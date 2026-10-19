// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Canonical manifests without domain execution implementation imports. */
import type { WorkflowDefinition, WorkflowName } from "../workflow-contracts/contracts.js";
import { iaDiscoverySearch } from "../ia/discovery-search-plan.js";
import { documentationAuditSearch } from "../maturity/audit-search-plan.js";
import { documentationObservationSearch } from "../search/observation-search-plan.js";
import { sourceReadinessSearch } from "../readiness/workflow.js";
import { releaseDocumentationReadinessSearch } from "../readiness/release-workflow.js";
import { loadWorkflowManifestCatalog, type DeclarativeWorkflowName } from "./manifest.js";

let cached: Readonly<Record<DeclarativeWorkflowName, WorkflowDefinition>> | undefined;
export function loadDeclarativeWorkflowCatalog(): Readonly<
  Record<DeclarativeWorkflowName, WorkflowDefinition>
> {
  return (cached ??= loadWorkflowManifestCatalog({
    searchPlans: {
      "documentation-audit": documentationAuditSearch,
      "documentation-observation": documentationObservationSearch,
      "information-architecture-discovery": iaDiscoverySearch,
      "source-readiness": sourceReadinessSearch,
      "release-documentation-readiness": releaseDocumentationReadinessSearch,
    },
  }));
}
export function getDeclarativeWorkflow(name: WorkflowName): WorkflowDefinition | undefined {
  return (loadDeclarativeWorkflowCatalog() as Partial<Record<WorkflowName, WorkflowDefinition>>)[
    name
  ];
}
