// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Public hosted verification seam for externally reviewed native plans. */
import { createArtifact, validateArtifact, type ArtifactReference } from "../artifacts/index.js";
import { canonicalJson } from "../content-ir/index.js";
import { deepFreeze } from "../contract-kit/index.js";
import type { IaPlanReviewerPolicy } from "../ia/plan-review.js";
import type { SiteBootstrapApplicationBundle } from "../site-bootstrap/contracts.js";
import { validateSiteBootstrapApplicationBundle } from "../site-bootstrap/bundle.js";
import { verifyHostedSiteBootstrapSelection } from "../site-bootstrap/hosted.js";

export interface NativeSiteImportVerificationInput {
  readonly pendingPlan: unknown;
  readonly bundle: unknown;
  /** Protected project policy; a task or bundle never supplies this authority. */
  readonly reviewerPolicy: IaPlanReviewerPolicy;
  readonly repositoryRevision: string;
  readonly now: Date;
}

/**
 * Bind a genuinely signed successor to the accepted producer's exact pending
 * plan. Registration happens only after this verifies; it grants no write.
 */
export function verifyNativeSiteImport(input: NativeSiteImportVerificationInput): {
  readonly bundle: SiteBootstrapApplicationBundle;
  readonly plan: ArtifactReference<"ia-plan">;
  readonly pendingPlan: ArtifactReference<"ia-plan">;
} {
  const bundle = validateSiteBootstrapApplicationBundle(input.bundle, {
    now: input.now,
    reviewerPolicy: input.reviewerPolicy,
  });
  const pending = validateArtifact(input.pendingPlan, {
    index: bundle.evaluationInput.index,
    planAcceptance: "any",
    now: input.now,
  });
  if (pending.kind !== "ia-plan")
    throw new Error("Native approval import requires the accepted producer's IA plan artifact.");
  const pendingPlan: ArtifactReference<"ia-plan"> = {
    kind: pending.kind,
    schemaVersion: pending.schemaVersion,
    digest: pending.digest,
    repositoryRevision: pending.repository.revision,
    repositoryContentDigest: pending.repository.contentDigest,
  };
  if (canonicalJson(bundle.review.predecessorPlan) !== canonicalJson(pendingPlan))
    throw new Error("The signed native approval names a different producing plan artifact.");
  // The canonical review operation changes approval and supersedes only. A
  // signed replacement may not quietly rewrite the producer's scope or inputs.
  const expected = createArtifact(
    "ia-plan",
    { ...pending.payload, approval: bundle.plan.payload.approval, supersedes: pendingPlan },
    { index: bundle.evaluationInput.index, now: input.now },
  );
  if (expected.digest !== bundle.plan.digest)
    throw new Error(
      "The approved native plan changed the producing plan beyond its review transition.",
    );
  const plan: ArtifactReference<"ia-plan"> = {
    kind: bundle.plan.kind,
    schemaVersion: bundle.plan.schemaVersion,
    digest: bundle.plan.digest,
    repositoryRevision: bundle.plan.repository.revision,
    repositoryContentDigest: bundle.plan.repository.contentDigest,
  };
  verifyHostedSiteBootstrapSelection({
    task: { kind: "site-bootstrap", plan },
    bundle,
    reviewerPolicy: input.reviewerPolicy,
    repositoryRevision: input.repositoryRevision,
    now: input.now,
  });
  return deepFreeze({ bundle, plan, pendingPlan });
}

export { verifyHostedSiteBootstrapSelection } from "../site-bootstrap/hosted.js";
export { validateIaPlanReviewerPolicy } from "../ia/plan-review.js";
export type { IaPlanReviewerPolicy } from "../ia/plan-review.js";
