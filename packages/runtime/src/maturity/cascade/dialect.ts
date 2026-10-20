// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Documentation maturity cascade — dialect bottoms, shared types, and decode.
 * Bound through contract-kit rather than a separate dialect.
 */

import { types as nodeUtilTypes } from "node:util";

import { deepFreeze } from "../../contract-kit/freeze.js";
import { createContractKit, type ContractFail } from "../../contract-kit/index.js";
import * as workflowCatalog from "../../workflow-registry/catalog.js";
import type { RoadmapProjectIdentity } from "../../roadmap/contracts/ledger.js";
import type { SanitizedRoadmapIssue } from "../../roadmap/planning.js";
import type { RepositoryWorkspace } from "../../repository/workspace/contracts.js";
import {
  DOCUMENTATION_MATURITY_GATE_CATALOG,
  DOCUMENTATION_MATURITY_GATE_IDS,
  decodeDocumentationMaturityWorkUnit,
  type DocumentationMaturityGateId,
  type DocumentationMaturityRepositoryBindingV1,
  type DocumentationMaturityWorkUnitV1,
} from "../contracts.js";
import {
  DOCUMENTATION_MATURITY_EVALUATOR_CATALOG,
  decodeDocumentationMaturityGateEvaluation,
  evaluateDocumentationMaturityGate,
  type DocumentationMaturityGateEvaluationV1,
} from "../evaluators.js";

/**
 * Shared contract-kit binding for cascade dialect helpers.
 * Freeze and inert checks come from the kit; custom exact bottoms below
 * preserve cascade fail-closed codes.
 */
export { deepFreeze };
const kit = createContractKit({
  fail: () => fail("invalid-input"),
  codes: {
    invalidShape: "invalid-shape",
    invalidValue: "invalid-value",
    digestMismatch: "digest-mismatch",
    credentialMaterial: "credential-material",
    schemaMismatch: "migration-required",
  },
  inertMode: "strict",
});

export const canonicalDigest = kit.canonicalDigest;
export const canonicalJson = kit.canonicalJson;

export const DOCUMENTATION_MATURITY_CASCADE_ALGORITHM_VERSION = "1.0.0" as const;
export const DOCUMENTATION_MATURITY_CASCADE_POLICY_PATH =
  ".docsfab-documentation-maturity-cascade-policy.json" as const;

export const MAXIMUM_POLICY_BYTES = 64 * 1024;
export const MAXIMUM_EXCEPTION_EVIDENCE_BYTES = 256 * 1024;
export const MAXIMUM_EXCEPTIONS = 64;
export const MAXIMUM_TRACKER_ISSUES = 1_024;
/** Measured native execution ceiling; keeps ranking graph work bounded. */
export const MAXIMUM_WORK_UNITS = 256;
/** Six evaluator gates × the catalog's 256 finding-only authority ceiling. */
export const MAXIMUM_FINDING_ONLY_CANDIDATES = 1_536;
/** The release-readiness rubric has fewer than 64 compatibility units. */
export const MAXIMUM_COMPATIBILITY_CANDIDATES = 64;
export const MAXIMUM_CASCADE_CANDIDATES =
  MAXIMUM_WORK_UNITS + MAXIMUM_FINDING_ONLY_CANDIDATES + MAXIMUM_COMPATIBILITY_CANDIDATES;
export const MAXIMUM_INERT_DEPTH = 64;
export const MAXIMUM_INERT_NODES = 100_000;
export const MAXIMUM_TRACKER_OBSERVATION_NODES = 600_000;
export const MAXIMUM_TRACKER_OBSERVATION_TOTAL_NODES = MAXIMUM_TRACKER_OBSERVATION_NODES + 1_024;
export const MAXIMUM_RANKING_INSPECTION_NODES = 700_000;
export const MAXIMUM_GITLAB_METADATA_BYTES = 512 * 1024;
export const MAXIMUM_GITLAB_ISSUE_PAGE_BYTES = 4 * 1024 * 1024;
export const MAXIMUM_GITLAB_TOTAL_BYTES = 16 * 1024 * 1024;
export const MAXIMUM_GITLAB_ELAPSED_MS = 30_000;
export const MAXIMUM_GITLAB_PAGES = Math.ceil(MAXIMUM_TRACKER_ISSUES / 100);
export const TRACKER_OBSERVATION_LIFETIME_MS = 5 * 60 * 1_000;
export const SHA = /^[a-f0-9]{64}$/u;
export const REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
export const SAFE_TOKEN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,255})$/u;
export type GateInput = Parameters<typeof evaluateDocumentationMaturityGate>[0];

