// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  sealCandidateAttempt,
  type CandidateAttemptInputV1,
  type CandidateAttemptV1,
  type CandidateBaselineV1,
  type CandidateEvaluationVectorV1,
  candidateFail,
} from "./candidate-attempt.js";
import { createCandidateDialect, deepFreeze } from "./candidate-dialect.js";
import {
  decideCandidateKeepDiscard,
  type CandidateKeepDiscardDecisionV1,
} from "./candidate-keep-discard.js";
import {
  budgetExhausted,
  normalizeConsumption,
  plateauReached,
  sealCandidateTerminalState,
  type CandidateExperimentBudgetV1,
  type CandidateExperimentConsumptionV1,
  type CandidatePlateauPolicyV1,
  type CandidateTerminalStateV1,
} from "./candidate-plateau.js";

const kit = createCandidateDialect(candidateFail);

export interface CandidateExperimentLedgerEntryV1 {
  schemaVersion: 1;
  kind: "docsfab-candidate-experiment-ledger-entry";
  sequence: number;
  attempt: CandidateAttemptV1;
  decision: CandidateKeepDiscardDecisionV1;
  entrySha256: string;
}

export interface CandidateExperimentLedgerV1 {
  schemaVersion: 1;
  kind: "docsfab-candidate-experiment-ledger";
  experimentId: string;
  baselineSha256: string;
  sourceCheckoutSha256: string;
  selectedCandidateSha256: string;
  selectedEvaluation: CandidateEvaluationVectorV1;
  budget: CandidateExperimentBudgetV1;
  plateau: CandidatePlateauPolicyV1;
  consumption: CandidateExperimentConsumptionV1;
  entries: readonly CandidateExperimentLedgerEntryV1[];
  terminal: CandidateTerminalStateV1 | null;
  ledgerSha256: string;
}

export interface CandidateExperimentLoopResultV1 {
  ledger: CandidateExperimentLedgerV1;
  replayIdempotent: boolean;
}

export function createCandidateExperimentLedger(input: {
  experimentId: string;
  baseline: CandidateBaselineV1;
  budget: CandidateExperimentBudgetV1;
  plateau: CandidatePlateauPolicyV1;
}): CandidateExperimentLedgerV1 {
  kit.assertInert(input);
  kit.rejectCredentials(input);
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-candidate-experiment-ledger" as const,
    experimentId: kit.identifier(input.experimentId),
    baselineSha256: kit.hash(input.baseline.baselineSha256),
    sourceCheckoutSha256: kit.hash(input.baseline.sourceCheckoutSha256),
    selectedCandidateSha256: kit.hash(input.baseline.selectedCandidateSha256),
    selectedEvaluation: input.baseline.evaluation,
    budget: input.budget,
    plateau: input.plateau,
    consumption: normalizeConsumption({
      attempts: 0,
      elapsedMs: 0,
      tokens: 0,
      costUnits: 0,
    }),
    entries: Object.freeze([]) as readonly CandidateExperimentLedgerEntryV1[],
    terminal: null,
  };
  return deepFreeze({
    ...body,
    ledgerSha256: kit.canonicalDigest(body),
  });
}

