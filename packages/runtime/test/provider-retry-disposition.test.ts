// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * What the writer records about retry disposition.
 *
 * "This condition cannot be retried" is a property of the error; "this run did
 * not retry it" is a property of the run. `retryable` must answer the first in
 * both directions: a deterministic response-size overflow is not a retryable
 * transient, and a throttle or blank answer the execution mode declined to
 * retry is not terminal.
 *
 * Every case drives a deterministic provider through the real bounded in-turn
 * replay (`withBoundedProviderTurnRetry`), the real settled-turn projection
 * (`assistantTurnFailure`), and the real record projection
 * (`executeInferenceStep`). The subject is what reaches
 * `steps[].inference.attempts[]`, not the classifier on its own.
 *
 * Each fixture carries its own repository revision and provider error text, so
 * an assertion reading another fixture's record reads the wrong identity.
 */
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { parseRetryPolicy } from "../src/config/retry-policy.js";
import type { InferenceRetryPolicy } from "../src/execution/contracts.js";
import { InferenceStepError } from "../src/execution/contracts.js";
import { assistantTurnFailure } from "../src/harness/pi-offline.js";
import { classifyModelFailure } from "../src/model/context-budget.js";
import { ProviderResponseLimitError } from "../src/model/provider.js";
import {
  DEFAULT_PROVIDER_TURN_RETRY_POLICY,
  describeProviderTurnReplayVeto,
  withBoundedProviderTurnRetry,
  type ProviderTurnReplayProbe,
} from "../src/model/provider-turn-retry.js";
import {
  CONFIGURABLE_RETRY_CATEGORIES,
  INFERENCE_FAILURE_CATEGORIES,
} from "../src/inference-attempt-taxonomy.js";
import type {
  InferenceAttemptEvidence,
  InferenceExecutionEvidence,
  InferenceFailureCategory,
} from "../src/records/contracts.js";
import {
  INFERENCE_RETRY_DISPOSITION_UNAVAILABLE,
  readInferenceRetryDisposition,
} from "../src/records/inference-retry-disposition.js";
import type { StepMode } from "../src/workflow-contracts/contracts.js";
import { executeInferenceStep } from "../src/workflow-execution/retry.js";

type StreamSimple = ModelRuntime["streamSimple"];
type ProviderEvent = {
  type: string;
  reason?: string;
  error?: { errorMessage?: string; stopReason?: string };
  message?: unknown;
};

/** The front-door shapes the provider route answers with. */
const ROUTE_503 = '503: {"message":"litellm.ServiceUnavailableError: upstream unavailable"}';
const ROUTE_429 = '429: {"message":"litellm.RateLimitError: rate limit exceeded"}';
const ROUTE_408 = '408: {"message":"litellm.Timeout: Connection timed out."}';
const ROUTE_CONTEXT_400 =
  "400: litellm.ContextWindowExceededError: litellm.BadRequestError: BedrockException: Context Window Error - prompt is too long: 1009642 tokens > 1000000 maximum";
const ROUTE_INVALID_400 = "400: request body does not match the provider schema";
/** The shipped refusal text, taken from the shipped error rather than retyped. */
const RESPONSE_OVERFLOW = new ProviderResponseLimitError(65_536).message;

/** The shipped default retryable set, as `.env.example` lists it. */
const SHIPPED_RETRYABLE_CATEGORIES: readonly InferenceFailureCategory[] = [
  ...CONFIGURABLE_RETRY_CATEGORIES,
];

/**
 * Minimal stand-in for Pi's AssistantMessageEventStream, which Pi does not
 * export. The replay wrapper builds its output stream from the delegate's own
 * constructor, so the fake exercises the seam production uses.
 */
class FakeEventStream {
  private readonly queue: ProviderEvent[] = [];
  private readonly waiting: Array<(value: IteratorResult<ProviderEvent>) => void> = [];
  private complete = false;

  public push(event: ProviderEvent): void {
    if (this.complete) return;
    if (event.type === "done" || event.type === "error") this.complete = true;
    const waiter = this.waiting.shift();
    if (waiter) waiter({ value: event, done: false });
    else this.queue.push(event);
  }

  public end(): void {
    this.complete = true;
    while (this.waiting.length > 0) {
      this.waiting.shift()!({ value: undefined as never, done: true });
    }
  }

