// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { unassessedQualityEvaluation } from "./helpers/unassessed-quality-evaluation.js";

import { describe, expect, it } from "vitest";

import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../src/operator/json-evidence.js";
import {
  buildRunResultV1,
  decodeRunResultV1,
  serializeRunResultV1,
} from "../src/operator/run-result.js";
import {
  QUALITY_REPORT_FAILURES,
  inspectQualityReportFromRun,
  projectQualityReportFromRun,
  QualityReportProjectionError,
} from "../src/evaluation-report/contracts.js";
import {
  sealQualityValidationBinding,
  sealQualityValidatorReceipt,
} from "../src/evaluation-report/index.js";
import { canonicalDigest } from "../src/content-ir/canonical.js";
import { validateStagedQualityArtifact } from "../src/evaluation-report/quality-schema-validation.js";
import { projectReviewFindingsFromRun } from "../src/review/findings.js";
import {
  bindCommentExistingMrTarget,
  reviewResultFromRun,
  type ObservedMergeRequest,
} from "../src/cli/comment-existing-mr.js";
import type { RunRecord, StepRunRecord } from "../src/records/contracts.js";
import {
  createWorkflowOutcome,
  workflowOutcomeStepEvidence,
} from "../src/workflow-contracts/outcome.js";
import { configureCredential } from "./helpers/configured-credential.js";
import { verificationResultFixture } from "./helpers/verification.js";

const REVISION = "a".repeat(40);
const EVALUATION_RECORD = "1".repeat(64);
const SCORE_RECORD = "2".repeat(64);
const EVALUATOR_IDENTITY = "3".repeat(64);
const PACK_BINDING = "4".repeat(64);

function qualitySummary(limitation: string, hardGateFailures: string[] = []): string {
  const summary = {
    report_contract: "docsfab-quality-report-v0.1",
    target: {
      paths: ["docs/guide.md"],
      repository_revision: REVISION,
      documentation_revision: REVISION,
    },
    profile: { id: "docsfab-documentation-quality", version: "v0.1" },
    evaluation: {
      decision: hardGateFailures.length > 0 ? "fail" : "pass",
      confidence: 0.9,
      hard_gate_failures: hardGateFailures,
    },
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
      quality_report: "run:run-outer-agent:evaluate-document-quality:quality-report",
    },
  };
  return [
    "# Documentation quality evaluation report",
    "",
    "## Validated result summary",
    "",
    "```json",
    JSON.stringify(summary),
    "```",
    "",
    "## Evidence gaps and limitations",
    "",
    `- Limitation: ${limitation}`,
  ].join("\n");
}

function record(): RunRecord {
  const issue = (
    id: string,
    severity: "critical" | "major",
    location: string,
    finding: string,
  ) => ({
    id,
    severity,
    category: "technical_accuracy",
    location,
    finding,
    evidence: { source_id: "source-1", locator: "docs/guide.md:12" },
    required_change: "Update the affected documentation.",
  });
  const result: RunRecord = {
    schemaVersion: 2,
    id: "run-outer-agent",
    workflow: "review-documentation",
    repository: { sourcePath: "/tmp/repository", requestedRevision: "HEAD", revision: REVISION },
    workspace: { strategy: "tracked-export", disposable: true },
    status: "succeeded",
    createdAt: "2026-09-10T00:00:00.000Z",
    models: [],
    skills: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0 },
    tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
    steps: [
      {
        id: "verify-technical-accuracy",
        title: "Verify",
        skill: "verify-technical-accuracy",
        mode: "read-only",
        status: "succeeded",
        summary: canonicalizeJsonEvidence({
          verdict: "needs-revision",
          issues: [issue("TECH-001", "critical", "docs/guide.md:12", "The command is incorrect.")],
        }),
      },
      {
        id: "review-documentation",
        title: "Review",
        skill: "review-documentation",
        mode: "read-only",
        status: "succeeded",
        summary: canonicalizeJsonEvidence({
          verdict: "needs-revision",
          issues: [issue("EDIT-001", "major", "docs/guide.md:18", "The explanation is unclear.")],
        }),
      },
      {
        id: "evaluate-document-quality",
        title: "Evaluate",
        skill: "evaluate-document-quality",
        mode: "read-only",
        status: "succeeded",
        summary: qualitySummary("x".repeat(530)),
      },
    ],
  };
  bindQualityEvidence(result);
  const evidence = workflowOutcomeStepEvidence(result, "evaluate-document-quality");
  result.workflowOutcome = createWorkflowOutcome(
    {
      disposition: "inconclusive",
      findings: [
        {
          id: "finding:workflow",
          kind: "evidence-limitation",
          severity: "warning",
          code: "review-required",
          evidenceIds: [evidence.id],
        },
      ],
      evidence: [evidence],
      limitations: ["review-required"],
      openDecisions: [],
      producedArtifacts: [],
    },
    result,
  );
  return result;
}

