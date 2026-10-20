// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { canonicalDigest, canonicalJson } from "../content-ir/canonical.js";
import { deepFreeze } from "../contract-kit/freeze.js";
import {
  decodeDocumentationMaturityCascadeAssessment,
  decodeDocumentationMaturityCascadeSelection,
  decodeDocumentationMaturityCascadeTrackerObservation,
  type DocumentationMaturityCascadeAssessmentV1,
  type DocumentationMaturityCascadeSelectionV1,
  type DocumentationMaturityCascadeTrackerObservationV1,
} from "../maturity/cascade.js";
import type { DocumentationMaturityWorkUnitV1 } from "../maturity/contracts.js";
import { decodeRepositoryDiscoveryInventory } from "../repository/inventory.js";
import type { RepositoryDiscoveryInventoryV1 } from "../repository/inventory.js";
import { detectCredentialRuleIdsInValue } from "../security/repository-scanner.js";
import { roadmapDigest } from "../roadmap/contracts/decode.js";
import { validateRoadmapLedger } from "../roadmap/contracts/ledger.js";
import { validateRoadmapMutationPlanV2 } from "../roadmap/execution-v2.js";
import {
  assertMaterialForOperation,
  validateIssueLifecycleMaterialBundle,
} from "../roadmap/issue-adapter.js";
import {
  assertAuthenticAutoRoadmapPlanningResultV1,
  type AutoRoadmapPlanningResultV1,
} from "./roadmap-planning.js";
import { restoreAutoRoadmapExecutionPlanV1 } from "./roadmap.js";
import { bindableCycleWorkflow } from "../workflow-registry/catalog.js";
import * as workflowCatalog from "../workflow-registry/catalog.js";
import {
  decodeAutoAssessment,
  decodeAutoCycleRequest,
  decodeWorkflowDecision,
  type AutoAssessmentV1,
  type AutoCycleDeliveryMode,
  type AutoCycleRequestV1,
  type WorkflowDecisionV1,
} from "./contracts.js";

export const AUTO_DRY_RUN_SCHEMA_VERSION = 1 as const;

export interface AutoDryRunSourceV1 {
  repositoryPath: string;
  targetBranch: string;
  draftMergeRequestDestination: {
    provider: "gitlab";
    projectIdentitySha256: string;
    targetBranch: string;
  };
  inventory: RepositoryDiscoveryInventoryV1;
  request: AutoCycleRequestV1;
  assessment: AutoAssessmentV1;
  decision: WorkflowDecisionV1;
  maturityAssessment: DocumentationMaturityCascadeAssessmentV1;
  maturityTrackerObservation: DocumentationMaturityCascadeTrackerObservationV1;
  maturitySelection: DocumentationMaturityCascadeSelectionV1;
  managedTrackerObservationSha256: string;
  repositoryContentDigest: string;
}

/** Authenticated planning result consumed by the preview projection. */
export type AutoDryRunRoadmapProjectionV1 = AutoRoadmapPlanningResultV1;

export interface AutoDryRunRoadmapPlanner {
  plan(source: AutoDryRunSourceV1): Promise<AutoDryRunRoadmapProjectionV1>;
}

export interface AutoDryRunEvidenceV1 {
  id: string;
  kind:
    | "repository-inventory"
    | "maturity-finding"
    | "tracker-observation"
    | "workflow-prerequisite"
    | "roadmap-plan";
  sha256: string;
  paths: string[];
}

export interface AutoDryRunWorkflowDecisionPreviewV1 {
  disposition: WorkflowDecisionV1["disposition"];
  workflow: WorkflowDecisionV1["workflow"];
  reasonCode: string;
  confidence: "high" | "bounded" | "needs-input" | "blocked";
  deliveryMode: AutoCycleDeliveryMode | null;
  evidenceIds: string[];
  dependencies: Array<{
    id: string;
    state: "satisfied" | "missing" | "conflicting" | "blocked";
    evidenceIds: string[];
  }>;
  pathScope: string[];
  expectedValidation: string[];
  openInputIds: string[];
  requestSha256: string | null;
  assessmentSha256: string | null;
  decisionSha256: string | null;
}

export interface AutoDryRunOperationPreviewV1 {
  key: string;
  action:
    | "create"
    | "reuse"
    | "update"
    | "link"
    | "supersede"
    | "investigate"
    | "deferred"
    | "draft-mr";
  target: {
    kind: "issue" | "draft-merge-request";
    identitySha256: string;
    issueIid: number | null;
    targetBranch: string | null;
    sourceBranch: string | null;
  };
  evidenceIds: string[];
  performsMutation: false;
}

export interface AutoDryRunResultV1 {
  schemaVersion: typeof AUTO_DRY_RUN_SCHEMA_VERSION;
  kind: "docsfab-auto-dry-run";
  readOnly: true;
  authorization: null;
  repository: {
    path: string;
    targetBranch: string | null;
    identitySha256: string;
    revision: string;
    inventorySha256: string;
    inventoryStatus: "complete" | "incomplete";
  };
  tracker: null | {
    projectIdentitySha256: string;
    observationSha256: string;
    observedAt: string;
    authority: "observe-only";
  };
  assessment: {
    maturityAssessmentSha256: string | null;
    maturitySelectionSha256: string | null;
    selectedWorkUnitFingerprint: string | null;
  };
  cycle: null | {
    request: AutoCycleRequestV1;
    assessment: AutoAssessmentV1;
    decision: WorkflowDecisionV1;
  };
  decision: AutoDryRunWorkflowDecisionPreviewV1;
  evidence: AutoDryRunEvidenceV1[];
  operations: AutoDryRunOperationPreviewV1[];
  draftMergeRequestDestination: AutoDryRunSourceV1["draftMergeRequestDestination"] | null;
  roadmapPlanSha256: string | null;
  resultSha256: string;
  nextAction: string;
}

export interface AutoDryRunNeedsInputV1 {
  repositoryPath: string;
  repository: {
    identitySha256: string;
    revision: string;
  };
  inventory: RepositoryDiscoveryInventoryV1;
  reasonCode: string;
  openInputIds: string[];
  targetBranch: string | null;
  draftMergeRequestDestination: AutoDryRunSourceV1["draftMergeRequestDestination"] | null;
}

export class AutoDryRunError extends Error {
  public constructor(
    public readonly code:
      | "invalid-source"
      | "binding-mismatch"
      | "unsafe-output"
      | "invalid-roadmap-preview",
  ) {
    super(`Autonomous dry-run rejected: ${code}.`);
    this.name = "AutoDryRunError";
  }
}

