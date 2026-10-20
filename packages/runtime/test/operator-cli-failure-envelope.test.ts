// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import { handleMultiUnitCampaignCommand } from "../src/cli/commands/multi-unit-campaign.js";
import { main } from "../src/cli/router.js";
import { reportOperatorFailure } from "../src/operator/error-envelope.js";
import { reportLocalCliFailure } from "../src/operator/local-cli-failure.js";
import {
  localMissingModelProfileLocator,
  ModelProfileMigrationError,
  parseModelEndpoint,
} from "../src/model/configuration.js";
import { validModelEnvironment } from "./helpers.js";
import { commitFixture, git, initFixtureRepo } from "./helpers/git.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";

const execFileAsync = promisify(execFile);
const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporary: string[] = [];
const originalArgv = process.argv;

function setCliArguments(args: readonly string[]): void {
  process.argv = [originalArgv[0]!, originalArgv[1]!, ...args];
}

async function runOperatorCli(
  relativePath: string,
  args: string[] = [],
  environment: NodeJS.ProcessEnv = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const result = await execFileAsync(
      process.execPath,
      ["--import", "tsx", relativePath, ...args],
      {
        cwd: runtimeRoot,
        env: { ...process.env, PI_OFFLINE: "1", CI: "1", ...environment },
        maxBuffer: 1024 * 1024,
      },
    );
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
      exitCode: typeof failure.code === "number" ? failure.code : 1,
    };
  }
}

