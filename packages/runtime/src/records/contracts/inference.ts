// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Inference attempts, provider evidence, retry, answer, and tool-call contracts.

import type { InferenceRejectedReplyExcerptV1 } from "../../execution/rejected-reply-excerpt.js";
import type { InferenceRejectedReplyShapeV1 } from "../../execution/rejected-reply-shape.js";
import type {
  ExecutionLeaseRuntimeEvidenceV1,
  InferenceRejectionReasonV1,
} from "../../execution/contracts.js";
import type { ModelEvidence, SkillEvidence } from "./model-skill-quality.js";
import type { TokenUsage, ToolActivitySummary } from "./tool-activity.js";

export type InferenceFailureCategory =
  | "blank-response"
  | "malformed-response"
  | "context-exhausted"
  | "timeout"
  | "throttled"
  | "provider-transient"
  | "invalid-request"
  | "provider-terminal"
  | "host-runtime-failure"
  | "no-progress";

/** Typed, content-free origin for host failures during inference execution. */
export interface InferenceHostFailureOriginV1 {
  readonly schemaVersion: 1;
  readonly origin: "execution-lease-coordinator";
  readonly code: "invalid-execution-lease-coordinator";
}
export interface InferenceEvidenceIdentity {
  repositoryRevision: string;
  contextPacketDigest?: string;
  consultedNodeIds?: string[];
  /**
   * Search evidence this step ran against, observed or inherited. Present only
   * when the step joins a search plan, so non-search identity digests are unchanged.
   */
  searchEvidenceSha256?: string;
  /** Digest of the admitted technical result supplied to the evaluator. */
  technicalVerificationSha256?: string;
  /** Whole provisional candidate set bound to this execution lease and attempt. */
  provisionalRichCandidateSha256?: string;
  /** Digest of the host-derived CREATE V3 phase/candidate invocation identity. */
  authoringPhaseSha256?: string;
}
export type InferenceTurnDecision = "proceed" | "compact" | "stop";
export type InferenceTurnReason =
  | "context-exhausted"
  | "provider-turn-limit"
  | "tool-call-limit"
  | "compaction-limit"
  | "compaction-ineffective"
  | "evidence-preservation-required"
  | "output-authority-exhausted";
/**
 * The lease's cumulative output-token authority as it bound one governed turn.
 *
 * Present only when the remainder (`maxOutputTokens - cumulativeOutputTokens`)
 * was below what the turn would have requested: the request was clamped to it,
 * or it fell below `floorOutputTokens` and the turn stopped with
 * `output-authority-exhausted`.
 */