function withStepSummary(recordValue: RunRecord, skill: string, summary: string): RunRecord {
  const hasStep = recordValue.steps.some((step) => step.skill === skill);
  const addedStep: StepRunRecord = {
    id: skill,
    title: skill,
    skill,
    mode: "read-only",
    status: "succeeded",
    summary,
  };
  const updated: RunRecord = {
    ...recordValue,
    steps: hasStep
      ? recordValue.steps.map((step) => (step.skill === skill ? { ...step, summary } : step))
      : [...recordValue.steps, addedStep],
  };
  if (skill === "evaluate-document-quality") bindQualityEvidence(updated);
  return updated;
}

function bindQualityEvidence(recordValue: RunRecord): RunRecord {
  const evaluator = recordValue.steps.find((step) => step.skill === "evaluate-document-quality");
  if (!evaluator?.summary) return recordValue;
  const selectionBody = {
    workflow: "review-documentation" as const,
    selectorId: "review-documentation:docsfab-documentation-quality:v1" as const,
    workflowSourceSha256: "4".repeat(64),
    repositoryIdentitySha256: createHash("sha256").update("/tmp/repository").digest("hex"),
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

function expectInvalidQualityReport(recordValue: RunRecord): void {
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
}

function rebindEvaluatorMarkdown(recordValue: RunRecord, markdown: string): void {
  const validation = recordValue.qualityArtifactValidation!;
  const reportReceipt = validation.validators.reportBinding!;
  const payloadSha256 = createHash("sha256").update(markdown, "utf8").digest("hex");
  const evaluator = recordValue.steps.find((step) => step.skill === "evaluate-document-quality")!;
  evaluator.summary = markdown;
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

describe("outer-agent RunResultV1 contract", () => {
  it("decodes legacy envelopes and rejects malformed findings availability", () => {
    const result = buildRunResultV1({
      record: record(),
      recordPath: "/tmp/run.json",
      exitCode: 0,
      repositoryPath: "/tmp/repository",
    });
    const legacy = structuredClone(result) as Record<string, unknown>;
    delete legacy.reviewFindingsProjection;
    expect(decodeRunResultV1(legacy).reviewFindingsProjection).toBeUndefined();

    expect(() =>
      decodeRunResultV1({
        ...structuredClone(result),
        reviewFindingsProjection: {
          ...result.reviewFindingsProjection,
          availability: "empty",
        },
      }),
    ).toThrow("invalid review findings projection");
    expect(() =>
      decodeRunResultV1({
        ...structuredClone(result),
        reviewFindings: [{ id: "unsafe" }],
      }),
    ).toThrow();
  });

  it("keeps the envelope and truncates an overlong quality limitation", () => {
    const result = buildRunResultV1({
      record: record(),
      recordPath: "/tmp/run.json",
      exitCode: 0,
      repositoryPath: "/tmp/repository",
    });
    expect(result.kind).toBe("docsfab-run-result");
    expect(result.quality).not.toBeNull();
    expect(result.quality?.limitations).toContain("truncated-projection-field");
    expect(result.quality?.limitations.find((value) => value.startsWith("xxx"))).toHaveLength(512);
    expect(JSON.parse(serializeRunResultV1(result)).kind).toBe("docsfab-run-result");
  });

  it.each(["create-documentation", "update-documentation"] as const)(
    "reports unavailable validation for advisory quality in %s without changing execution",
    (workflow) => {
      const current = record();
      current.workflow = workflow;
      delete current.workflowOutcome;
      delete current.qualityProfileSelection;
      delete current.qualityArtifactValidation;
      const result = buildRunResultV1({
        record: current,
        recordPath: "/tmp/run.json",
        exitCode: 0,
        repositoryPath: "/tmp/repository",
      });
      expect(result.quality).toBeNull();
      expect(result.execution.status).toBe("succeeded");
      expect(result.execution.exitCode).toBe(0);
      expect(result.product.limitations).toContain("quality-validation-unavailable");
      expect(decodeRunResultV1(JSON.parse(serializeRunResultV1(result)))).toEqual(result);
      expect(inspectQualityReportFromRun(current)).toEqual({
        quality: null,
        limitation: "quality-validation-unavailable",
      });
    },
  );

  it("distinguishes missing authoring evaluation without trusting a claimed host decline", () => {
    const current = record();
    current.workflow = "create-documentation";
    delete current.workflowOutcome;
    delete current.qualityProfileSelection;
    delete current.qualityArtifactValidation;
    current.steps = current.steps.filter((step) => step.skill !== "evaluate-document-quality");
    expect(inspectQualityReportFromRun(current)).toEqual({
      quality: null,
      limitation: "quality-evaluator-not-run",
    });
    current.steps.push({
      id: "evaluate-document-quality",
      title: "Evaluate",
      skill: "evaluate-document-quality",
      mode: "read-only",
      status: "succeeded",
      summary: "Host report decline: candidate quality artifacts failed validation.",
    });
    expect(inspectQualityReportFromRun(current)).toEqual({
      quality: null,
      limitation: "quality-validation-unavailable",
    });
    current.status = "needs-input";
    current.steps = [];
    expect(inspectQualityReportFromRun(current)).toEqual({ quality: null });
  });

  it("lifts sealed technical and editorial issues while retaining workflow codes", () => {
    const current = record();
    const result = buildRunResultV1({
      record: current,
      recordPath: "/tmp/run.json",
      exitCode: 0,
      repositoryPath: "/tmp/repository",
    });
    expect(result.product.findings).toEqual(["review-required"]);
    expect(result.reviewFindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "TECH-001",
          severity: "error",
          path: "docs/guide.md",
          evidence: expect.any(String),
          recommendation: expect.any(String),
        }),
        expect.objectContaining({ code: "EDIT-001", severity: "warning", path: "docs/guide.md" }),
      ]),
    );
    const observed: ObservedMergeRequest = {
      host: "gitlab.example.com",
      projectId: 437040,
      mergeRequestIid: 88,
      sourceBranch: "topic",
      targetBranch: "main",
      headSha: REVISION,
      requestIdentitySha256: "b".repeat(64),
      proofStatus: "current",
    };
    const review = reviewResultFromRun(
      current,
      bindCommentExistingMrTarget(observed, "review-documentation", 0),
    );
    expect(review.findings.map((finding) => finding.code)).toEqual(
      expect.arrayContaining(["TECH-001", "EDIT-001"]),
    );
    expect(result.reviewFindings?.map((finding) => finding.code)).toEqual(
      review.findings.map((finding) => finding.code),
    );
    expect(
      review.findings.every((finding) => !finding.summary.startsWith("Workflow finding:")),
    ).toBe(true);
  });

  it("projects the admitted technical wrapper without treating arbitrary review keys as findings", () => {
    const current = record();
    const technicalStep = current.steps.find((step) => step.id === "verify-technical-accuracy")!;
    const legacyReview = JSON.parse(technicalStep.summary!) as Record<string, unknown>;
    technicalStep.summary = canonicalizeJsonEvidence({
      coverage: [
        {
          evidence: ["src/cli.ts:42"],
          path: "docs/guide.md",
          reason: "Compared the command with the option parser.",
          status: "verified",
        },
      ],
      review: legacyReview,
    });
    current.reviewScope = {
      scope: "focused-set",
      reason: "operator-named",
      targetPaths: ["docs/guide.md"],
      deferredPaths: [],
      scopeSha256: "d".repeat(64),
      corpusFileCount: 1,
    };

    const projected = projectReviewFindingsFromRun(current);
    expect(projected.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "finding:verify-technical-accuracy:TECH-001:1",
          code: "TECH-001",
          path: "docs/guide.md",
          line: 12,
        }),
      ]),
    );

    technicalStep.summary = canonicalizeJsonEvidence({
      review: legacyReview,
      unrelated: [],
    });
    const arbitrary = projectReviewFindingsFromRun(current);
    expect(arbitrary.findings.map((finding) => finding.code)).not.toContain("TECH-001");
    expect(arbitrary.limitations).toContain(
      "review-findings-invalid:verify-technical-accuracy:schema",
    );
  });

  it("keeps admitted human-review and unverified coverage from becoming a complete zero", () => {
    const current = record();
    current.reviewScope = {
      scope: "focused-set",
      reason: "operator-named",
      targetPaths: ["docs/guide.md"],
      deferredPaths: [],
      scopeSha256: "f".repeat(64),
      corpusFileCount: 1,
    };
    current.steps = current.steps
      .filter((step) => step.skill !== "evaluate-document-quality")
      .map((step) =>
        step.skill === "verify-technical-accuracy"
          ? {
              ...step,
              summary: canonicalizeJsonEvidence({
                coverage: [
                  {
                    evidence: [],
                    path: "docs/guide.md",
                    reason: "The required implementation source was unavailable.",
                    status: "unverified",
                  },
                ],
                review: { issues: [], verdict: "human-review" },
              }),
            }
          : {
              ...step,
              summary: canonicalizeJsonEvidence({ issues: [], verdict: "human-review" }),
            },
      );

    const projected = projectReviewFindingsFromRun(current);
    expect(projected).toMatchObject({ availability: "partial", findings: [] });
    expect(projected.limitations).toEqual(
      expect.arrayContaining([
        "review-findings-human-review:verify-technical-accuracy",
        "review-findings-coverage-unverified:verify-technical-accuracy:docs/guide.md",
        "review-findings-human-review:review-documentation",
      ]),
    );
  });

  it("keeps rejected findings invalid when an admitted source also requires human review", () => {
    const current = record();
    const editorial = current.steps.find((step) => step.skill === "review-documentation")!;
    current.steps = [
      {
        ...editorial,
        summary: canonicalizeJsonEvidence({
          issues: [
            {
              id: "EDIT-009",
              severity: "major",
              category: "source_grounding",
              location: "docs/guide.md:18",
              finding: "The only claimed evidence is https://example.invalid/source.",
              evidence: { source_id: "source-9", locator: "docs/guide.md:18" },
              required_change: "Replace the claim with admitted local evidence.",
            },
          ],
          verdict: "human-review",
        }),
      },
    ];

    const projected = projectReviewFindingsFromRun(current);
    expect(projected).toMatchObject({ availability: "invalid", findings: [] });
    expect(projected.limitations).toEqual(
      expect.arrayContaining([
        "review-findings-human-review:review-documentation",
        "review-findings-invalid:review-documentation:1",
      ]),
    );
  });

  it("rejects technical wrapper coverage that does not match retained focused scope", () => {
    const current = record();
    const technicalStep = current.steps.find((step) => step.id === "verify-technical-accuracy")!;
    const legacyReview = JSON.parse(technicalStep.summary!) as Record<string, unknown>;
    technicalStep.summary = canonicalizeJsonEvidence({
      review: legacyReview,
      coverage: [
        {
          path: "docs/other.md",
          status: "verified",
          evidence: ["src/cli.ts:42"],
          reason: "Compared the command with the option parser.",
        },
      ],
    });
    current.reviewScope = {
      scope: "focused-set",
      reason: "operator-named",
      targetPaths: ["docs/guide.md"],
      deferredPaths: [],
      scopeSha256: "e".repeat(64),
      corpusFileCount: 1,
    };

    const projected = projectReviewFindingsFromRun(current);
    expect(projected.findings.map((finding) => finding.code)).not.toContain("TECH-001");
    expect(projected.findings.map((finding) => finding.code)).toContain("EDIT-001");
    expect(projected.limitations).toContain(
      "review-findings-invalid:verify-technical-accuracy:schema",
    );
  });

  it("retains canonical review findings from an authoring workflow", () => {
    const current = record();
    current.workflow = "create-documentation";
    current.steps = [current.steps[0]!];
    delete current.workflowOutcome;
    delete current.qualityArtifactValidation;
    delete current.qualityProfileSelection;
    delete current.qualityPack;

    const result = buildRunResultV1({
      record: current,
      recordPath: "/tmp/run.json",
      exitCode: 0,
      repositoryPath: "/tmp/repository",
    });
    expect(result.reviewFindings?.map((finding) => finding.code)).toEqual(["TECH-001"]);
    expect(result.reviewFindingsProjection).toBeUndefined();
  });

  it("projects the current typed verification envelope through the public result", () => {
    const verification = verificationResultFixture(["docs/guide.md"]);
    verification.review = {
      verdict: "needs-revision",
      issues: [
        {
          id: "TECH-001",
          severity: "critical",
          category: "technical_accuracy",
          location: "docs/guide.md:12",
          finding: "The command is incorrect.",
          evidence: { source_id: "source-1", locator: "docs/guide.md:12" },
          required_change: "Update the affected documentation.",
        },
      ],
    };
    const current = withStepSummary(
      record(),
      "verify-technical-accuracy",
      canonicalizeJsonEvidence(verification),
    );
    const result = buildRunResultV1({
      record: current,
      recordPath: "/tmp/run.json",
      exitCode: 0,
      repositoryPath: "/tmp/repository",
    });

    expect(result.reviewFindings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "TECH-001" })]),
    );
  });
  it.each(["missing-coverage", "duplicate-coverage", "noncanonical"] as const)(
    "rejects hostile verification envelope: %s",
    (variant) => {
      const review: JsonEvidenceValue = {
        verdict: "needs-revision",
        issues: [
          {
            id: "TECH-001",
            severity: "critical",
            category: "technical_accuracy",
            location: "docs/guide.md:12",
            finding: "The command is incorrect.",
            evidence: { source_id: "source-1", locator: "docs/guide.md:12" },
            required_change: "Update the affected documentation.",
          },
        ],
      };
      const envelope = structuredClone(
        verificationResultFixture(["docs/guide.md"]),
      ) as unknown as Record<string, JsonEvidenceValue>;
      envelope.review = review;
      const coverage = (envelope.coverage as JsonEvidenceValue[])[0]!;
      if (variant === "missing-coverage") delete envelope.coverage;
      if (variant === "duplicate-coverage") envelope.coverage = [coverage, coverage];
      const summary =
        variant === "noncanonical" ? JSON.stringify(envelope) : canonicalizeJsonEvidence(envelope);
      const result = buildRunResultV1({
        record: withStepSummary(record(), "verify-technical-accuracy", summary),
        recordPath: "/tmp/run.json",
        exitCode: 0,
        repositoryPath: "/tmp/repository",
      });
      expect(result.reviewFindings).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ code: "TECH-001" })]),
      );
      expect(result.product.limitations).toContain(
        variant === "noncanonical"
          ? "review-findings-unparsed:verify-technical-accuracy"
          : "review-findings-invalid:verify-technical-accuracy:schema",
      );
    },
  );
  it("names a path under the run's checkout repository-relative in a review result", () => {
    const base = record();
    const checkout = base.repository.sourcePath;
    const summary = canonicalizeJsonEvidence({
      verdict: "needs-revision",
      issues: [
        {
          id: "TECH-001",
          severity: "major",
          category: "technical_accuracy",
          location: "docs/guide.md:12",
          finding: `Run ${checkout}/scripts/build.sh before the documented command.`,
          evidence: { source_id: "source-1", locator: "docs/guide.md:12" },
          required_change: "Update the affected documentation.",
        },
      ],
    });
    const observed: ObservedMergeRequest = {
      host: "gitlab.example.com",
      projectId: 437040,
      mergeRequestIid: 88,
      sourceBranch: "topic",
      targetBranch: "main",
      headSha: REVISION,
      requestIdentitySha256: "b".repeat(64),
      proofStatus: "current",
    };
    const comment = reviewResultFromRun(
      withStepSummary(base, "verify-technical-accuracy", summary),
      bindCommentExistingMrTarget(observed, "review-documentation", 0),
    );
    expect(comment.findings.find((finding) => finding.code === "TECH-001")?.summary).toContain(
      "Run scripts/build.sh before the documented command.",
    );
    expect(JSON.stringify(comment)).not.toContain(checkout);
  });

  it("rejects unsafe or schema-invalid sealed findings without downgrading them", () => {
    // TECH-001 carries one of DocsFab's own configured credentials and is
    // refused. TECH-006 carries a value of the same shape that is not
    // configured, which is finding text like any other (#1807).
    const configured = configureCredential(["AKIA", "Q7W3E9R2T5Y8U4I6"].join(""));
    const shaped = ["AKIA", "M4N8B2V6C1X5Z9L3"].join("");
    const unsafe = canonicalizeJsonEvidence({
      verdict: "needs-revision",
      issues: [
        {
          id: "TECH-001",
          severity: "critical",
          category: "technical_accuracy",
          location: "docs/guide.md:12",
          finding: `safe prefix ${"x".repeat(520)}\n${configured}`,
          evidence: {
            source_id: "source-1",
            locator: "docs/guide.md:12",
          },
          required_change: "Update the affected documentation.",
        },
        {
          id: "TECH-002",
          severity: "major",
          category: "technical_accuracy",
          location: "docs/guide.md:12",
          // Documentation examples of credential keys, not credentials.
          finding:
            'The guide sets password: "changeme" and token = ${GITLAB_TOKEN}; the command is incorrect.',
          evidence: { source_id: "source-1", locator: "docs/guide.md:12" },
          required_change: "Update the affected documentation.",
        },
        {
          id: "TECH-003",
          severity: "major",
          category: "technical_accuracy",
          location: "docs/guide.md:12",
          finding: `safe prefix ${"x".repeat(520)}\n/private/tmp/reviewer-secret.txt`,
          evidence: { source_id: "source-1", locator: "docs/guide.md:12" },
          required_change: "Update the affected documentation.",
        },
        {
          id: "TECH-004",
          severity: "major",
          category: "technical_accuracy",
          location: "docs/guide.md:12",
          finding: `safe prefix ${"x".repeat(520)}\nHTTPS://example.invalid/evidence`,
          evidence: { source_id: "source-1", locator: "docs/guide.md:12" },
          required_change: "Update the affected documentation.",
        },
        {
          id: "TECH-005",
          severity: "major",
          category: "technical_accuracy",
          location: "docs/guide.md:12",
          finding: "The command is incorrect.",
          evidence: { source_id: "source-1", locator: "docs/guide.md:12" },
          required_change: `safe prefix ${"x".repeat(520)}\ndiff --git a/docs/guide.md b/docs/guide.md`,
        },
        {
          id: "TECH-006",
          severity: "major",
          category: "technical_accuracy",
          location: "docs/guide.md:12",
          finding: `The guide quotes ${shaped}; the command is incorrect.`,
          evidence: { source_id: "source-1", locator: "docs/guide.md:12" },
          required_change: "Update the affected documentation.",
        },
      ],
    });
    const current = withStepSummary(record(), "verify-technical-accuracy", unsafe);
    const result = buildRunResultV1({
      record: current,
      recordPath: "/tmp/run.json",
      exitCode: 0,
      repositoryPath: "/tmp/repository",
    });
    expect(result.reviewFindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "EDIT-001" }),
        expect.objectContaining({ code: "TECH-002" }),
        expect.objectContaining({ code: "TECH-006" }),
      ]),
    );
    expect(result.reviewFindings.find((finding) => finding.code === "TECH-006")?.summary).toContain(
      shaped,
    );
    expect(result.reviewFindings).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "TECH-001" })]),
    );
    expect(JSON.stringify(result)).not.toContain(configured);
    expect(result.product.limitations).toContain(
      "review-findings-invalid:verify-technical-accuracy:3",
    );
    const observed: ObservedMergeRequest = {
      host: "gitlab.example.com",
      projectId: 437040,
      mergeRequestIid: 88,
      sourceBranch: "topic",
      targetBranch: "main",
      headSha: REVISION,
      requestIdentitySha256: "b".repeat(64),
      proofStatus: "current",
    };
    const comment = reviewResultFromRun(
      current,
      bindCommentExistingMrTarget(observed, "review-documentation", 0),
    );
    expect(comment.findings.map((finding) => finding.code)).toEqual(
      expect.arrayContaining(["TECH-002", "EDIT-001"]),
    );
    expect(comment.findings.find((finding) => finding.code === "TECH-002")?.summary).toContain(
      'password: "changeme" and token = ${GITLAB_TOKEN}',
    );
    const malformedNested = canonicalizeJsonEvidence({
      verdict: "needs-revision",
      issues: [
        {
          id: "TECH-003",
          severity: "major",
          category: "technical_accuracy",
          location: "docs/guide.md:12",
          finding: "The command is incorrect.",
          evidence: { source_id: "source-1", locator: "docs/guide.md:12", extra: "reject" },
          required_change: "Update the affected documentation.",
        },
      ],
    });
    const nestedResult = projectReviewFindingsFromRun(
      withStepSummary(record(), "verify-technical-accuracy", malformedNested),
    );
    expect(nestedResult.findings).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "TECH-003" })]),
    );
    expect(nestedResult.limitations).toContain(
      "review-findings-invalid:verify-technical-accuracy:schema",
    );
  });

  it("bounds sealed finding count and input size with explicit limitations", () => {
    const issue = (index: number) => ({
      id: `TECH-${String(index).padStart(3, "0")}`,
      severity: "minor",
      category: "technical_accuracy",
      location: "docs/guide.md:12",
      finding: `Finding ${index}`,
      evidence: { source_id: "source-1", locator: "docs/guide.md:12" },
      required_change: "Update the affected documentation.",
    });
    const many = withStepSummary(
      record(),
      "verify-technical-accuracy",
      canonicalizeJsonEvidence({
        verdict: "needs-revision",
        issues: Array.from({ length: 300 }, (_, i) => issue(i)),
      }),
    );
    const bounded = projectReviewFindingsFromRun(many);
    expect(bounded.findings).toHaveLength(256);
    expect(bounded.limitations).toContain("review-findings-omitted:44");

    const oversized = withStepSummary(record(), "verify-technical-accuracy", "x".repeat(1_048_577));
    expect(projectReviewFindingsFromRun(oversized).limitations).toContain(
      "review-findings-input-too-large:verify-technical-accuracy",
    );

    const largeIssue = (index: number) => ({
      ...issue(index),
      finding: "f".repeat(500),
      required_change: "r".repeat(500),
      evidence: { source_id: "source-1", locator: "l".repeat(500) },
    });
    const aggregate = projectReviewFindingsFromRun(
      withStepSummary(
        record(),
        "verify-technical-accuracy",
        canonicalizeJsonEvidence({
          verdict: "needs-revision",
          issues: Array.from({ length: 300 }, (_, i) => largeIssue(i)),
        }),
      ),
    );
    expect(
      aggregate.limitations.some((value) => value.startsWith("review-findings-omitted-bytes:")),
    ).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(aggregate.findings), "utf8")).toBeLessThanOrEqual(
      131_072,
    );
  });

  it("keeps quality available when distinct long hard gates share a projection prefix", () => {
    const prefix = "x".repeat(509);
    const current = withStepSummary(
      record(),
      "evaluate-document-quality",
      qualitySummary("bounded", [`${prefix}-first`, `${prefix}-second`]),
    );
    const quality = projectQualityReportFromRun(current);
    expect(quality).not.toBeNull();
    expect(quality?.limitations).toContain("truncated-projection-field:2");
  });

  it("rejects absent, unsealed, substituted, digest-mismatched, or locator-mismatched quality evidence", () => {
    const absent = record();
    delete absent.qualityProfileSelection;
    delete absent.qualityArtifactValidation;
    expectInvalidQualityReport(absent);

    const unsealed = record();
    unsealed.qualityArtifactValidation = {
      ...unsealed.qualityArtifactValidation!,
      bindingSha256: "0".repeat(64),
    };
    expectInvalidQualityReport(unsealed);

    const substituted = record();
    substituted.qualityArtifactValidation = {
      ...substituted.qualityArtifactValidation!,
      repositoryRevision: "f".repeat(40),
    };
    expectInvalidQualityReport(substituted);

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
    expectInvalidQualityReport(digestMismatched);

    const locatorMismatched = record();
    rebindEvaluatorMarkdown(
      locatorMismatched,
      locatorMismatched.steps
        .find((step) => step.skill === "evaluate-document-quality")!
        .summary!.replace(`record:sha256:${EVALUATION_RECORD}`, `record:sha256:${"9".repeat(64)}`),
    );
    expectInvalidQualityReport(locatorMismatched);

    const forgedPass = record();
    forgedPass.steps = forgedPass.steps.map((step) =>
      step.skill === "evaluate-document-quality"
        ? { ...step, summary: "Quality evaluation: PASS" }
        : step,
    );
    delete forgedPass.qualityProfileSelection;
    delete forgedPass.qualityArtifactValidation;
    expect(inspectQualityReportFromRun(forgedPass)).toEqual({
      quality: null,
      error: QUALITY_REPORT_FAILURES["missing-report"],
    });
    expect(() => projectQualityReportFromRun(forgedPass)).toThrow(QualityReportProjectionError);
  });

  it("does not treat an invented lint envelope as sealed findings", () => {
    const lint = withStepSummary(
      record(),
      "lint-documentation",
      canonicalizeJsonEvidence({
        schemaVersion: 1,
        kind: "docsfab-lint-result",
        issues: [
          {
            code: "LINT-001",
            severity: "major",
            message: "The documentation is malformed.",
          },
        ],
      }),
    );
    const projected = projectReviewFindingsFromRun(lint);
    expect(projected.findings).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "LINT-001" })]),
    );
    expect(projected.limitations).toContain(
      "review-findings-schema-unavailable:lint-documentation",
    );
  });

  it("deduplicates repeated sealed findings for both result consumers", () => {
    const current = record();
    const original = current.steps[0]!;
    const duplicated: RunRecord = {
      ...current,
      steps: [...current.steps, { ...original, id: "verify-technical-accuracy-retry" }],
    };
    const projected = projectReviewFindingsFromRun(duplicated);
    expect(projected.findings.filter((finding) => finding.code === "TECH-001")).toHaveLength(1);
    expect(projected.limitations).toContain(
      "review-findings-duplicate:finding:verify-technical-accuracy:TECH-001:1",
    );

    const observed: ObservedMergeRequest = {
      host: "gitlab.example.com",
      projectId: 437040,
      mergeRequestIid: 88,
      sourceBranch: "topic",
      targetBranch: "main",
      headSha: REVISION,
      requestIdentitySha256: "b".repeat(64),
      proofStatus: "current",
    };
    const review = reviewResultFromRun(
      duplicated,
      bindCommentExistingMrTarget(observed, "review-documentation", 0),
    );
    expect(review.findings.filter((finding) => finding.code === "TECH-001")).toHaveLength(1);
  });

  it("retains distinct findings from alternate historical technical producers", () => {
    const current = record();
    const original = current.steps[0]!;
    const retried: RunRecord = {
      ...current,
      steps: [
        ...current.steps,
        {
          ...original,
          id: "verify-technical-accuracy-retry",
          summary: canonicalizeJsonEvidence({
            verdict: "needs-revision",
            issues: [
              {
                id: "TECH-002",
                severity: "major",
                category: "technical_accuracy",
                location: "docs/guide.md:24",
                finding: "The retried review found a second technical issue.",
                evidence: { source_id: "source-2", locator: "docs/guide.md:24" },
                required_change: "Correct the second technical issue.",
              },
            ],
          }),
        },
      ],
    };

    const projected = projectReviewFindingsFromRun(retried);
    expect(projected.findings.map((finding) => finding.code)).toEqual(
      expect.arrayContaining(["TECH-001", "TECH-002"]),
    );
  });

  it("retains a conflict limitation when a retry changes an existing finding id", () => {
    const current = record();
    const original = current.steps[0]!;
    const conflicting: RunRecord = {
      ...current,
      steps: [
        ...current.steps,
        {
          ...original,
          id: "verify-technical-accuracy-retry",
          summary: canonicalizeJsonEvidence({
            verdict: "needs-revision",
            issues: [
              {
                id: "TECH-001",
                severity: "minor",
                category: "technical_accuracy",
                location: "docs/guide.md:99",
                finding: "The retry supplied conflicting details for the same finding id.",
                evidence: { source_id: "source-2", locator: "docs/guide.md:99" },
                required_change: "Resolve the conflicting retry evidence.",
              },
            ],
          }),
        },
      ],
    };
    const projected = projectReviewFindingsFromRun(conflicting);
    expect(projected.findings.filter((finding) => finding.code === "TECH-001")).toHaveLength(1);
    expect(projected.limitations).toContain(
      "review-findings-duplicate:finding:verify-technical-accuracy:TECH-001:1",
    );

    const observed: ObservedMergeRequest = {
      host: "gitlab.example.com",
      projectId: 437040,
      mergeRequestIid: 88,
      sourceBranch: "topic",
      targetBranch: "main",
      headSha: REVISION,
      requestIdentitySha256: "b".repeat(64),
      proofStatus: "current",
    };
    const review = reviewResultFromRun(
      conflicting,
      bindCommentExistingMrTarget(observed, "review-documentation", 0),
    );
    expect(review.findings.filter((finding) => finding.code === "TECH-001")).toHaveLength(1);
    expect(review.findings.find((finding) => finding.code === "TECH-001")?.path).toBe(
      "docs/guide.md",
    );
  });
  it("validates RFC3339 dates on a freshly constructed quality evaluation", () => {
    const profile = JSON.parse(
      readFileSync(
        new URL("../quality/profiles/docsfab-documentation-quality/profile.json", import.meta.url),
        "utf8",
      ),
    );
    const fixture = unassessedQualityEvaluation(profile, REVISION, ["docs/local-example.md"]);
    expect(
      validateStagedQualityArtifact("documentation-quality-evaluation.schema.json", {
        ...fixture,
        evaluated_at: "2026-09-10t12:34:56z",
      }),
    ).toBe("valid");
    expect(
      validateStagedQualityArtifact("documentation-quality-evaluation.schema.json", {
        ...fixture,
        evaluated_at: "2026-04-30T23:59:60Z",
      }),
    ).toBe("invalid");
    expect(
      validateStagedQualityArtifact("documentation-quality-evaluation.schema.json", {
        ...fixture,
        evaluated_at: "2026-12-31T23:59:60Z",
      }),
    ).toBe("valid");
  });
});
