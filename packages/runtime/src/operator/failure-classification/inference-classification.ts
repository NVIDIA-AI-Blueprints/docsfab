// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Classify recorded inference attempts from admitted telemetry and codes. */
import {
  INFERENCE_REJECTION_FAILURE_CLASSES,
  INFERENCE_CATEGORY_FAILURE_CLASSES,
  LIMIT_REFUSAL_CODES,
  familyClass,
  providerErrorFailure,
} from "./inference-codes.js";
import {
  QUALITY_VALIDATION_REJECTION_FAILURE_CLASSES,
  QUALITY_ARTIFACT_FAILURE_CLASSES,
  qualityRejectionFailureClass,
} from "./quality-codes.js";
import { runFailure } from "./run-codes.js";

import { attemptExecutionLimitStop } from "../../config/execution-limit-stops.js";

import {
  REQUEST_POLICY_REFUSALS,
  isRequestPolicyRefusal,
  requestPolicyFailureCode,
} from "../../model/request-policy-refusals.js";
import type {
  InferenceAttemptEvidence,
  InferenceFailureCategory,
  ModelFinishReason,
} from "../../records/contracts.js";

import {
  isInferenceAttemptModelTelemetry,
  RAW_MODEL_FINISH_REASONS,
} from "../../records/model-telemetry.js";

import {
  failureClassification,
  isFailureCode,
  type FailureClass,
  type FailureClassificationV1,
  type FailureLayer,
} from "../failure-class.js";

/**
 * Normalized telemetry finish reasons meaning the reply hit its output
 * allowance. A failed attempt that ended this way is a bound, whatever shape
 * the reply had.
 */
export const OUTPUT_LIMIT_MODEL_FINISH_REASONS: ReadonlySet<ModelFinishReason> = new Set([
  "length",
]);

/**
 * Raw provider stop tokens that mean the same, read from the last turn when
 * the record has no normalized finish reason. Derived from the telemetry
 * normalizer's own table, so a token it maps to `length` cannot be missed here.
 */
export const OUTPUT_LIMIT_FINISH_REASONS: ReadonlySet<string> = new Set(
  [...RAW_MODEL_FINISH_REASONS]
    .filter(([, reason]) => OUTPUT_LIMIT_MODEL_FINISH_REASONS.has(reason))
    .map(([token]) => token),
);

/** The class a closed rejection code maps to, or `undefined` outside every table. */
export function inferenceRejectionFailureClass(code: string): FailureClass | undefined {
  if (Object.hasOwn(INFERENCE_REJECTION_FAILURE_CLASSES, code)) {
    return INFERENCE_REJECTION_FAILURE_CLASSES[code];
  }
  // A quality correction round records the quality check's own code.
  if (Object.hasOwn(QUALITY_VALIDATION_REJECTION_FAILURE_CLASSES, code)) {
    return QUALITY_VALIDATION_REJECTION_FAILURE_CLASSES[code];
  }
  // A host bound that ended the attempt records its catalog refusal, such as a
  // read-loop stop; read last, so a table that names a shared code keeps its class.
  return familyClass(code) ?? (LIMIT_REFUSAL_CODES.has(code) ? "bound" : undefined);
}

/** The code of an attempt whose own timer fired while the model was still calling tools. */
export const ATTEMPT_DEADLINE_IN_TOOL_LOOP = "attempt-deadline-in-tool-loop";

/** The code of an attempt whose own timer fired while a provider request had no first byte. */
export const ATTEMPT_DEADLINE_AWAITING_PROVIDER = "attempt-deadline-awaiting-provider";

/**
 * Classify one failed inference attempt: an output-limit stop wins, then a
 * named execution ceiling, then a recorded `cut-answer` condition, then an
 * attempt deadline inside a tool loop, then the coded rejection, then the
 * retained provider error, then the category. An unnamed rejection code is
 * `unknown` with that code, never the category's class, so the missing table
 * entry stays visible. `context-exhausted` is the host's own stop, so a
 * provider error never replaces its `bound`.
 */
