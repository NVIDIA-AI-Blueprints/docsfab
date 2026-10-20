// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { defaultRetryPolicy } from "../src/config/profile-projection.js";
import { parseRetryPolicy } from "../src/config/retry-policy.js";
import { INFERENCE_STEP_ERROR_CODES } from "../src/execution/contracts.js";
import {
  CONFIGURABLE_RETRY_CATEGORIES,
  INFERENCE_ATTEMPT_OUTCOMES,
  INFERENCE_ATTEMPT_SUCCESS_OUTCOME,
  INFERENCE_FAILURE_CATEGORIES,
  INFERENCE_FAILURE_CATEGORY_COVERAGE,
  NON_RETRYABLE_INFERENCE_FAILURE_CATEGORIES,
  isConfigurableRetryCategory,
  isInferenceAttemptOutcome,
  isInferenceFailureCategory,
  isMalformedResponseCategory,
  isNonRetryableInferenceFailureCategory,
} from "../src/inference-attempt-taxonomy.js";
import type { RunRecord } from "../src/records/contracts.js";
import { SCORECARD_FAILURE_CLASSES } from "../src/scorecard.js";
import type { WorkflowOutcomeCandidateV1 } from "../src/workflow-contracts/contracts.js";
import {
  createWorkflowOutcome,
  WorkflowOutcomeError,
  workflowOutcomeStepEvidence,
} from "../src/workflow-contracts/outcome.js";

/**
 * Oracle transcribed from the sets the three consumers declared before the
 * taxonomy module existed (`workflow-contracts/outcome.ts`, `scorecard.ts`,
 * `quality-evaluation/corpus-live.ts`), so the assertions compare the module
 * against those declarations rather than a restatement of itself.
 */
const SHIPPED = {
  outcomeAttemptOutcomes: [
    "succeeded",
    "blank-response",
    "malformed-response",
    "context-exhausted",
    "timeout",
    "throttled",
    "provider-transient",
    "invalid-request",
    "provider-terminal",
    "host-runtime-failure",
    // The host's read-loop stop.
    "no-progress",
  ],
  outcomeConfigurableRetryCategories: [
    "blank-response",
    "malformed-response",
    "timeout",
    "throttled",
    "provider-transient",
    "no-progress",
  ],
  outcomeNonRetryableCategories: [
    "context-exhausted",
    "invalid-request",
    "provider-terminal",
    "host-runtime-failure",
  ],
  scorecardFailureClasses: [
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
    "policy-security-blocked",
    "policy-security-denied",
    "policy-scanner-failed",
    "policy-context-preflight",
    "unclassified",
  ],
  corpusLiveRetryableCategories: [
    "blank-response",
    "malformed-response",
    "context-exhausted",
    "timeout",
    "throttled",
    "provider-transient",
    "invalid-request",
    "provider-terminal",
    "host-runtime-failure",
    // The host's read-loop stop.
    "no-progress",
  ],
  corpusLiveAttemptOutcomes: [
    "succeeded",
    "blank-response",
    "malformed-response",
    "context-exhausted",
    "timeout",
    "throttled",
    "provider-transient",
    "invalid-request",
    "provider-terminal",
    "host-runtime-failure",
    // The host's read-loop stop.
    "no-progress",
  ],
} as const;

const CONSUMERS = {
  outcome: "../src/workflow-contracts/outcome.ts",
  scorecard: "../src/scorecard.ts",
  corpusLive: "../src/quality-evaluation/corpus-live.ts",
} as const;

function sorted(values: Iterable<string>): string[] {
  return [...values].sort();
}

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

