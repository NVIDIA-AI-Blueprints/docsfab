// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { deepFreezeGraph } from "../../contract-kit/freeze.js";
import {
  bad,
  canonicalJson,
  containsCredentialDeep,
  digest,
  enumeration,
  freezeDeep,
  id,
  nonnegative,
  objectId,
  record,
  sha,
} from "../wire-decode.js";
import {
  assertHostRuntimeSemanticData,
  jsonRecord,
  parseHostRuntimeSemanticClaimCoreData,
  semanticCitationData,
} from "./inert-data.js";
import type {
  HostRuntimeSemanticCitationV1,
  HostRuntimeAcceptedEffectClaim,
  HostRuntimeAcceptedEffectFacet,
  HostRuntimeAcceptedEffectRevalidation,
  HostRuntimeCorrectiveProposalRevalidationV1,
  HostRuntimeAcceptedEffectAssessmentV1,
  HostRuntimeCorrectiveProposalAssessmentV1,
} from "./types.js";

/** Deterministic complete facets; a model cannot choose which scope qualifier to omit. */
export function semanticAcceptedEffectFacets(
  input: HostRuntimeAcceptedEffectClaim,
): readonly HostRuntimeAcceptedEffectFacet[] {
  const claim = parseHostRuntimeSemanticClaimCoreData(input);
  const entries: Array<{ field: "statement" | "scope"; scopeKey: string | null; content: string }> =
    [
      { field: "statement", scopeKey: null, content: claim.statement },
      ...Object.keys(claim.scope)
        .sort()
        .map((scopeKey) => ({
          field: "scope" as const,
          scopeKey,
          content: canonicalJson({ [scopeKey]: claim.scope[scopeKey] }),
        })),
    ];
  return freezeDeep(
    entries.map((entry) => ({
      ...entry,
      facetId: `accepted-effect:${digest({ claimId: claim.claim_id, ...entry })}`,
      contentSha256: createHash("sha256").update(entry.content).digest("hex"),
    })),
  );
}