export interface InferenceOutputAuthorityEvidence {
  /** Cumulative output tokens the lease may spend across the whole attempt. */
  maxOutputTokens: number;
  /** Output tokens already charged when this turn was governed. */
  cumulativeOutputTokens: number;
  /** Smallest remainder worth a provider turn; always above `requiredMinimumOutputTokens`. */
  floorOutputTokens: number;
}
export interface InferenceCompactionEvidence {
  beforeRequestDigest: string;
  afterRequestDigest: string;
  estimatedInputTokensBefore: number;
  estimatedInputTokensAfter: number;
  removedMessages: number;
  retainedMessages: number;
  preservedCitationCount: number;
  preservedCitationDigest: string;
}
export interface InferenceTurnEvidence {
  contextBudgetSchemaVersion?: 2;
  /** Explicitly absent aggregate provider-turn/tool-call/compaction ceilings. */
  aggregatePolicy?: { kind: "absent" };
  /** Absent on historical host-window evidence; explicit when the provider admits context. */
  contextAdmission?: "provider";
  turn: number;
  toolCalls: number;
  toolResults: number;
  /** SDK-rejected calls on this final turn before host preflight, only on a terminal submission refusal. */
  terminalPreExecutionRejections?: number;
  maxProviderTurns?: number;
  maxToolCalls?: number;
  compactions: number;
  maxCompactions?: number;
  configuredContextWindow: number;
  effectiveContextWindow: number;
  configuredMaxInputTokens?: number;
  effectiveMaxInputTokens?: number;
  configuredMaxOutputTokens: number;
  effectiveMaxOutputTokens: number;
  reservedTokens: number;
  estimatedInputTokens: number;
  availableInputTokens?: number;
  availableOutputTokens: number;
  requiredMinimumOutputTokens: number;
  requestedOutputTokens?: number;
  /**
   * Tokens actually produced on this governed turn, including discarded
   * in-turn replay output, so with `providerRetries` it may exceed one
   * request's grant. Not a permitted maximum. Absent on a stop and when
   * production is unknown; never substitute the grant for missing usage. Older
   * records may store the grant here.
   */
  outputTokens?: number;
  /**
   * Provider `finish_reason`, copied only when it is a closed token
   * (`/^[a-z][a-z0-9_]{0,31}$/`). Absence means unavailable.
   */
  rawStopReason?: string;
  /** Present only on a turn the lease's cumulative output authority clamped or stopped. */
  outputAuthority?: InferenceOutputAuthorityEvidence;
  decision: InferenceTurnDecision;
  reason?: InferenceTurnReason;
  requestDigest: string;
  /** Distinguishes finalized provider-payload evidence from legacy turn records. */
  providerPayloadSchemaVersion?: 1;
  /** Present only after Pi's final provider payload hook succeeds. */
  requestPolicySha256?: string;
  /**
   * Digest of the exact credential-safe payload authorized for transport. After
   * the one nudged replay, this is the nudged payload, not the first attempt's.
   */
  finalPayloadSha256?: string;
  /**
   * In-turn provider retries; absent means zero. Every retry replays the exact
   * payload except the single nudged replay for a blank turn stopped at the
   * output limit, which appends one user message and moves `finalPayloadSha256`.
   */
  providerRetries?: number;
  /**
   * Empty provider turns, including the one that ended the turn; absent means
   * zero. Never exceeds `providerRetries + 1`.
   */
  providerBlankTurns?: number;
  /**
   * Why the in-turn replay stopped. Written only when a failed or empty
   * physical attempt was not replayed; absence means no replay was refused.
   */
  providerReplayVeto?: ProviderTurnReplayVeto;
  /**
   * Assistant messages whose replayed reasoning the installed request policy
   * omitted from the payload `finalPayloadSha256` digests. Absent means none;
   * written only with that digest.
   */
  replayedReasoningOmitted?: number;
  /**
   * The installed request policy's closed reason for refusing this turn's
   * payload (`model/request-policy-refusals.ts`). Without
   * `finalPayloadSha256` no request was sent; with it, a replay was refused.
   */
  requestPolicyRefusal?: import("../../model/request-policy-refusals.js").RequestPolicyRefusal;
  evidenceDigest: string;
  compaction?: InferenceCompactionEvidence;
}
/**
 * Why a failed physical provider attempt was not replayed, in the order
 * `model/provider-turn-retry.ts` decides it. Not failure categories.
 *
 * `partial-stream` and `local-denial` veto a condition the classifier calls
 * retryable: replaying after published content would corrupt the message, and
 * a request DocsFab refused would be refused identically. Do not collapse them
 * into `condition-not-retryable`.
 */
export type ProviderTurnReplayVeto =
  | "partial-stream"
  | "condition-not-retryable"
  | "attempts-exhausted"
  | "step-physical-attempts-exhausted"
  | "blank-attempts-exhausted"
  | "local-denial"
  | "backoff-budget-exhausted"
  | "attempt-deadline"
  | "cancelled";
/**
 * Whether the failure condition can be retried at all under the retry
 * taxonomy, with no policy opinion mixed in. Derived from the recorded outcome
 * alone, so a host refusal stamped onto `retryable` cannot make an eligible
 * condition look terminal. `not-applicable` means a succeeded attempt.
 */
