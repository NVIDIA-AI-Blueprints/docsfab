// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Operator reading of the recorded condition/decision pair: whether a failure
 * condition is retryable, and what the run's policy did about it. This module
 * renders and decides nothing. Every value comes from decoded record fields,
 * never from an error message and never reconstructed from the conflated
 * `retryable` / `retryScheduled` flags.
 */
import { isRetainableInferenceRejection } from "../config/inference-rejection-limits.js";
import type { InferenceRejectionReasonV1 } from "../execution/contracts.js";
import {
  isRejectedReplyExcerptOf,
  projectRejectedReplyExcerpt,
  rejectedReplyExcerptDisplayRoots,
  type InferenceRejectedReplyExcerptV1,
} from "../execution/rejected-reply-excerpt.js";
import type { HostRootSet } from "../security/egress.js";
import {
  canonicalizeRejectedReplyShape,
  isInferenceRejectedReplyShape,
  type InferenceRejectedReplyShapeV1,
} from "../execution/rejected-reply-shape.js";
import { isDeclaredResponseContractKey } from "../execution/response-contract-vocabulary.js";
import {
  INFERENCE_ATTEMPT_SUCCESS_OUTCOME,
  isInferenceAttemptOutcome,
  isInferenceFailureCategory,
} from "../inference-attempt-taxonomy.js";
import type {
  InferenceAttemptEvidence,
  InferenceConditionRetryability,
  InferenceExecutionEvidence,
  InferenceFailureCategory,
  InferenceRetryDecision,
  ProviderTurnReplayVeto,
  RunRecord,
} from "../records/contracts.js";
import {
  INFERENCE_RETRY_DISPOSITION_UNAVAILABLE,
  inferenceAttemptBudgetPositions,
  isInferenceTransportRetryEvidence,
  isProviderTurnReplayVeto,
  readInferenceRetryDisposition,
  remainingRetryBudget,
  type InferenceAttemptBudgetPosition,
} from "../records/inference-retry-disposition.js";
import { effectiveInferenceRetryCategories } from "../records/inference-replay.js";
import { isRetryRuleId, RETRY_RULES } from "../records/inference-retry-rule-vocabulary.js";
import { RECORDED_RETRY_RULES } from "../contracts/model-output.generated.js";
import {
  accountProviderAttempts,
  PROVIDER_ATTEMPT_ACCOUNTING_UNAVAILABLE,
  readTerminalReplayVeto,
  type ProviderAttemptAccountingV1,
} from "../model/provider-attempt.js";
import { isRecord } from "../shared/primitives.js";
import { readQualityValidationRejection } from "../evaluation-report/quality-validation-rejection.js";

/**
 * Why an eligible condition was not retried. The record writes one `declined`
 * for several causes; each is read from other fields on the same attempt
 * record. `unexplained` marks a decline no recorded field accounts for, rather
 * than attributing it to the nearest plausible cause.
 */
export type InferenceRetryDeclineCause =
  | "write-step"
  | "reset-write-step"
  | "terminal-policy"
  | "no-allowance"
  | "host-refusal"
  | "unexplained";

/**
 * Tokens read off a record without a recorded `retryRule`, derived from its
 * other fields. A record this build writes names its rule, so it never reads
 * `retried` or `declined-unexplained`.
 */
const LEGACY_RETRY_DECISION_TOKENS = [
  "retried",
  "exhausted",
  "declined-write-step",
  "declined-reset-write-step",
  "declined-terminal-policy",
  "declined-no-allowance",
  "declined-host-refusal",
  "declined-unexplained",
  "not-applicable",
  "unavailable",
] as const;

/** The derived tokens, in their published order, then the catalog rules not already among them. */
export const INFERENCE_RETRY_DECISION_TOKENS = Object.freeze([
  ...LEGACY_RETRY_DECISION_TOKENS,
  ...RECORDED_RETRY_RULES.filter(
    (rule) => !(LEGACY_RETRY_DECISION_TOKENS as readonly string[]).includes(rule),
  ),
] as const) as readonly (
  | (typeof RECORDED_RETRY_RULES)[number]
  | (typeof LEGACY_RETRY_DECISION_TOKENS)[number]
)[];

