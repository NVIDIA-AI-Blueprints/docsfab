// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { constants } from "node:fs";
import { access, chmod, lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, delimiter, join } from "node:path";

import { describe, expect, it, type TestContext } from "vitest";

import { deterministicLocalUserSourceBranch } from "../src/delivery/index.js";
import {
  branchCleanupEvidenceDigest,
  cleanupRunDeliveryBranch,
  validBranchCleanupEvidence,
  type GitDeletionIdentity,
  type RunDeliveryBranchCleanupEvidence,
} from "../src/delivery/worktree/run-deletion-cleanup.js";
import { assertSafeGitOperation } from "../src/delivery/worktree/host.js";
import { commitFixture, git, gitVersionAtLeast, initFixtureRepo } from "./helpers/git.js";
import { temporaryRoots } from "./helpers/temp.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";

// These cases call the delete-time branch cleanup directly. A CLI case in
// run-deletion-retained-attempts.test.ts reaches it only after a preview has
// vetted the branch, so a guard that the delete repeats for the window between
// the preview and the confirmation stays invisible to it unless the case also
// changes the repository in that window.
const temporary = temporaryRoots();

async function directoryIdentity(path: string): Promise<GitDeletionIdentity> {
  const stat = await lstat(path);
  return { path, dev: stat.dev, ino: stat.ino, size: 0, mtimeMs: 0, kind: "directory" };
}

/** Evidence as a preview would record it: the branch pinned at `revision`, digest included. */
async function evidenceFor(
  source: string,
  branch: string,
  revision: string,
): Promise<RunDeliveryBranchCleanupEvidence> {
  const commonGitDirectory = join(source, ".git");
  const body = {
    sourcePath: source,
    commonGitDirectory,
    branch,
    revision,
    source: await directoryIdentity(source),
    commonGit: await directoryIdentity(commonGitDirectory),
  };
  return { ...body, digest: branchCleanupEvidenceDigest(body) };
}

async function fixture() {
  const root = await temporary.create("docsfab-branch-guards-", { realpath: true });
  const source = join(await realpath(root), "source");
  const base = await initFixtureRepo(
    source,
    { "README.md": "base\n" },
    { branch: "main", message: "base" },
  );
  return { root, source, base };
}

async function branchTip(source: string, branch: string): Promise<string | undefined> {
  return (
    (await git(source, ["for-each-ref", "--format=%(objectname)", `refs/heads/${branch}`])) ||
    undefined
  );
}

async function isDetached(worktree: string): Promise<boolean> {
  return git(worktree, ["symbolic-ref", "-q", "HEAD"]).then(
    () => false,
    () => true,
  );
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** The `git` that PATH resolves to right now, before any wrapper is installed. */
async function realGit(): Promise<string> {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, "git");
    if (
      await access(candidate, constants.X_OK).then(
        () => true,
        () => false,
      )
    )
      return candidate;
  }
  throw new Error("git is not on PATH");
}

/**
 * Runs `commands` once, immediately before the first `update-ref` that `run` starts, by putting a
 * `git` wrapper first on PATH. DocsFab starts Git with a minimal environment, so the commands travel
 * in a file beside the wrapper.
 */
async function withCommandsBeforeUpdateRef<T>(commands: string, run: () => Promise<T>): Promise<T> {
  const directory = await temporary.create("docsfab-git-wrapper-");
  const hook = join(directory, "before-update-ref.sh");
  await writeFile(hook, commands);
  await writeFile(
    join(directory, "git"),
    [
      "#!/bin/sh",
      `hook=${shellQuote(hook)}`,
      'for argument in "$@"; do',
      '  if [ "$argument" = update-ref ] && [ -f "$hook" ]; then',
      '    mv "$hook" "$hook.ran" && /bin/sh "$hook.ran" > /dev/null 2>&1',
      "    break",
      "  fi",
      "done",
      `exec ${shellQuote(await realGit())} "$@"`,
      "",
    ].join("\n"),
  );
  await chmod(join(directory, "git"), 0o755);
  const saved = process.env.PATH ?? "";
  process.env.PATH = `${directory}${delimiter}${saved}`;
  try {
    return await run();
  } finally {
    process.env.PATH = saved;
  }
}

/**
 * DocsFab run branches stacked one commit each, a topic branch on the last of them, and a main that
 * moves on. Rebasing the topic onto main with `--update-refs` then moves every run branch too.
 */
