// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Cross-process, root-local exclusion for run writes and physical index maintenance. */
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";

import { RUN_GATE_REMOVE_WORKER } from "./run-gate-remove-source.js";

export class RunMaintenanceGateError extends Error {
  public readonly code: "held" | "unsafe" | "tombstoned" | "object-deleted";
  public constructor(code: "held" | "unsafe" | "tombstoned" | "object-deleted") {
    super(
      code === "held"
        ? "Local run maintenance gate is held. Wait for the writer or deletion to finish; a complete gate with a proven-dead owner is recovered automatically. Inspect an unknown or incomplete lock before manual recovery."
        : code === "tombstoned"
          ? "This run was deleted. Create a new run ID instead of restoring its local files."
          : code === "object-deleted"
            ? "A referenced artifact object was deleted. Recreate that object before publishing this run record."
            : "Local run maintenance gate changed identity; inspect it before retrying.",
    );
    this.code = code;
    this.name = "RunMaintenanceGateError";
  }
}

/** Store object locators in supported run and sealed quality-validation contracts. */
export function referencedArtifactDigests(
  value: unknown,
  visitContainer: () => void = () => undefined,
): Set<string> {
  const digests = new Set<string>();
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;
    visitContainer();
    if (Array.isArray(node)) {
      for (const item of node) stack.push(item);
      continue;
    }
    const fields = node as Record<string, unknown>;
    if (
      fields.kind === "docsfab-review-locator-observation-reference" &&
      typeof fields.objectSha256 === "string" &&
      /^[a-f0-9]{64}$/u.test(fields.objectSha256)
    ) {
      digests.add(fields.objectSha256);
    }
    if (
      fields.kind === "docsfab-review-delivery-snapshot-reference" &&
      typeof fields.rootObjectSha256 === "string" &&
      /^[a-f0-9]{64}$/u.test(fields.rootObjectSha256)
    ) {
      // The low-level writer gate collects known object pointers conservatively.
      // Deletion separately decodes the complete run-bound reference and graph.
      digests.add(fields.rootObjectSha256);
    }
    if (fields.kind === "docsfab-quality-artifact-validation-binding") {
      // The low-level writer gate collects known locator fields conservatively.
      // Deletion independently decodes and validates the sealed binding.
      if (
        typeof fields.bindingSha256 === "string" &&
        /^[a-f0-9]{64}$/u.test(fields.bindingSha256)
      ) {
        digests.add(fields.bindingSha256);
      }
      for (const group of [fields.artifacts, fields.validators]) {
        if (!group || typeof group !== "object" || Array.isArray(group)) continue;
        for (const entry of Object.values(group)) {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
          for (const key of ["recordSha256", "receiptSha256"] as const) {
            const digest = (entry as Record<string, unknown>)[key];
            if (typeof digest === "string" && /^[a-f0-9]{64}$/u.test(digest)) digests.add(digest);
          }
        }
      }
    }
    const reference = fields.reference;
    if (reference && typeof reference === "object" && !Array.isArray(reference)) {
      const candidate = reference as Record<string, unknown>;
      if (
        typeof candidate.kind === "string" &&
        typeof candidate.digest === "string" &&
        /^[a-f0-9]{64}$/u.test(candidate.digest) &&
        typeof candidate.repositoryRevision === "string" &&
        typeof candidate.repositoryContentDigest === "string"
      ) {
        digests.add(candidate.digest);
      }
    }
    for (const item of Object.values(fields)) stack.push(item);
  }
  return digests;
}

function tombstonePath(directory: string, runId: string): string {
  const digest = createHash("sha256")
    .update("docsfab-run-deletion-tombstone-v1\0")
    .update(directory)
    .update("\0")
    .update(runId)
    .digest("hex");
  return join(directory, ".docsfab-run-delete-tombstones", digest);
}

export async function assertRunNotTombstoned(directory: string, runId: string): Promise<void> {
  if (await isRunTombstoned(directory, runId)) {
    throw new RunMaintenanceGateError("tombstoned");
  }
}

