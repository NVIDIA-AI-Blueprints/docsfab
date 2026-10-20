// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { RepositoryTarget } from "../../repository/contracts.js";
import type { RunRecord } from "../../records/contracts.js";
import type { WorkflowName } from "../../workflow-contracts/contracts.js";
import type { RepositoryWorkspace } from "../../repository/workspace/contracts.js";
import type { ReleaseDocumentationWorkUnitV1 } from "../../release-documentation-readiness.js";
import * as workflowCatalog from "../../workflow-registry/catalog.js";
import {
  createDocumentationMaturityFinding,
  createDocumentationMaturityWorkUnit,
  createDocumentationRepositoryObservation,
  decodeDocumentationMaturityFinding,
  decodeDocumentationMaturityWorkUnit,
  documentationMaturityFindingFingerprint,
  validateDocumentationMaturityFinding,
  validateDocumentationMaturityWorkUnit,
  type DocumentationGovernedInputAuthorityV1,
  type DocumentationMaturityAuthorityV1,
  type DocumentationMaturityFindingCandidateV1,
  type DocumentationMaturityFindingV1,
  type DocumentationMaturityGateId,
  type DocumentationMaturityRequirementV1,
  type DocumentationMaturityWorkUnitV1,
  type DocumentationRepositoryObservationV1,
  type DocumentationWorkflowInputRequirementAuthorityV1,
} from "../contracts.js";
import {
  DOCUMENTATION_MATURITY_CAPABILITIES,
  DOCUMENTATION_MATURITY_DEFECT_CLASSES,
  documentationMaturityEvaluator,
  type DocumentationMaturityCapability,
  type DocumentationMaturityDefectClass,
  type DocumentationMaturityEvaluatorCheckState,
  type DocumentationMaturityEvaluatorDefinitionV1,
} from "./catalog.js";
import {
  assertExactShallowInput,
  assertInertPlainData,
  baseAuthority,
  boundedStrings,
  choice,
  deepFreeze,
  exact,
  invalid,
  isSortedUnique,
  plainObject,
  repositoryBinding,
  revision,
  safeId,
  safeIdArray,
  sha,
  shaArray,
  snapshotOpaqueSequence,
  snapshotPlainData,
  unique,
  canonicalDigest,
  canonicalJson,
} from "./dialect.js";
import { loadDocumentationMaturityHostPolicy } from "./host-policy.js";

export interface DocumentationMaturityMappedCheckV1 {
  checkId: string;
  state: DocumentationMaturityEvaluatorCheckState;
  defectClass: DocumentationMaturityDefectClass;
  evidenceSha256s: string[];
  findingFingerprints: string[];
  limitationCodes: string[];
}

export interface DocumentationMaturitySemanticReviewV1 {
  capability: DocumentationMaturityCapability;
  workflow: WorkflowName;
  disposition: "ready" | "not-ready" | "blocked" | "needs-input" | "inconclusive";
  outcomeSha256: string;
  limitationCodes: string[];
  overlaySha256: string;
}

/** Opaque authenticated semantic evidence. It never contains deterministic check results. */
export interface DocumentationMaturitySemanticOverlayV1
  extends DocumentationMaturitySemanticReviewV1 {
  schemaVersion: 1;
  kind: "docsfab-documentation-maturity-semantic-overlay";
  gateId: DocumentationMaturityGateId;
  repository: { identitySha256: string; revision: string };
}

export interface DocumentationMaturityCapabilityMappingV1 {
  schemaVersion: 1;
  kind: "docsfab-documentation-maturity-capability-mapping";
  gateId: DocumentationMaturityGateId;
  capability: DocumentationMaturityCapability;
  repository: { identitySha256: string; revision: string };
  sourceSha256: string;
  checks: DocumentationMaturityMappedCheckV1[];
  findings: DocumentationMaturityFindingV1[];
  workUnits: DocumentationMaturityWorkUnitV1[];
  adaptedWorkUnits: DocumentationMaturityAdaptedWorkUnitV1[];
  mappingSha256: string;
}

export interface DocumentationMaturityAdaptedWorkUnitV1 {
  sourceKind: "release-documentation-readiness";
  sourceArtifactSha256: string;
  workflow: {
    name: "release-documentation-readiness";
    stepId: "assess-release-documentation-readiness";
  };
  value: ReleaseDocumentationWorkUnitV1;
}

interface MappingPrivateState {
  authority: DocumentationMaturityAuthorityV1;
}

const authenticMappings = new WeakMap<object, MappingPrivateState>();
const authenticSemanticOverlays = new WeakMap<object, { record: RunRecord }>();

