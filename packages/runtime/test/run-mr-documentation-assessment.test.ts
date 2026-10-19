// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

import {
  buildInstruction,
  minimizeWorkflowJson,
  parseMergeCommitIdentity,
  resolveAssessmentRevisions,
  resolveChangeIdentity,
  resolveChangedPaths,
  runMrDocumentationAssessment,
  scrub,
  scrubDeep,
  unresolvedOutcome,
  usableCommitBeforeSha,
  type ExecuteFn,
} from "../scripts/run-mr-documentation-assessment.js";
import { temporaryRoots } from "./helpers/temp.js";
import { commitFixture, git, initFixtureRepo } from "./helpers/git.js";
import { jobNames, matchesCiPath, readGitlabCiConfig } from "./helpers/gitlab-ci.js";
import { internalOnly } from "./helpers/internal-path.js";

const roots = temporaryRoots();
const gitlabCi = internalOnly(
  ".gitlab/ci",
  "it pins the GitLab CI definition, which is not exported",
);
const previousExitCode = process.exitCode;

afterEach(async () => {
  process.exitCode = previousExitCode;
});

function scratch(prefix: string): Promise<string> {
  return roots.create(prefix, { realpath: true });
}

function gitListing(paths: readonly string[]): ExecuteFn {
  return async (file) => {
    if (file !== "git") {
      throw new Error(`unexpected executable ${file}`);
    }
    return { stdout: `${paths.join("\n")}\n`, stderr: "" };
  };
}

