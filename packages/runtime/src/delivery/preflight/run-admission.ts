// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import { lstat, open, realpath, stat, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import type { ChangedFileEvidence, PatchMetadata } from "../../impact/contracts.js";
import type { CredentialFinding } from "../../security/credential-findings.js";
import type {
  WorkflowOutcomeEnvelopeV1,
  WorkflowName,
} from "../../workflow-contracts/contracts.js";
import {
  canonicalizeJsonEvidence,
  parseJsonEvidence,
  type JsonEvidenceValue,
} from "../../json-evidence.js";
import {
  LocalUserPublicationPreflightError,
  type LocalUserPublicationFailureCode,
  type LocalUserPublicationPreflightDetails,
} from "../contracts.js";
import {
  decodeSuccessfulCheckoutRunRecord,
  decodeSuccessfulPublicationRunRecord,
  PublicationRunRecordDecodeError,
  type PublicationRunRecordDecodeOptionsV1,
} from "../run-record.js";
import { getWorkflow } from "../../workflow-registry/catalog.js";
import {
  assertTaskLineageProjection,
  type TaskLineageProjectionV1,
} from "../../lineage/contracts.js";
import {
  createCompositionPublicationBinding,
  type CompositionPublicationBindingV1,
} from "../metadata.js";
import { containsConfiguredCredential } from "../../security/configured-credentials.js";
import { readRequiredCheckLimitations } from "../../workflow-execution/required-check-limitation.js";
import { formatLimitObservation, limit } from "../../config/limits.js";
import { runRecordMaxBytes } from "../../records/run-record-limit.js";
import { isNodeError, pathExists } from "../../shared/primitives.js";
import { fail, object, SAFE_ID, safeRepositoryPath } from "./primitives.js";

const SHA256 = /^[a-f0-9]{64}$/u;

// Patch readers share the capture bound, so every patch the run can capture is readable.
const PATCH_BYTES_LIMIT = "repository.evidenceGitOutputMaxBytes";

/** The catalog refusal of `runs.recordMaxBytes`, which is also this preflight's code. */
const RUN_RECORD_BOUND_CODE = "runs-record-max-bytes-bound";

export interface VerifiedPublicationRun {
  id: string;
  workflow: WorkflowName;
  workflowOutcome: string;
  recordSha256: string;
  sourcePath: string;
  revision: string;
  patch: PatchMetadata;
  patchBytes: Buffer;
  changedFiles: ChangedFileEvidence[];
  changedFileCount: number;
  /** Ephemeral operator instruction when recorded on the run; absent otherwise. */
  instruction?: string;
  /** Validated product outcome envelope when recorded on the run. */
  productOutcome?: WorkflowOutcomeEnvelopeV1;
  /**
   * Sealed task-lineage projection from the run record, or null for a legacy run
   * that recorded none; the commit and draft-MR narrative render from it.
   */
  taskLineage: TaskLineageProjectionV1 | null;
  /** Terminal composition selection and aggregate required for marked publication. */
  compositionExecution?: CompositionPublicationBindingV1;
  /**
   * Content-free `credential-like-content` findings the run recorded (#1807),
   * sorted and unique; the draft MR's Notes block lists them.
   */
  credentialFindings?: readonly CredentialFinding[];
  /**
   * The run's "required check could not run" lines (#1918), which the draft MR
   * repeats so maintainers see them; absent when every required check ran.
   */
  requiredCheckLimitations?: readonly string[];
}

/**
 * `--state-dir` must name the run-store directory itself. Selecting its parent
 * or the config-root above `.docsfab/runs` is a distinct closed fail, not a
 * generic missing record.
 */
