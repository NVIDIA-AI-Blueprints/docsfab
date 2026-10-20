// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  COMMENT_EXISTING_MR_PORT_REQUIRED,
  loadDefaultCommentExistingMrPort,
} from "../src/cli/comment-existing-mr-host.js";
import { executeRunRequest } from "../src/cli/run-request.js";
import type { DocsFabConfig } from "../src/config/runtime-loader.js";
import { validModelConfig } from "./helpers.js";

function stubConfig(): DocsFabConfig {
  return {
    projectRoot: "/tmp/does-not-matter",
    skillCrateDirectory: "/tmp/does-not-matter/skill-crate",
    qualityDirectory: "/tmp/does-not-matter/quality",
    qualityPackDirectory: "/tmp/does-not-matter/quality-pack",
    stateDirectory: "/tmp/docsfab-comment-mr-port-state",
    retryPolicy: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0, retryableCategories: [] },
    model: validModelConfig,
  };
}

describe("comment-existing-mr-host default port", () => {
  it("contains no gitlab-mr-note or packages/host specifiers", () => {
    const source = readFileSync(
      new URL("../src/cli/comment-existing-mr-host.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/gitlab-mr-note/u);
    expect(source).not.toMatch(/packages\/host/u);
  });

  it("fails closed instead of loading a host projector", async () => {
    await expect(loadDefaultCommentExistingMrPort("/tmp/example")).rejects.toThrow(
      COMMENT_EXISTING_MR_PORT_REQUIRED,
    );
  });

  it("rejects local --comment-mr runs without an injected port", async () => {
    await expect(
      executeRunRequest(
        {
          workflow: "review-documentation",
          repositoryPath: "/tmp/example",
          revision: "HEAD",
          allowWrite: false,
          releaseGate: false,
          verbose: false,
          json: false,
          showScan: false,
          commentMr: "88",
        },
        stubConfig(),
      ),
    ).rejects.toThrow(COMMENT_EXISTING_MR_PORT_REQUIRED);
  });
});
