// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The inner reason a workflow product outcome was refused.
 *
 * `applyWorkflowOutcome` runs three producers after every step succeeded:
 * release-readiness projection, the outcome projector, and outcome admission
 * (`createWorkflowOutcome`). This module reduces a thrown error to a closed
 * `{code, location}` so the record names the producer and rule:
 *
 * - `code` is `workflow-outcome-<phase>-<producer code>`, read from the
 *   producer's closed error code, or `workflow-outcome-<phase>-uncoded-error`.
 *   Never from message text.
 * - `location` is the `$`-rooted outcome-candidate member the admission rule
 *   read, such as `$.findings[].code`. A projection-phase refusal records the
 *   run-record member its projector names, such as `$.status`; otherwise, and
 *   always for release readiness, `$`. Array members are `[]`, never an index.
 *
 * Nothing here copies error, model, or validator text.
 */

import { INFERENCE_REJECTION_LOCATION_GRAMMAR } from "../config/inference-rejection-limits.js";
import { ReleaseDocumentationReadinessError } from "../release-documentation-readiness.js";
import {
  WORKFLOW_OUTCOME_ERROR_CODES,
  WORKFLOW_OUTCOME_ROOT_LOCATION,
  WorkflowOutcomeError,
  type WorkflowOutcomeErrorCode,
} from "../workflow-contracts/outcome.js";

/** Pipeline order. */
export const WORKFLOW_OUTCOME_PHASES = ["release-readiness", "projection", "admission"] as const;

export type WorkflowOutcomePhase = (typeof WORKFLOW_OUTCOME_PHASES)[number];

/** Every shipped projector uses exactly these codes; the drift test holds each to this list. */
export const WORKFLOW_OUTCOME_PROJECTOR_ERROR_CODES = [
  "invalid-workflow",
  "invalid-record",
] as const;

export type WorkflowOutcomeProjectorErrorCode =
  (typeof WORKFLOW_OUTCOME_PROJECTOR_ERROR_CODES)[number];

type ReleaseReadinessErrorCode = ReleaseDocumentationReadinessError["code"];

/** `ReleaseDocumentationReadinessError`'s closed codes, held exhaustive below. */
const RELEASE_DOCUMENTATION_READINESS_ERROR_CODES = [
  "invalid-authority",
  "invalid-artifact",
  "execution-incomplete",
] as const satisfies readonly ReleaseReadinessErrorCode[];
// A code added to the error class does not typecheck until it is listed.
const releaseReadinessCodesExhaustive: Exclude<
  ReleaseReadinessErrorCode,
  (typeof RELEASE_DOCUMENTATION_READINESS_ERROR_CODES)[number]
> extends never
  ? true
  : false = true;
void releaseReadinessCodesExhaustive;

const UNCODED = "uncoded-error";

export type WorkflowOutcomeRejectionCode =
  | `workflow-outcome-release-readiness-${ReleaseReadinessErrorCode | typeof UNCODED}`
  | `workflow-outcome-projection-${
      | WorkflowOutcomeProjectorErrorCode
      | WorkflowOutcomeErrorCode
      | typeof UNCODED}`
  | `workflow-outcome-admission-${WorkflowOutcomeErrorCode | typeof UNCODED}`;

/** Enumerated once so the class table and tests can hold it closed. */
export const WORKFLOW_OUTCOME_REJECTION_CODES: readonly WorkflowOutcomeRejectionCode[] =
  Object.freeze([
    ...prefixed("workflow-outcome-release-readiness-", [
      ...RELEASE_DOCUMENTATION_READINESS_ERROR_CODES,
      UNCODED,
    ]),
    ...prefixed("workflow-outcome-projection-", [
      ...WORKFLOW_OUTCOME_PROJECTOR_ERROR_CODES,
      ...WORKFLOW_OUTCOME_ERROR_CODES,
      UNCODED,
    ]),
    ...prefixed("workflow-outcome-admission-", [...WORKFLOW_OUTCOME_ERROR_CODES, UNCODED]),
  ]);

function prefixed<P extends string, C extends string>(
  prefix: P,
  codes: readonly C[],
): `${P}${C}`[] {
  return codes.map((code) => `${prefix}${code}` as `${P}${C}`);
}

/** Recorded on a failed run beside `failure` (`RunRecord.workflowOutcomeRejection`). */
export interface WorkflowOutcomeRejectionV1 {
  readonly code: WorkflowOutcomeRejectionCode;
  readonly location: string;
}

/**
 * The inner reason for one refusal. Never throws: a diagnostic must not be
 * able to fail the run it describes. A location outside the retained grammar
 * reads as `$`, never as a copied string.
 */
export function workflowOutcomeRejection(
  phase: WorkflowOutcomePhase,
  error: unknown,
): WorkflowOutcomeRejectionV1 {
  const code = producerCode(phase, error);
  return Object.freeze({
    code: `workflow-outcome-${phase}-${code}` as WorkflowOutcomeRejectionCode,
    location: rejectionLocation(phase, code, error),
  });
}

function rejectionLocation(phase: WorkflowOutcomePhase, code: string, error: unknown): string {
  if (phase === "admission") {
    return error instanceof WorkflowOutcomeError &&
      INFERENCE_REJECTION_LOCATION_GRAMMAR.test(error.location)
      ? error.location
      : WORKFLOW_OUTCOME_ROOT_LOCATION;
  }
  // A projector's own closed refusal may name the run-record member its rule
  // read. An outcome-contract error raised inside a projector names a
  // candidate member, not a run-record location, so it reads `$`.
  if (
    phase === "projection" &&
    !(error instanceof WorkflowOutcomeError) &&
    includes(WORKFLOW_OUTCOME_PROJECTOR_ERROR_CODES, code)
  ) {
    const location = (error as { location?: unknown }).location;
    if (typeof location === "string" && INFERENCE_REJECTION_LOCATION_GRAMMAR.test(location)) {
      return location;
    }
  }
  return WORKFLOW_OUTCOME_ROOT_LOCATION;
}

function producerCode(phase: WorkflowOutcomePhase, error: unknown): string {
  if (phase === "release-readiness") {
    return error instanceof ReleaseDocumentationReadinessError &&
      includes(RELEASE_DOCUMENTATION_READINESS_ERROR_CODES, error.code)
      ? error.code
      : UNCODED;
  }
  if (error instanceof WorkflowOutcomeError && includes(WORKFLOW_OUTCOME_ERROR_CODES, error.code)) {
    return error.code;
  }
  if (phase === "projection") {
    // Projectors live behind the `WorkflowOutcomeProjector` port and raise
    // their own error classes; each carries a `code` from the closed list.
    const code = (error as { code?: unknown } | null | undefined)?.code;
    if (error instanceof Error && includes(WORKFLOW_OUTCOME_PROJECTOR_ERROR_CODES, code)) {
      return code;
    }
  }
  return UNCODED;
}

function includes<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

/** Strictly read a recorded inner reason; anything else reads as `null`. */
export function readWorkflowOutcomeRejection(value: unknown): WorkflowOutcomeRejectionV1 | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== "code" || keys[1] !== "location") return null;
  const candidate = value as Record<string, unknown>;
  if (
    !includes(WORKFLOW_OUTCOME_REJECTION_CODES, candidate.code) ||
    typeof candidate.location !== "string" ||
    !INFERENCE_REJECTION_LOCATION_GRAMMAR.test(candidate.location)
  ) {
    return null;
  }
  return Object.freeze({ code: candidate.code, location: candidate.location });
}
