// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Fixed diagnostic: never persist an arbitrary AbortSignal.reason. */
export const WORKFLOW_CANCELLED = "Workflow cancelled by user.";

export class WorkflowCancelledError extends Error {
  public readonly code = "workflow-cancelled";

  public constructor(options?: ErrorOptions) {
    super(WORKFLOW_CANCELLED, options);
    this.name = "WorkflowCancelledError";
  }
}

export function assertWorkflowActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new WorkflowCancelledError();
}
