// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `docsfab run --pr` / `--mr` with a github.com pull request URL (row 9),
 * `run --change <github compare URL>` from argv (row 2's positive control),
 * the persisted citation of both (row R), and the token-free transport with
 * GitHub token variables set (row 8b). Every run starts from parsed argv, so
 * the run-only `--pr` block is the code under test, not a hand-built request.
 * The global `fetch` is the fixture forge; only the model turn is substituted.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { parseDoArguments } from "../src/cli/commands/do-parse.js";
import { parseLiveAgentArguments } from "../src/cli/commands/live-agent.js";
import { handleSourcesCommand } from "../src/cli/commands/sources.js";
import { executeRunRequest } from "../src/cli/run-request.js";
import {
  parseRunArguments,
  SOURCE_AWARE_WORKFLOWS,
  unsupportedSourceWorkflowRefusal,
} from "../src/cli/run-arguments.js";
import type { CommandRunner } from "../src/init/types.js";
import {
  ChangeRequestSelectorError,
  parseChangeRequestSelector,
} from "../src/inputs/change-request-selector.js";
import { ChangeSourceError } from "../src/inputs/change-source.js";
import { changeSourceRepositoryPath } from "../src/inputs/change-source/acquisition.js";
import { MERGED_MR_UPDATE_REPRODUCTION_INSTRUCTION } from "../src/inputs/merged-mr-instruction.js";
import type { RequestIntentInterpreterPort } from "../src/request-intent/interpret.js";
import { runtimeConfig } from "./support/execution-convergence.js";
import {
  createSourceFixture,
  HTML_SOURCE_PATH,
  skillResolver,
  SourceToolHarness,
} from "./support/source-acquisition-cli.js";
import { fixtureGit } from "./support/change-source-fixture.js";
import {
  buildChangeRepository,
  FakeGithub,
  NAME,
  OWNER,
  REPOSITORY_ID,
} from "./support/github-change-source-fixture.js";
import { temporaryRoots } from "./helpers/temp.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";

const roots = temporaryRoots();
const REPO = "/tmp/docsfab-github-pr-cli";
const INSTRUCTION = "Update docs/whats-new.md for the change.";
const PULL = `https://github.com/${OWNER}/${NAME}/pull/7`;
const GITLAB = "https://gitlab.example.test/g/p/-/merge_requests/7";
const SHA = "0123456789abcdef0123456789abcdef01234567";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  process.exitCode = undefined;
});

function update(...extra: readonly string[]): string[] {
  return ["update-documentation", "--repo", REPO, "--instruction", INSTRUCTION, ...extra];
}

const pullSelector = {
  schemaVersion: 1,
  kind: "docsfab-change-source-selector",
  source: "github-pull-request",
  host: "github.com",
  owner: OWNER,
  repository: NAME,
  number: 7,
};

/** The thrown error of a synchronous call; a call that returns fails the test. */
function thrown(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    if (error instanceof Error) return error;
  }
  throw new Error("expected the call to throw an Error");
}