/** Append one sealed attempt and its decision; an identical replay is a no-op. */
export function appendCandidateExperimentEntry(
  ledger: CandidateExperimentLedgerV1,
  input: {
    attempt: CandidateAttemptInputV1 | CandidateAttemptV1;
    selectedEvaluation?: CandidateEvaluationVectorV1;
    charge?: Partial<CandidateExperimentConsumptionV1>;
  },
): CandidateExperimentLoopResultV1 {
  kit.assertInert(input);
  kit.rejectCredentials(input);
  const current = decodeCandidateExperimentLedger(ledger);
  if (current.terminal !== null) {
    candidateFail("invalid-value");
  }

  const attempt =
    "attemptSha256" in input.attempt &&
    (input.attempt as CandidateAttemptV1).kind === "docsfab-candidate-attempt"
      ? (input.attempt as CandidateAttemptV1)
      : sealCandidateAttempt(input.attempt as CandidateAttemptInputV1);

  if (attempt.sourceCheckoutSha256 !== current.sourceCheckoutSha256) {
    candidateFail("workspace-isolation");
  }
  if (attempt.baselineSha256 !== current.baselineSha256) {
    candidateFail("invalid-value");
  }

  // Check replay before re-deciding: a moved selected candidate would otherwise
  // mint a conflicting decision.
  const existingAttempt = current.entries.find(
    (entry) => entry.attempt.attemptSha256 === attempt.attemptSha256,
  );
  if (existingAttempt) {
    return { ledger: current, replayIdempotent: true };
  }

  const priorSelected = current.selectedCandidateSha256;
  const selectedEvaluation = input.selectedEvaluation ?? current.selectedEvaluation;
  const decision = decideCandidateKeepDiscard({
    attempt,
    baseline: {
      schemaVersion: 1,
      kind: "docsfab-candidate-baseline",
      sourceCheckoutSha256: current.sourceCheckoutSha256,
      selectedCandidateSha256: priorSelected,
      evaluation: current.selectedEvaluation,
      baselineSha256: current.baselineSha256,
    },
    selectedEvaluation,
    priorSelectedCandidateSha256: priorSelected,
  });

  const charge = normalizeConsumption({
    attempts: (input.charge?.attempts ?? 1) + current.consumption.attempts,
    elapsedMs: (input.charge?.elapsedMs ?? 0) + current.consumption.elapsedMs,
    tokens: (input.charge?.tokens ?? 0) + current.consumption.tokens,
    costUnits: (input.charge?.costUnits ?? 0) + current.consumption.costUnits,
  });

  const entry = sealEntry({
    sequence: current.entries.length,
    attempt,
    decision,
  });

  const entries = Object.freeze([...current.entries, entry]);
  const selectedCandidateSha256 = decision.selectedCandidateSha256;
  const nextSelectedEvaluation =
    decision.disposition === "keep" ? attempt.evaluation : selectedEvaluation;

  let terminal: CandidateTerminalStateV1 | null = null;
  if (budgetExhausted(current.budget, charge)) {
    terminal = sealCandidateTerminalState({
      reason: "budget-exhausted",
      selectedCandidateSha256,
      sourceCheckoutSha256: current.sourceCheckoutSha256,
      consumption: charge,
    });
  } else if (
    plateauReached(
      current.plateau,
      entries.map((item) => item.decision),
    )
  ) {
    terminal = sealCandidateTerminalState({
      reason: "plateau",
      selectedCandidateSha256,
      sourceCheckoutSha256: current.sourceCheckoutSha256,
      consumption: charge,
    });
  } else if (decision.disposition === "keep") {
    // Keep alone does not terminate; caller may continue until plateau/budget.
  }

  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-candidate-experiment-ledger" as const,
    experimentId: current.experimentId,
    baselineSha256: current.baselineSha256,
    sourceCheckoutSha256: current.sourceCheckoutSha256,
    selectedCandidateSha256,
    selectedEvaluation: nextSelectedEvaluation,
    budget: current.budget,
    plateau: current.plateau,
    consumption: charge,
    entries,
    terminal,
  };
  return {
    ledger: deepFreeze({
      ...body,
      ledgerSha256: kit.canonicalDigest(body),
    }),
    replayIdempotent: false,
  };
}

/**
 * Run a bounded candidate loop. Generators produce isolated disposable
 * candidates; discard never mutates source or prior selected identity except
 * via an explicit keep decision on the ledger.
 */
export function runBoundedCandidateExperiment(input: {
  experimentId: string;
  baseline: CandidateBaselineV1;
  budget: CandidateExperimentBudgetV1;
  plateau: CandidatePlateauPolicyV1;
  /** Must match the experiment identity. */
  ledger?: CandidateExperimentLedgerV1;
  generateAttempt: (context: {
    attemptIndex: number;
    selectedCandidateSha256: string;
    selectedEvaluation: CandidateEvaluationVectorV1;
    sourceCheckoutSha256: string;
    baselineSha256: string;
  }) => CandidateAttemptInputV1 | CandidateAttemptV1 | null;
  chargeForAttempt?: (attempt: CandidateAttemptV1) => Partial<CandidateExperimentConsumptionV1>;
}): CandidateExperimentLoopResultV1 {
  kit.assertInert({
    experimentId: input.experimentId,
    baseline: input.baseline,
    budget: input.budget,
    plateau: input.plateau,
  });
  kit.rejectCredentials({
    experimentId: input.experimentId,
    baseline: input.baseline,
    budget: input.budget,
    plateau: input.plateau,
  });

  let ledger = input.ledger
    ? decodeCandidateExperimentLedger(input.ledger)
    : createCandidateExperimentLedger({
        experimentId: input.experimentId,
        baseline: input.baseline,
        budget: input.budget,
        plateau: input.plateau,
      });

  if (ledger.experimentId !== kit.identifier(input.experimentId)) {
    candidateFail("invalid-value");
  }
  if (ledger.baselineSha256 !== input.baseline.baselineSha256) {
    candidateFail("invalid-value");
  }

  let replayIdempotent = false;
  while (ledger.terminal === null) {
    if (budgetExhausted(ledger.budget, ledger.consumption)) {
      ledger = withTerminal(
        ledger,
        sealCandidateTerminalState({
          reason: "budget-exhausted",
          selectedCandidateSha256: ledger.selectedCandidateSha256,
          sourceCheckoutSha256: ledger.sourceCheckoutSha256,
          consumption: ledger.consumption,
        }),
      );
      break;
    }

    const attemptIndex = ledger.entries.length;
    const generated = input.generateAttempt({
      attemptIndex,
      selectedCandidateSha256: ledger.selectedCandidateSha256,
      selectedEvaluation: ledger.selectedEvaluation,
      sourceCheckoutSha256: ledger.sourceCheckoutSha256,
      baselineSha256: ledger.baselineSha256,
    });

    if (generated === null) {
      ledger = withTerminal(
        ledger,
        sealCandidateTerminalState({
          reason: ledger.entries.some((entry) => entry.decision.disposition === "keep")
            ? "kept-improved"
            : "no-eligible-candidate",
          selectedCandidateSha256: ledger.selectedCandidateSha256,
          sourceCheckoutSha256: ledger.sourceCheckoutSha256,
          consumption: ledger.consumption,
        }),
      );
      break;
    }

    const result = appendCandidateExperimentEntry(ledger, {
      attempt: generated,
      charge: (() => {
        const attempt =
          "attemptSha256" in generated &&
          (generated as CandidateAttemptV1).kind === "docsfab-candidate-attempt"
            ? (generated as CandidateAttemptV1)
            : sealCandidateAttempt(generated as CandidateAttemptInputV1);
        return input.chargeForAttempt?.(attempt) ?? { attempts: 1 };
      })(),
    });
    replayIdempotent = result.replayIdempotent;
    if (result.replayIdempotent) {
      // Identical replay: stop without fabricating additional attempts.
      break;
    }
    ledger = result.ledger;
  }

  return { ledger, replayIdempotent };
}

