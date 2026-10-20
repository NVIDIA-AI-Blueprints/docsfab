// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Soft elapsed budget that makes a judgment step answer inside its own attempt
 * instead of reading until the attempt timer kills it.
 *
 * Without it, a judgment step can spend every retry reading and exhaust the
 * job deadline with no terminal outcome. At the flip point the host withdraws
 * the tools and asks for the answer from what the model already read. Pages it
 * never compared come back `unverified`, and `judgment-coverage.ts` host-fills
 * any target the reply still omits, so the forced answer is degraded model
 * content, never a refusal.
 */
import { limit, type ResolveLimitsOptions } from "../config/limits.js";
import { LIMIT_DEFINITION_BY_NAME } from "../config/limits.generated.js";
import type { HarnessStepInput } from "../execution/contracts.js";
import { listCatalogWorkflows } from "../workflow-registry/catalog.js";
import {
  degradesJudgmentModelContent,
  requiresTechnicalCorrection,
  usesProvisionalVerificationJudgment,
} from "../workflow-execution/source-obligation.js";

/** The unit's own scale, not an operational bound; the bound is the catalog's share limit. */
const BASIS_POINTS_PER_WHOLE = 10_000;
/** Unit conversion for a tokens-per-second rate, not an operational bound. */
const MS_PER_SECOND = 1_000;

export interface AnswerNowPolicy {
  /** Share of the attempt timer the step may spend reading, in basis points. */
  readonly elapsedShareBasisPoints: number;
  /** Output decode rate the answer reserve assumes, in tokens per second. */
  readonly decodeTokensPerSecond: number;
  /** Time the answer reserve charges each planned answer turn before its first token. */
  readonly turnLatencyMs: number;
}

/**
 * What the forced answer still has to produce: its output tokens and the
 * provider turns it may take. A whole text answer plans one answer turn plus
 * its length-stop continuations; a records answer plans its remaining record
 * messages, so both flips share `answerNowReserveMs`.
 */
export interface AnswerNowPlan {
  readonly answerOutputTokens: number;
  readonly answerTurns: number;
}

export interface RecordsAnswerNowFlipInput {
  /** Effective attempt timer from the same sealed plan as `dFullMs`. */
  readonly attemptTimeoutMs: number | undefined;
  /** Share of the attempt timer reserved for reading, in basis points. */
  readonly elapsedShareBasisPoints: number;
  /** Full-plan decode time from the same qualified plan used to derive T*. */
  readonly dFullMs: number;
  /** Fixed final-report decode reserve, independent of remaining record bytes. */
  readonly reportDecodeReserveMs: number;
  /** Bytes in the currently open portion of the full answer plan. */
  readonly openPlanBytes: number;
  /** Total bytes in the qualified full answer plan. */
  readonly fullPlanBytes: number;
  /** Remaining provider messages from the actual qualified groups. */
  readonly remainingMessages: number;
  /** Qualified per-turn latency, including production-sized prompt prefill. */
  readonly turnLatencyMs: number;
  /** Unknown D3 state reserves the one residual turn conservatively. */
  readonly d3ResidualFires: boolean | "unknown";
}

export interface RecordsAnswerNowFlip {
  /** False means the measured answer reserve cannot fit this attempt timer. */
  readonly armed: boolean;
  /** Absolute elapsed-time threshold from attempt start; absent when unarmed. */
  readonly flipAtMs?: number;
  readonly remainingReserveMs: number;
  readonly unarmedReason?: "missing-timer" | "answer-reserve-does-not-fit";
  readonly d3ResidualSource:
    | "observed-fire"
    | "observed-no-fire"
    | "unobserved-conservative-reserve";
}

/**
 * Dynamic §4.1 records answer-now flip. Every call uses the remaining bytes
 * and provider messages from the qualified plan; it does not infer a message
 * count from a row count or a generic fallback. A state whose answer reserve
 * is at least the timer cannot arm.
 */
