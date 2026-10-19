// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `docsfab run --mr` and `docsfab run --change <merge request>` end to end
 * through `executeRunRequest`: the merge request is pinned and its diff read
 * from the checkout before any model call, then bound beside its text when it
 * is merged. Only the model turn and the `glab` command are substituted.
 */
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { sourceReadBudgetForModel } from "../src/cli/run/source-acquisition.js";
import { executeRunRequest } from "../src/cli/run-request.js";
import { parseRunArguments } from "../src/cli/run-arguments.js";
import type { CommandRunner } from "../src/init/types.js";
import { ChangeSourceError } from "../src/inputs/change-source.js";
import {
  CHANGE_SOURCE_DIFF_MEDIA_TYPE,
  changeSourceRepositoryPath,
} from "../src/inputs/change-source/acquisition.js";
import { gitlabMrSourceRepositoryPath } from "../src/inputs/source-acquisition-gitlab.js";
import type { RequestIntentInterpreterPort } from "../src/request-intent/interpret.js";
import { runtimeConfig } from "./support/execution-convergence.js";
import {
  createSourceFixture,
  HTML_SOURCE_PATH,
  runRequest,
  skillResolver,
  SourceToolHarness,
} from "./support/source-acquisition-cli.js";
import { commitFiles, fixtureGit } from "./support/change-source-fixture.js";
import { commitGet, diffItems, ENDPOINTS, RecordedGitLab } from "./support/gitlab-forge-fixture.js";
import { temporaryRoots } from "./helpers/temp.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";

const HOST = "gitlab.example.test";
const PROJECT_PATH = "team/docs-project";
const PROJECT_ID = 4242;
const IID = 813;
const MR_URL = `https://${HOST}/${PROJECT_PATH}/-/merge_requests/${IID}`;
const MR_BODY = "The export command now requires an explicit output path.";

const roots = temporaryRoots();

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

const RECORDED = readFileSync(
  join(import.meta.dirname, "fixtures", "change-source-gitlab", "merge-request-get.json"),
  "utf8",
);

function recordedMergeRequest(
  ids: Readonly<Record<"base" | "start" | "head" | "merge", string | null>>,
  fields: Record<string, unknown> = {},
): Record<string, unknown> {
  const filled = JSON.parse(RECORDED, (_key, value: unknown) =>
    typeof value === "string" && value.startsWith("@")
      ? ids[value.slice(1) as keyof typeof ids]
      : value,
  ) as Record<string, unknown>;
  return { ...filled, ...fields };
}

/**
 * A `glab` stand-in: the project read answers the project's identity, each
 * merge request read answers the next body from `answers` (the last repeats),
 * and every read of GitLab's own diff fails as an expired login does, so a
 * checkout without the objects keeps the local refusal.
 */
function forge(answers: readonly Record<string, unknown>[]) {
  const calls: string[][] = [];
  let reads = 0;
  const commands: CommandRunner = {
    async run(_command, args) {
      calls.push([...args]);
      const endpoint = String(args.at(-1));
      if (/\/repository\/|\/diffs\?/u.test(endpoint)) {
        return { stdout: "", stderr: "glab: 401 Unauthorized", exitCode: 1 };
      }
      const body = endpoint.includes("/merge_requests/")
        ? answers[Math.min(reads++, answers.length - 1)]
        : { id: PROJECT_ID, path_with_namespace: PROJECT_PATH };
      return { stdout: JSON.stringify(body), stderr: "", exitCode: 0 };
    },
  };
  return { calls, commands };
}

