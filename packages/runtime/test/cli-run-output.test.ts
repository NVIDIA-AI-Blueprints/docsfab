// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createPrintProgressHandler, parseDoctorArguments, parseRunArguments } from "../src/cli.js";
import { canonicalEvaluatorSummary, serializeRunResultCliJson } from "../src/cli/run/delivery.js";
import { createWorkUnitMachineContract } from "../src/maturity/work-unit-machine-contract.js";
import { handleShipCommand } from "../src/cli/commands/ship.js";
import { markPreWriteFreshnessFailure } from "../src/cli/run/delivery.js";
import { LocalUserPublicationPreflightError } from "../src/delivery/contracts.js";
import {
  formatOperatorErrorEnvelope,
  toOperatorErrorEnvelope,
} from "../src/operator/error-envelope.js";
import { usage } from "../src/cli/usage.js";
import type { RunRecord } from "../src/records/contracts.js";
import { createKnowledgeContinuationReceipt } from "../src/records/knowledge-continuation.js";
import type { ChangedFileEvidence } from "../src/impact/contracts.js";
import type { WorkflowOutcomeFindingV1 } from "../src/workflow-contracts/contracts.js";
import { canonicalizeJsonEvidence, parseJsonEvidence } from "../src/json-evidence.js";
import { canonicalDigest } from "../src/content-ir/canonical.js";
import {
  sealQualityValidationBinding,
  sealQualityValidatorReceipt,
} from "../src/evaluation-report/index.js";
import { explainFindingCode } from "../src/operator/cli-format.js";
import {
  buildRunResultV1,
  collectRunResultNextSteps,
  decodeRunResultV1,
  formatRunSummary,
  projectHumanReviewFindings,
  projectRunPresentationView,
  runSummaryLineBudget,
  serializeRunResultV1,
} from "../src/operator/index.js";
import {
  buildRunHumanNextCommand,
  formatRunFailureDiagnosticLines,
  parsePatchFileStats,
  staleRevisionRecovery,
  type RunSummaryPublicationOutcome,
} from "../src/operator/run-summary.js";
import {
  createWorkflowOutcome,
  workflowOutcomeStepEvidence,
} from "../src/workflow-contracts/outcome.js";
import {
  authoringReviewFindingsRecord,
  UNADMITTED_AUTHORING_EVALUATOR_MARKDOWN,
} from "./helpers/authoring-review-record.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

// Reason literals transcribed from `staleRevisionRecovery` in
// src/operator/run-summary.ts. Never recompute them through the selector under
// test: assertions derived from it pass even when its phase literals are swapped.
const PRE_WRITE_STALE_REASON =
  "GitLab's target branch moved before the write started; no run was created. Check this workspace with doctor, then retry, or fetch the merge-request target branch and pass --revision with its new head commit.";
const POST_WRITE_STALE_REASON =
  "The run base is not an ancestor of GitLab's target branch. Merge it into the target branch, then run this to republish the preserved write without re-running the workflow; or start a new run from a commit on the target branch.";
const POST_WRITE_STALE_REASON_WITHOUT_REPOSITORY =
  "The run base is not an ancestor of GitLab's target branch. Inspect the record, merge its base into the target branch, then republish it with docsfab ship from the run's repository checkout; or start a new run from a commit on the target branch.";
// Transcribed from `ACTIONS["stale-revision"]` in src/delivery/contracts.ts. It
// is the publication failure detail on every production post-write footer, so
// it must agree with the NEXT reason rather than tell the operator to start over.
const SHARED_STALE_REVISION_ACTION =
  "The run base is not an ancestor of GitLab's target branch; for example, it is only on another branch, or the target-branch history was rewritten. Merge it into the target branch, then republish a preserved write with `docsfab ship <run-id> --repo <path>`; or start a new run from a commit on the target branch.";
const STALE_REVISION_PREFLIGHT_DETAIL = `Local-user GitLab publication preflight failed (stale-revision). ${SHARED_STALE_REVISION_ACTION}`;

function minimalRunRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    schemaVersion: 2,
    id: "run-test-001",
    workflow: "review-documentation",
    repository: {
      sourcePath: "/tmp/example",
      requestedRevision: "HEAD",
      revision: "a".repeat(40),
    },
    workspace: { strategy: "tracked-export", disposable: true },
    status: "succeeded",
    createdAt: "2026-08-10T12:00:00.000Z",
    models: [],
    skills: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0 },
    tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
    steps: [],
    ...overrides,
  };
}

function plannerFailureRecord(code: string): RunRecord {
  return minimalRunRecord({
    workflow: "create-documentation",
    status: "failed",
    instruction: "Create docs/usage.md with sk-private-instruction-canary.",
    error: "Workflow product outcome could not be validated or persisted.",
    steps: [
      {
        id: "plan-documentation",
        title: "Plan documentation",
        kind: "evaluate",
        skill: "plan-documentation",
        mode: "read-only",
        status: "needs-input",
        inference: { attempts: [{ outcome: "succeeded" }] } as never,
        planDiagnostic: {
          schemaVersion: 1,
          kind: "docsfab-documentation-plan-diagnostic",
          code,
          responseSha256: "d".repeat(64),
          responseShape: "json-object",
        },
        summary: "PRIVATE_MODEL_RESPONSE_MUST_NOT_APPEAR",
      },
    ],
  });
}

function compositionRunRecord(): RunRecord {
  const record = minimalRunRecord({ id: "composition-run-001" });
  record.compositionExecution = {
    compositionId: "openai-gpt-5.6-sol-pi",
    evidenceSha256: "e".repeat(64),
    technicalApproval: "not-established",
    roleQualification: "not-established",
    releaseEligible: false,
  } as never;
  record.compositionExecutionAggregate = {
    compositionEvidenceSha256: "e".repeat(64),
    runId: record.id,
    workflow: { id: record.workflow },
    repository: { revision: record.repository.revision },
    aggregateSha256: "f".repeat(64),
    technicalApproval: "not-established",
    roleQualification: "not-established",
    releaseEligible: false,
  } as never;
  return record;
}