describe("run --pr / --mr with a github.com pull request URL (row 9, D3)", () => {
  it("makes the pull request the run's change source in every spelling and form", () => {
    for (const argv of [
      ["--pr", PULL],
      [`--pr=${PULL}`],
      ["--mr", PULL],
      [`--mr=${PULL}`],
      ["--pr", `${PULL}/files`],
      ["--pr", `https://www.github.com/${OWNER}/${NAME}/pull/7`],
    ]) {
      const parsed = parseRunArguments(update(...argv));
      expect(parsed.changeSource, argv.join(" ")).toEqual(pullSelector);
      expect(parsed.changeRequestSelector, argv.join(" ")).toBeUndefined();
    }
    // --source still composes with it.
    const withSource = parseRunArguments(update("--pr", PULL, "--source", "docs/a.html"));
    expect(withSource.sourcePaths).toEqual(["docs/a.html"]);
    expect(withSource.changeSource).toEqual(pullSelector);
  });

  it("counts every --pr and --mr value before taking one out", () => {
    for (const argv of [
      ["--pr", PULL, "--mr", GITLAB],
      ["--mr", GITLAB, "--pr", PULL],
      ["--pr", PULL, "--pr", PULL],
    ]) {
      expect(thrown(() => parseRunArguments(update(...argv))).message, argv.join(" ")).toMatch(
        /^Pass --pr or --mr at most once in total;/u,
      );
    }
  });

  it("keeps the workflow and resume gates for the GitHub value, with the GitLab texts", () => {
    const workflow = thrown(() => parseRunArguments(["review-documentation", "--pr", PULL]));
    expect(workflow.message).toBe(unsupportedSourceWorkflowRefusal(SOURCE_AWARE_WORKFLOWS, "--pr"));
    const resume = (value: string) =>
      thrown(() =>
        parseRunArguments([
          "update-documentation",
          "--repo",
          REPO,
          "--resume-from",
          "run-1",
          "--canon-snapshot",
          "{}",
          "--pr",
          value,
        ]),
      ).message;
    expect(resume(PULL)).toBe(resume("!1"));
    expect(resume(PULL)).toMatch(/^--pr or --mr cannot be combined with --resume-from;/u);
  });

  it("refuses --change beside it and a date-window instruction", () => {
    const code = (argv: string[]) => {
      const error = thrown(() => parseRunArguments(argv));
      expect(error, argv.join(" ")).toBeInstanceOf(ChangeSourceError);
      return (error as ChangeSourceError).code;
    };
    expect(code(update("--change", "HEAD", "--pr", PULL))).toBe("change-source-selector-conflict");
    expect(code(update(`--pr=${PULL}`, "--change", `${PULL}/files`))).toBe(
      "change-source-selector-conflict",
    );
    expect(
      code([
        "update-documentation",
        "--repo",
        REPO,
        "--instruction",
        MERGED_MR_UPDATE_REPRODUCTION_INSTRUCTION,
        "--pr",
        PULL,
      ]),
    ).toBe("change-source-date-window-conflict");
  });

  it("binds it beside --comparison-base or --comparison-workspace, as --change binds it", () => {
    const base = "a".repeat(40);
    const revision = "b".repeat(40);
    for (const [comparison, request] of [
      [
        ["--comparison-base", base, "--revision", revision],
        { kind: "base-head", baseRevision: base, headRevision: revision },
      ],
      [["--comparison-workspace"], { kind: "workspace" }],
    ] as const) {
      for (const option of ["--pr", "--mr", "--change"]) {
        const label = `${option} ${comparison[0]}`;
        const parsed = parseRunArguments(update(option, PULL, ...comparison));
        expect(parsed.changeSource, label).toEqual(pullSelector);
        expect(parsed.changeRequestSelector, label).toBeUndefined();
        expect(parsed.comparisonRequest, label).toEqual(request);
      }
      // Adjacent: a commit URL under --pr still refuses beside the comparison, by its own code.
      const commit = thrown(() =>
        parseRunArguments(
          update("--pr", `https://github.com/${OWNER}/${NAME}/commit/${SHA}`, ...comparison),
        ),
      );
      expect(commit, comparison[0]).toBeInstanceOf(ChangeSourceError);
      expect((commit as ChangeSourceError).code, comparison[0]).toBe(
        "change-source-github-pr-not-pull-request",
      );
    }
  });

  it("refuses a GitHub commit or compare URL under --pr toward --change, and other github.com paths by grammar", () => {
    const refusal = (argv: string[]) => {
      const error = thrown(() => parseRunArguments(update(...argv))) as ChangeSourceError;
      return [error.code, error.detail];
    };
    for (const argv of [
      ["--pr", `https://github.com/${OWNER}/${NAME}/commit/${SHA}`],
      ["--mr", `https://github.com/${OWNER}/${NAME}/compare/main...feature`],
    ]) {
      expect(refusal(argv), argv.join(" ")).toEqual([
        "change-source-github-pr-not-pull-request",
        undefined,
      ]);
    }
    expect(refusal(["--pr", `https://github.com/${OWNER}/${NAME}/issues/7`])).toEqual([
      "change-source-github-url-grammar",
      "path",
    ]);
    expect(refusal(["--pr", `${PULL}?w=1`])).toEqual([
      "change-source-github-url-grammar",
      "query string",
    ]);
  });

  it("leaves every value not on https github.com to the shared admission, byte for byte", () => {
    for (const value of [
      "github.com/o/r/pull/7",
      "https://gitea.example/o/r/pull/3",
      "http://github.com/o/r/pull/7",
      "https://github.example.test/o/r/pull/7",
    ]) {
      const expected = thrown(() => parseChangeRequestSelector(value));
      const actual = thrown(() => parseRunArguments(update("--pr", value)));
      expect(actual, value).toBeInstanceOf(ChangeRequestSelectorError);
      expect([(actual as ChangeRequestSelectorError).code, actual.message], value).toEqual([
        (expected as ChangeRequestSelectorError).code,
        expected.message,
      ]);
    }
    const gitlab = parseRunArguments(update("--pr", GITLAB));
    expect(gitlab.changeRequestSelector).toEqual(parseChangeRequestSelector(GITLAB));
    expect(gitlab.changeSource).toMatchObject({ source: "gitlab-merge-request" });
  });

  it("admits GitHub --pr for live-agent while do and sources still refuse it", async () => {
    const expected = thrown(() => parseChangeRequestSelector(PULL)) as ChangeRequestSelectorError;
    expect(expected.code).toBe("unsupported-provider");
    for (const parse of [() => parseDoArguments(["update the guide", "--pr", PULL])]) {
      const error = thrown(parse);
      expect(error).toBeInstanceOf(ChangeRequestSelectorError);
      expect([(error as ChangeRequestSelectorError).code, error.message]).toEqual([
        expected.code,
        expected.message,
      ]);
    }
    for (const argv of [["--pr", PULL], [`--pr=${PULL}`], ["--mr", PULL], [`--mr=${PULL}`]]) {
      const parsed = parseLiveAgentArguments(argv);
      expect(parsed.changeSource, argv.join(" ")).toMatchObject({
        source: "github-pull-request",
        number: 7,
      });
      expect(parsed.changeRequestSelector, argv.join(" ")).toBeUndefined();
    }
    for (const argv of [
      ["--pr", GITLAB],
      [`--pr=${GITLAB}`],
      ["--mr", GITLAB],
      [`--mr=${GITLAB}`],
    ]) {
      const parsed = parseLiveAgentArguments(argv);
      expect(parsed.changeRequestSelector, argv.join(" ")).toEqual(
        parseChangeRequestSelector(GITLAB),
      );
      expect(parsed.changeSource, argv.join(" ")).toBeUndefined();
    }
    const errors: string[] = [];
    const result = await handleSourcesCommand(["--pr", PULL], {
      write: () => undefined,
      writeError: (text) => errors.push(text),
      cwd: "/tmp",
    });
    expect(result.refused).toBe(true);
    expect(errors.join("")).toContain(expected.message);
  });
});

