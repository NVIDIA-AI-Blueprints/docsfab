// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Nested remaining-budget owner for shared execution.
 *
 * Children reserve from the parent remaining budget. Physical effects settle
 * once on the owner that executed them; duplicate events cannot charge the
 * parent and the child. Unused reservation returns only after proven
 * settlement or a did-not-start child. This is process-local host state, not
 * a second budget chain or lifecycle store.
 */
import {
  createContractKit,
  createHostAuthorityFactory,
  createReceiptReplayGuard,
  deepFreeze,
} from "../contract-kit/index.js";
import { assertWorkflowActive } from "./cancellation.js";

export const TASK_BUDGET_KIND = "docsfab-task-budget-owner" as const;

export const TASK_BUDGET_DIMENSIONS = [
  "provider-turns",
  "tool-calls",
  "input-tokens",
  "output-tokens",
  "source-bytes",
  "elapsed-ms",
  "cost-microusd",
] as const;
export type TaskBudgetDimension = (typeof TASK_BUDGET_DIMENSIONS)[number];
export type TaskBudgetEnvelope = Readonly<Record<TaskBudgetDimension, number>>;

export const SOURCE_READ_ROLES = ["parent-observer", "writer", "verifier"] as const;
export type SourceReadRole = (typeof SOURCE_READ_ROLES)[number];

export type TaskBudgetErrorCode =
  | "invalid-shape"
  | "invalid-value"
  | "cancelled"
  | "budget-exhausted"
  | "effect-already-settled"
  | "reservation-release-unproven"
  | "parent-read-is-not-writer-charge"
  | "source-reference-cannot-widen";

const ERROR_MESSAGES: Readonly<Record<TaskBudgetErrorCode, string>> = {
  "invalid-shape": "Task budget rejected an unauthenticated or malformed host identity.",
  "invalid-value": "Task budget rejected a non-integer, negative, or incomplete envelope.",
  cancelled: "Task budget refused work after cancellation.",
  "budget-exhausted": "Task budget refused a charge or reservation past remaining capacity.",
  "effect-already-settled":
    "Task budget refused a duplicate physical effect; settlement already occurred once.",
  "reservation-release-unproven":
    "Task budget refused to return an unused reservation before proven settlement.",
  "parent-read-is-not-writer-charge":
    "Task budget refused to count a parent observer read as a writer or verifier read.",
  "source-reference-cannot-widen":
    "Task budget refused an optional source reference that would raise remaining capacity.",
};

export class TaskBudgetError extends Error {
  public readonly code: TaskBudgetErrorCode;
  public readonly dimension?: TaskBudgetDimension;
  public readonly remaining?: number;
  public readonly observed?: number;

  public constructor(
    code: TaskBudgetErrorCode,
    options: {
      message?: string;
      dimension?: TaskBudgetDimension;
      remaining?: number;
      observed?: number;
    } = {},
  ) {
    super(options.message ?? ERROR_MESSAGES[code]);
    this.name = "TaskBudgetError";
    this.code = code;
    this.dimension = options.dimension;
    this.remaining = options.remaining;
    this.observed = options.observed;
  }
}

function fail(
  code: TaskBudgetErrorCode,
  options: ConstructorParameters<typeof TaskBudgetError>[1] = {},
): never {
  throw new TaskBudgetError(code, options);
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;

function scopedId(value: unknown): string {
  const result = kit.string(value);
  if (!SAFE_ID.test(result)) fail("invalid-value");
  return result;
}

const kit = createContractKit<TaskBudgetErrorCode>({
  fail: (code) => fail(code),
  inertMode: "strict",
  codes: {
    invalidShape: "invalid-shape",
    invalidValue: "invalid-value",
    digestMismatch: "invalid-value",
    credentialMaterial: "invalid-value",
    schemaMismatch: "invalid-value",
  },
});

export type TaskBudgetOwner = {
  readonly kind: typeof TASK_BUDGET_KIND;
};

interface BudgetTree {
  settledEffects: ReturnType<typeof createReceiptReplayGuard<TaskBudgetErrorCode>>;
  effectRoles: Map<string, SourceReadRole | "physical">;
}

interface TaskBudgetState {
  verifyCurrent(): boolean;
  envelope: TaskBudgetEnvelope;
  reserved: TaskBudgetEnvelope;
  settled: TaskBudgetEnvelope;
  inFlight: number;
  released: boolean;
  parent?: TaskBudgetOwner;
  tree: BudgetTree;
  signal?: AbortSignal;
}

const budgetAuthority = createHostAuthorityFactory<"docsfab-task-budget-owner", TaskBudgetState>({
  kind: "docsfab-task-budget-owner",
  invalidMessage: "A task budget owner requires a host verifier.",
});

function requireState(owner: TaskBudgetOwner): TaskBudgetState {
  const state = budgetAuthority.lookup(owner);
  if (!state) fail("invalid-shape");
  return state;
}

function quantity(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    Object.is(value, -0)
  ) {
    fail("invalid-value");
  }
  return value;
}

