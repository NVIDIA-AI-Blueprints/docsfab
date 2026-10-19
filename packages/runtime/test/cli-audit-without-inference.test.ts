// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { withLocalWorkflowRun } from "../src/cli/run/local-workflow.js";
import { parseChangeSourceSelector } from "../src/inputs/change-source.js";
import type { RunRecord } from "../src/records/contracts.js";
import { retainedTemplateAuditReport } from "../src/templates/audit.js";
import { git, initFixtureRepo } from "./helpers/git.js";
import { temporaryRoots } from "./helpers/temp.js";
import { nestedDeadlineMs, testTimeoutMs } from "./helpers/test-timeouts.js";

const runtimeRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cliEntry = join(runtimeRoot, "src", "cli.ts");
const tsxLoader = fileURLToPath(import.meta.resolve("tsx"));
const roots = temporaryRoots();
const localCaseMs = 60_000;
const localProcessMs = 30_000;

function credentialFreeEnvironment(additions: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) => !/(?:API_KEY|CREDENTIAL|PASSWORD|SECRET|TOKEN|^MODEL_|^JUDGE_)/iu.test(name),
      ),
    ),
    ...additions,
  };
}

async function runCli(
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  networkGuard: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", tsxLoader, "--import", networkGuard, cliEntry, ...args],
      { cwd: runtimeRoot, env: environment, stdio: ["ignore", "pipe", "pipe"] },
    );
    const timeout = setTimeout(
      () => {
        child.kill();
        reject(new Error("Audit CLI process exceeded its local deadline."));
      },
      nestedDeadlineMs(localProcessMs, localCaseMs),
    );
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