  public async *[Symbol.asyncIterator](): AsyncIterator<ProviderEvent> {
    while (true) {
      if (this.queue.length > 0) {
        yield this.queue.shift()!;
        continue;
      }
      if (this.complete) return;
      const next = await new Promise<IteratorResult<ProviderEvent>>((resolve) =>
        this.waiting.push(resolve),
      );
      if (next.done) return;
      yield next.value;
    }
  }
}

function errorTurn(errorMessage: string): FakeEventStream {
  const stream = new FakeEventStream();
  stream.push({ type: "start" });
  stream.push({ type: "error", error: { errorMessage } });
  return stream;
}

/** The provider published content and only then failed: half a message exists. */
function committedErrorTurn(errorMessage: string): FakeEventStream {
  const stream = new FakeEventStream();
  stream.push({ type: "start" });
  stream.push({ type: "text_delta" });
  stream.push({ type: "error", error: { errorMessage } });
  return stream;
}

/** The empty assistant turn: the stream completed carrying nothing. */
function blankTurn(): FakeEventStream {
  const stream = new FakeEventStream();
  stream.push({ type: "start" });
  stream.push({
    type: "done",
    reason: "stop",
    message: { content: [], stopReason: "stop", usage: { input: 1_200, output: 0 } },
  });
  return stream;
}

function answeredTurn(text: string): FakeEventStream {
  const stream = new FakeEventStream();
  stream.push({ type: "start" });
  stream.push({ type: "text_delta" });
  stream.push({
    type: "done",
    reason: "stop",
    message: { content: [{ type: "text", text }], stopReason: "stop" },
  });
  return stream;
}

interface GovernedTurnFixture {
  /** One factory per provider request of the governed turn; the last repeats. */
  turns: readonly (() => FakeEventStream)[];
  /**
   * DocsFab itself refused the request (origin, redirect, response-size, or
   * credential boundary), so the provider never answered it.
   */
  locallyDenied?: boolean;
}

interface GovernedTurnObservation {
  providerRequests: number;
  inTurnReplays: number;
  /** The settled assistant message, in the shape Pi's session state carries. */
  message: object;
}

async function runGovernedTurn(fixture: GovernedTurnFixture): Promise<GovernedTurnObservation> {
  let index = 0;
  let inTurnReplays = 0;
  const delegate = (() => {
    const factory = fixture.turns[Math.min(index, fixture.turns.length - 1)]!;
    index += 1;
    return factory();
  }) as unknown as StreamSimple;
  const wrapped = withBoundedProviderTurnRetry(delegate, {
    // The bounded waits are real policy, but this test is about what gets
    // recorded, not how long it took.
    sleep: async () => {},
    isReplayable: () => fixture.locallyDenied !== true,
    onRetry: () => {
      inTurnReplays += 1;
    },
  });
  const events: ProviderEvent[] = [];
  const stream = wrapped({} as never, { messages: [] } as never) as AsyncIterable<ProviderEvent>;
  for await (const event of stream) events.push(event);
  const terminal = events.at(-1);
  const message =
    terminal?.type === "error"
      ? { stopReason: "error", errorMessage: terminal.error?.errorMessage ?? "provider error" }
      : ((terminal as { message?: object } | undefined)?.message ?? {});
  return { providerRequests: index, inTurnReplays, message };
}

/**
 * What `harness/pi.ts` does between a settled provider turn and the step
 * failure it throws: the shipped `assistantTurnFailure` projection, then an
 * `InferenceStepError` carrying its category and retryable flag unchanged. A
 * blank final answer is the harness's own `blank-response` condition.
 */
function stepFailureFromProviderTurn(message: object): InferenceStepError | undefined {
  const failure = assistantTurnFailure(message);
  if (!failure) return undefined;
  if (failure.disposition === "blank") {
    return new InferenceStepError("Model returned a blank response.", "blank-response", true);
  }
  const classification = failure.classification;
  if (!classification) {
    throw new Error(`fixture settled without a classification: ${failure.disposition}`);
  }
  return new InferenceStepError(
    `Model request failed [${classification.category}; retryable=${classification.retryable}]: ${
      failure.detail ?? failure.disposition
    }`,
    classification.category,
    classification.retryable,
  );
}

/**
 * The host's ordinary rejection of an unusable answer:
 * `workflow-execution/review-response.ts` `fail()`, whose default is retryable.
 */
function hostRejection(): InferenceStepError {
  return new InferenceStepError(
    "Review response did not satisfy the host-owned structured contract.",
    "malformed-response",
    true,
  );
}