/** The source fixture plus a two-commit feature merged into its branch with a merge commit. */
async function mergeRequestFixture() {
  const fixture = await createSourceFixture();
  roots.track(fixture.root);
  const branch = await fixtureGit(fixture.repository, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const base = await fixtureGit(fixture.repository, ["rev-parse", "HEAD"]);
  await fixtureGit(fixture.repository, ["checkout", "-q", "-b", "feature/export-path"]);
  const first = await commitFiles(
    fixture.repository,
    { "src/export-notes.md": "The export command writes to the current directory.\n" },
    "Seed export notes",
  );
  const head = await commitFiles(
    fixture.repository,
    { "src/export.ts": "export const requiresOutputPath = true;\n" },
    "Require an explicit export path",
  );
  await fixtureGit(fixture.repository, ["checkout", "-q", branch]);
  await fixtureGit(fixture.repository, [
    "merge",
    "-q",
    "--no-ff",
    "-m",
    "Merge branch 'feature/export-path'",
    "feature/export-path",
  ]);
  const merge = await fixtureGit(fixture.repository, ["rev-parse", "HEAD"]);
  // The same feature landed as one squash commit, on a branch of its own.
  await fixtureGit(fixture.repository, ["checkout", "-q", "-b", "squashed", base]);
  await fixtureGit(fixture.repository, ["merge", "-q", "--squash", "feature/export-path"]);
  await fixtureGit(fixture.repository, ["commit", "-q", "-m", "Require an explicit export path"]);
  const squash = await fixtureGit(fixture.repository, ["rev-parse", "HEAD"]);
  await fixtureGit(fixture.repository, ["checkout", "-q", branch]);
  return { fixture, base, first, head, merge, squash };
}

/**
 * Run with the operator's status output on, and return each line written to
 * stderr, unindented; stdout and the console are muted.
 */
async function runCapturingStatus(
  request: ReturnType<typeof argvRequest>,
  fixture: { stateDirectory: string },
  commands: CommandRunner,
): Promise<{ status: string | undefined; lines: string[] }> {
  const written: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    written.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation((message?: unknown) => {
    written.push(`${String(message ?? "")}\n`);
  });
  const record = await executeRunRequest(request, runtimeConfig(fixture.stateDirectory), {
    silent: false,
    quiet: false,
    executionHarness: new SourceToolHarness({
      readOnSkill: "plan-documentation",
      planSourcePaths: [HTML_SOURCE_PATH],
    }),
    skillResolver,
    changeRequestCommands: commands,
    changeRequestEnvironment: {},
  });
  vi.restoreAllMocks();
  return {
    status: record?.status,
    lines: written
      .join("")
      .split("\n")
      .map((line) => line.trim()),
  };
}

/** The request `docsfab run` builds from argv, on the fixture's checkout. */
function argvRequest(fixture: { repository: string }, ...selection: string[]) {
  const parsed = parseRunArguments([
    "create-documentation",
    "--repo",
    fixture.repository,
    "--instruction",
    runRequest(fixture).instruction,
    ...selection,
  ]);
  return {
    ...runRequest(fixture),
    ...(parsed.changeRequestSelector
      ? { changeRequestSelector: parsed.changeRequestSelector }
      : {}),
    ...(parsed.changeSource ? { changeSource: parsed.changeSource } : {}),
  };
}

/** The shipped scripted model, pointed at the diff so its citation names the diff. */
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

function countingInterpreter(): { port: RequestIntentInterpreterPort; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    port: {
      async call() {
        calls += 1;
        throw new Error("request-intent model call reached in a pre-model refusal test");
      },
    },
  };
}

describe("docsfab run --mr binds a merged merge request's diff beside its text", () => {
  it(
    "binds the text, the diff and the manifest, cites the diff, and reads only by GET",
    async () => {
      const { fixture, base, head, merge } = await mergeRequestFixture();
      const stub = forge([recordedMergeRequest({ base, start: base, head, merge })]);
      const model = new DiffCitingHarness({
        readOnSkill: "plan-documentation",
        planSourcePaths: [HTML_SOURCE_PATH],
        readWindowMaxBytes: sourceReadBudgetForModel(undefined).budgetBytes,
      });
      const record = await executeRunRequest(
        argvRequest(fixture, "--mr", MR_URL),
        runtimeConfig(fixture.stateDirectory),
        {
          silent: true,
          executionHarness: model,
          skillResolver,
          changeRequestCommands: stub.commands,
          changeRequestEnvironment: {},
        },
      );

      expect(record?.status).toBe("succeeded");
      const diffPath = changeSourceRepositoryPath(merge, "diff");
      const manifestPath = changeSourceRepositoryPath(merge, "manifest");
      const textPath = gitlabMrSourceRepositoryPath(IID);
      expect([...model.listedPaths].sort()).toEqual([diffPath, manifestPath, textPath].sort());
      expect(model.toolReads.join("\n")).toContain(MR_BODY);
      const producers = new Map(
        model.listed.map((entry) => [entry.repositoryPath, entry.observationId]),
      );
      const citations = record!.sourceCitations!.steps.flatMap((step) => step.citations);
      expect(citations.map((citation) => citation.observationId)).toEqual([
        producers.get(diffPath),
      ]);
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
      // The diff read first, then the text's project identity and merge request reads.
      expect(stub.calls).toHaveLength(3);
      for (const args of stub.calls) {
        expect(args.slice(0, 5)).toEqual(["api", "--hostname", HOST, "--method", "GET"]);
      }
    },
    testTimeoutMs(60_000),
  );

  it(
    "refuses text whose merge commit is not the one the diff was pinned at",
    async () => {
      const { fixture, base, first, head, merge } = await mergeRequestFixture();
      const stub = forge([
        recordedMergeRequest({ base, start: base, head, merge }),
        recordedMergeRequest({ base, start: base, head, merge: first }),
      ]);
      const error = await executeRunRequest(
        argvRequest(fixture, "--mr", MR_URL),
        runtimeConfig(fixture.stateDirectory),
        {
          silent: true,
          executionHarness: new SourceToolHarness({ readOnSkill: null, planSourcePaths: [] }),
          skillResolver,
          changeRequestCommands: stub.commands,
          changeRequestEnvironment: {},
        },
      ).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ChangeSourceError);
      expect((error as ChangeSourceError).code).toBe("change-source-mr-moved");
    },
    testTimeoutMs(60_000),
  );
});

