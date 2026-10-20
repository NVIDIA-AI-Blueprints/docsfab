#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdir, open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  deliveryAcceptanceSourceCheckoutSha256,
  observeDeliveryAcceptanceSourceCheckout,
  runOfflineDeliveryAcceptance,
} from "./acceptance.js";
import {
  assembleVerifiedDeliveryAcceptanceChain,
  type DeliveryAcceptanceChainEvidence,
} from "./acceptance-chain.js";
import {
  DELIVERY_ACCEPTANCE_EMPTY_IGNORED_STATE_SUMMARY,
  finalizeDeliveryAcceptanceManifest,
  parseDeliveryAcceptanceChainBinding,
  parseDeliveryAcceptanceManifest,
  type DeliveryAcceptanceChainBindingV1,
} from "./acceptance-manifest.js";
import { runLocalUserPublishExecuteCli, type LocalUserPublishCliDependencies } from "./cli.js";
import {
  loadVerifiedPublicationRun,
  preflightLocalUserGitLabPublication,
  serializeLocalUserPublicationPlan,
  type VerifiedPublicationRun,
} from "./preflight.js";
import type { LocalUserPublicationPlan } from "./contracts.js";
import { DeterministicLocalGitPublisher, gitEnvironment } from "./git-publisher.js";
import { glabEnvironment } from "./gitlab-adapter.js";
import { loadPrivateDocsFabEnvironment } from "../config/private-environment.js";
import { FileScmDeliveryReceiptStore } from "./receipt-store.js";
import { scmDeliveryIdempotencyKey, type ScmDeliveryRecord } from "./receipt.js";
import { decodeLocalUserGitLabPublicationResult } from "./publication-result.js";
import {
  canonicalizeJsonEvidence,
  parseJsonEvidence,
  type JsonEvidenceValue,
} from "../json-evidence.js";
import { runCliEntrypoint } from "../operator/cli-entrypoint.js";
import { loadSavedRunEditorialDecodeOptions } from "../cli/run/editorial-replay.js";
import type { RunRecord } from "../records/contracts.js";
import type { WorkflowOutcomeDecodeOptionsV1 } from "../workflow-contracts/outcome.js";
import { sha256 } from "../content-ir/canonical.js";
import { refuseLimit, type ResolvedLimit } from "../config/limits.js";
import { runRecordMaxBytes } from "../records/run-record-limit.js";