export type InferenceRetryDecisionToken = (typeof INFERENCE_RETRY_DECISION_TOKENS)[number];

/** The condition was eligible for retry, yet the harness stamped `retryable: false`. */
export const RETRY_ELIGIBILITY_DISAGREEMENT = "eligible-vs-retryable-false";

export type RetryEligibilityDisagreement = typeof RETRY_ELIGIBILITY_DISAGREEMENT;

export const RETRY_ELIGIBILITY_DISAGREEMENT_REASON =
  "condition eligible disagrees with retryable false";

/**
 * One sentence per rendered decision. The run footer and `docsfab runs show`
 * both read this table, so they cannot describe a record two ways.
 */
export const INFERENCE_RETRY_DECISION_REASONS: Readonly<
  Record<InferenceRetryDecisionToken, string>
> = Object.freeze({
  // The catalog's clause for every rule it has ever recorded.
  ...(Object.fromEntries(
    RECORDED_RETRY_RULES.map((rule) => [
      rule,
      isRetryRuleId(rule) ? RETRY_RULES[rule].summary : "a retired retry rule decided it",
    ]),
  ) as Record<(typeof RECORDED_RETRY_RULES)[number], string>),
  retried: "the runtime scheduled another attempt",
  "declined-unexplained": "the record does not say which rule declined it",
  unavailable: "the record carries no readable retryability/decision pair",
});

/**
 * The rendered pair plus its evidence. Records are untrusted input, so a field
 * this surface cannot read is `unavailable` rather than guessed or dropped.
 */
export interface InferenceRetryDispositionReadingV1 {
  readonly stepId: string;
  readonly attempt: number | typeof INFERENCE_RETRY_DISPOSITION_UNAVAILABLE;
  readonly outcome:
    | InferenceAttemptEvidence["outcome"]
    | typeof INFERENCE_RETRY_DISPOSITION_UNAVAILABLE;
  readonly conditionRetryability:
    | InferenceConditionRetryability
    | typeof INFERENCE_RETRY_DISPOSITION_UNAVAILABLE;
  readonly retryDecision: InferenceRetryDecision | typeof INFERENCE_RETRY_DISPOSITION_UNAVAILABLE;
  readonly decisionToken: InferenceRetryDecisionToken;
  /** The harness's flag; can be false while the condition is eligible. */
  readonly retryable: boolean | typeof INFERENCE_RETRY_DISPOSITION_UNAVAILABLE;
  /** Retries left after this attempt's decision, from the recorded effective budget. */
  readonly retriesRemaining: number | typeof INFERENCE_RETRY_DISPOSITION_UNAVAILABLE;
  /** Present only when the condition is `eligible` and `retryable` is `false`. */
  readonly eligibilityDisagreement?: RetryEligibilityDisagreement;
  readonly rejection?: InferenceRejectionReasonV1;
  /**
   * Governed turns and physical provider requests this attempt spent, from its
   * turn ledger. `unavailable` when there is no readable ledger; a partly
   * unsealed ledger still reads, with `coverage` saying so.
   */
  readonly physicalAttempts:
    | ProviderAttemptAccountingV1
    | typeof PROVIDER_ATTEMPT_ACCOUNTING_UNAVAILABLE;
  /** The boundary that refused the last in-turn replay, when one was refused. */
  readonly replayVeto?: ProviderTurnReplayVeto;
  /** The rejected reply's structural fingerprint: keys, types, and lengths, never reply text. */
  readonly rejectedReplyShape?: InferenceRejectedReplyShapeV1;
  /** The rejected reply's bounded excerpt, redacted again and with this host's roots replaced. */
  readonly rejectedReplyExcerpt?: InferenceRejectedReplyExcerptV1;
}

/**
 * One operator clause for a rejected reply's shape. It carries no reply text:
 * the parser's closed code and position, the root type, contract-declared keys,
 * and counts.
 */
