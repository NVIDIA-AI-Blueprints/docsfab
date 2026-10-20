// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import * as contracts from "../../src/maturity/index.js";
import * as workflowCatalog from "../../src/workflow-registry/catalog.js";

export * from "../../src/maturity/index.js";

function withWorkflowAccess<Args extends unknown[], Result>(
  operation: (...args: [...Args, contracts.DocumentationMaturityWorkflowAccess]) => Result,
): (...args: Args) => Result {
  return (...args) => operation(...args, workflowCatalog);
}

export const createDocumentationMaturityFinding = withWorkflowAccess(
  contracts.createDocumentationMaturityFinding,
);
export const decodeDocumentationMaturityFinding = withWorkflowAccess(
  contracts.decodeDocumentationMaturityFinding,
);
export const validateDocumentationMaturityFinding = withWorkflowAccess(
  contracts.validateDocumentationMaturityFinding,
);
export const createDocumentationMaturityWorkUnit = withWorkflowAccess(
  contracts.createDocumentationMaturityWorkUnit,
);
export const decodeDocumentationMaturityWorkUnit = withWorkflowAccess(
  contracts.decodeDocumentationMaturityWorkUnit,
);
export const validateDocumentationMaturityWorkUnit = withWorkflowAccess(
  contracts.validateDocumentationMaturityWorkUnit,
);
export const projectSanitizedDocumentationMaturityFinding = withWorkflowAccess(
  contracts.projectSanitizedDocumentationMaturityFinding,
);
export const projectSanitizedDocumentationMaturityWorkUnit = withWorkflowAccess(
  contracts.projectSanitizedDocumentationMaturityWorkUnit,
);
export const migrateDocumentationMaturityFinding = withWorkflowAccess(
  contracts.migrateDocumentationMaturityFinding,
);
export const migrateDocumentationMaturityWorkUnit = withWorkflowAccess(
  contracts.migrateDocumentationMaturityWorkUnit,
);
