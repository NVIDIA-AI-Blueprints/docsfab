// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { formatIaPlanContinuation, formatIaTaskArguments } from "../src/cli.js";
import { iaPlanningTaskFromCli, parseTwoPhaseIaRunArguments } from "../src/ia/cli.js";

const CWD = "/workspace";

describe("two-phase IA CLI contract", () => {
  it.each(["page", "section"] as const)(
    "does not advertise the site-only approval command for a %s plan",
    (scope) => {
      const lines = formatIaPlanContinuation(
        {
          id: "planning-run",
          artifacts: [
            {
              role: "output",
              reference: {
                kind: "ia-plan",
                schemaVersion: 1,
                digest: "b".repeat(64),
                repositoryRevision: "a".repeat(40),
                repositoryContentDigest: "c".repeat(64),
              },
            },
          ],
        },
        {
          kind: "ia-plan",
          scope,
          mode: "reevaluate",
          target:
            scope === "page"
              ? { sourcePath: "docs/a b; '$()`*.md" }
              : { sourcePath: "docs/a b; '$()`*.md", anchor: "section ; '$()`*" },
        },
        "/selected/repository",
      );
      expect(lines).toEqual([
        "Disposition: needs-human-decision",
        "Action: no approval command is available for this non-bootstrap plan.",
      ]);
      expect(lines.join("\n")).not.toContain("ia approve");
      expect(lines.join("\n")).not.toContain("Next:");
    },
  );

  it("quotes the complete page or section target when formatting a host command", () => {
    expect(
      formatIaTaskArguments({
        kind: "ia-plan",
        scope: "section",
        mode: "reevaluate",
        target: {
          sourcePath: "docs/a b; '$()`*.md",
          anchor: "section ; '$()`*",
        },
      }),
    ).toBe(" --scope section --target 'docs/a b; '\\''$()`*.md#section ; '\\''$()`*'");
    expect(
      formatIaTaskArguments({
        kind: "ia-plan",
        scope: "page",
        mode: "reevaluate",
        target: { sourcePath: "docs/a b; '$()`*.md" },
      }),
    ).toBe(" --scope page --target 'docs/a b; '\\''$()`*.md'");
  });

  it.each([
    [
      ["ia-plan", "--repo", "repo", "--scope", "site", "--mode", "create"],
      { workflow: "ia-plan", scope: "site", mode: "create", allowWrite: false },
    ],
    [
      ["ia-analysis", "--repo", "repo", "--scope", "site", "--mode", "create"],
      { workflow: "ia-analysis", scope: "site", mode: "create", allowWrite: false },
    ],
    [
      ["ia-plan", "--repo", "repo", "--scope", "site", "--mode", "reevaluate"],
      { workflow: "ia-plan", scope: "site", mode: "reevaluate", allowWrite: false },
    ],
    [
      ["ia-plan", "--repo", "repo", "--scope", "section", "--target", "docs/guide.md#install"],
      {
        workflow: "ia-plan",
        scope: "section",
        mode: "reevaluate",
        target: "docs/guide.md#install",
      },
    ],
    [
      [
        "ia-plan",
        "--repo",
        "repo",
        "--scope",
        "page",
        "--target",
        "docs/guide.md",
        "--input-digest",
        "f".repeat(64),
      ],
      {
        workflow: "ia-plan",
        scope: "page",
        mode: "reevaluate",
        target: "docs/guide.md",
        inputDigest: "f".repeat(64),
      },
    ],
  ])("parses fixed planning invocation %#", (args, expected) => {
    expect(parseTwoPhaseIaRunArguments(args, CWD)).toMatchObject({
      repositoryPath: "/workspace/repo",
      revision: "HEAD",
      ...expected,
    });
  });

  it("requires an approved-plan path and explicit write authorization for apply", () => {
    expect(
      parseTwoPhaseIaRunArguments(
        [
          "site-bootstrap",
          "--repo",
          "repo",
          "--revision",
          "a".repeat(40),
          "--plan",
          "records/plan.json",
          "--reviewer-policy",
          "private/reviewers.json",
          "--allow-write",
        ],
        CWD,
      ),
    ).toEqual({
      workflow: "site-bootstrap",
      repositoryPath: "/workspace/repo",
      revision: "a".repeat(40),
      planPath: "/workspace/records/plan.json",
      reviewerPolicyPath: "/workspace/private/reviewers.json",
      allowWrite: true,
    });
    expect(() =>
      parseTwoPhaseIaRunArguments(["site-bootstrap", "--repo", "repo", "--plan", "plan.json"], CWD),
    ).toThrow("requires --allow-write");
    expect(() =>
      parseTwoPhaseIaRunArguments(
        [
          "site-bootstrap",
          "--repo",
          "repo",
          "--plan",
          "plan.json",
          "--allow-write",
          "--input-digest",
          "f".repeat(64),
        ],
        CWD,
      ),
    ).toThrow("does not accept --input-digest");
  });

  it("rejects retired scanner-override options on either phase", () => {
    // The whole-repository scan is advisory only: the IA CLI exposes no
    // scanner overrides, so the flags are unknown options.
    expect(() =>
      parseTwoPhaseIaRunArguments(
        [
          "ia-plan",
          "--repo",
          "repo",
          "--scope",
          "site",
          "--mode",
          "reevaluate",
          "--revision",
          "a".repeat(40),
          "--scanner-override-rule",
          "credential.private-key",
        ],
        CWD,
      ),
    ).toThrow('Unknown ia-plan option "--scanner-override-rule".');
    expect(() =>
      parseTwoPhaseIaRunArguments(
        [
          "site-bootstrap",
          "--repo",
          "repo",
          "--plan",
          "plan.json",
          "--allow-write",
          "--scanner-override-reason",
          "reviewed",
        ],
        CWD,
      ),
    ).toThrow('Unknown site-bootstrap option "--scanner-override-reason".');
  });

  it("accepts only a complete preallocated live-corpus authorization on analysis", () => {
    const revision = "b".repeat(40);
    expect(
      parseTwoPhaseIaRunArguments(
        [
          "ia-analysis",
          "--repo",
          "repo",
          "--revision",
          revision,
          "--scope",
          "site",
          "--mode",
          "reevaluate",
          "--run-id",
          "greenfield-run-1",
          "--corpus-execution-authorization",
          "private/execution.json",
          "--corpus-reviewer-policy",
          "private/reviewers.json",
          "--corpus-case-id",
          "greenfield-reader-jobs",
          "--corpus-tested-revision",
          revision,
        ],
        CWD,
      ),
    ).toMatchObject({
      workflow: "ia-analysis",
      revision,
      runId: "greenfield-run-1",
      corpusExecutionAuthorizationPath: "/workspace/private/execution.json",
      corpusReviewerPolicyPath: "/workspace/private/reviewers.json",
      corpusCaseId: "greenfield-reader-jobs",
      corpusTestedRevision: revision,
    });
  });

  it("maps page and anchored section targets to closed runner tasks", () => {
    const page = parseTwoPhaseIaRunArguments(
      ["ia-plan", "--repo", "repo", "--scope", "page", "--target", "docs/guide.md"],
      CWD,
    );
    const section = parseTwoPhaseIaRunArguments(
      ["ia-plan", "--repo", "repo", "--scope", "section", "--target", "docs/guide.md#install"],
      CWD,
    );
    if (page.workflow !== "ia-plan" || section.workflow !== "ia-plan") throw new Error("fixture");
    expect(iaPlanningTaskFromCli(page)).toEqual({
      task: {
        kind: "ia-plan",
        scope: "page",
        mode: "reevaluate",
        target: { sourcePath: "docs/guide.md" },
      },
      contextTarget: { sourcePath: "docs/guide.md" },
    });
    expect(iaPlanningTaskFromCli(section)).toEqual({
      task: {
        kind: "ia-plan",
        scope: "section",
        mode: "reevaluate",
        target: { sourcePath: "docs/guide.md", anchor: "install" },
      },
      contextTarget: { sourcePath: "docs/guide.md", anchor: "install" },
    });
  });

  it("rejects page fragments and invalid section targets during parsing", () => {
    for (const [scope, target] of [
      ["page", "docs/guide.md#install"],
      ["section", "docs/guide.md"],
      ["section", "docs/guide.md#"],
    ] as const) {
      expect(() =>
        parseTwoPhaseIaRunArguments(
          ["ia-plan", "--repo", "repo", "--scope", scope, "--target", target],
          CWD,
        ),
      ).toThrow();
    }
  });

  it.each([
    ["ia-plan", "--repo", "repo", "--scope", "site", "--mode", "create", "--allow-write"],
    ["ia-analysis", "--repo", "repo", "--scope", "site", "--mode", "create", "--allow-write"],
    [
      "ia-analysis",
      "--repo",
      "repo",
      "--scope",
      "site",
      "--mode",
      "create",
      "--reviewer-policy",
      "reviewers.json",
    ],
    [
      "ia-plan",
      "--repo",
      "repo",
      "--scope",
      "site",
      "--mode",
      "create",
      "--reviewer-policy",
      "reviewers.json",
    ],
    ["ia-plan", "--repo", "repo", "--scope", "site", "--mode", "create", "--target", "docs/x.md"],
    ["ia-plan", "--repo", "repo", "--scope", "page", "--target", "../escape.md"],
    ["ia-plan", "--repo", "repo", "--scope", "page", "--target", "docs/x.md", "--mode", "create"],
    ["site-bootstrap", "--repo", "repo", "--plan", "plan.json", "--allow-write", "--scope", "site"],
    ["ia-plan", "--repo", "repo", "--scope", "site", "--mode", "create", "--unknown"],
    [
      "ia-plan",
      "--repo",
      "repo",
      "--scope",
      "site",
      "--mode",
      "reevaluate",
      "--scanner-override-rule",
      "credential.private-key",
    ],
    [
      "ia-plan",
      "--repo",
      "repo",
      "--scope",
      "site",
      "--mode",
      "reevaluate",
      "--revision",
      "HEAD",
      "--scanner-override-rule",
      "credential.private-key",
      "--scanner-override-reason",
      "reviewed",
      "--scanner-override-expires-at",
      "2099-01-01T00:00:00.000Z",
    ],
    [
      "ia-analysis",
      "--repo",
      "repo",
      "--scope",
      "site",
      "--mode",
      "reevaluate",
      "--run-id",
      "only-one-field",
    ],
    [
      "ia-analysis",
      "--repo",
      "repo",
      "--revision",
      "a".repeat(40),
      "--scope",
      "site",
      "--mode",
      "reevaluate",
      "--run-id",
      "run-1",
      "--corpus-execution-authorization",
      "execution.json",
      "--corpus-reviewer-policy",
      "reviewers.json",
      "--corpus-case-id",
      "case-1",
      "--corpus-tested-revision",
      "b".repeat(40),
    ],
    ["ia-plan", "--repo", "repo", "--scope", "site", "--mode", "reevaluate", "--run-id", "run-1"],
  ])("rejects invalid or phase-confused arguments %#", (...args) => {
    expect(() => parseTwoPhaseIaRunArguments(args, CWD)).toThrow();
  });
});
