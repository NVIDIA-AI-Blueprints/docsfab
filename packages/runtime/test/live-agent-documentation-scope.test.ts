// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFile,
  link,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { DocsFabConfig } from "../src/config/runtime-loader.js";
import { createConfinedToolSet } from "../src/harness/confined-tools.js";
import { TASK_BRANCH_PREFIX } from "../src/live-agent/branch-preparation.js";
import {
  DOCUMENTATION_SANDBOX_FAILURE,
  documentationCommandSandbox,
  WORKTREE_CONFIG_PLACEHOLDER,
} from "../src/live-agent/command-sandbox.js";
import { limit, limitDefinition } from "../src/config/limits.js";
import { failureReason } from "../src/live-agent/activity-renderer.js";
import {
  COMMAND_PROCESS_STOP_LIMIT,
  commandProcessStopRefusal,
  createLiveCommandTool,
  LIVE_COMMAND_FAILURES,
} from "../src/live-agent/command-tool.js";
import {
  DocumentationScope,
  documentationLayoutNotice,
} from "../src/live-agent/documentation-scope.js";
import { assembleLiveAgentHost, narrowTaskDocumentationScope } from "../src/live-agent/host.js";
import { parseLiveAgentArguments } from "../src/cli/commands/live-agent.js";
import { temporaryRoots } from "./helpers/temp.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";
import { git, initFixtureRepo } from "./helpers/git.js";
import { installedLiveAgentCapabilities } from "./support/live-agent-installed-capabilities.js";

const roots = temporaryRoots();
async function fixture() {
  const root = await roots.create("docsfab-doc-scope-");
  await mkdir(join(root, "docs"));
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "app.js"), "original\n");
  return root;
}

describe("live-agent documentation-only write scope", () => {
  it("accepts documentation directories and explicit additions, not source or CI paths", () => {
    const scope = new DocumentationScope(["guides"]);
    for (const path of [
      "docs/guide.md",
      "fern/docs.yml",
      "packages/widget/docs/page.mdx",
      "documentation/image.png",
      "guides/start.rst",
      "README.md",
      "CHANGELOG.md",
      ".docsfab/reference-model/task.json",
    ])
      expect(scope.allows(path), path).toBe(true);
    for (const path of [
      "src/app.js",
      "package.json",
      ".gitlab-ci.yml",
      ".github/workflows/docs.yml",
      "docs/../src/app.js",
      "/docs/guide.md",
      "node_modules/docs/page.md",
      "guide.md",
    ])
      expect(scope.allows(path), path).toBe(false);
    expect(parseLiveAgentArguments(["--docs-dir", "guides", "--docs-dir", "help"])).toMatchObject({
      documentationDirectories: ["guides", "help"],
    });
    const trailingRoot = new DocumentationScope(["manual/"]);
    expect(trailingRoot.additionalDirectories).toEqual(["manual"]);
    expect(trailingRoot.allows("manual/guide.md")).toBe(true);
    expect(trailingRoot.allows("manuals/guide.md")).toBe(false);
    for (const path of [
      ".",
      "..",
      "/",
      ".git",
      ".github/workflows",
      ".private",
      "manual/.private",
      "manual//",
      "src/",
      "ci/",
    ])
      expect(() => new DocumentationScope([path])).toThrow();
  });

  it("blocks direct writes to source and linked paths while allowing new documentation", async () => {
    const root = await fixture();
    const scope = new DocumentationScope();
    const files = await createConfinedToolSet({
      workspacePath: root,
      allowWrite: true,
      isWritePathAllowed: (path) => scope.allows(path),
    });
    const write = files.definitions.find((tool) => tool.name === "write")!;
    const invoke = (path: string) =>
      write.execute("write", { path, content: "updated\n" }, undefined, undefined, {} as never);
    await invoke("docs/new/page.md");
    await invoke("README.md");
    await expect(invoke("src/app.js")).rejects.toThrow();
    await symlink(join(root, "src", "app.js"), join(root, "docs", "linked.md"));
    await expect(invoke("docs/linked.md")).rejects.toThrow();
    await link(join(root, "src", "app.js"), join(root, "docs", "hardlinked.md"));
    await expect(invoke("docs/hardlinked.md")).rejects.toThrow();
    expect(await readFile(join(root, "src", "app.js"), "utf8")).toBe("original\n");
    expect(await readFile(join(root, "docs", "new", "page.md"), "utf8")).toBe("updated\n");
  });

  it("enforces the same boundary for approved shell commands and subprocesses", async () => {
    const root = await fixture();
    await symlink(join(root, "src", "app.js"), join(root, "docs", "linked.md"));
    const tool = createLiveCommandTool({
      repositoryPath: root,
      allowWrite: true,
      confirm: async () => true,
    });
    const invoke = (command: string) =>
      tool.execute("bash", { command }, undefined, undefined, {} as never);
    expect((await invoke("printf 'docs' > docs/new.md")).details).toMatchObject({
      status: "succeeded",
    });
    for (const command of [
      "printf 'bad' > src/app.js",
      "printf 'bad' > docs/linked.md",
      "rm src/app.js",
      "mkdir src/new",
      "/bin/bash -c 'echo bad > src/app.js'",
      "ln src/app.js docs/new-link.md",
    ]) {
      expect((await invoke(command)).details, command).toMatchObject({ status: "failed" });
    }
    expect(await readFile(join(root, "src", "app.js"), "utf8")).toBe("original\n");
    expect(await readFile(join(root, "docs", "new.md"), "utf8")).toBe("docs");
  });
});

// Each case assembles the live host and runs Git and sandboxed commands.
const HOST_CASE_MS = testTimeoutMs(30_000);
const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DENIED = "DocsFab denied the requested tool path.";
type Tool = { name: string; execute: (...arguments_: any[]) => Promise<any> };

async function selectWritingSkill(host: Awaited<ReturnType<typeof assembleLiveAgentHost>>) {
  host.terminalOptions.onUserTurn?.("Update the documentation in this checkout.");
  const skill = host.customTools.find((tool) => tool.name === "docsfab_use_skill");
  if (!skill) throw new Error("Missing installed documentation skill tool.");
  await skill.execute("skill", { skill: "write-documentation" }, undefined, undefined, {} as never);
}

/** The write-enabled live host exactly as `runLiveAgent` assembles it for one checkout. */
async function writeEnabledHost(repositoryPath: string, stateRoot: string) {
  const confirm = vi.fn(async () => true);
  const host = await assembleLiveAgentHost({
    repositoryPath,
    allowWrite: true,
    environment: { PATH: process.env.PATH },
    config: {
      projectRoot: runtimeRoot,
      stateDirectory: join(stateRoot, "state"),
      model: { provider: "none", model: "none" },
    } as unknown as DocsFabConfig,
    capabilities: await installedLiveAgentCapabilities(["update-documentation"]),
    sourcePorts: {} as never,
    onNotice: () => undefined,
    writeError: () => undefined,
    runWorkflow: vi.fn() as never,
  });
  host.terminalOptions.setPublicationConfirmation?.(confirm);
  const tools = host.customTools as unknown as Tool[];
  const find = (name: string) => {
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`Missing tool ${name}`);
    return tool;
  };
  await selectWritingSkill(host);
  return {
    confirm,
    write: (path: string, content: string) =>
      find("write").execute("write", { path, content }, undefined, undefined, {} as never),
    edit: (path: string, oldText: string, newText: string) =>
      find("edit").execute(
        "edit",
        { path, edits: [{ oldText, newText }] },
        undefined,
        undefined,
        {} as never,
      ),
    bash: (command: string) =>
      find("bash").execute("bash", { command, timeout: 60 }, undefined, undefined, {} as never),
  };
}

/** Byte-exact view of the operator's own work, excluding the path the agent edits. */
async function userWork(repositoryPath: string, edited: string) {
  const status = (await git(repositoryPath, ["status", "--porcelain=v1", "-z"], { trim: false }))
    .split("\0")
    .filter((entry) => entry !== "" && entry.slice(3) !== edited);
  const staged = await git(repositoryPath, ["diff", "--cached", "--binary"], { trim: false });
  const blobs: Record<string, string> = {};
  for (const path of ["docs/staged.md", "docs/added.md", "src/staged.js"])
    blobs[path] = await git(repositoryPath, ["show", `:${path}`], { trim: false });
  const files: Record<string, string> = {};
  for (const path of [
    "docs/staged.md",
    "docs/added.md",
    "docs/unstaged.md",
    "src/staged.js",
    "src/unstaged.js",
    "notes/untracked.txt",
    "docs/untracked.md",
  ])
    files[path] = await readFile(join(repositoryPath, path), "utf8");
  return { status, staged, blobs, files };
}

/** `main` with staged-only (`M `), added-then-modified (`AM`), unstaged (` M`), and untracked (`??`) work. */
async function dirtyMain(): Promise<{ root: string; repositoryPath: string; mainSha: string }> {
  const root = await roots.create("docsfab-doc-preserve-");
  const repositoryPath = join(root, "repo");
  const mainSha = await initFixtureRepo(
    repositoryPath,
    {
      "docs/guide.md": "Guide original.\n",
      "docs/staged.md": "staged base\n",
      "docs/unstaged.md": "unstaged base\n",
      "src/staged.js": "export const staged = 0;\n",
      "src/unstaged.js": "export const unstaged = 0;\n",
    },
    { branch: "main", message: "Fixture base" },
  );
  // Production code runs Git with the ambient environment; keep host hooks out.
  await git(repositoryPath, ["config", "core.hooksPath", "/dev/null"]);
  await writeFile(join(repositoryPath, "docs", "staged.md"), "staged edit\n");
  await writeFile(join(repositoryPath, "src", "staged.js"), "export const staged = 1;\n");
  await git(repositoryPath, ["add", "docs/staged.md", "src/staged.js"]);
  await writeFile(join(repositoryPath, "docs", "added.md"), "added staged\n");
  await git(repositoryPath, ["add", "docs/added.md"]);
  await writeFile(join(repositoryPath, "docs", "added.md"), "added staged then modified\n");
  await writeFile(join(repositoryPath, "docs", "unstaged.md"), "unstaged edit\n");
  await writeFile(join(repositoryPath, "src", "unstaged.js"), "export const unstaged = 1;\n");
  await mkdir(join(repositoryPath, "notes"));
  await writeFile(join(repositoryPath, "notes", "untracked.txt"), "untracked note\n");
  await writeFile(join(repositoryPath, "docs", "untracked.md"), "untracked doc\n");
  const codes = (await git(repositoryPath, ["status", "--porcelain=v1"])).split("\n");
  expect(codes).toEqual(
    expect.arrayContaining([
      "M  docs/staged.md",
      "AM docs/added.md",
      " M docs/unstaged.md",
      "?? notes/",
      "?? docs/untracked.md",
    ]),
  );
  return { root, repositoryPath, mainSha };
}

describe("live-agent writes preserve the operator's own work", { timeout: HOST_CASE_MS }, () => {
  it.each(["write", "edit", "bash"] as const)(
    "keeps staged, unstaged, and untracked work byte-exact through the branch guard on main (%s)",
    async (kind) => {
      const fixture = await dirtyMain();
      const before = await userWork(fixture.repositoryPath, "docs/guide.md");
      const live = await writeEnabledHost(fixture.repositoryPath, fixture.root);
      if (kind === "write") await live.write("docs/guide.md", "Guide agent.\n");
      else if (kind === "edit") await live.edit("docs/guide.md", "Guide original.", "Guide agent.");
      else
        expect((await live.bash("printf 'Guide agent.\\n' > docs/guide.md")).details).toMatchObject(
          { status: "succeeded", exitCode: 0 },
        );
      expect(await readFile(join(fixture.repositoryPath, "docs", "guide.md"), "utf8")).toBe(
        "Guide agent.\n",
      );
      // The branch guard moved the work off main without committing, stashing, or resetting it.
      expect(
        (await git(fixture.repositoryPath, ["branch", "--show-current"])).startsWith(
          TASK_BRANCH_PREFIX,
        ),
      ).toBe(true);
      expect(await git(fixture.repositoryPath, ["rev-parse", "refs/heads/main"])).toBe(
        fixture.mainSha,
      );
      expect(await git(fixture.repositoryPath, ["rev-parse", "HEAD"])).toBe(fixture.mainSha);
      expect(await git(fixture.repositoryPath, ["stash", "list"])).toBe("");
      const after = await userWork(fixture.repositoryPath, "docs/guide.md");
      expect(after.status).toEqual(before.status);
      expect(after.staged).toBe(before.staged);
      expect(after.blobs).toEqual(before.blobs);
      expect(after.files).toEqual(before.files);
      expect(live.confirm).toHaveBeenCalledTimes(kind === "bash" ? 1 : 0);
    },
  );
});

/** Main checkout A and linked worktree B sharing A's Git metadata. */
async function linkedWorktrees() {
  const root = await roots.create("docsfab-doc-worktrees-");
  const a = join(root, "A");
  await initFixtureRepo(
    a,
    { "docs/guide.md": "A guide.\n", "src/app.js": "A source\n" },
    { branch: "main", message: "Fixture base" },
  );
  await git(a, ["config", "core.hooksPath", "/dev/null"]);
  const b = join(root, "B");
  await git(a, ["worktree", "add", "-q", "-b", "topic", b]);
  const canonicalA = await realpath(a);
  return { root, a: canonicalA, b: await realpath(b) };
}

const SANDBOX_DENIED = /Operation not permitted|Read-only file system/u;
/** Paths a profile makes writable: SBPL `subpath` allows, or bwrap binds of Git paths. */
function writableGrants(
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (platform === "darwin")
    return [...args.join("\n").matchAll(/\(subpath ("(?:[^"\\]|\\.)*")\)/gu)].map(
      (match) => JSON.parse(match[1]!) as string,
    );
  return args.flatMap((arg, index) =>
    arg === "--bind" || arg === "--bind-try" ? [args[index + 1]!] : [],
  );
}

describe("sandbox writable grant extraction", () => {
  it("includes bwrap writable and writable-if-present binds, not read-only binds", () => {
    expect(
      writableGrants(
        [
          "--bind",
          "/repo/docs",
          "/repo/docs",
          "--bind-try",
          "/repo/.git/refs",
          "/repo/.git/refs",
          "--ro-bind",
          "/repo/.git/HEAD",
          "/repo/.git/HEAD",
        ],
        "linux",
      ),
    ).toEqual(["/repo/docs", "/repo/.git/refs"]);
  });
});
const outputOf = (result: { content: { text: string }[] }) => result.content[0]!.text;
const bytesOrAbsent = (path: string) =>
  readFile(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "absent";
    throw error;
  });

async function bytesOfA(a: string) {
  return {
    guide: await readFile(join(a, "docs", "guide.md"), "utf8"),
    source: await readFile(join(a, "src", "app.js"), "utf8"),
    status: await git(a, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
      trim: false,
    }),
  };
}

