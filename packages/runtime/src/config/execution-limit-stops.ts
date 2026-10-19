// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The catalogued code for each execution ceiling a workflow step attempt can
 * exhaust: tool calls, provider turns, and compactions.
 *
 * A step reaches one of these ceilings in three ways. The turn governor
 * refuses the next turn and names the reason on the turn evidence; the
 * execution lease ends at the ceiling and names it as its terminal reason; or
 * the step completes having used every allowed call or turn. All three read
 * this module, so the run records the same code whichever way the step
 * stopped.
 *
 * The code is the limit's own catalog `refusal`, read by name. The ceiling a
 * step runs under is fitted from the catalog value and the composition's
 * sealed provider-turn budget, so the code names the limit that actually bound.
 */

import type { ExecutionLeaseRuntimeEvidenceV1 } from "../execution/contracts.js";
import type { InferenceTurnEvidence, InferenceTurnReason } from "../records/contracts.js";
import {
  OPERATIONAL_LIMIT_NAMES,
  exceededLimitStop,
  type OperationalLimitBreachRule,
  type OperationalLimitName,
  type OperationalLimitStop,
  type OperationalLimitUnit,
} from "./limit-stop.js";
import { LIMIT_DEFINITION_BY_NAME } from "./limits.generated.js";
import { limit } from "./limits.js";

/** The execution ceilings a step attempt can exhaust. */
export type StepExecutionCeiling = "tool-calls" | "provider-turns" | "compactions";

/**
 * The ceiling behind each governor stop reason, or `null` when the stop is not
 * an execution ceiling. Keyed by the closed reason union, so a new reason does
 * not typecheck until it is placed.
 *
 * `output-authority-exhausted` is a bound too, but its configured value comes
 * from a different catalog entry in composition and normal mode, and the turn
 * does not record which; it keeps the `context-exhausted` code until it does.
 */
export const TURN_STOP_CEILINGS = Object.freeze({
  "tool-call-limit": "tool-calls",
  "provider-turn-limit": "provider-turns",
  "compaction-limit": "compactions",
  "output-authority-exhausted": null,
  "context-exhausted": null,
  "compaction-ineffective": null,
  "evidence-preservation-required": null,
} as const satisfies Record<InferenceTurnReason, StepExecutionCeiling | null>);

type LeaseTerminalReason = NonNullable<ExecutionLeaseRuntimeEvidenceV1["terminalReason"]>;

/**
 * The ceiling behind each lease terminal reason, or `null`. The cumulative
 * token, time, and cost reasons are bounds whose configured value depends on
 * the execution mode, which the lease evidence does not record, so they are not
 * coded here.
 */
export const LEASE_TERMINAL_CEILINGS = Object.freeze({
  "hard-tool-call-ceiling": "tool-calls",
  "provider-turn-limit": "provider-turns",
  completed: null,
  "needs-input": null,
  "needs-human-decision": null,
  "security-denied": null,
  "authorization-denied": null,
  "cancellation-requested": null,
  "evidence-preservation-required": null,
  "context-exhausted": null,
  "cumulative-input-limit": null,
  "cumulative-output-limit": null,
  "output-authority-exhausted": null,
  "cumulative-time-limit": null,
  "cost-unavailable": null,
  "cumulative-cost-limit": null,
  "lease-limit": null,
  "checkpoint-not-renewable": null,
  "provider-terminal": null,
  "provider-unavailable": null,
} as const satisfies Record<
  LeaseTerminalReason,
  Exclude<StepExecutionCeiling, "compactions"> | null
>);

/** A step execution ceiling that stopped a step, with the limit's catalog code. */
export interface StepExecutionLimitStop extends OperationalLimitStop {
  readonly code: string;
  readonly ceiling: StepExecutionCeiling;
  /** The step's provider-turn budget the ceiling was fitted to. */
  readonly providerTurnBudget?: number;
}

/**
 * The value in force for this host: the catalog value, or a lower operator
 * override. A ceiling compared with it is attributed to the limit that
 * actually bound, never to a catalog value an override replaced.
 */
function effectiveValue(name: OperationalLimitName): number {
  const definition = LIMIT_DEFINITION_BY_NAME[name];
  if (!definition) {
    throw new Error(`Operational limit ${name} is not declared in config/limits.yaml.`);
  }
  try {
    return limit(name).value;
  } catch {
    // An invalid override is refused at startup; a classifier reading an
    // older record must not fail on it, so it attributes against the catalog.
    return definition.value;
  }
}

