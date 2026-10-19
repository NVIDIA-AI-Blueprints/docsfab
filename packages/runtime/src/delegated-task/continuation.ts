// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Pause one delegated task for focused clarification and resume that exact
 * task with fresh invocation authority and no replay. Write resumes are
 * recorded blocked; active-tool crash recovery is unsupported.
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { createReceiptReplayGuard } from "../contract-kit/index.js";
import {
  decodeKnowledgeContinuationReceipt,
  type KnowledgeContinuationReceiptV1,
} from "../records/knowledge-continuation.js";
import {
  projectDelegatedTaskFulfillment,
  type DelegatedTaskCheckEvidenceV1,
  type DelegatedTaskChildEvidenceV1,
} from "./fulfillment.js";
import {
  decodeDelegatedTaskAnswers,
  DELEGATED_TASK_MISSING_TARGET_QUESTION_ID,
  DELEGATED_TASK_RESUME_ANSWERS_COMMAND,
  missingTargetQuestion,
  selectEssentialDelegatedQuestions,
  type DelegatedTaskCompletedReadV1,
  type DelegatedTaskQuestionBatchV1,
  type DelegatedTaskQuestionCandidateV1,
  type DelegatedTaskQuestionV1,
} from "./question-contract.js";
import {
  delegatedTaskRequirementIdentitySha256,
  delegatedTaskRequirementsIdentitySha256,
  type DelegatedTaskRequestIdentityV1,
  type DelegatedTaskResultV1,
} from "./result-contract.js";
import {
  assertFreshAuthority,
  authorityFromHistoryCannotGrant,
  createDelegatedTaskState,
  DELEGATED_TASK_GENERIC_PROMPT,
  delegatedTaskOperationIdentitySha256,
  delegatedTaskPlanIdentitySha256,
  delegatedTaskSourceIdentitySha256,
  delegatedTaskStateContractKit,
  delegatedTaskStoreRecordId,
  DelegatedTaskStateError,
  DelegatedTaskStateStore,
  failDelegatedTaskState,
  questionBatchFromState,
  type DelegatedTaskAuthorityDescriptorV1,
  type DelegatedTaskRequirementInputV1,
  type DelegatedTaskSettledOperationV1,
  type DelegatedTaskStateV1,
  delegatedTaskStateBody,
} from "./task-state.js";

export const DELEGATED_TASK_INPUT_MODES = [
  "interactive",
  "non-tty",
  "no-input",
  "json",
  "end-of-input",
] as const;
export type DelegatedTaskInputMode = (typeof DELEGATED_TASK_INPUT_MODES)[number];

export const DELEGATED_TASK_WRITE_RESUME_REMAINDER = Object.freeze({
  blocked: true as const,
  nextRecipe: "#877",
  cells: Object.freeze(["write-resume-after-pause", "replay-settled-write"] as const),
  reason: "Write-resume cases require the #877 authority adapter and are not shipped here.",
});

export type DelegatedTaskContinuationErrorCode =
  | "invalid-shape"
  | "invalid-value"
  | "unsupported-recovery"
  | "grant-required"
  | "operation-replayed"
  | "permission-changed"
  | "provider-work-started";

export class DelegatedTaskContinuationError extends Error {
  public constructor(public readonly code: DelegatedTaskContinuationErrorCode) {
    super(`Delegated task continuation was rejected for the closed code ${code}.`);
    this.name = "DelegatedTaskContinuationError";
  }
}

export function failDelegatedTaskContinuation(code: DelegatedTaskContinuationErrorCode): never {
  throw new DelegatedTaskContinuationError(code);
}

const replayGuard = createReceiptReplayGuard(failDelegatedTaskContinuation, "operation-replayed");

const ZERO_USAGE = Object.freeze({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 0,
  turns: 0,
});

export interface DelegatedTaskCheckDefinitionV1 {
  checkId: string;
  definitionSha256: string;
  commandDefinitionSha256: string;
  scopeSha256: string;
  effectsSha256: string;
  authoritySha256: string;
}

