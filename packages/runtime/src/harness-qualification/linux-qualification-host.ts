// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdtemp,
  open,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { canonicalDigest } from "../contract-kit/index.js";
import { parseJsonEvidence } from "../json-evidence.js";
import type {
  ExecutableObservation,
  HarnessQualificationHost,
  ToolDenialProbeObservation,
  ToolDenialProbeRequest,
  VerifiedStagingObservation,
  WorkspaceObservation,
} from "./adapters.js";
import { runBoundedProcess } from "./bounded-process.js";
import type { HarnessAttestationV1 } from "./contracts.js";
import {
  requireLinuxDescendantContainment,
  runContainedLinuxBoundedProcess,
} from "./linux-containment.js";
import { sha256 as sha256Text, sha256 as sha256Bytes } from "../content-ir/canonical.js";

const MAX_EXECUTABLE_BYTES = 512 * 1024 * 1024;
const HASH_CHUNK_BYTES = 1024 * 1024;
const MAX_SYMLINK_HOPS = 8;
const MAX_VERSION_BYTES = 128;
const STAGING_ENTRIES = ["input-digests.json", "output-schema.json", "prompt"] as const;
const INPUT_DIGEST_BINDING_KEYS = [
  "corpusManifestSha256",
  "caseSha256",
  "workflowSha256",
  "skillSha256",
  "qualitySha256",
  "outputSchemaSha256",
  "thresholdsSha256",
  "scorerSha256",
  "promptSha256",
] as const;
const ORACLE_NAME = /oracle|expected|scorer|rubric|baseline|\.git/iu;
const SHA256 = /^[a-f0-9]{64}$/u;

/**
 * Opt-in Linux PID-namespace qualification host. The default local host stays
 * fail-closed on every platform so Darwin and occupied adapter tests keep
 * fail-before-spawn. This factory never reports verified containment on Darwin.
 */
export function createLinuxContainedHarnessQualificationHost(): HarnessQualificationHost {
  const unavailable = async (): Promise<never> => {
    throw new Error("DocsFab local harness qualification is unavailable without containment.");
  };
  return {
    platform: () => {
      if (process.platform !== "darwin" && process.platform !== "linux") {
        throw new Error("DocsFab does not support harness qualification on this platform.");
      }
      return { os: process.platform, arch: process.arch };
    },
    descendantContainment: async (signal) => {
      if (process.platform !== "linux") return "unsupported";
      return requireLinuxDescendantContainment(signal);
    },
    inspectExecutable: process.platform === "linux" ? inspectQualificationExecutable : unavailable,
    workspaceManifest: process.platform === "linux" ? inspectWorkspaceManifest : unavailable,
    openVerifiedStaging: process.platform === "linux" ? openVerifiedStaging : unavailable,
    toolDenialProbe: async (request, signal) => toolDenialUnavailable(request, signal),
    runProcess: process.platform === "linux" ? runContainedLinuxBoundedProcess : runBoundedProcess,
  };
}

export function bindQualificationStagingManifest(input: {
  readonly prompt: Buffer;
  readonly outputSchemaJson: Buffer;
  readonly inputDigests: Pick<
    HarnessAttestationV1["inputDigests"],
    (typeof INPUT_DIGEST_BINDING_KEYS)[number]
  >;
}): string {
  return canonicalDigest({
    kind: "docsfab-qualification-staging",
    promptSha256: sha256Bytes(input.prompt),
    outputSchemaSha256: sha256Bytes(input.outputSchemaJson),
    inputDigests: input.inputDigests,
  });
}

