// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import type { HarnessStepResult } from "../src/execution/contracts.js";
import type { WorkflowName } from "../src/workflow-contracts/contracts.js";
import { InferenceStepError } from "../src/execution/contracts.js";
import {
  HOST_REFUSED_REPLY_OBLIGATION_REASON,
  hostFillRefusedJudgment,
  refusedWithNoRetryLeft,
} from "../src/harness/cut-judgment.js";
import { buildHostStepPrompt } from "../src/harness/pi.js";
import { parseRetryPolicy } from "../src/config/retry-policy.js";
import { contractPlaceholderScope } from "../src/workflow-execution/contract-placeholders.js";
import { HOST_FILLED_COVERAGE_REASON } from "../src/workflow-execution/judgment-coverage.js";
import {
  decodeProvisionalVerificationJudgment,
  judgmentCoveragePolicy,
  validateTechnicalCorrectionEvidence,
} from "../src/workflow-execution/source-obligation.js";
import {
  RECORDED_JUDGMENT_TARGET,
  probe7AttemptRows,
  recordedReviewJudgmentFixture,
  withIssueJudgment,
} from "./helpers/recorded-review-judgment.js";
import { sourceObligationProposalFixture } from "./helpers/verification.js";
import {
  HarnessStepInput,
  bindSourceObligationLedger,
  captureInferenceFailure,
  createAuditHarness,
  createRepository,
  createReviewHarness,
  expectDecodedAttemptEvidence,
  resetSharedTestState,
  scriptedProvider,
  textTurn,
  validModelConfig,
} from "./support/pi-harness-session-fixtures.js";
import { configureCredential } from "./helpers/configured-credential.js";

afterEach(async () => {
  vi.unstubAllEnvs();
  await resetSharedTestState();
});

/**
 * Model content fails open; credential material and write or publish authority
 * fail closed. On the two `review-documentation` judgment steps, once no retry
 * of a refusal will follow (the attempt the runner marks final, or a refusal
 * that is never retried), a reply the step's admission refused for anything but
 * its credential screen is admitted as the all-host-filled floor:
 * every obligation host-filled and unverified, coverage host-filled, no issue
 * judgment, verdict `human-review`, and one content-free host note.
 *
 * Cases drive `PiHarness.runStep` with a scripted provider over a recorded
 * ledger of 18 obligations in six applicable dimensions, and a recorded model
 * judgment against that ledger. They set `finalInferenceAttempt` the way the runner
 * does for the configured budget, read through `parseRetryPolicy({})`.
 */
