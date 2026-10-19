// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Documentation maturity cascade — non-authoritative reporting / inspection layer.
 * Projections never restore finding, tracker, assessment, or write authority.
 */

import type { RepositoryWorkspace } from "../../repository/workspace/contracts.js";
import * as workflowCatalog from "../../workflow-registry/catalog.js";
import {
  decodeDocumentationMaturityWorkUnit,
  type DocumentationMaturityGateId,
  type DocumentationMaturityWorkUnitV1,
} from "../contracts.js";
import {
  decodeDocumentationMaturityGateEvaluation,
  type DocumentationMaturityGateEvaluationV1,
} from "../evaluators.js";
import {
  MAXIMUM_CASCADE_CANDIDATES,
  MAXIMUM_COMPATIBILITY_CANDIDATES,
  MAXIMUM_FINDING_ONLY_CANDIDATES,
  MAXIMUM_INERT_DEPTH,
  MAXIMUM_RANKING_INSPECTION_NODES,
  MAXIMUM_WORK_UNITS,
  TRACKER_OBSERVATION_LIFETIME_MS,
  assertInertPlainData,
  boundedInteger,
  canonicalDigest,
  decodeDocumentationMaturityCascadeAssessment,
  deepFreeze,
  denseArray,
  exactObject,
  exactShallow,
  fail,
  gateId,
  normalizeTrackerIssues,
  repositoryPath,
  safeToken,
  sha,
  timestamp,
  type CascadeExceptionV1,
  type DocumentationMaturityCascadeAssessmentV1,
  type DocumentationMaturityCascadeRankInspectionV1,
  type DocumentationMaturityCascadeSelectionInspectionV1,
  type DocumentationMaturityCandidateBudgetInspectionV1,
  type DocumentationMaturityGitLabBindingInspectionV1,
  type DocumentationMaturityPrerequisiteExceptionInspectionV1,
} from "./dialect.js";
import {
  assertCascadeCandidateBudget,
  buildDependencyGraph,
  buildSelection,
  compareRankedCandidates,
  loadCascadeExceptions,
  rankFor,
  validException,
} from "./selection.js";
import {
  parseGitLabRemote,
  snapshotGitLabProjectMetadata,
  snapshotHostGitLabConfiguration,
} from "./tracker.js";

/**
 * Explain the fixed ranking policy over self-checksummed work units. This
 * projection never restores finding, tracker, assessment, or write authority
 * and is not accepted by selectDocumentationMaturityWorkUnit.
 */
export function inspectDocumentationMaturityWorkUnitRanking(inputValue: {
  workUnits: readonly unknown[];
  trackerIssues: readonly unknown[];
}): DocumentationMaturityCascadeRankInspectionV1[] {
  const input = exactShallow(inputValue, ["workUnits", "trackerIssues"], "invalid-input");
  assertInertPlainData(
    inputValue,
    "invalid-input",
    MAXIMUM_RANKING_INSPECTION_NODES,
    MAXIMUM_INERT_DEPTH,
  );
  const trackerIssues = normalizeTrackerIssues(input.trackerIssues);
  const units = denseArray(input.workUnits, MAXIMUM_WORK_UNITS, "invalid-input").map((value) => {
    try {
      return { workUnit: decodeDocumentationMaturityWorkUnit(value, workflowCatalog) };
    } catch {
      fail("invalid-input");
    }
  });
  const graph = buildDependencyGraph(units, trackerIssues);
  const ranked = units
    .map((unit) => {
      const dependencies = graph.dependencies.get(unit.workUnit.workUnitFingerprint)?.size ?? 0;
      const unresolved =
        graph.unresolvedReasons.get(unit.workUnit.workUnitFingerprint)?.length ?? 0;
      const trackerState = graph.trackerStates.get(unit.workUnit.findingFingerprint) ?? "absent";
      const eligibility: DocumentationMaturityCascadeRankInspectionV1["eligibility"] =
        dependencies > 0 || unresolved > 0
          ? "dependency-blocked"
          : unit.workUnit.confidence === "inconclusive" ||
              trackerState === "closed-unverified" ||
              trackerState === "conflict"
            ? "investigation"
            : unit.workUnit.execution.state !== "ready" ||
                trackerState === "complete" ||
                (unit.workUnit.disposition !== "observed-absence" &&
                  unit.workUnit.disposition !== "bounded-not-found")
              ? "not-executable"
              : "ready";
      return {
        workUnitFingerprint: unit.workUnit.workUnitFingerprint,
        eligibility,
        rank: rankFor({ gate: { gateId: unit.workUnit.gateId }, workUnit: unit.workUnit }, graph),
        workUnit: unit.workUnit,
      };
    })
    .sort(compareRankedCandidates);
  return deepFreeze(ranked.map(({ workUnit: _workUnit, ...inspection }) => inspection));
}