export async function rejectStateDirectoryParentOfRunStore(
  stateDirectory: string,
  runId: string,
  editorialDecodeOptions: PublicationRunRecordDecodeOptionsV1 = {},
): Promise<void> {
  if (!SAFE_ID.test(runId)) return;
  const selected = resolve(stateDirectory);
  const selectedRecordPath = join(selected, `${runId}.json`);
  if (await pathExists(selectedRecordPath)) return;
  const nestedStore = await nestedIntactRunStore(selected, runId, editorialDecodeOptions);
  if (nestedStore === undefined) return;
  fail("state-directory-not-run-store", { selectedDirectory: selected });
}

async function nestedIntactRunStore(
  selected: string,
  runId: string,
  editorialDecodeOptions: PublicationRunRecordDecodeOptionsV1,
): Promise<string | undefined> {
  for (const relativeParts of [["runs"], [".docsfab", "runs"]]) {
    const candidate = await privateNestedStoreDirectory(selected, relativeParts);
    if (candidate === undefined) continue;
    if (await intactPublicationRunRecord(candidate, runId, editorialDecodeOptions))
      return candidate.path;
  }
  return undefined;
}

interface DirectorySnapshot {
  readonly path: string;
  readonly stats: Stats;
}

interface PrivateNestedStoreDirectory {
  readonly path: string;
  readonly chain: readonly DirectorySnapshot[];
  readonly privateStart: number;
}

async function privateNestedStoreDirectory(
  selected: string,
  relativeParts: readonly string[],
): Promise<PrivateNestedStoreDirectory | undefined> {
  const chain = await directoryChain(selected);
  if (chain === undefined) return undefined;
  const privateStart = chain.length;
  let current = selected;
  for (const part of relativeParts) {
    current = join(current, part);
    const stats = await safeLstatDirectory(current);
    if (stats === undefined || !privateDirectory(stats)) return undefined;
    chain.push({ path: current, stats });
  }
  return { path: current, chain, privateStart };
}

