// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * github.com compare URLs as change sources (row 2) and the tree path-set
 * check every GitHub kind's file list passes (D5), against a fixture forge
 * built from real local repositories. Expected paths, statuses and commits
 * are written out here, never computed with the fixture's own helpers.
 */
import { chmod, symlink } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveCliChangeSourceEvidence } from "../src/cli/run/source-acquisition.js";
import { OperationalLimitError } from "../src/config/limits.js";
import { prepareRepositoryWorkspace } from "../src/repository/workspace/materialize.js";
import {
  ChangeSourceError,
  parseChangeSourceSelector,
  type ChangeSourceFileV1,
} from "../src/inputs/change-source.js";
import { resolveGithubChangeSource } from "../src/inputs/change-source/github.js";
import type { GithubChangeSourceSelectorV1 } from "../src/inputs/change-source/github-url.js";
import { temporaryRoots } from "./helpers/temp.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";
import { commitFiles, fixtureGit, initChangeRepository } from "./support/change-source-fixture.js";
import {
  buildChangeRepository,
  FakeGithub,
  NAME,
  OWNER,
  pullJson,
  REPOSITORY_ID,
} from "./support/github-change-source-fixture.js";

const roots = temporaryRoots();
const COMPARE = `https://github.com/${OWNER}/${NAME}/compare/`;
const FULL_ID = /^[0-9a-f]{40}$/u;

afterEach(() => {
  vi.unstubAllEnvs();
});

async function resolve(fake: FakeGithub, url: string, environment: Record<string, string> = {}) {
  return resolveGithubChangeSource({
    selector: parseChangeSourceSelector(url) as GithubChangeSourceSelectorV1,
    fetch: fake.fetch,
    limits: { environment, hostFile: null },
  });
}

/** The coded refusal of a rejected resolution; anything else fails the test. */
async function refusalOf(pending: Promise<unknown>): Promise<ChangeSourceError> {
  const error = await pending.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  if (error instanceof ChangeSourceError) return error;
  throw new Error(`expected a change-source refusal, got ${String(error)}`);
}

/** A file as [status, old path, new path]: the shape the expectations below are written in. */
function shape(files: readonly ChangeSourceFileV1[]) {
  return files.map((file) => [file.status, file.oldPath, file.newPath]);
}

const subject = (repository: string, id: string) =>
  fixtureGit(repository, ["show", "-s", "--format=%s", id]);

/** The requests after the repository read: two pins by name, then full ids and `...` only. */
function expectPinnedReads(fake: FakeGithub, base: string, head: string, refs: [string, string]) {
  const paths = fake.paths();
  expect(paths.slice(0, 3)).toEqual([
    `/repos/${OWNER}/${NAME}`,
    `/repositories/${REPOSITORY_ID}/commits?sha=${encodeURIComponent(refs[0])}&per_page=1`,
    `/repositories/${REPOSITORY_ID}/commits?sha=${encodeURIComponent(refs[1])}&per_page=1`,
  ]);
  expect(paths[3]).toBe(`/repositories/${REPOSITORY_ID}/compare/${base}...${head}?per_page=100`);
  for (const path of paths.slice(3)) {
    const ids = path.match(/[0-9a-f]{40}/gu) ?? [];
    expect(ids.length, path).toBeGreaterThan(0);
    expect(path.replace("...", "").includes(".."), path).toBe(false);
    expect(path.includes("?sha="), path).toBe(false);
  }
}

const DIVERGED_FILES = [
  ["A", null, "assets/logo.png"],
  ["R", "docs/export-notes.md", "docs/export-guide.md"],
  ["D", "obsolete.txt", null],
  ["M", "scripts/release.sh", "scripts/release.sh"],
  ["M", "src/export.ts", "src/export.ts"],
  ["A", null, "src/flags.ts"],
];
const FEATURE_SUBJECTS = [
  "Require an explicit export path",
  "Add the output flag",
  "Make the release script executable",
];

