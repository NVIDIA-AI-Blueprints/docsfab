// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Decide a provider failure's inference category from what the transport
 * observed of a sent request, before any message-text rule. Text misreads in
 * both directions (a broken stream flattened to `terminated`, a content-filter
 * stop that mentions `connection`), so the typed class decides and text is only
 * the fallback when there is no typed verdict.
 *
 * Only closed telemetry facts are read: whether a provider error exists (one is
 * recorded only when the last physical request left the host, so DocsFab's own
 * refusals never carry one), its class, its HTTP status, and any status a
 * structured in-stream error event declared. A re-decided error's message is
 * composed from those facts alone.
 */
import { inferenceFailureConditionOf, InferenceStepError } from "../execution/contracts.js";
import type {
  InferenceAttemptModelTelemetryV1,
  InferenceFailureCategory,
  ProviderErrorClass,
  ProviderErrorTelemetryV1,
} from "../records/contracts.js";
import { isHttpStatus } from "../records/model-telemetry.js";

/** The inference verdict one provider error class names. */
export interface ProviderErrorClassDisposition {
  readonly category: InferenceFailureCategory;
  readonly retryable: boolean;
}

/**
 * The one table from a sent provider error's class to its inference verdict,
 * read by both the in-turn replay (`provider-turn-retry.ts`) and the step-level
 * retry ({@link decideSentProviderFailure}).
 *
 * - `network`, `server`, and `timeout` are faults a fresh attempt can clear.
 *   So is `stream-incomplete`: the stream closed before the provider finished
 *   its answer, a transport fault rather than an answer about the request.
 * - `rate-limit` is retryable only when answered with a status; see
 *   {@link providerErrorDisposition}.
 * - `content-filter`, `auth`, and `invalid-request` are answers about this
 *   request or credential, so none is retried. With no policy-stop category,
 *   content-filter maps to `provider-terminal`; the recorded class still names
 *   the exact cause.
 * - `unknown` names no verdict; the failure keeps the text classifier's.
 */
export const PROVIDER_ERROR_CLASS_DISPOSITIONS: Readonly<
  Record<ProviderErrorClass, ProviderErrorClassDisposition | undefined>
> = Object.freeze({
  network: Object.freeze({ category: "provider-transient", retryable: true }),
  server: Object.freeze({ category: "provider-transient", retryable: true }),
  "stream-incomplete": Object.freeze({ category: "provider-transient", retryable: true }),
  timeout: Object.freeze({ category: "timeout", retryable: true }),
  "rate-limit": Object.freeze({ category: "throttled", retryable: true }),
  "content-filter": Object.freeze({ category: "provider-terminal", retryable: false }),
  auth: Object.freeze({ category: "invalid-request", retryable: false }),
  "invalid-request": Object.freeze({ category: "invalid-request", retryable: false }),
  unknown: undefined,
});

/**
 * The verdict for a `rate-limit` class with no HTTP status, such as "quota
 * exceeded" or an error event declaring 429 inside a 200 stream. That is
 * usually a quota wall no bounded backoff outlasts, so it is explicitly
 * terminal and no text rule can revive a retry for it.
 */
const UNANSWERED_RATE_LIMIT_DISPOSITION: ProviderErrorClassDisposition = Object.freeze({
  category: "provider-terminal",
  retryable: false,
});

/**
 * The verdict a sent provider error names, or `undefined` for none. The class
 * decides, except that a rate limit is retryable only when the provider
 * answered it with an HTTP status.
 */
export function providerErrorDisposition(
  providerError: Pick<ProviderErrorTelemetryV1, "class" | "httpStatus"> | undefined,
): ProviderErrorClassDisposition | undefined {
  if (providerError === undefined) return undefined;
  if (providerError.class === "rate-limit" && !isHttpStatus(providerError.httpStatus)) {
    return UNANSWERED_RATE_LIMIT_DISPOSITION;
  }
  return PROVIDER_ERROR_CLASS_DISPOSITIONS[providerError.class];
}

