// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Private source bytes and their closed object graph. A run binding is a separate contract. */
import { createHash } from "node:crypto";

import { DurableArtifactStore, opaqueRecordDigest } from "../artifacts/store.js";
import { limit, refuseLimit, type ResolveLimitsOptions } from "../config/limits.js";
import { createContractKit } from "../contract-kit/index.js";
import { decodeSuccessfulReviewRunRecord } from "../delivery/run-record.js";
import { changeSourceAcquiredOriginalBytes } from "../inputs/change-source/acquisition.js";
import { decodeChangeSourceV1, type ChangeSourceV1 } from "../inputs/change-source.js";
import type { RunRecord } from "../records/contracts.js";
import type { FileRunStore } from "../records/file-store.js";
import { decodeReviewDeliverySnapshotReference } from "../records/review-delivery-snapshot-reference.js";
import type { ReviewDiffHunk, ReviewDiffState } from "./anchors.js";
import type { ReviewDeliverySnapshot } from "./contracts.js";
import {
  admittedReviewSourceSidePresence,
  reviewDeliverySnapshotDigest,
} from "./snapshot-digest.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const REASONS = [
  "not-in-source",
  "source-omitted",
  "unsupported-gitlink",
  "unsupported-mode",
] as const;
export type SourceSideReason = (typeof REASONS)[number];

export interface SourceSnapshotSideBytes {
  readonly objectId: string;
  readonly bytes: Uint8Array;
  /** The source's stated hash, independently retained even if it differs from the raw bytes. */
  readonly statedSha256: string | null;
}

export interface SourceSnapshotUnavailableSide {
  readonly reason: SourceSideReason;
  readonly statedSha256: string | null;
}

export interface SourceSnapshotRowInput {
  readonly state: ReviewDiffState;
  /** Exact number of consecutive unified-diff sections for this source row. */
  readonly sections: number;
  readonly before: SourceSnapshotSideBytes | SourceSnapshotUnavailableSide;
  readonly after: SourceSnapshotSideBytes | SourceSnapshotUnavailableSide;
}

export interface SourceSnapshotPartInput {
  readonly runId: string;
  readonly sourceSha256: string;
  readonly repositoryIdentitySha256: string;
  readonly reviewedHeadSha: string;
  /** Historical delivery digest; this layer does not derive a snapshot or attest its run. */
  readonly snapshotSha256: string;
  readonly manifest: { readonly observationId: string; readonly bytes: Uint8Array };
  readonly diff: { readonly observationId: string; readonly bytes: Uint8Array };
  readonly rows: readonly SourceSnapshotRowInput[];
}

export interface SourceSnapshotBlobV1 {
  readonly objectId: string;
  readonly rawLength: number;
  readonly rawSha256: string;
}

export interface SourceSnapshotRootV2 {
  readonly kind: "docsfab-review-delivery-snapshot";
  readonly schemaVersion: 2;
  readonly runId: string;
  readonly sourceSha256: string;
  readonly repositoryIdentitySha256: string;
  readonly reviewedHeadSha: string;
  readonly snapshotSha256: string;
  readonly manifest: {
    readonly observationId: string;
    readonly originalSha256: string;
    readonly byteLength: number;
  };
  readonly diff: {
    readonly observationId: string;
    readonly originalSha256: string;
    readonly byteLength: number;
  };
  readonly states: readonly ReviewDiffState[];
  readonly sectionCounts: readonly number[];
  readonly sideReasons: readonly (SourceSideReason | null)[];
  readonly sideStatedSha256: readonly (string | null)[];
  readonly sideBlobIndices: readonly (number | null)[];
  readonly blobs: readonly SourceSnapshotBlobV1[];
  readonly partDigests: readonly string[];
}

export interface SourceSnapshotPartV1 {
  readonly kind: "docsfab-review-delivery-snapshot-part";
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly sourceSha256: string;
  readonly ordinal: number;
  readonly rawLength: number;
  readonly rawSha256: string;
  readonly rawBase64: string;
}

export class SourceSnapshotStoreError extends Error {
  public constructor(public readonly code: string) {
    super(`Review source snapshot invalid (${code}).`);
    this.name = "SourceSnapshotStoreError";
  }
}

