// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  ensureLocalUserPublicationFreshness,
  fetchGitEnvironment,
  planLocalUserPublicationFreshness,
  type LocalUserGitLabTargetObservation,
} from "../src/delivery/index.js";
import { LocalUserPublicationPreflightError } from "../src/delivery/contracts.js";
import { FIXTURE_GIT_IDENTITY, commitFixture, git, initFixtureRepo } from "./helpers/git.js";
import { temporaryRoots } from "./helpers/temp.js";

/** Clone, fetch, and push between the fixture's local repositories use the file transport. */
const FILE_TRANSPORT_ENV = { GIT_ALLOW_PROTOCOL: "file" } as const;
const roots = temporaryRoots();

describe("planLocalUserPublicationFreshness", () => {
  const gitlab = "b".repeat(40);
  const head = "a".repeat(40);

  it("no-ops when HEAD already matches GitLab", () => {
    expect(
      planLocalUserPublicationFreshness({
        requestedRevision: "HEAD",
        headRevision: gitlab,
        headBranch: "main",
        targetBranch: "main",
        gitlabRevision: gitlab,
      }),
    ).toEqual({ action: "noop" });
  });

  it("fast-forwards a live target-branch checkout that is behind GitLab", () => {
    expect(
      planLocalUserPublicationFreshness({
        requestedRevision: "HEAD",
        headRevision: head,
        headBranch: "main",
        targetBranch: "main",
        gitlabRevision: gitlab,
      }),
    ).toEqual({ action: "fast-forward", revision: gitlab });
  });

  it("resolves a feature branch from the target without moving its HEAD", () => {
    expect(
      planLocalUserPublicationFreshness({
        requestedRevision: "HEAD",
        headRevision: head,
        headBranch: "feature",
        targetBranch: "main",
        gitlabRevision: gitlab,
        revisionPolicy: "target-branch-head",
      }),
    ).toEqual({ action: "ensure-object", revision: gitlab });
  });

  it("refuses a pinned SHA that is not GitLab HEAD", () => {
    expect(
      planLocalUserPublicationFreshness({
        requestedRevision: head,
        headRevision: head,
        headBranch: "main",
        targetBranch: "main",
        gitlabRevision: gitlab,
      }),
    ).toEqual({ action: "fail", code: "stale-revision" });
  });

  it("ensures a pinned SHA that matches GitLab without fast-forwarding", () => {
    expect(
      planLocalUserPublicationFreshness({
        requestedRevision: gitlab,
        headRevision: head,
        headBranch: "main",
        targetBranch: "main",
        gitlabRevision: gitlab,
      }),
    ).toEqual({ action: "ensure-object", revision: gitlab });
  });

  it("resolves a named ref that is not the live checkout", () => {
    expect(
      planLocalUserPublicationFreshness({
        requestedRevision: "origin/main",
        headRevision: head,
        headBranch: "feature",
        targetBranch: "main",
        gitlabRevision: gitlab,
      }),
    ).toEqual({
      action: "resolve-named-ref",
      ref: "origin/main",
      gitlabRevision: gitlab,
    });
  });
});

describe("fetchGitEnvironment", () => {
  it("forwards SSH_AUTH_SOCK and does not allow the file protocol", () => {
    const env = fetchGitEnvironment({
      PATH: "/usr/bin",
      SSH_AUTH_SOCK: "/tmp/ssh.sock",
      GIT_ALLOW_PROTOCOL: "file",
    });
    expect(env.SSH_AUTH_SOCK).toBe("/tmp/ssh.sock");
    expect(env.GIT_ALLOW_PROTOCOL).toBe("ssh:https");
  });
});

describe("ensureLocalUserPublicationFreshness observation environment (#2393)", () => {
  it.each([
    ["names one", { HOME: "/operator-home", PATH: "/usr/bin" }],
    ["names none", undefined],
  ] as const)(
    "hands the observation the publisher's Git environment when the caller %s",
    async (_label, environment) => {
      // The observation reads the Git configuration the publisher will read, so it takes
      // the environment the publisher's Git will run with, not the process's.
      const sha = "a".repeat(40);
      const observe = vi.fn(async () => stubObservation("/repository", sha, sha, "main"));
      await ensureLocalUserPublicationFreshness(
        { repositoryPath: "/repository", revision: "HEAD" },
        { observe, ...(environment ? { environment } : {}) },
      );
      expect(observe).toHaveBeenCalledTimes(1);
      expect(observe.mock.calls[0]?.[2]).toBe(environment);
    },
  );
});

