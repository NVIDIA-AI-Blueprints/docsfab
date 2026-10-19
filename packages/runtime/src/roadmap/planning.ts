// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { deepFreeze } from "../contract-kit/freeze.js";
import { screenCredentialValue } from "../security/credential-shape-findings.js";
import { detectCredentialRuleIdsInValue } from "../security/repository-scanner.js";
import { roadmapCanonicalJson, roadmapDigest } from "./contracts/decode.js";
import {
  createRoadmapLedger,
  roadmapFindingFingerprint,
  validateRoadmapLedger,
  type RoadmapDedupDecision,
  type RoadmapDiscoveryBoundary,
  type RoadmapEvidenceReference,
  type RoadmapFinding,
  type RoadmapFindingMaterial,
  type RoadmapLedger,
  type RoadmapProjectIdentity,
  type RoadmapTrackerObservation,
  type RoadmapWorkstream,
} from "./contracts/ledger.js";
import {
  createRoadmapMutationPlanV2,
  validateRoadmapMutationPlanV2,
  type RoadmapMutationOperationV2Input,
  type RoadmapMutationPlanV2,
} from "./execution-v2.js";
import {
  internalRoadmapPlanningSourceState,
  type InternalRoadmapPlanningSourceCapability,
  type InternalRoadmapPlanningSourceState,
} from "./planning-authority-internal.js";
import { compareText } from "../shared/primitives.js";
import {
  ROADMAP_PLANNING_DISPOSITIONS,
  ROADMAP_PLANNING_MODES,
  ROADMAP_PLANNING_SCHEMA_VERSION,
} from "./planning/schema.js";
import {
  closed,
  decodeIssues,
  decodeRankedProposal,
  denseArray,
  digest,
  enumeration,
  identifier,
  sameStrings,
  textArray,
  timestamp,
  unique,
} from "./planning/value-codec.js";
import { decodeRoadmapPlanningInput } from "./planning/input-codec.js";
import { requireCondition } from "./planning/protocol.js";
import type {
  RoadmapPlanningArtifact,
  RoadmapPlanningCandidateInput,
  RoadmapPlanningDisposition,
  RoadmapPlanningDraft,
  RoadmapPlanningInput,
  RoadmapPlanningMode,
  RoadmapPlanningRankedProposal,
  RoadmapPlanningRankInput,
  RoadmapPlanningUnit,
  RoadmapReleaseChange,
  RoadmapReleasePlanningInput,
  RoadmapReleaseBoundaryAuthority,
  RoadmapHealthAuditFinding,
  RoadmapHealthAuditPackage,
  RoadmapHealthPlanningInput,
  RoadmapSweepPlanningInput,
  RoadmapSemanticReconciliation,
  SanitizedRoadmapIssue,
} from "./planning/schema.js";

export { ROADMAP_PLANNING_DISPOSITIONS, ROADMAP_PLANNING_MODES, ROADMAP_PLANNING_SCHEMA_VERSION };
export type {
  RoadmapPlanningMode,
  RoadmapPlanningDisposition,
  RoadmapPlanningUnit,
  RoadmapReleaseChange,
  RoadmapReleaseBoundaryAuthority,
  RoadmapHealthAuditFinding,
  RoadmapHealthAuditPackage,
  RoadmapPlanningDraft,
  RoadmapPlanningRankInput,
  RoadmapPlanningCandidateInput,
  RoadmapSemanticReconciliation,
  SanitizedRoadmapIssue,
  RoadmapReleasePlanningInput,
  RoadmapHealthPlanningInput,
  RoadmapSweepPlanningInput,
  RoadmapPlanningInput,
  RoadmapPlanningRankedProposal,
  RoadmapPlanningArtifact,
};
export { RoadmapPlanningError } from "./planning/protocol.js";
export { decodeRoadmapPlanningInput };

/** Opaque host-owned authority; its trust state is never serialized. */
export type RoadmapPlanningSourceCapability = InternalRoadmapPlanningSourceCapability;

