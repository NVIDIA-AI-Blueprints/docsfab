// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * A proxy that answers a governed step's model request with 403 or 407, or a
 * proxy setting refused as invalid or not turned on, ends the step with the
 * refusal's own code after one attempt, instead of a retryable provider
 * failure, and `docsfab runs show` names the catalog remediation. Every
 * provider here is a scripted `fetch` that throws the refusal the transport
 * throws, or a trap the policy reader must never reach; no request leaves
 * the host.
 */
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { handleRunsCommand } from "../src/cli/commands/runs.js";
import { parseJsonEvidence } from "../src/json-evidence.js";
import { WORKFLOW_CANCELLED } from "../src/execution/cancellation.js";
import {
  InferenceStepError,
  type HarnessStepInput,
  type InferenceRetryPolicy,
  type RunRequest,
} from "../src/execution/contracts.js";
import { PiHarness } from "../src/harness/pi.js";
import { createModelConnection, createProviderConnectionFactory } from "../src/model/provider.js";
import {
  OUTBOUND_PROXY_AUTH_REQUIRED_CODE,
  OUTBOUND_PROXY_DENIED_CODE,
  OUTBOUND_PROXY_INVALID_CODE,
  OUTBOUND_PROXY_NOT_ENABLED_CODE,
  OutboundProxyRefusal,
  resetOutboundProxyStateForTests,
  type OutboundProxyRefusalKind,
} from "../src/model/outbound-http-policy.js";
import { classifyStepFailure } from "../src/operator/failure-classification.js";
import { buildRunHumanNextCommand } from "../src/operator/run-next-action.js";
import { decodeRunResultV1 } from "../src/operator/run-result.js";
import { SITUATION_CATALOG } from "../src/operator/situation-catalog.js";
import type { RunRecord } from "../src/records/contracts.js";
import { FileRunStore } from "../src/records/file-store.js";
import type { RepositorySecurityScanner } from "../src/security/contracts.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import { executeInferenceStep } from "../src/workflow-execution/retry.js";
import { WorkflowRunner } from "../src/workflow-execution/runner.js";
import { readyContextPreflight, validModelConfig, validModelEnvironment } from "./helpers.js";
import { temporaryRoots } from "./helpers/temp.js";
import { sourceObligationObserverFixture } from "./helpers/verification.js";
import { nestedDeadlineMs, testTimeoutMs } from "./helpers/test-timeouts.js";
import {
  childEnvironment,
  PROXY_REFUSAL_CANARY,
  RUNTIME_ROOT,
  runGuardedNode,
  startProxyFixture,
  type ConnectReply,
  type ProxyFixture,
} from "./support/outbound-proxy-fixture.js";
import { fixtureCompositionExecutionProfile } from "./support/pi-harness-session-fixtures.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skillCrateDirectory = resolve(projectRoot, "skill-crate");
const SLOW = testTimeoutMs(20_000);
const OWN_PREFIX = "docsfab-proxy-step-";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

// No-growth guard: every directory this suite makes is removed after its case.
async function ownTemporaryEntries(): Promise<string[]> {
  return (await readdir(tmpdir())).filter((name) => name.startsWith(OWN_PREFIX));
}
let entriesBefore: Set<string>;
beforeAll(async () => {
  entriesBefore = new Set(await ownTemporaryEntries());
});
afterAll(async () => {
  const leaked = (await ownTemporaryEntries()).filter((name) => !entriesBefore.has(name));
  expect(leaked).toEqual([]);
});

/**
 * Lists `provider-transient` with a retry to spare, so an uncoded proxy
 * failure would show a second attempt; `provider-terminal` is not a
 * configurable retry category, so a coded one ends after the first.
 */
const policy: InferenceRetryPolicy = {
  maxRetries: 2,
  baseDelayMs: 0,
  maxDelayMs: 0,
  retryableCategories: ["provider-transient", "timeout", "throttled"],
};

const PROVIDER_HOST = new URL(validModelConfig.baseUrl).hostname;

/** The refusal the transport throws for a 403 or 407 tunnel reply, worded as it words it. */
function refusal(kind: OutboundProxyRefusalKind): OutboundProxyRefusal {
  const code = `outbound-proxy-${kind}`;
  const outcome = `(${code}). Nothing was sent to ${PROVIDER_HOST}.`;
  const message =
    kind === "denied"
      ? `The HTTPS_PROXY proxy refused to open a tunnel to ${PROVIDER_HOST} with 403 ${outcome}`
      : kind === "auth-required"
        ? `The HTTPS_PROXY proxy asked for proxy authentication with 407 before opening a tunnel to ${PROVIDER_HOST} ${outcome}`
        : `Refused or failed proxy request (${code}). Nothing was sent to ${PROVIDER_HOST}.`;
  return new OutboundProxyRefusal(kind, message, "HTTPS_PROXY");
}

/** The operator catalog row the step's failure class must come from. */
function operatorRow(code: string) {
  const row = SITUATION_CATALOG.find((item) => item.id === code && item.family === "operator");
  if (!row) throw new Error(`no operator catalog row for ${code}`);
  return row;
}

