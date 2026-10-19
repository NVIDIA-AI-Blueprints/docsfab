// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { deepFreeze } from "../contract-kit/index.js";
import type { RepositoryTarget } from "../repository/contracts.js";
import type {
  WorkflowName,
  WorkflowSearchStepEvidenceV1,
} from "../workflow-contracts/contracts.js";
import { canonicalDigest } from "../content-ir/canonical.js";
import { getWorkflow, isWorkflowName } from "../workflow-registry/catalog.js";
import { decodeWorkflowSearchEvidence } from "../workflow-contracts/search.js";
import { decodeBoundedSearchEvidence } from "./bounded-search-contracts.js";
import type {
  DocumentationGapLedgerEntryV1,
  DocumentationGapLedgerV1,
  DocumentationGapReconciliationV1,
  DocumentationGapRoadmapProposalV1,
  DocumentationGapState,
  DocumentationNegativeEvidenceV1,
  DocumentationSearchFindingV1,
} from "./gap-ledger-contracts.js";

export type {
  DocumentationGapLedgerEntryV1,
  DocumentationGapLedgerV1,
  DocumentationGapReconciliationV1,
  DocumentationGapRoadmapProposalV1,
  DocumentationGapState,
  DocumentationNegativeEvidenceV1,
  DocumentationSearchFindingV1,
} from "./gap-ledger-contracts.js";

import {
  DocumentationGapLedgerError,
  SAFE_ID,
  array,
  bool,
  cataloguedWorkflow,
  equal,
  fail,
  id,
  ids,
  object,
  oneOf,
  requireInert,
  requireKeys,
  rejectCredentials,
  revision,
  sha,
  unique,
  version,
} from "./gap-ledger/codec-primitives.js";
import { decodeDocumentationSearchFinding, workflowEvidence } from "./gap-ledger/finding-codec.js";
export { DocumentationGapLedgerError };
export { decodeDocumentationSearchFinding };

const SHA256 = /^[a-f0-9]{64}$/u;
const REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

/**
 * Project completed workflow search into content-free findings suitable for
 * step and run records. Questions, citations, paths, and searched text are not
 * copied into this projection.
 */
export function projectDocumentationSearchFindings(input: {
  workflow: WorkflowName;
  stepId: string;
  evidence: WorkflowSearchStepEvidenceV1;
}): DocumentationSearchFindingV1[] {
  requireInert(input, "invalid-finding");
  rejectCredentials(input, "invalid-finding");
  if (!isWorkflowName(input.workflow) || !SAFE_ID.test(input.stepId)) {
    fail("invalid-finding");
  }
  const evidence = workflowEvidence(input.evidence);
  return evidence.searches
    .map((search) => {
      const bounded = decodeBoundedSearchEvidence(search.bounded);
      const target = bounded.target;
      const body = {
        schemaVersion: 1 as const,
        kind: "docsfab-documentation-search-finding" as const,
        source: {
          workflow: input.workflow,
          stepId: input.stepId,
          planId: evidence.planId,
          planVersion: evidence.planVersion,
          workflowSearchEvidenceSha256: evidence.evidenceSha256,
        },
        stableGapId: target.stableFindingId,
        requirement: {
          id: target.targetKey,
          subjectSha256: target.subjectSha256,
        },
        target: {
          id: target.id,
          targetType: target.targetType,
          targetSha256: target.targetSha256,
          policySha256: canonicalDigest({
            probePolicy: target.probePolicy,
            requiredProbes: target.requiredProbes,
          }),
        },
        probeCoverage: {
          requiredProbeIds: [...bounded.coverage.requiredProbeIds],
          completedProbeIds: [...bounded.coverage.completedProbeIds],
          incompleteProbeIds: [...bounded.coverage.incompleteProbeIds],
          probes: bounded.probes.map((probe) => ({
            id: probe.id,
            outcome: probe.outcome,
            probeSha256: probe.probeSha256,
            evidenceSha256: probe.evidenceSha256,
          })),
          sufficient: bounded.coverage.sufficient,
          coverageSha256: bounded.coverage.coverageSha256,
        },
        disposition: bounded.finding.disposition,
        findingClass: bounded.finding.findingClass,
        confidence: {
          level: bounded.confidence.level,
          saturation: bounded.confidence.saturation.status,
          confidenceSha256: bounded.confidence.confidenceSha256,
        },
        limitations: bounded.limitations.map((limitation) => ({
          id: limitation.id,
          category: limitation.category,
          impact: limitation.impact,
          probeIds: [...limitation.probeIds],
          detailSha256: limitation.detailSha256,
          limitationSha256: limitation.limitationSha256,
        })),
        evidenceIdentity: {
          repositoryIdentitySha256: target.repository.identitySha256,
          repositoryRevision: target.repository.revision,
          workspaceSnapshotSha256: evidence.workspaceSnapshotSha256,
          boundedSearchEvidenceSha256: bounded.evidenceSha256,
          searchFindingSha256: bounded.finding.findingSha256,
        },
      };
      return decodeDocumentationSearchFinding({
        ...body,
        observationSha256: canonicalDigest(body),
      });
    })
    .sort(compareFindings);
}

export function negativeDocumentationEvidence(
  findings: readonly DocumentationSearchFindingV1[],
): DocumentationNegativeEvidenceV1[] {
  return findings
    .map(decodeDocumentationSearchFinding)
    .filter((finding) => finding.findingClass === "absence")
    .sort(compareFindings);
}

