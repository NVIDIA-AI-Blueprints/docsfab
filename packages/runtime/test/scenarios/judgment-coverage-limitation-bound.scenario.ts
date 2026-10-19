// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { limit } from "../../src/config/limits.js";
import { parseRetryPolicy } from "../../src/config/retry-policy.js";
import { InferenceStepError } from "../../src/execution/contracts.js";
import {
  HOST_COVERAGE_DEGRADATION_STEM,
  HOST_FILLED_COVERAGE_REASON,
  degradeJudgmentCoverage,
} from "../../src/workflow-execution/judgment-coverage.js";
import {
  decodeProvisionalVerificationJudgment,
  hostFilledCoverageBytes,
} from "../../src/workflow-execution/source-obligation.js";
import {
  RECORDED_JUDGMENT_TARGET,
  probe7AttemptRows,
  recordedReviewJudgmentFixture,
} from "../helpers/recorded-review-judgment.js";
import {
  captureInferenceFailure,
  createAuditHarness,
  createRepository,
  resetSharedTestState,
  scriptedProvider,
  textTurn,
  type HarnessStepInput,
} from "../support/pi-harness-session-fixtures.js";

function decodeError(run: () => unknown): InferenceStepError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(InferenceStepError);
    return error as InferenceStepError;
  }
  throw new Error("expected the judgment to be refused");
}

const PROPOSAL_BOUND = limit("technicalCorrection.proposalMaxBytes");

/**
 * The proposal bound's refusal, written out as the oracle: the bound, the
 * observed bytes, its remediation, and the scope with the coverage the host
 * writes for it, which alone is over the bound.
 */
function proposalBoundMessage(observed: number, targets: readonly string[]): string {
  return (
    "Technical correction response rejected: bounds-exceeded. " +
    `technical-correction-proposal-max-bytes-bound: ${observed} exceeds technicalCorrection.proposalMaxBytes = 262144 bytes. ` +
    `${PROPOSAL_BOUND.remediation} Follow the named remediation. ` +
    `Scope: ${targets.length} target pages and 18 source obligations; their host-filled coverage alone is ${hostFilledCoverageBytes(targets)} bytes.`
  );
}

export interface ReviewTargetScope {
  readonly label: string;
  readonly documentationTargets: readonly string[];
  readonly targetDescription: string;
  readonly judgmentProposalBytes: number;
  readonly floorProposalBytes: number;
}