export interface DocumentationMaturityCascadeAssessmentV1 {
  schemaVersion: 1;
  kind: "docsfab-documentation-maturity-cascade-assessment";
  algorithmVersion: typeof DOCUMENTATION_MATURITY_CASCADE_ALGORITHM_VERSION;
  gateCatalogSha256: string;
  evaluatorCatalogSha256: string;
  repository: DocumentationMaturityRepositoryBindingV1;
  gates: DocumentationMaturityGateEvaluationV1[];
  assessmentSha256: string;
}

export interface DocumentationMaturityCascadeTrackerObservationV1 {
  schemaVersion: 1;
  kind: "docsfab-documentation-maturity-cascade-tracker-observation";
  repository: DocumentationMaturityRepositoryBindingV1;
  projectSha256: string;
  observedAt: string;
  expiresAt: string;
  issues: SanitizedRoadmapIssue[];
  observationSha256: string;
}

export interface DocumentationMaturityCascadeRankV1 {
  gateOrdinal: 0 | 1 | 2 | 3 | 4 | 5;
  severityRank: 1 | 2 | 3 | 4;
  blockedAudienceCount: number;
  degradedAudienceCount: number;
  confidenceRank: 0 | 1 | 2;
  dependencyLeverage: number;
  effortPathCount: number;
  effortAcceptanceCount: number;
  pathCollisionCount: number;
  verificationCost: number;
}

/** Non-authoritative deterministic policy projection for tests and dry-run explanation. */
export interface DocumentationMaturityCascadeRankInspectionV1 {
  workUnitFingerprint: string;
  eligibility: "ready" | "dependency-blocked" | "investigation" | "not-executable";
  rank: DocumentationMaturityCascadeRankV1;
}

export interface DocumentationMaturityCascadeSelectionInspectionV1 {
  authority: "non-authoritative";
  selection: DocumentationMaturityCascadeSelectionV1;
}

export interface DocumentationMaturityGitLabBindingInspectionV1 {
  authority: "non-authoritative";
  project: RoadmapProjectIdentity;
}

export interface DocumentationMaturityPrerequisiteExceptionInspectionV1 {
  authority: "non-authoritative";
  valid: boolean;
}

export interface DocumentationMaturityCandidateBudgetInspectionV1 {
  authority: "non-authoritative";
  nativeWorkUnitCount: number;
  findingOnlyCount: number;
  adaptedWorkUnitCount: number;
  aggregateCount: number;
  maximumAggregateCount: number;
}

export type DocumentationMaturityCascadeCandidateStatus =
  | "selected"
  | "eligible-not-selected"
  | "prerequisite-blocked"
  | "dependency-blocked"
  | "missing-input"
  | "investigation"
  | "not-executable";

export interface DocumentationMaturityCascadeCandidateDecisionV1 {
  key: string;
  gateId: DocumentationMaturityGateId;
  findingFingerprint: string | null;
  workUnitFingerprint: string | null;
  status: DocumentationMaturityCascadeCandidateStatus;
  reasonCodes: string[];
  rank: DocumentationMaturityCascadeRankV1 | null;
}

export type DocumentationMaturityCascadeOutcomeV1 =
  | {
      state: "selected";
      gateId: DocumentationMaturityGateId;
      workUnit: DocumentationMaturityWorkUnitV1;
      missingInputIds: [];
    }
  | {
      state: "needs-input";
      gateId: DocumentationMaturityGateId | null;
      workUnit: null;
      missingInputIds: string[];
    }
  | {
      state: "investigation";
      gateId: DocumentationMaturityGateId | null;
      workUnit: null;
      missingInputIds: [];
    }
  | {
      state: "no-action";
      gateId: null;
      workUnit: null;
      missingInputIds: [];
    };