const kit = createContractKit<"root-shape-invalid">({
  fail: (code) => {
    throw new SourceSnapshotStoreError(code);
  },
  codes: {
    invalidShape: "root-shape-invalid",
    invalidValue: "root-shape-invalid",
    digestMismatch: "root-shape-invalid",
    credentialMaterial: "root-shape-invalid",
    schemaMismatch: "root-shape-invalid",
  },
  inertMode: "strict",
});
// The artifact store supplies canonical JSON and the effective object-byte bound.
// Decode objects/arrays with the kit without applying its identifier-string ceiling to raw base64.

function fail(code: string): never {
  throw new SourceSnapshotStoreError(code);
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha(value: unknown, code: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) fail(code);
  return value;
}

function objectId(value: unknown, code: string): string {
  if (typeof value !== "string" || !OBJECT_ID.test(value)) fail(code);
  return value;
}

function count(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail(code);
  return value as number;
}

function nonempty(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) fail(code);
  return value;
}

function observation(value: unknown): SourceSnapshotRootV2["manifest"] {
  const item = kit.object(value);
  kit.exact(item, ["observationId", "originalSha256", "byteLength"]);
  return {
    observationId: nonempty(item.observationId, "observation-id-invalid"),
    originalSha256: sha(item.originalSha256, "observation-sha-invalid"),
    byteLength: count(item.byteLength, "observation-length-invalid"),
  };
}

function decodeRoot(value: unknown): SourceSnapshotRootV2 {
  const root = kit.object(value);
  if (root.kind !== "docsfab-review-delivery-snapshot" || root.schemaVersion !== 2)
    fail("root-version-invalid");
  kit.exact(root, [
    "kind",
    "schemaVersion",
    "runId",
    "sourceSha256",
    "repositoryIdentitySha256",
    "reviewedHeadSha",
    "snapshotSha256",
    "manifest",
    "diff",
    "states",
    "sectionCounts",
    "sideReasons",
    "sideStatedSha256",
    "sideBlobIndices",
    "blobs",
    "partDigests",
  ]);
  const statesArray = kit.array(root.states);
  const sectionsArray = kit.array(root.sectionCounts);
  const reasonsArray = kit.array(root.sideReasons);
  const statedArray = kit.array(root.sideStatedSha256);
  const sideBlobIndices = kit.array(root.sideBlobIndices);
  const blobArray = kit.array(root.blobs);
  const partsArray = kit.array(root.partDigests);
  const states = statesArray.map((state) => {
    if (state !== "complete" && state !== "absent" && state !== "truncated")
      fail("row-state-invalid");
    return state as ReviewDiffState;
  });
  const sectionCounts = sectionsArray.map((section) =>
    count(section, "diff-section-count-invalid"),
  );
  if (
    sectionCounts.length !== states.length ||
    states.some((state, index) => state === "truncated" && sectionCounts[index] !== 0)
  )
    fail("diff-section-count-invalid");
  const sideCount = states.length * 2;
  if (
    !Number.isSafeInteger(sideCount) ||
    reasonsArray.length !== sideCount ||
    statedArray.length !== sideCount ||
    sideBlobIndices.length !== sideCount
  )
    fail("side-count-mismatch");
  const blobs = blobArray.map((entry) => {
    const item = kit.object(entry);
    kit.exact(item, ["objectId", "rawLength", "rawSha256"]);
    return {
      objectId: objectId(item.objectId, "blob-id-invalid"),
      rawLength: count(item.rawLength, "blob-length-invalid"),
      rawSha256: sha(item.rawSha256, "blob-sha-invalid"),
    };
  });
  const seenIds = new Set<string>();
  for (const blob of blobs) {
    if (seenIds.has(blob.objectId)) fail("blob-index-invalid");
    seenIds.add(blob.objectId);
  }
  let nextIndex = 0;
  const reasons = reasonsArray.map((reason, index) => {
    if (reason !== null && !REASONS.includes(reason as SourceSideReason))
      fail("side-reason-invalid");
    const blobIndex = sideBlobIndices[index];
    if (reason === null) {
      if (
        !Number.isSafeInteger(blobIndex) ||
        (blobIndex as number) < 0 ||
        (blobIndex as number) >= blobs.length
      )
        fail("blob-index-invalid");
      if (blobIndex === nextIndex) nextIndex++;
      else if ((blobIndex as number) >= nextIndex) fail("blob-index-invalid");
    } else if (blobIndex !== null) fail("blob-index-invalid");
    return reason as SourceSideReason | null;
  });
  if (nextIndex !== blobs.length) fail("blob-index-invalid");
  const stated = statedArray.map((value) =>
    value === null ? null : sha(value, "side-sha-invalid"),
  );
  const indices = sideBlobIndices as (number | null)[];
  const partDigests = partsArray.map((value) => sha(value, "part-digest-invalid"));
  if (new Set(partDigests).size !== partDigests.length) fail("part-digest-duplicate");
  const reviewedHeadSha = objectId(root.reviewedHeadSha, "head-invalid");
  return {
    kind: "docsfab-review-delivery-snapshot",
    schemaVersion: 2,
    runId: nonempty(root.runId, "run-id-invalid"),
    sourceSha256: sha(root.sourceSha256, "source-sha-invalid"),
    repositoryIdentitySha256: sha(root.repositoryIdentitySha256, "repository-sha-invalid"),
    reviewedHeadSha,
    snapshotSha256: sha(root.snapshotSha256, "snapshot-sha-invalid"),
    manifest: observation(root.manifest),
    diff: observation(root.diff),
    states,
    sectionCounts,
    sideReasons: reasons,
    sideStatedSha256: stated,
    sideBlobIndices: indices,
    blobs,
    partDigests,
  };
}

