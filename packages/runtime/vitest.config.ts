// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// Every Vitest entrypoint loads this config first, so the shared derived-
// generation step runs here, before anything reads a generated file.
execFileSync(
  process.execPath,
  [fileURLToPath(new URL("./scripts/ensure-derived.mjs", import.meta.url))],
  { stdio: "inherit" },
);

// Imported at run time, after the step above. The config bundler reads every
// statically known import, dynamic ones included, before any line here runs,
// so a missing generated mirror would fail the bundle and a stale one would be
// baked into it.
const timeoutsModule = new URL("./test/helpers/test-timeouts.ts", import.meta.url).href;
const { vitestDefaultTimeouts }: typeof import("./test/helpers/test-timeouts.js") = await import(
  /* @vite-ignore */ timeoutsModule
);
const limitationsModule = new URL("./src/acceptance-check-limitations.ts", import.meta.url).href;
const { acceptanceCheckExcludedFiles }: typeof import("./src/acceptance-check-limitations.js") =
  await import(/* @vite-ignore */ limitationsModule);

// The offline acceptance names the sandbox limitations it measured for its
// check phase. Say which files that leaves out, so no exclusion is silent;
// stderr keeps machine-read stdout, such as `vitest list --json`, intact.
const acceptanceCheckExclusions = acceptanceCheckExcludedFiles(process.env);
for (const limitation of acceptanceCheckExclusions) {
  process.stderr.write(
    `Acceptance check limitation: ${limitation.file} not run (${limitation.reason})\n`,
  );
}

// Every Vitest entrypoint is provider-offline by default, including direct
// `npx vitest`, changed-file loops, coverage, shuffles, and CI shards. Pi uses
// presence (not truthiness) of PI_OFFLINE to suppress startup/catalog network
// work and ambient OAuth refreshes.
process.env.PI_OFFLINE = "1";

// Host configuration is discovered from ~/.config/docsfab, so a developer who has
// run `docsfab setup` would otherwise load their own model profile into the suite
// and fail tests that assert on a stubbed profile. Pin every entrypoint to one
// empty throwaway root; suites that need their own layout still assign this
// variable themselves.
const isolatedConfigurationRoot = resolve(tmpdir(), "docsfab-vitest-configuration-root");
mkdirSync(isolatedConfigurationRoot, { recursive: true, mode: 0o700 });
process.env.DOCSFAB_CONFIG_ROOT = isolatedConfigurationRoot;

const configuredWorkers = Number.parseInt(process.env.VITEST_MAX_WORKERS ?? "", 10);
const maxWorkers =
  Number.isFinite(configuredWorkers) && configuredWorkers > 0
    ? configuredWorkers
    : process.env.CI
      ? 2
      : 4;

/**
 * Coverage floors apply only to critical seams (epic #269 / task #272).
 * Thresholds are ratchet floors from a measured baseline — not vanity globals.
 * See CONTRIBUTING.md and MR notes for the baseline numbers.
 *
 * Set DOCSFAB_COVERAGE_BASELINE=1 to report without enforcing thresholds.
 * Use that only for a documented Linux re-measure — not as the merge default
 * (`runtime:coverage` must not export it; #374 / #377).
 */
// Coverage lanes retain native V8 data but cannot enforce whole-suite floors
// independently. The final native merge clears this flag and enforces the
// canonical thresholds once across every lane's result.
const coverageThresholdsEnabled =
  process.env.DOCSFAB_COVERAGE_BASELINE !== "1" && process.env.DOCSFAB_COVERAGE_SHARD !== "1";

/**
 * Other seams: 2026-08-12 origin/main @ 25260e9 via
 * `DOCSFAB_COVERAGE_BASELINE=1 npm run test:coverage:baseline` (full suite;
 * Darwin delivery-worktree flake present).
 *
 * Measured then (lines / branches / functions / statements):
 * - workflow engine: 91.01 / 84.27 / 98.02 / 91.01
 * - harness:      82.39 / 77.25 / 97.52 / 82.39
 * - contract-kit: 95.19 / 89.44 / 100.0 / 95.19
 *
 * Delivery was 91.94 / 80.62 / 94.58 / 91.94 on that Darwin full-suite
 * run. Linux `runtime:coverage` excludes nested-git / bwrap delivery
 * suites (`test/delivery-*.test.ts` and siblings in `coverage-shards.mjs`)
 * because V8 coverage plus those files fails the job. Re-measure on that
 * job, not Darwin, before changing delivery floors (#374 / #377).
 *
 * Linux `runtime:coverage` on the runtime toolchain upgrade branch @ f8b6a41b
 * (pipeline 64538603, job 411773170, 2026-08-25, Vitest 4.1.11):
 * `src/delivery/**` lines 57.04%, statements 54.41%, functions 64.20%,
 * branches 54.46%. Floors sit ~5 pts under that Linux glob (neat integers).
 * Other seam floors still track the 2026-08-12 ratchet.
 */
const criticalSeamThresholds = {
  "src/workflow-*/**": {
    lines: 85,
    statements: 85,
    branches: 80,
    functions: 95,
  },
  "src/harness/**": {
    lines: 75,
    statements: 75,
    branches: 70,
    functions: 90,
  },
  "src/delivery/**": {
    lines: 52,
    statements: 49,
    branches: 49,
    functions: 59,
  },
  "src/contract-kit/**": {
    lines: 90,
    statements: 90,
    branches: 85,
    functions: 95,
  },
} as const;

export default defineConfig({
  test: {
    // Vitest 4.1.11 can lose coverage offsets for pending imports (#10643).
    // The version-guarded hook is inert unless V8 coverage is enabled.
    setupFiles: [
      "./test/helpers/coverage-module-offset.setup.mjs",
      "./test/helpers/private-route-fixture.setup.mjs",
    ],
    // Forks isolate git/bwrap/process-heavy suites better than threads and avoid
    // long-lived thread-pool RPC stalls after multi-minute runs.
    pool: "forks",
    maxWorkers,
    minWorkers: 1,
    // Shared runners are slower under load; keep local defaults tight. Values come
    // from config/limits.yaml (test.*). Declare a larger per-case or per-suite
    // budget through testTimeoutMs()/hookTimeoutMs() so CI never drops below
    // these defaults (#1009).
    ...vitestDefaultTimeouts(),
    // Ignore nested worktree checkouts if someone runs vitest without npm scripts.
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.docsfab/**",
      ...acceptanceCheckExclusions.map((limitation) => limitation.file),
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary", "json-summary", "html", "json"],
      reportsDirectory: "./coverage",
      // Still emit reports when a single suite fails (e.g. known Darwin
      // delivery-worktree flake); Linux CI remains the merge bar.
      reportOnFailure: true,
      // Critical seams only — do not chase a global %.
      include: ["src/workflow-*/**", "src/harness/**", "src/delivery/**", "src/contract-kit/**"],
      exclude: ["**/node_modules/**", "**/dist/**", "**/.docsfab/**", "**/*.d.ts", "**/index.ts"],
      ...(coverageThresholdsEnabled ? { thresholds: { ...criticalSeamThresholds } } : {}),
    },
  },
});
