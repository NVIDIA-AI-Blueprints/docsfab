// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Installed, read-only entry point for planning from a retained local review. */
import { dirname, resolve } from "node:path";
import { DurableArtifactStore } from "../artifacts/store.js";
import { FileRunStore } from "../records/file-store.js";
import { FileScmDeliveryReceiptStore } from "../delivery/receipt-store.js";
import { resolveDocsFabPublicationRoots } from "../config/host-paths.js";
import { inspectSavedReviewInventory as inspectFromStores } from "./inspection-intent.js";
import { planRetainedReviewDelivery as planFromStores } from "./retained-plan.js";
import { prepareRetainedReviewFeedback as prepareFromStores } from "./retained-plan.js";

export async function planRetainedReviewDelivery(
  input: Omit<Parameters<typeof planFromStores>[0], "runStore" | "artifacts"> & {
    readonly stateDirectory: string;
  },
): ReturnType<typeof planFromStores> {
  return planFromStores({
    runStore: new FileRunStore(input.stateDirectory),
    artifacts: new DurableArtifactStore(resolve(dirname(input.stateDirectory), "artifacts")),
    runId: input.runId,
    binding: input.binding,
    delivery: input.delivery,
    readOnly: true,
  });
}

/** Installed read-only scenario preparation over the same retained review run. */
export async function prepareRetainedReviewFeedback(
  input: Omit<Parameters<typeof prepareFromStores>[0], "runStore" | "artifacts"> & {
    readonly stateDirectory: string;
  },
): ReturnType<typeof prepareFromStores> {
  return prepareFromStores({
    runStore: new FileRunStore(input.stateDirectory),
    artifacts: new DurableArtifactStore(resolve(dirname(input.stateDirectory), "artifacts")),
    runId: input.runId,
    binding: input.binding,
    delivery: input.delivery,
    policy: input.policy,
    readOnly: true,
  });
}

/** Open the complete original inventory from the installed private stores. */
export async function inspectSavedReviewInventory(input: {
  readonly stateDirectory: string;
  readonly runId: string;
  readonly intentObjectSha256: string;
}): ReturnType<typeof inspectFromStores> {
  const roots = resolveDocsFabPublicationRoots(process.env, input.stateDirectory);
  return inspectFromStores({
    runStore: new FileRunStore(roots.stateDirectory),
    artifacts: new DurableArtifactStore(resolve(dirname(roots.stateDirectory), "artifacts")),
    receiptStore: new FileScmDeliveryReceiptStore(roots.receiptRoot),
    runId: input.runId,
    intentObjectSha256: input.intentObjectSha256,
  });
}
