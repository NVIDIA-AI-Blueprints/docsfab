// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Canonical, synthetic probe/lease evidence for outcome projection controls. */
import { createHash } from "node:crypto";
import {
  createExecutionCheckpoint,
  createExecutionLeaseIdentity,
  createExecutionLeasePolicy,
  createExecutionLeaseState,
  decideExecutionLeaseRenewal,
  type ExecutionCheckpointV1,
  type ExecutionLeaseDecisionV1,
  type ExecutionLeaseStateV1,
} from "../../src/execution/index.js";
import {
  createBoundedSearchEvidence,
  createSearchConfidence,
  createSearchCoverage,
  createSearchFinding,
  createSearchLimitation,
  createSearchProbe,
  createSearchProgressEvidence,
  createSearchProgressEvent,
  createSearchProgressExecutionAuthority,
  createSearchProgressObservation,
  createSearchProgressPolicy,
  createSearchRemainingWorkRationale,
  type SearchProbeOutcome,
  type SearchTargetV1,
  type SearchProgressObservationV1,
  type SearchLimitationCategory,
} from "../../src/search/index.js";
import type {
  WorkflowSearchResultV1,
  WorkflowSearchStepEvidenceV1,
} from "../../src/workflow-contracts/contracts.js";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

export function searchEvidenceFixture(
  target: SearchTargetV1,
  outcomes: Readonly<Record<string, SearchProbeOutcome>>,
  blockedCategory: SearchLimitationCategory = "unsupported-operation",
): WorkflowSearchResultV1 {
  const probes = target.requiredProbes.map((declaration) => {
    const outcome = outcomes[declaration.id] ?? "inconclusive";
    return createSearchProbe(
      {
        ...declaration,
        scopeSha256: sha(`scope:${declaration.id}`),
        outcome,
        matchCount: outcome === "match" ? 1 : 0,
        evidenceSha256: sha(`evidence:${declaration.id}:${outcome}`),
        citations:
          outcome === "match"
            ? [{ path: "docs/guide.md", anchorSha256: sha(`fixture-anchor:${declaration.id}`) }]
            : [],
      },
      target,
    );
  });
  const blocked = probes.filter((probe) => probe.outcome === "blocked");
  const limitations = blocked.length
    ? [
        createSearchLimitation(
          {
            id: "fixture-limitation",
            category: blockedCategory,
            impact: "blocking",
            probeIds: blocked.map((probe) => probe.id),
            detailSha256: sha("fixture-detail"),
          },
          target,
          probes,
        ),
      ]
    : [];
  const first = probes.map((probe, index) =>
    createSearchProgressEvent(
      {
        sequence: index + 1,
        category:
          probe.outcome === "blocked"
            ? blockedCategory === "access-denied"
              ? "authorization-denied"
              : "unsupported-operation"
            : "evidence-produced",
        operationSha256: sha(`operation:${probe.id}`),
        probeId: probe.id,
        probeSha256: probe.probeSha256,
        evidenceSha256: probe.outcome === "blocked" ? null : probe.evidenceSha256,
        limitationSha256: probe.outcome === "blocked" ? limitations[0]!.limitationSha256 : null,
        citations: probe.citations,
      },
      target,
      probes,
      limitations,
    ),
  );
  const repeat = () =>
    probes.map((_probe, index) =>
      createSearchProgressEvent(
        {
          sequence: index + 1,
          category: "no-new-evidence",
          operationSha256: sha(`repeat:${index}`),
          probeId: null,
          probeSha256: null,
          evidenceSha256: null,
          limitationSha256: null,
          citations: [],
        },
        target,
        probes,
        limitations,
      ),
    );
  const leases = probes.every((probe) => probe.outcome === "no-match")
    ? [first, repeat(), repeat()]
    : [first];
  const callsPerLease = probes.length;
  const policy = createExecutionLeasePolicy({
    callsPerLease,
    maxLeases: 4,
    hardToolCallCeiling: callsPerLease * 4,
    maxProviderTurns: 16,
    maxCompactions: 4,
    cumulative: { maxInputTokens: 10_000, maxOutputTokens: 10_000, maxElapsedMs: 10_000 },
  });
  const identity = createExecutionLeaseIdentity({
    inferenceAttempt: 1,
    retriesConsumed: 0,
    authorizationSha256: null,
    repositoryRevision: target.repository.revision,
    contextPacketSha256: null,
    evidenceSha256: sha("inventory"),
    toolPolicySha256: sha("tools"),
    contextAuthoritySha256: sha("context"),
    policySha256: policy.policySha256,
  });
  const checkpoints: ExecutionCheckpointV1[] = [],
    decisions: ExecutionLeaseDecisionV1[] = [];
  const observations: SearchProgressObservationV1[] = [];
  let previous: ExecutionLeaseStateV1 | undefined;
  const totals = {
    requested: 0,
    executed: 0,
    succeeded: 0,
    failed: 0,
    denied: 0,
    governanceBlocked: 0,
  };
  let execution;
  for (const [index, events] of leases.entries()) {
    const denied = events.filter((event) => event.category === "authorization-denied").length;
    const succeeded = events.filter(
      (event) => event.category === "evidence-produced" || event.category === "no-new-evidence",
    ).length;
    const failed = events.length - denied - succeeded;
    totals.requested += events.length;
    totals.executed += succeeded + failed;
    totals.succeeded += succeeded;
    totals.failed += failed;
    totals.denied += denied;
    const state = createExecutionLeaseState(
      {
        leaseNumber: index + 1,
        leaseExecutedToolCalls: succeeded + failed,
        providerTurns: index + 1,
        compactions: 0,
        toolCalls: { ...totals },
        cumulativeInputTokens: index + 1,
        cumulativeOutputTokens: index + 1,
        elapsedMs: index + 1,
        cost: { status: "known", microusd: 0 },
        lastCheckpointSha256: checkpoints.at(-1)?.checkpointSha256 ?? null,
      },
      policy,
      previous,
    );
    const checkpoint = createExecutionCheckpoint({
      policy,
      identity,
      state,
      reason: index === leases.length - 1 ? "workflow-completed" : "lease-exhausted",
      ...(checkpoints.length ? { previous: checkpoints.at(-1)! } : {}),
    });
    checkpoints.push(checkpoint);
    previous = state;
    execution = createSearchProgressExecutionAuthority({
      target,
      policy,
      identity,
      checkpoints,
      decisions,
    });
    observations.push(
      createSearchProgressObservation({
        target,
        probes,
        limitations,
        execution,
        events,
        previousObservations: observations,
      }),
    );
    if (index < leases.length - 1)
      decisions.push(
        decideExecutionLeaseRenewal({
          policy,
          identity,
          checkpoint,
          ...(index
            ? { history: { checkpoints: checkpoints.slice(0, -1), decisions: [...decisions] } }
            : {}),
        }),
      );
  }
  const current = observations.at(-1)!;
  const rationale = createSearchRemainingWorkRationale({
    target,
    category: current.remainingRequiredProbeIds.length ? "required-probes" : "none",
    remainingRequiredProbeIds: current.remainingRequiredProbeIds,
    remainingWorkCount: current.remainingRequiredProbeIds.length,
    detailSha256: sha("remaining-work"),
    citations: [],
  });
  const progress = createSearchProgressEvidence({
    policy: createSearchProgressPolicy(),
    execution: execution!,
    target,
    probes,
    limitations,
    observations,
    rationale,
  });
  const coverage = createSearchCoverage({
    target,
    probes,
    limitations,
    blockerDisclosure: { status: "complete", undisclosedBlockerCount: 0 },
  });
  const confidence = createSearchConfidence({
    target,
    probes,
    limitations,
    coverage,
    disposition: progress.recommendation.disposition,
    saturation: progress.recommendation.saturation,
  });
  const finding = createSearchFinding({ target, probes, limitations, coverage, confidence });
  return {
    targetId: target.id,
    bounded: createBoundedSearchEvidence({
      target,
      probes,
      limitations,
      coverage,
      confidence,
      finding,
    }),
    progress,
  };
}

/**
 * A typed step search-evidence object for harness fixtures that need only its
 * identity digests. It carries the full shape (an empty `searches` list unless
 * given), so code that renders or decodes the evidence sees a real object.
 */
export function searchStepEvidence(
  overrides: Partial<WorkflowSearchStepEvidenceV1> = {},
): WorkflowSearchStepEvidenceV1 {
  return {
    schemaVersion: 1,
    kind: "docsfab-workflow-search-evidence",
    planId: "documentation-audit-discovery",
    planVersion: "1.0.0",
    workspaceSnapshotSha256: "c".repeat(64),
    searches: [],
    evidenceSha256: "b".repeat(64),
    ...overrides,
  };
}
