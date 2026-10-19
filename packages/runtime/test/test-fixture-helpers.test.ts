// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FIXTURE_GIT_IDENTITY,
  commitFixture,
  git,
  hermeticGitEnv,
  initFixtureRepo,
} from "./helpers/git.js";
import { temporaryRoots } from "./helpers/temp.js";

const roots = temporaryRoots();

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("temporaryRoots", () => {
  const created: string[] = [];

  it("creates a prefixed directory under the OS temp directory", async () => {
    const root = await roots.create("docsfab-helper-temp-");
    const external = await mkdtemp(join(tmpdir(), "docsfab-helper-external-"));
    created.push(root, roots.track(external));
    expect(dirname(root)).toBe(tmpdir());
    expect(basename(root)).toMatch(/^docsfab-helper-temp-.{6}$/);
    expect((await stat(root)).isDirectory()).toBe(true);
  });

  it("removes created and tracked paths after the previous test", () => {
    expect(created).toHaveLength(2);
    for (const path of created) expect(existsSync(path)).toBe(false);
  });

  it("applies an explicit mode and returns a canonical path on request", async () => {
    const opened = await roots.create("docsfab-helper-mode-", { mode: 0o750 });
    expect((await stat(opened)).mode & 0o777).toBe(0o750);
    const canonical = await roots.create("docsfab-helper-real-", { realpath: true });
    expect(canonical).toBe(await realpath(canonical));
    await roots.cleanup();
    expect(existsSync(opened)).toBe(false);
    expect(existsSync(canonical)).toBe(false);
    await expect(roots.cleanup()).resolves.toBeUndefined();
  });
});

describe("hermetic fixture git", () => {
  it("ignores host Git configuration and variables that would break or alter a fixture commit", async () => {
    const host = await roots.create("docsfab-helper-host-git-");
    const hostConfig = join(host, "gitconfig");
    await writeFile(
      hostConfig,
      [
        "[user]",
        "  name = Leaked Host",
        "  email = leaked@host.invalid",
        "[init]",
        "  defaultBranch = leaked-branch",
        "[commit]",
        "  gpgsign = true",
        "[gpg]",
        "  program = false",
        "",
      ].join("\n"),
    );
    vi.stubEnv("GIT_CONFIG_GLOBAL", hostConfig);
    vi.stubEnv("GIT_DIR", join(host, "not-a-repository"));
    vi.stubEnv("GIT_AUTHOR_EMAIL", "leaked-author@host.invalid");

    const repository = join(await roots.create("docsfab-helper-repo-"), "repo");
    const revision = await initFixtureRepo(repository, {
      "docs/guide.md": "# Guide\n",
      "README.md": "# Fixture\n",
    });

    expect(revision).toMatch(/^[0-9a-f]{40}$/);
    expect(await git(repository, ["rev-parse", "HEAD"])).toBe(revision);
    expect(await git(repository, ["symbolic-ref", "--short", "HEAD"])).not.toBe("leaked-branch");
    expect(await git(repository, ["log", "-1", "--format=%an <%ae>|%cn <%ce>|%s"])).toBe(
      `${FIXTURE_GIT_IDENTITY.name} <${FIXTURE_GIT_IDENTITY.email}>|` +
        `${FIXTURE_GIT_IDENTITY.name} <${FIXTURE_GIT_IDENTITY.email}>|fixture`,
    );
    expect(await git(repository, ["ls-files"])).toBe("README.md\ndocs/guide.md");
    expect(await readFile(join(repository, "docs/guide.md"), "utf8")).toBe("# Guide\n");
    expect(await git(repository, ["config", "--local", "commit.gpgsign"])).toBe("false");
  });

  it("initializes without committing and honors branch, identity, and verbatim output", async () => {
    const repository = await roots.create("docsfab-helper-init-");
    await expect(
      initFixtureRepo(repository, undefined, {
        branch: "main",
        identity: { name: "Other", email: "other@example.test" },
      }),
    ).resolves.toBeUndefined();
    await expect(git(repository, ["rev-parse", "--verify", "HEAD"])).rejects.toThrow();
    expect(await git(repository, ["symbolic-ref", "--short", "HEAD"])).toBe("main");

    await writeFile(join(repository, "a.txt"), "a\n");
    const revision = await commitFixture(repository, "first");
    expect(await git(repository, ["log", "-1", "--format=%ae %s"])).toBe(
      "other@example.test first",
    );
    expect(await git(repository, ["rev-parse", "HEAD"], { trim: false })).toBe(`${revision}\n`);

    const empty = await roots.create("docsfab-helper-empty-");
    const emptyRevision = await initFixtureRepo(empty, {});
    expect(await git(empty, ["rev-parse", "HEAD"])).toBe(emptyRevision);
    expect(await git(empty, ["ls-files"])).toBe("");
  });

  it("layers caller variables over the hermetic environment only", () => {
    vi.stubEnv("GIT_CONFIG_GLOBAL", "/host/gitconfig");
    const env = hermeticGitEnv({ GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z" });
    expect(env.GIT_CONFIG_GLOBAL).toBe(process.platform === "win32" ? "NUL" : "/dev/null");
    expect(env.GIT_CONFIG_NOSYSTEM).toBe("1");
    expect(env.GIT_AUTHOR_DATE).toBe("2026-01-01T00:00:00Z");
    expect(env.HOME).not.toBe(process.env.HOME);
    expect(Object.keys(env)).not.toContain("GIT_DIR");
  });
});
