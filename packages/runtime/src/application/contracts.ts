// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ExecutionServices, RunRequest } from "../execution/contracts.js";
import type { TaskBudgetOwner } from "../execution/task-budget.js";
import type { TaskScope } from "../execution/task-scope.js";
import type { RunRecord } from "../records/contracts.js";
import type {
  FirstPassDocumentationTargetControl,
  WorkflowRunnerOptions,
} from "../workflow-execution/runner.js";

/** Existing runner services admitted by a host, without a second contract vocabulary. */
export type WorkflowApplicationServices = ExecutionServices &
  Omit<WorkflowRunnerOptions, keyof ExecutionServices>;

/** Internal application call over the runtime's existing request and record contracts. */
export interface ExecuteWorkflowApplicationInput {
  readonly request: RunRequest;
  readonly services: WorkflowApplicationServices;
  readonly firstPassTargetControl?: FirstPassDocumentationTargetControl;
  /** Current host-issued task scope, when the caller has bound one. */
  readonly taskScope?: TaskScope;
  /** Nested remaining-budget owner for this child workflow when bound. */
  readonly childBudget?: TaskBudgetOwner;
}

export type ExecuteWorkflowApplication = (
  input: ExecuteWorkflowApplicationInput,
) => Promise<RunRecord>;
