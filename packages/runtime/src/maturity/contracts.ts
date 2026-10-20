// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { RepositoryTarget } from "../repository/contracts.js";
import type { RunRecord } from "../records/contracts.js";
import type {
  ProductDisposition,
  WorkflowDefinition,
  WorkflowName,
} from "../workflow-contracts/contracts.js";
import { deepFreeze } from "../contract-kit/freeze.js";
import type { DocumentationMaturityContractErrorCode } from "./contracts/primitives.js";
import {
  DOCUMENTATION_AUDIENCES,
  DOCUMENTATION_FINDING_CONFIDENCE,
  DOCUMENTATION_FINDING_SEVERITIES,
  DOCUMENTATION_HUMAN_INPUT_KINDS,
  DOCUMENTATION_ISSUE_PRIORITIES,
  DOCUMENTATION_MATURITY_DISPOSITIONS,
  DOCUMENTATION_MATURITY_GATE_IDS,
  DOCUMENTATION_VERIFICATION_METHODS,
} from "./contracts/values.js";
import {
  DocumentationMaturityContractError,
  fail,
  assertInertPlainData,
  array,
  equal,
  exact,
  id,
  object,
  oneOf,
  paths,
  rejectCredentials,
  repositoryBinding,
  repositoryTarget,
  revision,
  safeCode,
  sha,
  shas,
  unique,
  workflowNameValue,
} from "./contracts/primitives.js";
import {
  findingCandidate,
  normalizeAcceptanceCriteria,
  normalizeAudienceImpact,
  normalizeFindingCandidate,
  normalizeHumanInputs,
  normalizeRepositoryObservationBody,
  normalizeRequirement,
  normalizeVerification,
  normalizeWorkflow,
  normalizeWorkflowInputs,
  normalizeWorkUnitCandidate,
  validateHumanClaimKind,
  validateHumanDecision,
} from "./contracts/normalizers.js";
export { DocumentationMaturityContractError };
export type { DocumentationMaturityContractErrorCode } from "./contracts/primitives.js";
export {
  DOCUMENTATION_AUDIENCES,
  DOCUMENTATION_FINDING_CONFIDENCE,
  DOCUMENTATION_FINDING_SEVERITIES,
  DOCUMENTATION_HUMAN_INPUT_KINDS,
  DOCUMENTATION_ISSUE_PRIORITIES,
  DOCUMENTATION_MATURITY_DISPOSITIONS,
  DOCUMENTATION_MATURITY_GATE_IDS,
  DOCUMENTATION_VERIFICATION_METHODS,
} from "./contracts/values.js";
import { canonicalDigest, canonicalJson, sha256 } from "../content-ir/canonical.js";
import {
  createDocumentationGapLedger,
  decodeDocumentationGapLedger,
  projectDocumentationSearchFindings,
  type DocumentationGapLedgerV1,
  type DocumentationSearchFindingV1,
} from "../search/gap-ledger.js";
import { decodeWorkflowOutcome } from "../workflow-contracts/outcome.js";
import { decodeSavedWorkflowSearchEvidence } from "../search/historical-audit-search.js";
import { authorizeSecurityScan } from "../security/scan-override.js";
import { resolveSecurityScanEffectiveDisposition } from "../security/scan-disposition.js";

export const DOCUMENTATION_MATURITY_SCHEMA_VERSION = 1 as const;

const SECURITY_SCAN_POLICY = {
  authorizeSecurityScan,
  resolveSecurityScanEffectiveDisposition,
} as const;

export interface DocumentationMaturityWorkflowAccess {
  getWorkflow(name: WorkflowName): WorkflowDefinition;
  isWorkflowName(value: string): boolean;
}
export const DOCUMENTATION_MATURITY_CATALOG_VERSION = "1.0.0" as const;

export type DocumentationMaturityGateId = (typeof DOCUMENTATION_MATURITY_GATE_IDS)[number];

/** Tracker priority is intentionally disjoint from G0-G5 maturity vocabulary. */

export type DocumentationIssuePriority = (typeof DOCUMENTATION_ISSUE_PRIORITIES)[number];

export type DocumentationMaturityDisposition = (typeof DOCUMENTATION_MATURITY_DISPOSITIONS)[number];

export type DocumentationFindingSeverity = (typeof DOCUMENTATION_FINDING_SEVERITIES)[number];

export type DocumentationFindingConfidence = (typeof DOCUMENTATION_FINDING_CONFIDENCE)[number];

export type DocumentationAudience = (typeof DOCUMENTATION_AUDIENCES)[number];

export type DocumentationHumanInputKind = (typeof DOCUMENTATION_HUMAN_INPUT_KINDS)[number];

export type DocumentationVerificationMethod = (typeof DOCUMENTATION_VERIFICATION_METHODS)[number];

export type DocumentationMaturityEvidenceKind =
  | "repository-observation"
  | "documentation-search"
  | "workflow-outcome";
export type DocumentationAcceptanceEvidenceKind = DocumentationMaturityEvidenceKind | "human-input";

export interface DocumentationMaturityGateDefinitionV1 {
  id: DocumentationMaturityGateId;
  ordinal: 0 | 1 | 2 | 3 | 4 | 5;
  stage: "foundations" | "coverage" | "structure" | "content" | "polish" | "maintenance";
  applicability: "always" | "documentation-surface";
  prerequisites: DocumentationMaturityGateId[];
  dispositions: DocumentationMaturityDisposition[];
  evidenceRequirements: {
    materialOneOf: Array<"repository-observation" | "authenticated-bounded-negative">;
    disposition: {
      "observed-absence": "exact-repository-absence";
      "bounded-not-found": "authenticated-bounded-negative";
      unknown: "inconclusive-search-or-product-outcome";
      "not-applicable": "provided-applicability-input";
      blocked: "blocked-search-or-product-outcome";
      satisfied: "positive-repository-observation";
    };
    unknownPolicy: "declare-missing-human-input";
    notApplicable: "provided-human-input";
  };
}

export interface DocumentationMaturityGateCatalogV1 {
  schemaVersion: 1;
  kind: "docsfab-documentation-maturity-gate-catalog";
  version: typeof DOCUMENTATION_MATURITY_CATALOG_VERSION;
  gates: DocumentationMaturityGateDefinitionV1[];
  catalogSha256: string;
}

const GATE_ROWS: Array<
  Omit<DocumentationMaturityGateDefinitionV1, "dispositions" | "evidenceRequirements">
> = [
  { id: "G0", ordinal: 0, stage: "foundations", applicability: "always", prerequisites: [] },
  {
    id: "G1",
    ordinal: 1,
    stage: "coverage",
    applicability: "documentation-surface",
    prerequisites: ["G0"],
  },
  {
    id: "G2",
    ordinal: 2,
    stage: "structure",
    applicability: "documentation-surface",
    prerequisites: ["G0", "G1"],
  },
  {
    id: "G3",
    ordinal: 3,
    stage: "content",
    applicability: "documentation-surface",
    prerequisites: ["G0", "G1", "G2"],
  },
  {
    id: "G4",
    ordinal: 4,
    stage: "polish",
    applicability: "documentation-surface",
    prerequisites: ["G0", "G1", "G2", "G3"],
  },
  {
    id: "G5",
    ordinal: 5,
    stage: "maintenance",
    applicability: "documentation-surface",
    prerequisites: ["G0", "G1", "G2", "G3", "G4"],
  },
];

