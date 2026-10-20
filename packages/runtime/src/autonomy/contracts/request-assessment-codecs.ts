// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  AutoAssessmentInputV1,
  AutoAssessmentV1,
  AutoCycleRequestInputV1,
  AutoCycleRequestV1,
  AutoCycleWorkflowAccess,
  WorkflowCandidateInputV1,
  WorkflowCandidateV1,
} from "../contracts.js";
import {
  array,
  assertInert,
  canonicalJson,
  compare,
  decodeSealed,
  enumeration,
  exact,
  fail,
  fingerprintCompare,
  hash,
  idCompare,
  identifier,
  normalizedHashes,
  normalizedIds,
  object,
  stringArray,
  timestamp,
  unique,
  workflowCompare,
} from "./codec-kit.js";
import {
  branch,
  maturityReference,
  normalizedPaths,
  prerequisite,
  repositoryBinding,
  workflowName,
  workflowPrerequisiteRequirement,
  workflowTaskBinding,
} from "./evidence-codecs.js";
import {
  AUTO_CYCLE_DELIVERY_MODES,
  AUTO_CYCLE_PATH_CLASSES,
  assertModeCompatible,
  deliveryRank,
  seal,
} from "./scope-values.js";

export function createAutoCycleRequest(
  input: AutoCycleRequestInputV1,
  workflows: AutoCycleWorkflowAccess,
): AutoCycleRequestV1 {
  assertInert(input);
  const normalized = normalizeRequestInput(input, workflows);
  return seal("docsfab-auto-cycle-request", "requestSha256", normalized);
}

export function decodeAutoCycleRequest(
  value: unknown,
  workflows: AutoCycleWorkflowAccess,
): AutoCycleRequestV1 {
  return decodeSealed(
    value,
    "docsfab-auto-cycle-request",
    "requestSha256",
    ["cycleId", "repository", "tracker", "maturityFindingSha256s", "bounds"],
    (root) => normalizeRequestInput(root as unknown as AutoCycleRequestInputV1, workflows),
  );
}

export function createWorkflowCandidate(
  input: WorkflowCandidateInputV1,
  request: AutoCycleRequestV1,
  workflows: AutoCycleWorkflowAccess,
): WorkflowCandidateV1 {
  const currentRequest = decodeAutoCycleRequest(request, workflows);
  assertInert(input);
  return normalizeCandidate(input, currentRequest, workflows);
}

export function decodeWorkflowCandidate(
  value: unknown,
  request: AutoCycleRequestV1,
  workflows: AutoCycleWorkflowAccess,
): WorkflowCandidateV1 {
  const currentRequest = decodeAutoCycleRequest(request, workflows);
  return decodeSealed(
    value,
    "docsfab-auto-workflow-candidate",
    "candidateSha256",
    [
      "id",
      "taskSha256",
      "workflow",
      "stepIds",
      "prerequisites",
      "maturityFindingFingerprints",
      "pathClass",
      "pathPrefixes",
      "deliveryMode",
      "validationIds",
    ],
    (root) => candidateBody(root as unknown as WorkflowCandidateInputV1, currentRequest, workflows),
  );
}

export function createAutoAssessment(
  input: AutoAssessmentInputV1,
  request: AutoCycleRequestV1,
  workflows: AutoCycleWorkflowAccess,
): AutoAssessmentV1 {
  const currentRequest = decodeAutoCycleRequest(request, workflows);
  assertInert(input);
  const normalized = normalizeAssessmentInput(input, currentRequest, workflows);
  return seal("docsfab-auto-assessment", "assessmentSha256", normalized);
}

export function decodeAutoAssessment(
  value: unknown,
  request: AutoCycleRequestV1,
  workflows: AutoCycleWorkflowAccess,
): AutoAssessmentV1 {
  const currentRequest = decodeAutoCycleRequest(request, workflows);
  return decodeSealed(
    value,
    "docsfab-auto-assessment",
    "assessmentSha256",
    [
      "requestSha256",
      "repository",
      "trackerObservationSha256",
      "evidenceState",
      "maturityFindings",
      "candidates",
      "openInputIds",
    ],
    (root) =>
      normalizeAssessmentInput(root as unknown as AutoAssessmentInputV1, currentRequest, workflows),
  );
}

