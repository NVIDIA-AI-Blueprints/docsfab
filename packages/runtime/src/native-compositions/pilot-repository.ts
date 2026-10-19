// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { constants } from "node:fs";
import { chmod, lstat, open, readFile, readdir, realpath, rename, rm } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

import { canonicalDigest, deepFreeze } from "../contract-kit/index.js";
import { parseJsonEvidence } from "../json-evidence.js";
import { NATIVE_PILOT_CORPUS_PATHS, readInstalledNativePilotCorpusFile } from "./pilot-corpus.js";
import { fail } from "./pilot-runner-error.js";
import {
  MAX_HOST_STDERR_BYTES,
  MAX_HOST_STDOUT_BYTES,
  SHA256,
  assertNoSymlinkAncestors,
  assertRunnerNewWritePath,
  assertRunnerWritePath,
  compareText,
  decodeUtf8,
  enumeration,
  exactKeys,
  hostEnvironment,
  readBoundedRegularFile,
  requirePrivateRoot,
  runBoundedHostProcess,
  safeJoin,
  safeRelativePath,
  sha256,
  strictObject,
} from "./pilot-paths.js";
import type { RunnerState } from "./pilot-runner.js";

export async function verifyCopiedKit(state: RunnerState): Promise<void> {
  for (const file of state.corpus.files) {
    const path = safeJoin(state.kitRoot, file.path);
    await assertNoSymlinkAncestors(path);
    const metadata = await lstat(path);
    const observedMode = (metadata.mode & 0o111) === 0 ? "100644" : "100755";
    const expected = readInstalledNativePilotCorpusFile({
      authority: state.corpusAuthority,
      path: file.path,
    });
    const observed = await readBoundedRegularFile(path, 8 * 1024 * 1024);
    if (
      observedMode !== file.mode ||
      sha256(observed) !== file.sha256 ||
      !observed.equals(expected)
    ) {
      fail("corpus-binding-mismatch");
    }
  }
}

export const MAX_REPOSITORY_FILES = 512;
export const MAX_REPOSITORY_BYTES = 16 * 1024 * 1024;

export interface RepositorySnapshot {
  readonly sha256: string;
  readonly files: readonly {
    readonly path: string;
    readonly sha256: string;
    readonly mode: string;
  }[];
}
export async function materializeRepository(
  state: RunnerState,
  destination: string,
): Promise<void> {
  await assertRunnerNewWritePath(state, destination);
  await verifyCopiedKit(state);
  const materializer = safeJoin(state.kitRoot, NATIVE_PILOT_CORPUS_PATHS.materializer);
  const result = await runBoundedHostProcess({
    executablePath: state.pythonExecutablePath,
    arguments: [materializer, "--destination", destination],
    workingDirectory: state.campaignRoot,
    environment: hostEnvironment(state.environment),
    stdin: null,
    timeoutMs: 60_000,
    maxStdoutBytes: MAX_HOST_STDOUT_BYTES,
    maxStderrBytes: MAX_HOST_STDERR_BYTES,
  });
  if (result.exitCode !== 0 || result.stderr.byteLength !== 0) {
    fail("host-operation-failed");
  }
  let receipt: Record<string, unknown>;
  try {
    receipt = strictObject(parseJsonEvidence(result.stdout));
  } catch {
    fail("host-operation-failed");
  }
  if (
    receipt.kind !== "docsfab-fixture-materialization" ||
    receipt.corpusId !== state.corpus.corpusId ||
    receipt.destination !== destination ||
    receipt.revision !== state.corpus.repositoryRevision ||
    receipt.repositoryTreeSha256 !== state.corpus.repositoryTreeSha256 ||
    receipt.fixtureSha256 !== state.corpus.sourceFixtureSha256 ||
    receipt.allowedPage !== state.corpus.allowedPage
  ) {
    fail("corpus-binding-mismatch");
  }
  await assertRunnerWritePath(state, destination);
  await verifyCopiedKit(state);
  await requirePrivateRepository(destination);
}

