// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { canonicalDigest } from "../content-ir/canonical.js";
import type { RepositoryIdentity } from "../content-ir/contracts.js";
import { buildContentIndexV2 } from "../content-ir/indexer.js";
import {
  validateDocumentationMaturityCascadeSelection,
  type DocumentationMaturityCascadeAssessmentV1,
  type DocumentationMaturityCascadeSelectionV1,
  type DocumentationMaturityCascadeTrackerObservationV1,
} from "../maturity/cascade.js";
import type {
  DocumentationMaturityFindingV1,
  DocumentationMaturityWorkUnitV1,
} from "../maturity/contracts.js";
import type { RepositoryWorkspace } from "../repository/workspace/contracts.js";
import * as workflowCatalog from "../workflow-registry/catalog.js";
import { bindableCycleWorkflow, isRunnableWorkflowName } from "../workflow-registry/catalog.js";
import {
  createRoadmapMutationPlanV2,
  type RoadmapMutationOperationV2Input,
  type RoadmapMutationPlanV2,
} from "../roadmap/execution-v2.js";
import {
  createIssueLifecycleMaterialBundle,
  mutationMaterialBytes,
  mutationMaterialDigest,
  type IssueLifecycleMaterialBundleV1,
  type IssueLifecycleMutationMaterial,
} from "../roadmap/issue-adapter.js";
import {
  createManagedIssueIdentity,
  reconcileManagedIssue,
  renderManagedIssueDraft,
  type ManagedIssueLabels,
  type ManagedIssueReconciliation,
  type ManagedIssueTemplateInput,
} from "../roadmap/managed-issue.js";
import {
  managedIssueTrackerObservationStateV1,
  type ManagedIssueTrackerObservationV1,
} from "../roadmap/managed-issue-observer.js";
import {
  decodeRoadmapPlanningInput,
  planRoadmap,
  type RoadmapHealthPlanningInput,
  type RoadmapPlanningArtifact,
  type RoadmapPlanningCandidateInput,
  type SanitizedRoadmapIssue,
} from "../roadmap/planning.js";
import {
  internalCreateRoadmapPlanningHostAuthority,
  internalIssueRoadmapPlanningSourceCapability,
  type InternalRoadmapPlanningSourceCapability,
} from "../roadmap/planning-authority-internal.js";
import { roadmapDigest } from "../roadmap/contracts/decode.js";
import { type RoadmapProjectIdentity } from "../roadmap/contracts/ledger.js";
import {
  decodeAutoAssessment,
  decodeAutoCycleRequest,
  decodeWorkflowDecision,
  type AutoAssessmentV1,
  type AutoCycleRequestV1,
  type WorkflowDecisionV1,
} from "./contracts.js";
import {
  createAutoRoadmapExecutionPlanV1,
  AutoRoadmapError,
  type AutoRoadmapExecutionPlanV1,
} from "./roadmap.js";
import { compareText } from "../shared/primitives.js";

export interface PlanAutoRoadmapCycleInputV1 {
  request: AutoCycleRequestV1;
  assessment: AutoAssessmentV1;
  decision: WorkflowDecisionV1;
  maturityAssessment: DocumentationMaturityCascadeAssessmentV1;
  maturityTrackerObservation: DocumentationMaturityCascadeTrackerObservationV1;
  maturitySelection: DocumentationMaturityCascadeSelectionV1;
  policyWorkspace: RepositoryWorkspace;
  repository: RepositoryIdentity;
  project: RoadmapProjectIdentity;
  managedTrackerObservation: ManagedIssueTrackerObservationV1;
  operationCap: number;
}

export type AutoRoadmapReconciliationDispositionV1 =
  | ManagedIssueReconciliation["disposition"]
  | "deferred-by-cap"
  | "non-actionable";

export interface AutoRoadmapReconciliationV1 {
  findingId: string;
  workUnitFingerprint: string;
  disposition: AutoRoadmapReconciliationDispositionV1;
  issueIid?: number;
  linkedIssueIids: number[];
  operationKeys: string[];
  reasonCode: string;
}

