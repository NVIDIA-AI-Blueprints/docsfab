// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { limit } from "../../config/limits.js";
import { REPOSITORY_INVENTORY_TEXT_MAX_FILE_BYTES_LIMIT } from "../../config/repository-inventory-limit.js";
import { canonicalDigest } from "../../content-ir/canonical.js";
import {
  readTrackedRepositoryFile,
  type listTrackedRepositoryEntries,
} from "../../repository/workspace/tracked-read.js";
import type { RepositoryWorkspace } from "../../repository/workspace/contracts.js";
import { normalizeWorkflowTaskInput } from "../../workflow-contracts/task.js";
import type { WorkflowTaskInput } from "../../workflow-contracts/contracts.js";
import {
  assertRstCapabilityAdmitted,
  createRstCapabilityAdmission,
} from "../../rst-authoring/capability-admission.js";
import {
  eligibleRstUpdatePaths,
  rstConfigurationCandidates,
} from "../../rst-authoring/eligibility.js";
import { firstPassDocumentationWriteRoots } from "../first-pass.js";
import type { RunRequestWithPublishProjection } from "./request.js";

export interface RstCapabilityPreflightResult {
  readonly rstUpdatePaths?: readonly string[];
  readonly rstCapabilityAdmission?: ReturnType<typeof createRstCapabilityAdmission>;
}

/** Resolves caller-bound RST eligibility and mints its internal admission. */
export async function prepareRstCapabilityPreflight(input: {
  readonly request: RunRequestWithPublishProjection;
  readonly task: WorkflowTaskInput | undefined;
  readonly workspace: RepositoryWorkspace;
  readonly documentationRoots: readonly string[] | undefined;
  readonly trackedEntries: Awaited<ReturnType<typeof listTrackedRepositoryEntries>>;
}): Promise<RstCapabilityPreflightResult> {
  const { request, task, workspace, documentationRoots, trackedEntries } = input;
  const normalizedTask =
    task?.kind === "bounded-doc-improvement" || task?.kind === "foundation-to-patch"
      ? normalizeWorkflowTaskInput({
          workflow: request.workflow,
          task,
          repository: {
            identitySha256: createHash("sha256").update(workspace.sourcePath).digest("hex"),
            revision: workspace.revision,
          },
          allowWrite: request.allowWrite,
          ...(request.instruction !== undefined ? { instruction: request.instruction } : {}),
          ...(request.contextTarget !== undefined ? { contextTarget: request.contextTarget } : {}),
        })
      : undefined;
  const callerBoundTargets = isTargetTask(normalizedTask) ? normalizedTask.intendedPaths : [];
  const callerBoundRstTargets = callerBoundTargets.filter((path) => path.endsWith(".rst"));
  const eligiblePaths = eligibleRstUpdatePaths(trackedEntries, documentationRoots);
  let rstUpdatePaths: readonly string[] | undefined;
  if (request.workflow === "update-documentation" && request.patchOnly === true) {
    rstUpdatePaths = eligiblePaths;
  }

  let rstCapabilityAdmission: ReturnType<typeof createRstCapabilityAdmission>;
  if (callerBoundRstTargets.length > 0 && isTargetTask(normalizedTask)) {
    const adapterBinding = await resolveTrackedSphinxAdapterBinding({
      workspace,
      trackedEntries,
      documentationRoots,
      callerBoundRstTargets,
    });
    const repositoryIdentitySha256 = createHash("sha256")
      .update(workspace.sourcePath)
      .digest("hex");
    rstCapabilityAdmission = createRstCapabilityAdmission({
      workflow: request.workflow,
      delivery: request.patchOnly === true ? "patch-only" : "default",
      targetPaths: callerBoundTargets,
      taskSha256: canonicalDigest(normalizedTask),
      repositoryIdentitySha256,
      repositoryRevision: workspace.revision,
      documentationRoots: adapterBinding.documentationRoots,
      ...(adapterBinding.configurationSha256
        ? { adapterConfigurationSha256: adapterBinding.configurationSha256 }
        : {}),
      adapterEligible:
        callerBoundRstTargets.length === 1 && eligiblePaths.includes(callerBoundRstTargets[0]!),
    });
    assertRstCapabilityAdmitted(rstCapabilityAdmission);
    // A caller-bound admitted task carries its precise RST scope downstream.
    rstUpdatePaths = Object.freeze(callerBoundRstTargets);
  }

  return {
    ...(rstUpdatePaths ? { rstUpdatePaths } : {}),
    ...(rstCapabilityAdmission ? { rstCapabilityAdmission } : {}),
  };
}

async function resolveTrackedSphinxAdapterBinding(input: {
  readonly workspace: RepositoryWorkspace;
  readonly trackedEntries: Awaited<ReturnType<typeof listTrackedRepositoryEntries>>;
  readonly documentationRoots: readonly string[] | undefined;
  readonly callerBoundRstTargets: readonly string[];
}) {
  const regularPaths = new Set(
    input.trackedEntries.flatMap((entry) =>
      entry.kind === "regular" && entry.path !== undefined ? [entry.path] : [],
    ),
  );
  const candidates =
    input.callerBoundRstTargets.length === 1
      ? rstConfigurationCandidates(
          input.callerBoundRstTargets[0]!,
          input.callerBoundRstTargets[0]!,
        ).filter((candidate) => regularPaths.has(candidate.configurationPath))
      : [];
  const sphinxOwner =
    candidates.length === 1 && candidates[0]!.adapterId === "sphinx" ? candidates[0] : undefined;
  const configurationSha256 = sphinxOwner
    ? createHash("sha256")
        .update(
          await readTrackedRepositoryFile(
            input.workspace,
            sphinxOwner.configurationPath,
            limit(REPOSITORY_INVENTORY_TEXT_MAX_FILE_BYTES_LIMIT).value,
          ),
        )
        .digest("hex")
    : undefined;
  const documentationRoots = firstPassDocumentationWriteRoots(
    input.documentationRoots,
    "local-widen",
    [...regularPaths],
    input.callerBoundRstTargets,
  ).roots;
  return { configurationSha256, documentationRoots };
}

function isTargetTask(value: unknown): value is {
  readonly kind: "bounded-doc-improvement" | "foundation-to-patch";
  readonly intendedPaths: readonly string[];
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    (value.kind === "bounded-doc-improvement" || value.kind === "foundation-to-patch") &&
    "intendedPaths" in value &&
    Array.isArray(value.intendedPaths)
  );
}
