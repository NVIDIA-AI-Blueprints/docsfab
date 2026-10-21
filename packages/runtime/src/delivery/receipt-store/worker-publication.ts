// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  RECEIPT_HELPER_REPORT_IMPORT,
  receiptHelperFailureReportSource,
} from "../receipt-helper-exit.js";

export const MAX_RECEIPT_BYTES = 1_000_000;

export const STABLE_PUBLICATION_READ_WORKER_SOURCE = String.raw`
const sameFile = (actual, expected) => actual.dev === expected.dev && actual.ino === expected.ino;
const publicationUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const publicationTemporary = (candidate, destination) => {
  const prefix = "." + destination + ".";
  const suffix = ".tmp";
  return candidate.startsWith(prefix) && candidate.endsWith(suffix) &&
    publicationUuid.test(candidate.slice(prefix.length, -suffix.length));
};
const retryPause = new Int32Array(new SharedArrayBuffer(4));
// delivery.receiptPublicationSettleMs, resolved by the store for each helper.
const publicationSettleMs = Number(process.env.DOCSFAB_RECEIPT_PUBLICATION_SETTLE_MS);
if (!Number.isSafeInteger(publicationSettleMs) || publicationSettleMs <= 0) throw new Error("invalid settle budget");
const readStablePrivateFile = destination => {
  const fd = openSync(destination, constants.O_RDONLY | O_NOFOLLOW);
  const original = fstatSync(fd);
  const readStable = before => {
    if (!privateFile(before, 1) || before.size <= 0 || before.size > ${MAX_RECEIPT_BYTES}) {
      closeSync(fd);
      throw new Error("invalid");
    }
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    const leaf = lstatSync(destination);
    closeSync(fd);
    if (!privateFile(after, 1) || !privateFile(leaf, 1) || !sameFile(after, before) ||
        !sameFile(leaf, before) || after.size !== before.size ||
        bytes.byteLength !== before.size) throw new Error("invalid");
    return bytes;
  };
  if (original.nlink === 1) return readStable(original);
  if (!privateFile(original, 2) || original.size <= 0 || original.size > ${MAX_RECEIPT_BYTES}) {
    closeSync(fd);
    throw new Error("invalid");
  }
  // A concurrent writer holds a second link only between its link and unlink.
  // Wait for that window within the catalog budget, then refuse.
  const settleDeadline = performance.now() + publicationSettleMs;
  while (true) {
    const settleExpired = performance.now() >= settleDeadline;
    const held = fstatSync(fd);
    const canonical = lstatSync(destination);
    if (!sameFile(held, original) || !sameFile(canonical, original) ||
        held.size !== original.size) {
      closeSync(fd);
      throw new Error("invalid");
    }
    if (held.nlink === 1 && canonical.nlink === 1) return readStable(held);
    if (held.nlink !== canonical.nlink) {
      if (!((held.nlink === 1 && canonical.nlink === 2) ||
            (held.nlink === 2 && canonical.nlink === 1)) ||
          !privateFile(held, held.nlink) || !privateFile(canonical, canonical.nlink) ||
          settleExpired) {
        closeSync(fd);
        throw new Error("invalid");
      }
      Atomics.wait(retryPause, 0, 0, 5);
      continue;
    }
    if (!privateFile(held, 2) || !privateFile(canonical, 2)) {
      closeSync(fd);
      throw new Error("invalid");
    }
    let matchingAliases = 0;
    for (const candidate of readdirSync(".")) {
      if (!publicationTemporary(candidate, destination)) continue;
      let temporary;
      try { temporary = lstatSync(candidate); }
      catch (error) { if (error?.code === "ENOENT") continue; throw error; }
      if (sameFile(temporary, original)) {
        if (!privateFile(temporary, 2)) {
          closeSync(fd);
          throw new Error("invalid");
        }
        matchingAliases += 1;
      }
    }
    const afterHeld = fstatSync(fd);
    const afterCanonical = lstatSync(destination);
    if (!sameFile(afterHeld, original) || !sameFile(afterCanonical, original) ||
        afterHeld.size !== original.size) {
      closeSync(fd);
      throw new Error("invalid");
    }
    if (afterHeld.nlink === 1 && afterCanonical.nlink === 1) return readStable(afterHeld);
    if (afterHeld.nlink !== afterCanonical.nlink) {
      if (!((afterHeld.nlink === 1 && afterCanonical.nlink === 2) ||
            (afterHeld.nlink === 2 && afterCanonical.nlink === 1)) ||
          !privateFile(afterHeld, afterHeld.nlink) ||
          !privateFile(afterCanonical, afterCanonical.nlink) || settleExpired) {
        closeSync(fd);
        throw new Error("invalid");
      }
      Atomics.wait(retryPause, 0, 0, 5);
      continue;
    }
    if (!privateFile(afterHeld, 2) || !privateFile(afterCanonical, 2) ||
        matchingAliases !== 1 || settleExpired) {
      closeSync(fd);
      throw new Error("invalid");
    }
    Atomics.wait(retryPause, 0, 0, 5);
  }
};
`;