export function deriveRecordsAnswerNowFlip(input: RecordsAnswerNowFlipInput): RecordsAnswerNowFlip {
  const positiveIntegers = [
    input.dFullMs,
    input.reportDecodeReserveMs,
    input.fullPlanBytes,
    input.turnLatencyMs,
  ].every((value) => Number.isSafeInteger(value) && value > 0);
  const nonNegativeIntegers = [input.openPlanBytes, input.remainingMessages].every(
    (value) => Number.isSafeInteger(value) && value >= 0,
  );
  if (
    !positiveIntegers ||
    input.reportDecodeReserveMs > input.dFullMs ||
    !nonNegativeIntegers ||
    input.openPlanBytes > input.fullPlanBytes ||
    (input.attemptTimeoutMs !== undefined &&
      (!Number.isSafeInteger(input.attemptTimeoutMs) || input.attemptTimeoutMs <= 0)) ||
    !Number.isSafeInteger(input.elapsedShareBasisPoints) ||
    input.elapsedShareBasisPoints < 0 ||
    input.elapsedShareBasisPoints >= BASIS_POINTS_PER_WHOLE ||
    (input.d3ResidualFires !== true &&
      input.d3ResidualFires !== false &&
      input.d3ResidualFires !== "unknown")
  ) {
    throw new TypeError("The records answer-now flip inputs are invalid or unsupported.");
  }

  const d3ReserveTurns = input.d3ResidualFires === false ? 0 : 1;
  const fullPlanBytes = BigInt(input.fullPlanBytes);
  const recordDecodeMs = input.dFullMs - input.reportDecodeReserveMs;
  const decodeNumerator = BigInt(recordDecodeMs) * BigInt(input.openPlanBytes);
  const decodeReserveMs =
    BigInt(input.reportDecodeReserveMs) + (decodeNumerator + fullPlanBytes - 1n) / fullPlanBytes;
  const turnReserveMs =
    (BigInt(input.remainingMessages) + 2n + BigInt(d3ReserveTurns)) * BigInt(input.turnLatencyMs);
  const remainingReserveBig = decodeReserveMs + turnReserveMs;
  if (remainingReserveBig > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new TypeError("The records answer-now reserve exceeds safe numeric precision.");
  }
  const remainingReserveMs = Number(remainingReserveBig);

  const d3ResidualSource =
    input.d3ResidualFires === true
      ? "observed-fire"
      : input.d3ResidualFires === false
        ? "observed-no-fire"
        : "unobserved-conservative-reserve";
  if (input.attemptTimeoutMs === undefined) {
    return {
      armed: false,
      remainingReserveMs,
      d3ResidualSource,
      unarmedReason: "missing-timer",
    };
  }
  if (remainingReserveMs >= input.attemptTimeoutMs) {
    return {
      armed: false,
      remainingReserveMs,
      d3ResidualSource,
      unarmedReason: "answer-reserve-does-not-fit",
    };
  }

  const readingShareNumerator =
    BigInt(input.elapsedShareBasisPoints) * BigInt(input.attemptTimeoutMs);
  const readingShareMs =
    (readingShareNumerator + BigInt(BASIS_POINTS_PER_WHOLE) - 1n) / BigInt(BASIS_POINTS_PER_WHOLE);
  const answerDeadlineMs = BigInt(input.attemptTimeoutMs) - remainingReserveBig;
  const flipAtMs = Number(readingShareMs < answerDeadlineMs ? readingShareMs : answerDeadlineMs);
  return { armed: true, flipAtMs, remainingReserveMs, d3ResidualSource };
}

export function resolveAnswerNowPolicy(options?: ResolveLimitsOptions): AnswerNowPolicy {
  return {
    elapsedShareBasisPoints: limit("compositionExecution.answerNowElapsedShareBasisPoints", options)
      .value,
    decodeTokensPerSecond: limit("compositionExecution.answerNowDecodeTokensPerSecond", options)
      .value,
    turnLatencyMs: limit("compositionExecution.answerNowTurnLatencyMs", options).value,
  };
}

/** The planned answer size of a step with no `compositionExecution.answerPlan` entry. */
export const ANSWER_PLAN_DEFAULT_LIMIT = "compositionExecution.answerPlan.defaultTokens";

/**
 * The catalog entry that declares a step's planned answer size: the step ID in
 * camel case, so `test-audience-understanding` reads
 * `compositionExecution.answerPlan.testAudienceUnderstandingTokens`.
 */
export function answerPlanLimitName(stepId: string): string {
  const camel = stepId.replace(/-([a-z0-9])/gu, (_match, next: string) => next.toUpperCase());
  return `compositionExecution.answerPlan.${camel}Tokens`;
}

