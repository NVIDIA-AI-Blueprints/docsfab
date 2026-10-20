// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Documentation maturity cascade — authoritative selection layer.
 * Owns G0–G5 assessment and work-unit selection semantics.
 */

import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

import type { SanitizedRoadmapIssue } from "../../roadmap/planning.js";
import {
  listTrackedRepositoryFiles,
  readTrackedRepositoryFile,
  verifyActiveRepositoryWorkspace,
  verifyTrackedRepositoryEntries,
} from "../../repository/workspace/tracked-read.js";
import type { RepositoryWorkspace } from "../../repository/workspace/contracts.js";
import {
  DOCUMENTATION_MATURITY_GATE_CATALOG,
  type DocumentationMaturityGateId,
  type DocumentationMaturityRepositoryBindingV1,
  type DocumentationMaturityWorkUnitV1,
} from "../contracts.js";
import {
  DOCUMENTATION_MATURITY_EVALUATOR_CATALOG,
  evaluateDocumentationMaturityGate,
  type DocumentationMaturityGateEvaluationV1,
} from "../evaluators.js";
import {
  DOCUMENTATION_MATURITY_CASCADE_ALGORITHM_VERSION,
  DOCUMENTATION_MATURITY_CASCADE_POLICY_PATH,
  MAXIMUM_CASCADE_CANDIDATES,
  MAXIMUM_COMPATIBILITY_CANDIDATES,
  MAXIMUM_EXCEPTION_EVIDENCE_BYTES,
  MAXIMUM_EXCEPTIONS,
  MAXIMUM_FINDING_ONLY_CANDIDATES,
  MAXIMUM_POLICY_BYTES,
  MAXIMUM_WORK_UNITS,
  authenticAssessments,
  authenticSelections,
  authenticTrackerObservations,
  canonicalDigest,
  canonicalJson,
  commonRepository,
  decodeDocumentationMaturityCascadeAssessment,
  decodeDocumentationMaturityCascadeSelection,
  decodeDocumentationMaturityCascadeTrackerObservation,
  assertInertPlainData,
  deepFreeze,
  denseArray,
  exactObject,
  exactShallow,
  fail,
  gateId,
  gateOrdinal,
  repositoryPath,
  safeToken,
  sha,
  snapshotGateInputs,
  unique,
  type AuthenticTrackerObservationState,
  type CascadeExceptionV1,
  type CascadeUnit,
  type DependencyGraph,
  type DocumentationMaturityCascadeAssessmentV1,
  type DocumentationMaturityCascadeCandidateDecisionV1,
  type DocumentationMaturityCascadeCandidateStatus,
  type DocumentationMaturityCascadeErrorCode,
  type DocumentationMaturityCascadeOutcomeV1,
  type DocumentationMaturityCascadeRankV1,
  type DocumentationMaturityCascadeSelectionV1,
  type DocumentationMaturityCascadeTrackerObservationV1,
  type GateInput,
  type TrackerFindingState,
  DocumentationMaturityCascadeError,
} from "./dialect.js";

const hostMonotonicNow = performance.now.bind(performance);

/** Evaluate exactly G0-G5 from the original source authorities. */
export async function assessDocumentationMaturityCascade(inputValue: {
  gateInputs: readonly GateInput[];
}): Promise<DocumentationMaturityCascadeAssessmentV1> {
  const input = exactShallow(inputValue, ["gateInputs"], "invalid-input");
  const gateInputs = snapshotGateInputs(input.gateInputs);
  const gates = await Promise.all(
    gateInputs.map((gateInput) => evaluateDocumentationMaturityGate(gateInput)),
  );
  const repository = commonRepository(gates, "invalid-assessment");
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-documentation-maturity-cascade-assessment" as const,
    algorithmVersion: DOCUMENTATION_MATURITY_CASCADE_ALGORITHM_VERSION,
    gateCatalogSha256: DOCUMENTATION_MATURITY_GATE_CATALOG.catalogSha256,
    evaluatorCatalogSha256: DOCUMENTATION_MATURITY_EVALUATOR_CATALOG.catalogSha256,
    repository,
    gates,
  };
  const assessment = deepFreeze({ ...body, assessmentSha256: canonicalDigest(body) });
  authenticAssessments.set(assessment, {
    gateInputs,
    sourcePath: gateInputs[0]!.repository.sourcePath,
  });
  return assessment;
}

/** Re-run all source adapters; structural decoding alone does not restore authority. */
export async function validateDocumentationMaturityCascadeAssessment(
  value: unknown,
  inputValue: Parameters<typeof assessDocumentationMaturityCascade>[0],
): Promise<DocumentationMaturityCascadeAssessmentV1> {
  const decoded = decodeDocumentationMaturityCascadeAssessment(value);
  const expected = await assessDocumentationMaturityCascade(inputValue);
  if (canonicalJson(decoded) !== canonicalJson(expected)) fail("invalid-assessment");
  return expected;
}

