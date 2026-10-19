// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Finite delegated-task clarification batch and answer-file decoding. Only a
 * material missing outcome or target, a contradictory product fact, or
 * unavailable authority is clarification; implementation-detail,
 * skill/workflow-ID, and typed tool/validator-failure candidates never become
 * questions. One batch holds at most three essential questions.
 */
import { createContractKit } from "../contract-kit/index.js";
import { JsonEvidenceError, parseJsonEvidence } from "../json-evidence.js";

export const DELEGATED_TASK_QUESTION_BATCH_KIND = "docsfab-delegated-task-question-batch" as const;
export const DELEGATED_TASK_QUESTION_BATCH_SCHEMA_VERSION = 1 as const;
export const DELEGATED_TASK_MAX_ESSENTIAL_QUESTIONS = 3 as const;
export const DELEGATED_TASK_MISSING_TARGET_QUESTION_ID = "q-target" as const;
export const DELEGATED_TASK_RESUME_ANSWERS_COMMAND = (
  taskId: string,
): `docsfab do --resume ${string} --answers <json-file>` =>
  `docsfab do --resume ${taskId} --answers <json-file>`;

export const DELEGATED_TASK_CLARIFICATION_KINDS = [
  "missing-outcome-or-target",
  "contradictory-product-fact",
  "unavailable-authority",
] as const;
export type DelegatedTaskClarificationKind = (typeof DELEGATED_TASK_CLARIFICATION_KINDS)[number];

export const DELEGATED_TASK_QUESTION_DISPOSITIONS = [
  "essential",
  "implementation-detail",
  "skill-or-workflow-id",
  "tool-validator-failure",
] as const;
export type DelegatedTaskQuestionDisposition =
  (typeof DELEGATED_TASK_QUESTION_DISPOSITIONS)[number];

export type DelegatedTaskQuestionErrorCode =
  | "invalid-shape"
  | "invalid-value"
  | "digest-mismatch"
  | "credential-material"
  | "migration-required"
  | "batch-too-large"
  | "forbidden-question"
  | "malformed-answers"
  | "duplicate-answer-key"
  | "missing-answer"
  | "extra-answer"
  | "stale-answer"
  | "already-settled-answer"
  | "blank-answer";

export class DelegatedTaskQuestionError extends Error {
  public constructor(public readonly code: DelegatedTaskQuestionErrorCode) {
    super(`Delegated task question contract was rejected for the closed code ${code}.`);
    this.name = "DelegatedTaskQuestionError";
  }
}

export function failDelegatedTaskQuestion(code: DelegatedTaskQuestionErrorCode): never {
  throw new DelegatedTaskQuestionError(code);
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
  enumeration,
  compare,
  unique,
  seal,
} = createContractKit({
  fail: failDelegatedTaskQuestion,
  inertMode: "strict",
  codes: {
    invalidShape: "invalid-shape",
    invalidValue: "invalid-value",
    digestMismatch: "digest-mismatch",
    credentialMaterial: "credential-material",
    schemaMismatch: "migration-required",
  },
});

const SKILL_OR_WORKFLOW_ID_PATTERN =
  /(?:\bskill\b|\bworkflow\b).{0,32}(?:\bid\b|\bidentifier\b|\bname\b)|(?:\bid\b|\bidentifier\b).{0,24}(?:\bskill\b|\bworkflow\b)/iu;
const IMPLEMENTATION_DETAIL_PATTERN =
  /(?:implementation detail|which helper|internal function|module filename)/iu;

export interface DelegatedTaskQuestionV1 {
  questionId: string;
  clarificationKind: DelegatedTaskClarificationKind;
  prompt: string;
  reason: string;
}

export interface DelegatedTaskCompletedReadV1 {
  locator: string;
  digestSha256: string;
}

export interface DelegatedTaskQuestionCandidateV1 {
  questionId: string;
  clarificationKind: DelegatedTaskClarificationKind;
  disposition: DelegatedTaskQuestionDisposition;
  prompt: string;
  reason: string;
}

export interface DelegatedTaskQuestionBatchBodyV1 {
  taskId: string;
  questions: readonly DelegatedTaskQuestionV1[];
  completedReads: readonly DelegatedTaskCompletedReadV1[];
  resumeCommand: string;
}

