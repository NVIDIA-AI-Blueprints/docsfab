// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleDoctorCommand } from "../src/cli/commands/doctor.js";
import { main } from "../src/cli/router.js";
import { resolveDocsFabStateDirectory } from "../src/config/host-paths.js";
import { limitDefinition } from "../src/config/limits.js";
import { createExecutionLeaseCoordinatorPolicy } from "../src/execution/index.js";
import { persistHostedQualityReport } from "../src/evaluation-report/hosted-report.js";
import { PiExecutionLeaseController } from "../src/harness/pi-lease.js";
import type { InferenceAttemptEvidence, RunRecord } from "../src/records/contracts.js";
import { FileRunStore } from "../src/records/file-store.js";
import { reportOperatorFailure, wantsJsonFailureOutput } from "../src/operator/error-envelope.js";
import { temporaryRoots } from "./helpers/temp.js";

const roots = temporaryRoots();
const recordsFitProjection = vi.hoisted(() => ({
  inspect: vi.fn<() => Promise<readonly Record<string, unknown>[]>>(),
}));
vi.mock("../src/cli/commands/answer-record-fit-doctor.js", () => ({
  inspectAnswerSubmissionRecordsFits: recordsFitProjection.inspect,
}));
const originalArgv = process.argv;
const originalLog = console.log;
const originalError = console.error;
const originalObserved = process.env.DOCSFAB_LIMITS_OBSERVED_FILE;
const originalConfigRoot = process.env.DOCSFAB_CONFIG_ROOT;
const originalStateDirectory = process.env.DOCSFAB_STATE_DIR;
const originalReadOnlyMaxRetries = process.env.DOCSFAB_READ_ONLY_MAX_RETRIES;

beforeEach(async () => {
  recordsFitProjection.inspect.mockResolvedValue([]);
  const stateDirectory = await roots.create("docsfab-doctor-limit-state-");
  process.env.DOCSFAB_STATE_DIR = stateDirectory;
  delete process.env.DOCSFAB_LIMITS_OBSERVED_FILE;
});

afterEach(async () => {
  console.log = originalLog;
  console.error = originalError;
  process.argv = originalArgv;
  process.exitCode = undefined;
  if (originalObserved === undefined) delete process.env.DOCSFAB_LIMITS_OBSERVED_FILE;
  else process.env.DOCSFAB_LIMITS_OBSERVED_FILE = originalObserved;
  if (originalConfigRoot === undefined) delete process.env.DOCSFAB_CONFIG_ROOT;
  else process.env.DOCSFAB_CONFIG_ROOT = originalConfigRoot;
  if (originalStateDirectory === undefined) delete process.env.DOCSFAB_STATE_DIR;
  else process.env.DOCSFAB_STATE_DIR = originalStateDirectory;
  if (originalReadOnlyMaxRetries === undefined) delete process.env.DOCSFAB_READ_ONLY_MAX_RETRIES;
  else process.env.DOCSFAB_READ_ONLY_MAX_RETRIES = originalReadOnlyMaxRetries;
});

async function captureDoctor(args: string[]): Promise<string> {
  const logs: string[] = [];
  console.log = (message?: unknown) => {
    logs.push(String(message ?? ""));
  };
  console.error = (message?: unknown) => {
    logs.push(String(message ?? ""));
  };
  await handleDoctorCommand(args);
  return logs.join("\n");
}

async function runDoctorCli(args: string[]): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  console.log = (message?: unknown) => stdout.push(String(message ?? ""));
  console.error = (message?: unknown) => stderr.push(String(message ?? ""));
  process.argv = [originalArgv[0]!, originalArgv[1]!, "doctor", ...args];
  try {
    await main();
  } catch (error) {
    reportOperatorFailure(error, {
      json: wantsJsonFailureOutput(),
      write: (line) => stderr.push(line),
    });
    process.exitCode = 1;
  }
  return {
    stdout: stdout.join("\n"),
    stderr: stderr.join("\n"),
    exitCode: process.exitCode ?? 0,
  };
}