describe("docsfab run --mr checks a squash-merged request's text against its pinned squash commit", () => {
  it(
    "refuses text naming another squash commit, and binds text naming the pinned one",
    async () => {
      const { fixture, base, first, head, squash } = await mergeRequestFixture();
      const pinned = recordedMergeRequest(
        { base, start: base, head, merge: null },
        { squash_commit_sha: squash },
      );
      const cases = [
        {
          text: recordedMergeRequest(
            { base, start: base, head, merge: null },
            { squash_commit_sha: first },
          ),
          code: "change-source-mr-moved",
        },
        // Adjacent: the same squash commit in the text binds.
        { text: pinned, code: undefined },
      ] as const;
      for (const { text, code } of cases) {
        const stub = forge([pinned, text]);
        const outcome = await executeRunRequest(
          argvRequest(fixture, "--mr", MR_URL),
          runtimeConfig(fixture.stateDirectory),
          {
            silent: true,
            executionHarness: new SourceToolHarness({
              readOnSkill: "plan-documentation",
              planSourcePaths: [HTML_SOURCE_PATH],
            }),
            skillResolver,
            changeRequestCommands: stub.commands,
            changeRequestEnvironment: {},
          },
        ).catch((caught: unknown) => caught);
        if (code === undefined) {
          expect((outcome as { status?: string } | undefined)?.status).toBe("succeeded");
        } else {
          expect(outcome).toBeInstanceOf(ChangeSourceError);
          expect((outcome as ChangeSourceError).code).toBe(code);
        }
        // The pin read, then the text's project identity and merge request reads.
        expect(stub.calls).toHaveLength(3);
      }
    },
    testTimeoutMs(120_000),
  );
});

describe("docsfab run tells the operator why an open merge request's text was not bound", () => {
  it(
    "writes the open-request status line through the shipped run, and not for a merged request",
    async () => {
      const { fixture, base, head, merge } = await mergeRequestFixture();
      const notice = `change source: merge request !${IID} is open; its description was not bound, because an open merge request's text can still change`;
      const open = await runCapturingStatus(
        argvRequest(fixture, "--mr", MR_URL),
        fixture,
        forge([
          recordedMergeRequest(
            { base, start: base, head, merge: null },
            { state: "opened", merged_at: null },
          ),
        ]).commands,
      );
      expect(open.status).toBe("succeeded");
      const openPresentation = open.lines.join(" ").replace(/\s+/gu, " ");
      expect(openPresentation.split(notice)).toHaveLength(2);
      expect(open.lines).toContain("change source label: merge-request-unmerged");
      // Adjacent: a merged request binds its text, so the line is absent.
      const merged = await runCapturingStatus(
        argvRequest(fixture, "--mr", MR_URL),
        fixture,
        forge([recordedMergeRequest({ base, start: base, head, merge })]).commands,
      );
      expect(merged.status).toBe("succeeded");
      // The capture is live: the merged run's own range summary is there.
      expect(merged.lines.some((line) => line.startsWith("change source: "))).toBe(true);
      expect(merged.lines.join(" ").replace(/\s+/gu, " ")).not.toContain(notice);
    },
    testTimeoutMs(120_000),
  );
});