export type DelegatedTaskQuestionBatchV1 = DelegatedTaskQuestionBatchBodyV1 & {
  schemaVersion: typeof DELEGATED_TASK_QUESTION_BATCH_SCHEMA_VERSION;
  kind: typeof DELEGATED_TASK_QUESTION_BATCH_KIND;
  batchSha256: string;
};

export const DELEGATED_TASK_QUESTION_BATCH_BODY_KEYS = [
  "taskId",
  "questions",
  "completedReads",
  "resumeCommand",
] as const;

function focusedText(value: unknown): string {
  const result = string(value);
  if (result.length < 1 || result.length > 512 || result.trim() !== result) {
    failDelegatedTaskQuestion("invalid-value");
  }
  return result;
}

function decodeQuestion(value: unknown): DelegatedTaskQuestionV1 {
  const root = object(value);
  exact(root, ["questionId", "clarificationKind", "prompt", "reason"]);
  const questionId = identifier(root.questionId);
  const prompt = focusedText(root.prompt);
  const reason = focusedText(root.reason);
  if (SKILL_OR_WORKFLOW_ID_PATTERN.test(prompt) || SKILL_OR_WORKFLOW_ID_PATTERN.test(reason)) {
    failDelegatedTaskQuestion("forbidden-question");
  }
  if (IMPLEMENTATION_DETAIL_PATTERN.test(prompt) || IMPLEMENTATION_DETAIL_PATTERN.test(reason)) {
    failDelegatedTaskQuestion("forbidden-question");
  }
  return {
    questionId,
    clarificationKind: enumeration(root.clarificationKind, DELEGATED_TASK_CLARIFICATION_KINDS),
    prompt,
    reason,
  };
}

function decodeCompletedRead(value: unknown): DelegatedTaskCompletedReadV1 {
  const root = object(value);
  exact(root, ["locator", "digestSha256"]);
  return {
    locator: identifier(root.locator),
    digestSha256: hash(root.digestSha256),
  };
}

function normalizeBatch(root: Record<string, unknown>): DelegatedTaskQuestionBatchBodyV1 {
  const questions = array(root.questions).map(decodeQuestion);
  unique(questions.map((question) => question.questionId));
  if (questions.length < 1) failDelegatedTaskQuestion("invalid-value");
  if (questions.length > DELEGATED_TASK_MAX_ESSENTIAL_QUESTIONS) {
    failDelegatedTaskQuestion("batch-too-large");
  }
  const ordered = [...questions].sort((left, right) => compare(left.questionId, right.questionId));
  const completedReads = array(root.completedReads)
    .map(decodeCompletedRead)
    .sort((left, right) => compare(left.locator, right.locator));
  unique(completedReads.map((read) => read.locator));
  const taskId = identifier(root.taskId);
  const resumeCommand = string(root.resumeCommand);
  if (resumeCommand !== DELEGATED_TASK_RESUME_ANSWERS_COMMAND(taskId)) {
    failDelegatedTaskQuestion("invalid-value");
  }
  return {
    taskId,
    questions: Object.freeze(ordered),
    completedReads: Object.freeze(completedReads),
    resumeCommand,
  };
}

export function createDelegatedTaskQuestionBatch(
  input: DelegatedTaskQuestionBatchBodyV1,
): DelegatedTaskQuestionBatchV1 {
  assertInert(input);
  rejectCredentials(input);
  const root = object(input);
  exact(root, [...DELEGATED_TASK_QUESTION_BATCH_BODY_KEYS]);
  return seal(
    DELEGATED_TASK_QUESTION_BATCH_KIND,
    "batchSha256",
    normalizeBatch(root),
  ) as DelegatedTaskQuestionBatchV1;
}

function isForbiddenCandidate(candidate: DelegatedTaskQuestionCandidateV1): boolean {
  if (candidate.disposition !== "essential") return true;
  if (SKILL_OR_WORKFLOW_ID_PATTERN.test(candidate.prompt)) return true;
  if (SKILL_OR_WORKFLOW_ID_PATTERN.test(candidate.reason)) return true;
  if (IMPLEMENTATION_DETAIL_PATTERN.test(candidate.prompt)) return true;
  if (IMPLEMENTATION_DETAIL_PATTERN.test(candidate.reason)) return true;
  return false;
}

