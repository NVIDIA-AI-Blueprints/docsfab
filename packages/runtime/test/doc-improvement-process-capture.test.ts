// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { EventEmitter, once } from "node:events";
import { createHash } from "node:crypto";
import { access, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  commandEvidence,
  emptyFailure,
  runRaw,
  text,
} from "../src/doc-improvement-cli/process-capture.js";

const spawnHarness = vi.hoisted(() => ({
  calls: [] as Array<{ executable: string; args: string[]; options: Record<string, unknown> }>,
  next: [] as Array<() => unknown>,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn((executable: string, args: string[], options: Record<string, unknown>) => {
      spawnHarness.calls.push({ executable, args: [...args], options });
      const controlled = spawnHarness.next.shift();
      return controlled ? controlled() : actual.spawn(executable, args, options as never);
    }),
  };
});

const roots: string[] = [];
const originalAmbientMarker = process.env.DOCSFAB_PROCESS_CAPTURE_AMBIENT;

interface ControlledChild extends EventEmitter {
  pid?: number;
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
  kill: ReturnType<typeof vi.fn>;
}

function controlledChild(pid?: number): ControlledChild {
  return Object.assign(new EventEmitter(), {
    pid,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    kill: vi.fn(() => true),
  });
}

async function closeControlled(child: ControlledChild, code = 0): Promise<void> {
  const stdoutEnded = once(child.stdout, "end");
  const stderrEnded = once(child.stderr, "end");
  child.stdout.end();
  child.stderr.end();
  await Promise.all([stdoutEnded, stderrEnded]);
  child.emit("close", code);
}

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "doc-improvement-process-capture-"));
  roots.push(root);
  return root;
}

async function childScript(root: string, source: string): Promise<string> {
  const script = join(root, "child.mjs");
  await writeFile(script, source, { mode: 0o600 });
  return script;
}

