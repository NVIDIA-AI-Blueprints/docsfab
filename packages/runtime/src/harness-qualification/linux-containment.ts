// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import {
  detectCredentialRuleIds,
  detectCredentialRuleIdsInValue,
} from "../security/repository-scanner.js";
import {
  type BoundedProcessObservation,
  type BoundedProcessRequest,
  type BoundedProcessRunner,
} from "./bounded-process.js";
import { pathExists } from "../shared/primitives.js";

export const LINUX_QUALIFICATION_BWRAP = "/usr/bin/bwrap";
export const LINUX_QUALIFICATION_ENVIRONMENT_NAMES = ["HOME", "LANG", "LC_ALL", "TMPDIR"] as const;

const RUNTIME_READ_PATHS = [
  "/usr",
  "/usr/local",
  "/bin",
  "/lib",
  "/lib64",
  "/etc/ssl",
  "/etc/ld.so.cache",
] as const;

const PROVE_TIMEOUT_MS = 5_000;
const ESCAPE_WAIT_MS = 600;

let verifiedContainmentThisProcess = false;

export function linuxQualificationCommandPrefix(options: {
  readonly executablePath: string;
  readonly workingDirectory: string;
  readonly readPaths?: readonly string[];
  readonly writePaths?: readonly string[];
}): string[] {
  const executablePath = requireAbsolutePath(options.executablePath);
  const workingDirectory = requireAbsolutePath(options.workingDirectory);
  const writePaths = uniqueAbsolute([
    workingDirectory,
    ...(options.writePaths ?? []).map(requireAbsolutePath),
  ]);
  const readPaths = uniqueAbsolute([
    executablePath,
    process.execPath,
    ...RUNTIME_READ_PATHS,
    ...(options.readPaths ?? []).map(requireAbsolutePath),
  ]).filter((path) => !writePaths.includes(path));
  const mountTargets = [...readPaths, ...writePaths, "/dev", "/proc", "/tmp"];
  return [
    "--unshare-pid",
    "--die-with-parent",
    "--new-session",
    "--tmpfs",
    "/",
    ...directoryFlags(mountTargets),
    ...readPaths.flatMap((path) => ["--ro-bind-try", path, path]),
    ...writePaths.flatMap((path) => ["--bind", path, path]),
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--tmpfs",
    "/tmp",
    "--chdir",
    workingDirectory,
    "--",
  ];
}

export async function proveLinuxDescendantContainment(
  scratchDirectory: string,
  signal?: AbortSignal,
): Promise<"verified" | "unsupported"> {
  if (process.platform !== "linux" || signal?.aborted) return "unsupported";
  if (!(await bwrapExecutableAvailable())) return "unsupported";
  let scratch: string;
  try {
    scratch = await realpath(requireAbsolutePath(scratchDirectory));
  } catch {
    return "unsupported";
  }
  const marker = join(scratch, "escaped-descendant");
  await rm(marker, { force: true });
  const observation = await spawnLinuxContainedProcess(
    {
      executablePath: process.execPath,
      arguments: ["-e", descendantEscapeParentScript(), marker],
      workingDirectory: scratch,
      environment: closedProbeEnvironment(scratch),
      stdin: Buffer.alloc(0),
      timeoutMs: PROVE_TIMEOUT_MS,
      maxStdoutBytes: 4_096,
      maxStderrBytes: 4_096,
      signal,
    },
    { writePaths: [scratch] },
  );
  await wait(ESCAPE_WAIT_MS);
  const escaped = await pathExists(marker);
  if (observation.status === "settled" && observation.exitCode === 0 && !escaped) {
    return "verified";
  }
  return "unsupported";
}

/**
 * Linux PID-namespace runner. Darwin and other platforms return
 * `unsupported-confinement` before spawn and never claim verified containment.
 */
export const runContainedLinuxBoundedProcess: BoundedProcessRunner = async (request) => {
  validateLinuxRequest(request);
  if (request.signal?.aborted) return emptyObservation("cancelled");
  if (process.platform !== "linux") return emptyObservation("unsupported-confinement");
  const containment = await requireLinuxDescendantContainment(request.signal);
  if (containment !== "verified") return emptyObservation("unsupported-confinement");
  return spawnLinuxContainedProcess(request, { writePaths: writableRequestPaths(request) });
};

