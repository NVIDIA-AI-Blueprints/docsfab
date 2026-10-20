// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { isProxy } from "node:util/types";

// Native source-case convergence replaces mapped claim text through the exact
// byte reproducer. Historical merge jobs retain their separate legacy contract.
export { materializeProductFeedbackCandidate, verifyProductFeedbackCandidate,
  parseProductFeedbackCandidateManifest, encodeProductFeedbackFile, productFeedbackTargetRoutePolicySha256, assertProductFeedbackTargetRoutes } from "./product-feedback-materializer.mjs";

export const RUNTIME_ADAPTER_VERSION = 1;

export const MERGE_RECONCILIATION_RUNTIME_VERSION = 1;
export const MERGE_RECONCILIATION_JOB_KIND =
  "docsfab-merge-reconciliation-job";
export const MERGE_RECONCILIATION_PROPOSAL_KIND =
  "docsfab-merge-reconciliation-proposal";
export const MERGE_RECONCILIATION_RESULT_KIND =
  "docsfab-merge-reconciliation-result";
export const MERGE_RECONCILIATION_RELATIONSHIPS = Object.freeze([
  "compatible",
  "behavior-conflict",
  "intent-conflict",
  "terminology-conflict",
  "scope-conflict",
  "version-conflict",
  "representation-conflict",
  "documentation-quality-conflict",
  "unknown",
]);
export const MERGE_RECONCILIATION_CONFLICT_CLASSIFICATIONS = Object.freeze(
  MERGE_RECONCILIATION_RELATIONSHIPS.filter(
    (classification) => classification !== "compatible",
  ),
);
export const MERGE_RECONCILIATION_SKILLS = Object.freeze([
  "register-source-thread",
  "assess-product-repository",
  "synthesize-source-threads",
  "converge-documentation",
]);

export const GOVERNED_CONVERGENCE_RUNTIME_VERSION = 1;
export const GOVERNED_CONVERGENCE_JOB_KIND =
  "docsfab-governed-convergence-knowledge-job";
export const PRODUCT_REFERENCE_MODEL_CANDIDATE_KIND =
  "docsfab-product-reference-model-candidate";
export const PRODUCT_REFERENCE_PROJECTION_SET_KIND =
  "docsfab-product-reference-projection-set";
export const GOVERNED_CONVERGENCE_KNOWLEDGE_RECEIPT_KIND =
  "docsfab-governed-convergence-knowledge-receipt";
export const PRODUCT_REFERENCE_PROJECTION_TARGETS = Object.freeze([
  "product-requirements",
  "software-requirements",
  "plan-of-record",
]);

const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const GIT_REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const GOVERNED_LOCATOR =
  /^(?:cas:sha256|docsfab-(?:source|model|inconsistency|candidate|receipt)):[a-f0-9]{64}$/u;
const CREDENTIAL = [
  /\b(?:glpat|gldt|glrt|glptt)-[A-Za-z0-9_-]{20,}\b/u,
  /\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}\b/u,
  /\bxox[baprcds]-[A-Za-z0-9-]{20,}\b/u,
  /\bxoxe(?:\.(?:xoxb|xoxp))?-[A-Za-z0-9-]{10,}\b/u,
  /\bxapp-[A-Za-z0-9-]{10,}\b/u,
  /\bnvapi-[A-Za-z0-9_-]{20,}\b/u,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/u,
  /(?:^|[^A-Za-z0-9_-])(?:token|secret|password|api[_-]?key|private[_-]?token|authorization)\s*[:=]\s*\S{8,}/iu,
  /^diff --git /mu,
];
const PATCH_SHAPES = [
  /^diff --git /mu,
  /^\+\+\+ [ab]\//mu,
  /^--- [ab]\//mu,
  /^@@ -\d/mu,
];

function requireTask(task) {
  if (!task || typeof task !== "object" || Array.isArray(task)) {
    throw new Error("Runtime task must be an object");
  }
  if (typeof task.id !== "string" || task.id.trim() === "") {
    throw new Error("Runtime task id is required");
  }
  if (task.state !== "claimed") {
    throw new Error(`Runtime task must be claimed, received ${String(task.state)}`);
  }
  if (!task.workPacket || typeof task.workPacket !== "object") {
    throw new Error("Runtime task work packet is required");
  }
  return task;
}

export function validateRuntimeAdapter(adapter) {
  if (!adapter || typeof adapter !== "object") {
    throw new Error("Runtime adapter must be an object");
  }
  if (adapter.contractVersion !== RUNTIME_ADAPTER_VERSION) {
    throw new Error(
      `Unsupported runtime adapter contract: ${String(adapter.contractVersion)}`,
    );
  }
  for (const method of ["initialize", "startRun", "getRun", "stopRun"]) {
    if (typeof adapter[method] !== "function") {
      throw new Error(`Runtime adapter is missing ${method}()`);
    }
  }
  return adapter;
}

export function renderWorkPacketPrompt(task, canonicalContext) {
  const validatedTask = requireTask(task);
  const packet = validatedTask.workPacket;
  if (!canonicalContext || typeof canonicalContext !== "object") {
    throw new Error("Canonical task context must be an object");
  }
  if (canonicalContext.version !== packet.inputVersion) {
    throw new Error(
      `Canonical context version ${String(canonicalContext.version)} does not match work packet ${String(packet.inputVersion)}`,
    );
  }
  return `# DocsFab knowledge-gathering work packet

Task: ${validatedTask.id}
Project: ${validatedTask.projectId}
Workflow: ${validatedTask.workflowId}
Lifecycle step: ${validatedTask.stepId}
Work kind: ${packet.kind}
Skill: ${packet.skill}
Canonical input version: ${packet.inputVersion}

## Inputs

${packet.inputRefs.map((reference) => `- ${reference}`).join("\n")}

## Expected outputs

${packet.expectedOutputs.map((output) => `- ${output}`).join("\n")}

## Stop conditions

${packet.stopConditions.map((condition) => `- ${condition}`).join("\n")}

## Canonical context

${JSON.stringify(canonicalContext, null, 2)}

## Authority boundary

The DocsFab knowledge control plane is the canonical system of record. Treat
this packet and context as read-only. Return proposed outputs, evidence,
uncertainty, unresolved items, verification performed, and manual
interventions. Do not approve a shared model, change policy, manage
credentials, merge, publish, or claim that a task is complete. The control
plane records artifacts and completion only after validating an explicit
receipt.
`;
}

/**
 * Compose the provider-neutral, report-only merge reconciliation boundary.
 * `executor` launches bounded workers and `resultStore` is the deployment-owned
 * durable store; this library supplies neither an always-on launcher nor
 * process-local persistence.
 */
export function createMergeReconciliationRuntimeAdapter({
  executor,
  resultStore,
}) {
  requireMethods(executor, ["execute"], "Merge reconciliation executor");
  requireMethods(
    resultStore,
    ["getByIdentity", "put"],
    "Merge reconciliation result store",
  );
  const inFlight = new Map();

  const adapter = {
    contractVersion: MERGE_RECONCILIATION_RUNTIME_VERSION,
    async reconcile(input) {
      const job = parseMergeReconciliationJob(input);
      const jobSha256 = sha256(canonicalJson(job));
      const identity = resultIdentity(job);
      const key = resultIdentityKey(identity);
      const existing = await resultStore.getByIdentity(identity);
      if (existing !== null && existing !== undefined) {
        return validateStoredResult(existing, job, jobSha256);
      }
      const active = inFlight.get(key);
      if (active) {
        if (active.jobSha256 !== jobSha256) {
          throw new Error("Merge reconciliation attempt conflicts with the active job");
        }
        return active.promise;
      }
      const promise = executeMergeReconciliation({
        executor,
        resultStore,
        job,
        jobSha256,
      }).finally(() => {
        inFlight.delete(key);
      });
      inFlight.set(key, { jobSha256, promise });
      return promise;
    },
    async getResult(identityInput) {
      const identity = parseResultIdentity(identityInput);
      const stored = await resultStore.getByIdentity(identity);
      if (stored === null || stored === undefined) return null;
      const result = parseMergeReconciliationResult(stored.result ?? stored);
      assertResultIdentity(result, identity);
      return result;
    },
  };
  return Object.freeze(adapter);
}

