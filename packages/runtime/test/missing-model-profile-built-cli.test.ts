// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { copyFile, cp, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { LIMIT_DEFINITION_BY_NAME } from "../src/config/limits.generated.js";
import { initFixtureRepo } from "./helpers/git.js";
import { hookTimeoutMs, testTimeoutMs } from "./helpers/test-timeouts.js";

const execFileAsync = promisify(execFile);
const runtimeRoot = fileURLToPath(new URL("..", import.meta.url));
const localJourneyMs = LIMIT_DEFINITION_BY_NAME["test.journeyLocalTimeoutMs"]!.value;
const missingProfile = "DocsFab found no loadable model profile.";
let fixtureRoot: string;
let packageRoot: string;
let repository: string;
let configurationRoot: string;

beforeAll(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "docsfab-missing-profile-built-"));
  packageRoot = join(fixtureRoot, "package");
  await mkdir(join(packageRoot, "bin"), { recursive: true });
  // A fresh isolated package proves the shipped catch path without replacing
  // the dist/ used by another test or a running source-checkout command.
  await execFileAsync(
    process.execPath,
    [join(runtimeRoot, "scripts/build-package.mjs"), "--output-dir", join(packageRoot, "dist")],
    {
      cwd: runtimeRoot,
      env: { ...process.env, PI_OFFLINE: "1" },
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  for (const file of ["docsfab.mjs", "source-checkout-refresh.mjs"]) {
    await copyFile(join(runtimeRoot, "bin", file), join(packageRoot, "bin", file));
  }
  await copyFile(join(runtimeRoot, "package.json"), join(packageRoot, "package.json"));
  for (const directory of ["workflows", "model-compositions", "governed-assets"]) {
    await cp(join(runtimeRoot, directory), join(packageRoot, directory), { recursive: true });
  }
  await symlink(join(runtimeRoot, "node_modules"), join(packageRoot, "node_modules"), "dir");
  await symlink(join(packageRoot, "bin/docsfab.mjs"), join(fixtureRoot, "docsfab.mjs"));
  repository = join(fixtureRoot, "repository");
  configurationRoot = join(fixtureRoot, "safe configuration root");
  await mkdir(configurationRoot, { mode: 0o700 });
  await initFixtureRepo(repository, { "README.md": "# Missing-profile fixture\n" });
}, hookTimeoutMs(localJourneyMs));

afterAll(async () => {
  if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
});

async function runEntrypoint(
  entrypoint: "bin" | "compiled launcher" | "symlinked bin",
  args: readonly string[] = [],
  environment: NodeJS.ProcessEnv = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const path =
    entrypoint === "bin"
      ? join(packageRoot, "bin/docsfab.mjs")
      : entrypoint === "compiled launcher"
        ? join(packageRoot, "dist/launcher.js")
        : join(fixtureRoot, "docsfab.mjs");
  try {
    const result = await execFileAsync(
      process.execPath,
      [path, "run", "review-documentation", "--repo", repository, ...args],
      {
        cwd: fixtureRoot,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: fixtureRoot,
          TMPDIR: tmpdir(),
          PI_OFFLINE: "1",
          DOCSFAB_CONFIG_ROOT: configurationRoot,
          DOCSFAB_SERVICE_ENV_FILE: join(fixtureRoot, "absent-service.env"),
          DOCSFAB_STATE_DIR: join(fixtureRoot, "state"),
          ...environment,
        },
      },
    );
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: unknown };
    if (typeof failure.code !== "number") throw error;
    return {
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
      exitCode: failure.code,
    };
  }
}

describe("missing-profile reporting through the actual isolated built package", {
  timeout: testTimeoutMs(localJourneyMs),
}, () => {
  it.each(["bin", "compiled launcher", "symlinked bin"] as const)(
    "%s names the safe effective files for a genuine human run failure",
    async (entrypoint) => {
      const result = await runEntrypoint(entrypoint);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(missingProfile);
      expect(result.stderr).toContain("code: migration-required");
      expect(result.stderr).toContain("Next action: docsfab setup");
      expect(result.stderr.split("\n")).toEqual(
        expect.arrayContaining([
          `Configuration root: ${configurationRoot}`,
          `Host configuration: ${join(configurationRoot, "host.yaml")}`,
          `Credential file: ${join(configurationRoot, "secrets.env")}`,
        ]),
      );
      expect(result.stderr).not.toContain(join(configurationRoot, ".env"));
    },
  );

  it.each(["bin", "compiled launcher", "symlinked bin"] as const)(
    "%s emits one root-private typed JSON envelope",
    async (entrypoint) => {
      const result = await runEntrypoint(entrypoint, ["--json"]);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(JSON.parse(result.stderr)).toMatchObject({
        schemaVersion: 1,
        kind: "docsfab-operator-error",
        code: "migration-required",
        nextAction: "docsfab setup",
      });
      expect(result.stderr).toContain(missingProfile);
      expect(result.stderr).not.toContain(configurationRoot);
      expect(result.stderr).not.toContain("Configuration root:");
      expect(result.stderr).not.toContain("Host configuration:");
      expect(result.stderr).not.toContain("Credential file:");
    },
  );

  it.each(["bin", "compiled launcher"] as const)(
    "%s preserves the unknown-option stop and help action",
    async (entrypoint) => {
      const result = await runEntrypoint(entrypoint, ["--bogus-flag"]);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("code: unknown-option");
      expect(result.stderr).toContain("docsfab run --help");
      expect(result.stderr).not.toContain(missingProfile);
      expect(result.stderr).not.toContain("Configuration root:");
    },
  );

  it.each(["bin", "compiled launcher"] as const)(
    "%s leaves a partial invalid profile on its migration path",
    async (entrypoint) => {
      const result = await runEntrypoint(entrypoint, [], { MODEL_PROVIDER: "fixture-provider" });
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("Model profile migration required.");
      expect(result.stderr).toContain("code: migration-required");
      expect(result.stderr).not.toContain(missingProfile);
      expect(result.stderr).not.toContain("Configuration root:");
      expect(result.stderr).not.toContain(configurationRoot);
    },
  );
});
