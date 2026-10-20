// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Dry-run-default multi-unit campaign ledger driver. Advances fingerprint slots
 * under caps and persists progress and unit receipts; the source checkout stays
 * unchanged and nothing is merged or published.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, open, rename, unlink, type FileHandle } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import {
  AcceptanceEvidenceError,
  pinAcceptanceEvidenceDirectory,
  readAcceptanceJsonLeaf,
  writeAcceptanceJsonExclusive,
  type AcceptanceEvidenceDirectory,
} from "../acceptance-evidence.js";
import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../json-evidence.js";
import {
  formatProjectConfigPreflightMessage,
  inspectProjectConfigCheckout,
  primaryProjectConfigPreflightCode,
  REPOSITORY_SOURCE_DIRTY_CODE,
  type ProjectConfigPreflightCode,
} from "../project-config-preflight.js";
import {
  assertMultiUnitCampaignPrivateDirectory,
  bindMultiUnitCampaignLedger,
  createMultiUnitDocImprovementProgress,
  decodeMultiUnitDocImprovementDeclaration,
  decodeMultiUnitDocImprovementProgress,
  decodeMultiUnitDocImprovementUnitQueue,
  type MultiUnitDocImprovementDeclarationV1,
  type MultiUnitDocImprovementProgressV1,
  type MultiUnitDocImprovementUnitQueueV1,
  type MultiUnitStopReason,
  MultiUnitDocImprovementError,
} from "./multi-unit-doc-improvement.js";

const GIT_BINARY = process.platform === "win32" ? "git" : "/usr/bin/git";
const SAFE_GIT_CONFIG = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.attributesFile=/dev/null",
  "-c",
  "core.excludesFile=/dev/null",
  "-c",
  "diff.external=",
  "-c",
  "pager.status=false",
  "-c",
  "pager.diff=false",
] as const;

const DRY_RUN_RECEIPT_KIND = "multi-unit-doc-improvement-dry-run-receipt" as const;
const DRY_RUN_RESULT_KIND = "multi-unit-doc-improvement-campaign-dry-run-result" as const;
const PROGRESS_NEXT_LEAF = "progress.next.json";
const PROGRESS_LEAF = "progress.json";
const DRY_RUN_RECEIPT_LEAF = "dry-run-receipt.json";

export type MultiUnitCampaignRunErrorCode =
  | "invalid-option"
  | "source-dirty"
  | "source-changed"
  | "source-inspect-failed"
  | "write-mode-disabled"
  | "progress-write-failed"
  | "unit-receipt-failed"
  | "campaign-decode-failed";

export class MultiUnitCampaignRunError extends Error {
  public constructor(
    public readonly code: MultiUnitCampaignRunErrorCode,
    public readonly diagnosticCode?: ProjectConfigPreflightCode,
  ) {
    super(
      diagnosticCode
        ? [
            `Multi-unit campaign dry-run rejected: ${code}.`,
            formatProjectConfigPreflightMessage(diagnosticCode, "multi-unit-campaign"),
          ].join("\n")
        : `Multi-unit campaign dry-run rejected: ${code}.`,
    );
    this.name = "MultiUnitCampaignRunError";
  }
}

function fail(
  code: MultiUnitCampaignRunErrorCode,
  diagnosticCode?: ProjectConfigPreflightCode,
): never {
  throw new MultiUnitCampaignRunError(code, diagnosticCode);
}

export interface MultiUnitCampaignDryRunInput {
  readonly repositoryPath: string;
  readonly campaignDirectory: string;
  readonly revision?: string;
  /** Explicit write gate; multi-unit source writes are not enabled. */
  readonly allowWrite: boolean;
  readonly now?: () => string;
}

export interface MultiUnitCampaignDryRunResultV1 {
  readonly schemaVersion: 1;
  readonly kind: typeof DRY_RUN_RESULT_KIND;
  readonly campaignId: string;
  readonly declarationDigest: string;
  readonly unitQueueDigest: string;
  readonly unitsProcessed: number;
  readonly queueIndex: number;
  readonly campaignAttempts: number;
  readonly stopReason: MultiUnitStopReason;
  readonly progressDigest: string;
  readonly sourceCheckoutUnchanged: true;
  readonly sourceRevision: string;
  readonly sourceStatusEmpty: true;
  readonly sourceSnapshotSha256: string;
}