export function parseMergeReconciliationJob(input) {
  const root = requireObject(input, "Merge reconciliation job");
  exactKeys(root, [
    "schemaVersion",
    "kind",
    "requestKey",
    "attemptId",
    "workId",
    "deploymentId",
    "projectId",
    "deploymentEpoch",
    "contextBindingSha256",
    "forge",
    "modelParent",
    "sourceRegistrations",
  ]);
  if (
    root.schemaVersion !== MERGE_RECONCILIATION_RUNTIME_VERSION ||
    root.kind !== MERGE_RECONCILIATION_JOB_KIND
  ) {
    throw new Error("Unsupported merge reconciliation job contract");
  }
  const forge = parseForgeBinding(root.forge);
  const modelParent = parseModelParent(root.modelParent);
  const sourceRegistrations = requireArray(
    root.sourceRegistrations,
    "Merge reconciliation source registrations",
  ).map(parseSourceRegistration);
  if (sourceRegistrations.length === 0) {
    throw new Error("Merge reconciliation requires the merged revision source");
  }
  if (new Set(sourceRegistrations.map((source) => source.sourceId)).size !== sourceRegistrations.length) {
    throw new Error("Merge reconciliation source ids must be unique");
  }
  const mergeSources = sourceRegistrations.filter(
    (source) => source.sourceKind === "repository-merge",
  );
  if (
    mergeSources.length !== 1 ||
    mergeSources[0].evidenceRole !== "behavior" ||
    mergeSources[0].version !== forge.mergeRevision ||
    mergeSources[0].integritySha256 !== forge.eventSha256
  ) {
    throw new Error("Merged revision source is not bound to the forge event");
  }
  const result = {
    schemaVersion: 1,
    kind: MERGE_RECONCILIATION_JOB_KIND,
    requestKey: requireIdentifier(root.requestKey, "Merge reconciliation request key"),
    attemptId: requireIdentifier(root.attemptId, "Merge reconciliation attempt id"),
    workId: requireIdentifier(root.workId, "Merge reconciliation work id"),
    deploymentId: requireIdentifier(root.deploymentId, "Deployment id"),
    projectId: requireIdentifier(root.projectId, "Project id"),
    deploymentEpoch: requireIdentifier(root.deploymentEpoch, "Deployment epoch"),
    contextBindingSha256: requireSha256(
      root.contextBindingSha256,
      "Reconciliation context-binding digest",
    ),
    forge,
    modelParent,
    sourceRegistrations,
  };
  if (
    result.deploymentId !== forge.deploymentId ||
    result.projectId !== forge.projectId ||
    result.deploymentEpoch !== forge.deploymentEpoch
  ) {
    throw new Error("Merge reconciliation job crosses its forge project boundary");
  }
  rejectUnsafe(result);
  return deepFreeze(result);
}

export function parseMergeReconciliationResult(input) {
  const root = requireObject(input, "Merge reconciliation result");
  exactKeys(root, [
    "schemaVersion",
    "kind",
    "jobSha256",
    "requestKey",
    "attemptId",
    "workId",
    "deploymentId",
    "projectId",
    "deploymentEpoch",
    "contextBindingSha256",
    "forge",
    "modelParent",
    "workflow",
    "sourceRegistrations",
    "claims",
    "inconsistencies",
    "candidateDelta",
    "receipt",
    "measurement",
    "authority",
    "resultSha256",
  ]);
  if (
    root.schemaVersion !== 1 ||
    root.kind !== MERGE_RECONCILIATION_RESULT_KIND
  ) {
    throw new Error("Unsupported merge reconciliation result contract");
  }
  const result = {
    schemaVersion: 1,
    kind: MERGE_RECONCILIATION_RESULT_KIND,
    jobSha256: requireSha256(root.jobSha256, "Merge reconciliation job digest"),
    requestKey: requireIdentifier(root.requestKey, "Merge reconciliation request key"),
    attemptId: requireIdentifier(root.attemptId, "Merge reconciliation attempt id"),
    workId: requireIdentifier(root.workId, "Merge reconciliation work id"),
    deploymentId: requireIdentifier(root.deploymentId, "Deployment id"),
    projectId: requireIdentifier(root.projectId, "Project id"),
    deploymentEpoch: requireIdentifier(root.deploymentEpoch, "Deployment epoch"),
    contextBindingSha256: requireSha256(
      root.contextBindingSha256,
      "Result context-binding digest",
    ),
    forge: parseForgeBinding(root.forge),
    modelParent: parseModelParent(root.modelParent),
    workflow: parseWorkflow(root.workflow),
    sourceRegistrations: requireArray(root.sourceRegistrations, "Result sources").map(
      parseSourceRegistration,
    ),
    claims: requireArray(root.claims, "Result claims").map(parseClaim),
    inconsistencies: requireArray(root.inconsistencies, "Result inconsistencies").map(
      parseInconsistency,
    ),
    candidateDelta: parseCandidateDelta(root.candidateDelta),
    receipt: parseReceipt(root.receipt),
    measurement: parseMeasurement(root.measurement),
    authority: parseAuthorityBoundary(root.authority),
    resultSha256: requireSha256(root.resultSha256, "Merge reconciliation result digest"),
  };
  validateResultBindings(result);
  const { resultSha256: _resultSha256, ...resultBody } = result;
  const bodySha256 = sha256(canonicalJson(resultBody));
  if (bodySha256 !== result.resultSha256) {
    throw new Error("Merge reconciliation result digest does not match its body");
  }
  rejectUnsafe(result);
  return deepFreeze(result);
}

function validateResultBindings(result) {
  if (
    result.deploymentId !== result.forge.deploymentId ||
    result.projectId !== result.forge.projectId ||
    result.deploymentEpoch !== result.forge.deploymentEpoch ||
    result.receipt.contextBindingSha256 !== result.contextBindingSha256 ||
    result.candidateDelta.modelId !== result.modelParent.modelId ||
    result.candidateDelta.parentVersion !== result.modelParent.version ||
    result.candidateDelta.parentSha256 !== result.modelParent.sha256 ||
    result.candidateDelta.locator !== `docsfab-candidate:${result.candidateDelta.sha256}` ||
    result.receipt.requestKey !== result.requestKey ||
    result.receipt.attemptId !== result.attemptId ||
    result.receipt.jobSha256 !== result.jobSha256 ||
    result.receipt.packetSha256 !== result.workflow.packetSha256 ||
    result.receipt.mergeRevision !== result.forge.mergeRevision ||
    result.receipt.mergeSourceRevision !== result.forge.sourceRevision ||
    result.receipt.modelParentSha256 !== result.modelParent.sha256 ||
    result.receipt.candidateDeltaSha256 !== result.candidateDelta.sha256 ||
    result.receipt.locator !== `docsfab-receipt:${result.receipt.sha256}`
  ) {
    throw new Error("Merge reconciliation result binding chain is inconsistent");
  }
  const canonicalJob = {
    schemaVersion: 1,
    kind: MERGE_RECONCILIATION_JOB_KIND,
    requestKey: result.requestKey,
    attemptId: result.attemptId,
    workId: result.workId,
    deploymentId: result.deploymentId,
    projectId: result.projectId,
    deploymentEpoch: result.deploymentEpoch,
    contextBindingSha256: result.contextBindingSha256,
    forge: result.forge,
    modelParent: result.modelParent,
    sourceRegistrations: result.sourceRegistrations,
  };
  if (sha256(canonicalJson(canonicalJob)) !== result.jobSha256) {
    throw new Error("Merge reconciliation result digest is not bound to its canonical job");
  }
  const mergeSources = result.sourceRegistrations.filter(
    (source) => source.sourceKind === "repository-merge",
  );
  if (
    mergeSources.length !== 1 ||
    mergeSources[0].version !== result.forge.mergeRevision ||
    mergeSources[0].integritySha256 !== result.forge.eventSha256
  ) {
    throw new Error("Merge reconciliation result lost the exact merged source");
  }
  const sourceIds = new Set(result.sourceRegistrations.map((source) => source.sourceId));
  const claimIds = new Set(result.claims.map((claim) => claim.claimId));
  if (
    sourceIds.size !== result.sourceRegistrations.length ||
    claimIds.size !== result.claims.length ||
    result.claims.some((claim) => claim.evidenceIds.some((sourceId) => !sourceIds.has(sourceId))) ||
    result.inconsistencies.some(
      (finding) => finding.sourceClaimIds.some((claimId) => !claimIds.has(claimId)),
    )
  ) {
    throw new Error("Merge reconciliation result contains unbound claims or evidence");
  }
  const candidateBody = {
    modelId: result.modelParent.modelId,
    parentVersion: result.modelParent.version,
    parentSha256: result.modelParent.sha256,
    jobSha256: result.jobSha256,
    packetSha256: result.workflow.packetSha256,
    sourceRegistrations: result.sourceRegistrations,
    claims: result.claims,
    inconsistencies: result.inconsistencies,
  };
  if (sha256(canonicalJson(candidateBody)) !== result.candidateDelta.sha256) {
    throw new Error("Candidate model delta digest does not match its inputs");
  }
  const receiptBody = {
    requestKey: result.requestKey,
    attemptId: result.attemptId,
    jobSha256: result.jobSha256,
    packetSha256: result.workflow.packetSha256,
    mergeRevision: result.forge.mergeRevision,
    mergeSourceRevision: result.forge.sourceRevision,
    modelParentSha256: result.modelParent.sha256,
    contextBindingSha256: result.contextBindingSha256,
    candidateDeltaSha256: result.candidateDelta.sha256,
    approvalState: "candidate",
    adjudicationAction: "none",
    projectionAction: "none",
  };
  if (sha256(canonicalJson(receiptBody)) !== result.receipt.sha256) {
    throw new Error("Merge reconciliation receipt digest does not match its inputs");
  }
  const expectedCounts = Object.fromEntries(
    MERGE_RECONCILIATION_CONFLICT_CLASSIFICATIONS.map((classification) => [
      classification,
      result.inconsistencies.filter((item) => item.classification === classification).length,
    ]),
  );
  const expectedConfidenceCounts = Object.fromEntries(
    MERGE_RECONCILIATION_CONFLICT_CLASSIFICATIONS.map((classification) => [
      classification,
      Object.fromEntries(["low", "medium", "high"].map((confidence) => [
        confidence,
        result.inconsistencies.filter(
          (item) => item.classification === classification && item.confidence === confidence,
        ).length,
      ])),
    ]),
  );
  if (
    result.measurement.eligibleMergeEvents !== 1 ||
    result.measurement.reconciliationAttempts !== 1 ||
    result.measurement.findingCount !== result.inconsistencies.length ||
    canonicalJson(result.measurement.classificationCounts) !== canonicalJson(expectedCounts) ||
    canonicalJson(result.measurement.confidenceCounts) !==
      canonicalJson(expectedConfidenceCounts) ||
    result.measurement.selfLoop.observedEligibleEvents !== 1 ||
    result.measurement.selfLoop.suppressedEvents !== 0 ||
    result.measurement.selfLoop.rate !== 0 ||
    result.measurement.falsePositive.assessedReports !== 0 ||
    result.measurement.falsePositive.falsePositiveReports !== 0
  ) {
    throw new Error("Merge reconciliation measurement does not match the result");
  }
}

