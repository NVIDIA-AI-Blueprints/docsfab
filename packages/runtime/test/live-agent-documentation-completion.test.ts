// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { canonicalDigest } from "../src/content-ir/canonical.js";
import {
  sealQualityValidationBinding,
  sealQualityValidatorReceipt,
} from "../src/evaluation-report/quality-artifact-staging.js";
import {
  loadQualityReportSummaryFixtures,
  qualityReportMarkdown,
} from "./helpers/quality-report-summary.js";

import {
  projectDocumentationWorkCompletion,
  type ProjectDocumentationWorkCompletionInputV1,
} from "../src/live-agent/documentation-work-completion.js";
import type { DocumentationWorkSelectionV1 } from "../src/live-agent/documentation-work-selection.js";
import type { LiveWorkflowRun } from "../src/live-agent/workflow-delivery.js";
import type { ReviewRunBinding } from "../src/review/run-result.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";

const REVISION = "a".repeat(40);
const SCOPE_DIGEST = "b".repeat(64);
const EVALUATION_RECORD = "1".repeat(64);
const SCORE_RECORD = "2".repeat(64);
const CANDIDATE_RECORD = "3".repeat(64);
const FINAL_RECORD = "4".repeat(64);
const EVALUATOR_IDENTITY = "5".repeat(64);
const PACK_BINDING = "6".repeat(64);
const PROFILE_PAYLOAD = "d425dd5c21b067ab67dbfdb6b06082b480769216a31e6df50a6341c1d8e62c01";

function selection(): DocumentationWorkSelectionV1 {
  return {
    kind: "workflow",
    requestIntent: null,
    workflowId: "review-documentation",
    basis: "documentation-specialist-default",
  };
}

function completeScope(overrides: Record<string, unknown> = {}) {
  return {
    scope: "focused-set",
    reason: "within-budget",
    targetPaths: ["docs/guide.md"],
    deferredPaths: [],
    scopeSha256: SCOPE_DIGEST,
    corpusFileCount: 1,
    accounting: {
      radiusSha256: SCOPE_DIGEST,
      radiusPageCount: 1,
      listedPageCount: 1,
      unlistedPageCount: 0,
      unreviewableNeighbourCount: 0,
      changedPathCount: 1,
      continuationCharacterLimit: 512,
    },
    ...overrides,
  };
}

function run(overrides: Record<string, unknown> = {}): LiveWorkflowRun {
  const workflow = getWorkflow("review-documentation");
  return {
    schemaVersion: 2,
    id: "run-doc-review",
    workflow: "review-documentation",
    repository: {
      sourcePath: "/workspace/repository",
      requestedRevision: REVISION,
      revision: REVISION,
    },
    workspace: { strategy: "tracked-export", disposable: true },
    status: "succeeded",
    createdAt: "2026-10-16T12:00:00.000Z",
    models: [],
    skills: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    tools: { total: 0, byName: {} },
    steps: workflow.steps.map((step) => ({
      id: step.id,
      title: step.title,
      skill: step.skill,
      mode: step.mode,
      status: "succeeded",
    })),
    reviewScope: completeScope(),
    ...overrides,
  } as unknown as LiveWorkflowRun;
}

function input(
  runRecord: LiveWorkflowRun,
  overrides: Partial<ProjectDocumentationWorkCompletionInputV1> = {},
): ProjectDocumentationWorkCompletionInputV1 {
  return { selection: selection(), run: runRecord, ...overrides };
}