export function planRoadmap(
  inputValue: unknown,
  trackerValue: unknown,
  sourceCapability: RoadmapPlanningSourceCapability,
): RoadmapPlanningArtifact {
  const input = decodeRoadmapPlanningInput(inputValue);
  const sourceAuthority = sourceAuthorityState(sourceCapability);
  const issues = decodeIssues(trackerValue);
  const tracker = issues.map(
    (issue) =>
      ({
        issueIid: issue.iid,
        state: issue.state,
        updatedAt: issue.updatedAt,
        identityDigest: issue.identityDigest,
      }) satisfies RoadmapTrackerObservation,
  );
  const sourceDigest = roadmapDigest({ source: input });
  requireCondition(
    sourceAuthority.sourceDigest === sourceDigest,
    "invalid-input",
    "$.sourceAuthority",
  );
  const boundaryDigest = roadmapDigest({
    mode: input.mode,
    repository: input.repository,
    project: input.project,
    units: input.units,
    ...(input.mode === "release"
      ? {
          fromRevision: input.fromRevision,
          toRevision: input.toRevision,
          releaseBoundary: input.releaseBoundary,
          ...(input.releaseRef === undefined ? {} : { releaseRef: input.releaseRef }),
        }
      : {}),
    ...(input.mode === "health"
      ? { ...(input.scope === undefined ? {} : { scope: input.scope }), docAudit: input.docAudit }
      : {}),
    ...(input.mode === "sweep"
      ? { baseBoundary: input.baseLedger.boundary, observedAt: input.observedAt }
      : {}),
  });
  const boundary = planningBoundary(input, boundaryDigest);
  const evidence = planningEvidence(input);
  const evidenceByCandidate = new Map(
    input.candidates.map((candidate) => [
      candidate.id,
      evidence.find((item) => item.id === semanticCandidateEvidenceId(candidate.id))!,
    ]),
  );

  const findings = input.candidates.map((candidate) =>
    finding(candidate, boundary, evidenceByCandidate.get(candidate.id)!),
  );
  const findingByCandidate = new Map(
    input.candidates.map((candidate, index) => [candidate.id, findings[index]!]),
  );
  for (const candidate of input.candidates) {
    const findingValue = findingByCandidate.get(candidate.id)!;
    findingValue.dependsOnFindingIds = (candidate.dependsOnCandidateIds ?? [])
      .map((id) => {
        const dependency = findingByCandidate.get(id);
        requireCondition(
          dependency !== undefined && id !== candidate.id,
          "invalid-input",
          `$.candidates.${candidate.id}.dependsOnCandidateIds`,
        );
        return dependency.id;
      })
      .sort(compareText);
  }
  const exactIssue = new Map<string, SanitizedRoadmapIssue>();
  for (const issue of issues)
    for (const fingerprint of issue.findingFingerprints) {
      if (!exactIssue.has(fingerprint)) exactIssue.set(fingerprint, issue);
    }
  const semanticByCandidate = new Map<string, RoadmapSemanticReconciliation>();
  for (const semantic of input.semanticReconciliation) {
    requireCondition(
      findingByCandidate.has(semantic.candidateId),
      "invalid-input",
      "$.semanticReconciliation.candidateId",
    );
    requireCondition(
      !semanticByCandidate.has(semantic.candidateId),
      "invalid-input",
      "$.semanticReconciliation.candidateId",
    );
    semanticByCandidate.set(semantic.candidateId, semantic);
  }

  const reconciled = input.candidates.map((candidate) => {
    const found = findingByCandidate.get(candidate.id)!;
    if (
      ["documented", "no-doc-impact", "healthy", "excluded"].includes(candidate.disposition) ||
      candidate.review.disposition === "rejected"
    ) {
      return {
        candidate,
        finding: found,
        action: "none" as const,
        rationale: "non-actionable-disposition",
      };
    }
    const exact =
      exactIssue.get(found.fingerprint) ??
      issues.find((issue) => issue.materialEvidenceDigests.includes(candidate.evidenceDigest));
    if (exact)
      return {
        candidate,
        finding: found,
        issue: exact,
        action: "link" as const,
        rationale: "deterministic-exact-match",
      };
    const semantic = semanticByCandidate.get(candidate.id);
    if (!semantic || semantic.decision === "unrelated")
      return {
        candidate,
        finding: found,
        action:
          candidate.review.disposition === "investigation" || candidate.rank.confidence < 0.8
            ? ("investigate" as const)
            : ("create" as const),
        rationale: "no-existing-match",
      };
    const issue = issues.find((item) => item.iid === semantic.issueIid);
    requireCondition(issue !== undefined, "stale-tracker", "$.semanticReconciliation.issueIid");
    if (semantic.decision === "extend")
      return {
        candidate,
        finding: found,
        issue,
        action: "extend" as const,
        rationale: "semantic-partial-overlap",
      };
    if (semantic.decision === "supersede")
      return {
        candidate,
        finding: found,
        issue,
        action: "supersede" as const,
        rationale: "semantic-supersession",
      };
    return {
      candidate,
      finding: found,
      issue,
      action: "investigate" as const,
      rationale: "semantic-conflict",
    };
  });

  const ranked = reconciled.map((item) =>
    rankedProposal(item.candidate, item.finding, item.action, item.rationale, item.issue?.iid),
  );
  ranked.sort(
    (left, right) =>
      right.score - left.score || compareText(left.findingFingerprint, right.findingFingerprint),
  );
  let createCount = 0;
  for (const proposal of ranked) {
    if (
      (proposal.action === "create" || proposal.action === "investigate") &&
      proposal.confidence >= 0.8
    ) {
      createCount += 1;
      if (createCount > input.proposalCap) proposal.action = "none";
    }
  }

  const dedup = reconciled.map((item) =>
    dedupDecision(item.candidate, item.finding, item.action, item.rationale, item.issue),
  );
  const workstreams = createWorkstreams(input.candidates, findingByCandidate);
  const generatedAt = input.observedAt;
  const sweeps =
    input.mode === "sweep"
      ? [
          {
            id: `sweep:${stableToken(sourceDigest)}`,
            observedAt: input.observedAt,
            repositoryRevision: input.repository.revision,
            trackerObservedAt: input.observedAt,
            findingFingerprints: findings.map((item) => item.fingerprint).sort(compareText),
            newFindingIds: findings
              .filter(
                (item) =>
                  !input.baseLedger.findings.some(
                    (existing) => existing.fingerprint === item.fingerprint,
                  ),
              )
              .map((item) => item.id)
              .sort(compareText),
            disposition: findings.some(
              (item) =>
                !input.baseLedger.findings.some(
                  (existing) => existing.fingerprint === item.fingerprint,
                ),
            )
              ? ("new-findings" as const)
              : ("clean" as const),
          },
        ]
      : [];
  const ledger = createRoadmapLedger({
    id: `ledger:${stableToken(sourceDigest)}`,
    repository: input.repository,
    project: input.project,
    boundary,
    trackerObservedAt: input.observedAt,
    tracker,
    evidence,
    findings,
    workstreams,
    dedup,
    transitions: [],
    sweeps,
    closeouts: [],
    createdAt: input.observedAt,
    updatedAt: input.observedAt,
  });

  const operations = ranked
    .filter((proposal) => proposal.action !== "none" && proposal.action !== "link")
    .map((proposal) => operationForProposal(proposal, input, ledger));
  for (const proposal of ranked) {
    const operation = operations.find((item) => item.findingIds.includes(proposal.findingId));
    if (operation) proposal.operationKey = operation.key;
  }
  const mutationPlan =
    operations.length === 0
      ? null
      : createRoadmapMutationPlanV2(
          {
            id: `plan:${stableToken(sourceDigest)}`,
            ledger: {
              kind: "roadmap-ledger",
              schemaVersion: 1,
              digest: ledger.digest,
              repositoryRevision: ledger.repository.revision,
              repositoryContentDigest: ledger.repository.contentDigest,
            },
            repository: ledger.repository,
            project: ledger.project,
            trackerObservedAt: ledger.trackerObservedAt,
            operations,
            generatedAt,
            expiresAt: input.expiresAt,
          },
          ledger,
        );
  const candidateArtifact: RoadmapPlanningArtifact = {
    kind: "docsfab-roadmap-plan",
    schemaVersion: ROADMAP_PLANNING_SCHEMA_VERSION,
    mode: input.mode,
    readOnly: true,
    authorization: null,
    reconciliationOrder: ["deterministic", "semantic"],
    sourceDigest,
    sourceAuthorityId: sourceAuthority.sourceAuthorityId,
    ledger,
    mutationPlan,
    rankedProposals: ranked,
    accountedUnitIds: [...input.units.map((item) => item.id)].sort(compareText),
    generatedAt,
    digest: "0".repeat(64),
  };
  candidateArtifact.digest = roadmapDigest(candidateArtifact);
  const artifact = validateRoadmapPlanningArtifactStructure(candidateArtifact);
  requireCondition(
    sourceAuthority.artifactDigest === undefined ||
      sourceAuthority.artifactDigest === artifact.digest,
    "invalid-input",
    "$.sourceAuthority.artifactDigest",
  );
  sourceAuthority.artifactDigest = artifact.digest;
  return artifact;
}

