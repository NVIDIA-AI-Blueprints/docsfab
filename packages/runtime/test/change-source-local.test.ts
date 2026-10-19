// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `resolveLocalChangeSource` over real local git fixtures: range semantics,
 * integrity, history, hardening, bounds, encoding and credential screening.
 * Every assertion reads the decoded contract or the exact diff bytes.
 */
import { chmod, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { inflateSync } from "node:zlib";

import { afterEach, describe, expect, it } from "vitest";

import { limit, OperationalLimitError } from "../src/config/limits.js";
import {
  ChangeSourceError,
  decodeChangeSourceV1,
  GIT_EMPTY_TREE_IDS,
  parseChangeSourceSelector,
  type ChangeSourceRefusalCode,
} from "../src/inputs/change-source.js";
import {
  changeSourceLimits,
  resolveLocalChangeSource,
  type ResolvedLocalChangeSourceV1,
} from "../src/inputs/change-source/local.js";
import { configureCredential } from "./helpers/configured-credential.js";
import { temporaryRoots } from "./helpers/temp.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";
import {
  commitFiles,
  fixtureDate,
  fixtureGit,
  initChangeRepository,
  rewriteLooseObject,
} from "./support/change-source-fixture.js";

const roots = temporaryRoots();
const overrides: string[] = [];

/** Set a host override for this test only. */
function override(variable: string, value: number): void {
  overrides.push(variable);
  process.env[variable] = String(value);
}

afterEach(() => {
  for (const variable of overrides.splice(0)) delete process.env[variable];
});

async function repository(files?: Readonly<Record<string, string | Uint8Array | null>>) {
  return initChangeRepository(await roots.create("docsfab-change-source-"), files);
}

async function resolve(
  repo: string,
  selector: string,
  extra: { readonly observeGit?: (args: readonly string[]) => void } = {},
): Promise<ResolvedLocalChangeSourceV1> {
  return resolveLocalChangeSource({
    sourcePath: repo,
    selector: parseChangeSourceSelector(selector),
    workspaceRevision: await fixtureGit(repo, ["rev-parse", "HEAD"]),
    ...extra,
  });
}

async function refusal(promise: Promise<unknown>): Promise<ChangeSourceError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(ChangeSourceError);
  return error as ChangeSourceError;
}

async function expectRefusal(
  promise: Promise<unknown>,
  code: ChangeSourceRefusalCode,
): Promise<ChangeSourceError> {
  const error = await refusal(promise);
  expect(error.code).toBe(code);
  return error;
}

function diffText(resolved: ResolvedLocalChangeSourceV1): string {
  return new TextDecoder().decode(resolved.diffBytes);
}

function changedPaths(resolved: ResolvedLocalChangeSourceV1): Array<string | null> {
  return resolved.changeSource.files.map((file) => file.newPath ?? file.oldPath);
}

describe("change-source range semantics", () => {
  it("diffs two-dot from base and three-dot from the merge base, listing head ^diff-base", async () => {
    const { repository: repo } = await repository({ "a.txt": "a0\n", "b.txt": "b0\n" });
    const root = await fixtureGit(repo, ["rev-parse", "HEAD"]);
    await fixtureGit(repo, ["checkout", "-q", "-b", "feature"]);
    const feature = await commitFiles(repo, { "b.txt": "b1\n" }, "feature change");
    await fixtureGit(repo, ["checkout", "-q", "main"]);
    const main = await commitFiles(repo, { "a.txt": "a1\n" }, "main change");

    const twoDot = await resolve(repo, "main..feature");
    expect(twoDot.changeSource.rangeSemantics).toBe("two-dot");
    expect(twoDot.changeSource.revision.base).toBe(main);
    expect(twoDot.changeSource.diffFrom).toBe(main);
    expect(twoDot.changeSource.mergeBase).toBe(root);
    expect(twoDot.changeSource.commits.map((commit) => commit.id)).toEqual([feature]);
    expect(changedPaths(twoDot)).toEqual(["a.txt", "b.txt"]);
    // The workspace is on main, which does not contain feature, and main is off
    // feature's history: both labelled, not refused.
    expect(twoDot.changeSource.labels).toEqual([
      "base-not-ancestor-of-head",
      "head-not-ancestor-of-workspace",
    ]);

    const threeDot = await resolve(repo, "main...feature");
    expect(threeDot.changeSource.rangeSemantics).toBe("three-dot");
    expect(threeDot.changeSource.revision.base).toBe(main);
    expect(threeDot.changeSource.diffFrom).toBe(root);
    expect(threeDot.changeSource.mergeBase).toBe(root);
    // Not rev-list's symmetric difference, which would also list `main`.
    expect(threeDot.changeSource.commits.map((commit) => commit.id)).toEqual([feature]);
    expect(changedPaths(threeDot)).toEqual(["b.txt"]);
    expect(threeDot.changeSource.labels).toEqual(["head-not-ancestor-of-workspace"]);
  });

  it("labels a reversed two-dot range, whose diff undoes the base, and not a forward one", async () => {
    const { repository: repo } = await repository({ "a.md": "a0\n" });
    await commitFiles(repo, { "b.md": "b\n" }, "add b");
    await commitFiles(repo, { "c.md": "c\n" }, "add c");
    const reversed = await resolve(repo, "HEAD..HEAD~2");
    expect(reversed.changeSource.commits).toEqual([]);
    expect(reversed.changeSource.files.map((file) => [file.status, file.oldPath])).toEqual([
      ["D", "b.md"],
      ["D", "c.md"],
    ]);
    expect(reversed.changeSource.labels).toEqual(["base-not-ancestor-of-head"]);
    // The adjacent forward range: base is head's ancestor, so no label.
    expect((await resolve(repo, "HEAD~2..HEAD")).changeSource.labels).toEqual([]);
  });

  it("diffs a merge commit against its first parent only, and a root commit against the empty tree", async () => {
    const { repository: repo } = await repository({ "a.txt": "a0\n" });
    const root = await fixtureGit(repo, ["rev-parse", "HEAD"]);
    await fixtureGit(repo, ["checkout", "-q", "-b", "side"]);
    await commitFiles(repo, { "side.txt": "side\n" }, "side change");
    await fixtureGit(repo, ["checkout", "-q", "main"]);
    const mainTip = await commitFiles(repo, { "a.txt": "a1\n" }, "main change");
    await fixtureGit(repo, ["merge", "-q", "--no-ff", "-m", "merge side", "side"]);
    const merge = await fixtureGit(repo, ["rev-parse", "HEAD"]);

    const merged = await resolve(repo, "HEAD");
    expect(merged.changeSource.rangeSemantics).toBe("first-parent-commit");
    expect(merged.changeSource.labels).toEqual([]);
    expect(merged.changeSource.revision.head).toBe(merge);
    expect(merged.changeSource.diffFrom).toBe(mainTip);
    expect(merged.changeSource.revision.base).toBe(mainTip);
    expect(merged.changeSource.commits.map((commit) => commit.id)).toEqual([merge]);
    expect(merged.changeSource.commits[0]!.parents).toHaveLength(2);
    expect(changedPaths(merged)).toEqual(["side.txt"]);

    const rooted = await resolve(repo, root);
    expect(rooted.changeSource.diffFrom).toBeNull();
    expect(rooted.changeSource.revision.base).toBeUndefined();
    expect(rooted.changeSource.baseTree).toBe(GIT_EMPTY_TREE_IDS.sha1);
    expect(rooted.changeSource.files.map((file) => [file.status, file.newPath])).toEqual([
      ["A", "a.txt"],
    ]);
  });

  it.each(["sha1", "sha256"] as const)(
    "accepts a %s head with only its tracked file deleted",
    async (objectFormat) => {
      const { repository: repo } = await initChangeRepository(
        await roots.create("docsfab-change-source-"),
        { "only.md": "one\n" },
        { objectFormat },
      );
      const oldBlob = await fixtureGit(repo, ["rev-parse", "HEAD:only.md"]);
      await commitFiles(repo, { "only.md": null }, "delete only file");

      const resolved = await resolve(repo, "HEAD~1..HEAD");
      expect(resolved.changeSource.objectFormat).toBe(objectFormat);
      expect(resolved.changeSource.headTree).toBe(GIT_EMPTY_TREE_IDS[objectFormat]);
      expect(resolved.changeSource.files).toEqual([
        {
          status: "D",
          similarity: null,
          oldPath: "only.md",
          newPath: null,
          oldMode: "100644",
          newMode: "000000",
          oldBlob,
          newBlob: "0".repeat(oldBlob.length),
          binary: false,
          added: 0,
          removed: 1,
        },
      ]);
      expect(diffText(resolved)).toContain("deleted file mode 100644");
    },
  );

  it("records symbolic names as full ids that later ref moves cannot change", async () => {
    const { repository: repo } = await repository();
    const first = await commitFiles(repo, { "guide.md": "one\n" }, "first");
    const second = await commitFiles(repo, { "guide.md": "two\n" }, "second");
    const resolved = await resolve(repo, "HEAD~1..HEAD");
    expect(resolved.changeSource.revision.base).toBe(first);
    expect(resolved.changeSource.revision.head).toBe(second);
    const before = Buffer.from(resolved.manifestBytes);

    await commitFiles(repo, { "guide.md": "three\n" }, "third");
    expect(Buffer.from(resolved.manifestBytes).equals(before)).toBe(true);
    expect(decodeChangeSourceV1(JSON.parse(before.toString("utf8"))).revision.head).toBe(second);
  });

  it("pairs a rename in the manifest with the diff's rename header", async () => {
    const { repository: repo } = await repository({ "old-name.md": "stable text\n".repeat(20) });
    await commitFiles(
      repo,
      { "old-name.md": null, "new-name.md": "stable text\n".repeat(20) },
      "rename",
    );
    const resolved = await resolve(repo, "HEAD~1..HEAD");
    expect(resolved.changeSource.files).toEqual([
      expect.objectContaining({ status: "R", oldPath: "old-name.md", newPath: "new-name.md" }),
    ]);
    const lines = diffText(resolved).split("\n");
    expect(lines).toContain("rename from old-name.md");
    expect(lines).toContain("rename to new-name.md");
  });
});

