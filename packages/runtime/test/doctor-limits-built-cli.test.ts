// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `docsfab doctor --limits` through the built CLI, `bin/docsfab.mjs` over
 * compiled `dist/`, never Vitest's module loader. The package is built into its
 * own directory so this file never replaces the shared `dist/` that other tests
 * and processes run from. Records are written by that build's own run-record
 * writer.
 */
import { execFile } from "node:child_process";
import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { temporaryRoots } from "./helpers/temp.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";

const execFileAsync = promisify(execFile);
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const recordWriter = pathToFileURL(
  join(projectRoot, "scripts", "lib", "leased-run-record.mjs"),
).href;
const BUILD_LOCAL_MS = 120_000;
const CLI_LOCAL_MS = 30_000;
const roots = temporaryRoots();

let buildRoot: string;
let packageRoot: string;

beforeAll(async () => {
  buildRoot = await mkdtemp(join(tmpdir(), "docsfab-built-cli-limits-"));
  packageRoot = join(buildRoot, "package");
  await mkdir(join(packageRoot, "bin"), { recursive: true });
  await execFileAsync(
    process.execPath,
    [join(projectRoot, "scripts", "build-package.mjs"), "--output-dir", join(packageRoot, "dist")],
    { cwd: projectRoot, env: { ...process.env, PI_OFFLINE: "1" }, maxBuffer: 16 * 1024 * 1024 },
  );
  for (const file of ["docsfab.mjs", "source-checkout-refresh.mjs"]) {
    await copyFile(join(projectRoot, "bin", file), join(packageRoot, "bin", file));
  }
  await copyFile(join(projectRoot, "package.json"), join(packageRoot, "package.json"));
  // The workflow catalog ships beside dist/ (package.json files), and the text
  // report reads its step list from there, as the runtime does.
  await cp(join(projectRoot, "workflows"), join(packageRoot, "workflows"), { recursive: true });
  // The built doctor loads the package's pinned installed-composition trust
  // root before projecting answer-record fit. Copy only the published assets;
  // package-internal source notes are intentionally excluded.
  const modelCompositionAssets = join(packageRoot, "model-compositions");
  await mkdir(modelCompositionAssets, { recursive: true });
  for (const file of [
    "adapter-registry.json",
    "candidate-projections.json",
    "composition-registry.json",
    "installed-manifest.json",
    "workflow-catalog.json",
  ]) {
    await copyFile(
      join(projectRoot, "model-compositions", file),
      join(modelCompositionAssets, file),
    );
  }
  await symlink(join(projectRoot, "node_modules"), join(packageRoot, "node_modules"), "dir");
}, testTimeoutMs(BUILD_LOCAL_MS));

afterAll(async () => {
  if (buildRoot) await rm(buildRoot, { recursive: true, force: true });
});

interface LimitRow {
  readonly name: string;
  readonly value: number;
  readonly unit: string;
  readonly source: string;
  readonly observedMaxSeen: number | null;
  readonly headroomPercent: number | null;
  readonly status: string;
}

async function privateRoot(prefix: string): Promise<string> {
  return roots.create(prefix, { mode: 0o700 });
}

/** Write a record with this build's own writer; returns what it recorded. */
async function writeRecord(
  stateDirectory: string,
  recordId: string,
  inputTokens?: number,
): Promise<{ recordPath: string; observed: Record<string, number> }> {
  const script = [
    "const [writer, input] = process.argv.slice(1);",
    "const { writeLeasedRunRecord } = await import(writer);",
    "process.stdout.write(JSON.stringify(await writeLeasedRunRecord(JSON.parse(input))));",
  ].join("\n");
  const input = { packageRoot, stateDirectory, recordId, ...(inputTokens ? { inputTokens } : {}) };
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--input-type=module", "-e", script, recordWriter, JSON.stringify(input)],
    { cwd: buildRoot },
  );
  return JSON.parse(stdout) as { recordPath: string; observed: Record<string, number> };
}

async function runBuiltCli(
  args: readonly string[],
  environment: Record<string, string>,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const home = await privateRoot("docsfab-built-cli-home-");
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [join(packageRoot, "bin", "docsfab.mjs"), ...args],
      {
        cwd: home,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: home,
          TMPDIR: tmpdir(),
          PI_OFFLINE: "1",
          // No host limits file applies, whatever this machine has installed.
          DOCSFAB_SERVICE_ENV_FILE: join(home, "absent-service.env"),
          ...environment,
        },
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    const failed = error as { code?: unknown; stdout?: string; stderr?: string };
    if (typeof failed.code !== "number") throw error;
    return { stdout: failed.stdout ?? "", stderr: failed.stderr ?? "", exitCode: failed.code };
  }
}

function rowsByName(stdout: string): Map<string, LimitRow> {
  const report = JSON.parse(stdout) as { kind: string; rows: LimitRow[] };
  expect(report.kind).toBe("docsfab-doctor-limits");
  return new Map(report.rows.map((row) => [row.name, row]));
}

