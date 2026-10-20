// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `docsfab do --change` through `handleDoCommand`: the sentence routes exactly
 * as it would without the change, the selection reaches the shared run path,
 * and every change-source refusal either reaches `do` with its own code before
 * any request-intent or workflow model call, or is listed here as unreachable
 * from `do` with the reason. Only the model turn is substituted, at the
 * documented harness seam; the resolver and git runner are wrapped, not
 * replaced, so their call counts are observations of the shipped path.
 */
import { readFileSync } from "node:fs";
import { chmod, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleDoCommand, parseDoArguments, type DoRunArguments } from "../src/cli/commands/do.js";
import { parseRunArguments } from "../src/cli/run-arguments.js";
import { executeRunRequest } from "../src/cli/run-request.js";
import { sourceReadBudgetForModel } from "../src/cli/run/source-acquisition.js";
import { limit } from "../src/config/limits.js";
import type { CommandRunner } from "../src/init/types.js";
import {
  CHANGE_SOURCE_REFUSAL_CODES,
  CHANGE_SOURCE_REFUSALS,
  ChangeSourceError,
  parseChangeSourceSelector,
  type ChangeSourceRefusalCode,
  type ChangeSourceV1,
} from "../src/inputs/change-source.js";
import {
  CHANGE_SOURCE_DIFF_MEDIA_TYPE,
  changeSourceRepositoryPath,
} from "../src/inputs/change-source/acquisition.js";
import {
  decodeReleaseUnitsIndexV1,
  releaseUnitsRepositoryPath,
} from "../src/inputs/change-source/release.js";
import { decodeRunChangeSourceRelease } from "../src/records/change-source-release.js";
import type { RunRecord } from "../src/records/contracts.js";
import type { RequestIntentInterpreterPort } from "../src/request-intent/interpret.js";
import {
  createWorkflowOutcome,
  workflowOutcomeStepEvidence,
} from "../src/workflow-contracts/outcome.js";
import { configureCredential } from "./helpers/configured-credential.js";
import { temporaryRoots } from "./helpers/temp.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";
import {
  appendPlainCommits,
  commitFiles,
  fixtureGit,
  rewriteLooseObject,
} from "./support/change-source-fixture.js";
import { runtimeConfig } from "./support/execution-convergence.js";
import { createReleaseFixture } from "./support/release-run.js";
import {
  buildChangeRepository,
  FakeGithub,
  NAME,
  OWNER,
  pullJson,
  REPOSITORY_ID,
} from "./support/github-change-source-fixture.js";
import {
  createSourceFixture,
  HTML_SOURCE_PATH,
  runRequest,
  skillResolver,
  SourceToolHarness,
  type SourceFixture,
} from "./support/source-acquisition-cli.js";

/**
 * Call counts of the shipped resolver and the one hardened git entry point,
 * and a hook a test may set to observe the moment the resolver is entered.
 */
const probes = vi.hoisted(() => ({
  resolve: 0,
  git: 0,
  onResolve: undefined as (() => void) | undefined,
}));

vi.mock("../src/cli/run/source-acquisition.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/cli/run/source-acquisition.js")>();
  return {
    ...actual,
    resolveCliChangeSource: (...args: Parameters<typeof actual.resolveCliChangeSource>) => {
      probes.resolve += 1;
      probes.onResolve?.();
      return actual.resolveCliChangeSource(...args);
    },
  };
});

vi.mock("../src/host-invoker/trusted-git.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/host-invoker/trusted-git.js")>();
  return {
    ...actual,
    runTrustedGit: (...args: Parameters<typeof actual.runTrustedGit>) => {
      probes.git += 1;
      return actual.runTrustedGit(...args);
    },
  };
});

const roots = temporaryRoots();

/** Table-routed sentences, checked against the router in the routing tests. */
const CREATE_SENTENCE = "Create a documentation page for the new export behavior.";
const UPDATE_SENTENCE = "Update docs/whats-new.md for the change.";
const REVIEW_SENTENCE = "Review the documentation for the export behavior.";
/** A table miss the admission model may classify. */
const ADMISSION_SENTENCE = "Help developers understand the export change.";
const WINDOW_SENTENCE =
  "Update the user documentation for the merge requests merged into main on September 14, 2026, using America/Los_Angeles time.";
const MERGE_REQUEST_URL = "https://gitlab.change-do.test/team/project/-/merge_requests/7";
/** The merge request the recorded GitLab answer describes. */
const GITLAB_PROJECT_PATH = "team/docs-project";
const GITLAB_PROJECT_ID = 4242;
const GITLAB_MR_URL = `https://gitlab.example.test/${GITLAB_PROJECT_PATH}/-/merge_requests/813`;
const GITHUB_PULL = `https://github.com/${OWNER}/${NAME}/pull/7`;
/** A pull request path on a forge no kind claims. */
const FOREIGN_FORGE_URL = "https://forge.example.test/org/repo/pull/7";

const RECORDED_MERGE_REQUEST = readFileSync(
  join(import.meta.dirname, "fixtures", "change-source-gitlab", "merge-request-get.json"),
  "utf8",
);

/** The recorded GitLab answer with its `@` commit placeholders filled. */
function recordedMergeRequest(
  ids: Readonly<Record<"base" | "start" | "head" | "merge", string | null>>,
  fields: Record<string, unknown> = {},
): Record<string, unknown> {
  const filled = JSON.parse(RECORDED_MERGE_REQUEST, (_key, value: unknown) =>
    typeof value === "string" && value.startsWith("@")
      ? ids[value.slice(1) as keyof typeof ids]
      : value,
  ) as Record<string, unknown>;
  return { ...filled, ...fields };
}

/**
 * A `glab` stand-in: the project read answers the project's identity and
 * every merge request read answers `answer`. `seen` records each call's argv
 * and how many workflow model calls had happened when it ran.
 */
function gitlabForge(
  answer: Record<string, unknown>,
  model?: () => number,
): { commands: CommandRunner; calls: string[][]; modelCallsAtRead: number[] } {
  const calls: string[][] = [];
  const modelCallsAtRead: number[] = [];
  return {
    calls,
    modelCallsAtRead,
    commands: {
      async run(_command, args) {
        calls.push([...args]);
        modelCallsAtRead.push(model?.() ?? 0);
        const body = String(args.at(-1)).includes("/merge_requests/")
          ? answer
          : { id: GITLAB_PROJECT_ID, path_with_namespace: GITLAB_PROJECT_PATH };
        return { stdout: JSON.stringify(body), stderr: "", exitCode: 0 };
      },
    },
  };
}

/** A commit id the fixture checkout does not hold, so the merge request's diff is read from GitLab. */
const ABSENT_COMMIT = "e".repeat(40);

/**
 * A `glab` stand-in for a merge request this checkout lacks: each GitLab diff
 * read whose path holds a key of `reads` answers that body (or that failed
 * call), any other diff read fails as an expired login does, and the merge
 * request and project reads answer as `gitlabForge` does.
 */
function remoteGitLab(
  answer: Record<string, unknown>,
  reads: Readonly<Record<string, unknown>> = {},
): CommandRunner {
  return {
    async run(_command, args) {
      const endpoint = String(args.at(-1));
      const read = Object.entries(reads).find(([fragment]) => endpoint.includes(fragment));
      if (read !== undefined) {
        const [, body] = read;
        return typeof body === "object" && body !== null && "failure" in body
          ? (body as Awaited<ReturnType<CommandRunner["run"]>>)
          : { stdout: JSON.stringify(body), stderr: "", exitCode: 0 };
      }
      if (/\/repository\/|\/diffs\?/u.test(endpoint)) {
        return { stdout: "", stderr: "glab: 401 Unauthorized", exitCode: 1 };
      }
      const body = endpoint.includes("/merge_requests/")
        ? answer
        : { id: GITLAB_PROJECT_ID, path_with_namespace: GITLAB_PROJECT_PATH };
      return { stdout: JSON.stringify(body), stderr: "", exitCode: 0 };
    },
  };
}

/** An open merge request whose head this checkout lacks, declaring `changesCount` files. */
async function absentOpenRequest(repository: string, changesCount: string) {
  const { base } = await rangeIds(repository);
  return recordedMergeRequest(
    { base, start: base, head: ABSENT_COMMIT, merge: null },
    { state: "opened", merged_at: null, changes_count: changesCount },
  );
}

/** The plain change fixture's two commits, as a merge request's base and head. */
async function rangeIds(repository: string): Promise<{ base: string; head: string }> {
  return {
    base: await fixtureGit(repository, ["rev-parse", "HEAD~1"]),
    head: await fixtureGit(repository, ["rev-parse", "HEAD"]),
  };
}