export interface DocumentationMaturityGateEvaluationV1 {
  schemaVersion: 1;
  kind: "docsfab-documentation-maturity-gate-evaluation";
  evaluatorId: string;
  evaluatorVersion: "1.0.0";
  evaluatorSha256: string;
  gateId: DocumentationMaturityGateId;
  repository: { identitySha256: string; revision: string };
  applicability: "applicable" | "not-applicable" | "unknown";
  disposition: "satisfied" | "not-ready" | "unknown" | "blocked" | "not-applicable";
  checks: DocumentationMaturityMappedCheckV1[];
  findings: DocumentationMaturityFindingV1[];
  workUnits: DocumentationMaturityWorkUnitV1[];
  adaptedWorkUnits: DocumentationMaturityAdaptedWorkUnitV1[];
  sourceMappings: Array<{
    capability: DocumentationMaturityCapability;
    sourceSha256: string;
    mappingSha256: string;
  }>;
  semanticReviews: DocumentationMaturitySemanticOverlayV1[];
  productNeedDecisionSha256: string | null;
  trackerMutation: "not-authorized";
  evaluationSha256: string;
}

export async function evaluateDocumentationMaturityGate(inputValue: {
  gateId: DocumentationMaturityGateId;
  repository: RepositoryTarget;
  policyWorkspace: RepositoryWorkspace | null;
  mappings: readonly DocumentationMaturityCapabilityMappingV1[];
  semanticOverlays?: readonly DocumentationMaturitySemanticOverlayV1[];
}): Promise<DocumentationMaturityGateEvaluationV1> {
  assertExactShallowInput(
    inputValue,
    ["gateId", "repository", "policyWorkspace", "mappings"],
    ["semanticOverlays"],
  );
  const inputDescriptors = Object.getOwnPropertyDescriptors(inputValue);
  const gateId = choice(inputDescriptors.gateId!.value, [
    "G0",
    "G1",
    "G2",
    "G3",
    "G4",
    "G5",
  ] as const);
  const definition = documentationMaturityEvaluator(gateId);
  const repositoryTarget = snapshotPlainData(inputValue.repository);
  const policyWorkspace = inputValue.policyWorkspace;
  const mappings = snapshotOpaqueSequence(
    inputValue.mappings,
    definition.evidenceLimits.maxMappings,
  );
  const semanticOverlays =
    inputValue.semanticOverlays === undefined
      ? (Object.freeze([]) as readonly DocumentationMaturitySemanticOverlayV1[])
      : snapshotOpaqueSequence(inputValue.semanticOverlays, definition.evidenceLimits.maxMappings);
  const repository = repositoryBinding(repositoryTarget.sourcePath, repositoryTarget.revision);
  if (mappings.length + semanticOverlays.length > definition.evidenceLimits.maxMappings) {
    invalid("evidence-limit-exceeded");
  }
  const states = mappings.map((mapping) => validateMapping(mapping, definition, repository));
  unique(mappings.map((mapping) => mapping.capability));
  const semanticReviews = semanticOverlays.map((overlay) =>
    validateSemanticOverlay(overlay, definition, repository),
  );
  unique(semanticReviews.map((review) => review.capability));
  let applicability: DocumentationMaturityGateEvaluationV1["applicability"] = "applicable";
  let productNeedDecisionSha256: string | null = null;
  if (definition.applicability === "explicit-product-need") {
    if (!policyWorkspace) invalid("invalid-product-need");
    const productNeed = (
      await loadDocumentationMaturityHostPolicy(policyWorkspace, repositoryTarget)
    ).productNeed;
    if (
      canonicalJson(productNeed.repository) !== canonicalJson(repository) ||
      !productNeed.scope.gateIds.includes(definition.gateId)
    ) {
      invalid("invalid-product-need");
    }
    applicability =
      productNeed.decision.need === "required"
        ? "applicable"
        : productNeed.decision.need === "not-required"
          ? "not-applicable"
          : "unknown";
    productNeedDecisionSha256 = productNeed.decisionSha256;
  } else if (policyWorkspace !== null) {
    invalid("invalid-product-need");
  }

  const mappedChecks = states.flatMap(({ mapping }) => mapping.checks);
  const checks = definition.checks.map((declared) => {
    const candidates = mappedChecks.filter((candidate) => candidate.checkId === declared.id);
    if (candidates.length > 1) invalid("invalid-mapping");
    return (
      candidates[0] ?? {
        checkId: declared.id,
        state: "unknown" as const,
        defectClass: declared.defectClass,
        evidenceSha256s: [],
        findingFingerprints: [],
        limitationCodes: ["declared-input-unavailable"],
      }
    );
  });
  const findings = states
    .flatMap(({ mapping, state }) =>
      mapping.findings.map((finding) =>
        validateDocumentationMaturityFinding(finding, state.authority, workflowCatalog),
      ),
    )
    .sort(compareFingerprint);
  const workUnits = states
    .flatMap(({ mapping, state }) =>
      mapping.workUnits.map((unit) => {
        const finding = findings.find(
          (candidate) => candidate.fingerprint === unit.findingFingerprint,
        );
        if (!finding) invalid("invalid-mapping");
        return validateDocumentationMaturityWorkUnit(
          unit,
          finding,
          state.authority,
          workflowCatalog,
        );
      }),
    )
    .sort((left, right) => left.workUnitFingerprint.localeCompare(right.workUnitFingerprint));
  const adaptedWorkUnits = states
    .flatMap(({ mapping }) => mapping.adaptedWorkUnits)
    .sort((left, right) => left.value.workUnitSha256.localeCompare(right.value.workUnitSha256));
  if (findings.length > definition.evidenceLimits.maxFindings) invalid("evidence-limit-exceeded");
  unique(findings.map((item) => item.fingerprint));
  unique(workUnits.map((item) => item.workUnitFingerprint));
  unique(adaptedWorkUnits.map((item) => item.value.workUnitSha256));
  const disposition: DocumentationMaturityGateEvaluationV1["disposition"] = composedDisposition(
    applicability,
    checks,
    semanticReviews,
  );
  if (
    applicability !== "applicable" &&
    (mappings.length > 0 ||
      semanticReviews.length > 0 ||
      findings.length > 0 ||
      workUnits.length > 0 ||
      adaptedWorkUnits.length > 0)
  ) {
    invalid("invalid-mapping");
  }
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-documentation-maturity-gate-evaluation" as const,
    evaluatorId: definition.id,
    evaluatorVersion: definition.version,
    evaluatorSha256: definition.evaluatorSha256,
    gateId: definition.gateId,
    repository,
    applicability,
    disposition,
    checks,
    findings,
    workUnits,
    adaptedWorkUnits,
    sourceMappings: mappings
      .map((mapping) => ({
        capability: mapping.capability,
        sourceSha256: mapping.sourceSha256,
        mappingSha256: mapping.mappingSha256,
      }))
      .sort((left, right) => left.capability.localeCompare(right.capability)),
    semanticReviews: semanticReviews.sort((left, right) =>
      left.capability.localeCompare(right.capability),
    ),
    productNeedDecisionSha256,
    trackerMutation: "not-authorized" as const,
  };
  return deepFreeze({ ...body, evaluationSha256: canonicalDigest(body) });
}

