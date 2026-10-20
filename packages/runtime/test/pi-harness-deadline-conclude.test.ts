// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * A read-only step stuck in a loop of distinct read and search calls never
 * trips the read-loop stop, which counts only unchanged re-reads, so it used to
 * read until the attempt timer ended the attempt. The host now asks it to
 * conclude once only its answer reserve remains, through the answer-now
 * machinery, and a timer that still fires inside the tool loop is a bound.
 *
 * Cases drive `PiHarness.runStep` against the real Pi session with a scripted
 * provider and an injected clock, or fake timers for the attempt timer.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { setImmediate } from "node:timers";

import { parseRetryPolicy } from "../src/config/retry-policy.js";
import { OUTPUT_HOST_TEXT } from "../src/contracts/model-output.generated.js";
import {
  concludeBeforeDeadlineAtMs,
  resolveAnswerNowPolicy,
  stepAnswerNowPlan,
} from "../src/harness/answer-now.js";
import {
  PI_ANSWER_NOW_PROMPT,
  PI_ANSWER_NOW_TOOL_REFUSAL,
  PI_DEADLINE_CONCLUDE_NOW_PROMPT,
} from "../src/harness/pi-session.js";
import {
  formatAnswerAskedEarlyLines,
  readAnswersAskedEarly,
} from "../src/operator/answer-asked-early.js";
import { classifyInferenceAttempt } from "../src/operator/failure-classification.js";
import { inferenceAttemptRulesConsistent } from "../src/records/inference-retry-rule.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";
import {
  boundStyleContext,
  createProviderConnectionFactory,
  createRepository,
  executeInferenceStep,
  fixtureCompositionExecutionProfile,
  PiHarness,
  qualityDirectory,
  resetSharedTestState,
  reviewStepInput,
  scriptedProvider,
  skillCrateDirectory,
  stepInput,
  textTurn,
  toolTurn,
  validModelConfig,
} from "./support/pi-harness-session-fixtures.js";
import {
  FIXTURE_REPORT,
  qualityStepInput,
  rawToolCallTurn,
  submissionCall,
  toolPathHarness,
  toolResults,
  userText,
} from "./support/answer-submission-fixtures.js";

/** Run admission resolves the bound style profile once; every harness here reads it. */
const styleContext = await boundStyleContext();

/** Hold the real Pi ls tool's filesystem result in the delayed-I/O regression. */
const delayedLsRead = vi.hoisted(() => ({
  repositoryPath: undefined as string | undefined,
  reached: undefined as (() => void) | undefined,
  release: undefined as (() => void) | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readdir: async (...args: Parameters<typeof actual.readdir>) => {
      const result = await actual.readdir(...args);
      if (delayedLsRead.repositoryPath && String(args[0]).includes(delayedLsRead.repositoryPath)) {
        delayedLsRead.repositoryPath = undefined;
        delayedLsRead.reached?.();
        await new Promise<void>((resolve) => {
          delayedLsRead.release = resolve;
        });
      }
      return result;
    },
  };
});

afterEach(async () => {
  vi.restoreAllMocks();
  delayedLsRead.release?.();
  delayedLsRead.repositoryPath = undefined;
  delayedLsRead.reached = undefined;
  delayedLsRead.release = undefined;
  vi.useRealTimers();
  await resetSharedTestState();
});

/** The attempt timer 13 of the 16 registered compositions seal. */
const SHORT_ATTEMPT_TIMEOUT_MS = 300_000;
/**
 * Literal oracles: 300,000 ms less each step's own answer reserve, its planned
 * answer at 80 tokens per second plus two 25,000 ms turns. The editorial
 * review plans 5,500 tokens (118,750 ms); step 8 plans 11,800 (197,500 ms).
 */
const EDITORIAL_CONCLUDE_AT_MS = 181_250;
const QUALITY_CONCLUDE_AT_MS = 102_500;
const FIXTURE_MAX_PROVIDER_TURNS = 8;
const TARGET = "README.md";

interface RecordedRequest {
  tools?: unknown;
  messages?: Array<{
    role?: unknown;
    content?: unknown;
    tool_call_id?: unknown;
  }>;
}