export async function createAutoDryRun(
  sourceValue: AutoDryRunSourceV1,
  planner?: AutoDryRunRoadmapPlanner,
): Promise<AutoDryRunResultV1> {
  const source = validateSource(sourceValue);
  const request = decodeAutoCycleRequest(source.request, workflowCatalog);
  const assessment = decodeAutoAssessment(source.assessment, request, workflowCatalog);
  const decision = decodeWorkflowDecision(source.decision, request, assessment, workflowCatalog);
  const maturityAssessment = decodeDocumentationMaturityCascadeAssessment(
    source.maturityAssessment,
  );
  const tracker = decodeDocumentationMaturityCascadeTrackerObservation(
    source.maturityTrackerObservation,
  );
  const selection = decodeDocumentationMaturityCascadeSelection(source.maturitySelection);
  const inventory = decodeRepositoryDiscoveryInventory(source.inventory);
  assertBindings({
    source,
    request,
    assessment,
    decision,
    maturityAssessment,
    tracker,
    selection,
    inventory,
  });

  const selectedWorkUnit =
    selection.outcome.state === "selected" ? selection.outcome.workUnit : null;
  const selectedCandidate =
    decision.disposition === "execute"
      ? assessment.candidates.find((item) => item.candidateSha256 === decision.candidateSha256)
      : undefined;
  if (
    (decision.disposition === "execute") !== Boolean(selectedCandidate) ||
    (selectedCandidate &&
      (!selectedWorkUnit ||
        selectedCandidate.workflow !== bindableCycleWorkflow(selectedWorkUnit.workflow.name) ||
        !selectedCandidate.maturityFindingFingerprints.includes(
          selectedWorkUnit.findingFingerprint,
        )))
  )
    bindingMismatch();

  if (decision.disposition === "execute" && !planner) {
    throw new AutoDryRunError("invalid-roadmap-preview");
  }
  const roadmap =
    decision.disposition === "execute"
      ? validateRoadmapProjection(await planner!.plan(source), source)
      : null;
  const evidence = evidenceProjection(inventory, assessment, tracker, selectedWorkUnit, roadmap);
  const operations = operationProjection(
    source,
    decision,
    selectedCandidate,
    selectedWorkUnit,
    roadmap,
    evidence,
  );
  const decisionPreview = workflowDecisionProjection(
    decision,
    request,
    assessment,
    selectedCandidate,
    selectedWorkUnit,
    evidence,
  );
  const nextAction = exactNextAction(source, request);
  const body = {
    schemaVersion: AUTO_DRY_RUN_SCHEMA_VERSION,
    kind: "docsfab-auto-dry-run" as const,
    readOnly: true as const,
    authorization: null,
    repository: {
      path: source.repositoryPath,
      targetBranch: source.targetBranch,
      identitySha256: request.repository.identitySha256,
      revision: request.repository.revision,
      inventorySha256: inventory.inventorySha256,
      inventoryStatus: inventory.status,
    },
    tracker: request.tracker,
    assessment: {
      maturityAssessmentSha256: maturityAssessment.assessmentSha256,
      maturitySelectionSha256: selection.selectionSha256,
      selectedWorkUnitFingerprint: selectedWorkUnit?.workUnitFingerprint ?? null,
    },
    cycle: { request, assessment, decision },
    decision: decisionPreview,
    evidence,
    operations,
    draftMergeRequestDestination:
      decision.disposition === "execute" && selectedCandidate?.deliveryMode !== "none"
        ? source.draftMergeRequestDestination
        : null,
    roadmapPlanSha256: roadmap?.digest ?? null,
    nextAction,
  };
  const result = deepFreeze({
    ...body,
    resultSha256: canonicalDigest(body),
  });
  if (detectCredentialRuleIdsInValue(result).length > 0) {
    throw new AutoDryRunError("unsafe-output");
  }
  return result;
}

/** Strict result for an unknown repository type or insufficient evidence. */
export function createAutoDryRunNeedsInput(input: AutoDryRunNeedsInputV1): AutoDryRunResultV1 {
  if (
    !input ||
    typeof input !== "object" ||
    Object.getPrototypeOf(input) !== Object.prototype ||
    !sameKeys(input as unknown as Record<string, unknown>, [
      "repositoryPath",
      "repository",
      "inventory",
      "reasonCode",
      "openInputIds",
      "targetBranch",
      "draftMergeRequestDestination",
    ]) ||
    typeof input.repositoryPath !== "string" ||
    input.repositoryPath.length === 0 ||
    !input.repository ||
    Object.getPrototypeOf(input.repository) !== Object.prototype ||
    !sameKeys(input.repository as unknown as Record<string, unknown>, [
      "identitySha256",
      "revision",
    ]) ||
    !sha256(input.repository.identitySha256) ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(input.repository.revision) ||
    !safeRepositoryPath(input.repositoryPath) ||
    !identifier(input.reasonCode) ||
    !sortedUniqueIdentifiers(input.openInputIds) ||
    (input.targetBranch !== null && !safeBranch(input.targetBranch))
  )
    invalidSource();
  if (
    createHash("sha256").update(input.repositoryPath).digest("hex") !==
    input.repository.identitySha256
  )
    invalidSource();
  const inventory = decodeRepositoryDiscoveryInventory(input.inventory);
  const needsInputDestination = input.draftMergeRequestDestination;
  if (
    needsInputDestination !== null &&
    (Object.getPrototypeOf(needsInputDestination) !== Object.prototype ||
      !sameKeys(needsInputDestination as unknown as Record<string, unknown>, [
        "provider",
        "projectIdentitySha256",
        "targetBranch",
      ]) ||
      needsInputDestination.provider !== "gitlab" ||
      !sha256(needsInputDestination.projectIdentitySha256) ||
      !safeBranch(needsInputDestination.targetBranch))
  )
    invalidSource();
  if (
    inventory.repositoryRevision !== input.repository.revision ||
    (input.draftMergeRequestDestination !== null &&
      (input.targetBranch === null ||
        input.draftMergeRequestDestination.targetBranch !== input.targetBranch))
  ) {
    bindingMismatch();
  }
  const nextAction = exactNextActionFor(
    input.repositoryPath,
    input.repository.revision,
    input.targetBranch,
  );
  const evidence: AutoDryRunEvidenceV1[] = [
    {
      id: "repository-inventory",
      kind: "repository-inventory",
      sha256: inventory.inventorySha256,
      paths: [],
    },
  ];
  const body = {
    schemaVersion: AUTO_DRY_RUN_SCHEMA_VERSION,
    kind: "docsfab-auto-dry-run" as const,
    readOnly: true as const,
    authorization: null,
    repository: {
      path: input.repositoryPath,
      targetBranch: input.targetBranch,
      identitySha256: input.repository.identitySha256,
      revision: input.repository.revision,
      inventorySha256: inventory.inventorySha256,
      inventoryStatus: inventory.status,
    },
    tracker: null,
    assessment: {
      maturityAssessmentSha256: null,
      maturitySelectionSha256: null,
      selectedWorkUnitFingerprint: null,
    },
    cycle: null,
    decision: {
      disposition: "needs-input" as const,
      workflow: null,
      reasonCode: input.reasonCode,
      confidence: "needs-input" as const,
      deliveryMode: null,
      evidenceIds: ["repository-inventory"],
      dependencies: [],
      pathScope: [],
      expectedValidation: [],
      openInputIds: [...input.openInputIds],
      requestSha256: null,
      assessmentSha256: null,
      decisionSha256: null,
    },
    evidence,
    operations: [] as AutoDryRunOperationPreviewV1[],
    draftMergeRequestDestination: input.draftMergeRequestDestination,
    roadmapPlanSha256: null,
    nextAction,
  };
  const result = deepFreeze({
    ...body,
    resultSha256: canonicalDigest(body),
  });
  if (detectCredentialRuleIdsInValue(result).length > 0) {
    throw new AutoDryRunError("unsafe-output");
  }
  return result;
}

