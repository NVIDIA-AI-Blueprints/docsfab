// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { dirname } from "node:path";
import { parse as parseYaml } from "yaml";

import { getWorkflow, type RunnableWorkflowName } from "../workflow-registry/catalog.js";
import {
  readVerifiedCatalogFile,
  verifyCatalogSkill,
  type CatalogSkillId,
} from "../skills/catalog-crate.js";
import type { SkillInvocationProfile } from "../skills/invocation-metadata.js";
import type { LiveAgentCapabilities, LiveAgentSkill } from "./capabilities.js";

export interface DocumentationSkillCapabilityV1 {
  readonly skillId: CatalogSkillId;
  readonly description: string;
  readonly inputs: readonly { readonly name: string; readonly description: string }[];
  readonly results: readonly { readonly name: string; readonly description: string }[];
  readonly invocationProfiles: readonly Pick<
    SkillInvocationProfile,
    | "operation"
    | "acceptedCallerFields"
    | "requiredCallerFields"
    | "immediateToolResultKind"
    | "applicationResultKind"
  >[];
}

export interface DocumentationWorkflowCapabilityV1 {
  readonly workflowId: RunnableWorkflowName;
  readonly title: string;
  readonly purpose: string;
  readonly skillIds: readonly string[];
  readonly results: readonly string[];
}

export interface DocumentationWorkCapabilitiesV1 {
  readonly skills: readonly DocumentationSkillCapabilityV1[];
  readonly workflows: readonly DocumentationWorkflowCapabilityV1[];
}

/** Project only metadata already present in verified installed skills and workflows. */
export async function projectDocumentationWorkCapabilities(
  capabilities: LiveAgentCapabilities,
): Promise<DocumentationWorkCapabilitiesV1> {
  const skills = await Promise.all(capabilities.skills.map(projectSkill));
  const installedSkillIds = new Set<string>(skills.map((skill) => skill.skillId));
  const workflows = capabilities.workflows.map((workflow) => {
    const definition = getWorkflow(workflow.name);
    const stepSkillIds = definition.steps.map((step) => step.skill);
    const uniqueStepSkillIds = [...new Set(stepSkillIds)];
    const missingSkills = uniqueStepSkillIds.filter((id) => !installedSkillIds.has(id));
    if (missingSkills.length > 0) {
      throw new Error(
        `Installed workflow "${workflow.name}" refers to unavailable installed skills: ${missingSkills.join(", ")}.`,
      );
    }
    return Object.freeze({
      workflowId: workflow.name,
      title: workflow.title,
      purpose: definition.outcome,
      skillIds: Object.freeze(uniqueStepSkillIds),
      results: Object.freeze([definition.outcome]),
    });
  });
  return Object.freeze({ skills: Object.freeze(skills), workflows: Object.freeze(workflows) });
}

async function projectSkill(skill: LiveAgentSkill): Promise<DocumentationSkillCapabilityV1> {
  const verified = await verifyCatalogSkill({
    skillCrateDirectory: dirname(skill.directory),
    skillId: skill.lock.id,
    grantedTools: skill.lock.toolPolicy.granted,
    expectedVersion: skill.lock.version,
    expectedContentSha256: skill.lock.contentSha256,
  });
  const bytes = await readVerifiedCatalogFile(verified, "SKILL.md");
  const description = readSkillDescription(bytes.toString("utf8"));
  return Object.freeze({
    skillId: skill.lock.id,
    description,
    inputs: Object.freeze(
      skill.lock.inputs.map(({ name, description: detail }) =>
        Object.freeze({ name, description: detail }),
      ),
    ),
    results: Object.freeze(
      skill.lock.outputs.map(({ name, description: detail }) =>
        Object.freeze({ name, description: detail }),
      ),
    ),
    invocationProfiles: Object.freeze(
      (skill.invocation?.profiles ?? []).map((profile) =>
        Object.freeze({
          operation: profile.operation,
          acceptedCallerFields: profile.acceptedCallerFields,
          requiredCallerFields: profile.requiredCallerFields,
          immediateToolResultKind: profile.immediateToolResultKind,
          applicationResultKind: profile.applicationResultKind,
        }),
      ),
    ),
  });
}

function readSkillDescription(contents: string): string {
  const frontmatter = contents.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u)?.[1];
  if (!frontmatter)
    throw new Error("Installed documentation skill has no locked metadata frontmatter.");
  const metadata = parseYaml(frontmatter) as unknown;
  if (
    typeof metadata !== "object" ||
    metadata === null ||
    Array.isArray(metadata) ||
    typeof (metadata as { description?: unknown }).description !== "string" ||
    !(metadata as { description: string }).description.trim()
  ) {
    throw new Error("Installed documentation skill has no valid locked description metadata.");
  }
  return (metadata as { description: string }).description;
}