export type InferenceConditionRetryability = "eligible" | "not-eligible" | "not-applicable";
/**
 * What the run's retry policy did about that condition.
 *
 * - `retried`: matches `retryScheduled`.
 * - `declined`: eligible, but outside the effective retryable set, on a
 *   write-capable step, or refused by the host; retries may have remained.
 * - `exhausted`: eligible and would have retried, but the budget was spent.
 * - `not-applicable`: no retryable condition to decide about.
 */
export type InferenceRetryDecision = "retried" | "declined" | "exhausted" | "not-applicable";
/**
 * The host's classification of a failed structured answer or timeout, for the
 * retry rules it has its own budget or feedback for. Recorded beside `outcome`.
 *
 * - `unframed-reply`: a prose, array, or empty reply to a JSON contract.
 * - `cut-answer`: an answer cut at the output limit with no continuation left,
 *   or an answer completed by continuation and then refused.
 * - `attempt-deadline`: the host's own attempt timer fired.
 * - `provider-timeout`: any other `timeout`.
 * - `tool-call-ceiling`: a `no-progress` stop at the step's hard tool-call
 *   ceiling, after the settled tool turn that reached it.
 */
export type InferenceFailureCondition =
  | "unframed-reply"
  | "cut-answer"
  | "attempt-deadline"
  | "provider-timeout"
  | "tool-call-ceiling";
/**
 * How a provider turn finished, normalized across transports. `unknown` is a
 * token DocsFab does not recognize; the raw token is never copied here.
 */
export type ModelFinishReason =
  | "stop"
  | "length"
  | "tool-use"
  | "content-filter"
  | "error"
  | "aborted"
  | "unknown";
/**
 * Class of a provider error that ended an attempt; the telemetry never carries
 * its text. `stream-incomplete` is a 2xx chat-completions stream that closed
 * cleanly before any finish reason or `[DONE]`.
 */
export type ProviderErrorClass =
  | "rate-limit"
  | "auth"
  | "server"
  | "timeout"
  | "content-filter"
  | "network"
  | "stream-incomplete"
  | "invalid-request"
  | "unknown";
export interface ProviderErrorTelemetryV1 {
  readonly class: ProviderErrorClass;
  readonly httpStatus?: number;
  /** The response's `Retry-After`, in milliseconds, when usable. */
  readonly retryAfterMs?: number;
  /**
   * The failing status a structured error event inside a 2xx stream declared.
   * Never recorded with `httpStatus`, and never a transport status.
   */
  readonly streamErrorStatus?: number;
}
export interface InferenceAttemptModelTelemetryV1 {
  readonly schemaVersion: 1;
  /** How the last landed provider turn finished. Absent when no turn landed. */
  readonly finishReason?: ModelFinishReason;
  /** Output tokens that turn produced, when the provider reported usage. */
  readonly outputTokens?: number;
  /** The per-request output allowance that turn was sent with. */
  readonly outputAllowance?: number;
  /** Milliseconds from each provider turn's start to its assistant message, summed. */
  readonly providerLatencyMs: number;
  /** Present only when the last landed provider turn was a provider error. */
  readonly providerError?: ProviderErrorTelemetryV1;
}
/**
 * The closed match metadata an older host wrote on a `host-path-disclosure`
 * refusal: a root segment or form name and whether the token was in admitted
 * source, never the path. No current step writes it; readers keep accepting it
 * so those records still decode.
 */
export interface LegacyHostPathDisclosureV1 {
  readonly root: LegacyHostPathMatchRoot;
  readonly inAdmittedSource: LegacyHostPathSourceReading;
}

