// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `docsfab_history_blame` through the confined tool set the planner and writer
 * receive: attribution from fixture commits with known ids, the line-count
 * rule, the line bound and paging, cursors, revision and path policy, renamed
 * credential-bearing names, shallow and partial clones without a fetch, and
 * the citation each served page records.
 */
import { mkdir, readFile, symlink } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { limitDefinition } from "../src/config/limits.js";
import { runTrustedGit, TrustedGitError } from "../src/host-invoker/trusted-git.js";
import type { GitRunner } from "../src/repository/git-history.js";
import { configureCredential } from "./helpers/configured-credential.js";
import { plantedCredentialValue } from "./helpers/planted-credential.js";
import {
  cloneFixture,
  commitFiles,
  fixtureGit,
  historyFixture,
  type HistoryFixture,
  historyTools,
  lazyFetchingGit,
  refusalCode,
  sha256,
  type ToolPage,
} from "./helpers/git-history-fixture.js";
import { temporaryRoots } from "./helpers/temp.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";

const roots = temporaryRoots();
const BLAME = "docsfab_history_blame";
const BOUNDARY_MESSAGE =
  "DocsFab rejected data at a governed credential-isolation boundary before host credential material could escape.";
const RESPONSE_MAX_BYTES = limitDefinition("gitHistory.responseMaxBytes").value;
/** A SHA-256 object name in hex, longer than the fixtures' SHA-1 ids. */
const SHA256_ID_HEX = 64;
/** Fixture repositories and many git calls; raised on a loaded CI runner. */
const BLAME_TEST_TIMEOUT_MS = testTimeoutMs(60_000);
/** Six lines, so changing one keeps a renamed file similar enough for git to pair it. */
const SIX_LINES = "one\ntwo\nthree\nfour\nfive\nsix\n";

interface BlameLine {
  readonly line: number;
  readonly commit: string;
  readonly sourceLine: number;
  readonly text: string;
  readonly sourcePath?: string;
  readonly sourcePathWithheld?: true;
}

type BlamePage = ToolPage & {
  readonly lineRange: { start: number; end: number };
  readonly lines: BlameLine[];
};

/** A runner that records every git call before running it. */
function countingGit(calls: string[][]): GitRunner {
  return (cwd, args, maximumBytes, input) => {
    calls.push([...args]);
    return runTrustedGit(cwd, args, undefined, maximumBytes, input);
  };
}

/** Every string a parsed page holds, keys included. */
function stringsIn(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, entry]) => [key, ...stringsIn(entry)]);
  }
  return [];
}

/**
 * Whether the local object store holds an object, asked without a lazy fetch.
 * Older git (2.39, for one) refuses a missing object it is handed even under
 * `--missing=print`; `--ignore-missing` lists it as nothing on every version.
 */
async function heldLocally(repository: string, objectId: string): Promise<boolean> {
  const listed = await fixtureGit(repository, [
    "rev-list",
    "--objects",
    "--no-walk",
    "--missing=print",
    "--ignore-missing",
    "--no-object-names",
    objectId,
  ]);
  return listed.split("\n").includes(objectId);
}

/**
 * A runner that behaves like git 2.39 (the CI image's git) where git 2.50
 * does not: a `rev-list --missing=print` that names an absent object, without
 * `--ignore-missing`, exits 128 instead of listing it as `?<id>`.
 */
function exitsOnNamedMissing(git: GitRunner): GitRunner {
  return async (cwd, args, maximumBytes, input) => {
    const output = await git(cwd, args, maximumBytes, input);
    if (!args.includes("rev-list") || !args.includes("--missing=print")) return output;
    if (args.includes("--ignore-missing")) return output;
    const named = args.includes("--stdin")
      ? (input?.toString("utf8").split("\n") ?? [])
      : args.slice(args.indexOf("--end-of-options") + 1);
    const listed = output.toString("utf8").split("\n");
    if (named.some((name) => name.length > 0 && listed.includes(`?${name}`))) {
      throw new TrustedGitError("exit", "Fixture git refused a missing named object.", 128);
    }
    return output;
  };
}

/** notes.md over three commits: two lines from the first, one changed, one added. */
async function notesFixture(fixture: HistoryFixture) {
  const first = await commitFiles(
    fixture.repository,
    { "notes.md": "alpha\nbeta\ngamma\n" },
    "Notes",
  );
  const second = await commitFiles(
    fixture.repository,
    { "notes.md": "alpha\nBETA\ngamma\n" },
    "Shout beta",
  );
  const third = await commitFiles(
    fixture.repository,
    { "notes.md": "alpha\nBETA\ngamma\ndelta\n" },
    "Add delta",
  );
  return { first, second, third };
}

