// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `docsfab run --change <github URL>` end to end through `executeRunRequest`,
 * in the checkout shape the alpha tasks use: `git init` plus a depth-1 fetch,
 * with no remote. The change lives only on the (fixture) forge, so the
 * forge-reported arm is the only way to read it. The global `fetch` is the
 * fixture forge; only the model turn is otherwise substituted.
 */
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { executeRunRequest } from "../src/cli/run-request.js";
import { sourceReadBudgetForModel } from "../src/cli/run/source-acquisition.js";
import { OperationalLimitError } from "../src/config/limits.js";
import {
  ChangeSourceError,
  parseChangeSourceSelector,
  type ChangeSourceV1,
} from "../src/inputs/change-source.js";
import {
  CHANGE_SOURCE_DIFF_MEDIA_TYPE,
  changeSourceRepositoryPath,
} from "../src/inputs/change-source/acquisition.js";
import type { RequestIntentInterpreterPort } from "../src/request-intent/interpret.js";
import { runtimeConfig } from "./support/execution-convergence.js";
import {
  createSourceFixture,
  HTML_SOURCE_PATH,
  runRequest,
  skillResolver,
  SourceToolHarness,
} from "./support/source-acquisition-cli.js";
import { fixtureGit } from "./support/change-source-fixture.js";
import {
  buildChangeRepository,
  FakeGithub,
  NAME,
  OWNER,
  pullJson,
  REPOSITORY_ID,
} from "./support/github-change-source-fixture.js";
import { temporaryRoots } from "./helpers/temp.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";

const roots = temporaryRoots();
const PULL = `https://github.com/${OWNER}/${NAME}/pull/7`;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  process.exitCode = undefined;
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
  expect(await fixtureGit(repository, ["rev-parse", "--is-shallow-repository"])).toBe("true");
  expect(await fixtureGit(repository, ["remote"])).toBe("");
  return { ...fixture, repository };
}

/** A merged pull request on the fixture forge, served through the global fetch. */
async function mergedPullForge() {
  const change = await buildChangeRepository(await roots.create("docsfab-gh-run-"));
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
  vi.stubGlobal("fetch", fake.fetch);
  return { ...change, fake };
}

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