/** Shape/checksum decoder; call the validator below to reauthenticate sources. */
export function decodeDocumentationMaturityGateEvaluation(
  value: unknown,
): DocumentationMaturityGateEvaluationV1 {
  assertInertPlainData(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("invalid-mapping");
  const root = value as Record<string, unknown>;
  exact(root, [
    "schemaVersion",
    "kind",
    "evaluatorId",
    "evaluatorVersion",
    "evaluatorSha256",
    "gateId",
    "repository",
    "applicability",
    "disposition",
    "checks",
    "findings",
    "workUnits",
    "adaptedWorkUnits",
    "sourceMappings",
    "semanticReviews",
    "productNeedDecisionSha256",
    "trackerMutation",
    "evaluationSha256",
  ]);
  if (
    root.schemaVersion !== 1 ||
    root.kind !== "docsfab-documentation-maturity-gate-evaluation" ||
    root.evaluatorVersion !== "1.0.0" ||
    root.trackerMutation !== "not-authorized"
  ) {
    invalid("invalid-mapping");
  }
  const gateId = choice(root.gateId, ["G0", "G1", "G2", "G3", "G4", "G5"] as const);
  const definition = documentationMaturityEvaluator(gateId);
  if (
    root.evaluatorId !== definition.id ||
    root.evaluatorSha256 !== definition.evaluatorSha256 ||
    typeof root.evaluationSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(root.evaluationSha256)
  ) {
    invalid("invalid-mapping");
  }
  if (
    !Array.isArray(root.findings) ||
    !Array.isArray(root.workUnits) ||
    !Array.isArray(root.adaptedWorkUnits) ||
    !Array.isArray(root.checks) ||
    !Array.isArray(root.sourceMappings) ||
    !Array.isArray(root.semanticReviews)
  )
    invalid("invalid-mapping");
  const repositoryItem = plainObject(root.repository);
  exact(repositoryItem, ["identitySha256", "revision"]);
  const repository = {
    identitySha256: sha(repositoryItem.identitySha256),
    revision: revision(repositoryItem.revision),
  };
  const checks = root.checks.map((value) => decodeMappedCheck(value, definition));
  if (
    canonicalJson(checks.map((check) => check.checkId)) !==
    canonicalJson(definition.checks.map((check) => check.id))
  )
    invalid("invalid-mapping");
  const findings = root.findings.map((value) =>
    decodeDocumentationMaturityFinding(value, workflowCatalog),
  );
  const workUnits = root.workUnits.map((value) =>
    decodeDocumentationMaturityWorkUnit(value, workflowCatalog),
  );
  const adaptedWorkUnits = root.adaptedWorkUnits.map(decodeAdaptedWorkUnit);
  const sourceMappings = root.sourceMappings.map((value) => {
    const item = plainObject(value);
    exact(item, ["capability", "sourceSha256", "mappingSha256"]);
    return {
      capability: choice(item.capability, DOCUMENTATION_MATURITY_CAPABILITIES),
      sourceSha256: sha(item.sourceSha256),
      mappingSha256: sha(item.mappingSha256),
    };
  });
  if (
    sourceMappings.length > definition.evidenceLimits.maxMappings ||
    !isSortedUnique(sourceMappings.map((mapping) => mapping.capability)) ||
    sourceMappings.some(
      (mapping) =>
        !definition.inputs.some(
          (input) => input.capability === mapping.capability && input.layer === "deterministic",
        ),
    )
  ) {
    invalid("invalid-mapping");
  }
  const semanticReviews = root.semanticReviews.map((value) =>
    decodeSemanticOverlay(value, definition, repository),
  );
  if (
    sourceMappings.length + semanticReviews.length > definition.evidenceLimits.maxMappings ||
    !isSortedUnique(semanticReviews.map((review) => review.capability))
  ) {
    invalid("invalid-mapping");
  }
  const applicability = choice(root.applicability, [
    "applicable",
    "not-applicable",
    "unknown",
  ] as const);
  const productNeedDecisionSha256 =
    root.productNeedDecisionSha256 === null ? null : sha(root.productNeedDecisionSha256);
  if (
    (definition.applicability === "always") !== (productNeedDecisionSha256 === null) ||
    (definition.applicability === "always" && applicability !== "applicable")
  ) {
    invalid("invalid-mapping");
  }
  validateEvaluationLayering({
    definition,
    repository,
    applicability,
    checks,
    findings,
    workUnits,
    adaptedWorkUnits,
    sourceMappings,
    semanticReviews,
  });
  const disposition = choice(root.disposition, [
    "satisfied",
    "not-ready",
    "unknown",
    "blocked",
    "not-applicable",
  ] as const);
  if (disposition !== composedDisposition(applicability, checks, semanticReviews)) {
    invalid("invalid-mapping");
  }
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-documentation-maturity-gate-evaluation" as const,
    evaluatorId: definition.id,
    evaluatorVersion: definition.version,
    evaluatorSha256: definition.evaluatorSha256,
    gateId,
    repository,
    applicability,
    disposition,
    checks,
    findings,
    workUnits,
    adaptedWorkUnits,
    sourceMappings,
    semanticReviews,
    productNeedDecisionSha256,
    trackerMutation: "not-authorized" as const,
  };
  if (root.evaluationSha256 !== canonicalDigest(body)) invalid("invalid-mapping");
  const decoded = {
    ...body,
    evaluationSha256: root.evaluationSha256,
  } as DocumentationMaturityGateEvaluationV1;
  if (canonicalJson(decoded) !== canonicalJson(value)) invalid("invalid-mapping");
  return deepFreeze(decoded);
}

