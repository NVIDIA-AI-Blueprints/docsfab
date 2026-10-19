// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * A model request that was sent and then failed on the wire (the connection
 * broke mid-stream, the front door answered 5xx, or the provider timed out) is
 * retried within the read-only step budget, based on what transport telemetry
 * observed rather than whether its error text matched a rule. Auth and
 * invalid-request errors, DocsFab's own refusals, and write steps stay
 * terminal. Every provider here is a scripted `fetch`; no request leaves the
 * host.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  HarnessStepInput,
  HarnessStepResult,
  InferenceRetryPolicy,
} from "../src/execution/contracts.js";
import { InferenceStepError } from "../src/execution/contracts.js";
import { excerptRejectedReply } from "../src/execution/rejected-reply-excerpt.js";
import { fingerprintRejectedReply } from "../src/execution/rejected-reply-shape.js";
import { PiHarness } from "../src/harness/pi.js";
import { createModelConnection } from "../src/model/provider.js";
import {
  decideSentProviderFailure,
  sentProviderFailureDisposition,
} from "../src/model/sent-provider-failure.js";
import type {
  InferenceAttemptModelTelemetryV1,
  InferenceFailureCategory,
} from "../src/records/contracts.js";
import {
  inferenceRetryBackoffMs,
  isRecordedInferenceRetryBackoff,
} from "../src/records/inference-retry-disposition.js";
import { decodeInference } from "../src/scorecard-record-decode.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import { executeInferenceStep } from "../src/workflow-execution/retry.js";
import { validModelConfig } from "./helpers.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skillCrateDirectory = resolve(projectRoot, "skill-crate");
const temporaryDirectories: string[] = [];
const SLOW = testTimeoutMs(20_000);

const retryableCategories: InferenceFailureCategory[] = [
  "blank-response",
  "malformed-response",
  "timeout",
  "throttled",
  "provider-transient",
];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function telemetry(
  providerError?: InferenceAttemptModelTelemetryV1["providerError"],
): InferenceAttemptModelTelemetryV1 {
  return {
    schemaVersion: 1,
    finishReason: "error",
    providerLatencyMs: 364_012,
    ...(providerError ? { providerError } : {}),
  };
}

/** The shape `PiHarness` throws for a provider turn its text classifier did not recognize. */
function unclassifiedProviderFailure(
  providerError?: InferenceAttemptModelTelemetryV1["providerError"],
): InferenceStepError {
  return new InferenceStepError(
    "Model request failed [provider-terminal; retryable=false]: Provider turn failed: provider-failed: terminated.",
    "provider-terminal",
    false,
    { modelTelemetry: telemetry(providerError) },
  );
}

describe("sentProviderFailureDisposition (#1247, #1253)", () => {
  it.each([
    ["network", "provider-transient"],
    ["server", "provider-transient"],
    ["stream-incomplete", "provider-transient"],
    ["timeout", "timeout"],
  ] as const)("maps a sent %s error to the retryable %s category", (cls, category) => {
    expect(sentProviderFailureDisposition(telemetry({ class: cls }))).toEqual({
      category,
      retryable: true,
      providerErrorClass: cls,
    });
  });

  it("retries a rate limit only when the provider answered it with a status", () => {
    // A 429 is the throttle HTTP marks as repeatable.
    expect(
      sentProviderFailureDisposition(telemetry({ class: "rate-limit", httpStatus: 429 })),
    ).toEqual({ category: "throttled", retryable: true, providerErrorClass: "rate-limit" });
    // Rate-limit or quota words with no status are usually a quota wall, and
    // the class came from text: explicitly terminal.
    expect(sentProviderFailureDisposition(telemetry({ class: "rate-limit" }))).toEqual({
      category: "provider-terminal",
      retryable: false,
      providerErrorClass: "rate-limit",
    });
  });

  it.each([
    ["content-filter", "provider-terminal"],
    ["auth", "invalid-request"],
    ["invalid-request", "invalid-request"],
  ] as const)("maps a sent %s error to the terminal %s category", (cls, category) => {
    expect(sentProviderFailureDisposition(telemetry({ class: cls }))).toEqual({
      category,
      retryable: false,
      providerErrorClass: cls,
    });
  });

  it("gives a sent unknown error no verdict", () => {
    expect(sentProviderFailureDisposition(telemetry({ class: "unknown" }))).toBeUndefined();
  });

  it("gives an attempt with no sent provider error no category", () => {
    // Transport telemetry records a provider error only for a request that
    // left the host, so DocsFab's own refusals reach here with none.
    expect(sentProviderFailureDisposition(telemetry())).toBeUndefined();
    expect(sentProviderFailureDisposition(undefined)).toBeUndefined();
  });
});