function textTurn(value: string): Response {
  const chunk = (delta: object, finish: string | null, extra: object = {}) => ({
    id: "completion-proxy-step",
    object: "chat.completion.chunk",
    created: 1,
    model: validModelConfig.modelId,
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...extra,
  });
  const body = [
    chunk({ role: "assistant", content: value }, null),
    chunk({}, "stop", { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }),
  ]
    .map((item) => `data: ${JSON.stringify(item)}\n\n`)
    .concat("data: [DONE]\n\n")
    .join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function harness(): PiHarness {
  return new PiHarness({
    skillCrateDirectory,
    model: validModelConfig,
    // Instant in-turn replay, so a replayable failure spends no wall time.
    createConnection: (model, connectionOptions) =>
      createModelConnection(
        model,
        connectionOptions
          ? { ...connectionOptions, providerTurnRetry: { baseDelayMs: 0, maxDelayMs: 0 } }
          : connectionOptions,
      ),
  });
}

async function runStep(input: HarnessStepInput, retryPolicy: InferenceRetryPolicy = policy) {
  const pi = harness();
  return executeInferenceStep({
    mode: "read-only",
    policy: retryPolicy,
    evidenceIdentity: input.evidenceIdentity,
    sleep: async () => undefined,
    execute: (attempt) =>
      pi.runStep({ ...input, inferenceAttempt: attempt, retriesConsumed: attempt - 1 }),
  });
}

async function createRepository(): Promise<string> {
  const repositoryPath = await mkdtemp(join(tmpdir(), OWN_PREFIX));
  temporaryDirectories.push(repositoryPath);
  await writeFile(join(repositoryPath, "README.md"), "# Fixture\n");
  return repositoryPath;
}

function stepInput(repositoryPath: string, signal?: AbortSignal): HarnessStepInput {
  const workflow = getWorkflow("review-documentation");
  return {
    runId: "proxy-step-run",
    repositoryPath,
    workflow,
    step: workflow.steps[0]!,
    evidenceIdentity: { repositoryRevision: "a".repeat(40) },
    ...(signal ? { signal } : {}),
  };
}

function classify(execution: Awaited<ReturnType<typeof runStep>>) {
  if (execution.status !== "failed") throw new Error("expected a failed step");
  return classifyStepFailure({
    error: execution.error,
    step: { inference: execution.evidence },
    cancelled: false,
  });
}

/** How a transport fault the text rule reads as a network error is classified. */
const NETWORK_FAULT = { class: "infrastructure", layer: "inference", code: "provider-network" };

const CODED = [
  ["denied", OUTBOUND_PROXY_DENIED_CODE],
  ["auth-required", OUTBOUND_PROXY_AUTH_REQUIRED_CODE],
  ["invalid", OUTBOUND_PROXY_INVALID_CODE],
  ["not-enabled", OUTBOUND_PROXY_NOT_ENABLED_CODE],
] as const;

/**
 * The readiness check `runs show` names per code: a refused setting is read
 * offline by doctor; a proxy's 403 or 407 shows only on a live request.
 */
const READINESS_CHECK: Record<(typeof CODED)[number][1], string> = {
  [OUTBOUND_PROXY_DENIED_CODE]: "docsfab doctor --live",
  [OUTBOUND_PROXY_AUTH_REQUIRED_CODE]: "docsfab doctor --live",
  [OUTBOUND_PROXY_INVALID_CODE]: "docsfab doctor",
  [OUTBOUND_PROXY_NOT_ENABLED_CODE]: "docsfab doctor",
};

describe("a governed step ends a proxy refusal that cannot recover with its code", () => {
  it.each(CODED)(
    "%s: one request, one attempt, coded provider-terminal, attempt evidence kept",
    async (kind, code) => {
      const repositoryPath = await createRepository();
      const thrown = refusal(kind);
      const provider = vi.fn(async () => {
        throw thrown;
      });
      vi.stubGlobal("fetch", provider);
      const execution = await runStep(stepInput(repositoryPath));

      // Never replayed in the turn, never retried as a step.
      expect(provider).toHaveBeenCalledTimes(1);
      expect(execution.status).toBe("failed");
      if (execution.status !== "failed") return;
      expect(execution.evidence.attempts).toHaveLength(1);
      const [attempt] = execution.evidence.attempts;
      expect(attempt).toMatchObject({
        outcome: "provider-terminal",
        retryable: false,
        retryScheduled: false,
      });
      // The failed attempt keeps what the harness collected for it.
      expect(attempt?.turns?.length).toBeGreaterThan(0);
      expect(attempt?.usage).toBeDefined();
      expect(attempt?.modelTelemetry).toBeDefined();
      // The refused request was never sent, so no provider answer can decide it.
      expect(attempt?.modelTelemetry?.providerError).toBeUndefined();

      expect(classify(execution)).toEqual({
        class: operatorRow(code).failureClass,
        layer: "workflow",
        code,
      });
      const error = execution.error;
      expect(error).toBeInstanceOf(InferenceStepError);
      expect(error.message).toBe(
        `Model request failed [provider-terminal; retryable=false]: ${thrown.message}`,
      );
      expect(error.message).not.toContain("Connection error");
      expect(error.message.match(new RegExp(code, "gu"))).toHaveLength(1);
      // The refusal rides as a non-enumerable cause, so no record or log copies it.
      expect(error.cause).toBe(thrown);
      expect(Object.getOwnPropertyDescriptor(error, "cause")?.enumerable).toBe(false);
      const serialized = JSON.stringify({ error, evidence: execution.evidence });
      expect(serialized).not.toContain('"variable"');
      expect(serialized).not.toContain("HTTPS_PROXY");
      expect(serialized).not.toContain(code);
    },
    SLOW,
  );

  it(
    "positive control: the same step lands when the request goes through",
    async () => {
      const repositoryPath = await createRepository();
      const provider = vi.fn(async () => textTurn("The review is complete."));
      vi.stubGlobal("fetch", provider);
      const execution = await runStep(stepInput(repositoryPath));
      expect(execution.status).toBe("succeeded");
      expect(provider).toHaveBeenCalledTimes(1);
    },
    SLOW,
  );

  it(
    "positive control: a 502 from the provider stays uncoded and keeps its step retry",
    async () => {
      const repositoryPath = await createRepository();
      const provider = vi.fn(
        async () =>
          new Response('{"error":{"message":"bad gateway"}}', {
            status: 502,
            headers: { "content-type": "application/json" },
          }),
      );
      vi.stubGlobal("fetch", provider);
      const execution = await runStep(stepInput(repositoryPath));
      expect(execution.status).toBe("failed");
      if (execution.status !== "failed") return;
      expect(execution.evidence.attempts.length).toBeGreaterThanOrEqual(2);
      expect(execution.evidence.attempts[0]).toMatchObject({
        outcome: "provider-transient",
        retryScheduled: true,
      });
      expect(classify(execution).code).not.toMatch(/^outbound-proxy-/u);
    },
    SLOW,
  );
});

describe("what the hop must not code (adjacent conditions)", () => {
  it(
    "a cancelled attempt stays the cancellation even when its last request was denied",
    async () => {
      const repositoryPath = await createRepository();
      const controller = new AbortController();
      const provider = vi.fn(async () => {
        controller.abort();
        throw refusal("denied");
      });
      vi.stubGlobal("fetch", provider);
      let thrown: unknown;
      try {
        await harness().runStep(stepInput(repositoryPath, controller.signal));
      } catch (error) {
        thrown = error;
      }
      // Observed at the harness throw: above it the retry loop replaces any
      // failure under an aborted signal.
      expect(thrown).toBeInstanceOf(InferenceStepError);
      const error = thrown as InferenceStepError;
      expect(error.message).toContain(WORKFLOW_CANCELLED);
      expect(error.message).not.toContain(OUTBOUND_PROXY_DENIED_CODE);
      expect(error.cause).toBeUndefined();
      expect(provider).toHaveBeenCalledTimes(1);
    },
    SLOW,
  );

  it(
    "an attempt its own timer ended stays a timeout even when its last request was denied",
    async () => {
      const repositoryPath = await createRepository();
      // Never answers until the timer aborts the request, then fails it with
      // the 403 refusal, so the attempt holds a timed-out flag and a denied slot.
      const provider = vi.fn(
        (_request: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            const fail = () => reject(refusal("denied"));
            if (init?.signal?.aborted) fail();
            else init?.signal?.addEventListener("abort", fail, { once: true });
          }),
      );
      vi.stubGlobal("fetch", provider);
      const attemptTimerMs = 60_000;
      const executionProfile = fixtureCompositionExecutionProfile({
        maxProviderTurns: 4,
        timeoutMs: attemptTimerMs,
        maxResponseBytes: 65_536,
      });
      const timed = new PiHarness({
        skillCrateDirectory,
        executionProfile,
        credential: { family: "nvidia-inference-api", apiKey: validModelConfig.apiKey },
        providerConnectionFactory: createProviderConnectionFactory({
          routeId: executionProfile.routeId,
          transport: executionProfile.transport,
        }),
      });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const failure = timed.runStep(stepInput(repositoryPath)).then(
        () => undefined,
        (error: unknown) => error,
      );
      let stepped = 0;
      while (provider.mock.calls.length === 0) {
        if ((stepped += 1) > attemptTimerMs) throw new Error("the request was never sent");
        await vi.advanceTimersByTimeAsync(1);
      }
      await vi.advanceTimersByTimeAsync(attemptTimerMs);
      const error = await failure;

      expect(error).toBeInstanceOf(InferenceStepError);
      expect(provider).toHaveBeenCalledTimes(1);
      expect((error as InferenceStepError).category).toBe("timeout");
      expect((error as InferenceStepError).condition).toBe("attempt-deadline");
      expect((error as InferenceStepError).cause).toBeUndefined();
    },
    SLOW,
  );

  it(
    "an attempt timer that fires while the denied turn is reported keeps the refusal's code",
    async () => {
      const repositoryPath = await createRepository();
      const provider = vi.fn(async () => {
        throw refusal("denied");
      });
      vi.stubGlobal("fetch", provider);
      const attemptTimerMs = 60_000;
      const executionProfile = fixtureCompositionExecutionProfile({
        maxProviderTurns: 4,
        timeoutMs: attemptTimerMs,
        maxResponseBytes: 65_536,
      });
      const base = createProviderConnectionFactory({
        routeId: executionProfile.routeId,
        transport: executionProfile.transport,
      });
      // The harness reads the refusal only while it reports the refused turn,
      // in the same synchronous handler that records the turn's error, after
      // the turn ended and before the prompt settles. Firing the attempt timer
      // there is the same, to every reader, as firing it just after the record:
      // the timer's flag, abort and rejection are read only once it returns.
      let timerFiredAtReport = false;
      const factory: typeof base = {
        routeId: base.routeId,
        transport: base.transport,
        async create(connectionInput, turnOptions) {
          const connection = await base.create(connectionInput, turnOptions);
          const transport = connection.providerTransport!;
          return {
            ...connection,
            providerTransport: {
              ...transport,
              lastProxyRefusal: () => {
                const recorded = transport.lastProxyRefusal();
                if (recorded && !timerFiredAtReport) {
                  timerFiredAtReport = true;
                  vi.advanceTimersByTime(attemptTimerMs);
                }
                return recorded;
              },
            },
          };
        },
      };
      const timed = new PiHarness({
        skillCrateDirectory,
        executionProfile,
        credential: { family: "nvidia-inference-api", apiKey: validModelConfig.apiKey },
        providerConnectionFactory: factory,
      });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      let settled = false;
      const failure = timed.runStep(stepInput(repositoryPath)).then(
        () => undefined,
        (error: unknown) => error,
      );
      void failure.finally(() => {
        settled = true;
      });
      let stepped = 0;
      while (!settled) {
        if ((stepped += 1) > attemptTimerMs) throw new Error("the step never settled");
        await vi.advanceTimersByTimeAsync(1);
      }
      const error = await failure;

      expect(timerFiredAtReport).toBe(true);
      expect(provider).toHaveBeenCalledTimes(1);
      expect(error).toBeInstanceOf(InferenceStepError);
      const step = error as InferenceStepError;
      expect(step.category).toBe("provider-terminal");
      expect(step.retryable).toBe(false);
      expect(step.message).toContain(OUTBOUND_PROXY_DENIED_CODE);
      // The recorded turn error is the attempt's first error, so the hop runs
      // ahead of the deadline condition and the step drops it.
      expect(step.condition).toBeUndefined();
      expect((step.cause as OutboundProxyRefusal | undefined)?.code).toBe(
        OUTBOUND_PROXY_DENIED_CODE,
      );
    },
    SLOW,
  );

  it(
    "an unrelated transport error with no refusal stays text-classified and retried",
    async () => {
      const repositoryPath = await createRepository();
      const provider = vi.fn(async () => {
        throw new TypeError("fetch failed");
      });
      vi.stubGlobal("fetch", provider);
      const execution = await runStep(stepInput(repositoryPath));
      expect(execution.status).toBe("failed");
      if (execution.status !== "failed") return;
      expect(execution.evidence.attempts.length).toBeGreaterThanOrEqual(2);
      expect(execution.evidence.attempts[0]).toMatchObject({
        outcome: "provider-transient",
        retryScheduled: true,
      });
      expect(execution.error.cause).toBeUndefined();
      expect(classify(execution)).toEqual(NETWORK_FAULT);
    },
    SLOW,
  );

  it(
    "an unreachable proxy stays a retryable transport fault after the in-turn replays",
    async () => {
      const repositoryPath = await createRepository();
      const provider = vi.fn(async () => {
        throw refusal("unreachable");
      });
      vi.stubGlobal("fetch", provider);
      const execution = await runStep(stepInput(repositoryPath));
      expect(execution.status).toBe("failed");
      if (execution.status !== "failed") return;
      // Replayed inside each turn, then retried as a step.
      expect(provider.mock.calls.length).toBeGreaterThan(execution.evidence.attempts.length);
      expect(execution.evidence.attempts.length).toBeGreaterThanOrEqual(2);
      for (const attempt of execution.evidence.attempts) {
        expect(attempt.outcome).toBe("provider-transient");
      }
      expect(execution.error.cause).toBeUndefined();
      expect(classify(execution)).toEqual(NETWORK_FAULT);
    },
    SLOW,
  );

  it(
    "an unreachable proxy replayed to an unrelated failure never reads as a proxy code",
    async () => {
      const repositoryPath = await createRepository();
      let calls = 0;
      const provider = vi.fn(async () => {
        calls += 1;
        if (calls % 2 === 1) throw refusal("unreachable");
        return new Response('{"error":{"message":"bad gateway"}}', {
          status: 502,
          headers: { "content-type": "application/json" },
        });
      });
      vi.stubGlobal("fetch", provider);
      const execution = await runStep(stepInput(repositoryPath));
      expect(execution.status).toBe("failed");
      if (execution.status !== "failed") return;
      expect(provider.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(execution.error.cause).toBeUndefined();
      expect(classify(execution).code).not.toMatch(/^outbound-proxy-/u);
    },
    SLOW,
  );
});

describe("a refused proxy setting read by the real policy reader", () => {
  const PROXY_VARIABLES = [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
  ] as const;

  afterEach(() => {
    vi.unstubAllEnvs();
    resetOutboundProxyStateForTests();
  });

  /** Only the named proxy setting applies; global fetch is a trap the reader must not reach. */
  function proxySetting(value: string) {
    for (const name of PROXY_VARIABLES) vi.stubEnv(name, undefined);
    vi.stubEnv("HTTPS_PROXY", value);
    resetOutboundProxyStateForTests();
    // In-process cases never turn proxy support on for the test worker.
    const dispatcher = (globalThis as Record<symbol, unknown>)[
      Symbol.for("undici.globalDispatcher.1")
    ];
    expect(dispatcher?.constructor.name).not.toBe("EnvHttpProxyAgent");
    const trap = vi.fn(async () => textTurn("must never be sent"));
    vi.stubGlobal("fetch", trap);
    return trap;
  }

  // SOCKS is not a scheme DocsFab's proxy support uses; the valid proxy URL
  // reads not-enabled because this worker has not turned proxy support on.
  it.each([
    ["socks5://h:1", OUTBOUND_PROXY_INVALID_CODE],
    ["http://proxy.example.test:3128", OUTBOUND_PROXY_NOT_ENABLED_CODE],
  ] as const)(
    "HTTPS_PROXY=%s: nothing sent, one attempt, coded provider-terminal",
    async (value, code) => {
      const trap = proxySetting(value);
      const repositoryPath = await createRepository();
      const execution = await runStep(stepInput(repositoryPath));
      expect(trap).not.toHaveBeenCalled();
      expect(execution.status).toBe("failed");
      if (execution.status !== "failed") return;
      expect(execution.evidence.attempts).toHaveLength(1);
      expect(execution.evidence.attempts[0]).toMatchObject({
        outcome: "provider-terminal",
        retryable: false,
        retryScheduled: false,
      });
      expect(classify(execution)).toEqual({
        class: operatorRow(code).failureClass,
        layer: "workflow",
        code,
      });
      const error = execution.error;
      expect(
        error.message.startsWith("Model request failed [provider-terminal; retryable=false]: "),
      ).toBe(true);
      expect(error.message.match(new RegExp(code, "gu"))).toHaveLength(1);
      expect(error.message).not.toContain(value);
      expect((error.cause as OutboundProxyRefusal | undefined)?.code).toBe(code);
      const serialized = JSON.stringify({ error, evidence: execution.evidence });
      expect(serialized).not.toContain(code);
      expect(serialized).not.toContain(value);
    },
    SLOW,
  );

  it(
    "the runner records the invalid setting's code on the step and the run",
    async () => {
      const trap = proxySetting("socks5://h:1");
      const workspacePath = await createRepository();
      const stateDirectory = await createStateDirectory();
      const record = await runWorkflow(stateDirectory, workspacePath);
      const expected = {
        class: operatorRow(OUTBOUND_PROXY_INVALID_CODE).failureClass,
        layer: "workflow",
        code: OUTBOUND_PROXY_INVALID_CODE,
      };
      expect(trap).not.toHaveBeenCalled();
      expect(record.steps[0]!.failure).toEqual(expected);
      expect(record.failure).toEqual(expected);
      expect(record.steps[0]!.inference?.attempts).toHaveLength(1);
    },
    SLOW,
  );
});

async function createStateDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), OWN_PREFIX));
  temporaryDirectories.push(directory);
  return directory;
}