export interface AutoRoadmapPlanningResultV1 {
  kind: "docsfab-auto-roadmap-planning-result";
  schemaVersion: 1;
  readOnly: true;
  authorization: null;
  source: {
    requestSha256: string;
    assessmentSha256: string;
    decisionSha256: string;
    maturityAssessmentSha256: string;
    maturitySelectionSha256: string;
    trackerObservationSha256: string;
    managedTrackerObservationSha256: string;
  };
  planning: RoadmapPlanningArtifact;
  mutationPlan: RoadmapMutationPlanV2 | null;
  materials: IssueLifecycleMaterialBundleV1 | null;
  execution: AutoRoadmapExecutionPlanV1 | null;
  reconciliations: AutoRoadmapReconciliationV1[];
  deferredWorkUnitFingerprints: string[];
  digest: string;
}

interface ProjectedFinding {
  finding: DocumentationMaturityFindingV1;
  workUnit?: DocumentationMaturityWorkUnitV1;
  unitIds: string[];
  candidate: RoadmapPlanningCandidateInput;
}

const planningCapabilities = new Map<string, InternalRoadmapPlanningSourceCapability>();
const authenticPlanningResults = new WeakMap<
  object,
  {
    digest: string;
    sourceDigest: string;
    planningDigest: string;
  }
>();