describe("docsfab_history_blame", { timeout: BLAME_TEST_TIMEOUT_MS }, () => {
  it("attributes each line to the commit that last changed it and cites the served lines", async () => {
    const fixture = await historyFixture(roots);
    const { first, second, third } = await notesFixture(fixture);
    const { text, call, toolSet } = await historyTools(fixture.repository, third);

    const raw = await text(BLAME, { path: "notes.md", revision: "head", startLine: 1, endLine: 4 });
    expect(JSON.parse(raw)).toEqual({
      kind: "docsfab-history-blame",
      revision: third,
      path: "notes.md",
      lineRange: { start: 1, end: 4 },
      requestedRange: { start: 1, end: 4 },
      totalLines: 4,
      labels: [],
      nextCursor: null,
      lines: [
        { line: 1, commit: first, sourceLine: 1, text: "alpha" },
        { line: 2, commit: second, sourceLine: 2, text: "BETA" },
        { line: 3, commit: first, sourceLine: 3, text: "gamma" },
        { line: 4, commit: third, sourceLine: 4, text: "delta" },
      ],
    });
    expect(toolSet.getHistoryReads()).toEqual([
      {
        tool: BLAME,
        revisions: [third],
        paths: ["notes.md"],
        ranges: [{ path: "notes.md", unit: "lines", start: 1, end: 4 }],
        labels: [],
        sha256: sha256(raw),
      },
    ]);
    // At an older revision the same file reads as it was then.
    const older = (await call(BLAME, {
      path: "notes.md",
      revision: second.slice(0, 12),
      startLine: 2,
      endLine: 3,
    })) as BlamePage;
    expect(older.revision).toBe(second);
    expect(older.lines).toEqual([
      { line: 2, commit: second, sourceLine: 2, text: "BETA" },
      { line: 3, commit: first, sourceLine: 3, text: "gamma" },
    ]);
  });

  it("counts lines by line breaks plus an unterminated last line, and refuses past the count", async () => {
    const fixture = await historyFixture(roots);
    const head = await commitFiles(
      fixture.repository,
      { "open.txt": "a\nb", "closed.txt": "a\nb\n", "empty.txt": "" },
      "Line endings",
    );
    const { call, refusal, categories } = await historyTools(fixture.repository, head);

    // The last line of a file with no trailing newline is a line ...
    const open = (await call(BLAME, {
      path: "open.txt",
      revision: "head",
      startLine: 2,
      endLine: 2,
    })) as BlamePage;
    expect(open).toMatchObject({ totalLines: 2, lines: [expect.objectContaining({ text: "b" })] });
    // ... and one past it is not.
    const pastOpen = await refusal(BLAME, {
      path: "open.txt",
      revision: "head",
      startLine: 1,
      endLine: 3,
    });
    expect(refusalCode(pastOpen)).toBe("history-line-range-invalid");
    expect(pastOpen).toContain("The file has 2 lines at that revision.");
    // A trailing newline ends the last line; it does not start another.
    const closed = (await call(BLAME, {
      path: "closed.txt",
      revision: "head",
      startLine: 1,
      endLine: 2,
    })) as BlamePage;
    expect(closed.totalLines).toBe(2);
    expect(
      refusalCode(
        await refusal(BLAME, { path: "closed.txt", revision: "head", startLine: 1, endLine: 3 }),
      ),
    ).toBe("history-line-range-invalid");
    // An empty file has no lines at all.
    expect(
      refusalCode(
        await refusal(BLAME, { path: "empty.txt", revision: "head", startLine: 1, endLine: 1 }),
      ),
    ).toBe("history-line-range-invalid");
    // Line numbers count from 1, and a range runs forward.
    for (const [startLine, endLine] of [
      [0, 1],
      [2, 1],
      [-1, 1],
    ] as const) {
      const message = await refusal(BLAME, {
        path: "closed.txt",
        revision: "head",
        startLine,
        endLine,
      });
      expect(refusalCode(message), `${String(startLine)}..${String(endLine)}`).toBe(
        "history-line-range-invalid",
      );
    }
    for (const startLine of [1.5, "1", null]) {
      const message = await refusal(BLAME, {
        path: "closed.txt",
        revision: "head",
        startLine,
        endLine: 2,
      });
      expect(refusalCode(message), String(startLine)).toBe("history-arguments-invalid");
    }
    expect(categories()).toEqual({ "malformed-arguments": 9 });
  });

  it("refuses a binary file at the blamed revision", async () => {
    const fixture = await historyFixture(roots);
    const head = await commitFiles(
      fixture.repository,
      { "logo.bin": Buffer.from([0x61, 0x0a, 0x00, 0x62, 0x0a]), "plain.txt": "a\nb\n" },
      "Binary",
    );
    const { call, refusal, categories, toolSet } = await historyTools(fixture.repository, head);

    const message = await refusal(BLAME, {
      path: "logo.bin",
      revision: "head",
      startLine: 1,
      endLine: 1,
    });
    expect(refusalCode(message)).toBe("history-object-binary");
    expect(categories()).toEqual({ "recoverable-miss": 1 });
    expect(toolSet.getHistoryReads()).toBeUndefined();
    // Control: a text file of the same commit is served.
    expect(
      (await call(BLAME, { path: "plain.txt", revision: "head", startLine: 1, endLine: 2 })).lines,
    ).toHaveLength(2);
  });
});

