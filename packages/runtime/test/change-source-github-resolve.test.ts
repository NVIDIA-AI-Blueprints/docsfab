// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The GitHub change-source resolver against a fixture forge built from a real
 * local repository: identity, pull request state, head drift, completeness,
 * the anonymous transport, and the encoding and credential screens.
 */
import { createHash } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  resolveCliChangeSource,
  resolveCliChangeSourceEvidence,
} from "../src/cli/run/source-acquisition.js";
import { OperationalLimitError } from "../src/config/limits.js";
import { prepareRepositoryWorkspace } from "../src/repository/workspace/materialize.js";
import {
  ChangeSourceError,
  decodeChangeSourceV1,
  parseChangeSourceSelector,
  type ChangeSourceV1,
} from "../src/inputs/change-source.js";
import { DIFF_SOURCE_MEDIA_TYPE, diffSourceExtractorAdapter } from "../src/inputs/adapters/diff.js";
import { digestChangeSourceProducerScope } from "../src/inputs/change-source/acquisition.js";
import type { SourceDiffLocatorV1 } from "../src/inputs/source-evidence.js";
import { extractSourceRepresentation } from "../src/inputs/source-extraction.js";
import { resolveGithubChangeSource } from "../src/inputs/change-source/github.js";
import type { GithubChangeSourceSelectorV1 } from "../src/inputs/change-source/github-url.js";
import type { GithubPullRequestSourceV1 } from "../src/inputs/change-source/github-member.js";
import { configureCredential } from "./helpers/configured-credential.js";
import { temporaryRoots } from "./helpers/temp.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";
import { commitFiles, fixtureGit, initChangeRepository } from "./support/change-source-fixture.js";
import {
  API,
  buildChangeRepository,
  FakeGithub,
  FORK_ID,
  json,
  NAME,
  OWNER,
  pullJson,
  REPOSITORY_ID,
} from "./support/github-change-source-fixture.js";

const roots = temporaryRoots();
const PULL = `https://github.com/${OWNER}/${NAME}/pull/7`;
const NO_HOST_FILE = { environment: {}, hostFile: null } as const;

afterEach(() => {
  vi.unstubAllEnvs();
});

function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function selector(url: string): GithubChangeSourceSelectorV1 {
  return parseChangeSourceSelector(url) as GithubChangeSourceSelectorV1;
}

function limits(environment: Record<string, string> = {}) {
  return { environment, hostFile: null } as const;
}

async function resolve(fake: FakeGithub, url: string, environment: Record<string, string> = {}) {
  return resolveGithubChangeSource({
    selector: selector(url),
    fetch: fake.fetch,
    limits: limits(environment),
  });
}

/** The refusal code of a rejected resolution; anything else fails the test. */
async function codeOf(pending: Promise<unknown>): Promise<string> {
  const error = await pending.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  if (error instanceof ChangeSourceError || error instanceof OperationalLimitError)
    return error.code;
  throw new Error(`expected a coded refusal, got ${String(error)}`);
}

async function openPullFixture() {
  const change = await buildChangeRepository(await roots.create("docsfab-gh-"));
  const fake = new FakeGithub(change.repository);
  await fake.servePull({
    number: 7,
    state: "open",
    merged: false,
    baseSha: change.fork,
    baseRef: "main",
    headSha: change.head,
    baseNow: change.baseNow,
  });
  return { ...change, fake };
}