/**
 * Deduplicate the same authenticated bounded finding when more than one step
 * projects it. Source envelopes remain part of each step record, but they do
 * not create duplicate run-level gap observations.
 */
export function deduplicateDocumentationSearchFindings(
  findings: readonly DocumentationSearchFindingV1[],
): DocumentationSearchFindingV1[] {
  const result = new Map<string, DocumentationSearchFindingV1>();
  for (const value of findings) {
    const finding = decodeDocumentationSearchFinding(value);
    const key = findingEquivalenceSha256(finding);
    const existing = result.get(key);
    if (!existing || compareFindings(finding, existing) < 0) result.set(key, finding);
  }
  return [...result.values()].sort(compareFindings);
}

/** Closed structural validator for the four mutually bound record projections. */
export function validateDocumentationGapRecordProjection(input: {
  workflow: WorkflowName;
  stepId: string;
  currentRevision: string;
  searchEvidence: WorkflowSearchStepEvidenceV1;
  searchFindings: readonly DocumentationSearchFindingV1[];
  negativeEvidence: readonly DocumentationNegativeEvidenceV1[];
  gapLedger: DocumentationGapLedgerV1;
  priorLedgers?: readonly DocumentationGapLedgerV1[];
}): {
  searchFindings: DocumentationSearchFindingV1[];
  negativeEvidence: DocumentationNegativeEvidenceV1[];
  gapLedger: DocumentationGapLedgerV1;
} {
  requireInert(input, "invalid-ledger");
  rejectCredentials(input, "invalid-ledger");
  const expectedFindings = projectDocumentationSearchFindings({
    workflow: input.workflow,
    stepId: input.stepId,
    evidence: input.searchEvidence,
  });
  const expectedNegative = negativeDocumentationEvidence(expectedFindings);
  const expectedLedger = createDocumentationGapLedger({
    currentRevision: input.currentRevision,
    findings: expectedFindings,
    ...(input.priorLedgers ? { priorLedgers: input.priorLedgers } : {}),
  });
  const searchFindings = input.searchFindings.map(decodeDocumentationSearchFinding);
  const negativeEvidence = input.negativeEvidence.map(decodeDocumentationSearchFinding);
  const gapLedger = decodeDocumentationGapLedger(input.gapLedger);
  if (
    canonicalDigest(searchFindings) !== canonicalDigest(expectedFindings) ||
    canonicalDigest(negativeEvidence) !== canonicalDigest(expectedNegative) ||
    canonicalDigest(gapLedger) !== canonicalDigest(expectedLedger)
  ) {
    fail("contradictory-evidence");
  }
  return deepFreeze({ searchFindings, negativeEvidence, gapLedger });
}

export function createDocumentationGapLedger(input: {
  currentRevision: string;
  findings: readonly DocumentationSearchFindingV1[];
  priorLedgers?: readonly DocumentationGapLedgerV1[];
}): DocumentationGapLedgerV1 {
  requireInert(input, "invalid-ledger");
  rejectCredentials(input, "invalid-ledger");
  if (
    !REVISION.test(input.currentRevision) ||
    !Array.isArray(input.findings) ||
    input.findings.length === 0 ||
    (input.priorLedgers !== undefined && !Array.isArray(input.priorLedgers))
  ) {
    fail("invalid-ledger");
  }
  const current = deduplicateDocumentationSearchFindings(input.findings);
  if (
    current.some((finding) => finding.evidenceIdentity.repositoryRevision !== input.currentRevision)
  ) {
    fail("invalid-ledger");
  }
  const repositoryIdentitySha256 = current[0]!.evidenceIdentity.repositoryIdentitySha256;
  if (
    current.some(
      (finding) => finding.evidenceIdentity.repositoryIdentitySha256 !== repositoryIdentitySha256,
    )
  ) {
    fail("invalid-ledger");
  }
  const prior = (input.priorLedgers ?? []).map(decodeDocumentationGapLedger);
  if (prior.some((ledger) => ledger.repositoryIdentitySha256 !== repositoryIdentitySha256)) {
    fail("invalid-ledger");
  }
  const currentByGap = new Map<string, DocumentationSearchFindingV1>();
  for (const finding of current) {
    const existing = currentByGap.get(finding.stableGapId);
    if (existing && findingEquivalenceSha256(existing) !== findingEquivalenceSha256(finding)) {
      fail("contradictory-evidence");
    }
    if (!existing || compareFindings(finding, existing) < 0) {
      currentByGap.set(finding.stableGapId, finding);
    }
  }
  const observations = new Map<string, Map<string, DocumentationSearchFindingV1>>();
  const priorEntries = new Map<string, DocumentationGapLedgerEntryV1>();
  for (const ledger of prior) {
    for (const entry of ledger.entries) {
      const existing = priorEntries.get(entry.stableGapId);
      if (
        existing &&
        (canonicalDigest(existing.requirement) !== canonicalDigest(entry.requirement) ||
          existing.policySha256 !== entry.policySha256)
      ) {
        fail("contradictory-evidence");
      }
      priorEntries.set(entry.stableGapId, entry);
      addObservations(observations, entry.observations);
    }
  }
  addObservations(observations, current, true);
  assertSameSnapshotDeterminism(observations);
  const gapIds = [...observations.keys()].sort();
  const entries = gapIds.map((stableGapId) => {
    const history = [...observations.get(stableGapId)!.values()].sort(compareFindings);
    const selected =
      currentByGap.get(stableGapId) ??
      priorEntries
        .get(stableGapId)
        ?.observations.find(
          (finding) =>
            finding.observationSha256 === priorEntries.get(stableGapId)!.currentObservationSha256,
        );
    if (!selected) fail("invalid-ledger");
    const first = history[0]!;
    if (
      history.some(
        (finding) =>
          canonicalDigest(finding.requirement) !== canonicalDigest(first.requirement) ||
          finding.target.policySha256 !== first.target.policySha256,
      )
    ) {
      fail("contradictory-evidence");
    }
    const reconciliations = mergeReconciliations(
      prior
        .filter((ledger) => ledger.entries.some((entry) => entry.stableGapId === stableGapId))
        .flatMap(
          (ledger) =>
            ledger.entries.find((entry) => entry.stableGapId === stableGapId)!.reconciliations,
        ),
    );
    const negative = history.find((finding) => finding.findingClass === "absence");
    if (satisfiesDocumentationRequirement(selected) && negative && reconciliations.length === 0) {
      reconciliations.push(
        createReconciliation({
          stableGapId,
          status: "found",
          repositoryRevision: selected.evidenceIdentity.repositoryRevision,
          negativeObservationSha256: negative.observationSha256,
          evidenceObservationSha256: selected.observationSha256,
          evidenceSha256: selected.evidenceIdentity.searchFindingSha256,
          previousReconciliationSha256: reconciliations.at(-1)?.reconciliationSha256 ?? null,
        }),
      );
    }
    const body = {
      schemaVersion: 1 as const,
      kind: "docsfab-documentation-gap-entry" as const,
      stableGapId,
      requirement: { ...first.requirement },
      policySha256: first.target.policySha256,
      observations: history,
      currentObservationSha256: selected.observationSha256,
      state: gapState(selected, negative !== undefined),
      reconciliations,
    };
    return decodeLedgerEntry({ ...body, entrySha256: canonicalDigest(body) });
  });
  return finalizeLedger({
    repositoryIdentitySha256,
    currentRevision: input.currentRevision,
    entries,
  });
}

