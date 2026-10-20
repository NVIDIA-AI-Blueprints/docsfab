// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { createContractKit, deepFreeze } from "../contract-kit/index.js";
import { assertTaskLineageProjection, type TaskLineageProjectionV1 } from "../lineage/contracts.js";
import type { RunRecord } from "./contracts.js";
import { isRecordableEvidenceWarning } from "./evidence-warnings.js";
import { decodeRunModelSettings } from "./run-model-settings.js";
import {
  decodeKnowledgeResumeReceipt,
  type KnowledgeResumeReceiptV1,
} from "../canon/from-knowledge-snapshot.js";
import {
  decodeRunRecordRequestIntent,
  type RunRecordRequestIntentV1,
} from "../request-intent/interpret-record.js";
import { declaredRequestIntentOperation } from "../request-intent/interpret.js";
import { RequestIntentContractError } from "../request-intent/kit.js";

export const KNOWLEDGE_CONTINUATION_RECEIPT_KIND =
  "docsfab-knowledge-continuation-receipt" as const;
export const KNOWLEDGE_CONTINUATION_PRIVATE_TASK_KIND =
  "docsfab-knowledge-continuation-private-task" as const;
export const KNOWLEDGE_CONTINUATION_DELIVERY_INTENT_KIND =
  "docsfab-knowledge-continuation-delivery-intent" as const;
/** The private task version writers emit. Version 1 tasks, which store no targets, still decode. */
export const KNOWLEDGE_CONTINUATION_PRIVATE_TASK_SCHEMA_VERSION = 2 as const;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;

export type KnowledgeContinuationErrorCode =
  | "invalid-shape"
  | "invalid-value"
  | "digest-mismatch"
  | "migration-required"
  | "binding-mismatch"
  | "delivery-recovery-required"
  | "artifact-missing";

export class KnowledgeContinuationError extends Error {
  public constructor(public readonly code: KnowledgeContinuationErrorCode) {
    super(`Knowledge continuation rejected: ${code}.`);
    this.name = "KnowledgeContinuationError";
  }
}

function fail(code: KnowledgeContinuationErrorCode): never {
  throw new KnowledgeContinuationError(code);
}

const kit = createContractKit({
  fail: (code) => {
    throw new KnowledgeContinuationError(code);
  },
  inertMode: "strict",
  codes: {
    invalidShape: "invalid-shape",
    invalidValue: "invalid-value",
    digestMismatch: "digest-mismatch",
    credentialMaterial: "invalid-value",
    schemaMismatch: "migration-required",
  },
});

export interface KnowledgeContinuationReceiptV1 {
  schemaVersion: 1;
  kind: typeof KNOWLEDGE_CONTINUATION_RECEIPT_KIND;
  originalRunId: string;
  repositoryIdentitySha256: string;
  repositoryRevision: string;
  workflow: "create-documentation" | "update-documentation";
  instructionSha256: string;
  candidateSnapshotSha256: string;
  candidateArtifactSha256: string;
  candidateBytesSha256: string;
  originalTaskArtifactSha256: string;
  originalTaskBindingArtifactSha256: string;
  originalTaskBindingBytesSha256: string;
  originArtifactSha256: string;
  lineageArtifactSha256: string;
  taskLineageProjectionSha256: string;
  targetConflictReceipt: KnowledgeResumeReceiptV1 | null;
  targetConflictReceiptSha256: string | null;
  receiptSha256: string;
}

export interface KnowledgeContinuationRetainedBytesV1 {
  schemaVersion: 1;
  kind: "docsfab-knowledge-continuation-retained-bytes";
  purpose: "candidate-snapshot" | "original-task-binding";
  encoding: "utf8";
  bytesSha256: string;
  text: string;
}

export function createKnowledgeContinuationRetainedBytes(
  purpose: KnowledgeContinuationRetainedBytesV1["purpose"],
  text: string,
): KnowledgeContinuationRetainedBytesV1 {
  return decodeKnowledgeContinuationRetainedBytes({
    schemaVersion: 1,
    kind: "docsfab-knowledge-continuation-retained-bytes",
    purpose,
    encoding: "utf8",
    bytesSha256: createHash("sha256").update(text, "utf8").digest("hex"),
    text,
  });
}

