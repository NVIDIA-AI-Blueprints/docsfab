// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `check:model-compositions` reads every candidate source from the checkout it
 * runs in. These cases run the shipped script against a repository holding
 * only the runtime files it needs, the shape of an exported public tree.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { testTimeoutMs } from "./helpers/test-timeouts.js";

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = resolve(runtimeRoot, "scripts/check-model-compositions.mjs");
const tsxLoader = import.meta.resolve("tsx");
const EXCERPT = "packages/runtime/model-compositions/sources/candidates/generation-gpt-6-sol.json";
// Each case loads the composition modules through tsx (about 3 s idle); local
// budget in ms, raised to test.ciTimeoutMs in CI.
const localCheckCaseMs = 30_000;

function withRuntimeCheckout(mutate: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "docsfab-composition-pins-"));
  try {
    for (const path of ["model-compositions", "workflows"]) {
      cpSync(resolve(runtimeRoot, path), join(root, "packages/runtime", path), {
        recursive: true,
      });
    }
    spawnSync("git", ["init", "--quiet"], { cwd: root });
    mutate(root);
    return spawnSync(process.execPath, ["--import", tsxLoader, scriptPath], {
      cwd: root,
      encoding: "utf8",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("check-model-compositions candidate sources", () => {
  it(
    "passes on a checkout that holds only the runtime package's sources",
    () => {
      const result = withRuntimeCheckout(() => {});
      expect(result.stderr).toBe("");
      expect(result.stdout).toMatch(/^Model compositions are current: /mu);
      expect(result.status).toBe(0);
    },
    testTimeoutMs(localCheckCaseMs),
  );

  it(
    "names a candidate source whose bytes no longer match its pin",
    () => {
      const result = withRuntimeCheckout((root) => appendFileSync(join(root, EXCERPT), "\n"));
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        `candidate-source-digest-stale: candidate source digest is stale: ${EXCERPT}`,
      );
    },
    testTimeoutMs(localCheckCaseMs),
  );

  it(
    "names a missing candidate source instead of failing on a raw read",
    () => {
      const result = withRuntimeCheckout((root) =>
        rmSync(join(root, dirname(EXCERPT)), { recursive: true }),
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(
        /candidate-source-missing: candidate source packages\/runtime\/model-compositions\/sources\/candidates\/generation-[a-z0-9-]+\.json does not exist/u,
      );
    },
    testTimeoutMs(localCheckCaseMs),
  );
});
