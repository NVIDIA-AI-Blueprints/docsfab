// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  QUALITY_CHECK_INTEGRITY_CODES,
  QUALITY_CHECK_REJECTION_CODES,
  QUALITY_VALIDATOR_UNAVAILABLE_CODES,
} from "../src/evaluation-report/quality-check-rejections.js";
import { STAGED_QUALITY_SCHEMA_MISMATCH_KEYWORDS } from "../src/evaluation-report/quality-schema-validation.js";
import {
  EVALUATION_DIAGNOSTIC_CODES,
  classifyEvaluationDiagnostic,
  projectEvaluationValidatorRejection,
} from "../src/evaluation-report/quality-validation-rejection.js";
import { QualityArtifactValidationError } from "../src/evaluation-report/quality-validator-host.js";
import { InferenceStepError } from "../src/execution/contracts.js";
import { OUTPUT_RULE_HINTS } from "../src/contracts/model-output.js";
import {
  RESPONSE_REJECTION_RULE_HINTS,
  responseCorrectionInstruction,
} from "../src/harness/response-correction.js";
import { inferenceRejectionFailureClass } from "../src/operator/failure-classification.js";
import type { QualityArtifactValidationBindingV1 } from "../src/records/contracts.js";
import {
  declinedQualityReportNote,
  QUALITY_CORRECTION_FAILURE_MESSAGE,
  QUALITY_REPORT_DECLINE_STEM,
  qualityCorrectionFailure,
  qualityRefusalBehind,
} from "../src/workflow-execution/quality-correction-round.js";
import {
  EVERY_CORRECTABLE_QUALITY_REJECTION_HAS_A_RULE,
  QUALITY_RESPONSE_RULE_HINTS,
} from "../src/workflow-execution/quality-rejection-rule-hints.js";
import {
  QUALITY_REJECTION_RETRYABILITY,
  isHostBuiltQualityRejection,
  isModelCorrectableQualityRejection,
  type QualityRejectionCode,
} from "../src/workflow-execution/quality-rejection-retryability.js";

/** Adapter-level correctable codes that are not emitted by the locked validators. */
const ADAPTER_REJECTION_CODES = ["evaluation-layer-residual-invalid"] as const;

/** Every code a quality-path refusal can record, read from the closed sets. */
const EVERY_CODE: readonly QualityRejectionCode[] = [
  ...QUALITY_CHECK_REJECTION_CODES,
  ...EVALUATION_DIAGNOSTIC_CODES,
  ...ADAPTER_REJECTION_CODES,
  ...STAGED_QUALITY_SCHEMA_MISMATCH_KEYWORDS.map(
    (keyword) => `evaluation-schema-${keyword}` as const,
  ),
];

/** Host faults: whatever the evaluator writes, these never retry. */
const HOST_FAULTS: readonly QualityRejectionCode[] = [
  ...Object.values(QUALITY_CHECK_INTEGRITY_CODES),
  ...Object.values(QUALITY_VALIDATOR_UNAVAILABLE_CODES),
  "quality-technical-verification-unadmitted",
  "quality-evaluator-identity-unbound",
  "quality-technical-verification-changed",
  "candidate-selection-mismatch",
  "candidate-host-binding-mismatch",
  // Tagged evaluator paths receive these members from the host; a refusal on
  // the legacy untagged path is terminal rather than a contradictory retry.
  "candidate-profile-mismatch",
  "candidate-model-version-mismatch",
  "candidate-scope-type-invalid",
  "candidate-revision-mismatch",
  // The host writes evaluation.target.paths, so a refusal of it is the host's defect.
  "candidate-target-paths-invalid",
  "candidate-target-outside-scope",
  "candidate-artifact-unstored",
  "staged-artifact-unreadable",
  "report-profile-bytes-changed",
  "report-rubric-bytes-changed",
  "final-report-unstored",
  "validation-binding-unstored",
  "validator-workspace-not-private",
  "validator-lock-entry-missing",
  "validator-input-not-regular",
  "validator-input-digest-changed",
  "evaluation-validator-refused",
  "evaluation-input-unreadable",
  "evaluation-pack-invalid",
  "report-limitations-mismatch",
  "quality-score-validator-refused",
  "report-binding-validator-refused",
];

/** Security refusals. */
const SECURITY_AND_AUTHORITY: readonly QualityRejectionCode[] = [
  "candidate-not-inert",
  "candidate-credential-material",
];

/** Recorded matrix rejections. */
const RECORDED = [
  { code: "technical-trace-missing-source-locator", location: "$.findings" },
  {
    code: "layer-confidence-exceeds-dimensions",
    location: "$.layers.trustworthy_information.confidence",
  },
] as const;