/** A pull request merged with a merge commit, served by a fixture GitHub. */
async function mergedPull(): Promise<{
  fake: FakeGithub;
  head: string;
  baseNow: string;
  fork: string;
}> {
  const change = await buildChangeRepository(await roots.create("docsfab-change-do-gh-"));
  await fixtureGit(change.repository, [
    "merge",
    "-q",
    "--no-ff",
    "-m",
    "Merge pull request #7",
    change.head,
  ]);
  const fake = new FakeGithub(change.repository);
  await fake.servePull({
    number: 7,
    state: "closed",
    merged: true,
    baseSha: change.baseNow,
    baseRef: "main",
    headSha: change.head,
    baseNow: await fixtureGit(change.repository, ["rev-parse", "main"]),
  });
  return {
    fake,
    head: change.head,
    baseNow: change.baseNow,
    fork: change.fork,
  };
}

/** Serve GitHub from `fake` for the rest of the test. */
function serveGithub(fake: FakeGithub): FakeGithub {
  vi.stubGlobal("fetch", fake.fetch);
  return fake;
}

beforeEach(() => {
  probes.resolve = 0;
  probes.git = 0;
  probes.onResolve = undefined;
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  process.exitCode = undefined;
});

/** The fixture plus one commit the change names, with ids taken as it is built. */
async function changeFixture(): Promise<{
  fixture: SourceFixture;
  before: string;
  head: string;
}> {
  const fixture = await createSourceFixture();
  roots.track(fixture.root);
  const guide = "The export command writes to the current directory.\n";
  await commitFiles(fixture.repository, { "src/export-notes.md": guide }, "seed export notes");
  const before = await fixtureGit(fixture.repository, ["rev-parse", "HEAD"]);
  const head = await commitFiles(
    fixture.repository,
    {
      "src/export-notes.md": null,
      "src/export-guide.md": guide,
      "src/export.ts": "export const requiresOutputPath = true;\n",
    },
    "Require an explicit export path",
  );
  return { fixture, before, head };
}

/** Points the writer at the diff, so its citation names the diff observation. */
class DiffCitingHarness extends SourceToolHarness {
  public override async runStep(input: Parameters<SourceToolHarness["runStep"]>[0]) {
    if (input.step.skill === "write-documentation") {
      this.readSpans.sort(
        (left, right) =>
          Number(right.mediaType === CHANGE_SOURCE_DIFF_MEDIA_TYPE) -
          Number(left.mediaType === CHANGE_SOURCE_DIFF_MEDIA_TYPE),
      );
    }
    return super.runStep(input);
  }
}

/** Each observation's full text as the model read it, keyed by repository path. */
function readTexts(model: SourceToolHarness): Map<string, string> {
  const texts = new Map<string, string>();
  for (const window of model.windowReads) {
    const path = model.readSpans.find(
      (span) => span.spanId === window.spans[0]!.spanId,
    )!.repositoryPath;
    texts.set(path, window.spans.map((span) => span.text).join("\n"));
  }
  return texts;
}

interface DoProbe {
  readonly error?: unknown;
  readonly decision?: unknown;
  /** Requests `do` handed to the shared run path. */
  readonly runs: readonly DoRunArguments[];
  /** Records the real run path returned, under `execute`. */
  readonly records: readonly (RunRecord | undefined)[];
  /** Admission requests, with the offer's workflows. */
  readonly admissions: readonly {
    request: string;
    workflows: readonly string[];
  }[];
  /** Request-intent model calls: the first model call of a run. */
  readonly intents: number;
  /** Workflow step model calls. */
  readonly steps: number;
  readonly model: SourceToolHarness;
}

/**
 * Drive `handleDoCommand` with counting seams. With `execute`, the run seam is
 * the real `executeRunRequest`; otherwise it records the request and stops.
 */
async function driveDo(
  argv: readonly string[],
  options: {
    readonly stateDirectory: string;
    readonly execute?: boolean;
    readonly admit?: string;
    readonly model?: SourceToolHarness;
    readonly currentWorkspaceSnapshotSha256?: string;
    /** The `glab` stand-in a GitLab merge request kind reads through. */
    readonly changeRequestCommands?: CommandRunner;
  },
): Promise<DoProbe> {
  const runs: DoRunArguments[] = [];
  const records: (RunRecord | undefined)[] = [];
  const admissions: { request: string; workflows: readonly string[] }[] = [];
  let intents = 0;
  const interpreter: RequestIntentInterpreterPort = {
    async call() {
      intents += 1;
      throw new Error("request-intent model call reached in a pre-model refusal test");
    },
  };
  const model = options.model ?? new SourceToolHarness({ readOnSkill: null, planSourcePaths: [] });
  let decision: unknown;
  let error: unknown;
  try {
    decision = await handleDoCommand([...argv], {
      stateDirectory: options.stateDirectory,
      ...(options.currentWorkspaceSnapshotSha256
        ? {
            currentWorkspaceSnapshotSha256: options.currentWorkspaceSnapshotSha256,
          }
        : {}),
      admitCatalogWorkflow: async (request, offer) => {
        admissions.push({ request, workflows: [...offer.workflows] });
        return options.admit;
      },
      runWorkflow: async (request) => {
        runs.push(request);
        if (!options.execute) return undefined;
        const record = await executeRunRequest(request, runtimeConfig(options.stateDirectory), {
          silent: true,
          executionHarness: model,
          skillResolver,
          ...(options.model ? {} : { requestInterpreter: interpreter }),
          ...(options.changeRequestCommands
            ? {
                changeRequestCommands: options.changeRequestCommands,
                changeRequestEnvironment: {},
              }
            : {}),
        });
        records.push(record);
        return record;
      },
    });
  } catch (caught) {
    error = caught;
  }
  return {
    error,
    decision,
    runs,
    records,
    admissions,
    intents,
    steps: model.calls.length,
    model,
  };
}

function changeSourceCode(error: unknown): ChangeSourceRefusalCode | undefined {
  return error instanceof ChangeSourceError ? error.code : undefined;
}

/** `do` argv for the create route with the fixture's concrete instruction. */
function createArgv(repository: string, ...extra: string[]): string[] {
  return [
    CREATE_SENTENCE,
    "--repo",
    repository,
    "--instruction",
    runRequest({ repository }).instruction,
    "--patch-only",
    "--quiet",
    ...extra,
  ];
}

/** One open editorial needs-input run for `repositoryPath` that asks for a `prd` text fill. */
async function openEditorialRun(stateDirectory: string, repositoryPath: string): Promise<void> {
  const record: RunRecord = {
    schemaVersion: 2,
    id: "change-do-open-run",
    workflow: "update-documentation",
    repository: {
      sourcePath: repositoryPath,
      requestedRevision: "HEAD",
      revision: "b".repeat(40),
    },
    workspace: { strategy: "tracked-export", disposable: true },
    instruction: "Update docs/cli.md so it documents the current public option.",
    status: "needs-input",
    createdAt: "2026-09-16T12:00:00.000Z",
    completedAt: "2026-09-16T12:00:01.000Z",
    models: [],
    skills: [],
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
      turns: 0,
    },
    tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
    steps: [
      {
        id: "plan-documentation",
        title: "Plan documentation",
        skill: "plan-documentation",
        mode: "read-only",
        status: "needs-input",
        summary: "The planner asked for named InputAsk fills.",
      },
    ],
  };
  const evidence = workflowOutcomeStepEvidence(record, "plan-documentation");
  record.workflowOutcome = createWorkflowOutcome(
    {
      disposition: "needs-input",
      findings: [
        {
          id: "finding:editorial:prd",
          kind: "missing-governed-input",
          severity: "warning",
          code: "independent-rejection",
          inputId: "prd",
          evidenceIds: [evidence.id],
        },
      ],
      evidence: [evidence],
      limitations: [],
      openDecisions: [
        {
          id: "decision:editorial:prd",
          kind: "governed-input",
          inputId: "prd",
          evidenceIds: [evidence.id],
        },
      ],
      producedArtifacts: [],
    },
    record,
  );
  await writeFile(
    join(stateDirectory, `${record.id}.json`),
    `${JSON.stringify(record, null, 2)}\n`,
    { mode: 0o600 },
  );
}

async function emptyState(): Promise<string> {
  return roots.create("docsfab-change-do-state-", { mode: 0o700 });
}