function validateRoadmapPlanningArtifactStructure(value: unknown): RoadmapPlanningArtifact {
  const root = closed(value, "$", [
    "kind",
    "schemaVersion",
    "mode",
    "readOnly",
    "authorization",
    "reconciliationOrder",
    "sourceDigest",
    "sourceAuthorityId",
    "ledger",
    "mutationPlan",
    "rankedProposals",
    "accountedUnitIds",
    "generatedAt",
    "digest",
  ]);
  requireCondition(
    root.kind === "docsfab-roadmap-plan" &&
      root.schemaVersion === 1 &&
      root.readOnly === true &&
      root.authorization === null,
    "invalid-input",
    "$",
  );
  const ledger = validateRoadmapLedger(root.ledger);
  const mutationPlan =
    root.mutationPlan === null ? null : validateRoadmapMutationPlanV2(root.mutationPlan, ledger);
  const order = textArray(root.reconciliationOrder, "$.reconciliationOrder");
  requireCondition(
    order.length === 2 && order[0] === "deterministic" && order[1] === "semantic",
    "invalid-input",
    "$.reconciliationOrder",
  );
  const proposals = denseArray(root.rankedProposals, "$.rankedProposals").map((item, index) =>
    decodeRankedProposal(item, `$.rankedProposals[${index}]`),
  );
  const artifact: RoadmapPlanningArtifact = {
    kind: "docsfab-roadmap-plan",
    schemaVersion: 1,
    mode: enumeration(root.mode, ROADMAP_PLANNING_MODES, "$.mode"),
    readOnly: true,
    authorization: null,
    reconciliationOrder: ["deterministic", "semantic"],
    sourceDigest: digest(root.sourceDigest, "$.sourceDigest"),
    sourceAuthorityId: identifier(root.sourceAuthorityId, "$.sourceAuthorityId"),
    ledger,
    mutationPlan,
    rankedProposals: proposals,
    accountedUnitIds: textArray(root.accountedUnitIds, "$.accountedUnitIds").sort(compareText),
    generatedAt: timestamp(root.generatedAt, "$.generatedAt"),
    digest: digest(root.digest, "$.digest"),
  };
  requireCondition(
    new Set(artifact.accountedUnitIds).size === artifact.accountedUnitIds.length,
    "invalid-input",
    "$.accountedUnitIds",
  );
  requireCondition(roadmapDigest(artifact) === artifact.digest, "invalid-input", "$.digest");
  requireCondition(
    screenCredentialValue(artifact, "roadmap-planning", detectCredentialRuleIdsInValue) === null,
    "unsafe-content",
    "$",
  );
  validatePlanningBindings(artifact);
  return deepFreeze(artifact);
}