describe("GitHub pull request identity and range (row 3)", () => {
  it(
    "binds every whole-pull-request view to one repository-id identity and diffs only merge base to head",
    async () => {
      const { fake, fork, head, baseNow } = await openPullFixture();
      const views = ["", "/files", "/commits", "/changes"].map((view) =>
        selector(`${PULL}${view}`),
      );
      for (const view of views) expect(view).toEqual(views[0]);

      const { changeSource } = await resolve(fake, PULL);
      expect(changeSource.revision.repository).toEqual({
        kind: "github-repository",
        identitySha256: sha256Hex(`{"host":"github.com","repositoryId":${REPOSITORY_ID}}`),
      });
      // Open: base is the target tip now, the diff runs from the merge base.
      expect(changeSource.revision.base).toBe(baseNow);
      expect(changeSource.revision.head).toBe(head);
      expect(changeSource.rangeSemantics).toBe("three-dot");
      expect(changeSource.mergeBase).toBe(fork);
      expect(changeSource.diffFrom).toBe(fork);
      expect(changeSource.baseTree).toBe(
        await fixtureGit(fake.repository, ["rev-parse", `${fork}^{tree}`]),
      );
      // main's own change after the fork is not part of the pull request.
      expect(changeSource.files.map((file) => file.newPath ?? file.oldPath)).not.toContain(
        "CHANGELOG.md",
      );
      expect(changeSource.source).toEqual({
        kind: "github-pull-request",
        provenance: "forge-reported",
        host: "github.com",
        repositoryId: REPOSITORY_ID,
        fullName: `${OWNER}/${NAME}`,
        number: 7,
        state: "open",
        headRepositoryId: REPOSITORY_ID,
      });
      expect(decodeChangeSourceV1(JSON.parse(JSON.stringify(changeSource)))).toEqual(changeSource);
      // The documented request budget: pull, target ref, compare, two trees, head re-read.
      expect(fake.paths()).toEqual([
        `/repos/${OWNER}/${NAME}/pulls/7`,
        `/repositories/${REPOSITORY_ID}/git/ref/heads/main`,
        `/repositories/${REPOSITORY_ID}/compare/${baseNow}...${head}?per_page=100`,
        `/repositories/${REPOSITORY_ID}/git/trees/${changeSource.baseTree}?recursive=1`,
        `/repositories/${REPOSITORY_ID}/git/trees/${changeSource.headTree}?recursive=1`,
        `/repositories/${REPOSITORY_ID}/pulls/7`,
      ]);
    },
    testTimeoutMs(60_000),
  );

  it(
    "gives another pull request number, repository id or fork head another record and producer scope",
    async () => {
      const { fake, fork, head, baseNow } = await openPullFixture();
      const first = (await resolve(fake, PULL)).changeSource;
      const record = (overrides: Record<string, unknown>) => ({
        ...pullJson({
          number: 7,
          state: "open",
          merged: false,
          baseSha: fork,
          baseRef: "main",
          headSha: head,
          commits: first.commits.length,
          changedFiles: first.files.length,
        }),
        ...overrides,
      });

      // The same commits and files served as pull request 8.
      fake.body(`/repos/${OWNER}/${NAME}/pulls/8`, record({ number: 8 }));
      fake.body(`/repositories/${REPOSITORY_ID}/pulls/8`, record({ number: 8 }));
      const other = (await resolve(fake, `https://github.com/${OWNER}/${NAME}/pull/8`))
        .changeSource;
      expect(other.revision).toEqual(first.revision);
      expect(other.changeSourceSha256).not.toBe(first.changeSourceSha256);

      // The same pull request with its head in a fork.
      const fromFork = record({
        head: {
          ...record({}).head,
          repo: { id: FORK_ID, full_name: "someone/widget" },
        },
      });
      fake.body(`/repos/${OWNER}/${NAME}/pulls/7`, fromFork);
      fake.body(`/repositories/${REPOSITORY_ID}/pulls/7`, fromFork);
      const forked = (await resolve(fake, PULL)).changeSource;
      expect((forked.source as GithubPullRequestSourceV1).headRepositoryId).toBe(FORK_ID);
      expect(forked.changeSourceSha256).not.toBe(first.changeSourceSha256);

      const readScope = ["docs"];
      const scopes = [first, other, forked].map((changeSource) =>
        digestChangeSourceProducerScope({ changeSource, readScope }),
      );
      expect(new Set(scopes).size).toBe(3);

      // Another repository id is another identity even at the same name.
      const moved = new FakeGithub(fake.repository);
      const movedId = REPOSITORY_ID + 1;
      const pullRecord = record({
        base: {
          ...record({}).base,
          repo: { id: movedId, full_name: `${OWNER}/${NAME}` },
        },
      });
      moved.body(`/repos/${OWNER}/${NAME}/pulls/7`, pullRecord);
      moved.body(`/repositories/${movedId}/pulls/7`, pullRecord);
      for (const request of [...fake.requests]) {
        const path = request.url.slice(API.length);
        if (!path.startsWith(`/repositories/${REPOSITORY_ID}/`) || path.includes("/pulls/"))
          continue;
        const answer = await (await fake.fetch(request.url, {})).json();
        moved.body(
          path.replace(`/repositories/${REPOSITORY_ID}/`, `/repositories/${movedId}/`),
          answer,
        );
      }
      const elsewhere = (await resolve(moved, PULL)).changeSource;
      expect(elsewhere.revision.repository.identitySha256).not.toBe(
        first.revision.repository.identitySha256,
      );
      expect(baseNow).toBe(first.revision.base);
    },
    testTimeoutMs(60_000),
  );
});

describe("GitHub pull request state (row 12)", () => {
  /** The feature branch merged onto main three ways, each leaving main at a new tip. */
  async function mergedFixture(how: "merge-commit" | "squash" | "rebase") {
    const change = await buildChangeRepository(await roots.create("docsfab-gh-"));
    const { repository, head, baseNow } = change;
    await fixtureGit(repository, ["checkout", "-q", "main"]);
    if (how === "merge-commit") {
      await fixtureGit(repository, ["merge", "-q", "--no-ff", "-m", "Merge pull request #7", head]);
    } else if (how === "squash") {
      await fixtureGit(repository, ["merge", "-q", "--squash", head]);
      await fixtureGit(repository, ["commit", "-q", "-m", "Require an explicit export path (#7)"]);
    } else {
      await fixtureGit(repository, ["cherry-pick", `${change.fork}..${head}`]);
    }
    const mergedTip = await fixtureGit(repository, ["rev-parse", "main"]);
    const fake = new FakeGithub(repository);
    await fake.servePull({
      number: 7,
      state: "closed",
      merged: true,
      baseSha: baseNow,
      baseRef: "main",
      headSha: head,
      baseNow: mergedTip,
    });
    return { ...change, fake, mergedTip };
  }

  it.each(["merge-commit", "squash", "rebase"] as const)(
    "reads a %s merged pull request from its own recorded base and head",
    async (how) => {
      const { fake, fork, head, baseNow } = await mergedFixture(how);
      const frozen = await fake.compareJson(baseNow, head);
      const { changeSource } = await resolve(fake, PULL);
      expect(changeSource.revision.base).toBe(baseNow);
      expect(changeSource.revision.head).toBe(head);
      expect(changeSource.mergeBase).toBe(fork);
      expect((changeSource.source as GithubPullRequestSourceV1).state).toBe("merged");
      expect(changeSource.commits.map((entry) => entry.id)).toEqual(
        frozen.commits.map((entry) => entry.sha),
      );
      expect(changeSource.files.map((file) => file.newPath ?? file.oldPath)).toEqual(
        frozen.files.map((file) => file.filename),
      );
      expect(changeSource.files).toHaveLength(6);
      // A merged pull request never reads the target branch's tip: five requests.
      expect(fake.paths().some((path) => path.includes("/git/ref/"))).toBe(false);
      expect(fake.requests).toHaveLength(5);
    },
    testTimeoutMs(60_000),
  );

  it(
    "refuses a pull request closed without merging, before any further read",
    async () => {
      const change = await buildChangeRepository(await roots.create("docsfab-gh-"));
      const fake = new FakeGithub(change.repository);
      await fake.servePull({
        number: 7,
        state: "closed",
        merged: false,
        baseSha: change.fork,
        baseRef: "main",
        headSha: change.head,
      });
      expect(await codeOf(resolve(fake, PULL))).toBe("change-source-github-pull-closed-unmerged");
      expect(fake.paths()).toEqual([`/repos/${OWNER}/${NAME}/pulls/7`]);
    },
    testTimeoutMs(60_000),
  );
});