function buildGateCatalog(): DocumentationMaturityGateCatalogV1 {
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-documentation-maturity-gate-catalog" as const,
    version: DOCUMENTATION_MATURITY_CATALOG_VERSION,
    gates: GATE_ROWS.map((gate) => ({
      ...gate,
      dispositions: [...DOCUMENTATION_MATURITY_DISPOSITIONS],
      evidenceRequirements: {
        materialOneOf: ["repository-observation", "authenticated-bounded-negative"] as Array<
          "repository-observation" | "authenticated-bounded-negative"
        >,
        disposition: {
          "observed-absence": "exact-repository-absence" as const,
          "bounded-not-found": "authenticated-bounded-negative" as const,
          unknown: "inconclusive-search-or-product-outcome" as const,
          "not-applicable": "provided-applicability-input" as const,
          blocked: "blocked-search-or-product-outcome" as const,
          satisfied: "positive-repository-observation" as const,
        },
        unknownPolicy: "declare-missing-human-input" as const,
        notApplicable: "provided-human-input" as const,
      },
    })),
  };
  return deepFreeze({ ...body, catalogSha256: canonicalDigest(body) });
}

export const DOCUMENTATION_MATURITY_GATE_CATALOG = buildGateCatalog();

export interface DocumentationMaturityRepositoryBindingV1 {
  identitySha256: string;
  revision: string;
}

/**
 * A content-free repository observation supplied by an independent scanner.
 * Its checksum protects transport integrity; it becomes authority only when
 * passed separately to validateDocumentationMaturityFinding.
 */
export interface DocumentationRepositoryObservationV1 {
  schemaVersion: 1;
  kind: "docsfab-documentation-repository-observation";
  id: string;
  repository: DocumentationMaturityRepositoryBindingV1;
  gateId: DocumentationMaturityGateId;
  requirement: DocumentationMaturityRequirementV1;
  observation: "present" | "absent";
  paths: string[];
  scopeSha256: string;
  observationSha256: string;
}

export interface DocumentationMaturityRepositoryEvidenceReferenceV1 {
  id: string;
  kind: "repository-observation";
  sha256: string;
}

export interface DocumentationMaturitySearchEvidenceReferenceV1 {
  id: string;
  kind: "documentation-search";
  sha256: string;
}

export interface DocumentationMaturityOutcomeEvidenceReferenceV1 {
  id: string;
  kind: "workflow-outcome";
  sha256: string;
  productDisposition: ProductDisposition;
}

export type DocumentationMaturityEvidenceReferenceV1 =
  | DocumentationMaturityRepositoryEvidenceReferenceV1
  | DocumentationMaturitySearchEvidenceReferenceV1
  | DocumentationMaturityOutcomeEvidenceReferenceV1;

export interface DocumentationAudienceImpactV1 {
  audience: DocumentationAudience;
  impact: "blocked" | "degraded" | "none";
}

export interface DocumentationMaturityRequirementV1 {
  id: string;
  subjectSha256: string;
}

export type DocumentationHumanInputClaim =
  | "applicability"
  | "ownership"
  | "support-requirement"
  | "approval"
  | "other";

export type DocumentationHumanInputDecision =
  | "applicable"
  | "not-applicable"
  | "owner-identified"
  | "support-required"
  | "support-not-required"
  | "approved"
  | "other";

export type DocumentationHumanInputV1 =
  | {
      id: string;
      kind: DocumentationHumanInputKind;
      claim: DocumentationHumanInputClaim;
      status: "missing";
      decision: null;
      valueSha256: null;
    }
  | {
      id: string;
      kind: DocumentationHumanInputKind;
      claim: DocumentationHumanInputClaim;
      status: "provided";
      decision: DocumentationHumanInputDecision;
      valueSha256: string;
    };

export type DocumentationWorkflowInputRequirementV1 =
  | { id: string; status: "missing"; sha256: null }
  | { id: string; status: "available"; sha256: string };

export interface DocumentationMaturityWorkflowV1 {
  name: WorkflowName;
  stepId: string;
}

export interface DocumentationAcceptanceCriterionV1 {
  id: string;
  evidenceKinds: DocumentationAcceptanceEvidenceKind[];
}

export interface DocumentationVerificationV1 {
  id: string;
  method: DocumentationVerificationMethod;
  acceptanceCriterionIds: string[];
}

export interface DocumentationMaturityFindingCandidateV1 {
  id: string;
  findingKey: string;
  gateId: DocumentationMaturityGateId;
  requirement: DocumentationMaturityRequirementV1;
  scopeSha256: string;
  disposition: DocumentationMaturityDisposition;
  issuePriority: DocumentationIssuePriority;
  severity: DocumentationFindingSeverity;
  confidence: DocumentationFindingConfidence;
  audienceImpact: DocumentationAudienceImpactV1[];
  affectedPaths: string[];
  dependencyFingerprints: string[];
  requiredHumanInput: DocumentationHumanInputV1[];
  requiredWorkflowInputs: DocumentationWorkflowInputRequirementV1[];
  workflow: DocumentationMaturityWorkflowV1;
  acceptanceCriteria: DocumentationAcceptanceCriterionV1[];
  verification: DocumentationVerificationV1[];
  evidence: DocumentationMaturityEvidenceReferenceV1[];
}

export interface DocumentationMaturityFindingV1 extends DocumentationMaturityFindingCandidateV1 {
  schemaVersion: 1;
  kind: "docsfab-documentation-maturity-finding";
  repository: DocumentationMaturityRepositoryBindingV1;
  fingerprint: string;
  findingSha256: string;
}

export interface DocumentationMaturitySearchAuthorityV1 {
  gateId: DocumentationMaturityGateId;
  requirement: DocumentationMaturityRequirementV1;
  affectedPaths: string[];
  scopeSha256: string;
  workflow: WorkflowName;
  stepId: string;
  targetId: string;
  evidence: unknown;
}

/** Content-free human-input authority obtained outside the finding candidate. */
export interface DocumentationHumanInputAuthorityV1 {
  id: string;
  kind: DocumentationHumanInputKind;
  claim: DocumentationHumanInputClaim;
  decision: DocumentationHumanInputDecision;
  valueSha256: string;
  repository: DocumentationMaturityRepositoryBindingV1;
  gateId: DocumentationMaturityGateId;
  requirement: DocumentationMaturityRequirementV1;
  affectedPaths: string[];
  scopeSha256: string;
}

export interface DocumentationHumanInputRequirementAuthorityV1 {
  id: string;
  kind: DocumentationHumanInputKind;
  claim: DocumentationHumanInputClaim;
  repository: DocumentationMaturityRepositoryBindingV1;
  gateId: DocumentationMaturityGateId;
  requirement: DocumentationMaturityRequirementV1;
  affectedPaths: string[];
  scopeSha256: string;
}

/** Content-free resolver authority proving a ready work unit's input exists. */
export interface DocumentationGovernedInputAuthorityV1 {
  id: string;
  sha256: string;
  repository: DocumentationMaturityRepositoryBindingV1;
  gateId: DocumentationMaturityGateId;
  requirement: DocumentationMaturityRequirementV1;
  workflow: DocumentationMaturityWorkflowV1;
  findingFingerprint: string;
}

export interface DocumentationWorkflowInputRequirementAuthorityV1 {
  id: string;
  repository: DocumentationMaturityRepositoryBindingV1;
  gateId: DocumentationMaturityGateId;
  requirement: DocumentationMaturityRequirementV1;
  workflow: DocumentationMaturityWorkflowV1;
  findingFingerprint: string;
}

export interface DocumentationMaturityAuthorityV1 {
  repository: RepositoryTarget;
  repositoryIdentitySha256: string;
  repositoryObservations: readonly DocumentationRepositoryObservationV1[];
  searches: readonly DocumentationMaturitySearchAuthorityV1[];
  gapLedger: DocumentationGapLedgerV1 | null;
  outcomeRecords: readonly RunRecord[];
  humanInputRequirements: readonly DocumentationHumanInputRequirementAuthorityV1[];
  humanInputs: readonly DocumentationHumanInputAuthorityV1[];
  workflowInputRequirements: readonly DocumentationWorkflowInputRequirementAuthorityV1[];
  governedInputs: readonly DocumentationGovernedInputAuthorityV1[];
}