function decodeMappedCheck(
  value: unknown,
  definition: DocumentationMaturityEvaluatorDefinitionV1,
): DocumentationMaturityMappedCheckV1 {
  const item = plainObject(value);
  exact(item, [
    "checkId",
    "state",
    "defectClass",
    "evidenceSha256s",
    "findingFingerprints",
    "limitationCodes",
  ]);
  const checkId = safeId(item.checkId);
  const declared = definition.checks.find((candidate) => candidate.id === checkId);
  if (!declared || declared.defectClass !== item.defectClass) invalid("invalid-mapping");
  return {
    checkId,
    state: choice(item.state, ["satisfied", "finding", "unknown", "blocked"] as const),
    defectClass: choice(item.defectClass, DOCUMENTATION_MATURITY_DEFECT_CLASSES),
    evidenceSha256s: shaArray(item.evidenceSha256s),
    findingFingerprints: shaArray(item.findingFingerprints),
    limitationCodes: safeIdArray(item.limitationCodes),
  };
}

function decodeSemanticOverlay(
  value: unknown,
  definition: DocumentationMaturityEvaluatorDefinitionV1,
  repository: { identitySha256: string; revision: string },
): DocumentationMaturitySemanticOverlayV1 {
  const item = plainObject(value);
  exact(item, [
    "schemaVersion",
    "kind",
    "gateId",
    "capability",
    "repository",
    "workflow",
    "disposition",
    "outcomeSha256",
    "limitationCodes",
    "overlaySha256",
  ]);
  const capability = choice(item.capability, DOCUMENTATION_MATURITY_CAPABILITIES);
  if (
    item.schemaVersion !== 1 ||
    item.kind !== "docsfab-documentation-maturity-semantic-overlay" ||
    item.gateId !== definition.gateId ||
    !definition.inputs.some(
      (input) => input.capability === capability && input.layer === "semantic",
    )
  )
    invalid("invalid-mapping");
  const repositoryValue = plainObject(item.repository);
  exact(repositoryValue, ["identitySha256", "revision"]);
  const overlayRepository = {
    identitySha256: sha(repositoryValue.identitySha256),
    revision: revision(repositoryValue.revision),
  };
  if (canonicalJson(overlayRepository) !== canonicalJson(repository)) invalid("invalid-mapping");
  const workflow = choice(item.workflow, [
    "readiness",
    "review-documentation",
    "update-documentation",
    "ia-analysis",
    "ia-plan",
  ] as const);
  if (workflowCapability(workflow) !== capability) invalid("invalid-mapping");
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-documentation-maturity-semantic-overlay" as const,
    gateId: definition.gateId,
    capability,
    repository: overlayRepository,
    workflow,
    disposition: choice(item.disposition, [
      "ready",
      "not-ready",
      "blocked",
      "needs-input",
      "inconclusive",
    ] as const),
    outcomeSha256: sha(item.outcomeSha256),
    limitationCodes: safeIdArray(item.limitationCodes),
  };
  const overlaySha256 = sha(item.overlaySha256);
  if (overlaySha256 !== canonicalDigest(body)) invalid("invalid-mapping");
  return { ...body, overlaySha256 };
}