describe("docsfab do --change end to end", () => {
  it(
    "routes a create request, binds the diff and manifest, and cites the diff through do",
    async () => {
      const { fixture, before, head } = await changeFixture();
      const model = new DiffCitingHarness({
        readOnSkill: "plan-documentation",
        planSourcePaths: [HTML_SOURCE_PATH],
        readWindowMaxBytes: sourceReadBudgetForModel(undefined).budgetBytes,
      });
      const probe = await driveDo(createArgv(fixture.repository, "--change", "HEAD~1..HEAD"), {
        stateDirectory: fixture.stateDirectory,
        execute: true,
        model,
      });
      expect(probe.error).toBeUndefined();
      expect(probe.decision).toMatchObject({
        status: "selected",
        workflow: "create-documentation",
      });
      expect(probe.admissions).toEqual([]);
      expect(probe.runs).toHaveLength(1);
      expect(probe.runs[0]!.changeSource).toEqual(parseChangeSourceSelector("HEAD~1..HEAD"));
      expect(probes.resolve).toBe(1);

      const diffPath = changeSourceRepositoryPath(head, "diff");
      const manifestPath = changeSourceRepositoryPath(head, "manifest");
      expect([...model.listedPaths].sort()).toEqual([diffPath, manifestPath].sort());
      const manifest = JSON.parse(readTexts(model).get(manifestPath)!) as ChangeSourceV1;
      expect(manifest.revision).toMatchObject({ base: before, head });
      expect(manifest.commits.map((commit) => commit.id)).toEqual([head]);
      expect(readTexts(model).get(diffPath)!.split("\n")).toContain(
        "+export const requiresOutputPath = true;",
      );
      // The diff extracts through the unified diff adapter: a manifest span
      // first, then diff locators that name the changed files.
      const diffLocators = model.listed
        .filter((entry) => entry.repositoryPath === diffPath)
        .map((entry) => entry.locator);
      expect(diffLocators.length).toBeGreaterThan(0);
      expect(diffLocators.every((locator) => locator.kind === "diff")).toBe(true);
      expect(diffLocators[0]).toMatchObject({ kind: "diff", part: "manifest" });
      expect(diffLocators).toContainEqual(
        expect.objectContaining({
          kind: "diff",
          part: "hunk",
          hunkOrdinal: expect.any(Number),
          newPath: "src/export.ts",
        }),
      );

      // The writer's citation names the diff observation `do` bound.
      const record = probe.records[0];
      expect(record?.status).toBe("succeeded");
      const diffObservation = model.listed.find((entry) => entry.repositoryPath === diffPath)!;
      const citations = record!.sourceCitations!.steps.flatMap((step) => step.citations);
      expect(citations.map((citation) => citation.observationId)).toEqual([
        diffObservation.observationId,
      ]);
      // The persisted record cites exactly the change do bound, by the
      // observations the model listed.
      const saved = JSON.parse(
        readFileSync(join(fixture.stateDirectory, `${record!.id}.json`), "utf8"),
      ) as RunRecord;
      const listedId = (path: string) =>
        model.listed.find((entry) => entry.repositoryPath === path)!.observationId;
      expect(
        saved.changeSources?.map((entry) => ({
          sourceKind: entry.sourceKind,
          base: entry.base,
          head: entry.head,
          changeSourceSha256: entry.changeSourceSha256,
          observations: [...entry.observations].sort((a, b) => a.role.localeCompare(b.role)),
        })),
      ).toEqual([
        {
          sourceKind: "local-range",
          base: before,
          head,
          changeSourceSha256: manifest.changeSourceSha256,
          observations: [
            { role: "diff", observationId: listedId(diffPath) },
            { role: "manifest", observationId: listedId(manifestPath) },
          ],
        },
      ]);
    },
    testTimeoutMs(60_000),
  );

  it(
    "routes an update request to update-documentation and binds the same range",
    async () => {
      const { fixture, head } = await changeFixture();
      const model = new SourceToolHarness({
        readOnSkill: "plan-documentation",
        planSourcePaths: [HTML_SOURCE_PATH],
      });
      const probe = await driveDo(
        [
          UPDATE_SENTENCE,
          "--repo",
          fixture.repository,
          "--patch-only",
          "--quiet",
          "--change",
          "HEAD~1..HEAD",
        ],
        { stateDirectory: fixture.stateDirectory, execute: true, model },
      );
      expect(probe.error).toBeUndefined();
      expect(probe.decision).toMatchObject({
        status: "selected",
        workflow: "update-documentation",
      });
      expect(probe.runs.map((run) => run.workflow)).toEqual(["update-documentation"]);
      expect([...model.listedPaths].sort()).toEqual(
        [
          changeSourceRepositoryPath(head, "diff"),
          changeSourceRepositoryPath(head, "manifest"),
        ].sort(),
      );
    },
    testTimeoutMs(60_000),
  );
});

/** The selector `docsfab run` admits for the same `--change` value. */
function runSelector(value: string) {
  return parseRunArguments([
    "update-documentation",
    "--instruction",
    "Update docs/whats-new.md for the change.",
    "--change",
    value,
  ]).changeSource;
}