async function executeMergeReconciliation({ executor, resultStore, job, jobSha256 }) {
  const task = buildMergeWorkPacket(job, jobSha256);
  const canonicalContext = deepFreeze({
    version: job.modelParent.streamVersion,
    job,
    jobSha256,
    executionBoundary: {
      mode: "candidate-report-only",
      adjudication: false,
      mergeModelOrProjection: false,
    },
  });
  const rawProposal = await executor.execute(
    deepFreeze({
      task,
      canonicalContext,
      procedure: {
        skills: [...MERGE_RECONCILIATION_SKILLS],
        order: "register-assess-synthesize-converge",
      },
    }),
  );
  const proposal = parseProposal(rawProposal, task.workPacket.packetSha256);
  const result = sealResult(job, jobSha256, task.workPacket.packetSha256, proposal);
  const stored = await resultStore.put({
    identity: resultIdentity(job),
    jobSha256,
    resultSha256: result.resultSha256,
    result,
  });
  return validateStoredResult(stored ?? { jobSha256, result }, job, jobSha256);
}

function buildMergeWorkPacket(job, jobSha256) {
  const packetBody = {
    kind: "reconcile-merged-change",
    skill: "converge-documentation",
    inputVersion: job.modelParent.streamVersion,
    inputRefs: [
      job.modelParent.locator,
      ...job.sourceRegistrations.map((source) => source.locator),
    ],
    expectedOutputs: [
      "registered source items",
      "provenance-bound atomic claim decisions",
      "classified inconsistency report",
      "candidate product-model delta",
      "report-only merge receipt",
    ],
    stopConditions: [
      "missing exact merge revision",
      "missing or changed product-model parent",
      "lost source provenance",
      "authority required to adjudicate",
      "request to merge a model or PRD/SRD/POR projection",
    ],
    jobSha256,
  };
  const packetSha256 = sha256(canonicalJson(packetBody));
  return deepFreeze({
    id: job.attemptId,
    projectId: job.projectId,
    workflowId: "merge-reconciliation",
    stepId: "model",
    state: "claimed",
    workPacket: { ...packetBody, packetSha256 },
  });
}

function parseProposal(input, expectedPacketSha256) {
  const root = requireObject(input, "Merge reconciliation proposal");
  exactKeys(root, [
    "schemaVersion",
    "kind",
    "packetSha256",
    "claims",
    "inconsistencies",
  ]);
  if (root.schemaVersion !== 1 || root.kind !== MERGE_RECONCILIATION_PROPOSAL_KIND) {
    throw new Error("Unsupported merge reconciliation proposal contract");
  }
  if (requireSha256(root.packetSha256, "Proposal packet digest") !== expectedPacketSha256) {
    throw new Error("Merge reconciliation proposal is bound to another work packet");
  }
  const claims = requireArray(root.claims, "Proposal claims").map(parseClaim);
  const inconsistencies = requireArray(
    root.inconsistencies,
    "Proposal inconsistencies",
  ).map(parseInconsistency);
  const claimIds = new Set(claims.map((claim) => claim.claimId));
  if (claimIds.size !== claims.length) throw new Error("Proposal claim ids must be unique");
  const conflictIds = new Set(inconsistencies.map((item) => item.conflictId));
  if (conflictIds.size !== inconsistencies.length) {
    throw new Error("Proposal conflict ids must be unique");
  }
  return deepFreeze({ claims, inconsistencies });
}

function sealResult(job, jobSha256, packetSha256, proposal) {
  const sourceIds = new Set(job.sourceRegistrations.map((source) => source.sourceId));
  for (const claim of proposal.claims) {
    if (claim.evidenceIds.some((sourceId) => !sourceIds.has(sourceId))) {
      throw new Error("Proposed claim cites an unregistered source");
    }
  }
  const claimIds = new Set(proposal.claims.map((claim) => claim.claimId));
  for (const finding of proposal.inconsistencies) {
    if (finding.sourceClaimIds.some((claimId) => !claimIds.has(claimId))) {
      throw new Error("Inconsistency cites an unknown proposed claim");
    }
  }
  const candidateBody = {
    modelId: job.modelParent.modelId,
    parentVersion: job.modelParent.version,
    parentSha256: job.modelParent.sha256,
    jobSha256,
    packetSha256,
    sourceRegistrations: job.sourceRegistrations,
    claims: proposal.claims,
    inconsistencies: proposal.inconsistencies,
  };
  const candidateSha256 = sha256(canonicalJson(candidateBody));
  const candidateDelta = deepFreeze({
    status: "candidate",
    modelId: job.modelParent.modelId,
    parentVersion: job.modelParent.version,
    parentSha256: job.modelParent.sha256,
    sha256: candidateSha256,
    locator: `docsfab-candidate:${candidateSha256}`,
  });
  const receiptBody = {
    requestKey: job.requestKey,
    attemptId: job.attemptId,
    jobSha256,
    packetSha256,
    mergeRevision: job.forge.mergeRevision,
    mergeSourceRevision: job.forge.sourceRevision,
    modelParentSha256: job.modelParent.sha256,
    contextBindingSha256: job.contextBindingSha256,
    candidateDeltaSha256: candidateSha256,
    approvalState: "candidate",
    adjudicationAction: "none",
    projectionAction: "none",
  };
  const receiptSha256 = sha256(canonicalJson(receiptBody));
  const receipt = deepFreeze({
    ...receiptBody,
    sha256: receiptSha256,
    locator: `docsfab-receipt:${receiptSha256}`,
  });
  const classificationCounts = Object.fromEntries(
    MERGE_RECONCILIATION_CONFLICT_CLASSIFICATIONS.map((classification) => [
      classification,
      proposal.inconsistencies.filter((item) => item.classification === classification).length,
    ]),
  );
  const confidenceCounts = Object.fromEntries(
    MERGE_RECONCILIATION_CONFLICT_CLASSIFICATIONS.map((classification) => [
      classification,
      Object.fromEntries(["low", "medium", "high"].map((confidence) => [
        confidence,
        proposal.inconsistencies.filter(
          (item) => item.classification === classification && item.confidence === confidence,
        ).length,
      ])),
    ]),
  );
  const resultBody = {
    schemaVersion: 1,
    kind: MERGE_RECONCILIATION_RESULT_KIND,
    jobSha256,
    requestKey: job.requestKey,
    attemptId: job.attemptId,
    workId: job.workId,
    deploymentId: job.deploymentId,
    projectId: job.projectId,
    deploymentEpoch: job.deploymentEpoch,
    contextBindingSha256: job.contextBindingSha256,
    forge: job.forge,
    modelParent: job.modelParent,
    workflow: {
      workflowId: "merge-reconciliation",
      packetSha256,
      skills: [...MERGE_RECONCILIATION_SKILLS],
    },
    sourceRegistrations: job.sourceRegistrations,
    claims: proposal.claims,
    inconsistencies: proposal.inconsistencies,
    candidateDelta,
    receipt,
    measurement: {
      mode: "report-only",
      eligibleMergeEvents: 1,
      reconciliationAttempts: 1,
      findingCount: proposal.inconsistencies.length,
      classificationCounts,
      confidenceCounts,
      selfLoop: { observedEligibleEvents: 1, suppressedEvents: 0, rate: 0 },
      falsePositive: {
        state: "unassessed",
        assessedReports: 0,
        falsePositiveReports: 0,
        rate: null,
      },
    },
    authority: {
      adjudicated: false,
      modelApproved: false,
      projectionMerged: false,
    },
  };
  const result = deepFreeze({
    ...resultBody,
    resultSha256: sha256(canonicalJson(resultBody)),
  });
  return parseMergeReconciliationResult(result);
}