function validationError(code: string, location = "$"): QualityArtifactValidationError {
  return new QualityArtifactValidationError(
    "evaluation-invalid",
    { status: "failed" } as unknown as QualityArtifactValidationBindingV1,
    "# Retained evaluator report",
    { validator: "evaluation", code, location, issueCount: 1 },
  );
}

describe("quality rejection retryability table (#1246)", () => {
  it("classifies every closed quality code exactly once, with a reason", () => {
    // The compile-time reading: a code without an entry, or a stale entry,
    // fails the typecheck before this runs.
    expect(Object.keys(QUALITY_REJECTION_RETRYABILITY).sort()).toEqual(
      [...new Set(EVERY_CODE)].sort(),
    );
    for (const code of EVERY_CODE) {
      const entry = QUALITY_REJECTION_RETRYABILITY[code];
      expect(["model-correctable", "terminal"], code).toContain(entry.retry);
      expect(entry.reason.trim().length, code).toBeGreaterThan(0);
    }
  });

  it("keeps host faults, unnamed refusals, and security or authority refusals terminal", () => {
    for (const code of [...HOST_FAULTS, ...SECURITY_AND_AUTHORITY]) {
      expect(isModelCorrectableQualityRejection(code), code).toBe(false);
    }
  });

  it("does not retry host-owned metadata mismatches with model instructions", () => {
    for (const code of [
      "candidate-profile-mismatch",
      "candidate-model-version-mismatch",
      "candidate-scope-type-invalid",
      "candidate-revision-mismatch",
    ] as const) {
      expect(isHostBuiltQualityRejection(code), code).toBe(true);
      expect(Object.hasOwn(QUALITY_RESPONSE_RULE_HINTS, code), code).toBe(false);
    }
    expect(QUALITY_RESPONSE_RULE_HINTS["candidate-evaluation-shape"]!.rule).toContain(
      "the host writes the profile and target metadata",
    );
  });

  it("makes the recorded matrix rejections model-correctable", () => {
    for (const { code } of RECORDED) {
      expect(isModelCorrectableQualityRejection(code), code).toBe(true);
    }
  });

  it("reads a code outside the table as terminal", () => {
    for (const code of ["unretainable-reason-too-long", "constructor", "evaluation-schema-"]) {
      expect(isModelCorrectableQualityRejection(code), code).toBe(false);
    }
  });

  it("gives every model-correctable code its own rule hint and failure class", () => {
    expect(EVERY_CORRECTABLE_QUALITY_REJECTION_HAS_A_RULE).toBe(true);
    const correctable = EVERY_CODE.filter(isModelCorrectableQualityRejection);
    const residualCode = "evaluation-layer-residual-invalid";
    expect(QUALITY_RESPONSE_RULE_HINTS).not.toHaveProperty(residualCode);
    expect(RESPONSE_REJECTION_RULE_HINTS[residualCode]).toEqual(OUTPUT_RULE_HINTS[residualCode]);
    for (const code of correctable) {
      expect(Object.hasOwn(RESPONSE_REJECTION_RULE_HINTS, code), code).toBe(true);
      expect(inferenceRejectionFailureClass(code), code).toBeDefined();
    }
  });

  it("states the uncapped plain-or-JSON limitation row contract in the hint", () => {
    for (const code of [
      "report-limitation-section-count",
      "report-limitation-row-ambiguous",
      "report-limitation-value-invalid",
      "report-limitation-duplicate",
    ] as const) {
      const rule = QUALITY_RESPONSE_RULE_HINTS[code]!.rule;
      expect(rule, code).toContain('"- Limitation: <text>"');
      expect(rule, code).toContain('"- Limitation (JSON):" followed by the JSON string encoding');
      expect(rule, code).not.toContain("<JSON string>");
      expect(rule, code).toContain("without a per-limitation character ceiling");
      expect(rule, code).not.toContain("512");
    }
  });

  it("states each recorded rejection's rule in the retry prompt", () => {
    for (const rejection of RECORDED) {
      const prompt = responseCorrectionInstruction({ rejection });
      expect(prompt).toContain(
        `The previous response failed host rule ${rejection.code} at ${rejection.location}.`,
      );
      expect(prompt).toContain(QUALITY_RESPONSE_RULE_HINTS[rejection.code]!.rule);
      expect(prompt).not.toContain("has no specific repair hint");
    }
  });
});