function textOf(content: unknown): string {
  if (Array.isArray(content)) {
    return content.map((part) => (part as { text?: string }).text ?? "").join("");
  }
  return typeof content === "string" ? content : "";
}

function userTexts(request: RecordedRequest): string[] {
  return (request.messages ?? [])
    .filter((message) => message.role === "user")
    .map((message) => textOf(message.content));
}

function toolResultText(request: RecordedRequest, toolCallId: string): string | undefined {
  const message = (request.messages ?? []).find(
    (candidate) => candidate.role === "tool" && candidate.tool_call_id === toolCallId,
  );
  return message ? textOf(message.content) : undefined;
}

/** A mutable clock the harness reads for every elapsed decision in an attempt. */
function testClock(startedAt = 1_000_000) {
  let value = startedAt;
  return {
    now: () => value,
    advanceTo: (elapsedMs: number) => {
      value = startedAt + elapsedMs;
    },
  };
}

/** Records each request and moves the clock once request `afterRequest` was sent. */
function clockedProvider(
  responses: readonly Response[],
  clock: ReturnType<typeof testClock>,
  schedule: { afterRequest: number; elapsedMs: number },
) {
  const requests: RecordedRequest[] = [];
  const provider = scriptedProvider(responses);
  const fetchMock = vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    if (requests.length === schedule.afterRequest) clock.advanceTo(schedule.elapsedMs);
    return provider(request, init);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { requests, fetchMock };
}

function compositionHarness(timeoutMs: number, now?: () => number): PiHarness {
  const executionProfile = fixtureCompositionExecutionProfile({
    maxProviderTurns: FIXTURE_MAX_PROVIDER_TURNS,
    timeoutMs,
  });
  return new PiHarness({
    skillCrateDirectory,
    qualityDirectory,
    styleContext,
    executionProfile,
    credential: { family: "nvidia-inference-api", apiKey: validModelConfig.apiKey },
    providerConnectionFactory: createProviderConnectionFactory({
      routeId: executionProfile.routeId,
      transport: executionProfile.transport,
    }),
    ...(now ? { now } : {}),
  });
}

/** The editorial review's answer: a read-only step the host does not degrade. */
const EDITORIAL_REPLY = JSON.stringify({
  verdict: "needs-revision",
  issues: [
    {
      id: "TECH-001",
      severity: "major",
      category: "technical_accuracy",
      location: `${TARGET}:12`,
      finding: "The command omits a required flag.",
      evidence: { source_id: "source-1", locator: "src/cli.ts:42" },
      required_change: "Add the required flag.",
    },
  ],
});

/** Three distinct read and search calls: nothing the read-loop stop counts. */
const distinctReads = () => [
  toolTurn([{ id: "loop-ls", name: "ls", arguments: { path: "." } }]),
  toolTurn([{ id: "loop-find", name: "find", arguments: { pattern: "*.md" } }]),
  toolTurn([{ id: "loop-grep", name: "grep", arguments: { pattern: "flag", path: "." } }]),
];