export function formatRejectedReplyShapeClause(shape: InferenceRejectedReplyShapeV1): string {
  if (shape.parse.status === "failed") {
    const detail = shape.parse.detail ? ` ${shape.parse.detail}` : "";
    const position = shape.parse.offset === undefined ? "" : ` at character ${shape.parse.offset}`;
    return `reply not JSON (${shape.parse.code}${detail}${position} of ${shape.replyChars})`;
  }
  const truncation = formatReplyShapeTruncation(shape);
  if (shape.root !== "object") return `reply is a JSON ${shape.root}, not an object${truncation}`;
  // Defense in depth: a hand-edited record cannot put an undeclared key on
  // the terminal, because only contract-declared keys are ever printed.
  const keys = (shape.topLevelKeys ?? []).filter(isDeclaredResponseContractKey);
  const overLimit =
    shape.truncation?.find((entry) => entry.scope === "top-level-keys")?.omitted ?? 0;
  const undeclared = Math.max(0, (shape.topLevelKeyCount ?? keys.length) - keys.length - overLimit);
  const hidden = [
    ...(undeclared > 0 ? [`+${undeclared} undeclared`] : []),
    ...(overLimit > 0 ? [`+${overLimit} over limit`] : []),
  ];
  const listed = keys.length > 0 ? keys.join(", ") : "none";
  return `reply keys ${listed}${hidden.length > 0 ? ` (${hidden.join(", ")})` : ""}${truncation}`;
}

/** The bounds that clipped a fingerprint, named so clipping reaches the operator line. */
function formatReplyShapeTruncation(shape: InferenceRejectedReplyShapeV1): string {
  const clipped = (shape.truncation ?? [])
    .filter((entry) => entry.scope !== "top-level-keys")
    .map((entry) => `${entry.omitted} ${entry.scope} past ${entry.limit} = ${entry.bound}`);
  return clipped.length > 0 ? `; reply shape truncated (${clipped.join(", ")})` : "";
}

/**
 * The physical-request clause of an operator line. It states both counts, since
 * physical requests alone read like governed turns.
 */
export function formatProviderAttemptClause(
  accounting: InferenceRetryDispositionReadingV1["physicalAttempts"],
): string {
  if (accounting === PROVIDER_ATTEMPT_ACCOUNTING_UNAVAILABLE) {
    return `physical ${PROVIDER_ATTEMPT_ACCOUNTING_UNAVAILABLE}`;
  }
  // With no accounted turn there is no floor to state; "physical 0" would read
  // like a total.
  if (accounting.logicalTurns === 0 && accounting.unaccountedTurns > 0) {
    return `physical unaccounted (${accounting.unaccountedTurns} turns unreadable)`;
  }
  const partial =
    accounting.coverage === "partial"
      ? ` (at least; ${accounting.unaccountedTurns} unaccounted)`
      : "";
  return (
    `physical ${accounting.physicalRequests}` +
    ` across ${accounting.logicalTurns} governed` +
    ` ${accounting.logicalTurns === 1 ? "turn" : "turns"}${partial}`
  );
}

function readableRejection(value: unknown): InferenceRejectionReasonV1 | undefined {
  if (!isRecord(value)) return undefined;
  const { code, location } = value;
  if (typeof code !== "string" || typeof location !== "string") return undefined;
  // Operator prose: a code or location outside the retained grammar is not
  // echoed, so a hand-edited record cannot put free text on the terminal.
  if (!isRetainableInferenceRejection({ code, location })) return undefined;
  return { code, location };
}

