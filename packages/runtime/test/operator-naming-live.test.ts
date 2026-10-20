// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assembleLiveAgentHost } from "../src/live-agent/host.js";
import { initFixtureRepo } from "./helpers/git.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";
import { runtimeConfig } from "./support/execution-convergence.js";
import { verifyCatalogSkill } from "../src/skills/catalog-crate.js";

const roots: string[] = [];
const budget = { timeout: testTimeoutMs(30_000) };
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function live(instruction: string) {
  const root = await mkdtemp(join(tmpdir(), "docsfab-naming-live-"));
  roots.push(root);
  const repository = join(root, "repository");
  const verifiedSkill = await verifyCatalogSkill({
    skillCrateDirectory: resolve("skill-crate"),
    skillId: "write-documentation",
    grantedTools: ["read", "grep", "find", "ls", "edit", "write"],
  });
  const paths = ["docs/WARP.md", "docs/.operator-notes/guide.md", "docs/agents/index.md"];
  await initFixtureRepo(repository, Object.fromEntries(paths.map((path) => [path, "original\n"])), {
    branch: "main",
  });
  const host = await assembleLiveAgentHost({
    repositoryPath: repository,
    allowWrite: true,
    environment: { PATH: process.env.PATH },
    config: runtimeConfig(join(root, "state")),
    capabilities: {
      skills: [{ lock: verifiedSkill.skill, directory: verifiedSkill.directory }],
      qualityPack: { id: "docsfab-default", version: "1.0.0" } as never,
      workflows: [],
    },
    sourcePorts: {} as never,
    onNotice() {},
    writeError() {},
    runWorkflow: async () => {
      throw new Error("A direct edit must not invoke a workflow.");
    },
  });
  host.terminalOptions.onUserTurn?.(instruction);
  const useSkill = host.customTools.find((tool) => tool.name === "docsfab_use_skill")!;
  await useSkill.execute(
    "use-skill",
    { skill: "write-documentation" },
    undefined,
    undefined,
    {} as never,
  );
  const write = host.customTools.find((tool) => tool.name === "write")!;
  const edit = host.customTools.find((tool) => tool.name === "edit")!;
  return {
    repository,
    write: (path: string) =>
      write.execute("write", { path, content: "updated\n" }, undefined, undefined, {} as never),
    edit: (path: string) =>
      edit.execute(
        "edit",
        { path, edits: [{ oldText: "original", newText: "updated" }] },
        undefined,
        undefined,
        {} as never,
      ),
  };
}

describe("the assembled live host uses only verbatim operator messages", () => {
  it.each(["docs/WARP.md", "docs/.operator-notes/guide.md"])(
    "refuses an unnamed direct write and edit to %s",
    budget,
    async (path) => {
      const host = await live("Update the documentation.");
      await expect(host.write(path)).rejects.toThrow("messages in this session do not name");
      await expect(host.edit(path)).rejects.toThrow("messages in this session do not name");
      expect(await readFile(join(host.repository, path), "utf8")).toBe("original\n");
    },
  );
  it.each(["docs/WARP.md", "docs/.operator-notes/guide.md"])(
    "writes the exact named %s (control)",
    budget,
    async (path) => {
      const host = await live(`Update ${path} for the new option.`);
      await host.write(path);
      expect(await readFile(join(host.repository, path), "utf8")).toBe("updated\n");
    },
  );
  it(
    "writes a normal agents directory page without naming the file (control)",
    budget,
    async () => {
      const host = await live("Update the documentation.");
      await host.write("docs/agents/index.md");
      expect(await readFile(join(host.repository, "docs/agents/index.md"), "utf8")).toBe(
        "updated\n",
      );
    },
  );
});
