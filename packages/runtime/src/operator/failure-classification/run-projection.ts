// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Project failure classes onto step, run, and store records. */
import {
  CLI_REFUSAL_FAILURE_CLASSES,
  RUN_STORE_FAILURE_CLASSES,
  RUN_FAILURE_CODE_CLASSES,
  runFailure,
  type RunFailureCode,
} from "./run-codes.js";
import {
  INFERENCE_CATEGORY_FAILURE_CLASSES,
  OPERATOR_CODE_FAMILY_FAILURE_CLASSES,
  LIMIT_REFUSAL_CODES,
  COMPOSITION_EVIDENCE_CLASS_BY_CODE,
} from "./inference-codes.js";
import { QUALITY_ARTIFACT_FAILURE_CLASSES, qualityRejectionFailureClass } from "./quality-codes.js";
import {
  classifyInferenceAttempt,
  classifyInferenceFailure,
  classifyQualityValidationFailure,
  classifyUnboundQualityRejection,
  executionLimitCodeOf,
  requestPolicyRefusalOf,
} from "./inference-classification.js";
import { retainedInferenceRejection } from "../../config/inference-rejection-limits.js";

import { QualityStepRejectionError } from "../../evaluation-report/quality-check-rejections.js";

import { InferenceStepError } from "../../execution/contracts.js";

import {
  REQUEST_POLICY_REFUSALS,
  isRequestPolicyRefusal,
  requestPolicyFailureCode,
  requestPolicyRefusalOfCode,
  type RequestPolicyRefusal,
} from "../../model/request-policy-refusals.js";
import type {
  InferenceFailureCategory,
  RunRecord,
  RunStore,
  StepRunRecord,
} from "../../records/contracts.js";
import type { FileRunStoreErrorCode } from "../../records/file-store.js";
import { CompositionExecutionEvidenceError } from "../../records/composition-execution-error.js";

import { QualityPackError } from "../../quality-pack/error.js";

import {
  failureClassification,
  isFailureCode,
  readFailureClassification,
  type FailureClass,
  type FailureClassificationV1,
  type FailureLayer,
} from "../failure-class.js";
import { situationRowForId } from "../situation-catalog.js";

/** The class of a public operator code outside inference, or `undefined` when no table names it. */
export function operatorCodeFailureClass(code: string): FailureClass | undefined {
  const row = situationRowForId(code);
  if (row) return row.failureClass;
  const refusal = requestPolicyRefusalOfCode(code);
  if (refusal) return REQUEST_POLICY_REFUSALS[refusal].failureClass;
  if (Object.hasOwn(CLI_REFUSAL_FAILURE_CLASSES, code)) {
    return CLI_REFUSAL_FAILURE_CLASSES[code as keyof typeof CLI_REFUSAL_FAILURE_CLASSES];
  }
  if (Object.hasOwn(RUN_STORE_FAILURE_CLASSES, code)) {
    return RUN_STORE_FAILURE_CLASSES[code as keyof typeof RUN_STORE_FAILURE_CLASSES];
  }
  if (Object.hasOwn(RUN_FAILURE_CODE_CLASSES, code)) {
    return RUN_FAILURE_CODE_CLASSES[code as RunFailureCode];
  }
  if (Object.hasOwn(INFERENCE_CATEGORY_FAILURE_CLASSES, code)) {
    return INFERENCE_CATEGORY_FAILURE_CLASSES[code as InferenceFailureCategory];
  }
  for (const [prefix, failureClass] of Object.entries(OPERATOR_CODE_FAMILY_FAILURE_CLASSES)) {
    // The bare prefix, or a code containing it later on, stays uncatalogued.
    if (code.startsWith(prefix) && code.length > prefix.length) return failureClass;
  }
  if (LIMIT_REFUSAL_CODES.has(code)) return "bound";
  return undefined;
}