function validateStoredResult(storedInput, job, jobSha256) {
  const stored = requireObject(storedInput, "Stored merge reconciliation result");
  const result = parseMergeReconciliationResult(stored.result ?? stored);
  const identity = resultIdentity(job);
  if (
    (stored.identity !== undefined &&
      resultIdentityKey(parseResultIdentity(stored.identity)) !== resultIdentityKey(identity)) ||
    (stored.jobSha256 !== undefined && stored.jobSha256 !== jobSha256) ||
    result.jobSha256 !== jobSha256 ||
    result.requestKey !== job.requestKey ||
    result.attemptId !== job.attemptId ||
    result.workId !== job.workId ||
    result.projectId !== job.projectId ||
    result.deploymentEpoch !== job.deploymentEpoch ||
    result.forge.mergeRevision !== job.forge.mergeRevision ||
    result.modelParent.sha256 !== job.modelParent.sha256
  ) {
    throw new Error("Stored merge reconciliation result is bound to another job");
  }
  assertResultIdentity(result, identity);
  return result;
}

function resultIdentity(value) {
  return deepFreeze({
    deploymentId: value.deploymentId,
    projectId: value.projectId,
    deploymentEpoch: value.deploymentEpoch,
    attemptId: value.attemptId,
  });
}

function parseResultIdentity(input) {
  const root = requireObject(input, "Merge reconciliation result identity");
  exactKeys(root, ["deploymentId", "projectId", "deploymentEpoch", "attemptId"]);
  return deepFreeze({
    deploymentId: requireIdentifier(root.deploymentId, "Result deployment id"),
    projectId: requireIdentifier(root.projectId, "Result project id"),
    deploymentEpoch: requireIdentifier(root.deploymentEpoch, "Result deployment epoch"),
    attemptId: requireIdentifier(root.attemptId, "Result attempt id"),
  });
}

function resultIdentityKey(identity) {
  return sha256(canonicalJson(parseResultIdentity(identity)));
}

function assertResultIdentity(result, identity) {
  if (
    result.deploymentId !== identity.deploymentId ||
    result.projectId !== identity.projectId ||
    result.deploymentEpoch !== identity.deploymentEpoch ||
    result.attemptId !== identity.attemptId
  ) {
    throw new Error("Stored merge reconciliation result crosses its composite identity");
  }
}

function parseForgeBinding(input) {
  const root = requireObject(input, "Merge reconciliation forge binding");
  exactKeys(root, [
    "deploymentId",
    "projectId",
    "deploymentEpoch",
    "provider",
    "providerHostSha256",
    "providerProjectId",
    "changeId",
    "aggregateId",
    "sourceRevision",
    "mergeRevision",
    "eventSha256",
  ]);
  return deepFreeze({
    deploymentId: requireIdentifier(root.deploymentId, "Forge deployment id"),
    projectId: requireIdentifier(root.projectId, "Forge project id"),
    deploymentEpoch: requireIdentifier(root.deploymentEpoch, "Forge deployment epoch"),
    provider: requireIdentifier(root.provider, "Forge provider"),
    providerHostSha256: requireSha256(root.providerHostSha256, "Forge provider host digest"),
    providerProjectId: requireIdentifier(root.providerProjectId, "Forge provider project id"),
    changeId: requireIdentifier(root.changeId, "Forge change id"),
    aggregateId: requireIdentifier(root.aggregateId, "Forge aggregate id"),
    sourceRevision: requireRevision(root.sourceRevision, "Forge source revision"),
    mergeRevision: requireRevision(root.mergeRevision, "Forge merge revision"),
    eventSha256: requireSha256(root.eventSha256, "Forge event digest"),
  });
}

function parseModelParent(input) {
  const root = requireObject(input, "Product Reference Model parent");
  exactKeys(root, ["modelId", "version", "streamVersion", "sha256", "locator"]);
  if (!Number.isSafeInteger(root.streamVersion) || root.streamVersion < 0) {
    throw new Error("Product Reference Model stream version must be non-negative");
  }
  const sha256Value = requireSha256(root.sha256, "Product Reference Model digest");
  const locator = requireLocator(root.locator, "Product Reference Model locator");
  if (locator !== `docsfab-model:${sha256Value}`) {
    throw new Error("Product Reference Model locator does not match its digest");
  }
  return deepFreeze({
    modelId: requireIdentifier(root.modelId, "Product Reference Model id"),
    version: requireIdentifier(root.version, "Product Reference Model version"),
    streamVersion: root.streamVersion,
    sha256: sha256Value,
    locator,
  });
}

function parseSourceRegistration(input) {
  const root = requireObject(input, "Source registration");
  exactKeys(root, [
    "sourceId",
    "sourceThreadId",
    "itemId",
    "sourceKind",
    "evidenceRole",
    "version",
    "representationId",
    "integritySha256",
    "locator",
  ]);
  if (!["repository-merge", "review", "behavior", "authority-decision"].includes(root.sourceKind)) {
    throw new Error("Source registration has unsupported kind");
  }
  if (!["review", "behavior", "intent", "representation", "authority"].includes(root.evidenceRole)) {
    throw new Error("Source registration has unsupported evidence role");
  }
  if (
    (root.sourceKind === "authority-decision" &&
      !["intent", "representation", "authority"].includes(root.evidenceRole)) ||
    (root.sourceKind !== "authority-decision" &&
      !["review", "behavior"].includes(root.evidenceRole))
  ) throw new Error("Source registration kind and evidence role disagree");
  const version = requireIdentifier(root.version, "Source version");
  if (root.sourceKind === "repository-merge" && !GIT_REVISION.test(version)) {
    throw new Error("Repository merge source requires an exact Git revision");
  }
  const integritySha256 = requireSha256(root.integritySha256, "Source integrity digest");
  const locator = requireLocator(root.locator, "Source locator");
  if (
    locator !== `docsfab-source:${integritySha256}` &&
    locator !== `cas:sha256:${integritySha256}`
  ) {
    throw new Error("Source locator does not match its integrity digest");
  }
  return deepFreeze({
    sourceId: requireIdentifier(root.sourceId, "Source id"),
    sourceThreadId: requireIdentifier(root.sourceThreadId, "Source thread id"),
    itemId: requireIdentifier(root.itemId, "Source item id"),
    sourceKind: root.sourceKind,
    evidenceRole: root.evidenceRole,
    version,
    representationId: requireIdentifier(root.representationId, "Source representation id"),
    integritySha256,
    locator,
  });
}

function parseClaim(input) {
  const root = requireObject(input, "Proposed claim");
  exactKeys(root, [
    "claimId",
    "relationship",
    "action",
    "statement",
    "statementSha256",
    "evidenceIds",
  ]);
  if (!MERGE_RECONCILIATION_RELATIONSHIPS.includes(root.relationship)) {
    throw new Error("Proposed claim has unsupported relationship");
  }
  if (![
    "included",
    "added",
    "superseded",
    "excluded",
    "rescoped",
    "variant",
    "unresolved",
  ].includes(root.action)) {
    throw new Error("Proposed claim has unsupported action");
  }
  const statement = requireSemanticStatement(root.statement);
  const statementSha256 = requireSha256(
    root.statementSha256,
    "Proposed claim statement digest",
  );
  if (sha256(statement) !== statementSha256) {
    throw new Error("Proposed claim statement does not match its digest");
  }
  return deepFreeze({
    claimId: requireIdentifier(root.claimId, "Proposed claim id"),
    relationship: root.relationship,
    action: root.action,
    statement,
    statementSha256,
    evidenceIds: requireArray(root.evidenceIds, "Proposed claim evidence ids").map(
      (value) => requireIdentifier(value, "Proposed claim evidence id"),
    ),
  });
}

function requireSemanticStatement(value) {
  const privateContext = [
    /^\s*(?:system|developer|assistant|user)\s*(?:prompt|message)?\s*:/iu,
    /^\s*persona(?:\s+memory)?\s*:/iu,
    /\b(?:private|hidden|raw|confidential)\s+(?:system\s+)?(?:prompt|persona|memory)\b/iu,
    /\bignore\s+(?:all\s+)?(?:previous|prior)\s+instructions\b/iu,
    /\byou\s+are\s+(?:an?\s+)?(?:ai|assistant|agent)\b/iu,
    /<(?:system|developer|assistant|user)(?:_instruction)?>/iu,
  ];
  // Claims and accountable decisions are stored/rendered as inert one-line prose.
  const inertSemanticText = /[<>\[\]]|!?\[[^\]\r\n]*\]\s*\([^\)\r\n]*\)/u;
  if (
    typeof value !== "string" || value.trim().length === 0 ||
    value !== value.normalize("NFC") || Buffer.byteLength(value, "utf8") > 2_048 ||
    CREDENTIAL.some((pattern) => pattern.test(value)) ||
    PATCH_SHAPES.some((pattern) => pattern.test(value)) ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(value) ||
    inertSemanticText.test(value) ||
    privateContext.some((pattern) => pattern.test(value))
  ) throw new Error("Proposed claim semantic statement is invalid or unsafe");
  return value;
}

function requireDecisionSemanticText(value, label) {
  const text = requireSemanticStatement(value);
  if (text !== text.trim() || Buffer.byteLength(text, "utf8") > 512) {
    throw new Error(`${label} is invalid or unsafe`);
  }
  return text;
}

