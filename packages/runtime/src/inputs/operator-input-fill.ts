// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Operator InputAsk fills for editorial `needs-input` resume.
 *
 * Host-owned intake: a reply sentence and/or `--attach` files bind to named
 * `inputId`s. Text fills never certify a verified no-change.
 */
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { link, lstat, mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import {
  editorialInputAskPresentationV1,
  parseSourceSupportInputIdV1,
  type EditorialInputAskFillKindV1,
} from "../artifacts/editorial-input-ask.js";
import { enforceLimit, OperationalLimitError } from "../config/limits.js";
import { sha256 } from "../content-ir/canonical.js";
import { enforceRunRecordMaxBytes } from "../records/run-record-limit.js";
import { parseJsonEvidence, type JsonEvidenceValue } from "../json-evidence.js";
import { credentialFreeGitEnvironment } from "../repository/evidence.js";
import {
  classifyRunResumability,
  isEditorialInputAskRecord,
  isPlannerGovernedInputRecord,
} from "../operator/run-resumability.js";
import type { ReaderSourceHintV1 } from "../execution/reader-task-admission.js";
import { decodeRunRecordReaderEvidenceRequest } from "../records/reader-evidence-request.js";
import {
  decodeRetainedEvidenceBindings,
  retainedSourcePaths,
  type RetainedEvidenceBindingsV1,
} from "../records/retained-evidence-bindings.js";
import { decodeRunChangeSources, type RunChangeSourcesV1 } from "../records/change-sources.js";
import type { ReaderComparisonRequestV1 } from "../search/change-impact.js";
import { inspectProcessBirth } from "../init/storage.js";
import { containsConfiguredCredential } from "../security/configured-credentials.js";
import { buildRepositoryDiscoveryInventory } from "../repository/inventory.js";
import { withRepositoryWorkspace } from "../repository/workspace/materialize.js";
import { hasErrnoCode } from "../shared/primitives.js";
import { decodeOperatorTargetPaths } from "../records/operator-target-paths.js";
import { decodeRunRecordRequestIntentAdmission } from "../request-intent/interpret-record.js";
import { RequestIntentContractError } from "../request-intent/kit.js";
import { admitCliSourceSelection } from "../cli/run-arguments.js";
import { sanitizeDisplayText } from "../operator/error-envelope.js";
import { redactCredentialMaterial } from "../security/credential-material.js";
import { decodeSavedRunRecord } from "../records/saved-run-record.js";

import { OperatorInputFillError } from "./operator-input-fill/errors.js";
import {
  continuedRevision,
  retainedBindings,
  retainedReaderEvidence,
  unionReaderSources,
} from "./operator-input-fill/continuation-evidence.js";
export {
  OPERATOR_INPUT_FILL_ERROR_CODES,
  OperatorInputFillError,
  type OperatorInputFillErrorCode,
} from "./operator-input-fill/errors.js";
export {
  assertContinuedEvidenceMatches,
  assertLiveSelectionMatchesContinuation,
  continuationBindingFlagConflict,
  continuationEvidenceRequest,
  operatorInputResumeInstructionContext,
  type ContinuedEvidenceObservationV1,
} from "./operator-input-fill/continuation-evidence.js";

export const OPERATOR_INPUT_MAX_SOURCE_BYTES = 1024 * 1024;
export const OPERATOR_INPUT_MAX_RETAINED_BYTES = 8 * 1024 * 1024;
export const OPERATOR_INPUT_MAX_NOMINATIONS = 128;

const SAFE_RECORD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_LIST_RECORDS = 10_000;
const TEXT_SLOT_KINDS = new Set<EditorialInputAskFillKindV1>(["text", "request"]);
const PATH_SLOT_KINDS = new Set<EditorialInputAskFillKindV1>(["path"]);

export interface OperatorInputAskSlotV1 {
  readonly inputId: string;
  readonly fillKind: EditorialInputAskFillKindV1;
  readonly label: string;
}

export interface OperatorInputAttributionV1 {
  readonly who: "operator";
  readonly what: string;
  readonly when: string;
}

export interface OperatorInputFillV1 {
  readonly inputId: string;
  readonly fillKind: EditorialInputAskFillKindV1;
  readonly role:
    | "request"
    | "accepted-knowledge"
    | "current-documentation"
    | "public-contract"
    /** A tracked file the continued CREATE plans as an approved source. */
    | "approved-source";
  readonly source: "reply-text" | "tracked-path" | "operator-file";
  readonly sha256: string;
  readonly byteLength: number;
  readonly attribution: OperatorInputAttributionV1;
  /** Host path or repository-relative path; never printed on stdout by callers. */
  readonly locator: string;
}

export interface OperatorInputResumePlanV1 {
  readonly originalRunId: string;
  readonly workflow: "create-documentation" | "update-documentation";
  readonly instruction: string;
  readonly instructionSha256: string;
  /** The original run's live-agent context, carried unchanged; never parsed. */
  readonly instructionContext?: string;
  readonly repositoryPath: string;
  readonly revision: string;
  readonly fills: readonly OperatorInputFillV1[];
  readonly skipPlanner: boolean;
  readonly skipSearchObserve: boolean;
  readonly revalidate: boolean;
  readonly verifiedNoChange: false;
  /** The original run's nominations, then the fills' sources, deduplicated by role and path. */
  readonly readerSources: readonly ReaderSourceHintV1[];
  /** The original run's comparison request, carried unchanged. */
  readonly comparisonRequest?: ReaderComparisonRequestV1;
  /**
   * The original run's `--source` files with the digests it read, carried
   * unchanged; the continuation binds the same files and refuses if they moved.
   */
  readonly retainedEvidenceBindings?: RetainedEvidenceBindingsV1;
  /**
   * The original run's `--change` citation, carried unchanged; the
   * continuation binds the same commits from these pins, never from the
   * selector the operator typed.
   */
  readonly changeSources?: RunChangeSourcesV1;
  readonly slots: readonly OperatorInputAskSlotV1[];
  /**
   * The stopped run is recorded as superseded by this id before the
   * continuation starts, so one chain has at most one open run.
   */
  readonly continuationRunId?: string;
}

export interface OpenEditorialRunV1 {
  readonly runId: string;
  readonly record: unknown;
  readonly workflow: "create-documentation" | "update-documentation";
  readonly repositoryPath: string;
  readonly instruction: string;
  readonly instructionContext?: string;
  /** The saved `readerEvidenceRequest`, undecoded; the resume plan decodes it. */
  readonly readerEvidenceRequest?: unknown;
  /** The saved `retainedEvidenceBindings`, undecoded; the resume plan decodes it. */
  readonly retainedEvidenceBindings?: unknown;
  /** The saved `changeSources`, undecoded; the resume plan decodes it. */
  readonly changeSources?: unknown;
  readonly slots: readonly OperatorInputAskSlotV1[];
}

/**
 * The repository path as the runner records it, so a `--repo` reached
 * through a symbolic link matches its own run. A path realpath cannot
 * resolve (removed, unreadable, or invalid) falls back to `resolve`; it then
 * matches nothing live, and one stale run never breaks every `docsfab do`.
 */
export function canonicalRepositoryPath(path: string): string {
  const resolved = resolve(path);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

export function editorialInputAskSlots(record: unknown): readonly OperatorInputAskSlotV1[] {
  if (!isEditorialInputAskRecord(record)) return [];
  const outcome = (record as { workflowOutcome?: { findings?: unknown } }).workflowOutcome;
  const findings = Array.isArray(outcome?.findings) ? outcome.findings : [];
  const slots: OperatorInputAskSlotV1[] = [];
  const seen = new Set<string>();
  for (const finding of findings) {
    if (!finding || typeof finding !== "object" || Array.isArray(finding)) continue;
    const item = finding as { kind?: unknown; inputId?: unknown };
    if (item.kind !== "missing-governed-input" || typeof item.inputId !== "string") continue;
    if (seen.has(item.inputId)) continue;
    const presentation = editorialInputAskPresentationV1(item.inputId);
    if (!presentation) continue;
    seen.add(item.inputId);
    slots.push({
      inputId: item.inputId,
      fillKind: presentation.fillKind,
      label: presentation.label,
    });
  }
  return Object.freeze(slots);
}

export function retainedWorkspaceSnapshotSha256(record: unknown): string | undefined {
  if (!record || typeof record !== "object" || Array.isArray(record)) return undefined;
  const root = record as {
    workflowBranchCoverage?: { workspaceSnapshotSha256?: unknown };
    steps?: unknown;
  };
  const coverage = root.workflowBranchCoverage?.workspaceSnapshotSha256;
  if (typeof coverage === "string" && SHA256.test(coverage)) return coverage;
  if (!Array.isArray(root.steps)) return undefined;
  for (const step of root.steps) {
    if (!step || typeof step !== "object" || Array.isArray(step)) continue;
    const item = step as {
      id?: unknown;
      searchEvidence?: { workspaceSnapshotSha256?: unknown };
      searchParticipation?: { workspaceSnapshotSha256?: unknown };
    };
    const fromEvidence = item.searchEvidence?.workspaceSnapshotSha256;
    if (typeof fromEvidence === "string" && SHA256.test(fromEvidence)) return fromEvidence;
    const fromParticipation = item.searchParticipation?.workspaceSnapshotSha256;
    if (typeof fromParticipation === "string" && SHA256.test(fromParticipation)) {
      return fromParticipation;
    }
    if (item.id === "plan-documentation") {
      const planEvidence = item.searchEvidence?.workspaceSnapshotSha256;
      if (typeof planEvidence === "string" && SHA256.test(planEvidence)) return planEvidence;
    }
  }
  return undefined;
}

export function retainedPlanBindingDigest(record: unknown): string | undefined {
  if (!record || typeof record !== "object" || Array.isArray(record)) return undefined;
  const steps = (record as { steps?: unknown }).steps;
  if (!Array.isArray(steps)) return undefined;
  for (const step of steps) {
    if (!step || typeof step !== "object" || Array.isArray(step)) continue;
    const item = step as { id?: unknown; planBinding?: { digest?: unknown } };
    if (item.id !== "plan-documentation") continue;
    const digest = item.planBinding?.digest;
    return typeof digest === "string" && SHA256.test(digest) ? digest : undefined;
  }
  return undefined;
}

export function evaluateResumeSkip(input: {
  readonly record: unknown;
  readonly currentWorkspaceSnapshotSha256?: string;
}): {
  readonly skipPlanner: boolean;
  readonly skipSearchObserve: boolean;
  readonly revalidate: boolean;
} {
  const retainedSnapshot = retainedWorkspaceSnapshotSha256(input.record);
  const planBinding = retainedPlanBindingDigest(input.record);
  const current = input.currentWorkspaceSnapshotSha256;
  const match =
    typeof retainedSnapshot === "string" &&
    typeof current === "string" &&
    retainedSnapshot === current &&
    typeof planBinding === "string";
  return {
    skipPlanner: match,
    skipSearchObserve: match,
    revalidate: !match,
  };
}

export function textFillForbidsVerifiedNoChange(
  fills: readonly Pick<OperatorInputFillV1, "fillKind" | "source" | "role">[],
): boolean {
  return fills.some(
    (fill) =>
      TEXT_SLOT_KINDS.has(fill.fillKind) ||
      fill.source === "reply-text" ||
      fill.role === "request" ||
      fill.role === "accepted-knowledge",
  );
}

export async function observeWorkspaceSnapshotSha256(
  repositoryPath: string,
  revision: string,
): Promise<string | undefined> {
  try {
    return await withRepositoryWorkspace(repositoryPath, revision, async (workspace) => {
      const inventory = await buildRepositoryDiscoveryInventory({ workspace });
      return inventory.inventorySha256;
    });
  } catch {
    return undefined;
  }
}

export async function listOpenEditorialRuns(stateDirectory: string): Promise<OpenEditorialRunV1[]> {
  let entries;
  try {
    entries = await readdir(stateDirectory, { withFileTypes: true });
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) return [];
    throw new OperatorInputFillError("The saved run directory could not be read.");
  }
  const candidates = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (candidates.length > MAX_LIST_RECORDS) {
    throw new OperatorInputFillError(
      "The saved run directory contains too many records to list safely.",
    );
  }
  const open: OpenEditorialRunV1[] = [];
  for (const entry of candidates) {
    const runId = entry.name.slice(0, -5);
    if (!SAFE_RECORD_ID.test(runId)) continue;
    let loaded: OpenEditorialRunV1 | undefined;
    try {
      loaded = await loadOpenEditorialRun(runId, stateDirectory);
    } catch (error) {
      // One record over runs.recordMaxBytes must not stop every request in
      // this directory; it is named on stderr instead of silently skipped.
      if (!(error instanceof OperationalLimitError)) throw error;
      process.stderr.write(
        `WARNING ${error.code}: saved run ${runId} was not checked for an open InputAsk. ${error.message}\n`,
      );
      continue;
    }
    if (loaded) open.push(loaded);
  }
  return open.sort((left, right) => left.runId.localeCompare(right.runId));
}

export async function selectOpenEditorialRun(input: {
  readonly stateDirectory: string;
  readonly continueFrom?: string;
  readonly repositoryPath?: string;
  readonly repositoryArgument?: string;
  readonly revision?: string;
  readonly revisionExplicit?: boolean;
  readonly attachPaths?: readonly string[];
  readonly replyText?: string;
}): Promise<OpenEditorialRunV1> {
  const open = await listOpenEditorialRuns(input.stateDirectory);
  const scoped = input.repositoryPath
    ? open.filter(
        (item) =>
          canonicalRepositoryPath(item.repositoryPath) ===
          canonicalRepositoryPath(input.repositoryPath!),
      )
    : open;
  if (input.continueFrom !== undefined) {
    const match = open.find((item) => item.runId === input.continueFrom);
    if (!match) {
      if (input.continueFrom !== undefined && input.repositoryPath !== undefined) {
        const planner = await plannerRecoveryRefusal(input);
        if (planner) throw planner;
      }
      const superseded = SAFE_RECORD_ID.test(input.continueFrom)
        ? await supersedingRunState(input.stateDirectory, input.continueFrom)
        : undefined;
      throw new OperatorInputFillError(
        superseded
          ? supersededMessage(
              input.continueFrom,
              await supersessionTip(input.stateDirectory, input.continueFrom, superseded),
            )
          : `No open editorial needs-input run named ${input.continueFrom} is available to continue.`,
      );
    }
    if (
      input.repositoryPath !== undefined &&
      canonicalRepositoryPath(match.repositoryPath) !==
        canonicalRepositoryPath(input.repositoryPath)
    ) {
      throw new OperatorInputFillError(
        `No open editorial needs-input run named ${input.continueFrom} is available to continue.`,
      );
    }
    return match;
  }
  if (scoped.length === 0) {
    throw new OperatorInputFillError("No open editorial needs-input run is available to continue.");
  }
  if (scoped.length > 1) {
    const ids = scoped.map((item) => item.runId).join(", ");
    throw new OperatorInputFillError(
      `More than one open editorial needs-input run exists (${ids}). Pass --continue <run-id>.`,
    );
  }
  return scoped[0]!;
}

/** Existing planner stops can only be amended through an ordinary new run. */
async function plannerRecoveryRefusal(input: {
  readonly stateDirectory: string;
  readonly continueFrom?: string;
  readonly repositoryPath?: string;
  readonly repositoryArgument?: string;
  readonly revision?: string;
  readonly revisionExplicit?: boolean;
  readonly attachPaths?: readonly string[];
  readonly replyText?: string;
}): Promise<OperatorInputFillError | undefined> {
  const runId = input.continueFrom;
  if (!runId || !SAFE_RECORD_ID.test(runId) || !input.repositoryPath) return undefined;
  let record: Awaited<ReturnType<typeof readSavedRecord>>;
  try {
    record = await readSavedRecord(input.stateDirectory, runId);
  } catch (error) {
    // The listing already names the bound; the targeted lookup must not reveal foreign existence.
    if (error instanceof OperationalLimitError) return undefined;
    throw error;
  }
  if (!record) return undefined;
  const savedRepository = record.repository;
  if (!savedRepository || typeof savedRepository !== "object" || Array.isArray(savedRepository))
    return undefined;
  const repositoryPath = (savedRepository as Record<string, unknown>).sourcePath;
  if (
    typeof repositoryPath !== "string" ||
    canonicalRepositoryPath(repositoryPath) !== canonicalRepositoryPath(input.repositoryPath)
  )
    return undefined;
  if ((await supersedingRunState(input.stateDirectory, runId)) !== undefined) return undefined;
  try {
    decodeSavedRunRecord(record as JsonEvidenceValue, runId);
  } catch {
    return undefined;
  }
  const workspace = record.workspace;
  if (
    !workspace ||
    typeof workspace !== "object" ||
    Array.isArray(workspace) ||
    (workspace as Record<string, unknown>).strategy !== "tracked-export" ||
    (workspace as Record<string, unknown>).disposable !== true ||
    typeof (savedRepository as Record<string, unknown>).requestedRevision !== "string"
  )
    return undefined;
  if (!isPlannerGovernedInputRecord(record)) return undefined;
  const base = `Run ${runId} stopped at the planner stage, which do --continue cannot resume. The saved run remains unchanged.`;
  const unsupported = (reason: string) =>
    new OperatorInputFillError(
      `${base} ${reason}`,
      "continue-planner-input-unsupported",
      `Inspect docsfab runs show ${shellArgument(runId)} and start a new amended run with the original request after resolving: ${reason}`,
    );
  const workflow = record.workflow;
  const savedRevision = (savedRepository as Record<string, unknown>).revision;
  const instruction = record.instruction;
  if (
    (workflow !== "create-documentation" && workflow !== "update-documentation") ||
    typeof savedRevision !== "string" ||
    !/^[a-f0-9]{40,64}$/u.test(savedRevision) ||
    typeof instruction !== "string" ||
    !instruction.trim()
  ) {
    return unsupported(
      "The saved workflow, full revision, or original instruction cannot be replayed safely.",
    );
  }
  if (record.instructionContext !== undefined) {
    return unsupported("The retained instruction context has no exact new-run CLI replay option.");
  }
  if (record.readerEvidenceRequest !== undefined) {
    try {
      decodeRunRecordReaderEvidenceRequest(record.readerEvidenceRequest, workflow);
    } catch {
      return unsupported("The retained reader or comparison binding is malformed.");
    }
    return unsupported(
      "The retained reader or comparison binding needs a separate explicit new-run selection.",
    );
  }
  if (record.changeSourceRelease !== undefined)
    return unsupported("The retained release binding cannot be replayed by this command.");
  if (record.changeSources !== undefined) {
    try {
      decodeRunChangeSources(record.changeSources, workflow);
    } catch {
      return unsupported("The retained change binding is malformed.");
    }
    return unsupported("The retained change binding needs a separate explicit new-run selection.");
  }
  let retained: string[] = [];
  if (record.retainedEvidenceBindings !== undefined) {
    let bindings: RetainedEvidenceBindingsV1;
    try {
      bindings = decodeRetainedEvidenceBindings(record.retainedEvidenceBindings, workflow);
    } catch {
      return unsupported("The retained source binding is malformed.");
    }
    if (bindings.changeRequest)
      return unsupported("The retained PR binding cannot be replayed by this command.");
    retained = retainedSourcePaths(bindings);
  }
  const attachments = input.attachPaths ?? [];
  if (attachments.some((path) => isAbsolute(path))) {
    return unsupported(
      "An absolute --attach operator file cannot become a repository --source; nominate a tracked repository-relative source.",
    );
  }
  if (attachments.length === 0 && !input.replyText?.trim()) {
    return unsupported(
      "Supply an actual reply or a tracked repository-relative --attach source to amend the request.",
    );
  }
  const sources = [...new Set([...retained, ...attachments])].sort();
  try {
    admitCliSourceSelection(
      sources.flatMap((path) => ["--source", path]),
      { workflow },
    );
  } catch {
    return unsupported("A source path is not a valid repository-relative --source selection.");
  }
  let revision: string;
  try {
    const selector = input.revisionExplicit ? input.revision : "HEAD";
    if (
      typeof selector !== "string" ||
      !selector ||
      selector.startsWith("-") ||
      /[\s\u0000-\u001f\u007f]/u.test(selector)
    ) {
      throw new Error("The selected new-run revision has an invalid selector.");
    }
    revision = execFileSync(
      "git",
      ["-C", repositoryPath, "rev-parse", "--verify", "--end-of-options", `${selector}^{commit}`],
      {
        encoding: "utf8",
        env: credentialFreeGitEnvironment(),
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim();
    if (!/^[a-f0-9]{40,64}$/u.test(revision))
      throw new Error("Git returned an invalid commit identity for the selected new-run revision.");
  } catch {
    return unsupported(
      "The selected new-run revision does not resolve to a commit in this repository; choose a valid revision containing the nominated sources.",
    );
  }
  for (const source of sources) {
    try {
      const tree = execFileSync(
        "git",
        ["-C", repositoryPath, "ls-tree", "-z", revision, "--", source],
        {
          encoding: "utf8",
          env: credentialFreeGitEnvironment(),
        },
      );
      if (!/^100(?:644|755) blob [a-f0-9]+\t/u.test(tree) || !tree.endsWith(`\t${source}\0`)) {
        return unsupported(
          `Source ${source} is not a regular tracked file at new-run revision ${revision}; commit it or choose a revision containing it.`,
        );
      }
    } catch {
      return unsupported(
        `Source ${source} could not be verified at new-run revision ${revision}; choose a valid tracked source and start a new run.`,
      );
    }
  }
  const reply = input.replyText?.trim() ? input.replyText : undefined;
  if (reply && containsConfiguredCredential(reply))
    return unsupported("The reply contained a configured credential and was withheld.");
  if ([instruction, reply ?? ""].some((value) => /[\r\n\u0000-\u001f\u007f]/u.test(value))) {
    return unsupported(
      "The saved request or reply contains control characters that cannot be displayed as a safe shell command.",
    );
  }
  const amended = reply ? `${instruction}\n\nOperator amendment:\n${reply}` : instruction;
  const repoArgument =
    input.repositoryArgument &&
    !isAbsolute(input.repositoryArgument) &&
    canonicalRepositoryPath(input.repositoryArgument) === canonicalRepositoryPath(repositoryPath)
      ? input.repositoryArgument
      : canonicalRepositoryPath(process.cwd()) === canonicalRepositoryPath(repositoryPath)
        ? "."
        : undefined;
  if (!repoArgument) {
    return unsupported(
      "Run from the saved repository with --repo ., or use a validated relative --repo path from this invocation directory.",
    );
  }
  const args = [
    "docsfab",
    "run",
    workflow,
    "--repo",
    repoArgument,
    "--revision",
    revision,
    "--instruction",
    amended,
    ...sources.flatMap((source) => ["--source", source]),
    "--patch-only",
  ];
  const command = args.map(shellArgument).join(" ");
  // Match the envelope's full scrub so a redacted command is never offered as executable.
  if (sanitizeDisplayText(redactCredentialMaterial(command)) !== command) {
    return unsupported(
      "The exact amended command contains private path or credential material that output protection would change. Run from the saved repository and use --repo . with the original request and nominated sources.",
    );
  }
  return new OperatorInputFillError(
    `${base} The offered command starts a new run at revision ${revision}.`,
    "continue-planner-input-unsupported",
    command,
  );
}

function shellArgument(value: string): string {
  return /^[A-Za-z0-9_.\-/:@]+$/u.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

export async function planOperatorInputResume(input: {
  readonly stateDirectory: string;
  readonly continueFrom?: string;
  readonly repositoryPath: string;
  readonly repositoryArgument?: string;
  readonly revision: string;
  /** Whether the operator named `revision`; a retained base-head pins it otherwise. */
  readonly revisionExplicit?: boolean;
  readonly replyText?: string;
  /** An explicit live answer names its open text/request slot. CLI --reply may omit it. */
  readonly replyInputId?: string;
  readonly attachPaths?: readonly string[];
  readonly currentWorkspaceSnapshotSha256?: string;
  readonly now?: () => Date;
}): Promise<OperatorInputResumePlanV1> {
  const attachPaths = input.attachPaths ?? [];
  const reply = input.replyText?.trim() ? input.replyText : undefined;
  if (!reply && attachPaths.length === 0) {
    if (input.continueFrom) {
      await selectOpenEditorialRun({
        stateDirectory: input.stateDirectory,
        continueFrom: input.continueFrom,
        repositoryPath: input.repositoryPath,
        repositoryArgument: input.repositoryArgument,
        revision: input.revision,
        revisionExplicit: input.revisionExplicit,
      });
    }
    throw new OperatorInputFillError(
      "Continuing an editorial job requires a reply sentence and/or --attach <path>.",
    );
  }
  if (attachPaths.length > OPERATOR_INPUT_MAX_NOMINATIONS) {
    throw new OperatorInputFillError(
      "Too many --attach nominations were supplied for this InputAsk resume.",
    );
  }
  const selected = await selectOpenEditorialRun({
    stateDirectory: input.stateDirectory,
    continueFrom: input.continueFrom,
    repositoryPath: input.repositoryPath,
    repositoryArgument: input.repositoryArgument,
    revision: input.revision,
    revisionExplicit: input.revisionExplicit,
    attachPaths: input.attachPaths,
    replyText: input.replyText,
  });
  // Decoded here, never in the open-run listing, so a malformed value refuses
  // by name instead of hiding the run.
  const retained = retainedReaderEvidence(selected);
  const bindings = retainedBindings(selected);
  const revision = continuedRevision(selected.runId, retained, input);
  const when = (input.now ?? (() => new Date()))().toISOString();
  const fills = await bindOperatorInputFills({
    slots: selected.slots,
    replyText: reply,
    replyInputId: input.replyInputId,
    attachPaths,
    repositoryPath: selected.repositoryPath,
    when,
  });
  const currentSnapshot =
    input.currentWorkspaceSnapshotSha256 ??
    (await observeWorkspaceSnapshotSha256(selected.repositoryPath, revision));
  // A newly approved source must be bound by a new plan, so the retained
  // planBinding cannot match and the plan revalidates.
  const skip = fills.some((fill) => fill.role === "approved-source")
    ? { skipPlanner: false, skipSearchObserve: false, revalidate: true }
    : evaluateResumeSkip({
        record: selected.record,
        ...(currentSnapshot ? { currentWorkspaceSnapshotSha256: currentSnapshot } : {}),
      });
  const filledSources: ReaderSourceHintV1[] = fills
    .filter((fill) => fill.source === "tracked-path" && fill.role !== "approved-source")
    .map((fill) => ({
      role: fill.role === "public-contract" ? "public-contract" : "current-documentation",
      path: fill.locator,
    }));
  const readerSources = unionReaderSources(retained?.readerSources ?? [], filledSources);
  return {
    originalRunId: selected.runId,
    workflow: selected.workflow,
    instruction: selected.instruction,
    instructionSha256: digestInstruction(selected.instruction),
    ...(selected.instructionContext ? { instructionContext: selected.instructionContext } : {}),
    repositoryPath: selected.repositoryPath,
    revision,
    fills,
    skipPlanner: skip.skipPlanner,
    skipSearchObserve: skip.skipSearchObserve,
    revalidate: skip.revalidate,
    verifiedNoChange: false,
    ...(bindings.retainedEvidenceBindings
      ? { retainedEvidenceBindings: bindings.retainedEvidenceBindings }
      : {}),
    ...(bindings.changeSources ? { changeSources: bindings.changeSources } : {}),
    readerSources,
    ...(retained?.comparisonRequest ? { comparisonRequest: retained.comparisonRequest } : {}),
    slots: selected.slots,
    continuationRunId: randomUUID(),
  };
}

const SUPERSESSION_DIRECTORY = "input-ask-supersession";
const SUPERSESSION_KIND = "docsfab-input-ask-supersession";
const SUPERSESSION_SEQUENCE = /^[1-9][0-9]*$/u;

/** Process liveness for a continuation's owner; the shared process-birth probe by default. */
export interface OperatorInputProcessInspector {
  inspect(pid: number): { alive: boolean; identity?: string };
}

const DEFAULT_PROCESS_INSPECTOR: OperatorInputProcessInspector = { inspect: inspectProcessBirth };

/**
 * Where a stopped run's chain stands. `open`: the successor is itself a
 * continuable input stop. `running`: the successor is queued, running, or has
 * no record yet, under a live owner. `completed`: the successor succeeded.
 * Any other successor state supersedes nothing, so the stopped run is open again.
 */
export interface OperatorInputSupersessionStateV1 {
  readonly successor: string;
  readonly state: "open" | "running" | "completed";
}

/** The host's claim on one continuation; release it when no record was saved. */
export interface OperatorInputSupersessionClaimV1 {
  /** Remove this claim when its continuation never saved a record. Never throws. */
  release(): Promise<void>;
}

/**
 * Durably record that a stopped editorial run is continued by
 * `plan.continuationRunId`, before that continuation starts.
 *
 * Claims live beside the run records as
 * `input-ask-supersession/<stopped-run-id>.<sequence>.json`. Each continuation
 * claims the next sequence with an exclusive link, so a concurrent second
 * continuation is refused instead of overwriting the first, and a live owner's
 * claim refuses a new one even before its run saved a record. The caller
 * releases the claim when the continuation ends without a record.
 */
export async function recordOperatorInputSupersession(input: {
  readonly stateDirectory: string;
  readonly plan: Pick<OperatorInputResumePlanV1, "originalRunId" | "continuationRunId" | "fills">;
  readonly now?: () => Date;
  readonly processes?: OperatorInputProcessInspector;
}): Promise<OperatorInputSupersessionClaimV1> {
  const { originalRunId, continuationRunId } = input.plan;
  if (
    !continuationRunId ||
    !SAFE_RECORD_ID.test(originalRunId) ||
    !SAFE_RECORD_ID.test(continuationRunId)
  ) {
    throw new OperatorInputFillError("The editorial continuation has no safe run identity.");
  }
  const processes = input.processes ?? DEFAULT_PROCESS_INSPECTOR;
  const directory = join(input.stateDirectory, SUPERSESSION_DIRECTORY);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const markers = await supersessionMarkers(directory, originalRunId);
  const current = await evaluateSupersession(
    input.stateDirectory,
    originalRunId,
    markers.at(-1),
    processes,
  );
  if (current) {
    throw new OperatorInputFillError(
      supersededMessage(
        originalRunId,
        await supersessionTip(input.stateDirectory, originalRunId, current, processes),
      ),
    );
  }
  const sequence = (markers.at(-1)?.sequence ?? 0) + 1;
  const owner = processes.inspect(process.pid);
  const body = {
    schemaVersion: 1,
    kind: SUPERSESSION_KIND,
    originalRunId,
    supersededBy: continuationRunId,
    sequence,
    owner: { pid: process.pid, processBirthIdentity: owner.identity ?? null },
    inputIds: input.plan.fills.map((fill) => fill.inputId),
    recordedAt: (input.now ?? (() => new Date()))().toISOString(),
  };
  const target = join(directory, `${originalRunId}.${String(sequence)}.json`);
  const temporary = join(directory, `.${originalRunId}.${continuationRunId}.tmp`);
  await writeFile(temporary, `${JSON.stringify(body)}\n`, { mode: 0o600, flag: "wx" });
  try {
    await link(temporary, target);
  } catch (error) {
    if (hasErrnoCode(error, "EEXIST")) {
      throw new OperatorInputFillError(
        `Run ${originalRunId} is already being continued by another continuation. Wait for it, then continue the run it names.`,
      );
    }
    throw error;
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
  return {
    release: async () => {
      try {
        if (await savedRecordExists(input.stateDirectory, continuationRunId)) return;
        const claimed = parseJsonEvidence(await readFile(target)) as {
          supersededBy?: unknown;
        } | null;
        if (claimed?.supersededBy === continuationRunId) await unlink(target);
      } catch {
        // An unreleased claim with a dead owner reopens the stop on its own.
      }
    },
  };
}

async function supersessionMarkers(
  directory: string,
  runId: string,
): Promise<{ readonly sequence: number; readonly path: string }[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) return [];
    throw error;
  }
  const prefix = `${runId}.`;
  const markers: { sequence: number; path: string }[] = [];
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith(".json")) continue;
    const sequence = name.slice(prefix.length, -".json".length);
    if (!SUPERSESSION_SEQUENCE.test(sequence)) continue;
    const value = Number(sequence);
    if (!Number.isSafeInteger(value)) continue;
    markers.push({ sequence: value, path: join(directory, name) });
  }
  return markers.sort((left, right) => left.sequence - right.sequence);
}

/** The latest claim's effect on `runId`, or `undefined` when the run is open again. */
async function supersedingRunState(
  stateDirectory: string,
  runId: string,
  processes: OperatorInputProcessInspector = DEFAULT_PROCESS_INSPECTOR,
): Promise<OperatorInputSupersessionStateV1 | undefined> {
  try {
    const markers = await supersessionMarkers(join(stateDirectory, SUPERSESSION_DIRECTORY), runId);
    return await evaluateSupersession(stateDirectory, runId, markers.at(-1), processes);
  } catch (error) {
    // A record over the run-record bound is reported by name, never read as absent.
    if (error instanceof OperationalLimitError) throw error;
    return undefined;
  }
}

/**
 * Follow an `open` successor that was itself continued to the run that now
 * holds the chain, so a refusal never names a run that continue would refuse.
 */
async function supersessionTip(
  stateDirectory: string,
  runId: string,
  first: OperatorInputSupersessionStateV1,
  processes: OperatorInputProcessInspector = DEFAULT_PROCESS_INSPECTOR,
): Promise<OperatorInputSupersessionStateV1> {
  let current = first;
  const seen = new Set([runId]);
  while (current.state === "open" && !seen.has(current.successor)) {
    seen.add(current.successor);
    const next = await supersedingRunState(stateDirectory, current.successor, processes);
    if (!next) break;
    current = next;
  }
  return current;
}

/**
 * The operator input of the run that began the continuation chain ending at
 * `stoppedRunId`, the run an InputAsk continuation resumes. A continuation
 * records `continuation` with the reason `operator-input-resume` and no link
 * to its parent, so the chain is walked back through the supersession claims,
 * each naming the run its continuation superseded, to the first run that is no
 * such continuation. Legacy records without explicit targets retain only
 * their text. `undefined` when any link, record, or input cannot be read,
 * the continuation markers disagree with predecessor evidence, or the chain loops.
 */
export async function continuationChainOriginalInput(
  stateDirectory: string,
  stoppedRunId: string,
): Promise<
  { readonly instruction: string; readonly explicitPaths: readonly string[] } | undefined
> {
  const seen = new Set<string>();
  let runId: string | undefined = stoppedRunId;
  while (runId !== undefined && !seen.has(runId)) {
    if (!SAFE_RECORD_ID.test(runId)) return undefined;
    seen.add(runId);
    const record = await readSavedRecord(stateDirectory, runId);
    if (!record) return undefined;
    const origin = recordedNamingOrigin(record);
    if (origin === undefined) return undefined;
    const predecessor = await supersededPredecessor(stateDirectory, runId);
    if (predecessor === undefined) return undefined;
    if (origin === "operator-continuation") {
      if (predecessor === null) return undefined;
      runId = predecessor;
      continue;
    }
    // An incoming claim proves this was continued, even if its marker was
    // erased or replaced by an otherwise valid original-run admission.
    if (predecessor !== null || typeof record.instruction !== "string") return undefined;
    try {
      return {
        instruction: record.instruction,
        explicitPaths:
          record.operatorTargetPaths === undefined
            ? []
            : decodeOperatorTargetPaths(record.operatorTargetPaths),
      };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Classify host continuation markers without promoting the model's sealed reading. */
function recordedNamingOrigin(record: {
  readonly [key: string]: unknown;
}): "original" | "operator-continuation" | undefined {
  const requestIntent = record.requestIntent;
  // Genuine legacy original records have no interpretation field. The caller
  // must still prove that no supersession claim identifies a predecessor.
  if (requestIntent === undefined) return "original";
  try {
    const admission = decodeRunRecordRequestIntentAdmission(requestIntent);
    return admission.outcome === "continuation" && admission.reason === "operator-input-resume"
      ? "operator-continuation"
      : "original";
  } catch (error) {
    if (!(error instanceof RequestIntentContractError)) throw error;
    return undefined;
  }
}

/** A unique valid predecessor; null means none, undefined means incomplete or ambiguous evidence. */
async function supersededPredecessor(
  stateDirectory: string,
  runId: string,
): Promise<string | null | undefined> {
  let names: string[];
  try {
    names = await readdir(join(stateDirectory, SUPERSESSION_DIRECTORY));
  } catch (error) {
    return hasErrnoCode(error, "ENOENT") ? null : undefined;
  }
  let predecessor: string | null = null;
  for (const name of names.sort()) {
    if (name.startsWith(".") || !name.endsWith(".json")) continue;
    let value: {
      schemaVersion?: unknown;
      kind?: unknown;
      originalRunId?: unknown;
      supersededBy?: unknown;
      sequence?: unknown;
    } | null;
    try {
      value = parseJsonEvidence(
        await readFile(join(stateDirectory, SUPERSESSION_DIRECTORY, name)),
      ) as typeof value;
    } catch {
      // An unreadable claim could name this run; absence is not established.
      return undefined;
    }
    const original = value?.originalRunId;
    const sequence = value?.sequence;
    if (
      value?.schemaVersion !== 1 ||
      value.kind !== SUPERSESSION_KIND ||
      typeof original !== "string" ||
      !SAFE_RECORD_ID.test(original) ||
      typeof value.supersededBy !== "string" ||
      !SAFE_RECORD_ID.test(value.supersededBy) ||
      typeof sequence !== "number" ||
      !Number.isSafeInteger(sequence) ||
      !SUPERSESSION_SEQUENCE.test(String(sequence)) ||
      name !== `${original}.${String(sequence)}.json`
    )
      return undefined;
    if (value.supersededBy !== runId) continue;
    if (predecessor !== null) return undefined;
    predecessor = original;
  }
  return predecessor;
}

async function evaluateSupersession(
  stateDirectory: string,
  runId: string,
  marker: { readonly sequence: number; readonly path: string } | undefined,
  processes: OperatorInputProcessInspector,
): Promise<OperatorInputSupersessionStateV1 | undefined> {
  if (!marker) return undefined;
  try {
    const value = parseJsonEvidence(await readFile(marker.path)) as {
      kind?: unknown;
      originalRunId?: unknown;
      supersededBy?: unknown;
      sequence?: unknown;
      owner?: { pid?: unknown; processBirthIdentity?: unknown };
    } | null;
    const successor = value?.supersededBy;
    if (
      value?.kind !== SUPERSESSION_KIND ||
      value.originalRunId !== runId ||
      value.sequence !== marker.sequence ||
      typeof successor !== "string" ||
      !SAFE_RECORD_ID.test(successor)
    ) {
      return undefined;
    }
    const ownerLive = ownerAlive(value.owner, processes);
    const record = await readSavedRecord(stateDirectory, successor);
    if (!record) return ownerLive ? { successor, state: "running" } : undefined;
    if (await continuableEditorialInputStop(record, stateDirectory)) {
      return { successor, state: "open" };
    }
    if (record.status === "succeeded") return { successor, state: "completed" };
    if ((record.status === "queued" || record.status === "running") && ownerLive) {
      return { successor, state: "running" };
    }
    return undefined;
  } catch (error) {
    if (error instanceof OperationalLimitError) throw error;
    return undefined;
  }
}

/**
 * An owner whose start identity cannot be read counts as alive, matching
 * knowledge continuation; a recorded identity that differs from the live
 * process's is a reborn pid.
 */
function ownerAlive(
  owner: { pid?: unknown; processBirthIdentity?: unknown } | undefined,
  processes: OperatorInputProcessInspector,
): boolean {
  const pid = owner?.pid;
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return false;
  const current = processes.inspect(pid);
  if (!current.alive) return false;
  const recorded = owner?.processBirthIdentity;
  if (typeof recorded !== "string" || current.identity === undefined) return true;
  return current.identity === recorded;
}

function supersededMessage(runId: string, tip: OperatorInputSupersessionStateV1): string {
  switch (tip.state) {
    case "open":
      return `Run ${runId} was already continued; ${tip.successor} is the open run in that chain. Continue ${tip.successor} instead.`;
    case "running":
      return `Run ${runId} is being continued as ${tip.successor}. Wait for that run to finish.`;
    case "completed":
      return `Run ${runId} was already continued as ${tip.successor}, which completed.`;
  }
}

async function savedRecordExists(stateDirectory: string, runId: string): Promise<boolean> {
  try {
    return (await stat(join(stateDirectory, `${runId}.json`))).isFile();
  } catch {
    return false;
  }
}

/**
 * A saved run record whose `id` matches its file name, or `undefined`. A record
 * over `runs.recordMaxBytes` refuses with that limit's code and size rather
 * than reading as absent; nothing else throws.
 */
async function readSavedRecord(
  stateDirectory: string,
  runId: string,
): Promise<{ readonly [key: string]: unknown } | undefined> {
  try {
    const recordPath = join(stateDirectory, `${runId}.json`);
    const metadata = await lstat(recordPath);
    if (!metadata.isFile()) return undefined;
    enforceRunRecordMaxBytes(metadata.size);
    const value = parseJsonEvidence(await readFile(recordPath));
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const record = value as { readonly [key: string]: unknown };
    return record.id === runId ? record : undefined;
  } catch (error) {
    if (error instanceof OperationalLimitError) throw error;
    return undefined;
  }
}

export async function bindOperatorInputFills(input: {
  readonly slots: readonly OperatorInputAskSlotV1[];
  readonly replyText?: string;
  readonly replyInputId?: string;
  readonly attachPaths: readonly string[];
  readonly repositoryPath: string;
  readonly when: string;
}): Promise<readonly OperatorInputFillV1[]> {
  const unmatched = [...input.slots];
  const fills: OperatorInputFillV1[] = [];
  let retained = 0;
  for (const attachPath of input.attachPaths) {
    // A source-support slot takes only a repository file the plan can bind, so
    // an operator file outside the checkout never fills one.
    const trackedOnly = !isAbsolute(attachPath);
    const slot =
      takeSlot(unmatched, PATH_SLOT_KINDS, trackedOnly) ??
      takeSlot(unmatched, TEXT_SLOT_KINDS, trackedOnly);
    if (!slot) {
      throw new OperatorInputFillError(
        "An --attach file was supplied with no remaining InputAsk slot that can accept a file fill.",
      );
    }
    const admitted = await admitAttach(attachPath, input.repositoryPath, slot);
    retained += admitted.byteLength;
    if (retained > OPERATOR_INPUT_MAX_RETAINED_BYTES) {
      throw new OperatorInputFillError("Attached fills exceed the retained 8 MiB budget.");
    }
    fills.push({
      ...admitted,
      attribution: { who: "operator", what: slot.inputId, when: input.when },
    });
  }
  if (input.replyText !== undefined) {
    const slot =
      input.replyInputId === undefined
        ? takeSlot(unmatched, TEXT_SLOT_KINDS)
        : unmatched.find(
            (candidate) =>
              candidate.inputId === input.replyInputId && TEXT_SLOT_KINDS.has(candidate.fillKind),
          );
    if (!slot && input.replyInputId !== undefined) {
      throw new OperatorInputFillError(
        "The named InputAsk slot is not open for a text reply. Next: use an open text/request input ID followed by ': <answer>', or supply the exact repository path for a file slot.",
      );
    }
    if (!slot) {
      throw new OperatorInputFillError(
        "A reply sentence was supplied with no remaining text or request InputAsk slot. Text cannot fill a comparison or file slot; supply the repository path of the file instead.",
      );
    }
    const textFill = admitReplyText(input.replyText, slot);
    retained += textFill.byteLength;
    if (retained > OPERATOR_INPUT_MAX_RETAINED_BYTES) {
      throw new OperatorInputFillError("Attached fills exceed the retained 8 MiB budget.");
    }
    fills.push({
      ...textFill,
      attribution: { who: "operator", what: slot.inputId, when: input.when },
    });
  }
  if (fills.length === 0) {
    throw new OperatorInputFillError(
      "No InputAsk fills were bound from the supplied reply or attachments.",
    );
  }
  return Object.freeze(fills);
}

function takeSlot(
  unmatched: OperatorInputAskSlotV1[],
  kinds: ReadonlySet<EditorialInputAskFillKindV1>,
  admitSourceSupport = false,
): OperatorInputAskSlotV1 | undefined {
  const index = unmatched.findIndex(
    (slot) =>
      kinds.has(slot.fillKind) &&
      (admitSourceSupport || parseSourceSupportInputIdV1(slot.inputId) === undefined),
  );
  if (index === -1) return undefined;
  return unmatched.splice(index, 1)[0];
}

function admitReplyText(
  replyText: string,
  slot: OperatorInputAskSlotV1,
): Omit<OperatorInputFillV1, "attribution"> {
  const text = slotString(replyText, "reply sentence");
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength > OPERATOR_INPUT_MAX_SOURCE_BYTES) {
    throw new OperatorInputFillError("The reply sentence exceeds the 1 MiB source cap.");
  }
  // Only DocsFab's own configured credentials stop an operator input (#1807).
  if (containsConfiguredCredential(text)) {
    throw new OperatorInputFillError(
      "The reply sentence contained a configured credential and was withheld.",
    );
  }
  return {
    inputId: slot.inputId,
    fillKind: slot.fillKind,
    role: slot.inputId === "request" ? "request" : "accepted-knowledge",
    source: "reply-text",
    sha256: sha256(bytes),
    byteLength: bytes.byteLength,
    locator: `request:${slot.inputId}`,
  };
}

async function admitAttach(
  attachPath: string,
  repositoryPath: string,
  slot: OperatorInputAskSlotV1,
): Promise<Omit<OperatorInputFillV1, "attribution">> {
  if (!attachPath || attachPath.includes("\0")) {
    throw new OperatorInputFillError("Each --attach path must be a non-empty filesystem path.");
  }
  if (isAbsolute(attachPath)) {
    return admitOperatorFile(attachPath, slot);
  }
  return admitTrackedOrOperatorFile(attachPath, repositoryPath, slot);
}

async function admitTrackedOrOperatorFile(
  relativePath: string,
  repositoryPath: string,
  slot: OperatorInputAskSlotV1,
): Promise<Omit<OperatorInputFillV1, "attribution">> {
  if (
    relativePath !== relativePath.normalize("NFC") ||
    relativePath.includes("\\") ||
    relativePath.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new OperatorInputFillError(
      "Each --attach repository path must be a safe repository-relative path.",
    );
  }
  const absolute = resolve(repositoryPath, relativePath);
  try {
    const bytes = await readCappedFile(absolute);
    const role =
      parseSourceSupportInputIdV1(slot.inputId) !== undefined
        ? "approved-source"
        : slot.inputId === "public-contract"
          ? "public-contract"
          : slot.fillKind === "path"
            ? "current-documentation"
            : "accepted-knowledge";
    return {
      inputId: slot.inputId,
      fillKind: slot.fillKind,
      role,
      source: PATH_SLOT_KINDS.has(slot.fillKind) ? "tracked-path" : "operator-file",
      sha256: sha256(bytes),
      byteLength: bytes.byteLength,
      locator: relativePath,
    };
  } catch (error) {
    if (error instanceof OperatorInputFillError) throw error;
    throw new OperatorInputFillError(
      "An --attach path could not be read as a tracked or operator file.",
    );
  }
}

async function admitOperatorFile(
  attachPath: string,
  slot: OperatorInputAskSlotV1,
): Promise<Omit<OperatorInputFillV1, "attribution">> {
  const bytes = await readCappedFile(attachPath);
  return {
    inputId: slot.inputId,
    fillKind: slot.fillKind,
    role:
      slot.fillKind === "path" && slot.inputId === "public-contract"
        ? "public-contract"
        : slot.fillKind === "path"
          ? "current-documentation"
          : "accepted-knowledge",
    source: "operator-file",
    sha256: sha256(bytes),
    byteLength: bytes.byteLength,
    locator: attachPath,
  };
}

async function readCappedFile(path: string): Promise<Uint8Array> {
  let info;
  try {
    info = await lstat(path);
  } catch {
    throw new OperatorInputFillError("An --attach path could not be read from disk.");
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new OperatorInputFillError(
      "Each --attach path must be a regular file, not a symbolic link.",
    );
  }
  if (info.size > OPERATOR_INPUT_MAX_SOURCE_BYTES) {
    throw new OperatorInputFillError("An attached file exceeds the 1 MiB source cap.");
  }
  const bytes = await readFile(path);
  if (bytes.byteLength > OPERATOR_INPUT_MAX_SOURCE_BYTES) {
    throw new OperatorInputFillError("An attached file exceeds the 1 MiB source cap.");
  }
  if (containsConfiguredCredential(bytes.toString("utf8"))) {
    throw new OperatorInputFillError(
      "An attached file contained a configured credential and was withheld.",
    );
  }
  return bytes;
}

function slotString(value: string, label: string): string {
  const text = value.normalize("NFC");
  if (!text.trim() || text.includes("\0")) {
    throw new OperatorInputFillError(`The ${label} must be non-empty NFC text without NUL.`);
  }
  if (value !== text) {
    throw new OperatorInputFillError(
      `The ${label} must already be NFC-normalized before it is admitted.`,
    );
  }
  return text;
}

async function loadOpenEditorialRun(
  runId: string,
  stateDirectory: string,
): Promise<OpenEditorialRunV1 | undefined> {
  const record = await readSavedRecord(stateDirectory, runId);
  const stop = record ? await continuableEditorialInputStop(record, stateDirectory) : undefined;
  if (!stop) return undefined;
  if ((await supersedingRunState(stateDirectory, runId)) !== undefined) return undefined;
  return stop;
}

/**
 * The one definition of a continuable editorial input stop: a create or update
 * `needs-input` run with named InputAsk slots that the resumability classifier
 * calls resumable. Supersession claims separately decide whether a chain has
 * moved past it.
 */
export async function continuableEditorialInputStop(
  value: unknown,
  stateDirectory: string,
): Promise<OpenEditorialRunV1 | undefined> {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const record = value as { [key: string]: unknown };
    const runId = record.id;
    if (typeof runId !== "string" || !SAFE_RECORD_ID.test(runId)) return undefined;
    if (!isEditorialInputAskRecord(record)) return undefined;
    const resumability = await classifyRunResumability(record, stateDirectory);
    if (resumability.category !== "resumable" || resumability.reason !== "needs-input") {
      return undefined;
    }
    const workflow = record.workflow;
    if (workflow !== "create-documentation" && workflow !== "update-documentation") {
      return undefined;
    }
    const repository = record.repository;
    if (!repository || typeof repository !== "object" || Array.isArray(repository))
      return undefined;
    const repositoryPath = (repository as { sourcePath?: unknown }).sourcePath;
    const instruction = record.instruction;
    if (
      typeof repositoryPath !== "string" ||
      typeof instruction !== "string" ||
      !instruction.trim()
    ) {
      return undefined;
    }
    const slots = editorialInputAskSlots(record);
    if (slots.length === 0) return undefined;
    const instructionContext = record.instructionContext;
    return {
      runId,
      record,
      workflow,
      repositoryPath,
      instruction,
      ...(typeof instructionContext === "string" && instructionContext.trim()
        ? { instructionContext }
        : {}),
      ...(record.readerEvidenceRequest !== undefined
        ? { readerEvidenceRequest: record.readerEvidenceRequest }
        : {}),
      ...(record.retainedEvidenceBindings !== undefined
        ? { retainedEvidenceBindings: record.retainedEvidenceBindings }
        : {}),
      ...(record.changeSources !== undefined ? { changeSources: record.changeSources } : {}),
      slots,
    };
  } catch {
    return undefined;
  }
}

function digestInstruction(instruction: string): string {
  return createHash("sha256").update(instruction.normalize("NFC"), "utf8").digest("hex");
}