/**
 * Set the run's class from a refusal a trusted admission port reported rather
 * than threw. An unregistered code is `unknown` with that code. A code outside
 * the kebab-case shape records `unclassified-run-failure` instead of throwing
 * out of the finalizer.
 */
export function markRunRefusal(record: RunRecord, code: string): void {
  if (readFailureClassification(record.failure)) return;
  if (!isFailureCode(code)) {
    record.failure = runFailure("unclassified-run-failure");
    return;
  }
  record.failure = failureClassification(
    operatorCodeFailureClass(code) ?? "unknown",
    "workflow",
    code,
  );
}

/** Kebab-case code on an error, the same shape the operator envelope admits. */
function errorCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || !("code" in error)) return undefined;
  const code = (error as { code: unknown }).code;
  return typeof code === "string" && /^[a-z](?:[a-z0-9-]{0,62}[a-z0-9])?$/u.test(code)
    ? code
    : undefined;
}

/**
 * Classify a thrown error at `layer`. An inference error classifies at the
 * inference layer; any other error reads its code from the operator tables.
 */
export function classifyThrownFailure(
  error: unknown,
  layer: FailureLayer,
  options: { readonly cancelled?: boolean } = {},
): FailureClassificationV1 {
  if (options.cancelled) return runFailure("workflow-cancelled");
  // A classification must never fail the stop it describes. A hostile error
  // (a throwing `code` getter, a trapping proxy) reads as uncoded.
  try {
    return classifyThrownError(error, layer);
  } catch {
    return failureClassification("unknown", layer, "uncoded-error");
  }
}

/**
 * The error the retry layer wrapped as `provider-terminal` only because it was
 * not an inference error, else `undefined`. The wrapped error's code names the
 * cause; the wrap's category does not.
 */
function retryWrappedCause(error: unknown): unknown {
  try {
    return error instanceof InferenceStepError &&
      error.category === "provider-terminal" &&
      error.rejection === undefined &&
      error.cause !== undefined &&
      !(error.cause instanceof InferenceStepError)
      ? error.cause
      : undefined;
  } catch {
    return undefined;
  }
}

function classifyThrownError(error: unknown, layer: FailureLayer): FailureClassificationV1 {
  // The envelope and the step record read the same cause from the same error.
  const wrapped = retryWrappedCause(error);
  if (wrapped !== undefined) return classifyThrownError(wrapped, layer);
  if (error instanceof CompositionExecutionEvidenceError) {
    return failureClassification(COMPOSITION_EVIDENCE_CLASS_BY_CODE[error.code], layer, error.code);
  }
  if (error instanceof QualityStepRejectionError) {
    return classifyUnboundQualityRejection(error.rejection?.code, layer);
  }
  // The installed quality pack failed verification. The class follows the error's
  // type, not its code: `unsafe-path`, `stale`, `tampered`, and most other pack
  // codes are also thrown by modules that read a repository, an artifact store, or
  // another lock. A code row would class those failures too, so those errors stay
  // `unknown`. Whichever check failed, the pack needs restoring.
  if (error instanceof QualityPackError) {
    return failureClassification("infrastructure", layer, error.code);
  }
  if (error instanceof InferenceStepError) {
    const rejection = error.rejection ? retainedInferenceRejection(error.rejection) : undefined;
    const finishReason = error.evidence?.turns?.at(-1)?.rawStopReason;
    const modelTelemetry = error.evidence?.modelTelemetry;
    return classifyInferenceFailure({
      category: error.category,
      ...(error.hostFailureOrigin === undefined
        ? {}
        : { hostFailureOrigin: error.hostFailureOrigin }),
      ...(rejection ? { rejectionCode: rejection.code } : {}),
      ...(typeof finishReason === "string" ? { finishReason } : {}),
      ...(modelTelemetry === undefined ? {} : { modelTelemetry }),
      ...executionLimitCodeOf(error.evidence ?? {}),
      ...requestPolicyRefusalOf(error.evidence ?? {}),
    });
  }
  const refusal = requestPolicyRefusalOfError(error);
  if (refusal) {
    return failureClassification(
      REQUEST_POLICY_REFUSALS[refusal].failureClass,
      layer,
      requestPolicyFailureCode(refusal),
    );
  }
  const code = errorCode(error);
  if (code === undefined) return failureClassification("unknown", layer, "uncoded-error");
  return failureClassification(operatorCodeFailureClass(code) ?? "unknown", layer, code);
}

