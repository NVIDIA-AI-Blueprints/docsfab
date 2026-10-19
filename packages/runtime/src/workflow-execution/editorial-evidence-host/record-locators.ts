// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { canonicalDigest } from "../../content-ir/index.js";
import type { ArtifactReference } from "../../artifacts/index.js";

function recordLocator(kind: string, digest: string): string {
  return canonicalDigest({ schemaVersion: 1, kind: `docsfab-${kind}-locator`, digest });
}

function repositoryIndexLocator(
  repositoryRevision: string,
  repositoryContentDigest: string,
): string {
  return canonicalDigest({
    schemaVersion: 1,
    kind: "docsfab-editorial-repository-index-locator",
    repositoryRevision,
    repositoryContentDigest,
  });
}

function associationLocator(runId: string, stepId: string, reference: ArtifactReference): string {
  return canonicalDigest({
    schemaVersion: 1,
    kind: "docsfab-editorial-evidence-association-locator",
    runId,
    stepId,
    reference,
  });
}

export { associationLocator, recordLocator, repositoryIndexLocator };
