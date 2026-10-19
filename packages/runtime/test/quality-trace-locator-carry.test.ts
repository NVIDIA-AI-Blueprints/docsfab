// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The host carries admitted technical fact locators onto the final evaluator
 * finding that already traces the fact.
 *
 * The fixture keeps the structure of a recorded failure on
 * `technical-trace-missing-source-locator`: one finding consolidates several
 * facts, names every fact ID, issue ID, and uncertainty, and cites wider or
 * neighbouring ranges in place of three admitted locators. FACT-3 lacks
 * `27-27`; FACT-10 lacks `23-24` and `9-10`. Descriptions and uncertainties
 * are fixture text, not recorded model prose.
 */

import { describe, expect, it } from "vitest";

import {
  carryAdmittedTechnicalLocators,
  HOST_CARRIED_LOCATOR_EVIDENCE,
  hostCarriedLocatorDescription,
  inspectTechnicalFactTrace,
} from "../src/evaluation-report/quality-artifact-staging.js";
import type { QualityArtifactCandidateV1 } from "../src/execution/contracts.js";
import {
  evidenceCitesRepositoryLocator,
  TECHNICAL_FACT_DIMENSIONS,
  type TechnicalSourceFact,
  type VerificationResult,
} from "../src/workflow-execution/review-response.js";

const SOURCE = "src/sprout.mjs";

function fact(
  id: string,
  dimension: TechnicalSourceFact["dimension"],
  issueId: string,
  lines: readonly string[],
): TechnicalSourceFact {
  return {
    id,
    dimension,
    sourceLocators: lines.map((range) => `${SOURCE}:${range}`),
    statement: `Fixture statement for ${id}.`,
    documentationDisposition: "omitted",
    uncertainty: `Fixture uncertainty for ${id}: source inspected, not executed.`,
    issueIds: [issueId],
  };
}

/** The recorded facts the failing finding traced, keyed by dimension. */
const RECORDED_FACTS: readonly TechnicalSourceFact[] = [
  fact("FACT-2", "input-representations", "TECH-003", ["14-20"]),
  fact("FACT-3", "input-representations", "TECH-003", ["22-24", "27-27"]),
  fact("FACT-7", "defaults-and-overrides", "TECH-001", ["12-13"]),
  fact("FACT-10", "destination-and-trust", "TECH-003", ["16-17", "23-24", "9-10"]),
  fact("FACT-15", "error-status-retry", "TECH-003", ["8-10"]),
];

function recordedVerification(
  facts: readonly TechnicalSourceFact[] = RECORDED_FACTS,
): VerificationResult {
  return {
    review: { verdict: "needs-revision", issues: [] },
    coverage: [],
    factInventory: {
      completeness: "bounded-not-proven",
      dimensions: TECHNICAL_FACT_DIMENSIONS.map((dimension) => {
        const inDimension = facts.filter((candidate) => candidate.dimension === dimension);
        return inDimension.length > 0
          ? {
              dimension,
              status: "applicable" as const,
              reason: `Fixture ${dimension} scope.`,
              sourceLocators: [],
              facts: structuredClone(inDimension),
            }
          : {
              dimension,
              status: "not-applicable" as const,
              reason: `Fixture source defines no ${dimension} behavior.`,
              sourceLocators: [`${SOURCE}:1-27`],
              facts: [],
            };
      }),
      limitations: [],
    },
  } as unknown as VerificationResult;
}

function uncertainty(id: string): string {
  return RECORDED_FACTS.find((candidate) => candidate.id === id)!.uncertainty;
}

/** The recorded evaluation shape: FIND-001 traces FACT-7; FIND-003 consolidates the rest. */
function recordedCandidate(): QualityArtifactCandidateV1 {
  const consolidated = ["FACT-2", "FACT-3", "FACT-10", "FACT-15"];
  return {
    evaluation: {
      findings: [
        {
          id: "FIND-001",
          severity: "major",
          dimension_id: "factual-accuracy",
          description: `Fact FACT-7 linked issue IDs: TECH-001. Uncertainty: ${uncertainty("FACT-7")}`,
          evidence: [
            {
              evidence_class: "grounded-judgment",
              strength: "derived",
              locator: `docs/quickstart.md:11; ${SOURCE}:12-13`,
              description: "Fixture evidence for FACT-7.",
            },
          ],
          owner: "documentation-owner",
          acceptance_condition: "Fixture acceptance condition.",
          status: "open",
        },
        {
          id: "FIND-003",
          severity: "major",
          dimension_id: "prevention-recovery",
          description: `Facts ${consolidated.join(", ")} linked issue IDs: TECH-003. ${consolidated
            .map((id) => `${id}: ${uncertainty(id)}`)
            .join(" ")}`,
          evidence: [
            {
              evidence_class: "grounded-judgment",
              strength: "derived",
              locator: [
                "docs/quickstart.md:3",
                "docs/quickstart.md:21",
                `${SOURCE}:14-20`,
                `${SOURCE}:22-24`,
                `${SOURCE}:16-17`,
                `${SOURCE}:8-10`,
              ].join("; "),
              description: "Fixture consolidated evidence.",
            },
          ],
          owner: "documentation-owner",
          acceptance_condition: "Fixture acceptance condition.",
          status: "open",
        },
      ],
      limitations: [],
    },
    qualityScore: null,
    reportMarkdown: "# Fixture report",
    selectionSha256: "f".repeat(64),
  };
}

