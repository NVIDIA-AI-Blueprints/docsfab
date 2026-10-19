// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { canonicalJson } from "../../content-ir/canonical.js";
import type {
  DocumentationAcceptanceCriterionV1,
  DocumentationAcceptanceEvidenceKind,
  DocumentationAudienceImpactV1,
  DocumentationFindingConfidence,
  DocumentationFindingSeverity,
  DocumentationHumanInputClaim,
  DocumentationHumanInputDecision,
  DocumentationHumanInputKind,
  DocumentationHumanInputV1,
  DocumentationMaturityContractErrorCode,
  DocumentationMaturityDisposition,
  DocumentationMaturityEvidenceReferenceV1,
  DocumentationMaturityFindingCandidateV1,
  DocumentationMaturityFindingV1,
  DocumentationMaturityGateId,
  DocumentationMaturityRequirementV1,
  DocumentationMaturityWorkUnitCandidateV1,
  DocumentationMaturityRepositoryBindingV1,
  DocumentationVerificationMethod,
  DocumentationVerificationV1,
  DocumentationWorkflowInputRequirementV1,
  DocumentationMaturityWorkflowAccess,
  DocumentationMaturityWorkflowV1,
  DocumentationRepositoryObservationV1,
} from "../contracts.js";
import {
  DOCUMENTATION_AUDIENCES,
  DOCUMENTATION_FINDING_SEVERITIES,
  DOCUMENTATION_ISSUE_PRIORITIES,
  DOCUMENTATION_MATURITY_DISPOSITIONS,
  DOCUMENTATION_MATURITY_GATE_IDS,
  DOCUMENTATION_FINDING_CONFIDENCE,
  DOCUMENTATION_HUMAN_INPUT_KINDS,
  DOCUMENTATION_VERIFICATION_METHODS,
} from "./values.js";
import {
  array,
  equal,
  exact,
  fail,
  id,
  ids,
  object,
  oneOf,
  paths,
  repositoryBinding,
  safeCode,
  sha,
  shas,
  unique,
  workflowNameValue,
} from "./primitives.js";

export function normalizeRepositoryObservationBody(
  value: Record<string, unknown>,
): Omit<DocumentationRepositoryObservationV1, "observationSha256"> {
  equal(value.schemaVersion, 1, "invalid-observation");
  equal(value.kind, "docsfab-documentation-repository-observation", "invalid-observation");
  return {
    schemaVersion: 1,
    kind: "docsfab-documentation-repository-observation",
    id: id(value.id, "invalid-observation"),
    repository: repositoryBinding(value.repository, "invalid-observation"),
    gateId: oneOf(value.gateId, DOCUMENTATION_MATURITY_GATE_IDS, "invalid-observation"),
    requirement: normalizeRequirement(value.requirement, "invalid-observation"),
    observation: oneOf(value.observation, ["present", "absent"] as const, "invalid-observation"),
    paths: paths(value.paths, "invalid-observation", false),
    scopeSha256: sha(value.scopeSha256, "invalid-observation"),
  };
}

export function normalizeAudienceImpact(
  value: unknown,
  disposition: DocumentationMaturityDisposition,
  severity: DocumentationFindingSeverity,
  code: DocumentationMaturityContractErrorCode,
): DocumentationAudienceImpactV1[] {
  const audienceImpact = array(value, code)
    .map((value) => {
      const item = object(value, code);
      exact(item, ["audience", "impact"], code);
      return {
        audience: oneOf(item.audience, DOCUMENTATION_AUDIENCES, code),
        impact: oneOf(item.impact, ["blocked", "degraded", "none"] as const, code),
      };
    })
    .sort((left, right) => left.audience.localeCompare(right.audience));
  unique(
    audienceImpact.map((item) => item.audience),
    code,
  );
  if (
    audienceImpact.length === 0 ||
    (disposition === "satisfied" || disposition === "not-applicable"
      ? audienceImpact.some((item) => item.impact !== "none") || severity !== "informational"
      : audienceImpact.every((item) => item.impact === "none"))
  ) {
    fail(code);
  }
  return audienceImpact;
}