describe("inference attempt taxonomy module", () => {
  it("publishes the attempt-outcome set both pre-change consumers declared", () => {
    // A live record must survive both decoders, so the module equals both
    // consumers' sets.
    expect(sorted(INFERENCE_ATTEMPT_OUTCOMES)).toEqual(sorted(SHIPPED.outcomeAttemptOutcomes));
    expect(sorted(INFERENCE_ATTEMPT_OUTCOMES)).toEqual(sorted(SHIPPED.corpusLiveAttemptOutcomes));
    expect(INFERENCE_ATTEMPT_OUTCOMES).toHaveLength(SHIPPED.outcomeAttemptOutcomes.length);
    expect(INFERENCE_ATTEMPT_SUCCESS_OUTCOME).toBe("succeeded");
    expect(sorted(INFERENCE_ATTEMPT_OUTCOMES)).toEqual(
      sorted([INFERENCE_ATTEMPT_SUCCESS_OUTCOME, ...INFERENCE_FAILURE_CATEGORIES]),
    );
  });

  it("publishes the failure-category set the shipped operator error codes enumerate", () => {
    // `INFERENCE_STEP_ERROR_CODES` independently maps every failure category
    // onto its operator-envelope code.
    expect(sorted(INFERENCE_FAILURE_CATEGORIES)).toEqual(
      sorted(Object.keys(INFERENCE_STEP_ERROR_CODES)),
    );
    expect(sorted(INFERENCE_FAILURE_CATEGORIES)).toEqual(
      sorted(SHIPPED.corpusLiveRetryableCategories),
    );
    expect(sorted(INFERENCE_FAILURE_CATEGORIES)).toEqual(
      sorted(SHIPPED.outcomeAttemptOutcomes.filter((outcome) => outcome !== "succeeded")),
    );
    expect(INFERENCE_FAILURE_CATEGORY_COVERAGE).toBe(true);
  });

  it("publishes the configurable retry set the shipped retry policies still use", () => {
    // The host-config default and the environment parser independently produce
    // this vocabulary. They are policy defaults, so they are oracles for the
    // vocabulary only, not for a retry choice.
    expect(sorted(CONFIGURABLE_RETRY_CATEGORIES)).toEqual(
      sorted(SHIPPED.outcomeConfigurableRetryCategories),
    );
    // The host default pins no list, so it follows the taxonomy.
    expect(defaultRetryPolicy().retryableCategories).toBeUndefined();
    expect(sorted(CONFIGURABLE_RETRY_CATEGORIES)).toEqual(
      sorted(parseRetryPolicy({}).retryableCategories),
    );
  });

  it("derives the non-retryable complement the outcome contract inlined", () => {
    expect(sorted(NON_RETRYABLE_INFERENCE_FAILURE_CATEGORIES)).toEqual(
      sorted(SHIPPED.outcomeNonRetryableCategories),
    );
    // Partition: the two subsets are disjoint and together cover the whole set.
    expect(
      sorted([...CONFIGURABLE_RETRY_CATEGORIES, ...NON_RETRYABLE_INFERENCE_FAILURE_CATEGORIES]),
    ).toEqual(sorted(INFERENCE_FAILURE_CATEGORIES));
    for (const category of INFERENCE_FAILURE_CATEGORIES) {
      expect(isConfigurableRetryCategory(category)).toBe(
        !isNonRetryableInferenceFailureCategory(category),
      );
    }
  });

  it("answers membership questions for exactly the closed sets and nothing else", () => {
    for (const outcome of SHIPPED.outcomeAttemptOutcomes) {
      expect(isInferenceAttemptOutcome(outcome)).toBe(true);
      expect(isInferenceFailureCategory(outcome)).toBe(outcome !== "succeeded");
    }
    for (const category of SHIPPED.outcomeConfigurableRetryCategories) {
      expect(isConfigurableRetryCategory(category)).toBe(true);
    }
    for (const stranger of [
      "succeeded ",
      "Provider-Transient",
      "provider-unavailable",
      "retryable",
      "",
      undefined,
      null,
      0,
    ]) {
      expect(isInferenceAttemptOutcome(stranger)).toBe(false);
      expect(isInferenceFailureCategory(stranger)).toBe(false);
      expect(isConfigurableRetryCategory(stranger)).toBe(false);
      expect(isMalformedResponseCategory(stranger)).toBe(false);
    }
    // "succeeded" is an attempt outcome but not a failure or retry category.
    expect(isConfigurableRetryCategory(INFERENCE_ATTEMPT_SUCCESS_OUTCOME)).toBe(false);
    expect(isMalformedResponseCategory("malformed-response")).toBe(true);
    expect(isMalformedResponseCategory("blank-response")).toBe(false);
    expect(isMalformedResponseCategory(INFERENCE_ATTEMPT_SUCCESS_OUTCOME)).toBe(false);
  });
});

