// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The closed vocabulary of governed workflow search stops (#1927), kept free
 * of runtime imports so the failure tables and `docsfab why` can read it
 * without loading the runner.
 */

/**
 * Governed workflow search phases, in order: snapshot the catalog's search
 * plan, run the coordinator over the repository, admit its evidence, and, for
 * release readiness, validate the batch authority.
 */
export const WORKFLOW_SEARCH_PHASES = [
  "plan",
  "coordinator",
  "evidence",
  "release-authority",
] as const;

export type WorkflowSearchPhase = (typeof WORKFLOW_SEARCH_PHASES)[number];

/** The catalogued stop for a phase whose error no failure table names. */
export type WorkflowSearchFailureCode = `workflow-search-${WorkflowSearchPhase}-failed`;

/** A trusted search contract rejected evidence inside the host search boundary. */
export const WORKFLOW_SEARCH_CONTRACT_FAILURE_CODE = "workflow-search-contract-failed" as const;

export function workflowSearchFailureCode(phase: WorkflowSearchPhase): WorkflowSearchFailureCode {
  return `workflow-search-${phase}-failed`;
}

export const WORKFLOW_SEARCH_FAILURE_CODES: readonly WorkflowSearchFailureCode[] = Object.freeze(
  WORKFLOW_SEARCH_PHASES.map((phase) => workflowSearchFailureCode(phase)),
);

/** The phase a governed search stop code names, or `undefined` for any other code. */
export function workflowSearchPhaseOfCode(code: unknown): WorkflowSearchPhase | undefined {
  return WORKFLOW_SEARCH_PHASES.find((phase) => code === workflowSearchFailureCode(phase));
}