export const LEGACY_HOST_PATH_MATCH_ROOTS = Object.freeze([
  "Applications",
  "Library",
  "Network",
  "System",
  "Users",
  "Volumes",
  "bin",
  "boot",
  "cores",
  "dev",
  "etc",
  "home",
  "lib",
  "lib32",
  "lib64",
  "libexec",
  "media",
  "mnt",
  "net",
  "opt",
  "private",
  "proc",
  "root",
  "run",
  "sbin",
  "srv",
  "sys",
  "tmp",
  "usr",
  "var",
  "file-uri",
  "windows-drive",
  "windows-separator",
  "home-tilde",
] as const);

export type LegacyHostPathMatchRoot = (typeof LEGACY_HOST_PATH_MATCH_ROOTS)[number];

export const LEGACY_HOST_PATH_SOURCE_READINGS = Object.freeze(["no", "unavailable"] as const);

export type LegacyHostPathSourceReading = (typeof LEGACY_HOST_PATH_SOURCE_READINGS)[number];

/** Exactly the two closed members of {@link LegacyHostPathDisclosureV1}. */
export function isLegacyHostPathDisclosure(value: unknown): value is LegacyHostPathDisclosureV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes("root") || !keys.includes("inAdmittedSource")) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    (LEGACY_HOST_PATH_MATCH_ROOTS as readonly unknown[]).includes(candidate.root) &&
    (LEGACY_HOST_PATH_SOURCE_READINGS as readonly unknown[]).includes(candidate.inAdmittedSource)
  );
}

export interface InferenceAttemptEvidence {
  attempt: number;
  outcome: "succeeded" | InferenceFailureCategory;
  /** Required exactly for `host-runtime-failure`; never provider telemetry. */
  hostFailureOrigin?: InferenceHostFailureOriginV1;
  /**
   * The harness's own failure flag, which may already carry a host refusal.
   * Read `conditionRetryability` and `retryDecision` instead.
   */
  retryable: boolean;
  retryScheduled: boolean;
  /**
   * Host-side, attempt-wide write-tool settlement reading. `no-write` is
   * emitted only when every authorized tool call is accounted for and no
   * filesystem mutator ran. Missing or incomplete settlement evidence is
   * `unavailable`, never permission to replay.
   */
  writeSettlement?: "no-write" | "write-executed" | "unavailable";
  /**
   * Written together with `retryDecision` or not at all. Absence on older
   * records means unavailable, never a value; see
   * `readInferenceRetryDisposition`.
   */
  conditionRetryability?: InferenceConditionRetryability;
  /** See `conditionRetryability` for pairing and absence. */
  retryDecision?: InferenceRetryDecision;
  /**
   * The catalog retry rule that made `retryDecision` (config/model-output/
   * retry-policy.yaml). Written on every attempt when the execution records
   * `conditionRetry`; absent on older records, whose decision token is derived.
   */
  retryRule?: import("../../contracts/model-output.generated.js").RetryRuleId;
  /** The failure condition the retry rule read; absent when there was none. */
  condition?: InferenceFailureCondition;
  /**
   * UTF-8 byte length of the reply span the step's decoder admitted. Written
   * only on a succeeded attempt whose harness decoded a structured reply.
   */
  answerBytes?: number;
  /**
   * The governed turn after which the host withdrew the tools and asked for
   * the answer, and what triggered it. Written on the attempt whether its
   * forced answer was admitted or refused.
   */
  concludeNow?: InferenceConcludeNowEvidenceV1;
  /** Where the host's attempt timer found the attempt; only with condition `attempt-deadline`. */
  deadlineTurn?: InferenceDeadlineTurn;
  /**
   * The final quality evaluator's answer path, and on the tool path the
   * submission and report states. Written on every attempt of that
   * step; absent on every other step and on older records.
   */
  answerSubmission?: InferenceAnswerSubmissionEvidenceV1;
  /**
   * Which host-owned validation refused the response and where it lives in the
   * response contract, since `outcome` alone cannot tell two
   * `malformed-response` defects apart. Absent when the failure carried no
   * coded reason. Content-free: drawn from the decoder's frozen vocabulary.
   */
  rejection?: InferenceRejectionReasonV1;
  /**
   * Structural fingerprint of the rejected reply: whether and where parsing
   * stopped, top-level keys, and type and length per key path. Never reply
   * text. Written only on a `malformed-response` attempt whose harness saw the
   * reply.
   */
  rejectedReplyShape?: InferenceRejectedReplyShapeV1;
  /**
   * Bounded, redacted head, tail, and parse-position text of the same reply.
   * Written with `rejectedReplyShape`; see `rejected-reply-excerpt.ts`.
   */
  rejectedReplyExcerpt?: InferenceRejectedReplyExcerptV1;
  /**
   * What the refused rule refused, beside `rejection`: a cited source path or
   * a revision's declared and observed changed paths, each only a path the
   * host knows, or withheld. Never reply text; see `rejection-subject.ts`.
   */
  rejectionSubject?: import("../../execution/rejection-subject.js").InferenceRejectionSubjectV1;
  /** Written only by older hosts; see {@link LegacyHostPathDisclosureV1}. */
  hostPathDisclosure?: LegacyHostPathDisclosureV1;
  /**
   * On an accepted judgment reply only, how many undeclared keys each judgment
   * row type carried. Names appear only for keys another response contract
   * declares; never reply text.
   */
  judgmentRowKeyAudit?: import("../../execution/judgment-row-key-audit-contract.js").JudgmentRowKeyAuditV1;
  /**
   * The provider's account of this attempt; closed enumerations and integers
   * only. Written on every Pi harness attempt; absence means unavailable.
   */
  modelTelemetry?: InferenceAttemptModelTelemetryV1;
  /** Content-free byte counts for physical provider response bodies; optional on older records. */
  providerResponses?: ProviderResponseEvidenceV1;
  /** Optional content-free, physical request and source-reuse measurements. */
  efficiency?: InferenceEfficiencyEvidenceV1;
  durationMs: number;
  backoffMs?: number;
  model?: ModelEvidence;
  usage?: TokenUsage;
  tools?: ToolActivitySummary;
  identity?: InferenceEvidenceIdentity;
  turns?: InferenceTurnEvidence[];
  executionLease?: ExecutionLeaseRuntimeEvidenceV1;
}