describe("GitHub compare URLs: three-dot and two-dot (row 2, Acceptance 2)", () => {
  it(
    "reads main...feature of two diverged refs from their merge base, pinning both refs first",
    async () => {
      const { repository, fork, head, baseNow } = await buildChangeRepository(
        await roots.create("docsfab-gh-compare-"),
      );
      const fake = new FakeGithub(repository);
      await fake.serveCompare("main", "feature/export-path");
      const { changeSource, diffBytes } = await resolve(
        fake,
        `${COMPARE}main...feature/export-path`,
      );
      expect(changeSource.source).toEqual({
        kind: "github-compare",
        provenance: "forge-reported",
        host: "github.com",
        repositoryId: REPOSITORY_ID,
        fullName: `${OWNER}/${NAME}`,
      });
      expect(changeSource.rangeSemantics).toBe("three-dot");
      expect(changeSource.revision.base).toBe(baseNow);
      expect(changeSource.revision.head).toBe(head);
      expect(changeSource.mergeBase).toBe(fork);
      expect(changeSource.diffFrom).toBe(fork);
      expect(
        await Promise.all(changeSource.commits.map((entry) => subject(repository, entry.id))),
      ).toEqual(FEATURE_SUBJECTS);
      expect(shape(changeSource.files)).toEqual(DIVERGED_FILES);
      // The binary file GitHub sends no patch for stays listed, labelled as the forge's omission.
      expect(changeSource.files[0]!.diffOmitted).toEqual({
        code: "change-source-file-diff-omitted",
        basis: "forge-omitted",
        forgeReason: "no-patch",
      });
      // main moved on after the fork; its changelog is not part of the change.
      expect(new TextDecoder().decode(diffBytes).includes("CHANGELOG.md")).toBe(false);
      expectPinnedReads(fake, baseNow, head, ["main", "feature/export-path"]);
    },
    testTimeoutMs(60_000),
  );

  it(
    "refuses main..feature of two diverged refs with the two-dot code, before reading a tree",
    async () => {
      const { repository, head, baseNow } = await buildChangeRepository(
        await roots.create("docsfab-gh-compare-"),
      );
      const fake = new FakeGithub(repository);
      await fake.serveCompare("main", "feature/export-path");
      const error = await refusalOf(resolve(fake, `${COMPARE}main..feature/export-path`));
      expect(error.code).toBe("change-source-github-two-dot-not-ancestor");
      expect(fake.paths().some((path) => path.includes("/git/trees/"))).toBe(false);
      // The two-dot form was still read as `...` between the pinned ids.
      expectPinnedReads(fake, baseNow, head, ["main", "feature/export-path"]);
    },
    testTimeoutMs(60_000),
  );

  it(
    "with head behind base, refuses two-dot with the same code and reads three-dot as an empty range",
    async () => {
      const { repository, fork } = await buildChangeRepository(
        await roots.create("docsfab-gh-compare-"),
      );
      const fake = new FakeGithub(repository);
      // `fork` is main's parent, so the merge base is head itself, not base.
      await fake.serveCompare("main", fork);
      const twoDot = await refusalOf(resolve(fake, `${COMPARE}main..${fork}`));
      expect(twoDot.code).toBe("change-source-github-two-dot-not-ancestor");
      const threeDot = await refusalOf(resolve(fake, `${COMPARE}main...${fork}`));
      expect(threeDot.code).toBe("change-source-empty-range");
      expect(threeDot.message).toContain("already part of the base's history");
    },
    testTimeoutMs(60_000),
  );

  it(
    "with base an ancestor of head, admits both forms with the same files, two-dot diffing from base",
    async () => {
      const { repository, fork, head } = await buildChangeRepository(
        await roots.create("docsfab-gh-compare-"),
      );
      const fake = new FakeGithub(repository);
      await fake.serveCompare(fork, "feature/export-path");
      const threeDot = await resolve(fake, `${COMPARE}${fork}...feature/export-path`);
      const twoDot = await resolve(fake, `${COMPARE}${fork}..feature/export-path`);
      expect(threeDot.changeSource.rangeSemantics).toBe("three-dot");
      expect(twoDot.changeSource.rangeSemantics).toBe("two-dot");
      for (const { changeSource } of [threeDot, twoDot]) {
        expect(changeSource.revision.base).toBe(fork);
        expect(changeSource.revision.head).toBe(head);
        expect(changeSource.mergeBase).toBe(fork);
        expect(changeSource.diffFrom).toBe(fork);
        expect(shape(changeSource.files)).toEqual(DIVERGED_FILES);
      }
      expect(twoDot.changeSource.commits).toEqual(threeDot.changeSource.commits);
      expect(Buffer.from(twoDot.diffBytes).equals(Buffer.from(threeDot.diffBytes))).toBe(true);
    },
    testTimeoutMs(60_000),
  );

  it(
    "pins an abbreviated id to the full id GitHub returns, and refuses a full id answered by another commit",
    async () => {
      const { repository, fork, head } = await buildChangeRepository(
        await roots.create("docsfab-gh-compare-"),
      );
      const fake = new FakeGithub(repository);
      const short = fork.slice(0, 7);
      await fake.serveCompare(short, head);
      const { changeSource } = await resolve(fake, `${COMPARE}${short}...${head}`);
      expect(changeSource.revision.base).toBe(fork);
      expect(changeSource.revision.base).toMatch(FULL_ID);

      // GitHub answering a full id with some other commit is a malformed reply.
      fake.body(`/repositories/${REPOSITORY_ID}/commits?sha=${head}&per_page=1`, [
        await fake.commitJson(fork),
      ]);
      const error = await refusalOf(resolve(fake, `${COMPARE}${short}...${head}`));
      expect([error.code, error.detail]).toEqual([
        "change-source-github-response-invalid",
        "commit sha",
      ]);

      // An empty listing pins nothing.
      fake.body(`/repositories/${REPOSITORY_ID}/commits?sha=${head}&per_page=1`, []);
      const empty = await refusalOf(resolve(fake, `${COMPARE}${short}...${head}`));
      expect([empty.code, empty.detail]).toEqual([
        "change-source-github-response-invalid",
        "commit listing",
      ]);
    },
    testTimeoutMs(60_000),
  );

  it(
    "refuses a compare whose commits, complete in number, do not end at the pinned head",
    async () => {
      const { repository, fork, head } = await buildChangeRepository(
        await roots.create("docsfab-gh-compare-"),
      );
      const fake = new FakeGithub(repository);
      await fake.serveCompare(fork, head);
      const path = `/repositories/${REPOSITORY_ID}/compare/${fork}...${head}?per_page=100`;
      const whole = await fake.compareJson(fork, head);
      // Three commits as declared, but the head's own commit is not among them.
      fake.body(path, {
        ...whole,
        commits: [whole.commits[0], whole.commits[0], whole.commits[1]],
      });
      const error = await refusalOf(resolve(fake, `${COMPARE}${fork}...${head}`));
      expect([error.code, error.detail]).toEqual([
        "change-source-github-response-invalid",
        "compare commits head",
      ]);
    },
    testTimeoutMs(60_000),
  );

  it(
    "refuses a compare over changeSources.commitsMax with the declared count",
    async () => {
      const { repository } = await buildChangeRepository(await roots.create("docsfab-gh-compare-"));
      const fake = new FakeGithub(repository);
      await fake.serveCompare("main", "feature/export-path");
      const url = `${COMPARE}main...feature/export-path`;
      const over = await resolve(fake, url, { DOCSFAB_CHANGE_SOURCES_COMMITS_MAX: "2" }).catch(
        (caught: unknown) => caught,
      );
      expect(over).toBeInstanceOf(OperationalLimitError);
      expect(over).toMatchObject({
        code: "change-source-commits-bound",
        observed: 3,
        configured: 2,
      });
      const at = await resolve(fake, url, { DOCSFAB_CHANGE_SOURCES_COMMITS_MAX: "3" });
      expect(at.changeSource.commits).toHaveLength(3);
    },
    testTimeoutMs(60_000),
  );
});