describe("docsfab do --change with a GitHub compare URL", () => {
  it("parses into the same compare selector run reads", () => {
    const url = `https://github.com/${OWNER}/${NAME}/compare/main...feature/export-path`;
    const parsed = parseDoArguments(["update the export guide", "--change", url]);
    expect(parsed.changeSource).toEqual(parseRunArguments(update("--change", url)).changeSource);
    expect(parsed.changeSource).toMatchObject({ source: "github-compare", form: "three-dot" });
  });
});

/** The docs workspace as the alpha tasks build it: shallow, detached, remote-less. */
async function shallowWorkspace() {
  const fixture = await createSourceFixture();
  roots.track(fixture.root);
  const repository = join(fixture.root, "shallow-checkout");
  await fixtureGit(fixture.root, ["init", "-q", repository]);
  await fixtureGit(repository, [
    "fetch",
    "-q",
    "--depth",
    "1",
    `file://${fixture.repository}`,
    "HEAD",
  ]);
  await fixtureGit(repository, ["checkout", "-q", "FETCH_HEAD"]);
  return { ...fixture, repository };
}

/** A command runner that records calls; the GitHub kinds must never use it. */
function spyRunner(): CommandRunner & { readonly calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    async run(command, args) {
      calls.push([command, ...args]);
      throw new Error("a GitHub change source ran a forge command");
    },
  };
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

