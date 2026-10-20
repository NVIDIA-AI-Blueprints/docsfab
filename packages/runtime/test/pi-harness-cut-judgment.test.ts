// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { HarnessStepResult } from "../src/execution/contracts.js";
import {
  HOST_UNJUDGED_OBLIGATION_REASON,
  hostCompleteCutJudgment,
  type CutJudgmentAnswer,
} from "../src/harness/cut-judgment.js";
import { lengthStopContinuationPrompt } from "../src/harness/length-stop-continuation.js";
import { lengthStopNudgeText } from "../src/model/provider-turn-retry.js";
import { HOST_FILLED_COVERAGE_REASON } from "../src/workflow-execution/judgment-coverage.js";
import {
  decodeProvisionalVerificationJudgment,
  judgmentCoveragePolicy,
  validateTechnicalCorrectionEvidence,
} from "../src/workflow-execution/source-obligation.js";
import { sourceObligationProposalFixture } from "./helpers/verification.js";
import {
  HarnessStepInput,
  PiHarness,
  SourceObligationLedgerProposalV1,
  bindSourceObligationLedger,
  bindSourceObligationLedgerV2,
  blankTurn,
  captureInferenceFailure,
  createAuditHarness,
  createInstantReplayAuditHarness,
  createProviderConnectionFactory,
  createRepository,
  createReviewHarness,
  expectDecodedAttemptEvidence,
  getWorkflow,
  issueOriginalSourceAuthorityAdmission,
  limitDefinition,
  fixtureCompositionExecutionProfile,
  resetSharedTestState,
  reviewSourcePhaseInput,
  scriptedProvider,
  sealOriginalSourceAuthority,
  skillCrateDirectory,
  sourceObligationScopeSha256,
  textTurn,
  toolTurn,
  validModelConfig,
} from "./support/pi-harness-session-fixtures.js";

afterEach(resetSharedTestState);

/**
 * Model content fails open, so on the two review judgment steps a cut answer
 * keeps its complete elements, the host fills the rest unverified, forces
 * `human-review`, and names the cut in one host limitation.
 *
 * Cases drive `PiHarness.runStep` with a scripted provider over a recorded
 * ledger of 18 obligations in six applicable dimensions, and a recorded model
 * judgment against that ledger, cut inside a row after k complete rows.
 */
