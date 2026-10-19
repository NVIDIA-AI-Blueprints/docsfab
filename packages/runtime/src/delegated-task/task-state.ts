// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Owner-private delegated-task record for pause/resume, stored through the
 * existing owner-private exact-id FileRunStore boundary. Lookup errors never
 * include a prompt, answer, source body, credential, or filesystem location.
 */
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join, resolve } from "node:path";

import { delegatedTaskStateMaxBytes } from "../contract-kit/decode-bounds.js";
import { createContractKit } from "../contract-kit/index.js";
import type { TaskLineageRepositoryBindingV1 } from "../lineage/contracts.js";
import {
  ensurePrivateRunDirectory,
  FileRunStore,
  FileRunStoreError,
  type FileRunStoreErrorCode,
} from "../records/file-store.js";
import {
  createDelegatedTaskQuestionBatch,
  DELEGATED_TASK_RESUME_ANSWERS_COMMAND,
  type DelegatedTaskCompletedReadV1,
  type DelegatedTaskQuestionBatchV1,
  type DelegatedTaskQuestionV1,
} from "./question-contract.js";
import {
  decodeDelegatedTaskRequestIdentity,
  delegatedTaskRequirementIdentitySha256,
  delegatedTaskRequirementsIdentitySha256,
  type DelegatedTaskRequestIdentityV1,
  type DelegatedTaskRequirementKind,
} from "./result-contract.js";

export const DELEGATED_TASK_STATE_KIND = "docsfab-delegated-task-state" as const;
export const DELEGATED_TASK_STATE_SCHEMA_VERSION = 2 as const;
export const DELEGATED_TASK_GENERIC_PROMPT = "You:";

const PRIVATE_FILE_MODE = 0o600;
const SAFE_RECORD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export const DELEGATED_TASK_STATE_PHASES = [
  "pending-input",
  "finished",
  "recovery-required",
] as const;
export type DelegatedTaskStatePhase = (typeof DELEGATED_TASK_STATE_PHASES)[number];

export const DELEGATED_TASK_SETTLED_OPERATION_KINDS = [
  "read",
  "edit",
  "check",
  "child-workflow",
  "publication",
] as const;
export type DelegatedTaskSettledOperationKind =
  (typeof DELEGATED_TASK_SETTLED_OPERATION_KINDS)[number];

export type DelegatedTaskStateErrorCode =
  | "invalid-shape"
  | "invalid-value"
  | "digest-mismatch"
  | "credential-material"
  | "migration-required"
  | "task-not-found"
  | "owner-mismatch"
  | "repository-mismatch"
  | "identity-mismatch"
  | "permission-changed"
  | "unsafe-store"
  | "recovery-required"
  | "bounds-exceeded";

export class DelegatedTaskStateError extends Error {
  public constructor(public readonly code: DelegatedTaskStateErrorCode) {
    super(`Delegated task state lookup was rejected for the closed code ${code}.`);
    this.name = "DelegatedTaskStateError";
  }
}

export function failDelegatedTaskState(code: DelegatedTaskStateErrorCode): never {
  throw new DelegatedTaskStateError(code);
}

const {
  assertInert,
  rejectCredentials,
  object,
  exact,
  array,
  string,
  identifier,
  hash,
  revision,
  timestamp,
  enumeration,
  compare,
  unique,
  seal,
  decodeSealed,
  canonicalDigest,
  canonicalJson,
} = createContractKit({
  fail: failDelegatedTaskState,
  inertMode: "strict",
  codes: {
    invalidShape: "invalid-shape",
    invalidValue: "invalid-value",
    digestMismatch: "digest-mismatch",
    credentialMaterial: "credential-material",
    schemaMismatch: "migration-required",
  },
});

export const delegatedTaskStateContractKit = {
  assertInert,
  rejectCredentials,
  object,
  exact,
  array,
  string,
  identifier,
  hash,
  revision,
  timestamp,
  enumeration,
  compare,
  unique,
  canonicalDigest,
  canonicalJson,
};

export interface DelegatedTaskAuthorityDescriptorV1 {
  read: boolean;
  write: boolean;
  check: boolean;
}