/** Select at most one exact executable unit from an authenticated assessment. */
export async function selectDocumentationMaturityWorkUnit(inputValue: {
  assessment: DocumentationMaturityCascadeAssessmentV1;
  trackerObservation: DocumentationMaturityCascadeTrackerObservationV1;
  policyWorkspace: RepositoryWorkspace;
}): Promise<DocumentationMaturityCascadeSelectionV1> {
  const input = exactShallow(
    inputValue,
    ["assessment", "trackerObservation", "policyWorkspace"],
    "invalid-input",
  );
  const assessmentValue = input.assessment;
  const trackerObservationValue = input.trackerObservation;
  if (
    !assessmentValue ||
    typeof assessmentValue !== "object" ||
    !authenticAssessments.has(assessmentValue)
  ) {
    fail("invalid-assessment");
  }
  const trackerState =
    trackerObservationValue && typeof trackerObservationValue === "object"
      ? authenticTrackerObservations.get(trackerObservationValue)
      : undefined;
  if (!trackerState) fail("invalid-tracker-observation");
  if (input.policyWorkspace !== trackerState.workspace) fail("repository-mismatch");
  const assessment = assessmentValue as DocumentationMaturityCascadeAssessmentV1;
  const trackerObservation =
    trackerObservationValue as DocumentationMaturityCascadeTrackerObservationV1;
  if (canonicalJson(assessment.repository) !== canonicalJson(trackerObservation.repository)) {
    fail("repository-mismatch");
  }
  const assessmentSnapshot = decodeDocumentationMaturityCascadeAssessment(assessment);
  const trackerSnapshot = decodeDocumentationMaturityCascadeTrackerObservation(trackerObservation);
  assertCurrentTrackerObservation(
    trackerObservation,
    trackerState,
    assessment,
    assessmentSnapshot.repository,
  );
  if (canonicalJson(trackerSnapshot) !== canonicalJson(trackerState.snapshot)) {
    fail("invalid-tracker-observation");
  }
  const exceptions = await loadCascadeExceptions(
    input.policyWorkspace,
    assessmentSnapshot.repository,
    assessmentSnapshot.gates,
    (): void =>
      assertCurrentTrackerObservation(
        trackerObservation,
        trackerState,
        assessment,
        assessmentSnapshot.repository,
      ),
  );
  assertCurrentTrackerObservation(
    trackerObservation,
    trackerState,
    assessment,
    assessmentSnapshot.repository,
  );
  const selection = buildSelection(assessmentSnapshot, trackerSnapshot, exceptions);
  const authenticSelection = deepFreeze(selection);
  authenticSelections.set(authenticSelection, { assessment, trackerObservation });
  return authenticSelection;
}

export async function validateDocumentationMaturityCascadeSelection(
  value: unknown,
  inputValue: Parameters<typeof selectDocumentationMaturityWorkUnit>[0],
): Promise<DocumentationMaturityCascadeSelectionV1> {
  const state = value && typeof value === "object" ? authenticSelections.get(value) : undefined;
  if (
    !state ||
    state.assessment !== inputValue.assessment ||
    state.trackerObservation !== inputValue.trackerObservation
  )
    fail("invalid-assessment");
  const decoded = decodeDocumentationMaturityCascadeSelection(value);
  const expected = await selectDocumentationMaturityWorkUnit(inputValue);
  if (canonicalJson(decoded) !== canonicalJson(expected)) fail("invalid-assessment");
  return expected;
}

export function assertCurrentTrackerObservation(
  observation: DocumentationMaturityCascadeTrackerObservationV1,
  state: AuthenticTrackerObservationState,
  assessment: DocumentationMaturityCascadeAssessmentV1,
  repository: DocumentationMaturityRepositoryBindingV1,
): void {
  const now = hostMonotonicNow();
  const invalid = [
    !Number.isFinite(now),
    now < state.observedAtMonotonicMs,
    now >= state.expiresAtMonotonicMs,
    state.assessment !== assessment,
    state.assessmentSha256 !== assessment.assessmentSha256,
    state.snapshot !== observation,
    canonicalJson(state.assessmentRepository) !== canonicalJson(repository),
    observation.projectSha256 !== canonicalDigest(state.project),
    observation.observedAt !== new Date(state.observedAtEpochMs).toISOString(),
    observation.expiresAt !== new Date(state.expiresAtEpochMs).toISOString(),
  ];
  if (invalid.some(Boolean)) {
    fail("invalid-tracker-observation");
  }
}

export function candidateCounts(assessment: DocumentationMaturityCascadeAssessmentV1): {
  nativeWorkUnitCount: number;
  findingOnlyCount: number;
  adaptedWorkUnitCount: number;
} {
  return assessment.gates.reduce(
    (counts, gate) => ({
      nativeWorkUnitCount: counts.nativeWorkUnitCount + gate.workUnits.length,
      findingOnlyCount:
        counts.findingOnlyCount +
        gate.findings.filter(
          (finding) =>
            !gate.workUnits.some((unit) => unit.findingFingerprint === finding.fingerprint),
        ).length,
      adaptedWorkUnitCount: counts.adaptedWorkUnitCount + gate.adaptedWorkUnits.length,
    }),
    { nativeWorkUnitCount: 0, findingOnlyCount: 0, adaptedWorkUnitCount: 0 },
  );
}