function declineCause(
  attempt: InferenceAttemptEvidence,
  execution: InferenceExecutionEvidence,
): InferenceRetryDeclineCause | typeof INFERENCE_RETRY_DISPOSITION_UNAVAILABLE {
  // Runtime order: a write-capable step gets an empty category list and zero
  // budget, so checking categories first would report the consequence.
  if (execution.replay === "disabled-write-step") return "write-step";
  // An unreadable field names no cause; `unexplained` would claim the record
  // was read and found silent.
  if (!Array.isArray(execution.retryableCategories)) return INFERENCE_RETRY_DISPOSITION_UNAVAILABLE;
  if (!isInferenceFailureCategory(attempt.outcome)) return INFERENCE_RETRY_DISPOSITION_UNAVAILABLE;
  // A host-reset writer replays malformed replies plus configured transport
  // categories when this record carries a separate transport budget.
  if (
    execution.replay === "reset-write-step" &&
    !effectiveInferenceRetryCategories(
      execution.replay,
      execution.retryableCategories,
      execution.transportRetry !== undefined,
    ).includes(attempt.outcome)
  ) {
    return "reset-write-step";
  }
  if (!execution.retryableCategories.includes(attempt.outcome)) return "terminal-policy";
  if (typeof execution.effectiveMaxRetries !== "number") {
    return INFERENCE_RETRY_DISPOSITION_UNAVAILABLE;
  }
  if (execution.effectiveMaxRetries < 1) return "no-allowance";
  if (typeof attempt.retryable !== "boolean") return INFERENCE_RETRY_DISPOSITION_UNAVAILABLE;
  if (!attempt.retryable) return "host-refusal";
  return "unexplained";
}

function readRetryableFlag(
  attempt: Record<string, unknown>,
): boolean | typeof INFERENCE_RETRY_DISPOSITION_UNAVAILABLE {
  return typeof attempt.retryable === "boolean"
    ? attempt.retryable
    : INFERENCE_RETRY_DISPOSITION_UNAVAILABLE;
}

function readRetriesRemaining(
  attempt: Record<string, unknown>,
  execution: Record<string, unknown>,
): number | typeof INFERENCE_RETRY_DISPOSITION_UNAVAILABLE {
  if (
    typeof attempt.attempt !== "number" ||
    !Number.isInteger(attempt.attempt) ||
    attempt.attempt < 1
  ) {
    return INFERENCE_RETRY_DISPOSITION_UNAVAILABLE;
  }
  if (
    typeof execution.effectiveMaxRetries !== "number" ||
    !Number.isInteger(execution.effectiveMaxRetries) ||
    execution.effectiveMaxRetries < 0
  ) {
    return INFERENCE_RETRY_DISPOSITION_UNAVAILABLE;
  }
  if (typeof attempt.retryScheduled !== "boolean") {
    return INFERENCE_RETRY_DISPOSITION_UNAVAILABLE;
  }
  const position = readBudgetPosition(attempt, execution);
  if (position === INFERENCE_RETRY_DISPOSITION_UNAVAILABLE) return position;
  // A recorded rule that spent or refused its own budget leaves nothing of it,
  // whatever the contract count still allows.
  const rule = attempt.retryRule;
  if (
    isRetryRuleId(rule) &&
    (RETRY_RULES[rule].decision === "exhausted" || rule.startsWith("declined-no-"))
  ) {
    return 0;
  }
  // A transport retry the wall clock refused leaves nothing to spend, whatever
  // the count still allows.
  if (position.elapsedExhausted && attempt.retryable === true && !attempt.retryScheduled) return 0;
  return remainingRetryBudget({
    attempt: position.ordinal,
    effectiveMaxRetries: position.maxRetries,
    retryScheduled: attempt.retryScheduled,
  });
}

/**
 * The attempt's place in the budget that judged it: the transport budget for a
 * transport fault when the record carries one, else the contract count. A
 * transport block the record cannot vouch for makes the position unreadable.
 */
function readBudgetPosition(
  attempt: Record<string, unknown>,
  execution: Record<string, unknown>,
):
  | Pick<InferenceAttemptBudgetPosition, "ordinal" | "maxRetries" | "elapsedExhausted">
  | typeof INFERENCE_RETRY_DISPOSITION_UNAVAILABLE {
  const transportRetry = execution.transportRetry;
  // One shared count, as every record before the transport budget kept.
  if (transportRetry === undefined) {
    return {
      ordinal: attempt.attempt as number,
      maxRetries: execution.effectiveMaxRetries as number,
      elapsedExhausted: false,
    };
  }
  const attempts = execution.attempts;
  const index = Array.isArray(attempts) ? attempts.indexOf(attempt) : -1;
  if (!Array.isArray(attempts) || index < 0 || !attempts.every(isRecord)) {
    return INFERENCE_RETRY_DISPOSITION_UNAVAILABLE;
  }
  if (
    !(
      Array.isArray(execution.retryableCategories) &&
      isInferenceTransportRetryEvidence(
        transportRetry,
        // The categories the step's effective policy retried, as the writer saw them.
        effectiveInferenceRetryCategories(
          execution.replay as InferenceExecutionEvidence["replay"],
          execution.retryableCategories as InferenceFailureCategory[],
          execution.transportRetry !== undefined,
        ),
      )
    )
  ) {
    return INFERENCE_RETRY_DISPOSITION_UNAVAILABLE;
  }
  const inference = execution as unknown as InferenceExecutionEvidence;
  return (
    inferenceAttemptBudgetPositions(inference, attempts as unknown as InferenceAttemptEvidence[])[
      index
    ] ?? INFERENCE_RETRY_DISPOSITION_UNAVAILABLE
  );
}

