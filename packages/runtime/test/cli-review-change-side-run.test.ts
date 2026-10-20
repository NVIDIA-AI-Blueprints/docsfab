// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Shipped GitLab CLI -> runner -> immutable step -> real Pi side tools; provider is local script. */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { executeRunRequest } from "../src/cli/run-request.js";
import { parseRunArguments } from "../src/cli/run-arguments.js";
import type { HarnessStepInput, HarnessStepResult } from "../src/execution/contracts.js";
import { PiHarness } from "../src/harness/pi.js";
import { SOURCE_LIST_MAX_ENTRIES } from "../src/harness/source-tools.js";
import type { ReviewChangeObservation } from "../src/harness/confined-tools/review-change-side.js";
import { createModelConnection } from "../src/model/provider.js";
import { limit } from "../src/config/limits.js";
import {
  canonicalSourceObligationProposal,
  requiresSourceObligationLedger,
} from "../src/workflow-execution/source-obligation.js";
import { TECHNICAL_FACT_DIMENSIONS } from "../src/workflow-execution/verification-result.js";
import { validModelConfig } from "./helpers.js";
import { temporaryRoots } from "./helpers/temp.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";
import { sourceObligationProposalFixture } from "./helpers/verification.js";
import { runtimeConfig } from "./support/execution-convergence.js";
import { authoringFixtureCandidateForInput } from "./support/authoring-quality-fixture.js";
import { createSourceFixture, SourceToolHarness } from "./support/source-acquisition-cli.js";
import { commitFiles, fixtureGit } from "./support/change-source-fixture.js";
import {
  boundStyleContext,
  qualityDirectory,
  skillCrateDirectory,
  textTurn,
  toolTurn,
} from "./support/pi-harness-session-fixtures.js";

const roots = temporaryRoots();
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

function response() {
  return JSON.stringify({
    verdict: "needs-revision",
    coverage: [
      {
        path: "README.md",
        status: "verified",
        evidence: ["README.md:1"],
        reason: "The active page was checked.",
      },
    ],
    issueJudgments: [
      {
        id: "TECH-DEL",
        severity: "major",
        category: "technical_accuracy",
        location: "docs/deleted.md:1",
        obligationIds: ["OBL-INPUT-REPRESENTATIONS-1"],
      },
      {
        id: "TECH-AFTER",
        severity: "major",
        category: "technical_accuracy",
        location: "README.md:1",
        obligationIds: ["OBL-INPUT-REPRESENTATIONS-1"],
      },
    ],
    obligationJudgments: [
      {
        obligationId: "OBL-INPUT-REPRESENTATIONS-1",
        disposition: "retained",
        documentationDisposition: "conflicting",
        issueIds: ["TECH-DEL", "TECH-AFTER"],
      },
    ],
  });
}

class RealSideReviewHarness extends SourceToolHarness {
  private pi: PiHarness | undefined;
  public observation: ReviewChangeObservation | undefined;
  public readonly modelResults = new Map<string, string>();
  public sawSourceCapability = false;
  public discoveredOrdinals: { deleted: number; after: number } | undefined;
  public piError: string | undefined;
  public providerRequests = 0;

  public constructor() {
    super({ readOnSkill: null, planSourcePaths: ["README.md"] });
  }

  private async realPi() {
    this.pi ??= new PiHarness({
      skillCrateDirectory,
      qualityDirectory,
      styleContext: await boundStyleContext(),
      model: validModelConfig,
      createConnection: createModelConnection,
      reviewReadMaxObjectBytes: limit("artifacts.maxObjectBytes").value,
    });
    return this.pi;
  }

  public override async inspectSkill(input: HarnessStepInput) {
    return (await this.realPi()).inspectSkill(input);
  }

