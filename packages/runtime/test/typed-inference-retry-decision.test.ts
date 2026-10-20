// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * An inference failure's retry is decided by the typed provider error class of
 * the request that was sent, before any message-text rule, and a recorded
 * backoff is bound to what the transport observed. Every provider here is a
 * scripted `fetch`; no request leaves the host.
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
import { PiHarness } from "../src/harness/pi.js";
import { observeLandedProviderTurn } from "../src/model/attempt-telemetry.js";
import { createModelConnection } from "../src/model/provider.js";
import { providerTurnFailureDisposition } from "../src/model/provider-turn-retry.js";
import { decideSentProviderFailure } from "../src/model/sent-provider-failure.js";
import type {
  InferenceAttemptModelTelemetryV1,
  InferenceExecutionEvidence,
  InferenceFailureCategory,
  RunRecord,
} from "../src/records/contracts.js";
import {
  honouredRetryAfterMs,
  inferenceRetryBackoffMs,
  isRecordedInferenceRetryBackoff,
} from "../src/records/inference-retry-disposition.js";
import { isInferenceAttemptModelTelemetry } from "../src/records/model-telemetry.js";
import { decodeInference } from "../src/scorecard-record-decode.js";
import { evaluateStructure, parseEvaluationFixture } from "../src/quality-evaluation/structural.js";
import { parseRetryPolicy } from "../src/config/retry-policy.js";
import { ScorecardRecordError } from "../src/execution/inference-evidence.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import { executeInferenceStep } from "../src/workflow-execution/retry.js";
import { validModelConfig } from "./helpers.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skillCrateDirectory = resolve(projectRoot, "skill-crate");
const temporaryDirectories: string[] = [];
const SLOW = testTimeoutMs(20_000);

/** Transport words and a policy stop in one line: the text rule alone would retry it. */
const CONTENT_FILTER_BREAK = "connection closed: content management policy violation";

const retryableCategories: InferenceFailureCategory[] = [
  "blank-response",
  "malformed-response",
  "timeout",
  "throttled",
  "provider-transient",
];

const policy: InferenceRetryPolicy = {
  maxRetries: 3,
  baseDelayMs: 100,
  maxDelayMs: 2_000,
  retryableCategories,
};

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
    providerLatencyMs: 12,
    ...(providerError ? { providerError } : {}),
  };
}

/** A failure the text classifier already called retryable, with typed telemetry beside it. */
function textRetryableFailure(
  category: InferenceFailureCategory,
  providerError?: InferenceAttemptModelTelemetryV1["providerError"],
): InferenceStepError {
  return new InferenceStepError(
    `Model request failed [${category}; retryable=true]: Provider turn failed: provider-failed: ${CONTENT_FILTER_BREAK}`,
    category,
    true,
    { modelTelemetry: telemetry(providerError) },
  );
}

async function runUnit(failure: () => InferenceStepError, sleeps: number[] = []) {
  let calls = 0;
  const execution = await executeInferenceStep({
    mode: "read-only",
    policy,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
    },
    execute: async () => {
      calls += 1;
      if (calls === 1) throw failure();
      return { summary: "ready" } satisfies HarnessStepResult;
    },
  });
  return { execution, calls: () => calls };
}