function validateEvaluationLayering(inputValue: {
  definition: DocumentationMaturityEvaluatorDefinitionV1;
  repository: { identitySha256: string; revision: string };
  applicability: DocumentationMaturityGateEvaluationV1["applicability"];
  checks: DocumentationMaturityMappedCheckV1[];
  findings: DocumentationMaturityFindingV1[];
  workUnits: DocumentationMaturityWorkUnitV1[];
  adaptedWorkUnits: DocumentationMaturityAdaptedWorkUnitV1[];
  sourceMappings: DocumentationMaturityGateEvaluationV1["sourceMappings"];
  semanticReviews: DocumentationMaturitySemanticOverlayV1[];
}): void {
  const {
    definition,
    repository,
    applicability,
    checks,
    findings,
    workUnits,
    adaptedWorkUnits,
    sourceMappings,
    semanticReviews,
  } = inputValue;
  if (
    findings.length > definition.evidenceLimits.maxFindings ||
    !isSortedUnique(findings.map((finding) => finding.fingerprint)) ||
    !isSortedUnique(workUnits.map((unit) => unit.workUnitFingerprint)) ||
    !isSortedUnique(adaptedWorkUnits.map((unit) => unit.value.workUnitSha256))
  ) {
    invalid("invalid-mapping");
  }
  if (
    applicability !== "applicable" &&
    (sourceMappings.length > 0 ||
      semanticReviews.length > 0 ||
      findings.length > 0 ||
      workUnits.length > 0 ||
      adaptedWorkUnits.length > 0)
  )
    invalid("invalid-mapping");
  const findingReferences = checks.flatMap((check) => check.findingFingerprints);
  unique(findingReferences);
  if (
    canonicalJson([...findingReferences].sort()) !==
    canonicalJson(findings.map((finding) => finding.fingerprint))
  )
    invalid("invalid-mapping");
  const adaptedSourceArtifacts = new Set(
    sourceMappings
      .filter((mapping) => mapping.capability === "release-documentation-readiness")
      .map((mapping) => mapping.sourceSha256),
  );
  if (adaptedWorkUnits.some((unit) => !adaptedSourceArtifacts.has(unit.sourceArtifactSha256))) {
    invalid("invalid-mapping");
  }
  for (const check of checks) {
    if (
      (check.state === "satisfied" || check.state === "finding" || check.state === "blocked") &&
      check.evidenceSha256s.length === 0
    )
      invalid("invalid-mapping");
    if (check.state !== "finding" && check.findingFingerprints.length > 0)
      invalid("invalid-mapping");
    if (
      (check.state === "unknown" || check.state === "blocked") &&
      check.limitationCodes.length === 0
    )
      invalid("invalid-mapping");
    if (
      (check.state === "satisfied" || check.state === "finding") &&
      check.limitationCodes.length > 0
    )
      invalid("invalid-mapping");
    if (
      check.state === "finding" &&
      check.findingFingerprints.length === 0 &&
      adaptedWorkUnits.length === 0
    )
      invalid("invalid-mapping");
  }
  const findingSet = new Set(findings.map((finding) => finding.fingerprint));
  for (const finding of findings) {
    if (
      finding.gateId !== definition.gateId ||
      canonicalJson(finding.repository) !== canonicalJson(repository)
    )
      invalid("invalid-mapping");
  }
  for (const workUnit of workUnits) {
    if (
      !findingSet.has(workUnit.findingFingerprint) ||
      workUnit.gateId !== definition.gateId ||
      canonicalJson(workUnit.repository) !== canonicalJson(repository)
    )
      invalid("invalid-mapping");
  }
}