describe("GitHub compare producer", () => {
  it(
    "mints both observations under the compare kind's own producer id",
    async () => {
      const { repository } = await buildChangeRepository(await roots.create("docsfab-gh-compare-"));
      const fake = new FakeGithub(repository);
      await fake.serveCompare("main", "feature/export-path");
      const resolved = await resolve(fake, `${COMPARE}main...feature/export-path`);
      const docs = await initChangeRepository(await roots.create("docsfab-gh-docs-"));
      const workspace = await prepareRepositoryWorkspace(docs.repository, "HEAD");
      try {
        const evidence = await resolveCliChangeSourceEvidence({
          workspace,
          resolved,
          admittedRequest: { workflow: "update-documentation", allowWrite: false },
          runId: "github-compare-producer",
        });
        expect(evidence.acquired.producerScopes.map((scope) => scope.producerId)).toEqual([
          "change-source-github-compare",
        ]);
        expect(evidence.acquired.acquired.map((entry) => entry.observation.producerId)).toEqual([
          "change-source-github-compare",
          "change-source-github-compare",
        ]);
      } finally {
        await workspace.dispose();
      }
    },
    testTimeoutMs(60_000),
  );
});

describe("the compare URL grammar (D2)", () => {
  const SHA = "0123456789abcdef0123456789abcdef01234567";

  it("claims each admitted form with its refs and range form", () => {
    const cases: ReadonlyArray<readonly [string, "two-dot" | "three-dot", string, string]> = [
      ["main...feature", "three-dot", "main", "feature"],
      ["main..feature", "two-dot", "main", "feature"],
      ["main...feature/export-path", "three-dot", "main", "feature/export-path"],
      ["release/1.x..feature/a/b", "two-dot", "release/1.x", "feature/a/b"],
      [`${SHA}...${SHA.slice(0, 7)}`, "three-dot", SHA, SHA.slice(0, 7)],
      ["main...feature.diff", "three-dot", "main", "feature"],
      ["main...feature.patch", "three-dot", "main", "feature"],
      ["main...feature/", "three-dot", "main", "feature"],
      ["main...feature?expand=1", "three-dot", "main", "feature"],
      ["main...feature#diff-0123", "three-dot", "main", "feature"],
      ["main...feature%2Fx", "three-dot", "main", "feature/x"],
      ["main...fix%23123", "three-dot", "main", "fix#123"],
      ["v1.0..v1.1", "two-dot", "v1.0", "v1.1"],
      // `@` is a ref character; only `@{` and a lone `@` are not.
      ["main...release@2", "three-dot", "main", "release@2"],
      // The URL parser trims trailing spaces and C0 controls; with no dot
      // segment before them, nothing the parser removes changes the range.
      ["main...feature ", "three-dot", "main", "feature"],
      ["main...feature\f", "three-dot", "main", "feature"],
    ];
    for (const [range, form, base, head] of cases) {
      expect(parseChangeSourceSelector(`${COMPARE}${range}`), range).toEqual({
        schemaVersion: 1,
        kind: "docsfab-change-source-selector",
        source: "github-compare",
        host: "github.com",
        owner: OWNER,
        repository: NAME,
        form,
        base,
        head,
      });
    }
    expect(
      parseChangeSourceSelector(`https://www.github.com/${OWNER}/${NAME}/compare/a...b`),
    ).toMatchObject({ source: "github-compare", host: "github.com" });
  });

  it("refuses each other form with its own code and never echoes the value", () => {
    const secret = "s3cr3t-Value";
    const cases: ReadonlyArray<readonly [string, string, string?]> = [
      // A query that changes the diff, or any query beside expand=1.
      [`main...${secret}?w=1`, "change-source-github-url-grammar", "query string"],
      ["main...feature?expand=1&w=1", "change-source-github-url-grammar", "query string"],
      ["main...feature?expand=0", "change-source-github-url-grammar", "query string"],
      // No range: the bare compare page, or one ref.
      ["", "change-source-github-compare-unsupported"],
      ["main", "change-source-github-compare-unsupported"],
      [`${secret}.x`, "change-source-github-compare-unsupported"],
      // Another fork, or a reflog date.
      [`owner:${secret}...main`, "change-source-github-compare-unsupported"],
      ["main...owner:repo:branch", "change-source-github-compare-unsupported"],
      [`main@{1day}...${secret}`, "change-source-github-compare-unsupported"],
      ["main...main%40%7B1day%7D", "change-source-github-compare-unsupported"],
      // Malformed sides.
      ["...main", "change-source-github-url-grammar", "compare range"],
      ["main..", "change-source-github-url-grammar", "compare range"],
      ["a....b", "change-source-github-url-grammar", "compare range"],
      ["a...b...c", "change-source-github-url-grammar", "compare range"],
      ["a..b..c", "change-source-github-url-grammar", "compare range"],
      ["main...feature~1", "change-source-github-url-grammar", "compare range"],
      ["main...feature%5E", "change-source-github-url-grammar", "compare range"],
      ["main...a%20b", "change-source-github-url-grammar", "compare range"],
      ["main...-x", "change-source-github-url-grammar", "compare range"],
      ["main...x.lock", "change-source-github-url-grammar", "compare range"],
      ["main...a//b", "change-source-github-url-grammar", "compare range"],
      ["main...@", "change-source-github-url-grammar", "compare range"],
      ["main...%E0%A4%A", "change-source-github-url-grammar", "compare range"],
      // Dot segments the URL parser would silently remove. Each one collapses
      // into an admissible compare, so only the dot-segment check refuses it.
      ["x/../main...feature", "change-source-github-url-grammar", "path"],
      ["x/%2e%2e/main...feature", "change-source-github-url-grammar", "path"],
      ["x/.%2E/main...feature", "change-source-github-url-grammar", "path"],
      ["main...x/%2e", "change-source-github-url-grammar", "path"],
      ["./main...feature", "change-source-github-url-grammar", "path"],
      ["x\\..\\main...feature", "change-source-github-url-grammar", "path"],
      // A final dot segment the parser exposes by trimming trailing spaces
      // and C0 controls; as typed, the head side is `feature/x/..`.
      ["main...feature/x/.. ", "change-source-github-url-grammar", "path"],
      ["main...feature/x/..\f", "change-source-github-url-grammar", "path"],
      ["main...feature/x/..\u0001", "change-source-github-url-grammar", "path"],
      ["main...feature/x/%2e%2e ", "change-source-github-url-grammar", "path"],
      // The parser trims neither a no-break space nor `!`, so the segment
      // stays `..` plus a character, which no ref name may hold.
      ["main...feature/x/..\u00a0", "change-source-github-url-grammar", "compare range"],
      ["main...feature/x/..!", "change-source-github-url-grammar", "compare range"],
    ];
    for (const [range, code, detail] of cases) {
      let error: unknown;
      try {
        parseChangeSourceSelector(`${COMPARE}${range}`);
      } catch (caught) {
        error = caught;
      }
      expect(error, range).toBeInstanceOf(ChangeSourceError);
      const refusal = error as ChangeSourceError;
      expect([refusal.code, refusal.detail], range).toEqual([code, detail]);
      expect(refusal.message.includes(secret), range).toBe(false);
      expect(refusal.message.includes(`/${OWNER}/`), range).toBe(false);
    }
    // A compare URL whose dot segments would collapse into a pull request path.
    let collapsed: unknown;
    try {
      parseChangeSourceSelector(`${COMPARE}x/../../pull/1`);
    } catch (caught) {
      collapsed = caught;
    }
    expect(collapsed).toMatchObject({ code: "change-source-github-url-grammar", detail: "path" });
  });

  it("refuses ?expand=1 on every route but compare", () => {
    for (const value of [
      `https://github.com/${OWNER}/${NAME}/pull/7?expand=1`,
      `https://github.com/${OWNER}/${NAME}/commit/${SHA}?expand=1`,
    ]) {
      expect(() => parseChangeSourceSelector(value), value).toThrowError(
        expect.objectContaining({
          code: "change-source-github-url-grammar",
          detail: "query string",
        }),
      );
    }
  });
});

