// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  CorpusCase,
  CorpusDestination,
  CorpusLiveCohortIdentity,
  CorpusMetrics,
  CorpusObservationSet,
  CorpusRunObservation,
  LivingDocumentationDataset,
} from "../corpus.js";

export function computeMetrics(
  dataset: LivingDocumentationDataset,
  runs: CorpusRunObservation[],
): CorpusMetrics {
  let evidenceRequired = 0;
  let evidenceObserved = 0;
  let answerCount = 0;
  let placementMatches = 0;
  let retrievalCount = 0;
  let recalledAt3 = 0;
  let reciprocalRank = 0;
  let observedNoResultCount = 0;
  let correctNoResultCount = 0;
  for (const run of runs) {
    const corpusCase = dataset.cases.find((item) => item.id === run.caseId)!;
    const observedEvidence = new Set(run.evidenceNodeIds);
    evidenceRequired += corpusCase.requiredEvidenceNodeIds.length;
    evidenceObserved += corpusCase.requiredEvidenceNodeIds.filter((id) =>
      observedEvidence.has(id),
    ).length;
    for (const answer of corpusCase.knownAnswers) {
      answerCount += 1;
      const accepted = [...answer.expected, ...answer.acceptableAlternatives];
      const placement =
        run.placements.find((item) => item.answerId === answer.id)?.destination ?? null;
      const ranking = run.rankings.find((item) => item.answerId === answer.id)?.destinations ?? [];
      if (ranking.length === 0) observedNoResultCount += 1;
      if (answer.kind === "negative-control") {
        if (ranking.length === 0 && placement === null) correctNoResultCount += 1;
        continue;
      }
      if (placement && accepted.some((destination) => sameDestination(destination, placement)))
        placementMatches += 1;
      const rank = ranking.findIndex((destination) =>
        accepted.some((expected) => sameDestination(expected, destination)),
      );
      retrievalCount += 1;
      if (rank >= 0 && rank < 3) recalledAt3 += 1;
      if (rank >= 0) reciprocalRank += 1 / (rank + 1);
    }
  }
  const latencies = runs.map((run) => run.metrics.latencyMs).sort((left, right) => left - right);
  const costs = runs.map((run) => run.metrics.usage.cost);
  const input = runs.reduce((total, run) => total + run.metrics.usage.input, 0);
  const output = runs.reduce((total, run) => total + run.metrics.usage.output, 0);
  const cacheRead = runs.reduce((total, run) => total + run.metrics.usage.cacheRead, 0);
  const cacheWrite = runs.reduce((total, run) => total + run.metrics.usage.cacheWrite, 0);
  const turns = runs.reduce((total, run) => total + run.metrics.usage.turns, 0);
  return {
    artifactValidityRate: ratio(runs.filter((run) => run.artifactValid).length, runs.length),
    evidenceCoverage: ratio(evidenceObserved, evidenceRequired),
    orphanCount: runs.reduce((total, run) => total + run.orphanNodeIds.length, 0),
    duplicateCanonicalHomeCount: runs.reduce(
      (total, run) => total + run.duplicateCanonicalHomes.length,
      0,
    ),
    placementAgreement: ratio(placementMatches + correctNoResultCount, answerCount),
    recallAt3: ratio(recalledAt3, retrievalCount),
    meanReciprocalRank: ratio(reciprocalRank, retrievalCount),
    noResultRate: ratio(observedNoResultCount, answerCount),
    providerBlanks: runs.filter((run) => run.provider.failureClass === "blank-response").length,
    unclassifiedFailures: runs.filter(
      (run) => run.provider.outcome !== "succeeded" && !run.provider.failureClass,
    ).length,
    latencyMs: {
      minimum: latencies[0] ?? 0,
      median: percentile(latencies, 0.5),
      maximum: latencies.at(-1) ?? 0,
    },
    tokens: {
      input,
      output,
      cacheRead,
      cacheWrite,
      total: input + output + cacheRead + cacheWrite,
      turns,
    },
    costUsd: costs.some((value) => value === undefined)
      ? null
      : rounded(costs.reduce<number>((total, value) => total + (value ?? 0), 0)),
  };
}

export function evaluateFiveRunReliability(
  dataset: LivingDocumentationDataset,
  observations: CorpusObservationSet,
): boolean {
  if (observations.mode !== "live") return true;
  return dataset.cases
    .filter((item) => item.planning && item.expectedDisposition === "recommendation-ready")
    .every((corpusCase) => {
      const runs = observations.runs.filter((run) => run.caseId === corpusCase.id);
      if (runs.length !== 5) return false;
      const topology = canonicalGrouping(runs[0]!.majorGroupings);
      if (
        corpusCase.expectedDisposition === "recommendation-ready" &&
        (runs[0]!.majorGroupings.length === 0 ||
          runs[0]!.majorGroupings.every((group) => group.length === 0))
      ) {
        return false;
      }
      return runs.every(
        (run) =>
          run.provider.outcome === "succeeded" &&
          run.provider.failureClass === undefined &&
          run.artifactValid &&
          canonicalGrouping(run.majorGroupings) === topology,
      );
    });
}

export function canonicalGrouping(groups: string[][]): string {
  return JSON.stringify(
    groups
      .map((group) => [...group].sort())
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
  );
}

export function destinationKey(value: CorpusDestination): string {
  return `${value.nodeId}\0${value.path}\0${value.url}\0${value.anchor ?? ""}`;
}

export function sameDestination(left: CorpusDestination, right: CorpusDestination): boolean {
  return destinationKey(left) === destinationKey(right);
}

export function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : rounded(numerator / denominator);
}

export function percentile(values: number[], point: number): number {
  return values.length === 0 ? 0 : values[Math.floor((values.length - 1) * point)]!;
}

export function rounded(value: number): number {
  return Number(value.toFixed(12));
}
