// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { WorkflowSearchPlanV1 } from "../workflow-contracts/contracts.js";
import { deepFreeze } from "../contract-kit/freeze.js";

export const sourceReadinessSearch: WorkflowSearchPlanV1 = deepFreeze({
  schemaVersion: 1,
  id: "source-readiness-discovery",
  version: "1.0.0",
  targets: [
    {
      id: "source-documentation-artifacts",
      targetKey: "source-documentation-artifacts",
      question:
        "Which documentation artifacts are discoverable inputs for future documentation work?",
      targetType: "artifact-existence",
      artifactClass: "documentation-artifact",
      requiredProbes: [
        { id: "source-doc-exact", strategy: "exact-path", location: "documentation-tree" },
        {
          id: "source-doc-inventory",
          strategy: "documentation-inventory",
          location: "documentation-tree",
        },
      ],
    },
    {
      id: "source-documentation-coverage",
      targetKey: "source-documentation-coverage",
      question:
        "Do the available sources provide complete and usable input for the requested documentation work?",
      targetType: "rubric-coverage",
      requiredProbes: [
        {
          id: "source-completeness-rubric",
          strategy: "rubric-assessment",
          location: "documentation-tree",
        },
        {
          id: "source-coverage-inventory",
          strategy: "documentation-inventory",
          location: "documentation-tree",
        },
        {
          id: "source-usability-rubric",
          strategy: "rubric-assessment",
          location: "documentation-tree",
        },
      ],
      rubric: {
        id: "docsfab-source-readiness",
        version: "1.0.0",
        criteria: [
          {
            id: "source-completeness",
            kind: "completeness",
            requiredProbeIds: ["source-completeness-rubric", "source-coverage-inventory"],
          },
          {
            id: "source-usability",
            kind: "usability",
            requiredProbeIds: ["source-usability-rubric"],
          },
        ],
      },
    },
  ],
});