describe("blame bounds and cursors", { timeout: BLAME_TEST_TIMEOUT_MS }, () => {
  it("serves exactly blameMaxLines and refuses one more by its code before git runs", async () => {
    const fixture = await historyFixture(roots);
    const bound = 3;
    const head = await commitFiles(fixture.repository, { "five.txt": "1\n2\n3\n4\n5\n" }, "Five");
    const calls: string[][] = [];
    const { call, refusal, categories } = await historyTools(fixture.repository, head, {
      git: countingGit(calls),
      environment: { DOCSFAB_GIT_HISTORY_BLAME_MAX_LINES: String(bound) },
    });

    const atBound = (await call(BLAME, {
      path: "five.txt",
      revision: "head",
      startLine: 2,
      endLine: 2 + bound - 1,
    })) as BlamePage;
    expect(atBound.lines.map((entry) => entry.line)).toEqual([2, 3, 4]);
    calls.length = 0;
    const over = await refusal(BLAME, {
      path: "five.txt",
      revision: "head",
      startLine: 2,
      endLine: 2 + bound,
    });
    expect(refusalCode(over)).toBe("git-history-blame-max-lines-bound");
    expect(over).toContain(`${String(bound + 1)} exceeds gitHistory.blameMaxLines`);
    expect(calls).toEqual([]);
    expect(categories()).toEqual({ "recoverable-miss": 1 });
  });

  it("serves a range whose page is exactly responseMaxBytes whole and pages one byte more", async () => {
    const fixture = await historyFixture(roots);
    const wide = "x".repeat(RESPONSE_MAX_BYTES / 4);
    const tail = (width: number) => `${wide}\n${wide}\n${wide}\n${"y".repeat(width)}\n`;
    const blameAll = async (head: string) =>
      (await historyTools(fixture.repository, head)).text(BLAME, {
        path: "wide.txt",
        revision: "head",
        startLine: 1,
        endLine: 4,
      });
    // The envelope of this shape, read from a real page with a short last line.
    const probeWidth = 1;
    const probe = await commitFiles(fixture.repository, { "wide.txt": tail(probeWidth) }, "Probe");
    const probeBytes = Buffer.byteLength(await blameAll(probe));
    const exactWidth = probeWidth + RESPONSE_MAX_BYTES - probeBytes;

    const atBound = await commitFiles(
      fixture.repository,
      { "wide.txt": tail(exactWidth) },
      "At bound",
    );
    const whole = await blameAll(atBound);
    expect(Buffer.byteLength(whole)).toBe(RESPONSE_MAX_BYTES);
    expect(JSON.parse(whole)).toMatchObject({ nextCursor: null, lineRange: { start: 1, end: 4 } });

    const overBound = await commitFiles(
      fixture.repository,
      { "wide.txt": tail(exactWidth + 1) },
      "Over bound",
    );
    const paged = await historyTools(fixture.repository, overBound);
    const first = JSON.parse(
      await paged.text(BLAME, { path: "wide.txt", revision: "head", startLine: 1, endLine: 4 }),
    ) as BlamePage;
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(first.lineRange).toEqual({ start: 1, end: 3 });
    const second = (await paged.call(BLAME, { cursor: first.nextCursor })) as BlamePage;
    expect(second).toMatchObject({ nextCursor: null, lineRange: { start: 4, end: 4 } });
    expect([...first.lines, ...second.lines].map((entry) => entry.line)).toEqual([1, 2, 3, 4]);
    expect(second.lines[0]!.text).toBe("y".repeat(exactWidth + 1));
    expect(paged.toolSet.getHistoryReads()!.map((entry) => entry.ranges)).toEqual([
      [{ path: "wide.txt", unit: "lines", start: 1, end: 3 }],
      [{ path: "wide.txt", unit: "lines", start: 4, end: 4 }],
    ]);
    // One line too long for a page alone is refused by the page bound, never cut.
    const tooLong = await commitFiles(
      fixture.repository,
      { "long.txt": `${"z".repeat(RESPONSE_MAX_BYTES)}\n` },
      "Long line",
    );
    const long = await historyTools(fixture.repository, tooLong);
    expect(
      refusalCode(
        await long.refusal(BLAME, { path: "long.txt", revision: "head", startLine: 1, endLine: 1 }),
      ),
    ).toBe("git-history-response-max-bytes-bound");
  });

  it("shares cursorsMaxPerToolSet with the other history tools", async () => {
    const fixture = await historyFixture(roots);
    const wide = "x".repeat(RESPONSE_MAX_BYTES / 2);
    const head = await commitFiles(
      fixture.repository,
      { "wide.txt": `${wide}\n${wide}\n`, "big.txt": "b".repeat(RESPONSE_MAX_BYTES * 2) },
      "Wide",
    );
    const environment = { DOCSFAB_GIT_HISTORY_CURSORS_MAX_PER_TOOL_SET: "1" };
    const blameFirst = { path: "wide.txt", revision: "head", startLine: 1, endLine: 2 };
    const shared = await historyTools(fixture.repository, head, { environment });
    expect(
      (await shared.call("docsfab_history_show", { path: "big.txt", revision: "head" })).nextCursor,
    ).toEqual(expect.any(String));
    const message = await shared.refusal(BLAME, blameFirst);
    expect(refusalCode(message)).toBe("git-history-cursors-max-per-tool-set-bound");
    // Control: a fresh tool set holds the blame cursor.
    const fresh = await historyTools(fixture.repository, head, { environment });
    expect((await fresh.call(BLAME, blameFirst)).nextCursor).toEqual(expect.any(String));
  });

  it("refuses a blame cursor replayed with another path, revision, range or tool", async () => {
    const fixture = await historyFixture(roots);
    const wide = "x".repeat(RESPONSE_MAX_BYTES / 2);
    const head = await commitFiles(
      fixture.repository,
      { "wide.txt": `${wide}\n${wide}\n${wide}\n`, "other.txt": `${wide}\n${wide}\n${wide}\n` },
      "Wide",
    );
    const { call, refusal } = await historyTools(fixture.repository, head);
    const first = (await call(BLAME, {
      path: "wide.txt",
      revision: "head",
      startLine: 1,
      endLine: 3,
    })) as BlamePage;
    const cursor = first.nextCursor;
    expect(cursor).toEqual(expect.any(String));

    const replays: Array<[string, Record<string, unknown>]> = [
      [BLAME, { cursor, path: "other.txt" }],
      [BLAME, { cursor, revision: fixture.head }],
      [BLAME, { cursor, startLine: 2 }],
      [BLAME, { cursor, endLine: 2 }],
      ["docsfab_history_show", { cursor }],
      ["docsfab_history_log", { cursor }],
      [BLAME, { cursor: `hc-${"0".repeat(32)}` }],
    ];
    for (const [tool, parameters] of replays) {
      expect(refusalCode(await refusal(tool, parameters)), JSON.stringify(parameters)).toBe(
        "history-cursor-invalid",
      );
    }
    // A show cursor is not a blame cursor either.
    const show = await call("docsfab_history_show", { path: "wide.txt", revision: "head" });
    expect(show.nextCursor).toEqual(expect.any(String));
    expect(refusalCode(await refusal(BLAME, { cursor: show.nextCursor }))).toBe(
      "history-cursor-invalid",
    );
    // Control: the cursor with matching arguments resumes where the page ended.
    const next = (await call(BLAME, {
      cursor,
      path: "wide.txt",
      revision: "head",
      startLine: 1,
      endLine: 3,
    })) as BlamePage;
    expect(next.lineRange.start).toBe(first.lineRange.end + 1);
  });
});

