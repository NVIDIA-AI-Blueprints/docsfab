// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { lstat, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { editorialInputAskPresentationV1 } from "../artifacts/editorial-input-ask.js";
import { DurableArtifactStore } from "../artifacts/store.js";
import {
  decodeKnowledgeAcceptedSnapshot,
  type KnowledgeAcceptedSnapshotV1,
} from "../canon/from-knowledge-snapshot.js";
import {
  continuationRequestedPageIntent,
  inspectRequestedPageSupport,
} from "../cli/knowledge-resume.js";
import { parseSetOptions, withoutSetOptions } from "../cli/model-setting-options.js";
import { parseRunArguments } from "../cli/run-arguments.js";
import { commandLineSettings } from "../config/model-settings.js";
import { canonicalDigest } from "../contract-kit/index.js";
import { inspectProcessBirth } from "../init/storage.js";
import type { RunRecord } from "../records/contracts.js";
import {
  decodeKnowledgeContinuationPrivateTask,
  decodeKnowledgeContinuationStoppedRun,
  matchesKnowledgeContinuationTargetConflictScope,
  type KnowledgeContinuationPrivateTask,
  type KnowledgeContinuationStoppedRunV1,
} from "../records/knowledge-continuation.js";
import { workflowOutcomeState } from "../workflow-contracts/outcome.js";
import {
  admitPlannerDiagnostic,
  isPlannerMissingGovernedInputCode,
} from "../workflow-contracts/planner-diagnostic.js";
import type { WorkflowOutcomeDecodeOptionsV1 } from "../workflow-contracts/outcome.js";
import {
  classifyLatest,
  KnowledgeContinuationAttemptStore,
  type KnowledgeContinuationAttemptV1,
  type KnowledgeContinuationProcessInspector,
} from "../records/knowledge-continuation-store.js";

/**
 * Read-only projection of saved run state through the strict stopped-run
 * reader and typed attempt journal. Never claims an attempt, recovers a
 * capability, or invents a command; execution revalidates authority and
 * bindings independently.
 */

export type RunResumabilityCategory = "terminal" | "blocked" | "resumable" | "non-resumable";

export type RunResumabilityReason =
  | "succeeded"
  | "failed"
  | "queued"
  | "running"
  | "needs-human-decision"
  | "needs-input"
  | "unsupported-status"
  | "unverifiable-receipt"
  | "unverifiable-attempt-journal"
  | "no-attempt-yet"
  | "safe-pre-execution-retry"
  | "attempt-in-progress"
  | "already-completed"
  | "recovery-required";

/** Minimized, public-safe presentation fact. No private evidence, ever. */
export interface RunResumabilityProjectionV1 {
  readonly category: RunResumabilityCategory;
  readonly reason: RunResumabilityReason;
}

export function knowledgeContinuationAttemptsDirectory(stateDirectory: string): string {
  return resolve(dirname(resolve(stateDirectory)), "knowledge-continuations");
}

export function knowledgeContinuationArtifactsDirectory(stateDirectory: string): string {
  return resolve(dirname(resolve(stateDirectory)), "artifacts");
}

/**
 * Classify one saved run for `runs list` and `runs show`. Never claims,
 * transitions, recovers a host capability, or contacts a provider or publisher.
 */
