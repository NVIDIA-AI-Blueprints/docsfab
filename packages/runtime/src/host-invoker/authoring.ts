// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Authenticated CREATE V3 candidate assembly shared by hosted invocations. */
import { resolve } from "node:path";
import { buildContentIndex } from "../content-ir/index.js";
import type { AgentHarness } from "../execution/contracts.js";
import { LocalImpactPostflightService } from "../impact/postflight.js";
import { validateAuthoringRunRecordV1 } from "../records/authoring-execution.js";
import type { RunRecord } from "../records/contracts.js";
import { repositoryChangeWriteEffectPaths } from "../repository/contracts.js";
import { GitPatchEvidenceCollector } from "../repository/evidence.js";
import { prepareRepositoryWorkspace } from "../repository/workspace/materialize.js";
import type { RepositoryWorkspace } from "../repository/workspace/contracts.js";
import { verifyActiveRepositoryWorkspace } from "../repository/workspace/tracked-read.js";
import { LocalWorkflowSearchCoordinator } from "../search/local-workflow-coordinator.js";
import { isWorkflowManifestV3, type WorkflowDefinition } from "../workflow-contracts/contracts.js";
import { LocalAuthoringCandidateLifecycle } from "../workflow-execution/authoring-runtime.js";
import { readImmutablePatchArtifact } from "../workflow-execution/authoring-workspace-host.js";
import { documentationPlanWritePaths } from "../workflow-execution/plan-binding.js";
import { LocalSourceObligationSourceObserver } from "../workflow-execution/source-obligation-observer.js";
import { WorkflowChecksHostOperation } from "../workflow-execution/workflow-checks.js";
import type { HostRuntimeRequestV1 } from "./contracts.js";
import { runTrustedGit } from "./trusted-git.js";
import { withinWriteCeiling } from "./wire-decode.js";

export async function prepareHostedAuthoring(input: {
  request: HostRuntimeRequestV1;
  workflow: WorkflowDefinition;
  workspace: RepositoryWorkspace;
}) {
  if (!isWorkflowManifestV3(input.workflow)) return undefined;
  const { request, workflow } = input;
  const originalSource = input.workspace;
  const authority = request.writeAuthority;
  if (!authority || !request.allowWrite || originalSource.revision !== request.revision)
    throw new Error("Hosted CREATE requires its exact source workspace and separate write grant.");
  await verifyActiveRepositoryWorkspace(originalSource);
  const workspace = await prepareRepositoryWorkspace(request.workspacePath, request.revision);
  const artifactDirectory = resolve(request.stateDirectory, "patches");
  let repositoryEvidence: GitPatchEvidenceCollector | undefined;
  try {
    repositoryEvidence = await GitPatchEvidenceCollector.create(workspace.path, artifactDirectory);
    const workflowSearch = new LocalWorkflowSearchCoordinator({ workspace });
    const sourceObligationObserver = new LocalSourceObligationSourceObserver(originalSource);
    const hostOperations = new WorkflowChecksHostOperation(workspace);
    const authoringCandidateLifecycle = new LocalAuthoringCandidateLifecycle({
      workspace,
      evidenceCollector: repositoryEvidence,
      search: workflowSearch,
      sourceObserver: sourceObligationObserver,
      hostOperations,
      artifactDirectory,
      // A CREATE converted into an UPDATE modifies an existing page, which a
      // hosted grant allows only through an exact modify target at that blob.
      updateGrant: ({ path, objectId }) =>
        authority.targets.some(
          (target) =>
            target.path === path &&
            target.operations.includes("modify") &&
            target.preimageObjectId === objectId,
        ),
    });
    const impactPostflight = new LocalImpactPostflightService(
      await buildContentIndex({
        repositoryPath: workspace.path,
        repositoryRevision: workspace.revision,
      }),
    );
    function assertPaths(paths: readonly string[]) {
      if (paths.some((path) => !withinWriteCeiling(path, authority!.pathCeiling)))
        throw new Error("Hosted CREATE candidate exceeds its installed write scope.");
    }
    return {
      workspacePath: workspace.path,
      repository: {
        sourcePath: workspace.sourcePath,
        requestedRevision: request.revision,
        revision: workspace.revision,
      },
      dispose: () => workspace.dispose(),
      repositoryEvidence,
      workflowSearch,
      sourceObligationObserver,
      hostOperations,
      authoringCandidateLifecycle,
      impactPostflight,
      wrapHarness(harness: AgentHarness): AgentHarness {
        return {
          ...(harness.inspectSkill
            ? { inspectSkill: (step) => harness.inspectSkill!.call(harness, step) }
            : {}),
          async runStep(step) {
            if (step.step.mode === "write" && step.planBinding)
              assertPaths(documentationPlanWritePaths(step.planBinding));
            const result = await harness.runStep.call(harness, step);
            if (result.planBinding) assertPaths(documentationPlanWritePaths(result.planBinding));
            return result;
          },
        };
      },
      async finalize(record: RunRecord, signal?: AbortSignal): Promise<void> {
        if (record.status !== "succeeded") return;
        validateAuthoringRunRecordV1(record, workflow, { requireTerminalSuccess: true });
        const patch = record.changes?.patch;
        if (!patch || record.repository.revision !== request.revision)
          throw new Error("Hosted CREATE has no authenticated selected patch for this revision.");
        assertPaths(repositoryChangeWriteEffectPaths(record.changes!.files));
        const bytes = await readImmutablePatchArtifact(
          patch.artifactPath,
          patch.byteLength,
          patch.sha256,
        );
        if (bytes.length === 0) return;
        // The runner admitted the selected candidate, including any revision
        // branch. Transfer that retained patch, never the original writer tree.
        await runTrustedGit(
          request.workspacePath,
          ["apply", "--check", "-"],
          signal,
          undefined,
          bytes,
        );
        await runTrustedGit(request.workspacePath, ["apply", "-"], signal, undefined, bytes);
      },
    };
  } catch (error) {
    try {
      await repositoryEvidence?.dispose();
    } finally {
      await workspace.dispose();
    }
    throw error;
  }
}