export interface ProviderResponseObservationV1 {
  requestSequence: number;
  disposition:
    | "complete"
    | "no-body"
    | "cancelled"
    | "read-error"
    | "limit-refused"
    | "no-response";
  /** Bytes observed from stream chunks (never Content-Length); may be partial on non-complete outcomes. */
  observedBytes: number;
  httpStatus?: number;
  /** Present only for an opted-in public task observer; hashes observed stream bytes. */
  bodySha256?: string;
}

/** Versioned runtime-dispatch diagnostics; external fetch wrappers may retry a send. */
export interface InferenceEfficiencyEvidenceV1 {
  schemaVersion: 1;
  /** Null means the connection exposed no request observer; [] means observed no sends. */
  requests:
    | {
        requestSequence: number;
        /** Null is an ungoverned request; a number identifies a governed turn. */
        turn: number | null;
        /** Null only when the dispatched body was not a readable string at the boundary. */
        bodyBytes: number | null;
        bodySha256: string | null;
      }[]
    | null;
  /** Null means reuse was disabled or unavailable; zero means enabled with no activity. */
  sourceReuse: SourceReuseCountersV1 | null;
}

export interface SourceReuseCountersV1 {
  hits: number;
  misses: number;
  seededRanges: number;
  refusals: number;
  invalidations: { authorityChange: number; sourceChange: number; snapshotChange: number };
  rangeMismatches: number;
}