export type DocumentationWorkUnitExecutionV1 =
  | {
      state: "ready";
      governedInputs: Array<{ id: string; sha256: string }>;
      missingInputIds: [];
    }
  | {
      state: "missing-input";
      governedInputs: null;
      missingInputIds: string[];
    };

export interface DocumentationMaturityWorkUnitCandidateV1 {
  id: string;
  dependsOnWorkUnitIds: string[];
  execution: DocumentationWorkUnitExecutionV1;
}

export interface DocumentationMaturityWorkUnitV1 extends DocumentationMaturityWorkUnitCandidateV1 {
  schemaVersion: 1;
  kind: "docsfab-documentation-maturity-work-unit";
  repository: DocumentationMaturityRepositoryBindingV1;
  findingFingerprint: string;
  gateId: DocumentationMaturityGateId;
  requirement: DocumentationMaturityRequirementV1;
  scopeSha256: string;
  disposition: DocumentationMaturityDisposition;
  issuePriority: DocumentationIssuePriority;
  severity: DocumentationFindingSeverity;
  confidence: DocumentationFindingConfidence;
  audienceImpact: DocumentationAudienceImpactV1[];
  affectedPaths: string[];
  dependencyFingerprints: string[];
  requiredHumanInput: DocumentationHumanInputV1[];
  requiredWorkflowInputs: DocumentationWorkflowInputRequirementV1[];
  workflow: DocumentationMaturityWorkflowV1;
  acceptanceCriteria: DocumentationAcceptanceCriterionV1[];
  verification: DocumentationVerificationV1[];
  trackerMutation: "not-authorized";
  workUnitFingerprint: string;
  workUnitSha256: string;
}

export interface DocumentationMaturityFindingProjectionV1 {
  schemaVersion: 1;
  kind: "docsfab-documentation-maturity-finding-projection";
  fingerprint: string;
  gateId: DocumentationMaturityGateId;
  disposition: DocumentationMaturityDisposition;
  issuePriority: DocumentationIssuePriority;
  severity: DocumentationFindingSeverity;
  confidence: DocumentationFindingConfidence;
  audiences: DocumentationAudience[];
  affectedPathSha256s: string[];
  dependencyFingerprints: string[];
  missingHumanInputKinds: DocumentationHumanInputKind[];
  workflow: DocumentationMaturityWorkflowV1;
  evidenceKinds: DocumentationMaturityEvidenceKind[];
  projectionSha256: string;
}

export interface DocumentationMaturityWorkUnitProjectionV1 {
  schemaVersion: 1;
  kind: "docsfab-documentation-maturity-work-unit-projection";
  workUnitFingerprint: string;
  findingFingerprint: string;
  gateId: DocumentationMaturityGateId;
  issuePriority: DocumentationIssuePriority;
  executionState: "ready" | "missing-input";
  missingInputCount: number;
  workflow: DocumentationMaturityWorkflowV1;
  trackerMutation: "not-authorized";
  projectionSha256: string;
}

export const DOCUMENTATION_MATURITY_MIGRATION_POLICY = deepFreeze({
  schemaVersion: 1 as const,
  kind: "docsfab-documentation-maturity-migration-policy" as const,
  currentSchemaVersion: 1 as const,
  acceptedSourceVersions: [1] as const,
  v1: "identity-only" as const,
  unknownVersion: "reject" as const,
});

export function decodeDocumentationMaturityGateCatalog(
  value: unknown,
): DocumentationMaturityGateCatalogV1 {
  assertInertPlainData(value, "invalid-catalog");
  rejectCredentials(value, "invalid-catalog");
  if (canonicalJson(value) !== canonicalJson(DOCUMENTATION_MATURITY_GATE_CATALOG)) {
    fail("invalid-catalog");
  }
  return DOCUMENTATION_MATURITY_GATE_CATALOG;
}

export function createDocumentationRepositoryObservation(
  input: Omit<DocumentationRepositoryObservationV1, "schemaVersion" | "kind" | "observationSha256">,
): DocumentationRepositoryObservationV1 {
  assertInertPlainData(input, "invalid-observation");
  rejectCredentials(input, "invalid-observation");
  const body = normalizeRepositoryObservationBody({
    schemaVersion: 1,
    kind: "docsfab-documentation-repository-observation",
    ...input,
  });
  return deepFreeze({ ...body, observationSha256: canonicalDigest(body) });
}

export function decodeDocumentationRepositoryObservation(
  value: unknown,
): DocumentationRepositoryObservationV1 {
  assertInertPlainData(value, "invalid-observation");
  rejectCredentials(value, "invalid-observation");
  const root = object(value, "invalid-observation");
  exact(
    root,
    [
      "schemaVersion",
      "kind",
      "id",
      "repository",
      "gateId",
      "requirement",
      "observation",
      "paths",
      "scopeSha256",
      "observationSha256",
    ],
    "invalid-observation",
  );
  const body = normalizeRepositoryObservationBody(root);
  const observationSha256 = sha(root.observationSha256, "invalid-observation");
  if (observationSha256 !== canonicalDigest(body)) fail("invalid-observation");
  const decoded = deepFreeze({ ...body, observationSha256 });
  if (canonicalJson(value) !== canonicalJson(decoded)) fail("invalid-observation");
  return decoded;
}

export function documentationMaturityFindingFingerprint(
  input: Pick<
    DocumentationMaturityFindingV1,
    "repository" | "gateId" | "findingKey" | "requirement" | "scopeSha256" | "affectedPaths"
  >,
): string {
  assertInertPlainData(input, "invalid-finding");
  const repository = repositoryBinding(input.repository, "invalid-finding");
  const gateId = oneOf(input.gateId, DOCUMENTATION_MATURITY_GATE_IDS, "invalid-finding");
  const findingKey = safeCode(input.findingKey, "invalid-finding");
  const requirement = normalizeRequirement(input.requirement, "invalid-finding");
  const scopeSha256 = sha(input.scopeSha256, "invalid-finding");
  const affectedPaths = paths(input.affectedPaths, "invalid-finding", false);
  return canonicalDigest({
    schemaVersion: 1,
    repositoryIdentitySha256: repository.identitySha256,
    gateId,
    findingKey,
    requirement,
    scopeSha256,
    affectedPaths,
  });
}

/** Seal a material finding against independently supplied repository/workflow authority. */
export function createDocumentationMaturityFinding(
  candidateValue: DocumentationMaturityFindingCandidateV1,
  authorityValue: DocumentationMaturityAuthorityV1,
  workflows: DocumentationMaturityWorkflowAccess,
): DocumentationMaturityFindingV1 {
  assertInertPlainData(candidateValue, "invalid-finding");
  rejectCredentials(candidateValue, "invalid-finding");
  const authority = resolveAuthority(authorityValue, workflows);
  const candidate = normalizeFindingCandidate(candidateValue, workflows);
  const repository = authority.repositoryBinding;
  const fingerprint = documentationMaturityFindingFingerprint({
    repository,
    gateId: candidate.gateId,
    findingKey: candidate.findingKey,
    requirement: candidate.requirement,
    scopeSha256: candidate.scopeSha256,
    affectedPaths: candidate.affectedPaths,
  });
  validateFindingEvidence(candidate, authority, fingerprint);
  if (candidate.dependencyFingerprints.includes(fingerprint)) fail("invalid-finding");
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-documentation-maturity-finding" as const,
    repository,
    ...candidate,
    fingerprint,
  };
  return deepFreeze({ ...body, findingSha256: canonicalDigest(body) });
}

