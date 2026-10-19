// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * One owner for the inference retry and attempt-outcome vocabulary, so outcome
 * validation, the scorecard failure classes, and the live-corpus decoder
 * cannot drift apart.
 *
 * Harness-neutral: string tuples and membership predicates only, and its one
 * import is type-only. Whether to retry, how many attempts are permitted, and
 * how physical attempts are accounted remain the retry policy's and the
 * runner's jobs. Adding or removing a category is a product decision, not a
 * refactor.
 */
import type { InferenceFailureCategory } from "./records/contracts.js";

export type { InferenceFailureCategory };

export const INFERENCE_ATTEMPT_SUCCESS_OUTCOME = "succeeded";

/**
 * Every inference failure category, in the order the scorecard and its
 * renderer report them. The order is load-bearing for the reliability
 * `incidents` / `terminalFailures` key order and the rendered incident table,
 * so it matches `scorecard-render.ts`'s shipped reporting list exactly.
 */
export const INFERENCE_FAILURE_CATEGORIES = Object.freeze([
  "blank-response",
  "malformed-response",
  "context-exhausted",
  "timeout",
  "throttled",
  "provider-transient",
  "provider-terminal",
  "host-runtime-failure",
  "invalid-request",
  "no-progress",
] as const satisfies readonly InferenceFailureCategory[]);

/**
 * `true` only while the tuple above enumerates the whole record-contract
 * union. A category added to `InferenceFailureCategory` without being listed
 * here makes this declaration fail to typecheck.
 */
export const INFERENCE_FAILURE_CATEGORY_COVERAGE: [InferenceFailureCategory] extends [
  (typeof INFERENCE_FAILURE_CATEGORIES)[number],
]
  ? true
  : never = true;

/** Every recordable attempt outcome: success plus every failure category. */
export const INFERENCE_ATTEMPT_OUTCOMES = Object.freeze([
  INFERENCE_ATTEMPT_SUCCESS_OUTCOME,
  ...INFERENCE_FAILURE_CATEGORIES,
] as const);

export type InferenceAttemptOutcome = (typeof INFERENCE_ATTEMPT_OUTCOMES)[number];

/**
 * The categories a retry policy may list as retryable. This is the vocabulary
 * bound, not a retry decision: a policy that retries none of them is valid.
 */
export const CONFIGURABLE_RETRY_CATEGORIES = Object.freeze([
  "blank-response",
  "malformed-response",
  "timeout",
  "throttled",
  "provider-transient",
  "no-progress",
] as const satisfies readonly InferenceFailureCategory[]);

export type ConfigurableRetryCategory = (typeof CONFIGURABLE_RETRY_CATEGORIES)[number];

export type NonRetryableInferenceFailureCategory = Exclude<
  InferenceFailureCategory,
  ConfigurableRetryCategory
>;

/**
 * The complement of {@link CONFIGURABLE_RETRY_CATEGORIES}, derived rather than
 * restated so the two sets stay a partition of the failure categories.
 */
export const NON_RETRYABLE_INFERENCE_FAILURE_CATEGORIES: readonly NonRetryableInferenceFailureCategory[] =
  Object.freeze(
    INFERENCE_FAILURE_CATEGORIES.filter(
      (category): category is NonRetryableInferenceFailureCategory =>
        !isConfigurableRetryCategory(category),
    ),
  );

export function isInferenceAttemptOutcome(value: unknown): value is InferenceAttemptOutcome {
  return (INFERENCE_ATTEMPT_OUTCOMES as readonly unknown[]).includes(value);
}

export function isInferenceFailureCategory(value: unknown): value is InferenceFailureCategory {
  return (INFERENCE_FAILURE_CATEGORIES as readonly unknown[]).includes(value);
}

/**
 * The only failure category whose attempt may carry a reply-shape fingerprint.
 * Corpus-live and other consumers compare through this predicate so they do
 * not re-declare the category literal beside the closed set.
 */
export function isMalformedResponseCategory(
  value: unknown,
): value is Extract<InferenceFailureCategory, "malformed-response"> {
  return value === "malformed-response";
}

export function isConfigurableRetryCategory(value: unknown): value is ConfigurableRetryCategory {
  return (CONFIGURABLE_RETRY_CATEGORIES as readonly unknown[]).includes(value);
}

export function isNonRetryableInferenceFailureCategory(
  value: unknown,
): value is NonRetryableInferenceFailureCategory {
  return (NON_RETRYABLE_INFERENCE_FAILURE_CATEGORIES as readonly unknown[]).includes(value);
}