describe("GitHub pull request head drift (row 4)", () => {
  it(
    "refuses when the head moved between the first and last read, and admits a moved base",
    async () => {
      const { fake, fork, head, baseNow } = await openPullFixture();
      const reread = (headSha: string, baseSha: string) =>
        pullJson({
          number: 7,
          state: "open",
          merged: false,
          baseSha,
          baseRef: "main",
          headSha,
          commits: 3,
          changedFiles: 6,
        });
      fake.body(`/repositories/${REPOSITORY_ID}/pulls/7`, reread(baseNow, fork));
      expect(await codeOf(resolve(fake, PULL))).toBe("change-source-github-head-moved");
      // The head re-read is the last request.
      expect(fake.paths().at(-1)).toBe(`/repositories/${REPOSITORY_ID}/pulls/7`);

      // The target branch moved on again during the reads: neither the base
      // the pull request first reported nor the tip the range pinned.
      const movedOn = await commitFiles(fake.repository, { "NEWS.md": "news\n" }, "Move main on");
      expect([fork, baseNow]).not.toContain(movedOn);
      fake.body(`/repositories/${REPOSITORY_ID}/pulls/7`, reread(head, movedOn));
      const { changeSource } = await resolve(fake, PULL);
      expect(changeSource.revision.head).toBe(head);
      expect(changeSource.revision.base).toBe(baseNow);

      // The same head under another base repository is not the same pull request.
      const moved = reread(head, fork);
      fake.body(`/repositories/${REPOSITORY_ID}/pulls/7`, {
        ...moved,
        base: { ...moved.base, repo: { ...moved.base.repo, id: FORK_ID } },
      });
      expect(await codeOf(resolve(fake, PULL))).toBe("change-source-github-response-invalid");
    },
    testTimeoutMs(60_000),
  );
});

describe("GitHub file records and the synthesized diff (row 6, D0)", () => {
  it(
    "matches git's own diff for every file GitHub sent a patch for, and labels the one it did not",
    async () => {
      const { fake, fork, head } = await openPullFixture();
      const resolved = await resolve(fake, PULL);
      const { changeSource } = resolved;
      const byPath = new Map(
        changeSource.files.map((file) => [file.newPath ?? file.oldPath, file]),
      );

      const logo = byPath.get("assets/logo.png")!;
      expect(logo.diffOmitted).toEqual({
        code: "change-source-file-diff-omitted",
        basis: "forge-omitted",
        forgeReason: "no-patch",
      });
      expect(logo.binary).toBe(false);
      expect(byPath.get("docs/export-guide.md")).toMatchObject({
        status: "R",
        similarity: null,
        oldPath: "docs/export-notes.md",
        oldMode: "100644",
        newMode: "100644",
      });
      expect(byPath.get("scripts/release.sh")).toMatchObject({
        status: "M",
        oldMode: "100644",
        newMode: "100755",
      });
      expect(changeSource.protocol).toEqual({ provider: "github" });
      expect(changeSource.labels).toEqual([]);

      // Git's diff of the same range, without the rename score GitHub does
      // not report and without the binary file GitHub sent no patch for.
      const git = await fixtureGit(fake.repository, [
        "diff-tree",
        "-p",
        "-M",
        "--full-index",
        "--no-color",
        fork,
        head,
      ]);
      const expected = `${git}\n`
        .split(/(?=^diff --git )/mu)
        .filter((section) => !section.includes("assets/logo.png"))
        .map((section) => section.replace(/^similarity index \d+%\n/mu, ""))
        .join("");
      expect(Buffer.from(resolved.diffBytes).toString("utf8")).toBe(expected);
    },
    testTimeoutMs(60_000),
  );

  it(
    "extracts the synthesized diff into complete per-file and per-hunk spans",
    async () => {
      const { fake } = await openPullFixture();
      const { changeSource, diffBytes } = await resolve(fake, PULL);
      const extracted = await extractSourceRepresentation({
        adapter: diffSourceExtractorAdapter,
        bytes: diffBytes,
        mediaType: DIFF_SOURCE_MEDIA_TYPE,
      });
      expect(extracted.representation.completeness).toBe("complete");
      expect(extracted.representation.limitations).toEqual([]);
      const derivative = Buffer.from(extracted.derivative);
      const original = Buffer.from(diffBytes);
      const locators = extracted.representation.spans.map(
        (span) => span.locator as SourceDiffLocatorV1,
      );
      // Every span but the manifest is the original slice its locator names.
      for (const [index, span] of extracted.representation.spans.entries()) {
        const locator = locators[index]!;
        if (locator.part === "manifest") continue;
        expect(
          original
            .subarray(locator.startByte!, locator.endByte!)
            .equals(derivative.subarray(span.startByte, span.endByte)),
        ).toBe(true);
      }
      // One diff file per forge file with a patch, in order, with its paths,
      // change kind, and line counts; the no-patch file is the change-source
      // manifest's `diffOmitted` entry, not a diff file.
      const sent = changeSource.files.filter((file) => file.diffOmitted === undefined);
      const fileHeads = locators.filter(
        (locator) => locator.part === "header" || locator.part === "file",
      );
      const changeOf = {
        A: "added",
        D: "deleted",
        M: "modified",
        T: "modified",
        R: "renamed",
        C: "copied",
      };
      expect(
        fileHeads.map((locator) => [locator.oldPath, locator.newPath, locator.change]),
      ).toEqual(
        sent.map((file) => [
          file.oldPath,
          file.newPath,
          changeOf[file.status as keyof typeof changeOf],
        ]),
      );
      const rows = derivative.subarray(0, extracted.representation.spans[0]!.endByte).toString();
      expect(rows.split("\n")[0]).toMatch(
        new RegExp(
          `^diff manifest: ${sent.length} files, \\d+ hunks?, \\+${sent.reduce((total, file) => total + file.added, 0)} -${sent.reduce((total, file) => total + file.removed, 0)} lines$`,
          "u",
        ),
      );
      for (const [index, file] of sent.entries()) {
        const hunks = locators.filter(
          (locator) => locator.part === "hunk" && locator.fileOrdinal === index + 1,
        );
        expect(hunks.length > 0, String(file.newPath)).toBe(file.added + file.removed > 0);
      }
    },
    testTimeoutMs(60_000),
  );

  it(
    "keeps a file whose diff is over the per-file bound listed with its measured size",
    async () => {
      const { fake } = await openPullFixture();
      const { changeSource, diffBytes } = await resolve(fake, PULL, {
        DOCSFAB_CHANGE_SOURCES_FILE_DIFF_MAX_BYTES: "200",
      });
      const flags = changeSource.files.find((file) => file.newPath === "src/flags.ts")!;
      expect(flags.diffOmitted).toMatchObject({
        basis: "measured",
        limitName: "changeSources.fileDiffMaxBytes",
        limitBytes: 200,
      });
      expect(Buffer.from(diffBytes).toString("utf8")).not.toContain("b/src/flags.ts");
    },
    testTimeoutMs(60_000),
  );
});