describe("PiHarness conclude-before-deadline ask for a read-only step", () => {
  it("states the points the fixtures pin, where a small-answer step reads longer than step 8", () => {
    const at = (stepId: string) =>
      concludeBeforeDeadlineAtMs(
        SHORT_ATTEMPT_TIMEOUT_MS,
        resolveAnswerNowPolicy({ environment: {} }),
        stepAnswerNowPlan(stepId, validModelConfig.profile.maxOutputTokens, { environment: {} }),
      );
    expect(at("review-documentation")).toBe(EDITORIAL_CONCLUDE_AT_MS);
    expect(at("evaluate-document-quality")).toBe(QUALITY_CONCLUDE_AT_MS);
    expect(EDITORIAL_CONCLUDE_AT_MS).toBeGreaterThan(QUALITY_CONCLUDE_AT_MS);
  });

  it("asks a distinct-call loop to conclude before the deadline, denies later calls, and admits the answer", async () => {
    const repositoryPath = await createRepository();
    const input = reviewStepInput(repositoryPath, "review-documentation");
    expect(input.step.mode).toBe("read-only");
    const clock = testClock();
    const lateCall = toolTurn([{ id: "late-ls", name: "ls", arguments: { path: "." } }]);
    const { requests, fetchMock } = clockedProvider(
      [...distinctReads(), lateCall, textTurn(EDITORIAL_REPLY)],
      clock,
      // The clock reaches the point while the third distinct call is in flight.
      { afterRequest: 3, elapsedMs: EDITORIAL_CONCLUDE_AT_MS },
    );

    const result = await compositionHarness(SHORT_ATTEMPT_TIMEOUT_MS, clock.now).runStep(input);

    expect(fetchMock).toHaveBeenCalledTimes(5);
    // No ask while the distinct calls ran, then exactly one, which stays in
    // the history; the step's own deadline wording, not the judgment ask.
    expect(requests.map((request) => userTexts(request).at(-1))).toEqual([
      expect.not.stringContaining("DocsFab withdrew"),
      expect.not.stringContaining("DocsFab withdrew"),
      expect.not.stringContaining("DocsFab withdrew"),
      PI_DEADLINE_CONCLUDE_NOW_PROMPT,
      PI_DEADLINE_CONCLUDE_NOW_PROMPT,
    ]);
    expect(
      requests.map(
        (request) =>
          userTexts(request).filter((text) => text === PI_DEADLINE_CONCLUDE_NOW_PROMPT).length,
      ),
    ).toEqual([0, 0, 0, 1, 1]);
    expect(userTexts(requests[3]!)).not.toContain(PI_ANSWER_NOW_PROMPT);
    // The tools stay offered; a call after the ask is refused, not run.
    expect(requests[3]!.tools).toEqual(requests[0]!.tools);
    expect(toolResultText(requests[3]!, "loop-grep")).not.toBe(PI_ANSWER_NOW_TOOL_REFUSAL);
    expect(toolResultText(requests[4]!, "late-ls")).toBe(PI_ANSWER_NOW_TOOL_REFUSAL);
    expect(result.executionLease).toMatchObject({
      terminalReason: "completed",
      providerTurns: 5,
      toolCalls: { requested: 4, executed: 3, denied: 1 },
    });
    // The attempt says why and after which turn the host asked.
    expect(result.concludeNow).toEqual({ trigger: "attempt-deadline", turn: 3 });
  });

  it.each([
    ["one millisecond before its own point", EDITORIAL_CONCLUDE_AT_MS - 1],
    ["at step 8's earlier point", QUALITY_CONCLUDE_AT_MS],
  ])("keeps the tools %s", async (_label, elapsedMs) => {
    const repositoryPath = await createRepository();
    const input = reviewStepInput(repositoryPath, "review-documentation");
    const clock = testClock();
    const { requests, fetchMock } = clockedProvider(
      [...distinctReads(), textTurn(EDITORIAL_REPLY)],
      clock,
      { afterRequest: 3, elapsedMs },
    );

    const result = await compositionHarness(SHORT_ATTEMPT_TIMEOUT_MS, clock.now).runStep(input);

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(requests.flatMap(userTexts)).not.toContain(PI_DEADLINE_CONCLUDE_NOW_PROMPT);
    expect(result.executionLease).toMatchObject({ toolCalls: { executed: 3, denied: 0 } });
    expect(result.concludeNow).toBeUndefined();
  });

  it("records the ask on the attempt, where the record reader admits it and the summary counts it", async () => {
    const repositoryPath = await createRepository();
    const input = reviewStepInput(repositoryPath, "review-documentation");
    const clock = testClock();
    clockedProvider([...distinctReads(), textTurn(EDITORIAL_REPLY)], clock, {
      afterRequest: 3,
      elapsedMs: EDITORIAL_CONCLUDE_AT_MS,
    });
    const harness = compositionHarness(SHORT_ATTEMPT_TIMEOUT_MS, clock.now);

    const execution = await executeInferenceStep({
      mode: input.step.mode,
      policy: parseRetryPolicy({}),
      evidenceIdentity: input.evidenceIdentity,
      sleep: async () => {},
      execute: (attempt) => harness.runStep({ ...input, inferenceAttempt: attempt }),
    });

    expect(execution.status).toBe("succeeded");
    const [attempt] = execution.evidence.attempts;
    expect(attempt).toMatchObject({
      outcome: "succeeded",
      concludeNow: { trigger: "attempt-deadline", turn: 3 },
    });
    // A first attempt, scheduled by no conclude-now rule, may carry a timed ask.
    expect(inferenceAttemptRulesConsistent(execution.evidence, execution.evidence.attempts)).toBe(
      true,
    );
    const readings = readAnswersAskedEarly({
      steps: [{ id: input.step.id, inference: execution.evidence } as never],
    });
    expect(formatAnswerAskedEarlyLines(readings)).toEqual([
      "Answers asked early: 1 attempt was asked to answer from what the model had read, so its reading was cut short.",
      "Asked early: review-documentation attempt 1 after turn 3, because only its answer reserve was left before the attempt deadline (outcome succeeded).",
    ]);
  });

  it("asks the tool-call answer path for its submission, then for the report", async () => {
    const repositoryPath = await createRepository();
    const input = await qualityStepInput(repositoryPath);
    const evaluation = {
      evaluation_id: "eval-1",
      overall_decision: "insufficient-evidence",
      note: "Evaluated from the pages read before the deadline.",
    };
    const responses = [
      rawToolCallTurn([{ id: "read-1", name: "read", chunks: [JSON.stringify({ path: TARGET })] }]),
      rawToolCallTurn([{ id: "ls-1", name: "ls", chunks: [JSON.stringify({ path: "." })] }], {
        created: 2,
      }),
      rawToolCallTurn(
        [submissionCall("submit-1", JSON.stringify({ evaluation, qualityScore: null }))],
        { created: 3 },
      ),
      textTurn(FIXTURE_REPORT),
    ];
    const clock = testClock();
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      if (bodies.length === 2) clock.advanceTo(QUALITY_CONCLUDE_AT_MS);
      const response = responses[bodies.length - 1];
      if (!response) throw new Error("Unexpected provider request.");
      return response.clone();
    });

    const result = await toolPathHarness({
      timeoutMs: SHORT_ATTEMPT_TIMEOUT_MS,
      now: clock.now,
    }).runStep(input);

    expect(bodies).toHaveLength(4);
    expect(userText(bodies[1]!)).not.toContain(
      OUTPUT_HOST_TEXT["quality-submission-deadline-conclude-ask"],
    );
    expect(userText(bodies[2]!)).toContain(
      OUTPUT_HOST_TEXT["quality-submission-deadline-conclude-ask"],
    );
    expect(userText(bodies[2]!)).not.toContain(PI_DEADLINE_CONCLUDE_NOW_PROMPT);
    expect(toolResults(bodies[3]!).get("submit-1")).toBe(
      OUTPUT_HOST_TEXT["quality-submission-acknowledgement"],
    );
    expect(userText(bodies[3]!)).toContain(OUTPUT_HOST_TEXT["quality-submission-report-ask"]);
    expect(result.qualityArtifactCandidate?.evaluation).toEqual(evaluation);
    expect(result.concludeNow).toEqual({ trigger: "attempt-deadline", turn: 2 });
  });

  it("never asks a write step, whose tools make its change", async () => {
    const repositoryPath = await createRepository();
    const readOnly = stepInput(repositoryPath);
    const input = { ...readOnly, step: { ...readOnly.step, mode: "write" as const } };
    const clock = testClock();
    const { requests } = clockedProvider([...distinctReads(), textTurn("Audit complete.")], clock, {
      afterRequest: 1,
      elapsedMs: SHORT_ATTEMPT_TIMEOUT_MS - 1,
    });

    await compositionHarness(SHORT_ATTEMPT_TIMEOUT_MS, clock.now)
      .runStep(input)
      .catch(() => undefined);

    expect(requests.length).toBeGreaterThan(1);
    expect(requests.flatMap(userTexts)).not.toContain(PI_DEADLINE_CONCLUDE_NOW_PROMPT);
  });
});