/** Strict shape/checksum decoder. It does not authenticate claimed evidence. */
export function decodeDocumentationMaturityFinding(
  value: unknown,
  workflows: DocumentationMaturityWorkflowAccess,
): DocumentationMaturityFindingV1 {
  assertInertPlainData(value, "invalid-finding");
  rejectCredentials(value, "invalid-finding");
  const root = object(value, "invalid-finding");
  exact(
    root,
    [
      "schemaVersion",
      "kind",
      "repository",
      "id",
      "findingKey",
      "gateId",
      "requirement",
      "scopeSha256",
      "disposition",
      "issuePriority",
      "severity",
      "confidence",
      "audienceImpact",
      "affectedPaths",
      "dependencyFingerprints",
      "requiredHumanInput",
      "requiredWorkflowInputs",
      "workflow",
      "acceptanceCriteria",
      "verification",
      "evidence",
      "fingerprint",
      "findingSha256",
    ],
    "invalid-finding",
  );
  equal(root.schemaVersion, 1, "invalid-finding");
  equal(root.kind, "docsfab-documentation-maturity-finding", "invalid-finding");
  const repository = repositoryBinding(root.repository, "invalid-finding");
  const candidate = normalizeFindingCandidate(
    {
      id: root.id,
      findingKey: root.findingKey,
      gateId: root.gateId,
      requirement: root.requirement,
      scopeSha256: root.scopeSha256,
      disposition: root.disposition,
      issuePriority: root.issuePriority,
      severity: root.severity,
      confidence: root.confidence,
      audienceImpact: root.audienceImpact,
      affectedPaths: root.affectedPaths,
      dependencyFingerprints: root.dependencyFingerprints,
      requiredHumanInput: root.requiredHumanInput,
      requiredWorkflowInputs: root.requiredWorkflowInputs,
      workflow: root.workflow,
      acceptanceCriteria: root.acceptanceCriteria,
      verification: root.verification,
      evidence: root.evidence,
    } as DocumentationMaturityFindingCandidateV1,
    workflows,
  );
  const fingerprint = sha(root.fingerprint, "invalid-finding");
  const expectedFingerprint = documentationMaturityFindingFingerprint({
    repository,
    gateId: candidate.gateId,
    findingKey: candidate.findingKey,
    requirement: candidate.requirement,
    scopeSha256: candidate.scopeSha256,
    affectedPaths: candidate.affectedPaths,
  });
  if (
    fingerprint !== expectedFingerprint ||
    candidate.dependencyFingerprints.includes(fingerprint)
  ) {
    fail("invalid-finding");
  }
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-documentation-maturity-finding" as const,
    repository,
    ...candidate,
    fingerprint,
  };
  const findingSha256 = sha(root.findingSha256, "invalid-finding");
  if (findingSha256 !== canonicalDigest(body)) fail("invalid-finding");
  const decoded = deepFreeze({ ...body, findingSha256 });
  if (canonicalJson(value) !== canonicalJson(decoded)) fail("invalid-finding");
  return decoded;
}

/** Authenticate a decoded/self-checksummed finding against external authority. */
export function validateDocumentationMaturityFinding(
  value: unknown,
  authority: DocumentationMaturityAuthorityV1,
  workflows: DocumentationMaturityWorkflowAccess,
): DocumentationMaturityFindingV1 {
  const decoded = decodeDocumentationMaturityFinding(value, workflows);
  const expected = createDocumentationMaturityFinding(
    findingCandidate(decoded),
    authority,
    workflows,
  );
  if (canonicalJson(decoded) !== canonicalJson(expected)) fail("contradictory-evidence");
  return expected;
}

export function createDocumentationMaturityWorkUnit(
  candidateValue: DocumentationMaturityWorkUnitCandidateV1,
  findingValue: unknown,
  authority: DocumentationMaturityAuthorityV1,
  workflows: DocumentationMaturityWorkflowAccess,
): DocumentationMaturityWorkUnitV1 {
  assertInertPlainData(candidateValue, "invalid-work-unit");
  rejectCredentials(candidateValue, "invalid-work-unit");
  const finding = validateDocumentationMaturityFinding(findingValue, authority, workflows);
  const candidate = normalizeWorkUnitCandidate(
    candidateValue,
    finding.requiredHumanInput,
    finding.requiredWorkflowInputs,
  );
  const resolvedAuthority = resolveAuthority(authority, workflows);
  if (candidate.execution.state === "ready") {
    for (const input of candidate.execution.governedInputs) {
      const trusted = resolvedAuthority.governedInputs.get(input.id);
      if (
        !trusted ||
        trusted.sha256 !== input.sha256 ||
        canonicalJson(trusted.repository) !== canonicalJson(finding.repository) ||
        trusted.gateId !== finding.gateId ||
        canonicalJson(trusted.requirement) !== canonicalJson(finding.requirement) ||
        canonicalJson(trusted.workflow) !== canonicalJson(finding.workflow) ||
        trusted.findingFingerprint !== finding.fingerprint
      ) {
        fail("invalid-work-unit");
      }
    }
  }
  const stableBody = {
    schemaVersion: 1,
    findingFingerprint: finding.fingerprint,
    requirement: finding.requirement,
    scopeSha256: finding.scopeSha256,
    workflow: finding.workflow,
    acceptanceCriteria: finding.acceptanceCriteria,
    verification: finding.verification,
  };
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-documentation-maturity-work-unit" as const,
    repository: finding.repository,
    findingFingerprint: finding.fingerprint,
    gateId: finding.gateId,
    requirement: finding.requirement,
    scopeSha256: finding.scopeSha256,
    disposition: finding.disposition,
    issuePriority: finding.issuePriority,
    severity: finding.severity,
    confidence: finding.confidence,
    audienceImpact: finding.audienceImpact,
    affectedPaths: finding.affectedPaths,
    dependencyFingerprints: finding.dependencyFingerprints,
    requiredHumanInput: finding.requiredHumanInput,
    requiredWorkflowInputs: finding.requiredWorkflowInputs,
    workflow: finding.workflow,
    acceptanceCriteria: finding.acceptanceCriteria,
    verification: finding.verification,
    trackerMutation: "not-authorized" as const,
    ...candidate,
    workUnitFingerprint: canonicalDigest(stableBody),
  };
  return deepFreeze({ ...body, workUnitSha256: canonicalDigest(body) });
}