describe("GitHub completeness against declared totals (row 6)", () => {
  it(
    "refuses a compare whose commits or files fall short of the declared totals",
    async () => {
      const { fake, fork, head, baseNow } = await openPullFixture();
      const path = `/repositories/${REPOSITORY_ID}/compare/${baseNow}...${head}?per_page=100`;
      const whole = await fake.compareJson(baseNow, head);
      fake.body(path, { ...whole, commits: whole.commits.slice(1) });
      expect(await codeOf(resolve(fake, PULL))).toBe("change-source-github-incomplete");

      fake.body(path, { ...whole, files: whole.files.slice(1) });
      expect(await codeOf(resolve(fake, PULL))).toBe("change-source-github-incomplete");

      fake.body(path, whole);
      expect((await resolve(fake, PULL)).changeSource.mergeBase).toBe(fork);
    },
    testTimeoutMs(60_000),
  );

  it(
    "follows rel=next across compare pages and stops at a last page with no next link",
    async () => {
      const { fake, head, baseNow } = await openPullFixture();
      const path = `/repositories/${REPOSITORY_ID}/compare/${baseNow}...${head}?per_page=100`;
      const whole = await fake.compareJson(baseNow, head);
      const second = `${API}/repositories/${REPOSITORY_ID}/compare/${baseNow}...${head}?per_page=100&page=2`;
      fake.route(path, () =>
        json(
          { ...whole, commits: whole.commits.slice(0, 2) },
          {
            headers: {
              link: `<${second}>; rel="next", <${second}>; rel="last"`,
            },
          },
        ),
      );
      fake.route(second, () =>
        json({ ...whole, files: undefined, commits: whole.commits.slice(2) }),
      );
      const { changeSource } = await resolve(fake, PULL);
      expect(changeSource.commits.map((entry) => entry.id)).toEqual(
        whole.commits.map((entry) => entry.sha),
      );
      expect(fake.paths()).toContain(second.slice(API.length));
    },
    testTimeoutMs(60_000),
  );

  it(
    "refuses one page past changeSourcesGithub.pagesMax and admits exactly at it",
    async () => {
      const { fake, head, baseNow } = await openPullFixture();
      const path = `/repositories/${REPOSITORY_ID}/compare/${baseNow}...${head}?per_page=100`;
      const whole = await fake.compareJson(baseNow, head);
      const page = (n: number) =>
        `${API}/repositories/${REPOSITORY_ID}/compare/${baseNow}...${head}?per_page=100&page=${n}`;
      fake.route(path, () =>
        json(
          { ...whole, commits: whole.commits.slice(0, 1) },
          { headers: { link: `<${page(2)}>; rel="next"` } },
        ),
      );
      fake.route(page(2), () =>
        json(
          { ...whole, files: undefined, commits: whole.commits.slice(1, 2) },
          { headers: { link: `<${page(3)}>; rel="next"` } },
        ),
      );
      fake.route(page(3), () =>
        json({ ...whole, files: undefined, commits: whole.commits.slice(2) }),
      );

      const atBound = await resolve(fake, PULL, {
        DOCSFAB_CHANGE_SOURCES_GITHUB_PAGES_MAX: "3",
      });
      expect(atBound.changeSource.commits).toHaveLength(3);

      const error = await resolve(fake, PULL, {
        DOCSFAB_CHANGE_SOURCES_GITHUB_PAGES_MAX: "2",
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(OperationalLimitError);
      expect(error).toMatchObject({
        code: "change-source-github-pages-bound",
        observed: 3,
        configured: 2,
      });
    },
    testTimeoutMs(60_000),
  );

  it(
    "refuses a pull request over the commit or changed-file bound with the declared count",
    async () => {
      const { fake } = await openPullFixture();
      const files = await resolve(fake, PULL, {
        DOCSFAB_CHANGE_SOURCES_CHANGED_FILES_MAX: "6",
      });
      expect(files.changeSource.files).toHaveLength(6);
      const overFiles = await resolve(fake, PULL, {
        DOCSFAB_CHANGE_SOURCES_CHANGED_FILES_MAX: "5",
      }).catch((caught: unknown) => caught);
      expect(overFiles).toMatchObject({
        code: "change-source-changed-files-bound",
        observed: 6,
        configured: 5,
      });

      const commits = await resolve(fake, PULL, {
        DOCSFAB_CHANGE_SOURCES_COMMITS_MAX: "3",
      });
      expect(commits.changeSource.commits).toHaveLength(3);
      const overCommits = await resolve(fake, PULL, {
        DOCSFAB_CHANGE_SOURCES_COMMITS_MAX: "2",
      }).catch((caught: unknown) => caught);
      expect(overCommits).toMatchObject({
        code: "change-source-commits-bound",
        observed: 3,
        configured: 2,
      });
    },
    testTimeoutMs(60_000),
  );

  it(
    "refuses a truncated tree",
    async () => {
      const { fake, head } = await openPullFixture();
      const tree = await fixtureGit(fake.repository, ["rev-parse", `${head}^{tree}`]);
      const path = `/repositories/${REPOSITORY_ID}/git/trees/${tree}?recursive=1`;
      fake.body(path, { ...(await fake.treeJson(tree)), truncated: true });
      expect(await codeOf(resolve(fake, PULL))).toBe("change-source-github-tree-truncated");
    },
    testTimeoutMs(60_000),
  );
});

describe("GitHub commit URLs", () => {
  it(
    "reads a commit against its first parent and pins an abbreviated id to the full one",
    async () => {
      const { repository, head } = await buildChangeRepository(await roots.create("docsfab-gh-"));
      const parent = await fixtureGit(repository, ["rev-parse", `${head}~1`]);
      const fake = new FakeGithub(repository);
      const short = head.slice(0, 12);
      await fake.serveCommit(head, short);
      const { changeSource } = await resolve(
        fake,
        `https://github.com/${OWNER}/${NAME}/commit/${short}`,
      );
      expect(changeSource.rangeSemantics).toBe("first-parent-commit");
      expect(changeSource.revision.head).toBe(head);
      expect(changeSource.revision.base).toBe(parent);
      expect(changeSource.diffFrom).toBe(parent);
      expect(changeSource.mergeBase).toBeNull();
      expect(changeSource.commits.map((entry) => entry.id)).toEqual([head]);
      expect(changeSource.source).toEqual({
        kind: "github-commit",
        provenance: "forge-reported",
        host: "github.com",
        repositoryId: REPOSITORY_ID,
        fullName: `${OWNER}/${NAME}`,
      });
      expect(changeSource.files).toEqual([
        expect.objectContaining({
          status: "M",
          oldPath: "scripts/release.sh",
          oldMode: "100644",
          newMode: "100755",
        }),
      ]);
      // Repository, commit, parent commit, two trees.
      expect(fake.requests).toHaveLength(5);
    },
    testTimeoutMs(60_000),
  );

  it(
    "refuses a commit whose resolved id does not extend the abbreviation",
    async () => {
      const { repository, head } = await buildChangeRepository(await roots.create("docsfab-gh-"));
      const fake = new FakeGithub(repository);
      await fake.serveCommit(head, "abcd");
      expect(await codeOf(resolve(fake, `https://github.com/${OWNER}/${NAME}/commit/abcd`))).toBe(
        "change-source-github-response-invalid",
      );
    },
    testTimeoutMs(60_000),
  );

  it(
    "quotes a non-ASCII or control-character path, and heads an empty file, exactly as git does",
    async () => {
      const { repository } = await initChangeRepository(await roots.create("docsfab-gh-"), {
        "README.md": "# Root\n",
      });
      const head = await commitFiles(
        repository,
        {
          "docs/caf\u00e9 notes.md": "Bonjour\n",
          'docs/say "hi"\tnow.md': "Hi\n",
          // An empty file has no hunk to send: a header-only section, no omission.
          "docs/empty.md": "",
        },
        "Add quoted paths",
      );
      const fake = new FakeGithub(repository);
      await fake.serveCommit(head);
      const { diffBytes, changeSource } = await resolve(
        fake,
        `https://github.com/${OWNER}/${NAME}/commit/${head}`,
      );
      expect(
        changeSource.files.find((file) => file.newPath === "docs/empty.md"),
      ).not.toHaveProperty("diffOmitted");
      const git = await fixtureGit(repository, [
        "diff-tree",
        "-p",
        "-M",
        "--full-index",
        "--no-color",
        `${head}~1`,
        head,
      ]);
      expect(Buffer.from(diffBytes).toString("utf8")).toBe(`${git}\n`);
      expect(Buffer.from(diffBytes).toString("utf8")).toContain('"b/docs/caf\\303\\251 notes.md"');
    },
    testTimeoutMs(60_000),
  );

  it(
    "labels a no-patch file filled from or emptied to the empty file, and not an emptied-then-deleted one",
    async () => {
      const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03]);
      const { repository } = await initChangeRepository(await roots.create("docsfab-gh-"), {
        "assets/placeholder.png": "",
        "assets/icon.png": binary,
        "docs/empty.md": "",
      });
      const head = await commitFiles(
        repository,
        {
          "assets/placeholder.png": binary,
          "assets/icon.png": "",
          "docs/empty.md": null,
        },
        "Fill the placeholder, empty the icon, drop the empty page",
      );
      const fake = new FakeGithub(repository);
      await fake.serveCommit(head);
      const { diffBytes, changeSource } = await resolve(
        fake,
        `https://github.com/${OWNER}/${NAME}/commit/${head}`,
      );
      const byPath = new Map(
        changeSource.files.map((file) => [file.newPath ?? file.oldPath, file]),
      );
      const omitted = {
        code: "change-source-file-diff-omitted",
        basis: "forge-omitted",
        forgeReason: "no-patch",
      };
      expect(byPath.get("assets/placeholder.png")).toMatchObject({ status: "M" });
      expect(byPath.get("assets/placeholder.png")!.diffOmitted).toEqual(omitted);
      expect(byPath.get("assets/icon.png")).toMatchObject({ status: "M" });
      expect(byPath.get("assets/icon.png")!.diffOmitted).toEqual(omitted);
      // A deleted empty file changes no content: a header-only section.
      expect(byPath.get("docs/empty.md")).toMatchObject({ status: "D" });
      expect(byPath.get("docs/empty.md")).not.toHaveProperty("diffOmitted");
      const git = await fixtureGit(repository, [
        "diff-tree",
        "-p",
        "--full-index",
        "--no-color",
        `${head}~1`,
        head,
      ]);
      const expected = `${git}\n`
        .split(/(?=^diff --git )/mu)
        .filter((section) => !section.includes("assets/"))
        .join("");
      expect(Buffer.from(diffBytes).toString("utf8")).toBe(expected);
    },
    testTimeoutMs(60_000),
  );

  it(
    "reads a root commit against the empty tree",
    async () => {
      const { repository } = await initChangeRepository(await roots.create("docsfab-gh-"), {
        "README.md": "# Root\n",
      });
      const root = await fixtureGit(repository, ["rev-parse", "HEAD"]);
      const fake = new FakeGithub(repository);
      await fake.serveCommit(root);
      const { changeSource } = await resolve(
        fake,
        `https://github.com/${OWNER}/${NAME}/commit/${root}`,
      );
      expect(changeSource.revision.base).toBeUndefined();
      expect(changeSource.diffFrom).toBeNull();
      expect(changeSource.baseTree).toBe("4b825dc642cb6eb9a060e54bf8d69288fbee4904");
      expect(changeSource.files).toEqual([
        expect.objectContaining({ status: "A", newPath: "README.md" }),
      ]);
    },
    testTimeoutMs(60_000),
  );

  /** A commit whose files fill pages of exactly GitHub's page size; trees and ids are synthetic. */
  function pagedCommit(fileCount: number, pageSizes: readonly number[]) {
    const id = (n: number, salt: string) => createHash("sha1").update(`${salt}:${n}`).digest("hex");
    const head = id(0, "commit");
    const parent = id(1, "commit");
    const baseTree = id(0, "tree");
    const headTree = id(1, "tree");
    const files = Array.from({ length: fileCount }, (_, n) => ({
      sha: id(n, "blob"),
      filename: `docs/page-${n}.md`,
      status: "added",
      additions: 1,
      deletions: 0,
      changes: 1,
      patch: "@@ -0,0 +1 @@\n+page",
    }));
    const fake = new FakeGithub("unused");
    fake.body(`/repos/${OWNER}/${NAME}`, {
      id: REPOSITORY_ID,
      full_name: `${OWNER}/${NAME}`,
    });
    const page = (n: number) =>
      `${API}/repositories/${REPOSITORY_ID}/commits/${head}?per_page=100${n === 1 ? "" : `&page=${n}`}`;
    let offset = 0;
    pageSizes.forEach((size, index) => {
      const slice = files.slice(offset, offset + size);
      offset += size;
      const last = index === pageSizes.length - 1;
      fake.route(page(index + 1), () =>
        json(
          {
            sha: head,
            commit: { message: "Add pages", tree: { sha: headTree } },
            parents: [{ sha: parent }],
            stats: { additions: fileCount, deletions: 0, total: fileCount },
            files: slice,
          },
          last ? {} : { headers: { link: `<${page(index + 2)}>; rel="next"` } },
        ),
      );
    });
    fake.body(`/repositories/${REPOSITORY_ID}/git/commits/${parent}`, {
      sha: parent,
      tree: { sha: baseTree },
    });
    fake.body(`/repositories/${REPOSITORY_ID}/git/trees/${baseTree}?recursive=1`, {
      sha: baseTree,
      truncated: false,
      tree: [],
    });
    fake.body(`/repositories/${REPOSITORY_ID}/git/trees/${headTree}?recursive=1`, {
      sha: headTree,
      truncated: false,
      tree: files.map((file) => ({
        path: file.filename,
        mode: "100644",
        type: "blob",
        sha: file.sha,
      })),
    });
    return {
      fake,
      url: `https://github.com/${OWNER}/${NAME}/commit/${head}`,
      page,
    };
  }

  it(
    "admits an exactly full last page with no next link, and reads every linked page",
    async () => {
      const full = pagedCommit(100, [100]);
      const admitted = await resolve(full.fake, full.url);
      expect(admitted.changeSource.files).toHaveLength(100);
      expect(
        full.fake
          .paths()
          .filter((path) => path.startsWith(`/repositories/${REPOSITORY_ID}/commits/`)),
      ).toHaveLength(1);

      const split = pagedCommit(150, [100, 50]);
      const both = await resolve(split.fake, split.url);
      expect(both.changeSource.files.map((file) => file.newPath)).toContain("docs/page-149.md");
    },
    testTimeoutMs(60_000),
  );

  it(
    "refuses a file listing short of the commit's declared line totals",
    async () => {
      // GitHub declared 150 added lines and listed 100 one-line files with no next link.
      const short = pagedCommit(150, [100]);
      expect(await codeOf(resolve(short.fake, short.url))).toBe("change-source-github-incomplete");
    },
    testTimeoutMs(60_000),
  );

  it(
    "refuses a commit listing one file past changeSources.changedFilesMax",
    async () => {
      const paged = pagedCommit(150, [100, 50]);
      const error = await resolve(paged.fake, paged.url, {
        DOCSFAB_CHANGE_SOURCES_CHANGED_FILES_MAX: "149",
      }).catch((caught: unknown) => caught);
      expect(error).toMatchObject({
        code: "change-source-changed-files-bound",
        observed: 150,
        configured: 149,
      });
      const admitted = await resolve(paged.fake, paged.url, {
        DOCSFAB_CHANGE_SOURCES_CHANGED_FILES_MAX: "150",
      });
      expect(admitted.changeSource.files).toHaveLength(150);
    },
    testTimeoutMs(60_000),
  );
});