/** Closed root metadata for deletion inventory; raw parts are verified separately. */
export function decodeSourceSnapshotRoot(value: unknown): SourceSnapshotRootV2 {
  return decodeRoot(value);
}

/** Validate a staged part even when a failed write left no root to name it. */
export function decodeSourceSnapshotPart(value: unknown): {
  readonly part: SourceSnapshotPartV1;
  readonly raw: Uint8Array;
} {
  const item = kit.object(value);
  kit.exact(item, [
    "kind",
    "schemaVersion",
    "runId",
    "sourceSha256",
    "ordinal",
    "rawLength",
    "rawSha256",
    "rawBase64",
  ]);
  if (item.kind !== "docsfab-review-delivery-snapshot-part" || item.schemaVersion !== 1)
    fail("part-version-invalid");
  const part: SourceSnapshotPartV1 = {
    kind: "docsfab-review-delivery-snapshot-part",
    schemaVersion: 1,
    runId: nonempty(item.runId, "run-id-invalid"),
    sourceSha256: sha(item.sourceSha256, "source-sha-invalid"),
    ordinal: count(item.ordinal, "part-ordinal-invalid"),
    rawLength: count(item.rawLength, "part-length-invalid"),
    rawSha256: sha(item.rawSha256, "part-sha-invalid"),
    rawBase64:
      typeof item.rawBase64 === "string" ? item.rawBase64 : fail("part-base64-noncanonical"),
  };
  if (part.rawLength === 0) fail("part-length-invalid");
  const raw = Buffer.from(part.rawBase64, "base64");
  if (raw.toString("base64") !== part.rawBase64) fail("part-base64-noncanonical");
  if (raw.byteLength !== part.rawLength || digest(raw) !== part.rawSha256)
    fail("part-content-mismatch");
  return { part, raw };
}

function decodePart(value: unknown, root: SourceSnapshotRootV2, ordinal: number): Uint8Array {
  const { part, raw } = decodeSourceSnapshotPart(value);
  if (
    part.runId !== root.runId ||
    part.sourceSha256 !== root.sourceSha256 ||
    part.ordinal !== ordinal
  )
    fail("part-binding-mismatch");
  return raw;
}

