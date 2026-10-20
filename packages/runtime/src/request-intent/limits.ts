// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { limit, type ResolvedLimit, type ResolveLimitsOptions } from "../config/limits.js";
import type {
  RequestIntentExistenceAnswer,
  RequestIntentOperation,
  RequestIntentPathScope,
} from "./contract.js";

/** Resolved `requestIntent.*` limits; the caller resolves them through `limit()`. */
export interface RequestIntentLimits {
  readonly maxTargets: ResolvedLimit;
  readonly maxQuotes: ResolvedLimit;
  readonly maxQuoteChars: ResolvedLimit;
  readonly maxQuestionChars: ResolvedLimit;
  readonly maxQuestionOptions: ResolvedLimit;
  readonly maxOptionChars: ResolvedLimit;
  readonly maxInventoryEntries: ResolvedLimit;
  readonly maxNavigationEntries: ResolvedLimit;
  readonly maxWriteScopeEntries: ResolvedLimit;
  readonly maxDocsRootEntries: ResolvedLimit;
}

export const REQUEST_INTENT_LIMIT_NAMES = {
  maxTargets: "requestIntent.maxTargets",
  maxQuotes: "requestIntent.maxQuotes",
  maxQuoteChars: "requestIntent.maxQuoteChars",
  maxQuestionChars: "requestIntent.maxQuestionChars",
  maxQuestionOptions: "requestIntent.maxQuestionOptions",
  maxOptionChars: "requestIntent.maxOptionChars",
  maxInventoryEntries: "requestIntent.maxInventoryEntries",
  maxNavigationEntries: "requestIntent.maxNavigationEntries",
  maxWriteScopeEntries: "requestIntent.maxWriteScopeEntries",
  maxDocsRootEntries: "requestIntent.maxDocsRootEntries",
} as const satisfies Record<keyof RequestIntentLimits, string>;

export interface RequestIntentDecodeInput {
  /** The operator's request text as the run received it. */
  readonly instruction: string;
  readonly limits: RequestIntentLimits;
}

/**
 * Everything admission reads besides the proposal. Every field is required; a
 * missing or malformed one is a host fault, never a default.
 */
export interface RequestIntentAdmissionInput extends RequestIntentDecodeInput {
  /** Repository paths an `inventory` target may name, matched exactly. */
  readonly inventory: readonly string[];
  /** The operation the run's declared workflow or `do` route performs. */
  readonly declaredOperation: RequestIntentOperation;
  /** Roots a create target must sit under, compared exactly and segment-bounded. */
  readonly docsRoot: readonly RequestIntentPathScope[];
  /** What the run may write, compared exactly and segment-bounded. */
  readonly grantedWriteScope: readonly RequestIntentPathScope[];
  /** Existing navigation and index files a companion target may name, matched exactly. */
  readonly navigationSet: readonly string[];
  /**
   * One answer per path `requestIntentExistencePaths` asks about, and no
   * other: the `write`-role targets, exact case.
   */
  readonly existence: readonly RequestIntentExistenceAnswer[];
}

/** Resolve every `requestIntent.*` bound through `limit()`, for a caller to pass in. */
export function resolveRequestIntentLimits(
  options: ResolveLimitsOptions = {},
): RequestIntentLimits {
  const resolve = (name: string) => limit(name, options);
  return {
    maxTargets: resolve(REQUEST_INTENT_LIMIT_NAMES.maxTargets),
    maxQuotes: resolve(REQUEST_INTENT_LIMIT_NAMES.maxQuotes),
    maxQuoteChars: resolve(REQUEST_INTENT_LIMIT_NAMES.maxQuoteChars),
    maxQuestionChars: resolve(REQUEST_INTENT_LIMIT_NAMES.maxQuestionChars),
    maxQuestionOptions: resolve(REQUEST_INTENT_LIMIT_NAMES.maxQuestionOptions),
    maxOptionChars: resolve(REQUEST_INTENT_LIMIT_NAMES.maxOptionChars),
    maxInventoryEntries: resolve(REQUEST_INTENT_LIMIT_NAMES.maxInventoryEntries),
    maxNavigationEntries: resolve(REQUEST_INTENT_LIMIT_NAMES.maxNavigationEntries),
    maxWriteScopeEntries: resolve(REQUEST_INTENT_LIMIT_NAMES.maxWriteScopeEntries),
    maxDocsRootEntries: resolve(REQUEST_INTENT_LIMIT_NAMES.maxDocsRootEntries),
  };
}