export function normalizeFindingCandidate(
  value: DocumentationMaturityFindingCandidateV1,
  workflows: DocumentationMaturityWorkflowAccess,
): DocumentationMaturityFindingCandidateV1 {
  const root = object(value, "invalid-finding");
  exact(
    root,
    [
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
    ],
    "invalid-finding",
  );
  const disposition = oneOf(
    root.disposition,
    DOCUMENTATION_MATURITY_DISPOSITIONS,
    "invalid-finding",
  );
  const severity = oneOf(root.severity, DOCUMENTATION_FINDING_SEVERITIES, "invalid-finding");
  const audienceImpact = normalizeAudienceImpact(
    root.audienceImpact,
    disposition,
    severity,
    "invalid-finding",
  );
  const affectedPaths = paths(root.affectedPaths, "invalid-finding", false);
  const dependencyFingerprints = shas(root.dependencyFingerprints, "invalid-finding");
  const requiredHumanInput = normalizeHumanInputs(root.requiredHumanInput, "invalid-finding");
  const requiredWorkflowInputs = normalizeWorkflowInputs(
    root.requiredWorkflowInputs,
    "invalid-finding",
  );
  const workflow = normalizeWorkflow(root.workflow, "invalid-finding", workflows);
  const acceptanceCriteria = normalizeAcceptanceCriteria(
    root.acceptanceCriteria,
    "invalid-finding",
  );
  const verification = normalizeVerification(
    root.verification,
    acceptanceCriteria,
    "invalid-finding",
  );
  const evidence = normalizeEvidenceReferences(root.evidence);
  return {
    id: id(root.id, "invalid-finding"),
    findingKey: safeCode(root.findingKey, "invalid-finding"),
    gateId: oneOf(root.gateId, DOCUMENTATION_MATURITY_GATE_IDS, "invalid-finding"),
    requirement: normalizeRequirement(root.requirement, "invalid-finding"),
    scopeSha256: sha(root.scopeSha256, "invalid-finding"),
    disposition,
    issuePriority: oneOf(root.issuePriority, DOCUMENTATION_ISSUE_PRIORITIES, "invalid-finding"),
    severity,
    confidence: oneOf(root.confidence, DOCUMENTATION_FINDING_CONFIDENCE, "invalid-finding"),
    audienceImpact,
    affectedPaths,
    dependencyFingerprints,
    requiredHumanInput,
    requiredWorkflowInputs,
    workflow,
    acceptanceCriteria,
    verification,
    evidence,
  };
}