export function validateRoadmapPlanningArtifact(
  value: unknown,
  sourceCapability: RoadmapPlanningSourceCapability,
): RoadmapPlanningArtifact {
  const artifact = validateRoadmapPlanningArtifactStructure(value);
  const authority = sourceAuthorityState(sourceCapability);
  requireCondition(
    authority.sourceDigest === artifact.sourceDigest &&
      authority.sourceAuthorityId === artifact.sourceAuthorityId &&
      authority.artifactDigest === artifact.digest,
    "invalid-input",
    "$.sourceAuthority",
  );
  return artifact;
}

function validatePlanningBindings(artifact: RoadmapPlanningArtifact): void {
  requireCondition(
    artifact.ledger.id === `ledger:${stableToken(artifact.sourceDigest)}` &&
      artifact.generatedAt === artifact.ledger.updatedAt,
    "invalid-input",
    "$.sourceDigest",
  );
  requireCondition(
    artifact.rankedProposals.length === artifact.ledger.findings.length,
    "invalid-input",
    "$.rankedProposals",
  );
  unique(
    artifact.rankedProposals.map((proposal) => proposal.candidateId),
    "$.rankedProposals.candidateId",
  );
  unique(
    artifact.rankedProposals.map((proposal) => proposal.findingId),
    "$.rankedProposals.findingId",
  );
  for (let index = 1; index < artifact.rankedProposals.length; index += 1) {
    const previous = artifact.rankedProposals[index - 1]!;
    const current = artifact.rankedProposals[index]!;
    requireCondition(
      previous.score > current.score ||
        (previous.score === current.score &&
          compareText(previous.findingFingerprint, current.findingFingerprint) <= 0),
      "invalid-input",
      "$.rankedProposals",
    );
  }
  for (const proposal of artifact.rankedProposals) {
    const findingValue = artifact.ledger.findings.find(
      (finding) => finding.id === proposal.findingId,
    );
    requireCondition(
      findingValue !== undefined && findingValue.fingerprint === proposal.findingFingerprint,
      "invalid-input",
      `$.rankedProposals.${proposal.candidateId}.findingId`,
    );
    requireCondition(
      proposal.draft === undefined ||
        sameStrings(proposal.draft.evidencePaths, findingValue.affectedPaths),
      "invalid-input",
      `$.rankedProposals.${proposal.candidateId}.draft.evidencePaths`,
    );
    requireCondition(
      !["documented", "no-doc-impact", "healthy", "excluded"].includes(findingValue.disposition) ||
        proposal.action === "none",
      "invalid-input",
      `$.rankedProposals.${proposal.candidateId}.action`,
    );
    requireCondition(
      !["create", "extend", "supersede", "investigate"].includes(proposal.action) ||
        proposal.draft !== undefined,
      "invalid-input",
      `$.rankedProposals.${proposal.candidateId}.draft`,
    );
    const decision = artifact.ledger.dedup.find((item) => item.findingId === proposal.findingId);
    requireCondition(
      decision !== undefined,
      "invalid-input",
      `$.ledger.dedup.${proposal.findingId}`,
    );
    if (proposal.action === "link")
      requireCondition(
        decision.decision === "duplicate" && decision.issueIid === proposal.issueIid,
        "invalid-input",
        `$.rankedProposals.${proposal.candidateId}.action`,
      );
    if (proposal.action === "extend")
      requireCondition(
        decision.decision === "reuse" && decision.issueIid === proposal.issueIid,
        "invalid-input",
        `$.rankedProposals.${proposal.candidateId}.action`,
      );
    if (proposal.action === "supersede")
      requireCondition(
        decision.decision === "supersede" && decision.issueIid === proposal.issueIid,
        "invalid-input",
        `$.rankedProposals.${proposal.candidateId}.action`,
      );
  }
  const actionable = artifact.rankedProposals.filter(
    (proposal) => proposal.action !== "none" && proposal.action !== "link",
  );
  if (actionable.length === 0) {
    requireCondition(
      artifact.mutationPlan === null &&
        artifact.rankedProposals.every((proposal) => proposal.operationKey === undefined),
      "invalid-input",
      "$.mutationPlan",
    );
    return;
  }
  requireCondition(artifact.mutationPlan !== null, "invalid-input", "$.mutationPlan");
  const expectedOperations = actionable.map((proposal) =>
    operationForProposal(
      proposal,
      { mode: artifact.mode, project: artifact.ledger.project },
      artifact.ledger,
    ),
  );
  const expected = createRoadmapMutationPlanV2(
    {
      id: `plan:${stableToken(artifact.sourceDigest)}`,
      ledger: {
        kind: "roadmap-ledger",
        schemaVersion: 1,
        digest: artifact.ledger.digest,
        repositoryRevision: artifact.ledger.repository.revision,
        repositoryContentDigest: artifact.ledger.repository.contentDigest,
      },
      repository: artifact.ledger.repository,
      project: artifact.ledger.project,
      trackerObservedAt: artifact.ledger.trackerObservedAt,
      operations: expectedOperations,
      generatedAt: artifact.generatedAt,
      expiresAt: artifact.mutationPlan.expiresAt,
    },
    artifact.ledger,
  );
  requireCondition(
    roadmapCanonicalJson(expected) === roadmapCanonicalJson(artifact.mutationPlan),
    "invalid-input",
    "$.mutationPlan",
  );
  for (const proposal of actionable) {
    const operation = expected.operations.find((item) =>
      item.findingIds.includes(proposal.findingId),
    );
    requireCondition(
      proposal.operationKey === operation?.key,
      "invalid-input",
      `$.rankedProposals.${proposal.candidateId}.operationKey`,
    );
  }
}

