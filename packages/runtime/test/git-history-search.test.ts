// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * docsfab_history_search through the confined tool set the planner and writer
 * receive: a literal string matched by git's pickaxe over windows of the
 * pinned history, the exclusion invariant (a match only in a credential-
 * bearing, generated or undecodable file leaves no trace), shallow cuts, the
 * partial-clone refusal, paging, cursors, repository configuration, and the
 * citation each served page records.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { limitDefinition } from "../src/config/limits.js";
import { runTrustedGit, TrustedGitError } from "../src/host-invoker/trusted-git.js";
import type { GitRunner } from "../src/repository/git-history.js";
import { configureCredential } from "./helpers/configured-credential.js";
import {
  cloneFixture,
  commitFiles,
  FIXTURE_GIT_ENVIRONMENT,
  fixtureGit,
  historyFixture,
  historyTools,
  lazyFetchingGit,
  refusalCode,
  sha256,
  type ToolPage,
} from "./helpers/git-history-fixture.js";
import { plantedCredentialValue } from "./helpers/planted-credential.js";
import { temporaryRoots } from "./helpers/temp.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";

const roots = temporaryRoots();
const SEARCH = "docsfab_history_search";
const NEEDLE_MAX_BYTES = limitDefinition("gitHistory.searchNeedleMaxBytes");
const SCAN_BOUND = limitDefinition("gitHistory.pickaxeMaxCommitsScanned");
const RESPONSE_BOUND = limitDefinition("gitHistory.responseMaxBytes");
/** Fixture repositories and many git calls; raised on a loaded CI runner. */
const SEARCH_TEST_TIMEOUT_MS = testTimeoutMs(60_000);
/** A SHA-256 object name in hex, longer than the fixtures' SHA-1 ids. */
const SHA256_ID_HEX = 64;
/** A string no fixture file holds. */
const NOWHERE = "zzNeedleFoundNowhere";

interface SearchMatch {
  readonly commit: string;
  readonly parents: string[];
  readonly committedAt: string;
  readonly subject: string | null;
  readonly subjectWithheld?: true;
  readonly paths: Array<string | null>;
  readonly atShallowCut?: true;
}

type SearchPage = ToolPage & {
  readonly scanRange: { start: number; end: number };
  readonly matches: SearchMatch[];
};

/** A git runner that keeps every argument list it is given. */
function recordingGit(calls: string[][], inner: GitRunner = trusted): GitRunner {
  return (cwd, args, maximumBytes, input) => {
    calls.push([...args]);
    return inner(cwd, args, maximumBytes, input);
  };
}

const trusted: GitRunner = (cwd, args, maximumBytes, input) =>
  runTrustedGit(cwd, args, undefined, maximumBytes, input);

/** The calls of one kind among the recorded ones: the walk, the name list, or the search. */
const isWalk = (args: readonly string[]) =>
  args.includes("rev-list") && args.some((arg) => arg.startsWith("--skip="));
const isNameList = (args: readonly string[]) => args.includes("diff-tree");
const isPickaxe = (args: readonly string[]) => args.includes("--no-walk=unsorted");

/** Commit with an explicit date, so the walk's date order is the test's to choose. */
async function commitAt(
  repository: string,
  files: Record<string, string>,
  message: string,
  date: string,
): Promise<string> {
  for (const [path, content] of Object.entries(files)) {
    await writeFile(join(repository, path), content);
  }
  await fixtureGit(repository, ["add", "-A"]);
  await gitWithInput(repository, ["commit", "--quiet", "--allow-empty", "-m", message], undefined, {
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
  });
  return fixtureGit(repository, ["rev-parse", "HEAD"]);
}

function gitWithInput(
  cwd: string,
  args: readonly string[],
  input?: Buffer,
  environment: NodeJS.ProcessEnv = {},
  executable = "/usr/bin/git",
  onStdinError?: (error: NodeJS.ErrnoException) => void,
  stdinErrorForTest?: NodeJS.ErrnoException,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      executable,
      [...args],
      { cwd, env: { ...FIXTURE_GIT_ENVIRONMENT, ...environment } },
      (error, stdout) => (error ? reject(error) : resolve(stdout.trim())),
    );
    if (child.stdin) {
      // An early child exit can close its pipe before Node flushes input. The
      // execFile callback remains the authority for the process result; handle
      // EPIPE here so it cannot become an unhandled stream error.
      child.stdin.on("error", (error: NodeJS.ErrnoException) => {
        onStdinError?.(error);
        if (error.code !== "EPIPE") reject(error);
      });
      if (stdinErrorForTest) child.stdin.emit("error", stdinErrorForTest);
      if (input === undefined) child.stdin.end();
      else child.stdin.end(input);
    }
  });
}

/**
 * Commit files whose names are raw bytes, such as a name that is not UTF-8,
 * through the index alone: some file systems refuse such a name.
 */
async function commitRawNames(
  repository: string,
  entries: ReadonlyArray<readonly [Buffer, string]>,
  message: string,
): Promise<string> {
  const lines: Buffer[] = [];
  for (const [name, content] of entries) {
    const blob = await fixtureGit(repository, ["hash-object", "-w", "--stdin"], content);
    lines.push(Buffer.from(`100644 ${blob}\t`, "utf8"), name, Buffer.from([0]));
  }
  await gitWithInput(repository, ["update-index", "-z", "--index-info"], Buffer.concat(lines));
  await fixtureGit(repository, ["commit", "--quiet", "-m", message]);
  return fixtureGit(repository, ["rev-parse", "HEAD"]);
}

const commits = (page: SearchPage) => page.matches.map((match) => match.commit);

/** A page with each cursor handle reduced to whether there is one. */
function shape(page: SearchPage) {
  return { ...page, nextCursor: page.nextCursor !== null };
}

