// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { access, mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { nestedDeadlineMs, testTimeoutMs } from "./helpers/test-timeouts.js";
import { temporaryRoots } from "./helpers/temp.js";

const runtimeRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cliEntry = join(runtimeRoot, "src", "cli.ts");
const tsxLoader = fileURLToPath(import.meta.resolve("tsx"));
// Local budgets in ms. In CI each case gets at least test.ciTimeoutMs from
// config/limits.yaml, and each CLI child keeps its local share of that budget
// so it still fails first.
const localCliProcessMs = 10_000;
const localScopedHelpCaseMs = 15_000;
const localHelpRecoveryCaseMs = 25_000;
const roots = temporaryRoots();

describe("public CLI help", () => {
  it("returns scoped init help without repository, configuration, command, or network side effects", {
    timeout: testTimeoutMs(localScopedHelpCaseMs),
  }, async () => {
    const fixture = await createHelpFixture();
    const result = await runCli(["init", "--help"], fixture);

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toContain("Initialize DocsFab for one selected input repository");
    expect(result.stdout).toContain("This help command performs");
    expect(result.stdout).toContain("docsfab doctor --repo /absolute/path/to/input-repository");
    expect(result.stdout).not.toContain("composition pilot-campaign");
    await expectNoHelpSideEffects(fixture);
  });

  it("returns general help from the process without repository, configuration, command, or network side effects", {
    timeout: testTimeoutMs(localScopedHelpCaseMs),
  }, async () => {
    const fixture = await createHelpFixture();
    const result = await runCli(["help"], fixture);

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toContain("'docsfab' 'list'");
    await expectNoHelpSideEffects(fixture);
  });

  it("returns run help from the process without repository, configuration, command, or network side effects", {
    timeout: testTimeoutMs(localScopedHelpCaseMs),
  }, async () => {
    const fixture = await createHelpFixture();
    const result = await runCli(["run", "--help"], fixture);

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toContain("release-documentation-readiness");
    expect(result.stdout).toContain("bootstrap");
    await expectNoHelpSideEffects(fixture);
  });

  it("lists workflows from the process without repository, configuration, command, or network side effects", {
    timeout: testTimeoutMs(localScopedHelpCaseMs),
  }, async () => {
    const fixture = await createHelpFixture();
    const result = await runCli(["list"], fixture);

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toContain("Available workflows");
    expect(result.stdout).toContain("review-documentation");
    await expectNoHelpSideEffects(fixture);
  });

  it("prints a workflow plan from the process without repository, configuration, command, or network side effects", {
    timeout: testTimeoutMs(localScopedHelpCaseMs),
  }, async () => {
    const fixture = await createHelpFixture();
    const result = await runCli(["plan", "review-documentation"], fixture);

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toContain("Outcome:");
    expect(result.stdout).not.toContain("skill:");
    await expectNoHelpSideEffects(fixture);
  });

  it("keeps an unknown init option diagnostic paired with working scoped help", {
    timeout: testTimeoutMs(localHelpRecoveryCaseMs),
  }, async () => {
    const root = await roots.create("docsfab-cli-help-error-");
    const target = join(root, "empty-target");
    const networkGuard = join(root, "network-guard.mjs");
    await mkdir(target);
    await writeFile(
      networkGuard,
      "globalThis.fetch = async () => { throw new Error('network'); };\n",
    );
    const environment = credentialFreeEnvironment({
      HOME: root,
      DOCSFAB_CONFIG_ROOT: join(root, "config"),
    });

    const cliDeadlineMs = nestedDeadlineMs(localCliProcessMs, localHelpRecoveryCaseMs);
    const failure = await runCliWithTimeout(
      ["init", "--unknown"],
      target,
      networkGuard,
      environment,
      cliDeadlineMs,
    );
    const recovery = await runCliWithTimeout(
      ["init", "--help"],
      target,
      networkGuard,
      environment,
      cliDeadlineMs,
    );

    expect(failure.code).toBe(1);
    expect(failure.stderr).toContain("Unknown init option.");
    expect(failure.stderr).toContain("Run `docsfab init --help`");
    expect(recovery.code).toBe(0);
    expect(recovery.stdout).toContain("--approve-plan-sha256 <digest>");
    expect(await readdir(target)).toEqual([]);
  });

  it("exits 0 with command-group help from the process without configuration or network", {
    timeout: testTimeoutMs(localHelpRecoveryCaseMs),
  }, async () => {
    const root = await roots.create("docsfab-cli-group-help-");
    const target = join(root, "empty-target");
    const configuration = join(root, "config");
    const networkMarker = join(root, "network-called");
    const networkGuard = join(root, "network-guard.mjs");
    await mkdir(target);
    await writeFile(
      networkGuard,
      `import { appendFileSync } from "node:fs";\n` +
        `globalThis.fetch = async () => {\n` +
        `  appendFileSync(process.env.DOCSFAB_TEST_NETWORK_MARKER, "fetch\\n");\n` +
        `  throw new Error("network disabled by CLI help test");\n` +
        `};\n`,
    );
    const environment = credentialFreeEnvironment({
      HOME: root,
      DOCSFAB_CONFIG_ROOT: configuration,
      DOCSFAB_TEST_NETWORK_MARKER: networkMarker,
    });
    const cliDeadlineMs = nestedDeadlineMs(localCliProcessMs, localHelpRecoveryCaseMs);

    const runs = await runCliWithTimeout(
      ["runs", "--help"],
      target,
      networkGuard,
      environment,
      cliDeadlineMs,
    );
    const composition = await runCliWithTimeout(
      ["help", "composition"],
      target,
      networkGuard,
      environment,
      cliDeadlineMs,
    );

    expect(runs).toMatchObject({ code: 0, stderr: "" });
    expect(runs.stdout).toContain("docsfab runs query --where rowKind=run --group-by runStatus");
    expect(runs.stdout).toContain("docsfab runs import <harness-batch-directory>");
    expect(composition).toMatchObject({ code: 0, stderr: "" });
    expect(composition.stdout).toContain("docsfab composition preflight --composition");
    expect(await readdir(target)).toEqual([]);
    await expectPathMissing(configuration);
    await expectPathMissing(networkMarker);
  });
});

