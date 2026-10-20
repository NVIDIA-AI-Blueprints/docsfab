// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { parseDoArguments, parseRunArguments } from "../src/cli.js";
import {
  RUN_ACCEPTED_OPTIONS,
  RUN_OPTION_REFUSALS,
  RUN_OPTION_REFUSAL_CODES,
} from "../src/cli/run-arguments.js";

describe("bounded documentation improvement run arguments", () => {
  const revision = "a".repeat(40);

  it("accepts bootstrap patch delivery only with its explicit write grant", () => {
    expect(() =>
      parseRunArguments([
        "bootstrap",
        "--repo",
        "repository",
        "--instruction",
        "Prepare.",
        "--patch-only",
      ]),
    ).toThrow(/requires --allow-write/u);
    expect(
      parseRunArguments([
        "bootstrap",
        "--repo",
        "repository",
        "--instruction",
        "Prepare.",
        "--patch-only",
        "--allow-write",
      ]),
    ).toMatchObject({ workflow: "bootstrap", allowWrite: true, draftMr: false });
    expect(() =>
      parseRunArguments([
        "bootstrap",
        "--repo",
        "repository",
        "--instruction",
        "Prepare.",
        "--draft-mr",
      ]),
    ).toThrow(/no draft-MR delivery adapter/u);
  });

  it("parses repeatable reader source roles without accepting paths or digests by assertion", () => {
    expect(
      parseRunArguments([
        "update-documentation",
        "--repo",
        "repository",
        "--instruction",
        "Update the Orbit command.",
        "--reader-source",
        "public-contract=src/orbit.ts",
        "--reader-source",
        "current-documentation=docs/cli.md",
      ]).readerSources,
    ).toEqual([
      { role: "public-contract", path: "src/orbit.ts" },
      { role: "current-documentation", path: "docs/cli.md" },
    ]);
    for (const invalid of [
      "public-contract=../secret",
      "invented=src/orbit.ts",
      "public-contract=",
    ]) {
      expect(() =>
        parseRunArguments([
          "update-documentation",
          "--instruction",
          "Update the command.",
          "--reader-source",
          invalid,
        ]),
      ).toThrow();
    }
    expect(() =>
      parseRunArguments([
        "review-documentation",
        "--reader-source",
        "public-contract=src/orbit.ts",
      ]),
    ).toThrow("valid only for the update-documentation workflow");
  });

  it("treats retired job names as unknown; campaign flags bind to update-documentation", () => {
    expect(() =>
      parseRunArguments([
        "polish",
        "--repo",
        "repository",
        "--revision",
        revision,
        "--allow-write",
        "--doc-improvement-campaign",
        "private-campaign",
        "--reviewer-policy",
        "reviewers.json",
      ]),
    ).toThrow('Unknown workflow "polish". Run "docsfab list".');
    expect(() =>
      parseRunArguments([
        "review-documentation",
        "--repo",
        "repository",
        "--revision",
        revision,
        "--allow-write",
        "--doc-improvement-campaign",
        "private-campaign",
        "--reviewer-policy",
        "reviewers.json",
      ]),
    ).toThrow("Bounded documentation improvement requires");
    expect(
      parseRunArguments([
        "update-documentation",
        "--repo",
        "repository",
        "--revision",
        revision,
        "--allow-write",
        "--doc-improvement-campaign",
        "private-campaign",
        "--reviewer-policy",
        "reviewers.json",
      ]),
    ).toMatchObject({
      workflow: "update-documentation",
      allowWrite: true,
    });
  });

  it("selects release-gate product exit policy explicitly", () => {
    expect(
      parseRunArguments(["review-documentation", "--repo", "repository", "--release-gate"]),
    ).toMatchObject({
      workflow: "review-documentation",
      releaseGate: true,
      allowWrite: false,
    });
    expect(() =>
      parseRunArguments([
        "review-documentation",
        "--repo",
        "repository",
        "--release-gate",
        "--release-gate",
      ]),
    ).toThrow("must not be duplicated");
    expect(() =>
      parseRunArguments([
        "ia-analysis",
        "--repo",
        "repository",
        "--scope",
        "site",
        "--mode",
        "create",
        "--release-gate",
      ]),
    ).toThrow("not bound to a catalog skill");
  });

  it.each([
    ["review-documentation", true, revision, "campaign", "policy"],
    ["review-documentation", false, revision, "campaign", "policy"],
    ["review-documentation", true, "HEAD", "campaign", "policy"],
    ["review-documentation", true, revision, "campaign", undefined],
    ["review-documentation", true, revision, undefined, "policy"],
  ] as const)(
    "rejects incomplete or ineligible campaign write inputs",
    (workflow, allowWrite, requestedRevision, campaign, policy) => {
      const args = [workflow, "--repo", "repository", "--revision", requestedRevision];
      if (allowWrite) args.push("--allow-write");
      if (campaign) args.push("--doc-improvement-campaign", campaign);
      if (policy) args.push("--reviewer-policy", policy);
      expect(() => parseRunArguments(args)).toThrow("Bounded documentation improvement requires");
    },
  );

  it("rejects duplicate critical campaign paths", () => {
    expect(() =>
      parseRunArguments([
        "review-documentation",
        "--repo",
        "repository",
        "--revision",
        revision,
        "--allow-write",
        "--doc-improvement-campaign",
        "one",
        "--doc-improvement-campaign",
        "two",
        "--reviewer-policy",
        "reviewers.json",
      ]),
    ).toThrow("must not be duplicated");
  });

  it("rejects arbitrary prose beside the signed campaign", () => {
    expect(() =>
      parseRunArguments([
        "review-documentation",
        "--repo",
        "repository",
        "--revision",
        revision,
        "--allow-write",
        "--doc-improvement-campaign",
        "campaign",
        "--reviewer-policy",
        "reviewers.json",
        "--instruction",
        "edit an unapproved path",
      ]),
    ).toThrow("rejects --instruction");
  });

  it("rejects caller context overrides beside the signed campaign", () => {
    expect(() =>
      parseRunArguments([
        "review-documentation",
        "--repo",
        "repository",
        "--revision",
        revision,
        "--allow-write",
        "--doc-improvement-campaign",
        "campaign",
        "--reviewer-policy",
        "reviewers.json",
        "--context-path",
        "docs/unrelated.md",
      ]),
    ).toThrow("rejects context overrides");
  });

  it("selects the composition path with --composition alone", () => {
    const parsed = parseRunArguments([
      "review-documentation",
      "--repo",
      "repository",
      "--composition",
      "openai-gpt-5.6-sol-pi",
    ]);
    expect(parsed).toMatchObject({
      compositionId: "openai-gpt-5.6-sol-pi",
      releaseGate: false,
    });
    // No tier field survives on the parsed request.
    expect(Object.keys(parsed).filter((key) => /mode$/iu.test(key))).toEqual([]);
  });

  it("keeps the model-profile path when --composition is omitted", () => {
    const parsed = parseRunArguments(["review-documentation", "--repo", "repository"]);
    expect(parsed.compositionId).toBeUndefined();
    // No tier field survives on the parsed request.
    expect(Object.keys(parsed).filter((key) => /mode$/iu.test(key))).toEqual([]);
    // The model-profile path keeps the release gate and existing-MR delivery.
    expect(
      parseRunArguments(["review-documentation", "--repo", "repository", "--release-gate"]),
    ).toMatchObject({ releaseGate: true });
    expect(
      parseRunArguments(["review-documentation", "--repo", "repository", "--comment-mr", "42"]),
    ).toMatchObject({ commentMr: "42" });
  });

  it.each([
    ["--mode", ["--mode", "production"]],
    ["--mode with a composition", ["--mode", "alpha", "--composition", "openai-gpt-5.6-sol-pi"]],
  ] as const)("refuses the deleted tier flag %s as an unknown option", (_kind, flags) => {
    let raised: unknown;
    try {
      parseRunArguments(["review-documentation", "--repo", "repository", ...flags]);
    } catch (error) {
      raised = error;
    }
    expect((raised as { code?: string }).code).toBe("unknown-option");
    expect((raised as Error).message).toBe(RUN_OPTION_REFUSALS["unknown-option"]);
  });

  it("refuses a duplicated or malformed composition selection", () => {
    expect(() =>
      parseRunArguments([
        "review-documentation",
        "--repo",
        "repository",
        "--composition",
        "openai-gpt-5.6-sol-pi",
        "--composition",
        "anthropic-claude-opus-4.7-pi",
      ]),
    ).toThrow("The --composition option must not be duplicated on docsfab run.");
    expect(() =>
      parseRunArguments([
        "review-documentation",
        "--repo",
        "repository",
        "--composition",
        "Bad Id",
      ]),
    ).toThrow("--composition must provide one valid installed DocsFab composition identifier.");
  });

  it("admits release-gate and existing-MR delivery on the composition path", () => {
    const composition = ["--composition", "openai-gpt-5.6-sol-pi"];
    const parse = (args: string[]) =>
      parseRunArguments(["review-documentation", "--repo", "repository", ...args]);
    expect(parse([...composition, "--release-gate"])).toMatchObject({
      compositionId: "openai-gpt-5.6-sol-pi",
      releaseGate: true,
    });
    expect(parse([...composition, "--comment-mr", "42"])).toMatchObject({
      compositionId: "openai-gpt-5.6-sol-pi",
      commentMr: "42",
    });
    // Adjacent condition: the path still refuses an unknown option with --composition.
    expect(() => parse([...composition, "--mode", "production"])).toThrow();
  });

  it("keeps a composition write run local unless --draft-mr is passed", () => {
    const createDocumentation = (...flags: string[]) =>
      parseRunArguments([
        "create-documentation",
        "--repo",
        "repository",
        "--instruction",
        "Create the approved guide.",
        ...flags,
      ]);
    const composition = ["--composition", "openai-gpt-5.6-sol-pi"];

    const local = createDocumentation(...composition);
    expect(local).toMatchObject({ allowWrite: true, draftMr: false });
    expect(local.remoteName).toBeUndefined();
    expect(createDocumentation(...composition, "--draft-mr")).toMatchObject({
      allowWrite: true,
      draftMr: true,
      remoteName: "origin",
    });
    // Adjacent condition: the model-profile path still opens a draft MR by default.
    expect(createDocumentation()).toMatchObject({
      allowWrite: true,
      draftMr: true,
      remoteName: "origin",
    });
  });
});