/** A real Pi session start-up; the attempt timer runs on a fake clock. */
const SESSION = testTimeoutMs(20_000);
/** Under the answer reserve, so no ask arms and only the timer ends the loop. */
const TINY_ATTEMPT_TIMER_MS = 60_000;

/** Run out the attempt clock only after the intended provider state is observed. */
async function runOutTimer(request: Promise<void>, timerMs: number, firstByte?: Promise<void>) {
  await request;
  if (firstByte) await firstByte;
  // Give the transport one real event-loop turn to record the consumed byte.
  await new Promise<void>((resolve) => setImmediate(resolve));
  await vi.advanceTimersByTimeAsync(timerMs);
}

/**
 * A response that delivers the first SSE event of `body`, then stalls until the
 * request is aborted. Read `body` before fake timers start.
 */
function stalledAfterFirstEvent(
  body: string,
  init?: RequestInit,
  onFirstByte?: () => void,
): Promise<Response> {
  const first = `${body.split("\n\n")[0]!}\n\n`;
  const signal = init?.signal;
  const abort = () => {
    signal?.removeEventListener("abort", abort);
    controller.error(signal?.reason ?? new Error("aborted"));
  };
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
      controller.enqueue(new TextEncoder().encode(first));
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
    },
    pull() {
      // With one queued event, pull runs once the consumer takes that event.
      onFirstByte?.();
      onFirstByte = undefined;
    },
    cancel() {
      signal?.removeEventListener("abort", abort);
    },
  });
  return Promise.resolve(
    new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }),
  );
}