describe("PiHarness floor for a review judgment refused with no retry left", () => {
  const TARGETS = [RECORDED_JUDGMENT_TARGET];
  /** The attempt the configured read-only budget ends on: `retry.maxRetries + 1`. */
  const FINAL_ATTEMPT = parseRetryPolicy({}).maxRetries + 1;
  const COMPLETION_STEM = "Host judgment completion:";

  function recordedFixture(
    repositoryPath: string,
    workflowName: WorkflowName = "review-documentation",
  ) {
    return recordedReviewJudgmentFixture(repositoryPath, { workflowName });
  }

  /** `input` as the runner hands it to the attempt the configured budget ends on. */
  function onFinalAttempt(input: HarnessStepInput): HarnessStepInput {
    return {
      ...input,
      inferenceAttempt: FINAL_ATTEMPT,
      retriesConsumed: FINAL_ATTEMPT - 1,
      finalInferenceAttempt: true,
    };
  }

  /** `input` as the runner hands it to the first attempt, with retries left. */
  function onFirstAttempt(input: HarnessStepInput): HarnessStepInput {
    return { ...input, inferenceAttempt: 1, retriesConsumed: 0, finalInferenceAttempt: false };
  }

  function recordingProvider(responses: readonly Response[]) {
    const provider = scriptedProvider(responses);
    const fetchMock = vi.fn(async (request: RequestInfo | URL, init?: RequestInit) =>
      provider(request, init),
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  function dimensions(result: HarnessStepResult) {
    return Object.fromEntries(
      (result.verificationResult?.factInventory.dimensions ?? []).map((dimension) => [
        dimension.dimension,
        `${dimension.status}:${dimension.facts.length}`,
      ]),
    );
  }

  function limitationsStartingWith(result: HarnessStepResult, stem: string): string[] {
    return (result.verificationResult?.factInventory.limitations ?? []).filter((entry) =>
      entry.startsWith(stem),
    );
  }

  /** The floor note, written out as the oracle rather than rebuilt from the module. */
  function floorNote(stepId: string, code: string, attempts = FINAL_ATTEMPT): string {
    const spent = `${attempts.toLocaleString("en-US")} ${attempts === 1 ? "attempt" : "attempts"}`;
    return (
      `Host judgment completion: the step's own checks refused the ${stepId} judgment reply with no retry left ` +
      `(${spent} spent, rejection code ${code}), so the host kept none of that reply. ` +
      "The host kept 0 complete obligation judgments and recorded 18 unverified, " +
      "kept 0 coverage entries and host-filled 1, " +
      "and kept 0 issue judgments and dropped 0; " +
      "the verdict is human-review."
    );
  }

  /** The six applicable dimensions of the recorded ledger, with their obligation counts. */
  const LEDGER_DIMENSIONS = [
    ["input-representations", 3],
    ["defaults-and-overrides", 3],
    ["mutable-state", 1],
    ["destination-and-trust", 3],
    ["error-status-retry", 5],
    ["environment-prerequisite", 3],
  ] as const;

  /** The host demotion reason of one dimension of a floored reply, as the oracle. */
  function floorDemotion(dimension: string, obligations: number): string {
    return `Host demotion judgment-reply-refused: the step's own checks refused the judgment reply with no retry left, so the host kept no judgment of ${obligations} of the ${obligations} obligations of the applicable ledger dimension ${dimension}, no source-verified fact remains for it, and human review is required.`;
  }

  function expectFloor(
    result: HarnessStepResult,
    stepId: string,
    code: string,
    attempts = FINAL_ATTEMPT,
  ): void {
    expect(result.verificationResult?.review).toEqual({ verdict: "human-review", issues: [] });
    expect(Object.values(dimensions(result))).toEqual(Array(6).fill("unverified:0"));
    expect(result.verificationResult?.coverage).toEqual([
      { path: TARGETS[0], status: "unverified", evidence: [], reason: HOST_FILLED_COVERAGE_REASON },
    ]);
    expect(limitationsStartingWith(result, COMPLETION_STEM)).toEqual([
      floorNote(stepId, code, attempts),
    ]);
    // The demotion names the refusal, not a cut.
    expect(limitationsStartingWith(result, "Host demotion judgment-reply-refused:").sort()).toEqual(
      LEDGER_DIMENSIONS.map(([dimension, obligations]) =>
        floorDemotion(dimension, obligations),
      ).sort(),
    );
    expect(limitationsStartingWith(result, "Host demotion answer-cut-at-output-limit")).toEqual([]);
    const evidenceLines = limitationsStartingWith(
      result,
      "Host demotion evidence for rejected source obligation OBL-",
    );
    expect(evidenceLines).toHaveLength(18);
    for (const line of evidenceLines) {
      expect(line).toMatch(
        /\): judgment-reply-refused, the step's own checks refused the reply with no retry left, so the host kept none of it and filled it\.$/u,
      );
    }
  }

  describe("T1-T2: the floor once no retry is left", () => {
    it("T1: admits the floor when step 4's final reply has an off-vocabulary severity", async () => {
      // A retryable `judgment-severity-invalid` rejection, which would record
      // `exhausted` on the final attempt without the floor.
      const repositoryPath = await createRepository();
      const fixture = recordedFixture(repositoryPath);
      const fetchMock = recordingProvider([
        textTurn(withIssueJudgment(fixture.judgment, "TECH-001", { severity: "blocker" })),
      ]);

      const result = await (await createReviewHarness(true)).runStep(
        onFinalAttempt(fixture.provisional),
      );

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expectFloor(result, "provisional-technical-verification", "judgment-severity-invalid");
      // No reply text reaches the note: the refused severity value is absent.
      expect(limitationsStartingWith(result, COMPLETION_STEM)[0]).not.toContain("blocker");
      // The row-key audit measures the reply the step admitted: the floor.
      expect(result.judgmentRowKeyAudit).toMatchObject({
        issueJudgments: { rows: 0 },
        obligationJudgments: { rows: 18, undeclaredKeys: 0 },
      });
      expect(result.turns?.map((turn) => turn.rawStopReason)).toEqual(["stop"]);
      expect(result.executionLease).toMatchObject({
        providerTurns: 1,
        terminalReason: "completed",
      });
      expectDecodedAttemptEvidence(result, "succeeded", false);
    });

    it("T1b: admits the floor for probe 7's attempt shape, rows without documentationDisposition", async () => {
      // `{obligationId, disposition: "retained"}` rows; the disposition rule
      // names the member.
      const repositoryPath = await createRepository();
      const fixture = recordedFixture(repositoryPath);
      recordingProvider([textTurn(probe7AttemptRows(fixture.judgment))]);

      const result = await (await createReviewHarness(true)).runStep(
        onFinalAttempt(fixture.provisional),
      );

      expectFloor(
        result,
        "provisional-technical-verification",
        "judgment-documentation-disposition-invalid",
      );
    });

    it("T2: admits the floor on step 5 as V3 evidence that re-validates without the policy", async () => {
      const repositoryPath = await createRepository();
      const fixture = recordedFixture(repositoryPath);
      recordingProvider([
        textTurn(withIssueJudgment(fixture.judgment, "TECH-001", { severity: "blocker" })),
      ]);

      const result = await (await createAuditHarness()).runStep(onFinalAttempt(fixture.correction));

      expectFloor(result, "verify-technical-accuracy", "judgment-severity-invalid");
      const evidence = result.technicalCorrectionEvidence;
      expect(evidence?.schemaVersion).toBe(3);
      const accounting =
        evidence?.schemaVersion === 3 ? evidence.proposal.obligationAccounting : undefined;
      expect(
        accounting?.map((row) => (row.disposition === "rejected" ? row.reason : row.disposition)),
      ).toEqual(Array(18).fill(HOST_REFUSED_REPLY_OBLIGATION_REASON));
      // The runner, run records and delivery re-validate with no policy in hand.
      expect(
        validateTechnicalCorrectionEvidence(
          evidence,
          fixture.ledger,
          result.verificationResult!,
          fixture.sealedEvidence,
          TARGETS,
        ),
      ).toEqual(evidence);
    });

    it.each([
      ["the first attempt", onFirstAttempt, 1],
      ["the final attempt", onFinalAttempt, FINAL_ATTEMPT],
    ] as const)(
      "floors an issue located outside the targets on %s, a refusal never retried",
      async (_label, mark, attempts) => {
        // `target-authority` is not retryable. The floor keeps nothing of the
        // reply, so the out-of-target page does not reach the record.
        const repositoryPath = await createRepository();
        const fixture = recordedFixture(repositoryPath);
        recordingProvider([
          textTurn(
            withIssueJudgment(fixture.judgment, "TECH-001", { location: "docs/elsewhere.md:11" }),
          ),
        ]);

        const result = await (await createAuditHarness()).runStep(mark(fixture.provisional));

        expectFloor(result, "provisional-technical-verification", "target-authority", attempts);
        expect(JSON.stringify(result.verificationResult)).not.toContain("docs/elsewhere.md");
      },
    );
  });

  describe("a path cited in the reply's prose", () => {
    const PROSE =
      "Compared the page with the source: it runs under /usr/bin/env as /home/node, " +
      "logs file:42, and writes /tmp/x.";

    it.each([
      ["provisional-technical-verification", "provisional"],
      ["verify-technical-accuracy", "correction"],
    ] as const)("is admitted, not refused or floored, on %s", async (_label, step) => {
      const repositoryPath = await createRepository();
      const fixture = recordedFixture(repositoryPath);
      const [coverage] = fixture.judgment.coverage as Array<Record<string, unknown>>;
      recordingProvider([
        textTurn(
          JSON.stringify({ ...fixture.judgment, coverage: [{ ...coverage, reason: PROSE }] }),
        ),
      ]);

      const result = await (await createAuditHarness()).runStep(fixture[step]);

      expect(result.verificationResult?.coverage).toEqual([
        expect.objectContaining({ path: TARGETS[0], status: "verified", reason: PROSE }),
      ]);
      expect(limitationsStartingWith(result, COMPLETION_STEM)).toEqual([]);
    });
  });

  describe("the floor's own condition and reply, read directly", () => {
    const refusal = (category: InferenceStepError["category"], retryable: boolean) =>
      new InferenceStepError("A refusal.", category, retryable, undefined, {
        code: "judgment-severity-invalid",
        location: "$.issueJudgments[].severity",
      });

    it("names a refusal with no retry left other than a credential match", async () => {
      const fixture = recordedFixture(await createRepository());
      const first = onFirstAttempt(fixture.provisional);
      const final = onFinalAttempt(fixture.provisional);
      const disclosure = () =>
        new InferenceStepError("A refusal.", "malformed-response", false, undefined, {
          code: "unsafe-disclosure",
          location: "$response",
        });
      // Only a credential match raises `unsafe-disclosure`, and it stays closed.
      const credential = disclosure();

      expect(refusedWithNoRetryLeft(final, refusal("malformed-response", true))).toBe(true);
      expect(refusedWithNoRetryLeft(first, refusal("malformed-response", false))).toBe(true);
      expect(refusedWithNoRetryLeft(first, refusal("malformed-response", true))).toBe(false);
      expect(refusedWithNoRetryLeft(final, credential)).toBe(false);
      expect(refusedWithNoRetryLeft(first, credential)).toBe(false);
      expect(refusedWithNoRetryLeft(final, new Error("A host fault."))).toBe(false);
    });

    it("writes human-review and keeps nothing of the refused reply in the floor it builds", async () => {
      // The decoder also forces human-review over unverified coverage, so this
      // reads the host-authored reply itself.
      const fixture = recordedFixture(await createRepository());

      const floor = hostFillRefusedJudgment(
        onFinalAttempt(fixture.provisional),
        refusal("malformed-response", true),
      );

      const reply = JSON.parse(floor.reply) as Record<string, unknown>;
      expect(reply.verdict).toBe("human-review");
      expect(reply.coverage).toEqual([]);
      expect(reply.issueJudgments).toEqual([]);
      expect(reply.obligationJudgments).toHaveLength(18);
      expect(floor.coveragePolicy).toMatchObject({
        degradeCoverage: true,
        hostFillReason: "judgment-reply-refused",
      });
      expect(floor.coveragePolicy.hostFilledObligationIds?.size).toBe(18);
    });
  });

  describe("T3: adjacent conditions keep today's behaviour", () => {
    it.each([
      ["a first attempt with retries left", onFirstAttempt],
      [
        "an attempt the runner did not mark",
        (input: HarnessStepInput) => ({
          ...input,
          inferenceAttempt: FINAL_ATTEMPT,
          retriesConsumed: FINAL_ATTEMPT - 1,
        }),
      ],
    ] as const)("rethrows the same refusal retryable on %s", async (_label, mark) => {
      const repositoryPath = await createRepository();
      const fixture = recordedFixture(repositoryPath);
      recordingProvider([
        textTurn(withIssueJudgment(fixture.judgment, "TECH-001", { severity: "blocker" })),
      ]);

      const error = await captureInferenceFailure(
        await createReviewHarness(true),
        mark(fixture.provisional),
      );

      expect(error.message).toBe("Technical correction response rejected: invalid-review.");
      expect(error.category).toBe("malformed-response");
      expect(error.retryable).toBe(true);
      expect(error.rejection).toEqual({
        code: "judgment-severity-invalid",
        location: "$.issueJudgments[].severity",
      });
    });

    it.each([
      ["the first attempt", onFirstAttempt],
      ["the final attempt", onFinalAttempt],
    ] as const)("still fails a credential in the reply on %s", async (_label, mark) => {
      // Credential material stays fail-closed. The token is built at run time so
      // this file carries no credential-shaped literal.
      const repositoryPath = await createRepository();
      const fixture = recordedFixture(repositoryPath);
      const token = configureCredential(["glpat", "a".repeat(24)].join("-"));
      recordingProvider([
        textTurn(withIssueJudgment(fixture.judgment, "TECH-001", { obligationIds: [token] })),
      ]);

      const error = await captureInferenceFailure(
        await createAuditHarness(),
        mark(fixture.provisional),
      );

      expect(error.message).toBe("Technical correction response rejected: unsafe-disclosure.");
      expect(error.retryable).toBe(false);
    });

    it("still refuses create-documentation's judgment step on its final attempt (#1293)", async () => {
      const repositoryPath = await createRepository();
      const fixture = recordedFixture(repositoryPath, "create-documentation");
      recordingProvider([
        textTurn(withIssueJudgment(fixture.judgment, "TECH-001", { severity: "blocker" })),
      ]);

      const error = await captureInferenceFailure(
        await createAuditHarness(),
        onFinalAttempt(fixture.provisional),
      );

      expect(error.message).toBe("Technical correction response rejected: invalid-review.");
      expect(error.retryable).toBe(true);
      expect(error.rejection).toEqual({
        code: "judgment-severity-invalid",
        location: "$.issueJudgments[].severity",
      });
    });

    it("still refuses a judgment step over a V1 ledger on its final attempt", async () => {
      // A V1 ledger keeps the strict legacy validator: the judgment shape is not
      // its contract.
      const repositoryPath = await createRepository();
      const fixture = recordedFixture(repositoryPath);
      const v1Input: HarnessStepInput = {
        ...fixture.correction,
        sourceObligationLedger: bindSourceObligationLedger(
          sourceObligationProposalFixture(),
          fixture.correction,
          [{ path: "src/api.ts", sha256: "f".repeat(64) }],
        ),
      };
      recordingProvider([textTurn(probe7AttemptRows(fixture.judgment))]);

      const error = await captureInferenceFailure(
        await createAuditHarness(),
        onFinalAttempt(v1Input),
      );

      expect(error.message).toMatch(/^Technical correction response rejected: invalid-shape\./u);
      expect(error.message).not.toContain(COMPLETION_STEM);
    });

    it("keeps V6's cut path for an answer cut on the final attempt", async () => {
      // A cut answer is completed from the elements it kept, and its note
      // names the cut, whatever attempt it arrived on.
      const repositoryPath = await createRepository();
      const fixture = recordedFixture(repositoryPath);
      const limit = validModelConfig.profile.maxOutputTokens;
      const usage = { prompt_tokens: 10, completion_tokens: limit, total_tokens: 10 + limit };
      const cutAt = fixture.answer.indexOf('{"obligationId":"OBL-DESTINATION-AND-TRUST-1"') + 30;
      const half = Math.floor(cutAt / 2);
      recordingProvider([
        textTurn(fixture.answer.slice(0, half), validModelConfig.modelId, "length", usage),
        textTurn(fixture.answer.slice(half, cutAt), validModelConfig.modelId, "length", usage),
      ]);

      const result = await (await createAuditHarness()).runStep(
        onFinalAttempt(fixture.provisional),
      );

      const [note] = limitationsStartingWith(result, COMPLETION_STEM);
      expect(note).toContain("judgment answer was cut at the");
      expect(note).toContain(
        "The host kept 7 complete obligation judgments and recorded 11 unverified,",
      );
      expect(note).not.toContain("with no retry left");
      expect(
        limitationsStartingWith(result, "Host demotion answer-cut-at-output-limit:"),
      ).toHaveLength(3);
      expect(limitationsStartingWith(result, "Host demotion judgment-reply-refused")).toEqual([]);
    });
  });

  describe("T4: real-reply positive control", () => {
    it.each([
      ["a first attempt", onFirstAttempt],
      ["the final attempt", onFinalAttempt],
    ] as const)("admits the recorded real judgment unchanged on %s", async (_label, mark) => {
      // A valid reply never takes the floor: it decodes exactly as the decoder
      // alone decodes it, with no host completion note.
      const repositoryPath = await createRepository();
      const fixture = recordedFixture(repositoryPath);
      recordingProvider([textTurn(fixture.answer)]);

      const result = await (await createReviewHarness(true)).runStep(mark(fixture.provisional));

      expect(result.verificationResult).toEqual(
        decodeProvisionalVerificationJudgment(
          fixture.answer,
          fixture.ledger,
          TARGETS,
          undefined,
          judgmentCoveragePolicy(fixture.provisional),
        ),
      );
      expect(result.verificationResult?.review.verdict).toBe("needs-revision");
      expect(limitationsStartingWith(result, COMPLETION_STEM)).toEqual([]);
    });
  });

  it("renders no contract placeholder on either judgment step, so no placeholder scan re-reads a floored reply", async () => {
    // `pi.ts` scans the model's reply for copied contract placeholders after
    // admission. It can only refuse a value of a role the step's own contract
    // rendered; if either judgment contract ever renders one, the floor must be
    // re-checked against that scan. The final attempt's prompt carries the
    // previous refusal's correction.
    const repositoryPath = await createRepository();
    const fixture = recordedFixture(repositoryPath);
    for (const input of [fixture.provisional, fixture.correction]) {
      for (const responseCorrection of [
        undefined,
        {
          rejection: {
            code: "judgment-documentation-disposition-invalid",
            location: "$.obligationJudgments[].documentationDisposition",
          },
        },
        {
          rejection: { code: "judgment-severity-invalid", location: "$.issueJudgments[].severity" },
        },
      ]) {
        const prompt = buildHostStepPrompt(
          {
            ...onFinalAttempt(input),
            ...(responseCorrection ? { responseCorrection } : {}),
          },
          "",
          validModelConfig.profile.maxOutputTokens,
        );
        expect([...contractPlaceholderScope(prompt)], input.step.id).toEqual([]);
      }
    }
  });
});
