#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, readFile, readdir } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { internalContentPath } from "../src/config/internal-content.js";

export const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const repositoryRoot = resolve(runtimeRoot, "../..");
export const corpusId = "routing-task-guide-v1";
export const sourceRelative = `${internalContentPath("modelComparisonSource")}/routing-task-guide-v1`;
export const sourceRoot = resolve(repositoryRoot, sourceRelative);
export const governedRoot = resolve(
  runtimeRoot,
  internalContentPath("modelComparisonInstalled"),
  "..",
);
export const targetRelative = `${internalContentPath("modelComparisonInstalled")}/${corpusId}`;
export const targetRoot = resolve(runtimeRoot, targetRelative);
export const projectedCorpusRoot = resolve(targetRoot, "corpus");
export const bundleId = "model-comparison-routing-task-guide-v1";

export function fail(message) {
  throw new Error(`Model-comparison kit generation failed: ${message}`);
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => [key, sortValue(child)]),
  );
}

export function canonicalDigest(value) {
  return sha256(JSON.stringify(sortValue(value)));
}

export function serialized(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function relativePath(root, path) {
  const candidate = relative(root, path).split("\\").join("/");
  if (!candidate || candidate === ".." || candidate.startsWith("../")) {
    fail("a generated path escaped its fixed root");
  }
  return candidate;
}

export function fileMode(stat) {
  return (stat.mode & constants.S_IXUSR) === 0 ? "100644" : "100755";
}

export async function discoveredSourceFiles(directory = sourceRoot, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = resolve(directory, entry.name);
    const relativeName = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) fail(`source corpus contains a symbolic link: ${relativeName}`);
    if (entry.isDirectory()) {
      files.push(...(await discoveredSourceFiles(path, relativeName)));
      continue;
    }
    if (!entry.isFile()) fail(`source corpus contains an unsupported node: ${relativeName}`);
    const stat = await lstat(path);
    const bytes = await readFile(path);
    files.push({
      path: relativeName,
      bytes,
      sha256: sha256(bytes),
      mode: fileMode(stat),
    });
  }
  return files;
}

export function trackedSourceModes() {
  const records = execFileSync("git", ["ls-files", "--stage", "-z", "--", sourceRelative], {
    cwd: repositoryRoot,
    encoding: "utf8",
    timeout: 10_000,
  })
    .split("\0")
    .filter(Boolean);
  const tracked = new Map();
  for (const record of records) {
    const separator = record.indexOf("\t");
    const metadata = separator === -1 ? [] : record.slice(0, separator).split(" ");
    const path = separator === -1 ? "" : record.slice(separator + 1);
    if (
      metadata.length !== 3 ||
      !/^[0-7]{6}$/u.test(metadata[0] ?? "") ||
      !/^[a-f0-9]{40,64}$/u.test(metadata[1] ?? "") ||
      metadata[2] !== "0" ||
      !path.startsWith(`${sourceRelative}/`)
    ) {
      fail("source corpus Git index entry is invalid or unmerged");
    }
    const relativeName = path.slice(sourceRelative.length + 1);
    if (!relativeName || tracked.has(relativeName)) {
      fail("source corpus Git index contains an invalid or duplicate path");
    }
    const mode = metadata[0];
    if (mode !== "100644" && mode !== "100755") {
      fail(`source corpus Git index contains a non-regular file: ${relativeName}`);
    }
    tracked.set(relativeName, mode);
  }
  return tracked;
}

export async function sourceFiles() {
  const files = await discoveredSourceFiles();
  const tracked = trackedSourceModes();
  for (const file of files) {
    const trackedMode = tracked.get(file.path);
    if (!trackedMode) {
      fail(`source corpus file is not Git-tracked: ${file.path}`);
    }
    if (file.mode !== trackedMode) {
      fail(`source corpus file mode differs from the Git index: ${file.path}`);
    }
    tracked.delete(file.path);
  }
  if (tracked.size !== 0) {
    fail(`source corpus tracked file is absent from the worktree: ${[...tracked.keys()][0]}`);
  }
  return files;
}

export async function copyCorpusFiles(files) {
  await mkdir(projectedCorpusRoot, { recursive: true, mode: 0o755 });
  for (const file of files) {
    const destination = resolve(projectedCorpusRoot, file.path);
    relativePath(projectedCorpusRoot, destination);
    await mkdir(dirname(destination), { recursive: true, mode: 0o755 });
    await copyFile(resolve(sourceRoot, file.path), destination);
    await chmod(destination, file.mode === "100755" ? 0o755 : 0o644);
  }
}
