// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { limit } from "../../src/config/limits.js";
import {
  assertReviewScopeFitsProposalBound,
  hostFilledCoverageBytes,
  ReviewScopeBoundError,
} from "../../src/workflow-execution/source-obligation.js";
import { RECORDED_JUDGMENT_TARGET } from "../helpers/recorded-review-judgment.js";
import type { ReviewTargetScope } from "./judgment-coverage-limitation-bound.scenario.js";

export function registerReviewScopeBoundReproduction(scope: ReviewTargetScope): void {
  const PROPOSAL_BOUND = limit("technicalCorrection.proposalMaxBytes");
  const probe7TargetsWithRecordedPage = () =>
    [...new Set([RECORDED_JUDGMENT_TARGET, ...scope.documentationTargets])].sort();
  describe(`${scope.label}: a review scope over the proposal bound at run start`, () => {
    it("is refused with the bound, the observed coverage bytes, the scope, and the remediation", () => {
      const targets = probe7TargetsWithRecordedPage();
      const bytes = hostFilledCoverageBytes(targets);
      expect(bytes).toBeGreaterThan(PROPOSAL_BOUND.value);

      let error: unknown;
      try {
        assertReviewScopeFitsProposalBound(targets);
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(ReviewScopeBoundError);
      const refused = error as ReviewScopeBoundError;
      expect(refused.code).toBe("technical-correction-proposal-max-bytes-bound");
      expect(refused.limitName).toBe("technicalCorrection.proposalMaxBytes");
      expect(refused.configured).toBe(PROPOSAL_BOUND.value);
      expect(refused.observed).toBe(bytes);
      expect(refused.message).toBe(
        `technical-correction-proposal-max-bytes-bound: ${bytes} exceeds technicalCorrection.proposalMaxBytes = 262144 bytes. ` +
          `${PROPOSAL_BOUND.remediation} Follow the named remediation. ` +
          `Scope: ${targets.length} target pages. Observed is the host-filled coverage alone, which every technical-correction proposal for this scope carries, measured before any model call.`,
      );
    });

    it("admits the focused probe-7 scope of one page", () => {
      expect(() => assertReviewScopeFitsProposalBound([RECORDED_JUDGMENT_TARGET])).not.toThrow();
    });
  });
}