/**
 * A host refusal of a condition the taxonomy calls eligible: the
 * `malformed-response` `workflow-execution/review-response.ts` throws when the
 * shipped review schema cannot be loaded, which the host will not retry
 * whatever budget remains. It is how a record reaches the exhausted/declined
 * boundary with retries still available.
 */
function hostRefusal(): InferenceStepError {
  return new InferenceStepError(
    "The host-owned review response schema could not be loaded.",
    "malformed-response",
    false,
  );
}

interface RecordedStepFixture {
  /** Divergent per fixture: the recorded identity a swapped assertion would miss. */
  revision: string;
  mode: StepMode;
  policy: InferenceRetryPolicy;
  /** One governed-turn fixture per step attempt; the last repeats. */
  turns: readonly GovernedTurnFixture[];
  /** The host's own verdict on this step attempt, raised above the provider. */
  hostVerdict?: (attempt: number) => InferenceStepError | undefined;
}

interface RecordedStep {
  evidence: InferenceExecutionEvidence;
  observed: GovernedTurnObservation[];
  status: "succeeded" | "failed";
}

async function projectRecordedStep(fixture: RecordedStepFixture): Promise<RecordedStep> {
  const observed: GovernedTurnObservation[] = [];
  const execution = await executeInferenceStep({
    mode: fixture.mode,
    policy: fixture.policy,
    evidenceIdentity: { repositoryRevision: fixture.revision },
    sleep: async () => {},
    now: () => 0,
    execute: async (attempt) => {
      const turn = await runGovernedTurn(
        fixture.turns[Math.min(attempt - 1, fixture.turns.length - 1)]!,
      );
      observed.push(turn);
      const verdict = fixture.hostVerdict?.(attempt);
      if (verdict) throw verdict;
      const failure = stepFailureFromProviderTurn(turn.message);
      if (failure) throw failure;
      return { summary: `${fixture.revision} answered` };
    },
  });
  return { evidence: execution.evidence, observed, status: execution.status };
}

/** The two facts under test, read off a recorded attempt as a reader must. */
function disposition(attempt: InferenceAttemptEvidence): {
  outcome: string;
  retryable: boolean;
  retryScheduled: boolean;
  conditionRetryability: string;
  retryDecision: string;
} {
  return {
    outcome: attempt.outcome,
    retryable: attempt.retryable,
    retryScheduled: attempt.retryScheduled,
    ...readInferenceRetryDisposition(attempt),
  };
}

const readOnlyPolicy = (
  maxRetries: number,
  retryableCategories: readonly InferenceFailureCategory[] = SHIPPED_RETRYABLE_CATEGORIES,
): InferenceRetryPolicy => ({
  maxRetries,
  baseDelayMs: 100,
  maxDelayMs: 400,
  retryableCategories: [...retryableCategories],
});