export function currentDocumentationGapFindings(
  ledger: DocumentationGapLedgerV1,
): DocumentationSearchFindingV1[] {
  const decoded = decodeDocumentationGapLedger(ledger);
  return decoded.entries
    .map((entry) => {
      const current = entry.observations.find(
        (finding) => finding.observationSha256 === entry.currentObservationSha256,
      );
      if (!current) fail("invalid-ledger");
      return current;
    })
    .sort(compareFindings);
}

export function documentationGapLedgerFromStepFindings(input: {
  currentRevision: string;
  steps: readonly { searchFindings?: readonly DocumentationSearchFindingV1[] }[];
}):
  | {
      searchFindings: DocumentationSearchFindingV1[];
      negativeEvidence: DocumentationNegativeEvidenceV1[];
      gapLedger: DocumentationGapLedgerV1;
    }
  | undefined {
  const findingsOnly = {
    currentRevision: input.currentRevision,
    steps: input.steps
      .filter((step) => step.searchFindings !== undefined && step.searchFindings.length > 0)
      .map((step) => ({ searchFindings: step.searchFindings })),
  };
  requireInert(findingsOnly, "invalid-ledger");
  rejectCredentials(findingsOnly, "invalid-ledger");
  let ledger: DocumentationGapLedgerV1 | undefined;
  for (const step of findingsOnly.steps) {
    if (!step.searchFindings || step.searchFindings.length === 0) continue;
    ledger = createDocumentationGapLedger({
      currentRevision: input.currentRevision,
      findings: step.searchFindings,
      ...(ledger ? { priorLedgers: [ledger] } : {}),
    });
  }
  if (!ledger) return undefined;
  const searchFindings = currentDocumentationGapFindings(ledger);
  return {
    searchFindings,
    negativeEvidence: negativeDocumentationEvidence(searchFindings),
    gapLedger: ledger,
  };
}

export function attestDocumentationGapReconciliation(input: {
  ledger: DocumentationGapLedgerV1;
  stableGapId: string;
  status: "fixed" | "verified";
  repositoryRevision: string;
  evidenceSha256: string;
}): DocumentationGapLedgerV1 {
  requireInert(input, "invalid-reconciliation");
  rejectCredentials(input, "invalid-reconciliation");
  const ledger = decodeDocumentationGapLedger(input.ledger);
  const entry = ledger.entries.find((candidate) => candidate.stableGapId === input.stableGapId);
  if (
    !entry ||
    entry.state !== "resolved" ||
    !REVISION.test(input.repositoryRevision) ||
    input.repositoryRevision !== ledger.currentRevision ||
    !SHA256.test(input.evidenceSha256)
  ) {
    fail("invalid-reconciliation");
  }
  const previous = entry.reconciliations.at(-1);
  if (
    !previous ||
    (input.status === "fixed" && previous.status !== "found") ||
    (input.status === "verified" && previous.status !== "fixed")
  ) {
    fail("invalid-reconciliation");
  }
  const updated = ledger.entries.map((candidate) => {
    if (candidate.stableGapId !== input.stableGapId) return candidate;
    const reconciliations = [
      ...candidate.reconciliations,
      createReconciliation({
        stableGapId: candidate.stableGapId,
        status: input.status,
        repositoryRevision: input.repositoryRevision,
        negativeObservationSha256: previous.negativeObservationSha256,
        evidenceObservationSha256: previous.evidenceObservationSha256,
        evidenceSha256: input.evidenceSha256,
        previousReconciliationSha256: previous.reconciliationSha256,
      }),
    ];
    const body = { ...without(candidate, "entrySha256"), reconciliations };
    return decodeLedgerEntry({ ...body, entrySha256: canonicalDigest(body) });
  });
  return finalizeLedger({
    repositoryIdentitySha256: ledger.repositoryIdentitySha256,
    currentRevision: ledger.currentRevision,
    entries: updated,
  });
}