/**
 * Categories the text classifier assigns to a provider's answer, and so the
 * only ones a retryable typed verdict may replace. Every other category is
 * DocsFab's own verdict (a host budget stop, or a decoder's judgement of a reply
 * that arrived). A terminal typed verdict is not bound by this set.
 */
const PROVIDER_ANSWER_CATEGORIES: ReadonlySet<InferenceFailureCategory> = new Set([
  "timeout",
  "throttled",
  "provider-transient",
  "invalid-request",
  "provider-terminal",
]);

/** The closed inference disposition a step failure's telemetry decides, if any. */
export interface SentProviderFailureDisposition extends ProviderErrorClassDisposition {
  readonly providerErrorClass: ProviderErrorClass;
}

/**
 * The typed verdict for an attempt whose last landed provider turn ended with
 * a sent provider error; `undefined` for an `unknown` class and for every
 * attempt with no provider error, including one with no telemetry at all.
 */
export function sentProviderFailureDisposition(
  telemetry: InferenceAttemptModelTelemetryV1 | undefined,
): SentProviderFailureDisposition | undefined {
  const providerError = telemetry?.providerError;
  const disposition = providerErrorDisposition(providerError);
  return disposition === undefined || providerError === undefined
    ? undefined
    : { ...disposition, providerErrorClass: providerError.class };
}

/**
 * Re-decide a step failure from its attempt's typed provider telemetry, before
 * the text classifier's verdict counts; return every failure it does not
 * decide unchanged. The telemetry describes the last landed provider turn, not
 * the thrown error, so:
 *
 * - A coded decoder rejection keeps its verdict.
 * - A non-retryable typed verdict overrules a retryable failure of any
 *   category, since declining a retry is the safe direction. A failure that is
 *   already terminal keeps its category.
 * - A retryable typed verdict replaces only a category in
 *   `PROVIDER_ANSWER_CATEGORIES` that is `provider-terminal` (the text
 *   fallthrough) or already retryable, so a host refusal someone decided is
 *   never turned into a retry by an earlier turn's telemetry.
 *
 * The replacement keeps the evidence, reply fingerprint, and reply excerpt, and
 * carries the original as a non-enumerable `cause` so no serializer copies it
 * into a record.
 */
export function decideSentProviderFailure(failure: InferenceStepError): InferenceStepError {
  if (failure.rejection !== undefined) return failure;
  const telemetry = failure.evidence?.modelTelemetry;
  const disposition = sentProviderFailureDisposition(telemetry);
  if (!disposition) return failure;
  if (!disposition.retryable) {
    // An already terminal failure has no retry left to decide.
    if (!failure.retryable) return failure;
  } else if (
    !PROVIDER_ANSWER_CATEGORIES.has(failure.category) ||
    (!failure.retryable && failure.category !== "provider-terminal") ||
    (disposition.category === failure.category && failure.retryable)
  ) {
    return failure;
  }
  const status = telemetry?.providerError?.httpStatus;
  const streamStatus = telemetry?.providerError?.streamErrorStatus;
  const statusClause =
    status !== undefined
      ? ` (HTTP ${status})`
      : streamStatus !== undefined
        ? ` (in-stream status ${streamStatus})`
        : "";
  const decided = new InferenceStepError(
    `Model request failed [${disposition.category}; retryable=${disposition.retryable}]: the sent ` +
      `provider request ended with a ${disposition.providerErrorClass} error${statusClause}.`,
    disposition.category,
    disposition.retryable,
    failure.evidence,
    undefined,
    // A condition describes the original category; it survives only when the
    // typed verdict keeps that category.
    disposition.category === failure.category ? inferenceFailureConditionOf(failure) : undefined,
  );
  if (failure.rejectedReplyShape) decided.rejectedReplyShape = failure.rejectedReplyShape;
  if (failure.rejectedReplyExcerpt) decided.rejectedReplyExcerpt = failure.rejectedReplyExcerpt;
  Object.defineProperty(decided, "cause", {
    value: failure,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return decided;
}