export async function isRunTombstoned(directory: string, runId: string): Promise<boolean> {
  const root = await realpath(directory);
  const path = tombstonePath(root, runId);
  try {
    const stat = await lstat(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o077) !== 0
    ) {
      throw new RunMaintenanceGateError("unsafe");
    }
    return true;
  } catch (error) {
    if (nodeCode(error) === "ENOENT") return false;
    throw error;
  }
}

/** Called with the run gate held before the first irreversible deletion step. */
export async function writeRunTombstone(directory: string, runId: string): Promise<void> {
  const root = await realpath(directory);
  const tombstones = join(root, ".docsfab-run-delete-tombstones");
  await mkdir(tombstones, { recursive: true, mode: 0o700 });
  const directoryStat = await lstat(tombstones);
  if (
    !directoryStat.isDirectory() ||
    directoryStat.isSymbolicLink() ||
    directoryStat.uid !== process.getuid?.() ||
    (directoryStat.mode & 0o077) !== 0
  ) {
    throw new RunMaintenanceGateError("unsafe");
  }
  const path = tombstonePath(root, runId);
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile("deleting-or-deleted\n");
    await handle.sync();
  } finally {
    await handle.close();
  }
  const parent = await open(
    tombstones,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const pinned = await parent.stat();
    if (pinned.dev !== directoryStat.dev || pinned.ino !== directoryStat.ino) {
      throw new RunMaintenanceGateError("unsafe"); // hygiene: ok -- typed gate code; its constructor supplies the operator-safe message.
    }
    await parent.sync();
  } finally {
    await parent.close();
  }
}

function nodeCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

/** Candidate pools used by the supported CLI and host-invoker state layouts. */
export async function withArtifactReferenceGates<T>(
  stateDirectory: string,
  action: () => Promise<T>,
): Promise<T> {
  const root = await realpath(stateDirectory);
  const candidates = [join(dirname(root), "artifacts"), join(root, "artifacts")].sort();
  const existing: string[] = [];
  for (const candidate of candidates) {
    try {
      const stat = await lstat(candidate);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new RunMaintenanceGateError("unsafe");
      existing.push(candidate);
    } catch (error) {
      if (nodeCode(error) !== "ENOENT") throw error;
    }
  }
  const visit = async (index: number): Promise<T> => {
    if (index === existing.length) return action();
    return withRunMaintenanceGate(existing[index] as string, () => visit(index + 1));
  };
  return visit(0);
}

/** Serialize legacy patch writers whose collector only knows the patch root. */
export async function withPatchRootGates<T>(
  stateDirectory: string,
  extraRoots: readonly string[],
  action: (roots: readonly string[]) => Promise<T>,
): Promise<T> {
  const root = await realpath(stateDirectory);
  const candidates = [
    ...new Set([join(dirname(root), "patches"), join(root, "patches"), ...extraRoots]),
  ].sort();
  const existing: string[] = [];
  for (const candidate of candidates) {
    try {
      const stat = await lstat(candidate);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new RunMaintenanceGateError("unsafe");
      existing.push(candidate);
    } catch (error) {
      if (nodeCode(error) !== "ENOENT") throw error;
    }
  }
  const visit = async (index: number): Promise<T> => {
    if (index === existing.length) return action(existing);
    return withRunMaintenanceGate(existing[index] as string, () => visit(index + 1));
  };
  return visit(0);
}

/** Reject a late record publication if deletion removed its referenced object. */
export async function assertNoDeletedArtifactReferences(
  stateDirectory: string,
  record: unknown,
): Promise<void> {
  const root = await realpath(stateDirectory);
  for (const digest of referencedArtifactDigests(record)) {
    for (const artifactRoot of [join(dirname(root), "artifacts"), join(root, "artifacts")]) {
      const marker = join(artifactRoot, ".docsfab-run-deleted-objects", digest);
      try {
        await lstat(marker);
      } catch (error) {
        if (nodeCode(error) === "ENOENT") continue;
        throw error;
      }
      const objectPath = join(artifactRoot, "objects", "sha256", `${digest}.json`);
      try {
        const stat = await lstat(objectPath);
        if (stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1) continue;
      } catch (error) {
        if (nodeCode(error) !== "ENOENT") throw error;
      }
      throw new RunMaintenanceGateError("object-deleted");
    }
  }
}

