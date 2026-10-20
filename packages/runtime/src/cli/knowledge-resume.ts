// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Resume the original documentation Task from a knowledge snapshot.
 * Does not invent intent, switch jobs, or copy knowledge procedures.
 */

import { createHash } from "node:crypto";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  decodeKnowledgeAcceptedSnapshot,
  decodeKnowledgeResumeReceipt,
  KNOWLEDGE_RESUME_RECEIPT_KIND,
  KnowledgeSnapshotImportError,
  type KnowledgeResumeReceiptV1,
  type KnowledgeResumeReceiptConflictV1,
  type KnowledgeAcceptedSnapshotV1,
} from "../canon/from-knowledge-snapshot.js";
import type { WorkflowName } from "../workflow-contracts/contracts.js";
import type { OriginalRequestCompletion } from "./first-pass-support.js";
import { compareText, isNodeError } from "../shared/primitives.js";
import type { RequestIntentV1 } from "../request-intent/contract.js";
import { requestIntentWriteSet } from "../request-intent/seal.js";
import {
  KNOWLEDGE_CONTINUATION_PRIVATE_TASK_SCHEMA_VERSION,
  KnowledgeContinuationError,
  type KnowledgeContinuationPrivateTask,
} from "../records/knowledge-continuation.js";

export const ORIGINAL_TASK_PATH = ".docsfab/reference-model/original-task.json";
export const ORIGINAL_TASK_KIND = "docsfab-original-task" as const;

const UNRESOLVED_CLAIM_STATES = new Set(["disputed", "unresolved"]);
const DOCUMENTATION_RESUME_WORKFLOWS = new Set<WorkflowName>([
  "create-documentation",
  "update-documentation",
]);

export type KnowledgeResumeDisposition = "continue" | "needs-input";
export type KnowledgeResumeStopReason =
  | "conflict"
  | "unresolved-claim"
  | "intent-mismatch"
  | "insufficient-evidence"
  | "needs-authorization";

const INTENT_BEARING_PAGE =
  /\b(about|purpose|vision|mission|audience|rationale|product\s+intent)\b/iu;
