// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { deepFreeze } from "../../contract-kit/index.js";
import { canonicalDigest } from "../../content-ir/canonical.js";
import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../../json-evidence.js";
import type { DocumentationSearchFindingV1 } from "../gap-ledger-contracts.js";
import type { WorkflowSearchStepEvidenceV1 } from "../../workflow-contracts/contracts.js";
import {
  decodeBoundedSearchEvidence,
  type SearchDisposition,
} from "../bounded-search-contracts.js";
import { decodeSearchProgressEvidence } from "../progress-contracts.js";
import {
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
} from "./codec-primitives.js";

const DISPOSITIONS: readonly SearchDisposition[] = [
  "found",
  "not-found-after-bounded-search",
  "search-still-productive",
  "search-incomplete",
  "search-blocked",
  "stopped-no-progress",
  "stopped-hard-ceiling",
];

export function decodeDocumentationSearchFinding(value: unknown): DocumentationSearchFindingV1 {
  requireInert(value, "invalid-finding");
  rejectCredentials(value, "invalid-finding");
  const item = object(value, "invalid-finding");
  requireKeys(
    item,
    [
      "schemaVersion",
      "kind",
      "source",
      "stableGapId",
      "requirement",
      "target",
      "probeCoverage",
      "disposition",
      "findingClass",
      "confidence",
      "limitations",
      "evidenceIdentity",
      "observationSha256",
    ],
    "invalid-finding",
  );
  equal(item.schemaVersion, 1, "invalid-finding");
  equal(item.kind, "docsfab-documentation-search-finding", "invalid-finding");
  const sourceItem = object(item.source, "invalid-finding");
  requireKeys(
    sourceItem,
    ["workflow", "stepId", "planId", "planVersion", "workflowSearchEvidenceSha256"],
    "invalid-finding",
  );
  const workflow = cataloguedWorkflow(sourceItem.workflow, "invalid-finding");
  const source = {
    workflow,
    stepId: id(sourceItem.stepId, "invalid-finding"),
    planId: id(sourceItem.planId, "invalid-finding"),
    planVersion: version(sourceItem.planVersion, "invalid-finding"),
    workflowSearchEvidenceSha256: sha(sourceItem.workflowSearchEvidenceSha256, "invalid-finding"),
  };
  const requirementItem = object(item.requirement, "invalid-finding");
  requireKeys(requirementItem, ["id", "subjectSha256"], "invalid-finding");
  const requirement = {
    id: id(requirementItem.id, "invalid-finding"),
    subjectSha256: sha(requirementItem.subjectSha256, "invalid-finding"),
  };
  const targetItem = object(item.target, "invalid-finding");
  requireKeys(targetItem, ["id", "targetType", "targetSha256", "policySha256"], "invalid-finding");
  const target = {
    id: id(targetItem.id, "invalid-finding"),
    targetType: oneOf(
      targetItem.targetType,
      ["artifact-existence", "rubric-coverage"] as const,
      "invalid-finding",
    ),
    targetSha256: sha(targetItem.targetSha256, "invalid-finding"),
    policySha256: sha(targetItem.policySha256, "invalid-finding"),
  };
  const coverageItem = object(item.probeCoverage, "invalid-finding");
  requireKeys(
    coverageItem,
    [
      "requiredProbeIds",
      "completedProbeIds",
      "incompleteProbeIds",
      "probes",
      "sufficient",
      "coverageSha256",
    ],
    "invalid-finding",
  );
  const requiredProbeIds = ids(coverageItem.requiredProbeIds, "invalid-finding");
  const completedProbeIds = ids(coverageItem.completedProbeIds, "invalid-finding");
  const incompleteProbeIds = ids(coverageItem.incompleteProbeIds, "invalid-finding");
  const probes = array(coverageItem.probes, "invalid-finding").map((value) => {
    const probe = object(value, "invalid-finding");
    requireKeys(probe, ["id", "outcome", "probeSha256", "evidenceSha256"], "invalid-finding");
    return {
      id: id(probe.id, "invalid-finding"),
      outcome: oneOf(
        probe.outcome,
        ["match", "no-match", "inconclusive", "blocked"] as const,
        "invalid-finding",
      ),
      probeSha256: sha(probe.probeSha256, "invalid-finding"),
      evidenceSha256: sha(probe.evidenceSha256, "invalid-finding"),
    };
  });
  unique(
    probes.map((probe) => probe.id),
    "invalid-finding",
  );
  if (
    requiredProbeIds.length < 2 ||
    canonicalDigest([...probes].sort((a, b) => a.id.localeCompare(b.id))) !==
      canonicalDigest(probes) ||
    [...completedProbeIds, ...incompleteProbeIds].sort().join(",") !== requiredProbeIds.join(",") ||
    completedProbeIds.some((probeId) => !probes.some((probe) => probe.id === probeId)) ||
    probes.some((probe) => !requiredProbeIds.includes(probe.id))
  ) {
    fail("invalid-finding");
  }
  const probeCoverage = {
    requiredProbeIds,
    completedProbeIds,
    incompleteProbeIds,
    probes,
    sufficient: bool(coverageItem.sufficient, "invalid-finding"),
    coverageSha256: sha(coverageItem.coverageSha256, "invalid-finding"),
  };
  const disposition = oneOf(item.disposition, DISPOSITIONS, "invalid-finding");
  const findingClass = oneOf(
    item.findingClass,
    ["presence", "absence", "inconclusive", "blocked"] as const,
    "invalid-finding",
  );
  if (findingClassFor(disposition) !== findingClass) fail("invalid-finding");
  const confidenceItem = object(item.confidence, "invalid-finding");
  requireKeys(confidenceItem, ["level", "saturation", "confidenceSha256"], "invalid-finding");
  const confidence = {
    level: oneOf(
      confidenceItem.level,
      ["confirmed", "bounded", "inconclusive", "blocked"] as const,
      "invalid-finding",
    ),
    saturation: oneOf(
      confidenceItem.saturation,
      ["saturated", "productive", "not-observed"] as const,
      "invalid-finding",
    ),
    confidenceSha256: sha(confidenceItem.confidenceSha256, "invalid-finding"),
  };
  const expectedLevel =
    disposition === "found"
      ? "confirmed"
      : disposition === "not-found-after-bounded-search"
        ? "bounded"
        : disposition === "search-blocked" || disposition === "stopped-hard-ceiling"
          ? "blocked"
          : "inconclusive";
  const allCriteria =
    source.workflow === "release-documentation-readiness" &&
    source.planId === "release-documentation-readiness-discovery" &&
    source.planVersion === "2.0.0";
  const matched = probeCoverage.probes.some((probe) => probe.outcome === "match");
  const allMatched = probeCoverage.probes.every((probe) => probe.outcome === "match");
  if (
    confidence.level !== expectedLevel ||
    (findingClass === "absence" &&
      (!probeCoverage.sufficient ||
        probeCoverage.incompleteProbeIds.length > 0 ||
        (allCriteria
          ? probeCoverage.probes.some(
              (probe) => probe.outcome !== "match" && probe.outcome !== "no-match",
            ) || allMatched
          : probeCoverage.probes.some((probe) => probe.outcome !== "no-match")))) ||
    (findingClass === "presence" && (allCriteria ? !allMatched : !matched)) ||
    (findingClass === "blocked" &&
      !probeCoverage.probes.some((probe) => probe.outcome === "blocked"))
  ) {
    fail("invalid-finding");
  }
  const limitations = array(item.limitations, "invalid-finding").map((value) => {
    const limitation = object(value, "invalid-finding");
    requireKeys(
      limitation,
      ["id", "category", "impact", "probeIds", "detailSha256", "limitationSha256"],
      "invalid-finding",
    );
    return {
      id: id(limitation.id, "invalid-finding"),
      category: oneOf(
        limitation.category,
        [
          "access-denied",
          "hard-ceiling",
          "index-incomplete",
          "tool-failure",
          "unsupported-operation",
          "scope-excluded",
          "timeout",
          "evidence-unavailable",
        ] as const,
        "invalid-finding",
      ),
      impact: oneOf(limitation.impact, ["non-blocking", "blocking"] as const, "invalid-finding"),
      probeIds: ids(limitation.probeIds, "invalid-finding"),
      detailSha256: sha(limitation.detailSha256, "invalid-finding"),
      limitationSha256: sha(limitation.limitationSha256, "invalid-finding"),
    };
  });
  unique(
    limitations.map((limitation) => limitation.id),
    "invalid-finding",
  );
  if (
    limitations.some(
      (limitation) =>
        limitation.probeIds.some(
          (probeId) => !probeCoverage.probes.some((probe) => probe.id === probeId),
        ) ||
        limitation.limitationSha256 !==
          createDigest({
            schemaVersion: 1,
            kind: "docsfab-search-limitation",
            id: limitation.id,
            category: limitation.category,
            impact: limitation.impact,
            targetSha256: target.targetSha256,
            probeIds: limitation.probeIds,
            detailSha256: limitation.detailSha256,
          }),
    )
  ) {
    fail("invalid-finding");
  }
  const identityItem = object(item.evidenceIdentity, "invalid-finding");
  requireKeys(
    identityItem,
    [
      "repositoryIdentitySha256",
      "repositoryRevision",
      "workspaceSnapshotSha256",
      "boundedSearchEvidenceSha256",
      "searchFindingSha256",
    ],
    "invalid-finding",
  );
  const evidenceIdentity = {
    repositoryIdentitySha256: sha(identityItem.repositoryIdentitySha256, "invalid-finding"),
    repositoryRevision: revision(identityItem.repositoryRevision, "invalid-finding"),
    workspaceSnapshotSha256: sha(identityItem.workspaceSnapshotSha256, "invalid-finding"),
    boundedSearchEvidenceSha256: sha(identityItem.boundedSearchEvidenceSha256, "invalid-finding"),
    searchFindingSha256: sha(identityItem.searchFindingSha256, "invalid-finding"),
  };
  const stableGapId = id(item.stableGapId, "invalid-finding");
  if (!/^search-finding:[a-f0-9]{32}$/u.test(stableGapId)) fail("invalid-finding");
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-documentation-search-finding" as const,
    source,
    stableGapId,
    requirement,
    target,
    probeCoverage,
    disposition,
    findingClass,
    confidence,
    limitations,
    evidenceIdentity,
  };
  const observationSha256 = sha(item.observationSha256, "invalid-finding");
  if (observationSha256 !== canonicalDigest(body)) fail("invalid-finding");
  return deepFreeze({ ...body, observationSha256 });
}

