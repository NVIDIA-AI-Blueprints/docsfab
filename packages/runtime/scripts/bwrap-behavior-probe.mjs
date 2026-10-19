#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Prove the minimum bwrap behavior DocsFab's Linux publisher depends on.
 * This is deliberately a local operator probe, not a claim that Docker is a
 * production-grade sandbox.
 */
import { accessSync, constants, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

function fail(message) {
  console.error(`bwrap-behavior-probe: ${message}`);
  process.exit(1);
}

const script = [
  "const fs=require('node:fs'),net=require('node:net');",
  "const scratch=process.argv[1];",
  "const hostTmpSentinel=process.argv[2];",
  "let outsideWriteDenied=false;",
  "try{fs.writeFileSync('/etc/docsfab-bwrap-probe','x')}catch{outsideWriteDenied=true}",
  "if(!outsideWriteDenied)process.exit(11);",
  "if(fs.existsSync(hostTmpSentinel))process.exit(15);",
  "fs.writeFileSync(`${scratch}/allowed-write`,'ok');",
  // bwrap may remain PID 1 while Node becomes PID 2, but either proves this
  // process is in the newly-created, small PID namespace.
  "if(process.pid>2)process.exit(12);",
  "const socket=net.connect({host:'1.1.1.1',port:53});",
  "socket.once('connect',()=>process.exit(13));",
  "socket.once('error',()=>process.exit(0));",
  "setTimeout(()=>process.exit(14),1500);",
].join("");

export function buildBwrapArguments(scratch, hostTmpSentinel) {
  return [
    "--unshare-net",
    "--unshare-pid",
    "--die-with-parent",
    "--new-session",
    "--ro-bind",
    "/",
    "/",
    // Later bwrap mounts shadow earlier mounts. Create the isolated /tmp
    // first, then make the one allowed scratch directory reachable inside it.
    "--tmpfs",
    "/tmp",
    "--bind",
    scratch,
    scratch,
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--",
    process.execPath,
    "-e",
    script,
    scratch,
    hostTmpSentinel,
  ];
}

function main() {
  if (process.platform !== "linux") {
    console.log(
      JSON.stringify({ schemaVersion: 1, bwrap: "skipped", reason: "linux-only" }, null, 2),
    );
    return;
  }
  const trustedRoot = process.env.DOCSFAB_TEST_TRUSTED_ROOT || process.env.TMPDIR || tmpdir();
  try {
    accessSync(trustedRoot, constants.W_OK);
  } catch {
    fail(`trusted temp root is not writable: ${trustedRoot}`);
  }

  const scratch = mkdtempSync(join(trustedRoot, "docsfab-bwrap-probe-"));
  let hostTmpSentinel;
  let failureMessage;
  try {
    hostTmpSentinel = mkdtempSync("/tmp/docsfab-bwrap-host-tmp-");
    const result = spawnSync("/usr/bin/bwrap", buildBwrapArguments(scratch, hostTmpSentinel), {
      encoding: "utf8",
      timeout: 5_000,
    });
    if (result.error) failureMessage = `bwrap did not run: ${result.error.message}`;
    else if (result.status !== 0)
      failureMessage =
        `isolation behavior failed (exit ${result.status ?? "unknown"}): ` +
        (result.stderr || result.stdout).trim();
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    if (hostTmpSentinel) rmSync(hostTmpSentinel, { recursive: true, force: true });
  }
  if (failureMessage) fail(failureMessage);
  console.log(JSON.stringify({ schemaVersion: 1, bwrap: "passed", trustedRoot }, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
