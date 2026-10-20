// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { isRetainableInferenceRejection } from "../src/config/inference-rejection-limits.js";
import {
  OUTPUT_REPLAY_MODES,
  OUTPUT_RULE_HINTS,
  OUTPUT_RULES,
  isModelCorrectableOutputRule,
} from "../src/contracts/model-output.js";
import { InferenceStepError, type HarnessStepResult } from "../src/execution/contracts.js";
import {
  RESPONSE_REJECTION_RULE_HINTS,
  responseCorrectionInstruction,
} from "../src/harness/response-correction.js";
import { inferenceRejectionFailureClass } from "../src/operator/failure-classification.js";
import {
  INFERENCE_RETRY_DECISION_REASONS,
  inferenceRetryDecisionToken,
} from "../src/operator/retry-disposition.js";
import { executeInferenceStep } from "../src/workflow-execution/retry.js";
import {
  AUTHORING_REVISION_ACCOUNTING_DIAGNOSTIC_CODES,
  REVISION_ACCOUNTING_REJECTION_CODES,
  revisionAccountingDiagnosticForRejectionCode,
} from "../src/workflow-contracts/run-recovery-presentation.js";
import type { AuthoringRevisionInputV1 } from "../src/workflow-execution/authoring-candidate.js";
import { AuthoringRevisionReplayError } from "../src/workflow-execution/authoring-runtime.js";
import {
  checkAuthoringRevisionAttempt,
  resetAuthoringRevisionForRetry,
  type AuthoringRevisionReplayV1,
} from "../src/workflow-execution/revision-accounting-round.js";

/** A recorded create-cli matrix run. */
const RECORDED = {
  code: "revision-accounting-changed-path-mismatch",
  location: "$.changedPaths",
} as const;

/** The reset-write-step statement that closes every revision retry hint. */
const RESTORED_WORKSPACE = OUTPUT_REPLAY_MODES["reset-write-step"].statement;

const PAGE = "docs/cli-reference.md";

/** The one issue and its admitted locators, as the recorded run's revision input. */
const revisionInput = {
  writePaths: [PAGE],
  actionableFacts: [
    {
      id: "FACT001",
      issueIds: ["TECH-001"],
      sourceLocators: ["README.md:3", "docs/guide.md:13", "docs/quickstart.md:3"],
    },
  ],
} as unknown as AuthoringRevisionInputV1;

/** The recorded reply's accounting: the page declared changed, the issue applied. */
function recordedResult(overrides: Partial<HarnessStepResult> = {}): HarnessStepResult {
  return {
    summary: "Applied the admitted correction.",
    authoringRevisionAccounting: {
      changedPaths: [PAGE],
      issueAccounting: [
        {
          disposition: "applied",
          issueId: "TECH-001",
          reason: "The page already stated the source-backed prerequisite.",
          sourceLocators: ["README.md:3", "docs/guide.md:13", "docs/quickstart.md:3"],
        },
      ],
      unresolvedFacts: [],
    },
    model: { provider: "fixture", model: "fixture-model" },
    usage: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, total: 5, turns: 1 },
    ...overrides,
  } as HarnessStepResult;
}

function replayObserving(
  observe: () => Promise<readonly string[]>,
  calls: string[] = [],
): AuthoringRevisionReplayV1 {
  return {
    lifecycle: {
      observeRevisionChangedPaths: async () => {
        calls.push("observe");
        return observe();
      },
      resetRevision: async () => {
        calls.push("reset");
      },
    },
    session: {} as AuthoringRevisionReplayV1["session"],
    input: revisionInput,
  };
}

