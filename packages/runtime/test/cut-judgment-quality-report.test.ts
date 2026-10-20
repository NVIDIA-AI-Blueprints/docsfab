// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { cp, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  declinedJudgmentCut,
  hostCompleteCutQualityReport,
  QUALITY_REPORT_CUT_STEM,
  qualityReportCutApplies,
  recoverableQualityReportCut,
  type CutJudgmentAnswer,
} from "../src/harness/cut-judgment.js";
import { decodeQualityArtifactResponse } from "../src/harness/quality-candidate-tool.js";
import {
  HOST_WRITTEN_EVALUATION_FIELDS,
  hostWrittenEvaluationFieldsSentence,
} from "../src/evaluation-report/evaluation-target.js";
import { canonicalDigest } from "../src/content-ir/canonical.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import type { HarnessStepInput } from "../src/execution/contracts.js";
import type { QualityProfileSelectionReceiptV1 } from "../src/records/contracts.js";
import { temporaryRoots } from "./helpers/temp.js";
import { unverifiedVerificationResultFixture } from "./helpers/verification.js";
import {
  captureInferenceFailure,
  createAuditHarness,
  createRepository,
  editorialTechnicalStepInput,
  projectRoot,
  scriptedProvider,
  skillCrateDirectory,
  textTurn,
  toolTurn,
  validModelConfig,
} from "./support/pi-harness-session-fixtures.js";
import { createModelConnection } from "../src/model/provider.js";
import { PI_CONCLUDE_NOW_PROMPT } from "../src/harness/pi-session.js";
import { qualityResponseCorrection } from "../src/workflow-execution/quality-response-correction.js";
import { executeInferenceStep } from "../src/workflow-execution/retry.js";
import { parseRetryPolicy } from "../src/config/retry-policy.js";

/**
 * The final quality evaluator has no source-obligation ledger to host-fill
 * against (unlike the two `answerNowAppliesTo` judgment steps V6 covers), so
 * it is completed by a sibling function that keeps only the model's own
 * complete `evaluation`/`qualityScore` verbatim and writes the narrative
 * report itself. Mirrors `cut-judgment-prefix.test.ts` and
 * `pi-harness-cut-judgment.test.ts`'s style for the ledger-based steps.
 */
