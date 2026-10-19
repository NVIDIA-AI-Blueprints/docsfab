// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { InferenceStepError } from "../src/execution/contracts.js";
import {
  REVIEW_RESULT_REJECTION_CODES,
  REVIEW_RESULT_REJECTION_RETRYABILITY,
  isModelCorrectableReviewResultRejection,
  type ReviewResultRejectionCode,
} from "../src/workflow-execution/review-result-rejection-retryability.js";
import {
  REVIEW_RESULT_KIT_CODES,
  rejectReviewResultContract,
  validateEditorialReviewResult,
} from "../src/workflow-execution/review-response.js";
import { configureCredential } from "./helpers/configured-credential.js";

/**
 * Disclosure and integrity rejections stop, and credential material is a
 * disclosure rejection. `host-path-disclosure` is recorded only by older hosts
 * and stays terminal so those records classify as they did. Pinned here so a
 * change to the table is a visible decision.
 */
const TERMINAL: readonly ReviewResultRejectionCode[] = [
  "digest-mismatch",
  "credential-material",
  "host-path-disclosure",
];

function thrown(run: () => unknown): InferenceStepError {
  try {
    run();
  } catch (error) {
    if (error instanceof InferenceStepError) return error;
    throw error;
  }
  throw new Error("expected a rejection");
}

const REVIEW = {
  verdict: "needs-revision",
  issues: [
    {
      id: "REV-001",
      severity: "major",
      category: "completeness",
      location: "README.md:4",
      finding: "Readers cannot identify the required prerequisite from this page.",
      evidence: { source_id: "repository", locator: "README.md:4" },
      required_change: "Document the source-supported prerequisite.",
    },
  ],
};

describe("review-result rejection retryability table (#1292)", () => {
  it("classifies every closed code exactly once, with a reason", () => {
    expect(Object.keys(REVIEW_RESULT_REJECTION_RETRYABILITY).sort()).toEqual(
      [...REVIEW_RESULT_REJECTION_CODES].sort(),
    );
    for (const code of REVIEW_RESULT_REJECTION_CODES) {
      const entry = REVIEW_RESULT_REJECTION_RETRYABILITY[code];
      expect(["model-correctable", "terminal"], code).toContain(entry.retry);
      expect(entry.reason.trim().length, code).toBeGreaterThan(0);
    }
  });

  it("stops on disclosure and integrity codes and retries every other code", () => {
    for (const code of REVIEW_RESULT_REJECTION_CODES) {
      expect(isModelCorrectableReviewResultRejection(code), code).toBe(!TERMINAL.includes(code));
    }
  });

  it("maps every contract-kit axis onto a classified code", () => {
    for (const code of Object.values(REVIEW_RESULT_KIT_CODES)) {
      expect(REVIEW_RESULT_REJECTION_CODES, code).toContain(code);
    }
    expect(REVIEW_RESULT_KIT_CODES.credentialMaterial).toBe("credential-material");
    expect(REVIEW_RESULT_KIT_CODES.digestMismatch).toBe("digest-mismatch");
  });

  it.each(REVIEW_RESULT_REJECTION_CODES)("raises %s with the table's classification", (code) => {
    const error = thrown(() => rejectReviewResultContract(code));
    expect(error.category).toBe("malformed-response");
    expect(error.retryable).toBe(isModelCorrectableReviewResultRejection(code));
  });

  it("keeps a credential in an editorial review result terminal and admits a cited path", () => {
    configureCredential(`glpat-${"A1b2C3d4E5f6G7h8J9k0"}`);
    const credential = structuredClone(REVIEW);
    credential.issues[0]!.finding = `The page needs glpat-${"A1b2C3d4E5f6G7h8J9k0"} set.`;
    expect(thrown(() => validateEditorialReviewResult(credential)).retryable).toBe(false);
    const path = structuredClone(REVIEW);
    path.issues[0]!.finding = "The page reads /Users/alice/private/cli.ts first.";
    expect(validateEditorialReviewResult(path)).toEqual(path);
  });

  it("keeps a shape refusal in an editorial review result retryable", () => {
    expect(thrown(() => validateEditorialReviewResult([])).retryable).toBe(true);
    expect(validateEditorialReviewResult(structuredClone(REVIEW))).toEqual(REVIEW);
  });
});