export interface DelegatedTaskRequirementInputV1 {
  id: string;
  kind: DelegatedTaskRequirementKind;
  originalSha256: string;
  targetLocator: string;
}

export interface DelegatedTaskSettledOperationV1 {
  operationId: string;
  kind: DelegatedTaskSettledOperationKind;
  inputIdentitySha256: string;
  receiptSha256: string;
  definitionSha256: string | null;
}

export interface DelegatedTaskRepositoryBindingV1 extends TaskLineageRepositoryBindingV1 {
  canonicalPathSha256: string;
}

export interface DelegatedTaskStateBodyV1 {
  id: string;
  taskId: string;
  ownerId: string;
  request: DelegatedTaskRequestIdentityV1;
  repository: DelegatedTaskRepositoryBindingV1;
  sourceSha256: string;
  planSha256: string;
  outcomeSha256: string;
  /** Retained outcome bytes. `outcomeSha256` is their canonical digest. */
  outcome: string;
  originalRequirements: readonly DelegatedTaskRequirementInputV1[];
  planRequirementIds: readonly string[];
  pendingQuestions: readonly DelegatedTaskQuestionV1[];
  settledQuestionIds: readonly string[];
  issuedQuestionIds: readonly string[];
  completedReads: readonly DelegatedTaskCompletedReadV1[];
  settledOperations: readonly DelegatedTaskSettledOperationV1[];
  knowledgeChildReceiptSha256: string | null;
  storedAuthorityDescriptor: DelegatedTaskAuthorityDescriptorV1;
  phase: DelegatedTaskStatePhase;
  activeTool: boolean;
  createdAt: string;
  updatedAt: string;
}

export type DelegatedTaskStateV1 = DelegatedTaskStateBodyV1 & {
  schemaVersion: typeof DELEGATED_TASK_STATE_SCHEMA_VERSION;
  kind: typeof DELEGATED_TASK_STATE_KIND;
  stateSha256: string;
};

export const DELEGATED_TASK_STATE_BODY_KEYS = [
  "id",
  "taskId",
  "ownerId",
  "request",
  "repository",
  "sourceSha256",
  "planSha256",
  "outcomeSha256",
  "outcome",
  "originalRequirements",
  "planRequirementIds",
  "pendingQuestions",
  "settledQuestionIds",
  "issuedQuestionIds",
  "completedReads",
  "settledOperations",
  "knowledgeChildReceiptSha256",
  "storedAuthorityDescriptor",
  "phase",
  "activeTool",
  "createdAt",
  "updatedAt",
] as const;

export function delegatedTaskStoreRecordId(taskId: string): string {
  return canonicalDigest({ kind: DELEGATED_TASK_STATE_KIND, taskId: identifier(taskId) });
}

export function delegatedTaskSourceIdentitySha256(
  reads: readonly DelegatedTaskCompletedReadV1[],
): string {
  return canonicalDigest({
    reads: [...reads]
      .map((read) => ({ locator: read.locator, digestSha256: read.digestSha256 }))
      .sort((left, right) => compare(left.locator, right.locator)),
  });
}

export function delegatedTaskPlanIdentitySha256(
  requirements: readonly DelegatedTaskRequirementInputV1[],
  planRequirementIds: readonly string[],
): string {
  return canonicalDigest({
    requirements: [...requirements]
      .map((requirement) => ({
        id: requirement.id,
        kind: requirement.kind,
        originalSha256: requirement.originalSha256,
        targetLocator: requirement.targetLocator,
      }))
      .sort((left, right) => compare(left.id, right.id)),
    planRequirementIds: [...planRequirementIds].sort(compare),
  });
}

export function delegatedTaskOperationIdentitySha256(input: {
  kind: DelegatedTaskSettledOperationKind;
  operationId: string;
  inputIdentitySha256: string;
}): string {
  return canonicalDigest({
    kind: input.kind,
    operationId: input.operationId,
    inputIdentitySha256: input.inputIdentitySha256,
  });
}

function booleanValue(value: unknown): boolean {
  if (typeof value !== "boolean") failDelegatedTaskState("invalid-value");
  return value;
}