/** Called under the artifact-reference gate before unlinking a unique object. */
export async function markArtifactObjectForDeletion(root: string, digest: string): Promise<void> {
  if (!/^[a-f0-9]{64}$/u.test(digest)) throw new RunMaintenanceGateError("unsafe");
  const markerRoot = join(root, ".docsfab-run-deleted-objects");
  await mkdir(markerRoot, { recursive: true, mode: 0o700 });
  const directory = await lstat(markerRoot);
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    directory.uid !== process.getuid?.() ||
    (directory.mode & 0o077) !== 0
  ) {
    throw new RunMaintenanceGateError("unsafe");
  }
  const path = join(markerRoot, digest);
  try {
    const handle = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile("deleted-object-digest\n");
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (nodeCode(error) !== "EEXIST") throw error;
    const existing = await lstat(path);
    if (
      !existing.isFile() ||
      existing.isSymbolicLink() ||
      existing.nlink !== 1 ||
      existing.uid !== process.getuid?.() ||
      (existing.mode & 0o077) !== 0
    ) {
      throw new RunMaintenanceGateError("unsafe");
    }
  }
}

/** A newly committed object supersedes its old deletion marker under the same pool gate. */
export async function clearArtifactDeletionMarker(root: string, digest: string): Promise<void> {
  if (!/^[a-f0-9]{64}$/u.test(digest)) throw new RunMaintenanceGateError("unsafe");
  const path = join(root, ".docsfab-run-deleted-objects", digest);
  try {
    const existing = await lstat(path);
    if (
      !existing.isFile() ||
      existing.isSymbolicLink() ||
      existing.nlink !== 1 ||
      existing.uid !== process.getuid?.() ||
      (existing.mode & 0o077) !== 0
    ) {
      throw new RunMaintenanceGateError("unsafe");
    }
    await unlink(path);
  } catch (error) {
    if (nodeCode(error) !== "ENOENT") throw error;
  }
}

export async function withRunMaintenanceGate<T>(
  directory: string,
  action: () => Promise<T>,
  onContention?: () => void | Promise<void>,
): Promise<T> {
  return withNamedRunGate(directory, ".docsfab-run-maintenance.lock", action, onContention);
}

/** One long-lived publication/run exclusion, keyed without persisting a raw run ID. */
export async function withActiveRunGate<T>(
  directory: string,
  runId: string,
  action: () => Promise<T>,
): Promise<T> {
  const root = await realpath(directory);
  const digest = createHash("sha256")
    .update("docsfab-active-run-gate-v1\0")
    .update(root)
    .update("\0")
    .update(runId)
    .digest("hex");
  return withNamedRunGate(root, `.docsfab-run-active-${digest}.lock`, action);
}