const MARKDOWN_TARGET_TOKEN = /(?<![A-Za-z0-9_.-])(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.mdx?/u;
// Positional anchor for the legacy output count only: paths before it are
// read dependencies or exclusions. It never decides whether a request writes.
const ORDINARY_OPERATION = /\b(?:create|update|refresh|revise|write)\b/iu;
const ASSESSMENT_PREFIX = /^\s*(?:assess|review|check)\b/iu;
const FIRST_PASS_SOURCE_QUOTATION_CLAIM = /^repository source\s+.+\s+states:/iu;
const REPOSITORY_SOURCE_LOCATOR = /^(?:readme|document):/u;
const BOUNDED_BEHAVIOR_REQUEST_PREFIX = "Write `docs/";
const BOUNDED_BEHAVIOR_REQUEST_SUFFIX = "` using only these repository-observed behavior claims:";
const BOUNDED_BEHAVIOR_PATH_SEGMENT = /^[A-Za-z0-9_-]+$/u;
const BOUNDED_BEHAVIOR_FILE = /^[A-Za-z0-9_-]+\.mdx?$/u;

export class KnowledgeResumeError extends Error {
  public constructor(
    public readonly code: KnowledgeResumeStopReason,
    message: string,
    public readonly receipt?: KnowledgeResumeReceiptV1,
  ) {
    super(message);
    this.name = "KnowledgeResumeError";
  }
}

function failResume(code: KnowledgeResumeStopReason, message: string): never {
  throw new KnowledgeResumeError(code, message);
}

export interface OriginalTaskBindingV1 {
  schemaVersion: 1;
  kind: typeof ORIGINAL_TASK_KIND;
  workflow: "create-documentation" | "update-documentation";
  instructionSha256: string;
}

export interface KnowledgeResumeInspection {
  disposition: KnowledgeResumeDisposition;
  snapshot: KnowledgeAcceptedSnapshotV1;
  stopReason?: KnowledgeResumeStopReason;
  receipt?: KnowledgeResumeReceiptV1;
}

interface BoundedBehaviorRequest {
  targetPath: string;
  statements: string[];
}

export function isDocumentationResumeWorkflow(
  workflow: WorkflowName,
): workflow is "create-documentation" | "update-documentation" {
  return DOCUMENTATION_RESUME_WORKFLOWS.has(workflow);
}

export function inspectKnowledgeSnapshotResume(
  snapshot: KnowledgeAcceptedSnapshotV1,
  selectedTargetPath?: string,
): KnowledgeResumeInspection {
  const advisoryConflicts: KnowledgeResumeReceiptConflictV1[] = [];
  const advisoryClaimIds = new Set<string>();
  for (const conflict of snapshot.conflicts) {
    if (
      selectedTargetPath === undefined ||
      conflict.classification === undefined ||
      conflict.classification.blockingDocumentationPaths.includes(selectedTargetPath)
    ) {
      return { disposition: "needs-input", snapshot, stopReason: "conflict" };
    }
    advisoryConflicts.push({
      conflictId: conflict.id,
      claimIds: conflict.claimIds,
      ...conflict.classification,
    });
    for (const claimId of conflict.claimIds) advisoryClaimIds.add(claimId);
  }
  if (
    snapshot.claims.some(
      (claim) => UNRESOLVED_CLAIM_STATES.has(claim.modelState) && !advisoryClaimIds.has(claim.id),
    )
  ) {
    return { disposition: "needs-input", snapshot, stopReason: "unresolved-claim" };
  }
  if (advisoryConflicts.length === 0) {
    return { disposition: "continue", snapshot };
  }
  const receipt = decodeKnowledgeResumeReceipt({
    schemaVersion: 1,
    kind: KNOWLEDGE_RESUME_RECEIPT_KIND,
    snapshotSha256: snapshot.snapshotSha256,
    selectedTargetPath,
    advisoryConflicts,
  });
  return { disposition: "continue", snapshot, receipt };
}

export function sameKnowledgeResumeReceipt(
  left: KnowledgeResumeReceiptV1 | undefined,
  right: KnowledgeResumeReceiptV1 | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return (
    JSON.stringify(decodeKnowledgeResumeReceipt(left)) ===
    JSON.stringify(decodeKnowledgeResumeReceipt(right))
  );
}

export function requireMatchingKnowledgeResumeReceipts(
  left: KnowledgeResumeReceiptV1 | undefined,
  right: KnowledgeResumeReceiptV1 | undefined,
  requireBothActiveRoutes = false,
): KnowledgeResumeReceiptV1 | undefined {
  if (requireBothActiveRoutes && (left === undefined) !== (right === undefined)) {
    throw new Error("Knowledge resume receipts disagree between active snapshot import routes.");
  }
  if (left === undefined)
    return right === undefined ? undefined : decodeKnowledgeResumeReceipt(right);
  if (right === undefined) return decodeKnowledgeResumeReceipt(left);
  if (!sameKnowledgeResumeReceipt(left, right)) {
    throw new Error("Knowledge resume receipts disagree between active snapshot import routes.");
  }
  return decodeKnowledgeResumeReceipt(left);
}

export function isFirstPassSourceQuotationClaim(statement: string): boolean {
  return FIRST_PASS_SOURCE_QUOTATION_CLAIM.test(statement.trim());
}

/** The pages an admitted request intent writes, as first pass projects them. */
export interface RequestedPageIntent {
  readonly writeTargets: readonly string[];
}

/**
 * The pages an intent asks first pass to write: role `write` only, since
 * companions are navigation the plan binds, then the shared write set (less
 * exclusions, one spelling per case-folded path), sorted as the runner
 * requires a target control to be.
 */
export function firstPassIntentWriteTargets(
  intent: Pick<RequestIntentV1, "targets" | "exclusions">,
): string[] {
  return requestIntentWriteSet({
    targets: intent.targets.filter((target) => target.role === "write"),
    exclusions: intent.exclusions,
  }).sort(compareText);
}

/**
 * The pages a continuation binds: the write targets of the admitted reading
 * its stopped run stored, which the private-task decoder has re-verified
 * against the task's instruction. `undefined` when the stopped run stored
 * none (a version 1 task, or a run with no admitted reading), so the request
 * words are read as they were for that run.
 */
export function continuationRequestedPageIntent(
  privateTask: KnowledgeContinuationPrivateTask,
): RequestedPageIntent | undefined {
  if (
    privateTask.schemaVersion !== KNOWLEDGE_CONTINUATION_PRIVATE_TASK_SCHEMA_VERSION ||
    privateTask.continuationTargets === null
  )
    return undefined;
  const intent = privateTask.continuationTargets.requestIntent.intent;
  // The decoder refuses a stored admission without a sealed intent; never
  // fall back to the words for one that reached here some other way.
  if (intent === null) throw new KnowledgeContinuationError("binding-mismatch"); // hygiene: ok -- stable typed code; the constructor supplies the operator-safe message.
  return Object.freeze({ writeTargets: Object.freeze(firstPassIntentWriteTargets(intent)) });
}

/**
 * Whether the snapshot supports the page the request asks for. With an
 * admitted `intent`, its write targets select the page and count the outputs,
 * and the request words decide neither; a bounded template's statements must
 * still be supported. Without one, the request words are read as they always
 * were.
 */
export function inspectRequestedPageSupport(
  snapshot: KnowledgeAcceptedSnapshotV1,
  instruction: string | undefined,
  intent?: RequestedPageIntent,
): KnowledgeResumeInspection {
  const text = (instruction ?? "").normalize("NFC").replace(/\r\n?/gu, "\n").trim();
  const requested = parseBoundedBehaviorRequest(text);
  // Only one admitted page can scope a conflict; several select none, so any
  // conflict blocks, as it does for a request that names no page.
  const selectedTargetPath = intent
    ? intent.writeTargets.length === 1
      ? intent.writeTargets[0]
      : undefined
    : requested?.targetPath;
  const resume = inspectKnowledgeSnapshotResume(snapshot, selectedTargetPath);
  if (resume.disposition === "needs-input") return resume;
  // An admitted reading that names no page selects none: the snapshot is
  // inspected as for a request that names no page, and no word is read.
  if (intent && intent.writeTargets.length === 0) return resume;
  if (snapshot.status !== "candidate" && resume.receipt === undefined) return resume;
  if (!intent && snapshot.status === "candidate" && INTENT_BEARING_PAGE.test(text)) {
    return { disposition: "needs-input", snapshot, stopReason: "insufficient-evidence" };
  }
  if (!intent && !requested && isPathlessOrdinaryDocumentationInstruction(text)) {
    return resume;
  }
  const repositorySourceIds = new Set(
    snapshot.sources
      .filter((source) => REPOSITORY_SOURCE_LOCATOR.test(source.locator))
      .map((source) => source.id),
  );
  const supportedStatements = new Set(
    snapshot.claims
      .filter(
        (claim) =>
          claim.kind === "behavior" &&
          !["disputed", "unresolved", "superseded"].includes(claim.modelState) &&
          !isFirstPassSourceQuotationClaim(claim.statement) &&
          claim.evidenceIds.every((evidenceId) => repositorySourceIds.has(evidenceId)),
      )
      .map((claim) => claim.statement.normalize("NFC")),
  );
  // A candidate snapshot covers a multi-page request but not a single page
  // without bounded statements; the admitted count replaces the worded one.
  const covered =
    requested !== undefined
      ? requested.statements.every((statement) => supportedStatements.has(statement))
      : (intent ? intent.writeTargets.length : legacyRequestedDocumentationPaths(text).length) > 1;
  return covered
    ? resume
    : {
        disposition: "needs-input",
        snapshot,
        stopReason: "insufficient-evidence",
        ...(resume.receipt ? { receipt: resume.receipt } : {}),
      };
}

// Only a caller that passes no admitted intent counts pages this way: a
// continuation whose stopped run stored none, a --canon-snapshot import
// without one, or a tracked snapshot on the no-intent arm. Ordinary
// first-pass support is validated against the installed knowledge parser
// instead. Without an operation word nothing
// separates outputs from named sources or exclusions, so the text counts no
// outputs.
function legacyRequestedDocumentationPaths(instruction: string): string[] {
  const token = /(?<![A-Za-z0-9_.-])((?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.mdx?)/gu;
  const matches = [...instruction.matchAll(token)].filter((match) => {
    const end = (match.index ?? 0) + match[0].length;
    const suffix = instruction.slice(end);
    return suffix === "" || /^[\s,;:!?`'"\])]/u.test(suffix) || /^\.(?:\s|$)/u.test(suffix);
  });
  const operationOffset = ORDINARY_OPERATION.exec(instruction)?.index;
  if (operationOffset === undefined) return [];
  const dependencyOffset = /\b(?:using|based on|with evidence from|consulting)\b/iu.exec(
    instruction.slice(operationOffset),
  )?.index;
  const boundary =
    dependencyOffset === undefined ? instruction.length : operationOffset + dependencyOffset;
  return [
    ...new Set(
      matches
        .filter(
          (match) =>
            (match.index ?? 0) > operationOffset && (match.index ?? instruction.length) < boundary,
        )
        .map((match) => match[1]!),
    ),
  ];
}

function parseBoundedBehaviorRequest(instruction: string): BoundedBehaviorRequest | undefined {
  const [header, ...claimLines] = instruction.split("\n");
  if (
    !header?.startsWith(BOUNDED_BEHAVIOR_REQUEST_PREFIX) ||
    !header.endsWith(BOUNDED_BEHAVIOR_REQUEST_SUFFIX) ||
    claimLines.length === 0 ||
    claimLines.some((line) => !line.startsWith("- ") || line.length === 2)
  ) {
    return undefined;
  }
  const relativePath = header.slice(
    BOUNDED_BEHAVIOR_REQUEST_PREFIX.length,
    -BOUNDED_BEHAVIOR_REQUEST_SUFFIX.length,
  );
  const pathParts = relativePath.split("/");
  const file = pathParts.pop();
  if (
    !file ||
    !BOUNDED_BEHAVIOR_FILE.test(file) ||
    pathParts.some((part) => !BOUNDED_BEHAVIOR_PATH_SEGMENT.test(part))
  ) {
    return undefined;
  }
  const statements = claimLines.map((line) => line.slice(2));
  if (statements.length === 0 || new Set(statements).size !== statements.length) return undefined;
  return { targetPath: `docs/${relativePath}`, statements };
}

function isPathlessOrdinaryDocumentationInstruction(text: string): boolean {
  if (ASSESSMENT_PREFIX.test(text) || INTENT_BEARING_PAGE.test(text)) return false;
  return !MARKDOWN_TARGET_TOKEN.test(text);
}

export function instructionSha256(instruction: string | undefined): string {
  return createHash("sha256")
    .update((instruction ?? "").normalize("NFC"), "utf8")
    .digest("hex");
}

export function decodeOriginalTaskBinding(value: unknown): OriginalTaskBindingV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    failResume("intent-mismatch", "The original Task binding is not an object.");
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1 || record.kind !== ORIGINAL_TASK_KIND) {
    failResume("intent-mismatch", "The original Task binding is not v1.");
  }
  if (record.workflow !== "create-documentation" && record.workflow !== "update-documentation") {
    failResume("intent-mismatch", "The original Task is not a documentation create or update job.");
  }
  if (
    typeof record.instructionSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(record.instructionSha256)
  ) {
    failResume("intent-mismatch", "The original Task instruction digest is invalid.");
  }
  return {
    schemaVersion: 1,
    kind: ORIGINAL_TASK_KIND,
    workflow: record.workflow,
    instructionSha256: record.instructionSha256,
  };
}

export async function readOriginalTaskBinding(
  workspacePath: string,
): Promise<OriginalTaskBindingV1 | undefined> {
  const path = await locateOriginalTaskBinding(workspacePath);
  if (path === undefined) return undefined;
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    failResume(
      "intent-mismatch",
      "The retained original Task binding cannot be read safely from the selected workspace.",
    );
  }
  try {
    return decodeOriginalTaskBinding(JSON.parse(text) as unknown);
  } catch (error) {
    if (error instanceof KnowledgeResumeError) throw error;
    failResume(
      "intent-mismatch",
      "The retained original Task binding contains malformed JSON data.",
    );
  }
}

async function locateOriginalTaskBinding(workspacePath: string): Promise<string | undefined> {
  const segments = ORIGINAL_TASK_PATH.split("/");
  let path = workspacePath;
  for (const [index, segment] of segments.entries()) {
    path = join(path, segment);
    let status;
    try {
      status = await lstat(path);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return undefined;
      failResume(
        "intent-mismatch",
        "The retained original Task binding path cannot be inspected safely.",
      );
    }
    if (status.isSymbolicLink()) {
      failResume(
        "intent-mismatch",
        "The retained original Task binding path must not contain symbolic links.",
      );
    }
    const leaf = index === segments.length - 1;
    if ((!leaf && !status.isDirectory()) || (leaf && !status.isFile())) {
      failResume(
        "intent-mismatch",
        "The retained original Task binding path has an invalid file type.",
      );
    }
  }
  return path;
}

export async function writeOriginalTaskBinding(
  workspacePath: string,
  binding: OriginalTaskBindingV1,
): Promise<void> {
  const path = join(workspacePath, ORIGINAL_TASK_PATH);
  await writeFile(path, `${JSON.stringify(binding, null, 2)}\n`);
}

export function assertResumeMatchesOriginal(input: {
  workflow: WorkflowName;
  instruction: string | undefined;
  original: OriginalTaskBindingV1;
}): void {
  if (input.workflow !== input.original.workflow) {
    failResume(
      "intent-mismatch",
      `Resume the original ${input.original.workflow} Task; do not invent a different job.`,
    );
  }
  const digest = instructionSha256(input.instruction);
  if (digest !== input.original.instructionSha256) {
    failResume(
      "intent-mismatch",
      "Resume continues the original instruction; do not invent a different intent.",
    );
  }
}

export function inspectSnapshotValue(
  value: unknown,
  instruction?: string,
  intent?: RequestedPageIntent,
): KnowledgeResumeInspection {
  try {
    return inspectRequestedPageSupport(decodeKnowledgeAcceptedSnapshot(value), instruction, intent);
  } catch (error) {
    if (error instanceof KnowledgeSnapshotImportError) {
      throw new Error(`The knowledge snapshot import was rejected: ${error.code}.`);
    }
    throw error;
  }
}

export function knowledgeResumeNeedsInputMessage(reason: KnowledgeResumeStopReason): string {
  if (reason === "conflict") {
    return "The knowledge snapshot has unresolved conflicts. Capture an attributed answer and resume the original Task; do not invent intent.";
  }
  if (reason === "unresolved-claim") {
    return "The knowledge snapshot has disputed or unresolved claims. Capture an attributed answer and resume the original Task; do not invent intent.";
  }
  if (reason === "insufficient-evidence") {
    return "The knowledge snapshot cannot support the requested page. Capture an attributed answer and resume the original Task; do not invent intent.";
  }
  if (reason === "needs-authorization") {
    return "Authorize a documentation write root such as docs/ or fern/ before DocsFab can propose a destination. Capture that authorization and resume the original Task; do not invent a path.";
  }
  return "This run does not match the original Task. Resume the original job without inventing intent.";
}

export interface DocumentationPartialAnswerIdentityV1 {
  readonly assessmentIdentitySha256: string;
  readonly repositoryRevision: string;
  readonly snapshotSha256?: string;
  readonly planBindingSha256?: string;
}

/** True when a later answer is bound to a prior snapshot, revision, or plan. */
export function documentationPartialAnswerIsStale(
  current: DocumentationPartialAnswerIdentityV1,
  bound: DocumentationPartialAnswerIdentityV1,
): boolean {
  return (
    current.assessmentIdentitySha256 !== bound.assessmentIdentitySha256 ||
    current.repositoryRevision !== bound.repositoryRevision ||
    (current.snapshotSha256 ?? null) !== (bound.snapshotSha256 ?? null) ||
    (current.planBindingSha256 ?? null) !== (bound.planBindingSha256 ?? null)
  );
}

export function originalRequestCompletionAfterPartialAnswer(
  originalUnmetRequirementIds: readonly string[],
): OriginalRequestCompletion {
  return originalUnmetRequirementIds.length === 0 ? "complete" : "incomplete";
}
