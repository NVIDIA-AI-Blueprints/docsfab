// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { chmod, lstat, mkdir, open, readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

import { fail, NativePilotRunnerError } from "./pilot-runner-error.js";
import { compareText } from "../shared/primitives.js";
import { sha256 } from "../content-ir/canonical.js";

export const SHA256 = /^[a-f0-9]{64}$/u;
export const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
export const MAX_HOST_STDOUT_BYTES = 4 * 1024 * 1024;
export const MAX_HOST_STDERR_BYTES = 1024 * 1024;

export type NativePilotWriteBoundary = {
  readonly campaignRoot: string;
  readonly durableReplayRoot: string;
  readonly forbiddenRoots: readonly string[];
};

export async function requirePrivateRoot(value: string): Promise<string> {
  const path = await requireCanonicalRoot(value);
  const metadata = await lstat(path);
  const owner = typeof process.getuid === "function" ? process.getuid() : metadata.uid;
  if (
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    metadata.uid !== owner ||
    (metadata.mode & 0o077) !== 0
  ) {
    fail("artifact-permissions-invalid");
  }
  return path;
}

export async function requireCanonicalRoot(value: string): Promise<string> {
  if (!canonicalAbsolutePath(value)) fail("path-policy");
  try {
    const canonical = await realpath(value);
    if (canonical !== value) fail("path-policy");
    await assertNoSymlinkAncestors(canonical);
    return canonical;
  } catch (error) {
    if (error instanceof NativePilotRunnerError) throw error;
    fail("path-policy");
  }
}

export async function requireExecutablePath(value: string): Promise<string> {
  const path = await requireCanonicalRoot(value);
  const metadata = await stat(path);
  if (!metadata.isFile() || (metadata.mode & 0o111) === 0) fail("path-policy");
  return path;
}

export function persistPrivateBytesSync(
  state: NativePilotWriteBoundary,
  path: string,
  bytes: Buffer,
): void {
  assertRunnerNewWritePathSync(state, path);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  assertRunnerWritePathSync(state, dirname(path));
  assertRunnerNewWritePathSync(state, path);
  const descriptor = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  let closed = false;
  try {
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    closed = true;
  } finally {
    if (!closed) closeSync(descriptor);
  }
}

export interface HostProcessResult {
  readonly exitCode: number | null;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}