export function classifyInferenceFailure(input: {
  readonly category: InferenceFailureCategory;
  readonly hostFailureOrigin?: InferenceAttemptEvidence["hostFailureOrigin"];
  readonly rejectionCode?: string;
  readonly finishReason?: string;
  /** The attempt's `modelTelemetry`, read through the record's strict reader. */
  readonly modelTelemetry?: unknown;
  /**
   * The catalog code of the execution ceiling the attempt stopped at, read
   * from its governed turn or lease evidence by `attemptExecutionLimitStop`.
   */
  readonly executionLimitCode?: string;
  readonly cancelled?: boolean;
  /**
   * The installed request policy's refusal recorded on the attempt's last
   * governed turn, read by `requestPolicyRefusalOf`. The refused request was
   * never sent, so nothing the provider or the reply recorded outranks it.
   */
  readonly requestPolicyRefusal?: string;
  /**
   * The attempt's recorded condition. A `cut-answer` refusal is classed by the
   * whole answer: its last turn may have stopped normally after a continuation.
   * A named execution-limit code, when the attempt records one, is the more
   * specific bound and takes precedence over this condition.
   */
  readonly condition?: unknown;
  /** Where the attempt timer found an `attempt-deadline` attempt (`deadlineTurn`). */
  readonly deadlineTurn?: unknown;
  /** The attempt recorded a `concludeNow` ask, so its next turn was the answer. */
  readonly askedToAnswer?: boolean;
}): FailureClassificationV1 {
  if (input.cancelled) return runFailure("workflow-cancelled");
  // The host-origin pair is captured at the coordinator boundary. It outranks
  // provider telemetry and model finish metadata, which describe a different
  // subsystem and must not misattribute this failure.
  if (input.category === "host-runtime-failure") {
    const origin = input.hostFailureOrigin;
    if (
      !origin ||
      Object.keys(origin).sort().join(",") !== "code,origin,schemaVersion" ||
      origin.schemaVersion !== 1 ||
      origin.origin !== "execution-lease-coordinator" ||
      origin.code !== "invalid-execution-lease-coordinator"
    ) {
      return failureClassification("unknown", "inference", "unreadable-host-failure-origin");
    }
    return failureClassification(
      "infrastructure",
      "inference",
      "invalid-execution-lease-coordinator",
    );
  }
  if (isRequestPolicyRefusal(input.requestPolicyRefusal)) {
    return failureClassification(
      REQUEST_POLICY_REFUSALS[input.requestPolicyRefusal].failureClass,
      "inference",
      requestPolicyFailureCode(input.requestPolicyRefusal),
    );
  }
  const telemetry = isInferenceAttemptModelTelemetry(input.modelTelemetry, input.category)
    ? input.modelTelemetry
    : undefined;
  const cutAtAllowance =
    telemetry?.finishReason !== undefined
      ? OUTPUT_LIMIT_MODEL_FINISH_REASONS.has(telemetry.finishReason)
      : input.finishReason !== undefined &&
        OUTPUT_LIMIT_FINISH_REASONS.has(input.finishReason.trim().toLowerCase());
  if (cutAtAllowance) return failureClassification("bound", "inference", "output-limit-reached");
  // A governor or lease stop at an execution ceiling names that ceiling,
  // whatever category the stop was wrapped in on its way out of the harness.
  if (input.executionLimitCode !== undefined && isFailureCode(input.executionLimitCode)) {
    return failureClassification("bound", "inference", input.executionLimitCode);
  }
  // A refused answer the host cut and continued is classed by the whole answer;
  // a named execution ceiling above is the more specific bound and wins.
  if (input.condition === "cut-answer") {
    return failureClassification("bound", "inference", "output-limit-reached");
  }
  // The host's attempt timer fired: a tool loop is a host bound, a request
  // with no first byte is the provider's stall.
  if (input.condition === "attempt-deadline") {
    // A request the provider never started answering is the provider's stall,
    // whatever the model did before it.
    if (input.deadlineTurn === "awaiting-first-byte") {
      return failureClassification(
        "infrastructure",
        "inference",
        ATTEMPT_DEADLINE_AWAITING_PROVIDER,
      );
    }
    // A tool loop needs evidence the model was still producing tool calls: its
    // last landed turn called tools, and the timer found tools running or tool
    // calls (or, before any ask for the answer, other output) streaming.
    const lastFinish =
      telemetry?.finishReason ??
      (input.finishReason === undefined
        ? undefined
        : RAW_MODEL_FINISH_REASONS.get(input.finishReason.trim().toLowerCase()));
    const producingToolCalls =
      input.deadlineTurn === "between-requests" ||
      input.deadlineTurn === "streaming-tool-call" ||
      (input.deadlineTurn === "streaming" && input.askedToAnswer !== true);
    if (lastFinish === "tool-use" && producingToolCalls) {
      return failureClassification("bound", "inference", ATTEMPT_DEADLINE_IN_TOOL_LOOP);
    }
  }
  if (input.rejectionCode !== undefined) {
    // A hand-edited record can carry any string here; one outside the code
    // grammar is not a code, so it cannot be named, and classing must not throw.
    if (!isFailureCode(input.rejectionCode)) {
      return failureClassification("unknown", "inference", "unreadable-rejection-code");
    }
    return failureClassification(
      inferenceRejectionFailureClass(input.rejectionCode) ?? "unknown",
      "inference",
      input.rejectionCode,
    );
  }
  if (telemetry && input.category !== "context-exhausted") {
    const provider = providerErrorFailure(telemetry);
    if (provider) return failureClassification(provider.failureClass, "inference", provider.code);
  }
  return failureClassification(
    INFERENCE_CATEGORY_FAILURE_CLASSES[input.category],
    "inference",
    input.category,
  );
}