export function proposeDocumentationGapRoadmapUnit(input: {
  ledger: DocumentationGapLedgerV1;
  stableGapId: string;
  workflow: WorkflowName;
  stepId: string;
  repository: RepositoryTarget;
  repositoryIdentitySha256: string;
  searchEvidence: unknown;
}): DocumentationGapRoadmapProposalV1 {
  requireInert(input, "invalid-proposal");
  rejectCredentials(input, "invalid-proposal");
  const item = object(input, "invalid-proposal");
  requireKeys(
    item,
    [
      "ledger",
      "stableGapId",
      "workflow",
      "stepId",
      "repository",
      "repositoryIdentitySha256",
      "searchEvidence",
    ],
    "invalid-proposal",
  );
  const stableGapId = id(item.stableGapId, "invalid-proposal");
  const ledger = decodeDocumentationGapLedger(item.ledger);
  const authority = authenticateRoadmapSearchAuthority({
    workflow: cataloguedWorkflow(item.workflow, "invalid-proposal"),
    stepId: id(item.stepId, "invalid-proposal"),
    repository: item.repository as RepositoryTarget,
    repositoryIdentitySha256: sha(item.repositoryIdentitySha256, "invalid-proposal"),
    searchEvidence: item.searchEvidence,
  });
  const findings = authority.findings;
  const entry = ledger.entries.find((candidate) => candidate.stableGapId === stableGapId);
  const current = entry?.observations.find(
    (finding) => finding.observationSha256 === entry.currentObservationSha256,
  );
  const authentic = findings.find(
    (finding) =>
      finding.stableGapId === stableGapId &&
      current !== undefined &&
      canonicalDigest(finding) === canonicalDigest(current),
  );
  if (
    !entry ||
    entry.state !== "open" ||
    !current ||
    !authentic ||
    current.disposition !== "not-found-after-bounded-search" ||
    ledger.repositoryIdentitySha256 !== authentic.evidenceIdentity.repositoryIdentitySha256 ||
    ledger.currentRevision !== authentic.evidenceIdentity.repositoryRevision
  ) {
    fail("invalid-proposal");
  }
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-documentation-gap-roadmap-proposal" as const,
    proposalId: `gap-proposal:${canonicalDigest({ stableGapId }).slice(0, 32)}`,
    stableGapId,
    repositoryRevision: current.evidenceIdentity.repositoryRevision,
    requirement: { ...entry.requirement },
    sourceLedgerSha256: ledger.ledgerSha256,
    sourceObservationSha256: current.observationSha256,
    disposition: "not-found-after-bounded-search" as const,
    lifecycle: "proposed" as const,
    trackerMutation: "not-authorized" as const,
  };
  return decodeDocumentationGapRoadmapProposal({
    ...body,
    proposalSha256: canonicalDigest(body),
  });
}

/**
 * Authenticate a serialized roadmap proposal against its exact source
 * authorities. The proposal digest is only an integrity checksum; callers
 * must use this validator before treating a decoded proposal as evidence.
 */
export function validateDocumentationGapRoadmapProposal(input: {
  proposal: DocumentationGapRoadmapProposalV1;
  ledger: DocumentationGapLedgerV1;
  workflow: WorkflowName;
  stepId: string;
  repository: RepositoryTarget;
  repositoryIdentitySha256: string;
  searchEvidence: unknown;
}): DocumentationGapRoadmapProposalV1 {
  requireInert(input, "invalid-proposal");
  rejectCredentials(input, "invalid-proposal");
  const item = object(input, "invalid-proposal");
  requireKeys(
    item,
    [
      "proposal",
      "ledger",
      "workflow",
      "stepId",
      "repository",
      "repositoryIdentitySha256",
      "searchEvidence",
    ],
    "invalid-proposal",
  );
  const proposal = decodeDocumentationGapRoadmapProposal(item.proposal);
  const expected = proposeDocumentationGapRoadmapUnit({
    ledger: item.ledger as DocumentationGapLedgerV1,
    stableGapId: proposal.stableGapId,
    workflow: cataloguedWorkflow(item.workflow, "invalid-proposal"),
    stepId: id(item.stepId, "invalid-proposal"),
    repository: item.repository as RepositoryTarget,
    repositoryIdentitySha256: sha(item.repositoryIdentitySha256, "invalid-proposal"),
    searchEvidence: item.searchEvidence,
  });
  if (canonicalDigest(proposal) !== canonicalDigest(expected)) {
    fail("invalid-proposal");
  }
  return expected;
}

