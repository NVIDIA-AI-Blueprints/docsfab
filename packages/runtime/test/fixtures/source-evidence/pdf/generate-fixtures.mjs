#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Deterministic text-PDF fixture generator (#837).
 *
 * Hand-builds minimal, spec-legal PDF 1.4 byte structures directly, so the
 * committed fixtures are reproducible without a PDF authoring tool or a
 * network fetch, and so their exact byte layout (including which pages are
 * text-bearing, image-only, encrypted-marked, or malformed) is legible from
 * this script rather than opaque binary provenance.
 *
 * Run `node generate-fixtures.mjs` from this directory to regenerate the
 * committed `*.pdf` fixtures after an intentional change. Output is
 * deterministic: re-running with no logic change reproduces byte-identical
 * files (no timestamps, no random IDs).
 */
import { createCipheriv, createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Decoded size of the chained-filter bomb, in bytes.
 *
 * Sized against the slowest place it runs, not the fastest. At 192 MiB this
 * cost 1.8 s locally and 53 s under CI coverage instrumentation on a slow
 * runner, which is most of a 60 s vitest timeout and contributed to a job
 * hitting the 20-minute wall. 32 MiB is still orders of magnitude beyond what
 * a 25 ms budget can decode, so the deadline proof is unchanged, at roughly a
 * sixth of the cost.
 */
const CHAINED_BOMB_PAYLOAD_BYTES = 32 * 1024 * 1024;

function latin1(text) {
  return Buffer.from(text, "latin1");
}

/** Encode a JS string (code points 0x20-0x7E / 0xA0-0xFF only) as raw WinAnsi-equivalent PDF literal-string bytes. */
function pdfLiteralBytes(text) {
  const out = [];
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code === undefined || code > 0xff) {
      throw new Error(
        `fixture text outside the adapter's supported byte range: ${JSON.stringify(ch)}`,
      );
    }
    if (code === 0x28 || code === 0x29 || code === 0x5c) out.push(0x5c, code);
    else out.push(code);
  }
  return Buffer.from(out);
}

class PdfBuilder {
  constructor() {
    this.objects = new Map();
    this.nextNum = 1;
  }

  reserve() {
    const num = this.nextNum;
    this.nextNum += 1;
    return num;
  }

  addDict(num, dictBody) {
    this.objects.set(num, latin1(`${num} 0 obj\n${dictBody}\nendobj\n`));
  }

  addStream(num, extraDictEntries, rawBytes, { compress = false } = {}) {
    const body = compress ? deflateSync(rawBytes) : rawBytes;
    const filter = compress ? " /Filter /FlateDecode" : "";
    const header = latin1(
      `${num} 0 obj\n<< /Length ${body.length}${filter}${extraDictEntries} >>\nstream\n`,
    );
    const footer = latin1(`\nendstream\nendobj\n`);
    this.objects.set(num, Buffer.concat([header, body, footer]));
  }