export async function planAutoRoadmapCycleV1(
  input: PlanAutoRoadmapCycleInputV1,
): Promise<AutoRoadmapPlanningResultV1> {
  const request = decodeAutoCycleRequest(input.request, workflowCatalog);
  const assessment = decodeAutoAssessment(input.assessment, request, workflowCatalog);
  const decision = decodeWorkflowDecision(input.decision, request, assessment, workflowCatalog);
  const selection = await validateDocumentationMaturityCascadeSelection(input.maturitySelection, {
    assessment: input.maturityAssessment,
    trackerObservation: input.maturityTrackerObservation,
    policyWorkspace: input.policyWorkspace,
  });
  const currentIndex = await buildContentIndexV2({ workspace: input.policyWorkspace });
  if (
    currentIndex.repository.revision !== input.repository.revision ||
    currentIndex.repository.contentDigest !== input.repository.contentDigest
  ) {
    throw new AutoRoadmapError("stale-repository");
  }
  assertBindings(input, request, assessment, selection);
  const managedState = managedIssueTrackerObservationStateV1(input.managedTrackerObservation);
  const projected = projectSelectedMaturityFinding(
    input.maturityAssessment,
    request,
    assessment,
    decision,
    selection,
  );
  const planningInput = healthPlanningInput(input, projected);
  const initialPlanning = runReadOnlyPlanning(planningInput, trackerProjection(input, []));
  const exactFingerprints = new Map(
    initialPlanning.ledger.findings.map((finding) => {
      const identity = createManagedIssueIdentity(initialPlanning.ledger, finding.id);
      return [identity.marker.identityDigest, finding.fingerprint] as const;
    }),
  );
  const planningTracker = trackerProjection(input, [...exactFingerprints.entries()]);
  const planning = runReadOnlyPlanning(planningInput, planningTracker);
  const operationCap = boundedCap(input.operationCap);
  const operationInputs: RoadmapMutationOperationV2Input[] = [];
  const mutationMaterials: IssueLifecycleMutationMaterial[] = [];
  const reconciliations: AutoRoadmapReconciliationV1[] = [];
  const deferred = new Set<string>();
  const byCandidate = new Map(projected.map((item) => [item.candidate.id, item]));

  for (const proposal of planning.rankedProposals) {
    const projectedFinding = byCandidate.get(proposal.candidateId);
    const ledgerFinding = planning.ledger.findings.find((item) => item.id === proposal.findingId);
    if (!projectedFinding || !ledgerFinding) throw new AutoRoadmapError("projection-drift");
    const fingerprint =
      projectedFinding.workUnit?.workUnitFingerprint ?? projectedFinding.finding.fingerprint;
    if (proposal.action === "none") {
      reconciliations.push(
        reconciliation(
          ledgerFinding.id,
          fingerprint,
          "non-actionable",
          [],
          "read-only-planner-non-actionable",
        ),
      );
      continue;
    }
    const identity = createManagedIssueIdentity(planning.ledger, ledgerFinding.id);
    const linkedIssueIids = typedLinkEvidence(
      input.managedTrackerObservation,
      identity.marker.identityDigest,
    );
    const labels = managedLabels(projectedFinding);
    const managed = reconcileManagedIssue({
      identity,
      observations: [...managedState.reconcilerIssues],
      desiredLabels: labels,
    });
    const matchedManaged = input.managedTrackerObservation.issues.some(
      (issue) => issue.marker?.identityDigest === identity.marker.identityDigest,
    );
    if (proposal.action === "link" && !matchedManaged) {
      reconciliations.push(
        reconciliation(
          ledgerFinding.id,
          fingerprint,
          "non-actionable",
          [],
          "human-issue-not-explicitly-linked",
          proposal.issueIid,
          linkedIssueIids,
        ),
      );
      continue;
    }
    if (
      managed.disposition === "create" &&
      (proposal.action === "link" ||
        proposal.action === "extend" ||
        proposal.action === "supersede")
    ) {
      reconciliations.push(
        reconciliation(
          ledgerFinding.id,
          fingerprint,
          "non-actionable",
          [],
          "existing-disposition-without-managed-target",
          proposal.issueIid,
          linkedIssueIids,
        ),
      );
      continue;
    }
    const prepared = prepareManagedOperations(
      planning,
      projectedFinding,
      identity,
      labels,
      managed,
      managed.issueIid === undefined
        ? undefined
        : managedState.reconcilerIssues.find((issue) => issue.iid === managed.issueIid),
    );
    if (operationInputs.length + prepared.operations.length > operationCap) {
      deferred.add(fingerprint);
      reconciliations.push(
        reconciliation(
          ledgerFinding.id,
          fingerprint,
          "deferred-by-cap",
          [],
          "cycle-operation-cap",
          managed.issueIid,
          linkedIssueIids,
        ),
      );
      continue;
    }
    operationInputs.push(...prepared.operations);
    mutationMaterials.push(...prepared.materials);
    reconciliations.push(
      reconciliation(
        ledgerFinding.id,
        fingerprint,
        managed.disposition,
        prepared.operations.map((item) => item.key),
        managed.reasonCode,
        managed.issueIid,
        linkedIssueIids,
      ),
    );
  }

  const mutationPlan =
    operationInputs.length === 0
      ? null
      : createRoadmapMutationPlanV2(
          {
            id: `auto-plan:${roadmapDigest({ source: planning.sourceDigest }).slice(0, 32)}`,
            ledger: {
              kind: "roadmap-ledger",
              schemaVersion: 1,
              digest: planning.ledger.digest,
              repositoryRevision: planning.ledger.repository.revision,
              repositoryContentDigest: planning.ledger.repository.contentDigest,
            },
            repository: planning.ledger.repository,
            project: planning.ledger.project,
            trackerObservedAt: planning.ledger.trackerObservedAt,
            operations: operationInputs,
            generatedAt: input.managedTrackerObservation.observedAt,
            expiresAt: input.maturityTrackerObservation.expiresAt,
          },
          planning.ledger,
        );
  const materials =
    mutationPlan === null
      ? null
      : createIssueLifecycleMaterialBundle({
          planDigest: mutationPlan.digest,
          operations: mutationMaterials,
        });
  const deferredWorkUnitFingerprints = [...deferred].sort(compareText);
  const execution =
    mutationPlan === null || materials === null
      ? null
      : createAutoRoadmapExecutionPlanV1({
          source: {
            requestSha256: request.requestSha256,
            assessmentSha256: assessment.assessmentSha256,
            decisionSha256: decision.decisionSha256,
            maturityAssessmentSha256: input.maturityAssessment.assessmentSha256,
            maturitySelectionSha256: selection.selectionSha256,
            trackerObservationSha256: input.maturityTrackerObservation.observationSha256,
            managedTrackerObservationSha256: input.managedTrackerObservation.digest,
            planningArtifactSha256: planning.digest,
          },
          ledger: planning.ledger,
          plan: mutationPlan,
          materials,
          operationCap,
          deferredWorkUnitFingerprints,
        });
  const body = {
    kind: "docsfab-auto-roadmap-planning-result" as const,
    schemaVersion: 1 as const,
    readOnly: true as const,
    authorization: null,
    source: {
      requestSha256: request.requestSha256,
      assessmentSha256: assessment.assessmentSha256,
      decisionSha256: decision.decisionSha256,
      maturityAssessmentSha256: input.maturityAssessment.assessmentSha256,
      maturitySelectionSha256: selection.selectionSha256,
      trackerObservationSha256: input.maturityTrackerObservation.observationSha256,
      managedTrackerObservationSha256: input.managedTrackerObservation.digest,
    },
    planning,
    mutationPlan,
    materials,
    execution,
    reconciliations: reconciliations.sort((left, right) =>
      compareText(left.findingId, right.findingId),
    ),
    deferredWorkUnitFingerprints,
  };
  const result = freeze({ ...body, digest: roadmapDigest(body) });
  authenticPlanningResults.set(result, {
    digest: result.digest,
    sourceDigest: roadmapDigest(result.source),
    planningDigest: result.planning.digest,
  });
  return result;
}