describe("recorded condition retryability and retry decision (#480)", () => {
  it("does not report a deterministic overflow as an eligible transient retry", async () => {
    const step = await projectRecordedStep({
      revision: "a".repeat(40),
      mode: "read-only",
      policy: readOnlyPolicy(2),
      turns: [{ turns: [() => errorTurn(RESPONSE_OVERFLOW)] }],
    });

    expect(step.status).toBe("failed");
    // The deterministic refusal was not replayed: not in the turn, where the
    // condition is not retryable, and not by the step policy.
    expect(step.observed.map((turn) => turn.providerRequests)).toEqual([1]);
    expect(step.evidence.attempts).toHaveLength(1);
    expect(disposition(step.evidence.attempts[0]!)).toEqual({
      outcome: "provider-terminal",
      retryable: false,
      retryScheduled: false,
      conditionRetryability: "not-eligible",
      retryDecision: "not-applicable",
    });
    expect(step.evidence.attempts[0]!.identity?.repositoryRevision).toBe("a".repeat(40));
    expect(step.evidence.attempts[0]!.outcome).not.toBe("provider-transient");
    expect(SHIPPED_RETRYABLE_CATEGORIES).not.toContain(step.evidence.attempts[0]!.outcome);
  });

  it("retains the throttle classifier facts when the execution mode declines to retry", async () => {
    const step = await projectRecordedStep({
      // A write-capable step, so replay is disabled for every category however
      // the run is configured.
      revision: "b".repeat(40),
      mode: "write",
      policy: readOnlyPolicy(2),
      turns: [{ turns: [() => errorTurn(ROUTE_429)] }],
    });

    expect(step.status).toBe("failed");
    expect(step.evidence.replay).toBe("disabled-write-step");
    expect(step.evidence.attempts).toHaveLength(1);
    expect(disposition(step.evidence.attempts[0]!)).toEqual({
      // The classifier's verdict survives the mode's refusal in both fields that
      // carry it: the throttle is still a throttle and still retryable.
      outcome: "throttled",
      retryable: true,
      retryScheduled: false,
      conditionRetryability: "eligible",
      retryDecision: "declined",
    });
    expect(step.evidence.attempts[0]!.identity?.repositoryRevision).toBe("b".repeat(40));
    expect(step.evidence.attempts[0]!.outcome).not.toBe("provider-terminal");
    // Declined is not exhausted: this mode never opened a retry window.
    expect(step.evidence.attempts[0]!.retryDecision).not.toBe("exhausted");
  });

  /**
   * An explicit zero override never opens a read-only retry window. Calling that
   * exhausted would tell an operator retries were attempted and used up when none
   * was possible.
   */
  it("records a zero-retry read-only lane as declined, not exhausted", async () => {
    // A 429 is judged by the transport budget, so both counts are lowered.
    const shipped = parseRetryPolicy({
      DOCSFAB_READ_ONLY_MAX_RETRIES: "0",
      DOCSFAB_READ_ONLY_MAX_TRANSPORT_RETRIES: "0",
    });
    expect(shipped.maxRetries).toBe(0);
    expect(shipped.retryableCategories).toContain("throttled");

    const bare = await projectRecordedStep({
      revision: "5".repeat(40),
      mode: "read-only",
      policy: shipped,
      turns: [{ turns: [() => errorTurn(ROUTE_429)] }],
    });

    expect(bare.evidence.effectiveMaxRetries).toBe(0);
    expect(bare.evidence.attempts.map(disposition)).toEqual([
      {
        outcome: "throttled",
        retryable: true,
        retryScheduled: false,
        conditionRetryability: "eligible",
        retryDecision: "declined",
      },
    ]);
    expect(bare.evidence.attempts[0]!.identity?.repositoryRevision).toBe("5".repeat(40));

    // Control: an explicit one-retry policy opens a window and then closes it.
    // Only here is the budget what stopped the retry.
    const configured = parseRetryPolicy({
      DOCSFAB_READ_ONLY_MAX_RETRIES: "1",
      DOCSFAB_READ_ONLY_MAX_TRANSPORT_RETRIES: "1",
    });
    expect(configured.maxRetries).toBe(1);
    const budgeted = await projectRecordedStep({
      revision: "6".repeat(40),
      mode: "read-only",
      policy: configured,
      turns: [{ turns: [() => errorTurn(ROUTE_429)] }],
    });

    expect(budgeted.evidence.attempts.map((attempt) => attempt.retryDecision)).toEqual([
      "retried",
      "exhausted",
    ]);
    expect(budgeted.evidence.attempts[1]!.identity?.repositoryRevision).toBe("6".repeat(40));
  });

  /**
   * The exhausted/declined boundary, end to end. On the attempt that equals the
   * budget a retry was still available and the host refused it; only strictly
   * past the budget is the budget what stopped the retry.
   */
  it("records a host refusal with retries remaining as declined, not exhausted", async () => {
    const policy = readOnlyPolicy(2, ["malformed-response"]);
    const refused = await projectRecordedStep({
      revision: "8".repeat(40),
      mode: "read-only",
      policy,
      // Attempt 1 is a retryable malformed answer; attempt 2 is the host's own
      // refusal of the same eligible condition, with a retry still available.
      turns: [{ turns: [() => answeredTurn("unusable")] }],
      hostVerdict: (attempt) => (attempt < 2 ? hostRejection() : hostRefusal()),
    });

    expect(refused.evidence.effectiveMaxRetries).toBe(2);
    expect(refused.evidence.attempts.map(disposition)).toEqual([
      {
        outcome: "malformed-response",
        retryable: true,
        retryScheduled: true,
        conditionRetryability: "eligible",
        retryDecision: "retried",
      },
      {
        // attempt 2 of a 2-retry budget: one retry was still available.
        outcome: "malformed-response",
        retryable: false,
        retryScheduled: false,
        conditionRetryability: "eligible",
        retryDecision: "declined",
      },
    ]);
    expect(refused.evidence.attempts[1]!.identity?.repositoryRevision).toBe("8".repeat(40));

    // Control one attempt further out, where the budget really is spent.
    const spent = await projectRecordedStep({
      revision: "4".repeat(40),
      mode: "read-only",
      policy,
      turns: [{ turns: [() => answeredTurn("unusable")] }],
      hostVerdict: (attempt) => (attempt < 3 ? hostRejection() : hostRefusal()),
    });
    expect(spent.evidence.attempts.map((attempt) => attempt.retryDecision)).toEqual([
      "retried",
      "retried",
      "exhausted",
    ]);
  });

  it("records a blank answer as an eligible condition the policy did retry", async () => {
    const step = await projectRecordedStep({
      revision: "c".repeat(40),
      mode: "read-only",
      policy: readOnlyPolicy(2),
      turns: [{ turns: [blankTurn] }, { turns: [() => answeredTurn("recovered")] }],
    });

    expect(step.status).toBe("succeeded");
    // The empty turn is bounded inside the governed turn before the step retry.
    expect(step.observed.map((turn) => turn.providerRequests)).toEqual([
      DEFAULT_PROVIDER_TURN_RETRY_POLICY.maxBlankAttempts,
      1,
    ]);
    expect(step.evidence.attempts.map(disposition)).toEqual([
      {
        outcome: "blank-response",
        retryable: true,
        retryScheduled: true,
        conditionRetryability: "eligible",
        retryDecision: "retried",
      },
      {
        outcome: "succeeded",
        retryable: false,
        retryScheduled: false,
        conditionRetryability: "not-applicable",
        retryDecision: "not-applicable",
      },
    ]);
    expect(step.evidence.attempts[0]!.identity?.repositoryRevision).toBe("c".repeat(40));
  });

  /**
   * Both veto cases use a read-only policy that lists the category, and a
   * governed turn whose second provider request would answer. The veto is then
   * the only thing between the run and a success, so the veto, not the
   * execution mode or an unlisted category, produces the recorded failure. On a
   * write-capable step every eligible failure is declined before a veto matters.
   */
  it.each([
    [
      "partial-stream",
      "d".repeat(40),
      "2".repeat(40),
      "provider-transient",
      () => committedErrorTurn(ROUTE_503),
      () => errorTurn(ROUTE_503),
      false,
    ],
    [
      "local-denial",
      "e".repeat(40),
      "3".repeat(40),
      "timeout",
      () => errorTurn(ROUTE_408),
      () => errorTurn(ROUTE_408),
      true,
    ],
  ] as const)(
    "keeps the %s veto explicit, and the veto is what the record shows",
    async (_label, vetoedRevision, controlRevision, outcome, vetoedTurn, controlTurn, denied) => {
      const policy = readOnlyPolicy(0);
      expect(policy.retryableCategories).toContain(outcome);

      const vetoed = await projectRecordedStep({
        revision: vetoedRevision,
        mode: "read-only",
        policy,
        turns: [{ turns: [vetoedTurn, () => answeredTurn("recovered")], locallyDenied: denied }],
      });
      // Control: the identical condition and policy with the veto removed. The
      // in-turn replay lands the answer and the step never fails at all.
      const replayed = await projectRecordedStep({
        revision: controlRevision,
        mode: "read-only",
        policy,
        turns: [{ turns: [controlTurn, () => answeredTurn("recovered")] }],
      });

      expect(vetoed.observed.map((turn) => turn.providerRequests)).toEqual([1]);
      expect(vetoed.observed[0]!.inTurnReplays).toBe(0);
      expect(replayed.observed.map((turn) => turn.providerRequests)).toEqual([2]);
      expect(replayed.observed[0]!.inTurnReplays).toBe(1);

      expect(vetoed.status).toBe("failed");
      expect(disposition(vetoed.evidence.attempts[0]!)).toEqual({
        // The condition is still an eligible transient; only the decision
        // differs, and a reader can tell the two apart.
        outcome,
        retryable: true,
        retryScheduled: false,
        conditionRetryability: "eligible",
        retryDecision: "declined",
      });
      expect(vetoed.evidence.attempts[0]!.identity?.repositoryRevision).toBe(vetoedRevision);

      expect(replayed.status).toBe("succeeded");
      expect(disposition(replayed.evidence.attempts[0]!)).toEqual({
        outcome: "succeeded",
        retryable: false,
        retryScheduled: false,
        conditionRetryability: "not-applicable",
        retryDecision: "not-applicable",
      });
      expect(replayed.evidence.attempts[0]!.identity?.repositoryRevision).toBe(controlRevision);
    },
  );

  it("separates an exhausted retry budget from a declined one", async () => {
    const step = await projectRecordedStep({
      revision: "f".repeat(40),
      mode: "read-only",
      policy: readOnlyPolicy(1),
      turns: [{ turns: [() => errorTurn(ROUTE_429)] }],
    });

    expect(step.status).toBe("failed");
    expect(step.evidence.attempts.map(disposition)).toEqual([
      {
        outcome: "throttled",
        retryable: true,
        retryScheduled: true,
        conditionRetryability: "eligible",
        retryDecision: "retried",
      },
      {
        // Same eligible condition, same listed category, no budget left.
        outcome: "throttled",
        retryable: true,
        retryScheduled: false,
        conditionRetryability: "eligible",
        retryDecision: "exhausted",
      },
    ]);
    expect(step.evidence.attempts[1]!.identity?.repositoryRevision).toBe("f".repeat(40));
    // A run that never listed the category records the same non-retry as a
    // decline, so the two are not interchangeable spellings.
    const declined = await projectRecordedStep({
      revision: "0".repeat(40),
      mode: "read-only",
      policy: readOnlyPolicy(1, ["blank-response"]),
      turns: [{ turns: [() => errorTurn(ROUTE_429)] }],
    });
    expect(declined.evidence.attempts.map((attempt) => attempt.retryDecision)).toEqual([
      "declined",
    ]);
  });

  it("reads a historical attempt as explicitly unavailable instead of guessing", async () => {
    const step = await projectRecordedStep({
      revision: "9".repeat(40),
      mode: "write",
      policy: readOnlyPolicy(2),
      turns: [{ turns: [() => errorTurn(ROUTE_429)] }],
    });
    const current = step.evidence.attempts[0]!;
    // A record written before the distinction existed: same attempt, neither
    // new field.
    const historical = structuredClone(current) as Partial<InferenceAttemptEvidence>;
    delete historical.conditionRetryability;
    delete historical.retryDecision;

    expect(readInferenceRetryDisposition(historical)).toEqual({
      conditionRetryability: INFERENCE_RETRY_DISPOSITION_UNAVAILABLE,
      retryDecision: INFERENCE_RETRY_DISPOSITION_UNAVAILABLE,
    });
    // The conflated fields are still there and still say "retryable, not
    // scheduled"; the reading must not turn that into a decision.
    expect(historical.retryable).toBe(true);
    expect(historical.retryScheduled).toBe(false);
    expect(readInferenceRetryDisposition(historical).retryDecision).not.toBe("declined");
    expect(readInferenceRetryDisposition(historical).conditionRetryability).not.toBe("eligible");
    // Positive control: the same attempt with the fields reads as the decision.
    expect(readInferenceRetryDisposition(current)).toEqual({
      conditionRetryability: "eligible",
      retryDecision: "declined",
    });
  });
});

