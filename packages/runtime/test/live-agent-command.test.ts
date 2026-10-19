// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { link, mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DocsFabConfig } from "../src/config/runtime-loader.js";
import { TASK_BRANCH_FAILURES } from "../src/live-agent/branch-preparation.js";
import { limit } from "../src/config/limits.js";
import {
  COMMAND_OUTPUT_LIMIT,
  createLiveCommandTool,
  LIVE_COMMAND_FAILURES,
} from "../src/live-agent/command-tool.js";
import { DOCUMENTATION_SCOPE_FAILURE } from "../src/live-agent/documentation-scope.js";
import { createConfinedToolSet } from "../src/harness/confined-tools.js";
import { verifyCatalogSkill } from "../src/skills/catalog-crate.js";
import type { CommandApproval } from "../src/live-agent/command-approval.js";
import { temporaryRoots } from "./helpers/temp.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";
import { git, initFixtureRepo } from "./helpers/git.js";
import { configureCredential } from "./helpers/configured-credential.js";

const roots = temporaryRoots();
function fixture(): Promise<string> {
  return roots.create("docsfab-live-command-");
}

function invoke(
  tool: ReturnType<typeof createLiveCommandTool>,
  command: string,
  signal?: AbortSignal,
  timeout?: number,
) {
  return tool.execute(
    "call",
    { command, ...(timeout === undefined ? {} : { timeout }) },
    signal,
    undefined,
    {} as never,
  );
}