async function stackedRunBranches(
  source: string,
  branches: readonly string[],
): Promise<{ branch: string; tip: string }[]> {
  const stacked: { branch: string; tip: string }[] = [];
  for (const branch of branches) {
    await git(source, ["switch", "-q", "-c", branch]);
    await writeFile(join(source, `${branch.replaceAll("/", "-")}.txt`), `${branch}\n`);
    stacked.push({ branch, tip: await commitFixture(source, `commit for ${branch}`) });
  }
  await git(source, ["switch", "-q", "-c", "topic"]);
  await writeFile(join(source, "topic.txt"), "topic\n");
  await commitFixture(source, "topic work");
  await git(source, ["switch", "-q", "main"]);
  await writeFile(join(source, "main-moves.txt"), "main\n");
  await commitFixture(source, "main moves on");
  return stacked;
}

async function stackedRunBranch(source: string): Promise<{ branch: string; tip: string }> {
  return (await stackedRunBranches(source, ["docsfab-run/stacked"]))[0]!;
}

/** `git rebase --update-refs` and Git's own guard for it first appeared in Git 2.38. */
async function requireUpdateRefs(context: TestContext): Promise<void> {
  if (!(await gitVersionAtLeast(2, 38))) {
    context.skip("rebase --update-refs and Git's guard for it need Git 2.38 or later");
  }
}

/** Starts `git rebase --update-refs main` in `worktree`; the failing exec step stops it part-way. */
async function stopUpdateRefsRebase(worktree: string): Promise<string> {
  await git(worktree, ["rebase", "--update-refs", "-x", "false", "main"], {
    env: { GIT_SEQUENCE_EDITOR: "true" },
  }).then(
    () => expect.unreachable("the rebase should stop at the failing exec step"),
    () => undefined,
  );
  expect(await isDetached(worktree)).toBe(true);
  return git(worktree, ["rev-parse", "--absolute-git-dir"]);
}

