#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Fail closed when the local/CI environment cannot run isolation suites.
 * Usage: node scripts/ci-env-check.mjs
 */
import { accessSync, constants, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

function fail(message) {
  console.error(`ci-env-check: ${message}`);
  process.exit(1);
}

function commandVersion(command, args = ["--version"]) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    fail(`required command not runnable: ${command}`);
  }
  return (result.stdout || result.stderr || "").trim().split("\n")[0] ?? command;
}

const nodeVersion = process.version;
const rg = commandVersion("rg");
const bwrap = process.platform === "linux" ? commandVersion("bwrap") : "(skipped: non-linux)";

const trusted = process.env.DOCSFAB_TEST_TRUSTED_ROOT || process.env.TMPDIR || tmpdir();
try {
  accessSync(trusted, constants.W_OK);
} catch {
  fail(`trusted temp root is not writable: ${trusted}`);
}

const probe = mkdtempSync(join(trusted, "docsfab-ci-env-"));
try {
  writeFileSync(join(probe, "probe"), "ok\n");
} finally {
  rmSync(probe, { recursive: true, force: true });
}

console.log(
  JSON.stringify(
    {
      schemaVersion: 1,
      node: nodeVersion,
      rg,
      bwrap,
      trustedRoot: trusted,
      piOffline: process.env.PI_OFFLINE ?? null,
      commitSha: process.env.CI_COMMIT_SHA ?? null,
      jobName: process.env.CI_JOB_NAME ?? null,
      jobImage: process.env.CI_JOB_IMAGE ?? null,
    },
    null,
    2,
  ),
);