export function assertRoadmapPlanningFresh(
  artifactValue: unknown,
  repository: { revision: string; contentDigest: string },
  trackerValue: unknown,
  sourceCapability: RoadmapPlanningSourceCapability,
): RoadmapPlanningArtifact {
  const artifact = validateRoadmapPlanningArtifact(artifactValue, sourceCapability);
  requireCondition(
    artifact.ledger.repository.revision === repository.revision &&
      artifact.ledger.repository.contentDigest === repository.contentDigest,
    "stale-repository",
    "$.ledger.repository",
  );
  const current = decodeIssues(trackerValue);
  requireCondition(
    current.length === artifact.ledger.tracker.length,
    "stale-tracker",
    "$.ledger.tracker",
  );
  const byIid = new Map(current.map((item) => [item.iid, item]));
  for (const observed of artifact.ledger.tracker) {
    const found = byIid.get(observed.issueIid);
    requireCondition(
      found?.state === observed.state &&
        found.updatedAt === observed.updatedAt &&
        found.identityDigest === observed.identityDigest,
      "stale-tracker",
      `$.ledger.tracker.${observed.issueIid}`,
    );
  }
  return artifact;
}

export function serializeRoadmapPlanningArtifact(
  artifact: RoadmapPlanningArtifact,
  sourceCapability: RoadmapPlanningSourceCapability,
): string {
  return `${roadmapCanonicalJson(validateRoadmapPlanningArtifact(artifact, sourceCapability))}\n`;
}