function catalogCode(name: string): string {
  const definition = LIMIT_DEFINITION_BY_NAME[name];
  if (!definition) {
    throw new Error(`Operational limit ${name} is not declared in config/limits.yaml.`);
  }
  return definition.refusal;
}

/** The read-loop supervision limits; their values live only in `config/limits/execution.yaml`. */
export const READ_LOOP_LIMITS = Object.freeze({
  repeatStreak: "execution.readLoopRepeatStreak",
  withheldReads: "execution.readLoopWithheldReads",
  unchangedReReads: "execution.readLoopUnchangedReReads",
} as const);

/**
 * The codes a read-loop `no-progress` stop records: the per-result bound and
 * the cross-result bound, read from the catalog by limit name.
 */
export const READ_LOOP_STOP_CODES: ReadonlySet<string> = new Set([
  catalogCode(READ_LOOP_LIMITS.withheldReads),
  catalogCode(READ_LOOP_LIMITS.unchangedReReads),
]);

/**
 * The code of each execution ceiling a step attempt can use up before it
 * answers: tool calls and provider turns, the host's or the sealed budget's.
 */
export const STEP_EXECUTION_CEILING_CODES: ReadonlyMap<
  string,
  Exclude<StepExecutionCeiling, "compactions">
> = new Map([
  [catalogCode(OPERATIONAL_LIMIT_NAMES.compositionMaxToolCallsPerStep), "tool-calls"],
  [catalogCode(OPERATIONAL_LIMIT_NAMES.compositionMaxProviderTurns), "provider-turns"],
  [catalogCode(OPERATIONAL_LIMIT_NAMES.sealedCompositionMaxProviderTurns), "provider-turns"],
]);

/**
 * Which limit bound a provider-turn budget. Below the host's effective value,
 * the composition's sealed budget set it; at that value the host limit did.
 */
function providerTurnLimit(maxProviderTurns: number): OperationalLimitName {
  return maxProviderTurns < effectiveValue(OPERATIONAL_LIMIT_NAMES.compositionMaxProviderTurns)
    ? OPERATIONAL_LIMIT_NAMES.sealedCompositionMaxProviderTurns
    : OPERATIONAL_LIMIT_NAMES.compositionMaxProviderTurns;
}

const NARROW_SCOPE =
  "Narrow the request, for example to fewer pages or sources, so the step finishes inside its ceiling.";

const SEALED_BUDGET =
  "the composition's sealed turn budget sets it, and raising a sealed budget means re-qualifying the composition.";

/** How the host value relates to the catalog: an override can only lower it. */
function hostValueSource(name: OperationalLimitName): string {
  const value = effectiveValue(name);
  return value < LIMIT_DEFINITION_BY_NAME[name]!.value
    ? `${name} = ${String(value)}, lowered by an operator override; raise or remove the override, or narrow the request.`
    : `${name} = ${String(value)}, the catalog value.`;
}

function remediation(
  ceiling: StepExecutionCeiling,
  configured: number,
  providerTurnBudget: number | undefined,
): string {
  switch (ceiling) {
    case "tool-calls": {
      const toolLimit = OPERATIONAL_LIMIT_NAMES.compositionMaxToolCallsPerStep;
      if (configured < effectiveValue(toolLimit) && providerTurnBudget !== undefined) {
        const turnBound =
          providerTurnLimit(providerTurnBudget) ===
          OPERATIONAL_LIMIT_NAMES.sealedCompositionMaxProviderTurns
            ? SEALED_BUDGET
            : hostValueSource(OPERATIONAL_LIMIT_NAMES.compositionMaxProviderTurns);
        return (
          `The ceiling is ${toolLimit} = ${String(effectiveValue(toolLimit))} fitted to this ` +
          `step's provider-turn budget of ${String(providerTurnBudget)}; ${turnBound} ${NARROW_SCOPE}`
        );
      }
      return `The ceiling is ${hostValueSource(toolLimit)} ${NARROW_SCOPE}`;
    }
    case "provider-turns":
      return providerTurnLimit(configured) ===
        OPERATIONAL_LIMIT_NAMES.sealedCompositionMaxProviderTurns
        ? `The ceiling is the step's provider-turn budget; ${SEALED_BUDGET} ${NARROW_SCOPE}`
        : `The ceiling is ${hostValueSource(OPERATIONAL_LIMIT_NAMES.compositionMaxProviderTurns)} ${NARROW_SCOPE}`;
    case "compactions":
      return `Reduce context pressure: ${NARROW_SCOPE}`;
  }
}

