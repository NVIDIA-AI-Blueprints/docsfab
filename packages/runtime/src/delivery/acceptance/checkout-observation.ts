// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import {
  DELIVERY_ACCEPTANCE_IGNORED_STATE_POLICY,
  type DeliveryAcceptanceIgnoredNotObservedReason,
  type DeliveryAcceptanceIgnoredStateSummaryV1,
} from "../acceptance-manifest.js";
import { compareText } from "../../shared/primitives.js";
import { command } from "./process.js";

const MAX_FINGERPRINT_FILE_BYTES = 1024 * 1024;
const MAX_FINGERPRINT_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_FINGERPRINT_UNTRACKED_FILES = 1_000;
const SAFE_READ_GIT_CONFIG = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.attributesFile=/dev/null",
  "-c",
  "core.excludesFile=/dev/null",
  "-c",
  "diff.trustExitCode=false",
  "-c",
  "pager.status=false",
  "-c",
  "pager.diff=false",
] as const;

export interface DeliveryAcceptanceSourceCheckoutObservationV1 {
  sha256: string;
  ignored: DeliveryAcceptanceIgnoredStateSummaryV1;
}

export async function deliveryAcceptanceSourceCheckoutSha256(source: string): Promise<string> {
  return (await observeDeliveryAcceptanceSourceCheckout(source)).sha256;
}

export async function observeDeliveryAcceptanceSourceCheckout(
  source: string,
): Promise<DeliveryAcceptanceSourceCheckoutObservationV1> {
  const canonicalSource = await realpath(source);
  const [head, branch, statusBytes, staged, unstaged, untracked, ignored] = await Promise.all([
    safeFingerprintGit(canonicalSource, ["rev-parse", "HEAD"]),
    safeFingerprintGit(canonicalSource, ["symbolic-ref", "HEAD"]),
    safeFingerprintGit(canonicalSource, [
      "status",
      "--porcelain=v2",
      "-z",
      "--untracked-files=all",
    ]),
    safeFingerprintGit(canonicalSource, [
      "diff",
      "--binary",
      "--no-ext-diff",
      "--no-textconv",
      "--cached",
      "HEAD",
      "--",
    ]),
    safeFingerprintGit(canonicalSource, [
      "diff",
      "--binary",
      "--no-ext-diff",
      "--no-textconv",
      "--",
    ]),
    safeFingerprintGit(canonicalSource, ["ls-files", "--others", "--exclude-standard", "-z"]),
    safeFingerprintGit(canonicalSource, [
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "--directory",
      "--no-empty-directory",
      "-z",
    ]),
  ]);
  const paths = fingerprintPaths(untracked, "untracked");
  if (paths.length > MAX_FINGERPRINT_UNTRACKED_FILES || new Set(paths).size !== paths.length) {
    throw new Error("Source checkout has too many or duplicate untracked fingerprint entries.");
  }
  const ignoredPaths = fingerprintPaths(ignored, "ignored");
  if (
    ignoredPaths.length > DELIVERY_ACCEPTANCE_IGNORED_STATE_POLICY.maximumEntries ||
    new Set(ignoredPaths).size !== ignoredPaths.length
  ) {
    throw new Error("Source checkout ignored-state observation exceeded its bounded policy.");
  }
  const digest = createHash("sha256");
  for (const [label, bytes] of [
    ["head", head],
    ["branch", branch],
    ["status", statusBytes],
    ["staged", staged],
    ["unstaged", unstaged],
    ["untracked", untracked],
    ["ignored", ignored],
  ] as const)
    updateFingerprintDigest(digest, label, bytes);
  let totalBytes = 0;
  for (const path of paths) {
    const bytes = await readBoundedUntrackedFile(canonicalSource, path);
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_FINGERPRINT_TOTAL_BYTES) {
      throw new Error("Source checkout untracked fingerprint exceeds its total byte limit.");
    }
    updateFingerprintDigest(digest, `path:${path}`, bytes);
  }
  let ignoredObservedBytes = 0;
  let observedFileCount = 0;
  let notObservedEntryCount = 0;
  const notObservedReasons = new Set<DeliveryAcceptanceIgnoredNotObservedReason>();
  for (const path of ignoredPaths) {
    const observation = await observeIgnoredFingerprintEntry(
      canonicalSource,
      path,
      DELIVERY_ACCEPTANCE_IGNORED_STATE_POLICY.maximumTotalObservedBytes - ignoredObservedBytes,
    );
    updateFingerprintDigest(digest, `ignored-path:${path}`, observation.metadata);
    if (observation.bytes) {
      ignoredObservedBytes += observation.bytes.byteLength;
      observedFileCount += 1;
      updateFingerprintDigest(digest, `ignored-bytes:${path}`, observation.bytes);
    } else {
      notObservedEntryCount += 1;
      notObservedReasons.add(observation.reason);
    }
  }
  const reasons = [...notObservedReasons].sort(compareText);
  const ignoredSummary: DeliveryAcceptanceIgnoredStateSummaryV1 = {
    policySha256: DELIVERY_ACCEPTANCE_IGNORED_STATE_POLICY.sha256,
    disposition: notObservedEntryCount === 0 ? "fully-observed" : "policy-approved-not-observed",
    entryCount: ignoredPaths.length,
    observedFileCount,
    notObservedEntryCount,
    notObservedReasons: reasons,
  };
  return { sha256: digest.digest("hex"), ignored: ignoredSummary };
}