  build(rootNum, extraTrailerEntries = "") {
    const header = latin1("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n");
    const parts = [header];
    const offsets = new Map();
    let offset = header.length;
    const maxNum = Math.max(...this.objects.keys());
    for (let num = 1; num <= maxNum; num += 1) {
      const buf = this.objects.get(num);
      if (!buf) continue;
      offsets.set(num, offset);
      parts.push(buf);
      offset += buf.length;
    }
    // Each 20-byte xref entry uses a CRLF end-of-line (one of the three PDF
    // spec-legal forms) rather than a trailing space before LF, so the
    // generated fixture has no line ending in a bare space/tab for
    // `git diff --check` to flag.
    const xrefOffset = offset;
    const xrefLines = [`xref\n`, `0 ${maxNum + 1}\n`, `0000000000 65535 f\r\n`];
    for (let num = 1; num <= maxNum; num += 1) {
      const off = offsets.get(num);
      xrefLines.push(
        off === undefined
          ? `0000000000 00000 f\r\n`
          : `${String(off).padStart(10, "0")} 00000 n\r\n`,
      );
    }
    parts.push(latin1(xrefLines.join("")));
    parts.push(
      latin1(
        `trailer\n<< /Size ${maxNum + 1} /Root ${rootNum} 0 R${extraTrailerEntries} >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
      ),
    );
    return Buffer.concat(parts);
  }
}

const XREF_STREAM_LINE = "Held inside a PDF 1.5 cross-reference stream file.";
const RC4_LINE = "Owner-locked but openable: this text must still never be cited.";
const LOOKALIKE_LINE = "This page merely mentions /Encrypt, /O and /U as words.";
const ACROFORM_LINE = "Static page text beside an AcroForm whose values are elsewhere.";
const AES128_LINE = "AES-128 owner-locked: readable by any reader, citable by none.";
const AES256_LINE = "AES-256 owner-locked: readable by any reader, citable by none.";
const SUPERSEDED_LINE = "SUPERSEDED revision one text that must never be cited.";
const CURRENT_LINE = "CURRENT revision two text that a correct reader cites.";

const FONT_DICT = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`;

function pageDict(pagesNum, fontNum, contentNum) {
  return `<< /Type /Page /Parent ${pagesNum} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontNum} 0 R >> >> /Contents ${contentNum} 0 R >>`;
}

function textStream(lines) {
  const parts = [latin1("BT\n/F1 12 Tf\n72 720 Td\n")];
  lines.forEach((line, index) => {
    if (index > 0) parts.push(latin1("0 -18 Td\n"));
    if (Array.isArray(line)) {
      parts.push(latin1("["));
      for (const piece of line) {
        if (typeof piece === "number") {
          parts.push(latin1(`${piece} `));
        } else {
          parts.push(latin1("("), pdfLiteralBytes(piece), latin1(")"));
        }
      }
      parts.push(latin1("] TJ\n"));
    } else {
      parts.push(latin1("("), pdfLiteralBytes(line), latin1(") Tj\n"));
    }
  });
  parts.push(latin1("ET\n"));
  return Buffer.concat(parts);
}

/* ------------------------------------------------------------------ *
 * Standard security handler, revision 2 (RC4, 40-bit).
 *
 * Needed because the interesting encryption case is not "PDF.js refuses the
 * file". It is the opposite: a well-formed document with an owner password and
 * an EMPTY user password, which PDF.js decrypts without being asked for
 * anything, and which a reader could therefore quote verbatim. Building one by
 * hand is the only way to have that case in a committed fixture without
 * shipping someone else's encrypted document.
 * ------------------------------------------------------------------ */

/** PDF 32-byte password padding string (ISO 32000-1, Algorithm 2, step a). */
const PASSWORD_PAD = Buffer.from([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);

function padPassword(password) {
  return Buffer.concat([Buffer.from(password, "latin1"), PASSWORD_PAD]).subarray(0, 32);
}

function md5(...parts) {
  const hash = createHash("md5");
  for (const part of parts) hash.update(part);
  return hash.digest();
}

/** Textbook RC4. Deterministic, 20 lines, and only ever used on fixture bytes. */
function rc4(key, data) {
  const state = new Uint8Array(256);
  for (let index = 0; index < 256; index += 1) state[index] = index;
  let swap = 0;
  for (let index = 0; index < 256; index += 1) {
    swap = (swap + state[index] + key[index % key.length]) & 0xff;
    const hold = state[index];
    state[index] = state[swap];
    state[swap] = hold;
  }
  const out = Buffer.alloc(data.length);
  let i = 0;
  let j = 0;
  for (let index = 0; index < data.length; index += 1) {
    i = (i + 1) & 0xff;
    j = (j + state[i]) & 0xff;
    const hold = state[i];
    state[i] = state[j];
    state[j] = hold;
    out[index] = data[index] ^ state[(state[i] + state[j]) & 0xff];
  }
  return out;
}

function int32le(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeInt32LE(value, 0);
  return buffer;
}

/**
 * Build the /O and /U entries and the file encryption key for revision 2.
 *
 * `userPassword` is empty on purpose: that is the common real-world shape,
 * where the owner locks permissions and any reader can still open the file.
 */
function revision2Keys({ ownerPassword, userPassword, permissions, fileId }) {
  const ownerEntry = rc4(md5(padPassword(ownerPassword)).subarray(0, 5), padPassword(userPassword));
  const encryptionKey = md5(
    padPassword(userPassword),
    ownerEntry,
    int32le(permissions),
    fileId,
  ).subarray(0, 5);
  const userEntry = rc4(encryptionKey, PASSWORD_PAD);
  return { ownerEntry, userEntry, encryptionKey };
}

/** Per-object RC4 key (Algorithm 1): file key, then object and generation number. */
function objectKey(encryptionKey, objectNumber) {
  const suffix = Buffer.from([
    objectNumber & 0xff,
    (objectNumber >> 8) & 0xff,
    (objectNumber >> 16) & 0xff,
    0,
    0,
  ]);
  return md5(encryptionKey, suffix).subarray(0, Math.min(encryptionKey.length + 5, 16));
}

const hex = (buffer) => `<${buffer.toString("hex").toUpperCase()}>`;

/**
 * A genuinely encrypted, genuinely readable document: RC4 40-bit, owner
 * password set, user password EMPTY.
 *
 * PDF.js opens this with no password and returns its text. Nothing about the
 * load fails. The only thing standing between this document and a verbatim
 * quotation is the adapter checking, after load, whether the document was
 * encrypted at all. `hexName` writes the trailer key as `/Encr#79pt`, the same
 * PDF name spelled with an escape, to prove the check does not depend on the
 * literal bytes `/Encrypt` appearing anywhere.
 */
function buildRc4OwnerOnly({ hexName = false } = {}) {
  const PERMISSIONS = -4;
  const FILE_ID = Buffer.from("0123456789abcdef0123456789abcdef", "hex");
  const { ownerEntry, userEntry, encryptionKey } = revision2Keys({
    ownerPassword: "owner-secret",
    userPassword: "",
    permissions: PERMISSIONS,
    fileId: FILE_ID,
  });

  const b = new PdfBuilder();
  const catalogNum = b.reserve();
  const pagesNum = b.reserve();
  const pageNum = b.reserve();
  const fontNum = b.reserve();
  const contentNum = b.reserve();
  const encryptNum = b.reserve();

  b.addDict(catalogNum, `<< /Type /Catalog /Pages ${pagesNum} 0 R >>`);
  b.addDict(pagesNum, `<< /Type /Pages /Kids [${pageNum} 0 R] /Count 1 >>`);
  b.addDict(pageNum, pageDict(pagesNum, fontNum, contentNum));
  b.addDict(fontNum, FONT_DICT);
  // The content stream is really encrypted, so a reader that skipped
  // decryption would get noise rather than this sentence.
  b.addStream(contentNum, "", rc4(objectKey(encryptionKey, contentNum), textStream([RC4_LINE])), {
    compress: false,
  });
  // The security handler's own strings are never encrypted.
  b.addDict(
    encryptNum,
    `<< /Filter /Standard /V 1 /R 2 /O ${hex(ownerEntry)} /U ${hex(userEntry)} /P ${PERMISSIONS} >>`,
  );

  const key = hexName ? "/Encr#79pt" : "/Encrypt";
  return b.build(catalogNum, ` ${key} ${encryptNum} 0 R /ID [${hex(FILE_ID)} ${hex(FILE_ID)}]`);
}

/**
 * POSITIVE CONTROL for the encryption check: an ordinary, unencrypted document
 * whose page text mentions `/Encrypt`, `/O` and `/U`, so those byte sequences
 * appear verbatim in the file. A detector that pattern-matched raw bytes would
 * refuse this; the adapter must read it.
 */
function buildEncryptLookalike() {
  const b = new PdfBuilder();
  const catalogNum = b.reserve();
  const pagesNum = b.reserve();
  const pageNum = b.reserve();
  const fontNum = b.reserve();
  const contentNum = b.reserve();

  b.addDict(catalogNum, `<< /Type /Catalog /Pages ${pagesNum} 0 R >>`);
  b.addDict(pagesNum, `<< /Type /Pages /Kids [${pageNum} 0 R] /Count 1 >>`);
  b.addDict(pageNum, pageDict(pagesNum, fontNum, contentNum));
  b.addDict(fontNum, FONT_DICT);
  b.addStream(contentNum, "", textStream([LOOKALIKE_LINE]), { compress: false });

  return b.build(catalogNum);
}

/**
 * A page with real text under a plain AcroForm and no XFA.
 *
 * Static page text is genuine here, but form field values live in the AcroForm
 * and never appear in it, so the representation has to be partial rather than
 * complete.
 */
function buildAcroForm() {
  const b = new PdfBuilder();
  const catalogNum = b.reserve();
  const pagesNum = b.reserve();
  const pageNum = b.reserve();
  const fontNum = b.reserve();
  const contentNum = b.reserve();
  const fieldNum = b.reserve();

  b.addDict(
    catalogNum,
    `<< /Type /Catalog /Pages ${pagesNum} 0 R /AcroForm << /Fields [${fieldNum} 0 R] >> >>`,
  );
  b.addDict(pagesNum, `<< /Type /Pages /Kids [${pageNum} 0 R] /Count 1 >>`);
  b.addDict(pageNum, pageDict(pagesNum, fontNum, contentNum));
  b.addDict(fontNum, FONT_DICT);
  b.addDict(fieldNum, `<< /FT /Tx /T (applicant) /V (value that is not page text) >>`);
  b.addStream(contentNum, "", textStream([ACROFORM_LINE]), { compress: false });

  return b.build(catalogNum);
}

/**
 * A chained-filter decompression bomb: `/Filter [/FlateDecode x4]` over a run
 * of zero bytes, so the file is tiny and the fully decoded stream is not.
 *
 * `oversized-inflate-bomb.pdf` uses one filter and finishes quickly. Chaining
 * multiplies the work, and a review measured a larger version of this shape
 * taking 7.1 seconds before reporting `no-text-layer`. The adapter has no
 * decompressor of its own to bound, so what bounds this is the seam's deadline,
 * which reaches PDF.js because PDF.js yields. The test asserts exactly that.
 */
function buildChainedFilterBomb(payloadBytes) {
  const b = new PdfBuilder();
  const catalogNum = b.reserve();
  const pagesNum = b.reserve();
  const pageNum = b.reserve();
  const fontNum = b.reserve();
  const contentNum = b.reserve();

  b.addDict(catalogNum, `<< /Type /Catalog /Pages ${pagesNum} 0 R >>`);
  b.addDict(pagesNum, `<< /Type /Pages /Kids [${pageNum} 0 R] /Count 1 >>`);
  b.addDict(pageNum, pageDict(pagesNum, fontNum, contentNum));
  b.addDict(fontNum, FONT_DICT);

  let body = Buffer.alloc(payloadBytes, 0);
  for (let round = 0; round < 4; round += 1) body = deflateSync(body);
  const header = latin1(
    `${contentNum} 0 obj\n<< /Length ${body.length} /Filter [/FlateDecode /FlateDecode /FlateDecode /FlateDecode] >>\nstream\n`,
  );
  b.objects.set(contentNum, Buffer.concat([header, body, latin1("\nendstream\nendobj\n")]));

  return b.build(catalogNum);
}

/* ------------------------------------------------------------------ *
 * AES security handlers: V4/R4 (AESV2, 128-bit) and V5/R6 (AESV3, 256-bit).
 *
 * RC4 is the simplest encrypted PDF to hand-build, but it is not the one
 * readers actually meet. Every modern producer writes AES, so a corpus that
 * only covers RC4 leaves the common case resting on a reviewer's session
 * rather than on a committed fixture. Both handlers below produce documents
 * that PDF.js opens and decrypts with no password, exactly like the RC4 one,
 * which is the property the adapter has to survive.
 *
 * Everything is deterministic: fixed salts, fixed initialization vectors, and
 * a fixed file key. Determinism matters more than unpredictability here,
 * because the whole point is a byte-reproducible fixture, and none of this
 * material protects anything.
 * ------------------------------------------------------------------ */

function md5Times(times, input, keyLength) {
  let digest = input;
  for (let round = 0; round < times; round += 1) {
    digest = createHash("md5").update(digest.subarray(0, keyLength)).digest();
  }
  return digest;
}

function aesCbcNoPad(key, iv, data) {
  const cipher = createCipheriv(key.length === 32 ? "aes-256-cbc" : "aes-128-cbc", key, iv);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

/** AES-CBC with the PDF's required 16-byte IV prefix and PKCS#7 padding. */
function aesCbcStream(key, iv, data) {
  const cipher = createCipheriv(key.length === 32 ? "aes-256-cbc" : "aes-128-cbc", key, iv);
  return Buffer.concat([iv, cipher.update(data), cipher.final()]);
}

/**
 * AES-128, /V 4 /R 4, security handler revision 4 with the AESV2 crypt filter.
 *
 * Key derivation is the classic MD5 algorithm with the revision-3-and-up
 * 50-round hardening, and the per-object key takes the extra `sAlT` suffix that
 * AESV2 requires.
 */
function buildAes128OwnerOnly() {
  const PERMISSIONS = -4;
  const KEY_LENGTH = 16;
  const FILE_ID = Buffer.from("fedcba98765432100123456789abcdef", "hex");
  const IV = Buffer.from("000102030405060708090a0b0c0d0e0f", "hex");

  // Algorithm 3, revision 3 and up: 50 MD5 rounds, then 20 RC4 rounds.
  const ownerBase = md5Times(
    50,
    createHash("md5").update(padPassword("owner-secret")).digest(),
    KEY_LENGTH,
  );
  let ownerEntry = padPassword("");
  for (let round = 0; round < 20; round += 1) {
    const roundKey = Buffer.from(ownerBase.subarray(0, KEY_LENGTH).map((byte) => byte ^ round));
    ownerEntry = rc4(roundKey, ownerEntry);
  }

  // Algorithm 2, revision 3 and up: 50 MD5 rounds over the same inputs.
  const keyBase = createHash("md5")
    .update(Buffer.concat([padPassword(""), ownerEntry, int32le(PERMISSIONS), FILE_ID]))
    .digest();
  const encryptionKey = md5Times(50, keyBase, KEY_LENGTH).subarray(0, KEY_LENGTH);

  // Algorithm 5: MD5 of the pad and the file id, then 20 RC4 rounds.
  let userEntry = rc4(
    encryptionKey,
    createHash("md5")
      .update(Buffer.concat([PASSWORD_PAD, FILE_ID]))
      .digest(),
  );
  for (let round = 1; round <= 19; round += 1) {
    const roundKey = Buffer.from(encryptionKey.map((byte) => byte ^ round));
    userEntry = rc4(roundKey, userEntry);
  }
  userEntry = Buffer.concat([userEntry, Buffer.alloc(16, 0)]).subarray(0, 32);

  const b = new PdfBuilder();
  const catalogNum = b.reserve();
  const pagesNum = b.reserve();
  const pageNum = b.reserve();
  const fontNum = b.reserve();
  const contentNum = b.reserve();
  const encryptNum = b.reserve();

  b.addDict(catalogNum, `<< /Type /Catalog /Pages ${pagesNum} 0 R >>`);
  b.addDict(pagesNum, `<< /Type /Pages /Kids [${pageNum} 0 R] /Count 1 >>`);
  b.addDict(pageNum, pageDict(pagesNum, fontNum, contentNum));
  b.addDict(fontNum, FONT_DICT);

  // AESV2 per-object key: file key, object and generation number, then `sAlT`.
  const objectSalt = Buffer.concat([
    encryptionKey,
    Buffer.from([contentNum & 0xff, (contentNum >> 8) & 0xff, (contentNum >> 16) & 0xff, 0, 0]),
    Buffer.from([0x73, 0x41, 0x6c, 0x54]),
  ]);
  const contentKey = createHash("md5")
    .update(objectSalt)
    .digest()
    .subarray(0, Math.min(KEY_LENGTH + 5, 16));
  b.addStream(contentNum, "", aesCbcStream(contentKey, IV, textStream([AES128_LINE])), {
    compress: false,
  });

  b.addDict(
    encryptNum,
    `<< /Filter /Standard /V 4 /R 4 /Length 128 /CF << /StdCF << /CFM /AESV2 /AuthEvent /DocOpen /Length 16 >> >> /StmF /StdCF /StrF /StdCF /O ${hex(ownerEntry)} /U ${hex(userEntry)} /P ${PERMISSIONS} >>`,
  );

  return b.build(catalogNum, ` /Encrypt ${encryptNum} 0 R /ID [${hex(FILE_ID)} ${hex(FILE_ID)}]`);
}

/**
 * The revision-6 password hash (ISO 32000-2, Algorithm 2.B).
 *
 * The iterated SHA-256/384/512 loop is the only fiddly part of AES-256, and it
 * is written out here rather than approximated, because a fixture PDF.js
 * cannot open would silently become another load-failure test.
 */
function hash2B(password, salt, userData) {
  let k = createHash("sha256")
    .update(Buffer.concat([password, salt, userData]))
    .digest();
  let round = 0;
  for (;;) {
    const k1 = Buffer.concat(
      Array.from({ length: 64 }, () => Buffer.concat([password, k, userData])),
    );
    const e = aesCbcNoPad(k.subarray(0, 16), k.subarray(16, 32), k1);
    let sum = 0;
    for (let index = 0; index < 16; index += 1) sum += e[index];
    const algorithm = ["sha256", "sha384", "sha512"][sum % 3];
    k = createHash(algorithm).update(e).digest();
    round += 1;
    if (round >= 64 && e[e.length - 1] <= round - 32) break;
  }
  return k.subarray(0, 32);
}

/**
 * AES-256, /V 5 /R 6, the shape every current producer writes.
 *
 * The file key is independent of the passwords here: /U and /UE wrap it for
 * the (empty) user password, so any reader opens the document unasked, which
 * is exactly the case that matters.
 */
function buildAes256OwnerOnly() {
  const PERMISSIONS = -4;
  const FILE_KEY = Buffer.from(
    "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",
    "hex",
  );
  const IV = Buffer.from("0f0e0d0c0b0a09080706050403020100", "hex");
  const USER_VALIDATION_SALT = Buffer.from("0001020304050607", "hex");
  const USER_KEY_SALT = Buffer.from("08090a0b0c0d0e0f", "hex");
  const OWNER_VALIDATION_SALT = Buffer.from("1011121314151617", "hex");
  const OWNER_KEY_SALT = Buffer.from("18191a1b1c1d1e1f", "hex");
  const EMPTY = Buffer.alloc(0);
  const owner = Buffer.from("owner-secret", "latin1");

  const userHash = hash2B(EMPTY, USER_VALIDATION_SALT, EMPTY);
  const userEntry = Buffer.concat([userHash, USER_VALIDATION_SALT, USER_KEY_SALT]);
  const userKey = hash2B(EMPTY, USER_KEY_SALT, EMPTY);
  const userEncrypted = aesCbcNoPad(userKey, Buffer.alloc(16, 0), FILE_KEY);

  const ownerHash = hash2B(owner, OWNER_VALIDATION_SALT, userEntry);
  const ownerEntry = Buffer.concat([ownerHash, OWNER_VALIDATION_SALT, OWNER_KEY_SALT]);
  const ownerKey = hash2B(owner, OWNER_KEY_SALT, userEntry);
  const ownerEncrypted = aesCbcNoPad(ownerKey, Buffer.alloc(16, 0), FILE_KEY);

  // /Perms: permissions, the "adb" marker, and filler, in AES-256-ECB.
  const permsBlock = Buffer.concat([
    int32le(PERMISSIONS),
    Buffer.from([0xff, 0xff, 0xff, 0xff]),
    Buffer.from("T", "latin1"),
    Buffer.from("adb", "latin1"),
    Buffer.from([0, 0, 0, 0]),
  ]);
  const permsCipher = createCipheriv("aes-256-ecb", FILE_KEY, null);
  permsCipher.setAutoPadding(false);
  const perms = Buffer.concat([permsCipher.update(permsBlock), permsCipher.final()]);

  const b = new PdfBuilder();
  const catalogNum = b.reserve();
  const pagesNum = b.reserve();
  const pageNum = b.reserve();
  const fontNum = b.reserve();
  const contentNum = b.reserve();
  const encryptNum = b.reserve();

  b.addDict(catalogNum, `<< /Type /Catalog /Pages ${pagesNum} 0 R >>`);
  b.addDict(pagesNum, `<< /Type /Pages /Kids [${pageNum} 0 R] /Count 1 >>`);
  b.addDict(pageNum, pageDict(pagesNum, fontNum, contentNum));
  b.addDict(fontNum, FONT_DICT);
  // AESV3 uses the file key directly: no per-object derivation.
  b.addStream(contentNum, "", aesCbcStream(FILE_KEY, IV, textStream([AES256_LINE])), {
    compress: false,
  });

  b.addDict(
    encryptNum,
    `<< /Filter /Standard /V 5 /R 6 /Length 256 /CF << /StdCF << /CFM /AESV3 /AuthEvent /DocOpen /Length 32 >> >> /StmF /StdCF /StrF /StdCF /O ${hex(ownerEntry)} /U ${hex(userEntry)} /OE ${hex(ownerEncrypted)} /UE ${hex(userEncrypted)} /Perms ${hex(perms)} /P ${PERMISSIONS} >>`,
  );

  const FILE_ID = Buffer.from("aabbccddeeff00112233445566778899", "hex");
  return b.build(catalogNum, ` /Encrypt ${encryptNum} 0 R /ID [${hex(FILE_ID)} ${hex(FILE_ID)}]`);
}

/** Two-page fixture: ASCII, non-ASCII (accented) text, one plain and one FlateDecode stream, one TJ array. */
function buildSimpleTwoPage({ divergent = false } = {}) {
  const b = new PdfBuilder();
  const catalogNum = b.reserve();
  const pagesNum = b.reserve();
  const page1Num = b.reserve();
  const page2Num = b.reserve();
  const fontNum = b.reserve();
  const content1Num = b.reserve();
  const content2Num = b.reserve();

  b.addDict(catalogNum, `<< /Type /Catalog /Pages ${pagesNum} 0 R >>`);
  b.addDict(pagesNum, `<< /Type /Pages /Kids [${page1Num} 0 R ${page2Num} 0 R] /Count 2 >>`);
  b.addDict(page1Num, pageDict(pagesNum, fontNum, content1Num));
  b.addDict(page2Num, pageDict(pagesNum, fontNum, content2Num));
  b.addDict(fontNum, FONT_DICT);

  const firstLine = divergent
    ? "The five boxing wizards jump quickly."
    : "The quick brown fox jumps over the lazy dog.";
  const secondLine = divergent
    ? "Accents: garçon, mañana, naïve, crema catalana."
    : "Accents: café, señor, über, façade.";
  const content1 = textStream([firstLine, secondLine]);
  b.addStream(content1Num, "", content1, { compress: false });

  const thirdLine = divergent
    ? "Page two of the divergent fixture, second item."
    : "Page two, second item.";
  const content2 = textStream([
    [divergent ? "Sorted" : "Kerned", -250, "Text", -250, "Example"],
    thirdLine,
  ]);
  b.addStream(content2Num, "", content2, { compress: true });

  return b.build(catalogNum);
}

/** One page whose only mark-making is an XObject image: no text-showing operator at all. */
function buildImageOnly() {
  const b = new PdfBuilder();
  const catalogNum = b.reserve();
  const pagesNum = b.reserve();
  const pageNum = b.reserve();
  const imgNum = b.reserve();
  const contentNum = b.reserve();

  b.addDict(catalogNum, `<< /Type /Catalog /Pages ${pagesNum} 0 R >>`);
  b.addDict(pagesNum, `<< /Type /Pages /Kids [${pageNum} 0 R] /Count 1 >>`);
  b.addDict(
    pageNum,
    `<< /Type /Page /Parent ${pagesNum} 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 ${imgNum} 0 R >> >> /Contents ${contentNum} 0 R >>`,
  );
  b.addStream(
    imgNum,
    " /Type /XObject /Subtype /Image /Width 2 /Height 3 /ColorSpace /DeviceRGB /BitsPerComponent 8",
    Buffer.from([
      0xff, 0x00, 0x00, 0x00, 0x00, 0xff, 0x00, 0xff, 0x00, 0xff, 0xff, 0x00, 0x00, 0xff, 0xff,
      0xff, 0x00, 0xff,
    ]),
    { compress: false },
  );
  b.addStream(contentNum, "", latin1("q 80 0 0 120 72 96 cm /Im1 Do Q\n"), { compress: false });

  return b.build(catalogNum);
}

/** Page one has real text; page two is image-only: exercises "partial" completeness. */
function buildMixed() {
  const b = new PdfBuilder();
  const catalogNum = b.reserve();
  const pagesNum = b.reserve();
  const page1Num = b.reserve();
  const page2Num = b.reserve();
  const fontNum = b.reserve();
  const imgNum = b.reserve();
  const content1Num = b.reserve();
  const content2Num = b.reserve();

  b.addDict(catalogNum, `<< /Type /Catalog /Pages ${pagesNum} 0 R >>`);
  b.addDict(pagesNum, `<< /Type /Pages /Kids [${page1Num} 0 R ${page2Num} 0 R] /Count 2 >>`);
  b.addDict(page1Num, pageDict(pagesNum, fontNum, content1Num));
  b.addDict(
    page2Num,
    `<< /Type /Page /Parent ${pagesNum} 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 ${imgNum} 0 R >> >> /Contents ${content2Num} 0 R >>`,
  );
  b.addDict(fontNum, FONT_DICT);
  b.addStream(
    imgNum,
    " /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8",
    Buffer.from([0x40]),
    { compress: false },
  );

  b.addStream(
    content1Num,
    "",
    textStream(["Only the first page of this document carries readable text."]),
    { compress: false },
  );
  b.addStream(content2Num, "", latin1("q 50 0 0 50 50 50 cm /Im1 Do Q\n"), { compress: false });

  return b.build(catalogNum);
}

/** One page, zero-length content stream: no text, no image, nothing to read. */
function buildEmpty() {
  const b = new PdfBuilder();
  const catalogNum = b.reserve();
  const pagesNum = b.reserve();
  const pageNum = b.reserve();
  const fontNum = b.reserve();
  const contentNum = b.reserve();

  b.addDict(catalogNum, `<< /Type /Catalog /Pages ${pagesNum} 0 R >>`);
  b.addDict(pagesNum, `<< /Type /Pages /Kids [${pageNum} 0 R] /Count 1 >>`);
  b.addDict(pageNum, pageDict(pagesNum, fontNum, contentNum));
  b.addDict(fontNum, FONT_DICT);
  b.addStream(contentNum, "", Buffer.alloc(0), { compress: false });

  return b.build(catalogNum);
}

/** A real, otherwise-readable document whose trailer names an /Encrypt dictionary. */
function buildEncrypted() {
  const b = new PdfBuilder();
  const catalogNum = b.reserve();
  const pagesNum = b.reserve();
  const pageNum = b.reserve();
  const fontNum = b.reserve();
  const contentNum = b.reserve();

  b.addDict(catalogNum, `<< /Type /Catalog /Pages ${pagesNum} 0 R >>`);
  b.addDict(pagesNum, `<< /Type /Pages /Kids [${pageNum} 0 R] /Count 1 >>`);
  b.addDict(pageNum, pageDict(pagesNum, fontNum, contentNum));
  b.addDict(fontNum, FONT_DICT);
  b.addStream(
    contentNum,
    "",
    textStream(["This text exists but must never be read: the file is encrypted."]),
    {
      compress: false,
    },
  );

  // A deliberately INVALID /Encrypt dictionary: /O and /U are one byte each,
  // so PDF.js cannot derive a key and fails at load with a PasswordException.
  // That is a real case, but it only proves "load failure implies refusal".
  // The refusal that matters is `rc4-owner-only.pdf`, which PDF.js decrypts
  // successfully; this fixture does not stand in for it.
  const encryptNum = b.reserve();
  b.addDict(encryptNum, `<< /Filter /Standard /V 1 /R 2 /O <00> /U <00> /P -4 >>`);

  return b.build(catalogNum, ` /Encrypt ${encryptNum} 0 R`);
}

/** A header that claims to be a PDF, with no parseable object graph beneath it. */
function buildMalformed() {
  return latin1(
    "%PDF-1.4\n% This file intentionally has no valid catalog/pages object graph.\n1 0 obj\n<< /NotEvenClose\nendobj\n%%EOF\n",
  );
}

/**
 * A page whose text uses a Type0/Identity-H composite font with hex-string
 * operands, the shape a critic review found the removed hand-written parser
 * silently mis-decoded (real text "012" was misread through the Latin-1
 * table as "HACH"). PDF.js resolves these CIDs to the digits "012", so this
 * fixture is the positive control for composite fonts; `type0-unmapped.pdf`
 * is the refusal case.
 */
function buildType0Font() {
  const b = new PdfBuilder();
  const catalogNum = b.reserve();
  const pagesNum = b.reserve();
  const pageNum = b.reserve();
  const fontNum = b.reserve();
  const descendantNum = b.reserve();
  const contentNum = b.reserve();

  b.addDict(catalogNum, `<< /Type /Catalog /Pages ${pagesNum} 0 R >>`);
  b.addDict(pagesNum, `<< /Type /Pages /Kids [${pageNum} 0 R] /Count 1 >>`);
  b.addDict(
    pageNum,
    `<< /Type /Page /Parent ${pagesNum} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontNum} 0 R >> >> /Contents ${contentNum} 0 R >>`,
  );
  b.addDict(
    fontNum,
    `<< /Type /Font /Subtype /Type0 /BaseFont /Identity-H /Encoding /Identity-H /DescendantFonts [${descendantNum} 0 R] >>`,
  );
  b.addDict(
    descendantNum,
    `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Identity-H /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /DW 1000 >>`,
  );
  // CIDs 0x0030 0x0031 0x0032 with no embedded font/CIDToGIDMap/ToUnicode:
  // without those, "text" here has no well-defined character meaning at
  // all, which is exactly why decoding it as Latin-1 bytes (as the removed
  // parser did) is wrong rather than merely imprecise.
  b.addStream(contentNum, "", latin1("BT\n/F1 12 Tf\n72 720 Td\n<003000310032> Tj\nET\n"), {
    compress: false,
  });

  return b.build(catalogNum);
}

/**
 * A page that draws an inline image (`BI` / `ID` / `EI`) with no
 * text-showing operator at all: the shape a critic review found the removed
 * hand-written parser treated as citable text, because it tokenized `ID`'s
 * raw image bytes the same way it tokenized real content-stream operands.
 */
function buildInlineImage() {
  const b = new PdfBuilder();
  const catalogNum = b.reserve();
  const pagesNum = b.reserve();
  const pageNum = b.reserve();
  const contentNum = b.reserve();

  b.addDict(catalogNum, `<< /Type /Catalog /Pages ${pagesNum} 0 R >>`);
  b.addDict(pagesNum, `<< /Type /Pages /Kids [${pageNum} 0 R] /Count 1 >>`);
  b.addDict(
    pageNum,
    `<< /Type /Page /Parent ${pagesNum} 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents ${contentNum} 0 R >>`,
  );
  const inlineImageBytes = Buffer.concat([
    latin1("q\nBI\n/W 4\n/H 1\n/CS /G\n/BPC 8\nID\n"),
    Buffer.from([0x41, 0x42, 0x43, 0x2e]), // "ABC." -- readable-looking raw sample bytes, not text
    latin1("\nEI\nQ\n"),
  ]);
  b.addStream(contentNum, "", inlineImageBytes, { compress: false });

  return b.build(catalogNum);
}

/**
 * A real PDF 1.5+ file whose object graph is reachable only through a
 * cross-reference stream (`/Type /XRef`) plus an object stream
 * (`/Type /ObjStm`): there is no classic `xref` table and no `trailer`
 * dictionary anywhere in the bytes, and the font object exists only as a
 * compressed member of the object stream, with no `N G obj` header of its
 * own.
 *
 * A critic review found the removed hand-written parser returned nothing at
 * all for this shape, with no limitation reported, because it only ever
 * scanned for literal `N G obj` headers. This fixture is byte-correct, so a
 * reader that genuinely follows the cross-reference stream extracts the page
 * text and a reader that does not gets nothing. That difference is the test.
 */
function buildXrefStreamPdf() {
  // Fixed object numbers: the cross-reference stream has to describe every
  // one of them by number, so they are written out rather than reserved.
  const CATALOG = 1;
  const PAGES = 2;
  const PAGE = 3;
  const CONTENT = 4;
  const FONT = 5; // lives only inside the object stream
  const OBJSTM = 6;
  const XREF = 7;
  const SIZE = 8;

  const b = new PdfBuilder();
  b.addDict(CATALOG, `<< /Type /Catalog /Pages ${PAGES} 0 R >>`);
  b.addDict(PAGES, `<< /Type /Pages /Kids [${PAGE} 0 R] /Count 1 >>`);
  b.addDict(PAGE, pageDict(PAGES, FONT, CONTENT));
  b.addStream(CONTENT, "", textStream([XREF_STREAM_LINE]), { compress: false });

  // Object stream: a "N offset" pair header, then the object bodies. The font
  // dictionary is the only member, so its offset inside the payload is 0.
  const objStmHeader = latin1(`${FONT} 0 `);
  const objStmPayload = Buffer.concat([objStmHeader, latin1(FONT_DICT)]);
  b.addStream(OBJSTM, ` /Type /ObjStm /N 1 /First ${objStmHeader.length}`, objStmPayload, {
    compress: true,
  });

  const header = latin1("%PDF-1.5\n%\xe2\xe3\xcf\xd3\n");
  const parts = [header];
  const offsets = new Map();
  let offset = header.length;
  for (const num of [CATALOG, PAGES, PAGE, CONTENT, OBJSTM]) {
    const buf = b.objects.get(num);
    offsets.set(num, offset);
    parts.push(buf);
    offset += buf.length;
  }
  const xrefOffset = offset;

  // /W [1 2 1]: one type byte, a two-byte field 2, a one-byte field 3.
  const rows = [];
  const row = (type, field2, field3) =>
    rows.push(Buffer.from([type, (field2 >> 8) & 0xff, field2 & 0xff, field3 & 0xff]));
  row(0, 0xffff, 0xff); // object 0, the head of the free list
  row(1, offsets.get(CATALOG), 0);
  row(1, offsets.get(PAGES), 0);
  row(1, offsets.get(PAGE), 0);
  row(1, offsets.get(CONTENT), 0);
  row(2, OBJSTM, 0); // type 2: object 5 is member index 0 of object stream 6
  row(1, offsets.get(OBJSTM), 0);
  row(1, xrefOffset, 0); // the cross-reference stream describes itself

  const xrefBody = deflateSync(Buffer.concat(rows));
  parts.push(
    latin1(
      `${XREF} 0 obj\n<< /Type /XRef /Size ${SIZE} /W [1 2 1] /Root ${CATALOG} 0 R /Filter /FlateDecode /Length ${xrefBody.length} >>\nstream\n`,
    ),
  );
  parts.push(xrefBody);
  parts.push(latin1(`\nendstream\nendobj\nstartxref\n${xrefOffset}\n%%EOF\n`));
  return Buffer.concat(parts);
}

/**
 * An incrementally updated file: the original content stream says one thing,
 * and an appended update section replaces that same object number with
 * different text, then appends its own `xref` table and a `trailer` carrying
 * `/Prev`.
 *
 * A critic review found the removed hand-written parser resolved objects by
 * taking the last matching `N G obj` header in byte order, so a shadow object
 * could be cited as though it were current. Here the superseding object is
 * physically LAST in the file but is the one a correct reader must use, and
 * the superseded object is physically first. Both orderings are therefore
 * distinguishable, and the fixture states which text is current.
 */
function buildIncrementalUpdate() {
  const CATALOG = 1;
  const PAGES = 2;
  const PAGE = 3;
  const FONT = 4;
  const CONTENT = 5;

  const b = new PdfBuilder();
  b.addDict(CATALOG, `<< /Type /Catalog /Pages ${PAGES} 0 R >>`);
  b.addDict(PAGES, `<< /Type /Pages /Kids [${PAGE} 0 R] /Count 1 >>`);
  b.addDict(PAGE, pageDict(PAGES, FONT, CONTENT));
  b.addDict(FONT, FONT_DICT);
  b.addStream(CONTENT, "", textStream([SUPERSEDED_LINE]), { compress: false });
  const base = b.build(CATALOG);

  // Revision 2: the same object number, new bytes, appended after %%EOF.
  const update = new PdfBuilder();
  update.addStream(CONTENT, "", textStream([CURRENT_LINE]), { compress: false });
  const updatedObject = update.objects.get(CONTENT);
  const updatedOffset = base.length;
  const updateXrefOffset = updatedOffset + updatedObject.length;
  const basePrev = Number(/startxref\n(\d+)\n%%EOF\n$/u.exec(base.toString("latin1"))?.[1] ?? "0");
  const updateXref = latin1(
    `xref\n0 1\n0000000000 65535 f\r\n${CONTENT} 1\n${String(updatedOffset).padStart(10, "0")} 00000 n\r\ntrailer\n<< /Size ${CONTENT + 1} /Root ${CATALOG} 0 R /Prev ${basePrev} >>\nstartxref\n${updateXrefOffset}\n%%EOF\n`,
  );
  return Buffer.concat([base, updatedObject, updateXref]);
}

/**
 * The same refusable document as `encrypted.pdf`, except the trailer spells
 * the `/Encrypt` key using a `#`-escaped name character: `/Encr#79pt`, where
 * `#79` is the letter `y`.
 *
 * `/Encrypt` and `/Encr#79pt` are the same PDF name. A detector that looks
 * for the literal bytes `/Encrypt` misses this file and reads text out of an
 * encrypted document; a reader that decodes name escapes, as PDF.js does,
 * does not. That is why the adapter under test never pattern-matches raw
 * bytes for encryption.
 */
function buildEncryptedHexName() {
  const b = new PdfBuilder();
  const catalogNum = b.reserve();
  const pagesNum = b.reserve();
  const pageNum = b.reserve();
  const fontNum = b.reserve();
  const contentNum = b.reserve();

  b.addDict(catalogNum, `<< /Type /Catalog /Pages ${pagesNum} 0 R >>`);
  b.addDict(pagesNum, `<< /Type /Pages /Kids [${pageNum} 0 R] /Count 1 >>`);
  b.addDict(pageNum, pageDict(pagesNum, fontNum, contentNum));
  b.addDict(fontNum, FONT_DICT);
  b.addStream(
    contentNum,
    "",
    textStream(["Hex-named encryption key: this text must never be read either."]),
    { compress: false },
  );

  const encryptNum = b.reserve();
  b.addDict(encryptNum, `<< /Filter /Standard /V 1 /R 2 /O <00> /U <00> /P -4 >>`);
  return b.build(catalogNum, ` /Encr#79pt ${encryptNum} 0 R`);
}

/**
 * A page with ordinary readable text whose catalog also declares an XFA form.
 *
 * An XFA document's user-visible content lives in the XFA XML stream, not in
 * the page content streams, so page text is at best a partial and at worst a
 * misleading view of what a reader would see. The adapter refuses rather than
 * citing the page layer as if it were the document.
 */
function buildXfaForm() {
  const b = new PdfBuilder();
  const catalogNum = b.reserve();
  const pagesNum = b.reserve();
  const pageNum = b.reserve();
  const fontNum = b.reserve();
  const contentNum = b.reserve();
  const xfaNum = b.reserve();

  b.addDict(
    catalogNum,
    `<< /Type /Catalog /Pages ${pagesNum} 0 R /AcroForm << /Fields [] /XFA ${xfaNum} 0 R >> >>`,
  );
  b.addDict(pagesNum, `<< /Type /Pages /Kids [${pageNum} 0 R] /Count 1 >>`);
  b.addDict(pageNum, pageDict(pagesNum, fontNum, contentNum));
  b.addDict(fontNum, FONT_DICT);
  b.addStream(
    contentNum,
    "",
    textStream(["Static page text that is not the XFA form the reader would see."]),
    { compress: false },
  );
  b.addStream(
    xfaNum,
    "",
    latin1('<?xml version="1.0" encoding="UTF-8"?><xdp:xdp xmlns:xdp="http://ns.adobe.com/xdp/"/>'),
    { compress: false },
  );

  return b.build(catalogNum);
}

/**
 * A Type0/Identity-H page whose CIDs land where no mapping exists at all, so
 * a reader has nothing to report but unmapped glyphs.
 *
 * `type0-font.pdf` uses CIDs 0x0030-0x0032, which PDF.js resolves to the
 * digits "012". This fixture uses CIDs in a range with no standard mapping
 * and no ToUnicode CMap, so PDF.js yields replacement or private-use code
 * points instead of characters. Those must be refused as
 * `unsupported-encoding`, never cited as source text.
 */
function buildType0Unmapped() {
  const b = new PdfBuilder();
  const catalogNum = b.reserve();
  const pagesNum = b.reserve();
  const pageNum = b.reserve();
  const fontNum = b.reserve();
  const descendantNum = b.reserve();
  const contentNum = b.reserve();

  b.addDict(catalogNum, `<< /Type /Catalog /Pages ${pagesNum} 0 R >>`);
  b.addDict(pagesNum, `<< /Type /Pages /Kids [${pageNum} 0 R] /Count 1 >>`);
  b.addDict(
    pageNum,
    `<< /Type /Page /Parent ${pagesNum} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontNum} 0 R >> >> /Contents ${contentNum} 0 R >>`,
  );
  b.addDict(
    fontNum,
    `<< /Type /Font /Subtype /Type0 /BaseFont /Identity-H /Encoding /Identity-H /DescendantFonts [${descendantNum} 0 R] >>`,
  );
  b.addDict(
    descendantNum,
    `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Identity-H /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /DW 1000 >>`,
  );
  b.addStream(contentNum, "", latin1("BT\n/F1 12 Tf\n72 720 Td\n<E000E001E002> Tj\nET\n"), {
    compress: false,
  });

  return b.build(catalogNum);
}

/**
 * Shared Type0/Identity-H page used by the #920 fixture pair.
 *
 * Same CIDs `0x0030 0x0031 0x0032` in the content stream either way. Without a
 * ToUnicode CMap, PDF.js's CID-to-Unicode heuristic is the identity function
 * and `getTextContent()` returns `012` with no public indicator that the
 * mapping was invented. With an embedded ToUnicode CMap that maps those CIDs
 * to A, B, and C, the same text API returns `ABC`. The pair is the control
 * and the divergent case for heuristic-encoding detection; at
 * `pdfjs-dist@6.3.289` the text API still cannot tell them apart.
 */
function buildType0Composite({ toUnicode } = {}) {
  const b = new PdfBuilder();
  const catalogNum = b.reserve();
  const pagesNum = b.reserve();
  const pageNum = b.reserve();
  const fontNum = b.reserve();
  const descendantNum = b.reserve();
  const contentNum = b.reserve();
  const cmapNum = toUnicode ? b.reserve() : undefined;

  b.addDict(catalogNum, `<< /Type /Catalog /Pages ${pagesNum} 0 R >>`);
  b.addDict(pagesNum, `<< /Type /Pages /Kids [${pageNum} 0 R] /Count 1 >>`);
  b.addDict(
    pageNum,
    `<< /Type /Page /Parent ${pagesNum} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontNum} 0 R >> >> /Contents ${contentNum} 0 R >>`,
  );
  const toUnicodeRef = cmapNum === undefined ? "" : ` /ToUnicode ${cmapNum} 0 R`;
  b.addDict(
    fontNum,
    `<< /Type /Font /Subtype /Type0 /BaseFont /Identity-H /Encoding /Identity-H /DescendantFonts [${descendantNum} 0 R]${toUnicodeRef} >>`,
  );
  b.addDict(
    descendantNum,
    `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Identity-H /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /DW 1000 >>`,
  );
  b.addStream(contentNum, "", latin1("BT\n/F1 12 Tf\n72 720 Td\n<003000310032> Tj\nET\n"), {
    compress: false,
  });
  if (cmapNum !== undefined) {
    const pairs = toUnicode
      .map(
        ([cid, unicode]) =>
          `<${cid.toString(16).padStart(4, "0").toUpperCase()}> <${unicode
            .toString(16)
            .padStart(4, "0")
            .toUpperCase()}>`,
      )
      .join("\n");
    b.addStream(
      cmapNum,
      "",
      latin1(
        `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n${toUnicode.length} beginbfchar\n${pairs}\nendbfchar\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n`,
      ),
      { compress: false },
    );
  }

  return b.build(catalogNum);
}

/** Composite Type0 page with no ToUnicode CMap: PDF.js heuristically emits `012`. */
function buildType0HeuristicEncoding() {
  return buildType0Composite();
}

/**
 * Composite Type0 page whose embedded ToUnicode CMap maps the same CIDs to
 * A, B, and C, so a reader that honours the map emits `ABC` rather than `012`.
 */
function buildType0ToUnicodeControl() {
  return buildType0Composite({
    toUnicode: [
      [0x0030, 0x0041],
      [0x0031, 0x0042],
      [0x0032, 0x0043],
    ],
  });
}

/**
 * A small `FlateDecode` stream that expands enormously (all-zero bytes
 * compress at a very high ratio): the shape a critic review found the
 * removed hand-written parser's unbounded `inflateSync` call turned into a
 * 157-second event-loop block on a single in-budget (3.65 MB) file. The
 * adapter under test never calls `zlib` at all, so this fixture is a
 * regression guard: if extraction is ever un-blocked without first fixing
 * that, this fixture is what should catch it before a shared host does.
 */
function buildOversizedInflateBomb() {
  const b = new PdfBuilder();
  const catalogNum = b.reserve();
  const pagesNum = b.reserve();
  const pageNum = b.reserve();
  const fontNum = b.reserve();
  const contentNum = b.reserve();

  b.addDict(catalogNum, `<< /Type /Catalog /Pages ${pagesNum} 0 R >>`);
  b.addDict(pagesNum, `<< /Type /Pages /Kids [${pageNum} 0 R] /Count 1 >>`);
  b.addDict(pageNum, pageDict(pagesNum, fontNum, contentNum));
  b.addDict(fontNum, FONT_DICT);
  // 5,000,000 zero bytes compress to a few KB at max ratio: small on disk,
  // large if ever actually inflated.
  b.addStream(contentNum, "", Buffer.alloc(5_000_000, 0), { compress: true });

  return b.build(catalogNum);
}

/** More pages than #795's 100-page policy, so the page ceiling is exercised against a real document rather than a synthetic count. */
function buildManyPages(count) {
  const b = new PdfBuilder();
  const catalogNum = b.reserve();
  const pagesNum = b.reserve();
  const fontNum = b.reserve();
  const pageNums = [];
  const contentNums = [];
  for (let index = 0; index < count; index += 1) {
    pageNums.push(b.reserve());
    contentNums.push(b.reserve());
  }

  b.addDict(catalogNum, `<< /Type /Catalog /Pages ${pagesNum} 0 R >>`);
  b.addDict(
    pagesNum,
    `<< /Type /Pages /Kids [${pageNums.map((n) => `${n} 0 R`).join(" ")}] /Count ${count} >>`,
  );
  b.addDict(fontNum, FONT_DICT);
  for (let index = 0; index < count; index += 1) {
    b.addDict(pageNums[index], pageDict(pagesNum, fontNum, contentNums[index]));
    b.addStream(contentNums[index], "", textStream([`Page ${index + 1} of ${count}.`]), {
      compress: false,
    });
  }

  return b.build(catalogNum);
}

const fixtures = {
  "simple-two-page.pdf": buildSimpleTwoPage(),
  "divergent-two-page.pdf": buildSimpleTwoPage({ divergent: true }),
  "image-only.pdf": buildImageOnly(),
  "mixed.pdf": buildMixed(),
  "empty.pdf": buildEmpty(),
  "encrypted.pdf": buildEncrypted(),
  "malformed.pdf": buildMalformed(),
  "many-pages.pdf": buildManyPages(105),
  "type0-font.pdf": buildType0Font(),
  "type0-heuristic-encoding.pdf": buildType0HeuristicEncoding(),
  "type0-tounicode.pdf": buildType0ToUnicodeControl(),
  "inline-image.pdf": buildInlineImage(),
  "xref-stream.pdf": buildXrefStreamPdf(),
  "oversized-inflate-bomb.pdf": buildOversizedInflateBomb(),
  "incremental-update.pdf": buildIncrementalUpdate(),
  "encrypted-hex-name.pdf": buildEncryptedHexName(),
  "type0-unmapped.pdf": buildType0Unmapped(),
  "xfa-form.pdf": buildXfaForm(),
  "acroform.pdf": buildAcroForm(),
  "rc4-owner-only.pdf": buildRc4OwnerOnly(),
  "rc4-owner-only-hex-name.pdf": buildRc4OwnerOnly({ hexName: true }),
  "encrypt-lookalike.pdf": buildEncryptLookalike(),
  "aes128-owner-only.pdf": buildAes128OwnerOnly(),
  "aes256-owner-only.pdf": buildAes256OwnerOnly(),
  "chained-filter-bomb.pdf": buildChainedFilterBomb(CHAINED_BOMB_PAYLOAD_BYTES),
};

for (const [name, bytes] of Object.entries(fixtures)) {
  writeFileSync(join(here, name), bytes);
  console.log(`wrote ${name} (${bytes.length} bytes)`);
}
