// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Bind readiness to the same immutable tracked workspace used by the local CLI. */
import { DOCSFAB_PROJECT_CONFIG_FILE, MAX_CONFIG_BYTES } from "../init/types.js";
import { loadTrackedDocsFabProjectConfig } from "../project-config-preflight.js";
import { ReadinessWorkflowOutcomeProjector } from "../readiness/outcome-projector.js";
import type { RepositoryWorkspace } from "../repository/workspace/contracts.js";
import { readTrackedRepositoryFile } from "../repository/workspace/tracked-read.js";
import { LocalWorkflowSearchCoordinator } from "../search/local-workflow-coordinator.js";
import type { WorkflowName, WorkflowOutcomeProjector } from "../workflow-contracts/contracts.js";

export interface HostedReadinessPreparation {
  readonly workspacePath: string;
  readonly repository: Pick<RepositoryWorkspace, "sourcePath" | "requestedRevision" | "revision">;
  readonly workflowSearch: LocalWorkflowSearchCoordinator;
  readonly outcomeProjector?: WorkflowOutcomeProjector;
  readonly releaseDefaultBranch?: string;
}

export async function prepareHostedReadiness(
  workflow: WorkflowName,
  workspace: RepositoryWorkspace,
): Promise<HostedReadinessPreparation | null> {
  if (workflow !== "readiness" && workflow !== "release-documentation-readiness") return null;
  const common = {
    workspacePath: workspace.path,
    repository: {
      sourcePath: workspace.sourcePath,
      requestedRevision: workspace.requestedRevision,
      revision: workspace.revision,
    },
    workflowSearch: new LocalWorkflowSearchCoordinator({ workspace }),
  };
  if (workflow === "readiness")
    return { ...common, outcomeProjector: new ReadinessWorkflowOutcomeProjector(workspace) };
  // The repository's tracked default branch is an assessment binding, never a
  // publication grant. Use the existing canonical config ceiling/reader; do not
  // import current working-tree bytes or guess "main" for an older revision.
  const config = await loadTrackedDocsFabProjectConfig({
    sourcePath: workspace.sourcePath,
    readTrackedBytes: () =>
      readTrackedRepositoryFile(workspace, DOCSFAB_PROJECT_CONFIG_FILE, MAX_CONFIG_BYTES),
    surface: "release-documentation-readiness",
  });
  return { ...common, releaseDefaultBranch: config.gitlab.defaultBranch };
}