export function decodeKnowledgeContinuationRetainedBytes(
  value: unknown,
): KnowledgeContinuationRetainedBytesV1 {
  kit.assertInert(value);
  const record = kit.object(value);
  kit.exact(record, ["schemaVersion", "kind", "purpose", "encoding", "bytesSha256", "text"]);
  if (
    record.schemaVersion !== 1 ||
    record.kind !== "docsfab-knowledge-continuation-retained-bytes" ||
    (record.purpose !== "candidate-snapshot" && record.purpose !== "original-task-binding") ||
    record.encoding !== "utf8"
  )
    fail("invalid-value");
  const text = kit.string(record.text);
  const bytesSha256 = kit.hash(record.bytesSha256);
  if (bytesSha256 !== createHash("sha256").update(text, "utf8").digest("hex"))
    fail("digest-mismatch");
  return deepFreeze(structuredClone(record)) as unknown as KnowledgeContinuationRetainedBytesV1;
}

interface KnowledgeContinuationPrivateTaskBody {
  kind: typeof KNOWLEDGE_CONTINUATION_PRIVATE_TASK_KIND;
  originalRunId: string;
  workflow: "create-documentation" | "update-documentation";
  instruction: string;
  instructionSha256: string;
  repository: {
    identitySha256: string;
    revision: string;
    sourcePath: string;
    requestedRevision: string;
  };
  delivery: KnowledgeContinuationDeliveryIntentV1;
  targetConflictReceipt: KnowledgeResumeReceiptV1 | null;
  taskLineage: TaskLineageProjectionV1;
}

export interface KnowledgeContinuationPrivateTaskV1 extends KnowledgeContinuationPrivateTaskBody {
  schemaVersion: 1;
}

/**
 * Where a continuation's pages come from: the stopped run's admitted reading,
 * kept whole so every reader re-verifies it against the instruction.
 */
export interface KnowledgeContinuationTargetsV1 {
  source: "admitted-intent";
  requestIntent: RunRecordRequestIntentV1;
}

export interface KnowledgeContinuationPrivateTaskV2 extends KnowledgeContinuationPrivateTaskBody {
  schemaVersion: typeof KNOWLEDGE_CONTINUATION_PRIVATE_TASK_SCHEMA_VERSION;
  /** `null` when the stopped run had no admitted reading. */
  continuationTargets: KnowledgeContinuationTargetsV1 | null;
}

export type KnowledgeContinuationPrivateTask =
  | KnowledgeContinuationPrivateTaskV1
  | KnowledgeContinuationPrivateTaskV2;

export interface KnowledgeContinuationDeliveryIntentV1 {
  schemaVersion: 1;
  kind: typeof KNOWLEDGE_CONTINUATION_DELIVERY_INTENT_KIND;
  mode: "patch-only" | "draft-mr";
  remoteName: string | null;
  targetBranch: string | null;
  targetRevision: string | null;
  intentSha256: string;
}

export function createKnowledgeContinuationDeliveryIntent(input: {
  mode: KnowledgeContinuationDeliveryIntentV1["mode"];
  remoteName: string | null;
  targetBranch: string | null;
  targetRevision: string | null;
}): KnowledgeContinuationDeliveryIntentV1 {
  const body = {
    schemaVersion: 1 as const,
    kind: KNOWLEDGE_CONTINUATION_DELIVERY_INTENT_KIND,
    mode: input.mode,
    remoteName: input.remoteName,
    targetBranch: input.targetBranch,
    targetRevision: input.targetRevision,
  };
  return decodeKnowledgeContinuationDeliveryIntent({
    ...body,
    intentSha256: kit.canonicalDigest(body),
  });
}