/**
 * Assert that a planning result is the exact immutable object the planner
 * issued in this process. Serialized, copied, or rehashed projections are inert.
 */
export function assertAuthenticAutoRoadmapPlanningResultV1(
  value: unknown,
): AutoRoadmapPlanningResultV1 {
  const state =
    value && typeof value === "object" ? authenticPlanningResults.get(value) : undefined;
  if (!state) throw new AutoRoadmapError("invalid-plan");
  const result = value as AutoRoadmapPlanningResultV1;
  if (
    !Object.isFrozen(result) ||
    state.digest !== result.digest ||
    state.sourceDigest !== roadmapDigest(result.source) ||
    state.planningDigest !== result.planning.digest ||
    roadmapDigest(result) !== result.digest
  ) {
    throw new AutoRoadmapError("invalid-plan");
  }
  return result;
}

function assertBindings(
  input: PlanAutoRoadmapCycleInputV1,
  request: AutoCycleRequestV1,
  assessment: AutoAssessmentV1,
  selection: DocumentationMaturityCascadeSelectionV1,
): void {
  const repository = input.repository;
  if (
    request.repository.revision !== repository.revision ||
    request.repository.identitySha256 !== input.maturityAssessment.repository.identitySha256 ||
    request.repository.revision !== input.maturityAssessment.repository.revision ||
    selection.repository.revision !== repository.revision ||
    selection.repository.identitySha256 !== input.maturityAssessment.repository.identitySha256 ||
    selection.assessmentSha256 !== input.maturityAssessment.assessmentSha256 ||
    selection.trackerObservationSha256 !== input.maturityTrackerObservation.observationSha256 ||
    request.tracker.observationSha256 !== input.maturityTrackerObservation.observationSha256 ||
    request.tracker.projectIdentitySha256 !== canonicalDigest(input.project) ||
    request.tracker.observedAt !== input.maturityTrackerObservation.observedAt ||
    assessment.trackerObservationSha256 !== input.maturityTrackerObservation.observationSha256 ||
    canonicalDigest(input.project) !== input.maturityTrackerObservation.projectSha256 ||
    roadmapDigest(input.project) !== roadmapDigest(input.managedTrackerObservation.project) ||
    input.managedTrackerObservation.observedAt !== input.maturityTrackerObservation.observedAt
  ) {
    throw new AutoRoadmapError("binding-mismatch");
  }
}