export function assertCascadeCandidateBudget(
  counts: { nativeWorkUnitCount: number; findingOnlyCount: number; adaptedWorkUnitCount: number },
  code: DocumentationMaturityCascadeErrorCode,
): void {
  const aggregate =
    counts.nativeWorkUnitCount + counts.findingOnlyCount + counts.adaptedWorkUnitCount;
  if (
    !Number.isSafeInteger(aggregate) ||
    counts.nativeWorkUnitCount > MAXIMUM_WORK_UNITS ||
    counts.findingOnlyCount > MAXIMUM_FINDING_ONLY_CANDIDATES ||
    counts.adaptedWorkUnitCount > MAXIMUM_COMPATIBILITY_CANDIDATES ||
    aggregate > MAXIMUM_CASCADE_CANDIDATES
  )
    fail(code);
}

export function buildSelection(
  assessment: DocumentationMaturityCascadeAssessmentV1,
  trackerObservation: DocumentationMaturityCascadeTrackerObservationV1,
  exceptions: readonly CascadeExceptionV1[],
): DocumentationMaturityCascadeSelectionV1 {
  assertCascadeCandidateBudget(candidateCounts(assessment), "invalid-assessment");
  const allUnits: CascadeUnit[] = assessment.gates.flatMap((gate) =>
    gate.workUnits.map((workUnit) => ({
      gate,
      workUnit,
      finding: gate.findings.find(
        (finding) => finding.fingerprint === workUnit.findingFingerprint,
      )!,
    })),
  );
  if (allUnits.some((item) => !item.finding)) fail("invalid-assessment");
  const dependencyGraph = buildDependencyGraph(allUnits, trackerObservation.issues);
  const eligible: Array<{
    key: string;
    gate: DocumentationMaturityGateEvaluationV1;
    workUnit: DocumentationMaturityWorkUnitV1;
    rank: DocumentationMaturityCascadeRankV1;
    exceptionIds: string[];
    reasonCodes: string[];
  }> = [];
  const decisions: DocumentationMaturityCascadeCandidateDecisionV1[] = [];
  const usedExceptionIds = new Set<string>();

  for (const item of allUnits) {
    const key = `maturity:${item.workUnit.workUnitFingerprint}`;
    const reasons: string[] = [];
    const advisoryReasons: string[] = [];
    const exceptionIds: string[] = [];
    for (const prerequisite of unresolvedPrerequisites(item.gate.gateId, assessment.gates)) {
      const exception = exceptions.find(
        (candidate) =>
          candidate.prerequisiteGateId === prerequisite.gateId &&
          candidate.targetGateId === item.gate.gateId &&
          candidate.candidateWorkUnitFingerprint === item.workUnit.workUnitFingerprint,
      );
      if (!exception || !validException(exception, prerequisite, item, assessment.gates)) {
        reasons.push(`prerequisite-blocked:${prerequisite.gateId}`);
      } else {
        exceptionIds.push(exception.id);
        usedExceptionIds.add(exception.id);
      }
    }
    if (item.workUnit.execution.state === "missing-input") reasons.push("missing-input");
    if (item.workUnit.confidence === "inconclusive") reasons.push("inconclusive-evidence");
    if (
      item.workUnit.disposition !== "observed-absence" &&
      item.workUnit.disposition !== "bounded-not-found"
    )
      reasons.push("unsupported-write-disposition");
    if ((dependencyGraph.dependencies.get(item.workUnit.workUnitFingerprint)?.size ?? 0) > 0) {
      reasons.push("pending-current-dependency");
    }
    reasons.push(
      ...(dependencyGraph.unresolvedReasons.get(item.workUnit.workUnitFingerprint) ?? []),
    );
    const trackerState =
      dependencyGraph.trackerStates.get(item.workUnit.findingFingerprint) ?? "absent";
    if (trackerState === "active") advisoryReasons.push("tracker-active-reuse");
    if (trackerState === "complete") reasons.push("tracker-complete");
    if (trackerState === "closed-unverified") reasons.push("tracker-closed-unverified");
    if (trackerState === "conflict") reasons.push("tracker-fingerprint-conflict");
    const rank = rankFor(item, dependencyGraph);
    const status: DocumentationMaturityCascadeCandidateStatus = reasons.some((reason) =>
      reason.startsWith("prerequisite-blocked:"),
    )
      ? "prerequisite-blocked"
      : reasons.includes("missing-input")
        ? "missing-input"
        : reasons.includes("pending-current-dependency") ||
            reasons.some(
              (reason) =>
                reason.startsWith("unresolved-") || reason.startsWith("tracker-dependency-"),
            )
          ? "dependency-blocked"
          : reasons.includes("inconclusive-evidence") ||
              reasons.includes("tracker-closed-unverified") ||
              reasons.includes("tracker-fingerprint-conflict")
            ? "investigation"
            : reasons.length > 0
              ? "not-executable"
              : "eligible-not-selected";
    decisions.push({
      key,
      gateId: item.gate.gateId,
      findingFingerprint: item.workUnit.findingFingerprint,
      workUnitFingerprint: item.workUnit.workUnitFingerprint,
      status,
      reasonCodes: [...reasons, ...advisoryReasons].sort(),
      rank,
    });
    if (reasons.length === 0)
      eligible.push({
        key,
        gate: item.gate,
        workUnit: item.workUnit,
        rank,
        exceptionIds,
        reasonCodes: advisoryReasons,
      });
  }

  for (const gate of assessment.gates) {
    for (const finding of gate.findings.filter(
      (candidate) =>
        !gate.workUnits.some((unit) => unit.findingFingerprint === candidate.fingerprint),
    )) {
      const blockedBy = unresolvedPrerequisites(gate.gateId, assessment.gates);
      const missing = finding.requiredHumanInput.some((item) => item.status === "missing");
      decisions.push({
        key: `finding:${finding.fingerprint}`,
        gateId: gate.gateId,
        findingFingerprint: finding.fingerprint,
        workUnitFingerprint: null,
        status:
          blockedBy.length > 0
            ? "prerequisite-blocked"
            : missing
              ? "missing-input"
              : "investigation",
        reasonCodes:
          blockedBy.length > 0
            ? blockedBy.map((prerequisite) => `prerequisite-blocked:${prerequisite.gateId}`).sort()
            : [missing ? "missing-input" : "no-executable-work-unit"],
        rank: null,
      });
    }
    for (const adapted of gate.adaptedWorkUnits) {
      const blockedBy = unresolvedPrerequisites(gate.gateId, assessment.gates);
      decisions.push({
        key: `release-readiness:${adapted.value.workUnitSha256}`,
        gateId: gate.gateId,
        findingFingerprint: null,
        workUnitFingerprint: null,
        status:
          blockedBy.length > 0
            ? "prerequisite-blocked"
            : adapted.value.requiredHumanInput.length > 0
              ? "missing-input"
              : "investigation",
        reasonCodes:
          blockedBy.length > 0
            ? blockedBy.map((prerequisite) => `prerequisite-blocked:${prerequisite.gateId}`).sort()
            : [
                adapted.value.requiredHumanInput.length > 0
                  ? "missing-input"
                  : "adapted-unit-scope-unavailable",
              ],
        rank: null,
      });
    }
  }

  for (const exception of exceptions) {
    if (!usedExceptionIds.has(exception.id)) fail("invalid-policy");
  }
  eligible.sort(compareRankedCandidates);
  let outcome: DocumentationMaturityCascadeOutcomeV1;
  if (eligible.length > 0) {
    const selected = eligible[0]!;
    const selectedDecision = decisions.find((candidate) => candidate.key === selected.key)!;
    selectedDecision.status = "selected";
    selectedDecision.reasonCodes = [
      ...selected.reasonCodes,
      ...selected.exceptionIds.map((id) => `nonblocking-exception:${id}`),
    ].sort();
    for (const candidate of decisions) {
      if (candidate.status === "eligible-not-selected") {
        candidate.reasonCodes = [
          ...(eligible.find((item) => item.key === candidate.key)?.reasonCodes ?? []),
          ...(candidate.gateId !== selected.gate.gateId
            ? [`later-gate-than-selected:${selected.gate.gateId}`]
            : candidate.rank?.pathCollisionCount
              ? ["path-collision", "lower-deterministic-rank"]
              : ["lower-deterministic-rank"]),
        ].sort();
      }
    }
    outcome = {
      state: "selected",
      gateId: selected.gate.gateId,
      workUnit: selected.workUnit,
      missingInputIds: [],
    };
  } else {
    const missingCandidateGate = earliestGate(
      decisions.filter((candidate) => candidate.status === "missing-input"),
    );
    const productNeedGate =
      assessment.gates.find(
        (gate) =>
          gate.applicability === "unknown" &&
          unresolvedPrerequisites(gate.gateId, assessment.gates).length === 0,
      )?.gateId ?? null;
    const missingGate = missingCandidateGate ?? productNeedGate;
    const missingInputIds = missingGate === null ? [] : missingInputs(assessment, missingGate);
    if (missingInputIds.length > 0) {
      outcome = {
        state: "needs-input",
        gateId: missingGate,
        workUnit: null,
        missingInputIds,
      };
    } else if (
      decisions.length > 0 ||
      assessment.gates.some(
        (gate) =>
          gate.disposition === "blocked" ||
          gate.disposition === "unknown" ||
          gate.disposition === "not-ready",
      )
    ) {
      outcome = {
        state: "investigation",
        gateId: earliestUnresolvedGate(assessment.gates),
        workUnit: null,
        missingInputIds: [],
      };
    } else {
      outcome = { state: "no-action", gateId: null, workUnit: null, missingInputIds: [] };
    }
  }
  const orderedDecisions = decisions.sort(
    (left, right) =>
      gateOrdinal(left.gateId) - gateOrdinal(right.gateId) || left.key.localeCompare(right.key),
  );
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-documentation-maturity-cascade-selection" as const,
    algorithmVersion: DOCUMENTATION_MATURITY_CASCADE_ALGORITHM_VERSION,
    repository: assessment.repository,
    assessmentSha256: assessment.assessmentSha256,
    trackerObservationSha256: trackerObservation.observationSha256,
    exceptionIds: [...usedExceptionIds].sort(),
    candidates: orderedDecisions,
    outcome,
    trackerMutation: "not-authorized" as const,
  };
  return { ...body, selectionSha256: canonicalDigest(body) };
}