describe("ensureLocalUserPublicationFreshness real git", () => {
  it("fast-forwards a behind clone onto GitLab HEAD", async () => {
    const pair = await behindClonePair();
    await ensureLocalUserPublicationFreshness(
      { repositoryPath: pair.behind, revision: "HEAD" },
      {
        observe: async () => stubObservation(pair.behind, pair.behindSha, pair.aheadSha, "main"),
        fetchCommit: fetchWithFileProtocol,
      },
    );
    expect(await revParse(pair.behind)).toBe(pair.aheadSha);
  });

  it("leaves a dirty behind clone in place and still fetches GitLab HEAD", async () => {
    const pair = await behindClonePair();
    await writeFile(join(pair.behind, "README.md"), "local dirt\n");
    const messages: string[] = [];
    await ensureLocalUserPublicationFreshness(
      {
        repositoryPath: pair.behind,
        revision: "HEAD",
        status: (message) => messages.push(message),
      },
      {
        observe: async () => stubObservation(pair.behind, pair.behindSha, pair.aheadSha, "main"),
        fetchCommit: fetchWithFileProtocol,
      },
    );
    expect(await revParse(pair.behind)).toBe(pair.behindSha);
    await git(pair.behind, ["cat-file", "-e", `${pair.aheadSha}^{commit}`]);
    expect(messages.some((message) => message.includes("leaving tracked local changes"))).toBe(
      true,
    );
  });

  it("refuses a diverged checkout without moving HEAD", async () => {
    const pair = await behindClonePair();
    await writeFile(join(pair.behind, "README.md"), "diverged\n");
    await git(pair.behind, ["add", "README.md"]);
    await git(pair.behind, ["commit", "-q", "-m", "diverged"]);
    const before = await revParse(pair.behind);
    await expect(
      ensureLocalUserPublicationFreshness(
        { repositoryPath: pair.behind, revision: "HEAD" },
        {
          observe: async () => stubObservation(pair.behind, before, pair.aheadSha, "main"),
          fetchCommit: fetchWithFileProtocol,
        },
      ),
    ).rejects.toMatchObject({ code: "stale-revision" });
    expect(await revParse(pair.behind)).toBe(before);
  });

  it("resolves and fetches GitLab HEAD for a feature branch without moving HEAD", async () => {
    const pair = await behindClonePair();
    await git(pair.behind, ["checkout", "-q", "-b", "feature"]);
    const snapshot = await ensureLocalUserPublicationFreshness(
      {
        repositoryPath: pair.behind,
        revision: "HEAD",
        revisionPolicy: "target-branch-head",
      },
      {
        observe: async () =>
          stubObservation(pair.behind, pair.behindSha, pair.aheadSha, "main", "feature"),
        fetchCommit: fetchWithFileProtocol,
      },
    );
    expect(snapshot).toEqual({ branch: "main", revision: pair.aheadSha });
    expect(await revParse(pair.behind)).toBe(pair.behindSha);
    await git(pair.behind, ["cat-file", "-e", `${pair.aheadSha}^{commit}`]);
  });

  it("refuses a pinned stale SHA without fetching", async () => {
    const pair = await behindClonePair();
    let fetched = false;
    await expect(
      ensureLocalUserPublicationFreshness(
        { repositoryPath: pair.behind, revision: pair.behindSha },
        {
          observe: async () => stubObservation(pair.behind, pair.behindSha, pair.aheadSha, "main"),
          fetchCommit: async () => {
            fetched = true;
          },
        },
      ),
    ).rejects.toMatchObject({ code: "stale-revision" });
    expect(fetched).toBe(false);
    expect(await revParse(pair.behind)).toBe(pair.behindSha);
  });

  it("fetches a pinned GitLab SHA without fast-forwarding HEAD", async () => {
    const pair = await behindClonePair();
    let fastForwarded = false;
    await ensureLocalUserPublicationFreshness(
      { repositoryPath: pair.behind, revision: pair.aheadSha },
      {
        observe: async () => stubObservation(pair.behind, pair.behindSha, pair.aheadSha, "main"),
        fetchCommit: fetchWithFileProtocol,
        fastForward: async () => {
          fastForwarded = true;
        },
      },
    );
    expect(fastForwarded).toBe(false);
    expect(await revParse(pair.behind)).toBe(pair.behindSha);
    await git(pair.behind, ["cat-file", "-e", `${pair.aheadSha}^{commit}`]);
  });

  it("fails closed when resolving the target object cannot fetch", async () => {
    const pair = await behindClonePair();
    await git(pair.behind, ["checkout", "-q", "-b", "feature"]);
    await expect(
      ensureLocalUserPublicationFreshness(
        {
          repositoryPath: pair.behind,
          revision: "HEAD",
          revisionPolicy: "target-branch-head",
        },
        {
          observe: async () =>
            stubObservation(pair.behind, pair.behindSha, pair.aheadSha, "main", "feature"),
          hasCommit: async () => false,
          fetchCommit: async () => {
            throw new Error("network unavailable");
          },
        },
      ),
    ).rejects.toMatchObject({ code: "stale-revision" });
    expect(await revParse(pair.behind)).toBe(pair.behindSha);
  });
});