function projectSelectedMaturityFinding(
  maturityAssessment: DocumentationMaturityCascadeAssessmentV1,
  request: AutoCycleRequestV1,
  assessment: AutoAssessmentV1,
  decision: WorkflowDecisionV1,
  selection: DocumentationMaturityCascadeSelectionV1,
): ProjectedFinding[] {
  if (decision.disposition !== "execute" || selection.outcome.state !== "selected") return [];
  const selected = selection.outcome.workUnit;
  const autoCandidate = assessment.candidates.find(
    (candidate) => candidate.candidateSha256 === decision.candidateSha256,
  );
  const assessmentReference = assessment.maturityFindings.find(
    (finding) => finding.fingerprint === selected.findingFingerprint,
  );
  if (
    !autoCandidate ||
    autoCandidate.workflow !== decision.workflow ||
    autoCandidate.workflow !== bindableCycleWorkflow(selected.workflow.name) ||
    (isRunnableWorkflowName(selected.workflow.name) &&
      !autoCandidate.stepIds.includes(selected.workflow.stepId)) ||
    !autoCandidate.maturityFindingFingerprints.includes(selected.findingFingerprint) ||
    !assessmentReference ||
    assessmentReference.findingSha256 === undefined ||
    !request.maturityFindingSha256s.includes(assessmentReference.findingSha256) ||
    selected.affectedPaths.some(
      (path) =>
        !autoCandidate.pathPrefixes.some(
          (prefix) => prefix === "." || path === prefix || path.startsWith(`${prefix}/`),
        ),
    )
  ) {
    throw new AutoRoadmapError("binding-mismatch");
  }
  const workUnits = maturityAssessment.gates.flatMap((gate) => gate.workUnits);
  const byFinding = new Map(workUnits.map((unit) => [unit.findingFingerprint, unit]));
  const workUnit = byFinding.get(selected.findingFingerprint);
  const findings = maturityAssessment.gates
    .flatMap((gate) => gate.findings)
    .filter(
      (finding) =>
        finding.fingerprint === selected.findingFingerprint &&
        finding.findingSha256 === assessmentReference.findingSha256 &&
        finding.confidence === assessmentReference.confidence &&
        finding.disposition === assessmentReference.disposition &&
        workUnit?.workUnitSha256 === selected.workUnitSha256,
    );
  if (findings.length !== 1 || !workUnit) throw new AutoRoadmapError("binding-mismatch");
  const candidateIds = new Map(
    findings.map((finding) => [
      finding.fingerprint,
      `candidate:${finding.fingerprint.slice(0, 32)}`,
    ]),
  );
  return findings
    .map((finding): ProjectedFinding => {
      const workUnit = byFinding.get(finding.fingerprint);
      const scopedPaths = [...finding.affectedPaths].sort(compareText);
      const unitIds = scopedPaths
        .map(
          (path) =>
            `unit:${roadmapDigest({ findingFingerprint: finding.fingerprint, path }).slice(0, 32)}`,
        )
        .sort(compareText);
      const evidenceDigest = workUnit?.workUnitSha256 ?? finding.findingSha256;
      const investigation =
        finding.disposition === "unknown" ||
        finding.disposition === "blocked" ||
        finding.confidence === "inconclusive" ||
        workUnit === undefined;
      const candidate: RoadmapPlanningCandidateInput = {
        id: candidateIds.get(finding.fingerprint)!,
        category: `maturity-${finding.gateId.toLowerCase()}`,
        severity: finding.issuePriority.toLowerCase() as "p0" | "p1" | "p2",
        disposition: maturityDisposition(finding),
        unitIds,
        affectedPaths: scopedPaths,
        evidenceDigest,
        rank: maturityRank(finding),
        review: {
          disposition: investigation ? "investigation" : "accepted",
          rationaleCode: investigation
            ? "maturity-investigation-required"
            : "maturity-evidence-accepted",
          evidenceDigest,
        },
        draft: {
          kind: investigation ? "investigation" : "issue",
          title: `Maturity ${finding.gateId}: ${finding.requirement.id}`,
          summary: `Resolve documentation maturity requirement ${finding.requirement.id}.`,
          acceptanceCriteria: workUnit?.acceptanceCriteria.map((criterion) => criterion.id) ?? [
            `Investigate ${finding.requirement.id}`,
          ],
          verification: workUnit?.verification.map(
            (verification) => `${verification.id}: ${verification.method}`,
          ) ?? ["Record bounded investigation evidence"],
          evidencePaths: scopedPaths,
          selfContained: true,
        },
        dependsOnCandidateIds: finding.dependencyFingerprints.flatMap((fingerprint) => {
          const id = candidateIds.get(fingerprint);
          return id === undefined ? [] : [id];
        }),
      };
      return { finding, ...(workUnit === undefined ? {} : { workUnit }), unitIds, candidate };
    })
    .sort((left, right) => compareText(left.candidate.id, right.candidate.id));
}