/** Strict shape/checksum decoder. Finding authority is checked by the validator below. */
export function decodeDocumentationMaturityWorkUnit(
  value: unknown,
  workflows: DocumentationMaturityWorkflowAccess,
): DocumentationMaturityWorkUnitV1 {
  assertInertPlainData(value, "invalid-work-unit");
  rejectCredentials(value, "invalid-work-unit");
  const root = object(value, "invalid-work-unit");
  exact(
    root,
    [
      "schemaVersion",
      "kind",
      "repository",
      "findingFingerprint",
      "gateId",
      "requirement",
      "scopeSha256",
      "disposition",
      "issuePriority",
      "severity",
      "confidence",
      "audienceImpact",
      "affectedPaths",
      "dependencyFingerprints",
      "requiredHumanInput",
      "requiredWorkflowInputs",
      "workflow",
      "acceptanceCriteria",
      "verification",
      "trackerMutation",
      "id",
      "dependsOnWorkUnitIds",
      "execution",
      "workUnitFingerprint",
      "workUnitSha256",
    ],
    "invalid-work-unit",
  );
  equal(root.schemaVersion, 1, "invalid-work-unit");
  equal(root.kind, "docsfab-documentation-maturity-work-unit", "invalid-work-unit");
  equal(root.trackerMutation, "not-authorized", "invalid-work-unit");
  const repository = repositoryBinding(root.repository, "invalid-work-unit");
  const findingFingerprint = sha(root.findingFingerprint, "invalid-work-unit");
  const gateId = oneOf(root.gateId, DOCUMENTATION_MATURITY_GATE_IDS, "invalid-work-unit");
  const requirement = normalizeRequirement(root.requirement, "invalid-work-unit");
  const scopeSha256 = sha(root.scopeSha256, "invalid-work-unit");
  const disposition = oneOf(
    root.disposition,
    DOCUMENTATION_MATURITY_DISPOSITIONS,
    "invalid-work-unit",
  );
  const issuePriority = oneOf(
    root.issuePriority,
    DOCUMENTATION_ISSUE_PRIORITIES,
    "invalid-work-unit",
  );
  const severity = oneOf(root.severity, DOCUMENTATION_FINDING_SEVERITIES, "invalid-work-unit");
  const confidence = oneOf(root.confidence, DOCUMENTATION_FINDING_CONFIDENCE, "invalid-work-unit");
  const audienceImpact = normalizeAudienceImpact(
    root.audienceImpact,
    disposition,
    severity,
    "invalid-work-unit",
  );
  const affectedPaths = paths(root.affectedPaths, "invalid-work-unit", false);
  const dependencyFingerprints = shas(root.dependencyFingerprints, "invalid-work-unit");
  const requiredHumanInput = normalizeHumanInputs(root.requiredHumanInput, "invalid-work-unit");
  const requiredWorkflowInputs = normalizeWorkflowInputs(
    root.requiredWorkflowInputs,
    "invalid-work-unit",
  );
  const workflow = normalizeWorkflow(root.workflow, "invalid-work-unit", workflows);
  const acceptanceCriteria = normalizeAcceptanceCriteria(
    root.acceptanceCriteria,
    "invalid-work-unit",
  );
  const verification = normalizeVerification(
    root.verification,
    acceptanceCriteria,
    "invalid-work-unit",
  );
  const candidate = normalizeWorkUnitCandidate(
    {
      id: root.id as string,
      dependsOnWorkUnitIds: root.dependsOnWorkUnitIds as string[],
      execution: root.execution as DocumentationWorkUnitExecutionV1,
    },
    requiredHumanInput,
    requiredWorkflowInputs,
  );
  const stableBody = {
    schemaVersion: 1,
    findingFingerprint,
    requirement,
    scopeSha256,
    workflow,
    acceptanceCriteria,
    verification,
  };
  const workUnitFingerprint = sha(root.workUnitFingerprint, "invalid-work-unit");
  if (workUnitFingerprint !== canonicalDigest(stableBody)) fail("invalid-work-unit");
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-documentation-maturity-work-unit" as const,
    repository,
    findingFingerprint,
    gateId,
    requirement,
    scopeSha256,
    disposition,
    issuePriority,
    severity,
    confidence,
    audienceImpact,
    affectedPaths,
    dependencyFingerprints,
    requiredHumanInput,
    requiredWorkflowInputs,
    workflow,
    acceptanceCriteria,
    verification,
    trackerMutation: "not-authorized" as const,
    ...candidate,
    workUnitFingerprint,
  };
  const workUnitSha256 = sha(root.workUnitSha256, "invalid-work-unit");
  if (workUnitSha256 !== canonicalDigest(body)) fail("invalid-work-unit");
  const decoded = deepFreeze({ ...body, workUnitSha256 });
  if (canonicalJson(value) !== canonicalJson(decoded)) fail("invalid-work-unit");
  return decoded;
}

export function validateDocumentationMaturityWorkUnit(
  value: unknown,
  findingValue: unknown,
  authority: DocumentationMaturityAuthorityV1,
  workflows: DocumentationMaturityWorkflowAccess,
): DocumentationMaturityWorkUnitV1 {
  const decoded = decodeDocumentationMaturityWorkUnit(value, workflows);
  const expected = createDocumentationMaturityWorkUnit(
    {
      id: decoded.id,
      dependsOnWorkUnitIds: decoded.dependsOnWorkUnitIds,
      execution: decoded.execution,
    },
    findingValue,
    authority,
    workflows,
  );
  if (canonicalJson(decoded) !== canonicalJson(expected)) fail("invalid-work-unit");
  return expected;
}

export function projectSanitizedDocumentationMaturityFinding(
  value: unknown,
  workflows: DocumentationMaturityWorkflowAccess,
): DocumentationMaturityFindingProjectionV1 {
  const finding = decodeDocumentationMaturityFinding(value, workflows);
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-documentation-maturity-finding-projection" as const,
    fingerprint: finding.fingerprint,
    gateId: finding.gateId,
    disposition: finding.disposition,
    issuePriority: finding.issuePriority,
    severity: finding.severity,
    confidence: finding.confidence,
    audiences: finding.audienceImpact.map((item) => item.audience).sort(),
    affectedPathSha256s: finding.affectedPaths.map(sha256).sort(),
    dependencyFingerprints: [...finding.dependencyFingerprints],
    missingHumanInputKinds: finding.requiredHumanInput
      .filter((item) => item.status === "missing")
      .map((item) => item.kind)
      .sort(),
    workflow: finding.workflow,
    evidenceKinds: [...new Set(finding.evidence.map((item) => item.kind))].sort(),
  };
  return deepFreeze({ ...body, projectionSha256: canonicalDigest(body) });
}

export function projectSanitizedDocumentationMaturityWorkUnit(
  value: unknown,
  workflows: DocumentationMaturityWorkflowAccess,
): DocumentationMaturityWorkUnitProjectionV1 {
  const workUnit = decodeDocumentationMaturityWorkUnit(value, workflows);
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-documentation-maturity-work-unit-projection" as const,
    workUnitFingerprint: workUnit.workUnitFingerprint,
    findingFingerprint: workUnit.findingFingerprint,
    gateId: workUnit.gateId,
    issuePriority: workUnit.issuePriority,
    executionState: workUnit.execution.state,
    missingInputCount: workUnit.execution.missingInputIds.length,
    workflow: workUnit.workflow,
    trackerMutation: "not-authorized" as const,
  };
  return deepFreeze({ ...body, projectionSha256: canonicalDigest(body) });
}

/** v1 is the only accepted source; unknown versions require an explicit future rule. */
export function migrateDocumentationMaturityFinding(
  value: unknown,
  workflows: DocumentationMaturityWorkflowAccess,
): DocumentationMaturityFindingV1 {
  assertInertPlainData(value, "migration-required");
  const root = object(value, "migration-required");
  if (root.schemaVersion !== 1) fail("migration-required");
  return decodeDocumentationMaturityFinding(value, workflows);
}

export function migrateDocumentationMaturityWorkUnit(
  value: unknown,
  workflows: DocumentationMaturityWorkflowAccess,
): DocumentationMaturityWorkUnitV1 {
  assertInertPlainData(value, "migration-required");
  const root = object(value, "migration-required");
  if (root.schemaVersion !== 1) fail("migration-required");
  return decodeDocumentationMaturityWorkUnit(value, workflows);
}

interface ResolvedEvidence {
  reference: DocumentationMaturityEvidenceReferenceV1;
  fact: "present" | "observed-absence" | "bounded-not-found" | "unknown" | "blocked" | "product";
  material: DocumentationMaturityMaterialBindingV1 | null;
  workflows: DocumentationMaturityWorkflowV1[];
}

interface DocumentationMaturityMaterialBindingV1 {
  repository: DocumentationMaturityRepositoryBindingV1;
  gateId: DocumentationMaturityGateId;
  requirement: DocumentationMaturityRequirementV1;
  affectedPaths: string[];
  scopeSha256: string;
}

interface ResolvedAuthority {
  repositoryBinding: DocumentationMaturityRepositoryBindingV1;
  evidence: Map<string, ResolvedEvidence>;
  humanInputRequirements: Map<string, DocumentationHumanInputRequirementAuthorityV1>;
  humanInputs: Map<string, DocumentationHumanInputAuthorityV1>;
  workflowInputRequirements: Map<string, DocumentationWorkflowInputRequirementAuthorityV1>;
  governedInputs: Map<string, DocumentationGovernedInputAuthorityV1>;
}

