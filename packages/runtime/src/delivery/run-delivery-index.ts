// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Append-only index from a run id and from a merge-request reference to the
 * durable SCM delivery receipt that opened the draft merge request.
 *
 * Receipts are keyed by idempotency key and plan digest only, and the sealed
 * run record cannot change after the run, so this index is the one place that
 * answers "which MR did this run open?" without a forge round trip. It lives
 * under the canonical receipt root (the one `--state-dir` and
 * `DOCSFAB_RECEIPT_ROOT` name), whatever root the receipt itself was written
 * under, so `docsfab runs show` finds deliveries made with `--receipt-root` or
 * a managed cycle root.
 *
 * Layout: `<root>/run-index/{by-run,by-mr,by-mr-path}/<sha256(key)>/NNNNNN.json`.
 * Each entry file is immutable and chained to the previous one in its key.
 * Sequence records append order; MR lookups use confirmed opening times from
 * receipts because an interrupted append can be repaired after a newer MR.
 */
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import { resolveDocsFabPublicationRoots } from "../config/host-paths.js";
import {
  limit,
  refuseLimit,
  formatLimitObservation,
  type ResolvedLimit,
} from "../config/limits.js";
import {
  canonicalizeJsonEvidence,
  parseJsonEvidence,
  type JsonEvidenceValue,
} from "../json-evidence.js";
import { isNodeError } from "../shared/primitives.js";
import { withRunMaintenanceGate } from "../records/run-maintenance-gate.js";
import type { ScmDeliveryRecord } from "./receipt.js";
import { FileScmDeliveryReceiptStore, ScmDeliveryReceiptStoreError } from "./receipt-store.js";

export const RUN_DELIVERY_INDEX_DIRECTORY = "run-index";
export const RUN_DELIVERY_INDEX_WRITE_FAILED = "run-delivery-index-write-failed";

const ENTRY_MAX_BYTES_LIMIT = "delivery.runDeliveryIndexEntryMaxBytes";
const ENTRIES_PER_KEY_LIMIT = "delivery.runDeliveryIndexEntriesPerKey";
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const SHA256 = /^[a-f0-9]{64}$/u;
const REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
// Six digits, the width the entries-per-key bound's catalog maximum is tied to.
const ENTRY_NAME = /^(\d{6})\.json$/u;
const PENDING_NAME = /^\.pending-[0-9a-f-]{36}\.json$/u;
const ENTRY_KIND = "docsfab-run-delivery-index-entry" as const;

/** Key spaces: one run id, one numeric MR identity, one path-based MR identity. */
export type RunDeliveryIndexKeySpace = "by-run" | "by-mr" | "by-mr-path";

export interface RunDeliveryIndexEntryV1 {
  readonly schemaVersion: 1;
  readonly kind: typeof ENTRY_KIND;
  readonly runId: string;
  readonly runRecordSha256: string;
  readonly idempotencyKey: string;
  /** Receipt digest when the delivery reached `opened`; a later recovery CAS may change it. */
  readonly receiptSha256: string;
  /** Realpath of the receipt store root the receipt was written under. */
  readonly receiptRoot: string;
  readonly planSha256: string;
  readonly provider: "gitlab" | "github";
  readonly host: string;
  readonly projectId: number;
  readonly path: string;
  readonly mergeRequestIid: number;
  readonly mergeRequestUrl: string;
  readonly sourceBranch: string;
  readonly targetBranch: string;
  readonly commitRevision: string;
  readonly headRevision: string;
  readonly sequence: number;
  readonly previousEntrySha256: string | null;
  readonly sha256: string;
}

/** Physical slot captured by deletion preview, beside its validated chain entry. */
export interface RunDeliveryIndexDeletionSlot {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly sha256: string;
  readonly entry: RunDeliveryIndexEntryV1;
}

export interface RunDeliveryIndexDeletionChain {
  readonly space: RunDeliveryIndexKeySpace;
  readonly key: string;
  readonly directory: string;
  readonly slots: readonly RunDeliveryIndexDeletionSlot[];
}

/** Every coded reason a lookup can stop on. Limit refusals use the limit's own code. */
export type RunDeliveryLookupRefusalCode =
  | "run-delivery-index-unavailable"
  | "run-delivery-index-invalid"
  | "run-delivery-receipt-missing"
  | "run-delivery-receipt-invalid"
  | "run-delivery-receipt-mismatch"
  | "delivery-run-delivery-index-entry-max-bytes-bound"
  | "delivery-run-delivery-index-entries-per-key-bound";

export type RunDeliveryLookup =
  | {
      readonly status: "found";
      readonly entry: RunDeliveryIndexEntryV1;
      readonly receipt: ScmDeliveryRecord;
      readonly receiptSha256AtOpen: string;
      readonly receiptSha256Current: string;
      readonly disposition: ScmDeliveryRecord["disposition"];
      readonly checkedRoot: string;
    }
  | {
      readonly status: "absent";
      readonly code: "run-delivery-not-recorded";
      readonly checkedRoot: string;
    }
  | {
      readonly status: "refused";
      readonly code: RunDeliveryLookupRefusalCode;
      /** Operator sentence naming the observed state and the remediation. */
      readonly detail: string;
      readonly checkedRoot: string;
    };

export type RunDeliveryList =
  | {
      readonly status: "listed";
      /** Oldest first. */
      readonly entries: readonly RunDeliveryIndexEntryV1[];
      readonly checkedRoot: string;
    }
  | Exclude<RunDeliveryLookup, { status: "found" }>;

export interface MergeRequestReference {
  readonly provider: "gitlab" | "github";
  readonly host: string;
  readonly path: string;
  readonly mergeRequestIid: number;
}

/** Typed failure for an index write; the publish path maps it to its failed result line. */
export class RunDeliveryIndexContractError extends Error {
  public readonly recoveryCommand?: string;

  public constructor(
    public readonly code: typeof RUN_DELIVERY_INDEX_WRITE_FAILED,
    message: string,
    options?: { cause?: unknown; recoveryCommand?: string },
  ) {
    super(message, options);
    this.name = "RunDeliveryIndexContractError";
    if (options?.recoveryCommand !== undefined) this.recoveryCommand = options.recoveryCommand;
  }
}

/** Internal refusal carried to the lookup boundary, never past it. */
class RunDeliveryLookupContractError extends Error {
  public constructor(
    public readonly code: RunDeliveryLookupRefusalCode,
    public readonly detail: string,
  ) {
    super(detail);
    this.name = "RunDeliveryLookupContractError";
  }
}