const SAFE_BRANCH =
  /^(?![-.])(?!.*(?:\.\.|@\{|\\|[\x00-\x20~^:?*\[]))(?!.*\/$)(?!.*\.lock(?:\/|$))[A-Za-z0-9._/-]{1,200}$/u;

interface CommitBinding {
  revision: string;
  treeRevision: string;
  parentRevision: string;
  parentCount: 1;
}

export interface DeliveryAcceptanceCliDependencies {
  preflight?: typeof preflightLocalUserGitLabPublication;
  execute?: (
    args: readonly string[],
    dependencies: LocalUserPublishCliDependencies,
  ) => Promise<void>;
  loadRun?: typeof loadVerifiedPublicationRun;
  loadReceipt?: (
    receiptRoot: string,
    idempotencyKey: string,
  ) => Promise<ScmDeliveryRecord | undefined>;
  sourceCheckoutSha256?: typeof deliveryAcceptanceSourceCheckoutSha256;
  sourceCheckoutObservation?: typeof observeDeliveryAcceptanceSourceCheckout;
  inspectCommit?: (repository: string, revision: string) => Promise<CommitBinding>;
  currentDocsFabRevision?: () => Promise<string>;
  randomId?: () => string;
  assembleChain?: (
    evidence: DeliveryAcceptanceChainEvidence,
    editorialDecodeOptions?: WorkflowOutcomeDecodeOptionsV1,
  ) => DeliveryAcceptanceChainBindingV1;
  log?: (message: string) => void;
}

export async function runDeliveryAcceptanceCli(
  args: readonly string[],
  dependencies: DeliveryAcceptanceCliDependencies = {},
): Promise<void> {
  if (args.includes("--live-cleanup")) return runLiveCleanup(args);
  if (args.includes("--assemble-chain")) return runAssembleChain(args, dependencies);
  if (args.includes("--live")) return runLive(args, dependencies);
  const stateRoot = required(args, "--state-dir");
  const evidenceRoot = required(args, "--evidence-dir");
  const testedRevision = required(args, "--tested-revision");
  rejectUnknown(args, new Set(["--state-dir", "--evidence-dir", "--tested-revision"]), new Set());
  const result = await runOfflineDeliveryAcceptance({
    stateRoot: absolute(stateRoot, "--state-dir"),
    evidenceRoot: absolute(evidenceRoot, "--evidence-dir"),
    testedRevision,
  });
  (dependencies.log ?? console.log)(
    canonicalizeJsonEvidence({
      schemaVersion: 1,
      kind: "docsfab-delivery-acceptance-result",
      status: "passed",
      manifestSha256: result.manifest.sha256,
      manifestPath: result.manifestPath,
      workspacePreserved: result.workspacePreserved,
    } as unknown as JsonEvidenceValue).trimEnd(),
  );
}

async function runAssembleChain(
  args: readonly string[],
  dependencies: DeliveryAcceptanceCliDependencies,
): Promise<void> {
  rejectUnknown(
    args,
    new Set([
      "--tested-revision",
      "--readiness-record",
      "--declaration",
      "--analysis-record",
      "--authorization",
      "--reviewer-policy",
      "--write-record",
      "--patch",
      "--chain-output",
    ]),
    new Set(["--assemble-chain"]),
  );
  const testedRevision = required(args, "--tested-revision");
  const currentDocsFabRevision = await (
    dependencies.currentDocsFabRevision ?? inspectCurrentDocsFabRevision
  )();
  if (testedRevision !== currentDocsFabRevision) {
    throw new Error("Delivery chain tested revision is not the exact DocsFab checkout revision.");
  }
  const chain = await assembleChainFromArgs(args, testedRevision, dependencies);
  const requestedOutputPath = absolute(required(args, "--chain-output"), "--chain-output");
  const parent = await privateRoot(dirname(requestedOutputPath));
  const outputPath = join(parent, basename(requestedOutputPath));
  const handle = await open(outputPath, "wx", 0o600);
  try {
    await handle.writeFile(canonicalizeJsonEvidence(chain as unknown as JsonEvidenceValue));
    await handle.sync();
  } finally {
    await handle.close();
  }
  (dependencies.log ?? console.log)(
    canonicalizeJsonEvidence({
      schemaVersion: 1,
      kind: "docsfab-delivery-acceptance-chain-result",
      status: "verified",
      chainSha256: chain.sha256,
      chainPath: outputPath,
    } as unknown as JsonEvidenceValue).trimEnd(),
  );
}

async function runLive(
  args: readonly string[],
  dependencies: DeliveryAcceptanceCliDependencies,
): Promise<void> {
  if (process.env.DOCSFAB_DELIVERY_ACCEPTANCE_LIVE !== "true") {
    throw new Error("Live delivery acceptance requires DOCSFAB_DELIVERY_ACCEPTANCE_LIVE=true.");
  }
  rejectUnknown(
    args,
    new Set([
      "--repo",
      "--run-id",
      "--state-dir",
      "--evidence-dir",
      "--approve-project-id",
      "--approve-project-path",
      "--approve-action",
      "--validation-command",
      "--remote",
      "--target-branch",
      "--source-branch",
      "--confirm-plan-sha256",
      "--delivery-root",
      "--receipt-root",
      "--tested-revision",
      "--chain-manifest",
      "--offline-manifest",
      "--readiness-record",
      "--declaration",
      "--analysis-record",
      "--authorization",
      "--reviewer-policy",
      "--write-record",
      "--patch",
    ]),
    new Set(["--live", "--preflight-only"]),
  );
  const repository = absolute(required(args, "--repo"), "--repo");
  const runId = required(args, "--run-id");
  const stateDirectory = absolute(required(args, "--state-dir"), "--state-dir");
  const testedRevision = required(args, "--tested-revision");
  const currentDocsFabRevision = await (
    dependencies.currentDocsFabRevision ?? inspectCurrentDocsFabRevision
  )();
  if (testedRevision !== currentDocsFabRevision) {
    throw new Error("Live acceptance tested revision is not the exact DocsFab checkout revision.");
  }
  const claimedChain = parseDeliveryAcceptanceChainBinding(
    await readBoundedFile(
      absolute(required(args, "--chain-manifest"), "--chain-manifest"),
      1024 * 1024,
    ),
  );
  const chain = await assembleChainFromArgs(args, testedRevision, dependencies);
  if (
    chain.sha256 !== claimedChain.sha256 ||
    canonicalizeJsonEvidence(chain as unknown as JsonEvidenceValue) !==
      canonicalizeJsonEvidence(claimedChain as unknown as JsonEvidenceValue)
  ) {
    throw new Error("Live acceptance chain descriptor does not match verified private evidence.");
  }
  if (chain.testedRevision !== testedRevision || chain.write.id !== runId) {
    throw new Error("Live acceptance chain does not bind the exact tested revision and write run.");
  }
  const matrixManifest = parseDeliveryAcceptanceManifest(
    await readBoundedFile(
      absolute(required(args, "--offline-manifest"), "--offline-manifest"),
      1024 * 1024,
    ),
  );
  if (matrixManifest.mode !== "offline" || matrixManifest.testedRevision !== testedRevision) {
    throw new Error("Live acceptance requires the offline matrix from the exact tested revision.");
  }
  const projectId = positiveInteger(required(args, "--approve-project-id"), "--approve-project-id");
  const projectPath = safeProjectPath(required(args, "--approve-project-path"));
  const action = required(args, "--approve-action");
  const sourceObservation =
    dependencies.sourceCheckoutObservation ??
    (dependencies.sourceCheckoutSha256
      ? async (source: string) => ({
          sha256: await dependencies.sourceCheckoutSha256!(source),
          ignored: { ...DELIVERY_ACCEPTANCE_EMPTY_IGNORED_STATE_SUMMARY, notObservedReasons: [] },
        })
      : observeDeliveryAcceptanceSourceCheckout);
  const sourceBefore = await sourceObservation(repository);
  const validationCommand = value(args, "--validation-command");
  const remoteName = value(args, "--remote");
  const targetBranch = value(args, "--target-branch");
  const sourceBranch = value(args, "--source-branch");
  const runRecordPath = resolve(stateDirectory, `${runId}.json`);
  const editorialDecodeOptions =
    dependencies.preflight && dependencies.loadRun && dependencies.execute
      ? undefined
      : await loadAcceptanceEditorialDecodeOptions(runRecordPath);
  const plan = await (dependencies.preflight ?? preflightLocalUserGitLabPublication)(
    {
      runId,
      runRecordPath,
      repositoryPath: repository,
      draftMergeRequest: true,
      ...(validationCommand ? { validationCommand } : {}),
      ...(remoteName ? { remoteName } : {}),
      ...(targetBranch ? { targetBranch } : {}),
      ...(sourceBranch ? { proposedSourceBranch: sourceBranch } : {}),
    },
    undefined,
    editorialDecodeOptions,
  );
  const verifiedRun = await (dependencies.loadRun ?? loadVerifiedPublicationRun)(
    runRecordPath,
    runId,
    editorialDecodeOptions,
  );
  assertLiveChainMatchesRun(chain, verifiedRun, plan);
  if (plan.project.id !== projectId || plan.project.path !== projectPath) {
    throw new Error("Live destination approval does not match the read-only publication plan.");
  }
  if (args.includes("--preflight-only")) {
    if (action !== "inspect-only")
      throw new Error("Live preflight requires --approve-action inspect-only.");
    (dependencies.log ?? console.log)(serializeLocalUserPublicationPlan(plan).trimEnd());
    return;
  }
  if (action !== "open-draft-mr") {
    throw new Error("Live publication requires --approve-action open-draft-mr.");
  }
  const confirmedPlan = required(args, "--confirm-plan-sha256");
  if (confirmedPlan !== plan.sha256)
    throw new Error("Live publication confirmation does not match fresh preflight.");
  const deliveryRoot = absolute(required(args, "--delivery-root"), "--delivery-root");
  const receiptRoot = absolute(required(args, "--receipt-root"), "--receipt-root");
  const evidenceRoot = await privateRoot(
    absolute(required(args, "--evidence-dir"), "--evidence-dir"),
  );
  const logs: string[] = [];
  await (dependencies.execute ?? runLocalUserPublishExecuteCli)(
    [
      runId,
      "--repo",
      repository,
      "--draft-mr",
      "--execute",
      "--confirm-plan-sha256",
      confirmedPlan,
      "--delivery-root",
      deliveryRoot,
      "--receipt-root",
      receiptRoot,
      "--state-dir",
      stateDirectory,
      ...(remoteName ? ["--remote", remoteName] : []),
      ...(targetBranch ? ["--target-branch", targetBranch] : []),
      ...(sourceBranch ? ["--source-branch", sourceBranch] : []),
      ...(validationCommand ? ["--validation-command", validationCommand] : []),
    ],
    {
      cwd: process.cwd(),
      stateDirectory,
      log: (message) => logs.push(message),
      ...(editorialDecodeOptions ? { editorialDecodeOptions } : {}),
    },
  );
  const sourceAfter = await sourceObservation(repository);
  if (
    sourceAfter.sha256 !== sourceBefore.sha256 ||
    canonicalizeJsonEvidence(sourceAfter.ignored as unknown as JsonEvidenceValue) !==
      canonicalizeJsonEvidence(sourceBefore.ignored as unknown as JsonEvidenceValue)
  ) {
    throw new Error("Live publication mutated the source checkout.");
  }
  const result = decodeLocalUserGitLabPublicationResult(parseUnknownJson(logs.at(-1) ?? "{}"));
  const receipt = await (dependencies.loadReceipt ?? loadReceipt)(
    receiptRoot,
    scmDeliveryIdempotencyKey(plan),
  );
  if (
    !receipt ||
    receipt.sha256 !== result.receiptSha256 ||
    receipt.state !== "opened" ||
    receipt.disposition !== "succeeded" ||
    receipt.evidence.commit?.sha !== result.commitRevision ||
    receipt.evidence.push?.remoteRevision !== result.commitRevision ||
    receipt.evidence.mergeRequest?.iid !== result.mergeRequest.iid
  ) {
    throw new Error("Live publication receipt does not bind the terminal result.");
  }
  const pushRevision = receipt.evidence.push?.remoteRevision;
  const validation = receipt.evidence.validation;
  const mergeRequest = receipt.evidence.mergeRequest;
  if (!pushRevision || !validation || !mergeRequest) {
    throw new Error("Live publication receipt is missing terminal evidence.");
  }
  const commit = await (dependencies.inspectCommit ?? inspectCommit)(
    repository,
    result.commitRevision,
  );
  if (commit.parentRevision !== plan.baseRevision) {
    throw new Error("Live publication commit is not single-parented to the exact plan base.");
  }
  const liveManifest = finalizeDeliveryAcceptanceManifest({
    schemaVersion: 1,
    kind: "docsfab-local-user-gitlab-delivery-acceptance",
    mode: "live",
    status: "passed",
    testedRevision,
    sourceRevision: plan.baseRevision,
    chain,
    plan: {
      sha256: plan.sha256,
      baseRevision: plan.baseRevision,
      runRecordSha256: plan.run.recordSha256,
      patchSha256: plan.patch.sha256,
    },
    publicationAuthorization: {
      decision: "authorized",
      command: "publish",
      planSha256: receipt.authorization.planSha256,
    },
    validation: { ...validation, status: "passed" },
    commit: { ...commit, baseRevision: plan.baseRevision },
    remote: {
      identitySha256: sha256(
        `${plan.project.host}:${plan.project.id}:${plan.project.path}:${plan.remote.name}`,
      ),
      name: plan.remote.name,
      transport: plan.remote.transport,
      sourceBranch: plan.proposedSourceBranch,
      targetBranch: plan.targetBranch.name,
      headRevision: pushRevision,
    },
    mergeRequest: {
      iid: mergeRequest.iid,
      draft: true,
      state: "opened",
      sourceBranch: mergeRequest.sourceBranch,
      targetBranch: mergeRequest.targetBranch,
      headRevision: mergeRequest.headRevision,
      identitySha256: sha256(
        `${plan.project.id}:${mergeRequest.iid}:${plan.proposedSourceBranch}:${result.commitRevision}`,
      ),
    },
    receipt: {
      idempotencyKey: receipt.idempotencyKey,
      sha256: receipt.sha256,
      state: "opened",
      disposition: "succeeded",
      planSha256: receipt.planSha256,
    },
    sourceCheckout: {
      status: "unchanged",
      beforeSha256: sourceBefore.sha256,
      afterSha256: sourceAfter.sha256,
      ignored: sourceAfter.ignored,
    },
    idempotency: { ...matrixManifest.idempotency },
    failureMatrix: matrixManifest.failureMatrix.map((item) => ({ ...item })),
    failureMatrixSummary: { ...matrixManifest.failureMatrixSummary },
    liveGate: {
      status: "approved-and-run",
      destinationSha256: sha256(`${plan.project.host}:${plan.project.id}:${plan.project.path}`),
      cleanup: "separately-gated",
    },
    dogfoodDisposition: matrixManifest.dogfoodDisposition,
  });
  const serialized = canonicalizeJsonEvidence(liveManifest as unknown as JsonEvidenceValue);
  const evidenceDirectory = join(
    evidenceRoot,
    `live-${plan.baseRevision.slice(0, 12)}-${(dependencies.randomId ?? randomUUID)()}`,
  );
  await mkdir(evidenceDirectory, { mode: 0o700 });
  const manifestPath = join(evidenceDirectory, "manifest.json");
  const handle = await open(manifestPath, "wx", 0o600);
  try {
    await handle.writeFile(serialized);
    await handle.sync();
  } finally {
    await handle.close();
  }
  (dependencies.log ?? console.log)(
    canonicalizeJsonEvidence({
      schemaVersion: 1,
      kind: "docsfab-delivery-live-acceptance-result",
      status: "passed",
      manifestSha256: liveManifest.sha256,
      manifestPath,
    } as unknown as JsonEvidenceValue).trimEnd(),
  );
}

function assertLiveChainMatchesRun(
  chain: DeliveryAcceptanceChainBindingV1,
  run: VerifiedPublicationRun,
  plan: LocalUserPublicationPlan,
): void {
  const changedPaths = run.changedFiles.map((file) => file.path).sort();
  if (
    chain.sourceRevision !== run.revision ||
    run.revision !== plan.baseRevision ||
    chain.write.id !== run.id ||
    chain.write.recordSha256 !== run.recordSha256 ||
    chain.write.outcome !== run.workflowOutcome ||
    chain.write.changedPaths.length !== changedPaths.length ||
    chain.write.changedPaths.some((path, index) => path !== changedPaths[index]) ||
    chain.patch.sha256 !== run.patch.sha256 ||
    chain.patch.sha256 !== plan.patch.sha256 ||
    chain.patch.byteLength !== run.patch.byteLength ||
    chain.patch.changedPaths.length !== changedPaths.length ||
    plan.run.recordSha256 !== run.recordSha256 ||
    plan.patch.changedFileCount !== changedPaths.length
  ) {
    throw new Error("Live acceptance chain does not bind the exact verified write run and plan.");
  }
}

async function assembleChainFromArgs(
  args: readonly string[],
  testedRevision: string,
  dependencies: DeliveryAcceptanceCliDependencies,
): Promise<DeliveryAcceptanceChainBindingV1> {
  const applicationRecordPath = absolute(required(args, "--write-record"), "--write-record");
  // Saved run records share the one run-record bound every reader applies.
  const recordBound = runRecordMaxBytes();
  const applicationRecordBytes = await readBoundedFile(applicationRecordPath, recordBound);
  const editorialDecodeOptions = dependencies.assembleChain
    ? undefined
    : await loadAcceptanceEditorialDecodeOptions(applicationRecordPath, applicationRecordBytes);
  return (dependencies.assembleChain ?? assembleVerifiedDeliveryAcceptanceChain)(
    {
      testedRevision,
      readinessRecordBytes: await readBoundedFile(
        absolute(required(args, "--readiness-record"), "--readiness-record"),
        recordBound,
      ),
      declarationBytes: await readBoundedFile(
        absolute(required(args, "--declaration"), "--declaration"),
        1024 * 1024,
      ),
      analysisRecordBytes: await readBoundedFile(
        absolute(required(args, "--analysis-record"), "--analysis-record"),
        recordBound,
      ),
      authorizationBytes: await readBoundedFile(
        absolute(required(args, "--authorization"), "--authorization"),
        1024 * 1024,
      ),
      reviewerPolicyBytes: await readBoundedFile(
        absolute(required(args, "--reviewer-policy"), "--reviewer-policy"),
        1024 * 1024,
      ),
      applicationRecordBytes,
      patchBytes: await readBoundedFile(
        absolute(required(args, "--patch"), "--patch"),
        10 * 1024 * 1024,
      ),
    },
    editorialDecodeOptions,
  );
}

async function loadAcceptanceEditorialDecodeOptions(
  runRecordPath: string,
  bytes?: Uint8Array,
): Promise<WorkflowOutcomeDecodeOptionsV1 | undefined> {
  const recordBytes = bytes ?? (await readBoundedFile(runRecordPath, runRecordMaxBytes()));
  const record = parseJsonEvidence(recordBytes) as unknown as RunRecord;
  return loadSavedRunEditorialDecodeOptions(record, dirname(runRecordPath));
}

/**
 * Read an owner-private regular file. `maximum` is a fixed byte count, or a
 * catalogued limit whose own refusal names an oversized file's size.
 */
async function readBoundedFile(path: string, maximum: number | ResolvedLimit): Promise<Buffer> {
  const maximumBytes = typeof maximum === "number" ? maximum : maximum.value;
  const details = await lstat(path);
  if (typeof maximum !== "number" && details.isFile() && details.size > maximumBytes) {
    refuseLimit(maximum, details.size);
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (
    details.isSymbolicLink() ||
    !details.isFile() ||
    details.size <= 0 ||
    details.size > maximumBytes ||
    uid === undefined ||
    details.uid !== uid ||
    (details.mode & 0o077) !== 0
  ) {
    throw new Error("Live acceptance input must be an owner-private bounded regular file.");
  }
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const handle = await open(path, fsConstants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat();
    if (!sameFile(details, opened)) {
      throw new Error("Live acceptance input changed before reading.");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const pathAfter = await lstat(path);
    if (
      bytes.byteLength !== details.size ||
      bytes.byteLength > maximumBytes ||
      !sameFile(details, after) ||
      !sameFile(details, pathAfter)
    ) {
      throw new Error("Live acceptance input changed while reading.");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function sameFile(
  left: Awaited<ReturnType<typeof lstat>>,
  right: Awaited<ReturnType<typeof lstat>>,
): boolean {
  return (
    right.isFile() &&
    !right.isSymbolicLink() &&
    right.nlink === 1 &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function parseUnknownJson(value: string): unknown {
  if (Buffer.byteLength(value, "utf8") < 2 || Buffer.byteLength(value, "utf8") > 1024 * 1024) {
    throw new Error("Live acceptance JSON evidence is invalid.");
  }
  try {
    return parseJsonEvidence(value);
  } catch {
    throw new Error("Live acceptance JSON evidence is invalid.");
  }
}

async function loadReceipt(
  receiptRoot: string,
  idempotencyKey: string,
): Promise<ScmDeliveryRecord | undefined> {
  return new FileScmDeliveryReceiptStore(receiptRoot).load(idempotencyKey);
}

async function inspectCurrentDocsFabRevision(): Promise<string> {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  return (await captureCommand("git", ["rev-parse", "HEAD"], projectRoot)).toString("utf8").trim();
}

async function inspectCommit(repository: string, revision: string): Promise<CommitBinding> {
  if (!isRevision(revision)) throw new Error("Live publication commit revision is invalid.");
  const lines = (await captureCommand("git", ["cat-file", "-p", revision], repository))
    .toString("utf8")
    .split("\n");
  const treeLines = lines.filter((line) => line.startsWith("tree "));
  const parentLines = lines.filter((line) => line.startsWith("parent "));
  const treeRevision = treeLines.length === 1 ? treeLines[0]!.slice(5) : "";
  const parentRevision = parentLines.length === 1 ? parentLines[0]!.slice(7) : "";
  if (!isRevision(treeRevision) || !isRevision(parentRevision)) {
    throw new Error("Live publication commit must have exactly one tree and one parent.");
  }
  return { revision, treeRevision, parentRevision, parentCount: 1 };
}

function isRevision(value: unknown): value is string {
  return typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value);
}

async function runLiveCleanup(args: readonly string[]): Promise<void> {
  if (process.env.DOCSFAB_DELIVERY_ACCEPTANCE_LIVE_CLEANUP !== "true") {
    throw new Error("Live cleanup requires DOCSFAB_DELIVERY_ACCEPTANCE_LIVE_CLEANUP=true.");
  }
  rejectUnknown(
    args,
    new Set([
      "--approve-action",
      "--repo",
      "--approve-host",
      "--approve-project-id",
      "--approve-project-path",
      "--merge-request-iid",
      "--source-branch",
      "--target-branch",
      "--remote",
      "--approve-remote-transport",
    ]),
    new Set(["--live-cleanup"]),
  );
  const action = required(args, "--approve-action");
  if (action !== "close-draft-mr-and-delete-source-branch") {
    throw new Error("Live cleanup requires the exact close-and-delete approval action.");
  }
  const repository = await realpath(absolute(required(args, "--repo"), "--repo"));
  const host = safeHost(required(args, "--approve-host"));
  const projectId = positiveInteger(required(args, "--approve-project-id"), "--approve-project-id");
  const projectPath = safeProjectPath(required(args, "--approve-project-path"));
  const mergeRequestIid = positiveInteger(
    required(args, "--merge-request-iid"),
    "--merge-request-iid",
  );
  const sourceBranch = safeBranch(required(args, "--source-branch"), "--source-branch");
  const targetBranch = safeBranch(required(args, "--target-branch"), "--target-branch");
  const remoteName = safeRemote(value(args, "--remote") ?? "origin");
  const remoteTransport = safeRemoteTransport(required(args, "--approve-remote-transport"));
  if (!sourceBranch.startsWith("docsfab-run/") || sourceBranch === targetBranch) {
    throw new Error("Cleanup is limited to a dedicated non-target docsfab-run/ source branch.");
  }
  const git = new DeterministicLocalGitPublisher();
  const remoteTarget = {
    project: { host, path: projectPath },
    remote: { name: remoteName, transport: remoteTransport },
  } as const;
  await captureCommand("glab", ["auth", "status", "--hostname", host], repository);
  const project = strictObject(
    parseUnknownJson(
      (
        await captureCommand(
          "glab",
          ["api", "--hostname", host, `projects/${projectId}`],
          repository,
        )
      ).toString("utf8"),
    ),
  );
  if (
    project.id !== projectId ||
    project.path_with_namespace !== projectPath ||
    project.default_branch === sourceBranch
  ) {
    throw new Error("Cleanup destination no longer matches the exact approved project.");
  }
  const request = strictObject(
    parseUnknownJson(
      (
        await captureCommand(
          "glab",
          ["api", "--hostname", host, `projects/${projectId}/merge_requests/${mergeRequestIid}`],
          repository,
        )
      ).toString("utf8"),
    ),
  );
  const draft =
    request.draft === true ||
    request.work_in_progress === true ||
    (typeof request.title === "string" && /^(?:Draft:|WIP:)/u.test(request.title));
  if (
    request.iid !== mergeRequestIid ||
    request.state !== "opened" ||
    !draft ||
    request.source_branch !== sourceBranch ||
    request.target_branch !== targetBranch ||
    request.source_project_id !== projectId ||
    request.target_project_id !== projectId ||
    typeof request.sha !== "string" ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(request.sha)
  ) {
    throw new Error("Cleanup is limited to the exact open draft MR approved by the operator.");
  }
  const remoteHead = await git.remoteBranchRevisionForTarget(
    remoteTarget,
    sourceBranch,
    repository,
  );
  if (remoteHead !== request.sha) {
    throw new Error("Cleanup source branch no longer matches the exact approved draft MR.");
  }
  // Cleanup never removes local receipts, patches, manifests, or worktrees.
  await requireCommand(
    "glab",
    [
      "api",
      "--hostname",
      host,
      "--method",
      "PUT",
      `projects/${projectId}/merge_requests/${mergeRequestIid}`,
      "--field",
      "state_event=close",
    ],
    repository,
  );
  await git.deleteRemoteBranch({
    target: remoteTarget,
    branch: sourceBranch,
    expectedRevision: request.sha,
    cwd: repository,
  });
  console.log(
    canonicalizeJsonEvidence({
      schemaVersion: 1,
      kind: "docsfab-delivery-live-cleanup-result",
      status: "completed",
      mergeRequestIid,
      sourceBranchSha256: await digest(sourceBranch),
      evidencePreserved: true,
    } as unknown as JsonEvidenceValue).trimEnd(),
  );
}

function required(args: readonly string[], name: string): string {
  const found = value(args, name);
  if (!found) throw new Error(`${name} is required.`);
  return found;
}

function value(args: readonly string[], name: string): string | undefined {
  const indexes = args.flatMap((argument, index) => (argument === name ? [index] : []));
  if (indexes.length > 1) throw new Error(`Duplicate ${name}.`);
  if (indexes.length === 0) return undefined;
  const found = args[indexes[0]! + 1];
  if (!found || found.startsWith("--")) throw new Error(`${name} requires one value.`);
  return found;
}

function rejectUnknown(args: readonly string[], valued: Set<string>, flags: Set<string>): void {
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index]!;
    if (flags.has(item)) continue;
    if (!valued.has(item)) throw new Error(`Unknown delivery acceptance option ${item}.`);
    index += 1;
  }
}

function absolute(path: string, name: string): string {
  if (!isAbsolute(path)) throw new Error(`${name} requires an absolute path.`);
  return resolve(path);
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw new Error(`${name} requires a positive integer.`);
  return parsed;
}

function safeProjectPath(value: string): string {
  if (!/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/u.test(value) || value.includes("..")) {
    throw new Error("--approve-project-path requires a canonical GitLab project path.");
  }
  return value;
}

function safeHost(value: string): string {
  if (!/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/u.test(value) || !value.includes(".")) {
    throw new Error("--approve-host requires a canonical hostname.");
  }
  return value;
}

function safeBranch(value: string, name: string): string {
  if (!SAFE_BRANCH.test(value)) throw new Error(`${name} requires a safe branch.`);
  return value;
}

function safeRemote(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(value))
    throw new Error("--remote requires a safe remote name.");
  return value;
}

function safeRemoteTransport(value: string): "ssh" | "https" {
  if (value !== "ssh" && value !== "https") {
    throw new Error("--approve-remote-transport requires ssh or https.");
  }
  return value;
}

async function requireCommand(
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<void> {
  await captureCommand(command, args, cwd);
}

async function captureCommand(
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<Buffer> {
  const result = await new Promise<{ exitCode: number; stdout: Buffer }>((resolveExit) => {
    const child = spawn(command, [...args], {
      cwd,
      env:
        command === "glab"
          ? glabEnvironment(loadPrivateDocsFabEnvironment())
          : gitEnvironment(process.env),
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    const chunks: Buffer[] = [];
    let size = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size <= 1_000_000) chunks.push(Buffer.from(chunk));
      else child.kill("SIGKILL");
    });
    child.once("error", () => resolveExit({ exitCode: 1, stdout: Buffer.concat(chunks) }));
    child.once("close", (code) =>
      resolveExit({
        exitCode: code === 0 && size <= 1_000_000 ? 0 : 1,
        stdout: Buffer.concat(chunks),
      }),
    );
  });
  if (result.exitCode !== 0) throw new Error(`Live cleanup command failed (${command}).`);
  return result.stdout;
}

async function digest(value: string): Promise<string> {
  return sha256(value);
}

async function privateRoot(path: string): Promise<string> {
  let details;
  try {
    details = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = await realpath(dirname(path));
    if (join(parent, basename(path)) !== path) {
      throw new Error("Live evidence root cannot traverse symlinked ancestors.");
    }
    await mkdir(path, { mode: 0o700 });
    details = await lstat(path);
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (
    details.isSymbolicLink() ||
    !details.isDirectory() ||
    uid === undefined ||
    details.uid !== uid
  ) {
    throw new Error("Live evidence root must be an owner-controlled real directory.");
  }
  await chmod(path, 0o700);
  const tightened = await lstat(path);
  if (
    tightened.dev !== details.dev ||
    tightened.ino !== details.ino ||
    (tightened.mode & 0o777) !== 0o700
  ) {
    throw new Error("Live evidence root must be owner-private.");
  }
  return realpath(path);
}

function strictObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Live cleanup observation is invalid.");
  }
  return value as Record<string, unknown>;
}

runCliEntrypoint(import.meta.url, () =>
  runDeliveryAcceptanceCli(process.argv.slice(2)).then(() => undefined),
);