describe("--repo local path (#404 / #406)", () => {
  it("rejects git URLs and still parses directory paths", () => {
    expect(() =>
      parseRunArguments([
        "review-documentation",
        "--repo",
        "https://gitlab.example.com/example-user/mark",
      ]),
    ).toThrow(/local filesystem path/u);
    expect(() =>
      parseRunArguments(["review-documentation", "--repo", "git@host:group/repo.git"]),
    ).toThrow(/local filesystem path/u);
    expect(() =>
      parseRunArguments(["review-documentation", "--repo", "ssh://git@host/group/repo.git"]),
    ).toThrow(/local filesystem path/u);

    expect(parseRunArguments(["review-documentation", "--repo", "repository"]).repositoryPath).toBe(
      resolve("repository"),
    );
    expect(parseRunArguments(["review-documentation", "--repo", "/tmp/docs"]).repositoryPath).toBe(
      resolve("/tmp/docs"),
    );

    expect(() =>
      parseDoArguments([
        "Evaluate the documentation",
        "--repo",
        "https://gitlab.example.com/example-user/mark",
      ]),
    ).toThrow(/local filesystem path/u);
    expect(() =>
      parseDoArguments(["Evaluate the documentation", "--repo", "git@host:group/repo.git"]),
    ).toThrow(/local filesystem path/u);
    expect(
      parseDoArguments(["Evaluate the documentation", "--repo", "repository"]).repositoryPath,
    ).toBe(resolve("repository"));
    expect(
      parseDoArguments(["Evaluate the documentation", "--repo", "/tmp/docs"]).repositoryPath,
    ).toBe(resolve("/tmp/docs"));
  });
});