function resolveAuthority(
  value: DocumentationMaturityAuthorityV1,
  workflows: DocumentationMaturityWorkflowAccess,
): ResolvedAuthority {
  assertInertPlainData(value, "invalid-authority");
  rejectCredentials(value, "invalid-authority");
  const root = object(value, "invalid-authority");
  exact(
    root,
    [
      "repository",
      "repositoryIdentitySha256",
      "repositoryObservations",
      "searches",
      "gapLedger",
      "outcomeRecords",
      "humanInputRequirements",
      "humanInputs",
      "workflowInputRequirements",
      "governedInputs",
    ],
    "invalid-authority",
  );
  const repository = repositoryTarget(root.repository, "invalid-authority");
  const repositoryIdentitySha256 = sha(root.repositoryIdentitySha256, "invalid-authority");
  if (repositoryIdentitySha256 !== sha256(repository.sourcePath)) fail("invalid-authority");
  const repositoryBindingValue = {
    identitySha256: repositoryIdentitySha256,
    revision: repository.revision,
  };
  const evidence = new Map<string, ResolvedEvidence>();
  const humanInputRequirements = new Map<string, DocumentationHumanInputRequirementAuthorityV1>();
  for (const value of array(root.humanInputRequirements, "invalid-authority")) {
    const item = object(value, "invalid-authority");
    exact(
      item,
      [
        "id",
        "kind",
        "claim",
        "repository",
        "gateId",
        "requirement",
        "affectedPaths",
        "scopeSha256",
      ],
      "invalid-authority",
    );
    const requirementAuthority = {
      id: id(item.id, "invalid-authority"),
      kind: oneOf(item.kind, DOCUMENTATION_HUMAN_INPUT_KINDS, "invalid-authority"),
      claim: oneOf(
        item.claim,
        ["applicability", "ownership", "support-requirement", "approval", "other"] as const,
        "invalid-authority",
      ),
      repository: repositoryBinding(item.repository, "invalid-authority"),
      gateId: oneOf(item.gateId, DOCUMENTATION_MATURITY_GATE_IDS, "invalid-authority"),
      requirement: normalizeRequirement(item.requirement, "invalid-authority"),
      affectedPaths: paths(item.affectedPaths, "invalid-authority", false),
      scopeSha256: sha(item.scopeSha256, "invalid-authority"),
    };
    validateHumanClaimKind(
      requirementAuthority.kind,
      requirementAuthority.claim,
      "invalid-authority",
    );
    if (
      canonicalJson(requirementAuthority.repository) !== canonicalJson(repositoryBindingValue) ||
      humanInputRequirements.has(requirementAuthority.id)
    )
      fail("invalid-authority");
    humanInputRequirements.set(requirementAuthority.id, requirementAuthority);
  }
  const humanInputs = new Map<string, DocumentationHumanInputAuthorityV1>();
  for (const value of array(root.humanInputs, "invalid-authority")) {
    const item = object(value, "invalid-authority");
    exact(
      item,
      [
        "id",
        "kind",
        "claim",
        "decision",
        "valueSha256",
        "repository",
        "gateId",
        "requirement",
        "affectedPaths",
        "scopeSha256",
      ],
      "invalid-authority",
    );
    const authority = {
      id: id(item.id, "invalid-authority"),
      kind: oneOf(item.kind, DOCUMENTATION_HUMAN_INPUT_KINDS, "invalid-authority"),
      claim: oneOf(
        item.claim,
        ["applicability", "ownership", "support-requirement", "approval", "other"] as const,
        "invalid-authority",
      ),
      decision: oneOf(
        item.decision,
        [
          "applicable",
          "not-applicable",
          "owner-identified",
          "support-required",
          "support-not-required",
          "approved",
          "other",
        ] as const,
        "invalid-authority",
      ),
      valueSha256: sha(item.valueSha256, "invalid-authority"),
      repository: repositoryBinding(item.repository, "invalid-authority"),
      gateId: oneOf(item.gateId, DOCUMENTATION_MATURITY_GATE_IDS, "invalid-authority"),
      requirement: normalizeRequirement(item.requirement, "invalid-authority"),
      affectedPaths: paths(item.affectedPaths, "invalid-authority", false),
      scopeSha256: sha(item.scopeSha256, "invalid-authority"),
    };
    validateHumanClaimKind(authority.kind, authority.claim, "invalid-authority");
    validateHumanDecision(authority.claim, authority.decision, "invalid-authority");
    if (canonicalJson(authority.repository) !== canonicalJson(repositoryBindingValue)) {
      fail("invalid-authority");
    }
    const declared = humanInputRequirements.get(authority.id);
    if (
      !declared ||
      declared.kind !== authority.kind ||
      declared.claim !== authority.claim ||
      declared.gateId !== authority.gateId ||
      canonicalJson(declared.repository) !== canonicalJson(authority.repository) ||
      canonicalJson(declared.requirement) !== canonicalJson(authority.requirement) ||
      canonicalJson(declared.affectedPaths) !== canonicalJson(authority.affectedPaths) ||
      declared.scopeSha256 !== authority.scopeSha256
    )
      fail("invalid-authority");
    if (humanInputs.has(authority.id)) fail("invalid-authority");
    humanInputs.set(authority.id, authority);
  }
  const workflowInputRequirements = new Map<
    string,
    DocumentationWorkflowInputRequirementAuthorityV1
  >();
  for (const value of array(root.workflowInputRequirements, "invalid-authority")) {
    const item = object(value, "invalid-authority");
    exact(
      item,
      ["id", "repository", "gateId", "requirement", "workflow", "findingFingerprint"],
      "invalid-authority",
    );
    const requirementAuthority = {
      id: id(item.id, "invalid-authority"),
      repository: repositoryBinding(item.repository, "invalid-authority"),
      gateId: oneOf(item.gateId, DOCUMENTATION_MATURITY_GATE_IDS, "invalid-authority"),
      requirement: normalizeRequirement(item.requirement, "invalid-authority"),
      workflow: normalizeWorkflow(item.workflow, "invalid-authority", workflows),
      findingFingerprint: sha(item.findingFingerprint, "invalid-authority"),
    };
    if (
      canonicalJson(requirementAuthority.repository) !== canonicalJson(repositoryBindingValue) ||
      workflowInputRequirements.has(requirementAuthority.id)
    )
      fail("invalid-authority");
    workflowInputRequirements.set(requirementAuthority.id, requirementAuthority);
  }
  const governedInputs = new Map<string, DocumentationGovernedInputAuthorityV1>();
  for (const value of array(root.governedInputs, "invalid-authority")) {
    const item = object(value, "invalid-authority");
    exact(
      item,
      ["id", "sha256", "repository", "gateId", "requirement", "workflow", "findingFingerprint"],
      "invalid-authority",
    );
    const inputId = id(item.id, "invalid-authority");
    if (governedInputs.has(inputId)) fail("invalid-authority");
    const inputAuthority = {
      id: inputId,
      sha256: sha(item.sha256, "invalid-authority"),
      repository: repositoryBinding(item.repository, "invalid-authority"),
      gateId: oneOf(item.gateId, DOCUMENTATION_MATURITY_GATE_IDS, "invalid-authority"),
      requirement: normalizeRequirement(item.requirement, "invalid-authority"),
      workflow: normalizeWorkflow(item.workflow, "invalid-authority", workflows),
      findingFingerprint: sha(item.findingFingerprint, "invalid-authority"),
    };
    if (canonicalJson(inputAuthority.repository) !== canonicalJson(repositoryBindingValue)) {
      fail("invalid-authority");
    }
    const declared = workflowInputRequirements.get(inputId);
    if (
      !declared ||
      declared.gateId !== inputAuthority.gateId ||
      declared.findingFingerprint !== inputAuthority.findingFingerprint ||
      canonicalJson(declared.repository) !== canonicalJson(inputAuthority.repository) ||
      canonicalJson(declared.requirement) !== canonicalJson(inputAuthority.requirement) ||
      canonicalJson(declared.workflow) !== canonicalJson(inputAuthority.workflow)
    ) {
      fail("invalid-authority");
    }
    governedInputs.set(inputId, inputAuthority);
  }
  const add = (resolved: ResolvedEvidence): void => {
    if (evidence.has(resolved.reference.id)) fail("invalid-authority");
    evidence.set(resolved.reference.id, resolved);
  };
  for (const value of array(root.repositoryObservations, "invalid-authority")) {
    const observation = decodeDocumentationRepositoryObservation(value);
    if (canonicalJson(observation.repository) !== canonicalJson(repositoryBindingValue)) {
      fail("invalid-authority");
    }
    add({
      reference: {
        id: `repository-observation:${observation.observationSha256}`,
        kind: "repository-observation",
        sha256: observation.observationSha256,
      },
      fact: observation.observation === "present" ? "present" : "observed-absence",
      material: {
        repository: observation.repository,
        gateId: observation.gateId,
        requirement: observation.requirement,
        affectedPaths: observation.paths,
        scopeSha256: observation.scopeSha256,
      },
      workflows: [],
    });
  }
  const searchSources = array(root.searches, "invalid-authority");
  let authenticatedSearchLedger: DocumentationGapLedgerV1 | null = null;
  if (searchSources.length === 0) {
    if (root.gapLedger !== null) fail("invalid-authority");
  } else {
    if (root.gapLedger === null) fail("invalid-authority");
    try {
      authenticatedSearchLedger = decodeDocumentationGapLedger(root.gapLedger);
    } catch {
      fail("invalid-authority");
    }
    if (authenticatedSearchLedger.repositoryIdentitySha256 !== repositoryIdentitySha256) {
      fail("invalid-authority");
    }
  }
  for (const value of searchSources) {
    const source = object(value, "invalid-authority");
    exact(
      source,
      [
        "gateId",
        "requirement",
        "affectedPaths",
        "scopeSha256",
        "workflow",
        "stepId",
        "targetId",
        "evidence",
      ],
      "invalid-authority",
    );
    const gateId = oneOf(source.gateId, DOCUMENTATION_MATURITY_GATE_IDS, "invalid-authority");
    const requirement = normalizeRequirement(source.requirement, "invalid-authority");
    const affectedPaths = paths(source.affectedPaths, "invalid-authority", false);
    const scopeSha256 = sha(source.scopeSha256, "invalid-authority");
    const targetId = id(source.targetId, "invalid-authority");
    const workflowName = workflowNameValue(source.workflow, "invalid-authority", workflows);
    const workflow = workflows.getWorkflow(workflowName);
    const stepId = id(source.stepId, "invalid-authority");
    const step = workflow.steps.find((item) => item.id === stepId);
    if (!step?.search) fail("invalid-authority");
    let decoded;
    try {
      decoded = decodeSavedWorkflowSearchEvidence(source.evidence, step.search, repository);
    } catch {
      fail("invalid-authority");
    }
    const completeFindings = projectDocumentationSearchFindings({
      workflow: workflowName,
      stepId,
      evidence: decoded,
    });
    const expectedCompleteLedger = createDocumentationGapLedger({
      currentRevision: repository.revision,
      findings: completeFindings,
    });
    if (
      authenticatedSearchLedger === null ||
      canonicalJson(authenticatedSearchLedger) !== canonicalJson(expectedCompleteLedger)
    ) {
      fail("invalid-authority");
    }
    const findings = completeFindings.filter((finding) => finding.target.id === targetId);
    if (findings.length !== 1) fail("invalid-authority");
    for (const finding of findings) {
      if (
        finding.evidenceIdentity.repositoryIdentitySha256 !== repositoryIdentitySha256 ||
        finding.evidenceIdentity.repositoryRevision !== repository.revision ||
        canonicalJson(finding.requirement) !== canonicalJson(requirement)
      ) {
        fail("invalid-authority");
      }
      add(
        searchEvidence(
          finding,
          {
            repository: repositoryBindingValue,
            gateId,
            requirement,
            affectedPaths,
            scopeSha256,
          },
          { name: workflowName, stepId },
        ),
      );
    }
  }
  for (const value of array(root.outcomeRecords, "invalid-authority")) {
    const record = value as RunRecord;
    if (
      !record ||
      typeof record !== "object" ||
      canonicalJson(record.repository) !== canonicalJson(repository)
    ) {
      fail("invalid-authority");
    }
    let outcome;
    try {
      outcome = decodeWorkflowOutcome(record.workflowOutcome, record, SECURITY_SCAN_POLICY);
    } catch {
      fail("invalid-authority");
    }
    add({
      reference: {
        id: `workflow-outcome:${outcome.outcomeSha256}`,
        kind: "workflow-outcome",
        sha256: outcome.outcomeSha256,
        productDisposition: outcome.disposition,
      },
      fact: "product",
      material: null,
      workflows: outcome.evidence
        .map((evidence) => ({ name: record.workflow, stepId: evidence.stepId }))
        .filter(
          (workflow, index, values) =>
            values.findIndex(
              (candidate) => canonicalJson(candidate) === canonicalJson(workflow),
            ) === index,
        ),
    });
  }
  rejectContradictoryMaterialFacts(evidence.values());
  return {
    repositoryBinding: deepFreeze(repositoryBindingValue),
    evidence,
    humanInputRequirements,
    humanInputs,
    workflowInputRequirements,
    governedInputs,
  };
}