export function serializeAutoDryRun(result: AutoDryRunResultV1): string {
  return `${canonicalJson(result)}\n`;
}

export function decodeAutoDryRunResult(value: unknown): AutoDryRunResultV1 {
  assertPlainData(value, new Set<object>());
  const root = exactRecord(value, [
    "schemaVersion",
    "kind",
    "readOnly",
    "authorization",
    "repository",
    "tracker",
    "assessment",
    "cycle",
    "decision",
    "evidence",
    "operations",
    "draftMergeRequestDestination",
    "roadmapPlanSha256",
    "nextAction",
    "resultSha256",
  ]);
  if (
    root.schemaVersion !== 1 ||
    root.kind !== "docsfab-auto-dry-run" ||
    root.readOnly !== true ||
    root.authorization !== null ||
    !sha256(root.resultSha256) ||
    typeof root.nextAction !== "string" ||
    !root.nextAction.startsWith("docsfab auto --once --repo ")
  )
    invalidSource();
  const repository = exactRecord(root.repository, [
    "path",
    "targetBranch",
    "identitySha256",
    "revision",
    "inventorySha256",
    "inventoryStatus",
  ]);
  if (
    !safeRepositoryPath(repository.path) ||
    (repository.targetBranch !== null && !safeBranch(repository.targetBranch)) ||
    !sha256(repository.identitySha256) ||
    !sha256(repository.inventorySha256) ||
    typeof repository.revision !== "string" ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(repository.revision) ||
    (repository.inventoryStatus !== "complete" && repository.inventoryStatus !== "incomplete")
  ) {
    invalidSource();
  }
  if (root.tracker !== null) {
    const tracker = exactRecord(root.tracker, [
      "projectIdentitySha256",
      "observationSha256",
      "observedAt",
      "authority",
    ]);
    if (
      !sha256(tracker.projectIdentitySha256) ||
      !sha256(tracker.observationSha256) ||
      tracker.authority !== "observe-only" ||
      !timestamp(tracker.observedAt)
    )
      invalidSource();
  }
  const assessment = exactRecord(root.assessment, [
    "maturityAssessmentSha256",
    "maturitySelectionSha256",
    "selectedWorkUnitFingerprint",
  ]);
  for (const item of [
    assessment.maturityAssessmentSha256,
    assessment.maturitySelectionSha256,
    assessment.selectedWorkUnitFingerprint,
  ]) {
    if (item !== null && !sha256(item)) invalidSource();
  }
  let cycleRequest: AutoCycleRequestV1 | null = null;
  let cycleAssessment: AutoAssessmentV1 | null = null;
  let cycleDecision: WorkflowDecisionV1 | null = null;
  let cycleCandidate: AutoAssessmentV1["candidates"][number] | undefined;
  if (root.cycle !== null) {
    const cycle = exactRecord(root.cycle, ["request", "assessment", "decision"]);
    try {
      cycleRequest = decodeAutoCycleRequest(cycle.request, workflowCatalog);
      cycleAssessment = decodeAutoAssessment(cycle.assessment, cycleRequest, workflowCatalog);
      cycleDecision = decodeWorkflowDecision(
        cycle.decision,
        cycleRequest,
        cycleAssessment,
        workflowCatalog,
      );
    } catch {
      invalidSource();
    }
    cycleCandidate =
      cycleDecision.disposition === "execute"
        ? cycleAssessment.candidates.find(
            (candidate) => candidate.candidateSha256 === cycleDecision!.candidateSha256,
          )
        : undefined;
    if ((cycleDecision.disposition === "execute") !== Boolean(cycleCandidate)) invalidSource();
  }
  const decision = exactRecord(root.decision, [
    "disposition",
    "workflow",
    "reasonCode",
    "confidence",
    "deliveryMode",
    "evidenceIds",
    "dependencies",
    "pathScope",
    "expectedValidation",
    "openInputIds",
    "requestSha256",
    "assessmentSha256",
    "decisionSha256",
  ]);
  if (
    !["execute", "no-action", "needs-input", "blocked", "superseded"].includes(
      decision.disposition as string,
    ) ||
    (decision.workflow !== null && !identifier(decision.workflow)) ||
    !identifier(decision.reasonCode) ||
    !["high", "bounded", "needs-input", "blocked"].includes(decision.confidence as string) ||
    (decision.deliveryMode !== null &&
      !["none", "local-patch", "local-user-gitlab"].includes(decision.deliveryMode as string)) ||
    !stringArray(decision.evidenceIds, safeOutputId) ||
    !stringArray(decision.pathScope, safeRelativePath) ||
    !stringArray(decision.expectedValidation, identifier) ||
    !stringArray(decision.openInputIds, identifier) ||
    !nullableSha(decision.requestSha256) ||
    !nullableSha(decision.assessmentSha256) ||
    !nullableSha(decision.decisionSha256) ||
    !Array.isArray(decision.dependencies)
  )
    invalidSource();
  for (const dependencyValue of decision.dependencies) {
    const dependency = exactRecord(dependencyValue, ["id", "state", "evidenceIds"]);
    if (
      !identifier(dependency.id) ||
      !["satisfied", "missing", "conflicting", "blocked"].includes(dependency.state as string) ||
      !stringArray(dependency.evidenceIds, safeOutputId)
    )
      invalidSource();
  }
  if (!Array.isArray(root.evidence) || !Array.isArray(root.operations)) invalidSource();
  const evidenceIds = new Set<string>();
  for (const evidenceValue of root.evidence) {
    const evidence = exactRecord(evidenceValue, ["id", "kind", "sha256", "paths"]);
    if (
      !safeOutputId(evidence.id) ||
      evidenceIds.has(evidence.id) ||
      !sha256(evidence.sha256) ||
      ![
        "repository-inventory",
        "maturity-finding",
        "tracker-observation",
        "workflow-prerequisite",
        "roadmap-plan",
      ].includes(evidence.kind as string) ||
      !stringArray(evidence.paths, safeRelativePath)
    )
      invalidSource();
    evidenceIds.add(evidence.id);
  }
  const operationKeys = new Set<string>();
  for (const operationValue of root.operations) {
    const operation = exactRecord(operationValue, [
      "key",
      "action",
      "target",
      "evidenceIds",
      "performsMutation",
    ]);
    const target = exactRecord(operation.target, [
      "kind",
      "identitySha256",
      "issueIid",
      "targetBranch",
      "sourceBranch",
    ]);
    if (
      !safeOutputId(operation.key) ||
      operationKeys.has(operation.key) ||
      ![
        "create",
        "reuse",
        "update",
        "link",
        "supersede",
        "investigate",
        "deferred",
        "draft-mr",
      ].includes(operation.action as string) ||
      operation.performsMutation !== false ||
      !stringArray(operation.evidenceIds, (item) => identifier(item) && evidenceIds.has(item)) ||
      (target.kind !== "issue" && target.kind !== "draft-merge-request") ||
      !sha256(target.identitySha256) ||
      (target.issueIid !== null &&
        (!Number.isSafeInteger(target.issueIid) || (target.issueIid as number) < 1)) ||
      (target.targetBranch !== null && !safeBranch(target.targetBranch)) ||
      (target.sourceBranch !== null && !safeBranch(target.sourceBranch)) ||
      (operation.action === "draft-mr" &&
        (target.kind !== "draft-merge-request" ||
          target.issueIid !== null ||
          target.targetBranch === null ||
          target.sourceBranch === null)) ||
      (operation.action !== "draft-mr" &&
        (target.kind !== "issue" || target.targetBranch !== null || target.sourceBranch !== null))
    )
      invalidSource();
    operationKeys.add(operation.key as string);
  }
  if (root.draftMergeRequestDestination !== null) {
    const destination = exactRecord(root.draftMergeRequestDestination, [
      "provider",
      "projectIdentitySha256",
      "targetBranch",
    ]);
    if (
      destination.provider !== "gitlab" ||
      !sha256(destination.projectIdentitySha256) ||
      !safeBranch(destination.targetBranch)
    )
      invalidSource();
  }
  const evidence = root.evidence as AutoDryRunEvidenceV1[];
  const operations = root.operations as AutoDryRunOperationPreviewV1[];
  const draftOperations = operations.filter((operation) => operation.action === "draft-mr");
  const destination = root.draftMergeRequestDestination as
    | AutoDryRunSourceV1["draftMergeRequestDestination"]
    | null;
  const expectedDraftIdentity =
    destination !== null &&
    decision.workflow !== null &&
    assessment.selectedWorkUnitFingerprint !== null
      ? deliverySemanticIdentity({
          repositoryRevision: repository.revision as string,
          projectIdentitySha256: destination.projectIdentitySha256,
          targetBranch: destination.targetBranch,
          workUnitFingerprint: assessment.selectedWorkUnitFingerprint as string,
          workflow: decision.workflow as string,
        })
      : null;
  const expectedDraftBranch =
    expectedDraftIdentity === null
      ? null
      : `docsfab-run/auto-${expectedDraftIdentity.slice(0, 16)}`;
  const expectedDraftKey =
    expectedDraftBranch === null
      ? null
      : `draft-mr:${canonicalDigest({
          semanticIdentitySha256: expectedDraftIdentity,
          sourceBranch: expectedDraftBranch,
        }).slice(0, 32)}`;
  if (
    !nullableSha(root.roadmapPlanSha256) ||
    createHash("sha256")
      .update(repository.path as string)
      .digest("hex") !== repository.identitySha256 ||
    !evidence.some(
      (item) =>
        item.id === "repository-inventory" &&
        item.kind === "repository-inventory" &&
        item.sha256 === repository.inventorySha256,
    ) ||
    !(decision.evidenceIds as string[]).every((id) => evidenceIds.has(id)) ||
    !(decision.dependencies as Array<{ evidenceIds: string[] }>).every((dependency) =>
      dependency.evidenceIds.every((id) => evidenceIds.has(id)),
    ) ||
    (root.tracker !== null &&
      !evidence.some(
        (item) =>
          item.id === "tracker-observation" &&
          item.sha256 === (root.tracker as { observationSha256: string }).observationSha256,
      )) ||
    (root.roadmapPlanSha256 !== null &&
      !evidence.some(
        (item) => item.id === "roadmap-plan" && item.sha256 === root.roadmapPlanSha256,
      )) ||
    (decision.disposition === "execute" &&
      (root.tracker === null ||
        root.roadmapPlanSha256 === null ||
        decision.workflow === null ||
        assessment.selectedWorkUnitFingerprint === null ||
        decision.requestSha256 === null ||
        decision.assessmentSha256 === null ||
        decision.decisionSha256 === null ||
        (decision.openInputIds as string[]).length !== 0)) ||
    (root.tracker === null &&
      (assessment.maturityAssessmentSha256 !== null ||
        assessment.maturitySelectionSha256 !== null ||
        assessment.selectedWorkUnitFingerprint !== null ||
        decision.requestSha256 !== null ||
        decision.assessmentSha256 !== null ||
        decision.decisionSha256 !== null ||
        decision.deliveryMode !== null ||
        root.roadmapPlanSha256 !== null)) ||
    (root.tracker !== null &&
      (assessment.maturityAssessmentSha256 === null ||
        assessment.maturitySelectionSha256 === null ||
        decision.requestSha256 === null ||
        decision.assessmentSha256 === null ||
        decision.decisionSha256 === null ||
        decision.deliveryMode === null)) ||
    (decision.disposition !== "execute" && root.operations.length !== 0)
  )
    invalidSource();
  if ((root.cycle === null) !== (root.tracker === null)) invalidSource();
  if (cycleRequest !== null && cycleAssessment !== null && cycleDecision !== null) {
    const tracker = root.tracker as NonNullable<AutoDryRunResultV1["tracker"]>;
    const expectedDeliveryMode = cycleCandidate?.deliveryMode ?? cycleRequest.bounds.deliveryMode;
    if (
      repository.identitySha256 !== cycleRequest.repository.identitySha256 ||
      repository.revision !== cycleRequest.repository.revision ||
      repository.targetBranch !== cycleRequest.bounds.targetBranch ||
      tracker.projectIdentitySha256 !== cycleRequest.tracker.projectIdentitySha256 ||
      tracker.observationSha256 !== cycleRequest.tracker.observationSha256 ||
      tracker.observedAt !== cycleRequest.tracker.observedAt ||
      tracker.authority !== cycleRequest.tracker.authority ||
      decision.disposition !== cycleDecision.disposition ||
      decision.workflow !== cycleDecision.workflow ||
      decision.reasonCode !== cycleDecision.reasonCode ||
      canonicalJson(decision.openInputIds) !== canonicalJson(cycleDecision.openInputIds) ||
      decision.requestSha256 !== cycleDecision.requestSha256 ||
      decision.assessmentSha256 !== cycleDecision.assessmentSha256 ||
      decision.decisionSha256 !== cycleDecision.decisionSha256 ||
      decision.deliveryMode !== expectedDeliveryMode ||
      (cycleCandidate !== undefined && cycleCandidate.workflow !== cycleDecision.workflow)
    ) {
      invalidSource();
    }
  }
  if (
    (decision.disposition === "needs-input") !== (decision.confidence === "needs-input") ||
    (decision.disposition === "needs-input" &&
      ((decision.openInputIds as string[]).length === 0 || decision.workflow !== null)) ||
    (decision.disposition === "blocked") !== (decision.confidence === "blocked") ||
    (decision.disposition === "blocked" && decision.workflow !== null) ||
    (["no-action", "superseded"].includes(decision.disposition as string) &&
      (decision.workflow !== null || (decision.openInputIds as string[]).length !== 0)) ||
    draftOperations.length > 1 ||
    (destination === null && draftOperations.length !== 0) ||
    (decision.deliveryMode === "none" && (destination !== null || draftOperations.length !== 0)) ||
    (decision.disposition === "execute" &&
      decision.deliveryMode !== "none" &&
      destination === null) ||
    (decision.disposition === "execute" && destination !== null && draftOperations.length !== 1) ||
    (destination !== null &&
      draftOperations.some(
        (operation) =>
          operation.target.kind !== "draft-merge-request" ||
          operation.target.identitySha256 !== canonicalDigest(destination) ||
          operation.target.targetBranch !== destination.targetBranch ||
          operation.target.sourceBranch !== expectedDraftBranch ||
          operation.key !== expectedDraftKey,
      )) ||
    (destination !== null && destination.targetBranch !== repository.targetBranch) ||
    (destination !== null &&
      root.tracker !== null &&
      destination.projectIdentitySha256 !==
        (root.tracker as { projectIdentitySha256: string }).projectIdentitySha256) ||
    root.nextAction !==
      exactNextActionFor(
        repository.path as string,
        repository.revision as string,
        repository.targetBranch as string | null,
      )
  )
    invalidSource();
  const { resultSha256: _resultSha256, ...body } = root;
  if (
    canonicalDigest(body) !== root.resultSha256 ||
    detectCredentialRuleIdsInValue(root).length > 0
  )
    invalidSource();
  return deepFreeze(structuredClone(root)) as unknown as AutoDryRunResultV1;
}

