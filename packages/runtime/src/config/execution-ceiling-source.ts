// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * What set the execution ceiling a step stopped at. Kept apart from
 * `execution-limit-stops.ts`, which the attempt classifier imports, because it
 * fits the catalog lease shape and so reads the lease contracts.
 */
import {
  EXECUTION_LEASE_DEFAULTS,
  resolveLeaseShapeForTurns,
} from "../execution/lease-contracts.js";
import type { StepExecutionLimitStop } from "./execution-limit-stops.js";
import { OPERATIONAL_LIMIT_NAMES, type OperationalLimitName } from "./limit-stop.js";
import { LIMIT_DEFINITION_BY_NAME } from "./limits.generated.js";

/**
 * What set the ceiling a step stopped at, read only from the run record and
 * the catalog, never from the process that reads it:
 *
 * - `sealed-budget`: the composition's sealed provider-turn budget, directly
 *   or as the tool-call ceiling fitted to it. Only re-qualifying the
 *   composition raises it.
 * - `host-limit`: a host execution limit at its catalog value, as the run host
 *   recorded it.
 * - `operator-override`: a host value an operator override lowered below its
 *   catalog value.
 * - `limits-not-recorded`: the record does not carry the run host's configured
 *   provider-turn limit and the composition's sealed budgets, so a sealed
 *   budget and an override cannot be told apart.
 * - `codes-mismatch`: the recorded ceiling code names a ceiling that the
 *   stopped attempt's turn, lease, and recorded limits do not explain.
 */
export const STEP_EXECUTION_CEILING_SOURCES = Object.freeze([
  "sealed-budget",
  "host-limit",
  "operator-override",
  "limits-not-recorded",
  "codes-mismatch",
] as const);

export type StepExecutionCeilingSource = (typeof STEP_EXECUTION_CEILING_SOURCES)[number];

export function isStepExecutionCeilingSource(value: unknown): value is StepExecutionCeilingSource {
  return (STEP_EXECUTION_CEILING_SOURCES as readonly unknown[]).includes(value);
}

/**
 * The provider-turn values a composition run records about its own limits
 * (`compositionExecution.limits`): the run host's configured value, after any
 * override, and the smallest sealed budget (candidate, composition, package).
 */
export interface RecordedProviderTurnLimits {
  readonly configured: number;
  readonly sealed: number;
}

function catalogValue(name: OperationalLimitName): number {
  return LIMIT_DEFINITION_BY_NAME[name]!.value;
}

/**
 * What set a provider-turn budget, from the record: the sealed budget when the
 * budget is it, else the run host's configured value, which is an override
 * when it is below the catalog value.
 */
function providerTurnBudgetSource(
  maxProviderTurns: number,
  recorded: RecordedProviderTurnLimits | undefined,
): StepExecutionCeilingSource {
  if (recorded === undefined) return "limits-not-recorded";
  if (maxProviderTurns === recorded.sealed) return "sealed-budget";
  if (maxProviderTurns !== recorded.configured) return "codes-mismatch";
  return recorded.configured < catalogValue(OPERATIONAL_LIMIT_NAMES.compositionMaxProviderTurns)
    ? "operator-override"
    : "host-limit";
}

/**
 * The source of the ceiling `stop` names. A tool-call ceiling below its
 * catalog value is the one the catalog lease shape fits to the step's
 * provider-turn budget, so it has that budget's source; a ceiling lower than
 * that fit was lowered by an override.
 */
export function stepExecutionCeilingSource(
  stop: Pick<StepExecutionLimitStop, "ceiling" | "configured" | "providerTurnBudget">,
  recorded: RecordedProviderTurnLimits | undefined,
): StepExecutionCeilingSource {
  switch (stop.ceiling) {
    case "provider-turns":
      return providerTurnBudgetSource(stop.configured, recorded);
    case "tool-calls": {
      if (stop.configured >= catalogValue(OPERATIONAL_LIMIT_NAMES.compositionMaxToolCallsPerStep)) {
        return "host-limit";
      }
      const budget = stop.providerTurnBudget;
      // A fitted ceiling is positive and leaves at least one turn of its
      // budget for a lease, so a budget at or below it cannot have set it.
      if (budget === undefined || stop.configured < 1 || budget <= stop.configured) {
        return "operator-override";
      }
      const fitted = resolveLeaseShapeForTurns(
        EXECUTION_LEASE_DEFAULTS,
        budget,
      ).hardToolCallCeiling;
      return stop.configured >= fitted
        ? providerTurnBudgetSource(budget, recorded)
        : "operator-override";
    }
    case "compactions":
      return stop.configured < catalogValue(OPERATIONAL_LIMIT_NAMES.governanceMaxCompactions)
        ? "operator-override"
        : "host-limit";
  }
}
