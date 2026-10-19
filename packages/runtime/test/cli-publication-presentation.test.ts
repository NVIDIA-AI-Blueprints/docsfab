// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { handleShipCommand } from "../src/cli/commands/ship.js";
import { runLocalUserPublishCli } from "../src/delivery/cli.js";
import type { VerifiedPublicationRun } from "../src/delivery/index.js";
import { PublicationResultContractError } from "../src/delivery/publication-result.js";
import { LocalUserGitLabPublisherError } from "../src/delivery/publisher.js";
import { shipSucceededWrite } from "../src/operator/delivery-orchestrator.js";

const mergeRequest = {
  iid: 12,
  url: "https://gitlab.example/group/project/-/merge_requests/12",
  draft: true as const,
  headRevision: "d".repeat(40),
};

const verifiedRun: VerifiedPublicationRun = {
  id: "run-1",
  workflow: "update-documentation",
  workflowOutcome: "Update the guide.",
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

function published(targetBranch = "main", url = mergeRequest.url) {
  return {
    mergeRequest,
    publicationResult: {
      schemaVersion: 1,
      kind: "docsfab-local-user-gitlab-publication-result",
      status: "opened",
      planSha256: "1".repeat(64),
      idempotencyKey: "2".repeat(64),
      receiptSha256: "3".repeat(64),
      state: "opened",
      disposition: "succeeded",
      sourceBranch: "docsfab/run-1",
      targetBranch,
      commitRevision: mergeRequest.headRevision,
      mergeRequest: { ...mergeRequest, url },
    },
  } as const;
}

describe("ship and one-shot publication presentation", () => {
  it("waits for typed publication settlement before printing final success", async () => {
    const log = vi.fn();
    let settle!: () => void;
    const gate = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const submit = vi.fn(async () => {
      await gate;
      return published();
    });

    const operation = handleShipCommand(["run-1", "--repo", "/product"], {
      cwd: "/product",
      stateDirectory: "/private/runs",
      log,
      loadRun: async () => verifiedRun,
      submit,
    });
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    expect(log).not.toHaveBeenCalledWith(`Draft merge request: ${mergeRequest.url}`);
    settle();
    await operation;
    expect(log).toHaveBeenCalledWith(`Draft merge request: ${mergeRequest.url}`);
  });

  it.each([
    { targetBranch: "release", url: mergeRequest.url },
    { targetBranch: "main", url: "https://gitlab.example/group/project/-/merge_requests/13" },
  ])("refuses mismatched typed target or URL without claiming success", async (mismatch) => {
    const log = vi.fn();
    await expect(
      shipSucceededWrite(
        {
          runId: "run-1",
          repositoryPath: "/product",
          stateDirectory: "/private/runs",
          cwd: "/product",
          dryRun: false,
          targetBranch: "main",
        },
        {
          log,
          loadRun: async () => verifiedRun,
          submit: async () => published(mismatch.targetBranch, mismatch.url),
        },
      ),
    ).rejects.toBeInstanceOf(PublicationResultContractError);
    expect(log).not.toHaveBeenCalledWith(`Draft merge request: ${mergeRequest.url}`);
  });

  it("preserves a typed failure and retained-work output without a success line", async () => {
    const log = vi.fn();
    const failure = new LocalUserGitLabPublisherError("invalid-input", {
      recoveryCommand: "docsfab publish run-1 --repo /product",
    });
    await expect(
      handleShipCommand(["run-1", "--repo", "/product"], {
        cwd: "/product",
        stateDirectory: "/private/runs",
        log,
        loadRun: async () => verifiedRun,
        submit: async (_record, _envelope, context) => {
          context.log?.("Preserved patch: /private/patch.diff");
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
    expect(log).toHaveBeenCalledWith("Preserved patch: /private/patch.diff");
    expect(log).not.toHaveBeenCalledWith(`Draft merge request: ${mergeRequest.url}`);
  });

  it("keeps the one-shot publish route and its existing stderr note", async () => {
    const log = vi.fn();
    const stderr = vi.fn();
    const result = await runLocalUserPublishCli(["run-1", "--repo", "/product", "--draft-mr"], {
      cwd: "/product",
      stateDirectory: "/private/runs",
      log,
      stderr,
      loadRun: async () => verifiedRun,
      submit: async () => published(),
    });
    expect(result?.publicationResult?.targetBranch).toBe("main");
    expect(log).toHaveBeenCalledWith(`Draft merge request: ${mergeRequest.url}`);
    expect(stderr).toHaveBeenCalledWith("Note: prefer docsfab ship for interactive use.");
  });
});