describe("evaluation validator load and profile faults (#1246)", () => {
  /** Diagnostics the validator prints when its own inputs, not the evaluation, are broken. */
  const PACK_FAULTS = [
    [
      "unable to read JSON file /private/profile.json: [Errno 2] No such file",
      "evaluation-input-unreadable",
    ],
    ["invalid JSON in /private/profile.json: Expecting value", "evaluation-pack-invalid"],
    ["non-finite JSON number: NaN", "evaluation-pack-invalid"],
    ["unresolved JSON Schema reference: #/$defs/missing", "evaluation-pack-invalid"],
    ["documentation quality profile must contain an object", "evaluation-pack-invalid"],
    ["profile.applicability must contain an object", "evaluation-pack-invalid"],
    ["profile applicability references unknown dimension: task-success", "evaluation-pack-invalid"],
    ["profile contains unknown constraint: made-up", "evaluation-pack-invalid"],
    ["profile outcome minimum attempts must be a positive integer", "evaluation-pack-invalid"],
    [
      "profile path prefix 'reference' path '/abs' must be repository-relative",
      "evaluation-pack-invalid",
    ],
  ] as const;

  it("names a broken quality pack with a terminal host-fault code, never the evaluator's", () => {
    for (const [diagnostic, code] of PACK_FAULTS) {
      expect(classifyEvaluationDiagnostic(diagnostic), diagnostic).toEqual({ code, location: "$" });
      expect(isModelCorrectableQualityRejection(code), code).toBe(false);
      const rejection = projectEvaluationValidatorRejection({
        stderr: `error: ${diagnostic}\n`,
        payload: undefined,
      });
      expect(rejection.code, diagnostic).toBe(code);
      expect(
        qualityCorrectionFailure(validationError(rejection.code, rejection.location), {
          summary: "# Report",
        }),
        diagnostic,
      ).toBeUndefined();
    }
  });

  it("still reads the evaluator's own diagnostics as correctable", () => {
    for (const diagnostic of [
      "layers.trustworthy_information confidence exceeds its lowest required-dimension confidence",
      "target.paths[0] path '/abs' must be repository-relative",
      "an unrecognised profile rule the table has no row for",
    ]) {
      const { code } = classifyEvaluationDiagnostic(diagnostic);
      expect(isModelCorrectableQualityRejection(code), `${diagnostic} -> ${code}`).toBe(true);
    }
  });
});

describe("quality correction round failure (#1246)", () => {
  it("turns a model-correctable refusal into a retryable coded attempt failure", () => {
    const refusal = validationError("technical-trace-missing-source-locator", "$.findings");
    const model = { provider: "fixture", model: "fixture-model" };
    const usage = { input: 3, output: 5, cacheRead: 0, cacheWrite: 0, total: 8, turns: 1 };
    const failure = qualityCorrectionFailure(refusal, { summary: "# Report", model, usage });

    expect(failure).toBeInstanceOf(InferenceStepError);
    expect(failure).toMatchObject({
      message: QUALITY_CORRECTION_FAILURE_MESSAGE,
      category: "malformed-response",
      retryable: true,
      rejection: {
        code: "technical-trace-missing-source-locator",
        location: "$.findings",
      },
      evidence: { model, usage },
    });
    expect(qualityRefusalBehind(failure)).toBe(refusal);
    // The refusal stays in host-owned state; nothing on the error carries it.
    expect(JSON.stringify(failure)).not.toContain("Retained evaluator report");
    expect(Object.values(failure!)).not.toContain(refusal);
  });

  it("leaves a terminal refusal and any other error to stop the step as they are", () => {
    const result = { summary: "# Report" };
    for (const code of [...HOST_FAULTS, ...SECURITY_AND_AUTHORITY, "unknown-code"]) {
      expect(qualityCorrectionFailure(validationError(code), result), code).toBeUndefined();
    }
    expect(qualityCorrectionFailure(new Error("host defect"), result)).toBeUndefined();
    const uncoded = new QualityArtifactValidationError(
      "candidate-invalid",
      { status: "failed" } as unknown as QualityArtifactValidationBindingV1,
      "",
      undefined as never,
    );
    expect(qualityCorrectionFailure(uncoded, result)).toBeUndefined();
    expect(qualityRefusalBehind(new InferenceStepError("x", "malformed-response", true))).toBe(
      undefined,
    );
  });
});

describe("declined quality report note (#1246)", () => {
  it("names the spent attempts and the rejection code, singular and plural", () => {
    const singular = declinedQualityReportNote(1, "evaluation-schema-enum");
    expect(singular.startsWith(QUALITY_REPORT_DECLINE_STEM)).toBe(true);
    expect(singular).toContain("1 attempt spent");
    expect(singular).not.toContain("1 attempts spent");
    expect(singular).toContain("evaluation-schema-enum");

    const plural = declinedQualityReportNote(3, "family-evidence-missing");
    expect(plural).toContain("3 attempts spent");
    expect(plural).toContain("family-evidence-missing");
  });

  it("never claims a quality score, so a reader cannot mistake the decline for a judgment", () => {
    const note = declinedQualityReportNote(2, "required-dimension-not-applicable");
    expect(note).toContain("no quality score is recorded for this review");
    expect(note).toContain("every other step's findings are unaffected");
  });
});