export interface DocumentationMaturityCascadeSelectionV1 {
  schemaVersion: 1;
  kind: "docsfab-documentation-maturity-cascade-selection";
  algorithmVersion: typeof DOCUMENTATION_MATURITY_CASCADE_ALGORITHM_VERSION;
  repository: DocumentationMaturityRepositoryBindingV1;
  assessmentSha256: string;
  trackerObservationSha256: string;
  exceptionIds: string[];
  candidates: DocumentationMaturityCascadeCandidateDecisionV1[];
  outcome: DocumentationMaturityCascadeOutcomeV1;
  trackerMutation: "not-authorized";
  selectionSha256: string;
}

export interface CascadeExceptionV1 {
  id: string;
  prerequisiteGateId: DocumentationMaturityGateId;
  targetGateId: DocumentationMaturityGateId;
  candidateWorkUnitFingerprint: string;
  candidateScopeSha256: string;
  evidencePath: string;
  evidenceSha256: string;
  rationale: "independent-scope";
}

export interface AuthenticAssessmentState {
  gateInputs: readonly GateInput[];
  sourcePath: string;
}

export interface AuthenticTrackerObservationState {
  assessment: DocumentationMaturityCascadeAssessmentV1;
  assessmentSha256: string;
  assessmentRepository: DocumentationMaturityRepositoryBindingV1;
  workspace: RepositoryWorkspace;
  project: RoadmapProjectIdentity;
  observedAtEpochMs: number;
  expiresAtEpochMs: number;
  observedAtMonotonicMs: number;
  expiresAtMonotonicMs: number;
  snapshot: DocumentationMaturityCascadeTrackerObservationV1;
}

export interface CascadeUnit {
  gate: DocumentationMaturityGateEvaluationV1;
  workUnit: DocumentationMaturityWorkUnitV1;
  finding: DocumentationMaturityGateEvaluationV1["findings"][number];
}

export interface DependencyGraph {
  dependencies: ReadonlyMap<string, ReadonlySet<string>>;
  unresolvedReasons: ReadonlyMap<string, readonly string[]>;
  transitiveLeverage: ReadonlyMap<string, number>;
  pathCollisionCounts: ReadonlyMap<string, number>;
  trackerStates: ReadonlyMap<string, TrackerFindingState>;
}

export type TrackerFindingState =
  | "absent"
  | "active"
  | "complete"
  | "closed-unverified"
  | "conflict";

export const authenticAssessments = new WeakMap<object, AuthenticAssessmentState>();
export const authenticTrackerObservations = new WeakMap<object, AuthenticTrackerObservationState>();
export const authenticSelections = new WeakMap<
  object,
  {
    assessment: DocumentationMaturityCascadeAssessmentV1;
    trackerObservation: DocumentationMaturityCascadeTrackerObservationV1;
  }
>();

export type DocumentationMaturityCascadeErrorCode =
  | "invalid-input"
  | "invalid-assessment"
  | "invalid-tracker-observation"
  | "invalid-policy"
  | "repository-mismatch";

export class DocumentationMaturityCascadeError extends Error {
  public constructor(public readonly code: DocumentationMaturityCascadeErrorCode) {
    super(`Documentation maturity cascade rejected: ${code}.`);
    this.name = "DocumentationMaturityCascadeError";
  }
}

export function gateOrdinal(gateId: DocumentationMaturityGateId): 0 | 1 | 2 | 3 | 4 | 5 {
  return DOCUMENTATION_MATURITY_GATE_CATALOG.gates.find((gate) => gate.id === gateId)!.ordinal;
}