/** One commit per benign probe on top of a seeded repository; each probe is its own change. */
async function probeRepository() {
  const { repository } = await initChangeRepository(await roots.create("docsfab-gh-oracle-"), {
    "README.md": "# Probe\n",
    "guide.md": "one\ntwo\nthree\nfour\nfive\nsix\n",
    "page.md": "a page that moves unchanged\n",
    "source.md": "copy me\n",
    "run.sh": "echo run\n",
    "link-target.md": "target\n",
    swap: "a file that becomes a directory\n",
    "empty-old.md": "",
  });
  const probes: Record<string, string> = {};
  const record = async (name: string, files: Record<string, string | null>) => {
    probes[name] = await commitFiles(repository, files, name);
  };
  await record("rename with an edit", {
    "guide.md": null,
    "manual.md": "one\ntwo\nTHREE\nfour\nfive\nsix\n",
  });
  await record("pure rename", {
    "page.md": null,
    "moved/page.md": "a page that moves unchanged\n",
  });
  await record("copy", { "copied.md": "copy me\n" });
  await chmod(join(repository, "run.sh"), 0o755);
  await record("mode only", {});
  await fixtureGit(repository, ["rm", "-q", "link-target.md"]);
  await symlink("README.md", join(repository, "link-target.md"));
  await record("file to symlink", {});
  await record("directory and file swap", { swap: null, "swap/inner.md": "now a directory\n" });
  await record("empty file added", { "empty-new.md": "" });
  await record("empty file deleted", { "empty-old.md": null });
  // Gitlinks last: `git add -A` in later commits would drop a gitlink with no checkout.
  const sub = (n: number) => String(n).repeat(40);
  await fixtureGit(repository, ["update-index", "--add", "--cacheinfo", `160000,${sub(1)},vendor`]);
  await fixtureGit(repository, ["commit", "-q", "-m", "add a submodule"]);
  await fixtureGit(repository, ["update-index", "--cacheinfo", `160000,${sub(2)},vendor`]);
  await fixtureGit(repository, ["commit", "-q", "-m", "gitlink bump"]);
  probes["gitlink bump"] = await fixtureGit(repository, ["rev-parse", "HEAD"]);
  return { repository, probes };
}

