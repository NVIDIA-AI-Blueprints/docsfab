// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { RunRecord } from "../../src/records/contracts.js";
import { canonicalizeJsonEvidence } from "../../src/json-evidence.js";
import {
  createWorkflowOutcome,
  defaultInconclusiveWorkflowOutcome,
} from "../../src/workflow-contracts/outcome.js";
import { createDocumentationPlanBinding } from "../../src/workflow-execution/plan-binding.js";
import { verificationResultFixture } from "./verification.js";

export const UNADMITTED_AUTHORING_EVALUATOR_MARKDOWN = "UNADMITTED_AUTHORING_EVALUATOR_MARKDOWN";

export function authoringReviewFindingsRecord(): RunRecord {
  const path = "docs/usage.md";
  const verification = verificationResultFixture([path]);
  verification.review = {
    verdict: "needs-revision",
    issues: [
      {
        id: "TECH-001",
        severity: "major",
        category: "technical_accuracy",
        location: `${path}:12`,
        finding: "The documented representation is broader than the admitted source evidence.",
        evidence: { source_id: "approved-source:src/api.ts", locator: "src/api.ts:42" },
        required_change: "Constrain the documentation to the admitted representation.",
      },
    ],
  };
  const fact = verification.factInventory.dimensions[0]!.facts[0]!;
  fact.id = "FACT-001";
  fact.documentationDisposition = "omitted";
  fact.issueIds = ["TECH-001"];

  const record: RunRecord = {
    schemaVersion: 2,
    id: "authoring-findings-run-001",
    workflow: "create-documentation",
    repository: {
      sourcePath: "/tmp/example",
      requestedRevision: "HEAD",
      revision: "a".repeat(40),
    },
    workspace: { strategy: "tracked-export", disposable: true },
    status: "succeeded",
    createdAt: "2026-09-14T12:00:00.000Z",
    models: [],
    skills: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0 },
    tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
    steps: [
      {
        id: "plan-documentation",
        title: "Plan documentation",
        kind: "evaluate",
        skill: "plan-documentation",
        mode: "read-only",
        status: "succeeded",
        planBinding: createDocumentationPlanBinding({
          mode: "create",
          pages: [{ path, disposition: "create" }],
          sourceBindings: [{ pagePath: path, sources: ["src/api.ts"] }],
        }),
      },
      {
        id: "verify-technical-accuracy",
        title: "Verify technical accuracy",
        kind: "evaluate",
        skill: "verify-technical-accuracy",
        mode: "read-only",
        status: "succeeded",
        summary: canonicalizeJsonEvidence(verification as never).trimEnd(),
      },
      {
        id: "review-documentation",
        title: "Review documentation",
        kind: "evaluate",
        skill: "review-documentation",
        mode: "read-only",
        status: "succeeded",
        summary: canonicalizeJsonEvidence({
          issues: [
            {
              id: "TASK-001",
              severity: "minor",
              category: "task_success",
              location: `${path}:20`,
              finding: "The prerequisite is not linked from the task guide.",
              evidence: { source_id: "README.md", locator: "README.md:28" },
              required_change: "Link the prerequisite from the task guide.",
            },
          ],
          verdict: "needs-revision",
        }),
      },
      {
        id: "evaluate-document-quality",
        title: "Evaluate document quality",
        kind: "evaluate",
        skill: "evaluate-document-quality",
        mode: "read-only",
        status: "succeeded",
        summary: `${UNADMITTED_AUTHORING_EVALUATOR_MARKDOWN}: no validated quality artifact was emitted.`,
      },
    ],
  };
  record.workflowOutcome = createWorkflowOutcome(
    defaultInconclusiveWorkflowOutcome(record),
    record,
  );
  return record;
}