describe("operator CLI failure envelopes", () => {
  afterEach(() => {
    process.argv = originalArgv;
    process.exitCode = undefined;
    vi.restoreAllMocks();
    return Promise.all(
      temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  it("keeps the packed-CLI git prerequisite sentence as the first envelope line", () => {
    const lines: string[] = [];
    reportOperatorFailure(
      new Error("This DocsFab command requires git. Install git, ensure it is on PATH, and retry."),
      { write: (line) => lines.push(line) },
    );
    expect(
      lines
        .join("\n")
        .startsWith(
          "This DocsFab command requires git. Install git, ensure it is on PATH, and retry.",
        ),
    ).toBe(true);
  });

  it("routes threat-model-review-cli failures through the envelope instead of a bare exit", async () => {
    const result = await runOperatorCli("src/security/threat-model-review-cli.ts");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Threat-model review evidence is missing, stale, or invalid.");
  }, 20_000);

  it("prints kind docsfab-operator-error on multi-unit-campaign --json failure", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((value?: unknown) => {
      lines.push(String(value));
    });

    await handleMultiUnitCampaignCommand(["--json"]);

    expect(process.exitCode).toBe(1);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      schemaVersion: 1,
      kind: "docsfab-operator-error",
      code: "invalid-option",
    });
  });

  it("prints kind docsfab-operator-error on setup --json failure with a TTY code line", async () => {
    const jsonLines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((value?: unknown) => {
      jsonLines.push(String(value));
    });
    setCliArguments(["setup", "--json", "--verbose"]);
    await main();
    expect(process.exitCode).toBe(1);
    const json = JSON.parse(jsonLines[0]!) as {
      kind: string;
      code: string;
      message: string;
      nextAction?: string;
    };
    expect(json).toMatchObject({
      schemaVersion: 1,
      kind: "docsfab-operator-error",
    });
    expect(json.code).toMatch(/^[a-z](?:[a-z0-9-]{0,62}[a-z0-9])?$/u);
    expect(json.message).not.toMatch(/nvapi-|sk-|api_key=/iu);
    expect(json.nextAction).toEqual(expect.any(String));

    jsonLines.length = 0;
    process.exitCode = undefined;
    setCliArguments(["setup", "--not-a-real-flag"]);
    await main();
    expect(process.exitCode).toBe(1);
    expect(jsonLines.join("\n")).toMatch(/^code: /mu);
    expect(jsonLines.join("\n")).not.toMatch(/nvapi-|sk-|api_key=/iu);
  });

  it("prints kind docsfab-operator-error on live-agent --json failure with a TTY code line", async () => {
    const jsonLines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((value?: unknown) => {
      jsonLines.push(String(value));
    });
    setCliArguments(["live-agent", "--json", "--new", "--new"]);
    await main();
    expect(process.exitCode).toBe(1);
    const json = JSON.parse(jsonLines[0]!) as {
      kind: string;
      code: string;
      message: string;
    };
    expect(json).toMatchObject({
      schemaVersion: 1,
      kind: "docsfab-operator-error",
    });
    expect(json.code).toMatch(/^[a-z](?:[a-z0-9-]{0,62}[a-z0-9])?$/u);
    expect(json.message).toMatch(/only once/u);
    expect(json.message).not.toMatch(/nvapi-|sk-|api_key=/iu);

    jsonLines.length = 0;
    process.exitCode = undefined;
    setCliArguments(["live-agent", "--new", "--new"]);
    await main();
    expect(process.exitCode).toBe(1);
    expect(jsonLines.join("\n")).toMatch(/^code: /mu);
    expect(jsonLines.join("\n")).not.toMatch(/nvapi-|sk-|api_key=/iu);
  });

  it("prints kind docsfab-operator-error when threat-model-review-cli --json fails", async () => {
    const jsonFailure = await runOperatorCli("src/security/threat-model-review-cli.ts", ["--json"]);
    expect(jsonFailure.exitCode).toBe(1);
    expect(JSON.parse(jsonFailure.stderr)).toMatchObject({
      schemaVersion: 1,
      kind: "docsfab-operator-error",
      code: "invalid-threat-model-review-evidence",
    });
  }, 20_000);

  it("reports a decisive destination through the source CLI's outside-write-scope envelope", async () => {
    const repository = await mkdtemp(resolve(tmpdir(), "docsfab-proposal-scope-cli-"));
    temporary.push(repository);
    await mkdir(resolve(repository, "docs"));
    await writeFile(resolve(repository, "README.md"), "# Fixture\n");
    await initFixtureRepo(repository);
    await commitFixture(repository, "fixture");

    const result = await runOperatorCli(
      "src/cli.ts",
      [
        "run",
        "update-documentation",
        "--repo",
        repository,
        "--instruction",
        "Update docs/a.md, docs/../unsafe.md, and docs/b.md.",
        "--allow-write",
        "--patch-only",
        "--json",
      ],
      validModelEnvironment,
    );

    expect(result.exitCode).toBe(1);
    const envelope = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(envelope).toMatchObject({
      kind: "docsfab-operator-error",
      code: "request-intent-outside-write-scope",
    });
    expect(result.stderr).toContain("docs/../unsafe.md");
    expect(result.stderr).toContain("documentationRoots");
    expect(await git(repository, ["status", "--porcelain"], { trim: false })).toBe("");
  }, 30_000);

  it.each([
    ["create-documentation", false],
    ["create-documentation", true],
    ["update-documentation", false],
    ["update-documentation", true],
  ] as const)(
    "keeps %s outside-write-scope disposition through the source CLI (json=%s)",
    async (workflow, json) => {
      const repository = await mkdtemp(resolve(tmpdir(), "docsfab-source-scope-"));
      temporary.push(repository);
      await initFixtureRepo(repository, {
        "README.md": "# Fixture\n",
        "docs/a.md": "# Alpha\n",
        "src/notes.md": "# Source\n",
        ".docsfab.json": JSON.stringify({
          schemaVersion: 1,
          gitlab: { remote: "origin", defaultBranch: "main" },
          provider: { configuration: "host" },
          storage: { scope: "user-private" },
          documentationRoots: ["docs"],
        }),
      });
      const args = [
        "run",
        workflow,
        "--repo",
        repository,
        "--allow-write",
        "--patch-only",
        "--instruction",
        `${workflow === "create-documentation" ? "Create" : "Update"} src/notes.md for developers.`,
      ];
      const output = await runOperatorCli(
        "src/cli.ts",
        [...args, ...(json ? ["--json"] : [])],
        validModelEnvironment,
      );
      expect(output.exitCode).toBe(1);
      if (json)
        expect(JSON.parse(output.stderr)).toMatchObject({
          kind: "docsfab-operator-error",
          code: "request-intent-outside-write-scope",
          failure: { class: "planning-refusal", layer: "cli" },
          nextAction: expect.stringContaining("documentationRoots"),
        });
      else expect(output.stderr).toContain("code: request-intent-outside-write-scope");
      expect(output.stderr).toContain("src/notes.md");
      expect(output.stderr).toContain("docs/");
      expect(output.stderr).toContain("documentationRoots");
      expect(await git(repository, ["status", "--porcelain"], { trim: false })).toBe("");
    },
    testTimeoutMs(30_000),
  );

  // At the shipped entry point, a question about pages is refused before
  // any workflow or model work, with a content-free envelope and next action.
  it("refuses a question-form instruction through the public JSON CLI boundary", async () => {
    const repository = await mkdtemp(resolve(tmpdir(), "docsfab-non-actionable-cli-"));
    temporary.push(repository);
    await mkdir(resolve(repository, "docs"));
    await writeFile(resolve(repository, "README.md"), "# Fixture\n");
    await initFixtureRepo(repository);
    await commitFixture(repository, "fixture");

    const result = await runOperatorCli(
      "src/cli.ts",
      [
        "run",
        "update-documentation",
        "--repo",
        repository,
        "--instruction",
        "Should I update docs/question-a.md or docs/question-b.md?",
        "--allow-write",
        "--patch-only",
        "--json",
      ],
      validModelEnvironment,
    );

    expect(result.exitCode).toBe(1);
    const envelope = JSON.parse(result.stderr) as Record<string, unknown>;
    expect(envelope).toMatchObject({
      kind: "docsfab-operator-error",
      code: "proposal-scope-non-actionable-targets",
      message:
        "The documentation request names its pages only in a question, a deferral, or a request not to change them.",
      nextAction:
        "Rephrase the instruction as a request to proceed with the change to the named pages, then start a new run.",
      details: {
        kind: "docsfab-proposal-scope-admission-failure",
        phase: "proposal-scope-admission",
        retryable: false,
        noWorkPerformed: true,
      },
    });
    expect(result.stderr).not.toContain("question-a");
    expect(result.stderr).not.toContain("Should I");
    expect(await git(repository, ["status", "--porcelain"], { trim: false })).toBe("");
  }, 30_000);
});

