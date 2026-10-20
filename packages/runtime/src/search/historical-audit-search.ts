// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { RepositoryTarget } from "../repository/contracts.js";
import type {
  WorkflowSearchPlanV1,
  WorkflowSearchStepEvidenceV1,
} from "../workflow-contracts/contracts.js";
import { deepFreeze } from "../contract-kit/freeze.js";
import {
  decodeWorkflowSearchEvidence,
  WorkflowSearchEvidenceError,
} from "../workflow-contracts/search.js";

/** Exact v1 audit plan retained for records sealed before complete-coverage rubric v2. */
export const historicalDocumentationAuditSearch: WorkflowSearchPlanV1 = deepFreeze({
  schemaVersion: 1,
  id: "documentation-audit-discovery",
  version: "1.0.0",
  targets: [
    {
      id: "documentation-audit-rubric",
      targetKey: "documentation-audit-rubric",
      question:
        "What evidence supports or contradicts documentation correctness, coverage, findability, and maintainability?",
      targetType: "rubric-coverage",
      requiredProbes: [
        {
          id: "audit-accuracy-rubric",
          strategy: "rubric-assessment",
          location: "documentation-tree",
        },
        {
          id: "audit-completeness-rubric",
          strategy: "rubric-assessment",
          location: "documentation-tree",
        },
        {
          id: "audit-doc-inventory",
          strategy: "documentation-inventory",
          location: "documentation-tree",
        },
        {
          id: "audit-usability-rubric",
          strategy: "rubric-assessment",
          location: "documentation-tree",
        },
        { id: "audit-nav-rubric", strategy: "rubric-assessment", location: "navigation" },
        { id: "audit-nav-graph", strategy: "navigation-graph", location: "navigation" },
      ],
      rubric: {
        id: "docsfab-documentation-audit",
        version: "1.0.0",
        criteria: [
          { id: "audit-accuracy", kind: "accuracy", requiredProbeIds: ["audit-accuracy-rubric"] },
          {
            id: "audit-completeness",
            kind: "completeness",
            requiredProbeIds: ["audit-completeness-rubric", "audit-doc-inventory"],
          },
          {
            id: "audit-navigation",
            kind: "navigation",
            requiredProbeIds: ["audit-nav-graph", "audit-nav-rubric"],
          },
          {
            id: "audit-usability",
            kind: "usability",
            requiredProbeIds: ["audit-usability-rubric"],
          },
        ],
      },
    },
  ],
});

/** Saved audit records retain their original plan and rubric identity. */
export function decodeSavedWorkflowSearchEvidence(
  value: unknown,
  plan: WorkflowSearchPlanV1,
  repository: RepositoryTarget,
): WorkflowSearchStepEvidenceV1 {
  try {
    return decodeWorkflowSearchEvidence(value, plan, repository);
  } catch (error) {
    if (
      !(error instanceof WorkflowSearchEvidenceError) ||
      plan.id !== historicalDocumentationAuditSearch.id ||
      plan.version !== "2.0.0"
    ) {
      throw error;
    }
    return decodeWorkflowSearchEvidence(value, historicalDocumentationAuditSearch, repository);
  }
}