export function isInferenceEfficiencyEvidenceV1(
  value: unknown,
): value is InferenceEfficiencyEvidenceV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (
    Object.keys(item).sort().join() !== "requests,schemaVersion,sourceReuse" ||
    item.schemaVersion !== 1 ||
    (item.requests !== null && !Array.isArray(item.requests))
  )
    return false;
  let previous = 0;
  for (const request of item.requests ?? []) {
    if (!request || typeof request !== "object" || Array.isArray(request)) return false;
    const row = request as Record<string, unknown>;
    if (
      Object.keys(row).sort().join() !== "bodyBytes,bodySha256,requestSequence,turn" ||
      !Number.isSafeInteger(row.requestSequence) ||
      (row.requestSequence as number) <= previous ||
      (row.turn !== null && (!Number.isSafeInteger(row.turn) || (row.turn as number) < 1)) ||
      !(
        (row.bodyBytes === null && row.bodySha256 === null) ||
        (Number.isSafeInteger(row.bodyBytes) &&
          (row.bodyBytes as number) >= 0 &&
          typeof row.bodySha256 === "string" &&
          /^[a-f0-9]{64}$/u.test(row.bodySha256))
      )
    )
      return false;
    previous = row.requestSequence as number;
  }
  return item.sourceReuse === null || isSourceReuseCountersV1(item.sourceReuse);
}

export function isSourceReuseCountersV1(reuse: unknown): reuse is SourceReuseCountersV1 {
  if (!reuse || typeof reuse !== "object" || Array.isArray(reuse)) return false;
  const stats = reuse as Record<string, unknown>;
  if (
    Object.keys(stats).sort().join() !==
    "hits,invalidations,misses,rangeMismatches,refusals,seededRanges"
  )
    return false;
  if (
    !["hits", "misses", "seededRanges", "refusals", "rangeMismatches"].every(
      (key) => Number.isSafeInteger(stats[key]) && (stats[key] as number) >= 0,
    )
  )
    return false;
  const invalidations = stats.invalidations;
  if (!invalidations || typeof invalidations !== "object" || Array.isArray(invalidations))
    return false;
  const reasons = invalidations as Record<string, unknown>;
  return (
    Object.keys(reasons).sort().join() === "authorityChange,snapshotChange,sourceChange" &&
    ["authorityChange", "sourceChange", "snapshotChange"].every(
      (key) => Number.isSafeInteger(reasons[key]) && (reasons[key] as number) >= 0,
    )
  );
}

export interface ProviderResponseEvidenceV1 {
  schemaVersion: 1;
  /** `pending` means one or more sent requests had no terminal body outcome at snapshot time. */
  state: "complete" | "pending";
  observations: ProviderResponseObservationV1[];
  pendingRequestSequences: number[];
}