export function unresolvedPrerequisites(
  gateId: DocumentationMaturityGateId,
  gates: readonly DocumentationMaturityGateEvaluationV1[],
): DocumentationMaturityGateEvaluationV1[] {
  const prerequisites = DOCUMENTATION_MATURITY_GATE_CATALOG.gates.find(
    (gate) => gate.id === gateId,
  )!.prerequisites;
  return prerequisites
    .map((id) => gates.find((gate) => gate.gateId === id)!)
    .filter((gate) => gate.disposition !== "satisfied" && gate.disposition !== "not-applicable");
}

export function validException(
  exception: CascadeExceptionV1,
  prerequisite: DocumentationMaturityGateEvaluationV1,
  target: {
    gate: DocumentationMaturityGateEvaluationV1;
    workUnit: DocumentationMaturityWorkUnitV1;
    finding: DocumentationMaturityGateEvaluationV1["findings"][number];
  },
  gates: readonly DocumentationMaturityGateEvaluationV1[],
): boolean {
  if (exception.candidateScopeSha256 !== target.workUnit.scopeSha256) return false;
  const prerequisitePaths = new Set([
    ...prerequisite.findings.flatMap((finding) => finding.affectedPaths),
    ...prerequisite.workUnits.flatMap((unit) => unit.affectedPaths),
  ]);
  if (target.workUnit.affectedPaths.some((path) => prerequisitePaths.has(path))) return false;
  const prerequisiteFindingFingerprints = new Set(
    prerequisite.findings.map((finding) => finding.fingerprint),
  );
  const prerequisiteWorkUnitIds = new Set(prerequisite.workUnits.map((unit) => unit.id));
  if (
    target.workUnit.dependencyFingerprints.some((value) =>
      prerequisiteFindingFingerprints.has(value),
    ) ||
    target.workUnit.dependsOnWorkUnitIds.some((value) => prerequisiteWorkUnitIds.has(value))
  )
    return false;
  return gates.some((gate) => gate === prerequisite);
}