describe("docsfab_history_search", { timeout: SEARCH_TEST_TIMEOUT_MS }, () => {
  it("does not write empty input when none is supplied", async () => {
    await expect(gitWithInput(process.cwd(), ["--version"])).resolves.toMatch(/^git version /u);
  });

  it("keeps an early child exit's process result authoritative over stdin EPIPE", async () => {
    const stdinErrors: NodeJS.ErrnoException[] = [];
    const result = await gitWithInput(
      process.cwd(),
      [],
      Buffer.alloc(1_048_576),
      {},
      "/usr/bin/true",
      (error) => stdinErrors.push(error),
    );
    expect(result).toBe("");
    expect(stdinErrors.map((error) => error.code)).toContain("EPIPE");
  });

  it("keeps execFile's nonzero exit authoritative when stdin closes early", async () => {
    const stdinErrors: NodeJS.ErrnoException[] = [];
    await expect(
      gitWithInput(process.cwd(), [], Buffer.alloc(1_048_576), {}, "/usr/bin/false", (error) =>
        stdinErrors.push(error),
      ),
    ).rejects.toMatchObject({ code: 1 });
    expect(stdinErrors.map((error) => error.code)).toContain("EPIPE");
  });

  it("rejects stdin failures other than EPIPE", async () => {
    const stdinError = Object.assign(new Error("stdin failed"), { code: "EIO" });
    const stdinErrors: NodeJS.ErrnoException[] = [];
    await expect(
      gitWithInput(
        process.cwd(),
        ["--version"],
        undefined,
        {},
        "/usr/bin/git",
        (error) => stdinErrors.push(error),
        stdinError,
      ),
    ).rejects.toMatchObject({ code: "EIO", message: "stdin failed" });
    expect(stdinErrors).toEqual([stdinError]);
  });

  it("finds the commits that added and removed a string, newest first, and cites the page", async () => {
    const fixture = await historyFixture(roots);
    const added = await commitFiles(
      fixture.repository,
      { "src/widget.ts": "export function widgetFactory() {}\n" },
      "Add the widget factory",
    );
    await commitFiles(fixture.repository, { "docs/guide.md": "# Guide\n\nUnrelated.\n" }, "Docs");
    const removed = await commitFiles(
      fixture.repository,
      { "src/widget.ts": "export function makeWidget() {}\n" },
      "Rename the widget factory",
    );
    const { text, toolSet } = await historyTools(fixture.repository, removed);

    const raw = await text(SEARCH, { needle: "widgetFactory" });
    const page = JSON.parse(raw) as SearchPage;
    expect(page).toEqual({
      kind: "docsfab-history-search",
      range: { from: null, to: removed },
      paths: [],
      scanRange: { start: 0, end: 5 },
      // The fixture's second commit adds a credential-bearing file.
      labels: ["history-paths-excluded"],
      nextCursor: null,
      matches: [
        {
          commit: removed,
          parents: [expect.any(String)],
          committedAt: expect.any(String),
          subject: "Rename the widget factory",
          paths: ["src/widget.ts"],
        },
        {
          commit: added,
          parents: [fixture.head],
          committedAt: expect.any(String),
          subject: "Add the widget factory",
          paths: ["src/widget.ts"],
        },
      ],
    });
    expect(raw).not.toContain("widgetFactory");
    expect(toolSet.getHistoryReads()).toEqual([
      {
        tool: SEARCH,
        revisions: [removed],
        paths: [],
        ranges: [{ path: null, unit: "entries", start: 0, end: 5 }],
        labels: ["history-paths-excluded"],
        matchedCommits: [removed, added],
        sha256: sha256(raw),
      },
    ]);
    // The needle reaches no citation.
    expect(JSON.stringify(toolSet.getHistoryReads())).not.toContain("widgetFactory");
    // A range: only the commits after the one that added it.
    const ranged = (await (
      await historyTools(fixture.repository, removed)
    ).call(SEARCH, {
      needle: "widgetFactory",
      range: { from: added },
    })) as SearchPage;
    expect(commits(ranged)).toEqual([removed]);
    expect(ranged.scanRange).toEqual({ start: 0, end: 2 });
    // A range that holds no commit scans nothing and never runs the search.
    const calls: string[][] = [];
    const empty = await historyTools(fixture.repository, removed, { git: recordingGit(calls) });
    const none = (await empty.call(SEARCH, {
      needle: "widgetFactory",
      range: { from: "head" },
    })) as SearchPage;
    expect(none).toMatchObject({ scanRange: { start: 0, end: 0 }, matches: [], nextCursor: null });
    expect(none.labels).toEqual([]);
    expect(calls.filter(isWalk)).toHaveLength(1);
    expect(calls.filter((args) => isNameList(args) || isPickaxe(args))).toEqual([]);
    expect(empty.toolSet.getHistoryReads()![0]!.matchedCommits).toEqual([]);
  });

  it("matches the needle literally: never an option, pathspec, revision or pattern", async () => {
    const fixture = await historyFixture(roots);
    const literal = await commitFiles(
      fixture.repository,
      { "notes.txt": "flags -p and HEAD, the pattern .* and :(glob)*\n" },
      "Literal strings",
    );
    const abc = await commitFiles(fixture.repository, { "abc.txt": "abc\n" }, "Plain abc");
    const marker = join(fixture.root, "written");
    const calls: string[][] = [];
    const { call } = await historyTools(fixture.repository, abc, { git: recordingGit(calls) });

    for (const needle of ["-p", "HEAD", ".*", ":(glob)*"]) {
      const page = (await call(SEARCH, { needle })) as SearchPage;
      expect(commits(page), needle).toEqual([literal]);
      expect(page.matches[0]!.paths).toEqual(["notes.txt"]);
    }
    // An option-shaped needle writes nothing and matches nothing.
    const option = (await call(SEARCH, { needle: `--output=${marker}` })) as SearchPage;
    expect(option.matches).toEqual([]);
    expect(existsSync(marker)).toBe(false);
    // Not a regular expression: "a.c" does not match "abc", and "abc" does.
    expect(commits((await call(SEARCH, { needle: "a.c" })) as SearchPage)).toEqual([]);
    expect(commits((await call(SEARCH, { needle: "abc" })) as SearchPage)).toEqual([abc]);
    // One argument, `-S` then the needle, and never a regex or all-pairs switch.
    const searches = calls.filter(isPickaxe);
    expect(searches.length).toBeGreaterThan(0);
    for (const args of searches) {
      expect(args.filter((arg) => arg.startsWith("-S"))).toHaveLength(1);
      expect(args).not.toContain("--pickaxe-regex");
      expect(args).not.toContain("--pickaxe-all");
      expect(args.some((arg) => arg.startsWith("-G"))).toBe(false);
      expect(args).toContain("--diff-merges=off");
    }
  });

  it("refuses an empty, NUL-bearing, lone-surrogate or non-string needle before git runs", async () => {
    const fixture = await historyFixture(roots);
    const calls: string[][] = [];
    const { refusal, call, categories } = await historyTools(fixture.repository, fixture.head, {
      git: recordingGit(calls),
    });
    for (const needle of ["", "a\0b", "lone \ud800 surrogate", 7, null]) {
      expect(refusalCode(await refusal(SEARCH, { needle })), JSON.stringify(needle)).toBe(
        "history-arguments-invalid",
      );
    }
    expect(refusalCode(await refusal(SEARCH, {}))).toBe("history-arguments-invalid");
    expect(calls).toEqual([]);
    expect(categories()).toEqual({ "malformed-arguments": 6 });
    // Adjacent: a paired surrogate is one valid code point and is searched.
    const page = (await call(SEARCH, { needle: "emoji 😀" })) as SearchPage;
    expect(page.matches).toEqual([]);
    expect(calls.filter(isPickaxe)).toHaveLength(1);
  });

  it("refuses range ends that are not commits of the pinned history", async () => {
    const fixture = await historyFixture(roots);
    await fixtureGit(fixture.repository, ["tag", "-a", "-m", "Base", "v1", fixture.base]);
    const tag = await fixtureGit(fixture.repository, ["rev-parse", "v1"]);
    await fixtureGit(fixture.repository, ["checkout", "--quiet", "-b", "side", fixture.base]);
    const side = await commitFiles(fixture.repository, { "side.txt": "answer\n" }, "Side");
    await fixtureGit(fixture.repository, ["checkout", "--quiet", "main"]);
    const { refusal, call } = await historyTools(fixture.repository, fixture.head);

    for (const [to, code] of [
      // Longer than this repository's commit ids: a SHA-256 length in a SHA-1 repository.
      ["a".repeat(SHA256_ID_HEX), "history-revision-invalid"],
      [tag, "history-revision-invalid"],
      ["HEAD@{1}", "history-revision-invalid"],
      ["HEAD", "history-revision-invalid"],
      [side, "history-revision-out-of-scope"],
    ] as const) {
      expect(refusalCode(await refusal(SEARCH, { needle: "answer", range: { to } })), to).toBe(
        code,
      );
    }
    expect(refusalCode(await refusal(SEARCH, { needle: "answer", range: { from: side } }))).toBe(
      "history-revision-out-of-scope",
    );
    // Control: the ancestor itself.
    expect(
      commits(
        (await call(SEARCH, { needle: "answer", range: { to: fixture.base } })) as SearchPage,
      ),
    ).toEqual([fixture.base]);
  });

  it("parses a matched name that spells a record header or starts with a line feed as a name", async () => {
    const fixture = await historyFixture(roots);
    // A name holding unit separators around a full id, as a header would.
    const forged = `${fixture.base}\x1f\x1f2026-01-01T00:00:00+00:00\x1fforged`;
    const leading = "\nleading.md";
    const head = await commitFiles(
      fixture.repository,
      { [forged]: "needleInName\n", [leading]: "needleInName\n" },
      "Odd names",
    );
    const { call } = await historyTools(fixture.repository, head);
    const page = (await call(SEARCH, { needle: "needleInName" })) as SearchPage;
    expect(page.matches).toEqual([
      expect.objectContaining({ commit: head, paths: [leading, forged].sort() }),
    ]);
  });

  it("refuses a search output whose records are reordered or name a commit outside the window", async () => {
    const fixture = await historyFixture(roots);
    const first = await commitFiles(fixture.repository, { "a.txt": "reorder\n" }, "First");
    const second = await commitFiles(fixture.repository, { "b.txt": "reorder\n" }, "Second");
    const tamper =
      (edit: (output: Buffer) => Buffer): GitRunner =>
      async (cwd, args, maximumBytes, input) => {
        const output = await trusted(cwd, args, maximumBytes, input);
        return isPickaxe(args) ? edit(output) : output;
      };
    const records = (output: Buffer) => output.toString("latin1").slice(1, -1).split("\0\0");
    const reordered = tamper((output) => {
      const [newer, older] = records(output);
      return Buffer.from(`\0${older}\0\0${newer}\0`, "latin1");
    });
    // The first commit's own header, not the second's parent field.
    const foreign = tamper((output) =>
      Buffer.from(
        output.toString("latin1").replace(`\0${first}\x1f`, `\0${"f".repeat(first.length)}\x1f`),
        "latin1",
      ),
    );
    const duplicated = tamper((output) => {
      const [newer] = records(output);
      return Buffer.from(`\0${newer}\0\0${newer}\0`, "latin1");
    });
    for (const [label, git] of [
      ["reordered", reordered],
      ["foreign", foreign],
      ["duplicated", duplicated],
    ] as const) {
      const tools = await historyTools(fixture.repository, second, { git });
      expect(refusalCode(await tools.refusal(SEARCH, { needle: "reorder" })), label).toBe(
        "history-git-failed",
      );
      expect(tools.categories(), label).toEqual({ "tool-defect": 1 });
    }
    // Control: the same output untouched is served in the window's order.
    const plain = await historyTools(fixture.repository, second, {
      git: tamper((output) => output),
    });
    expect(commits((await plain.call(SEARCH, { needle: "reorder" })) as SearchPage)).toEqual([
      second,
      first,
    ]);
  });
});