function decodeEnvelope(value: unknown): TaskBudgetEnvelope {
  const record = kit.object(value);
  kit.exact(record, TASK_BUDGET_DIMENSIONS);
  const envelope = {} as Record<TaskBudgetDimension, number>;
  for (const dimension of TASK_BUDGET_DIMENSIONS) {
    envelope[dimension] = quantity(record[dimension]);
  }
  return deepFreeze(envelope);
}

function zeroEnvelope(): TaskBudgetEnvelope {
  const envelope = {} as Record<TaskBudgetDimension, number>;
  for (const dimension of TASK_BUDGET_DIMENSIONS) envelope[dimension] = 0;
  return deepFreeze(envelope);
}

function remainingOf(state: TaskBudgetState): TaskBudgetEnvelope {
  const envelope = {} as Record<TaskBudgetDimension, number>;
  for (const dimension of TASK_BUDGET_DIMENSIONS) {
    const remaining =
      state.envelope[dimension] - state.reserved[dimension] - state.settled[dimension];
    if (remaining < 0) fail("invalid-value");
    envelope[dimension] = remaining;
  }
  return deepFreeze(envelope);
}

function addEnvelope(left: TaskBudgetEnvelope, right: TaskBudgetEnvelope): TaskBudgetEnvelope {
  const envelope = {} as Record<TaskBudgetDimension, number>;
  for (const dimension of TASK_BUDGET_DIMENSIONS) {
    const total = left[dimension] + right[dimension];
    if (!Number.isSafeInteger(total) || total < 0) fail("invalid-value");
    envelope[dimension] = total;
  }
  return deepFreeze(envelope);
}

function subtractEnvelope(left: TaskBudgetEnvelope, right: TaskBudgetEnvelope): TaskBudgetEnvelope {
  const envelope = {} as Record<TaskBudgetDimension, number>;
  for (const dimension of TASK_BUDGET_DIMENSIONS) {
    const total = left[dimension] - right[dimension];
    if (!Number.isSafeInteger(total) || total < 0) fail("invalid-value");
    envelope[dimension] = total;
  }
  return deepFreeze(envelope);
}

function hasPositiveCharge(charges: TaskBudgetEnvelope): boolean {
  return TASK_BUDGET_DIMENSIONS.some((dimension) => charges[dimension] > 0);
}

function assertFitsRemaining(remaining: TaskBudgetEnvelope, charges: TaskBudgetEnvelope): void {
  for (const dimension of TASK_BUDGET_DIMENSIONS) {
    if (charges[dimension] > remaining[dimension]) {
      fail("budget-exhausted", {
        dimension,
        remaining: remaining[dimension],
        observed: charges[dimension],
        message: `Task budget exhausted (${dimension}): remaining ${remaining[dimension]}, observed ${charges[dimension]}.`,
      });
    }
  }
}

export interface CreateTaskBudgetInput {
  readonly envelope: TaskBudgetEnvelope;
  readonly signal?: AbortSignal;
}

export function createRootTaskBudget(input: CreateTaskBudgetInput): TaskBudgetOwner {
  const envelope = decodeEnvelope(input.envelope);
  const tree: BudgetTree = {
    settledEffects: createReceiptReplayGuard(fail, "effect-already-settled"),
    effectRoles: new Map(),
  };
  return budgetAuthority.create({
    verifyCurrent: () => !input.signal?.aborted,
    envelope,
    reserved: zeroEnvelope(),
    settled: zeroEnvelope(),
    inFlight: 0,
    released: false,
    tree,
    signal: input.signal,
  }) as TaskBudgetOwner;
}

export function reserveChildBudget(
  parent: TaskBudgetOwner,
  reservation: TaskBudgetEnvelope,
  signal?: AbortSignal,
): TaskBudgetOwner {
  const parentState = requireState(parent);
  if (parentState.released) fail("invalid-value");
  assertTaskBudgetActive(parent, signal ?? parentState.signal);
  const childEnvelope = decodeEnvelope(reservation);
  if (!hasPositiveCharge(childEnvelope)) fail("invalid-value");
  assertFitsRemaining(remainingOf(parentState), childEnvelope);
  parentState.reserved = addEnvelope(parentState.reserved, childEnvelope);
  return budgetAuthority.create({
    verifyCurrent: () => parentState.verifyCurrent() && !signal?.aborted,
    envelope: childEnvelope,
    reserved: zeroEnvelope(),
    settled: zeroEnvelope(),
    inFlight: 0,
    released: false,
    parent,
    tree: parentState.tree,
    signal: signal ?? parentState.signal,
  }) as TaskBudgetOwner;
}

