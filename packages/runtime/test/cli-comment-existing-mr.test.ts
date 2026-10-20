// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { parseDoArguments, parseRunArguments, parseCommentMrTarget } from "../src/cli.js";
import { usage } from "../src/cli/usage.js";
import {
  CommentExistingMrHeadChangedError,
  bindCommentExistingMrTarget,
  emptyCommentExistingMrMutations,
  postCommentExistingMrReviewSummary,
  reviewCoverageFromRun,
  reviewResultFromRun,
  reviewResultInputFromRun,
  type CommentExistingMrPort,
  type ObservedMergeRequest,
} from "../src/cli/comment-existing-mr.js";
import { createReviewResult, decodeReviewResult } from "../src/review/index.js";
import { reviewResultFromRun as hostedReviewResultFromRun } from "../src/review/run-result.js";
import { declinedQualityReportNote } from "../src/workflow-execution/quality-correction-round.js";
import { GOLDEN_OUTCOME_REQUEST } from "../src/cli/outcome-router.js";
import type { RunRecord } from "../src/records/contracts.js";
import { canonicalDigest } from "../src/content-ir/canonical.js";
import {
  QUALITY_REPORT_FAILURES,
  inspectQualityReportFromRun,
  projectQualityReportFromRun,
  QualityReportProjectionError,
  sealQualityValidationBinding,
  sealQualityValidatorReceipt,
} from "../src/evaluation-report/index.js";

const HEAD = "d".repeat(40);
const OTHER_HEAD = "e".repeat(40);
const IDENTITY = "a".repeat(64);
const EVALUATION_RECORD = "1".repeat(64);
const SCORE_RECORD = "2".repeat(64);
const EVALUATOR_IDENTITY = "3".repeat(64);
const PACK_BINDING = "4".repeat(64);

function qualityReport(revision = HEAD): string {
  return [
    "# Documentation quality evaluation report",
    "",
    "## Validated result summary",
    "",
    "```json",
    JSON.stringify({
      report_contract: "docsfab-quality-report-v0.1",
      target: {
        paths: ["docs/page.md"],
        repository_revision: revision,
        documentation_revision: revision,
      },
      profile: { id: "docsfab-documentation-quality", version: "v0.1" },
      evaluation: { decision: "pass", confidence: 0.9, hard_gate_failures: [] },
      rubric: {
        status: "available",
        id: "task-guide-v0.1",
        dimension_scores: {},
        total: 84,
        threshold: 80,
        interpretation_band: "Green",
        decision: "pass",
        confidence: 0.9,
        hard_gates: {},
      },
      validation: { evaluation: "passed", quality_score: "passed", report_binding: "passed" },
      artifact_locators: {
        evaluation: `record:sha256:${EVALUATION_RECORD}`,
        quality_score: `record:sha256:${SCORE_RECORD}`,
        quality_report: "run:run-test-001:evaluate-document-quality:quality-report",
      },
    }),
    "```",
    "",
    "## Evidence gaps and limitations",
    "",
    "- Limitation: One audience scenario was unavailable.",
  ].join("\n");
}

function observed(overrides: Partial<ObservedMergeRequest> = {}): ObservedMergeRequest {
  return {
    host: "gitlab.example.com",
    projectId: 437040,
    mergeRequestIid: 88,
    sourceBranch: "docsfab/topic",
    targetBranch: "main",
    headSha: HEAD,
    requestIdentitySha256: IDENTITY,
    proofStatus: "current",
    ...overrides,
  };
}

function record(overrides: Partial<RunRecord> = {}): RunRecord {
  const result: RunRecord = {
    schemaVersion: 2,
    id: "run-test-001",
    workflow: "review-documentation",
    repository: {
      sourcePath: "/tmp/example",
      requestedRevision: HEAD,
      revision: HEAD,
    },
    workspace: { strategy: "tracked-export", disposable: true },
    status: "succeeded",
    createdAt: "2026-08-21T12:00:00.000Z",
    models: [],
    skills: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0 },
    tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
    steps: [
      {
        id: "evaluate-document-quality",
        title: "Evaluate document quality",
        kind: "evaluate",
        skill: "evaluate-document-quality",
        mode: "read-only",
        status: "succeeded",
        summary: qualityReport(),
      },
    ],
    changes: {
      files: [{ path: "docs/page.md", status: "modified" }],
      patch: {
        sha256: "b".repeat(64),
        byteLength: 32,
        lineCount: 4,
        artifactPath: "/tmp/run.patch",
        format: "git-diff",
      },
    },
    ...overrides,
  };
  return bindQualityEvidence(result);
}