/** Serialized data only; the host derives subject from the original selected finding. */
export function parseHostRuntimeAcceptedEffectRevalidationData(
  input: unknown,
): HostRuntimeAcceptedEffectRevalidation {
  assertHostRuntimeSemanticData(input);
  const root = record(input, [
    "schemaVersion",
    "kind",
    "subject",
    "baseline",
    "original",
    "decision",
    "claim",
    "repository",
    "facets",
    "purposeSha256",
  ]);
  if (
    (root.schemaVersion !== 1 && root.schemaVersion !== 2 && root.schemaVersion !== 3) ||
    root.kind !== "docsfab-accepted-effect-revalidation"
  )
    bad("accepted-effect-kind");
  const baseline = record(root.baseline, [
    "projectId",
    "generation",
    "baselineSha256",
    "modelId",
    "modelSha256",
    "canonSha256",
    "approvalReceiptSha256",
    "sourceClosureSha256",
  ]);
  id(baseline.projectId);
  id(baseline.modelId);
  nonnegative(baseline.generation);
  for (const key of [
    "baselineSha256",
    "modelSha256",
    "canonSha256",
    "approvalReceiptSha256",
    "sourceClosureSha256",
  ])
    sha(baseline[key]);
  const original = record(root.original, [
    "comparisonSha256",
    "outcomeSha256",
    "findingSha256",
    "assertion",
  ]);
  for (const key of ["comparisonSha256", "outcomeSha256", "findingSha256"]) sha(original[key]);
  enumeration(original.assertion, ["proposed-intent", "observed-implementation"] as const);
  if (
    root.subject !==
    (original.assertion === "proposed-intent" ? "desired-intent" : "observed-implementation")
  )
    bad("accepted-effect-subject");
  const decision = record(root.decision, [
    "sourceRegistrationSha256",
    "selectedOptionId",
    "approvalTargetSha256",
    "offeredDeltaSha256",
  ]);
  for (const key of ["sourceRegistrationSha256", "approvalTargetSha256", "offeredDeltaSha256"])
    sha(decision[key]);
  enumeration(decision.selectedOptionId, ["keep-approved", "replace-statement-and-scope"] as const);
  const claim = record(root.claim, ["beforeRecordSha256", "before", "offeredAfter", "expected"]);
  sha(claim.beforeRecordSha256);
  const before = parseHostRuntimeSemanticClaimCoreData(claim.before),
    after = parseHostRuntimeSemanticClaimCoreData(claim.offeredAfter);
  const expected = parseHostRuntimeSemanticClaimCoreData(claim.expected);
  if (
    before.claim_id !== after.claim_id ||
    canonicalJson(expected) !==
      canonicalJson(decision.selectedOptionId === "keep-approved" ? before : after)
  )
    bad("accepted-effect-selected-core");
  const repository = record(root.repository, [
    "observationSha256",
    "priorComparisonReceiptSha256",
    "priorInputInventorySha256",
    "unavailableEvidenceIds",
    "previousRevision",
    "previousTree",
    "observedRevision",
    "observedTree",
    "origin",
  ]);
  sha(repository.observationSha256);
  sha(repository.priorComparisonReceiptSha256);
  sha(repository.priorInputInventorySha256);
  if (
    !Array.isArray(repository.unavailableEvidenceIds) ||
    new Set(repository.unavailableEvidenceIds.map(id)).size !==
      repository.unavailableEvidenceIds.length
  )
    bad("accepted-effect-unavailable");
  if (root.schemaVersion !== 1 && repository.previousRevision === null) {
    if (repository.previousTree !== null || repository.origin !== null)
      bad("accepted-effect-snapshot-boundary");
  } else {
    objectId(repository.previousRevision);
    objectId(repository.previousTree);
  }
  objectId(repository.observedRevision);
  objectId(repository.observedTree);
  if (repository.origin !== null) {
    const origin = record(repository.origin, ["originalMergeAnchorSha256", "revision"]);
    sha(origin.originalMergeAnchorSha256);
    objectId(origin.revision);
  }
  if (canonicalJson(root.facets) !== canonicalJson(semanticAcceptedEffectFacets(expected)))
    bad("accepted-effect-facets");
  const { purposeSha256, ...body } = root;
  if (
    sha(purposeSha256) !== digest(body) ||
    containsCredentialDeep(root, "hosted-semantic:acceptedEffectRevalidation")
  )
    bad("accepted-effect-digest-or-credential");
  return deepFreezeGraph(root) as unknown as HostRuntimeAcceptedEffectRevalidation;
}

/** Normalized data only. The live chunk parser separately checks source/intent spans. */
export function parseHostRuntimeAcceptedEffectAssessmentData(
  input: unknown,
): HostRuntimeAcceptedEffectAssessmentV1 {
  assertHostRuntimeSemanticData(input);
  const row = record(input, [
    "facetId",
    "relationship",
    "assertion",
    "explanation",
    "intentCitation",
    "sourceCitations",
  ]);
  id(row.facetId);
  enumeration(row.relationship, [
    "supports-full-facet",
    "supports-part-of-facet",
    "contradicts",
    "insufficient",
    "not-informative",
  ] as const);
  enumeration(row.assertion, ["proposed-intent", "observed-implementation", "unknown"] as const);
  if (
    typeof row.explanation !== "string" ||
    !row.explanation.trim() ||
    row.explanation.includes("\0") ||
    semanticCitationData(row.intentCitation).evidenceId !== row.facetId ||
    !Array.isArray(row.sourceCitations) ||
    !row.sourceCitations.length
  )
    bad("accepted-effect-assessment");
  row.sourceCitations.forEach(semanticCitationData);
  if (containsCredentialDeep(row, "hosted-semantic:acceptedEffectAssessment"))
    bad("accepted-effect-credential");
  return deepFreezeGraph(row) as unknown as HostRuntimeAcceptedEffectAssessmentV1;
}