export function formatAutoDryRun(result: AutoDryRunResultV1): string {
  const selected = result.decision.workflow ?? "none";
  const lines = [
    `Assessment: ${result.decision.disposition} (${result.decision.confidence})`,
    `Repository: ${result.repository.revision}`,
    `Inventory: ${result.repository.inventoryStatus} ${result.repository.inventorySha256}`,
    `Workflow: ${selected}`,
    `Reason: ${result.decision.reasonCode}`,
    `Evidence: ${result.decision.evidenceIds.join(", ") || "none"}`,
    `Dependencies: ${result.decision.dependencies.map((item) => `${item.id}=${item.state}`).join(", ") || "none"}`,
    `Paths: ${result.decision.pathScope.join(", ") || "none"}`,
    `Validation: ${result.decision.expectedValidation.join(", ") || "none"}`,
    `Open inputs: ${result.decision.openInputIds.join(", ") || "none"}`,
    "Previewed operations:",
    ...result.operations.map(
      (operation) => `  ${operation.key} ${operation.action} ${operation.target.kind}`,
    ),
    `Draft MR target: ${result.draftMergeRequestDestination?.targetBranch ?? "needs input"}`,
    `Next: ${result.nextAction}`,
  ];
  return lines.join("\n");
}

function validateSource(value: AutoDryRunSourceV1): AutoDryRunSourceV1 {
  assertPlainData(value, new Set<object>());
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    invalidSource();
  const keys = [
    "repositoryPath",
    "targetBranch",
    "draftMergeRequestDestination",
    "inventory",
    "request",
    "assessment",
    "decision",
    "maturityAssessment",
    "maturityTrackerObservation",
    "maturitySelection",
    "managedTrackerObservationSha256",
    "repositoryContentDigest",
  ];
  if (
    !sameKeys(value as unknown as Record<string, unknown>, keys) ||
    typeof value.repositoryPath !== "string" ||
    value.repositoryPath.length === 0 ||
    !safeRepositoryPath(value.repositoryPath) ||
    !safeBranch(value.targetBranch) ||
    !sha256(value.managedTrackerObservationSha256) ||
    !sha256(value.repositoryContentDigest)
  )
    invalidSource();
  const destination = value.draftMergeRequestDestination;
  if (
    !destination ||
    Object.getPrototypeOf(destination) !== Object.prototype ||
    !sameKeys(destination as unknown as Record<string, unknown>, [
      "provider",
      "projectIdentitySha256",
      "targetBranch",
    ]) ||
    destination.provider !== "gitlab" ||
    !sha256(destination.projectIdentitySha256) ||
    !safeBranch(destination.targetBranch) ||
    destination.targetBranch !== value.targetBranch
  )
    invalidSource();
  return value;
}