describe("step retry decided by the typed provider error (#1253)", () => {
  it.each([
    ["content-filter", "provider-terminal"],
    ["auth", "invalid-request"],
    ["invalid-request", "invalid-request"],
  ] as const)(
    "never retries a sent %s error the text classifier called transient",
    async (cls, category) => {
      const { execution, calls } = await runUnit(() =>
        textRetryableFailure("provider-transient", { class: cls }),
      );

      expect(calls()).toBe(1);
      expect(execution.status).toBe("failed");
      expect(execution.evidence.attempts).toHaveLength(1);
      expect(execution.evidence.attempts[0]).toMatchObject({
        outcome: category,
        retryable: false,
        retryScheduled: false,
        conditionRetryability: "not-eligible",
        retryDecision: "not-applicable",
        modelTelemetry: { providerError: { class: cls } },
      });
      // The decided error is composed from closed facts; no provider text survives.
      const error = execution.status === "failed" ? execution.error : undefined;
      expect(error?.message).toBe(
        `Model request failed [${category}; retryable=false]: the sent provider request ended with ${/^[aeiou]/u.test(cls) ? "an" : "a"} ${cls} error.`,
      );
      expect(JSON.stringify(execution.evidence)).not.toContain("policy violation");
    },
  );

  it.each([
    ["content-filter", "malformed-response"],
    ["auth", "malformed-response"],
    ["content-filter", "blank-response"],
  ] as const)(
    "applies a sent %s verdict before an uncoded %s the text classifier called retryable",
    async (cls, textCategory) => {
      // `invalid response: content_filter triggered` reads as an uncoded
      // malformed-response to the text rule; the typed class wins.
      const { execution, calls } = await runUnit(() =>
        textRetryableFailure(textCategory, { class: cls }),
      );

      expect(calls()).toBe(1);
      expect(execution.evidence.attempts[0]).toMatchObject({
        outcome: cls === "auth" ? "invalid-request" : "provider-terminal",
        retryable: false,
        retryScheduled: false,
      });
    },
  );

  it("never retries a status-less rate limit, whatever the text classifier said", async () => {
    // An explicit terminal verdict, so `connection ... rate limit` cannot
    // revive a retry through a text rule.
    const { execution, calls } = await runUnit(() =>
      textRetryableFailure("provider-transient", { class: "rate-limit" }),
    );
    expect(calls()).toBe(1);
    expect(execution.evidence.attempts[0]).toMatchObject({
      outcome: "provider-terminal",
      retryable: false,
      retryScheduled: false,
    });
  });

  it("retries a rate limit the provider answered with a status", async () => {
    const { execution, calls } = await runUnit(
      () =>
        new InferenceStepError("x", "provider-terminal", false, {
          modelTelemetry: telemetry({ class: "rate-limit", httpStatus: 429 }),
        }),
    );
    expect(calls()).toBe(2);
    expect(execution.evidence.attempts[0]).toMatchObject({
      outcome: "throttled",
      retryable: true,
      retryScheduled: true,
    });
  });

  it("replaces a text category with the typed one when both are retryable", async () => {
    const { execution, calls } = await runUnit(() =>
      textRetryableFailure("timeout", { class: "network" }),
    );

    expect(calls()).toBe(2);
    expect(execution.evidence.attempts[0]).toMatchObject({
      outcome: "provider-transient",
      retryScheduled: true,
    });
  });

  it("keeps the text verdict for an unknown class and for an attempt with no provider error", () => {
    const unknown = textRetryableFailure("provider-transient", { class: "unknown" });
    const none = textRetryableFailure("provider-transient");
    expect(decideSentProviderFailure(unknown)).toBe(unknown);
    expect(decideSentProviderFailure(none)).toBe(none);
  });

  it("keeps an already-terminal failure's recorded category", () => {
    const failure = new InferenceStepError("HTTP 400", "invalid-request", false, {
      modelTelemetry: telemetry({ class: "content-filter", httpStatus: 400 }),
    });
    expect(decideSentProviderFailure(failure)).toBe(failure);
  });
});

describe("the error that failed the step decides, not an earlier turn's telemetry (#1253)", () => {
  // The telemetry names the attempt's last landed provider turn. A failure the
  // host raised for its own reason must never be turned into a retry by it.
  const network = telemetry({ class: "network" });
  it.each([
    [
      "a host refusal raised as invalid-request",
      () =>
        new InferenceStepError("skill expansion missing", "invalid-request", false, {
          modelTelemetry: network,
        }),
      "invalid-request",
      false,
    ],
    [
      "a host budget stop",
      () =>
        new InferenceStepError("budget", "context-exhausted", false, { modelTelemetry: network }),
      "context-exhausted",
      false,
    ],
    [
      "a coded decoder rejection",
      () =>
        new InferenceStepError(
          "truncated",
          "provider-terminal",
          false,
          { modelTelemetry: network },
          { code: "text-truncated", location: "$response" },
        ),
      "provider-terminal",
      false,
    ],
    [
      "an uncoded malformed reply",
      () =>
        new InferenceStepError("bad reply", "malformed-response", false, {
          modelTelemetry: network,
        }),
      "malformed-response",
      false,
    ],
    [
      "a blank reply",
      () =>
        new InferenceStepError("blank", "blank-response", true, {
          modelTelemetry: network,
        }),
      "blank-response",
      true,
    ],
    [
      "a retryable malformed reply",
      () =>
        new InferenceStepError("bad reply", "malformed-response", true, {
          modelTelemetry: network,
        }),
      "malformed-response",
      true,
    ],
    [
      "a coded rejection beside a terminal class",
      () =>
        new InferenceStepError(
          "bad reply",
          "malformed-response",
          true,
          { modelTelemetry: telemetry({ class: "content-filter" }) },
          { code: "json-unexpected-end", location: "$response" },
        ),
      "malformed-response",
      true,
    ],
  ] as const)("keeps %s", async (_label, failure, outcome, retried) => {
    const original = failure();
    expect(decideSentProviderFailure(original)).toBe(original);

    const { execution, calls } = await runUnit(failure);
    expect(calls()).toBe(retried ? 2 : 1);
    expect(execution.evidence.attempts[0]).toMatchObject({ outcome, retryScheduled: retried });
  });
});

