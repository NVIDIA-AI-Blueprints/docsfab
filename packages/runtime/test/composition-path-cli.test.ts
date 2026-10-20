// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { RUN_OPTION_REFUSALS } from "../src/cli/run-arguments.js";
import { commitFixture, initFixtureRepo } from "./helpers/git.js";

const execFileAsync = promisify(execFile);
const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const COMPOSITION = "anthropic-claude-opus-4.7-pi";
const CREDENTIAL_UNAVAILABLE = "The selected executable composition credential is unavailable.";
const NO_MODEL_PROFILE = "DocsFab found no loadable model profile.";
const temporary: string[] = [];
let repository = "";
let configurationRoot = "";

/**
 * Run the source CLI entry point. Every credential the composition or a
 * model profile could read is blank and the host configuration root is an
 * empty directory, so no run can reach a provider: each path stops at its own
 * first refusal, which is what these tests compare.
 */
async function runDocsFab(
  args: string[],
  environmentOverrides: Record<string, string | undefined> = {},
): Promise<{ stderr: string; exitCode: number }> {
  try {
    const result = await execFileAsync(
      process.execPath,
      [
        "--import",
        "tsx",
        "src/cli.ts",
        "run",
        "review-documentation",
        "--repo",
        repository,
        ...args,
      ],
      {
        cwd: runtimeRoot,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: configurationRoot,
          TMPDIR: tmpdir(),
          PI_OFFLINE: "1",
          CI: "1",
          DOCSFAB_CONFIG_ROOT: configurationRoot,
          MODEL_API_KEY: "",
          ANTHROPIC_API_KEY: "",
          OPENAI_API_KEY: "",
          DOCSFAB_NVIDIA_API_KEY: "",
          ...environmentOverrides,
        },
        maxBuffer: 1024 * 1024,
      },
    );
    return { stderr: result.stderr, exitCode: 0 };
  } catch (error) {
    const failure = error as { stderr?: string; code?: number };
    return {
      stderr: failure.stderr ?? "",
      exitCode: typeof failure.code === "number" ? failure.code : 1,
    };
  }
}

describe("docsfab run path selection at the source CLI entry point", () => {
  beforeAll(async () => {
    configurationRoot = await mkdtemp(resolve(tmpdir(), "docsfab config path "));
    repository = await mkdtemp(resolve(tmpdir(), "docsfab-composition-path-repo-"));
    temporary.push(configurationRoot, repository);
    await writeFile(resolve(repository, "README.md"), "# Fixture\n");
    await initFixtureRepo(repository);
    await commitFixture(repository, "fixture");
  });

  afterAll(async () => {
    await Promise.all(
      temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  it("binds the installed composition from --composition alone", async () => {
    // Reaching credential selection means argv admitted the selection, the
    // workspace opened, and the installed composition resolved as active.
    const result = await runDocsFab(["--composition", COMPOSITION]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(CREDENTIAL_UNAVAILABLE);
    expect(result.stderr).not.toContain(NO_MODEL_PROFILE);
  }, 60_000);

  it("keeps the model-profile path when --composition is omitted", async () => {
    const result = await runDocsFab([]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(NO_MODEL_PROFILE);
    expect(result.stderr).not.toContain(CREDENTIAL_UNAVAILABLE);
    expect(result.stderr).not.toMatch(/composition/iu);
    expect(result.stderr).toContain(configurationRoot);
    expect(result.stderr).toContain(resolve(configurationRoot, "host.yaml"));
    expect(result.stderr).toContain(resolve(configurationRoot, "secrets.env"));
    expect(result.stderr).not.toContain("$DOCSFAB_CONFIG_ROOT/.env");
    expect(result.stderr).not.toContain(resolve(configurationRoot, ".env"));
    expect(result.stderr).toContain("docsfab setup");
  }, 60_000);

  it("names the default configuration root when DOCSFAB_CONFIG_ROOT is unset", async () => {
    const xdg = resolve(configurationRoot, "isolated xdg");
    const defaultRoot = resolve(xdg, "docsfab");
    await mkdir(defaultRoot, { recursive: true, mode: 0o700 });
    const result = await runDocsFab([], {
      DOCSFAB_CONFIG_ROOT: undefined,
      XDG_CONFIG_HOME: xdg,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(NO_MODEL_PROFILE);
    expect(result.stderr).toContain(defaultRoot);
    expect(result.stderr).toContain(resolve(defaultRoot, "host.yaml"));
    expect(result.stderr).toContain(resolve(defaultRoot, "secrets.env"));
    expect(result.stderr).not.toContain("$DOCSFAB_CONFIG_ROOT");
    expect(result.stderr).toContain("docsfab setup");
  }, 60_000);

  it("keeps configuration paths out of the shared JSON failure envelope", async () => {
    const result = await runDocsFab(["--json"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(NO_MODEL_PROFILE);
    expect(result.stderr).toContain("host.yaml and secrets.env");
    expect(result.stderr).not.toContain(configurationRoot);
    expect(result.stderr).not.toContain("$DOCSFAB_CONFIG_ROOT/.env");
    expect(JSON.parse(result.stderr)).toMatchObject({
      kind: "docsfab-operator-error",
      code: "migration-required",
    });
  }, 60_000);

  it("takes --release-gate on the composition path to credential selection", async () => {
    const result = await runDocsFab(["--composition", COMPOSITION, "--release-gate"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).not.toContain("composition-release-gate-unsupported");
    expect(result.stderr).toContain(CREDENTIAL_UNAVAILABLE);
  }, 60_000);

  it("takes --comment-mr on the composition path past the former capability refusal", async () => {
    const result = await runDocsFab(["--composition", COMPOSITION, "--comment-mr", "42"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).not.toContain("composition-existing-mr-unsupported");
    // The runtime-only entry point has no review-summary port, on either path.
    expect(result.stderr).toContain(
      "docsfab run --comment-mr requires an injected host review-summary port.",
    );
  }, 60_000);

  it("refuses the deleted --mode flag with the normal unknown-option stop", async () => {
    const result = await runDocsFab(["--mode", "production", "--composition", COMPOSITION]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(RUN_OPTION_REFUSALS["unknown-option"]);
  }, 60_000);
});
