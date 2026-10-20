// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * A page or navigation file the content index cannot index stops a run only
 * when the run needs that file (#1926). On a page the caller does not
 * target, an anchor the page cannot admit is left out and recorded with its
 * page and line; an executable sidebar is unknown navigation, recorded and
 * never run.
 */
import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildContentIndex,
  buildContentIndexV2,
  buildScopedContentIndex,
  ContentIndexError,
  contentIndexLimitations,
  describeContentIndexLimitation,
} from "../src/content-ir/index.js";
import type {
  ContentIndexV1,
  ContentIndexV2,
  DocumentNode,
  SectionNode,
} from "../src/content-ir/index.js";
import { executeRunRequest } from "../src/cli/run-request.js";
import { prepareRunPreflight } from "../src/cli/run/preflight.js";
import type { CliRunInvocation } from "../src/cli/run/request.js";
import type { DocsFabConfig } from "../src/config/runtime-loader.js";
import type {
  AgentHarness,
  HarnessStepInput,
  HarnessStepResult,
} from "../src/execution/contracts.js";
import { LocalImpactPostflightService } from "../src/impact/postflight.js";
import {
  collectRunLimitOverflowEvidence,
  mergeRunLimitOverflowEvidence,
  projectRunLimitOverflowLines,
} from "../src/operator/run-limit-overflow.js";
import type { RunRecord } from "../src/records/contracts.js";
import { appendEvidenceWarnings } from "../src/workflow-execution/runner-evidence.js";
import { WorkflowRunner } from "../src/workflow-execution/runner.js";
import { prepareRepositoryWorkspace } from "../src/repository/workspace/materialize.js";
import { readyContextPreflight, validModelConfig } from "./helpers.js";
import { commitFixture, git, initFixtureRepo } from "./helpers/git.js";
import { temporaryRoots } from "./helpers/temp.js";

const REVISION = "a".repeat(40);
const roots = temporaryRoots();
const runtimeRoot = fileURLToPath(new URL("..", import.meta.url));

afterEach(() => {
  vi.unstubAllGlobals();
  process.exitCode = undefined;
});

/**
 * NeMo Data Designer's field case: a PEP 723 script header inside an HTML
 * `<details>` transcript, after a blank line, so CommonMark reads `# ]` on
 * line 13 as an ATX heading whose anchor normalizes to nothing.
 */
const TRANSCRIPT = [
  "# Data Designer",
  "",
  "Intro.",
  "",
  "## Example",
  "",
  "<details>",
  "<summary>Transcript</summary>",
  "",
  "# /// script",
  "# dependencies = [",
  '#   "data-designer",',
  "# ]",
  "",
  "</details>",
  "",
  "## After",
  "",
  "Tail.",
  "",
].join("\n");
const EMPTY_ANCHOR =
  "The heading at line 13 of docs/data.md has no letter or digit to form an anchor. Add a letter or digit to the heading text, or give the heading an explicit {#anchor}.";

const REPEATED = ["# One {#same}", "", "A.", "", "# Two {#same}", "", "B.", ""].join("\n");
const REPEATED_ANCHOR =
  "The explicit anchor at line 5 of docs/repeat.md repeats the anchor defined at line 1. Rename one of them so each anchor on the page is unique.";

const PAGES = {
  "docs/guide.md": "# Guide\n\n## Install\n\nSteps.\n",
  "docs/other.md": "# Other\n\nText.\n",
};

async function repository(files: Record<string, string>): Promise<string> {
  const root = await roots.create("docsfab-content-ir-limitations-");
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), contents, "utf8");
  }
  return root;
}

async function index(
  files: Record<string, string>,
  targetPaths?: readonly string[],
): Promise<ContentIndexV1> {
  return buildContentIndex({
    repositoryPath: await repository(files),
    repositoryRevision: REVISION,
    ...(targetPaths ? { targetPaths } : {}),
  });
}