/** A step's planned answer size and the catalog entry it came from. */
export interface StepAnswerPlanTokens {
  readonly stepId: string;
  readonly tokens: number;
  /** The entry read: the step's own, or `ANSWER_PLAN_DEFAULT_LIMIT`. */
  readonly limit: string;
  /** `false` when the step has no entry of its own and uses the declared default. */
  readonly declared: boolean;
}

export function stepAnswerPlanTokens(
  stepId: string,
  options?: ResolveLimitsOptions,
): StepAnswerPlanTokens {
  const own = answerPlanLimitName(stepId);
  const declared = Object.hasOwn(LIMIT_DEFINITION_BY_NAME, own);
  const name = declared ? own : ANSWER_PLAN_DEFAULT_LIMIT;
  return { stepId, tokens: limit(name, options).value, limit: name, declared };
}

/**
 * The steps an in-attempt answer ask can reach, each with its planned answer
 * size: every read-only catalog step a model runs. `docsfab doctor --limits`
 * lists them, so a step on the declared default is never a silent fallback.
 */
/** The packaged workflow catalog could not be read, so no step list can be derived from it. */
export class WorkflowCatalogUnavailableError extends Error {
  readonly code = "workflow-catalog-unavailable";

  constructor(cause: unknown) {
    const reason =
      cause && typeof cause === "object" && typeof (cause as { code?: unknown }).code === "string"
        ? (cause as { code: string }).code
        : "unreadable";
    super(
      `DocsFab could not read its packaged workflow catalog (${reason}), so it cannot list the steps an answer plan applies to. Reinstall DocsFab so its workflows directory is present, then rerun.`,
    );
    this.name = "WorkflowCatalogUnavailableError";
  }
}

/** The catalog the runtime runs from, or a coded refusal when it cannot be read. */
function catalogWorkflows(): ReturnType<typeof listCatalogWorkflows> {
  try {
    return listCatalogWorkflows();
  } catch (error) {
    throw new WorkflowCatalogUnavailableError(error);
  }
}

export function answerPlanCoverage(
  options?: ResolveLimitsOptions,
): readonly StepAnswerPlanTokens[] {
  const stepIds = new Set<string>();
  for (const workflow of catalogWorkflows()) {
    for (const step of workflow.steps) {
      if (step.mode === "read-only" && step.kind !== "host-operation") stepIds.add(step.id);
    }
  }
  return [...stepIds].sort().map((stepId) => stepAnswerPlanTokens(stepId, options));
}

/**
 * The `docsfab doctor --limits` lines for `answerPlanCoverage`: one per step,
 * then the steps on the declared default by name.
 */
export function formatAnswerPlanLines(plans: readonly StepAnswerPlanTokens[]): string[] {
  const onDefault = plans.filter((plan) => !plan.declared).map((plan) => plan.stepId);
  return [
    "",
    "answer plan step | tokens | limit | source",
    ...plans.map((plan) =>
      [plan.stepId, String(plan.tokens), plan.limit, plan.declared ? "step" : "default"].join(
        " | ",
      ),
    ),
    onDefault.length === 0
      ? `Every listed step declares its own answer plan; none uses ${ANSWER_PLAN_DEFAULT_LIMIT}.`
      : `Steps using ${ANSWER_PLAN_DEFAULT_LIMIT}: ${onDefault.join(", ")}.`,
  ];
}

/**
 * The answer plan of a step's whole text answer: the step's planned answer
 * tokens over the answer turn and each length-stop continuation.
 * `perTurnOutputTokens` is the bound composition's effective per-turn output
 * limit; when given, the plan never counts more output than those turns can
 * carry.
 */
export function stepAnswerNowPlan(
  stepId: string,
  perTurnOutputTokens: number | undefined,
  options?: ResolveLimitsOptions,
): AnswerNowPlan {
  const answerTurns = 1 + limit("inference.maxLengthStopContinuations", options).value;
  const plannedTokens = stepAnswerPlanTokens(stepId, options).tokens;
  return {
    answerOutputTokens:
      perTurnOutputTokens === undefined
        ? plannedTokens
        : Math.min(plannedTokens, perTurnOutputTokens * answerTurns),
    answerTurns,
  };
}

/**
 * Attempt time the forced answer needs: its planned output at the decode rate,
 * plus one turn latency for each planned turn.
 */