  public override async runStep(input: HarnessStepInput): Promise<HarnessStepResult> {
    if (requiresSourceObligationLedger(input)) {
      const proposal = sourceObligationProposalFixture("README.md:1");
      proposal.dimensions[0] = {
        dimension: TECHNICAL_FACT_DIMENSIONS[0]!,
        status: "applicable",
        reason: "The active page states one source-backed claim.",
        sourceLocators: [],
        obligations: [
          {
            id: "OBL-IGNORED",
            dimension: TECHNICAL_FACT_DIMENSIONS[0]!,
            sourceLocators: ["README.md:1"],
            statement: "The opening line names the reviewed head.",
            evidenceClass: "source-observation",
            uncertainty: "none",
          },
        ],
      };
      return {
        summary: canonicalSourceObligationProposal(proposal),
        sourceObligationProposal: proposal,
        model: { provider: "hosted", model: "test-model" },
        skill: await this.inspectSkill(input),
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2, turns: 1 },
        tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
      };
    }
    if (input.step.id === "evaluate-document-quality") {
      const candidate = await authoringFixtureCandidateForInput(input);
      const target = candidate.evaluation.target as {
        documentation_family_evidence: Array<{ paths: string[] }>;
        paths: string[];
      };
      target.documentation_family_evidence[0]!.paths = ["README.md"];
      target.paths = ["README.md"];
      return {
        summary: candidate.reportMarkdown,
        qualityArtifactCandidate: candidate,
        model: { provider: "hosted", model: "test-model" },
        skill: await this.inspectSkill(input),
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2, turns: 1 },
        tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
      };
    }
    if (input.step.id !== "verify-technical-accuracy") {
      return { ...(await super.runStep(input)), skill: await this.inspectSkill(input) };
    }
    this.sawSourceCapability = input.reviewChangeSource !== undefined;
    const inventory = toolTurn([
      {
        id: "inventory",
        name: "docsfab_read_review_change_side",
        arguments: { fromFileOrdinal: 0, maxFiles: SOURCE_LIST_MAX_ENTRIES },
      },
    ]);
    let index = 0;
    vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
      this.providerRequests += 1;
      const request = JSON.parse(String(init?.body ?? "{}")) as {
        messages: Array<{ role: string; tool_call_id?: string; content?: unknown }>;
      };
      for (const message of request.messages.filter((item) => item.role === "tool")) {
        if (message.tool_call_id)
          this.modelResults.set(
            message.tool_call_id,
            typeof message.content === "string"
              ? message.content
              : Array.isArray(message.content)
                ? message.content.map((item: { text?: string }) => item.text ?? "").join("")
                : "",
          );
      }
      if (index === 1) {
        const visible = this.modelResults.get("inventory");
        if (!visible) throw new Error("The model did not receive the pinned file inventory.");
        const rows = JSON.parse(visible) as {
          files: Array<{
            fileOrdinal: number;
            oldPath: string | null;
            newPath: string | null;
            beforeAvailable: boolean;
            afterAvailable: boolean;
          }>;
        };
        const deleted = rows.files.find(
          (row) => row.oldPath === "docs/deleted.md" && row.newPath === null && row.beforeAvailable,
        );
        const after = rows.files.find((row) => row.newPath === "README.md" && row.afterAvailable);
        if (!deleted || !after) throw new Error("Pinned file inventory omitted a usable side.");
        this.discoveredOrdinals = { deleted: deleted.fileOrdinal, after: after.fileOrdinal };
      }
      const deletedOrdinal = this.discoveredOrdinals?.deleted;
      const afterOrdinal = this.discoveredOrdinals?.after;
      const scripted = [
        inventory,
        deletedOrdinal === undefined
          ? undefined
          : toolTurn([
              {
                id: "before",
                name: "docsfab_read_review_change_side",
                arguments: {
                  fileOrdinal: deletedOrdinal,
                  side: "before",
                  startLine: 1,
                  endLine: 1,
                },
              },
            ]),
        deletedOrdinal === undefined
          ? undefined
          : toolTurn([
              {
                id: "selected",
                name: "docsfab_select_review_anchor",
                arguments: {
                  originalIssueId: "TECH-DEL",
                  fileOrdinal: deletedOrdinal,
                  side: "before",
                  startLine: 1,
                  endLine: 1,
                },
              },
            ]),
        toolTurn([{ id: "head-read", name: "read", arguments: { path: "README.md" } }]),
        afterOrdinal === undefined
          ? undefined
          : toolTurn([
              {
                id: "selected-after",
                name: "docsfab_select_review_anchor",
                arguments: {
                  originalIssueId: "TECH-AFTER",
                  fileOrdinal: afterOrdinal,
                  side: "after",
                  startLine: 1,
                  endLine: 1,
                },
              },
            ]),
        textTurn(response()),
      ];
      const next = scripted[index++];
      if (!next) throw new Error("Unexpected scripted provider request.");
      return next.clone();
    });
    let result: HarnessStepResult;
    try {
      result = await (await this.realPi()).runStep(input);
    } catch (error) {
      this.piError = error instanceof Error ? error.message : String(error);
      throw error;
    }
    this.observation = result.reviewChangeObservation;
    return result;
  }
}