describe("draft-MR revision policy (#463)", () => {
  it("uses the GitLab target-branch policy only when --revision is omitted", () => {
    expect(
      parseRunArguments([
        "create-documentation",
        "--repo",
        "repository",
        "--instruction",
        "Create the approved guide.",
        "--allow-write",
        "--draft-mr",
      ]),
    ).toMatchObject({ revision: "HEAD", revisionPolicy: "target-branch-head" });
    expect(
      parseRunArguments([
        "create-documentation",
        "--repo",
        "repository",
        "--instruction",
        "Create the approved guide.",
        "--allow-write",
        "--draft-mr",
        "--revision",
        "HEAD",
      ]),
    ).toMatchObject({ revision: "HEAD", revisionPolicy: "checkout-head" });
    expect(
      parseRunArguments([
        "create-documentation",
        "--repo",
        "repository",
        "--instruction",
        "Create the approved guide.",
        "--allow-write",
        "--draft-mr",
        "--revision",
        "origin/main",
      ]),
    ).toMatchObject({ revision: "origin/main", revisionPolicy: "explicit-ref" });
  });

  it("retains checkout HEAD without --draft-mr", () => {
    expect(parseRunArguments(["review-documentation", "--repo", "repository"])).toMatchObject({
      revision: "HEAD",
    });
  });
});

