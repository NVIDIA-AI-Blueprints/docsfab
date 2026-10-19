// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Keep a settled physical successor inspectable without replaying its claim. */
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalDigest } from "../contract-kit/index.js";
import { WORKFLOW_CANCELLED } from "../execution/cancellation.js";
import {
  attachRunFailureClassifications,
  classifyingRunStore,
  markRunThrownFailure,
} from "../operator/failure-classification.js";
import type { DocsFabConfig } from "../config/runtime-loader.js";
import type { RunRecord } from "../records/contracts.js";
import type { FirstPassChoiceV1 } from "../records/first-pass-choice.js";
import { FileRunStore, FileRunStoreError } from "../records/file-store.js";
import { createIndexedFileRunStore } from "../records/run-index-store.js";
import { runRecordMaxBytes } from "../records/run-record-limit.js";
import { decodeSavedRunRecord } from "../records/saved-run-record.js";
import { emptyTools, emptyUsage } from "../workflow-execution/runner-step.js";
import {
  FirstPassChoiceContinuationError,
  firstPassChoiceContinuationMessage,
} from "../cli/run/first-pass-choice-continuation.js";
import type { LiveFirstPassChoicePlanV1 } from "./first-pass-choice.js";

async function readFirstPassChoiceChild(input: {
  readonly stateDirectory: string;
  readonly repositoryPath: string;
  readonly plan: LiveFirstPassChoicePlanV1;
  readonly choices: readonly FirstPassChoiceV1[];
}): Promise<{ record: RunRecord; sha256: string } | undefined> {
  const id = input.choices.at(-1)!.successorRunId;
  let saved;
  try {
    saved = await new FileRunStore(input.stateDirectory).getWithDigest(id, {
      maxBytes: runRecordMaxBytes().value,
    });
  } catch (error) {
    if (error instanceof FileRunStoreError && error.code === "record-not-found") return undefined;
    throw error;
  }
  const child = decodeSavedRunRecord(saved.record as never, id);
  if (
    child.workflow !== input.plan.workflow ||
    child.instruction !== input.plan.instruction ||
    child.instructionContext !== input.plan.instructionContext ||
    child.repository.revision !== input.plan.revision ||
    realpathSync(resolve(child.repository.sourcePath)) !==
      realpathSync(resolve(input.repositoryPath)) ||
    canonicalDigest(child.firstPassChoices ?? []) !== canonicalDigest(input.choices)
  ) {
    throw new FirstPassChoiceContinuationError("tampered"); // hygiene: ok -- stable typed code; the constructor supplies the operator-safe message.
  }
  return { record: child, sha256: saved.sha256 };
}

export async function loadFirstPassChoiceChild(
  input: Parameters<typeof readFirstPassChoiceChild>[0],
): Promise<RunRecord | undefined> {
  return (await readFirstPassChoiceChild(input))?.record;
}

export async function settleFirstPassChoiceFailure(input: {
  readonly config: DocsFabConfig;
  readonly repositoryPath: string;
  readonly plan: LiveFirstPassChoicePlanV1;
  readonly choices: readonly FirstPassChoiceV1[];
  readonly requestIntent: RunRecord["requestIntent"];
  readonly createdAt: string;
  readonly workflowWorkStarted: boolean;
  readonly cancelled: boolean;
  readonly error: unknown;
}): Promise<RunRecord> {
  const savedRead = await readFirstPassChoiceChild({
    ...input,
    stateDirectory: input.config.stateDirectory,
  });
  const saved = savedRead?.record;
  if (saved && saved.status !== "queued" && saved.status !== "running") return saved;
  if (!saved && input.workflowWorkStarted) {
    throw new Error(
      `The successor reported workflow work, but its saved evidence is unavailable. Report allocated run ${input.choices.at(-1)!.successorRunId} to the DocsFab runtime owner; do not retry unchanged.`,
    );
  }
  const completedAt = new Date().toISOString();
  const record: RunRecord = saved ?? {
    schemaVersion: 2,
    id: input.choices.at(-1)!.successorRunId,
    workflow: input.plan.workflow,
    repository: {
      sourcePath: realpathSync(resolve(input.repositoryPath)),
      requestedRevision: input.plan.revision,
      revision: input.plan.revision,
    },
    workspace: { strategy: "tracked-export", disposable: true },
    instruction: input.plan.instruction,
    ...(input.plan.instructionContext !== undefined
      ? { instructionContext: input.plan.instructionContext }
      : {}),
    ...(input.requestIntent ? { requestIntent: input.requestIntent } : {}),
    firstPassChoices: [...input.choices],
    status: "running",
    createdAt: input.createdAt,
    models: [],
    skills: [],
    usage: emptyUsage(),
    tools: emptyTools(),
    steps: [],
  };
  record.status = "failed";
  record.error ??= input.cancelled
    ? WORKFLOW_CANCELLED
    : (firstPassChoiceContinuationMessage(input.error) ??
      "The bound choice successor stopped before a terminal workflow result was saved.");
  record.completedAt = completedAt;
  for (const step of record.steps) {
    if (step.status !== "running") continue;
    step.status = "failed";
    step.error ??= record.error;
    step.completedAt ??= completedAt;
  }
  markRunThrownFailure(record, input.error, {
    cancelled: input.cancelled,
    ...(input.error instanceof FileRunStoreError ? { storeCode: input.error.code } : {}),
  });
  const store = createIndexedFileRunStore(input.config.stateDirectory);
  if (savedRead) {
    attachRunFailureClassifications(record);
    await store.replaceIfDigest(record.id, savedRead.sha256, record, runRecordMaxBytes().value);
  } else {
    await classifyingRunStore(store).save(record);
  }
  return record;
}