/** The closed refusal a `ProviderRequestPolicyError` carries, read without importing it. */
function requestPolicyRefusalOfError(error: unknown): RequestPolicyRefusal | undefined {
  if (!(error instanceof Error) || errorCode(error) !== "provider-request-policy") return undefined;
  const refusal = (error as { refusal?: unknown }).refusal;
  return isRequestPolicyRefusal(refusal) ? refusal : undefined;
}

/**
 * Classify a failed step: cancellation, then a retry-wrapped non-inference
 * error, then the terminal failed inference attempt, then the thrown error.
 */
export function classifyStepFailure(input: {
  readonly error: unknown;
  readonly step: Pick<StepRunRecord, "inference">;
  readonly cancelled: boolean;
}): FailureClassificationV1 {
  if (input.cancelled) return runFailure("workflow-cancelled");
  const wrapped = retryWrappedCause(input.error);
  if (wrapped !== undefined) return classifyThrownFailure(wrapped, "workflow");
  const terminal = input.step.inference?.attempts.at(-1);
  return classifyInferenceAttempt(terminal) ?? classifyThrownFailure(input.error, "workflow", {});
}

/**
 * A failed step's classification: the recorded one, else one read from its
 * quality validator code or terminal inference attempt, so an older record
 * without a stored class classifies when its closed evidence names one.
 */
export function readStepFailure(
  step: StepRunRecord,
  record?: Pick<RunRecord, "qualityArtifactValidation">,
): FailureClassificationV1 | undefined {
  if (step.status !== "failed") return undefined;
  const recorded = readFailureClassification((step as { failure?: unknown }).failure);
  if (recorded) return recorded;
  const quality = (step as { qualityValidationRejection?: { code?: unknown } })
    .qualityValidationRejection;
  const failureCode = record?.qualityArtifactValidation?.failureCode;
  if (failureCode && Object.hasOwn(QUALITY_ARTIFACT_FAILURE_CLASSES, failureCode)) {
    return classifyQualityValidationFailure({
      failureCode,
      ...(typeof quality?.code === "string" ? { rejectionCode: quality.code } : {}),
    });
  }
  // A quality refusal with no binding names its cause only by its code.
  if (typeof quality?.code === "string" && qualityRejectionFailureClass(quality.code)) {
    return classifyUnboundQualityRejection(quality.code, "workflow");
  }
  return classifyInferenceAttempt(step.inference?.attempts.at(-1));
}

/** The run's failure: the recorded one, else its first failed step's. */
export function readRunFailure(record: RunRecord): FailureClassificationV1 | undefined {
  if (record.status !== "failed") return undefined;
  const recorded = readFailureClassification((record as { failure?: unknown }).failure);
  if (recorded) return recorded;
  const steps = Array.isArray(record.steps) ? record.steps : [];
  for (const step of steps) {
    const failure = readStepFailure(step, record);
    if (failure) return failure;
  }
  return undefined;
}

/**
 * Attach classifications to a record before save. A failed run without its own
 * class takes its first failed step's, else `unclassified-run-failure`; a
 * record that is not failed carries none.
 */
