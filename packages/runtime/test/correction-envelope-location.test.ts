// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { InferenceStepError } from "../src/execution/contracts.js";
import { validateVerificationResult } from "../src/workflow-execution/review-response.js";
import {
  bindTechnicalCorrectionResponse,
  type SourceObligationLedgerV1,
} from "../src/workflow-execution/source-obligation.js";
import { verificationResultFixture } from "./helpers/verification.js";

function rejection(value: unknown): InferenceStepError["rejection"] {
  try {
    bindTechnicalCorrectionResponse(
      value,
      // The nested verification result is refused before the ledger is read.
      {} as SourceObligationLedgerV1,
      (candidate) => validateVerificationResult(candidate, ["docs/guide.md"]),
    );
  } catch (error) {
    if (error instanceof InferenceStepError) return error.rejection;
    throw error;
  }
  throw new Error("expected the correction envelope to be refused");
}

describe("correction envelope rejection locations (#1180)", () => {
  it("names the nested verification member relative to the reply envelope", () => {
    const verificationResult = verificationResultFixture(["docs/guide.md"]) as unknown as {
      review: Record<string, unknown>;
      factInventory: Record<string, unknown>;
    };
    verificationResult.review.verdict = "definitely";

    expect(rejection({ verificationResult, obligationAccounting: [] })).toEqual({
      code: "review-schema-enum",
      location: "$.verificationResult.review.verdict",
    });
  });

  it("rebases a fact-inventory detail onto the envelope", () => {
    const verificationResult = verificationResultFixture(["docs/guide.md"]) as unknown as {
      factInventory: Record<string, unknown>;
    };
    verificationResult.factInventory.completeness = "complete";

    expect(rejection({ verificationResult, obligationAccounting: [] })).toEqual({
      code: "inventory-completeness",
      location: "$.verificationResult.factInventory",
    });
  });
});
