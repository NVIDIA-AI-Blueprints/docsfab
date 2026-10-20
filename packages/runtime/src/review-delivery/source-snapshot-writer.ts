// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Pre-model source retention contract. Provider readers supply pinned original Git objects. */
import { createHash } from "node:crypto";

import type { DurableArtifactStore } from "../artifacts/store.js";
import { limit, refuseLimit, type ResolveLimitsOptions } from "../config/limits.js";
import { sha256 } from "../content-ir/canonical.js";
import {
  CHANGE_SOURCE_DIFF_MEDIA_TYPE,
  CHANGE_SOURCE_MANIFEST_MEDIA_TYPE,
  changeSourceAcquiredOriginalBytes,
  changeSourceRepositoryPath,
  type AcquiredChangeSourceOriginalEntryV1,
  type AcquiredChangeSourceV1,
} from "../inputs/change-source/acquisition.js";
import { decodeChangeSourceV1, type ResolvedChangeSourceV1 } from "../inputs/change-source.js";
import { objectId } from "../inputs/change-source/objects.js";
import { decodeSourceObservation, type SourceDiffLocatorV1 } from "../inputs/source-evidence.js";
import { decodeSourceBinding, type SourceBindingV1 } from "../inputs/source-evidence.js";
import type { ReviewDeliverySnapshotReferenceV1 } from "../records/review-delivery-snapshot-reference.js";
import type { ReviewDiffState } from "./anchors.js";
import type { ReviewDeliverySnapshot } from "./contracts.js";
import { reviewDeliverySnapshotDigest } from "./snapshot-digest.js";
import {
  projectReviewDiffHunks,
  retainSourceSnapshotParts,
  type SourceSideReason,
  type SourceSnapshotRowInput,
} from "./source-snapshot-store.js";

export type SidePreflight =
  | {
      readonly kind: "verified";
      readonly objectId: string;
      readonly objectType: "blob";
      readonly byteLength: number;
    }
  | {
      readonly kind: "unavailable";
      readonly reason: "unsupported-gitlink" | "unsupported-mode";
    };

export interface ReviewOriginalSideReader {
  inspect(input: {
    readonly ordinal: number;
    readonly side: "before" | "after";
    readonly path: string;
    readonly blobId: string | null;
    readonly mode: string | null;
  }): Promise<SidePreflight>;
  read(input: {
    readonly ordinal: number;
    readonly side: "before" | "after";
    readonly expected: Extract<SidePreflight, { readonly kind: "verified" }>;
  }): Promise<Uint8Array>;
}

export interface RetainReviewDeliverySourceSnapshotInput {
  readonly artifacts: DurableArtifactStore;
  readonly runId: string;
  readonly resolved: ResolvedChangeSourceV1;
  readonly acquired: AcquiredChangeSourceV1;
  /** The same sealed source binding named by the runner's source reference. */
  readonly runSourceBinding: SourceBindingV1;
  readonly readOriginal: ReviewOriginalSideReader;
  readonly limits?: ResolveLimitsOptions;
}

export class SourceSnapshotWriterError extends Error {
  public constructor(public readonly code: string) {
    super(
      `Review source snapshot refused (${code}); check the pinned source objects and observations, then rerun or narrow the change.`,
    );
    this.name = "SourceSnapshotWriterError";
  }
}

function fail(code: string): never {
  throw new SourceSnapshotWriterError(code);
}

type VerifiedPreflight = Extract<SidePreflight, { readonly kind: "verified" }>;
type Side = "before" | "after";
type PendingSide =
  | { readonly kind: "verified"; readonly objectId: string }
  | { readonly kind: "unavailable"; readonly reason: SourceSideReason };

