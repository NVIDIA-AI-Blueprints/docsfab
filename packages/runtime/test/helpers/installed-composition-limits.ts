// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Sealed limits of an installed executable composition, read from the package's
 * composition assets so setup tests follow a reseal instead of pinning a copy.
 */
import {
  loadInstalledModelCompositionAuthority,
  resolveInstalledExecutableComposition,
} from "../../src/model-composition/installed.js";

/** Any installed workflow resolves the same composition limits. */
const WORKFLOW_ID = "review-documentation";

/** Lowest of the candidate, composition, and package-ceiling context windows. */
export async function sealedCompositionContextWindow(compositionId: string): Promise<number> {
  const { authority } = await loadInstalledModelCompositionAuthority();
  const bound = resolveInstalledExecutableComposition({
    authority,
    compositionId,
    workflowId: WORKFLOW_ID,
  });
  return Math.min(
    bound.candidate.proposedLimits.contextWindow,
    bound.composition.compositionLimits.contextWindow,
    bound.compositionCeiling.contextWindow,
  );
}