export interface DelegatedTaskInspectPauseInput {
  taskId: string;
  ownerId: string;
  outcome: string;
  request: DelegatedTaskRequestIdentityV1;
  repositoryPath: string;
  repositoryRevision: string;
  admittedLocators: readonly string[];
  materialTargetLocator?: string;
  originalRequirements: readonly DelegatedTaskRequirementInputV1[];
  candidateQuestions?: readonly DelegatedTaskQuestionCandidateV1[];
  inputMode: DelegatedTaskInputMode;
  currentAuthority: DelegatedTaskAuthorityDescriptorV1;
  storeDirectory: string;
  settledOperations?: readonly DelegatedTaskSettledOperationV1[];
  knowledgeChildReceipt?: KnowledgeContinuationReceiptV1;
  activeTool?: boolean;
  now?: () => Date;
}

export type DelegatedTaskInspectPauseResult =
  | {
      status: "finished";
      result: DelegatedTaskResultV1;
      completedReads: readonly DelegatedTaskCompletedReadV1[];
      genericPrompt: false;
    }
  | {
      status: "needs-input";
      result: DelegatedTaskResultV1;
      batch: DelegatedTaskQuestionBatchV1;
      state: DelegatedTaskStateV1;
      genericPrompt: false;
    }
  | { status: "recovery-required"; code: "unsupported-recovery"; genericPrompt: false };

export interface DelegatedTaskResumeExecutors {
  readonly edit?: (inputIdentitySha256: string) => Promise<string>;
  readonly check?: (input: {
    checkId: string;
    inputIdentitySha256: string;
    definitionSha256: string;
  }) => Promise<{ evidenceId: string; receiptSha256: string; state: "passed" | "failed" }>;
  readonly childWorkflow?: (operationId: string) => Promise<string>;
  readonly publication?: (operationId: string) => Promise<string>;
  readonly provider?: () => Promise<void>;
}

export interface DelegatedTaskResumeInput {
  taskId: string;
  ownerId: string;
  repositoryPath: string;
  repositoryRevision: string;
  answersJson: string;
  freshAuthority: DelegatedTaskAuthorityDescriptorV1;
  storeDirectory: string;
  requestSha256?: string;
  taskSha256?: string;
  sourceSha256?: string;
  planSha256?: string;
  currentInputIdentitySha256?: string;
  authorizedDocumentationEdit?: boolean;
  checkDefinition?: DelegatedTaskCheckDefinitionV1;
  retainedCheckDefinition?: DelegatedTaskCheckDefinitionV1;
  executors?: DelegatedTaskResumeExecutors;
  knowledgeChildReceipt?: KnowledgeContinuationReceiptV1;
  now?: () => Date;
  /**
   * `now` writes the terminal phase before return. `defer` validates and
   * returns the next state without writing, so the caller can commit only
   * after the driver finishes.
   */
  commit?: "now" | "defer";
}

export type DelegatedTaskResumeResult =
  | {
      status: "resumed";
      result: DelegatedTaskResultV1;
      state: DelegatedTaskStateV1;
      recordByteSha256: string;
      genericPrompt: false;
      knowledgeChildReceipt?: KnowledgeContinuationReceiptV1;
      interviewRecordsCreated: 0;
    }
  | {
      status: "blocked-write-resume";
      nextRecipe: "#877";
      result: DelegatedTaskResultV1;
      genericPrompt: false;
    }
  | { status: "recovery-required"; code: "unsupported-recovery"; genericPrompt: false };

function forbidGenericPrompt(text: string): void {
  if (text.includes(DELEGATED_TASK_GENERIC_PROMPT)) {
    failDelegatedTaskContinuation("invalid-value");
  }
}

function sha256Text(value: string): string {
  return delegatedTaskStateContractKit.canonicalDigest(value);
}

async function canonicalRepositoryPath(path: string): Promise<string> {
  if (typeof path !== "string" || path.trim() === "" || !isAbsolute(path)) {
    failDelegatedTaskState("repository-mismatch");
  }
  if (path.split(/[\\/]/u).includes("..")) failDelegatedTaskState("repository-mismatch");
  const canonical = await realpath(resolve(path)).catch(() =>
    failDelegatedTaskState("repository-mismatch"),
  );
  const info = await stat(canonical).catch(() => failDelegatedTaskState("repository-mismatch"));
  if (!info.isDirectory()) failDelegatedTaskState("repository-mismatch");
  return canonical;
}