describe("docsfab doctor --limits", () => {
  it("reads run limits after review report persistence through the doctor CLI", async () => {
    const stateDirectory = process.env.DOCSFAB_STATE_DIR!;
    const store = new FileRunStore(stateDirectory);
    await store.save(runRecord("reviewed", [attempt(1, 9, false, undefined, true)]));
    const savedRun = await store.get("reviewed");
    const persistedReport = await persistHostedQualityReport({
      stateDirectory,
      runId: "reviewed",
      quality: null,
      markdown: "Review complete.",
    });
    const reportBytes = await readFile(persistedReport.path);
    const artifactDirectory = join(stateDirectory, "artifacts");
    await mkdir(artifactDirectory, { mode: 0o700 });
    const artifactPath = join(artifactDirectory, "unrelated.txt");
    await writeFile(artifactPath, "Unrelated retained artifact.", { mode: 0o600 });

    const result = await runDoctorCli(["--limits", "--json"]);

    expect(result.exitCode, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout) as {
      rows: {
        name: string;
        observedMaxSeen: number | null;
        headroomPercent: number | null;
        status: string;
      }[];
    };
    const timeoutRow = report.rows.find((row) => row.name === "compositionExecution.timeoutMs");
    expect(timeoutRow).toMatchObject({ observedMaxSeen: 9, status: "ok" });
    expect(timeoutRow?.headroomPercent).toBeGreaterThan(0);
    expect(await store.get("reviewed")).toEqual(savedRun);
    expect(await readFile(persistedReport.path)).toEqual(reportBytes);
    expect(await readFile(artifactPath, "utf8")).toBe("Unrelated retained artifact.");
  });

  it.each([
    {
      label: "duplicate --limits in text mode",
      args: ["--limits", "--limits"],
      json: false,
      message: "The --limits option must not be duplicated on docsfab doctor.",
    },
    {
      label: "duplicate --limits in JSON mode",
      args: ["--limits", "--limits", "--json"],
      json: true,
      message: "The --limits option must not be duplicated on docsfab doctor.",
    },
    {
      label: "--limits with --live in text mode",
      args: ["--limits", "--live"],
      json: false,
      message: "doctor --limits cannot combine with --live or --catalog.",
    },
    {
      label: "--limits with --catalog in JSON mode",
      args: ["--limits", "--catalog", "--json"],
      json: true,
      message: "doctor --limits cannot combine with --live or --catalog.",
    },
  ])("rejects $label through the real CLI boundary", async ({ args, json, message }) => {
    const result = await runDoctorCli(args);
    expect(result).toMatchObject({ exitCode: 1, stdout: "" });
    if (json) {
      expect(JSON.parse(result.stderr)).toMatchObject({
        schemaVersion: 1,
        kind: "docsfab-operator-error",
        code: "cli-usage",
        message,
        nextAction: expect.stringContaining("docsfab --help"),
      });
    } else {
      expect(result.stderr).toContain(message);
      expect(result.stderr).toMatch(/^code: cli-usage$/mu);
      expect(result.stderr).toContain("Next action: Run `docsfab --help`");
    }
  });

  it("prints required columns for every migrated limit", async () => {
    const output = await captureDoctor(["--limits"]);
    expect(output).toContain(
      "name | value | unit | source | observed-max-seen | headroom% | status",
    );
    expect(output).toContain("compositionExecution.timeoutMs");
    expect(output).toContain("retry.maxRetries");
    // The technical-correction byte bounds, sealed in the catalog.
    for (const name of [
      "technicalCorrection.proposalMaxBytes | 262144 | bytes | config/limits.yaml",
      "technicalCorrection.evidenceMaxBytes | 524288 | bytes | config/limits.yaml",
      "technicalCorrection.derivedResultMaxBytes | 786432 | bytes | config/limits.yaml",
    ]) {
      expect(output).toContain(name);
    }
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("projects a credential-free records fit into text and JSON doctor output and exits on a failed fit", async () => {
    recordsFitProjection.inspect.mockResolvedValue([
      {
        compositionId: "synthetic-records-fit",
        qualification: "qualified",
        fitStatus: "does-not-fit",
        predictedTimerMs: 420_000,
        timerReviewLimitMs: 600_000,
        effectiveMaxOutputTokens: 8_192,
        effectiveTimeoutMs: 300_000,
        requiredReadingTurns: 8,
        effectiveMaxProviderTurns: 7,
        effectiveMessageBudgetBytes: 6_144,
        largestRecordEnvelopeBytes: 5_000,
        recordCallCeiling: 36,
        recordCallCeilingProvenance: "canonical profile answer plan",
        evidenceProvenance: "synthetic sealed evidence digests",
      },
    ]);

    const text = await captureDoctor(["--limits"]);
    expect(process.exitCode).toBe(1);
    expect(text).toContain("synthetic-records-fit | 420000 | 600000 | 8192 | 300000");
    expect(text).toContain("canonical profile answer plan; synthetic sealed evidence digests");

    process.exitCode = undefined;
    const json = JSON.parse(await captureDoctor(["--limits", "--json"])) as {
      exitCode: number;
      answerSubmissionRecordsFits: Array<{ recordCallCeiling: number; fitStatus: string }>;
    };
    expect(json.exitCode).toBe(1);
    expect(json.answerSubmissionRecordsFits[0]).toMatchObject({
      recordCallCeiling: 36,
      fitStatus: "does-not-fit",
    });
  });

  it("fails doctor limits for a qualified capability below its phase-B message floor", async () => {
    recordsFitProjection.inspect.mockResolvedValue([
      {
        compositionId: "synthetic-records-below-qualified-floor",
        qualification: "qualified",
        fitStatus: "does-not-fit",
        reason: "effective message budget is below the smallest qualified rung (6144 bytes)",
        predictedTimerMs: 420_000,
        timerReviewLimitMs: 600_000,
        effectiveMaxOutputTokens: 1_024,
        effectiveTimeoutMs: 300_000,
        requiredReadingTurns: 8,
        effectiveMaxProviderTurns: 7,
        effectiveMessageBudgetBytes: 2_340,
        largestRecordEnvelopeBytes: 5_000,
        recordCallCeiling: 240,
        recordCallCeilingProvenance: "canonical profile answer plan",
        evidenceProvenance: "synthetic sealed evidence digests",
      },
    ]);

    const output = await captureDoctor(["--limits"]);
    expect(process.exitCode).toBe(1);
    expect(output).toContain("synthetic-records-below-qualified-floor | 420000 | 600000");
    expect(output).toContain("qualified | does-not-fit | effective message budget is below");
  });

  it("reads FileRunStore evidence and enforces warning, over, and zero-retry boundaries", async () => {
    process.env.DOCSFAB_READ_ONLY_MAX_RETRIES = "0";
    const stateDirectory = process.env.DOCSFAB_STATE_DIR!;
    const store = new FileRunStore(stateDirectory);
    const timeout = limitDefinition("compositionExecution.timeoutMs");
    await store.save(
      runRecord("warning", [attempt(1, timeout.value * timeout.warnAt, false, undefined, true)]),
    );

    const warning = await captureDoctor(["--limits"]);
    expect(process.exitCode).toBe(3);
    expect(warning).toContain(
      "compositionExecution.timeoutMs | 3600000 | ms | config/limits.yaml | 2880000 | 20 | warn",
    );
    expect(warning).toContain("retry.maxRetries | 0 | count | host | 0 | 100 | ok");

    await store.save(runRecord("retry-over", [attempt(1, 1, true, 1_000), attempt(2, 1, false)]));
    process.exitCode = undefined;
    const over = await captureDoctor(["--limits"]);
    expect(process.exitCode).toBe(1);
    expect(over).toContain("retry.maxRetries | 0 | count | host | 1 | 0 | over");
  });

  it("does not report a complete Slack answer as over a zero chunk-mode setting", async () => {
    const observationFile = join(process.env.DOCSFAB_STATE_DIR!, "slack-observations.json");
    await writeFile(observationFile, JSON.stringify({ "host.slack.liveAgentAnswerMaxChunks": 4 }));
    process.env.DOCSFAB_LIMITS_OBSERVED_FILE = observationFile;
    const output = await captureDoctor(["--limits"]);
    expect(output).toContain(
      "host.slack.liveAgentAnswerMaxChunks | 0 | count | config/limits.yaml | 4 | n/a | ok",
    );
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("reports unavailable observations as unknown without fabricating headroom", async () => {
    const output = await captureDoctor(["--limits"]);
    expect(output).toContain(
      "compositionExecution.timeoutMs | 3600000 | ms | config/limits.yaml | n/a | n/a | unknown",
    );
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("emits JSON evidence with --limits --json", async () => {
    const output = await captureDoctor(["--limits", "--json"]);
    const parsed = JSON.parse(output) as { kind: string; rows: unknown[] };
    expect(parsed.kind).toBe("docsfab-doctor-limits");
    expect(parsed.rows.length).toBeGreaterThan(0);
  });

  it("lists each read-only model step's answer plan and names the steps on the default", async () => {
    const output = await captureDoctor(["--limits"]);
    expect(output).toContain(
      "test-audience-understanding | 2900 | compositionExecution.answerPlan.testAudienceUnderstandingTokens | step",
    );
    expect(output).toContain(
      "answer-question | 11800 | compositionExecution.answerPlan.defaultTokens | default",
    );
    expect(output).toContain(
      "Steps using compositionExecution.answerPlan.defaultTokens: analyze-information-architecture, answer-question, compare-product-behavior.",
    );
    // The JSON record keeps its documented keys; its rows carry each plan entry.
    const parsed = JSON.parse(await captureDoctor(["--limits", "--json"])) as {
      rows: Array<{ name: string; value: number }>;
    };
    expect(Object.keys(parsed).sort()).toEqual([
      "exitCode",
      "kind",
      "rows",
      "schemaVersion",
      "status",
    ]);
    expect(
      parsed.rows.find(
        (row) => row.name === "compositionExecution.answerPlan.evaluateDocumentQualityTokens",
      )?.value,
    ).toBe(11_800);
  });

  it("loads a limit override from the same local configuration source as runtime", async () => {
    const root = await roots.create("docsfab-doctor-limit-config-");
    await writeFile(
      join(root, ".env"),
      "DOCSFAB_COMPOSITION_EXECUTION_TIMEOUT_MS=2000000\n",
      "utf8",
    );
    process.env.DOCSFAB_CONFIG_ROOT = root;

    const output = await captureDoctor(["--limits"]);
    expect(output).toContain("compositionExecution.timeoutMs | 2000000 | ms | host |");
  });

  it("reads the run-record directory in the order resolveDocsFabStateDirectory uses", async () => {
    const root = await roots.create("docsfab-doctor-limit-precedence-", { mode: 0o700 });
    const configurationRoot = join(root, "configuration");
    await mkdir(configurationRoot, { mode: 0o700 });
    const stores = {
      exported: join(root, "exported-runs"),
      hostYaml: join(root, "host-runs"),
      envFile: join(root, "env-file-runs"),
      defaultRoot: join(configurationRoot, ".docsfab", "runs"),
    };
    const durations = { exported: 111, hostYaml: 222, envFile: 333, defaultRoot: 444 };
    for (const [tier, directory] of Object.entries(stores)) {
      const durationMs = durations[tier as keyof typeof durations];
      await new FileRunStore(directory).save(
        runRecord(`${tier}-run`, [attempt(1, durationMs, false, undefined, true)]),
      );
    }
    const hostYaml = (stateDir?: string) =>
      writeFile(
        join(configurationRoot, "host.yaml"),
        [
          "schemaVersion: 1",
          "kind: docsfab-host-config",
          "compositionId: test-composition",
          ...(stateDir === undefined ? [] : ["paths:", `  stateDir: ${stateDir}`]),
          "",
        ].join("\n"),
        { mode: 0o600 },
      );
    process.env.DOCSFAB_CONFIG_ROOT = configurationRoot;
    const observedTimeout = async (): Promise<unknown> => {
      const result = await runDoctorCli(["--limits", "--json"]);
      expect(result.exitCode, result.stderr).toBe(0);
      const report = JSON.parse(result.stdout) as {
        rows: { name: string; observedMaxSeen: number | null }[];
      };
      return report.rows.find((row) => row.name === "compositionExecution.timeoutMs")
        ?.observedMaxSeen;
    };

    await hostYaml(stores.hostYaml);
    process.env.DOCSFAB_STATE_DIR = stores.exported;
    expect(resolveDocsFabStateDirectory(process.env)).toBe(stores.exported);
    expect(await observedTimeout()).toBe(durations.exported);

    delete process.env.DOCSFAB_STATE_DIR;
    expect(resolveDocsFabStateDirectory(process.env)).toBe(stores.hostYaml);
    expect(await observedTimeout()).toBe(durations.hostYaml);

    await hostYaml();
    await writeFile(
      join(configurationRoot, "secrets.env"),
      `DOCSFAB_STATE_DIR=${stores.envFile}\n`,
      {
        mode: 0o600,
      },
    );
    expect(resolveDocsFabStateDirectory(process.env)).toBe(stores.envFile);
    expect(await observedTimeout()).toBe(durations.envFile);

    await writeFile(join(configurationRoot, "secrets.env"), "", { mode: 0o600 });
    expect(resolveDocsFabStateDirectory(process.env)).toBe(stores.defaultRoot);
    expect(await observedTimeout()).toBe(durations.defaultRoot);
  });

  it("names a hand-corrupted record in its invalid-record envelope", async () => {
    const stateDirectory = process.env.DOCSFAB_STATE_DIR!;
    await new FileRunStore(stateDirectory).save(
      runRecord("corrupted", [attempt(1, 9, false, undefined, true)]),
    );
    const recordPath = join(stateDirectory, "corrupted.json");
    const stored = JSON.parse(await readFile(recordPath, "utf8")) as {
      steps: { inference: { attempts: { executionLease: { providerTurns: number } }[] } }[];
    };
    stored.steps[0]!.inference.attempts[0]!.executionLease.providerTurns += 1;
    await writeFile(recordPath, JSON.stringify(stored));

    const result = await runDoctorCli(["--limits", "--json"]);

    expect(result).toMatchObject({ exitCode: 1, stdout: "" });
    expect(JSON.parse(result.stderr)).toMatchObject({
      kind: "docsfab-operator-error",
      code: "invalid-record",
      message:
        "Run limit observations failed (invalid-record) at $DOCSFAB_STATE_DIR/corrupted.json.",
      nextAction:
        "Inspect the named file and correct the contract fields it breaks, then rerun `docsfab doctor --limits`.",
      failure: { class: "contract-shape", code: "invalid-record" },
    });
  });
});

function attempt(
  number: number,
  durationMs: number,
  retryScheduled: boolean,
  backoffMs?: number,
  leased = false,
): InferenceAttemptEvidence {
  return {
    attempt: number,
    outcome: retryScheduled ? "timeout" : "succeeded",
    retryable: retryScheduled,
    retryScheduled,
    durationMs,
    ...(backoffMs === undefined ? {} : { backoffMs }),
    ...(leased ? { executionLease: executionLease(number) } : {}),
  };
}

function executionLease(inferenceAttempt: number) {
  const context = {
    status: "ready" as const,
    availableInputTokens: 10_000,
    requiredInputTokens: 1,
    authoritySha256: "9".repeat(64),
  };
  const subject = new PiExecutionLeaseController({
    policy: createExecutionLeaseCoordinatorPolicy({
      maxCompactions: 1,
      providerLimits: { maxProviderTurns: 16, maxCompactions: 1 },
      cumulative: {
        maxInputTokens: 10_000,
        maxOutputTokens: 10_000,
        maxElapsedMs: 10_000,
      },
    }),
    identity: {
      inferenceAttempt,
      retriesConsumed: inferenceAttempt - 1,
      authorizationSha256: "1".repeat(64),
      repositoryRevision: "a".repeat(40),
      contextPacketSha256: "2".repeat(64),
      evidenceSha256: "3".repeat(64),
      toolPolicySha256: "4".repeat(64),
      contextAuthoritySha256: context.authoritySha256,
    },
    pricing: {
      status: "known",
      inputMicrousdPerMillionTokens: 100,
      outputMicrousdPerMillionTokens: 200,
      authoritySha256: "5".repeat(64),
    },
    context,
  });
  subject.complete();
  return subject.evidence({
    inferenceAttempt,
    retriesConsumed: inferenceAttempt - 1,
    repositoryRevision: "a".repeat(40),
    providerTurnLedgerSha256: "6".repeat(64),
    usageSha256: "7".repeat(64),
    toolsSha256: "8".repeat(64),
  });
}

function runRecord(id: string, attempts: InferenceAttemptEvidence[]): RunRecord {
  return {
    schemaVersion: 2,
    id,
    workflow: "readiness",
    repository: {
      sourcePath: "/operator/source",
      requestedRevision: "HEAD",
      revision: "a".repeat(40),
    },
    workspace: { strategy: "tracked-export", disposable: true },
    status: "succeeded",
    createdAt: "2026-09-18T12:00:00.000Z",
    models: [],
    skills: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0 },
    tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
    steps: [
      {
        id: "observe",
        title: "Observe",
        skill: "observe",
        mode: "read-only",
        status: "succeeded",
        inference: {
          configuredMaxRetries: attempts.length - 1,
          effectiveMaxRetries: attempts.length - 1,
          baseDelayMs: attempts[0]?.backoffMs ?? 0,
          maxDelayMs: attempts[0]?.backoffMs ?? 0,
          retryableCategories: attempts.length > 1 ? ["timeout"] : [],
          replay: "read-only",
          attempts,
        },
      },
    ],
  };
}