describe("in-turn replay decided by the typed provider error (#1253)", () => {
  const errorTurn = (errorMessage: string) => ({ stopReason: "error", errorMessage });

  it.each([
    [CONTENT_FILTER_BREAK, undefined, false, "provider-terminal"],
    ["connection reset: unauthorized", 401, false, "invalid-request"],
    ["connection reset", 400, false, "invalid-request"],
    ["connection reset", undefined, true, "provider-transient"],
    ["upstream", 503, true, "provider-transient"],
    ["slow down", 429, true, "throttled"],
    ["Rate limit exceeded for this key", undefined, false, "provider-terminal"],
    ["connection reset: quota exceeded", undefined, false, "provider-terminal"],
  ] as const)(
    "decides a sent %j (HTTP %s) from its class",
    (message, httpStatus, retryable, category) => {
      expect(
        providerTurnFailureDisposition(errorTurn(message), {
          sent: true,
          ...(httpStatus === undefined ? {} : { httpStatus }),
        }),
      ).toEqual({ retryable, category });
    },
  );

  it("keeps the text classifier for a request that was never sent", () => {
    // DocsFab's own refusals never send; the host's local-denial veto owns them.
    expect(providerTurnFailureDisposition(errorTurn("Connection error"), { sent: false })).toEqual({
      retryable: true,
      category: "provider-transient",
    });
    expect(providerTurnFailureDisposition(errorTurn("Connection error"), undefined)).toEqual({
      retryable: true,
      category: "provider-transient",
    });
  });
});

describe("recorded backoff bound to the observed status (#1253)", () => {
  const backoffPolicy = { baseDelayMs: 100, maxDelayMs: 2_000 };

  it("writes a Retry-After only beside the status of the response that carried it", () => {
    const turn = { stopReason: "error", errorMessage: "connection reset" };
    expect(
      observeLandedProviderTurn(turn, { sent: true, httpStatus: 503, retryAfterMs: 1_500 })
        .providerError,
    ).toEqual({ class: "server", httpStatus: 503, retryAfterMs: 1_500 });
    expect(
      observeLandedProviderTurn(turn, { sent: true, retryAfterMs: 1_500 }).providerError,
    ).toEqual({ class: "network" });
  });

  it("refuses telemetry recording a Retry-After with no observed status", () => {
    const withStatus = telemetry({ class: "server", httpStatus: 503, retryAfterMs: 1_500 });
    const without = telemetry({ class: "server", retryAfterMs: 1_500 });
    expect(isInferenceAttemptModelTelemetry(withStatus, "provider-transient")).toBe(true);
    expect(isInferenceAttemptModelTelemetry(without, "provider-transient")).toBe(false);
  });

  it("honours a Retry-After only with its status, when scheduling and when validating", async () => {
    expect(inferenceRetryBackoffMs(backoffPolicy, 1, { retryAfterMs: 1_500 })).toBe(100);
    expect(
      inferenceRetryBackoffMs(backoffPolicy, 1, { httpStatus: 503, retryAfterMs: 1_500 }),
    ).toBe(1_500);

    const attempt = (providerError: InferenceAttemptModelTelemetryV1["providerError"]) => ({
      attempt: 1,
      backoffMs: 1_500,
      modelTelemetry: telemetry(providerError),
    });
    expect(
      isRecordedInferenceRetryBackoff(
        backoffPolicy,
        attempt({ class: "server", httpStatus: 503, retryAfterMs: 1_500 }),
      ),
    ).toBe(true);
    expect(
      isRecordedInferenceRetryBackoff(
        backoffPolicy,
        attempt({ class: "server", retryAfterMs: 1_500 }),
      ),
    ).toBe(false);

    // The writer: a status-less Retry-After schedules only the exponential wait.
    const sleeps: number[] = [];
    const { execution } = await runUnit(
      () =>
        new InferenceStepError("x", "provider-terminal", false, {
          modelTelemetry: telemetry({ class: "network", retryAfterMs: 1_500 }),
        }),
      sleeps,
    );
    expect(sleeps).toEqual([100]);
    expect(execution.evidence.attempts[0]?.backoffMs).toBe(100);
  });

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["a fraction", 1_500.5],
    ["an unsafe integer", 2 ** 53],
    ["a negative wait", -1_500],
    ["zero", 0],
  ])("treats %s as no Retry-After at all", (_label, retryAfterMs) => {
    const providerError = { httpStatus: 503, retryAfterMs };
    expect(honouredRetryAfterMs(providerError)).toBe(0);
    expect(inferenceRetryBackoffMs(backoffPolicy, 1, providerError)).toBe(100);
    expect(inferenceRetryBackoffMs(backoffPolicy, 3, providerError)).toBe(400);
  });
});

