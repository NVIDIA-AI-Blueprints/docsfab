// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Strict admission of the sanitized planner diagnostic on a stopped authoring
 * record: a closed code, the response shape, and the response digest, never
 * planner prose. A leaf so the operator projection and the authoring outcome
 * projector share one rule without an import cycle.
 */

import type { RunRecord } from "../records/contracts.js";
import { AUTHORING_QUALITY_OUTCOME_WORKFLOWS } from "./authoring-workflows.js";

/** The needs-input reasons a planner model may state. */
const PLANNER_MODEL_NEEDS_INPUT_REASONS = [
  "missing-information",
  "ambiguous-scope",
  "missing-source",
  "unresolved-decision",
  "blocked-dependency",
] as const;

/**
 * Planner stop codes that name a governed input the request lacks: the model's
 * stated reasons, the fallback for any other reason, and the stops plan
 * admission raises itself. A model reason never maps to a host stop code.
 */
export const PLANNER_MISSING_GOVERNED_INPUT_CODES = [
  ...PLANNER_MODEL_NEEDS_INPUT_REASONS,
  "model-reported-needs-input",
  // Host: a CREATE plan targets several pages the revision already holds.
  "ambiguous-create-targets",
] as const;

export type PlannerMissingGovernedInputCodeV1 =
  (typeof PLANNER_MISSING_GOVERNED_INPUT_CODES)[number];

export const PLANNER_RESPONSE_SHAPES = ["json-object", "invalid-json", "json-value"] as const;

export type PlannerResponseShapeV1 = (typeof PLANNER_RESPONSE_SHAPES)[number];

export interface AdmittedPlannerDiagnosticV1 {
  readonly code: string;
  readonly responseShape: PlannerResponseShapeV1;
  readonly responseSha256: string;
}

const PLANNER_AUTHORING_WORKFLOWS: readonly string[] = AUTHORING_QUALITY_OUTCOME_WORKFLOWS;
const PLANNER_DIAGNOSTIC_KEYS = [
  "code",
  "kind",
  "responseSha256",
  "responseShape",
  "schemaVersion",
] as const;
const MISSING_GOVERNED_INPUT_CODE_SET: ReadonlySet<string> = new Set(
  PLANNER_MISSING_GOVERNED_INPUT_CODES,
);
const MODEL_NEEDS_INPUT_REASON_SET: ReadonlySet<string> = new Set(
  PLANNER_MODEL_NEEDS_INPUT_REASONS,
);
const RESPONSE_SHAPE_SET: ReadonlySet<string> = new Set(PLANNER_RESPONSE_SHAPES);
const SHA256 = /^[a-f0-9]{64}$/u;

export function isPlannerMissingGovernedInputCode(
  code: string,
): code is PlannerMissingGovernedInputCodeV1 {
  return MISSING_GOVERNED_INPUT_CODE_SET.has(code);
}

/**
 * The closed code for a planner's stated needs-input reason. A reason outside
 * the closed set reads as `model-reported-needs-input`, never as model text.
 */
export function plannerNeedsInputReasonCode(reason: string): PlannerMissingGovernedInputCodeV1 {
  return MODEL_NEEDS_INPUT_REASON_SET.has(reason)
    ? (reason as PlannerMissingGovernedInputCodeV1)
    : "model-reported-needs-input";
}

export function isPlannerResponseShape(value: unknown): value is PlannerResponseShapeV1 {
  return typeof value === "string" && RESPONSE_SHAPE_SET.has(value);
}

/**
 * The one planner diagnostic on a `failed` or `needs-input` authoring record,
 * or `undefined`. Only a read-only `plan-documentation` evaluate step that
 * stopped `needs-input` after a succeeded inference attempt can carry it, and
 * the envelope must be exactly the sanitized shape.
 */
export function admitPlannerDiagnostic(
  record: Readonly<RunRecord>,
): AdmittedPlannerDiagnosticV1 | undefined {
  if (
    !PLANNER_AUTHORING_WORKFLOWS.includes(record.workflow) ||
    !["failed", "needs-input"].includes(record.status)
  ) {
    return undefined;
  }
  if (!Array.isArray(record.steps)) return undefined;
  const steps: Record<string, unknown>[] = [];
  for (const step of record.steps as unknown[]) {
    if (!step || typeof step !== "object" || Array.isArray(step)) return undefined;
    steps.push(step as Record<string, unknown>);
  }
  const candidates = steps.filter((step) => step.planDiagnostic !== undefined);
  if (candidates.length !== 1) return undefined;
  const step = candidates[0]!;
  const diagnostic: unknown = step.planDiagnostic;
  if (
    step.id !== "plan-documentation" ||
    step.skill !== "plan-documentation" ||
    step.kind !== "evaluate" ||
    step.mode !== "read-only" ||
    step.status !== "needs-input" ||
    !hasSucceededInferenceAttempt(step.inference) ||
    !diagnostic ||
    typeof diagnostic !== "object" ||
    Array.isArray(diagnostic) ||
    Object.keys(diagnostic).sort().join("\0") !== [...PLANNER_DIAGNOSTIC_KEYS].sort().join("\0")
  ) {
    return undefined;
  }
  const value = diagnostic as Record<string, unknown>;
  if (
    value.schemaVersion !== 1 ||
    value.kind !== "docsfab-documentation-plan-diagnostic" ||
    typeof value.code !== "string" ||
    typeof value.responseSha256 !== "string" ||
    !SHA256.test(value.responseSha256) ||
    !isPlannerResponseShape(value.responseShape)
  ) {
    return undefined;
  }
  return Object.freeze({
    code: value.code,
    responseShape: value.responseShape,
    responseSha256: value.responseSha256,
  });
}

function hasSucceededInferenceAttempt(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const attempts = (value as Record<string, unknown>).attempts;
  if (!Array.isArray(attempts) || attempts.length === 0) return false;
  const terminal = attempts.at(-1);
  return (
    Boolean(terminal) &&
    typeof terminal === "object" &&
    !Array.isArray(terminal) &&
    (terminal as Record<string, unknown>).outcome === "succeeded"
  );
}