function healthPlanningInput(
  input: PlanAutoRoadmapCycleInputV1,
  projected: readonly ProjectedFinding[],
): RoadmapHealthPlanningInput {
  const units = projected
    .flatMap((item) =>
      item.candidate.affectedPaths.map((path, index) => ({
        id: item.unitIds[index]!,
        kind: "doc-audit" as const,
        path,
        evidenceDigest: item.workUnit?.workUnitSha256 ?? item.finding.findingSha256,
      })),
    )
    .sort((left, right) => compareText(left.id, right.id));
  const candidates = projected.map((item) => item.candidate);
  const auditBody = {
    kind: "authenticated-doc-audit-package" as const,
    schemaVersion: 1 as const,
    runId: `auto-maturity:${input.maturityAssessment.assessmentSha256.slice(0, 32)}`,
    workflow: "review-documentation" as const,
    status: "succeeded" as const,
    repositoryRevision: input.repository.revision,
    repositoryContentDigest: input.repository.contentDigest,
    projectIdentityDigest: roadmapDigest(input.project),
    findings: projected.map((item) => ({
      id: item.candidate.id,
      units: units.filter((unit) => item.unitIds.includes(unit.id)),
      affectedPaths: [...item.candidate.affectedPaths],
      evidenceDigest: item.candidate.evidenceDigest,
      candidateDigest: roadmapDigest(item.candidate),
    })),
  };
  return {
    kind: "docsfab-roadmap-planning-input",
    schemaVersion: 1,
    mode: "health",
    repository: input.repository,
    project: input.project,
    observedAt: input.managedTrackerObservation.observedAt,
    expiresAt: input.maturityTrackerObservation.expiresAt,
    units,
    candidates,
    semanticReconciliation: [],
    proposalCap: Math.max(1, projected.length),
    docAudit: { ...auditBody, digest: roadmapDigest(auditBody) },
  };
}

function runReadOnlyPlanning(
  input: RoadmapHealthPlanningInput,
  tracker: SanitizedRoadmapIssue[],
): RoadmapPlanningArtifact {
  const decoded = decodeRoadmapPlanningInput(input);
  const sourceDigest = roadmapDigest({ source: decoded });
  const capabilityKey = roadmapDigest({ sourceDigest, tracker });
  let source = planningCapabilities.get(capabilityKey);
  if (!source) {
    const host = internalCreateRoadmapPlanningHostAuthority(sourceDigest);
    source = internalIssueRoadmapPlanningSourceCapability(host, sourceDigest);
    planningCapabilities.set(capabilityKey, source);
  }
  return planRoadmap(decoded, tracker, source);
}

function trackerProjection(
  input: PlanAutoRoadmapCycleInputV1,
  exact: ReadonlyArray<readonly [string, string]>,
): SanitizedRoadmapIssue[] {
  const exactByMarker = new Map(exact);
  return input.managedTrackerObservation.issues.map((issue) => {
    const own = issue.marker && exactByMarker.get(issue.marker.identityDigest);
    return {
      iid: issue.iid,
      state: issue.state,
      updatedAt: issue.updatedAt,
      identityDigest: issue.identityDigest,
      findingFingerprints: own ? [own] : [],
      materialEvidenceDigests: [...issue.materialEvidenceDigests],
    };
  });
}

