// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ContentIndexV1 } from "../content-ir/index.js";
import { analyzeDocumentationImpact, type ImpactPolicyBinding } from "../impact/index.js";
import type { SiteBootstrapImpactPostflightEvidence } from "./contracts.js";

/**
 * Compare the immutable export baseline with its current disposable-workspace
 * state. Git revision equality is expected: content and index identities prove
 * whether the local, not-yet-committed scaffold changed documentation.
 */
export function runSiteBootstrapImpactPostflight(input: {
  before: ContentIndexV1;
  after: ContentIndexV1;
  policy: ImpactPolicyBinding;
}): SiteBootstrapImpactPostflightEvidence {
  if (input.before.repository.revision !== input.after.repository.revision) {
    throw new Error("Site bootstrap postflight must remain on one Git revision.");
  }
  if (input.before.indexDigest === input.after.indexDigest) {
    return {
      schemaVersion: 1,
      status: "no-change",
      policy: { ...input.policy },
      repository: binding(input.after),
    };
  }
  const analysis = analyzeDocumentationImpact({
    mode: "incremental",
    before: input.before,
    after: input.after,
    policy: input.policy,
  });
  return {
    schemaVersion: 1,
    status: "completed",
    mode: "incremental",
    policy: { ...analysis.policy },
    beforeRepository: { ...analysis.beforeRepository },
    afterRepository: { ...analysis.afterRepository },
    analysisDigest: analysis.digest,
    changedPaths: [...analysis.changedPaths],
    changedRegions: [...analysis.changedRegions],
    affectedNodeIds: analysis.neighborhood.map((entry) => entry.nodeId),
  };
}

function binding(index: ContentIndexV1) {
  return {
    revision: index.repository.revision,
    contentDigest: index.repository.contentDigest,
    indexDigest: index.indexDigest,
  };
}
