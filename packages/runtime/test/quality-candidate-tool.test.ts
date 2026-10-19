// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  createQualityCandidateValidationTool,
  QUALITY_CANDIDATE_JSON_MAX_BYTES,
} from "../src/harness/quality-candidate-tool.js";
import { isQualityCandidateValidationStep } from "../src/execution/contracts.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import { CANON_TOOL_NAMES } from "../src/harness/canon-tools.js";
import {
  QUALITY_ANSWER_RECORD_TOOL_NAME,
  QUALITY_SUBMISSION_TOOL_NAME,
} from "../src/harness/answer-submission.js";
import {
  grantedToolsForStep,
  QUALITY_CANDIDATE_VALIDATION_TOOL_NAME,
} from "../src/harness/pi-tool-confine.js";
import { configureCredentialsForEachTest } from "./helpers/configured-credential.js";
import { plantedCredentialValue } from "./helpers/planted-credential.js";
import { verificationResultFixture } from "./helpers/verification.js";

const selection = {
  skillLockSha256: "a".repeat(64),
  qualityLockSha256: "b".repeat(64),
  qualityBundleSha256: "c".repeat(64),
  profileAssetPath: "profiles/docsfab-documentation-quality/profile.json",
  profilePayloadSha256: "d".repeat(64),
  profileId: "docsfab-documentation-quality",
  profileVersion: "v0.1",
  profileModel: "documentation-quality-model-v0.2",
  repositoryRevision: "e".repeat(40),
  selectionSha256: "f".repeat(64),
} as const;

function technicalVerification() {
  const result = structuredClone(verificationResultFixture(["README.md"]));
  const fact = result.factInventory.dimensions[0]!.facts[0]!;
  fact.documentationDisposition = "omitted";
  fact.issueIds = ["TECH-001"];
  result.review = {
    verdict: "needs-revision",
    issues: [
      {
        id: "TECH-001",
        severity: "major",
        category: "technical_accuracy",
        location: "README.md:1",
        finding: "The fixture fact needs a correction.",
        evidence: { source_id: "fixture-source", locator: fact.sourceLocators[0]! },
        required_change: "Correct the fixture fact.",
      },
    ],
  };
  return result;
}

function candidate(evaluation: Record<string, unknown>): string {
  return JSON.stringify({ evaluation, qualityScore: null, reportMarkdown: "# Fixture report" });
}

async function execute(candidateJson: string | undefined, includeUnexpected = false) {
  const tool = createQualityCandidateValidationTool({
    selection,
    technicalVerification: technicalVerification(),
  });
  const result = await tool.execute(
    "candidate-call",
    candidateJson === undefined
      ? {}
      : { candidateJson, ...(includeUnexpected ? { unexpected: "PRIVATE extra value" } : {}) },
    undefined,
    undefined,
    undefined as never,
  );
  return JSON.parse((result.content[0] as { text: string }).text) as Record<string, unknown>;
}

// One of DocsFab's own configured credentials for each test, and a token of
// the same shape that is not configured (#1807).
const CONFIGURED_TOKEN = ["ghp", plantedCredentialValue(62, 36)].join("_");
const SHAPED_TOKEN = ["ghp", plantedCredentialValue(63, 36)].join("_");