/** Exact, content-free v1 provider response observation contract. */
export function isProviderResponseEvidenceV1(value: unknown): value is ProviderResponseEvidenceV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const evidence = value as Record<string, unknown>;
  if (
    Object.keys(evidence).length !== 4 ||
    !["schemaVersion", "state", "observations", "pendingRequestSequences"].every((key) =>
      Object.hasOwn(evidence, key),
    ) ||
    evidence.schemaVersion !== 1 ||
    (evidence.state !== "complete" && evidence.state !== "pending") ||
    !Array.isArray(evidence.observations) ||
    !Array.isArray(evidence.pendingRequestSequences)
  )
    return false;

  const observations = evidence.observations as unknown[];
  const pending = evidence.pendingRequestSequences as unknown[];
  let previous = 0;
  const seen = new Set<number>();
  for (const item of observations) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const observation = item as Record<string, unknown>;
    const keys = Object.keys(observation);
    if (
      keys.some(
        (key) => !["requestSequence", "disposition", "observedBytes", "httpStatus"].includes(key),
      ) ||
      !["requestSequence", "disposition", "observedBytes"].every((key) =>
        Object.hasOwn(observation, key),
      ) ||
      !Number.isSafeInteger(observation.requestSequence) ||
      (observation.requestSequence as number) <= previous ||
      seen.has(observation.requestSequence as number) ||
      typeof observation.disposition !== "string" ||
      !["complete", "no-body", "cancelled", "read-error", "limit-refused", "no-response"].includes(
        observation.disposition,
      ) ||
      !Number.isSafeInteger(observation.observedBytes) ||
      (observation.observedBytes as number) < 0 ||
      (observation.httpStatus !== undefined &&
        (!Number.isSafeInteger(observation.httpStatus) ||
          (observation.httpStatus as number) < 100 ||
          (observation.httpStatus as number) > 599))
    )
      return false;
    if (
      (observation.disposition === "no-response" &&
        (observation.observedBytes !== 0 || observation.httpStatus !== undefined)) ||
      (observation.disposition !== "no-response" && observation.httpStatus === undefined) ||
      (observation.disposition === "no-body" && observation.observedBytes !== 0)
    )
      return false;
    previous = observation.requestSequence as number;
    seen.add(previous);
  }
  previous = 0;
  for (const sequence of pending) {
    if (
      !Number.isSafeInteger(sequence) ||
      (sequence as number) <= previous ||
      seen.has(sequence as number)
    )
      return false;
    previous = sequence as number;
    seen.add(previous);
  }
  return (evidence.state === "complete") === (pending.length === 0);
}
export interface InferenceExecutionEvidence {
  configuredMaxRetries: number;
  effectiveMaxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  retryableCategories: InferenceFailureCategory[];
  /**
   * `reset-write-step`: the host restores the workspace before every retry, so
   * the write step may replay a retryable malformed reply.
   */
  replay: "read-only" | "disabled-write-step" | "reset-write-step";
  attempts: InferenceAttemptEvidence[];
  /** Provenance of `configuredMaxRetries` when the parsed policy retained it. */
  maxRetriesSource?: "config/limits.yaml" | "host" | "project";
  /**
   * The transport budget the step applied. Present: an attempt whose outcome is
   * in `categories` was judged against this budget, not `effectiveMaxRetries`.
   * Absent: every attempt shared `effectiveMaxRetries`, as older records did.
   */
  transportRetry?: InferenceTransportRetryEvidence;
  /**
   * The condition budgets the step applied, each a subset of
   * `effectiveMaxRetries`. Present: every attempt records `retryRule`.
   */
  conditionRetry?: InferenceConditionRetryEvidence;
}
export interface InferenceConditionRetryEvidence {
  /** Applied `retry.maxTimeoutRetries`. */
  maxTimeoutRetries: number;
  /** Applied `retry.maxCutAnswerRetries`. */
  maxCutAnswerRetries: number;
  /** Applied `retry.maxNoProgressRetries`; absent on records written before that budget. */
  maxNoProgressRetries?: number;
}
/**
 * Why the host withdrew the tools and asked for the answer inside an attempt:
 *
 * - `read-loop`: on a conclude-now retry, the read-evidence ledger withheld an
 *   unchanged re-read.
 * - `reading-budget`: a judgment step spent its answer-now reading budget.
 * - `attempt-deadline`: a read-only step was still calling tools once only its
 *   answer reserve remained before the attempt timer.
 */
export type InferenceConcludeNowTrigger = "read-loop" | "reading-budget" | "attempt-deadline";
/**
 * Where the host's attempt timer found the attempt when it fired:
 *
 * - `awaiting-first-byte`: a provider request was sent and no byte of its
 *   response had arrived.
 * - `streaming-answer`: the provider was streaming answer text.
 * - `streaming-tool-call`: the provider was streaming tool calls.
 * - `streaming`: the provider was streaming, with no answer text or tool call
 *   yet, for example reasoning.
 * - `between-requests`: no provider request was in flight, for example while
 *   the turn's tools ran.
 */
export type InferenceDeadlineTurn =
  | "awaiting-first-byte"
  | "streaming-answer"
  | "streaming-tool-call"
  | "streaming"
  | "between-requests";