describe("search exclusion invariant", { timeout: SEARCH_TEST_TIMEOUT_MS }, () => {
  /** The page and citation for `needle`, beside those for a needle found nowhere. */
  async function compare(
    repository: string,
    head: string,
    needle: string,
    parameters: Record<string, unknown> = {},
    environment?: NodeJS.ProcessEnv,
  ) {
    const read = async (value: string) => {
      const tools = await historyTools(repository, head, environment ? { environment } : {});
      const pages: SearchPage[] = [];
      let page = JSON.parse(
        await tools.text(SEARCH, { needle: value, ...parameters }),
      ) as SearchPage;
      pages.push(page);
      while (page.nextCursor !== null) {
        page = (await tools.call(SEARCH, { cursor: page.nextCursor })) as SearchPage;
        pages.push(page);
      }
      const citations = tools.toolSet.getHistoryReads()!;
      return { pages, citations };
    };
    return { found: await read(needle), nowhere: await read(NOWHERE) };
  }

  it("serves the same page and citation for a needle only in a credential file as for one found nowhere", async () => {
    const fixture = await historyFixture(roots);
    const head = await commitFiles(
      fixture.repository,
      { ".env": "SECRET_NAME_ONLY_HERE=1\n", "docs/a.md": "public\n" },
      "Configure",
    );
    const { found, nowhere } = await compare(fixture.repository, head, "SECRET_NAME_ONLY_HERE");
    // No cursor on either side, so the bytes, and so the digests, are equal.
    expect(found).toEqual(nowhere);
    expect(found.pages[0]!.labels).toEqual(["history-paths-excluded"]);
    expect(found.citations[0]!.matchedCommits).toEqual([]);
    // Window by window, cursors compared as present or absent.
    const windowed = await compare(
      fixture.repository,
      head,
      "SECRET_NAME_ONLY_HERE",
      {},
      { DOCSFAB_GIT_HISTORY_PICKAXE_MAX_COMMITS_SCANNED: String(SCAN_BOUND.min) },
    );
    expect(windowed.found.pages.length).toBeGreaterThan(1);
    expect(windowed.found.pages.map(shape)).toEqual(windowed.nowhere.pages.map(shape));
    const unhandled = (citations: typeof windowed.found.citations) =>
      citations.map(({ sha256: _digest, cursor, nextCursor, ...rest }) => ({
        ...rest,
        cursor: cursor !== undefined,
        nextCursor: nextCursor !== undefined,
      }));
    expect(unhandled(windowed.found.citations)).toEqual(unhandled(windowed.nowhere.citations));
    // Positive control: a needle in a served file changes the page.
    const control = await compare(fixture.repository, head, "public");
    expect(control.found.pages[0]!.matches.map((match) => match.paths)).toEqual([["docs/a.md"]]);
    expect(control.found).not.toEqual(control.nowhere);
  });

  it("serves only the admitted file of a commit that matches it and a credential file", async () => {
    const fixture = await historyFixture(roots);
    const head = await commitFiles(
      fixture.repository,
      { ".env": "BOTH_PLACES=1\n", "docs/a.md": "BOTH_PLACES\n" },
      "Both",
    );
    const { call } = await historyTools(fixture.repository, head);
    const page = (await call(SEARCH, { needle: "BOTH_PLACES" })) as SearchPage;
    expect(page.matches).toEqual([expect.objectContaining({ commit: head, paths: ["docs/a.md"] })]);
  });

  it("drops a credential file under a directory that was a file, under a directory path", async () => {
    const fixture = await historyFixture(roots);
    await commitFiles(fixture.repository, { cfg: "plain\n" }, "A file named cfg");
    await fixtureGit(fixture.repository, ["rm", "--quiet", "cfg"]);
    const head = await commitFiles(
      fixture.repository,
      { "cfg/.env": "SWAPPED_SECRET=1\n" },
      "cfg becomes a directory",
    );
    const { found, nowhere } = await compare(fixture.repository, head, "SWAPPED_SECRET", {
      paths: ["cfg"],
    });
    expect(found).toEqual(nowhere);
    expect(found.pages[0]!.labels).toEqual(["history-paths-excluded"]);
    // Control: the same swap with a served file name is found.
    const served = await commitFiles(
      fixture.repository,
      { "cfg/settings.md": "SWAPPED_SECRET\n" },
      "Doc",
    );
    const { call } = await historyTools(fixture.repository, served);
    expect(
      commits((await call(SEARCH, { needle: "SWAPPED_SECRET", paths: ["cfg"] })) as SearchPage),
    ).toEqual([served]);
  });

  it("drops a name that is not UTF-8 as excluded, never as a withheld entry", async () => {
    const fixture = await historyFixture(roots);
    const head = await commitRawNames(
      fixture.repository,
      [
        [Buffer.concat([Buffer.from([0xff]), Buffer.from("/.env")]), "UNDECODABLE_DIR_SECRET\n"],
        [Buffer.concat([Buffer.from([0xff]), Buffer.from(".md")]), "UNDECODABLE_NAME_ONLY\n"],
        [Buffer.from("docs/plain.md"), "DECODABLE_CONTROL\n"],
      ],
      "Raw names",
    );
    for (const needle of ["UNDECODABLE_DIR_SECRET", "UNDECODABLE_NAME_ONLY"]) {
      const { found, nowhere } = await compare(fixture.repository, head, needle);
      expect(found, needle).toEqual(nowhere);
      expect(found.pages[0]!.labels).toEqual(["history-paths-excluded"]);
    }
    // Control: a decodable name in the same commit is found.
    const { call } = await historyTools(fixture.repository, head);
    expect(((await call(SEARCH, { needle: "DECODABLE_CONTROL" })) as SearchPage).matches).toEqual([
      expect.objectContaining({ commit: head, paths: ["docs/plain.md"] }),
    ]);
  });

  it("labels excluded paths from the requested paths only", async () => {
    // The fixture's head changes docs, code and a credential file outside docs.
    const fixture = await historyFixture(roots);
    const { call } = await historyTools(fixture.repository, fixture.head);
    const scoped = (await call(SEARCH, { needle: "answer", paths: ["docs"] })) as SearchPage;
    expect(scoped.labels).toEqual([]);
    expect(commits(scoped)).toEqual([fixture.base]);
    // Control: the same window without paths carries the label.
    expect(((await call(SEARCH, { needle: "answer" })) as SearchPage).labels).toEqual([
      "history-paths-excluded",
    ]);
  });
});

