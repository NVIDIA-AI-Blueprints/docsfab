// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Executes the literal shell form that `configuration-root-not-canonical`
 * prints as its next action, and proves it selects the same root as
 * `resolveDocsFabConfigurationRoot` under the same environment.
 */
import { spawnSync } from "node:child_process";
import { lstat, mkdir, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveDocsFabConfigurationRoot } from "../src/config/host-paths.js";
import {
  INIT_CONFIGURATION_ROOT_NEXT_ACTION,
  INIT_CONFIGURATION_ROOT_SHELL_FORM,
} from "../src/init/render.js";
import { temporaryRoots } from "./helpers/temp.js";

const temporaryDirectories = temporaryRoots();

afterEach(() => {
  vi.unstubAllEnvs();
});

interface Layout {
  root: string;
  work: string;
  homeReal: string;
  homeLink: string;
  xdgReal: string;
  xdgLink: string;
  configLink: string;
}

async function layout(): Promise<Layout> {
  const root = await temporaryDirectories.create("docsfab-root-shell-", {
    mode: 0o700,
    realpath: true,
  });
  const [work, homeReal, xdgReal, configReal, dotXdg] = [
    "work",
    "home-real",
    "xdg-real",
    "config-real",
    ".xdg",
  ].map((name) => join(root, name));
  for (const directory of [work, homeReal, xdgReal, configReal, dotXdg]) {
    await mkdir(directory, { mode: 0o700 });
  }
  const [homeLink, xdgLink, configLink] = ["home-link", "xdg-link", "config-link"].map((name) =>
    join(root, name),
  );
  await symlink(homeReal, homeLink);
  await symlink(xdgReal, xdgLink);
  await symlink(configReal, configLink);
  return { root, work, homeReal, homeLink, xdgReal, xdgLink, configLink };
}

/** `sh` is dash on Debian runners; bash is the common interactive shell there. */
const SHELLS = ["sh", "bash"] as const;

/**
 * Runs the shipped shell form under `shell` in a clean environment, then reads
 * the variable back from a child shell, so an unexported assignment fails.
 */
function runShellForm(environment: NodeJS.ProcessEnv, cwd: string, shell = "sh") {
  const script = [
    `${INIT_CONFIGURATION_ROOT_SHELL_FORM} || { printf 'failed:%s\\n' "\${DOCSFAB_CONFIG_ROOT-unset}"; exit 3; }`,
    `sh -c 'printf "root:%s\\n" "$DOCSFAB_CONFIG_ROOT"'`,
  ].join("\n");
  return spawnSync(shell, ["-c", script], { cwd, env: environment, encoding: "utf8" });
}

/** The root DocsFab selects for `environment`; its default reads the process HOME. */
function docsFabRoot(environment: NodeJS.ProcessEnv): string {
  vi.stubEnv("HOME", environment.HOME);
  expect(homedir()).toBe(environment.HOME);
  return resolveDocsFabConfigurationRoot(environment);
}

type Case = readonly [name: string, env: (paths: Layout) => Record<string, string>];

const CASES: readonly Case[] = [
  ["explicit root through a symlink", (p) => ({ DOCSFAB_CONFIG_ROOT: p.configLink })],
  [
    "missing explicit root under a symlinked parent",
    (p) => ({ DOCSFAB_CONFIG_ROOT: join(p.configLink, "fresh") }),
  ],
  ["XDG_CONFIG_HOME through a symlink", (p) => ({ XDG_CONFIG_HOME: p.xdgLink })],
  ["default root under a symlinked HOME", () => ({})],
  [
    "an XDG_CONFIG_HOME named with a leading dot",
    (p) => ({ XDG_CONFIG_HOME: join(p.root, ".xdg") }),
  ],
  // XDG values init ignores in favour of HOME/.config.
  ["an empty XDG_CONFIG_HOME", () => ({ XDG_CONFIG_HOME: "" })],
  ["a relative XDG_CONFIG_HOME", () => ({ XDG_CONFIG_HOME: "rel" })],
  ["an XDG_CONFIG_HOME with a trailing slash", (p) => ({ XDG_CONFIG_HOME: `${p.xdgLink}/` })],
  ["an XDG_CONFIG_HOME ending in a dot segment", (p) => ({ XDG_CONFIG_HOME: `${p.xdgLink}/.` })],
  [
    "an XDG_CONFIG_HOME with an inner dot segment",
    (p) => ({ XDG_CONFIG_HOME: `${p.root}/./xdg-real` }),
  ],
  [
    "an XDG_CONFIG_HOME with a dot-dot segment",
    (p) => ({ XDG_CONFIG_HOME: `${p.xdgReal}/../xdg-real` }),
  ],
  ["an XDG_CONFIG_HOME ending in dot-dot", (p) => ({ XDG_CONFIG_HOME: `${p.xdgReal}/..` })],
  ["an XDG_CONFIG_HOME with a doubled slash", (p) => ({ XDG_CONFIG_HOME: `${p.root}//xdg-real` })],
];

describe("configuration-root next action shell form (#1438)", () => {
  it("is the command the refusal prints", () => {
    expect(
      INIT_CONFIGURATION_ROOT_NEXT_ACTION.endsWith(`: ${INIT_CONFIGURATION_ROOT_SHELL_FORM}`),
    ).toBe(true);
  });

  const MATRIX = SHELLS.flatMap((shell) => CASES.map(([name, env]) => [shell, name, env] as const));

  it.each(MATRIX)(
    "%s exports the canonical root DocsFab selects: %s",
    async (shell, _name, extra) => {
      const paths = await layout();
      const environment: NodeJS.ProcessEnv = {
        PATH: process.env.PATH,
        HOME: paths.homeLink,
        ...extra(paths),
      };
      const result = runShellForm(environment, paths.work, shell);
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      const expected = await realpath(docsFabRoot(environment));
      expect(result.stdout).toBe(`root:${expected}\n`);
      // A relative XDG value must not create a directory under the caller's cwd.
      await expect(lstat(join(paths.work, "rel"))).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("creates a missing root owner-only", async () => {
    const paths = await layout();
    const result = runShellForm({ PATH: process.env.PATH, HOME: paths.homeLink }, paths.work);
    expect(result.status).toBe(0);
    const created = join(paths.homeReal, ".config", "docsfab");
    expect(result.stdout).toBe(`root:${created}\n`);
    expect((await stat(created)).mode & 0o777).toBe(0o700);
  });

  it("exports nothing when the root cannot be created", async () => {
    const paths = await layout();
    const blocker = join(paths.root, "not-a-directory");
    await writeFile(blocker, "");
    const result = runShellForm(
      { PATH: process.env.PATH, HOME: join(blocker, "home") },
      paths.work,
    );
    expect(result.status).toBe(3);
    expect(result.stdout).toBe("failed:unset\n");
  });
});