describe("inference taxonomy consumers", () => {
  it("keeps the scorecard reliability reporting list byte-identical in order", () => {
    // Order fixes the `incidents` / `terminalFailures` key order and the
    // rendered incident table rows.
    expect([...SCORECARD_FAILURE_CLASSES]).toEqual([...SHIPPED.scorecardFailureClasses]);
  });

  it("freezes the exported scorecard reporting list against in-process mutation", () => {
    // A `push` anywhere in the process would change the key set, and so the
    // serialized scorecard and its digest, for every later scorecard.
    // `ReadonlyArray` is compile-time only.
    expect(Object.isFrozen(SCORECARD_FAILURE_CLASSES)).toBe(true);
  });

  it("keeps the scorecard renderer's untouched reporting list in step with the module", () => {
    // `scorecard-render.ts` declares its own list, which must stay a superset in
    // the same order or the rendered table and the counters disagree. Parsed
    // from its source so the oracle is the renderer itself.
    const rendered = source("../src/scorecard-render.ts");
    const block = /const FAILURE_CLASSES[^=]*=\s*\[([^\]]*)\]/u.exec(rendered);
    expect(block).not.toBeNull();
    const declared = [...block![1]!.matchAll(/"([^"]+)"/gu)].map((match) => match[1]!);
    expect(declared).toEqual([...SCORECARD_FAILURE_CLASSES]);
    expect(declared.slice(0, INFERENCE_FAILURE_CATEGORIES.length)).toEqual([
      ...INFERENCE_FAILURE_CATEGORIES,
    ]);
  });

  it("leaves no consumer holding a parallel copy of the taxonomy literals", () => {
    // A consumer that re-declares the set fails here, even while it still
    // agrees, so a second declaration cannot drift.
    const allowedFailureCategoryLiterals: Record<keyof typeof CONSUMERS, string[]> = {
      // Compares one classified failure against one category; not a set.
      scorecard: ["context-exhausted"],
      outcome: [],
      corpusLive: [],
    };
    for (const [name, path] of Object.entries(CONSUMERS) as Array<
      [keyof typeof CONSUMERS, string]
    >) {
      const text = source(path);
      expect(text).toMatch(/from "\.[./]*inference-attempt-taxonomy\.js"/u);
      const present = INFERENCE_FAILURE_CATEGORIES.filter((category) =>
        text.includes(`"${category}"`),
      );
      expect({ [name]: sorted(present) }).toEqual({
        [name]: sorted(allowedFailureCategoryLiterals[name]),
      });
    }
  });

  it("routes each consumer gate through the shared predicate it replaced", () => {
    // Pins which predicate guards each site. Set equality alone would not catch
    // a gate swapped to a narrower or wider set, such as corpus-live's
    // retryable-category gate, which admits every failure category.
    const outcome = source(CONSUMERS.outcome);
    expect(outcome).toContain(
      "inference.retryableCategories.some((category) => !isConfigurableRetryCategory(category))",
    );
    // Per record: `no-progress` is terminal where the record had no budget for it.
    expect(outcome).toContain(
      "const terminal = new Set<string>(terminalInferenceCategories(inference));",
    );
    expect(outcome).toContain("!isInferenceAttemptOutcome(attempt.outcome)");

    const corpusLive = source(CONSUMERS.corpusLive);
    expect(corpusLive).toContain(
      "inference.retryableCategories.some((item) => !isInferenceFailureCategory(String(item)))",
    );
    expect(corpusLive).toContain("!isInferenceAttemptOutcome(String(attempt.outcome))");
    expect(corpusLive).toContain("!isMalformedResponseCategory(attempt.outcome) ||");
    expect(corpusLive).toContain("!isInferenceRejectedReplyShape(attempt.rejectedReplyShape)");

    expect(source(CONSUMERS.scorecard)).toContain("...INFERENCE_FAILURE_CATEGORIES,");
  });
});