export async function classifyRunResumability(
  record: unknown,
  stateDirectory: string,
  processes?: KnowledgeContinuationProcessInspector,
  editorialDecodeOptions?: WorkflowOutcomeDecodeOptionsV1,
): Promise<RunResumabilityProjectionV1> {
  const inspector = processes ?? { inspect: inspectProcessBirth };
  const status = readStringField(record, "status");
  switch (status) {
    case "succeeded":
      return { category: "terminal", reason: "succeeded" };
    case "failed":
      return { category: "non-resumable", reason: "failed" };
    case "queued":
      return { category: "blocked", reason: "queued" };
    case "running":
      return { category: "blocked", reason: "running" };
    case "needs-human-decision":
      return humanDecisionResumability(record, editorialDecodeOptions);
    case "needs-input":
      break;
    default:
      return { category: "non-resumable", reason: "unsupported-status" };
  }
  if (!hasKnowledgeContinuationReceipt(record)) {
    if (isEditorialInputAskRecord(record)) {
      return { category: "resumable", reason: "needs-input" };
    }
    return { category: "blocked", reason: "needs-input" };
  }
  let stopped: KnowledgeContinuationStoppedRunV1;
  try {
    stopped = decodeKnowledgeContinuationStoppedRun(record);
  } catch {
    return { category: "non-resumable", reason: "unverifiable-receipt" };
  }
  let attempts: readonly KnowledgeContinuationAttemptV1[];
  try {
    attempts = await readAttemptsWithoutInitializing(stateDirectory, stopped.id, inspector);
  } catch {
    return { category: "non-resumable", reason: "unverifiable-attempt-journal" };
  }
  const latest = attempts.at(-1);
  if (!latest) return { category: "resumable", reason: "no-attempt-yet" };
  // `classifyLatest` owns owner-liveness inference, including the
  // alive-but-unknown-identity case a local copy would treat as safe to retry.
  const disposition = classifyLatest(latest, inspector);
  switch (disposition) {
    case "already-completed":
      return { category: "terminal", reason: "already-completed" };
    case "busy":
      return { category: "blocked", reason: "attempt-in-progress" };
    case "retry":
    case "abandon-pre-execution":
      return { category: "resumable", reason: "safe-pre-execution-retry" };
    case "recovery-required":
      return { category: "non-resumable", reason: "recovery-required" };
  }
}

/**
 * Read the attempt journal without the store's `initialize()` mkdir/chmod side
 * effect. A missing journal root means "no attempt yet"; only an existing root
 * is handed to the real store.
 */
async function readAttemptsWithoutInitializing(
  stateDirectory: string,
  originalRunId: string,
  processes: KnowledgeContinuationProcessInspector,
): Promise<readonly KnowledgeContinuationAttemptV1[]> {
  const root = knowledgeContinuationAttemptsDirectory(stateDirectory);
  let rootStat: Awaited<ReturnType<typeof lstat>> | undefined;
  try {
    rootStat = await lstat(root);
  } catch (error) {
    if (isEnoent(error)) return [];
    throw error;
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("The knowledge-continuation attempt journal root directory is unsafe.");
  }
  return new KnowledgeContinuationAttemptStore(root, processes).read(originalRunId);
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function readStringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : undefined;
}
function humanDecisionResumability(
  value: unknown,
  options?: WorkflowOutcomeDecodeOptionsV1,
): RunResumabilityProjectionV1 {
  const blocked: RunResumabilityProjectionV1 = {
    category: "blocked",
    reason: "needs-human-decision",
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) return blocked;
  try {
    const state = workflowOutcomeState(value as RunRecord, options);
    if (state.state !== "current") return blocked;
    if (state.outcome.disposition !== "blocked" && state.outcome.disposition !== "needs-input") {
      return blocked;
    }
    const decisions = state.outcome.openDecisions.filter(
      (decision) => decision.kind === "human-decision",
    );
    return decisions.length > 0
      ? { category: "resumable", reason: "needs-human-decision" }
      : blocked;
  } catch {
    return blocked;
  }
}

function hasKnowledgeContinuationReceipt(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return (value as Record<string, unknown>).knowledgeContinuationReceipt !== undefined;
}

const INVALID_MODEL_OUTPUT_CODES = new Set([
  "invalid-json",
  "invalid-envelope",
  "invalid-summary",
  "invalid-shape",
  "invalid-mode",
  "empty-pages",
  "invalid-path",
  "duplicate-page",
  "invalid-disposition",
  "missing-source-binding",
  "duplicate-source-binding",
  "invalid-source",
  "digest-mismatch",
  "unknown",
]);

/**
 * Editorial InputAsk stop: `workflowOutcome` `needs-input` with named
 * `inputId`s after a create/update job. Knowledge-continuation receipts, failed
 * inference, and invalid-model-output stay on their existing doors. Only an
 * `inputId` with an InputAsk presentation is a fillable slot; a planner
 * governed-input stop is for a retry with an amended instruction, not
 * `do --continue`.
 */