export async function requireLinuxDescendantContainment(
  signal?: AbortSignal,
): Promise<"verified" | "unsupported"> {
  if (verifiedContainmentThisProcess) return "verified";
  const result = await withProbeScratch((scratch) =>
    proveLinuxDescendantContainment(scratch, signal),
  );
  if (result === "verified") verifiedContainmentThisProcess = true;
  return result;
}

async function spawnLinuxContainedProcess(
  request: BoundedProcessRequest,
  options: { readonly writePaths: readonly string[] },
): Promise<BoundedProcessObservation> {
  if (request.signal?.aborted) return emptyObservation("cancelled");
  const prefix = linuxQualificationCommandPrefix({
    executablePath: request.executablePath,
    workingDirectory: request.workingDirectory,
    writePaths: options.writePaths,
  });
  const started = performance.now();
  return await new Promise<BoundedProcessObservation>((resolvePromise) => {
    let settled = false;
    let terminalStatus: BoundedProcessObservation["status"] = "settled";
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stdoutOverflow = false;
    let stderrOverflow = false;
    let stdinDelivered = false;
    const child = spawn(
      LINUX_QUALIFICATION_BWRAP,
      [...prefix, request.executablePath, ...request.arguments],
      {
        cwd: request.workingDirectory,
        env: { ...request.environment },
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    const kill = (): void => {
      try {
        child.kill("SIGKILL");
      } catch {
        // The PID namespace still reaps descendants when bwrap exits.
      }
    };
    const append = (
      current: Buffer<ArrayBufferLike>,
      chunk: Buffer,
      maximum: number,
    ): Buffer<ArrayBufferLike> => {
      const remaining = Math.max(0, maximum - current.byteLength);
      return remaining === 0 ? current : Buffer.concat([current, chunk.subarray(0, remaining)]);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.byteLength + chunk.byteLength > request.maxStdoutBytes) {
        stdoutOverflow = true;
        terminalStatus = "output-limit";
        kill();
      }
      stdout = append(stdout, chunk, request.maxStdoutBytes);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.byteLength + chunk.byteLength > request.maxStderrBytes) {
        stderrOverflow = true;
        terminalStatus = "output-limit";
        kill();
      }
      stderr = append(stderr, chunk, request.maxStderrBytes);
    });
    const timer = setTimeout(() => {
      if (terminalStatus === "settled") terminalStatus = "timeout";
      kill();
    }, request.timeoutMs);
    const onAbort = (): void => {
      if (terminalStatus === "settled") terminalStatus = "cancelled";
      kill();
    };
    request.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdin.once("error", () => {
      stdinDelivered = false;
    });
    child.stdin.end(request.stdin, () => {
      stdinDelivered = terminalStatus === "settled" || terminalStatus === "output-limit";
    });
    const finish = (exitCode: number | null, signalName: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", onAbort);
      resolvePromise({
        status: terminalStatus,
        exitCode,
        signal: signalName,
        durationMs: Math.max(0, Math.round(performance.now() - started)),
        stdout,
        stderr,
        stdoutBytes: stdout.byteLength,
        stderrBytes: stderr.byteLength,
        stdoutOverflow,
        stderrOverflow,
        stdinBytes: request.stdin.byteLength,
        stdinDelivered,
        descendantContainment: "verified",
      });
    };
    child.once("error", () => {
      terminalStatus = terminalStatus === "settled" ? "spawn-failed" : terminalStatus;
      finish(null, null);
    });
    child.once("close", (code, signalName) => finish(code, signalName));
  });
}

