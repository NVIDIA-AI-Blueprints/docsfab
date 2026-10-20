// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Resolve the exact catalog skill directories named by workflow steps. */
import type { WorkflowDefinition, WorkflowStep } from "../workflow-contracts/contracts.js";
import { verifyCatalogSkill } from "./catalog-crate.js";

const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"] as const;
const WRITE_TOOLS = [...READ_ONLY_TOOLS, "edit", "write"] as const;

export function catalogSkillToolsForStep(step: WorkflowStep): readonly string[] {
  // A native executor's filesystem authority is enforced by that operation's
  // host grant. Its guidance does not grant generic model write tools.
  return step.kind === "host-operation" || step.mode === "read-only"
    ? READ_ONLY_TOOLS
    : WRITE_TOOLS;
}

export async function catalogSkillDirectoryForStep(options: {
  skillCrateDirectory: string;
  step: WorkflowStep;
}): Promise<string> {
  return (
    await verifyCatalogSkill({
      skillCrateDirectory: options.skillCrateDirectory,
      skillId: options.step.skill,
      grantedTools: catalogSkillToolsForStep(options.step),
    })
  ).directory;
}

export async function catalogSkillDirectoriesForWorkflow(
  skillCrateDirectory: string,
  workflow: WorkflowDefinition,
): Promise<readonly string[]> {
  return Promise.all(
    workflow.steps.map((step) => catalogSkillDirectoryForStep({ skillCrateDirectory, step })),
  );
}
