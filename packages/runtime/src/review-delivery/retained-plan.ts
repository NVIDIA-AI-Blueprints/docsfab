// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Local read-only composition from saved run to inspectable review plan. */
import type { DurableArtifactStore } from "../artifacts/store.js";
import { canonicalJson } from "../content-ir/canonical.js";
import { decodeSuccessfulReviewRunRecord } from "../delivery/run-record.js";
import type { ChangeSourceV1 } from "../inputs/change-source.js";
import type { FileRunStore } from "../records/file-store.js";
import type { ReviewTargetV2 } from "../review/contracts.js";
import { loadReviewLocatorAuthority } from "../review/locator-provenance.js";
import { reviewResultFromRun, type ReviewRunBinding } from "../review/run-result.js";
import { projectReviewResultV1 } from "../review/target-migration.js";
import type { ReviewDeliveryPlan, ReviewDeliveryPlanInput } from "./contracts.js";
import { createReviewDeliveryPlan, reviewDeliverySnapshotDigest } from "./plan.js";
import { loadRetainedReviewResult } from "./result-store.js";
import {
  prepareReviewFeedback,
  type ReviewFeedbackPreparationPolicy,
} from "./feedback-preparation.js";

type RetainedReviewInput = Parameters<typeof planRetainedReviewDelivery>[0];

async function retainedPlanningInput(
  input: RetainedReviewInput,
): Promise<ReviewDeliveryPlanInput<ChangeSourceV1>> {
  const saved = await input.runStore.getWithDigest(input.runId, { readOnly: input.readOnly });
  const run = decodeSuccessfulReviewRunRecord(saved.record);
  if (run.id !== input.runId)
    throw new Error("Saved review run identity changed before delivery planning.");
  const loaded =
    run.reviewDeliverySnapshot === undefined
      ? undefined
      : await loadRetainedReviewResult({
          runStore: input.runStore,
          artifacts: input.artifacts,
          runId: input.runId,
          target: input.binding.target,
          readOnly: input.readOnly,
        });
  if (
    loaded &&
    (canonicalJson(loaded.source.source) !== canonicalJson(input.binding.source) ||
      reviewDeliverySnapshotDigest(loaded.source.snapshot, loaded.source.source) !==
        reviewDeliverySnapshotDigest(input.delivery.snapshot, input.binding.source))
  )
    throw new Error("Saved review source differs from the requested delivery source.");
  const result = loaded?.result ?? reviewResultFromRun(run, input.binding);
  const projected = projectReviewResultV1(result, input.binding.target);
  const locatorEvidence = await loadReviewLocatorAuthority({
    runStore: input.runStore,
    artifacts: input.artifacts,
    runId: input.runId,
    binding: input.binding,
    result: projected,
    snapshotSha256: reviewDeliverySnapshotDigest(input.delivery.snapshot, input.binding.source),
    readOnly: input.readOnly,
  });
  return {
    ...input.delivery,
    target: input.binding.target,
    source: input.binding.source,
    result,
    locatorEvidence,
  };
}

export async function planRetainedReviewDelivery(input: {
  readonly runStore: FileRunStore;
  readonly artifacts: DurableArtifactStore;
  readonly runId: string;
  readonly readOnly?: true;
  readonly binding: ReviewRunBinding & {
    readonly target: ReviewTargetV2;
    readonly source: ChangeSourceV1;
  };
  readonly delivery: Omit<
    ReviewDeliveryPlanInput<ChangeSourceV1>,
    "target" | "source" | "result" | "locatorEvidence"
  >;
}): Promise<ReviewDeliveryPlan<ChangeSourceV1>> {
  return createReviewDeliveryPlan(await retainedPlanningInput(input));
}

/** The retained-run path and direct callers share the same pure preparation policy. */
export async function prepareRetainedReviewFeedback(
  input: RetainedReviewInput & { readonly policy: ReviewFeedbackPreparationPolicy },
) {
  return prepareReviewFeedback(await retainedPlanningInput(input), input.policy);
}
