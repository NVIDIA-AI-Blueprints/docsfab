// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Bounded in-turn retry for retryable provider failures.
 *
 * Pi reports a provider failure as a stream `error` event, not a throw, and
 * DocsFab's session handler terminalizes the execution lease before the outer
 * classifier can call it retryable. This wrapper sits directly above the
 * provider transport and below the turn governor, so a retry:
 *
 * - replays the exact request it last sent: the governed request, or the nudged
 *   request once the length nudge has fired. The governor is not re-entered, so
 *   `maxProviderTurns` still bounds distinct requests, and
 *   `finalizeTurnEvidence` fails closed if a replay's payload digest differs
 *   from the one it sealed;
 * - never reaches Pi's agent, so the execution lease is not terminalized;
 * - is bounded by attempt count, per-attempt backoff, a total backoff budget,
 *   the caller's abort signal, and the composition's attempt deadline. A turn
 *   the provider is throttling (HTTP 429) gets a wider count and wait budget:
 *   measured route throttling stayed as likely after a long wait as after a
 *   short one, so only more attempts outlast it.
 *
 * A blank turn that stopped at the output limit gets one non-identical replay
 * that appends a bounded nudge naming the limit, since an identical replay asks
 * the same question. Transport faults arrive in bursts and this window can be a
 * single-attempt step's only defence, so it is wide; empty turns keep the
 * narrower `maxBlankAttempts` bound because each replay re-bills the whole input
 * context.
 */
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

import {
  observeLandedProviderTurn,
  type ProviderExchangeObservation,
} from "./attempt-telemetry.js";
import { classifyModelFailure } from "./context-budget.js";
import { providerAttemptLimit } from "./provider-attempt.js";
import { providerErrorDisposition } from "./sent-provider-failure.js";
import type { InferenceFailureCategory, ProviderTurnReplayVeto } from "../records/contracts.js";

export type { ProviderTurnReplayVeto };

type StreamSimple = ModelRuntime["streamSimple"];
type StreamSimpleContext = Parameters<StreamSimple>[1];
type StreamSimpleOptions = Parameters<StreamSimple>[2];
type ProviderEventStream = ReturnType<StreamSimple>;
type ProviderEvent = { type: string; error?: unknown };

/**
 * Categories replayed with the identical request when the provider ended the
 * stream with an error event: transport or availability faults with no partial
 * commitment at the provider. `malformed-response` and `blank-response` are
 * excluded because a provider error claiming either is a model-output fault the
 * workflow-level retry policy owns. Empty turns are not error events; see
 * `observeBlankProviderTurn`.
 */
export const RETRYABLE_PROVIDER_TURN_CATEGORIES: readonly InferenceFailureCategory[] =
  Object.freeze(["provider-transient", "throttled", "timeout"]);

/**
 * Pi stop reasons for a successfully completed turn whose emptiness carries no
 * verdict of its own, so an identical replay may answer differently.
 */
const REPLAYABLE_BLANK_STOP_REASONS: ReadonlySet<string> = new Set(["stop", "toolUse"]);

/**
 * Provider `finish_reason` values behind those stop reasons. `length`,
 * `content_filter`, and every unknown reason are deterministic answers about
 * this request, so an identical replay pays twice for the same refusal.
 */
const REPLAYABLE_BLANK_FINISH_REASONS: ReadonlySet<string> = new Set([
  "stop",
  "end",
  "tool_calls",
  "function_call",
]);

/** Stop metadata, mapped or raw, meaning the model spent its whole output budget. */
const LENGTH_STOP_REASONS: ReadonlySet<string> = new Set(["length", "max_tokens"]);

/**
 * Nudged replays granted to one governed turn whose blank answer stopped at the
 * output limit. A second such answer fails the step rather than paying again.
 */
export const MAX_LENGTH_STOP_NUDGED_REPLAYS = 1;

/**
 * Upper bound on the nudge text. It must fit inside the request policy's
 * `reservedContextTokens`, which the turn governor keeps free, so the nudge
 * cannot push a governed request past its input ceiling.
 */
export const LENGTH_STOP_NUDGE_MAX_CHARS = 600;