function validateLinuxRequest(request: BoundedProcessRequest): void {
  if (!isAbsolute(request.executablePath) || !isAbsolute(request.workingDirectory)) {
    throw new Error(
      "DocsFab requires absolute executable and working-directory paths for bounded processes.",
    );
  }
  const environmentEntries = Object.entries(request.environment);
  if (
    request.arguments.some((value) => typeof value !== "string" || value.includes("\0")) ||
    environmentEntries.some(
      ([name, value]) =>
        !isAllowedEnvironmentName(name) || typeof value !== "string" || value.includes("\0"),
    ) ||
    detectCredentialRuleIdsInValue({
      arguments: request.arguments,
      environment: request.environment,
    }).length > 0 ||
    detectCredentialRuleIds(request.stdin.toString("latin1")).length > 0 ||
    !Number.isSafeInteger(request.timeoutMs) ||
    request.timeoutMs < 1 ||
    !Number.isSafeInteger(request.maxStdoutBytes) ||
    request.maxStdoutBytes < 1 ||
    !Number.isSafeInteger(request.maxStderrBytes) ||
    request.maxStderrBytes < 1
  ) {
    throw new Error("DocsFab rejected a bounded process request with invalid values.");
  }
}

function writableRequestPaths(request: BoundedProcessRequest): readonly string[] {
  const paths = [request.workingDirectory];
  const home = request.environment.HOME;
  const temporaryRoot = request.environment.TMPDIR;
  if (home !== undefined && pathInside(request.workingDirectory, home)) paths.push(home);
  if (temporaryRoot !== undefined && pathInside(request.workingDirectory, temporaryRoot)) {
    paths.push(temporaryRoot);
  }
  return uniqueAbsolute(paths.map(requireAbsolutePath));
}

function linuxQualificationEnvironmentNameSet(): Set<string> {
  return new Set(LINUX_QUALIFICATION_ENVIRONMENT_NAMES);
}

function isAllowedEnvironmentName(name: string): boolean {
  return linuxQualificationEnvironmentNameSet().has(name);
}

function closedProbeEnvironment(scratch: string): Readonly<Record<string, string>> {
  return { HOME: scratch, LANG: "C", LC_ALL: "C", TMPDIR: scratch };
}

function descendantEscapeParentScript(): string {
  const escapedChildScript = [
    "const fs=require('node:fs');",
    "setTimeout(()=>{try{fs.writeFileSync(process.argv[1],'escaped')}catch{}},250);",
    "setTimeout(()=>process.exit(0),500);",
  ].join("");
  return [
    "const cp=require('node:child_process');",
    "const marker=process.argv[1];",
    `const child=cp.spawn(process.execPath,['-e',${JSON.stringify(escapedChildScript)},marker],{detached:true,stdio:'ignore'});`,
    "child.unref();",
    "setTimeout(()=>process.exit(0),50);",
  ].join("");
}

function directoryFlags(paths: readonly string[]): string[] {
  const directories = new Set<string>();
  for (const path of paths) {
    let current = path;
    while (current !== "/") {
      directories.add(current);
      current = dirname(current);
    }
  }
  return [...directories]
    .sort((left, right) => left.length - right.length)
    .flatMap((path) => ["--dir", path]);
}

function uniqueAbsolute(paths: readonly string[]): string[] {
  return [...new Set(paths.map(requireAbsolutePath))];
}

function requireAbsolutePath(value: string): string {
  if (!isAbsolute(value) || value.includes("\0")) {
    throw new Error("DocsFab rejected a bounded process request with invalid values.");
  }
  return resolve(value);
}

async function withProbeScratch<T>(run: (scratch: string) => Promise<T>): Promise<T> {
  const root = process.env.TMPDIR || tmpdir();
  if (!isAbsolute(root)) {
    throw new Error("DocsFab rejected a bounded process request with invalid values.");
  }
  const scratch = await mkdtemp(join(root, "docsfab-hq-pid-"));
  try {
    return await run(scratch);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

function pathInside(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

async function bwrapExecutableAvailable(): Promise<boolean> {
  try {
    await access(LINUX_QUALIFICATION_BWRAP, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

function emptyObservation(
  status: "cancelled" | "unsupported-confinement",
): BoundedProcessObservation {
  return {
    status,
    exitCode: null,
    signal: null,
    durationMs: 0,
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    stdoutBytes: 0,
    stderrBytes: 0,
    stdoutOverflow: false,
    stderrOverflow: false,
    stdinBytes: 0,
    stdinDelivered: false,
    descendantContainment: "unsupported",
  };
}
