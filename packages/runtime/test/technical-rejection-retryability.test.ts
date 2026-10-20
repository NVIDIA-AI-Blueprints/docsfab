// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { InferenceStepError } from "../src/execution/contracts.js";
import { RESPONSE_REJECTION_RULE_HINTS } from "../src/harness/response-correction.js";
import { ruleHintFor } from "../src/workflow-execution/rejection-rule-hints.js";
import {
  EVERY_CORRECTABLE_TECHNICAL_REASON_HAS_A_RULE,
  FACT_INVENTORY_RULE_HINTS,
} from "../src/workflow-execution/review-response-rule-hints.js";
import {
  DIMENSION_DEMOTION_REJECTIONS,
  FACT_INVENTORY_LIMITATION_BOUND_REJECTION,
  ISSUE_JUDGMENT_VOCABULARY_REJECTIONS,
  TECHNICAL_CORRECTION_BYTE_BOUNDS,
  TECHNICAL_REJECTION_RETRYABILITY_COVERAGE,
  TECHNICAL_REVIEW_REJECTION_CODES,
  UNKNOWN_OBLIGATION_LINK_REJECTION,
  rejectTechnicalCorrection,
  technicalCorrectionBoundary,
  validateVerificationResult,
  type TechnicalRejectionReasonCode,
  type TechnicalReviewRejectionCode,
} from "../src/workflow-execution/review-response.js";
import {
  FACT_LINK_REJECTION_CODES,
  TECHNICAL_REJECTION_RETRYABILITY,
  isModelCorrectableTechnicalRejection,
} from "../src/workflow-execution/technical-rejection-retryability.js";
import { verificationResultFixture } from "./helpers/verification.js";

const EVERY_REASON: readonly TechnicalRejectionReasonCode[] = [
  ...TECHNICAL_REVIEW_REJECTION_CODES,
  ...(Object.keys(FACT_INVENTORY_RULE_HINTS) as (keyof typeof FACT_INVENTORY_RULE_HINTS)[]).map(
    (detail) => `inventory-${detail}` as const,
  ),
  ...FACT_LINK_REJECTION_CODES,
  UNKNOWN_OBLIGATION_LINK_REJECTION.code,
  ISSUE_JUDGMENT_VOCABULARY_REJECTIONS.severity.code,
  ISSUE_JUDGMENT_VOCABULARY_REJECTIONS.category.code,
  ...Object.values(DIMENSION_DEMOTION_REJECTIONS).map(({ code }) => code),
  FACT_INVENTORY_LIMITATION_BOUND_REJECTION.code,
  ...Object.values(TECHNICAL_CORRECTION_BYTE_BOUNDS).map(({ code }) => code),
];

/** Authority, credential, and disclosure violations stop immediately. */
const TERMINAL: readonly TechnicalReviewRejectionCode[] = [
  "unsafe-disclosure",
  "source-authority",
  "target-authority",
];

/**
 * So does a limitation-count overflow, which only retaining obligations the
 * source does not establish could fit.
 */
const TERMINAL_REASONS: readonly TechnicalRejectionReasonCode[] = [
  ...TERMINAL,
  FACT_INVENTORY_LIMITATION_BOUND_REJECTION.code,
  // A byte bound no re-ask can fit: the host built the record, or the scope's
  // host-filled coverage alone is over it.
  ...Object.values(TECHNICAL_CORRECTION_BYTE_BOUNDS).map(({ code }) => code),
  // Host-derived links; these fire only on a host-built proposal or record.
  "fact-link-documented-fact",
  "fact-link-judgment-omits-linked-facts",
  "fact-link-judgment-fact-mismatch",
  "fact-link-judgment-missing-fact",
  "fact-link-unknown-issue",
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

describe("technical rejection retryability table (#1238)", () => {
  it("classifies every closed reason exactly once, with a reason", () => {
    // The compile-time reading: a reason without an entry, or a stale entry,
    // fails the typecheck before this runs.
    expect(TECHNICAL_REJECTION_RETRYABILITY_COVERAGE).toBe(true);
    expect(Object.keys(TECHNICAL_REJECTION_RETRYABILITY).sort()).toEqual(
      [...new Set(EVERY_REASON)].sort(),
    );
    for (const code of EVERY_REASON) {
      const entry = TECHNICAL_REJECTION_RETRYABILITY[code];
      expect(["model-correctable", "terminal"], code).toContain(entry.retry);
      expect(entry.reason.trim().length, code).toBeGreaterThan(0);
    }
  });

  it("keeps security and authority refusals terminal and retries every other reason", () => {
    for (const code of EVERY_REASON) {
      expect(isModelCorrectableTechnicalRejection(code), code).toBe(
        !(TERMINAL_REASONS as readonly string[]).includes(code),
      );
    }
  });

  it("gives every model-correctable reason its own rule hint", () => {
    expect(EVERY_CORRECTABLE_TECHNICAL_REASON_HAS_A_RULE).toBe(true);
    for (const code of EVERY_REASON.filter(isModelCorrectableTechnicalRejection)) {
      expect(
        ruleHintFor(RESPONSE_REJECTION_RULE_HINTS, { code, location: "$" }),
        code,
      ).toBeTruthy();
    }
  });

  it("raises each correction-only refusal with the table's classification", () => {
    for (const code of TECHNICAL_REVIEW_REJECTION_CODES) {
      expect(thrown(() => rejectTechnicalCorrection(code)).retryable, code).toBe(
        isModelCorrectableTechnicalRejection(code),
      );
    }
    for (const code of FACT_LINK_REJECTION_CODES) {
      const error = thrown(() =>
        rejectTechnicalCorrection("invalid-fact-link", undefined, { code, location: "$" }),
      );
      expect(error.retryable, code).toBe(isModelCorrectableTechnicalRejection(code));
      expect(error.rejection).toEqual({ code, location: "$" });
    }
  });
});

describe("technical correction boundary without host rejection state (#1238)", () => {
  const repairable = () => {
    throw new InferenceStepError("contract kit refusal", "malformed-response", true);
  };

  it("retries a repairable host contract refusal under a model-correctable code", () => {
    const error = thrown(() => technicalCorrectionBoundary("invalid-shape", repairable));
    expect(error).toMatchObject({
      message: "Technical correction response rejected: invalid-shape.",
      retryable: true,
      rejection: { code: "invalid-shape", location: "$response" },
    });
  });

  it.each(TERMINAL)("keeps the same refusal terminal under %s", (code) => {
    expect(thrown(() => technicalCorrectionBoundary(code, repairable)).retryable).toBe(false);
  });

  it("keeps a refusal its raiser marked terminal, and a host exception, terminal", () => {
    expect(
      thrown(() =>
        technicalCorrectionBoundary("invalid-shape", () => {
          throw new InferenceStepError("host refusal", "malformed-response", false);
        }),
      ).retryable,
    ).toBe(false);
    expect(
      thrown(() =>
        technicalCorrectionBoundary("invalid-shape", () => {
          throw new TypeError("host defect");
        }),
      ).retryable,
    ).toBe(false);
  });

  it("keeps an unavailable host review schema terminal through the correction wrap", () => {
    const error = thrown(() =>
      technicalCorrectionBoundary(
        "invalid-review",
        () =>
          validateVerificationResult(
            verificationResultFixture(["docs/page.md"]),
            ["docs/page.md"],
            () => "schema-unavailable",
          ),
        "$.verificationResult",
      ),
    );
    expect(error).toMatchObject({
      message: "Technical correction response rejected: invalid-review.",
      retryable: false,
    });
  });
});