/** Store only bytes and graph metadata. This function cannot attest acquisition or run success. */
export async function retainSourceSnapshotParts(
  artifacts: DurableArtifactStore,
  input: SourceSnapshotPartInput,
  options: { readonly limits?: ResolveLimitsOptions } = {},
): Promise<{ readonly rootObjectSha256: string }> {
  const uniqueBound = limit("reviewDelivery.snapshotUniqueOriginalBytesMax", options.limits);
  const partBound = limit("reviewDelivery.snapshotPartBytes", options.limits);
  const blobs: SourceSnapshotBlobV1[] = [];
  const blobBytes: Uint8Array[] = [];
  let uniqueOriginalBytes = 0;
  const byId = new Map<string, number>();
  const states: ReviewDiffState[] = [];
  const sectionCounts: number[] = [];
  const sideReasons: (SourceSideReason | null)[] = [];
  const sideStatedSha256: (string | null)[] = [];
  const sideBlobIndices: (number | null)[] = [];
  for (const row of input.rows) {
    states.push(row.state);
    sectionCounts.push(count(row.sections, "diff-section-count-invalid"));
    for (const side of [row.before, row.after]) {
      sideStatedSha256.push(side.statedSha256);
      if ("bytes" in side) {
        const id = objectId(side.objectId, "blob-id-invalid");
        const raw = side.bytes;
        if (!(raw instanceof Uint8Array)) fail("blob-bytes-invalid");
        const rawSha256 = digest(raw);
        let index = byId.get(id);
        if (index === undefined) {
          uniqueOriginalBytes += raw.byteLength;
          if (!Number.isSafeInteger(uniqueOriginalBytes) || uniqueOriginalBytes > uniqueBound.value)
            refuseLimit(uniqueBound, uniqueOriginalBytes);
          index = blobs.length;
          byId.set(id, index);
          blobs.push({ objectId: id, rawLength: raw.byteLength, rawSha256 });
          blobBytes.push(raw);
        } else if (
          blobs[index]!.rawSha256 !== rawSha256 ||
          blobs[index]!.rawLength !== raw.byteLength ||
          !Buffer.from(blobBytes[index]!).equals(raw)
        )
          fail("blob-id-conflict");
        sideReasons.push(null);
        sideBlobIndices.push(index);
      } else {
        sideReasons.push(side.reason);
        sideBlobIndices.push(null);
      }
    }
  }
  const base = {
    kind: "docsfab-review-delivery-snapshot" as const,
    schemaVersion: 2 as const,
    runId: input.runId,
    sourceSha256: input.sourceSha256,
    repositoryIdentitySha256: input.repositoryIdentitySha256,
    reviewedHeadSha: input.reviewedHeadSha,
    snapshotSha256: input.snapshotSha256,
    manifest: {
      observationId: input.manifest.observationId,
      originalSha256: digest(input.manifest.bytes),
      byteLength: input.manifest.bytes.byteLength,
    },
    diff: {
      observationId: input.diff.observationId,
      originalSha256: digest(input.diff.bytes),
      byteLength: input.diff.bytes.byteLength,
    },
    states,
    sectionCounts,
    sideReasons,
    sideStatedSha256,
    sideBlobIndices,
    blobs,
  };
  // The same decoder checks writes; a private record cannot acquire extra keys or loose values.
  decodeRoot({ ...base, partDigests: [] });
  const stream = Buffer.concat([input.manifest.bytes, input.diff.bytes, ...blobBytes]);
  const partDigests: string[] = [];
  for (let offset = 0; offset < stream.byteLength; ) {
    const ordinal = partDigests.length;
    const makePart = (length: number): SourceSnapshotPartV1 => {
      const raw = stream.subarray(offset, offset + length);
      return {
        kind: "docsfab-review-delivery-snapshot-part",
        schemaVersion: 1,
        runId: input.runId,
        sourceSha256: input.sourceSha256,
        ordinal,
        rawLength: raw.byteLength,
        rawSha256: digest(raw),
        rawBase64: raw.toString("base64"),
      };
    };
    let low = 0;
    let high = Math.min(stream.byteLength - offset, partBound.value);
    while (low < high) {
      const middle = low + Math.ceil((high - low) / 2);
      if (Buffer.byteLength(JSON.stringify(makePart(middle)), "utf8") <= artifacts.maxObjectBytes)
        low = middle;
      else high = middle - 1;
    }
    if (low === 0) fail("part-exceeds-artifact-object-limit");
    const part = makePart(low);
    const partDigest = opaqueRecordDigest(part);
    await artifacts.putRecord(partDigest, part);
    partDigests.push(partDigest);
    offset += low;
  }
  const root: SourceSnapshotRootV2 = { ...base, partDigests };
  const rootObjectSha256 = opaqueRecordDigest(root);
  await artifacts.putRecord(rootObjectSha256, root);
  return { rootObjectSha256 };
}