export interface MultiUnitCampaignDryRunDependencies {
  readonly inspectSource?: (repositoryPath: string) => Promise<SourceCheckoutSnapshot>;
  readonly assertSourceUnchanged?: (
    before: SourceCheckoutSnapshot,
    after: SourceCheckoutSnapshot,
  ) => void;
}

export interface SourceCheckoutSnapshot {
  readonly revision: string;
  readonly status: string;
  readonly snapshotSha256: string;
}

export async function runMultiUnitCampaignDryRun(
  input: MultiUnitCampaignDryRunInput,
  dependencies: MultiUnitCampaignDryRunDependencies = {},
): Promise<MultiUnitCampaignDryRunResultV1> {
  if (input.allowWrite) {
    fail("write-mode-disabled");
  }

  const repositoryPath = resolve(input.repositoryPath);
  const campaignDirectory = resolve(input.campaignDirectory);
  if (repositoryPath === campaignDirectory) {
    fail("invalid-option");
  }

  const inspect = dependencies.inspectSource ?? inspectSourceCheckout;
  const assertUnchanged = dependencies.assertSourceUnchanged ?? assertSourceCheckoutUnchanged;
  const before = await inspect(repositoryPath);
  if (before.status !== "") {
    const inspection = await inspectProjectConfigCheckout(repositoryPath).catch(() => null);
    fail(
      "source-dirty",
      inspection
        ? (primaryProjectConfigPreflightCode(inspection) ?? REPOSITORY_SOURCE_DIRTY_CODE)
        : REPOSITORY_SOURCE_DIRTY_CODE,
    );
  }
  if (input.revision !== undefined && input.revision !== "HEAD") {
    const expected = input.revision.trim();
    if (expected.length === 0 || expected.includes("\0") || expected.startsWith("-")) {
      fail("invalid-option");
    }
    if (
      before.revision !== expected &&
      !before.revision.startsWith(expected) &&
      !expected.startsWith(before.revision)
    ) {
      fail("invalid-option");
    }
  }

  const ledger = await loadBoundLedger(campaignDirectory);
  if (ledger.progress.stopReason !== null) {
    const afterTerminal = await inspect(repositoryPath);
    assertUnchanged(before, afterTerminal);
    return finalizeResult(ledger, 0, before);
  }

  if (ledger.unitQueue.units.length < 2) {
    fail("invalid-option");
  }

  const now = input.now ?? (() => new Date().toISOString());
  let progress = ledger.progress;
  let unitsProcessed = 0;
  const startIndex = progress.queueIndex;

  for (let index = startIndex; index < ledger.unitQueue.units.length; index += 1) {
    if (progress.campaignAttempts >= ledger.declaration.caps.maxCampaignAttempts) {
      progress = await persistProgress(ledger.campaign, {
        campaignId: ledger.declaration.campaignId,
        declarationDigest: ledger.declaration.digest,
        unitQueueDigest: ledger.unitQueue.digest,
        queueIndex: progress.queueIndex,
        unitAttempts: progress.unitAttempts,
        campaignAttempts: progress.campaignAttempts,
        stopReason: "cap-exhausted",
        updatedAt: now(),
      });
      break;
    }

    const entry = ledger.unitQueue.units[index]!;
    const nextAttempts = progress.campaignAttempts + 1;
    if (nextAttempts > ledger.declaration.caps.maxCampaignAttempts) {
      progress = await persistProgress(ledger.campaign, {
        campaignId: ledger.declaration.campaignId,
        declarationDigest: ledger.declaration.digest,
        unitQueueDigest: ledger.unitQueue.digest,
        queueIndex: index,
        unitAttempts: progress.unitAttempts,
        campaignAttempts: progress.campaignAttempts,
        stopReason: "cap-exhausted",
        updatedAt: now(),
      });
      break;
    }

    await writeUnitDryRunReceipt(ledger.campaign, entry.workUnitFingerprint, {
      campaignId: ledger.declaration.campaignId,
      workUnitFingerprint: entry.workUnitFingerprint,
      machineContractSha256: entry.machineContractSha256,
      queueIndex: index,
      campaignAttempt: nextAttempts,
      recordedAt: now(),
    });

    const nextIndex = index + 1;
    const complete = nextIndex >= ledger.unitQueue.units.length;
    progress = await persistProgress(ledger.campaign, {
      campaignId: ledger.declaration.campaignId,
      declarationDigest: ledger.declaration.digest,
      unitQueueDigest: ledger.unitQueue.digest,
      queueIndex: nextIndex,
      unitAttempts: 1,
      campaignAttempts: nextAttempts,
      stopReason: complete ? "complete" : null,
      updatedAt: now(),
    });
    unitsProcessed += 1;
  }

  if (progress.stopReason === null) {
    progress = await persistProgress(ledger.campaign, {
      campaignId: ledger.declaration.campaignId,
      declarationDigest: ledger.declaration.digest,
      unitQueueDigest: ledger.unitQueue.digest,
      queueIndex: progress.queueIndex,
      unitAttempts: progress.unitAttempts,
      campaignAttempts: progress.campaignAttempts,
      stopReason: "complete",
      updatedAt: now(),
    });
  }

  const after = await inspect(repositoryPath);
  assertUnchanged(before, after);
  return finalizeResult({ ...ledger, progress }, unitsProcessed, before);
}

