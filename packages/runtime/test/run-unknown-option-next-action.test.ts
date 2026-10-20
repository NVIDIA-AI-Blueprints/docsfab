// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { SourcesCliOptionError } from "../src/cli/commands/sources.js";
import { CliRunOptionError, parseRunArguments } from "../src/cli/run-arguments.js";
import {
  DEFAULT_NEXT_ACTIONS,
  formatOperatorErrorEnvelope,
  toOperatorErrorEnvelope,
} from "../src/operator/error-envelope.js";
import { initFixtureRepo } from "./helpers/git.js";
import { temporaryRoots } from "./helpers/temp.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";

const execFileAsync = promisify(execFile);
const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const roots = temporaryRoots();

/** Pinned as a literal so the operator-facing text is checked apart from the source constant. */
const RUN_HELP_NEXT_ACTION =
  "Run `docsfab run --help` to list the options docsfab run accepts, then correct or remove the unrecognized option and run the command again.";

interface CliResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

interface Fixture {
  readonly repository: string;
  readonly configurationRoot: string;
  readonly stateDirectory: string;
  run(args: readonly string[]): Promise<CliResult>;
}

/**
 * The source CLI entry point with an empty configuration root and a
 * state directory that does not exist yet, so any run store the command
 * creates is visible afterwards.
 */
async function fixture(): Promise<Fixture> {
  const root = await roots.create("docsfab-run-unknown-option-");
  const repository = join(root, "repository");
  const configurationRoot = join(root, "configuration");
  const stateDirectory = join(root, "state");
  await mkdir(configurationRoot, { mode: 0o700 });
  await initFixtureRepo(repository, { "README.md": "# Fixture\n" });
  return {
    repository,
    configurationRoot,
    stateDirectory,
    async run(args) {
      try {
        const result = await execFileAsync(
          process.execPath,
          ["--import", "tsx", "src/cli.ts", ...args],
          {
            cwd: runtimeRoot,
            env: {
              PATH: process.env.PATH ?? "",
              HOME: root,
              TMPDIR: tmpdir(),
              PI_OFFLINE: "1",
              DOCSFAB_CONFIG_ROOT: configurationRoot,
              DOCSFAB_STATE_DIR: stateDirectory,
            },
          },
        );
        return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
      } catch (error) {
        const failure = error as { stdout?: string; stderr?: string; code?: number };
        return {
          stdout: failure.stdout ?? "",
          stderr: failure.stderr ?? "",
          exitCode: typeof failure.code === "number" ? failure.code : -1,
        };
      }
    },
  };
}

describe("docsfab run unknown-option refusal names a next action", () => {
  it("prints the run help command as the Next action in human output", {
    timeout: testTimeoutMs(60_000),
  }, async () => {
    const cli = await fixture();
    for (const args of [
      ["run", "review-documentation", "--repo", cli.repository, "--bogus-flag"],
      ["run", "create-documentation", "--repo", cli.repository, "--instruction", "x", "--foo"],
    ]) {
      const result = await cli.run(args);
      expect(result.exitCode, args.join(" ")).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("code: unknown-option");
      expect(result.stderr.split("\n")).toContain(`Next action: ${RUN_HELP_NEXT_ACTION}`);
    }
    // The refusal comes from argument parsing: no run store, so no workflow.
    expect(existsSync(cli.stateDirectory)).toBe(false);
  });

  it("carries the same nextAction in the --json error envelope", {
    timeout: testTimeoutMs(60_000),
  }, async () => {
    const cli = await fixture();
    const result = await cli.run([
      "run",
      "review-documentation",
      "--repo",
      cli.repository,
      "--bogus-flag",
      "--json",
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    const envelope = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(envelope).toMatchObject({
      kind: "docsfab-operator-error",
      code: "unknown-option",
      nextAction: RUN_HELP_NEXT_ACTION,
      failure: { class: "operator-input", code: "unknown-option" },
    });
    expect(existsSync(cli.stateDirectory)).toBe(false);
  });

  it("leaves a run with only accepted options on its later stop", {
    timeout: testTimeoutMs(60_000),
  }, async () => {
    const cli = await fixture();
    const result = await cli.run(["run", "review-documentation", "--repo", cli.repository]);
    // The empty configuration root stops this run, but not as an unknown option.
    expect(result.exitCode).toBe(1);
    expect(result.stderr.split("\n")).toContain("code: migration-required");
    expect(result.stderr.split("\n")).not.toContain("code: unknown-option");
    expect(result.stderr).toContain(`Configuration root: ${cli.configurationRoot}`);
    expect(result.stderr).not.toContain("docsfab run --help");
  });

  it("keeps the help action to docsfab run's own refusal", () => {
    let raised: unknown;
    try {
      parseRunArguments(["review-documentation", "--repo", runtimeRoot, "--verbos"]);
    } catch (error) {
      raised = error;
    }
    expect(raised).toBeInstanceOf(CliRunOptionError);
    const envelope = toOperatorErrorEnvelope(raised);
    expect(envelope.nextAction).toBe(RUN_HELP_NEXT_ACTION);
    expect(formatOperatorErrorEnvelope(envelope).split("\n")).toContain(
      `Next action: ${RUN_HELP_NEXT_ACTION}`,
    );

    // Another command's unknown-option refusal does not borrow docsfab run's help.
    const sources = toOperatorErrorEnvelope(new SourcesCliOptionError("unknown-option"));
    expect(sources.code).toBe("unknown-option");
    expect(sources.nextAction ?? "").not.toContain("docsfab run --help");

    // A genuinely unexpected error keeps the generic envelope.
    const unexpected = toOperatorErrorEnvelope(new Error("Something unexpected happened."));
    expect(unexpected.code).toBe("operator-error");
    expect(unexpected.nextAction).toBe(DEFAULT_NEXT_ACTIONS["operator-error"]);
  });
});