function bindQualityEvidence(recordValue: RunRecord): RunRecord {
  const evaluator = recordValue.steps.find((step) => step.skill === "evaluate-document-quality");
  if (!evaluator?.summary) return recordValue;
  const selectionBody = {
    workflow: "review-documentation" as const,
    selectorId: "review-documentation:docsfab-documentation-quality:v1" as const,
    workflowSourceSha256: "4".repeat(64),
    repositoryIdentitySha256: createHash("sha256").update("/tmp/example").digest("hex"),
    repositoryRevision: recordValue.repository.revision,
    inventorySha256: "5".repeat(64),
    targetScope: "documentation-set" as const,
    targetScopeSha256: "6".repeat(64),
    targetPathSetSha256: "3".repeat(64),
    applicabilitySha256: "f".repeat(64),
    documentCount: 1,
    qualityPackManifestSha256: "8".repeat(64),
    qualityPackBindingSha256: PACK_BINDING,
    skillLockSha256: "9".repeat(64),
    qualityLockSha256: "a".repeat(64),
    qualityBundleSha256: "7".repeat(64),
    profileBarId: "profile:docsfab-documentation-quality" as const,
    profileAssetPath: "profiles/docsfab-documentation-quality/profile.json" as const,
    profilePayloadSha256: "d425dd5c21b067ab67dbfdb6b06082b480769216a31e6df50a6341c1d8e62c01",
    profileId: "docsfab-documentation-quality" as const,
    profileVersion: "v0.1" as const,
    profileModel: "documentation-quality-model-v0.2" as const,
    profileStatus: "experimental" as const,
    releaseGateEligible: false as const,
  };
  const selection = {
    schemaVersion: 1 as const,
    kind: "docsfab-quality-profile-selection-receipt" as const,
    ...selectionBody,
    selectionSha256: canonicalDigest({
      schemaVersion: 1,
      kind: "docsfab-quality-profile-selection-receipt",
      ...selectionBody,
    }),
  };
  const reportSha256 = createHash("sha256").update(evaluator.summary, "utf8").digest("hex");
  recordValue.qualityPack = {
    schemaVersion: 1,
    id: "docsfab-default",
    version: "1.0.0",
    manifestSha256: "8".repeat(64),
    bindingSha256: PACK_BINDING,
    skillLockSha256: "9".repeat(64),
    qualityLockSha256: "a".repeat(64),
    qualityBundleSha256: selection.qualityBundleSha256,
    barIds: [selection.profileBarId],
  };
  recordValue.qualityProfileSelection = selection;
  evaluator.evaluateEvidence = {
    schemaVersion: 1,
    kind: "docsfab-evaluate-step-evidence",
    evaluatorIdentitySha256: EVALUATOR_IDENTITY,
    toolPolicySha256: "b".repeat(64),
    acceptancePolicySha256: "c".repeat(64),
  };
  recordValue.qualityArtifactValidation = sealQualityValidationBinding({
    runId: recordValue.id,
    repositoryRevision: recordValue.repository.revision,
    selectionSha256: selection.selectionSha256,
    qualityPackBindingSha256: PACK_BINDING,
    evaluatorIdentitySha256: EVALUATOR_IDENTITY,
    status: "passed",
    failureCode: null,
    artifacts: {
      evaluation: { recordSha256: EVALUATION_RECORD, payloadSha256: "d".repeat(64) },
      qualityScore: { recordSha256: SCORE_RECORD, payloadSha256: "e".repeat(64) },
      candidateReport: { recordSha256: "f".repeat(64), payloadSha256: reportSha256 },
      finalReport: { recordSha256: "1".repeat(64), payloadSha256: reportSha256 },
    },
    validatorAssets: {
      evaluationScriptSha256: "65".padStart(64, "0"),
      evaluationSchemaSha256: "2".repeat(64),
      qualityScoreScriptSha256: "71".padStart(64, "0"),
      reportScriptSha256: "72".padStart(64, "0"),
    },
    validators: {
      evaluation: qualityValidatorReceipt("evaluation", [
        "d".repeat(64),
        "2".repeat(64),
        selection.profilePayloadSha256,
      ]),
      qualityScore: qualityValidatorReceipt("quality-score", ["e".repeat(64)]),
      reportBinding: qualityValidatorReceipt("report-binding", [
        "d".repeat(64),
        reportSha256,
        selection.profilePayloadSha256,
        "e".repeat(64),
      ]),
    },
  });
  return recordValue;
}

function qualityValidatorReceipt(
  validator: "evaluation" | "quality-score" | "report-binding",
  inputPayloadSha256s: string[],
) {
  return sealQualityValidatorReceipt({
    validator,
    program: "python3",
    scriptSha256: validator.charCodeAt(0).toString(16).padStart(64, "0"),
    inputPayloadSha256s,
    outcome: "passed",
    exitCode: 0,
    stdoutSha256: "1".repeat(64),
    stderrSha256: "2".repeat(64),
  });
}