describe("search under repository configuration", { timeout: SEARCH_TEST_TIMEOUT_MS }, () => {
  it("finds a root match, lists a rename as two names, runs no program and serves only requested paths", async () => {
    const fixture = await historyFixture(roots);
    const marker = join(fixture.root, "ran");
    const program = join(fixture.root, "program.sh");
    await writeFile(program, `#!/bin/sh\necho ran >> "${marker}"\n`, { mode: 0o755 });
    await fixtureGit(fixture.repository, ["mv", "src/app.ts", "src/renamed.ts"]);
    const renamed = await commitFiles(fixture.repository, {}, "Rename the app");
    const tree = await fixtureGit(fixture.repository, ["rev-parse", "HEAD^{tree}"]);
    const identity = "Fixture <fixture@example.invalid> 1790000000 +0000";
    const signed = await fixtureGit(
      fixture.repository,
      ["hash-object", "-t", "commit", "-w", "--stdin"],
      `tree ${tree}\nparent ${renamed}\nauthor ${identity}\ncommitter ${identity}\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n -----END PGP SIGNATURE-----\n\nSigned head\n`,
    );
    await fixtureGit(fixture.repository, ["update-ref", "refs/heads/main", signed]);
    for (const [key, value] of [
      ["log.showRoot", "false"],
      ["diff.renames", "copies"],
      ["log.showSignature", "true"],
      ["gpg.program", program],
      ["diff.noprefix", "true"],
      ["log.diffMerges", "first-parent"],
      ["core.pager", program],
    ] as const) {
      await fixtureGit(fixture.repository, ["config", key, value]);
    }
    const { call } = await historyTools(fixture.repository, signed);

    const page = (await call(SEARCH, { needle: "export const answer" })) as SearchPage;
    expect(page.matches.map((match) => [match.commit, match.paths])).toEqual([
      [renamed, ["src/app.ts", "src/renamed.ts"]],
      [fixture.base, ["src/app.ts"]],
    ]);
    expect(existsSync(marker)).toBe(false);
    // A match outside the requested paths is not served.
    const scoped = (await call(SEARCH, {
      needle: "export const answer",
      paths: ["docs"],
    })) as SearchPage;
    expect(scoped.matches).toEqual([]);
    const guide = (await call(SEARCH, { needle: "The answer is", paths: ["docs"] })) as SearchPage;
    expect(guide.matches.map((match) => match.paths)).toEqual([["docs/guide.md"]]);
    // Positive control: plain git with this configuration hides the root and pairs the rename.
    const plain = await gitWithInput(fixture.repository, [
      "-c",
      "log.showSignature=false",
      "log",
      "--format=%H",
      "--name-only",
      "-Sexport const answer",
    ]);
    expect(plain).not.toContain(fixture.base);
    expect(plain).not.toContain(renamed);
  });
});