describe("docsfab do --change reads every kind docsfab run reads", () => {
  it(
    "binds a GitLab merge request's diff through the shared run path, read before any model call",
    async () => {
      const { fixture, before, head } = await changeFixture();
      const model = new SourceToolHarness({
        readOnSkill: "plan-documentation",
        planSourcePaths: [HTML_SOURCE_PATH],
      });
      const stub = gitlabForge(
        recordedMergeRequest(
          { base: before, start: before, head, merge: null },
          { state: "opened", merged_at: null },
        ),
        () => model.calls.length,
      );
      const probe = await driveDo(createArgv(fixture.repository, "--change", GITLAB_MR_URL), {
        stateDirectory: fixture.stateDirectory,
        execute: true,
        model,
        changeRequestCommands: stub.commands,
      });
      expect(probe.error).toBeUndefined();
      expect(probe.decision).toMatchObject({
        status: "selected",
        workflow: "create-documentation",
      });
      expect(probe.admissions).toEqual([]);
      // The same selector docsfab run admits, of the merge request kind.
      expect(probe.runs[0]!.changeSource).toEqual(runSelector(GITLAB_MR_URL));
      expect(probe.runs[0]!.changeSource?.source).toBe("gitlab-merge-request");
      expect(Object.hasOwn(probe.runs[0]!, "changeRequestSelector")).toBe(false);
      expect(probes.resolve).toBe(1);
      expect(probe.records[0]?.status).toBe("succeeded");
      // One read pins the open merge request, by GET, before any model call.
      expect(stub.calls).toHaveLength(1);
      expect(stub.calls[0]!.slice(0, 5)).toEqual([
        "api",
        "--hostname",
        "gitlab.example.test",
        "--method",
        "GET",
      ]);
      expect(stub.modelCallsAtRead).toEqual([0]);
      expect(model.calls.length).toBeGreaterThan(0);
      expect([...model.listedPaths].sort()).toEqual(
        [
          changeSourceRepositoryPath(head, "diff"),
          changeSourceRepositoryPath(head, "manifest"),
        ].sort(),
      );
      const saved = JSON.parse(
        readFileSync(join(fixture.stateDirectory, `${probe.records[0]!.id}.json`), "utf8"),
      ) as RunRecord;
      expect(
        saved.changeSources?.map(({ sourceKind, base, head: pinned }) => ({
          sourceKind,
          base,
          head: pinned,
        })),
      ).toEqual([{ sourceKind: "gitlab-merge-request", base: before, head }]);
    },
    testTimeoutMs(60_000),
  );

  it(
    "binds a release range as run does: resolved before any model call, each unit and the index cited",
    async () => {
      const { fixture, base, plain, merge } = await createReleaseFixture();
      roots.track(fixture.root);
      const model = new SourceToolHarness({
        readOnSkill: "plan-documentation",
        planSourcePaths: [HTML_SOURCE_PATH],
        readWindowMaxBytes: sourceReadBudgetForModel(undefined).budgetBytes,
      });
      const modelCallsAtResolve: number[] = [];
      probes.onResolve = () => modelCallsAtResolve.push(model.calls.length);
      const probe = await driveDo(
        createArgv(fixture.repository, "--change", "release:v1.0..v1.1"),
        { stateDirectory: fixture.stateDirectory, execute: true, model },
      );
      expect(probe.error).toBeUndefined();
      expect(probe.decision).toMatchObject({
        status: "selected",
        workflow: "create-documentation",
      });
      expect(probe.admissions).toEqual([]);
      // The same selector docsfab run admits, of the release kind.
      expect(probe.runs[0]!.changeSource).toEqual(runSelector("release:v1.0..v1.1"));
      expect(probe.runs[0]!.changeSource?.source).toBe("release-range");
      // One resolution, entered before the first model call; the run then reached the model.
      expect(modelCallsAtResolve).toEqual([0]);
      expect(model.calls.length).toBeGreaterThan(0);
      expect(probe.records[0]?.status).toBe("succeeded");

      const indexPath = releaseUnitsRepositoryPath(base, merge);
      const unitPaths = [plain, merge].flatMap((unit) => [
        changeSourceRepositoryPath(unit, "manifest"),
        changeSourceRepositoryPath(unit, "diff"),
      ]);
      expect([...model.listedPaths].sort()).toEqual([indexPath, ...unitPaths].sort());
      const listedId = (path: string) =>
        model.listed.find((entry) => entry.repositoryPath === path)!.observationId;
      const index = decodeReleaseUnitsIndexV1(JSON.parse(readTexts(model).get(indexPath)!));

      const saved = JSON.parse(
        readFileSync(join(fixture.stateDirectory, `${probe.records[0]!.id}.json`), "utf8"),
      ) as Record<string, unknown>;
      // One entry per bound unit, in index order, each citing the observations the model listed.
      const entries = saved.changeSources as RunRecord["changeSources"];
      expect(
        entries?.map((entry) => ({
          sourceKind: entry.sourceKind,
          head: entry.head,
          changeSourceSha256: entry.changeSourceSha256,
          observations: [...entry.observations].sort((a, b) => a.role.localeCompare(b.role)),
        })),
      ).toEqual(
        index.units.map((unit) => ({
          sourceKind: "release-range",
          head: unit.id,
          changeSourceSha256:
            unit.evidence.state === "bound" ? unit.evidence.changeSourceSha256 : null,
          observations: [
            {
              role: "diff",
              observationId: listedId(changeSourceRepositoryPath(unit.id, "diff")),
            },
            {
              role: "manifest",
              observationId: listedId(changeSourceRepositoryPath(unit.id, "manifest")),
            },
          ],
        })),
      );
      expect(index.units.map((unit) => unit.id)).toEqual([plain, merge]);
      expect(saved.changeSourceRelease).toEqual({
        schemaVersion: 1,
        kind: "docsfab-run-change-source-release",
        repository: index.revision.repository,
        objectFormat: index.objectFormat,
        base,
        head: merge,
        releaseUnitsSha256: index.releaseUnitsSha256,
        observationId: listedId(indexPath),
        units: 2,
        pageUnits: 2,
        omittedUnits: 0,
        remainingUnits: 0,
        continuation: null,
      });
      // The persisted pair decodes through the shared reader.
      expect(
        decodeRunChangeSourceRelease(
          saved.changeSourceRelease,
          saved.workflow,
          saved.changeSources,
        ),
      ).toEqual(saved.changeSourceRelease);
    },
    testTimeoutMs(120_000),
  );

  it("keeps --mr on do text-only: it hands no change source to the run path", async () => {
    const stateDirectory = await emptyState();
    const probe = await driveDo(
      [UPDATE_SENTENCE, "--repo", "/tmp/change-do", "--patch-only", "--mr", GITLAB_MR_URL],
      { stateDirectory },
    );
    expect(probe.error).toBeUndefined();
    expect(probe.runs).toHaveLength(1);
    expect(probe.runs[0]!.changeRequestSelector).toMatchObject({
      provider: "gitlab",
    });
    expect(Object.hasOwn(probe.runs[0]!, "changeSource")).toBe(false);
    // Contrast: docsfab run --mr derives the merge request's change source.
    expect(
      parseRunArguments([
        "update-documentation",
        "--instruction",
        "Update docs/whats-new.md for the change.",
        "--mr",
        GITLAB_MR_URL,
      ]).changeSource,
    ).toEqual(runSelector(GITLAB_MR_URL));
  });

  it(
    "binds a merged GitHub pull request through the shared run path, read before any model call",
    async () => {
      const { fixture } = await changeFixture();
      const { fake, head } = await mergedPull();
      const model = new SourceToolHarness({
        readOnSkill: "plan-documentation",
        planSourcePaths: [HTML_SOURCE_PATH],
      });
      const modelCallsAtRead: number[] = [];
      vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
        modelCallsAtRead.push(model.calls.length);
        return fake.fetch(url, init);
      });
      const probe = await driveDo(createArgv(fixture.repository, "--change", GITHUB_PULL), {
        stateDirectory: fixture.stateDirectory,
        execute: true,
        model,
      });
      expect(probe.error).toBeUndefined();
      expect(probe.decision).toMatchObject({
        status: "selected",
        workflow: "create-documentation",
      });
      expect(probe.admissions).toEqual([]);
      expect(probe.runs[0]!.changeSource).toEqual(runSelector(GITHUB_PULL));
      expect(probe.runs[0]!.changeSource?.source).toBe("github-pull-request");
      expect(probes.resolve).toBe(1);
      expect(probe.records[0]?.status).toBe("succeeded");
      expect(modelCallsAtRead.length).toBeGreaterThan(0);
      expect(modelCallsAtRead.every((calls) => calls === 0)).toBe(true);
      expect(model.calls.length).toBeGreaterThan(0);
      expect([...model.listedPaths].sort()).toEqual(
        [
          changeSourceRepositoryPath(head, "diff"),
          changeSourceRepositoryPath(head, "manifest"),
        ].sort(),
      );
    },
    testTimeoutMs(90_000),
  );

  it("parses forge values under --dry-run and --route-only without reading GitLab or GitHub", async () => {
    const stateDirectory = await emptyState();
    const repository = await roots.create("docsfab-change-do-repo-");
    const github = new FakeGithub("unused");
    serveGithub(github);
    for (const mode of ["--dry-run", "--route-only"]) {
      for (const value of [GITLAB_MR_URL, GITHUB_PULL]) {
        const stub = gitlabForge({});
        const probe = await driveDo(
          [UPDATE_SENTENCE, "--repo", repository, mode, "--change", value],
          {
            stateDirectory,
            execute: true,
            changeRequestCommands: stub.commands,
          },
        );
        expect(probe.error, `${mode} ${value}`).toBeUndefined();
        expect(probe.decision, `${mode} ${value}`).toMatchObject({
          workflow: "update-documentation",
        });
        expect(probe.runs, `${mode} ${value}`).toEqual([]);
        expect(stub.calls, `${mode} ${value}`).toEqual([]);
      }
    }
    expect(github.requests).toEqual([]);
    expect(probes.resolve).toBe(0);
  });

  it("refuses a value no kind claims as an unsupported kind that names no forge", () => {
    let caught: unknown;
    try {
      parseDoArguments([CREATE_SENTENCE, "--change", FOREIGN_FORGE_URL]);
    } catch (error) {
      caught = error;
    }
    expect(changeSourceCode(caught)).toBe("change-source-kind-unsupported");
    expect((caught as Error).message).toContain(
      CHANGE_SOURCE_REFUSALS["change-source-kind-unsupported"],
    );
    // The value the row used before the merge request kind landed now parses as that kind.
    expect(
      parseDoArguments([CREATE_SENTENCE, "--change", MERGE_REQUEST_URL]).changeSource,
    ).toMatchObject({
      source: "gitlab-merge-request",
    });
  });
});