function countingInterpreter(): {
  port: RequestIntentInterpreterPort;
  calls: () => number;
} {
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

describe("docsfab run --change <github URL> end to end (row 1)", () => {
  it(
    "binds a merged pull request read from the forge, cites its diff, and records exactly the expected manifest",
    async () => {
      const fixture = await shallowWorkspace();
      const { fake, fork, head, baseNow } = await mergedPullForge();
      const model = new DiffCitingHarness({
        readOnSkill: "plan-documentation",
        planSourcePaths: [HTML_SOURCE_PATH],
        readWindowMaxBytes: sourceReadBudgetForModel(undefined).budgetBytes,
      });
      const record = await executeRunRequest(
        {
          ...runRequest(fixture),
          changeSource: parseChangeSourceSelector(PULL),
        },
        runtimeConfig(fixture.stateDirectory),
        { silent: true, executionHarness: model, skillResolver },
      );
      expect(record?.status).toBe("succeeded");
      const diffPath = changeSourceRepositoryPath(head, "diff");
      const manifestPath = changeSourceRepositoryPath(head, "manifest");
      expect([...model.listedPaths].sort()).toEqual([diffPath, manifestPath].sort());

      const manifest = JSON.parse(readTexts(model).get(manifestPath)!) as ChangeSourceV1;
      const tree = (commit: string) =>
        fixtureGit(fake.repository, ["rev-parse", `${commit}^{tree}`]);
      const blob = (commit: string, path: string) =>
        fixtureGit(fake.repository, ["rev-parse", `${commit}:${path}`]);
      const subject = (commit: string) =>
        fixtureGit(fake.repository, ["show", "-s", "--format=%s", commit]);
      const parent = (commit: string) => fixtureGit(fake.repository, ["rev-parse", `${commit}~1`]);
      const second = await parent(head);
      const first = await parent(second);
      const { changeSourceSha256, revision, ...body } = manifest;
      expect(changeSourceSha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(revision).toEqual({
        schemaVersion: 1,
        kind: "docsfab-pinned-repository-revision",
        repository: {
          kind: "github-repository",
          identitySha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
        },
        base: baseNow,
        head,
      });
      expect(body).toEqual({
        schemaVersion: 1,
        kind: "docsfab-change-source",
        source: {
          kind: "github-pull-request",
          provenance: "forge-reported",
          host: "github.com",
          repositoryId: REPOSITORY_ID,
          fullName: `${OWNER}/${NAME}`,
          number: 7,
          state: "merged",
          headRepositoryId: REPOSITORY_ID,
        },
        objectFormat: "sha1",
        rangeSemantics: "three-dot",
        mergeBase: fork,
        diffFrom: fork,
        baseTree: await tree(fork),
        headTree: await tree(head),
        commits: [
          { id: first, parents: [fork], subject: await subject(first) },
          { id: second, parents: [first], subject: await subject(second) },
          { id: head, parents: [second], subject: await subject(head) },
        ],
        files: [
          {
            status: "A",
            similarity: null,
            oldPath: null,
            newPath: "assets/logo.png",
            oldMode: null,
            newMode: "100644",
            oldBlob: null,
            newBlob: await blob(head, "assets/logo.png"),
            binary: false,
            added: 0,
            removed: 0,
            diffOmitted: {
              code: "change-source-file-diff-omitted",
              basis: "forge-omitted",
              forgeReason: "no-patch",
            },
          },
          {
            status: "R",
            similarity: null,
            oldPath: "docs/export-notes.md",
            newPath: "docs/export-guide.md",
            oldMode: "100644",
            newMode: "100644",
            oldBlob: await blob(fork, "docs/export-notes.md"),
            newBlob: await blob(head, "docs/export-guide.md"),
            binary: false,
            added: 0,
            removed: 0,
          },
          {
            status: "D",
            similarity: null,
            oldPath: "obsolete.txt",
            newPath: null,
            oldMode: "100644",
            newMode: null,
            oldBlob: await blob(fork, "obsolete.txt"),
            newBlob: null,
            binary: false,
            added: 0,
            removed: 1,
          },
          {
            status: "M",
            similarity: null,
            oldPath: "scripts/release.sh",
            newPath: "scripts/release.sh",
            oldMode: "100644",
            newMode: "100755",
            oldBlob: await blob(fork, "scripts/release.sh"),
            newBlob: await blob(head, "scripts/release.sh"),
            binary: false,
            added: 0,
            removed: 0,
          },
          {
            status: "M",
            similarity: null,
            oldPath: "src/export.ts",
            newPath: "src/export.ts",
            oldMode: "100644",
            newMode: "100644",
            oldBlob: await blob(fork, "src/export.ts"),
            newBlob: await blob(head, "src/export.ts"),
            binary: false,
            added: 1,
            removed: 1,
          },
          {
            status: "A",
            similarity: null,
            oldPath: null,
            newPath: "src/flags.ts",
            oldMode: null,
            newMode: "100644",
            oldBlob: null,
            newBlob: await blob(head, "src/flags.ts"),
            binary: false,
            added: 1,
            removed: 0,
          },
        ],
        labels: [],
        protocol: { provider: "github" },
      });

      const diffLines = readTexts(model).get(diffPath)!.split("\n");
      expect(diffLines).toContain("rename from docs/export-notes.md");
      expect(diffLines).toContain("+export const requiresOutputPath = true;");
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
      const diffObservation = model.listed.find((entry) => entry.repositoryPath === diffPath)!;
      const citations = record!.sourceCitations!.steps.flatMap((step) => step.citations);
      expect(citations.map((citation) => citation.observationId)).toEqual([
        diffObservation.observationId,
      ]);

      // The merged range came from the pull request's own base, never the branch tip.
      expect(fake.paths().some((path) => path.includes("/git/ref/"))).toBe(false);
    },
    testTimeoutMs(90_000),
  );

  it(
    "binds a commit URL on update-documentation from the same shallow checkout",
    async () => {
      const fixture = await shallowWorkspace();
      const change = await buildChangeRepository(await roots.create("docsfab-gh-run-"));
      const fake = new FakeGithub(change.repository);
      await fake.serveCommit(change.head);
      vi.stubGlobal("fetch", fake.fetch);
      const model = new SourceToolHarness({
        readOnSkill: "plan-documentation",
        planSourcePaths: [HTML_SOURCE_PATH],
      });
      await executeRunRequest(
        {
          ...runRequest(fixture),
          workflow: "update-documentation",
          instruction: "Update docs/whats-new.md for the change.",
          allowWrite: false,
          changeSource: parseChangeSourceSelector(
            `https://github.com/${OWNER}/${NAME}/commit/${change.head}`,
          ),
        },
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
      // The diff extracts through the unified diff adapter: a manifest span
      // first, then a file locator for the mode-only change, which has no hunk.
      const diffLocators = model.listed
        .filter((entry) => entry.repositoryPath === changeSourceRepositoryPath(change.head, "diff"))
        .map((entry) => entry.locator);
      expect(diffLocators.length).toBeGreaterThan(0);
      expect(diffLocators.every((locator) => locator.kind === "diff")).toBe(true);
      expect(diffLocators[0]).toMatchObject({ kind: "diff", part: "manifest" });
      expect(diffLocators).toContainEqual(
        expect.objectContaining({ kind: "diff", part: "file", newPath: "scripts/release.sh" }),
      );
    },
    testTimeoutMs(90_000),
  );
});

describe("docsfab run update-documentation --change <merged pull URL>", () => {
  it(
    "binds the merged pull request on update-documentation too",
    async () => {
      const fixture = await shallowWorkspace();
      const { head } = await mergedPullForge();
      const model = new SourceToolHarness({
        readOnSkill: "plan-documentation",
        planSourcePaths: [HTML_SOURCE_PATH],
      });
      await executeRunRequest(
        {
          ...runRequest(fixture),
          workflow: "update-documentation",
          instruction: "Update docs/whats-new.md for the change.",
          allowWrite: false,
          changeSource: parseChangeSourceSelector(`${PULL}/files`),
        },
        runtimeConfig(fixture.stateDirectory),
        { silent: true, executionHarness: model, skillResolver },
      );
      expect([...model.listedPaths].sort()).toEqual(
        [
          changeSourceRepositoryPath(head, "diff"),
          changeSourceRepositoryPath(head, "manifest"),
        ].sort(),
      );
    },
    testTimeoutMs(90_000),
  );
});

describe("GitHub refusals before any model call (row 10)", () => {
  it(
    "refuses every forge, grammar and bound failure with no model call",
    async () => {
      const fixture = await shallowWorkspace();
      const { fake, head, baseNow } = await mergedPullForge();
      const cases: ReadonlyArray<readonly [string, () => void, string]> = [
        [
          "https://github.com/octo-org/widget/pull/8",
          () => undefined,
          "change-source-github-not-found",
        ],
        [
          PULL,
          () => {
            vi.stubEnv("DOCSFAB_CHANGE_SOURCES_COMMITS_MAX", "2");
          },
          "change-source-commits-bound",
        ],
        [
          PULL,
          () => {
            vi.unstubAllEnvs();
            // The last read sees the head moved on to another commit.
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
          },
          "change-source-github-head-moved",
        ],
        [
          PULL,
          () => {
            fake.body(
              `/repositories/${REPOSITORY_ID}/pulls/7`,
              { message: "rate" },
              {
                status: 403,
                headers: {
                  "x-ratelimit-remaining": "0",
                  "x-ratelimit-reset": "1790000000",
                },
              },
            );
          },
          "change-source-github-rate-limited",
        ],
        [
          PULL,
          () => {
            const tree = `/repositories/${REPOSITORY_ID}/git/trees/`;
            for (const request of fake.requests.filter((entry) => entry.url.includes(tree))) {
              fake.body(request.url, {
                sha: request.url.split(tree)[1]!.slice(0, 40),
                truncated: true,
                tree: [],
              });
            }
          },
          "change-source-github-tree-truncated",
        ],
        [
          `https://github.com/octo-org/widget/compare/${baseNow}...${head}@{1day}`,
          () => undefined,
          "change-source-github-compare-unsupported",
        ],
      ];
      for (const [url, arrange, code] of cases) {
        arrange();
        const interpreter = countingInterpreter();
        const model = new SourceToolHarness({
          readOnSkill: "plan-documentation",
          planSourcePaths: [HTML_SOURCE_PATH],
        });
        const error = await Promise.resolve()
          .then(() =>
            executeRunRequest(
              {
                ...runRequest(fixture),
                changeSource: parseChangeSourceSelector(url),
              },
              runtimeConfig(fixture.stateDirectory),
              {
                silent: true,
                executionHarness: model,
                skillResolver,
                requestInterpreter: interpreter.port,
              },
            ),
          )
          .catch((caught: unknown) => caught);
        expect(
          error instanceof ChangeSourceError || error instanceof OperationalLimitError,
          url,
        ).toBe(true);
        expect((error as ChangeSourceError).code, url).toBe(code);
        expect(interpreter.calls(), url).toBe(0);
        expect(model.calls, url).toEqual([]);
      }
    },
    testTimeoutMs(120_000),
  );
});