function composedDisposition(
  applicability: DocumentationMaturityGateEvaluationV1["applicability"],
  checks: readonly DocumentationMaturityMappedCheckV1[],
  semanticReviews: readonly DocumentationMaturitySemanticOverlayV1[],
): DocumentationMaturityGateEvaluationV1["disposition"] {
  if (applicability === "not-applicable") return "not-applicable";
  if (applicability === "unknown") return "unknown";
  const states = [
    ...checks.map((check) => check.state),
    ...semanticReviews.map(
      (review): DocumentationMaturityEvaluatorCheckState =>
        review.disposition === "ready"
          ? "satisfied"
          : review.disposition === "not-ready"
            ? "finding"
            : review.disposition === "blocked"
              ? "blocked"
              : "unknown",
    ),
  ];
  return states.includes("finding")
    ? "not-ready"
    : states.includes("blocked")
      ? "blocked"
      : states.includes("unknown")
        ? "unknown"
        : "satisfied";
}

function decodeAdaptedWorkUnit(value: unknown): DocumentationMaturityAdaptedWorkUnitV1 {
  const item = plainObject(value);
  exact(item, ["sourceKind", "sourceArtifactSha256", "workflow", "value"]);
  if (item.sourceKind !== "release-documentation-readiness") invalid("invalid-mapping");
  const workflow = plainObject(item.workflow);
  exact(workflow, ["name", "stepId"]);
  if (
    workflow.name !== "release-documentation-readiness" ||
    workflow.stepId !== "assess-release-documentation-readiness"
  )
    invalid("invalid-mapping");
  const unit = plainObject(item.value);
  exact(unit, [
    "id",
    "targetId",
    "priority",
    "rationale",
    "dependencies",
    "acceptanceCriteria",
    "verification",
    "requiredHumanInput",
    "trackerMutation",
    "workUnitSha256",
  ]);
  if (unit.trackerMutation !== "not-authorized") invalid("invalid-mapping");
  const body = {
    id: safeId(unit.id),
    targetId: safeId(unit.targetId),
    priority: choice(unit.priority, ["P0", "P1", "P2"] as const),
    rationale: safeId(unit.rationale),
    dependencies: safeIdArray(unit.dependencies),
    acceptanceCriteria: boundedStrings(unit.acceptanceCriteria),
    verification: boundedStrings(unit.verification),
    requiredHumanInput: boundedStrings(unit.requiredHumanInput),
    trackerMutation: "not-authorized" as const,
  };
  const workUnitSha256 = sha(unit.workUnitSha256);
  if (workUnitSha256 !== canonicalDigest(body)) invalid("invalid-mapping");
  return {
    sourceKind: "release-documentation-readiness",
    sourceArtifactSha256: sha(item.sourceArtifactSha256),
    workflow: {
      name: "release-documentation-readiness",
      stepId: "assess-release-documentation-readiness",
    },
    value: { ...body, workUnitSha256 },
  };
}

export async function validateDocumentationMaturityGateEvaluation(
  value: unknown,
  inputValue: Parameters<typeof evaluateDocumentationMaturityGate>[0],
): Promise<DocumentationMaturityGateEvaluationV1> {
  const decoded = decodeDocumentationMaturityGateEvaluation(value);
  const expected = await evaluateDocumentationMaturityGate(inputValue);
  if (canonicalJson(decoded) !== canonicalJson(expected)) invalid("invalid-mapping");
  return expected;
}

function validateMapping(
  mapping: DocumentationMaturityCapabilityMappingV1,
  definition: DocumentationMaturityEvaluatorDefinitionV1,
  repository: { identitySha256: string; revision: string },
): { mapping: DocumentationMaturityCapabilityMappingV1; state: MappingPrivateState } {
  const state = authenticMappings.get(mapping);
  if (
    !state ||
    mapping.gateId !== definition.gateId ||
    !definition.inputs.some(
      (input) => input.capability === mapping.capability && input.layer === "deterministic",
    ) ||
    canonicalJson(mapping.repository) !== canonicalJson(repository)
  )
    invalid("invalid-source");
  const { mappingSha256: _mappingSha256, ...body } = mapping;
  const sourceInputIds = definition.inputs
    .filter((input) => input.capability === mapping.capability && input.layer === "deterministic")
    .map((input) => input.id);
  if (
    mapping.mappingSha256 !== canonicalDigest(body) ||
    mapping.checks.some(
      (candidate) =>
        !definition.checks.some(
          (check) =>
            check.id === candidate.checkId &&
            check.defectClass === candidate.defectClass &&
            check.sourceInputIds.some((sourceInputId) => sourceInputIds.includes(sourceInputId)),
        ),
    )
  ) {
    invalid("invalid-mapping");
  }
  return { mapping, state };
}