interface IndexLimits {
  readonly entryMaxBytes: ResolvedLimit;
  readonly entriesPerKey: ResolvedLimit;
}

function indexLimits(environment: NodeJS.ProcessEnv | undefined): IndexLimits {
  const options = environment === undefined ? {} : { environment };
  return {
    entryMaxBytes: limit(ENTRY_MAX_BYTES_LIMIT, options),
    entriesPerKey: limit(ENTRIES_PER_KEY_LIMIT, options),
  };
}

export function runDeliveryRunKey(runId: string): string {
  return `run:${runId}`;
}

export function runDeliveryMergeRequestKey(input: {
  provider: "gitlab" | "github";
  host: string;
  projectId: number;
  mergeRequestIid: number;
}): string {
  return `${input.provider}:${input.host.toLowerCase()}:${input.projectId}:${input.mergeRequestIid}`;
}

export function runDeliveryMergeRequestPathKey(input: MergeRequestReference): string {
  return `${input.provider}:${input.host.toLowerCase()}:path:${input.path}:${input.mergeRequestIid}`;
}

/**
 * Inverse of the receipt's canonical MR URL: `https://<host>/<path>/-/merge_requests/<iid>`
 * for GitLab, `https://<host>/<path>/pull/<iid>` for GitHub. Anything else is undefined.
 */
