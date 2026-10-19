// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { WorkflowSearchPlanV1 } from "../workflow-contracts/contracts.js";
import { deepFreeze } from "../contract-kit/freeze.js";

export const iaDiscoverySearch: WorkflowSearchPlanV1 = deepFreeze({
  schemaVersion: 1,
  id: "information-architecture-discovery",
  version: "1.0.0",
  targets: [
    {
      id: "information-architecture-rubric",
      targetKey: "information-architecture-rubric",
      question:
        "What repository evidence establishes the current documentation hierarchy, coverage, and navigation constraints for this IA task?",
      targetType: "rubric-coverage",
      requiredProbes: [
        { id: "ia-doc-rubric", strategy: "rubric-assessment", location: "documentation-tree" },
        {
          id: "ia-doc-inventory",
          strategy: "documentation-inventory",
          location: "documentation-tree",
        },
        { id: "ia-nav-rubric", strategy: "rubric-assessment", location: "navigation" },
        { id: "ia-nav-graph", strategy: "navigation-graph", location: "navigation" },
      ],
      rubric: {
        id: "docsfab-information-architecture",
        version: "1.0.0",
        criteria: [
          {
            id: "ia-completeness",
            kind: "completeness",
            requiredProbeIds: ["ia-doc-inventory", "ia-doc-rubric"],
          },
          {
            id: "ia-navigation",
            kind: "navigation",
            requiredProbeIds: ["ia-nav-graph", "ia-nav-rubric"],
          },
        ],
      },
    },
  ],
});