export function answerNowReserveMs(plan: AnswerNowPlan, policy: AnswerNowPolicy): number {
  return (
    Math.ceil((plan.answerOutputTokens * MS_PER_SECOND) / policy.decodeTokensPerSecond) +
    plan.answerTurns * policy.turnLatencyMs
  );
}

/**
 * The elapsed point inside one attempt after which only the answer reserve
 * remains: the attempt timer less the reserve the step's answer plan needs, or
 * `undefined` when there is no timer or the reserve does not fit inside it.
 *
 * A read-only step still calling tools at this point is asked to conclude;
 * past it, an answer started now would not finish before the timer.
 */
export function concludeBeforeDeadlineAtMs(
  attemptTimeoutMs: number | undefined,
  policy: AnswerNowPolicy,
  plan: AnswerNowPlan,
): number | undefined {
  if (attemptTimeoutMs === undefined) return undefined;
  const reserveMs = answerNowReserveMs(plan, policy);
  if (attemptTimeoutMs <= reserveMs) return undefined;
  return attemptTimeoutMs - reserveMs;
}

/**
 * The elapsed point inside one attempt at which the host withdraws tools and
 * asks for the answer, or `undefined` when the budget does not arm.
 *
 * The earlier of two terms wins: the reading share of the attempt timer, and
 * the timer minus the reserve the step's answer plan needs
 * (`concludeBeforeDeadlineAtMs`). Use `min`, not
 * `elapsed >= share && remaining >= reserve`: any reserve above
 * `(1 - share) x timeout` makes that conjunction permanently false.
 *
 * The budget does not arm when the attempt has no timer (normal mode) or when
 * the reserve does not fit inside the attempt. Flipping at zero there would
 * strip the tools from the whole attempt; `docsfab doctor` reports why the
 * budget did not arm instead.
 */
export function answerNowFlipAtMs(
  attemptTimeoutMs: number | undefined,
  policy: AnswerNowPolicy,
  plan: AnswerNowPlan,
): number | undefined {
  const deadlineAtMs = concludeBeforeDeadlineAtMs(attemptTimeoutMs, policy, plan);
  if (attemptTimeoutMs === undefined || deadlineAtMs === undefined) return undefined;
  const readingShareMs = Math.floor(
    (attemptTimeoutMs * policy.elapsedShareBasisPoints) / BASIS_POINTS_PER_WHOLE,
  );
  return Math.min(readingShareMs, deadlineAtMs);
}

/**
 * The two judgment steps whose answer may be degraded rather than refused:
 * provisional verification, and technical correction over a V2 ledger.
 *
 * Only `review-documentation` degrades judgment content. On
 * `create-documentation` the coverage policy refuses, so a forced early answer
 * there would come back `invalid-coverage`. Other steps have no judgment shape
 * and no host coverage fill to degrade into.
 */
export function answerNowAppliesTo(
  input: Pick<HarnessStepInput, "workflow" | "step" | "sourceObligationLedger">,
): boolean {
  if (!degradesJudgmentModelContent(input)) return false;
  // Mirrors `reply-admission/judgment.ts`: a V1 ledger keeps the strict
  // validator, which would refuse a forced early answer instead of degrading it.
  return (
    usesProvisionalVerificationJudgment(input) ||
    (requiresTechnicalCorrection(input) && input.sourceObligationLedger?.schemaVersion === 2)
  );
}

/**
 * The catalog steps `answerNowAppliesTo` admits, read from the predicate
 * itself. The gate admits technical correction only over a V2 ledger, so each
 * step is asked with one.
 */
export function answerNowStepIds(): readonly string[] {
  const stepIds = new Set<string>();
  for (const workflow of catalogWorkflows()) {
    for (const step of workflow.steps) {
      const input = {
        workflow,
        step,
        sourceObligationLedger: { schemaVersion: 2 } as HarnessStepInput["sourceObligationLedger"],
      };
      if (answerNowAppliesTo(input)) stepIds.add(step.id);
    }
  }
  return [...stepIds].sort();
}

/**
 * Steps the conclude-before-deadline ask applies to: every read-only step the
 * answer-now budget does not already cover. A write step changes files through
 * its tools, so withdrawing them would leave its change half made; its attempt
 * timer alone still ends it.
 */
export function concludeBeforeDeadlineAppliesTo(
  input: Pick<HarnessStepInput, "workflow" | "step" | "sourceObligationLedger">,
): boolean {
  return input.step.mode === "read-only" && !answerNowAppliesTo(input);
}
