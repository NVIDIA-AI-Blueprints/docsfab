// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";

import {
  createWorkflowLineageCandidate,
  type AutonomousTaskSelectionV1,
  type DecisionAttributionInputV1,
  type DocsFabTaskRecommendationV1,
  type OperatorTaskApprovalV1,
  type RejectedWorkflowAlternativeInputV1,
  type TaskLineageRepositoryBindingV1,
  type TaskRequestIdentityV1,
  type WorkflowLineageCandidateInputV1,
} from "../../src/lineage/index.js";

export interface CurrentTaskLineageFixture {
  repository: TaskLineageRepositoryBindingV1;
  request: TaskRequestIdentityV1;
  approval: OperatorTaskApprovalV1;
  recommendation: DocsFabTaskRecommendationV1;
  autonomousSelection: AutonomousTaskSelectionV1;
  candidates: WorkflowLineageCandidateInputV1[];
  selectedCandidateSha256: string;
  rejectedAlternatives: RejectedWorkflowAlternativeInputV1[];
  sharedDecisions: DecisionAttributionInputV1[];
}

const SELECTED_CANDIDATE_ID = "candidate:update-documentation";
const REJECTED_CANDIDATE_ID_BY_REASON = {
  "task-kind-incompatible": "candidate:review-documentation",
} as const;

const authoredFixture = JSON.parse(
  readFileSync(new URL("../fixtures/task-lineage-v1.json", import.meta.url), "utf8"),
) as CurrentTaskLineageFixture;

function currentCandidateDigests(fixture: CurrentTaskLineageFixture): Map<string, string> {
  const result = new Map<string, string>();
  for (const input of fixture.candidates) {
    if (result.has(input.id)) {
      throw new Error(`task-lineage-v1.json has duplicate candidate identity ${input.id}`);
    }
    result.set(input.id, createWorkflowLineageCandidate(input).candidateSha256);
  }
  return result;
}

function requiredDigest(digests: ReadonlyMap<string, string>, candidateId: string): string {
  const digest = digests.get(candidateId);
  if (!digest) {
    throw new Error(`task-lineage-v1.json is missing authored candidate identity ${candidateId}`);
  }
  return digest;
}

function rejectedCandidateId(reasonCode: string): string {
  const candidateId =
    REJECTED_CANDIDATE_ID_BY_REASON[reasonCode as keyof typeof REJECTED_CANDIDATE_ID_BY_REASON];
  if (!candidateId) {
    throw new Error(
      `task-lineage-v1.json rejectedAlternatives has unmapped reasonCode ${reasonCode}; review its candidate identity deliberately`,
    );
  }
  return candidateId;
}

/**
 * Keeps narrative test setup joined to the current workflow topology while the
 * source fixture remains an independently authored contract oracle.
 */
export function buildCurrentTaskLineageFixture(
  source: CurrentTaskLineageFixture = authoredFixture,
): CurrentTaskLineageFixture {
  const fixture = structuredClone(source);
  const digests = currentCandidateDigests(fixture);
  const selectedCandidateSha256 = requiredDigest(digests, SELECTED_CANDIDATE_ID);
  const rejectedAlternatives = fixture.rejectedAlternatives.map((rejected) => ({
    ...rejected,
    candidateSha256: requiredDigest(digests, rejectedCandidateId(rejected.reasonCode)),
  }));
  const sharedDecisions = fixture.sharedDecisions.map((decision) =>
    decision.id === "decision:workflow"
      ? { ...decision, outcomeSha256: selectedCandidateSha256 }
      : decision,
  );

  return {
    ...fixture,
    selectedCandidateSha256,
    rejectedAlternatives,
    sharedDecisions,
  };
}

export function taskLineageFixtureDigestMismatches(fixture: CurrentTaskLineageFixture): string[] {
  const current = buildCurrentTaskLineageFixture(fixture);
  const mismatches: string[] = [];
  if (fixture.selectedCandidateSha256 !== current.selectedCandidateSha256) {
    mismatches.push(
      `selectedCandidateSha256 (${SELECTED_CANDIDATE_ID}) disagrees with the current workflow topology`,
    );
  }
  fixture.rejectedAlternatives.forEach((rejected, index) => {
    if (rejected.candidateSha256 !== current.rejectedAlternatives[index]?.candidateSha256) {
      mismatches.push(
        `rejectedAlternatives[${index}].candidateSha256 (${rejectedCandidateId(rejected.reasonCode)}) disagrees with the current workflow topology`,
      );
    }
  });
  const fixtureWorkflowDecision = fixture.sharedDecisions.find(
    (decision) => decision.id === "decision:workflow",
  );
  if (fixtureWorkflowDecision?.outcomeSha256 !== current.selectedCandidateSha256) {
    mismatches.push(
      `sharedDecisions[decision:workflow].outcomeSha256 (${SELECTED_CANDIDATE_ID}) disagrees with selectedCandidateSha256`,
    );
  }
  return mismatches;
}
