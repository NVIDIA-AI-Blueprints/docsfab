// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { roadmapCanonicalJson, roadmapDigest } from "./contracts/decode.js";
import { validateRoadmapLedger, type RoadmapLedger } from "./contracts/ledger.js";
import {
  validateRoadmapMutationAuthorizationV2,
  validateRoadmapMutationPlanV2,
  validateRoadmapMutationReceiptV2,
  type RoadmapMutationAuthorizationV2,
  type RoadmapMutationPlanV2,
  type RoadmapMutationReceiptV2,
} from "./execution-v2.js";
import {
  createManagedIssueIdentity,
  createManagedIssueStateBinding,
  type ManagedIssueIdentityV1,
  type ManagedIssueStateBindingV1,
} from "./managed-issue.js";
import { internalIssueLifecycleExecutionReceiptState } from "./issue-lifecycle-authority-internal.js";

/**
 * Host-held evidence that a managed issue reached a revision-bound state.
 * This record is useful for persistence, but is authoritative only after it
 * has been restored against the exact validated plan, authorization, and
 * receipt that produced it.
 */
export interface ManagedIssueStateAdvanceV1 {
  kind: "docsfab-managed-issue-state-advance";
  schemaVersion: 1;
  projectDigest: string;
  ledgerDigest: string;
  planDigest: string;
  authorizationDigest: string;
  operatorAuthorityId: string;
  operatorIdentityDigest: string;
  receiptDigest: string;
  operationKey: string;
  issueIid: number;
  effectIdentityDigest: string;
  recordedAt: string;
  stateBinding: ManagedIssueStateBindingV1;
  digest: string;
}

export interface ManagedIssueStateAdvanceContextV1 {
  ledger: RoadmapLedger;
  plan: RoadmapMutationPlanV2;
  authorization: RoadmapMutationAuthorizationV2;
  receipt: RoadmapMutationReceiptV2;
  operationKey: string;
  identity: ManagedIssueIdentityV1;
}

export class ManagedIssueStateError extends Error {
  public constructor(
    public readonly code: "invalid-evidence" | "operation-not-confirmed" | "issue-mismatch",
  ) {
    super(`Managed issue state advance failed: ${code}.`);
    this.name = "ManagedIssueStateError";
  }
}

interface AuthenticAdvanceState {
  issueIid: number;
  recordedAt: string;
  binding: ManagedIssueStateBindingV1;
}

interface AuthenticLookupState {
  bindings: ReadonlyMap<number, ManagedIssueStateBindingV1>;
}

const authenticAdvances = new WeakMap<object, AuthenticAdvanceState>();
const authenticLookups = new WeakMap<object, AuthenticLookupState>();

/** Opaque host-owned lookup consumed by the managed tracker observer. */
export interface ManagedIssueStateLookupV1 {
  readonly kind: "docsfab-managed-issue-state-lookup";
}

export function recordManagedIssueStateAdvanceV1(
  context: ManagedIssueStateAdvanceContextV1,
): ManagedIssueStateAdvanceV1 {
  const ledger = validateRoadmapLedger(context.ledger);
  const plan = validateRoadmapMutationPlanV2(context.plan, ledger);
  const authorization = validateRoadmapMutationAuthorizationV2(context.authorization, plan, ledger);
  if (authorization.authority.kind !== "local-user") {
    throw new ManagedIssueStateError("invalid-evidence");
  }
  const receipt = validateRoadmapMutationReceiptV2(context.receipt, ledger, plan, authorization);
  const execution = internalIssueLifecycleExecutionReceiptState(context.receipt);
  if (
    !execution ||
    execution.projectDigest !== roadmapDigest(plan.project) ||
    execution.ledgerDigest !== ledger.digest ||
    execution.planDigest !== plan.digest ||
    execution.authorizationDigest !== authorization.digest ||
    execution.receiptDigest !== receipt.digest ||
    execution.operatorAuthorityId !== authorization.authority.id
  ) {
    throw new ManagedIssueStateError("invalid-evidence");
  }
  const stateBinding = createManagedIssueStateBinding(context.identity);
  const expectedIdentity = createManagedIssueIdentity(ledger, stateBinding.findingId);
  if (roadmapCanonicalJson(expectedIdentity) !== roadmapCanonicalJson(context.identity)) {
    throw new ManagedIssueStateError("invalid-evidence");
  }
  const operation = plan.operations.find((candidate) => candidate.key === context.operationKey);
  if (
    !operation ||
    !authorization.authorizedOperationKeys.includes(operation.key) ||
    !operation.findingIds.includes(stateBinding.findingId)
  ) {
    throw new ManagedIssueStateError("invalid-evidence");
  }
  const effect = execution.confirmedEffects.get(operation.key);
  if (!effect || (effect.kind !== "issue" && effect.kind !== "note")) {
    throw new ManagedIssueStateError("operation-not-confirmed");
  }
  const issueIid =
    effect.kind === "issue"
      ? parseIssueIid(effect.externalId, effect.targetKey)
      : parseIssueTargetKey(effect.subjectTargetKey);
  const body = {
    kind: "docsfab-managed-issue-state-advance" as const,
    schemaVersion: 1 as const,
    projectDigest: roadmapDigest(plan.project),
    ledgerDigest: ledger.digest,
    planDigest: plan.digest,
    authorizationDigest: authorization.digest,
    operatorAuthorityId: execution.operatorAuthorityId,
    operatorIdentityDigest: execution.operatorIdentityDigest,
    receiptDigest: receipt.digest,
    operationKey: operation.key,
    issueIid,
    effectIdentityDigest: effect.identityDigest,
    recordedAt: receipt.updatedAt,
    stateBinding,
  };
  const advance = freeze({ ...body, digest: roadmapDigest(body) });
  authenticAdvances.set(advance, {
    issueIid,
    recordedAt: receipt.updatedAt,
    binding: stateBinding,
  });
  return advance;
}