async function inspectQualificationExecutable(
  absolutePath: string,
  signal: AbortSignal,
): Promise<ExecutableObservation> {
  if (signal.aborted) throw cancelled();
  const canonicalPath = await canonicalFile(absolutePath);
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const handle = await open(canonicalPath, constants.O_RDONLY | noFollow);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size < 1 || before.size > MAX_EXECUTABLE_BYTES) {
      throw unavailable();
    }
    const contentSha256 = createHash("sha256");
    const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
    let offset = 0;
    while (offset < before.size) {
      if (signal.aborted) throw cancelled();
      const requested = Math.min(buffer.byteLength, before.size - offset);
      const { bytesRead } = await handle.read(buffer, 0, requested, offset);
      if (bytesRead < 1) throw unavailable();
      contentSha256.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (signal.aborted) throw cancelled();
    const sha256 = contentSha256.digest("hex");
    const owner = typeof process.getuid === "function" ? process.getuid() : -1;
    const trusted =
      sameFile(before, after) &&
      offset === after.size &&
      (after.uid === 0 || after.uid === owner) &&
      (after.mode & 0o022) === 0 &&
      (after.mode & 0o111) !== 0;
    const reportedVersion = await readReportedVersion(canonicalPath, signal);
    return {
      basename: basename(canonicalPath),
      sha256,
      identitySha256: canonicalDigest({
        canonicalPathSha256: sha256Text(canonicalPath),
        device: String(after.dev),
        inode: String(after.ino),
        size: after.size,
        mode: after.mode,
        owner: after.uid,
        group: after.gid,
        contentSha256: sha256,
      }),
      reportedVersion,
      trusted: trusted && reportedVersion !== "unreported",
    };
  } finally {
    await handle.close();
  }
}

async function inspectWorkspaceManifest(
  absolutePath: string,
  signal: AbortSignal,
): Promise<WorkspaceObservation> {
  if (signal.aborted) throw cancelled();
  const canonicalPath = await canonicalDirectory(absolutePath);
  const details = await stat(canonicalPath);
  const entries = (await readdir(canonicalPath)).sort();
  if (entries.some((name) => ORACLE_NAME.test(name))) throw unavailable();
  return {
    canonicalPath,
    sha256: canonicalDigest({
      kind: "docsfab-qualification-workspace",
      canonicalPathSha256: sha256Text(canonicalPath),
      entries,
      mode: details.mode,
      owner: details.uid,
      device: String(details.dev),
      inode: String(details.ino),
    }),
    empty: entries.length === 0,
    ownerOnly: ownerOnlyDirectory(details),
  };
}

async function openVerifiedStaging(
  absolutePath: string,
  signal: AbortSignal,
): Promise<VerifiedStagingObservation> {
  if (signal.aborted) throw cancelled();
  const canonicalPath = await canonicalDirectory(absolutePath);
  const details = await stat(canonicalPath);
  const entries = (await readdir(canonicalPath)).sort();
  if (
    !ownerOnlyDirectory(details) ||
    entries.length !== STAGING_ENTRIES.length ||
    entries.some((name, index) => name !== STAGING_ENTRIES[index] || ORACLE_NAME.test(name))
  ) {
    throw unavailable();
  }
  for (const name of entries) {
    const child = joinPath(canonicalPath, name);
    const childDetails = await lstat(child);
    if (
      childDetails.isSymbolicLink() ||
      !childDetails.isFile() ||
      (childDetails.mode & 0o022) !== 0
    ) {
      throw unavailable();
    }
  }
  const prompt = await readFile(joinPath(canonicalPath, "prompt"));
  const outputSchemaJson = await readFile(joinPath(canonicalPath, "output-schema.json"));
  const digestBytes = await readFile(joinPath(canonicalPath, "input-digests.json"));
  const inputDigests = parseInputDigests(digestBytes);
  let outputSchema: unknown;
  try {
    outputSchema = parseJsonEvidence(outputSchemaJson);
  } catch {
    throw unavailable();
  }
  const expectedManifest = bindQualificationStagingManifest({
    prompt,
    outputSchemaJson,
    inputDigests: {
      corpusManifestSha256: inputDigests.corpusManifestSha256,
      caseSha256: inputDigests.caseSha256,
      workflowSha256: inputDigests.workflowSha256,
      skillSha256: inputDigests.skillSha256,
      qualitySha256: inputDigests.qualitySha256,
      outputSchemaSha256: inputDigests.outputSchemaSha256,
      thresholdsSha256: inputDigests.thresholdsSha256,
      scorerSha256: inputDigests.scorerSha256,
      promptSha256: inputDigests.promptSha256,
    },
  });
  const trusted =
    sha256Bytes(prompt) === inputDigests.promptSha256 &&
    canonicalDigest(outputSchema) === inputDigests.outputSchemaSha256 &&
    expectedManifest === inputDigests.stagingManifestSha256;
  return {
    canonicalPath,
    prompt,
    outputSchemaJson,
    inputDigests,
    trusted,
  };
}