function expectInvalidQualityReport(
  recordValue: RunRecord,
  binding: ReturnType<typeof bindCommentExistingMrTarget>,
): void {
  expect(inspectQualityReportFromRun(recordValue)).toEqual({
    quality: null,
    error: QUALITY_REPORT_FAILURES["invalid-report"],
  });
  expect(() => projectQualityReportFromRun(recordValue)).toThrowError(
    expect.objectContaining({
      name: "QualityReportProjectionError",
      code: "invalid-report",
    }),
  );
  expect(() => reviewResultFromRun(recordValue, binding)).toThrowError(
    expect.objectContaining({
      name: "QualityReportProjectionError",
      code: "invalid-report",
    }),
  );
}

function rebindEvaluatorMarkdown(recordValue: RunRecord, markdown: string): void {
  const validation = recordValue.qualityArtifactValidation!;
  const reportReceipt = validation.validators.reportBinding!;
  const payloadSha256 = createHash("sha256").update(markdown, "utf8").digest("hex");
  recordValue.steps[0]!.summary = markdown;
  recordValue.qualityArtifactValidation = sealQualityValidationBinding({
    runId: validation.runId,
    repositoryRevision: validation.repositoryRevision,
    selectionSha256: validation.selectionSha256,
    qualityPackBindingSha256: validation.qualityPackBindingSha256,
    evaluatorIdentitySha256: validation.evaluatorIdentitySha256,
    status: validation.status,
    failureCode: validation.failureCode,
    artifacts: {
      ...validation.artifacts,
      finalReport: { ...validation.artifacts.finalReport!, payloadSha256 },
    },
    validatorAssets: validation.validatorAssets,
    validators: {
      ...validation.validators,
      reportBinding: sealQualityValidatorReceipt({
        validator: reportReceipt.validator,
        program: reportReceipt.program,
        scriptSha256: reportReceipt.scriptSha256,
        inputPayloadSha256s: reportReceipt.inputPayloadSha256s.map((digest, index) =>
          index === 1 ? payloadSha256 : digest,
        ),
        outcome: reportReceipt.outcome,
        exitCode: reportReceipt.exitCode,
        stdoutSha256: reportReceipt.stdoutSha256,
        stderrSha256: reportReceipt.stderrSha256,
      }),
    },
  });
}

function fakePort(
  options: { heads?: string[]; project?: CommentExistingMrPort["project"] } = {},
): CommentExistingMrPort {
  const heads = [...(options.heads ?? [HEAD])];
  const mutations = emptyCommentExistingMrMutations();
  return {
    mutations,
    async observe() {
      const headSha = heads.length > 1 ? heads.shift()! : (heads[0] ?? HEAD);
      return observed({ headSha });
    },
    project:
      options.project ??
      (async (input) => {
        const target = input.target as { headSha: string; mergeRequestIid: number };
        return {
          status: "projected" as const,
          mutation: "created",
          reviewedHeadSha: target.headSha,
          mergeRequestIid: target.mergeRequestIid,
          noteId: "note-1",
          deliveryIntent: "comment-existing-mr" as const,
        };
      }),
  };
}

describe("comment-existing-mr CLI target", () => {
  it("accepts one unambiguous IID or GitLab MR URL", () => {
    expect(parseCommentMrTarget("88")).toEqual({ kind: "iid", mergeRequestIid: 88 });
    expect(parseCommentMrTarget("!88")).toEqual({ kind: "iid", mergeRequestIid: 88 });
    expect(
      parseCommentMrTarget(
        "https://gitlab.example.com/tech-docs/agents/docsfab/-/merge_requests/88",
      ),
    ).toEqual({
      kind: "url",
      host: "gitlab.example.com",
      projectPath: "tech-docs/agents/docsfab",
      mergeRequestIid: 88,
    });
  });

  it("rejects credentials, query tokens, and ambiguous values", () => {
    expect(() => parseCommentMrTarget(`88 glpat-${"A".repeat(20)}`)).toThrow(/credential/u);
    expect(() =>
      parseCommentMrTarget(
        "https://gitlab.example.com/group/project/-/merge_requests/88?private_token=secret",
      ),
    ).toThrow(/credential/u);
    expect(() => parseCommentMrTarget("not-an-mr")).toThrow(/unambiguous/u);
    expect(() => parseCommentMrTarget("0")).toThrow(/unambiguous/u);
  });
});

