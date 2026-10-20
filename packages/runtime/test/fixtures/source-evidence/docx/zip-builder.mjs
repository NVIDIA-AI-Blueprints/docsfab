// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Minimal deterministic ZIP writer for DOCX fixtures (#838).
 *
 * This is fixture tooling, not product code: it exists so both the committed
 * fixture generator and the adapter's negative-control tests can build exact,
 * reviewable ZIP byte sequences (including deliberately malformed ones)
 * without depending on a third-party ZIP library or a real Word install.
 *
 * CRC-32 fields are written as zero. The adapter under test never validates
 * per-entry CRC-32 (the host already binds the whole original file by SHA-256),
 * so a real checksum would add code with nothing to verify it. Real ZIP tools
 * that do check CRC-32 would reject these archives; that is fine, they are
 * test-only inputs for this adapter, not files meant to round-trip through
 * Word.
 */
import { deflateRawSync } from "node:zlib";

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;

/**
 * @param {Array<{
 *   name: string,
 *   content: string | Uint8Array,
 *   store?: boolean,
 *   generalPurposeFlag?: number,
 *   externalAttrs?: number,
 *   declaredUncompressedSize?: number,
 *   localNameOverride?: string,
 * }>} entries
 * @returns {Buffer}
 */
export function buildZip(entries) {
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, "utf8");
    // Deliberately test-only: the local header can name a different part than
    // the central directory entry it belongs to, to exercise the adapter's
    // agreement check between the two.
    const localNameBytes = Buffer.from(entry.localNameOverride ?? entry.name, "utf8");
    const content = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content);
    const method = entry.store ? 0 : 8;
    const data = entry.store ? content : deflateRawSync(content);
    const flag = entry.generalPurposeFlag ?? 0;
    // Deliberately test-only: the declared uncompressed size can be a lie
    // (smaller than what the entry actually inflates to), to prove the real
    // defense is the decompressor's own output-size bound, not this field.
    const declaredUncompressedSize = entry.declaredUncompressedSize ?? content.length;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(LOCAL_FILE_HEADER_SIGNATURE, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(flag, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0x21, 12);
    localHeader.writeUInt32LE(0, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(declaredUncompressedSize, 22);
    localHeader.writeUInt16LE(localNameBytes.length, 26);
    localHeader.writeUInt16LE(0, 28);

    const localHeaderOffset = offset;
    localChunks.push(localHeader, localNameBytes, data);
    offset += localHeader.length + localNameBytes.length + data.length;

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(CENTRAL_DIRECTORY_SIGNATURE, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(flag, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0x21, 14);
    centralHeader.writeUInt32LE(0, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(declaredUncompressedSize, 24);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(entry.externalAttrs ?? 0, 38);
    centralHeader.writeUInt32LE(localHeaderOffset, 42);
    centralChunks.push(centralHeader, nameBytes);
  }

  const centralDirectoryOffset = offset;
  const central = Buffer.concat(centralChunks);
  offset += central.length;

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(END_OF_CENTRAL_DIRECTORY_SIGNATURE, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(centralDirectoryOffset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localChunks, central, eocd]);
}

/** Unix symlink mode bits placed in a central-directory external-attrs field. */
export const SYMLINK_EXTERNAL_ATTRS = (0o120000 << 16) >>> 0;

/** General-purpose bit-flag bit 0: entry data is encrypted. */
export const ENCRYPTED_GENERAL_PURPOSE_FLAG = 0x1;