function renderGovernedDecisionStatement(input) {
  return `Conflict ${input.conflictId}. Decision: ${input.disposition}. Selected claims: ${
    input.selectedClaimIds.length === 0 ? "none" : input.selectedClaimIds.join(", ")
  }. Rationale: ${input.rationale}.${
    input.scope === null ? "" : ` New scope: ${input.scope}.`
  } Decision source: ${input.sourceRegistrationSha256}.`;
}

/** Preserve ordinary Markdown (including relative links), reject private/runtime context. */
function requireProjectionBaseContent(value) {
  const privateContext = [
    /^\s*(?:system|developer|assistant|user)\s*(?:prompt|message)?\s*:/iu,
    /^\s*persona(?:\s+memory)?\s*:/iu,
    /\b(?:private|hidden|raw|confidential)\s+(?:system\s+)?(?:prompt|persona|memory)\b/iu,
    /\bignore\s+(?:all\s+)?(?:previous|prior)\s+instructions\b/iu,
    /\byou\s+are\s+(?:an?\s+)?(?:ai|assistant|agent)\b/iu,
    /<(?:system|developer|assistant|user)(?:_instruction)?>/iu,
  ];
  if (
    typeof value !== "string" || value.length === 0 || value !== value.normalize("NFC") ||
    CREDENTIAL.some((pattern) => pattern.test(value)) || PATCH_SHAPES.some((pattern) => pattern.test(value)) ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value) ||
    privateContext.some((pattern) => pattern.test(value))
  ) throw new Error("Projection base is invalid or unsafe");
  return value;
}

function parseInconsistency(input) {
  const root = requireObject(input, "Inconsistency");
  exactKeys(root, [
    "conflictId",
    "status",
    "classification",
    "sourceClaimIds",
    "resolutionOwner",
    "authorityKind",
    "decisionKind",
    "confidence",
    "confidenceBasisSha256",
    "impact",
    "impactBasisSha256",
    "blocksTargets",
    "safeSummary",
    "variants",
    "detailLocator",
    "adjudication",
  ]);
  if (!MERGE_RECONCILIATION_CONFLICT_CLASSIFICATIONS.includes(root.classification)) {
    throw new Error("Inconsistency has unsupported classification");
  }
  if (root.status !== "open" && root.status !== "deferred") {
    throw new Error("Report-only inconsistency must remain open or deferred");
  }
  if (root.adjudication !== null) {
    throw new Error("Merge reconciliation may not auto-adjudicate an inconsistency");
  }
  return deepFreeze({
    conflictId: requireIdentifier(root.conflictId, "Conflict id"),
    status: root.status,
    classification: root.classification,
    sourceClaimIds: requireArray(root.sourceClaimIds, "Conflict claim ids").map(
      (value) => requireIdentifier(value, "Conflict claim id"),
    ),
    resolutionOwner: requireIdentifier(root.resolutionOwner, "Conflict resolution owner"),
    authorityKind: requireIdentifier(root.authorityKind, "Conflict authority kind"),
    decisionKind: requireEnumeration(
      root.decisionKind,
      ["intent", "scope", "representation", "authority"],
      "Conflict decision kind",
    ),
    confidence: requireEnumeration(
      root.confidence,
      ["low", "medium", "high"],
      "Conflict confidence",
    ),
    confidenceBasisSha256: requireSha256(
      root.confidenceBasisSha256,
      "Conflict confidence basis",
    ),
    impact: requireEnumeration(
      root.impact,
      ["informational", "advisory", "load-bearing"],
      "Conflict impact",
    ),
    impactBasisSha256: requireSha256(root.impactBasisSha256, "Conflict impact basis"),
    blocksTargets: requireArray(root.blocksTargets, "Conflict blocked targets").map(
      (value) => requireIdentifier(value, "Conflict blocked target"),
    ),
    safeSummary: requireSafeSummary(root.safeSummary, "Conflict summary"),
    variants: requireArray(root.variants, "Conflict variants").map((value) => {
      const variant = requireObject(value, "Conflict variant");
      exactKeys(variant, ["claimId", "safeSummary", "evidenceLocators"]);
      const evidenceLocators = requireArray(
        variant.evidenceLocators,
        "Conflict variant evidence",
      ).map((locator) => requireLocator(locator, "Conflict variant evidence locator"));
      if (evidenceLocators.length === 0) throw new Error("Conflict variant requires evidence");
      return deepFreeze({
        claimId: requireIdentifier(variant.claimId, "Conflict variant claim"),
        safeSummary: requireSafeSummary(variant.safeSummary, "Conflict variant summary"),
        evidenceLocators,
      });
    }),
    detailLocator: requireLocator(root.detailLocator, "Conflict detail locator"),
    adjudication: null,
  });
}

function parseWorkflow(input) {
  const root = requireObject(input, "Reconciliation workflow");
  exactKeys(root, ["workflowId", "packetSha256", "skills"]);
  const skills = requireArray(root.skills, "Reconciliation workflow skills").map(
    (value) => requireIdentifier(value, "Reconciliation skill"),
  );
  if (
    root.workflowId !== "merge-reconciliation" ||
    canonicalJson(skills) !== canonicalJson(MERGE_RECONCILIATION_SKILLS)
  ) {
    throw new Error("Reconciliation workflow does not run the required knowledge procedures");
  }
  return deepFreeze({
    workflowId: "merge-reconciliation",
    packetSha256: requireSha256(root.packetSha256, "Reconciliation packet digest"),
    skills,
  });
}

function parseCandidateDelta(input) {
  const root = requireObject(input, "Candidate model delta");
  exactKeys(root, [
    "status",
    "modelId",
    "parentVersion",
    "parentSha256",
    "sha256",
    "locator",
  ]);
  if (root.status !== "candidate") {
    throw new Error("Merge reconciliation may only produce a candidate model delta");
  }
  return deepFreeze({
    status: "candidate",
    modelId: requireIdentifier(root.modelId, "Candidate model id"),
    parentVersion: requireIdentifier(root.parentVersion, "Candidate parent version"),
    parentSha256: requireSha256(root.parentSha256, "Candidate parent digest"),
    sha256: requireSha256(root.sha256, "Candidate delta digest"),
    locator: requireLocator(root.locator, "Candidate delta locator"),
  });
}

function parseReceipt(input) {
  const root = requireObject(input, "Merge reconciliation receipt");
  exactKeys(root, [
    "requestKey",
    "attemptId",
    "jobSha256",
    "packetSha256",
    "mergeRevision",
    "mergeSourceRevision",
    "modelParentSha256",
    "contextBindingSha256",
    "candidateDeltaSha256",
    "approvalState",
    "adjudicationAction",
    "projectionAction",
    "sha256",
    "locator",
  ]);
  if (
    root.approvalState !== "candidate" ||
    root.adjudicationAction !== "none" ||
    root.projectionAction !== "none"
  ) {
    throw new Error("Merge reconciliation receipt exceeds report-only authority");
  }
  return deepFreeze({
    requestKey: requireIdentifier(root.requestKey, "Receipt request key"),
    attemptId: requireIdentifier(root.attemptId, "Receipt attempt id"),
    jobSha256: requireSha256(root.jobSha256, "Receipt job digest"),
    packetSha256: requireSha256(root.packetSha256, "Receipt packet digest"),
    mergeRevision: requireRevision(root.mergeRevision, "Receipt merge revision"),
    mergeSourceRevision: requireRevision(root.mergeSourceRevision, "Receipt source revision"),
    modelParentSha256: requireSha256(root.modelParentSha256, "Receipt model parent digest"),
    contextBindingSha256: requireSha256(
      root.contextBindingSha256,
      "Receipt context-binding digest",
    ),
    candidateDeltaSha256: requireSha256(root.candidateDeltaSha256, "Receipt candidate digest"),
    approvalState: "candidate",
    adjudicationAction: "none",
    projectionAction: "none",
    sha256: requireSha256(root.sha256, "Receipt digest"),
    locator: requireLocator(root.locator, "Receipt locator"),
  });
}

