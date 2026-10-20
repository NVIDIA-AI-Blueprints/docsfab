// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Approved local delivery targets for one run; no receipt or plan bodies are retained. */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath, rmdir, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { resolveDocsFabPublicationRoots } from "../config/host-paths.js";
import { limit, refuseLimit } from "../config/limits.js";
import type { JsonEvidenceValue } from "../json-evidence.js";
import { FileRunStore } from "../records/file-store.js";
import { DurableArtifactStore } from "../artifacts/store.js";
import { inspectReviewIntentForDeletion } from "../review-delivery/inspection-intent.js";
import { decodeSavedRunRecord } from "../records/saved-run-record.js";
import { runRecordMaxBytes } from "../records/run-record-limit.js";
import {
  projectRunRetainedDeliveryV1,
  unavailableRunRetainedDelivery,
  type RunRetainedDeliveryV1,
} from "../records/retained-delivery.js";
import { redactCredentialMaterial } from "../security/credential-material.js";
import { withDeliveryRootGates } from "./delivery-root-gates.js";
import {
  assertRemovedWorktreeRegistration,
  inspectRunDeliveryBranches,
  inspectRunDeliveryWorktree,
  type RunDeliveryWorktreeCleanupEvidence,
} from "./worktree/run-deletion-cleanup.js";
import { FileScmDeliveryReceiptStore } from "./receipt-store.js";
import { deliveryCapsuleName } from "./worktree/materialize.js";
import {
  inventoryRunDeliveryIndexUnderGate,
  purgeRunDeliveryIndexUnderGate,
  type RunDeliveryIndexDeletionChain,
  type RunDeliveryIndexKeySpace,
} from "./run-delivery-index.js";

const SHA256 = /^[a-f0-9]{64}$/u;
export const RUN_DELIVERY_ATTEMPT_LOCATIONS = ".docsfab-run-delivery-attempts";
export { withDeliveryRootGates } from "./delivery-root-gates.js";

export interface RunDeliveryEntryIdentity {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly kind: "file" | "directory";
  readonly sha256?: string;
}

/** Negative ownership evidence for one complete, strictly inspected review journal. */
export interface UnrelatedReviewReceiptIdentity {
  readonly root: string;
  readonly idempotencyKey: string;
  readonly rootEntry: RunDeliveryEntryIdentity;
  readonly entries: readonly RunDeliveryEntryIdentity[];
}

/** Apply only identities that appeared in the approved inventory. The coordinator owns the outer run gate. */
export async function applyRunDeliveryDeletion(
  inventory: RunDeliveryDeletionInventory,
  hooks: RunDeliveryDeletionHooks = {},
): Promise<RunDeliveryDeletionResult> {
  return withDeliveryRootGates(inventory.receiptRoots, () =>
    applyRunDeliveryDeletionUnderGate(inventory, hooks),
  );
}

/** Only the confirmed run-deletion coordinator may call this while holding every receipt root. */
export async function applyRunDeliveryDeletionUnderGate(
  inventory: RunDeliveryDeletionInventory,
  hooks: RunDeliveryDeletionHooks = {},
): Promise<RunDeliveryDeletionResult> {
  const { digest: approvedDigest, ...body } = inventory;
  if (approvedDigest !== runDeliveryInventoryDigest(body))
    throw new Error(
      "The approved delivery inventory changed after preview; inspect it and preview again.",
    );
  if (
    inventory.index.root !==
      resolveDocsFabPublicationRoots({}, inventory.stateDirectory).receiptRoot ||
    inventory.receiptRoots.some((root) => !isAbsolute(root) || resolve(root) !== root) ||
    inventory.deliveryRoots.some((root) => !isAbsolute(root) || resolve(root) !== root)
  ) {
    throw new Error(
      "The approved delivery roots changed after preview; inspect them and preview again.",
    );
  }
  for (const receipt of inventory.receipts) {
    if (
      !inventory.receiptRoots.includes(receipt.root) ||
      !SHA256.test(receipt.idempotencyKey) ||
      receipt.entries[0]?.path !== join(receipt.root, receipt.idempotencyKey)
    ) {
      throw new Error(
        "The approved receipt path changed after preview; inspect it and preview again.",
      );
    }
  }
  for (const plan of inventory.plans) {
    if (
      !inventory.receiptRoots.includes(plan.root) ||
      plan.entry.path !== join(plan.root, `plan-${plan.planSha256}.json`)
    ) {
      throw new Error(
        "The approved plan path changed after preview; inspect it and preview again.",
      );
    }
  }
  for (const attempt of inventory.attempts) {
    if (
      !inventory.deliveryRoots.includes(attempt.root) ||
      dirname(attempt.path) !== join(attempt.root, "attempts") ||
      attempt.entries[0]?.path !== attempt.path
    )
      throw new Error(
        "The approved attempt path changed after preview; inspect it and preview again.",
      );
  }
  for (const entry of inventory.metadata) {
    if (dirname(entry.path) !== join(inventory.stateDirectory, RUN_DELIVERY_ATTEMPT_LOCATIONS)) {
      throw new Error(
        "The approved attempt metadata path changed after preview; inspect it and preview again.",
      );
    }
  }
  {
    // Precheck all existing leaves before the first irreversible index rebuild.
    for (const entry of [
      ...inventory.receipts.flatMap((receipt) => receipt.entries),
      ...inventory.plans.map((plan) => plan.entry),
      ...inventory.attempts.flatMap((attempt) => attempt.entries),
      ...inventory.metadata,
    ]) {
      if (await exists(entry.path)) await assertIdentity(entry);
    }
    const unresolved = [...inventory.unresolved];
    const shared = new Set(
      inventory.plans.filter((plan) => plan.shared).map((plan) => plan.entry.path),
    );
    for (const plan of inventory.plans.filter((candidate) => !candidate.shared)) {
      if (await retainedReceiptReferencesPlan(plan.root, plan.planSha256, inventory.runId)) {
        shared.add(plan.entry.path);
      }
    }
    const cleared = new Set<string>();
    for (const attempt of inventory.attempts.filter(
      (candidate) => candidate.requiresWorktreeCleanup,
    )) {
      const evidence = hooks.clearedWorktrees?.find(
        (candidate) => candidate.attemptPath === attempt.path,
      );
      if (!evidence) continue;
      await assertRemovedWorktreeRegistration(inventory, attempt, evidence);
      cleared.add(attempt.path);
    }
    let removed = await purgeRunDeliveryIndexUnderGate({
      indexRoot: inventory.index.root,
      runId: inventory.runId,
      recordSha256: inventory.recordSha256,
      chains: inventory.index.affected,
      afterKeyspace: hooks.afterIndexKeyspace,
    });
    for (const attempt of inventory.attempts) {
      const registrationStillPresent =
        attempt.requiresWorktreeCleanup &&
        (
          await Promise.all(
            attempt.entries
              .filter((entry) => entry.path.endsWith("/repository/.git"))
              .map((entry) => exists(entry.path)),
          )
        ).some(Boolean);
      if (
        attempt.requiresWorktreeCleanup &&
        (!cleared.has(attempt.path) || registrationStillPresent)
      ) {
        unresolved.push(
          `Registered Git worktree at ${attempt.path} needs exact published-delivery cleanup authority before local deletion.`,
        );
        continue;
      }
      removed += await removeApprovedEntries(attempt.entries, hooks.afterRemove);
    }
    for (const receipt of inventory.receipts)
      removed += await removeApprovedEntries(receipt.entries, hooks.afterRemove);
    for (const plan of inventory.plans)
      if (!shared.has(plan.entry.path)) {
        removed += await removeApprovedEntries([plan.entry], hooks.afterRemove);
      }
    for (const entry of inventory.metadata) {
      if (!(await exists(entry.path))) continue;
      const location = JSON.parse(await readFile(entry.path, "utf8")) as RunDeliveryAttemptLocation;
      if (await exists(location.attemptPath)) {
        unresolved.push(
          `Retained attempt ${location.attemptPath} still needs cleanup; keep its private location metadata and retry.`,
        );
        continue;
      }
      removed += await removeApprovedEntries([entry], hooks.afterRemove);
    }
    return {
      removed,
      sharedRetained: shared.size,
      unresolved,
      ...(unresolved.length ? { nextAction: unresolved.join(" ") } : {}),
    };
  }
}

