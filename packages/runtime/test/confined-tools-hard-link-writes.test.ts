// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * A confined edit or write never changes a file outside the workspace through
 * a hard link. A workspace name that shares its inode with an outside file is
 * refused as `link` before any byte moves, whatever grant admitted the path,
 * and at every shipped site that builds a confined tool set.
 */
import { link, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { DocsFabConfig } from "../src/config/runtime-loader.js";
import { runDelegatedTask } from "../src/delegated-task/driver.js";
import {
  attemptDelegatedWriteActivation,
  createDelegatedTaskAuthority,
  grantedDirectToolNames,
  probeDelegatedOperation,
} from "../src/delegated-task/authority-adapter.js";
import type { HarnessStepInput } from "../src/execution/contracts.js";
import { createConfinedToolSet, safeFailureMessage } from "../src/harness/confined-tools.js";
import { VIRTUAL_WORKSPACE_CWD } from "../src/harness/pi-session.js";
import { DocumentationScope } from "../src/live-agent/documentation-scope.js";
import { assembleLiveAgentHost } from "../src/live-agent/host.js";
import {
  isRepositoryBootstrapGuidancePath,
  REPOSITORY_BOOTSTRAP_STEP,
} from "../src/onboarding/bootstrap-result.js";
import { git, initFixtureRepo } from "./helpers/git.js";
import { validModelConfig } from "./helpers.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";
import { installedLiveAgentCapabilities } from "./support/live-agent-installed-capabilities.js";
import {
  createAuditHarness,
  documentationPlanBinding,
  getWorkflow,
  resetSharedTestState,
  textTurn,
  toolTurn,
} from "./support/pi-harness-session-fixtures.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  await resetSharedTestState();
});

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUTSIDE_BYTES = "# Outside the workspace\n\nOriginal text.\n";
const DENIED = safeFailureMessage("denied-path");

async function tempDirectory(prefix: string): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  roots.push(root);
  return root;
}

interface OutsideFile {
  path: string;
  /** Content and mtime are unchanged since the fixture linked it. */
  expectUnchanged(): Promise<void>;
}

/**
 * Replace `relativePath` in `workspace` with a hard link to a fresh file in a
 * separate temporary directory, outside the workspace.
 */
async function hardLinkOutside(workspace: string, relativePath: string): Promise<OutsideFile> {
  const outsideRoot = await tempDirectory("docsfab-hard-link-outside-");
  const path = join(outsideRoot, "outside.md");
  await writeFile(path, OUTSIDE_BYTES);
  const inside = join(workspace, relativePath);
  await mkdir(dirname(inside), { recursive: true });
  await rm(inside, { force: true });
  await link(path, inside);
  const before = await stat(path);
  expect(before.nlink).toBe(2);
  return {
    path,
    async expectUnchanged() {
      expect(await readFile(path, "utf8")).toBe(OUTSIDE_BYTES);
      const after = await stat(path);
      expect(after.mtimeMs).toBe(before.mtimeMs);
      expect(after.size).toBe(before.size);
      expect(after.ino).toBe(before.ino);
    },
  };
}

type ToolSet = Awaited<ReturnType<typeof createConfinedToolSet>>;
interface CallableTool {
  name: string;
  prepareArguments?: (raw: unknown) => unknown;
  execute: (...arguments_: any[]) => Promise<any>;
}

/** Pi's own order: prepare, clone (validateToolArguments), then execute. */
function caller(tools: readonly CallableTool[]) {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  return (name: "edit" | "write", raw: Record<string, unknown>) => {
    const tool = byName.get(name)!;
    expect(tool, name).toBeDefined();
    const prepared = structuredClone(tool.prepareArguments ? tool.prepareArguments(raw) : raw);
    return tool.execute(name, prepared as never, undefined, undefined, {} as never);
  };
}

function mutation(tool: "edit" | "write", path: string): Record<string, unknown> {
  return tool === "write"
    ? { path, content: "Replaced through the link.\n" }
    : { path, edits: [{ oldText: "Original text.", newText: "Edited through the link." }] };
}

/** Every spelling the confinement judges as the same workspace path. */
function spellings(path: string): string[] {
  return [path, `./${path}`, `@${path}`, `${VIRTUAL_WORKSPACE_CWD}/${path}`];
}

const GRANT_MODES: readonly {
  grant: string;
  linked: string;
  writable: string;
  options: () => Partial<Parameters<typeof createConfinedToolSet>[0]>;
}[] = [
  {
    grant: "an ungated write step",
    linked: "docs/guide.md",
    writable: "docs/other.md",
    options: () => ({}),
  },
  {
    grant: "an approved plan or bounded task (exact granted leaves)",
    linked: "docs/guide.md",
    writable: "docs/other.md",
    options: () => ({ allowedWritePaths: ["docs/guide.md", "docs/other.md"] }),
  },
  {
    grant: "the bootstrap gate",
    linked: "AGENTS.md",
    writable: "README.md",
    options: () => ({ isWritePathAllowed: isRepositoryBootstrapGuidancePath }),
  },
  {
    grant: "the live-agent documentation scope",
    linked: "docs/guide.md",
    writable: "docs/other.md",
    options: () => {
      const scope = new DocumentationScope();
      return { isWritePathAllowed: (path: string) => scope.allows(path) };
    },
  },
];