async function directoryChain(path: string): Promise<DirectorySnapshot[] | undefined> {
  const paths: string[] = [];
  let current = resolve(path);
  while (true) {
    paths.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const chain: DirectorySnapshot[] = [];
  for (const ancestor of paths.reverse()) {
    const stats = await safeLstatDirectory(ancestor);
    if (stats === undefined) return undefined;
    chain.push({ path: ancestor, stats });
  }
  return chain;
}

async function intactPublicationRunRecord(
  store: PrivateNestedStoreDirectory,
  expectedRunId: string,
  editorialDecodeOptions: PublicationRunRecordDecodeOptionsV1,
): Promise<boolean> {
  const recordPath = join(store.path, `${expectedRunId}.json`);
  const leaf = await safeLstat(recordPath);
  if (leaf === undefined || !privateRegularFile(leaf)) return false;
  try {
    const bytes = await readPrivateFile(
      recordPath,
      runRecordMaxBytes().value,
      "invalid-run-record",
      fsConstants.O_NONBLOCK,
    );
    if (!(await samePrivateDirectoryChain(store.chain, store.privateStart))) return false;
    const value = parseJsonEvidence(bytes);
    const decoded = decodeSuccessfulPublicationRunRecord(value, editorialDecodeOptions);
    return decoded.id === expectedRunId;
  } catch {
    return false;
  }
}

async function safeLstat(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch {
    return undefined;
  }
}

async function safeLstatDirectory(path: string): Promise<Stats | undefined> {
  const stats = await safeLstat(path);
  if (stats === undefined) return undefined;
  if (!stats.isSymbolicLink()) return stats.isDirectory() ? stats : undefined;
  if (!(await isOperatingSystemDirectoryAlias(path))) return undefined;
  const followed = await stat(path).catch(() => undefined);
  return followed?.isDirectory() ? followed : undefined;
}

function privateDirectory(stats: Stats): boolean {
  const owner = typeof process.getuid === "function" ? process.getuid() : undefined;
  return owner !== undefined && stats.uid === owner && (stats.mode & 0o7777) === 0o700;
}

async function samePrivateDirectoryChain(
  chain: readonly DirectorySnapshot[],
  privateStart: number,
): Promise<boolean> {
  for (const [index, snapshot] of chain.entries()) {
    const current = await safeLstatDirectory(snapshot.path);
    if (
      current === undefined ||
      current.isSymbolicLink() !== snapshot.stats.isSymbolicLink() ||
      current.dev !== snapshot.stats.dev ||
      current.ino !== snapshot.stats.ino ||
      current.uid !== snapshot.stats.uid ||
      current.mode !== snapshot.stats.mode ||
      (index >= privateStart && !privateDirectory(current))
    ) {
      return false;
    }
  }
  return true;
}

async function isOperatingSystemDirectoryAlias(path: string): Promise<boolean> {
  if (process.platform !== "darwin" || (path !== "/var" && path !== "/tmp")) return false;
  const canonical = await realpath(path).catch(() => "");
  return canonical === `/private${path}`;
}

export async function loadVerifiedPublicationRun(
  path: string,
  expectedRunId: string,
  editorialDecodeOptions: PublicationRunRecordDecodeOptionsV1 = {},
): Promise<VerifiedPublicationRun> {
  return loadVerifiedRun(
    path,
    expectedRunId,
    editorialDecodeOptions,
    decodeSuccessfulPublicationRunRecord,
    true,
  );
}

/** Revalidate an already-bound publication record without reclassifying its loss as selection. */
export async function reloadVerifiedPublicationRun(
  path: string,
  expectedRunId: string,
  editorialDecodeOptions: PublicationRunRecordDecodeOptionsV1 = {},
): Promise<VerifiedPublicationRun> {
  return loadVerifiedRun(
    path,
    expectedRunId,
    editorialDecodeOptions,
    decodeSuccessfulPublicationRunRecord,
  );
}

/** Local checkout uses the same patch checks without acquiring publication eligibility. */
export async function loadVerifiedCheckoutRun(
  path: string,
  expectedRunId: string,
  editorialDecodeOptions: PublicationRunRecordDecodeOptionsV1 = {},
): Promise<VerifiedPublicationRun> {
  return loadVerifiedRun(
    path,
    expectedRunId,
    editorialDecodeOptions,
    decodeSuccessfulCheckoutRunRecord,
  );
}

async function loadVerifiedRun(
  path: string,
  expectedRunId: string,
  editorialDecodeOptions: PublicationRunRecordDecodeOptionsV1,
  decodeRecord: typeof decodeSuccessfulPublicationRunRecord,
  reportMissingRecord = false,
): Promise<VerifiedPublicationRun> {
  await rejectStateDirectoryParentOfRunStore(dirname(path), expectedRunId, editorialDecodeOptions);
  if (
    reportMissingRecord &&
    SAFE_ID.test(expectedRunId) &&
    isAbsolute(path) &&
    resolve(path) === path &&
    basename(path) === `${expectedRunId}.json`
  ) {
    try {
      // A present leaf still belongs to the pinned reader, including dangling links.
      await lstat(path);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        // A missing leaf must not hide a symlink/non-directory in the selected path.
        let parent = dirname(path);
        while ((await safeLstat(parent)) === undefined && parent !== dirname(parent))
          parent = dirname(parent);
        const chain = await directoryChain(parent);
        if (!chain || !(await samePrivateDirectoryChain(chain, chain.length)))
          fail("invalid-run-record");
        fail("saved-run-not-found");
      }
      fail("invalid-run-record");
    }
  }
  const recordBound = runRecordMaxBytes();
  const bytes = await readPrivateFile(
    path,
    recordBound.value,
    "invalid-run-record",
    0,
    // An oversized record is refused by the run-record limit, never as invalid.
    (observed) =>
      fail(RUN_RECORD_BOUND_CODE, { limitRefusal: formatLimitObservation(recordBound, observed) }),
  );
  let value: JsonEvidenceValue;
  try {
    value = parseJsonEvidence(bytes);
  } catch {
    fail("invalid-run-record");
  }
  if (!object(value) || value.status !== "succeeded") {
    if (object(value) && value.status !== "succeeded") fail("run-not-succeeded");
    fail("invalid-run-record");
  }
  let decoded;
  try {
    decoded = decodeRecord(value, editorialDecodeOptions);
  } catch (error) {
    if (error instanceof PublicationRunRecordDecodeError) fail("run-record-contract-gap");
    fail("invalid-run-record");
  }
  if (decoded.id !== expectedRunId) fail("invalid-run-record");
  const repository = value.repository as { [key: string]: JsonEvidenceValue };
  const steps = value.steps as JsonEvidenceValue[];
  const changes = value.changes as { [key: string]: JsonEvidenceValue };
  if (!isAbsolute(repository.sourcePath as string)) fail("invalid-run-record");
  if (!steps.some((step) => object(step) && step.mode === "write" && step.status === "succeeded")) {
    fail("run-not-write-capable");
  }
  if (!Array.isArray(changes.files) || changes.files.some((file) => !validChangedFile(file))) {
    fail("patch-ineligible");
  }
  const changedFiles = changes.files as unknown as ChangedFileEvidence[];
  if (new Set(changedFiles.map(changedFileKey)).size !== changedFiles.length)
    fail("patch-ineligible");
  const patch = validatePatch(changes.patch);
  if (changes.files.length === 0 || patch.byteLength === 0) fail("patch-ineligible");
  const patchBytes = await verifyPatch(patch);
  let taskLineage: TaskLineageProjectionV1 | null = null;
  if (value.taskLineage !== undefined && value.taskLineage !== null) {
    // A present-but-tampered lineage projection is a corrupt run record, not a
    // reason to fall back silently to a provenance-free narrative.
    try {
      taskLineage = assertTaskLineageProjection(value.taskLineage);
    } catch {
      fail("invalid-run-record");
    }
  }
  // Read after `verifyPatch`, whose configured-credential screen refuses a
  // patch with DocsFab's own credential before any limitation reaches the
  // draft MR (#1807, #1918).
  const requiredCheckLimitations = readRequiredCheckLimitations(decoded);
  const compositionExecution =
    decoded.compositionExecution === undefined
      ? undefined
      : createCompositionPublicationBinding({
          compositionId: decoded.compositionExecution.compositionId,
          evidenceSha256: decoded.compositionExecution.evidenceSha256,
          aggregateSha256: decoded.compositionExecutionAggregate!.aggregateSha256,
        });
  return {
    id: decoded.id,
    workflow: decoded.workflow,
    workflowOutcome: getWorkflow(decoded.workflow).outcome,
    recordSha256: createHash("sha256").update(bytes).digest("hex"),
    sourcePath: repository.sourcePath as string,
    revision: repository.revision as string,
    patch,
    patchBytes,
    changedFiles,
    changedFileCount: changes.files.length,
    ...(decoded.instruction === undefined ? {} : { instruction: decoded.instruction }),
    ...(decoded.workflowOutcome === undefined ? {} : { productOutcome: decoded.workflowOutcome }),
    taskLineage,
    ...(compositionExecution ? { compositionExecution } : {}),
    ...(decoded.credentialFindings?.length
      ? { credentialFindings: decoded.credentialFindings }
      : {}),
    ...(requiredCheckLimitations.length > 0 ? { requiredCheckLimitations } : {}),
  };
}