describe("decideSentProviderFailure (#1247)", () => {
  it("reclassifies an unrecognized sent network failure without retaining provider text", () => {
    const original = unclassifiedProviderFailure({ class: "network" });
    const reclassified = decideSentProviderFailure(original);

    expect(reclassified.category).toBe("provider-transient");
    expect(reclassified.retryable).toBe(true);
    expect(reclassified.evidence).toBe(original.evidence);
    expect(reclassified.message).toBe(
      "Model request failed [provider-transient; retryable=true]: the sent provider request ended with a network error.",
    );
    expect(reclassified.message).not.toContain("terminated");
    // The original stays reachable for diagnosis but does not serialize.
    expect(reclassified.cause).toBe(original);
    expect(Object.keys(reclassified)).not.toContain("cause");
  });

  it("keeps the rejected reply fingerprint and excerpt on the re-decided error (#1690)", () => {
    const original = unclassifiedProviderFailure({ class: "network" });
    const reply = "Reasoning before the answer.";
    original.rejectedReplyShape = fingerprintRejectedReply(reply, () => true);
    original.rejectedReplyExcerpt = excerptRejectedReply(reply, 512, 0);
    const reclassified = decideSentProviderFailure(original);
    expect(reclassified).not.toBe(original);
    expect(reclassified.rejectedReplyShape).toBe(original.rejectedReplyShape);
    expect(reclassified.rejectedReplyExcerpt).toBe(original.rejectedReplyExcerpt);
  });

  it("names the observed status of a sent server failure", () => {
    const reclassified = decideSentProviderFailure(
      unclassifiedProviderFailure({ class: "server", httpStatus: 503 }),
    );
    expect(reclassified.category).toBe("provider-transient");
    expect(reclassified.message).toContain("ended with a server error (HTTP 503).");
  });

  it.each([
    [
      "a category the classifier decided",
      new InferenceStepError("x", "invalid-request", false, {
        modelTelemetry: telemetry({ class: "network" }),
      }),
    ],
    [
      "a coded decoder rejection",
      new InferenceStepError(
        "x",
        "provider-terminal",
        false,
        { modelTelemetry: telemetry({ class: "network" }) },
        { code: "text-truncated", location: "$response" },
      ),
    ],
    ["an auth provider error", unclassifiedProviderFailure({ class: "auth", httpStatus: 401 })],
    ["no sent provider error", unclassifiedProviderFailure()],
  ])("leaves %s unchanged", (_label, failure) => {
    expect(decideSentProviderFailure(failure)).toBe(failure);
  });
});

