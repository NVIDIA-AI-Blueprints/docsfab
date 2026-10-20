// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * V2 prefix-complete editorial bind inside WorkflowRunner.run: planned-page
 * refresh, host-directed update, candidate admission, and bound suffix
 * selection. WorkflowRunner remains the composition root and owns schedule
 * and terminal outcome.
 */
import type { ArtifactReference } from "../artifacts/contracts.js";
import {
  bindHostOwnedEditorialProposalIdentityV1,
  hostBindDirectedUpdateProposalV1,
} from "../artifacts/editorial-decision.js";
import { canonicalJson } from "../content-ir/canonical.js";
import { plannerGovernedInputOutcome } from "../evaluation-report/authoring-outcome-projector.js";
import type { HarnessStepResult, RunRequest } from "../execution/contracts.js";
import { createWorkflowBranchCoverageV1 } from "../records/composition-execution.js";
import type { RunRecord, StepRunRecord } from "../records/contracts.js";
import type {
  WorkflowBranchEvidenceHost,
  WorkflowBranchSelectionEvidenceV1,
  WorkflowContextPolicy,
  WorkflowDefinition,
  WorkflowStep,
} from "../workflow-contracts/contracts.js";
import { isWorkflowManifestV2, workflowSelectedPath } from "../workflow-contracts/contracts.js";
import {
  createWorkflowOutcome,
  workflowOutcomeArtifactEvidence,
  workflowOutcomeStepEvidence,
  type WorkflowOutcomeDecodeOptionsV1,
} from "../workflow-contracts/outcome.js";
import {
  documentationPlanVerificationPaths,
  documentationPlanPagePaths,
  type AdmittedDocumentationPlanBinding,
} from "./plan-binding.js";
import {
  editorialSelectErrorCode,
  hostOwnedEditorialIdentity,
  rejectedProposalDigest,
  shouldHostBindDirectedUpdate,
  synthesizeEditorialInputAskSlots,
  uniqueDocumentationPaths,
  type EditorialAdmissionControlV1,
  type EditorialSelectStopCode,
  type FirstPassDocumentationTargetControl,
  type WorkflowRunnerOptions,
} from "./runner-ports.js";
import { durationMs, type ProgressEventInput } from "./runner-schedule.js";
import { addUniqueArtifacts, normalizeArtifactUses } from "./runner-step.js";

export interface EditorialWorkflowBindSession {
  editorialHost: WorkflowBranchEvidenceHost | undefined;
  editorialAdmissionState: EditorialAdmissionControlV1 | undefined;
  admittedEditorialEvidenceRefs: ArtifactReference[];
  branchSelection: WorkflowBranchSelectionEvidenceV1 | undefined;
  executionSteps: WorkflowStep[];
  executionContextPolicy: WorkflowContextPolicy;
  selectedHasWriteStep: boolean;
}

export interface EditorialWorkflowBindInput {
  readonly options: WorkflowRunnerOptions;
  readonly timestamp: () => string;
  readonly emit: (event: ProgressEventInput) => void;
  readonly request: RunRequest;
  readonly workflow: WorkflowDefinition;
  readonly step: WorkflowStep;
  readonly stepRecord: StepRunRecord;
  readonly record: RunRecord;
  readonly completedStepResult: HarnessStepResult | undefined;
  readonly planBindings: Map<string, AdmittedDocumentationPlanBinding>;
  readonly validatedFirstPassTargetControl: FirstPassDocumentationTargetControl | undefined;
  readonly decodeOptions: () => WorkflowOutcomeDecodeOptionsV1;
  readonly session: EditorialWorkflowBindSession;
}

export type EditorialWorkflowBindResult =
  | { readonly kind: "continue" }
  | { readonly kind: "return"; readonly record: RunRecord };

/**
 * The limitation an `insufficient-evidence` stop records when the admitted
 * candidate names none, as every host-filled planner judgment does.
 */
export const EDITORIAL_UNSTATED_INSUFFICIENCY_LIMITATION = "insufficient-evidence";