function validatePatch(value: JsonEvidenceValue | undefined): PatchMetadata {
  if (
    !object(value) ||
    Object.keys(value).sort().join(",") !== "artifactPath,byteLength,format,lineCount,sha256" ||
    typeof value.sha256 !== "string" ||
    !SHA256.test(value.sha256) ||
    typeof value.byteLength !== "number" ||
    !Number.isSafeInteger(value.byteLength) ||
    value.byteLength <= 0 ||
    value.byteLength > limit(PATCH_BYTES_LIMIT).value ||
    typeof value.lineCount !== "number" ||
    !Number.isSafeInteger(value.lineCount) ||
    value.lineCount <= 0 ||
    typeof value.artifactPath !== "string" ||
    !isAbsolute(value.artifactPath) ||
    value.format !== "git-diff"
  ) {
    fail("patch-ineligible");
  }
  return value as unknown as PatchMetadata;
}

async function verifyPatch(patch: PatchMetadata): Promise<Buffer> {
  let handle: FileHandle | undefined;
  try {
    const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
    handle = await open(patch.artifactPath, fsConstants.O_RDONLY | noFollow);
    const before = await handle.stat();
    if (
      !privateRegularFile(before) ||
      before.size !== patch.byteLength ||
      before.size > limit(PATCH_BYTES_LIMIT).value
    ) {
      fail("patch-mismatch");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const pathAfter = await lstat(patch.artifactPath);
    if (
      !after.isFile() ||
      pathAfter.isSymbolicLink() ||
      !pathAfter.isFile() ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      after.dev !== pathAfter.dev ||
      after.ino !== pathAfter.ino ||
      bytes.byteLength !== after.size ||
      createHash("sha256").update(bytes).digest("hex") !== patch.sha256
    ) {
      fail("patch-mismatch");
    }
    // DocsFab's own configured credentials never reach published output
    // (#1807): the patch is what a push publishes. A credential shape alone
    // is the maintainers' to judge and does not stop publication.
    if (containsConfiguredCredential(bytes.toString("utf8"))) fail("patch-credential-material");
    return bytes;
  } catch (error) {
    if (error instanceof LocalUserPublicationPreflightError) throw error;
    return fail("patch-unavailable");
  } finally {
    await handle?.close();
  }
}

function validChangedFile(value: JsonEvidenceValue): boolean {
  if (
    !object(value) ||
    typeof value.path !== "string" ||
    !safeRepositoryPath(value.path) ||
    typeof value.status !== "string" ||
    !["added", "modified", "deleted", "renamed", "copied"].includes(value.status)
  )
    return false;
  const moves = value.status === "renamed" || value.status === "copied";
  const validShape = moves
    ? typeof value.previousPath === "string" && safeRepositoryPath(value.previousPath)
    : value.previousPath === undefined;
  return (
    validShape &&
    Object.keys(value).sort().join(",") === (moves ? "path,previousPath,status" : "path,status")
  );
}

function changedFileKey(value: ChangedFileEvidence): string {
  return `${value.status}\0${value.previousPath ?? ""}\0${value.path}`;
}

async function readPrivateFile(
  path: string,
  maximumBytes: number,
  code: LocalUserPublicationFailureCode,
  openFlags = 0,
  refuseSize?: (observed: number) => never,
): Promise<Buffer> {
  let handle: FileHandle | undefined;
  try {
    const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
    handle = await open(path, fsConstants.O_RDONLY | noFollow | openFlags);
    const before = await handle.stat();
    if (!privateRegularFile(before) || before.size <= 0) fail(code);
    if (before.size > maximumBytes) {
      if (refuseSize) refuseSize(before.size);
      fail(code);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const pathAfter = await lstat(path);
    if (
      !privateRegularFile(after) ||
      pathAfter.isSymbolicLink() ||
      !privateRegularFile(pathAfter) ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      after.dev !== pathAfter.dev ||
      after.ino !== pathAfter.ino ||
      bytes.byteLength !== after.size
    )
      fail(code);
    return bytes;
  } catch (error) {
    if (error instanceof LocalUserPublicationPreflightError) throw error;
    return fail(code);
  } finally {
    await handle?.close();
  }
}

function privateRegularFile(value: Stats): boolean {
  const owner = typeof process.getuid === "function" ? process.getuid() : undefined;
  return owner !== undefined && value.isFile() && value.uid === owner && (value.mode & 0o077) === 0;
}
