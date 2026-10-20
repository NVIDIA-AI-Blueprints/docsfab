// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Hermetic Git for runtime test fixtures.
 *
 * Host Git configuration (global `commit.gpgsign`, `init.defaultBranch`, hooks,
 * excludes, a leaked `GIT_DIR`) must not change what a test builds. {@link git}
 * ignores system and global config and points `HOME`/`XDG_CONFIG_HOME` at an
 * absent directory. {@link initFixtureRepo} also writes a repo-local identity
 * and disables signing, so production code running its own Git with the
 * ambient environment can still commit.
 */
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Never created: Git treats missing per-user config, ignore, and attributes files as absent. */
const ABSENT_HOME = join(tmpdir(), "docsfab-test-git-home-absent");

export const FIXTURE_GIT_IDENTITY = Object.freeze({
  name: "DocsFab Test",
  email: "docsfab@example.test",
});

/** Minimal Git environment, isolated from system/global config and the caller's Git variables. */
export function hermeticGitEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: ABSENT_HOME,
    XDG_CONFIG_HOME: ABSENT_HOME,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
    ...extra,
  };
}

export interface GitOptions {
  readonly env?: NodeJS.ProcessEnv;
  /** Return stdout verbatim instead of trimmed. */
  readonly trim?: false;
  readonly maxBuffer?: number;
}

/** Run `git <args>` in `cwd` hermetically; resolves trimmed stdout, rejects on non-zero exit. */
export async function git(
  cwd: string,
  args: readonly string[],
  options: GitOptions = {},
): Promise<string> {
  const { stdout } = await execFileAsync("git", [...args], {
    cwd,
    encoding: "utf8",
    env: hermeticGitEnv(options.env),
    ...(options.maxBuffer === undefined ? {} : { maxBuffer: options.maxBuffer }),
  });
  return options.trim === false ? stdout : stdout.trim();
}

export type FixtureFiles = Readonly<Record<string, string | Uint8Array>>;

export interface FixtureRepoOptions {
  /** Initial branch name; omitted uses Git's built-in default (host config is ignored). */
  readonly branch?: string;
  readonly identity?: Readonly<{ name: string; email: string }>;
  readonly message?: string;
  /** Git object format; omitted uses Git's default, SHA-1. */
  readonly objectFormat?: "sha1" | "sha256";
}

/**
 * `git init` `root` (created if missing) with a repo-local identity and
 * `commit.gpgsign=false`. With `files`, writes each relative path, commits
 * everything, and resolves the new HEAD revision.
 */
export async function initFixtureRepo(
  root: string,
  files?: undefined,
  options?: FixtureRepoOptions,
): Promise<undefined>;
export async function initFixtureRepo(
  root: string,
  files: FixtureFiles,
  options?: FixtureRepoOptions,
): Promise<string>;
export async function initFixtureRepo(
  root: string,
  files?: FixtureFiles,
  options: FixtureRepoOptions = {},
): Promise<string | undefined> {
  const identity = options.identity ?? FIXTURE_GIT_IDENTITY;
  await mkdir(root, { recursive: true });
  await git(root, [
    "init",
    "-q",
    ...(options.branch ? ["-b", options.branch] : []),
    ...(options.objectFormat ? [`--object-format=${options.objectFormat}`] : []),
  ]);
  await git(root, ["config", "user.name", identity.name]);
  await git(root, ["config", "user.email", identity.email]);
  await git(root, ["config", "commit.gpgsign", "false"]);
  if (files === undefined) return undefined;
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), contents);
  }
  return await commitFixture(root, options.message);
}

/** Stage everything in `root`, commit it (empty commits allowed), and resolve the new HEAD revision. */
export async function commitFixture(root: string, message = "fixture"): Promise<string> {
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-q", "--allow-empty", "-m", message]);
  return await git(root, ["rev-parse", "HEAD"]);
}

/** Whether the Git that tests run is at least `major.minor`, as `git --version` reports it. */
export async function gitVersionAtLeast(major: number, minor: number): Promise<boolean> {
  const reported = await git(process.cwd(), ["--version"]);
  const match = /^git version (\d+)\.(\d+)/u.exec(reported);
  if (!match) throw new Error(`Unrecognized git --version output: ${reported}`);
  const [reportedMajor, reportedMinor] = [Number(match[1]), Number(match[2])];
  return reportedMajor > major || (reportedMajor === major && reportedMinor >= minor);
}