function locatorInsideRepository(repository: string, locator: string): string {
  const target = resolve(join(repository, locator));
  const relativePath = relative(repository, target);
  if (
    relativePath.startsWith(`..${sep}`) ||
    relativePath === ".." ||
    relativePath.startsWith("/")
  ) {
    failDelegatedTaskState("repository-mismatch");
  }
  return target;
}

export async function inspectAdmittedSources(input: {
  repositoryPath: string;
  admittedLocators: readonly string[];
}): Promise<readonly DelegatedTaskCompletedReadV1[]> {
  const repository = await canonicalRepositoryPath(input.repositoryPath);
  const reads: DelegatedTaskCompletedReadV1[] = [];
  for (const locator of input.admittedLocators) {
    const id = delegatedTaskStateContractKit.identifier(locator);
    const target = locatorInsideRepository(repository, id);
    const entry = await lstat(target).catch(() => undefined);
    if (!entry || entry.isSymbolicLink() || !entry.isFile()) continue;
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const bytes = await handle.readFile();
      reads.push({
        locator: id,
        digestSha256: createHash("sha256").update(bytes).digest("hex"),
      });
    } finally {
      await handle.close().catch(() => undefined);
    }
  }
  return Object.freeze(
    [...reads].sort((left, right) =>
      delegatedTaskStateContractKit.compare(left.locator, right.locator),
    ),
  );
}

async function targetExists(repositoryPath: string, locator: string): Promise<boolean> {
  const repository = await canonicalRepositoryPath(repositoryPath);
  const target = locatorInsideRepository(
    repository,
    delegatedTaskStateContractKit.identifier(locator),
  );
  const entry = await lstat(target).catch(() => undefined);
  return Boolean(entry && !entry.isSymbolicLink() && (entry.isFile() || entry.isDirectory()));
}

function projectResult(
  state: Pick<
    DelegatedTaskStateV1,
    | "taskId"
    | "request"
    | "repository"
    | "originalRequirements"
    | "planRequirementIds"
    | "pendingQuestions"
    | "knowledgeChildReceiptSha256"
  >,
  stopReason: "finished" | "needs-input",
  extras: {
    checks?: DelegatedTaskCheckEvidenceV1[];
    children?: DelegatedTaskChildEvidenceV1[];
  } = {},
): DelegatedTaskResultV1 {
  const children: DelegatedTaskChildEvidenceV1[] = extras.children
    ? [...extras.children]
    : state.knowledgeChildReceiptSha256
      ? [
          {
            childId: "child:knowledge",
            taskId: state.taskId,
            taskSha256: state.request.taskSha256,
            repositoryIdentitySha256: state.repository.identitySha256,
            repositoryRevision: state.repository.revision,
            workflow: "create-documentation",
            status: "succeeded",
            failureCode: null,
            formalQuality: "not-established",
            attemptedRequirementIds: state.originalRequirements
              .filter((requirement) => requirement.kind === "child-workflow")
              .map((requirement) => requirement.id),
          },
        ]
      : [];
  const result = projectDelegatedTaskFulfillment({
    taskId: state.taskId,
    request: state.request,
    repository: {
      identitySha256: state.repository.identitySha256,
      revision: state.repository.revision,
    },
    originalRequirements: state.originalRequirements,
    planRequirementIds: state.planRequirementIds,
    stopReason,
    deliveryState: "not-requested",
    artifacts: [],
    checks: extras.checks ?? [],
    children,
    pendingQuestions: state.pendingQuestions.map((question) => ({
      questionId: question.questionId,
    })),
    usage: ZERO_USAGE,
  });
  forbidGenericPrompt(result.nextAction.command);
  return result;
}

function stamp(now: () => Date): string {
  return now().toISOString();
}

function bindRepository(canonicalPath: string, revision: string) {
  return {
    identitySha256: createHash("sha256").update(canonicalPath).digest("hex"),
    revision,
    canonicalPathSha256: sha256Text(canonicalPath),
  };
}