export function decodeKnowledgeContinuationDeliveryIntent(
  value: unknown,
): KnowledgeContinuationDeliveryIntentV1 {
  kit.assertInert(value);
  const record = kit.object(value);
  kit.exact(record, [
    "schemaVersion",
    "kind",
    "mode",
    "remoteName",
    "targetBranch",
    "targetRevision",
    "intentSha256",
  ]);
  if (
    record.schemaVersion !== 1 ||
    record.kind !== KNOWLEDGE_CONTINUATION_DELIVERY_INTENT_KIND ||
    (record.mode !== "patch-only" && record.mode !== "draft-mr")
  )
    fail("invalid-value");
  if (record.remoteName !== null) safeText(record.remoteName);
  if (record.targetBranch !== null) safeText(record.targetBranch);
  if (record.targetRevision !== null) kit.revision(record.targetRevision);
  if (
    (record.mode === "draft-mr" &&
      (record.remoteName === null ||
        record.targetBranch === null ||
        record.targetRevision === null)) ||
    (record.mode === "patch-only" &&
      (record.remoteName !== null ||
        record.targetBranch !== null ||
        record.targetRevision !== null))
  )
    fail("binding-mismatch");
  const intentSha256 = kit.hash(record.intentSha256);
  const { intentSha256: _digest, ...body } = record;
  if (intentSha256 !== kit.canonicalDigest(body)) fail("digest-mismatch");
  return deepFreeze(structuredClone(record)) as unknown as KnowledgeContinuationDeliveryIntentV1;
}

export type KnowledgeContinuationStoppedRunV1 = Pick<
  RunRecord,
  | "schemaVersion"
  | "id"
  | "workflow"
  | "repository"
  | "workspace"
  | "taskLineage"
  | "knowledgeContinuationReceipt"
  | "status"
  | "error"
  | "evidenceWarnings"
  | "modelSettings"
  | "createdAt"
  | "completedAt"
  | "models"
  | "skills"
  | "usage"
  | "tools"
  | "steps"
>;

type ReceiptBody = Omit<KnowledgeContinuationReceiptV1, "receiptSha256">;

export function createKnowledgeContinuationReceipt(
  body: ReceiptBody,
): KnowledgeContinuationReceiptV1 {
  const normalized = decodeReceiptBody(body);
  return deepFreeze({ ...normalized, receiptSha256: kit.canonicalDigest(normalized) });
}

export function decodeKnowledgeContinuationReceipt(value: unknown): KnowledgeContinuationReceiptV1 {
  kit.assertInert(value);
  const record = kit.object(value);
  kit.exact(record, [
    "schemaVersion",
    "kind",
    "originalRunId",
    "repositoryIdentitySha256",
    "repositoryRevision",
    "workflow",
    "instructionSha256",
    "candidateSnapshotSha256",
    "candidateArtifactSha256",
    "candidateBytesSha256",
    "originalTaskArtifactSha256",
    "originalTaskBindingArtifactSha256",
    "originalTaskBindingBytesSha256",
    "originArtifactSha256",
    "lineageArtifactSha256",
    "taskLineageProjectionSha256",
    "targetConflictReceipt",
    "targetConflictReceiptSha256",
    "receiptSha256",
  ]);
  const { receiptSha256, ...body } = record;
  const normalized = decodeReceiptBody(body);
  kit.hash(receiptSha256);
  if (receiptSha256 !== kit.canonicalDigest(normalized)) fail("digest-mismatch");
  return deepFreeze({ ...normalized, receiptSha256 }) as KnowledgeContinuationReceiptV1;
}

/** Compare retained conflict scope while allowing a newly accepted snapshot digest. */
export function matchesKnowledgeContinuationTargetConflictScope(
  retained: KnowledgeResumeReceiptV1 | null,
  current: KnowledgeResumeReceiptV1 | undefined,
  currentSnapshotSha256: string,
): boolean {
  kit.hash(currentSnapshotSha256);
  if (retained === null || current === undefined) return retained === null && current === undefined;
  const historical = decodeKnowledgeResumeReceipt(retained);
  const accepted = decodeKnowledgeResumeReceipt(current);
  return (
    accepted.snapshotSha256 === currentSnapshotSha256 &&
    historical.selectedTargetPath === accepted.selectedTargetPath &&
    kit.canonicalDigest(historical.advisoryConflicts) ===
      kit.canonicalDigest(accepted.advisoryConflicts)
  );
}