function authenticateRoadmapSearchAuthority(input: {
  workflow: WorkflowName;
  stepId: string;
  repository: RepositoryTarget;
  repositoryIdentitySha256: string;
  searchEvidence: unknown;
}): {
  evidence: WorkflowSearchStepEvidenceV1;
  findings: DocumentationSearchFindingV1[];
} {
  const workflowName = cataloguedWorkflow(input.workflow, "invalid-proposal");
  const stepId = id(input.stepId, "invalid-proposal");
  const workflow = getWorkflow(workflowName);
  const step = workflow.steps.find((candidate) => candidate.id === stepId);
  if (!step?.search) fail("invalid-proposal");
  const repository = repositoryTarget(input.repository, "invalid-proposal");
  const repositoryIdentitySha256 = sha(input.repositoryIdentitySha256, "invalid-proposal");
  let evidence: WorkflowSearchStepEvidenceV1;
  try {
    evidence = decodeWorkflowSearchEvidence(input.searchEvidence, step.search, repository);
  } catch {
    fail("invalid-proposal");
  }
  if (
    evidence.searches.some(
      (search) =>
        search.bounded.target.repository.identitySha256 !== repositoryIdentitySha256 ||
        search.bounded.target.repository.revision !== repository.revision,
    )
  ) {
    fail("invalid-proposal");
  }
  return {
    evidence,
    findings: projectDocumentationSearchFindings({
      workflow: workflow.name,
      stepId: step.id,
      evidence,
    }),
  };
}

export function decodeDocumentationGapLedger(value: unknown): DocumentationGapLedgerV1 {
  requireInert(value, "invalid-ledger");
  rejectCredentials(value, "invalid-ledger");
  const item = object(value, "invalid-ledger");
  requireKeys(
    item,
    [
      "schemaVersion",
      "kind",
      "repositoryIdentitySha256",
      "currentRevision",
      "entries",
      "ledgerSha256",
    ],
    "invalid-ledger",
  );
  equal(item.schemaVersion, 1, "invalid-ledger");
  equal(item.kind, "docsfab-documentation-gap-ledger", "invalid-ledger");
  const repositoryIdentitySha256 = sha(item.repositoryIdentitySha256, "invalid-ledger");
  const currentRevision = revision(item.currentRevision, "invalid-ledger");
  const entries = array(item.entries, "invalid-ledger").map(decodeLedgerEntry);
  if (
    entries.length === 0 ||
    entries.some((entry) =>
      entry.observations.some(
        (finding) => finding.evidenceIdentity.repositoryIdentitySha256 !== repositoryIdentitySha256,
      ),
    ) ||
    !entries.some((entry) =>
      entry.observations.some(
        (finding) => finding.evidenceIdentity.repositoryRevision === currentRevision,
      ),
    ) ||
    entries.some((entry) => {
      const atCurrentRevision = entry.observations.filter(
        (finding) => finding.evidenceIdentity.repositoryRevision === currentRevision,
      );
      return (
        atCurrentRevision.length > 0 &&
        !atCurrentRevision.some(
          (finding) => finding.observationSha256 === entry.currentObservationSha256,
        )
      );
    }) ||
    canonicalDigest([...entries].sort((a, b) => a.stableGapId.localeCompare(b.stableGapId))) !==
      canonicalDigest(entries)
  ) {
    fail("invalid-ledger");
  }
  unique(
    entries.map((entry) => entry.stableGapId),
    "invalid-ledger",
  );
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-documentation-gap-ledger" as const,
    repositoryIdentitySha256,
    currentRevision,
    entries,
  };
  const ledgerSha256 = sha(item.ledgerSha256, "invalid-ledger");
  if (ledgerSha256 !== canonicalDigest(body)) fail("invalid-ledger");
  return deepFreeze({ ...body, ledgerSha256 });
}

/**
 * Decode only the closed proposal shape and its self-checksum. This function
 * does not authenticate the claimed revision, ledger, or observation. Use
 * validateDocumentationGapRoadmapProposal at every trust boundary.
 */
export function decodeDocumentationGapRoadmapProposal(
  value: unknown,
): DocumentationGapRoadmapProposalV1 {
  requireInert(value, "invalid-proposal");
  rejectCredentials(value, "invalid-proposal");
  const item = object(value, "invalid-proposal");
  requireKeys(
    item,
    [
      "schemaVersion",
      "kind",
      "proposalId",
      "stableGapId",
      "repositoryRevision",
      "requirement",
      "sourceLedgerSha256",
      "sourceObservationSha256",
      "disposition",
      "lifecycle",
      "trackerMutation",
      "proposalSha256",
    ],
    "invalid-proposal",
  );
  equal(item.schemaVersion, 1, "invalid-proposal");
  equal(item.kind, "docsfab-documentation-gap-roadmap-proposal", "invalid-proposal");
  const requirementItem = object(item.requirement, "invalid-proposal");
  requireKeys(requirementItem, ["id", "subjectSha256"], "invalid-proposal");
  const stableGapId = id(item.stableGapId, "invalid-proposal");
  if (!/^search-finding:[a-f0-9]{32}$/u.test(stableGapId)) fail("invalid-proposal");
  const proposalId = id(item.proposalId, "invalid-proposal");
  if (proposalId !== `gap-proposal:${canonicalDigest({ stableGapId }).slice(0, 32)}`) {
    fail("invalid-proposal");
  }
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-documentation-gap-roadmap-proposal" as const,
    proposalId,
    stableGapId,
    repositoryRevision: revision(item.repositoryRevision, "invalid-proposal"),
    requirement: {
      id: id(requirementItem.id, "invalid-proposal"),
      subjectSha256: sha(requirementItem.subjectSha256, "invalid-proposal"),
    },
    sourceLedgerSha256: sha(item.sourceLedgerSha256, "invalid-proposal"),
    sourceObservationSha256: sha(item.sourceObservationSha256, "invalid-proposal"),
    disposition: oneOf(
      item.disposition,
      ["not-found-after-bounded-search"] as const,
      "invalid-proposal",
    ),
    lifecycle: oneOf(item.lifecycle, ["proposed"] as const, "invalid-proposal"),
    trackerMutation: oneOf(item.trackerMutation, ["not-authorized"] as const, "invalid-proposal"),
  };
  const proposalSha256 = sha(item.proposalSha256, "invalid-proposal");
  if (proposalSha256 !== canonicalDigest(body)) fail("invalid-proposal");
  return deepFreeze({ ...body, proposalSha256 });
}