describe("executeInferenceStep with a sent provider failure (#1247)", () => {
  const policy: InferenceRetryPolicy = {
    maxRetries: 2,
    baseDelayMs: 100,
    maxDelayMs: 2_000,
    retryableCategories,
  };

  it("retries a sent network failure within the read-only budget and records it truthfully", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const execution = await executeInferenceStep({
      mode: "read-only",
      policy,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
      execute: async () => {
        calls += 1;
        if (calls === 1) throw unclassifiedProviderFailure({ class: "network" });
        return { summary: "ready" } satisfies HarnessStepResult;
      },
    });

    expect(execution.status).toBe("succeeded");
    expect(calls).toBe(2);
    expect(sleeps).toEqual([100]);
    expect(execution.evidence.attempts[0]).toMatchObject({
      outcome: "provider-transient",
      retryable: true,
      retryScheduled: true,
      conditionRetryability: "eligible",
      retryDecision: "retried",
      backoffMs: 100,
      modelTelemetry: { providerError: { class: "network" } },
    });
    expect(JSON.stringify(execution.evidence)).not.toContain("terminated");
    expect(isRecordedInferenceRetryBackoff(policy, execution.evidence.attempts[0]!)).toBe(true);
  });

  it("does not exceed retry.maxRetries for a provider that keeps breaking", async () => {
    let calls = 0;
    const execution = await executeInferenceStep({
      mode: "read-only",
      policy,
      sleep: async () => undefined,
      execute: async () => {
        calls += 1;
        throw unclassifiedProviderFailure({ class: "network" });
      },
    });

    expect(execution.status).toBe("failed");
    expect(calls).toBe(policy.maxRetries + 1);
    expect(execution.evidence.attempts.at(-1)).toMatchObject({
      outcome: "provider-transient",
      retryScheduled: false,
      retryDecision: "exhausted",
    });
    expect(execution.status === "failed" && execution.error.message).toBe(
      "Model request failed [provider-transient; retryable=true]: the sent provider request ended with a network error.",
    );
  });

  it.each([
    ["auth", 401],
    ["auth", 403],
    ["invalid-request", 400],
  ] as const)("keeps a sent %s error (HTTP %i) terminal", async (cls, httpStatus) => {
    let calls = 0;
    const execution = await executeInferenceStep({
      mode: "read-only",
      policy,
      sleep: async () => undefined,
      execute: async () => {
        calls += 1;
        throw unclassifiedProviderFailure({ class: cls, httpStatus });
      },
    });

    expect(calls).toBe(1);
    expect(execution.evidence.attempts).toHaveLength(1);
    expect(execution.evidence.attempts[0]).toMatchObject({
      outcome: "provider-terminal",
      retryable: false,
      retryScheduled: false,
    });
  });

  it("never retries a write step, whatever the transport observed", async () => {
    let calls = 0;
    const execution = await executeInferenceStep({
      mode: "write",
      policy,
      sleep: async () => undefined,
      execute: async () => {
        calls += 1;
        throw unclassifiedProviderFailure({ class: "network" });
      },
    });

    expect(calls).toBe(1);
    expect(execution.evidence.replay).toBe("disabled-write-step");
    expect(execution.evidence.attempts[0]).toMatchObject({
      outcome: "provider-transient",
      retryScheduled: false,
      retryDecision: "declined",
    });
  });

  it("keeps a cancelled attempt a cancellation, not a retryable provider fault", async () => {
    const controller = new AbortController();
    const execution = await executeInferenceStep({
      mode: "read-only",
      policy,
      signal: controller.signal,
      sleep: async () => undefined,
      execute: async () => {
        controller.abort();
        throw unclassifiedProviderFailure({ class: "network" });
      },
    });

    expect(execution.status).toBe("failed");
    expect(execution.evidence.attempts).toHaveLength(1);
    expect(execution.evidence.attempts[0]).toMatchObject({
      outcome: "provider-terminal",
      retryScheduled: false,
    });
  });

  it.each([
    ["lengthens the wait to", 1_500, 1_500],
    ["clamps to retry.maxDelayMs", 30_000, 2_000],
    ["keeps the longer exponential wait over", 50, 100],
  ])("%s a sent failure's observed Retry-After", async (_label, retryAfterMs, expected) => {
    const sleeps: number[] = [];
    let calls = 0;
    const execution = await executeInferenceStep({
      mode: "read-only",
      policy,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
      execute: async () => {
        calls += 1;
        if (calls === 1) {
          throw unclassifiedProviderFailure({ class: "server", httpStatus: 503, retryAfterMs });
        }
        return { summary: "ready" } satisfies HarnessStepResult;
      },
    });

    expect(execution.status).toBe("succeeded");
    expect(sleeps).toEqual([expected]);
    expect(execution.evidence.attempts[0]?.backoffMs).toBe(expected);
    expect(isRecordedInferenceRetryBackoff(policy, execution.evidence.attempts[0]!)).toBe(true);
  });
});

