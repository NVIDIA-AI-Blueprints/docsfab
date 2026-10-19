// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { createLiveAgentResourceLoader } from "../src/live-agent/host.js";
import { temporaryRoots } from "./helpers/temp.js";

const roots = temporaryRoots();

async function writeSkill(directory: string, name: string, marker: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${marker}\n---\n\n# ${marker}\n`,
  );
}

async function writePrompt(directory: string, name: string, marker: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${name}.md`), `---\ndescription: ${marker}\n---\n\n${marker}\n`);
}

describe("live-agent task session resources", () => {
  it("requires a private agent directory for task mode", async () => {
    await expect(
      createLiveAgentResourceLoader({
        repositoryPath: "/unused/repository",
        host: { systemPrompt: "TASK_HOST_PROMPT" },
        noninteractiveTask: true,
      }),
    ).rejects.toThrow("A task session requires a private agent directory.");
  });

  it("keeps valid repository and agent resources out of a task loader", async () => {
    const root = await roots.create("docsfab-live-task-resources-");
    const repositoryPath = join(root, "repository");
    const agentDir = join(root, "private-agent");
    const repositorySkill = "REPOSITORY_HOSTILE_SKILL_MARKER";
    const agentSkill = "AGENT_HOSTILE_SKILL_MARKER";
    const repositoryPrompt = "REPOSITORY_HOSTILE_PROMPT_MARKER";
    const agentPrompt = "AGENT_HOSTILE_PROMPT_MARKER";
    const repositoryContext = "REPOSITORY_HOSTILE_CONTEXT_MARKER";
    const agentContext = "AGENT_HOSTILE_CONTEXT_MARKER";
    const agentSystem = "AGENT_HOSTILE_SYSTEM_MARKER";
    const hostSystemPrompt = "TASK_HOST_AUTHORIZED_SYSTEM_PROMPT";

    await Promise.all([
      mkdir(repositoryPath, { recursive: true }),
      mkdir(agentDir, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(repositoryPath, "AGENTS.md"), `${repositoryContext}\n`),
      writeFile(join(agentDir, "AGENTS.md"), `${agentContext}\n`),
      writeFile(join(agentDir, "SYSTEM.md"), `${agentSystem}\n`),
      writeSkill(
        join(repositoryPath, ".pi", "skills", "repository-hostile"),
        "repository-hostile",
        repositorySkill,
      ),
      writeSkill(join(agentDir, "skills", "agent-hostile"), "agent-hostile", agentSkill),
      writePrompt(join(repositoryPath, ".pi", "prompts"), "repository-hostile", repositoryPrompt),
      writePrompt(join(agentDir, "prompts"), "agent-hostile", agentPrompt),
    ]);

    // This control uses Pi's real loaders with explicit local resource paths.
    // It proves the hostile fixture contains valid, discoverable context,
    // skills, and prompt templates before the task policy is applied.
    const ambientControl = new DefaultResourceLoader({
      cwd: repositoryPath,
      agentDir,
      settingsManager: SettingsManager.inMemory(),
      noExtensions: true,
      additionalSkillPaths: [join(repositoryPath, ".pi", "skills"), join(agentDir, "skills")],
      additionalPromptTemplatePaths: [
        join(repositoryPath, ".pi", "prompts"),
        join(agentDir, "prompts"),
      ],
    });
    await ambientControl.reload();
    expect(ambientControl.getSkills().skills.map(({ name }) => name)).toEqual(
      expect.arrayContaining(["repository-hostile", "agent-hostile"]),
    );
    expect(
      ambientControl
        .getPrompts()
        .prompts.map(({ content }) => content)
        .join("\n"),
    ).toContain(repositoryPrompt);
    expect(
      ambientControl
        .getPrompts()
        .prompts.map(({ content }) => content)
        .join("\n"),
    ).toContain(agentPrompt);
    const ambientContext = ambientControl
      .getAgentsFiles()
      .agentsFiles.map(({ content }) => content)
      .join("\n");
    expect(ambientContext).toContain(repositoryContext);
    expect(ambientContext).toContain(agentContext);
    expect(ambientControl.getSystemPrompt()).toContain(agentSystem);

    const taskLoader = await createLiveAgentResourceLoader({
      repositoryPath,
      agentDir,
      noninteractiveTask: true,
      host: { systemPrompt: hostSystemPrompt },
    });

    expect(taskLoader.getSystemPrompt()).toBe(hostSystemPrompt);
    expect(taskLoader.getAppendSystemPrompt()).toEqual([]);
    expect(taskLoader.getSkills().skills).toEqual([]);
    expect(taskLoader.getPrompts().prompts).toEqual([]);
    expect(taskLoader.getThemes().themes).toEqual([]);
    expect(taskLoader.getAgentsFiles().agentsFiles).toEqual([]);
  });
});