/** A request that never sends a byte until it is aborted. */
function silentRequest(init?: RequestInit): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    const abort = () => reject(signal?.reason ?? new Error("aborted"));
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

/** Provider handlers in request order; past the last one every request is silent. */
function sequencedProvider(
  handlers: ReadonlyArray<(init?: RequestInit) => Promise<Response>>,
  onRequest?: (count: number) => void,
) {
  let count = 0;
  const reached = new Map<number, Array<() => void>>();
  const fetchMock = vi.fn((_request: RequestInfo | URL, init?: RequestInit) => {
    count += 1;
    onRequest?.(count);
    for (const resolve of reached.get(count) ?? []) resolve();
    reached.delete(count);
    const handler = handlers[count - 1];
    return handler ? handler(init) : silentRequest(init);
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    fetchMock,
    request: (ordinal: number) =>
      count >= ordinal
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            reached.set(ordinal, [...(reached.get(ordinal) ?? []), resolve]);
          }),
  };
}

async function timedOutAttempt(
  input: ReturnType<typeof stepInput>,
  harness: PiHarness,
  request: Promise<void>,
  timerMs: number,
  firstByte?: Promise<void>,
  beforeTimer?: Promise<void>,
) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const execution = executeInferenceStep({
    mode: input.step.mode,
    policy: parseRetryPolicy({ DOCSFAB_READ_ONLY_MAX_RETRIES: "0" }),
    evidenceIdentity: input.evidenceIdentity,
    sleep: async () => {},
    execute: (attempt) => harness.runStep({ ...input, inferenceAttempt: attempt }),
  });
  if (beforeTimer) await beforeTimer;
  await runOutTimer(request, timerMs, firstByte);
  const outcome = await execution;
  expect(outcome.status).toBe("failed");
  const [attempt] = outcome.evidence.attempts;
  expect(attempt).toMatchObject({ outcome: "timeout", condition: "attempt-deadline" });
  return attempt!;
}