/** Seal the accepted snapshot to the original stop and fresh recovery authorization. */
export function knowledgeContinuationAcceptanceSha256(input: {
  receiptSha256: string;
  recoveryAuthorizationSha256: string;
  snapshotSha256: string;
  targetConflictReceiptSha256: string | null;
}): string {
  kit.hash(input.receiptSha256);
  kit.hash(input.recoveryAuthorizationSha256);
  kit.hash(input.snapshotSha256);
  if (input.targetConflictReceiptSha256 !== null) kit.hash(input.targetConflictReceiptSha256);
  return kit.canonicalDigest({
    kind: "docsfab-knowledge-continuation-accepted-snapshot",
    ...input,
  });
}

export function createKnowledgeContinuationPrivateTask(
  value: KnowledgeContinuationPrivateTaskV2,
): KnowledgeContinuationPrivateTaskV2 {
  return decodeKnowledgeContinuationPrivateTask(value) as KnowledgeContinuationPrivateTaskV2;
}

const PRIVATE_TASK_V1_KEYS = [
  "schemaVersion",
  "kind",
  "originalRunId",
  "workflow",
  "instruction",
  "instructionSha256",
  "repository",
  "delivery",
  "targetConflictReceipt",
  "taskLineage",
] as const;

/** Decodes either version as stored, so the artifact digest still matches its receipt. */
export function decodeKnowledgeContinuationPrivateTask(
  value: unknown,
): KnowledgeContinuationPrivateTask {
  kit.assertInert(value);
  const record = kit.object(value);
  const current = record.schemaVersion === KNOWLEDGE_CONTINUATION_PRIVATE_TASK_SCHEMA_VERSION;
  kit.exact(
    record,
    current ? [...PRIVATE_TASK_V1_KEYS, "continuationTargets"] : [...PRIVATE_TASK_V1_KEYS],
  );
  if (
    (record.schemaVersion !== 1 && !current) ||
    record.kind !== KNOWLEDGE_CONTINUATION_PRIVATE_TASK_KIND
  )
    fail("invalid-value");
  identifier(record.originalRunId);
  workflow(record.workflow);
  if (
    typeof record.instruction !== "string" ||
    record.instruction.length === 0 ||
    record.instruction.length > 1_000_000 ||
    record.instruction.includes("\0")
  )
    fail("invalid-value");
  kit.hash(record.instructionSha256);
  if (
    record.instructionSha256 !==
    createHash("sha256").update(record.instruction.normalize("NFC"), "utf8").digest("hex")
  )
    fail("digest-mismatch");
  if (current && record.continuationTargets !== null)
    verifyContinuationTargets(record.continuationTargets, record.instruction, record.workflow);
  const repository = kit.object(record.repository);
  kit.exact(repository, ["identitySha256", "revision", "sourcePath", "requestedRevision"]);
  kit.hash(repository.identitySha256);
  kit.revision(repository.revision);
  safeText(repository.sourcePath);
  safeText(repository.requestedRevision);
  decodeKnowledgeContinuationDeliveryIntent(record.delivery);
  const targetConflictReceipt =
    record.targetConflictReceipt === null
      ? null
      : decodeKnowledgeResumeReceipt(record.targetConflictReceipt);
  const taskLineage = assertTaskLineageProjection(record.taskLineage);
  if (
    taskLineage.repositoryIdentitySha256 !== repository.identitySha256 ||
    taskLineage.repositoryRevision !== repository.revision ||
    taskLineage.selectedWorkflow !== record.workflow
  )
    fail("binding-mismatch");
  if (targetConflictReceipt !== null && targetConflictReceipt.snapshotSha256.length !== 64)
    fail("binding-mismatch");
  return deepFreeze(structuredClone(record)) as unknown as KnowledgeContinuationPrivateTask;
}