describe("PiHarness host completion of a review judgment answer cut at the output limit", () => {
  const OUTPUT_LIMIT = validModelConfig.profile.maxOutputTokens;
  const LIMIT_LABEL = OUTPUT_LIMIT.toLocaleString("en-US");
  /** A cut turn bills the whole per-turn budget, read from the bound profile. */
  const CUT_USAGE = {
    prompt_tokens: 10,
    completion_tokens: OUTPUT_LIMIT,
    total_tokens: 10 + OUTPUT_LIMIT,
  };
  const TARGETS = ["docs/quickstart.md"];
  const RUN_ID = "review-cli-1219";

  const cutTurn = (text: string) => textTurn(text, validModelConfig.modelId, "length", CUT_USAGE);
  const blankCutTurn = () => blankTurn("length", CUT_USAGE);

  function read(name: string): unknown {
    return JSON.parse(
      readFileSync(new URL(`./fixtures/review-cli-correction/${name}`, import.meta.url), "utf8"),
    );
  }

  /** The recorded ledger, sealed for this repository, and the steps that judge it. */
  function recordedFixture(repositoryPath: string, workflowName = "review-documentation") {
    const ledgerFixture = read("recorded-ledger.json") as {
      ledgerProposal: SourceObligationLedgerProposalV1;
      repositoryRevision: string;
      sources: Array<{ path: string; sha256: string }>;
    };
    const judgment = read("recorded-judgment.json") as Record<string, unknown>;
    const workflow = getWorkflow(workflowName);
    const base = reviewSourcePhaseInput(repositoryPath, "derive-source-obligations");
    const reviewScope = { ...base.reviewScope!, targetPaths: [...TARGETS] };
    const evidenceIdentity = { repositoryRevision: ledgerFixture.repositoryRevision };
    const deriveInput: HarnessStepInput = {
      ...base,
      workflow,
      runId: RUN_ID,
      evidenceIdentity,
      reviewScope,
    };
    const scopeSha256 = sourceObligationScopeSha256(deriveInput);
    const sourceSha256 = ledgerFixture.sources[0]!.sha256;
    const sealed = sealOriginalSourceAuthority({
      runId: RUN_ID,
      scope:
        workflowName === "create-documentation"
          ? "create-plan-sources"
          : "review-tracked-workspace",
      repositoryRevision: ledgerFixture.repositoryRevision,
      scopeSha256,
      workspaceSnapshotSha256: deriveInput.searchEvidence!.workspaceSnapshotSha256,
      members: [{ path: "src/sprout.mjs", mode: 0o755, byteLength: 1, sourceSha256 }],
    });
    const ledger = bindSourceObligationLedgerV2(
      ledgerFixture.ledgerProposal,
      deriveInput,
      ledgerFixture.sources,
      sealed.evidence,
    );
    const admission = issueOriginalSourceAuthorityAdmission({
      capture: sealed.capture,
      observer: { observe: async (paths) => paths.map((path) => ({ path, sha256: sourceSha256 })) },
      runId: RUN_ID,
      repositoryRevision: ledgerFixture.repositoryRevision,
      scopeSha256,
      workspaceSnapshotSha256: deriveInput.searchEvidence!.workspaceSnapshotSha256,
    });
    const stepInput = (stepId: string): HarnessStepInput => ({
      ...reviewSourcePhaseInput(repositoryPath, "provisional-technical-verification"),
      workflow,
      step: workflow.steps.find((step) => step.id === stepId)!,
      runId: RUN_ID,
      evidenceIdentity,
      reviewScope,
      sourceObligationLedger: ledger,
    });
    return {
      ledger,
      judgment,
      /** The real reply, in the member order the model wrote it. */
      answer: JSON.stringify(judgment),
      sealedEvidence: sealed.evidence,
      provisional: stepInput("provisional-technical-verification"),
      correction: {
        ...stepInput("verify-technical-accuracy"),
        originalSourceAuthorityAdmission: admission,
      } satisfies HarnessStepInput,
    };
  }

  function insideRow(answer: string, obligationId: string, offset = 30): number {
    const index = answer.indexOf(`{"obligationId":"${obligationId}"`);
    expect(index, `row ${obligationId} not in the answer`).toBeGreaterThan(0);
    return index + offset;
  }

  function recordingProvider(responses: readonly Response[]) {
    const requests: Array<{ messages?: Array<{ role?: unknown; content?: unknown }> }> = [];
    const provider = scriptedProvider(responses);
    const fetchMock = vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)));
      return provider(request, init);
    });
    vi.stubGlobal("fetch", fetchMock);
    return { requests, fetchMock };
  }

  function userTexts(request: { messages?: Array<{ role?: unknown; content?: unknown }> }) {
    return (request.messages ?? [])
      .filter((message) => message.role === "user")
      .map((message) =>
        Array.isArray(message.content)
          ? message.content.map((part) => (part as { text?: string }).text ?? "").join("")
          : typeof message.content === "string"
            ? message.content
            : "",
      );
  }

  type Result = HarnessStepResult;

  function dimensions(result: Result) {
    return Object.fromEntries(
      (result.verificationResult?.factInventory.dimensions ?? []).map((dimension) => [
        dimension.dimension,
        `${dimension.status}:${dimension.facts.length}`,
      ]),
    );
  }

  function limitationsStartingWith(result: Result, stem: string): string[] {
    return (result.verificationResult?.factInventory.limitations ?? []).filter((entry) =>
      entry.startsWith(stem),
    );
  }

  /** The host note, written out as the oracle rather than rebuilt from the module. */
  function completionNote(parts: {
    stepId: string;
    shape: string;
    continuations: string;
    billed: string;
    retained: number;
    kept: string;
    filled: number;
    coverage: string;
    issues: string;
  }): string {
    return (
      `Host judgment completion: the ${parts.stepId} judgment answer was cut at the ${LIMIT_LABEL}-token output limit (${parts.shape}) after ${parts.continuations}; ` +
      `the answer turns billed ${parts.billed} output tokens and the host retained ${parts.retained.toLocaleString("en-US")} characters. ` +
      `The host kept ${parts.kept} and recorded ${parts.filled} unverified, ` +
      `${parts.coverage}, ` +
      `and ${parts.issues}; ` +
      "the verdict is human-review."
    );
  }

  it("T1: keeps the complete rows of a step-4 answer cut twice and fills the rest unverified", async () => {
    // The answer turn cut at the limit, then the one continuation the catalog
    // default allows cut again, after 7 complete rows of 18.
    const repositoryPath = await createRepository();
    const fixture = recordedFixture(repositoryPath);
    const cutAt = insideRow(fixture.answer, "OBL-DESTINATION-AND-TRUST-1");
    const firstCut = Math.floor(cutAt / 3);
    const { fetchMock } = recordingProvider([
      cutTurn(fixture.answer.slice(0, firstCut)),
      cutTurn(fixture.answer.slice(firstCut, cutAt)),
    ]);

    const result = await (await createReviewHarness(true)).runStep(fixture.provisional);

    // No third turn is bought.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.verificationResult?.review.verdict).toBe("human-review");
    // The 7 complete rows kept their facts; the dimensions of the 11
    // obligations no complete row judged are unverified.
    expect(dimensions(result)).toEqual({
      "input-representations": "applicable:3",
      "defaults-and-overrides": "applicable:3",
      "mutable-state": "applicable:1",
      "destination-and-trust": "unverified:0",
      "error-status-retry": "unverified:0",
      "environment-prerequisite": "unverified:0",
    });
    const keptStatements = fixture.ledger.dimensions
      .slice(0, 3)
      .flatMap((dimension) => dimension.obligations.map(({ statement }) => statement))
      .sort();
    expect(
      result.verificationResult?.factInventory.dimensions
        .flatMap((dimension) => dimension.facts.map(({ statement }) => statement))
        .sort(),
    ).toEqual(keptStatements);
    // TECH-002 and TECH-004 cite only filled obligations and TECH-003 is left
    // with nothing open, so all three drop; TECH-005 loses six links to filled
    // obligations and keeps the five open facts it still supports.
    expect(result.verificationResult?.review.issues.map(({ id }) => id)).toEqual([
      "TECH-001",
      "TECH-005",
    ]);
    expect(limitationsStartingWith(result, "Host judgment completion:")).toEqual([
      completionNote({
        stepId: "provisional-technical-verification",
        shape: "text-truncated",
        continuations: "1 continuation turn",
        billed: (2 * OUTPUT_LIMIT).toLocaleString("en-US"),
        retained: cutAt,
        kept: "7 complete obligation judgments",
        filled: 11,
        coverage: "kept 1 coverage entry and host-filled 0",
        issues:
          "kept 2 issue judgments after pruning 6 links to host-filled obligations and dropped 3",
      }),
    ]);
    expect(
      limitationsStartingWith(result, "Host demotion answer-cut-at-output-limit:"),
    ).toHaveLength(3);
    expect(
      limitationsStartingWith(result, "Host demotion evidence for rejected source obligation OBL-"),
    ).toHaveLength(11);
    // Both turns stopped at the limit, the attempt settled, and the lease
    // completed without a new reason.
    expect(result.turns?.map((turn) => turn.rawStopReason)).toEqual(["length", "length"]);
    expect(result.modelTelemetry?.finishReason).toBe("length");
    expect(result.executionLease).toMatchObject({ providerTurns: 2, terminalReason: "completed" });
    // The scorecard reader that delivery and `parseScorecardRunRecord` share
    // admits a succeeded attempt whose last turn stopped at the limit.
    expectDecodedAttemptEvidence(result, "succeeded", false);
  });

  it("T2: completes probe 5's blank continuation, pinning the nudged replay's wire shape", async () => {
    // The continuation's first request comes back blank at the limit and the
    // in-turn nudged replay is cut again. The nudge asks for "the complete
    // terminal answer", so the model may restart: the replay re-emits the answer
    // and is cut after 11 complete rows. The final cut alone keeps more rows
    // than the stitched text and wins.
    const repositoryPath = await createRepository();
    const fixture = recordedFixture(repositoryPath);
    const firstCut = fixture.answer.indexOf('"TECH-003"');
    const restartCut = insideRow(fixture.answer, "OBL-ERROR-STATUS-RETRY-2");
    const { requests, fetchMock } = recordingProvider([
      cutTurn(fixture.answer.slice(0, firstCut)),
      blankCutTurn(),
      cutTurn(fixture.answer.slice(0, restartCut)),
    ]);

    const result = await (await createInstantReplayAuditHarness()).runStep(fixture.provisional);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    // Pins the replay wire shape: the blank request ends on the continuation
    // ask, and its replay appends the length-stop nudge after that same ask.
    const continuationAsk = lengthStopContinuationPrompt(OUTPUT_LIMIT, firstCut);
    expect(userTexts(requests[1]!).at(-1)).toBe(continuationAsk);
    expect(userTexts(requests[2]!).slice(-2)).toEqual([
      continuationAsk,
      lengthStopNudgeText(OUTPUT_LIMIT),
    ]);
    expect(result.verificationResult?.review.verdict).toBe("human-review");
    // A dimension that kept a complete row stays applicable with that fact;
    // its unjudged obligations are named by their host rows instead.
    expect(dimensions(result)).toEqual({
      "input-representations": "applicable:3",
      "defaults-and-overrides": "applicable:3",
      "mutable-state": "applicable:1",
      "destination-and-trust": "applicable:4",
      "error-status-retry": "applicable:1",
      "environment-prerequisite": "unverified:0",
    });
    expect(
      limitationsStartingWith(result, "Rejected source obligation OBL-ERROR-STATUS-RETRY-"),
    ).toEqual(
      ["2", "3", "4", "5"].map((ordinal) =>
        expect.stringContaining(
          `Rejected source obligation OBL-ERROR-STATUS-RETRY-${ordinal}: ${HOST_UNJUDGED_OBLIGATION_REASON}`,
        ),
      ),
    );
    expect(limitationsStartingWith(result, "Host judgment completion:")).toEqual([
      completionNote({
        stepId: "provisional-technical-verification",
        shape: "text-truncated",
        continuations: "1 continuation turn",
        // The first cut, plus the blank request and its replay folded into
        // the continuation turn.
        billed: (3 * OUTPUT_LIMIT).toLocaleString("en-US"),
        retained: firstCut + restartCut,
        kept: "11 complete obligation judgments",
        filled: 7,
        coverage: "kept 1 coverage entry and host-filled 0",
        issues:
          "kept 4 issue judgments after pruning 5 links to host-filled obligations and dropped 1",
      }),
    ]);
    expect(result.executionLease).toMatchObject({ terminalReason: "completed" });
  });

  it("T3: fills the whole answer when the cut surfaced nothing (output-truncated)", async () => {
    // The turn is blank at the limit and its nudged replay is blank again.
    // Nothing is recoverable, and every obligation, target and dimension is
    // host-filled.
    const repositoryPath = await createRepository();
    const fixture = recordedFixture(repositoryPath);
    const { fetchMock } = recordingProvider([blankCutTurn(), blankCutTurn()]);

    const result = await (await createInstantReplayAuditHarness()).runStep(fixture.provisional);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.verificationResult?.review).toEqual({ verdict: "human-review", issues: [] });
    expect(Object.values(dimensions(result))).toEqual(Array(6).fill("unverified:0"));
    expect(result.verificationResult?.coverage).toEqual([
      { path: TARGETS[0], status: "unverified", evidence: [], reason: HOST_FILLED_COVERAGE_REASON },
    ]);
    expect(limitationsStartingWith(result, "Host judgment completion:")).toEqual([
      completionNote({
        stepId: "provisional-technical-verification",
        shape: "output-truncated",
        continuations: "0 continuation turns",
        billed: (2 * OUTPUT_LIMIT).toLocaleString("en-US"),
        retained: 0,
        kept: "0 complete obligation judgments",
        filled: 18,
        coverage: "kept 0 coverage entries and host-filled 1",
        issues: "kept 0 issue judgments and dropped 0",
      }),
    ]);
    expect(result.executionLease).toMatchObject({ providerTurns: 1, terminalReason: "completed" });
    expectDecodedAttemptEvidence(result, "succeeded", false);
  });

  it("T4: completes a cut step-5 answer as V3 correction evidence that re-validates without the policy", async () => {
    // The runner, the run records and delivery re-validate the recorded V3
    // evidence with no coverage policy in hand, so the host rows and host-cut
    // demotions must stand on the recorded proposal alone.
    const repositoryPath = await createRepository();
    const fixture = recordedFixture(repositoryPath);
    const cutAt = insideRow(fixture.answer, "OBL-DESTINATION-AND-TRUST-1");
    recordingProvider([
      cutTurn(fixture.answer.slice(0, Math.floor(cutAt / 2))),
      cutTurn(fixture.answer.slice(Math.floor(cutAt / 2), cutAt)),
    ]);

    const result = await (await createAuditHarness()).runStep(fixture.correction);

    const evidence = result.technicalCorrectionEvidence;
    expect(evidence?.schemaVersion).toBe(3);
    expect(result.verificationResult?.review.verdict).toBe("human-review");
    const accounting =
      evidence?.schemaVersion === 3 ? evidence.proposal.obligationAccounting : undefined;
    expect(accounting?.filter(({ disposition }) => disposition === "retained")).toHaveLength(7);
    expect(
      accounting
        ?.filter(({ disposition }) => disposition === "rejected")
        .map((row) => (row.disposition === "retained" ? undefined : row.reason)),
    ).toEqual(Array(11).fill(HOST_UNJUDGED_OBLIGATION_REASON));
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

  it("T5: still continues a cut with budget left, and completes it uncut", async () => {
    // Budget left means continue first.
    const repositoryPath = await createRepository();
    const fixture = recordedFixture(repositoryPath);
    const half = Math.floor(fixture.answer.length / 2);
    const { fetchMock } = recordingProvider([
      cutTurn(fixture.answer.slice(0, half)),
      textTurn(fixture.answer.slice(half)),
    ]);

    const result = await (await createAuditHarness()).runStep(fixture.provisional);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.verificationResult?.review.verdict).toBe("needs-revision");
    expect(limitationsStartingWith(result, "Host judgment completion:")).toEqual([]);
    expect(result.turns?.map((turn) => turn.rawStopReason)).toEqual(["length", "stop"]);
  });

  it.each([
    ["create-documentation's judgment step (#1293)", "create-documentation", "v2"],
    ["a judgment step over a V1 ledger", "review-documentation", "v1"],
  ] as const)(
    "T5: still refuses the same double cut on %s as the cut-answer condition, with the unchanged message",
    async (_label, workflowName, ledgerVersion) => {
      const repositoryPath = await createRepository();
      const fixture = recordedFixture(repositoryPath, workflowName);
      const input: HarnessStepInput =
        ledgerVersion === "v2"
          ? fixture.provisional
          : {
              ...fixture.provisional,
              sourceObligationLedger: bindSourceObligationLedger(
                sourceObligationProposalFixture(),
                fixture.provisional,
                [{ path: "src/api.ts", sha256: "f".repeat(64) }],
              ),
            };
      const cutAt = insideRow(fixture.answer, "OBL-DESTINATION-AND-TRUST-1");
      const firstCut = Math.floor(cutAt / 3);
      const second = fixture.answer.slice(firstCut, cutAt);
      const { fetchMock } = recordingProvider([
        cutTurn(fixture.answer.slice(0, firstCut)),
        cutTurn(second),
      ]);

      const error = await captureInferenceFailure(await createAuditHarness(), input);

      expect(error.message).toContain(
        `text-truncated: step provisional-technical-verification answer cut at the ${LIMIT_LABEL}-token output limit (finish_reason=length) after ${second.length.toLocaleString("en-US")} characters`,
      );
      // The cut is the `cut-answer` condition; the retry rule decides, not the harness.
      expect(error.retryable).toBe(true);
      expect(error.condition).toBe("cut-answer");
      expect(error.rejection).toEqual({ code: "text-truncated", location: "$response" });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );

  it("T5: still refuses a double cut on the ledger derivation step, which is not a judgment, as the cut-answer condition", async () => {
    const repositoryPath = await createRepository();
    const partial = '{"completeness":"bounded-not-proven","dimensions":[{"dimension":"input';
    const { fetchMock } = recordingProvider([cutTurn(partial), cutTurn(",representations")]);

    const error = await captureInferenceFailure(
      await createAuditHarness(),
      reviewSourcePhaseInput(repositoryPath, "derive-source-obligations"),
    );

    expect(error.message).toContain(
      `text-truncated: step derive-source-obligations answer cut at the ${LIMIT_LABEL}-token output limit (finish_reason=length) after 16 characters`,
    );
    // The cut is the `cut-answer` condition; the retry rule decides, not the harness.
    expect(error.retryable).toBe(true);
    expect(error.condition).toBe("cut-answer");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("T5: leaves a cut tool call on a judgment step to the tool-batch refusal, unchanged", async () => {
    // A length stop with a tool call is `tool-arguments-truncated`, settled by
    // the tool-batch branch, not by this completion.
    vi.stubEnv("DOCSFAB_GOVERNANCE_MAX_LENGTH_STOPPED_TOOL_TURNS", "2");
    const repositoryPath = await createRepository();
    const fixture = recordedFixture(repositoryPath);
    const cut = (created: number) =>
      toolTurn(
        [{ id: `call-${created}`, name: "read", arguments: { path: "README.md" } }],
        created,
        "length",
        CUT_USAGE,
      );
    const { fetchMock } = recordingProvider([cut(1), cut(2)]);

    const error = await captureInferenceFailure(
      await createInstantReplayAuditHarness(),
      fixture.provisional,
    );

    expect(error.message).toContain(
      `tool-arguments-truncated: 2 consecutive provider turns of step provisional-technical-verification hit the ${LIMIT_LABEL}-token output limit (finish_reason=length) with truncated tool arguments`,
    );
    expect(error.rejection).toEqual({ code: "tool-arguments-truncated", location: "$response" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("releases complete rows whose issue judgment the cut removed (rows written before issues)", async () => {
    // Element order is not guaranteed. With `obligationJudgments` written
    // before `issueJudgments`, a cut after the first issue judgment leaves all
    // 18 rows complete, but a fact that needs an issue has one only if
    // TECH-001 links it. The others are released to the host rather than
    // refused as unlinked, since the cut may have removed their issue.
    const repositoryPath = await createRepository();
    const fixture = recordedFixture(repositoryPath);
    const { verdict, coverage, obligationJudgments, issueJudgments } = fixture.judgment;
    const reordered = JSON.stringify({ verdict, coverage, obligationJudgments, issueJudgments });
    const cutAt = reordered.indexOf('{"id":"TECH-002"') + 12;
    const firstCut = Math.floor(cutAt / 2);
    recordingProvider([
      cutTurn(reordered.slice(0, firstCut)),
      cutTurn(reordered.slice(firstCut, cutAt)),
    ]);

    const result = await (await createAuditHarness()).runStep(fixture.provisional);

    expect(result.verificationResult?.review.issues.map(({ id }) => id)).toEqual(["TECH-001"]);
    // Kept: the two documented rows and the one TECH-001 links.
    expect(dimensions(result)).toEqual({
      "input-representations": "applicable:1",
      "defaults-and-overrides": "applicable:1",
      "mutable-state": "unverified:0",
      "destination-and-trust": "unverified:0",
      "error-status-retry": "unverified:0",
      "environment-prerequisite": "applicable:1",
    });
    expect(limitationsStartingWith(result, "Host judgment completion:")[0]).toContain(
      "The host kept 3 complete obligation judgments and recorded 15 unverified,",
    );
  });

  it("T6: admits the recorded real judgment unchanged when it arrives uncut", async () => {
    // Positive control: an uncut answer does not take the completion path and
    // decodes exactly as the decoder alone decodes it.
    const repositoryPath = await createRepository();
    const fixture = recordedFixture(repositoryPath);
    const { fetchMock } = recordingProvider([textTurn(fixture.answer)]);

    const result = await (await createReviewHarness(true)).runStep(fixture.provisional);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.verificationResult).toEqual(
      decodeProvisionalVerificationJudgment(
        fixture.answer,
        fixture.ledger,
        TARGETS,
        undefined,
        judgmentCoveragePolicy(fixture.provisional),
      ),
    );
    expect(limitationsStartingWith(result, "Host judgment completion:")).toEqual([]);
    expect(result.verificationResult?.review.verdict).toBe("needs-revision");
    expect(result.turns?.map((turn) => turn.rawStopReason)).toEqual(["stop"]);
  });

  function withRows(judgment: Record<string, unknown>, patch: Record<string, unknown>): string {
    const rows = (judgment.obligationJudgments as Array<Record<string, unknown>>).map((row) =>
      Object.hasOwn(patch, row.obligationId as string) ? patch[row.obligationId as string] : row,
    );
    return JSON.stringify({ ...judgment, obligationJudgments: rows });
  }

  function withIssue(
    judgment: Record<string, unknown>,
    id: string,
    patch: Record<string, unknown>,
  ): string {
    const issues = (judgment.issueJudgments as Array<Record<string, unknown>>).map((issue) =>
      issue.id === id ? { ...issue, ...patch } : issue,
    );
    return JSON.stringify({ ...judgment, issueJudgments: issues });
  }

  /** `answer` cut at `cutAt`, as two cut turns that spend the continuation bound. */
  function cutTwice(answer: string, cutAt: number): Response[] {
    const firstCut = Math.floor(cutAt / 2);
    return [cutTurn(answer.slice(0, firstCut)), cutTurn(answer.slice(firstCut, cutAt))];
  }

  /** The cut the turn_end handler would keep for `answer` cut twice at `cutAt`. */
  function cutOf(answer: string, cutAt: number): CutJudgmentAnswer {
    return {
      shape: "text-truncated",
      stitched: answer.slice(0, cutAt),
      finalCut: answer.slice(Math.floor(cutAt / 2), cutAt),
      continuationTurns: 1,
      outputTokenLimit: OUTPUT_LIMIT,
      answerOutputTokens: 2 * OUTPUT_LIMIT,
    };
  }

  /** The sentence a floor completion appends, written out as the oracle. */
  function floorSentence(kept: string, code: string): string {
    return ` The step's own checks refused the host's first completion, which kept ${kept} (${code}), so the host kept none of them and filled every obligation.`;
  }

  /** The note of a floor completion over the recorded ledger, cut twice at `cutAt`. */
  function floorNote(stepId: string, cutAt: number, kept: string, code: string): string {
    return (
      completionNote({
        stepId,
        shape: "text-truncated",
        continuations: "1 continuation turn",
        billed: (2 * OUTPUT_LIMIT).toLocaleString("en-US"),
        retained: cutAt,
        kept: "0 complete obligation judgments",
        filled: 18,
        coverage: "kept 0 coverage entries and host-filled 1",
        issues: "kept 0 issue judgments and dropped 0",
      }) + floorSentence(kept, code)
    );
  }

  describe("B1 (r1): the host-cut demotion branch, in both directions", () => {
    it("host-cut demotes a dimension whose complete model rejection sits beside host-filled rows (step 4)", async () => {
      // The branch's exact condition: an emptied applicable dimension that owns
      // at least one host-filled obligation. The model's complete row rejects
      // OBL-ERROR-STATUS-RETRY-1 and the cut falls inside
      // OBL-ERROR-STATUS-RETRY-2, so the dimension holds one model rejection and
      // four host rows, not only host-filled rows.
      const repositoryPath = await createRepository();
      const fixture = recordedFixture(repositoryPath);
      const answer = withRows(fixture.judgment, {
        "OBL-ERROR-STATUS-RETRY-1": {
          obligationId: "OBL-ERROR-STATUS-RETRY-1",
          disposition: "rejected",
          reason: "The admitted source does not establish this retry rule at all.",
        },
      });
      recordingProvider(cutTwice(answer, insideRow(answer, "OBL-ERROR-STATUS-RETRY-2")));

      const result = await (await createAuditHarness()).runStep(fixture.provisional);

      expect(result.verificationResult?.review.verdict).toBe("human-review");
      expect(dimensions(result)).toEqual({
        "input-representations": "applicable:3",
        "defaults-and-overrides": "applicable:3",
        "mutable-state": "applicable:1",
        "destination-and-trust": "applicable:4",
        "error-status-retry": "unverified:0",
        "environment-prerequisite": "unverified:0",
      });
      expect(
        limitationsStartingWith(
          result,
          "Host demotion answer-cut-at-output-limit: the judgment answer was cut at the output limit before a complete judgment of 4 of the 5 obligations of the applicable ledger dimension error-status-retry",
        ),
      ).toHaveLength(1);
      expect(
        limitationsStartingWith(
          result,
          "Host demotion evidence for rejected source obligation OBL-ERROR-STATUS-RETRY-",
        ),
      ).toEqual([
        "Host demotion evidence for rejected source obligation OBL-ERROR-STATUS-RETRY-1 (error-status-retry): answer-cut-at-output-limit, its complete judgment row rejected it before the cut.",
        ...["2", "3", "4", "5"].map(
          (ordinal) =>
            `Host demotion evidence for rejected source obligation OBL-ERROR-STATUS-RETRY-${ordinal} (error-status-retry): answer-cut-at-output-limit, no complete judgment of it arrived before the cut, so the host filled it.`,
        ),
      ]);
    });

    it("re-validates the same mixed dimension as step-5 evidence without the policy", async () => {
      // The runner, the run records and delivery re-validate the recorded V3
      // evidence with no coverage policy in hand, so the model's own rejection
      // row must stand beside the host rows on the recorded proposal alone.
      const repositoryPath = await createRepository();
      const fixture = recordedFixture(repositoryPath);
      const reason = "The admitted source does not establish this retry rule at all.";
      const answer = withRows(fixture.judgment, {
        "OBL-ERROR-STATUS-RETRY-1": {
          obligationId: "OBL-ERROR-STATUS-RETRY-1",
          disposition: "rejected",
          reason,
        },
      });
      recordingProvider(cutTwice(answer, insideRow(answer, "OBL-ERROR-STATUS-RETRY-2")));

      const result = await (await createAuditHarness()).runStep(fixture.correction);

      const evidence = result.technicalCorrectionEvidence;
      const accounting =
        evidence?.schemaVersion === 3 ? evidence.proposal.obligationAccounting : undefined;
      expect(accounting?.filter(({ disposition }) => disposition !== "rejected")).toHaveLength(10);
      expect(
        accounting
          ?.filter(({ disposition }) => disposition === "rejected")
          .map((row) => (row.disposition === "rejected" ? [row.obligationId, row.reason] : [])),
      ).toEqual([
        ["OBL-ERROR-STATUS-RETRY-1", reason],
        ...[
          "OBL-ERROR-STATUS-RETRY-2",
          "OBL-ERROR-STATUS-RETRY-3",
          "OBL-ERROR-STATUS-RETRY-4",
          "OBL-ERROR-STATUS-RETRY-5",
          "OBL-ENVIRONMENT-PREREQUISITE-1",
          "OBL-ENVIRONMENT-PREREQUISITE-2",
          "OBL-ENVIRONMENT-PREREQUISITE-3",
        ].map((id) => [id, HOST_UNJUDGED_OBLIGATION_REASON]),
      ]);
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

    it("keeps the emptied-dimension refusal for a complete dimension of a cut answer (decoder)", async () => {
      // OBL-MUTABLE-STATE-1 is the only obligation of its dimension, its
      // complete row arrived before the cut and rejected it, and the host filled
      // none of that dimension, so the emptied-dimension refusal still decides
      // it rather than host-cut demotion.
      const repositoryPath = await createRepository();
      const fixture = recordedFixture(repositoryPath);
      const answer = withRows(fixture.judgment, {
        "OBL-MUTABLE-STATE-1": {
          obligationId: "OBL-MUTABLE-STATE-1",
          disposition: "rejected",
          reason: "Not established by the admitted source in this run.",
        },
      });
      const completed = hostCompleteCutJudgment(
        fixture.provisional,
        cutOf(answer, insideRow(answer, "OBL-DESTINATION-AND-TRUST-1")),
        undefined,
      );
      expect([...completed.coveragePolicy.hostFilledObligationIds!]).not.toContain(
        "OBL-MUTABLE-STATE-1",
      );

      expect(() =>
        decodeProvisionalVerificationJudgment(
          completed.reply,
          fixture.ledger,
          TARGETS,
          undefined,
          completed.coveragePolicy,
        ),
      ).toThrow("Technical correction response rejected: invalid-fact-inventory.");
    });

    it("falls back to the floor when that refusal reaches the harness (step 4)", async () => {
      // The same answer through `PiHarness.runStep`: the refusal above is
      // model content, so the host keeps none of the cut answer.
      const repositoryPath = await createRepository();
      const fixture = recordedFixture(repositoryPath);
      const answer = withRows(fixture.judgment, {
        "OBL-MUTABLE-STATE-1": {
          obligationId: "OBL-MUTABLE-STATE-1",
          disposition: "rejected",
          reason: "Not established by the admitted source in this run.",
        },
      });
      const cutAt = insideRow(answer, "OBL-DESTINATION-AND-TRUST-1");
      recordingProvider(cutTwice(answer, cutAt));

      const result = await (await createAuditHarness()).runStep(fixture.provisional);

      expect(Object.values(dimensions(result))).toEqual(Array(6).fill("unverified:0"));
      expect(limitationsStartingWith(result, "Host judgment completion:")).toEqual([
        floorNote(
          "provisional-technical-verification",
          cutAt,
          "7 complete obligation judgments, 1 coverage entry, and 2 issue judgments",
          "inventory-dimension-facts",
        ),
      ]);
    });
  });

  it("B2 (r1): bounds the scanner to the step's response ceiling at the shipped call site", async () => {
    // `PiHarness.runStep` hands `compositionPolicy.maxResponseBytes` to
    // `hostCompleteCutJudgment`. Each message and the retained prefix fit that
    // ceiling, but the stitched text the scanner reads is the prefix plus the
    // final cut. The ceiling ends inside OBL-DEFAULTS-AND-OVERRIDES-2 while the
    // stitched text runs into OBL-DESTINATION-AND-TRUST-1, so only the four rows
    // inside the ceiling may be kept.
    const repositoryPath = await createRepository();
    const fixture = recordedFixture(repositoryPath);
    // The recorded answer is ASCII, so a character offset is a byte count.
    const maxResponseBytes = insideRow(fixture.answer, "OBL-DEFAULTS-AND-OVERRIDES-2");
    const cutAt = insideRow(fixture.answer, "OBL-DESTINATION-AND-TRUST-1");
    expect(Buffer.byteLength(fixture.answer, "utf8")).toBe(fixture.answer.length);
    expect(cutAt - Math.floor(cutAt / 2)).toBeLessThan(maxResponseBytes);
    expect(cutAt).toBeGreaterThan(maxResponseBytes);
    const { fetchMock } = recordingProvider(cutTwice(fixture.answer, cutAt));
    const executionProfile = fixtureCompositionExecutionProfile({
      // `createReviewHarness(true)`'s turn and time bounds; only the response
      // ceiling differs.
      maxProviderTurns: 4,
      timeoutMs: 30_000,
      maxResponseBytes,
    });
    const harness = new PiHarness({
      skillCrateDirectory,
      executionProfile,
      credential: { family: "nvidia-inference-api", apiKey: validModelConfig.apiKey },
      providerConnectionFactory: createProviderConnectionFactory({
        routeId: executionProfile.routeId,
        transport: executionProfile.transport,
      }),
    });

    const result = await harness.runStep(fixture.provisional);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(dimensions(result)).toEqual({
      "input-representations": "applicable:3",
      "defaults-and-overrides": "applicable:1",
      "mutable-state": "unverified:0",
      "destination-and-trust": "unverified:0",
      "error-status-retry": "unverified:0",
      "environment-prerequisite": "unverified:0",
    });
    expect(limitationsStartingWith(result, "Host judgment completion:")[0]).toContain(
      "The host kept 4 complete obligation judgments and recorded 14 unverified,",
    );
  });

  describe("N1 (r1): a kept element the step's own checks refuse as model content", () => {
    it("fills every obligation when a kept issue judgment has an off-vocabulary severity (step 4)", async () => {
      // The recorded reply with one complete, kept issue judgment whose
      // severity is outside the stated vocabulary. That is model content, so
      // the host keeps none of the cut answer and completes it to the floor, as
      // it does a blank cut.
      const repositoryPath = await createRepository();
      const fixture = recordedFixture(repositoryPath);
      const answer = withIssue(fixture.judgment, "TECH-001", { severity: "blocker" });
      const cutAt = insideRow(answer, "OBL-DESTINATION-AND-TRUST-1");
      const { fetchMock } = recordingProvider(cutTwice(answer, cutAt));

      const result = await (await createReviewHarness(true)).runStep(fixture.provisional);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result.verificationResult?.review).toEqual({ verdict: "human-review", issues: [] });
      expect(Object.values(dimensions(result))).toEqual(Array(6).fill("unverified:0"));
      expect(limitationsStartingWith(result, "Host judgment completion:")).toEqual([
        floorNote(
          "provisional-technical-verification",
          cutAt,
          "7 complete obligation judgments, 1 coverage entry, and 2 issue judgments",
          "judgment-severity-invalid",
        ),
      ]);
      expect(result.executionLease).toMatchObject({
        providerTurns: 2,
        terminalReason: "completed",
      });
      // The row-key audit measures the reply the step admitted, the floor, not
      // the refused completion with its two kept issue judgments.
      expect(result.judgmentRowKeyAudit).toMatchObject({
        issueJudgments: { rows: 0 },
        obligationJudgments: { rows: 18, undeclaredKeys: 0 },
      });
      expectDecodedAttemptEvidence(result, "succeeded", false);
    });

    it("fills every obligation when a kept row's reason is over the prose ceiling (step 5)", async () => {
      // A complete, kept refined row whose reason is one character over
      // `technicalCorrection.proseMaxChars`. The floor's V3 evidence
      // re-validates with no policy in hand, as T4's does.
      const repositoryPath = await createRepository();
      const fixture = recordedFixture(repositoryPath);
      const rows = fixture.judgment.obligationJudgments as Array<Record<string, unknown>>;
      const refined = rows.find((row) => row.obligationId === "OBL-DESTINATION-AND-TRUST-1")!;
      const answer = withRows(fixture.judgment, {
        "OBL-DESTINATION-AND-TRUST-1": {
          ...refined,
          reason: "x".repeat(limitDefinition("technicalCorrection.proseMaxChars").value + 1),
        },
      });
      const cutAt = insideRow(answer, "OBL-DESTINATION-AND-TRUST-3");
      recordingProvider(cutTwice(answer, cutAt));

      const result = await (await createAuditHarness()).runStep(fixture.correction);

      const evidence = result.technicalCorrectionEvidence;
      const accounting =
        evidence?.schemaVersion === 3 ? evidence.proposal.obligationAccounting : undefined;
      expect(
        accounting?.map((row) => (row.disposition === "rejected" ? row.reason : row.disposition)),
      ).toEqual(Array(18).fill(HOST_UNJUDGED_OBLIGATION_REASON));
      expect(limitationsStartingWith(result, "Host judgment completion:")).toEqual([
        floorNote(
          "verify-technical-accuracy",
          cutAt,
          "9 complete obligation judgments, 1 coverage entry, and 4 issue judgments",
          "bounds-exceeded",
        ),
      ]);
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
      [
        "a kept issue judgment located outside the approved targets",
        "target-authority",
        (judgment: Record<string, unknown>) =>
          withIssue(judgment, "TECH-001", { location: "docs/elsewhere.md:11" }),
      ],
    ] as const)("still fails closed on %s, an authority refusal", async (_label, code, mutate) => {
      // The rejection-retryability table marks authority refusals terminal, so
      // they stay fail-closed instead of taking the floor.
      const repositoryPath = await createRepository();
      const fixture = recordedFixture(repositoryPath);
      const answer = mutate(fixture.judgment);
      recordingProvider(cutTwice(answer, insideRow(answer, "OBL-DESTINATION-AND-TRUST-1")));

      const error = await captureInferenceFailure(await createAuditHarness(), fixture.provisional);

      expect(error.message).toContain(`Technical correction response rejected: ${code}.`);
      expect(error.retryable).toBe(false);
    });
  });

  describe("candidate and row choice (r1 N4)", () => {
    it("keeps the first complete row naming an obligation and counts the repeat as discarded", async () => {
      const repositoryPath = await createRepository();
      const fixture = recordedFixture(repositoryPath);
      const rows = fixture.judgment.obligationJudgments as Array<Record<string, unknown>>;
      const repeat = { ...rows[0]!, documentationDisposition: "omitted" };
      const answer = JSON.stringify({
        ...fixture.judgment,
        obligationJudgments: [rows[0], repeat, ...rows.slice(1)],
      });

      const completed = hostCompleteCutJudgment(
        fixture.provisional,
        cutOf(answer, insideRow(answer, "OBL-DESTINATION-AND-TRUST-1")),
        undefined,
      );

      const reply = JSON.parse(completed.reply) as { obligationJudgments: unknown[] };
      expect(reply.obligationJudgments[0]).toEqual(rows[0]);
      expect(completed.counts.rowsDiscarded).toBe(1);
      expect(completed.coveragePolicy.hostLimitations?.[0]).toMatch(
        / 1 complete row that named no sealed obligation or repeated one was discarded\.$/u,
      );
    });

    it("prefers the stitched text when the final cut alone keeps as many rows", async () => {
      // Both candidates are cut before `obligationJudgments` begins, so each
      // keeps no row: a tie. The stitched text is the continuation the host
      // asked for and wins; the final cut here restarts the answer with a
      // different coverage reason.
      const repositoryPath = await createRepository();
      const fixture = recordedFixture(repositoryPath);
      const coverage = fixture.judgment.coverage as Array<Record<string, unknown>>;
      const restart = JSON.stringify({
        ...fixture.judgment,
        coverage: [{ ...coverage[0], reason: "A restarted answer's coverage reason." }],
      });
      const retained = fixture.answer.slice(0, fixture.answer.indexOf('"issueJudgments"'));
      const finalCut = restart.slice(0, restart.indexOf('"issueJudgments"'));

      const completed = hostCompleteCutJudgment(
        fixture.provisional,
        { ...cutOf(fixture.answer, 0), stitched: retained + finalCut, finalCut },
        undefined,
      );

      expect(completed.counts.rowsKept).toBe(0);
      expect((JSON.parse(completed.reply) as { coverage: unknown }).coverage).toEqual(coverage);
    });
  });
});