export function projectTaskBudget(owner: TaskBudgetOwner): {
  readonly availability: "available";
  readonly remaining: TaskBudgetEnvelope;
  readonly reservedOutstanding: TaskBudgetEnvelope;
  readonly settled: TaskBudgetEnvelope;
} {
  const state = requireState(owner);
  return deepFreeze({
    availability: "available" as const,
    remaining: remainingOf(state),
    reservedOutstanding: state.reserved,
    settled: state.settled,
  });
}

export function remainingTaskBudget(owner: TaskBudgetOwner): TaskBudgetEnvelope {
  return remainingOf(requireState(owner));
}

export function assertTaskBudgetActive(owner: TaskBudgetOwner, signal?: AbortSignal): void {
  const state = requireState(owner);
  const activeSignal = signal ?? state.signal;
  if (activeSignal?.aborted || !state.verifyCurrent()) fail("cancelled");
  try {
    assertWorkflowActive(activeSignal);
  } catch {
    fail("cancelled");
  }
}

export function beginBudgetedEffect(owner: TaskBudgetOwner): void {
  const state = requireState(owner);
  if (state.released) fail("invalid-value");
  assertTaskBudgetActive(owner);
  state.inFlight += 1;
}

export function endBudgetedEffect(owner: TaskBudgetOwner): void {
  const state = requireState(owner);
  if (state.inFlight < 1) fail("invalid-value");
  state.inFlight -= 1;
}

export interface PhysicalEffectChargeV1 {
  readonly effectId: string;
  readonly charges: TaskBudgetEnvelope;
}

export function settlePhysicalEffect(owner: TaskBudgetOwner, effect: PhysicalEffectChargeV1): void {
  const state = requireState(owner);
  if (state.released) fail("invalid-value");
  assertTaskBudgetActive(owner);
  const effectId = scopedId(effect.effectId);
  const charges = decodeEnvelope(effect.charges);
  if (!hasPositiveCharge(charges)) fail("invalid-value");
  const existingRole = state.tree.effectRoles.get(effectId);
  if (existingRole === "parent-observer") fail("parent-read-is-not-writer-charge");
  assertFitsRemaining(remainingOf(state), charges);
  state.tree.settledEffects.consume(state.tree, effectId);
  state.settled = addEnvelope(state.settled, charges);
  state.tree.effectRoles.set(effectId, "physical");
}

export function settleSourceRead(
  owner: TaskBudgetOwner,
  input: {
    readonly effectId: string;
    readonly bytes: number;
    readonly role: SourceReadRole;
  },
): void {
  const state = requireState(owner);
  if (state.released) fail("invalid-value");
  assertTaskBudgetActive(owner);
  const effectId = scopedId(input.effectId);
  const role = kit.enumeration(input.role, SOURCE_READ_ROLES);
  const bytes = quantity(input.bytes);
  const existingRole = state.tree.effectRoles.get(effectId);
  if (existingRole === "parent-observer" && role !== "parent-observer") {
    fail("parent-read-is-not-writer-charge");
  }
  if (existingRole && existingRole !== role) fail("parent-read-is-not-writer-charge");
  const charges = {
    ...zeroEnvelope(),
    "source-bytes": bytes,
  };
  if (bytes > 0) {
    assertFitsRemaining(remainingOf(state), charges);
    state.tree.settledEffects.consume(state.tree, `${role}:${effectId}`);
    state.settled = addEnvelope(state.settled, charges);
  }
  state.tree.effectRoles.set(effectId, role);
}

export function releaseChildReservation(child: TaskBudgetOwner): void {
  const childState = requireState(child);
  if (!childState.parent) fail("invalid-value");
  if (childState.released) fail("invalid-value");
  const parentState = requireState(childState.parent);
  if (parentState.released) fail("invalid-value");
  if (childState.inFlight !== 0) fail("reservation-release-unproven");
  if (hasPositiveCharge(childState.reserved)) fail("reservation-release-unproven");
  parentState.reserved = subtractEnvelope(parentState.reserved, childState.envelope);
  parentState.settled = addEnvelope(parentState.settled, childState.settled);
  childState.envelope = childState.settled;
  childState.reserved = zeroEnvelope();
  childState.released = true;
}

export function composeSourceReadBudget(
  taskRemainingBytes: number,
  sourceAcquisitionLimitBytes: number,
  options: {
    readonly sourceReferencePresent?: boolean;
    readonly requestedBytes?: number;
  } = {},
): number {
  const taskRemaining = quantity(taskRemainingBytes);
  const sourceLimit = quantity(sourceAcquisitionLimitBytes);
  const composed = Math.min(taskRemaining, sourceLimit);
  if (options.sourceReferencePresent && options.requestedBytes !== undefined) {
    const requested = quantity(options.requestedBytes);
    if (requested > composed) fail("source-reference-cannot-widen");
  }
  return composed;
}