function stubObservation(
  repositoryPath: string,
  headRevision: string,
  gitlabRevision: string,
  targetBranch: string,
  headBranch = targetBranch,
): LocalUserGitLabTargetObservation {
  return {
    repositoryPath,
    headRevision,
    headBranch,
    remoteName: "origin",
    remote: {
      host: "gitlab.example.test",
      projectPath: "group/docs",
      transport: "https",
    },
    project: {
      id: 1,
      pathWithNamespace: "group/docs",
      defaultBranch: targetBranch,
      accessLevel: 30,
    },
    target: { name: targetBranch, protected: true, revision: gitlabRevision },
  };
}

async function fetchWithFileProtocol(input: {
  repositoryPath: string;
  remoteName: string;
  revision: string;
}): Promise<void> {
  await git(input.repositoryPath, ["fetch", "--no-tags", "--", input.remoteName, input.revision], {
    env: FILE_TRANSPORT_ENV,
  });
}

async function behindClonePair(): Promise<{
  behind: string;
  aheadSha: string;
  behindSha: string;
}> {
  const root = await roots.create("docsfab-freshness-");
  const ahead = join(root, "ahead");
  await initFixtureRepo(ahead, { "README.md": "one\n" }, { branch: "main", message: "one" });
  const origin = join(root, "origin.git");
  // Linux CI git still defaults bare HEAD to `master`. Point it at `main`
  // before clone so the behind checkout is not an unborn branch.
  await git(root, ["init", "--bare", "-q", "-b", "main", origin]);
  await git(origin, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  await git(ahead, ["remote", "add", "origin", origin]);
  await git(ahead, ["push", "-q", "-u", "origin", "main"], { env: FILE_TRANSPORT_ENV });
  const behind = join(root, "behind");
  await git(root, ["clone", "-q", "-b", "main", "--", origin, behind], {
    env: FILE_TRANSPORT_ENV,
  });
  await configureGit(behind);
  const behindSha = await revParse(behind);
  await writeFile(join(ahead, "README.md"), "two\n");
  await commitFixture(ahead, "two");
  await git(ahead, ["push", "-q", "origin", "main"], { env: FILE_TRANSPORT_ENV });
  return { behind, aheadSha: await revParse(ahead), behindSha };
}

/** The clone commits its own diverged change, so it needs the fixture identity too. */
async function configureGit(cwd: string): Promise<void> {
  await git(cwd, ["config", "user.email", FIXTURE_GIT_IDENTITY.email]);
  await git(cwd, ["config", "user.name", FIXTURE_GIT_IDENTITY.name]);
  await git(cwd, ["config", "commit.gpgsign", "false"]);
}

async function revParse(cwd: string): Promise<string> {
  return await git(cwd, ["rev-parse", "HEAD"]);
}