describe("--context-path (#525)", () => {
  it("binds a repository-relative path on review-documentation", () => {
    expect(
      parseRunArguments([
        "review-documentation",
        "--repo",
        "repository",
        "--context-path",
        "docs/about/use-cases.md",
      ]),
    ).toMatchObject({
      workflow: "review-documentation",
      contextTarget: { sourcePath: "docs/about/use-cases.md" },
    });
  });

  it("rejects duplicated context override flags", () => {
    expect(() =>
      parseRunArguments([
        "review-documentation",
        "--repo",
        "repository",
        "--context-path",
        "docs/about/use-cases.md",
        "--context-path",
        "docs/AGENTS.md",
      ]),
    ).toThrow("must not be duplicated");
  });
});

describe("durable knowledge continuation arguments (#761)", () => {
  const base = [
    "create-documentation",
    "--repo",
    "repository",
    "--resume-from",
    "stopped.run:1",
    "--canon-snapshot",
    "answer.json",
    "--allow-write",
    "--accept-candidate-snapshot",
    "--authority-id",
    "product-owner",
  ];

  it("admits a content-free create/update selector with all existing grants", () => {
    const parsed = parseRunArguments(base);
    expect(parsed).toMatchObject({
      workflow: "create-documentation",
      resumeFrom: "stopped.run:1",
      allowWrite: true,
      acceptCandidateSnapshot: true,
      canonSnapshotAuthorityId: "product-owner",
    });
    expect(parsed).not.toHaveProperty("instruction");
    expect(parseRunArguments(["update-documentation", ...base.slice(1)])).toMatchObject({
      workflow: "update-documentation",
      resumeFrom: "stopped.run:1",
    });
  });

  it("rejects unsafe, duplicated, ineligible, or incomplete knowledge selectors", () => {
    expect(() =>
      parseRunArguments(base.map((value, index) => (index === 4 ? "../run" : value))),
    ).toThrow(/safe stopped run id/u);
    expect(() => parseRunArguments([...base, "--resume-from", "other"])).toThrow(
      /must not be duplicated/u,
    );
    expect(() => parseRunArguments(["review-documentation", ...base.slice(1)])).toThrow(
      /only valid/u,
    );
    expect(() => parseRunArguments([...base, "--comment-mr", "17"])).toThrow(
      /does not support --comment-mr/u,
    );
  });

  it("admits read-only review and V2 update answer-record resume and refuses CREATE V3", () => {
    expect(
      parseRunArguments([
        "update-documentation",
        "--repo",
        "repository",
        "--resume-from",
        "stopped.run:1",
        "--allow-write",
      ]),
    ).toMatchObject({ workflow: "update-documentation", resumeFrom: "stopped.run:1" });
    expect(
      parseRunArguments([
        "review-documentation",
        "--repo",
        "repository",
        "--resume-from",
        "stopped.run:1",
      ]),
    ).toMatchObject({ workflow: "review-documentation", resumeFrom: "stopped.run:1" });
    expect(() =>
      parseRunArguments([
        "create-documentation",
        "--repo",
        "repository",
        "--resume-from",
        "stopped.run:1",
        "--allow-write",
      ]),
    ).toThrow(/does not support CREATE V3/u);
  });
});