function assertBindings(input: {
  source: AutoDryRunSourceV1;
  request: AutoCycleRequestV1;
  assessment: AutoAssessmentV1;
  decision: WorkflowDecisionV1;
  maturityAssessment: DocumentationMaturityCascadeAssessmentV1;
  tracker: DocumentationMaturityCascadeTrackerObservationV1;
  selection: DocumentationMaturityCascadeSelectionV1;
  inventory: RepositoryDiscoveryInventoryV1;
}): void {
  if (
    createHash("sha256").update(input.source.repositoryPath).digest("hex") !==
      input.request.repository.identitySha256 ||
    input.source.targetBranch !== input.request.bounds.targetBranch ||
    input.source.draftMergeRequestDestination.targetBranch !== input.source.targetBranch ||
    input.source.draftMergeRequestDestination.projectIdentitySha256 !==
      input.request.tracker.projectIdentitySha256 ||
    input.inventory.repositoryRevision !== input.request.repository.revision ||
    canonicalJson(input.maturityAssessment.repository) !==
      canonicalJson(input.request.repository) ||
    canonicalJson(input.tracker.repository) !== canonicalJson(input.request.repository) ||
    input.tracker.projectSha256 !== input.request.tracker.projectIdentitySha256 ||
    input.tracker.observationSha256 !== input.request.tracker.observationSha256 ||
    input.tracker.observedAt !== input.request.tracker.observedAt ||
    input.assessment.assessmentSha256 !== input.decision.assessmentSha256 ||
    input.selection.assessmentSha256 !== input.maturityAssessment.assessmentSha256 ||
    input.selection.trackerObservationSha256 !== input.tracker.observationSha256 ||
    canonicalJson(input.selection.repository) !== canonicalJson(input.request.repository)
  ) {
    bindingMismatch();
  }
}

