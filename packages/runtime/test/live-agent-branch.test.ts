// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";

import { createConfinedToolSet } from "../src/harness/confined-tools.js";
import { canonicalDigest } from "../src/content-ir/canonical.js";
import { createLiveCommandTool } from "../src/live-agent/command-tool.js";
import { createLiveAgentToolDefinitions } from "../src/live-agent/capabilities.js";
import {
  TASK_BRANCH_FAILURES,
  TASK_BRANCH_PREFIX,
  createLiveAgentMutationGuard,
  prepareTaskBranch,
} from "../src/live-agent/branch-preparation.js";
import { LiveWorkflowDelivery } from "../src/live-agent/workflow-delivery.js";
import type { RunRecord } from "../src/records/contracts.js";
import { verifyCatalogSkill } from "../src/skills/catalog-crate.js";
import { temporaryRoots } from "./helpers/temp.js";
import { git, initFixtureRepo } from "./helpers/git.js";

const exec = promisify(execFile);
const roots = temporaryRoots();

async function gitBinary(cwd: string, args: string[]): Promise<Buffer> {
  const result = await exec("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "buffer",
  });
  return result.stdout;
}

async function repository(options: {
  branch?: string;
  originDefault?: string;
  detach?: boolean;
}): Promise<{
  root: string;
  repositoryPath: string;
  defaultRef: string;
  defaultSha: string;
}> {
  const root = await roots.create("docsfab-live-branch-");
  const repositoryPath = join(root, "repo");
  const branch = options.branch ?? "main";
  const defaultSha = await initFixtureRepo(
    repositoryPath,
    { "docs/guide.md": "Original guide.\n", "README.md": "Original documentation.\n" },
    { branch, message: "Fixture base" },
  );
  // Production code under test runs Git with the ambient environment; keep host hooks out.
  await git(repositoryPath, ["config", "core.hooksPath", "/dev/null"]);
  if (options.originDefault) {
    const remote = join(root, "origin.git");
    await git(root, ["init", "--bare", "-q", remote]);
    await git(repositoryPath, ["remote", "add", "origin", remote]);
    await git(repositoryPath, [
      "update-ref",
      `refs/remotes/origin/${options.originDefault}`,
      "HEAD",
    ]);
    await git(repositoryPath, [
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      `refs/remotes/origin/${options.originDefault}`,
    ]);
  }
  if (options.detach) await git(repositoryPath, ["switch", "--detach", "--quiet"]);
  return {
    root,
    repositoryPath,
    defaultRef: `refs/heads/${branch}`,
    defaultSha,
  };
}