function prepareManagedOperations(
  planning: RoadmapPlanningArtifact,
  projected: ProjectedFinding,
  identity: ReturnType<typeof createManagedIssueIdentity>,
  labels: ManagedIssueLabels,
  managed: ManagedIssueReconciliation,
  observedManaged?: { labels: string[] },
): { operations: RoadmapMutationOperationV2Input[]; materials: IssueLifecycleMutationMaterial[] } {
  const finding = planning.ledger.findings.find((item) => item.id === identity.findingId)!;
  if (managed.disposition === "migration" && managed.issueIid !== undefined) {
    const current = planning.ledger.tracker.find((item) => item.issueIid === managed.issueIid);
    if (!current) return { operations: [], materials: [] };
    const operationKey = `operation:migrate:${identity.marker.identityDigest.slice(0, 32)}`;
    const material: IssueLifecycleMutationMaterial = {
      operationKey,
      action: "comment",
      body: [
        "DocsFab managed-state migration verification.",
        `Marker identity: ${identity.marker.identityDigest}`,
        `Repository state: ${identity.repositoryStateDigest}`,
      ].join("\n\n"),
    };
    return {
      operations: [
        operationInput(
          operationKey,
          "comment",
          identity.findingId,
          {
            source: "ledger-observation",
            targetKey: `issue:${managed.issueIid}`,
          },
          [],
          [
            {
              source: "ledger-observation",
              targetKey: `issue:${managed.issueIid}`,
              observedAt: current.updatedAt,
              identityDigest: current.identityDigest,
            },
          ],
          "comment",
          material,
          "note",
        ),
      ],
      materials: [material],
    };
  }
  if (managed.disposition === "create") {
    const operationKey = `operation:create:${identity.marker.identityDigest.slice(0, 32)}`;
    const template = managedTemplate(projected, identity, labels, finding.evidenceIds);
    const draft = renderManagedIssueDraft(template);
    const material: IssueLifecycleMutationMaterial = {
      operationKey,
      action: template.kind === "saga" ? "create-saga" : "create-issue",
      title: draft.title,
      description: draft.description,
      labels: draft.labels,
    };
    return {
      operations: [
        operationInput(
          operationKey,
          "issue",
          identity.findingId,
          {
            source: "project",
            targetKey: `project:${planning.ledger.project.projectId}`,
          },
          [],
          [],
          "create",
          material,
        ),
      ],
      materials: [material],
    };
  }
  if (managed.disposition !== "reuse" || !managed.patch?.labels || managed.issueIid === undefined) {
    return { operations: [], materials: [] };
  }
  const current = planning.ledger.tracker.find((item) => item.issueIid === managed.issueIid);
  if (!current || !observedManaged) return { operations: [], materials: [] };
  const desired = new Set(managed.patch.labels);
  const present = new Set(observedManaged.labels);
  const remove = [...present].filter((label) => !desired.has(label)).sort(compareText);
  const add = [...desired].filter((label) => !present.has(label)).sort(compareText);
  const operations: RoadmapMutationOperationV2Input[] = [];
  const materials: IssueLifecycleMutationMaterial[] = [];
  let dependency: string | undefined;
  for (const [action, names] of [
    ["remove-labels", remove],
    ["add-labels", add],
  ] as const) {
    if (names.length === 0) continue;
    const key = `operation:${action}:${identity.marker.identityDigest.slice(0, 32)}`;
    const material: IssueLifecycleMutationMaterial = { operationKey: key, action, labels: names };
    const target =
      dependency === undefined
        ? { source: "ledger-observation" as const, targetKey: `issue:${managed.issueIid}` }
        : {
            source: "dependency-result" as const,
            operationKey: dependency,
            effectKind: "issue" as const,
          };
    const preconditions =
      dependency === undefined
        ? [
            {
              source: "ledger-observation" as const,
              targetKey: `issue:${managed.issueIid}`,
              observedAt: current.updatedAt,
              identityDigest: current.identityDigest,
            },
          ]
        : [
            {
              source: "dependency-result" as const,
              operationKey: dependency,
              effectKind: "issue" as const,
            },
          ];
    operations.push(
      operationInput(
        key,
        "label",
        identity.findingId,
        target,
        dependency === undefined ? [] : [dependency],
        preconditions,
        "assign-label",
        material,
      ),
    );
    materials.push(material);
    dependency = key;
  }
  return { operations, materials };
}

function operationInput(
  key: string,
  kind: "issue" | "label" | "comment",
  findingId: string,
  target: RoadmapMutationOperationV2Input["target"],
  dependsOnOperationKeys: string[],
  preconditions: RoadmapMutationOperationV2Input["preconditions"],
  intent: "create" | "assign-label" | "comment",
  material: IssueLifecycleMutationMaterial,
  effectKind: "issue" | "note" = "issue",
): RoadmapMutationOperationV2Input {
  return {
    key,
    kind,
    findingIds: [findingId],
    dependsOnOperationKeys,
    target,
    preconditions,
    proposal: { kind, intent, effectKind },
    materialDigest: mutationMaterialDigest(material),
    materialBytes: mutationMaterialBytes(material),
    expectedEffectKind: effectKind,
  };
}