describe("PiHarness never retries a content-filter break (#1253, scripted fetch)", () => {
  const harnessPolicy: InferenceRetryPolicy = { ...policy, baseDelayMs: 0, maxDelayMs: 0 };

  it(
    "refuses a decoded record whose honoured Retry-After lost its observed status",
    async () => {
      const repositoryPath = await createRepository();
      let calls = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          calls += 1;
          return calls === 1
            ? new Response("{}", {
                status: 503,
                headers: { "content-type": "application/json", "retry-after": "1" },
              })
            : textTurn("The review is complete.", "stop");
        }),
      );
      const execution = await runStep(
        stepInput(repositoryPath),
        { ...harnessPolicy, baseDelayMs: 100, maxDelayMs: 2_000 },
        1,
      );

      expect(execution.status).toBe("succeeded");
      expect(execution.evidence.attempts[0]).toMatchObject({
        backoffMs: 1_000,
        modelTelemetry: { providerError: { httpStatus: 503, retryAfterMs: 1_000 } },
      });
      expect(() => decodeInference(structuredClone(execution.evidence))).not.toThrow();

      const forged = structuredClone(execution.evidence);
      delete (forged.attempts[0]!.modelTelemetry!.providerError as { httpStatus?: number })
        .httpStatus;
      expect(() => decodeInference(forged)).toThrow();
    },
    SLOW,
  );

  it(
    "does not retry a committed stream that breaks with content-filter words",
    async () => {
      const repositoryPath = await createRepository();
      const provider = vi.fn(async () => brokenStream(CONTENT_FILTER_BREAK, "partial"));
      vi.stubGlobal("fetch", provider);
      const execution = await runStep(stepInput(repositoryPath), harnessPolicy);

      expect(provider).toHaveBeenCalledTimes(1);
      expect(execution.status).toBe("failed");
      expect(execution.evidence.attempts).toHaveLength(1);
      const [attempt] = execution.evidence.attempts;
      expect(attempt).toMatchObject({
        outcome: "provider-terminal",
        retryable: false,
        retryScheduled: false,
        retryDecision: "not-applicable",
        modelTelemetry: { finishReason: "error", providerError: { class: "content-filter" } },
      });
      expect(attempt?.turns?.at(-1)?.providerReplayVeto).toBe("partial-stream");
      expect(JSON.stringify(execution.evidence)).not.toContain("policy violation");
      expect(() => decodeInference(structuredClone(execution.evidence))).not.toThrow();
    },
    SLOW,
  );

  it(
    "does not replay an uncommitted stream that breaks with content-filter words",
    async () => {
      const repositoryPath = await createRepository();
      const provider = vi.fn(async () => brokenStream(CONTENT_FILTER_BREAK));
      vi.stubGlobal("fetch", provider);
      const execution = await runStep(stepInput(repositoryPath), harnessPolicy);

      expect(provider).toHaveBeenCalledTimes(1);
      expect(execution.status).toBe("failed");
      expect(execution.evidence.attempts).toHaveLength(1);
      expect(execution.evidence.attempts[0]).toMatchObject({
        outcome: "provider-terminal",
        retryScheduled: false,
        modelTelemetry: { providerError: { class: "content-filter" } },
      });
      expect(execution.evidence.attempts[0]?.turns?.at(-1)?.providerReplayVeto).toBe(
        "condition-not-retryable",
      );
    },
    SLOW,
  );

  // One fetch each.
  it.each([
    [
      "an uncommitted content-filter break read as malformed",
      "invalid response: content_filter triggered",
      undefined,
      "content-filter",
    ],
    [
      "an uncommitted auth break read as malformed",
      "unexpected end of JSON input: unauthorized",
      undefined,
      "auth",
    ],
    [
      "an uncommitted status-less rate limit",
      "Rate limit exceeded for this key",
      undefined,
      "rate-limit",
    ],
    [
      "an uncommitted status-less quota wall",
      "quota exceeded: monthly token allowance",
      undefined,
      "rate-limit",
    ],
    ["a committed status-less rate limit", "too many requests", "partial", "rate-limit"],
  ] as const)(
    "neither replays nor retries %s",
    async (_label, reason, partial, cls) => {
      const repositoryPath = await createRepository();
      const provider = vi.fn(async () => brokenStream(reason, partial));
      vi.stubGlobal("fetch", provider);
      const execution = await runStep(stepInput(repositoryPath), harnessPolicy);

      expect(provider).toHaveBeenCalledTimes(1);
      expect(execution.status).toBe("failed");
      expect(execution.evidence.attempts).toHaveLength(1);
      expect(execution.evidence.attempts[0]).toMatchObject({
        retryable: false,
        retryScheduled: false,
        modelTelemetry: { providerError: { class: cls } },
      });
      expect(execution.evidence.attempts[0]?.modelTelemetry?.providerError?.httpStatus).toBe(
        undefined,
      );
    },
    SLOW,
  );

  it(
    "neither replays nor retries a rate-limit error event inside a 200 stream",
    async () => {
      const repositoryPath = await createRepository();
      const provider = vi.fn(async () =>
        sseBody([
          { error: { message: "Rate limit reached; quota exceeded", type: "rate_limit_error" } },
        ]),
      );
      vi.stubGlobal("fetch", provider);
      const execution = await runStep(stepInput(repositoryPath), harnessPolicy);

      expect(provider).toHaveBeenCalledTimes(1);
      expect(execution.evidence.attempts).toHaveLength(1);
      expect(execution.evidence.attempts[0]).toMatchObject({
        retryable: false,
        retryScheduled: false,
        modelTelemetry: { providerError: { class: "rate-limit" } },
      });
    },
    SLOW,
  );

  it(
    "still replays and retries an HTTP 429",
    async () => {
      const repositoryPath = await createRepository();
      let calls = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          calls += 1;
          return calls <= 2
            ? new Response(JSON.stringify({ error: { message: "slow down" } }), {
                status: 429,
                headers: { "content-type": "application/json" },
              })
            : textTurn("The review is complete.", "stop");
        }),
      );
      // One in-turn attempt, so the second 429 reaches the step retry.
      const execution = await runStep(stepInput(repositoryPath), harnessPolicy, 1);

      expect(calls).toBe(3);
      expect(execution.status).toBe("succeeded");
      expect(execution.evidence.attempts[0]).toMatchObject({
        outcome: "throttled",
        retryable: true,
        retryScheduled: true,
        modelTelemetry: { providerError: { class: "rate-limit", httpStatus: 429 } },
      });
    },
    SLOW,
  );

  it(
    "still replays an uncommitted stream that breaks with a plain transport fault",
    async () => {
      const repositoryPath = await createRepository();
      let calls = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          calls += 1;
          return calls === 1
            ? brokenStream("connection reset by peer")
            : textTurn("The review is complete.", "stop");
        }),
      );
      const execution = await runStep(stepInput(repositoryPath), harnessPolicy);

      expect(calls).toBe(2);
      expect(execution.status).toBe("succeeded");
      // Replayed inside the turn: one step attempt.
      expect(execution.evidence.attempts).toHaveLength(1);
    },
    SLOW,
  );
});

