// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { canonicalJson } from "../src/content-ir/canonical.js";
import {
  assertTechnicalFactTrace,
  carryAdmittedTechnicalLocators,
  inspectTechnicalFactTrace,
  renderAdmittedTechnicalFactEvidence,
} from "../src/evaluation-report/quality-artifact-staging.js";
import type { QualityArtifactCandidateV1 } from "../src/execution/contracts.js";
import {
  TECHNICAL_FACT_DIMENSIONS,
  type TechnicalSourceFact,
  type VerificationResult,
} from "../src/workflow-execution/review-response.js";

const FACT: TechnicalSourceFact = {
  id: "FACT-7",
  dimension: "input-representations",
  sourceLocators: ["src/a.ts:4; section: parser", "src/a.ts:8-9"],
  statement: "The parser preserves the original spelling.",
  documentationDisposition: "omitted",
  uncertainty: "The parser path was inspected, not executed.",
  issueIds: ["TECH-12"],
};

function verification(fact: TechnicalSourceFact = FACT): VerificationResult {
  return {
    review: { verdict: "needs-revision", issues: [] },
    coverage: [],
    factInventory: {
      completeness: "bounded-not-proven",
      dimensions: TECHNICAL_FACT_DIMENSIONS.map((dimension) =>
        dimension === fact.dimension
          ? {
              dimension,
              status: "applicable" as const,
              reason: `Fixture ${dimension} scope.`,
              sourceLocators: [],
              facts: [structuredClone(fact)],
            }
          : {
              dimension,
              status: "not-applicable" as const,
              reason: `Fixture has no ${dimension} facts.`,
              sourceLocators: [],
              facts: [],
            },
      ),
      limitations: [],
    },
  } as unknown as VerificationResult;
}

function candidate(evidence: unknown[] = []): QualityArtifactCandidateV1 {
  return {
    evaluation: {
      findings: [
        {
          id: "FIND-1",
          description: "Model-authored finding description remains unchanged.",
          evidence,
        },
      ],
      limitations: [],
    },
    qualityScore: null,
    reportMarkdown: "",
    selectionSha256: "a".repeat(64),
  } as unknown as QualityArtifactCandidateV1;
}

describe("quality answer-record technical fact trace", () => {
  it("renders schema-compatible host items with canonical provenance and whole locators", () => {
    const rendered = renderAdmittedTechnicalFactEvidence(FACT);
    expect(rendered).toEqual({
      evidence_class: "grounded-judgment",
      strength: "derived",
      provider_id: "docsfab-host-fact-render",
      locator: canonicalJson(FACT.sourceLocators),
      description: canonicalJson({
        factId: FACT.id,
        statement: FACT.statement,
        uncertainty: FACT.uncertainty,
        issueIds: FACT.issueIds,
      }),
    });
    expect(Object.keys(rendered).sort()).toEqual(
      ["description", "evidence_class", "locator", "provider_id", "strength"].sort(),
    );
    expect(JSON.parse(rendered.locator)).toEqual(FACT.sourceLocators);
  });

  it("traces authentic records items without rewriting model-owned finding text", () => {
    const rendered = renderAdmittedTechnicalFactEvidence(FACT);
    const value = candidate([rendered]);
    const finding = value.evaluation.findings[0] as Record<string, unknown>;

    expect(inspectTechnicalFactTrace(value.evaluation, verification(), "records")).toEqual({
      status: "passed",
      violations: [],
      truncated: false,
    });
    expect(finding.description).toBe("Model-authored finding description remains unchanged.");
    expect(carryAdmittedTechnicalLocators(value, verification(), "records")).toBe(value);
  });

  it("refuses a missing link and tampered admitted host evidence", () => {
    const source = verification();
    const missing = candidate();
    expect(() => assertTechnicalFactTrace(missing.evaluation, source, "records")).toThrow(
      "technical-trace-incomplete",
    );

    const tampered = renderAdmittedTechnicalFactEvidence(FACT);
    expect(
      inspectTechnicalFactTrace(
        candidate([{ ...tampered, locator: canonicalJson(["src/a.ts:5"]) }]).evaluation,
        source,
        "records",
      ).status,
    ).toBe("invalid");
  });

  it("does not let a model-spoofed host marker establish a text-path trace", () => {
    const spoofed = candidate([renderAdmittedTechnicalFactEvidence(FACT)]);
    expect(inspectTechnicalFactTrace(spoofed.evaluation, verification(), "text")).toMatchObject({
      status: "invalid",
      violations: [expect.objectContaining({ code: "missing-fact-id", factId: FACT.id })],
    });
  });
});
