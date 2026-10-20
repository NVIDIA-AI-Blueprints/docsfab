// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  RECEIPT_HELPER_REPORT_IMPORT,
  receiptHelperFailureReportSource,
} from "../receipt-helper-exit.js";

/**
 * Lock-directory helpers shared by the lease and cleanup workers. Expects
 * `expectedRoot`, `O_NOFOLLOW`, and the fs functions in scope.
 */
export const LEASE_DIRECTORY_WORKER_SOURCE = String.raw`
const ownerTemporaryName = /^\.owner\.[a-f0-9]{64}\.tmp$/u;
// delivery.mergeRequestLeaseRecordMaxBytes, resolved by the store for each helper.
const leaseRecordMaxBytes = Number(process.env.DOCSFAB_RECEIPT_LEASE_RECORD_MAX_BYTES);
if (!Number.isSafeInteger(leaseRecordMaxBytes) || leaseRecordMaxBytes <= 0) throw new Error("invalid");
const ownerFile = stat => stat.isFile() && !stat.isSymbolicLink() && stat.uid === expectedRoot.uid && (stat.mode & 0o7777) === 0o600 && stat.nlink >= 1;
const ownerRecordStat = directory => {
  let fd;
  try { fd = openSync(directory + "/owner.json", constants.O_RDONLY | O_NOFOLLOW); }
  catch (error) { if (error?.code === "ENOENT") return undefined; throw error; }
  const stat = fstatSync(fd);
  closeSync(fd);
  if (!ownerFile(stat)) process.exit(2);
  return stat;
};
// Remove the owner record and owner temporaries from a lock directory that is
// held or proven abandoned. A temporary is either an orphan (one link) or the
// second name of the owner record, left when its helper died between linking
// and removing it. Anything else, or an owner link outside this directory, is
// not ours to delete.
const clearLockDirectory = (directory, owner, removeDirectory = true, changedOwnerCode = 2) => {
  const removable = [];
  let aliases = 0;
  for (const entry of readdirSync(directory)) {
    if (entry === "owner.json" && owner) continue;
    const candidate = lstatSync(directory + "/" + entry);
    const alias = owner !== undefined && candidate.dev === owner.dev && candidate.ino === owner.ino;
    if (!ownerTemporaryName.test(entry) || !candidate.isFile() || candidate.isSymbolicLink() ||
        candidate.uid !== expectedRoot.uid || (candidate.mode & 0o077) !== 0 ||
        candidate.nlink !== (alias ? owner.nlink : 1)) process.exit(2);
    if (alias) aliases += 1;
    removable.push(entry);
  }
  if (owner && owner.nlink !== 1 + aliases) process.exit(2);
  if (owner) removable.push("owner.json");
  // Only names checked above are removed; anything added since fails rmdir.
  for (const entry of removable) {
    if (entry === "owner.json") {
      const current = ownerRecordStat(directory);
      if (!current || current.dev !== owner.dev || current.ino !== owner.ino) process.exit(changedOwnerCode);
    }
    try { unlinkSync(directory + "/" + entry); }
    catch (error) { if (error?.code === "ENOENT" && changedOwnerCode === 3) process.exit(3); throw error; }
  }
  if (removeDirectory) rmdirSync(directory);
};
// Remove a lock name after its owner record is gone. A contender may already
// have removed the empty lock or published a complete successor under the
// name; neither leaves anything of ours. Entries added to our own lock refuse.
const removeReleasedLock = expected => {
  try { rmdirSync(lockName); return; }
  catch (error) {
    if (error?.code === "ENOENT") return;
    if (error?.code !== "ENOTEMPTY" && error?.code !== "EEXIST") throw error;
  }
  let current;
  try { current = lstatSync(lockName); }
  catch (error) { if (error?.code === "ENOENT") return; throw error; }
  if (current.dev === expected.dev && current.ino === expected.ino) process.exit(2);
};
`;