describe("anonymous GitHub transport (rows 7, 8a)", () => {
  it(
    "sends no Authorization header and never follows redirects itself, whatever the environment holds",
    async () => {
      const { fake } = await openPullFixture();
      const token = ["ghp", "Zq8Lk2Vn5Mc7Bt4Rw9Xh3Jd6Fs1Gt0Ya2Ub"].join("_");
      vi.stubEnv("GITHUB_TOKEN", token);
      vi.stubEnv("GH_TOKEN", token);
      const workspace = {
        sourcePath: "/nonexistent",
        revision: "0".repeat(40),
      } as never;
      const resolved = await resolveCliChangeSource(
        {
          workspace,
          selector: selector(PULL),
          limits: {
            environment: { GITHUB_TOKEN: token, GH_TOKEN: token },
            hostFile: null,
          },
          forge: {
            commands: {
              run: async () => ({ stdout: "", stderr: "" }),
            } as never,
            environment: { GITHUB_TOKEN: token },
          },
        },
        {
          "github-pull-request": (input) =>
            resolveGithubChangeSource({
              selector: input.selector as GithubChangeSourceSelectorV1,
              fetch: fake.fetch,
              ...(input.limits ? { limits: input.limits } : {}),
            }),
        },
      );
      expect(resolved.changeSource.revision.repository.kind).toBe("github-repository");
      expect(fake.requests.length).toBeGreaterThan(0);
      for (const request of fake.requests) {
        expect(Object.keys(request.headers).map((key) => key.toLowerCase())).not.toContain(
          "authorization",
        );
        expect(JSON.stringify(request.headers)).not.toContain(token.slice(4));
        expect(request.redirect).toBe("manual");
        expect(request.url.startsWith(`${API}/`)).toBe(true);
      }
    },
    testTimeoutMs(60_000),
  );

  it(
    "follows a same-origin redirect for a renamed repository, and refuses a cross-host one",
    async () => {
      const { fake } = await openPullFixture();
      const original = `/repos/${OWNER}/${NAME}/pulls/7`;
      const record = await (await fake.fetch(`${API}${original}`, {})).json();
      fake.body(
        `/repos/${OWNER}/old-name/pulls/7`,
        {},
        {
          status: 301,
          headers: { location: `${API}/repositories/${REPOSITORY_ID}/pulls/7` },
        },
      );
      fake.body(`/repositories/${REPOSITORY_ID}/pulls/7`, record);
      const renamed = await resolve(fake, `https://github.com/${OWNER}/old-name/pull/7`);
      expect(renamed.changeSource.revision.repository.kind).toBe("github-repository");

      for (const location of [
        "https://evil.example.test/repositories/1/pulls/7",
        "http://api.github.com/repositories/1/pulls/7",
        "https://user:pass@api.github.com/repositories/1/pulls/7",
      ]) {
        fake.body(`/repos/${OWNER}/old-name/pulls/7`, {}, { status: 302, headers: { location } });
        expect(
          await codeOf(resolve(fake, `https://github.com/${OWNER}/old-name/pull/7`)),
          location,
        ).toBe("change-source-github-redirect-cross-host");
      }
      expect(fake.requests.some((request) => !request.url.startsWith(`${API}/`))).toBe(false);
    },
    testTimeoutMs(60_000),
  );

  it(
    "refuses one redirect past changeSourcesGithub.redirectsMax",
    async () => {
      const { fake } = await openPullFixture();
      const record = await (await fake.fetch(`${API}/repos/${OWNER}/${NAME}/pulls/7`, {})).json();
      fake.body(
        `/repos/${OWNER}/a/pulls/7`,
        {},
        { status: 301, headers: { location: `/repos/${OWNER}/b/pulls/7` } },
      );
      fake.body(
        `/repos/${OWNER}/b/pulls/7`,
        {},
        {
          status: 301,
          headers: { location: `/repos/${OWNER}/${NAME}/pulls/7` },
        },
      );
      fake.body(`/repos/${OWNER}/${NAME}/pulls/7`, record);
      const url = `https://github.com/${OWNER}/a/pull/7`;
      expect(
        (
          await resolve(fake, url, {
            DOCSFAB_CHANGE_SOURCES_GITHUB_REDIRECTS_MAX: "2",
          })
        ).changeSource,
      ).toBeDefined();
      const error = await resolve(fake, url, {
        DOCSFAB_CHANGE_SOURCES_GITHUB_REDIRECTS_MAX: "1",
      }).catch((caught: unknown) => caught);
      expect(error).toMatchObject({
        code: "change-source-github-redirects-bound",
        observed: 2,
        configured: 1,
      });
    },
    testTimeoutMs(60_000),
  );

  it("classes the rate limit, other refusals of access, and a missing repository apart", async () => {
    const reset = 1_790_000_000;
    const answer = async (status: number, headers: Record<string, string>) => {
      const fake = new FakeGithub("unused");
      fake.body(`/repos/${OWNER}/${NAME}/pulls/7`, { message: "denied" }, { status, headers });
      const error = await resolve(fake, PULL).catch((caught: unknown) => caught);
      return error as ChangeSourceError;
    };
    const primary = await answer(403, {
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": String(reset),
    });
    expect(primary.code).toBe("change-source-github-rate-limited");
    expect(primary.detail).toBe(`resets at ${new Date(reset * 1000).toISOString()}`);
    expect((await answer(429, {})).code).toBe("change-source-github-rate-limited");
    expect(
      (
        await answer(403, {
          "retry-after": "60",
          "x-ratelimit-remaining": "12",
        })
      ).code,
    ).toBe("change-source-github-rate-limited");
    const forbidden = await answer(403, { "x-ratelimit-remaining": "41" });
    expect(forbidden.code).toBe("change-source-github-forbidden");
    expect(forbidden.message).not.toContain("reset");
    expect((await answer(404, { "x-ratelimit-remaining": "41" })).code).toBe(
      "change-source-github-not-found",
    );
    const failed = await answer(502, {});
    expect(failed.code).toBe("change-source-github-request-failed");
    expect(failed.detail).toBe("HTTP 502");
  });

  it("refuses a body one byte past changeSourcesGithub.responseMaxBytes and admits one exactly at it", async () => {
    const bound = 65_536;
    const sized = (bytes: number) => {
      const fake = new FakeGithub("unused");
      const body = JSON.stringify({ message: "padding" });
      fake.route(
        `/repos/${OWNER}/${NAME}`,
        () => new Response(body + " ".repeat(bytes - body.length), { status: 200 }),
      );
      return fake;
    };
    const environment = {
      DOCSFAB_CHANGE_SOURCES_GITHUB_RESPONSE_MAX_BYTES: String(bound),
    };
    const url = `https://github.com/${OWNER}/${NAME}/commit/abcdef1`;
    // Exactly at the bound the body is read and judged on its content.
    expect(await codeOf(resolve(sized(bound), url, environment))).toBe(
      "change-source-github-response-invalid",
    );
    const over = await resolve(sized(bound + 1), url, environment).catch(
      (caught: unknown) => caught,
    );
    expect(over).toMatchObject({
      code: "change-source-github-response-bound",
      observed: bound + 1,
      configured: bound,
    });
  });

  it("refuses an unreachable GitHub with the proxy remediation, and rethrows the caller's own abort", async () => {
    const unreachable: typeof fetch = async () => {
      throw new TypeError("fetch failed");
    };
    const refused = await resolveGithubChangeSource({
      selector: selector(PULL),
      fetch: unreachable,
      limits: NO_HOST_FILE,
    }).catch((caught: unknown) => caught);
    expect(refused).toMatchObject({ code: "change-source-github-unreachable" });
    expect((refused as Error).message).toContain("NODE_USE_ENV_PROXY=1");

    const controller = new AbortController();
    const hanging: typeof fetch = (_url, init) =>
      new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      });
    const pending = resolveGithubChangeSource({
      selector: selector(PULL),
      fetch: hanging,
      signal: controller.signal,
      limits: NO_HOST_FILE,
    }).catch((caught: unknown) => caught);
    controller.abort(new Error("operator cancelled"));
    const aborted = await pending;
    expect(aborted).not.toBeInstanceOf(ChangeSourceError);
    expect(aborted).not.toBeInstanceOf(OperationalLimitError);
    expect((aborted as Error).message).toBe("operator cancelled");
  });

  it(
    "refuses a request past changeSourcesGithub.requestTimeoutMs with the elapsed time",
    async () => {
      const hanging: typeof fetch = (_url, init) =>
        new Promise((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
        });
      const error = await resolveGithubChangeSource({
        selector: selector(PULL),
        fetch: hanging,
        limits: limits({
          DOCSFAB_CHANGE_SOURCES_GITHUB_REQUEST_TIMEOUT_MS: "1000",
        }),
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(OperationalLimitError);
      expect(error).toMatchObject({
        code: "change-source-github-timeout-bound",
        configured: 1000,
      });
      expect((error as OperationalLimitError).observed).toBeGreaterThanOrEqual(1000);
    },
    testTimeoutMs(30_000),
  );

  it("refuses a body that is not JSON, and a record missing a field, naming the field", async () => {
    const fake = new FakeGithub("unused");
    fake.route(`/repos/${OWNER}/${NAME}/pulls/7`, () => new Response("<html>", { status: 200 }));
    const notJson = (await resolve(fake, PULL).catch(
      (caught: unknown) => caught,
    )) as ChangeSourceError;
    expect([notJson.code, notJson.detail]).toEqual([
      "change-source-github-response-invalid",
      "response body",
    ]);
    fake.body(`/repos/${OWNER}/${NAME}/pulls/7`, {
      number: 7,
      state: "open",
      merged: false,
    });
    const missing = (await resolve(fake, PULL).catch(
      (caught: unknown) => caught,
    )) as ChangeSourceError;
    expect([missing.code, missing.detail]).toEqual([
      "change-source-github-response-invalid",
      "pull request base",
    ]);
  });
});