describe("live-agent current checkout commands", () => {
  it("edits current manual work, commits selected files, and pushes to a local remote without a workflow record", async () => {
    const root = await fixture();
    const remote = join(root, ".git", "fixture-remote.git");
    await initFixtureRepo(root, { "guide.md": "Original\n" }, { branch: "main" });
    // The command under test runs Git with the ambient environment; keep host hooks out.
    await git(root, ["config", "core.hooksPath", "/dev/null"]);
    await git(root, ["init", "--bare", remote]);
    await git(root, ["remote", "add", "origin", remote]);
    await writeFile(join(root, "guide.md"), "Manual revision\n");
    await writeFile(join(root, "unrelated.txt"), "Preserve this\n");
    await git(root, ["add", "unrelated.txt"]);
    const files = await createConfinedToolSet({ workspacePath: root, allowWrite: true });
    await files.definitions
      .find((tool) => tool.name === "edit")!
      .execute(
        "edit",
        {
          path: "guide.md",
          edits: [{ oldText: "Manual revision", newText: "Manual revision plus agent edit" }],
        },
        undefined,
        undefined,
        {} as never,
      );
    const confirm = vi.fn(async (_request: CommandApproval) => true);
    const tool = createLiveCommandTool({ repositoryPath: root, allowWrite: true, confirm });
    expect(
      (
        await invoke(
          tool,
          "git diff --check && git switch -c docs/current-work && git commit --only -m 'docs: update guide' -- guide.md && git push origin HEAD:refs/heads/docs/current-work",
        )
      ).details,
    ).toMatchObject({ status: "succeeded", exitCode: 0 });
    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm.mock.calls[0]?.[0]).toMatchObject({
      kind: "command",
      command: expect.stringContaining("git switch -c docs/current-work"),
    });
    expect(
      await git(root, ["--git-dir", remote, "show", "docs/current-work:guide.md"], { trim: false }),
    ).toBe("Manual revision plus agent edit\n");
    expect(await git(root, ["diff", "--cached", "--name-only"])).toBe("unrelated.txt");
    expect(await readFile(join(root, "unrelated.txt"), "utf8")).toBe("Preserve this\n");
  });

  it("declines commands without modifying files and refuses commands in read-only mode", async () => {
    const root = await fixture();
    const confirm = vi.fn(async () => false);
    const tool = createLiveCommandTool({ repositoryPath: root, allowWrite: true, confirm });
    expect((await invoke(tool, "touch declined")).details).toMatchObject({ status: "cancelled" });
    await expect(readFile(join(root, "declined"))).rejects.toThrow();
    await expect(
      invoke(
        createLiveCommandTool({ repositoryPath: root, allowWrite: false, confirm }),
        "touch denied",
      ),
    ).rejects.toThrow(LIVE_COMMAND_FAILURES.readonly);
    expect(confirm).toHaveBeenCalledOnce();
  });

  it("withholds a configured credential in output from stdout and stderr", async () => {
    configureCredential(["glpat", "abcdefghijklmnopqrst"].join("-"));
    const root = await fixture();
    // Assemble at execution time so the request itself contains no token.
    const tool = createLiveCommandTool({
      repositoryPath: root,
      allowWrite: true,
      confirm: async () => true,
    });
    for (const suffix of ["", " >&2"]) {
      await expect(
        invoke(tool, `printf '%s%s' 'glpat-' 'abcdefghijklmnopqrst'${suffix}`),
      ).rejects.toThrow(LIVE_COMMAND_FAILURES.credentials);
    }
    await expect(invoke(tool, "echo glpat-abcdefghijklmnopqrst")).rejects.toThrow(
      LIVE_COMMAND_FAILURES.credentials,
    );
  });

  it("does not inherit model keys or shell startup hooks, but retains local CLI configuration paths", async () => {
    const root = await fixture();
    const tool = createLiveCommandTool({
      repositoryPath: root,
      allowWrite: true,
      confirm: async () => true,
      environment: {
        PATH: process.env.PATH,
        HOME: root,
        GH_CONFIG_DIR: root,
        MODEL_API_KEY: "private-fixture",
        BASH_ENV: "/missing-startup",
        npm_config_cache: join(root, "unapproved-cache"),
      },
    });
    const result = await invoke(
      tool,
      'test -z "$MODEL_API_KEY" && test -z "$BASH_ENV" && test "$GH_CONFIG_DIR" = "$HOME" && test "$npm_config_cache" = "$TMPDIR/npm-cache"',
    );
    expect(result.details).toMatchObject({ status: "succeeded", exitCode: 0 });
  });

  it("runs npm cache work in private scratch while keeping home and repository caches read-only", async () => {
    const root = await fixture();
    const scratchRoot = await fixture();
    const confirm = vi.fn(async () => true);
    const tool = createLiveCommandTool({
      repositoryPath: root,
      allowWrite: true,
      confirm,
      environment: { PATH: process.env.PATH, HOME: root },
    });
    // Offline npm operation reproduces Fern's required cache writes without
    // downloading a CLI, using a real home directory, or touching global state.
    const result = await withTemporaryDirectory(scratchRoot, () =>
      invoke(
        tool,
        [
          "set -e -o pipefail",
          'test "$npm_config_cache" = "$TMPDIR/npm-cache"',
          "npm cache verify --loglevel=error",
          'test -d "$npm_config_cache/_cacache"',
          'if mkdir "$HOME/.npm"; then exit 9; fi',
          'if mkdir "$PWD/.docsfab-private-npm-cache"; then exit 9; fi',
          'printf "CACHE=%s\\n" "$npm_config_cache"',
        ].join("\n"),
      ),
    );
    expect(result.details).toMatchObject({ status: "succeeded", exitCode: 0 });
    expect(confirm).toHaveBeenCalledOnce();
    const text = result.content.find((block) => block.type === "text")?.text ?? "";
    expect(/^CACHE=(.+)$/mu.exec(text)?.[1]).toBe("$TMPDIR/npm-cache");
    expect(await leftoverScratch(scratchRoot)).toEqual([]);
    await expect(stat(join(root, ".npm"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(root, ".docsfab-private-npm-cache"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("reports a failed dependent validation batch before a later successful command", async () => {
    const tool = createLiveCommandTool({
      repositoryPath: await fixture(),
      allowWrite: true,
      confirm: async () => true,
    });
    expect(tool.description).toContain("set -e -o pipefail");
    for (const command of [
      "set -e -o pipefail\nfalse\nprintf 'later check ran'",
      "false && printf 'later check ran'",
    ]) {
      const result = await invoke(tool, command);
      expect(result.details).toMatchObject({ status: "failed", exitCode: 1 });
      expect(result.content).toEqual([{ type: "text", text: "Command exited with code 1.\n" }]);
    }
  });

  it("returns the real exit status and screened diagnostic without a success claim", async () => {
    const tool = createLiveCommandTool({
      repositoryPath: await fixture(),
      allowWrite: true,
      confirm: async () => true,
    });
    const result = await invoke(tool, "echo 'branch already exists' >&2; exit 7");
    expect(result.details).toMatchObject({ status: "failed", exitCode: 7 });
    expect(result.content).toEqual([
      { type: "text", text: "Command exited with code 7.\nbranch already exists\n" },
    ]);
  });

  it("cancels before execution, after approval, and during a running command", async () => {
    const root = await fixture();
    const controller = new AbortController();
    const confirm = vi.fn(async () => true);
    const tool = createLiveCommandTool({ repositoryPath: root, allowWrite: true, confirm });
    controller.abort();
    expect((await invoke(tool, "touch cancelled", controller.signal)).details).toMatchObject({
      status: "cancelled",
    });
    expect(confirm).not.toHaveBeenCalled();
    const after = new AbortController();
    const second = createLiveCommandTool({
      repositoryPath: root,
      allowWrite: true,
      confirm: async () => {
        after.abort();
        return true;
      },
    });
    expect((await invoke(second, "touch cancelled", after.signal)).details).toMatchObject({
      status: "cancelled",
    });
    const running = new AbortController();
    const pending = invoke(tool, "sleep 30; touch cancelled", running.signal);
    setTimeout(() => running.abort(), 100);
    await expect(pending).rejects.toThrow(LIVE_COMMAND_FAILURES.cancelled);
    await expect(readFile(join(root, "cancelled"))).rejects.toThrow();
  });

  it("stops timeouts and excessive output without leaking a partial output buffer", async () => {
    const tool = createLiveCommandTool({
      repositoryPath: await fixture(),
      allowWrite: true,
      confirm: async () => true,
    });
    await expect(invoke(tool, "sleep 30", undefined, 1)).rejects.toThrow(
      LIVE_COMMAND_FAILURES.timeout,
    );
    await expect(invoke(tool, "yes output")).rejects.toThrow(LIVE_COMMAND_FAILURES.output);
  });
});

// Each case assembles the live host and runs Git and sandboxed commands.
const HOST_CASE_MS = testTimeoutMs(30_000);
const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SANDBOX_EXECUTABLES = new Set(["/usr/bin/sandbox-exec", "/usr/bin/bwrap"]);
const SCRATCH_PREFIX = "docsfab-doc-command-";
type Tool = { name: string; execute: (...arguments_: any[]) => Promise<any> };

/** True for the sandbox's `bash -c true` readiness probe, and nothing else. */
function isSandboxProbe(file: string, args: readonly string[]): boolean {
  return SANDBOX_EXECUTABLES.has(file) && args.at(-2) === "-c" && args.at(-1) === "true";
}

/**
 * Load the live host with a pass-through `node:child_process` so a test can
 * observe every sandbox call and spawned argv, and optionally fail only the
 * sandbox readiness probe. `execFile[util.promisify.custom]` stays intact.
 */
async function loadHost(options: { failProbe?: boolean } = {}) {
  const execCalls: { file: string; args: readonly string[] }[] = [];
  const spawnCalls: { file: string; args: readonly string[] }[] = [];
  vi.doMock("node:child_process", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:child_process")>();
    const promisified = promisify(actual.execFile);
    const execFile = Object.assign(
      (...args: unknown[]) => (actual.execFile as (...inner: unknown[]) => unknown)(...args),
      {
        [promisify.custom]: async (file: string, args: readonly string[], rest: object) => {
          execCalls.push({ file, args });
          if (options.failProbe && isSandboxProbe(file, args))
            throw Object.assign(new Error("fixture probe failure"), { code: 1 });
          return promisified(file, args, rest);
        },
      },
    );
    const spawn = ((file: string, args: readonly string[], rest: object) => {
      spawnCalls.push({ file, args });
      return actual.spawn(file, args, rest);
    }) as typeof actual.spawn;
    return { ...actual, default: { ...actual, execFile, spawn }, execFile, spawn };
  });
  vi.resetModules();
  const module = await import("../src/live-agent/host.js");
  return { assembleLiveAgentHost: module.assembleLiveAgentHost, execCalls, spawnCalls };
}

afterEach(() => {
  vi.doUnmock("node:child_process");
  vi.resetModules();
});

async function liveBash(
  loaded: Awaited<ReturnType<typeof loadHost>>,
  repositoryPath: string,
  stateRoot: string,
) {
  const confirm = vi.fn(async () => true);
  const verifiedSkill = await verifyCatalogSkill({
    skillCrateDirectory: resolve("skill-crate"),
    skillId: "write-documentation",
    grantedTools: ["read", "grep", "find", "ls", "edit", "write"],
  });
  const host = await loaded.assembleLiveAgentHost({
    repositoryPath,
    allowWrite: true,
    environment: { PATH: process.env.PATH },
    config: {
      projectRoot: runtimeRoot,
      stateDirectory: join(stateRoot, "state"),
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
  host.terminalOptions.onUserTurn?.("Run an approved documentation maintenance command.");
  const useSkill = host.customTools.find((tool) => tool.name === "docsfab_use_skill")!;
  await useSkill.execute(
    "use-skill",
    { skill: "write-documentation" },
    undefined,
    undefined,
    {} as never,
  );
  host.terminalOptions.setPublicationConfirmation?.(confirm);
  const bash = (host.customTools as unknown as Tool[]).find((tool) => tool.name === "bash")!;
  return {
    confirm,
    run: (command: string) =>
      bash.execute("bash", { command, timeout: 60 }, undefined, undefined, {} as never),
  };
}

/** `main` with staged, added-then-modified, unstaged, and untracked work. */
async function dirtyMain() {
  const root = await fixture();
  const repositoryPath = join(root, "repo");
  await initFixtureRepo(
    repositoryPath,
    { "docs/guide.md": "Guide.\n", "docs/staged.md": "base\n", "src/app.js": "source\n" },
    { branch: "main" },
  );
  await git(repositoryPath, ["config", "core.hooksPath", "/dev/null"]);
  await writeFile(join(repositoryPath, "docs", "staged.md"), "staged\n");
  await git(repositoryPath, ["add", "docs/staged.md"]);
  await writeFile(join(repositoryPath, "docs", "added.md"), "added\n");
  await git(repositoryPath, ["add", "docs/added.md"]);
  await writeFile(join(repositoryPath, "docs", "added.md"), "added then modified\n");
  await writeFile(join(repositoryPath, "src", "app.js"), "unstaged source\n");
  await writeFile(join(repositoryPath, "docs", "untracked.md"), "untracked\n");
  const scratchRoot = join(root, "tmp");
  await mkdir(scratchRoot);
  return { root, repositoryPath, scratchRoot };
}

async function checkoutState(repositoryPath: string) {
  return {
    branch: await git(repositoryPath, ["branch", "--show-current"]),
    status: await git(repositoryPath, ["status", "--porcelain=v1", "-z"], { trim: false }),
    index: await git(repositoryPath, ["diff", "--cached", "--binary"], { trim: false }),
    source: await readFile(join(repositoryPath, "src", "app.js"), "utf8"),
    added: await readFile(join(repositoryPath, "docs", "added.md"), "utf8"),
  };
}

async function leftoverScratch(scratchRoot: string): Promise<string[]> {
  return (await readdir(scratchRoot)).filter((name) => name.startsWith(SCRATCH_PREFIX));
}

/** Run with `os.tmpdir()` pointed at the fixture so leaked sandbox scratch is observable. */
async function withTemporaryDirectory<T>(directory: string, action: () => Promise<T>): Promise<T> {
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = directory;
  try {
    return await action();
  } finally {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
  }
}

async function withPlatform<T>(platform: NodeJS.Platform, action: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...original, value: platform });
  try {
    return await action();
  } finally {
    Object.defineProperty(process, "platform", original);
  }
}

const MARKER = "printf marker > docs/marker.md";

describe("live-agent host commands when documentation isolation cannot be set up", {
  timeout: HOST_CASE_MS,
}, () => {
  it("runs a positive control through the same host, branch guard, and private scratch", async () => {
    const { root, repositoryPath, scratchRoot } = await dirtyMain();
    const loaded = await loadHost();
    const live = await liveBash(loaded, repositoryPath, root);
    const result = await withTemporaryDirectory(scratchRoot, () =>
      live.run(`${MARKER} && printf 'TMP=%s\\n' "$(basename "$TMPDIR")"`),
    );
    expect(result.details).toMatchObject({ status: "succeeded", exitCode: 0 });
    const text = result.content[0].text as string;
    expect(/^TMP=(.+)$/mu.exec(text)?.[1]?.startsWith(SCRATCH_PREFIX)).toBe(true);
    expect(await readFile(join(repositoryPath, "docs", "marker.md"), "utf8")).toBe("marker");
    expect(await git(repositoryPath, ["branch", "--show-current"])).not.toBe("main");
    expect(loaded.execCalls.filter((call) => isSandboxProbe(call.file, call.args))).toHaveLength(1);
    expect(await leftoverScratch(scratchRoot)).toEqual([]);
  });

  it.each([
    ["the other supported OS, whose sandbox binary is absent", "swap"],
    ["an unsupported OS", "aix"],
  ] as const)("fails closed before branch preparation on %s", async (_label, forcing) => {
    const { root, repositoryPath, scratchRoot } = await dirtyMain();
    const before = await checkoutState(repositoryPath);
    const loaded = await loadHost();
    const live = await liveBash(loaded, repositoryPath, root);
    const platform =
      forcing === "swap" ? (process.platform === "darwin" ? "linux" : "darwin") : forcing;
    await expect(
      withTemporaryDirectory(scratchRoot, () => withPlatform(platform, () => live.run(MARKER))),
    ).rejects.toThrow(LIVE_COMMAND_FAILURES.isolation);
    expect(live.confirm).toHaveBeenCalledOnce();
    // The missing or unknown sandbox is never executed, and no command is spawned.
    expect(loaded.execCalls.some((call) => SANDBOX_EXECUTABLES.has(call.file))).toBe(false);
    expect(loaded.spawnCalls.some((call) => call.args.includes(MARKER))).toBe(false);
    await expect(stat(join(repositoryPath, "docs", "marker.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    // Isolation is checked before the branch guard: the checkout stays on main.
    expect(await checkoutState(repositoryPath)).toEqual(before);
    expect(await leftoverScratch(scratchRoot)).toEqual([]);
  });

  it("fails closed when the installed sandbox's readiness probe fails", async () => {
    const { root, repositoryPath, scratchRoot } = await dirtyMain();
    const before = await checkoutState(repositoryPath);
    const loaded = await loadHost({ failProbe: true });
    const live = await liveBash(loaded, repositoryPath, root);
    await expect(withTemporaryDirectory(scratchRoot, () => live.run(MARKER))).rejects.toThrow(
      LIVE_COMMAND_FAILURES.isolation,
    );
    expect(loaded.execCalls.filter((call) => isSandboxProbe(call.file, call.args))).toHaveLength(1);
    expect(loaded.spawnCalls.some((call) => call.args.includes(MARKER))).toBe(false);
    await expect(stat(join(repositoryPath, "docs", "marker.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await checkoutState(repositoryPath)).toEqual(before);
    expect(await leftoverScratch(scratchRoot)).toEqual([]);
  });

  it.each([
    ["under a documentation directory", "docs/linked.md"],
    ["at a top-level documentation file", "README.md"],
  ])("fails closed on a pre-existing hard link %s", async (_label, linked) => {
    const { root, repositoryPath, scratchRoot } = await dirtyMain();
    // The sandbox would grant write access to this path; it shares bytes with source.
    await link(join(repositoryPath, "src", "app.js"), join(repositoryPath, linked));
    const before = await checkoutState(repositoryPath);
    const loaded = await loadHost();
    const live = await liveBash(loaded, repositoryPath, root);
    await expect(withTemporaryDirectory(scratchRoot, () => live.run(MARKER))).rejects.toThrow(
      DOCUMENTATION_SCOPE_FAILURE,
    );
    expect(loaded.spawnCalls.some((call) => call.args.includes(MARKER))).toBe(false);
    await expect(stat(join(repositoryPath, "docs", "marker.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await checkoutState(repositoryPath)).toEqual(before);
    expect(await leftoverScratch(scratchRoot)).toEqual([]);
  });

  it("reports a branch-guard refusal after isolation succeeded, not as isolation, and removes scratch", async () => {
    // The sandbox is ready, then the host-held mutation gate refuses.
    const root = await fixture();
    const directory = join(root, "not-git");
    const scratchRoot = join(root, "tmp");
    await mkdir(join(directory, "docs"), { recursive: true });
    await mkdir(scratchRoot);
    const loaded = await loadHost();
    const live = await liveBash(loaded, directory, root);
    const refusal = withTemporaryDirectory(scratchRoot, () => live.run(MARKER));
    await expect(refusal).rejects.toThrow(TASK_BRANCH_FAILURES.repository);
    await expect(refusal).rejects.not.toThrow(LIVE_COMMAND_FAILURES.isolation);
    expect(loaded.execCalls.filter((call) => isSandboxProbe(call.file, call.args))).toHaveLength(1);
    expect(loaded.spawnCalls.some((call) => call.args.includes(MARKER))).toBe(false);
    await expect(stat(join(directory, "docs", "marker.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await leftoverScratch(scratchRoot)).toEqual([]);
  });
});

/** Printer whose own `-c` script bytes come back as hex, independent of any spy. */
const PRINT_SELF = `printf '%s' "$BASH_EXECUTION_STRING" | od -An -tx1 -v`;

describe("live-agent approved command identity", { timeout: HOST_CASE_MS }, () => {
  it.each([
    ["leading and trailing spaces", `  ${PRINT_SELF}  `],
    ["a trailing newline", `${PRINT_SELF}\n`],
    ["a tab and shell operators", `${PRINT_SELF} #\t; && | $( ) end`],
    ["a literal backslash-n", `${PRINT_SELF} # a\\nb`],
    ["zero-width and C1 controls", `${PRINT_SELF} # \u200b \u0085 \u009b`],
    [
      "a multi-line script",
      `set -e\n${PRINT_SELF} # a;b && c | d $(printf e)\t\\n\u200b\u0085\u009b\n`,
    ],
  ])("executes exactly the approved script with %s", async (_label, command) => {
    const root = await fixture();
    const repositoryPath = join(root, "repo");
    await initFixtureRepo(repositoryPath, { "docs/guide.md": "Guide.\n" }, { branch: "topic" });
    const loaded = await loadHost();
    const live = await liveBash(loaded, repositoryPath, root);
    const result = await live.run(command);
    expect(result.details).toMatchObject({ status: "succeeded", exitCode: 0 });
    expect(live.confirm).toHaveBeenCalledOnce();
    const approved = (live.confirm.mock.calls[0] as unknown as [CommandApproval])[0];
    expect(approved.command).toBe(command);
    const spawned = loaded.spawnCalls.filter((call) => SANDBOX_EXECUTABLES.has(call.file));
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.args.slice(-2)).toEqual(["-c", approved.command]);
    // Behavioural check: bash reports the script it actually received.
    const hex = (result.content[0].text as string).split("\n").slice(1).join(" ");
    const executed = Buffer.from((hex.match(/[0-9a-f]{2}/gu) ?? []).join(""), "hex");
    expect(executed.equals(Buffer.from(approved.command, "utf8"))).toBe(true);
  });
});

/** The tool's default stdout plus stderr byte bound. */
const COMMAND_OUTPUT_BYTES = limit(COMMAND_OUTPUT_LIMIT, { environment: {} }).value;

function outputText(result: { content: readonly { type: string; text?: string }[] }): string {
  return result.content.find((block) => block.type === "text")?.text ?? "";
}

function approvedTool(repositoryPath: string, environment?: NodeJS.ProcessEnv) {
  return createLiveCommandTool({
    repositoryPath,
    allowWrite: true,
    confirm: async () => true,
    ...(environment ? { environment } : {}),
  });
}

describe("live-agent command output egress", { timeout: HOST_CASE_MS }, () => {
  it("returns pwd and a Git error naming the checkout repository-relative", async () => {
    const root = await fixture();
    const repositoryPath = join(root, "repo");
    await initFixtureRepo(repositoryPath, { "docs/guide.md": "Guide.\n" }, { branch: "main" });
    const result = await invoke(
      approvedTool(repositoryPath),
      'pwd; (cd docs && pwd); git -C "$PWD/missing" status 2>&1',
    );
    const text = outputText(result);
    expect(text.split("\n").slice(1, 3)).toEqual([".", "docs"]);
    expect(text).toContain("fatal: cannot change to 'missing'");
    for (const host of new Set([root, await realpath(root)])) expect(text).not.toContain(host);
  });

  it("returns a linked worktree and its main checkout's Git paths repository-relative", async () => {
    const root = await fixture();
    const main = join(root, "main");
    const linked = join(root, "linked");
    await initFixtureRepo(main, { "docs/guide.md": "Guide.\n" }, { branch: "main" });
    await git(main, ["worktree", "add", "-b", "topic", linked]);
    const result = await invoke(
      approvedTool(linked),
      'pwd; git rev-parse --path-format=absolute --git-dir --git-common-dir; git -C "$PWD/missing" status 2>&1',
    );
    const text = outputText(result);
    expect(text.split("\n").slice(1, 4)).toEqual([".", ".git/worktrees/linked", ".git"]);
    expect(text).toContain("fatal: cannot change to 'missing'");
    for (const host of new Set([root, await realpath(root)])) expect(text).not.toContain(host);
  });

  it("returns the command's private scratch as $TMPDIR", async () => {
    const result = await invoke(
      approvedTool(await fixture()),
      'touch "$TMPDIR/note"; printf "%s\\n" "$TMPDIR" "$npm_config_cache" "$TMPDIR"/note',
    );
    expect(outputText(result)).toBe(
      "Command exited with code 0.\n$TMPDIR\n$TMPDIR/npm-cache\n$TMPDIR/note\n",
    );
  });

  it("leaves a declared public root as written and still replaces HOME and the scratch", async () => {
    const root = await fixture();
    const repositoryPath = join(root, "repo");
    await mkdir(repositoryPath);
    const real = await realpath(repositoryPath);
    const environment = {
      PATH: process.env.PATH,
      HOME: join(root, "home"),
      TMPDIR: join(root, "host-tmp"),
    };
    const command = 'printf "%s\\n" "$PWD" "$HOME/.config" "$TMPDIR"';
    const declared = await invoke(
      approvedTool(repositoryPath, {
        ...environment,
        DOCSFAB_PUBLIC_ROOTS: [...new Set([repositoryPath, real])].join(delimiter),
      }),
      command,
    );
    expect(outputText(declared)).toBe(`Command exited with code 0.\n${real}\n~/.config\n$TMPDIR\n`);
    const undeclared = await invoke(approvedTool(repositoryPath, environment), command);
    expect(outputText(undeclared)).toBe("Command exited with code 0.\n.\n~/.config\n$TMPDIR\n");
  });

  it("refuses an invalid public-roots declaration when the tool is built, before any command", async () => {
    const repositoryPath = await fixture();
    expect(() =>
      approvedTool(repositoryPath, { PATH: process.env.PATH, DOCSFAB_PUBLIC_ROOTS: "relative" }),
    ).toThrow(/^public-roots-invalid: /u);
  });

  it("withholds configured-credential output that also names host roots, as before", async () => {
    configureCredential(["glpat", "abcdefghijklmnopqrst"].join("-"));
    const tool = approvedTool(await fixture());
    for (const suffix of ["", " >&2"]) {
      await expect(
        invoke(tool, `printf '%s %s%s\\n' "$PWD" 'glpat-' 'abcdefghijklmnopqrst'${suffix}`),
      ).rejects.toThrow(LIVE_COMMAND_FAILURES.credentials);
    }
  });

  it("maps an egress refusal to the existing credential refusal", async () => {
    vi.doMock("../src/security/egress.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../src/security/egress.js")>()),
      egressText: () => ({ ok: false, code: "credential-material" }),
    }));
    try {
      vi.resetModules();
      const module = await import("../src/live-agent/command-tool.js");
      const tool = module.createLiveCommandTool({
        repositoryPath: await fixture(),
        allowWrite: true,
        confirm: async () => true,
      });
      await expect(invoke(tool, "pwd")).rejects.toThrow(module.LIVE_COMMAND_FAILURES.credentials);
    } finally {
      vi.doUnmock("../src/security/egress.js");
    }
  });

  it("applies the output bound to the command's bytes and replaces every root within it", async () => {
    const repositoryPath = await fixture();
    const lines = Math.floor(COMMAND_OUTPUT_BYTES / ((await realpath(repositoryPath)).length + 1));
    const tool = approvedTool(repositoryPath);
    const within = await invoke(tool, `yes "$PWD" | head -n ${lines}`);
    expect(outputText(within)).toBe(`Command exited with code 0.\n${".\n".repeat(lines)}`);
    await expect(invoke(tool, `yes "$PWD" | head -n ${lines + 1}`)).rejects.toThrow(
      LIVE_COMMAND_FAILURES.output,
    );
  });

  it("takes the output bound from its catalogued limit and host override", async () => {
    expect(COMMAND_OUTPUT_BYTES).toBe(1_048_576);
    const tool = approvedTool(await fixture(), {
      ...process.env,
      DOCSFAB_LIVE_AGENT_COMMAND_OUTPUT_BYTES: "16",
    });
    expect(outputText(await invoke(tool, "printf '%016d' 0"))).toBe(
      `Command exited with code 0.\n${"0".repeat(16)}`,
    );
    await expect(invoke(tool, "printf '%017d' 0")).rejects.toThrow(LIVE_COMMAND_FAILURES.output);
  });
});
