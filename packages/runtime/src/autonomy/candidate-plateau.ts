// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { candidateFail } from "./candidate-attempt.js";
import { createCandidateDialect, deepFreeze } from "./candidate-dialect.js";
import type { CandidateKeepDiscardDecisionV1 } from "./candidate-keep-discard.js";

const kit = createCandidateDialect(candidateFail);

export const CANDIDATE_TERMINAL_REASONS = [
  "kept-improved",
  "budget-exhausted",
  "plateau",
  "no-eligible-candidate",
] as const;
export type CandidateTerminalReason = (typeof CANDIDATE_TERMINAL_REASONS)[number];

export interface CandidateExperimentBudgetV1 {
  schemaVersion: 1;
  kind: "docsfab-candidate-experiment-budget";
  maxAttempts: number;
  maxElapsedMs: number;
  maxTokens: number;
  maxCostUnits: number;
  budgetSha256: string;
}

export interface CandidateExperimentConsumptionV1 {
  attempts: number;
  elapsedMs: number;
  tokens: number;
  costUnits: number;
}

export interface CandidatePlateauPolicyV1 {
  schemaVersion: 1;
  kind: "docsfab-candidate-plateau-policy";
  /** Consecutive non-improving decisions before the plateau stop. */
  consecutiveNonImprovingLimit: number;
  policySha256: string;
}

export interface CandidateTerminalStateV1 {
  schemaVersion: 1;
  kind: "docsfab-candidate-terminal-state";
  reason: CandidateTerminalReason;
  /** Successful bounded stop — not fabricated quality success. */
  boundedSuccess: true;
  selectedCandidateSha256: string;
  sourceCheckoutSha256: string;
  consumption: CandidateExperimentConsumptionV1;
  terminalSha256: string;
}

export function sealCandidateExperimentBudget(input: {
  maxAttempts: number;
  maxElapsedMs: number;
  maxTokens: number;
  maxCostUnits: number;
}): CandidateExperimentBudgetV1 {
  kit.assertInert(input);
  kit.rejectCredentials(input);
  const maxAttempts = requirePositiveInt(input.maxAttempts);
  const maxElapsedMs = requirePositiveInt(input.maxElapsedMs);
  const maxTokens = requireNonNegativeInt(input.maxTokens);
  const maxCostUnits = requireNonNegativeInt(input.maxCostUnits);
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-candidate-experiment-budget" as const,
    maxAttempts,
    maxElapsedMs,
    maxTokens,
    maxCostUnits,
  };
  return deepFreeze({
    ...body,
    budgetSha256: kit.canonicalDigest(body),
  });
}

export function sealCandidatePlateauPolicy(input: {
  consecutiveNonImprovingLimit: number;
}): CandidatePlateauPolicyV1 {
  kit.assertInert(input);
  kit.rejectCredentials(input);
  const consecutiveNonImprovingLimit = requirePositiveInt(input.consecutiveNonImprovingLimit);
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-candidate-plateau-policy" as const,
    consecutiveNonImprovingLimit,
  };
  return deepFreeze({
    ...body,
    policySha256: kit.canonicalDigest(body),
  });
}

export function normalizeConsumption(
  value: CandidateExperimentConsumptionV1,
): CandidateExperimentConsumptionV1 {
  return deepFreeze({
    attempts: requireNonNegativeInt(value.attempts),
    elapsedMs: requireNonNegativeInt(value.elapsedMs),
    tokens: requireNonNegativeInt(value.tokens),
    costUnits: requireNonNegativeInt(value.costUnits),
  });
}

export function budgetExhausted(
  budget: CandidateExperimentBudgetV1,
  consumption: CandidateExperimentConsumptionV1,
): boolean {
  const current = normalizeConsumption(consumption);
  return (
    current.attempts >= budget.maxAttempts ||
    current.elapsedMs >= budget.maxElapsedMs ||
    current.tokens >= budget.maxTokens ||
    current.costUnits >= budget.maxCostUnits
  );
}

/** Count trailing non-improving decisions (discard or identical); a keep resets. */
export function consecutiveNonImprovingCount(
  decisions: readonly CandidateKeepDiscardDecisionV1[],
): number {
  let count = 0;
  for (let index = decisions.length - 1; index >= 0; index -= 1) {
    if (decisions[index]!.disposition === "keep") break;
    count += 1;
  }
  return count;
}

export function plateauReached(
  policy: CandidatePlateauPolicyV1,
  decisions: readonly CandidateKeepDiscardDecisionV1[],
): boolean {
  return consecutiveNonImprovingCount(decisions) >= policy.consecutiveNonImprovingLimit;
}

export function sealCandidateTerminalState(input: {
  reason: CandidateTerminalReason;
  selectedCandidateSha256: string;
  sourceCheckoutSha256: string;
  consumption: CandidateExperimentConsumptionV1;
}): CandidateTerminalStateV1 {
  kit.assertInert(input);
  kit.rejectCredentials(input);
  const reason = kit.enumeration(input.reason, CANDIDATE_TERMINAL_REASONS);
  const consumption = normalizeConsumption(input.consumption);
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-candidate-terminal-state" as const,
    reason,
    boundedSuccess: true as const,
    selectedCandidateSha256: kit.hash(input.selectedCandidateSha256),
    sourceCheckoutSha256: kit.hash(input.sourceCheckoutSha256),
    consumption,
  };
  return deepFreeze({
    ...body,
    terminalSha256: kit.canonicalDigest(body),
  });
}

export function decodeCandidateTerminalState(value: unknown): CandidateTerminalStateV1 {
  return kit.decodeSealed(
    value,
    "docsfab-candidate-terminal-state",
    "terminalSha256",
    ["reason", "boundedSuccess", "selectedCandidateSha256", "sourceCheckoutSha256", "consumption"],
    (root) => {
      const sealed = sealCandidateTerminalState({
        reason: root.reason as CandidateTerminalReason,
        selectedCandidateSha256: root.selectedCandidateSha256 as string,
        sourceCheckoutSha256: root.sourceCheckoutSha256 as string,
        consumption: root.consumption as CandidateExperimentConsumptionV1,
      });
      const {
        schemaVersion: _schemaVersion,
        kind: _kind,
        terminalSha256: _terminalSha256,
        ...body
      } = sealed;
      return body;
    },
  );
}

function requirePositiveInt(value: number): number {
  if (!Number.isInteger(value) || value < 1 || !Number.isSafeInteger(value)) {
    candidateFail("invalid-value");
  }
  return value;
}

function requireNonNegativeInt(value: number): number {
  if (!Number.isInteger(value) || value < 0 || !Number.isSafeInteger(value)) {
    candidateFail("invalid-value");
  }
  return value;
}