describe("revision-accounting rules in the model-output catalog (#1266, #1130)", () => {
  it("declares every recorded revision-accounting code exactly once", () => {
    // The compile-time reading: an undeclared code does not typecheck.
    expect(REVISION_ACCOUNTING_REJECTION_CODES).toEqual(
      AUTHORING_REVISION_ACCOUNTING_DIAGNOSTIC_CODES.map((code) => `revision-accounting-${code}`),
    );
    expect(
      Object.values(OUTPUT_RULES)
        .filter((rule) => rule.family === "revision-accounting")
        .map((rule) => rule.code),
    ).toEqual([...REVISION_ACCOUNTING_REJECTION_CODES]);
    for (const code of REVISION_ACCOUNTING_REJECTION_CODES) {
      const rule = OUTPUT_RULES[code];
      expect(["model-correctable", "terminal"], code).toContain(rule.retry);
      expect(rule.reason.trim().length, code).toBeGreaterThan(0);
      expect(rule.locations, code).toHaveLength(1);
      expect(isRetainableInferenceRejection({ code, location: rule.locations[0] }), code).toBe(
        true,
      );
    }
  });

  it("keeps security and authority refusals terminal and the recorded mismatch correctable", () => {
    expect(isModelCorrectableOutputRule("revision-accounting-unsafe-disclosure")).toBe(false);
    expect(isModelCorrectableOutputRule("revision-accounting-source-locator-membership")).toBe(
      false,
    );
    expect(OUTPUT_RULES["revision-accounting-unsafe-disclosure"].kind).toBe("disclosure");
    expect(OUTPUT_RULES["revision-accounting-source-locator-membership"].kind).toBe("authority");
    expect(isModelCorrectableOutputRule("revision-accounting-changed-path-mismatch")).toBe(true);
    expect(isModelCorrectableOutputRule("revision-accounting-unchanged-applied")).toBe(true);
    expect(OUTPUT_RULES["revision-accounting-changed-path-mismatch"].locations).toEqual([
      RECORDED.location,
    ]);
  });

  it("gives every model-correctable code its statement as the hint, and every code a failure class", () => {
    const correctable = REVISION_ACCOUNTING_REJECTION_CODES.filter(isModelCorrectableOutputRule);
    expect(
      Object.keys(OUTPUT_RULE_HINTS)
        .filter((code) => code.startsWith("revision-accounting-"))
        .sort(),
    ).toEqual([...correctable].sort());
    for (const code of REVISION_ACCOUNTING_REJECTION_CODES) {
      expect(inferenceRejectionFailureClass(code), code).toBe(OUTPUT_RULES[code].failureClass);
      expect(Object.hasOwn(RESPONSE_REJECTION_RULE_HINTS, code), code).toBe(
        correctable.includes(code),
      );
    }
    for (const code of correctable) {
      // One sentence per rule: the contract states it and the retry repeats it.
      expect(OUTPUT_RULE_HINTS[code]!.rule).toBe(
        `${OUTPUT_RULES[code].statement} ${RESTORED_WORKSPACE}`,
      );
    }
  });

  it("states the recorded rejection's rule and the candidate-0 restore in the retry prompt", () => {
    const prompt = responseCorrectionInstruction({ rejection: RECORDED });
    expect(prompt).toContain(
      `The previous response failed host rule ${RECORDED.code} at ${RECORDED.location}.`,
    );
    expect(prompt).toContain(OUTPUT_RULE_HINTS[RECORDED.code]!.rule);
    expect(prompt).toContain("Rewriting a page with identical content does not change it.");
    expect(prompt).toContain(RESTORED_WORKSPACE);
    expect(prompt).not.toContain("has no specific repair hint");
    expect(prompt).not.toContain(PAGE);
  });

  it("reads a recorded code structurally and refuses anything outside the closed set", () => {
    expect(revisionAccountingDiagnosticForRejectionCode(RECORDED.code)).toBe(
      "changed-path-mismatch",
    );
    for (const code of [
      "revision-accounting-",
      "revision-accounting-unknown",
      "revision-accounting-historical-generic",
      "changed-path-mismatch",
      undefined,
      7,
    ]) {
      expect(revisionAccountingDiagnosticForRejectionCode(code), String(code)).toBeUndefined();
    }
  });
});

describe("host-reset writer retry surface (#1266)", () => {
  it.each([
    ["timeout", true, "declined-reset-write-step"],
    ["malformed-response", false, "declined-host-refusal"],
  ] as const)(
    "names why a %s the host-reset writer did not replay was declined",
    async (category, retryable, token) => {
      const execution = await executeInferenceStep({
        mode: "write",
        hostResetsWrites: true,
        policy: {
          maxRetries: 3,
          baseDelayMs: 1,
          maxDelayMs: 2,
          retryableCategories: ["malformed-response", "timeout"],
        },
        execute: async () => {
          throw new InferenceStepError("fixture failure", category, retryable);
        },
      });
      const attempt = execution.evidence.attempts[0]!;
      expect(attempt.retryDecision).toBe("declined");
      expect(inferenceRetryDecisionToken(attempt, execution.evidence)).toBe(token);
      expect(INFERENCE_RETRY_DECISION_REASONS[token]).toBeDefined();
    },
  );
});