function digest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  spawnHarness.calls.length = 0;
  spawnHarness.next.length = 0;
  if (originalAmbientMarker === undefined) delete process.env.DOCSFAB_PROCESS_CAPTURE_AMBIENT;
  else process.env.DOCSFAB_PROCESS_CAPTURE_AMBIENT = originalAmbientMarker;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("documentation-improvement raw process capture", () => {
  it("passes literal argv, cwd, explicit environment, and copied stdin to a real child", async () => {
    const root = await fixtureRoot();
    const script = await childScript(
      root,
      [
        "let input = '';",
        "process.stdin.setEncoding('utf8');",
        "process.stdin.on('data', (chunk) => { input += chunk; });",
        "process.stdin.on('end', () => process.stdout.write(JSON.stringify({",
        "  args: process.argv.slice(2), cwd: process.cwd(),",
        "  marker: process.env.DOCSFAB_PROCESS_CAPTURE_MARKER ?? null, input,",
        "})));",
      ].join("\n"),
    );
    const stdin = Buffer.from("private input bytes\n", "utf8");
    const shellMarker = join(root, "must-not-be-created-by-a-shell");
    const literalArgument = `literal; touch "${shellMarker}" && *`;
    const environment = { PATH: process.env.PATH, DOCSFAB_PROCESS_CAPTURE_MARKER: "explicit" };

    const resultPromise = runRaw(
      process.execPath,
      [script, literalArgument],
      root,
      environment,
      stdin,
    );
    stdin.fill(0);
    const result = await resultPromise;

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(text(result))).toEqual({
      args: [literalArgument],
      cwd: await realpath(root),
      marker: "explicit",
      input: "private input bytes\n",
    });
    const launch = spawnHarness.calls.at(-1)!;
    expect(launch.args).toEqual([script, literalArgument]);
    await expect(access(shellMarker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(launch.options).toMatchObject({
      cwd: root,
      env: environment,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  });

  it("uses only PATH when no explicit environment is supplied", async () => {
    const root = await fixtureRoot();
    process.env.DOCSFAB_PROCESS_CAPTURE_AMBIENT = "must-not-leak";
    const script = await childScript(
      root,
      "process.stdout.write(JSON.stringify({ambient: process.env.DOCSFAB_PROCESS_CAPTURE_AMBIENT ?? null}));",
    );

    const result = await runRaw(process.execPath, [script], root);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(text(result))).toEqual({ ambient: null });
    expect(spawnHarness.calls.at(-1)!.options.env).toEqual({ PATH: process.env.PATH });
  });

  it("normalizes failures and hashes stdout followed by stderr", async () => {
    const root = await fixtureRoot();
    const script = await childScript(
      root,
      "process.stdout.write('stdout\\n'); process.stderr.write('stderr\\n'); process.exitCode = 7;",
    );

    const result = await runRaw(process.execPath, [script], root);
    const evidence = commandEvidence("npm-check", [process.execPath, script], result);
    const missing = await runRaw(join(root, "missing-executable"), [], root, {
      PATH: process.env.PATH,
    });

    expect(result.exitCode).toBe(1);
    expect(text(result)).toBe("stdout\n");
    expect(result.output).toEqual(
      Buffer.concat([Buffer.from("stdout\n"), Buffer.from("stderr\n")]),
    );
    expect(evidence).toEqual({
      id: "npm-check",
      command: [process.execPath, script],
      exitCode: 1,
      outputSha256: digest(result.output),
    });
    expect(missing).toEqual({ exitCode: 1, stdout: Buffer.alloc(0), output: Buffer.alloc(0) });
    expect(emptyFailure()).toEqual({
      exitCode: 1,
      stdout: Buffer.alloc(0),
      output: Buffer.alloc(0),
    });
  });

  it("accepts exactly 8 MiB and rejects the next byte across both output streams", async () => {
    const killGroup = vi.spyOn(process, "kill").mockImplementation(() => true);
    const exact = controlledChild(15101);
    spawnHarness.next.push(() => exact);
    const exactRun = runRaw("controlled-child", [], process.cwd(), { PATH: process.env.PATH });
    exact.stdout.write(Buffer.alloc(4 * 1024 * 1024, 0x41));
    exact.stderr.write(Buffer.alloc(4 * 1024 * 1024, 0x42));
    await closeControlled(exact);
    await expect(exactRun).resolves.toMatchObject({
      exitCode: 0,
      output: { byteLength: 8 * 1024 * 1024 },
    });
    if (process.platform === "win32") expect(exact.kill).toHaveBeenCalledWith("SIGKILL");
    else expect(killGroup).toHaveBeenCalledWith(-15101, "SIGKILL");

    const overflow = controlledChild(15102);
    spawnHarness.next.push(() => overflow);
    const overflowRun = runRaw("controlled-child", [], process.cwd(), { PATH: process.env.PATH });
    overflow.stdout.write(Buffer.alloc(4 * 1024 * 1024, 0x41));
    overflow.stderr.write(Buffer.alloc(4 * 1024 * 1024, 0x42));
    overflow.stderr.write(Buffer.from([0x5a]));
    await closeControlled(overflow);
    const result = await overflowRun;
    expect(result.exitCode).toBe(1);
    expect(result.output.byteLength).toBe(8 * 1024 * 1024);
    expect(result.output.includes(0x5a)).toBe(false);
    if (process.platform === "win32") expect(overflow.kill).toHaveBeenCalledWith("SIGKILL");
    else expect(killGroup).toHaveBeenCalledWith(-15102, "SIGKILL");
  });

  it("times out at 120000 ms, records error before close, and settles once", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const child = controlledChild(15103);
    spawnHarness.next.push(() => child);
    const killGroup = vi.spyOn(process, "kill").mockImplementation(() => true);

    const resultPromise = runRaw("controlled-child", ["timer"], process.cwd(), { PATH: "/bin" });
    await vi.advanceTimersByTimeAsync(119_999);
    expect(killGroup).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    if (process.platform === "win32") expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    else expect(killGroup).toHaveBeenCalledWith(-15103, "SIGKILL");
    child.emit("error", new Error("simulated spawn failure"));
    await closeControlled(child);
    child.emit("close", 0);

    await expect(resultPromise).resolves.toEqual({
      exitCode: 1,
      stdout: Buffer.alloc(0),
      output: Buffer.alloc(0),
    });
    expect(vi.getTimerCount()).toBe(0);
    if (process.platform === "win32") {
      expect(killGroup).not.toHaveBeenCalled();
      expect(child.kill).toHaveBeenCalledTimes(2);
    } else {
      expect(killGroup).toHaveBeenCalledTimes(2);
      expect(child.kill).not.toHaveBeenCalled();
    }
  });

  it("uses direct child kill on the Windows platform branch", async () => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...platformDescriptor, value: "win32" });
    const child = controlledChild(15105);
    spawnHarness.next.push(() => child);
    const killGroup = vi.spyOn(process, "kill").mockImplementation(() => true);
    try {
      const run = runRaw("controlled-child", [], process.cwd(), { PATH: "/bin" });
      expect(spawnHarness.calls.at(-1)!.options.detached).toBe(false);
      await closeControlled(child);
      await expect(run).resolves.toMatchObject({ exitCode: 0 });
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
      expect(killGroup).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, "platform", platformDescriptor);
    }
  });

  it("uses direct child kill without a PID and falls back when group kill throws", async () => {
    const direct = controlledChild(undefined);
    spawnHarness.next.push(() => direct);
    const directRun = runRaw("controlled-child", [], process.cwd(), { PATH: "/bin" });
    await closeControlled(direct);
    await expect(directRun).resolves.toMatchObject({ exitCode: 0 });
    expect(direct.kill).toHaveBeenCalledWith("SIGKILL");

    const fallback = controlledChild(15104);
    spawnHarness.next.push(() => fallback);
    const groupKill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("simulated process-group kill failure");
    });
    const fallbackRun = runRaw("controlled-child", [], process.cwd(), { PATH: "/bin" });
    await closeControlled(fallback);
    await expect(fallbackRun).resolves.toMatchObject({ exitCode: 0 });
    if (process.platform === "win32") expect(groupKill).not.toHaveBeenCalled();
    else expect(groupKill).toHaveBeenCalledWith(-15104, "SIGKILL");
    expect(fallback.kill).toHaveBeenCalledWith("SIGKILL");
  });
});