/**
 * Drop non-essential candidates, then keep at most three essential questions in
 * stable question-id order. Implementation-detail and skill/workflow-ID
 * questions never appear.
 */
export function selectEssentialDelegatedQuestions(
  candidates: readonly DelegatedTaskQuestionCandidateV1[],
): readonly DelegatedTaskQuestionV1[] {
  assertInert(candidates);
  const essential = array(candidates)
    .map((value) => {
      const root = object(value);
      exact(root, ["questionId", "clarificationKind", "prompt", "reason", "disposition"]);
      return {
        questionId: identifier(root.questionId),
        clarificationKind: enumeration(root.clarificationKind, DELEGATED_TASK_CLARIFICATION_KINDS),
        disposition: enumeration(root.disposition, DELEGATED_TASK_QUESTION_DISPOSITIONS),
        prompt: focusedText(root.prompt),
        reason: focusedText(root.reason),
      };
    })
    .filter((candidate) => !isForbiddenCandidate(candidate))
    .sort((left, right) => compare(left.questionId, right.questionId));
  unique(essential.map((candidate) => candidate.questionId));
  return Object.freeze(
    essential.slice(0, DELEGATED_TASK_MAX_ESSENTIAL_QUESTIONS).map((candidate) => ({
      questionId: candidate.questionId,
      clarificationKind: candidate.clarificationKind,
      prompt: candidate.prompt,
      reason: candidate.reason,
    })),
  );
}

export function missingTargetQuestion(reason: string): DelegatedTaskQuestionV1 {
  return {
    questionId: DELEGATED_TASK_MISSING_TARGET_QUESTION_ID,
    clarificationKind: "missing-outcome-or-target",
    prompt: "What documentation target path should this delegated task produce?",
    reason: focusedText(reason),
  };
}

export interface DecodeDelegatedTaskAnswersInput {
  bytes: string;
  taskId: string;
  pendingQuestionIds: readonly string[];
  settledQuestionIds?: readonly string[];
  issuedQuestionIds?: readonly string[];
}

export function decodeDelegatedTaskAnswers(
  input: DecodeDelegatedTaskAnswersInput,
): Readonly<Record<string, string>> {
  const pending = [...input.pendingQuestionIds].map(identifier).sort(compare);
  unique(pending);
  const settled = [...(input.settledQuestionIds ?? [])].map(identifier);
  unique(settled);
  const issued = [...(input.issuedQuestionIds ?? pending)].map(identifier);
  unique(issued);
  if (pending.some((id) => settled.includes(id))) failDelegatedTaskQuestion("invalid-value");
  identifier(input.taskId);
  let parsed: unknown;
  try {
    parsed = parseJsonEvidence(input.bytes);
  } catch (error) {
    if (error instanceof JsonEvidenceError && error.code === "duplicate-key") {
      failDelegatedTaskQuestion("duplicate-answer-key");
    }
    failDelegatedTaskQuestion("malformed-answers");
  }
  assertInert(parsed);
  rejectCredentials(parsed);
  const root = object(parsed);
  const keys = Object.keys(root).sort(compare);
  unique(keys.map(identifier));
  for (const key of keys) {
    const questionId = identifier(key);
    if (settled.includes(questionId)) failDelegatedTaskQuestion("already-settled-answer");
    if (!pending.includes(questionId)) {
      if (issued.includes(questionId)) failDelegatedTaskQuestion("stale-answer");
      failDelegatedTaskQuestion("extra-answer");
    }
  }
  for (const pendingId of pending) {
    if (!keys.includes(pendingId)) failDelegatedTaskQuestion("missing-answer");
  }
  const answers: Record<string, string> = {};
  for (const key of keys) {
    const value = string(root[key]);
    if (value.trim() === "" || value.trim() !== value) failDelegatedTaskQuestion("blank-answer");
    if (value.length > 4_096) failDelegatedTaskQuestion("invalid-value");
    answers[key] = value;
  }
  return Object.freeze(answers);
}