/**
 * Explicitly non-authoritative seam for deterministic policy explanation and
 * hostile/race tests. Its synthetic observation is never entered into the
 * production observation WeakMap and cannot be used by the selector.
 */
export async function inspectDocumentationMaturityCascadeSelection(inputValue: {
  assessment: DocumentationMaturityCascadeAssessmentV1;
  trackerIssues: readonly unknown[];
  policyWorkspace: RepositoryWorkspace;
  observedAt: string;
  timeSource: () => Date;
}): Promise<DocumentationMaturityCascadeSelectionInspectionV1> {
  const input = exactShallow(
    inputValue,
    ["assessment", "trackerIssues", "policyWorkspace", "observedAt", "timeSource"],
    "invalid-input",
  );
  const assessmentValue = input.assessment;
  if (typeof input.timeSource !== "function") fail("invalid-input");
  const assessment = decodeDocumentationMaturityCascadeAssessment(assessmentValue);
  const observedAt = timestamp(input.observedAt, "invalid-input");
  const observedAtEpochMs = Date.parse(observedAt);
  const expiresAtEpochMs = observedAtEpochMs + TRACKER_OBSERVATION_LIFETIME_MS;
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-documentation-maturity-cascade-tracker-observation" as const,
    repository: assessment.repository,
    projectSha256: canonicalDigest({ authority: "non-authoritative" }),
    observedAt,
    expiresAt: new Date(expiresAtEpochMs).toISOString(),
    issues: normalizeTrackerIssues(input.trackerIssues),
  };
  const tracker = deepFreeze({ ...body, observationSha256: canonicalDigest(body) });
  const assertCurrent = (): void => {
    let now: number;
    try {
      now = (input.timeSource as () => Date)().getTime();
    } catch {
      fail("invalid-input");
    }
    if (!Number.isFinite(now) || now < observedAtEpochMs || now >= expiresAtEpochMs) {
      fail("invalid-tracker-observation");
    }
  };
  assertCurrent();
  const exceptions = await loadCascadeExceptions(
    input.policyWorkspace,
    assessment.repository,
    assessment.gates,
    assertCurrent,
  );
  assertCurrent();
  return deepFreeze({
    authority: "non-authoritative" as const,
    selection: buildSelection(assessment, tracker, exceptions),
  });
}

/** Pure, non-authoritative explanation of canonical remote/project binding. */
export function inspectDocumentationMaturityGitLabBinding(inputValue: {
  remote: string;
  metadata: unknown;
  expectedProject: { host: string; fullPath: string; projectId: number; sshPort: number };
}): DocumentationMaturityGitLabBindingInspectionV1 {
  const input = exactShallow(
    inputValue,
    ["remote", "metadata", "expectedProject"],
    "invalid-input",
  );
  if (typeof input.remote !== "string") fail("invalid-input");
  const binding = parseGitLabRemote(input.remote);
  if (!binding) fail("invalid-input");
  const expected = exactShallow(
    input.expectedProject,
    ["host", "fullPath", "projectId", "sshPort"],
    "invalid-input",
  );
  const configuration = snapshotHostGitLabConfiguration({
    DOCSFAB_ROADMAP_GITLAB_HOST: expected.host as string,
    DOCSFAB_ROADMAP_GITLAB_FULL_PATH: expected.fullPath as string,
    DOCSFAB_ROADMAP_GITLAB_PROJECT_ID: String(expected.projectId),
    DOCSFAB_ROADMAP_GITLAB_SSH_PORT: String(expected.sshPort),
  });
  if (
    !configuration ||
    binding.host !== configuration.host ||
    binding.fullPath !== configuration.fullPath ||
    (binding.transport === "ssh" && binding.sshPort !== configuration.sshPort)
  )
    fail("repository-mismatch");
  return deepFreeze({
    authority: "non-authoritative" as const,
    project: snapshotGitLabProjectMetadata(input.metadata, configuration),
  });
}