const scanner: RepositorySecurityScanner = {
  scan: async () => ({
    ruleSet: "test-v1",
    status: "passed",
    scannedFiles: 1,
    binaryFiles: 0,
    findings: [],
  }),
};

async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const log = console.log;
  console.log = (message?: unknown) => {
    lines.push(String(message ?? ""));
  };
  try {
    await fn();
  } finally {
    console.log = log;
  }
  return lines.join("\n");
}

async function runWorkflow(stateDirectory: string, workspacePath: string) {
  const request: RunRequest = {
    workflow: "review-documentation",
    workspacePath,
    repository: { sourcePath: workspacePath, requestedRevision: "HEAD", revision: "a".repeat(40) },
    allowWrite: false,
  };
  return new WorkflowRunner({
    harness: harness(),
    store: new FileRunStore(stateDirectory),
    repositoryScanner: scanner,
    contextPreflight: readyContextPreflight,
    sourceObligationObserver: sourceObligationObserverFixture,
    retryPolicy: policy,
    retrySleep: async () => undefined,
    id: () => "proxy-step-run",
  }).run(request);
}

describe("the workflow runner records the proxy's code on the step", () => {
  it.each(CODED)(
    "%s: step and run failure carry the code, and docsfab runs show prints it",
    async (kind, code) => {
      const workspacePath = await createRepository();
      const stateDirectory = await createStateDirectory();
      const thrown = refusal(kind);
      const provider = vi.fn(async () => {
        throw thrown;
      });
      vi.stubGlobal("fetch", provider);
      const record = await runWorkflow(stateDirectory, workspacePath);
      const expected = { class: operatorRow(code).failureClass, layer: "workflow", code };

      expect(provider).toHaveBeenCalledTimes(1);
      expect(record.status).toBe("failed");
      const step = record.steps[0]!;
      expect(step.failure).toEqual(expected);
      expect(record.failure).toEqual(expected);
      expect(step.inference?.attempts).toHaveLength(1);
      expect(step.inference?.attempts[0]).toMatchObject({
        outcome: "provider-terminal",
        retryable: false,
      });
      // The recorded attempt keeps the turns and usage the harness collected.
      expect(step.inference?.attempts[0]?.turns?.length).toBeGreaterThan(0);
      expect(step.inference?.attempts[0]?.usage).toBeDefined();
      // The refusal itself is never persisted.
      const persisted = JSON.stringify(record);
      expect(persisted).not.toContain('"variable"');
      expect(persisted).not.toContain('"nextAction"');

      const shown = await captureStdout(() =>
        handleRunsCommand(["show", record.id, "--state-dir", stateDirectory]),
      );
      expect(shown).toContain(`Failure class: ${expected.class} (layer workflow, code ${code}).`);

      // NEXT names a runnable readiness check and the catalog row's remediation.
      const command = `${READINESS_CHECK[code].replace(
        "docsfab doctor",
        `docsfab doctor --repo ${workspacePath}`,
      )}`;
      expect(command).not.toContain("'<");
      const lines = shown.split("\n").map((line) => line.trim());
      const at = lines.indexOf("NEXT");
      expect(at).toBeGreaterThanOrEqual(0);
      expect(lines.slice(at + 1, at + 3)).toEqual([
        command,
        `Reason: ${operatorRow(code).nextAction}`,
      ]);
      const json = await captureStdout(() =>
        handleRunsCommand(["show", record.id, "--json", "--state-dir", stateDirectory]),
      );
      process.exitCode = undefined;
      expect(decodeRunResultV1(parseJsonEvidence(json)).nextSteps).toEqual([
        command,
        operatorRow(code).nextAction,
      ]);
    },
    SLOW,
  );

  it.each(CODED)(
    "%s: a non-proxy code of the same class gets no proxy remediation",
    async (kind, code) => {
      const workspacePath = await createRepository();
      const stateDirectory = await createStateDirectory();
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw refusal(kind);
        }),
      );
      const record = await runWorkflow(stateDirectory, workspacePath);
      const failureClass = operatorRow(code).failureClass;
      const sibling = SITUATION_CATALOG.find(
        (row) =>
          row.family === "operator" &&
          row.failureClass === failureClass &&
          !row.id.startsWith("outbound-proxy-"),
      );
      if (!sibling) throw new Error(`no other operator row with class ${failureClass}`);
      // Only the code differs from the refused step, so a lookup keyed on the
      // class, the outcome, or the attempt would still answer with the proxy row.
      const forged = structuredClone(record) as RunRecord;
      forged.steps[0]!.failure = { class: failureClass, layer: "workflow", code: sibling.id };
      const next = buildRunHumanNextCommand({ record: forged, repositoryPath: workspacePath });
      const proxyActions = SITUATION_CATALOG.filter((row) =>
        row.id.startsWith("outbound-proxy-"),
      ).map((row) => row.nextAction);
      expect(next).toBeDefined();
      expect(proxyActions).not.toContain(next?.reason);
      expect(next?.command.startsWith("docsfab doctor")).toBe(false);
      // The same record with its own code does get the proxy remediation.
      expect(buildRunHumanNextCommand({ record, repositoryPath: workspacePath })?.reason).toBe(
        operatorRow(code).nextAction,
      );
    },
    SLOW,
  );

  it(
    "positive control: an unreachable proxy keeps the transient retry action",
    async () => {
      const workspacePath = await createRepository();
      const stateDirectory = await createStateDirectory();
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw refusal("unreachable");
        }),
      );
      const record = await runWorkflow(stateDirectory, workspacePath);
      expect(record.steps[0]!.failure).toEqual(NETWORK_FAULT);
      const json = await captureStdout(() =>
        handleRunsCommand(["show", record.id, "--json", "--state-dir", stateDirectory]),
      );
      process.exitCode = undefined;
      const nextSteps = decodeRunResultV1(parseJsonEvidence(json)).nextSteps;
      expect(nextSteps[1]).toContain("ended on a transient failure");
      for (const row of SITUATION_CATALOG.filter((item) => item.id.startsWith("outbound-proxy-"))) {
        expect(nextSteps).not.toContain(row.nextAction);
      }
    },
    SLOW,
  );

  it(
    "positive control: a provider failure with no refusal keeps its own class and evidence",
    async () => {
      const workspacePath = await createRepository();
      const stateDirectory = await createStateDirectory();
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw new TypeError("fetch failed");
        }),
      );
      const record = await runWorkflow(stateDirectory, workspacePath);
      const step = record.steps[0]!;
      expect(step.failure).toEqual(NETWORK_FAULT);
      expect(step.inference?.attempts.length).toBeGreaterThanOrEqual(2);
      expect(step.inference?.attempts[0]?.turns?.length).toBeGreaterThan(0);
    },
    SLOW,
  );
});