describe("--change never feeds routing", () => {
  it("routes and previews exactly as the same request without --change", async () => {
    const stateDirectory = await emptyState();
    for (const sentence of [CREATE_SENTENCE, UPDATE_SENTENCE, ADMISSION_SENTENCE]) {
      const plain = await driveDo([sentence, "--repo", "/tmp/change-do", "--route-only"], {
        stateDirectory,
      });
      const withChange = await driveDo(
        [sentence, "--repo", "/tmp/change-do", "--route-only", "--change", "HEAD"],
        { stateDirectory },
      );
      expect(plain.error, sentence).toBeUndefined();
      expect(withChange.error, sentence).toBeUndefined();
      expect(withChange.decision, sentence).toEqual(plain.decision);
      expect(withChange.admissions, sentence).toEqual([]);
    }
  });

  it("asks the admission model with the same request text and offer", async () => {
    const stateDirectory = await emptyState();
    const plain = await driveDo([ADMISSION_SENTENCE, "--repo", "/tmp/change-do", "--patch-only"], {
      stateDirectory,
    });
    const withChange = await driveDo(
      [ADMISSION_SENTENCE, "--repo", "/tmp/change-do", "--patch-only", "--change", "HEAD"],
      { stateDirectory },
    );
    expect(plain.admissions).toHaveLength(1);
    expect(plain.admissions[0]!.request).toBe(ADMISSION_SENTENCE);
    expect(withChange.admissions).toEqual(plain.admissions);
    expect(withChange.decision).toEqual(plain.decision);
    // Positive control: the abstain left both at needs-input, so neither ran.
    expect(plain.runs).toEqual([]);
    expect(withChange.runs).toEqual([]);
  });

  it("forwards the parsed range to the run seam and nothing for a plain request", async () => {
    const stateDirectory = await emptyState();
    const plain = await driveDo([UPDATE_SENTENCE, "--repo", "/tmp/change-do", "--patch-only"], {
      stateDirectory,
    });
    const withChange = await driveDo(
      [UPDATE_SENTENCE, "--repo", "/tmp/change-do", "--patch-only", "--change=main...HEAD"],
      { stateDirectory },
    );
    expect(plain.runs).toHaveLength(1);
    expect(Object.hasOwn(plain.runs[0]!, "changeSource")).toBe(false);
    expect(withChange.runs).toHaveLength(1);
    expect(withChange.runs[0]!.changeSource).toEqual(parseChangeSourceSelector("main...HEAD"));
    // Same request apart from the change: the selection is the only difference.
    const { changeSource: _bound, ...rest } = withChange.runs[0]!;
    expect(rest).toEqual(plain.runs[0]);
  });
});

/**
 * Each code reaches `do` from one argv. `stage` says where it stops: `parse`
 * and `route` before the run seam; `continuation` before an open run is
 * continued; `resolution` inside the shared run path, before request intent.
 */
interface ReachedRow {
  readonly stage: "parse" | "route" | "continuation" | "resolution";
  readonly argv: (repository: string) => readonly string[];
  /** Builds the repository the row needs; the default is the plain change fixture. */
  readonly repository?: () => Promise<string>;
  /** Writes an open editorial run for the repository first. */
  readonly openRun?: boolean;
  readonly environment?: Readonly<Record<string, string>>;
  readonly detail?: string;
  /**
   * Stands up the forge the row reads, from the row's repository: a GitLab
   * row returns its `glab` stand-in; a GitHub row serves the global fetch.
   */
  readonly forge?: (repository: string) => Promise<CommandRunner | undefined>;
}

async function plainRepository(): Promise<string> {
  return (await changeFixture()).fixture.repository;
}

async function sourceRepository(): Promise<SourceFixture> {
  const fixture = await createSourceFixture();
  roots.track(fixture.root);
  return fixture;
}

/**
 * Every change-source code: reached from `do`, or unreachable from `do` with
 * the reason. Typed over the whole code list, so a new code fails to compile
 * here until it is placed, and the runtime check below fails too.
 */
const REFUSAL_TABLE: Readonly<
  Record<ChangeSourceRefusalCode, ReachedRow | { unreachable: string }>
