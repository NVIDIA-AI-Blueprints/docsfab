// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it, vi } from "vitest";
import { formatRunSummary } from "../src/operator/run-summary.js";
import { buildRunResultV1 } from "../src/operator/run-result.js";
import { createLiveAgentToolDefinitions } from "../src/live-agent/capabilities.js";
import { deliverCliRunResult } from "../src/cli/run/delivery.js";
import { LiveAgentActivityRenderer } from "../src/live-agent/activity-renderer.js";

import {
  HostedQualityReportError,
  assertHostedReportUrl,
  dispatchHostedReportRequest,
  hostedReportsRoot,
  isHostedReportUrl,
  persistHostedQualityReport,
  readPersistedHostedQualityReport,
  projectQualityReportFromRun,
  renderQualityReportHtml,
  resolveHostedReportUrl,
  QualityReportProjectionError,
  decodeQualityReportProjection,
  parseQualityReportProjection,
  sealQualityValidationBinding,
  sealQualityValidatorReceipt,
} from "../src/evaluation-report/index.js";
import { validateStagedQualityArtifact } from "../src/evaluation-report/quality-schema-validation.js";
import { canonicalDigest } from "../src/content-ir/canonical.js";
import {
  HOSTED_QUALITY_REPORT_MAXIMUM_BYTES,
  hostedQualityMarkdownPath,
  hostedReportServeCommand,
} from "../src/evaluation-report/hosted-report.js";
import type { ReviewFindingV1 } from "../src/review/index.js";
import type { RunRecord } from "../src/records/contracts.js";
import {
  resetStartupPublicRootsForTest,
  validateStartupPublicRoots,
} from "../src/security/host-roots.js";
import {
  loadQualityReportSummaryFixtures,
  qualityReportMarkdown,
} from "./helpers/quality-report-summary.js";
import { configureCredentialsForEachTest } from "./helpers/configured-credential.js";

// Configured for every test: only a configured credential is refused (#1807).
configureCredentialsForEachTest(`glpat-${"x".repeat(24)}`);

const REVISION = "a".repeat(40);
const EVALUATION_RECORD = "1".repeat(64);
const SCORE_RECORD = "2".repeat(64);
const CANDIDATE_RECORD = "3".repeat(64);
const FINAL_RECORD = "4".repeat(64);
const EVALUATOR_IDENTITY = "5".repeat(64);
const PACK_BINDING = "6".repeat(64);
const QUALITY_REPORT_FIXTURES = loadQualityReportSummaryFixtures();
const QUALITY_REPORT_PROJECTION_FIXTURES = loadQualityReportProjectionFixtures();

interface QualityReportProjectionFixture {
  readonly name: string;
  readonly valid: boolean;
  readonly projection: Record<string, unknown>;
}

