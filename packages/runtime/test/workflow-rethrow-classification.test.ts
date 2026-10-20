// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * A run that throws outside every step catch after a step finished reaches the
 * operator as its saved failed record, with the record's own failure, on the
 * CLI (`docsfab run`, `docsfab do`) and on the host (`hostInvokerMain`).
 *
 * Every cell drives the shipped entry point with the real PiHarness over a
 * scripted provider and the real `FileRunStore`. Only two seams are
 * substituted: the CLI's `loadConfig` (the test's model endpoint and state
 * directory) and one `FileRunStore.save` call, which fails at the moment the
 * cell names. No other throw between steps is reachable from scripted model
 * output or fixture repository state on this revision, so the failing save
 * is the trigger; `settleThrownWorkflowRun` is the code under test.
 *
 * A thrown CLI failure is reported the way `src/cli.ts` reports it: the real
 * `reportOperatorFailure` with `--json`, read back as parsed JSON.
 */
import { read, fstatSync, type Stats } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DocsFabConfig } from "../src/config/runtime-loader.js";
import { main } from "../src/cli/router.js";
import { PiHarness } from "../src/harness/pi.js";
import {
  parseHostRuntimeRequest,
  sealHostRuntimeComposition,
} from "../src/host-invoker/contracts.js";
import { hostInvokerMain } from "../src/host-invoker/main.js";
import { parseHostRuntimeTerminal } from "../src/host-invoker/terminal.js";
import type { FailureClassificationV1 } from "../src/operator/failure-class.js";
import { readRunFailure } from "../src/operator/failure-classification.js";
import { reportOperatorFailure } from "../src/operator/error-envelope.js";
import { formatRunFailureDiagnosticLines } from "../src/operator/run-summary.js";
import type { RunRecord } from "../src/records/contracts.js";
import { FileRunStore, FileRunStoreError } from "../src/records/file-store.js";
import { CompositionExecutionEvidenceError } from "../src/records/composition-execution.js";
import { validModelConfig } from "./helpers.js";
import {
  createFixtureRepository,
  hostedReadinessRequest,
  removeFixture,
  runtimeConfig,
  scriptedProvider,
  textTurn,
} from "./support/execution-convergence.js";

const cliConfig = vi.hoisted(() => ({ current: undefined as DocsFabConfig | undefined }));

vi.mock("../src/config/runtime-loader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/config/runtime-loader.js")>();
  return {
    ...actual,
    loadConfig: (...args: Parameters<typeof actual.loadConfig>) =>
      cliConfig.current ?? actual.loadConfig(...args),
  };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, read: vi.fn(actual.read), fstatSync: vi.fn(actual.fstatSync) };
});

// Each cell runs a real Git fixture, a real context compile and the real Pi
// adapter; the budget is execution plumbing, not an operational bound.
vi.setConfig({ testTimeout: 120_000 });

const roots: string[] = [];
const argv = process.argv;

beforeEach(() => {
  process.exitCode = undefined;
});

afterEach(async () => {
  vi.restoreAllMocks();
  saveFailures.length = 0;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  cliConfig.current = undefined;
  process.argv = argv;
  process.exitCode = undefined;
  await Promise.all(roots.splice(0).map((root) => removeFixture(root)));
});

type Fixture = Awaited<ReturnType<typeof createFixtureRepository>>;

async function fixture(): Promise<Fixture> {
  const created = await createFixtureRepository("documented");
  roots.push(created.root);
  return created;
}

/** When the failing save fires, read from the record being saved. */
const AFTER_FIRST_STEP = (record: RunRecord): boolean =>
  record.status === "running" &&
  record.steps[0]?.status === "succeeded" &&
  record.steps.slice(1).every((step) => step.status === "pending");
const WHILE_FIRST_STEP_RUNS = (record: RunRecord): boolean =>
  record.status === "running" && record.steps[0]?.status === "running";

interface SaveFailure {
  readonly when: (record: RunRecord) => boolean;
  readonly failure: () => unknown;
  fired: boolean;
}
const saveFailures: SaveFailure[] = [];