> = {
  "change-source-option-value-missing": {
    stage: "parse",
    // Raw argv: a boolean flag is never taken as the range.
    argv: (repository) => createArgv(repository, "--change", "--json", "HEAD"),
  },
  "change-source-option-form-unrecognized": {
    stage: "parse",
    argv: (repository) => createArgv(repository, "--change:HEAD"),
  },
  "change-source-selector-repeated": {
    stage: "parse",
    argv: (repository) => createArgv(repository, "--change", "HEAD", "--change=HEAD~1..HEAD"),
  },
  "change-source-selector-grammar": {
    stage: "parse",
    argv: (repository) => createArgv(repository, "--change", "HEAD^!"),
  },
  "change-source-kind-unsupported": {
    stage: "parse",
    // No kind claims another forge's pull request; GitLab and GitHub forms have their own rows.
    argv: (repository) => createArgv(repository, "--change", FOREIGN_FORGE_URL),
  },
  "change-source-selector-conflict": {
    stage: "parse",
    argv: (repository) => createArgv(repository, "--change", "HEAD", "--pr", MERGE_REQUEST_URL),
  },
  "change-source-workflow-unsupported": {
    stage: "route",
    argv: (repository) => [REVIEW_SENTENCE, "--repo", repository, "--change", "HEAD"],
    detail: "the quoted request routed to review-documentation; nothing was read",
  },
  "change-source-resume-unsupported": {
    stage: "continuation",
    openRun: true,
    argv: (repository) => [
      "The product requirements are in docs/prd.md.",
      "--repo",
      repository,
      "--change",
      "HEAD",
    ],
    detail:
      "an editorial needs-input run is open for this repository, so do would continue it with this sentence as its reply; reply without --change, or start a fresh run with docsfab run <workflow> --change",
  },
  "change-source-date-window-conflict": {
    stage: "route",
    argv: (repository) => [WINDOW_SENTENCE, "--repo", repository, "--change", "HEAD"],
  },
  "change-source-revision-unresolved": {
    stage: "resolution",
    argv: (repository) => createArgv(repository, "--change", "no-such-branch..HEAD"),
  },
  "change-source-history-unavailable": {
    stage: "resolution",
    repository: async () => {
      const repository = await plainRepository();
      const shallow = join(await roots.create("docsfab-change-do-shallow-"), "shallow");
      await fixtureGit(repository, ["clone", "-q", "--depth=1", `file://${repository}`, shallow]);
      return shallow;
    },
    argv: (repository) => createArgv(repository, "--change", "HEAD~1..HEAD"),
  },
  "change-source-no-merge-base": {
    stage: "resolution",
    repository: async () => {
      const repository = await plainRepository();
      await fixtureGit(repository, ["branch", "mainline"]);
      await fixtureGit(repository, ["checkout", "-q", "--orphan", "island"]);
      await commitFiles(repository, { "island.md": "isle\n" }, "island root");
      return repository;
    },
    argv: (repository) => createArgv(repository, "--change", "mainline...island"),
  },
  "change-source-empty-range": {
    stage: "resolution",
    argv: (repository) => createArgv(repository, "--change", "HEAD..HEAD"),
  },
  "change-source-integrity-mismatch": {
    stage: "resolution",
    repository: async () => {
      const { repository } = await sourceRepository();
      const interior = await commitFiles(repository, { "src/a.md": "one\n" }, "interior");
      await commitFiles(repository, { "src/a.md": "two\n" }, "head");
      await rewriteLooseObject(repository, interior, (body) =>
        Buffer.from(body.toString("latin1").replace("interior", "INTERIOR"), "latin1"),
      );
      return repository;
    },
    argv: (repository) => createArgv(repository, "--change", "HEAD~2..HEAD"),
  },
  "change-source-grafts-present": {
    stage: "resolution",
    repository: async () => {
      const repository = await plainRepository();
      const middle = await fixtureGit(repository, ["rev-parse", "HEAD~1"]);
      await writeFile(join(repository, ".git", "info", "grafts"), `${middle}\n`);
      return repository;
    },
    argv: (repository) => createArgv(repository, "--change", "HEAD~2..HEAD"),
  },
  "change-source-encoding-unsupported": {
    stage: "resolution",
    repository: async () => {
      const repository = await plainRepository();
      await commitFiles(
        repository,
        { "src/latin.txt": Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]) },
        "latin-1",
      );
      return repository;
    },
    argv: (repository) => createArgv(repository, "--change", "HEAD~1..HEAD"),
  },
  "change-source-credential-present": {
    stage: "resolution",
    repository: async () => {
      const repository = await plainRepository();
      const planted = configureCredential("planted-change-do-fixture-value");
      await commitFiles(repository, { "src/leak.md": `value ${planted}\n` }, "plant");
      return repository;
    },
    argv: (repository) => createArgv(repository, "--change", "HEAD~1..HEAD"),
  },
  "change-source-limits-inconsistent": {
    stage: "resolution",
    environment: {
      DOCSFAB_CHANGE_SOURCES_DIFF_MAX_BYTES: String(limit("changeSources.fileDiffMaxBytes").value),
      DOCSFAB_CHANGE_SOURCES_FILE_DIFF_MAX_BYTES: String(
        limit("changeSources.fileDiffMaxBytes").value + 1,
      ),
    },
    argv: (repository) => createArgv(repository, "--change", "HEAD~1..HEAD"),
  },
  "change-source-git-failed": {
    stage: "resolution",
    repository: async () => {
      const { repository } = await sourceRepository();
      const root = await fixtureGit(repository, ["rev-parse", "HEAD"]);
      const interior = await commitFiles(repository, { "src/a.md": "one\n" }, "interior");
      await commitFiles(repository, { "src/a.md": "two\n" }, "head");
      const path = join(repository, ".git", "objects", interior.slice(0, 2), interior.slice(2));
      await chmod(path, 0o644);
      await writeFile(path, Buffer.from("not a zlib stream"));
      // Both endpoints resolve; the merge base walk fails on the broken commit.
      await fixtureGit(repository, ["tag", "fixture-root", root]);
      return repository;
    },
    argv: (repository) => createArgv(repository, "--change", "fixture-root...HEAD"),
  },
  "change-source-resolution-missing": {
    unreachable:
      "embedder-only guard in cli/run/execution.ts; do hands its request to executeRunRequest, whose local-workflow path resolves the range first",
  },
  "change-source-mr-objects-unavailable": {
    stage: "resolution",
    // The merge commit is not in this checkout, DocsFab never fetches, and
    // reading its diff from GitLab fails too.
    forge: async (repository) => {
      const { base, head } = await rangeIds(repository);
      return remoteGitLab(
        recordedMergeRequest({
          base,
          start: base,
          head,
          merge: ABSENT_COMMIT,
        }),
      );
    },
    argv: (repository) => createArgv(repository, "--change", GITLAB_MR_URL),
  },
  "change-source-mr-closed-unmerged": {
    stage: "resolution",
    forge: async (repository) => {
      const { base, head } = await rangeIds(repository);
      return gitlabForge(
        recordedMergeRequest(
          { base, start: base, head, merge: null },
          { state: "closed", merged_at: null },
        ),
      ).commands;
    },
    argv: (repository) => createArgv(repository, "--change", GITLAB_MR_URL),
  },
  "change-source-mr-locked": {
    stage: "resolution",
    forge: async (repository) => {
      const { base, head } = await rangeIds(repository);
      return gitlabForge(
        recordedMergeRequest({ base, start: base, head, merge: null }, { state: "locked" }),
      ).commands;
    },
    argv: (repository) => createArgv(repository, "--change", GITLAB_MR_URL),
  },
  "change-source-mr-diff-refs-missing": {
    stage: "resolution",
    forge: async (repository) => {
      const { base, head } = await rangeIds(repository);
      return gitlabForge(
        recordedMergeRequest({ base, start: base, head, merge: null }, { diff_refs: null }),
      ).commands;
    },
    argv: (repository) => createArgv(repository, "--change", GITLAB_MR_URL),
  },
  "change-source-mr-moved": {
    stage: "resolution",
    // GitLab reports a head other than its diff's head.
    forge: async (repository) => {
      const { base, head } = await rangeIds(repository);
      return gitlabForge(
        recordedMergeRequest(
          { base, start: base, head, merge: null },
          { state: "opened", merged_at: null, sha: base },
        ),
      ).commands;
    },
    argv: (repository) => createArgv(repository, "--change", GITLAB_MR_URL),
  },
  "change-source-github-url-credentials": {
    stage: "parse",
    argv: (repository) =>
      createArgv(
        repository,
        "--change",
        `https://user:fixture-pass@github.com/${OWNER}/${NAME}/pull/7`,
      ),
  },
  "change-source-github-url-insecure": {
    stage: "parse",
    argv: (repository) =>
      createArgv(repository, "--change", `http://github.com/${OWNER}/${NAME}/pull/7`),
  },
  "change-source-github-url-grammar": {
    stage: "parse",
    argv: (repository) => createArgv(repository, "--change", `${GITHUB_PULL}?w=1`),
  },
  "change-source-github-url-partial": {
    stage: "parse",
    argv: (repository) =>
      createArgv(repository, "--change", `${GITHUB_PULL}/commits/${"a".repeat(40)}`),
  },
  "change-source-github-compare-unsupported": {
    stage: "parse",
    // One ref names no range to read.
    argv: (repository) =>
      createArgv(repository, "--change", `https://github.com/${OWNER}/${NAME}/compare/main`),
  },
  "change-source-github-pull-closed-unmerged": {
    stage: "resolution",
    forge: async () => {
      const fake = new FakeGithub("unused");
      fake.body(
        `/repos/${OWNER}/${NAME}/pulls/7`,
        pullJson({
          number: 7,
          state: "closed",
          merged: false,
          baseSha: "a".repeat(40),
          baseRef: "main",
          headSha: "b".repeat(40),
          commits: 1,
          changedFiles: 1,
        }),
      );
      serveGithub(fake);
      return undefined;
    },
    argv: (repository) => createArgv(repository, "--change", GITHUB_PULL),
  },
  "change-source-github-head-moved": {
    stage: "resolution",
    // The last read of the pull request reports another head.
    forge: async () => {
      const { fake, baseNow } = await mergedPull();
      fake.body(
        `/repositories/${REPOSITORY_ID}/pulls/7`,
        pullJson({
          number: 7,
          state: "closed",
          merged: true,
          baseSha: baseNow,
          baseRef: "main",
          headSha: baseNow,
          commits: 3,
          changedFiles: 6,
        }),
      );
      serveGithub(fake);
      return undefined;
    },
    argv: (repository) => createArgv(repository, "--change", GITHUB_PULL),
  },
  "change-source-github-incomplete": {
    stage: "resolution",
    // The compare lists one commit fewer than the pull request declares.
    forge: async () => {
      const { fake, baseNow, head } = await mergedPull();
      const path = `/repositories/${REPOSITORY_ID}/compare/${baseNow}...${head}?per_page=100`;
      const whole = await fake.compareJson(baseNow, head);
      fake.body(path, { ...whole, commits: whole.commits.slice(1) });
      serveGithub(fake);
      return undefined;
    },
    argv: (repository) => createArgv(repository, "--change", GITHUB_PULL),
  },
  "change-source-github-tree-truncated": {
    stage: "resolution",
    forge: async () => {
      const { fake, fork, head } = await mergedPull();
      for (const commit of [fork, head]) {
        const tree = await fixtureGit(fake.repository, ["rev-parse", `${commit}^{tree}`]);
        fake.body(`/repositories/${REPOSITORY_ID}/git/trees/${tree}?recursive=1`, {
          sha: tree,
          truncated: true,
          tree: [],
        });
      }
      serveGithub(fake);
      return undefined;
    },
    argv: (repository) => createArgv(repository, "--change", GITHUB_PULL),
  },
  "change-source-github-redirect-cross-host": {
    stage: "resolution",
    forge: async () => {
      serveGithub(
        new FakeGithub("unused").body(
          `/repos/${OWNER}/${NAME}/pulls/7`,
          {},
          {
            status: 302,
            headers: {
              location: "https://evil.example.test/repositories/1/pulls/7",
            },
          },
        ),
      );
      return undefined;
    },
    argv: (repository) => createArgv(repository, "--change", GITHUB_PULL),
  },
  "change-source-github-rate-limited": {
    stage: "resolution",
    forge: async () => {
      serveGithub(
        new FakeGithub("unused").body(
          `/repos/${OWNER}/${NAME}/pulls/7`,
          { message: "rate" },
          {
            status: 403,
            headers: {
              "x-ratelimit-remaining": "0",
              "x-ratelimit-reset": "1790000000",
            },
          },
        ),
      );
      return undefined;
    },
    argv: (repository) => createArgv(repository, "--change", GITHUB_PULL),
  },
  "change-source-github-forbidden": {
    stage: "resolution",
    forge: async () => {
      serveGithub(
        new FakeGithub("unused").body(
          `/repos/${OWNER}/${NAME}/pulls/7`,
          { message: "denied" },
          { status: 403, headers: { "x-ratelimit-remaining": "41" } },
        ),
      );
      return undefined;
    },
    argv: (repository) => createArgv(repository, "--change", GITHUB_PULL),
  },
  "change-source-github-not-found": {
    stage: "resolution",
    // The fixture GitHub answers 404 for every path it does not serve.
    forge: async () => {
      serveGithub(new FakeGithub("unused"));
      return undefined;
    },
    argv: (repository) => createArgv(repository, "--change", GITHUB_PULL),
  },
  "change-source-github-request-failed": {
    stage: "resolution",
    forge: async () => {
      serveGithub(
        new FakeGithub("unused").body(`/repos/${OWNER}/${NAME}/pulls/7`, {}, { status: 502 }),
      );
      return undefined;
    },
    argv: (repository) => createArgv(repository, "--change", GITHUB_PULL),
  },
  "change-source-github-unreachable": {
    stage: "resolution",
    forge: async () => {
      vi.stubGlobal("fetch", async () => {
        throw new TypeError("fetch failed");
      });
      return undefined;
    },
    argv: (repository) => createArgv(repository, "--change", GITHUB_PULL),
  },
  "change-source-github-response-invalid": {
    stage: "resolution",
    // A 200 answer for the commit's repository without its id or name.
    forge: async () => {
      serveGithub(
        new FakeGithub("unused").body(`/repos/${OWNER}/${NAME}`, {
          message: "padding",
        }),
      );
      return undefined;
    },
    argv: (repository) =>
      createArgv(repository, "--change", `https://github.com/${OWNER}/${NAME}/commit/abcdef1`),
  },
  "change-source-github-two-dot-not-ancestor": {
    stage: "resolution",
    // main moved on after the feature branch forked, so main..feature diverges.
    forge: async () => {
      const change = await buildChangeRepository(await roots.create("docsfab-change-do-gh-"));
      const fake = new FakeGithub(change.repository);
      await fake.serveCompare("main", "feature/export-path");
      serveGithub(fake);
      return undefined;
    },
    argv: (repository) =>
      createArgv(
        repository,
        "--change",
        `https://github.com/${OWNER}/${NAME}/compare/main..feature/export-path`,
      ),
  },
  "change-source-github-pr-not-pull-request": {
    unreachable:
      "run-only: do keeps --pr and --mr GitLab-only, so a GitHub URL there refuses with the change-request selector's unsupported-provider before the run-only --pr block in cli/run-arguments.ts could see it",
  },
  "change-source-record-unbound": {
    unreachable:
      "host-defect guard in cli/run/execution.ts runChangeSourcesForRun; it fires only when a resolved change source fails to reach the runner, and both acquisition paths do reaches return the acquired change whenever one resolved, so no do argv causes it; the end-to-end tests above assert the persisted changeSources entry",
  },
  "change-source-mr-forge-incomplete": {
    stage: "resolution",
    // GitLab answers the merge commit's read about another commit.
    forge: async (repository) => {
      const { base, head } = await rangeIds(repository);
      return remoteGitLab(recordedMergeRequest({ base, start: base, head, merge: ABSENT_COMMIT }), {
        [`/repository/commits/${ABSENT_COMMIT}`]: {
          id: "f".repeat(40),
          parent_ids: [base],
          message: "Merge\n",
          stats: { additions: 0, deletions: 0, total: 0 },
        },
      });
    },
    argv: (repository) => createArgv(repository, "--change", GITLAB_MR_URL),
  },
  "change-source-mr-forge-overflow": {
    stage: "resolution",
    forge: async (repository) => remoteGitLab(await absentOpenRequest(repository, "3+")),
    argv: (repository) => createArgv(repository, "--change", GITLAB_MR_URL),
  },
  "change-source-mr-forge-text-replaced": {
    stage: "resolution",
    forge: async (repository) =>
      remoteGitLab(await absentOpenRequest(repository, "1"), {
        "/diffs?": [
          {
            diff: "@@ -0,0 +1 @@\n+page\n",
            new_path: "docs/caf\uFFFD.md",
            old_path: "docs/caf\uFFFD.md",
            a_mode: "0",
            b_mode: "100644",
            new_file: true,
            renamed_file: false,
            deleted_file: false,
            generated_file: false,
          },
        ],
      }),
    argv: (repository) => createArgv(repository, "--change", GITLAB_MR_URL),
  },
  "change-source-mr-forge-page-bound": {
    stage: "resolution",
    forge: async (repository) =>
      remoteGitLab(await absentOpenRequest(repository, "1"), {
        "/diffs?": { stdout: "", stderr: "", exitCode: 1, failure: "output-limit" },
      }),
    argv: (repository) => createArgv(repository, "--change", GITLAB_MR_URL),
  },
  "change-source-release-form-unsupported": {
    stage: "parse",
    argv: (repository) => createArgv(repository, "--change", "release:since-last"),
    detail: "release:since-last",
  },
  "change-source-release-no-units": {
    stage: "resolution",
    // Head is base's parent, so the first-parent walk lists nothing.
    argv: (repository) => createArgv(repository, "--change", "release:HEAD..HEAD~1"),
  },
  "change-source-release-observations-exceeded": {
    stage: "resolution",
    repository: async () => {
      const { repository } = await sourceRepository();
      await fixtureGit(repository, ["tag", "base"]);
      await appendPlainCommits(repository, 127, 2);
      return repository;
    },
    environment: { DOCSFAB_CHANGE_SOURCES_RELEASE_UNITS_PER_RUN_MAX: "127" },
    argv: (repository) =>
      createArgv(
        repository,
        "--source",
        HTML_SOURCE_PATH,
        "--source",
        "docs/guide.md",
        "--change",
        "release:base..HEAD",
      ),
    detail:
      "257 observations: 1 units index, 2 for each of 127 units, and 2 --source files, over the 256 one source binding holds",
  },
  "change-source-release-index-over-read-budget": {
    stage: "resolution",
    // No model is bound, so the read ceiling alone sets the step budget.
    environment: { DOCSFAB_SOURCES_READ_RESPONSE_CEILING_BYTES: "200" },
    argv: (repository) => createArgv(repository, "--change", "release:HEAD~1..HEAD"),
  },
};