describe("an open merge request binds its diff alone, under --mr and --change alike", () => {
  it(
    "binds the diff and manifest with no text observation for either option",
    async () => {
      const { fixture, base, head } = await mergeRequestFixture();
      const open = recordedMergeRequest(
        { base, start: base, head, merge: null },
        { state: "opened", merged_at: null },
      );
      const listed: string[][] = [];
      for (const selection of [
        ["--mr", MR_URL],
        ["--change", MR_URL],
      ]) {
        const stub = forge([open]);
        const model = new SourceToolHarness({
          readOnSkill: "plan-documentation",
          planSourcePaths: [HTML_SOURCE_PATH],
        });
        const record = await executeRunRequest(
          argvRequest(fixture, ...selection),
          runtimeConfig(fixture.stateDirectory),
          {
            silent: true,
            executionHarness: model,
            skillResolver,
            changeRequestCommands: stub.commands,
            changeRequestEnvironment: {},
          },
        );
        expect(record?.status, selection[0]).toBe("succeeded");
        expect(model.toolReads.join("\n"), selection[0]).not.toContain(MR_BODY);
        // One read: the pinned merge request; no project or text read follows.
        expect(stub.calls, selection[0]).toHaveLength(1);
        listed.push([...model.listedPaths].sort());
      }
      expect(listed[0]).toEqual(
        [
          changeSourceRepositoryPath(head, "diff"),
          changeSourceRepositoryPath(head, "manifest"),
        ].sort(),
      );
      expect(listed[1]).toEqual(listed[0]);
    },
    testTimeoutMs(120_000),
  );
});

describe("docsfab run refuses a merge request before any model call", () => {
  it(
    "refuses a closed merge request and one whose commits are not local, with no request-intent or step call",
    async () => {
      const { fixture, base, head } = await mergeRequestFixture();
      const cases = [
        {
          answer: recordedMergeRequest(
            { base, start: base, head, merge: null },
            { state: "closed", merged_at: null },
          ),
          code: "change-source-mr-closed-unmerged",
        },
        {
          answer: recordedMergeRequest({ base, start: base, head, merge: "e".repeat(40) }),
          code: "change-source-mr-objects-unavailable",
        },
      ] as const;
      for (const { answer, code } of cases) {
        for (const option of ["--mr", "--change"]) {
          const stub = forge([answer]);
          const model = new SourceToolHarness({ readOnSkill: null, planSourcePaths: [] });
          const interpreter = countingInterpreter();
          const error = await executeRunRequest(
            argvRequest(fixture, option, MR_URL),
            runtimeConfig(fixture.stateDirectory),
            {
              silent: true,
              executionHarness: model,
              skillResolver,
              requestInterpreter: interpreter.port,
              changeRequestCommands: stub.commands,
              changeRequestEnvironment: {},
            },
          ).catch((caught: unknown) => caught);
          expect((error as ChangeSourceError).code, `${option} ${code}`).toBe(code);
          expect(interpreter.calls()).toBe(0);
          expect(model.calls).toEqual([]);
        }
      }
    },
    testTimeoutMs(120_000),
  );
});

/**
 * GitLab's side of a merge request this checkout never fetched: a clone of
 * the checkout where the feature's two commits and their squash commit live.
 */
async function remoteOnlyFixture() {
  const fixture = await createSourceFixture();
  roots.track(fixture.root);
  const base = await fixtureGit(fixture.repository, ["rev-parse", "HEAD"]);
  const remote = join(await roots.create("docsfab-gitlab-forge-remote-"), "remote");
  await fixtureGit(fixture.repository, ["clone", "-q", `file://${fixture.repository}`, remote]);
  await fixtureGit(remote, ["checkout", "-q", "-b", "feature/export-path"]);
  await commitFiles(
    remote,
    { "src/export-notes.md": "The export command writes to the current directory.\n" },
    "Seed export notes",
  );
  const head = await commitFiles(
    remote,
    { "src/export.ts": "export const requiresOutputPath = true;\n" },
    "Require an explicit export path",
  );
  await fixtureGit(remote, ["checkout", "-q", "-b", "squashed", base]);
  await fixtureGit(remote, ["merge", "-q", "--squash", "feature/export-path"]);
  await fixtureGit(remote, ["commit", "-q", "-m", "Require an explicit export path"]);
  const squash = await fixtureGit(remote, ["rev-parse", "HEAD"]);
  return { fixture, remote, base, head, squash };
}

/** The recorded GitLab for it; any other read answers the project's identity, as `!N` needs. */
async function remoteOnlyGitLab(
  remote: string,
  pin: Record<string, unknown>,
  squash: string,
  base: string,
): Promise<RecordedGitLab> {
  return new RecordedGitLab((endpoint) =>
    endpoint.includes("/merge_requests/") || endpoint.includes("/repository/")
      ? undefined
      : { id: PROJECT_ID, path_with_namespace: PROJECT_PATH },
  )
    .on(ENDPOINTS.pin, pin)
    .on(ENDPOINTS.reread, pin)
    .on(ENDPOINTS.commit(squash), await commitGet(remote, squash))
    .paged(
      (page) => ENDPOINTS.commitDiff(squash, page),
      await diffItems(remote, base, squash, null),
    );
}