/** Pure, non-authoritative explanation of the central-gate exception rule. */
export function inspectDocumentationMaturityPrerequisiteException(inputValue: {
  exception: unknown;
  prerequisite: unknown;
  targetGateId: DocumentationMaturityGateId;
  workUnit: unknown;
}): DocumentationMaturityPrerequisiteExceptionInspectionV1 {
  const input = exactShallow(
    inputValue,
    ["exception", "prerequisite", "targetGateId", "workUnit"],
    "invalid-input",
  );
  assertInertPlainData(inputValue, "invalid-input");
  let prerequisite: DocumentationMaturityGateEvaluationV1;
  let workUnit: DocumentationMaturityWorkUnitV1;
  try {
    prerequisite = decodeDocumentationMaturityGateEvaluation(input.prerequisite);
    workUnit = decodeDocumentationMaturityWorkUnit(input.workUnit, workflowCatalog);
  } catch {
    fail("invalid-input");
  }
  const targetGateId = gateId(input.targetGateId, "invalid-input");
  const item = exactObject(
    input.exception,
    [
      "id",
      "prerequisiteGateId",
      "targetGateId",
      "candidateWorkUnitFingerprint",
      "candidateScopeSha256",
      "evidencePath",
      "evidenceSha256",
      "rationale",
    ],
    "invalid-input",
  );
  const exception: CascadeExceptionV1 = {
    id: safeToken(item.id, "invalid-input"),
    prerequisiteGateId: gateId(item.prerequisiteGateId, "invalid-input"),
    targetGateId: gateId(item.targetGateId, "invalid-input"),
    candidateWorkUnitFingerprint: sha(item.candidateWorkUnitFingerprint, "invalid-input"),
    candidateScopeSha256: sha(item.candidateScopeSha256, "invalid-input"),
    evidencePath: repositoryPath(item.evidencePath, "invalid-input"),
    evidenceSha256: sha(item.evidenceSha256, "invalid-input"),
    rationale: item.rationale === "independent-scope" ? "independent-scope" : fail("invalid-input"),
  };
  const target = {
    gate: { gateId: targetGateId } as DocumentationMaturityGateEvaluationV1,
    workUnit,
    finding: prerequisite.findings[0]!,
  };
  const valid =
    exception.prerequisiteGateId === prerequisite.gateId &&
    exception.targetGateId === targetGateId &&
    exception.candidateWorkUnitFingerprint === workUnit.workUnitFingerprint &&
    validException(exception, prerequisite, target, [prerequisite]);
  return deepFreeze({ authority: "non-authoritative" as const, valid });
}

/** Explain the one aggregate candidate ceiling without constructing decisions. */
export function inspectDocumentationMaturityCandidateBudget(inputValue: {
  nativeWorkUnitCount: number;
  findingOnlyCount: number;
  adaptedWorkUnitCount: number;
}): DocumentationMaturityCandidateBudgetInspectionV1 {
  const input = exactShallow(
    inputValue,
    ["nativeWorkUnitCount", "findingOnlyCount", "adaptedWorkUnitCount"],
    "invalid-input",
  );
  const counts = {
    nativeWorkUnitCount: boundedInteger(
      input.nativeWorkUnitCount,
      0,
      MAXIMUM_WORK_UNITS,
      "invalid-input",
    ),
    findingOnlyCount: boundedInteger(
      input.findingOnlyCount,
      0,
      MAXIMUM_FINDING_ONLY_CANDIDATES,
      "invalid-input",
    ),
    adaptedWorkUnitCount: boundedInteger(
      input.adaptedWorkUnitCount,
      0,
      MAXIMUM_COMPATIBILITY_CANDIDATES,
      "invalid-input",
    ),
  };
  assertCascadeCandidateBudget(counts, "invalid-input");
  return deepFreeze({
    authority: "non-authoritative" as const,
    ...counts,
    aggregateCount:
      counts.nativeWorkUnitCount + counts.findingOnlyCount + counts.adaptedWorkUnitCount,
    maximumAggregateCount: MAXIMUM_CASCADE_CANDIDATES,
  });
}
