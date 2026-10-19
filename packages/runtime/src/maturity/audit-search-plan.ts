// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { WorkflowSearchPlanV1 } from "../workflow-contracts/contracts.js";
import { deepFreeze } from "../contract-kit/freeze.js";
import { SEARCH_COMPLETE_COVERAGE_RUBRIC_VERSION } from "../search/bounded-search-contracts.js";

/** Shared discovery contract for documentation-audit search. */
export const documentationAuditSearch: WorkflowSearchPlanV1 = deepFreeze({
  schemaVersion: 1,
  id: "documentation-audit-discovery",
  version: "2.0.0",
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
        version: SEARCH_COMPLETE_COVERAGE_RUBRIC_VERSION,
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