describe("docsfab run --mr reads a merge request this checkout never fetched from GitLab", () => {
  it(
    "persists one forge-reported change in the run record, cited beside the merge request's text",
    async () => {
      const { fixture, remote, base, head, squash } = await remoteOnlyFixture();
      // The checkout holds none of the merge request's commits.
      await expect(
        fixtureGit(fixture.repository, ["cat-file", "-e", `${squash}^{commit}`]),
      ).rejects.toThrow();
      const pin = recordedMergeRequest(
        { base, start: base, head, merge: null },
        { squash_commit_sha: squash, squash: true },
      );
      const gitlab = await remoteOnlyGitLab(remote, pin, squash, base);
      const model = new DiffCitingHarness({
        readOnSkill: "plan-documentation",
        planSourcePaths: [HTML_SOURCE_PATH],
        readWindowMaxBytes: sourceReadBudgetForModel(undefined).budgetBytes,
      });
      const record = await executeRunRequest(
        argvRequest(fixture, "--mr", MR_URL),
        runtimeConfig(fixture.stateDirectory),
        {
          silent: true,
          executionHarness: model,
          skillResolver,
          changeRequestCommands: gitlab.commands,
          changeRequestEnvironment: {},
        },
      );
      expect(record?.status).toBe("succeeded");
      // Read from the record file the run store wrote, not the returned record.
      const saved = JSON.parse(
        await readFile(join(fixture.stateDirectory, `${record!.id}.json`), "utf8"),
      ) as { changeSources?: Array<Record<string, unknown>> };
      expect(saved.changeSources).toHaveLength(1);
      const diffPath = changeSourceRepositoryPath(squash, "diff");
      const manifestPath = changeSourceRepositoryPath(squash, "manifest");
      const observation = (path: string) =>
        model.listed.find((entry) => entry.repositoryPath === path)!.observationId;
      expect(saved.changeSources![0]).toMatchObject({
        sourceKind: "gitlab-merge-request",
        provenance: "forge-reported",
        rangeSemantics: "first-parent-commit",
        base,
        head: squash,
        commitCount: 1,
        fileCount: 2,
        observations: [
          { role: "diff", observationId: observation(diffPath) },
          { role: "manifest", observationId: observation(manifestPath) },
        ],
      });
      // The squashed request's text binds beside its forge diff, and the step cites the diff.
      expect([...model.listedPaths].sort()).toEqual(
        [diffPath, manifestPath, gitlabMrSourceRepositoryPath(IID)].sort(),
      );
      const citations = record!.sourceCitations!.steps.flatMap((step) => step.citations);
      expect(citations.map((citation) => citation.observationId)).toEqual([observation(diffPath)]);
      expect(gitlab.endpoints().slice(0, 4)).toEqual([
        ENDPOINTS.pin,
        ENDPOINTS.commit(squash),
        ENDPOINTS.commitDiff(squash, 1),
        ENDPOINTS.reread,
      ]);
    },
    testTimeoutMs(120_000),
  );

  it(
    "refuses an incomplete GitLab answer before any model call",
    async () => {
      const { fixture, remote, base, head, squash } = await remoteOnlyFixture();
      const pin = recordedMergeRequest(
        { base, start: base, head, merge: null },
        { squash_commit_sha: squash, squash: true },
      );
      // GitLab's diff lost a file its commit counts lines for.
      const gitlab = (await remoteOnlyGitLab(remote, pin, squash, base)).paged(
        (page) => ENDPOINTS.commitDiff(squash, page),
        (await diffItems(remote, base, squash, null)).slice(1),
      );
      const model = new SourceToolHarness({ readOnSkill: null, planSourcePaths: [] });
      const interpreter = countingInterpreter();
      const error = await executeRunRequest(
        argvRequest(fixture, "--mr", MR_URL),
        runtimeConfig(fixture.stateDirectory),
        {
          silent: true,
          executionHarness: model,
          skillResolver,
          requestInterpreter: interpreter.port,
          changeRequestCommands: gitlab.commands,
          changeRequestEnvironment: {},
        },
      ).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ChangeSourceError);
      expect((error as ChangeSourceError).code).toBe("change-source-mr-forge-incomplete");
      expect(interpreter.calls()).toBe(0);
      expect(model.calls).toEqual([]);
    },
    testTimeoutMs(120_000),
  );
});