// Local budgets in ms for one tsx-compiled DocsFab child running a workflow;
// in CI each case gets at least test.ciTimeoutMs and the child keeps its share.
const localCaseMs = 90_000;
const localProcessMs = 60_000;
const processDeadline = () => nestedDeadlineMs(localProcessMs, localCaseMs);

const roots = temporaryRoots();
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

const CANARY = "CANARYPW";
const PROXY_USER = "proxyuser";
/** Every form the proxy password could leak in. */
const CANARY_FORMS = [
  CANARY,
  encodeURIComponent(CANARY),
  Buffer.from(CANARY).toString("base64"),
  Buffer.from(`${PROXY_USER}:${CANARY}`).toString("base64"),
  PROXY_REFUSAL_CANARY,
];
const CHILD_HOST = "models.example.test";

interface ChildStep {
  readonly status: string;
  readonly failure: unknown;
  readonly error: string | null;
  readonly attempts: ReadonlyArray<{ outcome: string; retryable: boolean }>;
}

/**
 * A DocsFab entry that runs one review workflow through the real runner and
 * Pi harness. The proxy comes from the entry itself: the child environment
 * carries no NODE_USE_ENV_PROXY or NODE_OPTIONS.
 */
async function writeWorkflowEntry(fixture: ProxyFixture): Promise<string> {
  const entry = join(fixture.root, "proxy-step-entry.mts");
  const source = (path: string) => JSON.stringify(pathToFileURL(join(RUNTIME_ROOT, path)).href);
  await writeFile(
    entry,
    `import { runCliEntrypoint } from ${source("src/operator/cli-entrypoint.ts")};
import { parseModelEndpoint } from ${source("src/model/configuration.ts")};
import { createModelConnection } from ${source("src/model/provider.ts")};
import { PiHarness } from ${source("src/harness/pi.ts")};
import { FileRunStore } from ${source("src/records/file-store.ts")};
import { WorkflowRunner } from ${source("src/workflow-execution/runner.ts")};
import { readyContextPreflight } from ${source("test/helpers.ts")};
import { sourceObligationObserverFixture } from ${source("test/helpers/verification.ts")};
runCliEntrypoint(import.meta.url, async () => {
  const workspacePath = process.env.PROXY_STEP_WORKSPACE;
  const harness = new PiHarness({
    skillCrateDirectory: ${JSON.stringify(join(RUNTIME_ROOT, "skill-crate"))},
    model: parseModelEndpoint(process.env),
    // Instant in-turn replay, so a replayable failure spends no wall time.
    createConnection: (model, options) =>
      createModelConnection(model, options ? { ...options, providerTurnRetry: { baseDelayMs: 0, maxDelayMs: 0 } } : options),
  });
  const record = await new WorkflowRunner({
    harness,
    store: new FileRunStore(process.env.PROXY_STEP_STATE),
    repositoryScanner: { scan: async () => ({ ruleSet: "test-v1", status: "passed", scannedFiles: 1, binaryFiles: 0, findings: [] }) },
    contextPreflight: readyContextPreflight,
    sourceObligationObserver: sourceObligationObserverFixture,
    retryPolicy: ${JSON.stringify(policy)},
    retrySleep: async () => undefined,
    id: () => "proxy-step-child",
  }).run({
    workflow: "review-documentation",
    workspacePath,
    repository: { sourcePath: workspacePath, requestedRevision: "HEAD", revision: "a".repeat(40) },
    allowWrite: false,
  });
  const step = record.steps[0];
  console.log(JSON.stringify({
    status: step?.status ?? "missing",
    failure: step?.failure ?? null,
    error: step?.error ?? null,
    attempts: (step?.inference?.attempts ?? []).map((attempt) => ({ outcome: attempt.outcome, retryable: attempt.retryable })),
  }));
  return { exitCode: 0 };
});
`,
  );
  return entry;
}