describe("encoding and credentials in forge text (row 11)", () => {
  it(
    "refuses a patch with text that has no UTF-8 form, and a configured credential in a patch",
    async () => {
      const { fake, head, baseNow } = await openPullFixture();
      const path = `/repositories/${REPOSITORY_ID}/compare/${baseNow}...${head}?per_page=100`;
      const whole = await fake.compareJson(baseNow, head);
      const withPatch = (patch: string) => ({
        ...whole,
        files: whole.files.map((file) =>
          file.filename === "src/flags.ts" ? { ...file, patch } : file,
        ),
      });
      fake.route(
        path,
        () =>
          new Response(JSON.stringify(withPatch("@@ -0,0 +1 @@\n+X")).replace("+X", "+\\ud800"), {
            status: 200,
          }),
      );
      expect(await codeOf(resolve(fake, PULL))).toBe("change-source-encoding-unsupported");

      const credential = configureCredential(["glpat", "Hq4Lr8Sw2Tz6Uv1Wx5Ya9Bc3"].join("-"));
      fake.body(path, withPatch(`@@ -0,0 +1 @@\n+export const token = "${credential}";`));
      expect(await codeOf(resolve(fake, PULL))).toBe("change-source-credential-present");

      // Credential-shaped text that is not a configured credential is content.
      fake.body(
        path,
        withPatch(
          `@@ -0,0 +1 @@\n+export const example = "${["glpat", "Ex4mple0Ex4mple0Ex4mple0"].join("-")}";`,
        ),
      );
      expect((await resolve(fake, PULL)).changeSource.files).toHaveLength(6);

      // An empty patch on a file whose content changed is a patch GitHub left out.
      fake.body(path, withPatch(""));
      const flags = (await resolve(fake, PULL)).changeSource.files.find(
        (file) => file.newPath === "src/flags.ts",
      )!;
      expect(flags.diffOmitted).toEqual({
        code: "change-source-file-diff-omitted",
        basis: "forge-omitted",
        forgeReason: "no-patch",
      });
    },
    testTimeoutMs(60_000),
  );
});