describe("MR documentation assessment credential scrubbing", () => {
  it("redacts assigned secrets, bearer tokens, and bare keys without keeping a prefix", () => {
    const assigned = "API_KEY=supersecretvalue99";
    const bearer = "Authorization: Bearer abcdefghijklmnopqrstuvwx";
    const bareBearer = "Bearer abcdefghijklmnopqrstuvwx";
    const nvapi = `nvapi-${"A".repeat(24)}`;
    const openai = "sk-testplaceholderkeyvalue";
    const combined = [assigned, bearer, bareBearer, nvapi, openai].join("\n");
    const cleaned = scrub(combined);
    expect(cleaned).not.toMatch(
      /supersecretvalue99|abcdefghijklmnop|AAAAAAAAAAAAAAAA|sk-testplaceholder/u,
    );
    expect(cleaned).not.toContain(combined.slice(0, 12));
    expect(cleaned).toMatch(/\[REDACTED/u);
  });

  it("scrubs pathResolution, mergeRequest title, outcome, decision, and raw together", () => {
    const token = "abcdefghijklmnopqrstuvwx";
    const cleaned = JSON.stringify(
      scrubDeep({
        pathResolution: { reason: `diff failed Bearer ${token}` },
        mergeRequest: { title: `rotate nvapi-${"B".repeat(24)}` },
        outcome: "token=supersecretvalue99",
        decision: `Authorization: Bearer ${token}`,
        raw: { prompt: "sk-testplaceholderkeyvalue", steps: ["full unsanitized workflow"] },
      }),
    );
    expect(cleaned).not.toMatch(
      /abcdefghijklmnopqrstuvwx|BBBBBBBBBBBBBBBBBBBBBBBB|supersecretvalue99|sk-testplaceholder/u,
    );
  });
});

describe("MR documentation assessment path bind", () => {
  it("keeps every extractor-eligible path and does not invent a clip", async () => {
    const paths = Array.from(
      { length: 50 },
      (_, index) => `src/file-${String(index).padStart(2, "0")}.ts`,
    );
    const resolution = await resolveChangedPaths({
      repositoryRoot: "/repo",
      diffBaseSha: "abc123",
      sourceSha: "def456",
      execute: gitListing([...paths, "docs/guide.md"]),
    });
    expect(resolution.status).toBe("resolved");
    expect(resolution.sourcePaths).toEqual([...paths, "docs/guide.md"]);
    expect(resolution.sourcePaths).toHaveLength(51);
    expect(resolution.skippedPaths).toEqual([]);
    expect(resolution).not.toHaveProperty("truncated");
  });
});

describe("MR documentation assessment source revision", () => {
  it("asks git for BASE SOURCE, not the working tree", async () => {
    let gitArgs: string[] = [];
    const resolution = await resolveChangedPaths({
      repositoryRoot: "/repo",
      diffBaseSha: "base-sha",
      sourceSha: "source-sha",
      execute: async (_file, args) => {
        gitArgs = [...args];
        return { stdout: "src/changed.ts\n", stderr: "" };
      },
    });
    expect(gitArgs).toEqual([
      "diff",
      "--name-only",
      "--diff-filter=ACMR",
      "base-sha",
      "source-sha",
      "--",
      ".",
    ]);
    expect(resolution.sourcePaths).toEqual(["src/changed.ts"]);
  });

  it("refuses to resolve against the working tree when the source SHA is missing", async () => {
    let invoked = false;
    const resolution = await resolveChangedPaths({
      repositoryRoot: "/repo",
      diffBaseSha: "base-sha",
      sourceSha: undefined,
      execute: async () => {
        invoked = true;
        return { stdout: "target-only.ts\n", stderr: "" };
      },
    });
    expect(invoked).toBe(false);
    expect(resolution.status).toBe("no-source-sha");
    expect(resolution.sourcePaths).toEqual([]);
    expect(resolution.skippedPaths).toEqual([]);
  });

  it("returns only source-side paths when the target has independently advanced", async () => {
    const repository = await scratch("docsfab-mr-assess-merged-results-");
    const baseSha = await initFixtureRepo(
      repository,
      { "shared.ts": "export const shared = 1;\n" },
      { message: "base" },
    );

    await git(repository, ["checkout", "-b", "source"]);
    await writeFile(join(repository, "source-only.ts"), "export const sourceOnly = 1;\n");
    const sourceSha = await commitFixture(repository, "source change");

    await git(repository, ["checkout", "-b", "target", baseSha]);
    await writeFile(join(repository, "target-only.ts"), "export const targetOnly = 1;\n");
    await commitFixture(repository, "target advance");

    await git(repository, ["checkout", "-b", "merge-result"]);
    await git(repository, ["merge", "--no-ff", "--no-edit", "-m", "merged results", "source"]);

    const workingTreeDiff = await git(repository, [
      "diff",
      "--name-only",
      "--diff-filter=ACMR",
      baseSha,
      "--",
      ".",
    ]);
    expect(workingTreeDiff.split("\n").filter(Boolean).sort()).toEqual([
      "source-only.ts",
      "target-only.ts",
    ]);

    const baseToSource = await git(repository, [
      "diff",
      "--name-only",
      "--diff-filter=ACMR",
      baseSha,
      sourceSha,
      "--",
      ".",
    ]);
    expect(baseToSource.split("\n").filter(Boolean)).toEqual(["source-only.ts"]);

    const resolution = await resolveChangedPaths({
      repositoryRoot: repository,
      diffBaseSha: baseSha,
      sourceSha,
    });
    expect(resolution.status).toBe("resolved");
    expect(resolution.sourcePaths).toEqual(["source-only.ts"]);
    expect(resolution.sourcePaths).not.toContain("target-only.ts");
    expect(resolution.changedPathCount).toBe(1);
  });
});

describe("MR documentation assessment wrapper", () => {
  it("writes result.json for a missing credential and does not invoke the workflow", async () => {
    const stage = await scratch("docsfab-mr-assess-missing-");
    let invokedWorkflow = false;
    const artifact = (await runMrDocumentationAssessment({
      env: {
        MR_ASSESSMENT_STAGE_DIR: stage,
        CI_PROJECT_DIR: stage,
        CI_MERGE_REQUEST_IID: "1005",
        CI_MERGE_REQUEST_TITLE: `secret nvapi-${"C".repeat(24)}`,
        CI_MERGE_REQUEST_TARGET_BRANCH: "main",
        CI_MERGE_REQUEST_DIFF_BASE_SHA: "base",
        CI_MERGE_REQUEST_SOURCE_BRANCH_SHA: "source",
        DOCSFAB_CONFIG_ROOT: join(stage, "missing-config"),
      },
      execute: async (file, args) => {
        if (file === "git") {
          return { stdout: "src/cli.ts\ndocs/guide.md\n", stderr: "" };
        }
        invokedWorkflow = true;
        throw new Error(`workflow should not run: ${args.join(" ")}`);
      },
      credentialPrepared: async () => false,
      now: () => new Date("2026-09-22T00:00:00.000Z"),
    })) as Record<string, unknown>;
    const onDisk = JSON.parse(await readFile(join(stage, "result.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(invokedWorkflow).toBe(false);
    expect(process.exitCode).toBe(1);
    expect(artifact.status).toBe("insufficient-evidence");
    expect(onDisk.status).toBe("insufficient-evidence");
    // The reason must name the copied-key dependency, not steer the operator
    // towards restoring a copy removed on purpose, and must not invent a secret-store
    // migration product decision.
    expect(String(onDisk.reason)).toMatch(/no secret-store credential path/u);
    expect(String(onDisk.reason)).toContain("#1087");
    expect(String(onDisk.reason)).toMatch(/has not chosen a Vault push binding/u);
    expect(String(onDisk.reason)).not.toMatch(/configuration problem/u);
    expect(String(onDisk.reason)).not.toMatch(/migrating this job onto the secret store/u);
    expect(JSON.stringify(onDisk)).not.toMatch(/nvapi-|CCCCCCCC/u);
    const resolution = onDisk.pathResolution as { sourcePaths: string[]; skippedPaths: string[] };
    expect(resolution.sourcePaths).toEqual(["src/cli.ts", "docs/guide.md"]);
    expect(resolution.skippedPaths).toEqual([]);
  });

  it("refuses with a coded status and non-zero exit when the before-SHA is unusable", async () => {
    // A zeroed CI_COMMIT_BEFORE_SHA names no change set. Without a top-level
    // code and a non-zero exit, the artifact reads as a completed assessment
    // whose workflows happened to be skipped, under allow_failure: true.
    const stage = await scratch("docsfab-mr-assess-zero-before-");
    let invokedWorkflow = false;
    const artifact = (await runMrDocumentationAssessment({
      env: {
        MR_ASSESSMENT_STAGE_DIR: stage,
        CI_PROJECT_DIR: stage,
        CI_COMMIT_BEFORE_SHA: "0".repeat(40),
        CI_COMMIT_SHA: "landed-sha",
        DOCSFAB_CONFIG_ROOT: join(stage, "config"),
      },
      execute: async (file) => {
        if (file === "git") throw new Error("git must not run without a diff base");
        invokedWorkflow = true;
        throw new Error("workflow must not run without a change set");
      },
      credentialPrepared: async () => true,
      now: () => new Date("2026-09-22T00:00:00.000Z"),
    })) as Record<string, unknown>;
    const onDisk = JSON.parse(await readFile(join(stage, "result.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(invokedWorkflow).toBe(false);
    expect(process.exitCode).toBe(1);
    expect(artifact.status).toBe("no-change-set");
    expect(onDisk.status).toBe("no-change-set");
    // Must not be conflated with the missing-credential outcome.
    expect(onDisk.status).not.toBe("insufficient-evidence");
    expect(String(onDisk.reason)).toMatch(/all-zeros/u);
    const resolution = onDisk.pathResolution as { status: string };
    expect(resolution.status).toBe("no-diff-base");
    const workflows = onDisk.workflows as { status: string; outcome: unknown }[];
    for (const workflow of workflows) {
      expect(workflow.status).toBe("skipped");
      expect(workflow.outcome).toBe("no-change-set");
    }
  });

  it("invokes update-documentation against the checkout when no path is extractor-eligible", async () => {
    const stage = await scratch("docsfab-mr-assess-zero-");
    const captured: string[][] = [];
    await runMrDocumentationAssessment({
      env: {
        MR_ASSESSMENT_STAGE_DIR: stage,
        CI_PROJECT_DIR: stage,
        CI_MERGE_REQUEST_IID: "1005",
        CI_MERGE_REQUEST_TITLE: "docs only",
        CI_MERGE_REQUEST_TARGET_BRANCH: "main",
        CI_MERGE_REQUEST_DIFF_BASE_SHA: "base",
        CI_MERGE_REQUEST_SOURCE_BRANCH_SHA: "source",
        DOCSFAB_CONFIG_ROOT: join(stage, "config"),
      },
      execute: async (file, args) => {
        if (file === "git") {
          return { stdout: "docs/guide.rst\nREADME.rst\n", stderr: "" };
        }
        captured.push([...args]);
        return {
          stdout: JSON.stringify({
            kind: "docsfab-run-result",
            execution: { runId: "run-1", status: "succeeded", exitCode: 0 },
            editorial: { outcome: "no-change", decision: "keep" },
            product: { disposition: "no-change" },
            secretDump: "full unsanitized workflow JSON",
          }),
          stderr: "",
        };
      },
      credentialPrepared: async () => true,
      now: () => new Date("2026-09-22T00:00:00.000Z"),
    });
    expect(captured).toHaveLength(1);
    const args = captured[0] ?? [];
    expect(args).toContain("update-documentation");
    expect(args).toContain("--patch-only");
    expect(args).not.toContain("--source");
    expect(args).not.toContain("--comment-mr");
    expect(args).not.toContain("--draft-mr");
    const onDisk = JSON.parse(await readFile(join(stage, "result.json"), "utf8")) as {
      workflows: Array<{ status: string; outcome: string; raw: Record<string, unknown> }>;
    };
    expect(onDisk.workflows[0]?.status).toBe("completed");
    expect(onDisk.workflows[0]?.outcome).toBe("no-change");
    expect(onDisk.workflows[0]?.raw).not.toHaveProperty("secretDump");
    expect(onDisk.workflows[0]?.raw).toMatchObject({ runId: "run-1", outcome: "no-change" });
  });

  it("passes an eligible Markdown path as --source to update-documentation", async () => {
    const stage = await scratch("docsfab-mr-assess-markdown-source-");
    const captured: string[][] = [];
    await runMrDocumentationAssessment({
      env: {
        MR_ASSESSMENT_STAGE_DIR: stage,
        CI_PROJECT_DIR: stage,
        CI_MERGE_REQUEST_IID: "1005",
        CI_MERGE_REQUEST_TITLE: "docs update",
        CI_MERGE_REQUEST_TARGET_BRANCH: "main",
        CI_MERGE_REQUEST_DIFF_BASE_SHA: "base",
        CI_MERGE_REQUEST_SOURCE_BRANCH_SHA: "source",
        DOCSFAB_CONFIG_ROOT: join(stage, "config"),
      },
      execute: async (file, args) => {
        if (file === "git") return { stdout: "docs/guide.md\n", stderr: "" };
        captured.push([...args]);
        return {
          stdout: JSON.stringify({
            kind: "docsfab-run-result",
            execution: { runId: "run-markdown", status: "succeeded", exitCode: 0 },
            editorial: { outcome: "no-change", decision: "keep" },
            product: { disposition: "no-change" },
          }),
          stderr: "",
        };
      },
      credentialPrepared: async () => true,
      now: () => new Date("2026-09-22T00:00:00.000Z"),
    });
    expect(captured).toHaveLength(1);
    const args = captured[0] ?? [];
    expect(args).toContain("update-documentation");
    expect(args).toContain("--patch-only");
    const sourceIndex = args.indexOf("--source");
    expect(sourceIndex).toBeGreaterThanOrEqual(0);
    expect(args[sourceIndex + 1]).toBe("docs/guide.md");
    expect(args.filter((argument) => argument === "--source")).toHaveLength(1);
  });

  it("stages a scrubbed patch instead of copying unsanitized bytes", async () => {
    const stage = await scratch("docsfab-mr-assess-patch-");
    const patchPath = join(stage, "upstream.patch");
    const secret = `nvapi-${"D".repeat(24)}`;
    await writeFile(
      patchPath,
      `diff --git a/a b/a\n+Bearer abcdefghijklmnopqrstuvwx\n+${secret}\n`,
    );
    await runMrDocumentationAssessment({
      env: {
        MR_ASSESSMENT_STAGE_DIR: stage,
        CI_PROJECT_DIR: stage,
        CI_MERGE_REQUEST_IID: "1005",
        CI_MERGE_REQUEST_DIFF_BASE_SHA: "base",
        CI_MERGE_REQUEST_SOURCE_BRANCH_SHA: "source",
        DOCSFAB_CONFIG_ROOT: join(stage, "config"),
      },
      execute: async (file) => {
        if (file === "git") {
          return { stdout: "src/cli.ts\n", stderr: "" };
        }
        return {
          stdout: JSON.stringify({
            kind: "docsfab-run-result",
            execution: {
              runId: "run-2",
              status: "succeeded",
              exitCode: 0,
              patchPath,
            },
            editorial: { outcome: "update" },
          }),
          stderr: "",
        };
      },
      credentialPrepared: async () => true,
      now: () => new Date("2026-09-22T00:00:00.000Z"),
    });
    const staged = await readFile(join(stage, "update-documentation.patch"), "utf8");
    expect(staged).not.toMatch(/abcdefghijklmnopqrstuvwx|nvapi-DDDD/u);
    expect(staged).toMatch(/\[REDACTED/u);
  });
});

describe("MR documentation assessment helpers", () => {
  it("describes a documentation-only bind when no --source paths exist", () => {
    expect(
      buildInstruction({
        iid: "1005",
        title: "docs",
        targetBranch: "main",
        sourcePathCount: 0,
      }),
    ).toMatch(/No changed path matched a supported --source extractor/u);
  });

  it("drops unsanitized workflow fields from the retained raw projection", () => {
    expect(
      minimizeWorkflowJson({
        kind: "docsfab-run-result",
        execution: {
          runId: "run-3",
          status: "succeeded",
          exitCode: 0,
          patchPath: "/tmp/secret.patch",
        },
        editorial: { outcome: "no-change", decision: "keep" },
        product: { disposition: "no-change" },
        prompt: "full unsanitized workflow JSON",
      }),
    ).toEqual({
      kind: "docsfab-run-result",
      runId: "run-3",
      status: "succeeded",
      exitCode: 0,
      disposition: "no-change",
      outcome: "no-change",
      decision: "keep",
    });
  });
});

describe("MR assessment revision selection (#1087)", () => {
  it("uses the default-branch push pair when no merge-request variables exist", () => {
    expect(
      resolveAssessmentRevisions({
        CI_COMMIT_BEFORE_SHA: "before-sha",
        CI_COMMIT_SHA: "landed-sha",
      }),
    ).toEqual({ diffBaseSha: "before-sha", sourceSha: "landed-sha" });
  });

  it("prefers the merge-request pair and never substitutes the merged-results SHA", () => {
    // CI_COMMIT_SHA is the merged-results commit on an MR pipeline. Using it
    // as the source would contribute target-only paths.
    expect(
      resolveAssessmentRevisions({
        CI_MERGE_REQUEST_DIFF_BASE_SHA: "mr-base",
        CI_MERGE_REQUEST_SOURCE_BRANCH_SHA: "mr-source",
        CI_COMMIT_BEFORE_SHA: "before-sha",
        CI_COMMIT_SHA: "merged-results-sha",
      }),
    ).toEqual({ diffBaseSha: "mr-base", sourceSha: "mr-source" });
  });

  it("does not mix the two pairs when the merge-request pair is half-present", () => {
    // A half-set MR pair must resolve to a missing half, not silently borrow
    // CI_COMMIT_SHA from the push pair.
    expect(
      resolveAssessmentRevisions({
        CI_MERGE_REQUEST_DIFF_BASE_SHA: "mr-base",
        CI_COMMIT_SHA: "merged-results-sha",
      }),
    ).toEqual({ diffBaseSha: "mr-base", sourceSha: undefined });
  });

  it("treats an all-zero before-SHA as absent", () => {
    // GitLab zeroes this on schedule, web, and api pipelines and on a
    // branch's first commit.
    expect(usableCommitBeforeSha("0".repeat(40))).toBeUndefined();
    expect(usableCommitBeforeSha("")).toBeUndefined();
    expect(usableCommitBeforeSha(undefined)).toBeUndefined();
    expect(usableCommitBeforeSha("  abc123  ")).toBe("abc123");
  });

  it("codes an unusable before-SHA distinctly from a missing credential", () => {
    // Conflating these would make a zeroed CI_COMMIT_BEFORE_SHA look like a
    // CI/CD variable problem, and vice versa.
    expect(unresolvedOutcome("no-diff-base")).toBe("no-change-set");
    expect(unresolvedOutcome("no-source-sha")).toBe("no-change-set");
    expect(unresolvedOutcome("diff-failed")).toBe("resolution-error");
    expect(unresolvedOutcome("no-diff-base")).not.toBe("insufficient-evidence");
  });

  it("resolves no-diff-base rather than assessing the whole tree", async () => {
    const { diffBaseSha, sourceSha } = resolveAssessmentRevisions({
      CI_COMMIT_BEFORE_SHA: "0".repeat(40),
      CI_COMMIT_SHA: "landed-sha",
    });
    const resolution = await resolveChangedPaths({
      repositoryRoot: "/repo",
      diffBaseSha,
      sourceSha,
      execute: (() => {
        throw new Error("git must not run without a diff base");
      }) as unknown as ExecuteFn,
    });
    expect(resolution.status).toBe("no-diff-base");
    expect(resolution.changedPathCount).toBe(0);
    expect(resolution.reason).toMatch(/all-zeros/u);
  });
});

describe("MR assessment change identity (#1087)", () => {
  const mergeCommit = [
    "Merge branch 'swarm/1086-mr-diff-review-create' into 'main'",
    "",
    "fix(runtime): bind merged-MR diffs for REVIEW and CREATE",
    "",
    "Closes #1086",
    "",
    "See merge request tech-docs/agents/docsfab!1006",
    "",
  ].join("\n");

  it("recovers the merge request from the landed merge commit, offline", () => {
    expect(parseMergeCommitIdentity(mergeCommit)).toEqual({
      iid: "1006",
      title: "fix(runtime): bind merged-MR diffs for REVIEW and CREATE",
      targetBranch: "main",
      source: "merge-commit-message",
    });
  });

  it("claims no merge request for a direct push to the default branch", () => {
    // A non-merge commit must not be reported as a merge request.
    const identity = parseMergeCommitIdentity("fix(runtime): a direct commit\n");
    expect(identity.iid).toBeUndefined();
    expect(identity.targetBranch).toBeUndefined();
    expect(identity.source).toBe("none");
    expect(parseMergeCommitIdentity(undefined).source).toBe("none");
    expect(parseMergeCommitIdentity("   ").source).toBe("none");
  });

  it("does not trust a crafted trailer without GitLab's merge header", () => {
    // Anyone who can put text in a commit body can write this line. Trusting it
    // would label the artifact with someone else's merge request and corrupt the
    // traceability hand review depends on.
    const crafted = [
      "fix(runtime): an ordinary direct commit",
      "",
      "See merge request tech-docs/agents/docsfab!9999",
      "",
    ].join("\n");
    expect(parseMergeCommitIdentity(crafted)).toEqual({
      iid: undefined,
      title: undefined,
      targetBranch: undefined,
      source: "none",
    });
  });

  it("prefers GitLab's own trailer over one planted in the body", () => {
    // GitLab appends its trailer last, after any author-supplied body.
    const planted = [
      "Merge branch 'feature' into 'main'",
      "",
      "feat: a change",
      "",
      "See merge request tech-docs/agents/docsfab!9999",
      "",
      "See merge request tech-docs/agents/docsfab!1006",
      "",
    ].join("\n");
    expect(parseMergeCommitIdentity(planted).iid).toBe("1006");
  });

  it("keeps an author-controlled subject on one line", () => {
    // The subject is quoted into the model instruction, a more privileged
    // position than file content. Control characters there could restructure
    // the surrounding sentence.
    const hostile = [
      "Merge branch 'feature' into 'main'",
      "",
      "feat: a\u0000title\u001bwith\tcontrol chars",
      "",
      "See merge request tech-docs/agents/docsfab!7",
      "",
    ].join("\n");
    const title = parseMergeCommitIdentity(hostile).title ?? "";
    expect(title).toBe("feat: a title with control chars");
    expect(title).not.toMatch(/[\p{Cc}\p{Cf}]/u);

    const instruction = buildInstruction({
      iid: "7",
      title,
      targetBranch: "main",
      sourcePathCount: 1,
      landed: true,
    });
    expect(instruction.split("\n")).toHaveLength(1);
  });

  it("flattens every separator a renderer might treat as a line break", () => {
    // U+2028 and U+2029 are Zl/Zp, not Cc/Cf, so a control-character class alone
    // would leave them intact; U+0085 and U+200B are not matched by a naive
    // [ \t] class. Pinned so neither pass can be narrowed away silently.
    const separators = [
      " ", // LINE SEPARATOR
      " ", // PARAGRAPH SEPARATOR
      "\u0085", // NEXT LINE
      "\u000b", // VERTICAL TAB
      "\u000c", // FORM FEED
      " ", // NO-BREAK SPACE
      "﻿", // ZERO WIDTH NO-BREAK SPACE
      " ", // EN QUAD
      "　", // IDEOGRAPHIC SPACE
      "​", // ZERO WIDTH SPACE
    ];
    for (const separator of separators) {
      const message = [
        "Merge branch 'feature' into 'main'",
        "",
        `feat: before${separator}after`,
        "",
        "See merge request tech-docs/agents/docsfab!7",
        "",
      ].join("\n");
      const title = parseMergeCommitIdentity(message).title;
      expect(title, `separator ${JSON.stringify(separator)}`).toBe("feat: before after");
    }
  });

  it("recovers nothing but the branch from a merge commit with no body", () => {
    const bare = "Merge branch 'feature' into 'main'\n";
    expect(parseMergeCommitIdentity(bare)).toEqual({
      iid: undefined,
      title: undefined,
      targetBranch: "main",
      source: "merge-commit-message",
    });
  });

  it("prefers GitLab's merge-request variables when they exist", () => {
    expect(
      resolveChangeIdentity({
        CI_MERGE_REQUEST_IID: "999",
        CI_MERGE_REQUEST_TITLE: "from variables",
        CI_MERGE_REQUEST_TARGET_BRANCH: "main",
        CI_COMMIT_MESSAGE: mergeCommit,
      }),
    ).toEqual({
      iid: "999",
      title: "from variables",
      targetBranch: "main",
      source: "merge-request-variables",
    });
    expect(resolveChangeIdentity({ CI_COMMIT_MESSAGE: mergeCommit }).source).toBe(
      "merge-commit-message",
    );
  });

  it("does not call a landed change set an open merge request", () => {
    // The push wording must not render "this merge request, merging." on main.
    const landed = buildInstruction({
      iid: undefined,
      title: undefined,
      targetBranch: "main",
      sourcePathCount: 1,
      landed: true,
    });
    expect(landed).toContain("the change set that landed on main");
    expect(landed).not.toMatch(/, merging/u);
    expect(landed).not.toMatch(/this merge request/u);

    expect(
      buildInstruction({
        iid: "1006",
        title: "t",
        targetBranch: "main",
        sourcePathCount: 1,
        landed: true,
      }),
    ).toContain('merge request !1006 ("t") on main');

    // The merge-request-pipeline wording is unchanged.
    expect(
      buildInstruction({
        iid: "1006",
        title: "t",
        targetBranch: "main",
        sourcePathCount: 1,
      }),
    ).toContain('merge request !1006 ("t"), merging into main');
  });
});

describe("MR assessment CI job wiring", () => {
  it.skipIf(gitlabCi.skip)(
    gitlabCi.title("runs on default-branch pushes, not merge-request pipelines (#1087)"),
    async () => {
      const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
      const pipeline = await readFile(join(repositoryRoot, ".gitlab/ci/runtime.yml"), "utf8");
      // Start at the job's descriptive header, not at .rules:, so stale prose in
      // the header cannot survive every assertion here.
      const start = pipeline.indexOf("# Assesses documentation impact");
      const end = pipeline.indexOf("\n# The provider-comparison", start);
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      const job = pipeline.slice(start, end);

      // The header must not describe the open merge request's own diff or an
      // automatic merge_request_event run.
      expect(job).not.toMatch(/CURRENT merge request/u);
      expect(job).not.toMatch(/the \*open\* MR's own diff/u);
      expect(job).not.toMatch(/CI_MERGE_REQUEST_DIFF_BASE_SHA/u);
      expect(job).not.toMatch(/CI_MERGE_REQUEST_SOURCE_BRANCH_SHA/u);
      expect(job).not.toMatch(/runs automatically on\s*#?\s*merge-request pipelines/u);
      // The SHAs reach the unprivileged CI child through
      // config/env-admission.yaml and its generated shell mirror, not a
      // hand-edited append_child_env line in runtime-run.sh under a Path exception.
      expect(job).not.toMatch(/named Path exception/u);
      expect(job).not.toMatch(/one-line append_child_env/u);
      expect(job).toContain("config/env-admission.yaml");
      // Protected CI/CD variables reach protected refs only, so an MR pipeline
      // could never obtain MODEL_API_KEY and would always write
      // insufficient-evidence under allow_failure: true.
      expect(job).toContain('if: $CI_PIPELINE_SOURCE == "push" && $CI_COMMIT_BRANCH');
      expect(job).not.toContain('if: $CI_PIPELINE_SOURCE == "merge_request_event"');
      // Manual until the output is established as trustworthy: an automatic rule
      // would buy an untrusted live run per merge to main.
      expect(job).toMatch(/when: manual/u);
      expect(job).toContain("when: never");
      expect(job).toContain("allow_failure: true");
      expect(job).toContain("when: always");
      expect(job).toContain("scripts/run-mr-documentation-assessment.ts");
      // The default-branch pair, not the merged-results working tree.
      expect(job).toContain("CI_COMMIT_BEFORE_SHA");
      expect(job).not.toContain("confirm this pipeline is running on a protected ref");
      // Its only key source is the copied project variable that the secret-store README
      // retires. The missing-key message must say so, not call it "a CI/CD variable
      // configuration problem", which invites restoring a retired credential.
      expect(job).not.toMatch(/configuration problem/u);
      expect(job).not.toMatch(/only shape in which it can\s*#?\s*actually reach a model/u);
      expect(job).toContain("has no secret-store credential path");
      expect(job).toContain("Do not restore a copied key");
      expect(job).toMatch(/has not chosen a Vault push binding/u);
      expect(job).not.toMatch(/decision note 70891571/u);
      expect(job).not.toMatch(/chosen path/u);
      expect(job).not.toMatch(/exit 1\s*\n\s*fi/u);
      expect(job).toContain("- .runtime_unprivileged");
      expect(job).toContain("- .rules:mr-assessment");
      expect(job).toContain("needs: []");
      // It does not describe assessing the open merge request's diff.
      expect(job).not.toMatch(/this MR's own changed paths/u);
      // Not asserted by string absence: the rules comment names
      // .runtime_downstream to explain why the job must not extend it. The
      // extends list is checked structurally in the next test instead.
    },
  );

  it.skipIf(gitlabCi.skip)(
    gitlabCi.title("is not interruptible and does not retry a spent live run"),
    async () => {
      const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
      const source = await readFile(join(repositoryRoot, ".gitlab/ci/runtime.yml"), "utf8");
      const pipeline = parse(source) as Record<string, GitlabJob>;
      const job = pipeline["runtime:mr-assessment"];

      // The global default is interruptible: true and newer default-branch
      // pipelines cancel older ones. A paid run cancelled mid-workflow uploads no
      // artifact, and the next pipeline's CI_COMMIT_BEFORE_SHA has moved past that
      // change set, so it could not be assessed again.
      expect(job.interruptible).toBe(false);

      // The global default retries stuck_or_timeout_failure, which would spend
      // the model budget a second time for a job that already consumed it.
      expect(job.retry?.when).toEqual(["runner_system_failure"]);
      expect(job.retry?.when).not.toContain("stuck_or_timeout_failure");

      // Job timeout and artifact expiry come from config/limits.yaml through the
      // generated platform-bounds include. Asserted on the parsed job, not a
      // fixed-size text window that would stop covering the job as it grows.
      expect(job.extends).toContain(".ci_live_model_platform_bounds");
      expect(job.timeout).toBeUndefined();
      expect(job.artifacts?.expire_in).toBeUndefined();

      // .runtime_downstream requires runtime:prepare; this job starts
      // independently with needs: [] and runs npm ci itself.
      expect(job.extends).not.toContain(".runtime_downstream");
      expect(job.needs).toEqual([]);

      const bounds = parse(
        await readFile(join(repositoryRoot, ".gitlab/ci/live-model-limits.generated.yml"), "utf8"),
      ) as Record<string, GitlabJob>;
      const platform = bounds[".ci_live_model_platform_bounds"];
      expect(platform.timeout).toMatch(/\d/u);
      expect(platform.artifacts?.expire_in).toMatch(/\d/u);
    },
  );

  it.skipIf(gitlabCi.skip)(
    gitlabCi.title("is omitted from merge-request pipelines entirely"),
    async () => {
      const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
      const pipeline = await readCiPipeline(repositoryRoot);
      const included = includedJobs(pipeline, ["docs/index.md", "fern/docs.yml"]);
      expect(included.has("runtime:mr-assessment")).toBe(false);
    },
  );

  it.skipIf(gitlabCi.skip)(
    gitlabCi.title("is created with satisfiable needs on a default-branch push"),
    async () => {
      const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
      const pipeline = await readCiPipeline(repositoryRoot);
      const included = includedJobs(pipeline, ["docs/index.md"], DEFAULT_BRANCH_PUSH);
      expect(included.has("runtime:mr-assessment")).toBe(true);
      expect(unsatisfiedNeeds(pipeline, included)).toEqual([]);

      // Every matching rule must be manual: an automatic rule would spend a live
      // model run per merge on output not yet established as trustworthy.
      const matching = (pipeline.definitions[".rules:mr-assessment"].rules ?? []).filter(
        (rule) => rule.if && evaluateIf(rule.if, DEFAULT_BRANCH_PUSH),
      );
      expect(matching).not.toHaveLength(0);
      for (const rule of matching) expect(rule.when).toBe("manual");
      // .rules:runtime admits prepare on any default-branch push, so needs: []
      // is a scheduling choice here rather than a creatability requirement.
      expect(included.has("runtime:prepare")).toBe(true);
      expect(pipeline.definitions["runtime:mr-assessment"].needs).toEqual([]);
    },
  );

  it.skipIf(gitlabCi.skip)(
    gitlabCi.title("resolves job variables from extended templates into rule scope"),
    async () => {
      // Positive case for the variable plumbing. runtime:live-model's Vault guard
      // reads VAULT_* values that exist only as job variables inherited from
      // the secret-store credential template. If they did not reach rule scope, or
      // extends did not deep-merge variables, the guard would exclude the job on its
      // one automatic shape; only a case where it is included proves the plumbing.
      const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
      const pipeline = await readCiPipeline(repositoryRoot);
      const merged = mergeGitlabJob(pipeline.definitions, "runtime:live-model");
      expect(merged.variables?.VAULT_SERVER_URL).toBe("https://prod.vault.nvidia.com");
      // The job's own variables survive the merge alongside the template's.
      expect(merged.variables?.PI_OFFLINE).toBe("0");

      const included = includedJobs(pipeline, [], PROTECTED_MAIN_SCHEDULE);
      expect(included.has("runtime:live-model")).toBe(true);
      // Push-only: the schedule shape never selects the assessment job.
      expect(included.has("runtime:mr-assessment")).toBe(false);

      // A project or pipeline variable outranks the template's job variable,
      // so redirecting any Vault connection field trips the `when: never` guard.
      for (const name of [
        "VAULT_SERVER_URL",
        "VAULT_NAMESPACE",
        "VAULT_AUTH_PATH",
        "VAULT_AUTH_ROLE",
      ]) {
        const overridden = includedJobs(pipeline, [], PROTECTED_MAIN_SCHEDULE, {
          [name]: "https://example.invalid",
        });
        expect(overridden.has("runtime:live-model"), name).toBe(false);
      }
      const debug = includedJobs(pipeline, [], PROTECTED_MAIN_SCHEDULE, { CI_DEBUG_TRACE: "true" });
      expect(debug.has("runtime:live-model")).toBe(false);
      // An unprotected ref is excluded by the selection rule itself.
      const unprotected = includedJobs(pipeline, [], {
        ...PROTECTED_MAIN_SCHEDULE,
        CI_COMMIT_REF_PROTECTED: "false",
      });
      expect(unprotected.has("runtime:live-model")).toBe(false);
    },
  );

  it("evaluates rules the way GitLab does for the operators the pipeline uses", () => {
    // Unset variables compare as null: never equal, so != a literal is true.
    expect(evaluateIf('$UNSET != "x"', {})).toBe(true);
    expect(evaluateIf('$UNSET == "x"', {})).toBe(false);
    expect(evaluateIf('$SET != "x"', { SET: "x" })).toBe(false);
    expect(evaluateIf("$A != $B", { A: "main", B: "main" })).toBe(false);
    // Two unset variables are null == null, which GitLab treats as equal.
    expect(evaluateIf("$A == $B", {})).toBe(true);
    expect(evaluateIf("$A != $B", {})).toBe(false);
    // Unset (null) is not the empty string.
    expect(evaluateIf("$A == $B", { B: "" })).toBe(false);
    expect(evaluateIf('$UNSET == ""', {})).toBe(false);
    expect(evaluateIf("$CI_COMMIT_TAG == null", {})).toBe(true);
    expect(evaluateIf("$CI_COMMIT_TAG != null", {})).toBe(false);
    expect(evaluateIf("$CI_COMMIT_TAG == null", { CI_COMMIT_TAG: "" })).toBe(false);
    expect(evaluateIf("$CI_COMMIT_TAG != null", { CI_COMMIT_TAG: "" })).toBe(true);
    expect(evaluateIf("$CI_COMMIT_TAG == null", { CI_COMMIT_TAG: "v1.2.3" })).toBe(false);
    expect(evaluateIf("$CI_COMMIT_TAG != null", { CI_COMMIT_TAG: "v1.2.3" })).toBe(true);
    expect(evaluateIf("$FLAG =~ /^(true|t)$/i", { FLAG: "TRUE" })).toBe(true);
    // !~ negates a match; a variable on the right holds a /pattern/ (the nightly arm selection).
    expect(evaluateIf("$FLAG !~ /^(true|t)$/i", { FLAG: "TRUE" })).toBe(false);
    expect(evaluateIf("$FLAG !~ /^(true|t)$/i", { FLAG: "no" })).toBe(true);
    expect(evaluateIf("$FLAG !~ /^(true|t)$/i", {})).toBe(true);
    const arm = { DOCSFAB_BENCH_NIGHTLY_ARM_PATTERN: "/(^|,) *docsfab-do *(,|$)/" };
    const selection =
      "$DOCSFAB_BENCH_NIGHTLY_ARMS =~ /.+/ && $DOCSFAB_BENCH_NIGHTLY_ARMS !~ $DOCSFAB_BENCH_NIGHTLY_ARM_PATTERN";
    expect(evaluateIf(selection, { ...arm, DOCSFAB_BENCH_NIGHTLY_ARMS: "skills-agent" })).toBe(
      true,
    );
    expect(
      evaluateIf(selection, { ...arm, DOCSFAB_BENCH_NIGHTLY_ARMS: "basic-agent, docsfab-do" }),
    ).toBe(false);
    expect(evaluateIf(selection, { ...arm, DOCSFAB_BENCH_NIGHTLY_ARMS: "" })).toBe(false);
    expect(evaluateIf(selection, arm)).toBe(false);
    expect(evaluateIf("$A =~ $P", { A: "docsfab-do", P: "/^docsfab/" })).toBe(true);
    expect(evaluateIf("$A !~ $P", { A: "docsfab-do" })).toBe(true);
    expect(() => evaluateIf("$A =~ $P", { A: "x", P: "not a pattern" })).toThrow(
      /Unsupported CI rule expression/u,
    );
    expect(evaluateIf("$http_proxy", { http_proxy: "http://proxy.invalid" })).toBe(true);
    expect(evaluateIf("$http_proxy", { http_proxy: "yes", HTTP_PROXY: "" })).toBe(true);
    expect(evaluateIf("$HTTP_PROXY", { http_proxy: "yes", HTTP_PROXY: "" })).toBe(false);
    expect(evaluateIf("$http_proxy != $HTTP_PROXY", { http_proxy: "yes", HTTP_PROXY: "" })).toBe(
      true,
    );
    expect(evaluateIf('$http_proxy != ""', { http_proxy: "http://proxy.invalid" })).toBe(true);
    expect(evaluateIf('$runner2 == "linux"', { runner2: "linux" })).toBe(true);
    expect(evaluateIf("$lower_case == $other2", { lower_case: "same", other2: "same" })).toBe(true);
    expect(evaluateIf("$http_proxy =~ /^http/i", { http_proxy: "http://proxy.invalid" })).toBe(
      true,
    );
    expect(evaluateIf("$http_proxy", {})).toBe(false);
    expect(evaluateIf("$http_proxy", { http_proxy: "" })).toBe(false);
    expect(evaluateIf('$proxy_2 == "ready"', { proxy_2: "ready" })).toBe(true);
    expect(evaluateIf('$proxy_2 != "ready"', {})).toBe(true);
    expect(evaluateIf("$mixedCase_3 == $other_4", { mixedCase_3: "x", other_4: "x" })).toBe(true);
    expect(
      evaluateIf("$http_proxy =~ /^http:/", { http_proxy: "http://proxy.example.invalid" }),
    ).toBe(true);
    expect(
      evaluateIf("($http_proxy || $HTTPS_PROXY) && $env_2", {
        http_proxy: "",
        HTTPS_PROXY: "http://proxy.example.invalid",
        env_2: "1",
      }),
    ).toBe(true);
    expect(() => evaluateIf("$1INVALID", { "1INVALID": "x" })).toThrow(/Unsupported CI rule/u);
    expect(() => evaluateIf("$bad-name", { "bad-name": "x" })).toThrow(/Unsupported CI rule/u);
    expect(() => evaluateIf("$A < 1", { A: "0" })).toThrow(/Unsupported CI rule/u);
    expect(() => evaluateIf("$invalid-name", { invalid: "value" })).toThrow(/Unsupported CI rule/u);
  });
});

describe.skipIf(gitlabCi.skip)(
  gitlabCi.title("GitLab CI needs across every loaded include"),
  () => {
    const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");

    async function mutatedPipeline(
      mutate: (definitions: Record<string, GitlabJob>) => void,
    ): Promise<CiPipeline> {
      const config = await readGitlabCiConfig(repositoryRoot);
      const definitions = structuredClone(config.definitions) as Record<string, GitlabJob>;
      mutate(definitions);
      return ciPipelineFrom(definitions, jobNames({ ...config, definitions }));
    }

    it("resolves every non-optional need to a job the same pipeline creates, in every pipeline type", async () => {
      const pipeline = await readCiPipeline(repositoryRoot);
      // Positive control: the model sees jobs from every include, and each
      // pipeline type creates some of them.
      for (const job of [
        "runtime:package:verify",
        "process:mr-hygiene",
        "docs:check",
        "secret_detection",
      ]) {
        expect(pipeline.jobs.has(job), job).toBe(true);
      }
      for (const [type, predefined] of Object.entries(PIPELINE_TYPES)) {
        expect(includedJobs(pipeline, EVERY_PATH, predefined).size, type).toBeGreaterThan(0);
      }
      expect(unsatisfiedNeedsAcrossPipelines(pipeline)).toEqual([]);
    });

    it("refuses a need on a job another include creates only in merge-request pipelines", async () => {
      const pipeline = await mutatedPipeline((definitions) => {
        definitions["runtime:package:verify"].needs = [
          ...(definitions["runtime:package:verify"].needs ?? []),
          "process:mr-hygiene",
        ];
      });
      const found = unsatisfiedNeedsAcrossPipelines(pipeline);
      expect(found).toContain(
        "main push: runtime:package:verify needs process:mr-hygiene, which rules omitted (changed: [])",
      );
      expect(found).toContain(
        "release tag: runtime:package:verify needs process:mr-hygiene, which rules omitted (changed: [])",
      );
    });

    it("refuses a need on a job whose rules only a GitLab template defines", async () => {
      const pipeline = await mutatedPipeline((definitions) => {
        definitions["runtime:package:verify"].needs = [
          ...(definitions["runtime:package:verify"].needs ?? []),
          "sast",
        ];
      });
      expect(unsatisfiedNeedsAcrossPipelines(pipeline)).toContain(
        "main push: runtime:package:verify needs sast, whose rules only a GitLab template defines (changed: [])",
      );
    });

    it("refuses to model an overlay-only job that is not on the externally defined list", async () => {
      await expect(
        mutatedPipeline((definitions) => {
          definitions["docs:fern-preview"] = { needs: [] };
        }),
      ).rejects.toThrow(
        "docs:fern-preview has no script or trigger, so a template or component defines it; add it to EXTERNALLY_DEFINED_JOBS",
      );
    });

    it("takes a component job's rules from its include inputs", async () => {
      const pipeline = await readCiPipeline(repositoryRoot);
      const created = (type: string) => includedJobs(pipeline, EVERY_PATH, PIPELINE_TYPES[type]);
      expect(created("release tag").has("docs:fern-publish")).toBe(true);
      expect(created("pre-release tag").has("docs:fern-publish")).toBe(false);
      expect(created("main push").has("docs:fern-publish")).toBe(false);
      expect(created("main push").has("docs:fern-main")).toBe(true);
      expect(created("merge request").has("docs:fern-main")).toBe(false);
    });
  },
);

describe("GitLab CI rules:changes globs", () => {
  it("matches the way GitLab's fnmatch does for the patterns the pipeline uses", () => {
    expect(matchesCiPath("AGENTS.md", "**/AGENTS.md")).toBe(true);
    expect(matchesCiPath("packages/runtime/AGENTS.md", "**/AGENTS.md")).toBe(true);
    expect(matchesCiPath("packages/runtime/AGENTS.md.bak", "**/AGENTS.md")).toBe(false);
    expect(matchesCiPath("notes/worker.md", "notes/**/*.md")).toBe(true);
    expect(matchesCiPath("notes/a/b/worker.md", "notes/**/*.md")).toBe(true);
    expect(matchesCiPath("notes/worker.txt", "notes/**/*.md")).toBe(false);
    expect(matchesCiPath("packages/runtime/src/a.ts", "packages/runtime/**/*")).toBe(true);
    expect(matchesCiPath("packages/runtime", "packages/runtime/**/*")).toBe(false);
    expect(matchesCiPath("packages/runtimex/a.ts", "packages/runtime/**/*")).toBe(false);
    expect(matchesCiPath(".gitlab-ci.yml", ".gitlab-ci.yml")).toBe(true);
    expect(matchesCiPath("xgitlab-ci.yml", ".gitlab-ci.yml")).toBe(false);
    expect(() => matchesCiPath("a", "docs/{a,b}.md")).toThrow(
      "Unsupported rules:changes pattern: docs/{a,b}.md",
    );
  });
});

describe("GitLab CI if: quoted string comparison", () => {
  const prodVault = "https://prod.vault.nvidia.com";
  const vaultMismatch = `$VAULT_SERVER_URL != "${prodVault}"`;
  const vaultMatch = `$VAULT_SERVER_URL == "${prodVault}"`;
  const liveModelVaultGuard =
    '$VAULT_SERVER_URL != "https://prod.vault.nvidia.com" || $VAULT_NAMESPACE != "swgpu-docsfab" || $VAULT_AUTH_PATH != "jwt/docsfab-ci" || $VAULT_AUTH_ROLE != "docsfab-ci-model-main"';

  it("treats an unset variable as null for quoted !=", () => {
    expect(evaluateIf(vaultMismatch, {})).toBe(true);
    expect(evaluateIf(vaultMismatch, MERGE_REQUEST_PIPELINE)).toBe(true);
    expect(evaluateIf(vaultMismatch, DEFAULT_BRANCH_PUSH)).toBe(true);
  });

  it("is false for quoted != when the variable equals the literal", () => {
    expect(evaluateIf(vaultMismatch, { VAULT_SERVER_URL: prodVault })).toBe(false);
  });

  it("is true for quoted != when the variable differs from the literal", () => {
    expect(evaluateIf(vaultMismatch, { VAULT_SERVER_URL: "https://example.invalid" })).toBe(true);
  });

  it("matches quoted == only when the variable equals the literal", () => {
    expect(evaluateIf(vaultMatch, { VAULT_SERVER_URL: prodVault })).toBe(true);
    expect(evaluateIf(vaultMatch, {})).toBe(false);
    expect(evaluateIf(vaultMatch, { VAULT_SERVER_URL: "https://example.invalid" })).toBe(false);
  });

  it("evaluates the live-model vault guard without throwing", () => {
    expect(evaluateIf(liveModelVaultGuard, DEFAULT_BRANCH_PUSH)).toBe(true);
    expect(
      evaluateIf(liveModelVaultGuard, {
        VAULT_SERVER_URL: prodVault,
        VAULT_NAMESPACE: "swgpu-docsfab",
        VAULT_AUTH_PATH: "jwt/docsfab-ci",
        VAULT_AUTH_ROLE: "docsfab-ci-model-main",
      }),
    ).toBe(false);
  });
});

type GitlabNeed = string | { job: string; optional?: boolean };
type GitlabRule = {
  if?: string;
  when?: string;
  changes?: { paths?: string[] };
};
type GitlabJob = {
  extends?: string | string[];
  variables?: Record<string, string>;
  needs?: GitlabNeed[];
  rules?: GitlabRule[];
  script?: unknown;
  trigger?: unknown;
  interruptible?: boolean;
  retry?: { max?: number; when?: string[] };
  timeout?: string;
  artifacts?: { expire_in?: string };
};

function asList(value: string | string[] | undefined): string[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function mergeGitlabJob(
  pipeline: Record<string, GitlabJob>,
  name: string,
  stack = new Set<string>(),
): GitlabJob {
  if (stack.has(name)) {
    throw new Error(`extends cycle at ${name}`);
  }
  const raw = pipeline[name];
  // A missing template would merge as {} and silently drop its rules and
  // variables, so the wiring assertions would pass for the wrong reason.
  if (!raw) throw new Error(`extends target ${name} is not in the loaded CI files`);
  stack.add(name);
  let merged: GitlabJob = {};
  for (const parent of asList(raw.extends)) {
    merged = overlayGitlabJob(merged, mergeGitlabJob(pipeline, parent, stack));
  }
  stack.delete(name);
  return overlayGitlabJob(merged, raw);
}

function overlayGitlabJob(base: GitlabJob, overlay: GitlabJob): GitlabJob {
  const result: GitlabJob = { ...base, ...overlay };
  const needs = Object.hasOwn(overlay, "needs") ? overlay.needs : base.needs;
  const rules = Object.hasOwn(overlay, "rules") ? overlay.rules : base.rules;
  if (needs !== undefined) result.needs = needs;
  else delete result.needs;
  if (rules !== undefined) result.rules = rules;
  else delete result.rules;
  // extends deep-merges hashes; variables is the one hash these rules read.
  if (base.variables || overlay.variables) {
    result.variables = { ...base.variables, ...overlay.variables };
  }
  return result;
}

/**
 * Jobs a GitLab template or CI component defines, which the local files only
 * overlay; the model does not load templates or components, so each entry
 * names where the rules GitLab evaluates for the job come from:
 * - "local": blueprint-compliance.yml sets the job's rules, and a rules array
 *   in a later include replaces the template's, so the local rules are exact.
 * - "component": the docs-ci-components job takes its rules from its
 *   include's `inputs.rules` in .gitlab-ci.yml.
 * - "template": only the template knows the rules. The model cannot tell
 *   whether GitLab creates the job, so a need on one is reported, not assumed.
 * A job without script or trigger that is missing here fails the model check,
 * so a new overlay cannot be evaluated as if it had no rules.
 */
const EXTERNALLY_DEFINED_JOBS: Readonly<
  Record<
    string,
    { rules: "local" } | { rules: "component"; component: string } | { rules: "template" }
  >
> = {
  // Jobs/Secret-Detection, Jobs/SAST, and Jobs/Dependency-Scanning templates.
  secret_detection: { rules: "local" },
  "semgrep-sast": { rules: "local" },
  "gemnasium-dependency_scanning": { rules: "local" },
  "gemnasium-python-dependency_scanning": { rules: "local" },
  // The SAST and Dependency-Scanning templates' configuration jobs; the local
  // overlay sets only their stage.
  sast: { rules: "template" },
  dependency_scanning: { rules: "template" },
  "docs:fern-main": { rules: "component", component: "fern-main" },
  "docs:fern-publish": { rules: "component", component: "fern-publish" },
};

type CiPipeline = {
  /** Every key GitLab loads, so extends resolves across included files. */
  definitions: Record<string, GitlabJob>;
  /** Every job of every loaded file, merged, with the rules GitLab evaluates for it. */
  jobs: ReadonlyMap<string, GitlabJob>;
  /** Jobs whose rules only a GitLab template defines. */
  templateRules: ReadonlySet<string>;
};

async function readCiPipeline(repositoryRoot: string): Promise<CiPipeline> {
  const config = await readGitlabCiConfig(repositoryRoot);
  return ciPipelineFrom(config.definitions as Record<string, GitlabJob>, jobNames(config));
}

function ciPipelineFrom(
  definitions: Record<string, GitlabJob>,
  names: readonly string[],
): CiPipeline {
  const jobs = new Map<string, GitlabJob>();
  const templateRules = new Set<string>();
  for (const name of names) {
    const merged = mergeGitlabJob(definitions, name);
    const external = EXTERNALLY_DEFINED_JOBS[name];
    const overlayOnly = merged.script === undefined && merged.trigger === undefined;
    if (overlayOnly !== (external !== undefined)) {
      throw new Error(
        overlayOnly
          ? `${name} has no script or trigger, so a template or component defines it; add it to EXTERNALLY_DEFINED_JOBS`
          : `${name} is on EXTERNALLY_DEFINED_JOBS but the loaded files define it; remove the entry`,
      );
    }
    if (external?.rules === "template") {
      templateRules.add(name);
      continue;
    }
    jobs.set(
      name,
      external?.rules === "component"
        ? { ...merged, rules: componentRules(definitions, external.component) }
        : merged,
    );
  }
  for (const name of Object.keys(EXTERNALLY_DEFINED_JOBS)) {
    if (!names.includes(name)) {
      throw new Error(`${name} is on EXTERNALLY_DEFINED_JOBS but no loaded file overlays it`);
    }
  }
  return { definitions, jobs, templateRules };
}

function componentRules(definitions: Record<string, GitlabJob>, component: string): GitlabRule[] {
  const include = (definitions as Record<string, unknown>).include;
  const entries = (Array.isArray(include) ? include : []).filter(
    (entry): entry is { component: string; inputs?: { rules?: GitlabRule[] } } =>
      typeof entry?.component === "string" && entry.component.includes(`/${component}@`),
  );
  if (entries.length !== 1 || !entries[0].inputs?.rules) {
    throw new Error(`.gitlab-ci.yml must include component ${component} once, with inputs.rules`);
  }
  return entries[0].inputs.rules;
}

/** One path the pattern matches, for driving a single-path merge request through the rules. */
function examplePathFor(pattern: string): string {
  const path = pattern.replaceAll("**/", "").replaceAll("*", "x");
  if (!matchesCiPath(path, pattern)) throw new Error(`${path} does not match ${pattern}`);
  return path;
}

/** Stands for a pipeline in which every `rules:changes` pattern matches. */
const EVERY_PATH = Symbol("every path changed");
type ChangedPaths = readonly string[] | typeof EVERY_PATH;

type CiVariables = Record<string, string | undefined>;

// Predefined variables only. GitLab defines CI_DEFAULT_BRANCH on every
// pipeline; omitting it would let `$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH`
// match as null == null on an MR pipeline, where CI_COMMIT_BRANCH is unset.
const MERGE_REQUEST_PIPELINE: CiVariables = {
  CI_PIPELINE_SOURCE: "merge_request_event",
  CI_DEFAULT_BRANCH: "main",
};

const DEFAULT_BRANCH_PUSH: CiVariables = {
  CI_PIPELINE_SOURCE: "push",
  CI_COMMIT_BRANCH: "main",
  CI_DEFAULT_BRANCH: "main",
};

// A scheduled pipeline on protected main in the DocsFab project: the one
// shape in which runtime:live-model runs automatically. Predefined only.
const PROTECTED_MAIN_SCHEDULE: CiVariables = {
  CI_PIPELINE_SOURCE: "schedule",
  CI_PROJECT_ID: "437040",
  CI_COMMIT_BRANCH: "main",
  CI_DEFAULT_BRANCH: "main",
  CI_COMMIT_REF_PROTECTED: "true",
};

/**
 * Evaluate the subset of GitLab rule syntax this pipeline uses: equality and
 * inequality against a quoted string, another variable, or null; regex match
 * (=~) and non-match (!~) with flags, against a /pattern/ literal or a
 * variable holding one; presence, parenthesised groups, and && / ||. An
 * undefined variable compares as null (never equal to a quoted-string literal;
 * two unset variables are equal) and matches no pattern; an undefined pattern
 * variable is no pattern, so =~ is false and !~ true.
 * Anything outside the subset throws, so a compound rule cannot silently look
 * like a non-match.
 */
function evaluateIf(expression: string | undefined, vars: CiVariables): boolean {
  if (!expression) return true;
  const token = expression.trim().replaceAll(/\s+/gu, " ");
  if (token.startsWith("(") && matchingParen(token, 0) === token.length - 1) {
    return evaluateIf(token.slice(1, -1), vars);
  }
  for (const operator of ["||", "&&"] as const) {
    const at = splitTopLevel(token, operator);
    if (at !== -1) {
      const left = evaluateIf(token.slice(0, at), vars);
      const right = evaluateIf(token.slice(at + 2), vars);
      return operator === "||" ? left || right : left && right;
    }
  }
  const variable = "[A-Za-z_][A-Za-z0-9_]*";
  const comparison = token.match(
    new RegExp(`^\\$(${variable}) ?(==|!=) ?(?:"([^"]*)"|\\$(${variable})|(null))$`, "u"),
  );
  if (comparison) {
    const left = vars[comparison[1]];
    const right = comparison[5] === "null" ? undefined : (comparison[3] ?? vars[comparison[4]]);
    // GitLab compares an undefined variable as null: it never equals a
    // quoted-string literal (including ""), so != against a quoted string is
    // true when the variable is unset. Two unset variables are null == null.
    const equal = left === right;
    return comparison[2] === "==" ? equal : !equal;
  }
  const regexMatch = token.match(new RegExp(`^\\$(${variable}) ?=~ ?\\/(.*)\\/([a-z]*)$`, "u"));
  if (regexMatch) {
    const left = vars[regexMatch[1]];
    return left !== undefined && new RegExp(regexMatch[2], `u${regexMatch[3]}`).test(left);
  }
  // !~ against a literal, or =~ / !~ against a variable that holds /pattern/flags (the nightly arm selection).
  const notMatch = token.match(new RegExp(`^\\$(${variable}) ?!~ ?\\/(.*)\\/([a-z]*)$`, "u"));
  if (notMatch) {
    const left = vars[notMatch[1]];
    return !(left !== undefined && new RegExp(notMatch[2], `u${notMatch[3]}`).test(left));
  }
  const heldPattern = token.match(new RegExp(`^\\$(${variable}) ?(=~|!~) ?\\$(${variable})$`, "u"));
  if (heldPattern) {
    const held = vars[heldPattern[3]];
    if (held === undefined) return heldPattern[2] === "!~";
    const pattern = /^\/(.*)\/([a-z]*)$/u.exec(held);
    if (!pattern) throw new Error(`Unsupported CI rule expression: ${expression}`);
    const left = vars[heldPattern[1]];
    const matched = left !== undefined && new RegExp(pattern[1], `u${pattern[2]}`).test(left);
    return heldPattern[2] === "=~" ? matched : !matched;
  }
  const presence = token.match(new RegExp(`^\\$(${variable})$`, "u"));
  if (presence) return Boolean(vars[presence[1]]);
  throw new Error(`Unsupported CI rule expression: ${expression}`);
}

/** Index of the `)` matching the `(` at `from`, or -1. */
function matchingParen(text: string, from: number): number {
  let depth = 0;
  for (let index = from; index < text.length; index += 1) {
    if (text[index] === "(") depth += 1;
    else if (text[index] === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/** Index of `operator` outside any parentheses, or -1. */
function splitTopLevel(text: string, operator: "&&" | "||"): number {
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "(") depth += 1;
    else if (text[index] === ")") depth -= 1;
    else if (depth === 0 && text.startsWith(operator, index)) return index;
  }
  return -1;
}

/**
 * `predefined` are GitLab's predefined CI variables; `overrides` are pipeline,
 * trigger, schedule, project, or group CI/CD variables. GitLab's precedence,
 * lowest to highest, is predefined < job YAML variables < project/group <
 * pipeline/trigger/schedule. The Vault guards rely on the last step: an
 * override of VAULT_SERVER_URL must win over the template's value and trip the
 * `when: never` guard.
 */
function includedOnPipeline(
  job: GitlabJob,
  changedPaths: ChangedPaths,
  predefined: CiVariables,
  overrides: CiVariables = {},
): boolean {
  const rules = job.rules ?? [];
  if (rules.length === 0) return true;
  const scope = { ...predefined, ...job.variables, ...overrides };
  for (const rule of rules) {
    if (rule.if && !evaluateIf(rule.if, scope)) continue;
    if (rule.changes?.paths) {
      const hit =
        changedPaths === EVERY_PATH ||
        rule.changes.paths.some((pattern) =>
          changedPaths.some((path) => matchesCiPath(path, pattern)),
        );
      if (!hit) continue;
    }
    return rule.when !== "never";
  }
  return false;
}

function includedJobs(
  pipeline: CiPipeline,
  changedPaths: ChangedPaths,
  predefined: CiVariables = MERGE_REQUEST_PIPELINE,
  overrides: CiVariables = {},
): Set<string> {
  const included = new Set<string>();
  for (const [name, job] of pipeline.jobs) {
    if (includedOnPipeline(job, changedPaths, predefined, overrides)) included.add(name);
  }
  return included;
}

/**
 * Non-optional needs GitLab would refuse when it creates the pipeline: a
 * needed job that rules omit, that only a template can create, or that no
 * loaded file defines.
 */
function unsatisfiedNeeds(pipeline: CiPipeline, included: Set<string>): string[] {
  const missing: string[] = [];
  for (const name of included) {
    for (const entry of pipeline.jobs.get(name)?.needs ?? []) {
      const job = typeof entry === "string" ? entry : entry.job;
      if (typeof entry !== "string" && entry.optional === true) continue;
      if (pipeline.templateRules.has(job)) {
        missing.push(`${name} needs ${job}, whose rules only a GitLab template defines`);
      } else if (!pipeline.jobs.has(job)) {
        missing.push(`${name} needs ${job}, which no loaded CI file defines`);
      } else if (!included.has(job)) {
        missing.push(`${name} needs ${job}, which rules omitted`);
      }
    }
  }
  return missing;
}

/**
 * Pipelines GitLab creates for this project, by type, each with protected-ref
 * and project predefined variables where GitLab sets them.
 */
const PIPELINE_TYPES: Readonly<Record<string, CiVariables>> = {
  "merge request": { ...MERGE_REQUEST_PIPELINE, CI_MERGE_REQUEST_EVENT_TYPE: "detached" },
  "merged result": { ...MERGE_REQUEST_PIPELINE, CI_MERGE_REQUEST_EVENT_TYPE: "merged_result" },
  "main push": { ...DEFAULT_BRANCH_PUSH, CI_PROJECT_ID: "437040", CI_COMMIT_REF_PROTECTED: "true" },
  "release tag": {
    CI_PIPELINE_SOURCE: "push",
    CI_COMMIT_TAG: "v1.2.3",
    CI_DEFAULT_BRANCH: "main",
    CI_PROJECT_ID: "437040",
    CI_COMMIT_REF_PROTECTED: "true",
  },
  "main schedule": PROTECTED_MAIN_SCHEDULE,
  "main web": { ...PROTECTED_MAIN_SCHEDULE, CI_PIPELINE_SOURCE: "web" },
  "feature-branch web": {
    CI_PIPELINE_SOURCE: "web",
    CI_COMMIT_BRANCH: "agent/1-example",
    CI_DEFAULT_BRANCH: "main",
    CI_PROJECT_ID: "437040",
    CI_COMMIT_REF_PROTECTED: "false",
  },
  "pre-release tag": {
    CI_PIPELINE_SOURCE: "push",
    CI_COMMIT_TAG: "v1.2.3-rc.1",
    CI_DEFAULT_BRANCH: "main",
    CI_PROJECT_ID: "437040",
    CI_COMMIT_REF_PROTECTED: "true",
  },
};

/**
 * Changed-path sets that drive every `rules:changes` pattern both ways: none,
 * each pattern alone, and all of them.
 */
function changedPathScenarios(pipeline: CiPipeline): ChangedPaths[] {
  const patterns = new Set<string>();
  for (const job of pipeline.jobs.values()) {
    for (const rule of job.rules ?? [])
      for (const pattern of rule.changes?.paths ?? []) patterns.add(pattern);
  }
  return [[], ...[...patterns].map((pattern) => [examplePathFor(pattern)]), EVERY_PATH];
}

/** Unsatisfied needs of every pipeline type and changed-path scenario, one line per distinct edge. */
function unsatisfiedNeedsAcrossPipelines(pipeline: CiPipeline): string[] {
  const found = new Map<string, string>();
  for (const [type, predefined] of Object.entries(PIPELINE_TYPES)) {
    for (const changed of changedPathScenarios(pipeline)) {
      for (const line of unsatisfiedNeeds(pipeline, includedJobs(pipeline, changed, predefined))) {
        const key = `${type}: ${line}`;
        if (!found.has(key)) {
          const shape = changed === EVERY_PATH ? "every path" : `[${changed.join(", ")}]`;
          found.set(key, `${key} (changed: ${shape})`);
        }
      }
    }
  }
  return [...found.values()];
}