/** Safe terminal output containing only closed states and shortened identities. */
export function formatDocumentationGapLedgerSummary(value: DocumentationGapLedgerV1): string[] {
  const ledger = decodeDocumentationGapLedger(value);
  const counts = new Map<DocumentationGapState, number>();
  for (const entry of ledger.entries) counts.set(entry.state, (counts.get(entry.state) ?? 0) + 1);
  return [
    `Documentation gap ledger: ${ledger.entries.length} finding(s) at ${ledger.currentRevision.slice(0, 12)}`,
    `Gap states: open=${counts.get("open") ?? 0}, resolved=${counts.get("resolved") ?? 0}, satisfied=${counts.get("satisfied") ?? 0}, inconclusive=${counts.get("inconclusive") ?? 0}, blocked=${counts.get("blocked") ?? 0}`,
    ...ledger.entries.map((entry) => {
      const current = entry.observations.find(
        (finding) => finding.observationSha256 === entry.currentObservationSha256,
      )!;
      return `Gap ${entry.stableGapId}: ${entry.state}; ${current.disposition}; confidence=${current.confidence.level}; limitations=${current.limitations.length}`;
    }),
  ];
}

export function renderDocumentationGapLedgerMarkdown(value: DocumentationGapLedgerV1): string {
  const ledger = decodeDocumentationGapLedger(value);
  const rows = ledger.entries.map((entry) => {
    const current = entry.observations.find(
      (finding) => finding.observationSha256 === entry.currentObservationSha256,
    )!;
    return `| \`${entry.stableGapId}\` | ${entry.state} | ${current.disposition} | ${current.confidence.level} | ${current.limitations.length} | ${entry.observations.length} |`;
  });
  return [
    "## Documentation gap ledger",
    "",
    `Revision: \`${ledger.currentRevision}\``,
    "",
    "| Stable gap | State | Disposition | Confidence | Limitations | Observations |",
    "| --- | --- | --- | --- | ---: | ---: |",
    ...rows,
    "",
  ].join("\n");
}

function decodeLedgerEntry(value: unknown): DocumentationGapLedgerEntryV1 {
  const item = object(value, "invalid-ledger");
  requireKeys(
    item,
    [
      "schemaVersion",
      "kind",
      "stableGapId",
      "requirement",
      "policySha256",
      "observations",
      "currentObservationSha256",
      "state",
      "reconciliations",
      "entrySha256",
    ],
    "invalid-ledger",
  );
  equal(item.schemaVersion, 1, "invalid-ledger");
  equal(item.kind, "docsfab-documentation-gap-entry", "invalid-ledger");
  const stableGapId = id(item.stableGapId, "invalid-ledger");
  const observations = array(item.observations, "invalid-ledger").map(
    decodeDocumentationSearchFinding,
  );
  if (
    observations.length === 0 ||
    observations.some((finding) => finding.stableGapId !== stableGapId) ||
    canonicalDigest([...observations].sort(compareFindings)) !== canonicalDigest(observations)
  ) {
    fail("invalid-ledger");
  }
  unique(
    observations.map((finding) => finding.observationSha256),
    "invalid-ledger",
  );
  unique(observations.map(findingEquivalenceSha256), "invalid-ledger");
  const requirementItem = object(item.requirement, "invalid-ledger");
  requireKeys(requirementItem, ["id", "subjectSha256"], "invalid-ledger");
  const requirement = {
    id: id(requirementItem.id, "invalid-ledger"),
    subjectSha256: sha(requirementItem.subjectSha256, "invalid-ledger"),
  };
  const policySha256 = sha(item.policySha256, "invalid-ledger");
  if (
    observations.some(
      (finding) =>
        canonicalDigest(finding.requirement) !== canonicalDigest(requirement) ||
        finding.target.policySha256 !== policySha256,
    )
  ) {
    fail("invalid-ledger");
  }
  const currentObservationSha256 = sha(item.currentObservationSha256, "invalid-ledger");
  const current = observations.find(
    (finding) => finding.observationSha256 === currentObservationSha256,
  );
  if (!current) fail("invalid-ledger");
  const state = oneOf(
    item.state,
    ["open", "resolved", "satisfied", "inconclusive", "blocked"] as const,
    "invalid-ledger",
  );
  if (
    gapState(
      current,
      observations.some((finding) => finding.findingClass === "absence"),
    ) !== state
  ) {
    fail("contradictory-evidence");
  }
  const reconciliations = array(item.reconciliations, "invalid-ledger").map((value, index) =>
    decodeReconciliation(value, index === 0 ? null : undefined),
  );
  validateReconciliations(reconciliations, stableGapId, observations);
  if (
    reconciliations.some(
      (reconciliation) =>
        !observations.some(
          (finding) =>
            finding.evidenceIdentity.repositoryRevision === reconciliation.repositoryRevision,
        ),
    )
  ) {
    fail("invalid-reconciliation");
  }
  if (state === "resolved" && reconciliations[0]?.status !== "found") {
    fail("contradictory-evidence");
  }
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-documentation-gap-entry" as const,
    stableGapId,
    requirement,
    policySha256,
    observations,
    currentObservationSha256,
    state,
    reconciliations,
  };
  const entrySha256 = sha(item.entrySha256, "invalid-ledger");
  if (entrySha256 !== canonicalDigest(body)) fail("invalid-ledger");
  return deepFreeze({ ...body, entrySha256 });
}