describe("GitHub producer and binding", () => {
  it(
    "mints both observations under the pull request kind's own producer id",
    async () => {
      const { fake } = await openPullFixture();
      const resolved = await resolve(fake, PULL);
      const docs = await initChangeRepository(await roots.create("docsfab-gh-docs-"), {
        "docs/a.md": "# A\n",
      });
      await commitFiles(docs.repository, { "docs/b.md": "# B\n" }, "second");
      const workspace = await prepareRepositoryWorkspace(docs.repository, "HEAD");
      try {
        const evidence = await resolveCliChangeSourceEvidence({
          workspace,
          resolved,
          admittedRequest: {
            workflow: "update-documentation",
            allowWrite: false,
          },
          runId: "github-change-source-producer",
        });
        expect(evidence.acquired.producerScopes.map((scope) => scope.producerId)).toEqual([
          "change-source-github-pull-request",
        ]);
        expect(evidence.acquired.acquired.map((entry) => entry.observation.producerId)).toEqual([
          "change-source-github-pull-request",
          "change-source-github-pull-request",
        ]);
        expect(evidence.acquired.binding.requiredObservationIds).toHaveLength(2);
      } finally {
        await workspace.dispose();
      }
      const decoded: ChangeSourceV1 = decodeChangeSourceV1(
        JSON.parse(Buffer.from(resolved.manifestBytes).toString("utf8")),
      );
      expect(decoded.changeSourceSha256).toBe(resolved.changeSource.changeSourceSha256);
    },
    testTimeoutMs(60_000),
  );
});