describe("revision-accounting correction round (#1266)", () => {
  it("refuses the recorded unchanged rewrite as a coded, retryable attempt failure", async () => {
    const calls: string[] = [];
    const check = await checkAuthoringRevisionAttempt(
      replayObserving(async () => [], calls),
      recordedResult(),
    );

    expect(check.kind).toBe("refused");
    const refusal = (check as { refusal: InferenceStepError }).refusal;
    expect(refusal).toBeInstanceOf(InferenceStepError);
    expect(refusal.category).toBe("malformed-response");
    expect(refusal.retryable).toBe(true);
    expect(refusal.rejection).toEqual(RECORDED);
    expect(refusal.message).toBe(
      "Authoring revision accounting did not satisfy the host-owned contract: revision-accounting-changed-path-mismatch.",
    );
    // The refused attempt keeps its own provider evidence.
    expect(refusal.evidence).toMatchObject({
      model: { model: "fixture-model" },
      usage: { total: 5 },
    });
    expect(JSON.stringify(refusal)).not.toContain("source-backed prerequisite");
    expect(calls).toEqual(["observe"]);
  });

  it("refuses an applied issue when the declared paths match an unchanged revision", async () => {
    const result = recordedResult();
    const accounting = result.authoringRevisionAccounting as unknown as { changedPaths: string[] };
    accounting.changedPaths = [];
    const check = await checkAuthoringRevisionAttempt(
      replayObserving(async () => []),
      result,
    );

    expect(check.kind).toBe("refused");
    expect((check as { refusal: InferenceStepError }).refusal.rejection).toEqual({
      code: "revision-accounting-unchanged-applied",
      location: "$.issueAccounting[].disposition",
    });
  });

  it("admits accounting that matches the observed change", async () => {
    await expect(
      checkAuthoringRevisionAttempt(
        replayObserving(async () => [PAGE]),
        recordedResult(),
      ),
    ).resolves.toEqual({ kind: "admitted" });
  });

  it("leaves a plan-scope write denial and a non-success outcome to the step's own checks", async () => {
    const calls: string[] = [];
    const replay = replayObserving(async () => [], calls);
    for (const overrides of [
      { mutationBoundaryDenials: 1 },
      { outcome: "needs-input" as const },
      { authoringRevisionAccounting: undefined },
    ]) {
      await expect(
        checkAuthoringRevisionAttempt(replay, recordedResult(overrides)),
      ).resolves.toEqual({ kind: "admitted" });
    }
    expect(calls).toEqual([]);
  });

  it("reports a failed observation as a coded host fault, never the model's reply", async () => {
    const check = await checkAuthoringRevisionAttempt(
      replayObserving(async () => {
        throw new Error("The fixture snapshot failed.");
      }),
      recordedResult(),
    );

    expect(check.kind).toBe("host-fault");
    const fault = (check as { fault: AuthoringRevisionReplayError }).fault;
    expect(fault).toBeInstanceOf(AuthoringRevisionReplayError);
    expect(fault.code).toBe("authoring-revision-observation-failed");
    expect(Object.keys(fault)).not.toContain("cause");
  });

  it("codes a failed candidate-0 restore as a host fault", async () => {
    const replay = replayObserving(async () => []);
    const failing: AuthoringRevisionReplayV1 = {
      ...replay,
      lifecycle: {
        ...replay.lifecycle,
        resetRevision: async () => {
          throw new Error("The fixture restore failed.");
        },
      },
    };

    await expect(resetAuthoringRevisionForRetry(failing)).rejects.toMatchObject({
      code: "authoring-revision-reset-failed",
      message:
        "The authoring revision workspace could not be restored to candidate 0 before a retry.",
    });
  });
});