export function workflowEvidence(value: unknown): WorkflowSearchStepEvidenceV1 {
  const item = object(value, "invalid-finding");
  requireKeys(
    item,
    [
      "schemaVersion",
      "kind",
      "planId",
      "planVersion",
      "workspaceSnapshotSha256",
      "searches",
      "evidenceSha256",
    ],
    "invalid-finding",
  );
  equal(item.schemaVersion, 1, "invalid-finding");
  equal(item.kind, "docsfab-workflow-search-evidence", "invalid-finding");
  const evidenceSha256 = sha(item.evidenceSha256, "invalid-finding");
  const workspaceSnapshotSha256 = sha(item.workspaceSnapshotSha256, "invalid-finding");
  if (
    evidenceSha256 !==
    createDigest({
      schemaVersion: item.schemaVersion,
      kind: item.kind,
      planId: item.planId,
      planVersion: item.planVersion,
      workspaceSnapshotSha256,
      searches: item.searches,
    })
  ) {
    fail("invalid-finding");
  }
  const searches = array(item.searches, "invalid-finding").map((value) => {
    const search = object(value, "invalid-finding");
    requireKeys(search, ["targetId", "bounded", "progress"], "invalid-finding");
    const bounded = decodeBoundedSearchEvidence(search.bounded);
    const progress = decodeSearchProgressEvidence(search.progress);
    if (
      id(search.targetId, "invalid-finding") !== bounded.target.id ||
      canonicalDigest(progress.target) !== canonicalDigest(bounded.target) ||
      canonicalDigest(progress.probes) !== canonicalDigest(bounded.probes) ||
      canonicalDigest(progress.limitations) !== canonicalDigest(bounded.limitations) ||
      progress.recommendation.disposition !== bounded.confidence.disposition ||
      canonicalDigest(progress.recommendation.saturation) !==
        canonicalDigest(bounded.confidence.saturation) ||
      progress.recommendation.recommendation !== "stop" ||
      progress.recommendation.disposition === "search-still-productive"
    ) {
      fail("invalid-finding");
    }
    return { targetId: bounded.target.id, bounded, progress };
  });
  if (
    searches.length === 0 ||
    new Set(searches.map((search) => search.targetId)).size !== searches.length ||
    searches.some(
      (search) =>
        search.bounded.target.repository.identitySha256 !==
          searches[0]!.bounded.target.repository.identitySha256 ||
        search.bounded.target.repository.revision !==
          searches[0]!.bounded.target.repository.revision,
    )
  ) {
    fail("invalid-finding");
  }
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-workflow-search-evidence" as const,
    planId: id(item.planId, "invalid-finding"),
    planVersion: version(item.planVersion, "invalid-finding"),
    workspaceSnapshotSha256,
    searches,
  };
  return deepFreeze({ ...body, evidenceSha256 }) as WorkflowSearchStepEvidenceV1;
}

function findingClassFor(
  disposition: SearchDisposition,
): DocumentationSearchFindingV1["findingClass"] {
  if (disposition === "found") return "presence";
  if (disposition === "not-found-after-bounded-search") return "absence";
  if (disposition === "search-blocked" || disposition === "stopped-hard-ceiling") return "blocked";
  return "inconclusive";
}

function createDigest(value: unknown): string {
  return createHash("sha256")
    .update(canonicalizeJsonEvidence(value as JsonEvidenceValue))
    .digest("hex");
}