async function retainedReceiptReferencesPlan(
  root: string,
  planSha256: string,
  targetRunId: string,
): Promise<boolean> {
  const store = new FileScmDeliveryReceiptStore(root);
  for (const name of await readdir(root)) {
    if (!SHA256.test(name)) continue;
    const loaded = await store.loadEither(name);
    if (
      loaded?.kind === "scm" &&
      loaded.record.run.id !== targetRunId &&
      loaded.record.planSha256 === planSha256
    )
      return true;
  }
  return false;
}

async function assertIdentity(expected: RunDeliveryEntryIdentity): Promise<void> {
  const current = await identity(expected.path, expected.kind);
  if (JSON.stringify(current) !== JSON.stringify(expected)) {
    throw new Error(
      `The delivery entry changed since preview at ${expected.path}; inspect it and preview again.`,
    );
  }
}

async function removeApprovedEntries(
  entries: readonly RunDeliveryEntryIdentity[],
  afterRemove?: (path: string) => void | Promise<void>,
): Promise<number> {
  let removed = 0;
  for (const entry of [...entries].reverse()) {
    if (!(await exists(entry.path))) continue;
    await assertIdentity(entry);
    if (entry.kind === "directory") await rmdir(entry.path);
    else await unlink(entry.path);
    removed += 1;
    await afterRemove?.(entry.path);
  }
  return removed;
}

interface RunDeliveryAttemptLocationBase {
  readonly kind: "docsfab-run-delivery-attempt-location";
  readonly stateDirectory: string;
  readonly runId: string;
  readonly recordSha256: string;
  readonly deliveryRoot: string;
  readonly attemptPath: string;
  readonly planSha256: string;
}

export type RunDeliveryAttemptLocation =
  | (RunDeliveryAttemptLocationBase & { readonly schemaVersion: 1 })
  | (RunDeliveryAttemptLocationBase & {
      readonly schemaVersion: 2;
      readonly receiptRoot: string;
    });

export interface RunDeliveryDeletionInventory {
  readonly schemaVersion: 1;
  readonly kind: "docsfab-run-delivery-deletion-inventory";
  readonly stateDirectory: string;
  readonly runId: string;
  readonly recordSha256: string;
  readonly receiptRoots: readonly string[];
  readonly deliveryRoots: readonly string[];
  readonly receipts: readonly {
    root: string;
    idempotencyKey: string;
    planSha256: string;
    entries: readonly RunDeliveryEntryIdentity[];
  }[];
  /** Absent in older private deletion journals, which retain strict resume behavior. */
  readonly unrelatedReviewReceipts?: readonly UnrelatedReviewReceiptIdentity[];
  readonly plans: readonly {
    root: string;
    planSha256: string;
    entry: RunDeliveryEntryIdentity;
    shared: boolean;
  }[];
  readonly attempts: readonly {
    root: string;
    path: string;
    planSha256: string;
    entries: readonly RunDeliveryEntryIdentity[];
    requiresWorktreeCleanup: boolean;
  }[];
  readonly metadata: readonly RunDeliveryEntryIdentity[];
  readonly index: { root: string; affected: readonly RunDeliveryIndexDeletionChain[] };
  readonly sharedRetained: number;
  readonly unresolved: readonly string[];
  readonly digest: string;
}

export interface RunDeliveryDeletionResult {
  readonly removed: number;
  readonly sharedRetained: number;
  readonly unresolved: readonly string[];
  readonly nextAction?: string;
}

export interface RemainingRunDeliveryTargets {
  readonly remaining: number;
  readonly maintenanceIncomplete: boolean;
  readonly unresolved: readonly string[];
}

/** Read-only remaining count for journal resume and truthful cumulative reporting. */
export async function countRemainingRunDeliveryTargets(
  inventory: RunDeliveryDeletionInventory,
  clearedWorktrees: readonly RunDeliveryWorktreeCleanupEvidence[] = [],
): Promise<RemainingRunDeliveryTargets> {
  return withDeliveryRootGates(inventory.receiptRoots, () =>
    countRemainingRunDeliveryTargetsUnderGate(inventory, clearedWorktrees),
  );
}

