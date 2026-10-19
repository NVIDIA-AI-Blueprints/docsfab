// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { RunRequest } from "../../execution/contracts.js";
import type { RunRecord, StepRunRecord } from "../../records/contracts.js";
import {
  createDocumentationGapLedger,
  currentDocumentationGapFindings,
  negativeDocumentationEvidence,
  projectDocumentationSearchFindings,
} from "../../search/gap-ledger.js";
import { searchBriefOmissionWarning } from "../../search/model-search-brief.js";
import type { RepositoryDiscoveryInventoryV1 } from "../../repository/inventory.js";
import type {
  WorkflowDefinition,
  WorkflowSearchCoordinator,
  WorkflowSearchStepEvidenceV1,
  WorkflowStep,
} from "../../workflow-contracts/contracts.js";
import { appendEvidenceWarnings, workflowSearch } from "../runner-evidence.js";
import {
  authorizedWritePaths,
  rememberSearchObservation,
  resolveSearchParticipation,
  type SearchParticipationState,
} from "../search-participation.js";
import type { WorkflowRunnerOptions } from "../runner-ports.js";

interface StepSearchEvidenceInput {
  readonly activeWorkflowSearch: WorkflowSearchCoordinator | undefined;
  readonly step: WorkflowStep;
  readonly searchParticipation: SearchParticipationState;
  readonly session: { releaseTrustedInventory: RepositoryDiscoveryInventoryV1 | undefined };
  readonly stepRecord: StepRunRecord;
  readonly workflow: WorkflowDefinition;
  readonly record: RunRecord;
  readonly options: Pick<WorkflowRunnerOptions, "store">;
  readonly request: Pick<RunRequest, "repository" | "releaseDefaultBranch">;
  readonly activeWorkspacePath: string;
}