describe("recorded retry backoff (#1247)", () => {
  const policy = { baseDelayMs: 100, maxDelayMs: 2_000 };

  it("derives the exponential wait, lengthened to Retry-After and bounded by maxDelayMs", () => {
    expect(inferenceRetryBackoffMs(policy, 1)).toBe(100);
    expect(inferenceRetryBackoffMs(policy, 3)).toBe(400);
    const observed = (retryAfterMs: number) => ({ httpStatus: 503, retryAfterMs });
    expect(inferenceRetryBackoffMs(policy, 1, observed(1_500))).toBe(1_500);
    expect(inferenceRetryBackoffMs(policy, 1, observed(60_000))).toBe(2_000);
    expect(inferenceRetryBackoffMs(policy, 3, observed(200))).toBe(400);
  });

  it("admits the honoured wait and a pre-#1247 exponential wait, and nothing else", () => {
    const attempt = (backoffMs: number) => ({
      attempt: 1,
      backoffMs,
      modelTelemetry: telemetry({ class: "server", httpStatus: 503, retryAfterMs: 1_500 }),
    });
    expect(isRecordedInferenceRetryBackoff(policy, attempt(1_500))).toBe(true);
    expect(isRecordedInferenceRetryBackoff(policy, attempt(100))).toBe(true);
    expect(isRecordedInferenceRetryBackoff(policy, attempt(1_000))).toBe(false);
    expect(isRecordedInferenceRetryBackoff(policy, attempt(2_000))).toBe(false);
  });
});