async function runChild(fixture: ProxyFixture, proxyUrl: string) {
  const entry = await writeWorkflowEntry(fixture);
  const workspacePath = join(fixture.root, "workspace");
  const stateDirectory = join(fixture.root, "state");
  await mkdir(workspacePath);
  // The run store refuses a root other users can read.
  await mkdir(stateDirectory, { mode: 0o700 });
  await writeFile(join(workspacePath, "README.md"), "# Fixture\n");
  const result = await runGuardedNode(
    fixture,
    ["--import", "tsx", entry],
    childEnvironment(fixture, {
      ...validModelEnvironment,
      MODEL_BASE_URL: `https://${CHILD_HOST}/v1`,
      HTTPS_PROXY: proxyUrl,
      PROXY_STEP_WORKSPACE: workspacePath,
      PROXY_STEP_STATE: stateDirectory,
    }),
    processDeadline(),
  );
  return { result, stateDirectory };
}

/** Every file under `root` that contains `needle`, as `grep -rlF` lists them. */
async function filesContaining(root: string, needle: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    if ((await readFile(path)).includes(needle)) found.push(path);
  }
  return found;
}

function proxyUrlWithCanary(fixture: ProxyFixture): string {
  return `http://${PROXY_USER}:${CANARY}@127.0.0.1:${String(fixture.proxyPort)}`;
}