export function retryEligibilityDisagreement(
  conditionRetryability:
    | InferenceConditionRetryability
    | typeof INFERENCE_RETRY_DISPOSITION_UNAVAILABLE,
  retryable: boolean | typeof INFERENCE_RETRY_DISPOSITION_UNAVAILABLE,
): RetryEligibilityDisagreement | undefined {
  return conditionRetryability === "eligible" && retryable === false
    ? RETRY_ELIGIBILITY_DISAGREEMENT
    : undefined;
}

/**
 * The rendered decision for one attempt; `unavailable` wins over everything.
 * The recorded retry rule is read first: it is the rule that decided, and it
 * must agree with the recorded decision. Only an older record without one has
 * its cause derived from other fields.
 */
export function inferenceRetryDecisionToken(
  attempt: InferenceAttemptEvidence,
  execution: InferenceExecutionEvidence,
): InferenceRetryDecisionToken {
  const { retryDecision } = readInferenceRetryDisposition(attempt);
  if (retryDecision === INFERENCE_RETRY_DISPOSITION_UNAVAILABLE) return "unavailable";
  const recorded = (attempt as { retryRule?: unknown }).retryRule;
  if (recorded !== undefined) {
    // A rule read beside an unreadable outcome names nothing the record vouches for.
    return isRetryRuleId(recorded) &&
      RETRY_RULES[recorded].decision === retryDecision &&
      isInferenceAttemptOutcome(attempt.outcome)
      ? recorded
      : "unavailable";
  }
  if (retryDecision !== "declined") return retryDecision;
  const cause = declineCause(attempt, execution);
  if (cause === INFERENCE_RETRY_DISPOSITION_UNAVAILABLE) return "unavailable";
  return `declined-${cause}`;
}

/**
 * Whether a step failed an attempt, was retried, or has an unreadable attempt.
 * An unreadable attempt qualifies so a malformed record cannot hide a failure.
 */
function hasRetryStory(execution: Record<string, unknown>): boolean {
  if (!Array.isArray(execution.attempts)) return true;
  return execution.attempts.some(
    (attempt) =>
      !isRecord(attempt) ||
      attempt.outcome !== INFERENCE_ATTEMPT_SUCCESS_OUTCOME ||
      attempt.retryScheduled === true,
  );
}