function loadQualityReportProjectionFixtures(): readonly QualityReportProjectionFixture[] {
  const value = JSON.parse(
    readFileSync(
      new URL(
        "../../quality/tests/fixtures/quality-report-projection/quality-report-projection-matrix.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as unknown;
  if (!Array.isArray(value)) {
    throw new Error("Quality report projection fixture matrix must be an array.");
  }
  return Object.freeze(
    value.map((fixture) => {
      if (
        fixture === null ||
        typeof fixture !== "object" ||
        Array.isArray(fixture) ||
        typeof fixture.name !== "string" ||
        typeof fixture.valid !== "boolean" ||
        fixture.projection === null ||
        typeof fixture.projection !== "object" ||
        Array.isArray(fixture.projection)
      ) {
        throw new Error("Quality report projection fixture matrix contains an invalid entry.");
      }
      return Object.freeze({
        name: fixture.name,
        valid: fixture.valid,
        projection: fixture.projection as Record<string, unknown>,
      });
    }),
  );
}
const PROFILE_SHA256 = createHash("sha256")
  .update(
    await readFile(
      new URL("../../quality/profiles/docsfab-documentation-quality/profile.json", import.meta.url),
    ),
  )
  .digest("hex");

function report(rubric: "available" | "unavailable" = "available"): string {
  const rubricValue =
    rubric === "available"
      ? {
          status: "available",
          id: "task-guide-v0.1",
          dimension_scores: {},
          total: 84,
          threshold: 80,
          interpretation_band: "Green",
          decision: "pass",
          confidence: 0.9,
          hard_gates: {},
        }
      : { status: "unavailable", reason: "No unambiguous content-type rubric." };
  return [
    "# Documentation quality evaluation report",
    "",
    "## Validated result summary",
    "",
    "```json",
    JSON.stringify({
      report_contract: "docsfab-quality-report-v0.1",
      target: {
        paths: ["docs/guide.md"],
        repository_revision: REVISION,
        documentation_revision: REVISION,
      },
      profile: { id: "docsfab-documentation-quality", version: "v0.1" },
      evaluation: {
        decision: rubric === "available" ? "pass" : "insufficient-evidence",
        confidence: rubric === "available" ? 0.9 : 0.4,
        hard_gate_failures: [],
      },
      rubric: rubricValue,
      validation: {
        evaluation: "passed",
        quality_score: rubric === "available" ? "passed" : "unavailable",
        report_binding: "passed",
      },
      artifact_locators: {
        evaluation: `record:sha256:${EVALUATION_RECORD}`,
        quality_score: rubric === "available" ? `record:sha256:${SCORE_RECORD}` : null,
        quality_report: "run:run-quality:evaluate-document-quality:quality-report",
      },
    }),
    "```",
    "",
    "## Evidence gaps and limitations",
    "",
    "- Limitation: Audience evidence was unavailable for this run.",
  ].join("\n");
}

function record(markdown = report()): RunRecord {
  const selectionBody = {
    workflow: "review-documentation" as const,
    selectorId: "review-documentation:docsfab-documentation-quality:v1" as const,
    workflowSourceSha256: "5".repeat(64),
    repositoryIdentitySha256: createHash("sha256").update("/tmp/repository").digest("hex"),
    repositoryRevision: REVISION,
    inventorySha256: "7".repeat(64),
    targetScope: "documentation-set" as const,
    targetScopeSha256: "6".repeat(64),
    targetPathSetSha256: "8".repeat(64),
    applicabilitySha256: "a".repeat(64),
    documentCount: 1,
    qualityPackManifestSha256: "f".repeat(64),
    qualityPackBindingSha256: PACK_BINDING,
    skillLockSha256: "1".repeat(64),
    qualityLockSha256: "2".repeat(64),
    qualityBundleSha256: "9".repeat(64),
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
  const scoreAvailable = markdown.includes('"quality_score":"passed"');
  const payloadSha256 = createHash("sha256").update(markdown, "utf8").digest("hex");
  const qualityArtifactValidation = sealQualityValidationBinding({
    runId: "run-quality",
    repositoryRevision: REVISION,
    selectionSha256: selection.selectionSha256,
    qualityPackBindingSha256: PACK_BINDING,
    evaluatorIdentitySha256: EVALUATOR_IDENTITY,
    status: "passed",
    failureCode: null,
    artifacts: {
      evaluation: { recordSha256: EVALUATION_RECORD, payloadSha256: "a".repeat(64) },
      qualityScore: scoreAvailable
        ? { recordSha256: SCORE_RECORD, payloadSha256: "b".repeat(64) }
        : null,
      candidateReport: { recordSha256: CANDIDATE_RECORD, payloadSha256 },
      finalReport: { recordSha256: FINAL_RECORD, payloadSha256 },
    },
    validatorAssets: validatorAssets("0".repeat(64)),
    validators: {
      evaluation: validatorReceipt("evaluation", [
        "a".repeat(64),
        "0".repeat(64),
        selection.profilePayloadSha256,
      ]),
      qualityScore: scoreAvailable ? validatorReceipt("quality-score", ["b".repeat(64)]) : null,
      reportBinding: validatorReceipt("report-binding", [
        "a".repeat(64),
        payloadSha256,
        selection.profilePayloadSha256,
        ...(scoreAvailable ? ["b".repeat(64)] : []),
      ]),
    },
  });
  return {
    schemaVersion: 2,
    id: "run-quality",
    workflow: "review-documentation",
    repository: { sourcePath: "/tmp/repository", requestedRevision: "HEAD", revision: REVISION },
    workspace: { strategy: "tracked-export", disposable: true },
    status: "succeeded",
    createdAt: "2026-08-21T00:00:00.000Z",
    models: [],
    skills: [],
    qualityPack: {
      schemaVersion: 1,
      id: "docsfab-default",
      version: "1.0.0",
      manifestSha256: "f".repeat(64),
      bindingSha256: PACK_BINDING,
      skillLockSha256: "1".repeat(64),
      qualityLockSha256: "2".repeat(64),
      qualityBundleSha256: selection.qualityBundleSha256,
      barIds: [selection.profileBarId],
    },
    qualityProfileSelection: selection,
    qualityArtifactValidation,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0 },
    tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
    steps: [
      {
        id: "evaluate-document-quality",
        title: "Produce the final quality report",
        kind: "evaluate",
        skill: "evaluate-document-quality",
        mode: "read-only",
        status: "succeeded",
        evaluateEvidence: {
          schemaVersion: 1,
          kind: "docsfab-evaluate-step-evidence",
          evaluatorIdentitySha256: EVALUATOR_IDENTITY,
          toolPolicySha256: "3".repeat(64),
          acceptancePolicySha256: "4".repeat(64),
        },
        summary: markdown,
      },
    ],
  };
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

function resealReceipt(
  receipt: NonNullable<
    NonNullable<RunRecord["qualityArtifactValidation"]>["validators"]["evaluation"]
  >,
  overrides: Partial<Omit<typeof receipt, "schemaVersion" | "kind" | "receiptSha256">>,
) {
  return sealQualityValidatorReceipt({
    validator: receipt.validator,
    program: receipt.program,
    scriptSha256: receipt.scriptSha256,
    inputPayloadSha256s: receipt.inputPayloadSha256s,
    outcome: receipt.outcome,
    exitCode: receipt.exitCode,
    stdoutSha256: receipt.stdoutSha256,
    stderrSha256: receipt.stderrSha256,
    ...overrides,
  });
}

function resealValidation(
  recordValue: RunRecord,
  validators: NonNullable<RunRecord["qualityArtifactValidation"]>["validators"],
): void {
  const validation = recordValue.qualityArtifactValidation!;
  recordValue.qualityArtifactValidation = sealQualityValidationBinding({
    runId: validation.runId,
    repositoryRevision: validation.repositoryRevision,
    selectionSha256: validation.selectionSha256,
    qualityPackBindingSha256: validation.qualityPackBindingSha256,
    evaluatorIdentitySha256: validation.evaluatorIdentitySha256,
    status: validation.status,
    failureCode: validation.failureCode,
    artifacts: validation.artifacts,
    validatorAssets: validation.validatorAssets,
    validators,
  });
}

function rebindFinalMarkdown(recordValue: RunRecord, markdown: string): void {
  const validation = recordValue.qualityArtifactValidation!;
  const reportReceipt = validation.validators.reportBinding!;
  const payloadSha256 = createHash("sha256").update(markdown, "utf8").digest("hex");
  recordValue.steps.at(-1)!.summary = markdown;
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
      reportBinding: resealReceipt(reportReceipt, {
        inputPayloadSha256s: reportReceipt.inputPayloadSha256s.map((digest, index) =>
          index === 1 ? payloadSha256 : digest,
        ),
      }),
    },
  });
}

function validatorAssets(evaluationSchemaSha256: string) {
  return {
    evaluationScriptSha256: "65".padStart(64, "0"),
    evaluationSchemaSha256,
    qualityScoreScriptSha256: "71".padStart(64, "0"),
    reportScriptSha256: "72".padStart(64, "0"),
  };
}

describe("quality report projection", () => {
  it("preserves the legacy v0.1 report digest", () => {
    const fixture = QUALITY_REPORT_FIXTURES[0]!;
    const projected = parseQualityReportProjection(qualityReportMarkdown(fixture.summary), {
      repositoryRevision: REVISION,
      patchSha256: null,
    });
    expect(projected.schemaVersion).toBe(1);
    expect(projected.reportLocator.digestSha256).toBe(
      "93ad0b8aa19681a45bb938c216a3e8f194f3539d82c8249825b5ca33dfafd1ec",
    );
  });

  it.each(QUALITY_REPORT_FIXTURES)("validates shared raw fixture: $name", (fixture) => {
    const invoke = () =>
      parseQualityReportProjection(qualityReportMarkdown(fixture.summary), {
        repositoryRevision: REVISION,
        patchSha256: null,
        ...(fixture.summary.report_contract === "docsfab-quality-report-v0.2"
          ? {
              profile: {
                artifactLocator: "profiles/docsfab-documentation-quality/profile.json",
                artifactSha256: PROFILE_SHA256,
                id: "docsfab-documentation-quality",
                version: "v0.1",
              },
            }
          : {}),
      });
    if (fixture.valid) {
      expect(invoke).not.toThrow();
    } else {
      expect(invoke).toThrow(QualityReportProjectionError);
    }
  });

  it("accounts for Evidence gap rows and rejects ambiguous v0.2 limitation sections", () => {
    const fixture = QUALITY_REPORT_FIXTURES.find((item) => item.name.startsWith("v0.2 retains"))!;
    const binding = {
      repositoryRevision: REVISION,
      patchSha256: null,
      profile: {
        artifactLocator: "profiles/docsfab-documentation-quality/profile.json",
        artifactSha256: PROFILE_SHA256,
        id: "docsfab-documentation-quality",
        version: "v0.1",
      },
    };
    const markdown = qualityReportMarkdown(fixture.summary);
    const evidenceGap = markdown.replace(
      "- Limitation: Technical verification did not cover an optional example.",
      "- Evidence gap: Technical verification did not cover an optional example.",
    );
    const projected = parseQualityReportProjection(evidenceGap, binding);
    expect(projected.schemaVersion === 2 && projected.unclassifiedLimitations).toEqual([
      "Technical verification did not cover an optional example.",
    ]);
    const ambiguous = [
      evidenceGap.replace("- Evidence gap:", "Contradictory prose\n- Evidence gap:"),
      `${evidenceGap}\n\n## Evidence gaps and limitations\n\n- Limitation: hidden`,
      evidenceGap.replace("optional example.", "optional example.\n  continuation"),
    ];
    for (const candidate of ambiguous) {
      expect(() => parseQualityReportProjection(candidate, binding)).toThrow(
        QualityReportProjectionError,
      );
    }
    const reordered = structuredClone(fixture.summary);
    (reordered.limitations as unknown[]).reverse();
    expect(() =>
      parseQualityReportProjection(
        markdown.replace(JSON.stringify(fixture.summary), JSON.stringify(reordered)),
        binding,
      ),
    ).toThrow(QualityReportProjectionError);
  });

  // An evaluator can write documentation_revision as a label such as
  // "rev-1". The report schema and its validator admit any bounded string
  // there, so this reader must too, or a passed artifact reads back as an
  // invalid binding.
  it("reads documentation_revision with the report schema's bounded-string rule", () => {
    const fixture = QUALITY_REPORT_FIXTURES.find((item) => item.name.startsWith("v0.2 retains"))!;
    const binding = {
      repositoryRevision: REVISION,
      patchSha256: null,
      profile: {
        artifactLocator: "profiles/docsfab-documentation-quality/profile.json",
        artifactSha256: PROFILE_SHA256,
        id: "docsfab-documentation-quality",
        version: "v0.1",
      },
    };
    const withTarget = (target: Record<string, unknown>) => {
      const summary = structuredClone(fixture.summary) as { target: Record<string, unknown> };
      summary.target = { ...summary.target, ...target };
      return qualityReportMarkdown(summary as typeof fixture.summary);
    };
    for (const documentationRevision of ["rev-1", `sha256:${"d".repeat(64)}`, "d".repeat(40)]) {
      expect(
        parseQualityReportProjection(
          withTarget({ documentation_revision: documentationRevision }),
          binding,
        ),
      ).toBeDefined();
    }
    // Still refused: what the schema refuses, and a repository revision that
    // is not this run's, which the same reader binds.
    for (const target of [
      { documentation_revision: "" },
      { documentation_revision: " rev-1" },
      { documentation_revision: "r".repeat(513) },
      { documentation_revision: 1 },
      { repository_revision: "e".repeat(40) },
    ]) {
      expect(() => parseQualityReportProjection(withTarget(target), binding)).toThrow(
        "Quality report projection rejected: invalid-report.",
      );
    }
  });

  it("accepts title-case headings and retains bold-label limitations without changing the report", () => {
    const markdown = report()
      .replace("Validated result summary", "Validated Result Summary")
      .replace("Evidence gaps and limitations", "Evidence Gaps and Limitations")
      .replace("- Limitation:", "- **Limitation:**");
    expect(projectQualityReportFromRun(record(markdown))).toMatchObject({
      decision: "pass",
      limitations: ["Audience evidence was unavailable for this run."],
    });
    expect(() => projectQualityReportFromRun(record(`${markdown}\n${report()}`))).toThrow(
      QualityReportProjectionError,
    );
    expect(() =>
      projectQualityReportFromRun(record(markdown.replace('"confidence":0.9', '"confidence":9'))),
    ).toThrow(QualityReportProjectionError);
  });

  it("rejects a re-sealed locator substitution and projects an exact replay stably", () => {
    const original = record();
    expect(projectQualityReportFromRun(structuredClone(original))).toEqual(
      projectQualityReportFromRun(structuredClone(original)),
    );

    const substituted = structuredClone(original);
    const markdown = report().replace(
      `record:sha256:${EVALUATION_RECORD}`,
      `record:sha256:${"9".repeat(64)}`,
    );
    rebindFinalMarkdown(substituted, markdown);

    expect(() => projectQualityReportFromRun(substituted)).toThrow(QualityReportProjectionError);
  });

  it("rejects cross-run and selected-profile substitutions", () => {
    const crossRun = record();
    crossRun.id = "run-different";
    expect(() => projectQualityReportFromRun(crossRun)).toThrow(QualityReportProjectionError);

    const crossProfile = record();
    const markdown = report().replace(
      '"id":"docsfab-documentation-quality","version":"v0.1"',
      '"id":"substituted-profile","version":"v9"',
    );
    rebindFinalMarkdown(crossProfile, markdown);
    expect(() => projectQualityReportFromRun(crossProfile)).toThrow(QualityReportProjectionError);
  });

  it.each(["create-documentation", "update-documentation"] as const)(
    "rejects review validation receipts substituted into %s",
    (workflow) => {
      const substituted = record();
      substituted.workflow = workflow;
      expect(() => projectQualityReportFromRun(substituted)).toThrow(QualityReportProjectionError);
    },
  );

  it.each(["create-documentation", "update-documentation"] as const)(
    "does not let narrative decline wording hide invalid %s receipts",
    (workflow) => {
      const substituted = record();
      substituted.workflow = workflow;
      rebindFinalMarkdown(
        substituted,
        report().replace("Audience evidence", "Host report decline: Audience evidence"),
      );
      expect(() => projectQualityReportFromRun(substituted)).toThrow(QualityReportProjectionError);
    },
  );

  it("rejects missing, substituted, failed, mis-typed, or mis-bound validator receipts", () => {
    const cases = [
      (current: RunRecord) => {
        resealValidation(current, {
          ...current.qualityArtifactValidation!.validators,
          evaluation: null,
        });
      },
      (current: RunRecord) => {
        const receipt = current.qualityArtifactValidation!.validators.evaluation!;
        resealValidation(current, {
          ...current.qualityArtifactValidation!.validators,
          evaluation: { ...receipt, stdoutSha256: "9".repeat(64) },
        });
      },
      (current: RunRecord) => {
        const receipt = current.qualityArtifactValidation!.validators.evaluation!;
        resealValidation(current, {
          ...current.qualityArtifactValidation!.validators,
          evaluation: resealReceipt(receipt, { outcome: "failed", exitCode: 1 }),
        });
      },
      (current: RunRecord) => {
        const receipt = current.qualityArtifactValidation!.validators.evaluation!;
        resealValidation(current, {
          ...current.qualityArtifactValidation!.validators,
          evaluation: resealReceipt(receipt, { validator: "quality-score" }),
        });
      },
      (current: RunRecord) => {
        const receipt = current.qualityArtifactValidation!.validators.evaluation!;
        resealValidation(current, {
          ...current.qualityArtifactValidation!.validators,
          evaluation: resealReceipt(receipt, {
            inputPayloadSha256s: ["9".repeat(64), ...receipt.inputPayloadSha256s.slice(1)],
          }),
        });
      },
      (current: RunRecord) => {
        const receipt = current.qualityArtifactValidation!.validators.evaluation!;
        resealValidation(current, {
          ...current.qualityArtifactValidation!.validators,
          evaluation: resealReceipt(receipt, {
            scriptSha256: "9".repeat(64),
          }),
        });
      },
      (current: RunRecord) => {
        const receipt = current.qualityArtifactValidation!.validators.evaluation!;
        resealValidation(current, {
          ...current.qualityArtifactValidation!.validators,
          evaluation: resealReceipt(receipt, {
            inputPayloadSha256s: [
              receipt.inputPayloadSha256s[0]!,
              "9".repeat(64),
              receipt.inputPayloadSha256s[2]!,
            ],
          }),
        });
      },
    ];

    for (const mutate of cases) {
      const current = record();
      mutate(current);
      expect(() => projectQualityReportFromRun(current)).toThrow(QualityReportProjectionError);
    }
  });

  it("retains truncation evidence for title-case headings and bold limitation labels", () => {
    const markdown = report()
      .replace("Evidence gaps and limitations", "Evidence Gaps and Limitations")
      .replace(
        "- Limitation: Audience evidence was unavailable for this run.",
        `- **Limitation:** ${"x".repeat(600)}`,
      );
    const projected = projectQualityReportFromRun(record(markdown));
    expect(projected?.limitations).toContain("truncated-projection-field");
    expect(projected?.limitations.some((item) => item.startsWith("x".repeat(509)))).toBe(true);
    expect(projected?.limitations.every((item) => item.length <= 512)).toBe(true);
  });

  it("retains truncation evidence for long raw hard gates and unavailable reasons", () => {
    const longGate = `gate-${"g".repeat(600)}`;
    const longReason = `reason-${"r".repeat(600)}`;
    const fixture = structuredClone(
      QUALITY_REPORT_FIXTURES.find(
        (candidate) => candidate.name === "unavailable rubric with hard gates fails",
      )!.summary,
    );
    (fixture.evaluation as Record<string, unknown>).hard_gate_failures = [longGate];
    (fixture.rubric as Record<string, unknown>).reason = longReason;
    const projected = parseQualityReportProjection(qualityReportMarkdown(fixture), {
      repositoryRevision: REVISION,
      patchSha256: null,
    });
    expect(projected.decision).toBe("fail");
    expect(projected.hardGateFailures[0]).toHaveLength(512);
    expect(projected.rubric).toMatchObject({ status: "unavailable" });
    expect(projected.rubric.status === "unavailable" && projected.rubric.reason).toHaveLength(512);
    expect(projected.limitations).toContain("truncated-projection-field:2");
  });

  it.each([false, true])(
    "retains step outputs and reports unavailable quality through CLI and live tools, json=%s",
    async (json) => {
      const saved = record(
        "Review findings exist, but the required structured summary is missing.",
      );
      const original = structuredClone(saved);
      const context = {
        record: saved,
        recordPath: "/private/run.json",
        repositoryPath: "/fixture",
        exitCode: 1 as const,
      };
      expect(formatRunSummary({ ...context, quiet: true }).join("\n")).toContain("missing-report");
      const envelope = buildRunResultV1(context);
      expect(envelope.quality).toBeNull();
      expect(envelope.product.limitations).toContain("quality-projection-unavailable");
      expect(envelope.nextSteps.join(" ")).toContain("Completed step outputs remain");
      const output: string[] = [];
      const stateDirectory = await mkdtemp(join(tmpdir(), "docsfab-report-failure-"));
      const oldExitCode = process.exitCode;
      try {
        const invoke = {
          request: { workflow: "review-documentation", repositoryPath: "/fixture" },
          config: { stateDirectory },
          options: { json },
          output: {
            log: (line: string) => output.push(line),
            error: (line: string) => output.push(line),
          },
        } as unknown as Parameters<typeof deliverCliRunResult>[0];
        const returned = await deliverCliRunResult(
          invoke,
          {} as never,
          {} as never,
          { record: saved, exitCode: 0 } as never,
        );
        expect(returned).toEqual(saved);
        expect(process.exitCode).toBe(1);
        expect(output.join("\n")).toContain("missing-report");
        const retained = await readPersistedHostedQualityReport({
          stateDirectory,
          runId: saved.id,
        });
        expect(retained).toMatchObject({ reportAvailable: true, markdownAvailable: true });
        expect(output.join("\n")).toContain(retained?.url);
        const tool = createLiveAgentToolDefinitions({
          capabilities: {
            skills: [],
            workflows: [{ name: "review-documentation", title: "Review" }],
            qualityPack: {} as never,
          },
          runWorkflow: async () => returned,
        }).find((entry) => entry.name === "docsfab_run_workflow")!;
        const result = await tool.execute(
          "report-call",
          { workflow: "review-documentation", instruction: "Review docs" },
          undefined,
          undefined,
          {} as never,
        );
        expect(result.details).toMatchObject({
          status: "failed",
          workflowStatus: "succeeded",
          runId: saved.id,
          quality: null,
          steps: [{ summary: saved.steps[0]!.summary }],
        });
        const activity = new LiveAgentActivityRenderer({
          write: (line) => output.push(line),
          tty: false,
          columns: () => 100,
          skillIds: [],
          workflowIds: ["review-documentation"],
        });
        try {
          activity.begin();
          activity.handle({
            type: "tool_execution_start",
            toolName: tool.name,
            toolCallId: "report-call",
            args: { workflow: "review-documentation" },
          });
          activity.handle({
            type: "tool_execution_end",
            toolName: tool.name,
            toolCallId: "report-call",
            result,
            isError: false,
          });
          expect(output.join("\n")).toContain("Review report processing failed (missing-report)");
          expect(output.join("\n")).not.toContain("No safe failure detail");
        } finally {
          activity.dispose();
        }
        expect(saved).toEqual(original);
      } finally {
        process.exitCode = oldExitCode;
        await rm(stateDirectory, { recursive: true, force: true });
      }
    },
  );

  it.each([false, true])(
    "withholds a hosted report that egress refuses and still writes the run output, json=%s",
    async (json) => {
      const token = `glpat-${"x".repeat(24)}`;
      const saved = record(`Review findings exist; the evaluator quoted ${token}.`);
      const output: string[] = [];
      const stateDirectory = await mkdtemp(join(tmpdir(), "docsfab-report-withheld-"));
      const oldExitCode = process.exitCode;
      try {
        const invoke = {
          request: { workflow: "review-documentation", repositoryPath: "/fixture" },
          config: { stateDirectory },
          options: { json },
          output: {
            log: (line: string) => output.push(line),
            error: (line: string) => output.push(line),
          },
        } as unknown as Parameters<typeof deliverCliRunResult>[0];
        await expect(
          deliverCliRunResult(
            invoke,
            {} as never,
            {} as never,
            {
              record: saved,
              exitCode: 1,
            } as never,
          ),
        ).resolves.toEqual(saved);
        const text = output.join("\n");
        expect(text).not.toContain(token);
        if (json) {
          const result = JSON.parse(text) as { product: { limitations: string[] } };
          expect(result.product.limitations).toContain(
            "hosted-report-withheld:credential-material",
          );
        } else {
          expect(text).toContain("report withheld (credential-material)");
        }
        const retained = await readPersistedHostedQualityReport({
          stateDirectory,
          runId: saved.id,
        });
        expect(retained?.reportAvailable ?? false).toBe(false);
      } finally {
        process.exitCode = oldExitCode;
        await rm(stateDirectory, { recursive: true, force: true });
      }
    },
  );

  it.each([
    ["a filesystem failure", "file", undefined],
    ["a report refusal that egress did not raise", "directory", "invalid-run-id"],
  ] as const)("rethrows %s while persisting the hosted report", async (_label, state, code) => {
    const root = await mkdtemp(join(tmpdir(), "docsfab-report-rethrow-"));
    // A state path that is a file makes the report directory unwritable.
    const stateDirectory = join(root, "state");
    if (state === "file") await writeFile(stateDirectory, "occupied");
    const originalEntries = await readdir(root);
    const saved = { ...record(), ...(code ? { id: "../escaped" } : {}) };
    const oldExitCode = process.exitCode;
    try {
      const invoke = {
        request: { workflow: "review-documentation", repositoryPath: "/fixture" },
        config: { stateDirectory },
        options: { json: true },
        output: { log: () => undefined, error: () => undefined },
      } as unknown as Parameters<typeof deliverCliRunResult>[0];
      const failure: unknown = await deliverCliRunResult(
        invoke,
        {} as never,
        {} as never,
        {
          record: saved,
          exitCode: 1,
        } as never,
      ).then(
        () => undefined,
        (error: unknown) => error,
      );
      if (code) expect(failure).toMatchObject({ name: "HostedQualityReportError", code });
      else expect(failure).toMatchObject({ name: "RunMaintenanceGateError", code: "unsafe" });
      expect(await readdir(root)).toEqual(originalEntries);
      if (state === "file") expect(await readFile(stateDirectory, "utf8")).toBe("occupied");
    } finally {
      process.exitCode = oldExitCode;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("projects the validated report summary for the standalone evaluation workflow", () => {
    const projected = projectQualityReportFromRun(record());
    expect(projected).toMatchObject({
      decision: "pass",
      confidence: 0.9,
      patchSha256: null,
      rubric: { status: "available", total: 84, interpretationBand: "Green" },
      limitations: ["Audience evidence was unavailable for this run."],
    });
    expect(projected?.reportLocator.digestSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(decodeQualityReportProjection(projected)).toEqual(projected);
  });

  it("keeps V1 limitation bounds while preserving unbounded V2 projection text", () => {
    const base = projectQualityReportFromRun(record());
    expect(base).not.toBeNull();
    if (!base) throw new Error("Expected the V1 quality projection fixture.");
    const long = "x".repeat(513);
    const multiline = "first\r\nsecond\u0085third\u2028fourth\u001cgroup";
    expect(() => decodeQualityReportProjection({ ...base, limitations: [long] })).toThrow(
      QualityReportProjectionError,
    );

    const v2 = {
      ...base,
      schemaVersion: 2 as const,
      limitations: [long, multiline],
      retainedGapEvidence: [],
      unclassifiedLimitations: [long, multiline],
    };
    expect(decodeQualityReportProjection(v2)).toMatchObject({
      schemaVersion: 2,
      limitations: [long, multiline].sort(),
      unclassifiedLimitations: [long, multiline].sort(),
    });
    for (const invalid of ["\ufeffedge", "trailing\n"]) {
      expect(() =>
        decodeQualityReportProjection({
          ...v2,
          limitations: [invalid],
          unclassifiedLimitations: [invalid],
        }),
      ).toThrow(QualityReportProjectionError);
    }
  });

  it.each(["create-documentation", "update-documentation"] as const)(
    "retains legacy advisory %s summaries without claiming validation",
    (workflow) => {
      const legacy = { ...record(), workflow };
      delete legacy.qualityProfileSelection;
      delete legacy.qualityArtifactValidation;
      expect(projectQualityReportFromRun(legacy)).toBeNull();
    },
  );

  it("preserves an unavailable score as insufficient evidence", () => {
    expect(
      parseQualityReportProjection(report("unavailable"), {
        repositoryRevision: REVISION,
        patchSha256: null,
      }),
    ).toMatchObject({
      decision: "insufficient-evidence",
      rubric: { status: "unavailable", reason: "No unambiguous content-type rubric." },
    });
  });

  it("decodes both unavailable-rubric precedence branches", () => {
    const insufficient = parseQualityReportProjection(report("unavailable"), {
      repositoryRevision: REVISION,
      patchSha256: null,
    });
    expect(decodeQualityReportProjection(insufficient)).toEqual(insufficient);

    const failed = {
      ...insufficient,
      decision: "fail" as const,
      hardGateFailures: ["critical-factual-error"],
    };
    expect(decodeQualityReportProjection(failed)).toMatchObject({
      decision: "fail",
      hardGateFailures: ["critical-factual-error"],
      rubric: { status: "unavailable" },
    });
    expect(() =>
      decodeQualityReportProjection({ ...failed, decision: "insufficient-evidence" }),
    ).toThrow(QualityReportProjectionError);
    expect(() => decodeQualityReportProjection({ ...insufficient, decision: "fail" })).toThrow(
      QualityReportProjectionError,
    );
  });

  it.each(QUALITY_REPORT_PROJECTION_FIXTURES)(
    "decodes shared projection fixture: $name",
    (fixture) => {
      const invoke = () => decodeQualityReportProjection(fixture.projection);
      if (fixture.valid) {
        const decoded = invoke();
        expect(decoded.schemaVersion).toBe(fixture.projection.schemaVersion);
        expect(decoded.decision).toBe(fixture.projection.decision);
        expect(decoded.kind).toBe("docsfab-quality-report-projection");
      } else {
        expect(invoke).toThrow(QualityReportProjectionError);
        if (fixture.projection.schemaVersion === 1) {
          expect(
            validateStagedQualityArtifact(
              "quality-report-projection.schema.json",
              fixture.projection,
            ),
          ).toBe("invalid");
        }
      }
    },
  );

  it("fails closed when the final report is absent", () => {
    expect(() => projectQualityReportFromRun(record("review complete"))).toThrow(
      QualityReportProjectionError,
    );
  });
});

describe("hosted quality HTML report", () => {
  it("renders escaped HTML, persists it, and resolves a loopback reports URL", async () => {
    const projected = projectQualityReportFromRun(record())!;
    const html = renderQualityReportHtml(projected, "<script>alert(1)</script>");
    expect(html).toContain("DocsFab review report");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>alert");
    const root = await mkdtemp(join(tmpdir(), "docsfab-hosted-report-"));
    const persisted = await persistHostedQualityReport({
      stateDirectory: root,
      runId: "run-quality",
      quality: projected,
      markdown: "<script>alert(1)</script>\n# Documentation quality evaluation report",
      environment: {},
    });
    expect(persisted.url).toBe("http://127.0.0.1:8787/reports/run-quality/");
    expect(persisted.markdownPath).toBe(hostedQualityMarkdownPath(root, "run-quality"));
    expect(persisted.markdownAvailable).toBe(true);
    expect(await readFile(persisted.markdownPath!, "utf8")).toBe(
      "<script>alert(1)</script>\n# Documentation quality evaluation report",
    );
    expect(persisted.serveCommand).toBe(`docsfab reports serve --state-dir '${root}' --port 8787`);
    expect((await stat(persisted.path)).mode & 0o777).toBe(0o600);
    expect((await stat(persisted.markdownPath!)).mode & 0o777).toBe(0o600);
    expect((await stat(hostedReportsRoot(root))).mode & 0o777).toBe(0o700);
    expect(await readFile(persisted.path, "utf8")).toContain("&lt;script&gt;");
    const served = await dispatchHostedReportRequest({
      method: "GET",
      urlPath: "/reports/run-quality/",
      reportsRoot: hostedReportsRoot(root),
    });
    expect(served.status).toBe(200);
    expect(served.contentType).toContain("text/html");
    expect(served.body).toContain("Decision");
    const markdown = await dispatchHostedReportRequest({
      method: "GET",
      urlPath: "/reports/run-quality/quality-report.md",
      reportsRoot: hostedReportsRoot(root),
    });
    expect(markdown).toMatchObject({
      status: 200,
      contentType: "text/markdown; charset=utf-8",
      body: "<script>alert(1)</script>\n# Documentation quality evaluation report",
    });
    expect(
      await dispatchHostedReportRequest({
        method: "POST",
        urlPath: "/reports/run-quality/quality-report.md",
        reportsRoot: hostedReportsRoot(root),
      }),
    ).toMatchObject({ status: 405 });
    const denied = await dispatchHostedReportRequest({
      method: "GET",
      urlPath: "/reports/../run-quality/",
      reportsRoot: hostedReportsRoot(root),
    });
    expect(denied.status).toBe(404);
    await rm(root, { recursive: true, force: true });
  });

  it("keeps nullable quality and sealed findings truthful", () => {
    const finding: ReviewFindingV1 = {
      severity: "warning",
      code: "TECH-001",
      id: "finding:test:1",
      summary: "<unsafe>",
      path: null,
      line: 42,
      origin: "agent",
      evidence: "evidence",
      recommendation: "fix",
    };
    const html = renderQualityReportHtml(
      null,
      "<script>alert(1)</script>",
      [finding],
      ["review-findings-unparsed:test"],
    );
    expect(html).toContain("Quality</dt><dd>unavailable/not projected");
    expect(html).toContain("TECH-001");
    expect(html).toContain("Id: finding:test:1");
    expect(html).toContain("Path: null");
    expect(html).toContain("Line: 42");
    expect(html).toContain("Origin: agent");
    expect(html).toContain("&lt;unsafe&gt;");
    expect(html).toContain("review-findings-unparsed:test");
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("Hard-gate failures");
  });

  it("refuses a hosted report egress cannot walk with its own code", async () => {
    const root = await mkdtemp(join(tmpdir(), "docsfab-hosted-report-unwalkable-"));
    try {
      await expect(
        persistHostedQualityReport({
          stateDirectory: root,
          runId: "run-quality-unwalkable",
          quality: null,
          markdown: "report\n",
          findingLimitations: [new Date(0)] as unknown as string[],
        }),
      ).rejects.toMatchObject({
        name: "HostedQualityReportError",
        code: "egress-unwalkable-value",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("validates a report run ID before touching state and still refuses a file state root", async () => {
    const root = await mkdtemp(join(tmpdir(), "docsfab-hosted-report-order-"));
    const stateDirectory = join(root, "state");
    const input = { stateDirectory, quality: null, markdown: "report\n" };
    try {
      await expect(
        persistHostedQualityReport({ ...input, runId: "../escaped" }),
      ).rejects.toMatchObject({ name: "HostedQualityReportError", code: "invalid-run-id" });
      await writeFile(stateDirectory, "occupied");
      const originalEntries = await readdir(root);
      await expect(
        persistHostedQualityReport({ ...input, runId: "valid-report-run" }),
      ).rejects.toMatchObject({ name: "RunMaintenanceGateError", code: "unsafe" });
      expect(await readdir(root)).toEqual(originalEntries);
      expect(await readFile(stateDirectory, "utf8")).toBe("occupied");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("replaces roots with the startup public-roots declaration", async () => {
    const root = await mkdtemp(join(tmpdir(), "docsfab-hosted-report-startup-"));
    const home = "/srv/report-roots/home/node";
    try {
      vi.stubEnv("HOME", home);
      vi.stubEnv("DOCSFAB_PUBLIC_ROOTS", home);
      validateStartupPublicRoots();
      vi.stubEnv("DOCSFAB_PUBLIC_ROOTS", "relative");
      const persisted = await persistHostedQualityReport({
        stateDirectory: root,
        runId: "run-quality-startup",
        quality: null,
        markdown: `cwd ${home}/docs\n`,
      });
      expect(await readFile(persisted.markdownPath!, "utf8")).toBe(`cwd ${home}/docs\n`);
    } finally {
      vi.unstubAllEnvs();
      resetStartupPublicRootsForTest();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("omits over-bound Markdown and uses the configured numeric port", async () => {
    const root = await mkdtemp(join(tmpdir(), "docsfab-hosted-report-bound-"));
    const exact = await persistHostedQualityReport({
      stateDirectory: root,
      runId: "run-quality-bound",
      quality: null,
      markdown: "a".repeat(HOSTED_QUALITY_REPORT_MAXIMUM_BYTES),
    });
    expect(exact.markdownAvailable).toBe(true);
    const markdown = "😀".repeat(Math.ceil(HOSTED_QUALITY_REPORT_MAXIMUM_BYTES / 4) + 1);
    const persisted = await persistHostedQualityReport({
      stateDirectory: root,
      runId: "run-quality-bound",
      quality: null,
      markdown,
      environment: { DOCSFAB_REPORT_PORT: "9191" },
    });
    expect(persisted.markdownAvailable).toBe(false);
    expect(persisted.markdownUnavailableReason).toBe("byte-bound");
    expect(persisted.markdownPath).toBeNull();
    expect(persisted.markdownDigestSha256).toBeNull();
    expect(persisted.serveCommand).toBe(`docsfab reports serve --state-dir '${root}' --port 9191`);
    expect(
      await dispatchHostedReportRequest({
        method: "GET",
        urlPath: "/reports/run-quality-bound/quality-report.md",
        reportsRoot: hostedReportsRoot(root),
      }),
    ).toMatchObject({ status: 404 });
    await rm(root, { recursive: true, force: true });
  });

  it("shell-quotes report state paths in the generated serving command", () => {
    expect(
      hostedReportServeCommand("/tmp/report state/'quoted", { DOCSFAB_REPORT_PORT: "9191" }),
    ).toBe("docsfab reports serve --state-dir '/tmp/report state/'\\''quoted' --port 9191");
  });

  it("does not serve an artifact after its availability-bound bytes change", async () => {
    const root = await mkdtemp(join(tmpdir(), "docsfab-hosted-report-tamper-"));
    const persisted = await persistHostedQualityReport({
      stateDirectory: root,
      runId: "run-quality-tamper",
      quality: null,
      markdown: "retained evaluator report\n",
    });
    await writeFile(persisted.markdownPath!, "tampered evaluator report\n", "utf8");
    const replay = await readPersistedHostedQualityReport({
      stateDirectory: root,
      runId: "run-quality-tamper",
    });
    expect(replay).toMatchObject({
      reportAvailable: false,
      reportUnavailableReason: "artifact-unavailable",
      markdownAvailable: false,
      markdownUnavailableReason: "artifact-unavailable",
    });
    expect(
      await dispatchHostedReportRequest({
        method: "GET",
        urlPath: "/reports/run-quality-tamper/quality-report.md",
        reportsRoot: hostedReportsRoot(root),
      }),
    ).toMatchObject({ status: 404 });
    expect(
      await dispatchHostedReportRequest({
        method: "GET",
        urlPath: "/reports/run-quality-tamper/",
        reportsRoot: hostedReportsRoot(root),
      }),
    ).toMatchObject({ status: 404 });
    await rm(root, { recursive: true, force: true });
  });

  it("binds the private availability manifest to its requested run", async () => {
    const root = await mkdtemp(join(tmpdir(), "docsfab-hosted-report-binding-"));
    const persisted = await persistHostedQualityReport({
      stateDirectory: root,
      runId: "run-quality-bound-manifest",
      quality: null,
      markdown: "retained evaluator report\n",
    });
    const manifestPath = join(dirname(persisted.path), ".availability.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.runId = "another-run";
    await writeFile(manifestPath, JSON.stringify(manifest), "utf8");
    expect(
      await readPersistedHostedQualityReport({
        stateDirectory: root,
        runId: "run-quality-bound-manifest",
      }),
    ).toBeNull();
    expect(
      await dispatchHostedReportRequest({
        method: "GET",
        urlPath: "/reports/run-quality-bound-manifest/",
        reportsRoot: hostedReportsRoot(root),
      }),
    ).toMatchObject({ status: 404 });
    await rm(root, { recursive: true, force: true });
  });

  it("rejects credentialed or off-contract hosted report URLs", () => {
    expect(isHostedReportUrl("http://127.0.0.1:8787/reports/run-quality/")).toBe(true);
    expect(isHostedReportUrl("https://operator.brevlab.com/reports/run-quality/")).toBe(true);
    expect(() =>
      assertHostedReportUrl("https://user:token@127.0.0.1:8787/reports/run-quality/"),
    ).toThrow(HostedQualityReportError);
    expect(() => assertHostedReportUrl("https://example.com/other/run-quality/")).toThrow(
      HostedQualityReportError,
    );
    expect(
      resolveHostedReportUrl("run-quality", {
        DOCSFAB_REPORT_BASE_URL: "https://operator.brevlab.com/",
      }),
    ).toBe("https://operator.brevlab.com/reports/run-quality/");
    expect(() =>
      resolveHostedReportUrl("run-quality", {
        DOCSFAB_REPORT_BASE_URL: "https://user:token@operator.brevlab.com",
      }),
    ).toThrow(HostedQualityReportError);
  });
});