async function refusal(promise: Promise<unknown>): Promise<ContentIndexError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ContentIndexError);
    return error as ContentIndexError;
  }
  throw new Error("Expected the content index to stop, but it indexed the repository.");
}

function sections(built: ContentIndexV1 | ContentIndexV2, page: string) {
  return built.nodes
    .filter((node): node is SectionNode => node.kind === "section" && node.sourcePath === page)
    .sort((left, right) => left.startLine - right.startLine)
    .map(({ anchor, startLine, endLine }) => `${anchor} ${startLine}-${endLine}`);
}

function page(built: ContentIndexV1 | ContentIndexV2, path: string) {
  return built.nodes.filter(
    (node) => (node as DocumentNode | SectionNode).sourcePath === path,
  ) as Array<DocumentNode | SectionNode>;
}

describe("anchors on pages the caller does not target", () => {
  it("leaves an empty-anchor heading out, names the page and line, and keeps indexing", async () => {
    const built = await index({ ...PAGES, "docs/data.md": TRANSCRIPT });
    expect(contentIndexLimitations(built)).toEqual([
      { path: "docs/data.md", reason: "empty-page-anchor", line: 13, detail: EMPTY_ANCHOR },
    ]);
    expect(describeContentIndexLimitation(contentIndexLimitations(built)[0]!)).toBe(
      `${EMPTY_ANCHOR} The content index leaves that anchor out and continues.`,
    );
    // The section before the left-out heading runs on to the next kept one.
    expect(sections(built, "docs/data.md")).toEqual([
      "data-designer 1-4",
      "example 5-9",
      "script 10-10",
      "dependencies 11-11",
      "data-designer-1 12-16",
      "after 17-20",
    ]);
    expect(sections(built, "docs/guide.md")).toEqual(["guide 1-2", "install 3-6"]);
  });

  it("keeps the lines of a left-out heading in the page body", async () => {
    const regions = async (heading: string) => {
      const built = await index({ "docs/data.md": TRANSCRIPT.replace("# ]", heading) });
      const node = page(built, "docs/data.md").find(
        (candidate): candidate is DocumentNode => candidate.kind === "document",
      )!;
      return node.regions;
    };
    const before = await regions("# ]");
    const after = await regions("# ]]");
    // An edit to the left-out line still changes the page's evidence.
    expect(after.body).not.toBe(before.body);
    expect(after.headings).toBe(before.headings);
  });

  it("keeps the first of a repeated anchor and records each repeat", async () => {
    const built = await index({
      "docs/repeat.md": REPEATED,
      "docs/labels.md": [
        "(shared)=",
        "# Three",
        "",
        "(shared)=",
        "# Four",
        "",
        '<a id="spot"></a>',
        '<a id="spot"></a>',
        "",
      ].join("\n"),
    });
    expect(contentIndexLimitations(built)).toEqual([
      {
        path: "docs/labels.md",
        reason: "duplicate-page-anchor",
        line: 4,
        detail:
          "The MyST label at line 4 of docs/labels.md repeats the anchor defined at line 1. Rename one of them so each anchor on the page is unique.",
      },
      {
        path: "docs/labels.md",
        reason: "duplicate-page-anchor",
        line: 8,
        detail:
          "The HTML id at line 8 of docs/labels.md repeats the anchor defined at line 7. Rename one of them so each anchor on the page is unique.",
      },
      { path: "docs/repeat.md", reason: "duplicate-page-anchor", line: 5, detail: REPEATED_ANCHOR },
    ]);
    expect(sections(built, "docs/repeat.md")).toEqual(["same 1-8"]);
    expect(sections(built, "docs/labels.md")).toEqual(["shared 2-9"]);
  });

  it("keeps a heading whose MyST label is empty and names the label line", async () => {
    const built = await index({ "docs/label.md": "# Intro\n\n(🚀)=\n## Launch\n\nGo.\n" });
    expect(sections(built, "docs/label.md")).toEqual(["intro 1-3", "launch 4-7"]);
    expect(contentIndexLimitations(built)).toEqual([
      {
        path: "docs/label.md",
        reason: "empty-page-anchor",
        line: 3,
        detail:
          "The MyST label at line 3 of docs/label.md has no letter or digit to form an anchor. Add a letter or digit to it, or remove it.",
      },
    ]);
  });

  it("leaves every node of an indexable page unchanged", async () => {
    const clean = await index(PAGES);
    expect(contentIndexLimitations(clean)).toEqual([]);
    const withProblems = await index({
      ...PAGES,
      "docs/data.md": TRANSCRIPT,
      "docs/repeat.md": REPEATED,
      "website/sidebars.ts": "export default {};\n",
      "website/docs/intro.md": "# Intro\n",
    });
    expect(contentIndexLimitations(withProblems)).toHaveLength(3);
    for (const path of Object.keys(PAGES)) {
      expect(page(withProblems, path), path).toEqual(page(clean, path));
    }
  });
});