export interface BlankProviderTurnObservation {
  /** Pi's mapped stop reason for the completed turn. */
  stopReason: string;
  /** The provider's own `finish_reason`, when the transport preserved one. */
  rawStopReason?: string;
  /** Provider error text carried on a turn that still completed, when present. */
  errorMessage?: string;
  usage: { inputTokens: number; outputTokens: number };
  /** False when the provider's own stop reason makes an identical replay pointless. */
  replayable: boolean;
  /**
   * True when the turn stopped at the output limit. An identical replay is
   * pointless, but one replay carrying the length nudge is not.
   */
  lengthStopped: boolean;
}

export interface ProviderBlankTurnEvent extends BlankProviderTurnObservation {
  /** 1-based index of the attempt that came back empty. */
  attempt: number;
  /** True when this blank turn is about to be replayed and its output discarded. */
  replayed: boolean;
  options: StreamSimpleOptions;
}

export interface ProviderTurnRetryPolicy {
  /** Total provider attempts for one governed turn, including the first. */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Ceiling on the summed backoff across all retries of one governed turn. */
  maxTotalDelayMs: number;
  /**
   * `maxAttempts` and `maxTotalDelayMs` for a failure classed `throttled`. One
   * counter and one summed wait serve the whole turn; the failure being
   * decided picks which bound applies. Never below the general bounds.
   */
  maxThrottledAttempts: number;
  maxThrottledTotalDelayMs: number;
  /**
   * Provider attempts one governed turn may spend on empty turns, including the
   * one that ends it; the effective bound is the smaller of this and
   * `maxAttempts`. Kept below the transport bound because a replayed empty turn
   * is billed for its whole input context and charged to the lease.
   */
  maxBlankAttempts: number;
}

/**
 * Default policy, read from the `providerAttempt.*` limits through
 * `provider-attempt.ts` so `docsfab doctor --limits` reports the numbers applied
 * here. The measured route faults, 408 timeouts included, returned within
 * milliseconds, so for them the backoff is effectively the whole replay window.
 * The attempt deadline still bounds every wait.
 */
export const DEFAULT_PROVIDER_TURN_RETRY_POLICY: ProviderTurnRetryPolicy = Object.freeze({
  maxAttempts: providerAttemptLimit("maxAttemptsPerTurn"),
  baseDelayMs: providerAttemptLimit("baseDelayMs"),
  maxDelayMs: providerAttemptLimit("maxDelayMs"),
  maxTotalDelayMs: providerAttemptLimit("maxTotalDelayMs"),
  maxThrottledAttempts: providerAttemptLimit("maxThrottledAttemptsPerTurn"),
  maxThrottledTotalDelayMs: providerAttemptLimit("maxThrottledTotalDelayMs"),
  maxBlankAttempts: providerAttemptLimit("maxBlankAttemptsPerTurn"),
});

export interface ProviderTurnRetryEvent {
  /** 1-based index of the attempt that failed. */
  attempt: number;
  category: InferenceFailureCategory;
  delayMs: number;
  /** Stream options of the failed attempt, for host-side attribution. */
  options: StreamSimpleOptions;
  /** True when the replay carries the length nudge, so its payload digest differs. */
  nudged: boolean;
}

/** A replay about to wait out its backoff, for an operator-facing progress line. */
export interface ProviderTurnBackoffEvent {
  /** 1-based index of the attempt that failed. */
  attempt: number;
  /** The attempt bound that applies to this failure's category. */
  maxAttempts: number;
  category: InferenceFailureCategory;
  delayMs: number;
}

export interface ProviderPhysicalAttemptEvent {
  /** 1-based index of the physical request within this governed turn. */
  attempt: number;
  replay: boolean;
  options: StreamSimpleOptions;
}

export interface ProviderTurnReplayVetoEvent {
  /** 1-based index of the physical attempt whose replay was refused. */
  attempt: number;
  veto: ProviderTurnReplayVeto;
  options: StreamSimpleOptions;
}