/**
 * Classify a recorded attempt, or `undefined` for a succeeded or unreadable
 * one. Reads only the attempt's closed fields.
 */
export function classifyInferenceAttempt(
  attempt: InferenceAttemptEvidence | undefined,
): FailureClassificationV1 | undefined {
  if (!attempt || typeof attempt !== "object") return undefined;
  const outcome = attempt.outcome;
  if (!Object.hasOwn(INFERENCE_CATEGORY_FAILURE_CLASSES, outcome)) return undefined;
  const lastTurn = Array.isArray(attempt.turns) ? attempt.turns.at(-1) : undefined;
  const rejectionCode =
    attempt.rejection && typeof attempt.rejection.code === "string"
      ? attempt.rejection.code
      : undefined;
  return classifyInferenceFailure({
    category: outcome as InferenceFailureCategory,
    ...(attempt.hostFailureOrigin === undefined
      ? {}
      : { hostFailureOrigin: attempt.hostFailureOrigin }),
    ...(rejectionCode === undefined ? {} : { rejectionCode }),
    ...(typeof lastTurn?.rawStopReason === "string"
      ? { finishReason: lastTurn.rawStopReason }
      : {}),
    ...(attempt.modelTelemetry === undefined ? {} : { modelTelemetry: attempt.modelTelemetry }),
    ...executionLimitCodeOf(attempt),
    ...requestPolicyRefusalOf(attempt),
    ...(attempt.condition === undefined ? {} : { condition: attempt.condition }),
    ...(attempt.deadlineTurn === undefined ? {} : { deadlineTurn: attempt.deadlineTurn }),
    askedToAnswer: attempt.concludeNow !== undefined,
  });
}

/**
 * The request-policy refusal on an attempt's last governed turn, read
 * defensively: only the turn the attempt ended on, and only a catalogued id.
 */
export function requestPolicyRefusalOf(evidence: { readonly turns?: unknown }): {
  requestPolicyRefusal?: string;
} {
  const last = Array.isArray(evidence.turns) ? (evidence.turns.at(-1) as unknown) : undefined;
  const refusal =
    last && typeof last === "object"
      ? (last as { requestPolicyRefusal?: unknown }).requestPolicyRefusal
      : undefined;
  return isRequestPolicyRefusal(refusal) ? { requestPolicyRefusal: refusal } : {};
}

/** The execution-ceiling code an attempt's turn or lease evidence names, read defensively. */
export function executionLimitCodeOf(evidence: {
  readonly turns?: unknown;
  readonly executionLease?: unknown;
}): { executionLimitCode?: string } {
  const turns = Array.isArray(evidence.turns) ? evidence.turns : undefined;
  const lease =
    evidence.executionLease && typeof evidence.executionLease === "object"
      ? evidence.executionLease
      : undefined;
  const stop = attemptExecutionLimitStop({
    ...(turns ? { turns } : {}),
    ...(lease ? { executionLease: lease } : {}),
  });
  return stop ? { executionLimitCode: stop.code } : {};
}

/** Classify a quality validation stop from its inner code, else its binding code. */
export function classifyQualityValidationFailure(input: {
  readonly rejectionCode?: string;
  readonly failureCode: keyof typeof QUALITY_ARTIFACT_FAILURE_CLASSES;
}): FailureClassificationV1 {
  const code = input.rejectionCode;
  // A code outside the grammar is not a code; the binding's code still names the stop.
  const inner = code === undefined ? undefined : qualityRejectionFailureClass(code);
  if (code !== undefined && inner) return failureClassification(inner, "workflow", code);
  return failureClassification(
    QUALITY_ARTIFACT_FAILURE_CLASSES[input.failureCode],
    "workflow",
    input.failureCode,
  );
}

/**
 * Classify a quality-path refusal that has no validation binding. An unnamed
 * code is `unknown` with that code.
 */
export function classifyUnboundQualityRejection(
  code: unknown,
  layer: FailureLayer,
): FailureClassificationV1 {
  if (!isFailureCode(code))
    return failureClassification("unknown", layer, "unreadable-rejection-code");
  return failureClassification(qualityRejectionFailureClass(code) ?? "unknown", layer, code);
}