describe("PiHarness spends a separate transport budget on HTTP 429s (scripted fetch)", () => {
  const transportPolicy = parseRetryPolicy({});
  const transportRetries = transportPolicy.transport!.maxRetries;
  const throttled = () =>
    new Response(JSON.stringify({ error: { message: "slow down" } }), {
      status: 429,
      headers: { "content-type": "application/json" },
    });

  it(
    "retries past the contract count and the record decoder admits the attempts",
    async () => {
      const repositoryPath = await createRepository();
      // More throttled step attempts than the contract count alone allows.
      const throttles = transportPolicy.maxRetries + 1;
      let calls = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          calls += 1;
          return calls <= throttles ? throttled() : textTurn("The review is complete.", "stop");
        }),
      );
      // One in-turn attempt, so every 429 reaches the step retry.
      const execution = await runStep(stepInput(repositoryPath), transportPolicy, 1);

      expect(calls).toBe(throttles + 1);
      expect(execution.status).toBe("succeeded");
      expect(execution.evidence.attempts.map((attempt) => attempt.outcome)).toEqual([
        ...Array(throttles).fill("throttled"),
        "succeeded",
      ]);
      const decoded = decodeInference(structuredClone(execution.evidence));
      expect(decoded.transportRetry?.maxRetries).toBe(transportRetries);
      // Without its transport block the same attempts overrun the shared count.
      const forged = structuredClone(execution.evidence);
      delete forged.transportRetry;
      expect(() => decodeInference(forged)).toThrow(ScorecardRecordError);
      // The structural evaluator's turn-governance reader agrees on both.
      expect(retryPolicyGovernance(execution.evidence)).not.toContain(
        "invalid retry policy evidence",
      );
      expect(retryPolicyGovernance(forged)).toContain("invalid retry policy evidence");
      // Both readers refuse a malformed block, including one that would move
      // a contract category off the contract count.
      for (const block of MALFORMED_TRANSPORT_BLOCKS) {
        const malformed = structuredClone(execution.evidence);
        (malformed as unknown as { transportRetry: unknown }).transportRetry = block;
        expect(() => decodeInference(structuredClone(malformed)), JSON.stringify(block)).toThrow(
          ScorecardRecordError,
        );
        expect(retryPolicyGovernance(malformed), JSON.stringify(block)).toContain(
          "invalid retry policy evidence",
        );
      }
    },
    SLOW,
  );

  it(
    "re-derives the wall-clock stop from recorded durations and waits",
    async () => {
      const repositoryPath = await createRepository();
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => throttled()),
      );
      // 3,000 ms attempts and 1,000 then 2,000 ms waits: the third attempt
      // would spend 3 x 3,000 + 3,000 + 4,000 = 16,000 ms, past a 14,000 ms
      // bound by less than the 3,000 ms of waits already recorded, so a reader
      // that dropped those waits would call it unexhausted.
      const policy = {
        ...transportPolicy,
        transport: { ...transportPolicy.transport!, maxElapsedMs: 14_000 },
      };
      const execution = await runStep(stepInput(repositoryPath), policy, 1, 3_000);

      expect(execution.evidence.attempts.map((attempt) => attempt.retryDecision)).toEqual([
        "retried",
        "retried",
        "exhausted",
      ]);
      if (execution.status !== "failed") throw new Error("expected a failed step");
      expect(execution.error.message).toContain(
        "retry-transport-max-elapsed-ms-bound: 16000 exceeds retry.transportMaxElapsedMs = 14000 ms.",
      );
      expect(() => decodeInference(structuredClone(execution.evidence))).not.toThrow();
      expect(retryPolicyGovernance(execution.evidence)).not.toContain(
        "invalid retry policy evidence",
      );
    },
    SLOW,
  );

  it(
    "accepts an unused transport budget on a write step",
    async () => {
      const repositoryPath = await createRepository();
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => textTurn("The review is complete.", "stop")),
      );
      const execution = await runStep(stepInput(repositoryPath), transportPolicy, 1);
      const write = structuredClone(execution.evidence);
      write.replay = "disabled-write-step";
      write.effectiveMaxRetries = 0;
      // A write step applies no condition budget either (#1733).
      write.conditionRetry = { maxTimeoutRetries: 0, maxCutAnswerRetries: 0 };
      delete write.transportRetry;
      // An unused transport block is valid; only a replay requires proof.
      expect(() => decodeInference(structuredClone(write), "disabled-write-step")).not.toThrow();
      write.transportRetry = structuredClone(execution.evidence.transportRetry);
      expect(() => decodeInference(write, "disabled-write-step")).not.toThrow();
    },
    SLOW,
  );

  it(
    "stops the step by name once the transport budget is spent, in a record the decoder admits",
    async () => {
      const repositoryPath = await createRepository();
      const provider = vi.fn(async () => throttled());
      vi.stubGlobal("fetch", provider);
      const execution = await runStep(stepInput(repositoryPath), transportPolicy, 1);

      expect(provider).toHaveBeenCalledTimes(transportRetries + 1);
      expect(execution.status).toBe("failed");
      if (execution.status !== "failed") throw new Error("expected a failed step");
      expect(execution.error.message).toContain(
        `retry-max-transport-retries-bound: ${transportRetries + 1} exceeds retry.maxTransportRetries = ${transportRetries} count.`,
      );
      expect(execution.evidence.attempts.at(-1)).toMatchObject({
        outcome: "throttled",
        retryDecision: "exhausted",
      });
      expect(() => decodeInference(structuredClone(execution.evidence))).not.toThrow();
    },
    SLOW,
  );
});

