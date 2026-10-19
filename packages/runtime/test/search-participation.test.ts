// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { getWorkflow } from "../src/workflow-registry/catalog.js";
import {
  createSearchParticipationState,
  markAuthorizedWrite,
  rememberSearchObservation,
  resolveSearchParticipation,
  SearchParticipationError,
} from "../src/workflow-execution/search-participation.js";
import type { LastSearchObservation } from "../src/workflow-execution/search-participation.js";
import type { DocumentationGapLedgerV1 } from "../src/search/gap-ledger.js";
import type { WorkflowSearchStepEvidenceV1 } from "../src/workflow-contracts/contracts.js";

const SNAPSHOT = "a".repeat(64);
const OTHER_SNAPSHOT = "b".repeat(64);

function observation(overrides: Partial<LastSearchObservation> = {}): LastSearchObservation {
  const searchEvidence = {
    schemaVersion: 1,
    kind: "docsfab-workflow-search-evidence",
    planId: "documentation-observation-discovery",
    planVersion: "1.0.0",
    workspaceSnapshotSha256: SNAPSHOT,
    searches: [],
    evidenceSha256: "c".repeat(64),
  } as unknown as WorkflowSearchStepEvidenceV1;
  const gapLedger = {
    schemaVersion: 1,
    kind: "docsfab-documentation-gap-ledger",
    repositoryIdentitySha256: "d".repeat(64),
    currentRevision: "e".repeat(40),
    entries: [],
    ledgerSha256: "f".repeat(64),
  } as unknown as DocumentationGapLedgerV1;
  return {
    stepId: "plan-documentation",
    observedByStepId: "plan-documentation",
    searchMode: "observe",
    planId: "documentation-observation-discovery",
    workspaceSnapshotSha256: SNAPSHOT,
    searchEvidence,
    searchFindings: [],
    gapLedger,
    ...overrides,
  };
}

describe("workflow search participation", () => {
  it("reuses sealed evidence until an authorized write changes the snapshot", () => {
    const workflow = getWorkflow("update-documentation");
    const verify = workflow.steps.find((step) => step.id === "verify-technical-accuracy")!;
    const evaluate = workflow.steps.find((step) => step.id === "evaluate-document-quality")!;
    const state = createSearchParticipationState();
    rememberSearchObservation(state, observation());

    expect(resolveSearchParticipation({ step: verify, state })?.mode).toBe("revalidate");
    expect(resolveSearchParticipation({ step: evaluate, state })?.mode).toBe("reuse");

    markAuthorizedWrite(state);
    expect(() => resolveSearchParticipation({ step: evaluate, state })).toThrow(
      SearchParticipationError,
    );
    expect(() => resolveSearchParticipation({ step: evaluate, state })).toThrow(
      /workspace snapshot changed/u,
    );
    expect(resolveSearchParticipation({ step: verify, state })?.mode).toBe("revalidate");

    rememberSearchObservation(
      state,
      observation({
        stepId: "verify-technical-accuracy",
        searchMode: "revalidate",
        workspaceSnapshotSha256: OTHER_SNAPSHOT,
      }),
    );
    expect(resolveSearchParticipation({ step: evaluate, state })?.mode).toBe("reuse");
  });

  it("rejects a second observe of the same plan in one run", () => {
    const workflow = getWorkflow("update-documentation");
    const plan = workflow.steps.find((step) => step.id === "plan-documentation")!;
    const state = createSearchParticipationState();
    rememberSearchObservation(state, observation());
    expect(() => resolveSearchParticipation({ step: plan, state })).toThrow(/already observed/u);
  });
});