describe("audit-documentation without inference configuration", () => {
  it.each(["absent", "selected-profile-without-key", "missing-judge-key"] as const)(
    "runs the actual CLI with %s and no provider or catalog request",
    { timeout: testTimeoutMs(localCaseMs) },
    async (configuration) => {
      const root = await roots.create("docsfab-audit-no-key-", { mode: 0o700, realpath: true });
      const configRoot = join(root, "config");
      const repository = join(root, "repository");
      const networkMarker = join(root, "network-called");
      const networkGuard = join(root, "network-guard.mjs");
      await mkdir(configRoot, { mode: 0o700 });
      const revision = await initFixtureRepo(repository, {
        "docs/quickstart.md":
          "# Quickstart\n\n## Prerequisites\n\n## Quickstart Steps\n\n## What's Next\n",
      });
      await writeFile(
        networkGuard,
        `import { appendFileSync } from "node:fs";\n` +
          `globalThis.fetch = async () => {\n` +
          `  appendFileSync(process.env.DOCSFAB_TEST_NETWORK_MARKER, "fetch\\n");\n` +
          `  throw new Error("network disabled by audit test");\n` +
          `};\n`,
      );
      if (configuration === "selected-profile-without-key") {
        await writeFile(
          join(configRoot, "host.yaml"),
          "schemaVersion: 1\nkind: docsfab-host-config\nactiveExecutionProfile: nvidia-inference-gpt-6-sol-pi\n",
        );
      }
      const environment = credentialFreeEnvironment({
        HOME: root,
        DOCSFAB_CONFIG_ROOT: configRoot,
        DOCSFAB_TEST_NETWORK_MARKER: networkMarker,
        PI_OFFLINE: "0",
        ...(configuration === "missing-judge-key" ? { JUDGE_ENABLED: "true" } : {}),
      });

      const result = await runCli(
        ["run", "audit-documentation", "--repo", repository, "--revision", revision, "--json"],
        environment,
        networkGuard,
      );
      expect(result.code).toBe(0);
      const run = JSON.parse(result.stdout) as {
        execution: { workflow: string; status: string; recordPath: string };
      };
      expect(run.execution.workflow).toBe("audit-documentation");
      expect(run.execution.status).toBe("succeeded");
      const record = JSON.parse(await readFile(run.execution.recordPath, "utf8")) as RunRecord;
      expect(record.models).toEqual([]);
      expect(record.usage).toMatchObject({ input: 0, output: 0, turns: 0 });
      expect(retainedTemplateAuditReport(record)?.coverage.enumerated).toBeGreaterThan(0);
      expect(await git(repository, ["status", "--porcelain"])).toBe("");
      expect(await git(repository, ["rev-parse", "HEAD"])).toBe(revision);
      await expect(access(networkMarker)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("refuses --change for a no-key structural audit before reading a provider", {
    timeout: testTimeoutMs(localCaseMs),
  }, async () => {
    const root = await roots.create("docsfab-audit-no-key-change-", {
      mode: 0o700,
      realpath: true,
    });
    const configRoot = join(root, "config");
    const repository = join(root, "repository");
    const networkMarker = join(root, "network-called");
    const networkGuard = join(root, "network-guard.mjs");
    await mkdir(configRoot, { mode: 0o700 });
    const revision = await initFixtureRepo(repository, {
      "docs/quickstart.md": "# Quickstart\n\nFirst version.\n",
    });
    await writeFile(
      networkGuard,
      `import { appendFileSync } from "node:fs";\n` +
        `globalThis.fetch = async () => {\n` +
        `  appendFileSync(process.env.DOCSFAB_TEST_NETWORK_MARKER, "fetch\\n");\n` +
        `  throw new Error("network disabled by audit test");\n` +
        `};\n`,
    );
    const result = await runCli(
      [
        "run",
        "audit-documentation",
        "--repo",
        repository,
        "--revision",
        revision,
        "--change",
        "HEAD~1..HEAD",
        "--json",
      ],
      credentialFreeEnvironment({
        HOME: root,
        DOCSFAB_CONFIG_ROOT: configRoot,
        DOCSFAB_TEST_NETWORK_MARKER: networkMarker,
        PI_OFFLINE: "0",
      }),
      networkGuard,
    );
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({
      code: "change-source-workflow-unsupported",
    });
    expect(await git(repository, ["status", "--porcelain"])).toBe("");
    await expect(access(networkMarker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a direct audit change source before opening a workspace", async () => {
    await expect(
      withLocalWorkflowRun(
        {
          workflow: "audit-documentation",
          repositoryPath: "/nonexistent-audit-change-source-workspace",
          revision: "HEAD",
          changeSource: parseChangeSourceSelector("HEAD~1..HEAD"),
          allowWrite: false,
          releaseGate: false,
          verbose: false,
          json: false,
          showScan: false,
        },
        undefined,
        { silent: true, output: { log: () => undefined, error: () => undefined } },
        async () => {
          throw new Error("Audit unexpectedly reached execution.");
        },
      ),
    ).rejects.toMatchObject({ code: "change-source-workflow-unsupported" });
  });

  it("applies a private evidence-git output bound before a no-key audit executes", {
    timeout: testTimeoutMs(localCaseMs),
  }, async () => {
    const root = await roots.create("docsfab-audit-private-evidence-bound-", {
      mode: 0o700,
      realpath: true,
    });
    const configRoot = join(root, "config");
    const repository = join(root, "repository");
    const networkMarker = join(root, "network-called");
    const networkGuard = join(root, "network-guard.mjs");
    await mkdir(configRoot, { mode: 0o700 });
    await writeFile(
      join(configRoot, ".env"),
      "DOCSFAB_REPOSITORY_EVIDENCE_GIT_OUTPUT_MAX_BYTES=16\n",
    );
    const revision = await initFixtureRepo(repository, { "docs/quickstart.md": "# Quickstart\n" });
    await writeFile(
      networkGuard,
      `import { appendFileSync } from "node:fs";\n` +
        `globalThis.fetch = async () => {\n` +
        `  appendFileSync(process.env.DOCSFAB_TEST_NETWORK_MARKER, "fetch\\n");\n` +
        `  throw new Error("network disabled by audit test");\n` +
        `};\n`,
    );
    const environment = credentialFreeEnvironment({
      HOME: root,
      DOCSFAB_CONFIG_ROOT: configRoot,
      DOCSFAB_TEST_NETWORK_MARKER: networkMarker,
      PI_OFFLINE: "0",
    });
    delete environment.DOCSFAB_REPOSITORY_EVIDENCE_GIT_OUTPUT_MAX_BYTES;
    const result = await runCli(
      ["run", "audit-documentation", "--repo", repository, "--revision", revision, "--json"],
      environment,
      networkGuard,
    );
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({
      code: "repository-evidence-git-output-max-bytes-bound",
    });
    expect(await git(repository, ["status", "--porcelain"])).toBe("");
    await expect(access(networkMarker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("still requires model configuration for review and create", {
    timeout: testTimeoutMs(localCaseMs),
  }, async () => {
    const root = await roots.create("docsfab-audit-model-control-", {
      mode: 0o700,
      realpath: true,
    });
    const configRoot = join(root, "config");
    const repository = join(root, "repository");
    const networkGuard = join(root, "network-guard.mjs");
    await mkdir(configRoot, { mode: 0o700 });
    const revision = await initFixtureRepo(repository, { "docs/quickstart.md": "# Quickstart\n" });
    await writeFile(
      networkGuard,
      "globalThis.fetch = async () => { throw new Error('network disabled'); };\n",
    );
    const environment = credentialFreeEnvironment({
      HOME: root,
      DOCSFAB_CONFIG_ROOT: configRoot,
      PI_OFFLINE: "0",
    });
    for (const workflow of ["review-documentation", "create-documentation"]) {
      const result = await runCli(
        ["run", workflow, "--repo", repository, "--revision", revision, "--json"],
        environment,
        networkGuard,
      );
      expect(result.code).not.toBe(0);
      expect(result.stdout).not.toContain("template-audit");
    }
    expect(await git(repository, ["status", "--porcelain"])).toBe("");
  });

  it("validates an explicit installed composition without resolving its credential", {
    timeout: testTimeoutMs(localCaseMs),
  }, async () => {
    const root = await roots.create("docsfab-audit-composition-", {
      mode: 0o700,
      realpath: true,
    });
    const configRoot = join(root, "config");
    const repository = join(root, "repository");
    const networkMarker = join(root, "network-called");
    const networkGuard = join(root, "network-guard.mjs");
    await mkdir(configRoot, { mode: 0o700 });
    const revision = await initFixtureRepo(repository, { "docs/quickstart.md": "# Quickstart\n" });
    await writeFile(
      networkGuard,
      `import { appendFileSync } from "node:fs";\n` +
        `globalThis.fetch = async () => {\n` +
        `  appendFileSync(process.env.DOCSFAB_TEST_NETWORK_MARKER, "fetch\\n");\n` +
        `  throw new Error("network disabled by audit test");\n` +
        `};\n`,
    );
    const environment = credentialFreeEnvironment({
      HOME: root,
      DOCSFAB_CONFIG_ROOT: configRoot,
      DOCSFAB_TEST_NETWORK_MARKER: networkMarker,
      PI_OFFLINE: "0",
    });
    const valid = await runCli(
      [
        "run",
        "audit-documentation",
        "--repo",
        repository,
        "--revision",
        revision,
        "--composition",
        "nvidia-inference-gpt-6-sol-pi",
        "--json",
      ],
      environment,
      networkGuard,
    );
    expect(valid.code).toBe(0);
    expect((JSON.parse(valid.stdout) as { execution: { status: string } }).execution.status).toBe(
      "succeeded",
    );
    const invalid = await runCli(
      [
        "run",
        "audit-documentation",
        "--repo",
        repository,
        "--revision",
        revision,
        "--composition",
        "not-an-installed-composition",
        "--json",
      ],
      environment,
      networkGuard,
    );
    expect(invalid.code).not.toBe(0);
    expect(await git(repository, ["status", "--porcelain"])).toBe("");
    await expect(access(networkMarker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps governed asset corruption as a startup refusal", {
    timeout: testTimeoutMs(localCaseMs),
  }, async () => {
    const root = await roots.create("docsfab-audit-asset-", { mode: 0o700, realpath: true });
    const configRoot = join(root, "config");
    const repository = join(root, "repository");
    const networkMarker = join(root, "network-called");
    const networkGuard = join(root, "network-guard.mjs");
    await mkdir(configRoot, { mode: 0o700 });
    const revision = await initFixtureRepo(repository, { "docs/quickstart.md": "# Quickstart\n" });
    await writeFile(
      networkGuard,
      `import { appendFileSync } from "node:fs";\n` +
        `globalThis.fetch = async () => {\n` +
        `  appendFileSync(process.env.DOCSFAB_TEST_NETWORK_MARKER, "fetch\\n");\n` +
        `  throw new Error("network disabled by audit test");\n` +
        `};\n`,
    );
    const result = await runCli(
      ["run", "audit-documentation", "--repo", repository, "--revision", revision, "--json"],
      credentialFreeEnvironment({
        HOME: root,
        DOCSFAB_CONFIG_ROOT: configRoot,
        DOCSFAB_QUALITY_PACK_DIR: join(root, "missing-quality-pack"),
        DOCSFAB_TEST_NETWORK_MARKER: networkMarker,
        PI_OFFLINE: "0",
      }),
      networkGuard,
    );
    expect(result.code).not.toBe(0);
    expect(JSON.parse(result.stderr)).toMatchObject({ code: "lock-unavailable" });
    expect(result.stdout).not.toContain('"status":"succeeded"');
    expect(await git(repository, ["status", "--porcelain"])).toBe("");
    await expect(access(networkMarker)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