describe("change-source integrity", () => {
  it("refuses a well-formed interior commit that no longer hashes to its id", async () => {
    const { repository: repo } = await repository();
    const interior = await commitFiles(repo, { "a.md": "one\n" }, "interior commit");
    await commitFiles(repo, { "a.md": "two\n" }, "head commit");
    await rewriteLooseObject(repo, interior, (body) =>
      Buffer.from(body.toString("latin1").replace("interior commit", "INTERIOR COMMIT"), "latin1"),
    );
    // Positive control: git itself walks the tampered range without complaint.
    expect(await fixtureGit(repo, ["rev-list", "HEAD~2..HEAD"])).toContain(interior);

    const error = await expectRefusal(
      resolve(repo, "HEAD~2..HEAD"),
      "change-source-integrity-mismatch",
    );
    expect(error.detail).toBe("commit 1");
  });

  it("refuses a well-formed head root tree that no longer hashes to its id", async () => {
    const { repository: repo } = await repository({ "a.md": "one\n", "b.md": "bee\n" });
    await commitFiles(repo, { "a.md": "two\n" }, "head commit");
    const tree = await fixtureGit(repo, ["rev-parse", "HEAD^{tree}"]);
    const other = await fixtureGit(repo, ["rev-parse", "HEAD~1^{tree}"]);
    const otherBody = inflateSync(
      await readFile(join(repo, ".git", "objects", other.slice(0, 2), other.slice(2))),
    );
    await rewriteLooseObject(repo, tree, () => otherBody.subarray(otherBody.indexOf(0) + 1));
    // Positive control: git's own tree diff reads the tampered tree.
    await fixtureGit(repo, ["diff-tree", "-r", "HEAD~1", "HEAD"]);

    const error = await expectRefusal(
      resolve(repo, "HEAD~1..HEAD"),
      "change-source-integrity-mismatch",
    );
    expect(error.detail).toBe("head tree");
  });

  it("classifies a tampered endpoint and a malformed endpoint as unresolved, never an integrity mismatch", async () => {
    const { repository: repo } = await repository();
    await commitFiles(repo, { "a.md": "one\n" }, "base commit");
    const head = await commitFiles(repo, { "a.md": "two\n" }, "head commit");
    await rewriteLooseObject(repo, head, (body) =>
      Buffer.from(body.toString("latin1").replace("head commit", "HEAD COMMIT"), "latin1"),
    );
    await expectRefusal(resolve(repo, "HEAD~1..HEAD"), "change-source-revision-unresolved");

    const { repository: other } = await repository();
    const base = await commitFiles(other, { "a.md": "one\n" }, "base commit");
    await commitFiles(other, { "a.md": "two\n" }, "head commit");
    const path = join(other, ".git", "objects", base.slice(0, 2), base.slice(2));
    await chmod(path, 0o644);
    await writeFile(path, Buffer.from("not a zlib stream"));
    await expectRefusal(resolve(other, `${base}..HEAD`), "change-source-revision-unresolved");
  });

  it("ignores replace refs", async () => {
    const { repository: repo } = await repository();
    await commitFiles(repo, { "a.md": "one\n" }, "first");
    const head = await commitFiles(repo, { "a.md": "two\n" }, "second");
    const clean = await resolve(repo, "HEAD~1..HEAD");
    const decoy = await commitFiles(repo, { "a.md": "decoy\n" }, "decoy");
    await fixtureGit(repo, ["reset", "-q", "--hard", head]);
    await fixtureGit(repo, ["replace", head, decoy]);
    const replaced = await resolve(repo, "HEAD~1..HEAD");
    expect(Buffer.from(replaced.diffBytes).equals(Buffer.from(clean.diffBytes))).toBe(true);
    expect(replaced.changeSource.revision.head).toBe(head);
  });
});

/**
 * Each shallow case builds several clones and resolves each range twice; a
 * case takes a few seconds alone, more on a shared, loaded host.
 */
const SHALLOW_CASE_LOCAL_MS = 20_000;