/** Recheck every content address and byte span after restart, without reading a checkout. */
export async function readSourceSnapshotParts(
  artifacts: DurableArtifactStore,
  rootObjectSha256: string,
): Promise<{
  readonly root: SourceSnapshotRootV2;
  readonly manifestBytes: Uint8Array;
  readonly diffBytes: Uint8Array;
  readonly blobBytes: readonly Uint8Array[];
}> {
  const storedRoot = await artifacts.getRecord(rootObjectSha256, { readOnly: true });
  if (opaqueRecordDigest(storedRoot) !== rootObjectSha256) fail("root-address-mismatch");
  const root = decodeRoot(storedRoot);
  const parts: Uint8Array[] = [];
  let total = 0;
  for (const [ordinal, partDigest] of root.partDigests.entries()) {
    const storedPart = await artifacts.getRecord(partDigest, { readOnly: true });
    if (opaqueRecordDigest(storedPart) !== partDigest) fail("part-address-mismatch");
    const raw = decodePart(storedPart, root, ordinal);
    total += raw.byteLength;
    if (!Number.isSafeInteger(total)) fail("part-stream-length-mismatch");
    parts.push(raw);
  }
  const expected =
    root.manifest.byteLength +
    root.diff.byteLength +
    root.blobs.reduce((sum, blob) => sum + blob.rawLength, 0);
  if (!Number.isSafeInteger(expected) || total !== expected) fail("part-stream-length-mismatch");
  const stream = Buffer.concat(parts, total);
  let offset = 0;
  const take = (length: number): Uint8Array => {
    const raw = Uint8Array.from(stream.subarray(offset, offset + length));
    offset += length;
    return raw;
  };
  const manifestBytes = take(root.manifest.byteLength);
  const diffBytes = take(root.diff.byteLength);
  if (
    digest(manifestBytes) !== root.manifest.originalSha256 ||
    digest(diffBytes) !== root.diff.originalSha256
  )
    fail("observation-content-mismatch");
  const blobBytes = root.blobs.map((blob) => {
    const raw = take(blob.rawLength);
    if (digest(raw) !== blob.rawSha256) fail("blob-content-mismatch");
    return raw;
  });
  if (offset !== stream.byteLength) fail("part-stream-length-mismatch");
  return { root, manifestBytes, diffBytes, blobBytes };
}

/**
 * Load only from a saved successful review run. The run's single source citation,
 * typed pointer, closed object graph, original observation bytes and unchanged
 * delivery digest must all agree before a caller receives a snapshot.
 */
export async function loadRetainedReviewSource(input: {
  readonly runStore: FileRunStore;
  readonly artifacts: DurableArtifactStore;
  readonly runId: string;
  readonly expectedRunSha256?: string;
  readonly readOnly?: true;
}): Promise<{
  readonly source: ChangeSourceV1;
  readonly snapshot: ReviewDeliverySnapshot;
  readonly root: SourceSnapshotRootV2;
}> {
  const saved = await input.runStore.getWithDigest(input.runId, { readOnly: true });
  if (input.expectedRunSha256 !== undefined && saved.sha256 !== input.expectedRunSha256)
    fail("saved-run-record-mismatch");
  const run = decodeSuccessfulReviewRunRecord(saved.record);
  if (run.id !== input.runId || run.reviewDeliverySnapshot === undefined)
    fail("saved-run-reference-missing");
  const validated = await validateRetainedReviewSourceForRun({
    run,
    artifacts: input.artifacts,
  });
  return { source: validated.source, snapshot: validated.snapshot, root: validated.root };
}