function original(
  entry: AcquiredChangeSourceOriginalEntryV1<"manifest" | "diff">,
  bytes: Uint8Array,
  runIdSha256: string,
  source: ResolvedChangeSourceV1["changeSource"],
) {
  let observation: ReturnType<typeof decodeSourceObservation>;
  try {
    observation = decodeSourceObservation(entry.observation);
  } catch {
    return fail("observation-invalid");
  }
  const rawSha256 = sha256(bytes);
  const expectedMediaType =
    entry.role === "manifest" ? CHANGE_SOURCE_MANIFEST_MEDIA_TYPE : CHANGE_SOURCE_DIFF_MEDIA_TYPE;
  const representation = observation.representations.find(
    (candidate) => candidate.representationSha256 === entry.representation.representationSha256,
  );
  if (
    observation.observationId !== entry.observation.observationId ||
    observation.runIdSha256 !== runIdSha256 ||
    observation.original.sha256 !== rawSha256 ||
    observation.original.byteLength !== bytes.byteLength ||
    observation.original.mediaType !== expectedMediaType ||
    observation.original.repositoryPath !==
      changeSourceRepositoryPath(source.revision.head, entry.role) ||
    representation === undefined ||
    representation.originalSha256 !== rawSha256 ||
    entry.representation.originalSha256 !== rawSha256
  )
    fail("observation-source-mismatch");
  return { observation, representation };
}

/** Use the already admitted diff adapter's file locators; never reparse Git headers here. */
function sectionCounts(
  source: ResolvedChangeSourceV1["changeSource"],
  spans: ReturnType<typeof decodeSourceObservation>["representations"][number]["spans"],
): number[] {
  const sections = new Map<
    number,
    { readonly oldPath: string | null; readonly newPath: string | null }
  >();
  for (const span of spans) {
    const locator = span.locator;
    if (locator.kind !== "diff" || (locator.part !== "file" && locator.part !== "header")) continue;
    const ordinal = locator.fileOrdinal;
    if (ordinal === null || !Number.isSafeInteger(ordinal) || ordinal < 1)
      fail("diff-section-inventory-invalid");
    const previous = sections.get(ordinal);
    if (
      previous !== undefined &&
      (previous.oldPath !== locator.oldPath || previous.newPath !== locator.newPath)
    )
      fail("diff-section-inventory-invalid");
    sections.set(ordinal, { oldPath: locator.oldPath, newPath: locator.newPath });
  }
  const ordered = [...sections].sort(([left], [right]) => left - right);
  if (ordered.some(([ordinal], index) => ordinal !== index + 1))
    fail("diff-section-inventory-invalid");
  let next = 0;
  const counts = source.files.map((file) => {
    if (file.diffOmitted !== undefined) return 0;
    let count = 0;
    // Git emits a type change as a deletion section followed by an addition
    // section, while the sealed source keeps one row with both paths/modes.
    if (
      file.oldPath !== null &&
      file.newPath !== null &&
      file.oldMode !== file.newMode &&
      ordered[next]?.[1].oldPath === file.oldPath &&
      ordered[next]?.[1].newPath === null &&
      ordered[next + 1]?.[1].oldPath === null &&
      ordered[next + 1]?.[1].newPath === file.newPath
    ) {
      next += 2;
      return 2;
    }
    while (
      ordered[next]?.[1].oldPath === file.oldPath &&
      ordered[next]?.[1].newPath === file.newPath
    ) {
      count++;
      next++;
    }
    if (count === 0) fail("diff-section-source-mismatch");
    return count;
  });
  if (next !== ordered.length) fail("diff-section-source-mismatch");
  return counts;
}

function unavailable(reason: SourceSideReason): PendingSide {
  return { kind: "unavailable", reason };
}