describe("a DocsFab entry behind a real proxy (child process)", {
  timeout: testTimeoutMs(localCaseMs),
}, () => {
  it.each([
    [403, OUTBOUND_PROXY_DENIED_CODE],
    [407, OUTBOUND_PROXY_AUTH_REQUIRED_CODE],
  ] as const)(
    "a %s tunnel reply ends the step with its code after one CONNECT, and leaks no credential",
    async (status, code) => {
      const fixture = await startProxyFixture(roots, closers, `${OWN_PREFIX}fixture-`);
      fixture.script([{ kind: "status", status }], { kind: "status", status });
      const { result, stateDirectory } = await runChild(fixture, proxyUrlWithCanary(fixture));

      expect(result.stderr).toBe("");
      expect(result.code).toBe(0);
      const step = JSON.parse(result.stdout) as ChildStep;
      expect(step).toMatchObject({
        status: "failed",
        failure: { class: operatorRow(code).failureClass, layer: "workflow", code },
        attempts: [{ outcome: "provider-terminal", retryable: false }],
      });
      expect(step.error).not.toContain("Connection error");
      // One tunnel request, nothing reached the target.
      expect(fixture.proxyConnections()).toBe(1);
      expect(fixture.proxyLog.map((entry) => entry.line)).toEqual([
        `CONNECT ${CHILD_HOST}:443 HTTP/1.1`,
      ]);
      expect(fixture.targetRequests).toEqual([]);

      const shown = await captureStdout(() =>
        handleRunsCommand(["show", "proxy-step-child", "--state-dir", stateDirectory]),
      );
      expect(shown).toContain(
        `Failure class: ${operatorRow(code).failureClass} (layer workflow, code ${code}).`,
      );
      for (const form of CANARY_FORMS) {
        expect(result.stdout).not.toContain(form);
        expect(result.stderr).not.toContain(form);
        expect(shown).not.toContain(form);
        expect(await filesContaining(stateDirectory, form)).toEqual([]);
      }
    },
  );

  it("positive control: a tunnel the proxy opens carries the step's request to the provider", async () => {
    const fixture = await startProxyFixture(roots, closers, `${OWN_PREFIX}fixture-`);
    const { result } = await runChild(fixture, fixture.proxyUrl);
    expect(result.stderr).toBe("");
    const step = JSON.parse(result.stdout) as ChildStep;
    expect(fixture.proxyLog[0]?.line).toBe(`CONNECT ${CHILD_HOST}:443 HTTP/1.1`);
    expect(fixture.targetRequests[0]).toEqual({
      host: CHILD_HOST,
      method: "POST",
      url: "/v1/chat/completions",
    });
    // The fixture answers with its own probe tool call, which this step does
    // not grant, so the step ends on the provider's answer: never a proxy code.
    expect(step.attempts.length).toBeGreaterThan(0);
    expect(JSON.stringify(step.failure)).not.toContain("outbound-proxy-");
  });

  it.each([
    ["a socket reset after CONNECT 200", { kind: "reset-after-200" }],
    ["a 502 tunnel reply", { kind: "status", status: 502 }],
  ] as const satisfies ReadonlyArray<readonly [string, ConnectReply]>)(
    "%s stays uncoded and keeps its step retry",
    async (_name, reply) => {
      const fixture = await startProxyFixture(roots, closers, `${OWN_PREFIX}fixture-`);
      fixture.script([], reply);
      const { result } = await runChild(fixture, fixture.proxyUrl);
      expect(result.stderr).toBe("");
      const step = JSON.parse(result.stdout) as ChildStep;
      expect(step.status).toBe("failed");
      expect(step.attempts.length).toBeGreaterThanOrEqual(2);
      expect(step.attempts[0]?.retryable).toBe(true);
      expect(JSON.stringify(step.failure)).not.toContain("outbound-proxy-");
      expect(fixture.proxyConnections()).toBeGreaterThan(1);
      expect(fixture.targetRequests).toEqual([]);
    },
  );
});