function createReconciliation(
  input: Omit<DocumentationGapReconciliationV1, "schemaVersion" | "kind" | "reconciliationSha256">,
): DocumentationGapReconciliationV1 {
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-documentation-gap-reconciliation" as const,
    ...input,
  };
  return decodeReconciliation({ ...body, reconciliationSha256: canonicalDigest(body) });
}

function decodeReconciliation(
  value: unknown,
  expectedPrevious?: string | null,
): DocumentationGapReconciliationV1 {
  const item = object(value, "invalid-reconciliation");
  requireKeys(
    item,
    [
      "schemaVersion",
      "kind",
      "stableGapId",
      "status",
      "repositoryRevision",
      "negativeObservationSha256",
      "evidenceObservationSha256",
      "evidenceSha256",
      "previousReconciliationSha256",
      "reconciliationSha256",
    ],
    "invalid-reconciliation",
  );
  equal(item.schemaVersion, 1, "invalid-reconciliation");
  equal(item.kind, "docsfab-documentation-gap-reconciliation", "invalid-reconciliation");
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-documentation-gap-reconciliation" as const,
    stableGapId: id(item.stableGapId, "invalid-reconciliation"),
    status: oneOf(item.status, ["found", "fixed", "verified"] as const, "invalid-reconciliation"),
    repositoryRevision: revision(item.repositoryRevision, "invalid-reconciliation"),
    negativeObservationSha256: sha(item.negativeObservationSha256, "invalid-reconciliation"),
    evidenceObservationSha256: sha(item.evidenceObservationSha256, "invalid-reconciliation"),
    evidenceSha256: sha(item.evidenceSha256, "invalid-reconciliation"),
    previousReconciliationSha256:
      item.previousReconciliationSha256 === null
        ? null
        : sha(item.previousReconciliationSha256, "invalid-reconciliation"),
  };
  if (expectedPrevious !== undefined && body.previousReconciliationSha256 !== expectedPrevious) {
    fail("invalid-reconciliation");
  }
  const reconciliationSha256 = sha(item.reconciliationSha256, "invalid-reconciliation");
  if (reconciliationSha256 !== canonicalDigest(body)) fail("invalid-reconciliation");
  return deepFreeze({ ...body, reconciliationSha256 });
}

function validateReconciliations(
  reconciliations: readonly DocumentationGapReconciliationV1[],
  stableGapId: string,
  observations: readonly DocumentationSearchFindingV1[],
): void {
  let previous: DocumentationGapReconciliationV1 | undefined;
  for (const reconciliation of reconciliations) {
    if (
      reconciliation.stableGapId !== stableGapId ||
      reconciliation.previousReconciliationSha256 !== (previous?.reconciliationSha256 ?? null)
    ) {
      fail("invalid-reconciliation");
    }
    const negative = observations.find(
      (finding) => finding.observationSha256 === reconciliation.negativeObservationSha256,
    );
    const evidence = observations.find(
      (finding) => finding.observationSha256 === reconciliation.evidenceObservationSha256,
    );
    if (
      !negative ||
      negative.findingClass !== "absence" ||
      !evidence ||
      evidence.findingClass !== "presence" ||
      (reconciliation.status === "found" &&
        (reconciliation.repositoryRevision !== evidence.evidenceIdentity.repositoryRevision ||
          reconciliation.evidenceSha256 !== evidence.evidenceIdentity.searchFindingSha256)) ||
      (previous !== undefined &&
        (reconciliation.negativeObservationSha256 !== previous.negativeObservationSha256 ||
          reconciliation.evidenceObservationSha256 !== previous.evidenceObservationSha256)) ||
      (reconciliation.status === "found" && previous !== undefined) ||
      (reconciliation.status === "fixed" && previous?.status !== "found") ||
      (reconciliation.status === "verified" && previous?.status !== "fixed")
    ) {
      fail("invalid-reconciliation");
    }
    previous = reconciliation;
  }
}