describe("workflow outcome validation over the shared taxonomy", () => {
  it.each([...CONFIGURABLE_RETRY_CATEGORIES].filter((category) => category !== "no-progress"))(
    "accepts a retried %s attempt bound to the shared retry vocabulary",
    (category) => {
      const record = retriedRecord(category, [category]);
      expect(createWorkflowOutcome(notReady(record), record).disposition).toBe("not-ready");
    },
  );

  it("retries no-progress only in a record that applied a no-progress budget", () => {
    // A record without condition budgets predates the no-progress retry, so
    // its no-progress stop is terminal: a retried one is refused.
    const legacy = retriedRecord("no-progress", ["no-progress"]);
    expect(() => createWorkflowOutcome(notReady(legacy), legacy)).toThrowError(
      new WorkflowOutcomeError("execution-product-mismatch"),
    );
    // With the budget and its recorded rules, the same retry is admitted.
    const budgeted = retriedRecord("no-progress", ["no-progress"]);
    const inference = budgeted.steps[0]!.inference!;
    inference.conditionRetry = {
      maxTimeoutRetries: 1,
      maxCutAnswerRetries: 1,
      maxNoProgressRetries: 1,
    };
    Object.assign(inference.attempts[0]!, {
      conditionRetryability: "eligible",
      retryDecision: "retried",
      retryRule: "retried-no-progress",
    });
    Object.assign(inference.attempts[1]!, {
      conditionRetryability: "not-applicable",
      retryDecision: "not-applicable",
      retryRule: "not-applicable",
    });
    expect(createWorkflowOutcome(notReady(budgeted), budgeted).disposition).toBe("not-ready");
  });

  // Parameterised from the oracle, not the module under test, so a widened
  // configurable set fails a case instead of deleting it.
  it.each([...SHIPPED.outcomeNonRetryableCategories])(
    "rejects %s in a retry policy because it is outside the configurable set",
    (category) => {
      // `"timeout"` stays in the policy to satisfy the gate that requires a
      // retried attempt's outcome in `retryableCategories`, leaving the
      // configurable-set bound as the only reason to reject.
      const record = retriedRecord("timeout", ["timeout", category]);
      expect(() => createWorkflowOutcome(notReady(record), record)).toThrowError(
        new WorkflowOutcomeError("execution-product-mismatch"),
      );
    },
  );

  it("rejects a retry category outside the closed set and accepts the same record without it", () => {
    const rejected = retriedRecord("timeout", ["timeout", "provider-unavailable"]);
    expect(() => createWorkflowOutcome(notReady(rejected), rejected)).toThrowError(
      new WorkflowOutcomeError("execution-product-mismatch"),
    );
    const accepted = retriedRecord("timeout", ["timeout"]);
    expect(createWorkflowOutcome(notReady(accepted), accepted).disposition).toBe("not-ready");
  });

  it("rejects an attempt outcome outside the closed set", () => {
    const record = retriedRecord("timeout", ["timeout"]);
    record.steps[0]!.inference!.attempts[0]!.outcome = "timed-out" as never;
    expect(() => createWorkflowOutcome(notReady(record), record)).toThrowError(
      new WorkflowOutcomeError("execution-product-mismatch"),
    );
  });
});

/**
 * A record whose single step retried once on `failed`, then succeeded, under a
 * policy that lists `retryableCategories`, in the fixture shape of
 * `test/workflow-outcome.test.ts`.
 */
function retriedRecord(failed: string, retryableCategories: string[]): RunRecord {
  const record = succeededRecord();
  const emptyTools = { totalCalls: 0, failedCalls: 0, byTool: [] };
  record.steps[0]!.tools = structuredClone(emptyTools);
  record.steps[0]!.inference = {
    configuredMaxRetries: 1,
    effectiveMaxRetries: 1,
    baseDelayMs: 1,
    maxDelayMs: 1,
    retryableCategories: retryableCategories as never,
    replay: "read-only",
    attempts: [
      {
        attempt: 1,
        outcome: failed as never,
        retryable: true,
        retryScheduled: true,
        durationMs: 1,
        backoffMs: 1,
        tools: structuredClone(emptyTools),
      },
      {
        attempt: 2,
        outcome: "succeeded",
        retryable: false,
        retryScheduled: false,
        durationMs: 1,
        tools: structuredClone(emptyTools),
      },
    ],
  };
  return record;
}

function succeededRecord(): RunRecord {
  return {
    schemaVersion: 2,
    id: "run:taxonomy-fixture",
    workflow: "readiness",
    repository: {
      sourcePath: "/private/source",
      requestedRevision: "HEAD",
      revision: "a".repeat(40),
    },
    workspace: { strategy: "tracked-export", disposable: true },
    status: "succeeded",
    createdAt: "2026-08-05T00:00:00.000Z",
    startedAt: "2026-08-05T00:00:00.000Z",
    completedAt: "2026-08-05T00:00:01.000Z",
    durationMs: 1_000,
    models: [],
    skills: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0 },
    tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
    steps: [
      {
        id: "assess-readiness",
        title: "Assess repository readiness",
        kind: "inference",
        skill: "doc-context-analyzer",
        mode: "read-only",
        status: "succeeded",
        startedAt: "2026-08-05T00:00:00.000Z",
        completedAt: "2026-08-05T00:00:01.000Z",
        durationMs: 1_000,
        summary: "Typed product evidence fixture.",
      },
    ],
  };
}

function notReady(record: RunRecord): WorkflowOutcomeCandidateV1 {
  const evidence = workflowOutcomeStepEvidence(record, "assess-readiness");
  return {
    disposition: "not-ready",
    findings: [
      {
        id: "finding:public-docs-gap",
        kind: "product-gap",
        severity: "blocking",
        code: "public-docs-gap",
        evidenceIds: [evidence.id],
      },
    ],
    evidence: [evidence],
    limitations: [],
    openDecisions: [],
    producedArtifacts: [],
  };
}