export function isEditorialInputAskRecord(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.status !== "needs-input") return false;
  if (record.workflow !== "create-documentation" && record.workflow !== "update-documentation") {
    return false;
  }
  if (hasFailedInference(record) || hasInvalidModelOutput(record)) return false;
  const outcome = record.workflowOutcome;
  if (!outcome || typeof outcome !== "object" || Array.isArray(outcome)) return false;
  const body = outcome as Record<string, unknown>;
  if (body.disposition !== "needs-input" || !Array.isArray(body.findings)) return false;
  return body.findings.some((finding) => {
    if (!finding || typeof finding !== "object" || Array.isArray(finding)) return false;
    const item = finding as Record<string, unknown>;
    return (
      item.kind === "missing-governed-input" &&
      typeof item.inputId === "string" &&
      editorialInputAskPresentationV1(item.inputId) !== undefined
    );
  });
}

/** An admitted planner governed-input stop, including historical records without an outcome. */
export function isPlannerGovernedInputRecord(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.workflow !== "create-documentation" && record.workflow !== "update-documentation")
    return false;
  if (record.status !== "failed" && record.status !== "needs-input") return false;
  if (
    hasFailedInference(record) ||
    hasInvalidModelOutput(record) ||
    isEditorialInputAskRecord(record)
  )
    return false;
  const diagnostic = admitPlannerDiagnostic(record as unknown as RunRecord);
  if (!diagnostic || !isPlannerMissingGovernedInputCode(diagnostic.code)) return false;
  try {
    const outcome = workflowOutcomeState(record as unknown as RunRecord);
    return outcome.state !== "current" || outcome.outcome.disposition === "needs-input";
  } catch {
    return false;
  }
}

function hasInvalidModelOutput(record: Record<string, unknown>): boolean {
  if (!Array.isArray(record.steps)) return false;
  return record.steps.some((step) => {
    if (!step || typeof step !== "object" || Array.isArray(step)) return false;
    const diagnostic = (step as Record<string, unknown>).planDiagnostic;
    if (!diagnostic || typeof diagnostic !== "object" || Array.isArray(diagnostic)) return false;
    const code = (diagnostic as Record<string, unknown>).code;
    return typeof code === "string" && INVALID_MODEL_OUTPUT_CODES.has(code);
  });
}

function hasFailedInference(record: Record<string, unknown>): boolean {
  if (!Array.isArray(record.steps)) return false;
  return record.steps.some((step) => {
    if (!step || typeof step !== "object" || Array.isArray(step)) return false;
    const inference = (step as Record<string, unknown>).inference;
    if (!inference || typeof inference !== "object" || Array.isArray(inference)) return false;
    const attempts = (inference as Record<string, unknown>).attempts;
    if (!Array.isArray(attempts) || attempts.length === 0) return false;
    const terminal = attempts.at(-1);
    if (!terminal || typeof terminal !== "object" || Array.isArray(terminal)) return false;
    const outcome = (terminal as Record<string, unknown>).outcome;
    return typeof outcome === "string" && outcome !== "succeeded";
  });
}

export interface RunContinuationRenderedCommand {
  readonly command: string;
  readonly reason: string;
}

export type RunContinuationSelectionOutcome =
  | { readonly disposition: "ready"; readonly rendered: RunContinuationRenderedCommand }
  | { readonly disposition: "missing-input"; readonly reason: string }
  | { readonly disposition: "unverifiable"; readonly reason: string };

export interface RunContinuationSelectionInput {
  readonly record: unknown;
  /** Required so this function is the one place that gates a command on "resumable". */
  readonly resumability: RunResumabilityProjectionV1;
  readonly stateDirectory: string;
  readonly stateDirectoryExplicit: boolean;
  readonly canonSnapshotPath?: string;
  readonly acceptCandidateSnapshot: boolean;
  readonly authorityId?: string;
}