describe("change-source history and revisions", {
  timeout: testTimeoutMs(SHALLOW_CASE_LOCAL_MS),
}, () => {
  it("separates a shallow clone's missing history from an unresolved name", async () => {
    const { repository: repo, root } = await repository();
    for (const step of ["one", "two", "three", "four"]) {
      await commitFiles(repo, { "a.md": `${step}\n` }, step);
    }
    const shallow = join(root, "shallow");
    await fixtureGit(root, ["clone", "-q", "--depth=2", `file://${repo}`, shallow]);
    expect(await fixtureGit(shallow, ["rev-parse", "--is-shallow-repository"])).toBe("true");

    await expectRefusal(resolve(shallow, "HEAD~3..HEAD"), "change-source-history-unavailable");
    // Inside the clone's depth the range admits: CI clones are shallow.
    const inside = await resolve(shallow, "HEAD~1..HEAD");
    expect(inside.changeSource.commits).toHaveLength(1);
    // A name that does not exist is unresolved, shallow or not.
    await expectRefusal(
      resolve(shallow, "no-such-branch..HEAD"),
      "change-source-revision-unresolved",
    );
    await expectRefusal(resolve(repo, "no-such-branch..HEAD"), "change-source-revision-unresolved");
    // A single commit at the shallow boundary has no parent object to diff from.
    await expectRefusal(resolve(shallow, "HEAD~1"), "change-source-history-unavailable");
  });

  /** `root -> main one -> main two` on main and `main one -> feature one` on feature. */
  async function boundaryFixture() {
    const { repository: repo, root } = await repository();
    const rootCommit = await fixtureGit(repo, ["rev-parse", "HEAD"]);
    const first = await commitFiles(repo, { "m.md": "m1\n" }, "main one");
    await fixtureGit(repo, ["checkout", "-q", "-b", "feature"]);
    await commitFiles(repo, { "f.md": "f1\n" }, "feature one");
    await fixtureGit(repo, ["checkout", "-q", "main"]);
    const second = await commitFiles(repo, { "m.md": "m2\n" }, "main two");
    await fixtureGit(repo, ["branch", "other", rootCommit]);
    return { repo, root, rootCommit, first, second };
  }

  async function shallowFile(clone: string): Promise<string[]> {
    return (await readFile(join(clone, ".git", "shallow"), "utf8")).split("\n").filter(Boolean);
  }

  async function shallowClone(
    root: string,
    repo: string,
    name: string,
    depth: number,
    branch = "main",
  ) {
    const clone = join(root, name);
    const args = ["clone", "-q", `--depth=${depth}`, "--single-branch", "-b", branch];
    await fixtureGit(root, [...args, `file://${repo}`, clone]);
    return clone;
  }

  const ids = (resolved: ResolvedLocalChangeSourceV1) =>
    resolved.changeSource.commits.map((commit) => commit.id);
  /** The per-commit ancestry marker, in list order; undefined where the record carries none. */
  const marks = (resolved: ResolvedLocalChangeSourceV1) =>
    resolved.changeSource.commits.map((commit) => commit.descendsFromDiffBase);
  const sameDiff = (left: ResolvedLocalChangeSourceV1, right: ResolvedLocalChangeSourceV1) =>
    Buffer.from(left.diffBytes).equals(Buffer.from(right.diffBytes));

  it("admits a two-dot range across a shallow boundary whose parent object is missing, labelled both ways", async () => {
    const { repository: repo, root } = await repository();
    await fixtureGit(repo, ["checkout", "-q", "-b", "feature"]);
    const feature = await commitFiles(repo, { "f.md": "f1\n" }, "feature one");
    await fixtureGit(repo, ["checkout", "-q", "main"]);
    const first = await commitFiles(repo, { "m.md": "m1\n" }, "main one");
    const second = await commitFiles(repo, { "m.md": "m2\n" }, "main two");
    const shallow = join(root, "shallow");
    await fixtureGit(root, [
      "clone",
      "-q",
      "--depth=1",
      "--no-single-branch",
      `file://${repo}`,
      shallow,
    ]);
    // Both tips are present, each at depth one: main's parent is past the boundary.
    expect(await fixtureGit(shallow, ["rev-parse", "origin/feature", "main"])).toBe(
      `${feature}\n${second}`,
    );
    expect(await fixtureGit(shallow, ["cat-file", "--batch-check"], `${first}\n`)).toBe(
      `${first} missing`,
    );
    // The true range is main one and main two; git alone lists only main two.
    expect(await fixtureGit(shallow, ["rev-list", "main", `^${feature}`])).toBe(second);
    const whole = await resolve(repo, "feature..main");
    expect(ids(whole)).toEqual([first, second]);
    expect(whole.changeSource.labels).toEqual(["base-not-ancestor-of-head"]);

    const cut = await resolve(shallow, "origin/feature..main");
    expect(ids(cut)).toEqual([second]);
    // Short behind main two, and main two is not proven to descend from feature
    // one; whether feature one is main two's ancestor is not decided.
    expect(cut.changeSource.labels).toEqual([
      "commit-list-incomplete-shallow",
      "commit-list-may-include-base-history",
    ]);
    expect(marks(cut)).toEqual([false]);
    expect(cut.changeSource.mergeBase).toBeNull();
    expect(sameDiff(cut, whole)).toBe(true);
    // Three-dot diffs from the merge base, which this clone does not hold.
    await expectRefusal(
      resolve(shallow, "origin/feature...main"),
      "change-source-history-unavailable",
    );
  });

  it("admits a shallow range whose boundary parent arrived through another ref, labelled incomplete", async () => {
    const { repo, root, rootCommit, first, second } = await boundaryFixture();
    // A depth-one main, then a plain fetch of feature: main one and the root
    // arrive, but main two stays a boundary commit git walks as parentless.
    const fetched = await shallowClone(root, repo, "fetched", 1);
    await fixtureGit(fetched, ["fetch", "-q", "origin", "feature:refs/remotes/origin/feature"]);
    expect(await shallowFile(fetched)).toEqual([second]);
    expect(await fixtureGit(fetched, ["cat-file", "-t", first])).toBe("commit");
    expect(await fixtureGit(fetched, ["rev-list", "main", `^${rootCommit}`])).toBe(second);
    const whole = await resolve(repo, `${rootCommit}..main`);
    expect(ids(whole)).toEqual([first, second]);
    expect(whole.changeSource.labels).toEqual([]);
    const cut = await resolve(fetched, `${rootCommit}..main`);
    expect(ids(cut)).toEqual([second]);
    expect(cut.changeSource.labels).toEqual(["commit-list-incomplete-shallow"]);
    expect(marks(cut)).toEqual([undefined]);
    expect(sameDiff(cut, whole)).toBe(true);

    // Mixed depths: feature fetched at depth two and other at depth one.
    const mixed = await shallowClone(root, repo, "mixed", 1);
    const fetch = ["fetch", "-q", "origin"];
    await fixtureGit(mixed, [...fetch, "--depth=2", "feature:refs/remotes/origin/feature"]);
    await fixtureGit(mixed, [...fetch, "--depth=1", "other:refs/remotes/origin/other"]);
    expect(await fixtureGit(mixed, ["rev-list", "main", "^origin/other"])).toBe(second);
    const mixedWhole = await resolve(repo, "other..main");
    expect(ids(mixedWhole)).toEqual([first, second]);
    const mixedCut = await resolve(mixed, "origin/other..main");
    expect(ids(mixedCut)).toEqual([second]);
    expect(mixedCut.changeSource.labels).toEqual(["commit-list-incomplete-shallow"]);
    expect(sameDiff(mixedCut, mixedWhole)).toBe(true);
  });

  it("admits a shallow merge range cut at a boundary, labelled incomplete, three-dot too when base is the merge base", async () => {
    const { repository: repo, root } = await repository();
    await fixtureGit(repo, ["checkout", "-q", "-b", "side"]);
    const sideOne = await commitFiles(repo, { "s.md": "s1\n" }, "side one");
    const sideTwo = await commitFiles(repo, { "s.md": "s2\n" }, "side two");
    await fixtureGit(repo, ["checkout", "-q", "main"]);
    const mainTip = await commitFiles(repo, { "m.md": "m1\n" }, "main one");
    await fixtureGit(repo, ["merge", "-q", "--no-ff", "--no-edit", "-m", "merge side", "side"]);
    const merge = await fixtureGit(repo, ["rev-parse", "HEAD"]);
    await fixtureGit(repo, ["branch", "side-one", sideOne]);
    const clone = await shallowClone(root, repo, "clone", 2);
    await fixtureGit(clone, ["fetch", "-q", "origin", "side-one:refs/remotes/origin/side-one"]);
    expect(new Set(await shallowFile(clone))).toEqual(new Set([mainTip, sideTwo]));
    expect(await fixtureGit(clone, ["cat-file", "-t", sideOne])).toBe("commit");
    expect(await fixtureGit(clone, ["merge-base", mainTip, "main"])).toBe(mainTip);
    // Git alone lists side two and the merge, dropping side one.
    expect((await fixtureGit(clone, ["rev-list", "main", `^${mainTip}`])).split("\n")).toEqual([
      merge,
      sideTwo,
    ]);
    const whole = await resolve(repo, `${mainTip}..main`);
    expect(ids(whole)).toEqual([sideOne, sideTwo, merge]);
    // Base is the merge base, so no newer one can hide: three-dot diffs exactly too.
    for (const selector of [`${mainTip}..main`, `${mainTip}...main`]) {
      const cut = await resolve(clone, selector);
      expect(ids(cut), selector).toEqual([sideTwo, merge]);
      expect(cut.changeSource.labels, selector).toEqual(["commit-list-incomplete-shallow"]);
      expect(sameDiff(cut, whole), selector).toBe(true);
    }
  });

  it("admits a shallow two-dot range with no visible merge base, labelled, and refuses it three-dot", async () => {
    const { repository: repo, root } = await repository();
    const rootCommit = await fixtureGit(repo, ["rev-parse", "HEAD"]);
    await fixtureGit(repo, ["checkout", "-q", "-b", "other"]);
    await commitFiles(repo, { "o.md": "o1\n" }, "other one");
    const otherTip = await commitFiles(repo, { "o.md": "o2\n" }, "other two");
    await fixtureGit(repo, ["checkout", "-q", "main"]);
    const first = await commitFiles(repo, { "m.md": "m1\n" }, "main one");
    const second = await commitFiles(repo, { "m.md": "m2\n" }, "main two");
    // Main is whole; only other's history is cut, so the shared root is hidden
    // from other's side and git lists the root as if it were in the range.
    const clone = join(root, "clone");
    await fixtureGit(root, [
      "clone",
      "-q",
      "--single-branch",
      "-b",
      "main",
      `file://${repo}`,
      clone,
    ]);
    await fixtureGit(clone, [
      "fetch",
      "-q",
      "--depth=1",
      "origin",
      "other:refs/remotes/origin/other",
    ]);
    expect(await shallowFile(clone)).toEqual([otherTip]);
    expect((await fixtureGit(clone, ["rev-list", "main", "^origin/other"])).split("\n")).toEqual([
      second,
      first,
      rootCommit,
    ]);
    const whole = await resolve(repo, "other..main");
    expect(ids(whole)).toEqual([first, second]);
    expect(whole.changeSource.mergeBase).toBe(rootCommit);
    const cut = await resolve(clone, "origin/other..main");
    expect(ids(cut)).toEqual([rootCommit, first, second]);
    expect(cut.changeSource.mergeBase).toBeNull();
    // Main is whole, so other two is decided not to be its ancestor.
    expect(cut.changeSource.labels).toEqual([
      "base-not-ancestor-of-head",
      "commit-list-may-include-base-history",
    ]);
    expect(marks(cut)).toEqual([false, false, false]);
    expect(sameDiff(cut, whole)).toBe(true);
    await expectRefusal(resolve(clone, "origin/other...main"), "change-source-history-unavailable");
    expect((await resolve(repo, "other...main")).changeSource.mergeBase).toBe(rootCommit);
  });

  /** `root -> Q -> S -> B` on main; feature `F1` (parent Q), then `H` merges main into it. */
  async function exclusionFixture() {
    const { repository: repo, root } = await repository();
    const rootCommit = await fixtureGit(repo, ["rev-parse", "HEAD"]);
    const q = await commitFiles(repo, { "m.md": "q\n" }, "main q");
    await fixtureGit(repo, ["checkout", "-q", "-b", "feature"]);
    const f1 = await commitFiles(repo, { "f.md": "f1\n" }, "feature one");
    await fixtureGit(repo, ["checkout", "-q", "main"]);
    const s = await commitFiles(repo, { "m.md": "s\n" }, "main s");
    const b = await commitFiles(repo, { "m.md": "b\n" }, "main b");
    await fixtureGit(repo, ["checkout", "-q", "feature"]);
    await fixtureGit(repo, ["merge", "-q", "--no-ff", "--no-edit", "-m", "merge main", "main"]);
    const h = await fixtureGit(repo, ["rev-parse", "HEAD"]);
    await fixtureGit(repo, ["checkout", "-q", "main"]);
    return { repo, root, rootCommit, q, f1, s, b, h };
  }

  /** A shallow main at `depth`, then a plain fetch of feature. */
  async function exclusionClone(root: string, repo: string, depth: number) {
    const clone = await shallowClone(root, repo, `excluded-${depth}`, depth);
    await fixtureGit(clone, ["fetch", "-q", "origin", "feature:refs/remotes/origin/feature"]);
    return clone;
  }

  it("admits a shallow two-dot range whose diff base's own history is cut, labelled and marked, and refuses it three-dot", async () => {
    const { repo, root, rootCommit, q, f1, b, h } = await exclusionFixture();
    const clone = await exclusionClone(root, repo, 1);
    expect(await shallowFile(clone)).toEqual([b]);
    // Git alone lists the root and Q, which are B's own ancestors.
    expect((await fixtureGit(clone, ["rev-list", "origin/feature", `^${b}`])).split("\n")).toEqual([
      h,
      f1,
      q,
      rootCommit,
    ]);
    const whole = await resolve(repo, `${b}..feature`);
    expect(ids(whole)).toEqual([f1, h]);
    expect(marks(whole)).toEqual([undefined, undefined]);
    const cut = await resolve(clone, `${b}..origin/feature`);
    expect(ids(cut)).toEqual([rootCommit, q, f1, h]);
    expect(cut.changeSource.labels).toEqual([
      "commit-list-may-include-base-history",
      "head-not-ancestor-of-workspace",
    ]);
    // Only the merge provably descends from B; feature one is in the range but unproven.
    expect(marks(cut)).toEqual([false, false, false, true]);
    expect(sameDiff(cut, whole)).toBe(true);
    await expectRefusal(
      resolve(clone, `${b}...origin/feature`),
      "change-source-history-unavailable",
    );
    expect(ids(await resolve(repo, `${b}...feature`))).toEqual([f1, h]);
  });

  it("removes the diff base's own history found across the boundary, listing the exact range", async () => {
    const { repo, root, rootCommit, q, f1, s, b, h } = await exclusionFixture();
    const clone = await exclusionClone(root, repo, 2);
    expect(await shallowFile(clone)).toEqual([s]);
    // S's parent Q arrived with feature; git still walks S as parentless.
    expect(await fixtureGit(clone, ["cat-file", "-t", q])).toBe("commit");
    expect((await fixtureGit(clone, ["rev-list", "origin/feature", `^${b}`])).split("\n")).toEqual([
      h,
      f1,
      q,
      rootCommit,
    ]);
    for (const selector of [`${b}..origin/feature`, `${b}...origin/feature`]) {
      const resolved = await resolve(clone, selector);
      expect(ids(resolved), selector).toEqual([f1, h]);
      expect(resolved.changeSource.diffFrom, selector).toBe(b);
      expect(resolved.changeSource.mergeBase, selector).toBe(b);
      expect(resolved.changeSource.labels, selector).toEqual(["head-not-ancestor-of-workspace"]);
      expect(marks(resolved), selector).toEqual([undefined, undefined]);
      const whole = await resolve(repo, selector.replace("origin/feature", "feature"));
      expect(sameDiff(resolved, whole), selector).toBe(true);
    }
  });

  it("labels a hidden ancestor whose visible parent is excluded when the boundary hides the rest", async () => {
    // main: root -> P; side: P -> C -> X1 -> X2 -> X3; D merges side into main,
    // and H joins D with C again, so C is D's ancestor only through X3.
    const { repository: repo, root } = await repository();
    const p = await commitFiles(repo, { "p.md": "p\n" }, "main p");
    await fixtureGit(repo, ["checkout", "-q", "-b", "side"]);
    const c = await commitFiles(repo, { "c.md": "c\n" }, "side c");
    for (const step of ["x1", "x2", "x3"]) await commitFiles(repo, { "x.md": `${step}\n` }, step);
    const x1 = await fixtureGit(repo, ["rev-parse", "HEAD~2"]);
    await fixtureGit(repo, ["checkout", "-q", "main"]);
    await fixtureGit(repo, ["merge", "-q", "--no-ff", "--no-edit", "-m", "merge side", "side"]);
    const d = await fixtureGit(repo, ["rev-parse", "HEAD"]);
    const tree = await fixtureGit(repo, ["rev-parse", `${d}^{tree}`]);
    const h = await fixtureGit(repo, ["commit-tree", tree, "-p", d, "-p", c, "-m", "join c"]);
    await fixtureGit(repo, ["update-ref", "refs/heads/main", h]);

    const clone = await shallowClone(root, repo, "hidden", 4);
    expect(await fixtureGit(clone, ["cat-file", "--batch-check"], `${x1}\n`)).toBe(`${x1} missing`);
    expect(await fixtureGit(clone, ["cat-file", "-t", p])).toBe("commit");
    // Git lists C, whose only visible parent P is excluded, beside the merge.
    expect((await fixtureGit(clone, ["rev-list", "main", `^${d}`])).split("\n")).toEqual([h, c]);
    const whole = await resolve(repo, `${d}..main`);
    expect(ids(whole)).toEqual([h]);
    const cut = await resolve(clone, `${d}..main`);
    expect(ids(cut)).toEqual([c, h]);
    expect(cut.changeSource.labels).toEqual(["commit-list-may-include-base-history"]);
    expect(marks(cut)).toEqual([false, true]);
    expect(sameDiff(cut, whole)).toBe(true);
  });

  it("admits linear CI ranges inside a depth-only clone unlabelled, two-dot and three-dot", async () => {
    const { repository: repo, root } = await repository();
    const steps: string[] = [];
    for (const step of ["one", "two", "three", "four", "five"]) {
      steps.push(await commitFiles(repo, { "a.md": `${step}\n` }, step));
    }
    const clone = await shallowClone(root, repo, "ci", 4);
    expect(await shallowFile(clone)).toEqual([steps[1]]);
    for (const [selector, expected] of [
      ["HEAD~1..HEAD", steps.slice(4)],
      ["HEAD~2..HEAD", steps.slice(3)],
      ["HEAD~2...HEAD", steps.slice(3)],
      ["HEAD~1...HEAD", steps.slice(4)],
      [`${steps[1]}..HEAD`, steps.slice(2)],
    ] as const) {
      const cut = await resolve(clone, selector);
      const whole = await resolve(repo, selector);
      expect(ids(cut), selector).toEqual(expected);
      expect(ids(whole), selector).toEqual(expected);
      expect(cut.changeSource.labels, selector).toEqual([]);
      expect(whole.changeSource.labels, selector).toEqual([]);
      expect(sameDiff(cut, whole), selector).toBe(true);
    }
  });

  it("admits a depth-only merge-tip range whose side commit is not proven to descend from the base, labelled and marked", async () => {
    const { repository: repo, root } = await repository();
    const a1 = await commitFiles(repo, { "a.md": "a1\n" }, "a1");
    await fixtureGit(repo, ["checkout", "-q", "-b", "side"]);
    const s1 = await commitFiles(repo, { "s.md": "s1\n" }, "s1");
    await fixtureGit(repo, ["checkout", "-q", "main"]);
    await commitFiles(repo, { "a.md": "a2\n" }, "a2");
    await commitFiles(repo, { "a.md": "a3\n" }, "a3");
    await fixtureGit(repo, ["merge", "-q", "--no-ff", "--no-edit", "-m", "merge side", "side"]);
    const merge = await fixtureGit(repo, ["rev-parse", "HEAD"]);
    const clone = await shallowClone(root, repo, "merge-tip", 3);
    expect(await fixtureGit(clone, ["cat-file", "-t", a1])).toBe("commit");
    const whole = await resolve(repo, "HEAD~1..HEAD");
    expect(ids(whole)).toEqual([s1, merge]);
    expect(whole.changeSource.labels).toEqual([]);
    // S1 is in the range, but HEAD~1's history is cut below A1, so it is unproven.
    const cut = await resolve(clone, "HEAD~1..HEAD");
    expect(ids(cut)).toEqual([s1, merge]);
    expect(cut.changeSource.labels).toEqual(["commit-list-may-include-base-history"]);
    expect(marks(cut)).toEqual([false, true]);
    expect(sameDiff(cut, whole)).toBe(true);
    // Three-dot keeps refusing when its list is in doubt this way.
    await expectRefusal(resolve(clone, "HEAD~1...HEAD"), "change-source-history-unavailable");
    // The merge alone diffs against the same first parent, unlabelled.
    const alone = await resolve(clone, "HEAD");
    expect(ids(alone)).toEqual([merge]);
    expect(alone.changeSource.labels).toEqual([]);
    expect(sameDiff(alone, whole)).toBe(true);
  });

  it("labels a long side branch merged past the clone depth both ways, with the diff exact", async () => {
    const { repository: repo, root } = await repository();
    await fixtureGit(repo, ["checkout", "-q", "-b", "side"]);
    const side: string[] = [];
    for (const step of ["s1", "s2", "s3", "s4"]) {
      side.push(await commitFiles(repo, { "s.md": `${step}\n` }, step));
    }
    await fixtureGit(repo, ["checkout", "-q", "main"]);
    const main: string[] = [];
    for (const step of ["a1", "a2", "a3"]) {
      main.push(await commitFiles(repo, { "a.md": `${step}\n` }, step));
    }
    await fixtureGit(repo, ["merge", "-q", "--no-ff", "--no-edit", "-m", "merge side", "side"]);
    const merge = await fixtureGit(repo, ["rev-parse", "HEAD"]);
    const clone = await shallowClone(root, repo, "long-side", 3);
    expect(new Set(await shallowFile(clone))).toEqual(new Set([main[1], side[2]]));
    const whole = await resolve(repo, "HEAD~1..HEAD");
    expect(ids(whole)).toEqual([...side, merge]);
    const cut = await resolve(clone, "HEAD~1..HEAD");
    // S3 sits on the boundary with S2 missing (short), and neither S3 nor S4
    // is proven to descend from A3 (may include base history).
    expect(ids(cut)).toEqual([side[2], side[3], merge]);
    expect(cut.changeSource.labels).toEqual([
      "commit-list-incomplete-shallow",
      "commit-list-may-include-base-history",
    ]);
    expect(marks(cut)).toEqual([false, false, true]);
    expect(sameDiff(cut, whole)).toBe(true);
  });

  it("refuses a shallow three-dot range whose base crosses a boundary above the visible merge base", async () => {
    // root -> V -> X; feature X -> F1; W from V; base: X -> Z1 -> Z2 -> Z3, then
    // merges W. The true merge base is X; base reaches it only through Z1.
    const { repository: repo, root } = await repository();
    const v = await commitFiles(repo, { "v.md": "v\n" }, "V");
    const x = await commitFiles(repo, { "x.md": "x\n" }, "X");
    await fixtureGit(repo, ["checkout", "-q", "-b", "feature"]);
    const f1 = await commitFiles(repo, { "f.md": "f\n" }, "F1");
    await fixtureGit(repo, ["checkout", "-q", "-b", "w", v]);
    await commitFiles(repo, { "w.md": "w\n" }, "W");
    await fixtureGit(repo, ["checkout", "-q", "-b", "base", x]);
    for (const z of ["z1", "z2", "z3"]) await commitFiles(repo, { "z.md": `${z}\n` }, z);
    await fixtureGit(repo, ["merge", "-q", "--no-ff", "--no-edit", "-m", "base merge", "w"]);
    const clone = await shallowClone(root, repo, "base-cut", 3, "base");
    await fixtureGit(clone, ["fetch", "-q", "origin", "feature:refs/remotes/origin/feature"]);
    expect(await shallowFile(clone)).toContain(v);
    expect(await fixtureGit(clone, ["merge-base", "base", "origin/feature"])).toBe(v);
    const whole = await resolve(repo, "base...feature");
    expect(whole.changeSource.mergeBase).toBe(x);
    expect(ids(whole)).toEqual([f1]);
    // The closure below V is whole; the cut is on base's side, above V.
    await expectRefusal(
      resolve(clone, "base...origin/feature"),
      "change-source-history-unavailable",
    );
    // Two-dot reads only its endpoints: admitted, exact, the list labelled.
    const twoDot = await resolve(clone, "base..origin/feature");
    expect(ids(twoDot)).toEqual([x, f1]);
    expect(twoDot.changeSource.labels).toContain("commit-list-may-include-base-history");
    expect(sameDiff(twoDot, await resolve(repo, "base..feature"))).toBe(true);
  });

  it("refuses a shallow three-dot range whose head crosses a boundary above the visible merge base", async () => {
    // main: root -> V -> X -> Y; feature: X -> F1 -> F2 -> F3, then merges W
    // (from V). The true merge base is X; head reaches it only through F1.
    const { repository: repo, root } = await repository();
    const rootCommit = await fixtureGit(repo, ["rev-parse", "HEAD"]);
    const v = await commitFiles(repo, { "v.md": "v\n" }, "V");
    const x = await commitFiles(repo, { "x.md": "x\n" }, "X");
    await fixtureGit(repo, ["checkout", "-q", "-b", "feature"]);
    const feature: string[] = [];
    for (const step of ["f1", "f2", "f3"]) {
      feature.push(await commitFiles(repo, { "f.md": `${step}\n` }, step));
    }
    await fixtureGit(repo, ["checkout", "-q", "-b", "w", v]);
    const w = await commitFiles(repo, { "w.md": "w\n" }, "W");
    await fixtureGit(repo, ["checkout", "-q", "feature"]);
    await fixtureGit(repo, ["merge", "-q", "--no-ff", "--no-edit", "-m", "merge w", "w"]);
    const head = await fixtureGit(repo, ["rev-parse", "HEAD"]);
    await fixtureGit(repo, ["checkout", "-q", "main"]);
    await commitFiles(repo, { "y.md": "y\n" }, "Y");
    const clone = await shallowClone(root, repo, "head-cut", 3, "feature");
    await fixtureGit(clone, ["fetch", "-q", "origin", "main:refs/remotes/origin/main"]);
    // The root arrives through its own ref, so the walk below V is whole and
    // only the cut at F2 is left.
    await fixtureGit(repo, ["branch", "root", rootCommit]);
    await fixtureGit(clone, ["fetch", "-q", "origin", "root:refs/remotes/origin/root"]);
    expect(new Set(await shallowFile(clone))).toEqual(new Set([feature[1], v]));
    // F1 stays missing; the root is present behind V.
    expect(await fixtureGit(clone, ["cat-file", "--batch-check"], `${feature[0]}\n`)).toBe(
      `${feature[0]} missing`,
    );
    expect(await fixtureGit(clone, ["cat-file", "-t", rootCommit])).toBe("commit");
    expect(await fixtureGit(clone, ["merge-base", "origin/main", "feature"])).toBe(v);
    expect((await resolve(repo, "main...feature")).changeSource.mergeBase).toBe(x);
    await expectRefusal(
      resolve(clone, "origin/main...feature"),
      "change-source-history-unavailable",
    );
    const twoDot = await resolve(clone, "origin/main..feature");
    expect(new Set(ids(twoDot))).toEqual(new Set([feature[1], feature[2], w, head]));
    // Short behind F2; whether Y is head's ancestor is then not decided, so
    // only the list is labelled.
    expect(twoDot.changeSource.labels).toEqual(["commit-list-incomplete-shallow"]);
    expect(sameDiff(twoDot, await resolve(repo, "main..feature"))).toBe(true);
  });

  /** Seconds after the fixture's default commit date. */
  const at = (seconds: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString();

  /**
   * `root -> V -> Bd -> X` on `xb`; A and C fork from V; `base-tip` merges A
   * with X and `head-tip` merges C with X, so the true merge base is X. A depth-two
   * clone of `xb` stops at Bd, and plain fetches of A, `base-tip` and `head-tip` bring
   * V back whole: git then sees V and X as two incomparable merge bases.
   */
  async function crissCrossFixture(vDate: string) {
    const { repository: repo, root } = await repository();
    const v = await commitFiles(repo, { "v.md": "v\n" }, "V", { date: vDate });
    await fixtureGit(repo, ["checkout", "-q", "-b", "xb"]);
    const bd = await commitFiles(repo, { "b.md": "b\n" }, "Bd", { date: at(2) });
    const x = await commitFiles(repo, { "x.md": "x\n" }, "X", { date: at(3) });
    const merge = (message: string, date: string) =>
      fixtureGit(
        repo,
        ["merge", "-q", "--no-ff", "--no-edit", "-m", message, "xb"],
        undefined,
        fixtureDate(date),
      );
    await fixtureGit(repo, ["checkout", "-q", "-b", "a", v]);
    await commitFiles(repo, { "a.md": "a\n" }, "A", { date: at(4) });
    await fixtureGit(repo, ["checkout", "-q", "-b", "base-tip"]);
    await merge("base", at(5));
    await fixtureGit(repo, ["checkout", "-q", "-b", "head-tip", v]);
    const c = await commitFiles(repo, { "c.md": "c\n" }, "C", { date: at(6) });
    await merge("head", at(7));
    const head = await fixtureGit(repo, ["rev-parse", "HEAD"]);
    const clone = await shallowClone(root, repo, "criss-cross", 2, "xb");
    for (const ref of ["a", "base-tip", "head-tip"]) {
      await fixtureGit(clone, ["fetch", "-q", "origin", `${ref}:refs/remotes/origin/${ref}`]);
    }
    expect(await shallowFile(clone)).toEqual([bd]);
    expect(await fixtureGit(clone, ["cat-file", "-t", v])).toBe("commit");
    const mergeBases = await fixtureGit(clone, [
      "merge-base",
      "--all",
      "origin/base-tip",
      "origin/head-tip",
    ]);
    expect(new Set(mergeBases.split("\n"))).toEqual(new Set([v, x]));
    return { repo, root, clone, v, x, c, head };
  }

  /** The detail a shallow three-dot refusal over more than one merge base carries. */
  const multipleMergeBases = (...ids: string[]) =>
    `merge bases ${[...ids].sort().join(", ")}: this shallow clone shows more than one, ` +
    "and only full history decides which one git would diff from. " +
    "Run git fetch --unshallow, or use <base>..<head>, whose diff is exact";

  it("refuses a shallow three-dot range whose visible history shows more than one merge base", async () => {
    const { repo, clone, v, x, c, head } = await crissCrossFixture(at(100));
    // V's later committer date makes git pick it; with full history X is the
    // only merge base, so a diff from V would add Bd's and X's changes.
    const picked = [
      "-c",
      "core.commitGraph=false",
      "merge-base",
      "origin/base-tip",
      "origin/head-tip",
    ];
    expect(await fixtureGit(clone, picked)).toBe(v);
    const whole = await resolve(repo, "base-tip...head-tip");
    expect(whole.changeSource.mergeBase).toBe(x);
    expect(ids(whole)).toEqual([c, head]);
    expect(changedPaths(whole)).toEqual(["c.md"]);
    const error = await expectRefusal(
      resolve(clone, "origin/base-tip...origin/head-tip"),
      "change-source-history-unavailable",
    );
    expect(error.detail).toBe(multipleMergeBases(v, x));
    // Two-dot reads only its endpoints, so its diff stays exact.
    const twoDot = await resolve(clone, "origin/base-tip..origin/head-tip");
    expect(sameDiff(twoDot, await resolve(repo, "base-tip..head-tip"))).toBe(true);
  });

  it("refuses the same shallow criss-cross when git would pick the true merge base, and keeps git's choice in a full clone", async () => {
    const { repo, root, clone, v, x, c, head } = await crissCrossFixture(at(1));
    const picked = [
      "-c",
      "core.commitGraph=false",
      "merge-base",
      "origin/base-tip",
      "origin/head-tip",
    ];
    expect(await fixtureGit(clone, picked)).toBe(x);
    // Over-refusal, accepted: the clone cannot tell this case from the one above.
    const error = await expectRefusal(
      resolve(clone, "origin/base-tip...origin/head-tip"),
      "change-source-history-unavailable",
    );
    expect(error.detail).toBe(multipleMergeBases(v, x));
    const full = join(root, "full");
    await fixtureGit(root, ["clone", "-q", "--no-local", `file://${repo}`, full]);
    expect(await fixtureGit(full, ["rev-parse", "--is-shallow-repository"])).toBe("false");
    const whole = await resolve(full, "origin/base-tip...origin/head-tip");
    expect(whole.changeSource.mergeBase).toBe(x);
    expect(ids(whole)).toEqual([c, head]);
    expect(changedPaths(whole)).toEqual(["c.md"]);
    expect(sameDiff(whole, await resolve(repo, "base-tip...head-tip"))).toBe(true);

    // A true criss-cross in complete history keeps git's own pick.
    const { repository: crossed } = await repository();
    const rootCommit = await fixtureGit(crossed, ["rev-parse", "HEAD"]);
    const p = await commitFiles(crossed, { "p.md": "p\n" }, "P");
    await fixtureGit(crossed, ["checkout", "-q", "-b", "q", rootCommit]);
    const q = await commitFiles(crossed, { "q.md": "q\n" }, "Q");
    await fixtureGit(crossed, ["checkout", "-q", "-b", "one", p]);
    await fixtureGit(crossed, ["merge", "-q", "--no-ff", "--no-edit", "-m", "one", q]);
    await fixtureGit(crossed, ["checkout", "-q", "-b", "two", q]);
    await fixtureGit(crossed, ["merge", "-q", "--no-ff", "--no-edit", "-m", "two", p]);
    await commitFiles(crossed, { "t.md": "t\n" }, "T");
    const bases = await fixtureGit(crossed, ["merge-base", "--all", "one", "two"]);
    expect(new Set(bases.split("\n"))).toEqual(new Set([p, q]));
    const gitPick = await fixtureGit(crossed, [
      "-c",
      "core.commitGraph=false",
      "merge-base",
      "one",
      "two",
    ]);
    const criss = await resolve(crossed, "one...two");
    expect(criss.changeSource.mergeBase).toBe(gitPick);
    const names = await fixtureGit(crossed, ["diff-tree", "-r", "--name-only", gitPick, "two"]);
    expect(changedPaths(criss)).toEqual(names.split("\n"));
  });

  it("leaves a boundary parent the base's own history holds unlabelled, and decides ancestry through it", async () => {
    // main: root -> A -> B; feature: A -> F1 -> F2, cloned at depth two, then
    // main fetched whole: F1 is a boundary commit whose parent A is B's ancestor.
    const { repository: repo, root } = await repository();
    const a = await commitFiles(repo, { "a.md": "a\n" }, "A");
    await fixtureGit(repo, ["checkout", "-q", "-b", "feature"]);
    const f1 = await commitFiles(repo, { "f.md": "f1\n" }, "F1");
    const f2 = await commitFiles(repo, { "f.md": "f2\n" }, "F2");
    await fixtureGit(repo, ["checkout", "-q", "main"]);
    await commitFiles(repo, { "b.md": "b\n" }, "B");
    const clone = await shallowClone(root, repo, "feature-cut", 2, "feature");
    await fixtureGit(clone, ["fetch", "-q", "origin", "main:refs/remotes/origin/main"]);
    expect(await shallowFile(clone)).toEqual([f1]);
    expect(await fixtureGit(clone, ["cat-file", "-t", a])).toBe("commit");
    const twoDot = await resolve(clone, "origin/main..feature");
    expect(ids(twoDot)).toEqual([f1, f2]);
    expect(ids(await resolve(repo, "main..feature"))).toEqual([f1, f2]);
    // A is excluded through B, so the list is whole and B is decided off head's history.
    expect(twoDot.changeSource.labels).toEqual(["base-not-ancestor-of-head"]);
    // From A itself, git sees no merge base, but A is F1's parent: an ancestor.
    const fromA = await resolve(clone, `${a}..feature`);
    expect(fromA.changeSource.mergeBase).toBeNull();
    expect(ids(fromA)).toEqual([f1, f2]);
    expect(fromA.changeSource.labels).toEqual([]);
  });

  it("admits a shallow range inside its depth, including one that ends at the boundary", async () => {
    const { repo, root, first, second } = await boundaryFixture();
    const third = await commitFiles(repo, { "m.md": "m3\n" }, "main three");
    const clone = await shallowClone(root, repo, "clone", 3);
    expect(await shallowFile(clone)).toEqual([first]);
    const inside = await resolve(clone, `${first}..main`);
    expect(ids(inside)).toEqual([second, third]);
    expect(inside.changeSource.labels).toEqual([]);
    expect(ids(await resolve(repo, `${first}..main`))).toEqual([second, third]);
    // A boundary commit whose parent arrived later diffs from that parent.
    await fixtureGit(repo, ["branch", "previous", second]);
    const tip = await shallowClone(root, repo, "tip", 1);
    await fixtureGit(tip, ["fetch", "-q", "origin", "previous:refs/remotes/origin/previous"]);
    expect(await shallowFile(tip)).toEqual([third]);
    const single = await resolve(tip, "main");
    expect(ids(single)).toEqual([third]);
    expect(single.changeSource.revision.base).toBe(second);
  });

  it("admits a shallow boundary merge alone, and refuses any other missing parent as unresolved", async () => {
    const { repository: repo, root } = await repository();
    await fixtureGit(repo, ["checkout", "-q", "-b", "side"]);
    const side = await commitFiles(repo, { "s.md": "s\n" }, "side");
    await fixtureGit(repo, ["checkout", "-q", "main"]);
    const mainTip = await commitFiles(repo, { "m.md": "m\n" }, "main");
    await fixtureGit(repo, ["merge", "-q", "--no-ff", "--no-edit", "-m", "merge side", "side"]);
    const merge = await fixtureGit(repo, ["rev-parse", "HEAD"]);
    const whole = await resolve(repo, "HEAD");
    // Shallow: the merge is a boundary commit; its first parent arrives later, its second never.
    await fixtureGit(repo, ["branch", "previous", mainTip]);
    const clone = await shallowClone(root, repo, "merge-boundary", 1);
    await fixtureGit(clone, ["fetch", "-q", "origin", "previous:refs/remotes/origin/previous"]);
    expect(await shallowFile(clone)).toEqual([merge]);
    expect(await fixtureGit(clone, ["cat-file", "--batch-check"], `${side}\n`)).toBe(
      `${side} missing`,
    );
    // One commit's list is that commit, and its diff reads only the first parent.
    const alone = await resolve(clone, "HEAD");
    expect(ids(alone)).toEqual([merge]);
    expect(alone.changeSource.diffFrom).toBe(mainTip);
    expect(alone.changeSource.labels).toEqual([]);
    expect(sameDiff(alone, whole)).toBe(true);
    // Both parents present (fetched later): admitted the same way.
    await fixtureGit(repo, ["branch", "side-tip", side]);
    await fixtureGit(clone, ["fetch", "-q", "origin", "side-tip:refs/remotes/origin/side-tip"]);
    expect(await shallowFile(clone)).toEqual([merge]);
    expect(ids(await resolve(clone, "HEAD"))).toEqual([merge]);

    // A commit off the boundary that names a missing parent is a damaged object
    // database, not shallow history, in a shallow clone too.
    const tree = await fixtureGit(clone, ["rev-parse", `${merge}^{tree}`]);
    const absent = "e".repeat(40);
    const body = [
      `tree ${tree}`,
      `parent ${merge}`,
      `parent ${absent}`,
      "author Fixture Author <author@example.test> 1767225600 +0000",
      "committer Fixture Committer <committer@example.test> 1767225600 +0000",
      "",
      "names a missing parent",
      "",
    ].join("\n");
    const damaged = await fixtureGit(clone, ["hash-object", "-t", "commit", "-w", "--stdin"], body);
    await expectRefusal(resolve(clone, damaged), "change-source-revision-unresolved");

    // Not shallow: the same missing object is not missing history.
    await fixtureGit(repo, ["branch", "-q", "-D", "side", "side-tip"]);
    await rm(join(repo, ".git", "objects", side.slice(0, 2), side.slice(2)));
    expect(await fixtureGit(repo, ["rev-parse", "--is-shallow-repository"])).toBe("false");
    expect(await fixtureGit(repo, ["cat-file", "--batch-check"], `${side}\n`)).toBe(
      `${side} missing`,
    );
    // Git itself diffs the merge against its first parent without complaint.
    expect(await fixtureGit(repo, ["diff-tree", "-r", "--name-only", mainTip, "HEAD"])).toBe(
      "s.md",
    );
    await expectRefusal(resolve(repo, "HEAD"), "change-source-revision-unresolved");
  });

  it("reads only local plumbing: no fetch and no protocol override", async () => {
    const { repository: repo } = await repository();
    await commitFiles(repo, { "a.md": "one\n" }, "change");
    const seen: string[][] = [];
    await resolve(repo, "HEAD~1..HEAD", { observeGit: (args) => seen.push([...args]) });
    const subcommands = seen.map((args) => args.find((arg) => !arg.startsWith("-")));
    expect(new Set(subcommands)).toEqual(
      new Set(["rev-parse", "merge-base", "rev-list", "cat-file", "diff-tree"]),
    );
    expect(seen.flat().some((arg) => /fetch|protocol|remote/u.test(arg))).toBe(false);
  });

  it("refuses an empty range but admits a range of empty commits as no change", async () => {
    const { repository: repo } = await repository();
    await expectRefusal(resolve(repo, "HEAD..HEAD"), "change-source-empty-range");
    const empty = await commitFiles(repo, {}, "empty commit", { allowEmpty: true });
    const resolved = await resolve(repo, "HEAD~1..HEAD");
    expect(resolved.changeSource.commits.map((commit) => commit.id)).toEqual([empty]);
    expect(resolved.changeSource.files).toEqual([]);
    expect(resolved.diffBytes.byteLength).toBe(0);
  });

  it("refuses three-dot over unrelated histories but records no merge base for two-dot", async () => {
    const { repository: repo } = await repository();
    await fixtureGit(repo, ["checkout", "-q", "--orphan", "island"]);
    await commitFiles(repo, { "island.md": "isle\n" }, "island root");
    await expectRefusal(resolve(repo, "main...island"), "change-source-no-merge-base");
    const twoDot = await resolve(repo, "main..island");
    expect(twoDot.changeSource.mergeBase).toBeNull();
  });
});

describe("change-source hardening", () => {
  async function hardeningFixture() {
    // Two hunks a few lines apart, with a blank context line in each.
    const lines = [
      "alpha",
      "",
      "beta",
      "gamma",
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "",
      "zeta",
    ];
    const edited = lines.map((line) =>
      line === "beta" || line === "zeta" ? line.toUpperCase() : line,
    );
    const fixture = await repository({ "f.txt": `${lines.join("\n")}\n` });
    await commitFiles(fixture.repository, { "f.txt": `${edited.join("\n")}\n` }, "edit");
    return { ...fixture, clean: await resolve(fixture.repository, "HEAD~1..HEAD") };
  }

  it("ignores an untracked working-tree .gitattributes", async () => {
    const { repository: repo, clean } = await hardeningFixture();
    await writeFile(join(repo, ".gitattributes"), "f.txt -diff\n");
    // Positive control: porcelain git honors it.
    expect(await fixtureGit(repo, ["diff", "HEAD~1", "HEAD"])).toContain("Binary files");
    const tampered = await resolve(repo, "HEAD~1..HEAD");
    expect(Buffer.from(tampered.diffBytes).equals(Buffer.from(clean.diffBytes))).toBe(true);
    expect(tampered.changeSource.files[0]!.binary).toBe(false);
  });

  it("ignores repo-local diff configuration that porcelain diff honors", async () => {
    const { repository: repo, clean } = await hardeningFixture();
    await fixtureGit(repo, ["config", "diff.noprefix", "true"]);
    await fixtureGit(repo, ["config", "diff.context", "0"]);
    await fixtureGit(repo, ["config", "diff.suppressBlankEmpty", "true"]);
    await fixtureGit(repo, ["config", "diff.interHunkContext", "10"]);
    expect(await fixtureGit(repo, ["diff", "HEAD~1", "HEAD"])).toContain("--- f.txt");
    const tampered = await resolve(repo, "HEAD~1..HEAD");
    expect(Buffer.from(tampered.diffBytes).equals(Buffer.from(clean.diffBytes))).toBe(true);
    expect(diffText(tampered).split("\n")).toContain("--- a/f.txt");
  });

  it("refuses a grafts file that would rewrite the commit list", async () => {
    const { repository: repo } = await hardeningFixture();
    await commitFiles(repo, { "f.txt": "omega\n" }, "third");
    const middle = await fixtureGit(repo, ["rev-parse", "HEAD~1"]);
    await writeFile(join(repo, ".git", "info", "grafts"), `${middle}\n`);
    await expectRefusal(resolve(repo, "HEAD~2..HEAD"), "change-source-grafts-present");
  });

  it("runs no hook and labels a non-empty info/attributes", async () => {
    const { repository: repo, root } = await hardeningFixture();
    const hooks = join(root, "hooks");
    await mkdir(hooks);
    const marker = join(root, "hook-ran");
    for (const hook of ["reference-transaction", "post-checkout", "post-index-change"]) {
      await writeFile(join(hooks, hook), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
    }
    await fixtureGit(repo, ["config", "core.hooksPath", hooks]);
    await writeFile(join(repo, ".git", "info", "attributes"), "*.bin binary\n");
    const resolved = await resolve(repo, "HEAD~1..HEAD");
    expect(resolved.changeSource.labels).toEqual(["info-attributes-present"]);
    await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never runs a configured textconv driver (producer level)", async () => {
    const { repository: repo, clean } = await hardeningFixture();
    await fixtureGit(repo, ["config", "diff.marked.textconv", "sed s/^/X/"]);
    await writeFile(join(repo, ".git", "info", "attributes"), "f.txt diff=marked\n");
    // Positive control: porcelain git runs the driver.
    expect(await fixtureGit(repo, ["diff", "HEAD~1", "HEAD"])).toContain("+XBETA");
    const tampered = await resolve(repo, "HEAD~1..HEAD");
    expect(Buffer.from(tampered.diffBytes).equals(Buffer.from(clean.diffBytes))).toBe(true);
  });
});

describe("change-source bounds", () => {
  it("admits a commit count at its limit and refuses one over with the counted value", async () => {
    const { repository: repo } = await repository();
    for (const step of ["one", "two", "three"]) {
      await commitFiles(repo, { "a.md": `${step}\n` }, step);
    }
    override("DOCSFAB_CHANGE_SOURCES_COMMITS_MAX", 2);
    const commits = limit("changeSources.commitsMax").value;
    const admitted = await resolve(repo, `HEAD~${commits}..HEAD`);
    expect(admitted.changeSource.commits).toHaveLength(commits);
    const error = await resolve(repo, `HEAD~${commits + 1}..HEAD`).catch((caught) => caught);
    expect(error).toBeInstanceOf(OperationalLimitError);
    expect(error).toMatchObject({ code: "change-source-commits-bound", observed: commits + 1 });
  });

  it("admits a shallow exclusion walk crossing its limit of boundary commits and refuses one more", async () => {
    override("DOCSFAB_CHANGE_SOURCES_SHALLOW_BOUNDARY_COMMITS_MAX", 2);
    const crossings = limit("changeSources.shallowBoundaryCommitsMax").value;
    const { repository: repo } = await repository();
    const chain: string[] = [await fixtureGit(repo, ["rev-parse", "HEAD"])];
    for (let step = 0; step <= crossings + 1; step += 1) {
      chain.push(await commitFiles(repo, { "a.md": `${step}\n` }, `step ${step}`));
    }
    const head = chain.at(-1)!;
    const base = chain.at(-2)!;
    // Every boundary commit's parent is present, so the walk crosses each in
    // turn: the base, then each listed ancestor below it.
    const boundaryOf = (count: number) => chain.slice(-1 - count, -1);
    const shallow = join(repo, ".git", "shallow");
    await writeFile(shallow, `${boundaryOf(crossings).join("\n")}\n`);
    expect(await fixtureGit(repo, ["rev-parse", "--is-shallow-repository"])).toBe("true");
    const admitted = await resolve(repo, `${base}..${head}`);
    expect(admitted.changeSource.commits.map((commit) => commit.id)).toEqual([head]);
    await writeFile(shallow, `${boundaryOf(crossings + 1).join("\n")}\n`);
    const error = await resolve(repo, `${base}..${head}`).catch((caught) => caught);
    expect(error).toBeInstanceOf(OperationalLimitError);
    expect(error).toMatchObject({
      code: "change-source-shallow-boundary-bound",
      observed: crossings + 1,
    });
  });

  it("admits a changed-file count at its limit and refuses one over", async () => {
    const { repository: repo } = await repository();
    await commitFiles(repo, { "a.md": "a\n", "b.md": "b\n" }, "two files");
    await commitFiles(repo, { "c.md": "c\n" }, "third file");
    override("DOCSFAB_CHANGE_SOURCES_CHANGED_FILES_MAX", 2);
    const files = limit("changeSources.changedFilesMax").value;
    expect((await resolve(repo, "HEAD~2..HEAD~1")).changeSource.files).toHaveLength(files);
    const error = await resolve(repo, "HEAD~2..HEAD").catch((caught) => caught);
    expect(error).toMatchObject({ code: "change-source-changed-files-bound", observed: files + 1 });
  });

  it("admits a diff at its byte limit and refuses one byte over", async () => {
    const { repository: repo } = await repository();
    await commitFiles(repo, { "a.md": "alpha\n", "b.md": "beta\n" }, "change");
    const size = (await resolve(repo, "HEAD~1..HEAD")).diffBytes.byteLength;
    override("DOCSFAB_CHANGE_SOURCES_DIFF_MAX_BYTES", size);
    override("DOCSFAB_CHANGE_SOURCES_FILE_DIFF_MAX_BYTES", size);
    expect((await resolve(repo, "HEAD~1..HEAD")).diffBytes.byteLength).toBe(
      limit("changeSources.diffMaxBytes").value,
    );
    override("DOCSFAB_CHANGE_SOURCES_DIFF_MAX_BYTES", size - 1);
    override("DOCSFAB_CHANGE_SOURCES_FILE_DIFF_MAX_BYTES", size - 1);
    const error = await resolve(repo, "HEAD~1..HEAD").catch((caught) => caught);
    expect(error).toMatchObject({ code: "change-source-diff-bound", observed: size });
  });

  it("omits one file's oversized diff with a label, judged per file, and still admits the range", async () => {
    const { repository: repo } = await repository();
    await commitFiles(repo, { "small.md": "s\n", "medium.md": "m\n".repeat(40) }, "change");
    const clean = await resolve(repo, "HEAD~1..HEAD");
    const sections = diffText(clean).split(/(?=^diff --git )/mu);
    const small = Buffer.byteLength(sections.find((part) => part.includes("small.md"))!);
    const medium = Buffer.byteLength(sections.find((part) => part.includes("medium.md"))!);
    expect(medium).toBeGreaterThan(small);
    override("DOCSFAB_CHANGE_SOURCES_FILE_DIFF_MAX_BYTES", small);
    const fileLimit = limit("changeSources.fileDiffMaxBytes").value;
    const resolved = await resolve(repo, "HEAD~1..HEAD");
    const byPath = new Map(resolved.changeSource.files.map((file) => [file.newPath, file]));
    // Exactly at the per-file limit: kept. Over it but well under the total: omitted.
    expect(byPath.get("small.md")!.diffOmitted).toBeUndefined();
    expect(byPath.get("medium.md")!.diffOmitted).toEqual({
      code: "change-source-file-diff-omitted",
      observedBytes: medium,
      basis: "measured",
      limitName: "changeSources.fileDiffMaxBytes",
      limitBytes: fileLimit,
    });
    expect(medium).toBeLessThan(limit("changeSources.diffMaxBytes").value);
    expect(diffText(resolved)).not.toContain("medium.md");
  });

  it("omits a lockfile-sized diff, and one too large to read at all, without refusing the range", async () => {
    const { repository: repo } = await repository();
    const lockLines = Array.from(
      { length: 12_000 },
      (_, index) => `"pkg-${index}": "1.0.${index}"`,
    );
    await commitFiles(repo, { "package-lock.json": `${lockLines.join("\n")}\n` }, "lock v1");
    const huge = Buffer.alloc(limit("hostInvoker.gitOutputMaxBytes").value / 2 + 1, "x");
    await commitFiles(
      repo,
      {
        "package-lock.json": `${lockLines.map((line) => line.replace("1.0.", "2.0.")).join("\n")}\n`,
        "bundle.js": huge,
        "docs/guide.md": "The guide.\n",
      },
      "bump",
    );
    const resolved = await resolve(repo, "HEAD~1..HEAD");
    const byPath = new Map(resolved.changeSource.files.map((file) => [file.newPath, file]));
    expect(byPath.get("package-lock.json")!.diffOmitted).toMatchObject({ basis: "measured" });
    expect(byPath.get("bundle.js")!.diffOmitted).toMatchObject({ basis: "upper-bound" });
    expect(byPath.get("docs/guide.md")!.diffOmitted).toBeUndefined();
    expect(diffText(resolved)).toContain("+The guide.");
  });

  it("reads a rename's diff when an unreadable file forces reads by path", async () => {
    const { repository: repo } = await repository({ "old-name.md": "stable text\n".repeat(20) });
    const huge = Buffer.alloc(limit("hostInvoker.gitOutputMaxBytes").value / 2 + 1, "x");
    await commitFiles(
      repo,
      { "old-name.md": null, "new-name.md": "stable text\n".repeat(20), "bundle.js": huge },
      "rename beside a bundle",
    );
    const resolved = await resolve(repo, "HEAD~1..HEAD");
    const byPath = new Map(resolved.changeSource.files.map((file) => [file.newPath, file]));
    expect(byPath.get("bundle.js")!.diffOmitted).toMatchObject({ basis: "upper-bound" });
    expect(byPath.get("new-name.md")).toMatchObject({ status: "R", oldPath: "old-name.md" });
    const lines = diffText(resolved).split("\n");
    expect(lines).toContain("rename from old-name.md");
    expect(lines).toContain("rename to new-name.md");
  });

  it("refuses a manifest that would not extract whole, at the limit and one byte under", async () => {
    const { repository: repo } = await repository();
    await commitFiles(repo, { "a.md": "alpha\n" }, "a subject long enough to outweigh the diff");
    const clean = await resolve(repo, "HEAD~1..HEAD");
    const manifest = clean.manifestBytes.byteLength;
    const diff = clean.diffBytes.byteLength;
    expect(diff).toBeLessThan(manifest);
    override("DOCSFAB_CHANGE_SOURCES_DIFF_MAX_BYTES", diff);
    override("DOCSFAB_CHANGE_SOURCES_FILE_DIFF_MAX_BYTES", diff);
    override("DOCSFAB_SOURCES_EXTRACTION_MAX_DERIVATIVE_BYTES", manifest);
    expect((await resolve(repo, "HEAD~1..HEAD")).manifestBytes.byteLength).toBe(
      limit("sources.extractionMaxDerivativeBytes").value,
    );
    override("DOCSFAB_SOURCES_EXTRACTION_MAX_DERIVATIVE_BYTES", manifest - 1);
    const error = await resolve(repo, "HEAD~1..HEAD").catch((caught) => caught);
    expect(error).toBeInstanceOf(OperationalLimitError);
    expect(error).toMatchObject({
      code: "sources-extraction-max-derivative-bytes-bound",
      observed: manifest,
    });
  });

  it("refuses contradictory limits before any git read, and admits a diff bound equal to the derivative bound", () => {
    expect(() => changeSourceLimits()).not.toThrow();
    override(
      "DOCSFAB_CHANGE_SOURCES_DIFF_MAX_BYTES",
      limit("changeSources.fileDiffMaxBytes").value,
    );
    override(
      "DOCSFAB_CHANGE_SOURCES_FILE_DIFF_MAX_BYTES",
      limit("changeSources.diffMaxBytes").value + 1,
    );
    expect(() => changeSourceLimits()).toThrow(
      expect.objectContaining({ code: "change-source-limits-inconsistent" }),
    );
    delete process.env.DOCSFAB_CHANGE_SOURCES_FILE_DIFF_MAX_BYTES;
    override(
      "DOCSFAB_SOURCES_EXTRACTION_MAX_DERIVATIVE_BYTES",
      limit("changeSources.diffMaxBytes").value - 1,
    );
    expect(() => changeSourceLimits()).toThrow(
      expect.objectContaining({ code: "change-source-limits-inconsistent" }),
    );
    // The relation compares raw bytes and admits equality; the resolver's
    // extraction of the diff, with its manifest, is what refuses a diff
    // whose extracted form would not fit.
    override(
      "DOCSFAB_SOURCES_EXTRACTION_MAX_DERIVATIVE_BYTES",
      limit("changeSources.diffMaxBytes").value,
    );
    expect(() => changeSourceLimits()).not.toThrow();
  });

  it("maps an unrelated git failure to git-failed, not to missing history", async () => {
    const { repository: repo, root } = await repository();
    for (const step of ["one", "two", "three"]) {
      await commitFiles(repo, { "a.md": `${step}\n` }, step);
    }
    const shallow = join(root, "shallow");
    await fixtureGit(root, ["clone", "-q", "--depth=2", `file://${repo}`, shallow]);
    const tree = await fixtureGit(shallow, ["rev-parse", "HEAD^{tree}"]);
    // A clone arrives packed: move the pack aside and explode it into loose
    // objects, so one object can be corrupted on its own.
    const packDirectory = join(shallow, ".git", "objects", "pack");
    const pack = (await readdir(packDirectory)).find((name) => name.endsWith(".pack"))!;
    const packBytes = await readFile(join(packDirectory, pack));
    await rm(packDirectory, { recursive: true, force: true });
    await mkdir(packDirectory);
    await fixtureGit(shallow, ["unpack-objects", "-q"], packBytes);
    const path = join(shallow, ".git", "objects", tree.slice(0, 2), tree.slice(2));
    await chmod(path, 0o644);
    await writeFile(path, Buffer.from("not a zlib stream"));
    await expectRefusal(resolve(shallow, "HEAD~1..HEAD"), "change-source-git-failed");
  });
});

describe("change-source failure scoping", () => {
  it("lets a caller abort through instead of reporting it as a git failure", async () => {
    const { repository: repo } = await repository();
    await commitFiles(repo, { "a.md": "one\n" }, "change");
    const error = await resolveLocalChangeSource({
      sourcePath: repo,
      selector: parseChangeSourceSelector("HEAD~1..HEAD"),
      workspaceRevision: await fixtureGit(repo, ["rev-parse", "HEAD"]),
      signal: AbortSignal.abort(),
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ name: "AbortError" });
    expect(error).not.toBeInstanceOf(ChangeSourceError);
  });

  it("reports a malformed interior commit as a git failure, never as unrelated histories", async () => {
    const { repository: repo } = await repository();
    const root = await fixtureGit(repo, ["rev-parse", "HEAD"]);
    const interior = await commitFiles(repo, { "a.md": "one\n" }, "interior");
    const head = await commitFiles(repo, { "a.md": "two\n" }, "head");
    const path = join(repo, ".git", "objects", interior.slice(0, 2), interior.slice(2));
    await chmod(path, 0o644);
    await writeFile(path, Buffer.from("not a zlib stream"));
    // Both endpoints resolve; merge-base fails walking through the broken commit.
    await expectRefusal(resolve(repo, `${root}...${head}`), "change-source-git-failed");
  });

  it("treats only an absent grafts file as absent, not an unreadable git directory", async () => {
    const { repository: repo } = await repository();
    await commitFiles(repo, { "a.md": "one\n" }, "change");
    await rm(join(repo, ".git", "info"), { recursive: true, force: true });
    await writeFile(join(repo, ".git", "info"), "not a directory\n");
    const error = await resolve(repo, "HEAD~1..HEAD").catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "ENOTDIR" });
  });
});

