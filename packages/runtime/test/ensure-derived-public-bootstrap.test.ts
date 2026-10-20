// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Independent public-provider import/bootstrap/stored-key/gate proof; original NVIDIA qualification stays internal.
import { type ExecFileException, execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { LIMIT_DEFINITION_BY_NAME } from "../src/config/limits.generated.js";
import { copiedDerivedCheckout } from "./helpers/derived-checkout.js";
import { temporaryRoots } from "./helpers/temp.js";
import { TEST_TIMEOUT_LIMITS, nestedDeadlineMs, testTimeoutMs } from "./helpers/test-timeouts.js";

const roots = temporaryRoots();
const copiedCheckout = () => copiedDerivedCheckout(roots);
const LIVE_MODEL_CLEAN_CHECKOUT_TEST_MS =
  LIMIT_DEFINITION_BY_NAME[TEST_TIMEOUT_LIMITS.ciTest]!.value;
const ACCEPTANCE_GENERATED_MIRRORS = [
  "packages/runtime/src/config/limits.generated.ts",
  "packages/runtime/src/config/env-admission.generated.ts",
  "packages/runtime/src/contracts/model-output.generated.ts",
];
const LIVE_MODEL_REQUIRED_DERIVED_STEPS = "limits,env-admission,model-output";
// Execution plumbing: preserve the original child's diagnostic capacity.
const CHILD_OUTPUT_BYTES = 16 * 1024 * 1024;

interface Completed {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function childEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  // A nested Vitest must not inherit this worker's pool identity.
  for (const key of Object.keys(environment)) {
    if (key.startsWith("VITEST")) delete environment[key];
  }
  environment.VITEST_MAX_WORKERS = "1";
  return environment;
}

function run(
  command: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
  extraEnvironment: NodeJS.ProcessEnv = {},
): Promise<Completed> {
  return new Promise((resolveRun) => {
    execFile(
      command,
      args,
      {
        cwd,
        env: { ...childEnvironment(), ...extraEnvironment },
        timeout: timeoutMs,
        maxBuffer: CHILD_OUTPUT_BYTES,
        encoding: "utf8",
      },
      (error: ExecFileException | null, stdout: string, stderr: string) => {
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : null;
        resolveRun({ code, stdout, stderr });
      },
    );
  });
}

describe("public-provider bootstrap on a copied checkout", () => {
  it(
    "a public-provider bootstrap preserves the copied-checkout imports, stored key and gate argument checks",
    async () => {
      const root = await copiedCheckout();
      const runtime = join(root, "packages/runtime");
      for (const mirror of ACCEPTANCE_GENERATED_MIRRORS) {
        await rm(join(root, mirror), { force: true });
      }
      const generated = await run(
        process.execPath,
        ["scripts/ensure-derived.mjs", "--steps", LIVE_MODEL_REQUIRED_DERIVED_STEPS],
        runtime,
        nestedDeadlineMs(LIVE_MODEL_CLEAN_CHECKOUT_TEST_MS, LIVE_MODEL_CLEAN_CHECKOUT_TEST_MS),
      );
      expect({ code: generated.code, stderr: generated.stderr }).toMatchObject({ code: 0 });

      const configurationRoot = await roots.create("docsfab-live-journey-config-", {
        realpath: true,
      });
      const bootstrap = await run(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "--eval",
          'import { runSetupBootstrap } from "./src/setup/bootstrap.ts"; const result = await runSetupBootstrap({ profile: "anthropic-claude-opus-4.7-pi", purpose: "setup", environment: process.env }); console.log(result.status);',
        ],
        runtime,
        nestedDeadlineMs(LIVE_MODEL_CLEAN_CHECKOUT_TEST_MS, LIVE_MODEL_CLEAN_CHECKOUT_TEST_MS),
        { MODEL_API_KEY: "ci-test-placeholder", DOCSFAB_CONFIG_ROOT: configurationRoot },
      );
      expect({ code: bootstrap.code, stdout: bootstrap.stdout.trim() }).toEqual({
        code: 0,
        stdout: "ready",
      });

      const gate = await run(
        process.execPath,
        ["--import", "tsx", "scripts/live-journey-gate.mts"],
        runtime,
        nestedDeadlineMs(LIVE_MODEL_CLEAN_CHECKOUT_TEST_MS, LIVE_MODEL_CLEAN_CHECKOUT_TEST_MS),
        { MODEL_API_KEY: undefined, DOCSFAB_CONFIG_ROOT: configurationRoot },
      );
      // The gate loaded its import closure and read the key the bootstrap
      // stored, so it stops at its first argument check.
      expect(gate.code).toBe(1);
      expect(gate.stderr).toContain("live-journey-gate: --repo is required.");
      expect(gate.stderr).not.toContain("MODEL_API_KEY was not supplied");
    },
    testTimeoutMs(LIVE_MODEL_CLEAN_CHECKOUT_TEST_MS),
  );
});
