// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { WorkflowSearchPlanV1 } from "../workflow-contracts/contracts.js";
import { deepFreeze } from "../contract-kit/freeze.js";

/**
 * Required observation probes for plan / impact / verify.
 * navigation-entry already requires documentation-inventory then navigation-graph.
 */
export const documentationObservationSearch: WorkflowSearchPlanV1 = deepFreeze({
  schemaVersion: 1,
  id: "documentation-observation-discovery",
  version: "1.0.0",
  targets: [
    {
      id: "documentation-observation",
      targetKey: "documentation-observation",
      question: "Which documentation pages and navigation graph can this job consult?",
      targetType: "artifact-existence",
      artifactClass: "navigation-entry",
      requiredProbes: [
        {
          id: "observation-doc-inventory",
          strategy: "documentation-inventory",
          location: "documentation-tree",
        },
        {
          id: "observation-nav-graph",
          strategy: "navigation-graph",
          location: "navigation",
        },
      ],
    },
  ],
});

export function isObservationSearchPlan(
  search: WorkflowSearchPlanV1 | undefined,
): search is WorkflowSearchPlanV1 {
  return search?.id === documentationObservationSearch.id;
}