function findings(candidate: QualityArtifactCandidateV1): Array<Record<string, unknown>> {
  return candidate.evaluation.findings as Array<Record<string, unknown>>;
}

describe("host-carried technical fact locators (#1267)", () => {
  it("reproduces the recorded refusal: two facts miss locators a wider range covers", () => {
    expect(
      inspectTechnicalFactTrace(recordedCandidate().evaluation, recordedVerification()),
    ).toEqual({
      status: "invalid",
      violations: [
        { code: "missing-source-locator", factId: "FACT-3" },
        { code: "missing-source-locator", factId: "FACT-10" },
      ],
      truncated: false,
    });
  });

  it("carries exactly the missing admitted locators onto the linked finding, so the trace passes", () => {
    const verification = recordedVerification();
    const recorded = recordedCandidate();
    const before = structuredClone(recorded);

    const carried = carryAdmittedTechnicalLocators(recorded, verification);

    expect(inspectTechnicalFactTrace(carried.evaluation, verification)).toEqual({
      status: "passed",
      violations: [],
      truncated: false,
    });
    expect(findings(carried)[1]!.evidence).toEqual([
      ...(findings(before)[1]!.evidence as unknown[]),
      {
        ...HOST_CARRIED_LOCATOR_EVIDENCE,
        locator: `${SOURCE}:27-27`,
        description: hostCarriedLocatorDescription("FACT-3"),
      },
      {
        ...HOST_CARRIED_LOCATOR_EVIDENCE,
        locator: `${SOURCE}:23-24`,
        description: hostCarriedLocatorDescription("FACT-10"),
      },
      {
        ...HOST_CARRIED_LOCATOR_EVIDENCE,
        locator: `${SOURCE}:9-10`,
        description: hostCarriedLocatorDescription("FACT-10"),
      },
    ]);
    // Only the entries are added: every model field, and the other finding, is unchanged.
    expect({ ...findings(carried)[1]!, evidence: undefined }).toEqual({
      ...findings(before)[1]!,
      evidence: undefined,
    });
    expect(findings(carried)[0]).toEqual(findings(before)[0]);
    expect({ ...carried, evaluation: undefined }).toEqual({ ...before, evaluation: undefined });
    // The model's candidate is not mutated.
    expect(recorded).toEqual(before);
  });

  it("returns the candidate itself when every traced finding already cites its locators", () => {
    const verification = recordedVerification();
    const complete = carryAdmittedTechnicalLocators(recordedCandidate(), verification);
    expect(carryAdmittedTechnicalLocators(complete, verification)).toBe(complete);
    expect(carryAdmittedTechnicalLocators(complete, undefined)).toBe(complete);
  });

  it.each([
    ["fact ID", "FACT-3", "FACT-X", "missing-fact-id"],
    ["issue ID", "TECH-003", "TECH-999", "missing-issue-id"],
    ["uncertainty", uncertainty("FACT-3"), "An unrelated uncertainty.", "missing-uncertainty"],
  ])(
    "never carries locators onto a finding missing the %s the model owns",
    (_part, from, to, code) => {
      const verification = recordedVerification();
      const recorded = recordedCandidate();
      const finding = findings(recorded)[1]!;
      finding.description = String(finding.description).replaceAll(from, to);

      const carried = carryAdmittedTechnicalLocators(recorded, verification);

      expect(inspectTechnicalFactTrace(carried.evaluation, verification)).toMatchObject({
        status: "invalid",
        violations: expect.arrayContaining([{ code, factId: "FACT-3" }]),
      });
      expect(
        findings(carried).flatMap((candidate) =>
          (candidate.evidence as Array<{ description: string }>).map((entry) => entry.description),
        ),
      ).not.toContain(hostCarriedLocatorDescription("FACT-3"));
    },
  );

  it("leaves a malformed evaluation or evidence field for the validators to refuse", () => {
    const verification = recordedVerification();
    const malformed = recordedCandidate();
    malformed.evaluation.findings = [...findings(malformed), "not-an-object"];
    expect(carryAdmittedTechnicalLocators(malformed, verification)).toBe(malformed);

    const noEvidence = recordedCandidate();
    findings(noEvidence)[1]!.evidence = "not-an-array";
    expect(carryAdmittedTechnicalLocators(noEvidence, verification)).toBe(noEvidence);
  });
});

/**
 * An admitted `path: label` locator can contain `;`. The trace check reads an
 * evidence locator field with the verifier's locator grammar, not a `;` split,
 * so the model or the host carry can satisfy it.
 */