export function decodeDocumentationMaturityCascadeAssessment(
  value: unknown,
): DocumentationMaturityCascadeAssessmentV1 {
  const root = exactObject(
    value,
    [
      "schemaVersion",
      "kind",
      "algorithmVersion",
      "gateCatalogSha256",
      "evaluatorCatalogSha256",
      "repository",
      "gates",
      "assessmentSha256",
    ],
    "invalid-assessment",
  );
  assertInertPlainData(value, "invalid-assessment");
  if (
    root.schemaVersion !== 1 ||
    root.kind !== "docsfab-documentation-maturity-cascade-assessment" ||
    root.algorithmVersion !== DOCUMENTATION_MATURITY_CASCADE_ALGORITHM_VERSION ||
    root.gateCatalogSha256 !== DOCUMENTATION_MATURITY_GATE_CATALOG.catalogSha256 ||
    root.evaluatorCatalogSha256 !== DOCUMENTATION_MATURITY_EVALUATOR_CATALOG.catalogSha256
  ) {
    fail("invalid-assessment");
  }
  const repository = repositoryBinding(root.repository, "invalid-assessment");
  const gates = denseArray(root.gates, 6, "invalid-assessment").map((gate) => {
    try {
      return decodeDocumentationMaturityGateEvaluation(gate);
    } catch {
      fail("invalid-assessment");
    }
  });
  if (
    gates.length !== 6 ||
    canonicalJson(gates.map((gate) => gate.gateId)) !==
      canonicalJson(DOCUMENTATION_MATURITY_GATE_IDS) ||
    gates.some((gate) => canonicalJson(gate.repository) !== canonicalJson(repository))
  ) {
    fail("invalid-assessment");
  }
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-documentation-maturity-cascade-assessment" as const,
    algorithmVersion: DOCUMENTATION_MATURITY_CASCADE_ALGORITHM_VERSION,
    gateCatalogSha256: DOCUMENTATION_MATURITY_GATE_CATALOG.catalogSha256,
    evaluatorCatalogSha256: DOCUMENTATION_MATURITY_EVALUATOR_CATALOG.catalogSha256,
    repository,
    gates,
  };
  const assessmentSha256 = sha(root.assessmentSha256, "invalid-assessment");
  if (assessmentSha256 !== canonicalDigest(body)) fail("invalid-assessment");
  const decoded = deepFreeze({ ...body, assessmentSha256 });
  if (canonicalJson(decoded) !== canonicalJson(value)) fail("invalid-assessment");
  return decoded;
}

export function decodeDocumentationMaturityCascadeTrackerObservation(
  value: unknown,
): DocumentationMaturityCascadeTrackerObservationV1 {
  const root = exactObject(
    value,
    [
      "schemaVersion",
      "kind",
      "repository",
      "projectSha256",
      "observedAt",
      "expiresAt",
      "issues",
      "observationSha256",
    ],
    "invalid-tracker-observation",
  );
  assertInertPlainData(
    value,
    "invalid-tracker-observation",
    MAXIMUM_TRACKER_OBSERVATION_TOTAL_NODES,
    MAXIMUM_INERT_DEPTH,
  );
  if (
    root.schemaVersion !== 1 ||
    root.kind !== "docsfab-documentation-maturity-cascade-tracker-observation"
  ) {
    fail("invalid-tracker-observation");
  }
  const repository = repositoryBinding(root.repository, "invalid-tracker-observation");
  const observedAt = timestamp(root.observedAt, "invalid-tracker-observation");
  const expiresAt = timestamp(root.expiresAt, "invalid-tracker-observation");
  if (Date.parse(expiresAt) - Date.parse(observedAt) !== TRACKER_OBSERVATION_LIFETIME_MS) {
    fail("invalid-tracker-observation");
  }
  const issues = normalizeTrackerIssues(root.issues);
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-documentation-maturity-cascade-tracker-observation" as const,
    repository,
    projectSha256: sha(root.projectSha256, "invalid-tracker-observation"),
    observedAt,
    expiresAt,
    issues,
  };
  const observationSha256 = sha(root.observationSha256, "invalid-tracker-observation");
  if (observationSha256 !== canonicalDigest(body)) fail("invalid-tracker-observation");
  const decoded = deepFreeze({ ...body, observationSha256 });
  if (canonicalJson(decoded) !== canonicalJson(value)) fail("invalid-tracker-observation");
  return decoded;
}