function readStepRetryDispositions(step: unknown): InferenceRetryDispositionReadingV1[] {
  if (!isRecord(step)) return [];
  const execution = step.inference;
  if (!isRecord(execution) || !hasRetryStory(execution)) return [];
  const stepId = typeof step.id === "string" ? step.id : INFERENCE_RETRY_DISPOSITION_UNAVAILABLE;
  // A non-array attempt list still gets one line, so an unreadable retry
  // history is visible instead of being an empty section.
  const attempts = Array.isArray(execution.attempts) ? execution.attempts : [undefined];
  const readings: InferenceRetryDispositionReadingV1[] = [];
  let roots: HostRootSet | undefined;
  for (const attempt of attempts) {
    if (!isRecord(attempt)) {
      readings.push({
        stepId,
        attempt: INFERENCE_RETRY_DISPOSITION_UNAVAILABLE,
        outcome: INFERENCE_RETRY_DISPOSITION_UNAVAILABLE,
        conditionRetryability: INFERENCE_RETRY_DISPOSITION_UNAVAILABLE,
        retryDecision: INFERENCE_RETRY_DISPOSITION_UNAVAILABLE,
        decisionToken: "unavailable",
        retryable: INFERENCE_RETRY_DISPOSITION_UNAVAILABLE,
        retriesRemaining: INFERENCE_RETRY_DISPOSITION_UNAVAILABLE,
        physicalAttempts: PROVIDER_ATTEMPT_ACCOUNTING_UNAVAILABLE,
      });
      continue;
    }
    const evidence = attempt as unknown as InferenceAttemptEvidence;
    const pair = readInferenceRetryDisposition(evidence);
    const rejection = readableRejection(attempt.rejection);
    // Count and veto read the same turn rows, so they cannot come from two
    // different attempts.
    const physicalAttempts = accountProviderAttempts(attempt.turns);
    const replayVeto = readTerminalReplayVeto(attempt.turns);
    const retryable = readRetryableFlag(attempt);
    const retriesRemaining = readRetriesRemaining(attempt, execution);
    const eligibilityDisagreement = retryEligibilityDisagreement(
      pair.conditionRetryability,
      retryable,
    );
    readings.push({
      stepId,
      attempt:
        typeof attempt.attempt === "number"
          ? attempt.attempt
          : INFERENCE_RETRY_DISPOSITION_UNAVAILABLE,
      outcome: isInferenceAttemptOutcome(attempt.outcome)
        ? attempt.outcome
        : INFERENCE_RETRY_DISPOSITION_UNAVAILABLE,
      conditionRetryability: pair.conditionRetryability,
      retryDecision: pair.retryDecision,
      decisionToken: inferenceRetryDecisionToken(
        evidence,
        execution as unknown as InferenceExecutionEvidence,
      ),
      retryable,
      retriesRemaining,
      physicalAttempts,
      // An unknown veto is dropped rather than echoed into operator prose.
      ...(isProviderTurnReplayVeto(replayVeto) ? { replayVeto } : {}),
      ...(eligibilityDisagreement ? { eligibilityDisagreement } : {}),
      ...(rejection ? { rejection } : {}),
      ...(isInferenceRejectedReplyShape(attempt.rejectedReplyShape)
        ? {
            rejectedReplyShape: canonicalizeRejectedReplyShape(
              structuredClone(attempt.rejectedReplyShape),
              isDeclaredResponseContractKey,
            ),
          }
        : {}),
      ...(isRejectedReplyExcerptOf(attempt.rejectedReplyExcerpt, attempt.rejectedReplyShape)
        ? {
            rejectedReplyExcerpt: projectRejectedReplyExcerpt(
              attempt.rejectedReplyExcerpt as InferenceRejectedReplyExcerptV1,
              (roots ??= rejectedReplyExcerptDisplayRoots()),
            ),
          }
        : {}),
    });
  }
  return readings;
}

/**
 * Every attempt of every failed-or-retried step, in record order. All three
 * operator surfaces share this selector so they agree on which attempts exist.
 * No bound here: the run's retry allowance already bounds the count, and
 * truncating would hide the attempt that explains the failure.
 */
export function readRunRetryDispositions(
  record: RunRecord,
): readonly InferenceRetryDispositionReadingV1[] {
  if (!Array.isArray(record.steps)) return [];
  return record.steps.flatMap((step) => readStepRetryDispositions(step));
}

/** The terminal attempt of a step that has a retry story, when one can be read. */
export function readTerminalRetryDisposition(
  step: RunRecord["steps"][number],
): InferenceRetryDispositionReadingV1 | undefined {
  return readStepRetryDispositions(step).at(-1);
}

/**
 * One line per attempt, for saved-run replay. `condition` and `decision` print
 * as separate fields so a reader can tell "cannot be retried" from "was not
 * retried".
 */