export async function runBoundedHostProcess(input: {
  readonly executablePath: string;
  readonly arguments: readonly string[];
  readonly workingDirectory: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly stdin: Buffer | null;
  readonly timeoutMs: number;
  readonly maxStdoutBytes: number;
  readonly maxStderrBytes: number;
}): Promise<HostProcessResult> {
  return await new Promise<HostProcessResult>((resolvePromise, rejectPromise) => {
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let overflow = false;
    let timedOut = false;
    let resolved = false;
    const child = spawn(input.executablePath, [...input.arguments], {
      cwd: input.workingDirectory,
      env: { ...input.environment },
      shell: false,
      stdio: [input.stdin === null ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const finishError = (): void => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      rejectPromise(new NativePilotRunnerError("host-operation-failed"));
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, input.timeoutMs);
    child.stdout!.on("data", (chunk: Buffer) => {
      if (stdout.byteLength + chunk.byteLength > input.maxStdoutBytes) {
        overflow = true;
        child.kill("SIGKILL");
      }
      const remaining = Math.max(0, input.maxStdoutBytes - stdout.byteLength);
      stdout = Buffer.concat([stdout, chunk.subarray(0, remaining)]);
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      if (stderr.byteLength + chunk.byteLength > input.maxStderrBytes) {
        overflow = true;
        child.kill("SIGKILL");
      }
      const remaining = Math.max(0, input.maxStderrBytes - stderr.byteLength);
      stderr = Buffer.concat([stderr, chunk.subarray(0, remaining)]);
    });
    child.once("error", finishError);
    child.once("close", (exitCode) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      if (overflow) {
        rejectPromise(new NativePilotRunnerError("output-limit"));
        return;
      }
      if (timedOut) {
        rejectPromise(new NativePilotRunnerError("host-operation-failed"));
        return;
      }
      resolvePromise({ exitCode, stdout, stderr });
    });
    if (input.stdin !== null) child.stdin!.end(input.stdin);
  });
}

export async function readBoundedRegularFile(path: string, maximum: number): Promise<Buffer> {
  const before = await lstat(path);
  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    before.nlink !== 1 ||
    before.size < 1 ||
    before.size > maximum
  ) {
    fail("artifact-path-invalid");
  }
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const handle = await open(path, constants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat();
    if (!sameFile(before, opened)) fail("artifact-path-invalid");
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (!sameFile(opened, after) || bytes.byteLength !== after.size) {
      fail("artifact-path-invalid");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

export async function readPrivateArtifact(path: string, maximum: number): Promise<Buffer> {
  const metadata = await lstat(path);
  const owner = typeof process.getuid === "function" ? process.getuid() : metadata.uid;
  if (metadata.uid !== owner || (metadata.mode & 0o077) !== 0) {
    fail("artifact-permissions-invalid");
  }
  return await readBoundedRegularFile(path, maximum);
}

export function sameFile(
  left: Awaited<ReturnType<typeof lstat>>,
  right: Awaited<ReturnType<typeof lstat>>,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

export function hostEnvironment(source: NodeJS.ProcessEnv): Readonly<Record<string, string>> {
  const result: Record<string, string> = {
    PATH: source.PATH ?? "/usr/bin:/bin",
    LANG: locale(source.LANG ?? "C.UTF-8"),
    LC_ALL: locale(source.LC_ALL ?? source.LANG ?? "C.UTF-8"),
  };
  if (source.TMPDIR && canonicalAbsolutePath(resolve(source.TMPDIR))) {
    result.TMPDIR = resolve(source.TMPDIR);
  }
  return Object.freeze(result);
}

export function safeJoin(root: string, logicalPath: string): string {
  if (!safeRelativePath(logicalPath)) fail("path-policy");
  const path = resolve(root, logicalPath);
  if (!inside(root, path)) fail("path-policy");
  return path;
}

export function runnerWriteStorageRoot(boundary: NativePilotWriteBoundary, path: string): string {
  if (!canonicalAbsolutePath(path)) fail("path-policy");
  const storageRoot = [boundary.campaignRoot, boundary.durableReplayRoot].find(
    (root) => path === root || inside(root, path),
  );
  if (
    !storageRoot ||
    boundary.forbiddenRoots.some(
      (forbiddenRoot) => overlaps(forbiddenRoot, storageRoot) || overlaps(forbiddenRoot, path),
    )
  ) {
    fail("artifact-path-invalid");
  }
  return storageRoot;
}

export async function assertRunnerWritePath(
  boundary: NativePilotWriteBoundary,
  path: string,
): Promise<void> {
  try {
    const storageRoot = runnerWriteStorageRoot(boundary, path);
    await assertNoSymlinkAncestors(storageRoot);
    if (await pathExists(path)) {
      await assertNoSymlinkAncestors(path);
      return;
    }
    await assertSafeNewPath(storageRoot, path);
  } catch (error) {
    if (error instanceof NativePilotRunnerError) throw error;
    fail("artifact-path-invalid");
  }
}

export async function assertRunnerNewWritePath(
  boundary: NativePilotWriteBoundary,
  path: string,
): Promise<void> {
  await assertRunnerWritePath(boundary, path);
  if (await pathExists(path)) fail("artifact-path-invalid");
}

export async function ensureRunnerPrivateDirectory(
  boundary: NativePilotWriteBoundary,
  path: string,
  recursive: boolean,
): Promise<void> {
  try {
    await assertRunnerWritePath(boundary, path);
    await mkdir(path, { recursive, mode: 0o700 });
    await assertRunnerWritePath(boundary, path);
    await requirePrivateRoot(path);
  } catch (error) {
    if (error instanceof NativePilotRunnerError) throw error;
    fail("artifact-path-invalid");
  }
}

export function assertRunnerWritePathSync(boundary: NativePilotWriteBoundary, path: string): void {
  try {
    const storageRoot = runnerWriteStorageRoot(boundary, path);
    assertNoSymlinkAncestorsSync(storageRoot);
    try {
      lstatSync(path);
      assertNoSymlinkAncestorsSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      assertSafeNewPathSync(storageRoot, path);
    }
  } catch (error) {
    if (error instanceof NativePilotRunnerError) throw error;
    fail("artifact-path-invalid");
  }
}

export function assertRunnerNewWritePathSync(
  boundary: NativePilotWriteBoundary,
  path: string,
): void {
  assertRunnerWritePathSync(boundary, path);
  try {
    lstatSync(path);
    fail("artifact-path-invalid");
  } catch (error) {
    if (error instanceof NativePilotRunnerError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") fail("artifact-path-invalid");
  }
}

export async function assertNoSymlinkAncestors(path: string): Promise<void> {
  if (!canonicalAbsolutePath(path)) fail("path-policy");
  const filesystemRoot = parse(path).root;
  const segments = path.slice(filesystemRoot.length).split(sep).filter(Boolean);
  let current = filesystemRoot;
  for (const segment of segments) {
    current = join(current, segment);
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) fail("path-policy");
  }
  if ((await realpath(path)) !== path) fail("path-policy");
}

export async function assertSafeNewPath(root: string, path: string): Promise<void> {
  if (!canonicalAbsolutePath(root) || !canonicalAbsolutePath(path) || !inside(root, path)) {
    fail("path-policy");
  }
  await assertNoSymlinkAncestors(root);
  let current = dirname(path);
  while (inside(root, current) && !(await pathExists(current))) current = dirname(current);
  await assertNoSymlinkAncestors(current);
}

export function assertSafeNewPathSync(root: string, path: string): void {
  if (!canonicalAbsolutePath(root) || !canonicalAbsolutePath(path) || !inside(root, path)) {
    fail("path-policy");
  }
  assertNoSymlinkAncestorsSync(root);
  let current = dirname(path);
  while (inside(root, current)) {
    try {
      lstatSync(current);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      current = dirname(current);
    }
  }
  assertNoSymlinkAncestorsSync(current);
}

export function assertNoSymlinkAncestorsSync(path: string): void {
  if (!canonicalAbsolutePath(path)) fail("path-policy");
  const filesystemRoot = parse(path).root;
  const segments = path.slice(filesystemRoot.length).split(sep).filter(Boolean);
  let current = filesystemRoot;
  for (const segment of segments) {
    current = join(current, segment);
    if (lstatSync(current).isSymbolicLink()) fail("path-policy");
  }
  if (realpathSync(path) !== path) fail("path-policy");
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function safeRelativePath(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 4_096 &&
    !isAbsolute(value) &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

export function overlaps(left: string, right: string): boolean {
  return left === right || inside(left, right) || inside(right, left);
}

export function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

export function canonicalAbsolutePath(value: unknown): value is string {
  return typeof value === "string" && isAbsolute(value) && resolve(value) === value;
}

export function strictUtf8(bytes: Buffer): string {
  const value = decodeUtf8(bytes);
  if (value.includes("\0") || value !== value.normalize("NFC")) fail("invalid-value");
  return value;
}

export function decodeUtf8(bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("invalid-value");
  }
}

export { sha256 };

export function identifier(value: unknown): string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) fail("invalid-value");
  return value;
}

export function strictObject(value: unknown): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    fail("invalid-shape");
  }
  return value as Record<string, unknown>;
}

export function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const observed = Object.keys(value).sort();
  const keys = [...expected].sort();
  if (observed.length !== keys.length || observed.some((key, index) => key !== keys[index])) {
    fail("invalid-shape");
  }
}

export function enumeration<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) fail("invalid-value");
  return value as T;
}

export function nonnegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail("invalid-value");
  return value as number;
}

export function boundedNumber(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    fail("invalid-value");
  }
  return value;
}

export function locale(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/u.test(value)) fail("invalid-value");
  return value;
}

export function username(value: string | undefined): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._@+-]{0,127}$/u.test(value)) {
    fail("invalid-value");
  }
  return value;
}

export { compareText };