export function parseMergeRequestUrl(url: string): MergeRequestReference | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Only an unparseable URL lands here; it is not a merge-request reference.
    return undefined;
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.port !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    return undefined;
  }
  const gitlab = /^\/([^?#]+?)\/-\/merge_requests\/([1-9]\d*)$/u.exec(parsed.pathname);
  const github = gitlab ? null : /^\/([^?#]+?)\/pull\/([1-9]\d*)$/u.exec(parsed.pathname);
  const match = gitlab ?? github;
  if (!match) return undefined;
  const mergeRequestIid = Number(match[2]);
  if (!Number.isSafeInteger(mergeRequestIid)) return undefined;
  return {
    provider: gitlab ? "gitlab" : "github",
    host: parsed.hostname.toLowerCase(),
    path: match[1]!,
    mergeRequestIid,
  };
}

/**
 * Append one opened delivery to every key space. Idempotent: a key that
 * already holds any entry with the same idempotency key gets nothing, so
 * replaying an older delivery never makes it the newest again.
 */
export async function recordRunDelivery(input: {
  /** Canonical receipt root that holds `run-index/`; it must already exist and be private. */
  indexRoot: string;
  record: ScmDeliveryRecord;
  /** Root the receipt was written under. */
  receiptRoot: string;
  environment?: NodeJS.ProcessEnv;
}): Promise<{ readonly appended: readonly RunDeliveryIndexKeySpace[] }> {
  return withRunMaintenanceGate(input.indexRoot, () => recordRunDeliveryUnderGate(input));
}

async function recordRunDeliveryUnderGate(input: {
  indexRoot: string;
  record: ScmDeliveryRecord;
  receiptRoot: string;
  environment?: NodeJS.ProcessEnv;
}): Promise<{ readonly appended: readonly RunDeliveryIndexKeySpace[] }> {
  if (
    await lstatOrUndefined(
      join(input.indexRoot, RUN_DELIVERY_INDEX_DIRECTORY, ".deletion-in-progress"),
    )
  ) {
    throw new RunDeliveryIndexContractError(
      RUN_DELIVERY_INDEX_WRITE_FAILED,
      "An interrupted run deletion is maintaining the delivery index. Resume deletion before recording another delivery.",
    );
  }
  const { record } = input;
  const mergeRequest = record.evidence.mergeRequest;
  const commit = record.evidence.commit;
  if (record.state !== "opened" || mergeRequest === undefined || commit === undefined) {
    throw new RunDeliveryIndexContractError(
      RUN_DELIVERY_INDEX_WRITE_FAILED,
      "Only a delivery receipt that reached opened with merge-request evidence can be indexed.",
    );
  }
  const limits = indexLimits(input.environment);
  const indexDirectory = await ensurePrivateDirectory(
    join(input.indexRoot, RUN_DELIVERY_INDEX_DIRECTORY),
  );
  const base = {
    schemaVersion: 1 as const,
    kind: ENTRY_KIND,
    runId: record.run.id,
    runRecordSha256: record.run.recordSha256,
    idempotencyKey: record.idempotencyKey,
    receiptSha256: record.sha256,
    receiptRoot: input.receiptRoot,
    planSha256: record.planSha256,
    provider: record.repository.provider,
    host: record.repository.host,
    projectId: record.repository.projectId,
    path: record.repository.path,
    mergeRequestIid: mergeRequest.iid,
    mergeRequestUrl: mergeRequest.url,
    sourceBranch: record.sourceBranch,
    targetBranch: record.targetBranch,
    commitRevision: commit.sha,
    headRevision: mergeRequest.headRevision,
  };
  const keys: ReadonlyArray<[RunDeliveryIndexKeySpace, string]> = [
    ["by-run", runDeliveryRunKey(base.runId)],
    [
      "by-mr",
      runDeliveryMergeRequestKey({
        provider: base.provider,
        host: base.host,
        projectId: base.projectId,
        mergeRequestIid: base.mergeRequestIid,
      }),
    ],
    [
      "by-mr-path",
      runDeliveryMergeRequestPathKey({
        provider: base.provider,
        host: base.host,
        path: base.path,
        mergeRequestIid: base.mergeRequestIid,
      }),
    ],
  ];
  const appended: RunDeliveryIndexKeySpace[] = [];
  for (const [space, key] of keys) {
    const spaceDirectory = await ensurePrivateDirectory(join(indexDirectory, space));
    const keyDirectory = await ensurePrivateDirectory(join(spaceDirectory, keyDigest(key)));
    if (await appendEntry(keyDirectory, space, key, base, limits)) appended.push(space);
  }
  return { appended };
}

/**
 * The publish path's index hook, run after a delivery reaches `opened` and
 * before the terminal publication-result line. On success it logs nothing. On
 * any failure to record the delivery it logs a failed-shaped terminal result
 * (state `opened`, the recovery command) and throws, so every caller that
 * decodes the last log line reports `run-delivery-index-write-failed` instead
 * of an opened MR nobody can find.
 */
export async function recordOpenedRunDeliveryOrReport(input: {
  record: ScmDeliveryRecord;
  planSha256: string;
  roots: { repositoryPath: string; deliveryRoot: string; receiptRoot: string };
  stateDirectory: string;
  environment: NodeJS.ProcessEnv;
  recoveryCommand: string;
  log(message: string): void;
}): Promise<void> {
  try {
    const indexRoot = await secureCanonicalIndexRoot(input);
    await recordRunDelivery({
      indexRoot,
      record: input.record,
      receiptRoot: input.roots.receiptRoot,
      environment: input.environment,
    });
  } catch (error) {
    // Any failure to record an opened delivery, including a limit refusal.
    const mergeRequest = input.record.evidence.mergeRequest;
    input.log(
      canonicalizeJsonEvidence({
        schemaVersion: 1,
        kind: "docsfab-local-user-gitlab-publication-result",
        status: "failed",
        planSha256: input.planSha256,
        idempotencyKey: input.record.idempotencyKey,
        receiptSha256: input.record.sha256,
        state: input.record.state,
        disposition: input.record.disposition,
        sourceBranch: input.record.sourceBranch,
        targetBranch: input.record.targetBranch,
        ...(mergeRequest ? { mergeRequestUrl: mergeRequest.url } : {}),
        failureCode: RUN_DELIVERY_INDEX_WRITE_FAILED,
        nextAction: "rerun-recovery-command",
        recoveryCommand: input.recoveryCommand,
      }).trimEnd(),
    );
    throw new RunDeliveryIndexContractError(
      RUN_DELIVERY_INDEX_WRITE_FAILED,
      `The draft merge request is open, but DocsFab could not record it in the run delivery index (${describeError(error)}). Rerun the recovery command to record it.`,
      { cause: error, recoveryCommand: input.recoveryCommand },
    );
  }
}

/**
 * The canonical receipt root the index lives under. When it is not the root
 * this delivery used, it gets the same owner-private and disjointness checks
 * the publisher applies to its own roots.
 */
async function secureCanonicalIndexRoot(input: {
  roots: { repositoryPath: string; deliveryRoot: string; receiptRoot: string };
  stateDirectory: string;
  environment: NodeJS.ProcessEnv;
}): Promise<string> {
  const canonical = resolveDocsFabPublicationRoots(
    input.environment,
    input.stateDirectory,
  ).receiptRoot;
  if (canonical === input.roots.receiptRoot) return canonical;
  await mkdir(canonical, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  await assertPrivateDirectory(canonical, "the canonical receipt root");
  const real = await realpath(canonical);
  if (real === input.roots.receiptRoot) return real;
  if (overlaps(real, input.roots.repositoryPath) || overlaps(real, input.roots.deliveryRoot)) {
    throw new RunDeliveryIndexContractError(
      RUN_DELIVERY_INDEX_WRITE_FAILED,
      "The canonical receipt root must be disjoint from the repository and the delivery root.",
    );
  }
  return real;
}

/** Resolve the canonical root for a state directory and look the run up, read-only. */
export async function lookupSavedRunDelivery(input: {
  environment: NodeJS.ProcessEnv;
  stateDirectory: string;
  runId: string;
}): Promise<RunDeliveryLookup> {
  let indexRoot: string;
  try {
    indexRoot = resolveDocsFabPublicationRoots(input.environment, input.stateDirectory).receiptRoot;
  } catch (error) {
    // Only the root resolver's own refusal (a malformed DOCSFAB_RECEIPT_ROOT) lands here.
    return {
      status: "refused",
      code: "run-delivery-index-unavailable",
      detail: `The receipt root could not be resolved (${describeError(error)}). Fix DOCSFAB_RECEIPT_ROOT, then rerun docsfab runs show.`,
      checkedRoot: input.stateDirectory,
    };
  }
  return findRunDelivery({
    indexRoot,
    runId: input.runId,
    environment: input.environment,
  });
}

/**
 * Latest confirmed opening for one run. A run has more than one delivery only
 * when it was published with different plans (another base, target, or patch);
 * a repaired index append can occur after another plan has opened.
 */
export async function findRunDelivery(input: {
  indexRoot: string;
  runId: string;
  environment?: NodeJS.ProcessEnv;
}): Promise<RunDeliveryLookup> {
  return guardedLookup(
    input.indexRoot,
    async (indexDirectory, checkedRoot) => {
      const entries = await readKey(
        indexDirectory,
        "by-run",
        runDeliveryRunKey(input.runId),
        indexLimits(input.environment),
      );
      return entries === undefined ? undefined : newestOpenedDelivery(entries, checkedRoot);
    },
    { space: "by-run", key: runDeliveryRunKey(input.runId) },
  );
}

/** Latest confirmed opening for one merge request, by numeric project id. */
export async function findMergeRequestDelivery(input: {
  indexRoot: string;
  provider: "gitlab" | "github";
  host: string;
  projectId: number;
  mergeRequestIid: number;
  environment?: NodeJS.ProcessEnv;
}): Promise<RunDeliveryLookup> {
  return guardedLookup(input.indexRoot, async (indexDirectory, checkedRoot) => {
    const entries = await readKey(
      indexDirectory,
      "by-mr",
      runDeliveryMergeRequestKey(input),
      indexLimits(input.environment),
    );
    return entries === undefined ? undefined : newestOpenedDelivery(entries, checkedRoot);
  });
}

/**
 * Newest delivery for a merge request named by project path, as in a pasted
 * MR URL. The path hit must still be that project's newest recorded path; a
 * path the project no longer uses refuses instead of resolving to another MR.
 */
export async function findMergeRequestDeliveryByPath(input: {
  indexRoot: string;
  provider: "gitlab" | "github";
  host: string;
  path: string;
  mergeRequestIid: number;
  environment?: NodeJS.ProcessEnv;
}): Promise<RunDeliveryLookup> {
  return guardedLookup(input.indexRoot, async (indexDirectory, checkedRoot) => {
    const limits = indexLimits(input.environment);
    const byPath = await readKey(
      indexDirectory,
      "by-mr-path",
      runDeliveryMergeRequestPathKey(input),
      limits,
    );
    if (byPath === undefined) return undefined;
    // A repaired append can arrive after newer deliveries in either key.
    // The numeric-MR chain supplies all candidates for each project; the
    // receipt's confirmed opened transition supplies their actual order.
    const current: RunDeliveryIndexEntryV1[] = [];
    const seenProjects = new Set<number>();
    for (const pathEntry of byPath) {
      if (seenProjects.has(pathEntry.projectId)) continue;
      seenProjects.add(pathEntry.projectId);
      const byProject = await readKey(
        indexDirectory,
        "by-mr",
        runDeliveryMergeRequestKey(pathEntry),
        limits,
      );
      if (byProject === undefined) {
        throw invalid(
          `path-project-mismatch: ${input.path} merge request ${input.mergeRequestIid} has no numeric project history for project ${pathEntry.projectId}. Inspect the index before trusting this URL.`,
        );
      }
      const projectEntry = await newestOpenedEntry(byProject, checkedRoot);
      if (projectEntry.path !== input.path) continue;
      if (
        !byPath.some(
          (entry) =>
            entry.projectId === projectEntry.projectId &&
            entry.idempotencyKey === projectEntry.idempotencyKey,
        )
      ) {
        throw invalid(
          `path-project-mismatch: ${input.path} merge request ${input.mergeRequestIid} is missing its newest numeric project delivery in the path index. Replay its publication recovery command.`,
        );
      }
      current.push(projectEntry);
    }
    if (current.length !== 1) {
      throw new RunDeliveryLookupContractError(
        "run-delivery-index-invalid",
        `path-project-mismatch: ${input.path} merge request ${input.mergeRequestIid} has ${current.length} current project matches. Look the merge request up by its current URL or by project id.`,
      );
    }
    return verifyAgainstReceipt(current[0]!, checkedRoot);
  });
}

/** Every delivery recorded for one merge request, oldest opening first. */
export async function listMergeRequestDeliveries(input: {
  indexRoot: string;
  provider: "gitlab" | "github";
  host: string;
  projectId: number;
  mergeRequestIid: number;
  environment?: NodeJS.ProcessEnv;
}): Promise<RunDeliveryList> {
  const result = await guardedLookup(input.indexRoot, async (indexDirectory, checkedRoot) => {
    const entries = await readKey(
      indexDirectory,
      "by-mr",
      runDeliveryMergeRequestKey(input),
      indexLimits(input.environment),
    );
    if (entries === undefined) return undefined;
    const ordered = await orderedOpenedEntries(entries, checkedRoot);
    assertUniqueOpenedTimes(ordered);
    return {
      status: "listed",
      entries: ordered.map((delivery) => delivery.entry),
      checkedRoot,
    } as const;
  });
  return result;
}

/**
 * Root checks shared by every lookup. A missing receipt root or a missing
 * `run-index/` is `absent` (nothing was ever recorded there); everything that
 * exists must be an owner-private real directory. Never creates anything.
 */
async function guardedLookup<T extends { status: string }>(
  indexRoot: string,
  read: (indexDirectory: string, checkedRoot: string) => Promise<T | undefined>,
  fastReject?: { space: RunDeliveryIndexKeySpace; key: string },
): Promise<T | Exclude<RunDeliveryLookup, { status: "found" }>> {
  const checkedRoot = resolve(indexRoot);
  try {
    const rootDetails = await lstatOrUndefined(checkedRoot);
    if (rootDetails === undefined) {
      return {
        status: "absent",
        code: "run-delivery-not-recorded",
        checkedRoot,
      };
    }
    const realRoot = await realpath(checkedRoot);
    const indexDirectory = join(realRoot, RUN_DELIVERY_INDEX_DIRECTORY);
    const indexDetails = await lstatOrUndefined(indexDirectory);
    if (indexDetails === undefined) {
      return {
        status: "absent",
        code: "run-delivery-not-recorded",
        checkedRoot,
      };
    }
    if (!isPrivateDirectory(rootDetails, false)) {
      throw new RunDeliveryLookupContractError(
        "run-delivery-index-unavailable",
        `The receipt root ${checkedRoot} is not an owner-private real directory. Restore its owner and mode 0700, then rerun docsfab runs show.`,
      );
    }
    if (!isPrivateDirectory(indexDetails, true)) {
      throw new RunDeliveryLookupContractError(
        "run-delivery-index-invalid",
        `unsafe-directory: ${indexDirectory} is not an owner-private real directory. Inspect it; DocsFab only reads an index it could have written.`,
      );
    }
    // A special file at the exact known key is already unsafe. Reject it
    // promptly without opening it; every successful read still takes the
    // root gate and revalidates the entry there after any concurrent swap.
    if (fastReject) {
      const keyDirectory = join(indexDirectory, fastReject.space, keyDigest(fastReject.key));
      const first = await lstatOrUndefined(join(keyDirectory, entryName(1)));
      if (first && (!first.isFile() || first.isSymbolicLink())) {
        throw invalid(
          `unsafe-entry: ${join(keyDirectory, entryName(1))} is not a regular index entry.`,
        );
      }
    }
    const result = await withRunMaintenanceGate(checkedRoot, async () => {
      if (await lstatOrUndefined(join(indexDirectory, ".deletion-in-progress"))) {
        throw invalid(
          `maintenance-incomplete: ${indexDirectory} has an interrupted deletion. Resume run deletion before reading its index.`,
        );
      }
      return read(indexDirectory, checkedRoot);
    });
    return (
      result ?? {
        status: "absent",
        code: "run-delivery-not-recorded",
        checkedRoot,
      }
    );
  } catch (error) {
    if (error instanceof RunDeliveryLookupContractError) {
      return {
        status: "refused",
        code: error.code,
        detail: error.detail,
        checkedRoot,
      };
    }
    // Only filesystem faults (errors carrying a syscall) reach here; refusals were handled above.
    if (isFilesystemError(error)) {
      return {
        status: "refused",
        code: "run-delivery-index-unavailable",
        detail: `The run delivery index under ${checkedRoot} could not be read (${error.code}). Check the receipt root, then rerun docsfab runs show.`,
        checkedRoot,
      };
    }
    throw error;
  }
}

/** Entries of one key, oldest first, or undefined when the key has none. */
async function readKey(
  indexDirectory: string,
  space: RunDeliveryIndexKeySpace,
  key: string,
  limits: IndexLimits,
): Promise<RunDeliveryIndexEntryV1[] | undefined> {
  const spaceDirectory = join(indexDirectory, space);
  const spaceDetails = await lstatOrUndefined(spaceDirectory);
  if (spaceDetails === undefined) return undefined;
  if (!isPrivateDirectory(spaceDetails, true)) throw unsafeDirectory(spaceDirectory);
  const keyDirectory = join(spaceDirectory, keyDigest(key));
  const keyDetails = await lstatOrUndefined(keyDirectory);
  if (keyDetails === undefined) return undefined;
  if (!isPrivateDirectory(keyDetails, true)) throw unsafeDirectory(keyDirectory);
  const entries = await readKeyDirectory(keyDirectory, space, key, limits);
  return entries.length === 0 ? undefined : entries;
}

async function readKeyDirectory(
  keyDirectory: string,
  space: RunDeliveryIndexKeySpace,
  key: string,
  limits: IndexLimits,
): Promise<RunDeliveryIndexEntryV1[]> {
  const names: string[] = [];
  for (const name of await readdir(keyDirectory)) {
    if (PENDING_NAME.test(name)) continue;
    if (!ENTRY_NAME.test(name)) {
      throw invalid(`unexpected-entry-name: ${join(keyDirectory, name)} is not an index entry.`);
    }
    names.push(name);
  }
  names.sort();
  if (names.length > limits.entriesPerKey.value) {
    throw new RunDeliveryLookupContractError(
      limits.entriesPerKey.refusal as RunDeliveryLookupRefusalCode,
      `${formatLimitObservation(limits.entriesPerKey, names.length)} Key: ${keyDirectory}.`,
    );
  }
  const entries: RunDeliveryIndexEntryV1[] = [];
  for (const [index, name] of names.entries()) {
    const sequence = Number(ENTRY_NAME.exec(name)![1]);
    if (sequence !== index + 1) {
      throw invalid(`sequence-gap: ${join(keyDirectory, name)} is not entry ${index + 1}.`);
    }
    const entry = await readEntry(join(keyDirectory, name), limits.entryMaxBytes);
    const previous = entries.at(-1);
    if (
      entry.sequence !== sequence ||
      entry.previousEntrySha256 !== (previous?.sha256 ?? null) ||
      keyFor(space, entry) !== key
    ) {
      throw invalid(
        `chain-broken: ${join(keyDirectory, name)} does not continue its key's entry chain.`,
      );
    }
    entries.push(entry);
  }
  return entries;
}

async function readEntry(path: string, maxBytes: ResolvedLimit): Promise<RunDeliveryIndexEntryV1> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  } catch (error) {
    // A symlinked entry fails O_NOFOLLOW with ELOOP; other errors are filesystem faults.
    if (isNodeError(error, "ELOOP")) throw invalid(`unsafe-entry: ${path} is a symbolic link.`);
    throw error;
  }
  try {
    const details = await handle.stat();
    if (!details.isFile() || details.uid !== currentUid()) {
      throw invalid(`unsafe-entry: ${path} is not a regular file this user owns.`);
    }
    if (details.size > maxBytes.value) {
      throw new RunDeliveryLookupContractError(
        maxBytes.refusal as RunDeliveryLookupRefusalCode,
        `${formatLimitObservation(maxBytes, details.size)} Entry: ${path}.`,
      );
    }
    const bytes = await handle.readFile();
    if (bytes.byteLength > maxBytes.value) {
      throw new RunDeliveryLookupContractError(
        maxBytes.refusal as RunDeliveryLookupRefusalCode,
        `${formatLimitObservation(maxBytes, bytes.byteLength)} Entry: ${path}.`,
      );
    }
    return decodeEntry(bytes, path);
  } finally {
    await handle.close();
  }
}

function decodeEntry(bytes: Uint8Array, path: string): RunDeliveryIndexEntryV1 {
  let value: unknown;
  try {
    value = parseJsonEvidence(bytes, { requireCanonical: true });
  } catch {
    // Any parse failure of an entry file is corruption, never "no MR".
    throw invalid(`malformed-entry: ${path} is not canonical JSON.`);
  }
  const fields = [
    "schemaVersion",
    "kind",
    "runId",
    "runRecordSha256",
    "idempotencyKey",
    "receiptSha256",
    "receiptRoot",
    "planSha256",
    "provider",
    "host",
    "projectId",
    "path",
    "mergeRequestIid",
    "mergeRequestUrl",
    "sourceBranch",
    "targetBranch",
    "commitRevision",
    "headRevision",
    "sequence",
    "previousEntrySha256",
    "sha256",
  ];
  const entry = value as Record<string, unknown>;
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(entry).sort().join(",") !== [...fields].sort().join(",") ||
    entry.schemaVersion !== 1 ||
    entry.kind !== ENTRY_KIND ||
    !nonEmptyString(entry.runId) ||
    !isSha(entry.runRecordSha256) ||
    !isSha(entry.idempotencyKey) ||
    !isSha(entry.receiptSha256) ||
    !nonEmptyString(entry.receiptRoot) ||
    !isAbsolute(entry.receiptRoot) ||
    !isSha(entry.planSha256) ||
    (entry.provider !== "gitlab" && entry.provider !== "github") ||
    !nonEmptyString(entry.host) ||
    !positiveInteger(entry.projectId) ||
    !nonEmptyString(entry.path) ||
    !positiveInteger(entry.mergeRequestIid) ||
    !nonEmptyString(entry.mergeRequestUrl) ||
    !nonEmptyString(entry.sourceBranch) ||
    !nonEmptyString(entry.targetBranch) ||
    !isRevision(entry.commitRevision) ||
    !isRevision(entry.headRevision) ||
    !positiveInteger(entry.sequence) ||
    (entry.previousEntrySha256 !== null && !isSha(entry.previousEntrySha256)) ||
    !isSha(entry.sha256)
  ) {
    throw invalid(`malformed-entry: ${path} is not a run delivery index entry.`);
  }
  const { sha256, ...body } = entry;
  if (entrySha256(body) !== sha256) {
    throw invalid(`digest-mismatch: ${path} does not match its recorded sha256.`);
  }
  return value as RunDeliveryIndexEntryV1;
}

/**
 * Load the receipt the entry names from the root it was written under and
 * check identity. Equal digests are not required: replaying an opened
 * delivery can legitimately move its receipt to `recovered`.
 */
async function verifyAgainstReceipt(
  entry: RunDeliveryIndexEntryV1,
  checkedRoot: string,
): Promise<RunDeliveryLookup> {
  const rootDetails = await lstatOrUndefined(entry.receiptRoot);
  if (rootDetails === undefined) {
    throw new RunDeliveryLookupContractError(
      "run-delivery-receipt-missing",
      `The receipt root ${entry.receiptRoot} recorded for this delivery no longer exists. Restore it, or replay the publication recovery command.`,
    );
  }
  if (
    !isPrivateDirectory(rootDetails, true) ||
    (await realpath(entry.receiptRoot)) !== entry.receiptRoot
  ) {
    throw invalid(
      `unsafe-receipt-root: ${entry.receiptRoot} is not an owner-private real directory.`,
    );
  }
  let receipt: ScmDeliveryRecord | undefined;
  try {
    receipt = await new FileScmDeliveryReceiptStore(entry.receiptRoot).load(entry.idempotencyKey);
  } catch (error) {
    if (!(error instanceof ScmDeliveryReceiptStoreError)) throw error;
    // Only receipt-store refusals land here; a corrupt receipt differs from an unreadable store.
    if (error.code === "receipt-invalid" || error.code === "receipt-missing") {
      throw new RunDeliveryLookupContractError(
        "run-delivery-receipt-invalid",
        `The delivery receipt under ${entry.receiptRoot} failed its integrity checks (${error.code}). Inspect the receipt before replaying the publication.`,
      );
    }
    throw new RunDeliveryLookupContractError(
      "run-delivery-index-unavailable",
      `The receipt store at ${entry.receiptRoot} could not be read (${error.code}). Check it, then rerun docsfab runs show.`,
    );
  }
  if (receipt === undefined) {
    throw new RunDeliveryLookupContractError(
      "run-delivery-receipt-missing",
      `No delivery receipt ${entry.idempotencyKey} exists under ${entry.receiptRoot}. Restore the receipt, or replay the publication recovery command.`,
    );
  }
  const mismatch = identityMismatch(entry, receipt);
  if (mismatch !== undefined) {
    throw new RunDeliveryLookupContractError(
      "run-delivery-receipt-mismatch",
      `The delivery receipt under ${entry.receiptRoot} disagrees with its index entry on ${mismatch}. Inspect both before trusting this delivery.`,
    );
  }
  return {
    status: "found",
    entry,
    receipt,
    receiptSha256AtOpen: entry.receiptSha256,
    receiptSha256Current: receipt.sha256,
    disposition: receipt.disposition,
    checkedRoot,
  };
}

type VerifiedDelivery = Extract<RunDeliveryLookup, { status: "found" }>;

/** A repair append does not change the time the MR was actually opened. */
function openedAt(delivery: VerifiedDelivery): number {
  const attempts = delivery.receipt.attempts.filter(
    (attempt) => attempt.outcome === "confirmed" && attempt.toState === "opened",
  );
  if (attempts.length !== 1) {
    throw invalid(
      `opened-at-missing: delivery ${delivery.entry.idempotencyKey} has no unique confirmed opened transition. Inspect its receipt before trusting MR order.`,
    );
  }
  return Date.parse(attempts[0]!.at);
}

async function orderedOpenedEntries(
  entries: readonly RunDeliveryIndexEntryV1[],
  checkedRoot: string,
): Promise<Array<{ entry: RunDeliveryIndexEntryV1; openedAt: number }>> {
  const deliveries: Array<{ entry: RunDeliveryIndexEntryV1; openedAt: number }> = [];
  for (const entry of entries) {
    const delivery = await verifyAgainstReceipt(entry, checkedRoot);
    if (delivery.status !== "found")
      throw invalid("verified-delivery-missing: an indexed receipt was not found.");
    deliveries.push({ entry, openedAt: openedAt(delivery) });
  }
  deliveries.sort((left, right) => left.openedAt - right.openedAt);
  return deliveries;
}

function assertUniqueOpenedTimes(
  deliveries: readonly { entry: RunDeliveryIndexEntryV1; openedAt: number }[],
): void {
  for (let index = 1; index < deliveries.length; index += 1) {
    if (deliveries[index - 1]!.openedAt === deliveries[index]!.openedAt) {
      throw invalid(
        `opened-at-ambiguous: two deliveries have the same confirmed opened time. Inspect their run ids and receipts before trusting delivery order.`,
      );
    }
  }
}

async function newestOpenedEntry(
  entries: readonly RunDeliveryIndexEntryV1[],
  checkedRoot: string,
): Promise<RunDeliveryIndexEntryV1> {
  const ordered = await orderedOpenedEntries(entries, checkedRoot);
  const latest = ordered.at(-1)!;
  if (ordered.length > 1 && ordered.at(-2)!.openedAt === latest.openedAt) {
    throw invalid(
      `opened-at-ambiguous: multiple deliveries have the latest confirmed opened time. Look up each run id or inspect their receipts before trusting delivery order.`,
    );
  }
  return latest.entry;
}

async function newestOpenedDelivery(
  entries: readonly RunDeliveryIndexEntryV1[],
  checkedRoot: string,
): Promise<VerifiedDelivery> {
  const latest = await newestOpenedEntry(entries, checkedRoot);
  const delivery = await verifyAgainstReceipt(latest, checkedRoot);
  if (delivery.status !== "found")
    throw invalid("verified-delivery-missing: an indexed receipt was not found.");
  return delivery;
}

function identityMismatch(
  entry: RunDeliveryIndexEntryV1,
  receipt: ScmDeliveryRecord,
): string | undefined {
  const pairs: ReadonlyArray<[string, unknown, unknown]> = [
    ["idempotencyKey", receipt.idempotencyKey, entry.idempotencyKey],
    ["planSha256", receipt.planSha256, entry.planSha256],
    ["run.id", receipt.run.id, entry.runId],
    ["run.recordSha256", receipt.run.recordSha256, entry.runRecordSha256],
    ["repository.provider", receipt.repository.provider, entry.provider],
    ["repository.host", receipt.repository.host, entry.host],
    ["repository.projectId", receipt.repository.projectId, entry.projectId],
    ["repository.path", receipt.repository.path, entry.path],
    ["sourceBranch", receipt.sourceBranch, entry.sourceBranch],
    ["targetBranch", receipt.targetBranch, entry.targetBranch],
    ["evidence.mergeRequest.iid", receipt.evidence.mergeRequest?.iid, entry.mergeRequestIid],
  ];
  return pairs.find(([, left, right]) => left !== right)?.[0];
}

/** Append one entry unless the key already records this idempotency key. */
async function appendEntry(
  keyDirectory: string,
  space: RunDeliveryIndexKeySpace,
  key: string,
  base: Omit<RunDeliveryIndexEntryV1, "sequence" | "previousEntrySha256" | "sha256">,
  limits: IndexLimits,
): Promise<boolean> {
  // Each pass that loses a link race re-reads a strictly longer key, so the
  // entries-per-key bound ends the loop.
  for (;;) {
    let existing: RunDeliveryIndexEntryV1[];
    try {
      existing = await readKeyDirectory(keyDirectory, space, key, limits);
    } catch (error) {
      if (error instanceof RunDeliveryLookupContractError) {
        throw new RunDeliveryIndexContractError(RUN_DELIVERY_INDEX_WRITE_FAILED, error.detail, {
          cause: error,
        });
      }
      throw error;
    }
    if (existing.some((entry) => entry.idempotencyKey === base.idempotencyKey)) return false;
    const sequence = existing.length + 1;
    if (sequence > limits.entriesPerKey.value) refuseLimit(limits.entriesPerKey, sequence);
    const body = {
      ...base,
      sequence,
      previousEntrySha256: existing.at(-1)?.sha256 ?? null,
    };
    const entry = { ...body, sha256: entrySha256(body) };
    const bytes = Buffer.from(canonicalizeJsonEvidence(entry as unknown as JsonEvidenceValue));
    if (bytes.byteLength > limits.entryMaxBytes.value) {
      refuseLimit(limits.entryMaxBytes, bytes.byteLength);
    }
    if (await publishEntry(keyDirectory, entryName(sequence), bytes)) return true;
  }
}

/** Write a temp file, then hard-link it into place without replacing; false on a lost race. */
async function publishEntry(directory: string, name: string, bytes: Buffer): Promise<boolean> {
  const pending = join(directory, `.pending-${randomUUID()}.json`);
  const handle = await open(
    pending,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    PRIVATE_FILE_MODE,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(pending, join(directory, name));
  } catch (error) {
    await unlink(pending);
    // EEXIST: another publisher recorded this sequence first; the caller re-reads.
    if (isNodeError(error, "EEXIST")) return false;
    throw error;
  }
  await syncDirectory(directory);
  await unlink(pending);
  await syncDirectory(directory);
  return true;
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function ensurePrivateDirectory(path: string): Promise<string> {
  try {
    await mkdir(path, { mode: PRIVATE_DIRECTORY_MODE });
  } catch (error) {
    // EEXIST is the normal case after the first delivery; the checks below decide trust.
    if (!isNodeError(error, "EEXIST")) throw error;
  }
  await assertPrivateDirectory(path, "a run delivery index directory");
  return path;
}

async function assertPrivateDirectory(path: string, role: string): Promise<void> {
  const details = await lstat(path);
  if (!isPrivateDirectory(details, false)) {
    throw new RunDeliveryIndexContractError(
      RUN_DELIVERY_INDEX_WRITE_FAILED,
      `${path} is ${role} but not an owner-private real directory.`,
    );
  }
}

function isPrivateDirectory(
  details: Awaited<ReturnType<typeof lstat>>,
  exactMode: boolean,
): boolean {
  const mode = Number(details.mode);
  return (
    !details.isSymbolicLink() &&
    details.isDirectory() &&
    Number(details.uid) === currentUid() &&
    (exactMode ? (mode & 0o777) === PRIVATE_DIRECTORY_MODE : (mode & 0o077) === 0)
  );
}

function currentUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

async function lstatOrUndefined(
  path: string,
): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    // ENOENT is "never recorded here"; every other error is a fault the caller reports.
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  }
}