describe("anchors on a target page", () => {
  it("still stops with the coded reason naming the page and line", async () => {
    const files = { ...PAGES, "docs/data.md": TRANSCRIPT, "docs/repeat.md": REPEATED };
    for (const targets of [["docs/data.md"], ["docs"], ["docs/"]]) {
      const error = await refusal(index(files, targets));
      expect(error.code, targets[0]).toBe("empty-page-anchor");
      expect(error.message, targets[0]).toBe(EMPTY_ANCHOR);
    }
    const repeated = await refusal(index(files, ["docs/repeat.md"]));
    expect(repeated.code).toBe("duplicate-page-anchor");
    expect(repeated.message).toBe(REPEATED_ANCHOR);

    // Targeting another page leaves both problems recorded.
    const elsewhere = await index(files, ["docs/guide.md"]);
    expect(contentIndexLimitations(elsewhere).map((limitation) => limitation.path)).toEqual([
      "docs/data.md",
      "docs/repeat.md",
    ]);
  });

  it("stops a focused index on its selected page and records a page beside it", async () => {
    const repositoryPath = await repository({ ...PAGES, "docs/data.md": TRANSCRIPT });
    const error = await refusal(
      buildScopedContentIndex({
        repositoryPath,
        repositoryRevision: REVISION,
        includePaths: ["docs/data.md"],
      }),
    );
    expect(error.code).toBe("empty-page-anchor");
    expect(error.message).toBe(EMPTY_ANCHOR);

    const beside = await buildScopedContentIndex({
      repositoryPath,
      repositoryRevision: REVISION,
      includePaths: ["docs/guide.md"],
    });
    if (beside.status !== "indexed") throw new Error("The focused index refused an alias.");
    expect(contentIndexLimitations(beside.index)).toEqual([
      { path: "docs/data.md", reason: "empty-page-anchor", line: 13, detail: EMPTY_ANCHOR },
    ]);
  });
});