function validateSemanticOverlay(
  overlay: DocumentationMaturitySemanticOverlayV1,
  definition: DocumentationMaturityEvaluatorDefinitionV1,
  repository: { identitySha256: string; revision: string },
): DocumentationMaturitySemanticOverlayV1 {
  const state = authenticSemanticOverlays.get(overlay);
  if (
    !state ||
    overlay.gateId !== definition.gateId ||
    canonicalJson(overlay.repository) !== canonicalJson(repository) ||
    !definition.inputs.some(
      (input) => input.capability === overlay.capability && input.layer === "semantic",
    )
  ) {
    invalid("invalid-source");
  }
  const { overlaySha256, ...body } = overlay;
  if (overlaySha256 !== canonicalDigest(body)) invalid("invalid-source");
  const recordRepository = repositoryBinding(
    state.record.repository.sourcePath,
    state.record.repository.revision,
  );
  if (
    canonicalJson(recordRepository) !== canonicalJson(repository) ||
    state.record.workflow !== overlay.workflow ||
    state.record.workflowOutcome?.outcomeSha256 !== overlay.outcomeSha256
  ) {
    invalid("invalid-source");
  }
  return overlay;
}

export function sealMapping(
  inputValue: Omit<
    DocumentationMaturityCapabilityMappingV1,
    "schemaVersion" | "kind" | "mappingSha256" | "adaptedWorkUnits"
  > & {
    adaptedWorkUnits?: DocumentationMaturityAdaptedWorkUnitV1[];
  },
  authority: DocumentationMaturityAuthorityV1,
): DocumentationMaturityCapabilityMappingV1 {
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-documentation-maturity-capability-mapping" as const,
    ...inputValue,
    checks: [...inputValue.checks].sort((left, right) => left.checkId.localeCompare(right.checkId)),
    findings: [...inputValue.findings].sort(compareFingerprint),
    workUnits: [...inputValue.workUnits].sort((left, right) =>
      left.workUnitFingerprint.localeCompare(right.workUnitFingerprint),
    ),
    adaptedWorkUnits: [...(inputValue.adaptedWorkUnits ?? [])].sort((left, right) =>
      left.value.workUnitSha256.localeCompare(right.value.workUnitSha256),
    ),
  };
  const mapping = deepFreeze({ ...body, mappingSha256: canonicalDigest(body) });
  authenticMappings.set(mapping, { authority });
  return mapping;
}

export interface ObservationDefectSeed {
  checkId: string;
  defectClass: DocumentationMaturityDefectClass;
  affectedPaths: string[];
  issuePriority: "P0" | "P1" | "P2";
  workflow: { name: WorkflowName; stepId: string };
  requirementSubjectSha256?: string;
  scopeSha256?: string;
}

export function sealObservationMapping(inputValue: {
  gateId: DocumentationMaturityGateId;
  capability: DocumentationMaturityCapability;
  repository: RepositoryTarget;
  sourceSha256: string;
  checks: DocumentationMaturityMappedCheckV1[];
  defects: ObservationDefectSeed[];
}): DocumentationMaturityCapabilityMappingV1 {
  const authority = baseAuthority(inputValue.repository);
  const repository = repositoryBinding(
    inputValue.repository.sourcePath,
    inputValue.repository.revision,
  );
  const observations: DocumentationRepositoryObservationV1[] = [];
  const candidates: DocumentationMaturityFindingCandidateV1[] = [];
  const workflowRequirements: DocumentationWorkflowInputRequirementAuthorityV1[] = [];
  const governedInputs: DocumentationGovernedInputAuthorityV1[] = [];
  for (const defect of inputValue.defects) {
    const requirement = {
      ...checkRequirement(inputValue.gateId, defect.checkId),
      ...(defect.requirementSubjectSha256
        ? { subjectSha256: defect.requirementSubjectSha256 }
        : {}),
    };
    const scopeSha256 = defect.scopeSha256 ?? checkScope(inputValue.gateId, defect.checkId);
    const paths = [...new Set(defect.affectedPaths)].sort();
    const observation = createDocumentationRepositoryObservation({
      id: `observation:${inputValue.gateId.toLowerCase()}:${defect.checkId}`,
      repository,
      gateId: inputValue.gateId,
      requirement,
      observation: "absent",
      paths,
      scopeSha256,
    });
    observations.push(observation);
    const governedInputId = `input:${inputValue.gateId.toLowerCase()}:${defect.checkId}`;
    const candidate: DocumentationMaturityFindingCandidateV1 = {
      id: `finding:${inputValue.gateId.toLowerCase()}:${defect.checkId}`,
      findingKey: defect.checkId,
      gateId: inputValue.gateId,
      requirement,
      scopeSha256,
      disposition: "observed-absence",
      issuePriority: defect.issuePriority,
      severity:
        defect.issuePriority === "P0"
          ? "critical"
          : defect.issuePriority === "P1"
            ? "major"
            : "minor",
      confidence: "confirmed",
      audienceImpact: [
        {
          audience: audienceForDefect(defect.defectClass),
          impact: defect.issuePriority === "P0" ? "blocked" : "degraded",
        },
      ],
      affectedPaths: paths,
      dependencyFingerprints: [],
      requiredHumanInput: [],
      requiredWorkflowInputs: [
        { id: governedInputId, status: "available", sha256: inputValue.sourceSha256 },
      ],
      workflow: defect.workflow,
      acceptanceCriteria: [
        { id: `criterion:${defect.checkId}`, evidenceKinds: ["repository-observation"] },
      ],
      verification: [
        {
          id: `verify:${defect.checkId}`,
          method: "repository-observation",
          acceptanceCriterionIds: [`criterion:${defect.checkId}`],
        },
      ],
      evidence: [
        {
          id: `repository-observation:${observation.observationSha256}`,
          kind: "repository-observation",
          sha256: observation.observationSha256,
        },
      ],
    };
    candidates.push(candidate);
    const fingerprint = documentationMaturityFindingFingerprint({ ...candidate, repository });
    workflowRequirements.push({
      id: governedInputId,
      repository,
      gateId: inputValue.gateId,
      requirement,
      workflow: defect.workflow,
      findingFingerprint: fingerprint,
    });
    governedInputs.push({
      id: governedInputId,
      sha256: inputValue.sourceSha256,
      repository,
      gateId: inputValue.gateId,
      requirement,
      workflow: defect.workflow,
      findingFingerprint: fingerprint,
    });
  }
  authority.repositoryObservations = observations;
  authority.workflowInputRequirements = workflowRequirements;
  authority.governedInputs = governedInputs;
  const findings = candidates.map((candidate) =>
    createDocumentationMaturityFinding(candidate, authority, workflowCatalog),
  );
  const workUnits = findings.map((finding) =>
    createDocumentationMaturityWorkUnit(
      {
        id: `work:${inputValue.gateId.toLowerCase()}:${finding.findingKey}`,
        dependsOnWorkUnitIds: [],
        execution: {
          state: "ready",
          governedInputs: finding.requiredWorkflowInputs.map((item) => ({
            id: item.id,
            sha256: item.sha256!,
          })),
          missingInputIds: [],
        },
      },
      finding,
      authority,
      workflowCatalog,
    ),
  );
  const byCheck = new Map(findings.map((finding) => [finding.findingKey, finding.fingerprint]));
  const checks = inputValue.checks.map((candidate) => ({
    ...candidate,
    findingFingerprints: byCheck.has(candidate.checkId)
      ? [byCheck.get(candidate.checkId)!]
      : candidate.findingFingerprints,
  }));
  return sealMapping(
    {
      gateId: inputValue.gateId,
      capability: inputValue.capability,
      repository,
      sourceSha256: inputValue.sourceSha256,
      checks,
      findings,
      workUnits,
    },
    authority,
  );
}