function mergeReconciliations(
  values: readonly DocumentationGapReconciliationV1[],
): DocumentationGapReconciliationV1[] {
  const uniqueValues = new Map(values.map((value) => [value.reconciliationSha256, value]));
  const result: DocumentationGapReconciliationV1[] = [];
  let expected: string | null = null;
  while (true) {
    const next = [...uniqueValues.values()].find(
      (value) => value.previousReconciliationSha256 === expected,
    );
    if (!next) break;
    result.push(next);
    uniqueValues.delete(next.reconciliationSha256);
    expected = next.reconciliationSha256;
  }
  if (uniqueValues.size > 0) fail("contradictory-evidence");
  return result;
}

function finalizeLedger(
  input: Omit<DocumentationGapLedgerV1, "schemaVersion" | "kind" | "ledgerSha256">,
): DocumentationGapLedgerV1 {
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-documentation-gap-ledger" as const,
    repositoryIdentitySha256: input.repositoryIdentitySha256,
    currentRevision: input.currentRevision,
    entries: [...input.entries].sort((a, b) => a.stableGapId.localeCompare(b.stableGapId)),
  };
  return decodeDocumentationGapLedger({ ...body, ledgerSha256: canonicalDigest(body) });
}

function addObservations(
  target: Map<string, Map<string, DocumentationSearchFindingV1>>,
  findings: readonly DocumentationSearchFindingV1[],
  preferIncoming = false,
): void {
  for (const finding of findings) {
    const byHash = target.get(finding.stableGapId) ?? new Map();
    const key = findingEquivalenceSha256(finding);
    const existing = byHash.get(key);
    if (!existing || preferIncoming || compareFindings(finding, existing) < 0) {
      byHash.set(key, finding);
    }
    target.set(finding.stableGapId, byHash);
  }
}

function gapState(
  finding: DocumentationSearchFindingV1,
  hasNegative: boolean,
): DocumentationGapState {
  if (finding.findingClass === "absence") return "open";
  if (finding.findingClass === "presence") {
    if (finding.limitations.some((limitation) => limitation.impact === "blocking")) {
      return "blocked";
    }
    if (!finding.probeCoverage.sufficient) return "inconclusive";
    return hasNegative ? "resolved" : "satisfied";
  }
  return finding.findingClass === "blocked" ? "blocked" : "inconclusive";
}

function satisfiesDocumentationRequirement(finding: DocumentationSearchFindingV1): boolean {
  return (
    finding.findingClass === "presence" &&
    finding.probeCoverage.sufficient &&
    finding.limitations.every((limitation) => limitation.impact !== "blocking")
  );
}

function compareFindings(
  left: DocumentationSearchFindingV1,
  right: DocumentationSearchFindingV1,
): number {
  return (
    left.stableGapId.localeCompare(right.stableGapId) ||
    left.evidenceIdentity.repositoryRevision.localeCompare(
      right.evidenceIdentity.repositoryRevision,
    ) ||
    left.evidenceIdentity.workspaceSnapshotSha256.localeCompare(
      right.evidenceIdentity.workspaceSnapshotSha256,
    ) ||
    left.observationSha256.localeCompare(right.observationSha256)
  );
}

function findingEquivalenceSha256(finding: DocumentationSearchFindingV1): string {
  return canonicalDigest({
    stableGapId: finding.stableGapId,
    repositoryIdentitySha256: finding.evidenceIdentity.repositoryIdentitySha256,
    repositoryRevision: finding.evidenceIdentity.repositoryRevision,
    workspaceSnapshotSha256: finding.evidenceIdentity.workspaceSnapshotSha256,
    policySha256: finding.target.policySha256,
    targetSha256: finding.target.targetSha256,
    coverageSha256: finding.probeCoverage.coverageSha256,
    boundedSearchEvidenceSha256: finding.evidenceIdentity.boundedSearchEvidenceSha256,
    searchFindingSha256: finding.evidenceIdentity.searchFindingSha256,
  });
}

function assertSameSnapshotDeterminism(
  observations: Map<string, Map<string, DocumentationSearchFindingV1>>,
): void {
  for (const byHash of observations.values()) {
    const seen = new Map<string, string>();
    for (const finding of byHash.values()) {
      const key = `${finding.evidenceIdentity.repositoryRevision}:${finding.evidenceIdentity.workspaceSnapshotSha256}`;
      const equivalence = findingEquivalenceSha256(finding);
      const existing = seen.get(key);
      if (existing && existing !== equivalence) fail("contradictory-evidence");
      seen.set(key, equivalence);
    }
  }
}

function without<T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> {
  const clone = { ...value };
  delete clone[key];
  return clone;
}

function repositoryTarget(
  value: unknown,
  code: DocumentationGapLedgerError["code"],
): RepositoryTarget {
  const item = object(value, code);
  requireKeys(item, ["sourcePath", "requestedRevision", "revision"], code);
  if (
    typeof item.sourcePath !== "string" ||
    item.sourcePath.length === 0 ||
    item.sourcePath.length > 4_096 ||
    /[\u0000-\u001f\u007f]/u.test(item.sourcePath) ||
    typeof item.requestedRevision !== "string" ||
    item.requestedRevision.length === 0 ||
    item.requestedRevision.length > 1_024
  ) {
    fail(code);
  }
  return {
    sourcePath: item.sourcePath,
    requestedRevision: item.requestedRevision,
    revision: revision(item.revision, code),
  };
}