function finalizeResult(
  ledger: {
    declaration: MultiUnitDocImprovementDeclarationV1;
    unitQueue: MultiUnitDocImprovementUnitQueueV1;
    progress: MultiUnitDocImprovementProgressV1;
  },
  unitsProcessed: number,
  source: SourceCheckoutSnapshot,
): MultiUnitCampaignDryRunResultV1 {
  const stopReason = ledger.progress.stopReason;
  if (stopReason === null) {
    fail("progress-write-failed");
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    kind: DRY_RUN_RESULT_KIND,
    campaignId: ledger.declaration.campaignId,
    declarationDigest: ledger.declaration.digest,
    unitQueueDigest: ledger.unitQueue.digest,
    unitsProcessed,
    queueIndex: ledger.progress.queueIndex,
    campaignAttempts: ledger.progress.campaignAttempts,
    stopReason,
    progressDigest: ledger.progress.digest,
    sourceCheckoutUnchanged: true as const,
    sourceRevision: source.revision,
    sourceStatusEmpty: true as const,
    sourceSnapshotSha256: source.snapshotSha256,
  });
}

async function loadBoundLedger(campaignDirectory: string): Promise<{
  campaign: AcceptanceEvidenceDirectory;
  declaration: MultiUnitDocImprovementDeclarationV1;
  unitQueue: MultiUnitDocImprovementUnitQueueV1;
  progress: MultiUnitDocImprovementProgressV1;
}> {
  try {
    const pinned = await pinAcceptanceEvidenceDirectory(campaignDirectory);
    const declarationLeaf = await readAcceptanceJsonLeaf(pinned, "declaration.json");
    const unitQueueLeaf = await readAcceptanceJsonLeaf(pinned, "unit-queue.json");
    const progressLeaf = await readAcceptanceJsonLeaf(pinned, "progress.json");
    const declaration = decodeMultiUnitDocImprovementDeclaration(declarationLeaf.value);
    const unitQueue = decodeMultiUnitDocImprovementUnitQueue(unitQueueLeaf.value);
    const progress = decodeMultiUnitDocImprovementProgress(progressLeaf.value);
    bindMultiUnitCampaignLedger({ declaration, unitQueue, progress });
    const campaign = await assertMultiUnitCampaignPrivateDirectory({
      directory: campaignDirectory,
      declaration,
      unitQueue,
    });
    return { campaign, declaration, unitQueue, progress };
  } catch (error) {
    if (
      error instanceof MultiUnitDocImprovementError ||
      error instanceof MultiUnitCampaignRunError
    ) {
      throw error;
    }
    fail("campaign-decode-failed");
  }
}