describe("provider turn replay vetoes (#480)", () => {
  const authorized: ProviderTurnReplayProbe = {
    committed: false,
    conditionRetryable: true,
    attemptsRemaining: true,
    // The step-wide physical bound, intact on the authorized probe.
    stepAttemptsRemaining: true,
    blankAttemptsRemaining: true,
    locallyDenied: () => false,
    backoffBudgetRemaining: true,
    withinDeadline: () => true,
    cancelled: () => false,
  };

  it("authorizes a replay only when no stop applies", () => {
    expect(describeProviderTurnReplayVeto(authorized)).toBeUndefined();
  });

  it("names each stop instead of collapsing it into a terminal condition", () => {
    const cases: ReadonlyArray<[Partial<ProviderTurnReplayProbe>, string]> = [
      [{ committed: true }, "partial-stream"],
      [{ conditionRetryable: false }, "condition-not-retryable"],
      [{ attemptsRemaining: false }, "attempts-exhausted"],
      [{ stepAttemptsRemaining: false }, "step-physical-attempts-exhausted"],
      [{ blankAttemptsRemaining: false }, "blank-attempts-exhausted"],
      [{ locallyDenied: () => true }, "local-denial"],
      [{ backoffBudgetRemaining: false }, "backoff-budget-exhausted"],
      [{ withinDeadline: () => false }, "attempt-deadline"],
      [{ cancelled: () => true }, "cancelled"],
    ];
    for (const [override, expected] of cases) {
      expect(describeProviderTurnReplayVeto({ ...authorized, ...override })).toBe(expected);
    }
    // The two vetoes keep their own names on an otherwise retryable condition:
    // neither is "the condition cannot be retried".
    expect(
      describeProviderTurnReplayVeto({ ...authorized, committed: true, conditionRetryable: true }),
    ).toBe("partial-stream");
    expect(
      describeProviderTurnReplayVeto({
        ...authorized,
        locallyDenied: () => true,
        conditionRetryable: true,
      }),
    ).toBe("local-denial");
  });

  /**
   * The order, not just the members. Each case is one where two stops would
   * answer differently, so moving a check past its neighbour changes the
   * reported veto.
   *
   * The host veto sits directly behind `partial-stream`, ahead of the attempt
   * bounds. DocsFab's own payload-finalization refusal ("Provider request rejected
   * by the installed request policy (payload-authority: turn-evidence-authority).")
   * is text the
   * classifier calls non-retryable, so with the host veto checked later the
   * record would read `condition-not-retryable` for a request the provider never
   * saw. `isReplayable` is therefore consulted on every non-committed failed
   * attempt, exactly once (the counters pin it); the clock-reading probe stays
   * lazy.
   */
  it("keeps every stop behind the ones that must outrank it", () => {
    const counted = (
      override: Partial<ProviderTurnReplayProbe>,
    ): { veto: string | undefined; hostChecks: number; clockReads: number } => {
      let hostChecks = 0;
      let clockReads = 0;
      const veto = describeProviderTurnReplayVeto({
        ...authorized,
        locallyDenied: () => {
          hostChecks += 1;
          return true;
        },
        withinDeadline: () => {
          clockReads += 1;
          return false;
        },
        ...override,
      });
      return { veto, hostChecks, clockReads };
    };

    // A committed stream outranks everything, including a condition the
    // classifier calls terminal and a host that refused the request: the
    // consumer already owns half a message either way.
    expect(counted({ committed: true, conditionRetryable: false })).toEqual({
      veto: "partial-stream",
      hostChecks: 0,
      clockReads: 0,
    });
    // The host veto outranks the condition's verdict. Both are true here, and
    // only one of them is about something the provider said.
    expect(counted({ conditionRetryable: false })).toEqual({
      veto: "local-denial",
      hostChecks: 1,
      clockReads: 0,
    });
    // It outranks the bounds for the same reason: an identical replay of a
    // request DocsFab refused would be refused identically, allowance or not.
    expect(counted({ attemptsRemaining: false, stepAttemptsRemaining: false })).toEqual({
      veto: "local-denial",
      hostChecks: 1,
      clockReads: 0,
    });
    // With the host allowing the replay, the condition's own verdict outranks
    // both attempt bounds.
    expect(
      counted({
        locallyDenied: () => false,
        conditionRetryable: false,
        attemptsRemaining: false,
      }),
    ).toEqual({
      veto: "condition-not-retryable",
      hostChecks: 0,
      clockReads: 0,
    });
    expect(counted({ locallyDenied: () => false, attemptsRemaining: false })).toEqual({
      veto: "attempts-exhausted",
      hostChecks: 0,
      clockReads: 0,
    });
    expect(counted({ locallyDenied: () => false, blankAttemptsRemaining: false })).toEqual({
      veto: "blank-attempts-exhausted",
      hostChecks: 0,
      clockReads: 0,
    });
    // The step-wide physical bound sits between the per-turn attempt bound and
    // the empty-turn bound. A step with nothing left is reported as such, not as
    // an exhausted turn.
    expect(counted({ locallyDenied: () => false, stepAttemptsRemaining: false })).toEqual({
      veto: "step-physical-attempts-exhausted",
      hostChecks: 0,
      clockReads: 0,
    });
    expect(
      counted({
        locallyDenied: () => false,
        attemptsRemaining: false,
        stepAttemptsRemaining: false,
      }),
    ).toEqual({
      veto: "attempts-exhausted",
      hostChecks: 0,
      clockReads: 0,
    });
    // The host veto still outranks the backoff budget and the deadline, and the
    // clock is not read once it has answered.
    expect(counted({ backoffBudgetRemaining: false })).toEqual({
      veto: "local-denial",
      hostChecks: 1,
      clockReads: 0,
    });
    // With the host allowing the replay, the budget outranks the deadline.
    expect(counted({ locallyDenied: () => false, backoffBudgetRemaining: false })).toEqual({
      veto: "backoff-budget-exhausted",
      hostChecks: 0,
      clockReads: 0,
    });
    // And the deadline outranks cancellation.
    expect(counted({ locallyDenied: () => false, cancelled: () => true })).toEqual({
      veto: "attempt-deadline",
      hostChecks: 0,
      clockReads: 1,
    });
  });
});