describe("review recovery action admission (#2579)", () => {
  it.each([
    { revisionArgs: [] },
    { revisionArgs: ["--revision", "HEAD"] },
    { revisionArgs: ["--revision", "abc123"] },
  ])("requires an explicit full revision when rescoping with $revisionArgs", ({ revisionArgs }) => {
    expect(() =>
      parseRunArguments([
        "review-documentation",
        "--repo",
        "repository",
        "--review-target",
        "docs/a.md",
        "--rescope-from",
        "saved-review-run",
        ...revisionArgs,
      ]),
    ).toThrow(/--rescope-from option requires --revision/u);
  });

  it.each([40, 64])("admits a pinned rescope at a %i-hex revision", (length) => {
    const revision = "a".repeat(length);
    expect(
      parseRunArguments([
        "review-documentation",
        "--repo",
        "repository",
        "--review-target",
        "docs/a.md",
        "--rescope-from",
        "saved-review-run",
        "--revision",
        revision,
      ]),
    ).toMatchObject({ rescopeFrom: "saved-review-run", revision });
  });

  it("rejects a command that selects resume and rescope together", () => {
    expect(() =>
      parseRunArguments([
        "review-documentation",
        "--repo",
        "repository",
        "--review-target",
        "docs/a.md",
        "--rescope-from",
        "saved-review-run",
        "--resume-from",
        "saved-review-run",
      ]),
    ).toThrow(/--rescope-from option cannot be combined with --resume-from/u);
  });
});

describe("delegated do parser (#880)", () => {
  const request = "Which flag enables JSON output?";

  it("parses --delegate with pilot options and keeps catalog defaults off that path", () => {
    expect(
      parseDoArguments([
        "--delegate",
        request,
        "--repo",
        "/tmp/docs",
        "--no-input",
        "--json",
        "--quiet",
        "--allow-write",
      ]),
    ).toMatchObject({
      request,
      delegate: true,
      noInput: true,
      json: true,
      quiet: true,
      allowWrite: true,
      routeOnly: false,
      dryRun: false,
    });
  });

  it("rejects --delegate with --route-only or --dry-run before provider work", () => {
    expect(() =>
      parseDoArguments(["--delegate", request, "--repo", "/tmp/docs", "--route-only"]),
    ).toThrow(/cannot be combined with --route-only/u);
    expect(() =>
      parseDoArguments(["--delegate", request, "--repo", "/tmp/docs", "--dry-run"]),
    ).toThrow(/cannot be combined with --dry-run/u);
  });

  it("rejects delegated flags whose exact meaning is not preserved", () => {
    expect(() =>
      parseDoArguments(["--delegate", request, "--repo", "/tmp/docs", "--revision", "HEAD"]),
    ).toThrow(/does not accept --revision/u);
    expect(() =>
      parseDoArguments(["--delegate", request, "--repo", "/tmp/docs", "--patch-only"]),
    ).toThrow(/does not accept --patch-only/u);
    expect(() =>
      parseDoArguments(["--delegate", request, "--repo", "/tmp/docs", "--draft-mr"]),
    ).toThrow(/does not accept --draft-mr/u);
    expect(() =>
      parseDoArguments(["--delegate", request, "--repo", "/tmp/docs", "--comment-mr", "!1"]),
    ).toThrow(/does not accept --comment-mr/u);
    expect(() =>
      parseDoArguments(["--delegate", request, "--repo", "/tmp/docs", "--remote", "origin"]),
    ).toThrow(/does not accept --remote/u);
    expect(() =>
      parseDoArguments(["--delegate", request, "--repo", "/tmp/docs", "--instruction", request]),
    ).toThrow(/does not accept --instruction/u);
  });

  it("requires --resume with --answers and rejects a trailing prompt", () => {
    expect(() => parseDoArguments(["--resume", "task:one", "--repo", "/tmp/docs"])).toThrow(
      /requires --answers/u,
    );
    expect(() =>
      parseDoArguments(["--answers", "answers.json", "--delegate", request, "--repo", "/tmp/docs"]),
    ).toThrow(/requires --resume/u);
    expect(() =>
      parseDoArguments([
        "--resume",
        "task:one",
        "--answers",
        "answers.json",
        request,
        "--repo",
        "/tmp/docs",
      ]),
    ).toThrow(/does not accept a quoted outcome/u);
    expect(
      parseDoArguments([
        "--resume",
        "task:one",
        "--answers",
        "answers.json",
        "--repo",
        "/tmp/docs",
        "--json",
      ]),
    ).toMatchObject({
      delegate: true,
      resumeTaskId: "task:one",
      answersPath: "answers.json",
      request: "",
    });
  });

  it("keeps --no-input unknown on catalog do", () => {
    expect(() => parseDoArguments([request, "--repo", "/tmp/docs", "--no-input"])).toThrow(
      /Unknown do option "--no-input"/u,
    );
  });
});