/**
 * Fail exactly one `FileRunStore.save`: the first, after earlier rules fired
 * or not, whose record matches `when`. Every other save is the real one.
 */
function failOneSave(when: (record: RunRecord) => boolean, failure: () => unknown): () => boolean {
  const rule: SaveFailure = { when, failure, fired: false };
  saveFailures.push(rule);
  if (!vi.isMockFunction(FileRunStore.prototype.save)) {
    const save = FileRunStore.prototype.save;
    vi.spyOn(FileRunStore.prototype, "save").mockImplementation(async function (
      this: FileRunStore,
      record: RunRecord,
    ) {
      const next = saveFailures.find((candidate) => !candidate.fired && candidate.when(record));
      if (next) {
        next.fired = true;
        throw next.failure();
      }
      return save.call(this, record);
    });
  }
  return () => rule.fired;
}

interface CliOutcome {
  /** Parsed stdout JSON documents, in order. */
  readonly stdout: unknown[];
  /** The operator envelope `src/cli.ts` would print, when `main()` threw. */
  readonly envelope: Record<string, unknown> | undefined;
  readonly exitCode: number | undefined;
}

/** `docsfab <argv>` in process, reported exactly as `src/cli.ts` reports a throw. */
async function runCli(args: readonly string[], stateDirectory: string): Promise<CliOutcome> {
  cliConfig.current = runtimeConfig(stateDirectory);
  const logged: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...items: unknown[]) => {
    logged.push(items.map(String).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  process.argv = [argv[0]!, "docsfab", ...args];
  let envelope: Record<string, unknown> | undefined;
  try {
    await main();
  } catch (error) {
    reportOperatorFailure(error, {
      json: true,
      write: (line) => {
        envelope = JSON.parse(line) as Record<string, unknown>;
      },
    });
    process.exitCode = 1;
  }
  const stdout = logged.flatMap((line) => {
    try {
      return [JSON.parse(line) as unknown];
    } catch {
      return [];
    }
  });
  return { stdout, envelope, exitCode: process.exitCode as number | undefined };
}

async function persistedRecord(stateDirectory: string): Promise<RunRecord> {
  const names = (await readdir(stateDirectory)).filter(
    (name) => name.endsWith(".json") && !name.startsWith("."),
  );
  expect(names).toHaveLength(1);
  return JSON.parse(await readFile(join(stateDirectory, names[0]!), "utf8")) as RunRecord;
}

interface RunResultJson {
  readonly kind: string;
  readonly execution: { readonly status: string; readonly exitCode: number };
  readonly failures?: ReadonlyArray<FailureClassificationV1 & { readonly scope: string }>;
}

function runResult(outcome: CliOutcome): RunResultJson {
  const results = outcome.stdout.filter(
    (item): item is RunResultJson =>
      typeof item === "object" &&
      item !== null &&
      (item as RunResultJson).kind === "docsfab-run-result",
  );
  expect(results).toHaveLength(1);
  return results[0]!;
}

function runFailureOf(result: RunResultJson): FailureClassificationV1 | undefined {
  const run = result.failures?.find((failure) => failure.scope === "run");
  if (!run) return undefined;
  const { scope: _scope, ...failure } = run;
  return failure;
}

/** The hosted route the scripted provider stands in for. */
const HOSTED_ROUTE = "openai-direct";

/** The review run's first step answers in one text turn. */
const AUDIT_TURN = (): Response => textTurn("Deterministic audit evidence.");

describe("a throw after a finished step reaches the CLI as the saved failed record", () => {
  it.each([
    {
      name: "an uncoded failure",
      failure: () => new Error("unrecognized record store failure"),
      expected: { class: "unknown", layer: "workflow", code: "uncoded-error" },
    },
    {
      // The refusal the terminal composition seal throws.
      name: "a coded failure",
      failure: () => new CompositionExecutionEvidenceError("subject-mismatch"),
      expected: { class: "contract-shape", layer: "workflow", code: "subject-mismatch" },
    },
  ])("docsfab run prints $name from the saved record", async ({ failure, expected }) => {
    const repo = await fixture();
    vi.stubGlobal("fetch", scriptedProvider([AUDIT_TURN()]));
    const fired = failOneSave(AFTER_FIRST_STEP, failure);

    const outcome = await runCli(
      [
        "run",
        "review-documentation",
        "--repo",
        repo.repository,
        "--revision",
        "HEAD",
        "--instruction",
        "Review the committed fixture documentation.",
        "--json",
      ],
      repo.stateDirectory,
    );

    expect(fired()).toBe(true);
    expect(outcome.envelope).toBeUndefined();
    expect(outcome.exitCode).toBe(1);
    const saved = await persistedRecord(repo.stateDirectory);
    expect(saved.status).toBe("failed");
    expect(saved.steps[0]?.status).toBe("succeeded");
    expect(saved.steps.slice(1).every((step) => step.status === "pending")).toBe(true);
    expect(readRunFailure(saved)).toEqual(expected);
    expect(formatRunFailureDiagnosticLines(saved)).toContain(
      `Failure class: ${expected.class} (layer ${expected.layer}, code ${expected.code}).`,
    );
    const result = runResult(outcome);
    expect(result.execution).toMatchObject({ status: "failed", exitCode: 1 });
    expect(runFailureOf(result)).toEqual(readRunFailure(saved));
  });

  it("docsfab do prints the saved record's failure", async () => {
    const repo = await fixture();
    vi.stubGlobal("fetch", scriptedProvider([AUDIT_TURN()]));
    const fired = failOneSave(
      AFTER_FIRST_STEP,
      () => new Error("unrecognized record store failure"),
    );

    const outcome = await runCli(
      [
        "do",
        "Review the documentation for the export behavior.",
        "--repo",
        repo.repository,
        "--revision",
        "HEAD",
        "--json",
      ],
      repo.stateDirectory,
    );

    expect(fired()).toBe(true);
    expect(outcome.envelope).toBeUndefined();
    expect(outcome.exitCode).toBe(1);
    const saved = await persistedRecord(repo.stateDirectory);
    expect(saved.workflow).toBe("review-documentation");
    expect(readRunFailure(saved)).toEqual({
      class: "unknown",
      layer: "workflow",
      code: "uncoded-error",
    });
    expect(runFailureOf(runResult(outcome))).toEqual(readRunFailure(saved));
  });

  // Adjacent: the classified path handles only "a step finished and none is
  // running". A throw while the first step still runs keeps the bare rethrow:
  // the envelope stays `operator-error` and the saved record is not rewritten.
  it("a throw while the first step runs keeps the operator-error envelope and the running record", async () => {
    const repo = await fixture();
    vi.stubGlobal("fetch", scriptedProvider([]));
    const fired = failOneSave(
      WHILE_FIRST_STEP_RUNS,
      () => new Error("unrecognized record store failure"),
    );

    const outcome = await runCli(
      ["run", "review-documentation", "--repo", repo.repository, "--revision", "HEAD", "--json"],
      repo.stateDirectory,
    );

    expect(fired()).toBe(true);
    expect(outcome.exitCode).toBe(1);
    expect(
      outcome.stdout.some((item) => (item as RunResultJson).kind === "docsfab-run-result"),
    ).toBe(false);
    expect(outcome.envelope).toMatchObject({
      code: "operator-error",
      failure: { class: "unknown", layer: "cli", code: "operator-error" },
    });
    const saved = await persistedRecord(repo.stateDirectory);
    expect(saved.status).toBe("running");
    expect(saved.steps.every((step) => step.status === "pending")).toBe(true);
    expect(saved.failure).toBeUndefined();
  });

  // Adjacent: a recognized run-store failure keeps its own code on the CLI.
  it("a run-store failure after the first step keeps its run-store code", async () => {
    const repo = await fixture();
    vi.stubGlobal("fetch", scriptedProvider([AUDIT_TURN()]));
    const fired = failOneSave(AFTER_FIRST_STEP, () => new FileRunStoreError("write-failed"));

    const outcome = await runCli(
      ["run", "review-documentation", "--repo", repo.repository, "--revision", "HEAD", "--json"],
      repo.stateDirectory,
    );

    expect(fired()).toBe(true);
    expect(outcome.exitCode).toBe(1);
    expect(outcome.envelope).toMatchObject({
      code: "run-store-write-failed",
      failure: { code: "run-store-write-failed" },
    });
    const saved = await persistedRecord(repo.stateDirectory);
    expect(saved.status).toBe("failed");
    expect(readRunFailure(saved)).toEqual({
      class: "infrastructure",
      layer: "workflow",
      code: "run-store-write-failed",
    });
  });

  // Adjacent: a run whose step already failed keeps that step's failure; the
  // throw that follows is not the run's first cause.
  it("a throw after a step failed keeps the step's failure", async () => {
    const repo = await fixture();
    // A provider with no scripted turn fails the first step at once.
    vi.stubEnv("DOCSFAB_READ_ONLY_MAX_RETRIES", "0");
    vi.stubEnv("DOCSFAB_READ_ONLY_MAX_TRANSPORT_RETRIES", "0");
    vi.stubGlobal("fetch", scriptedProvider([]));
    const fired = failOneSave(
      (record) => record.steps[0]?.status === "failed",
      () => new Error("unrecognized record store failure"),
    );

    const outcome = await runCli(
      ["run", "review-documentation", "--repo", repo.repository, "--revision", "HEAD", "--json"],
      repo.stateDirectory,
    );

    expect(fired()).toBe(true);
    expect(outcome.envelope).toBeUndefined();
    expect(outcome.exitCode).toBe(1);
    const saved = await persistedRecord(repo.stateDirectory);
    expect(saved.status).toBe("failed");
    expect(saved.steps[0]?.status).toBe("failed");
    const stepFailure = saved.steps[0]?.failure;
    expect(stepFailure).toBeDefined();
    expect(stepFailure?.code).not.toBe("uncoded-error");
    expect(readRunFailure(saved)).toEqual(stepFailure);
    expect(runFailureOf(runResult(outcome))).toEqual(stepFailure);
  });
});

describe("a settled record the store refuses is never reported as saved", () => {
  // Adjacent: the classified path returns a record only once it is saved. A
  // recognized store refusal of that save keeps its run-store code; an
  // unrecognized one keeps the bare rethrow.
  it.each([
    {
      name: "a recognized store code",
      failure: () => new FileRunStoreError("write-failed"),
      expected: { code: "run-store-write-failed" },
    },
    {
      name: "an unrecognized failure",
      failure: () => new Error("unrecognized record store failure"),
      expected: { code: "operator-error" },
    },
  ])("the settling save fails with $name", async ({ failure, expected }) => {
    const repo = await fixture();
    vi.stubGlobal("fetch", scriptedProvider([AUDIT_TURN()]));
    const first = failOneSave(
      AFTER_FIRST_STEP,
      () => new Error("unrecognized record store failure"),
    );
    const settling = failOneSave((record) => record.status === "failed", failure);

    const outcome = await runCli(
      ["run", "review-documentation", "--repo", repo.repository, "--revision", "HEAD", "--json"],
      repo.stateDirectory,
    );

    expect(first()).toBe(true);
    expect(settling()).toBe(true);
    expect(outcome.exitCode).toBe(1);
    expect(
      outcome.stdout.some((item) => (item as RunResultJson).kind === "docsfab-run-result"),
    ).toBe(false);
    expect(outcome.envelope).toMatchObject(expected);
    const saved = await persistedRecord(repo.stateDirectory);
    expect(saved.status).toBe("running");
  });
});

describe("a throw after a finished step reaches the host as the saved failed record", () => {
  /** One `hostInvokerMain` call over a scripted request descriptor; returns the terminal. */
  async function runHost(repo: Fixture, onStepSaved?: () => void) {
    // The hosted review's first step answers in one text turn, like the CLI
    // cells; the readiness reply would need a sealed citation contract. The
    // composition names the scripted model, so the terminal admits its record.
    const offline = hostedReadinessRequest({
      ...repo,
      workflow: "review-documentation" as "readiness",
    });
    const request = parseHostRuntimeRequest({
      ...offline,
      composition: sealHostRuntimeComposition({
        compositionId: "rethrow-classification-scripted-v1",
        route: HOSTED_ROUTE,
        credentialFamily: "openai-api",
        executionProfile: {
          routeId: HOSTED_ROUTE,
          providerId: HOSTED_ROUTE,
          baseUrl: validModelConfig.baseUrl,
          modelId: validModelConfig.modelId,
          transport: "openai-chat-completions",
          apiFormat: "chat_completions",
          profile: validModelConfig.profile,
          requestPolicy: validModelConfig.requestPolicy,
        },
        declaredTools: offline.composition.declaredTools,
      }),
    });
    // A mis-scripted provider fails the step at once instead of backing off.
    vi.stubEnv("DOCSFAB_READ_ONLY_MAX_RETRIES", "0");
    vi.stubEnv("DOCSFAB_READ_ONLY_MAX_TRANSPORT_RETRIES", "0");
    const harness = new PiHarness({
      skillCrateDirectory: join(process.cwd(), "skill-crate"),
      model: { ...validModelConfig, providerId: HOSTED_ROUTE },
    });
    const written: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((
      chunk: unknown,
      _encoding: unknown,
      callback: unknown,
    ) => {
      written.push(String(chunk));
      if (typeof callback === "function") (callback as (error?: Error | null) => void)(null);
      return true;
    }) as never);
    vi.mocked(fstatSync).mockReturnValueOnce({ isFile: () => true } as Stats);
    let delivered = false;
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    // Only the request descriptor is scripted; every other read stays real.
    vi.mocked(read).mockImplementation(((fd: number, ...rest: unknown[]) => {
      if (fd !== 3) return (actual.read as (...args: unknown[]) => void)(fd, ...rest);
      const callback = rest.at(-1) as (...args: unknown[]) => void;
      const buffer = delivered ? Buffer.alloc(0) : Buffer.from(JSON.stringify(request));
      delivered = true;
      queueMicrotask(() => callback(null, buffer.byteLength, buffer));
    }) as never);
    const signals = ["SIGTERM", "SIGINT"] as const;
    const before = new Map(signals.map((signal) => [signal, new Set(process.listeners(signal))]));
    try {
      onStepSaved?.();
      await hostInvokerMain(["--request-fd", "3"], { executionHarness: harness });
    } finally {
      for (const signal of signals)
        for (const listener of process.listeners(signal))
          if (!before.get(signal)!.has(listener)) process.removeListener(signal, listener);
    }
    const lines = written
      .join("")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { kind?: string });
    const terminals = lines.filter((line) => line.kind !== "docsfab-host-runtime-event");
    expect(terminals).toHaveLength(1);
    return parseHostRuntimeTerminal(terminals[0], request);
  }

  it("seals the saved record and its failure, not a synthetic execution failure", async () => {
    const repo = await fixture();
    vi.stubGlobal("fetch", scriptedProvider([AUDIT_TURN()]));
    const fired = failOneSave(
      AFTER_FIRST_STEP,
      () => new Error("unrecognized record store failure"),
    );

    const terminal = await runHost(repo);

    expect(fired()).toBe(true);
    expect(terminal.runRecord.runtimeRecord).not.toHaveProperty("failurePhase");
    expect(process.exitCode).toBeUndefined();
    expect(terminal.status).toBe("failed");
    const saved = await persistedRecord(repo.stateDirectory);
    expect(saved.status).toBe("failed");
    expect(saved.steps[0]?.status).toBe("succeeded");
    const sealed = terminal.runRecord.runtimeRecord as RunRecord & { code?: string };
    expect(sealed.code).toBeUndefined();
    expect(sealed.id).toBe(saved.id);
    expect(sealed.steps.map((step) => step.status)).toEqual(saved.steps.map((step) => step.status));
    expect(readRunFailure(sealed)).toEqual(readRunFailure(saved));
    expect(readRunFailure(saved)).toEqual({
      class: "unknown",
      layer: "workflow",
      code: "uncoded-error",
    });
  });

  // Adjacent: a recognized run-store failure crosses the host boundary as its
  // own code, not as the saved record.
  it("a run-store failure after the first step seals its run-store code", async () => {
    const repo = await fixture();
    vi.stubGlobal("fetch", scriptedProvider([AUDIT_TURN()]));
    const fired = failOneSave(AFTER_FIRST_STEP, () => new FileRunStoreError("write-failed"));

    const terminal = await runHost(repo);

    expect(fired()).toBe(true);
    expect(process.exitCode).toBe(1);
    expect(terminal.status).toBe("failed");
    expect(terminal.runRecord.runtimeRecord).toMatchObject({
      failurePhase: "workflow-execution",
      code: "run-store-write-failed",
    });
    const saved = await persistedRecord(repo.stateDirectory);
    expect(readRunFailure(saved)).toEqual({
      class: "infrastructure",
      layer: "workflow",
      code: "run-store-write-failed",
    });
  });

  // Adjacent: a cancellation is settled by its own branch and keeps
  // `workflow-cancelled`, not the classified store failure.
  async function cancelledHostRun() {
    const repo = await fixture();
    vi.stubGlobal("fetch", scriptedProvider([AUDIT_TURN()]));
    const fired = failOneSave(AFTER_FIRST_STEP, () => {
      // `hostInvokerMain` aborts its run on SIGTERM.
      process.emit("SIGTERM");
      return new Error("unrecognized record store failure");
    });
    const terminal = await runHost(repo);
    expect(fired()).toBe(true);
    return { terminal, saved: await persistedRecord(repo.stateDirectory) };
  }

  it("a cancellation at the same point saves workflow-cancelled", async () => {
    const { terminal, saved } = await cancelledHostRun();
    expect(terminal.status).toBe("failed");
    expect(saved.status).toBe("failed");
    expect(readRunFailure(saved)).toEqual({
      class: "cancelled",
      layer: "workflow",
      code: "workflow-cancelled",
    });
  });

  // Known failure: after a cancelled run returns, `runHostedWorkflow` re-reads
  // the workspace revision with the aborted signal and throws, so the host
  // seals `execution-failed` while the saved record says `workflow-cancelled`.
  it.fails("a cancellation at the same point seals workflow-cancelled on the host terminal (#2078)", async () => {
    const { terminal, saved } = await cancelledHostRun();
    expect(readRunFailure(terminal.runRecord.runtimeRecord as RunRecord)).toEqual(
      readRunFailure(saved),
    );
  });

  // Adjacent: a throw while the first step runs is not settled, so the host
  // keeps sealing its own `execution-failed` record. A catalogued code forged
  // on that plain Error never reaches the host boundary.
  it("a throw while the first step runs keeps the host's execution-failed record", async () => {
    const repo = await fixture();
    vi.stubGlobal("fetch", scriptedProvider([]));
    const fired = failOneSave(WHILE_FIRST_STEP_RUNS, () =>
      Object.assign(new Error("forged failure"), { code: "run-store-write-failed" }),
    );

    const terminal = await runHost(repo);

    expect(fired()).toBe(true);
    expect(process.exitCode).toBe(1);
    expect(terminal.status).toBe("failed");
    expect(terminal.runRecord.runtimeRecord).toMatchObject({
      failurePhase: "workflow-execution",
      code: "execution-failed",
    });
    const saved = await persistedRecord(repo.stateDirectory);
    expect(saved.status).toBe("running");
  });
});