function searchEvidence(
  finding: DocumentationSearchFindingV1,
  material: DocumentationMaturityMaterialBindingV1,
  workflow: DocumentationMaturityWorkflowV1,
): ResolvedEvidence {
  const fact =
    finding.findingClass === "presence"
      ? "present"
      : finding.findingClass === "absence"
        ? "bounded-not-found"
        : finding.findingClass === "blocked"
          ? "blocked"
          : "unknown";
  return {
    reference: {
      id: `documentation-search:${finding.observationSha256}`,
      kind: "documentation-search",
      sha256: finding.observationSha256,
    },
    fact,
    material,
    workflows: [workflow],
  };
}

function validateFindingEvidence(
  candidate: DocumentationMaturityFindingCandidateV1,
  authority: ResolvedAuthority,
  fingerprint: string,
): void {
  const expectedMaterial: DocumentationMaturityMaterialBindingV1 = {
    repository: authority.repositoryBinding,
    gateId: candidate.gateId,
    requirement: candidate.requirement,
    affectedPaths: candidate.affectedPaths,
    scopeSha256: candidate.scopeSha256,
  };
  const declaredHuman = [...authority.humanInputRequirements.values()]
    .filter(
      (input) =>
        input.gateId === candidate.gateId &&
        canonicalJson(input.repository) === canonicalJson(authority.repositoryBinding) &&
        canonicalJson(input.requirement) === canonicalJson(candidate.requirement) &&
        canonicalJson(input.affectedPaths) === canonicalJson(candidate.affectedPaths) &&
        input.scopeSha256 === candidate.scopeSha256,
    )
    .sort((left, right) => left.id.localeCompare(right.id));
  if (
    canonicalJson(
      candidate.requiredHumanInput.map((input) => ({
        id: input.id,
        kind: input.kind,
        claim: input.claim,
      })),
    ) !==
    canonicalJson(
      declaredHuman.map((input) => ({
        id: input.id,
        kind: input.kind,
        claim: input.claim,
      })),
    )
  )
    fail("contradictory-evidence");
  const declaredWorkflow = [...authority.workflowInputRequirements.values()]
    .filter(
      (input) =>
        input.gateId === candidate.gateId &&
        input.findingFingerprint === fingerprint &&
        canonicalJson(input.repository) === canonicalJson(authority.repositoryBinding) &&
        canonicalJson(input.requirement) === canonicalJson(candidate.requirement) &&
        canonicalJson(input.workflow) === canonicalJson(candidate.workflow),
    )
    .sort((left, right) => left.id.localeCompare(right.id));
  if (
    canonicalJson(candidate.requiredWorkflowInputs.map((input) => input.id)) !==
    canonicalJson(declaredWorkflow.map((input) => input.id))
  ) {
    fail("contradictory-evidence");
  }
  for (const input of candidate.requiredHumanInput) {
    const trusted = authority.humanInputs.get(input.id);
    if (input.status === "missing") {
      if (trusted !== undefined) fail("contradictory-evidence");
    } else if (
      !trusted ||
      trusted.kind !== input.kind ||
      trusted.claim !== input.claim ||
      trusted.decision !== input.decision ||
      trusted.valueSha256 !== input.valueSha256 ||
      trusted.gateId !== candidate.gateId ||
      canonicalJson(trusted.repository) !== canonicalJson(authority.repositoryBinding) ||
      canonicalJson(trusted.requirement) !== canonicalJson(candidate.requirement) ||
      canonicalJson(trusted.affectedPaths) !== canonicalJson(candidate.affectedPaths) ||
      trusted.scopeSha256 !== candidate.scopeSha256
    ) {
      fail("contradictory-evidence");
    }
  }
  for (const input of candidate.requiredWorkflowInputs) {
    const trusted = authority.governedInputs.get(input.id);
    if (input.status === "missing") {
      if (trusted !== undefined) fail("contradictory-evidence");
    } else if (
      !trusted ||
      trusted.sha256 !== input.sha256 ||
      trusted.gateId !== candidate.gateId ||
      canonicalJson(trusted.repository) !== canonicalJson(authority.repositoryBinding) ||
      canonicalJson(trusted.requirement) !== canonicalJson(candidate.requirement) ||
      canonicalJson(trusted.workflow) !== canonicalJson(candidate.workflow) ||
      trusted.findingFingerprint !== fingerprint
    ) {
      fail("contradictory-evidence");
    }
  }
  const hasMissingSemanticHumanInput = candidate.requiredHumanInput.some(
    (input) =>
      input.status === "missing" &&
      (input.kind === "product-policy" ||
        input.kind === "ownership" ||
        input.kind === "support-commitment"),
  );
  if (hasMissingSemanticHumanInput && candidate.disposition !== "unknown") {
    fail("contradictory-evidence");
  }
  const hasNotApplicableDecision = candidate.requiredHumanInput.some(
    (input) =>
      input.status === "provided" &&
      input.kind === "product-policy" &&
      input.claim === "applicability" &&
      input.decision === "not-applicable",
  );
  if (hasNotApplicableDecision && candidate.disposition !== "not-applicable") {
    fail("contradictory-evidence");
  }
  const hasExactObservedAbsence = [...authority.evidence.values()].some(
    (item) =>
      item.fact === "observed-absence" &&
      item.material !== null &&
      canonicalJson(item.material) === canonicalJson(expectedMaterial),
  );
  if (hasExactObservedAbsence && candidate.disposition !== "observed-absence") {
    fail("contradictory-evidence");
  }
  const resolved = candidate.evidence.map((reference) => {
    const expected = authority.evidence.get(reference.id);
    if (!expected || canonicalJson(expected.reference) !== canonicalJson(reference)) {
      fail("contradictory-evidence");
    }
    if (
      expected.material !== null &&
      canonicalJson(expected.material) !== canonicalJson(expectedMaterial)
    ) {
      fail("contradictory-evidence");
    }
    if (
      expected.workflows.length > 0 &&
      !expected.workflows.some(
        (workflow) => canonicalJson(workflow) === canonicalJson(candidate.workflow),
      )
    ) {
      fail("contradictory-evidence");
    }
    return expected;
  });
  if (
    resolved.length === 0 ||
    !resolved.some(
      (item) =>
        item.reference.kind === "repository-observation" ||
        item.reference.kind === "documentation-search",
    )
  ) {
    fail("contradictory-evidence");
  }
  const facts = new Set(resolved.map((item) => item.fact));
  const outcomes = resolved
    .filter(
      (
        item,
      ): item is ResolvedEvidence & {
        reference: DocumentationMaturityOutcomeEvidenceReferenceV1;
      } => item.reference.kind === "workflow-outcome",
    )
    .map((item) => item.reference.productDisposition);
  if (
    outcomes.some((outcome) => !productOutcomeSupportsDisposition(outcome, candidate.disposition))
  ) {
    fail("contradictory-evidence");
  }
  switch (candidate.disposition) {
    case "observed-absence":
      if (!facts.has("observed-absence") || candidate.confidence !== "confirmed") {
        fail("contradictory-evidence");
      }
      break;
    case "bounded-not-found":
      if (!facts.has("bounded-not-found") || candidate.confidence !== "bounded") {
        fail("contradictory-evidence");
      }
      break;
    case "unknown":
      if (
        !(
          facts.has("unknown") ||
          outcomes.some((item) => item === "inconclusive" || item === "needs-input") ||
          candidate.requiredHumanInput.some(
            (item) =>
              item.status === "missing" &&
              (item.kind === "product-policy" ||
                item.kind === "ownership" ||
                item.kind === "support-commitment"),
          )
        ) ||
        candidate.confidence !== "inconclusive"
      ) {
        fail("contradictory-evidence");
      }
      break;
    case "not-applicable":
      if (
        candidate.confidence !== "confirmed" ||
        !candidate.requiredHumanInput.some(
          (item) =>
            item.status === "provided" &&
            item.kind === "product-policy" &&
            item.claim === "applicability" &&
            item.decision === "not-applicable",
        )
      ) {
        fail("contradictory-evidence");
      }
      break;
    case "blocked":
      if (
        !(facts.has("blocked") || outcomes.includes("blocked")) ||
        candidate.confidence === "inconclusive"
      ) {
        fail("contradictory-evidence");
      }
      break;
    case "satisfied":
      if (!facts.has("present") || candidate.confidence === "inconclusive") {
        fail("contradictory-evidence");
      }
      break;
  }
}