function normalizeRequestInput(
  value: AutoCycleRequestInputV1,
  workflows: AutoCycleWorkflowAccess,
): AutoCycleRequestInputV1 {
  const root = object(value);
  exact(root, ["cycleId", "repository", "tracker", "maturityFindingSha256s", "bounds"]);
  const repository = repositoryBinding(root.repository);
  const trackerRoot = object(root.tracker);
  exact(trackerRoot, ["projectIdentitySha256", "observationSha256", "observedAt", "authority"]);
  const boundsRoot = object(root.bounds);
  exact(boundsRoot, [
    "workflowNames",
    "pathClass",
    "pathPrefixes",
    "targetBranch",
    "deliveryMode",
    "requiredValidationIds",
    "workflowPrerequisites",
    "workflowTasks",
  ]);
  const workflowNames = stringArray(boundsRoot.workflowNames).map((value) =>
    workflowName(value, workflows),
  );
  unique(workflowNames);
  if (workflowNames.length === 0) fail("invalid-value");
  const pathClass = enumeration(boundsRoot.pathClass, AUTO_CYCLE_PATH_CLASSES);
  const deliveryMode = enumeration(boundsRoot.deliveryMode, AUTO_CYCLE_DELIVERY_MODES);
  assertModeCompatible(pathClass, deliveryMode);
  const workflowPrerequisites = array(boundsRoot.workflowPrerequisites)
    .map((value) => workflowPrerequisiteRequirement(value, workflows))
    .sort(workflowCompare);
  const workflowTasks = array(boundsRoot.workflowTasks)
    .map((value) => workflowTaskBinding(value, workflows))
    .sort(workflowCompare);
  if (
    workflowPrerequisites.length !== workflowNames.length ||
    workflowTasks.length !== workflowNames.length ||
    canonicalJson(workflowPrerequisites.map((item) => item.workflow)) !==
      canonicalJson([...workflowNames].sort(compare)) ||
    canonicalJson(workflowTasks.map((item) => item.workflow)) !==
      canonicalJson([...workflowNames].sort(compare))
  )
    fail("scope-expansion");
  return {
    cycleId: identifier(root.cycleId),
    repository,
    tracker: {
      projectIdentitySha256: hash(trackerRoot.projectIdentitySha256),
      observationSha256: hash(trackerRoot.observationSha256),
      observedAt: timestamp(trackerRoot.observedAt),
      authority: enumeration(trackerRoot.authority, ["observe-only"] as const),
    },
    maturityFindingSha256s: normalizedHashes(root.maturityFindingSha256s),
    bounds: {
      workflowNames: workflowNames.sort(compare),
      pathClass,
      pathPrefixes: normalizedPaths(boundsRoot.pathPrefixes, pathClass),
      targetBranch: branch(boundsRoot.targetBranch),
      deliveryMode,
      requiredValidationIds: normalizedIds(boundsRoot.requiredValidationIds, true),
      workflowPrerequisites,
      workflowTasks,
    },
  };
}

function normalizeCandidate(
  input: WorkflowCandidateInputV1,
  request: AutoCycleRequestV1,
  workflows: AutoCycleWorkflowAccess,
): WorkflowCandidateV1 {
  return seal(
    "docsfab-auto-workflow-candidate",
    "candidateSha256",
    candidateBody(input, request, workflows),
  );
}

function candidateBody(
  input: WorkflowCandidateInputV1,
  request: AutoCycleRequestV1,
  workflows: AutoCycleWorkflowAccess,
) {
  const root = object(input);
  exact(root, [
    "id",
    "workflow",
    "prerequisites",
    "maturityFindingFingerprints",
    "taskSha256",
    "stepIds",
    "pathClass",
    "pathPrefixes",
    "deliveryMode",
    "validationIds",
  ]);
  const workflow = workflowName(root.workflow, workflows);
  if (!request.bounds.workflowNames.includes(workflow)) fail("scope-expansion");
  const definition = workflows.getWorkflow(workflow);
  const stepIds = stringArray(root.stepIds).map(identifier);
  if (canonicalJson(stepIds) !== canonicalJson(definition.steps.map((step) => step.id))) {
    fail("workflow-not-registered");
  }
  const prerequisites = array(root.prerequisites).map(prerequisite).sort(idCompare);
  unique(prerequisites.map((item) => item.id));
  const requiredPrerequisites = request.bounds.workflowPrerequisites.find(
    (item) => item.workflow === workflow,
  );
  if (
    !requiredPrerequisites ||
    canonicalJson(prerequisites.map((item) => item.id)) !==
      canonicalJson(requiredPrerequisites.prerequisiteIds)
  )
    fail("prerequisite-unsatisfied");
  const pathClass = enumeration(root.pathClass, AUTO_CYCLE_PATH_CLASSES);
  const pathPrefixes = normalizedPaths(root.pathPrefixes, pathClass);
  const deliveryMode = enumeration(root.deliveryMode, AUTO_CYCLE_DELIVERY_MODES);
  if (
    pathClass !== request.bounds.pathClass ||
    !pathPrefixes.every((path) =>
      request.bounds.pathPrefixes.some(
        (prefix) => path === prefix || path.startsWith(`${prefix}/`),
      ),
    ) ||
    deliveryRank(deliveryMode) > deliveryRank(request.bounds.deliveryMode)
  ) {
    fail("scope-expansion");
  }
  assertModeCompatible(pathClass, deliveryMode);
  const writes = definition.steps.some((step) => step.mode === "write");
  if (
    writes !== (pathClass === "documentation-write") ||
    (writes && deliveryMode === "none") ||
    (!writes && deliveryMode !== "none")
  ) {
    fail("scope-expansion");
  }
  const validationIds = normalizedIds(root.validationIds, true);
  if (canonicalJson(validationIds) !== canonicalJson(request.bounds.requiredValidationIds)) {
    fail("scope-expansion");
  }
  const task = request.bounds.workflowTasks.find((item) => item.workflow === workflow);
  if (!task || hash(root.taskSha256) !== task.taskSha256) fail("scope-expansion");
  return {
    id: identifier(root.id),
    taskSha256: task.taskSha256,
    workflow,
    stepIds,
    prerequisites,
    maturityFindingFingerprints: normalizedHashes(root.maturityFindingFingerprints),
    pathClass,
    pathPrefixes,
    deliveryMode,
    validationIds,
  };
}

