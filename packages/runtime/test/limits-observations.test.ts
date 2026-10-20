// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { limit } from "../src/config/limits.js";
import {
  LimitObservationError,
  persistHostedLimitObservations,
  projectRunLimitObservations,
  readRunLimitObservations,
  resolveHostedLimitObservationsDirectory,
} from "../src/config/limits-observations.js";
import { createExecutionLeaseCoordinatorPolicy } from "../src/execution/index.js";
import { digestPiToolCall, PiExecutionLeaseController } from "../src/harness/pi-lease.js";
import type { RunRecord } from "../src/records/contracts.js";
import { FileRunStore } from "../src/records/file-store.js";
import { executeInferenceStep } from "../src/workflow-execution/retry.js";
import { parseRetryPolicy } from "../src/config/retry-policy.js";
import { InferenceStepError } from "../src/execution/contracts.js";
import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../src/json-evidence.js";
import { temporaryRoots } from "./helpers/temp.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";
import {
  blankTurn,
  createInstantReplayAuditHarness,
  createRepository,
  resetSharedTestState,
  scriptedProvider,
  stepInput,
  textTurn,
} from "./support/pi-harness-session-fixtures.js";

const roots = temporaryRoots();

afterEach(resetSharedTestState);

describe("run limit observations", () => {
  it("returns no fabricated measurements for an empty store", async () => {
    const stateDirectory = await temporaryRoot();

    await expect(read(stateDirectory)).resolves.toEqual({});
  });

  it("does not create a missing store beneath an unwritable service home", async () => {
    const root = await temporaryRoot();
    const serviceHome = join(root, "service-home");
    const missingStore = join(serviceHome, ".config", "docsfab", ".docsfab", "runs");
    await mkdir(serviceHome, { mode: 0o500 });

    await expect(
      readRunLimitObservations({
        environment: { HOME: serviceHome, XDG_CONFIG_HOME: join(serviceHome, ".config") },
      }),
    ).resolves.toEqual({});
    await expect(lstat(missingStore)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not attribute high unleased attempt usage to composition limits", async () => {
    const stateDirectory = await temporaryRoot();
    const record = runRecord("high-usage");
    record.steps.push(
      inferenceStep([
        attempt({
          attempt: 1,
          durationMs: 1_700_000,
          retryScheduled: true,
          backoffMs: 1_000,
          providerTurns: 500,
          toolCalls: 390,
          inputTokens: 1_500_000,
          outputTokens: 120_000,
        }),
        attempt({
          attempt: 2,
          durationMs: 1_710_000,
          retryScheduled: true,
          backoffMs: 2_000,
          providerTurns: 501,
          toolCalls: 391,
          inputTokens: 1_510_000,
          outputTokens: 121_000,
        }),
        attempt({
          attempt: 3,
          durationMs: 1_720_000,
          retryScheduled: false,
          providerTurns: 502,
          toolCalls: 392,
          inputTokens: 1_520_000,
          outputTokens: 122_000,
        }),
      ]),
    );
    await new FileRunStore(stateDirectory).save(record);

    await expect(read(stateDirectory)).resolves.toEqual({
      "retry.baseDelayMs": 1_000,
      "retry.maxDelayMs": 2_000,
      "retry.maxRetries": 2,
    });
  });

  it("keeps unleased retry-producer evidence limited to retry observations", async () => {
    const stateDirectory = await temporaryRoot();
    const produced = await executeInferenceStep({
      mode: "read-only",
      policy: {
        maxRetries: 0,
        baseDelayMs: 25,
        maxDelayMs: 50,
        retryableCategories: [],
      },
      now: sequentialClock([100, 142]),
      execute: async () => ({
        summary: "ready",
        usage: { input: 40, output: 8, cacheRead: 0, cacheWrite: 0, total: 48, turns: 3 },
        tools: { totalCalls: 2, failedCalls: 0, byTool: [] },
      }),
    });
    const record = runRecord("producer-evidence");
    record.steps.push({
      id: "produced",
      title: "Produced evidence",
      skill: "observe",
      mode: "read-only",
      status: produced.status,
      inference: produced.evidence,
    });
    await new FileRunStore(stateDirectory).save(record);

    // A record that applied condition budgets also observes them; none was spent.
    await expect(read(stateDirectory)).resolves.toEqual({
      "retry.maxRetries": 0,
      "retry.maxTimeoutRetries": 0,
      "retry.maxCutAnswerRetries": 0,
      "retry.maxNoProgressRetries": 0,
    });
  });

  it("observes transport retries against the transport limits, never the contract count", async () => {
    const stateDirectory = await temporaryRoot();
    const policy = parseRetryPolicy({});
    const transportRetries = policy.transport!.maxRetries;
    const script = [
      ...Array<"429">(transportRetries).fill("429"),
      ...Array<"malformed">(policy.maxRetries).fill("malformed"),
      "ok",
    ] as const;
    const produced = await executeInferenceStep({
      mode: "read-only",
      policy,
      now: () => 0,
      sleep: async () => undefined,
      execute: async (attempt) => {
        const step = script[attempt - 1];
        if (step === "429")
          throw new InferenceStepError("429 Too Many Requests", "throttled", true);
        if (step === "malformed") {
          throw new InferenceStepError("Refused.", "malformed-response", true);
        }
        return { summary: "ready" };
      },
    });
    expect(produced.status).toBe("succeeded");
    const transportWaits = produced.evidence.attempts
      .filter((attempt) => attempt.outcome === "throttled")
      .map((attempt) => attempt.backoffMs ?? 0);
    const contractWaits = produced.evidence.attempts
      .filter((attempt) => attempt.outcome === "malformed-response")
      .map((attempt) => attempt.backoffMs ?? 0);
    const record = runRecord("transport-evidence");
    record.steps.push({
      id: "produced",
      title: "Produced evidence",
      skill: "observe",
      mode: "read-only",
      status: produced.status,
      inference: produced.evidence,
    });
    await new FileRunStore(stateDirectory).save(record);

    await expect(read(stateDirectory)).resolves.toEqual({
      "retry.maxRetries": policy.maxRetries,
      "retry.baseDelayMs": contractWaits[0],
      "retry.maxDelayMs": Math.max(...contractWaits),
      "retry.maxTransportRetries": transportRetries,
      "retry.transportMaxDelayMs": Math.max(...transportWaits),
      "retry.transportMaxElapsedMs": transportWaits.reduce((sum, wait) => sum + wait, 0),
      "retry.maxTimeoutRetries": 0,
      "retry.maxCutAnswerRetries": 0,
      "retry.maxNoProgressRetries": 0,
    });
  });

  it("reads composition usage from real Pi execution-lease evidence", async () => {
    const stateDirectory = await temporaryRoot();
    const record = runRecord("leased-producer-evidence");
    record.steps.push(
      inferenceStep([
        leasedAttempt({
          attempt: 1,
          durationMs: 42,
          retryScheduled: false,
          providerTurns: 1,
          toolCalls: 2,
          inputTokens: 40,
          outputTokens: 8,
        }),
      ]),
    );
    await new FileRunStore(stateDirectory).save(record);

    await expect(read(stateDirectory)).resolves.toEqual({
      "compositionExecution.maxCumulativeInputTokens": 40,
      "compositionExecution.maxCumulativeOutputTokens": 8,
      "compositionExecution.maxProviderTurns": 1,
      "compositionExecution.maxToolCallsPerStep": 2,
      "compositionExecution.timeoutMs": 42,
      "retry.maxRetries": 0,
    });
  });

  it("takes maxima across records without summing independent attempts", async () => {
    const stateDirectory = await temporaryRoot();
    const first = runRecord("first");
    first.steps.push(
      inferenceStep([
        leasedAttempt({
          attempt: 1,
          durationMs: 90,
          retryScheduled: true,
          backoffMs: 10,
          providerTurns: 1,
          toolCalls: 5,
          inputTokens: 700,
          outputTokens: 70,
        }),
        leasedAttempt({
          attempt: 2,
          durationMs: 80,
          retryScheduled: false,
          providerTurns: 1,
          toolCalls: 4,
          inputTokens: 600,
          outputTokens: 60,
        }),
      ]),
    );
    const second = runRecord("second");
    second.steps.push(
      inferenceStep([
        leasedAttempt({
          attempt: 1,
          durationMs: 100,
          retryScheduled: false,
          providerTurns: 1,
          toolCalls: 3,
          inputTokens: 650,
          outputTokens: 90,
        }),
      ]),
    );
    const store = new FileRunStore(stateDirectory);
    await store.save(first);
    await store.save(second);

    await expect(read(stateDirectory)).resolves.toMatchObject({
      "compositionExecution.maxCumulativeInputTokens": 700,
      "compositionExecution.maxCumulativeOutputTokens": 90,
      "compositionExecution.maxProviderTurns": 1,
      "compositionExecution.maxToolCallsPerStep": 5,
      "compositionExecution.timeoutMs": 100,
      "retry.maxRetries": 1,
    });
  });

  it("keeps measured zero distinct from unavailable optional metrics", async () => {
    const stateDirectory = await temporaryRoot();
    const unavailable = runRecord("unavailable");
    unavailable.steps.push(inferenceStep([minimalAttempt()]));
    const store = new FileRunStore(stateDirectory);
    await store.save(unavailable);
    await expect(read(stateDirectory)).resolves.toEqual({
      "retry.maxRetries": 0,
    });

    const measured = runRecord("measured-zero");
    measured.steps.push(
      inferenceStep([
        leasedAttempt({
          attempt: 1,
          durationMs: 0,
          retryScheduled: false,
          providerTurns: 0,
          toolCalls: 0,
          inputTokens: 0,
          outputTokens: 0,
        }),
      ]),
    );
    await store.save(measured);

    await expect(read(stateDirectory)).resolves.toEqual({
      "compositionExecution.maxCumulativeInputTokens": 0,
      "compositionExecution.maxCumulativeOutputTokens": 0,
      "compositionExecution.maxProviderTurns": 0,
      "compositionExecution.maxToolCallsPerStep": 0,
      "compositionExecution.timeoutMs": 0,
      "retry.maxRetries": 0,
    });
  });

  it("tolerates additive fields and refuses invalid numeric evidence safely", async () => {
    const stateDirectory = await temporaryRoot();
    const additive = runRecord("additive");
    additive.future = { schemaVersion: 99 };
    const additiveAttempt = leasedAttempt({
      attempt: 1,
      durationMs: 5,
      retryScheduled: false,
      providerTurns: 1,
      toolCalls: 0,
      inputTokens: 2,
      outputTokens: 3,
    });
    additiveAttempt.futureMetric = "ignored";
    additive.steps.push(inferenceStep([additiveAttempt]));
    await new FileRunStore(stateDirectory).save(additive as unknown as RunRecord);
    await expect(read(stateDirectory)).resolves.toMatchObject({
      "compositionExecution.maxCumulativeInputTokens": 2,
    });

    const invalid = runRecord("invalid");
    const invalidAttempt = leasedAttempt({
      attempt: 1,
      durationMs: 0,
      retryScheduled: false,
      providerTurns: 0,
      toolCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
    });
    invalidAttempt.usage = { input: -1, output: 0, turns: 0 };
    invalid.steps.push(inferenceStep([invalidAttempt]));
    await new FileRunStore(stateDirectory).save(invalid as unknown as RunRecord);

    const invalidPath = join(stateDirectory, "invalid.json");
    await expect(read(stateDirectory)).rejects.toMatchObject<Partial<LimitObservationError>>({
      name: "LimitObservationError",
      code: "invalid-record",
      path: invalidPath,
      message: `Run limit observations failed (invalid-record) at ${invalidPath}.`,
    });
  });

  it("observes lease tokens after the real Pi harness replays a blank provider turn", {
    timeout: testTimeoutMs(30_000),
  }, async () => {
    const repositoryPath = await createRepository();
    vi.stubGlobal("fetch", scriptedProvider([blankTurn(), textTurn("The review is complete.")]));
    const harness = await createInstantReplayAuditHarness();
    const produced = await executeInferenceStep({
      mode: "read-only",
      policy: parseRetryPolicy({}),
      execute: () => harness.runStep(stepInput(repositoryPath)),
    });
    const attempt = produced.evidence.attempts[0]!;
    // The lease charges the discarded blank turn; Pi's session totals do not.
    expect(attempt.executionLease?.cumulativeInputTokens).toBe(710);
    expect(attempt.usage?.input).toBe(10);
    const record = runRecord("replayed-blank-turn");
    record.steps.push({
      id: "observe",
      title: "Observe",
      skill: "observe",
      mode: "read-only",
      status: produced.status,
      inference: produced.evidence,
    });
    const stateDirectory = await temporaryRoot();
    await new FileRunStore(stateDirectory).save(record);

    await expect(read(stateDirectory)).resolves.toMatchObject({
      "compositionExecution.maxCumulativeInputTokens": 710,
      "compositionExecution.maxCumulativeOutputTokens":
        attempt.executionLease!.cumulativeOutputTokens,
      "compositionExecution.maxProviderTurns": 1,
      "retry.maxRetries": 0,
    });
  });

  it("reports a hand-corrupted lease as invalid-record at its record path", async () => {
    const stateDirectory = await temporaryRoot();
    await new FileRunStore(stateDirectory).save(observedRecord("corrupted-lease", 5));
    const recordPath = join(stateDirectory, "corrupted-lease.json");
    const stored = JSON.parse(await readFile(recordPath, "utf8")) as {
      steps: { inference: { attempts: { executionLease: { cumulativeInputTokens: number } }[] } }[];
    };
    stored.steps[0]!.inference.attempts[0]!.executionLease.cumulativeInputTokens += 1;
    await writeFile(recordPath, JSON.stringify(stored));

    await expect(read(stateDirectory)).rejects.toMatchObject<Partial<LimitObservationError>>({
      code: "invalid-record",
      path: recordPath,
      message: `Run limit observations failed (invalid-record) at ${recordPath}.`,
    });
    await expect(
      projectRunLimitObservations({ stateDirectory, recordId: "corrupted-lease" }),
    ).rejects.toMatchObject({ code: "invalid-record", path: recordPath });
  });

  it("names a hosted observation file that is not valid JSON", async () => {
    const root = await temporaryRoot();
    const environment = { DOCSFAB_STATE_DIR: join(root, "runs") };
    await persistHostedLimitObservations({
      observations: { "retry.maxRetries": 0 },
      projectId: "project-corrupted",
      environment,
    });
    const hostedFile = join(
      resolveHostedLimitObservationsDirectory(environment),
      "project-corrupted.json",
    );
    await writeFile(hostedFile, "{ not json");

    await expect(readRunLimitObservations({ environment })).rejects.toMatchObject({
      code: "invalid-record",
      path: hostedFile,
      message: `Run limit observations failed (invalid-record) at ${hostedFile}.`,
    });
  });

  it.each([
    {
      label: "usage input above its lease",
      edit: (attempt: LeasedAttemptValue) => {
        attempt.usage.input += 5_000;
      },
    },
    {
      label: "usage output above its lease",
      edit: (attempt: LeasedAttemptValue) => {
        attempt.usage.output += 5_000;
      },
    },
    {
      label: "a resealed lease below its usage",
      edit: (attempt: LeasedAttemptValue) => {
        attempt.executionLease = resealedLease(attempt.executionLease, {
          cumulativeInputTokens: 1,
        });
      },
    },
  ])("refuses $label as invalid-record at its record path", async ({ edit }) => {
    const stateDirectory = await temporaryRoot();
    const recordPath = await savedLeasedRecord(stateDirectory, "usage-above-lease", edit);

    await expect(read(stateDirectory)).rejects.toMatchObject({
      code: "invalid-record",
      path: recordPath,
      message: `Run limit observations failed (invalid-record) at ${recordPath}.`,
    });
  });

  it("reads tokens from a resealed lease that exceeds its usage, as a replay leaves it", async () => {
    const stateDirectory = await temporaryRoot();
    await savedLeasedRecord(stateDirectory, "lease-above-usage", (attempt) => {
      attempt.executionLease = resealedLease(attempt.executionLease, {
        cumulativeInputTokens: 9_000,
        cumulativeOutputTokens: 700,
      });
    });

    await expect(read(stateDirectory)).resolves.toMatchObject({
      "compositionExecution.maxCumulativeInputTokens": 9_000,
      "compositionExecution.maxCumulativeOutputTokens": 700,
    });
  });

  it("refuses a negative-zero lease integer as invalid-record, not internal-error", async () => {
    const stateDirectory = await temporaryRoot();
    const recordPath = await savedLeasedRecord(stateDirectory, "negative-zero-lease", () => {});
    const text = await readFile(recordPath, "utf8");
    const field = /("checkpointProviderTurns": )0\b/gu;
    expect(text.match(field)).toHaveLength(1);
    await writeFile(recordPath, text.replace(field, "$1-0"));

    await expect(read(stateDirectory)).rejects.toMatchObject({
      code: "invalid-record",
      path: recordPath,
      message: `Run limit observations failed (invalid-record) at ${recordPath}.`,
    });
  });

  it("gives a rejection that names no file a next action that names none", async () => {
    const root = await temporaryRoot();
    const failure = await persistHostedLimitObservations({
      observations: { "compositionExecution.timeoutMs": -1 },
      projectId: "project-unnamed",
      environment: { DOCSFAB_STATE_DIR: join(root, "runs") },
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toMatchObject({
      code: "invalid-record",
      path: undefined,
      message: "Run limit observations failed (invalid-record).",
      nextAction: "Correct the limit observations that break their contract, then retry.",
    });
  });

  it("uses the explicit and host-configured state directories", async () => {
    const root = await temporaryRoot();
    const explicitState = join(root, "explicit-runs");
    const hostState = join(root, "host-runs");
    const configRoot = join(root, "config");
    await new FileRunStore(explicitState).save(observedRecord("explicit", 11));
    await new FileRunStore(hostState).save(observedRecord("host", 22));
    await mkdir(configRoot, { mode: 0o700 });
    await writeFile(
      join(configRoot, "host.yaml"),
      [
        "schemaVersion: 1",
        "kind: docsfab-host-config",
        "compositionId: test-composition",
        "paths:",
        `  stateDir: ${hostState}`,
        "",
      ].join("\n"),
      "utf8",
    );

    await expect(
      readRunLimitObservations({ environment: { DOCSFAB_STATE_DIR: explicitState } }),
    ).resolves.toMatchObject({ "compositionExecution.timeoutMs": 11 });
    await expect(
      readRunLimitObservations({ environment: { DOCSFAB_CONFIG_ROOT: configRoot } }),
    ).resolves.toMatchObject({ "compositionExecution.timeoutMs": 22 });
  });

  it("preserves the explicit observations-file compatibility override", async () => {
    const root = await temporaryRoot();
    const compatibilityFile = join(root, "observed.json");
    await writeFile(
      compatibilityFile,
      JSON.stringify({
        "compositionExecution.timeoutMs": 33,
        "recovery.headroomWarnRatio": 0.75,
        "retry.maxRetries": 2,
      }),
      "utf8",
    );

    await expect(
      readRunLimitObservations({
        cwd: root,
        environment: { DOCSFAB_LIMITS_OBSERVED_FILE: "observed.json" },
      }),
    ).resolves.toEqual({
      "compositionExecution.timeoutMs": 33,
      "recovery.headroomWarnRatio": 0.75,
      "retry.maxRetries": 2,
    });
  });

  it("refuses unsafe compatibility observations and a missing explicit file", async () => {
    const root = await temporaryRoot();
    const compatibilityFile = join(root, "observed.json");
    for (const observed of [-1, 1.5]) {
      await writeFile(
        compatibilityFile,
        JSON.stringify({ "compositionExecution.maxProviderTurns": observed }),
        "utf8",
      );
      await expect(
        readRunLimitObservations({
          environment: { DOCSFAB_LIMITS_OBSERVED_FILE: compatibilityFile },
        }),
      ).rejects.toMatchObject({
        name: "LimitObservationError",
        code: "invalid-record",
        path: compatibilityFile,
        message: `Run limit observations failed (invalid-record) at ${compatibilityFile}.`,
      });
    }

    await expect(
      readRunLimitObservations({
        environment: { DOCSFAB_LIMITS_OBSERVED_FILE: join(root, "missing.json") },
      }),
    ).rejects.toMatchObject({
      name: "LimitObservationError",
      code: "read-failed",
      message: "Run limit observations failed (read-failed).",
    });
  });

  it("ignores real store temporaries and refuses symlink evidence", async () => {
    const stateDirectory = await temporaryRoot();
    await new FileRunStore(stateDirectory).save(observedRecord("original", 7));
    await writeFile(join(stateDirectory, ".original.interrupted.tmp"), "partial", {
      mode: 0o600,
    });
    await expect(read(stateDirectory)).resolves.toMatchObject({
      "compositionExecution.timeoutMs": 7,
    });

    await symlink(join(stateDirectory, "original.json"), join(stateDirectory, "linked.json"));
    await expect(read(stateDirectory)).rejects.toMatchObject({
      name: "LimitObservationError",
      code: "unsafe-store",
      message: "Run limit observations failed (unsafe-store).",
    });
  });

  it("projects records beside each owned private state namespace", async () => {
    const stateDirectory = await temporaryRoot();
    await new FileRunStore(stateDirectory).save(observedRecord("reviewed", 7));
    for (const name of [
      "artifacts",
      "delegated-tasks",
      "input-ask-supersession",
      "native-inputs",
      "reports",
      "study",
    ]) {
      await mkdir(join(stateDirectory, name), { mode: 0o700 });
      await expect(read(stateDirectory)).resolves.toMatchObject({
        "compositionExecution.timeoutMs": 7,
      });
    }
  });

  it.each(["reports", "study", "artifacts"])(
    "refuses a %s namespace with a symlink, file, or permissive mode",
    async (name) => {
      const stateDirectory = await temporaryRoot();
      await new FileRunStore(stateDirectory).save(observedRecord("reviewed", 7));
      const path = join(stateDirectory, name);
      await symlink(stateDirectory, path);
      await expect(read(stateDirectory)).rejects.toMatchObject({ code: "unsafe-store" });

      const fileRoot = await temporaryRoot();
      await new FileRunStore(fileRoot).save(observedRecord("reviewed", 7));
      await writeFile(join(fileRoot, name), "not a namespace", { mode: 0o600 });
      await expect(read(fileRoot)).rejects.toMatchObject({ code: "unsafe-store" });

      const permissiveRoot = await temporaryRoot();
      await new FileRunStore(permissiveRoot).save(observedRecord("reviewed", 7));
      const permissivePath = join(permissiveRoot, name);
      await mkdir(permissivePath, { mode: 0o700 });
      await chmod(permissivePath, 0o750);
      await expect(read(permissiveRoot)).rejects.toMatchObject({ code: "unsafe-store" });
      expect((await lstat(permissivePath)).mode & 0o777).toBe(0o750);
    },
  );

  it("refuses an unowned namespace name", async () => {
    const stateDirectory = await temporaryRoot();
    await new FileRunStore(stateDirectory).save(observedRecord("reviewed", 7));
    await mkdir(join(stateDirectory, "unexpected"), { mode: 0o700 });
    await expect(read(stateDirectory)).rejects.toMatchObject({ code: "unsafe-store" });
  });

  it("persists hosted observations without creating the local run store", async () => {
    const root = await temporaryRoot();
    const serviceHome = join(root, "service-home");
    await mkdir(serviceHome, { mode: 0o700 });
    const environment = {
      HOME: serviceHome,
      XDG_CONFIG_HOME: join(serviceHome, ".config"),
    };
    const timeout = configuredTimeoutMs();

    await persistHostedLimitObservations({
      observations: { "compositionExecution.timeoutMs": timeout },
      projectId: "project-hosted",
      environment,
    });
    await persistHostedLimitObservations({
      observations: { "compositionExecution.timeoutMs": timeout + 1, "retry.maxRetries": 0 },
      projectId: "project-hosted",
      environment,
    });

    await expect(readRunLimitObservations({ environment })).resolves.toEqual({
      "compositionExecution.timeoutMs": timeout + 1,
      "retry.maxRetries": 0,
    });
    await expect(
      lstat(join(serviceHome, ".config", "docsfab", ".docsfab", "runs")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    const hosted = resolveHostedLimitObservationsDirectory(environment);
    expect((await lstat(hosted)).mode & 0o777).toBe(0o700);
    expect((await lstat(join(hosted, "project-hosted.json"))).mode & 0o777).toBe(0o600);
  });

  it("keeps hosted measured zero distinct from a missing hosted store", async () => {
    const root = await temporaryRoot();
    const missing = {
      HOME: join(root, "missing-home"),
      XDG_CONFIG_HOME: join(root, "missing-config"),
    };
    await expect(readRunLimitObservations({ environment: missing })).resolves.toEqual({});

    const environment = { DOCSFAB_STATE_DIR: join(root, "runs") };
    await persistHostedLimitObservations({
      observations: {
        "compositionExecution.timeoutMs": 0,
        "compositionExecution.maxProviderTurns": 0,
        "retry.maxRetries": 0,
      },
      projectId: "project-zero",
      environment,
    });
    await expect(readRunLimitObservations({ environment })).resolves.toEqual({
      "compositionExecution.timeoutMs": 0,
      "compositionExecution.maxProviderTurns": 0,
      "retry.maxRetries": 0,
    });
  });

  it("projects one hosted attempt record beside private attempt files", async () => {
    const stateDirectory = await temporaryRoot();
    await mkdir(join(stateDirectory, "artifacts"), { mode: 0o700 });
    await new FileRunStore(stateDirectory).save(observedRecord("run-hosted", 0));

    await expect(
      projectRunLimitObservations({ stateDirectory, recordId: "run-hosted" }),
    ).resolves.toMatchObject({
      "compositionExecution.timeoutMs": 0,
      "retry.maxRetries": 0,
    });
    await expect(
      projectRunLimitObservations({
        stateDirectory,
        recordId: "missing-run",
      }),
    ).resolves.toEqual({});
  });

  it("merges hosted maxima with local records and preserves the compatibility file", async () => {
    const root = await temporaryRoot();
    const stateDirectory = join(root, "runs");
    const environment = { DOCSFAB_STATE_DIR: stateDirectory };
    await new FileRunStore(stateDirectory).save(observedRecord("local", 11));
    await persistHostedLimitObservations({
      observations: { "compositionExecution.timeoutMs": 40 },
      projectId: "project-a",
      environment,
    });
    await persistHostedLimitObservations({
      observations: { "compositionExecution.timeoutMs": 22, "retry.maxRetries": 0 },
      projectId: "project-b",
      environment,
    });

    await expect(readRunLimitObservations({ environment })).resolves.toMatchObject({
      "compositionExecution.timeoutMs": 40,
      "retry.maxRetries": 0,
    });

    const compatibilityFile = join(root, "observed.json");
    await writeFile(
      compatibilityFile,
      JSON.stringify({ "compositionExecution.timeoutMs": 33 }),
      "utf8",
    );
    await expect(
      readRunLimitObservations({
        environment: { ...environment, DOCSFAB_LIMITS_OBSERVED_FILE: compatibilityFile },
      }),
    ).resolves.toEqual({ "compositionExecution.timeoutMs": 33 });
  });
});

function temporaryRoot(): Promise<string> {
  return roots.create("docsfab-limit-observations-", { mode: 0o700 });
}

function read(stateDirectory: string): Promise<Readonly<Record<string, number>>> {
  return readRunLimitObservations({ environment: { DOCSFAB_STATE_DIR: stateDirectory } });
}

function configuredTimeoutMs(): number {
  return limit("compositionExecution.timeoutMs", { environment: { NODE_TEST_CONTEXT: "true" } })
    .value;
}

function runRecord(id: string): RunRecord & Record<string, unknown> {
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
    steps: [],
  };
}

function inferenceStep(attempts: Array<Record<string, unknown>>): RunRecord["steps"][number] {
  const backoffs = attempts
    .map((attempt) => attempt.backoffMs)
    .filter((value): value is number => typeof value === "number");
  const baseDelayMs = backoffs[0] ?? 0;
  return {
    id: "observe",
    title: "Observe",
    skill: "observe",
    mode: "read-only",
    status: "succeeded",
    inference: {
      configuredMaxRetries: attempts.length - 1,
      effectiveMaxRetries: attempts.length - 1,
      baseDelayMs,
      maxDelayMs: backoffs.length === 0 ? 0 : Math.max(...backoffs),
      retryableCategories: backoffs.length === 0 ? [] : ["provider-transient"],
      replay: "read-only",
      attempts,
    },
  } as RunRecord["steps"][number];
}

function minimalAttempt(): Record<string, unknown> {
  return {
    attempt: 1,
    outcome: "provider-terminal",
    retryable: false,
    retryScheduled: false,
    durationMs: 0,
  };
}

function attempt(input: {
  attempt: number;
  durationMs: number;
  retryScheduled: boolean;
  backoffMs?: number;
  providerTurns: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
}): Record<string, unknown> {
  return {
    attempt: input.attempt,
    outcome: input.retryScheduled ? "provider-transient" : "succeeded",
    retryable: input.retryScheduled,
    retryScheduled: input.retryScheduled,
    durationMs: input.durationMs,
    ...(input.backoffMs === undefined ? {} : { backoffMs: input.backoffMs }),
    usage: {
      input: input.inputTokens,
      output: input.outputTokens,
      cacheRead: 0,
      cacheWrite: 0,
      total: input.inputTokens + input.outputTokens,
      turns: input.providerTurns,
    },
    tools: { totalCalls: input.toolCalls, failedCalls: 0, byTool: [] },
  };
}

function leasedAttempt(input: {
  attempt: number;
  durationMs: number;
  retryScheduled: boolean;
  backoffMs?: number;
  providerTurns: 0 | 1;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
}): Record<string, unknown> {
  const result = attempt(input);
  result.executionLease = leaseEvidence(input);
  return result;
}

function leaseEvidence(input: {
  attempt: number;
  retryScheduled: boolean;
  providerTurns: 0 | 1;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
}) {
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
      inferenceAttempt: input.attempt,
      retriesConsumed: input.attempt - 1,
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

  if (input.providerTurns === 1) {
    const calls = Array.from({ length: input.toolCalls }, (_, index) => {
      const callSha256 = digestPiToolCall(`call-${String(index)}`, "read", index);
      return { callSha256, authorization: "execute" as const };
    });
    const usage = {
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      elapsedMs: 1,
      compactions: 0,
      context,
    };
    if (calls.length > 0) {
      subject.requestToolBatch(calls, {
        kind: "ordinary",
        toolCalls: calls.length,
        providerTurns: 1,
        compactions: 0,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        elapsedMs: 1,
        contextInputTokens: 1,
      });
      subject.settleToolBatch(
        calls.map((call) => ({ callSha256: call.callSha256, outcome: "succeeded" as const })),
        usage,
      );
    } else {
      subject.preflightProviderTurn({
        kind: "ordinary",
        toolCalls: 0,
        providerTurns: 1,
        compactions: 0,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        elapsedMs: 1,
        contextInputTokens: 1,
      });
      subject.settleOrdinaryProviderTurn(usage);
    }
  }
  if (input.retryScheduled) subject.stop("provider-unavailable", "provider-failed");
  else subject.complete();
  return subject.evidence({
    inferenceAttempt: input.attempt,
    retriesConsumed: input.attempt - 1,
    repositoryRevision: "a".repeat(40),
    providerTurnLedgerSha256: "6".repeat(64),
    usageSha256: "7".repeat(64),
    toolsSha256: "8".repeat(64),
  });
}

function sequentialClock(values: readonly number[]): () => number {
  let index = 0;
  return () => values[index++]!;
}

function observedRecord(id: string, durationMs: number): RunRecord {
  const record = runRecord(id);
  record.steps.push(
    inferenceStep([
      leasedAttempt({
        attempt: 1,
        durationMs,
        retryScheduled: false,
        providerTurns: 1,
        toolCalls: 0,
        inputTokens: 1,
        outputTokens: 1,
      }),
    ]),
  );
  return record;
}

interface LeasedAttemptValue {
  usage: { input: number; output: number };
  executionLease: Record<string, unknown>;
}

/** Save one leased record, edit its attempt as stored, and return the record path. */
async function savedLeasedRecord(
  stateDirectory: string,
  id: string,
  edit: (attempt: LeasedAttemptValue) => void,
): Promise<string> {
  const record = runRecord(id);
  record.steps.push(
    inferenceStep([
      leasedAttempt({
        attempt: 1,
        durationMs: 21,
        retryScheduled: false,
        providerTurns: 1,
        toolCalls: 0,
        inputTokens: 4_000,
        outputTokens: 300,
      }),
    ]),
  );
  await new FileRunStore(stateDirectory).save(record);
  const recordPath = join(stateDirectory, `${id}.json`);
  const stored = JSON.parse(await readFile(recordPath, "utf8")) as {
    steps: { inference: { attempts: LeasedAttemptValue[] } }[];
  };
  edit(stored.steps[0]!.inference.attempts[0]!);
  await writeFile(recordPath, `${JSON.stringify(stored, null, 2)}\n`);
  return recordPath;
}

/** The lease with `changes` applied and its own digest recomputed, as a forger would. */
function resealedLease(
  lease: Record<string, unknown>,
  changes: Record<string, number>,
): Record<string, unknown> {
  const { evidenceSha256: _previous, ...body } = { ...lease, ...changes };
  const evidenceSha256 = createHash("sha256")
    .update(canonicalizeJsonEvidence(body as JsonEvidenceValue))
    .digest("hex");
  return { ...body, evidenceSha256 };
}
