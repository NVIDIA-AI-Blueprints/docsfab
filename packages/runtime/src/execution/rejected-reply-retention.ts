// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Harness-boundary attachment of a rejected reply's shape fingerprint and its
 * bounded, redacted excerpt.
 *
 * Kept apart from `rejected-reply-shape.ts` so the record contract can import
 * the fingerprint types from a leaf that does not depend on `execution/contracts.ts`.
 */

import { InferenceStepError } from "./contracts.js";
import { limit } from "../config/limits.js";
import { isMalformedResponseCategory } from "../inference-attempt-taxonomy.js";
import { excerptRejectedReply } from "./rejected-reply-excerpt.js";
import { fingerprintRejectedReply, type DeclaredReplyKey } from "./rejected-reply-shape.js";
import { responseContractKeyVocabulary } from "./response-contract-vocabulary.js";

/** Resolved before any attempt runs. */
export interface RejectedReplyShapePolicy {
  readonly isDeclared: DeclaredReplyKey;
  readonly maxDepth: number;
  readonly maxEntries: number;
  readonly excerptChars: number;
}

/**
 * Resolve the fingerprint and excerpt bounds and the response-contract
 * vocabulary once, before a step's first attempt. An out-of-range override or
 * an unreadable schema refuses here, so it can never replace a rejection later.
 */
export function resolveRejectedReplyShapePolicy(): RejectedReplyShapePolicy {
  const vocabulary = responseContractKeyVocabulary();
  return Object.freeze({
    isDeclared: (key: string) => vocabulary.has(key),
    maxDepth: limit("inference.rejectedReplyShapeMaxDepth").value,
    maxEntries: limit("inference.rejectedReplyShapeMaxEntries").value,
    excerptChars: limit("inference.rejectedReplyExcerptChars").value,
  });
}

/**
 * Attach the fingerprint and redacted excerpt of `reply` to a response-contract
 * rejection.
 *
 * Called once at the harness boundary, after every decoder wrap has run. Only a
 * `malformed-response` rejection without a fingerprint is changed. Returns the
 * same error object, so state other modules key on its identity survives. Pure
 * given `policy`: no environment or catalog read on this error path. The
 * credential guard may load its source parser on first use; if a guard cannot
 * run, every excerpt segment is withheld rather than the rejection replaced.
 * `innerTexts` are strings decoded from inside `reply` that the excerpt's
 * credential screen covers as well.
 */
export function retainRejectedReplyShape(
  error: unknown,
  reply: string | undefined,
  policy: RejectedReplyShapePolicy,
  innerTexts: readonly string[] = [],
): unknown {
  if (
    reply === undefined ||
    !(error instanceof InferenceStepError) ||
    !isMalformedResponseCategory(error.category) ||
    error.rejectedReplyShape !== undefined
  ) {
    return error;
  }
  error.rejectedReplyShape = fingerprintRejectedReply(reply, policy.isDeclared, {
    maxDepth: policy.maxDepth,
    maxEntries: policy.maxEntries,
  });
  const { parse } = error.rejectedReplyShape;
  error.rejectedReplyExcerpt = excerptRejectedReply(
    reply,
    policy.excerptChars,
    parse.status === "failed" ? parse.offset : undefined,
    innerTexts,
  );
  return error;
}