export function buildDependencyGraph(
  units: readonly { workUnit: DocumentationMaturityWorkUnitV1 }[],
  trackerIssues: readonly SanitizedRoadmapIssue[],
): DependencyGraph {
  if (units.length > MAXIMUM_WORK_UNITS) fail("invalid-assessment");
  const byId = new Map<string, { workUnit: DocumentationMaturityWorkUnitV1 }>();
  const byFinding = new Map<string, { workUnit: DocumentationMaturityWorkUnitV1 }>();
  const byWorkUnit = new Map<string, { workUnit: DocumentationMaturityWorkUnitV1 }>();
  for (const unit of units) {
    if (
      byId.has(unit.workUnit.id) ||
      byFinding.has(unit.workUnit.findingFingerprint) ||
      byWorkUnit.has(unit.workUnit.workUnitFingerprint)
    )
      fail("invalid-assessment");
    byId.set(unit.workUnit.id, unit);
    byFinding.set(unit.workUnit.findingFingerprint, unit);
    byWorkUnit.set(unit.workUnit.workUnitFingerprint, unit);
  }
  const trackerStates = indexTrackerStates(trackerIssues);
  const dependencies = new Map<string, Set<string>>();
  const unresolvedReasons = new Map<string, string[]>();
  for (const unit of units) {
    const key = unit.workUnit.workUnitFingerprint;
    const current = new Set<string>();
    const unresolved = new Set<string>();
    const addCurrent = (dependency: { workUnit: DocumentationMaturityWorkUnitV1 }): void => {
      if (dependency.workUnit.workUnitFingerprint === key) fail("invalid-assessment");
      const state = trackerStates.get(dependency.workUnit.findingFingerprint) ?? "absent";
      if (state === "complete") return;
      if (state === "conflict") unresolved.add("tracker-dependency-conflict");
      else if (state === "closed-unverified") {
        unresolved.add("tracker-dependency-closed-unverified");
      } else {
        current.add(dependency.workUnit.workUnitFingerprint);
      }
    };
    for (const dependencyId of unit.workUnit.dependsOnWorkUnitIds) {
      const dependency = byId.get(dependencyId);
      if (!dependency) unresolved.add("unresolved-work-unit-dependency");
      else addCurrent(dependency);
    }
    for (const fingerprint of unit.workUnit.dependencyFingerprints) {
      const dependency = byFinding.get(fingerprint);
      if (dependency) {
        addCurrent(dependency);
        continue;
      }
      const state = trackerStates.get(fingerprint) ?? "absent";
      if (state === "complete") continue;
      if (state === "active") unresolved.add("tracker-dependency-active");
      else if (state === "closed-unverified") {
        unresolved.add("tracker-dependency-closed-unverified");
      } else if (state === "conflict") unresolved.add("tracker-dependency-conflict");
      else unresolved.add("unresolved-finding-dependency");
    }
    dependencies.set(key, current);
    unresolvedReasons.set(key, [...unresolved].sort());
  }
  assertAcyclicDependencies(dependencies);
  const dependents = new Map<string, Set<string>>(
    [...byWorkUnit.keys()].map((key) => [key, new Set()]),
  );
  for (const [dependent, prerequisites] of dependencies) {
    for (const prerequisite of prerequisites) dependents.get(prerequisite)!.add(dependent);
  }
  const leverageSets = new Map<string, ReadonlySet<string>>();
  const leverageVisiting = new Set<string>();
  const descendants = (key: string, depth: number): ReadonlySet<string> => {
    if (depth > MAXIMUM_WORK_UNITS || leverageVisiting.has(key)) fail("invalid-assessment");
    const cached = leverageSets.get(key);
    if (cached) return cached;
    leverageVisiting.add(key);
    const reached = new Set<string>();
    for (const dependent of dependents.get(key) ?? []) {
      reached.add(dependent);
      for (const nested of descendants(dependent, depth + 1)) reached.add(nested);
    }
    leverageVisiting.delete(key);
    leverageSets.set(key, reached);
    return reached;
  };
  const transitiveLeverage = new Map<string, number>();
  for (const key of byWorkUnit.keys()) transitiveLeverage.set(key, descendants(key, 0).size);

  const unitsByPath = new Map<string, Set<string>>();
  for (const unit of units) {
    for (const path of unit.workUnit.affectedPaths) {
      const keys = unitsByPath.get(path) ?? new Set<string>();
      keys.add(unit.workUnit.workUnitFingerprint);
      unitsByPath.set(path, keys);
    }
  }
  const pathCollisionCounts = new Map<string, number>();
  for (const unit of units) {
    const collisions = new Set<string>();
    for (const path of unit.workUnit.affectedPaths) {
      for (const key of unitsByPath.get(path) ?? []) {
        if (key !== unit.workUnit.workUnitFingerprint) collisions.add(key);
      }
    }
    pathCollisionCounts.set(unit.workUnit.workUnitFingerprint, collisions.size);
  }
  return {
    dependencies,
    unresolvedReasons,
    transitiveLeverage,
    pathCollisionCounts,
    trackerStates,
  };
}

