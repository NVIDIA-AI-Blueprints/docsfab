// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The coded plan-scope stop of an authoring writer: the host refused at least
 * one edit/write call outside the approved documentation plan, so the step
 * stopped `needs-input` for a new plan. One leaf owns the recorded shape, its
 * producer, and its strict admission, so the step loop that writes it, the
 * authoring outcome projector and CREATE record validation that seal it, and
 * the operator surfaces that present it share one rule. Reads no model text.
 */

import type { RunRecord } from "../records/contracts.js";
import { AUTHORING_QUALITY_OUTCOME_WORKFLOWS } from "./authoring-workflows.js";

export const PLAN_SCOPE_STOP_KIND = "docsfab-documentation-plan-scope-stop";

/** Closed stop codes. Each names the governed input the stop asks for. */
export const PLAN_SCOPE_STOP_CODES = ["writer-mutation-outside-plan"] as const;

export type PlanScopeStopCodeV1 = (typeof PLAN_SCOPE_STOP_CODES)[number];

export interface DocumentationPlanScopeStopV1 {
  readonly schemaVersion: 1;
  readonly kind: typeof PLAN_SCOPE_STOP_KIND;
  readonly code: PlanScopeStopCodeV1;
  /** Edit/write calls the confined mutation boundary refused in the stopping attempt. */
  readonly refusedMutations: number;
}

export interface AdmittedPlanScopeStopV1 {
  readonly stepId: string;
  readonly code: PlanScopeStopCodeV1;
  readonly refusedMutations: number;
}

/** The governed input a plan-scope stop asks for, in the planner's `documentation-plan:` namespace. */
export function planScopeStopInputId(code: PlanScopeStopCodeV1): string {
  return `documentation-plan:${code}`;
}

/** Operator NEXT reason for an admitted stop; names the code, never a path or model text. */
export function planScopeStopNextReason(stop: AdmittedPlanScopeStopV1): string {
  return (
    `The writer asked to change a path outside the approved documentation plan ` +
    `(${stop.code}; ${stop.refusedMutations} refused edit/write call(s)), and DocsFab refused it before any change. ` +
    "Run this template against the original target checkout after amending the instruction so the plan " +
    "includes every path the change needs, or narrow the request so it no longer needs that path."
  );
}

const AUTHORING_WORKFLOWS: readonly string[] = AUTHORING_QUALITY_OUTCOME_WORKFLOWS;
const STOP_KEYS = ["code", "kind", "refusedMutations", "schemaVersion"] as const;
const CODE_SET: ReadonlySet<string> = new Set(PLAN_SCOPE_STOP_CODES);

/**
 * The step field the step loop records when a planned write step had refused
 * mutations. `refusedMutations` must be a positive integer.
 */
export function createPlanScopeStop(refusedMutations: number): DocumentationPlanScopeStopV1 {
  if (!Number.isSafeInteger(refusedMutations) || refusedMutations < 1) {
    throw new Error("A plan-scope stop requires at least one refused mutation."); // hygiene: ok -- host invariant, never model input
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: PLAN_SCOPE_STOP_KIND,
    code: "writer-mutation-outside-plan",
    refusedMutations,
  });
}

/**
 * The one admitted plan-scope stop on a `needs-input` or `failed` authoring
 * record, or `undefined`. Exactly one step carries the field, and it must be
 * the only `needs-input` step: a write inference step bound to the planner's
 * exact plan digest whose last inference attempt succeeded. The recorded tool
 * evidence must account for every refused mutation: at least that many
 * `denied-path` failures and failed edit/write calls on the same step.
 */
export function admitPlanScopeStop(
  record: Readonly<RunRecord>,
): AdmittedPlanScopeStopV1 | undefined {
  if (
    !AUTHORING_WORKFLOWS.includes(record.workflow) ||
    !["failed", "needs-input"].includes(record.status) ||
    !Array.isArray(record.steps)
  ) {
    return undefined;
  }
  const steps: Record<string, unknown>[] = [];
  for (const step of record.steps as unknown[]) {
    if (!isObject(step)) return undefined;
    steps.push(step);
  }
  const holders = steps.filter((step) => step.planScopeStop !== undefined);
  if (holders.length !== 1) return undefined;
  const step = holders[0]!;
  const stopped = steps.filter((candidate) => candidate.status === "needs-input");
  if (stopped.length !== 1 || stopped[0] !== step) return undefined;
  const stop = step.planScopeStop;
  if (
    typeof step.id !== "string" ||
    step.kind !== "inference" ||
    step.mode !== "write" ||
    !isObject(stop) ||
    Object.keys(stop).sort().join("\0") !== [...STOP_KEYS].join("\0") ||
    stop.schemaVersion !== 1 ||
    stop.kind !== PLAN_SCOPE_STOP_KIND ||
    typeof stop.code !== "string" ||
    !CODE_SET.has(stop.code) ||
    !Number.isSafeInteger(stop.refusedMutations) ||
    (stop.refusedMutations as number) < 1 ||
    !lastAttemptSucceeded(step.inference)
  ) {
    return undefined;
  }
  const refusedMutations = stop.refusedMutations as number;
  const planner = steps.find((candidate) => candidate.id === "plan-documentation");
  const plannerDigest = planDigest(planner?.planBinding);
  if (
    planner?.status !== "succeeded" ||
    plannerDigest === undefined ||
    planDigest(step.planBinding) !== plannerDigest
  ) {
    return undefined;
  }
  if (!toolEvidenceAccountsFor(step.tools, refusedMutations)) return undefined;
  return Object.freeze({
    stepId: step.id,
    code: stop.code as PlanScopeStopCodeV1,
    refusedMutations,
  });
}

function toolEvidenceAccountsFor(value: unknown, refusedMutations: number): boolean {
  if (!isObject(value)) return false;
  const categories = Array.isArray(value.failureCategories) ? value.failureCategories : [];
  const denied = categories.find(
    (entry: unknown) => isObject(entry) && entry.category === "denied-path",
  ) as Record<string, unknown> | undefined;
  if (!denied || typeof denied.count !== "number" || denied.count < refusedMutations) return false;
  const byTool = Array.isArray(value.byTool) ? value.byTool : [];
  let failedMutations = 0;
  for (const entry of byTool as unknown[]) {
    if (!isObject(entry) || (entry.name !== "edit" && entry.name !== "write")) continue;
    if (typeof entry.failures !== "number") return false;
    failedMutations += entry.failures;
  }
  return failedMutations >= refusedMutations;
}

function planDigest(value: unknown): string | undefined {
  return isObject(value) && typeof value.digest === "string" && /^[a-f0-9]{64}$/u.test(value.digest)
    ? value.digest
    : undefined;
}

function lastAttemptSucceeded(value: unknown): boolean {
  if (!isObject(value) || !Array.isArray(value.attempts) || value.attempts.length === 0) {
    return false;
  }
  const terminal: unknown = value.attempts.at(-1);
  return isObject(terminal) && terminal.outcome === "succeeded";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