export interface BoundedProviderTurnRetryOptions {
  policy?: Partial<ProviderTurnRetryPolicy>;
  /**
   * Absolute epoch-ms deadline for the whole inference attempt. A retry is not
   * scheduled when its backoff would cross the deadline.
   */
  deadlineAt?: () => number | undefined;
  now?: () => number;
  /** Must settle early when the signal aborts, or cancellation waits out the backoff. */
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  /**
   * Host veto consulted after a failed attempt; false ends the turn without a
   * replay. The provider library flattens every local refusal into one opaque
   * message, so only the host can tell a transport fault from its own policy stop.
   */
  isReplayable?: (options: StreamSimpleOptions) => boolean;
  /**
   * Server-requested wait (Retry-After) for the last failed attempt, in
   * milliseconds, when the host observed one. It can only lengthen the policy
   * wait, which `maxDelayMs` and the across-the-turn budget still bound.
   */
  retryAfterMs?: (options: StreamSimpleOptions) => number | undefined;
  /**
   * What the transport observed of the failed attempt: whether it was sent, and
   * a failing response's status. When present, the attempt is decided by the
   * closed provider-error class its telemetry records, before any message-text
   * rule; absent, the text classifier decides.
   */
  providerExchange?: () => ProviderExchangeObservation | undefined;
  /**
   * Physical provider requests the whole step attempt has left. False ends the
   * turn without a replay and records `step-physical-attempts-exhausted`;
   * absent means unbounded across turns. This stops replays only: the caller
   * enforces the allowance for a turn's first request through
   * `assertStepPhysicalAttemptsRemaining` before the governor admits the turn.
   */
  stepAttemptsRemaining?: () => boolean;
  /**
   * Called before every physical request of this governed turn, the first
   * included, so the step ledger has charged it before `stepAttemptsRemaining`
   * is consulted for the next. It counts requests issued to the delegate,
   * including ones DocsFab's own payload gate refuses; otherwise a step that
   * refuses every request would never reach its bound. The narrower "reached
   * the transport" count is `providerRetries + 1` on the turn ledger.
   */
  onPhysicalAttempt?: (event: ProviderPhysicalAttemptEvent) => void;
  /**
   * Called once when a failed or empty physical attempt is not replayed, naming
   * the first boundary that refused it.
   */
  onReplayVeto?: (event: ProviderTurnReplayVetoEvent) => void;
  onRetry?: (event: ProviderTurnRetryEvent) => void;
  /**
   * Called before the backoff of an authorized replay. `onRetry` fires after
   * the wait, so without this an operator watches a silent wait.
   */
  onBackoff?: (event: ProviderTurnBackoffEvent) => void;
  /**
   * Called for every empty provider turn, replayed or not, so the host can
   * charge its tokens and record it. A replayed blank turn never reaches Pi, so
   * this is the only place it is accounted for.
   */
  onBlankTurn?: (event: ProviderBlankTurnEvent) => void;
}

export function resolveProviderTurnRetryPolicy(
  policy?: Partial<ProviderTurnRetryPolicy>,
): ProviderTurnRetryPolicy {
  const resolved = {
    ...DEFAULT_PROVIDER_TURN_RETRY_POLICY,
    // A caller that narrows the general bounds narrows throttled replays with
    // them unless it names the throttled bounds too.
    ...(policy?.maxAttempts === undefined ? {} : { maxThrottledAttempts: policy.maxAttempts }),
    ...(policy?.maxTotalDelayMs === undefined
      ? {}
      : { maxThrottledTotalDelayMs: policy.maxTotalDelayMs }),
    ...policy,
  };
  for (const [name, value] of Object.entries(resolved)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`Provider turn retry ${name} must be a non-negative safe integer.`);
    }
  }
  if (resolved.maxAttempts < 1) {
    throw new Error("Provider turn retry maxAttempts must be at least 1.");
  }
  if (resolved.maxBlankAttempts < 1) {
    throw new Error("Provider turn retry maxBlankAttempts must be at least 1.");
  }
  if (resolved.maxDelayMs < resolved.baseDelayMs) {
    throw new Error("Provider turn retry maxDelayMs must not be below baseDelayMs.");
  }
  if (resolved.maxThrottledAttempts < resolved.maxAttempts) {
    throw new Error("Provider turn retry maxThrottledAttempts must not be below maxAttempts.");
  }
  if (resolved.maxThrottledTotalDelayMs < resolved.maxTotalDelayMs) {
    throw new Error(
      "Provider turn retry maxThrottledTotalDelayMs must not be below maxTotalDelayMs.",
    );
  }
  return Object.freeze(resolved);
}

/** Empty-turn attempts one governed turn may spend under `policy`; never above `maxAttempts`. */
export function effectiveBlankAttemptBound(policy: ProviderTurnRetryPolicy): number {
  return Math.min(policy.maxBlankAttempts, policy.maxAttempts);
}

