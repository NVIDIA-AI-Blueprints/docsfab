// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { limit } from "../src/config/limits.js";
import {
  CHECK_COMMAND_TIMEOUT_LIMIT,
  CHECK_OUTPUT_RETAINED_LIMIT,
  checkSandboxEnvironment,
  runBoundedCheckCommand,
} from "../src/workflow-execution/check-sandbox.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";

/**
 * A slow, noisy check under the declared default bounds (#1932). It drives the
 * bounded executor the Linux sandbox runs bubblewrap through, so it runs on
 * any platform. It takes 45 seconds, so it runs in the delivery isolation lane.
 */
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("check command default bounds (#1932)", () => {
  it(
    "passes a check that runs 45 s and prints 64 KiB, keeping its head and tail",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "docsfab-check-bounds-"));
      cleanups.push(() => rm(root, { recursive: true, force: true }));
      // The second 32 KiB is written by the check's own 45 s timer, so its
      // presence shows the check ran 45 s by its own clock; no wall clock here
      // can race it.
      const result = await runBoundedCheckCommand(
        process.execPath,
        [
          "-e",
          `process.stdout.write(Buffer.alloc(32768, "h"));
           setTimeout(() => process.stdout.write(Buffer.alloc(32768, "t")), 45000);`,
        ],
        {
          cwd: root,
          env: checkSandboxEnvironment(process.execPath, root),
          timeoutMs: limit(CHECK_COMMAND_TIMEOUT_LIMIT).value,
          retainedOutputBytes: limit(CHECK_OUTPUT_RETAINED_LIMIT).value,
        },
      );
      expect(result).toMatchObject({
        status: "passed",
        exitCode: 0,
        outputBytes: 65_536,
        outputOmittedBytes: 65_536 - 16_384,
      });
      expect(result).not.toHaveProperty("reason");
      expect(result.output).toBe(
        `${"h".repeat(8_192)}\n[49152 bytes of output omitted]\n${"t".repeat(8_192)}`,
      );
    },
    testTimeoutMs(150_000),
  );
});