const CEILING_UNITS: Record<StepExecutionCeiling, OperationalLimitUnit> = {
  "tool-calls": "calls",
  "provider-turns": "turns",
  compactions: "compactions",
};

/**
 * The stop for one ceiling, or `undefined` when the evidence does not support
 * a breach under the enforcing comparison.
 */
export function stepExecutionCeilingStop(input: {
  readonly ceiling: StepExecutionCeiling;
  readonly breach: OperationalLimitBreachRule;
  readonly configured: number;
  readonly observed: number;
  /** The step's provider-turn budget, for a tool-call ceiling fitted to it. */
  readonly providerTurnBudget?: number;
}): StepExecutionLimitStop | undefined {
  const { ceiling, configured, observed, providerTurnBudget } = input;
  if (![configured, observed].every((value) => Number.isFinite(value) && value >= 0)) {
    return undefined;
  }
  const limit =
    ceiling === "tool-calls"
      ? OPERATIONAL_LIMIT_NAMES.compositionMaxToolCallsPerStep
      : ceiling === "provider-turns"
        ? providerTurnLimit(configured)
        : OPERATIONAL_LIMIT_NAMES.governanceMaxCompactions;
  const stop = exceededLimitStop({
    limit,
    unit: CEILING_UNITS[ceiling],
    breach: input.breach,
    configured,
    observed,
    remediation: remediation(ceiling, configured, providerTurnBudget),
  });
  if (!stop) return undefined;
  return Object.freeze({
    ...stop,
    code: catalogCode(limit),
    ceiling,
    ...(providerTurnBudget === undefined ? {} : { providerTurnBudget }),
  });
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * The stop a governed turn records, read from its closed reason and counters,
 * or `undefined` when the turn did not stop at an execution ceiling. The
 * comparisons are the governor's own: it refuses a turn once tool calls pass
 * the ceiling, once provider turns reach it (the evidence records the refused
 * turn's number, one past), or once compactions reach theirs.
 */
export function governedTurnLimitStop(
  turn: Partial<InferenceTurnEvidence> | undefined,
): StepExecutionLimitStop | undefined {
  if (!turn || turn.decision !== "stop" || typeof turn.reason !== "string") return undefined;
  if (!Object.hasOwn(TURN_STOP_CEILINGS, turn.reason)) return undefined;
  const ceiling = TURN_STOP_CEILINGS[turn.reason];
  if (ceiling === null) return undefined;
  const pair = {
    "tool-calls": [turn.toolCalls, turn.maxToolCalls, "past-the-bound"],
    "provider-turns": [turn.turn, turn.maxProviderTurns, "past-the-bound"],
    compactions: [turn.compactions, turn.maxCompactions, "at-the-bound"],
  } as const satisfies Record<StepExecutionCeiling, readonly [unknown, unknown, unknown]>;
  const [observed, configured, breach] = pair[ceiling];
  const observedCount = count(observed);
  const configuredCount = count(configured);
  if (observedCount === undefined || configuredCount === undefined) return undefined;
  const providerTurnBudget = count(turn.maxProviderTurns);
  return stepExecutionCeilingStop({
    ceiling,
    breach,
    configured: configuredCount,
    observed: observedCount,
    ...(providerTurnBudget === undefined ? {} : { providerTurnBudget }),
  });
}

/**
 * The stop a lease records when it ended at an execution ceiling, measured
 * against the policy maxima its last governed turn carries. The lease stops
 * once executed calls reach the tool-call ceiling, and once only one provider
 * turn remains, because it keeps that turn for the step's final answer; the
 * reserved turn counts as used, so both comparisons are inclusive.
 */
export function leaseTerminalLimitStop(
  lease:
    | {
        readonly terminalReason?: string;
        readonly providerTurns?: number;
        readonly toolCalls?: { readonly executed?: number };
      }
    | undefined,
  lastTurn: Partial<InferenceTurnEvidence> | undefined,
): StepExecutionLimitStop | undefined {
  const reason = lease?.terminalReason;
  if (typeof reason !== "string" || !Object.hasOwn(LEASE_TERMINAL_CEILINGS, reason)) {
    return undefined;
  }
  const ceiling = LEASE_TERMINAL_CEILINGS[reason as LeaseTerminalReason];
  if (ceiling === null) return undefined;
  const providerTurns = count(lease?.providerTurns);
  const observed =
    ceiling === "tool-calls"
      ? count(lease?.toolCalls?.executed)
      : providerTurns === undefined
        ? undefined
        : providerTurns + 1;
  const configured = count(
    ceiling === "tool-calls" ? lastTurn?.maxToolCalls : lastTurn?.maxProviderTurns,
  );
  if (observed === undefined || configured === undefined) return undefined;
  const providerTurnBudget = count(lastTurn?.maxProviderTurns);
  return stepExecutionCeilingStop({
    ceiling,
    breach: "at-the-bound",
    configured,
    observed,
    ...(providerTurnBudget === undefined ? {} : { providerTurnBudget }),
  });
}

/**
 * Whether the host ended the attempt after the settled tool turn that brought
 * its executed calls to the hard tool-call ceiling: the lease stopped at that
 * ceiling, at the bound the last governed turn records, without a governor
 * refusal. Record decoders admit the `tool-call-ceiling` condition on a
 * `no-progress` attempt only in this shape.
 */
export function attemptEndedAtToolCallCeiling(
  lease:
    | (NonNullable<Parameters<typeof leaseTerminalLimitStop>[0]> & {
        readonly terminalDisposition?: string;
      })
    | undefined,
  lastTurn: Partial<InferenceTurnEvidence> | undefined,
): boolean {
  return (
    lease?.terminalDisposition === "budget-stopped" &&
    lastTurn?.decision !== "stop" &&
    leaseTerminalLimitStop(lease, lastTurn)?.ceiling === "tool-calls"
  );
}

/**
 * The stop for an attempt that ended at an execution ceiling: the governor's
 * refusal on its last turn first, then its lease's terminal reason.
 */
export function attemptExecutionLimitStop(attempt: {
  readonly turns?: readonly Partial<InferenceTurnEvidence>[];
  readonly executionLease?: Parameters<typeof leaseTerminalLimitStop>[0];
}): StepExecutionLimitStop | undefined {
  const lastTurn = attempt.turns?.at(-1);
  return (
    governedTurnLimitStop(lastTurn) ?? leaseTerminalLimitStop(attempt.executionLease, lastTurn)
  );
}

/**
 * The stop for a step that completed having used its whole allowance: every
 * tool call, or every provider turn. Exhausting the allowance is the host's
 * truncation signal, so the comparison is inclusive.
 */
export function exhaustedAllowanceStop(input: {
  readonly executedToolCalls?: number;
  readonly maxToolCalls?: number;
  readonly providerTurns?: number;
  readonly maxProviderTurns?: number;
}): StepExecutionLimitStop | undefined {
  const { executedToolCalls, maxToolCalls, providerTurns, maxProviderTurns } = input;
  const providerTurnBudget = count(maxProviderTurns);
  const budget = providerTurnBudget === undefined ? {} : { providerTurnBudget };
  if (
    typeof maxToolCalls === "number" &&
    typeof executedToolCalls === "number" &&
    maxToolCalls > 0
  ) {
    const toolStop = stepExecutionCeilingStop({
      ceiling: "tool-calls",
      breach: "at-the-bound",
      configured: maxToolCalls,
      observed: executedToolCalls,
      ...budget,
    });
    if (toolStop) return toolStop;
  }
  if (
    typeof maxProviderTurns === "number" &&
    typeof providerTurns === "number" &&
    maxProviderTurns > 0
  ) {
    return stepExecutionCeilingStop({
      ceiling: "provider-turns",
      breach: "at-the-bound",
      configured: maxProviderTurns,
      observed: providerTurns,
      ...budget,
    });
  }
  return undefined;
}

const CEILING_NOUNS: Record<StepExecutionCeiling, string> = {
  "tool-calls": "tool-call",
  "provider-turns": "provider-turn",
  compactions: "compaction",
};

/**
 * One line naming the code, the observed value against the ceiling, the
 * scope, and the remediation. Interpolates only host vocabulary: the step id,
 * limit identities, and numbers.
 */
export function formatStepExecutionLimitStop(
  stepId: string,
  limitStop: StepExecutionLimitStop,
): string {
  const verb = limitStop.observed > limitStop.configured ? "exceeded" : "used all of";
  return (
    `${limitStop.code}: workflow step "${stepId}" ${verb} its ` +
    `${CEILING_NOUNS[limitStop.ceiling]} ceiling of ${String(limitStop.configured)} ` +
    `${limitStop.unit} (observed ${String(limitStop.observed)} ${limitStop.unit}). ` +
    `Scope: one attempt of this step. ${limitStop.remediation}`
  );
}
