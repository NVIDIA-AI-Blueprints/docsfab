// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { allHeavyFiles } from "../scripts/check-ci-heavy-manifest.mjs";
import { smokeFiles } from "../scripts/vitest-ci.mjs";

const HISTORICAL_SMOKE = [
  "test/semantic-evaluation.test.ts",
  "test/release-artifact.test.ts",
  "test/cli-arguments.test.ts",
  "test/provider.test.ts",
  "test/launcher.test.ts",
  "test/json-evidence.test.ts",
] as const;

const REQUIRED_CURRENT_SURFACE = [
  "test/channels-slack-notify.test.ts",
  "test/observation-apparatus.test.ts",
  "test/operator-status-block.test.ts",
  "test/host-progress.test.ts",
  "test/product-test.test.ts",
] as const;

const FORBIDDEN_SMOKE = ["test/runner.test.ts", "test/delivery-worktree.test.ts"] as const;

describe("L0 CI smoke membership", () => {
  it("keeps the historical six plus frozen current-surface files", () => {
    expect(smokeFiles).toEqual([
      ...HISTORICAL_SMOKE,
      ...REQUIRED_CURRENT_SURFACE,
      "test/ci-smoke-membership.test.ts",
    ]);
  });

  it("excludes isolation-listed files and runner.test.ts", () => {
    const overlap = [...FORBIDDEN_SMOKE, ...allHeavyFiles()].filter((path) =>
      smokeFiles.includes(path),
    );
    expect(overlap).toEqual([]);
  });
});