function productOutcomeSupportsDisposition(
  outcome: ProductDisposition,
  disposition: DocumentationMaturityDisposition,
): boolean {
  switch (disposition) {
    case "observed-absence":
    case "bounded-not-found":
      return outcome === "not-ready";
    case "unknown":
      return outcome === "inconclusive" || outcome === "needs-input";
    case "not-applicable":
    case "satisfied":
      return outcome === "ready";
    case "blocked":
      return outcome === "blocked";
  }
}

function rejectContradictoryMaterialFacts(values: Iterable<ResolvedEvidence>): void {
  const factsByBinding = new Map<string, Set<ResolvedEvidence["fact"]>>();
  for (const value of values) {
    if (value.material === null || value.fact === "product") continue;
    const key = canonicalDigest(value.material);
    const facts = factsByBinding.get(key) ?? new Set();
    facts.add(value.fact);
    factsByBinding.set(key, facts);
  }
  for (const facts of factsByBinding.values()) {
    if (facts.size <= 1) continue;
    if ([...facts].every((fact) => fact === "observed-absence" || fact === "bounded-not-found"))
      continue;
    fail("contradictory-evidence");
  }
}

/** Additive re-exports for the sealed MEA machine-contract envelope. */
export {
  WORK_UNIT_MACHINE_ACCEPTANCE_AUTHORITIES,
  WORK_UNIT_MACHINE_CHECK_KINDS,
  WORK_UNIT_MACHINE_CONTRACT_KIND,
  WORK_UNIT_MACHINE_CONTRACT_SCHEMA_VERSION,
  WORK_UNIT_MACHINE_EXPECTED_OUTCOME_CLASSES,
  WorkUnitMachineContractError,
  admitsWorkUnitMachineContractForCampaign,
  createWorkUnitMachineContract,
  decodeWorkUnitMachineContract,
  requireWorkUnitMachineContractForMeaAdmission,
  type WorkUnitMachineAcceptanceAuthority,
  type WorkUnitMachineCheckKind,
  type WorkUnitMachineCheckV1,
  type WorkUnitMachineContractBodyV1,
  type WorkUnitMachineContractErrorCode,
  type WorkUnitMachineContractV1,
  type WorkUnitMachineExpectedOutcomeClass,
} from "./work-unit-machine-contract.js";