export function assertAcyclicDependencies(
  dependencies: ReadonlyMap<string, ReadonlySet<string>>,
): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  let visitedNodes = 0;
  const visit = (key: string, depth: number): void => {
    if (depth > MAXIMUM_WORK_UNITS || visitedNodes > MAXIMUM_WORK_UNITS * 2) {
      fail("invalid-assessment");
    }
    if (visiting.has(key)) fail("invalid-assessment");
    if (visited.has(key)) return;
    visitedNodes += 1;
    visiting.add(key);
    for (const dependency of dependencies.get(key) ?? []) visit(dependency, depth + 1);
    visiting.delete(key);
    visited.add(key);
  };
  for (const key of dependencies.keys()) visit(key, 0);
}

export function indexTrackerStates(
  issues: readonly SanitizedRoadmapIssue[],
): ReadonlyMap<string, TrackerFindingState> {
  const matches = new Map<string, SanitizedRoadmapIssue[]>();
  for (const issue of issues) {
    for (const fingerprint of issue.findingFingerprints) {
      const values = matches.get(fingerprint) ?? [];
      values.push(issue);
      matches.set(fingerprint, values);
    }
  }
  const states = new Map<string, TrackerFindingState>();
  for (const [fingerprint, values] of matches) {
    const opened = values.filter((issue) => issue.state === "opened");
    const closed = values.filter((issue) => issue.state === "closed");
    states.set(
      fingerprint,
      opened.length > 1 || closed.length > 1 || (opened.length > 0 && closed.length > 0)
        ? "conflict"
        : opened.length === 1
          ? "active"
          : closed[0]!.materialEvidenceDigests.length > 0
            ? "complete"
            : "closed-unverified",
    );
  }
  return states;
}