function normalizeAssessmentInput(
  input: AutoAssessmentInputV1,
  request: AutoCycleRequestV1,
  workflows: AutoCycleWorkflowAccess,
): Omit<AutoAssessmentV1, "schemaVersion" | "kind" | "assessmentSha256"> {
  const root = object(input);
  exact(root, [
    "requestSha256",
    "repository",
    "trackerObservationSha256",
    "evidenceState",
    "maturityFindings",
    "candidates",
    "openInputIds",
  ]);
  if (
    hash(root.requestSha256) !== request.requestSha256 ||
    canonicalJson(repositoryBinding(root.repository)) !== canonicalJson(request.repository) ||
    hash(root.trackerObservationSha256) !== request.tracker.observationSha256
  ) {
    fail("scope-expansion");
  }
  const findings = array(root.maturityFindings).map(maturityReference).sort(fingerprintCompare);
  unique(findings.map((item) => item.fingerprint));
  const suppliedFindingDigests = findings.map((item) => item.findingSha256).sort(compare);
  if (canonicalJson(suppliedFindingDigests) !== canonicalJson(request.maturityFindingSha256s)) {
    fail("scope-expansion");
  }
  const candidates = array(root.candidates)
    .map((item) =>
      "schemaVersion" in object(item)
        ? decodeWorkflowCandidate(item, request, workflows)
        : createWorkflowCandidate(item as unknown as WorkflowCandidateInputV1, request, workflows),
    )
    .sort((left, right) => left.candidateSha256.localeCompare(right.candidateSha256));
  unique(candidates.map((item) => item.candidateSha256));
  unique(candidates.map((item) => item.id));
  const findingFingerprints = new Set(findings.map((item) => item.fingerprint));
  if (
    candidates.some((candidate) =>
      candidate.maturityFindingFingerprints.some(
        (fingerprint) => !findingFingerprints.has(fingerprint),
      ),
    )
  )
    fail("scope-expansion");
  const evidenceState = enumeration(root.evidenceState, [
    "sufficient",
    "low-confidence",
    "conflicting",
    "blocked",
  ] as const);
  const openInputIds = normalizedIds(root.openInputIds, false);
  const hasBlockedEvidence =
    findings.some((finding) => finding.disposition === "blocked") ||
    candidates.some((candidate) =>
      candidate.prerequisites.some((item) => item.state === "blocked"),
    );
  const hasUncertainEvidence =
    findings.some(
      (finding) => finding.confidence === "inconclusive" || finding.disposition === "unknown",
    ) ||
    candidates.some((candidate) =>
      candidate.prerequisites.some(
        (item) => item.state === "missing" || item.state === "conflicting",
      ),
    );
  if (
    (evidenceState === "sufficient" && (hasBlockedEvidence || hasUncertainEvidence)) ||
    (evidenceState === "blocked" && !hasBlockedEvidence) ||
    (evidenceState === "low-confidence" && !hasUncertainEvidence && openInputIds.length === 0)
  ) {
    fail("decision-conflict");
  }
  if (
    (evidenceState === "low-confidence" || evidenceState === "conflicting") &&
    openInputIds.length === 0
  )
    fail("invalid-value");
  return {
    requestSha256: request.requestSha256,
    repository: request.repository,
    trackerObservationSha256: request.tracker.observationSha256,
    evidenceState,
    maturityFindings: findings,
    candidates,
    openInputIds,
  };
}