export async function retainReviewDeliverySourceSnapshot(
  input: RetainReviewDeliverySourceSnapshotInput,
): Promise<ReviewDeliverySnapshotReferenceV1> {
  const { artifacts, runId, resolved, acquired, readOriginal } = input;
  if (typeof runId !== "string" || runId.length === 0) fail("run-id-invalid");
  // These caller-owned typed arrays can change while provider callbacks await.
  const resolvedDiffBytes = Uint8Array.from(resolved.diffBytes);
  const manifestBytes = Uint8Array.from(resolved.manifestBytes);
  const acquiredDiffBytes = changeSourceAcquiredOriginalBytes(resolvedDiffBytes);
  let source: ResolvedChangeSourceV1["changeSource"];
  let acquiredSource: ResolvedChangeSourceV1["changeSource"];
  try {
    source = decodeChangeSourceV1(resolved.changeSource);
    acquiredSource = decodeChangeSourceV1(acquired.changeSource);
    const manifest = decodeChangeSourceV1(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes)),
    );
    if (manifest.changeSourceSha256 !== source.changeSourceSha256) fail("source-pair-mismatch");
  } catch (error) {
    if (error instanceof SourceSnapshotWriterError) throw error;
    fail("source-invalid");
  }
  if (source.changeSourceSha256 !== acquiredSource.changeSourceSha256) fail("source-pair-mismatch");
  if (
    acquired.acquired.length !== 2 ||
    acquired.acquired[0]?.role !== "diff" ||
    acquired.acquired[1]?.role !== "manifest"
  )
    fail("observation-pair-invalid");
  const runIdSha256 = createHash("sha256").update(runId, "utf8").digest("hex");
  const diff = original(acquired.acquired[0], acquiredDiffBytes, runIdSha256, source);
  const manifest = original(acquired.acquired[1], manifestBytes, runIdSha256, source);
  const binding = decodeSourceBinding(input.runSourceBinding);
  const required = new Set(binding.requiredObservationIds);
  const named = new Map(
    binding.observations.map((entry) => [entry.observationId, entry.observationSha256]),
  );
  if (
    binding.runIdSha256 !== runIdSha256 ||
    binding.repository.revision !== source.revision.head ||
    diff.observation.repository.identitySha256 !== binding.repository.identitySha256 ||
    diff.observation.repository.revision !== binding.repository.revision ||
    manifest.observation.repository.identitySha256 !== binding.repository.identitySha256 ||
    manifest.observation.repository.revision !== binding.repository.revision ||
    diff.observation.repository.identitySha256 !== manifest.observation.repository.identitySha256 ||
    diff.observation.repository.revision !== manifest.observation.repository.revision ||
    diff.observation.requestSha256 !== binding.requestSha256 ||
    manifest.observation.requestSha256 !== binding.requestSha256 ||
    !required.has(diff.observation.observationId) ||
    !required.has(manifest.observation.observationId) ||
    named.get(diff.observation.observationId) !== diff.observation.observationSha256 ||
    named.get(manifest.observation.observationId) !== manifest.observation.observationSha256
  )
    fail("observation-pair-mismatch");
  const counts = sectionCounts(source, diff.representation.spans);
  const unique = new Map<
    string,
    { readonly expected: VerifiedPreflight; readonly ordinal: number; readonly side: Side }
  >();
  const pending: Array<{ readonly before: PendingSide; readonly after: PendingSide }> = [];
  let uniqueBytes = 0;
  const bound = limit("reviewDelivery.snapshotUniqueOriginalBytesMax", input.limits);
  for (const [index, file] of source.files.entries()) {
    const side = async (which: Side): Promise<PendingSide> => {
      const path = which === "before" ? file.oldPath : file.newPath;
      const blobId = which === "before" ? file.oldBlob : file.newBlob;
      const mode = which === "before" ? file.oldMode : file.newMode;
      // Git's raw added/deleted entry may still carry a zero mode/object
      // sentinel on the side whose path is absent; path is the admitted fact.
      if (path === null) return unavailable("not-in-source");
      if (blobId === null) return unavailable("source-omitted");
      if (mode === "160000") return unavailable("unsupported-gitlink");
      if (mode !== "100644" && mode !== "100755" && mode !== "120000")
        return unavailable("unsupported-mode");
      const prior = unique.get(blobId);
      if (prior !== undefined) return { kind: "verified", objectId: blobId };
      let inspected: SidePreflight;
      try {
        inspected = await readOriginal.inspect({
          ordinal: index,
          side: which,
          path,
          blobId,
          mode,
        });
      } catch {
        return fail("blob-inspect-failed");
      }
      if (
        inspected.kind !== "verified" ||
        inspected.objectType !== "blob" ||
        inspected.objectId !== blobId ||
        !Number.isSafeInteger(inspected.byteLength) ||
        inspected.byteLength < 0
      )
        fail("blob-inventory-mismatch");
      uniqueBytes += inspected.byteLength;
      if (!Number.isSafeInteger(uniqueBytes) || uniqueBytes > bound.value)
        refuseLimit(bound, uniqueBytes);
      unique.set(blobId, {
        expected: {
          kind: "verified",
          objectId: inspected.objectId,
          objectType: "blob",
          byteLength: inspected.byteLength,
        },
        ordinal: index,
        side: which,
      });
      return { kind: "verified", objectId: blobId };
    };
    pending.push({ before: await side("before"), after: await side("after") });
  }
  const bytesById = new Map<string, Uint8Array>();
  for (const [id, item] of unique) {
    let raw: Uint8Array;
    try {
      raw = await readOriginal.read({
        ordinal: item.ordinal,
        side: item.side,
        expected: { ...item.expected },
      });
    } catch {
      return fail("blob-read-failed");
    }
    if (!(raw instanceof Uint8Array) || raw.byteLength !== item.expected.byteLength)
      fail("blob-length-mismatch");
    const owned = Uint8Array.from(raw);
    if (objectId(source.objectFormat, "blob", Buffer.from(owned)) !== id)
      fail("blob-object-id-mismatch");
    bytesById.set(id, owned);
  }
  const rows: SourceSnapshotRowInput[] = source.files.map((file, index) => {
    const pendingRow = pending[index]!;
    const storedSide = (pendingSide: PendingSide) => {
      if (pendingSide.kind === "unavailable")
        return { reason: pendingSide.reason, statedSha256: null } as const;
      const bytes = bytesById.get(pendingSide.objectId);
      if (bytes === undefined) return fail("blob-read-missing");
      // The admitted source and reader provide no separate provider SHA-256 claim.
      // This is a host-derived side digest after independent Git object verification;
      // the store still retains it apart from the actual-byte digest.
      return { objectId: pendingSide.objectId, bytes, statedSha256: sha256(bytes) } as const;
    };
    const state: ReviewDiffState =
      file.diffOmitted !== undefined
        ? "truncated"
        : file.binary ||
            (pendingRow.before.kind === "unavailable" &&
              pendingRow.before.reason !== "not-in-source") ||
            (pendingRow.after.kind === "unavailable" && pendingRow.after.reason !== "not-in-source")
          ? "absent"
          : "complete";
    return {
      state,
      sections: counts[index]!,
      before: storedSide(pendingRow.before),
      after: storedSide(pendingRow.after),
    };
  });
  const parsed = projectReviewDiffHunks(
    resolvedDiffBytes,
    rows.map((row) => ({ state: row.state, sections: row.sections })),
  );
  const snapshot: ReviewDeliverySnapshot = {
    changeSourceSha256: source.changeSourceSha256,
    files: source.files.map((file, index) => {
      const row = rows[index]!;
      const before = row.before;
      const after = row.after;
      return {
        oldPath: file.oldPath,
        newPath: file.newPath,
        beforeBytes: "bytes" in before ? before.bytes : null,
        afterBytes: "bytes" in after ? after.bytes : null,
        beforeSha256: before.statedSha256,
        afterSha256: after.statedSha256,
        state: row.state,
        hunks: parsed[index] ?? [],
      };
    }),
  };
  let snapshotSha256: string;
  try {
    snapshotSha256 = reviewDeliverySnapshotDigest(snapshot, source);
  } catch {
    return fail("snapshot-digest-invalid");
  }
  const retained = await retainSourceSnapshotParts(
    artifacts,
    {
      runId,
      sourceSha256: source.changeSourceSha256,
      repositoryIdentitySha256: source.revision.repository.identitySha256,
      reviewedHeadSha: source.revision.head,
      snapshotSha256,
      manifest: {
        observationId: manifest.observation.observationId,
        bytes: manifestBytes,
      },
      diff: { observationId: diff.observation.observationId, bytes: acquiredDiffBytes },
      rows,
    },
    input.limits ? { limits: input.limits } : {},
  );
  return {
    kind: "docsfab-review-delivery-snapshot-reference",
    schemaVersion: 1,
    runId,
    rootObjectSha256: retained.rootObjectSha256,
    snapshotSha256,
    changeSourceSha256: source.changeSourceSha256,
    reviewedHeadSha: source.revision.head,
    repositoryIdentitySha256: source.revision.repository.identitySha256,
  };
}