export function rankFor(
  item: {
    gate: { gateId: DocumentationMaturityGateId };
    workUnit: DocumentationMaturityWorkUnitV1;
  },
  dependencyGraph: DependencyGraph,
): DocumentationMaturityCascadeRankV1 {
  const severityRank = ({ informational: 1, minor: 2, major: 3, critical: 4 } as const)[
    item.workUnit.severity
  ];
  const confidenceRank = ({ inconclusive: 0, bounded: 1, confirmed: 2 } as const)[
    item.workUnit.confidence
  ];
  const blockedAudienceCount = item.workUnit.audienceImpact.filter(
    (impact) => impact.impact === "blocked",
  ).length;
  const degradedAudienceCount = item.workUnit.audienceImpact.filter(
    (impact) => impact.impact === "degraded",
  ).length;
  const dependencyLeverage =
    dependencyGraph.transitiveLeverage.get(item.workUnit.workUnitFingerprint) ?? 0;
  const pathCollisionCount =
    dependencyGraph.pathCollisionCounts.get(item.workUnit.workUnitFingerprint) ?? 0;
  const verificationWeights = {
    "repository-observation": 1,
    "bounded-search": 2,
    "workflow-outcome": 3,
    "human-attestation": 4,
  } as const;
  return {
    gateOrdinal: gateOrdinal(item.gate.gateId),
    severityRank,
    blockedAudienceCount,
    degradedAudienceCount,
    confidenceRank,
    dependencyLeverage,
    effortPathCount: item.workUnit.affectedPaths.length,
    effortAcceptanceCount: item.workUnit.acceptanceCriteria.length,
    pathCollisionCount,
    verificationCost: item.workUnit.verification.reduce(
      (sum, verification) => sum + verificationWeights[verification.method],
      0,
    ),
  };
}

export function compareRankedCandidates(
  left: { workUnit: DocumentationMaturityWorkUnitV1; rank: DocumentationMaturityCascadeRankV1 },
  right: { workUnit: DocumentationMaturityWorkUnitV1; rank: DocumentationMaturityCascadeRankV1 },
): number {
  return (
    left.rank.gateOrdinal - right.rank.gateOrdinal ||
    right.rank.severityRank - left.rank.severityRank ||
    right.rank.blockedAudienceCount - left.rank.blockedAudienceCount ||
    right.rank.degradedAudienceCount - left.rank.degradedAudienceCount ||
    right.rank.confidenceRank - left.rank.confidenceRank ||
    right.rank.dependencyLeverage - left.rank.dependencyLeverage ||
    left.rank.effortPathCount - right.rank.effortPathCount ||
    left.rank.effortAcceptanceCount - right.rank.effortAcceptanceCount ||
    left.rank.pathCollisionCount - right.rank.pathCollisionCount ||
    left.rank.verificationCost - right.rank.verificationCost ||
    left.workUnit.workUnitFingerprint.localeCompare(right.workUnit.workUnitFingerprint)
  );
}

export function missingInputs(
  assessment: DocumentationMaturityCascadeAssessmentV1,
  selectedGateId: DocumentationMaturityGateId,
): string[] {
  const result = assessment.gates
    .filter((gate) => gate.gateId === selectedGateId)
    .flatMap((gate) => [
      ...(gate.applicability === "unknown" ? [`product-need:${gate.gateId}`] : []),
      ...gate.workUnits.flatMap((unit) => unit.execution.missingInputIds),
      ...gate.findings.flatMap((finding) =>
        finding.requiredHumanInput
          .filter((input) => input.status === "missing")
          .map((input) => input.id),
      ),
      ...gate.adaptedWorkUnits.flatMap((unit) => unit.value.requiredHumanInput),
    ]);
  return [...new Set(result)].sort();
}

export function earliestGate(
  decisions: readonly DocumentationMaturityCascadeCandidateDecisionV1[],
): DocumentationMaturityGateId | null {
  return (
    [...decisions].sort((left, right) => gateOrdinal(left.gateId) - gateOrdinal(right.gateId))[0]
      ?.gateId ?? null
  );
}

export function earliestUnresolvedGate(
  gates: readonly DocumentationMaturityGateEvaluationV1[],
): DocumentationMaturityGateId | null {
  return (
    gates.find((gate) => gate.disposition !== "satisfied" && gate.disposition !== "not-applicable")
      ?.gateId ?? null
  );
}

