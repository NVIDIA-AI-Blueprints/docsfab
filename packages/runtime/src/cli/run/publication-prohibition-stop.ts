// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The interpretation half of the publication-prohibition guard. The request
 * text half refuses earlier, while `run` and `do` parse their arguments and
 * before any run record exists, so a run stopped here was stopped by the
 * interpretation's `non-publication` constraint, which its record keeps.
 */
import { randomUUID } from "node:crypto";

import type { DocsFabConfig } from "../../config/runtime-loader.js";
import { failureClassification } from "../../operator/failure-class.js";
import {
  classifyingRunStore,
  operatorCodeFailureClass,
} from "../../operator/failure-classification.js";
import type { RunRecord } from "../../records/contracts.js";
import { createIndexedFileRunStore } from "../../records/run-index-store.js";
import type { RepositoryWorkspace } from "../../repository/workspace/contracts.js";
import type { RunRecordRequestIntentV1 } from "../../request-intent/interpret-record.js";
import { emptyTools, emptyUsage } from "../../workflow-execution/runner-step.js";
import type { RequestInterpretationStep } from "./request-intent-stop.js";
import type { RunRequestWithPublishProjection } from "./request.js";

const PUBLICATION_PROHIBITION_CONFLICT = "publication-prohibition-conflict";

/**
 * The interpretation a run that goes on recorded, when its reading has a
 * `non-publication` constraint. Only narrows, so any reading the run goes on
 * with counts, admitted or not.
 */
export function interpretedNonPublication(
  step: RequestInterpretationStep,
): RunRecordRequestIntentV1 | undefined {
  if (step.kind !== "continue" || step.recorded === undefined) return undefined;
  const constraints = step.recorded.intent?.constraints ?? [];
  return constraints.some((constraint) => constraint.kind === "non-publication")
    ? step.recorded
    : undefined;
}

/** Whether the run delivers by publishing: a draft merge request or an MR review summary. */
export function runRequestPublishes(request: RunRequestWithPublishProjection): boolean {
  return (
    request.draftMr === true ||
    request.commentMr !== undefined ||
    request.commentMrBinding !== undefined
  );
}

/** Save the record of a run stopped before its first step by an interpreted prohibition. */
export async function persistPublicationProhibitionStop(input: {
  readonly request: RunRequestWithPublishProjection;
  readonly config: DocsFabConfig;
  readonly workspace: RepositoryWorkspace;
  readonly recorded: RunRecordRequestIntentV1;
}): Promise<RunRecord> {
  const now = new Date().toISOString();
  const record: RunRecord = {
    schemaVersion: 2,
    id: input.request.runId ?? randomUUID(),
    workflow: input.request.workflow,
    repository: {
      sourcePath: input.workspace.sourcePath,
      requestedRevision: input.workspace.requestedRevision,
      revision: input.workspace.revision,
    },
    workspace: { strategy: "tracked-export", disposable: true },
    ...(input.request.instruction ? { instruction: input.request.instruction } : {}),
    ...(input.request.instructionContext
      ? { instructionContext: input.request.instructionContext }
      : {}),
    status: "failed",
    error: PUBLICATION_PROHIBITION_CONFLICT,
    failure: failureClassification(
      operatorCodeFailureClass(PUBLICATION_PROHIBITION_CONFLICT) ?? "unknown",
      "workflow",
      PUBLICATION_PROHIBITION_CONFLICT,
    ),
    createdAt: now,
    completedAt: now,
    models: [],
    skills: [],
    usage: emptyUsage(),
    tools: emptyTools(),
    requestIntent: input.recorded,
    steps: [],
  };
  await classifyingRunStore(createIndexedFileRunStore(input.config.stateDirectory)).save(record);
  return record;
}