/**
 * After the V2 prefix step named by `selection.afterStepId`, bind host-owned
 * editorial identity, optionally host-bind a directed update, admit the
 * candidate artifact, and append the selected suffix. Early InputAsk stops
 * return the record so WorkflowRunner.run can exit without further steps.
 */
export async function bindEditorialWorkflowBranch(
  input: EditorialWorkflowBindInput,
): Promise<EditorialWorkflowBindResult> {
  const {
    options,
    timestamp,
    emit,
    request,
    workflow,
    step,
    stepRecord,
    record,
    completedStepResult,
    planBindings,
    validatedFirstPassTargetControl,
    decodeOptions,
    session,
  } = input;
  if (!isWorkflowManifestV2(workflow) || step.id !== workflow.branching.selection.afterStepId) {
    return { kind: "continue" };
  }

  const retainEditorialInsufficientOutcome = (limitations: readonly string[]): void => {
    const plannerEvidence = workflowOutcomeStepEvidence(
      record,
      workflow.branching.selection.afterStepId,
    );
    const candidateUse = (record.artifacts ?? []).find(
      (use) =>
        use.role === "output" &&
        use.stepId === workflow.branching.selection.afterStepId &&
        use.reference.kind === "editorial-decision",
    );
    if (!candidateUse || limitations.length === 0) {
      throw new Error(
        "Editorial insufficiency evidence is unavailable for workflow outcome binding.",
      );
    }
    const candidateEvidence = workflowOutcomeArtifactEvidence(record, candidateUse);
    const evidence = [plannerEvidence, candidateEvidence];
    record.workflowOutcome = createWorkflowOutcome(
      {
        disposition: "inconclusive",
        findings: limitations.map((limitation) => ({
          id: `finding:editorial:${limitation}`,
          kind: "evidence-limitation",
          severity: "warning",
          code: limitation,
          evidenceIds: evidence.map((item) => item.id),
        })),
        evidence,
        limitations: [...limitations],
        openDecisions: [],
        producedArtifacts: [candidateUse.reference],
      },
      record,
      decodeOptions(),
    );
  };

  const prefixSnapshotSha256 =
    stepRecord.searchEvidence?.workspaceSnapshotSha256 ??
    request.readerContextProvenance?.workspace_snapshot_sha256;
  if (prefixSnapshotSha256) {
    record.workflowBranchCoverage = createWorkflowBranchCoverageV1({
      workflow,
      repositoryRevision: record.repository.revision,
      workspaceSnapshotSha256: prefixSnapshotSha256,
      selection: null,
    });
  }
  const proposal = completedStepResult?.editorialDecisionProposal;
  const stopEditorialSelectNeedsInput = async (stopInput: {
    readonly code: EditorialSelectStopCode;
    readonly proposal: unknown;
  }): Promise<RunRecord> => {
    const comparisonUnknown =
      (session.editorialAdmissionState?.comparison.kind ?? "unknown") === "unknown";
    const sourceRoles = (session.editorialAdmissionState?.sources ?? []).map(
      (source) => source.role,
    );
    const plan = planBindings.get("plan-documentation");
    const planPages = plan ? documentationPlanVerificationPaths(plan) : [];
    const slots = synthesizeEditorialInputAskSlots({
      code: stopInput.code,
      comparisonUnknown,
      sourceRoles,
      planPages,
      // Without a write grant the run can only assess, so it also asks for the
      // accepted knowledge an assessment needs. With the grant it is not an
      // assessment, whatever the request says.
      assessmentOnly: !request.allowWrite,
    });
    stepRecord.status = "needs-input";
    stepRecord.error = `editorial-select:${stopInput.code}:${rejectedProposalDigest(
      stopInput.proposal,
    )}`;
    record.status = "needs-input";
    record.completedAt = timestamp();
    record.durationMs = durationMs(record.startedAt, record.completedAt);
    const plannerEvidence = workflowOutcomeStepEvidence(record, step.id);
    const producedArtifacts: ArtifactReference[] = [];
    for (const use of record.artifacts ?? []) {
      if (
        use.role !== "output" ||
        producedArtifacts.some((item) => canonicalJson(item) === canonicalJson(use.reference))
      ) {
        continue;
      }
      producedArtifacts.push(use.reference);
    }
    producedArtifacts.sort((left, right) =>
      canonicalJson(left).localeCompare(canonicalJson(right)),
    );
    record.workflowOutcome = createWorkflowOutcome(
      {
        disposition: "needs-input",
        findings: slots.map((slot) => ({
          id: `finding:editorial:${slot.inputId}`,
          kind: "missing-governed-input",
          severity: "warning",
          code: slot.code,
          inputId: slot.inputId,
          evidenceIds: [plannerEvidence.id],
        })),
        evidence: [plannerEvidence],
        limitations: [],
        openDecisions: slots.map((slot) => ({
          id: `decision:editorial:${slot.inputId}`,
          kind: "governed-input",
          inputId: slot.inputId,
          evidenceIds: [plannerEvidence.id],
        })),
        producedArtifacts,
      },
      record,
      decodeOptions(),
    );
    await options.store.save(record);
    emit({ type: "run-status", runId: record.id, status: record.status });
    return record;
  };
  try {
    const plan = planBindings.get("plan-documentation");
    if (plan && session.editorialAdmissionState?.refreshForPlannedPages) {
      const pages = uniqueDocumentationPaths([
        ...(validatedFirstPassTargetControl?.targetPaths ?? []),
        ...documentationPlanVerificationPaths(plan),
      ]);
      if (pages.length > 0) {
        const refreshed = await session.editorialAdmissionState.refreshForPlannedPages(pages);
        session.editorialHost = refreshed.workflowBranchEvidence;
        session.editorialAdmissionState = {
          comparison: refreshed.comparison,
          sources: refreshed.sources,
          editorialEvidenceRefs: refreshed.editorialEvidenceRefs,
          refreshForPlannedPages: session.editorialAdmissionState.refreshForPlannedPages,
        };
        session.admittedEditorialEvidenceRefs = [...refreshed.editorialEvidenceRefs];
      }
    }
  } catch {
    // Planned pages stay unadmitted; select() then retains a typed InputAsk.
  }
  if (!session.editorialHost || proposal === undefined) {
    record.status = "needs-input";
    record.completedAt = timestamp();
    record.durationMs = durationMs(record.startedAt, record.completedAt);
    // An admitted planner governed-input stop is a sealed needs-input outcome,
    // as for restructure and create. Retained branch coverage is admissible
    // only through the editorial host's decoder, so without that host the stop
    // keeps its unsealed planner projection.
    const plannerStop = plannerGovernedInputOutcome(record);
    if (
      plannerStop &&
      (session.editorialHost !== undefined || record.workflowBranchCoverage === undefined)
    ) {
      record.workflowOutcome = createWorkflowOutcome(plannerStop, record, decodeOptions());
    }
    await options.store.save(record);
    emit({ type: "run-status", runId: record.id, status: record.status });
    return { kind: "return", record };
  }
  const editorialHost = session.editorialHost;
  const identity = hostOwnedEditorialIdentity({
    artifactEvidenceRefs: session.admittedEditorialEvidenceRefs,
    sources: session.editorialAdmissionState?.sources ?? [],
  });
  const plan = planBindings.get("plan-documentation");
  const comparisonUnknown =
    (session.editorialAdmissionState?.comparison.kind ?? "unknown") === "unknown";
  const planMutates = (plan ? documentationPlanPagePaths(plan).length : 0) > 0;
  const sourceRoles = new Set(
    (session.editorialAdmissionState?.sources ?? []).map((source) => source.role),
  );
  const identityAdmitted =
    identity.artifactEvidenceRefs.length > 0 &&
    identity.sourceEvidence.length > 0 &&
    sourceRoles.has("request") &&
    sourceRoles.has("current-documentation");
  let selectProposal: unknown = bindHostOwnedEditorialProposalIdentityV1(proposal, identity);
  if (
    identityAdmitted &&
    shouldHostBindDirectedUpdate({
      planMutates,
      allowWrite: request.allowWrite,
      comparisonUnknown,
    })
  ) {
    try {
      selectProposal = hostBindDirectedUpdateProposalV1(identity, request.instruction ?? "");
    } catch {
      return {
        kind: "return",
        record: await stopEditorialSelectNeedsInput({
          code: "evidence-unavailable",
          proposal,
        }),
      };
    }
  }
  let branchSelection: WorkflowBranchSelectionEvidenceV1;
  try {
    branchSelection = await editorialHost.select({
      workflow,
      record: structuredClone(record),
      proposal: selectProposal,
    });
  } catch (error) {
    return {
      kind: "return",
      record: await stopEditorialSelectNeedsInput({
        code: editorialSelectErrorCode(error),
        proposal: selectProposal,
      }),
    };
  }
  session.branchSelection = branchSelection;
  if (
    branchSelection.candidateArtifact.kind !== "editorial-decision" ||
    branchSelection.candidateArtifact.schemaVersion !== 3
  ) {
    return {
      kind: "return",
      record: await stopEditorialSelectNeedsInput({
        code: "evidence-unavailable",
        proposal: selectProposal,
      }),
    };
  }
  const candidateUse = normalizeArtifactUses(
    [{ role: "output", reference: branchSelection.candidateArtifact }],
    step.id,
    record.repository.revision,
  );
  stepRecord.artifacts ??= [];
  addUniqueArtifacts(stepRecord.artifacts, candidateUse);
  record.artifacts ??= [];
  addUniqueArtifacts(record.artifacts, candidateUse);
  record.workflowBranchCoverage = createWorkflowBranchCoverageV1({
    workflow,
    repositoryRevision: record.repository.revision,
    workspaceSnapshotSha256: branchSelection.workspaceSnapshotSha256,
    selection: null,
  });
  if (branchSelection.candidate === "insufficient-evidence") {
    if (branchSelection.branchId !== null) {
      throw new Error("Insufficient editorial evidence cannot select a workflow suffix.");
    }
    record.status = "needs-input";
    record.completedAt = timestamp();
    record.durationMs = durationMs(record.startedAt, record.completedAt);
    // A planner judgment names no limitation code; the host-filled proposal
    // carries none, so the stop records the judgment itself.
    const { limitations } = branchSelection.editorialCandidate.proposal;
    retainEditorialInsufficientOutcome(
      limitations.length > 0 ? limitations : [EDITORIAL_UNSTATED_INSUFFICIENCY_LIMITATION],
    );
    await options.store.save(record);
    emit({ type: "run-status", runId: record.id, status: record.status });
    return { kind: "return", record };
  }
  const expectedBranch = branchSelection.candidate === "update" ? "author" : "assess-no-change";
  if (branchSelection.branchId !== expectedBranch) {
    throw new Error("Editorial evidence selected an invalid workflow branch."); // hygiene: ok
  }
  const selectedPath = workflowSelectedPath(workflow, expectedBranch);
  const suffix = selectedPath.steps.slice(workflow.branching.prefix.steps.length);
  record.workflowBranchCoverage = createWorkflowBranchCoverageV1({
    workflow,
    repositoryRevision: record.repository.revision,
    workspaceSnapshotSha256: branchSelection.workspaceSnapshotSha256,
    selection: {
      branchId: expectedBranch,
      candidateArtifact: branchSelection.candidateArtifact,
    },
  });
  for (const suffixStep of suffix) {
    record.steps.push({
      id: suffixStep.id,
      title: suffixStep.title,
      kind: suffixStep.kind ?? "inference",
      ...(suffixStep.operation ? { operation: suffixStep.operation } : {}),
      skill: suffixStep.skill,
      mode: suffixStep.mode,
      status: "pending",
    });
  }
  await options.store.save(record);
  if (
    expectedBranch === "author" &&
    !suffix.some(
      (candidate) => candidate.id === "write-documentation" && candidate.mode === "write",
    )
  ) {
    throw new Error("Selected author workflow has no governed write barrier.");
  }
  session.executionSteps = [...session.executionSteps, ...suffix];
  session.executionContextPolicy = selectedPath.contextPolicy;
  session.selectedHasWriteStep = expectedBranch === "author";
  return { kind: "continue" };
}