/** Re-authenticate a persisted advance; a copied or merely rehashed record is inert. */
export function restoreManagedIssueStateAdvanceV1(
  value: unknown,
  context: ManagedIssueStateAdvanceContextV1,
): ManagedIssueStateAdvanceV1 {
  const expected = recordManagedIssueStateAdvanceV1(context);
  if (
    !value ||
    typeof value !== "object" ||
    roadmapCanonicalJson(value) !== roadmapCanonicalJson(expected)
  ) {
    throw new ManagedIssueStateError("invalid-evidence");
  }
  return expected;
}

export function createManagedIssueStateLookupV1(
  advances: readonly ManagedIssueStateAdvanceV1[],
): ManagedIssueStateLookupV1 {
  const bindings = new Map<number, ManagedIssueStateBindingV1>();
  const latest = new Map<number, AuthenticAdvanceState>();
  for (const advance of advances) {
    const state =
      advance && typeof advance === "object" ? authenticAdvances.get(advance) : undefined;
    if (!state) throw new ManagedIssueStateError("invalid-evidence");
    const prior = latest.get(state.issueIid);
    if (
      prior &&
      prior.recordedAt === state.recordedAt &&
      prior.binding.digest !== state.binding.digest
    ) {
      throw new ManagedIssueStateError("issue-mismatch");
    }
    if (!prior || prior.recordedAt < state.recordedAt) latest.set(state.issueIid, state);
  }
  for (const state of latest.values()) bindings.set(state.issueIid, state.binding);
  const lookup = freeze({ kind: "docsfab-managed-issue-state-lookup" as const });
  authenticLookups.set(lookup, { bindings });
  return lookup;
}

/** @internal State is available only from an authentic host-owned lookup. */
export function managedIssueStateBindingFromLookup(
  lookup: ManagedIssueStateLookupV1,
  issueIid: number,
): ManagedIssueStateBindingV1 | undefined {
  const state = lookup && typeof lookup === "object" ? authenticLookups.get(lookup) : undefined;
  if (!state) throw new ManagedIssueStateError("invalid-evidence");
  return state.bindings.get(issueIid);
}

function parseIssueIid(externalId: string, targetKey: string): number {
  const issueIid = Number(externalId);
  if (!Number.isSafeInteger(issueIid) || issueIid <= 0 || targetKey !== `issue:${issueIid}`) {
    throw new ManagedIssueStateError("issue-mismatch");
  }
  return issueIid;
}

function parseIssueTargetKey(targetKey: string): number {
  const match = /^issue:([1-9][0-9]*)$/u.exec(targetKey);
  if (!match) throw new ManagedIssueStateError("issue-mismatch");
  const issueIid = Number(match[1]);
  if (!Number.isSafeInteger(issueIid)) throw new ManagedIssueStateError("issue-mismatch");
  return issueIid;
}

function freeze<T extends object>(value: T): T {
  return Object.freeze(value);
}