describe("every change-source refusal, from do", () => {
  it("places every code exactly once", () => {
    expect(Object.keys(REFUSAL_TABLE).sort()).toEqual([...CHANGE_SOURCE_REFUSAL_CODES].sort());
  });

  // A code missing from the table fails the test above by name, not here.
  const reached = CHANGE_SOURCE_REFUSAL_CODES.flatMap((code) => {
    const row = REFUSAL_TABLE[code] as ReachedRow | { unreachable: string } | undefined;
    return row === undefined || "unreachable" in row ? [] : [[code, row] as const];
  });

  it.each(reached)(
    "%s stops with no request-intent, admission or step call",
    async (code, row) => {
      const repository = await (row.repository ?? plainRepository)();
      const stateDirectory = await emptyState();
      if (row.openRun) await openEditorialRun(stateDirectory, repository);
      const changeRequestCommands = await row.forge?.(repository);
      const prior = Object.keys(row.environment ?? {}).map(
        (name) => [name, process.env[name]] as const,
      );
      for (const [name, value] of Object.entries(row.environment ?? {})) process.env[name] = value;
      let probe: DoProbe;
      try {
        probe = await driveDo(row.argv(repository), {
          stateDirectory,
          execute: row.stage === "resolution",
          currentWorkspaceSnapshotSha256: "c".repeat(64),
          ...(changeRequestCommands ? { changeRequestCommands } : {}),
        });
      } finally {
        for (const [name, value] of prior) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
      }
      expect(changeSourceCode(probe.error), String(probe.error)).toBe(code);
      if (row.detail !== undefined) {
        expect((probe.error as ChangeSourceError).detail).toBe(row.detail);
      }
      expect(probe.intents).toBe(0);
      expect(probe.admissions).toEqual([]);
      expect(probe.steps).toBe(0);
      // Parse, route and continuation stops never reach the run seam.
      expect(probe.runs).toHaveLength(row.stage === "resolution" ? 1 : 0);
      expect(probes.resolve).toBe(row.stage === "resolution" ? 1 : 0);
    },
    testTimeoutMs(60_000),
  );

  it("refuses both comparison options as unknown do options", () => {
    for (const option of ["--comparison-base", "--comparison-workspace"]) {
      expect(() => parseDoArguments([CREATE_SENTENCE, option, "a".repeat(40)])).toThrow(
        `Unknown do option "${option}" is not supported.`,
      );
    }
  });

  it("refuses the other parse forms run refuses, with the same codes", () => {
    const cases: readonly [readonly string[], ChangeSourceRefusalCode][] = [
      [[CREATE_SENTENCE, "--change"], "change-source-option-value-missing"],
      [[CREATE_SENTENCE, "--change="], "change-source-option-value-missing"],
      [[CREATE_SENTENCE, "--chang", "HEAD"], "change-source-option-form-unrecognized"],
      [
        [CREATE_SENTENCE, "--change", "HEAD", "--change", "HEAD"],
        "change-source-selector-repeated",
      ],
      [
        [CREATE_SENTENCE, "--change", "HEAD", "--mr", MERGE_REQUEST_URL],
        "change-source-selector-conflict",
      ],
      [
        [CREATE_SENTENCE, "--continue", "run-1", "--change", "HEAD"],
        "change-source-resume-unsupported",
      ],
      [
        [CREATE_SENTENCE, "--attach", "docs/prd.md", "--change", "HEAD"],
        "change-source-resume-unsupported",
      ],
    ];
    for (const [argv, code] of cases) {
      let caught: unknown;
      try {
        parseDoArguments([...argv]);
      } catch (error) {
        caught = error;
      }
      expect(changeSourceCode(caught), argv.join(" ")).toBe(code);
    }
  });

  it("refuses an option-shaped --instruction value before --change admission, as run does", () => {
    for (const parse of [
      () => parseDoArguments([CREATE_SENTENCE, "--instruction", "--change is new"]),
      () => parseRunArguments(["update-documentation", "--instruction", "--change is new"]),
    ]) {
      expect(parse).toThrow("--instruction requires a value.");
    }
  });

  it("lets benign look-alikes through and keeps their own refusals", () => {
    const benign = parseDoArguments(["document the --change flag", "--repo", "/tmp/change-do"]);
    expect(benign.request).toBe("document the --change flag");
    expect(Object.hasOwn(benign, "changeSource")).toBe(false);
    for (const option of ["--changes", "--changelog"]) {
      expect(() => parseDoArguments([CREATE_SENTENCE, option, "X"])).toThrow(
        `Unknown do option "${option}" is not supported.`,
      );
    }
    expect(() => parseDoArguments([CREATE_SENTENCE, "--changed-path", "a"])).toThrow(
      "The --changed-path option is not supported. Use review-documentation for read-only review.",
    );
    // Positive controls: both spellings parse to the same selector.
    expect(parseDoArguments([CREATE_SENTENCE, "--change", "HEAD"]).changeSource).toEqual(
      parseDoArguments([CREATE_SENTENCE, "--change=HEAD"]).changeSource,
    );
    expect(
      parseDoArguments([CREATE_SENTENCE, "--change", "HEAD~1..HEAD", "--source", "docs/a.md"]),
    ).toMatchObject({
      changeSource: parseChangeSourceSelector("HEAD~1..HEAD"),
      sourcePaths: ["docs/a.md"],
    });
  });

  it("refuses --source first when it and --change meet a route that binds neither", async () => {
    const stateDirectory = await emptyState();
    const probe = await driveDo(
      [REVIEW_SENTENCE, "--repo", "/tmp/change-do", "--source", "docs/a.md", "--change", "HEAD"],
      { stateDirectory },
    );
    expect((probe.error as { code?: string }).code).toBe("source-route-unsupported");
    expect(probe.runs).toEqual([]);
  });

  it(
    "keeps one admission call ahead of resolution for an admission-eligible request",
    async () => {
      const repository = await plainRepository();
      const stateDirectory = await emptyState();
      const probe = await driveDo(
        [
          ADMISSION_SENTENCE,
          "--repo",
          repository,
          "--patch-only",
          "--quiet",
          "--change",
          "no-such-branch..HEAD",
        ],
        { stateDirectory, execute: true, admit: "update-documentation" },
      );
      expect(changeSourceCode(probe.error)).toBe("change-source-revision-unresolved");
      expect(probe.admissions.map((call) => call.request)).toEqual([ADMISSION_SENTENCE]);
      expect(probe.intents).toBe(0);
      expect(probe.steps).toBe(0);
      expect(probe.runs.map((run) => run.workflow)).toEqual(["update-documentation"]);
    },
    testTimeoutMs(60_000),
  );
});

