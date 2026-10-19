// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { grantedToolsForStep } from "../harness/pi-tool-confine.js";
import { PRESERVATION_SOURCE_READ_TOOL_NAMES } from "../harness/source-tools.js";
import type { WorkflowName } from "../workflow-contracts/contracts.js";
import { getWorkflow } from "../workflow-registry/catalog.js";

export interface HostedWorkflowCatalogOptions {
  /**
   * True only for a run that opted into stage-specific preservation delivery
   * (`preservationBaseDeliveryForHostWorkflow` returned `"stage-specific"`).
   * Default off: the sealed `declaredTools` of an installed policy omit
   * `docsfab_read_preservation_source`, so declaring it unconditionally would
   * make every installed `restructure-documentation` policy fail this check.
   */
  preservationSourceRead?: boolean;
}

/** Canonical installed definitions only; no provider, workspace or credential access. */
export function inspectHostedWorkflowCatalog(
  name: WorkflowName,
  options: HostedWorkflowCatalogOptions = {},
): {
  workflow: WorkflowName;
  stepIds: string[];
  writeStepIds: string[];
  declaredTools: string[];
} {
  const workflow = getWorkflow(name);
  if (!workflow)
    throw new Error("The hosted runtime workflow is not installed in the exact release.");
  return {
    workflow: name,
    stepIds: workflow.steps.map((step) => step.id),
    writeStepIds: workflow.steps.filter((step) => step.mode === "write").map((step) => step.id),
    // An `invokes` step runs its child pipeline in process, so the outer tool
    // ceiling must cover the child's tools. The manifest parser admits only
    // `create-documentation` as a child, which invokes nothing, so depth is one.
    declaredTools: [
      ...new Set(
        workflow.steps.flatMap((step) => [
          ...grantedToolsForStep(workflow, step, false),
          ...(options.preservationSourceRead === true &&
          workflow.name === "restructure-documentation" &&
          step.id === "test-audience-understanding"
            ? PRESERVATION_SOURCE_READ_TOOL_NAMES
            : []),
          ...(step.invokes ? inspectHostedWorkflowCatalog(step.invokes).declaredTools : []),
        ]),
      ),
    ].sort(),
  };
}

/** The same strict catalog boundary used by execution and operator preflight. */
export function assertHostedWorkflowCatalog(
  input: {
    workflow: WorkflowName;
    stepIds: readonly string[];
    composition: { declaredTools: readonly string[] };
  },
  options: HostedWorkflowCatalogOptions = {},
): void {
  const installed = inspectHostedWorkflowCatalog(input.workflow, options);
  if (JSON.stringify(installed.stepIds) !== JSON.stringify(input.stepIds))
    throw new Error("The hosted runtime step catalog differs from the exact host request.");
  if (JSON.stringify(installed.declaredTools) !== JSON.stringify(input.composition.declaredTools))
    throw new Error(
      "The installed composition tool set differs from the selected workflow declaration.",
    );
}
