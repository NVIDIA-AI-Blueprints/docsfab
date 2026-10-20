// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

const limits = JSON.parse(
  await (await import("node:fs/promises")).readFile(
    new URL("../../../../config/limits.catalog.json", import.meta.url),
    "utf8",
  ),
).limits;

function governedLimit(name, unit) {
  const limit = limits[name];
  if (
    !Number.isSafeInteger(limit?.value) ||
    limit.value <= 0 ||
    limit.unit !== unit ||
    limit.override !== null
  ) {
    throw new Error(`invalid governed packaging diagnostic limit ${name}`);
  }
  return limit.value;
}

const archiveBytesLimit = governedLimit("publishPackage.diagnosticArchiveBytes", "bytes");
const expandedBytesLimit = governedLimit("publishPackage.diagnosticExpandedBytes", "bytes");
const membersLimit = governedLimit("publishPackage.diagnosticMembers", "members");

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function tarString(header, start, length) {
  const end = header.indexOf(0, start);
  return header
    .subarray(start, end < 0 || end >= start + length ? start + length : end)
    .toString("utf8");
}

function tarNumber(header, start, length) {
  const value = tarString(header, start, length).trim().replace(/^0+/u, "") || "0";
  if (!/^[0-7]+$/u.test(value)) throw new Error("invalid tar member size");
  const number = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(number)) throw new Error("tar member size exceeds safe integer range");
  return number;
}

function inspectArchive(archive) {
  if (!Buffer.isBuffer(archive) || archive.byteLength > archiveBytesLimit) {
    throw new Error("archive exceeds governed reproducibility diagnostic input bound");
  }
  const tar = gunzipSync(archive, { maxOutputLength: expandedBytesLimit });
  const members = [];
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = tarString(header, 0, 100);
    const prefix = tarString(header, 345, 155);
    const path = prefix ? `${prefix}/${name}` : name;
    const size = tarNumber(header, 124, 12);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length || members.length >= membersLimit) {
      throw new Error("tar archive exceeds governed member or expanded-byte diagnostic bound");
    }
    const type = String.fromCharCode(header[156] || 48);
    const body = tar.subarray(dataStart, dataEnd);
    members.push({
      path,
      type,
      size,
      sha256: sha256(body),
      header: {
        sha256: sha256(header),
        mode: tarString(header, 100, 8),
        uid: tarString(header, 108, 8),
        gid: tarString(header, 116, 8),
        mtime: tarString(header, 136, 12),
        checksum: tarString(header, 148, 8),
        magic: tarString(header, 257, 6),
        version: tarString(header, 263, 2),
        owner: tarString(header, 265, 32),
        group: tarString(header, 297, 32),
      },
    });
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return {
    compressed: {
      size: archive.byteLength,
      sha256: sha256(archive),
      gzipHeader: archive.subarray(0, 10).toString("hex"),
    },
    expanded: { size: tar.byteLength, sha256: sha256(tar) },
    members,
  };
}

/** Hash-only explanation of a failed deterministic pack gate. Raw archive bytes are never emitted. */
export function comparePackedArchives(candidate, repeated) {
  const left = inspectArchive(candidate);
  const right = inspectArchive(repeated);
  const byPath = (items) => new Map(items.map((item) => [item.path, item]));
  const a = byPath(left.members);
  const b = byPath(right.members);
  const paths = [...new Set([...a.keys(), ...b.keys()])].sort();
  const differingMembers = paths
    .filter((path) => {
      const one = a.get(path);
      const two = b.get(path);
      return (
        !one || !two || one.type !== two.type || one.size !== two.size || one.sha256 !== two.sha256
      );
    })
    .map((path) => ({ path, candidate: a.get(path) ?? null, repeated: b.get(path) ?? null }));
  const changedNames = new Set(differingMembers.map(({ path }) => path));
  const historicalRestampShape =
    changedNames.size > 0 &&
    [...changedNames].every(
      (path) => path === "package/package.json" || path === "package/npm-shrinkwrap.json",
    );
  const leftByPath = new Map(left.members.map((member) => [member.path, member]));
  const rightByPath = new Map(right.members.map((member) => [member.path, member]));
  const differingHeaders = paths
    .filter((path) => leftByPath.get(path)?.header.sha256 !== rightByPath.get(path)?.header.sha256)
    .map((path) => ({
      path,
      candidate: leftByPath.get(path)?.header ?? null,
      repeated: rightByPath.get(path)?.header ?? null,
    }));
  let classification = "tar-structure-difference-review-required";
  if (candidate.equals(repeated)) classification = "exact-byte-match";
  else if (left.expanded.sha256 === right.expanded.sha256) {
    classification = "gzip-only-difference-review-required";
  } else if (differingMembers.length === 0 && differingHeaders.length > 0) {
    classification = "tar-metadata-only-difference-review-required";
  } else if (historicalRestampShape) {
    classification = "manifest-only-difference-review-required";
  } else if (differingMembers.length > 0) {
    classification = "member-content-difference-review-required";
  }
  return {
    schemaVersion: 1,
    kind: "docsfab-packed-reproducibility-diagnostic",
    classification,
    candidate: left,
    repeated: right,
    differingMemberCount: differingMembers.length,
    differingMembers,
    differingHeaderCount: differingHeaders.length,
    differingHeaders,
    gate: "failed",
  };
}