/** Internal held-root count; public callers acquire the gates themselves. */
export async function countRemainingRunDeliveryTargetsUnderGate(
  inventory: RunDeliveryDeletionInventory,
  clearedWorktrees: readonly RunDeliveryWorktreeCleanupEvidence[] = [],
): Promise<RemainingRunDeliveryTargets> {
  const { digest: approvedDigest, ...body } = inventory;
  if (approvedDigest !== runDeliveryInventoryDigest(body))
    throw new Error(
      "The approved delivery inventory changed after preview; inspect it and preview again.",
    );
  {
    let remaining = 0;
    const unresolved = [...inventory.unresolved];
    for (const entry of [
      ...inventory.receipts.flatMap((receipt) => receipt.entries),
      ...inventory.plans.filter((plan) => !plan.shared).map((plan) => plan.entry),
      ...inventory.attempts.flatMap((attempt) => attempt.entries),
      ...inventory.metadata,
    ])
      if (await exists(entry.path)) remaining += 1;
    for (const chain of inventory.index.affected) {
      for (const slot of chain.slots.filter(
        (candidate) => candidate.entry.runId === inventory.runId,
      )) {
        const name = `${String(slot.entry.sequence).padStart(6, "0")}.json`;
        const backupPath = join(`${chain.directory}.deletion-backup`, name);
        const path = (await exists(backupPath)) ? backupPath : slot.path;
        if (
          (await exists(path)) &&
          createHash("sha256")
            .update(await readFile(path))
            .digest("hex") === slot.sha256
        ) {
          remaining += 1;
        }
      }
    }
    const maintenanceIncomplete = await exists(
      join(inventory.index.root, "run-index", ".deletion-in-progress"),
    );
    if (maintenanceIncomplete)
      unresolved.push(
        "Resume the interrupted delivery-index rebuild before reading or recording deliveries.",
      );
    for (const attempt of inventory.attempts) {
      const registrationStillPresent =
        attempt.requiresWorktreeCleanup &&
        (
          await Promise.all(
            attempt.entries
              .filter((entry) => entry.path.endsWith("/repository/.git"))
              .map((entry) => exists(entry.path)),
          )
        ).some(Boolean);
      const evidence = clearedWorktrees.find((candidate) => candidate.attemptPath === attempt.path);
      let cleared = false;
      if (evidence && !registrationStillPresent) {
        try {
          await assertRemovedWorktreeRegistration(inventory, attempt, evidence);
          cleared = true;
        } catch (error) {
          unresolved.push(
            error instanceof Error
              ? error.message
              : `Inspect changed Git registration for ${attempt.path}.`,
          );
        }
      }
      if (
        attempt.requiresWorktreeCleanup &&
        (await exists(attempt.path)) &&
        (!cleared || registrationStillPresent)
      ) {
        unresolved.push(
          `Registered Git worktree at ${attempt.path} needs exact published-delivery cleanup authority.`,
        );
      }
    }
    return { remaining, maintenanceIncomplete, unresolved };
  }
}

export interface RunDeliveryDeletionHooks {
  readonly afterRemove?: (path: string) => void | Promise<void>;
  readonly afterIndexKeyspace?: (space: RunDeliveryIndexKeySpace) => void | Promise<void>;
  readonly clearedWorktrees?: readonly RunDeliveryWorktreeCleanupEvidence[];
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function runDeliveryInventoryDigest(
  inventory: Omit<RunDeliveryDeletionInventory, "digest">,
): string {
  return digest({ domain: "docsfab-run-delivery-deletion-inventory-v1", inventory });
}

/** Write before prepareWorktree can create an attempt under a custom delivery root. */
export async function recordRunDeliveryAttemptLocation(
  input: RunDeliveryAttemptLocation,
): Promise<string> {
  const stateDirectory = await existingCanonicalRoot(input.stateDirectory, false);
  const deliveryRoot = await existingCanonicalRoot(input.deliveryRoot);
  if (
    !stateDirectory ||
    !deliveryRoot ||
    !SHA256.test(input.recordSha256) ||
    !SHA256.test(input.planSha256) ||
    !input.runId ||
    dirname(input.attemptPath) !== join(deliveryRoot, "attempts") ||
    resolve(input.attemptPath) !== input.attemptPath
  ) {
    throw new Error(
      "The delivery attempt location is invalid; inspect the retained metadata before retrying.",
    );
  }
  if (input.schemaVersion === 2) {
    if (
      !(await existingCanonicalRoot(input.receiptRoot)) ||
      Object.values(input).some(
        (value) => typeof value === "string" && redactCredentialMaterial(value) !== value,
      )
    )
      throw new Error("The delivery attempt location cannot be retained safely.");
  }
  const directory = join(stateDirectory, RUN_DELIVERY_ATTEMPT_LOCATIONS);
  await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  await existingCanonicalRoot(directory);
  const path = join(directory, `${digest(input)}.json`);
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  ).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
    const existing = await readPrivateAttemptLocation(path);
    if (JSON.stringify(existing.value) !== JSON.stringify(input)) throw unsafeAttemptLocation(path);
    return undefined;
  });
  if (!handle) return path;
  try {
    await handle.writeFile(JSON.stringify(input));
    await handle.sync();
  } finally {
    await handle.close();
  }
  return path;
}

