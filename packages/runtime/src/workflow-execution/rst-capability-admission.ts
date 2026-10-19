// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import type { RunRequest } from "../execution/contracts.js";
import { canonicalDigest } from "../content-ir/canonical.js";
import { validateWorkflowRunRequestTask } from "../workflow-contracts/task.js";
import {
  assertRstCapabilityAdmitted,
  createRstCapabilityAdmission,
  verifyRstCapabilityAdmission,
} from "../rst-authoring/capability-admission.js";
import type { WorkflowRunnerOptions } from "./runner-ports.js";

/** The central runner's canonical RST write boundary; CLI facts are rechecked here. */
export function assertCanonicalRstCapability(
  options: Pick<WorkflowRunnerOptions, "planWriteScope" | "rstCapabilityAdmission">,
  request: RunRequest,
): void {
  const task = validateWorkflowRunRequestTask(request);
  const targets =
    task?.kind === "bounded-doc-improvement" || task?.kind === "foundation-to-patch"
      ? task.intendedPaths
      : [];
  const rstTargets = targets.filter((path) => path.endsWith(".rst"));
  if (rstTargets.length === 0) return;

  const taskSha256 = canonicalDigest(task);
  const repositoryIdentitySha256 = createHash("sha256")
    .update(request.repository.sourcePath)
    .digest("hex");
  const scope = options.planWriteScope;
  const admittedScope = scope?.rstUpdatePaths;
  const matches =
    scope !== undefined &&
    verifyRstCapabilityAdmission(options.rstCapabilityAdmission, {
      workflow: request.workflow,
      delivery: "patch-only",
      targetPaths: targets,
      taskSha256,
      repositoryIdentitySha256,
      repositoryRevision: request.repository.revision,
      documentationRoots: scope.roots,
    }) &&
    admittedScope?.length === rstTargets.length &&
    rstTargets.every((path, index) => admittedScope[index] === path);
  if (matches) return;

  const refusal = createRstCapabilityAdmission({
    workflow: request.workflow,
    delivery: "unknown",
    targetPaths: targets,
    taskSha256,
    repositoryIdentitySha256,
    repositoryRevision: request.repository.revision,
    documentationRoots: scope?.roots,
    adapterEligible: false,
  });
  assertRstCapabilityAdmitted(refusal);
}