function runWithCanonicalDocumentationResult(): LiveWorkflowRun {
  const base = run();
  const reportFixture = loadQualityReportSummaryFixtures().find(
    (fixture) => fixture.name === "available rubric with layered insufficient evidence",
  );
  if (!reportFixture) throw new Error("Canonical quality report fixture is missing.");
  const summary = structuredClone(reportFixture.summary);
  const target = summary.target as Record<string, unknown>;
  target.paths = ["docs/guide.md"];
  target.repository_revision = REVISION;
  target.documentation_revision = REVISION;
  const evaluationLocator = `record:sha256:${EVALUATION_RECORD}`;
  const scoreLocator = `record:sha256:${SCORE_RECORD}`;
  const locators = summary.artifact_locators as Record<string, unknown>;
  locators.evaluation = evaluationLocator;
  locators.quality_score = scoreLocator;
  locators.quality_report = `run:${base.id}:evaluate-document-quality:quality-report`;
  const markdown = qualityReportMarkdown(summary);
  const markdownSha256 = createHash("sha256").update(markdown, "utf8").digest("hex");

  const selectionBody = {
    workflow: "review-documentation" as const,
    selectorId: "review-documentation:docsfab-documentation-quality:v1" as const,
    workflowSourceSha256: EVALUATOR_IDENTITY,
    repositoryIdentitySha256: createHash("sha256").update(base.repository.sourcePath).digest("hex"),
    repositoryRevision: REVISION,
    inventorySha256: "7".repeat(64),
    targetScope: "documentation-set" as const,
    targetScopeSha256: "8".repeat(64),
    targetPathSetSha256: "9".repeat(64),
    applicabilitySha256: "a".repeat(64),
    documentCount: 1,
    qualityPackManifestSha256: "f".repeat(64),
    qualityPackBindingSha256: PACK_BINDING,
    skillLockSha256: "b".repeat(64),
    qualityLockSha256: "c".repeat(64),
    qualityBundleSha256: "d".repeat(64),
    profileBarId: "profile:docsfab-documentation-quality" as const,
    profileAssetPath: "profiles/docsfab-documentation-quality/profile.json" as const,
    profilePayloadSha256: PROFILE_PAYLOAD,
    profileId: "docsfab-documentation-quality" as const,
    profileVersion: "v0.1" as const,
    profileModel: "documentation-quality-model-v0.2" as const,
    profileStatus: "experimental" as const,
    releaseGateEligible: false as const,
  };
  const qualityProfileSelection = {
    schemaVersion: 1 as const,
    kind: "docsfab-quality-profile-selection-receipt" as const,
    ...selectionBody,
    selectionSha256: canonicalDigest({
      schemaVersion: 1,
      kind: "docsfab-quality-profile-selection-receipt",
      ...selectionBody,
    }),
  };
  const qualityArtifactValidation = sealQualityValidationBinding({
    runId: base.id,
    repositoryRevision: REVISION,
    selectionSha256: qualityProfileSelection.selectionSha256,
    qualityPackBindingSha256: PACK_BINDING,
    evaluatorIdentitySha256: EVALUATOR_IDENTITY,
    status: "passed",
    failureCode: null,
    artifacts: {
      evaluation: { recordSha256: EVALUATION_RECORD, payloadSha256: "e".repeat(64) },
      qualityScore: { recordSha256: SCORE_RECORD, payloadSha256: "f".repeat(64) },
      candidateReport: { recordSha256: CANDIDATE_RECORD, payloadSha256: markdownSha256 },
      finalReport: { recordSha256: FINAL_RECORD, payloadSha256: markdownSha256 },
    },
    validatorAssets: {
      evaluationScriptSha256: "65".padStart(64, "0"),
      evaluationSchemaSha256: "0".repeat(64),
      qualityScoreScriptSha256: "71".padStart(64, "0"),
      reportScriptSha256: "72".padStart(64, "0"),
    },
    validators: {
      evaluation: validatorReceipt("evaluation", ["e".repeat(64), "0".repeat(64), PROFILE_PAYLOAD]),
      qualityScore: validatorReceipt("quality-score", ["f".repeat(64)]),
      reportBinding: validatorReceipt("report-binding", [
        "e".repeat(64),
        markdownSha256,
        PROFILE_PAYLOAD,
        "f".repeat(64),
      ]),
    },
  });
  const steps = base.steps.map((step) =>
    step.skill === "evaluate-document-quality"
      ? {
          ...step,
          summary: markdown,
          evaluateEvidence: {
            schemaVersion: 1,
            kind: "docsfab-evaluate-step-evidence",
            evaluatorIdentitySha256: EVALUATOR_IDENTITY,
            toolPolicySha256: "1".repeat(64),
            acceptancePolicySha256: "2".repeat(64),
          },
        }
      : step,
  );

  return {
    ...base,
    steps,
    qualityPack: {
      schemaVersion: 1,
      id: "docsfab-default",
      version: "1.0.0",
      manifestSha256: "f".repeat(64),
      bindingSha256: PACK_BINDING,
      skillLockSha256: selectionBody.skillLockSha256,
      qualityLockSha256: selectionBody.qualityLockSha256,
      qualityBundleSha256: selectionBody.qualityBundleSha256,
      barIds: [selectionBody.profileBarId],
    },
    qualityProfileSelection,
    qualityArtifactValidation,
  } as unknown as LiveWorkflowRun;
}