describe("search windows, pages and cursors", { timeout: SEARCH_TEST_TIMEOUT_MS }, () => {
  it("scans exactly a window, then continues past a window with no match", async () => {
    const fixture = await historyFixture(roots);
    const window = SCAN_BOUND.min + 2;
    const environment = { DOCSFAB_GIT_HISTORY_PICKAXE_MAX_COMMITS_SCANNED: String(window) };
    // Only the root commit changes the needle's count; the history grows to exactly one window.
    let head = fixture.head;
    for (let index = 2; index < window; index += 1) {
      head = await commitFiles(
        fixture.repository,
        { "src/app.ts": `${String(index)}\n` },
        `Step ${String(index)}`,
      );
    }
    const exact = await historyTools(fixture.repository, head, { environment });
    const whole = (await exact.call(SEARCH, { needle: "# Guide" })) as SearchPage;
    expect(whole.scanRange).toEqual({ start: 0, end: window });
    expect(commits(whole)).toEqual([fixture.base]);
    expect(whole.nextCursor).toBeNull();

    const extra = await commitFiles(fixture.repository, { "src/app.ts": "extra\n" }, "One more");
    const over = await historyTools(fixture.repository, extra, { environment });
    const first = (await over.call(SEARCH, { needle: "# Guide" })) as SearchPage;
    expect(first.scanRange).toEqual({ start: 0, end: window });
    expect(first.matches).toEqual([]);
    expect(first.nextCursor).toEqual(expect.any(String));
    const rest = (await over.call(SEARCH, { cursor: first.nextCursor })) as SearchPage;
    expect(rest.scanRange).toEqual({ start: window, end: window + 1 });
    expect(commits(rest)).toEqual([fixture.base]);
    expect(rest.nextCursor).toBeNull();
    expect(
      over.toolSet.getHistoryReads()!.map((entry) => [entry.ranges, entry.matchedCommits]),
    ).toEqual([
      [[{ path: null, unit: "entries", start: 0, end: window }], []],
      [[{ path: null, unit: "entries", start: window, end: window + 1 }], [fixture.base]],
    ]);
  });

  it("resumes a window boundary inside a merge's two branches without losing the other branch", async () => {
    const fixture = await historyFixture(roots);
    const repository = fixture.repository;
    const environment = {
      DOCSFAB_GIT_HISTORY_PICKAXE_MAX_COMMITS_SCANNED: String(SCAN_BOUND.min + 1),
    };
    // Dates order the walk: merge, newer side, main, older side, then the
    // fixture's commits. The window boundary falls after the newer side
    // commit, so the next window's first commit is on the other branch and
    // the older side commit, the only match, is still owed.
    await fixtureGit(repository, ["checkout", "--quiet", "-b", "side", fixture.head]);
    const olderSide = await commitAt(
      repository,
      { "side.txt": "SIDE_ONLY\n" },
      "Older side",
      "2026-10-02T00:00:00Z",
    );
    const newerSide = await commitAt(
      repository,
      { "side-2.txt": "side\n" },
      "Newer side",
      "2026-10-04T00:00:00Z",
    );
    await fixtureGit(repository, ["checkout", "--quiet", "main"]);
    const main = await commitAt(
      repository,
      { "main.txt": "main\n" },
      "Main",
      "2026-10-03T00:00:00Z",
    );
    await gitWithInput(
      repository,
      ["merge", "--quiet", "--no-ff", "-m", "Merge side", "side"],
      undefined,
      {
        GIT_AUTHOR_DATE: "2026-10-05T00:00:00Z",
        GIT_COMMITTER_DATE: "2026-10-05T00:00:00Z",
      },
    );
    const merge = await fixtureGit(repository, ["rev-parse", "HEAD"]);
    const walk = (await fixtureGit(repository, ["rev-list", merge])).split("\n");
    expect(walk.slice(0, 4)).toEqual([merge, newerSide, main, olderSide]);
    const tools = await historyTools(repository, merge, { environment });

    const first = (await tools.call(SEARCH, { needle: "SIDE_ONLY" })) as SearchPage;
    expect(first.scanRange).toEqual({ start: 0, end: 2 });
    expect(first.matches).toEqual([]);
    const second = (await tools.call(SEARCH, { cursor: first.nextCursor })) as SearchPage;
    expect(second.scanRange).toEqual({ start: 2, end: 4 });
    expect(commits(second)).toEqual([olderSide]);
  });

  it("pages matches by bytes inside one window and a match's files across pages", async () => {
    const fixture = await historyFixture(roots);
    const bound = RESPONSE_BOUND.min;
    const environment = { DOCSFAB_GIT_HISTORY_RESPONSE_MAX_BYTES: String(bound) };
    let head = fixture.head;
    const matching: string[] = [];
    for (let index = 0; index < 8; index += 1) {
      head = await commitFiles(
        fixture.repository,
        { [`many/match-${String(index)}.txt`]: "PAGED_NEEDLE\n" },
        `Add a match with a subject long enough to fill a page quickly ${String(index)}`,
      );
      matching.unshift(head);
    }
    const tools = await historyTools(fixture.repository, head, { environment });
    const pages: SearchPage[] = [];
    let raw = await tools.text(SEARCH, { needle: "PAGED_NEEDLE" });
    for (;;) {
      expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(bound);
      const page = JSON.parse(raw) as SearchPage;
      pages.push(page);
      if (page.nextCursor === null) break;
      raw = await tools.text(SEARCH, { cursor: page.nextCursor });
    }
    expect(pages.length).toBeGreaterThan(1);
    // Every page names the same window; together they serve each match once, in order.
    expect(new Set(pages.map((page) => JSON.stringify(page.scanRange))).size).toBe(1);
    expect(pages.flatMap(commits)).toEqual(matching);
    expect(tools.toolSet.getHistoryReads()!.map((entry) => entry.matchedCommits)).toEqual(
      pages.map(commits),
    );
  });

  it("continues one commit's files across pages, and refuses one file too long for a page", async () => {
    const fixture = await historyFixture(roots);
    const bound = RESPONSE_BOUND.min;
    const environment = { DOCSFAB_GIT_HISTORY_RESPONSE_MAX_BYTES: String(bound) };
    const name = (index: number) => `vanish/file-${String(index).padStart(4, "0")}.txt`;
    // More files than one page's bytes can list, each name JSON-quoted with a comma.
    const count = Math.ceil(bound / (name(0).length + 3)) + 1;
    const files = Object.fromEntries(
      Array.from({ length: count }, (_, index) => [name(index), "VANISHING\n"]),
    );
    await commitFiles(fixture.repository, files, "Add the symbol everywhere");
    const removed = await commitFiles(
      fixture.repository,
      Object.fromEntries(Object.keys(files).map((path) => [path, "gone\n"])),
      "Remove it",
    );
    const tools = await historyTools(fixture.repository, removed, { environment });
    const pages: SearchPage[] = [];
    let page = (await tools.call(SEARCH, {
      needle: "VANISHING",
      range: { from: fixture.head },
    })) as SearchPage;
    pages.push(page);
    while (page.nextCursor !== null) {
      page = (await tools.call(SEARCH, { cursor: page.nextCursor })) as SearchPage;
      pages.push(page);
    }
    const ofRemoval = pages.filter((entry) => commits(entry).includes(removed));
    expect(ofRemoval.length).toBeGreaterThan(1);
    expect(
      ofRemoval.flatMap((entry) => entry.matches.find((match) => match.commit === removed)!.paths),
    ).toEqual(Object.keys(files).sort());
    for (const citation of tools.toolSet.getHistoryReads()!) {
      expect(new Set(citation.matchedCommits).size).toBe(citation.matchedCommits!.length);
    }

    // One name longer than a page can hold beside its envelope.
    // Committed through the index: the whole path is longer than some file systems allow.
    const segments = 5;
    const longName = `${Array.from({ length: segments }, () => "d".repeat(Math.floor(bound / segments))).join("/")}/x.txt`;
    expect(longName.length).toBeGreaterThan(bound);
    const long = await commitRawNames(
      fixture.repository,
      [[Buffer.from(longName, "utf8"), "LONG_ONE\n"]],
      "Long",
    );
    const longTools = await historyTools(fixture.repository, long, { environment });
    const message = await longTools.refusal(SEARCH, {
      needle: "LONG_ONE",
      range: { from: removed },
    });
    expect(refusalCode(message)).toBe("git-history-response-max-bytes-bound");
    expect(longTools.categories()).toEqual({ "recoverable-miss": 1 });
  });

  it("refuses a cursor replayed with another needle, paths, range or tool, and continues it unchanged", async () => {
    const fixture = await historyFixture(roots);
    const environment = { DOCSFAB_GIT_HISTORY_PICKAXE_MAX_COMMITS_SCANNED: String(SCAN_BOUND.min) };
    const tools = await historyTools(fixture.repository, fixture.head, { environment });
    const first = (await tools.call(SEARCH, { needle: "answer", paths: ["src"] })) as SearchPage;
    const cursor = first.nextCursor;
    expect(cursor).toEqual(expect.any(String));
    const log = await tools.call("docsfab_history_log", {});
    expect(log.nextCursor).toBeNull();

    for (const [tool, parameters] of [
      [SEARCH, { cursor, needle: "answer " }],
      [SEARCH, { cursor, paths: ["docs"] }],
      [SEARCH, { cursor, paths: ["src", "docs"] }],
      [SEARCH, { cursor, range: { to: fixture.base } }],
      [SEARCH, { cursor, range: { from: fixture.base } }],
      ["docsfab_history_log", { cursor }],
      [SEARCH, { cursor: `hc-${"0".repeat(32)}` }],
    ] as const) {
      expect(refusalCode(await tools.refusal(tool, parameters)), JSON.stringify(parameters)).toBe(
        "history-cursor-invalid",
      );
    }
    // Control: the cursor with every argument matching continues the walk.
    const next = (await tools.call(SEARCH, {
      cursor,
      needle: "answer",
      paths: ["src"],
      range: { to: "head" },
    })) as SearchPage;
    expect(next.scanRange).toEqual({ start: 1, end: 2 });
    expect(commits(next)).toEqual([fixture.base]);
  });

  it("refuses a needle one byte over its bound in UTF-8, not in UTF-16 units, before git runs", async () => {
    const fixture = await historyFixture(roots);
    const calls: string[][] = [];
    const { call, refusal } = await historyTools(fixture.repository, fixture.head, {
      git: recordingGit(calls),
    });
    // "é" is two UTF-8 bytes and one UTF-16 unit.
    const atBound = `${"é".repeat(Math.floor(NEEDLE_MAX_BYTES.value / 2))}${"a".repeat(NEEDLE_MAX_BYTES.value % 2)}`;
    expect(Buffer.byteLength(atBound)).toBe(NEEDLE_MAX_BYTES.value);
    const over = `${atBound}a`;
    expect(over.length).toBeLessThan(NEEDLE_MAX_BYTES.value);
    const message = await refusal(SEARCH, { needle: over });
    expect(refusalCode(message)).toBe("git-history-search-needle-max-bytes-bound");
    expect(message).toContain(
      `${String(NEEDLE_MAX_BYTES.value + 1)} exceeds gitHistory.searchNeedleMaxBytes`,
    );
    expect(message).not.toContain(over);
    expect(calls).toEqual([]);
    expect(((await call(SEARCH, { needle: atBound })) as SearchPage).matches).toEqual([]);
  });

  it("refuses a bad override of either search bound when the tool set is built, before git runs", async () => {
    const fixture = await historyFixture(roots);
    for (const [variable, definition] of [
      ["DOCSFAB_GIT_HISTORY_PICKAXE_MAX_COMMITS_SCANNED", SCAN_BOUND],
      ["DOCSFAB_GIT_HISTORY_SEARCH_NEEDLE_MAX_BYTES", NEEDLE_MAX_BYTES],
    ] as const) {
      const calls: string[][] = [];
      await expect(
        historyTools(fixture.repository, fixture.head, {
          git: recordingGit(calls),
          environment: { [variable]: String(definition.max + 1) },
        }),
        variable,
      ).rejects.toThrow(
        `${variable} must be an integer between ${String(definition.min)} and ${String(definition.max)}.`,
      );
      expect(calls).toEqual([]);
      // Adjacent: the maximum itself builds.
      await expect(
        historyTools(fixture.repository, fixture.head, {
          environment: { [variable]: String(definition.max) },
        }),
      ).resolves.toBeDefined();
    }
  });

  it("shares cursorsMaxPerToolSet with the other history tools", async () => {
    const fixture = await historyFixture(roots);
    const big = await commitFiles(
      fixture.repository,
      { "big.txt": "x".repeat(RESPONSE_BOUND.value * 2) },
      "Big",
    );
    const tools = await historyTools(fixture.repository, big, {
      environment: {
        DOCSFAB_GIT_HISTORY_CURSORS_MAX_PER_TOOL_SET: String(
          limitDefinition("gitHistory.cursorsMaxPerToolSet").min,
        ),
        DOCSFAB_GIT_HISTORY_PICKAXE_MAX_COMMITS_SCANNED: String(SCAN_BOUND.min),
      },
    });
    const show = await tools.call("docsfab_history_show", { path: "big.txt", revision: "head" });
    expect(show.nextCursor).toEqual(expect.any(String));
    const message = await tools.refusal(SEARCH, { needle: "answer" });
    expect(refusalCode(message)).toBe("git-history-cursors-max-per-tool-set-bound");
  });
});