describe("locator-grammar trace matching (#1281)", () => {
  const LABELLED = `${SOURCE}: Defaults; environment overrides`;

  function labelledFact(): TechnicalSourceFact {
    return {
      ...fact("FACT-20", "defaults-and-overrides", "TECH-005", ["30-31"]),
      sourceLocators: [LABELLED, `${SOURCE}:30-31`],
    };
  }

  function labelledCandidate(locator: string): QualityArtifactCandidateV1 {
    const candidate = recordedCandidate();
    candidate.evaluation.findings = [
      {
        id: "FIND-020",
        severity: "major",
        dimension_id: "factual-accuracy",
        description: `Fact FACT-20 linked issue IDs: TECH-005. Uncertainty: ${labelledFact().uncertainty}`,
        evidence: [
          {
            evidence_class: "grounded-judgment",
            strength: "derived",
            locator,
            description: "Fixture evidence for FACT-20.",
          },
        ],
        owner: "documentation-owner",
        acceptance_condition: "Fixture acceptance condition.",
        status: "open",
      },
    ];
    return candidate;
  }

  it.each([
    ["the locator alone", LABELLED, LABELLED, true],
    ["a list entry", `docs/a.md:3; ${LABELLED} ;src/b.ts:4`, LABELLED, true],
    ["a list entry without spaces", "src/a.ts:10;src/a.ts:12", "src/a.ts:12", true],
    ["the first entry of a labelled locator", LABELLED, `${SOURCE}: Defaults`, true],
    ["a range that prefixes a wider one", "src/a.ts:10-120", "src/a.ts:10-12", false],
    [
      "a label that prefixes a longer one",
      `${SOURCE}: Defaults and overrides`,
      `${SOURCE}: Defaults`,
      false,
    ],
    ["an invalid range", "src/a.ts:10-2", "src/a.ts:10-2", false],
    ["a locator inside prose", "see src/a.ts:10", "src/a.ts:10", false],
    ["a comma-joined locator", "src/a.ts:10,src/b.ts:4", "src/b.ts:4", false],
    ["an untrimmed locator", "src/a.ts:10 ", "src/a.ts:10 ", false],
    ["a whole-file path", "src/a.ts", "src/a.ts", false],
  ])("an evidence field cites %s: %s", (_case, field, locator, cited) => {
    expect(evidenceCitesRepositoryLocator(field, locator)).toBe(cited);
  });

  it("accepts an admitted `path: label; more` locator the model cites in a list", () => {
    const verification = recordedVerification([labelledFact()]);
    const candidate = labelledCandidate(`docs/quickstart.md:3; ${LABELLED}; ${SOURCE}:30-31`);

    expect(inspectTechnicalFactTrace(candidate.evaluation, verification)).toEqual({
      status: "passed",
      violations: [],
      truncated: false,
    });
    expect(carryAdmittedTechnicalLocators(candidate, verification)).toBe(candidate);
  });

  it("passes an admitted `path: label; more` locator after the host carries it", () => {
    const verification = recordedVerification([labelledFact()]);
    const candidate = labelledCandidate(`${SOURCE}: Defaults; ${SOURCE}:30-31`);

    expect(inspectTechnicalFactTrace(candidate.evaluation, verification)).toEqual({
      status: "invalid",
      violations: [{ code: "missing-source-locator", factId: "FACT-20" }],
      truncated: false,
    });

    const carried = carryAdmittedTechnicalLocators(candidate, verification);

    expect(findings(carried)[0]!.evidence).toEqual([
      ...(findings(candidate)[0]!.evidence as unknown[]),
      {
        ...HOST_CARRIED_LOCATOR_EVIDENCE,
        locator: LABELLED,
        description: hostCarriedLocatorDescription("FACT-20"),
      },
    ]);
    expect(inspectTechnicalFactTrace(carried.evaluation, verification)).toEqual({
      status: "passed",
      violations: [],
      truncated: false,
    });
    expect(carryAdmittedTechnicalLocators(carried, verification)).toBe(carried);
  });

  it("never lets the host description satisfy another fact's uncertainty", () => {
    // FACT-21's uncertainty is a substring of the fixed host description, and
    // the model never wrote it. The carry for FACT-20 must not supply it.
    const hostOnly = "verification result.";
    expect(hostCarriedLocatorDescription("FACT-20")).toContain(hostOnly);
    const other: TechnicalSourceFact = {
      ...fact("FACT-21", "defaults-and-overrides", "TECH-005", ["40-41"]),
      uncertainty: hostOnly,
    };
    const verification = recordedVerification([labelledFact(), other]);
    const candidate = labelledCandidate(`${SOURCE}:30-31; ${SOURCE}:40-41`);
    const finding = findings(candidate)[0]!;
    finding.description = `${String(finding.description)} Fact FACT-21 is also linked.`;
    expect(JSON.stringify(candidate)).not.toContain(hostOnly);

    const carried = carryAdmittedTechnicalLocators(candidate, verification);

    expect(findings(carried)[0]!.evidence).toContainEqual({
      ...HOST_CARRIED_LOCATOR_EVIDENCE,
      locator: LABELLED,
      description: hostCarriedLocatorDescription("FACT-20"),
    });
    expect(inspectTechnicalFactTrace(carried.evaluation, verification)).toEqual({
      status: "invalid",
      violations: [{ code: "missing-uncertainty", factId: "FACT-21" }],
      truncated: false,
    });
  });
});