async function persistProgress(
  campaign: AcceptanceEvidenceDirectory,
  body: Parameters<typeof createMultiUnitDocImprovementProgress>[0],
): Promise<MultiUnitDocImprovementProgressV1> {
  const progress = createMultiUnitDocImprovementProgress(body);
  const nextPath = join(campaign.path, PROGRESS_NEXT_LEAF);
  const progressPath = join(campaign.path, PROGRESS_LEAF);
  let handle: FileHandle | undefined;
  try {
    const bytes = Buffer.from(
      `${canonicalizeJsonEvidence(progress as unknown as JsonEvidenceValue)}\n`,
      "utf8",
    );
    handle = await open(
      nextPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    await handle.chmod(0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(nextPath, progressPath);
    await chmod(progressPath, 0o600);
    const after = await lstat(progressPath);
    if ((after.mode & 0o7777) !== 0o600 || after.nlink !== 1 || !after.isFile()) {
      fail("progress-write-failed");
    }
    return progress;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(nextPath).catch(() => undefined);
    if (error instanceof MultiUnitCampaignRunError) throw error;
    fail("progress-write-failed");
  }
}

async function writeUnitDryRunReceipt(
  campaign: AcceptanceEvidenceDirectory,
  fingerprint: string,
  body: {
    campaignId: string;
    workUnitFingerprint: string;
    machineContractSha256: string;
    queueIndex: number;
    campaignAttempt: number;
    recordedAt: string;
  },
): Promise<void> {
  const unitDirName = basename(fingerprint);
  if (unitDirName !== fingerprint) {
    fail("unit-receipt-failed");
  }
  const unitPath = join(campaign.path, "units", fingerprint);
  let unitPinned: AcceptanceEvidenceDirectory;
  try {
    unitPinned = await pinAcceptanceEvidenceDirectory(unitPath);
  } catch {
    fail("unit-receipt-failed");
  }
  const receiptDigest = createHash("sha256")
    .update(
      canonicalizeJsonEvidence({
        kind: DRY_RUN_RECEIPT_KIND,
        schemaVersion: 1,
        ...body,
      } as unknown as JsonEvidenceValue),
    )
    .digest("hex");
  const receipt = Object.freeze({
    schemaVersion: 1 as const,
    kind: DRY_RUN_RECEIPT_KIND,
    campaignId: body.campaignId,
    workUnitFingerprint: body.workUnitFingerprint,
    machineContractSha256: body.machineContractSha256,
    queueIndex: body.queueIndex,
    campaignAttempt: body.campaignAttempt,
    receiptDigest,
    recordedAt: body.recordedAt,
  });
  try {
    await writeAcceptanceJsonExclusive(unitPinned, DRY_RUN_RECEIPT_LEAF, receipt);
  } catch (error) {
    // Resume: this unit slot already has a receipt.
    if (error instanceof AcceptanceEvidenceError && error.code === "already-exists") {
      return;
    }
    fail("unit-receipt-failed");
  }
}

export async function inspectSourceCheckout(
  repositoryPath: string,
): Promise<SourceCheckoutSnapshot> {
  const path = resolve(repositoryPath);
  const revision = await runGit(path, ["rev-parse", "HEAD"]);
  const status = await runGit(path, ["status", "--porcelain=v1", "--untracked-files=all"]);
  const snapshotSha256 = createHash("sha256")
    .update(await runGit(path, ["write-tree"]))
    .update("\n")
    .update(status)
    .update("\n")
    .update(revision)
    .digest("hex");
  return { revision, status, snapshotSha256 };
}

export function assertSourceCheckoutUnchanged(
  before: SourceCheckoutSnapshot,
  after: SourceCheckoutSnapshot,
): void {
  if (
    before.revision !== after.revision ||
    before.status !== after.status ||
    before.snapshotSha256 !== after.snapshotSha256 ||
    after.status !== ""
  ) {
    fail("source-changed");
  }
}

async function runGit(repositoryPath: string, args: readonly string[]): Promise<string> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(GIT_BINARY, [...SAFE_GIT_CONFIG, "-C", repositoryPath, ...args], {
      cwd: repositoryPath,
      env: {
        PATH: process.env.PATH,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        LANG: "C",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", () => reject(new MultiUnitCampaignRunError("source-inspect-failed")));
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new MultiUnitCampaignRunError("source-inspect-failed"));
        return;
      }
      resolvePromise(Buffer.concat(stdout).toString("utf8").trimEnd());
    });
  });
}

export function serializeMultiUnitCampaignDryRunResult(
  result: MultiUnitCampaignDryRunResultV1,
): string {
  return `${canonicalizeJsonEvidence(result as unknown as JsonEvidenceValue)}\n`;
}

export function formatMultiUnitCampaignDryRunResult(
  result: MultiUnitCampaignDryRunResultV1,
): string {
  return [
    `Multi-unit campaign: ${result.campaignId}`,
    `Mode: dry-run`,
    `Units processed: ${result.unitsProcessed}`,
    `Queue index: ${result.queueIndex}`,
    `Campaign attempts: ${result.campaignAttempts}`,
    `Stop reason: ${result.stopReason}`,
    `Progress digest: ${result.progressDigest}`,
    `Source checkout unchanged: yes`,
    `Source revision: ${result.sourceRevision}`,
  ].join("\n");
}