function qualityReviewRecord(): RunRecord {
  const revision = "a".repeat(40);
  const evaluationRecord = "1".repeat(64);
  const scoreRecord = "2".repeat(64);
  const evaluatorIdentity = "3".repeat(64);
  const packBinding = "4".repeat(64);
  const markdown = [
    "# Documentation quality evaluation report",
    "",
    "## Validated result summary",
    "",
    "```json",
    JSON.stringify({
      report_contract: "docsfab-quality-report-v0.1",
      target: {
        paths: ["docs/guide.md"],
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
      validation: {
        evaluation: "passed",
        quality_score: "passed",
        report_binding: "passed",
      },
      artifact_locators: {
        evaluation: `record:sha256:${evaluationRecord}`,
        quality_score: `record:sha256:${scoreRecord}`,
        quality_report: "run:run-test-001:evaluate-document-quality:quality-report",
      },
    }),
    "```",
  ].join("\n");
  const selectionBody = {
    workflow: "review-documentation" as const,
    selectorId: "review-documentation:docsfab-documentation-quality:v1" as const,
    workflowSourceSha256: "4".repeat(64),
    repositoryIdentitySha256: createHash("sha256").update("/tmp/example").digest("hex"),
    repositoryRevision: revision,
    inventorySha256: "5".repeat(64),
    targetScope: "documentation-set" as const,
    targetScopeSha256: "6".repeat(64),
    targetPathSetSha256: "d".repeat(64),
    applicabilitySha256: "e".repeat(64),
    documentCount: 1,
    qualityPackManifestSha256: "8".repeat(64),
    qualityPackBindingSha256: packBinding,
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
  const reportSha256 = createHash("sha256").update(markdown, "utf8").digest("hex");
  return minimalRunRecord({
    qualityPack: {
      schemaVersion: 1,
      id: "docsfab-default",
      version: "1.0.0",
      manifestSha256: "8".repeat(64),
      bindingSha256: packBinding,
      skillLockSha256: "9".repeat(64),
      qualityLockSha256: "a".repeat(64),
      qualityBundleSha256: selection.qualityBundleSha256,
      barIds: [selection.profileBarId],
    },
    qualityProfileSelection: selection,
    qualityArtifactValidation: sealQualityValidationBinding({
      runId: "run-test-001",
      repositoryRevision: revision,
      selectionSha256: selection.selectionSha256,
      qualityPackBindingSha256: packBinding,
      evaluatorIdentitySha256: evaluatorIdentity,
      status: "passed",
      failureCode: null,
      artifacts: {
        evaluation: { recordSha256: evaluationRecord, payloadSha256: "b".repeat(64) },
        qualityScore: { recordSha256: scoreRecord, payloadSha256: "c".repeat(64) },
        candidateReport: { recordSha256: "d".repeat(64), payloadSha256: reportSha256 },
        finalReport: { recordSha256: "e".repeat(64), payloadSha256: reportSha256 },
      },
      validatorAssets: {
        evaluationScriptSha256: "65".padStart(64, "0"),
        evaluationSchemaSha256: "f".repeat(64),
        qualityScoreScriptSha256: "71".padStart(64, "0"),
        reportScriptSha256: "72".padStart(64, "0"),
      },
      validators: {
        evaluation: qualityValidatorReceipt("evaluation", [
          "b".repeat(64),
          "f".repeat(64),
          selection.profilePayloadSha256,
        ]),
        qualityScore: qualityValidatorReceipt("quality-score", ["c".repeat(64)]),
        reportBinding: qualityValidatorReceipt("report-binding", [
          "b".repeat(64),
          reportSha256,
          selection.profilePayloadSha256,
          "c".repeat(64),
        ]),
      },
    }),
    tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
    steps: [
      {
        id: "evaluate-document-quality",
        title: "Evaluate document quality",
        kind: "evaluate",
        skill: "evaluate-document-quality",
        mode: "read-only",
        status: "succeeded",
        evaluateEvidence: {
          schemaVersion: 1,
          kind: "docsfab-evaluate-step-evidence",
          evaluatorIdentitySha256: evaluatorIdentity,
          toolPolicySha256: "3".repeat(64),
          acceptancePolicySha256: "4".repeat(64),
        },
        summary: markdown,
      },
    ],
  });
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

describe("canonical evaluator report selection", () => {
  it("requires the canonical id, skill, succeeded status, and string summary", () => {
    const valid = qualityReviewRecord();
    expect(canonicalEvaluatorSummary(valid)).toBe(valid.steps[0]?.summary);
    const step = valid.steps[0]!;
    const variant = (overrides: Record<string, unknown>): RunRecord =>
      ({ ...valid, steps: [{ ...step, ...overrides }] }) as RunRecord;
    expect(canonicalEvaluatorSummary(variant({ id: "other-evaluator" }))).toBeNull();
    expect(canonicalEvaluatorSummary(variant({ summary: undefined }))).toBeNull();
    expect(canonicalEvaluatorSummary(variant({ summary: 42 }))).toBeNull();
    expect(canonicalEvaluatorSummary(variant({ status: "failed" }))).toBeNull();
  });
});

function currentAuditRecordWithFindings(codes: readonly string[], modelSummary: string): RunRecord {
  const record: RunRecord = {
    schemaVersion: 2,
    id: "run-test-001",
    workflow: "review-documentation",
    repository: {
      sourcePath: "/tmp/example",
      requestedRevision: "HEAD",
      revision: "a".repeat(40),
    },
    workspace: { strategy: "tracked-export", disposable: true },
    status: "succeeded",
    createdAt: "2026-08-10T12:00:00.000Z",
    startedAt: "2026-08-10T12:00:00.000Z",
    completedAt: "2026-08-10T12:00:01.000Z",
    durationMs: 1_000,
    models: [],
    skills: [],
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
      turns: 0,
    },
    tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
    steps: [
      {
        id: "audit-documentation",
        title: "Audit documentation",
        kind: "inference",
        skill: "audit-documentation",
        mode: "read-only",
        status: "succeeded",
        startedAt: "2026-08-10T12:00:00.000Z",
        completedAt: "2026-08-10T12:00:01.000Z",
        durationMs: 1_000,
        summary: modelSummary,
      },
    ],
  };
  const evidence = workflowOutcomeStepEvidence(record, "audit-documentation");
  const findings: WorkflowOutcomeFindingV1[] = codes.map((code, index) => ({
    id: `finding:${String(index + 1).padStart(2, "0")}-${code}`,
    kind: "product-gap",
    severity: "blocking",
    code,
    evidenceIds: [evidence.id],
  }));
  record.workflowOutcome = createWorkflowOutcome(
    {
      disposition: "not-ready",
      findings,
      evidence: [evidence],
      limitations: [],
      openDecisions: [],
      producedArtifacts: [],
    },
    record,
  );
  return record;
}

describe("run CLI output flags", () => {
  it("parses --verbose, --json, and --show-scan independently", () => {
    expect(
      parseRunArguments(["review-documentation", "--repo", "repository", "--verbose"]),
    ).toMatchObject({
      verbose: true,
      json: false,
      showScan: false,
    });
    expect(
      parseRunArguments(["review-documentation", "--repo", "repository", "--json"]),
    ).toMatchObject({
      verbose: false,
      json: true,
      showScan: false,
    });
    expect(
      parseRunArguments(["review-documentation", "--repo", "repository", "--show-scan"]),
    ).toMatchObject({
      verbose: false,
      json: false,
      showScan: true,
    });
  });

  it("rejects --verbose with --json", () => {
    expect(() =>
      parseRunArguments(["review-documentation", "--repo", "repository", "--verbose", "--json"]),
    ).toThrow("cannot be combined");
  });

  it("parses public --quiet independently and rejects it combined with --verbose (#314)", () => {
    expect(
      parseRunArguments(["review-documentation", "--repo", "repository", "--quiet"]),
    ).toMatchObject({
      quiet: true,
      verbose: false,
      json: false,
    });
    expect(parseRunArguments(["review-documentation", "--repo", "repository"])).toMatchObject({
      quiet: false,
    });
    // --json wins: --quiet parses cleanly alongside --json, no conflict.
    expect(
      parseRunArguments(["review-documentation", "--repo", "repository", "--quiet", "--json"]),
    ).toMatchObject({
      quiet: true,
      json: true,
    });
    expect(() =>
      parseRunArguments(["review-documentation", "--repo", "repository", "--quiet", "--verbose"]),
    ).toThrow("cannot be combined with --verbose");
    expect(() =>
      parseRunArguments(["review-documentation", "--repo", "repository", "--quiet", "--quiet"]),
    ).toThrow("must not be duplicated");
  });

  it("documents public --quiet on run and do (#314)", () => {
    expect(usage()).toMatch(/docsfab run <workflow>[\s\S]*?\[--quiet\]/u);
    expect(usage()).toMatch(/docsfab do "<outcome request>"[\s\S]*?\[--quiet\]/u);
    expect(usage()).toContain(
      "docsfab reports serve [--bind 127.0.0.1|0.0.0.0] [--port <port>] [--state-dir <path>]",
    );
    expect(usage()).toContain("DOCSFAB_REPORT_BASE_URL");
  });

  it("requires explicit input for write workflows; write and draft MR are the default", () => {
    expect(
      parseRunArguments([
        "create-documentation",
        "--repo",
        "repository",
        "--instruction",
        "Create the approved task guide.",
      ]),
    ).toMatchObject({
      workflow: "create-documentation",
      instruction: "Create the approved task guide.",
      allowWrite: true,
      draftMr: true,
      remoteName: "origin",
    });
    expect(
      parseRunArguments([
        "create-documentation",
        "--instruction",
        "Create the approved task guide.",
        "--patch-only",
      ]),
    ).toMatchObject({
      allowWrite: true,
      draftMr: false,
    });
    expect(() =>
      parseRunArguments(["restructure-documentation", "--repo", "repository", "--allow-write"]),
    ).toThrow("requires a concrete --instruction <text> value");
    expect(
      parseRunArguments([
        "restructure-documentation",
        "--repo",
        "repository",
        "--instruction",
        "Split the installation guide.",
      ]),
    ).toMatchObject({
      allowWrite: true,
      draftMr: true,
      remoteName: "origin",
    });
  });
});

describe("createPrintProgressHandler", () => {
  it("suppresses model text unless verbose", () => {
    const chunks: string[] = [];
    const write = (text: string): boolean => {
      chunks.push(text);
      return true;
    };
    const quiet = createPrintProgressHandler(false);
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = write as typeof process.stderr.write;
    try {
      quiet({
        sequence: 1,
        type: "text",
        runId: "run-1",
        stepId: "audit",
        text: "secret model prose",
      });
      quiet({
        sequence: 2,
        type: "step-status",
        runId: "run-1",
        stepId: "audit",
        status: "running",
      });
    } finally {
      process.stderr.write = original;
    }
    expect(chunks.join("")).not.toContain("secret model prose");
    expect(chunks.join("")).toContain("step audit: running");
  });

  it("streams model text to stderr when verbose", () => {
    const chunks: string[] = [];
    const write = (text: string): boolean => {
      chunks.push(text);
      return true;
    };
    const verbose = createPrintProgressHandler(true);
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = write as typeof process.stderr.write;
    try {
      verbose({ sequence: 1, type: "text", runId: "run-1", stepId: "audit", text: "model prose" });
    } finally {
      process.stderr.write = original;
    }
    expect(chunks.join("")).toContain("model prose");
  });
});

describe("run summary and JSON envelope", () => {
  it("preserves safe credential findings in ordinary and work-unit initial JSON", () => {
    const finding = {
      code: "credential-like-content" as const,
      location: "docs/quickstart.md:23",
      rule: "credential.nvidia-api-key",
    };
    const contract = createWorkUnitMachineContract({
      workUnitFingerprint: "d".repeat(64),
      repositoryIdentitySha256: "e".repeat(64),
      machineChecks: [
        { checkKind: "npm-script", commandId: "check", expectedOutcomeClass: "pass" },
      ],
      acceptanceAuthority: "host-deterministic",
      trackerMutation: "not-authorized",
    });
    for (const workUnitMachineContracts of [undefined, [contract]]) {
      const record = minimalRunRecord({
        workflow: "release-documentation-readiness",
        credentialFindings: [finding],
        ...(workUnitMachineContracts ? { workUnitMachineContracts } : {}),
      });
      const result = buildRunResultV1({
        record,
        recordPath: "/state/initial-credential-findings.json",
        exitCode: 0,
        repositoryPath: "/example",
      });
      const shown = JSON.parse(serializeRunResultCliJson(result, record));
      expect(shown.credentialFindings).toEqual([finding]);
      expect(shown.workUnitMachineContracts).toEqual(workUnitMachineContracts);
      const { resultSha256, ...body } = shown;
      expect(resultSha256).toBe(
        createHash("sha256").update(canonicalizeJsonEvidence(body), "utf8").digest("hex"),
      );
      expect(decodeRunResultV1(shown)).toEqual(shown);

      const injected = {
        ...result,
        credentialFindings: [{ ...finding, snippet: "private scanner evidence" }],
      };
      expect(() => serializeRunResultCliJson(injected, record)).toThrow();
    }
  });

  it("shows admitted authoring findings without changing product or JSON semantics", () => {
    const record = authoringReviewFindingsRecord();
    const reviewFindingsProjection = projectHumanReviewFindings(record);
    expect(reviewFindingsProjection).toMatchObject({
      availability: "partial",
      artifactLocator: null,
    });
    expect(reviewFindingsProjection?.findings.map((finding) => finding.code)).toEqual([
      "TASK-001",
      "FACT-001",
    ]);

    const context = {
      record,
      recordPath: "/private/state/authoring-findings-run-001.json",
      exitCode: 0 as const,
      repositoryPath: "/tmp/example",
      reviewFindingsProjection,
      tty: false,
    };
    const human = formatRunSummary(context).join("\n");
    expect(human).toContain("PRODUCT\n  Product disposition: inconclusive");
    expect(human).toContain("Product findings: structured-product-evidence-unavailable");
    expect(human).toContain("REVIEW FINDINGS\n  Availability: partial (2)");
    expect(human).toContain("[warning] FACT-001 at docs/usage.md:12");
    expect(human).toContain("technical-issue=TECH-001");
    expect(human).toContain("[info] TASK-001 at docs/usage.md:20");
    expect(human).toContain("Artifact: none; source: admitted run-step summaries");
    expect(human).toContain("Limitation: review-findings-unparsed:evaluate-document-quality");
    expect(human).not.toContain(UNADMITTED_AUTHORING_EVALUATOR_MARKDOWN);

    const input = {
      record,
      recordPath: context.recordPath,
      exitCode: context.exitCode,
      repositoryPath: context.repositoryPath,
    };
    const existingJson = serializeRunResultV1(buildRunResultV1(input));
    const projectedJson = serializeRunResultV1(
      buildRunResultV1({ ...input, reviewFindingsProjection }),
    );
    expect(projectedJson).toBe(existingJson);
    const result = decodeRunResultV1(parseJsonEvidence(projectedJson));
    expect(result.product.disposition).toBe("inconclusive");
    expect(result.product.findings).toEqual(["structured-product-evidence-unavailable"]);
    expect(result.reviewFindings?.map((finding) => finding.code)).toEqual(["TASK-001", "FACT-001"]);
    expect(result.reviewFindingsProjection).toBeUndefined();
    expect(result.quality).toBeNull();
  });

  it("keeps default audit summary under forty lines", () => {
    const record = minimalRunRecord();
    const lines = formatRunSummary({
      record,
      recordPath: "/private/state/run-test-001.json",
      exitCode: 0,
      repositoryPath: "/tmp/example",
      tty: false,
    });
    expect(runSummaryLineBudget(lines)).toBeLessThanOrEqual(40);
    expect(lines.join("\n")).toContain("EXECUTION");
    expect(lines.join("\n")).toContain("PRODUCT");
    expect(lines.join("\n")).toContain("Product disposition: legacy-no-product-disposition");
    expect(lines.join("\n")).toContain("Product disposition meaning:");
  });

  it("emits one parseable RunResultV1 object", () => {
    const record = minimalRunRecord();
    const envelope = buildRunResultV1({
      record,
      recordPath: "/private/state/run-test-001.json",
      exitCode: 0,
      repositoryPath: "/tmp/example",
      nextSteps: [],
    });
    const serialized = serializeRunResultV1(envelope);
    expect(() => parseJsonEvidence(serialized)).not.toThrow();
    const parsed = decodeRunResultV1(parseJsonEvidence(serialized));
    expect(parsed.kind).toBe("docsfab-run-result");
    expect(parsed.execution.runId).toBe("run-test-001");
    expect(parsed.execution.patchSha256).toBeNull();
    expect(parsed.execution.docChangeDelta).toBeNull();
    expect(parsed.htmlReport).toBeNull();
    expect(parsed.product.disposition).toBe("legacy-no-product-disposition");
  });

  it("prints the hosted HTML report URL on the QUALITY footer and JSON envelope", () => {
    const record = qualityReviewRecord();
    const url = "http://127.0.0.1:8787/reports/run-test-001/";
    const htmlReport = {
      url,
      path: "/private/state/reports/run-test-001/index.html",
      digestSha256: "c".repeat(64),
    };
    const lines = formatRunSummary({
      record,
      recordPath: "/private/state/run-test-001.json",
      exitCode: 0,
      repositoryPath: "/tmp/example",
      htmlReportUrl: url,
      tty: false,
    });
    expect(lines).toContain("QUALITY");
    expect(lines).toContain(`  Report: ${url}`);
    expect(lines.join("\n")).not.toContain("artifact-digest:");
    const envelope = buildRunResultV1({
      record,
      recordPath: "/private/state/run-test-001.json",
      exitCode: 0,
      repositoryPath: "/tmp/example",
      nextSteps: [],
      htmlReport,
    });
    expect(envelope.htmlReport).toEqual(htmlReport);
    expect(Object.keys(envelope.htmlReport ?? {}).sort()).toEqual(["digestSha256", "path", "url"]);
    expect(decodeRunResultV1(parseJsonEvidence(serializeRunResultV1(envelope))).htmlReport).toEqual(
      htmlReport,
    );
  });

  it("labels intentional Markdown omission in human report guidance", () => {
    const record = qualityReviewRecord();
    const context = {
      record,
      recordPath: "/private/state/run-test-001.json",
      exitCode: 0 as const,
      repositoryPath: "/tmp/example",
      htmlReportUrl: "http://127.0.0.1:8787/reports/run-test-001/",
      htmlReportPath: "/private/state/reports/run-test-001/index.html",
      markdownReportAvailable: false,
      markdownReportUnavailableReason: "byte-bound" as const,
      reportServeCommand: "docsfab reports serve --state-dir '/private/state' --port 8787",
      tty: false,
    };
    const human = formatRunSummary(context).join("\n");
    expect(human).toContain(
      "Limitation: no structured limitations were projected; inspect the retained evaluator report.",
    );
    expect(human).toContain("Markdown path: unavailable (byte-bound)");
    expect(collectRunResultNextSteps(context).join(" ")).toContain(
      "evaluator Markdown artifact is unavailable (byte-bound)",
    );
  });

  it("makes the immutable composition boundary visible in human and JSON output", () => {
    const record = compositionRunRecord();
    const lines = formatRunSummary({
      record,
      recordPath: "/private/state/composition-run-001.json",
      exitCode: 0,
      repositoryPath: "/tmp/example",
      tty: false,
    });
    expect(lines.some((line) => line.includes("Execution mode"))).toBe(false);
    expect(lines).toContain("  Composition: openai-gpt-5.6-sol-pi");
    expect(lines).toContain(`  Composition evidence: ${"e".repeat(64)}`);
    expect(lines).toContain(`  Composition aggregate: ${"f".repeat(64)}`);
    expect(lines).toContain("  Technical approval: not-established");
    expect(lines).toContain("  Role qualification: not-established");
    expect(lines).toContain("  Release eligible: no");

    const envelope = buildRunResultV1({
      record,
      recordPath: "/private/state/composition-run-001.json",
      exitCode: 0,
      repositoryPath: "/tmp/example",
      nextSteps: [],
    });
    expect(envelope.compositionExecution).toEqual({
      compositionId: "openai-gpt-5.6-sol-pi",
      evidenceSha256: "e".repeat(64),
      aggregateSha256: "f".repeat(64),
      technicalApproval: "not-established",
      roleQualification: "not-established",
      releaseEligible: false,
    });
    expect(decodeRunResultV1(parseJsonEvidence(serializeRunResultV1(envelope)))).toEqual(envelope);
  });

  it("rejects a succeeded composition output whose terminal aggregate was stripped", () => {
    const record = compositionRunRecord();
    delete record.compositionExecutionAggregate;
    expect(() =>
      buildRunResultV1({
        record,
        recordPath: "/private/state/composition-run-001.json",
        exitCode: 0,
        repositoryPath: "/tmp/example",
      }),
    ).toThrow("aggregate evidence that conflicts");
  });

  it("shows at most three glossary Finding lines for a current audit outcome", () => {
    expect(explainFindingCode("audit-rubric-evidence-limited")).toContain(
      "not sufficiently assessed",
    );
    const modelSummary = "MODEL_STEP_SUMMARY_BLOB_MUST_NOT_LEAK";
    const codes = [
      "audit-documentation-gap",
      "audit-search-blocked",
      "audit-search-incomplete",
      "extra-finding-delta",
      "extra-finding-echo",
    ] as const;
    const record = currentAuditRecordWithFindings([...codes], modelSummary);
    const lines = formatRunSummary({
      record,
      recordPath: "/private/state/run-test-001.json",
      exitCode: 0,
      repositoryPath: "/tmp/example",
      tty: false,
    });
    const text = lines.join("\n");
    const findingLines = lines.filter((line) => line.trimStart().startsWith("Finding:"));
    expect(findingLines).toHaveLength(3);
    expect(findingLines).toEqual([
      `  Finding: ${codes[0]} — ${explainFindingCode(codes[0])}`,
      `  Finding: ${codes[1]} — ${explainFindingCode(codes[1])}`,
      `  Finding: ${codes[2]} — ${explainFindingCode(codes[2])}`,
    ]);
    expect(lines).toContain("  Product findings omitted: 2");
    expect(lines.some((line) => line.trimStart().startsWith("Product findings:"))).toBe(false);
    expect(text).toContain("Product disposition: not-ready");
    expect(text).toContain("Product disposition meaning:");
    expect(text).not.toContain(modelSummary);

    const envelope = buildRunResultV1({
      record,
      recordPath: "/private/state/run-test-001.json",
      exitCode: 0,
      repositoryPath: "/tmp/example",
      nextSteps: [],
    });
    expect(envelope.product.findings).toEqual([...codes]);
  });

  it("does not invent Finding lines for a legacy audit without a projector", () => {
    const record = minimalRunRecord({
      steps: [
        {
          id: "audit-documentation",
          title: "Audit documentation",
          kind: "inference",
          skill: "audit-documentation",
          mode: "read-only",
          status: "succeeded",
          summary: "MODEL_STEP_SUMMARY_BLOB_MUST_NOT_LEAK",
        },
      ],
    });
    const lines = formatRunSummary({
      record,
      recordPath: "/private/state/run-test-001.json",
      exitCode: 0,
      repositoryPath: "/tmp/example",
      tty: false,
    });
    expect(lines.filter((line) => line.trimStart().startsWith("Finding:"))).toEqual([]);
    expect(lines.join("\n")).toContain("Product disposition: legacy-no-product-disposition");
    expect(lines.some((line) => line.trimStart().startsWith("Product findings omitted:"))).toBe(
      false,
    );
  });
});

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

function findSectionLines(lines: readonly string[], header: string): string[] {
  const start = lines.findIndex((line) => {
    const plain = stripAnsi(line);
    return plain === header || plain === `── ${header} ──`;
  });
  if (start === -1) return [];
  const rest = lines.slice(start + 1);
  const end = rest.indexOf("");
  return end === -1 ? rest : rest.slice(0, end);
}

function recordWithChanges(
  files: ChangedFileEvidence[],
  overrides: Partial<RunRecord> = {},
): RunRecord {
  return minimalRunRecord({
    changes: {
      files,
      patch: {
        sha256: "a".repeat(64),
        byteLength: 128,
        lineCount: 8,
        artifactPath: "/private/patches/run-test-001.patch",
        format: "git-diff",
      },
    },
    ...overrides,
  });
}

describe("verdict-first footer (#312)", () => {
  it("composes a nested VERDICT block, plain on a pipe", () => {
    const record = currentAuditRecordWithFindings(["audit-documentation-gap"], "model prose");
    const publication: RunSummaryPublicationOutcome = {
      status: "failed",
      failureCode: "validation-failed",
    };
    const lines = formatRunSummary({
      record,
      recordPath: "/private/state/run-test-001.json",
      exitCode: 0,
      repositoryPath: "/tmp/example",
      publication,
      tty: false,
    });
    expect(lines[0]).toBe("VERDICT");
    expect(findSectionLines(lines, "VERDICT")).toEqual([
      `  review-documentation ${record.id.slice(0, 8)}`,
      "    execution succeeded",
      "    product not-ready",
      "    publication failed",
    ]);
    expect(lines[1]).not.toContain("\u001b[");
  });

  it("colors the VERDICT line on a TTY and stays plain on a pipe", () => {
    vi.stubEnv("TERM", "xterm");
    vi.stubEnv("FORCE_COLOR", undefined);
    const record = minimalRunRecord();
    // Pin terminal and color environment so inherited `TERM=dumb`, `FORCE_COLOR=0`,
    // `CI=true`, or `NO_COLOR=1` cannot change the expected TTY/pipe contrast.
    const tty = formatRunSummary({
      record,
      recordPath: "/private/state/run-test-001.json",
      exitCode: 0,
      repositoryPath: "/tmp/example",
      tty: true,
      ci: false,
      noColor: false,
    });
    const pipe = formatRunSummary({
      record,
      recordPath: "/private/state/run-test-001.json",
      exitCode: 0,
      repositoryPath: "/tmp/example",
      tty: false,
      ci: false,
      noColor: false,
    });
    expect(findSectionLines(tty, "VERDICT").join("\n")).toContain("\u001b[");
    expect(findSectionLines(pipe, "VERDICT").join("\n")).not.toContain("\u001b[");
  });

  it("omits NEXT when execution succeeded with no patch and no publication request", () => {
    const record = minimalRunRecord();
    const lines = formatRunSummary({
      record,
      recordPath: "/private/state/run-test-001.json",
      exitCode: 0,
      repositoryPath: "/tmp/example",
      tty: false,
    });
    expect(lines).not.toContain("NEXT");
  });

  it("suggests saved evidence inspection when a succeeded write left a local patch", () => {
    const record = recordWithChanges([{ path: "README.md", status: "modified" }]);
    const lines = formatRunSummary({
      record,
      recordPath: "/private/state/run-test-001.json",
      exitCode: 0,
      repositoryPath: "/tmp/example",
      tty: false,
    });
    expect(findSectionLines(lines, "NEXT")).toEqual([
      `  docsfab runs show ${record.id} --state-dir /private/state --json`,
      "  Reason: Inspect the saved product evidence and review the local patch before deciding whether to publish.",
    ]);
  });

  it("gives an evidence-unavailable failure a non-looping readiness action", () => {
    for (const status of ["needs-input", "needs-human-decision"] as const) {
      const record = minimalRunRecord({ status });
      const lines = formatRunSummary({
        record,
        recordPath: "/private/state/run-test-001.json",
        exitCode: 0,
        repositoryPath: "/tmp/example",
        tty: false,
      });
      expect(findSectionLines(lines, "NEXT")).toEqual([
        "  docsfab doctor --repo '<original target checkout>' --live",
        "  Reason: Against the original target checkout, verify runtime and provider readiness, then rerun the original workflow; structured failure evidence is unavailable.",
      ]);
    }
  });

  it("points a failed run without a typed recovery at the saved record", () => {
    const record = minimalRunRecord({ status: "failed" });
    const lines = formatRunSummary({
      record,
      recordPath: "/private/state/run-test-001.json",
      exitCode: 1,
      repositoryPath: "/tmp/example",
      tty: false,
    });
    expect(findSectionLines(lines, "NEXT")).toEqual([
      `  docsfab runs show ${record.id} --state-dir /private/state --json`,
      "  Reason: Inspect the saved run for the failing step and coded rejection. Do not retry unchanged inference from this output.",
      `  Why: docsfab why ${record.id} --state-dir /private/state`,
    ]);
  });

  it("resumes only a knowledge stop with a retained receipt", () => {
    const record = minimalRunRecord({
      workflow: "create-documentation",
      status: "needs-input",
      error: "needs-authorization",
      knowledgeContinuationReceipt: createKnowledgeContinuationReceipt({
        schemaVersion: 1,
        kind: "docsfab-knowledge-continuation-receipt",
        originalRunId: "run-test-001",
        repositoryIdentitySha256: "a".repeat(64),
        repositoryRevision: "a".repeat(40),
        workflow: "create-documentation",
        instructionSha256: "a".repeat(64),
        candidateSnapshotSha256: "a".repeat(64),
        candidateArtifactSha256: "a".repeat(64),
        candidateBytesSha256: "a".repeat(64),
        originalTaskArtifactSha256: "a".repeat(64),
        originalTaskBindingArtifactSha256: "a".repeat(64),
        originalTaskBindingBytesSha256: "a".repeat(64),
        originArtifactSha256: "a".repeat(64),
        lineageArtifactSha256: "a".repeat(64),
        taskLineageProjectionSha256: "a".repeat(64),
        targetConflictReceipt: null,
        targetConflictReceiptSha256: null,
      }),
    });
    const next = buildRunHumanNextCommand({
      record,
      recordPath: "/private/state/run-test-001.json",
      exitCode: 2,
      repositoryPath: "/tmp/example",
    });
    expect(next?.command).toContain("--resume-from");
    expect(next?.command).not.toContain("docsfab doctor");
    expect(next?.reason).toContain("InputAsk");
    expect(next?.reason).not.toContain("docsfab doctor");
    const lines = formatRunSummary({
      record,
      recordPath: "/private/state/run-test-001.json",
      exitCode: 2,
      repositoryPath: "/tmp/example",
      tty: false,
    });
    expect(findSectionLines(lines, "NEXT").join("\n")).not.toContain("docsfab doctor");

    const withoutReceipt = minimalRunRecord({
      workflow: "create-documentation",
      status: "needs-input",
      error: "needs-authorization",
    });
    const unavailable = buildRunHumanNextCommand({
      record: withoutReceipt,
      recordPath: "/private/state/run-test-001.json",
      exitCode: 2,
      repositoryPath: "/tmp/example",
    });
    expect(unavailable?.command).toBe(
      "docsfab runs show run-test-001 --state-dir /private/state --json",
    );
    expect(unavailable?.reason).toContain("no retained continuation receipt");
    expect(unavailable?.reason).toContain("--resume-from cannot bind it");
  });

  it("keeps invalid model output distinct from governed input in human and JSON output", () => {
    const cases = [
      {
        code: "invalid-envelope",
        category: "invalid-model-output",
        disposition: "unavailable",
        nextCommand:
          "docsfab run create-documentation --repo '<original target checkout>' --instruction '<repeat the original approved instruction>' --patch-only",
        nextPhrase: "no missing user input was established",
      },
      {
        code: "missing-information",
        category: "missing-governed-input",
        disposition: "needs-input",
        nextCommand:
          "docsfab run create-documentation --repo '<original target checkout>' --instruction '<amended instruction with required governed input>' --patch-only",
        nextPhrase: "required governed input",
      },
    ] as const;
    for (const expected of cases) {
      const record = plannerFailureRecord(expected.code);
      const context = {
        record,
        recordPath: "/private/state/run-test-001.json",
        exitCode: 1 as const,
        repositoryPath: "/tmp/example",
        tty: false,
      };
      const human = formatRunSummary(context).join("\n");
      const nextSteps = collectRunResultNextSteps(context);
      const selectedAction = buildRunHumanNextCommand(context)!;
      const json = buildRunResultV1({
        record,
        recordPath: context.recordPath,
        exitCode: 1,
        repositoryPath: context.repositoryPath,
        nextSteps,
      });
      expect(human).toContain(`Product disposition: ${expected.disposition}`);
      expect(human).toContain(`Planner diagnostic: ${expected.code}`);
      expect(human).toContain(`Planner diagnostic category: ${expected.category}`);
      expect(human).toContain(expected.nextCommand);
      expect(nextSteps.join(" ")).toContain(expected.nextPhrase);
      expect(nextSteps.filter((step) => step === selectedAction.command)).toHaveLength(1);
      expect(nextSteps.filter((step) => step === selectedAction.reason)).toHaveLength(1);
      expect(json.plannerDiagnostic).toMatchObject({
        category: expected.category,
        code: expected.code,
      });
      expect(human).not.toContain("legacy-no-product-disposition");
      expect(human).not.toContain("docsfab runs show");
      expect(human).not.toContain("PRIVATE_MODEL_RESPONSE");
      expect(findSectionLines(formatRunSummary(context), "NEXT").join("\n")).not.toContain(
        "sk-private-instruction-canary",
      );
      expect(serializeRunResultV1(json)).not.toContain("PRIVATE_MODEL_RESPONSE");
      expect(serializeRunResultV1(json)).not.toContain("sk-private-instruction-canary");
    }
  });

  it("resumes with one-shot publish, quoting an unsafe path, when --draft-mr publication failed", () => {
    const record = minimalRunRecord();
    const publication: RunSummaryPublicationOutcome = {
      status: "failed",
      failureCode: "validation-failed",
      recoveryCommand: "docsfab publish run-test-001 --repo /tmp/example --draft-mr --execute …",
    };
    const lines = formatRunSummary({
      record,
      recordPath: "/private/state/run-test-001.json",
      exitCode: 0,
      repositoryPath: "/tmp/my repo",
      publication,
      tty: false,
    });
    expect(findSectionLines(lines, "NEXT")).toEqual([
      `  docsfab publish ${record.id} --repo '/tmp/my repo' --state-dir /private/state`,
      "  Reason: Retry publication of this run; do not re-run the workflow.",
    ]);
    expect(findSectionLines(lines, "PUBLICATION")).toEqual([
      "  Status: failed (validation-failed)",
      `  Recovery: ${publication.recoveryCommand}`,
    ]);
  });

  it("does not suggest publish when publication was not attempted", () => {
    const record = recordWithChanges([{ path: ".docsfab.json", status: "added" }]);
    const lines = formatRunSummary({
      record,
      recordPath: "/private/state/run-test-001.json",
      exitCode: 0,
      repositoryPath: "/tmp/example",
      publication: { status: "failed", failureCode: "publication-not-attempted" },
      tty: false,
    });
    expect(findSectionLines(lines, "NEXT")).toEqual([
      `  docsfab runs show ${record.id}`,
      "  Reason: Publication was not attempted; the patch did not change documentation files.",
    ]);
    expect(findSectionLines(lines, "VERDICT").join("\n")).toContain("publication failed");
    expect(findSectionLines(lines, "PATCH")).toContain("  No documentation files.");
  });

  it("keeps local patch guidance inspect-first across unknown and unsuccessful outcomes", () => {
    const files: ChangedFileEvidence[] = [{ path: "docs/usage.md", status: "modified" }];
    const changes = recordWithChanges(files).changes!;
    const unknown = recordWithChanges(files);
    const inconclusive = authoringReviewFindingsRecord();
    inconclusive.changes = structuredClone(changes);
    const negative = currentAuditRecordWithFindings(
      ["documentation-quality-below-threshold"],
      "model prose",
    );
    negative.changes = structuredClone(changes);

    for (const record of [unknown, inconclusive, negative]) {
      const context = {
        record,
        recordPath: `/private/custom state/${record.id}.json`,
        exitCode: 0 as const,
        repositoryPath: "/tmp/example",
        tty: false,
      };
      const command = `docsfab runs show ${record.id} --state-dir '/private/custom state' --json`;
      // An authoring evidence-limitation is a capability wall: same inspect-first
      // command, but the reason names the wall and redirects.
      const reason =
        record === inconclusive
          ? "Product inconclusive at a wall: evidence-limitation structured-product-evidence-unavailable (the admitted evidence cannot support a complete result). This is a capability or policy wall, not missing input. Change the request instead: narrow or retarget it, wait for the capability, or accept the outcome as incomplete. Do not retry the unchanged request. The retained local patch does not resolve the wall; review it before any publish."
          : "Inspect the saved product evidence and review the local patch before deciding whether to publish.";
      expect(findSectionLines(formatRunSummary(context), "NEXT")).toEqual([
        `  ${command}`,
        `  Reason: ${reason}`,
      ]);
      expect(collectRunResultNextSteps(context)).toEqual([command, reason]);
      expect(collectRunResultNextSteps(context).join(" ")).not.toContain("docsfab publish");
      expect(collectRunResultNextSteps(context).join(" ")).not.toContain("apply it");
    }
  });

  it("does not print No documentation files when the patch changed docs", () => {
    const record = recordWithChanges([
      { path: ".docsfab.json", status: "added" },
      { path: "docs/get-started/faq.md", status: "added" },
    ]);
    const lines = formatRunSummary({
      record,
      recordPath: "/private/state/run-test-001.json",
      exitCode: 0,
      repositoryPath: "/tmp/example",
      publication: { status: "failed", failureCode: "publication-not-attempted" },
      tty: false,
    });
    expect(findSectionLines(lines, "PATCH")).toEqual([
      "  .docsfab.json",
      "  docs/get-started/faq.md",
    ]);
    expect(lines.join("\n")).not.toContain("No documentation files.");
  });

  it("uses the ship NEXT for post-write stale-revision without claiming an empty documentation patch", () => {
    const record = recordWithChanges([
      { path: ".docsfab.json", status: "added" },
      { path: "docs/get-started/faq.md", status: "added" },
    ]);
    const lines = formatRunSummary({
      record,
      recordPath: "/private/state/run-test-001.json",
      exitCode: 0,
      repositoryPath: "/tmp/example",
      publication: {
        status: "failed",
        failureCode: "stale-revision",
        phase: "post-write",
        // Production carries this detail (src/cli/run/delivery.ts).
        detail: STALE_REVISION_PREFLIGHT_DETAIL,
      },
      tty: false,
    });
    expect(findSectionLines(lines, "NEXT")).toEqual([
      `  docsfab ship ${record.id} --repo /tmp/example`,
      `  Reason: ${POST_WRITE_STALE_REASON}`,
    ]);
    expect(findSectionLines(lines, "PUBLICATION")).toEqual([
      "  Status: failed (stale-revision)",
      `  ${STALE_REVISION_PREFLIGHT_DETAIL}`,
    ]);
    // The whole screen agrees: the detail must not tell the operator to start
    // over while NEXT is telling them the write is preserved.
    expect(lines.join("\n")).not.toContain("Create a new run at");
    expect(findSectionLines(lines, "PATCH")).toEqual([
      "  .docsfab.json",
      "  docs/get-started/faq.md",
    ]);
    expect(lines.join("\n")).not.toContain("No documentation files.");
  });

  it("tells operators to clean tracked dirt before retrying publish", () => {
    const record = recordWithChanges([{ path: "docs/get-started/faq.md", status: "added" }]);
    const lines = formatRunSummary({
      record,
      recordPath: "/private/state/run-test-001.json",
      exitCode: 0,
      repositoryPath: "/tmp/example",
      publication: { status: "failed", failureCode: "tracked-source-dirty" },
      tty: false,
    });
    expect(findSectionLines(lines, "NEXT")).toEqual([
      `  docsfab publish ${record.id} --repo /tmp/example --state-dir /private/state`,
      "  Reason: Commit, stash, or discard tracked and staged changes first. Untracked files are allowed.",
    ]);
    expect(findSectionLines(lines, "PUBLICATION")).toEqual([
      "  Status: failed (tracked-source-dirty)",
    ]);
  });

  it("recovers multiple remotes with publish --remote", () => {
    const record = recordWithChanges([{ path: "docs/get-started/faq.md", status: "added" }]);
    const lines = formatRunSummary({
      record,
      recordPath: "/private/state/run-test-001.json",
      exitCode: 0,
      repositoryPath: "/tmp/example",
      publication: { status: "failed", failureCode: "ambiguous-remote" },
      tty: false,
    });
    expect(findSectionLines(lines, "NEXT")).toEqual([
      `  docsfab publish ${record.id} --repo /tmp/example --state-dir /private/state`,
      "  Reason: This checkout has more than one Git remote and none is named origin. Pass --remote <name>.",
    ]);
  });

  it("tells operators to restore the Git identity before retrying publish", () => {
    const record = recordWithChanges([{ path: "docs/get-started/faq.md", status: "added" }]);
    const lines = formatRunSummary({
      record,
      recordPath: "/private/state/run-test-001.json",
      exitCode: 0,
      repositoryPath: "/tmp/example",
      publication: { status: "failed", failureCode: "git-identity-drift" },
      tty: false,
    });
    expect(findSectionLines(lines, "NEXT")).toEqual([
      `  docsfab publish ${record.id} --repo /tmp/example --state-dir /private/state`,
      "  Reason: Git user.name or user.email changed after this publication was planned. Set them back to the identity you published with, then run this; the write is preserved. To publish as the new identity, start a new run.",
    ]);
    expect(findSectionLines(lines, "PUBLICATION")).toEqual([
      "  Status: failed (git-identity-drift)",
    ]);
  });

  it("tells operators to remove a refused Git setting before retrying publish", () => {
    const record = recordWithChanges([{ path: "docs/get-started/faq.md", status: "added" }]);
    const lines = formatRunSummary({
      record,
      recordPath: "/private/state/run-test-001.json",
      exitCode: 0,
      repositoryPath: "/tmp/example",
      publication: { status: "failed", failureCode: "git-configuration-refused" },
      tty: false,
    });
    expect(findSectionLines(lines, "NEXT")).toEqual([
      `  docsfab publish ${record.id} --repo /tmp/example --state-dir /private/state`,
      "  Reason: DocsFab refused a Git setting that can run a command, change how it pushes, or turn signing on. Remove it from the file that sets it; `git config --show-origin --list` shows each setting's file. Then run this; the write is preserved. core.sshCommand and core.askPass can move to your global Git config instead, when HOME is an absolute path outside the checkout.",
    ]);
    expect(findSectionLines(lines, "PUBLICATION")).toEqual([
      "  Status: failed (git-configuration-refused)",
    ]);
  });

  it("tells operators to repair the Git checkout before retrying publish", () => {
    const record = recordWithChanges([{ path: "docs/get-started/faq.md", status: "added" }]);
    const lines = formatRunSummary({
      record,
      recordPath: "/private/state/run-test-001.json",
      exitCode: 0,
      repositoryPath: "/tmp/example",
      publication: { status: "failed", failureCode: "git-checkout-unverified" },
      tty: false,
    });
    expect(findSectionLines(lines, "NEXT")).toEqual([
      `  docsfab publish ${record.id} --repo /tmp/example --state-dir /private/state`,
      "  Reason: DocsFab could not verify the checkout's Git setup. Check `git --version` (2.9.5 or newer), `git remote get-url --push --all <remote>` (the one project URL the plan names), `git config --show-origin --list` (no error, a value for every setting), and that `git config --includes --show-origin --null --list | wc -c` is no larger than delivery.gitConfigurationListingMaxBytes, then run this; the write is preserved.",
    ]);
    expect(findSectionLines(lines, "PUBLICATION")).toEqual([
      "  Status: failed (git-checkout-unverified)",
    ]);
  });

  it("hang-indents a publication detail and SCAN summary", () => {
    const record = recordWithChanges([{ path: "docs/get-started/faq.md", status: "added" }], {
      securityScan: {
        ruleSet: "docsfab-local-v2",
        status: "blocked",
        scannedFiles: 15,
        binaryFiles: 0,
        findings: [{ path: "docs/example.md", ruleId: "credential.assigned-secret" }],
      },
      securityScanEffectiveDisposition: { status: "advisory" },
    });
    const lines = formatRunSummary({
      record,
      recordPath: "/private/state/run-test-001.json",
      exitCode: 0,
      repositoryPath: "/tmp/example",
      publication: {
        status: "failed",
        failureCode: "stale-revision",
        detail: STALE_REVISION_PREFLIGHT_DETAIL,
      },
      tty: false,
    });
    expect(findSectionLines(lines, "PUBLICATION")).toEqual([
      "  Status: failed (stale-revision)",
      `  ${STALE_REVISION_PREFLIGHT_DETAIL}`,
    ]);
    // Realistic fixture with no recorded phase: the detail and the NEXT this
    // same screen prints have to agree.
    expect(findSectionLines(lines, "NEXT")).toEqual([
      `  docsfab ship ${record.id} --repo /tmp/example`,
      `  Reason: ${POST_WRITE_STALE_REASON}`,
    ]);
    expect(lines.join("\n")).not.toContain("Create a new run at");
    expect(findSectionLines(lines, "SCAN")).toEqual([
      "  Repository scan: 1 finding(s); effective advisory.",
    ]);
  });

  it("omits EXECUTION and PRODUCT from the --quiet footer", () => {
    const record = recordWithChanges([{ path: "README.md", status: "modified" }]);
    const lines = formatRunSummary({
      record,
      recordPath: "/private/state/run-test-001.json",
      exitCode: 0,
      repositoryPath: "/tmp/example",
      quiet: true,
      tty: false,
    });
    expect(lines[0]).toBe("VERDICT");
    expect(lines).toContain("RECORD");
    expect(lines).toContain("PATCH");
    expect(lines).not.toContain("EXECUTION");
    expect(lines).not.toContain("PRODUCT");
    expect(lines).not.toContain("PUBLICATION");
  });

  it("omits FAILURE from the --quiet footer, but formatRunFailureDiagnosticLines still exposes the reason", () => {
    const record = minimalRunRecord({
      status: "failed",
      error: "model provider refused the request: quota exhausted",
      steps: [
        {
          id: "audit-docs",
          title: "Audit docs",
          skill: "audit-documentation",
          mode: "read-only",
          status: "failed",
          error: "step blew up",
        },
      ],
    });
    const lines = formatRunSummary({
      record,
      recordPath: "/private/state/run-test-001.json",
      exitCode: 1,
      repositoryPath: "/tmp/example",
      quiet: true,
      tty: false,
    });
    // --quiet stops after RECORD, so deliverCliRunResult re-emits this reason on
    // stderr itself (test/cli-run-delivery-quiet.test.ts).
    expect(lines).not.toContain("FAILURE");
    expect(formatRunFailureDiagnosticLines(record)).toEqual([
      "Run run-test-001 failed at step audit-docs.",
      "Step audit-docs failed: step blew up",
      "model provider refused the request: quota exhausted",
    ]);
  });

  it("collapses product findings and limitations that share one code", () => {
    const record = minimalRunRecord({
      workflow: "create-documentation",
      startedAt: "2026-08-10T12:00:00.000Z",
      completedAt: "2026-08-10T12:00:01.000Z",
      durationMs: 1_000,
      tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
      steps: [
        {
          id: "evaluate-document-quality",
          title: "Evaluate document quality",
          kind: "evaluate",
          skill: "evaluate-document-quality",
          mode: "read-only",
          status: "succeeded",
          startedAt: "2026-08-10T12:00:00.000Z",
          completedAt: "2026-08-10T12:00:01.000Z",
          durationMs: 1_000,
        },
      ],
    });
    const evidence = workflowOutcomeStepEvidence(record, "evaluate-document-quality");
    record.workflowOutcome = createWorkflowOutcome(
      {
        disposition: "inconclusive",
        findings: [
          {
            id: "finding:01-structured-product-evidence-unavailable",
            kind: "evidence-limitation",
            severity: "info",
            code: "structured-product-evidence-unavailable",
            evidenceIds: [evidence.id],
          },
        ],
        evidence: [evidence],
        limitations: ["structured-product-evidence-unavailable"],
        openDecisions: [],
        producedArtifacts: [],
      },
      record,
    );
    const lines = formatRunSummary({
      record,
      recordPath: "/private/state/run-test-001.json",
      exitCode: 0,
      repositoryPath: "/tmp/example",
      tty: false,
    });
    const product = findSectionLines(lines, "PRODUCT");
    expect(product).toContain("  Product disposition: inconclusive");
    expect(product).toContain("  Product findings: structured-product-evidence-unavailable");
    expect(product.some((line) => line.trimStart().startsWith("Product limitations:"))).toBe(false);
    expect(product.some((line) => line.trimStart().startsWith("Product open decisions:"))).toBe(
      false,
    );
  });

  it("suggests the merge-request URL when --draft-mr publication succeeded", () => {
    const record = recordWithChanges([{ path: "README.md", status: "modified" }]);
    const publication: RunSummaryPublicationOutcome = {
      status: "succeeded",
      mergeRequestUrl: "https://gitlab.example/group/project/-/merge_requests/1",
    };
    const lines = formatRunSummary({
      record,
      recordPath: "/private/state/run-test-001.json",
      exitCode: 0,
      repositoryPath: "/tmp/example",
      publication,
      tty: false,
    });
    expect(findSectionLines(lines, "NEXT")).toEqual([
      `  ${publication.mergeRequestUrl}`,
      "  Reason: Draft MR is up.",
    ]);
    expect(findSectionLines(lines, "PUBLICATION")).toEqual([
      "  Status: succeeded",
      `  Merge request: ${publication.mergeRequestUrl}`,
    ]);
  });

  it("lists PATCH files with +/- stats from the patch artifact, capped at ten", () => {
    const files = Array.from({ length: 12 }, (_, index) => ({
      path: `docs/file-${index}.md`,
      status: "modified" as const,
    }));
    const record = recordWithChanges(files);
    const patchFileStats = files.slice(0, 3).map((file, index) => ({
      path: file.path,
      insertions: index + 1,
      deletions: index,
    }));
    const lines = formatRunSummary({
      record,
      recordPath: "/private/state/run-test-001.json",
      exitCode: 0,
      repositoryPath: "/tmp/example",
      patchFileStats,
      tty: false,
    });
    const patch = findSectionLines(lines, "PATCH");
    expect(patch).toHaveLength(11);
    expect(patch[0]).toBe("  docs/file-0.md  +1/-0");
    expect(patch[1]).toBe("  docs/file-1.md  +2/-1");
    expect(patch[2]).toBe("  docs/file-2.md  +3/-2");
    expect(patch[3]).toBe("  docs/file-3.md");
    expect(patch[9]).toBe("  docs/file-9.md");
    expect(patch.at(-1)).toBe("  PATCH omitted: 2");
  });

  it("parses per-file +/- stats from a unified diff, and refuses a block/file count mismatch", () => {
    const patchText = [
      "diff --git a/docs/a.md b/docs/a.md",
      "index 111..222 100644",
      "--- a/docs/a.md",
      "+++ b/docs/a.md",
      "@@ -1,2 +1,3 @@",
      " unchanged",
      "-removed one",
      "+added one",
      "+added two",
      "diff --git a/docs/b.md b/docs/b.md",
      "index 333..444 100644",
      "--- a/docs/b.md",
      "+++ b/docs/b.md",
      "@@ -1,1 +1,1 @@",
      "-old",
      "+new",
      "",
    ].join("\n");
    const stats = parsePatchFileStats(patchText, [{ path: "docs/a.md" }, { path: "docs/b.md" }]);
    expect(stats).toEqual([
      { path: "docs/a.md", insertions: 2, deletions: 1 },
      { path: "docs/b.md", insertions: 1, deletions: 1 },
    ]);
    expect(parsePatchFileStats(patchText, [{ path: "docs/a.md" }])).toBeUndefined();
  });

  it("suppresses DocChangeDelta: unavailable on default but shows it under --verbose", () => {
    const record = recordWithChanges([{ path: "README.md", status: "modified" }]);
    const defaultLines = formatRunSummary({
      record,
      recordPath: "/private/state/run-test-001.json",
      exitCode: 0,
      repositoryPath: "/tmp/example",
      tty: false,
    });
    expect(defaultLines.join("\n")).not.toContain("DocChangeDelta: unavailable");
    const verboseLines = formatRunSummary({
      record,
      recordPath: "/private/state/run-test-001.json",
      exitCode: 0,
      repositoryPath: "/tmp/example",
      verbose: true,
      tty: false,
    });
    expect(verboseLines.join("\n")).toContain(
      "DocChangeDelta: unavailable (gap-ledger-unavailable)",
    );
  });

  it("shows a human duration by default and raw milliseconds under --verbose", () => {
    const record = minimalRunRecord({ durationMs: 398_000 });
    const defaultLines = formatRunSummary({
      record,
      recordPath: "/private/state/run-test-001.json",
      exitCode: 0,
      repositoryPath: "/tmp/example",
      tty: false,
    });
    expect(findSectionLines(defaultLines, "EXECUTION")).toContain("  Duration: 6m 38s");
    const verboseLines = formatRunSummary({
      record,
      recordPath: "/private/state/run-test-001.json",
      exitCode: 0,
      repositoryPath: "/tmp/example",
      verbose: true,
      tty: false,
    });
    expect(findSectionLines(verboseLines, "EXECUTION")).toContain("  Duration: 398000ms");
  });

  it("keeps a maximal footer (patch + publication + quality-adjacent findings) readable", () => {
    const files = Array.from({ length: 3 }, (_, index) => ({
      path: `docs/file-${index}.md`,
      status: "modified" as const,
    }));
    const record = currentAuditRecordWithFindings(
      ["audit-documentation-gap", "audit-search-blocked"],
      "model prose that must not leak",
    );
    record.changes = {
      files,
      patch: {
        sha256: "a".repeat(64),
        byteLength: 128,
        lineCount: 8,
        artifactPath: "/private/patches/run-test-001.patch",
        format: "git-diff",
      },
    };
    const publication: RunSummaryPublicationOutcome = {
      status: "succeeded",
      mergeRequestUrl: "https://gitlab.example/group/project/-/merge_requests/9",
    };
    const lines = formatRunSummary({
      record,
      recordPath: "/private/state/run-test-001.json",
      exitCode: 0,
      repositoryPath: "/tmp/example",
      publication,
      tty: false,
    });
    expect(lines[0]).toBe("VERDICT");
    expect(findSectionLines(lines, "VERDICT").join("\n")).toContain("publication succeeded");
    expect(lines.indexOf("NEXT")).toBeLessThan(lines.indexOf("PATCH"));
    expect(lines.indexOf("PATCH")).toBeLessThan(lines.indexOf("RECORD"));
    expect(lines.indexOf("RECORD")).toBeLessThan(lines.indexOf("EXECUTION"));
    expect(lines.indexOf("EXECUTION")).toBeLessThan(lines.indexOf("PRODUCT"));
    expect(lines.indexOf("PRODUCT")).toBeLessThan(lines.indexOf("PUBLICATION"));
    expect(lines.join("\n")).not.toContain("model prose that must not leak");
  });

  it("photographs the FAQ mixed-plane fixture: nested VERDICT, runs show NEXT, PATCH note", () => {
    const record = recordWithChanges(
      [
        { path: ".docsfab.json", status: "modified" },
        { path: ".docsfab/reference-model.json", status: "modified" },
        { path: ".docsfab/lock.json", status: "modified" },
      ],
      {
        workflow: "create-documentation",
        id: "abcdef1234567890abcdef1234567890",
        startedAt: "2026-08-10T12:00:00.000Z",
        completedAt: "2026-08-10T12:00:01.000Z",
        durationMs: 1_000,
        tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
        steps: [
          {
            id: "evaluate-document-quality",
            title: "Evaluate document quality",
            kind: "evaluate",
            skill: "evaluate-document-quality",
            mode: "read-only",
            status: "succeeded",
            startedAt: "2026-08-10T12:00:00.000Z",
            completedAt: "2026-08-10T12:00:01.000Z",
            durationMs: 1_000,
          },
        ],
      },
    );
    const evidence = workflowOutcomeStepEvidence(record, "evaluate-document-quality");
    record.workflowOutcome = createWorkflowOutcome(
      {
        disposition: "inconclusive",
        findings: [
          {
            id: "finding:01-structured-product-evidence-unavailable",
            kind: "evidence-limitation",
            severity: "info",
            code: "structured-product-evidence-unavailable",
            evidenceIds: [evidence.id],
          },
        ],
        evidence: [evidence],
        limitations: ["structured-product-evidence-unavailable"],
        openDecisions: [],
        producedArtifacts: [],
      },
      record,
    );
    const lines = formatRunSummary({
      record,
      recordPath: "/private/state/abcdef12.json",
      exitCode: 0,
      repositoryPath: "/tmp/example",
      publication: { status: "failed", failureCode: "publication-not-attempted" },
      tty: false,
    });
    expect(findSectionLines(lines, "VERDICT")).toEqual([
      "  create-documentation abcdef12",
      "    execution succeeded",
      "    product inconclusive",
      "    publication failed",
    ]);
    expect(findSectionLines(lines, "NEXT")[0]).toBe(`  docsfab runs show ${record.id}`);
    expect(findSectionLines(lines, "PATCH")).toEqual([
      "  .docsfab.json",
      "  .docsfab/reference-model.json",
      "  .docsfab/lock.json",
      "  No documentation files.",
    ]);
  });
});

describe("typed run presentation view", () => {
  it("shares the existing verdict and recovery decision with the human footer", () => {
    const record = minimalRunRecord({ status: "succeeded" });
    const context = {
      record,
      recordPath: "/private/state/run-test-001.json",
      exitCode: 0 as const,
      repositoryPath: "/tmp/example",
      publication: {
        status: "failed" as const,
        failureCode: "stale-revision",
        phase: "post-write" as const,
      },
      tty: false,
    };
    const view = projectRunPresentationView(context);
    const lines = formatRunSummary(context);

    expect(view.verdict).toMatchObject({ execution: "succeeded", publication: "failed" });
    expect(view.publication).toEqual(context.publication);
    expect(view.next).toEqual(buildRunHumanNextCommand(context));
    expect(findSectionLines(lines, "NEXT")).toContain(`  ${view.next!.command}`);
    expect(findSectionLines(lines, "NEXT")).toContain(`  Reason: ${view.next!.reason}`);
    expect(findSectionLines(lines, "VERDICT").join("\n")).toContain("publication failed");
  });

  it("keeps saved delivery lookup separate from the original publication verdict", () => {
    const record = minimalRunRecord();
    const context = {
      record,
      recordPath: "/private/state/run-test-001.json",
      exitCode: 0 as const,
      repositoryPath: "/tmp/example",
      deliveryLookup: {
        status: "refused" as const,
        code: "run-delivery-index-unavailable",
        detail: "The delivery index could not be read.",
        checkedRoot: "/private/receipts",
      },
      tty: false,
    };
    const view = projectRunPresentationView(context);
    const lines = formatRunSummary(context);

    expect(view.deliveryLookup).toEqual(context.deliveryLookup);
    expect(view.publication).toEqual({ status: "not-requested" });
    expect(view.verdict.publication).toBeUndefined();
    expect(findSectionLines(lines, "PUBLICATION")).toContain(
      "  Status: lookup refused (run-delivery-index-unavailable)",
    );
  });
});

describe("doctor --repo", () => {
  it("accepts an explicit repository path", () => {
    expect(parseDoctorArguments(["--repo", "/tmp/example", "--json"])).toMatchObject({
      repositoryPath: "/tmp/example",
      json: true,
    });
  });

  it("rejects unknown doctor options", () => {
    expect(() => parseDoctorArguments(["--not-a-doctor-option"])).toThrow("Unknown doctor option.");
  });
});

describe("stale-revision NEXT split by publication phase", () => {
  // Divergent per-phase fixtures: nothing can pass by matching the other phase.
  const preWriteRepository = "/tmp/conductor/task-a";
  const postWriteRepository = "/tmp/conductor/task-b";
  const postWriteRecordPath = "/private/state-b/run-test-001.json";

  function summaryContext(phase: "pre-write" | "post-write") {
    return {
      record: recordWithChanges([{ path: "docs/get-started/faq.md", status: "modified" }]),
      recordPath:
        phase === "pre-write" ? "/private/state-a/run-test-001.json" : postWriteRecordPath,
      exitCode: 1,
      repositoryPath: phase === "pre-write" ? preWriteRepository : postWriteRepository,
      publication: {
        status: "failed" as const,
        failureCode: "stale-revision",
        phase,
      },
      tty: false,
    };
  }

  // Whole NEXT blocks pinned to literals, so swapped reason strings fail.
  const PRE_WRITE_NEXT = [
    `  docsfab doctor --repo ${preWriteRepository}`,
    `  Reason: ${PRE_WRITE_STALE_REASON}`,
  ];
  const POST_WRITE_NEXT = [
    `  docsfab ship run-test-001 --repo ${postWriteRepository}`,
    `  Reason: ${POST_WRITE_STALE_REASON}`,
  ];

  it("pins each phase to its own shipped reason literal, not only its command", () => {
    const preWrite = findSectionLines(formatRunSummary(summaryContext("pre-write")), "NEXT");
    const postWrite = findSectionLines(formatRunSummary(summaryContext("post-write")), "NEXT");

    expect(preWrite).toEqual(PRE_WRITE_NEXT);
    expect(postWrite).toEqual(POST_WRITE_NEXT);
    expect(preWrite).not.toEqual(postWrite);

    // The discard-versus-preserve clauses; a swap puts each on the wrong phase.
    expect(preWrite.join(" ")).toContain("no run was created.");
    expect(preWrite.join(" ")).not.toContain("preserved write");
    expect(postWrite.join(" ")).toContain("republish the preserved write");
    expect(postWrite.join(" ")).not.toContain("no run was created");

    // Neither phase keeps the superseded shared line.
    expect(preWrite.join(" ")).not.toContain("docsfab ship");
    expect(postWrite.join(" ")).not.toContain("docsfab doctor");
    expect(preWrite.join(" ")).not.toContain("Create a new run at");
    expect(postWrite.join(" ")).not.toContain("Create a new run at");
  });

  it.each([["pre-write", PRE_WRITE_NEXT] as const, ["post-write", POST_WRITE_NEXT] as const])(
    "pins the default render, --quiet, and RunResultV1 nextSteps for %s",
    (phase, expected) => {
      const context = summaryContext(phase);

      expect(findSectionLines(formatRunSummary(context), "NEXT")).toEqual(expected);
      expect(findSectionLines(formatRunSummary({ ...context, quiet: true }), "NEXT")).toEqual(
        expected,
      );

      // `expected` carries the rendered two-space hang indent; nextSteps do not.
      const bare = expected.map((line) => line.slice(2));
      const nextSteps = collectRunResultNextSteps(context);
      expect(nextSteps).toEqual([bare[0], bare[1]?.replace("Reason: ", "")]);

      // Exactly how the CLI builds the JSON envelope (src/cli/run/delivery.ts).
      const envelope = decodeRunResultV1(
        parseJsonEvidence(serializeRunResultV1(buildRunResultV1({ ...context, nextSteps }))),
      );
      expect(envelope.nextSteps).toEqual([bare[0], bare[1]?.replace("Reason: ", "")]);
    },
  );

  it("pins all three staleRevisionRecovery branches to their shipped literals", () => {
    expect(
      staleRevisionRecovery({ phase: "pre-write", repositoryPath: preWriteRepository }),
    ).toEqual({
      command: `docsfab doctor --repo ${preWriteRepository}`,
      reason: PRE_WRITE_STALE_REASON,
    });
    expect(
      staleRevisionRecovery({
        phase: "post-write",
        runId: "run-test-001",
        repositoryPath: postWriteRepository,
      }),
    ).toEqual({
      command: `docsfab ship run-test-001 --repo ${postWriteRepository}`,
      reason: POST_WRITE_STALE_REASON,
    });
    // `docsfab ship` requires --repo, so a portable context keeps the
    // inspect-the-record argv and names ship in prose instead.
    expect(staleRevisionRecovery({ phase: "post-write", runId: "run-test-001" })).toEqual({
      command: "docsfab runs show run-test-001",
      reason: POST_WRITE_STALE_REASON_WITHOUT_REPOSITORY,
    });
    expect(PRE_WRITE_STALE_REASON).not.toBe(POST_WRITE_STALE_REASON);
    expect(POST_WRITE_STALE_REASON).not.toBe(POST_WRITE_STALE_REASON_WITHOUT_REPOSITORY);
  });

  it("tells the operator to push a run base GitLab does not have before ship (#2120)", () => {
    const unpushed = {
      ...summaryContext("post-write"),
      publication: {
        status: "failed" as const,
        failureCode: "run-revision-unpushed",
        phase: "post-write" as const,
      },
    };
    const reason =
      "GitLab does not have the run base commit; it was never pushed. Push it to the target branch, then run this to republish the preserved write without re-running the workflow; or start a new run from a commit on the target branch.";
    expect(findSectionLines(formatRunSummary(unpushed), "NEXT")).toEqual([
      `  docsfab ship run-test-001 --repo ${postWriteRepository}`,
      `  Reason: ${reason}`,
    ]);
    expect(collectRunResultNextSteps(unpushed)).toEqual([
      `docsfab ship run-test-001 --repo ${postWriteRepository}`,
      reason,
    ]);
    expect(
      staleRevisionRecovery({
        phase: "post-write",
        runId: "run-test-001",
        code: "run-revision-unpushed",
      }),
    ).toEqual({
      command: "docsfab runs show run-test-001",
      reason:
        "GitLab does not have the run base commit; it was never pushed. Inspect the record, push its base commit to the target branch, then republish it with docsfab ship from the run's repository checkout; or start a new run from a commit on the target branch.",
    });
    // A stale-revision refusal keeps its own cause.
    expect(buildRunHumanNextCommand(summaryContext("post-write"))?.reason).toBe(
      POST_WRITE_STALE_REASON,
    );
    expect(POST_WRITE_STALE_REASON).not.toContain("never pushed");
  });

  it("reads a failure with no recorded phase as post-write", () => {
    // An outcome without the phase field can only describe a write that already
    // happened, so it must never render the pre-write line.
    const context = summaryContext("post-write");
    const { phase, ...publicationWithoutPhase } = context.publication;
    expect(phase).toBe("post-write");
    const withoutPhase = { ...context, publication: publicationWithoutPhase };

    expect(findSectionLines(formatRunSummary(withoutPhase), "NEXT")).toEqual(POST_WRITE_NEXT);
    expect(findSectionLines(formatRunSummary({ ...withoutPhase, quiet: true }), "NEXT")).toEqual(
      POST_WRITE_NEXT,
    );
    expect(collectRunResultNextSteps(withoutPhase)).toEqual([
      `docsfab ship run-test-001 --repo ${postWriteRepository}`,
      POST_WRITE_STALE_REASON,
    ]);
  });

  it("emits only commands the shipped parsers accept for each phase", async () => {
    const preWriteArgv = buildRunHumanNextCommand(summaryContext("pre-write"))!.command.split(" ");
    expect(preWriteArgv[0]).toBe("docsfab");
    expect(preWriteArgv[1]).toBe("doctor");
    const doctorArguments = parseDoctorArguments(preWriteArgv.slice(2));
    expect(doctorArguments.repositoryPath).toBe(preWriteRepository);
    expect(usage()).toContain(
      "docsfab doctor [--repo <path>] [--use local-review|local-patch|draft-mr] [--live]\n" +
        "                 [--quiet | --verbose] [--json]\n" +
        "    (--quiet keeps the selected-use result, material attention, and next action;\n" +
        "     --verbose adds supporting diagnostics from this invocation; neither adds probes)",
    );

    const postWriteContext = summaryContext("post-write");
    const postWriteArgv = buildRunHumanNextCommand(postWriteContext)!.command.split(" ");
    expect(postWriteArgv.slice(0, 2)).toEqual(["docsfab", "ship"]);
    expect(usage()).toContain("docsfab ship <run-id> --repo <path>");

    // The shipped ship parser accepts this argv and recovers the exact run id.
    const loaded: { path?: string; runId?: string } = {};
    await expect(
      handleShipCommand(postWriteArgv.slice(2), {
        cwd: "/tmp",
        stateDirectory: dirname(postWriteRecordPath),
        log: () => undefined,
        loadRun: async (path: string, runId: string) => {
          loaded.path = path;
          loaded.runId = runId;
          throw new Error("ship-parse-probe");
        },
      } as unknown as Parameters<typeof handleShipCommand>[1]),
    ).rejects.toThrow("ship-parse-probe");
    expect(loaded.runId).toBe(postWriteContext.record.id);
    expect(loaded.path).toBe(
      resolve(dirname(postWriteRecordPath), `${postWriteContext.record.id}.json`),
    );
  });
  it("carries the pre-write recovery into the operator error envelope", () => {
    // The freshness prelude refuses before any run record exists, so the
    // pre-write NEXT reaches the operator through the failure envelope.
    const marked = markPreWriteFreshnessFailure(
      new LocalUserPublicationPreflightError("stale-revision"),
      preWriteRepository,
    );
    const envelope = toOperatorErrorEnvelope(marked);
    const expectedCommand = `docsfab doctor --repo ${preWriteRepository}`;

    expect(envelope.code).toBe("stale-revision");
    expect(envelope.nextAction).toContain(expectedCommand);
    expect(envelope.nextAction).toContain(PRE_WRITE_STALE_REASON);
    expect(envelope.nextAction).not.toContain("docsfab ship");
    expect(envelope.nextAction).not.toContain("preserved write");
    const rendered = formatOperatorErrorEnvelope(envelope);
    expect(rendered).toContain(
      `Next action: ${PRE_WRITE_STALE_REASON} Run \`${expectedCommand}\`.`,
    );
    // The shared typed remediation must not survive alongside it: pre-write has
    // no preserved write to republish, so that sentence would be false here.
    expect(rendered).not.toContain(SHARED_STALE_REVISION_ACTION);
    expect(rendered).not.toContain("republish a preserved write");
    // A plain preflight error of the same code does carry it.
    expect(
      formatOperatorErrorEnvelope(
        toOperatorErrorEnvelope(new LocalUserPublicationPreflightError("stale-revision")),
      ),
    ).toContain(SHARED_STALE_REVISION_ACTION);
  });

  it("marks only the pre-write stale-revision failure and leaves other failures alone", () => {
    const otherCode = new LocalUserPublicationPreflightError("tracked-source-dirty");
    const plain = new Error("unrelated");
    expect(markPreWriteFreshnessFailure(otherCode, preWriteRepository)).toBe(otherCode);
    expect(otherCode.action).toBe(
      new LocalUserPublicationPreflightError("tracked-source-dirty").action,
    );
    expect(markPreWriteFreshnessFailure(plain, preWriteRepository)).toBe(plain);
    expect(toOperatorErrorEnvelope(otherCode).nextAction).not.toContain("docsfab doctor");
  });
});