export function renderRoadmapPlanningArtifact(
  artifactValue: unknown,
  sourceCapability: RoadmapPlanningSourceCapability,
): string {
  const artifact = validateRoadmapPlanningArtifact(artifactValue, sourceCapability);
  const lines = [
    `Roadmap plan (${artifact.mode}, read-only)`,
    `Ledger: ${artifact.ledger.digest}`,
    `Mutation plan: ${artifact.mutationPlan?.digest ?? "none"}`,
    `Boundary units accounted: ${artifact.accountedUnitIds.length}`,
  ];
  for (const proposal of artifact.rankedProposals) {
    lines.push(
      `- ${proposal.action.toUpperCase()} ${proposal.candidateId} score=${proposal.score} confidence=${proposal.confidence.toFixed(2)}${proposal.issueIid ? ` issue=#${proposal.issueIid}` : ""}`,
    );
    lines.push(`  ${proposal.reasons.join("; ")}`);
  }
  return lines.join("\n");
}

function planningBoundary(
  input: RoadmapPlanningInput,
  sourceDigest: string,
): RoadmapDiscoveryBoundary {
  if (input.mode === "release")
    return {
      id: `boundary:${stableToken(sourceDigest)}`,
      mode: "release",
      observedAt: input.observedAt,
      queryDigest: sourceDigest,
      fromRevision: input.fromRevision,
      toRevision: input.toRevision,
    };
  if (input.mode === "sweep")
    return {
      ...input.baseLedger.boundary,
      observedAt: input.observedAt,
      queryDigest: sourceDigest,
    };
  return {
    id: `boundary:${stableToken(sourceDigest)}`,
    mode: "documentation-health",
    observedAt: input.observedAt,
    queryDigest: sourceDigest,
  };
}