function evidenceProjection(
  inventory: RepositoryDiscoveryInventoryV1,
  assessment: AutoAssessmentV1,
  tracker: DocumentationMaturityCascadeTrackerObservationV1,
  selectedWorkUnit: DocumentationMaturityWorkUnitV1 | null,
  roadmap: AutoDryRunRoadmapProjectionV1 | null,
): AutoDryRunEvidenceV1[] {
  const evidence: AutoDryRunEvidenceV1[] = [
    {
      id: "repository-inventory",
      kind: "repository-inventory",
      sha256: inventory.inventorySha256,
      paths: [],
    },
    {
      id: "tracker-observation",
      kind: "tracker-observation",
      sha256: tracker.observationSha256,
      paths: [],
    },
  ];
  for (const finding of assessment.maturityFindings)
    evidence.push({
      id: `maturity:${finding.fingerprint}`,
      kind: "maturity-finding",
      sha256: finding.findingSha256,
      paths:
        finding.fingerprint === selectedWorkUnit?.findingFingerprint
          ? [...selectedWorkUnit.affectedPaths]
          : [],
    });
  for (const candidate of assessment.candidates) {
    for (const prerequisite of candidate.prerequisites) {
      for (const [index, digest] of prerequisite.evidenceSha256s.entries())
        evidence.push({
          id: `prerequisite:${candidate.id}:${prerequisite.id}:${index}`,
          kind: "workflow-prerequisite",
          sha256: digest,
          paths: [],
        });
    }
  }
  if (roadmap)
    evidence.push({
      id: "roadmap-plan",
      kind: "roadmap-plan",
      sha256: roadmap.digest,
      paths: selectedWorkUnit ? [...selectedWorkUnit.affectedPaths] : [],
    });
  return evidence.sort((left, right) => left.id.localeCompare(right.id));
}

function workflowDecisionProjection(
  decision: WorkflowDecisionV1,
  request: AutoCycleRequestV1,
  assessment: AutoAssessmentV1,
  candidate: AutoAssessmentV1["candidates"][number] | undefined,
  selectedWorkUnit: DocumentationMaturityWorkUnitV1 | null,
  evidence: AutoDryRunEvidenceV1[],
): AutoDryRunWorkflowDecisionPreviewV1 {
  const evidenceIds = evidence
    .filter(
      (item) =>
        item.kind === "repository-inventory" ||
        item.kind === "tracker-observation" ||
        item.kind === "maturity-finding" ||
        item.kind === "workflow-prerequisite",
    )
    .map((item) => item.id);
  return {
    disposition: decision.disposition,
    workflow: decision.workflow,
    reasonCode: decision.reasonCode,
    confidence:
      decision.disposition === "blocked"
        ? "blocked"
        : decision.disposition === "needs-input"
          ? "needs-input"
          : assessment.maturityFindings.some((item) => item.confidence === "bounded")
            ? "bounded"
            : "high",
    deliveryMode: candidate?.deliveryMode ?? request.bounds.deliveryMode,
    evidenceIds,
    dependencies: (candidate?.prerequisites ?? []).map((item) => ({
      id: item.id,
      state: item.state,
      evidenceIds: evidence
        .filter((reference) => reference.id.includes(`:${candidate!.id}:${item.id}:`))
        .map((reference) => reference.id),
    })),
    pathScope: selectedWorkUnit
      ? [...selectedWorkUnit.affectedPaths]
      : candidate
        ? [...candidate.pathPrefixes]
        : [],
    expectedValidation: candidate ? [...candidate.validationIds] : [],
    openInputIds: [...decision.openInputIds],
    requestSha256: decision.requestSha256,
    assessmentSha256: decision.assessmentSha256,
    decisionSha256: decision.decisionSha256,
  };
}