function decodeAuthority(value: unknown): DelegatedTaskAuthorityDescriptorV1 {
  const root = object(value);
  exact(root, ["read", "write", "check"]);
  return {
    read: booleanValue(root.read),
    write: booleanValue(root.write),
    check: booleanValue(root.check),
  };
}

function decodeRequirement(value: unknown): DelegatedTaskRequirementInputV1 {
  const root = object(value);
  exact(root, ["id", "kind", "originalSha256", "targetLocator"]);
  const id = identifier(root.id);
  const kind = enumeration(root.kind, ["artifact", "check", "child-workflow"] as const);
  const targetLocator = identifier(root.targetLocator);
  const originalSha256 = hash(root.originalSha256);
  if (originalSha256 !== delegatedTaskRequirementIdentitySha256({ id, kind, targetLocator })) {
    failDelegatedTaskState("identity-mismatch");
  }
  return { id, kind, originalSha256, targetLocator };
}

function decodeQuestion(value: unknown): DelegatedTaskQuestionV1 {
  const root = object(value);
  exact(root, ["questionId", "clarificationKind", "prompt", "reason"]);
  return {
    questionId: identifier(root.questionId),
    clarificationKind: enumeration(root.clarificationKind, [
      "missing-outcome-or-target",
      "contradictory-product-fact",
      "unavailable-authority",
    ] as const),
    prompt: string(root.prompt),
    reason: string(root.reason),
  };
}

function decodeCompletedRead(value: unknown): DelegatedTaskCompletedReadV1 {
  const root = object(value);
  exact(root, ["locator", "digestSha256"]);
  return { locator: identifier(root.locator), digestSha256: hash(root.digestSha256) };
}

function decodeSettledOperation(value: unknown): DelegatedTaskSettledOperationV1 {
  const root = object(value);
  exact(root, ["operationId", "kind", "inputIdentitySha256", "receiptSha256", "definitionSha256"]);
  return {
    operationId: identifier(root.operationId),
    kind: enumeration(root.kind, DELEGATED_TASK_SETTLED_OPERATION_KINDS),
    inputIdentitySha256: hash(root.inputIdentitySha256),
    receiptSha256: hash(root.receiptSha256),
    definitionSha256: root.definitionSha256 === null ? null : hash(root.definitionSha256),
  };
}

function decodeRepository(value: unknown): DelegatedTaskRepositoryBindingV1 {
  const root = object(value);
  exact(root, ["identitySha256", "revision", "canonicalPathSha256"]);
  return {
    identitySha256: hash(root.identitySha256),
    revision: revision(root.revision),
    canonicalPathSha256: hash(root.canonicalPathSha256),
  };
}

