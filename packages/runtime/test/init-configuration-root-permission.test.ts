// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { chmod, mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { runDocsFabInit } from "../src/init.js";
import { formatInitFailure } from "../src/init/render.js";
import {
  captureConfigurationRoot,
  ConfigurationRootNotCanonicalError,
} from "../src/init/storage.js";
import { temporaryRoots } from "./helpers/temp.js";

const roots = temporaryRoots();

async function layout(mode = 0o700) {
  const parent = await roots.create("docsfab init config root with spaces ", { realpath: true });
  const repository = join(parent, "repository");
  const home = join(parent, "home");
  const configRoot = join(parent, "configuration root");
  await Promise.all([
    mkdir(repository, { mode: 0o700 }),
    mkdir(home, { mode: 0o700 }),
    mkdir(configRoot, { mode }),
  ]);
  await chmod(configRoot, mode);
  return { parent, repository, home, configRoot };
}

function runInit(repository: string, home: string, configRoot: string, calls: string[] = []) {
  return runDocsFabInit(["--non-interactive", "--repo", repository], {
    cwd: repository,
    environment: { HOME: home, DOCSFAB_CONFIG_ROOT: configRoot },
    homeDirectory: home,
    commands: {
      run: async (command) => {
        calls.push(command);
        return { exitCode: 1, stdout: "" };
      },
    },
    log: () => undefined,
  });
}

describe("init configuration-root permission admission", () => {
  it.each([0o755, 0o775, 0o777])(
    "refuses an existing root with mode %s before init reads or writes configuration",
    async (mode) => {
      const fixture = await layout(mode);
      const calls: string[] = [];
      let error: unknown;
      try {
        await runInit(fixture.repository, fixture.home, fixture.configRoot, calls);
      } catch (caught) {
        error = caught;
      }

      expect(error).toMatchObject({
        code: "configuration-root-not-private",
      });
      expect((error as Error).message).toContain(`mode ${mode.toString(8).padStart(4, "0")}`);
      expect(formatInitFailure(error)).toContain("code: configuration-root-not-private");
      expect(formatInitFailure(error)).toContain('chmod 700 "$DOCSFAB_CONFIG_ROOT"');
      expect(formatInitFailure(error)).not.toContain("configuration-root-not-canonical");
      expect(calls).toEqual([]);
    },
  );

  it("passes owner-private admission and continues to repository inspection", async () => {
    const fixture = await layout();
    const calls: string[] = [];
    const error = await runDocsFabInit(["--non-interactive", "--repo", fixture.repository], {
      cwd: fixture.repository,
      environment: { HOME: fixture.home, DOCSFAB_CONFIG_ROOT: fixture.configRoot },
      homeDirectory: fixture.home,
      commands: {
        run: async (command) => {
          calls.push(command);
          return { exitCode: 1, stdout: "" };
        },
      },
      log: () => undefined,
    }).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(calls.length).toBeGreaterThan(0);
    expect(error).not.toMatchObject({ code: "configuration-root-not-private" });
  });

  it("keeps a canonical-path refusal distinct from a permission refusal", async () => {
    const fixture = await layout();
    const linkedRoot = join(fixture.parent, "configuration root link");
    await symlink(fixture.configRoot, linkedRoot);

    let error: unknown;
    try {
      await runInit(fixture.repository, fixture.home, linkedRoot);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ConfigurationRootNotCanonicalError);
    expect(error).toMatchObject({ code: "configuration-root-not-canonical" });
  });

  it("refuses a non-private root at init's trusted-directory admission boundary", async () => {
    const fixture = await layout(0o775);

    await expect(
      captureConfigurationRoot(fixture.configRoot, fixture.home, {
        HOME: fixture.home,
        DOCSFAB_CONFIG_ROOT: fixture.configRoot,
      }),
    ).rejects.toMatchObject({
      code: "configuration-root-not-private",
      message: expect.stringContaining("mode 0775"),
    });
  });
});