describe("executable navigation", () => {
  it("records a Docusaurus sidebar as unknown navigation and never runs it", async () => {
    for (const name of ["sidebars.ts", "sidebars.js", "sidebars.cjs", "sidebars.mjs"]) {
      const root = await repository({
        "website/docs/intro.md": "# Intro\n",
        "website/docs/guide.md": "# Guide\n",
        [`website/${name}`]: [
          'import { writeFileSync } from "node:fs";',
          'writeFileSync(new URL("./ran.txt", import.meta.url), "ran");',
          "export default { docs: ['intro', 'guide'] };",
          "",
        ].join("\n"),
      });
      const built = await buildContentIndex({ repositoryPath: root, repositoryRevision: REVISION });
      expect(contentIndexLimitations(built), name).toEqual([
        { path: `website/${name}`, reason: "unsupported-navigation" },
      ]);
      expect(describeContentIndexLimitation(contentIndexLimitations(built)[0]!)).toBe(
        `website/${name} is a JavaScript or TypeScript navigation file, which DocsFab never runs, so the content index has no navigation from it.`,
      );
      expect(
        built.edges.filter((edge) => edge.kind === "navigation"),
        name,
      ).toEqual([]);
      await expect(access(join(root, "website", "ran.txt")), name).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
  });

  it("records a sidebars.json that is not valid JSON as unreadable navigation", async () => {
    const built = await index({ ...PAGES, "docs/sidebars.json": "{ not json" });
    expect(contentIndexLimitations(built)).toEqual([
      {
        path: "docs/sidebars.json",
        reason: "unreadable-navigation",
        detail: "it is not valid JSON",
      },
    ]);
  });

  it("records the same problems in an index built from a tracked workspace", async () => {
    const source = await repository({
      ...PAGES,
      "docs/data.md": TRANSCRIPT,
      "website/sidebars.ts": "export default {};\n",
    });
    await initFixtureRepo(source, undefined, { branch: "main" });
    await commitFixture(source, "unindexable fixture");
    const workspace = await prepareRepositoryWorkspace(source, "HEAD");
    try {
      const built = await buildContentIndexV2({ workspace });
      expect(contentIndexLimitations(built)).toEqual([
        { path: "docs/data.md", reason: "empty-page-anchor", line: 13, detail: EMPTY_ANCHOR },
        { path: "website/sidebars.ts", reason: "unsupported-navigation" },
      ]);
      expect(sections(built, "docs/data.md")).toContain("data-designer-1 12-16");
    } finally {
      await workspace.dispose();
    }
  });
});

/** A page the run wrote with a repeated explicit anchor (line 7) and an empty heading (line 9). */
const WRITTEN_GUIDE =
  "# Guide\n\n## Install {#install}\n\nSteps.\n\n## Upgrade {#install}\n\n## 🚀\n";
const WRITTEN_WARNINGS = [
  "content-index-written-anchor: The explicit anchor at line 7 of docs/guide.md repeats the anchor defined at line 3. Rename one of them so each anchor on the page is unique. The content index leaves that anchor out and continues. The run wrote this page; fix the line before the change merges.",
  "content-index-written-anchor: The heading at line 9 of docs/guide.md has no letter or digit to form an anchor. Add a letter or digit to the heading text, or give the heading an explicit {#anchor}. The content index leaves that anchor out and continues. The run wrote this page; fix the line before the change merges.",
];

describe("pages a run writes", () => {
  const revision = REVISION;
  const changed = (path: string) => [{ path, status: "modified" as const }];
  async function postflightWarnings(
    before: Record<string, string>,
    after: Record<string, string>,
    changedPath: string,
  ): Promise<{ warnings: string[]; status: string }> {
    const repositoryPath = await repository(before);
    const baseline = await buildContentIndex({ repositoryPath, repositoryRevision: revision });
    const service = new LocalImpactPostflightService(baseline);
    for (const [path, contents] of Object.entries(after)) {
      await writeFile(join(repositoryPath, path), contents, "utf8");
    }
    const warnings: string[] = [];
    const result = await service.postflight({
      runId: "written-anchor",
      workflow: "update-documentation",
      repository: { sourcePath: repositoryPath, requestedRevision: "HEAD", revision },
      workspacePath: repositoryPath,
      changedFiles: changed(changedPath),
      recordWarning: (warning) => warnings.push(warning),
    });
    return { warnings, status: result.status };
  }

  it("reports an anchor problem the run wrote into a changed page, without stopping", async () => {
    const { warnings, status } = await postflightWarnings(
      PAGES,
      { "docs/guide.md": WRITTEN_GUIDE },
      "docs/guide.md",
    );
    expect(status).toBe("completed");
    expect(warnings).toEqual(WRITTEN_WARNINGS);
  });

  it("keeps the warning on the run record and in the operator footer, and the run succeeds", async () => {
    // docs/data.md keeps its old problem untouched: it is no warning.
    const workspacePath = await repository({ ...PAGES, "docs/data.md": TRANSCRIPT });
    const baseline = await buildContentIndex({
      repositoryPath: workspacePath,
      repositoryRevision: REVISION,
    });
    const runner = new WorkflowRunner({
      harness: {
        runStep: async (input) => {
          if (input.step.mode === "write") {
            await writeFile(join(workspacePath, "docs", "guide.md"), WRITTEN_GUIDE, "utf8");
          }
          return { summary: "completed write" };
        },
      },
      store: { save: async () => undefined },
      repositoryScanner: {
        scan: async () => ({
          ruleSet: "test-v1",
          status: "passed",
          scannedFiles: 0,
          binaryFiles: 0,
          findings: [],
        }),
      },
      contextPreflight: readyContextPreflight,
      impactPostflight: new LocalImpactPostflightService(baseline),
      repositoryEvidence: {
        capture: async (context) => ({
          files: [{ path: "docs/guide.md", status: "modified" }],
          ...(context.persistPatch
            ? {
                patch: {
                  sha256: "b".repeat(64),
                  byteLength: 123,
                  lineCount: 7,
                  artifactPath: ".docsfab/patches/run-written-anchor.patch",
                  format: "git-diff" as const,
                },
              }
            : {}),
        }),
      },
      id: () => "run-written-anchor",
    });
    const record = await runner.run({
      workflow: "bootstrap",
      workspacePath,
      repository: { sourcePath: workspacePath, requestedRevision: "HEAD", revision: REVISION },
      allowWrite: true,
    });
    expect(record.status).toBe("succeeded");
    expect(record.evidenceWarnings).toEqual(WRITTEN_WARNINGS);
    expect(projectRunLimitOverflowLines(collectRunLimitOverflowEvidence(record))).toEqual(
      WRITTEN_WARNINGS,
    );
    // Every operator surface (run summary, JSON result, runs show) merges the
    // record's evidence before projecting it.
    expect(
      projectRunLimitOverflowLines(
        mergeRunLimitOverflowEvidence(collectRunLimitOverflowEvidence(record)),
      ),
    ).toEqual(WRITTEN_WARNINGS);
  });

  it("reports a heading whose anchor problem changes code on the same page", async () => {
    // The baseline's empty heading becomes a repeated explicit anchor: the
    // page keeps one problem, but of a new code.
    const { warnings } = await postflightWarnings(
      { "docs/guide.md": "# Guide\n\n## Install {#install}\n\n## 🚀\n" },
      { "docs/guide.md": "# Guide\n\n## Install {#install}\n\n## Again {#install}\n" },
      "docs/guide.md",
    );
    expect(warnings).toEqual([
      "content-index-written-anchor: The explicit anchor at line 5 of docs/guide.md repeats the anchor defined at line 3. Rename one of them so each anchor on the page is unique. The content index leaves that anchor out and continues. The run wrote this page; fix the line before the change merges.",
    ]);
  });

  it("keeps identical warnings once on the run record, which the record decoders require", () => {
    // Three HTML ids on one line give two problems with the same message.
    const repeated =
      "content-index-written-anchor: The HTML id at line 3 of docs/guide.md repeats the anchor defined at line 3. Rename one of them so each anchor on the page is unique. The content index leaves that anchor out and continues. The run wrote this page; fix the line before the change merges.";
    const record = { evidenceWarnings: ["Earlier warning."] } as RunRecord;
    appendEvidenceWarnings(record, [repeated, repeated, "Earlier warning."]);
    expect(record.evidenceWarnings).toEqual(["Earlier warning.", repeated]);

    // One the decoders could not keep is replaced, never dropped.
    const fresh = {} as RunRecord;
    appendEvidenceWarnings(fresh, ["x".repeat(1_025), "line\nbreak"]);
    expect(fresh.evidenceWarnings).toEqual([
      "A run warning was too long or held a control character, so the run record keeps this placeholder instead.",
    ]);
  });

  it("records one warning when the same message repeats in a page the run wrote", async () => {
    const workspacePath = await repository(PAGES);
    const baseline = await buildContentIndex({
      repositoryPath: workspacePath,
      repositoryRevision: REVISION,
    });
    const service = new LocalImpactPostflightService(baseline);
    await writeFile(
      join(workspacePath, "docs", "guide.md"),
      '# Guide\n\n<a id="spot"></a><a id="spot"></a><a id="spot"></a>\n',
      "utf8",
    );
    const warnings: string[] = [];
    await service.postflight({
      runId: "repeated-message",
      workflow: "update-documentation",
      repository: { sourcePath: workspacePath, requestedRevision: "HEAD", revision: REVISION },
      workspacePath,
      changedFiles: [{ path: "docs/guide.md", status: "modified" }],
      recordWarning: (warning) => warnings.push(warning),
    });
    expect(warnings).toHaveLength(2);
    expect(new Set(warnings).size).toBe(1);
    const record = {} as RunRecord;
    appendEvidenceWarnings(record, warnings);
    expect(record.evidenceWarnings).toEqual([warnings[0]]);
  });

  it("reports no problem that was there before the run, on an untouched page or a changed one", async () => {
    // An old problem on a page the run does not touch.
    const untouched = await postflightWarnings(
      { ...PAGES, "docs/data.md": TRANSCRIPT },
      { "docs/guide.md": "# Guide\n\n## Install\n\nNew steps.\n" },
      "docs/guide.md",
    );
    expect(untouched).toEqual({ warnings: [], status: "completed" });
    // An old problem on a page the run edits elsewhere, still one of its kind.
    const edited = await postflightWarnings(
      { ...PAGES, "docs/data.md": TRANSCRIPT },
      { "docs/data.md": `${TRANSCRIPT}\nMore tail.\n` },
      "docs/data.md",
    );
    expect(edited).toEqual({ warnings: [], status: "completed" });
    // Only pages the change evidence names count as written.
    const unlisted = await postflightWarnings(
      PAGES,
      { "docs/guide.md": WRITTEN_GUIDE },
      "docs/other.md",
    );
    expect(unlisted.warnings).toEqual([]);
  });
});

describe("docsfab run preflight", () => {
  async function exported(files: Record<string, string>) {
    const source = await repository(files);
    await initFixtureRepo(source, undefined, { branch: "main" });
    await commitFixture(source, "run preflight fixture");
    return prepareRepositoryWorkspace(source, "HEAD");
  }

  function invocation(errors: string[], contextTarget?: { sourcePath: string }) {
    return {
      request: { workflow: "update-documentation", ...(contextTarget ? { contextTarget } : {}) },
      config: {},
      output: { error: (line: string) => errors.push(line) },
    } as unknown as CliRunInvocation;
  }

  it("prints one notice per problem on a page or sidebar the run does not name, and continues", async () => {
    const workspace = await exported({
      ...PAGES,
      "docs/data.md": TRANSCRIPT,
      "docs/repeat.md": REPEATED,
      "website/sidebars.ts": "export default {};\n",
    });
    const errors: string[] = [];
    try {
      const preflight = await prepareRunPreflight(invocation(errors), workspace);
      expect("contentIndex" in preflight && preflight.contentIndex).toBeTruthy();
      expect(errors).toEqual([
        `Content index notice: ${EMPTY_ANCHOR} The content index leaves that anchor out and continues.`,
        `Content index notice: ${REPEATED_ANCHOR} The content index leaves that anchor out and continues.`,
        "Content index notice: website/sidebars.ts is a JavaScript or TypeScript navigation file, which DocsFab never runs, so the content index has no navigation from it.",
      ]);
    } finally {
      await workspace.dispose();
    }
  });

  it("stops before any model call when the run names the page as its context target", async () => {
    const workspace = await exported({ ...PAGES, "docs/data.md": TRANSCRIPT });
    const errors: string[] = [];
    try {
      const error = await refusal(
        prepareRunPreflight(invocation(errors, { sourcePath: "docs/data.md" }), workspace),
      );
      expect(error.code).toBe("empty-page-anchor");
      expect(error.message).toBe(EMPTY_ANCHOR);
      expect(errors).toEqual([]);
    } finally {
      await workspace.dispose();
    }
  });
});

describe("docsfab run", () => {
  /** Records every workflow step; a run that reaches one has passed preflight. */
  class RecordingHarness implements AgentHarness {
    public readonly steps: string[] = [];

    public async runStep(input: HarnessStepInput): Promise<HarnessStepResult> {
      this.steps.push(input.step.id);
      throw new Error("The test harness stops at the first workflow step.");
    }
  }

  async function runFixture(contextTarget?: { sourcePath: string }) {
    const repository = await roots.create("docsfab-content-ir-limitations-run-");
    const state = await roots.create("docsfab-content-ir-limitations-state-");
    const head = await initFixtureRepo(
      repository,
      {
        ...PAGES,
        "docs/data.md": TRANSCRIPT,
        "docs/repeat.md": REPEATED,
        "website/sidebars.ts": "export default {};\n",
        "website/docs/intro.md": "# Intro\n",
        ".docsfab.json": `${JSON.stringify({
          schemaVersion: 1,
          gitlab: { remote: "origin", defaultBranch: "main" },
          provider: { configuration: "host" },
          storage: { scope: "user-private" },
        })}\n`,
      },
      { branch: "main", message: "unindexable pages" },
    );
    await git(repository, [
      "remote",
      "add",
      "origin",
      "ssh://git@gitlab.example.invalid/docs/x.git",
    ]);
    await git(repository, ["update-ref", "refs/remotes/origin/main", head]);
    const config: DocsFabConfig = {
      projectRoot: runtimeRoot,
      skillCrateDirectory: join(runtimeRoot, "skill-crate"),
      qualityDirectory: join(runtimeRoot, "quality"),
      qualityPackDirectory: join(runtimeRoot, "quality-pack"),
      stateDirectory: join(state, "runs"),
      retryPolicy: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0, retryableCategories: [] },
      model: validModelConfig,
    };
    const modelRequests: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      modelRequests.push(input instanceof Request ? input.url : String(input));
      throw new Error("The test provider stops at the first model call.");
    });
    const harness = new RecordingHarness();
    let outcome: unknown;
    try {
      outcome = await executeRunRequest(
        {
          workflow: "update-documentation",
          repositoryPath: repository,
          revision: head,
          instruction: "Document the install steps in the guide.",
          ...(contextTarget ? { contextTarget } : {}),
          allowWrite: true,
          draftMr: false,
          releaseGate: false,
          verbose: false,
          json: false,
          showScan: false,
        },
        config,
        { silent: true, harness },
      );
    } catch (error) {
      outcome = error;
    }
    return { outcome, modelCalls: modelRequests.length + harness.steps.length };
  }

  it("runs a repository with problems on pages it does not name to its first model call", async () => {
    const { outcome, modelCalls } = await runFixture();
    expect(outcome).not.toBeInstanceOf(ContentIndexError);
    expect(modelCalls).toBeGreaterThan(0);
  }, 120_000);

  it("stops before any model call when its context target is the unindexable page", async () => {
    const { outcome, modelCalls } = await runFixture({ sourcePath: "docs/data.md" });
    expect(outcome).toBeInstanceOf(ContentIndexError);
    expect(outcome).toMatchObject({ code: "empty-page-anchor", message: EMPTY_ANCHOR });
    expect(modelCalls).toBe(0);
  }, 120_000);
});