/** Locate exact-plan attempts; each candidate still requires full prepare-time verification. */
export async function locateRunDeliveryAttempts(input: {
  stateDirectory: string;
  runId: string;
  recordSha256: string;
  deliveryRoot: string;
  planSha256: string;
  capsuleName: string;
}): Promise<string[]> {
  const stateDirectory = await existingCanonicalRoot(input.stateDirectory, false);
  const deliveryRoot = await existingCanonicalRoot(input.deliveryRoot);
  if (
    !stateDirectory ||
    !deliveryRoot ||
    !SHA256.test(input.recordSha256) ||
    !SHA256.test(input.planSha256)
  )
    throw new Error("Publication roots or digests are invalid; inspect them before replaying.");
  const recordedCandidates = new Set<string>();
  const discoveredCandidates = new Set<string>();
  const metadataDirectory = join(stateDirectory, RUN_DELIVERY_ATTEMPT_LOCATIONS);
  const metadataStat = await lstat(metadataDirectory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (metadataStat) {
    await existingCanonicalRoot(metadataDirectory);
    for (const name of (await readdir(metadataDirectory)).sort()) {
      if (!/^[a-f0-9]{64}\.json$/u.test(name))
        throw new Error(
          `Unknown delivery attempt metadata ${join(metadataDirectory, name)}; inspect it before replaying.`,
        );
      const path = join(metadataDirectory, name);
      const read = await readPrivateAttemptLocation(path);
      const location = validateAttemptLocation(read.value, path, stateDirectory, name);
      if (location.runId !== input.runId) continue;
      if (location.recordSha256 !== input.recordSha256)
        throw new Error(
          `Delivery attempt metadata ${path} names a different run record; inspect it before replaying.`,
        );
      if (location.planSha256 !== input.planSha256) continue;
      if (location.deliveryRoot !== deliveryRoot)
        throw new Error(
          `The matching delivery attempt is under ${location.deliveryRoot}; supply that root before replaying.`,
        );
      const after = await readPrivateAttemptLocation(path);
      if (!sameMetadataIdentity(read.identity, after.identity)) throw unsafeAttemptLocation(path);
      recordedCandidates.add(location.attemptPath);
    }
  }
  if (recordedCandidates.size > 1)
    throw new Error(
      "Multiple delivery attempt locations bind this run and plan; inspect them before replaying.",
    );
  const attemptsRoot = join(deliveryRoot, "attempts");
  const attemptsStat = await lstat(attemptsRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (attemptsStat) {
    await existingCanonicalRoot(attemptsRoot);
    for (const name of (await readdir(attemptsRoot)).sort()) {
      const path = join(attemptsRoot, name);
      const stat = await lstat(path);
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        stat.uid !== process.getuid?.() ||
        (stat.mode & 0o077) !== 0 ||
        (await realpath(path)) !== path
      )
        throw new Error(`Unsafe delivery attempt directory ${path}; inspect it before replaying.`);
      const capsulePath = join(path, input.capsuleName);
      const capsule = await lstat(capsulePath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (capsule) discoveredCandidates.add(path);
    }
  }
  if (recordedCandidates.size === 0 && discoveredCandidates.size > 1)
    throw new Error(
      "Multiple legacy delivery attempt locations match this run and plan without a persisted location; inspect them before replaying.",
    );
  // A persisted exact run/plan location is the replay authority. Directory
  // discovery exists for legacy attempts only and must not sort ahead of it.
  const discovered = [...discoveredCandidates]
    .filter((path) => !recordedCandidates.has(path))
    .sort((left, right) => left.localeCompare(right));
  return [...recordedCandidates, ...discovered];
}

function validateAttemptLocation(
  value: unknown,
  path: string,
  stateDirectory: string,
  filename: string,
): RunDeliveryAttemptLocation {
  const location = value as
    | (Partial<RunDeliveryAttemptLocationBase> & {
        schemaVersion?: 1 | 2;
        receiptRoot?: string;
      })
    | null;
  if (
    !location ||
    typeof location !== "object" ||
    Object.keys(location).sort().join(",") !==
      [
        "attemptPath",
        "deliveryRoot",
        "kind",
        "planSha256",
        "recordSha256",
        "runId",
        "schemaVersion",
        "stateDirectory",
        ...(location.schemaVersion === 2 ? ["receiptRoot"] : []),
      ]
        .sort()
        .join(",") ||
    (location.schemaVersion !== 1 && location.schemaVersion !== 2) ||
    (location.schemaVersion === 2 &&
      (typeof location.receiptRoot !== "string" ||
        !isAbsolute(location.receiptRoot) ||
        resolve(location.receiptRoot) !== location.receiptRoot)) ||
    location.kind !== "docsfab-run-delivery-attempt-location" ||
    location.stateDirectory !== stateDirectory ||
    typeof location.runId !== "string" ||
    location.runId.length === 0 ||
    !SHA256.test(location.recordSha256 ?? "") ||
    !SHA256.test(location.planSha256 ?? "") ||
    typeof location.deliveryRoot !== "string" ||
    !isAbsolute(location.deliveryRoot) ||
    resolve(location.deliveryRoot) !== location.deliveryRoot ||
    typeof location.attemptPath !== "string" ||
    !isAbsolute(location.attemptPath) ||
    resolve(location.attemptPath) !== location.attemptPath ||
    dirname(location.attemptPath) !== join(location.deliveryRoot, "attempts") ||
    filename !== `${digest(location)}.json`
  )
    throw new Error(`Delivery attempt metadata ${path} is invalid; inspect it before replaying.`);
  return location as RunDeliveryAttemptLocation;
}

async function readPrivateAttemptLocation(path: string): Promise<{
  value: unknown;
  identity: RunDeliveryEntryIdentity & { uid: number; nlink: number; mode: number };
}> {
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const nonblock = typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | noFollow | nonblock);
    const before = await handle.stat();
    const beforePath = await lstat(path);
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.uid !== process.getuid?.() ||
      (before.mode & 0o077) !== 0 ||
      before.size < 0 ||
      beforePath.isSymbolicLink() ||
      !sameMetadataIdentity(before, beforePath)
    )
      throw unsafeAttemptLocation(path);
    const bytes = await handle.readFile();
    if (bytes.byteLength !== before.size) throw unsafeAttemptLocation(path);
    const after = await handle.stat();
    const afterPath = await lstat(path);
    if (!sameMetadataIdentity(before, after) || !sameMetadataIdentity(before, afterPath))
      throw unsafeAttemptLocation(path);
    return {
      value: JSON.parse(bytes.toString("utf8")) as unknown,
      identity: {
        path,
        dev: before.dev,
        ino: before.ino,
        uid: before.uid,
        nlink: before.nlink,
        mode: before.mode,
        size: before.size,
        mtimeMs: before.mtimeMs,
        kind: "file",
      },
    };
  } catch (error) {
    if (error instanceof SyntaxError) throw unsafeAttemptLocation(path);
    if (error instanceof Error && error.message.includes("; inspect it before retrying."))
      throw error;
    throw unsafeAttemptLocation(path);
  } finally {
    await handle?.close();
  }
}

function sameMetadataIdentity(
  left: {
    dev: number;
    ino: number;
    uid: number;
    nlink: number;
    mode: number;
    size: number;
    mtimeMs: number;
  },
  right: {
    dev: number;
    ino: number;
    uid: number;
    nlink: number;
    mode: number;
    size: number;
    mtimeMs: number;
  },
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.uid === right.uid &&
    left.nlink === right.nlink &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs
  );
}

function unsafeAttemptLocation(path: string): Error {
  return new Error(
    `The delivery attempt location at ${path} is unsafe; inspect it before retrying.`,
  );
}

/** Called after successful attempt cleanup; failures retain location for deletion preview. */
export async function clearRunDeliveryAttemptLocation(path: string): Promise<void> {
  const stat = await lstat(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.uid !== process.getuid?.()
  ) {
    throw new Error(
      `The delivery attempt location at ${path} is unsafe; inspect it before retrying.`,
    );
  }
  await unlink(path);
}

async function existingCanonicalRoot(
  path: string,
  requirePrivate = true,
): Promise<string | undefined> {
  if (!isAbsolute(path) || resolve(path) !== path || path.includes("\0"))
    throw new Error(
      `The publication root at ${path} is invalid; supply its canonical absolute path.`,
    );
  if (!(await exists(path))) return undefined;
  const stat = await lstat(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (requirePrivate && (stat.mode & 0o077) !== 0) ||
    (await realpath(path)) !== path
  ) {
    throw new Error(`The publication root at ${path} is unsafe; inspect its owner and path.`);
  }
  return path;
}

