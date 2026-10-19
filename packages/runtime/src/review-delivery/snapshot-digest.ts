// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Shared source-side admission and snapshot identity, with no planner or locator dependency. */
import { createHash } from "node:crypto";
import { canonicalJson, sha256 } from "../content-ir/canonical.js";
import { changeSourceProvenance, type ChangeSourceV1 } from "../inputs/change-source.js";
import { ReviewDeliveryError, type ReviewDeliverySnapshot } from "./contracts.js";

function rejectDelivery(code: ReviewDeliveryError["code"]): never {
  throw new ReviewDeliveryError(code);
}

function sourceBlobId(bytes: Uint8Array, format: "sha1" | "sha256"): string {
  const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
  return createHash(format).update(header).update(bytes).digest("hex");
}

/** A missing path admits only the proven raw-Git or nullable forge metadata shapes. */
export function admittedReviewSourceSidePresence(
  source: ChangeSourceV1,
  file: ChangeSourceV1["files"][number],
  side: "before" | "after",
): "present" | "absent" | null {
  const oldMissing = file.oldPath === null;
  const newMissing = file.newPath === null;
  if (
    (file.status === "A") !== oldMissing ||
    (file.status === "D") !== newMissing ||
    (oldMissing && newMissing)
  )
    return null;
  if (!(side === "before" ? oldMissing : newMissing)) return "present";
  const mode = side === "before" ? file.oldMode : file.newMode;
  const blob = side === "before" ? file.oldBlob : file.newBlob;
  if (changeSourceProvenance(source.source) === "local-verified") {
    return mode === "000000" && blob === "0".repeat(source.revision.head.length) ? "absent" : null;
  }
  return blob === null && (mode === null || mode === "000000") ? "absent" : null;
}

export function copySnapshot(snapshot: ReviewDeliverySnapshot): ReviewDeliverySnapshot {
  const copiedBytes = new Map<Uint8Array, Uint8Array>();
  const copyBytes = (bytes: Uint8Array | null): Uint8Array | null => {
    if (bytes === null) return null;
    let copy = copiedBytes.get(bytes);
    if (copy === undefined) {
      copy = Uint8Array.from(bytes);
      copiedBytes.set(bytes, copy);
    }
    return copy;
  };
  return {
    changeSourceSha256: snapshot.changeSourceSha256,
    files: snapshot.files.map((file) => ({
      oldPath: file.oldPath,
      newPath: file.newPath,
      beforeBytes: copyBytes(file.beforeBytes),
      afterBytes: copyBytes(file.afterBytes),
      beforeSha256: file.beforeSha256,
      afterSha256: file.afterSha256,
      state: file.state,
      hunks: file.hunks.map((hunk) => ({ lines: hunk.lines.map((line) => ({ ...line })) })),
    })),
  };
}

export function snapshotDigest(snapshot: ReviewDeliverySnapshot, source: ChangeSourceV1): string {
  if (
    snapshot.changeSourceSha256 !== source.changeSourceSha256 ||
    snapshot.files.length !== source.files.length
  )
    rejectDelivery("snapshot-mismatch");
  const entries = snapshot.files.map((file, index) => {
    const manifest = source.files[index]!;
    if (
      file.oldPath !== manifest.oldPath ||
      file.newPath !== manifest.newPath ||
      (manifest.diffOmitted !== undefined && file.state === "complete") ||
      (manifest.binary && file.state === "complete")
    )
      rejectDelivery("snapshot-mismatch");
    for (const side of ["before", "after"] as const) {
      const bytes = side === "before" ? file.beforeBytes : file.afterBytes;
      const statedSha256 = side === "before" ? file.beforeSha256 : file.afterSha256;
      const blob = side === "before" ? manifest.oldBlob : manifest.newBlob;
      const mode = side === "before" ? manifest.oldMode : manifest.newMode;
      const presence = admittedReviewSourceSidePresence(source, manifest, side);
      if (presence === null) rejectDelivery("snapshot-mismatch");
      if (presence === "absent") {
        if (bytes !== null || statedSha256 !== null) rejectDelivery("snapshot-mismatch");
        continue;
      }
      if (mode === "160000") {
        // A gitlink's object id names a commit, not bytes for Git's blob hash.
        if (bytes !== null || (file.state !== "absent" && file.state !== "truncated"))
          rejectDelivery("snapshot-mismatch");
        continue;
      }
      if (
        blob !== null &&
        mode !== null &&
        mode !== "100644" &&
        mode !== "100755" &&
        mode !== "120000"
      ) {
        // The source names an object, but an unsupported mode admits no blob read.
        if (bytes !== null || (file.state !== "absent" && file.state !== "truncated"))
          rejectDelivery("snapshot-mismatch");
        continue;
      }
      if (blob !== null && (bytes === null || sourceBlobId(bytes, source.objectFormat) !== blob))
        rejectDelivery("snapshot-mismatch");
    }
    return {
      oldPath: file.oldPath,
      newPath: file.newPath,
      beforeSha256: file.beforeSha256,
      afterSha256: file.afterSha256,
      actualBeforeSha256: file.beforeBytes === null ? null : sha256(file.beforeBytes),
      actualAfterSha256: file.afterBytes === null ? null : sha256(file.afterBytes),
      state: file.state,
      hunks: file.hunks,
    };
  });
  return sha256(canonicalJson({ changeSourceSha256: snapshot.changeSourceSha256, files: entries }));
}

/** The same immutable snapshot identity the planner places on every action. */
export function reviewDeliverySnapshotDigest(
  snapshot: ReviewDeliverySnapshot,
  source: ChangeSourceV1,
): string {
  return snapshotDigest(copySnapshot(snapshot), source);
}
