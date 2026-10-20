// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared bounded-search progress fixtures: synthetic probes, progress events,
 * execution-lease authority, and bounded evidence for readiness search targets.
 */
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
  createSearchProbe,
  createSearchProgressEvidence,
  createSearchProgressEvent,
  createSearchProgressExecutionAuthority,
  createSearchProgressObservation,
  createSearchProgressPolicy,
  createSearchRemainingWorkRationale,
  type SearchDisposition,
  type SearchLimitationV1,
  type SearchProbeOutcome,
  type SearchProbeV1,
  type SearchProgressEventCategory,
  type SearchProgressEventV1,
  type SearchProgressObservationV1,
  type SearchTargetV1,
} from "../../src/search/index.js";
import type { WorkflowSearchResultV1 } from "../../src/workflow-contracts/contracts.js";
import {
  instantiateWorkflowSearchTargets,
  normalizeWorkflowSearchEvidence,
} from "../../src/workflow-contracts/search.js";
import { getWorkflow } from "../../src/workflow-registry/catalog.js";

export const REPOSITORY_IDENTITY = "b".repeat(64);
const SHA = (value: string) => createHash("sha256").update(value).digest("hex");

export function readinessEvidenceAt(
  revision: string,
  create: (target: SearchTargetV1) => WorkflowSearchResultV1,
  workspaceSnapshotSha256?: string,
) {
  const readinessPlan = getWorkflow("readiness").steps[0]!.search!;
  const targets = instantiateWorkflowSearchTargets(readinessPlan, {
    identitySha256: REPOSITORY_IDENTITY,
    revision,
  });
  return normalizeWorkflowSearchEvidence({
    plan: readinessPlan,
    repository: {
      sourcePath: "/selected/source",
      requestedRevision: revision,
      revision,
    },
    repositoryIdentitySha256: REPOSITORY_IDENTITY,
    searches: targets.map(create),
    ...(workspaceSnapshotSha256 ? { workspaceSnapshotSha256 } : {}),
  });
}

export function terminalSearch(
  target: SearchTargetV1,
  disposition: SearchDisposition,
  outcome: SearchProbeOutcome,
): WorkflowSearchResultV1 {
  const probes = target.requiredProbes.map((declaration, index) =>
    probe(
      target,
      declaration.id,
      index === 0 ? outcome : outcome === "match" ? "no-match" : outcome,
    ),
  );
  const events = probes.map((item, index) =>
    event(target, probes, [], "evidence-produced", item, undefined, index + 1),
  );
  const execution = executionFor(target, [events], "workflow-completed");
  const observation = createSearchProgressObservation({
    target,
    probes,
    limitations: [],
    execution,
    events,
  });
  const progress = progressFor(target, probes, [], [observation], execution);
  return pair(target, probes, [], progress);
}

export function boundedAbsence(target: SearchTargetV1): WorkflowSearchResultV1 {
  const probes = target.requiredProbes.map((declaration) =>
    probe(target, declaration.id, "no-match"),
  );
  const leases: SearchProgressEventV1[][] = [
    probes.map((item, index) =>
      event(target, probes, [], "evidence-produced", item, undefined, index + 1),
    ),
    probes.map((_, index) =>
      event(target, probes, [], "no-new-evidence", undefined, undefined, index + 1),
    ),
    probes.map((_, index) =>
      event(target, probes, [], "no-new-evidence", undefined, undefined, index + 1),
    ),
  ];
  const observations: SearchProgressObservationV1[] = [];
  for (let index = 0; index < leases.length; index += 1) {
    const execution = executionFor(
      target,
      leases.slice(0, index + 1),
      index === leases.length - 1 ? "workflow-completed" : undefined,
    );
    observations.push(
      createSearchProgressObservation({
        target,
        probes,
        limitations: [],
        execution,
        events: leases[index]!,
        previousObservations: observations,
      }),
    );
  }
  const execution = executionFor(target, leases, "workflow-completed");
  return pair(target, probes, [], progressFor(target, probes, [], observations, execution));
}

export function pair(
  target: SearchTargetV1,
  probes: SearchProbeV1[],
  limitations: SearchLimitationV1[],
  progress: ReturnType<typeof createSearchProgressEvidence>,
): WorkflowSearchResultV1 {
  const coverage = createSearchCoverage({
    target,
    probes,
    limitations,
    blockerDisclosure: { status: "complete", undisclosedBlockerCount: 0 },
  });
  const confidence = createSearchConfidence({
    target,
    probes,
    coverage,
    limitations,
    disposition: progress.recommendation.disposition,
    saturation: progress.recommendation.saturation,
  });
  const finding = createSearchFinding({
    target,
    probes,
    limitations,
    coverage,
    confidence,
  });
  const bounded = createBoundedSearchEvidence({
    target,
    probes,
    limitations,
    coverage,
    confidence,
    finding,
  });
  return { targetId: target.id, bounded, progress };
}