/** Deterministic exponential backoff; no jitter, so evidence stays reproducible. */
export function providerTurnRetryDelayMs(policy: ProviderTurnRetryPolicy, attempt: number): number {
  const exponential = policy.baseDelayMs * 2 ** Math.max(0, attempt - 1);
  return Math.min(policy.maxDelayMs, Math.floor(exponential));
}

export interface ProviderTurnReplayProbe {
  /** True when the attempt forwarded a content event to the consumer. */
  committed: boolean;
  /** The classifier's verdict on the condition, with no policy mixed in. */
  conditionRetryable: boolean;
  /** Provider attempts left for this governed turn under `maxAttempts`. */
  attemptsRemaining: boolean;
  /** Physical requests left for the whole step attempt (`maxPhysicalRequestsPerStep`). */
  stepAttemptsRemaining: boolean;
  /** Empty-turn attempts left under the narrower `maxBlankAttempts` bound. */
  blankAttemptsRemaining: boolean;
  /**
   * Host veto: DocsFab itself refused this outbound request. Consulted before
   * `conditionRetryable` because there was no provider answer to classify; the
   * classifier would otherwise record DocsFab's own refusal text as
   * `condition-not-retryable`.
   */
  locallyDenied: () => boolean;
  /** The next backoff still fits the across-the-turn budget. */
  backoffBudgetRemaining: boolean;
  /** The next backoff still ends before the attempt deadline. Lazy: reads the clock. */
  withinDeadline: () => boolean;
  cancelled: () => boolean;
}

/**
 * Name the first stop that refuses a replay, or `undefined` when one is
 * authorized. `partial-stream` and `local-denial` lead because neither is about
 * a provider answer: the consumer already owns half a message, or the provider
 * never answered. The condition's verdict, the bounds, and the time-bounded
 * checks follow.
 */
export function describeProviderTurnReplayVeto(
  probe: ProviderTurnReplayProbe,
): ProviderTurnReplayVeto | undefined {
  if (probe.committed) return "partial-stream";
  if (probe.locallyDenied()) return "local-denial";
  if (!probe.conditionRetryable) return "condition-not-retryable";
  if (!probe.attemptsRemaining) return "attempts-exhausted";
  if (!probe.stepAttemptsRemaining) return "step-physical-attempts-exhausted";
  if (!probe.blankAttemptsRemaining) return "blank-attempts-exhausted";
  if (!probe.backoffBudgetRemaining) return "backoff-budget-exhausted";
  if (!probe.withinDeadline()) return "attempt-deadline";
  if (probe.cancelled()) return "cancelled";
  return undefined;
}

export function isRetryableProviderTurnFailure(errorMessage: unknown): {
  retryable: boolean;
  category: InferenceFailureCategory;
} {
  return replayableProviderTurnDisposition(classifyModelFailure(errorMessage));
}

function replayableProviderTurnDisposition(failure: {
  category: InferenceFailureCategory;
  retryable: boolean;
}): { retryable: boolean; category: InferenceFailureCategory } {
  return {
    retryable: failure.retryable && RETRYABLE_PROVIDER_TURN_CATEGORIES.includes(failure.category),
    category: failure.category,
  };
}

/**
 * Decide whether a turn that ended with an error event may be replayed, from the
 * typed provider-error class before any message text. A sent request is
 * classified as its telemetry records it (`observeLandedProviderTurn`) and
 * `providerErrorDisposition` decides, so content-filter, auth, invalid-request,
 * and status-less rate-limit errors are never replayed whatever the message
 * says. An unsent request or an `unknown` class keeps the text classifier's
 * verdict.
 */
export function providerTurnFailureDisposition(
  message: unknown,
  exchange: ProviderExchangeObservation | undefined,
): { retryable: boolean; category: InferenceFailureCategory } {
  const typed =
    message !== null && typeof message === "object"
      ? providerErrorDisposition(observeLandedProviderTurn(message, exchange).providerError)
      : undefined;
  if (typed) return replayableProviderTurnDisposition(typed);
  const errorMessage = (message as { errorMessage?: unknown } | null | undefined)?.errorMessage;
  return isRetryableProviderTurnFailure(
    typeof errorMessage === "string" && errorMessage.trim() ? errorMessage : "provider error",
  );
}