async function existingRoots(paths: readonly string[]): Promise<string[]> {
  const canonical = await Promise.all(paths.map((path) => existingCanonicalRoot(path)));
  return [...new Set(canonical.filter((root): root is string => root !== undefined))].sort();
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function identity(
  path: string,
  kind: RunDeliveryEntryIdentity["kind"],
): Promise<RunDeliveryEntryIdentity> {
  const stat = await lstat(path);
  if (
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (kind === "file" ? !stat.isFile() || stat.nlink !== 1 : !stat.isDirectory())
  ) {
    throw new Error(`The delivery entry at ${path} is unsafe; inspect its owner and path.`);
  }
  if (kind === "directory")
    return { path, dev: stat.dev, ino: stat.ino, size: 0, mtimeMs: 0, kind };
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const pinned = await handle.stat();
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      pinned.dev !== stat.dev ||
      pinned.ino !== stat.ino ||
      pinned.size !== stat.size ||
      pinned.mtimeMs !== stat.mtimeMs ||
      after.size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs
    ) {
      throw new Error(
        `The delivery entry changed during inventory at ${path}; inspect it and preview again.`,
      );
    }
    return {
      path,
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      kind,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  } finally {
    await handle.close();
  }
}

async function tree(path: string): Promise<RunDeliveryEntryIdentity[]> {
  const entries = [await identity(path, "directory")];
  for (const name of await readdir(path)) {
    const child = join(path, name);
    const stat = await lstat(child);
    entries.push(
      ...(stat.isDirectory() && !stat.isSymbolicLink()
        ? await tree(child)
        : [await identity(child, "file")]),
    );
  }
  return entries;
}

function orderedEntries(entries: RunDeliveryEntryIdentity[]): RunDeliveryEntryIdentity[] {
  return entries.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
}