function normalizeState(root: Record<string, unknown>): DelegatedTaskStateBodyV1 {
  const taskId = identifier(root.taskId);
  const id = hash(root.id);
  if (id !== delegatedTaskStoreRecordId(taskId)) failDelegatedTaskState("identity-mismatch");
  const originalRequirements = array(root.originalRequirements)
    .map(decodeRequirement)
    .sort((left, right) => compare(left.id, right.id));
  unique(originalRequirements.map((requirement) => requirement.id));
  if (originalRequirements.length === 0) failDelegatedTaskState("invalid-value");
  const planRequirementIds = array(root.planRequirementIds).map(identifier).sort(compare);
  unique(planRequirementIds);
  if (planRequirementIds.join("\0") !== originalRequirements.map((item) => item.id).join("\0")) {
    failDelegatedTaskState("identity-mismatch");
  }
  const request = decodeDelegatedTaskRequestIdentity(root.request);
  if (request.taskSha256 !== delegatedTaskRequirementsIdentitySha256(originalRequirements)) {
    failDelegatedTaskState("identity-mismatch");
  }
  const pendingQuestions = array(root.pendingQuestions)
    .map(decodeQuestion)
    .sort((left, right) => compare(left.questionId, right.questionId));
  unique(pendingQuestions.map((question) => question.questionId));
  const settledQuestionIds = array(root.settledQuestionIds).map(identifier).sort(compare);
  unique(settledQuestionIds);
  const issuedQuestionIds = array(root.issuedQuestionIds).map(identifier).sort(compare);
  unique(issuedQuestionIds);
  if (pendingQuestions.some((question) => settledQuestionIds.includes(question.questionId))) {
    failDelegatedTaskState("invalid-value");
  }
  for (const question of pendingQuestions) {
    if (!issuedQuestionIds.includes(question.questionId)) failDelegatedTaskState("invalid-value");
  }
  for (const settledId of settledQuestionIds) {
    if (!issuedQuestionIds.includes(settledId)) failDelegatedTaskState("invalid-value");
  }
  const completedReads = array(root.completedReads)
    .map(decodeCompletedRead)
    .sort((left, right) => compare(left.locator, right.locator));
  unique(completedReads.map((read) => read.locator));
  const settledOperations = array(root.settledOperations)
    .map(decodeSettledOperation)
    .sort((left, right) => compare(left.operationId, right.operationId));
  unique(
    settledOperations.map((operation) =>
      delegatedTaskOperationIdentitySha256({
        kind: operation.kind,
        operationId: operation.operationId,
        inputIdentitySha256: operation.inputIdentitySha256,
      }),
    ),
  );
  const phase = enumeration(root.phase, DELEGATED_TASK_STATE_PHASES);
  const activeTool = booleanValue(root.activeTool);
  if (activeTool && phase !== "recovery-required") failDelegatedTaskState("recovery-required");
  if (pendingQuestions.length > 0 !== (phase === "pending-input")) {
    failDelegatedTaskState("invalid-value");
  }
  const sourceSha256 = hash(root.sourceSha256);
  if (sourceSha256 !== delegatedTaskSourceIdentitySha256(completedReads)) {
    failDelegatedTaskState("identity-mismatch");
  }
  const planSha256 = hash(root.planSha256);
  if (planSha256 !== delegatedTaskPlanIdentitySha256(originalRequirements, planRequirementIds)) {
    failDelegatedTaskState("identity-mismatch");
  }
  const outcomeSha256 = hash(root.outcomeSha256);
  return {
    id,
    taskId,
    ownerId: identifier(root.ownerId),
    request,
    repository: decodeRepository(root.repository),
    sourceSha256,
    planSha256,
    outcomeSha256,
    outcome: retainedOutcome(root.outcome, outcomeSha256),
    originalRequirements: Object.freeze(originalRequirements),
    planRequirementIds: Object.freeze(planRequirementIds),
    pendingQuestions: Object.freeze(pendingQuestions),
    settledQuestionIds: Object.freeze(settledQuestionIds),
    issuedQuestionIds: Object.freeze(issuedQuestionIds),
    completedReads: Object.freeze(completedReads),
    settledOperations: Object.freeze(settledOperations),
    knowledgeChildReceiptSha256:
      root.knowledgeChildReceiptSha256 === null ? null : hash(root.knowledgeChildReceiptSha256),
    storedAuthorityDescriptor: decodeAuthority(root.storedAuthorityDescriptor),
    phase,
    activeTool,
    createdAt: timestamp(root.createdAt),
    updatedAt: timestamp(root.updatedAt),
  };
}

function retainedOutcome(value: unknown, outcomeSha256: string): string {
  const outcome = string(value);
  if (outcome.length === 0) failDelegatedTaskState("invalid-value");
  if (canonicalDigest(outcome) !== outcomeSha256) failDelegatedTaskState("identity-mismatch");
  return outcome;
}

export function delegatedTaskStateBody(state: DelegatedTaskStateV1): DelegatedTaskStateBodyV1 {
  return Object.fromEntries(
    DELEGATED_TASK_STATE_BODY_KEYS.map((key) => [key, state[key]]),
  ) as unknown as DelegatedTaskStateBodyV1;
}

export function createDelegatedTaskState(input: DelegatedTaskStateBodyV1): DelegatedTaskStateV1 {
  assertInert(input);
  rejectCredentials(input);
  const root = object(input);
  exact(root, [...DELEGATED_TASK_STATE_BODY_KEYS]);
  return seal(
    DELEGATED_TASK_STATE_KIND,
    "stateSha256",
    normalizeState(root),
    DELEGATED_TASK_STATE_SCHEMA_VERSION,
  ) as DelegatedTaskStateV1;
}

