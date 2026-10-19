// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * A step attempt that a provider throttle or transport fault ended never
 * reached a contract verdict, so it is retried from its own bounded transport
 * budget and leaves the step's contract-correction count untouched. Every
 * failure here is the shape the harness raises, decided by the shipped typed
 * classifier; no request leaves the host.
 */
import { describe, expect, it } from "vitest";

import { limit } from "../src/config/limits.js";
import { parseRetryPolicy } from "../src/config/retry-policy.js";
import type { HarnessStepInput, InferenceRetryPolicy } from "../src/execution/contracts.js";
import { InferenceStepError } from "../src/execution/contracts.js";
import type {
  InferenceAttemptModelTelemetryV1,
  InferenceExecutionEvidence,
  RunRecord,
} from "../src/records/contracts.js";
import {
  formatStepRetryDispositionSentence,
  readRunRetryDispositions,
  readTerminalRetryDisposition,
} from "../src/operator/retry-disposition.js";
import { inferenceAttemptRulesConsistent } from "../src/records/inference-retry-rule.js";
import {
  inferenceAttemptBudgetPositions,
  inferenceAttemptsWithinBudgets,
  isInferenceTransportRetryEvidence,
  isRecordedInferenceRetryBackoff,
  projectBudgetedInferenceRetryDecision,
} from "../src/records/inference-retry-disposition.js";
import { executeInferenceStep } from "../src/workflow-execution/retry.js";

const catalog = (name: string) => limit(name, { environment: {} }).value;
const MAX_RETRIES = catalog("retry.maxRetries");
const MAX_TRANSPORT_RETRIES = catalog("retry.maxTransportRetries");
const TRANSPORT_MAX_DELAY_MS = catalog("retry.transportMaxDelayMs");
const TRANSPORT_MAX_ELAPSED_MS = catalog("retry.transportMaxElapsedMs");
const BASE_DELAY_MS = catalog("retry.baseDelayMs");

type Step = "429" | "malformed" | "400" | "stream-incomplete" | "ok";
type WriteSettlement = "no-write" | "write-executed" | "unavailable";

function telemetry(
  providerError: InferenceAttemptModelTelemetryV1["providerError"],
): InferenceAttemptModelTelemetryV1 {
  return { schemaVersion: 1, finishReason: "error", providerLatencyMs: 7, providerError };
}

/** The harness's failure for one scripted attempt, as the transport would record it. */
function failureFor(
  step: Exclude<Step, "ok">,
  retryAfterMs?: number,
  writeSettlement?: WriteSettlement,
): InferenceStepError {
  const evidence = (value: object | undefined) =>
    value === undefined && writeSettlement === undefined
      ? undefined
      : ({ ...value, ...(writeSettlement === undefined ? {} : { writeSettlement }) } as unknown as
          | InferenceExecutionEvidence["attempts"][number]
          | undefined);
  switch (step) {
    case "429":
      return new InferenceStepError(
        "Model request failed: 429 Too Many Requests",
        "throttled",
        true,
        evidence({
          modelTelemetry: telemetry({
            class: "rate-limit",
            httpStatus: 429,
            ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
          }),
        }),
      );
    case "stream-incomplete":
      return new InferenceStepError(
        "Model request failed: terminated",
        "provider-transient",
        true,
        evidence({
          modelTelemetry: telemetry({ class: "stream-incomplete" }),
        }),
      );
    case "400":
      return new InferenceStepError(
        "Model request failed: 400 Bad Request",
        "invalid-request",
        false,
        evidence({
          modelTelemetry: telemetry({ class: "invalid-request", httpStatus: 400 }),
        }),
      );
    case "malformed":
      return new InferenceStepError(
        "Quality artifact envelope refused.",
        "malformed-response",
        true,
        evidence(undefined),
        { code: "quality-envelope-json", location: "$" },
      );
  }
}

interface Seen {
  attempt: number;
  contractAttempt: number | undefined;
  correction: HarnessStepInput["responseCorrection"];
}

