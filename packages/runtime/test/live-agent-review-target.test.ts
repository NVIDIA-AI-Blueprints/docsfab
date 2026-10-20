// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DocsFabConfig } from "../src/config/runtime-loader.js";
import type { HarnessStepInput } from "../src/execution/contracts.js";
import { createRootTaskBudget } from "../src/execution/task-budget.js";
import {
  assembleLiveAgentHost,
  createLiveAgentBoundedRunner,
  runBoundedWorkflow,
} from "../src/live-agent/host.js";
import { loadLiveAgentCapabilities } from "../src/live-agent/capabilities.js";
import { liveReviewPullRequest, prepareLiveReviewTarget } from "../src/live-agent/review-target.js";
import { createLiveAgentSourceSelection } from "../src/live-agent/source-commands.js";
import { withRepositoryWorkspace } from "../src/repository/workspace/materialize.js";
import { temporaryRoots } from "./helpers/temp.js";
import { fixtureGit, initChangeRepository } from "./support/change-source-fixture.js";
import { runtimeConfig } from "./support/execution-convergence.js";
import {
  buildChangeRepository,
  FakeGithub,
  NAME,
  OWNER,
} from "./support/github-change-source-fixture.js";

const roots = temporaryRoots();
const pull = `https://github.com/${OWNER}/${NAME}/pull/7`;

afterEach(() => vi.unstubAllGlobals());