/**
 * A stored reading binds pages only if it still verifies against the task's
 * own instruction and is an admission for the task's declared operation: a
 * reading sealed for other words is `digest-mismatch`, and an advisory, a
 * question, or another operation's reading is `binding-mismatch`.
 */
function verifyContinuationTargets(
  value: unknown,
  instruction: string,
  workflow: "create-documentation" | "update-documentation",
): void {
  const targets = kit.object(value);
  kit.exact(targets, ["source", "requestIntent"]);
  if (targets.source !== "admitted-intent") fail("invalid-value");
  let recorded: RunRecordRequestIntentV1;
  try {
    recorded = decodeRunRecordRequestIntent(targets.requestIntent, instruction);
  } catch (error) {
    if (!(error instanceof RequestIntentContractError)) throw error;
    fail(
      error.code === "sealed-digest-mismatch" ||
        error.code === "sealed-instruction-mismatch" ||
        error.code === "sealed-quote-mismatch"
        ? "digest-mismatch"
        : "invalid-value",
    );
  }
  if (
    recorded.admission.outcome !== "admitted" ||
    recorded.intent === null ||
    recorded.intent.operation !== declaredRequestIntentOperation(workflow)
  )
    fail("binding-mismatch");
}

export function decodeKnowledgeContinuationStoppedRun(
  value: unknown,
): KnowledgeContinuationStoppedRunV1 {
  kit.assertInert(value);
  const record = kit.object(value);
  kit.exact(
    record,
    [
      "schemaVersion",
      "id",
      "workflow",
      "repository",
      "workspace",
      "taskLineage",
      "knowledgeContinuationReceipt",
      "status",
      "error",
      "evidenceWarnings",
      "modelSettings",
      "createdAt",
      "completedAt",
      "models",
      "skills",
      "usage",
      "tools",
      "steps",
    ],
    ["evidenceWarnings", "modelSettings"],
  );
  if (record.schemaVersion !== 2 || record.status !== "needs-input") fail("invalid-value");
  identifier(record.id);
  workflow(record.workflow);
  const repository = kit.object(record.repository);
  kit.exact(repository, ["sourcePath", "requestedRevision", "revision"]);
  safeText(repository.sourcePath);
  safeText(repository.requestedRevision);
  kit.revision(repository.revision);
  const workspace = kit.object(record.workspace);
  kit.exact(workspace, ["strategy", "disposable"]);
  if (workspace.strategy !== "tracked-export" || workspace.disposable !== true)
    fail("invalid-value");
  const taskLineage = assertTaskLineageProjection(record.taskLineage);
  const receipt = decodeKnowledgeContinuationReceipt(record.knowledgeContinuationReceipt);
  const repositoryIdentitySha256 = createHash("sha256")
    .update(repository.sourcePath as string)
    .digest("hex");
  if (
    receipt.originalRunId !== record.id ||
    receipt.workflow !== record.workflow ||
    receipt.repositoryRevision !== repository.revision ||
    receipt.repositoryIdentitySha256 !== repositoryIdentitySha256 ||
    receipt.taskLineageProjectionSha256 !== taskLineage.projectionSha256 ||
    taskLineage.repositoryIdentitySha256 !== repositoryIdentitySha256 ||
    taskLineage.repositoryRevision !== repository.revision ||
    taskLineage.selectedWorkflow !== record.workflow
  )
    fail("binding-mismatch");
  if (typeof record.error !== "string" || record.error.length === 0) fail("invalid-value");
  if (record.evidenceWarnings !== undefined) {
    const seen = new Set<string>();
    for (const warning of kit.array(record.evidenceWarnings)) {
      safeText(warning);
      if (!isRecordableEvidenceWarning(warning) || seen.has(warning)) fail("invalid-value");
      seen.add(warning);
    }
  }
  // The settings the stopped pass bound; its resume command repeats them.
  if (record.modelSettings !== undefined) {
    try {
      decodeRunModelSettings(record.modelSettings);
    } catch {
      fail("invalid-value");
    }
  }
  const createdAt = kit.timestamp(record.createdAt);
  const completedAt = kit.timestamp(record.completedAt);
  if (Date.parse(createdAt) > Date.parse(completedAt)) fail("invalid-value");
  const models = kit.array(record.models);
  const skills = kit.array(record.skills);
  const steps = kit.array(record.steps);
  if (models.length !== 0 || skills.length !== 0 || steps.length !== 0) fail("invalid-value");
  const usage = kit.object(record.usage);
  kit.exact(usage, ["input", "output", "cacheRead", "cacheWrite", "total", "turns"]);
  if (Object.values(usage).some((entry) => entry !== 0)) fail("invalid-value");
  const tools = kit.object(record.tools);
  kit.exact(tools, ["totalCalls", "failedCalls", "byTool"]);
  if (
    tools.totalCalls !== 0 ||
    tools.failedCalls !== 0 ||
    !Array.isArray(tools.byTool) ||
    tools.byTool.length !== 0
  )
    fail("invalid-value");
  return deepFreeze(structuredClone(record)) as unknown as KnowledgeContinuationStoppedRunV1;
}