function parseMeasurement(input) {
  const root = requireObject(input, "Merge reconciliation measurement");
  exactKeys(root, [
    "mode",
    "eligibleMergeEvents",
    "reconciliationAttempts",
    "findingCount",
    "classificationCounts",
    "confidenceCounts",
    "selfLoop",
    "falsePositive",
  ]);
  if (root.mode !== "report-only") throw new Error("Pilot measurement must be report-only");
  const classificationCounts = requireObject(
    root.classificationCounts,
    "Inconsistency classification counts",
  );
  exactKeys(classificationCounts, MERGE_RECONCILIATION_CONFLICT_CLASSIFICATIONS);
  const parsedCounts = Object.fromEntries(
    MERGE_RECONCILIATION_CONFLICT_CLASSIFICATIONS.map((classification) => [
      classification,
      requireNonnegativeInteger(classificationCounts[classification], `${classification} count`),
    ]),
  );
  const confidenceCounts = requireObject(
    root.confidenceCounts,
    "Inconsistency confidence counts",
  );
  exactKeys(confidenceCounts, MERGE_RECONCILIATION_CONFLICT_CLASSIFICATIONS);
  const parsedConfidenceCounts = Object.fromEntries(
    MERGE_RECONCILIATION_CONFLICT_CLASSIFICATIONS.map((classification) => {
      const counts = requireObject(confidenceCounts[classification], `${classification} confidence counts`);
      exactKeys(counts, ["low", "medium", "high"]);
      return [classification, Object.fromEntries(
        ["low", "medium", "high"].map((confidence) => [
          confidence,
          requireNonnegativeInteger(counts[confidence], `${classification} ${confidence} count`),
        ]),
      )];
    }),
  );
  const selfLoop = requireObject(root.selfLoop, "Self-loop measurement");
  exactKeys(selfLoop, ["observedEligibleEvents", "suppressedEvents", "rate"]);
  const falsePositive = requireObject(root.falsePositive, "False-positive measurement");
  exactKeys(falsePositive, ["state", "assessedReports", "falsePositiveReports", "rate"]);
  if (falsePositive.state !== "unassessed" || falsePositive.rate !== null) {
    throw new Error("Library result cannot claim a live false-positive assessment");
  }
  return deepFreeze({
    mode: "report-only",
    eligibleMergeEvents: requirePositiveInteger(root.eligibleMergeEvents, "Eligible merge events"),
    reconciliationAttempts: requirePositiveInteger(
      root.reconciliationAttempts,
      "Reconciliation attempts",
    ),
    findingCount: requireNonnegativeInteger(root.findingCount, "Finding count"),
    classificationCounts: parsedCounts,
    confidenceCounts: parsedConfidenceCounts,
    selfLoop: {
      observedEligibleEvents: requirePositiveInteger(
        selfLoop.observedEligibleEvents,
        "Observed eligible events",
      ),
      suppressedEvents: requireNonnegativeInteger(
        selfLoop.suppressedEvents,
        "Self-loop suppressed events",
      ),
      rate: requireRate(selfLoop.rate, "Self-loop rate"),
    },
    falsePositive: {
      state: "unassessed",
      assessedReports: requireNonnegativeInteger(
        falsePositive.assessedReports,
        "Assessed reports",
      ),
      falsePositiveReports: requireNonnegativeInteger(
        falsePositive.falsePositiveReports,
        "False-positive reports",
      ),
      rate: null,
    },
  });
}

function parseAuthorityBoundary(input) {
  const root = requireObject(input, "Merge reconciliation authority boundary");
  exactKeys(root, ["adjudicated", "modelApproved", "projectionMerged"]);
  if (
    root.adjudicated !== false ||
    root.modelApproved !== false ||
    root.projectionMerged !== false
  ) {
    throw new Error("Merge reconciliation result exceeds candidate authority");
  }
  return deepFreeze({ adjudicated: false, modelApproved: false, projectionMerged: false });
}

/**
 * Materialize one bounded semantic candidate and projections from a governed
 * merge/adjudication input. The adapter has no publication port: it can only
 * return immutable candidate bytes and a receipt for the host to gate and
 * place under a fenced integration-owner proposal.
 */
