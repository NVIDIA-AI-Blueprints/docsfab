// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { spawn } from "node:child_process";

import { canonicalDigest } from "../contract-kit/index.js";
import { detectCredentialRuleIdsInValue } from "../security/repository-scanner.js";
import {
  type NativeExecutableObservation,
  type NativePreflightHost,
  NativePreflightHostError,
  type NativePreflightProcessObservation,
  type NativePreflightProcessRequest,
} from "./adapters.js";
import { CODEX_CATALOG_ARGUMENTS, NATIVE_PREFLIGHT_ENVIRONMENT_NAMES } from "./contracts.js";
import type { NativeHarnessId } from "./contracts.js";

// Claude Code 2.1.226 ships a 279,661,952-byte native executable on macOS.
// Keep inspection bounded while admitting the observed packaged binary.
const MAX_EXECUTABLE_BYTES = 512 * 1024 * 1024;
const HASH_CHUNK_BYTES = 1024 * 1024;
const MAX_CONFIGURED_EXECUTABLE_PATH_BYTES = 4_096;

/**
 * Concrete host for fixed native CLI preflights. None makes a model request;
 * the Codex 0.155.1 account catalog is one authenticated provider read, and
 * the other admitted commands are provider-offline.
 *
 * It never invokes a shell, accepts no stdin, and rejects every command except
 * the version/auth/catalog argv frozen by the native adapters.
 */
export function createLocalNativePreflightHost(): NativePreflightHost {
  return Object.freeze({
    inspectExecutable: inspectLocalExecutable,
    runProcess: runLocalPreflightProcess,
  });
}

/**
 * Resolves one explicit host-configured executable to its canonical target.
 *
 * The returned path is the path the preflight executes and hashes. Launcher
 * symlinks are never executed after inspection, so a symlink swap cannot
 * redirect the fixed argv sequence between the two inspections.
 */
export async function resolveLocalNativeExecutable(
  harnessId: NativeHarnessId,
  configuredPath: string | undefined,
): Promise<string> {
  if (
    typeof configuredPath !== "string" ||
    !isAbsolute(configuredPath) ||
    configuredPath.length > MAX_CONFIGURED_EXECUTABLE_PATH_BYTES ||
    /\0/u.test(configuredPath)
  ) {
    throw new NativePreflightHostError("host-operation-failed");
  }
  const executableNames: readonly string[] =
    harnessId === "codex" ? (["codex", "codex.exe"] as const) : (["claude", "claude.exe"] as const);
  try {
    await access(configuredPath, constants.X_OK);
    const canonicalPath = await realpath(configuredPath);
    if (
      !canonicalAbsolutePath(canonicalPath) ||
      !executableNames.includes(basename(canonicalPath))
    ) {
      throw new NativePreflightHostError("host-operation-failed");
    }
    return canonicalPath;
  } catch (error) {
    if (error instanceof NativePreflightHostError) throw error;
    throw new NativePreflightHostError("host-operation-failed");
  }
}

async function inspectLocalExecutable(
  absolutePath: string,
  signal?: AbortSignal,
): Promise<NativeExecutableObservation> {
  if (signal?.aborted) throw new NativePreflightHostError("cancelled");
  if (!canonicalAbsolutePath(absolutePath)) {
    throw new NativePreflightHostError("host-operation-failed");
  }
  try {
    const canonicalPath = await realpath(absolutePath);
    const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    const handle = await open(canonicalPath, constants.O_RDONLY | noFollow);
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size < 1 || before.size > MAX_EXECUTABLE_BYTES) {
        throw new NativePreflightHostError("host-operation-failed");
      }
      const contentSha256 = createHash("sha256");
      const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
      let offset = 0;
      while (offset < before.size) {
        if (signal?.aborted) throw new NativePreflightHostError("cancelled");
        const requested = Math.min(buffer.byteLength, before.size - offset);
        const { bytesRead } = await handle.read(buffer, 0, requested, offset);
        if (bytesRead < 1) throw new NativePreflightHostError("host-operation-failed");
        contentSha256.update(buffer.subarray(0, bytesRead));
        offset += bytesRead;
      }
      const after = await handle.stat();
      if (signal?.aborted) throw new NativePreflightHostError("cancelled");
      const stable = sameFile(before, after) && offset === after.size;
      const owner = typeof process.getuid === "function" ? process.getuid() : -1;
      const trusted =
        canonicalPath === absolutePath &&
        stable &&
        (after.uid === 0 || after.uid === owner) &&
        (after.mode & 0o022) === 0 &&
        (after.mode & 0o111) !== 0;
      return Object.freeze({
        canonicalPath,
        basename: basename(canonicalPath),
        sha256: contentSha256.digest("hex"),
        identitySha256: canonicalDigest({
          canonicalPathSha256: createHash("sha256").update(canonicalPath, "utf8").digest("hex"),
          device: String(after.dev),
          inode: String(after.ino),
          size: after.size,
          mode: after.mode,
          owner: after.uid,
          group: after.gid,
          modifiedMs: after.mtimeMs,
          changedMs: after.ctimeMs,
        }),
        trusted,
      });
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof NativePreflightHostError) throw error;
    throw new NativePreflightHostError(signal?.aborted ? "cancelled" : "host-operation-failed");
  }
}

