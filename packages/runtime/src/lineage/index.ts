// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import * as workflowCatalog from "../workflow-registry/catalog.js";
import * as contracts from "./contracts.js";

export * from "./cli-operator-directed.js";
export * from "./contracts.js";
export * from "./run-capture.js";

function withWorkflowAccess<Args extends unknown[], Result>(
  operation: (...args: [...Args, contracts.TaskLineageWorkflowAccess]) => Result,
): (...args: Args) => Result {
  return (...args) => operation(...args, workflowCatalog);
}

export const createBoundedInstructionRequestIdentity = withWorkflowAccess(
  contracts.createBoundedInstructionRequestIdentity,
);
export const createStructuredTaskRequestIdentity = withWorkflowAccess(
  contracts.createStructuredTaskRequestIdentity,
);
export const createWorkflowLineageCandidate = withWorkflowAccess(
  contracts.createWorkflowLineageCandidate,
);
export const mintTaskLineageHostCapability = withWorkflowAccess(
  contracts.mintTaskLineageHostCapability,
);
export const decodeDecisionLineage = withWorkflowAccess(contracts.decodeDecisionLineage);
export const serializeDecisionLineage = withWorkflowAccess(contracts.serializeDecisionLineage);
export const decodePersistedDecisionLineage = withWorkflowAccess(
  contracts.decodePersistedDecisionLineage,
);
export const restoreTaskLineageArtifacts = withWorkflowAccess(
  contracts.restoreTaskLineageArtifacts,
);
export const assertTaskLineageAuthentic = withWorkflowAccess(contracts.assertTaskLineageAuthentic);
export const projectTaskLineage = withWorkflowAccess(contracts.projectTaskLineage);
export const migrateDecisionLineage = withWorkflowAccess(contracts.migrateDecisionLineage);