async function runScript(
  script: readonly Step[],
  options: {
    policy?: InferenceRetryPolicy;
    retryAfterMs?: number;
    /** Wall clock each attempt spends, so the transport elapsed bound can be reached. */
    attemptMs?: number;
    mode?: "read-only" | "write";
    hostResetsWrites?: boolean;
    writeSettlement?: WriteSettlement;
  } = {},
) {
  const seen: Seen[] = [];
  const sleeps: number[] = [];
  let clock = 0;
  const execution = await executeInferenceStep({
    mode: options.mode ?? "read-only",
    ...(options.hostResetsWrites ? { hostResetsWrites: true } : {}),
    policy: options.policy ?? parseRetryPolicy({}),
    now: () => clock,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      clock += milliseconds;
    },
    execute: async (attempt, correction, budget) => {
      seen.push({ attempt, contractAttempt: budget?.contractAttempt, correction });
      clock += options.attemptMs ?? 0;
      const step = script[attempt - 1];
      if (step === undefined) throw new Error(`script has no attempt ${attempt}`);
      if (step === "ok") return { summary: "ready" };
      throw failureFor(step, options.retryAfterMs, options.writeSettlement);
    },
  });
  return { execution, seen, sleeps };
}

/**
 * The checks every record reader applies through the shared budget helpers
 * (`outcome.ts`, `scorecard-record-decode.ts`, `structural.ts`): the block's
 * shape, both budgets, each attempt's decision, and each recorded wait. The
 * full decoders also need harness evidence; `typed-inference-retry-decision.test.ts`
 * runs those against a scripted provider.
 */
function readersAdmit(evidence: InferenceExecutionEvidence): boolean {
  if (
    evidence.transportRetry !== undefined &&
    !isInferenceTransportRetryEvidence(evidence.transportRetry, evidence.retryableCategories)
  ) {
    return false;
  }
  if (!inferenceAttemptsWithinBudgets(evidence, evidence.attempts)) return false;
  if (
    evidence.conditionRetry !== undefined &&
    !inferenceAttemptRulesConsistent(evidence, evidence.attempts)
  ) {
    return false;
  }
  const positions = inferenceAttemptBudgetPositions(evidence, evidence.attempts);
  return evidence.attempts.every((attempt, index) => {
    const position = positions[index]!;
    const decision = projectBudgetedInferenceRetryDecision({
      outcome: attempt.outcome,
      position,
      policyRetryableCategories: evidence.retryableCategories,
      retryScheduled: attempt.retryScheduled,
      retryable: attempt.retryable,
    });
    return (
      decision === attempt.retryDecision &&
      (!attempt.retryScheduled ||
        isRecordedInferenceRetryBackoff(position.backoff, attempt, position.ordinal))
    );
  });
}

