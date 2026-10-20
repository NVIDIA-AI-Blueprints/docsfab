// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Saved-run replay's read-only view of the run delivery index: which draft
 * merge request a saved run opened. `runs show` reaches the delivery index
 * only through this module, so the CLI command imports no delivery code.
 */
import { isProjectConfigPath } from "../delivery/run-record.js";
import { lookupSavedRunDelivery, type RunDeliveryLookup } from "../delivery/run-delivery-index.js";
import { lookupSavedRunRetainedDelivery as inspectSavedRunRetainedDelivery } from "../delivery/run-deletion-adapter.js";
import {
  unavailableRunRetainedDelivery,
  type RunRetainedDeliveryV1,
} from "../records/retained-delivery.js";
import type { RunRecord } from "../records/contracts.js";
import type { RunResultPublicationV1 } from "./run-result.js";

/** Same gate as draft-MR publication: a succeeded run whose patch changed documentation. */
export function runCarriesPublishablePatch(record: Pick<RunRecord, "status" | "changes">): boolean {
  return (
    record.status === "succeeded" &&
    (record.changes?.patch?.byteLength ?? 0) > 0 &&
    (record.changes?.files ?? []).some((file) => !isProjectConfigPath(file.path))
  );
}

/**
 * The PUBLICATION lookup for a saved run, or undefined for a run that could
 * not have opened a draft MR, so review, read-only, and no-change runs keep
 * their output and result digest unchanged. Never creates files.
 */
export async function lookupSavedRunPublication(input: {
  environment: NodeJS.ProcessEnv;
  stateDirectory: string;
  record: Pick<RunRecord, "id" | "status" | "changes">;
}): Promise<RunResultPublicationV1 | undefined> {
  if (!runCarriesPublishablePatch(input.record)) return undefined;
  return projectRunDeliveryLookup(
    await lookupSavedRunDelivery({
      environment: input.environment,
      stateDirectory: input.stateDirectory,
      runId: input.record.id,
    }),
  );
}

/** Independent of the MR index and verdict: a failed publication can retain local resources. */
export async function lookupSavedRunRetainedDelivery(input: {
  environment: NodeJS.ProcessEnv;
  stateDirectory: string;
  record: Pick<RunRecord, "id" | "status" | "changes">;
}): Promise<RunRetainedDeliveryV1 | undefined> {
  if (!runCarriesPublishablePatch(input.record)) return undefined;
  return inspectSavedRunRetainedDelivery({
    environment: input.environment,
    stateDirectory: input.stateDirectory,
    runId: input.record.id,
  }).catch(() => unavailableRunRetainedDelivery());
}

function projectRunDeliveryLookup(lookup: RunDeliveryLookup): RunResultPublicationV1 {
  if (lookup.status === "found") {
    return {
      status: "found",
      mergeRequestIid: lookup.entry.mergeRequestIid,
      mergeRequestUrl: lookup.entry.mergeRequestUrl,
      sourceBranch: lookup.entry.sourceBranch,
      targetBranch: lookup.entry.targetBranch,
      headRevision: lookup.entry.headRevision,
      disposition: lookup.disposition,
      receiptSha256AtOpen: lookup.receiptSha256AtOpen,
      receiptSha256Current: lookup.receiptSha256Current,
    };
  }
  if (lookup.status === "absent") {
    return { status: "absent", code: lookup.code, checkedRoot: lookup.checkedRoot };
  }
  return {
    status: "refused",
    code: lookup.code,
    detail: lookup.detail,
    checkedRoot: lookup.checkedRoot,
  };
}