describe("blame revision and path policy", { timeout: BLAME_TEST_TIMEOUT_MS }, () => {
  it("refuses an over-long id, a tag, a reflog entry, an option and a commit outside head's history", async () => {
    const fixture = await historyFixture(roots);
    await fixtureGit(fixture.repository, ["tag", "-a", "-m", "Base", "v1", fixture.base]);
    const tag = await fixtureGit(fixture.repository, ["rev-parse", "v1"]);
    await fixtureGit(fixture.repository, ["checkout", "--quiet", "-b", "side", fixture.base]);
    const side = await commitFiles(fixture.repository, { "src/app.ts": "side\n" }, "Side");
    await fixtureGit(fixture.repository, ["checkout", "--quiet", "main"]);
    const { call, refusal } = await historyTools(fixture.repository, fixture.head);
    const range = { path: "src/app.ts", startLine: 1, endLine: 1 };

    for (const [revision, code] of [
      ["a".repeat(SHA256_ID_HEX), "history-revision-invalid"],
      [tag, "history-revision-invalid"],
      ["HEAD@{1}", "history-revision-invalid"],
      ["--output=/tmp/x", "history-revision-invalid"],
      ["HEAD", "history-revision-invalid"],
      [side, "history-revision-out-of-scope"],
    ] as const) {
      expect(refusalCode(await refusal(BLAME, { ...range, revision })), revision).toBe(code);
    }
    // Control: the tag's commit is an ancestor and is blamed.
    expect((await call(BLAME, { ...range, revision: fixture.base })).lines).toEqual([
      expect.objectContaining({ commit: fixture.base, text: "export const answer = 1;" }),
    ]);
  });

  it("refuses a credential-bearing path before any git call and checks the type at the blamed revision", async () => {
    const fixture = await historyFixture(roots);
    const repository = fixture.repository;
    const file = await commitFiles(repository, { cfg: "plain\n", "link.md": "plain\n" }, "Files");
    await fixtureGit(repository, ["rm", "--quiet", "cfg", "link.md"]);
    await symlink("docs/guide.md", join(repository, "link.md"));
    const directory = await commitFiles(repository, { "cfg/README.md": "settings\n" }, "Swap");
    await fixtureGit(repository, ["rm", "--quiet", "-r", "cfg", "link.md"]);
    await fixtureGit(repository, ["update-index", "--add", "--cacheinfo", `160000,${file},cfg`]);
    await fixtureGit(repository, ["commit", "--quiet", "-m", "Submodule"]);
    const gitlink = await fixtureGit(repository, ["rev-parse", "HEAD"]);
    await fixtureGit(repository, ["rm", "--quiet", "--cached", "cfg"]);
    const fileAgain = await commitFiles(
      repository,
      { cfg: "plain again\n", "link.md": "plain again\n" },
      "Files again",
    );
    const calls: string[][] = [];
    const { call, refusal, categories } = await historyTools(repository, fileAgain, {
      git: countingGit(calls),
    });

    for (const path of [".env", "config/.env.local", "node_modules/x.js", "../x", "/etc/hosts"]) {
      const message = await refusal(BLAME, { path, revision: "head", startLine: 1, endLine: 1 });
      expect(refusalCode(message), path).toBe("history-path-refused");
    }
    expect(calls).toEqual([]);
    expect(categories()).toEqual({ "denied-path": 5 });
    // Files at head, but a directory, a link and a submodule at the blamed revisions.
    for (const [path, revision] of [
      ["cfg", directory],
      ["link.md", directory],
      ["cfg", gitlink],
    ] as const) {
      const message = await refusal(BLAME, { path, revision, startLine: 1, endLine: 1 });
      expect(refusalCode(message), `${path} at ${revision}`).toBe("history-path-not-file");
    }
    // Adjacent: the same paths are files at head and at the first commit.
    for (const revision of ["head", file]) {
      for (const path of ["cfg", "link.md"]) {
        const page = (await call(BLAME, { path, revision, startLine: 1, endLine: 1 })) as BlamePage;
        expect(page.lines, `${path} at ${revision}`).toHaveLength(1);
      }
    }
  });

  it("serves no credential-bearing name a renamed file had and labels the page", async () => {
    const fixture = await historyFixture(roots);
    const repository = fixture.repository;
    const added = await commitFiles(repository, { ".env": SIX_LINES }, "Add settings");
    await fixtureGit(repository, ["mv", ".env", "settings.txt"]);
    await commitFiles(repository, {}, "Rename settings");
    const changed = await commitFiles(
      repository,
      { "settings.txt": SIX_LINES.replace("two", "TWO") },
      "Shout two",
    );
    const { call, toolSet } = await historyTools(repository, changed);

    const page = (await call(BLAME, {
      path: "settings.txt",
      revision: "head",
      startLine: 1,
      endLine: 3,
    })) as BlamePage;
    expect(page.lines).toEqual([
      { line: 1, commit: added, sourceLine: 1, sourcePathWithheld: true, text: "one" },
      { line: 2, commit: changed, sourceLine: 2, text: "TWO" },
      { line: 3, commit: added, sourceLine: 3, sourcePathWithheld: true, text: "three" },
    ]);
    expect(page.labels).toEqual(["history-paths-excluded"]);
    expect(stringsIn(page).filter((value) => value.includes(".env"))).toEqual([]);
    expect(stringsIn(toolSet.getHistoryReads()).filter((value) => value.includes(".env"))).toEqual(
      [],
    );
    expect(toolSet.getHistoryReads()![0]!.labels).toEqual(["history-paths-excluded"]);
    // Adjacent: a page of only the line the rename commit's successor changed carries no old name.
    const own = (await call(BLAME, {
      path: "settings.txt",
      revision: "head",
      startLine: 2,
      endLine: 2,
    })) as BlamePage;
    expect(own).toMatchObject({ labels: [], lines: [{ commit: changed, text: "TWO" }] });
  });

  it("labels a line whose commit renamed the file from a credential-bearing name, and serves an admitted old name", async () => {
    const fixture = await historyFixture(roots);
    const repository = fixture.repository;
    const added = await commitFiles(repository, { ".env": SIX_LINES }, "Add settings");
    await fixtureGit(repository, ["mv", ".env", "settings.txt"]);
    // Renamed and changed in one commit: the changed line names the old file only as its parent's.
    const renamed = await commitFiles(
      repository,
      { "settings.txt": SIX_LINES.replace("three", "THREE") },
      "Rename and shout three",
    );
    const guide = await commitFiles(
      repository,
      { "docs/old-name.md": SIX_LINES.toUpperCase() },
      "Guide",
    );
    await fixtureGit(repository, ["mv", "docs/old-name.md", "docs/new-name.md"]);
    const head = await commitFiles(repository, {}, "Rename guide");
    const { call } = await historyTools(repository, head);

    const changedLine = (await call(BLAME, {
      path: "settings.txt",
      revision: "head",
      startLine: 3,
      endLine: 3,
    })) as BlamePage;
    expect(changedLine.lines).toEqual([{ line: 3, commit: renamed, sourceLine: 3, text: "THREE" }]);
    expect(changedLine.labels).toEqual(["history-paths-excluded"]);
    const oldLine = (await call(BLAME, {
      path: "settings.txt",
      revision: "head",
      startLine: 1,
      endLine: 1,
    })) as BlamePage;
    expect(oldLine.lines).toEqual([
      { line: 1, commit: added, sourceLine: 1, sourcePathWithheld: true, text: "one" },
    ]);
    // Adjacent: an admitted old name is served and sets no label.
    const moved = (await call(BLAME, {
      path: "docs/new-name.md",
      revision: "head",
      startLine: 1,
      endLine: 1,
    })) as BlamePage;
    expect(moved).toMatchObject({
      labels: [],
      lines: [
        { line: 1, commit: guide, sourceLine: 1, sourcePath: "docs/old-name.md", text: "ONE" },
      ],
    });
  });
});

