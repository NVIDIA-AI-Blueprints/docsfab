// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { EventEmitter } from "node:events";
import { chmod, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { OperationalLimitError } from "../src/config/limits.js";
import { createConfinedToolSet, GREP_FAILURE_MESSAGES } from "../src/harness/confined-tools.js";
import {
  createCredentialSafeGrepDefinition,
  CredentialSafeGrepTransportError,
} from "../src/harness/credential-safe-grep.js";
import {
  classifyCredentialSafeGrepWorkerError,
  parseCredentialSafeGrepRequest,
  validateCredentialSafeGrepAbort,
} from "../src/harness/credential-safe-grep-worker.js";
import { TOOL_RESULT_RECALL_TOOL_NAME } from "../src/harness/tool-output-cap.js";
import { temporaryRoots } from "./helpers/temp.js";

const roots = temporaryRoots();
const fakeTransport = vi.hoisted(() => ({ spawn: undefined as unknown }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      const injected = fakeTransport.spawn;
      if (typeof injected === "function") {
        return (
          injected as (...input: Parameters<typeof actual.spawn>) => ReturnType<typeof actual.spawn>
        )(...args);
      }
      return actual.spawn(...args);
    },
  };
});

type Spawn = typeof import("node:child_process").spawn;

const FAKE_GROUP_ID = 2_000_000_000;

type FakeOutcome =
  | { readonly kind: "frame"; readonly value: unknown }
  | { readonly kind: "frames"; readonly values: unknown[] }
  | { readonly kind: "eof"; readonly exitCode?: number }
  | { readonly kind: "frame-await-eof"; readonly value: unknown }
  | { readonly kind: "frame-stall-after-eof"; readonly value: unknown }
  | { readonly kind: "hold" };

let fakeOutcome: FakeOutcome | undefined;
let abortFrameSeen: (() => void) | undefined;
let requestFrameSeen: (() => void) | undefined;

function response(id: string, outcome: unknown = { kind: "success", result: { content: [] } }) {
  return { schemaVersion: 1, type: "result", id, outcome };
}

function installFakeWorker(options?: {
  readonly liveGroup?: boolean;
  readonly persistAfterHardStop?: boolean;
}): {
  readonly restore: () => void;
  readonly groupProbes: () => number;
  readonly hardStops: () => number;
  readonly stdinEnds: () => number;
} {
  const originalKill = process.kill.bind(process);
  let groupProbes = 0;
  let hardStops = 0;
  let stdinEnds = 0;
  let groupLive = options?.liveGroup ?? false;
  let currentChild: EventEmitter | undefined;
  const killSpy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (pid === -FAKE_GROUP_ID) {
      groupProbes += 1;
      if (signal === 0 && !groupLive)
        throw Object.assign(new Error("no such process group"), { code: "ESRCH" });
      if (signal === "SIGKILL") {
        hardStops += 1;
        if (!options?.persistAfterHardStop) {
          groupLive = false;
          setImmediate(() => currentChild?.emit("close", null, "SIGKILL"));
        }
      }
      return true;
    }
    return originalKill(pid, signal);
  });
  fakeTransport.spawn = (() => {
    const child = new EventEmitter() as EventEmitter & {
      pid: number;
      stdin: {
        write: (chunk: string, callback?: (error?: Error | null) => void) => boolean;
        end: () => void;
        once: (event: string, listener: (...args: unknown[]) => void) => EventEmitter;
        removeAllListeners: () => EventEmitter;
      };
      stdout: EventEmitter;
      stderr: EventEmitter;
    };
    child.pid = FAKE_GROUP_ID;
    currentChild = child;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = {
      once: () => child,
      removeAllListeners: () => child,
      end() {
        stdinEnds += 1;
        if (fakeOutcome?.kind === "frame-await-eof") {
          groupLive = false;
          setImmediate(() => child.emit("close", 0, null));
        }
      },
      write(chunk: string, callback?: (error?: Error | null) => void) {
        const frame = JSON.parse(chunk.trim()) as { id: string; type: string };
        if (frame.type === "abort") {
          abortFrameSeen?.();
          callback?.(null);
          return true;
        }
        requestFrameSeen?.();
        const selected = fakeOutcome;
        if (!selected) throw new Error("fake worker outcome not configured");
        callback?.(null);
        if (selected.kind === "hold") return true;
        setImmediate(() => {
          if (
            selected.kind === "frame" ||
            selected.kind === "frame-await-eof" ||
            selected.kind === "frame-stall-after-eof"
          ) {
            const value =
              typeof selected.value === "object" &&
              selected.value !== null &&
              "id" in selected.value &&
              selected.value.id === "placeholder"
                ? { ...selected.value, id: frame.id }
                : selected.value;
            child.stdout.emit("data", Buffer.from(`${JSON.stringify(value)}\n`));
          } else if (selected.kind === "frames") {
            child.stdout.emit(
              "data",
              Buffer.from(
                `${selected.values
                  .map((value) =>
                    typeof value === "object" &&
                    value !== null &&
                    "id" in value &&
                    value.id === "placeholder"
                      ? JSON.stringify({ ...value, id: frame.id })
                      : JSON.stringify(value),
                  )
                  .join("\n")}\n`,
              ),
            );
          }
          if (selected.kind !== "frame-await-eof" && selected.kind !== "frame-stall-after-eof")
            setImmediate(() =>
              child.emit("close", selected.kind === "eof" ? (selected.exitCode ?? 0) : 0, null),
            );
        });
        return true;
      },
    };
    return child;
  }) as Spawn;
  return {
    restore: () => {
      killSpy.mockRestore();
      fakeTransport.spawn = undefined;
      fakeOutcome = undefined;
      abortFrameSeen = undefined;
      requestFrameSeen = undefined;
    },
    groupProbes: () => groupProbes,
    hardStops: () => hardStops,
    stdinEnds: () => stdinEnds,
  };
}