function workflowCapability(workflow: WorkflowName): DocumentationMaturityCapability {
  switch (workflow) {
    case "readiness":
      return "source-readiness";
    case "review-documentation":
      return "documentation-audit";
    case "update-documentation":
      return "documentation-polish";
    case "ia-analysis":
    case "ia-plan":
      return "ia-semantic-review";
    default:
      invalid("invalid-source");
  }
}

function checkRequirement(
  gateId: DocumentationMaturityGateId,
  checkId: string,
): DocumentationMaturityRequirementV1 {
  const definition = documentationMaturityEvaluator(gateId).checks.find(
    (item) => item.id === checkId,
  );
  if (!definition) invalid("invalid-mapping");
  return { id: checkId, subjectSha256: canonicalDigest(definition) };
}

function checkScope(gateId: DocumentationMaturityGateId, checkId: string): string {
  const evaluator = documentationMaturityEvaluator(gateId);
  return canonicalDigest({
    evaluatorId: evaluator.id,
    evaluatorVersion: evaluator.version,
    checkId,
  });
}

function audienceForDefect(
  defectClass: DocumentationMaturityDefectClass,
): "reader" | "new-user" | "operator" | "maintainer" {
  switch (defectClass) {
    case "missing-content":
      return "new-user";
    case "missing-infrastructure":
      return "operator";
    case "structural-defect":
      return "reader";
    case "quality-defect":
      return "reader";
    case "governance-defect":
      return "maintainer";
  }
}

export function mappedCheck(inputValue: {
  checkId: string;
  state: DocumentationMaturityEvaluatorCheckState;
  defectClass: DocumentationMaturityDefectClass;
  evidenceSha256s?: string[];
  findingFingerprints?: string[];
  limitationCodes?: string[];
}): DocumentationMaturityMappedCheckV1 {
  return {
    checkId: inputValue.checkId,
    state: inputValue.state,
    defectClass: inputValue.defectClass,
    evidenceSha256s: [...new Set(inputValue.evidenceSha256s ?? [])].sort(),
    findingFingerprints: [...new Set(inputValue.findingFingerprints ?? [])].sort(),
    limitationCodes: [...new Set(inputValue.limitationCodes ?? [])].sort(),
  };
}

export function compareFingerprint(
  left: DocumentationMaturityFindingV1,
  right: DocumentationMaturityFindingV1,
): number {
  return left.fingerprint.localeCompare(right.fingerprint);
}
