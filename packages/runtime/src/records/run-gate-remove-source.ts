// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Isolated, descriptor-pinned removal of one observed run-gate generation. */
export const RUN_GATE_REMOVE_WORKER = String.raw`
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, readdirSync, rmdirSync, statSync, unlinkSync } from "node:fs";

const input = JSON.parse(process.env.DOCSFAB_RUN_GATE_REMOVE ?? "null");
const same = (left, right) => left.dev === right.dev && left.ino === right.ino;
const rootShape = stat => stat.isDirectory() && !stat.isSymbolicLink() &&
  stat.dev === input.root.dev && stat.ino === input.root.ino &&
  stat.uid === input.root.uid && (stat.mode & 0o7777) === input.root.mode;
const privateDirectory = stat => stat.isDirectory() && !stat.isSymbolicLink() &&
  stat.uid === input.root.uid && (stat.mode & 0o7777) === 0o700;
const privateFile = stat => stat.isFile() && !stat.isSymbolicLink() &&
  stat.uid === input.root.uid && (stat.mode & 0o7777) === 0o600 && stat.nlink === 1;
// The bound follows the exact two-field owner schema, including the largest
// safe PID and a v4 UUID; it is not an operator-tunable corpus limit.
const ownerMaximum = Buffer.byteLength(JSON.stringify({
  pid: Number.MAX_SAFE_INTEGER, token: "00000000-0000-4000-8000-000000000000"
}));
const ownerShape = value => value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).length === 2 && Object.hasOwn(value, "pid") && Object.hasOwn(value, "token") &&
  Number.isSafeInteger(value.pid) && value.pid > 0 &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value.token);
const readOwner = fd => {
  const stat = fstatSync(fd);
  if (!privateFile(stat) || stat.size > ownerMaximum) process.exit(2);
  const buffer = Buffer.alloc(ownerMaximum + 1);
  const length = readSync(fd, buffer, 0, buffer.length, 0);
  if (length !== stat.size || length > ownerMaximum) process.exit(2);
  const bytes = buffer.subarray(0, length).toString("utf8");
  let value;
  try { value = JSON.parse(bytes); } catch { process.exit(2); }
  if (!ownerShape(value) || JSON.stringify(value) !== bytes) process.exit(2);
  return { stat, bytes, value };
};
const dead = pid => {
  try { process.kill(pid, 0); return false; }
  catch (error) {
    if (error?.code === "ESRCH") return true;
    if (error?.code === "EPERM") return false;
    process.exit(2);
  }
};

try {
  if (!input || !["recover", "release"].includes(input.operation) ||
      typeof input.name !== "string" ||
      !/^\.docsfab-run-(?:maintenance|active-[a-f0-9]{64})\.lock$/u.test(input.name) ||
      !input.root || !input.gate || !input.owner ||
      !Number.isSafeInteger(input.root.dev) || !Number.isSafeInteger(input.root.ino) ||
      !Number.isSafeInteger(input.root.uid) || !Number.isSafeInteger(input.root.mode) ||
      !Number.isSafeInteger(input.gate.dev) || !Number.isSafeInteger(input.gate.ino) ||
      !Number.isSafeInteger(input.owner.dev) || !Number.isSafeInteger(input.owner.ino) ||
      !Number.isSafeInteger(input.pid) || input.pid <= 0 ||
      typeof input.token !== "string") process.exit(2);
  if (typeof process.getuid === "function" && input.root.uid !== process.getuid()) process.exit(2);
  if (!rootShape(statSync("."))) process.exit(2);
  const leaf = lstatSync(input.name);
  if (!privateDirectory(leaf) || !same(leaf, input.gate)) process.exit(3);
  // Keep both inodes alive so a removed predecessor cannot be recycled while
  // comparisons are in progress. All owner unlinks below use this old cwd.
  const directoryFd = openSync(input.name, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const held = fstatSync(directoryFd);
  if (!privateDirectory(held) || !same(held, leaf)) process.exit(3);
  const ownerFd = openSync(input.name + "/owner.json", constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const observed = readOwner(ownerFd);
  if (!same(observed.stat, input.owner) || observed.value.pid !== input.pid ||
      observed.value.token !== input.token) process.exit(3);
  if (input.operation === "recover" && !dead(observed.value.pid)) process.exit(3);
  process.chdir(input.name);
  if (!same(statSync("."), held) || !rootShape(statSync(".."))) process.exit(2);
  const named = lstatSync("../" + input.name);
  if (!privateDirectory(named) || !same(named, held)) process.exit(3);
  const current = lstatSync("owner.json");
  if (!privateFile(current) || !same(current, observed.stat)) process.exit(3);
  const reread = readOwner(ownerFd);
  if (reread.bytes !== observed.bytes || !same(reread.stat, observed.stat)) process.exit(3);
  const entries = readdirSync(".");
  if (entries.length !== 1 || entries[0] !== "owner.json") process.exit(2);
  if (input.operation === "recover" && !dead(observed.value.pid)) process.exit(3);
  // Only the successful unlink winner may try rmdir. Missing or changed owner
  // losers stop here, before any successor can be removed.
  try { unlinkSync("owner.json"); }
  catch (error) { if (error?.code === "ENOENT") process.exit(3); throw error; }
  process.chdir("..");
  if (!rootShape(statSync("."))) process.exit(2);
  let final;
  try { final = lstatSync(input.name); }
  catch (error) { if (error?.code === "ENOENT") process.exit(3); throw error; }
  if (!privateDirectory(final) || !same(final, held)) process.exit(3);
  try { rmdirSync(input.name); }
  catch (error) {
    if (["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error?.code)) process.exit(3);
    throw error;
  }
  closeSync(ownerFd);
  closeSync(directoryFd);
  process.exit(0);
} catch { process.exit(2); }
`;