export const MERGE_REQUEST_LEASE_WORKER = String.raw`
import { constants, closeSync, fchmodSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
${RECEIPT_HELPER_REPORT_IMPORT}
// An unexpected filesystem error leaves the lock state unknown: refuse as a
// lock-integrity failure (exit 2) and name the error.
${receiptHelperFailureReportSource(2)}

const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const expectedRoot = JSON.parse(process.env.DOCSFAB_RECEIPT_ROOT_IDENTITY ?? "null");
const key = process.env.DOCSFAB_RECEIPT_IDEMPOTENCY_KEY ?? "";
const leaseId = process.env.DOCSFAB_RECEIPT_LEASE_ID ?? "";
const publisherPid = Number(process.env.DOCSFAB_RECEIPT_PUBLISHER_PID);
const safeSha = value => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const sameDirectory = (actual, expected) => actual.isDirectory() && actual.dev === expected.dev && actual.ino === expected.ino && actual.uid === expected.uid && (actual.mode & 0o7777) === (expected.mode & 0o7777);
const root = statSync(".");
if (!expectedRoot || !sameDirectory(root, expectedRoot) || !safeSha(key) || !safeSha(leaseId) ||
    !Number.isSafeInteger(publisherPid) || publisherPid <= 0) process.exit(2);
const lockName = "." + key + ".merge-request.lock";
const ownerName = lockName + "/owner.json";
// The owner record is written under a private name and then hard-linked to
// owner.json. The link refuses an existing owner, so a contender sees no
// owner.json or a complete one, and a helper that lost the lock can never
// replace the current holder's record.
const ownerTemporary = ".owner." + leaseId + ".tmp";
const privateDirectory = stat => stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === expectedRoot.uid && (stat.mode & 0o7777) === 0o700;
const privateFile = (stat, links = 1) => stat.isFile() && !stat.isSymbolicLink() && stat.uid === expectedRoot.uid && (stat.mode & 0o7777) === 0o600 && stat.nlink === links;
${LEASE_DIRECTORY_WORKER_SOURCE}
const removeExact = (name, expected, expectedOwner) => {
  let leaf;
  try { leaf = lstatSync(name); }
  catch (error) { if (error?.code === "ENOENT") process.exit(3); throw error; }
  if (!privateDirectory(leaf)) process.exit(2);
  if (leaf.dev !== expected.dev || leaf.ino !== expected.ino) process.exit(3);
  process.chdir(name);
  if (!sameDirectory(statSync(".."), expectedRoot)) process.exit(2);
  if (!sameDirectory(statSync("."), expected)) process.exit(3);
  const current = ownerRecordStat(".");
  if (!current || current.dev !== expectedOwner.dev || current.ino !== expectedOwner.ino) process.exit(3);
  // Never rename the canonical lock after a dead-owner observation. All
  // unlinks stay in the observed directory; a successor keeps its pathname.
  clearLockDirectory(".", current, false, 3);
  process.chdir("..");
  try { leaf = lstatSync(name); }
  catch (error) { if (error?.code === "ENOENT") process.exit(3); throw error; }
  if (!privateDirectory(leaf)) process.exit(2);
  if (leaf.dev !== expected.dev || leaf.ino !== expected.ino) process.exit(3);
  try { rmdirSync(name); }
  catch (error) {
    if (error?.code === "ENOENT") process.exit(3);
    if ((error?.code === "ENOTEMPTY" || error?.code === "EEXIST") && ownerRecordStat(name)) process.exit(3);
    throw error;
  }
};
// Build one complete generation privately. No helper initializes an owner
// inside an existing canonical lock directory, including after a stale pause.
const rootPath = process.cwd();
const candidateName = lockName + ".candidate-" + leaseId + "-" + process.pid;
const candidatePath = rootPath + "/" + candidateName;
mkdirSync(candidateName, { mode: 0o700 });
const lockFd = openSync(candidateName, constants.O_RDONLY | constants.O_DIRECTORY | O_NOFOLLOW);
fchmodSync(lockFd, 0o700);
const held = fstatSync(lockFd);
const candidateLeaf = lstatSync(candidateName);
if (!privateDirectory(held) || !privateDirectory(candidateLeaf) || held.dev !== candidateLeaf.dev || held.ino !== candidateLeaf.ino) process.exit(2);
process.chdir(candidateName);
const assertCandidate = () => {
  if (!sameDirectory(statSync("."), held) || !sameDirectory(statSync(".."), expectedRoot) ||
      !sameDirectory(lstatSync("../" + candidateName), held)) process.exit(2);
};
assertCandidate();
const ownerFd = openSync(ownerTemporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW, 0o600);
fchmodSync(ownerFd, 0o600);
writeFileSync(ownerFd, JSON.stringify({ schemaVersion: 1, key, leaseId, pid: publisherPid }) + "\n");
fsyncSync(ownerFd);
const ownerRecord = fstatSync(ownerFd);
if (!privateFile(ownerRecord) || ownerRecord.size > leaseRecordMaxBytes) process.exit(2);
closeSync(ownerFd);
assertCandidate();
linkSync(ownerTemporary, "owner.json");
const sameInode = (actual, expected) => actual.dev === expected.dev && actual.ino === expected.ino;
const ownerPublished = lstatSync("owner.json");
if (!privateFile(ownerPublished, 2) || !sameInode(ownerPublished, ownerRecord)) process.exit(2);
unlinkSync(ownerTemporary);
const finalOwner = lstatSync("owner.json");
if (!privateFile(finalOwner) || !sameInode(finalOwner, ownerRecord)) process.exit(2);
fsyncSync(lockFd);
assertCandidate();
process.chdir("..");
let published = false;
// Ordinary refusals remove only this helper's fully initialized candidate.
// SIGKILL can leave a private orphan; it never occupies the canonical name.
process.once("exit", () => {
  if (published) return;
  try {
    if (!sameDirectory(statSync(rootPath), expectedRoot)) throw new Error("root changed");
    const leaf = lstatSync(candidatePath);
    const owner = ownerRecordStat(candidatePath);
    if (!privateDirectory(leaf) || !sameInode(leaf, held) || !owner || !sameInode(owner, ownerRecord)) throw new Error("candidate changed");
    clearLockDirectory(candidatePath, owner);
  } catch { process.exitCode = 2; }
});
const publishCandidate = () => {
  if (!sameDirectory(statSync("."), expectedRoot)) process.exit(2);
  const candidate = lstatSync(candidateName);
  if (!privateDirectory(candidate) || !sameInode(candidate, held)) process.exit(2);
  // Inspect legacy empty or malformed locks through the ordinary refusal and
  // stale-recovery path; never replace one merely because it is empty.
  try { lstatSync(lockName); return false; }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  try { renameSync(candidateName, lockName); }
  catch (error) { if (error?.code === "ENOTEMPTY" || error?.code === "EEXIST") return false; throw error; }
  published = true;
  return true;
};
if (!publishCandidate()) {
  let existing;
  try { existing = lstatSync(lockName); }
  catch (released) {
    // A publisher can finish between our failed mkdir and this inspection.
    // Re-enter normal acquisition; all root/owner checks still run there.
    if (released?.code === "ENOENT") process.exit(3);
    throw released;
  }
  if (!privateDirectory(existing)) process.exit(2);
  // Hold the inspected lock directory open through recovery as well as its
  // owner record, so neither inode number can be reused by a successor while
  // an identity comparison below depends on it. The OS releases it on exit.
  let existingFd;
  try { existingFd = openSync(lockName, constants.O_RDONLY | constants.O_DIRECTORY | O_NOFOLLOW); }
  catch (released) { if (released?.code === "ENOENT") process.exit(3); throw released; }
  if (!sameInode(fstatSync(existingFd), existing)) process.exit(3);
  let owner;
  let observedOwner;
  let observedOwnerFd;
  let missingOwner = false;
  try {
    // Keep the observed inode alive through recovery even if another reaper
    // unlinks its name while this helper is paused. A refusal exits the worker
    // and the OS releases the descriptor; successful recovery closes it below.
    observedOwnerFd = openSync(ownerName, constants.O_RDONLY | O_NOFOLLOW);
    observedOwner = fstatSync(observedOwnerFd);
    if (!ownerFile(observedOwner) || observedOwner.size > leaseRecordMaxBytes) process.exit(2);
    const ownerBytes = readFileSync(observedOwnerFd);
    if (ownerBytes.byteLength > leaseRecordMaxBytes) process.exit(2);
    owner = JSON.parse(ownerBytes.toString("utf8"));
  } catch (ownerError) {
    if (ownerError?.code !== "ENOENT") process.exit(2);
    // A canonical lock is published complete, so one without an owner record
    // is being released, or was left by the protocol before issue 1166. Its
    // recovery below is safe at any age: it removes only orphan temporaries,
    // and rmdir refuses once any owner is present.
    missingOwner = true;
  }
  if (!missingOwner) {
    if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || !safeSha(owner.key) ||
        owner.key !== key || !safeSha(owner.leaseId)) process.exit(2);
    let alive = true;
    try { process.kill(owner.pid, 0); } catch (probe) { if (probe?.code === "ESRCH") alive = false; }
    // Name the recorded holder so a lease that stays held can be diagnosed.
    if (alive) { writeSync(2, "DOCSFAB_LEASE_HELD " + owner.pid + "\n"); process.exit(3); }
  }
  if (missingOwner) {
    let stale;
    try { stale = lstatSync(lockName); }
    catch (error) { if (error?.code === "ENOENT") process.exit(3); throw error; }
    if (!privateDirectory(stale)) process.exit(2);
    if (stale.dev !== existing.dev || stale.ino !== existing.ino) process.exit(3);
    const removable = [];
    let entries;
    try { entries = readdirSync(lockName); }
    catch (error) { if (error?.code === "ENOENT") process.exit(3); throw error; }
    for (const entry of entries) {
      // Publication may have completed since the missing-owner observation.
      if (entry === "owner.json") process.exit(3);
      let candidate;
      try { candidate = lstatSync(lockName + "/" + entry); }
      catch (error) { if (error?.code === "ENOENT") process.exit(3); throw error; }
      if (!ownerTemporaryName.test(entry) || !candidate.isFile() || candidate.isSymbolicLink() ||
          candidate.uid !== expectedRoot.uid || (candidate.mode & 0o077) !== 0 || candidate.nlink !== 1) process.exit(2);
      removable.push(entry);
    }
    for (const entry of removable) {
      try { unlinkSync(lockName + "/" + entry); }
      catch (error) { if (error?.code !== "ENOENT") throw error; }
    }
    // Never rename a missing-owner lock: its publisher may now be active.
    // rmdir atomically refuses once a final owner is present.
    try { rmdirSync(lockName); }
    catch (error) {
      if (error?.code === "ENOENT") process.exit(3);
      if (error?.code === "ENOTEMPTY" || error?.code === "EEXIST") {
        try { lstatSync(ownerName); process.exit(3); }
        catch (ownerError) { if (ownerError?.code !== "ENOENT") throw ownerError; }
      }
      throw error;
    }
  } else {
    try { removeExact(lockName, existing, observedOwner); }
    finally { closeSync(observedOwnerFd); }
  }
  // A complete successor may already occupy the canonical name.
  if (!publishCandidate()) process.exit(3);
}
// Published. If the lock already left its name (moved away, or moved away and
// replaced), this helper lost it: retry (exit 3) without READY. That is not a
// lock-integrity failure, and the record left in the moved directory no
// longer names the lock.
let publishedLeaf;
try { publishedLeaf = lstatSync(lockName); }
catch (error) { if (error?.code === "ENOENT") process.exit(3); throw error; }
if (!privateDirectory(publishedLeaf)) process.exit(2);
if (!sameInode(publishedLeaf, held)) process.exit(3);
try { process.chdir(lockName); }
catch (error) { if (error?.code === "ENOENT") process.exit(3); throw error; }
if (!sameInode(statSync("."), held)) process.exit(3);
const assertHeld = (lostCode = 3) => {
  if (!sameDirectory(statSync("."), held) || !sameDirectory(statSync(".."), expectedRoot)) process.exit(2);
  let current;
  try { current = lstatSync("../" + lockName); }
  catch (error) { if (error?.code === "ENOENT") process.exit(lostCode); throw error; }
  if (!privateDirectory(current)) process.exit(2);
  if (!sameInode(current, held)) process.exit(lostCode);
};
assertHeld();
const claimedOwner = ownerRecordStat(".");
if (!claimedOwner || !sameInode(claimedOwner, ownerRecord)) process.exit(2);
fsyncSync(lockFd);
const publicationRootFd = openSync("..", constants.O_RDONLY | constants.O_DIRECTORY | O_NOFOLLOW);
fsyncSync(publicationRootFd);
closeSync(publicationRootFd);
process.stdout.write("READY " + JSON.stringify({ dev: held.dev, ino: held.ino }) + "\n");
const gate = Buffer.alloc(1);
readSync(0, gate, 0, 1, null);
assertHeld(2);
const releasedOwner = ownerRecordStat(".");
if (!releasedOwner || !sameInode(releasedOwner, ownerRecord)) process.exit(2);
clearLockDirectory(".", releasedOwner, false);
process.chdir("..");
if (!sameDirectory(statSync("."), expectedRoot)) process.exit(2);
removeReleasedLock(held);
const rootFd = openSync(".", constants.O_RDONLY | constants.O_DIRECTORY | O_NOFOLLOW);
fsyncSync(rootFd);
closeSync(rootFd);
closeSync(lockFd);
`;