type HelpFixture = {
  target: string;
  configuration: string;
  processMarker: string;
  networkMarker: string;
  networkGuard: string;
  environment: NodeJS.ProcessEnv;
};

async function createHelpFixture(): Promise<HelpFixture> {
  const root = await roots.create("docsfab-cli-help-");
  const target = join(root, "empty-target");
  const commands = join(root, "commands");
  const configuration = join(root, "config");
  const processMarker = join(root, "process-called");
  const networkMarker = join(root, "network-called");
  const networkGuard = join(root, "network-guard.mjs");
  await Promise.all([
    mkdir(target),
    mkdir(commands),
    mkdir(join(root, "home")),
    writeFile(
      networkGuard,
      `import { appendFileSync } from "node:fs";\n` +
        `globalThis.fetch = async () => {\n` +
        `  appendFileSync(process.env.DOCSFAB_TEST_NETWORK_MARKER, "fetch\\n");\n` +
        `  throw new Error("network disabled by CLI help test");\n` +
        `};\n`,
    ),
  ]);
  const commandGuard =
    `#!/bin/sh\n` + `printf '%s\\n' "$0 $*" >> "$DOCSFAB_TEST_PROCESS_MARKER"\n` + `exit 97\n`;
  await Promise.all(
    ["git", "glab"].map((name) => writeFile(join(commands, name), commandGuard, { mode: 0o700 })),
  );
  const environment = credentialFreeEnvironment({
    DOCSFAB_CONFIG_ROOT: configuration,
    DOCSFAB_TEST_NETWORK_MARKER: networkMarker,
    DOCSFAB_TEST_PROCESS_MARKER: processMarker,
    HOME: join(root, "home"),
    PATH: `${commands}:${process.env.PATH ?? ""}`,
  });
  return { target, configuration, processMarker, networkMarker, networkGuard, environment };
}

async function expectNoHelpSideEffects(fixture: HelpFixture): Promise<void> {
  expect(await readdir(fixture.target)).toEqual([]);
  await expectPathMissing(fixture.configuration);
  await expectPathMissing(fixture.processMarker);
  await expectPathMissing(fixture.networkMarker);
}

function runCli(
  args: readonly string[],
  fixture: HelpFixture,
): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  return runCliWithTimeout(
    args,
    fixture.target,
    fixture.networkGuard,
    fixture.environment,
    nestedDeadlineMs(localCliProcessMs, localScopedHelpCaseMs),
  );
}

function runCliWithTimeout(
  args: readonly string[],
  cwd: string,
  networkGuard: string,
  environment: NodeJS.ProcessEnv,
  deadlineMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", tsxLoader, "--import", networkGuard, cliEntry, ...args],
      { cwd, env: environment, stdio: ["ignore", "pipe", "pipe"] },
    );
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`CLI process exceeded ${deadlineMs} ms`));
    }, deadlineMs);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
  });
}

function credentialFreeEnvironment(additions: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) => !/(?:API_KEY|CREDENTIAL|PASSWORD|SECRET|TOKEN)/iu.test(name),
      ),
    ),
    ...additions,
  };
}

async function expectPathMissing(path: string): Promise<void> {
  await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
}