describe("change-source encoding and credentials", () => {
  it("refuses a Latin-1 file change as an encoding problem, not a credential", async () => {
    const { repository: repo } = await repository();
    await commitFiles(
      repo,
      { "latin.txt": Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]) },
      "latin-1",
    );
    await expectRefusal(resolve(repo, "HEAD~1..HEAD"), "change-source-encoding-unsupported");
  });

  it("reads a path that holds a tab", async () => {
    const { repository: repo } = await repository();
    await commitFiles(repo, { "tab\tname.md": "one\ntwo\n" }, "tab path");
    await commitFiles(repo, { "tab\tname.md": "one\nthree\nfour\n" }, "edit tab path");
    const resolved = await resolve(repo, "HEAD~1..HEAD");
    expect(resolved.changeSource.files).toEqual([
      expect.objectContaining({ status: "M", newPath: "tab\tname.md", added: 2, removed: 1 }),
    ]);
  });

  it("refuses a non-UTF-8 path", async () => {
    const { repository: repo } = await repository();
    const blob = await fixtureGit(repo, ["hash-object", "-w", "--stdin"], "text\n");
    const tree = await fixtureGit(
      repo,
      ["mktree"],
      Buffer.concat([
        Buffer.from(`100644 blob ${blob}\t`, "latin1"),
        Buffer.from([0x63, 0x61, 0x66, 0xe9]),
        Buffer.from("\n", "latin1"),
      ]),
    );
    const commit = await fixtureGit(repo, ["commit-tree", tree, "-p", "HEAD", "-m", "bad path"]);
    await fixtureGit(repo, ["update-ref", "refs/heads/main", commit]);
    await expectRefusal(resolve(repo, "HEAD~1..HEAD"), "change-source-encoding-unsupported");
  });

  it("refuses a configured credential and admits credential-shaped text that is not one", async () => {
    const { repository: repo } = await repository();
    const token = configureCredential(["glpat", "Qz8Lk2Vn5Mc7Bt4Rw9Xh3Jd6"].join("-"));
    await commitFiles(
      repo,
      {
        "notes.md": [
          `aws ${["AKIA", "IOSFODNN7", "EXAMPLE"].join("")}`,
          `digest ${"ab".repeat(32)}`,
          "-----BEGIN PUBLIC KEY-----",
          "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE",
          "-----END PUBLIC KEY-----",
          "",
        ].join("\n"),
      },
      "benign",
    );
    const benign = await resolve(repo, "HEAD~1..HEAD");
    expect(diffText(benign)).toContain("BEGIN PUBLIC KEY");
    await commitFiles(repo, { "leak.md": `token ${token}\n` }, "leak");
    await expectRefusal(resolve(repo, "HEAD~1..HEAD"), "change-source-credential-present");
  });

  it("refuses a configured credential in a commit subject or a path, never as a malformed record", async () => {
    const { repository: repo } = await repository();
    const token = configureCredential(["glpat", "Lm4Pq7Rs1Tv8Wx2Yz5Ab3Cd9"].join("-"));
    // Adjacent: an unconfigured credential-shaped subject admits.
    await commitFiles(repo, { "a.md": "a\n" }, ["glpat", "Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2"].join("-"));
    expect((await resolve(repo, "HEAD~1..HEAD")).changeSource.commits).toHaveLength(1);
    await commitFiles(repo, { "b.md": "b\n" }, `subject ${token}`);
    await expectRefusal(resolve(repo, "HEAD~1..HEAD"), "change-source-credential-present");
    await commitFiles(repo, { [`dir-${token}.md`]: "c\n" }, "path");
    await expectRefusal(resolve(repo, "HEAD~1..HEAD"), "change-source-credential-present");
  });
});