export function decodeDocumentationMaturityCascadeSelection(
  value: unknown,
): DocumentationMaturityCascadeSelectionV1 {
  const root = exactObject(
    value,
    [
      "schemaVersion",
      "kind",
      "algorithmVersion",
      "repository",
      "assessmentSha256",
      "trackerObservationSha256",
      "exceptionIds",
      "candidates",
      "outcome",
      "trackerMutation",
      "selectionSha256",
    ],
    "invalid-assessment",
  );
  assertInertPlainData(value, "invalid-assessment");
  if (
    root.schemaVersion !== 1 ||
    root.kind !== "docsfab-documentation-maturity-cascade-selection" ||
    root.algorithmVersion !== DOCUMENTATION_MATURITY_CASCADE_ALGORITHM_VERSION ||
    root.trackerMutation !== "not-authorized"
  )
    fail("invalid-assessment");
  const repository = repositoryBinding(root.repository, "invalid-assessment");
  const exceptionIds = safeTokens(root.exceptionIds, MAXIMUM_EXCEPTIONS, "invalid-assessment");
  const candidates = denseArray(
    root.candidates,
    MAXIMUM_CASCADE_CANDIDATES,
    "invalid-assessment",
  ).map((value) => decodeCandidateDecision(value));
  if (
    !isSortedUnique(
      candidates.map((candidate) => `${gateOrdinal(candidate.gateId)}:${candidate.key}`),
    )
  )
    fail("invalid-assessment");
  const outcome = decodeOutcome(root.outcome);
  const selected = candidates.filter((candidate) => candidate.status === "selected");
  if (
    (outcome.state === "selected" &&
      (selected.length !== 1 ||
        !outcome.workUnit ||
        selected[0]!.workUnitFingerprint !== outcome.workUnit.workUnitFingerprint)) ||
    (outcome.state !== "selected" && selected.length !== 0)
  )
    fail("invalid-assessment");
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-documentation-maturity-cascade-selection" as const,
    algorithmVersion: DOCUMENTATION_MATURITY_CASCADE_ALGORITHM_VERSION,
    repository,
    assessmentSha256: sha(root.assessmentSha256, "invalid-assessment"),
    trackerObservationSha256: sha(root.trackerObservationSha256, "invalid-assessment"),
    exceptionIds,
    candidates,
    outcome,
    trackerMutation: "not-authorized" as const,
  };
  const selectionSha256 = sha(root.selectionSha256, "invalid-assessment");
  if (selectionSha256 !== canonicalDigest(body)) fail("invalid-assessment");
  const decoded = deepFreeze({ ...body, selectionSha256 });
  if (canonicalJson(decoded) !== canonicalJson(value)) fail("invalid-assessment");
  return decoded;
}

export function decodeCandidateDecision(
  value: unknown,
): DocumentationMaturityCascadeCandidateDecisionV1 {
  const item = exactObject(
    value,
    ["key", "gateId", "findingFingerprint", "workUnitFingerprint", "status", "reasonCodes", "rank"],
    "invalid-assessment",
  );
  const rank = item.rank === null ? null : decodeRank(item.rank);
  return {
    key: safeToken(item.key, "invalid-assessment"),
    gateId: gateId(item.gateId, "invalid-assessment"),
    findingFingerprint:
      item.findingFingerprint === null ? null : sha(item.findingFingerprint, "invalid-assessment"),
    workUnitFingerprint:
      item.workUnitFingerprint === null
        ? null
        : sha(item.workUnitFingerprint, "invalid-assessment"),
    status: choice(
      item.status,
      [
        "selected",
        "eligible-not-selected",
        "prerequisite-blocked",
        "dependency-blocked",
        "missing-input",
        "investigation",
        "not-executable",
      ] as const,
      "invalid-assessment",
    ),
    reasonCodes: safeTokens(item.reasonCodes, 64, "invalid-assessment"),
    rank,
  };
}