describe("--dry-run and --route-only read no git", () => {
  it(
    "print the route without resolving, and still refuse bad grammar",
    async () => {
      const repository = await plainRepository();
      for (const mode of ["--dry-run", "--route-only"]) {
        probes.git = 0;
        const stateDirectory = await emptyState();
        const probe = await driveDo(
          [UPDATE_SENTENCE, "--repo", repository, mode, "--change", "no-such-branch..HEAD"],
          { stateDirectory, execute: true },
        );
        expect(probe.error, mode).toBeUndefined();
        expect(probe.decision, mode).toMatchObject({
          workflow: "update-documentation",
        });
        expect(probe.runs, mode).toEqual([]);
        expect(probes.resolve, mode).toBe(0);
        expect(probes.git, mode).toBe(0);
        expect(probe.admissions, mode).toEqual([]);
        const refused = await driveDo(
          [UPDATE_SENTENCE, "--repo", repository, mode, "--change", "HEAD^!"],
          { stateDirectory },
        );
        expect(changeSourceCode(refused.error), mode).toBe("change-source-selector-grammar");
      }
      // Positive control: the same argv without the preview flag resolves and reads git.
      const stateDirectory = await emptyState();
      const wet = await driveDo(
        [UPDATE_SENTENCE, "--repo", repository, "--patch-only", "--change", "no-such-branch..HEAD"],
        { stateDirectory, execute: true },
      );
      expect(changeSourceCode(wet.error)).toBe("change-source-revision-unresolved");
      expect(probes.resolve).toBe(1);
      expect(probes.git).toBeGreaterThan(0);
    },
    testTimeoutMs(60_000),
  );
});

describe("delegated do", () => {
  it("refuses --change and names it among the sources it does not accept", () => {
    for (const argv of [
      ["--delegate", CREATE_SENTENCE, "--change", "HEAD"],
      ["--delegate", CREATE_SENTENCE, "--change=HEAD~1..HEAD"],
    ]) {
      let caught: unknown;
      try {
        parseDoArguments(argv);
      } catch (error) {
        caught = error;
      }
      const message = (caught as Error | undefined)?.message ?? "";
      const listed = /^Delegated do does not accept (.+?)\. /u.exec(message)?.[1];
      expect(listed?.split(/, | or /u), argv.join(" ")).toEqual(["--source", "--pr", "--change"]);
    }
    // Control: the same argv without --delegate parses the change.
    expect(parseDoArguments([CREATE_SENTENCE, "--change", "HEAD"]).changeSource).toEqual(
      parseChangeSourceSelector("HEAD"),
    );
  });
});

describe("continuation does not take --change", () => {
  it("refuses an implicit reply with --change and continues the same reply without it", async () => {
    const repository = await roots.create("docsfab-change-do-repo-");
    const reply = "The product requirements are in docs/prd.md.";
    const refusedState = await emptyState();
    await openEditorialRun(refusedState, repository);
    const refused = await driveDo([reply, "--repo", repository, "--change", "HEAD"], {
      stateDirectory: refusedState,
      currentWorkspaceSnapshotSha256: "c".repeat(64),
    });
    expect(changeSourceCode(refused.error)).toBe("change-source-resume-unsupported");
    expect(refused.runs).toEqual([]);
    expect(refused.admissions).toEqual([]);
    // Nothing was claimed: the stopped run is still the one open record.
    expect(await readdir(refusedState)).toEqual(["change-do-open-run.json"]);

    const continuedState = await emptyState();
    await openEditorialRun(continuedState, repository);
    const continued = await driveDo([reply, "--repo", repository], {
      stateDirectory: continuedState,
      currentWorkspaceSnapshotSha256: "c".repeat(64),
    });
    expect(continued.error).toBeUndefined();
    expect(continued.runs).toHaveLength(1);
    expect(continued.runs[0]!.operatorInputResume?.originalRunId).toBe("change-do-open-run");
  });

  it("starts a fresh run with --change when the open run belongs to another repository", async () => {
    const repository = await roots.create("docsfab-change-do-repo-");
    const other = await roots.create("docsfab-change-do-other-");
    const stateDirectory = await emptyState();
    await openEditorialRun(stateDirectory, other);
    const probe = await driveDo(
      [UPDATE_SENTENCE, "--repo", repository, "--patch-only", "--change", "HEAD"],
      { stateDirectory },
    );
    expect(probe.error).toBeUndefined();
    expect(probe.runs).toHaveLength(1);
    expect(probe.runs[0]!.changeSource).toEqual(parseChangeSourceSelector("HEAD"));
    expect(Object.hasOwn(probe.runs[0]!, "operatorInputResume")).toBe(false);
  });

  it("refuses --continue and --attach with --change before any continuation", async () => {
    const repository = await roots.create("docsfab-change-do-repo-");
    for (const flag of [
      ["--continue", "change-do-open-run"],
      ["--attach", "docs/prd.md"],
    ]) {
      const stateDirectory = await emptyState();
      await openEditorialRun(stateDirectory, repository);
      const probe = await driveDo(
        ["The product requirements.", "--repo", repository, ...flag, "--change", "HEAD"],
        { stateDirectory, currentWorkspaceSnapshotSha256: "c".repeat(64) },
      );
      expect(changeSourceCode(probe.error), flag[0]).toBe("change-source-resume-unsupported");
      expect(probe.runs, flag[0]).toEqual([]);
    }
  });
});