export function materializeGovernedConvergence(input) {
  const job = parseGovernedConvergenceJob(input);
  const jobSha256 = sha256(canonicalJson(job));
  const decisionRegistrationSha256s = job.decisionSources.map(
    (source) => source.registrationSha256,
  );
  const modelBody = {
    schemaVersion: 1,
    kind: PRODUCT_REFERENCE_MODEL_CANDIDATE_KIND,
    modelId: job.modelParent.modelId,
    version: `candidate-${job.modelParent.streamVersion + 1}-${jobSha256.slice(0, 16)}`,
    streamVersion: job.modelParent.streamVersion + 1,
    parent: job.modelParent,
    merge: job.forge,
    sourceFrontier: job.sourceFrontier,
    semanticDelta: job.semanticDelta,
    decisionRegistrationSha256s,
    semanticContent: {
      sourceRegistrations: job.sourceRegistrations,
      claims: job.claims,
      decisions: job.decisions,
    },
    state: "candidate",
    approved: false,
  };
  const modelSha256 = sha256(canonicalJson(modelBody));
  const model = {
    ...modelBody,
    sha256: modelSha256,
    locator: `docsfab-model:${modelSha256}`,
  };
  const entries = job.projectionBases.map((base) => {
    const target = base.target;
    const provenance = [
      "<!-- docsfab:product-reference-model:start -->",
      "## Product Reference Model projection",
      "",
      `- Candidate model: \`${modelSha256}\``,
      `- Semantic delta: \`${job.semanticDelta.sha256}\``,
      `- Merge revision: \`${job.forge.mergeRevision}\``,
      `- Source frontier: \`${job.sourceFrontier.sha256}\``,
      `- Decision sources: ${decisionRegistrationSha256s.length === 0
        ? "none"
        : decisionRegistrationSha256s.map((digest) => `\`${digest}\``).join(", ")}`,
      `- Original source registrations: ${job.sourceRegistrations.map((source) =>
        `\`${source.sourceId}\``).join(", ")}`,
      "- Status: candidate; generated content is not independent semantic evidence",
      "",
      "### Converged semantic claims",
      ...(job.claims.length === 0
        ? ["- None recorded for this merge."]
        : job.claims.map((claim) =>
          `- \`${claim.claimId}\`: ${claim.action} (${claim.relationship}); ${claim.statement}`)),
      "",
      "### Accountable decisions",
      ...(job.decisions.length === 0
        ? ["- No accountable decision was required."]
        : job.decisions.map((decision) =>
          `- \`${decision.conflictId}\`: ${decision.disposition}; selected claims ${
            decision.selectedClaimIds.length === 0
              ? "none"
              : decision.selectedClaimIds.map((claimId) => `\`${claimId}\``).join(", ")
          }; ${decision.statement}`)),
      "<!-- docsfab:product-reference-model:end -->",
    ].join("\n");
    const marker = /<!-- docsfab:product-reference-model:start -->[\s\S]*?<!-- docsfab:product-reference-model:end -->/u;
    const content = marker.test(base.content)
      ? base.content.replace(marker, provenance)
      : `${base.content.replace(/\s*$/u, "")}\n\n${provenance}\n`;
    const contentSha256 = sha256(content);
    return {
      target,
      path: base.path,
      operation: "replace",
      mediaType: "text/markdown",
      sourceModelSha256: modelSha256,
      baseSha256: base.sha256,
      content,
      contentSha256,
      locator: `docsfab-candidate:${contentSha256}`,
      semanticEvidence: false,
      selfTriggerEligible: false,
    };
  });
  const projectionsBody = {
    schemaVersion: 1,
    kind: PRODUCT_REFERENCE_PROJECTION_SET_KIND,
    sourceModelSha256: modelSha256,
    entries,
  };
  const projectionsSha256 = sha256(canonicalJson(projectionsBody));
  const projections = {
    ...projectionsBody,
    sha256: projectionsSha256,
    locator: `docsfab-candidate:${projectionsSha256}`,
  };
  const receiptBody = {
    schemaVersion: 1,
    kind: GOVERNED_CONVERGENCE_KNOWLEDGE_RECEIPT_KIND,
    convergenceId: job.convergenceId,
    attemptId: job.attemptId,
    attemptKey: job.attemptKey,
    jobSha256,
    modelSha256,
    projectionsSha256,
  };
  const receiptSha256 = sha256(canonicalJson(receiptBody));
  const output = {
    jobSha256,
    model,
    projections,
    receipt: {
      ...receiptBody,
      sha256: receiptSha256,
      locator: `docsfab-receipt:${receiptSha256}`,
    },
  };
  rejectUnsafe(output);
  return deepFreeze(output);
}

export function parseGovernedConvergenceJob(input) {
  const root = requireObject(input, "Governed convergence knowledge job");
  exactKeys(root, [
    "schemaVersion", "kind", "convergenceId", "deploymentId", "projectId",
    "deploymentEpoch", "attemptId", "attemptKey", "forge", "sourceFrontier",
    "modelParent", "semanticDelta", "sourceRegistrations", "originalClaims", "claims", "loadBearingFindings",
    "decisionSources", "decisions",
    "affectedProjectionTargets",
    "projectionBases",
  ]);
  if (
    root.schemaVersion !== GOVERNED_CONVERGENCE_RUNTIME_VERSION ||
    root.kind !== GOVERNED_CONVERGENCE_JOB_KIND
  ) throw new Error("Unsupported governed convergence job contract");
  const forge = requireObject(root.forge, "Governed convergence forge binding");
  exactKeys(forge, [
    "provider", "providerHostSha256", "providerProjectId", "sourceRevision",
    "mergeRevision", "eventSha256", "eventSequence", "targetBranch",
  ]);
  const sourceFrontier = requireObject(
    root.sourceFrontier,
    "Governed convergence source frontier",
  );
  exactKeys(sourceFrontier, ["eventSequence", "sha256"]);
  const modelParent = requireObject(root.modelParent, "Governed convergence model parent");
  exactKeys(modelParent, ["modelId", "version", "streamVersion", "sha256", "locator"]);
  const semanticDelta = requireObject(root.semanticDelta, "Governed semantic delta");
  exactKeys(semanticDelta, ["kind", "sha256", "locator", "resultSha256"]);
  const parseGovernedClaim = (claimInput) => {
    const claim = requireObject(claimInput, "Governed semantic claim");
    exactKeys(claim, [
      "claimId", "relationship", "action", "statementSha256", "evidenceIds",
      "statement",
    ]);
    const statement = requireSemanticStatement(claim.statement);
    const statementSha256 = requireSha256(claim.statementSha256, "Claim statement digest");
    if (sha256(statement) !== statementSha256) {
      throw new Error("Claim semantic statement does not match its digest");
    }
    return {
      claimId: requireIdentifier(claim.claimId, "Claim id"),
      relationship: requireEnumeration(
        claim.relationship,
        MERGE_RECONCILIATION_RELATIONSHIPS,
        "Claim relationship",
      ),
      action: requireEnumeration(claim.action, [
        "included", "added", "superseded", "excluded", "rescoped", "variant", "unresolved",
      ], "Claim action"),
      statement,
      statementSha256,
      evidenceIds: requireArray(claim.evidenceIds, "Claim evidence ids")
        .map((evidenceId) => requireIdentifier(evidenceId, "Claim evidence id")),
    };
  };
  const originalClaims = requireArray(
    root.originalClaims,
    "Original merge-report claims",
  ).map(parseGovernedClaim);
  const claims = requireArray(root.claims, "Governed semantic claims").map(parseGovernedClaim);
  if (new Set(originalClaims.map((claim) => claim.claimId)).size !== originalClaims.length) {
    throw new Error("Original merge-report claim ids must be unique");
  }
  const sourceRegistrations = requireArray(
    root.sourceRegistrations,
    "Original merge-report source registrations",
  ).map(parseSourceRegistration);
  const sourceIds = new Set(sourceRegistrations.map((source) => source.sourceId));
  if (
    sourceRegistrations.length === 0 || sourceIds.size !== sourceRegistrations.length ||
    !sourceRegistrations.some((source) =>
      source.sourceKind === "repository-merge" && source.version === forge.mergeRevision &&
      source.integritySha256 === forge.eventSha256)
  ) throw new Error("Original merge-report source registrations are not bound to the merge");
  for (const claim of [...originalClaims, ...claims]) {
    if (
      new Set(claim.evidenceIds).size !== claim.evidenceIds.length ||
      claim.evidenceIds.some((sourceId) => !sourceIds.has(sourceId))
    ) throw new Error("Governed claim evidence is not bound to an original source registration");
  }
  const decisionSources = requireArray(
    root.decisionSources,
    "Governed convergence decision sources",
  ).map((sourceInput) => {
    const source = requireObject(sourceInput, "Governed convergence decision source");
    exactKeys(source, ["sourceId", "registrationSha256"]);
    return {
      sourceId: requireIdentifier(source.sourceId, "Decision source id"),
      registrationSha256: requireSha256(
        source.registrationSha256,
        "Decision source registration digest",
      ),
    };
  });
  const decisions = requireArray(root.decisions, "Governed accountable decisions")
    .map((decisionInput) => {
      const decision = requireObject(decisionInput, "Governed accountable decision");
      exactKeys(decision, [
        "conflictId", "disposition", "selectedClaimIds", "rationale", "rationaleSha256",
        "scope", "scopeSha256", "sourceRegistrationSha256", "statement", "statementContentSha256",
      ]);
      const conflictId = requireIdentifier(decision.conflictId, "Decision conflict id");
      const disposition = requireEnumeration(
        decision.disposition,
        ["accept-variant", "supersede-variant", "rescope", "retain-variants", "defer"],
        "Decision disposition",
      );
      const selectedClaimIds = requireArray(decision.selectedClaimIds, "Selected claim ids")
        .map((claimId) => requireIdentifier(claimId, "Selected claim id"));
      const rationale = requireDecisionSemanticText(decision.rationale, "Decision rationale");
      const scope = decision.scope === null
        ? null
        : requireDecisionSemanticText(decision.scope, "Decision scope");
      const rationaleSha256 = requireSha256(decision.rationaleSha256, "Decision rationale digest");
      const scopeSha256 = decision.scopeSha256 === null
        ? null
        : requireSha256(decision.scopeSha256, "Decision scope digest");
      const sourceRegistrationSha256 = requireSha256(
        decision.sourceRegistrationSha256,
        "Decision source registration digest",
      );
      const statement = requireSemanticStatement(decision.statement);
      if (
        rationaleSha256 !== sha256(rationale) ||
        (disposition === "rescope") !== (scope !== null) ||
        (scope === null) !== (scopeSha256 === null) ||
        (scope !== null && scopeSha256 !== sha256(scope)) ||
        statement !== renderGovernedDecisionStatement({
          conflictId,
          disposition,
          selectedClaimIds,
          rationale,
          scope,
          sourceRegistrationSha256,
        }) ||
        decision.statementContentSha256 !== sha256(statement)
      ) {
        throw new Error("Decision semantic statement is invalid");
      }
      return {
        conflictId,
        disposition,
        selectedClaimIds,
        rationale,
        rationaleSha256,
        scope,
        scopeSha256,
        sourceRegistrationSha256,
        statement,
        statementContentSha256: requireSha256(
          decision.statementContentSha256,
          "Decision semantic statement digest",
        ),
      };
    });
  const loadBearingFindings = requireArray(
    root.loadBearingFindings,
    "Original load-bearing findings",
  ).map((findingInput) => {
    const finding = requireObject(findingInput, "Original load-bearing finding");
    exactKeys(finding, ["conflictId", "sourceClaimIds"]);
    const sourceClaimIds = requireArray(finding.sourceClaimIds, "Original finding claim ids")
      .map((claimId) => requireIdentifier(claimId, "Original finding claim id"));
    if (
      sourceClaimIds.length === 0 ||
      new Set(sourceClaimIds).size !== sourceClaimIds.length ||
      sourceClaimIds.some((claimId) => !originalClaims.some((claim) => claim.claimId === claimId))
    ) throw new Error("Original load-bearing finding does not cite a merge-report claim");
    return { conflictId: requireIdentifier(finding.conflictId, "Original conflict id"), sourceClaimIds };
  });
  if (new Set(loadBearingFindings.map((finding) => finding.conflictId)).size !== loadBearingFindings.length) {
    throw new Error("Original load-bearing finding ids must be unique");
  }
  const affectedProjectionTargets = requireArray(
    root.affectedProjectionTargets,
    "Affected projection targets",
  ).map((target) => requireEnumeration(
    target,
    PRODUCT_REFERENCE_PROJECTION_TARGETS,
    "Affected projection target",
  ));
  if (
    affectedProjectionTargets.length === 0 ||
    new Set(affectedProjectionTargets).size !== affectedProjectionTargets.length ||
    canonicalJson(affectedProjectionTargets) !==
      canonicalJson([...affectedProjectionTargets].sort())
  ) throw new Error("Affected projection targets must be a non-empty sorted set");
  if (new Set(decisionSources.map((source) => source.sourceId)).size !== decisionSources.length) {
    throw new Error("Decision source ids must be unique");
  }
  const projectionBases = requireArray(
    root.projectionBases,
    "Projection bases",
  ).map((baseInput) => {
    const base = requireObject(baseInput, "Projection base");
    exactKeys(base, ["target", "path", "mediaType", "content", "sha256"]);
    const target = requireEnumeration(
      base.target,
      PRODUCT_REFERENCE_PROJECTION_TARGETS,
      "Projection base target",
    );
    const expectedPath = {
      "product-requirements": "planning/product-requirements.md",
      "software-requirements": "planning/software-requirements.md",
      "plan-of-record": "planning/plan-of-record.md",
    }[target];
    if (
      base.path !== expectedPath || base.mediaType !== "text/markdown" ||
      !requireProjectionBaseContent(base.content) ||
      base.sha256 !== sha256(base.content)
    ) throw new Error("Projection base is invalid");
    return {
      target,
      path: expectedPath,
      mediaType: "text/markdown",
      content: base.content,
      sha256: base.sha256,
    };
  });
  if (
    canonicalJson(projectionBases.map((base) => base.target)) !==
      canonicalJson(affectedProjectionTargets)
  ) throw new Error("Projection bases do not match affected targets");
  const parsed = {
    schemaVersion: 1,
    kind: GOVERNED_CONVERGENCE_JOB_KIND,
    convergenceId: requireIdentifier(root.convergenceId, "Convergence id"),
    deploymentId: requireIdentifier(root.deploymentId, "Deployment id"),
    projectId: requireIdentifier(root.projectId, "Project id"),
    deploymentEpoch: requireIdentifier(root.deploymentEpoch, "Deployment epoch"),
    attemptId: requireIdentifier(root.attemptId, "Convergence attempt id"),
    attemptKey: requireIdentifier(root.attemptKey, "Convergence attempt key"),
    forge: {
      provider: requireIdentifier(forge.provider, "Forge provider"),
      providerHostSha256: requireSha256(forge.providerHostSha256, "Forge host digest"),
      providerProjectId: requireIdentifier(forge.providerProjectId, "Forge project id"),
      sourceRevision: requireRevision(forge.sourceRevision, "Source revision"),
      mergeRevision: requireRevision(forge.mergeRevision, "Merge revision"),
      eventSha256: requireSha256(forge.eventSha256, "Forge event digest"),
      eventSequence: requirePositiveInteger(forge.eventSequence, "Forge event sequence"),
      targetBranch: requireIdentifier(forge.targetBranch, "Target branch"),
    },
    sourceFrontier: {
      eventSequence: requirePositiveInteger(
        sourceFrontier.eventSequence,
        "Source frontier sequence",
      ),
      sha256: requireSha256(sourceFrontier.sha256, "Source frontier digest"),
    },
    modelParent: {
      modelId: requireIdentifier(modelParent.modelId, "Model id"),
      version: requireIdentifier(modelParent.version, "Model version"),
      streamVersion: requirePositiveInteger(modelParent.streamVersion, "Model stream version"),
      sha256: requireSha256(modelParent.sha256, "Model digest"),
      locator: requireLocator(modelParent.locator, "Model locator"),
    },
    semanticDelta: {
      kind: requireEnumeration(
        semanticDelta.kind,
        ["merge-candidate", "adjudicated-candidate"],
        "Semantic delta kind",
      ),
      sha256: requireSha256(semanticDelta.sha256, "Semantic delta digest"),
      locator: requireLocator(semanticDelta.locator, "Semantic delta locator"),
      resultSha256: requireSha256(semanticDelta.resultSha256, "Semantic result digest"),
    },
    sourceRegistrations,
    originalClaims,
    claims,
    loadBearingFindings,
    decisionSources,
    decisions,
    affectedProjectionTargets,
    projectionBases,
  };
  if (parsed.sourceFrontier.eventSequence < parsed.forge.eventSequence) {
    throw new Error("Source frontier predates the causal merge");
  }
  if (
    parsed.semanticDelta.kind === "merge-candidate" && decisionSources.length !== 0
  ) throw new Error("Merge-only convergence must not contain decision sources");
  if (
    parsed.semanticDelta.kind === "adjudicated-candidate" && decisionSources.length === 0
  ) throw new Error("Adjudicated convergence requires registered decision sources");
  if (
    decisions.length !== decisionSources.length ||
    canonicalJson(decisions.map((decision) => decision.sourceRegistrationSha256).sort()) !==
      canonicalJson(decisionSources.map((source) => source.registrationSha256).sort())
  ) throw new Error("Accountable decisions must match registered decision sources");
  if (parsed.semanticDelta.kind === "merge-candidate") {
    if (parsed.loadBearingFindings.length !== 0 || parsed.decisions.length !== 0) {
      throw new Error("Merge-only convergence cannot settle a load-bearing finding");
    }
  } else {
    if (
      parsed.decisions.length !== parsed.loadBearingFindings.length ||
      new Set(parsed.decisions.map((decision) => decision.conflictId)).size !==
        parsed.decisions.length ||
      canonicalJson([...new Set(parsed.decisions.map((decision) => decision.conflictId))].sort()) !==
        canonicalJson(parsed.loadBearingFindings.map((finding) => finding.conflictId).sort()) ||
      parsed.decisions.some((decision) => {
        const finding = parsed.loadBearingFindings.find(
          (candidate) => candidate.conflictId === decision.conflictId,
        );
        return !finding ||
        decision.disposition === "defer" ||
        decision.selectedClaimIds.some((claimId) =>
          !finding.sourceClaimIds.includes(claimId)) ||
        (["accept-variant", "supersede-variant"].includes(decision.disposition) &&
          decision.selectedClaimIds.length !== 1) ||
        (["rescope", "retain-variants"].includes(decision.disposition) &&
          decision.selectedClaimIds.length !== 0) ||
        ((decision.disposition === "rescope") !== (decision.scopeSha256 !== null));
      })
    ) throw new Error("Accountable decisions do not close the original load-bearing frontier");
  }
  const expectedClaims = applyGovernedAccountableDecisions(
    parsed.originalClaims,
    parsed.loadBearingFindings,
    parsed.decisions,
  );
  if (canonicalJson(parsed.claims) !== canonicalJson(expectedClaims)) {
    throw new Error("Governed semantic claims do not apply accountable decisions");
  }
  rejectUnsafe(parsed);
  return deepFreeze(parsed);
}

function applyGovernedAccountableDecisions(originalClaims, findings, decisions) {
  let claims = originalClaims;
  for (const decision of decisions) {
    const finding = findings.find((candidate) => candidate.conflictId === decision.conflictId);
    if (!finding) {
      throw new Error("Ordered accountable decision frontier is incomplete");
    }
    const cited = new Set(finding.sourceClaimIds);
    claims = claims.map((claim) => {
      if (!cited.has(claim.claimId)) return claim;
      switch (decision.disposition) {
        case "rescope":
          return { ...claim, action: "rescoped" };
        case "retain-variants":
        case "defer":
          return { ...claim, action: "variant" };
        case "accept-variant":
          return {
            ...claim,
            action: decision.selectedClaimIds.includes(claim.claimId) ? "included" : "superseded",
          };
        case "supersede-variant":
          return {
            ...claim,
            action: decision.selectedClaimIds.includes(claim.claimId) ? "superseded" : "included",
          };
        default:
          throw new Error("Unsupported accountable decision disposition");
      }
    });
  }
  return claims;
}

function requireMethods(value, methods, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  for (const method of methods) {
    if (typeof value[method] !== "function") throw new Error(`${label} is missing ${method}()`);
  }
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  assertCanonicalDataTree(value, new Set(), label);
  return value;
}

function requireArray(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  assertCanonicalDataTree(value, new Set(), label);
  return value;
}

function assertCanonicalDataTree(value, seen, label) {
  if (value === undefined) throw new Error(`${label} must not contain undefined values`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new Error(`${label} must contain canonical finite numbers`);
    }
    return;
  }
  if (typeof value !== "object" || isProxy(value)) {
    throw new Error(`${label} must be inert plain data`);
  }
  if (seen.has(value)) throw new Error(`${label} must not contain cycles`);
  const arrayValue = Array.isArray(value);
  const proto = Object.getPrototypeOf(value);
  if (
    (arrayValue && proto !== Array.prototype) ||
    (!arrayValue && proto !== Object.prototype)
  ) {
    throw new Error(`${label} must be inert plain data`);
  }
  seen.add(value);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key === "symbol")) {
    throw new Error(`${label} must not contain symbol fields`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (arrayValue) {
    if (
      keys.length !== value.length + 1 ||
      !Object.prototype.hasOwnProperty.call(descriptors, "length")
    ) {
      throw new Error(`${label} arrays must be dense and index-only`);
    }
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(descriptors, String(index))) {
        throw new Error(`${label} arrays must be dense and index-only`);
      }
    }
  } else if (Object.prototype.hasOwnProperty.call(descriptors, "toJSON")) {
    throw new Error(`${label} must not define toJSON`);
  }
  for (const descriptor of Object.values(descriptors)) {
    if (!("value" in descriptor)) throw new Error(`${label} must not contain accessors`);
    if ((!arrayValue || descriptor !== descriptors.length) && descriptor.enumerable !== true) {
      throw new Error(`${label} must not contain non-enumerable data`);
    }
    assertCanonicalDataTree(descriptor.value, seen, label);
  }
  seen.delete(value);
}

function exactKeys(value, expected) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error("Contract contains missing or unexpected fields");
  }
}

function requireIdentifier(value, label) {
  if (typeof value !== "string" || !SAFE_IDENTIFIER.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function requireSafeSummary(value, label) {
  if (
    typeof value !== "string" || value.length < 1 || value.length > 512 ||
    value !== value.normalize("NFC") || CREDENTIAL.some((pattern) => pattern.test(value)) ||
    /[\u0000-\u001f\u007f<>`]/u.test(value) || /https?:\/\//iu.test(value)
  ) throw new Error(`${label} is invalid`);
  return value;
}