export function progressFor(
  target: SearchTargetV1,
  probes: SearchProbeV1[],
  limitations: SearchLimitationV1[],
  observations: SearchProgressObservationV1[],
  execution: ReturnType<typeof createSearchProgressExecutionAuthority>,
) {
  const current = observations.at(-1)!;
  const rationale = createSearchRemainingWorkRationale({
    target,
    category: current.remainingRequiredProbeIds.length > 0 ? "required-probes" : "none",
    remainingRequiredProbeIds: current.remainingRequiredProbeIds,
    remainingWorkCount: current.remainingRequiredProbeIds.length,
    detailSha256: SHA("d"),
    citations: [],
  });
  return createSearchProgressEvidence({
    policy: createSearchProgressPolicy(),
    execution,
    target,
    probes,
    limitations,
    observations,
    rationale,
  });
}

export function probe(
  target: SearchTargetV1,
  id: string,
  outcome: SearchProbeOutcome,
): SearchProbeV1 {
  const declaration = target.requiredProbes.find((item) => item.id === id)!;
  return createSearchProbe(
    {
      id,
      strategy: declaration.strategy,
      location: declaration.location,
      scopeSha256: SHA(id.charAt(0) || "1"),
      outcome,
      matchCount: outcome === "match" ? 1 : 0,
      evidenceSha256: SHA(id.charAt(1) || "2"),
      citations: outcome === "match" ? [{ path: "docs/guide.md", anchorSha256: SHA("e") }] : [],
    },
    target,
  );
}

export function event(
  target: SearchTargetV1,
  probes: SearchProbeV1[],
  limitations: SearchLimitationV1[],
  category: SearchProgressEventCategory,
  item: SearchProbeV1 | undefined,
  limitation: SearchLimitationV1 | undefined,
  sequence: number,
): SearchProgressEventV1 {
  return createSearchProgressEvent(
    {
      sequence,
      category,
      operationSha256: SHA(String(sequence)),
      probeId: item?.id ?? null,
      probeSha256: item?.probeSha256 ?? null,
      evidenceSha256: category === "evidence-produced" ? (item?.evidenceSha256 ?? null) : null,
      limitationSha256: limitation?.limitationSha256 ?? null,
      citations: item?.citations ?? [],
    },
    target,
    probes,
    limitations,
  );
}

export function executionFor(
  target: SearchTargetV1,
  leases: SearchProgressEventV1[][],
  finalReason?: "workflow-completed",
) {
  const callsPerLease = Math.max(1, leases[0]!.length);
  const policy = createExecutionLeasePolicy({
    callsPerLease,
    maxLeases: 4,
    hardToolCallCeiling: callsPerLease * 4,
    maxProviderTurns: 16,
    maxCompactions: 4,
    cumulative: {
      maxInputTokens: 10_000,
      maxOutputTokens: 10_000,
      maxElapsedMs: 10_000,
    },
  });
  const identity = createExecutionLeaseIdentity({
    inferenceAttempt: 1,
    retriesConsumed: 0,
    authorizationSha256: null,
    repositoryRevision: target.repository.revision,
    contextPacketSha256: null,
    evidenceSha256: SHA("a"),
    toolPolicySha256: SHA("b"),
    contextAuthoritySha256: SHA("c"),
    policySha256: policy.policySha256,
  });
  const checkpoints: ExecutionCheckpointV1[] = [];
  const decisions: ExecutionLeaseDecisionV1[] = [];
  let previousState: ExecutionLeaseStateV1 | undefined;
  const totals = {
    requested: 0,
    executed: 0,
    succeeded: 0,
    failed: 0,
    denied: 0,
    governanceBlocked: 0,
  };
  for (let index = 0; index < leases.length; index += 1) {
    const events = leases[index]!;
    const denied = events.filter((item) => item.category === "authorization-denied").length;
    const governanceBlocked = events.filter((item) => item.category === "governance-denied").length;
    const succeeded = events.filter(
      (item) => item.category === "evidence-produced" || item.category === "no-new-evidence",
    ).length;
    const failed = events.length - denied - governanceBlocked - succeeded;
    const executed = succeeded + failed;
    totals.requested += events.length;
    totals.executed += executed;
    totals.succeeded += succeeded;
    totals.failed += failed;
    totals.denied += denied;
    totals.governanceBlocked += governanceBlocked;
    const state = createExecutionLeaseState(
      {
        leaseNumber: index + 1,
        leaseExecutedToolCalls: executed,
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
      previousState,
    );
    const checkpoint = createExecutionCheckpoint({
      policy,
      identity,
      state,
      reason: index === leases.length - 1 && finalReason ? finalReason : "lease-exhausted",
      ...(checkpoints.length > 0 ? { previous: checkpoints.at(-1)! } : {}),
    });
    checkpoints.push(checkpoint);
    previousState = state;
    if (index < leases.length - 1) {
      decisions.push(
        decideExecutionLeaseRenewal({
          policy,
          identity,
          checkpoint,
          ...(index > 0
            ? { history: { checkpoints: checkpoints.slice(0, -1), decisions: [...decisions] } }
            : {}),
        }),
      );
    }
  }
  return createSearchProgressExecutionAuthority({
    target,
    policy,
    identity,
    checkpoints,
    decisions,
  });
}
