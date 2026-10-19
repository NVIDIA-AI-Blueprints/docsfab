// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Pure projection of independently verified GitLab facts; never a fetcher. */
import { createChangeRequestRef, type ChangeRequestRefV1 } from "../change-request.js";
import {
  createChangeSnapshot,
  type ChangeSnapshotGraphV1,
  type ChangeSnapshotLimitationV1,
  type ChangeSnapshotManifestRowV1,
  type ChangeSnapshotSourceSideV1,
  type ChangeSnapshotV1,
} from "../change-snapshot.js";

export class GitlabChangeProjectionError extends Error {
  constructor(readonly code: string) {
    super(
      code === "gitlab-change-identity-invalid"
        ? "GitLab change identity must use positive safe integer IDs."
        : "Verified native GitLab graph, manifest, and source facts are required.",
    );
    this.name = "GitlabChangeProjectionError";
  }
}

function refuse(code: string): never {
  throw new GitlabChangeProjectionError(code);
}

/**
 * The GitLab forge-reported B..H ChangeSourceV1 does not supply these M..H
 * facts. A caller must supply independently verified native object facts;
 * absent facts refuse instead of manufacturing a merge base from a label.
 */
export interface VerifiedGitlabChangeFactsV1 {
  readonly host: string;
  readonly targetProjectId: number;
  readonly sourceProjectId: number;
  readonly mergeRequestIid: number;
  readonly graph: ChangeSnapshotGraphV1;
  readonly manifest: readonly ChangeSnapshotManifestRowV1[];
  readonly sourceSides: readonly ChangeSnapshotSourceSideV1[];
  readonly sourceBindingSha256: string | null;
  readonly limitations: readonly ChangeSnapshotLimitationV1[];
}

function positive(value: number): string {
  if (!Number.isSafeInteger(value) || value <= 0) refuse("gitlab-change-identity-invalid");
  return String(value);
}

export function projectVerifiedGitlabChange(input: VerifiedGitlabChangeFactsV1): {
  ref: ChangeRequestRefV1;
  snapshot: ChangeSnapshotV1;
} {
  if (
    !input ||
    typeof input.host !== "string" ||
    !input.graph ||
    !Array.isArray(input.manifest) ||
    !Array.isArray(input.sourceSides) ||
    !Array.isArray(input.limitations) ||
    (input.sourceBindingSha256 !== null && typeof input.sourceBindingSha256 !== "string")
  )
    refuse("gitlab-change-native-facts-required");
  const ref = createChangeRequestRef({
    provider: "gitlab",
    canonicalHost: input.host.toLowerCase(),
    targetRepositoryId: positive(input.targetProjectId),
    objectKind: "merge-request",
    nativeChangeId: positive(input.mergeRequestIid),
  });
  const snapshot = createChangeSnapshot({
    ref,
    sourceRepositoryId: positive(input.sourceProjectId),
    graph: input.graph,
    manifest: [...input.manifest],
    sourceSides: [...input.sourceSides],
    sourceBindingSha256: input.sourceBindingSha256,
    limitations: [...input.limitations],
    completeness: "complete",
  });
  return { ref, snapshot };
}