/** Serve `<parent>...<probe>` and return its compare URL and the compare's API path. */
async function serveProbe(fake: FakeGithub, probe: string) {
  const parent = await fixtureGit(fake.repository, ["rev-parse", `${probe}~1`]);
  await fake.serveCompare(parent, probe);
  return {
    url: `${COMPARE}${parent}...${probe}`,
    path: `/repositories/${REPOSITORY_ID}/compare/${parent}...${probe}?per_page=100`,
    compare: await fake.compareJson(parent, probe),
  };
}

describe("the forge file list matches the two trees as a set of paths (D5)", () => {
  it(
    "admits each benign change: renames, a copy, mode, symlink, swap, gitlink and empty files",
    async () => {
      const { repository, probes } = await probeRepository();
      const expected: Record<string, unknown[]> = {
        "rename with an edit": [["R", "guide.md", "manual.md"]],
        "pure rename": [["R", "page.md", "moved/page.md"]],
        copy: [["C", "source.md", "copied.md"]],
        "mode only": [["M", "run.sh", "run.sh"]],
        "file to symlink": [["T", "link-target.md", "link-target.md"]],
        "directory and file swap": [
          ["D", "swap", null],
          ["A", null, "swap/inner.md"],
        ],
        "empty file added": [["A", null, "empty-new.md"]],
        "empty file deleted": [["D", "empty-old.md", null]],
        "gitlink bump": [["M", "vendor", "vendor"]],
      };
      for (const [name, files] of Object.entries(expected)) {
        const fake = new FakeGithub(repository);
        const served = await serveProbe(fake, probes[name]!);
        if (name === "copy") {
          // GitHub reports a copy with its source; git's -M listing calls it added.
          fake.body(served.path, {
            ...served.compare,
            // An exact copy: GitHub sends no hunk for it.
            files: served.compare.files.map(({ patch: _patch, ...file }) => ({
              ...file,
              status: "copied",
              previous_filename: "source.md",
            })),
          });
        }
        const { changeSource } = await resolve(fake, served.url);
        expect(shape(changeSource.files), name).toEqual(files);
      }
    },
    testTimeoutMs(90_000),
  );

  it(
    "refuses a pure rename listed without its old path, and counts a rename once against changedFilesMax",
    async () => {
      const { repository, probes } = await probeRepository();
      const fake = new FakeGithub(repository);
      const served = await serveProbe(fake, probes["pure rename"]!);
      // The trees change two paths for one file; at a bound of one file it admits.
      const admitted = await resolve(fake, served.url, {
        DOCSFAB_CHANGE_SOURCES_CHANGED_FILES_MAX: "1",
      });
      expect(shape(admitted.changeSource.files)).toEqual([["R", "page.md", "moved/page.md"]]);
      // The same entry reported as an add leaves the old path changed and unlisted.
      fake.body(served.path, {
        ...served.compare,
        files: served.compare.files.map(({ previous_filename: _old, ...file }) => ({
          ...file,
          status: "added",
        })),
      });
      const error = await refusalOf(resolve(fake, served.url));
      expect([error.code, error.detail]).toEqual([
        "change-source-github-incomplete",
        "files: 0 listed that the trees do not change, 1 changed in the trees and not listed",
      ]);
    },
    testTimeoutMs(60_000),
  );

  it(
    "refuses a list of the right length naming another file, and a file listed twice",
    async () => {
      const { repository, probes } = await probeRepository();
      const fake = new FakeGithub(repository);
      const served = await serveProbe(fake, probes["empty file added"]!);
      // README.md is in both trees, unchanged: same count, different set.
      fake.body(served.path, {
        ...served.compare,
        files: served.compare.files.map((file) => ({ ...file, filename: "README.md" })),
      });
      const swapped = await refusalOf(resolve(fake, served.url));
      expect([swapped.code, swapped.detail]).toEqual([
        "change-source-github-incomplete",
        "files: 1 listed that the trees do not change, 1 changed in the trees and not listed",
      ]);
      fake.body(served.path, {
        ...served.compare,
        files: [...served.compare.files, ...served.compare.files],
      });
      const twice = await refusalOf(resolve(fake, served.url));
      expect([twice.code, twice.detail]).toEqual([
        "change-source-github-incomplete",
        "files: 1 listed that the trees do not change, 0 changed in the trees and not listed",
      ]);
    },
    testTimeoutMs(60_000),
  );

  it(
    "refuses a list cut short at a page cap, and applies changedFilesMax to the trees first",
    async () => {
      const { repository } = await initChangeRepository(await roots.create("docsfab-gh-cap-"));
      const base = await fixtureGit(repository, ["rev-parse", "HEAD"]);
      const head = await commitFiles(
        repository,
        Object.fromEntries(
          ["a", "b", "c", "d", "e"].map((name) => [`docs/${name}.md`, `${name}\n`]),
        ),
        "Add five pages",
      );
      const fake = new FakeGithub(repository);
      await fake.serveCompare(base, head);
      const path = `/repositories/${REPOSITORY_ID}/compare/${base}...${head}?per_page=100`;
      const whole = await fake.compareJson(base, head);
      // A forge cap: the first three files and no total to compare against.
      fake.body(path, { ...whole, files: whole.files.slice(0, 3) });
      const url = `${COMPARE}${base}...${head}`;
      const short = await refusalOf(resolve(fake, url));
      expect([short.code, short.detail]).toEqual([
        "change-source-github-incomplete",
        "files: 0 listed that the trees do not change, 2 changed in the trees and not listed",
      ]);
      const bound = await resolve(fake, url, {
        DOCSFAB_CHANGE_SOURCES_CHANGED_FILES_MAX: "4",
      }).catch((caught: unknown) => caught);
      expect(bound).toMatchObject({
        code: "change-source-changed-files-bound",
        observed: 5,
        configured: 4,
      });
    },
    testTimeoutMs(60_000),
  );
});