function sameUnrelatedReviewReceipt(
  left: UnrelatedReviewReceiptIdentity,
  right: UnrelatedReviewReceiptIdentity,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Validate private journal evidence before it can exclude any receipt on resume. */
export function validUnrelatedReviewReceipts(inventory: RunDeliveryDeletionInventory): boolean {
  const certificates = inventory.unrelatedReviewReceipts;
  if (certificates === undefined) return true; // Older journals remain strict.
  if (!Array.isArray(certificates)) return false;
  const keys = new Set<string>();
  const certificateBound = limit("runs.deletionInventoryMaxEntries");
  let certificateEntries = 0;
  for (const certificate of certificates) {
    if (!certificate || typeof certificate !== "object") return false;
    const { root, idempotencyKey, rootEntry, entries } = certificate;
    if (
      typeof root !== "string" ||
      !inventory.receiptRoots.includes(root) ||
      !isAbsolute(root) ||
      resolve(root) !== root ||
      typeof idempotencyKey !== "string" ||
      !SHA256.test(idempotencyKey) ||
      !rootEntry ||
      rootEntry.kind !== "directory" ||
      rootEntry.path !== root ||
      !Number.isSafeInteger(rootEntry.dev) ||
      !Number.isSafeInteger(rootEntry.ino) ||
      !Array.isArray(entries) ||
      entries.length === 0
    )
      return false;
    const key = `${root}\0${idempotencyKey}`;
    if (keys.has(key)) return false;
    keys.add(key);
    certificateEntries += entries.length + 1;
    if (certificateEntries > certificateBound.value) return false;
    const journalPath = join(root, idempotencyKey);
    if (entries[0]?.path !== journalPath || entries[0].kind !== "directory") return false;
    const paths = new Set<string>();
    for (const entry of entries) {
      if (
        !entry ||
        typeof entry.path !== "string" ||
        (entry.path !== journalPath && !entry.path.startsWith(`${journalPath}/`)) ||
        resolve(entry.path) !== entry.path ||
        (entry.kind !== "file" && entry.kind !== "directory") ||
        !Number.isSafeInteger(entry.dev) ||
        !Number.isSafeInteger(entry.ino) ||
        !Number.isFinite(entry.size) ||
        !Number.isFinite(entry.mtimeMs) ||
        (entry.kind === "file" &&
          (typeof entry.sha256 !== "string" || !SHA256.test(entry.sha256))) ||
        paths.has(entry.path)
      )
        return false;
      paths.add(entry.path);
    }
    if (entries.some((entry, index) => index > 0 && entry.path <= entries[index - 1]!.path))
      return false;
  }
  return true;
}

/** Preview exact local receipt, plan, attempt and derived-index identities. */
interface RunDeliveryInventoryInput {
  stateDirectory: string;
  runId: string;
  recordSha256: string;
  receiptRoots?: readonly string[];
  deliveryRoots?: readonly string[];
  /** Observational snapshots mint no deletion authority or maintenance lock. */
  readOnly?: true;
  /** Strictly discovered run-owned intent object addresses from the artifact scanner. */
  reviewIntents?: readonly { readonly digest: string; readonly artifactRoot: string }[];
  /** Only the validated prior journal and tombstone may supply this under held receipt gates. */
  approvedUnrelatedReviewReceipts?: readonly UnrelatedReviewReceiptIdentity[];
}

export async function inventoryRunDelivery(
  input: RunDeliveryInventoryInput,
): Promise<RunDeliveryDeletionInventory> {
  if (input.approvedUnrelatedReviewReceipts !== undefined)
    throw new Error("Prior review receipt evidence requires the confirmed deletion receipt gate.");
  return inventoryRunDeliveryCore(input, false);
}

/** Internal inventory when the run-deletion coordinator continuously holds receipt gates. */
export async function inventoryRunDeliveryUnderGate(
  input: RunDeliveryInventoryInput,
): Promise<RunDeliveryDeletionInventory> {
  return inventoryRunDeliveryCore(input, true);
}

async function inventoryRunDeliveryCore(
  input: RunDeliveryInventoryInput,
  gateHeld: boolean,
): Promise<RunDeliveryDeletionInventory> {
  if (!SHA256.test(input.recordSha256))
    throw new Error(
      "The saved run record digest is invalid; inspect the record and preview again.",
    );
  const stateDirectory = await existingCanonicalRoot(input.stateDirectory, false);
  if (!stateDirectory)
    throw new Error("The run state directory is missing; restore it before previewing deletion.");
  const defaults = resolveDocsFabPublicationRoots({}, stateDirectory);
  const receiptRoots = await existingRoots([defaults.receiptRoot, ...(input.receiptRoots ?? [])]);
  const deliveryRoots = await existingRoots([
    defaults.deliveryRoot,
    ...(input.deliveryRoots ?? []),
  ]);
  for (const root of [...(input.receiptRoots ?? []), ...(input.deliveryRoots ?? [])]) {
    if (!(await exists(root)))
      throw new Error(
        `The supplied publication root at ${root} is missing; restore it or omit the option.`,
      );
  }
  const indexRoot = defaults.receiptRoot;
  const readInventory = async () => {
    const receipts: RunDeliveryDeletionInventory["receipts"][number][] = [];
    const unrelatedReviewReceipts: UnrelatedReviewReceiptIdentity[] = [];
    const certificateBound = limit("runs.deletionInventoryMaxEntries");
    let certificateEntries = 0;
    const plans: RunDeliveryDeletionInventory["plans"][number][] = [];
    const attempts: RunDeliveryDeletionInventory["attempts"][number][] = [];
    const unresolved: string[] = [];
    const affected = await inventoryRunDeliveryIndexUnderGate({
      indexRoot,
      runId: input.runId,
      recordSha256: input.recordSha256,
    });
    const indexedRoots = new Set(
      affected.flatMap((chain) =>
        chain.slots
          .filter((slot) => slot.entry.runId === input.runId)
          .map((slot) => slot.entry.receiptRoot),
      ),
    );
    for (const root of indexedRoots) {
      if (!receiptRoots.includes(root))
        unresolved.push(`Supply --receipt-root ${root} to inspect indexed publication bytes.`);
    }
    for (const root of receiptRoots) {
      const store = new FileScmDeliveryReceiptStore(root);
      const owners: Array<{ key: string; runId: string; planSha256: string }> = [];
      for (const name of await readdir(root)) {
        if (!SHA256.test(name)) continue;
        const path = join(root, name);
        const stat = await lstat(path);
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
          unresolved.push(`Inspect unsafe receipt journal ${path}.`);
          continue;
        }
        // Preview has no receipt gate. Bracket the strict read so the later
        // certificate describes the bytes that were actually classified.
        const beforeRootEntry = await identity(root, "directory");
        const beforeEntries = orderedEntries(await tree(path));
        const loaded = await store.loadEither(name);
        if (!loaded) {
          unresolved.push(`Inspect empty receipt journal ${path}.`);
          continue;
        }
        if (loaded.kind === "review") {
          const certificate: UnrelatedReviewReceiptIdentity = {
            root,
            idempotencyKey: name,
            rootEntry: beforeRootEntry,
            entries: beforeEntries,
          };
          if (
            JSON.stringify(beforeRootEntry) !== JSON.stringify(await identity(root, "directory")) ||
            JSON.stringify(beforeEntries) !== JSON.stringify(orderedEntries(await tree(path)))
          ) {
            unresolved.push(
              `Review receipt ${path} changed during inspection; inspect custody and preview again.`,
            );
            continue;
          }
          const approvedCertificate = input.approvedUnrelatedReviewReceipts?.find(
            (item) => item.root === root && item.idempotencyKey === name,
          );
          if (approvedCertificate) {
            if (!sameUnrelatedReviewReceipt(approvedCertificate, certificate)) {
              unresolved.push(
                `Review receipt ${path} changed since approved deletion; inspect its custody and retry.`,
              );
              continue;
            }
            certificateEntries += certificate.entries.length + 1;
            if (certificateEntries > certificateBound.value)
              refuseLimit(certificateBound, certificateEntries);
            unrelatedReviewReceipts.push(certificate);
            continue;
          }
          let associated = false;
          let ambiguous = false;
          for (const candidate of input.reviewIntents ?? []) {
            try {
              const intent = await inspectReviewIntentForDeletion({
                runStore: new FileRunStore(stateDirectory),
                artifacts: new DurableArtifactStore(candidate.artifactRoot),
                runId: input.runId,
                intentObjectSha256: candidate.digest,
              });
              const overlaps =
                intent.idempotencyKey === name ||
                intent.resultSha256 === loaded.record.manifest.originalResultSha256 ||
                intent.sourceSha256 === loaded.record.manifest.sourceSha256 ||
                intent.snapshotSha256 === loaded.record.manifest.snapshotSha256;
              if (!overlaps) continue;
              if (intent.idempotencyKey !== name) {
                ambiguous = true;
                continue;
              }
              await inspectReviewIntentForDeletion({
                runStore: new FileRunStore(stateDirectory),
                artifacts: new DurableArtifactStore(candidate.artifactRoot),
                runId: input.runId,
                intentObjectSha256: candidate.digest,
                receipt: loaded.record,
              });
              associated = true;
            } catch {
              ambiguous = true;
            }
          }
          if (!associated && !ambiguous) {
            try {
              const saved = await new FileRunStore(stateDirectory).getWithDigest(input.runId, {
                readOnly: true,
              });
              const run = decodeSavedRunRecord(saved.record as JsonEvidenceValue, input.runId);
              ambiguous =
                run.reviewDeliverySnapshot?.snapshotSha256 ===
                  loaded.record.manifest.snapshotSha256 ||
                (run.changeSources ?? []).some(
                  (source) => source.changeSourceSha256 === loaded.record.manifest.sourceSha256,
                );
            } catch {
              ambiguous = true;
            }
          }
          if (associated || ambiguous)
            unresolved.push(
              `Review receipt ${path} remains recovery authority for this saved review or has ambiguous ownership; inspect its custody and retained intent before retrying deletion.`,
            );
          else {
            certificateEntries += certificate.entries.length + 1;
            if (certificateEntries > certificateBound.value)
              refuseLimit(certificateBound, certificateEntries);
            unrelatedReviewReceipts.push(certificate);
          }
          continue;
        }
        const record = loaded.record;
        owners.push({ key: name, runId: record.run.id, planSha256: record.planSha256 });
        if (record.run.id !== input.runId) continue;
        if (record.run.recordSha256 !== input.recordSha256) {
          unresolved.push(`Receipt ${path} names a different run record; inspect it.`);
          continue;
        }
        const entries = await tree(path);
        let allTarget = true;
        for (const entry of entries.filter((candidate) => candidate.kind === "file")) {
          const slot = JSON.parse(await readFile(entry.path, "utf8")) as {
            record?: { run?: { id?: string; recordSha256?: string } };
          };
          if (
            slot.record?.run?.id !== input.runId ||
            slot.record.run.recordSha256 !== input.recordSha256
          ) {
            allTarget = false;
            break;
          }
        }
        if (allTarget)
          receipts.push({ root, idempotencyKey: name, planSha256: record.planSha256, entries });
        else unresolved.push(`Receipt ${path} has mixed ownership; inspect every slot.`);
      }
      for (const planSha256 of new Set(
        receipts.filter((receipt) => receipt.root === root).map((receipt) => receipt.planSha256),
      )) {
        const path = join(root, `plan-${planSha256}.json`);
        if (!(await exists(path))) {
          unresolved.push(`Restore missing publication plan ${path}, then preview deletion again.`);
          continue;
        }
        const plan = await store.loadPlan(planSha256);
        if (!plan || plan.run.id !== input.runId || plan.run.recordSha256 !== input.recordSha256) {
          unresolved.push(`Publication plan ${path} has conflicting ownership; inspect it.`);
          continue;
        }
        plans.push({
          root,
          planSha256,
          entry: await identity(path, "file"),
          shared: owners.some(
            (other) => other.planSha256 === planSha256 && other.runId !== input.runId,
          ),
        });
      }
    }
    const metadata = await inventoryAttemptMetadata(
      stateDirectory,
      input.runId,
      input.recordSha256,
      deliveryRoots,
      unresolved,
    );
    const knownLocations = new Map<string, string>();
    for (const entry of metadata) {
      const location = JSON.parse(await readFile(entry.path, "utf8")) as RunDeliveryAttemptLocation;
      knownLocations.set(location.attemptPath, location.planSha256);
    }
    for (const root of deliveryRoots) {
      const attemptDirectory = join(root, "attempts");
      if (!(await exists(attemptDirectory))) continue;
      await existingCanonicalRoot(attemptDirectory);
      for (const name of await readdir(attemptDirectory)) {
        const path = join(attemptDirectory, name);
        const stat = await lstat(path);
        if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
        let planSha256 = knownLocations.get(path);
        if (!planSha256) {
          for (const candidate of plans) {
            const plan = await new FileScmDeliveryReceiptStore(candidate.root).loadPlan(
              candidate.planSha256,
            );
            if (plan && (await exists(join(path, deliveryCapsuleName(plan))))) {
              planSha256 = plan.sha256;
              break;
            }
          }
        }
        if (planSha256) {
          const entries = await tree(path);
          const requiresWorktreeCleanup = entries.some((entry) =>
            entry.path.endsWith("/repository/.git"),
          );
          attempts.push({ root, path, planSha256, entries, requiresWorktreeCleanup });
        }
      }
    }
    for (const path of knownLocations.keys()) {
      if ((await exists(path)) && !attempts.some((attempt) => attempt.path === path)) {
        unresolved.push(
          `Supply --delivery-root ${dirname(dirname(path))} for retained attempt ${path}.`,
        );
      }
    }
    const body = {
      schemaVersion: 1 as const,
      kind: "docsfab-run-delivery-deletion-inventory" as const,
      stateDirectory,
      runId: input.runId,
      recordSha256: input.recordSha256,
      receiptRoots,
      deliveryRoots,
      receipts,
      unrelatedReviewReceipts: unrelatedReviewReceipts.sort((left, right) => {
        const leftKey = `${left.root}\0${left.idempotencyKey}`;
        const rightKey = `${right.root}\0${right.idempotencyKey}`;
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
      }),
      plans,
      attempts,
      metadata,
      index: { root: indexRoot, affected },
      sharedRetained: plans.filter((plan) => plan.shared).length,
      unresolved,
    };
    return { ...body, digest: runDeliveryInventoryDigest(body) };
  };
  return gateHeld || input.readOnly
    ? readInventory()
    : withDeliveryRootGates(receiptRoots, readInventory);
}