function fingerprintPaths(bytes: Uint8Array, label: "untracked" | "ignored"): string[] {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`Source checkout ${label} observation is invalid.`);
  }
  if (!text.endsWith("\0") && text.length > 0) {
    throw new Error(`Source checkout ${label} observation is invalid.`);
  }
  return text.split("\0").filter(Boolean).sort(compareText);
}

type IgnoredFingerprintObservation =
  | { metadata: Buffer; bytes: Buffer; reason?: never }
  | {
      metadata: Buffer;
      bytes?: never;
      reason: DeliveryAcceptanceIgnoredNotObservedReason;
    };

async function observeIgnoredFingerprintEntry(
  source: string,
  rawPath: string,
  remainingObservedBytes: number,
): Promise<IgnoredFingerprintObservation> {
  const collapsedDirectory = rawPath.endsWith("/");
  const path = collapsedDirectory ? rawPath.slice(0, -1) : rawPath;
  assertFingerprintPath(source, path, "ignored");
  const candidate = resolve(source, path);
  let before: Awaited<ReturnType<typeof lstat>>;
  try {
    before = await lstat(candidate);
  } catch {
    throw new Error("Source checkout ignored-state entry changed before observation.");
  }
  const metadata = fingerprintMetadata(before, collapsedDirectory ? "directory" : "leaf");
  if (collapsedDirectory) {
    if (!before.isDirectory() || before.isSymbolicLink()) {
      return stableNotObserved(candidate, before, metadata, "unsupported-entry");
    }
    return stableNotObserved(candidate, before, metadata, "directory-content");
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    return stableNotObserved(candidate, before, metadata, "unsupported-entry");
  }
  if (uid === undefined || before.uid !== uid || (before.mode & 0o077) !== 0) {
    return stableNotObserved(candidate, before, metadata, "not-owner-private");
  }
  if (before.size > DELIVERY_ACCEPTANCE_IGNORED_STATE_POLICY.maximumObservedFileBytes) {
    return stableNotObserved(candidate, before, metadata, "file-size-limit");
  }
  if (before.size > remainingObservedBytes) {
    return stableNotObserved(candidate, before, metadata, "aggregate-byte-limit");
  }
  const bytes = await readStableFingerprintFile(candidate, before, "ignored");
  return { metadata, bytes };
}

async function stableNotObserved(
  candidate: string,
  before: Awaited<ReturnType<typeof lstat>>,
  metadata: Buffer,
  reason: DeliveryAcceptanceIgnoredNotObservedReason,
): Promise<IgnoredFingerprintObservation> {
  let after: Awaited<ReturnType<typeof lstat>>;
  try {
    after = await lstat(candidate);
  } catch {
    throw new Error("Source checkout ignored-state entry changed while observing metadata.");
  }
  if (!sameFingerprintEntry(before, after)) {
    throw new Error("Source checkout ignored-state entry changed while observing metadata.");
  }
  return { metadata, reason };
}