describe("comment-existing-mr run arguments", () => {
  it("parses --comment-mr without --allow-write and binds it separately from --draft-mr", () => {
    expect(
      parseRunArguments(["review-documentation", "--repo", "repository", "--comment-mr", "88"]),
    ).toMatchObject({
      workflow: "review-documentation",
      commentMr: "88",
      draftMr: false,
      allowWrite: false,
    });
    expect(() =>
      parseRunArguments([
        "review-documentation",
        "--repo",
        "repository",
        "--allow-write",
        "--draft-mr",
        "--comment-mr",
        "88",
      ]),
    ).toThrow(/cannot be combined with --draft-mr/u);
    expect(() =>
      parseRunArguments([
        "review-documentation",
        "--repo",
        "repository",
        "--comment-mr",
        "88",
        "--comment-mr",
        "89",
      ]),
    ).toThrow(/must not be duplicated/u);
  });

  it("documents the explicit MR target on run and do", () => {
    const text = usage();
    expect(text).toContain("--comment-mr <iid-or-url>");
    expect(text).toContain("posts one review summary on that exact MR/head");
    expect(text).toContain("creates no branch or MR");
    expect(text).toContain("requires an injected host review-summary port");
  });

  it("parses --canon-sha256 only beside --comment-mr, once, as 64 lowercase hex", () => {
    const canon = "c".repeat(64);
    expect(
      parseRunArguments([
        "review-documentation",
        "--repo",
        "repository",
        "--comment-mr",
        "88",
        "--canon-sha256",
        canon,
      ]),
    ).toMatchObject({ commentMr: "88", commentMrCanonSha256: canon });
    expect(
      parseRunArguments(["review-documentation", "--repo", "repository", "--comment-mr", "88"]),
    ).not.toHaveProperty("commentMrCanonSha256");
    expect(() =>
      parseRunArguments(["review-documentation", "--repo", "repository", "--canon-sha256", canon]),
    ).toThrow(/--canon-sha256 requires --comment-mr/u);
    expect(() =>
      parseRunArguments([
        "review-documentation",
        "--repo",
        "repository",
        "--comment-mr",
        "88",
        "--canon-sha256",
        canon,
        "--canon-sha256",
        canon,
      ]),
    ).toThrow(/must not be duplicated/u);
    expect(() =>
      parseRunArguments([
        "review-documentation",
        "--repo",
        "repository",
        "--comment-mr",
        "88",
        "--canon-sha256",
        "C".repeat(64),
      ]),
    ).toThrow(/64 lowercase hex/u);
    expect(usage()).toContain("--canon-sha256 <sha256>");
  });
});

describe("comment-existing-mr do arguments", () => {
  it("forwards --comment-mr and refuses draft-MR creation", () => {
    expect(
      parseDoArguments([GOLDEN_OUTCOME_REQUEST, "--repo", "/tmp/repo", "--comment-mr", "!88"]),
    ).toMatchObject({
      commentMr: "!88",
      draftMr: false,
      allowWrite: false,
    });
    expect(() =>
      parseDoArguments([
        GOLDEN_OUTCOME_REQUEST,
        "--repo",
        "/tmp/repo",
        "--allow-write",
        "--draft-mr",
        "--comment-mr",
        "88",
      ]),
    ).toThrow(/cannot be combined with --draft-mr/u);
    expect(() =>
      parseDoArguments([
        GOLDEN_OUTCOME_REQUEST,
        "--repo",
        "/tmp/repo",
        "--route-only",
        "--comment-mr",
        "88",
      ]),
    ).toThrow(/classification is not a grant/u);
  });
});

