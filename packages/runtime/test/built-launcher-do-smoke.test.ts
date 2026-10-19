// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { beforeAll, describe, expect, it } from "vitest";

import { GOLDEN_OUTCOME_REQUEST } from "../src/cli/outcome-router.js";

const execFileAsync = promisify(execFile);
const projectRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const builtLauncher = join(projectRoot, "dist", "launcher.js");

/**
 * Built-launcher smoke: after `npm run build`, `dist/launcher.js` must
 * recognize `do` and golden `--route-only` must select review-documentation.
 * Catches a stale dist that still returns Unknown command "do".
 */
describe("built launcher do smoke (#284)", () => {
  beforeAll(async () => {
    await execFileAsync("npm", ["run", "build"], {
      cwd: projectRoot,
      env: { ...process.env, CI: "1", PI_OFFLINE: "1" },
      maxBuffer: 8 * 1024 * 1024,
    });
    await access(builtLauncher);
  }, 120_000);

  it("golden --route-only selects review-documentation on dist/launcher.js", async () => {
    const { stdout, stderr, exitCode } = await runBuiltLauncher([
      "do",
      GOLDEN_OUTCOME_REQUEST,
      "--repo",
      projectRoot,
      "--route-only",
      "--json",
    ]);

    const combined = `${stdout}\n${stderr}`;
    expect(combined).not.toMatch(/Unknown command ["']do["']/u);
    expect(exitCode).toBe(0);

    const envelope = JSON.parse(stdout) as {
      kind: string;
      decision: { status: string; workflow?: string };
    };
    expect(envelope).toMatchObject({
      kind: "docsfab-outcome-route",
      decision: {
        status: "selected",
        workflow: "review-documentation",
      },
    });
  }, 60_000);

  it("prints named --delegate opt-in help from dist/launcher.js", async () => {
    const { stdout, stderr, exitCode } = await runBuiltLauncher(["do", "--help"]);
    const combined = `${stdout}\n${stderr}`;
    expect(exitCode).toBe(0);
    expect(combined).toContain("--delegate");
    expect(combined).toMatch(/named opt-in/u);
    expect(combined).toContain("--resume <task-id>");
    expect(combined).toContain("--answers <json-file>");
  }, 60_000);

  it("rejects --delegate combined with --route-only before catalog routing", async () => {
    const { stdout, stderr, exitCode } = await runBuiltLauncher([
      "do",
      "--delegate",
      GOLDEN_OUTCOME_REQUEST,
      "--repo",
      projectRoot,
      "--route-only",
    ]);
    const combined = `${stdout}\n${stderr}`;
    expect(exitCode).toBeGreaterThan(0);
    expect(combined).toMatch(/cannot be combined with --route-only/u);
    expect(combined).not.toMatch(/kind":"docsfab-outcome-route/u);
    expect(combined).not.toContain("You:");
  }, 60_000);

  it("fails closed on delegated do without credentials and does not fall back to catalog routing", async () => {
    const configRoot = await mkdtemp(join(tmpdir(), "docsfab-delegated-do-config-"));
    try {
      const { stdout, stderr, exitCode } = await runBuiltLauncher(
        [
          "do",
          "--delegate",
          "Which flag enables JSON output?",
          "--repo",
          projectRoot,
          "--no-input",
          "--json",
        ],
        {
          DOCSFAB_CONFIG_ROOT: configRoot,
          XDG_CONFIG_HOME: configRoot,
          MODEL_API_KEY: "",
          OPENAI_API_KEY: "",
          DOCSFAB_MODEL_API_KEY: "",
        },
      );
      const combined = `${stdout}\n${stderr}`;
      expect(exitCode).not.toBe(0);
      expect(combined).not.toMatch(/Unknown command ["']do["']/u);
      expect(combined).not.toMatch(/Outcome route/u);
      expect(combined).not.toMatch(/kind":"docsfab-outcome-route/u);
      expect(combined).not.toContain("You:");
    } finally {
      await rm(configRoot, { recursive: true, force: true });
    }
  }, 60_000);
});

async function runBuiltLauncher(
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CI: "1",
    PI_OFFLINE: "1",
    ...extraEnv,
  };
  for (const name of ["MODEL_API_KEY", "OPENAI_API_KEY", "DOCSFAB_MODEL_API_KEY"]) {
    if (extraEnv[name] === "") delete env[name];
  }
  try {
    const result = await execFileAsync(process.execPath, [builtLauncher, ...args], {
      cwd: projectRoot,
      env,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (error) {
    const failure = error as {
      stdout?: string;
      stderr?: string;
      code?: number;
    };
    return {
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
      exitCode: typeof failure.code === "number" ? failure.code : 1,
    };
  }
}