async function runLocalPreflightProcess(
  request: NativePreflightProcessRequest,
): Promise<NativePreflightProcessObservation> {
  validateLocalRequest(request);
  if (request.signal?.aborted) return emptyObservation("cancelled");
  const started = performance.now();

  return await new Promise<NativePreflightProcessObservation>((resolvePromise) => {
    let settled = false;
    let terminalStatus: NativePreflightProcessObservation["status"] = "settled";
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stdoutOverflow = false;
    let stderrOverflow = false;

    const child = spawn(request.executablePath, request.arguments, {
      cwd: dirname(request.executablePath),
      env: { ...request.environment },
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });

    const kill = (): void => {
      try {
        if (child.pid !== undefined && process.platform !== "win32") {
          process.kill(-child.pid, "SIGKILL");
        } else {
          child.kill("SIGKILL");
        }
      } catch {
        child.kill("SIGKILL");
      }
    };
    const append = (current: Buffer, chunk: Buffer, maximum: number): Buffer => {
      const remaining = Math.max(0, maximum - current.byteLength);
      return remaining === 0 ? current : Buffer.concat([current, chunk.subarray(0, remaining)]);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.byteLength + chunk.byteLength > request.maxStdoutBytes) {
        stdoutOverflow = true;
        terminalStatus = "output-limit";
      }
      stdout = append(stdout, chunk, request.maxStdoutBytes);
      if (stdoutOverflow) kill();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.byteLength + chunk.byteLength > request.maxStderrBytes) {
        stderrOverflow = true;
        terminalStatus = "output-limit";
      }
      stderr = append(stderr, chunk, request.maxStderrBytes);
      if (stderrOverflow) kill();
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

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", onAbort);
      resolvePromise({
        status: terminalStatus,
        exitCode,
        signal,
        durationMs: Math.max(0, Math.round(performance.now() - started)),
        stdout,
        stderr,
        stdoutBytes: stdout.byteLength,
        stderrBytes: stderr.byteLength,
        stdoutOverflow,
        stderrOverflow,
      });
    };
    child.once("error", () => {
      terminalStatus = "spawn-failed";
      finish(null, null);
    });
    child.once("close", finish);
  });
}

/**
 * The local host's pre-spawn admission: fixed argv per operation and harness,
 * a closed environment, and bounded timeouts and captures. Exported so fake
 * hosts in tests apply the same check a real spawn does. Throws
 * `NativePreflightHostError("host-operation-failed")` on any mismatch.
 */
export function validateLocalRequest(request: NativePreflightProcessRequest): void {
  const names = Object.keys(request.environment).sort();
  const executableBasename = basename(request.executablePath);
  const codexExecutable = executableBasename === "codex" || executableBasename === "codex.exe";
  const claudeExecutable = executableBasename === "claude" || executableBasename === "claude.exe";
  const fixedCommand =
    (request.operation === "version" && exactArguments(request.arguments, ["--version"])) ||
    (request.operation === "authentication" &&
      ((codexExecutable && exactArguments(request.arguments, ["login", "status"])) ||
        (claudeExecutable && exactArguments(request.arguments, ["auth", "status", "--json"])))) ||
    (request.operation === "catalog" &&
      codexExecutable &&
      Object.values(CODEX_CATALOG_ARGUMENTS).some((catalogArguments) =>
        exactArguments(request.arguments, catalogArguments),
      ));
  if (
    !canonicalAbsolutePath(request.executablePath) ||
    !fixedCommand ||
    names.length === 0 ||
    names[0] !== "HOME" ||
    names.some(
      (name) => !(NATIVE_PREFLIGHT_ENVIRONMENT_NAMES as readonly string[]).includes(name),
    ) ||
    detectCredentialRuleIdsInValue(request.environment).length > 0 ||
    !Number.isSafeInteger(request.timeoutMs) ||
    request.timeoutMs < 1 ||
    request.timeoutMs > 60_000 ||
    !Number.isSafeInteger(request.maxStdoutBytes) ||
    request.maxStdoutBytes < 1 ||
    request.maxStdoutBytes > 4 * 1024 * 1024 ||
    !Number.isSafeInteger(request.maxStderrBytes) ||
    request.maxStderrBytes < 1 ||
    request.maxStderrBytes > 1024 * 1024
  ) {
    throw new NativePreflightHostError("host-operation-failed");
  }
}

function exactArguments(actual: readonly string[], expected: readonly string[]): boolean {
  return (
    actual.length === expected.length &&
    actual.every((argument, index) => argument === expected[index])
  );
}

function sameFile(
  before: Awaited<ReturnType<Awaited<ReturnType<typeof open>>["stat"]>>,
  after: Awaited<ReturnType<Awaited<ReturnType<typeof open>>["stat"]>>,
): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mode === after.mode &&
    before.uid === after.uid &&
    before.gid === after.gid &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs
  );
}

function emptyObservation(status: "cancelled"): NativePreflightProcessObservation {
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
  };
}

function canonicalAbsolutePath(value: string): boolean {
  return isAbsolute(value) && resolve(value) === value;
}