describe("the original #480 conditions against the current classifier", () => {
  it("records the pilot context-window refusal as context-exhausted through a provider turn", async () => {
    const run = (revision: string, errorMessage: string) =>
      projectRecordedStep({
        revision,
        mode: "read-only",
        policy: readOnlyPolicy(0, []),
        turns: [{ turns: [() => errorTurn(errorMessage)] }],
      });
    const context = await run("a".repeat(40), ROUTE_CONTEXT_400);
    const unrelated = await run("b".repeat(40), ROUTE_INVALID_400);
    expect(context.evidence.attempts[0]).toMatchObject({
      outcome: "context-exhausted",
      retryable: false,
    });
    expect(unrelated.evidence.attempts[0]).toMatchObject({
      outcome: "invalid-request",
      retryable: false,
    });
  });
  /**
   * Three conditions once recorded with the wrong outcome, kept as a
   * regression: none of the mislabels reproduces.
   */
  const originals = [
    {
      condition: "provider-response-too-large",
      errorMessage: RESPONSE_OVERFLOW,
      // An exact, deterministic overflow recorded as a retryable transient would
      // invite a retry loop that cannot succeed.
      reportedOutcome: "provider-transient",
      reportedRetryable: true,
      current: { category: "provider-terminal", retryable: false },
      conditionRetryability: "not-eligible",
    },
    {
      condition: "HTTP 429 throttle",
      errorMessage: ROUTE_429,
      reportedOutcome: "provider-terminal",
      reportedRetryable: false,
      current: { category: "throttled", retryable: true },
      conditionRetryability: "eligible",
    },
    {
      condition: "blank response",
      errorMessage: undefined,
      reportedOutcome: "provider-terminal",
      reportedRetryable: false,
      current: { category: "blank-response", retryable: true },
      conditionRetryability: "eligible",
    },
  ] as const;

  it("no longer reproduces any of the three recorded mislabels", async () => {
    for (const original of originals) {
      const step = await projectRecordedStep({
        revision: "7".repeat(40),
        mode: "read-only",
        // No category listed, so the policy retries nothing and the recorded
        // outcome is the condition's own, not a retry's.
        policy: readOnlyPolicy(0, []),
        turns: [
          {
            turns: [
              original.errorMessage === undefined
                ? blankTurn
                : () => errorTurn(original.errorMessage),
            ],
          },
        ],
      });
      const attempt = step.evidence.attempts[0]!;

      expect(attempt.outcome).toBe(original.current.category);
      expect(attempt.retryable).toBe(original.current.retryable);
      expect(attempt.conditionRetryability).toBe(original.conditionRetryability);
      expect(attempt.retryDecision).toBe(
        original.conditionRetryability === "eligible" ? "declined" : "not-applicable",
      );
      // The recorded mislabel does not come back.
      expect({ outcome: attempt.outcome, retryable: attempt.retryable }).not.toEqual({
        outcome: original.reportedOutcome,
        retryable: original.reportedRetryable,
      });
    }
  });

  it("keeps host runtime failures non-retryable without adding a policy default", () => {
    // Every recorded outcome above is drawn from the declared category sets,
    // while host-origin failures stay outside the configurable provider retry
    // policy. The host's own `no-progress` stop joins that set independently.
    expect([...INFERENCE_FAILURE_CATEGORIES]).toEqual([
      "blank-response",
      "malformed-response",
      "context-exhausted",
      "timeout",
      "throttled",
      "provider-transient",
      "provider-terminal",
      "host-runtime-failure",
      "invalid-request",
      "no-progress",
    ]);
    expect([...CONFIGURABLE_RETRY_CATEGORIES]).toEqual([
      "blank-response",
      "malformed-response",
      "timeout",
      "throttled",
      "provider-transient",
      "no-progress",
    ]);
    expect(DEFAULT_PROVIDER_TURN_RETRY_POLICY).toEqual({
      maxAttempts: 8,
      baseDelayMs: 500,
      maxDelayMs: 20_000,
      maxTotalDelayMs: 60_000,
      maxThrottledAttempts: 24,
      maxThrottledTotalDelayMs: 380_000,
      maxBlankAttempts: 3,
    });
    for (const message of [RESPONSE_OVERFLOW, ROUTE_429, ROUTE_408, ROUTE_503]) {
      expect(INFERENCE_FAILURE_CATEGORIES).toContain(classifyModelFailure(message).category);
    }
  });
});