describe("where the attempt timer found the attempt", () => {
  it(
    "is a provider stall when a request after one tool turn never sends a byte",
    async () => {
      const repositoryPath = await createRepository();
      const input = stepInput(repositoryPath);
      const provider = sequencedProvider([
        async () => toolTurn([{ id: "loop-ls", name: "ls", arguments: { path: "." } }]),
      ]);
      const attempt = await timedOutAttempt(
        input,
        compositionHarness(TINY_ATTEMPT_TIMER_MS),
        provider.request(2),
        TINY_ATTEMPT_TIMER_MS,
      );

      expect(attempt.deadlineTurn).toBe("awaiting-first-byte");
      expect(attempt.modelTelemetry?.finishReason).toBe("tool-use");
      expect(classifyInferenceAttempt(attempt)).toEqual({
        class: "infrastructure",
        layer: "inference",
        code: "attempt-deadline-awaiting-provider",
      });
    },
    SESSION,
  );

  it(
    "is a tool loop when the model is streaming its next tool calls",
    async () => {
      const repositoryPath = await createRepository();
      const input = stepInput(repositoryPath);
      const nextCalls = await toolTurn([
        { id: "loop-find", name: "find", arguments: { pattern: "*.md" } },
      ]).text();
      let receivedFirstByte!: () => void;
      const firstByte = new Promise<void>((resolve) => {
        receivedFirstByte = resolve;
      });
      const provider = sequencedProvider([
        async () => toolTurn([{ id: "loop-ls", name: "ls", arguments: { path: "." } }]),
        (init) => stalledAfterFirstEvent(nextCalls, init, receivedFirstByte),
      ]);
      const attempt = await timedOutAttempt(
        input,
        compositionHarness(TINY_ATTEMPT_TIMER_MS),
        provider.request(2),
        TINY_ATTEMPT_TIMER_MS,
        firstByte,
      );

      // The composition transport buffers the response, so the timer sees
      // body bytes arriving, not which kind of output they carry.
      expect(attempt.deadlineTurn).toBe("streaming");
      expect(classifyInferenceAttempt(attempt)).toEqual({
        class: "bound",
        layer: "inference",
        code: "attempt-deadline-in-tool-loop",
      });
    },
    SESSION,
  );

  it(
    "waits for a delayed real Pi ls read before timing the next streamed tool call",
    async () => {
      const repositoryPath = await createRepository();
      const input = stepInput(repositoryPath);
      const nextCalls = await toolTurn([
        { id: "loop-find", name: "find", arguments: { pattern: "*.md" } },
      ]).text();
      let reachedLs!: () => void;
      const lsReached = new Promise<void>((resolve) => {
        reachedLs = resolve;
      });
      let receivedFirstByte!: () => void;
      const firstByte = new Promise<void>((resolve) => {
        receivedFirstByte = resolve;
      });
      delayedLsRead.repositoryPath = repositoryPath;
      delayedLsRead.reached = reachedLs;
      const provider = sequencedProvider([
        async () => toolTurn([{ id: "loop-ls", name: "ls", arguments: { path: "." } }]),
        (init) => stalledAfterFirstEvent(nextCalls, init, receivedFirstByte),
      ]);
      const advanceTimer = vi.advanceTimersByTimeAsync.bind(vi);
      vi.spyOn(vi, "advanceTimersByTimeAsync").mockImplementation(async (duration) => {
        const requests = provider.fetchMock.mock.calls.length;
        if (requests !== 2) {
          throw new Error(
            `fake attempt clock advanced with ${requests} requests while Pi ls was pending`,
          );
        }
        await advanceTimer(duration);
      });
      const ioReleased = lsReached.then(
        () =>
          new Promise<number>((resolve) =>
            setImmediate(() => {
              const requestsBeforeRelease = provider.fetchMock.mock.calls.length;
              delayedLsRead.release?.();
              resolve(requestsBeforeRelease);
            }),
          ),
      );
      const attempt = await timedOutAttempt(
        input,
        compositionHarness(TINY_ATTEMPT_TIMER_MS),
        provider.request(2),
        TINY_ATTEMPT_TIMER_MS,
        firstByte,
        lsReached,
      );
      expect(await ioReleased).toBe(1);

      expect(provider.fetchMock).toHaveBeenCalledTimes(2);
      expect(attempt.deadlineTurn).toBe("streaming");
      expect(classifyInferenceAttempt(attempt)).toEqual({
        class: "bound",
        layer: "inference",
        code: "attempt-deadline-in-tool-loop",
      });
    },
    SESSION,
  );

  it(
    "is not a tool loop when the answer the host asked for is streaming",
    async () => {
      const repositoryPath = await createRepository();
      const input = reviewStepInput(repositoryPath, "review-documentation");
      const clock = testClock();
      const answer = await textTurn(EDITORIAL_REPLY).text();
      let receivedFirstByte!: () => void;
      const firstByte = new Promise<void>((resolve) => {
        receivedFirstByte = resolve;
      });
      const provider = sequencedProvider(
        [
          async () => toolTurn([{ id: "loop-ls", name: "ls", arguments: { path: "." } }]),
          (init) => stalledAfterFirstEvent(answer, init, receivedFirstByte),
        ],
        // The reserve point passes while the tool turn runs, so the second
        // request carries the ask for the answer.
        (count) => {
          if (count === 1) clock.advanceTo(EDITORIAL_CONCLUDE_AT_MS);
        },
      );
      const attempt = await timedOutAttempt(
        input,
        compositionHarness(SHORT_ATTEMPT_TIMEOUT_MS, clock.now),
        provider.request(2),
        SHORT_ATTEMPT_TIMEOUT_MS,
        firstByte,
      );

      expect(attempt.concludeNow).toEqual({ trigger: "attempt-deadline", turn: 1 });
      expect(attempt.deadlineTurn).toBe("streaming");
      expect(attempt.modelTelemetry?.finishReason).toBe("tool-use");
      expect(classifyInferenceAttempt(attempt)).toEqual({
        class: "unknown",
        layer: "inference",
        code: "timeout",
      });
    },
    SESSION,
  );
});