describe("docsfab run unknown option refusal (#985)", () => {
  const repo = "repository";
  const instruction = "Update the Orbit command.";
  const revision = "a".repeat(40);
  const canon = "b".repeat(64);
  const reviewDeliveryUrl = "https://gitlab.example.com/team/docs/-/merge_requests/17";
  const reviewDeliveryArgv = [
    "review-documentation",
    "--repo",
    repo,
    "--change",
    reviewDeliveryUrl,
    "--review-delivery",
    "preview",
    "--review-delivery-target",
    reviewDeliveryUrl,
  ];
  const resumeArgv = [
    "create-documentation",
    "--repo",
    repo,
    "--resume-from",
    "stopped.run:1",
    "--canon-snapshot",
    "answer.json",
    "--allow-write",
    "--accept-candidate-snapshot",
    "--authority-id",
    "product-owner",
  ];
  const documentedArgvByOption: Readonly<Record<string, readonly string[]>> = Object.freeze({
    "--verbose": ["review-documentation", "--repo", repo, "--verbose"],
    "--json": ["review-documentation", "--repo", repo, "--json"],
    "--show-scan": ["review-documentation", "--repo", repo, "--show-scan"],
    "--quiet": ["review-documentation", "--repo", repo, "--quiet"],
    "--study": ["review-documentation", "--repo", repo, "--study"],
    "--dry-run": ["review-documentation", "--repo", repo, "--dry-run"],
    "--experimental-answer-records": [
      "review-documentation",
      "--repo",
      repo,
      "--composition",
      "installed.composition",
      "--experimental-answer-records",
    ],
    "--patch-only": [
      "create-documentation",
      "--repo",
      repo,
      "--instruction",
      instruction,
      "--patch-only",
    ],
    "--release-gate": ["review-documentation", "--repo", repo, "--release-gate"],
    "--allow-write": ["review-documentation", "--repo", repo, "--allow-write"],
    "--draft-mr": [
      "create-documentation",
      "--repo",
      repo,
      "--instruction",
      instruction,
      "--draft-mr",
    ],
    "--comparison-workspace": [
      "update-documentation",
      "--repo",
      repo,
      "--instruction",
      instruction,
      "--comparison-workspace",
    ],
    "--accept-candidate-snapshot": resumeArgv,
    "--composition": [
      "review-documentation",
      "--repo",
      repo,
      "--composition",
      "installed.composition",
    ],
    "--repo": ["review-documentation", "--repo", repo],
    "--instruction": ["create-documentation", "--repo", repo, "--instruction", instruction],
    "--resume-from": resumeArgv,
    "--comment-mr": ["review-documentation", "--repo", repo, "--comment-mr", "88"],
    "--canon-sha256": [
      "review-documentation",
      "--repo",
      repo,
      "--comment-mr",
      "88",
      "--canon-sha256",
      canon,
    ],
    "--remote": [
      "create-documentation",
      "--repo",
      repo,
      "--instruction",
      instruction,
      "--remote",
      "origin",
    ],
    "--revision": ["review-documentation", "--repo", repo, "--revision", "HEAD"],
    "--comparison-base": [
      "update-documentation",
      "--repo",
      repo,
      "--instruction",
      instruction,
      "--revision",
      revision,
      "--comparison-base",
      "c".repeat(40),
    ],
    "--reader-source": [
      "update-documentation",
      "--repo",
      repo,
      "--instruction",
      instruction,
      "--reader-source",
      "public-contract=src/orbit.ts",
    ],
    "--source": [
      "create-documentation",
      "--repo",
      repo,
      "--instruction",
      instruction,
      "--source",
      "docs/a.md",
    ],
    "--pr": ["update-documentation", "--repo", repo, "--instruction", instruction, "--pr", "!813"],
    "--mr": ["update-documentation", "--repo", repo, "--instruction", instruction, "--mr", "!813"],
    "--change": [
      "update-documentation",
      "--repo",
      repo,
      "--instruction",
      instruction,
      "--change",
      "HEAD~1..HEAD",
    ],
    "--context-path": [
      "review-documentation",
      "--repo",
      repo,
      "--context-path",
      "docs/about/use-cases.md",
    ],
    "--review-target": [
      "review-documentation",
      "--repo",
      repo,
      "--review-target",
      "docs/about/use-cases.md",
    ],
    "--review-delivery": reviewDeliveryArgv,
    "--review-delivery-target": reviewDeliveryArgv,
    "--rescope-from": [
      "review-documentation",
      "--repo",
      repo,
      "--review-target",
      "docs/about/use-cases.md",
      "--rescope-from",
      "saved-review-run",
      "--revision",
      revision,
    ],
    "--context-anchor": [
      "review-documentation",
      "--repo",
      repo,
      "--context-path",
      "docs/about/use-cases.md",
      "--context-anchor",
      "heading",
    ],
    "--context-parent-path": [
      "review-documentation",
      "--repo",
      repo,
      "--context-path",
      "docs/about/use-cases.md",
      "--context-parent-path",
      "docs/about.md",
    ],
    "--context-parent-anchor": [
      "review-documentation",
      "--repo",
      repo,
      "--context-path",
      "docs/about/use-cases.md",
      "--context-parent-path",
      "docs/about.md",
      "--context-parent-anchor",
      "parent-heading",
    ],
    "--doc-improvement-campaign": [
      "update-documentation",
      "--repo",
      repo,
      "--revision",
      revision,
      "--allow-write",
      "--doc-improvement-campaign",
      "private-campaign",
      "--reviewer-policy",
      "reviewers.json",
    ],
    "--reviewer-policy": [
      "update-documentation",
      "--repo",
      repo,
      "--revision",
      revision,
      "--allow-write",
      "--doc-improvement-campaign",
      "private-campaign",
      "--reviewer-policy",
      "reviewers.json",
    ],
    "--canon-snapshot": [
      "create-documentation",
      "--repo",
      repo,
      "--instruction",
      instruction,
      "--canon-snapshot",
      "answer.json",
    ],
    "--authority-id": resumeArgv,
  });

  it.each([
    ["misspelled long option", "--verbos"],
    ["bare =VALUE form", "--json=true"],
    ["truncated or merged form", "--jsontrue"],
  ] as const)("refuses a %s with the coded unknown-option stop", (_kind, token) => {
    let raised: unknown;
    try {
      parseRunArguments(["review-documentation", "--repo", repo, token]);
    } catch (error) {
      raised = error;
    }
    expect((raised as { code?: string }).code).toBe("unknown-option");
    expect((raised as Error).message).toBe(RUN_OPTION_REFUSALS["unknown-option"]);
    for (const option of RUN_ACCEPTED_OPTIONS) {
      expect((raised as Error).message).toContain(option);
    }
  });

  it("still parses every documented run option", () => {
    expect(Object.keys(documentedArgvByOption).sort()).toEqual([...RUN_ACCEPTED_OPTIONS].sort());
    for (const option of RUN_ACCEPTED_OPTIONS) {
      const argv = documentedArgvByOption[option];
      expect(argv, option).toBeDefined();
      expect(argv).toContain(option);
      expect(() => parseRunArguments([...argv!]), option).not.toThrow();
    }
  });

  it.each([...RUN_OPTION_REFUSAL_CODES])(
    "names a condition and the change that clears it on the %s stop",
    (code) => {
      const message = RUN_OPTION_REFUSALS[code];
      expect(message).not.toContain(code);
      const sentences = message.split(". ").filter((part) => part.trim().length > 0);
      expect(sentences.length).toBeGreaterThanOrEqual(2);
      expect(sentences.at(-1)).toMatch(/^(?:Write|Pass|Use|Name|Run|Correct)\b/u);
      expect(message.endsWith(".")).toBe(true);
    },
  );

  it("keeps attached source and selector forms consumed rather than unknown", () => {
    expect(
      parseRunArguments([
        "create-documentation",
        "--repo",
        repo,
        "--instruction",
        instruction,
        "--source=docs/a.md",
      ]).sourcePaths,
    ).toEqual(["docs/a.md"]);
    expect(
      parseRunArguments([
        "update-documentation",
        "--repo",
        repo,
        "--instruction",
        instruction,
        "--pr=!813",
      ]).changeRequestSelector,
    ).toMatchObject({ number: 813 });
  });

  it("still names the dedicated --changed-path refusal rather than unknown-option", () => {
    let raised: unknown;
    try {
      parseRunArguments(["review-documentation", "--repo", repo, "--changed-path", "src/a.ts"]);
    } catch (error) {
      raised = error;
    }
    expect((raised as { code?: string }).code).not.toBe("unknown-option");
    expect((raised as Error).message).toContain("The --changed-path option is not supported");
  });
});