describe("a hard-linked write target is refused in every grant mode", () => {
  it.each(GRANT_MODES)(
    "refuses edit and write through a hard link under $grant and leaves the outside file unchanged",
    async ({ linked, writable, options }) => {
      const workspace = await tempDirectory("docsfab-hard-link-workspace-");
      const outside = await hardLinkOutside(workspace, linked);
      const toolSet: ToolSet = await createConfinedToolSet({
        workspacePath: workspace,
        allowWrite: true,
        ...options(),
      });
      const call = caller(toolSet.definitions as CallableTool[]);
      let refused = 0;
      for (const tool of ["edit", "write"] as const) {
        for (const path of spellings(linked)) {
          await expect(call(tool, mutation(tool, path)), `${tool} ${path}`).rejects.toThrow(DENIED);
          refused += 1;
          await outside.expectUnchanged();
        }
      }
      expect(toolSet.getMutationRefusals()).toEqual([{ reason: "link", count: refused }]);
      expect(toolSet.getMutationBoundaryDenials()).toBe(refused);
      expect(toolSet.getFailureCategories()).toEqual([{ category: "denied-path", count: refused }]);

      // The grant still admits an ordinary file: the refusal is the link, not the mode.
      await call("write", { path: writable, content: "Ordinary write.\n" });
      expect(await readFile(join(workspace, writable), "utf8")).toBe("Ordinary write.\n");
      await outside.expectUnchanged();
    },
  );
});

/** Model turns: a write, then an edit, through the hard link, then a reply. */
function scriptedHardLinkTurns(path: string, reply: string): () => typeof fetch {
  return () => {
    let turn = 0;
    return (async () => {
      turn += 1;
      if (turn === 1) {
        return toolTurn([{ id: "write-1", name: "write", arguments: mutation("write", path) }]);
      }
      if (turn === 2) {
        return toolTurn([{ id: "edit-1", name: "edit", arguments: mutation("edit", path) }]);
      }
      return textTurn(reply);
    }) as typeof fetch;
  };
}

async function harnessRepository(): Promise<string> {
  const repositoryPath = await tempDirectory("docsfab-hard-link-harness-");
  await writeFile(join(repositoryPath, "README.md"), "# Fixture\n");
  return repositoryPath;
}

function writeStep(repositoryPath: string): HarnessStepInput {
  const workflow = getWorkflow("restructure-documentation");
  return {
    runId: "hard-link-write-step",
    repositoryPath,
    workflow,
    step: workflow.steps.find((candidate) => candidate.id === "write-documentation")!,
    evidenceIdentity: { repositoryRevision: "a".repeat(40) },
  };
}

const BOUNDED_TASK = {
  kind: "bounded-doc-improvement" as const,
  campaignId: "campaign-1",
  repositoryId: "fixture/repository",
  testedCommit: "a".repeat(40),
  repositoryIdentitySha256: "b".repeat(64),
  contextSourcePath: "README.md",
  gap: {
    id: "readme-gap",
    evidenceSha256: "c".repeat(64),
    successCriterionSha256: "d".repeat(64),
  },
  analysis: {
    runId: "analysis-1",
    recordSha256: "e".repeat(64),
    approvedOutcomeSha256: "f".repeat(64),
    approvedProposal: "Clarify the README.",
  },
  authorization: { sha256: "0".repeat(64), digest: "1".repeat(64) },
  intendedPaths: ["README.md"],
};

const HARNESS_MODES: readonly {
  grant: string;
  input: (repositoryPath: string) => HarnessStepInput;
}[] = [
  { grant: "an ungated write step", input: writeStep },
  {
    grant: "an approved plan",
    input: (repositoryPath) => ({
      ...writeStep(repositoryPath),
      planBinding: documentationPlanBinding("restructure", "README.md"),
    }),
  },
  {
    grant: "a bounded task",
    input: (repositoryPath) => ({ ...writeStep(repositoryPath), task: BOUNDED_TASK }),
  },
  {
    grant: "the bootstrap gate",
    input: (repositoryPath) => {
      const workflow = getWorkflow("bootstrap");
      return {
        runId: "hard-link-bootstrap-step",
        repositoryPath,
        workflow,
        step: workflow.steps.find((candidate) => candidate.id === REPOSITORY_BOOTSTRAP_STEP)!,
        evidenceIdentity: { repositoryRevision: "a".repeat(40) },
      };
    },
  },
];