function decodeReceiptBody(value: unknown): ReceiptBody {
  const record = kit.object(value);
  kit.exact(record, [
    "schemaVersion",
    "kind",
    "originalRunId",
    "repositoryIdentitySha256",
    "repositoryRevision",
    "workflow",
    "instructionSha256",
    "candidateSnapshotSha256",
    "candidateArtifactSha256",
    "candidateBytesSha256",
    "originalTaskArtifactSha256",
    "originalTaskBindingArtifactSha256",
    "originalTaskBindingBytesSha256",
    "originArtifactSha256",
    "lineageArtifactSha256",
    "taskLineageProjectionSha256",
    "targetConflictReceipt",
    "targetConflictReceiptSha256",
  ]);
  if (record.schemaVersion !== 1 || record.kind !== KNOWLEDGE_CONTINUATION_RECEIPT_KIND)
    fail("invalid-value");
  identifier(record.originalRunId);
  kit.hash(record.repositoryIdentitySha256);
  kit.revision(record.repositoryRevision);
  workflow(record.workflow);
  kit.hash(record.instructionSha256);
  kit.hash(record.candidateSnapshotSha256);
  kit.hash(record.candidateArtifactSha256);
  kit.hash(record.candidateBytesSha256);
  kit.hash(record.originalTaskArtifactSha256);
  kit.hash(record.originalTaskBindingArtifactSha256);
  kit.hash(record.originalTaskBindingBytesSha256);
  kit.hash(record.originArtifactSha256);
  kit.hash(record.lineageArtifactSha256);
  kit.hash(record.taskLineageProjectionSha256);
  const targetConflictReceipt =
    record.targetConflictReceipt === null
      ? null
      : decodeKnowledgeResumeReceipt(record.targetConflictReceipt);
  if (record.targetConflictReceiptSha256 !== null) kit.hash(record.targetConflictReceiptSha256);
  if (
    (targetConflictReceipt === null) !== (record.targetConflictReceiptSha256 === null) ||
    (targetConflictReceipt !== null &&
      (targetConflictReceipt.snapshotSha256 !== record.candidateSnapshotSha256 ||
        kit.canonicalDigest(targetConflictReceipt) !== record.targetConflictReceiptSha256))
  )
    fail("binding-mismatch");
  return structuredClone({ ...record, targetConflictReceipt }) as unknown as ReceiptBody;
}

function identifier(value: unknown): asserts value is string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) fail("invalid-value");
}
function workflow(
  value: unknown,
): asserts value is "create-documentation" | "update-documentation" {
  if (value !== "create-documentation" && value !== "update-documentation") fail("invalid-value");
}
function safeText(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0"))
    fail("invalid-value");
}