export const MERGE_REQUEST_LEASE_CLEANUP_WORKER = String.raw`
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, rmdirSync, statSync, unlinkSync } from "node:fs";
${RECEIPT_HELPER_REPORT_IMPORT}
${receiptHelperFailureReportSource(2)}

const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const expectedRoot = JSON.parse(process.env.DOCSFAB_RECEIPT_ROOT_IDENTITY ?? "null");
const expectedLock = JSON.parse(process.env.DOCSFAB_RECEIPT_LOCK_IDENTITY ?? "null");
const key = process.env.DOCSFAB_RECEIPT_IDEMPOTENCY_KEY ?? "";
const leaseId = process.env.DOCSFAB_RECEIPT_LEASE_ID ?? "";
const publisherPid = Number(process.env.DOCSFAB_RECEIPT_PUBLISHER_PID);
const safeSha = value => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const sameDirectory = (actual, expected) => actual.isDirectory() && actual.dev === expected.dev && actual.ino === expected.ino && actual.uid === expected.uid && (actual.mode & 0o7777) === (expected.mode & 0o7777);
const privateDirectory = stat => stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === expectedRoot.uid && (stat.mode & 0o7777) === 0o700;
${LEASE_DIRECTORY_WORKER_SOURCE}
const root = statSync(".");
if (!expectedRoot || !sameDirectory(root, expectedRoot) || !expectedLock ||
    !Number.isSafeInteger(expectedLock.dev) || !Number.isSafeInteger(expectedLock.ino) ||
    !safeSha(key) || !safeSha(leaseId) || !Number.isSafeInteger(publisherPid) || publisherPid <= 0) process.exit(2);
const lockName = "." + key + ".merge-request.lock";
const ownerName = lockName + "/owner.json";
// The lease helper died after READY. Its lock left the name only if that
// helper's own release already cleared it; nothing of ours remains then.
let leaf;
try { leaf = lstatSync(lockName); }
catch (error) { if (error?.code === "ENOENT") process.exit(0); throw error; }
if (!privateDirectory(leaf)) process.exit(2);
if (leaf.dev !== expectedLock.dev || leaf.ino !== expectedLock.ino) process.exit(0);
const lockFd = openSync(lockName, constants.O_RDONLY | constants.O_DIRECTORY | O_NOFOLLOW);
const held = fstatSync(lockFd);
if (!privateDirectory(held) || held.dev !== leaf.dev || held.ino !== leaf.ino) process.exit(2);
let ownerStat;
try {
  const ownerFd = openSync(ownerName, constants.O_RDONLY | O_NOFOLLOW);
  ownerStat = fstatSync(ownerFd);
  if (!ownerFile(ownerStat) || ownerStat.size > leaseRecordMaxBytes) process.exit(2);
  const ownerBytes = readFileSync(ownerFd);
  closeSync(ownerFd);
  if (ownerBytes.byteLength > leaseRecordMaxBytes) process.exit(2);
  const owner = JSON.parse(ownerBytes.toString("utf8"));
  if (!owner || owner.schemaVersion !== 1 || owner.key !== key || owner.leaseId !== leaseId ||
      owner.pid !== publisherPid) process.exit(2);
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
  ownerStat = undefined;
}
const finalLeaf = lstatSync(lockName);
if (!privateDirectory(finalLeaf) || finalLeaf.dev !== held.dev || finalLeaf.ino !== held.ino) process.exit(2);
clearLockDirectory(lockName, ownerStat, false);
removeReleasedLock(held);
const rootFd = openSync(".", constants.O_RDONLY | constants.O_DIRECTORY | O_NOFOLLOW);
fsyncSync(rootFd);
closeSync(rootFd);
closeSync(lockFd);
`;