function managedTemplate(
  projected: ProjectedFinding,
  identity: ReturnType<typeof createManagedIssueIdentity>,
  labels: ManagedIssueLabels,
  evidence: string[],
): ManagedIssueTemplateInput {
  const finding = projected.finding;
  return {
    kind:
      projected.workUnit === undefined || finding.confidence === "inconclusive"
        ? "investigation"
        : "task",
    summary: `${finding.gateId} ${finding.requirement.id}`,
    identity,
    labels,
    evidence: [...evidence],
    rationale: `Documentation maturity disposition: ${finding.disposition}.`,
    audienceImpact:
      finding.audienceImpact.map((impact) => `${impact.audience}: ${impact.impact}`).join("; ") ||
      "No audience impact recorded.",
    pathScope: [...finding.affectedPaths],
    acceptance: projected.workUnit?.acceptanceCriteria.map((item) => item.id) ?? [
      `Investigate ${finding.requirement.id}`,
    ],
    verification: projected.workUnit?.verification.map((item) => `${item.id}: ${item.method}`) ?? [
      "Record bounded investigation evidence",
    ],
    dependencies: finding.dependencyFingerprints.map((item) => `finding:${item}`),
    requiredHumanInput: finding.requiredHumanInput
      .filter((item) => item.status === "missing")
      .map((item) => item.id),
  };
}

function managedLabels(projected: ProjectedFinding): ManagedIssueLabels {
  return {
    gate: projected.finding.gateId.toLowerCase() as ManagedIssueLabels["gate"],
    workflow: managedWorkflow(projected),
    priority: projected.finding.issuePriority.toLowerCase() as ManagedIssueLabels["priority"],
    lifecycle: projected.workUnit?.execution.state === "ready" ? "ready" : "blocked",
  };
}

function managedWorkflow(projected: ProjectedFinding): ManagedIssueLabels["workflow"] {
  const workflow = projected.workUnit?.workflow.name ?? projected.finding.workflow.name;
  if (workflow === "release-documentation-readiness") return "release-documentation";
  if (workflow === "review-documentation" || workflow === "readiness")
    return "documentation-health";
  if (workflow === "update-documentation") return "content-repair";
  if (workflow === "ia-analysis" || workflow === "ia-plan") return "information-architecture";
  return "investigation";
}

function maturityDisposition(
  finding: DocumentationMaturityFindingV1,
): RoadmapPlanningCandidateInput["disposition"] {
  if (finding.disposition === "satisfied") return "healthy";
  if (finding.disposition === "not-applicable") return "excluded";
  if (finding.disposition === "blocked") return "blocked";
  if (finding.disposition === "unknown") return "investigate";
  return "repair";
}

function maturityRank(
  finding: DocumentationMaturityFindingV1,
): RoadmapPlanningCandidateInput["rank"] {
  const impact = finding.audienceImpact.some((item) => item.impact === "blocked")
    ? 4
    : finding.audienceImpact.some((item) => item.impact === "degraded")
      ? 3
      : 1;
  const urgency = ({ P0: 4, P1: 3, P2: 2 } as const)[finding.issuePriority];
  const confidence = ({ confirmed: 1, bounded: 0.8, inconclusive: 0.4 } as const)[
    finding.confidence
  ];
  return {
    impact,
    urgency,
    dependency: Math.min(4, finding.dependencyFingerprints.length),
    scope: Math.min(4, finding.affectedPaths.length),
    verificationCost: Math.min(4, finding.verification.length),
    confidence,
  };
}

function reconciliation(
  findingId: string,
  workUnitFingerprint: string,
  disposition: AutoRoadmapReconciliationDispositionV1,
  operationKeys: string[],
  reasonCode: string,
  issueIid?: number,
  linkedIssueIids: number[] = [],
): AutoRoadmapReconciliationV1 {
  return {
    findingId,
    workUnitFingerprint,
    disposition,
    ...(issueIid === undefined ? {} : { issueIid }),
    linkedIssueIids: [...linkedIssueIids].sort((left, right) => left - right),
    operationKeys,
    reasonCode,
  };
}

function typedLinkEvidence(
  observation: ManagedIssueTrackerObservationV1,
  markerIdentityDigest: string,
): number[] {
  const byIid = new Map(observation.issues.map((issue) => [issue.iid, issue]));
  return observation.issues
    .flatMap((issue) =>
      issue.links.some(
        (link) => byIid.get(link.targetIid)?.marker?.identityDigest === markerIdentityDigest,
      )
        ? [issue.iid]
        : [],
    )
    .sort((left, right) => left - right);
}

function boundedCap(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 25) {
    throw new AutoRoadmapError("operation-cap-exceeded");
  }
  return value;
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