describe("blame of shallow and partial clones", { timeout: BLAME_TEST_TIMEOUT_MS }, () => {
  it("labels lines attributed to a shallow cut and never a full clone's root", async () => {
    const fixture = await historyFixture(roots);
    const cut = await commitFiles(fixture.repository, { "notes.md": "one\ntwo\n" }, "Notes");
    const head = await commitFiles(fixture.repository, { "notes.md": "one\nTWO\n" }, "Shout");
    // Control: in the full clone the root commit is git's boundary, and is not a cut.
    const full = await historyTools(fixture.repository, head);
    const root = (await full.call(BLAME, {
      path: "src/app.ts",
      revision: fixture.base,
      startLine: 1,
      endLine: 1,
    })) as BlamePage;
    expect(root).toMatchObject({ labels: [], lines: [{ commit: fixture.base }] });

    const deep = await cloneFixture(fixture, "deep", ["--depth=2"]);
    const shallowFile = await fixtureGit(deep, ["rev-parse", "--git-path", "shallow"]);
    expect((await readFile(join(deep, shallowFile), "utf8")).split("\n")).toContain(cut);
    const shallow = await historyTools(deep, head);
    const both = (await shallow.call(BLAME, {
      path: "notes.md",
      revision: "head",
      startLine: 1,
      endLine: 2,
    })) as BlamePage;
    expect(both.lines.map((entry) => entry.commit)).toEqual([cut, head]);
    expect(both.labels).toEqual(["history-shallow"]);
    // Adjacent: in the same shallow clone, a page with no line from the cut is not labelled.
    const own = (await shallow.call(BLAME, {
      path: "notes.md",
      revision: "head",
      startLine: 2,
      endLine: 2,
    })) as BlamePage;
    expect(own).toMatchObject({ labels: [], lines: [{ commit: head }] });
    expect(shallow.toolSet.getHistoryReads()!.map((entry) => entry.labels)).toEqual([
      ["history-shallow"],
      [],
    ]);
  });

  it("refuses blame a blobless clone cannot serve, without a fetch, and serves what it holds", async () => {
    const fixture = await historyFixture(roots);
    const repository = fixture.repository;
    const old = await commitFiles(repository, { "old.md": SIX_LINES }, "Old");
    await fixtureGit(repository, ["mv", "old.md", "new.md"]);
    await commitFiles(repository, { "new.md": `${SIX_LINES}seven\n` }, "Rename and extend");
    // A file whose newest version the clone holds, renamed whole after an older change.
    const hopped = await commitFiles(repository, { "hop-source.md": SIX_LINES }, "Hop source");
    await commitFiles(
      repository,
      { "hop-source.md": SIX_LINES.replace("one", "ONE") },
      "Change hop source",
    );
    await fixtureGit(repository, ["mv", "hop-source.md", "hopped.md"]);
    await commitFiles(repository, {}, "Rename hop source");
    const head = await commitFiles(repository, { "fresh.md": "fresh\n" }, "Fresh");
    const partial = await cloneFixture(fixture, "partial", ["--filter=blob:none"]);
    const attempts: string[][] = [];
    const { call, refusal, categories } = await historyTools(partial, head, {
      git: exitsOnNamedMissing(lazyFetchingGit(attempts)),
    });
    // Only the file's version before the rename is absent.
    const oldBlob = await fixtureGit(partial, ["rev-parse", `${old}:old.md`]);
    const newBlob = await fixtureGit(partial, ["rev-parse", `${head}:new.md`]);
    expect(await heldLocally(partial, oldBlob)).toBe(false);
    expect(await heldLocally(partial, newBlob)).toBe(true);
    // Control: the runner does exit on a missing object named without --ignore-missing.
    await expect(
      exitsOnNamedMissing(lazyFetchingGit(attempts))(
        partial,
        ["rev-list", "--objects", "--no-walk", "--missing=print", "--no-object-names", "--stdin"],
        undefined,
        Buffer.from(`${newBlob}\n${oldBlob}\n`, "utf8"),
      ),
    ).rejects.toMatchObject({ kind: "exit", exitCode: 128 });
    expect(attempts).toEqual([]);
    // Both names of the renamed file's newest version are held; only the
    // older version under the old name is not.
    const hopOld = await fixtureGit(partial, ["rev-parse", `${hopped}:hop-source.md`]);
    expect(await heldLocally(partial, hopOld)).toBe(false);
    expect(
      await heldLocally(partial, await fixtureGit(partial, ["rev-parse", `${head}:hopped.md`])),
    ).toBe(true);

    for (const parameters of [
      { path: "src/app.ts", revision: fixture.base, startLine: 1, endLine: 1 },
      { path: "new.md", revision: "head", startLine: 1, endLine: 7 },
      { path: "hopped.md", revision: "head", startLine: 1, endLine: 6 },
    ]) {
      expect(refusalCode(await refusal(BLAME, parameters)), parameters.path).toBe(
        "history-object-unavailable",
      );
    }
    expect(categories()).toEqual({ "recoverable-miss": 3 });
    expect(attempts).toEqual([]);
    // Present-object control: a file whose only version the clone holds.
    const page = (await call(BLAME, {
      path: "fresh.md",
      revision: "head",
      startLine: 1,
      endLine: 1,
    })) as BlamePage;
    expect(page).toMatchObject({
      labels: ["history-partial-clone"],
      lines: [{ commit: head, text: "fresh" }],
    });
    expect(attempts).toEqual([]);
    expect(await heldLocally(partial, oldBlob)).toBe(false);
  });

  it("serves a blobless clone's blame of a file unchanged since the root commit", async () => {
    // Its own repository, so the root commit adds a file no later commit changes.
    const root = await roots.create("docsfab-history-root-", { realpath: true });
    const repository = join(root, "repository");
    await mkdir(repository);
    await fixtureGit(repository, ["init", "--quiet", "--initial-branch=main"]);
    const base = await commitFiles(repository, { "keep.md": "kept\n" }, "Root");
    const head = await commitFiles(repository, { "other.md": "other\n" }, "Other");
    const partial = await cloneFixture({ root, repository, base, head }, "partial", [
      "--filter=blob:none",
    ]);
    const attempts: string[][] = [];
    const { call } = await historyTools(partial, head, { git: lazyFetchingGit(attempts) });

    const page = (await call(BLAME, {
      path: "keep.md",
      revision: "head",
      startLine: 1,
      endLine: 1,
    })) as BlamePage;
    expect(page).toMatchObject({
      labels: ["history-partial-clone"],
      lines: [{ commit: base, text: "kept" }],
    });
    expect(attempts).toEqual([]);
  });

  it("refuses show, diff and blame across trees a treeless clone does not hold, without a fetch", async () => {
    const fixture = await historyFixture(roots);
    const head = await commitFiles(fixture.repository, { "fresh.md": "fresh\n" }, "Fresh");
    const treeless = await cloneFixture(fixture, "treeless", ["--filter=tree:0"]);
    const attempts: string[][] = [];
    const { call, refusal, categories } = await historyTools(treeless, head, {
      git: lazyFetchingGit(attempts),
    });
    const baseTree = await fixtureGit(fixture.repository, ["rev-parse", `${fixture.base}^{tree}`]);
    expect(await heldLocally(treeless, baseTree)).toBe(false);

    for (const [tool, parameters] of [
      ["docsfab_history_show", { path: "src/app.ts", revision: fixture.base }],
      ["docsfab_history_diff", { base: fixture.base, head: "head" }],
      [BLAME, { path: "src/app.ts", revision: fixture.base, startLine: 1, endLine: 1 }],
    ] as const) {
      expect(refusalCode(await refusal(tool, parameters)), tool).toBe("history-object-unavailable");
    }
    expect(categories()).toEqual({ "recoverable-miss": 3 });
    expect(attempts).toEqual([]);
    // Control: head's trees and file are held, and read labelled.
    expect(
      await call("docsfab_history_show", { path: "fresh.md", revision: "head" }),
    ).toMatchObject({ text: "fresh\n", labels: ["history-partial-clone"] });
    expect(attempts).toEqual([]);
    expect(await heldLocally(treeless, baseTree)).toBe(false);
  });

  it("keeps a blame failure after the checks a defect in a full clone and unavailable in a partial one", async () => {
    const fixture = await historyFixture(roots);
    const head = await commitFiles(fixture.repository, { "fresh.md": "fresh\n" }, "Fresh");
    const failing: GitRunner = async (cwd, args, maximumBytes, input) => {
      if (args.includes("blame")) throw new TrustedGitError("exit", "injected", 128);
      return runTrustedGit(cwd, args, undefined, maximumBytes, input);
    };
    const parameters = { path: "fresh.md", revision: "head", startLine: 1, endLine: 1 };

    const full = await historyTools(fixture.repository, head, { git: failing });
    expect(refusalCode(await full.refusal(BLAME, parameters))).toBe("history-git-failed");
    expect(full.categories()).toEqual({ "tool-defect": 1 });
    const partial = await historyTools(
      await cloneFixture(fixture, "partial", ["--filter=blob:none"]),
      head,
      { git: failing },
    );
    expect(refusalCode(await partial.refusal(BLAME, parameters))).toBe(
      "history-object-unavailable",
    );
    expect(partial.categories()).toEqual({ "recoverable-miss": 1 });
    // Adjacent: a partial clone's blame that times out or overflows is not an
    // absent object, and keeps its own code.
    for (const [kind, code] of [
      ["timeout", "history-timeout"],
      ["output-bound", "history-output-too-large"],
    ] as const) {
      const bounded: GitRunner = async (cwd, args, maximumBytes, input) => {
        if (args.includes("blame")) throw new TrustedGitError(kind, "injected");
        return runTrustedGit(cwd, args, undefined, maximumBytes, input);
      };
      const tools = await historyTools(join(fixture.root, "partial"), head, { git: bounded });
      expect(refusalCode(await tools.refusal(BLAME, parameters)), kind).toBe(code);
    }
    // Control: without the injected failure both clones serve the line.
    for (const repository of [fixture.repository, join(fixture.root, "partial")]) {
      const page = await (await historyTools(repository, head)).call(BLAME, parameters);
      expect((page as BlamePage).lines, repository).toHaveLength(1);
    }
  });

  it("asks the partial clone's object store only about full ids", async () => {
    const fixture = await historyFixture(roots);
    const head = await commitFiles(fixture.repository, { "fresh.md": "fresh\n" }, "Fresh");
    const partial = await cloneFixture(fixture, "partial", ["--filter=blob:none"]);
    const parameters = { path: "fresh.md", revision: "head", startLine: 1, endLine: 1 };
    const stdin: string[] = [];
    const forging =
      (entryId: (id: string) => string): GitRunner =>
      async (cwd, args, maximumBytes, input) => {
        if (input !== undefined) stdin.push(input.toString("utf8"));
        const output = await runTrustedGit(cwd, args, undefined, maximumBytes, input);
        if (!args.includes("ls-tree")) return output;
        return Buffer.from(output.toString("utf8").replace(/\b[0-9a-f]{40}\b/u, entryId), "utf8");
      };

    // A tree entry whose id is not a full id never reaches rev-list's input.
    const forged = await historyTools(partial, head, { git: forging(() => "--all") });
    expect(refusalCode(await forged.refusal(BLAME, parameters))).toBe("history-git-failed");
    expect(forged.categories()).toEqual({ "tool-defect": 1 });
    expect(
      stdin.flatMap((text) => text.split("\n")).filter((line) => line.startsWith("-")),
    ).toEqual([]);
    // Adjacent: the same entry with its full id passes the check and is served.
    const held = await historyTools(partial, head, { git: forging((id) => id) });
    const page = (await held.call(BLAME, parameters)) as BlamePage;
    expect(page.lines).toEqual([expect.objectContaining({ commit: head, text: "fresh" })]);
  });
});