describe("built docsfab doctor --limits", () => {
  it("reports measured rows and headroom after this build persists a review report", {
    timeout: testTimeoutMs(CLI_LOCAL_MS),
  }, async () => {
    const stateDirectory = join(await privateRoot("docsfab-built-limits-state-"), "runs");
    const { observed, recordPath } = await writeRecord(stateDirectory, "built-run");
    const recordBytes = await readFile(recordPath);
    const reportModule = pathToFileURL(
      join(packageRoot, "dist", "evaluation-report", "hosted-report.js"),
    ).href;
    const script = [
      "const [module, stateDirectory] = process.argv.slice(1);",
      "const { persistHostedQualityReport } = await import(module);",
      'const report = await persistHostedQualityReport({ stateDirectory, runId: "built-run", quality: null, markdown: "Review complete." });',
      "process.stdout.write(JSON.stringify(report));",
    ].join("\n");
    const { stdout: persisted } = await execFileAsync(
      process.execPath,
      ["--input-type=module", "-e", script, reportModule, stateDirectory],
      { cwd: buildRoot, env: { PATH: process.env.PATH ?? "", HOME: buildRoot, PI_OFFLINE: "1" } },
    );
    const reportPath = (JSON.parse(persisted) as { path: string }).path;
    const reportBytes = await readFile(reportPath);

    const result = await runBuiltCli(["doctor", "--limits", "--json"], {
      DOCSFAB_CONFIG_ROOT: await privateRoot("docsfab-built-limits-config-"),
      DOCSFAB_STATE_DIR: stateDirectory,
      DOCSFAB_READ_ONLY_MAX_RETRIES: "2",
    });

    expect(result.exitCode, result.stderr).toBe(0);
    // The isolated build wrote its package files beside its own dist/.
    expect(await readFile(join(packageRoot, "LICENSE"), "utf8")).not.toBe("");
    const rows = rowsByName(result.stdout);
    expect(rows.get("retry.maxRetries")).toEqual({
      name: "retry.maxRetries",
      value: 2,
      unit: "count",
      source: "host",
      observedMaxSeen: 1,
      headroomPercent: 50,
      status: "ok",
    });
    expect(rows.get("compositionExecution.maxCumulativeInputTokens")).toMatchObject({
      observedMaxSeen: 4_567,
      headroomPercent: 100,
      status: "ok",
    });
    expect(rows.get("compositionExecution.maxCumulativeOutputTokens")?.observedMaxSeen).toBe(890);
    expect(rows.get("compositionExecution.maxProviderTurns")?.observedMaxSeen).toBe(2);
    expect(rows.get("compositionExecution.maxToolCallsPerStep")?.observedMaxSeen).toBe(3);
    for (const [name, value] of Object.entries(observed)) {
      expect(rows.get(name)?.observedMaxSeen, name).toBe(value);
      expect(rows.get(name)?.headroomPercent, name).not.toBeNull();
    }
    expect(await readFile(recordPath)).toEqual(recordBytes);
    expect(await readFile(reportPath)).toEqual(reportBytes);
  });

  it("reads an exported DOCSFAB_STATE_DIR before host.yaml paths.stateDir", {
    timeout: testTimeoutMs(CLI_LOCAL_MS),
  }, async () => {
    const root = await privateRoot("docsfab-built-limits-precedence-");
    const exported = join(root, "exported-runs");
    const hostConfigured = join(root, "host-runs");
    await writeRecord(exported, "exported-run", 4_567);
    await writeRecord(hostConfigured, "host-run", 1_234);
    const configurationRoot = join(root, "configuration");
    await mkdir(configurationRoot, { mode: 0o700 });
    await writeFile(
      join(configurationRoot, "host.yaml"),
      [
        "schemaVersion: 1",
        "kind: docsfab-host-config",
        "compositionId: test-composition",
        "paths:",
        `  stateDir: ${hostConfigured}`,
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    const inputTokens = async (environment: Record<string, string>) => {
      const result = await runBuiltCli(["doctor", "--limits", "--json"], {
        DOCSFAB_CONFIG_ROOT: configurationRoot,
        ...environment,
      });
      expect(result.exitCode, result.stderr).toBe(0);
      return rowsByName(result.stdout).get("compositionExecution.maxCumulativeInputTokens")
        ?.observedMaxSeen;
    };

    expect(await inputTokens({ DOCSFAB_STATE_DIR: exported })).toBe(4_567);
    expect(await inputTokens({})).toBe(1_234);
  });

  it("lists each step's answer plan in the text report from the packaged catalog", {
    timeout: testTimeoutMs(CLI_LOCAL_MS),
  }, async () => {
    const result = await runBuiltCli(["doctor", "--limits"], {
      DOCSFAB_CONFIG_ROOT: await privateRoot("docsfab-built-limits-config-"),
      DOCSFAB_STATE_DIR: join(await privateRoot("docsfab-built-limits-plans-"), "runs"),
    });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      "Steps using compositionExecution.answerPlan.defaultTokens: analyze-information-architecture, answer-question, compare-product-behavior.",
    );
  });

  it("refuses with a coded error when the packaged workflow catalog is missing", {
    timeout: testTimeoutMs(CLI_LOCAL_MS),
  }, async () => {
    const catalog = join(packageRoot, "workflows");
    const aside = join(packageRoot, "workflows-aside");
    await rename(catalog, aside);
    try {
      const result = await runBuiltCli(["doctor", "--limits"], {
        DOCSFAB_CONFIG_ROOT: await privateRoot("docsfab-built-limits-config-"),
        DOCSFAB_STATE_DIR: join(await privateRoot("docsfab-built-limits-nocatalog-"), "runs"),
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("workflow-catalog-unavailable");
      expect(result.stderr).toContain("could not read its packaged workflow catalog (ENOENT)");
      expect(result.stderr).not.toContain("scandir");
    } finally {
      await rename(aside, catalog);
    }
  });

  it("reports a hand-corrupted record as invalid-record with its path", {
    timeout: testTimeoutMs(CLI_LOCAL_MS),
  }, async () => {
    const stateDirectory = join(await privateRoot("docsfab-built-limits-corrupt-"), "runs");
    const { recordPath } = await writeRecord(stateDirectory, "corrupted-run");
    const record = JSON.parse(await readFile(recordPath, "utf8")) as {
      steps: {
        inference: { attempts: { executionLease?: { cumulativeInputTokens: number } }[] };
      }[];
    };
    const lease = record.steps[0]!.inference.attempts[1]!.executionLease!;
    lease.cumulativeInputTokens += 1;
    await writeFile(recordPath, JSON.stringify(record));

    const result = await runBuiltCli(["doctor", "--limits", "--json"], {
      DOCSFAB_CONFIG_ROOT: await privateRoot("docsfab-built-limits-config-"),
      DOCSFAB_STATE_DIR: stateDirectory,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({
      kind: "docsfab-operator-error",
      code: "invalid-record",
      message:
        "Run limit observations failed (invalid-record) at $DOCSFAB_STATE_DIR/corrupted-run.json.",
      nextAction:
        "Inspect the named file and correct the contract fields it breaks, then rerun `docsfab doctor --limits`.",
      failure: { class: "contract-shape", code: "invalid-record" },
    });
  });

  it.each([
    {
      label: "a faulting lease decoder",
      recordId: "decoder-fault",
      override:
        'export function decodeExecutionLeaseRuntimeEvidence() { throw new TypeError("lease decoder fault"); }',
      cause: /^TypeError: lease decoder fault$/u,
    },
    {
      label: "an unreadable decoded lease",
      recordId: "decoder-shape",
      override:
        'export function decodeExecutionLeaseRuntimeEvidence() { return { phase: "terminal" }; }',
      cause: /^TypeError: /u,
    },
  ])(
    "reports $label as internal-error, never invalid-record",
    {
      timeout: testTimeoutMs(CLI_LOCAL_MS),
    },
    async ({ recordId, override, cause }) => {
      const stateDirectory = join(await privateRoot("docsfab-built-limits-decoder-"), "runs");
      await writeRecord(stateDirectory, recordId);
      // Other startup modules import the decoder's remaining exports, so the
      // stand-in re-exports the build's module and replaces one function.
      const dist = join(packageRoot, "dist");
      const compiledDecoder = join(dist, "scorecard-record-decode.js");
      const original = join(dist, "scorecard-record-decode-original.js");
      await rename(compiledDecoder, original);
      try {
        await writeFile(
          compiledDecoder,
          `export * from "./scorecard-record-decode-original.js";\n${override}\n`,
        );
        const result = await runBuiltCli(["doctor", "--limits", "--json"], {
          DOCSFAB_CONFIG_ROOT: await privateRoot("docsfab-built-limits-config-"),
          DOCSFAB_STATE_DIR: stateDirectory,
        });

        expect(result.exitCode).toBe(1);
        expect(result.stdout).toBe("");
        const envelope = JSON.parse(result.stderr) as { message: string };
        expect(envelope).toMatchObject({
          kind: "docsfab-operator-error",
          code: "internal-error",
          nextAction: expect.stringMatching(/^Report this message to the DocsFab maintainers\./u),
          failure: { class: "unknown", code: "internal-error" },
        });
        const prefix = `Run limit observations failed (internal-error) at $DOCSFAB_STATE_DIR/${recordId}.json: `;
        expect(envelope.message.startsWith(prefix), envelope.message).toBe(true);
        expect(envelope.message.slice(prefix.length)).toMatch(cause);
        expect(result.stderr).not.toContain("invalid-record");
      } finally {
        await rm(compiledDecoder, { force: true });
        await rename(original, compiledDecoder);
      }
    },
  );
});