function planningEvidence(input: RoadmapPlanningInput): RoadmapEvidenceReference[] {
  return input.candidates
    .map((candidate) => ({
      id: semanticCandidateEvidenceId(candidate.id),
      kind: "validation" as const,
      digest: candidate.evidenceDigest,
      repositoryRevision: input.repository.revision,
      path: candidate.affectedPaths[0],
    }))
    .sort((left, right) => compareText(left.id, right.id));
}

function semanticCandidateEvidenceId(candidateId: string): string {
  return `evidence:${roadmapDigest({
    contract: "roadmap-semantic-candidate-identity-v1",
    candidateId,
  })}`;
}

function finding(
  candidate: RoadmapPlanningCandidateInput,
  boundary: RoadmapDiscoveryBoundary,
  evidence: RoadmapEvidenceReference,
): RoadmapFinding {
  const release = boundary.mode === "release";
  let disposition: RoadmapFinding["disposition"] = candidate.disposition;
  if (candidate.review.disposition === "rejected") disposition = release ? "blocked" : "excluded";
  if (candidate.review.disposition === "investigation" || candidate.rank.confidence < 0.8)
    disposition = release ? "blocked" : "investigate";
  const material: RoadmapFindingMaterial = {
    boundaryId: boundary.id,
    category: candidate.category,
    severity: candidate.severity,
    affectedPaths: candidate.affectedPaths,
    evidenceIds: [evidence.id],
    materialEvidenceDigest: candidate.evidenceDigest,
  };
  return {
    id: `finding:${stableToken(roadmapDigest(material))}`,
    fingerprint: roadmapFindingFingerprint(material),
    ...material,
    source: boundary.mode,
    disposition,
    lifecycle: "observed",
    dependsOnFindingIds: [],
  };
}

function rankedProposal(
  candidate: RoadmapPlanningCandidateInput,
  findingValue: RoadmapFinding,
  action: RoadmapPlanningRankedProposal["action"],
  rationale: string,
  issueIid?: number,
): RoadmapPlanningRankedProposal {
  const score =
    candidate.rank.impact * 25 +
    candidate.rank.urgency * 20 +
    candidate.rank.dependency * 15 +
    candidate.rank.scope * 10 -
    candidate.rank.verificationCost * 10 +
    Math.round(candidate.rank.confidence * 100);
  return {
    candidateId: candidate.id,
    findingId: findingValue.id,
    findingFingerprint: findingValue.fingerprint,
    action,
    ...(issueIid === undefined ? {} : { issueIid }),
    confidence: candidate.rank.confidence,
    score,
    reasons: [
      rationale,
      `impact-${candidate.rank.impact}`,
      `urgency-${candidate.rank.urgency}`,
      `dependency-${candidate.rank.dependency}`,
      `scope-${candidate.rank.scope}`,
      `verification-cost-${candidate.rank.verificationCost}`,
      `confidence-${candidate.rank.confidence.toFixed(2)}`,
    ],
    ...(candidate.draft === undefined ? {} : { draft: candidate.draft }),
  };
}

function dedupDecision(
  candidate: RoadmapPlanningCandidateInput,
  findingValue: RoadmapFinding,
  action: RoadmapPlanningRankedProposal["action"],
  rationale: string,
  issue?: SanitizedRoadmapIssue,
): RoadmapDedupDecision {
  if (!issue || action === "investigate")
    return {
      findingId: findingValue.id,
      decision: "create",
      rationaleCode: action === "investigate" ? "investigation-required" : rationale,
    };
  const decision = action === "supersede" ? "supersede" : action === "link" ? "duplicate" : "reuse";
  return {
    findingId: findingValue.id,
    decision,
    issueIid: issue.iid,
    observedUpdatedAt: issue.updatedAt,
    rationaleCode: rationale,
  };
}