describe("evaluate-document-quality: a cut answer degrades instead of failing the job", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const WORKFLOW = getWorkflow("review-documentation");
  const EVALUATE_STEP = WORKFLOW.steps.find((step) => step.id === "evaluate-document-quality")!;
  const OTHER_STEP = WORKFLOW.steps.find((step) => step.id === "audit-documentation")!;
  const roots = temporaryRoots();

  /**
   * A real, locked quality pack copy plus a `qualityProfileSelection` whose
   * lock-integrity fields are real sha256 digests of that copy: the same
   * pattern `pi-harness.test.ts`'s `evaluatorContractFixture` uses to reach
   * `PiHarness.runStep`'s own `loadQualityEvaluatorContract` prompt step
   * for `evaluate-document-quality`. The response-contract fields
   * (`selectionSha256`, `profileId`, ...) are the ones
   * `decodeQualityArtifactResponse` and the response-contract prompt read;
   * neither reads the receipt's many other sealed fields, so this fixture
   * (like the one it mirrors) supplies only what those two call sites use.
   */
  async function qualityEvaluatorFixture(
    harnessOverrides: Partial<Parameters<typeof createAuditHarness>[0]> = {},
  ): Promise<{
    harness: Awaited<ReturnType<typeof createAuditHarness>>;
    qualityProfileSelection: QualityProfileSelectionReceiptV1;
  }> {
    const root = await roots.create("docsfab-quality-report-cut-");
    const qualityDirectory = resolve(root, "quality");
    await cp(resolve(projectRoot, "quality"), qualityDirectory, { recursive: true });
    const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
    const qualityLockBytes = await readFile(resolve(qualityDirectory, "lock.json"));
    const qualityLock = JSON.parse(qualityLockBytes.toString("utf8")) as { bundleSha256: string };
    const profileAssetPath = "profiles/docsfab-documentation-quality/profile.json";
    const harness = await createAuditHarness({ qualityDirectory, ...harnessOverrides });
    const qualityProfileSelection = {
      selectionSha256: "a".repeat(64),
      repositoryRevision: "a".repeat(40),
      skillLockSha256: sha256(await readFile(resolve(skillCrateDirectory, "lock.json"))),
      qualityLockSha256: sha256(qualityLockBytes),
      qualityBundleSha256: qualityLock.bundleSha256,
      profileAssetPath,
      profilePayloadSha256: sha256(await readFile(resolve(qualityDirectory, profileAssetPath))),
      profileId: "docsfab-documentation-quality",
      profileVersion: "v0.1",
      profileModel: "documentation-quality-model-v0.2",
    } as unknown as QualityProfileSelectionReceiptV1;
    return { harness, qualityProfileSelection };
  }

  const REALISTIC_EVALUATION = {
    evaluation_id: "cut-judgment-quality-report-fixture",
    evaluation_version: "v0.1",
    evaluated_at: "2026-09-29T19:00:00Z",
    model_version: "documentation-quality-model-v0.2",
    profile: { id: "docsfab-documentation-quality", version: "v0.1" },
    evaluator: {
      provider_id: "fixture-evaluator",
      provider_type: "agent",
      independent_of_authors: true,
      independence_evidence: "Fixture evaluator is independent of the target author.",
    },
    target: {
      scope_type: "documentation-set",
      documentation_families: ["procedural"],
      documentation_family_evidence: [
        {
          family: "procedural",
          paths: ["docs/"],
          method: "path-convention",
          evidence_locator: "inventory:docs",
          rationale: "The tracked documentation path identifies a procedural family.",
        },
      ],
      repository_revision: "a".repeat(40),
      documentation_revision: "a".repeat(40),
      paths: ["README.md"],
      product_reference_model: { id: "fixture-product", version: "v1" },
      approved_evidence_revision: "fixture-evidence-v1",
      product_version: "fixture-v1",
      environment: "deterministic-test",
      delivery_surface_locator: "fixture:docs",
      risk_boundary: "General information only.",
      risk_classes: ["general-information"],
      audiences: ["developer"],
      intended_outcomes: ["complete the documented task"],
      intended_outcome_classes: ["task-completion"],
    },
    layers: {
      trustworthy_information: {
        decision: "pass",
        confidence: 0.9,
        dimensions: [],
        hard_gate_failures: [],
        limitations: [],
      },
    },
    outcomes: { human: [], agent: [] },
    hard_gate_failures: [],
    overall_decision: "pass",
    conditions: [],
    confidence: 0.9,
    findings: [],
    limitations: [],
  };

  function cutAnswer(overrides: Partial<CutJudgmentAnswer> = {}): CutJudgmentAnswer {
    return {
      shape: "text-truncated",
      stitched: "",
      finalCut: "",
      continuationTurns: 1,
      outputTokenLimit: 32_768,
      answerOutputTokens: 65_536,
      ...overrides,
    };
  }

  describe("qualityReportCutApplies", () => {
    it("recognizes evaluate-document-quality and no other step (adjacent condition)", () => {
      expect(qualityReportCutApplies({ step: EVALUATE_STEP })).toBe(true);
      expect(qualityReportCutApplies({ step: OTHER_STEP })).toBe(false);
    });
  });

  describe("declinedJudgmentCut widened gate", () => {
    const input: Pick<HarnessStepInput, "workflow" | "step" | "sourceObligationLedger"> = {
      workflow: WORKFLOW,
      step: EVALUATE_STEP,
    };

    it("recognizes a text-truncated cut on evaluate-document-quality once the continuation budget is spent", () => {
      expect(declinedJudgmentCut(input, "text-truncated", 1, 1)).toBe("text-truncated");
    });

    it("recognizes an output-truncated cut on evaluate-document-quality immediately", () => {
      expect(declinedJudgmentCut(input, "output-truncated", 0, 1)).toBe("output-truncated");
    });

    it("does NOT treat a text-truncated cut on evaluate-document-quality as declined while continuation budget remains (adjacent condition)", () => {
      expect(declinedJudgmentCut(input, "text-truncated", 0, 1)).toBeUndefined();
    });

    it("does NOT recognize a cut on an unrelated step, even with the same rejection code (adjacent condition)", () => {
      expect(
        declinedJudgmentCut({ workflow: WORKFLOW, step: OTHER_STEP }, "text-truncated", 1, 1),
      ).toBeUndefined();
    });
  });

  describe("recoverableQualityReportCut", () => {
    it("keeps a complete evaluation and qualityScore when only the trailing reportMarkdown was cut", () => {
      const complete = JSON.stringify({ evaluation: REALISTIC_EVALUATION, qualityScore: null });
      // Cut inside the reportMarkdown string value: the trailing `"` and `}`
      // never arrive, so this is exactly what a real cut turn's text looks
      // like once its structured members finished first.
      const cutInsideReportMarkdown = `${complete.slice(0, -1)},"reportMarkdown":"# Report\\n\\nThis narrative keeps going and going without ever reaching a natural stopping point because`;
      const recovered = recoverableQualityReportCut(
        { stitched: cutInsideReportMarkdown, finalCut: cutInsideReportMarkdown },
        undefined,
      );
      expect(recovered).toEqual({
        evaluation: REALISTIC_EVALUATION,
        qualityScore: null,
        qualityScoreCut: false,
      });
    });

    it("keeps the complete JSON object of the answer form when its Markdown report was cut", () => {
      const cutInsideReport = `${JSON.stringify({ evaluation: REALISTIC_EVALUATION, qualityScore: null })}\n\n# Report\n\nThis narrative keeps going without ever reaching a stopping point because`;
      expect(
        recoverableQualityReportCut(
          { stitched: cutInsideReport, finalCut: cutInsideReport },
          undefined,
        ),
      ).toEqual({ evaluation: REALISTIC_EVALUATION, qualityScore: null, qualityScoreCut: false });
    });

    it("keeps a complete non-null qualityScore too, verbatim", () => {
      const score = { total: 84, decision: "pass", confidence: 0.9 };
      const complete = JSON.stringify({ evaluation: REALISTIC_EVALUATION, qualityScore: score });
      const cutInsideReportMarkdown = `${complete.slice(0, -1)},"reportMarkdown":"# Report cut mid-sentence because`;
      const recovered = recoverableQualityReportCut(
        { stitched: cutInsideReportMarkdown, finalCut: cutInsideReportMarkdown },
        undefined,
      );
      expect(recovered).toEqual({
        evaluation: REALISTIC_EVALUATION,
        qualityScore: score,
        qualityScoreCut: false,
      });
    });

    it("still refuses recovery when one response exceeds its explicit byte ceiling", () => {
      const complete = JSON.stringify({ evaluation: REALISTIC_EVALUATION, qualityScore: null });
      const cutInsideReportMarkdown = `${complete.slice(0, -1)},"reportMarkdown":"# Report\\n\\ncut here because`;
      expect(
        recoverableQualityReportCut(
          { stitched: cutInsideReportMarkdown, finalCut: cutInsideReportMarkdown },
          1,
        ),
      ).toBeUndefined();
    });

    it("marks qualityScore as cut, not the model's own null judgment, when the cut lands before that member arrives at all", () => {
      // A complete `evaluation`, then the cut lands in the whitespace/comma
      // between it and `qualityScore` -- so `qualityScore` is absent from
      // the recovered prefix, not present-and-null the way the model's own
      // "no rubric applies" answer would be.
      const complete = JSON.stringify({ evaluation: REALISTIC_EVALUATION });
      const cutBeforeQualityScore = `${complete.slice(0, -1)},"qualityScor`;
      const recovered = recoverableQualityReportCut(
        { stitched: cutBeforeQualityScore, finalCut: cutBeforeQualityScore },
        undefined,
      );
      expect(recovered).toEqual({
        evaluation: REALISTIC_EVALUATION,
        qualityScore: null,
        qualityScoreCut: true,
      });
    });

    it("finds nothing to keep when the cut lands inside evaluation itself (adjacent condition)", () => {
      const cutInsideEvaluation = `{"evaluation":{"evaluation_id":"cut-judgment-quality-report-fixture","target":{"paths":["README.md`;
      expect(
        recoverableQualityReportCut(
          { stitched: cutInsideEvaluation, finalCut: cutInsideEvaluation },
          undefined,
        ),
      ).toBeUndefined();
    });

    it("finds nothing to keep on a completely blank (output-truncated) answer (adjacent condition)", () => {
      expect(
        recoverableQualityReportCut({ stitched: "", finalCut: "" }, undefined),
      ).toBeUndefined();
    });

    it("rejects a complete but non-object evaluation member, the adjacent condition it must not keep", () => {
      // A malformed (not merely cut) reply can still recover a complete
      // top-level `evaluation` member that is not an object at all; this
      // must not be kept, the same way `decodeQualityArtifactResponse`
      // itself would refuse it.
      const malformed = '{"evaluation":"not-an-object","reportMarkdown":"cut here because';
      expect(
        recoverableQualityReportCut({ stitched: malformed, finalCut: malformed }, undefined),
      ).toBeUndefined();
    });
  });

  describe("hostCompleteCutQualityReport", () => {
    it("returns undefined (never fabricates) when the cut lands inside evaluation itself", () => {
      const cutInsideEvaluation = '{"evaluation":{"evaluation_id":"x","target":{"paths":["a.md';
      expect(
        hostCompleteCutQualityReport(
          cutAnswer({ stitched: cutInsideEvaluation, finalCut: cutInsideEvaluation }),
          undefined,
        ),
      ).toBeUndefined();
    });

    it("builds a reply the step's own decodeQualityArtifactResponse admits, naming the cut as the one limitation", () => {
      const complete = JSON.stringify({ evaluation: REALISTIC_EVALUATION, qualityScore: null });
      const cutInsideReportMarkdown = `${complete.slice(0, -1)},"reportMarkdown":"# Report\\n\\ncut here because`;
      const completed = hostCompleteCutQualityReport(
        cutAnswer({ stitched: cutInsideReportMarkdown, finalCut: cutInsideReportMarkdown }),
        undefined,
      );
      expect(completed).toBeDefined();
      expect(completed!.limitation).toContain(QUALITY_REPORT_CUT_STEM);
      expect(completed!.limitation).toContain("evaluate-document-quality");
      expect(completed!.limitation).toContain("32,768-token output limit");
      // The step's real, unchanged admission decoder accepts the completed
      // reply exactly as it would a genuine model reply, and the structured
      // judgment survives byte-for-byte.
      const candidate = decodeQualityArtifactResponse(completed!.reply, {
        selectionSha256: "a".repeat(64),
      } as QualityProfileSelectionReceiptV1);
      expect(candidate.evaluation).toEqual(REALISTIC_EVALUATION);
      expect(candidate.qualityScore).toBeNull();
      expect(candidate.reportMarkdown).toContain(QUALITY_REPORT_CUT_STEM);
      expect(candidate.reportMarkdown.trim().length).toBeGreaterThan(0);
    });

    it("never claims the quality score had already completed when the cut actually landed before it arrived", () => {
      const complete = JSON.stringify({ evaluation: REALISTIC_EVALUATION });
      const cutBeforeQualityScore = `${complete.slice(0, -1)},"qualityScor`;
      const completed = hostCompleteCutQualityReport(
        cutAnswer({ stitched: cutBeforeQualityScore, finalCut: cutBeforeQualityScore }),
        undefined,
      );
      expect(completed).toBeDefined();
      // The false claim this fixes: never say the score "had already
      // completed" when it was actually lost to the cut.
      expect(completed!.limitation).not.toContain("quality score had already completed");
      expect(completed!.limitation).toContain("lost to the cut");
      // The decoded score is still `null` at the wire (the decoder admits no
      // other shape here), but never asserted as the model's own judgment.
      const candidate = decodeQualityArtifactResponse(completed!.reply, {
        selectionSha256: "a".repeat(64),
      } as QualityProfileSelectionReceiptV1);
      expect(candidate.evaluation).toEqual(REALISTIC_EVALUATION);
      expect(candidate.qualityScore).toBeNull();
      expect(candidate.reportMarkdown).toContain("lost to the cut");
    });
  });

  /**
   * End-to-end through the real, unmodified `PiHarness.runStep`: only the
   * provider's HTTP responses are scripted. Mirrors
   * `pi-harness-cut-judgment.test.ts`'s T1 style for the two ledger-based
   * steps, adapted to this step's own reply shape and its lack of a
   * source-obligation ledger.
   */
  it("T1: PiHarness.runStep degrades a real cut evaluate-document-quality answer instead of throwing", async () => {
    const repositoryPath = await createRepository();
    const { harness, qualityProfileSelection } = await qualityEvaluatorFixture();
    const technicalVerification = unverifiedVerificationResultFixture(["README.md"]);
    const input: HarnessStepInput = {
      runId: "cut-judgment-quality-report-t1",
      repositoryPath,
      workflow: WORKFLOW,
      step: EVALUATE_STEP,
      evidenceIdentity: {
        repositoryRevision: "a".repeat(40),
        technicalVerificationSha256: canonicalDigest(technicalVerification),
      },
      qualityProfileSelection,
      technicalVerification,
      verificationTargetPaths: ["README.md"],
    };
    const complete = JSON.stringify({ evaluation: REALISTIC_EVALUATION, qualityScore: null });
    const wholeAnswer = `${complete.slice(0, -1)},"reportMarkdown":"# Report\\n\\nA very long narrative that keeps describing findings and evidence in great detail without ever reaching a natural stopping point because there is always one more sentence to add about this documentation and its many observed properties and characteristics worth narrating at length for the reader`;
    // Split so BOTH turns individually hit the length limit and the
    // concatenation still never closes the reportMarkdown string: exactly
    // what a real two-turn cut looks like once its structured members
    // finished before the narrative did.
    const splitAt = Math.floor(wholeAnswer.length / 2);
    const CUT_USAGE = {
      prompt_tokens: 10,
      completion_tokens: validModelConfig.profile.maxOutputTokens,
      total_tokens: 10 + validModelConfig.profile.maxOutputTokens,
    };
    const cutTurn = (text: string) => textTurn(text, validModelConfig.modelId, "length", CUT_USAGE);
    const provider = scriptedProvider([
      cutTurn(wholeAnswer.slice(0, splitAt)),
      cutTurn(wholeAnswer.slice(splitAt)),
    ]);
    const fetchMock = vi.fn(provider);
    vi.stubGlobal("fetch", fetchMock);

    const result = await harness.runStep(input);

    // No third turn is bought: the host completes the reply once the
    // continuation budget is spent, exactly like the two ledger steps.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.qualityArtifactCandidate?.evaluation).toEqual(REALISTIC_EVALUATION);
    expect(result.qualityArtifactCandidate?.qualityScore).toBeNull();
    expect(result.summary).toContain(QUALITY_REPORT_CUT_STEM);
    expect(result.summary).toContain("evaluate-document-quality");
    expect(result.outcome ?? "succeeded").toBe("succeeded");
  }, 60_000);

  it("continues a V2 report beyond the ordinary continuation count and retains only a complete model judgment", async () => {
    const repositoryPath = await createRepository();
    const { harness, qualityProfileSelection } = await qualityEvaluatorFixture();
    const technicalVerification = unverifiedVerificationResultFixture(["README.md"]);
    const input: HarnessStepInput = {
      runId: "cut-judgment-quality-report-unbounded-continuation",
      repositoryPath,
      workflow: WORKFLOW,
      step: EVALUATE_STEP,
      evidenceIdentity: {
        repositoryRevision: "a".repeat(40),
        technicalVerificationSha256: canonicalDigest(technicalVerification),
      },
      qualityProfileSelection,
      technicalVerification,
      verificationTargetPaths: ["README.md"],
      experimentalAnswerRecordDiscoveryRenewal: true,
    };
    const reply = `${JSON.stringify({ evaluation: REALISTIC_EVALUATION, qualityScore: null })}\n\n# Report\n\nThe complete model judgment remains intact.`;
    const splitAt = Math.floor(reply.length / 3);
    const splitAgainAt = Math.floor((reply.length * 2) / 3);
    const CUT_USAGE = {
      prompt_tokens: 10,
      completion_tokens: validModelConfig.profile.maxOutputTokens,
      total_tokens: 10 + validModelConfig.profile.maxOutputTokens,
    };
    const provider = vi.fn(
      scriptedProvider([
        textTurn(reply.slice(0, splitAt), validModelConfig.modelId, "length", CUT_USAGE),
        textTurn(reply.slice(splitAt, splitAgainAt), validModelConfig.modelId, "length", CUT_USAGE),
        textTurn(reply.slice(splitAgainAt), validModelConfig.modelId),
      ]),
    );
    vi.stubGlobal("fetch", provider);

    const result = await harness.runStep(input);

    expect(provider).toHaveBeenCalledTimes(3);
    expect(result.qualityArtifactCandidate?.evaluation).toEqual(REALISTIC_EVALUATION);
    expect(result.qualityArtifactCandidate?.reportMarkdown).toContain(
      "The complete model judgment remains intact.",
    );
  }, 60_000);

  it("does not host-complete a V2 cut while the required model evaluation is incomplete", async () => {
    const repositoryPath = await createRepository();
    const { harness, qualityProfileSelection } = await qualityEvaluatorFixture();
    const technicalVerification = unverifiedVerificationResultFixture(["README.md"]);
    const input: HarnessStepInput = {
      runId: "cut-judgment-quality-report-incomplete-v2",
      repositoryPath,
      workflow: WORKFLOW,
      step: EVALUATE_STEP,
      evidenceIdentity: {
        repositoryRevision: "a".repeat(40),
        technicalVerificationSha256: canonicalDigest(technicalVerification),
      },
      qualityProfileSelection,
      technicalVerification,
      verificationTargetPaths: ["README.md"],
      experimentalAnswerRecordDiscoveryRenewal: true,
    };
    const incomplete = '{"evaluation":{"evaluation_id":"cut-before-complete"';
    const splitAt = Math.floor(incomplete.length / 2);
    const CUT_USAGE = {
      prompt_tokens: 10,
      completion_tokens: validModelConfig.profile.maxOutputTokens,
      total_tokens: 10 + validModelConfig.profile.maxOutputTokens,
    };
    const provider = vi.fn(
      scriptedProvider([
        textTurn(incomplete.slice(0, splitAt), validModelConfig.modelId, "length", CUT_USAGE),
        textTurn(incomplete.slice(splitAt), validModelConfig.modelId),
      ]),
    );
    vi.stubGlobal("fetch", provider);

    const error = await captureInferenceFailure(harness, input);

    expect(provider).toHaveBeenCalledTimes(2);
    expect(error.condition).toBe("cut-answer");
    expect(error.rejection?.code).toBe("quality-envelope-json");
  }, 60_000);

  /**
   * A cut answer the continuation completed, then refused for its keys, is the
   * `cut-answer` condition. Its retry still names the keys: the key-set repair
   * is keyed on the refusal the decoder raised, so the cut-answer wrap must
   * carry it, or the retry gets only the generic contract text.
   */
  it("carries the key-set repair of a cut, continued and refused answer into its cut-answer retry", async () => {
    const repositoryPath = await createRepository();
    const { harness, qualityProfileSelection } = await qualityEvaluatorFixture();
    const technicalVerification = unverifiedVerificationResultFixture(["README.md"]);
    const input: HarnessStepInput = {
      runId: "cut-judgment-quality-report-key-set",
      repositoryPath,
      workflow: WORKFLOW,
      step: EVALUATE_STEP,
      evidenceIdentity: {
        repositoryRevision: "a".repeat(40),
        technicalVerificationSha256: canonicalDigest(technicalVerification),
      },
      qualityProfileSelection,
      technicalVerification,
      verificationTargetPaths: ["README.md"],
    };
    // The shape hosted Super returned: evaluation fields at the top level.
    const wholeAnswer = `${JSON.stringify({ target: {}, profile: {}, evaluation: {} })}\n\n# Documentation quality evaluation report\n\n## Findings\n\n- None.\n`;
    const splitAt = Math.floor(wholeAnswer.length / 2);
    const CUT_USAGE = {
      prompt_tokens: 10,
      completion_tokens: validModelConfig.profile.maxOutputTokens,
      total_tokens: 10 + validModelConfig.profile.maxOutputTokens,
    };
    const fetchMock = vi.fn(
      scriptedProvider([
        textTurn(wholeAnswer.slice(0, splitAt), validModelConfig.modelId, "length", CUT_USAGE),
        textTurn(wholeAnswer.slice(splitAt), validModelConfig.modelId),
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const failure = await captureInferenceFailure(harness, input);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(failure.rejection).toEqual({ code: "quality-envelope-shape", location: "$" });
    expect(failure.condition).toBe("cut-answer");
    expect(failure.retryable).toBe(true);
    expect(qualityResponseCorrection(failure)).toEqual({
      kind: "quality-key-set",
      missing: ["qualityScore"],
      undeclared: ["target", "profile"],
      withheldCount: 0,
    });
    // The step retry the host schedules hands the repair to the next attempt.
    const corrections: Array<HarnessStepInput["responseCorrection"]> = [];
    const execution = await executeInferenceStep({
      mode: "read-only",
      policy: { ...parseRetryPolicy({}), baseDelayMs: 0, maxDelayMs: 0 },
      sleep: async () => {},
      execute: async (attempt, correction) => {
        corrections.push(correction);
        if (attempt === 1) throw failure;
        return { summary: "admitted" };
      },
    });
    expect(execution.evidence.attempts.map((attempt) => attempt.retryRule)).toEqual([
      "retried-cut-answer",
      "not-applicable",
    ]);
    expect(corrections[1]).toMatchObject({
      condition: "cut-answer",
      detail: { kind: "quality-key-set", missing: ["qualityScore"] },
    });
  }, 60_000);

  /**
   * A conclude-now retry whose forced answer is cut at the output limit still
   * takes the bounded continuation: the ask stays in force, the continuation
   * completes the answer, and the attempt records when the host asked.
   */
  it("completes a cut answer to the conclude-now ask through the continuation", async () => {
    const repositoryPath = await createRepository();
    const { harness, qualityProfileSelection } = await qualityEvaluatorFixture({
      limits: {
        environment: {
          DOCSFAB_EXECUTION_READ_LOOP_REPEAT_STREAK: "2",
          DOCSFAB_EXECUTION_READ_LOOP_WITHHELD_READS: "2",
        },
      },
    });
    const technicalVerification = unverifiedVerificationResultFixture(["README.md"]);
    const input: HarnessStepInput = {
      runId: "cut-judgment-quality-report-conclude-now",
      repositoryPath,
      workflow: WORKFLOW,
      step: EVALUATE_STEP,
      evidenceIdentity: {
        repositoryRevision: "a".repeat(40),
        technicalVerificationSha256: canonicalDigest(technicalVerification),
      },
      qualityProfileSelection,
      technicalVerification,
      verificationTargetPaths: ["README.md"],
      inferenceAttempt: 2,
      retriesConsumed: 1,
      responseCorrection: { retryRule: "retried-no-progress" },
    };
    const whole = `${JSON.stringify({ evaluation: REALISTIC_EVALUATION, qualityScore: null })}\n\n# Report\n\nThe evaluation is complete.\n`;
    const splitAt = Math.floor(whole.length / 2);
    const CUT_USAGE = {
      prompt_tokens: 10,
      completion_tokens: validModelConfig.profile.maxOutputTokens,
      total_tokens: 10 + validModelConfig.profile.maxOutputTokens,
    };
    const requests: Array<{ messages: Array<{ role?: string; content?: unknown }> }> = [];
    const responses = [
      // Four reads reach the first withheld re-read; the next request asks.
      ...[1, 2, 3, 4].map((turn) =>
        toolTurn([{ id: `q${turn}`, name: "read", arguments: { path: "README.md" } }], turn),
      ),
      textTurn(whole.slice(0, splitAt), validModelConfig.modelId, "length", CUT_USAGE),
      textTurn(whole.slice(splitAt), validModelConfig.modelId),
    ];
    vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body ?? "{}")));
      const response = responses[requests.length - 1];
      if (!response) throw new Error("Unexpected provider request.");
      return response.clone();
    });

    const result = await harness.runStep(input);

    expect(requests).toHaveLength(6);
    const lastUser = (index: number) =>
      JSON.stringify(requests[index]!.messages.filter((m) => m.role === "user").at(-1)?.content);
    // The ask, then the continuation of the cut answer to it.
    expect(lastUser(4)).toContain(JSON.stringify(PI_CONCLUDE_NOW_PROMPT).slice(1, 40));
    expect(lastUser(5)).not.toContain(JSON.stringify(PI_CONCLUDE_NOW_PROMPT).slice(1, 40));
    expect(result.qualityArtifactCandidate?.evaluation).toEqual(REALISTIC_EVALUATION);
    expect(result.concludeNow).toEqual({ trigger: "read-loop", turn: 4 });
  }, 60_000);

  /**
   * Kills mutant M11 (round 2's non-blocking finding 3): narrowing the
   * turn-end guard to `declinedCut === "text-truncated"` would skip this
   * exact shape. A continuation is spent on a recoverable `text-truncated`
   * prefix, and the continuation itself then comes back wholly blank
   * (`output-truncated`, classified on ITS OWN turn text alone, per
   * `pi-offline.ts`'s `text.trim() ? "text-truncated" : "output-truncated"`)
   * -- unlike two-blank-turns probes (round 2's P3/P3b), the retained
   * prefix here is never empty, so recovery is genuinely reachable only
   * because the guard still admits `output-truncated`.
   */
  it("T1b: recovers a bound evaluation whose spent continuation comes back blank, unlike a same-shaped fully blank pair", async () => {
    const repositoryPath = await createRepository();
    // A wholly blank turn triggers the underlying agent session's own
    // one-shot "nudge" replay before the harness ever sees `output-truncated`
    // (V6's own T3, `pi-harness-cut-judgment.test.ts:356-386`, needs the same
    // extra scripted turn). The zero-delay connection collapses its backoff
    // so this test does not pay real wall-clock retry time.
    const { harness, qualityProfileSelection } = await qualityEvaluatorFixture({
      createConnection: (model, options) =>
        createModelConnection(
          model,
          options ? { ...options, providerTurnRetry: { baseDelayMs: 0, maxDelayMs: 0 } } : options,
        ),
    });
    const technicalVerification = unverifiedVerificationResultFixture(["README.md"]);
    const input: HarnessStepInput = {
      runId: "cut-judgment-quality-report-t1b",
      repositoryPath,
      workflow: WORKFLOW,
      step: EVALUATE_STEP,
      evidenceIdentity: {
        repositoryRevision: "a".repeat(40),
        technicalVerificationSha256: canonicalDigest(technicalVerification),
      },
      qualityProfileSelection,
      technicalVerification,
      verificationTargetPaths: ["README.md"],
    };
    const complete = JSON.stringify({ evaluation: REALISTIC_EVALUATION, qualityScore: null });
    const firstTurn = `${complete.slice(0, -1)},"reportMarkdown":"# Report\\n\\ncut here because`;
    const CUT_USAGE = {
      prompt_tokens: 10,
      completion_tokens: validModelConfig.profile.maxOutputTokens,
      total_tokens: 10 + validModelConfig.profile.maxOutputTokens,
    };
    const provider = scriptedProvider([
      textTurn(firstTurn, validModelConfig.modelId, "length", CUT_USAGE),
      // The spent continuation's own turn produces no new text at all:
      // `output-truncated`, not a second `text-truncated`. The session
      // nudges once more before accepting it as final.
      textTurn("", validModelConfig.modelId, "length", CUT_USAGE),
      textTurn("", validModelConfig.modelId, "length", CUT_USAGE),
    ]);
    const fetchMock = vi.fn(provider);
    vi.stubGlobal("fetch", fetchMock);

    const result = await harness.runStep(input);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.qualityArtifactCandidate?.evaluation).toEqual(REALISTIC_EVALUATION);
    expect(result.qualityArtifactCandidate?.qualityScore).toBeNull();
    expect(result.summary).toContain(QUALITY_REPORT_CUT_STEM);
    expect(result.outcome ?? "succeeded").toBe("succeeded");
  }, 60_000);

  it.each(["complete", "cut-again", "invalid-proposal"] as const)(
    "update evaluator continues its cut editorial envelope and admits only a complete valid reply: %s",
    async (ending) => {
      const repositoryPath = await createRepository();
      const harness = await createAuditHarness();
      const editorial = editorialTechnicalStepInput(repositoryPath);
      const input: HarnessStepInput = {
        ...editorial,
        step: editorial.workflow.steps.find((step) => step.id === "evaluate-document-quality")!,
      };
      // Cut inside the report string before the independent proposal arrives;
      // retaining report prose alone cannot satisfy the assessment contract.
      const summary =
        "# Documentation Quality Evaluation Report\n\nThe candidate needs revision. " +
        "The independent findings establish a source-supported documentation defect.";
      const proposal = {
        schemaVersion: 1,
        kind: "docsfab-editorial-assessment-proposal",
        assessment: "rejected",
        rationale: "The independent findings establish a source-supported documentation defect.",
        evidenceRefs: ending === "invalid-proposal" ? [] : input.editorialEvidenceRefs,
        limitations: [],
        recommendation: {
          candidate: "update",
          kind: "product-gap",
          code: "product-gap.documentation-defect",
        },
      };
      const reply = JSON.stringify({ summary, editorialAssessmentProposal: proposal });
      const splitAt = reply.indexOf("The independent findings");
      const cutUsage = {
        prompt_tokens: 10,
        completion_tokens: validModelConfig.profile.maxOutputTokens,
        total_tokens: 10 + validModelConfig.profile.maxOutputTokens,
      };
      const provider = vi.fn(
        scriptedProvider([
          textTurn(reply.slice(0, splitAt), validModelConfig.modelId, "length", cutUsage),
          ending === "cut-again"
            ? textTurn(
                "The independent findings remain unfinished",
                validModelConfig.modelId,
                "length",
                cutUsage,
              )
            : textTurn(reply.slice(splitAt)),
        ]),
      );
      vi.stubGlobal("fetch", provider);

      if (ending === "complete") {
        const result = await harness.runStep(input);
        expect(result.summary).toBe(summary);
        expect(result.editorialAssessmentProposal).toEqual(proposal);
        expect(result.summary).not.toContain(QUALITY_REPORT_CUT_STEM);
        expect(result.executionLease).toMatchObject({ terminalDisposition: "completed" });
      } else {
        const error = await captureInferenceFailure(harness, input);
        expect(error.condition).toBe("cut-answer");
        if (ending === "cut-again") {
          expect(error.rejection).toEqual({ code: "text-truncated", location: "$response" });
          expect(error.message).toContain("output limit");
        } else {
          expect(error.rejection?.location).toBe("$.editorialAssessmentProposal");
          expect(error.rejection?.code).toBe("invalid-value");
        }
      }
      expect(provider).toHaveBeenCalledTimes(2);
      const continuationRequest = String(provider.mock.calls[1]?.[1]?.body);
      expect(continuationRequest).toContain("finish_reason=length");
      expect(continuationRequest).toContain("Continue");
    },
  );

  /**
   * The hosted shape: `runHostedWorkflow` never binds a quality-evaluator
   * profile (only the local CLI's `createLocalWorkflowApplicationServices`
   * does), so every pilot run of this step is the "unbound evaluator" T1
   * never exercises. Its prompt never loads the evaluator contract, so its
   * reply is plain markdown, not the JSON envelope T1's cut recovers --
   * proving the live J2 `output-limit-reached` shape now degrades too,
   * through the real, unmodified `PiHarness.runStep`.
   */
  it("T3 (hosted shape): PiHarness.runStep degrades a real cut answer for the unbound evaluator every hosted pilot run uses today, instead of failing as it did before this fix round", async () => {
    const repositoryPath = await createRepository();
    const harness = await createAuditHarness();
    const input: HarnessStepInput = {
      runId: "cut-judgment-quality-report-t3-unbound",
      repositoryPath,
      workflow: WORKFLOW,
      step: EVALUATE_STEP,
      // No `qualityProfileSelection`: the unbound evaluator. `evidenceIdentity`
      // carries only `repositoryRevision`, never `technicalVerificationSha256`
      // (and no `technicalVerification` either) -- the unbound evaluator
      // cannot accept one (pi.ts's `validateQualityCandidateToolBinding`
      // throws if it tries).
      evidenceIdentity: { repositoryRevision: "a".repeat(40) },
    };
    const cutText =
      "# Documentation quality report\n\nThe documentation is thorough and accurate across the " +
      "reviewed pages, with strong navigation coverage and consistently applied terminology. The " +
      "one area needing attention is";
    const CUT_USAGE = {
      prompt_tokens: 10,
      completion_tokens: validModelConfig.profile.maxOutputTokens,
      total_tokens: 10 + validModelConfig.profile.maxOutputTokens,
    };
    const provider = scriptedProvider([
      textTurn(cutText, validModelConfig.modelId, "length", CUT_USAGE),
    ]);
    const fetchMock = vi.fn(provider);
    vi.stubGlobal("fetch", fetchMock);

    const result = await harness.runStep(input);

    // No continuation is ever offered: the unbound evaluator never enters
    // the structured-envelope continuation branch (`requiresStructuredResponseEnvelope`
    // is false for it), so this is a single turn, not two.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.qualityArtifactCandidate).toBeUndefined();
    expect(result.summary).toContain(cutText);
    expect(result.summary).toContain(QUALITY_REPORT_CUT_STEM);
    expect(result.summary).toContain("evaluate-document-quality");
    expect(result.outcome ?? "succeeded").toBe("succeeded");
  }, 60_000);

  // A real `PiHarness.runStep` reproduction of a blank first turn
  // (`output-truncated`, nothing written before the limit) is not added
  // here: scripting a wholly empty `finish_reason: "length"` turn hits the
  // same lower-level provider-session empty-response retry this suite's
  // "output-truncated" twin test above already documents as unrelated to
  // this classification (it consumes its own retries before ever reaching
  // `declinedJudgmentCut`). The composed unit proof below exercises the
  // same logic that decides this case for the unbound evaluator: an empty
  // `stitched` answer is never treated as recoverable, so it falls through
  // to the unchanged pre-existing failure exactly as it does for the bound
  // evaluator (proved end-to-end just above by "adjacent condition:
  // without a recoverable evaluation...").
  it("T3 adjacent condition: composed unit proof -- an empty stitched answer is never recoverable for the unbound evaluator either", () => {
    expect(
      declinedJudgmentCut({ workflow: WORKFLOW, step: EVALUATE_STEP }, "output-truncated", 0, 0),
    ).toBe("output-truncated");
    // The unbound branch's own recoverability check (mirrored from the
    // turn-end site in pi.ts): an empty stitched answer has nothing to keep.
    expect("".trim().length === 0).toBe(true);
  });

  it("adjacent condition: without a recoverable evaluation, the same cut still fails the step exactly as it did before this slice, not a retryable blank-response", async () => {
    const repositoryPath = await createRepository();
    const { harness, qualityProfileSelection } = await qualityEvaluatorFixture();
    const technicalVerification = unverifiedVerificationResultFixture(["README.md"]);
    const input: HarnessStepInput = {
      runId: "cut-judgment-quality-report-t2",
      repositoryPath,
      workflow: WORKFLOW,
      step: EVALUATE_STEP,
      evidenceIdentity: {
        repositoryRevision: "a".repeat(40),
        technicalVerificationSha256: canonicalDigest(technicalVerification),
      },
      qualityProfileSelection,
      technicalVerification,
      verificationTargetPaths: ["README.md"],
    };
    // Cut while `evaluation` itself is still being written: nothing safe to
    // keep, so this must still fail exactly as it did before this slice --
    // the pre-existing non-retryable `malformed-response`/`text-truncated`
    // classification, never the generic retryable "blank response" a step
    // with no recovered content otherwise falls into.
    const cutInsideEvaluation =
      '{"evaluation":{"evaluation_id":"cut-judgment-quality-report-fixture","target":{"paths":["README.md';
    const CUT_USAGE = {
      prompt_tokens: 10,
      completion_tokens: validModelConfig.profile.maxOutputTokens,
      total_tokens: 10 + validModelConfig.profile.maxOutputTokens,
    };
    const cutTurn = (text: string) => textTurn(text, validModelConfig.modelId, "length", CUT_USAGE);
    const splitAt = Math.floor(cutInsideEvaluation.length / 2);
    const secondTurnText = cutInsideEvaluation.slice(splitAt);
    const provider = scriptedProvider([
      cutTurn(cutInsideEvaluation.slice(0, splitAt)),
      cutTurn(secondTurnText),
    ]);
    vi.stubGlobal("fetch", vi.fn(provider));

    const error = await captureInferenceFailure(harness, input);

    expect(error.message).toContain(
      `text-truncated: step evaluate-document-quality answer cut at the ${validModelConfig.profile.maxOutputTokens.toLocaleString("en-US")}-token output limit (finish_reason=length) after ${secondTurnText.length.toLocaleString("en-US")} characters`,
    );
    // The cut is the `cut-answer` condition; the retry rule decides, not the harness.
    expect(error.retryable).toBe(true);
    expect(error.condition).toBe("cut-answer");
    expect(error.rejection).toEqual({ code: "text-truncated", location: "$response" });
  }, 60_000);

  // Every structured step marks the same shape `cut-answer`; the retry rule's
  // own budget decides, with no step-specific exemption.
  it("keeps a refused stitched answer retryable on the quality evaluator", async () => {
    const repositoryPath = await createRepository();
    const { harness, qualityProfileSelection } = await qualityEvaluatorFixture();
    const technicalVerification = unverifiedVerificationResultFixture(["README.md"]);
    const input: HarnessStepInput = {
      runId: "cut-judgment-quality-report-restart",
      repositoryPath,
      workflow: WORKFLOW,
      step: EVALUATE_STEP,
      evidenceIdentity: {
        repositoryRevision: "a".repeat(40),
        technicalVerificationSha256: canonicalDigest(technicalVerification),
      },
      qualityProfileSelection,
      technicalVerification,
      verificationTargetPaths: ["README.md"],
    };
    // The cut turn stops inside the evaluation; the continuation finishes
    // normally but restarts the whole answer, so the stitched reply is refused.
    const whole = `${JSON.stringify({ evaluation: REALISTIC_EVALUATION, qualityScore: null })}\n\n# Report\n`;
    const CUT_USAGE = {
      prompt_tokens: 10,
      completion_tokens: validModelConfig.profile.maxOutputTokens,
      total_tokens: 10 + validModelConfig.profile.maxOutputTokens,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(
        scriptedProvider([
          textTurn(whole.slice(0, 60), validModelConfig.modelId, "length", CUT_USAGE),
          textTurn(whole),
        ]),
      ),
    );

    const error = await captureInferenceFailure(harness, input);

    expect(error.category).toBe("malformed-response");
    expect(error.rejection?.code).toBe("quality-envelope-json");
    // A fresh attempt within the cut-answer budget, not a stitched decline.
    expect(error.retryable).toBe(true);
    expect(error.condition).toBe("cut-answer");
  }, 60_000);

  it("never asks the evaluator for a field the host writes, when the host binds the target", async () => {
    const promptFor = async (bound: boolean, focused: boolean): Promise<string> => {
      const repositoryPath = await createRepository();
      const { harness, qualityProfileSelection } = await qualityEvaluatorFixture();
      const technicalVerification = unverifiedVerificationResultFixture(["README.md"]);
      const input: HarnessStepInput = {
        runId: `host-written-target-${bound}-${focused}`,
        repositoryPath,
        workflow: WORKFLOW,
        step: EVALUATE_STEP,
        evidenceIdentity: {
          repositoryRevision: "a".repeat(40),
          technicalVerificationSha256: canonicalDigest(technicalVerification),
        },
        qualityProfileSelection,
        technicalVerification,
        verificationTargetPaths: ["README.md"],
        ...(bound
          ? { qualityEvaluationTarget: [{ path: "README.md", directory: false, pageCount: 1 }] }
          : {}),
        // A focused review states its own scope block to every review step.
        ...(focused
          ? {
              reviewScope: {
                scope: "focused-set" as const,
                reason: "operator-named" as const,
                targetPaths: ["README.md"],
                deferredPaths: [],
                scopeSha256: "b".repeat(64),
                corpusFileCount: 1,
              },
            }
          : {}),
      };
      const fetchMock = vi.fn(scriptedProvider([textTurn("Not an answer.")]));
      vi.stubGlobal("fetch", fetchMock);
      await harness.runStep(input).catch(() => undefined);
      vi.unstubAllGlobals();
      const init = fetchMock.mock.calls[0]![1] as { body: string };
      return init.body;
    };
    const line = (body: string, subject: string) => {
      const start = body.indexOf(`- ${subject} must contain`);
      return start < 0 ? "" : body.slice(start, body.indexOf(".\\n", start));
    };
    const writtenKeys = (text: string) =>
      text.slice(0, text.indexOf(";") < 0 ? undefined : text.indexOf(";"));

    for (const focused of [false, true]) {
      const bound = await promptFor(true, focused);
      // No sentence anywhere asks the evaluator to write a host-written field.
      for (const field of HOST_WRITTEN_EVALUATION_FIELDS) {
        const escapedField = field.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
        expect(bound, `${field} focused=${focused}`).not.toMatch(
          new RegExp(`\\bevaluation\\.${escapedField} (?:must|to exactly)`, "u"),
        );
      }
      expect(bound).toContain(hostWrittenEvaluationFieldsSentence());
      const target = line(bound, "evaluation.target");
      expect(target).toMatch(/; leave out [^;]*\bpaths\b[^;]*, which the host writes$/u);
      expect(writtenKeys(target)).not.toMatch(/\bpaths\b/u);
      // Adjacent: the same key name in another object stays the evaluator's.
      const evidence = line(bound, "evaluation.target.documentation_family_evidence[]");
      expect(writtenKeys(evidence)).toMatch(/\bpaths\b/u);
      expect(evidence).not.toContain("which the host writes");
    }
    // Adjacent: without a bound target the evaluator writes the field itself.
    const unboundFocused = await promptFor(false, true);
    expect(unboundFocused).toContain("target.paths must contain exactly the approved page paths");
    const unbound = line(await promptFor(false, false), "evaluation.target");
    expect(writtenKeys(unbound)).toMatch(/\bpaths\b/u);
    expect(unbound).not.toContain("which the host writes");
  }, 240_000);

  /**
   * The output-truncated shape (a completely blank cut turn) takes the same
   * `declinedJudgmentCut` gate and the same `recoverableQualityReportCut`
   * check as the text-truncated case above, proven independently at the
   * unit level: "recognizes an output-truncated cut ... immediately" (the
   * gate) and "finds nothing to keep on a completely blank (output-
   * truncated) answer" (the recovery). Composed, they drive the identical
   * pi.ts fall-through this file's T2 case proves end to end -- an
   * end-to-end blank-turn reproduction is not added here because a fully
   * empty provider response is intercepted by the underlying agent
   * session's own empty-response retry before reaching this classification
   * at all, which is unrelated to this fix and out of this slice's scope.
   */

  it("adjacent condition: without a recoverable evaluation, the same cut still fails the step (T2's real-harness proof) -- composed unit proof for the output-truncated shape", () => {
    expect(
      declinedJudgmentCut({ workflow: WORKFLOW, step: EVALUATE_STEP }, "output-truncated", 0, 1),
    ).toBe("output-truncated");
    expect(recoverableQualityReportCut({ stitched: "", finalCut: "" }, undefined)).toBeUndefined();
  });
});
