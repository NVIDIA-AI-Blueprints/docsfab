// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  classifyEvaluationDiagnostic,
  EVALUATION_SEMANTICS_FALLBACK,
  EVALUATION_VALIDATOR_REFUSED,
  projectEvaluationValidatorRejection,
  readQualityValidationRejection,
} from "../src/evaluation-report/quality-validation-rejection.js";
import { isRetainableInferenceRejection } from "../src/config/inference-rejection-limits.js";

const VALIDATOR = new URL(
  "../quality/checks/validate_documentation_quality_evaluation.py",
  import.meta.url,
);

/**
 * Every diagnostic template the locked evaluation validator can emit, rendered
 * with placeholder values. Read from the validator the runtime ships, so a new
 * or reworded diagnostic fails here instead of silently reading as the generic
 * fallback.
 */
function renderedValidatorTemplates(): string[] {
  const source = readFileSync(VALIDATOR, "utf8");
  const templates: string[] = [];
  for (const match of source.matchAll(/errors\.append\(\s*((?:f?"[^"]*"\s*)+)\)/gu)) {
    const literal = [...match[1]!.matchAll(/f?"([^"]*)"/gu)].map((part) => part[1]).join("");
    templates.push(
      literal
        .replace(/\{layer_id\}/gu, "trustworthy_information")
        .replace(/\{population\}/gu, "human")
        .replace(/\{schema_key\}/gu, "accessibility_and_inclusion")
        .replace(/\{minimum_attempts\}/gu, "2")
        .replace(/\{[^}]*:\.3f\}/gu, "0.500")
        .replace(/\{[^}]*!r\}/gu, "'placeholder'")
        .replace(/\{[^}]*\}/gu, "placeholder"),
    );
  }
  return templates;
}

describe("evaluation validator rejection (#1180)", () => {
  it("strictly reads only the closed retained refusal shape", () => {
    const valid = {
      validator: "technical-trace",
      code: "technical-trace-missing-fact-id",
      location: "$.findings",
      issueCount: 4,
    } as const;
    expect(readQualityValidationRejection(valid)).toEqual(valid);
    expect(readQualityValidationRejection({ ...valid, extra: true })).toBeNull();
    expect(readQualityValidationRejection({ ...valid, validator: "unknown" })).toBeNull();
    expect(readQualityValidationRejection({ ...valid, code: "free prose" })).toBeNull();
    expect(readQualityValidationRejection({ ...valid, issueCount: -1 })).toBeNull();
  });

  it("classifies every diagnostic the shipped evaluation validator can emit", () => {
    const templates = renderedValidatorTemplates();
    expect(templates.length).toBeGreaterThan(40);
    const unclassified = templates.filter(
      (message) => classifyEvaluationDiagnostic(message).code === EVALUATION_SEMANTICS_FALLBACK,
    );
    expect(unclassified).toEqual([]);
    for (const message of templates) {
      expect(isRetainableInferenceRejection(classifyEvaluationDiagnostic(message))).toBe(true);
    }
  });

  it("reduces the 2026-09-23 review-live refusal to a code, location, and count", () => {
    // Diagnostics the locked validator printed for a recorded review-live run.
    const stderr = [
      "error: required dimension 'visual-explanation' cannot be not-applicable",
      "error: required dimension 'interaction-responsiveness' cannot be not-applicable",
      "error: outcomes repeats attempt_id 'not-run' across 'human' and 'agent'",
      "",
    ].join("\n");
    const rejection = projectEvaluationValidatorRejection({ stderr, payload: {} });
    // The empty payload is schema-invalid, so the exact schema reading wins.
    expect(rejection).toEqual({
      validator: "evaluation",
      code: "evaluation-schema-required",
      location: "$.evaluation_id",
      issueCount: 3,
    });
    expect(classifyEvaluationDiagnostic(stderr.split("\n")[0]!.slice("error: ".length))).toEqual({
      code: "required-dimension-not-applicable",
      location: "$.layers",
    });
  });

  it("names a schema member only when the frozen schema declares it", () => {
    expect(
      classifyEvaluationDiagnostic(
        "layers.trustworthy_information confidence exceeds its lowest required-dimension confidence",
      ),
    ).toEqual({
      code: "layer-confidence-exceeds-dimensions",
      location: "$.layers.trustworthy_information.confidence",
    });
    expect(
      classifyEvaluationDiagnostic(
        "layers.SENTINEL_1178 confidence exceeds its lowest required-dimension confidence",
      ),
    ).toEqual({ code: "layer-confidence-exceeds-dimensions", location: "$.layers" });
    expect(
      classifyEvaluationDiagnostic(
        "layers.trustworthy_information placeholder requires at least one required dimension",
      ),
    ).toEqual({
      code: "layer-decision-requires-required-dimension",
      location: "$.layers.trustworthy_information.decision",
    });
    expect(
      classifyEvaluationDiagnostic(
        "layers.SENTINEL_1178 placeholder requires at least one required dimension",
      ),
    ).toEqual({ code: "layer-decision-requires-required-dimension", location: "$.layers" });
  });

  it("classifies the complete confidence checks and content-free finding location", () => {
    expect(
      classifyEvaluationDiagnostic(
        "layers.trustworthy_information confidence must be 0 when no dimensions are required",
      ),
    ).toEqual({
      code: "layer-confidence-no-required-dimensions",
      location: "$.layers.trustworthy_information.confidence",
    });
    expect(
      classifyEvaluationDiagnostic(
        "layers.trustworthy_information confidence is below its lowest required-dimension confidence",
      ),
    ).toEqual({
      code: "layer-confidence-below-dimensions",
      location: "$.layers.trustworthy_information.confidence",
    });
    expect(
      classifyEvaluationDiagnostic("overall confidence must be 0 when no dimensions are required"),
    ).toEqual({ code: "overall-confidence-no-required-dimensions", location: "$.confidence" });
    expect(
      classifyEvaluationDiagnostic(
        "overall confidence is below the lowest required-dimension confidence",
      ),
    ).toEqual({ code: "overall-confidence-below-dimensions", location: "$.confidence" });
    expect(
      classifyEvaluationDiagnostic(
        "findings[117].dimension_id 'private-dimension-name' is not a profile dimension or constraint",
      ),
    ).toEqual({ code: "finding-dimension-unrecognized", location: "$.findings" });
  });

  it("never retains validator text, and states a refusal that listed no issue", () => {
    const secret = `nvapi-${"R5t6Y7u8".repeat(5)}`;
    const rejection = projectEvaluationValidatorRejection({
      stderr: `error: dimension '${secret}' is met without evidence\nerror: SENTINEL free text\n`,
      payload: undefined,
    });
    expect(JSON.stringify(rejection)).not.toContain(secret);
    expect(JSON.stringify(rejection)).not.toContain("SENTINEL");
    expect(rejection.issueCount).toBe(2);
    expect(projectEvaluationValidatorRejection({ stderr: "", payload: undefined })).toMatchObject({
      code: EVALUATION_VALIDATOR_REFUSED,
      location: "$",
      issueCount: 0,
    });
  });
});