describe("the shipped tool-set construction sites refuse a hard-linked write target", () => {
  it.each(HARNESS_MODES)(
    "Pi harness step under $grant refuses the model's write and edit through a hard link",
    { timeout: testTimeoutMs(30_000) },
    async ({ input }) => {
      const repositoryPath = await harnessRepository();
      const outside = await hardLinkOutside(repositoryPath, "README.md");
      vi.stubGlobal(
        "fetch",
        scriptedHardLinkTurns("README.md", "The requested documentation was updated.")(),
      );
      const harness = await createAuditHarness();
      const outcome = await harness.runStep(input(repositoryPath)).then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
      await outside.expectUnchanged();
      expect(await readFile(join(repositoryPath, "README.md"), "utf8")).toBe(OUTSIDE_BYTES);
      // A bootstrap step that ends in prose fails its own reply decode after
      // the refusals; every other mode returns the count it refused.
      if ("result" in outcome) {
        expect(outcome.result.mutationBoundaryDenials).toBe(2);
        expect(outcome.result.tools?.failureCategories).toEqual([
          { category: "denied-path", count: 2 },
        ]);
      } else {
        expect(input(repositoryPath).workflow.name).toBe("bootstrap");
      }
    },
  );

  it("live agent's write-enabled session refuses write and edit through a hard link", {
    timeout: testTimeoutMs(30_000),
  }, async () => {
    const root = await tempDirectory("docsfab-hard-link-live-");
    const repositoryPath = join(root, "repo");
    await initFixtureRepo(
      repositoryPath,
      { "docs/guide.md": "Guide original.\n" },
      { branch: "main", message: "Fixture base" },
    );
    await git(repositoryPath, ["config", "core.hooksPath", "/dev/null"]);
    const outside = await hardLinkOutside(repositoryPath, "docs/guide.md");
    const host = await assembleLiveAgentHost({
      repositoryPath,
      allowWrite: true,
      environment: { PATH: process.env.PATH },
      config: {
        projectRoot: runtimeRoot,
        stateDirectory: join(root, "state"),
        model: { provider: "none", model: "none" },
      } as unknown as DocsFabConfig,
      capabilities: await installedLiveAgentCapabilities(["update-documentation"]),
      sourcePorts: {} as never,
      onNotice: () => undefined,
      writeError: () => undefined,
      runWorkflow: vi.fn() as never,
    });
    host.terminalOptions.onUserTurn?.("Update the documentation in this checkout.");
    const skill = host.customTools.find((tool) => tool.name === "docsfab_use_skill");
    if (!skill) throw new Error("Missing installed documentation skill tool.");
    await skill.execute(
      "skill",
      { skill: "write-documentation" },
      undefined,
      undefined,
      {} as never,
    );
    const call = caller(host.customTools as unknown as CallableTool[]);
    for (const tool of ["write", "edit"] as const) {
      for (const path of spellings("docs/guide.md")) {
        await expect(call(tool, mutation(tool, path)), `${tool} ${path}`).rejects.toThrow(DENIED);
        await outside.expectUnchanged();
      }
    }
    // The same session still writes an ordinary documentation file.
    await call("write", { path: "docs/new.md", content: "# New\n" });
    expect(await readFile(join(repositoryPath, "docs", "new.md"), "utf8")).toBe("# New\n");
    await outside.expectUnchanged();
  });

  it("delegated task session offers no edit or write, so a hard-linked file cannot change", {
    timeout: testTimeoutMs(30_000),
  }, async () => {
    const root = await tempDirectory("docsfab-hard-link-delegated-");
    const repositoryPath = join(root, "repo");
    const agentDir = join(root, "agent");
    await mkdir(join(repositoryPath, "docs"), { recursive: true });
    await mkdir(agentDir);
    const outside = await hardLinkOutside(repositoryPath, "docs/reference.md");
    const offeredTools: string[][] = [];
    const turns = scriptedHardLinkTurns("docs/reference.md", "No change was made.")();
    vi.stubGlobal("fetch", async (request: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        tools?: { function?: { name?: string } }[];
      };
      offeredTools.push((body.tools ?? []).map((tool) => tool.function?.name ?? ""));
      return turns(request, init);
    });

    await runDelegatedTask({
      outcome: "Rewrite docs/reference.md.",
      repositoryPath,
      repositoryIdentity: { canonicalPath: repositoryPath, revision: "a".repeat(40) },
      sessionLifetime: { kind: "fresh" },
      limits: { maxProviderTurns: 8, maxToolCalls: 8, timeoutMs: 15_000 },
      model: validModelConfig,
      agentDir,
      persistChildRun: vi.fn(async () => undefined),
    }).catch(() => undefined);

    expect(offeredTools.length).toBeGreaterThan(0);
    for (const names of offeredTools) {
      expect(names).toContain("read");
      expect(names).not.toContain("edit");
      expect(names).not.toContain("write");
    }
    await outside.expectUnchanged();

    // The delegated authority's own tool set is read-only and its write classes are blocked.
    const authority = await createDelegatedTaskAuthority({ repositoryPath, allowWrite: true });
    expect(grantedDirectToolNames(authority)).not.toEqual(
      expect.arrayContaining(["edit", "write"]),
    );
    for (const operation of ["edit", "write"] as const) {
      expect(
        await probeDelegatedOperation(authority, operation, "docs/reference.md"),
      ).toMatchObject({ status: "denied", code: "write-activation-blocked" });
    }
    expect(await attemptDelegatedWriteActivation(authority)).toMatchObject({ status: "denied" });
    await outside.expectUnchanged();
  });
});
