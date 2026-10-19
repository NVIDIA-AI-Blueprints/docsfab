// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { AUTHORING_QUALITY_OUTCOME_WORKFLOWS } from "./authoring-workflows.js";
import type { WorkflowDefinition } from "./contracts.js";

export interface WorkflowDeliveryCapabilities {
  /** The shared run adapter can retain a patch for any workflow with a write step. */
  readonly patchOnly: boolean;
  /** Draft-MR delivery is wired only for the authoring outcome workflows. */
  readonly draftMr: boolean;
  /** Patch-only delivery does not replace an explicit grant on non-authoring writers. */
  readonly requiresExplicitWriteGrant: boolean;
}

/** Derive local delivery capabilities from the workflow contract and adapters. */
export function workflowDeliveryCapabilities(
  workflow: WorkflowDefinition,
): WorkflowDeliveryCapabilities {
  const patchOnly = workflow.steps.some((step) => step.mode === "write");
  const draftMr =
    patchOnly && (AUTHORING_QUALITY_OUTCOME_WORKFLOWS as readonly string[]).includes(workflow.name);
  return Object.freeze({
    patchOnly,
    draftMr,
    requiresExplicitWriteGrant: patchOnly && !draftMr,
  });
}
