// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Preload before an installed command. Configuration writes need fchmod, which
// Node's permission model disables; these observers keep that setup phase offline.
import assert from "node:assert/strict";
import { syncBuiltinESMExports } from "node:module";

export const outboundAttempts = [];
const initialExitCode = process.exitCode;
const deny = (name) => () => {
  outboundAttempts.push(name);
  process.exitCode = 1;
  throw new Error(`Offline package qualification denied ${name}`);
};

globalThis.fetch = deny("fetch");
for (const [name, methods] of [
  ["http", ["request", "get"]],
  ["https", ["request", "get"]],
  ["http2", ["connect"]],
  ["net", ["connect", "createConnection"]],
  ["tls", ["connect"]],
  ["dns", ["lookup", "resolve", "resolve4", "resolve6"]],
  ["dns/promises", ["lookup", "resolve", "resolve4", "resolve6"]],
  ["child_process", ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]],
]) {
  const module = (await import(`node:${name}`)).default;
  for (const method of methods) module[method] = deny(`${name}.${method}`);
}
const net = (await import("node:net")).default;
net.Socket.prototype.connect = deny("net.Socket.connect");
(await import("node:dgram")).default.Socket.prototype.send = deny("dgram.Socket.send");
const workers = (await import("node:worker_threads")).default;
workers.Worker = class {
  constructor() {
    deny("worker_threads.Worker")();
  }
};
syncBuiltinESMExports();

const childProcess = (await import("node:child_process")).default;
assert.throws(() => globalThis.fetch("https://network-control.invalid"), /qualification denied/u);
assert.throws(() => net.connect({ host: "network-control.invalid" }), /qualification denied/u);
assert.throws(() => childProcess.spawn(), /qualification denied/u);
assert.throws(() => new workers.Worker(""), /qualification denied/u);
assert.deepEqual(outboundAttempts, [
  "fetch",
  "net.connect",
  "child_process.spawn",
  "worker_threads.Worker",
]);
outboundAttempts.length = 0;
process.exitCode = initialExitCode;

// A product catch must not turn a forbidden request into a passing command.
process.on("exit", () => {
  if (outboundAttempts.length === 0) return;
  process.stderr.write(`Offline package qualification observed: ${outboundAttempts.join(", ")}\n`);
  process.exitCode = 1;
});