export function formatInferenceRetryDispositionLine(
  reading: InferenceRetryDispositionReadingV1,
): string {
  const rejection = reading.rejection
    ? `; rejected by ${reading.rejection.code} at ${reading.rejection.location}`
    : "";
  const reply = reading.rejectedReplyShape
    ? `; ${formatRejectedReplyShapeClause(reading.rejectedReplyShape)}`
    : "";
  const veto = reading.replayVeto ? `; replay stopped by ${reading.replayVeto}` : "";
  const disagreement = reading.eligibilityDisagreement
    ? `; ${RETRY_ELIGIBILITY_DISAGREEMENT_REASON}`
    : "";
  return (
    `Step ${reading.stepId} attempt ${reading.attempt}: ${reading.outcome}` +
    `; condition ${reading.conditionRetryability}` +
    `; retryable ${reading.retryable}` +
    `; decision ${reading.decisionToken}` +
    ` (${INFERENCE_RETRY_DECISION_REASONS[reading.decisionToken]})` +
    `; retries remaining ${reading.retriesRemaining}` +
    disagreement +
    `; ${formatProviderAttemptClause(reading.physicalAttempts)}` +
    veto +
    rejection +
    reply
  );
}

/**
 * The `RETRIES` body for `docsfab runs show`; empty when no step has a retry
 * story. An attempt with a retained reply excerpt is followed by its lines.
 */
export function formatRunRetryDispositionLines(record: RunRecord): string[] {
  if (!Array.isArray(record.steps)) return [];
  return record.steps.flatMap((step) => {
    const readings = readStepRetryDispositions(step);
    if (readings.length === 0) return [];
    const rejection = readQualityValidationRejection(step.qualityValidationRejection);
    return readings.flatMap((reading, index) => {
      // The final callback can succeed by declining quality. Its model reply
      // still failed admission; do not present that host choice as acceptance.
      const declined =
        step.id === "evaluate-document-quality" &&
        step.skill === "evaluate-document-quality" &&
        step.status === "succeeded" &&
        record.qualityArtifactValidation === undefined &&
        rejection !== null &&
        index === readings.length - 1 &&
        reading.outcome === "succeeded";
      return [
        declined
          ? `Step ${reading.stepId} attempt ${reading.attempt}: quality reply rejected by ${rejection.code} at ${rejection.location}; host continued without a validated quality evaluation or score; retries remaining ${reading.retriesRemaining}; ${formatProviderAttemptClause(reading.physicalAttempts)}`
          : formatInferenceRetryDispositionLine(reading),
        ...(reading.rejectedReplyExcerpt
          ? formatRejectedReplyExcerptLines(reading.rejectedReplyExcerpt).map((line) => `  ${line}`)
          : []),
      ];
    });
  });
}

/**
 * A summary line, then one line per retained segment. Segment text prints as a
 * JSON string with control, format, and line-separator characters escaped, so
 * reply text cannot move the cursor, restyle the terminal, or reorder a line.
 */
export function formatRejectedReplyExcerptLines(
  excerpt: InferenceRejectedReplyExcerptV1,
): string[] {
  const retained = excerpt.replyChars - excerpt.omittedChars;
  const clauses = [`${retained} of ${excerpt.replyChars} characters retained`];
  if (excerpt.omittedChars > 0) {
    clauses.push(
      `${excerpt.omittedChars} not retained past ${excerpt.limit} = ${excerpt.bound} per segment`,
    );
  }
  if (excerpt.parseOffset !== undefined) {
    const offset = excerpt.parseOffset;
    // A parser that ran out of input stops at the reply's length, in its last segment.
    const holder = excerpt.segments.find(
      (segment) =>
        segment.start <= offset &&
        (offset < segment.end || (offset === segment.end && offset === excerpt.replyChars)),
    );
    clauses.push(
      `parse stopped at character ${offset} (${holder ? `in ${holder.role}` : "not retained"})`,
    );
  }
  if (excerpt.redactions > 0) {
    clauses.push(`${excerpt.redactions} ${excerpt.redactions === 1 ? "span" : "spans"} redacted`);
  }
  return [
    `Reply excerpt: ${clauses.join("; ")}.`,
    ...excerpt.segments.map(
      (segment) =>
        `  ${segment.role} ${segment.start}-${segment.end}: ` +
        (segment.withheld ? `withheld (${segment.withheld})` : quoteExcerptText(segment.text)),
    ),
  ];
}

const UNPRINTABLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

function quoteExcerptText(text: string): string {
  return JSON.stringify(text).replace(UNPRINTABLE, (character) => {
    const code = character.codePointAt(0)!.toString(16);
    return code.length <= 4 ? `\\u${code.padStart(4, "0")}` : `\\u{${code}}`;
  });
}

/**
 * The run-footer sentence under a failed step, from its terminal reading. Uses
 * the same selector as `RETRIES` and `--json`.
 */
export function formatStepRetryDispositionSentence(
  step: RunRecord["steps"][number],
): string | undefined {
  const reading = readTerminalRetryDisposition(step);
  if (!reading) return undefined;
  const disagreement = reading.eligibilityDisagreement
    ? `; ${RETRY_ELIGIBILITY_DISAGREEMENT_REASON}`
    : "";
  return (
    `Step ${reading.stepId}` +
    ` condition ${reading.conditionRetryability}` +
    `, retryable ${reading.retryable}` +
    `, retry decision ${reading.decisionToken}` +
    ` on attempt ${reading.attempt}` +
    ` (${INFERENCE_RETRY_DECISION_REASONS[reading.decisionToken]});` +
    ` retries remaining ${reading.retriesRemaining}` +
    disagreement +
    `; ${formatProviderAttemptClause(reading.physicalAttempts)}` +
    (reading.replayVeto ? `, replay stopped by ${reading.replayVeto}` : "") +
    `.`
  );
}

/**
 * The inner reason a failed step was refused, in one operator sentence: the
 * rule and contract location from the record's coded fields, plus the reply
 * shape for an inference rejection. Silent without a readable inner reason.
 */
export function formatStepRejectionSentence(step: RunRecord["steps"][number]): string | undefined {
  if (!isRecord(step)) return undefined;
  const quality = (step as { qualityValidationRejection?: unknown }).qualityValidationRejection;
  if (isRecord(quality)) {
    const reason = readableRejection(quality);
    const count =
      typeof quality.issueCount === "number" && Number.isSafeInteger(quality.issueCount)
        ? quality.issueCount
        : undefined;
    if (reason) {
      return (
        `Rejected by ${reason.code} at ${reason.location}` +
        (count === undefined
          ? ""
          : ` (${count} quality validator ${count === 1 ? "issue" : "issues"})`) +
        `.`
      );
    }
  }
  const execution = (step as { inference?: unknown }).inference;
  if (!isRecord(execution) || !Array.isArray(execution.attempts)) return undefined;
  const terminal = execution.attempts.at(-1) as unknown;
  if (!isRecord(terminal)) return undefined;
  const reason = readableRejection(terminal.rejection);
  // The shape clause names only declared keys and the sentence prints no paths,
  // so no rewrite is needed here.
  const shape = isInferenceRejectedReplyShape(terminal.rejectedReplyShape)
    ? terminal.rejectedReplyShape
    : undefined;
  if (!reason && !shape) return undefined;
  const clauses = [
    ...(reason ? [`Rejected by ${reason.code} at ${reason.location}`] : []),
    ...(shape ? [formatRejectedReplyShapeClause(shape)] : []),
  ];
  const sentence = clauses.join("; ");
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`;
}

/**
 * The declined-retry clause for a stop/NEXT reason, or `undefined` unless the
 * reading is a decline.
 */
export function formatDeclinedRetryVisibilitySuffix(
  reading: InferenceRetryDispositionReadingV1 | undefined,
): string | undefined {
  if (!reading || reading.retryDecision !== "declined") return undefined;
  const remaining =
    typeof reading.retriesRemaining === "number"
      ? `; ${reading.retriesRemaining} ${
          reading.retriesRemaining === 1 ? "retry" : "retries"
        } remaining`
      : "";
  const disagreement =
    reading.eligibilityDisagreement === RETRY_ELIGIBILITY_DISAGREEMENT
      ? ` ${RETRY_ELIGIBILITY_DISAGREEMENT_REASON}`
      : ` condition ${reading.conditionRetryability}; retryable ${reading.retryable}`;
  return ` Retry declined:${disagreement}${remaining}.`;
}