/**
 * Recognize an empty assistant turn: a stream that ended with `done`, not
 * `error`, carrying no tool call and no text or thinking content.
 *
 * Emptiness is decided conservatively: any tool call, non-empty text or
 * thinking, or unrecognized block makes the turn non-blank, because a turn
 * wrongly called blank is replayed and its content discarded. Whitespace-only
 * text is not blank even though the harness trims it: it streamed content
 * events, so it has already committed.
 */
export function observeBlankProviderTurn(
  event: ProviderEvent | undefined,
): BlankProviderTurnObservation | undefined {
  if (event?.type !== "done") return undefined;
  const message = (event as { message?: unknown }).message;
  if (!message || typeof message !== "object" || !blankAssistantContent(message)) return undefined;
  const record = message as {
    stopReason?: unknown;
    rawStopReason?: unknown;
    errorMessage?: unknown;
    usage?: { input?: unknown; output?: unknown };
  };
  const eventReason = (event as { reason?: unknown }).reason;
  const stopReason =
    typeof record.stopReason === "string"
      ? record.stopReason
      : typeof eventReason === "string"
        ? eventReason
        : "unknown";
  const rawStopReason =
    typeof record.rawStopReason === "string" && record.rawStopReason.trim()
      ? record.rawStopReason.trim()
      : undefined;
  const errorMessage =
    typeof record.errorMessage === "string" && record.errorMessage.trim()
      ? record.errorMessage.trim()
      : undefined;
  return {
    stopReason,
    ...(rawStopReason ? { rawStopReason } : {}),
    ...(errorMessage ? { errorMessage } : {}),
    usage: {
      inputTokens: tokenCount(record.usage?.input),
      outputTokens: tokenCount(record.usage?.output),
    },
    replayable:
      REPLAYABLE_BLANK_STOP_REASONS.has(stopReason) &&
      (rawStopReason === undefined || REPLAYABLE_BLANK_FINISH_REASONS.has(rawStopReason)) &&
      errorMessage === undefined,
    // A provider error body outranks the stop reason: `content_filter` and
    // friends arrive as text and are never a length verdict.
    lengthStopped: isLengthStop(stopReason, rawStopReason) && errorMessage === undefined,
  };
}

/** True when the stop metadata says the model ran out of output budget. */
export function isLengthStop(stopReason: unknown, rawStopReason?: unknown): boolean {
  return (
    (typeof stopReason === "string" && LENGTH_STOP_REASONS.has(stopReason)) ||
    (typeof rawStopReason === "string" && LENGTH_STOP_REASONS.has(rawStopReason.trim()))
  );
}

/** Human-readable provider stop metadata for a failure message. */
export function describeBlankProviderTurn(
  observation: Pick<BlankProviderTurnObservation, "stopReason" | "rawStopReason" | "errorMessage">,
): string {
  return [
    `stopReason=${observation.stopReason}`,
    `finish_reason=${observation.rawStopReason ?? "absent"}`,
    ...(observation.errorMessage ? [`provider-error=${observation.errorMessage}`] : []),
  ].join(" ");
}

/**
 * The one message appended to a length-stopped blank turn's replay: a fixed,
 * vendor-neutral template bounded by `LENGTH_STOP_NUDGE_MAX_CHARS`, so it never
 * carries model output. It names the authorized limit so the model does not
 * guess at the same size again.
 */
export function lengthStopNudgeText(outputTokenLimit: number): string {
  const limit =
    Number.isSafeInteger(outputTokenLimit) && outputTokenLimit > 0
      ? outputTokenLimit.toLocaleString("en-US")
      : "the configured";
  const text = [
    `Your previous response exceeded the output limit of ${limit} tokens (finish_reason=length) and none of it was delivered.`,
    "Respond again within that limit.",
    "Keep every tool call's arguments small: never place a whole document or report inside one tool argument; write large content in bounded pieces or summarize it.",
    `Make sure the complete terminal answer fits within ${limit} tokens.`,
  ].join(" ");
  if (text.length > LENGTH_STOP_NUDGE_MAX_CHARS) {
    throw new Error("The length-stop nudge exceeds its own fixed character bound."); // hygiene: ok
  }
  return text;
}

/**
 * Build the nudged replay context without mutating the original, so Pi's
 * conversation is unchanged and the nudge exists only in the one request.
 */
