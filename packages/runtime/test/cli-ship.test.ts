// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { EmptyPublishableWriteError } from "../src/autonomy/managed-publish-host.js";
import { handleShipCommand } from "../src/cli/commands/ship.js";
import { usage } from "../src/cli/usage.js";
import type { VerifiedPublicationRun } from "../src/delivery/index.js";

const verifiedRun: VerifiedPublicationRun = {
  id: "run-1",
  workflow: "update-documentation",
  workflowOutcome: "Update documentation.",
  recordSha256: "a".repeat(64),
  sourcePath: "/product",
  revision: "b".repeat(40),
  patch: {
    sha256: "c".repeat(64),
    byteLength: 12,
    lineCount: 1,
    artifactPath: "/private/patch.diff",
    format: "git-diff",
  },
  patchBytes: Buffer.from("patch"),
  changedFiles: [{ path: "docs/guide.md", status: "modified" }],
  changedFileCount: 1,
  taskLineage: null,
};

describe("docsfab ship", () => {
  it("mints the write and draft-MR envelope then reports the opened draft MR", async () => {
    const log = vi.fn();
    const submit = vi.fn(async (_run: unknown, envelope: unknown, _context: unknown) => {
      expect(envelope).toMatchObject({ runId: "run-1", write: true, publish: "draft-mr" });
      return {
        mergeRequest: {
          iid: 12,
          url: "https://gitlab.example/mr/12",
          draft: true as const,
          headRevision: "d".repeat(40),
        },
      };
    });
    await handleShipCommand(["run-1", "--repo", "."], {
      cwd: "/product",
      stateDirectory: "/state/runs",
      log,
      loadRun: vi.fn(async () => verifiedRun),
      submit,
    });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith("Draft merge request: https://gitlab.example/mr/12");
  });

  it("keeps --dry-run read-only and prints a human plan summary", async () => {
    const log = vi.fn();
    const submit = vi.fn();
    await handleShipCommand(["run-1", "--repo", ".", "--dry-run"], {
      cwd: "/product",
      stateDirectory: "/state/runs",
      log,
      loadRun: vi.fn(async () => verifiedRun),
      preflight: vi.fn(async () => ({ targetBranch: { name: "main" } }) as never),
      submit,
    });
    expect(submit).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("would open a draft merge request to main"),
    );
  });

  it("preserves the typed empty-patch refusal", async () => {
    const refusal = new EmptyPublishableWriteError();
    await expect(
      handleShipCommand(["run-1", "--repo", "."], {
        cwd: "/product",
        stateDirectory: "/state/runs",
        log: () => undefined,
        loadRun: vi.fn(async () => verifiedRun),
        submit: vi.fn(async () => {
          throw refusal;
        }),
      }),
    ).rejects.toBe(refusal);
  });

  it("requires a run id and repository path", async () => {
    const dependencies = { cwd: "/product", stateDirectory: "/state/runs", log: () => undefined };
    await expect(handleShipCommand(["run-1"], dependencies)).rejects.toThrow(
      "requires an explicit --repo",
    );
    await expect(handleShipCommand(["--repo", "."], dependencies)).rejects.toThrow(
      "requires a succeeded write run id",
    );
  });

  it("documents the run-id ship path", () => {
    expect(usage()).toContain("docsfab ship <run-id> --repo <path> [--dry-run]");
  });
});