describe("PiHarness step retry after a sent request fails (#1247, scripted fetch)", () => {
  const policy: InferenceRetryPolicy = {
    maxRetries: 2,
    baseDelayMs: 0,
    maxDelayMs: 0,
    retryableCategories,
  };

  it(
    "retries a 200 response whose stream then breaks, and succeeds on a clean attempt",
    async () => {
      const repositoryPath = await createRepository();
      let calls = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          calls += 1;
          return calls === 1 ? brokenStream() : textTurn("The review is complete.", "stop");
        }),
      );
      const outputs: string[][] = [];
      const execution = await runStep(stepInput(repositoryPath), policy, { outputs });

      expect(calls).toBe(2);
      expect(execution.status).toBe("succeeded");
      const [broken, retried] = execution.evidence.attempts;
      expect(broken).toMatchObject({
        attempt: 1,
        outcome: "provider-transient",
        retryable: true,
        retryScheduled: true,
        retryDecision: "retried",
        modelTelemetry: { finishReason: "error", providerError: { class: "network" } },
      });
      // The in-turn wrapper could not replay a committed stream; the step retry did.
      expect(broken?.turns?.at(-1)?.providerReplayVeto).toBe("partial-stream");
      expect(retried).toMatchObject({ attempt: 2, outcome: "succeeded" });
      // A fresh attempt: the broken attempt's partial text did not reach the
      // retried attempt's output, and its own lease was bound to attempt 2.
      expect(outputs[1]?.join("")).not.toContain("partial");
      expect(retried?.executionLease?.binding).toMatchObject({
        inferenceAttempt: 2,
        retriesConsumed: 1,
      });
      expect(JSON.stringify(execution.evidence)).not.toContain("terminated");
      expect(() => decodeInference(structuredClone(execution.evidence))).not.toThrow();
    },
    SLOW,
  );

  it.each([401, 403, 400])(
    "does not retry an HTTP %i provider answer",
    async (status) => {
      const repositoryPath = await createRepository();
      const provider = vi.fn(async () => errorResponse(status, {}));
      vi.stubGlobal("fetch", provider);
      const execution = await runStep(stepInput(repositoryPath), policy);

      expect(provider).toHaveBeenCalledTimes(1);
      expect(execution.status).toBe("failed");
      expect(execution.evidence.attempts).toHaveLength(1);
      expect(execution.evidence.attempts[0]).toMatchObject({
        retryable: false,
        retryScheduled: false,
        modelTelemetry: { providerError: { httpStatus: status } },
      });
    },
    SLOW,
  );

  it(
    "backs off a 503's Retry-After at the step level, bounded by retry.maxDelayMs",
    async () => {
      const repositoryPath = await createRepository();
      let calls = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          calls += 1;
          return calls === 1
            ? errorResponse(503, { "retry-after": "3" })
            : textTurn("The review is complete.", "stop");
        }),
      );
      const sleeps: number[] = [];
      const execution = await runStep(
        stepInput(repositoryPath),
        { ...policy, baseDelayMs: 100, maxDelayMs: 2_000 },
        { sleeps, inTurnAttempts: 1 },
      );

      expect(calls).toBe(2);
      expect(execution.status).toBe("succeeded");
      expect(execution.evidence.attempts[0]).toMatchObject({
        retryScheduled: true,
        modelTelemetry: {
          providerError: { class: "server", httpStatus: 503, retryAfterMs: 3_000 },
        },
      });
      // Retry-After asked for 3,000 ms; retry.maxDelayMs bounds the wait to 2,000 ms.
      expect(sleeps).toEqual([2_000]);
      expect(execution.evidence.attempts[0]?.backoffMs).toBe(2_000);
      expect(() => decodeInference(structuredClone(execution.evidence))).not.toThrow();
    },
    SLOW,
  );

  it(
    "retries a 200 stream that closes mid-answer with no finish chunk and no [DONE] (#1696)",
    async () => {
      const repositoryPath = await createRepository();
      let calls = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          calls += 1;
          return calls === 1
            ? incompleteStream({ content: "partial" })
            : textTurn("The review is complete.", "stop");
        }),
      );
      const outputs: string[][] = [];
      const execution = await runStep(stepInput(repositoryPath), policy, { outputs });

      expect(calls).toBe(2);
      expect(execution.status).toBe("succeeded");
      const [cut, retried] = execution.evidence.attempts;
      expect(cut).toMatchObject({
        attempt: 1,
        outcome: "provider-transient",
        retryable: true,
        retryScheduled: true,
        retryDecision: "retried",
        modelTelemetry: { finishReason: "error" },
      });
      expect(cut?.modelTelemetry?.providerError).toEqual({ class: "stream-incomplete" });
      // The answer had started, so the in-turn replay still refuses; the step retries.
      expect(cut?.turns?.at(-1)?.providerReplayVeto).toBe("partial-stream");
      expect(retried).toMatchObject({ attempt: 2, outcome: "succeeded" });
      expect(outputs[1]?.join("")).not.toContain("partial");
      // A fresh lease for the retry, charged only with its own turn's output.
      expect(retried?.executionLease?.binding).toMatchObject({
        inferenceAttempt: 2,
        retriesConsumed: 1,
      });
      expect(retried?.usage?.output).toBe(5);
      expect(retried?.turns?.map((turn) => turn.outputTokens)).toEqual([5]);
      expect(JSON.stringify(execution.evidence)).not.toContain("finish_reason");
      expect(() => decodeInference(structuredClone(execution.evidence))).not.toThrow();
    },
    SLOW,
  );

  it(
    "stops retrying a stream that keeps closing mid-answer at retry.maxRetries (#1696)",
    async () => {
      const repositoryPath = await createRepository();
      const provider = vi.fn(async () => incompleteStream({ content: "partial" }));
      vi.stubGlobal("fetch", provider);
      const execution = await runStep(stepInput(repositoryPath), policy);

      // One physical request per attempt: the partial-stream veto holds in-turn.
      expect(provider).toHaveBeenCalledTimes(policy.maxRetries + 1);
      expect(execution.status).toBe("failed");
      expect(execution.evidence.attempts).toHaveLength(policy.maxRetries + 1);
      expect(execution.evidence.attempts.at(-1)).toMatchObject({
        outcome: "provider-transient",
        retryScheduled: false,
        retryDecision: "exhausted",
        modelTelemetry: { providerError: { class: "stream-incomplete" } },
      });
      expect(execution.status === "failed" && execution.error.message).toBe(
        "Model request failed [provider-transient; retryable=true]: the sent provider request ended with a stream-incomplete error.",
      );
    },
    SLOW,
  );

  it(
    "replays in-turn a stream that closes before any answer text (#1696)",
    async () => {
      const repositoryPath = await createRepository();
      let calls = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          calls += 1;
          return calls === 1 ? incompleteStream({}) : textTurn("The review is complete.", "stop");
        }),
      );
      const execution = await runStep(stepInput(repositoryPath), policy);

      expect(calls).toBe(2);
      expect(execution.status).toBe("succeeded");
      expect(execution.evidence.attempts).toHaveLength(1);
      const turn = execution.evidence.attempts[0]?.turns?.at(-1);
      expect(turn?.providerRetries).toBe(1);
      expect(turn?.providerReplayVeto).toBeUndefined();
      // The cut request reported no usage, so the lease charges only the replay.
      expect(turn?.outputTokens).toBe(5);
    },
    SLOW,
  );

  it(
    "keeps a stream that sent [DONE] without a finish chunk terminal (#1696)",
    async () => {
      const repositoryPath = await createRepository();
      const provider = vi.fn(async () => incompleteStream({ content: "partial", done: true }));
      vi.stubGlobal("fetch", provider);
      const execution = await runStep(stepInput(repositoryPath), policy);

      expect(provider).toHaveBeenCalledTimes(1);
      expect(execution.status).toBe("failed");
      expect(execution.evidence.attempts).toHaveLength(1);
      expect(execution.evidence.attempts[0]).toMatchObject({
        outcome: "provider-terminal",
        retryable: false,
        retryScheduled: false,
        modelTelemetry: { providerError: { class: "unknown" } },
      });
    },
    SLOW,
  );
});

