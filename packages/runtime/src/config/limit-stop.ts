// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Coded operational-limit stops.
 *
 * A stop caused by one of DocsFab's own bounds must never be reported as a
 * user cancellation, a generic failure, or an unannounced clamp. Every bound
 * that halts, refuses, or clips work reports one `OperationalLimitStop` naming
 * the limit, its configured value, the observed value, and the remediation.
 *
 * This module owns the vocabulary only. Each limit's value lives with the
 * subsystem that enforces it; a name here is a reference, never a value.
 */

/**
 * `stopped` halted the work at the bound, and is the only disposition a caller
 * may read as "this limit ended the run". `clamped` continued with a reduced
 * value. `clipped` continued but dropped or refused work at the bound. The last
 * two must reach the operator summary, not only a record, and neither may be
 * reported as an exhausted budget, because the work went on.
 */
export type OperationalLimitDisposition = "stopped" | "clamped" | "clipped";

/** Unit of both `configured` and `observed`; rendered beside every value. */
export type OperationalLimitUnit =
  | "ms"
  | "tokens"
  | "calls"
  | "turns"
  | "compactions"
  | "bytes"
  | "retries";

export interface OperationalLimitStop {
  /** Dotted identity of the configured limit, stable across surfaces. */
  readonly limit: string;
  readonly unit: OperationalLimitUnit;
  readonly disposition: OperationalLimitDisposition;
  /** The bound in force for this run. */
  readonly configured: number;
  /** What was seen: elapsed time, requested tokens, prepared calls. */
  readonly observed: number;
  /** What an operator can do about it. Never interpolates caller text. */
  readonly remediation: string;
}

/**
 * Identities of the limits classified so far. A name here is a reference to a
 * value defined by its owning module; adding a name does not define a bound.
 */
export const OPERATIONAL_LIMIT_NAMES = {
  /** Wall clock for one headless delegated task (`delegated-task/driver.ts`). */
  delegatedTaskTimeoutMs: "delegatedTask.timeoutMs",
  delegatedTaskMaxToolCalls: "delegatedTask.maxToolCalls",
  delegatedTaskMaxProviderTurns: "delegatedTask.maxProviderTurns",
  delegatedTaskMaxCompactions: "delegatedTask.maxCompactions",
  /** Output room left for one governed turn after its input was counted. */
  modelAvailableOutputTokens: "model.availableOutputTokens",
  /** The input cap one governed turn's reservation and estimate must fit. */
  modelEffectiveMaxInputTokens: "model.effectiveMaxInputTokens",
  /** Output-token authority the host lease has left for one more turn. */
  modelOutputTokenAuthority: "model.outputTokenAuthority",
  /** Latency ceiling for one hosted structural compile. */
  hostedContextPreflightBudgetMs: "hostInvoker.contextPreflightBudgetMs",
  /** Conservative context ceiling for a profile without current metadata. */
  modelProfileFallbackContextWindow: "modelProfile.conservativeFallbackContextWindow",
  /** Conservative output ceiling for a profile without current metadata. */
  modelProfileFallbackMaxOutputTokens: "modelProfile.conservativeFallbackMaxOutputTokens",
  /** Conservative input ceiling, derived from the clamped context window. */
  modelProfileFallbackMaxInputTokens: "modelProfile.conservativeFallbackMaxInputTokens",
  /** Tool calls one workflow step attempt may execute (`config/execution-limit-stops.ts`). */
  compositionMaxToolCallsPerStep: "compositionExecution.maxToolCallsPerStep",
  /** Provider turns one workflow step attempt may take. */
  compositionMaxProviderTurns: "compositionExecution.maxProviderTurns",
  /** A composition's sealed provider-turn budget, which can fit a step's ceilings below the catalog. */
  sealedCompositionMaxProviderTurns: "sealed.compositionLimits.maxProviderTurns",
  /** Context compactions one governed attempt may perform. */
  governanceMaxCompactions: "governance.maxCompactions",
} as const;

export type OperationalLimitName =
  (typeof OPERATIONAL_LIMIT_NAMES)[keyof typeof OPERATIONAL_LIMIT_NAMES];

/**
 * Where the enforcing bound draws its own line, stated by the caller because
 * only the enforcer knows it. `at-the-bound` is inclusive
 * (`observed >= configured`): an expired deadline, the hosted compile ceiling,
 * the turn governor's compaction counter. `past-the-bound` is strict
 * (`observed > configured`), as every other governed counter and every floor
 * comparison is.
 *
 * `exceededLimitStop` refuses evidence that contradicts its own reason, and
 * evidence exactly on a strict bound claims a stop at a ceiling the governor
 * would have admitted.
 */