function buildState(
  input: DelegatedTaskInspectPauseInput,
  canonicalPath: string,
  completedReads: readonly DelegatedTaskCompletedReadV1[],
  questions: readonly DelegatedTaskQuestionV1[],
  now: () => Date,
): DelegatedTaskStateV1 {
  const createdAt = stamp(now);
  const pending = questions;
  return createDelegatedTaskState({
    id: delegatedTaskStoreRecordId(input.taskId),
    taskId: input.taskId,
    ownerId: input.ownerId,
    request: input.request,
    repository: bindRepository(canonicalPath, input.repositoryRevision),
    sourceSha256: delegatedTaskSourceIdentitySha256(completedReads),
    planSha256: delegatedTaskPlanIdentitySha256(
      input.originalRequirements,
      input.originalRequirements.map((requirement) => requirement.id),
    ),
    outcomeSha256: sha256Text(input.outcome),
    outcome: input.outcome,
    originalRequirements: input.originalRequirements,
    planRequirementIds: input.originalRequirements.map((requirement) => requirement.id),
    pendingQuestions: pending,
    settledQuestionIds: [],
    issuedQuestionIds: pending.map((question) => question.questionId),
    completedReads,
    settledOperations: input.settledOperations ?? [],
    knowledgeChildReceiptSha256: input.knowledgeChildReceipt
      ? decodeKnowledgeContinuationReceipt(input.knowledgeChildReceipt).receiptSha256
      : null,
    storedAuthorityDescriptor: input.currentAuthority,
    phase: pending.length > 0 ? "pending-input" : "finished",
    activeTool: false,
    createdAt,
    updatedAt: createdAt,
  });
}

/**
 * Inspect admitted sources, then either finish without a question or persist a
 * clean pause with at most three essential questions.
 */
export async function inspectPauseDelegatedTask(
  input: DelegatedTaskInspectPauseInput,
): Promise<DelegatedTaskInspectPauseResult> {
  assertFreshAuthority(input.currentAuthority);
  delegatedTaskStateContractKit.enumeration(input.inputMode, DELEGATED_TASK_INPUT_MODES);
  if (input.activeTool) {
    return { status: "recovery-required", code: "unsupported-recovery", genericPrompt: false };
  }
  const now = input.now ?? (() => new Date());
  const canonicalPath = await canonicalRepositoryPath(input.repositoryPath);
  const completedReads = await inspectAdmittedSources({
    repositoryPath: canonicalPath,
    admittedLocators: input.admittedLocators,
  });
  const candidates: DelegatedTaskQuestionCandidateV1[] = [...(input.candidateQuestions ?? [])];
  if (input.materialTargetLocator) {
    const present = await targetExists(canonicalPath, input.materialTargetLocator);
    if (!present) {
      candidates.push({
        ...missingTargetQuestion(
          "The requested documentation target is missing after inspecting admitted sources.",
        ),
        disposition: "essential",
      });
    }
  }
  const questions = selectEssentialDelegatedQuestions(candidates);
  const state = buildState(input, canonicalPath, completedReads, questions, now);
  if (questions.length === 0) {
    const result = projectResult(state, "finished");
    return { status: "finished", result, completedReads, genericPrompt: false };
  }
  await new DelegatedTaskStateStore({ directory: input.storeDirectory }).save(state);
  const batch = questionBatchFromState(state);
  const result = projectResult(state, "needs-input");
  forbidGenericPrompt(batch.resumeCommand);
  if (result.stopReason !== "needs-input") failDelegatedTaskContinuation("invalid-value");
  if (result.fulfillment !== "partial" && result.fulfillment !== "none") {
    failDelegatedTaskContinuation("invalid-value");
  }
  if (result.nextAction.command !== DELEGATED_TASK_RESUME_ANSWERS_COMMAND(input.taskId)) {
    failDelegatedTaskContinuation("invalid-value");
  }
  return { status: "needs-input", result, batch, state, genericPrompt: false };
}

