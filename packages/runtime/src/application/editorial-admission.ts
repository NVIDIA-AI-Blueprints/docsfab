// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ArtifactReference } from "../artifacts/index.js";
import type { ContentIndexV1 } from "../content-ir/contracts.js";
import {
  observeReaderTaskContextAdmissionV1,
  type ReaderSourceHintV1,
  type ReaderTaskContextObservationV1,
} from "../execution/reader-task-admission.js";
import type {
  ReaderTaskContextInputProjectionV1,
  ReaderTaskContextSupplier,
} from "../execution/task-context.js";
import type { ReaderComparisonRequestV1 } from "../search/change-impact.js";
import type { WorkflowBranchEvidenceHost } from "../workflow-contracts/contracts.js";
import { assembleEditorialEvidenceFromAdmissionV1 } from "../workflow-execution/editorial-evidence-assembly.js";
import type {
  EditorialAdmissionControlV1,
  EditorialPlannedPageAdmissionV1,
} from "../workflow-execution/runner.js";

/** Combined change_scope + refresh hints must stay at the admission ceiling. */
const MAX_READER_SOURCE_NOMINATIONS = 128;

/** Already-observed reader evidence the local UPDATE path binds into runner admission. */
export interface AssembleEditorialAdmissionControlInputV1 {
  readonly artifactRoot: string;
  readonly contentIndex?: ContentIndexV1;
  readonly readerTaskContext?: ReaderTaskContextInputProjectionV1;
  readonly observation?: ReaderTaskContextObservationV1;
  readonly supplier?: ReaderTaskContextSupplier;
  readonly repositoryPath: string;
  readonly revision: string;
  readonly initialSourceHints: readonly ReaderSourceHintV1[];
  readonly comparisonRequest?: ReaderComparisonRequestV1;
  readonly capRefreshNominations?: boolean;
  readonly retainsVirtualRequest?: boolean;
  readonly requestEvidenceText?: string;
}

/** Live editorial admission plus the evidence host refresh may replace. */
export interface EditorialAdmissionAssemblyV1 {
  readonly editorialAdmission: EditorialAdmissionControlV1;
  readonly editorialEvidenceRefs?: readonly ArtifactReference[];
  readonly workflowBranchEvidence: WorkflowBranchEvidenceHost;
}

/**
 * Assemble presentation-free UPDATE editorial admission from observed reader
 * evidence. Planned-page refresh re-observes and re-assembles the same way.
 */
export async function assembleEditorialAdmissionControlV1(
  input: AssembleEditorialAdmissionControlInputV1,
): Promise<EditorialAdmissionAssemblyV1 | undefined> {
  const { contentIndex, readerTaskContext, observation, supplier } = input;
  if (!contentIndex || !readerTaskContext || !observation || !supplier) {
    return undefined;
  }
  const assembled = await assembleEditorialEvidenceFromAdmissionV1({
    artifactRoot: input.artifactRoot,
    index: contentIndex,
    readerTaskContext,
    observation,
    supplier,
  });
  let editorialEvidenceRefs = assembled.editorialEvidenceRefs;
  let workflowBranchEvidence = assembled.workflowBranchEvidence;
  const editorialAdmission: EditorialAdmissionControlV1 = {
    comparison: observation.admission.comparison,
    sources: observation.admission.sources.map((source) => ({
      uri: source.uri,
      sha256: source.sha256,
      role: source.role,
    })),
    ...(editorialEvidenceRefs ? { editorialEvidenceRefs } : {}),
    refreshForPlannedPages: async (pages): Promise<EditorialPlannedPageAdmissionV1> => {
      const plannedHints = pages.map((path) => ({
        role: "current-documentation" as const,
        path,
      }));
      const uniqueHints = uniqueReaderSourceHints([...plannedHints, ...input.initialSourceHints]);
      const changeScopeCount = readerTaskContext.readerContextInput.change_scope.length;
      const refreshHints = input.capRefreshNominations
        ? uniqueHints.slice(0, Math.max(1, MAX_READER_SOURCE_NOMINATIONS - changeScopeCount))
        : uniqueHints;
      const refreshedObservation = await observeReaderTaskContextAdmissionV1({
        repositoryPath: input.repositoryPath,
        revision: input.revision,
        observationMode: "workflow-export",
        readerContextInput: readerTaskContext.readerContextInput,
        comparisonRequest: input.comparisonRequest,
        sourceHints: refreshHints,
        ...(input.capRefreshNominations
          ? {
              onMissingSource: () => undefined,
            }
          : {}),
        ...(input.retainsVirtualRequest && input.requestEvidenceText
          ? { requestText: input.requestEvidenceText }
          : {}),
      });
      const refreshed = await assembleEditorialEvidenceFromAdmissionV1({
        artifactRoot: input.artifactRoot,
        index: contentIndex,
        readerTaskContext,
        observation: refreshedObservation,
        supplier,
      });
      workflowBranchEvidence = refreshed.workflowBranchEvidence;
      editorialEvidenceRefs = refreshed.editorialEvidenceRefs;
      return {
        workflowBranchEvidence: refreshed.workflowBranchEvidence,
        editorialEvidenceRefs: refreshed.editorialEvidenceRefs,
        sources: refreshedObservation.admission.sources.map((source) => ({
          uri: source.uri,
          sha256: source.sha256,
          role: source.role,
        })),
        comparison: refreshedObservation.admission.comparison,
      };
    },
  };
  return {
    editorialAdmission,
    get editorialEvidenceRefs() {
      return editorialEvidenceRefs;
    },
    get workflowBranchEvidence() {
      return workflowBranchEvidence;
    },
  };
}

function uniqueReaderSourceHints(hints: readonly ReaderSourceHintV1[]): ReaderSourceHintV1[] {
  const unique = new Map<string, ReaderSourceHintV1>();
  for (const hint of hints) {
    const key = `${hint.role}\0${hint.path}`;
    if (!unique.has(key)) unique.set(key, hint);
  }
  return [...unique.values()];
}