async function runStep(
  input: HarnessStepInput,
  policy: InferenceRetryPolicy,
  options: { sleeps?: number[]; outputs?: string[][]; inTurnAttempts?: number } = {},
) {
  const harness = new PiHarness({
    skillCrateDirectory,
    model: validModelConfig,
    // Instant in-turn replay, so a retryable provider error spends no wall time.
    createConnection: (model, connectionOptions) =>
      createModelConnection(
        model,
        connectionOptions
          ? {
              ...connectionOptions,
              providerTurnRetry: {
                baseDelayMs: 0,
                maxDelayMs: 0,
                ...(options.inTurnAttempts === undefined
                  ? {}
                  : { maxAttempts: options.inTurnAttempts, maxBlankAttempts: 1 }),
              },
            }
          : connectionOptions,
      ),
  });
  return executeInferenceStep({
    mode: "read-only",
    policy,
    evidenceIdentity: input.evidenceIdentity,
    sleep: async (milliseconds) => {
      options.sleeps?.push(milliseconds);
    },
    execute: (attempt) => {
      const output: string[] = [];
      options.outputs?.push(output);
      return harness.runStep({
        ...input,
        inferenceAttempt: attempt,
        retriesConsumed: attempt - 1,
        onText: (text) => output.push(text),
      });
    },
  });
}

async function createRepository(): Promise<string> {
  const repositoryPath = await mkdtemp(resolve(tmpdir(), "docsfab-sent-provider-retry-"));
  temporaryDirectories.push(repositoryPath);
  await writeFile(resolve(repositoryPath, "README.md"), "# Fixture\n");
  return repositoryPath;
}

function stepInput(repositoryPath: string): HarnessStepInput {
  const workflow = getWorkflow("review-documentation");
  return {
    runId: "sent-provider-retry-run",
    repositoryPath,
    workflow,
    step: workflow.steps[0]!,
    evidenceIdentity: { repositoryRevision: "a".repeat(40) },
  };
}

function textTurn(value: string, finishReason: string): Response {
  const chunk = (delta: object, finish: string | null, extra: object = {}) => ({
    id: "completion-sent-retry-turn",
    object: "chat.completion.chunk",
    created: 1,
    model: validModelConfig.modelId,
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...extra,
  });
  const body = [
    chunk({ role: "assistant", content: value }, null),
    chunk({}, finishReason, {
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
  ]
    .map((item) => `data: ${JSON.stringify(item)}\n\n`)
    .concat("data: [DONE]\n\n")
    .join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function errorResponse(status: number, headers: Record<string, string>): Response {
  return new Response(JSON.stringify({ error: { message: "provider body text" } }), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/**
 * A 200 stream that closes cleanly with no `finish_reason` chunk: an assistant
 * delta, with `content` when given, then `[DONE]` only when `done` is set.
 */
function incompleteStream(options: { content?: string; done?: boolean }): Response {
  const delta = { role: "assistant", ...(options.content ? { content: options.content } : {}) };
  const chunk = {
    id: "completion-sent-retry-incomplete",
    object: "chat.completion.chunk",
    created: 1,
    model: validModelConfig.modelId,
    choices: [{ index: 0, delta, finish_reason: null }],
  };
  const body = `data: ${JSON.stringify(chunk)}\n\n${options.done ? "data: [DONE]\n\n" : ""}`;
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** A 200 stream that commits one partial chunk and then breaks mid-flight. */
function brokenStream(): Response {
  const encoder = new TextEncoder();
  const first = {
    id: "completion-sent-retry-broken",
    object: "chat.completion.chunk",
    created: 1,
    model: validModelConfig.modelId,
    choices: [{ index: 0, delta: { role: "assistant", content: "partial" }, finish_reason: null }],
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(first)}\n\n`));
      setTimeout(() => controller.error(new TypeError("terminated")), 5);
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}