export interface InferenceConcludeNowEvidenceV1 {
  trigger: InferenceConcludeNowTrigger;
  /** The governed provider turn the answer was asked for after; 1-based. */
  turn: number;
}
/** How the final quality evaluator's answer reached the host. */
export type InferenceAnswerPath = "text-final" | "tool-call" | "answer-records";
/**
 * Why the answer took its path: the route recorded the capability, it did
 * not, a host tool ceiling withholds the submission tool, the operator set
 * `DOCSFAB_ANSWER_SUBMISSION=text-final`, or the host admitted an answer-record
 * ledger.
 */
export type InferenceAnswerPathReason =
  | "recorded-route"
  | "not-recorded"
  | "tool-not-granted"
  | "operator-override"
  | "record-ledger";
/**
 * The submission call's state when the attempt ended. `in-flight`: the
 * attempt ended while a submission call's arguments were streaming, before
 * its turn settled. `not-decoded-at-ceiling`: the call was on the turn that
 * reached the hard tool-call ceiling, so it was never decoded.
 * `not-applicable` is used when answer records, rather than one submission
 * call, carry the answer.
 */
export type InferenceAnswerSubmissionState =
  | "absent"
  | "in-flight"
  | "admitted"
  | "refused"
  | "not-decoded-at-ceiling"
  | "not-applicable";
/**
 * The report turn's state when the attempt ended. `in-flight`: the report was
 * asked for and the attempt ended before the report turn, or its
 * continuation, settled. `clamped`: the report was admitted, but cumulative
 * output authority narrowed a report turn's allowance. `authority-stopped`:
 * cumulative output authority refused a report turn.
 */
export type InferenceAnswerReportTurnState =
  | "not-asked"
  | "in-flight"
  | "admitted"
  | "refused"
  | "clamped"
  | "authority-stopped";
/**
 * The answer path of one final quality evaluator attempt and, when applicable,
 * the state of its submission and report. The answer-record path has no
 * singular submission. Byte counts are raw text captured by the host for an
 * `in-flight` state, so a deadline can be attributed without provider usage,
 * which an aborted stream often lacks.
 */
export interface InferenceAnswerSubmissionEvidenceV1 {
  path: InferenceAnswerPath;
  reason: InferenceAnswerPathReason;
  submission: InferenceAnswerSubmissionState;
  reportTurn: InferenceAnswerReportTurnState;
  /** Present only with `submission: in-flight`. */
  submissionInFlightBytes?: number;
  /** Present only with `reportTurn: in-flight`. */
  reportInFlightBytes?: number;
  /**
   * Present only with `submission: admitted`: whether each member arrived as
   * its JSON value or as one JSON string holding it (#1707). `string` covers a
   * `qualityScore` string that decoded to `null`.
   */
  memberEncoding?: InferenceAnswerMemberEncodingV1;
  /**
   * Present exactly when `memberEncoding` names a `string` member: the UTF-8
   * bytes of the decoded member strings, for diagnosis. Bounds apply to the
   * raw outer bytes, which are never fewer.
   */
  submissionInnerBytes?: number;
}
export interface InferenceAnswerMemberEncodingV1 {
  evaluation: "object" | "string";
  qualityScore: "object" | "null" | "string";
}
export interface InferenceTransportRetryEvidence {
  maxRetries: number;
  maxDelayMs: number;
  maxElapsedMs: number;
  /** Non-empty, duplicate-free subset of the transport categories the step retried. */
  categories: InferenceFailureCategory[];
}
export interface EvaluateStepEvidenceV1 {
  schemaVersion: 1;
  kind: "docsfab-evaluate-step-evidence";
  evaluatorIdentitySha256: string;
  toolPolicySha256: string;
  acceptancePolicySha256: string;
}
export interface SearchParticipationRecord {
  schemaVersion: 1;
  kind: "docsfab-step-search-participation";
  planId: string;
  searchMode: import("../../workflow-contracts/contracts.js").SearchMode;
  /** The step whose `observe` produced the evidence. Self for an observer. */
  observedByStepId: string;
  searchEvidenceSha256: string;
  workspaceSnapshotSha256: string;
}