export function decodeDelegatedTaskState(value: unknown): DelegatedTaskStateV1 {
  assertInert(value);
  const root = object(value);
  if (
    root.kind === DELEGATED_TASK_STATE_KIND &&
    root.schemaVersion === 1 &&
    !Object.hasOwn(root, "outcome")
  ) {
    failDelegatedTaskState("migration-required");
  }
  return decodeSealed(
    value,
    DELEGATED_TASK_STATE_KIND,
    "stateSha256",
    [...DELEGATED_TASK_STATE_BODY_KEYS],
    normalizeState,
    DELEGATED_TASK_STATE_SCHEMA_VERSION,
  ) as DelegatedTaskStateV1;
}

function mapStoreCode(code: FileRunStoreErrorCode): DelegatedTaskStateErrorCode {
  if (code === "record-not-found" || code === "unsafe-record-id") return "task-not-found";
  if (code === "bounds-exceeded") return "bounds-exceeded";
  if (code === "owner-mismatch") return "owner-mismatch";
  if (code === "unsafe-root" || code === "unsafe-entry") return "repository-mismatch";
  return "unsafe-store";
}

function rethrowStore(error: unknown): never {
  if (error instanceof DelegatedTaskStateError) throw error;
  if (error instanceof FileRunStoreError) failDelegatedTaskState(mapStoreCode(error.code));
  failDelegatedTaskState("unsafe-store");
}

function assertSafeLookupError(error: DelegatedTaskStateError): void {
  if (error.message.includes(DELEGATED_TASK_GENERIC_PROMPT)) {
    failDelegatedTaskState("unsafe-store");
  }
}

export interface DelegatedTaskStateLookup {
  taskId: string;
  ownerId: string;
  repositoryIdentitySha256: string;
  repositoryRevision: string;
  canonicalPathSha256: string;
  requestSha256?: string;
  taskSha256?: string;
  sourceSha256?: string;
  planSha256?: string;
}

export interface DelegatedTaskStateStoreOptions {
  directory: string;
  id?: () => string;
}

/**
 * Exact task-id lookup over the owner-private FileRunStore directory. Never
 * selects the most recent task or session.
 */
export class DelegatedTaskStateStore {
  private readonly directory: string;
  private readonly id: () => string;
  private readonly records: FileRunStore;

  public constructor(options: DelegatedTaskStateStoreOptions) {
    this.directory = resolve(options.directory);
    this.id = options.id ?? randomUUID;
    this.records = new FileRunStore(this.directory);
  }

  public async getExact(taskId: string): Promise<DelegatedTaskStateV1> {
    return (await this.readExact(taskId)).state;
  }