function findSettled(
  state: DelegatedTaskStateV1,
  kind: DelegatedTaskSettledOperationV1["kind"],
  operationId: string,
  inputIdentitySha256: string,
): DelegatedTaskSettledOperationV1 | undefined {
  const identity = delegatedTaskOperationIdentitySha256({
    kind,
    operationId,
    inputIdentitySha256,
  });
  return state.settledOperations.find(
    (operation) =>
      delegatedTaskOperationIdentitySha256({
        kind: operation.kind,
        operationId: operation.operationId,
        inputIdentitySha256: operation.inputIdentitySha256,
      }) === identity,
  );
}

function checkDefinitionUnchanged(
  current: DelegatedTaskCheckDefinitionV1,
  retained: DelegatedTaskCheckDefinitionV1,
): boolean {
  return (
    current.checkId === retained.checkId &&
    current.definitionSha256 === retained.definitionSha256 &&
    current.commandDefinitionSha256 === retained.commandDefinitionSha256 &&
    current.scopeSha256 === retained.scopeSha256 &&
    current.effectsSha256 === retained.effectsSha256 &&
    current.authoritySha256 === retained.authoritySha256
  );
}

/**
 * Resume only the exact retained owner-private task. Fresh authority is taken
 * from this invocation; stored descriptors, session messages, and answer text
 * cannot restore or widen a grant.
 */
