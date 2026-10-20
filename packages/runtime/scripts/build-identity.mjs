// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile, spawn } from "node:child_process";
import { realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const RELEASE_TAG = /^v(\d+\.\d+\.\d+)(?:-rc\.(0|[1-9]\d*))?$/u;

export const UNSTAMPED_BUILD_IDENTITY = Object.freeze({
  schemaVersion: 1,
  commit: null,
  dirty: null,
  releaseTag: null,
});

/**
 * The commit a build of `repositoryRoot` compiles, and whether the checkout
 * differed from it. A root that is not itself a Git work tree top level, such
 * as an unpacked package inside another repository, is unstamped rather than
 * attributed to the enclosing repository's commit.
 *
 * @param {string} repositoryRoot
 * @param {{ git?: typeof defaultGit; version?: string; env?: NodeJS.ProcessEnv }} [options]
 */
export async function readBuildIdentity(repositoryRoot, options = {}) {
  const git = options.git ?? defaultGit;
  let top;
  try {
    top = (await git.output(repositoryRoot, ["rev-parse", "--show-toplevel"])).trim();
  } catch {
    return UNSTAMPED_BUILD_IDENTITY;
  }
  if ((await realpath(top)) !== (await realpath(repositoryRoot))) return UNSTAMPED_BUILD_IDENTITY;
  const commit = (await git.output(repositoryRoot, ["rev-parse", "--verify", "HEAD"])).trim();
  if (!COMMIT.test(commit)) {
    throw new Error("The DocsFab build could not read the checkout's HEAD commit.");
  }
  const dirty = await git.hasOutput(repositoryRoot, [
    "status",
    "--porcelain",
    "--untracked-files=normal",
  ]);
  let releaseTag = null;
  const baseVersion = /^(\d+\.\d+\.\d+)(?:[-+]|$)/u.exec(options.version ?? "")?.[1];
  if (!dirty && baseVersion) {
    const supplied = (options.env ?? process.env).CI_COMMIT_TAG;
    const candidates = supplied
      ? [supplied]
      : (await git.output(repositoryRoot, ["tag", "--points-at", "HEAD"]))
          .trim()
          .split("\n")
          .filter(Boolean);
    const valid = [];
    for (const tag of candidates) {
      const match = RELEASE_TAG.exec(tag);
      if (match?.[1] !== baseVersion) continue;
      let target;
      try {
        target = (
          await git.output(repositoryRoot, ["rev-parse", "--verify", `refs/tags/${tag}^{commit}`])
        ).trim();
      } catch {
        continue;
      }
      if (target === commit)
        valid.push({ tag, rc: match[2] === undefined ? null : BigInt(match[2]) });
    }
    valid.sort((left, right) => {
      if (left.rc === null) return -1;
      if (right.rc === null) return 1;
      if (left.rc !== right.rc) return left.rc > right.rc ? -1 : 1;
      return left.tag.localeCompare(right.tag);
    });
    releaseTag = valid[0]?.tag ?? null;
  }
  return Object.freeze({ schemaVersion: 1, commit, dirty, releaseTag });
}

/** @param {{ schemaVersion: 1; commit: string | null; dirty: boolean | null; releaseTag?: string | null }} identity */
export function renderBuildIdentityModule(identity) {
  const value = JSON.stringify(
    {
      schemaVersion: 1,
      commit: identity.commit,
      dirty: identity.dirty,
    },
    null,
    2,
  );
  return [
    "// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.",
    "// SPDX-License-Identifier: Apache-2.0",
    "",
    "/** Written by scripts/build-package.mjs from the checkout this build compiled. */",
    `export const DOCSFAB_BUILD_IDENTITY = Object.freeze(${value});`,
    "",
  ].join("\n");
}

/** @param {{ releaseTag?: string | null }} identity */
export function renderReleaseIdentityModule(identity) {
  return `// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Written by scripts/build-package.mjs from the checkout this build compiled. */\nexport const DOCSFAB_RELEASE_IDENTITY = Object.freeze(${JSON.stringify({ releaseTag: identity.releaseTag ?? null }, null, 2)});\n`;
}

/**
 * @param {string} outputDirectory
 * @param {{ schemaVersion: 1; commit: string | null; dirty: boolean | null; releaseTag?: string | null }} identity
 */
export async function writeBuildIdentityModule(outputDirectory, identity) {
  await writeFile(join(outputDirectory, "build-identity.js"), renderBuildIdentityModule(identity));
  await writeFile(
    join(outputDirectory, "release-identity.js"),
    renderReleaseIdentityModule(identity),
  );
}

export const defaultGit = Object.freeze({
  /** @param {string} cwd @param {readonly string[]} args */
  async output(cwd, args) {
    return (await execute("git", [...args], { cwd })).stdout;
  },
  /**
   * Whether the command prints anything. It stops at the first byte, so a
   * large status listing needs no output buffer.
   *
   * @param {string} cwd
   * @param {readonly string[]} args
   * @returns {Promise<boolean>}
   */
  hasOutput(cwd, args) {
    return new Promise((resolve, reject) => {
      const child = spawn("git", [...args], { cwd, stdio: ["ignore", "pipe", "ignore"] });
      let printed = false;
      child.stdout.once("data", () => {
        printed = true;
        child.kill();
        resolve(true);
      });
      child.once("error", reject);
      child.once("close", (code) => {
        if (printed) return;
        if (code === 0) resolve(false);
        else reject(new Error(`git ${args[0] ?? ""} failed (${String(code)}).`));
      });
    });
  },
});