export function decodeRank(value: unknown): DocumentationMaturityCascadeRankV1 {
  const item = exactObject(
    value,
    [
      "gateOrdinal",
      "severityRank",
      "blockedAudienceCount",
      "degradedAudienceCount",
      "confidenceRank",
      "dependencyLeverage",
      "effortPathCount",
      "effortAcceptanceCount",
      "pathCollisionCount",
      "verificationCost",
    ],
    "invalid-assessment",
  );
  return {
    gateOrdinal: boundedInteger(item.gateOrdinal, 0, 5, "invalid-assessment") as
      | 0
      | 1
      | 2
      | 3
      | 4
      | 5,
    severityRank: boundedInteger(item.severityRank, 1, 4, "invalid-assessment") as 1 | 2 | 3 | 4,
    blockedAudienceCount: boundedInteger(item.blockedAudienceCount, 0, 6, "invalid-assessment"),
    degradedAudienceCount: boundedInteger(item.degradedAudienceCount, 0, 6, "invalid-assessment"),
    confidenceRank: boundedInteger(item.confidenceRank, 0, 2, "invalid-assessment") as 0 | 1 | 2,
    dependencyLeverage: boundedInteger(item.dependencyLeverage, 0, 256, "invalid-assessment"),
    effortPathCount: boundedInteger(item.effortPathCount, 1, 256, "invalid-assessment"),
    effortAcceptanceCount: boundedInteger(item.effortAcceptanceCount, 1, 64, "invalid-assessment"),
    pathCollisionCount: boundedInteger(item.pathCollisionCount, 0, 256, "invalid-assessment"),
    verificationCost: boundedInteger(item.verificationCost, 1, 256, "invalid-assessment"),
  };
}

export function decodeOutcome(value: unknown): DocumentationMaturityCascadeOutcomeV1 {
  const item = exactObject(
    value,
    ["state", "gateId", "workUnit", "missingInputIds"],
    "invalid-assessment",
  );
  const state = choice(
    item.state,
    ["selected", "needs-input", "investigation", "no-action"] as const,
    "invalid-assessment",
  );
  const gate = item.gateId === null ? null : gateId(item.gateId, "invalid-assessment");
  const missingInputIds = safeTokens(item.missingInputIds, 512, "invalid-assessment");
  if (state === "selected") {
    if (gate === null || missingInputIds.length > 0 || item.workUnit === null)
      fail("invalid-assessment");
    const workUnit = decodeDocumentationMaturityWorkUnit(item.workUnit, workflowCatalog);
    if (workUnit.gateId !== gate) fail("invalid-assessment");
    return { state, gateId: gate, workUnit, missingInputIds: [] };
  }
  if (
    item.workUnit !== null ||
    (state === "no-action" && gate !== null) ||
    (state !== "needs-input" && missingInputIds.length > 0) ||
    (state === "needs-input" && missingInputIds.length === 0)
  )
    fail("invalid-assessment");
  if (state === "needs-input") return { state, gateId: gate, workUnit: null, missingInputIds };
  if (state === "investigation")
    return { state, gateId: gate, workUnit: null, missingInputIds: [] };
  return { state, gateId: null, workUnit: null, missingInputIds: [] };
}

export function snapshotGateInputs(value: unknown): readonly GateInput[] {
  const inputs = denseArray(value, 6, "invalid-input");
  if (inputs.length !== 6) fail("invalid-input");
  const result = inputs.map((value, index): GateInput => {
    const item = exactShallow(
      value,
      ["gateId", "repository", "policyWorkspace", "mappings"],
      "invalid-input",
      ["semanticOverlays"],
    );
    const id = gateId(item.gateId, "invalid-input");
    if (id !== DOCUMENTATION_MATURITY_GATE_IDS[index]) fail("invalid-input");
    const repository = snapshotRepositoryTarget(item.repository);
    const mappings = snapshotOpaqueArray<GateInput["mappings"][number]>(
      item.mappings,
      16,
      "invalid-input",
    );
    const semanticOverlays =
      item.semanticOverlays === undefined
        ? undefined
        : snapshotOpaqueArray<NonNullable<GateInput["semanticOverlays"]>[number]>(
            item.semanticOverlays,
            16,
            "invalid-input",
          );
    return Object.freeze({
      gateId: id,
      repository,
      policyWorkspace: item.policyWorkspace as RepositoryWorkspace | null,
      mappings,
      ...(semanticOverlays === undefined ? {} : { semanticOverlays }),
    });
  });
  const repository = canonicalJson(result[0]!.repository);
  if (result.some((input) => canonicalJson(input.repository) !== repository))
    fail("repository-mismatch");
  return Object.freeze(result);
}