export function appendLengthStopNudge(
  context: StreamSimpleContext,
  outputTokenLimit: number,
  now: () => number = () => Date.now(),
): StreamSimpleContext {
  const messages = Array.isArray((context as { messages?: unknown }).messages)
    ? (context as { messages: unknown[] }).messages
    : [];
  return {
    ...context,
    messages: [
      ...messages,
      {
        role: "user",
        content: [{ type: "text", text: lengthStopNudgeText(outputTokenLimit) }],
        timestamp: now(),
      },
    ],
  } as StreamSimpleContext;
}

/**
 * The output limit the governed request was authorized with: the turn governor
 * writes it to `maxTokens`, and Pi's model record carries the profile ceiling
 * as the fallback for a stream that reached the wrapper without a governor.
 */
function authorizedOutputTokens(
  model: Parameters<StreamSimple>[0],
  streamOptions: StreamSimpleOptions,
): number {
  const requested = (streamOptions as { maxTokens?: unknown } | undefined)?.maxTokens;
  if (Number.isSafeInteger(requested) && Number(requested) > 0) return Number(requested);
  const modelMax = (model as { maxTokens?: unknown } | undefined)?.maxTokens;
  return Number.isSafeInteger(modelMax) && Number(modelMax) > 0 ? Number(modelMax) : 0;
}

function blankAssistantContent(message: object): boolean {
  const content = (message as { content?: unknown }).content;
  if (content === undefined || content === null) return true;
  if (!Array.isArray(content)) return false;
  return content.every((block) => {
    if (!block || typeof block !== "object") return false;
    const item = block as Record<string, unknown>;
    if (item.type === "text") return typeof item.text === "string" && item.text.length === 0;
    if (item.type === "thinking") {
      return typeof item.thinking === "string" && item.thinking.length === 0;
    }
    return false;
  });
}

function tokenCount(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
}

/**
 * Wrap a provider stream so one governed request survives a bounded number of
 * retryable failures.
 *
 * An attempt is held until it commits: the first event that is neither the
 * opener nor a terminal event. A held attempt has published nothing, so a
 * replay cannot leak partial content. After commit, events flow through and a
 * later failure is final, because half a message followed by a second message
 * is corruption. A `done` with no content event before it is an empty turn and
 * stays held, which is what makes replacing it safe.
 */