function validatorReceipt(
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

describe("projectDocumentationWorkCompletion", () => {
  it("reports completion only after the selected workflow and complete documented scope ran", () => {
    const result = projectDocumentationWorkCompletion(input(runWithCanonicalDocumentationResult()));

    expect(result).toMatchObject({
      status: "completed",
      selectionKind: "workflow",
      workflow: "review-documentation",
      repositoryRevision: REVISION,
      documentationScope: {
        status: "complete",
        scopeSha256: SCOPE_DIGEST,
        reviewedPaths: ["docs/guide.md"],
        deferredPaths: [],
        reviewRevision: REVISION,
      },
      impactDisposition: "not-assessed",
      incidentalCodeFindings: { status: "not-assessed", count: null },
      documentationResult: { kind: "docsfab-quality-report-projection" },
    });
  });

  it("does not complete when a required workflow method did not execute", () => {
    const record = run({
      steps: run().steps.slice(1),
    });

    expect(projectDocumentationWorkCompletion(input(record))).toMatchObject({
      status: "partial",
      limitations: expect.arrayContaining(["workflow-step-incomplete"]),
      documentationScope: { status: "complete" },
    });
  });

  it("does not count a same-ID step with the wrong skill as the registered method", () => {
    const record = run({
      steps: run().steps.map((step, index) =>
        index === 0 ? { ...step, skill: "software-development" } : step,
      ),
    });

    expect(projectDocumentationWorkCompletion(input(record))).toMatchObject({
      status: "partial",
      limitations: expect.arrayContaining(["workflow-step-incomplete"]),
    });
  });

  it("does not treat a code-only answer or a loaded skill selection as documentation evidence", () => {
    const codeOnly = run({
      workflow: "update-documentation",
      steps: [
        {
          id: "build-site",
          title: "Build site",
          skill: "software-development",
          mode: "read",
          status: "succeeded",
        },
      ],
    });

    expect(projectDocumentationWorkCompletion(input(codeOnly))).toMatchObject({
      status: "partial",
      limitations: expect.arrayContaining(["workflow-mismatch"]),
    });

    const loadedSkillOnly: DocumentationWorkSelectionV1 = {
      kind: "skills",
      requestIntent: null,
      skillIds: [getWorkflow("review-documentation").steps[0]!.skill],
      basis: "documentation-specialist-default",
    };
    expect(
      projectDocumentationWorkCompletion({
        selection: loadedSkillOnly,
        run: run({ steps: [] }),
      }),
    ).toMatchObject({ status: "not-assessed", selectionKind: "skills" });
  });

  it("keeps same-workflow success and scope partial when the canonical documentation result is absent", () => {
    const result = projectDocumentationWorkCompletion(input(run()));
    expect(result).toMatchObject({
      status: "partial",
      documentationScope: { status: "complete" },
      limitations: expect.arrayContaining(["documentation-result-unavailable"]),
    });
    expect(result.documentationResult).toBeUndefined();
  });

  it("keeps a PR review partial until its exact source-bound review result is available", () => {
    const record = run({ changeSources: [{ changeSourceSha256: "c".repeat(64) }] });

    expect(
      projectDocumentationWorkCompletion(input(record, { pullRequestReviewExpected: true })),
    ).toMatchObject({
      status: "partial",
      limitations: expect.arrayContaining([
        "review-binding-unavailable",
        "review-result-unavailable",
      ]),
      repositoryRevision: REVISION,
    });
  });

  it("marks a review binding for another revision stale", () => {
    const binding = {
      target: {
        schemaVersion: 2,
        headSha: "d".repeat(40),
        workflow: "review-documentation",
      } as ReviewRunBinding["target"],
      source: {},
    } as unknown as ReviewRunBinding;

    expect(
      projectDocumentationWorkCompletion(
        input(run(), {
          pullRequestReviewExpected: true,
          reviewBinding: binding,
        }),
      ),
    ).toMatchObject({
      status: "partial",
      limitations: expect.arrayContaining(["review-binding-stale"]),
    });
  });

  it("does not turn missing or unsupported coverage into a no-impact conclusion", () => {
    const empty = run({
      reviewScope: completeScope({ targetPaths: [], corpusFileCount: 0 }),
      impactPostflight: { schemaVersion: 1, status: "no-change" },
    });
    const unsupported = run({
      reviewScope: completeScope({ accounting: undefined }),
    });
    const noContentChange = runWithCanonicalDocumentationResult();
    const noContentChangeWithPostflight = {
      ...noContentChange,
      impactPostflight: { schemaVersion: 1, status: "no-change" },
    } as LiveWorkflowRun;

    const emptyResult = projectDocumentationWorkCompletion(input(empty));
    expect(emptyResult).toMatchObject({
      status: "partial",
      documentationScope: { status: "partial", reviewedPaths: [] },
      impactDisposition: "not-assessed",
      limitations: expect.arrayContaining([
        "documentation-scope-incomplete",
        "impact-not-assessed",
      ]),
    });
    expect(projectDocumentationWorkCompletion(input(unsupported))).toMatchObject({
      status: "partial",
      documentationScope: { status: "partial" },
    });
    expect(projectDocumentationWorkCompletion(input(noContentChangeWithPostflight))).toMatchObject({
      status: "completed",
      impactDisposition: "not-assessed",
    });
  });

  it("rejects internally inconsistent local scope accounting", () => {
    const inconsistent = run({
      reviewScope: completeScope({
        accounting: {
          ...completeScope().accounting,
          radiusPageCount: 0,
          listedPageCount: 0,
        },
      }),
    });

    expect(projectDocumentationWorkCompletion(input(inconsistent))).toMatchObject({
      status: "partial",
      documentationScope: { status: "partial" },
      limitations: expect.arrayContaining(["documentation-scope-incomplete"]),
    });
  });

  it("preserves scope evidence when cancellation interrupts completion", () => {
    const controller = new AbortController();
    controller.abort();

    expect(
      projectDocumentationWorkCompletion(input(run(), { signal: controller.signal })),
    ).toMatchObject({
      status: "partial",
      documentationScope: {
        status: "partial",
        scopeSha256: SCOPE_DIGEST,
        reviewedPaths: ["docs/guide.md"],
      },
      limitations: expect.arrayContaining(["run-cancelled"]),
    });
  });
});