export function snapshotRepositoryTarget(value: unknown): GateInput["repository"] {
  const item = exactShallow(
    value,
    ["sourcePath", "requestedRevision", "revision"],
    "invalid-input",
  );
  if (
    typeof item.sourcePath !== "string" ||
    item.sourcePath.length === 0 ||
    item.sourcePath.length > 4_096 ||
    typeof item.requestedRevision !== "string" ||
    item.requestedRevision.length === 0 ||
    item.requestedRevision.length > 1_024 ||
    typeof item.revision !== "string" ||
    !REVISION.test(item.revision)
  )
    fail("invalid-input");
  return Object.freeze({
    sourcePath: item.sourcePath,
    requestedRevision: item.requestedRevision,
    revision: item.revision,
  });
}

export function commonRepository(
  gates: readonly DocumentationMaturityGateEvaluationV1[],
  code: DocumentationMaturityCascadeErrorCode,
): DocumentationMaturityRepositoryBindingV1 {
  if (
    gates.length !== 6 ||
    canonicalJson(gates.map((gate) => gate.gateId)) !==
      canonicalJson(DOCUMENTATION_MATURITY_GATE_IDS)
  )
    fail(code);
  const repository = repositoryBinding(gates[0]!.repository, code);
  if (gates.some((gate) => canonicalJson(gate.repository) !== canonicalJson(repository)))
    fail(code);
  return repository;
}

export function normalizeTrackerIssues(value: unknown): SanitizedRoadmapIssue[] {
  assertInertPlainData(
    value,
    "invalid-tracker-observation",
    MAXIMUM_TRACKER_OBSERVATION_NODES,
    MAXIMUM_INERT_DEPTH,
  );
  const issues = denseArray(value, MAXIMUM_TRACKER_ISSUES, "invalid-tracker-observation")
    .map((value) => {
      const item = exactObject(
        value,
        [
          "iid",
          "state",
          "updatedAt",
          "identityDigest",
          "findingFingerprints",
          "materialEvidenceDigests",
        ],
        "invalid-tracker-observation",
      );
      return {
        iid: boundedInteger(item.iid, 1, Number.MAX_SAFE_INTEGER, "invalid-tracker-observation"),
        state: choice(item.state, ["opened", "closed"] as const, "invalid-tracker-observation"),
        updatedAt: timestamp(item.updatedAt, "invalid-tracker-observation"),
        identityDigest: sha(item.identityDigest, "invalid-tracker-observation"),
        findingFingerprints: shas(item.findingFingerprints, 256, "invalid-tracker-observation"),
        materialEvidenceDigests: shas(
          item.materialEvidenceDigests,
          256,
          "invalid-tracker-observation",
        ),
      };
    })
    .sort((left, right) => left.iid - right.iid);
  unique(
    issues.map((issue) => String(issue.iid)),
    "invalid-tracker-observation",
  );
  return issues;
}

export function repositoryBinding(
  value: unknown,
  code: DocumentationMaturityCascadeErrorCode,
): DocumentationMaturityRepositoryBindingV1 {
  const item = exactObject(value, ["identitySha256", "revision"], code);
  return {
    identitySha256: sha(item.identitySha256, code),
    revision:
      typeof item.revision === "string" && REVISION.test(item.revision)
        ? item.revision
        : fail(code),
  };
}

export function exactShallow(
  value: unknown,
  required: readonly string[],
  code: DocumentationMaturityCascadeErrorCode,
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    nodeUtilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    fail(code);
  const keys = Reflect.ownKeys(value);
  if (
    keys.some(
      (key) => typeof key !== "string" || (!required.includes(key) && !optional.includes(key)),
    ) ||
    required.some((key) => !keys.includes(key))
  )
    fail(code);
  const result: Record<string, unknown> = {};
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) fail(code);
    result[key] = descriptor.value;
  }
  return result;
}

export function exactObject(
  value: unknown,
  keys: readonly string[],
  code: DocumentationMaturityCascadeErrorCode,
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    nodeUtilTypes.isProxy(value) ||
    Reflect.ownKeys(value).length !== keys.length ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string" || !keys.includes(key))
  )
    fail(code);
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) fail(code);
    result[key] = descriptor.value;
  }
  return result;
}