/** main with a side branch merged in: the merge commit's first-parent diff is the side's file. */
async function mergeCommitRepository() {
  const { repository } = await initChangeRepository(await roots.create("docsfab-gh-merge-"), {
    "README.md": "# Merge\n",
  });
  const fork = await fixtureGit(repository, ["rev-parse", "HEAD"]);
  await fixtureGit(repository, ["checkout", "-q", "-b", "side"]);
  const side = await commitFiles(repository, { "docs/side.md": "from the side\n" }, "side page");
  await fixtureGit(repository, ["checkout", "-q", "main"]);
  await commitFiles(repository, { "docs/main.md": "on main\n" }, "main page");
  await fixtureGit(repository, ["merge", "-q", "--no-ff", "-m", "Merge side", side]);
  const merge = await fixtureGit(repository, ["rev-parse", "HEAD"]);
  return { repository, fork, side, merge };
}

describe("merge commits: the forge list must equal the first-parent tree diff", () => {
  it(
    "admits a merge commit listed as its first-parent diff and refuses an empty list",
    async () => {
      const { repository, merge } = await mergeCommitRepository();
      const url = `https://github.com/${OWNER}/${NAME}/commit/${merge}`;
      const fake = new FakeGithub(repository);
      await fake.serveCommit(merge);
      const admitted = await resolve(fake, url);
      expect(shape(admitted.changeSource.files)).toEqual([["A", null, "docs/side.md"]]);
      // A clean merge's combined diff is empty, and its line totals then agree with it.
      const path = `/repositories/${REPOSITORY_ID}/commits/${merge}?per_page=100`;
      fake.body(path, {
        ...(await fake.commitJson(merge)),
        stats: { additions: 0, deletions: 0, total: 0 },
        files: [],
      });
      const error = await refusalOf(resolve(fake, url));
      expect([error.code, error.detail]).toEqual([
        "change-source-github-incomplete",
        "files: 0 listed that the trees do not change, 1 changed in the trees and not listed",
      ]);
    },
    testTimeoutMs(60_000),
  );

  it(
    "admits a merged pull request whose head is a merge commit and refuses its empty list",
    async () => {
      const change = await buildChangeRepository(await roots.create("docsfab-gh-merge-pull-"));
      const { repository } = change;
      // The feature branch merges main back in before it lands.
      await fixtureGit(repository, ["checkout", "-q", "feature/export-path"]);
      await fixtureGit(repository, ["merge", "-q", "--no-ff", "-m", "Merge main", "main"]);
      const head = await fixtureGit(repository, ["rev-parse", "HEAD"]);
      await fixtureGit(repository, ["checkout", "-q", "main"]);
      const fake = new FakeGithub(repository);
      await fake.servePull({
        number: 7,
        state: "closed",
        merged: true,
        baseSha: change.baseNow,
        baseRef: "main",
        headSha: head,
      });
      const url = `https://github.com/${OWNER}/${NAME}/pull/7`;
      const admitted = await resolve(fake, url);
      expect(admitted.changeSource.mergeBase).toBe(change.baseNow);
      expect(shape(admitted.changeSource.files)).toEqual(DIVERGED_FILES);
      const compare = `/repositories/${REPOSITORY_ID}/compare/${change.baseNow}...${head}?per_page=100`;
      fake.body(compare, { ...(await fake.compareJson(change.baseNow, head)), files: [] });
      // Four commits: the three feature commits and the merge of main.
      fake.body(
        `/repos/${OWNER}/${NAME}/pulls/7`,
        pullJson({
          number: 7,
          state: "closed",
          merged: true,
          baseSha: change.baseNow,
          baseRef: "main",
          headSha: head,
          commits: 4,
          changedFiles: 0,
        }),
      );
      const error = await refusalOf(resolve(fake, url));
      expect([error.code, error.detail]).toEqual([
        "change-source-github-incomplete",
        "files: 0 listed that the trees do not change, 7 changed in the trees and not listed",
      ]);
    },
    testTimeoutMs(60_000),
  );
});