describe("fresh CLI pinned-side review", () => {
  it(
    "shows a deleted GitLab side and private proposal without admitting old-path V3 success",
    async () => {
      const fixture = await createSourceFixture({ "docs/deleted.md": "removed source line\n" });
      roots.track(fixture.root);
      const base = await fixtureGit(fixture.repository, ["rev-parse", "HEAD"]);
      const head = await commitFiles(
        fixture.repository,
        { "docs/deleted.md": null, "README.md": "# Reviewed head\n" },
        "Delete old source and revise reviewed page",
      );
      const host = "gitlab.example.test";
      const projectPath = "team/docs-project";
      const projectId = 4242;
      const iid = 813;
      const url = `https://${host}/${projectPath}/-/merge_requests/${iid}`;
      const template = readFileSync(
        new URL("./fixtures/change-source-gitlab/merge-request-get.json", import.meta.url),
        "utf8",
      );
      const answer = JSON.parse(template, (_key, value: unknown) =>
        typeof value === "string" && value.startsWith("@")
          ? ({ base, start: base, head, merge: null } as Record<string, unknown>)[value.slice(1)]
          : value,
      ) as Record<string, unknown>;
      answer.state = "opened";
      answer.merge_commit_sha = null;
      answer.squash_commit_sha = null;
      const commands = {
        async run(_command: string, args: readonly string[]) {
          const endpoint = String(args.at(-1));
          if (args.includes("config")) return { stdout: "Fixture User\n", stderr: "", exitCode: 0 };
          const body = endpoint.includes("/merge_requests/")
            ? answer
            : { id: projectId, path_with_namespace: projectPath };
          return { stdout: JSON.stringify(body), stderr: "", exitCode: 0 };
        },
      };
      const request = parseRunArguments([
        "review-documentation",
        "--repo",
        fixture.repository,
        "--instruction",
        "Review README.md and the deleted source for technical accuracy.",
        "--change",
        url,
        "--review-delivery-target",
        url,
        "--review-delivery",
        "preview",
      ]);
      const harness = new RealSideReviewHarness();
      let record: Awaited<ReturnType<typeof executeRunRequest>>;
      let thrown: string | undefined;
      let thrownName: string | undefined;
      try {
        record = await executeRunRequest(request, runtimeConfig(fixture.stateDirectory), {
          silent: true,
          executionHarness: harness,
          changeRequestCommands: commands,
          changeRequestEnvironment: {},
        });
      } catch (error) {
        thrown = error instanceof Error ? error.message : String(error);
        thrownName = error instanceof Error ? error.name : undefined;
      }
      expect(
        harness.sawSourceCapability,
        JSON.stringify({ status: record?.status, error: record?.error, thrown }),
      ).toBe(true);
      expect(
        harness.modelResults.get("before"),
        JSON.stringify({
          status: record?.status,
          error: record?.error,
          toolResults: [...harness.modelResults],
          observation: harness.observation,
          thrown,
          piError: harness.piError,
          providerRequests: harness.providerRequests,
        }),
      ).toBeDefined();
      expect(harness.modelResults.get("before")).toContain("removed source line");
      expect(harness.modelResults.get("inventory")).toContain("docs/deleted.md");
      expect(harness.discoveredOrdinals).toMatchObject({
        deleted: expect.any(Number),
        after: expect.any(Number),
      });
      expect(harness.discoveredOrdinals?.deleted).not.toBe(harness.discoveredOrdinals?.after);
      expect(harness.modelResults.get("before")).toContain(
        '"oldPath":"docs/deleted.md","newPath":null',
      );
      expect(harness.modelResults.get("selected")).toContain("proposal recorded");
      expect(harness.modelResults.get("head-read")).toContain("[source-line 1]");
      expect(harness.modelResults.get("selected-after")).toContain("proposal recorded");
      expect(harness.providerRequests).toBe(6);
      expect(harness.observation?.runId).toMatch(/^[a-zA-Z0-9-]+$/u);
      expect(harness.observation).toMatchObject({
        stepId: "verify-technical-accuracy",
        proposals: [
          {
            originalIssueId: "TECH-DEL",
            side: "before",
            oldPath: "docs/deleted.md",
            newPath: null,
          },
          {
            originalIssueId: "TECH-AFTER",
            side: "after",
            newPath: "README.md",
          },
        ],
        delivered: [{ side: "before" }, { side: "after", newPath: "README.md" }],
        unavailable: false,
      });
      expect(Buffer.byteLength(JSON.stringify(harness.observation))).toBeLessThan(
        limit("artifacts.maxObjectBytes").value,
      );
      expect(record?.status).not.toBe("succeeded");
      expect(thrownName).toBe("PublicationRunRecordDecodeError");
    },
    testTimeoutMs(120_000),
  );
});