export async function projectRunContinuationCommand(
  input: RunContinuationSelectionInput,
): Promise<RunContinuationSelectionOutcome> {
  // Checked before selector completeness: blocked, terminal, and unknown-owner
  // runs produce no resume command, whatever selection the caller supplied.
  if (input.resumability.reason === "needs-human-decision") {
    return {
      disposition: "unverifiable",
      reason:
        "Unverifiable: a needs-human-decision stop is not a knowledge continuation. --resume-from is refused; supply the named human decision.",
    };
  }
  if (input.resumability.category !== "resumable") {
    return {
      disposition: "unverifiable",
      reason: `Unverifiable: this run is ${input.resumability.category} (${input.resumability.reason}); no continuation command is available.`,
    };
  }
  if (!input.canonSnapshotPath || !input.acceptCandidateSnapshot || !input.authorityId) {
    return {
      disposition: "missing-input",
      reason:
        "Missing input: supply --canon-snapshot <path>, --accept-candidate-snapshot, and --authority-id <id> to project the exact continuation command.",
    };
  }
  let stopped: KnowledgeContinuationStoppedRunV1;
  try {
    stopped = decodeKnowledgeContinuationStoppedRun(input.record);
  } catch {
    return {
      disposition: "unverifiable",
      reason: "Unverifiable: the saved continuation receipt is malformed, stale, or unsafe.",
    };
  }
  const receipt = stopped.knowledgeContinuationReceipt;
  if (!receipt) {
    return {
      disposition: "unverifiable",
      reason: "Unverifiable: the saved continuation receipt is missing.",
    };
  }
  const store = new DurableArtifactStore(
    knowledgeContinuationArtifactsDirectory(input.stateDirectory),
  );

  let privateTaskValue: unknown;
  let originValue: unknown;
  let lineageValue: unknown;
  try {
    [privateTaskValue, originValue, lineageValue] = await Promise.all([
      store.getRecord(receipt.originalTaskArtifactSha256),
      store.getRecord(receipt.originArtifactSha256),
      store.getRecord(receipt.lineageArtifactSha256),
    ]);
  } catch {
    return {
      disposition: "unverifiable",
      reason: "Unverifiable: the retained original-task evidence for this run is unavailable.",
    };
  }
  if (
    canonicalDigest(privateTaskValue) !== receipt.originalTaskArtifactSha256 ||
    canonicalDigest(originValue) !== receipt.originArtifactSha256 ||
    canonicalDigest(lineageValue) !== receipt.lineageArtifactSha256
  ) {
    return {
      disposition: "unverifiable",
      reason:
        "Unverifiable: the retained original-task or lineage evidence does not match this run receipt.",
    };
  }
  let privateTask: KnowledgeContinuationPrivateTask;
  try {
    privateTask = decodeKnowledgeContinuationPrivateTask(privateTaskValue);
  } catch {
    return {
      disposition: "unverifiable",
      reason: "Unverifiable: the retained original-task evidence for this run is malformed.",
    };
  }

  if (
    privateTask.originalRunId !== receipt.originalRunId ||
    privateTask.workflow !== receipt.workflow ||
    privateTask.instructionSha256 !== receipt.instructionSha256 ||
    privateTask.repository.identitySha256 !== receipt.repositoryIdentitySha256 ||
    privateTask.repository.revision !== receipt.repositoryRevision ||
    privateTask.taskLineage.projectionSha256 !== receipt.taskLineageProjectionSha256 ||
    (receipt.targetConflictReceipt === null) !== (privateTask.targetConflictReceipt === null) ||
    (receipt.targetConflictReceipt !== null &&
      canonicalDigest(receipt.targetConflictReceipt) !==
        canonicalDigest(privateTask.targetConflictReceipt))
  ) {
    return {
      disposition: "unverifiable",
      reason:
        "Unverifiable: the retained original-task evidence does not bind to this run receipt.",
    };
  }

  let suppliedText: string;
  try {
    suppliedText = await readFile(resolve(input.canonSnapshotPath), "utf8");
  } catch {
    return {
      disposition: "unverifiable",
      reason: "Unverifiable: the supplied --canon-snapshot path could not be read.",
    };
  }
  let supplied: KnowledgeAcceptedSnapshotV1;
  try {
    supplied = decodeKnowledgeAcceptedSnapshot(JSON.parse(suppliedText) as unknown);
  } catch {
    return {
      disposition: "unverifiable",
      reason:
        "Unverifiable: the supplied --canon-snapshot is not a valid accepted knowledge snapshot.",
    };
  }

  const inspection = inspectRequestedPageSupport(
    supplied,
    privateTask.instruction,
    continuationRequestedPageIntent(privateTask),
  );
  if (inspection.disposition !== "continue") {
    return {
      disposition: "missing-input",
      reason:
        "Missing input: the supplied knowledge snapshot does not yet resolve this stop. Capture an accepted answer that resolves the retained conflicts or claims, then supply it with --canon-snapshot.",
    };
  }
  if (
    !matchesKnowledgeContinuationTargetConflictScope(
      privateTask.targetConflictReceipt,
      inspection.receipt,
      supplied.snapshotSha256,
    )
  ) {
    return {
      disposition: "unverifiable",
      reason:
        "Unverifiable: the supplied knowledge snapshot does not match this run retained target-conflict scope.",
    };
  }

  const resolvedSnapshotPath = resolve(input.canonSnapshotPath);
  // The resume binds the same preset and command-line settings as the stop.
  const settings = commandLineSettings(stopped.modelSettings?.writing, { exactEndpoint: true });
  const argv = [
    privateTask.workflow,
    "--repo",
    stopped.repository.sourcePath,
    ...(settings.compositionId ? ["--composition", settings.compositionId] : []),
    ...settings.sets.flatMap((pair) => ["--set", pair]),
    "--resume-from",
    stopped.id,
    "--canon-snapshot",
    resolvedSnapshotPath,
    "--accept-candidate-snapshot",
    "--authority-id",
    input.authorityId,
    "--allow-write",
    ...(privateTask.delivery.mode === "draft-mr"
      ? ["--draft-mr", "--remote", privateTask.delivery.remoteName ?? "origin"]
      : ["--patch-only"]),
  ];

  let parsed: ReturnType<typeof parseRunArguments>;
  let parsedSettings: ReturnType<typeof parseSetOptions>;
  try {
    parsedSettings = parseSetOptions(argv);
    parsed = parseRunArguments(withoutSetOptions(argv));
  } catch (error) {
    return {
      disposition: "unverifiable",
      reason: `Unverifiable: the projected command failed real command-parser validation (${error instanceof Error ? error.message : "unknown parser error"}).`,
    };
  }
  if (
    parsed.workflow !== privateTask.workflow ||
    parsed.resumeFrom !== stopped.id ||
    parsed.canonSnapshotPath !== resolvedSnapshotPath ||
    parsed.acceptCandidateSnapshot !== true ||
    parsed.canonSnapshotAuthorityId !== input.authorityId ||
    parsed.allowWrite !== true ||
    parsed.draftMr !== (privateTask.delivery.mode === "draft-mr") ||
    parsed.compositionId !== settings.compositionId ||
    Object.keys(parsedSettings.writing).length !== settings.sets.length
  ) {
    return {
      disposition: "unverifiable",
      reason:
        "Unverifiable: the projected command did not round-trip through the real command parser unchanged.",
    };
  }

  return {
    disposition: "ready",
    rendered: {
      command: renderContinuationCommand(
        argv,
        input.stateDirectoryExplicit ? input.stateDirectory : undefined,
      ),
      reason:
        "Resume the retained job with the accepted knowledge snapshot; no other input is required.",
    },
  };
}

function renderContinuationCommand(
  argv: readonly string[],
  stateDirectory: string | undefined,
): string {
  const body = ["docsfab", "run", ...argv].map(shellArgument).join(" ");
  return stateDirectory
    ? `env DOCSFAB_STATE_DIR=${shellArgument(resolve(stateDirectory))} ${body}`
    : body;
}

const SAFE_SHELL_TOKEN = /^[A-Za-z0-9_.\-/:@]+$/u;

function shellArgument(value: string): string {
  if (SAFE_SHELL_TOKEN.test(value)) return value;
  const quote = String.fromCharCode(39);
  const escaped = value.split(quote).join(`${quote}\\${quote}${quote}`);
  return `${quote}${escaped}${quote}`;
}
