// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  REVIEW_SCOPE_CONTINUATION_TEXT_LIMIT,
  isQualityCandidateValidationStep,
} from "../src/execution/contracts/run-request.js";
import {
  INFERENCE_STEP_ERROR_CODES,
  InferenceStepError,
  assertUsableHarnessStepResult,
  inferenceFailureConditionOf,
} from "../src/execution/contracts/inference-errors.js";
import {
  REVIEW_SCOPE_CONTINUATION_TEXT_LIMIT as facadeContinuationLimit,
  isQualityCandidateValidationStep as facadeCandidatePredicate,
  INFERENCE_STEP_ERROR_CODES as facadeErrorCodes,
  InferenceStepError as FacadeInferenceStepError,
  assertUsableHarnessStepResult as facadeResultValidator,
  inferenceFailureConditionOf as facadeFailureConditionOf,
} from "../src/execution/contracts.js";

describe("execution contract compatibility facade", () => {
  it("preserves the identity of runtime contract helpers", () => {
    expect(facadeContinuationLimit).toBe(REVIEW_SCOPE_CONTINUATION_TEXT_LIMIT);
    expect(facadeCandidatePredicate).toBe(isQualityCandidateValidationStep);
    expect(facadeErrorCodes).toBe(INFERENCE_STEP_ERROR_CODES);
    expect(FacadeInferenceStepError).toBe(InferenceStepError);
    expect(facadeResultValidator).toBe(assertUsableHarnessStepResult);
    expect(facadeFailureConditionOf).toBe(inferenceFailureConditionOf);
  });

  it("keeps the inference refusal class usable through the facade", () => {
    const error = new FacadeInferenceStepError("refused", "malformed-response", true);

    expect(error).toBeInstanceOf(InferenceStepError);
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("malformed-response");
  });
});