export function withBoundedProviderTurnRetry(
  delegate: StreamSimple,
  options: BoundedProviderTurnRetryOptions = {},
): StreamSimple {
  const policy = resolveProviderTurnRetryPolicy(options.policy);
  const blankAttemptBound = effectiveBlankAttemptBound(policy);
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? providerTurnBackoffSleep;
  return (model, context, streamOptions) => {
    // Announced before the request so the step ledger has counted it when the
    // next replay asks whether any remain, and even when the early return below
    // hands the delegate stream back.
    options.onPhysicalAttempt?.({ attempt: 1, replay: false, options: streamOptions });
    const first = delegate(model, context, streamOptions);
    const output = createSiblingStream(first);
    // The throttled bound is never below the general one, so it alone says
    // whether any replay is possible.
    if (!output || policy.maxThrottledAttempts < 2) return first;
    const sink = eventSink(output);
    void (async () => {
      let attemptStream = first;
      let held: ProviderEvent[] = [];
      let totalDelayMs = 0;
      let cancelled = false;
      let nudgedReplays = 0;
      let blankAttempts = 0;
      // The governed request until a nudge fires, then the nudged one: the
      // payload finalizer re-seals the turn to the nudged digest and would
      // refuse the original.
      let replayContext = context;
      try {
        for (let attempt = 1; ; attempt += 1) {
          const observed = await runAttempt(attemptStream, sink);
          // Partial-stream veto: the consumer already owns the stream, so a
          // replay would corrupt it.
          if (observed.committed) {
            // A committed attempt had its replay refused only if it then failed.
            if (isErrorEvent(observed.terminal)) {
              options.onReplayVeto?.({ attempt, veto: "partial-stream", options: streamOptions });
            }
            return;
          }
          // An attempt that produced no terminal event is not an outcome; the
          // last attempt that did terminate stays authoritative so the consumer
          // never receives a stream that ends without a result.
          if (isTerminalEvent(observed.terminal) || held.length === 0) held = observed.held;
          const blank = observeBlankProviderTurn(observed.terminal);
          if (blank) blankAttempts += 1;
          // A length-stopped blank turn gets one nudged replay, never an
          // identical one.
          const nudge =
            blank !== undefined &&
            !blank.replayable &&
            blank.lengthStopped &&
            nudgedReplays < MAX_LENGTH_STOP_NUDGED_REPLAYS;
          // A blank turn is charged and recorded even when nothing is replayed,
          // so the decision has to be complete before the callback fires.
          const disposition = blank
            ? { retryable: blank.replayable || nudge, category: "blank-response" as const }
            : isErrorEvent(observed.terminal)
              ? providerTurnFailureDisposition(
                  observed.terminal?.error,
                  options.providerExchange?.(),
                )
              : undefined;
          const delayMs =
            disposition === undefined
              ? 0
              : Math.min(
                  policy.maxDelayMs,
                  Math.max(
                    providerTurnRetryDelayMs(policy, attempt),
                    options.retryAfterMs?.(streamOptions) ?? 0,
                  ),
                );
          const deadlineAt = disposition === undefined ? undefined : options.deadlineAt?.();
          const throttled = disposition?.category === "throttled";
          const veto =
            disposition === undefined
              ? undefined
              : describeProviderTurnReplayVeto({
                  // A committed attempt returned above; the veto stays in the one
                  // function that names every stop so the rule cannot drift.
                  committed: false,
                  conditionRetryable: disposition.retryable,
                  attemptsRemaining:
                    attempt < (throttled ? policy.maxThrottledAttempts : policy.maxAttempts),
                  stepAttemptsRemaining: options.stepAttemptsRemaining?.() ?? true,
                  // Only empty turns count against the narrower blank bound.
                  blankAttemptsRemaining: blank === undefined || blankAttempts < blankAttemptBound,
                  locallyDenied: () => options.isReplayable?.(streamOptions) === false,
                  backoffBudgetRemaining:
                    totalDelayMs + delayMs <=
                    (throttled ? policy.maxThrottledTotalDelayMs : policy.maxTotalDelayMs),
                  withinDeadline: () => deadlineAt === undefined || now() + delayMs < deadlineAt,
                  cancelled: () => aborted(streamOptions),
                });
          const replay = disposition !== undefined && veto === undefined;
          if (!replay || !disposition) {
            // Only the wrapper knows which stop came first, so it records it.
            if (veto) options.onReplayVeto?.({ attempt, veto, options: streamOptions });
            if (blank) {
              options.onBlankTurn?.({
                ...blank,
                attempt,
                replayed: false,
                options: streamOptions,
              });
            }
            break;
          }
          totalDelayMs += delayMs;
          options.onBackoff?.({
            attempt,
            // A blank replay is bounded by the physical attempts and by the
            // blank attempts this turn has left, whichever ends first.
            maxAttempts: blank
              ? Math.min(policy.maxAttempts, attempt + blankAttemptBound - blankAttempts)
              : throttled
                ? policy.maxThrottledAttempts
                : policy.maxAttempts,
            category: disposition.category,
            delayMs,
          });
          await sleep(delayMs, abortSignal(streamOptions));
          if (aborted(streamOptions)) {
            if (blank) {
              // The provider request happened, but its replacement did not. Keep
              // the blank evidence without adding it to discarded replay usage:
              // the cancelled terminal message below still carries its tokens.
              options.onBlankTurn?.({
                ...blank,
                attempt,
                replayed: false,
                options: streamOptions,
              });
            }
            // The caller withdrew the authorized replay during the backoff,
            // after the veto check ran. Publishing the held provider error would
            // record the cancellation as a transient provider failure.
            options.onReplayVeto?.({ attempt, veto: "cancelled", options: streamOptions });
            cancelled = true;
            break;
          }
          options.onRetry?.({
            attempt,
            category: disposition.category,
            delayMs,
            options: streamOptions,
            nudged: nudge,
          });
          if (blank) {
            options.onBlankTurn?.({
              ...blank,
              attempt,
              replayed: true,
              options: streamOptions,
            });
          }
          if (nudge) {
            nudgedReplays += 1;
            replayContext = appendLengthStopNudge(
              context,
              authorizedOutputTokens(model, streamOptions),
              now,
            );
          }
          options.onPhysicalAttempt?.({
            attempt: attempt + 1,
            replay: true,
            options: streamOptions,
          });
          attemptStream = delegate(model, replayContext, streamOptions);
        }
      } catch {
        // A failure in the retry machinery itself must not strand the consumer:
        // publish the last observed outcome instead of hanging the stream.
      }
      for (const event of cancelled ? asCancelled(held) : held) sink.push(event);
      if (!isTerminalEvent(held.at(-1))) sink.end();
    })();
    return output;
  };
}