describe("run branch deletion guards", { timeout: testTimeoutMs(120_000) }, () => {
  it("deletes an approved branch at its approved tip and nothing else", async () => {
    const { source, base } = await fixture();
    await git(source, ["branch", "docsfab-run/delete", base]);
    await git(source, ["branch", "docsfab-run/delete-neighbor", base]);
    const evidence = await evidenceFor(source, "docsfab-run/delete", base);
    expect(validBranchCleanupEvidence(evidence)).toBe(true);

    await expect(cleanupRunDeliveryBranch(evidence)).resolves.toBe(true);

    expect(await branchTip(source, "docsfab-run/delete")).toBeUndefined();
    expect(await branchTip(source, "docsfab-run/delete-neighbor")).toBe(base);
    expect(await branchTip(source, "main")).toBe(base);
    await expect(cleanupRunDeliveryBranch(evidence)).resolves.toBe(false);
  });

  it("leaves the branch's upstream settings in the repository configuration", async () => {
    const { source, base } = await fixture();
    const branch = "docsfab-run/configured";
    await git(source, ["branch", branch, base]);
    await git(source, ["config", `branch.${branch}.remote`, "origin"]);
    await git(source, ["config", `branch.${branch}.merge`, `refs/heads/${branch}`]);

    await expect(cleanupRunDeliveryBranch(await evidenceFor(source, branch, base))).resolves.toBe(
      true,
    );

    expect(await branchTip(source, branch)).toBeUndefined();
    // Compare-and-delete removes the ref only; `git branch -D` would also drop these entries.
    expect(await git(source, ["config", "--get", `branch.${branch}.remote`])).toBe("origin");
    expect(await readFile(join(source, ".git", "config"), "utf8")).toContain(
      `[branch "${branch}"]`,
    );
  });

  it("refuses a branch whose tip moved after the approved inventory and keeps the commit", async () => {
    const { source, base } = await fixture();
    await git(source, ["branch", "docsfab-run/moved", base]);
    const evidence = await evidenceFor(source, "docsfab-run/moved", base);
    const tree = await git(source, ["rev-parse", `${base}^{tree}`]);
    const operator = await git(source, ["commit-tree", tree, "-p", base, "-m", "operator work"]);
    await git(source, ["update-ref", "refs/heads/docsfab-run/moved", operator, base]);

    await expect(cleanupRunDeliveryBranch(evidence)).rejects.toThrow(
      "Branch docsfab-run/moved moved after preview; inspect it and preview again.",
    );

    expect(await branchTip(source, "docsfab-run/moved")).toBe(operator);
  });

  it("refuses evidence for a branch outside docsfab-run even when its digest is consistent", async () => {
    const { source, base } = await fixture();
    await git(source, ["branch", "feature/operator", base]);
    const forged = await evidenceFor(source, "feature/operator", base);
    expect(validBranchCleanupEvidence(forged)).toBe(false);

    await expect(cleanupRunDeliveryBranch(forged)).rejects.toThrow(
      "Approved branch inventory changed for feature/operator; preview again.",
    );

    expect(await branchTip(source, "feature/operator")).toBe(base);
    expect(await branchTip(source, "main")).toBe(base);
  });

  it("refuses evidence whose digest does not match its content", async () => {
    const { source, base } = await fixture();
    await git(source, ["branch", "docsfab-run/tampered", base]);
    const evidence = await evidenceFor(source, "docsfab-run/tampered", base);
    const tampered = { ...evidence, revision: "0".repeat(40) };
    expect(validBranchCleanupEvidence(tampered)).toBe(false);

    await expect(cleanupRunDeliveryBranch(tampered)).rejects.toThrow(
      "Approved branch inventory changed for docsfab-run/tampered; preview again.",
    );

    expect(await branchTip(source, "docsfab-run/tampered")).toBe(base);
  });

  it("refuses a branch that a linked worktree has checked out", async () => {
    const { root, source, base } = await fixture();
    await git(source, ["branch", "docsfab-run/linked", base]);
    const evidence = await evidenceFor(source, "docsfab-run/linked", base);
    const operator = join(root, "operator-linked");
    await git(source, ["worktree", "add", "-q", operator, "docsfab-run/linked"]);

    await expect(cleanupRunDeliveryBranch(evidence)).rejects.toThrow(
      `Branch docsfab-run/linked is checked out at ${operator}; preview again.`,
    );

    expect(await branchTip(source, "docsfab-run/linked")).toBe(base);
    expect(await git(operator, ["symbolic-ref", "HEAD"])).toBe("refs/heads/docsfab-run/linked");
  });

  it("refuses a branch that the original checkout has checked out", async () => {
    const { source, base } = await fixture();
    await git(source, ["switch", "-q", "-c", "docsfab-run/primary"]);
    const evidence = await evidenceFor(source, "docsfab-run/primary", base);

    await expect(cleanupRunDeliveryBranch(evidence)).rejects.toThrow(
      `Branch docsfab-run/primary is checked out at ${source}; preview again.`,
    );

    expect(await branchTip(source, "docsfab-run/primary")).toBe(base);
    expect(await git(source, ["symbolic-ref", "HEAD"])).toBe("refs/heads/docsfab-run/primary");
  });

  it("refuses a branch that a rebase in another worktree began on", async () => {
    const { root, source, base } = await fixture();
    const branch = "docsfab-run/rebasing";
    await git(source, ["branch", branch, base]);
    const evidence = await evidenceFor(source, branch, base);
    const operator = join(root, "operator-rebase");
    await git(source, ["worktree", "add", "-q", operator, branch]);
    // The exec step fails on purpose, which stops the rebase part-way with HEAD detached.
    await git(operator, ["rebase", "--root", "-x", "false"], {
      env: { GIT_SEQUENCE_EDITOR: "true" },
    }).then(
      () => expect.unreachable("the rebase should stop at the failing exec step"),
      () => undefined,
    );
    expect(await isDetached(operator)).toBe(true);

    await expect(cleanupRunDeliveryBranch(evidence)).rejects.toThrow(
      `Branch ${branch} is being rebased at ${operator}; preview again.`,
    );

    expect(await branchTip(source, branch)).toBe(base);
  });

  it("refuses a branch that an apply-backend rebase in another worktree began on", async () => {
    const { root, source } = await fixture();
    const branch = "docsfab-run/applying";
    await git(source, ["switch", "-q", "-c", branch]);
    await writeFile(join(source, "README.md"), "branch change\n");
    const tip = await commitFixture(source, "branch change");
    await git(source, ["switch", "-q", "main"]);
    await writeFile(join(source, "README.md"), "main change\n");
    await commitFixture(source, "main change");
    const evidence = await evidenceFor(source, branch, tip);
    const operator = join(root, "operator-apply");
    await git(source, ["worktree", "add", "-q", operator, branch]);
    // Both sides changed README.md, so the replay stops on a conflict with HEAD detached.
    await git(operator, ["rebase", "--apply", "main"]).then(
      () => expect.unreachable("the rebase should stop on a conflict"),
      () => undefined,
    );
    expect(await isDetached(operator)).toBe(true);

    await expect(cleanupRunDeliveryBranch(evidence)).rejects.toThrow(
      `Branch ${branch} is being rebased at ${operator}; preview again.`,
    );

    expect(await branchTip(source, branch)).toBe(tip);
  });

  it("refuses a branch that a bisect in another worktree began on", async () => {
    const { root, source, base } = await fixture();
    await commitFixture(source, "second");
    const tip = await commitFixture(source, "third");
    const branch = "docsfab-run/bisecting";
    await git(source, ["branch", branch, tip]);
    const evidence = await evidenceFor(source, branch, tip);
    const operator = join(root, "operator-bisect");
    await git(source, ["worktree", "add", "-q", operator, branch]);
    await git(operator, ["bisect", "start"]);
    await git(operator, ["bisect", "bad"]);
    await git(operator, ["bisect", "good", base]);
    // Bisecting checks out a commit between the two, so only Git's bisect state names the branch.
    expect(await isDetached(operator)).toBe(true);

    await expect(cleanupRunDeliveryBranch(evidence)).rejects.toThrow(
      `Branch ${branch} is being bisected at ${operator}; preview again.`,
    );

    expect(await branchTip(source, branch)).toBe(tip);
  });

  it("refuses a branch that a rebase with update-refs in another worktree will move", async (context) => {
    await requireUpdateRefs(context);
    const { root, source, base } = await fixture();
    const { branch, tip } = await stackedRunBranch(source);
    await git(source, ["branch", "docsfab-run/unrelated", base]);
    const operator = join(root, "operator-update-refs");
    await git(source, ["worktree", "add", "-q", operator, "topic"]);
    // HEAD of that worktree names topic, so only the update-refs state lists the run branch.
    const gitDirectory = await stopUpdateRefsRebase(operator);
    expect(await readFile(join(gitDirectory, "rebase-merge", "head-name"), "utf8")).toBe(
      "refs/heads/topic\n",
    );
    expect(await readFile(join(gitDirectory, "rebase-merge", "update-refs"), "utf8")).toContain(
      `refs/heads/${branch}\n`,
    );
    // Git refuses this deletion itself, so DocsFab has to refuse it too. Git's wording varies by version.
    await expect(git(source, ["branch", "-D", branch])).rejects.toThrow();
    expect(await branchTip(source, branch)).toBe(tip);

    await expect(cleanupRunDeliveryBranch(await evidenceFor(source, branch, tip))).rejects.toThrow(
      `Branch ${branch} is being rebased at ${operator}; preview again.`,
    );

    expect(await branchTip(source, branch)).toBe(tip);
    // The state names only the branches that the rebase will move.
    await expect(
      cleanupRunDeliveryBranch(await evidenceFor(source, "docsfab-run/unrelated", base)),
    ).resolves.toBe(true);
  });

  it("refuses a branch that a rebase with update-refs in the original checkout will move", async (context) => {
    await requireUpdateRefs(context);
    const { source } = await fixture();
    const { branch, tip } = await stackedRunBranch(source);
    await git(source, ["switch", "-q", "topic"]);
    const gitDirectory = await stopUpdateRefsRebase(source);
    expect(gitDirectory).toBe(join(source, ".git"));
    expect(await readFile(join(gitDirectory, "rebase-merge", "update-refs"), "utf8")).toContain(
      `refs/heads/${branch}\n`,
    );
    await expect(git(source, ["branch", "-D", branch])).rejects.toThrow();
    expect(await branchTip(source, branch)).toBe(tip);

    await expect(cleanupRunDeliveryBranch(await evidenceFor(source, branch, tip))).rejects.toThrow(
      `Branch ${branch} is being rebased at ${source}; preview again.`,
    );

    expect(await branchTip(source, branch)).toBe(tip);
  });

  it("refuses every branch that a rebase with update-refs will move, whichever record lists it", async (context) => {
    await requireUpdateRefs(context);
    const { root, source } = await fixture();
    const stacked = await stackedRunBranches(source, [
      "docsfab-run/one",
      "docsfab-run/two",
      "docsfab-run/three",
    ]);
    const operator = join(root, "operator-many-refs");
    await git(source, ["worktree", "add", "-q", operator, "topic"]);
    const gitDirectory = await stopUpdateRefsRebase(operator);
    const listed = (await readFile(join(gitDirectory, "rebase-merge", "update-refs"), "utf8"))
      .split("\n")
      .filter((line) => line.startsWith("refs/heads/"))
      .sort();
    expect(listed).toEqual(stacked.map(({ branch }) => `refs/heads/${branch}`).sort());

    for (const { branch, tip } of stacked) {
      await expect(
        cleanupRunDeliveryBranch(await evidenceFor(source, branch, tip)),
        branch,
      ).rejects.toThrow(`Branch ${branch} is being rebased at ${operator}; preview again.`);
      expect(await branchTip(source, branch), branch).toBe(tip);
    }
  });

  it("reads every record of an update-refs file and matches only the exact branch name", async () => {
    const { root, source, base } = await fixture();
    const branch = "docsfab-run/records";
    const ref = `refs/heads/${branch}`;
    const oid = "a".repeat(40);
    const zero = "0".repeat(40);
    const record = (name: string, eol = "\n"): string => `${name}${eol}${oid}${eol}${zero}${eol}`;
    const operator = join(root, "operator-records");
    await git(source, ["worktree", "add", "-q", "--detach", operator, base]);
    const gitDirectory = await git(operator, ["rev-parse", "--absolute-git-dir"]);
    await mkdir(join(gitDirectory, "rebase-merge"), { recursive: true });
    const write = (content: string): Promise<void> =>
      writeFile(join(gitDirectory, "rebase-merge", "update-refs"), content);
    await git(source, ["branch", branch, base]);
    const evidence = await evidenceFor(source, branch, base);

    // Git writes three lines per ref and names several refs; the match must not depend on the
    // position of the record, on the line ends, or on padding around a line.
    const named: [string, string][] = [
      ["one record", record(ref)],
      ["no trailing newline", `${ref}\n${oid}\n${zero}`],
      ["second record", record("refs/heads/other") + record(ref)],
      ["third record", record("refs/heads/a") + record("refs/heads/b") + record(ref)],
      ["CRLF line ends", record(ref, "\r\n")],
      [
        "CRLF line ends in a later record",
        record("refs/heads/other", "\r\n") + record(ref, "\r\n"),
      ],
      ["blank and padded lines", `\n\n   ${ref}   \n${oid}\n${zero}\n`],
      ["tab padding", `\t${ref}\t\n${oid}\n${zero}\n`],
      ["a record cut after the ref", record("refs/heads/other") + ref],
    ];
    for (const [label, content] of named) {
      await write(content);
      await expect(cleanupRunDeliveryBranch(evidence), label).rejects.toThrow(
        `Branch ${branch} is being rebased at ${operator}; preview again.`,
      );
      expect(await branchTip(source, branch), label).toBe(base);
    }

    const other: [string, string][] = [
      ["a longer name", record(`${ref}-other`)],
      ["a child name", record(`${ref}/child`)],
      ["a name that this one extends", record("refs/heads/docsfab-run/record")],
      ["a different case", record("refs/heads/docsfab-run/RECORDS")],
      ["the short spelling", record(branch)],
      ["object ids only", `${oid}\n${zero}\n`],
      ["an empty file", ""],
    ];
    for (const [label, content] of other) {
      await write(content);
      await expect(cleanupRunDeliveryBranch(evidence), label).resolves.toBe(true);
      expect(await branchTip(source, branch), label).toBeUndefined();
      await git(source, ["branch", branch, base]);
    }
  });

  it("refuses a branch that a worktree's HEAD reaches through symbolic refs", async () => {
    const { root, source, base } = await fixture();
    const branch = "docsfab-run/aliased";
    await git(source, ["branch", branch, base]);
    // HEAD -> alias-two -> alias-one -> the run branch
    await git(source, ["symbolic-ref", "refs/heads/alias-one", `refs/heads/${branch}`]);
    await git(source, ["symbolic-ref", "refs/heads/alias-two", "refs/heads/alias-one"]);
    const operator = join(root, "operator-alias");
    await git(source, ["worktree", "add", "-q", "--detach", operator, base]);
    await git(operator, ["symbolic-ref", "HEAD", "refs/heads/alias-two"]);
    // Git resolves HEAD through the chain, so it refuses this deletion. Its wording varies by version.
    await expect(git(source, ["branch", "-D", branch])).rejects.toThrow();
    expect(await branchTip(source, branch)).toBe(base);

    await expect(cleanupRunDeliveryBranch(await evidenceFor(source, branch, base))).rejects.toThrow(
      `Branch ${branch} is checked out at ${operator}; preview again.`,
    );

    expect(await branchTip(source, branch)).toBe(base);
  });

  it("refuses a branch that the original checkout's HEAD reaches through symbolic refs", async () => {
    const { source, base } = await fixture();
    const branch = "docsfab-run/primary-aliased";
    await git(source, ["branch", branch, base]);
    await git(source, ["symbolic-ref", "refs/heads/alias", `refs/heads/${branch}`]);
    await git(source, ["symbolic-ref", "HEAD", "refs/heads/alias"]);

    await expect(cleanupRunDeliveryBranch(await evidenceFor(source, branch, base))).rejects.toThrow(
      `Branch ${branch} is checked out at ${source}; preview again.`,
    );

    expect(await branchTip(source, branch)).toBe(base);
  });

  it.each(["refs/worktree/alias", "refs/bisect/alias", "refs/rewritten/alias"] as const)(
    "refuses a branch that a linked worktree's HEAD reaches through %s",
    async (alias) => {
      const { root, source, base } = await fixture();
      const branch = "docsfab-run/per-worktree";
      await git(source, ["branch", branch, base]);
      const operator = join(root, "operator-per-worktree");
      await git(source, ["worktree", "add", "-q", "--detach", operator, base]);
      // Git keeps these refs in the linked worktree's own directory, not in the shared refs.
      await git(operator, ["symbolic-ref", alias, `refs/heads/${branch}`]);
      await git(operator, ["symbolic-ref", "HEAD", alias]);
      // Git resolves HEAD through the alias, so it lists the branch as checked out in that worktree.
      expect(await git(source, ["worktree", "list", "--porcelain"], { trim: false })).toContain(
        `worktree ${operator}\nHEAD ${base}\nbranch refs/heads/${branch}\n`,
      );

      await expect(
        cleanupRunDeliveryBranch(await evidenceFor(source, branch, base)),
      ).rejects.toThrow(`Branch ${branch} is checked out at ${operator}; preview again.`);

      expect(await branchTip(source, branch)).toBe(base);
      expect(await git(operator, ["rev-parse", "--verify", "HEAD"])).toBe(base);
    },
  );

  it("keeps refusing a branch when a linked worktree's own refs directory holds an entry that Git does not read", async () => {
    const { root, source, base } = await fixture();
    const branch = "docsfab-run/shadowed";
    await git(source, ["branch", branch, base]);
    // HEAD of the linked worktree -> the shared alias -> the run branch
    await git(source, ["symbolic-ref", "refs/heads/alias", `refs/heads/${branch}`]);
    const operator = join(root, "operator-shadowed");
    await git(source, ["worktree", "add", "-q", "--detach", operator, base]);
    await git(operator, ["symbolic-ref", "HEAD", "refs/heads/alias"]);
    // Git's own plumbing writes an alias into the worktree's directory. Only refs/worktree,
    // refs/bisect, and refs/rewritten are per-worktree there, so Git still reads the shared alias.
    const administration = await git(operator, ["rev-parse", "--absolute-git-dir"]);
    await git(source, [
      "update-ref",
      `worktrees/${basename(administration)}/refs/heads/alias`,
      base,
    ]);
    expect(await readFile(join(administration, "refs", "heads", "alias"), "utf8")).toBe(
      `${base}\n`,
    );
    expect(await git(source, ["worktree", "list", "--porcelain"], { trim: false })).toContain(
      `worktree ${operator}\nHEAD ${base}\nbranch refs/heads/${branch}\n`,
    );

    await expect(cleanupRunDeliveryBranch(await evidenceFor(source, branch, base))).rejects.toThrow(
      `Branch ${branch} is checked out at ${operator}; preview again.`,
    );

    expect(await branchTip(source, branch)).toBe(base);
    expect(await git(operator, ["rev-parse", "--verify", "HEAD"])).toBe(base);
  });

  it("follows a long chain of symbolic refs behind HEAD to its end", async () => {
    const { root, source, base } = await fixture();
    const branch = "docsfab-run/deep";
    await git(source, ["branch", branch, base]);
    // Deeper than Git itself resolves, so no depth cap may cut the walk short.
    let target = `refs/heads/${branch}`;
    for (let index = 1; index <= 12; index += 1) {
      await git(source, ["symbolic-ref", `refs/heads/deep-${index}`, target]);
      target = `refs/heads/deep-${index}`;
    }
    const operator = join(root, "operator-deep");
    await git(source, ["worktree", "add", "-q", "--detach", operator, base]);
    await git(operator, ["symbolic-ref", "HEAD", target]);

    await expect(cleanupRunDeliveryBranch(await evidenceFor(source, branch, base))).rejects.toThrow(
      `Branch ${branch} is checked out at ${operator}; preview again.`,
    );

    expect(await branchTip(source, branch)).toBe(base);
  });

  it("refuses a symbolic branch that a worktree's HEAD names directly", async () => {
    const { root, source, base } = await fixture();
    const branch = "docsfab-run/symbolic";
    // The run branch is itself a symbolic ref to main, and HEAD names the run branch.
    await git(source, ["symbolic-ref", `refs/heads/${branch}`, "refs/heads/main"]);
    const operator = join(root, "operator-symbolic");
    await git(source, ["worktree", "add", "-q", "--detach", operator, base]);
    await git(operator, ["symbolic-ref", "HEAD", `refs/heads/${branch}`]);

    await expect(cleanupRunDeliveryBranch(await evidenceFor(source, branch, base))).rejects.toThrow(
      `Branch ${branch} is checked out at ${operator}; preview again.`,
    );

    expect(await git(source, ["symbolic-ref", `refs/heads/${branch}`])).toBe("refs/heads/main");
    expect(await branchTip(source, "main")).toBe(base);
  });

  it("fails closed when the symbolic refs behind a worktree's HEAD form a cycle", async () => {
    const { root, source, base } = await fixture();
    await git(source, ["branch", "docsfab-run/unrelated", base]);
    const operator = join(root, "operator-cycle");
    await git(source, ["worktree", "add", "-q", "--detach", operator, base]);
    await git(operator, ["symbolic-ref", "HEAD", "refs/heads/loop-a"]);
    await writeFile(join(source, ".git", "refs", "heads", "loop-a"), "ref: refs/heads/loop-b\n");
    await writeFile(join(source, ".git", "refs", "heads", "loop-b"), "ref: refs/heads/loop-a\n");

    // HEAD cannot be resolved, so no branch is known to be free of it.
    await expect(
      cleanupRunDeliveryBranch(await evidenceFor(source, "docsfab-run/unrelated", base)),
    ).rejects.toMatchObject({ code: "cleanup-refused" });

    expect(await branchTip(source, "docsfab-run/unrelated")).toBe(base);
  });

  it("keeps a branch whose tip moves after the delete-time check and before the delete", async () => {
    const { source, base } = await fixture();
    const tree = await git(source, ["rev-parse", `${base}^{tree}`]);
    const operator = await git(source, ["commit-tree", tree, "-p", base, "-m", "operator work"]);

    // Positive control: through a wrapper that changes nothing, the same delete goes through.
    await git(source, ["branch", "docsfab-run/quiet", base]);
    const quiet = await evidenceFor(source, "docsfab-run/quiet", base);
    await expect(
      withCommandsBeforeUpdateRef("true\n", () => cleanupRunDeliveryBranch(quiet)),
    ).resolves.toBe(true);
    expect(await branchTip(source, "docsfab-run/quiet")).toBeUndefined();

    // The operator moves the tip after DocsFab's checks, just as the delete starts.
    await git(source, ["branch", "docsfab-run/racing", base]);
    const racing = await evidenceFor(source, "docsfab-run/racing", base);
    const moveTip = `${shellQuote(await realGit())} -C ${shellQuote(source)} update-ref refs/heads/docsfab-run/racing ${operator} ${base}\n`;
    await expect(
      withCommandsBeforeUpdateRef(moveTip, () => cleanupRunDeliveryBranch(racing)),
    ).rejects.toThrow(
      "Branch docsfab-run/racing moved after preview; inspect it and preview again.",
    );
    expect(await branchTip(source, "docsfab-run/racing")).toBe(operator);
  });

  it("deletes a branch that a rebase in another worktree began on a different branch", async () => {
    const { root, source, base } = await fixture();
    await git(source, ["branch", "docsfab-run/unrelated", base]);
    await git(source, ["branch", "operator-topic", base]);
    const evidence = await evidenceFor(source, "docsfab-run/unrelated", base);
    const operator = join(root, "operator-rebase-topic");
    await git(source, ["worktree", "add", "-q", operator, "operator-topic"]);
    await git(operator, ["rebase", "--root", "-x", "false"], {
      env: { GIT_SEQUENCE_EDITOR: "true" },
    }).then(
      () => expect.unreachable("the rebase should stop at the failing exec step"),
      () => undefined,
    );
    expect(await isDetached(operator)).toBe(true);

    await expect(cleanupRunDeliveryBranch(evidence)).resolves.toBe(true);

    expect(await branchTip(source, "docsfab-run/unrelated")).toBeUndefined();
    expect(await branchTip(source, "operator-topic")).toBe(base);
  });

  it("never deletes the branch that a symbolic ref named like a run branch points at", async () => {
    const { source, base } = await fixture();
    await git(source, ["symbolic-ref", "refs/heads/docsfab-run/alias", "refs/heads/main"]);
    const evidence = await evidenceFor(source, "docsfab-run/alias", base);

    // Without `--no-deref`, Git would delete `main` here. Either outcome keeps it.
    await cleanupRunDeliveryBranch(evidence).catch(() => undefined);

    expect(await branchTip(source, "main")).toBe(base);
    expect(await git(source, ["symbolic-ref", "HEAD"])).toBe("refs/heads/main");
  });
});