describe("transport faults never spend the contract-correction count", () => {
  it("gives a step that hits 429s all of its contract attempts, with the correction intact", async () => {
    const script: Step[] = ["malformed", "429", "429", "malformed", "malformed", "malformed"];
    const { execution, seen } = await runScript(script);

    // 1 + retry.maxRetries contract attempts, plus the two the throttle ended.
    expect(seen.map((entry) => entry.attempt)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(seen.map((entry) => entry.contractAttempt)).toEqual([1, 2, 2, 2, 3, 4]);
    expect(MAX_RETRIES + 1).toBe(4);
    expect(execution.status).toBe("failed");
    const attempts = execution.evidence.attempts;
    expect(attempts.map((attempt) => [attempt.outcome, attempt.retryDecision])).toEqual([
      ["malformed-response", "retried"],
      ["throttled", "retried"],
      ["throttled", "retried"],
      ["malformed-response", "retried"],
      ["malformed-response", "retried"],
      ["malformed-response", "exhausted"],
    ]);
    // The correction attempt 1 earned reaches every attempt until the contract
    // judges another reply; a throttle gave it nothing new to correct.
    const firstCorrection = seen[1]?.correction;
    expect(firstCorrection?.rejection).toEqual({ code: "quality-envelope-json", location: "$" });
    expect(seen[2]?.correction).toBe(firstCorrection);
    expect(seen[3]?.correction).toBe(firstCorrection);
    expect(seen[0]?.correction).toBeUndefined();
    expect(execution.evidence.transportRetry).toEqual({
      maxRetries: MAX_TRANSPORT_RETRIES,
      maxDelayMs: TRANSPORT_MAX_DELAY_MS,
      maxElapsedMs: TRANSPORT_MAX_ELAPSED_MS,
      categories: ["throttled", "provider-transient"],
    });
    expect(readersAdmit(execution.evidence)).toBe(true);
  });

  it("charges the throttles to the contract count for a policy built without the transport budget", async () => {
    // Adjacent condition: the older single-count policy, which records no
    // transport block, still behaves and decodes as it always did.
    const { transport: _absent, ...legacy } = parseRetryPolicy({});
    const { execution, seen } = await runScript(["malformed", "429", "429", "malformed"], {
      policy: legacy,
    });

    expect(seen.map((entry) => entry.attempt)).toEqual([1, 2, 3, 4]);
    expect(execution.evidence.attempts.at(-1)).toMatchObject({
      outcome: "malformed-response",
      retryDecision: "exhausted",
    });
    expect(execution.evidence.transportRetry).toBeUndefined();
    expect(readersAdmit(execution.evidence)).toBe(true);
  });

  it("still spends the contract count on a malformed reply and never retries a 400", async () => {
    const malformed = await runScript(["malformed", "malformed", "malformed", "malformed", "ok"]);
    expect(malformed.seen).toHaveLength(4);
    expect(malformed.execution.status).toBe("failed");
    expect(malformed.execution.evidence.attempts.at(-1)?.retryDecision).toBe("exhausted");

    const badRequest = await runScript(["400", "ok"]);
    expect(badRequest.seen).toHaveLength(1);
    expect(badRequest.execution.status).toBe("failed");
    expect(badRequest.execution.evidence.attempts[0]).toMatchObject({
      outcome: "invalid-request",
      retryScheduled: false,
      retryDecision: "not-applicable",
    });
    if (badRequest.execution.status !== "failed") throw new Error("expected a failed step");
    expect(badRequest.execution.error.message).not.toContain("Transport retries");
  });

  it("retries a stream that closed before it finished from the transport budget too", async () => {
    const { execution, seen } = await runScript([
      "stream-incomplete",
      "malformed",
      "malformed",
      "malformed",
      "malformed",
    ]);
    expect(seen.map((entry) => entry.contractAttempt)).toEqual([1, 1, 2, 3, 4]);
    expect(execution.evidence.attempts[0]).toMatchObject({
      outcome: "provider-transient",
      retryDecision: "retried",
    });
    expect(execution.evidence.attempts.at(-1)?.retryDecision).toBe("exhausted");
  });

  it("admits a record that spent every transport retry and every contract retry", async () => {
    const script: Step[] = [
      ...Array<Step>(MAX_TRANSPORT_RETRIES).fill("429"),
      ...Array<Step>(MAX_RETRIES).fill("malformed"),
      "ok",
    ];
    const { execution } = await runScript(script);
    expect(execution.status).toBe("succeeded");
    expect(execution.evidence.attempts).toHaveLength(MAX_TRANSPORT_RETRIES + MAX_RETRIES + 1);
    expect(readersAdmit(execution.evidence)).toBe(true);

    // The same attempts without the transport block claim more retries than
    // one shared count allows.
    const forged = structuredClone(execution.evidence);
    delete forged.transportRetry;
    expect(readersAdmit(forged)).toBe(false);
    // A block that names a smaller transport budget than was spent is refused.
    const shrunk = structuredClone(execution.evidence);
    shrunk.transportRetry!.maxRetries = MAX_TRANSPORT_RETRIES - 1;
    expect(readersAdmit(shrunk)).toBe(false);
  });
});

describe("transport waits honour Retry-After within retry.transportMaxDelayMs", () => {
  it("waits the exponential from retry.baseDelayMs by transport retry number", async () => {
    const { sleeps, execution } = await runScript(["malformed", "429", "429", "ok"]);
    // Contract retry 1, then transport retries 1 and 2: the transport
    // exponent counts transport retries, not attempts.
    expect(sleeps).toEqual([BASE_DELAY_MS, BASE_DELAY_MS, BASE_DELAY_MS * 2]);
    expect(readersAdmit(execution.evidence)).toBe(true);
  });

  it("waits as long as the provider's Retry-After asks, inside the bound", async () => {
    const retryAfterMs = TRANSPORT_MAX_DELAY_MS - 15_000;
    const { sleeps, execution } = await runScript(["429", "ok"], { retryAfterMs });
    expect(sleeps).toEqual([retryAfterMs]);
    expect(execution.evidence.attempts[0]?.backoffMs).toBe(retryAfterMs);
    expect(readersAdmit(execution.evidence)).toBe(true);
  });

  it("waits no longer than retry.transportMaxDelayMs for a longer Retry-After", async () => {
    const { sleeps, execution } = await runScript(["429", "ok"], {
      retryAfterMs: TRANSPORT_MAX_DELAY_MS * 10,
    });
    expect(sleeps).toEqual([TRANSPORT_MAX_DELAY_MS]);
    expect(readersAdmit(execution.evidence)).toBe(true);
    // A recorded wait past the bound is not the writer's formula.
    const forged = structuredClone(execution.evidence);
    forged.attempts[0]!.backoffMs = TRANSPORT_MAX_DELAY_MS + 1;
    expect(readersAdmit(forged)).toBe(false);
  });
});

describe("an exhausted transport budget stops the step by name", () => {
  it("names retry.maxTransportRetries with the observed count and its remediation", async () => {
    const script = Array<Step>(MAX_TRANSPORT_RETRIES + 2).fill("429");
    const { execution, seen } = await runScript(script);

    expect(seen).toHaveLength(MAX_TRANSPORT_RETRIES + 1);
    // No contract attempt was judged, so none was spent.
    expect(new Set(seen.map((entry) => entry.contractAttempt))).toEqual(new Set([1]));
    expect(execution.status).toBe("failed");
    if (execution.status !== "failed") throw new Error("expected a failed step");
    expect(execution.error.category).toBe("throttled");
    expect(execution.error.message).toContain(
      `Transport retries for this step stopped: retry-max-transport-retries-bound: ${MAX_TRANSPORT_RETRIES + 1} exceeds retry.maxTransportRetries = ${MAX_TRANSPORT_RETRIES} count.`,
    );
    expect(execution.error.message).toContain("Wait for the provider's rate limit");
    expect(execution.evidence.attempts.at(-1)).toMatchObject({
      outcome: "throttled",
      retryScheduled: false,
      retryDecision: "exhausted",
    });
    expect(readersAdmit(execution.evidence)).toBe(true);
    // The operator reads the transport count, not the untouched contract one.
    const readings = readRunRetryDispositions({
      steps: [{ id: "evaluate-document-quality", inference: execution.evidence }],
    } as unknown as RunRecord);
    expect(readings.map((reading) => reading.retriesRemaining)).toEqual([
      ...Array.from(
        { length: MAX_TRANSPORT_RETRIES },
        (_, index) => MAX_TRANSPORT_RETRIES - index - 1,
      ),
      0,
    ]);
  });

  it("names retry.transportMaxElapsedMs once the step's transport wall clock is spent", async () => {
    // Four attempts plus their waits cross the bound by less than the waits
    // already recorded, so a reader that dropped recorded waits from the sum
    // would not call the fourth exhausted.
    const attemptMs = TRANSPORT_MAX_ELAPSED_MS / 4 - 3_000;
    const { execution, seen, sleeps } = await runScript(Array<Step>(8).fill("429"), { attemptMs });

    // Three attempts and their waits fit; the fourth attempt's wait does not.
    expect(seen).toHaveLength(4);
    const observed =
      4 * attemptMs + sleeps.reduce((sum, wait) => sum + wait, 0) + BASE_DELAY_MS * 8;
    if (execution.status !== "failed") throw new Error("expected a failed step");
    expect(execution.error.message).toContain(
      `retry-transport-max-elapsed-ms-bound: ${observed} exceeds retry.transportMaxElapsedMs = ${TRANSPORT_MAX_ELAPSED_MS} ms.`,
    );
    // Exhausted by the wall clock before the count: readers re-derive it from
    // the recorded durations and waits.
    expect(execution.evidence.attempts.at(-1)?.retryDecision).toBe("exhausted");
    expect(readersAdmit(execution.evidence)).toBe(true);
    // The operator line beside the named stop says the same thing.
    const step = {
      id: "evaluate-document-quality",
      inference: execution.evidence,
    } as unknown as RunRecord["steps"][number];
    expect(formatStepRetryDispositionSentence(step)).toContain(
      "retry decision exhausted-transport-elapsed on attempt 4",
    );
    expect(readTerminalRetryDisposition(step)?.retriesRemaining).toBe(0);
    // A reset writer keeps its configured retry budget; the host reset makes
    // replay safe even when the failed turn had executed writes.
    const resetWriter = {
      ...step,
      inference: {
        ...execution.evidence,
        replay: "reset-write-step",
        effectiveMaxRetries: execution.evidence.configuredMaxRetries,
      },
    } as unknown as RunRecord["steps"][number];
    expect(readTerminalRetryDisposition(resetWriter)?.retriesRemaining).toBe(0);
    // A forged wait that makes the wall clock fit contradicts the decision.
    const forged = structuredClone(execution.evidence);
    forged.attempts[2]!.durationMs = 0;
    expect(readersAdmit(forged)).toBe(false);
  });

  it("stops on the first transport fault when a host lowers the count to 0", async () => {
    const policy = parseRetryPolicy({ DOCSFAB_READ_ONLY_MAX_TRANSPORT_RETRIES: "0" });
    expect(policy.transport?.maxRetries).toBe(0);
    const { execution, seen } = await runScript(["429", "ok"], { policy });
    expect(seen).toHaveLength(1);
    if (execution.status !== "failed") throw new Error("expected a failed step");
    expect(execution.error.message).toContain(
      "retry-max-transport-retries-bound: 1 exceeds retry.maxTransportRetries = 0 count.",
    );
    expect(execution.evidence.attempts[0]?.retryDecision).toBe("declined");
  });

  it("refuses a host override that would raise the count", () => {
    expect(() =>
      parseRetryPolicy({
        DOCSFAB_READ_ONLY_MAX_TRANSPORT_RETRIES: String(MAX_TRANSPORT_RETRIES + 1),
      }),
    ).toThrow(/DOCSFAB_READ_ONLY_MAX_TRANSPORT_RETRIES/u);
  });

  it("allows the host-reset revision writer to retry transport faults", async () => {
    // The CREATE revision writer may replay a transport failure after its host
    // restores candidate 0, even when its last settled tool call wrote files.
    const { execution, seen } = await runScript(["429", "ok"], {
      mode: "write",
      hostResetsWrites: true,
      writeSettlement: "write-executed",
    });
    expect(seen).toHaveLength(2);
    expect(execution.evidence.replay).toBe("reset-write-step");
    expect(execution.evidence.transportRetry?.categories).toEqual([
      "throttled",
      "provider-transient",
    ]);
    expect(execution.evidence.attempts[0]?.retryScheduled).toBe(true);
  });

  it("retries a disabled write step only when the attempt ledger proves no write ran", async () => {
    const { execution, seen } = await runScript(["429", "ok"], {
      mode: "write",
      writeSettlement: "no-write",
    });
    expect(seen.map((entry) => entry.contractAttempt)).toEqual([1, 1]);
    expect(execution.status).toBe("succeeded");
    expect(execution.evidence.transportRetry?.categories).toEqual([
      "throttled",
      "provider-transient",
    ]);
    expect(execution.evidence.attempts[0]).toMatchObject({
      writeSettlement: "no-write",
      retryScheduled: true,
      retryRule: "retried-transport",
    });
  });

  it("keeps a transport failure terminal after a settled write", async () => {
    const { execution, seen } = await runScript(["429", "ok"], {
      mode: "write",
      writeSettlement: "write-executed",
    });
    expect(seen).toHaveLength(1);
    expect(execution.evidence.transportRetry?.categories).toEqual([
      "throttled",
      "provider-transient",
    ]);
    if (execution.status !== "failed") throw new Error("expected a failed step");
    expect(execution.evidence.attempts[0]).toMatchObject({
      writeSettlement: "write-executed",
      retryScheduled: false,
      retryRule: "declined-write-step",
    });
  });

  it.each([
    ["missing settlement evidence", undefined],
    ["unreadable settlement evidence", "unavailable"],
  ] as const)("keeps a write transport failure terminal with %s", async (_label, settlement) => {
    const { execution, seen } = await runScript(["429", "ok"], {
      mode: "write",
      ...(settlement === undefined ? {} : { writeSettlement: settlement }),
    });
    expect(seen).toHaveLength(1);
    if (execution.status !== "failed") throw new Error("expected a failed step");
    expect(execution.evidence.attempts[0]).toMatchObject({
      retryScheduled: false,
      retryRule: "declined-write-step",
    });
  });

  it("keeps an in-flight or unrecognized mutator terminal when the ledger is ambiguous", async () => {
    const { execution, seen } = await runScript(["stream-incomplete", "ok"], {
      mode: "write",
      writeSettlement: "unavailable",
    });
    expect(seen).toHaveLength(1);
    if (execution.status !== "failed") throw new Error("expected a failed step");
    expect(execution.evidence.attempts[0]).toMatchObject({
      outcome: "provider-transient",
      retryScheduled: false,
      retryRule: "declined-write-step",
    });
  });
});
