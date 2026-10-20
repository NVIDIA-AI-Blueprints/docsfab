// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { assertTaskBudgetActive } from "../execution/task-budget.js";
import { assertTaskScopeActive } from "../execution/task-scope.js";
import type { RunRecord } from "../records/contracts.js";
import { WorkflowRunner } from "../workflow-execution/runner.js";
import type { ExecuteWorkflowApplicationInput } from "./contracts.js";

/** Execute one already-admitted workflow through the runtime's sole scheduler. */
export async function executeWorkflowApplication(
  input: ExecuteWorkflowApplicationInput,
): Promise<RunRecord> {
  if (input.taskScope) assertTaskScopeActive(input.taskScope, input.request.signal);
  if (input.childBudget) assertTaskBudgetActive(input.childBudget, input.request.signal);
  return new WorkflowRunner(input.services).run(input.request, input.firstPassTargetControl);
}