function createWorkstreams(
  candidates: RoadmapPlanningCandidateInput[],
  findings: Map<string, RoadmapFinding>,
): RoadmapWorkstream[] {
  const byCategory = new Map<string, string[]>();
  for (const candidate of candidates) {
    const values = byCategory.get(candidate.category) ?? [];
    values.push(findings.get(candidate.id)!.id);
    byCategory.set(candidate.category, values);
  }
  return [...byCategory.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([category, findingIds], index) => ({
      id: `workstream:${stableToken(category)}`,
      findingIds: findingIds.sort(compareText),
      dependsOnWorkstreamIds: [],
      collidesWithWorkstreamIds: [],
      executionOrder: index + 1,
      state: "ready",
    }));
}

function operationForProposal(
  proposal: RoadmapPlanningRankedProposal,
  input: Pick<RoadmapPlanningInput, "mode" | "project">,
  ledger: RoadmapLedger,
): RoadmapMutationOperationV2Input {
  const draft = proposal.draft;
  requireCondition(
    draft !== undefined,
    "invalid-input",
    `$.candidates.${proposal.candidateId}.draft`,
  );
  const rendered = renderDraft(draft);
  const materialDigest = roadmapDigest({
    draft: rendered,
    action: proposal.action,
    findingFingerprint: proposal.findingFingerprint,
  });
  const materialBytes = Buffer.byteLength(rendered, "utf8");
  const operationKey = `operation:${proposal.action}:${stableToken(`${proposal.findingFingerprint}:${proposal.issueIid ?? "new"}`)}`;
  if (proposal.issueIid !== undefined && proposal.action !== "investigate") {
    const observed = ledger.tracker.find((item) => item.issueIid === proposal.issueIid)!;
    const closeout = draft.kind === "closeout";
    requireCondition(
      !closeout || (input.mode === "sweep" && ledger.sweeps[0]?.disposition === "clean"),
      "invalid-input",
      `$.candidates.${proposal.candidateId}.draft.kind`,
    );
    return {
      key: operationKey,
      kind: closeout ? "closure" : "update",
      findingIds: [proposal.findingId],
      dependsOnOperationKeys: [],
      target: { source: "ledger-observation", targetKey: `issue:${proposal.issueIid}` },
      preconditions: [
        {
          source: "ledger-observation",
          targetKey: `issue:${proposal.issueIid}`,
          observedAt: observed.updatedAt,
          identityDigest: observed.identityDigest,
        },
      ],
      proposal: closeout
        ? { kind: "closure", intent: "close", effectKind: "issue" }
        : { kind: "update", intent: "update", effectKind: "issue" },
      materialDigest,
      materialBytes,
      expectedEffectKind: "issue",
    };
  }
  requireCondition(
    draft.kind !== "update" && draft.kind !== "closeout",
    "invalid-input",
    `$.candidates.${proposal.candidateId}.draft.kind`,
  );
  const createKind = draft.kind === "saga" ? ("saga" as const) : ("issue" as const);
  return {
    key: operationKey,
    kind: createKind,
    findingIds: [proposal.findingId],
    dependsOnOperationKeys: [],
    target: { source: "project", targetKey: `project:${input.project.projectId}` },
    preconditions: [],
    proposal: { kind: createKind, intent: "create", effectKind: "issue" },
    materialDigest,
    materialBytes,
    expectedEffectKind: "issue",
  };
}

function renderDraft(draft: RoadmapPlanningDraft): string {
  return [
    draft.title,
    draft.summary,
    ...draft.acceptanceCriteria,
    ...draft.verification,
    ...draft.evidencePaths,
    draft.requiredParentContext ?? "self-contained",
  ].join("\n");
}
function stableToken(value: string): string {
  return roadmapDigest({ value }).slice(0, 20);
}
function sourceAuthorityState(
  value: RoadmapPlanningSourceCapability,
): InternalRoadmapPlanningSourceState {
  const state = internalRoadmapPlanningSourceState(value);
  requireCondition(state !== undefined, "invalid-input", "$.sourceAuthority");
  return state;
}