describe("blame credentials and host roots", { timeout: BLAME_TEST_TIMEOUT_MS }, () => {
  it("refuses a range holding a configured credential, cites nothing, and serves a range without it", async () => {
    const fixture = await historyFixture(roots);
    const secret = configureCredential(plantedCredentialValue(1990));
    const head = await commitFiles(
      fixture.repository,
      { "notes.txt": `clean\nkey ${secret}\nalso clean\n` },
      "Leak",
    );
    const { call, refusal, toolSet } = await historyTools(fixture.repository, head);

    const message = await refusal(BLAME, {
      path: "notes.txt",
      revision: "head",
      startLine: 1,
      endLine: 3,
    });
    expect(message).toBe(BOUNDARY_MESSAGE);
    expect(toolSet.getHistoryReads()).toBeUndefined();
    // Control: a range that does not hold the line is served and cited.
    const clean = (await call(BLAME, {
      path: "notes.txt",
      revision: "head",
      startLine: 3,
      endLine: 3,
    })) as BlamePage;
    expect(clean.lines).toEqual([expect.objectContaining({ text: "also clean" })]);
    expect(toolSet.getHistoryReads()).toHaveLength(1);
  });

  it("serves an unconfigured credential shape and masks a host root before the digest", async () => {
    const fixture = await historyFixture(roots);
    const shaped = `glpat-${plantedCredentialValue(12)}`;
    const head = await commitFiles(
      fixture.repository,
      { "notes.txt": `token ${shaped}\nbuilt in ${fixture.repository}/src\n` },
      "Shape",
    );
    const { text, toolSet } = await historyTools(fixture.repository, head);

    const raw = await text(BLAME, {
      path: "notes.txt",
      revision: "head",
      startLine: 1,
      endLine: 2,
    });
    const page = JSON.parse(raw) as BlamePage;
    expect(page.lines[0]!.text).toBe(`token ${shaped}`);
    expect(page.lines[1]!.text).not.toContain(fixture.repository);
    expect(page.lines[1]!.text.startsWith("built in ")).toBe(true);
    expect(toolSet.getHistoryReads()![0]!.sha256).toBe(sha256(raw));
  });
});
