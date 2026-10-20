// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Routine test processes admit declared configuration, never the ambient environment. */
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const hook = fileURLToPath(new URL("./ensure-derived.mjs", import.meta.url));
const NAMES_MODULE = "./offline-test-env.generated.mjs";

/** The shared generation step refused or failed, so the offline name list cannot load. */
export class OfflineTestNamesUnavailable extends Error {
  constructor(status) {
    super(
      `OFFLINE_TEST_NAMES_UNAVAILABLE: scripts/ensure-derived.mjs exited ${status} before ${NAMES_MODULE} could load; its own message above names the cause. Fix it, then run: npm --prefix packages/runtime run generate:pins`,
    );
    this.name = "OfflineTestNamesUnavailable";
    this.code = "OFFLINE_TEST_NAMES_UNAVAILABLE";
  }
}

let offlineTestNames;

/**
 * The declared offline test names. The list is a generated module, so the
 * first call runs the shared generation step in its own process and only then
 * loads it; a runner that imported it at load would fail before that step
 * could create it.
 */
export function loadOfflineTestNames() {
  if (offlineTestNames !== undefined) return offlineTestNames;
  const run = spawnSync(process.execPath, [hook], { stdio: ["ignore", "inherit", "inherit"] });
  // Handles exactly a hook process that could not start; one that ran and
  // failed or died is the status case below.
  if (run.error) throw run.error;
  if (run.status !== 0) throw new OfflineTestNamesUnavailable(run.status ?? run.signal);
  offlineTestNames = require(NAMES_MODULE).OFFLINE_TEST_NAMES;
  return offlineTestNames;
}

export function offlineTestEnvironment(base = process.env) {
  const environment = {};
  for (const name of loadOfflineTestNames()) {
    const value = base[name];
    if (typeof value === "string") environment[name] = value;
  }
  // Same provider-offline default as vitest.config.ts, applied before npx starts.
  environment.PI_OFFLINE ??= "1";
  return environment;
}

// Realpath both sides: `import.meta.url` is symlink-resolved but argv[1] is
// not, and a mismatch would exit 0 having run nothing.
const isMain =
  process.argv[1] !== undefined &&
  realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));

// Start the outer npm/check process through this entry point too. Filtering
// inside npm's child would be too late for npm's own process-title display.
if (isMain) {
  const [command, ...args] = process.argv.slice(2);
  if (!command) {
    process.stderr.write(
      "Usage: node scripts/offline-test-environment.mjs <check-command> [arguments]\n",
    );
    process.exitCode = 2;
  } else {
    const child = spawnSync(command, args, {
      env: offlineTestEnvironment(),
      stdio: "inherit",
      shell: false,
    });
    if (child.error) process.stderr.write("The offline check subprocess could not start.\n");
    process.exitCode = child.status ?? 1;
  }
}