async function withNamedRunGate<T>(
  directory: string,
  name: string,
  action: () => Promise<T>,
  onContention?: () => void | Promise<void>,
): Promise<T> {
  const root = await realpath(directory);
  const rootStat = await lstat(root);
  if (
    !rootStat.isDirectory() ||
    rootStat.isSymbolicLink() ||
    (typeof process.getuid === "function" && rootStat.uid !== process.getuid())
  ) {
    throw new RunMaintenanceGateError("unsafe"); // hygiene: ok -- typed gate code; its constructor supplies the operator-safe message.
  }
  const gate = join(root, name);
  const owner = join(gate, "owner.json");
  const token = randomUUID();
  // Limits imports the run-store observation reader. Load it after this leaf
  // module initializes so the persistence package has no static value cycle.
  const { limit } = await import("../config/limits.js");
  const attempts = limit("runs.deletionGateAttempts");
  const retryPause = limit("runs.deletionGateRetryPauseMs");
  let acquired = false;
  for (let attempt = 1; attempt <= attempts.value; attempt += 1) {
    try {
      await mkdir(gate, { mode: 0o700 });
      acquired = true;
      break;
    } catch (error) {
      if (nodeCode(error) !== "EEXIST") throw error;
      const observed = await observeRunGateOwner(gate, owner, rootStat.uid);
      if (
        onContention &&
        observed !== null &&
        typeof observed === "object" &&
        !runGateOwnerIsDead(observed.pid)
      ) {
        await onContention();
        onContention = undefined;
      }
      if (
        observed === undefined ||
        (typeof observed === "object" && observed !== null && runGateOwnerIsDead(observed.pid))
      ) {
        if (typeof observed === "object" && observed !== null) {
          await removeObservedRunGate(root, name, rootStat, observed, "recover");
        }
        // Retry once within this configured attempt after a released name or
        // proven-dead generation. A live successor still wins EEXIST.
        try {
          await mkdir(gate, { mode: 0o700 });
          acquired = true;
          break;
        } catch (retryError) {
          if (nodeCode(retryError) !== "EEXIST") throw retryError;
        }
      }
      if (attempt === attempts.value) {
        if (observed === "pending") {
          throw new RunMaintenanceGateError("unsafe"); // hygiene: ok -- typed gate code; its constructor supplies the operator-safe message.
        }
        throw new RunMaintenanceGateError("held");
      }
      await pause(retryPause.value);
    }
  }
  if (!acquired) throw new RunMaintenanceGateError("held");
  const gateStat = await lstat(gate);
  if (
    !gateStat.isDirectory() ||
    gateStat.isSymbolicLink() ||
    gateStat.uid !== rootStat.uid ||
    (gateStat.mode & 0o7777) !== 0o700
  ) {
    throw new RunMaintenanceGateError("unsafe"); // hygiene: ok -- typed gate code; its constructor supplies the operator-safe message.
  }
  let ownerStat: Awaited<ReturnType<typeof lstat>> | undefined;
  let actionFailure: unknown;
  try {
    const handle = await open(
      owner,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, token }));
      await handle.sync();
      ownerStat = await handle.stat();
    } finally {
      await handle.close();
    }
    const currentRoot = await lstat(root);
    const observed = await observeRunGateOwner(gate, owner, rootStat.uid);
    if (
      !observed ||
      currentRoot.dev !== rootStat.dev ||
      currentRoot.ino !== rootStat.ino ||
      typeof observed !== "object" ||
      observed.gate.dev !== gateStat.dev ||
      observed.gate.ino !== gateStat.ino ||
      observed.owner.dev !== ownerStat.dev ||
      observed.owner.ino !== ownerStat.ino ||
      observed.pid !== process.pid ||
      observed.token !== token
    ) {
      throw new RunMaintenanceGateError("unsafe"); // hygiene: ok -- typed gate code; its constructor supplies the operator-safe message.
    }
    return await action();
  } catch (error) {
    actionFailure = error;
    throw error;
  } finally {
    try {
      if (!ownerStat) throw new RunMaintenanceGateError("unsafe"); // hygiene: ok -- typed gate code; its constructor supplies the operator-safe message.
      const removed = await removeObservedRunGate(
        root,
        name,
        rootStat,
        { gate: gateStat, owner: ownerStat, pid: process.pid, token },
        "release",
      );
      if (removed !== "removed") throw new RunMaintenanceGateError("unsafe"); // hygiene: ok -- typed gate code; its constructor supplies the operator-safe message.
    } catch (error) {
      if (actionFailure === undefined) throw error;
    }
  }
}

interface ObservedRunGateOwner {
  readonly gate: Awaited<ReturnType<typeof lstat>>;
  readonly owner: Awaited<ReturnType<typeof lstat>>;
  readonly pid: number;
  readonly token: string;
}

const RUN_GATE_OWNER_MAX_BYTES = Buffer.byteLength(
  JSON.stringify({ pid: Number.MAX_SAFE_INTEGER, token: "00000000-0000-4000-8000-000000000000" }),
);
const RUN_GATE_TOKEN = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;