export async function prepareStepSearchEvidence(
  input: StepSearchEvidenceInput,
): Promise<WorkflowSearchStepEvidenceV1 | undefined> {
  const {
    activeWorkflowSearch,
    step,
    searchParticipation,
    session,
    stepRecord,
    workflow,
    record,
    options,
    request,
    activeWorkspacePath,
  } = input;
  let searchEvidence: WorkflowSearchStepEvidenceV1 | undefined;
  if (activeWorkflowSearch && step.search) {
    const participation = resolveSearchParticipation({
      step,
      state: searchParticipation,
    });
    if (participation?.mode === "reuse") {
      const last = participation.last;
      if (!last) {
        throw new Error(
          `Workflow step "${step.id}" cannot reuse search evidence that was never observed.`,
        );
      }
      searchEvidence = last.searchEvidence;
      if (last.trustedInventory) {
        session.releaseTrustedInventory = last.trustedInventory;
      }
      stepRecord.searchEvidence = last.searchEvidence;
      if (last.repositoryBatchAuthority) {
        stepRecord.repositoryBatchAuthority = last.repositoryBatchAuthority;
      }
      stepRecord.searchFindings = projectDocumentationSearchFindings({
        workflow: workflow.name,
        stepId: step.id,
        evidence: last.searchEvidence,
      });
      stepRecord.negativeEvidence = negativeDocumentationEvidence(stepRecord.searchFindings);
      stepRecord.gapLedger = createDocumentationGapLedger({
        currentRevision: record.repository.revision,
        findings: stepRecord.searchFindings,
        ...(record.gapLedger ? { priorLedgers: [record.gapLedger] } : {}),
      });
      record.gapLedger = stepRecord.gapLedger;
      record.searchFindings = currentDocumentationGapFindings(record.gapLedger);
      record.negativeEvidence = negativeDocumentationEvidence(record.searchFindings);
      stepRecord.searchParticipation = {
        schemaVersion: 1,
        kind: "docsfab-step-search-participation",
        planId: step.search!.id,
        searchMode: "reuse",
        observedByStepId: last.observedByStepId,
        searchEvidenceSha256: last.searchEvidence.evidenceSha256,
        workspaceSnapshotSha256: last.searchEvidence.workspaceSnapshotSha256,
      };
      rememberSearchObservation(searchParticipation, {
        stepId: step.id,
        observedByStepId: last.observedByStepId,
        searchMode: "reuse",
        planId: step.search!.id,
        workspaceSnapshotSha256: last.searchEvidence.workspaceSnapshotSha256,
        searchEvidence: last.searchEvidence,
        searchFindings: stepRecord.searchFindings,
        gapLedger: stepRecord.gapLedger,
        ...(last.repositoryBatchAuthority
          ? { repositoryBatchAuthority: last.repositoryBatchAuthority }
          : {}),
        ...(last.trustedInventory ? { trustedInventory: last.trustedInventory } : {}),
      });
      await options.store.save(record);
    } else if (step.search) {
      const searchResult = await workflowSearch({
        workflowSearch: activeWorkflowSearch,
        runId: record.id,
        repositoryPath: activeWorkspacePath,
        repository: record.repository,
        workflow,
        step,
        ...(request.releaseDefaultBranch
          ? { repositoryDefaultBranch: request.releaseDefaultBranch }
          : {}),
        ...(searchParticipation.writeSinceLastSearch
          ? { authorizedWritePaths: authorizedWritePaths(record) }
          : {}),
      });
      searchEvidence = searchResult?.evidence;
      if (searchEvidence && searchResult) {
        if (searchResult.trustedInventory) {
          session.releaseTrustedInventory = searchResult.trustedInventory;
        }
        // For example, an asset the workspace content index left out past a limit.
        appendEvidenceWarnings(record, searchResult.evidenceWarnings ?? []);
        stepRecord.searchEvidence = searchEvidence;
        if (searchResult.repositoryBatchAuthority) {
          stepRecord.repositoryBatchAuthority = searchResult.repositoryBatchAuthority;
        }
        stepRecord.searchFindings = projectDocumentationSearchFindings({
          workflow: workflow.name,
          stepId: step.id,
          evidence: searchEvidence,
        });
        stepRecord.negativeEvidence = negativeDocumentationEvidence(stepRecord.searchFindings);
        stepRecord.gapLedger = createDocumentationGapLedger({
          currentRevision: record.repository.revision,
          findings: stepRecord.searchFindings,
          ...(record.gapLedger ? { priorLedgers: [record.gapLedger] } : {}),
        });
        record.gapLedger = stepRecord.gapLedger;
        record.searchFindings = currentDocumentationGapFindings(record.gapLedger);
        record.negativeEvidence = negativeDocumentationEvidence(record.searchFindings);
        stepRecord.searchParticipation = {
          schemaVersion: 1,
          kind: "docsfab-step-search-participation",
          planId: step.search.id,
          searchMode: participation?.mode ?? "observe",
          observedByStepId: step.id,
          searchEvidenceSha256: searchEvidence.evidenceSha256,
          workspaceSnapshotSha256: searchEvidence.workspaceSnapshotSha256,
        };
        rememberSearchObservation(searchParticipation, {
          stepId: step.id,
          observedByStepId: step.id,
          searchMode: participation?.mode ?? "observe",
          planId: step.search.id,
          workspaceSnapshotSha256: searchEvidence.workspaceSnapshotSha256,
          searchEvidence,
          searchFindings: stepRecord.searchFindings,
          gapLedger: stepRecord.gapLedger,
          ...(searchResult.repositoryBatchAuthority
            ? { repositoryBatchAuthority: searchResult.repositoryBatchAuthority }
            : {}),
          ...(searchResult.trustedInventory
            ? { trustedInventory: searchResult.trustedInventory }
            : {}),
        });
        await options.store.save(record);
      }
    }
  }
  // Host operations render no model prompt, so only a model step's brief can omit paths.
  if (searchEvidence && (step.kind ?? "inference") !== "host-operation") {
    recordSearchBriefOmission(record, step.id, searchEvidence);
  }
  return searchEvidence;
}

/**
 * Record, when the step starts, any cited paths its search brief leaves out,
 * so the operator footer reports what the model was given rather than a later
 * recomputation. The brief itself is rendered from the same evidence.
 */
export function recordSearchBriefOmission(
  record: RunRecord,
  stepId: string,
  evidence: WorkflowSearchStepEvidenceV1,
): void {
  const warning = searchBriefOmissionWarning(stepId, evidence);
  if (!warning || record.evidenceWarnings?.includes(warning)) return;
  record.evidenceWarnings = [...(record.evidenceWarnings ?? []), warning];
}