describe("compare-and-delete Git operation", () => {
  const revision = "a".repeat(40);
  const wideRevision = "b".repeat(64);
  const allowed = (...args: string[]): boolean => {
    try {
      assertSafeGitOperation(args);
      return true;
    } catch (error) {
      expect(error).toMatchObject({ code: "source-repository-mismatch" });
      return false;
    }
  };

  it("allows one exact run branch ref at one exact revision without following symbolic refs", () => {
    // The names DocsFab mints for runs, so the allowlist and the minting cannot drift apart. A run
    // ID may hold uppercase letters, dots, underscores, and hyphens; the name keeps all but the case.
    const minted = ["run-1", "Run_1.Final-2"].map((runId) =>
      deterministicLocalUserSourceBranch(runId, "c".repeat(40), "d".repeat(64), "e".repeat(64)),
    );
    expect(minted.every((branch) => branch.startsWith("docsfab-run/"))).toBe(true);
    for (const oid of [revision, wideRevision]) {
      for (const branch of ["docsfab-run/run-1", ...minted]) {
        expect(
          allowed("update-ref", "--no-deref", "-d", "--", `refs/heads/${branch}`, oid),
          branch,
        ).toBe(true);
      }
    }
  });

  it("refuses every other shape of the same command", () => {
    const branch = "refs/heads/docsfab-run/run-1";
    const refused: string[][] = [
      // Following a symbolic ref deletes the branch it names.
      ["update-ref", "-d", "--", branch, revision],
      ["update-ref", "-d", branch, revision],
      ["update-ref", "--no-deref", "-d", branch, revision],
      // Unconditional deletion, or a revision that is not a full object id.
      ["update-ref", "--no-deref", "-d", "--", branch],
      ["update-ref", "--no-deref", "-d", "--", branch, "HEAD"],
      ["update-ref", "--no-deref", "-d", "--", branch, "A".repeat(40)],
      ["update-ref", "--no-deref", "-d", "--", branch, "a".repeat(39)],
      // Only DocsFab run branches, never another local branch or a look-alike prefix.
      ["update-ref", "--no-deref", "-d", "--", "refs/heads/main", revision],
      ["update-ref", "--no-deref", "-d", "--", "refs/heads/feature/operator", revision],
      ["update-ref", "--no-deref", "-d", "--", "refs/heads/docsfab-runner/run-1", revision],
      ["update-ref", "--no-deref", "-d", "--", "refs/heads/docsfab-run", revision],
      ["update-ref", "--no-deref", "-d", "--", "refs/heads/docsfab-run/", revision],
      ["update-ref", "--no-deref", "-d", "--", "refs/tags/docsfab-run/run-1", revision],
      ["update-ref", "--no-deref", "-d", "--", "refs/remotes/origin/main", revision],
      ["update-ref", "--no-deref", "-d", "--", "refs/heads/../../HEAD", revision],
      ["update-ref", "--no-deref", "-d", "--", "HEAD", revision],
      ["update-ref", "--no-deref", "-d", "--", "docsfab-run/run-1", revision],
      ["update-ref", "--no-deref", "-d", "--", "refs/heads/docsfab run", revision],
      // Anything beyond the one deletion.
      ["update-ref", "--no-deref", "-d", "--", branch, revision, "extra"],
      ["update-ref", "--no-deref", "-m", "reason", "-d", "--", branch, revision],
      ["update-ref", "--no-deref", "--stdin"],
      ["update-ref", "--no-deref", "--", branch, revision],
    ];
    for (const args of refused) expect(allowed(...args), args.join(" ")).toBe(false);
  });

  it("refuses a name that Git rejects as a ref when every character is one that DocsFab mints", () => {
    // The character class alone allows each of these; only the Git ref-name rules refuse them.
    for (const name of ["x.lock", "x.", "x/", "a..b", "../main"]) {
      expect(
        allowed("update-ref", "--no-deref", "-d", "--", `refs/heads/docsfab-run/${name}`, revision),
        name,
      ).toBe(false);
    }
  });

  it("refuses a ref name with a character that DocsFab never mints", () => {
    // Git accepts most of these in a ref name; the allowlist does not rely on that. Minted names
    // hold only lowercase letters, digits, dots, hyphens, underscores, and slashes.
    const characters = [
      // control characters
      "\n",
      "\t",
      "\r",
      "\u0000",
      "\u0001",
      "\u001f",
      "\u007f",
      "\u0085",
      // invisible and look-alike Unicode
      "\u00a0",
      "\u200b",
      "\u202e",
      "\u2028",
      "\ufeff",
      "\u00fc",
      // other ASCII that Git allows
      "+",
      "=",
      ",",
      "@",
      "#",
      "Z",
    ];
    for (const character of characters) {
      const branch = `refs/heads/docsfab-run/run${character}1`;
      expect(
        allowed("update-ref", "--no-deref", "-d", "--", branch, revision),
        JSON.stringify(branch),
      ).toBe(false);
    }
  });
});