function requireEnumeration(value, allowed, label) {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function requireSha256(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function requireRevision(value, label) {
  if (typeof value !== "string" || !GIT_REVISION.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function requireLocator(value, label) {
  if (typeof value !== "string" || !GOVERNED_LOCATOR.test(value)) {
    throw new Error(`${label} must be a governed content-addressed locator`);
  }
  return value;
}

function requireNonnegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} is invalid`);
  return value;
}

function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} is invalid`);
  return value;
}

function requireRate(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function rejectUnsafe(value) {
  let unsafe = false;
  const visit = (candidate) => {
    if (typeof candidate === "string") {
      if (
        CREDENTIAL.some((pattern) => pattern.test(candidate)) ||
        PATCH_SHAPES.some((pattern) => pattern.test(candidate))
      ) unsafe = true;
      return;
    }
    if (candidate === null || typeof candidate !== "object") return;
    if (Array.isArray(candidate)) {
      for (const child of candidate) visit(child);
      return;
    }
    for (const [key, child] of Object.entries(candidate)) {
      visit(key);
      visit(child);
    }
  };
  visit(value);
  if (unsafe) {
    throw new Error("Merge reconciliation contract contains unsafe content");
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

// Cross-package receipt seam: byte ordering matches host/src/contract-dialect.ts,
// and a host integration test executes this adapter to catch drift.
function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