describe("live-agent linked worktrees", { timeout: HOST_CASE_MS }, () => {
  it("refuses file-tool writes from a linked worktree into the main checkout", async () => {
    const { root, a, b } = await linkedWorktrees();
    await symlink(join(a, "docs"), join(b, "docs", "into-a"));
    const before = await bytesOfA(a);
    const live = await writeEnabledHost(b, root);
    for (const path of [
      "../A/docs/x.md",
      join(a, "docs", "x.md"),
      "docs/into-a/x.md",
      "../A/src/app.js",
    ])
      await expect(live.write(path, "escaped\n"), path).rejects.toThrow(DENIED);
    for (const path of ["../A/docs/guide.md", join(a, "docs", "guide.md"), "docs/into-a/guide.md"])
      await expect(live.edit(path, "A guide.", "escaped"), path).rejects.toThrow(DENIED);
    await expect(stat(join(a, "docs", "x.md"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await bytesOfA(a)).toEqual(before);
    // Positive control: the same tool writes B's own documentation.
    await live.write("docs/x.md", "B page\n");
    expect(await readFile(join(b, "docs", "x.md"), "utf8")).toBe("B page\n");
  });

  it("confines approved commands in a linked worktree to its documentation and shared Git metadata", async () => {
    const { root, a, b } = await linkedWorktrees();
    const before = await bytesOfA(a);
    const live = await writeEnabledHost(b, root);
    for (const target of [
      join(a, "docs", "x.md"),
      join(a, "src", "app.js"),
      join(a, "docs", "guide.md"),
    ]) {
      const result = await live.bash(`printf x > ${JSON.stringify(target)}`);
      expect(result.details, target).toMatchObject({ status: "failed" });
    }
    await expect(stat(join(a, "docs", "x.md"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await bytesOfA(a)).toEqual(before);

    // Benign Git work from B needs the shared objects, refs, and its own admin directory.
    // Some Git versions print an `Unable to create '.../packed-refs.lock'` error on this
    // commit and still exit 0; the matrix accepts that stderr and asserts only the outcome.
    await live.write("docs/guide.md", "B guide.\n");
    for (const command of [
      "git status --short",
      "git worktree list",
      "git commit --only -q -m 'docs: B guide' -- docs/guide.md",
    ])
      expect((await live.bash(command)).details, command).toMatchObject({
        status: "succeeded",
        exitCode: 0,
      });
    expect(await git(b, ["show", "topic:docs/guide.md"], { trim: false })).toBe("B guide.\n");
    expect(await git(a, ["show", "main:docs/guide.md"], { trim: false })).toBe("A guide.\n");
    expect(await bytesOfA(a)).toEqual(before);
  });

  it("refuses a linked worktree's approved commands on the main checkout's own Git state", async () => {
    const { root, a, b } = await linkedWorktrees();
    const common = join(a, ".git");
    // The refusal must come from the sandbox, not from a missing directory.
    await mkdir(join(common, "hooks"), { recursive: true });
    const live = await writeEnabledHost(b, root);
    // Each probe writes bytes that differ from the target's current state.
    for (const [target, write] of [
      [join(common, "HEAD"), `printf 'ref: refs/heads/pinned-probe\\n' >`],
      [join(common, "index.probe"), "printf probe >"],
      [join(common, "index"), "printf probe >>"],
      [join(common, "logs", "HEAD"), "printf probe >>"],
      [join(common, "config"), `printf '[core]\\n\\tfsmonitor = probe\\n' >>`],
      [join(common, "hooks", "post-checkout"), `printf '#!/bin/sh\\n' >`],
    ] as const) {
      const before = await bytesOrAbsent(target);
      const result = await live.bash(`${write} ${JSON.stringify(target)}`);
      expect(result.details, target).toMatchObject({ status: "failed" });
      expect(outputOf(result), target).toMatch(SANDBOX_DENIED);
      expect(await bytesOrAbsent(target), target).toEqual(before);
    }
    // Checkout files outside documentation stay read-only in the same command class.
    expect(await readFile(join(a, "src", "app.js"), "utf8")).toBe("A source\n");
  });

  it("refuses ref deletion and upstream recording from a linked worktree", async () => {
    const { root, a, b } = await linkedWorktrees();
    const remote = join(root, "remote.git");
    await git(root, ["init", "-q", "--bare", remote]);
    await git(a, ["remote", "add", "origin", remote]);
    await git(a, ["branch", "stale"]);
    await git(a, ["push", "-q", "origin", "main", "stale"]);
    await git(a, ["fetch", "-q", "origin"]);
    await git(remote, ["branch", "-D", "stale"]);
    await git(a, ["branch", "packed-probe"]);
    await git(a, ["pack-refs", "--all"]);
    const live = await writeEnabledHost(b, root);
    // Git deletes a ref through `packed-refs.lock` in the shared root, which stays read-only.
    for (const [command, ref] of [
      ["git branch -D packed-probe", "refs/heads/packed-probe"],
      ["git fetch --prune origin", "refs/remotes/origin/stale"],
    ] as const) {
      const result = await live.bash(command);
      expect(result.details, command).toMatchObject({ status: "failed", exitCode: 1 });
      expect(outputOf(result), command).toMatch(/packed-refs\.lock/u);
      expect(outputOf(result), command).toMatch(SANDBOX_DENIED);
      await expect(git(a, ["rev-parse", "--verify", "-q", ref]), ref).resolves.toMatch(
        /^[0-9a-f]+$/u,
      );
    }
    // Upstream tracking lives in the shared `config`, which stays read-only.
    const upstream = await live.bash("git branch --set-upstream-to=origin/main");
    expect(upstream.details).toMatchObject({ status: "failed", exitCode: 1 });
    expect(outputOf(upstream)).toMatch(/could not lock config file/u);
    // `push -u` still pushes and exits 0, but records no upstream.
    const push = await live.bash(
      'git init -q --bare "$TMPDIR/upstream.git" && git push -q -u "$TMPDIR/upstream.git" topic',
    );
    expect(push.details).toMatchObject({ status: "succeeded", exitCode: 0 });
    expect(outputOf(push)).toMatch(/could not lock config file/u);
    await expect(git(b, ["config", "--get", "branch.topic.merge"])).rejects.toMatchObject({
      code: 1,
    });
  });

  it("still lets a linked worktree write its own admin directory and move shared refs", async () => {
    const { root, a, b } = await linkedWorktrees();
    const common = join(a, ".git");
    const live = await writeEnabledHost(b, root);
    const own = await live.bash(
      `printf probe > ${JSON.stringify(join(common, "worktrees", "B", "probe"))}`,
    );
    expect(own.details).toMatchObject({ status: "succeeded", exitCode: 0 });
    expect(await readFile(join(common, "worktrees", "B", "probe"), "utf8")).toBe("probe");
    // Inherent residue: refs are shared, so B can move the branch A has checked out.
    // A's HEAD then resolves to B's commit and A shows the difference as staged.
    await live.write("docs/guide.md", "B guide.\n");
    for (const command of [
      "git commit --only -q -m 'docs: B guide' -- docs/guide.md",
      "git update-ref refs/heads/main HEAD",
    ])
      expect((await live.bash(command)).details, command).toMatchObject({
        status: "succeeded",
        exitCode: 0,
      });
    expect(await git(a, ["rev-parse", "main"])).toBe(await git(b, ["rev-parse", "HEAD"]));
    expect(await git(a, ["status", "--porcelain=v1"])).toBe("M  docs/guide.md");
  });

  it("grants no Git metadata to a linked worktree whose gitfile points outside the common worktrees directory", async () => {
    const { root, a, b } = await linkedWorktrees();
    const common = join(a, ".git");
    const outside = join(await realpath(root), "outside-admin");
    await rename(join(common, "worktrees", "B"), outside);
    await writeFile(join(outside, "commondir"), `${common}\n`);
    await writeFile(join(b, ".git"), `gitdir: ${outside}\n`);
    expect(await git(b, ["rev-parse", "--path-format=absolute", "--git-dir"])).toBe(outside);
    const live = await writeEnabledHost(b, root);
    const probe = join(outside, "probe");
    const refused = await live.bash(`printf probe > ${JSON.stringify(probe)}`);
    expect(refused.details).toMatchObject({ status: "failed" });
    expect(outputOf(refused)).toMatch(SANDBOX_DENIED);
    await expect(stat(probe)).rejects.toMatchObject({ code: "ENOENT" });
    // The shared refs grant fails closed too: `commondir` is unverified here.
    const ref = await live.bash("git update-ref refs/heads/outside-probe HEAD");
    expect(ref.details).toMatchObject({ status: "failed" });
    expect(outputOf(ref)).toMatch(SANDBOX_DENIED);
    await expect(git(a, ["rev-parse", "--verify", "-q", "outside-probe"])).rejects.toMatchObject({
      code: 1,
    });
    // Positive control: the sandbox still runs and B's documentation stays writable.
    expect((await live.bash("printf 'B page\\n' > docs/x.md")).details).toMatchObject({
      status: "succeeded",
      exitCode: 0,
    });
    expect(await readFile(join(b, "docs", "x.md"), "utf8")).toBe("B page\n");
  });

  it("grants no Git metadata to the next command after a process outside the sandbox rewrites commondir", async () => {
    const { root, a, b } = await linkedWorktrees();
    const common = join(a, ".git");
    const other = join(root, "C");
    await initFixtureRepo(other, { "docs/c.md": "C.\n" }, { branch: "main", message: "C base" });
    // C has B's branch name, so B's HEAD still resolves and branch preparation passes after the rewrite.
    await git(other, ["branch", "topic"]);
    const otherGit = join(await realpath(other), ".git");
    const live = await writeEnabledHost(b, root);
    // Adjacent condition: before the rewrite, the shared refs are writable.
    expect(
      (await live.bash("git update-ref refs/heads/before-rewrite HEAD")).details,
    ).toMatchObject({ status: "succeeded", exitCode: 0 });
    expect(await git(a, ["rev-parse", "before-rewrite"])).toBe(await git(b, ["rev-parse", "HEAD"]));
    // Approved commands cannot write `commondir`; a process outside the sandbox, such as a
    // main-checkout command, still can.
    await writeFile(join(common, "worktrees", "B", "commondir"), `${otherGit}\n`);
    expect(await git(b, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).toBe(
      otherGit,
    );
    // The next command must not inherit a grant on the attacker-selected directory.
    for (const target of [
      join(otherGit, "refs", "heads", "probe"),
      join(otherGit, "objects", "probe"),
      join(otherGit, "logs", "refs", "probe"),
      join(common, "worktrees", "B", "probe"),
      join(common, "refs", "heads", "probe"),
    ]) {
      const result = await live.bash(`printf probe > ${JSON.stringify(target)}`);
      expect(result.details, target).toMatchObject({ status: "failed" });
      expect(outputOf(result), target).toMatch(SANDBOX_DENIED);
      await expect(stat(target), target).rejects.toMatchObject({ code: "ENOENT" });
    }
    // Positive control: the sandbox still runs and B's documentation stays writable.
    expect((await live.bash("printf 'B page\\n' > docs/x.md")).details).toMatchObject({
      status: "succeeded",
      exitCode: 0,
    });
    expect(await readFile(join(b, "docs", "x.md"), "utf8")).toBe("B page\n");
  });

  it("does not follow a symlinked shared Git path out of the common directory", async () => {
    const { root, a, b } = await linkedWorktrees();
    const common = join(a, ".git");
    const reflogs = join(common, "logs", "refs");
    const granted = async () => {
      const sandbox = await documentationCommandSandbox(b, new DocumentationScope());
      await sandbox.restoreGitState();
      await sandbox.cleanup();
      return writableGrants(sandbox.args);
    };
    // Adjacent condition: real shared directories and the admin directory are granted.
    const admin = join(common, "worktrees", "B");
    for (const path of [join(common, "objects"), join(common, "refs"), reflogs, admin])
      expect(await granted(), path).toContain(path);
    const elsewhere = join(await realpath(root), "elsewhere");
    const live = await writeEnabledHost(b, root);
    // A command cannot swap a granted path for a symlink: the path's parent is read-only.
    const swap = await live.bash(
      `mv ${JSON.stringify(reflogs)} ${JSON.stringify(`${reflogs}.old`)} && ln -s ${JSON.stringify(elsewhere)} ${JSON.stringify(reflogs)}`,
    );
    expect(swap.details).toMatchObject({ status: "failed" });
    expect(outputOf(swap)).toMatch(SANDBOX_DENIED);
    expect((await lstat(reflogs)).isDirectory()).toBe(true);
    // A symlink created inside a granted path does not make its target writable.
    await mkdir(elsewhere);
    const inner = join(common, "refs", "heads", "inner");
    const through = await live.bash(
      `ln -s ${JSON.stringify(elsewhere)} ${JSON.stringify(inner)} && printf probe > ${JSON.stringify(join(inner, "probe"))}`,
    );
    expect(through.details).toMatchObject({ status: "failed" });
    expect(outputOf(through)).toMatch(SANDBOX_DENIED);
    await expect(stat(join(elsewhere, "probe"))).rejects.toMatchObject({ code: "ENOENT" });
    await rm(inner);
    await rm(elsewhere, { recursive: true });
    // A process outside the sandbox swaps the path; the next command's grant refuses it.
    await rename(reflogs, elsewhere);
    await symlink(elsewhere, reflogs);
    const args = await granted();
    expect(args).not.toContain(reflogs);
    expect(args).not.toContain(elsewhere);
    expect(args).toContain(join(common, "refs"));
    const result = await live.bash(`printf probe > ${JSON.stringify(join(reflogs, "probe"))}`);
    expect(result.details).toMatchObject({ status: "failed" });
    expect(outputOf(result)).toMatch(SANDBOX_DENIED);
    await expect(stat(join(elsewhere, "probe"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("grants no missing shared Git path and still moves refs when reflogs are off", async () => {
    const { root, a, b } = await linkedWorktrees();
    const common = join(a, ".git");
    const reflogs = join(common, "logs", "refs");
    await rm(reflogs, { recursive: true });
    const sandbox = await documentationCommandSandbox(b, new DocumentationScope());
    await sandbox.restoreGitState();
    await sandbox.cleanup();
    const args = writableGrants(sandbox.args);
    expect(args).not.toContain(reflogs);
    for (const path of [
      join(common, "objects"),
      join(common, "refs"),
      join(common, "worktrees", "B"),
    ])
      expect(args, path).toContain(path);
    const live = await writeEnabledHost(b, root);
    // Reflogs on: Git must create `logs/refs`, which stays read-only on every platform.
    const refused = await live.bash("git update-ref refs/heads/reflog-probe HEAD");
    expect(refused.details).toMatchObject({ status: "failed", exitCode: 128 });
    expect(outputOf(refused)).toMatch(
      /unable to create directory for .*logs\/refs\/heads\/reflog-probe/u,
    );
    await expect(stat(reflogs)).rejects.toMatchObject({ code: "ENOENT" });
    // Positive control: with reflogs off, Git needs no `logs/refs` and ref updates succeed.
    await git(a, ["config", "core.logAllRefUpdates", "false"]);
    await live.write("docs/guide.md", "B guide.\n");
    for (const command of [
      "git commit --only -q -m 'docs: B guide' -- docs/guide.md",
      "git update-ref refs/heads/no-reflog HEAD",
    ])
      expect((await live.bash(command)).details, command).toMatchObject({
        status: "succeeded",
        exitCode: 0,
      });
    expect(await git(a, ["rev-parse", "no-reflog"])).toBe(await git(b, ["rev-parse", "HEAD"]));
    expect(await git(b, ["show", "topic:docs/guide.md"], { trim: false })).toBe("B guide.\n");
  });

  it("keeps the main checkout's whole Git directory writable, including other worktrees' admin directories", async () => {
    // Adjacent case: the main checkout still receives the whole directory.
    const { root, a } = await linkedWorktrees();
    const live = await writeEnabledHost(a, root);
    await live.write("docs/guide.md", "A agent.\n");
    const probe = join(a, ".git", "worktrees", "B", "probe");
    for (const command of [
      "git commit --only -q -m 'docs: A agent' -- docs/guide.md",
      `printf probe > ${JSON.stringify(probe)}`,
    ])
      expect((await live.bash(command)).details, command).toMatchObject({
        status: "succeeded",
        exitCode: 0,
      });
    expect(await git(a, ["show", "HEAD:docs/guide.md"], { trim: false })).toBe("A agent.\n");
    expect(await readFile(probe, "utf8")).toBe("probe");
  });
});

const POLL_MS = 20;
// Linux reports a rename over, or unlink of, a read-only mount point as busy.
const POINTER_DENIED = /Operation not permitted|Read-only file system|Device or resource busy/u;
const PLANTED = "[docsfab]\n\tprobe = planted\n";
const POINTER_FILES = ["commondir", "gitdir", "config.worktree"] as const;

/** Linked worktree B with `extensions.worktreeConfig` on, as in the owner's own checkout. */
async function worktreeConfigFixture(options: { legitimate: boolean }) {
  const fixture = await linkedWorktrees();
  const common = join(fixture.a, ".git");
  const admin = join(common, "worktrees", "B");
  await git(fixture.a, ["config", "extensions.worktreeConfig", "true"]);
  if (options.legitimate) await git(fixture.b, ["config", "--worktree", "docsfab.legit", "kept"]);
  // A repository whose shared config sets the probe key, as a commondir redirect target.
  const other = join(fixture.root, "C");
  await initFixtureRepo(other, { "docs/c.md": "C.\n" }, { branch: "main", message: "C base" });
  await git(other, ["branch", "topic"]);
  await git(other, ["config", "docsfab.probe", "redirected"]);
  return { ...fixture, common, admin, otherGit: join(await realpath(other), ".git") };
}

/** Host-side Git's view of a key from B; `absent` when Git reports it unset. */
const probeFrom = (b: string, key = "docsfab.probe") =>
  git(b, ["config", "--get", key]).catch((error: { code?: number }) => {
    if (error.code === 1) return "absent";
    throw error;
  });

const pointerState = (admin: string) =>
  Promise.all(POINTER_FILES.map((name) => bytesOrAbsent(join(admin, name))));

/**
 * Starts `run`, waits until its command creates `started`, then runs `outside` in this
 * unsandboxed test process. Polling never blocks a thread, so a command that fails before it
 * starts surfaces its own error instead of a hang.
 */
async function whileRunning<T>(
  started: string,
  run: () => Promise<T>,
  outside: () => Promise<unknown>,
) {
  let settled = false;
  const result = run();
  const settle = () => {
    settled = true;
  };
  void result.then(settle, settle);
  await vi.waitFor(
    async () => {
      if (!settled) await stat(started);
    },
    { timeout: HOST_CASE_MS, interval: POLL_MS },
  );
  if (!settled) await outside();
  return await result;
}

/**
 * Runs an approved command while a process outside the sandbox changes Git state, standing in
 * for any write the sandbox profile does not stop. The command waits in B's documentation until
 * the outside write finishes, so the change lands during the command.
 */
async function outsideWriteDuring(
  live: Awaited<ReturnType<typeof writeEnabledHost>>,
  b: string,
  mutate: () => Promise<unknown>,
) {
  const started = join(b, "docs", "started");
  const proceed = join(b, "docs", "proceed");
  try {
    return await whileRunning(
      started,
      () => live.bash("touch docs/started && until [ -e docs/proceed ]; do sleep 0.05; done"),
      async () => {
        await mutate();
        await writeFile(proceed, "");
      },
    );
  } finally {
    await rm(started, { force: true });
    await rm(proceed, { force: true });
  }
}

describe("live-agent linked worktree Git pointer files", { timeout: HOST_CASE_MS }, () => {
  it("refuses an approved command that plants per-worktree Git configuration", async () => {
    const { root, b, admin } = await worktreeConfigFixture({ legitimate: true });
    const configWorktree = join(admin, "config.worktree");
    const before = await readFile(configWorktree);
    const live = await writeEnabledHost(b, root);
    for (const command of [
      `printf '[docsfab]\\n\\tprobe = planted\\n' >> ${JSON.stringify(configWorktree)}`,
      "git config --worktree docsfab.probe planted",
    ]) {
      const result = await live.bash(command);
      expect(result.details, command).toMatchObject({ status: "failed" });
      expect(outputOf(result), command).toMatch(POINTER_DENIED);
      expect(await readFile(configWorktree), command).toEqual(before);
      expect(await probeFrom(b), command).toBe("absent");
    }
    expect(await probeFrom(b, "docsfab.legit")).toBe("kept");
  });

  it("refuses an approved command that creates config.worktree", async () => {
    const { root, b, admin } = await worktreeConfigFixture({ legitimate: false });
    const configWorktree = join(admin, "config.worktree");
    const live = await writeEnabledHost(b, root);
    for (const command of [
      `printf '[docsfab]\\n\\tprobe = planted\\n' > ${JSON.stringify(configWorktree)}`,
      `printf '[docsfab]\\n\\tprobe = planted\\n' > "$TMPDIR/cw" && mv "$TMPDIR/cw" ${JSON.stringify(configWorktree)}`,
    ]) {
      const result = await live.bash(command);
      expect(result.details, command).toMatchObject({ status: "failed" });
      expect(outputOf(result), command).toMatch(POINTER_DENIED);
      await expect(lstat(configWorktree), command).rejects.toMatchObject({ code: "ENOENT" });
      expect(await probeFrom(b), command).toBe("absent");
    }
    // Positive control: a command that leaves the file alone succeeds and leaves it absent.
    expect((await live.bash("git status --short")).details).toMatchObject({
      status: "succeeded",
      exitCode: 0,
    });
    await expect(lstat(configWorktree)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses an approved command that redirects commondir or rewrites a worktree pointer", async () => {
    const { root, a, b, common, admin, otherGit } = await worktreeConfigFixture({
      legitimate: false,
    });
    const commondir = join(admin, "commondir");
    const gitdir = join(admin, "gitdir");
    const before = await pointerState(admin);
    const gitfile = await readFile(join(b, ".git"));
    const live = await writeEnabledHost(b, root);
    const staged = `${commondir}.new`;
    for (const command of [
      `printf '%s\\n' ${JSON.stringify(otherGit)} > ${JSON.stringify(commondir)}`,
      `printf '%s\\n' ${JSON.stringify(otherGit)} > ${JSON.stringify(staged)} && mv ${JSON.stringify(staged)} ${JSON.stringify(commondir)}`,
      `rm ${JSON.stringify(commondir)}`,
      `printf '/elsewhere/.git\\n' > ${JSON.stringify(gitdir)}`,
      // The checkout root is never writable, so the gitfile needs no restore.
      `printf 'gitdir: %s\\n' ${JSON.stringify(otherGit)} > .git`,
    ]) {
      const result = await live.bash(command);
      expect(result.details, command).toMatchObject({ status: "failed" });
      expect(outputOf(result), command).toMatch(POINTER_DENIED);
    }
    await rm(staged, { force: true });
    expect(await pointerState(admin)).toEqual(before);
    expect(await readFile(join(b, ".git"))).toEqual(gitfile);
    expect(await git(b, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).toBe(common);
    expect(await probeFrom(b)).toBe("absent");
    expect(await git(a, ["worktree", "list", "--porcelain"])).toContain(`worktree ${b}\n`);
  });

  it.each([
    {
      name: "plants a setting in an existing config.worktree",
      legitimate: true,
      failure: "gitConfigWorktree",
      mutate: (admin: string) => appendFile(join(admin, "config.worktree"), PLANTED),
    },
    {
      name: "creates config.worktree",
      legitimate: false,
      failure: "gitConfigWorktree",
      mutate: (admin: string) => writeFile(join(admin, "config.worktree"), PLANTED),
    },
    {
      name: "redirects commondir",
      legitimate: true,
      failure: "gitCommondir",
      mutate: (admin: string, otherGit: string) =>
        writeFile(join(admin, "commondir"), `${otherGit}\n`),
    },
    {
      name: "deletes commondir so the admin directory becomes its own repository",
      legitimate: true,
      failure: "gitCommondir",
      mutate: async (admin: string) => {
        await rm(join(admin, "commondir"));
        await mkdir(join(admin, "objects"), { recursive: true });
        await mkdir(join(admin, "refs"), { recursive: true });
        await writeFile(join(admin, "config"), PLANTED);
      },
    },
    {
      name: "swaps commondir for a symlink to a documentation copy",
      legitimate: true,
      failure: "gitCommondir",
      // The bytes still match; a later documentation edit would redirect host Git.
      mutate: async (admin: string, _otherGit: string, b: string) => {
        await writeFile(join(b, "docs", "pointer.md"), await readFile(join(admin, "commondir")));
        await rm(join(admin, "commondir"));
        await symlink(join(b, "docs", "pointer.md"), join(admin, "commondir"));
      },
    },
    {
      name: "hard-links commondir into documentation",
      legitimate: true,
      failure: "gitCommondir",
      mutate: (admin: string, _otherGit: string, b: string) =>
        link(join(admin, "commondir"), join(b, "docs", "alias.md")),
    },
    {
      name: "rewrites gitdir",
      legitimate: true,
      failure: "gitGitdir",
      mutate: (admin: string) => writeFile(join(admin, "gitdir"), "/elsewhere/.git\n"),
    },
  ] as const)(
    "restores and refuses when a process outside the sandbox $name during a command",
    async ({ legitimate, failure, mutate }) => {
      const { root, b, common, admin, otherGit } = await worktreeConfigFixture({ legitimate });
      const before = await pointerState(admin);
      const live = await writeEnabledHost(b, root);
      await expect(
        outsideWriteDuring(live, b, () => mutate(admin, otherGit, b)),
      ).rejects.toMatchObject({
        name: "WorktreeGitStateError",
        message: LIVE_COMMAND_FAILURES[failure],
      });
      expect(await pointerState(admin)).toEqual(before);
      for (const name of POINTER_FILES) {
        const entry = await lstat(join(admin, name)).catch(() => undefined);
        if (entry) expect([name, entry.isFile(), entry.nlink]).toEqual([name, true, 1]);
      }
      expect(await git(b, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).toBe(
        common,
      );
      expect(await probeFrom(b)).toBe("absent");
      expect(await probeFrom(b, "docsfab.legit")).toBe(legitimate ? "kept" : "absent");
      // Positive control: the restored worktree runs the same command when nothing changes.
      await expect(outsideWriteDuring(live, b, async () => undefined)).resolves.toMatchObject({
        details: { status: "succeeded", exitCode: 0 },
      });
    },
  );

  it("restores and refuses when a cancelled command leaves a pointer file changed", async () => {
    const { b, admin, otherGit } = await worktreeConfigFixture({ legitimate: true });
    const before = await pointerState(admin);
    const tool = createLiveCommandTool({
      repositoryPath: b,
      allowWrite: true,
      confirm: async () => true,
    });
    const started = join(b, "docs", "started");
    /** Cancels the running command after the outside process has run `mutate`. */
    const cancelledDuring = async (mutate: () => Promise<unknown>) => {
      const cancel = new AbortController();
      try {
        return await whileRunning(
          started,
          () =>
            tool.execute(
              "bash",
              { command: "touch docs/started && sleep 60" },
              cancel.signal,
              undefined,
              {} as never,
            ),
          async () => {
            await mutate();
            cancel.abort();
          },
        );
      } finally {
        await rm(started, { force: true });
      }
    };
    await expect(
      cancelledDuring(() => writeFile(join(admin, "commondir"), `${otherGit}\n`)),
    ).rejects.toMatchObject({
      name: "WorktreeGitStateError",
      message: LIVE_COMMAND_FAILURES.gitCommondir,
    });
    expect(await pointerState(admin)).toEqual(before);
    expect(await probeFrom(b)).toBe("absent");
    // Adjacent condition: a cancellation that changes nothing reports the cancellation.
    await expect(cancelledDuring(async () => undefined)).rejects.toThrow(
      LIVE_COMMAND_FAILURES.cancelled,
    );
    expect(await pointerState(admin)).toEqual(before);
  });

  it("refuses to run a command when a pointer file is not a single regular file", async () => {
    const { root, b, admin } = await worktreeConfigFixture({ legitimate: false });
    await writeFile(join(b, "docs", "settings.md"), PLANTED);
    await symlink(join(b, "docs", "settings.md"), join(admin, "config.worktree"));
    const live = await writeEnabledHost(b, root);
    await expect(live.bash("printf ran > docs/ran.md")).rejects.toMatchObject({
      name: "WorktreeGitStateError",
      message: LIVE_COMMAND_FAILURES.gitIrregular,
    });
    await expect(stat(join(b, "docs", "ran.md"))).rejects.toMatchObject({ code: "ENOENT" });
    // Adjacent condition: a regular, singly linked file with the same bytes runs.
    await rm(join(admin, "config.worktree"));
    await writeFile(join(admin, "config.worktree"), PLANTED);
    expect((await live.bash("printf ran > docs/ran.md")).details).toMatchObject({
      status: "succeeded",
      exitCode: 0,
    });
    expect(await readFile(join(admin, "config.worktree"), "utf8")).toBe(PLANTED);
  });

  it("still commits, branches, and records reflogs with per-worktree configuration in place", async () => {
    const { root, a, b, admin } = await worktreeConfigFixture({ legitimate: true });
    const before = await pointerState(admin);
    const live = await writeEnabledHost(b, root);
    await live.write("docs/guide.md", "B guide.\n");
    for (const command of [
      "git commit --only -q -m 'docs: B guide' -- docs/guide.md",
      "git branch b-probe",
      "git update-ref -m 'docsfab probe' refs/heads/b-moved HEAD",
    ])
      expect((await live.bash(command)).details, command).toMatchObject({
        status: "succeeded",
        exitCode: 0,
      });
    const head = await git(b, ["rev-parse", "HEAD"]);
    expect(await git(b, ["show", "topic:docs/guide.md"], { trim: false })).toBe("B guide.\n");
    expect(await git(a, ["rev-parse", "b-probe"])).toBe(head);
    expect(await git(a, ["reflog", "show", "-1", "--format=%gs", "refs/heads/b-moved"])).toBe(
      "docsfab probe",
    );
    expect(await git(b, ["reflog", "show", "-1", "--format=%gs", "HEAD"])).toMatch(/^commit/u);
    expect(await pointerState(admin)).toEqual(before);
    expect(await probeFrom(b, "docsfab.legit")).toBe("kept");
  });

  it("keeps a restore's staging path out of approved commands", async () => {
    const { root, b, admin, otherGit } = await worktreeConfigFixture({ legitimate: true });
    const before = await pointerState(admin);
    const live = await writeEnabledHost(b, root);
    const staging = join(admin, "commondir.docsfab-restore");
    const result = await live.bash(
      `mkdir ${JSON.stringify(staging)} && printf '%s\\n' ${JSON.stringify(otherGit)} > ${JSON.stringify(join(staging, "probe"))}`,
    );
    if (process.platform === "darwin") {
      // A leftover background process could otherwise swap the staged file during a restore.
      expect(result.details).toMatchObject({ status: "failed" });
      expect(outputOf(result)).toMatch(SANDBOX_DENIED);
      await expect(lstat(staging)).rejects.toMatchObject({ code: "ENOENT" });
    } else {
      // bwrap ends every sandboxed process with the command, so no process can race a restore.
      expect(result.details).toMatchObject({ status: "succeeded", exitCode: 0 });
    }
    // Either way, a later restore replaces whatever sits at the staging path.
    await expect(
      outsideWriteDuring(live, b, () => writeFile(join(admin, "commondir"), `${otherGit}\n`)),
    ).rejects.toMatchObject({
      name: "WorktreeGitStateError",
      message: LIVE_COMMAND_FAILURES.gitCommondir,
    });
    expect(await pointerState(admin)).toEqual(before);
    await expect(lstat(staging)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes the Linux config.worktree placeholder when the isolation probe fails", async () => {
    const { b, admin } = await worktreeConfigFixture({ legitimate: false });
    const configWorktree = join(admin, "config.worktree");
    /** An empty grant path fails `sandbox-exec` and `bwrap` alike, after the pointer record. */
    class UnusableScope extends DocumentationScope {
      override async writablePaths(repository: string) {
        return [...(await super.writablePaths(repository)), ""];
      }
    }
    const tool = createLiveCommandTool({
      repositoryPath: b,
      allowWrite: true,
      confirm: async () => true,
      documentationScope: new UnusableScope(),
    });
    await expect(
      tool.execute(
        "bash",
        { command: "printf ran > docs/ran.md" },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow(DOCUMENTATION_SANDBOX_FAILURE);
    await expect(stat(join(b, "docs", "ran.md"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(configWorktree)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("treats a leftover or concurrent config.worktree placeholder as absent and removes it", async () => {
    const { root, b, admin } = await worktreeConfigFixture({ legitimate: false });
    const configWorktree = join(admin, "config.worktree");
    const succeeded = { details: { status: "succeeded", exitCode: 0 } };
    const live = await writeEnabledHost(b, root);
    // A placeholder left by a session that crashed mid-command.
    await writeFile(configWorktree, WORKTREE_CONFIG_PLACEHOLDER);
    await expect(live.bash("git status --short")).resolves.toMatchObject(succeeded);
    await expect(lstat(configWorktree)).rejects.toMatchObject({ code: "ENOENT" });
    // Another session on this worktree creates, or removes, its placeholder during a command.
    await expect(
      outsideWriteDuring(live, b, () => writeFile(configWorktree, WORKTREE_CONFIG_PLACEHOLDER)),
    ).resolves.toMatchObject(succeeded);
    await expect(lstat(configWorktree)).rejects.toMatchObject({ code: "ENOENT" });
    await writeFile(configWorktree, WORKTREE_CONFIG_PLACEHOLDER);
    await expect(
      outsideWriteDuring(live, b, () => rm(configWorktree, { force: true })),
    ).resolves.toMatchObject(succeeded);
    await expect(lstat(configWorktree)).rejects.toMatchObject({ code: "ENOENT" });
    // Adjacent condition: any other bytes are still a change.
    await expect(
      outsideWriteDuring(live, b, () => writeFile(configWorktree, PLANTED)),
    ).rejects.toMatchObject({
      name: "WorktreeGitStateError",
      message: LIVE_COMMAND_FAILURES.gitConfigWorktree,
    });
    await expect(lstat(configWorktree)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await probeFrom(b)).toBe("absent");
  });
});

/** Linked worktrees A and B whose documentation holds submodule `docs/theme`, initialized in B. */
async function worktreesWithSubmodule() {
  const root = await roots.create("docsfab-doc-submodule-");
  const theme = join(root, "theme");
  await initFixtureRepo(theme, { "index.md": "Theme.\n" }, { branch: "main", message: "Theme" });
  const a = join(root, "A");
  await initFixtureRepo(a, { "docs/guide.md": "A guide.\n" }, { branch: "main", message: "Base" });
  await git(a, ["config", "core.hooksPath", "/dev/null"]);
  await git(a, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", theme, "docs/theme"]);
  await git(a, ["commit", "-q", "-m", "Theme submodule"]);
  const b = join(root, "B");
  await git(a, ["worktree", "add", "-q", "-b", "topic", b]);
  await git(b, ["-c", "protocol.file.allow=always", "submodule", "update", "--init", "-q"]);
  const common = join(await realpath(a), ".git");
  return { root, a: await realpath(a), b: await realpath(b), common };
}

/**
 * The operator's next plain `git status` in `checkout`, traced: where host Git started a child
 * Git process, and every value of `docsfab.probe` any of those processes read.
 */
async function hostStatusTrace(checkout: string, root: string) {
  const trace = join(root, `trace-${randomUUID()}.json`);
  await git(checkout, ["status", "--porcelain=v1"], {
    env: { GIT_TRACE2_EVENT: trace, GIT_TRACE2_CONFIG_PARAMS: "docsfab.*" },
  });
  const events = (await readFile(trace, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map(
      (line) => JSON.parse(line) as { event: string; cd?: string; param?: string; value?: string },
    );
  await rm(trace, { force: true });
  return {
    children: events.filter((event) => event.event === "child_start").map((event) => event.cd),
    probes: events
      .filter((event) => event.event === "def_param" && event.param === "docsfab.probe")
      .map((event) => event.value),
  };
}

const gitlinks = async (checkout: string) =>
  (await git(checkout, ["ls-files", "--stage"]))
    .split("\n")
    .filter((line) => line.startsWith("160000 "))
    .map((line) => line.split("\t")[1]);

/** Commits one file in a new repository at `at` whose own config sets the probe key. */
const EMBED = (at: string) =>
  [
    `git init -q ${at}`,
    `git -C ${at} config docsfab.probe 1`,
    `printf 's\\n' > ${at}/s.md`,
    `git -C ${at} add s.md`,
    `git -C ${at} -c user.name=probe -c user.email=probe@example.test commit -q -m s`,
    `printf 'dirty\\n' > ${at}/s.md`,
  ].join(" && ");

const execFileAsync = promisify(execFile);

/** Undoes the permission and immutable-flag locks a command can put on a tree it created. */
async function unlockTree(path: string) {
  await execFileAsync("chmod", ["-R", "u+rwx", path]).catch(() => undefined);
  if (process.platform === "darwin")
    await execFileAsync("chflags", ["-R", "nouchg", path]).catch(() => undefined);
}

/** A committed repository outside the checkout whose own config sets the probe key. */
async function probeRepository(root: string) {
  const path = join(root, "planted");
  await initFixtureRepo(path, { "s.md": "s\n" }, { branch: "main", message: "planted" });
  await git(path, ["config", "docsfab.probe", "1"]);
  await writeFile(join(path, "s.md"), "dirty\n");
  return { path, head: await git(path, ["rev-parse", "HEAD"]) };
}

describe("live-agent linked worktree embedded repositories", { timeout: HOST_CASE_MS }, () => {
  it("keeps an approved command from making host git status read an embedded repository's config", async () => {
    const { root, b } = await linkedWorktrees();
    const live = await writeEnabledHost(b, root);
    const outcome = await live
      .bash(`set -e && ${EMBED("docs/sub")} && git add docs/sub`)
      .catch((error: unknown) => error);
    if (process.platform === "darwin") {
      // The profile denies creating `.git` under a documentation path.
      expect(outcome).toMatchObject({ details: { status: "failed" } });
      expect(outputOf(outcome as never)).toMatch(SANDBOX_DENIED);
    } else {
      expect(outcome).toMatchObject({
        name: "WorktreeGitStateError",
        message: LIVE_COMMAND_FAILURES.gitNestedRepository,
      });
    }
    await expect(lstat(join(b, "docs", "sub", ".git"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await gitlinks(b)).toEqual([]);
    expect(await hostStatusTrace(b, root)).toEqual({ children: [], probes: [] });
  });

  it.each([".Git", ".GIT"])(
    "keeps an approved command from creating a %s gitfile under documentation",
    async (name) => {
      const { root, a, b } = await linkedWorktrees();
      const planted = await probeRepository(root);
      const live = await writeEnabledHost(b, root);
      const outcome = await live
        .bash(
          `mkdir -p docs/sub && printf 'gitdir: %s\\n' ${JSON.stringify(join(planted.path, ".git"))} > docs/sub/${name}`,
        )
        .catch((error: unknown) => error);
      if (process.platform === "darwin") {
        // The profile denies `.git` in any letter case, as the case-insensitive volume resolves it.
        expect(outcome).toMatchObject({ details: { status: "failed" } });
        expect(outputOf(outcome as never)).toMatch(SANDBOX_DENIED);
      } else {
        expect(outcome).toMatchObject({
          name: "WorktreeGitStateError",
          message: LIVE_COMMAND_FAILURES.gitNestedRepository,
        });
      }
      await expect(lstat(join(b, "docs", "sub", name))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await git(join(b, "docs", "sub"), ["rev-parse", "--absolute-git-dir"])).toBe(
        join(a, ".git", "worktrees", "B"),
      );
    },
  );

  it("removes a .git name spelled with code points HFS+ ignores, and keeps names that only start with .git", async () => {
    const { root, b } = await linkedWorktrees();
    const planted = await probeRepository(root);
    const live = await writeEnabledHost(b, root);
    // `.g`, U+200C ZERO WIDTH NON-JOINER, `it`: HFS+ and Git's own path checks read it as `.git`.
    await expect(
      live.bash(
        `mkdir -p docs/sub && printf 'gitdir: %s\\n' ${JSON.stringify(join(planted.path, ".git"))} > "docs/sub/$(printf '.g\\342\\200\\214it')"`,
      ),
    ).rejects.toMatchObject({
      name: "WorktreeGitStateError",
      message: LIVE_COMMAND_FAILURES.gitNestedRepository,
    });
    expect(await readdir(join(b, "docs", "sub"))).toEqual([]);
    // Positive control: documentation files named like Git's own are not repository markers.
    await expect(
      live.bash(
        "mkdir -p docs/.github && printf k > docs/.gitkeep && printf i > docs/.gitignore && printf x > docs/.github/x.md",
      ),
    ).resolves.toMatchObject({ details: { status: "succeeded", exitCode: 0 } });
    for (const path of [".gitkeep", ".gitignore", ".github/x.md"])
      expect((await stat(join(b, "docs", path))).isFile(), path).toBe(true);
  });

  it("removes an embedded repository an approved command moves into documentation, and its gitlink", async () => {
    const { root, b } = await linkedWorktrees();
    const live = await writeEnabledHost(b, root);
    // Renaming a directory that already holds `.git` passes a path-based profile rule.
    await expect(
      live.bash(
        `set -e && ${EMBED('"$TMPDIR/nest"')} && mv "$TMPDIR/nest" docs/sub && git add docs/sub`,
      ),
    ).rejects.toMatchObject({
      name: "WorktreeGitStateError",
      message: LIVE_COMMAND_FAILURES.gitNestedRepository,
    });
    await expect(lstat(join(b, "docs", "sub", ".git"))).rejects.toMatchObject({ code: "ENOENT" });
    // Only what the command created is gone; the moved documentation stays.
    expect(await readFile(join(b, "docs", "sub", "s.md"), "utf8")).toBe("dirty\n");
    expect(await gitlinks(b)).toEqual([]);
    expect(await hostStatusTrace(b, root)).toEqual({ children: [], probes: [] });
    // Positive control: the same checkout still runs a benign command.
    await expect(live.bash("git status --short")).resolves.toMatchObject({
      details: { status: "succeeded", exitCode: 0 },
    });
  });

  it("keeps an approved command from turning a documentation directory into a bare repository", async () => {
    const { root, a, b } = await linkedWorktrees();
    const live = await writeEnabledHost(b, root);
    const outcome = await live
      .bash(
        "set -e && mkdir -p docs/objects docs/refs && git config -f docs/config docsfab.probe 1 && printf 'ref: refs/heads/main\\n' > docs/HEAD",
      )
      .catch((error: unknown) => error);
    if (process.platform === "darwin") {
      // The profile denies creating `HEAD` under a documentation path.
      expect(outcome).toMatchObject({ details: { status: "failed" } });
      expect(outputOf(outcome as never)).toMatch(SANDBOX_DENIED);
    } else {
      expect(outcome).toMatchObject({
        name: "WorktreeGitStateError",
        message: LIVE_COMMAND_FAILURES.gitNestedRepository,
      });
    }
    await expect(lstat(join(b, "docs", "HEAD"))).rejects.toMatchObject({ code: "ENOENT" });
    // Git started inside documentation finds this worktree's repository, not a planted one.
    expect(await git(join(b, "docs"), ["rev-parse", "--absolute-git-dir"])).toBe(
      join(a, ".git", "worktrees", "B"),
    );
    expect(await probeFrom(join(b, "docs"))).toBe("absent");
  });

  it("removes a bare repository an approved command moves into documentation, and keeps the operator's own", async () => {
    const { root, b } = await linkedWorktrees();
    const archive = join(b, "docs", "archive");
    await git(b, ["init", "-q", "--bare", archive]);
    await git(archive, ["config", "docsfab.owner", "operator"]);
    const live = await writeEnabledHost(b, root);
    await expect(
      live.bash(
        'set -e && git init -q --bare "$TMPDIR/bare" && git -C "$TMPDIR/bare" config docsfab.probe 1 && mv "$TMPDIR/bare" docs/bare',
      ),
    ).rejects.toMatchObject({
      name: "WorktreeGitStateError",
      message: LIVE_COMMAND_FAILURES.gitNestedRepository,
    });
    await expect(lstat(join(b, "docs", "bare", "HEAD"))).rejects.toMatchObject({ code: "ENOENT" });
    // Only the entry that made it a repository is gone; the rest stays as documentation content.
    expect((await stat(join(b, "docs", "bare", "objects"))).isDirectory()).toBe(true);
    expect(await probeFrom(join(b, "docs", "bare"))).toBe("absent");
    // The operator's bare repository stays, and approved commands cannot write it.
    const write = await live.bash("git -C docs/archive config docsfab.probe 1");
    expect(write.details).toMatchObject({ status: "failed" });
    expect(outputOf(write)).toMatch(POINTER_DENIED);
    expect(await git(archive, ["config", "--get", "docsfab.owner"])).toBe("operator");
    expect(await probeFrom(archive)).toBe("absent");
    await expect(live.bash("printf 'x\\n' > docs/x.md")).resolves.toMatchObject({
      details: { status: "succeeded", exitCode: 0 },
    });
  });

  it("removes only the entries that make documentation a bare repository", async () => {
    const { root, a, b } = await linkedWorktrees();
    const api = join(b, "docs", "api");
    for (const name of ["objects", "refs"]) {
      await mkdir(join(api, name), { recursive: true });
      await writeFile(join(api, name, "index.md"), `${name}\n`);
    }
    const live = await writeEnabledHost(b, root);
    const refused = {
      name: "WorktreeGitStateError",
      message: LIVE_COMMAND_FAILURES.gitNestedRepository,
    };
    // A new HEAD beside existing documentation named objects and refs: HEAD goes.
    await expect(
      outsideWriteDuring(live, b, () => writeFile(join(api, "HEAD"), "ref: refs/heads/main\n")),
    ).rejects.toMatchObject(refused);
    await expect(lstat(join(api, "HEAD"))).rejects.toMatchObject({ code: "ENOENT" });
    for (const name of ["objects", "refs"])
      expect(await readFile(join(api, name, "index.md"), "utf8")).toBe(`${name}\n`);
    // Adjacent condition: beside an existing HEAD, the new objects and refs go instead.
    const notes = join(b, "docs", "notes");
    await mkdir(notes);
    await writeFile(join(notes, "HEAD"), "ref: refs/heads/main\n");
    await expect(
      outsideWriteDuring(live, b, async () => {
        await mkdir(join(notes, "objects"));
        await mkdir(join(notes, "refs"));
      }),
    ).rejects.toMatchObject(refused);
    expect(await readFile(join(notes, "HEAD"), "utf8")).toBe("ref: refs/heads/main\n");
    for (const name of ["objects", "refs"])
      await expect(lstat(join(notes, name)), name).rejects.toMatchObject({ code: "ENOENT" });
    // HEAD beside commondir is a repository too, borrowing another directory's objects and refs.
    const linked = join(b, "docs", "linked");
    await expect(
      outsideWriteDuring(live, b, async () => {
        await mkdir(linked);
        await writeFile(join(linked, "commondir"), `${join(a, ".git")}\n`);
        await writeFile(join(linked, "HEAD"), "ref: refs/heads/main\n");
      }),
    ).rejects.toMatchObject(refused);
    await expect(lstat(join(linked, "HEAD"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await git(linked, ["rev-parse", "--absolute-git-dir"])).toBe(
      join(a, ".git", "worktrees", "B"),
    );
  });

  it("removes a gitlink an approved command stages for the operator's own nested repository", async () => {
    const { root, b } = await linkedWorktrees();
    const notes = join(b, "docs", "notes");
    await initFixtureRepo(notes, { "n.md": "n\n" }, { branch: "main", message: "notes" });
    await git(notes, ["config", "docsfab.owner", "operator"]);
    const live = await writeEnabledHost(b, root);
    await expect(live.bash("git add docs/notes")).rejects.toMatchObject({
      name: "WorktreeGitStateError",
      message: LIVE_COMMAND_FAILURES.gitGitlink,
    });
    expect(await gitlinks(b)).toEqual([]);
    // The operator's repository is not the command's to remove.
    expect(await git(notes, ["config", "--get", "docsfab.owner"])).toBe("operator");
    // Positive control: moving the operator's repository within documentation is not a creation.
    // The profile denies paths inside `.git`, and bwrap's read-only mount moves with its parent.
    await expect(live.bash("mv docs/notes docs/notes-moved")).resolves.toMatchObject({
      details: { status: "succeeded", exitCode: 0 },
    });
    await expect(lstat(notes)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await git(join(b, "docs", "notes-moved"), ["config", "--get", "docsfab.owner"])).toBe(
      "operator",
    );
  });

  it("restores the staged .gitmodules an approved command adds or changes", async () => {
    const { root, b } = await linkedWorktrees();
    const live = await writeEnabledHost(b, root);
    const stage = (url: string) =>
      `blob=$(printf '[submodule "x"]\\n\\tpath = docs/x\\n\\turl = ${url}\\n' | git hash-object -w --stdin) && git update-index --add --cacheinfo "100644,$blob,.gitmodules"`;
    const staged = () => git(b, ["ls-files", "--stage", "--", ".gitmodules"]);
    await expect(live.bash(stage("./probe"))).rejects.toMatchObject({
      name: "WorktreeGitStateError",
      message: LIVE_COMMAND_FAILURES.gitGitmodules,
    });
    expect(await staged()).toBe("");
    // The operator's own staged entry comes back unchanged.
    await writeFile(join(root, "gitmodules"), '[submodule "y"]\n\tpath = docs/y\n\turl = ./y\n');
    const own = await git(b, ["hash-object", "-w", join(root, "gitmodules")]);
    await git(b, ["update-index", "--add", "--cacheinfo", `100644,${own},.gitmodules`]);
    const before = await staged();
    await expect(live.bash(stage("./other"))).rejects.toMatchObject({
      name: "WorktreeGitStateError",
      message: LIVE_COMMAND_FAILURES.gitGitmodules,
    });
    expect(await staged()).toBe(before);
    // Positive control: a command that leaves it alone succeeds.
    await expect(live.bash("git status --short")).resolves.toMatchObject({
      details: { status: "succeeded", exitCode: 0 },
    });
  });

  it.each([
    {
      repair: "removes a staged gitlink",
      command: "git add docs/notes",
      message: LIVE_COMMAND_FAILURES.gitGitlink,
    },
    {
      repair: "restores the operator's staged .gitmodules",
      command:
        'blob=$(printf \'[submodule "x"]\\n\\tpath = docs/x\\n\\turl = ./probe\\n\' | git hash-object -w --stdin) && git update-index --add --cacheinfo "100644,$blob,.gitmodules"',
      message: LIVE_COMMAND_FAILURES.gitGitmodules,
    },
  ] as const)(
    "runs no operator hook, fsmonitor, or global Git configuration when the host check $repair",
    async ({ command, message }) => {
      const { root, a, b } = await linkedWorktrees();
      const notes = join(b, "docs", "notes");
      await initFixtureRepo(notes, { "n.md": "n\n" }, { branch: "main", message: "notes" });
      await writeFile(join(root, "gitmodules"), '[submodule "y"]\n\tpath = docs/y\n\turl = ./y\n');
      const own = await git(b, ["hash-object", "-w", join(root, "gitmodules")]);
      await git(b, ["update-index", "--add", "--cacheinfo", `100644,${own},.gitmodules`]);
      const stagedBefore = await git(b, ["ls-files", "--stage", "--", ".gitmodules"]);
      // The operator's own programs, outside every path an approved command can write. Each
      // only records that it ran.
      const hooks = join(root, "hooks");
      const hookRan = join(root, "hook-ran");
      const fsmonitorRan = join(root, "fsmonitor-ran");
      await mkdir(hooks);
      await writeFile(join(hooks, "post-index-change"), `#!/bin/sh\necho ran >> '${hookRan}'\n`, {
        mode: 0o755,
      });
      await writeFile(
        join(root, "fsmonitor"),
        `#!/bin/sh\necho ran >> '${fsmonitorRan}'\nexit 1\n`,
        {
          mode: 0o755,
        },
      );
      await git(a, ["config", "core.hooksPath", hooks]);
      await git(a, ["config", "core.fsmonitor", join(root, "fsmonitor")]);
      // The operator's global configuration records every Git process that reads it.
      const trace = join(root, "global-trace.json");
      const globalConfig = join(root, "global-gitconfig");
      await writeFile(globalConfig, `[trace2]\n\teventTarget = ${trace}\n`);
      vi.stubEnv("GIT_CONFIG_GLOBAL", globalConfig);
      const tracedIndexCommands = async () =>
        (await readFile(trace, "utf8").catch(() => ""))
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as { event: string; argv?: string[] })
          .filter(
            (event) =>
              event.event === "start" &&
              event.argv?.some((arg) => arg === "ls-files" || arg === "update-index"),
          );
      try {
        const tool = createLiveCommandTool({
          repositoryPath: b,
          allowWrite: true,
          confirm: async () => true,
          environment: { PATH: process.env.PATH },
        });
        await expect(
          tool.execute("bash", { command }, undefined, undefined, {} as never),
        ).rejects.toMatchObject({ name: "WorktreeGitStateError", message });
        // Read before any operator Git below, which runs both programs.
        expect(await bytesOrAbsent(hookRan)).toBe("absent");
        expect(await bytesOrAbsent(fsmonitorRan)).toBe("absent");
        expect(await tracedIndexCommands()).toEqual([]);
        expect(await gitlinks(b)).toEqual([]);
        expect(await git(b, ["ls-files", "--stage", "--", ".gitmodules"])).toBe(stagedBefore);
        // Positive controls: the operator's own Git runs each of them.
        await execFileAsync("git", ["ls-files", "--stage"], {
          cwd: b,
          env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: globalConfig },
        });
        expect(await tracedIndexCommands()).not.toEqual([]);
      } finally {
        vi.unstubAllEnvs();
      }
      expect(await bytesOrAbsent(fsmonitorRan)).not.toBe("absent");
      await git(b, ["read-tree", "HEAD"]);
      expect(await bytesOrAbsent(hookRan)).not.toBe("absent");
    },
  );

  it("keeps an initialized submodule's Git directory out of approved commands and keeps it working", async () => {
    const { root, b, common } = await worktreesWithSubmodule();
    const modules = join(common, "worktrees", "B", "modules");
    const theme = join(modules, "docs", "theme");
    const configBefore = await readFile(join(theme, "config"));
    const gitfileBefore = await readFile(join(b, "docs", "theme", ".git"));
    const live = await writeEnabledHost(b, root);
    for (const command of [
      "git -C docs/theme config docsfab.probe planted",
      `printf '[docsfab]\\n\\tprobe = planted\\n' >> ${JSON.stringify(join(theme, "config"))}`,
      `printf 'gitdir: %s\\n' ${JSON.stringify(join(root, "elsewhere"))} > docs/theme/.git`,
      `mkdir -p ${JSON.stringify(join(modules, "docs", "other"))}`,
    ]) {
      const result = await live.bash(command);
      expect(result.details, command).toMatchObject({ status: "failed" });
      expect(outputOf(result), command).toMatch(POINTER_DENIED);
    }
    expect(await readFile(join(theme, "config"))).toEqual(configBefore);
    expect(await readFile(join(b, "docs", "theme", ".git"))).toEqual(gitfileBefore);
    await expect(lstat(join(modules, "docs", "other"))).rejects.toMatchObject({ code: "ENOENT" });
    // Positive control: the operator's submodule keeps working inside and outside the sandbox.
    await live.write("docs/guide.md", "B guide.\n");
    for (const command of [
      "git status --short",
      "git submodule status",
      "git commit --only -q -m 'docs: B guide' -- docs/guide.md",
    ])
      expect((await live.bash(command)).details, command).toMatchObject({
        status: "succeeded",
        exitCode: 0,
      });
    expect(await gitlinks(b)).toEqual(["docs/theme"]);
    expect(await hostStatusTrace(b, root)).toEqual({ children: ["docs/theme"], probes: [] });
  });

  it.each([
    {
      name: "creates a .git directory under documentation and stages it",
      mutate: async (b: string) => {
        await initFixtureRepo(join(b, "docs", "sub"), { "s.md": "s\n" }, { message: "s" });
        await git(join(b, "docs", "sub"), ["config", "docsfab.probe", "1"]);
        await writeFile(join(b, "docs", "sub", "s.md"), "dirty\n");
        await git(b, ["add", "docs/sub"]);
      },
    },
    {
      name: "creates a case-variant .Git file under documentation",
      mutate: async (b: string, planted: string) => {
        await mkdir(join(b, "docs", "sub"));
        await writeFile(join(b, "docs", "sub", ".Git"), `gitdir: ${join(planted, ".git")}\n`);
      },
    },
    {
      name: "creates a .git symlink under documentation",
      mutate: async (b: string, planted: string) => {
        await mkdir(join(b, "docs", "sub"));
        await symlink(join(planted, ".git"), join(b, "docs", "sub", ".git"));
      },
    },
    {
      name: "creates submodule Git directories in the admin directory",
      mutate: async (_b: string, planted: string, admin: string) => {
        await mkdir(join(admin, "modules", "docs"), { recursive: true });
        await rename(join(planted, ".git"), join(admin, "modules", "docs", "sub"));
      },
    },
  ] as const)(
    "removes what a process outside the sandbox $name during a command",
    async ({ mutate }) => {
      const { root, a, b } = await linkedWorktrees();
      const admin = join(a, ".git", "worktrees", "B");
      const planted = await probeRepository(root);
      const live = await writeEnabledHost(b, root);
      await expect(
        outsideWriteDuring(live, b, () => mutate(b, planted.path, admin)),
      ).rejects.toMatchObject({
        name: "WorktreeGitStateError",
        message: LIVE_COMMAND_FAILURES.gitNestedRepository,
      });
      for (const name of [".git", ".Git"])
        await expect(lstat(join(b, "docs", "sub", name)), name).rejects.toMatchObject({
          code: "ENOENT",
        });
      await expect(lstat(join(admin, "modules"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await gitlinks(b)).toEqual([]);
      expect(await hostStatusTrace(b, root)).toEqual({ children: [], probes: [] });
      // Positive control: the restored worktree runs the same command when nothing changes.
      await expect(outsideWriteDuring(live, b, async () => undefined)).resolves.toMatchObject({
        details: { status: "succeeded", exitCode: 0 },
      });
    },
  );

  it("removes an embedded repository an approved command locks against removal", async () => {
    const { root, b } = await linkedWorktrees();
    const live = await writeEnabledHost(b, root);
    const nest = '"$TMPDIR/nest"';
    // On macOS the profile denies writes under `.git` in documentation, so the command locks the
    // repository in scratch and renames it in; it also marks a file immutable. On Linux the move
    // from scratch is a copy, so the command locks the copy.
    const [lockInScratch, lockInDocs] =
      process.platform === "darwin"
        ? [` && chflags uchg ${nest}/.git/description && chmod 000 ${nest}/.git/objects`, ""]
        : ["", " && chmod 000 docs/locked/sub/.git/objects"];
    const locked = join(b, "docs", "locked");
    try {
      await expect(
        live.bash(
          `set -e && ${EMBED(nest)}${lockInScratch} && mkdir docs/locked && mv ${nest} docs/locked/sub && git add docs/locked/sub${lockInDocs} && chmod 000 docs/locked`,
        ),
      ).rejects.toMatchObject({
        name: "WorktreeGitStateError",
        message: LIVE_COMMAND_FAILURES.gitNestedRepository,
      });
      await expect(lstat(join(locked, "sub", ".git"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(join(locked, "sub", "s.md"), "utf8")).toBe("dirty\n");
      expect(await gitlinks(b)).toEqual([]);
      expect(await hostStatusTrace(b, root)).toEqual({ children: [], probes: [] });
      // The check restores only read and search access; the owner's write bit stays as the command left it.
      expect((await stat(locked)).mode & 0o777).toBe(0o500);
    } finally {
      // A failed removal must not leave a tree the temporary-root cleanup cannot delete.
      await unlockTree(locked);
    }
  });

  it("runs every check when a command changes a pointer file and embeds a repository", async () => {
    const { root, b, admin, otherGit } = await worktreeConfigFixture({ legitimate: true });
    const before = await pointerState(admin);
    const live = await writeEnabledHost(b, root);
    await expect(
      outsideWriteDuring(live, b, async () => {
        await initFixtureRepo(join(b, "docs", "sub"), { "s.md": "s\n" }, { message: "s" });
        await git(b, ["add", "docs/sub"]);
        await writeFile(join(admin, "commondir"), `${otherGit}\n`);
      }),
    ).rejects.toMatchObject({
      name: "WorktreeGitStateError",
      message: LIVE_COMMAND_FAILURES.gitCommondir,
    });
    expect(await pointerState(admin)).toEqual(before);
    await expect(lstat(join(b, "docs", "sub", ".git"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await gitlinks(b)).toEqual([]);
  });

  it("refuses when the index cannot be read after or before a command", async () => {
    const { root, a, b } = await linkedWorktrees();
    const index = join(a, ".git", "worktrees", "B", "index");
    const live = await writeEnabledHost(b, root);
    await expect(
      outsideWriteDuring(live, b, () => writeFile(index, "not an index\n")),
    ).rejects.toMatchObject({
      name: "WorktreeGitStateError",
      message: LIVE_COMMAND_FAILURES.gitIndexUnrestorable,
    });
    // Adjacent condition: the next command cannot record the index either, so it does not run.
    await expect(live.bash("printf ran > docs/ran.md")).rejects.toMatchObject({
      name: "WorktreeGitStateError",
      message: LIVE_COMMAND_FAILURES.gitIndexUnreadable,
    });
    await expect(stat(join(b, "docs", "ran.md"))).rejects.toMatchObject({ code: "ENOENT" });
    // Positive control: once the operator rebuilds the index, commands run again.
    await rm(index);
    await git(b, ["read-tree", "HEAD"]);
    await expect(live.bash("printf ran > docs/ran.md")).resolves.toMatchObject({
      details: { status: "succeeded", exitCode: 0 },
    });
  });
});

/**
 * Starts a background process that keeps the command's output open and writes `docs/late.md`
 * once the test creates `docs/go`, after the command returns. Waits until it is running.
 */
const lateWriter = (launch = "", redirect = "") =>
  `${launch} sh -c 'touch docs/bg-started; until [ -e docs/go ]; do sleep 0.05; done; touch docs/late.md'${redirect} & until [ -e docs/bg-started ]; do sleep 0.05; done`;

/**
 * Replaces `process.kill` for SIGKILLs aimed at a process group until the test ends: `fault`
 * returns `true` to report a kill that did nothing, throws to simulate an errno, or returns
 * `undefined` to send the real signal. Other calls always pass through.
 */
function faultGroupKills(fault: (call: number) => true | undefined) {
  const real = process.kill.bind(process);
  let calls = 0;
  const spy = vi.spyOn(process, "kill").mockImplementation(((
    pid: number,
    signal?: string | number,
  ) => {
    if (pid < 0 && signal === "SIGKILL") {
      calls += 1;
      if (fault(calls)) return true;
    }
    return real(pid, signal as never);
  }) as typeof process.kill);
  // Also after a timeout, so a stuck kill loop gets the real signal and ends.
  onTestFinished(() => spy.mockRestore());
  return { calls: () => calls };
}

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`kill ${code}`), { code });
}
/** Long enough for a surviving background process to notice `docs/go` many times over. */
const LATE_WRITE_WAIT_MS = POLL_MS * 50;

/** Releases any background process the command left, then reports whether it wrote. */
async function lateWrite(root: string) {
  await writeFile(join(root, "docs", "go"), "");
  await new Promise((resolve) => setTimeout(resolve, LATE_WRITE_WAIT_MS));
  return bytesOrAbsent(join(root, "docs", "late.md"));
}

describe("live-agent approved command lifetime", { timeout: HOST_CASE_MS }, () => {
  const tool = (root: string, environment: NodeJS.ProcessEnv = {}) =>
    createLiveCommandTool({
      repositoryPath: root,
      allowWrite: true,
      confirm: async () => true,
      environment: { PATH: process.env.PATH, ...environment },
    });

  it("ends a background process before the result returns when the command exits", async () => {
    const root = await fixture();
    const result = await tool(root).execute(
      "bash",
      { command: `${lateWriter()}; printf 'out\\n'; printf 'err\\n' >&2; exit 3`, timeout: 10 },
      undefined,
      undefined,
      {} as never,
    );
    expect(await lateWrite(root)).toBe("absent");
    // Positive control: the foreground command's own output and exit code are unchanged.
    expect(result.details).toEqual({ status: "failed", exitCode: 3 });
    expect(outputOf(result)).toMatch(/^Command exited with code 3\.\n/u);
    expect(outputOf(result)).toContain("out\n");
    expect(outputOf(result)).toContain("err\n");
    await expect(
      tool(root).execute("bash", { command: "printf ok" }, undefined, undefined, {} as never),
    ).resolves.toEqual({
      content: [{ type: "text", text: "Command exited with code 0.\nok" }],
      details: { status: "succeeded", exitCode: 0 },
    });
  });

  it("ends a background process before the result returns when the command times out", async () => {
    const root = await fixture();
    await expect(
      tool(root).execute(
        "bash",
        { command: `${lateWriter()}; sleep 60`, timeout: 2 },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow(LIVE_COMMAND_FAILURES.timeout);
    expect(await lateWrite(root)).toBe("absent");
  });

  it("ends a background process before the result returns when the command is cancelled", async () => {
    const root = await fixture();
    const cancel = new AbortController();
    await expect(
      whileRunning(
        join(root, "docs", "started"),
        () =>
          tool(root).execute(
            "bash",
            { command: `${lateWriter()}; touch docs/started; sleep 60` },
            cancel.signal,
            undefined,
            {} as never,
          ),
        async () => cancel.abort(),
      ),
    ).rejects.toThrow(LIVE_COMMAND_FAILURES.cancelled);
    expect(await lateWrite(root)).toBe("absent");
  });

  // A group kill that misses a member on a loaded host, made deterministic: the first `misses`
  // group SIGKILLs report success and do nothing. One background member, which does not hold
  // the output open, so `close` follows the command's exit at once.
  it.each([2, 3])(
    "ends a background process that %i group kills missed before the result returns",
    async (misses) => {
      const root = await fixture();
      const kills = faultGroupKills((call) => (call <= misses ? true : undefined));
      await expect(
        tool(root).execute(
          "bash",
          { command: lateWriter("", " >/dev/null 2>&1"), timeout: 10 },
          undefined,
          undefined,
          {} as never,
        ),
      ).resolves.toMatchObject({ details: { status: "succeeded", exitCode: 0 } });
      expect(await lateWrite(root)).toBe("absent");
      // Not vacuous: every missed kill was spent, and a real one followed.
      expect(kills.calls()).toBeGreaterThan(misses);
    },
  );

  it("refuses with the named limit when the command's processes outlast the stop bound", async () => {
    const root = await fixture();
    // The catalog floor, so the refusal lands as early as a host can configure it.
    const floor = limitDefinition(COMMAND_PROCESS_STOP_LIMIT).min;
    const environment = { DOCSFAB_LIVE_AGENT_COMMAND_PROCESS_STOP_MS: String(floor) };
    // No real process is left; every group kill reports a member that is still there.
    const kills = faultGroupKills(() => true);
    const error = await tool(root, environment)
      .execute("bash", { command: "printf ok", timeout: 10 }, undefined, undefined, {} as never)
      .then(
        () => undefined,
        (caught: Error) => caught,
      );
    const observed = Number(/: (\d+) exceeds /u.exec(error?.message ?? "")?.[1]);
    expect(observed).toBeGreaterThan(floor);
    // The configured bound, not the catalog default, ended the loop.
    expect(observed).toBeLessThan(limitDefinition(COMMAND_PROCESS_STOP_LIMIT).value);
    expect(error?.message).toBe(
      commandProcessStopRefusal(limit(COMMAND_PROCESS_STOP_LIMIT, { environment }), observed),
    );
    expect(error?.message).toMatch(
      new RegExp(
        `^The host command ended, but a process it started could not be stopped\\. End it before retrying\\. live-agent-command-process-stop-ms-bound: ${observed} exceeds liveAgent\\.commandProcessStopMs = ${floor} milliseconds\\. `,
        "u",
      ),
    );
    // The kill repeated until the bound, not once.
    expect(kills.calls()).toBeGreaterThan(2);
    // The operator's terminal shows the refusal as it is, not as an unclassified failure.
    expect(failureReason(error, [])).toBe(error?.message);
    expect(failureReason(`${error?.message} Injected text.`, [])).toBeUndefined();
  });

  it("stops killing once no member of the group accepts a signal (EPERM)", async () => {
    const root = await fixture();
    const kills = faultGroupKills(() => {
      throw errno("EPERM");
    });
    await expect(
      tool(root).execute("bash", { command: "printf ok" }, undefined, undefined, {} as never),
    ).resolves.toEqual({
      content: [{ type: "text", text: "Command exited with code 0.\nok" }],
      details: { status: "succeeded", exitCode: 0 },
    });
    // The kill at exit, then one at close that ends the loop.
    expect(kills.calls()).toBe(2);
  });

  it("does not treat any other kill failure as an ended group", async () => {
    const root = await fixture();
    // The kill at exit succeeds; the one at close fails with an error the loop must not absorb.
    faultGroupKills((call) => {
      if (call === 2) throw errno("EINVAL");
      return undefined;
    });
    await expect(
      tool(root).execute("bash", { command: "printf ok" }, undefined, undefined, {} as never),
    ).rejects.toMatchObject({ code: "EINVAL", message: "kill EINVAL" });
  });

  // bwrap's PID namespace ends every process with the command; macOS has no such boundary.
  it.runIf(process.platform === "linux")(
    "ends a background process that starts its own session when the command exits on Linux",
    async () => {
      const root = await fixture();
      await expect(
        tool(root).execute(
          "bash",
          { command: lateWriter("setsid"), timeout: 10 },
          undefined,
          undefined,
          {} as never,
        ),
      ).resolves.toMatchObject({ details: { status: "succeeded", exitCode: 0 } });
      expect(await lateWrite(root)).toBe("absent");
    },
  );
});

const PROJECT_CONFIG = {
  schemaVersion: 1,
  gitlab: { remote: "origin", defaultBranch: "main" },
  provider: { configuration: "host" },
  storage: { scope: "user-private" },
};

/** A docs-only repository whose pages sit in top-level directories, as Mintlify and similar sites keep them. */
async function rootLayoutRepository(extra: Record<string, string> = {}) {
  const root = await roots.create("docsfab-doc-layout-");
  const repositoryPath = join(root, "repo");
  await initFixtureRepo(
    repositoryPath,
    {
      "README.md": "Readme.\n",
      "index.mdx": "Home.\n",
      "get-started/choose-deployment-path.mdx": "Choose a path.\n",
      "get-started/install.mdx": "Install.\n",
      "guides/tune.md": "Tune.\n",
      "snippets/card.jsx": "export const Card = () => null;\n",
      "src/README.md": "Source notes.\n",
      "src/util.ts": "export const util = 1;\n",
      "AGENTS.md": "Agent instructions.\n",
      ...extra,
    },
    { branch: "main", message: "Fixture base" },
  );
  await git(repositoryPath, ["config", "core.hooksPath", "/dev/null"]);
  return { root, repositoryPath: await realpath(repositoryPath) };
}

describe("live-agent documentation layout and scope refusals", { timeout: HOST_CASE_MS }, () => {
  it("grants configured documentationRoots for safe text documents only", () => {
    const scope = new DocumentationScope([], ["get-started"]);
    expect(scope.configuredRoots).toEqual(["get-started/"]);
    for (const path of ["get-started/install.mdx", "get-started/nested/page.md", "docs/a.md"])
      expect(scope.allows(path), path).toBe(true);
    for (const path of [
      "get-started/guide.rst",
      "get-started/guide.adoc",
      "get-started/guide.asciidoc",
      "get-started/topic.dita",
      "get-started/map.ditamap",
      "get-started/document.xml",
      "get-started/notes.odd",
    ])
      expect(scope.allows(path), path).toBe(true);
    for (const path of [
      "get-started/card.jsx",
      "get-started/tool.sh",
      "get-started/logo.png",
      "get-started/AGENTS.md",
      "guides/tune.md",
      "src/README.md",
      "src/docs/guide.adoc",
    ])
      expect(scope.allows(path), path).toBe(false);
    expect(scope.describe()).toContain("text documents under get-started/ (.docsfab.json)");
    for (const root of ["src", "packages", ".hidden", "node_modules/x"])
      expect(() => new DocumentationScope([], [root]), root).toThrow();
  });

  it("finds supported text documents outside every recognized documentation directory", async () => {
    const { repositoryPath } = await rootLayoutRepository({
      "manual/guide.adoc": "= Guide\n",
      "manual/topic.dita": '<topic id="topic"/>\n',
      "manual/generic.xml": '<topic id="xml"/>\n',
      "Release Notes/install.md": "Install.\n",
      "it’s safe/guide.md": "Guide.\n",
      "writer's notes/guide.md": "Guide.\n",
    });
    const layout = await new DocumentationScope().inspectLayout(repositoryPath);
    expect(layout).toEqual({
      directories: [],
      ungranted: [
        { directory: "Release Notes", pages: 1, grantable: true },
        { directory: "get-started", pages: 2, grantable: true },
        { directory: "guides", pages: 1, grantable: true },
        { directory: "it’s safe", pages: 1, grantable: true },
        { directory: "manual", pages: 3, grantable: true },
        { directory: "src", pages: 1, grantable: false },
        { directory: "writer's notes", pages: 1, grantable: true },
      ],
      rootPages: 1,
    });
    const notice = documentationLayoutNotice(layout)!;
    expect(notice).toContain("found no recognized documentation directory");
    expect(notice).toContain(
      "Release Notes/ (1 document), get-started/ (2 documents), guides/ (1 document), it\\u{2019}s safe/ (1 document), manual/ (3 documents), src/ (1 document), writer\\u{27}s notes/ (1 document)",
    );
    expect(notice).toContain("Recommended: keep documentation under docs/");
    expect(notice).toContain(
      `"documentationRoots": ["Release Notes", "get-started", "guides", "it’s safe", "manual", "writer's notes"]`,
    );
    expect(notice).toContain(
      `docsfab live-agent --docs-dir 'Release Notes' --docs-dir get-started --docs-dir guides --docs-dir 'it’s safe' --docs-dir manual --docs-dir 'writer'"'"'s notes'.`,
    );
    expect(notice).toContain("unfamiliar suffixes; syntax or semantic validation is reported only");
    expect(notice).toContain("Pages at the repository root cannot be granted");
    // A granted directory is a recognized layout: no notice.
    const granted = await new DocumentationScope(["get-started"]).inspectLayout(repositoryPath);
    expect(granted.directories).toEqual(["get-started"]);
    expect(documentationLayoutNotice(granted)).toBeUndefined();
  });

  it("grants Unicode and spaced page directories only after terminal session confirmation", () => {
    const scope = new DocumentationScope();
    expect(DocumentationScope.grantableRoot("manual/Release Notes")).toBe("manual/Release Notes/");
    expect(scope.allows("manual/Release Notes/install.md")).toBe(false);
    scope.grantForSession("manual/Release Notes");
    expect(scope.allows("manual/Release Notes/install.md")).toBe(true);
    expect(scope.allows("manual/Release Notes/tool.ts")).toBe(false);
    expect(scope.allows("manual/Release Notes/AGENTS.md")).toBe(false);
    expect(() => scope.grantForSession("src")).toThrow(/documentation paths only/u);
  });

  it("stays quiet for a repository with a docs directory and escapes repository-named directories", async () => {
    const { repositoryPath } = await rootLayoutRepository({ "docs/index.md": "Docs.\n" });
    expect(
      documentationLayoutNotice(await new DocumentationScope().inspectLayout(repositoryPath)),
    ).toBeUndefined();
    const hostile = await rootLayoutRepository({ "pages\u001b[31m/a.md": "A.\n" });
    const notice = documentationLayoutNotice(
      await new DocumentationScope().inspectLayout(hostile.repositoryPath),
    )!;
    expect(notice).toContain("pages\\u{1b}\\u{5b}31m/ (1 document)");
    expect(notice).not.toContain("\u001b");
  });

  it("tells the operator at session start and refuses out-of-scope writes with the way to grant them", async () => {
    const { root, repositoryPath } = await rootLayoutRepository();
    const notices: string[] = [];
    const host = await assembleLiveAgentHost({
      repositoryPath,
      allowWrite: true,
      environment: { PATH: process.env.PATH },
      config: {
        projectRoot: runtimeRoot,
        stateDirectory: join(root, "state"),
        model: { provider: "none", model: "none" },
      } as unknown as DocsFabConfig,
      capabilities: await installedLiveAgentCapabilities([]),
      sourcePorts: {} as never,
      onNotice: (message) => notices.push(message),
      writeError: () => undefined,
      runWorkflow: vi.fn() as never,
    });
    await selectWritingSkill(host);
    host.terminalOptions.setPublicationConfirmation?.(async () => true);
    expect(host.scopeNotices).toHaveLength(1);
    expect(host.scopeNotices[0]).toContain("--docs-dir get-started --docs-dir guides");
    expect(host.systemPrompt).toContain(
      "Before you plan or start a change, check each target path",
    );
    expect(host.systemPrompt).toContain("found no recognized documentation directory");
    const tools = host.customTools as unknown as Tool[];
    const write = tools.find((tool) => tool.name === "write")!;
    const bash = tools.find((tool) => tool.name === "bash")!;
    const target = "get-started/choose-deployment-path.mdx";
    const refusal = write.execute("write", { path: target, content: "x\n" }, undefined, undefined, {
      cwd: repositoryPath,
    } as never);
    await expect(refusal).rejects.toThrow(
      "DocsFab denied the requested tool path. It is outside this session's documentation scope",
    );
    await expect(refusal).rejects.toThrow("call docsfab_request_documentation_directory");
    const command = await bash.execute(
      "bash",
      { command: `printf 'x\\n' > ${target}`, timeout: 60 },
      undefined,
      undefined,
      {} as never,
    );
    expect(command.details).toMatchObject({ status: "failed" });
    expect(outputOf(command)).toMatch(SANDBOX_DENIED);
    expect(outputOf(command)).toContain("DocsFab note: commands can write only inside");
    expect(outputOf(command)).toContain("call docsfab_request_documentation_directory");
    // A failure that is not a refused write carries no scope note.
    const other = await bash.execute(
      "bash",
      { command: "exit 3", timeout: 60 },
      undefined,
      undefined,
      {} as never,
    );
    expect(outputOf(other)).not.toContain("DocsFab note");
    expect(await readFile(join(repositoryPath, target), "utf8")).toBe("Choose a path.\n");
  });

  it("applies tracked documentationRoots to direct edits and commands, pages only", async () => {
    const { root, repositoryPath } = await rootLayoutRepository({
      ".docsfab.json": `${JSON.stringify({ ...PROJECT_CONFIG, documentationRoots: ["get-started", "src"] })}\n`,
    });
    const host = await assembleLiveAgentHost({
      repositoryPath,
      allowWrite: true,
      environment: { PATH: process.env.PATH },
      config: {
        projectRoot: runtimeRoot,
        stateDirectory: join(root, "state"),
        model: { provider: "none", model: "none" },
      } as unknown as DocsFabConfig,
      capabilities: await installedLiveAgentCapabilities([]),
      sourcePorts: {} as never,
      onNotice: () => undefined,
      writeError: () => undefined,
      runWorkflow: vi.fn() as never,
    });
    await selectWritingSkill(host);
    host.terminalOptions.setPublicationConfirmation?.(async () => true);
    // src/ is a code directory a local run never widens to; the operator is told it was dropped.
    expect(host.scopeNotices).toEqual([
      'documentationRoots entries in .docsfab.json that grant no write root: "src" (a code directory).',
    ]);
    expect(host.systemPrompt).toContain("text documents under get-started/ (.docsfab.json)");
    const tools = host.customTools as unknown as Tool[];
    const write = tools.find((tool) => tool.name === "write")!;
    const bash = tools.find((tool) => tool.name === "bash")!;
    const invoke = (path: string) =>
      write.execute("write", { path, content: "Agent.\n" }, undefined, undefined, {} as never);
    await invoke("get-started/new-page.mdx");
    await expect(invoke("get-started/card.jsx")).rejects.toThrow(
      "outside this session's documentation scope",
    );
    await expect(invoke("guides/tune.md")).rejects.toThrow(
      "outside this session's documentation scope",
    );
    const command = await bash.execute(
      "bash",
      { command: "printf 'Edited.\\n' > get-started/install.mdx", timeout: 60 },
      undefined,
      undefined,
      {} as never,
    );
    expect(command.details).toMatchObject({ status: "succeeded" });
    expect(await readFile(join(repositoryPath, "get-started", "install.mdx"), "utf8")).toBe(
      "Edited.\n",
    );
    expect(await readFile(join(repositoryPath, "get-started", "new-page.mdx"), "utf8")).toBe(
      "Agent.\n",
    );
  });

  it("applies tracked configured text-document roots to direct edits without changing sibling files", async () => {
    const { root, repositoryPath } = await rootLayoutRepository({
      "manual/guide.adoc": "= Guide\n\ninclude::shared.adoc[]\n",
      "manual/shared.adoc": "== Shared\n",
      "manual/guide.dat": '<topic id="x">\n',
      "manual/guide.md": "# Guide\n",
      "manual/guide.mdx": "# Guide\n",
      "manual/guide.rst": "Guide\n=====\n",
      "manual/guide.asciidoc": "= Guide\n",
      "manual/topic.dita": '<topic id="topic"/>\n',
      "manual/map.ditamap": "<map/>\n",
      "manual/generic.xml": '<topic id="xml"/>\n',
      "manual/tool.sh": "#!/bin/sh\n",
      "src/docs/guide.adoc": "Source stays read-only.\n",
      ".docsfab.json": `${JSON.stringify({
        ...PROJECT_CONFIG,
        documentationRoots: ["manual"],
      })}\n`,
    });
    const host = await assembleLiveAgentHost({
      repositoryPath,
      allowWrite: true,
      environment: { PATH: process.env.PATH },
      config: {
        projectRoot: runtimeRoot,
        stateDirectory: join(root, "state"),
        model: { provider: "none", model: "none" },
      } as unknown as DocsFabConfig,
      capabilities: await installedLiveAgentCapabilities([]),
      sourcePorts: {} as never,
      onNotice: () => undefined,
      writeError: () => undefined,
      runWorkflow: vi.fn() as never,
    });
    await selectWritingSkill(host);
    const tools = host.customTools as unknown as Tool[];
    const write = tools.find((tool) => tool.name === "write")!;
    const invoke = (path: string, content: string) =>
      write.execute("write", { path, content }, undefined, undefined, {} as never);

    expect(host.systemPrompt).toContain("text documents under manual/");
    expect(host.systemPrompt).toContain("does not certify format syntax or semantic validity");
    await invoke("manual/guide.adoc", "= Updated\n\ninclude::shared.adoc[]\n");
    await invoke("manual/guide.dat", '<topic id="x">Updated</topic>\n');
    for (const path of [
      "manual/guide.md",
      "manual/guide.mdx",
      "manual/guide.rst",
      "manual/guide.asciidoc",
      "manual/topic.dita",
      "manual/map.ditamap",
      "manual/generic.xml",
    ]) {
      await invoke(path, `Updated ${path}\n`);
      expect(await readFile(join(repositoryPath, path), "utf8")).toBe(`Updated ${path}\n`);
    }
    await expect(invoke("manual/tool.sh", "changed\n")).rejects.toThrow(
      "outside this session's documentation scope",
    );
    await expect(invoke("src/docs/guide.adoc", "changed\n")).rejects.toThrow(
      "outside this session's documentation scope",
    );
    expect(await readFile(join(repositoryPath, "manual", "guide.adoc"), "utf8")).toContain(
      "include::shared.adoc[]",
    );
    expect(await readFile(join(repositoryPath, "manual", "shared.adoc"), "utf8")).toBe(
      "== Shared\n",
    );
    expect(await readFile(join(repositoryPath, "manual", "guide.dat"), "utf8")).toContain(
      "Updated",
    );
    expect(await readFile(join(repositoryPath, "manual", "tool.sh"), "utf8")).toBe("#!/bin/sh\n");
    expect(await readFile(join(repositoryPath, "src", "docs", "guide.adoc"), "utf8")).toBe(
      "Source stays read-only.\n",
    );
  });

  it("mounts only configured-root document leaves while preserving default documentation trees", async () => {
    const { repositoryPath } = await rootLayoutRepository({
      "docs/default.md": "Default documentation remains a tree grant.\n",
      "docs/guide.md": "Task target.\n",
      "docs/sibling.md": "Outside the task target.\n",
      "manual/guide.adoc": "= Guide\n",
      "manual/nested/reference.xml": "<topic/>\n",
      "manual/tool.sh": "#!/bin/sh\n",
      "manual/.private/notes.adoc": "Private.\n",
      "manual/AGENTS.md": "Instructions.\n",
      "src/docs/source.adoc": "Source documentation stays read-only.\n",
      ".docsfab.json": `${JSON.stringify({
        ...PROJECT_CONFIG,
        documentationRoots: ["manual"],
      })}\n`,
    });
    const sandbox = await documentationCommandSandbox(
      repositoryPath,
      new DocumentationScope([], ["manual"]),
      process.env,
      {
        runExec: async (file, args, options) =>
          file === "git" ? execFileAsync(file, [...args], options) : { stdout: "" },
      },
    );
    try {
      await sandbox.restoreGitState();
      if (process.platform === "linux")
        expect(
          sandbox.args.some(
            (arg, index) =>
              arg === "--bind" && sandbox.args[index + 1] === join(repositoryPath, "docs"),
          ),
        ).toBe(true);
      const grants = writableGrants(sandbox.args);
      expect(grants).toContain(join(repositoryPath, "docs"));
      expect(grants).not.toContain(join(repositoryPath, "src", "docs"));
      for (const path of [
        join(repositoryPath, "manual"),
        join(repositoryPath, "manual", "tool.sh"),
        join(repositoryPath, "manual", ".private", "notes.adoc"),
        join(repositoryPath, "manual", "AGENTS.md"),
      ])
        expect(grants, path).not.toContain(path);
      expect(grants).toContain(join(repositoryPath, "manual", "guide.adoc"));
      expect(grants).toContain(join(repositoryPath, "manual", "nested", "reference.xml"));
      expect(await new DocumentationScope(["manual"]).writablePaths(repositoryPath)).toContain(
        join(repositoryPath, "manual"),
      );
    } finally {
      await sandbox.cleanup();
    }

    const taskScope = narrowTaskDocumentationScope(
      new DocumentationScope([], ["docs"]),
      ["docs/guide.md"],
      [],
      ["docs/guide.md"],
    );
    const taskSandbox = await documentationCommandSandbox(repositoryPath, taskScope, process.env, {
      runExec: async (file, args, options) =>
        file === "git" ? execFileAsync(file, [...args], options) : { stdout: "" },
    });
    try {
      await taskSandbox.restoreGitState();
      const taskGrants = writableGrants(taskSandbox.args);
      expect(taskGrants).toContain(join(repositoryPath, "docs", "guide.md"));
      expect(taskGrants).not.toContain(join(repositoryPath, "docs"));
      expect(taskGrants).not.toContain(join(repositoryPath, "docs", "sibling.md"));
      expect(taskGrants).not.toContain(join(repositoryPath, "src", "docs"));
      expect(taskGrants).not.toContain(join(repositoryPath, "src", "docs", "source.adoc"));
    } finally {
      await taskSandbox.cleanup();
    }
  });

  it("does not mount source directories selected with --docs-dir", async () => {
    expect(() => new DocumentationScope(["src"])).toThrow(/source code/u);
  });
});

describe("live-agent file roots from documentationRoots", { timeout: HOST_CASE_MS }, () => {
  it("applies a tracked file entry to direct edits as that file alone", async () => {
    const { root, repositoryPath } = await rootLayoutRepository({
      "guides/setup.md": "Setup.\n",
      ".docsfab.json": `${JSON.stringify({
        ...PROJECT_CONFIG,
        documentationRoots: ["get-started", "guides/setup.md", "AGENTS.md", "src/README.md"],
      })}\n`,
    });
    const host = await assembleLiveAgentHost({
      repositoryPath,
      allowWrite: true,
      environment: { PATH: process.env.PATH },
      config: {
        projectRoot: runtimeRoot,
        stateDirectory: join(root, "state"),
        model: { provider: "none", model: "none" },
      } as unknown as DocsFabConfig,
      capabilities: await installedLiveAgentCapabilities([]),
      sourcePorts: {} as never,
      onNotice: () => undefined,
      writeError: () => undefined,
      runWorkflow: vi.fn() as never,
    });
    await selectWritingSkill(host);
    // A listed agent instruction or source file stays refused, and says why.
    expect(host.scopeNotices).toEqual([
      'documentationRoots entries in .docsfab.json that grant no write root: "AGENTS.md" (a hidden, third-party, source, CI, or agent instruction file), "src/README.md" (a hidden, third-party, source, CI, or agent instruction file).',
    ]);
    expect(host.systemPrompt).toContain("guides/setup.md (.docsfab.json, UTF-8 text editing)");
    const tools = host.customTools as unknown as Tool[];
    const write = tools.find((tool) => tool.name === "write")!;
    const invoke = (path: string) =>
      write.execute("write", { path, content: "Agent.\n" }, undefined, undefined, {} as never);
    await invoke("guides/setup.md");
    expect(await readFile(join(repositoryPath, "guides", "setup.md"), "utf8")).toBe("Agent.\n");
    for (const path of ["guides/tune.md", "guides/setup.md.md", "guides/Setup.md", "AGENTS.md"]) {
      await expect(invoke(path), path).rejects.toThrow(
        "outside this session's documentation scope",
      );
    }
  });

  it("applies a tracked exact AsciiDoc file as that file alone", async () => {
    const { root, repositoryPath } = await rootLayoutRepository({
      "manual/guide.adoc": "= Guide\n",
      "manual/other.adoc": "= Sibling\n",
      ".docsfab.json": `${JSON.stringify({
        ...PROJECT_CONFIG,
        documentationRoots: ["manual/guide.adoc"],
      })}\n`,
    });
    const host = await assembleLiveAgentHost({
      repositoryPath,
      allowWrite: true,
      environment: { PATH: process.env.PATH },
      config: {
        projectRoot: runtimeRoot,
        stateDirectory: join(root, "state"),
        model: { provider: "none", model: "none" },
      } as unknown as DocsFabConfig,
      capabilities: await installedLiveAgentCapabilities([]),
      sourcePorts: {} as never,
      onNotice: () => undefined,
      writeError: () => undefined,
      runWorkflow: vi.fn() as never,
    });
    await selectWritingSkill(host);
    const write = (host.customTools as unknown as Tool[]).find((tool) => tool.name === "write")!;
    await write.execute(
      "write",
      { path: "manual/guide.adoc", content: "= Changed\n" },
      undefined,
      undefined,
      {} as never,
    );
    await expect(
      write.execute(
        "write",
        { path: "manual/other.adoc", content: "= Forbidden\n" },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow("outside this session's documentation scope");
    expect(await readFile(join(repositoryPath, "manual", "guide.adoc"), "utf8")).toBe(
      "= Changed\n",
    );
    expect(await readFile(join(repositoryPath, "manual", "other.adoc"), "utf8")).toBe(
      "= Sibling\n",
    );
  });

  it("applies a bounded task's exact tracked AsciiDoc grant to that requested path only", async () => {
    const { root, repositoryPath } = await rootLayoutRepository({
      "manual/guide.adoc": "= Guide\n",
      "manual/other.adoc": "= Sibling\n",
      ".docsfab.json": `${JSON.stringify({
        ...PROJECT_CONFIG,
        documentationRoots: ["manual"],
      })}\n`,
    });
    const host = await assembleLiveAgentHost({
      repositoryPath,
      allowWrite: true,
      taskRequestedPaths: ["manual/guide.adoc"],
      taskGrantedFiles: ["manual/guide.adoc"],
      environment: { PATH: process.env.PATH },
      config: {
        projectRoot: runtimeRoot,
        stateDirectory: join(root, "state"),
        model: { provider: "none", model: "none" },
      } as unknown as DocsFabConfig,
      capabilities: await installedLiveAgentCapabilities([]),
      sourcePorts: {} as never,
      onNotice: () => undefined,
      writeError: () => undefined,
      runWorkflow: vi.fn() as never,
    });
    await selectWritingSkill(host);
    const write = (host.customTools as unknown as Tool[]).find((tool) => tool.name === "write")!;
    const invoke = (path: string) =>
      write.execute("write", { path, content: "= Task edit\n" }, undefined, undefined, {} as never);
    await invoke("manual/guide.adoc");
    for (const path of ["manual/other.adoc", "manual/guide.adoc/child", "src/docs/guide.adoc"]) {
      await expect(invoke(path), path).rejects.toThrow(
        "outside this session's documentation scope",
      );
    }
    expect(await readFile(join(repositoryPath, "manual", "guide.adoc"), "utf8")).toBe(
      "= Task edit\n",
    );
    expect(await readFile(join(repositoryPath, "manual", "other.adoc"), "utf8")).toBe(
      "= Sibling\n",
    );
  });
});

/** The write-enabled live host for a layout fixture, with scripted terminal answers. */
async function grantHost(root: string, repositoryPath: string, answers: boolean[]) {
  const confirm = vi.fn(async (_message: unknown) => answers.shift() ?? false);
  const host = await assembleLiveAgentHost({
    repositoryPath,
    allowWrite: true,
    environment: { PATH: process.env.PATH },
    config: {
      projectRoot: runtimeRoot,
      stateDirectory: join(root, "state"),
      model: { provider: "none", model: "none" },
    } as unknown as DocsFabConfig,
    capabilities: await installedLiveAgentCapabilities([]),
    sourcePorts: {} as never,
    onNotice: () => undefined,
    writeError: () => undefined,
    runWorkflow: vi.fn() as never,
  });
  await selectWritingSkill(host);
  host.terminalOptions.setPublicationConfirmation?.(confirm);
  const tools = host.customTools as unknown as Tool[];
  const find = (name: string) => tools.find((tool) => tool.name === name)!;
  return {
    host,
    confirm,
    grant: (directory: string) =>
      find("docsfab_request_documentation_directory").execute(
        "grant",
        { directory },
        undefined,
        undefined,
        {} as never,
      ),
    write: (path: string) =>
      find("write").execute(
        "write",
        { path, content: "Agent.\n" },
        undefined,
        undefined,
        {} as never,
      ),
  };
}

const configOf = async (repositoryPath: string) =>
  JSON.parse(await readFile(join(repositoryPath, ".docsfab.json"), "utf8")) as Record<
    string,
    unknown
  >;

describe("live-agent documentation directory grants", { timeout: HOST_CASE_MS }, () => {
  it("writes pages under confirmed Unicode and spaced roots without granting adjacent files", async () => {
    const { root, repositoryPath } = await rootLayoutRepository({
      "manual/Release Notes/install.md": "Install.\n",
      "manual/überblick/page.mdx": "Overview.\n",
    });
    const live = await grantHost(root, repositoryPath, [true, true]);
    await expect(live.write("manual/Release Notes/new.md")).rejects.toThrow(
      "outside this session's documentation scope",
    );
    expect((await live.grant("manual/Release Notes")).details).toEqual({ status: "granted" });
    await live.write("manual/Release Notes/new.md");
    expect(await readFile(join(repositoryPath, "manual/Release Notes/new.md"), "utf8")).toBe(
      "Agent.\n",
    );
    expect((await live.grant("manual/überblick")).details).toEqual({ status: "granted" });
    await live.write("manual/überblick/new.mdx");
    expect(await readFile(join(repositoryPath, "manual/überblick/new.mdx"), "utf8")).toBe(
      "Agent.\n",
    );
    for (const path of [
      "manual/Release Notes/tool.ts",
      "manual/Release Notes/AGENTS.md",
      "manual/Release Notes/.hidden.md",
      "manual/Release Notes/node_modules/pkg.md",
      "src/README.md",
      ".gitlab/ci/guide.md",
    ])
      await expect(live.write(path), path).rejects.toThrow(
        "outside this session's documentation scope",
      );
    expect(live.confirm).toHaveBeenCalledTimes(2);
  });

  it("grants pages only after the terminal answer and saves the root on a second yes", async () => {
    const { root, repositoryPath } = await rootLayoutRepository({
      ".docsfab.json": `${JSON.stringify(PROJECT_CONFIG)}\n`,
    });
    const live = await grantHost(root, repositoryPath, [true, true]);
    expect(live.host.tools).toContain("docsfab_request_documentation_directory");
    expect(live.host.systemPrompt).toContain(
      "call docsfab_request_documentation_directory with the page's directory before any other work",
    );
    await expect(live.write("get-started/new.mdx")).rejects.toThrow(
      "outside this session's documentation scope",
    );
    const result = await live.grant("get-started");
    expect(result.details).toEqual({ status: "saved" });
    expect(live.confirm.mock.calls.map(([message]) => message)).toEqual([
      "Allow DocsFab to edit Markdown and MDX pages under get-started/ for this session? Other files there stay read-only. [y/N] ",
      "Also add get-started to documentationRoots in .docsfab.json (new list: docs, fern, get-started), so later live-agent sessions and local workflow runs can edit it once you commit the file? [y/N] ",
    ]);
    await live.write("get-started/new.mdx");
    expect(await readFile(join(repositoryPath, "get-started", "new.mdx"), "utf8")).toBe("Agent.\n");
    await expect(live.write("get-started/card.jsx")).rejects.toThrow(
      "outside this session's documentation scope",
    );
    // The workflow defaults are kept, so declaring the key does not narrow workflow runs.
    expect(await configOf(repositoryPath)).toEqual({
      ...PROJECT_CONFIG,
      documentationRoots: ["docs", "fern", "get-started"],
    });
    expect((await live.grant("get-started")).details).toEqual({ status: "already-granted" });
    expect(live.confirm).toHaveBeenCalledTimes(2);
    // The save is a checkout change: it lands on a task branch, never on main.
    expect(await git(repositoryPath, ["branch", "--show-current"])).not.toBe("main");
    // A refusal names the scope as it is now, including the session grant.
    await expect(live.write("guides/new.md")).rejects.toThrow(
      "Markdown and MDX pages under get-started/ (granted this session)",
    );
  });

  it("escapes repository roots in the save prompt and refuses a linked configuration", async () => {
    const hostileRoots = ["docs", "a\u009b2J", "b\u202ec"];
    const { root, repositoryPath } = await rootLayoutRepository({
      ".docsfab.json": `${JSON.stringify({ ...PROJECT_CONFIG, documentationRoots: hostileRoots })}\n`,
    });
    const live = await grantHost(root, repositoryPath, [true, false]);
    expect((await live.grant("get-started")).details).toEqual({ status: "granted" });
    const prompt = String(live.confirm.mock.calls[1]![0]);
    expect(prompt).toContain("new list: docs, a\\u{9b}2J, b\\u{202e}c, get-started");
    expect(prompt).not.toMatch(/[\u009b\u202e]/u);
    // A hard-linked configuration is never written through.
    const linked = await rootLayoutRepository({
      ".docsfab.json": `${JSON.stringify(PROJECT_CONFIG)}\n`,
    });
    await link(join(linked.repositoryPath, ".docsfab.json"), join(linked.root, "outside.json"));
    const before = await readFile(join(linked.root, "outside.json"), "utf8");
    const refused = await grantHost(linked.root, linked.repositoryPath, [true, true]);
    const result = await refused.grant("get-started");
    expect(result.details).toEqual({ status: "granted" });
    expect(result.content[0].text).toContain("not a regular file");
    expect(refused.confirm).toHaveBeenCalledTimes(1);
    expect(await readFile(join(linked.root, "outside.json"), "utf8")).toBe(before);
  });

  it("keeps the page read-only and the configuration unchanged when the user declines", async () => {
    const { root, repositoryPath } = await rootLayoutRepository({
      ".docsfab.json": `${JSON.stringify(PROJECT_CONFIG)}\n`,
    });
    const before = await configOf(repositoryPath);
    const live = await grantHost(root, repositoryPath, [false]);
    expect((await live.grant("get-started")).details).toEqual({ status: "declined" });
    await expect(live.write("get-started/new.mdx")).rejects.toThrow(
      "outside this session's documentation scope",
    );
    expect(await configOf(repositoryPath)).toEqual(before);
    // A session grant without saving leaves the file alone too.
    const once = await grantHost(root, repositoryPath, [true, false]);
    expect((await once.grant("guides")).details).toEqual({ status: "granted" });
    await once.write("guides/new.md");
    expect(await configOf(repositoryPath)).toEqual(before);
  });

  it("refuses code, hidden, and escaping directories before asking", async () => {
    const { root, repositoryPath } = await rootLayoutRepository();
    const live = await grantHost(root, repositoryPath, [true, true]);
    for (const directory of [
      "src",
      ".github",
      "../outside",
      "/tmp",
      "",
      "packages",
      "node_modules/x",
    ])
      await expect(live.grant(directory), directory).rejects.toThrow();
    expect(live.confirm).not.toHaveBeenCalled();
  });

  it("grants for the session only when the repository has no project configuration", async () => {
    const { root, repositoryPath } = await rootLayoutRepository();
    const live = await grantHost(root, repositoryPath, [true, true]);
    const result = await live.grant("get-started/");
    expect(result.details).toEqual({ status: "granted" });
    expect(result.content[0].text).toContain("docsfab init");
    expect(live.confirm).toHaveBeenCalledTimes(1);
    await live.write("get-started/new.mdx");
    await expect(stat(join(repositoryPath, ".docsfab.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