export async function loadCascadeExceptions(
  workspaceValue: unknown,
  repository: DocumentationMaturityRepositoryBindingV1,
  gates: readonly DocumentationMaturityGateEvaluationV1[],
  assertCurrent: () => void,
): Promise<CascadeExceptionV1[]> {
  let workspace: RepositoryWorkspace;
  try {
    workspace = await verifyActiveRepositoryWorkspace(workspaceValue);
  } catch {
    fail("invalid-policy");
  }
  assertCurrent();
  if (
    workspace.revision !== repository.revision ||
    createHash("sha256").update(workspace.sourcePath).digest("hex") !== repository.identitySha256
  ) {
    fail("repository-mismatch");
  }
  const tracked = await listTrackedRepositoryFiles(workspace);
  assertCurrent();
  const policy = tracked.find((file) => file.path === DOCUMENTATION_MATURITY_CASCADE_POLICY_PATH);
  if (!policy) {
    await verifyPolicyWorkspace(workspace, repository, assertCurrent);
    assertCurrent();
    return [];
  }
  if (policy.byteLength > MAXIMUM_POLICY_BYTES) fail("invalid-policy");
  let bytes: Buffer;
  try {
    bytes = await readTrackedRepositoryFile(
      workspace,
      DOCUMENTATION_MATURITY_CASCADE_POLICY_PATH,
      MAXIMUM_POLICY_BYTES,
    );
  } catch {
    fail("invalid-policy");
  }
  assertCurrent();
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("invalid-policy");
  }
  const root = exactObject(parsed, ["schemaVersion", "kind", "exceptions"], "invalid-policy");
  assertInertPlainData(parsed, "invalid-policy");
  if (root.schemaVersion !== 1 || root.kind !== "docsfab-documentation-maturity-cascade-policy") {
    fail("invalid-policy");
  }
  const exceptionValues = denseArray(root.exceptions, MAXIMUM_EXCEPTIONS, "invalid-policy");
  const exceptions = exceptionValues
    .map((value) => {
      const item = exactObject(
        value,
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
        "invalid-policy",
      );
      const exception: CascadeExceptionV1 = {
        id: safeToken(item.id, "invalid-policy"),
        prerequisiteGateId: gateId(item.prerequisiteGateId, "invalid-policy"),
        targetGateId: gateId(item.targetGateId, "invalid-policy"),
        candidateWorkUnitFingerprint: sha(item.candidateWorkUnitFingerprint, "invalid-policy"),
        candidateScopeSha256: sha(item.candidateScopeSha256, "invalid-policy"),
        evidencePath: repositoryPath(item.evidencePath, "invalid-policy"),
        evidenceSha256: sha(item.evidenceSha256, "invalid-policy"),
        rationale:
          item.rationale === "independent-scope" ? "independent-scope" : fail("invalid-policy"),
      };
      if (
        gateOrdinal(exception.prerequisiteGateId) >= gateOrdinal(exception.targetGateId) ||
        !gates.some((gate) => gate.gateId === exception.prerequisiteGateId) ||
        !gates.some(
          (gate) =>
            gate.gateId === exception.targetGateId &&
            gate.workUnits.some(
              (unit) =>
                unit.workUnitFingerprint === exception.candidateWorkUnitFingerprint &&
                unit.scopeSha256 === exception.candidateScopeSha256,
            ),
        )
      ) {
        fail("invalid-policy");
      }
      return exception;
    })
    .sort((left, right) => left.id.localeCompare(right.id));
  unique(
    exceptions.map((exception) => exception.id),
    "invalid-policy",
  );
  if (
    bytes.toString("utf8") !==
    canonicalJson({
      schemaVersion: 1,
      kind: "docsfab-documentation-maturity-cascade-policy",
      exceptions,
    })
  )
    fail("invalid-policy");
  const trackedByPath = new Map(tracked.map((file) => [file.path, file.byteLength]));
  for (const exception of exceptions) {
    const byteLength = trackedByPath.get(exception.evidencePath);
    if (byteLength === undefined || byteLength > MAXIMUM_EXCEPTION_EVIDENCE_BYTES) {
      fail("invalid-policy");
    }
    let evidence: Buffer;
    try {
      evidence = await readTrackedRepositoryFile(
        workspace,
        exception.evidencePath,
        MAXIMUM_EXCEPTION_EVIDENCE_BYTES,
      );
    } catch {
      fail("invalid-policy");
    }
    assertCurrent();
    if (createHash("sha256").update(evidence).digest("hex") !== exception.evidenceSha256) {
      fail("invalid-policy");
    }
  }
  await verifyPolicyWorkspace(workspace, repository, assertCurrent);
  assertCurrent();
  return exceptions;
}

export async function verifyPolicyWorkspace(
  workspace: RepositoryWorkspace,
  repository: DocumentationMaturityRepositoryBindingV1,
  assertCurrent: () => void,
): Promise<void> {
  try {
    const statuses = await verifyTrackedRepositoryEntries(workspace);
    assertCurrent();
    const finalWorkspace = await verifyActiveRepositoryWorkspace(workspace);
    assertCurrent();
    if (
      statuses.some((entry) => entry.status !== "verified") ||
      finalWorkspace !== workspace ||
      finalWorkspace.revision !== repository.revision ||
      createHash("sha256").update(finalWorkspace.sourcePath).digest("hex") !==
        repository.identitySha256
    )
      fail("invalid-policy");
  } catch (error) {
    if (error instanceof DocumentationMaturityCascadeError) throw error;
    fail("invalid-policy");
  }
}
