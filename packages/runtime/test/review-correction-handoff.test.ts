// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../src/json-evidence.js";
import { createAuthoringPhaseEvidenceV1 } from "../src/records/authoring-execution.js";
import type { StepRunRecord } from "../src/records/contracts.js";
import { documentationAuditSearch } from "../src/maturity/audit-search-plan.js";
import { documentationObservationSearch } from "../src/search/observation-search-plan.js";
import { createAuthoringCandidate } from "../src/workflow-execution/authoring-candidate.js";
import type { ReviewResult } from "../src/workflow-execution/review-response.js";
import { admitCandidate0EditorialForCanonical } from "../src/workflow-execution/runner.js";
import { parseWorkflowManifestSnapshot } from "../src/workflow-registry/manifest.js";
import { authoringManifestV3, legacyAuthoringManifestV3 } from "./helpers/authoring-manifest.js";

const RUN_ID = "run-review-correction";
const REVISION = "a".repeat(40);
const workflow = parseWorkflowManifestSnapshot(authoringManifestV3(), "create-documentation", {
  "documentation-audit": documentationAuditSearch,
  "documentation-observation": documentationObservationSearch,
});
const candidate0 = createAuthoringCandidate({
  runId: RUN_ID,
  ordinal: 0,
  originalRevision: REVISION,
  planDigest: "b".repeat(64),
  writePaths: ["docs/guide.md"],
  patchDigestSha256: "c".repeat(64),
  patchBytes: 42,
  workspaceSnapshotDigest: "d".repeat(64),
});
const review: ReviewResult = {
  verdict: "needs-revision",
  issues: [
    {
      id: "EDITORIAL-001",
      severity: "major",
      category: "technical_accuracy",
      location: "docs/guide.md",
      finding: "The reader instruction contradicts the source-backed operation order.",
      evidence: { source_id: "source", locator: "src/contract.ts:10-20" },
      required_change: "State the source-backed operation order.",
    },
  ],
};
const summary = canonicalizeJsonEvidence(review as unknown as JsonEvidenceValue).trimEnd();

function editorialStep(
  input: {
    candidate?: typeof candidate0;
    phaseSummary?: string;
    summary?: string;
    id?: string;
    status?: StepRunRecord["status"];
  } = {},
): StepRunRecord {
  const candidate = input.candidate ?? candidate0;
  const stepSummary = input.summary ?? summary;
  return {
    id: input.id ?? "review-documentation",
    title: "Review documentation",
    kind: "evaluate",
    skill: "review-documentation",
    mode: "read-only",
    status: input.status ?? "succeeded",
    summary: stepSummary,
    authoringPhase: createAuthoringPhaseEvidenceV1({
      workflow,
      branchId: null,
      stepId: "review-documentation",
      candidates: [candidate],
      outputAdmitted: true,
      summary: input.phaseSummary ?? stepSummary,
    }),
  };
}

function admit(
  input: {
    runId?: string;
    repositoryRevision?: string;
    candidate?: typeof candidate0;
    step?: StepRunRecord;
    selectedWorkflow?: typeof workflow;
  } = {},
) {
  return admitCandidate0EditorialForCanonical({
    runId: input.runId ?? RUN_ID,
    repositoryRevision: input.repositoryRevision ?? REVISION,
    workflow: input.selectedWorkflow ?? workflow,
    candidate0: input.candidate ?? candidate0,
    step: input.step ?? editorialStep(),
  });
}

describe("review-to-correction editorial admission", () => {
  it("admits one strict candidate-zero editorial phase for canonical correction", () => {
    expect(admit()).toMatchObject({
      producerId: "review-documentation",
      candidateOrdinal: 0,
      candidateDigest: candidate0.digest,
      workspaceSnapshotDigest: candidate0.workspaceSnapshotDigest,
      result: review,
    });
  });

  it.each([
    ["wrong run", () => admit({ runId: "other-run" })],
    ["wrong revision", () => admit({ repositoryRevision: "e".repeat(40) })],
    ["wrong producer", () => admit({ step: editorialStep({ id: "future-review" }) })],
    ["future or incomplete producer", () => admit({ step: editorialStep({ status: "pending" }) })],
    [
      "stale summary digest",
      () => admit({ step: editorialStep({ phaseSummary: summary, summary: '{"issues":[]}' }) }),
    ],
    ["malformed summary", () => admit({ step: editorialStep({ summary: "not-json" }) })],
    [
      "wrong candidate ordinal",
      () => {
        const stale = createAuthoringCandidate({ ...candidate0, ordinal: 1 });
        return admit({ candidate: stale, step: editorialStep({ candidate: stale }) });
      },
    ],
    [
      "wrong candidate digest",
      () => {
        const stale = createAuthoringCandidate({
          ...candidate0,
          patchDigestSha256: "f".repeat(64),
        });
        return admit({ step: editorialStep({ candidate: stale }) });
      },
    ],
    [
      "wrong workspace snapshot",
      () => {
        const stale = createAuthoringCandidate({
          ...candidate0,
          workspaceSnapshotDigest: "1".repeat(64),
        });
        return admit({ step: editorialStep({ candidate: stale }) });
      },
    ],
    [
      "legacy pre-canonical layout",
      () =>
        admit({
          selectedWorkflow: parseWorkflowManifestSnapshot(
            legacyAuthoringManifestV3(),
            "create-documentation",
            {
              "documentation-audit": documentationAuditSearch,
              "documentation-observation": documentationObservationSearch,
            },
          ),
        }),
    ],
  ])("rejects %s before canonical context construction", (_name, action) => {
    expect(action).toThrow();
  });
});
