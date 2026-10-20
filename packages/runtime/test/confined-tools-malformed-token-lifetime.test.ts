// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * A malformed call's single-use token outlives its call when `execute` never
 * runs, as in an aborted batch. On the longest-lived tool set, the live
 * agent's one per terminal session, such a stale token can only refuse: run
 * late, replayed, or carried to another tool, it never admits a mutation.
 */
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import type { DocsFabConfig } from "../src/config/runtime-loader.js";
import { malformedArgumentsMessage, safeFailureMessage } from "../src/harness/confined-tools.js";
import { assembleLiveAgentHost } from "../src/live-agent/host.js";
import { verifyCatalogSkill } from "../src/skills/catalog-crate.js";
import { git, initFixtureRepo } from "./helpers/git.js";
import { temporaryRoots } from "./helpers/temp.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";

const roots = temporaryRoots();
const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
type Tool = {
  name: string;
  prepareArguments?: (raw: unknown) => unknown;
  execute: (...arguments_: any[]) => Promise<any>;
};

/** The write-enabled live host exactly as `runLiveAgent` assembles it for one session. */
async function liveSession() {
  const root = await roots.create("docsfab-stale-token-");
  const repositoryPath = join(root, "repo");
  const verifiedSkill = await verifyCatalogSkill({
    skillCrateDirectory: resolve("skill-crate"),
    skillId: "write-documentation",
    grantedTools: ["read", "grep", "find", "ls", "edit", "write"],
  });
  await initFixtureRepo(
    repositoryPath,
    { "docs/guide.md": "Guide original.\n" },
    { branch: "main", message: "Fixture base" },
  );
  await git(repositoryPath, ["config", "core.hooksPath", "/dev/null"]);
  const host = await assembleLiveAgentHost({
    repositoryPath,
    allowWrite: true,
    environment: { PATH: process.env.PATH },
    config: {
      projectRoot: runtimeRoot,
      stateDirectory: join(root, "state"),
      model: { provider: "none", model: "none" },
    } as unknown as DocsFabConfig,
    capabilities: {
      skills: [{ lock: verifiedSkill.skill, directory: verifiedSkill.directory }],
      qualityPack: { id: "docsfab-default", version: "1.0.0" } as never,
      workflows: [],
    },
    sourcePorts: {} as never,
    onNotice: () => undefined,
    writeError: () => undefined,
    runWorkflow: vi.fn() as never,
  });
  host.terminalOptions.onUserTurn?.("Update the documentation in this repository.");
  const useSkill = host.customTools.find((tool) => tool.name === "docsfab_use_skill")!;
  await useSkill.execute(
    "use-skill",
    { skill: "write-documentation" },
    undefined,
    undefined,
    {} as never,
  );
  const tools = host.customTools as unknown as Tool[];
  const find = (name: string) => tools.find((candidate) => candidate.name === name)!;
  /** Pi's preparation: prepare, then clone (validateToolArguments). */
  const prepare = (name: string, raw: Record<string, unknown>) => {
    const tool = find(name);
    expect(tool.prepareArguments, name).toBeTypeOf("function");
    return structuredClone(tool.prepareArguments!(raw)) as Record<string, unknown>;
  };
  const execute = (name: string, args: unknown) =>
    find(name).execute(name, args, undefined, undefined, {} as never);
  return { repositoryPath, prepare, execute };
}

describe("a stale malformed-call token on the live agent's session tool set", () => {
  it("refuses the token run late, replayed, or carried to another tool, and admits no mutation", {
    timeout: testTimeoutMs(30_000),
  }, async () => {
    const live = await liveSession();
    const guide = join(live.repositoryPath, "docs", "guide.md");
    // Prepared and never executed: the batch was aborted after preparation.
    const stale = live.prepare("write", {
      path: "docs/guide.md",
      content: "Stale.\n",
      extra: true,
    });
    const carried = live.prepare("write", {
      path: "docs/guide.md",
      content: "Carried.\n",
      extra: true,
    });
    expect(stale.path).not.toBe("docs/guide.md");

    // The session goes on: a well-formed write later in the session succeeds.
    await live.execute("write", live.prepare("write", { path: "docs/new.md", content: "# New\n" }));
    expect(await readFile(join(live.repositoryPath, "docs", "new.md"), "utf8")).toBe("# New\n");

    // Run late, the stale call is still the refused malformed call it was.
    await expect(live.execute("write", stale)).rejects.toThrow(malformedArgumentsMessage("write"));
    // Taken once, the token is gone; a replay is a refused path.
    await expect(
      live.execute("write", { path: stale.path, content: "Replayed.\n" }),
    ).rejects.toThrow(safeFailureMessage("denied-path"));
    // Another tool's registry never held the token.
    await expect(
      live.execute("edit", {
        path: carried.path,
        edits: [{ oldText: "Guide original.", newText: "Carried." }],
      }),
    ).rejects.toThrow(safeFailureMessage("denied-path"));

    expect(await readFile(guide, "utf8")).toBe("Guide original.\n");
    expect((await readdir(join(live.repositoryPath, "docs"))).sort()).toEqual([
      "guide.md",
      "new.md",
    ]);
  });
});