function fingerprintMetadata(
  value: Awaited<ReturnType<typeof lstat>>,
  kind: "directory" | "leaf",
): Buffer {
  return Buffer.from(
    [
      `kind=${kind}`,
      `mode=${value.mode}`,
      `size=${value.size}`,
      `uid=${value.uid}`,
      `links=${value.nlink}`,
      `modified=${value.mtimeMs}`,
      `changed=${value.ctimeMs}`,
    ].join("\n"),
    "utf8",
  );
}

async function safeFingerprintGit(source: string, args: readonly string[]): Promise<Buffer> {
  const result = await command("git", [...SAFE_READ_GIT_CONFIG, ...args], source, {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: "/dev/null",
    XDG_CONFIG_HOME: "/dev/null",
    LANG: "C",
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/usr/bin/false",
    SSH_ASKPASS: "/usr/bin/false",
    GIT_PAGER: "cat",
    GIT_ALLOW_PROTOCOL: "file",
  });
  if (result.exitCode !== 0) {
    throw new Error(`Source checkout fingerprint Git read failed (${args[0] ?? "unknown"}).`);
  }
  return result.stdout;
}

async function readBoundedUntrackedFile(source: string, path: string): Promise<Buffer> {
  assertFingerprintPath(source, path, "untracked");
  const candidate = resolve(source, path);
  const before = await lstat(candidate);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    before.size > MAX_FINGERPRINT_FILE_BYTES
  ) {
    throw new Error("Source checkout contains an unsafe untracked fingerprint entry.");
  }
  return readStableFingerprintFile(candidate, before, "untracked");
}

function assertFingerprintPath(source: string, path: string, label: "untracked" | "ignored"): void {
  if (
    isAbsolute(path) ||
    path.includes("\\") ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`Source checkout contains an unsafe ${label} fingerprint path.`);
  }
  const candidate = resolve(source, path);
  if (!nested(source, candidate)) {
    throw new Error(`Source checkout ${label} fingerprint path escaped the repository.`);
  }
}

async function readStableFingerprintFile(
  candidate: string,
  before: Awaited<ReturnType<typeof lstat>>,
  label: "untracked" | "ignored",
): Promise<Buffer> {
  if (typeof fsConstants.O_NOFOLLOW !== "number") {
    throw new Error(`Source checkout ${label} fingerprint requires no-follow file reads.`);
  }
  const noFollow = fsConstants.O_NOFOLLOW;
  let handle;
  try {
    handle = await open(candidate, fsConstants.O_RDONLY | noFollow);
  } catch {
    throw new Error(`Source checkout ${label} fingerprint entry changed before reading.`);
  }
  try {
    const descriptor = await handle.stat();
    if (!sameFingerprintFile(before, descriptor)) {
      throw new Error(`Source checkout ${label} fingerprint entry changed before reading.`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    let pathAfter: Awaited<ReturnType<typeof lstat>>;
    try {
      pathAfter = await lstat(candidate);
    } catch {
      throw new Error(`Source checkout ${label} fingerprint entry changed while reading.`);
    }
    if (
      bytes.byteLength !== before.size ||
      bytes.byteLength > MAX_FINGERPRINT_FILE_BYTES ||
      !sameFingerprintFile(before, after) ||
      !sameFingerprintFile(before, pathAfter)
    ) {
      throw new Error(`Source checkout ${label} fingerprint entry changed while reading.`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function sameFingerprintEntry(
  left: Awaited<ReturnType<typeof lstat>>,
  right: Awaited<ReturnType<typeof lstat>>,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.nlink === right.nlink &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function sameFingerprintFile(
  left: Awaited<ReturnType<typeof lstat>>,
  right: Awaited<ReturnType<typeof lstat>>,
): boolean {
  return (
    right.isFile() &&
    !right.isSymbolicLink() &&
    right.nlink === 1 &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function updateFingerprintDigest(
  digest: ReturnType<typeof createHash>,
  label: string,
  bytes: Uint8Array,
): void {
  digest.update(`${label.length}:${label}:${bytes.byteLength}:`);
  digest.update(bytes);
}

export function nested(parent: string, child: string): boolean {
  const value = relative(parent, child);
  return value !== "" && value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}