describe("comment-existing-mr composition", () => {
  it("binds the observed head and posts one review summary without git mutations", async () => {
    const port = fakePort();
    const binding = bindCommentExistingMrTarget(observed(), "review-documentation", 0);
    expect(binding.target.headSha).toBe(HEAD);
    expect(binding.target.deliveryIntent).toBe("comment-existing-mr");
    expect(binding.target.trigger).toBe("interactive");
    expect(binding.target.mergeRequestIid).toBe(88);
    expect(binding.target.logicalRequestId).toBe("cli-comment:review-documentation:437040:88");
    const result = reviewResultFromRun(record(), binding);
    expect(result.reviewedHeadSha).toBe(HEAD);
    expect(result.affectedPaths).toEqual(["docs/page.md"]);
    expect(result.patchLocator).toEqual({ kind: "artifact-digest", digestSha256: "b".repeat(64) });
    expect(JSON.stringify(result)).not.toContain("/tmp/run.patch");
    expect(JSON.stringify(result)).not.toContain("glpat-");
    const receipt = await postCommentExistingMrReviewSummary(
      port,
      binding,
      record(),
      { kind: "iid", mergeRequestIid: 88 },
      "/tmp/example",
      false,
    );
    expect(receipt.status).toBe("projected");
    expect(receipt.mergeRequestIid).toBe(88);
    expect(port.mutations).toEqual({ commits: 0, branches: 0, pushes: 0, mergeRequests: 0 });
  });

  it("projects a validated final evaluation as a v2 MR review result", () => {
    const binding = bindCommentExistingMrTarget(observed(), "review-documentation", 0);
    const result = reviewResultFromRun(
      record({
        workflow: "review-documentation",
        steps: [
          {
            id: "evaluate-document-quality",
            title: "Evaluate document quality",
            kind: "evaluate",
            skill: "evaluate-document-quality",
            mode: "read-only",
            status: "succeeded",
            summary: qualityReport(),
          },
        ],
      }),
      binding,
    );

    expect(result).toMatchObject({
      schemaVersion: 2,
      reviewedHeadSha: HEAD,
      qualityReport: {
        decision: "pass",
        patchSha256: "b".repeat(64),
        rubric: { status: "available", total: 84, interpretationBand: "Green" },
      },
    });
  });

  it("rejects absent, unsealed, substituted, digest-mismatched, or locator-mismatched quality evidence", () => {
    const binding = bindCommentExistingMrTarget(observed(), "review-documentation", 0);
    const absent = record();
    delete absent.qualityProfileSelection;
    delete absent.qualityArtifactValidation;
    expectInvalidQualityReport(absent, binding);

    const unsealed = record();
    unsealed.qualityArtifactValidation = {
      ...unsealed.qualityArtifactValidation!,
      bindingSha256: "0".repeat(64),
    };
    expectInvalidQualityReport(unsealed, binding);

    const substituted = record();
    substituted.qualityArtifactValidation = {
      ...substituted.qualityArtifactValidation!,
      repositoryRevision: "f".repeat(40),
    };
    expectInvalidQualityReport(substituted, binding);

    const digestMismatched = record();
    const digestValidation = digestMismatched.qualityArtifactValidation!;
    digestMismatched.qualityArtifactValidation = sealQualityValidationBinding({
      runId: digestValidation.runId,
      repositoryRevision: digestValidation.repositoryRevision,
      selectionSha256: digestValidation.selectionSha256,
      qualityPackBindingSha256: digestValidation.qualityPackBindingSha256,
      evaluatorIdentitySha256: digestValidation.evaluatorIdentitySha256,
      status: digestValidation.status,
      failureCode: digestValidation.failureCode,
      artifacts: {
        ...digestValidation.artifacts,
        finalReport: {
          ...digestValidation.artifacts.finalReport!,
          payloadSha256: "9".repeat(64),
        },
      },
      validatorAssets: digestValidation.validatorAssets,
      validators: digestValidation.validators,
    });
    expectInvalidQualityReport(digestMismatched, binding);

    const locatorMismatched = record();
    rebindEvaluatorMarkdown(
      locatorMismatched,
      locatorMismatched.steps[0]!.summary!.replace(
        `record:sha256:${EVALUATION_RECORD}`,
        `record:sha256:${"9".repeat(64)}`,
      ),
    );
    expectInvalidQualityReport(locatorMismatched, binding);

    const forgedPass = record();
    forgedPass.steps = [{ ...forgedPass.steps[0]!, summary: "Quality evaluation: PASS" }];
    delete forgedPass.qualityProfileSelection;
    delete forgedPass.qualityArtifactValidation;
    expect(inspectQualityReportFromRun(forgedPass)).toEqual({
      quality: null,
      error: QUALITY_REPORT_FAILURES["missing-report"],
    });
    expect(() => reviewResultFromRun(forgedPass, binding)).toThrow(QualityReportProjectionError);
  });

  it("carries the hosted HTML report URL on the GitLab review result", () => {
    const binding = bindCommentExistingMrTarget(observed(), "review-documentation", 0);
    const url = "http://127.0.0.1:8787/reports/run-test-001/";
    const result = reviewResultFromRun(record(), binding, url);
    expect(result).toMatchObject({
      schemaVersion: 2,
      hostedReportUrl: url,
    });
    expect(JSON.stringify(result)).toContain(url);
  });

  it("carries a focused run's review scope as the coverage block, with the canon digest when given", () => {
    const binding = bindCommentExistingMrTarget(observed(), "review-documentation", 0);
    const canon = "c".repeat(64);
    const focused = record({
      reviewScope: {
        scope: "focused-set",
        reason: "operator-named",
        targetPaths: ["docs/a.md", "docs/page.md", "docs/c.md"],
        // A `home/` segment is an ordinary tracked page (the Slack `target=`
        // grammar admits it), so the block carries it unchanged.
        deferredPaths: ["docs/d.md", "docs/e.md", "docs/home/index.md"],
        anchorPaths: [],
        scopeSha256: "5".repeat(64),
        corpusFileCount: 824,
      },
    });
    const withCanon = reviewResultFromRun(focused, binding, undefined, canon);
    expect(withCanon.reviewScope).toEqual({
      scope: "focused-set",
      reviewedCount: 3,
      corpusFileCount: 824,
      deferredPaths: ["docs/d.md", "docs/e.md", "docs/home/index.md"],
      anchorPaths: [],
      scopeSha256: "5".repeat(64),
      reviewRevision: HEAD,
      accounting: {
        radiusSha256: "5".repeat(64),
        radiusPageCount: 6,
        listedPageCount: 6,
        unlistedPageCount: 0,
        unreviewableNeighbourCount: 0,
        changedPathCount: null,
        continuationCharacterLimit: 2_048,
      },
      canonSha256: canon,
      templateCoverage: {
        reportDigest: null,
        pages: ["docs/a.md", "docs/page.md", "docs/c.md"].map((path) => ({
          path,
          mapping: "unknown",
          applicability: "unknown",
          reason: "No retained template audit covered this page.",
          templateId: null,
          conformance: "unknown",
          rules: [],
          suggestionIds: [],
          rubric: {
            status: "unknown",
            reason: "Selected rubric evidence is unavailable for this review run.",
          },
        })),
      },
    });
    expect(JSON.stringify(withCanon)).not.toContain("/tmp/");
    // The sealed result round-trips through the destination-neutral decoder.
    expect(decodeReviewResult(JSON.parse(JSON.stringify(withCanon)))).toEqual(withCanon);
    const continuation = `cas:${"a".repeat(32)}:${"b".repeat(64)}`;
    expect(
      hostedReviewResultFromRun(focused, binding, undefined, canon, continuation).reviewScope
        ?.continuationLocator,
    ).toBe(continuation);
    // Without a digest the block says so; the note then prints no command.
    expect(reviewResultFromRun(focused, binding).reviewScope).toMatchObject({ canonSha256: null });
    expect(reviewCoverageFromRun(focused, undefined)).toMatchObject({ reviewedCount: 3 });
    expect(() => reviewCoverageFromRun(focused, "not-a-digest")).toThrow(/64 lowercase hex/u);
    // A documentation-set run carries no block.
    const plain = reviewResultFromRun(record(), binding);
    expect(Object.hasOwn(plain, "reviewScope")).toBe(false);
    expect(reviewCoverageFromRun(record())).toBeUndefined();
    expect(JSON.stringify(plain)).not.toContain("reviewScope");
    // The closed-shape validator rejects an inconsistent block wherever the result is sealed or decoded.
    expect(() =>
      createReviewResult(binding.target, {
        ...reviewResultInputFromRun(focused, binding),
        reviewScope: {
          ...withCanon.reviewScope!,
          corpusFileCount: 4,
          deferredPaths: ["docs/d.md", "docs/e.md"],
          accounting: {
            ...withCanon.reviewScope!.accounting,
            listedPageCount: 5,
            radiusPageCount: 5,
          },
        },
      }),
    ).toThrow(/invalid-value/u);
    expect(() =>
      createReviewResult(binding.target, {
        ...reviewResultInputFromRun(focused, binding),
        reviewScope: {
          ...withCanon.reviewScope!,
          corpusFileCount: null,
          deferredPaths: ["/Users/operator/docs/d.md"],
          accounting: {
            ...withCanon.reviewScope!.accounting,
            listedPageCount: 4,
            radiusPageCount: 4,
          },
        },
      }),
    ).toThrow(/invalid-value/u);
    // Beyond an absolute path, a parent or empty segment and any character
    // that would break a comma-joined `target=` list in a code span (comma,
    // whitespace, backtick, control character) are refused as invalid-value.
    for (const page of [
      "docs/../d.md",
      "docs//d.md",
      "docs/a,b.md",
      "docs/a b.md",
      "docs/a`b.md",
      "docs/a\x01b.md",
    ]) {
      expect(() =>
        createReviewResult(binding.target, {
          ...reviewResultInputFromRun(focused, binding),
          reviewScope: {
            ...withCanon.reviewScope!,
            corpusFileCount: null,
            deferredPaths: [page],
            accounting: {
              ...withCanon.reviewScope!.accounting,
              listedPageCount: 4,
              radiusPageCount: 4,
            },
          },
        }),
      ).toThrow(/invalid-value/u);
    }
    expect(() =>
      createReviewResult(binding.target, {
        ...reviewResultInputFromRun(focused, binding),
        reviewScope: {
          ...withCanon.reviewScope!,
          reviewedCount: -1,
          corpusFileCount: null,
          deferredPaths: ["docs/d.md"],
          accounting: {
            ...withCanon.reviewScope!.accounting,
            listedPageCount: 0,
            radiusPageCount: 0,
          },
        },
      }),
    ).toThrow(/invalid-value/u);
    expect(() =>
      decodeReviewResult({
        ...JSON.parse(JSON.stringify(withCanon)),
        reviewScope: { ...withCanon.reviewScope, deferredPaths: ["docs/d.md", "docs/d.md"] },
      }),
    ).toThrow(/invalid-value/u);
  });

  it("names each deferred page and why in the posted review's skipped-files block", () => {
    // The gap this closes: a focused review's own scope computation could
    // already defer a page over its page budget (see the coverage test's
    // `deferredPaths` fixture above), but nothing ever told the posted
    // GitLab note -- `skippedPaths` stayed permanently empty, even though
    // the host's own note renderer (review-summary/contracts.ts) already
    // has a "Skipped files" section ready to print it.
    const binding = bindCommentExistingMrTarget(observed(), "review-documentation", 0);
    const focused = record({
      reviewScope: {
        scope: "focused-set",
        reason: "operator-named",
        targetPaths: ["docs/a.md", "docs/page.md", "docs/c.md"],
        deferredPaths: ["docs/d.md", "docs/e.md", "docs/home/index.md"],
        anchorPaths: [],
        scopeSha256: "5".repeat(64),
        corpusFileCount: 824,
      },
    });
    const result = reviewResultFromRun(focused, binding);
    const deferralReason =
      "Deferred before review: the review's own page budget (size, tool calls, and time) " +
      "ran out before reaching this page.";
    expect(result.skippedPaths).toEqual([
      { path: "docs/d.md", reason: deferralReason },
      { path: "docs/e.md", reason: deferralReason },
      { path: "docs/home/index.md", reason: deferralReason },
    ]);
    // The sealed result round-trips through the destination-neutral decoder.
    expect(decodeReviewResult(JSON.parse(JSON.stringify(result)))).toEqual(result);
    // A scope with nothing deferred, and a documentation-set run with no
    // scope block at all, both carry no `skippedPaths` key -- distinct from
    // an empty array, matching how `reviewScope` itself stays absent.
    const nothingDeferred = record({
      reviewScope: {
        scope: "focused-set",
        reason: "operator-named",
        targetPaths: ["docs/a.md"],
        deferredPaths: [],
        anchorPaths: [],
        scopeSha256: "6".repeat(64),
        corpusFileCount: 824,
      },
    });
    expect(Object.hasOwn(reviewResultFromRun(nothingDeferred, binding), "skippedPaths")).toBe(
      false,
    );
    expect(Object.hasOwn(reviewResultFromRun(record(), binding), "skippedPaths")).toBe(false);
  });

  it("fails closed when the run does not match the frozen workflow or lacks its report", () => {
    const binding = bindCommentExistingMrTarget(observed(), "review-documentation", 0);
    expect(() =>
      reviewResultFromRun(record({ workflow: "update-documentation" }), binding),
    ).toThrow(/workflow does not match/u);
    expect(() =>
      reviewResultFromRun(record({ workflow: "review-documentation", steps: [] }), binding),
    ).toThrow(/missing-report/u);
  });

  it("still posts every other step's findings when evaluate-document-quality declined, instead of refusing the whole review", () => {
    // No `qualityPack` / `qualityProfileSelection` / `qualityArtifactValidation`
    // at all -- the correction round's decline (quality-correction-round.ts)
    // never re-admits, so none of them is ever set. This is distinct from the
    // adjacent `steps: []` case just above (truly nothing ran): here the step
    // ran, succeeded, and named exactly why it has no structured report.
    const declined: RunRecord = {
      schemaVersion: 2,
      id: "run-test-declined",
      workflow: "review-documentation",
      repository: { sourcePath: "/tmp/example", requestedRevision: HEAD, revision: HEAD },
      workspace: { strategy: "tracked-export", disposable: true },
      status: "succeeded",
      createdAt: "2026-08-21T12:00:00.000Z",
      models: [],
      skills: [],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0 },
      tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
      steps: [
        {
          id: "audit-documentation",
          title: "Audit documentation",
          kind: "evaluate",
          skill: "audit-documentation",
          mode: "read-only",
          status: "succeeded",
          summary: JSON.stringify({ verdict: "pass", issues: [] }),
        },
        {
          id: "evaluate-document-quality",
          title: "Evaluate document quality",
          kind: "evaluate",
          skill: "evaluate-document-quality",
          mode: "read-only",
          status: "succeeded",
          summary: `${qualityReport()}\n\n---\n\n${declinedQualityReportNote(1, "evaluation-schema-enum")}`,
        },
      ],
      changes: {
        files: [{ path: "docs/page.md", status: "modified" }],
        patch: {
          sha256: IDENTITY,
          byteLength: HEAD.length,
          lineCount: 4,
          artifactPath: "/tmp/run.patch",
          format: "git-diff",
        },
      },
    };
    const binding = bindCommentExistingMrTarget(observed(), "review-documentation", 0);
    expect(projectQualityReportFromRun(declined)).toBeNull();
    expect(inspectQualityReportFromRun(declined)).toEqual({ quality: null });
    const result = reviewResultFromRun(declined, binding);
    expect(Object.hasOwn(result, "qualityReport")).toBe(false);
    expect(result.checks).toEqual(
      expect.arrayContaining([
        { id: "check:audit-documentation", name: "Audit documentation", status: "passed" },
        {
          id: "check:evaluate-document-quality",
          name: "Evaluate document quality",
          status: "passed",
        },
      ]),
    );
    // The sealed result round-trips through the destination-neutral decoder,
    // same as the decline-free path above.
    expect(decodeReviewResult(JSON.parse(JSON.stringify(result)))).toEqual(result);
  });

  it("labels an unproven quality report only when the hosted note opts in; the CLI still refuses (#2197)", () => {
    const binding = bindCommentExistingMrTarget(observed(), "review-documentation", 0);
    const label = { unprovenQualityReport: "label" } as const;
    // The hosted pilot's run shapes: a structured summary with no validated
    // evidence beside it, no structured summary at all, and no evaluate step.
    const unvalidated = record();
    delete unvalidated.qualityProfileSelection;
    delete unvalidated.qualityArtifactValidation;
    const unstructured = record();
    unstructured.steps = [{ ...unstructured.steps[0]!, summary: "Quality evaluation finished." }];
    delete unstructured.qualityProfileSelection;
    delete unstructured.qualityArtifactValidation;
    const unevaluated = record({ steps: [] });
    for (const [run, code] of [
      [unvalidated, "invalid-report"],
      [unstructured, "missing-report"],
      [unevaluated, "missing-report"],
    ] as const) {
      const refusal = expect.objectContaining({ name: "QualityReportProjectionError", code });
      expect(() => hostedReviewResultFromRun(run, binding)).toThrowError(refusal);
      expect(() =>
        hostedReviewResultFromRun(run, binding, undefined, undefined, undefined, {
          unprovenQualityReport: "refuse",
        }),
      ).toThrowError(refusal);
      expect(() => reviewResultFromRun(run, binding)).toThrowError(refusal);
      const labelled = hostedReviewResultFromRun(
        run,
        binding,
        undefined,
        undefined,
        undefined,
        label,
      );
      expect(labelled.schemaVersion).toBe(1);
      expect(Object.hasOwn(labelled, "qualityReport")).toBe(false);
      expect(labelled.checks).toContainEqual({
        id: "check:quality-report-unavailable",
        name: `Quality report unavailable: this hosted run carries no validated quality evidence (${code})`,
        status: "skipped",
      });
      expect(decodeReviewResult(JSON.parse(JSON.stringify(labelled)))).toEqual(labelled);
    }
    // Validated evidence keeps its quality section and earns no label.
    const validated = hostedReviewResultFromRun(
      record(),
      binding,
      undefined,
      undefined,
      undefined,
      label,
    );
    expect(validated.schemaVersion).toBe(2);
    expect(validated.checks.map((check) => check.id)).not.toContain(
      "check:quality-report-unavailable",
    );
    // A gap the caller already knows about is one skipped check.
    const gap = {
      id: "check:review-continuation-unavailable",
      name: "Continuation link unavailable: plan canon differs from the registered canon",
    };
    const gapped = hostedReviewResultFromRun(record(), binding, undefined, undefined, undefined, {
      skippedChecks: [gap],
    });
    expect(gapped.checks).toContainEqual({ ...gap, status: "skipped" });
    // Nothing but an unproven quality report is labelled away.
    expect(() =>
      hostedReviewResultFromRun(
        record({ workflow: "update-documentation" }),
        binding,
        undefined,
        undefined,
        undefined,
        label,
      ),
    ).toThrow(/workflow does not match/u);
  });

  it("retries once on head drift as a new lineage and then returns mr-head-changed", async () => {
    const binding = bindCommentExistingMrTarget(observed(), "review-documentation", 0);
    const retryPort = fakePort({
      heads: [OTHER_HEAD],
      project: async () => {
        throw Object.assign(new Error("Review summary rejected: mr-head-changed."), {
          code: "mr-head-changed",
        });
      },
    });
    await expect(
      postCommentExistingMrReviewSummary(
        retryPort,
        binding,
        record(),
        { kind: "iid", mergeRequestIid: 88 },
        "/tmp/example",
        false,
      ),
    ).rejects.toBeInstanceOf(CommentExistingMrHeadChangedError);
    const next = bindCommentExistingMrTarget(
      observed({ headSha: OTHER_HEAD }),
      "review-documentation",
      1,
    );
    expect(next.generation).toBe(1);
    expect(next.target.logicalRequestId).toBe("cli-comment:review-documentation:437040:88:r1");
    expect(next.target.headSha).toBe(OTHER_HEAD);
    expect(next.target.logicalRequestId).not.toBe(binding.target.logicalRequestId);
    await expect(
      postCommentExistingMrReviewSummary(
        retryPort,
        next,
        record({
          repository: { ...record().repository, revision: OTHER_HEAD },
          steps: [
            {
              id: "evaluate-document-quality",
              title: "Evaluate document quality",
              kind: "evaluate",
              skill: "evaluate-document-quality",
              mode: "read-only",
              status: "succeeded",
              summary: qualityReport(OTHER_HEAD),
            },
          ],
        }),
        { kind: "iid", mergeRequestIid: 88 },
        "/tmp/example",
        true,
      ),
    ).rejects.toMatchObject({ code: "mr-head-changed" });
    expect(retryPort.mutations.mergeRequests).toBe(0);
  });
});