describe("quality candidate validation tool", () => {
  configureCredentialsForEachTest(CONFIGURED_TOKEN);

  it("admits exact evaluators while granting the advisory tool only to REVIEW", () => {
    const workflow = getWorkflow("review-documentation");
    const step = workflow.steps.find(
      (candidateStep) => candidateStep.id === "evaluate-document-quality",
    )!;
    expect(isQualityCandidateValidationStep({ workflow, step, qualityArtifactBound: true })).toBe(
      true,
    );
    expect(QUALITY_CANDIDATE_VALIDATION_TOOL_NAME).toBe("validate_quality_candidate");
    expect(grantedToolsForStep(workflow, step, true)).toContain(
      QUALITY_CANDIDATE_VALIDATION_TOOL_NAME,
    );
    expect(grantedToolsForStep(workflow, step, true, true)).toEqual(
      expect.arrayContaining([QUALITY_CANDIDATE_VALIDATION_TOOL_NAME, "docsfab_read_source"]),
    );
    expect(grantedToolsForStep(workflow, step, true, false)).not.toContain("docsfab_read_source");
    expect(grantedToolsForStep(workflow, step)).not.toContain(
      QUALITY_CANDIDATE_VALIDATION_TOOL_NAME,
    );
    const createWorkflow = getWorkflow("create-documentation");
    const createStep = createWorkflow.authoringSchedule!.branches[0]!.steps.find(
      (candidateStep) => candidateStep.id === "evaluate-document-quality",
    )!;
    expect(
      isQualityCandidateValidationStep({
        workflow: createWorkflow,
        step: createStep,
        qualityArtifactBound: true,
      }),
    ).toBe(true);
    expect(grantedToolsForStep(createWorkflow, createStep, true)).not.toContain(
      QUALITY_CANDIDATE_VALIDATION_TOOL_NAME,
    );
    expect(grantedToolsForStep(createWorkflow, createStep, true, true)).toEqual(
      expect.arrayContaining(["docsfab_read_source"]),
    );
    expect(grantedToolsForStep(createWorkflow, createStep, true, false)).not.toContain(
      "docsfab_read_source",
    );
    expect(grantedToolsForStep(createWorkflow, createStep)).not.toContain(
      QUALITY_CANDIDATE_VALIDATION_TOOL_NAME,
    );
    for (const changed of [
      { ...step, id: "other" },
      { ...step, skill: "other" },
      { ...step, kind: "inference" as const },
      { ...step, mode: "write" as const },
    ]) {
      expect(
        isQualityCandidateValidationStep({
          workflow,
          step: changed,
          qualityArtifactBound: true,
        }),
      ).toBe(false);
      expect(grantedToolsForStep(workflow, changed, true)).not.toContain(
        QUALITY_CANDIDATE_VALIDATION_TOOL_NAME,
      );
    }
    expect(
      isQualityCandidateValidationStep({
        workflow: { name: "update-documentation" },
        step,
        qualityArtifactBound: true,
      }),
    ).toBe(true);
    expect(grantedToolsForStep({ name: "update-documentation" }, step, true)).not.toContain(
      QUALITY_CANDIDATE_VALIDATION_TOOL_NAME,
    );
    expect(
      isQualityCandidateValidationStep({
        workflow: { name: "restructure-documentation" },
        step,
        qualityArtifactBound: true,
      }),
    ).toBe(false);
  });

  it("omits canon artifact submission only on the experimental answer-record evaluator route", () => {
    const workflow = getWorkflow("review-documentation");
    const step = workflow.steps.find(
      (candidateStep) => candidateStep.id === "evaluate-document-quality",
    )!;
    const recordTools = grantedToolsForStep(
      workflow,
      step,
      true,
      false,
      false,
      false,
      false,
      undefined,
      { path: "tool-call", reason: "recorded-route" },
      false,
      true,
    );

    expect(recordTools).toContain(QUALITY_ANSWER_RECORD_TOOL_NAME);
    expect(recordTools).not.toContain(QUALITY_SUBMISSION_TOOL_NAME);
    expect(recordTools).not.toContain("canon_submit_artifact");
    expect(recordTools).toEqual(
      expect.arrayContaining(CANON_TOOL_NAMES.filter((name) => name !== "canon_submit_artifact")),
    );
    expect(grantedToolsForStep(workflow, step, true)).toContain("canon_submit_artifact");

    const foundationStep = {
      id: "foundation-plan",
      skill: "foundation-to-patch",
      kind: "inference" as const,
      mode: "write" as const,
    };
    expect(grantedToolsForStep({ name: "foundation-to-patch" }, foundationStep)).toContain(
      "canon_submit_artifact",
    );
  });

  it("returns only closed trace codes, admitted fact IDs and the candidate digest", async () => {
    const draft = candidate({ findings: [], limitations: [] });
    const result = await execute(draft);
    expect(result).toEqual({
      kind: "docsfab-quality-candidate-trace-validation",
      status: "invalid",
      candidateSha256: createHash("sha256").update(draft).digest("hex"),
      violations: [{ code: "missing-fact-id", factId: "FIXTURE_FACT_1" }],
      truncated: false,
    });
    expect(JSON.stringify(result)).not.toContain("src/api.ts");
    expect(JSON.stringify(result)).not.toContain("The fixture evidence is bounded");
  });

  it("accepts a corrected trace without staging or minting a validation receipt", async () => {
    const verification = technicalVerification();
    const fact = verification.factInventory.dimensions[0]!.facts[0]!;
    const draft = candidate({
      findings: [
        {
          id: "FINDING-1",
          description: `${fact.id} TECH-001 ${fact.uncertainty}`,
          evidence: [{ locator: fact.sourceLocators.join("; "), description: "Bound evidence." }],
        },
      ],
      limitations: [],
    });
    const tool = createQualityCandidateValidationTool({
      selection,
      technicalVerification: verification,
    });
    const result = await tool.execute(
      "candidate-call",
      { candidateJson: draft },
      undefined,
      undefined,
      undefined as never,
    );
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({
      kind: "docsfab-quality-candidate-trace-validation",
      status: "passed",
      candidateSha256: createHash("sha256").update(draft).digest("hex"),
      violations: [],
      truncated: false,
    });
    expect(JSON.stringify(result)).not.toContain("validationReceipt");
  });

  it("reports what the final host validator admits after it carries the admitted locators (#1267)", async () => {
    const verification = technicalVerification();
    const fact = verification.factInventory.dimensions[0]!.facts[0]!;
    const linked = (uncertainty: string) =>
      candidate({
        findings: [
          {
            id: "FINDING-1",
            description: `${fact.id} TECH-001 ${uncertainty}`,
            evidence: [{ locator: "README.md:1", description: "A wider or unrelated locator." }],
          },
        ],
        limitations: [],
      });

    expect(await execute(linked(fact.uncertainty))).toMatchObject({
      status: "passed",
      violations: [],
    });
    expect(await execute(linked("An unrelated uncertainty."))).toMatchObject({
      status: "invalid",
      violations: [{ code: "missing-uncertainty", factId: fact.id }],
    });
  });

  it.each([
    ["missing argument", undefined],
    ["malformed JSON", "PRIVATE malformed candidate"],
    [
      "configured-credential content",
      candidate({ findings: [], limitations: [], token: CONFIGURED_TOKEN }),
    ],
    ["raw byte overflow", "x".repeat(QUALITY_CANDIDATE_JSON_MAX_BYTES + 1)],
    ["unexpected argument", candidate({ findings: [], limitations: [] }), true],
  ])("returns a fixed content-free result for %s", async (_name, draft, includeUnexpected) => {
    const result = await execute(draft, includeUnexpected);
    expect(result).toMatchObject({
      kind: "docsfab-quality-candidate-trace-validation",
      status: "invalid",
      violations: [{ code: "malformed-candidate" }],
      truncated: false,
    });
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
    expect(JSON.stringify(result)).not.toContain("ghp_");
  });

  it("validates a candidate whose credential shape is not a configured credential (#1807)", async () => {
    const result = await execute(candidate({ findings: [], limitations: [], token: SHAPED_TOKEN }));
    expect(result).toMatchObject({ status: "invalid", truncated: false });
    const codes = (result as { violations: { code: string }[] }).violations.map(
      (violation) => violation.code,
    );
    expect(codes).not.toContain("malformed-candidate");
    expect(codes.length).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toContain(SHAPED_TOKEN);
  });
});