function operationProjection(
  source: AutoDryRunSourceV1,
  decision: WorkflowDecisionV1,
  candidate: AutoAssessmentV1["candidates"][number] | undefined,
  workUnit: DocumentationMaturityWorkUnitV1 | null,
  roadmap: AutoDryRunRoadmapProjectionV1 | null,
  evidence: AutoDryRunEvidenceV1[],
): AutoDryRunOperationPreviewV1[] {
  if (decision.disposition !== "execute" || !candidate || !workUnit) return [];
  const evidenceIds = evidence
    .filter(
      (item) =>
        item.kind === "maturity-finding" ||
        item.kind === "tracker-observation" ||
        item.kind === "roadmap-plan",
    )
    .map((item) => item.id);
  const operations: AutoDryRunOperationPreviewV1[] = [];
  for (const reconciliation of roadmap?.reconciliations ?? []) {
    const mutationKeys =
      reconciliation.operationKeys.length > 0
        ? reconciliation.operationKeys
        : [
            `reconcile:${canonicalDigest({
              workUnitFingerprint: reconciliation.workUnitFingerprint,
              disposition: reconciliation.disposition,
              issueIid: reconciliation.issueIid ?? null,
            }).slice(0, 32)}`,
          ];
    for (const key of mutationKeys) {
      const plannedOperation = roadmap?.mutationPlan?.operations.find((item) => item.key === key);
      const action =
        plannedOperation?.proposal.intent === "assign-label"
          ? "update"
          : reconciliationAction(reconciliation.disposition);
      if (!action) continue;
      operations.push({
        key,
        action,
        target: {
          kind: "issue",
          identitySha256: canonicalDigest({
            project: source.draftMergeRequestDestination.projectIdentitySha256,
            issueIid: reconciliation.issueIid ?? null,
            findingId: reconciliation.findingId,
          }),
          issueIid: reconciliation.issueIid ?? null,
          targetBranch: null,
          sourceBranch: null,
        },
        evidenceIds,
        performsMutation: false,
      });
    }
  }
  if (candidate.deliveryMode !== "none") {
    const semanticIdentitySha256 = deliverySemanticIdentity({
      repositoryRevision: source.request.repository.revision,
      projectIdentitySha256: source.draftMergeRequestDestination.projectIdentitySha256,
      targetBranch: source.targetBranch,
      workUnitFingerprint: workUnit.workUnitFingerprint,
      workflow: candidate.workflow,
    });
    const sourceBranch = `docsfab-run/auto-${semanticIdentitySha256.slice(0, 16)}`;
    operations.push({
      key: `draft-mr:${canonicalDigest({
        semanticIdentitySha256,
        sourceBranch,
      }).slice(0, 32)}`,
      action: "draft-mr",
      target: {
        kind: "draft-merge-request",
        identitySha256: canonicalDigest(source.draftMergeRequestDestination),
        issueIid: null,
        targetBranch: source.targetBranch,
        sourceBranch,
      },
      evidenceIds,
      performsMutation: false,
    });
  }
  return operations.sort((left, right) => left.key.localeCompare(right.key));
}

function deliverySemanticIdentity(input: {
  repositoryRevision: string;
  projectIdentitySha256: string;
  targetBranch: string;
  workUnitFingerprint: string;
  workflow: string;
}): string {
  return canonicalDigest({
    contract: "docsfab-auto-dry-run-delivery-v1",
    ...input,
  });
}

function validateRoadmapProjection(
  value: AutoDryRunRoadmapProjectionV1,
  source: AutoDryRunSourceV1,
): AutoDryRunRoadmapProjectionV1 {
  try {
    if (assertAuthenticAutoRoadmapPlanningResultV1(value) !== value) invalidRoadmap();
    assertPlainData(value, new Set<object>());
    if (
      !value ||
      typeof value !== "object" ||
      !sameKeys(value as unknown as Record<string, unknown>, [
        "kind",
        "schemaVersion",
        "readOnly",
        "authorization",
        "source",
        "planning",
        "mutationPlan",
        "materials",
        "execution",
        "reconciliations",
        "deferredWorkUnitFingerprints",
        "digest",
      ]) ||
      value.kind !== "docsfab-auto-roadmap-planning-result" ||
      value.schemaVersion !== 1 ||
      value.readOnly !== true ||
      value.authorization !== null ||
      !sha256(value.digest) ||
      roadmapDigest(value) !== value.digest ||
      !Array.isArray(value.reconciliations) ||
      !Array.isArray(value.deferredWorkUnitFingerprints)
    )
      invalidRoadmap();
    const expectedSource = {
      requestSha256: source.request.requestSha256,
      assessmentSha256: source.assessment.assessmentSha256,
      decisionSha256: source.decision.decisionSha256,
      maturityAssessmentSha256: source.maturityAssessment.assessmentSha256,
      maturitySelectionSha256: source.maturitySelection.selectionSha256,
      trackerObservationSha256: source.maturityTrackerObservation.observationSha256,
      managedTrackerObservationSha256: source.managedTrackerObservationSha256,
    };
    if (
      !sameKeys(value.source as unknown as Record<string, unknown>, Object.keys(expectedSource)) ||
      canonicalJson(value.source) !== canonicalJson(expectedSource) ||
      !value.planning ||
      roadmapDigest(value.planning) !== value.planning.digest
    )
      invalidRoadmap();
    const ledger = validateRoadmapLedger(value.planning.ledger);
    const selectedFingerprint =
      source.maturitySelection.outcome.state === "selected"
        ? source.maturitySelection.outcome.workUnit.workUnitFingerprint
        : null;
    if (
      selectedFingerprint === null ||
      ledger.repository.revision !== source.request.repository.revision ||
      ledger.repository.contentDigest !== source.repositoryContentDigest ||
      canonicalDigest(ledger.project) !==
        source.draftMergeRequestDestination.projectIdentitySha256 ||
      ledger.trackerObservedAt !== source.maturityTrackerObservation.observedAt ||
      value.reconciliations.length !== ledger.findings.length ||
      new Set(value.reconciliations.map((item) => item.findingId)).size !==
        value.reconciliations.length ||
      value.reconciliations.some(
        (item) =>
          item.workUnitFingerprint !== selectedFingerprint ||
          !ledger.findings.some((finding) => finding.id === item.findingId),
      ) ||
      value.deferredWorkUnitFingerprints.some((fingerprint) => fingerprint !== selectedFingerprint)
    )
      invalidRoadmap();
    if (value.planning.mutationPlan !== null) {
      validateRoadmapMutationPlanV2(value.planning.mutationPlan, ledger);
    }
    if (value.mutationPlan === null) {
      if (value.materials !== null || value.execution !== null) invalidRoadmap();
    } else {
      if (value.materials === null || value.execution === null) invalidRoadmap();
      const plan = validateRoadmapMutationPlanV2(value.mutationPlan, ledger);
      const materials = validateIssueLifecycleMaterialBundle(value.materials);
      if (
        materials.planDigest !== plan.digest ||
        materials.operations.length !== plan.operations.length
      )
        invalidRoadmap();
      for (const operation of plan.operations) {
        const material = materials.operations.find((item) => item.operationKey === operation.key);
        if (!material) invalidRoadmap();
        assertMaterialForOperation(operation, material);
      }
      restoreAutoRoadmapExecutionPlanV1(value.execution, {
        source: {
          ...expectedSource,
          planningArtifactSha256: value.planning.digest,
        },
        ledger,
        plan,
        materials,
        operationCap: value.execution.operationCap,
        deferredWorkUnitFingerprints: value.deferredWorkUnitFingerprints,
      });
    }
    const operationKeys = new Set(value.mutationPlan?.operations.map((item) => item.key) ?? []);
    const reconciledKeys = new Set<string>();
    for (const reconciliation of value.reconciliations) {
      if (
        !reconciliation ||
        typeof reconciliation !== "object" ||
        !sameKeys(
          reconciliation as unknown as Record<string, unknown>,
          [
            "findingId",
            "workUnitFingerprint",
            "disposition",
            "issueIid",
            "linkedIssueIids",
            "operationKeys",
            "reasonCode",
          ].filter((key) => key !== "issueIid" || reconciliation.issueIid !== undefined),
        ) ||
        !identifier(reconciliation.findingId) ||
        !sha256(reconciliation.workUnitFingerprint) ||
        !identifier(reconciliation.disposition) ||
        !identifier(reconciliation.reasonCode) ||
        !Array.isArray(reconciliation.linkedIssueIids) ||
        reconciliation.linkedIssueIids.some((iid) => !Number.isSafeInteger(iid) || iid < 1) ||
        !Array.isArray(reconciliation.operationKeys) ||
        reconciliation.operationKeys.some(
          (key) => !identifier(key) || !operationKeys.has(key) || reconciledKeys.has(key),
        ) ||
        (reconciliation.issueIid !== undefined &&
          (!Number.isSafeInteger(reconciliation.issueIid) || reconciliation.issueIid < 1))
      ) {
        invalidRoadmap();
      }
      for (const key of reconciliation.operationKeys) reconciledKeys.add(key);
      for (const key of reconciliation.operationKeys) {
        const operation = value.mutationPlan?.operations.find((item) => item.key === key);
        if (!operation || !operation.findingIds.includes(reconciliation.findingId))
          invalidRoadmap();
        if (
          (operation.proposal.intent === "create" && reconciliation.disposition !== "create") ||
          (operation.proposal.intent === "assign-label" &&
            reconciliation.disposition !== "reuse") ||
          (operation.proposal.intent === "comment" && reconciliation.disposition !== "migration")
        )
          invalidRoadmap();
        if (reconciliation.issueIid !== undefined) {
          const issueTarget = `issue:${reconciliation.issueIid}`;
          const targetMatches =
            (operation.target.source === "ledger-observation" &&
              operation.target.targetKey === issueTarget) ||
            operation.preconditions.some(
              (item) => item.source === "ledger-observation" && item.targetKey === issueTarget,
            );
          if (!targetMatches && operation.target.source !== "dependency-result") invalidRoadmap();
        } else if (
          operation.target.source === "ledger-observation" &&
          /^issue:/u.test(operation.target.targetKey)
        )
          invalidRoadmap();
      }
    }
    if (
      reconciledKeys.size !== operationKeys.size ||
      !value.deferredWorkUnitFingerprints.every(sha256) ||
      new Set(value.deferredWorkUnitFingerprints).size !==
        value.deferredWorkUnitFingerprints.length ||
      [...value.deferredWorkUnitFingerprints].sort().join("\0") !==
        value.deferredWorkUnitFingerprints.join("\0")
    )
      invalidRoadmap();
    return value;
  } catch (error) {
    if (error instanceof AutoDryRunError) throw error;
    throw new AutoDryRunError("invalid-roadmap-preview");
  }
}