async function toolDenialUnavailable(
  request: ToolDenialProbeRequest,
  signal: AbortSignal,
): Promise<ToolDenialProbeObservation> {
  if (signal.aborted) throw cancelled();
  return { status: "unsupported", bindingSha256: request.bindingSha256 };
}

async function readReportedVersion(executablePath: string, signal: AbortSignal): Promise<string> {
  const root = process.env.TMPDIR || tmpdir();
  if (!isAbsolute(root)) throw unavailable();
  const scratch = await mkdtemp(join(root, "docsfab-hq-ver-"));
  try {
    const observation = await runContainedLinuxBoundedProcess({
      executablePath,
      arguments: ["--version"],
      workingDirectory: scratch,
      environment: { HOME: scratch, LANG: "C", LC_ALL: "C", TMPDIR: scratch },
      stdin: Buffer.alloc(0),
      timeoutMs: 3_000,
      maxStdoutBytes: 4_096,
      maxStderrBytes: 4_096,
      signal,
    });
    if (observation.status !== "settled" || observation.exitCode !== 0) return "unreported";
    const text = observation.stdout.toString("utf8").trim().split("\n")[0] ?? "";
    if (text.length < 1 || text.length > MAX_VERSION_BYTES || text.includes("\0")) {
      return "unreported";
    }
    return text;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function canonicalFile(absolutePath: string): Promise<string> {
  if (!isAbsolute(absolutePath) || absolutePath.includes("\0")) throw unavailable();
  let current = resolve(absolutePath);
  for (let hop = 0; hop <= MAX_SYMLINK_HOPS; hop += 1) {
    const details = await lstat(current);
    if ((details.mode & 0o022) !== 0) throw unavailable();
    if (details.isFile()) return realpath(current);
    if (!details.isSymbolicLink()) throw unavailable();
    current = resolve(dirname(current), await readlink(current));
  }
  throw unavailable();
}

async function canonicalDirectory(absolutePath: string): Promise<string> {
  if (!isAbsolute(absolutePath) || absolutePath.includes("\0")) throw unavailable();
  const canonical = await realpath(resolve(absolutePath));
  const details = await lstat(canonical);
  if (details.isSymbolicLink() || !details.isDirectory()) throw unavailable();
  return canonical;
}

function parseInputDigests(bytes: Buffer): HarnessAttestationV1["inputDigests"] {
  let value: unknown;
  try {
    value = parseJsonEvidence(bytes);
  } catch {
    throw unavailable();
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw unavailable();
  const root = value as Record<string, unknown>;
  const keys = Object.keys(root).sort();
  const expectedKeys = [...INPUT_DIGEST_BINDING_KEYS, "stagingManifestSha256"].sort();
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw unavailable();
  }
  const result = {} as Record<
    (typeof INPUT_DIGEST_BINDING_KEYS)[number] | "stagingManifestSha256",
    string
  >;
  for (const key of [...INPUT_DIGEST_BINDING_KEYS, "stagingManifestSha256"] as const) {
    const digest = root[key];
    if (typeof digest !== "string" || !SHA256.test(digest)) throw unavailable();
    result[key] = digest;
  }
  return result;
}

function ownerOnlyDirectory(details: {
  uid: number;
  mode: number;
  isDirectory(): boolean;
}): boolean {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  return (
    uid !== undefined &&
    details.isDirectory() &&
    details.uid === uid &&
    (details.mode & 0o077) === 0
  );
}

function sameFile(
  before: { dev: number; ino: number; size: number; mode: number; uid: number; gid: number },
  after: { dev: number; ino: number; size: number; mode: number; uid: number; gid: number },
): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mode === after.mode &&
    before.uid === after.uid &&
    before.gid === after.gid
  );
}

function joinPath(root: string, name: string): string {
  const resolved = resolve(root, name);
  const relativePath = relative(root, resolved);
  if (relativePath.startsWith("..") || isAbsolute(relativePath) || relativePath.includes(sep)) {
    throw unavailable();
  }
  return resolved;
}

function unavailable(): Error {
  return new Error("DocsFab local harness qualification is unavailable without containment.");
}

function cancelled(): Error {
  return new Error("DocsFab stopped a bounded harness qualification operation.");
}