function keyFor(space: RunDeliveryIndexKeySpace, entry: RunDeliveryIndexEntryV1): string {
  if (space === "by-run") return runDeliveryRunKey(entry.runId);
  if (space === "by-mr") return runDeliveryMergeRequestKey(entry);
  return runDeliveryMergeRequestPathKey(entry);
}

function keyDigest(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/** Caller holds the receipt-root maintenance gate while capturing all affected chains. */
export async function inventoryRunDeliveryIndexUnderGate(input: {
  indexRoot: string;
  runId: string;
  recordSha256: string;
  environment?: NodeJS.ProcessEnv;
}): Promise<readonly RunDeliveryIndexDeletionChain[]> {
  const indexDirectory = join(input.indexRoot, RUN_DELIVERY_INDEX_DIRECTORY);
  if (!(await lstatOrUndefined(indexDirectory))) return [];
  await assertPrivateDirectory(indexDirectory, "a run delivery index directory");
  const limits = indexLimits(input.environment);
  const chains: RunDeliveryIndexDeletionChain[] = [];
  for (const space of ["by-run", "by-mr", "by-mr-path"] as const) {
    const spaceDirectory = join(indexDirectory, space);
    if (!(await lstatOrUndefined(spaceDirectory))) continue;
    await assertPrivateDirectory(spaceDirectory, "a run delivery index keyspace");
    for (const directoryName of (await readdir(spaceDirectory)).sort()) {
      if (!SHA256.test(directoryName))
        throw invalid(`unexpected-key-directory: ${join(spaceDirectory, directoryName)}.`);
      const directory = join(spaceDirectory, directoryName);
      await assertPrivateDirectory(directory, "a run delivery index key");
      const first = (await readdir(directory)).filter((name) => ENTRY_NAME.test(name)).sort()[0];
      if (!first) continue;
      const firstEntry = await readEntry(join(directory, first), limits.entryMaxBytes);
      const key = keyFor(space, firstEntry);
      if (keyDigest(key) !== directoryName)
        throw invalid(`key-mismatch: ${directory} has another key's entries.`);
      const entries = await readKeyDirectory(directory, space, key, limits);
      if (!entries.some((entry) => entry.runId === input.runId)) continue;
      if (
        entries.some(
          (entry) => entry.runId === input.runId && entry.runRecordSha256 !== input.recordSha256,
        )
      ) {
        throw invalid(
          "run-record-mismatch: delivery index names a different run record; inspect it before deletion.",
        );
      }
      const slots: RunDeliveryIndexDeletionSlot[] = [];
      for (const entry of entries) {
        const path = join(directory, entryName(entry.sequence));
        const stat = await lstat(path);
        if (
          !stat.isFile() ||
          stat.isSymbolicLink() ||
          stat.nlink !== 1 ||
          stat.uid !== currentUid()
        )
          throw invalid(`unsafe-entry: ${path}`);
        const bytes = await readFile(path);
        slots.push({
          path,
          dev: stat.dev,
          ino: stat.ino,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          entry,
        });
      }
      chains.push({ space, key, directory, slots });
    }
  }
  return chains;
}

/** Replace derived chains under the caller's root gate; marker blocks readers after interruption. */
export async function purgeRunDeliveryIndexUnderGate(input: {
  indexRoot: string;
  runId: string;
  recordSha256: string;
  chains: readonly RunDeliveryIndexDeletionChain[];
  afterKeyspace?: (space: RunDeliveryIndexKeySpace) => void | Promise<void>;
}): Promise<number> {
  if (input.chains.length === 0) return 0;
  const indexDirectory = join(input.indexRoot, RUN_DELIVERY_INDEX_DIRECTORY);
  const marker = join(indexDirectory, ".deletion-in-progress");
  const markerBody = createHash("sha256").update(JSON.stringify(input.chains)).digest("hex");
  const existingMarker = await lstatOrUndefined(marker);
  if (existingMarker) {
    if (!existingMarker.isFile() || (await readFile(marker, "utf8")) !== markerBody)
      throw invalid("maintenance-incomplete: another deletion owns the index marker.");
  } else {
    const handle = await open(
      marker,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      PRIVATE_FILE_MODE,
    );
    try {
      await handle.writeFile(markerBody);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  let removed = 0;
  for (const chain of input.chains) {
    const expected = join(indexDirectory, chain.space, keyDigest(chain.key));
    if (chain.directory !== expected)
      throw invalid("deletion-chain-path: approved index path changed.");
    const backup = `${expected}.deletion-backup`;
    const backupStat = await lstatOrUndefined(backup);
    const retained = rebuiltChainEntries(chain, input.runId, input.recordSha256);
    removed += chain.slots.length - retained.length;
    if (!backupStat) {
      const present = await readKeyDirectory(
        expected,
        chain.space,
        chain.key,
        indexLimits(undefined),
      );
      if (JSON.stringify(present) === JSON.stringify(retained)) continue;
      for (const slot of chain.slots) {
        const stat = await lstat(slot.path);
        const digest = createHash("sha256")
          .update(await readFile(slot.path))
          .digest("hex");
        if (
          stat.dev !== slot.dev ||
          stat.ino !== slot.ino ||
          stat.size !== slot.size ||
          stat.mtimeMs !== slot.mtimeMs ||
          digest !== slot.sha256
        ) {
          throw invalid(`deletion-entry-changed: ${slot.path}; preview again.`);
        }
      }
      await rename(expected, backup);
    } else {
      if (!backupStat.isDirectory() || backupStat.isSymbolicLink())
        throw invalid("deletion-backup-unsafe: inspect interrupted index rebuild.");
      for (const slot of chain.slots) {
        const path = join(backup, entryName(slot.entry.sequence));
        const stat = await lstat(path);
        const sha256 = createHash("sha256")
          .update(await readFile(path))
          .digest("hex");
        if (
          stat.dev !== slot.dev ||
          stat.ino !== slot.ino ||
          stat.size !== slot.size ||
          stat.mtimeMs !== slot.mtimeMs ||
          sha256 !== slot.sha256
        ) {
          throw invalid(`deletion-backup-changed: ${path}; inspect interrupted rebuild.`);
        }
      }
      if (await lstatOrUndefined(expected)) await rm(expected, { recursive: true, force: false });
    }
    await mkdir(expected, { mode: PRIVATE_DIRECTORY_MODE });
    for (const entry of retained) {
      const bytes = Buffer.from(canonicalizeJsonEvidence(entry as unknown as JsonEvidenceValue));
      if (!(await publishEntry(expected, entryName(entry.sequence), bytes)))
        throw invalid("deletion-rebuild-conflict: index slot appeared during maintenance.");
    }
    await input.afterKeyspace?.(chain.space);
  }
  for (const chain of input.chains) {
    const backup = `${chain.directory}.deletion-backup`;
    if (await lstatOrUndefined(backup)) await rm(backup, { recursive: true, force: false });
  }
  await unlink(marker);
  return removed;
}

function rebuiltChainEntries(
  chain: RunDeliveryIndexDeletionChain,
  runId: string,
  recordSha256: string,
): RunDeliveryIndexEntryV1[] {
  const retained: RunDeliveryIndexEntryV1[] = [];
  let previous: string | null = null;
  for (const slot of chain.slots) {
    if (slot.entry.runId === runId) {
      if (slot.entry.runRecordSha256 !== recordSha256)
        throw invalid("run-record-mismatch: target index row changed.");
      continue;
    }
    const {
      sha256: _oldDigest,
      sequence: _oldSequence,
      previousEntrySha256: _oldPrevious,
      ...base
    } = slot.entry;
    const body: Omit<RunDeliveryIndexEntryV1, "sha256"> = {
      ...base,
      sequence: retained.length + 1,
      previousEntrySha256: previous,
    };
    const entry: RunDeliveryIndexEntryV1 = { ...body, sha256: entrySha256(body) };
    retained.push(entry);
    previous = entry.sha256;
  }
  return retained;
}

function entryName(sequence: number): string {
  return `${String(sequence).padStart(6, "0")}.json`;
}

function entrySha256(body: Record<string, unknown>): string {
  return createHash("sha256")
    .update(canonicalizeJsonEvidence(body as JsonEvidenceValue))
    .digest("hex");
}

function invalid(detail: string): RunDeliveryLookupContractError {
  return new RunDeliveryLookupContractError("run-delivery-index-invalid", detail);
}

function unsafeDirectory(path: string): RunDeliveryLookupContractError {
  return invalid(`unsafe-directory: ${path} is not an owner-private real directory.`);
}

function overlaps(left: string, right: string): boolean {
  const leftToRight = relative(left, right);
  const rightToLeft = relative(right, left);
  return (
    left === right ||
    (!leftToRight.startsWith("..") && !isAbsolute(leftToRight)) ||
    (!rightToLeft.startsWith("..") && !isAbsolute(rightToLeft))
  );
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message.replace(/\.$/u, "");
  return "unknown error";
}

function isFilesystemError(error: unknown): error is NodeJS.ErrnoException & { code: string } {
  const candidate = error as NodeJS.ErrnoException;
  return (
    error instanceof Error &&
    typeof candidate.code === "string" &&
    typeof candidate.syscall === "string"
  );
}

function isSha(value: unknown): value is string {
  return typeof value === "string" && SHA256.test(value);
}

function isRevision(value: unknown): value is string {
  return typeof value === "string" && REVISION.test(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}