async function call(
  tools: Awaited<ReturnType<typeof createConfinedToolSet>>,
  name: string,
  parameters: Record<string, unknown>,
) {
  const tool = tools.definitions.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing tool ${name}`);
  return tool.execute(`test-${name}`, parameters, undefined, undefined, {} as never);
}

async function porcelain(repositoryPath: string): Promise<string> {
  return git(repositoryPath, ["status", "--porcelain"]);
}

async function currentBranch(repositoryPath: string): Promise<string> {
  return git(repositoryPath, ["branch", "--show-current"]);
}

describe("live-agent task branch preparation", () => {
  it("creates a unique task branch before a write on main and reuses it", async () => {
    const fixture = await repository({});
    const notices: string[] = [];
    const guard = createLiveAgentMutationGuard({
      repositoryPath: fixture.repositoryPath,
      onNotice: (message) => notices.push(message),
    });
    const tools = await createConfinedToolSet({
      workspacePath: fixture.repositoryPath,
      allowWrite: true,
      beforeMutation: () => guard.assertPrepared(),
    });
    await call(tools, "write", { path: "docs/guide.md", content: "Direct edit.\n" });
    const first = await currentBranch(fixture.repositoryPath);
    expect(first.startsWith(TASK_BRANCH_PREFIX)).toBe(true);
    expect(await git(fixture.repositoryPath, ["rev-parse", fixture.defaultRef])).toBe(
      fixture.defaultSha,
    );
    expect(await readFile(join(fixture.repositoryPath, "docs", "guide.md"), "utf8")).toBe(
      "Direct edit.\n",
    );
    await call(tools, "edit", {
      path: "docs/guide.md",
      edits: [{ oldText: "Direct edit.", newText: "Second edit." }],
    });
    expect(await currentBranch(fixture.repositoryPath)).toBe(first);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain(first);
    expect(notices[0]).toContain("not worktree isolation");
  });

  it("creates a task branch from a differently named default and from detached HEAD", async () => {
    const named = await repository({ branch: "trunk", originDefault: "trunk" });
    const namedGuard = createLiveAgentMutationGuard({ repositoryPath: named.repositoryPath });
    const namedTools = await createConfinedToolSet({
      workspacePath: named.repositoryPath,
      allowWrite: true,
      beforeMutation: () => namedGuard.assertPrepared(),
    });
    await call(namedTools, "write", { path: "docs/guide.md", content: "Trunk edit.\n" });
    expect((await currentBranch(named.repositoryPath)).startsWith(TASK_BRANCH_PREFIX)).toBe(true);
    expect(await git(named.repositoryPath, ["rev-parse", named.defaultRef])).toBe(named.defaultSha);

    const detached = await repository({ detach: true });
    const detachedGuard = createLiveAgentMutationGuard({
      repositoryPath: detached.repositoryPath,
    });
    const detachedTools = await createConfinedToolSet({
      workspacePath: detached.repositoryPath,
      allowWrite: true,
      beforeMutation: () => detachedGuard.assertPrepared(),
    });
    await call(detachedTools, "write", { path: "docs/guide.md", content: "Detached edit.\n" });
    expect((await currentBranch(detached.repositoryPath)).startsWith(TASK_BRANCH_PREFIX)).toBe(
      true,
    );
    expect(await git(detached.repositoryPath, ["rev-parse", detached.defaultRef])).toBe(
      detached.defaultSha,
    );
  });

  it("reuses an existing topic branch and preserves staged, unstaged, and untracked work", async () => {
    const fixture = await repository({});
    await git(fixture.repositoryPath, ["switch", "-c", "docs/existing-topic"]);
    await writeFile(join(fixture.repositoryPath, "docs", "unstaged.md"), "unstaged\n");
    await git(fixture.repositoryPath, ["add", "docs/unstaged.md"]);
    await writeFile(join(fixture.repositoryPath, "docs", "unstaged.md"), "unstaged dirty\n");
    await writeFile(join(fixture.repositoryPath, "docs", "untracked.md"), "untracked\n");
    const before = await porcelain(fixture.repositoryPath);
    const guard = createLiveAgentMutationGuard({ repositoryPath: fixture.repositoryPath });
    const tools = await createConfinedToolSet({
      workspacePath: fixture.repositoryPath,
      allowWrite: true,
      beforeMutation: () => guard.assertPrepared(),
    });
    await call(tools, "write", { path: "docs/guide.md", content: "Topic edit.\n" });
    expect(await currentBranch(fixture.repositoryPath)).toBe("docs/existing-topic");
    expect(await porcelain(fixture.repositoryPath)).toContain("docs/unstaged.md");
    expect(await porcelain(fixture.repositoryPath)).toContain("docs/untracked.md");
    expect(await readFile(join(fixture.repositoryPath, "docs", "unstaged.md"), "utf8")).toBe(
      "unstaged dirty\n",
    );
    expect(before).toContain("docs/unstaged.md");
    expect(await git(fixture.repositoryPath, ["rev-parse", fixture.defaultRef])).toBe(
      fixture.defaultSha,
    );
  });

  it("refuses a colliding branch name without overwriting it or writing files", async () => {
    const fixture = await repository({});
    await git(fixture.repositoryPath, ["switch", "-c", `${TASK_BRANCH_PREFIX}taken`]);
    await writeFile(join(fixture.repositoryPath, "docs", "taken.md"), "taken\n");
    await git(fixture.repositoryPath, ["add", "docs/taken.md"]);
    await git(fixture.repositoryPath, ["commit", "-qm", "Diverge colliding branch"]);
    const takenSha = await git(fixture.repositoryPath, [
      "rev-parse",
      `refs/heads/${TASK_BRANCH_PREFIX}taken`,
    ]);
    await git(fixture.repositoryPath, ["switch", "main"]);
    const original = await readFile(join(fixture.repositoryPath, "docs", "guide.md"), "utf8");
    const guard = createLiveAgentMutationGuard({
      repositoryPath: fixture.repositoryPath,
      createBranchName: () => `${TASK_BRANCH_PREFIX}taken`,
    });
    const tools = await createConfinedToolSet({
      workspacePath: fixture.repositoryPath,
      allowWrite: true,
      beforeMutation: () => guard.assertPrepared(),
    });
    await expect(
      call(tools, "write", { path: "docs/guide.md", content: "Should not land.\n" }),
    ).rejects.toThrow(TASK_BRANCH_FAILURES.collision);
    expect(await currentBranch(fixture.repositoryPath)).toBe("main");
    expect(await readFile(join(fixture.repositoryPath, "docs", "guide.md"), "utf8")).toBe(original);
    expect(
      await git(fixture.repositoryPath, ["rev-parse", `refs/heads/${TASK_BRANCH_PREFIX}taken`]),
    ).toBe(takenSha);
  });

  it("leaves the branch unchanged for reads and skill-instruction loading", async () => {
    const fixture = await repository({});
    const prepare = vi.fn(async () => undefined);
    const tools = await createConfinedToolSet({
      workspacePath: fixture.repositoryPath,
      allowWrite: true,
      beforeMutation: prepare,
    });
    await call(tools, "read", { path: "docs/guide.md" });
    expect(prepare).not.toHaveBeenCalled();
    expect(await currentBranch(fixture.repositoryPath)).toBe("main");

    const verified = await verifyCatalogSkill({
      skillCrateDirectory: resolve("skill-crate"),
      skillId: "review-documentation",
      grantedTools: ["read", "grep", "find", "ls"],
    });
    const liveTools = createLiveAgentToolDefinitions({
      allowWrite: true,
      capabilities: {
        skills: [{ lock: verified.skill, directory: verified.directory }],
        qualityPack: {} as never,
        workflows: [],
      },
      async runWorkflow() {
        throw new Error("No workflow needed for skill instruction loading.");
      },
    });
    const skill = liveTools.find((tool) => tool.name === "docsfab_use_skill");
    if (!skill) throw new Error("Missing skill tool");
    await skill.execute(
      "skill",
      { skill: "review-documentation" },
      undefined,
      undefined,
      {} as never,
    );
    expect(await currentBranch(fixture.repositoryPath)).toBe("main");
    expect(await git(fixture.repositoryPath, ["rev-parse", fixture.defaultRef])).toBe(
      fixture.defaultSha,
    );
  });

  it("prepares a task branch before command-driven documentation writes", async () => {
    const fixture = await repository({});
    const guard = createLiveAgentMutationGuard({ repositoryPath: fixture.repositoryPath });
    const tool = createLiveCommandTool({
      repositoryPath: fixture.repositoryPath,
      allowWrite: true,
      confirm: async () => true,
      beforeMutation: () => guard.assertPrepared(),
    });
    const result = await tool.execute(
      "bash",
      { command: "printf 'from-command\\n' > README.md" },
      undefined,
      undefined,
      {} as never,
    );
    expect(result.details).toMatchObject({ status: "succeeded", exitCode: 0 });
    expect((await currentBranch(fixture.repositoryPath)).startsWith(TASK_BRANCH_PREFIX)).toBe(true);
    expect(await readFile(join(fixture.repositoryPath, "README.md"), "utf8")).toBe(
      "from-command\n",
    );
    expect(await git(fixture.repositoryPath, ["rev-parse", fixture.defaultRef])).toBe(
      fixture.defaultSha,
    );
  });

  it("prepares a task branch before workflow persist applies a saved patch", async () => {
    const fixture = await repository({});
    await writeFile(join(fixture.repositoryPath, "README.md"), "Updated documentation.\n");
    const patchBytes = await gitBinary(fixture.repositoryPath, ["diff", "--binary"]);
    await writeFile(join(fixture.repositoryPath, "README.md"), "Original documentation.\n");
    const stateDirectory = join(fixture.root, "state");
    await mkdir(stateDirectory);
    const artifactPath = join(stateDirectory, "run-1.patch");
    await writeFile(artifactPath, patchBytes, { mode: 0o600 });
    const revision = fixture.defaultSha;
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0 };
    const toolUsage = { totalCalls: 0, failedCalls: 0, byTool: [] };
    const reference = {
      kind: "ia-plan",
      schemaVersion: 1,
      digest: "a".repeat(64),
      repositoryRevision: revision,
      repositoryContentDigest: "b".repeat(64),
    };
    const record = {
      schemaVersion: 2,
      id: "run-1",
      workflow: "site-bootstrap",
      repository: {
        sourcePath: fixture.repositoryPath,
        requestedRevision: "HEAD",
        revision,
      },
      workspace: { strategy: "tracked-export", disposable: true },
      task: { kind: "site-bootstrap", plan: reference },
      status: "succeeded",
      createdAt: "2026-09-09T00:00:00.000Z",
      startedAt: "2026-09-09T00:00:01.000Z",
      completedAt: "2026-09-09T00:00:02.000Z",
      durationMs: 1000,
      models: [],
      skills: [],
      usage,
      tools: toolUsage,
      artifacts: [{ role: "input", stepId: "apply-site-bootstrap", reference }],
      securityScan: {
        ruleSet: "credential-rules-v1",
        status: "passed",
        scannedFiles: 1,
        binaryFiles: 0,
        findings: [],
      },
      securityScanEffectiveDisposition: { status: "passed" },
      steps: [
        {
          id: "apply-site-bootstrap",
          title: "Apply approved site bootstrap",
          kind: "host-operation",
          operation: "site-bootstrap",
          skill: "template-scaffold-site",
          mode: "write",
          status: "succeeded",
          startedAt: "2026-09-09T00:00:01.000Z",
          completedAt: "2026-09-09T00:00:02.000Z",
          durationMs: 1000,
          usage,
          tools: toolUsage,
          artifacts: [{ role: "input", stepId: "apply-site-bootstrap", reference }],
          summary: "Applied approved site plan.",
          contextPreflight: {
            status: "ready",
            packetDigest: "c".repeat(64),
            consultedNodeIds: ["node-a"],
            ontologyVersion: "ontology-v1",
            effectiveDecisionIds: [],
            measurements: {
              byteLength: 1,
              estimatedTokens: 1,
              latencyMs: 1,
              nodeCount: 1,
              edgeCount: 0,
              pathCount: 1,
            },
            cache: { disposition: "miss", keyDigest: "d".repeat(64), rebuildAttempted: true },
          },
        },
      ],
      changes: {
        files: [{ path: "README.md", status: "modified" }],
        patch: {
          sha256: createHash("sha256").update(patchBytes).digest("hex"),
          byteLength: patchBytes.byteLength,
          lineCount: patchBytes.toString().trimEnd().split("\n").length,
          artifactPath,
          format: "git-diff",
        },
      },
    } as RunRecord;
    await writeFile(join(stateDirectory, "run-1.json"), JSON.stringify(record), { mode: 0o600 });
    const guard = createLiveAgentMutationGuard({ repositoryPath: fixture.repositoryPath });
    const delivery = new LiveWorkflowDelivery({
      repositoryPath: fixture.repositoryPath,
      stateDirectory,
      allowWrite: true,
      confirmPublication: async () => false,
      beforeMutation: () => guard.assertPrepared(),
    });
    expect(await delivery.persist(record)).toEqual({ status: "applied" });
    expect((await currentBranch(fixture.repositoryPath)).startsWith(TASK_BRANCH_PREFIX)).toBe(true);
    expect(await readFile(join(fixture.repositoryPath, "README.md"), "utf8")).toBe(
      "Updated documentation.\n",
    );
    expect(await git(fixture.repositoryPath, ["rev-parse", fixture.defaultRef])).toBe(
      fixture.defaultSha,
    );
  });

  it("reports mismatched session branches without switching or writing", async () => {
    const fixture = await repository({});
    await git(fixture.repositoryPath, ["switch", "-c", `${TASK_BRANCH_PREFIX}older`]);
    await writeFile(join(fixture.repositoryPath, "docs", "older.md"), "older\n");
    await git(fixture.repositoryPath, ["add", "docs/older.md"]);
    await git(fixture.repositoryPath, ["commit", "-qm", "Move task branch"]);
    await git(fixture.repositoryPath, ["switch", "main"]);
    const result = await prepareTaskBranch({
      repositoryPath: fixture.repositoryPath,
      session: { branchName: `${TASK_BRANCH_PREFIX}older` },
    });
    expect(result).toMatchObject({
      status: "mismatched",
      message: TASK_BRANCH_FAILURES.mismatched,
    });
    expect(await currentBranch(fixture.repositoryPath)).toBe("main");
  });

  it("keeps a unique topic branch even when a remembered session branch diverged", async () => {
    const fixture = await repository({});
    await git(fixture.repositoryPath, ["switch", "-c", `${TASK_BRANCH_PREFIX}older`]);
    await writeFile(join(fixture.repositoryPath, "docs", "older.md"), "older\n");
    await git(fixture.repositoryPath, ["add", "docs/older.md"]);
    await git(fixture.repositoryPath, ["commit", "-qm", "Diverge remembered branch"]);
    await git(fixture.repositoryPath, ["switch", "main"]);
    await git(fixture.repositoryPath, ["switch", "-c", "docs/other-topic"]);
    const result = await prepareTaskBranch({
      repositoryPath: fixture.repositoryPath,
      session: { branchName: `${TASK_BRANCH_PREFIX}older` },
    });
    expect(result).toMatchObject({ status: "succeeded", branchName: "docs/other-topic" });
    expect(await currentBranch(fixture.repositoryPath)).toBe("docs/other-topic");
  });

  it("creates a task branch from main without discarding dirty work", async () => {
    const fixture = await repository({});
    await writeFile(join(fixture.repositoryPath, "docs", "unstaged.md"), "unstaged\n");
    await git(fixture.repositoryPath, ["add", "docs/unstaged.md"]);
    await writeFile(join(fixture.repositoryPath, "docs", "unstaged.md"), "unstaged dirty\n");
    await writeFile(join(fixture.repositoryPath, "docs", "untracked.md"), "untracked\n");
    const guard = createLiveAgentMutationGuard({ repositoryPath: fixture.repositoryPath });
    const tools = await createConfinedToolSet({
      workspacePath: fixture.repositoryPath,
      allowWrite: true,
      beforeMutation: () => guard.assertPrepared(),
    });
    await call(tools, "write", { path: "docs/guide.md", content: "Dirty-tree edit.\n" });
    expect((await currentBranch(fixture.repositoryPath)).startsWith(TASK_BRANCH_PREFIX)).toBe(true);
    expect(await porcelain(fixture.repositoryPath)).toContain("docs/unstaged.md");
    expect(await porcelain(fixture.repositoryPath)).toContain("docs/untracked.md");
    expect(await readFile(join(fixture.repositoryPath, "docs", "unstaged.md"), "utf8")).toBe(
      "unstaged dirty\n",
    );
    expect(await git(fixture.repositoryPath, ["rev-parse", fixture.defaultRef])).toBe(
      fixture.defaultSha,
    );
  });

  it("does not reuse a remembered protected branch", async () => {
    const fixture = await repository({});
    const result = await prepareTaskBranch({
      repositoryPath: fixture.repositoryPath,
      session: { branchName: "main" },
      createBranchName: () => `${TASK_BRANCH_PREFIX}fresh-protected-test`,
    });
    expect(result.status).toBe("succeeded");
    expect(result.branchName).toBe(`${TASK_BRANCH_PREFIX}fresh-protected-test`);
    expect(await currentBranch(fixture.repositoryPath)).toBe(
      `${TASK_BRANCH_PREFIX}fresh-protected-test`,
    );
  });

  it("rejects persisted main and master state before branch reuse", async () => {
    for (const protectedBranch of ["main", "master"]) {
      const fixture = await repository({ branch: protectedBranch });
      const sessionDirectory = join(fixture.root, "sessions");
      await mkdir(join(sessionDirectory, "task-branches"), { recursive: true });
      await writeFile(
        join(sessionDirectory, "task-branches", `${canonicalDigest(fixture.repositoryPath)}.json`),
        JSON.stringify({
          kind: "docsfab-live-agent-task-branch",
          repositoryPath: fixture.repositoryPath,
          branchName: protectedBranch,
          defaultBranch: protectedBranch,
        }),
      );
      const result = await createLiveAgentMutationGuard({
        repositoryPath: fixture.repositoryPath,
        sessionDirectory,
        createBranchName: () => `${TASK_BRANCH_PREFIX}${protectedBranch}-fresh`,
      }).prepare();
      expect(result.status).toBe("succeeded");
      expect(result.branchName).toBe(`${TASK_BRANCH_PREFIX}${protectedBranch}-fresh`);
      expect(await currentBranch(fixture.repositoryPath)).not.toBe(protectedBranch);
    }
  });

  it("rejects a persisted old default after the resolved default changes", async () => {
    const oldDefault = `${TASK_BRANCH_PREFIX}old-default`;
    const newDefault = `${TASK_BRANCH_PREFIX}new-default`;
    const fixture = await repository({ branch: oldDefault, originDefault: oldDefault });
    await git(fixture.repositoryPath, ["branch", newDefault]);
    await git(fixture.repositoryPath, [
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      `refs/remotes/origin/${newDefault}`,
    ]);
    const sessionDirectory = join(fixture.root, "sessions");
    await mkdir(join(sessionDirectory, "task-branches"), { recursive: true });
    await writeFile(
      join(sessionDirectory, "task-branches", `${canonicalDigest(fixture.repositoryPath)}.json`),
      JSON.stringify({
        kind: "docsfab-live-agent-task-branch",
        repositoryPath: fixture.repositoryPath,
        branchName: oldDefault,
        defaultBranch: oldDefault,
      }),
    );
    const result = await createLiveAgentMutationGuard({
      repositoryPath: fixture.repositoryPath,
      sessionDirectory,
      createBranchName: () => `${TASK_BRANCH_PREFIX}after-default-change`,
    }).prepare();
    expect(result.status).toBe("succeeded");
    expect(result.branchName).toBe(`${TASK_BRANCH_PREFIX}after-default-change`);
    expect(await currentBranch(fixture.repositoryPath)).not.toBe(oldDefault);
    expect(await currentBranch(fixture.repositoryPath)).not.toBe(newDefault);
  });

  it("protects a configured default whose name is in the task namespace", async () => {
    const fixture = await repository({
      branch: `${TASK_BRANCH_PREFIX}default`,
      originDefault: `${TASK_BRANCH_PREFIX}default`,
    });
    const result = await prepareTaskBranch({
      repositoryPath: fixture.repositoryPath,
      createBranchName: () => `${TASK_BRANCH_PREFIX}generated`,
    });
    expect(result.status).toBe("succeeded");
    expect(result.branchName).toBe(`${TASK_BRANCH_PREFIX}generated`);
    expect(await git(fixture.repositoryPath, ["rev-parse", fixture.defaultRef])).toBe(
      fixture.defaultSha,
    );
  });

  it("adopts an existing task branch at HEAD and reuses it from a later guard", async () => {
    const fixture = await repository({});
    const kept = `${TASK_BRANCH_PREFIX}keep`;
    await git(fixture.repositoryPath, ["switch", "-c", kept]);
    await git(fixture.repositoryPath, ["switch", "main"]);
    const sessionDirectory = join(fixture.root, "sessions");
    const first = createLiveAgentMutationGuard({
      repositoryPath: fixture.repositoryPath,
      sessionDirectory,
    });
    expect(await first.assertPrepared()).toMatchObject({
      status: "succeeded",
      branchName: kept,
      reused: true,
    });
    expect(await currentBranch(fixture.repositoryPath)).toBe(kept);
    await git(fixture.repositoryPath, ["switch", "main"]);
    const second = createLiveAgentMutationGuard({
      repositoryPath: fixture.repositoryPath,
      sessionDirectory,
    });
    const tools = await createConfinedToolSet({
      workspacePath: fixture.repositoryPath,
      allowWrite: true,
      beforeMutation: () => second.assertPrepared(),
    });
    await call(tools, "write", { path: "docs/guide.md", content: "Session reuse.\n" });
    expect(await currentBranch(fixture.repositoryPath)).toBe(kept);
    expect(await readFile(join(fixture.repositoryPath, "docs", "guide.md"), "utf8")).toBe(
      "Session reuse.\n",
    );
    expect(await git(fixture.repositoryPath, ["rev-parse", fixture.defaultRef])).toBe(
      fixture.defaultSha,
    );
  });

  it("prepares a task branch when the checkout is on main and the default is not", async () => {
    const fixture = await repository({ branch: "develop", originDefault: "develop" });
    await git(fixture.repositoryPath, ["branch", "main"]);
    await git(fixture.repositoryPath, ["switch", "main"]);
    const guard = createLiveAgentMutationGuard({ repositoryPath: fixture.repositoryPath });
    const tools = await createConfinedToolSet({
      workspacePath: fixture.repositoryPath,
      allowWrite: true,
      beforeMutation: () => guard.assertPrepared(),
    });
    await call(tools, "write", { path: "docs/guide.md", content: "Main is protected.\n" });
    expect((await currentBranch(fixture.repositoryPath)).startsWith(TASK_BRANCH_PREFIX)).toBe(true);
    expect(await git(fixture.repositoryPath, ["rev-parse", "refs/heads/main"])).toBe(
      fixture.defaultSha,
    );
    expect(await git(fixture.repositoryPath, ["rev-parse", "refs/heads/develop"])).toBe(
      fixture.defaultSha,
    );
  });
});