/** Blocks every reader must refuse; the first names a contract category. */
const MALFORMED_TRANSPORT_BLOCKS: readonly unknown[] = [
  {
    maxRetries: 6,
    maxDelayMs: 60_000,
    maxElapsedMs: 3_600_000,
    categories: ["malformed-response"],
  },
  { maxRetries: 6, maxDelayMs: 60_000, maxElapsedMs: 3_600_000, categories: ["timeout"] },
  { maxRetries: 6, maxDelayMs: 60_000, maxElapsedMs: 3_600_000, categories: [] },
  {
    maxRetries: 6,
    maxDelayMs: 60_000,
    maxElapsedMs: 3_600_000,
    categories: ["throttled"],
    extra: 1,
  },
];

describe("PiHarness records the retry rule the decoders re-derive (#1733)", () => {
  it(
    "records a cut answer as retried-cut-answer in a record the decoders admit, and refuses a swapped rule",
    async () => {
      const repositoryPath = await createRepository();
      let calls = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          calls += 1;
          // The audit step has no host contract, so a cut ends the attempt.
          return calls === 1
            ? textTurn("# Audit\n\n1. The install section", "length")
            : textTurn("The review is complete.", "stop");
        }),
      );
      const execution = await runStep(stepInput(repositoryPath), parseRetryPolicy({}), 1);

      expect(execution.status).toBe("succeeded");
      expect(execution.evidence.attempts.map((attempt) => attempt.retryRule)).toEqual([
        "retried-cut-answer",
        "not-applicable",
      ]);
      expect(execution.evidence.attempts[0]?.condition).toBe("cut-answer");
      expect(() => decodeInference(structuredClone(execution.evidence))).not.toThrow();
      expect(retryPolicyGovernance(execution.evidence)).not.toContain("retry rules disagree");

      const forged = structuredClone(execution.evidence);
      forged.attempts[0]!.retryRule = "retried-contract-correction";
      expect(() => decodeInference(forged)).toThrow(ScorecardRecordError);
      expect(retryPolicyGovernance(forged)).toContain("retry rules disagree");
      // An answer size belongs only to the attempt that admitted an answer.
      const sized = structuredClone(execution.evidence);
      sized.attempts[0]!.answerBytes = 42;
      expect(() => decodeInference(sized)).toThrow(ScorecardRecordError);
      expect(retryPolicyGovernance(sized)).toContain(
        "answer bytes on an attempt that admitted no answer",
      );
    },
    SLOW,
  );
});