  public async readExact(
    taskId: string,
  ): Promise<{ state: DelegatedTaskStateV1; byteSha256: string }> {
    const recordId = delegatedTaskStoreRecordId(taskId);
    try {
      const path = join(this.directory, `${recordId}.json`);
      const pinned = await lstat(path).catch((error: unknown) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
        throw error;
      });
      const maxBytes = delegatedTaskStateMaxBytes();
      if (pinned?.isFile() && pinned.size > maxBytes) {
        failDelegatedTaskState("bounds-exceeded");
      }
      const loaded = await this.records.getWithDigest(recordId, { maxBytes });
      const state = decodeDelegatedTaskState(loaded.record);
      if (state.taskId !== taskId || state.id !== recordId) {
        failDelegatedTaskState("task-not-found");
      }
      return { state, byteSha256: loaded.sha256 };
    } catch (error) {
      if (error instanceof DelegatedTaskStateError) {
        assertSafeLookupError(error);
        throw error;
      }
      rethrowStore(error);
    }
  }

  public async lookup(binding: DelegatedTaskStateLookup): Promise<DelegatedTaskStateV1> {
    return (await this.lookupWithDigest(binding)).state;
  }

  public async lookupWithDigest(
    binding: DelegatedTaskStateLookup,
  ): Promise<{ state: DelegatedTaskStateV1; byteSha256: string }> {
    const loaded = await this.readExact(binding.taskId);
    const state = loaded.state;
    try {
      if (state.ownerId !== binding.ownerId) failDelegatedTaskState("owner-mismatch");
      if (state.repository.identitySha256 !== binding.repositoryIdentitySha256) {
        failDelegatedTaskState("repository-mismatch");
      }
      if (state.repository.revision !== binding.repositoryRevision) {
        failDelegatedTaskState("identity-mismatch");
      }
      if (state.repository.canonicalPathSha256 !== binding.canonicalPathSha256) {
        failDelegatedTaskState("repository-mismatch");
      }
      if (binding.requestSha256 && state.request.requestSha256 !== binding.requestSha256) {
        failDelegatedTaskState("identity-mismatch");
      }
      if (binding.taskSha256 && state.request.taskSha256 !== binding.taskSha256) {
        failDelegatedTaskState("identity-mismatch");
      }
      if (binding.sourceSha256 && state.sourceSha256 !== binding.sourceSha256) {
        failDelegatedTaskState("identity-mismatch");
      }
      if (binding.planSha256 && state.planSha256 !== binding.planSha256) {
        failDelegatedTaskState("identity-mismatch");
      }
      return loaded;
    } catch (error) {
      if (error instanceof DelegatedTaskStateError) {
        assertSafeLookupError(error);
        throw error;
      }
      rethrowStore(error);
    }
  }

  public async save(state: DelegatedTaskStateV1, expectedByteSha256?: string): Promise<void> {
    const sealed = createDelegatedTaskState(delegatedTaskStateBody(state));
    if (!SAFE_RECORD_ID.test(sealed.id)) failDelegatedTaskState("invalid-value");
    await ensurePrivateRunDirectory(this.directory).catch(rethrowStore);
    const lockPath = join(this.directory, `.${sealed.id}.lock`);
    let lock: FileHandle | undefined;
    try {
      lock = await open(
        lockPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        PRIVATE_FILE_MODE,
      );
      await lock.chmod(PRIVATE_FILE_MODE);
    } catch (error) {
      if (error instanceof DelegatedTaskStateError) throw error;
      failDelegatedTaskState(expectedByteSha256 === undefined ? "unsafe-store" : "digest-mismatch");
    }
    try {
      if (expectedByteSha256 !== undefined) {
        let currentSha256: string;
        try {
          currentSha256 = (
            await this.records.getWithDigest(sealed.id, {
              maxBytes: delegatedTaskStateMaxBytes(),
            })
          ).sha256;
        } catch (error) {
          if (error instanceof FileRunStoreError && error.code === "record-not-found") {
            failDelegatedTaskState("digest-mismatch");
          }
          rethrowStore(error);
        }
        if (currentSha256 !== expectedByteSha256) failDelegatedTaskState("digest-mismatch");
      }
      let bytes: Buffer;
      try {
        bytes = Buffer.from(`${canonicalJson(sealed)}\n`, "utf8");
      } catch {
        failDelegatedTaskState("unsafe-store");
      }
      await this.records.replaceExactBytes(sealed.id, bytes);
    } finally {
      await lock?.close().catch(() => undefined);
      await unlink(lockPath).catch(() => undefined);
    }
  }
}

export function assertFreshAuthority(supplied: DelegatedTaskAuthorityDescriptorV1): void {
  if (typeof supplied.read !== "boolean" || typeof supplied.write !== "boolean") {
    failDelegatedTaskState("permission-changed");
  }
  if (typeof supplied.check !== "boolean") failDelegatedTaskState("permission-changed");
  if (!supplied.read) failDelegatedTaskState("permission-changed");
}

export function authorityFromHistoryCannotGrant(_history: {
  stored: DelegatedTaskAuthorityDescriptorV1;
  sessionMessage?: string;
  answerText?: string;
  priorAllowWrite?: boolean;
}): DelegatedTaskAuthorityDescriptorV1 {
  return { read: false, write: false, check: false };
}

export function questionBatchFromState(state: DelegatedTaskStateV1): DelegatedTaskQuestionBatchV1 {
  return createDelegatedTaskQuestionBatch({
    taskId: state.taskId,
    questions: state.pendingQuestions,
    completedReads: state.completedReads,
    resumeCommand: DELEGATED_TASK_RESUME_ANSWERS_COMMAND(state.taskId),
  });
}