export const PLAN_WORKER = String.raw`
import { createHash, randomUUID } from "node:crypto";
import { constants, closeSync, fchmodSync, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync, readSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
${RECEIPT_HELPER_REPORT_IMPORT}
${receiptHelperFailureReportSource(1)}
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const expectedRoot = JSON.parse(process.env.DOCSFAB_RECEIPT_ROOT_IDENTITY ?? "null");
const safeSha = value => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const sameDirectory = (actual, expected) => actual.isDirectory() && actual.dev === expected.dev && actual.ino === expected.ino && actual.uid === expected.uid && (actual.mode & 0o7777) === (expected.mode & 0o7777);
const privateFile = (stat, nlink) => stat.isFile() && !stat.isSymbolicLink() && stat.uid === expectedRoot.uid && (stat.mode & 0o7777) === 0o600 && stat.nlink === nlink;
${STABLE_PUBLICATION_READ_WORKER_SOURCE}
const root = statSync(".");
if (!expectedRoot || !sameDirectory(root, expectedRoot)) process.exit(2);
const bytes = [];
const one = Buffer.alloc(1);
while (true) {
  if (readSync(0, one, 0, 1, null) !== 1) throw new Error("missing request");
  if (one[0] === 10) break;
  bytes.push(one[0]);
  if (bytes.length > ${MAX_RECEIPT_BYTES * 2}) throw new Error("oversized");
}
const request = JSON.parse(Buffer.from(bytes).toString("utf8"));
if (!request || !safeSha(request.planSha256) || !["load", "bind"].includes(request.operation)) throw new Error("invalid");
process.stdout.write("READY\n");
if (readSync(0, one, 0, 1, null) !== 1 || one[0] !== 49) throw new Error("unauthorized");
const name = "plan-" + request.planSha256 + ".json";
const serializeCanonical = (value, depth = 0) => {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") return JSON.stringify(value);
  const indentation = "  ".repeat(depth);
  const childIndentation = "  ".repeat(depth + 1);
  if (Array.isArray(value)) return value.length === 0 ? "[]" : "[\n" + value.map(item => childIndentation + serializeCanonical(item, depth + 1)).join(",\n") + "\n" + indentation + "]";
  if (typeof value !== "object") throw new Error("invalid");
  const keys = Object.keys(value).sort();
  return keys.length === 0 ? "{}" : "{\n" + keys.map(key => childIndentation + JSON.stringify(key) + ": " + serializeCanonical(value[key], depth + 1)).join(",\n") + "\n" + indentation + "}";
};
const digest = value => createHash("sha256").update(serializeCanonical(value) + "\n").digest("hex");
const validate = envelope => {
  if (!envelope || envelope.schemaVersion !== 1 || envelope.kind !== "docsfab-scm-publication-plan-binding" ||
      !safeSha(envelope.idempotencyKey) || !envelope.plan || envelope.plan.sha256 !== request.planSha256 || !safeSha(envelope.sha256)) throw new Error("invalid");
  const { sha256, ...body } = envelope;
  if (sha256 !== digest(body)) throw new Error("invalid");
  return envelope;
};
const load = () => {
  let bytes;
  try { bytes = readStablePrivateFile(name); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
  const parsed = JSON.parse(bytes.toString("utf8"));
  if (!bytes.equals(Buffer.from(JSON.stringify(parsed, null, 2) + "\n"))) throw new Error("invalid");
  return validate(parsed);
};
if (request.operation === "bind") {
  const envelope = validate(request.envelope);
  const bytes = Buffer.from(JSON.stringify(envelope, null, 2) + "\n");
  const temporary = "." + name + "." + randomUUID() + ".tmp";
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW, 0o600);
  fchmodSync(fd, 0o600);
  writeFileSync(fd, bytes);
  fsyncSync(fd);
  const temporaryStat = fstatSync(fd);
  closeSync(fd);
  if (!privateFile(temporaryStat, 1)) throw new Error("invalid");
  try { linkSync(temporary, name); } catch (error) { if (error?.code !== "EEXIST") throw error; }
  unlinkSync(temporary);
  const rootFd = openSync(".", constants.O_RDONLY | constants.O_DIRECTORY | O_NOFOLLOW);
  fsyncSync(rootFd);
  closeSync(rootFd);
  const bound = load();
  if (!bound || !bytes.equals(Buffer.from(JSON.stringify(bound, null, 2) + "\n"))) throw new Error("conflict");
  process.stdout.write(JSON.stringify({ envelope: bound }));
} else {
  process.stdout.write(JSON.stringify({ envelope: load() }));
}
`;