/** No deletion authority: only decide whether this run has resources to inspect. */
async function hasUnlocatedRunRetention(input: {
  runId: string;
  receiptRoots: readonly string[];
  deliveryRoots: readonly string[];
}): Promise<boolean> {
  const attemptPaths: string[] = [];
  for (const root of await existingRoots(input.deliveryRoots)) {
    const directory = join(root, "attempts");
    if (!(await exists(directory))) continue;
    await existingCanonicalRoot(directory);
    for (const name of await readdir(directory)) {
      const path = join(directory, name);
      const entry = await lstat(path);
      if (entry.isSymbolicLink()) throw unsafeAttemptLocation(path);
      if (!entry.isDirectory()) continue;
      await existingCanonicalRoot(path);
      attemptPaths.push(path);
    }
  }
  for (const root of await existingRoots(input.receiptRoots)) {
    const store = new FileScmDeliveryReceiptStore(root);
    for (const name of await readdir(root)) {
      if (!SHA256.test(name)) continue;
      const loaded = await store.loadEither(name);
      if (!loaded) return true;
      if (loaded.kind === "review") continue;
      const receipt = loaded.record;
      if (receipt.run.id !== input.runId) continue;
      if (receipt.disposition === "failed" || receipt.disposition === "active") return true;
      if (attemptPaths.length === 0) continue;
      const plan = await store.loadPlan(receipt.planSha256);
      if (!plan || plan.run.id !== input.runId) return true;
      for (const path of attemptPaths) {
        if (await exists(join(path, deliveryCapsuleName(plan)))) return true;
      }
    }
  }
  return false;
}