describe("search over shallow and partial clones", { timeout: SEARCH_TEST_TIMEOUT_MS }, () => {
  it("labels the page whose window holds the cut, flags a match at the cut, and leaves a full clone's root alone", async () => {
    const fixture = await historyFixture(roots);
    await commitFiles(fixture.repository, { "later.txt": "later\n" }, "Later");
    const head = await commitFiles(fixture.repository, { "last.txt": "last\n" }, "Last");
    const shallow = await cloneFixture(fixture, "shallow", ["--depth=2"]);
    const cut = await fixtureGit(shallow, ["rev-parse", "HEAD~1"]);
    const { call } = await historyTools(shallow, head);

    // The cut reads as a root: every older change to the file is attributed to it.
    const page = (await call(SEARCH, { needle: "The answer is two" })) as SearchPage;
    // The cut, read as a root, also lists the credential file.
    expect(page.labels).toEqual(["history-paths-excluded", "history-shallow"]);
    expect(page.matches).toEqual([
      expect.objectContaining({ commit: cut, parents: [], atShallowCut: true }),
    ]);
    // A window holding the cut with no match on it is labelled too.
    const unmatched = (await call(SEARCH, { needle: "last" })) as SearchPage;
    expect(unmatched.labels).toEqual(["history-paths-excluded", "history-shallow"]);
    expect(unmatched.matches).toEqual([expect.objectContaining({ commit: head })]);
    expect(unmatched.matches[0]).not.toHaveProperty("atShallowCut");

    // One commit a window: only the page whose window reaches the cut is labelled.
    const windowed = await historyTools(shallow, head, {
      environment: { DOCSFAB_GIT_HISTORY_PICKAXE_MAX_COMMITS_SCANNED: String(SCAN_BOUND.min) },
    });
    const first = (await windowed.call(SEARCH, { needle: NOWHERE })) as SearchPage;
    expect(first.labels).toEqual([]);
    const second = (await windowed.call(SEARCH, { cursor: first.nextCursor })) as SearchPage;
    expect(second.labels).toEqual(["history-paths-excluded", "history-shallow"]);
    expect(second.nextCursor).toBeNull();

    // Control: in the full clone the root is neither labelled nor flagged.
    const full = await historyTools(fixture.repository, head);
    const rooted = (await full.call(SEARCH, { needle: "# Guide" })) as SearchPage;
    expect(rooted.labels).toEqual(["history-paths-excluded"]);
    expect(rooted.matches).toEqual([
      expect.objectContaining({ commit: fixture.base, parents: [] }),
    ]);
    expect(rooted.matches[0]).not.toHaveProperty("atShallowCut");
  });

  it("labels a window holding a cut on one branch while the walk goes on down the other", async () => {
    const fixture = await historyFixture(roots);
    const repository = fixture.repository;
    await fixtureGit(repository, ["checkout", "--quiet", "-b", "side", fixture.head]);
    const side = await commitAt(
      repository,
      { "side.txt": "side\n" },
      "Side",
      "2026-10-08T00:00:00Z",
    );
    await fixtureGit(repository, ["checkout", "--quiet", "main"]);
    const deep = await commitAt(
      repository,
      { "deep.txt": "DEEP_ONLY\n" },
      "Deep",
      "2026-10-05T00:00:00Z",
    );
    await commitAt(repository, { "main.txt": "main\n" }, "Main", "2026-10-06T00:00:00Z");
    await gitWithInput(
      repository,
      ["merge", "--quiet", "--no-ff", "-m", "Merge side", "side"],
      undefined,
      { GIT_AUTHOR_DATE: "2026-10-09T00:00:00Z", GIT_COMMITTER_DATE: "2026-10-09T00:00:00Z" },
    );
    const merge = await fixtureGit(repository, ["rev-parse", "HEAD"]);
    // Cut the side branch only, as a shallow fetch that excluded its history
    // would: the main branch still reaches the root.
    await writeFile(join(repository, ".git", "shallow"), `${side}\n`);
    const walk = (await fixtureGit(repository, ["rev-list", merge])).split("\n");
    expect(walk.slice(0, 2)).toEqual([merge, side]);
    const tools = await historyTools(repository, merge, {
      environment: { DOCSFAB_GIT_HISTORY_PICKAXE_MAX_COMMITS_SCANNED: String(SCAN_BOUND.min + 1) },
    });

    const pages: SearchPage[] = [(await tools.call(SEARCH, { needle: "DEEP_ONLY" })) as SearchPage];
    while (pages.at(-1)!.nextCursor !== null) {
      pages.push((await tools.call(SEARCH, { cursor: pages.at(-1)!.nextCursor })) as SearchPage);
    }
    // The first window holds the cut, matches nothing there, and the walk goes on.
    expect(pages[0]!.matches).toEqual([]);
    expect(pages[0]!.nextCursor).toEqual(expect.any(String));
    expect(pages[0]!.labels).toContain("history-shallow");
    // A middle window without the cut is not labelled; the match is found deeper.
    expect(pages[1]!.labels).not.toContain("history-shallow");
    expect(pages.flatMap(commits)).toEqual([deep]);
  });

  it("labels a non-linear window that reaches two cuts though neither matches", async () => {
    const fixture = await historyFixture(roots);
    const repository = fixture.repository;
    await fixtureGit(repository, ["checkout", "--quiet", "-b", "side", fixture.head]);
    await commitFiles(repository, { "side.txt": "side\n" }, "Side");
    await fixtureGit(repository, ["checkout", "--quiet", "main"]);
    await commitFiles(repository, { "main.txt": "main\n" }, "Main");
    await fixtureGit(repository, ["merge", "--quiet", "--no-ff", "-m", "Merge side", "side"]);
    const head = await commitFiles(repository, { "top.txt": "TOP_ONLY\n" }, "Top");
    const shallow = await cloneFixture(fixture, "shallow-merge", ["--depth=3"]);
    const cuts = (await readFile(join(shallow, ".git", "shallow"), "utf8"))
      .split("\n")
      .filter(Boolean);
    expect(cuts).toHaveLength(2);
    const { call } = await historyTools(shallow, head);
    const page = (await call(SEARCH, { needle: "TOP_ONLY" })) as SearchPage;
    expect(commits(page)).toEqual([head]);
    expect(page.matches.some((match) => cuts.includes(match.commit))).toBe(false);
    expect(page.labels).toEqual(["history-paths-excluded", "history-shallow"]);
  });

  it("refuses a partial clone before any walk and fetches nothing", async () => {
    const fixture = await historyFixture(roots);
    for (const filter of ["--filter=blob:none", "--filter=tree:0"]) {
      const partial = await cloneFixture(fixture, `partial-${filter.slice(-6).replace(":", "")}`, [
        filter,
      ]);
      const attempts: string[][] = [];
      const calls: string[][] = [];
      const tools = await historyTools(partial, fixture.head, {
        git: recordingGit(calls, lazyFetchingGit(attempts)),
      });
      const message = await tools.refusal(SEARCH, { needle: "answer" });
      expect(refusalCode(message), filter).toBe("history-object-unavailable");
      expect(message).toContain("Search does not yet read partial clones.");
      expect(calls.filter((args) => isWalk(args) || isNameList(args) || isPickaxe(args))).toEqual(
        [],
      );
      expect(calls.filter((args) => args.includes("--get-regexp"))).toHaveLength(1);
      expect(attempts).toEqual([]);
      expect(tools.categories()).toEqual({ "recoverable-miss": 1 });
    }
    // Control: the full clone is served.
    const { call } = await historyTools(fixture.repository, fixture.head);
    expect(commits((await call(SEARCH, { needle: "# Guide" })) as SearchPage)).toEqual([
      fixture.base,
    ]);
  });

  it("keeps a git timeout as history-timeout and an exit as a defect", async () => {
    const fixture = await historyFixture(roots);
    for (const [kind, code] of [
      ["timeout", "history-timeout"],
      ["output-bound", "history-output-too-large"],
      ["exit", "history-git-failed"],
    ] as const) {
      for (const [stage, matches] of [
        ["walk", isWalk],
        ["names", isNameList],
        ["search", isPickaxe],
      ] as const) {
        const tools = await historyTools(fixture.repository, fixture.head, {
          git: async (cwd, args, maximumBytes, input) => {
            if (matches(args))
              throw new TrustedGitError(kind, "injected", kind === "exit" ? 128 : null);
            return trusted(cwd, args, maximumBytes, input);
          },
        });
        expect(
          refusalCode(await tools.refusal(SEARCH, { needle: "answer" })),
          `${kind} ${stage}`,
        ).toBe(code);
      }
    }
  });
});

