// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { createWorkflowLineageCandidate, TaskLineageContractError } from "../src/lineage/index.js";
import {
  buildCurrentTaskLineageFixture,
  taskLineageFixtureDigestMismatches,
} from "./helpers/current-task-lineage.js";

const REVIEW_STEP_IDS = [
  "audit-documentation",
  "derive-source-obligations",
  "lint-documentation",
  "provisional-technical-verification",
  "verify-technical-accuracy",
  "review-documentation",
  "test-audience-understanding",
  "evaluate-document-quality",
];

describe("current task-lineage fixture builder", () => {
  it("joins selected and rejected digests by authored candidate identity", () => {
    const source = buildCurrentTaskLineageFixture();
    source.candidates.reverse();

    const current = buildCurrentTaskLineageFixture(source);
    const candidates = new Map(
      current.candidates.map((candidate) => [
        candidate.id,
        createWorkflowLineageCandidate(candidate).candidateSha256,
      ]),
    );

    expect(current.selectedCandidateSha256).toBe(candidates.get("candidate:update-documentation"));
    expect(current.rejectedAlternatives).toEqual([
      {
        ...source.rejectedAlternatives[0],
        candidateSha256: candidates.get("candidate:review-documentation"),
      },
    ]);
    expect(
      current.sharedDecisions.find((decision) => decision.id === "decision:workflow")
        ?.outcomeSha256,
    ).toBe(candidates.get("candidate:update-documentation"));
  });

  it("diagnoses deliberately stale selected and rejected fixture digests", () => {
    const stale = buildCurrentTaskLineageFixture();
    stale.selectedCandidateSha256 = "f".repeat(64);
    stale.rejectedAlternatives[0]!.candidateSha256 = "e".repeat(64);

    expect(taskLineageFixtureDigestMismatches(stale)).toEqual([
      "selectedCandidateSha256 (candidate:update-documentation) disagrees with the current workflow topology",
      "rejectedAlternatives[0].candidateSha256 (candidate:review-documentation) disagrees with the current workflow topology",
    ]);
  });

  it("retains an independent REVIEW topology check and rejects an incompatible candidate", () => {
    const fixture = buildCurrentTaskLineageFixture();
    const reviewInput = fixture.candidates.find(
      (candidate) => candidate.id === "candidate:review-documentation",
    );
    expect(reviewInput).toBeDefined();
    const reviewCandidate = createWorkflowLineageCandidate(reviewInput!);
    expect(reviewCandidate.stepIds).toEqual(REVIEW_STEP_IDS);

    try {
      createWorkflowLineageCandidate({
        ...reviewInput!,
        stepIds: REVIEW_STEP_IDS.slice(0, -1),
        candidateSha256: reviewCandidate.candidateSha256,
      } as never);
      throw new Error("Expected task-lineage candidate admission to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(TaskLineageContractError);
      expect((error as TaskLineageContractError).code).toBe("digest-mismatch");
    }
  });
});