/** Reconstruct current retained resources without changing the saved run or its stores. */
export async function lookupSavedRunRetainedDelivery(input: {
  stateDirectory: string;
  runId: string;
  environment: NodeJS.ProcessEnv;
}): Promise<RunRetainedDeliveryV1 | undefined> {
  const selected = resolveDocsFabPublicationRoots(input.environment, input.stateDirectory);
  const defaults = resolveDocsFabPublicationRoots({}, input.stateDirectory);
  if (
    !(await exists(join(input.stateDirectory, RUN_DELIVERY_ATTEMPT_LOCATIONS))) &&
    !(await exists(selected.receiptRoot)) &&
    !(await exists(defaults.receiptRoot))
  )
    return undefined;
  const stateDirectory = await existingCanonicalRoot(input.stateDirectory, false);
  if (!stateDirectory) return unavailableRunRetainedDelivery();
  const deliveryRoots = new Set<string>();
  const receiptRoots = new Set<string>();
  const locations: RunDeliveryAttemptLocation[] = [];
  const metadataDirectory = join(stateDirectory, RUN_DELIVERY_ATTEMPT_LOCATIONS);
  if (await exists(metadataDirectory)) {
    await existingCanonicalRoot(metadataDirectory);
    for (const name of await readdir(metadataDirectory)) {
      if (!/^[a-f0-9]{64}\.json$/u.test(name)) throw unsafeAttemptLocation(metadataDirectory);
      const path = join(metadataDirectory, name);
      const read = await readPrivateAttemptLocation(path);
      const location = validateAttemptLocation(read.value, path, stateDirectory, name);
      if (location.runId !== input.runId) continue;
      locations.push(location);
      deliveryRoots.add(location.deliveryRoot);
      if (location.schemaVersion === 2) receiptRoots.add(location.receiptRoot);
    }
  }
  // Empty locator directories and completed receipts alone do not mean that
  // this run retained delivery resources. In particular, observing them must
  // not turn an otherwise ordinary saved result into an inspection warning.
  if (
    locations.length === 0 &&
    !(await hasUnlocatedRunRetention({
      runId: input.runId,
      deliveryRoots: [selected.deliveryRoot, defaults.deliveryRoot],
      receiptRoots: [selected.receiptRoot, defaults.receiptRoot],
    }))
  )
    return undefined;
  if (!(await existingCanonicalRoot(stateDirectory))) return unavailableRunRetainedDelivery();
  const store = new FileRunStore(stateDirectory);
  const readOptions = { readOnly: true, maxBytes: runRecordMaxBytes().value } as const;
  const saved = await store.getWithDigest(input.runId, readOptions);
  const record = decodeSavedRunRecord(saved.record as JsonEvidenceValue, input.runId);
  if (locations.some((location) => location.recordSha256 !== saved.sha256))
    return unavailableRunRetainedDelivery();
  if (deliveryRoots.size === 0) deliveryRoots.add(selected.deliveryRoot);
  if (receiptRoots.size === 0) receiptRoots.add(selected.receiptRoot);
  const inventoryInput = {
    stateDirectory,
    runId: input.runId,
    recordSha256: saved.sha256,
    deliveryRoots: await existingRoots([...deliveryRoots]),
    receiptRoots: await existingRoots([...receiptRoots]),
    readOnly: true,
  } as const;
  const inventory = await inventoryRunDelivery(inventoryInput);
  let unfinishedReceipt = false;
  for (const entry of inventory.receipts) {
    const receipt = await new FileScmDeliveryReceiptStore(entry.root).load(entry.idempotencyKey);
    if (receipt?.disposition === "failed" || receipt?.disposition === "active")
      unfinishedReceipt = true;
  }
  const worktrees: RunDeliveryWorktreeCleanupEvidence[] = [];
  let unresolved = inventory.unresolved.length;
  // A missing recorded root or plan is unknown retained state, not an empty inventory.
  if (
    [...deliveryRoots].some((root) => !inventoryInput.deliveryRoots.includes(root)) ||
    [...receiptRoots].some((root) => !inventoryInput.receiptRoots.includes(root)) ||
    locations.some(
      (location) =>
        !inventory.plans.some((plan) => plan.planSha256 === location.planSha256) ||
        !inventory.attempts.some((attempt) => attempt.path === location.attemptPath),
    )
  )
    unresolved += 1;
  for (const attempt of inventory.attempts) {
    if (!attempt.requiresWorktreeCleanup) continue;
    try {
      worktrees.push(await inspectRunDeliveryWorktree(inventory, attempt, record));
    } catch {
      unresolved += 1;
    }
  }
  const branchInventory = await inspectRunDeliveryBranches(inventory, record, worktrees);
  const current = await store.getWithDigest(input.runId, readOptions);
  const after = await inventoryRunDelivery(inventoryInput);
  if (current.sha256 !== saved.sha256 || after.digest !== inventory.digest) {
    return unavailableRunRetainedDelivery();
  }
  if (
    !unfinishedReceipt &&
    inventory.attempts.length === 0 &&
    inventory.metadata.length === 0 &&
    unresolved === 0
  )
    return undefined;
  return projectRunRetainedDeliveryV1({
    status: unresolved === 0 ? "retained" : "inspection-required",
    worktrees: worktrees.map((entry) => entry.worktreePath),
    branches: branchInventory.branches.map((entry) => entry.branch),
    keptBranches: branchInventory.kept,
    cleanupPreviewCommand:
      unresolved === 0
        ? buildRunDeletionPreviewCommand(input.runId, stateDirectory, {
            deliveryRoots: inventory.deliveryRoots,
            receiptRoots: inventory.receiptRoots,
          })
        : null,
    explanation:
      unresolved === 0
        ? null
        : "Some retained delivery resources could not be verified. Restore the original private publication roots and preview deletion again.",
  });
}

/** A preview command never includes or invents a deletion confirmation. */
export function buildRunDeletionPreviewCommand(
  runId: string,
  stateDirectory: string,
  roots: { deliveryRoots: readonly string[]; receiptRoots: readonly string[] },
): string {
  return [
    "docsfab",
    "runs",
    "delete",
    runId,
    "--state-dir",
    stateDirectory,
    ...roots.deliveryRoots.flatMap((root) => ["--delivery-root", root]),
    ...roots.receiptRoots.flatMap((root) => ["--receipt-root", root]),
  ]
    .map((value) =>
      /^[A-Za-z0-9_./:@+-]+$/u.test(value) ? value : `'${value.replaceAll("'", `'"'"'`)}'`,
    )
    .join(" ");
}

async function inventoryAttemptMetadata(
  stateDirectory: string,
  runId: string,
  recordSha256: string,
  deliveryRoots: readonly string[],
  unresolved: string[],
): Promise<RunDeliveryEntryIdentity[]> {
  const directory = join(stateDirectory, RUN_DELIVERY_ATTEMPT_LOCATIONS);
  if (!(await exists(directory))) return [];
  await existingCanonicalRoot(directory);
  const entries: RunDeliveryEntryIdentity[] = [];
  for (const name of await readdir(directory)) {
    const path = join(directory, name);
    if (!/^[a-f0-9]{64}\.json$/u.test(name)) {
      unresolved.push(`Inspect unknown attempt metadata ${path}.`);
      continue;
    }
    let location: RunDeliveryAttemptLocation;
    try {
      const read = await readPrivateAttemptLocation(path);
      location = validateAttemptLocation(read.value, path, stateDirectory, name);
    } catch {
      unresolved.push(
        `Inspect invalid attempt metadata ${path}; supply its --delivery-root if needed.`,
      );
      continue;
    }
    if (location.runId !== runId) continue;
    if (
      (location.schemaVersion !== 1 && location.schemaVersion !== 2) ||
      location.kind !== "docsfab-run-delivery-attempt-location" ||
      location.stateDirectory !== stateDirectory ||
      location.recordSha256 !== recordSha256 ||
      !SHA256.test(location.planSha256) ||
      !deliveryRoots.includes(location.deliveryRoot) ||
      dirname(location.attemptPath) !== join(location.deliveryRoot, "attempts") ||
      name !== `${digest(location)}.json`
    ) {
      unresolved.push(
        `Inspect invalid attempt metadata ${path}; supply its --delivery-root if needed.`,
      );
      continue;
    }
    entries.push(await identity(path, "file"));
  }
  return entries;
}