function invalidRoadmap(): never {
  throw new AutoDryRunError("invalid-roadmap-preview");
}

function reconciliationAction(value: string): AutoDryRunOperationPreviewV1["action"] | null {
  if (value === "create") return "create";
  if (value === "reuse-active" || value === "reuse") return "reuse";
  if (value === "update" || value === "refresh" || value === "migration") return "update";
  if (value === "link" || value === "duplicate") return "link";
  if (value === "supersede" || value === "superseded") return "supersede";
  if (
    value === "investigate" ||
    value === "non-actionable" ||
    value === "manually-detached" ||
    value === "conflict"
  )
    return "investigate";
  if (value === "deferred-by-cap") return "deferred";
  return null;
}

function exactNextAction(source: AutoDryRunSourceV1, request: AutoCycleRequestV1): string {
  return exactNextActionFor(
    source.repositoryPath,
    request.repository.revision,
    source.targetBranch,
  );
}

function exactNextActionFor(
  repositoryPath: string,
  revision: string,
  targetBranch: string | null,
): string {
  return [
    "docsfab auto --once --repo",
    shellQuote(repositoryPath),
    "--revision",
    revision,
    ...(targetBranch === null ? [] : ["--target-branch", shellQuote(targetBranch)]),
  ].join(" ");
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@+-]+$/u.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function sameKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === expected.length &&
    keys.every((key) => typeof key === "string" && expected.includes(key))
  );
}

function exactRecord(value: unknown, expected: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    !sameKeys(value as Record<string, unknown>, expected)
  )
    invalidSource();
  return value as Record<string, unknown>;
}

function assertPlainData(value: unknown, seen: Set<object>): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return;
  if (typeof value !== "object" || seen.has(value)) invalidSource();
  seen.add(value);
  if (Array.isArray(value)) {
    if (
      Object.getPrototypeOf(value) !== Array.prototype ||
      Reflect.ownKeys(value).length !== value.length + 1
    )
      invalidSource();
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !Object.hasOwn(descriptor, "value")) invalidSource();
      assertPlainData(descriptor.value, seen);
    }
  } else {
    if (Object.getPrototypeOf(value) !== Object.prototype) invalidSource();
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") invalidSource();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) {
        invalidSource();
      }
      assertPlainData(descriptor.value, seen);
    }
  }
  seen.delete(value);
}

function safeBranch(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^(?![-/.])(?!.*(?:\.\.|@\{|\/\/))[^\0-\x20\x7f~^:?*[\\]{1,200}$/u.test(value)
  );
}

function safeRepositoryPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.startsWith("/") &&
    value.length <= 4_096 &&
    !/[\0-\x1f\x7f]/u.test(value)
  );
}

function sha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function nullableSha(value: unknown): value is string | null {
  return value === null || sha256(value);
}

function timestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 64) return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function safeRelativePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    !value.split("/").some((part) => part === "" || part === "." || part === "..")
  );
}

function stringArray(value: unknown, predicate: (item: string) => boolean): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= 10_000 &&
    value.every((item) => typeof item === "string" && predicate(item)) &&
    new Set(value).size === value.length
  );
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
}

function safeOutputId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,511}$/u.test(value);
}

function sortedUniqueIdentifiers(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(identifier) &&
    new Set(value).size === value.length &&
    [...value].sort().join("\0") === value.join("\0")
  );
}

function invalidSource(): never {
  throw new AutoDryRunError("invalid-source");
}
function bindingMismatch(): never {
  throw new AutoDryRunError("binding-mismatch");
}