/** Validate the full retained source graph against the run before terminal success or cold use. */
export async function validateRetainedReviewSourceForRun(input: {
  readonly run: RunRecord;
  readonly artifacts: DurableArtifactStore;
}) {
  const { run } = input;
  if (run.reviewDeliverySnapshot === undefined) fail("saved-run-reference-missing");
  const reference = decodeReviewDeliverySnapshotReference(run.reviewDeliverySnapshot, {
    runId: run.id,
    workflow: run.workflow,
    status: run.status,
    changeSources: run.changeSources,
  });
  const retained = await readSourceSnapshotParts(input.artifacts, reference.rootObjectSha256);
  const root = retained.root;
  if (
    root.runId !== run.id ||
    root.sourceSha256 !== reference.changeSourceSha256 ||
    root.repositoryIdentitySha256 !== reference.repositoryIdentitySha256 ||
    root.reviewedHeadSha !== reference.reviewedHeadSha ||
    root.snapshotSha256 !== reference.snapshotSha256
  )
    fail("saved-run-root-binding-mismatch");
  const citation = run.changeSources?.find(
    (source) => source.changeSourceSha256 === reference.changeSourceSha256,
  );
  if (!citation) fail("saved-run-source-citation-missing");
  if (
    root.manifest.observationId !==
      citation.observations.find((entry) => entry.role === "manifest")?.observationId ||
    root.diff.observationId !==
      citation.observations.find((entry) => entry.role === "diff")?.observationId
  )
    fail("saved-run-observation-mismatch");
  let manifestValue: unknown;
  try {
    manifestValue = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(retained.manifestBytes),
    );
  } catch {
    return fail("manifest-invalid");
  }
  const source = decodeChangeSourceV1(manifestValue);
  if (
    source.changeSourceSha256 !== reference.changeSourceSha256 ||
    source.revision.repository.identitySha256 !== reference.repositoryIdentitySha256 ||
    source.revision.head !== reference.reviewedHeadSha ||
    source.files.length !== root.states.length ||
    source.files.length !== citation.fileCount
  )
    fail("manifest-source-mismatch");
  const noFileWitness = changeSourceAcquiredOriginalBytes(new Uint8Array(0));
  const exactNoFileWitness = Buffer.from(retained.diffBytes).equals(noFileWitness);
  const noDiffRows =
    source.files.every((file) => file.diffOmitted !== undefined) &&
    root.sectionCounts.every((sections) => sections === 0);
  if (noDiffRows && !exactNoFileWitness) fail("observation-content-mismatch");
  const parsed = projectReviewDiffHunks(
    noDiffRows ? new Uint8Array(0) : retained.diffBytes,
    root.states.map((state, index) => ({ state, sections: root.sectionCounts[index]! })),
  );
  const files = source.files.map((file, index) => {
    const state = root.states[index]!;
    const hunks = parsed[index];
    const side = (which: "before" | "after") => {
      const sideIndex = index * 2 + (which === "after" ? 1 : 0);
      const blobIndex = root.sideBlobIndices[sideIndex];
      const reason = root.sideReasons[sideIndex];
      const expectedId = which === "before" ? file.oldBlob : file.newBlob;
      const mode = which === "before" ? file.oldMode : file.newMode;
      const path = which === "before" ? file.oldPath : file.newPath;
      const presence = admittedReviewSourceSidePresence(source, file, which);
      if (presence === null) fail("side-source-mismatch");
      if (presence === "absent") {
        if (
          blobIndex !== null ||
          reason !== "not-in-source" ||
          root.sideStatedSha256[sideIndex] !== null
        )
          fail("side-source-mismatch");
        return { bytes: null, sha256: null };
      }
      if (blobIndex !== null && blobIndex !== undefined) {
        const blob = root.blobs[blobIndex];
        if (
          blob === undefined ||
          expectedId === null ||
          blob.objectId !== expectedId ||
          reason !== null ||
          (mode !== "100644" && mode !== "100755" && mode !== "120000")
        )
          fail("side-source-mismatch");
        return { bytes: retained.blobBytes[blobIndex]!, sha256: root.sideStatedSha256[sideIndex]! };
      }
      // Match the writer's precedence: a missing reported blob is omitted
      // even when its forge-reported mode is also unsupported.
      const expectedReason =
        expectedId === null
          ? "source-omitted"
          : mode === "160000"
            ? "unsupported-gitlink"
            : mode !== "100644" && mode !== "100755" && mode !== "120000"
              ? "unsupported-mode"
              : null;
      if (expectedReason === null || reason !== expectedReason) fail("side-source-mismatch");
      return { bytes: null, sha256: root.sideStatedSha256[sideIndex]! };
    };
    const before = side("before");
    const after = side("after");
    return {
      oldPath: file.oldPath,
      newPath: file.newPath,
      beforeBytes: before.bytes,
      afterBytes: after.bytes,
      beforeSha256: before.sha256,
      afterSha256: after.sha256,
      state,
      hunks: hunks ?? [],
    };
  });
  const snapshot: ReviewDeliverySnapshot = { changeSourceSha256: source.changeSourceSha256, files };
  try {
    if (reviewDeliverySnapshotDigest(snapshot, source) !== reference.snapshotSha256)
      fail("snapshot-digest-mismatch");
  } catch (error) {
    if (error instanceof SourceSnapshotStoreError) throw error;
    fail("snapshot-digest-mismatch");
  }
  return { source, snapshot, root, reference };
}