export function registerJudgmentCoverageLimitationBound(scope: ReviewTargetScope): void {
  const probe7DocumentationSetTargets = () => [...scope.documentationTargets];
  const probe7TargetsWithRecordedPage = () =>
    [...new Set([RECORDED_JUDGMENT_TARGET, ...scope.documentationTargets])].sort();
  describe(scope.label, () => {
    afterEach(async () => {
      vi.unstubAllGlobals();
      await resetSharedTestState();
    });

    /**
     * The host's coverage note quotes as many filled pages as fit
     * `technicalCorrection.fieldMaxChars` and then counts the rest, so over a long
     * target list it runs a little past that value. The fact inventory validator
     * does not bound a limitation's length, so a host-authored note is not refused
     * as if the model had written it; the count bound stays.
     */
    describe("a host coverage note longer than the former per-limitation bound", () => {
      const FORMER_BOUND = limit("technicalCorrection.fieldMaxChars").value;

      it(`is what the host writes over ${scope.targetDescription}`, () => {
        const { judgment } = recordedReviewJudgmentFixture("/workspace");
        const targets = probe7TargetsWithRecordedPage();
        expect(targets).toHaveLength(probe7DocumentationSetTargets().length + 1);

        const degraded = degradeJudgmentCoverage(judgment.coverage, targets);

        expect(degraded.filledPaths).toHaveLength(targets.length - 1);
        const lengths = degraded.limitations.map((note) => note.length);
        expect(Math.max(...lengths)).toBeGreaterThan(FORMER_BOUND);
      });

      it("is admitted in a judgment whose proposal fits its byte bound", () => {
        // Same-width synthetic pages beside the recorded page: enough that the
        // quoted list fills the budget and the count sentence runs past it, few
        // enough that the host-filled coverage fits the proposal byte bound.
        const pages = Array.from(
          { length: 400 },
          (_, index) => `docs/p${String(index).padStart(4, "0")}.md`,
        );
        const targets = [RECORDED_JUDGMENT_TARGET, ...pages];
        const fixture = recordedReviewJudgmentFixture("/workspace", { targets });

        const result = decodeProvisionalVerificationJudgment(
          fixture.answer,
          fixture.ledger,
          targets,
          undefined,
          { degradeCoverage: true },
        );

        const notes = result.factInventory.limitations.filter((entry) =>
          entry.startsWith(HOST_COVERAGE_DEGRADATION_STEM),
        );
        expect(notes).toHaveLength(1);
        expect(notes[0]!.length).toBeGreaterThan(FORMER_BOUND);
        expect(result.coverage).toHaveLength(targets.length);
      });

      it("stops the real judgment over the 1,313 targets at the proposal bound, without a re-ask", () => {
        // At documentation-set scope the host-filled coverage alone exceeds the
        // proposal byte bound, so the step's floor cannot fit and the scope, not
        // the reply, is what must change. A terser reply than the floor is not tried.
        const fixture = recordedReviewJudgmentFixture("/workspace");
        const targets = probe7TargetsWithRecordedPage();
        expect(hostFilledCoverageBytes(targets)).toBeGreaterThan(PROPOSAL_BOUND.value);

        const error = decodeError(() =>
          decodeProvisionalVerificationJudgment(
            fixture.answer,
            fixture.ledger,
            targets,
            undefined,
            {
              degradeCoverage: true,
            },
          ),
        );

        expect(error.message).toBe(proposalBoundMessage(scope.judgmentProposalBytes, targets));
        expect(error.rejection).toEqual({
          code: "technical-correction-proposal-max-bytes-bound",
          location: "$response",
        });
        expect(error.retryable).toBe(false);
      });
    });

    /**
     * The floor does not mask the proposal byte bound: over the documentation-set
     * target list it carries the same host-filled coverage as any reply, so it
     * exceeds the same bound; over a focused-set scope it fits.
     */
    describe("the floor over the probe-7 target sets", () => {
      const FINAL_ATTEMPT = parseRetryPolicy({}).maxRetries + 1;

      function onFinalAttempt(input: HarnessStepInput): HarnessStepInput {
        return {
          ...input,
          inferenceAttempt: FINAL_ATTEMPT,
          retriesConsumed: FINAL_ATTEMPT - 1,
          finalInferenceAttempt: true,
        };
      }

      it("stops the host-built floor over the 1,313 documentation-set targets as a host bound, not a model refusal", async () => {
        const repositoryPath = await createRepository();
        const targets = probe7TargetsWithRecordedPage();
        const fixture = recordedReviewJudgmentFixture(repositoryPath, { targets });
        vi.stubGlobal("fetch", scriptedProvider([textTurn(probe7AttemptRows(fixture.judgment))]));

        const error = await captureInferenceFailure(
          await createAuditHarness(),
          onFinalAttempt(fixture.provisional),
        );

        expect(error.message).toBe(proposalBoundMessage(scope.floorProposalBytes, targets));
        expect(error.rejection).toEqual({
          code: "technical-correction-proposal-max-bytes-bound",
          location: "$response",
        });
        expect(error.retryable).toBe(false);
      });

      it("decodes over the largest focused-set scope, reviewScope.maxTargets pages", async () => {
        const maxTargets = limit("reviewScope.maxTargets").value;
        const targets = [
          RECORDED_JUDGMENT_TARGET,
          ...probe7DocumentationSetTargets().filter((path) => path !== RECORDED_JUDGMENT_TARGET),
        ]
          .slice(0, maxTargets)
          .sort();
        expect(targets).toHaveLength(maxTargets);
        const repositoryPath = await createRepository();
        const fixture = recordedReviewJudgmentFixture(repositoryPath, { targets });
        vi.stubGlobal("fetch", scriptedProvider([textTurn(probe7AttemptRows(fixture.judgment))]));

        const result = await (await createAuditHarness()).runStep(
          onFinalAttempt(fixture.provisional),
        );

        expect(result.verificationResult?.review).toEqual({ verdict: "human-review", issues: [] });
        expect(result.verificationResult?.coverage).toHaveLength(maxTargets);
        expect(
          result.verificationResult?.coverage.every(
            (entry) =>
              entry.status === "unverified" && entry.reason === HOST_FILLED_COVERAGE_REASON,
          ),
        ).toBe(true);
        const notes = (result.verificationResult?.factInventory.limitations ?? []).filter((entry) =>
          entry.startsWith(HOST_COVERAGE_DEGRADATION_STEM),
        );
        expect(notes).toHaveLength(1);
        expect(notes[0]).toMatch(/ further page\(s\) are not listed\.$/u);
      });
    });
  });
}