export type OperationalLimitBreachRule = "at-the-bound" | "past-the-bound";

/**
 * Exhaustive by type, so a new rule without a comparison is a compile error;
 * the runtime guard catches a value that bypassed the type checker.
 */
const LIMIT_BREACH_ADMITS: Record<
  OperationalLimitBreachRule,
  (observed: number, configured: number) => boolean
> = {
  "at-the-bound": (observed, configured) => observed >= configured,
  "past-the-bound": (observed, configured) => observed > configured,
};

function assertMeasurable(value: number, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(
      `An operational limit stop requires a finite non-negative ${field}; a bound that cannot state its own value cannot be reported.`,
    );
  }
  return value;
}

/**
 * The stop for a ceiling that halts work, or `undefined` when the bound did not
 * bind. `breach` names the comparison the enforcing subsystem itself used and
 * has no default, because a guessed comparison can report a stop at equality
 * on a strict bound.
 */
export function exceededLimitStop(input: {
  limit: OperationalLimitName;
  unit: OperationalLimitUnit;
  breach: OperationalLimitBreachRule;
  configured: number;
  observed: number;
  remediation: string;
}): OperationalLimitStop | undefined {
  const configured = assertMeasurable(input.configured, "configured value");
  const observed = assertMeasurable(input.observed, "observed value");
  const admits = LIMIT_BREACH_ADMITS[input.breach];
  if (!admits) {
    throw new Error(
      `An operational limit stop carries no comparison for its breach rule; add one before reporting ${input.limit}.`,
    );
  }
  if (!admits(observed, configured)) return undefined;
  return Object.freeze({
    limit: input.limit,
    unit: input.unit,
    disposition: "stopped" as const,
    configured,
    observed,
    remediation: input.remediation,
  });
}

/**
 * The stop for a ceiling that reduces a requested value instead of refusing
 * it, or `undefined` unless the clamp binds: a profile already inside the
 * conservative fallback is not clamped and must not claim to be.
 */
export function clampedLimitStop(input: {
  limit: OperationalLimitName;
  unit: OperationalLimitUnit;
  configured: number;
  requested: number;
  remediation: string;
}): OperationalLimitStop | undefined {
  const configured = assertMeasurable(input.configured, "configured value");
  const requested = assertMeasurable(input.requested, "requested value");
  if (requested <= configured) return undefined;
  return Object.freeze({
    limit: input.limit,
    unit: input.unit,
    disposition: "clamped" as const,
    configured,
    observed: requested,
    remediation: input.remediation,
  });
}

/**
 * The flag for a ceiling that refused part of the work and let the rest
 * continue: a truncated listing, a dropped page, a tool call the governor
 * would not prepare. Returns `undefined` unless something was dropped, and
 * never carries the `stopped` disposition, because the run did not end at the
 * budget.
 */
export function clippedLimitStop(input: {
  limit: OperationalLimitName;
  unit: OperationalLimitUnit;
  configured: number;
  attempted: number;
  remediation: string;
}): OperationalLimitStop | undefined {
  const configured = assertMeasurable(input.configured, "configured value");
  const attempted = assertMeasurable(input.attempted, "attempted value");
  if (attempted <= configured) return undefined;
  return Object.freeze({
    limit: input.limit,
    unit: input.unit,
    disposition: "clipped" as const,
    configured,
    observed: attempted,
    remediation: input.remediation,
  });
}

/**
 * One sentence per stop: the limit, the observed value, and the remediation.
 * Besides the remediation, it interpolates only the limit's identity, numbers,
 * and unit. The verb tells an operator whether the run ended, continued
 * reduced, or continued with work dropped.
 */
const LIMIT_STOP_WORDING: Record<
  OperationalLimitDisposition,
  { verb: string; bound: string; seen: string }
> = {
  stopped: { verb: "stopped this run at", bound: "limit", seen: "observed" },
  clamped: { verb: "clamped to", bound: "effective", seen: "requested" },
  clipped: { verb: "continued with work clipped at", bound: "limit", seen: "attempted" },
};

export function formatOperationalLimitStop(stop: OperationalLimitStop): string {
  const wording = LIMIT_STOP_WORDING[stop.disposition];
  if (!wording) {
    throw new Error(
      `An operational limit stop carries no rendering for its disposition; add one before reporting ${stop.limit}.`,
    );
  }
  return `DocsFab ${wording.verb} the operational limit ${stop.limit} (${wording.bound} ${String(stop.configured)} ${stop.unit}, ${wording.seen} ${String(stop.observed)} ${stop.unit}). ${stop.remediation}`;
}
