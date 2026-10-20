// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { InferenceRetryPolicy } from "../execution/contracts.js";
import { CONFIGURABLE_RETRY_CATEGORIES as TAXONOMY_RETRY_CATEGORIES } from "../inference-attempt-taxonomy.js";
import type { InferenceFailureCategory } from "../records/contracts.js";
import { limit, type LimitSource, type ResolvedLimit } from "./limits.js";

/** The default retries every category the taxonomy lets a policy list. */
export const DEFAULT_RETRYABLE_CATEGORIES: readonly InferenceFailureCategory[] = Object.freeze([
  ...TAXONOMY_RETRY_CATEGORIES,
]);

const CONFIGURABLE_RETRY_CATEGORIES = new Set<InferenceFailureCategory>(
  DEFAULT_RETRYABLE_CATEGORIES,
);

/** Applied read-only retry default, with the catalog/host/project source that produced `maxRetries`. */
export type InferenceRetryPolicyArtefact = InferenceRetryPolicy & {
  readonly maxRetriesSource: LimitSource;
};

/**
 * A condition budget (timeout, cut answer, no-progress) is a subset of the read-only retry
 * count, not a second one. An operator override above that count is refused
 * here, so the operator is told. The catalog default is applied as at most that
 * count: a host that lowers `DOCSFAB_READ_ONLY_MAX_RETRIES`, even to 0, did not
 * ask for more condition retries, and `docsfab doctor` prints the applied value.
 */
function conditionRetryBudget(
  resolved: ResolvedLimit,
  maxRetries: number,
  override: string,
): number {
  if (resolved.value <= maxRetries) return resolved.value;
  if (resolved.source !== "config/limits.yaml") {
    throw new Error(`${override} must be less than or equal to DOCSFAB_READ_ONLY_MAX_RETRIES.`);
  }
  return maxRetries;
}

export function parseRetryPolicy(environment: NodeJS.ProcessEnv): InferenceRetryPolicyArtefact {
  const options = { environment };
  const maxRetries = limit("retry.maxRetries", options);
  const maxTimeoutRetries = conditionRetryBudget(
    limit("retry.maxTimeoutRetries", options),
    maxRetries.value,
    "DOCSFAB_READ_ONLY_MAX_TIMEOUT_RETRIES",
  );
  const maxCutAnswerRetries = conditionRetryBudget(
    limit("retry.maxCutAnswerRetries", options),
    maxRetries.value,
    "DOCSFAB_READ_ONLY_MAX_CUT_ANSWER_RETRIES",
  );
  const maxNoProgressRetries = conditionRetryBudget(
    limit("retry.maxNoProgressRetries", options),
    maxRetries.value,
    "DOCSFAB_READ_ONLY_MAX_NO_PROGRESS_RETRIES",
  );
  const baseDelayMs = limit("retry.baseDelayMs", options).value;
  const maxDelayMs = limit("retry.maxDelayMs", options).value;
  if (maxDelayMs < baseDelayMs) {
    throw new Error(
      "DOCSFAB_RETRY_MAX_DELAY_MS must be greater than or equal to DOCSFAB_RETRY_BASE_DELAY_MS.",
    );
  }
  const rawCategories = environment.DOCSFAB_RETRYABLE_CATEGORIES?.trim();
  const retryableCategories = rawCategories
    ? rawCategories.split(",").map((category) => category.trim())
    : [...DEFAULT_RETRYABLE_CATEGORIES];
  if (
    retryableCategories.length === 0 ||
    retryableCategories.some(
      (category) => !CONFIGURABLE_RETRY_CATEGORIES.has(category as InferenceFailureCategory),
    )
  ) {
    throw new Error(
      `DOCSFAB_RETRYABLE_CATEGORIES must contain only ${[...CONFIGURABLE_RETRY_CATEGORIES].join(", ")}.`,
    );
  }
  if (new Set(retryableCategories).size !== retryableCategories.length) {
    throw new Error("DOCSFAB_RETRYABLE_CATEGORIES must not contain duplicates.");
  }
  return {
    maxRetries: maxRetries.value,
    maxTimeoutRetries,
    maxCutAnswerRetries,
    maxNoProgressRetries,
    baseDelayMs,
    maxDelayMs,
    retryableCategories: retryableCategories as InferenceFailureCategory[],
    // Throttles and provider transport faults never spend `maxRetries`.
    transport: {
      maxRetries: limit("retry.maxTransportRetries", options).value,
      maxDelayMs: limit("retry.transportMaxDelayMs", options).value,
      maxElapsedMs: limit("retry.transportMaxElapsedMs", options).value,
    },
    maxRetriesSource: maxRetries.source,
  };
}
