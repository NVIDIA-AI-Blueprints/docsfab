// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { WorkflowSearchPlanV1 } from "../workflow-contracts/contracts.js";
import { deepFreeze } from "../contract-kit/freeze.js";

/** Data-only search contract for the release-roadmap adapter. */
export const ROADMAP_DISCOVERY_SEARCH_PLAN: WorkflowSearchPlanV1 = deepFreeze({
  schemaVersion: 1,
  id: "release-roadmap-discovery",
  version: "1.0.0",
  targets: [
    {
      id: "release-boundary-documentation-accounting",
      targetKey: "release-boundary-documentation-accounting",
      question:
        "Has each change in the confirmed release boundary been assessed for existing or required documentation work?",
      targetType: "rubric-coverage",
      requiredProbes: [
        {
          id: "roadmap-accounting-rubric",
          strategy: "rubric-assessment",
          location: "documentation-tree",
        },
        {
          id: "roadmap-documentation-inventory",
          strategy: "documentation-inventory",
          location: "documentation-tree",
        },
      ],
      rubric: {
        id: "docsfab-release-roadmap-accounting",
        version: "1.0.0",
        criteria: [
          {
            id: "roadmap-completeness",
            kind: "completeness",
            requiredProbeIds: ["roadmap-accounting-rubric", "roadmap-documentation-inventory"],
          },
        ],
      },
    },
  ],
});