describe("legacy disabled-writer transport evidence", () => {
  it("requires attempt-wide no-write proof in structural validation", () => {
    const transportRetry = {
      maxRetries: 2,
      maxDelayMs: 0,
      maxElapsedMs: 1_000,
      categories: ["provider-transient"],
    } as const;
    const makeEvidence = (
      writeSettlement?: "no-write" | "write-executed",
    ): InferenceExecutionEvidence => ({
      configuredMaxRetries: 6,
      effectiveMaxRetries: 0,
      baseDelayMs: 0,
      maxDelayMs: 0,
      retryableCategories: ["provider-transient"],
      replay: "disabled-write-step",
      transportRetry,
      attempts: [
        {
          attempt: 1,
          outcome: "provider-transient",
          retryable: true,
          retryScheduled: true,
          backoffMs: 0,
          durationMs: 0,
          ...(writeSettlement === undefined ? {} : { writeSettlement }),
        },
        {
          attempt: 2,
          outcome: "succeeded",
          retryable: false,
          retryScheduled: false,
          durationMs: 0,
        },
      ],
    });

    expect(retryPolicyGovernance(makeEvidence("no-write"))).not.toContain("retry rules disagree");
    expect(retryPolicyGovernance(makeEvidence())).toContain("retry rules disagree");
    expect(retryPolicyGovernance(makeEvidence("write-executed"))).toContain("retry rules disagree");
  });
});