describe("classifying an attempt-deadline timeout", () => {
  /** A timed-out attempt whose last landed turn stopped with `rawStopReason`. */
  const timedOut = (
    condition: string | undefined,
    rawStopReason: string | undefined,
    deadlineTurn?: string,
    asked = false,
  ) =>
    classifyInferenceAttempt({
      attempt: 1,
      outcome: "timeout",
      retryable: true,
      retryScheduled: false,
      ...(condition === undefined ? {} : { condition }),
      ...(deadlineTurn === undefined ? {} : { deadlineTurn }),
      ...(asked ? { concludeNow: { trigger: "attempt-deadline", turn: 2 } } : {}),
      turns: rawStopReason === undefined ? [] : [{ rawStopReason }],
    } as unknown as Parameters<typeof classifyInferenceAttempt>[0]);
  const toolLoop = { class: "bound", layer: "inference", code: "attempt-deadline-in-tool-loop" };
  const unknownTimeout = { class: "unknown", layer: "inference", code: "timeout" };
  const providerStall = {
    class: "infrastructure",
    layer: "inference",
    code: "attempt-deadline-awaiting-provider",
  };

  it("is a tool loop only with evidence the model was producing tool calls", () => {
    expect(timedOut("attempt-deadline", "tool_calls", "between-requests")).toEqual(toolLoop);
    expect(timedOut("attempt-deadline", "tool_calls", "streaming-tool-call")).toEqual(toolLoop);
    expect(timedOut("attempt-deadline", "tool_calls", "streaming")).toEqual(toolLoop);
    // A model that ignored the ask and kept calling tools is still a loop.
    expect(timedOut("attempt-deadline", "tool_calls", "between-requests", true)).toEqual(toolLoop);
  });

  it("is a provider stall when a request had no first byte, whatever came before", () => {
    expect(timedOut("attempt-deadline", "tool_calls", "awaiting-first-byte")).toEqual(
      providerStall,
    );
    expect(timedOut("attempt-deadline", "tool_calls", "awaiting-first-byte", true)).toEqual(
      providerStall,
    );
    expect(timedOut("attempt-deadline", undefined, "awaiting-first-byte")).toEqual(providerStall);
  });

  it("stays an unknown timeout for an answer in flight, a provider timeout, or no evidence", () => {
    expect(timedOut("attempt-deadline", "tool_calls", "streaming-answer")).toEqual(unknownTimeout);
    // Output streaming after the ask is the answer.
    expect(timedOut("attempt-deadline", "tool_calls", "streaming", true)).toEqual(unknownTimeout);
    // A record without where the timer found it claims nothing.
    expect(timedOut("attempt-deadline", "tool_calls")).toEqual(unknownTimeout);
    expect(timedOut("provider-timeout", "tool_calls", "between-requests")).toEqual(unknownTimeout);
    expect(timedOut("attempt-deadline", "stop", "between-requests")).toEqual(unknownTimeout);
    expect(timedOut(undefined, "tool_calls")).toEqual(unknownTimeout);
  });
});