export async function requirePrivateRepository(path: string): Promise<void> {
  const canonical = await realpath(path);
  if (canonical !== path) fail("path-policy");
  const metadata = await lstat(path);
  const owner = typeof process.getuid === "function" ? process.getuid() : metadata.uid;
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== owner) {
    fail("artifact-permissions-invalid");
  }
}

export async function snapshotRepository(repository: string): Promise<RepositorySnapshot> {
  const files: Array<{ path: string; sha256: string; mode: string }> = [];
  let aggregateBytes = 0;
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      if (entry.name === ".git" && directory === repository) continue;
      const path = join(directory, entry.name);
      const logical = relative(repository, path).split(sep).join("/");
      if (!safeRelativePath(logical)) fail("path-policy");
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) fail("path-policy");
      if (metadata.isDirectory()) {
        await visit(path);
        continue;
      }
      if (!metadata.isFile() || metadata.nlink !== 1) fail("path-policy");
      aggregateBytes += metadata.size;
      if (files.length >= MAX_REPOSITORY_FILES || aggregateBytes > MAX_REPOSITORY_BYTES) {
        fail("output-limit");
      }
      const bytes = await readFile(path);
      files.push({
        path: logical,
        sha256: sha256(bytes),
        mode: (metadata.mode & 0o111) === 0 ? "100644" : "100755",
      });
    }
  };
  await visit(repository);
  files.sort((left, right) => compareText(left.path, right.path));
  return deepFreeze({ sha256: canonicalDigest(files), files });
}

export async function gitChangedPaths(repository: string): Promise<readonly string[]> {
  const result = await runBoundedHostProcess({
    executablePath: "git",
    arguments: ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    workingDirectory: repository,
    environment: hostEnvironment(process.env),
    stdin: null,
    timeoutMs: 15_000,
    maxStdoutBytes: 1024 * 1024,
    maxStderrBytes: 64 * 1024,
  });
  if (result.exitCode !== 0 || result.stderr.byteLength !== 0) fail("host-operation-failed");
  const text = decodeUtf8(result.stdout);
  const records = text.split("\0").filter(Boolean);
  return Object.freeze(
    records
      .map((record) => record.slice(3))
      .map((path) => {
        if (!safeRelativePath(path)) fail("path-policy");
        return path;
      })
      .sort(),
  );
}

export async function gitPatch(repository: string, path: string): Promise<Buffer> {
  const result = await runBoundedHostProcess({
    executablePath: "git",
    arguments: ["diff", "--binary", "--no-ext-diff", "--", path],
    workingDirectory: repository,
    environment: hostEnvironment(process.env),
    stdin: null,
    timeoutMs: 15_000,
    maxStdoutBytes: 4 * 1024 * 1024,
    maxStderrBytes: 64 * 1024,
  });
  if (result.exitCode !== 0 || result.stderr.byteLength !== 0) fail("host-operation-failed");
  return result.stdout;
}

export async function atomicReplaceRegularFile(
  state: RunnerState,
  path: string,
  bytes: Buffer,
): Promise<void> {
  await assertRunnerWritePath(state, path);
  await assertNoSymlinkAncestors(path);
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    fail("write-boundary-failed");
  }
  const temporary = join(dirname(path), ".docsfab-native-pilot-write.tmp");
  await assertRunnerNewWritePath(state, temporary);
  const handle = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  let renamed = false;
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    await chmod(temporary, 0o644);
    await rename(temporary, path);
    renamed = true;
  } finally {
    if (!renamed) {
      await handle.close().catch((error: unknown) => {
        throw error;
      });
      await rm(temporary, { force: true });
    }
  }
  const after = await lstat(path);
  if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 1) {
    fail("write-boundary-failed");
  }
}

export async function assertDirectoryEmpty(path: string): Promise<void> {
  const entries = await readdir(path);
  if (entries.length !== 0) fail("workspace-mutation");
}