/** The structural evaluator's turn-governance verdict on one step's evidence. */
function retryPolicyGovernance(evidence: InferenceExecutionEvidence): string {
  const record = {
    id: "typed-retry-structural",
    repository: { revision: "a".repeat(40) },
    tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
    steps: [
      {
        id:
          evidence.replay === "disabled-write-step" ? "write-documentation" : "audit-documentation",
        status: "succeeded",
        mode: evidence.replay === "disabled-write-step" ? "write" : "read-only",
        inference: structuredClone(evidence),
      },
    ],
  } as unknown as RunRecord;
  const fixture = parseEvaluationFixture({
    version: 1,
    name: "transport budget",
    assertions: [{ type: "turn-governance-evidence" }],
  });
  return evaluateStructure(fixture, [record]).results[0]?.message ?? "";
}

async function runStep(
  input: HarnessStepInput,
  retryPolicy: InferenceRetryPolicy,
  inTurnAttempts?: number,
  /** Fake wall clock each step attempt spends; waits advance it too. */
  attemptMs?: number,
) {
  let clock = 0;
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
                ...(inTurnAttempts === undefined
                  ? {}
                  : { maxAttempts: inTurnAttempts, maxBlankAttempts: 1 }),
              },
            }
          : connectionOptions,
      ),
  });
  return executeInferenceStep({
    mode: "read-only",
    policy: retryPolicy,
    evidenceIdentity: input.evidenceIdentity,
    ...(attemptMs === undefined ? {} : { now: () => clock }),
    sleep: async (milliseconds) => {
      clock += milliseconds;
    },
    execute: (attempt) => {
      clock += attemptMs ?? 0;
      return harness.runStep({
        ...input,
        inferenceAttempt: attempt,
        retriesConsumed: attempt - 1,
      });
    },
  });
}

async function createRepository(): Promise<string> {
  const repositoryPath = await mkdtemp(resolve(tmpdir(), "docsfab-typed-retry-"));
  temporaryDirectories.push(repositoryPath);
  await writeFile(resolve(repositoryPath, "README.md"), "# Fixture\n");
  return repositoryPath;
}

function stepInput(repositoryPath: string): HarnessStepInput {
  const workflow = getWorkflow("review-documentation");
  return {
    runId: "typed-retry-run",
    repositoryPath,
    workflow,
    step: workflow.steps[0]!,
    evidenceIdentity: { repositoryRevision: "a".repeat(40) },
  };
}

function textTurn(value: string, finishReason: string): Response {
  const chunk = (delta: object, finish: string | null, extra: object = {}) => ({
    id: "completion-typed-retry-turn",
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

/** A 200 event stream carrying `items` verbatim. */
function sseBody(items: object[]): Response {
  const body = items
    .map((item) => `data: ${JSON.stringify(item)}\n\n`)
    .concat("data: [DONE]\n\n")
    .join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/**
 * A 200 stream that breaks with `reason`: after one committed chunk when
 * `partial` is given, before any content otherwise.
 */
function brokenStream(reason: string, partial?: string): Response {
  const encoder = new TextEncoder();
  const first = {
    id: "completion-typed-retry-broken",
    object: "chat.completion.chunk",
    created: 1,
    model: validModelConfig.modelId,
    choices: [{ index: 0, delta: { role: "assistant", content: partial }, finish_reason: null }],
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (partial !== undefined) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(first)}\n\n`));
      }
      setTimeout(() => controller.error(new TypeError(reason)), 5);
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}