describe("live-agent PR review target", () => {
  it("refuses an exhausted task budget before contacting GitHub or running a workflow", async () => {
    const fetch = vi.fn(() => {
      throw new Error("No forge read expected.");
    });
    vi.stubGlobal("fetch", fetch);
    const runWorkflow = vi.fn();
    const persist = vi.fn();
    const runner = createLiveAgentBoundedRunner({
      selection: createLiveAgentSourceSelection(),
      repositoryPath: "/workspace/local-docs",
      allowWrite: false,
      config: {} as DocsFabConfig,
      taskBudget: createRootTaskBudget({
        envelope: {
          "provider-turns": 0,
          "tool-calls": 0,
          "input-tokens": 0,
          "output-tokens": 0,
          "source-bytes": 0,
          "elapsed-ms": 0,
          "cost-microusd": 0,
        },
      }),
      runWorkflow,
      persist,
    });
    await expect(runner("review-documentation", `Review ${pull}`)).rejects.toMatchObject({
      code: "budget-exhausted",
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(runWorkflow).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });

  it.each([
    "without accessing the network",
    "do not use the internet",
    "no network",
    "don't use the network",
    "don't access the internet",
    "don't contact GitHub",
    "don’t contact GitHub",
    "dont use the network",
  ])("honors an offline request without acquiring a forge snapshot (%s)", async (restriction) => {
    const fetch = vi.fn(() => {
      throw new Error("Network access is forbidden.");
    });
    vi.stubGlobal("fetch", fetch);
    const notices: string[] = [];
    expect(
      await prepareLiveReviewTarget({
        instruction: `Review ${pull}; ${restriction}. The diff is in review.diff.`,
        repositoryPath: "/workspace/local-evidence",
        onNotice: (line) => notices.push(line),
      }),
    ).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
    expect(notices.join("\n")).toContain("no GitHub PR snapshot or diff is acquired");
  });
  it("rejects multiple PRs before acquisition and accepts repeated references to one PR", () => {
    expect(liveReviewPullRequest(`Review (${pull}). ${pull}`)).toMatchObject({ number: 7 });
    expect(() =>
      liveReviewPullRequest(`Review ${pull} and https://github.com/other/repo/pull/8`),
    ).toThrow("live-review-target-ambiguous");
    expect(liveReviewPullRequest("Review README.md.")).toBeUndefined();
  });

  it.each([
    pull.replace("https:", "http:"),
    pull.replace("https://github.com", "http://www.github.com"),
  ])("refuses an insecure PR URL before network access or workflow execution (%s)", async (url) => {
    const fetch = vi.fn(() => {
      throw new Error("No forge read expected.");
    });
    vi.stubGlobal("fetch", fetch);
    const runWorkflow = vi.fn();
    const persist = vi.fn();
    const runner = createLiveAgentBoundedRunner({
      selection: createLiveAgentSourceSelection(),
      repositoryPath: "/workspace/local-docs",
      allowWrite: false,
      config: {} as DocsFabConfig,
      runWorkflow,
      persist,
    });
    await expect(runner("review-documentation", `Review ${url}`)).rejects.toMatchObject({
      code: "change-source-github-url-insecure",
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(runWorkflow).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });

  it.each([
    ["initial request", `can you run doc review on this PR ${pull}`],
    [
      "resumed request",
      [
        `can you run doc review on this PR ${pull}`,
        "can you run this: git fetch origin refs/pull/7/head",
        "retry",
        "can you review now?",
      ].join("\n\n"),
    ],
  ])(
    "reviews the PR head and binds its diff while preserving a different dirty checkout (%s)",
    async (_label, instruction) => {
      const fixture = await buildChangeRepository(await roots.create("docsfab-live-pr-"));
      const forge = new FakeGithub(fixture.repository);
      await forge.servePull({
        number: 7,
        state: "open",
        merged: false,
        baseSha: fixture.baseNow,
        baseRef: "main",
        headSha: fixture.head,
        baseNow: fixture.baseNow,
      });
      vi.stubGlobal("fetch", forge.fetch);
      await writeFile(join(fixture.repository, "notes.txt"), "Unrelated user work.\n");
      const before = await fixtureGit(fixture.repository, ["status", "--porcelain"]);
      const requests: Array<Record<string, any>> = [];
      let reviewedSource = "";
      const runner = createLiveAgentBoundedRunner({
        selection: createLiveAgentSourceSelection(),
        repositoryPath: fixture.repository,
        allowWrite: true,
        config: {} as DocsFabConfig,
        persist: async () => ({ status: "not-needed" }),
        runWorkflow: async (request) => {
          requests.push(request);
          await withRepositoryWorkspace(
            request.repositoryPath,
            request.revision ?? "HEAD",
            async (workspace) => {
              reviewedSource = await readFile(join(workspace.path, "src/export.ts"), "utf8");
            },
          );
          return {
            id: "pr-review",
            workflow: request.workflow,
            status: "succeeded",
            steps: [],
          } as never;
        },
      });
      await runner(
        "review-documentation",
        instruction,
        undefined,
        undefined,
        undefined,
        "Prior conversation mentioned https://github.com/other/project/pull/8; it is not the target.",
      );
      expect(requests[0]?.revision).toBe(fixture.head);
      expect(requests[0]?.changeSource).toMatchObject({
        source: "github-pull-request",
        owner: OWNER,
        repository: NAME,
        number: 7,
      });
      expect(requests[0]?.preparedReviewChange.changeSource.revision.head).toBe(fixture.head);
      expect(requests[0]?.instruction).toBe(instruction);
      expect(reviewedSource).toContain("requiresOutputPath = true");
      expect(await fixtureGit(fixture.repository, ["rev-parse", "HEAD"])).toBe(fixture.baseNow);
      expect(await fixtureGit(fixture.repository, ["status", "--porcelain"])).toBe(before);
      expect(await readFile(join(fixture.repository, "notes.txt"), "utf8")).toBe(
        "Unrelated user work.\n",
      );
    },
  );

  it("keeps ordinary local reviews offline and bound to their existing checkout", async () => {
    const fetch = vi.fn(() => {
      throw new Error("No forge read expected.");
    });
    vi.stubGlobal("fetch", fetch);
    const requests: Array<Record<string, any>> = [];
    const runner = createLiveAgentBoundedRunner({
      selection: createLiveAgentSourceSelection(),
      repositoryPath: "/workspace/local-docs",
      allowWrite: false,
      config: {} as DocsFabConfig,
      persist: async () => ({ status: "not-needed" }),
      runWorkflow: async (request) => {
        requests.push(request);
        return {
          id: "local-review",
          workflow: request.workflow,
          status: "succeeded",
          steps: [],
        } as never;
      },
    });
    await runner("review-documentation", "Review README.md.");
    expect(fetch).not.toHaveBeenCalled();
    expect(requests[0]?.revision).toBeUndefined();
    expect(requests[0]?.changeSource).toBeUndefined();
  });

  it("refuses an advanced PR before workflow steps when retrying a saved revision", async () => {
    const fixture = await buildChangeRepository(await roots.create("docsfab-live-pr-retry-"));
    const forge = new FakeGithub(fixture.repository);
    await forge.servePull({
      number: 7,
      state: "open",
      merged: false,
      baseSha: fixture.baseNow,
      baseRef: "main",
      headSha: fixture.head,
      baseNow: fixture.baseNow,
    });
    vi.stubGlobal("fetch", forge.fetch);
    const runStep = vi.fn(async () => {
      throw new Error("The advanced PR must not reach workflow steps.");
    });
    const persist = vi.fn();
    const runner = createLiveAgentBoundedRunner({
      selection: createLiveAgentSourceSelection(),
      repositoryPath: fixture.repository,
      allowWrite: false,
      config: runtimeConfig(await roots.create("docsfab-live-pr-retry-state-")),
      persist,
      runWorkflow: (request) =>
        runBoundedWorkflow({ ...request, executionHarness: { runStep } as never }),
    });
    await expect(
      runner("review-documentation", `Review ${pull}`, undefined, undefined, undefined, undefined, {
        revision: fixture.baseNow,
        reviewTargetPaths: ["README.md"],
      }),
    ).rejects.toMatchObject({ code: "change-source-github-head-moved" });
    expect(runStep).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });

  it.each(["operator URL", "selected --pr", "offline local evidence"])(
    "binds the assembled host's review to its operator source (%s)",
    async (mode) => {
      const fixture = await buildChangeRepository(await roots.create("docsfab-live-pr-host-"));
      const forge = new FakeGithub(fixture.repository);
      await forge.servePull({
        number: 7,
        state: "open",
        merged: false,
        baseSha: fixture.baseNow,
        baseRef: "main",
        headSha: fixture.head,
        baseNow: fixture.baseNow,
      });
      const fetch = vi.fn(forge.fetch);
      vi.stubGlobal("fetch", fetch);
      const config = runtimeConfig(await roots.create("docsfab-live-pr-host-state-"));
      const requests: Array<Record<string, any>> = [];
      const host = await assembleLiveAgentHost({
        repositoryPath: fixture.repository,
        allowWrite: false,
        config,
        capabilities: await loadLiveAgentCapabilities(config),
        ...(mode === "selected --pr" ? { changeSource: liveReviewPullRequest(pull)! } : {}),
        environment: { PATH: process.env.PATH },
        sourcePorts: {} as never,
        onNotice: () => undefined,
        writeError: () => undefined,
        runWorkflow: async (request) => {
          requests.push(request);
          throw new Error("fixture PR snapshot runner reached");
        },
      });
      const instruction =
        mode === "selected --pr"
          ? "Review documentation in this pull request."
          : `Review ${pull}.${mode === "offline local evidence" ? " No network; use local evidence." : ""}`;
      host.terminalOptions.onUserTurn?.(instruction);
      expect(await host.terminalOptions.prepareUserTurn?.(instruction)).toBeUndefined();
      const tool = host.customTools.find((candidate) => candidate.name === "docsfab_run_workflow");
      if (!tool) throw new Error("Missing bounded workflow tool.");
      await expect(
        tool.execute(
          "review",
          { workflow: "review-documentation", instruction },
          undefined,
          undefined,
          {} as never,
        ),
      ).rejects.toThrow("fixture PR snapshot runner reached");
      expect(requests).toHaveLength(1);
      if (mode === "offline local evidence") {
        expect(fetch).not.toHaveBeenCalled();
        expect(requests[0]?.changeSource).toBeUndefined();
        expect(requests[0]?.revision).toBeUndefined();
      } else {
        expect(requests[0]?.revision).toBe(fixture.head);
        expect(requests[0]?.changeSource).toMatchObject({
          source: "github-pull-request",
          number: 7,
        });
        expect(requests[0]?.preparedReviewChange.changeSource.revision.head).toBe(fixture.head);
      }
    },
  );

  it("refuses unavailable PR objects instead of reviewing the current checkout", async () => {
    const fixture = await buildChangeRepository(await roots.create("docsfab-live-pr-missing-"));
    const forge = new FakeGithub(fixture.repository);
    await forge.servePull({
      number: 7,
      state: "open",
      merged: false,
      baseSha: fixture.baseNow,
      baseRef: "main",
      headSha: fixture.head,
      baseNow: fixture.baseNow,
    });
    vi.stubGlobal("fetch", forge.fetch);
    const unrelated = await initChangeRepository(await roots.create("docsfab-live-pr-unrelated-"), {
      "README.md": "A different repository with no PR objects.\n",
    });
    const before = await fixtureGit(unrelated.repository, ["rev-parse", "HEAD"]);
    await expect(
      prepareLiveReviewTarget({
        instruction: `Review ${pull}`,
        repositoryPath: unrelated.repository,
      }),
    ).rejects.toThrow("live-review-snapshot-unavailable");
    expect(await fixtureGit(unrelated.repository, ["rev-parse", "HEAD"])).toBe(before);
  });

  it("rejects a prepared PR diff paired with the wrong snapshot before any workflow step", async () => {
    const fixture = await buildChangeRepository(await roots.create("docsfab-live-pr-binding-"));
    const forge = new FakeGithub(fixture.repository);
    await forge.servePull({
      number: 7,
      state: "open",
      merged: false,
      baseSha: fixture.baseNow,
      baseRef: "main",
      headSha: fixture.head,
      baseNow: fixture.baseNow,
    });
    vi.stubGlobal("fetch", forge.fetch);
    const target = await prepareLiveReviewTarget({
      instruction: `Review ${pull}`,
      repositoryPath: fixture.repository,
    });
    const runStep = vi.fn(async () => {
      throw new Error("Workflow steps must not run.");
    });
    await expect(
      runBoundedWorkflow({
        workflow: "review-documentation",
        instruction: `Review ${pull}`,
        repositoryPath: fixture.repository,
        allowWrite: false,
        config: runtimeConfig(await roots.create("docsfab-live-pr-state-")),
        ...target,
        revision: fixture.baseNow,
        executionHarness: { runStep } as never,
      }),
    ).rejects.toMatchObject({ code: "change-source-github-head-moved" });
    expect(runStep).not.toHaveBeenCalled();
  });

  it("makes the bound PR manifest and diff readable in the real workflow's initial audit", async () => {
    const fixture = await buildChangeRepository(await roots.create("docsfab-live-pr-audit-"));
    const forge = new FakeGithub(fixture.repository);
    await forge.servePull({
      number: 7,
      state: "open",
      merged: false,
      baseSha: fixture.baseNow,
      baseRef: "main",
      headSha: fixture.head,
      baseNow: fixture.baseNow,
    });
    vi.stubGlobal("fetch", forge.fetch);
    const target = await prepareLiveReviewTarget({
      instruction: `Review ${pull}`,
      repositoryPath: fixture.repository,
    });
    let auditSources: string[] = [];
    const auditTexts: string[] = [];
    const runStep = vi.fn(async (input: HarnessStepInput) => {
      expect(input.step.id).toBe("audit-documentation");
      const spans = input.sourceReader?.listSources() ?? [];
      auditSources = spans.map((source) => source.repositoryPath);
      for (const span of spans) {
        auditTexts.push(
          input.sourceReader!.read({
            observationId: span.observationId,
            representationId: span.representationId,
            spanIds: [span.spanId],
          }).text,
        );
      }
      throw new Error("Stop after observing the audit's actual source capability.");
    });
    await runBoundedWorkflow({
      workflow: "review-documentation",
      instruction: `Review ${pull}`,
      repositoryPath: fixture.repository,
      allowWrite: false,
      config: runtimeConfig(await roots.create("docsfab-live-pr-audit-state-")),
      ...target,
      executionHarness: { runStep } as never,
    }).catch(() => undefined);
    expect(runStep).toHaveBeenCalled();
    expect(auditSources.some((path) => path.endsWith("/manifest.json"))).toBe(true);
    expect(auditSources.some((path) => path.endsWith("/range.diff"))).toBe(true);
    expect(auditTexts.join("\n")).toContain(fixture.head);
    expect(auditTexts.join("\n")).toContain("requiresOutputPath");
  });
});