export function decodeCandidateExperimentLedger(value: unknown): CandidateExperimentLedgerV1 {
  return kit.decodeSealed(
    value,
    "docsfab-candidate-experiment-ledger",
    "ledgerSha256",
    [
      "experimentId",
      "baselineSha256",
      "sourceCheckoutSha256",
      "selectedCandidateSha256",
      "selectedEvaluation",
      "budget",
      "plateau",
      "consumption",
      "entries",
      "terminal",
    ],
    (root) => {
      const experimentId = kit.identifier(root.experimentId);
      const baselineSha256 = kit.hash(root.baselineSha256);
      const sourceCheckoutSha256 = kit.hash(root.sourceCheckoutSha256);
      const selectedCandidateSha256 = kit.hash(root.selectedCandidateSha256);
      const selectedEvaluation = root.selectedEvaluation as CandidateEvaluationVectorV1;
      const budget = root.budget as CandidateExperimentBudgetV1;
      const plateau = root.plateau as CandidatePlateauPolicyV1;
      const consumption = normalizeConsumption(
        root.consumption as CandidateExperimentConsumptionV1,
      );
      const entries = Object.freeze(kit.array(root.entries).map((entry) => decodeEntry(entry)));
      const terminal = root.terminal === null ? null : (root.terminal as CandidateTerminalStateV1);
      return {
        experimentId,
        baselineSha256,
        sourceCheckoutSha256,
        selectedCandidateSha256,
        selectedEvaluation,
        budget,
        plateau,
        consumption,
        entries,
        terminal,
      };
    },
  );
}

function sealEntry(input: {
  sequence: number;
  attempt: CandidateAttemptV1;
  decision: CandidateKeepDiscardDecisionV1;
}): CandidateExperimentLedgerEntryV1 {
  if (!Number.isInteger(input.sequence) || input.sequence < 0) {
    candidateFail("invalid-value");
  }
  if (input.decision.attemptSha256 !== input.attempt.attemptSha256) {
    candidateFail("invalid-value");
  }
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-candidate-experiment-ledger-entry" as const,
    sequence: input.sequence,
    attempt: input.attempt,
    decision: input.decision,
  };
  return deepFreeze({
    ...body,
    entrySha256: kit.canonicalDigest(body),
  });
}

function decodeEntry(value: unknown): CandidateExperimentLedgerEntryV1 {
  const root = kit.object(value);
  kit.exact(root, ["schemaVersion", "kind", "sequence", "attempt", "decision", "entrySha256"]);
  if (root.schemaVersion !== 1 || root.kind !== "docsfab-candidate-experiment-ledger-entry") {
    candidateFail("schema-mismatch");
  }
  return sealEntry({
    sequence: root.sequence as number,
    attempt: root.attempt as CandidateAttemptV1,
    decision: root.decision as CandidateKeepDiscardDecisionV1,
  });
}

function withTerminal(
  ledger: CandidateExperimentLedgerV1,
  terminal: CandidateTerminalStateV1,
): CandidateExperimentLedgerV1 {
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-candidate-experiment-ledger" as const,
    experimentId: ledger.experimentId,
    baselineSha256: ledger.baselineSha256,
    sourceCheckoutSha256: ledger.sourceCheckoutSha256,
    selectedCandidateSha256: ledger.selectedCandidateSha256,
    selectedEvaluation: ledger.selectedEvaluation,
    budget: ledger.budget,
    plateau: ledger.plateau,
    consumption: ledger.consumption,
    entries: ledger.entries,
    terminal,
  };
  return deepFreeze({
    ...body,
    ledgerSha256: kit.canonicalDigest(body),
  });
}
