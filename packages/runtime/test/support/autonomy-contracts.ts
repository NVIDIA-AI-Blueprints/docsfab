// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import * as contracts from "../../src/autonomy/index.js";
import * as workflowCatalog from "../../src/workflow-registry/catalog.js";

export * from "../../src/autonomy/index.js";

function withWorkflowAccess<Args extends unknown[], Result>(
  operation: (...args: [...Args, contracts.AutoCycleWorkflowAccess]) => Result,
): (...args: Args) => Result {
  return (...args) => operation(...args, workflowCatalog);
}

export const createAutoCycleRequest = withWorkflowAccess(contracts.createAutoCycleRequest);
export const createAutoWorkflowTaskBinding = withWorkflowAccess(
  contracts.createAutoWorkflowTaskBinding,
);
export const assertAutoCycleExecutionTask = withWorkflowAccess(
  contracts.assertAutoCycleExecutionTask,
);
export const decodeAutoCycleRequest = withWorkflowAccess(contracts.decodeAutoCycleRequest);
export const createWorkflowCandidate = withWorkflowAccess(contracts.createWorkflowCandidate);
export const decodeWorkflowCandidate = withWorkflowAccess(contracts.decodeWorkflowCandidate);
export const createAutoAssessment = withWorkflowAccess(contracts.createAutoAssessment);
export const decodeAutoAssessment = withWorkflowAccess(contracts.decodeAutoAssessment);
export const createWorkflowDecision = withWorkflowAccess(contracts.createWorkflowDecision);
export const decodeWorkflowDecision = withWorkflowAccess(contracts.decodeWorkflowDecision);
export const mintAutoCycleHostCapability = withWorkflowAccess(
  contracts.mintAutoCycleHostCapability,
);
export const decodeAutoCycleAuthorization = withWorkflowAccess(
  contracts.decodeAutoCycleAuthorization,
);
export const assertAutoCycleAuthorized = withWorkflowAccess(contracts.assertAutoCycleAuthorized);
export const projectAutoCycleAuthorization = withWorkflowAccess(
  contracts.projectAutoCycleAuthorization,
);
export const createAutoCycleTerminalResult = withWorkflowAccess(
  contracts.createAutoCycleTerminalResult,
);
export const decodeAutoCycleTerminalResult = withWorkflowAccess(
  contracts.decodeAutoCycleTerminalResult,
);
export const migrateAutoCycleRequest = withWorkflowAccess(contracts.migrateAutoCycleRequest);
export const migrateWorkflowCandidate = withWorkflowAccess(contracts.migrateWorkflowCandidate);
export const migrateAutoAssessment = withWorkflowAccess(contracts.migrateAutoAssessment);
export const migrateWorkflowDecision = withWorkflowAccess(contracts.migrateWorkflowDecision);
export const migrateAutoCycleAuthorization = withWorkflowAccess(
  contracts.migrateAutoCycleAuthorization,
);
export const migrateAutoCycleTerminalResult = withWorkflowAccess(
  contracts.migrateAutoCycleTerminalResult,
);