export function attachRunFailureClassifications(record: RunRecord): void {
  const steps = Array.isArray(record.steps) ? record.steps : [];
  for (const step of steps) {
    if (step.status !== "failed") {
      delete step.failure;
      continue;
    }
    if (!readFailureClassification(step.failure)) {
      step.failure =
        readStepFailure({ ...step, failure: undefined }, record) ??
        runFailure("unclassified-step-failure");
    }
  }
  if (record.status !== "failed") {
    delete record.failure;
    delete record.workflowOutcomeRejection;
    delete record.authoringCandidateRejection;
    delete record.editorialFinalizationRejection;
    return;
  }
  if (readFailureClassification(record.failure)) return;
  const firstFailedStep = steps.find((step) => step.status === "failed");
  record.failure =
    (firstFailedStep ? readFailureClassification(firstFailedStep.failure) : null) ??
    runFailure("unclassified-run-failure");
}

/** A run store that attaches failure classes before every save. */
export function classifyingRunStore(store: RunStore): RunStore {
  return {
    async save(record: RunRecord): Promise<void> {
      attachRunFailureClassifications(record);
      await store.save(record);
    },
  };
}

/** Serialize immutable run snapshots so event-driven progress cannot overtake terminal saves. */
export function serializingRunStore(store: RunStore): RunStore {
  let tail: Promise<void> = Promise.resolve();
  return {
    save(record: RunRecord): Promise<void> {
      const snapshot = structuredClone(record);
      const operation = tail.then(() => store.save(snapshot));
      tail = operation.then(
        () => undefined,
        () => undefined,
      );
      return operation;
    },
  };
}

/**
 * Set the run's class unless an earlier failure already set it, so the run
 * keeps its first cause when a later finalizer also fails.
 */
export function markRunFailure(record: RunRecord, code: RunFailureCode): void {
  if (readFailureClassification(record.failure)) return;
  record.failure = runFailure(code);
}

/**
 * Set the run's class from the error that stopped it after or between steps. A
 * failed step already names the first cause, so the run takes its class at save.
 */
export function markRunThrownFailure(
  record: RunRecord,
  error: unknown,
  options: { readonly cancelled: boolean; readonly storeCode?: FileRunStoreErrorCode },
): void {
  if (readFailureClassification(record.failure)) return;
  if (options.cancelled) {
    record.failure = runFailure("workflow-cancelled");
    return;
  }
  const steps = Array.isArray(record.steps) ? record.steps : [];
  if (steps.some((step) => step.status === "failed")) return;
  if (options.storeCode !== undefined) {
    const code = `run-store-${options.storeCode}` as const;
    record.failure = failureClassification(RUN_STORE_FAILURE_CLASSES[code], "workflow", code);
    return;
  }
  record.failure = classifyThrownFailure(error, "workflow");
}

/** One failure occurrence for `--json` and reports: run, step, or attempt. */
export interface FailureOccurrenceV1 extends FailureClassificationV1 {
  readonly scope: "run" | "step" | "attempt";
  readonly stepId?: string;
  readonly attempt?: number;
}

/**
 * Every failure a record names, including failed attempts of a step that later
 * succeeded.
 */
export function projectRunFailureOccurrences(record: RunRecord): FailureOccurrenceV1[] {
  const occurrences: FailureOccurrenceV1[] = [];
  const run = readRunFailure(record);
  if (run) occurrences.push(Object.freeze({ scope: "run", ...run }));
  const steps = Array.isArray(record.steps) ? record.steps : [];
  for (const step of steps) {
    const stepFailure = readStepFailure(step, record);
    if (stepFailure) {
      occurrences.push(Object.freeze({ scope: "step", stepId: step.id, ...stepFailure }));
    }
    const attempts = Array.isArray(step.inference?.attempts) ? step.inference.attempts : [];
    for (const attempt of attempts) {
      const attemptFailure = classifyInferenceAttempt(attempt);
      if (!attemptFailure) continue;
      occurrences.push(
        Object.freeze({
          scope: "attempt",
          stepId: step.id,
          ...(Number.isSafeInteger(attempt.attempt) ? { attempt: attempt.attempt } : {}),
          ...attemptFailure,
        }),
      );
    }
  }
  return occurrences;
}