interface AttemptOutcome {
  /** True when events were forwarded downstream and no retry is possible. */
  committed: boolean;
  /** Events withheld from the consumer; empty once the attempt committed. */
  held: ProviderEvent[];
  terminal?: ProviderEvent;
}

async function runAttempt(
  stream: ProviderEventStream,
  sink: { push(event: ProviderEvent): void },
): Promise<AttemptOutcome> {
  const held: ProviderEvent[] = [];
  let committed = false;
  let terminal: ProviderEvent | undefined;
  try {
    for await (const event of stream as AsyncIterable<ProviderEvent>) {
      if (isTerminalEvent(event)) terminal = event;
      if (committed) {
        sink.push(event);
        continue;
      }
      held.push(event);
      // "start" alone commits nothing, and a terminal event -- an error, or a
      // `done` that carried no content event before it -- is still discardable.
      if (event.type === "start" || isTerminalEvent(event)) continue;
      for (const withheld of held) sink.push(withheld);
      held.length = 0;
      committed = true;
    }
  } catch {
    // A thrown stream is not replayable evidence; keep what was observed.
  }
  return { committed, held, ...(terminal ? { terminal } : {}) };
}

function eventSink(output: ProviderEventStream): {
  push(event: ProviderEvent): void;
  end(): void;
} {
  return output as unknown as { push(event: ProviderEvent): void; end(): void };
}

/**
 * Build an empty stream of the delegate's own class. Pi does not export
 * `AssistantMessageEventStream` and keeps its completion rules in that
 * constructor, so reusing it is the only way to stay behaviourally identical.
 */
function createSiblingStream(stream: ProviderEventStream): ProviderEventStream | undefined {
  try {
    const streamClass = (stream as { constructor?: unknown }).constructor as
      | (new () => ProviderEventStream)
      | undefined;
    if (typeof streamClass !== "function") return undefined;
    const sibling = new streamClass();
    return typeof (sibling as { push?: unknown }).push === "function" &&
      typeof (sibling as { end?: unknown }).end === "function"
      ? sibling
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Re-tag a held provider failure as an abort, the way Pi's own retry does.
 *
 * The consumer reads `stopReason` to decide a terminal disposition, so leaving
 * the provider's error in place records "cancelled during the backoff" as a
 * transient provider failure in the run record.
 */
function asCancelled(events: readonly ProviderEvent[]): ProviderEvent[] {
  return events.map((event) => {
    if (isErrorEvent(event)) {
      return {
        ...event,
        reason: "aborted",
        error: { ...(event.error as Record<string, unknown>), stopReason: "aborted" },
      };
    }
    if (event.type === "done") {
      const done = event as ProviderEvent & { message?: unknown };
      return {
        ...done,
        reason: "aborted",
        message: { ...(done.message as Record<string, unknown>), stopReason: "aborted" },
      };
    }
    return event;
  });
}

function isErrorEvent(event: ProviderEvent | undefined): boolean {
  return event?.type === "error";
}

function isTerminalEvent(event: ProviderEvent | undefined): boolean {
  return event?.type === "error" || event?.type === "done";
}

function abortSignal(streamOptions: StreamSimpleOptions): AbortSignal | undefined {
  return (streamOptions as { signal?: AbortSignal } | undefined)?.signal;
}

function aborted(streamOptions: StreamSimpleOptions): boolean {
  return abortSignal(streamOptions)?.aborted === true;
}

/**
 * Wait out the backoff, settling as soon as the caller cancels. Not unref'd:
 * the backoff is part of an in-flight attempt, and exiting mid-backoff would
 * lose the turn.
 */
export function providerTurnBackoffSleep(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const settle = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", settle);
      resolve();
    };
    const timer = setTimeout(settle, milliseconds);
    signal?.addEventListener("abort", settle, { once: true });
  });
}