/** A malformed hunk affects only its row; the caller must use summary fallback for null. */
function parseSectionHunks(section: readonly string[]): ReviewDiffHunk[] | null {
  const hunks: ReviewDiffHunk[] = [];
  let before = 0;
  let after = 0;
  let expectedBefore = 0;
  let expectedAfter = 0;
  let current:
    | {
        lines: {
          kind: "context" | "added" | "removed";
          text: string;
          beforeLine: number | null;
          afterLine: number | null;
        }[];
      }
    | undefined;
  for (const line of section.slice(1)) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(line);
    if (header) {
      if (current && (expectedBefore !== 0 || expectedAfter !== 0)) return null;
      before = Number(header[1]);
      after = Number(header[3]);
      expectedBefore = Number(header[2] ?? 1);
      expectedAfter = Number(header[4] ?? 1);
      if (
        ![before, after, expectedBefore, expectedAfter].every(
          (value) => Number.isSafeInteger(value) && value >= 0,
        )
      )
        return null;
      current = { lines: [] };
      hunks.push(current);
      continue;
    }
    if (line.startsWith("@@")) return null;
    if (!current) continue; // git section metadata, mode lines and binary markers
    if (line === "\\ No newline at end of file") continue;
    // GitHub's section builder adds one LF after a patch that may already end in LF.
    if (line === "" && expectedBefore === 0 && expectedAfter === 0) continue;
    const marker = line[0];
    if (marker !== " " && marker !== "+" && marker !== "-") return null;
    const kind = marker === " " ? "context" : marker === "+" ? "added" : "removed";
    const beforeLine = kind === "added" ? null : before++;
    const afterLine = kind === "removed" ? null : after++;
    if (beforeLine !== null) expectedBefore--;
    if (afterLine !== null) expectedAfter--;
    if (expectedBefore < 0 || expectedAfter < 0) return null;
    current.lines.push({ kind, text: line.slice(1), beforeLine, afterLine });
  }
  if (current && (expectedBefore !== 0 || expectedAfter !== 0)) return null;
  return hunks;
}

/** Parse the admitted unified diff in source row order; raw diff bytes remain stored separately. */
export function projectReviewDiffHunks(
  diffBytes: Uint8Array,
  rows: readonly { readonly state: ReviewDiffState; readonly sections: number }[],
): readonly (readonly ReviewDiffHunk[] | null)[] {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(diffBytes);
  } catch {
    return fail("diff-invalid-utf8");
  }
  const lines = text.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  if (lines.at(-1) === "") lines.pop();
  const sections: string[][] = [];
  for (const line of lines) {
    if (line.startsWith("diff --git ")) sections.push([line]);
    else if (sections.length === 0) fail("diff-section-invalid");
    else sections.at(-1)!.push(line);
  }
  let nextSection = 0;
  const projected = rows.map((row) => {
    const sectionCount = count(row.sections, "diff-section-count-invalid");
    if (row.state !== "complete" && row.state !== "absent" && row.state !== "truncated")
      fail("row-state-invalid");
    if (row.state === "truncated" && sectionCount !== 0) fail("diff-section-count-invalid");
    const hunks: ReviewDiffHunk[] = [];
    let invalid = false;
    for (let sectionIndex = 0; sectionIndex < sectionCount; sectionIndex++) {
      const section = sections[nextSection++];
      if (!section) fail("diff-section-count-mismatch");
      const parsed = parseSectionHunks(section);
      if (parsed === null) invalid = true;
      else hunks.push(...parsed);
    }
    return invalid ? null : hunks;
  });
  if (nextSection !== sections.length) fail("diff-section-count-mismatch");
  return projected;
}
