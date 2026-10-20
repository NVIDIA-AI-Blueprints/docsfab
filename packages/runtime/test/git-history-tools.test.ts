// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The git history tools through the confined tool set the planner and writer
 * receive: revision and path policy, ancestry scope, shallow and partial
 * clones, paging bounds and cursors, credential and host-root screening, and
 * the citation each served page records.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { limitDefinition } from "../src/config/limits.js";
import { createConfinedToolSet } from "../src/harness/confined-tools.js";
import { HISTORY_TOOL_NAMES } from "../src/harness/history-tools.js";
import { TrustedGitError } from "../src/host-invoker/trusted-git.js";
import {
  GIT_HISTORY_CODE_CATEGORIES,
  GIT_HISTORY_CODES,
  type GitRunner,
} from "../src/repository/git-history.js";
import { runTrustedGit } from "../src/host-invoker/trusted-git.js";
import { configureCredential } from "./helpers/configured-credential.js";
import { plantedCredentialValue } from "./helpers/planted-credential.js";
import {
  BASE_APP,
  cloneFixture,
  commitFiles,
  fixtureGit,
  HEAD_APP,
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
const BOUNDARY_MESSAGE =
  "DocsFab rejected data at a governed credential-isolation boundary before host credential material could escape.";
const LOG_MAX_ENTRIES = limitDefinition("gitHistory.logMaxEntries").value;
const RESPONSE_MAX_BYTES = limitDefinition("gitHistory.responseMaxBytes").value;
const PATHS_MAX_PER_CALL = limitDefinition("gitHistory.pathsMaxPerCall").value;
const GIT_OUTPUT_MAX_BYTES = limitDefinition("hostInvoker.gitOutputMaxBytes").value;
/** A SHA-256 object name in hex, longer than the fixtures' SHA-1 ids. */
const SHA256_ID_HEX = 64;
/** Fixture repositories and many git calls; raised on a loaded CI runner. */
const HISTORY_TEST_TIMEOUT_MS = testTimeoutMs(60_000);

describe("docsfab_history_show", { timeout: HISTORY_TEST_TIMEOUT_MS }, () => {
  it("reads a file at the base by full id and at head by alias, and cites each page", async () => {
    const fixture = await historyFixture(roots);
    const { call, text, toolSet } = await historyTools(fixture.repository, fixture.head);

    const baseText = await text("docsfab_history_show", {
      path: "src/app.ts",
      revision: fixture.base,
    });
    const basePage = JSON.parse(baseText) as ToolPage;
    expect(basePage).toMatchObject({
      kind: "docsfab-history-show",
      revision: fixture.base,
      path: "src/app.ts",
      text: BASE_APP,
      nextCursor: null,
      labels: [],
    });
    const headPage = await call("docsfab_history_show", { path: "src/app.ts", revision: "head" });
    expect(headPage).toMatchObject({ revision: fixture.head, text: HEAD_APP });

    const citations = toolSet.getHistoryReads()!;
    expect(citations).toHaveLength(2);
    expect(citations[0]).toEqual({
      tool: "docsfab_history_show",
      revisions: [fixture.base],
      paths: ["src/app.ts"],
      ranges: [{ path: "src/app.ts", unit: "bytes", start: 0, end: Buffer.byteLength(BASE_APP) }],
      labels: [],
      sha256: sha256(baseText),
    });
    expect(citations[1]!.revisions).toEqual([fixture.head]);
  });

  it("resolves a valid abbreviation and ignores a hex-named branch that spells it", async () => {
    const fixture = await historyFixture(roots);
    const prefix = fixture.base.slice(0, 7);
    // A branch named like the base's abbreviation, pointing at head.
    await fixtureGit(fixture.repository, ["branch", prefix, fixture.head]);
    const { call } = await historyTools(fixture.repository, fixture.head);

    const page = await call("docsfab_history_show", { path: "src/app.ts", revision: prefix });
    expect(page).toMatchObject({ revision: fixture.base, text: BASE_APP });
  });

  it("refuses a tag object id and a too-short id as invalid revisions, naming the minimum", async () => {
    const fixture = await historyFixture(roots);
    await fixtureGit(fixture.repository, ["tag", "-a", "-m", "Base", "v1", fixture.base]);
    const tag = await fixtureGit(fixture.repository, ["rev-parse", "v1"]);
    expect(tag).not.toBe(fixture.base);
    const { refusal, call, categories } = await historyTools(fixture.repository, fixture.head);

    const tagged = await refusal("docsfab_history_show", { path: "src/app.ts", revision: tag });
    expect(refusalCode(tagged)).toBe("history-revision-invalid");
    expect(tagged).toContain("names a tag");
    const minimum = limitDefinition("gitHistory.revisionMinHexChars").value;
    const short = fixture.base.slice(0, minimum - 1);
    const tooShort = await refusal("docsfab_history_show", { path: "src/app.ts", revision: short });
    expect(refusalCode(tooShort)).toBe("history-revision-invalid");
    expect(tooShort).toContain(
      `The id has ${String(minimum - 1)} hex characters; gitHistory.revisionMinHexChars is ${String(minimum)}.`,
    );
    // An id longer than this repository's object format is malformed, not a defect.
    const tooLong = await refusal("docsfab_history_show", {
      path: "src/app.ts",
      revision: `${fixture.base}${"a".repeat(SHA256_ID_HEX)}`.slice(0, SHA256_ID_HEX),
    });
    expect(refusalCode(tooLong)).toBe("history-revision-invalid");
    expect(tooLong).toContain(
      `The id has ${String(SHA256_ID_HEX)} hex characters; this repository's commit ids have ${String(fixture.base.length)}.`,
    );
    expect(categories()).toEqual({ "malformed-arguments": 3 });
    // Adjacent: the commit the tag points at, and an id exactly at the minimum, read.
    expect(
      await call("docsfab_history_show", { path: "src/app.ts", revision: fixture.base }),
    ).toMatchObject({ text: BASE_APP });
    expect(
      await call("docsfab_history_show", {
        path: "src/app.ts",
        revision: fixture.base.slice(0, minimum),
      }),
    ).toMatchObject({ revision: fixture.base });
  });

  it("refuses an unknown full id as a missing object and cites nothing", async () => {
    const fixture = await historyFixture(roots);
    const { refusal, toolSet, categories } = await historyTools(fixture.repository, fixture.head);

    const message = await refusal("docsfab_history_show", {
      path: "src/app.ts",
      revision: "0123456789abcdef0123456789abcdef01234567",
    });
    expect(refusalCode(message)).toBe("history-object-missing");
    expect(categories()).toEqual({ "recoverable-miss": 1 });
    expect(toolSet.getHistoryReads()).toBeUndefined();
  });

  it("refuses revision and path injection by code and writes no file", async () => {
    const fixture = await historyFixture(roots);
    const { refusal, call, categories } = await historyTools(fixture.repository, fixture.head);
    const written = join(fixture.root, "x");

    const revisions = [
      `--output=${written}`,
      "-p",
      "HEAD@{1}",
      `${fixture.base}..${fixture.head}`,
      "HEAD",
      "main",
      fixture.base.toUpperCase(),
      fixture.base.slice(0, 6),
    ];
    for (const revision of revisions) {
      const message = await refusal("docsfab_history_show", { path: "src/app.ts", revision });
      expect(refusalCode(message), revision).toBe("history-revision-invalid");
    }
    for (const path of ["../x", "/etc/hosts", "~/x", "src//app.ts", "./src/app.ts", ".env"]) {
      const message = await refusal("docsfab_history_show", { path, revision: "head" });
      expect(refusalCode(message), path).toBe("history-path-refused");
    }
    // Literal pathspecs: magic is just a name that does not exist.
    const magic = await refusal("docsfab_history_show", { path: ":(glob)*", revision: "head" });
    expect(refusalCode(magic)).toBe("history-path-missing");
    expect(existsSync(written)).toBe(false);
    expect(categories()).toEqual({
      "malformed-arguments": revisions.length,
      "denied-path": 6,
      "recoverable-miss": 1,
    });
    // Positive control: an abbreviated id the same checks admit.
    const page = await call("docsfab_history_show", {
      path: "src/app.ts",
      revision: fixture.base.slice(0, 12),
    });
    expect(page.text).toBe(BASE_APP);
  });

  it("refuses an abbreviation two commits share as ambiguous", async () => {
    const fixture = await historyFixture(roots);
    const [first, second] = await collidingCommits(fixture);
    const prefix = first.slice(0, 7);
    expect(second.startsWith(prefix)).toBe(true);
    const { refusal, call } = await historyTools(fixture.repository, fixture.head);

    const message = await refusal("docsfab_history_show", { path: "src/app.ts", revision: prefix });
    expect(refusalCode(message)).toBe("history-revision-ambiguous");
    // Control: one more character tells them apart, and the commit is then
    // refused only for scope, not as ambiguous.
    const distinct = first.slice(0, commonPrefixLength(first, second) + 1);
    const scoped = await refusal("docsfab_history_show", {
      path: "src/app.ts",
      revision: distinct,
    });
    expect(refusalCode(scoped)).toBe("history-revision-out-of-scope");
    expect(
      (await call("docsfab_history_show", { path: "src/app.ts", revision: "head" })).text,
    ).toBe(HEAD_APP);
  });

  it("refuses a directory, and reads a file that is binary as a coded refusal", async () => {
    const fixture = await historyFixture(roots);
    const head = await commitFiles(
      fixture.repository,
      { "assets/logo.bin": Buffer.from([0x89, 0x50, 0x00, 0x01]) },
      "Add a binary",
    );
    const { refusal } = await historyTools(fixture.repository, head);
    expect(
      refusalCode(await refusal("docsfab_history_show", { path: "src", revision: "head" })),
    ).toBe("history-path-not-file");
    expect(
      refusalCode(
        await refusal("docsfab_history_show", { path: "assets/logo.bin", revision: "head" }),
      ),
    ).toBe("history-object-binary");
  });
});

describe("history scope", { timeout: HISTORY_TEST_TIMEOUT_MS }, () => {
  it("refuses an unrelated branch, a stash, a dangling commit, a range end and a resumed read outside head's history", async () => {
    const fixture = await historyFixture(roots);
    await fixtureGit(fixture.repository, ["checkout", "--quiet", "-b", "side", fixture.base]);
    const side = await commitFiles(fixture.repository, { "src/side.ts": "side\n" }, "Side work");
    await fixtureGit(fixture.repository, ["checkout", "--quiet", "main"]);
    await writeFile(join(fixture.repository, "src/app.ts"), "stashed\n");
    await fixtureGit(fixture.repository, ["stash", "push", "--quiet"]);
    const stash = await fixtureGit(fixture.repository, ["rev-parse", "stash@{0}"]);
    const tree = await fixtureGit(fixture.repository, ["rev-parse", `${fixture.head}^{tree}`]);
    const dangling = await fixtureGit(fixture.repository, ["commit-tree", tree, "-m", "dangling"]);
    const { refusal, call, toolSet } = await historyTools(fixture.repository, fixture.head);

    for (const revision of [side, stash, dangling]) {
      const message = await refusal("docsfab_history_show", { path: "src/app.ts", revision });
      expect(refusalCode(message)).toBe("history-revision-out-of-scope");
    }
    expect(
      refusalCode(await refusal("docsfab_history_diff", { base: fixture.base, head: side })),
    ).toBe("history-revision-out-of-scope");
    expect(
      refusalCode(await refusal("docsfab_history_log", { range: { from: side, to: "head" } })),
    ).toBe("history-revision-out-of-scope");
    // A cursor is valid only for the history it was issued over.
    const big = await bigFileFixture(fixture, RESPONSE_MAX_BYTES * 2);
    const tools = await historyTools(fixture.repository, big);
    const first = await tools.call("docsfab_history_show", { path: "big.txt", revision: "head" });
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(
      refusalCode(
        await tools.refusal("docsfab_history_show", {
          cursor: first.nextCursor,
          revision: side,
        }),
      ),
    ).toBe("history-revision-out-of-scope");
    // Positive control: the ancestor itself.
    expect(
      (await call("docsfab_history_show", { path: "src/app.ts", revision: fixture.base })).text,
    ).toBe(BASE_APP);
    expect(toolSet.getHistoryReads()).toHaveLength(1);
  });
});

describe("shallow and partial clones", { timeout: HISTORY_TEST_TIMEOUT_MS }, () => {
  it("labels a walk that reaches a shallow cut and refuses a commit beyond it", async () => {
    const fixture = await historyFixture(roots);
    const shallow = await cloneFixture(fixture, "shallow", ["--depth=1"]);
    const { call, refusal, toolSet } = await historyTools(shallow, fixture.head);

    const log = await call("docsfab_history_log", {});
    expect(log.labels).toEqual(["history-shallow"]);
    expect((log.entries as Array<{ commit: string }>).map((entry) => entry.commit)).toEqual([
      fixture.head,
    ]);
    const missing = await refusal("docsfab_history_show", {
      path: "src/app.ts",
      revision: fixture.base,
    });
    expect(refusalCode(missing)).toBe("history-object-missing");
    expect(missing).toContain("shallow clone");
    // Control: head is inside the cut.
    const page = await call("docsfab_history_show", { path: "src/app.ts", revision: "head" });
    expect(page).toMatchObject({ text: HEAD_APP, labels: [] });
    expect(toolSet.getHistoryReads()!.map((entry) => entry.labels)).toEqual([
      ["history-shallow"],
      [],
    ]);
  });

  it("does not label a full clone's parentless root commit as shallow", async () => {
    const fixture = await historyFixture(roots);
    const full = await historyTools(fixture.repository, fixture.head);
    const log = await full.call("docsfab_history_log", {});
    const entries = log.entries as Array<{ commit: string; parents: string[] }>;
    expect(entries.at(-1)).toMatchObject({ commit: fixture.base, parents: [] });
    expect(log.labels).toEqual([]);
    // Control in the same test: the same walk in a shallow clone is labelled.
    const shallow = await historyTools(
      await cloneFixture(fixture, "shallow", ["--depth=1"]),
      fixture.head,
    );
    expect((await shallow.call("docsfab_history_log", {})).labels).toEqual(["history-shallow"]);
  });

  it("reads a base inside a deeper shallow clone unlabelled and labels only the walk to its cut", async () => {
    const fixture = await historyFixture(roots);
    const middle = fixture.head;
    const head = await commitFiles(fixture.repository, { "src/app.ts": "three\n" }, "Third");
    const deep = await cloneFixture(fixture, "deep", ["--depth=2"]);
    const { call } = await historyTools(deep, head);

    const show = await call("docsfab_history_show", { path: "src/app.ts", revision: middle });
    expect(show).toMatchObject({ text: HEAD_APP, labels: [] });
    // A walk that stops before the cut is not labelled ...
    const inside = await call("docsfab_history_log", { range: { from: middle } });
    expect(inside.labels).toEqual([]);
    // ... and one that reaches it is.
    expect((await call("docsfab_history_log", {})).labels).toEqual(["history-shallow"]);
  });

  it("refuses a blob a partial clone does not hold and labels a read it does", async () => {
    const fixture = await historyFixture(roots);
    const partial = await cloneFixture(fixture, "partial", ["--filter=blob:none"]);
    const { call, refusal, categories } = await historyTools(partial, fixture.head);

    const message = await refusal("docsfab_history_show", {
      path: "src/app.ts",
      revision: fixture.base,
    });
    expect(refusalCode(message)).toBe("history-object-unavailable");
    expect(categories()).toEqual({ "recoverable-miss": 1 });
    const page = await call("docsfab_history_show", { path: "src/app.ts", revision: "head" });
    expect(page).toMatchObject({ text: HEAD_APP, labels: ["history-partial-clone"] });
    // Still not fetched: the base blob stays absent.
    const blob = await fixtureGit(partial, ["rev-parse", `${fixture.base}:src/app.ts`]);
    await expect(
      fixtureGit(partial, ["--no-lazy-fetch", "cat-file", "-e", blob]).catch(() => "absent"),
    ).resolves.toBe("absent");
  });

  it("labels a path-limited walk that passes a cut commit not touching the path", async () => {
    const fixture = await historyFixture(roots);
    const added = await commitFiles(fixture.repository, { "old.md": "first\n" }, "Add old");
    await fixtureGit(fixture.repository, ["rm", "--quiet", "old.md"]);
    const removed = await commitFiles(fixture.repository, {}, "Remove old");
    const cut = await commitFiles(fixture.repository, { "src/app.ts": "cut\n" }, "Unrelated");
    const head = await commitFiles(fixture.repository, { "old.md": "again\n" }, "Re-add old");
    const deep = await cloneFixture(fixture, "deep", ["--depth=2"]);
    expect((await fixtureGit(deep, ["rev-parse", "--is-shallow-repository"])).trim()).toBe("true");
    const shallow = await historyTools(deep, head);

    // The cut commit does not touch old.md, so it is never listed; the walk still reached it.
    const log = await shallow.call("docsfab_history_log", { path: "old.md" });
    expect((log.entries as Array<{ commit: string }>).map((entry) => entry.commit)).toEqual([head]);
    expect(log).toMatchObject({ labels: ["history-shallow"], nextCursor: null });
    expect(shallow.toolSet.getHistoryReads()!.at(-1)!.labels).toEqual(["history-shallow"]);
    // A last page exactly as long as the page bound still asks whether the walk reached the cut.
    const exact = await historyTools(deep, head, {
      environment: { DOCSFAB_GIT_HISTORY_LOG_MAX_ENTRIES: "1" },
    });
    expect(await exact.call("docsfab_history_log", { path: "old.md" })).toMatchObject({
      labels: ["history-shallow"],
      nextCursor: null,
    });
    // Adjacent: a path-limited walk stopped at the cut never reaches it.
    const stopped = await shallow.call("docsfab_history_log", {
      path: "old.md",
      range: { from: cut },
    });
    expect(stopped.labels).toEqual([]);
    // Control: the full history lists every commit touching the path, unlabelled.
    const full = await historyTools(fixture.repository, head);
    const fullLog = await full.call("docsfab_history_log", { path: "old.md" });
    expect((fullLog.entries as Array<{ commit: string }>).map((entry) => entry.commit)).toEqual([
      head,
      removed,
      added,
    ]);
    expect(fullLog.labels).toEqual([]);
  });

  it("labels a mid-walk page that lists a cut parent of a merge, before the walk ends", async () => {
    const fixture = await historyFixture(roots);
    await fixtureGit(fixture.repository, ["checkout", "--quiet", "-b", "side"]);
    const side = await commitFiles(fixture.repository, { "side.md": "side\n" }, "Side");
    await fixtureGit(fixture.repository, ["checkout", "--quiet", "main"]);
    const main = await commitFiles(fixture.repository, { "main.md": "main\n" }, "Main");
    await fixtureGit(fixture.repository, ["merge", "--quiet", "--no-ff", "--no-edit", "side"]);
    const merge = await fixtureGit(fixture.repository, ["rev-parse", "HEAD"]);
    // Both parents of the merge are cut.
    const deep = await cloneFixture(fixture, "deep", ["--depth=2"]);
    const cut = await readFile(
      join(deep, await fixtureGit(deep, ["rev-parse", "--git-path", "shallow"])),
      "utf8",
    );
    expect(cut.split("\n").filter(Boolean).sort()).toEqual([main, side].sort());
    const pageBound = { DOCSFAB_GIT_HISTORY_LOG_MAX_ENTRIES: "1" };
    const shallow = await historyTools(deep, merge, { environment: pageBound });

    const first = await shallow.call("docsfab_history_log", {});
    expect(first.entries).toEqual([expect.objectContaining({ commit: merge })]);
    expect(first.labels).toEqual([]);
    // The walk is not over, so only the listed cut commit can carry the label.
    const second = await shallow.call("docsfab_history_log", { cursor: first.nextCursor });
    const listed = second.entries as Array<{ commit: string; parents: string[] }>;
    expect(listed).toHaveLength(1);
    expect([main, side]).toContain(listed[0]!.commit);
    expect(listed[0]!.parents).toEqual([]);
    expect(second.nextCursor).not.toBeNull();
    expect(second.labels).toEqual(["history-shallow"]);
    expect(shallow.toolSet.getHistoryReads()!.map((entry) => entry.labels)).toEqual([
      [],
      ["history-shallow"],
    ]);
    const third = await shallow.call("docsfab_history_log", { cursor: second.nextCursor });
    expect(third).toMatchObject({ labels: ["history-shallow"], nextCursor: null });
    // Control: the same mid-walk page in the full history lists a commit with parents, unlabelled.
    const full = await historyTools(fixture.repository, merge, { environment: pageBound });
    const fullFirst = await full.call("docsfab_history_log", {});
    const fullSecond = await full.call("docsfab_history_log", { cursor: fullFirst.nextCursor });
    expect((fullSecond.entries as Array<{ parents: string[] }>)[0]!.parents).toHaveLength(1);
    expect(fullSecond.labels).toEqual([]);
  });

  it("refuses a missing promisor blob as unavailable under a git that ignores GIT_NO_LAZY_FETCH", async () => {
    const fixture = await historyFixture(roots);
    const partial = await cloneFixture(fixture, "partial", ["--filter=blob:none"]);
    const fetchAttempts: string[][] = [];
    const { call, refusal, categories } = await historyTools(partial, fixture.head, {
      git: lazyFetchingGit(fetchAttempts),
    });
    // Control: this git does try a lazy fetch, which the protocol policy blocks.
    const blob = await fixtureGit(partial, ["rev-parse", `${fixture.base}:src/app.ts`]);
    await expect(
      lazyFetchingGit(fetchAttempts)(partial, ["cat-file", "-e", blob]),
    ).rejects.toMatchObject({
      kind: "exit",
      exitCode: 128,
    });
    expect(fetchAttempts).toHaveLength(1);
    fetchAttempts.length = 0;

    for (const [tool, parameters] of [
      ["docsfab_history_show", { path: "src/app.ts", revision: fixture.base }],
      ["docsfab_history_diff", { base: fixture.base, head: "head", paths: ["src/app.ts"] }],
      ["docsfab_history_show", { path: "src/app.ts", revision: "f".repeat(40) }],
    ] as const) {
      expect(refusalCode(await refusal(tool, parameters)), tool).toBe("history-object-unavailable");
    }
    expect(categories()).toEqual({ "recoverable-miss": 3 });
    // The tools ask the local store first, so no read even attempts a fetch.
    expect(fetchAttempts).toEqual([]);
    // Adjacent: an object the clone holds still reads, labelled.
    expect(
      await call("docsfab_history_show", { path: "src/app.ts", revision: "head" }),
    ).toMatchObject({ text: HEAD_APP, labels: ["history-partial-clone"] });
    await expect(
      fixtureGit(partial, ["--no-lazy-fetch", "cat-file", "-e", blob]).catch(() => "absent"),
    ).resolves.toBe("absent");
  });

  it("maps a corrupt object in a full clone to a defect, not a missing object", async () => {
    const fixture = await historyFixture(roots);
    const blob = await fixtureGit(fixture.repository, ["rev-parse", `${fixture.base}:src/app.ts`]);
    const file = join(fixture.repository, ".git", "objects", blob.slice(0, 2), blob.slice(2));
    await chmod(file, 0o644);
    await writeFile(file, "not a zlib stream");
    const { refusal, categories, call } = await historyTools(fixture.repository, fixture.head);

    const message = await refusal("docsfab_history_show", {
      path: "src/app.ts",
      revision: fixture.base,
    });
    expect(refusalCode(message)).toBe("history-git-failed");
    expect(categories()).toEqual({ "tool-defect": 1 });
    // Control: an intact object in the same checkout reads.
    expect(
      (await call("docsfab_history_show", { path: "src/app.ts", revision: "head" })).text,
    ).toBe(HEAD_APP);
  });
});

describe("docsfab_history_diff", { timeout: HISTORY_TEST_TIMEOUT_MS }, () => {
  it("diffs base to head, leaves a credential-bearing path out, and labels the count", async () => {
    const fixture = await historyFixture(roots);
    const { text, refusal, toolSet, categories } = await historyTools(
      fixture.repository,
      fixture.head,
    );

    const raw = await text("docsfab_history_diff", { base: fixture.base, head: "head" });
    const page = JSON.parse(raw) as ToolPage & {
      files: Array<{ path: string; patch: string }>;
    };
    expect(page.files.map((file) => file.path)).toEqual(["docs/guide.md", "src/app.ts"]);
    expect(page.files[1]!.patch).toContain("-export const answer = 1;\n+export const answer = 2;");
    expect(page.files[1]!.patch).toContain("--- a/src/app.ts\n+++ b/src/app.ts");
    expect(raw).not.toContain(".env");
    expect(raw).not.toContain("LOG_LEVEL");
    expect(page).toMatchObject({ excludedFiles: 1, labels: ["history-paths-excluded"] });
    const [citation] = toolSet.getHistoryReads()!;
    expect(citation).toMatchObject({
      tool: "docsfab_history_diff",
      revisions: [fixture.base, fixture.head],
      paths: ["docs/guide.md", "src/app.ts"],
      labels: ["history-paths-excluded"],
      excludedPathCount: 1,
      sha256: sha256(raw),
    });
    // The path argument is screened too.
    const refused = await refusal("docsfab_history_diff", {
      base: fixture.base,
      head: "head",
      paths: [".env"],
    });
    expect(refusalCode(refused)).toBe("history-path-refused");
    expect(categories()).toEqual({ "denied-path": 1 });
  });

  it("withholds only the file whose patch holds a configured credential", async () => {
    const fixture = await historyFixture(roots);
    const secret = configureCredential(plantedCredentialValue(1989));
    const head = await commitFiles(
      fixture.repository,
      { "config/service.txt": `endpoint token ${secret}\n`, "src/app.ts": "three\n" },
      "Configure",
    );
    const { text, toolSet } = await historyTools(fixture.repository, head);

    const raw = await text("docsfab_history_diff", { base: fixture.head, head: "head" });
    expect(raw).not.toContain(secret);
    const page = JSON.parse(raw) as { files: Array<Record<string, unknown>> };
    expect(page.files).toEqual([
      { path: "config/service.txt", withheld: true },
      expect.objectContaining({ path: "src/app.ts" }),
    ]);
    expect(toolSet.getHistoryReads()![0]!.paths).toEqual(["src/app.ts"]);
  });
});

describe("diff path sections", { timeout: HISTORY_TEST_TIMEOUT_MS }, () => {
  const MARKER = "CRITIC_MARKER_ENV_LEAK=1";

  /** A file `cfg` that becomes a directory holding `.env` and a README, then a file again. */
  async function swapFixture() {
    const fixture = await historyFixture(roots);
    const file = await commitFiles(fixture.repository, { cfg: "plain\n" }, "cfg is a file");
    await fixtureGit(fixture.repository, ["rm", "--quiet", "cfg"]);
    const directory = await commitFiles(
      fixture.repository,
      { "cfg/.env": `${MARKER}\n`, "cfg/README.md": "settings\n" },
      "cfg is a directory",
    );
    await fixtureGit(fixture.repository, ["rm", "--quiet", "-r", "cfg"]);
    const fileAgain = await commitFiles(fixture.repository, { cfg: "plain again\n" }, "cfg again");
    return { fixture, file, directory, fileAgain };
  }

  function sectionHeaders(patch: string): string[] {
    return patch.split("\n").filter((line) => line.startsWith("diff --git "));
  }

  it("serves only the file's own section when a file becomes a directory, or back", async () => {
    const { fixture, file, directory, fileAgain } = await swapFixture();
    const { text, toolSet } = await historyTools(fixture.repository, fileAgain);

    for (const [base, head, paths] of [
      [file, directory, undefined],
      [directory, fileAgain, undefined],
      [file, directory, ["cfg"]],
      [directory, fileAgain, ["cfg"]],
    ] as const) {
      const label = `${base === file ? "file to directory" : "directory to file"} ${paths ? "by path" : "whole"}`;
      const raw = await text("docsfab_history_diff", { base, head, ...(paths ? { paths } : {}) });
      expect(raw, label).not.toContain(MARKER);
      const page = JSON.parse(raw) as ToolPage & {
        files: Array<{ path: string; patch: string }>;
        excludedFiles: number;
      };
      expect(
        page.files.map((entry) => entry.path),
        label,
      ).toEqual(["cfg", "cfg/README.md"]);
      expect(page.excludedFiles, label).toBe(1);
      expect(page.labels, label).toEqual(["history-paths-excluded"]);
      for (const entry of page.files) {
        expect(sectionHeaders(entry.patch), `${label}: ${entry.path}`).toEqual([
          `diff --git a/${entry.path} b/${entry.path}`,
        ]);
      }
      // Adjacent: the file side's own change is still served.
      expect(page.files[0]!.patch, label).toContain(base === file ? "-plain\n" : "+plain again\n");
    }
    expect(
      toolSet.getHistoryReads()!.every((citation) => !citation.paths.includes("cfg/.env")),
    ).toBe(true);
  });

  it("serves both sections of a type change and no other path's section", async () => {
    const fixture = await historyFixture(roots);
    const repository = fixture.repository;
    const file = await commitFiles(
      repository,
      { "link.md": "plain\n", sub: "plain\n", "neighbour.md": "one\n" },
      "Files",
    );
    await fixtureGit(repository, ["rm", "--quiet", "link.md"]);
    await symlink("docs/guide.md", join(repository, "link.md"));
    const symlinked = await commitFiles(repository, { "neighbour.md": "two\n" }, "Link");
    await fixtureGit(repository, ["rm", "--quiet", "link.md"]);
    const fileAgain = await commitFiles(
      repository,
      { "link.md": "plain again\n", "neighbour.md": "three\n" },
      "File again",
    );
    // A gitlink without a checkout: staged directly, since `add -A` would drop it.
    await fixtureGit(repository, ["rm", "--quiet", "sub"]);
    await fixtureGit(repository, ["update-index", "--add", "--cacheinfo", `160000,${file},sub`]);
    await writeFile(join(repository, "neighbour.md"), "four\n");
    await fixtureGit(repository, ["add", "neighbour.md"]);
    await fixtureGit(repository, ["commit", "--quiet", "-m", "Submodule"]);
    const gitlink = await fixtureGit(repository, ["rev-parse", "HEAD"]);
    const { call, categories } = await historyTools(repository, gitlink);

    for (const [label, base, head, path, deleted, added, body] of [
      ["file to symlink", file, symlinked, "link.md", "100644", "120000", "+docs/guide.md"],
      ["symlink to file", symlinked, fileAgain, "link.md", "120000", "100644", "+plain again"],
      [
        "file to submodule",
        fileAgain,
        gitlink,
        "sub",
        "100644",
        "160000",
        `+Subproject commit ${file}`,
      ],
    ] as const) {
      for (const paths of [undefined, [path]]) {
        const scope = `${label} ${paths ? "by path" : "whole"}`;
        const page = (await call("docsfab_history_diff", {
          base,
          head,
          ...(paths ? { paths } : {}),
        })) as ToolPage & { files: Array<{ path: string; patch: string }> };
        expect(
          page.files.map((entry) => entry.path),
          scope,
        ).toEqual(paths ? [path] : [path, "neighbour.md"].sort());
        for (const entry of page.files) {
          const headers = sectionHeaders(entry.patch);
          expect(headers.length, `${scope}: ${entry.path}`).toBeGreaterThan(0);
          expect(new Set(headers), `${scope}: ${entry.path}`).toEqual(
            new Set([`diff --git a/${entry.path} b/${entry.path}`]),
          );
        }
        const changed = page.files.find((entry) => entry.path === path)!;
        // Both sections, deletion first, as git writes them.
        expect(sectionHeaders(changed.patch), scope).toHaveLength(2);
        const deletedAt = changed.patch.indexOf(`deleted file mode ${deleted}\n`);
        const addedAt = changed.patch.indexOf(`new file mode ${added}\n`);
        expect(deletedAt, scope).toBeGreaterThan(0);
        expect(addedAt, scope).toBeGreaterThan(deletedAt);
        expect(changed.patch, scope).toContain(`${body}\n`);
      }
    }
    expect(categories()).toEqual({});
  });

  it("matches the section of a path git quotes in its patch header", async () => {
    const fixture = await historyFixture(roots);
    const names = [
      'doc "quoted".md',
      "tab\there.md",
      "back\\slash.md",
      "esc\u001b.md",
      "del\u007f.md",
      "sp ace.md",
      "ünï.md",
    ];
    const head = await commitFiles(
      fixture.repository,
      Object.fromEntries(names.map((name) => [name, `${name} body\n`])),
      "Awkward names",
    );
    const { call } = await historyTools(fixture.repository, head);
    const page = (await call("docsfab_history_diff", {
      base: fixture.head,
      head: "head",
    })) as ToolPage & {
      files: Array<{ path: string; patch: string }>;
    };
    expect(page.files.map((entry) => entry.path).sort()).toEqual([...names].sort());
    for (const entry of page.files) {
      expect(sectionHeaders(entry.patch), entry.path).toHaveLength(1);
      expect(entry.patch, entry.path).toContain(`+${entry.path} body`);
    }
  });
});

describe("history credentials and host roots", { timeout: HISTORY_TEST_TIMEOUT_MS }, () => {
  it("refuses a configured credential committed at the base and cites nothing", async () => {
    const fixture = await historyFixture(roots);
    const secret = configureCredential(plantedCredentialValue(7));
    const base = await commitFiles(fixture.repository, { "notes.txt": `key ${secret}\n` }, "Leak");
    const head = await commitFiles(fixture.repository, { "notes.txt": "rotated\n" }, "Rotate");
    const { refusal, call, toolSet } = await historyTools(fixture.repository, head);

    const message = await refusal("docsfab_history_show", { path: "notes.txt", revision: base });
    expect(message).toBe(BOUNDARY_MESSAGE);
    expect(toolSet.getHistoryReads()).toBeUndefined();
    // Control: the rotated file at head is served and cited.
    expect((await call("docsfab_history_show", { path: "notes.txt", revision: "head" })).text).toBe(
      "rotated\n",
    );
    expect(toolSet.getHistoryReads()).toHaveLength(1);
  });

  it("refuses a page whose path names a configured credential and cites nothing", async () => {
    const fixture = await historyFixture(roots);
    const secret = configureCredential(plantedCredentialValue(23));
    const head = await commitFiles(
      fixture.repository,
      { [`notes/${secret}.txt`]: "benign content\n" },
      "Name",
    );
    const { refusal, toolSet } = await historyTools(fixture.repository, head);

    // The file text is clean; only the page's own path field carries the value,
    // so the confined result screen, not the text screen, refuses it.
    const message = await refusal("docsfab_history_show", {
      path: `notes/${secret}.txt`,
      revision: "head",
    });
    expect(message).toBe(BOUNDARY_MESSAGE);
    expect(toolSet.getHistoryReads()).toBeUndefined();
  });

  it("serves an unconfigured credential shape at an old revision and masks a host root", async () => {
    const fixture = await historyFixture(roots);
    const shaped = `glpat-${plantedCredentialValue(11)}`;
    const base = await commitFiles(
      fixture.repository,
      { "notes.txt": `token ${shaped}\nbuilt in ${fixture.repository}/src\n` },
      "Shape",
    );
    const head = await commitFiles(fixture.repository, { "notes.txt": "clean\n" }, "Clean");
    const { text, toolSet } = await historyTools(fixture.repository, head);

    const raw = await text("docsfab_history_show", { path: "notes.txt", revision: base });
    const page = JSON.parse(raw) as { text: string };
    expect(page.text).toContain(shaped);
    expect(page.text).not.toContain(fixture.repository);
    expect(toolSet.getHistoryReads()![0]!.sha256).toBe(sha256(raw));
  });
});

describe("history bounds and cursors", { timeout: HISTORY_TEST_TIMEOUT_MS }, () => {
  it("returns exactly logMaxEntries without a cursor and pages one more", async () => {
    const fixture = await historyFixture(roots);
    let head = fixture.head;
    // The fixture holds two commits; add enough for exactly the bound.
    for (let index = 2; index < LOG_MAX_ENTRIES; index += 1) {
      head = await commitFiles(fixture.repository, {}, `Commit ${String(index)}`);
    }
    const atBound = await historyTools(fixture.repository, head);
    const whole = await atBound.call("docsfab_history_log", {});
    expect((whole.entries as unknown[]).length).toBe(LOG_MAX_ENTRIES);
    expect(whole.nextCursor).toBeNull();

    const extra = await commitFiles(fixture.repository, {}, "One more");
    const overBound = await historyTools(fixture.repository, extra);
    const first = await overBound.call("docsfab_history_log", {});
    expect((first.entries as unknown[]).length).toBe(LOG_MAX_ENTRIES);
    expect(first.nextCursor).toEqual(expect.any(String));
    const rest = await overBound.call("docsfab_history_log", { cursor: first.nextCursor });
    expect(rest.entries).toEqual([expect.objectContaining({ commit: fixture.base, parents: [] })]);
    expect(rest.nextCursor).toBeNull();
    expect(overBound.toolSet.getHistoryReads()!.map((entry) => entry.ranges)).toEqual([
      [{ path: null, unit: "entries", start: 0, end: LOG_MAX_ENTRIES }],
      [{ path: null, unit: "entries", start: LOG_MAX_ENTRIES, end: LOG_MAX_ENTRIES + 1 }],
    ]);
  });

  it("serves a file whose page is exactly responseMaxBytes whole and pages one byte more", async () => {
    const fixture = await historyFixture(roots);
    // The envelope a one-line file of this digit width costs, read from a real page.
    const probeSize = 10_000;
    const probe = await bigFileFixture(fixture, probeSize);
    const probeText = await (await historyTools(fixture.repository, probe)).text(
      "docsfab_history_show",
      { path: "big.txt", revision: "head" },
    );
    const envelope = Buffer.byteLength(probeText) - probeSize;

    const atBound = await bigFileFixture(fixture, RESPONSE_MAX_BYTES - envelope);
    const exact = await historyTools(fixture.repository, atBound);
    const whole = await exact.text("docsfab_history_show", { path: "big.txt", revision: "head" });
    expect(Buffer.byteLength(whole)).toBe(RESPONSE_MAX_BYTES);
    expect((JSON.parse(whole) as ToolPage).nextCursor).toBeNull();

    const overBound = await bigFileFixture(fixture, RESPONSE_MAX_BYTES - envelope + 1);
    const paged = await historyTools(fixture.repository, overBound);
    const first = await paged.text("docsfab_history_show", { path: "big.txt", revision: "head" });
    expect(Buffer.byteLength(first)).toBeLessThanOrEqual(RESPONSE_MAX_BYTES);
    const firstPage = JSON.parse(first) as ToolPage & { text: string };
    expect(firstPage.nextCursor).toEqual(expect.any(String));
    const second = await paged.call("docsfab_history_show", { cursor: firstPage.nextCursor });
    expect(second.nextCursor).toBeNull();
    expect(`${firstPage.text}${second.text as string}`).toBe(
      "x".repeat(RESPONSE_MAX_BYTES - envelope + 1),
    );
  });

  it("admits pathsMaxPerCall paths, refuses one more by its code, and pages a wider diff", async () => {
    const fixture = await historyFixture(roots);
    const files = Object.fromEntries(
      Array.from({ length: PATHS_MAX_PER_CALL + 1 }, (_, index) => [
        `many/file-${String(index).padStart(4, "0")}.txt`,
        `${String(index)}\n`,
      ]),
    );
    const head = await commitFiles(fixture.repository, files, "Many files");
    const { call, refusal, categories } = await historyTools(fixture.repository, head);
    const paths = Object.keys(files);

    const admitted = await call("docsfab_history_diff", {
      base: fixture.head,
      head: "head",
      paths: paths.slice(0, PATHS_MAX_PER_CALL),
    });
    expect((admitted.files as unknown[]).length).toBe(PATHS_MAX_PER_CALL);
    expect(admitted.nextCursor).toBeNull();
    const refused = await refusal("docsfab_history_diff", {
      base: fixture.head,
      head: "head",
      paths,
    });
    expect(refusalCode(refused)).toBe("git-history-paths-max-per-call-bound");
    expect(categories()).toEqual({ "recoverable-miss": 1 });
    // Output fan-out: one more changed file than a page may cover.
    const wide = await call("docsfab_history_diff", { base: fixture.head, head: "head" });
    expect((wide.files as unknown[]).length).toBe(PATHS_MAX_PER_CALL);
    const rest = await call("docsfab_history_diff", { cursor: wide.nextCursor });
    expect(rest.files).toEqual([
      expect.objectContaining({
        path: `many/file-${String(PATHS_MAX_PER_CALL).padStart(4, "0")}.txt`,
      }),
    ]);
  });

  it("holds cursorsMaxPerToolSet cursors, reuses one for the same page, and refuses one more", async () => {
    const fixture = await historyFixture(roots);
    const head = await bigFileFixture(fixture, RESPONSE_MAX_BYTES * 4);
    const bound = 2;
    const { call, refusal } = await historyTools(fixture.repository, head, {
      environment: { DOCSFAB_GIT_HISTORY_CURSORS_MAX_PER_TOOL_SET: String(bound) },
    });
    const first = await call("docsfab_history_show", { path: "big.txt", revision: "head" });
    const again = await call("docsfab_history_show", { path: "big.txt", revision: "head" });
    expect(again.nextCursor).toBe(first.nextCursor);
    const second = await call("docsfab_history_show", { cursor: first.nextCursor });
    expect(second.nextCursor).toEqual(expect.any(String));
    const message = await refusal("docsfab_history_show", { cursor: second.nextCursor });
    expect(refusalCode(message)).toBe("git-history-cursors-max-per-tool-set-bound");
    expect(message).toContain(`${String(bound + 1)} exceeds gitHistory.cursorsMaxPerToolSet`);
  });

  it("reads arguments a model filled with empty values as omitted, and counts them", async () => {
    const fixture = await historyFixture(roots);
    const { call, toolSet } = await historyTools(fixture.repository, fixture.head);
    // The shape a live model sent: every declared argument, the unused ones empty.
    const plain = await call("docsfab_history_log", {
      path: "src/app.ts",
      range: { to: "head" },
    });
    const filled = await call("docsfab_history_log", {
      path: "src/app.ts",
      range: { from: "", to: "head" },
      cursor: "",
    });
    expect(filled).toEqual(plain);
    const shown = await call("docsfab_history_show", {
      path: "src/app.ts",
      revision: "head",
      cursor: null,
    });
    expect(shown).toMatchObject({ revision: fixture.head, text: HEAD_APP });
    expect(toolSet.getToolArgumentFiller()).toEqual([
      {
        tool: "docsfab_history_log",
        argument: "cursor",
        kind: "empty",
        count: 1,
      },
      {
        tool: "docsfab_history_log",
        argument: "range.from",
        kind: "empty",
        count: 1,
      },
      {
        tool: "docsfab_history_show",
        argument: "cursor",
        kind: "null",
        count: 1,
      },
    ]);
  });

  it("refuses a cursor replayed with other arguments, to another tool, or forged", async () => {
    const fixture = await historyFixture(roots);
    const head = await bigFileFixture(fixture, RESPONSE_MAX_BYTES * 2);
    const { call, refusal } = await historyTools(fixture.repository, head);
    const first = await call("docsfab_history_show", { path: "big.txt", revision: "head" });
    const cursor = first.nextCursor;

    const replays: Array<[string, Record<string, unknown>]> = [
      ["docsfab_history_show", { cursor, revision: fixture.head }],
      ["docsfab_history_show", { cursor, path: "src/app.ts" }],
      ["docsfab_history_diff", { cursor }],
      ["docsfab_history_log", { cursor }],
      ["docsfab_history_show", { cursor: `hc-${"0".repeat(32)}` }],
      ["docsfab_history_show", { cursor: JSON.stringify({ revision: fixture.base, offset: 0 }) }],
    ];
    for (const [tool, parameters] of replays) {
      expect(refusalCode(await refusal(tool, parameters)), JSON.stringify(parameters)).toBe(
        "history-cursor-invalid",
      );
    }
    // Control: the same cursor with matching arguments continues.
    const next = await call("docsfab_history_show", { cursor, path: "big.txt", revision: "head" });
    expect(next.byteRange).toEqual(expect.objectContaining({ start: expect.any(Number) }));
  });

  it("refuses a file over hostInvoker.gitOutputMaxBytes before reading it, and reads one at it", {
    timeout: testTimeoutMs(120_000),
  }, async () => {
    const fixture = await historyFixture(roots);
    const atBound = await bigFileFixture(fixture, GIT_OUTPUT_MAX_BYTES);
    const reader = await historyTools(fixture.repository, atBound);
    const page = await reader.call("docsfab_history_show", { path: "big.txt", revision: "head" });
    expect(page.totalBytes).toBe(GIT_OUTPUT_MAX_BYTES);
    const overBound = await bigFileFixture(fixture, GIT_OUTPUT_MAX_BYTES + 1);
    const over = await historyTools(fixture.repository, overBound);
    expect(
      refusalCode(
        await over.refusal("docsfab_history_show", { path: "big.txt", revision: "head" }),
      ),
    ).toBe("history-object-too-large");
  });

  it("refuses to build when responseMaxBytes is above the tool output cap and builds at it", async () => {
    const fixture = await historyFixture(roots);
    await expect(
      historyTools(fixture.repository, fixture.head, { toolOutputCapBytes: RESPONSE_MAX_BYTES }),
    ).resolves.toBeDefined();
    await expect(
      historyTools(fixture.repository, fixture.head, {
        toolOutputCapBytes: RESPONSE_MAX_BYTES - 1,
      }),
    ).rejects.toThrow(
      `git-history-response-max-bytes-bound: gitHistory.responseMaxBytes is ${String(RESPONSE_MAX_BYTES)} bytes, above the per-call tool output cap of ${String(RESPONSE_MAX_BYTES - 1)} bytes.`,
    );
  });

  it("codes a git timeout by its limit and keeps an exit and a spawn failure as defects", async () => {
    const fixture = await historyFixture(roots);
    const failing =
      (kind: "timeout" | "exit" | "spawn"): GitRunner =>
      async (cwd, args, maximumBytes, input) => {
        if (args.includes("cat-file") && args.includes("blob")) {
          throw new TrustedGitError(kind, "injected", kind === "exit" ? 128 : null);
        }
        return runTrustedGit(cwd, args, undefined, maximumBytes, input);
      };
    const timeout = await historyTools(fixture.repository, fixture.head, {
      git: failing("timeout"),
    });
    const timedOut = await timeout.refusal("docsfab_history_show", {
      path: "src/app.ts",
      revision: "head",
    });
    expect(refusalCode(timedOut)).toBe("history-timeout");
    expect(timedOut).toContain("hostInvoker.gitTimeoutMs");
    expect(timeout.categories()).toEqual({ "recoverable-miss": 1 });
    // Exit statuses the probes read as "no": any other status is not "no".
    const exitOn =
      (match: (args: readonly string[]) => boolean): GitRunner =>
      async (cwd, args, maximumBytes, input) => {
        if (match(args)) throw new TrustedGitError("exit", "injected", 128);
        return runTrustedGit(cwd, args, undefined, maximumBytes, input);
      };
    const ancestry = await historyTools(fixture.repository, fixture.head, {
      git: exitOn((args) => args.includes("merge-base")),
    });
    const notAncestor = await ancestry.refusal("docsfab_history_show", {
      path: "src/app.ts",
      revision: fixture.base,
    });
    expect(refusalCode(notAncestor)).toBe("history-git-failed");
    const promisor = await historyTools(fixture.repository, fixture.head, {
      git: exitOn((args) => args.includes("--get-regexp")),
    });
    expect(
      refusalCode(
        await promisor.refusal("docsfab_history_show", { path: "src/app.ts", revision: "head" }),
      ),
    ).toBe("history-git-failed");
    const presence = await historyTools(fixture.repository, fixture.head, {
      git: exitOn(
        (args) => args.includes("-e") || (args.includes("-s") && args.includes("cat-file")),
      ),
    });
    expect(
      refusalCode(
        await presence.refusal("docsfab_history_show", { path: "src/app.ts", revision: "head" }),
      ),
    ).toBe("history-git-failed");
    // A probe that timed out once is read again on the next call, not remembered.
    let shallowProbes = 0;
    const flaky = await historyTools(fixture.repository, fixture.head, {
      git: async (cwd, args, maximumBytes, input) => {
        if (args.includes("--is-shallow-repository") && shallowProbes++ === 0) {
          throw new TrustedGitError("timeout", "injected");
        }
        return runTrustedGit(cwd, args, undefined, maximumBytes, input);
      },
    });
    expect(refusalCode(await flaky.refusal("docsfab_history_log", {}))).toBe("history-timeout");
    expect((await flaky.call("docsfab_history_log", {})).entries).toHaveLength(2);
    for (const kind of ["exit", "spawn"] as const) {
      const tools = await historyTools(fixture.repository, fixture.head, { git: failing(kind) });
      const message = await tools.refusal("docsfab_history_show", {
        path: "src/app.ts",
        revision: "head",
      });
      expect(refusalCode(message), kind).toBe("history-git-failed");
      expect(tools.categories()).toEqual({ "tool-defect": 1 });
    }
  });
});

describe("history refusal categories", { timeout: HISTORY_TEST_TIMEOUT_MS }, () => {
  it("records each code under its category", async () => {
    const fixture = await historyFixture(roots);
    const partial = await cloneFixture(fixture, "partial", ["--filter=blob:none"]);
    const [first] = await collidingCommits(fixture);
    const big = await bigFileFixture(fixture, GIT_OUTPUT_MAX_BYTES + 1);
    const outputHead = await commitFiles(
      fixture.repository,
      { "huge.txt": "y\n".repeat(GIT_OUTPUT_MAX_BYTES / 2 + 1) },
      "Huge",
    );
    const binaryHead = await commitFiles(
      fixture.repository,
      { "logo.bin": Buffer.from([0, 1, 2]) },
      "Binary",
    );
    const corruptBlob = await fixtureGit(fixture.repository, [
      "rev-parse",
      `${fixture.base}:docs/guide.md`,
    ]);
    const corruptFile = join(
      fixture.repository,
      ".git",
      "objects",
      corruptBlob.slice(0, 2),
      corruptBlob.slice(2),
    );
    await chmod(corruptFile, 0o644);
    await writeFile(corruptFile, "corrupt");
    const timeoutRunner: GitRunner = async (cwd, args, maximumBytes, input) => {
      if (args.includes("cat-file") && args.includes("blob")) {
        throw new TrustedGitError("timeout", "injected");
      }
      return runTrustedGit(cwd, args, undefined, maximumBytes, input);
    };
    const cases: Record<
      (typeof GIT_HISTORY_CODES)[number],
      { repository?: string; head: string; git?: GitRunner; tool: string; parameters: object }
    > = {
      "history-arguments-invalid": {
        head: fixture.head,
        tool: "docsfab_history_show",
        parameters: { path: "src/app.ts", revision: "head", extra: true },
      },
      "history-revision-invalid": {
        head: fixture.head,
        tool: "docsfab_history_show",
        parameters: { path: "src/app.ts", revision: "HEAD" },
      },
      "history-revision-ambiguous": {
        head: fixture.head,
        tool: "docsfab_history_show",
        parameters: { path: "src/app.ts", revision: first.slice(0, 7) },
      },
      "history-revision-out-of-scope": {
        head: fixture.base,
        tool: "docsfab_history_show",
        parameters: { path: "src/app.ts", revision: fixture.head },
      },
      "history-object-missing": {
        head: fixture.head,
        tool: "docsfab_history_show",
        parameters: { path: "src/app.ts", revision: "f".repeat(40) },
      },
      "history-object-unavailable": {
        repository: partial,
        head: fixture.head,
        tool: "docsfab_history_show",
        parameters: { path: "src/app.ts", revision: fixture.base },
      },
      "history-object-too-large": {
        head: big,
        tool: "docsfab_history_show",
        parameters: { path: "big.txt", revision: "head" },
      },
      "history-object-binary": {
        head: binaryHead,
        tool: "docsfab_history_show",
        parameters: { path: "logo.bin", revision: "head" },
      },
      "history-output-too-large": {
        head: outputHead,
        tool: "docsfab_history_diff",
        parameters: { base: big, head: "head", paths: ["huge.txt"] },
      },
      "history-path-refused": {
        head: fixture.head,
        tool: "docsfab_history_show",
        parameters: { path: "../outside", revision: "head" },
      },
      "history-path-missing": {
        head: fixture.head,
        tool: "docsfab_history_show",
        parameters: { path: "absent.txt", revision: "head" },
      },
      "history-path-not-file": {
        head: fixture.head,
        tool: "docsfab_history_show",
        parameters: { path: "docs", revision: "head" },
      },
      "history-cursor-invalid": {
        head: fixture.head,
        tool: "docsfab_history_log",
        parameters: { cursor: "hc-forged" },
      },
      "history-line-range-invalid": {
        head: fixture.head,
        tool: "docsfab_history_blame",
        parameters: { path: "src/app.ts", revision: "head", startLine: 1, endLine: 2 },
      },
      "history-timeout": {
        head: fixture.head,
        git: timeoutRunner,
        tool: "docsfab_history_show",
        parameters: { path: "src/app.ts", revision: "head" },
      },
      "history-git-failed": {
        head: fixture.head,
        tool: "docsfab_history_show",
        parameters: { path: "docs/guide.md", revision: fixture.base },
      },
    };
    expect(Object.keys(cases).sort()).toEqual([...GIT_HISTORY_CODES].sort());
    for (const [code, scenario] of Object.entries(cases)) {
      const tools = await historyTools(scenario.repository ?? fixture.repository, scenario.head, {
        ...(scenario.git ? { git: scenario.git } : {}),
      });
      const message = await tools.refusal(
        scenario.tool,
        scenario.parameters as Record<string, unknown>,
      );
      expect(refusalCode(message), code).toBe(code);
      expect(tools.categories(), code).toEqual({
        [GIT_HISTORY_CODE_CATEGORIES[code as keyof typeof GIT_HISTORY_CODE_CATEGORIES]]: 1,
      });
      expect(tools.toolSet.getHistoryReads(), code).toBeUndefined();
    }
    expect(GIT_HISTORY_CODE_CATEGORIES).toEqual({
      "history-arguments-invalid": "malformed-arguments",
      "history-revision-invalid": "malformed-arguments",
      "history-revision-ambiguous": "malformed-arguments",
      "history-revision-out-of-scope": "recoverable-miss",
      "history-object-missing": "recoverable-miss",
      "history-object-unavailable": "recoverable-miss",
      "history-object-too-large": "recoverable-miss",
      "history-object-binary": "recoverable-miss",
      "history-output-too-large": "recoverable-miss",
      "history-path-refused": "denied-path",
      "history-path-missing": "recoverable-miss",
      "history-path-not-file": "recoverable-miss",
      "history-cursor-invalid": "recoverable-miss",
      "history-line-range-invalid": "malformed-arguments",
      "history-timeout": "recoverable-miss",
      "history-git-failed": "tool-defect",
    });
  });
});

describe("history tool registration", () => {
  it("registers the five tools only with a history reader", async () => {
    const fixture = await historyFixture(roots);
    const without = await createConfinedToolSet({
      workspacePath: fixture.root,
      allowWrite: false,
    });
    expect(without.definitions.map((tool) => tool.name)).not.toContain("docsfab_history_show");
    const { toolSet } = await historyTools(fixture.repository, fixture.head);
    expect(
      toolSet.definitions
        .map((tool) => tool.name)
        .filter((name) => name.startsWith("docsfab_history")),
    ).toEqual([...HISTORY_TOOL_NAMES]);
    expect(HISTORY_TOOL_NAMES).toEqual([
      "docsfab_history_blame",
      "docsfab_history_diff",
      "docsfab_history_log",
      "docsfab_history_search",
      "docsfab_history_show",
    ]);
  });
});

/** Commit a one-line file of exactly `bytes` bytes as `big.txt` and return the commit. */
async function bigFileFixture(fixture: HistoryFixture, bytes: number): Promise<string> {
  return commitFiles(fixture.repository, { "big.txt": "x".repeat(bytes) }, `Big ${String(bytes)}`);
}

function commonPrefixLength(left: string, right: string): number {
  let index = 0;
  while (index < left.length && left[index] === right[index]) index += 1;
  return index;
}

/**
 * Two commit objects whose ids share their first seven hex characters, found
 * by varying the message and hashing locally, then written to the store. They
 * are not in head's history.
 */
async function collidingCommits(fixture: HistoryFixture): Promise<[string, string]> {
  const tree = await fixtureGit(fixture.repository, ["rev-parse", `${fixture.base}^{tree}`]);
  const seen = new Map<string, string>();
  const identity = "Fixture <fixture@example.invalid> 1790000000 +0000";
  for (let index = 0; ; index += 1) {
    const body = `tree ${tree}\nauthor ${identity}\ncommitter ${identity}\n\ncollision ${String(index)}\n`;
    const id = createHash("sha1")
      .update(`commit ${String(Buffer.byteLength(body))}\0${body}`)
      .digest("hex");
    const prefix = id.slice(0, 7);
    const other = seen.get(prefix);
    if (other !== undefined) {
      const first = await fixtureGit(
        fixture.repository,
        ["hash-object", "-t", "commit", "-w", "--stdin"],
        other,
      );
      const second = await fixtureGit(
        fixture.repository,
        ["hash-object", "-t", "commit", "-w", "--stdin"],
        body,
      );
      return [first, second];
    }
    seen.set(prefix, body);
  }
}