async function observeRunGateOwner(
  gate: string,
  owner: string,
  uid: number,
): Promise<ObservedRunGateOwner | "pending" | "changed" | null | undefined> {
  let gateStat: Awaited<ReturnType<typeof lstat>>;
  try {
    gateStat = await lstat(gate);
  } catch (error) {
    if (nodeCode(error) === "ENOENT") return undefined;
    throw new RunMaintenanceGateError("unsafe"); // hygiene: ok -- typed gate code; its constructor supplies the operator-safe message.
  }
  if (
    !gateStat.isDirectory() ||
    gateStat.isSymbolicLink() ||
    gateStat.uid !== uid ||
    (gateStat.mode & 0o7777) !== 0o700
  ) {
    throw new RunMaintenanceGateError("unsafe"); // hygiene: ok -- typed gate code; its constructor supplies the operator-safe message.
  }
  let handle;
  try {
    handle = await open(owner, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (nodeCode(error) === "ENOENT") {
      // The release window or an unfinished initializer is ambiguous. Even
      // if a later lstat finds an empty directory, never reclaim it.
      let current: Awaited<ReturnType<typeof lstat>>;
      try {
        current = await lstat(gate);
      } catch (currentError) {
        if (nodeCode(currentError) === "ENOENT") return undefined;
        throw new RunMaintenanceGateError("unsafe"); // hygiene: ok -- typed gate code; its constructor supplies the operator-safe message.
      }
      if (
        !current.isDirectory() ||
        current.isSymbolicLink() ||
        current.uid !== uid ||
        (current.mode & 0o7777) !== 0o700
      ) {
        throw new RunMaintenanceGateError("unsafe"); // hygiene: ok -- typed gate code; its constructor supplies the operator-safe message.
      }
      if (current.dev !== gateStat.dev || current.ino !== gateStat.ino) return "changed";
      return null;
    }
    throw new RunMaintenanceGateError("unsafe"); // hygiene: ok -- typed gate code; its constructor supplies the operator-safe message.
  }
  try {
    let stat: Awaited<ReturnType<typeof handle.stat>>;
    try {
      stat = await handle.stat();
    } catch {
      throw new RunMaintenanceGateError("unsafe"); // hygiene: ok -- typed gate code; its constructor supplies the operator-safe message.
    }
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.uid !== uid ||
      (stat.mode & 0o7777) !== 0o600 ||
      stat.size > RUN_GATE_OWNER_MAX_BYTES
    ) {
      throw new RunMaintenanceGateError("unsafe"); // hygiene: ok -- typed gate code; its constructor supplies the operator-safe message.
    }
    // A real holder may unlink its owner after our open and before this stat.
    // The detached descriptor cannot authorize recovery; observe the name afresh.
    if (stat.nlink === 0) return "changed";
    if (stat.nlink !== 1) {
      throw new RunMaintenanceGateError("unsafe"); // hygiene: ok -- typed gate code; its constructor supplies the operator-safe message.
    }
    const buffer = Buffer.alloc(RUN_GATE_OWNER_MAX_BYTES + 1);
    let bytesRead: number;
    try {
      ({ bytesRead } = await handle.read(buffer, 0, buffer.length, 0));
    } catch {
      throw new RunMaintenanceGateError("unsafe"); // hygiene: ok -- typed gate code; its constructor supplies the operator-safe message.
    }
    if (bytesRead > RUN_GATE_OWNER_MAX_BYTES) {
      throw new RunMaintenanceGateError("unsafe"); // hygiene: ok -- typed gate code; its constructor supplies the operator-safe message.
    }
    if (bytesRead !== stat.size) return "pending";
    const bytes = buffer.subarray(0, bytesRead).toString("utf8");
    let value: unknown;
    try {
      value = JSON.parse(bytes);
    } catch {
      // An exclusive creator publishes owner bytes after the name appears.
      // Only a complete, validated record can authorize liveness recovery.
      return "pending";
    }
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).length !== 2 ||
      !Object.hasOwn(value, "pid") ||
      !Object.hasOwn(value, "token")
    ) {
      throw new RunMaintenanceGateError("unsafe"); // hygiene: ok -- typed gate code; its constructor supplies the operator-safe message.
    }
    const record = value as { pid: unknown; token: unknown };
    if (
      !Number.isSafeInteger(record.pid) ||
      (record.pid as number) <= 0 ||
      typeof record.token !== "string" ||
      !RUN_GATE_TOKEN.test(record.token) ||
      JSON.stringify(record) !== bytes
    ) {
      throw new RunMaintenanceGateError("unsafe"); // hygiene: ok -- typed gate code; its constructor supplies the operator-safe message.
    }
    let currentGate: Awaited<ReturnType<typeof lstat>>;
    try {
      currentGate = await lstat(gate);
    } catch (error) {
      if (nodeCode(error) === "ENOENT") return undefined;
      throw new RunMaintenanceGateError("unsafe"); // hygiene: ok -- typed gate code; its constructor supplies the operator-safe message.
    }
    let currentOwner: Awaited<ReturnType<typeof lstat>>;
    try {
      currentOwner = await lstat(owner);
    } catch (error) {
      if (nodeCode(error) === "ENOENT") return null;
      throw new RunMaintenanceGateError("unsafe"); // hygiene: ok -- typed gate code; its constructor supplies the operator-safe message.
    }
    // A holder's release can unlink the owner while this lstat runs; the
    // kernel then reports the doomed name with no links. That is the release
    // in progress the descriptor check above allows for, not an unsafe gate,
    // so the caller observes the name afresh.
    const ownerUnlinking = currentOwner.nlink === 0;
    if (
      !currentGate.isDirectory() ||
      currentGate.isSymbolicLink() ||
      currentGate.uid !== uid ||
      (currentGate.mode & 0o7777) !== 0o700 ||
      !currentOwner.isFile() ||
      currentOwner.isSymbolicLink() ||
      currentOwner.uid !== uid ||
      (currentOwner.mode & 0o7777) !== 0o600 ||
      (currentOwner.nlink !== 1 && !ownerUnlinking) ||
      currentOwner.size > RUN_GATE_OWNER_MAX_BYTES
    ) {
      throw new RunMaintenanceGateError("unsafe"); // hygiene: ok -- typed gate code; its constructor supplies the operator-safe message.
    }
    if (ownerUnlinking) return "changed";
    if (
      currentGate.dev !== gateStat.dev ||
      currentGate.ino !== gateStat.ino ||
      currentOwner.dev !== stat.dev ||
      currentOwner.ino !== stat.ino
    ) {
      return "changed";
    }
    return { gate: gateStat, owner: stat, pid: record.pid as number, token: record.token };
  } finally {
    await handle.close();
  }
}

function runGateOwnerIsDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if (nodeCode(error) === "ESRCH") return true;
    if (nodeCode(error) === "EPERM") return false;
    throw new RunMaintenanceGateError("unsafe"); // hygiene: ok -- typed gate code; its constructor supplies the operator-safe message.
  }
}

async function removeObservedRunGate(
  root: string,
  name: string,
  rootStat: Awaited<ReturnType<typeof lstat>>,
  observed: ObservedRunGateOwner,
  operation: "recover" | "release",
): Promise<"removed" | "changed"> {
  const { limit } = await import("../config/limits.js");
  const timeout = limit("runs.deletionGateHelperTimeoutMs");
  const input = JSON.stringify({
    operation,
    name,
    root: {
      dev: Number(rootStat.dev),
      ino: Number(rootStat.ino),
      uid: Number(rootStat.uid),
      mode: Number(rootStat.mode) & 0o7777,
    },
    gate: { dev: Number(observed.gate.dev), ino: Number(observed.gate.ino) },
    owner: { dev: Number(observed.owner.dev), ino: Number(observed.owner.ino) },
    pid: observed.pid,
    token: observed.token,
  });
  return new Promise((resolveResult, rejectResult) => {
    // The fixed helper emits nothing and captures no output. A timeout leaves
    // the lock state unknown and refuses rather than guessing at cleanup.
    const child = spawn(process.execPath, ["--input-type=module", "-e", RUN_GATE_REMOVE_WORKER], {
      cwd: root,
      env: { DOCSFAB_RUN_GATE_REMOVE: input, LC_ALL: "C", LANG: "C" },
      stdio: "ignore",
      windowsHide: true,
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeout.value);
    child.once("error", () => {
      clearTimeout(timer);
      rejectResult(new RunMaintenanceGateError("unsafe"));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (timedOut || (code !== 0 && code !== 3)) {
        rejectResult(new RunMaintenanceGateError("unsafe"));
      } else {
        resolveResult(code === 0 ? "removed" : "changed");
      }
    });
  });
}