function byName(toolSet: Awaited<ReturnType<typeof createConfinedToolSet>>, name: string) {
  const tool = toolSet.definitions.find((definition) => definition.name === name);
  if (!tool) throw new Error(`Missing confined tool ${name}`);
  return tool;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((item) => item.text ?? "").join("\n");
}

async function workspaceFixture() {
  const root = await roots.create("docsfab-credential-safe-grep-");
  const workspace = join(root, "workspace");
  const skill = join(root, "skill");
  const quality = join(root, "quality");
  const outside = join(root, "outside");
  await Promise.all([
    mkdir(workspace, { recursive: true }),
    mkdir(join(skill, "references"), { recursive: true }),
    mkdir(join(quality, "profiles"), { recursive: true }),
    mkdir(outside, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(skill, "references", "rubric.md"), "governed skill marker\n"),
    writeFile(join(quality, "profiles", "guide.md"), "governed quality marker\n"),
    writeFile(join(outside, "private.md"), "outside marker\n"),
  ]);
  await symlink(outside, join(workspace, "outside-link"));
  return { root, workspace, skill, quality, outside };
}

describe("credential-safe grep transport preserves the parent tool contract", () => {
  it("classifies a vanished worker path as recoverable while preserving unrelated failures", () => {
    expect(
      classifyCredentialSafeGrepWorkerError(Object.assign(new Error("gone"), { code: "ENOENT" })),
    ).toEqual({ kind: "recoverable-miss" });
    expect(classifyCredentialSafeGrepWorkerError(new Error("Path not found: guide.md"))).toEqual({
      kind: "recoverable-miss",
    });
    expect(
      classifyCredentialSafeGrepWorkerError(Object.assign(new Error("denied"), { code: "EACCES" })),
    ).toEqual({ kind: "tool-defect" });
  });
  it("rejects malformed request fields and mismatched cancellation through the worker parser", async () => {
    const { workspace } = await workspaceFixture();
    const request = {
      schemaVersion: 1,
      type: "request",
      id: "correlated",
      cwd: workspace,
      grants: { workspaceRoot: workspace },
      params: { pattern: "ordinary marker" },
    };
    expect(parseCredentialSafeGrepRequest(request).id).toBe(request.id);
    for (const malformed of [
      { ...request, extra: "untrusted" },
      { ...request, grants: { workspaceRoot: workspace, extra: "untrusted" } },
      { ...request, params: { pattern: "ordinary marker", extra: "untrusted" } },
      { ...request, id: 42 },
    ]) {
      expect(() => parseCredentialSafeGrepRequest(malformed)).toThrow();
    }
    expect(() =>
      validateCredentialSafeGrepAbort({ schemaVersion: 1, type: "abort", id: "wrong" }, request.id),
    ).toThrow();
    expect(() =>
      validateCredentialSafeGrepAbort(
        { schemaVersion: 1, type: "abort", id: request.id, extra: "untrusted" },
        request.id,
      ),
    ).toThrow();
    expect(() =>
      validateCredentialSafeGrepAbort(
        { schemaVersion: 1, type: "abort", id: request.id },
        request.id,
      ),
    ).not.toThrow();
  });

  it("accepts a well-formed response through the shipped parent transport", async () => {
    const { workspace } = await workspaceFixture();
    fakeOutcome = { kind: "frame", value: response("placeholder") };
    const fake = installFakeWorker();
    try {
      const tool = createCredentialSafeGrepDefinition(workspace, { workspaceRoot: workspace });
      const result = await tool.execute(
        "success",
        { path: ".", pattern: "marker", literal: true },
        undefined,
        undefined,
        undefined,
      );
      expect(result.content).toEqual([]);
      expect(fake.groupProbes()).toBeGreaterThan(0);
    } finally {
      fake.restore();
    }
  });

  it("lets a completed worker reap its grep process after the response frame", async () => {
    const { workspace } = await workspaceFixture();
    fakeOutcome = { kind: "frame-await-eof", value: response("placeholder") };
    const fake = installFakeWorker({ liveGroup: true });
    try {
      const tool = createCredentialSafeGrepDefinition(workspace, { workspaceRoot: workspace });
      await expect(
        tool.execute("complete", { path: ".", pattern: "marker", literal: true }, undefined),
      ).resolves.toMatchObject({ content: [] });
      expect(fake.stdinEnds()).toBe(1);
      expect(fake.hardStops()).toBe(0);
    } finally {
      fake.restore();
    }
  });

  it("shares one cleanup deadline across a stalled close and hard group stop", async () => {
    const { workspace } = await workspaceFixture();
    fakeOutcome = { kind: "frame-stall-after-eof", value: response("placeholder") };
    const fake = installFakeWorker({ liveGroup: true, persistAfterHardStop: true });
    const previous = process.env.DOCSFAB_EXECUTION_GREP_GROUP_CLEANUP_MS;
    process.env.DOCSFAB_EXECUTION_GREP_GROUP_CLEANUP_MS = "100";
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const tool = createCredentialSafeGrepDefinition(workspace, { workspaceRoot: workspace });
      let settled = false;
      const pending = tool.execute(
        "stall",
        { path: ".", pattern: "marker", literal: true },
        undefined,
      );
      void pending.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      for (let turn = 0; turn < 10 && fake.stdinEnds() === 0; turn += 1)
        await new Promise<void>((resolve) => setImmediate(resolve));
      expect(fake.stdinEnds()).toBe(1);
      await vi.advanceTimersByTimeAsync(101);
      expect(fake.hardStops()).toBe(1);
      expect(settled).toBe(true);
      await expect(pending).rejects.toMatchObject({
        failure: {
          kind: "cleanup-timeout",
          scope: "per-run",
          limitRefusal: {
            code: "execution-grep-group-cleanup-ms-bound",
            limitName: "execution.grepGroupCleanupMs",
            configured: 100,
            observed: 100,
          },
        },
      });
    } finally {
      vi.useRealTimers();
      fake.restore();
      if (previous === undefined) delete process.env.DOCSFAB_EXECUTION_GREP_GROUP_CLEANUP_MS;
      else process.env.DOCSFAB_EXECUTION_GREP_GROUP_CLEANUP_MS = previous;
    }
  });

  it.each([
    ["malformed JSON", { kind: "frame", value: "not-json" }],
    ["wrong response correlation", { kind: "frame", value: response("different-id") }],
    [
      "extra response frames",
      { kind: "frames", values: [response("placeholder"), response("placeholder")] },
    ],
    ["premature EOF", { kind: "eof" }],
    ["worker exit without a response", { kind: "eof", exitCode: 23 }],
  ] as const)(
    "classifies %s as a transport defect and settles the owned group",
    async (_name, outcome) => {
      const { workspace } = await workspaceFixture();
      fakeOutcome = outcome;
      const fake = installFakeWorker();
      try {
        const tool = createCredentialSafeGrepDefinition(workspace, { workspaceRoot: workspace });
        await expect(
          tool.execute(
            "fault",
            { path: ".", pattern: "marker", literal: true },
            undefined,
            undefined,
            undefined,
          ),
        ).rejects.toMatchObject({
          name: CredentialSafeGrepTransportError.name,
          failure: { kind: "tool-defect" },
        });
        expect(fake.groupProbes()).toBeGreaterThan(0);
      } finally {
        fake.restore();
      }
    },
  );

  it("classifies a valid worker denial and settles the owned group", async () => {
    const { workspace } = await workspaceFixture();
    fakeOutcome = {
      kind: "frame",
      value: response("placeholder", { kind: "failure", failure: { kind: "denied-path" } }),
    };
    const fake = installFakeWorker();
    try {
      const tool = createCredentialSafeGrepDefinition(workspace, { workspaceRoot: workspace });
      await expect(
        tool.execute(
          "denied",
          { path: ".", pattern: "marker", literal: true },
          undefined,
          undefined,
          undefined,
        ),
      ).rejects.toMatchObject({ failure: { kind: "denied-path" } });
      expect(fake.groupProbes()).toBeGreaterThan(0);
    } finally {
      fake.restore();
    }
  });

  it("lets cancellation win a response race and sends the correlated abort frame", async () => {
    const { workspace } = await workspaceFixture();
    fakeOutcome = { kind: "hold" };
    const fake = installFakeWorker();
    let sawAbort!: () => void;
    let sawRequest!: () => void;
    const abortSeen = new Promise<void>((resolve) => {
      sawAbort = resolve;
    });
    const requestSeen = new Promise<void>((resolve) => {
      sawRequest = resolve;
    });
    abortFrameSeen = sawAbort;
    requestFrameSeen = sawRequest;
    try {
      const tool = createCredentialSafeGrepDefinition(workspace, { workspaceRoot: workspace });
      const controller = new AbortController();
      const pending = tool.execute(
        "abort",
        { path: ".", pattern: "marker", literal: true },
        controller.signal,
        undefined,
        undefined,
      );
      await requestSeen;
      await new Promise<void>((resolve) => setImmediate(resolve));
      controller.abort();
      await expect(pending).rejects.toMatchObject({
        name: CredentialSafeGrepTransportError.name,
        failure: { kind: "tool-defect" },
      });
      await abortSeen;
      expect(fake.groupProbes()).toBeGreaterThan(0);
    } finally {
      fake.restore();
    }
  });
  it("settles with an actionable refusal when the owned group remains observable after its child closes", async () => {
    const { workspace } = await workspaceFixture();
    await writeFile(join(workspace, "guide.md"), "ordinary grep marker\n");
    const set = await createConfinedToolSet({ workspacePath: workspace, allowWrite: false });
    const originalKill = process.kill.bind(process);
    let hardStops = 0;
    const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid < 0 && signal === 0) return true;
      if (pid < 0 && signal === "SIGKILL") {
        hardStops += 1;
        return true;
      }
      return originalKill(pid, signal);
    });
    const previous = process.env.DOCSFAB_EXECUTION_GREP_GROUP_CLEANUP_MS;
    process.env.DOCSFAB_EXECUTION_GREP_GROUP_CLEANUP_MS = "100";
    try {
      const started = Date.now();
      const refusal = await byName(set, "grep")
        .execute(
          "cleanup",
          { path: "guide.md", pattern: "ordinary grep marker", literal: true },
          undefined,
          undefined,
          undefined,
        )
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      expect(refusal).toBeInstanceOf(Error);
      expect((refusal as Error).cause).toBeInstanceOf(OperationalLimitError);
      expect((refusal as Error).cause).toMatchObject({
        code: "execution-grep-group-cleanup-ms-bound",
        limitName: "execution.grepGroupCleanupMs",
        configured: 100,
        unit: "ms",
      });
      const message = (refusal as Error).message;
      expect(message).toContain("execution-grep-group-cleanup-ms-bound");
      expect(message).toContain("execution.grepGroupCleanupMs = 100 ms");
      expect(message).toContain("Scope: per-run");
      expect(message).toMatch(/owned process group \d+/u);
      expect(message).toContain("Inspect and terminate the named grep process group");
      const observed = Number(message.match(/: (\d+) exceeds execution\.grepGroupCleanupMs/u)?.[1]);
      expect(observed).toBeGreaterThanOrEqual(100);
      expect(observed).toBeLessThanOrEqual(Date.now() - started);
      expect((refusal as Error).cause).toMatchObject({ observed });
      expect(hardStops).toBeGreaterThan(0);
      expect(set.getFailureCategories()).toContainEqual({ category: "tool-defect", count: 1 });
    } finally {
      kill.mockRestore();
      if (previous === undefined) delete process.env.DOCSFAB_EXECUTION_GREP_GROUP_CLEANUP_MS;
      else process.env.DOCSFAB_EXECUTION_GREP_GROUP_CLEANUP_MS = previous;
    }
  });
  it("keeps exact governed skill and quality read grants while refusing outside and symlink paths", async () => {
    const { workspace, skill, quality } = await workspaceFixture();
    const set = await createConfinedToolSet({
      workspacePath: workspace,
      governedSkill: { id: "write-documentation", directory: skill },
      governedQualityDirectory: quality,
      allowWrite: false,
    });
    const grep = byName(set, "grep");

    const skillResult = await grep.execute(
      "skill",
      {
        path: `${set.governedSkillVirtualPath}/references`,
        pattern: "governed skill marker",
        literal: true,
      },
      undefined,
      undefined,
      undefined,
    );
    const qualityResult = await grep.execute(
      "quality",
      {
        path: `${set.governedQualityVirtualPath}/profiles`,
        pattern: "governed quality marker",
        literal: true,
      },
      undefined,
      undefined,
      undefined,
    );
    expect(textOf(skillResult)).toContain("rubric.md:1: governed skill marker");
    expect(textOf(qualityResult)).toContain("guide.md:1: governed quality marker");
    await expect(
      grep.execute(
        "outside",
        { path: "outside-link", pattern: "outside marker" },
        undefined,
        undefined,
        undefined,
      ),
    ).rejects.toThrow("DocsFab denied the requested tool path.");
    expect(set.getFailureCategories()).toContainEqual({ category: "denied-path", count: 1 });
  }, 30_000);

  it("keeps complete Pi output for the parent cap and archives that original for recall", async () => {
    const { workspace } = await workspaceFixture();
    const contents =
      Array.from(
        { length: 90 },
        (_, index) => `needle row${index} ${"ordinary-text-".repeat(34)}`,
      ).join("\n") + "\n";
    await writeFile(join(workspace, "large.md"), contents, "utf8");
    const large = await createConfinedToolSet({
      workspacePath: workspace,
      allowWrite: false,
      toolOutputCapBytes: 65_536,
      toolResultRecall: true,
    });
    const result = await byName(large, "grep").execute(
      "large",
      { path: "large.md", pattern: "needle", literal: true },
      undefined,
      undefined,
      undefined,
    );
    expect(textOf(result)).toContain("row89");
    expect(Buffer.byteLength(textOf(result), "utf8")).toBeGreaterThan(32_768);
    expect(textOf(result)).not.toContain("docsfab-output-cap");

    const small = await createConfinedToolSet({
      workspacePath: workspace,
      allowWrite: false,
      toolOutputCapBytes: 1024,
      toolResultRecall: true,
    });
    const capped = await byName(small, "grep").execute(
      "small",
      { path: "large.md", pattern: "needle", literal: true },
      undefined,
      undefined,
      undefined,
    );
    expect(textOf(capped)).toContain("docsfab-output-cap");
    expect(textOf(capped)).toContain("row89");
    const archive = small.getToolResultArchive();
    expect(archive?.receipts).toHaveLength(1);
    expect(archive?.storedBytes).toBeGreaterThan(32_768);
    const handle = archive!.receipts[0]!.handle;
    const recall = byName(small, TOOL_RESULT_RECALL_TOOL_NAME);
    const firstPage = await recall.execute("recall", { handle }, undefined, undefined, undefined);
    expect(textOf(firstPage)).toContain("row0");
  }, 30_000);

  it("retains actionable typed regex and glob errors and distinguishes a missing path", async () => {
    const { workspace } = await workspaceFixture();
    await writeFile(join(workspace, "guide.md"), "needle\n", "utf8");
    const set = await createConfinedToolSet({ workspacePath: workspace, allowWrite: false });
    const grep = byName(set, "grep");

    await expect(
      grep.execute("regex", { path: "guide.md", pattern: "[" }, undefined, undefined, undefined),
    ).rejects.toThrow(GREP_FAILURE_MESSAGES["regex-rejected"]);
    await expect(
      grep.execute(
        "glob",
        { path: ".", pattern: "needle", glob: "[" },
        undefined,
        undefined,
        undefined,
      ),
    ).rejects.toThrow(GREP_FAILURE_MESSAGES["glob-rejected"]);
    await expect(
      grep.execute(
        "missing",
        { path: "missing.md", pattern: "needle" },
        undefined,
        undefined,
        undefined,
      ),
    ).rejects.toThrow("DocsFab tool target is unavailable.");
    expect(set.getFailureCategories()).toEqual([
      { category: "expected-missing-probe", count: 1 },
      { category: "unsupported-pattern", count: 2 },
    ]);
  }, 30_000);

  it.skipIf(process.platform === "win32")(
    "terminates the nested rg process on abort and does not leave a process-group descendant",
    async () => {
      const root = await roots.create("docsfab-grep-abort-");
      const workspace = join(root, "workspace");
      const bin = join(root, "bin");
      const home = join(root, "home");
      const piAgent = join(root, "pi-agent");
      await Promise.all([
        mkdir(workspace, { recursive: true }),
        mkdir(bin, { recursive: true }),
        mkdir(home, { recursive: true }),
        mkdir(piAgent, { recursive: true }),
      ]);
      await writeFile(join(workspace, "guide.md"), "needle\n", "utf8");
      const pidPath = join(root, "rg.pid");
      const fakeRg = join(bin, "rg");
      await writeFile(
        fakeRg,
        `#!${process.execPath}\nconst fs=require("node:fs"); if(process.argv.includes("--version")){console.log("ripgrep 14.1.0");}else{fs.writeFileSync(${JSON.stringify(pidPath)},String(process.pid));process.on("SIGTERM",()=>{});setInterval(()=>{},1000);}\n`,
        { mode: 0o700 },
      );
      await chmod(fakeRg, 0o700);
      const previous = {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
        PI_OFFLINE: process.env.PI_OFFLINE,
      };
      process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? "/usr/bin:/bin"}`;
      process.env.HOME = home;
      process.env.PI_CODING_AGENT_DIR = piAgent;
      process.env.PI_OFFLINE = "1";
      try {
        const set = await createConfinedToolSet({ workspacePath: workspace, allowWrite: false });
        const controller = new AbortController();
        const pending = byName(set, "grep").execute(
          "abort",
          { path: "guide.md", pattern: "needle", literal: true },
          controller.signal,
          undefined,
          undefined,
        );
        let pid: number | undefined;
        for (let attempt = 0; attempt < 200; attempt += 1) {
          try {
            pid = Number(await readFile(pidPath, "utf8"));
            break;
          } catch {
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
        }
        expect(pid).toBeDefined();
        controller.abort();
        await expect(pending).rejects.toThrow();
        let alive = true;
        for (let attempt = 0; attempt < 20; attempt += 1) {
          try {
            process.kill(pid!, 0);
          } catch {
            alive = false;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        if (alive) {
          process.kill(pid!, "SIGKILL");
          for (let attempt = 0; attempt < 20; attempt += 1) {
            try {
              process.kill(pid!, 0);
              await new Promise((resolve) => setTimeout(resolve, 25));
            } catch {
              break;
            }
          }
        }
        expect(alive).toBe(false);
      } finally {
        for (const [name, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
      }
    },
    30_000,
  );
});