function normalizeEvidenceReferences(value: unknown): DocumentationMaturityEvidenceReferenceV1[] {
  const result = array(value, "invalid-finding")
    .map((value) => {
      const item = object(value, "invalid-finding");
      const kind = oneOf(
        item.kind,
        ["repository-observation", "documentation-search", "workflow-outcome"] as const,
        "invalid-finding",
      );
      if (kind === "workflow-outcome") {
        exact(item, ["id", "kind", "sha256", "productDisposition"], "invalid-finding");
        return {
          id: id(item.id, "invalid-finding"),
          kind,
          sha256: sha(item.sha256, "invalid-finding"),
          productDisposition: oneOf(
            item.productDisposition,
            ["ready", "not-ready", "needs-input", "inconclusive", "blocked"] as const,
            "invalid-finding",
          ),
        };
      }
      exact(item, ["id", "kind", "sha256"], "invalid-finding");
      return {
        id: id(item.id, "invalid-finding"),
        kind,
        sha256: sha(item.sha256, "invalid-finding"),
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
  if (result.length === 0 || result.length > 256) fail("invalid-finding");
  unique(
    result.map((item) => item.id),
    "invalid-finding",
  );
  return result;
}

export function normalizeHumanInputs(
  value: unknown,
  code: DocumentationMaturityContractErrorCode,
): DocumentationHumanInputV1[] {
  const result = array(value, code)
    .map((value) => {
      const item = object(value, code);
      exact(item, ["id", "kind", "claim", "status", "decision", "valueSha256"], code);
      const status = oneOf(item.status, ["missing", "provided"] as const, code);
      const base = {
        id: id(item.id, code),
        kind: oneOf(item.kind, DOCUMENTATION_HUMAN_INPUT_KINDS, code),
        claim: oneOf(
          item.claim,
          ["applicability", "ownership", "support-requirement", "approval", "other"] as const,
          code,
        ),
      };
      validateHumanClaimKind(base.kind, base.claim, code);
      if (status === "missing") {
        if (item.decision !== null || item.valueSha256 !== null) fail(code);
        return { ...base, status, decision: null, valueSha256: null };
      }
      const decision = oneOf(
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
        code,
      );
      validateHumanDecision(base.claim, decision, code);
      return { ...base, status, decision, valueSha256: sha(item.valueSha256, code) };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
  unique(
    result.map((item) => item.id),
    code,
  );
  return result;
}

export function normalizeWorkflowInputs(
  value: unknown,
  code: DocumentationMaturityContractErrorCode,
): DocumentationWorkflowInputRequirementV1[] {
  const result = array(value, code)
    .map((value) => {
      const item = object(value, code);
      exact(item, ["id", "status", "sha256"], code);
      const status = oneOf(item.status, ["missing", "available"] as const, code);
      if (status === "missing") {
        if (item.sha256 !== null) fail(code);
        return { id: id(item.id, code), status, sha256: null };
      }
      return { id: id(item.id, code), status, sha256: sha(item.sha256, code) };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
  unique(
    result.map((item) => item.id),
    code,
  );
  if (result.length === 0) fail(code);
  return result;
}

export function normalizeRequirement(
  value: unknown,
  code: DocumentationMaturityContractErrorCode,
): DocumentationMaturityRequirementV1 {
  const item = object(value, code);
  exact(item, ["id", "subjectSha256"], code);
  return { id: safeCode(item.id, code), subjectSha256: sha(item.subjectSha256, code) };
}

export function validateHumanClaimKind(
  kind: DocumentationHumanInputKind,
  claim: DocumentationHumanInputClaim,
  code: DocumentationMaturityContractErrorCode,
): void {
  const expected: Record<DocumentationHumanInputKind, DocumentationHumanInputClaim> = {
    "product-policy": "applicability",
    ownership: "ownership",
    "support-commitment": "support-requirement",
    approval: "approval",
    other: "other",
  };
  if (expected[kind] !== claim) fail(code);
}

export function validateHumanDecision(
  claim: DocumentationHumanInputClaim,
  decision: DocumentationHumanInputDecision,
  code: DocumentationMaturityContractErrorCode,
): void {
  const allowed: Record<DocumentationHumanInputClaim, readonly DocumentationHumanInputDecision[]> =
    {
      applicability: ["applicable", "not-applicable"],
      ownership: ["owner-identified"],
      "support-requirement": ["support-required", "support-not-required"],
      approval: ["approved"],
      other: ["other"],
    };
  if (!allowed[claim].includes(decision)) fail(code);
}

export function normalizeWorkflow(
  value: unknown,
  code: DocumentationMaturityContractErrorCode,
  workflows: DocumentationMaturityWorkflowAccess,
): DocumentationMaturityWorkflowV1 {
  const item = object(value, code);
  exact(item, ["name", "stepId"], code);
  const name = workflowNameValue(item.name, code, workflows);
  const stepId = id(item.stepId, code);
  if (!workflows.getWorkflow(name).steps.some((step) => step.id === stepId)) fail(code);
  return { name, stepId };
}

export function normalizeAcceptanceCriteria(
  value: unknown,
  code: DocumentationMaturityContractErrorCode,
): DocumentationAcceptanceCriterionV1[] {
  const result = array(value, code)
    .map((value) => {
      const item = object(value, code);
      exact(item, ["id", "evidenceKinds"], code);
      const evidenceKinds = array(item.evidenceKinds, code)
        .map((kind) =>
          oneOf(
            kind,
            [
              "repository-observation",
              "documentation-search",
              "workflow-outcome",
              "human-input",
            ] as const,
            code,
          ),
        )
        .sort();
      unique(evidenceKinds, code);
      if (evidenceKinds.length === 0) fail(code);
      return { id: id(item.id, code), evidenceKinds };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
  unique(
    result.map((item) => item.id),
    code,
  );
  if (result.length === 0 || result.length > 64) fail(code);
  return result;
}

export function normalizeVerification(
  value: unknown,
  criteria: readonly DocumentationAcceptanceCriterionV1[],
  code: DocumentationMaturityContractErrorCode,
): DocumentationVerificationV1[] {
  const criterionIds = new Set(criteria.map((item) => item.id));
  const result = array(value, code)
    .map((value) => {
      const item = object(value, code);
      exact(item, ["id", "method", "acceptanceCriterionIds"], code);
      const acceptanceCriterionIds = ids(item.acceptanceCriterionIds, code);
      if (
        acceptanceCriterionIds.length === 0 ||
        acceptanceCriterionIds.some((criterionId) => !criterionIds.has(criterionId))
      )
        fail(code);
      return {
        id: id(item.id, code),
        method: oneOf(item.method, DOCUMENTATION_VERIFICATION_METHODS, code),
        acceptanceCriterionIds,
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
  unique(
    result.map((item) => item.id),
    code,
  );
  if (
    result.length === 0 ||
    criteria.some(
      (criterion) =>
        !result.some((verification) => verification.acceptanceCriterionIds.includes(criterion.id)),
    )
  ) {
    fail(code);
  }
  const evidenceKindForMethod: Record<
    DocumentationVerificationMethod,
    DocumentationAcceptanceEvidenceKind
  > = {
    "repository-observation": "repository-observation",
    "bounded-search": "documentation-search",
    "workflow-outcome": "workflow-outcome",
    "human-attestation": "human-input",
  };
  if (
    result.some((verification) =>
      verification.acceptanceCriterionIds.some((criterionId) => {
        const criterion = criteria.find((item) => item.id === criterionId)!;
        return !criterion.evidenceKinds.includes(evidenceKindForMethod[verification.method]);
      }),
    )
  )
    fail(code);
  return result;
}

export function normalizeWorkUnitCandidate(
  value: DocumentationMaturityWorkUnitCandidateV1,
  requiredHumanInput: readonly DocumentationHumanInputV1[],
  requiredWorkflowInputs: readonly DocumentationWorkflowInputRequirementV1[],
): DocumentationMaturityWorkUnitCandidateV1 {
  const root = object(value, "invalid-work-unit");
  exact(root, ["id", "dependsOnWorkUnitIds", "execution"], "invalid-work-unit");
  const idValue = id(root.id, "invalid-work-unit");
  const dependsOnWorkUnitIds = ids(root.dependsOnWorkUnitIds, "invalid-work-unit");
  if (dependsOnWorkUnitIds.includes(idValue)) fail("invalid-work-unit");
  const executionItem = object(root.execution, "invalid-work-unit");
  exact(executionItem, ["state", "governedInputs", "missingInputIds"], "invalid-work-unit");
  const state = oneOf(
    executionItem.state,
    ["ready", "missing-input"] as const,
    "invalid-work-unit",
  );
  const missingInputIds = ids(executionItem.missingInputIds, "invalid-work-unit");
  const declaredMissing = requiredHumanInput
    .filter((item) => item.status === "missing")
    .map((item) => item.id)
    .concat(
      requiredWorkflowInputs.filter((item) => item.status === "missing").map((item) => item.id),
    )
    .sort();
  if (state === "ready") {
    if (missingInputIds.length > 0 || declaredMissing.length > 0) fail("invalid-work-unit");
    const governedInputs = array(executionItem.governedInputs, "invalid-work-unit")
      .map((value) => {
        const input = object(value, "invalid-work-unit");
        exact(input, ["id", "sha256"], "invalid-work-unit");
        return {
          id: id(input.id, "invalid-work-unit"),
          sha256: sha(input.sha256, "invalid-work-unit"),
        };
      })
      .sort((left, right) => left.id.localeCompare(right.id));
    unique(
      governedInputs.map((input) => input.id),
      "invalid-work-unit",
    );
    const expectedAvailable = requiredWorkflowInputs
      .filter((item) => item.status === "available")
      .map((item) => ({ id: item.id, sha256: item.sha256 }));
    if (canonicalJson(governedInputs) !== canonicalJson(expectedAvailable))
      fail("invalid-work-unit");
    return {
      id: idValue,
      dependsOnWorkUnitIds,
      execution: {
        state,
        governedInputs,
        missingInputIds: [],
      },
    };
  }
  if (
    executionItem.governedInputs !== null ||
    missingInputIds.length === 0 ||
    canonicalJson(missingInputIds) !== canonicalJson(declaredMissing)
  ) {
    fail("invalid-work-unit");
  }
  return {
    id: idValue,
    dependsOnWorkUnitIds,
    execution: { state, governedInputs: null, missingInputIds },
  };
}

export function findingCandidate(
  value: DocumentationMaturityFindingV1,
): DocumentationMaturityFindingCandidateV1 {
  return {
    id: value.id,
    findingKey: value.findingKey,
    gateId: value.gateId,
    requirement: value.requirement,
    scopeSha256: value.scopeSha256,
    disposition: value.disposition,
    issuePriority: value.issuePriority,
    severity: value.severity,
    confidence: value.confidence,
    audienceImpact: value.audienceImpact,
    affectedPaths: value.affectedPaths,
    dependencyFingerprints: value.dependencyFingerprints,
    requiredHumanInput: value.requiredHumanInput,
    requiredWorkflowInputs: value.requiredWorkflowInputs,
    workflow: value.workflow,
    acceptanceCriteria: value.acceptanceCriteria,
    verification: value.verification,
    evidence: value.evidence,
  };
}