describe("search credentials and host roots", { timeout: SEARCH_TEST_TIMEOUT_MS }, () => {
  it("withholds a subject or name holding a configured credential and masks a host root before the digest", async () => {
    const fixture = await historyFixture(roots);
    const secret = configureCredential(plantedCredentialValue(31));
    const leaked = await commitFiles(
      fixture.repository,
      { "a.txt": "CRED_NEEDLE\n", [`${secret}.txt`]: "CRED_NEEDLE\n" },
      `Rotate ${secret}`,
    );
    // A space, unlike a name character, lets the root start inside the name.
    const rootedName = `nest ${fixture.repository}/c.txt`;
    const rooted = await commitFiles(
      fixture.repository,
      { "b.txt": "CRED_NEEDLE\n", [rootedName]: "CRED_NEEDLE\n" },
      `Built in ${fixture.repository}/src`,
    );
    const { text, toolSet } = await historyTools(fixture.repository, rooted);
    const raw = await text(SEARCH, { needle: "CRED_NEEDLE" });
    const page = JSON.parse(raw) as SearchPage;
    expect(page.matches.map((match) => match.commit)).toEqual([rooted, leaked]);
    expect(page.matches[1]).toMatchObject({ subject: null, subjectWithheld: true });
    expect(page.matches[0]!.subject).not.toContain(fixture.repository);
    expect(page.matches[0]!.subject).toMatch(/^Built in /u);
    // A name holding a credential is listed as null; one holding a host root is masked.
    expect(new Set(page.matches[1]!.paths)).toEqual(new Set(["a.txt", null]));
    expect(page.matches[0]!.paths).toEqual(["b.txt", "nest c.txt"]);
    expect(raw).not.toContain(secret);
    expect(raw).not.toContain(fixture.repository);
    expect(toolSet.getHistoryReads()![0]!.sha256).toBe(sha256(raw));
  });
});