describe("explicit local CLI missing-profile reporter", () => {
  const root = "/synthetic/local-cli-safe-root";
  const runArgv = ["node", "docsfab", "run", "review-documentation"];

  function missingProfile(environment: NodeJS.ProcessEnv = {}): ModelProfileMigrationError {
    try {
      parseModelEndpoint({ DOCSFAB_CONFIG_ROOT: root, ...environment });
    } catch (error) {
      if (error instanceof ModelProfileMigrationError) return error;
      throw error;
    }
    throw new Error("The fixture must reach the genuine missing-profile diagnostic.");
  }

  it("appends only the genuine frozen locator after generic human reporting", () => {
    const failure = missingProfile();
    const locator = localMissingModelProfileLocator(failure);
    expect(Object.isFrozen(locator)).toBe(true);
    expect(locator?.join("\n")).toContain(root);
    const lines: string[] = [];
    const envelope = reportLocalCliFailure(failure, {
      argv: runArgv,
      write: (line) => lines.push(line),
    });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("code: migration-required");
    expect(lines[0]).not.toContain(root);
    expect(lines[1]).toBe(locator?.join("\n"));
    expect(JSON.stringify(envelope)).not.toContain(root);

    failure.message = "mutated diagnostic without locator authority";
    const changed: string[] = [];
    reportLocalCliFailure(failure, { argv: runArgv, write: (line) => changed.push(line) });
    expect(changed[1]).toBe(lines[1]);
  });

  it("keeps local JSON, non-run CLI and generic shared reporting root-private", () => {
    const failure = missingProfile();
    for (const argv of [
      [...runArgv, "--json"],
      ["node", "docsfab", "doctor"],
    ]) {
      const lines: string[] = [];
      reportLocalCliFailure(failure, { argv, write: (line) => lines.push(line) });
      expect(lines).toHaveLength(1);
      expect(lines.join("\n")).not.toContain(root);
      if (argv.includes("--json")) {
        expect(JSON.parse(lines[0]!)).toMatchObject({
          kind: "docsfab-operator-error",
          code: "migration-required",
        });
      }
    }
    const shared: string[] = [];
    reportOperatorFailure(failure, { write: (line) => shared.push(line) });
    expect(shared).toHaveLength(1);
    expect(shared[0]).not.toContain(root);
  });

  it("does not infer a locator from message, reason, properties or inherited identity", () => {
    const genuine = missingProfile();
    const forged = Object.assign(new Error(genuine.message), {
      name: genuine.name,
      reason: "no-profile",
      code: "migration-required",
      locator: [`Configuration root: ${root}`],
    });
    const sameClassLookalike = Object.assign(
      Object.create(Object.getPrototypeOf(genuine)) as ModelProfileMigrationError,
      { message: genuine.message, reason: "no-profile", code: "migration-required" },
    );
    expect(sameClassLookalike).toBeInstanceOf(ModelProfileMigrationError);
    for (const error of [forged, sameClassLookalike, Object.create(genuine) as unknown]) {
      expect(localMissingModelProfileLocator(error)).toBeUndefined();
      const lines: string[] = [];
      reportLocalCliFailure(error, { argv: runArgv, write: (line) => lines.push(line) });
      expect(lines).toHaveLength(1);
      expect(lines[0]).not.toContain(root);
    }
  });

  it("preserves both closed proxy and short-encoded B1 controls at the local caller", () => {
    const password = ["inert", "critic", "proxy", "password"].join("-");
    for (const [environment, form] of [
      [{ HTTPS_PROXY: `https://fixture:${password}@proxy.invalid:443` }, password],
      [{ SCM_TOKEN: "q z" }, encodeURIComponent("q z")],
    ] as const) {
      const failure = missingProfile({
        ...environment,
        DOCSFAB_CONFIG_ROOT: `/synthetic/local-cli/${form}`,
      });
      const lines: string[] = [];
      reportLocalCliFailure(failure, { argv: runArgv, write: (line) => lines.push(line) });
      expect(lines).toHaveLength(2);
      expect(lines[1]?.includes(form)).toBe(false);
      expect(lines[1]).toContain("[REDACTED]");
      expect(lines[1]).toContain("host.yaml");
      expect(lines[1]).toContain("secrets.env");
    }
  });
});