export function denseArray(
  value: unknown,
  maximum: number,
  code: DocumentationMaturityCascadeErrorCode,
): unknown[] {
  if (
    !Array.isArray(value) ||
    nodeUtilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  )
    fail(code);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (
    !lengthDescriptor ||
    !Object.hasOwn(lengthDescriptor, "value") ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0 ||
    lengthDescriptor.value > maximum
  )
    fail(code);
  const length = lengthDescriptor.value as number;
  if (Reflect.ownKeys(value).length !== length + 1) fail(code);
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) fail(code);
    result.push(descriptor.value);
  }
  return result;
}

function snapshotOpaqueArray<T>(
  value: unknown,
  maximum: number,
  code: DocumentationMaturityCascadeErrorCode,
): readonly T[] {
  return Object.freeze(denseArray(value, maximum, code) as T[]);
}

type CascadeInertKit = ReturnType<typeof createContractKit<DocumentationMaturityCascadeErrorCode>>;
const cascadeInertKits = new Map<DocumentationMaturityCascadeErrorCode, CascadeInertKit>();

function kitForInert(code: DocumentationMaturityCascadeErrorCode): CascadeInertKit {
  const existing = cascadeInertKits.get(code);
  if (existing) return existing;
  const created = createContractKit({
    fail: fail as ContractFail<DocumentationMaturityCascadeErrorCode>,
    inertMode: "strict",
    codes: {
      invalidShape: code,
      invalidValue: code,
      digestMismatch: code,
      credentialMaterial: code,
      schemaMismatch: code,
    },
  });
  cascadeInertKits.set(code, created);
  return created;
}

export const assertInertPlainData = (
  value: unknown,
  code: DocumentationMaturityCascadeErrorCode,
  _maximumNodes: number = MAXIMUM_INERT_NODES,
  _maximumDepth: number = MAXIMUM_INERT_DEPTH,
): void => {
  kitForInert(code).assertInert(value);
};

export function safeToken(value: unknown, code: DocumentationMaturityCascadeErrorCode): string {
  if (typeof value !== "string" || !SAFE_TOKEN.test(value)) fail(code);
  return value;
}

export function repositoryPath(
  value: unknown,
  code: DocumentationMaturityCascadeErrorCode,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4_096 ||
    value.startsWith("/") ||
    /^[A-Za-z]:/u.test(value) ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    value.split("/").some((part) => part === "" || part === "." || part === "..")
  )
    fail(code);
  return value;
}

export function safeTokens(
  value: unknown,
  maximum: number,
  code: DocumentationMaturityCascadeErrorCode,
): string[] {
  const result = denseArray(value, maximum, code).map((item) => safeToken(item, code));
  if (!isSortedUnique(result)) fail(code);
  return result;
}

export function shas(
  value: unknown,
  maximum: number,
  code: DocumentationMaturityCascadeErrorCode,
): string[] {
  const result = denseArray(value, maximum, code).map((item) => sha(item, code));
  if (!isSortedUnique(result)) fail(code);
  return result;
}

export function sha(value: unknown, code: DocumentationMaturityCascadeErrorCode): string {
  if (typeof value !== "string" || !SHA.test(value)) fail(code);
  return value;
}

export function gateId(
  value: unknown,
  code: DocumentationMaturityCascadeErrorCode,
): DocumentationMaturityGateId {
  return choice(value, DOCUMENTATION_MATURITY_GATE_IDS, code);
}

export function timestamp(value: unknown, code: DocumentationMaturityCascadeErrorCode): string {
  if (typeof value !== "string" || value.length > 64) fail(code);
  try {
    if (new Date(value).toISOString() !== value) fail(code);
  } catch {
    fail(code);
  }
  return value;
}

export function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  code: DocumentationMaturityCascadeErrorCode,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    fail(code);
  }
  return value;
}

function choice<T extends string>(
  value: unknown,
  allowed: readonly T[],
  code: DocumentationMaturityCascadeErrorCode,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) fail(code);
  return value as T;
}

export function unique(
  values: readonly string[],
  code: DocumentationMaturityCascadeErrorCode,
): void {
  if (new Set(values).size !== values.length) fail(code);
}

export function isSortedUnique(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || values[index - 1]!.localeCompare(value) < 0);
}

export function fail(code: DocumentationMaturityCascadeErrorCode): never {
  throw new DocumentationMaturityCascadeError(code);
}
