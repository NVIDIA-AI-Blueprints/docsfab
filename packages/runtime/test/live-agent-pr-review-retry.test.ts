// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as localWorkflow from "../src/cli/run/local-workflow.js";
import { loadLiveAgentCapabilities } from "../src/live-agent/capabilities.js";
import {
  assembleLiveAgentHost,
  liveWorkflowRetryBinding,
  runBoundedWorkflow,
} from "../src/live-agent/host.js";
import { liveReviewPullRequest, prepareLiveReviewTarget } from "../src/live-agent/review-target.js";
import { FileRunStore } from "../src/records/file-store.js";
import type { RunRecord } from "../src/records/contracts.js";
import { temporaryRoots } from "./helpers/temp.js";
import { commitFiles } from "./support/change-source-fixture.js";
import { runtimeConfig } from "./support/execution-convergence.js";
import {
  buildChangeRepository,
  FakeGithub,
  NAME,
  OWNER,
} from "./support/github-change-source-fixture.js";

const roots = temporaryRoots();
const pull = `https://github.com/${OWNER}/${NAME}/pull/7`;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("saved PR reviews through the assembled live-agent retry", () => {
  it.each([
    "URL",
    "selected PR",
    "URL without selection",
    "whole documentation",
    "missing selection",
    "different PR",
    "conflicting selection",
    "moved head",
    "changed base",
    "offline",
    "missing digest",
    "empty digest",
    "invalid digest",
    "non-string digest",
    "malformed source list",
    "empty source list",
  ])("keeps the saved evidence or refuses before dispatch (%s)", async (mode) => {
    const fixture = await buildChangeRepository(await roots.create("docsfab-saved-pr-retry-"));
    fixture.repository = await realpath(fixture.repository);
    const forge = new FakeGithub(fixture.repository);
    const originalPull = {
      number: 7,
      state: "open" as const,
      merged: false,
      baseSha: fixture.baseNow,
      baseRef: "main",
      headSha: fixture.head,
      baseNow: fixture.baseNow,
    };
    await forge.servePull(originalPull);
    const fetch = vi.fn(forge.fetch);
    vi.stubGlobal("fetch", fetch);
    const config = runtimeConfig(await roots.create("docsfab-saved-pr-state-"));
    const selectorOnly = ["selected PR", "missing selection", "different PR"].includes(mode);
    const instruction = selectorOnly
      ? "Review README.md in this pull request."
      : `Review ${mode === "whole documentation" ? "the documentation" : "README.md"} in ${pull}.${mode === "offline" ? " No network." : ""}`;
    const prepared = await prepareLiveReviewTarget({
      instruction: `Review ${pull}`,
      repositoryPath: fixture.repository,
    });
    const stop = vi.fn(async () => {
      throw new Error("Fixture stops at the initial audit.");
    });
    const original = await runBoundedWorkflow({
      workflow: "review-documentation",
      instruction,
      repositoryPath: fixture.repository,
      allowWrite: false,
      config,
      ...prepared,
      executionHarness: { runStep: stop } as never,
    });
    expect(original.status).toBe("failed");
    expect(stop).toHaveBeenCalled();
    expect(original.changeSources).toHaveLength(1);
    expect(original.instruction).toBe(instruction);
    expect(original.repository.sourcePath).toBe(fixture.repository);
    if (mode === "whole documentation") expect(original.reviewScope).toBeUndefined();
    else
      expect(original.reviewScope).toMatchObject({
        scope: "focused-set",
        reason: "operator-named",
        targetPaths: ["README.md"],
      });
    const citation = original.changeSources![0]!;
    const invalidSources = new Map<string, unknown>([
      ["missing digest", [{ ...citation, changeSourceSha256: undefined }]],
      ["empty digest", [{ ...citation, changeSourceSha256: "" }]],
      ["invalid digest", [{ ...citation, changeSourceSha256: "not-a-digest" }]],
      ["non-string digest", [{ ...citation, changeSourceSha256: 1 }]],
      ["malformed source list", { length: 1, 0: citation }],
      ["empty source list", []],
    ]);
    const saved: RunRecord = invalidSources.has(mode)
      ? JSON.parse(JSON.stringify({ ...original, changeSources: invalidSources.get(mode) }))
      : original;
    if (invalidSources.has(mode))
      await writeFile(join(config.stateDirectory, `${saved.id}.json`), JSON.stringify(saved), {
        mode: 0o600,
      });

    const actualLocalRun = localWorkflow.withLocalWorkflowRun;
    const sharedRun = vi
      .spyOn(localWorkflow, "withLocalWorkflowRun")
      .mockImplementation((request, runConfig, options, use) =>
        actualLocalRun(
          request,
          runConfig,
          {
            ...options,
            executionHarness: { runStep: stop } as never,
          },
          use,
        ),
      );
    const childSaves = vi.spyOn(FileRunStore.prototype, "save");
    const host = await assembleLiveAgentHost({
      repositoryPath: fixture.repository,
      allowWrite: false,
      config,
      capabilities: await loadLiveAgentCapabilities(config),
      changeSource: liveReviewPullRequest(pull)!,
      environment: { PATH: process.env.PATH },
      sourcePorts: {} as never,
      onNotice: () => undefined,
      writeError: () => undefined,
      // Deliberately no runWorkflow substitution: that bypasses saved-record admission.
    });
    host.terminalOptions.onUserTurn?.(instruction);
    host.workflowFailure.recordFailure({
      kind: "run",
      workflow: "review-documentation",
      runId: saved.id,
      status: "failed",
    });
    host.terminalOptions.turnNotices?.();
    if (
      [
        "URL without selection",
        "missing selection",
        "different PR",
        "conflicting selection",
        "offline",
      ].includes(mode)
    ) {
      await host.terminalOptions.dispatchSourceCommand?.(`/sources remove ${OWNER}/${NAME}#7`);
    }
    if (["different PR", "conflicting selection"].includes(mode)) {
      await forge.servePull({ ...originalPull, number: 8 });
      await host.terminalOptions.dispatchSourceCommand?.(
        `/sources review https://github.com/${OWNER}/${NAME}/pull/8`,
      );
    }
    if (mode === "moved head") {
      const head = await commitFiles(
        fixture.repository,
        { "README.md": "# Changed widget\n" },
        "Move the PR head",
      );
      await forge.servePull({ ...originalPull, headSha: head });
    }
    if (mode === "changed base") {
      await forge.servePull({ ...originalPull, baseSha: fixture.fork, baseNow: fixture.fork });
    }
    fetch.mockClear();
    stop.mockClear();
    expect(host.terminalOptions.resolveChoice?.("retry")).toContain(instruction);
    host.terminalOptions.onUserTurn?.("retry");
    await host.terminalOptions.prepareUserTurn?.("retry");
    const tool = host.customTools.find((candidate) => candidate.name === "docsfab_run_workflow");
    if (!tool) throw new Error("Missing workflow tool.");
    const retry = tool.execute(
      "retry",
      { workflow: "review-documentation", instruction },
      undefined,
      undefined,
      {} as never,
    );
    if (["URL", "selected PR", "URL without selection", "whole documentation"].includes(mode)) {
      await retry;
      expect(sharedRun).toHaveBeenCalledOnce();
      const [request, , options] = sharedRun.mock.calls[0]!;
      expect(request.revision).toBe(fixture.head);
      expect(request.reviewTargetPaths).toEqual(
        mode === "whole documentation" ? undefined : ["README.md"],
      );
      expect(options.preparedReviewChange?.changeSource.changeSourceSha256).toBe(
        saved.changeSources![0]!.changeSourceSha256,
      );
      expect(stop).toHaveBeenCalled();
    } else {
      if (invalidSources.has(mode)) {
        await expect(retry).rejects.toThrow("cannot reconstruct");
      } else
        await expect(retry).rejects.toMatchObject({
          code:
            mode === "conflicting selection"
              ? "live-review-target-ambiguous"
              : mode === "offline"
                ? "live-review-retry-network-disabled"
                : mode === "missing selection"
                  ? "live-review-retry-source-unavailable"
                  : "live-review-retry-evidence-moved",
        });
      expect(sharedRun).not.toHaveBeenCalled();
      expect(stop).not.toHaveBeenCalled();
      expect(childSaves).not.toHaveBeenCalled();
      if (
        invalidSources.has(mode) ||
        ["missing selection", "offline", "conflicting selection"].includes(mode)
      )
        expect(fetch).not.toHaveBeenCalled();
    }
    expect(
      JSON.parse(await readFile(join(config.stateDirectory, `${saved.id}.json`), "utf8")),
    ).toEqual(saved);
  });

  it("keeps unsupported external evidence and inconsistent saved revisions refused", () => {
    const base = {
      status: "failed",
      workflow: "review-documentation",
      instruction: "Review README.md.",
      repository: { sourcePath: "/fixture", revision: "a".repeat(40) },
    };
    const source = {
      sourceKind: "github-pull-request",
      head: base.repository.revision,
      changeSourceSha256: "b".repeat(64),
    };
    const current = {
      workflow: base.workflow,
      instruction: base.instruction,
      repositoryPath: base.repository.sourcePath,
    };
    expect(liveWorkflowRetryBinding(base as RunRecord, current)).toEqual({
      revision: base.repository.revision,
    });
    for (const evidence of [
      { changeSources: [{ ...source, sourceKind: "local-range" }] },
      { changeSources: [source, source] },
      { changeSources: [{ ...source, head: "c".repeat(40) }] },
      { changeSources: [source], retainedEvidenceBindings: {} },
    ])
      expect(() =>
        liveWorkflowRetryBinding({ ...base, ...evidence } as RunRecord, current),
      ).toThrow("cannot reconstruct");
  });
});