/**
 * The helper starts with an OS-held cwd for the pinned receipt root, then
 * changes into and verifies the exact journal inode before every relative
 * create/read. Path replacement can make the operation fail, but cannot
 * redirect receipt bytes into the replacement.
 */
export const JOURNAL_WORKER = String.raw`
import { createHash, randomUUID } from "node:crypto";
import { constants, closeSync, fchmodSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
${RECEIPT_HELPER_REPORT_IMPORT}
${receiptHelperFailureReportSource(1)}

const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const expectedRoot = JSON.parse(process.env.DOCSFAB_RECEIPT_ROOT_IDENTITY ?? "null");
const readLine = () => {
  const bytes = [];
  const one = Buffer.alloc(1);
  while (true) {
    if (readSync(0, one, 0, 1, null) !== 1) throw new Error("missing request");
    if (one[0] === 10) return Buffer.from(bytes).toString("utf8");
    bytes.push(one[0]);
    if (bytes.length > ${MAX_RECEIPT_BYTES * 2}) throw new Error("oversized request");
  }
};
const request = JSON.parse(readLine());
const safeSha = value => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const sameDirectory = (actual, expected) => actual.isDirectory() && actual.dev === expected.dev && actual.ino === expected.ino && actual.uid === expected.uid && (actual.mode & 0o7777) === (expected.mode & 0o7777);
const root = statSync(".");
if (!expectedRoot || !sameDirectory(root, expectedRoot) || !safeSha(request.idempotencyKey)) process.exit(2);

const gate = Buffer.alloc(1);
if (request.operation === "claim" || request.operation === "cas") {
  process.stdout.write("MUTATE\n");
  if (readSync(0, gate, 0, 1, null) !== 1 || gate[0] !== 49) process.exit(2);
}

let journalLeaf;
try {
  journalLeaf = lstatSync(request.idempotencyKey);
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
  if (request.operation === "load" || request.operation === "inspect") {
    process.stdout.write(JSON.stringify({ envelope: null }));
    process.exit(0);
  }
  try { mkdirSync(request.idempotencyKey, { mode: 0o700 }); } catch (mkdirError) { if (mkdirError?.code !== "EEXIST") throw mkdirError; }
  journalLeaf = lstatSync(request.idempotencyKey);
}
if (!journalLeaf.isDirectory() || journalLeaf.isSymbolicLink() || journalLeaf.uid !== expectedRoot.uid) process.exit(2);
const journalFd = openSync(request.idempotencyKey, constants.O_RDONLY | constants.O_DIRECTORY | O_NOFOLLOW);
const heldBefore = fstatSync(journalFd);
if (!heldBefore.isDirectory() || heldBefore.dev !== journalLeaf.dev || heldBefore.ino !== journalLeaf.ino || heldBefore.uid !== expectedRoot.uid) process.exit(2);
if ((heldBefore.mode & 0o7777) !== 0o700) {
  if (request.operation === "load" || request.operation === "inspect") process.exit(2);
  fchmodSync(journalFd, 0o700);
}
const captured = fstatSync(journalFd);
const capturedLeaf = lstatSync(request.idempotencyKey);
if (!sameDirectory(capturedLeaf, captured)) process.exit(2);
process.chdir(request.idempotencyKey);
const journal = statSync(".");
if (!sameDirectory(journal, captured)) process.exit(2);
if (request.expectedJournal && (journal.dev !== request.expectedJournal.dev || journal.ino !== request.expectedJournal.ino)) process.exit(3);
process.stdout.write("READY\n");
if (readSync(0, gate, 0, 1, null) !== 1 || gate[0] !== 49) process.exit(2);

const serializeCanonical = (value, depth = 0) => {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") return JSON.stringify(value);
  const indentation = "  ".repeat(depth);
  const childIndentation = "  ".repeat(depth + 1);
  if (Array.isArray(value)) return value.length === 0 ? "[]" : "[\n" + value.map(item => childIndentation + serializeCanonical(item, depth + 1)).join(",\n") + "\n" + indentation + "]";
  if (typeof value !== "object") throw new Error("invalid");
  const keys = Object.keys(value).sort();
  return keys.length === 0 ? "{}" : "{\n" + keys.map(key => childIndentation + JSON.stringify(key) + ": " + serializeCanonical(value[key], depth + 1)).join(",\n") + "\n" + indentation + "}";
};
const digest = value => createHash("sha256").update(serializeCanonical(value) + "\n").digest("hex");
const slotName = sequence => String(sequence).padStart(6, "0") + ".json";
const privateFile = (stat, nlink) => stat.isFile() && !stat.isSymbolicLink() && stat.uid === expectedRoot.uid && (stat.mode & 0o7777) === 0o600 && stat.nlink === nlink;
${STABLE_PUBLICATION_READ_WORKER_SOURCE}
let selectedDialect = request.dialect;
const validateEnvelope = (value, sequence, previous) => {
  const expectedKind = selectedDialect === "review" ? "docsfab-review-delivery-receipt-slot" : "docsfab-scm-delivery-receipt-slot";
  const expectedRecordKind = selectedDialect === "review" ? "docsfab-review-delivery-record" : "docsfab-scm-delivery-record";
  if (!value || value.schemaVersion !== 1 || value.kind !== expectedKind || value.sequence !== sequence || value.previousRecordSha256 !== previous || !value.record || value.record.kind !== expectedRecordKind || value.record.idempotencyKey !== request.idempotencyKey || !safeSha(value.record.sha256) || !safeSha(value.sha256)) throw new Error("invalid");
  const { sha256: recordDigest, ...recordBody } = value.record;
  if (recordDigest !== digest(recordBody)) throw new Error("invalid");
  const { sha256: envelopeDigest, ...envelopeBody } = value;
  if (envelopeDigest !== digest(envelopeBody)) throw new Error("invalid");
  return value;
};
const readJournal = allowEmpty => {
  const names = readdirSync(".");
  if (names.some(name => !/^\d{6}\.json$/u.test(name) && !/^\.\d{6}\.json\.[A-Za-z0-9-]+\.tmp$/u.test(name))) throw new Error("invalid");
  const slots = names.filter(name => /^\d{6}\.json$/u.test(name)).sort();
  if (slots.length === 0) { if (allowEmpty) return null; throw new Error("missing"); }
  if (request.dialect === "auto") {
    if (request.operation !== "load") throw new Error("invalid");
    const first = JSON.parse(readStablePrivateFile(slotName(0)).toString("utf8"));
    if (first?.kind === "docsfab-review-delivery-receipt-slot") selectedDialect = "review";
    else if (first?.kind === "docsfab-scm-delivery-receipt-slot") selectedDialect = undefined;
    else throw new Error("invalid");
  }
  let previous = null;
  let latest = null;
  for (let index = 0; index < slots.length; index += 1) {
    if (slots[index] !== slotName(index)) throw new Error("invalid");
    const bytes = readStablePrivateFile(slots[index]);
    const parsed = JSON.parse(bytes.toString("utf8"));
    if (!bytes.equals(Buffer.from(JSON.stringify(parsed, null, 2) + "\n"))) throw new Error("invalid");
    latest = validateEnvelope(parsed, index, previous);
    previous = latest.record.sha256;
  }
  return latest;
};
const append = envelope => {
  const destination = slotName(envelope.sequence);
  const temporary = "." + destination + "." + randomUUID() + ".tmp";
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW, 0o600);
  fchmodSync(fd, 0o600);
  writeFileSync(fd, Buffer.from(JSON.stringify(envelope, null, 2) + "\n"));
  fsyncSync(fd);
  const tempStat = fstatSync(fd);
  closeSync(fd);
  if (!privateFile(tempStat, 1)) throw new Error("invalid");
  let linked = false;
  try { linkSync(temporary, destination); linked = true; } catch (error) { if (error?.code !== "EEXIST") throw error; }
  fsyncSync(journalFd);
  if (linked) {
    const destinationStat = lstatSync(destination);
    const temporaryStat = lstatSync(temporary);
    if (!privateFile(destinationStat, 2) || !privateFile(temporaryStat, 2) || destinationStat.dev !== tempStat.dev || destinationStat.ino !== tempStat.ino) throw new Error("invalid");
  }
  unlinkSync(temporary);
  fsyncSync(journalFd);
  if (linked && !privateFile(lstatSync(destination), 1)) throw new Error("invalid");
  return linked;
};

let latest = readJournal(true);
if (request.operation === "claim" && latest === null) {
  if (!request.envelope || request.envelope.sequence !== 0 || request.envelope.previousRecordSha256 !== null) throw new Error("invalid");
  const created = append(request.envelope);
  latest = readJournal(false);
  process.stdout.write(JSON.stringify({ envelope: latest, journal: { dev: journal.dev, ino: journal.ino }, created }));
} else if (request.operation === "cas") {
  if (!latest) throw new Error("missing");
  if (latest.record.sha256 !== request.expectedSha256) {
    if (request.envelope?.record?.sha256 === latest.record.sha256) process.stdout.write(JSON.stringify({ envelope: latest, journal: { dev: journal.dev, ino: journal.ino } }));
    else process.stdout.write(JSON.stringify({ envelope: latest, journal: { dev: journal.dev, ino: journal.ino }, code: "receipt-conflict" }));
  } else {
    if (!request.envelope || request.envelope.sequence !== latest.sequence + 1 || request.envelope.previousRecordSha256 !== request.expectedSha256) throw new Error("invalid");
    append(request.envelope);
    latest = readJournal(false);
    process.stdout.write(JSON.stringify({ envelope: latest, journal: { dev: journal.dev, ino: journal.ino } }));
  }
} else {
  process.stdout.write(JSON.stringify({ envelope: latest, journal: { dev: journal.dev, ino: journal.ino }, created: false }));
}
`;
