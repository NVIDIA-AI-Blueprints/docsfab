// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SealedStepEvidenceBindingV1 } from "../execution/contracts.js";
import type { RunRecord } from "../records/contracts.js";
import type {
  DocumentationGapLedgerV1,
  DocumentationSearchFindingV1,
} from "../search/gap-ledger.js";
import type { RepositoryBatchReplayAuthorityV1 } from "../repository/inventory.js";
import type { RepositoryDiscoveryInventoryV1 } from "../repository/inventory.js";
import type {
  SearchMode,
  WorkflowSearchStepEvidenceV1,
  WorkflowStep,
} from "../workflow-contracts/contracts.js";

export class SearchParticipationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "SearchParticipationError";
  }
}

export interface LastSearchObservation {
  stepId: string;
  /**
   * The step whose `observe` produced this evidence; a reusing step
   * re-remembers it under its own `stepId`, so `stepId` alone misattributes.
   */
  observedByStepId: string;
  searchMode: SearchMode;
  planId: string;
  workspaceSnapshotSha256: string;
  searchEvidence: WorkflowSearchStepEvidenceV1;
  searchFindings: DocumentationSearchFindingV1[];
  gapLedger: DocumentationGapLedgerV1;
  repositoryBatchAuthority?: RepositoryBatchReplayAuthorityV1;
  trustedInventory?: RepositoryDiscoveryInventoryV1;
}

export interface SearchParticipationState {
  writeSinceLastSearch: boolean;
  lastByPlanId: Map<string, LastSearchObservation>;
}

export function createSearchParticipationState(): SearchParticipationState {
  return { writeSinceLastSearch: false, lastByPlanId: new Map() };
}

export function resolveSearchParticipation(input: {
  step: WorkflowStep;
  state: SearchParticipationState;
}): { mode: SearchMode; last: LastSearchObservation | undefined } | undefined {
  if (!input.step.search) {
    if (input.step.searchMode) {
      throw new SearchParticipationError(
        `Workflow step "${input.step.id}" declares searchMode without a search plan.`,
      );
    }
    return undefined;
  }
  const mode = input.step.searchMode;
  if (!mode) {
    throw new SearchParticipationError(
      `Workflow step "${input.step.id}" declares a search plan without searchMode.`,
    );
  }
  const last = input.state.lastByPlanId.get(input.step.search.id);
  if (mode === "observe" && last) {
    throw new SearchParticipationError(
      `Workflow step "${input.step.id}" cannot observe search plan "${input.step.search.id}" because this run already observed it.`,
    );
  }
  if ((mode === "revalidate" || mode === "reuse") && !last) {
    throw new SearchParticipationError(
      `Workflow step "${input.step.id}" cannot ${mode} search plan "${input.step.search.id}" without an earlier observe.`,
    );
  }
  if (mode === "reuse" && input.state.writeSinceLastSearch) {
    throw new SearchParticipationError(
      `Workflow step "${input.step.id}" cannot reuse search evidence after the workspace snapshot changed.`,
    );
  }
  return { mode, last };
}

export function rememberSearchObservation(
  state: SearchParticipationState,
  observation: LastSearchObservation,
): void {
  state.lastByPlanId.set(observation.planId, observation);
  state.writeSinceLastSearch = false;
}

export function markAuthorizedWrite(state: SearchParticipationState): void {
  state.writeSinceLastSearch = true;
}

export function authorizedWritePaths(record: RunRecord): readonly string[] {
  return (record.changes?.files ?? []).map((file) => file.path);
}

export function sealedEvidenceBindings(
  step: WorkflowStep,
  record: RunRecord,
): SealedStepEvidenceBindingV1[] | undefined {
  const consumed = step.consumesEvidence ?? [];
  if (consumed.length === 0) return undefined;
  return consumed.map((stepId) => {
    const prior = record.steps.find((candidate) => candidate.id === stepId);
    if (!prior || prior.status !== "succeeded") {
      throw new SearchParticipationError(
        `Workflow step "${step.id}" requires sealed evidence from earlier step "${stepId}".`,
      );
    }
    return {
      stepId,
      ...(prior.searchEvidence
        ? { searchEvidenceSha256: prior.searchEvidence.evidenceSha256 }
        : {}),
      ...(prior.gapLedger ? { gapLedgerSha256: prior.gapLedger.ledgerSha256 } : {}),
      ...(prior.evaluateEvidence
        ? { evaluateEvidenceSha256: prior.evaluateEvidence.evaluatorIdentitySha256 }
        : {}),
    };
  });
}