/** Structural data only. The optional existing purpose supplies exact keep-choice binding, not authority. */
export function parseHostRuntimeCorrectiveProposalRevalidationData(
  input: unknown,
  effect?: HostRuntimeAcceptedEffectRevalidation,
): HostRuntimeCorrectiveProposalRevalidationV1 {
  assertHostRuntimeSemanticData(input);
  const root = record(input, [
    "schemaVersion",
    "kind",
    "acceptedEffectPurposeSha256",
    "proposal",
    "purposeSha256",
  ]);
  if (root.schemaVersion !== 1 || root.kind !== "docsfab-corrective-proposal-revalidation")
    bad("corrective-proposal-kind");
  sha(root.acceptedEffectPurposeSha256);
  const proposal = record(root.proposal, [
    "candidateManifestSha256",
    "recipeSha256",
    "targetRoutePolicySha256",
    "targets",
  ]);
  for (const key of ["candidateManifestSha256", "recipeSha256", "targetRoutePolicySha256"])
    sha(proposal[key]);
  if (!Array.isArray(proposal.targets)) bad("corrective-proposal-targets");
  const targets = new Set<string>();
  for (const value of proposal.targets) {
    const target = record(value, ["claimId", "targetId", "path", "delivery", "heading"]);
    id(target.claimId);
    const targetId = id(target.targetId);
    if (
      targets.has(targetId) ||
      typeof target.path !== "string" ||
      !safeReaderPath(target.path) ||
      (target.heading !== null &&
        (typeof target.heading !== "string" ||
          !target.heading.trim() ||
          /[\r\n\0]/u.test(target.heading)))
    )
      bad("corrective-proposal-target");
    targets.add(targetId);
    enumeration(target.delivery, ["repository-planning", "public-documentation"] as const);
  }
  if (effect) {
    const bound = parseHostRuntimeAcceptedEffectRevalidationData(effect);
    if (
      bound.decision.selectedOptionId !== "keep-approved" ||
      root.acceptedEffectPurposeSha256 !== bound.purposeSha256 ||
      proposal.targets.some(
        (value) => (value as Record<string, unknown>).claimId !== bound.claim.before.claim_id,
      )
    )
      bad("corrective-proposal-effect-binding");
  }
  const { purposeSha256, ...body } = root;
  if (
    sha(purposeSha256) !== digest(body) ||
    containsCredentialDeep(root, "hosted-semantic:correctiveProposalRevalidation")
  )
    bad("corrective-proposal-digest-or-credential");
  return deepFreezeGraph(root) as unknown as HostRuntimeCorrectiveProposalRevalidationV1;
}
/** Normalized data only; source membership and current-W spans are checked against the actual chunk. */
export function parseHostRuntimeCorrectiveProposalAssessmentData(
  input: unknown,
): HostRuntimeCorrectiveProposalAssessmentV1 {
  assertHostRuntimeSemanticData(input);
  const row = record(input, [
    "facetId",
    "applicability",
    "implementation",
    "explanation",
    "intentCitation",
    "sourceCitations",
    "gapFindings",
  ]);
  id(row.facetId);
  enumeration(row.applicability, [
    "within-approved-scope",
    "partially-established",
    "scope-change-required",
    "insufficient",
    "not-informative",
  ] as const);
  enumeration(row.implementation, [
    "retained-deviation-present",
    "aligned",
    "partially-established",
    "not-established",
    "not-informative",
  ] as const);
  if (
    typeof row.explanation !== "string" ||
    !row.explanation.trim() ||
    row.explanation.includes("\0") ||
    semanticCitationData(row.intentCitation).evidenceId !== row.facetId ||
    !Array.isArray(row.sourceCitations) ||
    !row.sourceCitations.length ||
    !Array.isArray(row.gapFindings)
  )
    bad("corrective-proposal-assessment");
  row.sourceCitations.forEach(semanticCitationData);
  const gaps = new Set<string>();
  for (const value of row.gapFindings) {
    const gap = record(value, ["evidenceId", "claimId"]);
    id(gap.evidenceId);
    id(gap.claimId);
    const key = canonicalJson(gap);
    if (gaps.has(key)) bad("corrective-proposal-duplicate-gap");
    gaps.add(key);
  }
  if (
    (row.implementation === "retained-deviation-present") !== row.gapFindings.length > 0 ||
    containsCredentialDeep(row, "hosted-semantic:correctiveProposalAssessment")
  )
    bad("corrective-proposal-gap-state");
  return deepFreezeGraph(row) as unknown as HostRuntimeCorrectiveProposalAssessmentV1;
}

function safeReaderPath(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 4_096 &&
    value === value.normalize("NFC") &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    !value.startsWith("/") &&
    !/^[A-Za-z]:/u.test(value) &&
    value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..")
  );
}