export async function resumeDelegatedTask(
  input: DelegatedTaskResumeInput,
): Promise<DelegatedTaskResumeResult> {
  assertFreshAuthority(input.freshAuthority);
  const historyGrant = authorityFromHistoryCannotGrant({
    stored: { read: true, write: true, check: true },
    sessionMessage: input.answersJson,
    answerText: input.answersJson,
    priorAllowWrite: true,
  });
  if (historyGrant.write || historyGrant.check || historyGrant.read) {
    failDelegatedTaskContinuation("permission-changed");
  }
  const canonicalPath = await canonicalRepositoryPath(input.repositoryPath);
  const store = new DelegatedTaskStateStore({ directory: input.storeDirectory });
  const bound = bindRepository(canonicalPath, input.repositoryRevision);
  const loaded = await store.lookupWithDigest({
    taskId: input.taskId,
    ownerId: input.ownerId,
    repositoryIdentitySha256: bound.identitySha256,
    repositoryRevision: bound.revision,
    canonicalPathSha256: bound.canonicalPathSha256,
    requestSha256: input.requestSha256,
    taskSha256: input.taskSha256,
    sourceSha256: input.sourceSha256,
    planSha256: input.planSha256,
  });
  const state = loaded.state;
  if (state.phase === "recovery-required" || state.activeTool) {
    return { status: "recovery-required", code: "unsupported-recovery", genericPrompt: false };
  }
  if (input.freshAuthority.write || input.executors?.edit || input.executors?.publication) {
    return {
      status: "blocked-write-resume",
      nextRecipe: "#877",
      result: projectResult(state, "needs-input"),
      genericPrompt: false,
    };
  }
  const answers = decodeDelegatedTaskAnswers({
    bytes: input.answersJson,
    taskId: input.taskId,
    pendingQuestionIds: state.pendingQuestions.map((question) => question.questionId),
    settledQuestionIds: state.settledQuestionIds,
    issuedQuestionIds: state.issuedQuestionIds,
  });
  const referenced = new Set<string>();
  const verifier = {};
  const currentInputIdentitySha256 =
    input.currentInputIdentitySha256 ?? state.repository.identitySha256;
  const checks: DelegatedTaskCheckEvidenceV1[] = [];
  const newlySettledChecks: DelegatedTaskSettledOperationV1[] = [];
  if (input.checkDefinition && input.retainedCheckDefinition) {
    if (!checkDefinitionUnchanged(input.checkDefinition, input.retainedCheckDefinition)) {
      failDelegatedTaskContinuation("grant-required");
    }
    const prior = findSettled(
      state,
      "check",
      input.checkDefinition.checkId,
      currentInputIdentitySha256,
    );
    if (prior) {
      referenced.add(prior.receiptSha256);
      checks.push({
        evidenceId: `check:${input.checkDefinition.checkId}`,
        taskId: state.taskId,
        taskSha256: state.request.taskSha256,
        repositoryIdentitySha256: state.repository.identitySha256,
        repositoryRevision: state.repository.revision,
        checkId: input.checkDefinition.checkId,
        state: "passed",
        receiptSha256: prior.receiptSha256,
        boundRequirementIds: state.originalRequirements
          .filter((requirement) => requirement.kind === "check")
          .map((requirement) => requirement.id),
      });
    } else if (input.authorizedDocumentationEdit && input.executors?.check) {
      const executed = await input.executors.check({
        checkId: input.checkDefinition.checkId,
        inputIdentitySha256: currentInputIdentitySha256,
        definitionSha256: input.checkDefinition.definitionSha256,
      });
      referenced.add(executed.receiptSha256);
      newlySettledChecks.push({
        operationId: input.checkDefinition.checkId,
        kind: "check",
        inputIdentitySha256: currentInputIdentitySha256,
        receiptSha256: executed.receiptSha256,
        definitionSha256: input.checkDefinition.definitionSha256,
      });
      checks.push({
        evidenceId: executed.evidenceId,
        taskId: state.taskId,
        taskSha256: state.request.taskSha256,
        repositoryIdentitySha256: state.repository.identitySha256,
        repositoryRevision: state.repository.revision,
        checkId: input.checkDefinition.checkId,
        state: executed.state,
        receiptSha256: executed.receiptSha256,
        boundRequirementIds: state.originalRequirements
          .filter((requirement) => requirement.kind === "check")
          .map((requirement) => requirement.id),
      });
    }
  }
  for (const operation of state.settledOperations) referenced.add(operation.receiptSha256);
  for (const receipt of referenced) replayGuard.consume(verifier, receipt);
  const knowledgeChildReceipt = input.knowledgeChildReceipt
    ? decodeKnowledgeContinuationReceipt(input.knowledgeChildReceipt)
    : undefined;
  void input.executors?.childWorkflow;
  void input.executors?.provider;
  const now = input.now ?? (() => new Date());
  const answeredIds = Object.keys(answers);
  const resumed = createDelegatedTaskState({
    ...delegatedTaskStateBody(state),
    pendingQuestions: [],
    settledQuestionIds: Object.freeze(
      [...state.settledQuestionIds, ...answeredIds].sort(delegatedTaskStateContractKit.compare),
    ),
    phase: "finished",
    storedAuthorityDescriptor: input.freshAuthority,
    updatedAt: stamp(now),
    settledOperations: Object.freeze([...state.settledOperations, ...newlySettledChecks]),
  });
  if (input.commit !== "defer") await store.save(resumed, loaded.byteSha256);
  const result = projectResult(resumed, "finished", { checks });
  void answers[DELEGATED_TASK_MISSING_TARGET_QUESTION_ID];
  return {
    status: "resumed",
    result,
    state: resumed,
    recordByteSha256: loaded.byteSha256,
    genericPrompt: false,
    knowledgeChildReceipt,
    interviewRecordsCreated: 0,
  };
}

export function continueKnowledgeChild(receipt: unknown): KnowledgeContinuationReceiptV1 {
  return decodeKnowledgeContinuationReceipt(receipt);
}

export function createDelegatedRequirement(
  id: string,
  kind: DelegatedTaskRequirementInputV1["kind"],
  targetLocator: string,
): DelegatedTaskRequirementInputV1 {
  return {
    id,
    kind,
    originalSha256: delegatedTaskRequirementIdentitySha256({ id, kind, targetLocator }),
    targetLocator,
  };
}

export function createDelegatedRequest(
  requirements: readonly DelegatedTaskRequirementInputV1[],
  requestLabel = "request",
): DelegatedTaskRequestIdentityV1 {
  return {
    kind: "bounded-instruction",
    requestSha256: sha256Text(requestLabel),
    taskKind: "instruction-only",
    taskSha256: delegatedTaskRequirementsIdentitySha256(requirements),
  };
}

export { DelegatedTaskStateError, delegatedTaskStoreRecordId };