async function persisted(stateDirectory: string, id: string | undefined) {
  expect(id).toBeDefined();
  const text = await readFile(join(stateDirectory, `${id}.json`), "utf8");
  return { text, record: JSON.parse(text) as Record<string, unknown> };
}

describe("run from argv binds the GitHub change and persists its citation (rows 9, R, 8b)", () => {
  it(
    "binds run --pr <github pull URL> with GitHub token variables set, sending no credential and running no command",
    async () => {
      const fixture = await shallowWorkspace();
      const change = await buildChangeRepository(await roots.create("docsfab-gh-pr-"));
      await fixtureGit(change.repository, [
        "merge",
        "-q",
        "--no-ff",
        "-m",
        "Merge #7",
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
      });
      vi.stubGlobal("fetch", fake.fetch);
      // Token-shaped values built at run time, so no source line carries one.
      const token = ["gh", "p_", "Zq".repeat(18)].join("");
      vi.stubEnv("GH_TOKEN", token);
      vi.stubEnv("GITHUB_TOKEN", token);
      const runner = spyRunner();
      const parsed = parseRunArguments([
        "update-documentation",
        "--repo",
        fixture.repository,
        "--instruction",
        INSTRUCTION,
        "--patch-only",
        "--pr",
        PULL,
      ]);
      const model = new SourceToolHarness({
        readOnSkill: "plan-documentation",
        planSourcePaths: [HTML_SOURCE_PATH],
      });
      const record = await executeRunRequest(
        { ...parsed, quiet: true },
        runtimeConfig(fixture.stateDirectory),
        {
          silent: true,
          executionHarness: model,
          skillResolver,
          changeRequestCommands: runner,
          changeRequestEnvironment: { GH_TOKEN: token, GITHUB_TOKEN: token },
        },
      );
      expect([...model.listedPaths].sort()).toEqual(
        [
          changeSourceRepositoryPath(change.head, "diff"),
          changeSourceRepositoryPath(change.head, "manifest"),
        ].sort(),
      );
      const { text, record: saved } = await persisted(fixture.stateDirectory, record?.id);
      expect(saved.changeSources).toHaveLength(1);
      expect((saved.changeSources as Record<string, unknown>[])[0]).toMatchObject({
        sourceKind: "github-pull-request",
        provenance: "forge-reported",
        rangeSemantics: "three-dot",
        head: change.head,
        mergeBase: change.fork,
      });
      // Row 8b: anonymous reads only, and no forge command at all.
      expect(fake.requests.length).toBeGreaterThan(0);
      for (const request of fake.requests) {
        expect(Object.keys(request.headers), request.url).not.toContain("authorization");
        expect(JSON.stringify(request.headers).includes(token), request.url).toBe(false);
      }
      expect(runner.calls).toEqual([]);
      expect(text.includes(token)).toBe(false);
    },
    testTimeoutMs(90_000),
  );

  it(
    "binds run --change <github compare URL> and cites both observations the model listed",
    async () => {
      const fixture = await shallowWorkspace();
      const change = await buildChangeRepository(await roots.create("docsfab-gh-compare-run-"));
      const fake = new FakeGithub(change.repository);
      await fake.serveCompare("main", "feature/export-path");
      vi.stubGlobal("fetch", fake.fetch);
      const parsed = parseRunArguments([
        "update-documentation",
        "--repo",
        fixture.repository,
        "--instruction",
        INSTRUCTION,
        "--patch-only",
        "--change",
        `https://github.com/${OWNER}/${NAME}/compare/main...feature/export-path`,
      ]);
      expect(parsed.changeSource).toMatchObject({ source: "github-compare", form: "three-dot" });
      const model = new SourceToolHarness({
        readOnSkill: "plan-documentation",
        planSourcePaths: [HTML_SOURCE_PATH],
      });
      const record = await executeRunRequest(
        { ...parsed, quiet: true },
        runtimeConfig(fixture.stateDirectory),
        { silent: true, executionHarness: model, skillResolver },
      );
      expect(model.calls[0]?.stepId).toBe("plan-documentation");
      expect([...model.listedPaths].sort()).toEqual(
        [
          changeSourceRepositoryPath(change.head, "diff"),
          changeSourceRepositoryPath(change.head, "manifest"),
        ].sort(),
      );
      const { record: saved } = await persisted(fixture.stateDirectory, record?.id);
      expect(saved.changeSources).toEqual([
        expect.objectContaining({
          sourceKind: "github-compare",
          provenance: "forge-reported",
          rangeSemantics: "three-dot",
          base: change.baseNow,
          head: change.head,
          mergeBase: change.fork,
          diffFrom: change.fork,
          fileCount: 6,
          commitCount: 3,
        }),
      ]);
      // Both observations the record cites are the two the model listed.
      const listed = model.listed
        .filter((entry) => entry.repositoryPath?.startsWith("change-source/"))
        .map((entry) => entry.observationId);
      const cited = (
        saved.changeSources as { observations: { observationId: string }[] }[]
      )[0]!.observations.map((entry) => entry.observationId);
      expect([...new Set(listed)].sort()).toEqual([...cited].sort());
    },
    testTimeoutMs(90_000),
  );

  it(
    "refuses a GitHub --pr or compare that cannot be read before any model call",
    async () => {
      const fixture = await shallowWorkspace();
      const change = await buildChangeRepository(await roots.create("docsfab-gh-refuse-"));
      const fake = new FakeGithub(change.repository);
      await fake.serveCompare("main", "feature/export-path");
      vi.stubGlobal("fetch", fake.fetch);
      const cases: ReadonlyArray<readonly [string[], string]> = [
        [["--pr", `https://github.com/${OWNER}/${NAME}/pull/8`], "change-source-github-not-found"],
        [
          ["--change", `https://github.com/${OWNER}/${NAME}/compare/main..feature/export-path`],
          "change-source-github-two-dot-not-ancestor",
        ],
      ];
      for (const [argv, code] of cases) {
        const parsed = parseRunArguments([
          "update-documentation",
          "--repo",
          fixture.repository,
          "--instruction",
          INSTRUCTION,
          "--patch-only",
          ...argv,
        ]);
        const interpreter = countingInterpreter();
        const model = new SourceToolHarness({
          readOnSkill: "plan-documentation",
          planSourcePaths: [HTML_SOURCE_PATH],
        });
        const error = await executeRunRequest(
          { ...parsed, quiet: true },
          runtimeConfig(fixture.stateDirectory),
          {
            silent: true,
            executionHarness: model,
            skillResolver,
            requestInterpreter: interpreter.port,
          },
        ).catch((caught: unknown) => caught);
        expect(error, argv.join(" ")).toBeInstanceOf(ChangeSourceError);
        expect((error as ChangeSourceError).code, argv.join(" ")).toBe(code);
        expect(interpreter.calls(), argv.join(" ")).toBe(0);
        expect(model.calls, argv.join(" ")).toEqual([]);
      }
      expect(
        fake.paths().every((path) => !path.includes(`/repositories/${REPOSITORY_ID}/git/`)),
      ).toBe(true);
    },
    testTimeoutMs(90_000),
  );
});
