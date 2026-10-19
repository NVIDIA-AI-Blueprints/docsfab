// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-attempt model telemetry vocabulary and the one shape check every
 * attempt decoder shares, so decoders cannot drift apart. Keep it
 * harness-neutral: normalizing raw transport values is
 * `model/attempt-telemetry.ts`'s job.
 *
 * Content-free: every field is a closed-set member or an integer, so no
 * provider token, error text, or model output reaches a record through it.
 */
import type {
  InferenceAttemptEvidence,
  InferenceAttemptModelTelemetryV1,
  ModelFinishReason,
  ProviderErrorClass,
  ProviderErrorTelemetryV1,
} from "./contracts.js";

export type {
  InferenceAttemptModelTelemetryV1,
  ModelFinishReason,
  ProviderErrorClass,
  ProviderErrorTelemetryV1,
};

export const MODEL_TELEMETRY_SCHEMA_VERSION = 1;

export const MODEL_FINISH_REASONS = Object.freeze([
  "stop",
  "length",
  "tool-use",
  "content-filter",
  "error",
  "aborted",
  "unknown",
] as const satisfies readonly ModelFinishReason[]);

/** `true` only while the tuple above enumerates the whole contract union. */
export const MODEL_FINISH_REASON_COVERAGE: [ModelFinishReason] extends [
  (typeof MODEL_FINISH_REASONS)[number],
]
  ? true
  : never = true;

/**
 * Raw provider stop tokens, lower-cased, by transport vocabulary:
 * chat completions (`stop`, `length`, `tool_calls`, `content_filter`),
 * Anthropic messages (`end_turn`, `max_tokens`, `tool_use`, `refusal`),
 * OpenAI responses (`completed`, `incomplete.max_output_tokens`), and Gemini
 * (`STOP`, `MAX_TOKENS`, `SAFETY`). Anything else is `unknown`. The one
 * mapping both the telemetry normalizer and the failure classifier read.
 */
export const RAW_MODEL_FINISH_REASONS: ReadonlyMap<string, ModelFinishReason> = new Map([
  ["stop", "stop"],
  ["end", "stop"],
  ["end_turn", "stop"],
  ["stop_sequence", "stop"],
  ["pause_turn", "stop"],
  ["completed", "stop"],
  ["length", "length"],
  ["max_tokens", "length"],
  ["max_output_tokens", "length"],
  ["incomplete.max_output_tokens", "length"],
  ["tool_calls", "tool-use"],
  ["function_call", "tool-use"],
  ["tool_use", "tool-use"],
  ["content_filter", "content-filter"],
  ["incomplete.content_filter", "content-filter"],
  ["refusal", "content-filter"],
  ["sensitive", "content-filter"],
  ["safety", "content-filter"],
  ["recitation", "content-filter"],
  ["error", "error"],
  ["network_error", "error"],
  ["failed", "error"],
  ["cancelled", "aborted"],
]);

export const PROVIDER_ERROR_CLASSES = Object.freeze([
  "rate-limit",
  "auth",
  "server",
  "timeout",
  "content-filter",
  "network",
  "stream-incomplete",
  "invalid-request",
  "unknown",
] as const satisfies readonly ProviderErrorClass[]);

/** `true` only while the tuple above enumerates the whole contract union. */
export const PROVIDER_ERROR_CLASS_COVERAGE: [ProviderErrorClass] extends [
  (typeof PROVIDER_ERROR_CLASSES)[number],
]
  ? true
  : never = true;

const TELEMETRY_KEYS: ReadonlySet<string> = new Set([
  "schemaVersion",
  "finishReason",
  "outputTokens",
  "outputAllowance",
  "providerLatencyMs",
  "providerError",
]);
const PROVIDER_ERROR_KEYS: ReadonlySet<string> = new Set([
  "class",
  "httpStatus",
  "retryAfterMs",
  "streamErrorStatus",
]);

export function isModelFinishReason(value: unknown): value is ModelFinishReason {
  return (MODEL_FINISH_REASONS as readonly unknown[]).includes(value);
}

export function isProviderErrorClass(value: unknown): value is ProviderErrorClass {
  return (PROVIDER_ERROR_CLASSES as readonly unknown[]).includes(value);
}

export function isHttpStatus(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => keys.has(key));
}

/**
 * A recorded `Retry-After` never stands without the status of the response
 * that carried it; a wait no observed response asked for cannot lengthen a
 * backoff. An in-stream declared status belongs to a 2xx response, so it never
 * stands with a transport `httpStatus`.
 */
function isProviderErrorTelemetry(value: unknown): value is ProviderErrorTelemetryV1 {
  if (!isPlainObject(value) || !hasOnlyKeys(value, PROVIDER_ERROR_KEYS)) return false;
  return (
    isProviderErrorClass(value.class) &&
    (value.httpStatus === undefined || isHttpStatus(value.httpStatus)) &&
    (value.retryAfterMs === undefined ||
      (isCount(value.retryAfterMs) && isHttpStatus(value.httpStatus))) &&
    (value.streamErrorStatus === undefined ||
      (isHttpStatus(value.streamErrorStatus) &&
        value.streamErrorStatus >= 400 &&
        value.httpStatus === undefined))
  );
}

/** A provider error ends its attempt, so a succeeded `outcome` carrying one is refused. */
export function isInferenceAttemptModelTelemetry(
  value: unknown,
  outcome: InferenceAttemptEvidence["outcome"],
): value is InferenceAttemptModelTelemetryV1 {
  if (!isPlainObject(value) || !hasOnlyKeys(value, TELEMETRY_KEYS)) return false;
  if (value.schemaVersion !== MODEL_TELEMETRY_SCHEMA_VERSION) return false;
  if (!isCount(value.providerLatencyMs)) return false;
  if (value.finishReason !== undefined && !isModelFinishReason(value.finishReason)) return false;
  if (value.outputTokens !== undefined && !isCount(value.outputTokens)) return false;
  if (
    value.outputAllowance !== undefined &&
    (!isCount(value.outputAllowance) || value.outputAllowance === 0)
  ) {
    return false;
  }
  if (value.providerError === undefined) return true;
  // The error is the last landed turn's, so that turn's finish reason exists.
  return (
    outcome !== "succeeded" &&
    value.finishReason !== undefined &&
    isProviderErrorTelemetry(value.providerError)
  );
}
