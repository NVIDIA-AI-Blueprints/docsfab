// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { types as nodeUtilTypes } from "node:util";

import { roadmapCanonicalJson, roadmapDigest } from "../roadmap/contracts/decode.js";
import { validateRoadmapLedger, type RoadmapLedger } from "../roadmap/contracts/ledger.js";
import {
  validateRoadmapMutationAuthorizationV2,
  validateRoadmapMutationPlanV2,
  validateRoadmapMutationReceiptV2,
  type RoadmapMutationAuthorizationV2,
  type RoadmapMutationPlanV2,
  type RoadmapMutationReceiptV2,
} from "../roadmap/execution-v2.js";
import {
  assertMaterialForOperation,
  validateIssueLifecycleMaterialBundle,
  type IssueLifecycleMaterialBundleV1,
} from "../roadmap/issue-adapter.js";
import {
  applyIssueLifecyclePlan,
  type ApplyIssueLifecycleOptions,
  type IssueLifecycleApplicationResult,
} from "../roadmap/issue-lifecycle.js";
import { compareText } from "../shared/primitives.js";

export const AUTO_ROADMAP_SCHEMA_VERSION = 1 as const;
export const AUTO_ROADMAP_MAX_OPERATION_CAP = 25 as const;

export interface AutoRoadmapCycleSourceV1 {
  requestSha256: string;
  assessmentSha256: string;
  decisionSha256: string;
  maturityAssessmentSha256: string;
  maturitySelectionSha256: string;
  trackerObservationSha256: string;
  managedTrackerObservationSha256: string;
  planningArtifactSha256: string;
}

/**
 * Exact, read-only preview consumed by `docsfab auto --dry-run`. It carries no
 * authority: execution still requires a separate v2 local-user authorization.
 */
export interface AutoRoadmapExecutionPlanV1 {
  kind: "docsfab-auto-roadmap-execution-plan";
  schemaVersion: typeof AUTO_ROADMAP_SCHEMA_VERSION;
  readOnly: true;
  authorization: null;
  source: AutoRoadmapCycleSourceV1;
  ledgerDigest: string;
  mutationPlanDigest: string;
  materialBundleDigest: string;
  operationCap: number;
  operationKeys: string[];
  deferredWorkUnitFingerprints: string[];
  digest: string;
}

export interface CreateAutoRoadmapExecutionPlanInputV1 {
  source: AutoRoadmapCycleSourceV1;
  ledger: RoadmapLedger;
  plan: RoadmapMutationPlanV2;
  materials: IssueLifecycleMaterialBundleV1;
  operationCap: number;
  deferredWorkUnitFingerprints: string[];
}

export interface ApplyAutoRoadmapExecutionPlanOptionsV1
  extends Omit<ApplyIssueLifecycleOptions, "persistReceipt"> {
  autoPlan: AutoRoadmapExecutionPlanV1;
  persistReceipt: (receipt: RoadmapMutationReceiptV2) => Promise<void>;
}

export class AutoRoadmapError extends Error {
  public constructor(
    public readonly code:
      | "invalid-plan"
      | "operation-cap-exceeded"
      | "authorization-expansion"
      | "receipt-expansion"
      | "binding-mismatch"
      | "stale-repository"
      | "projection-drift",
  ) {
    super(`Auto roadmap integration failed: ${code}.`);
    this.name = "AutoRoadmapError";
  }
}

interface AuthenticAutoPlanState {
  ledgerDigest: string;
  planDigest: string;
  materialBundleDigest: string;
  operationCap: number;
}

const authenticAutoPlans = new WeakMap<object, AuthenticAutoPlanState>();
const SHA256 = /^[a-f0-9]{64}$/u;

export function createAutoRoadmapExecutionPlanV1(
  input: CreateAutoRoadmapExecutionPlanInputV1,
): AutoRoadmapExecutionPlanV1 {
  const ledger = validateRoadmapLedger(input.ledger);
  const plan = validateRoadmapMutationPlanV2(input.plan, ledger);
  const materials = validateIssueLifecycleMaterialBundle(input.materials);
  const operationCap = boundedOperationCap(input.operationCap);
  if (
    materials.planDigest !== plan.digest ||
    plan.operations.length > operationCap ||
    materials.operations.length !== plan.operations.length
  ) {
    throw new AutoRoadmapError(
      plan.operations.length > operationCap ? "operation-cap-exceeded" : "invalid-plan",
    );
  }
  const operationKeys = sortedUnique(plan.operations.map((operation) => operation.key));
  if (
    operationKeys.length !== plan.operations.length ||
    sortedUnique(materials.operations.map((material) => material.operationKey)).join("\0") !==
      operationKeys.join("\0")
  ) {
    throw new AutoRoadmapError("invalid-plan");
  }
  try {
    for (const operation of plan.operations) {
      const material = materials.operations.find((item) => item.operationKey === operation.key)!;
      assertMaterialForOperation(operation, material);
    }
  } catch {
    throw new AutoRoadmapError("invalid-plan");
  }
  const source = sourceBinding(input.source);
  const deferredWorkUnitFingerprints = sortedUniqueDigests(
    input.deferredWorkUnitFingerprints,
    "deferredWorkUnitFingerprints",
  );
  const body = {
    kind: "docsfab-auto-roadmap-execution-plan" as const,
    schemaVersion: AUTO_ROADMAP_SCHEMA_VERSION,
    readOnly: true as const,
    authorization: null,
    source,
    ledgerDigest: ledger.digest,
    mutationPlanDigest: plan.digest,
    materialBundleDigest: materials.digest,
    operationCap,
    operationKeys,
    deferredWorkUnitFingerprints,
  };
  const artifact = freeze({ ...body, digest: roadmapDigest(body) });
  authenticAutoPlans.set(artifact, {
    ledgerDigest: ledger.digest,
    planDigest: plan.digest,
    materialBundleDigest: materials.digest,
    operationCap,
  });
  return artifact;
}

/** Restore a persisted preview only by reproducing it from exact validated inputs. */
export function restoreAutoRoadmapExecutionPlanV1(
  value: unknown,
  input: CreateAutoRoadmapExecutionPlanInputV1,
): AutoRoadmapExecutionPlanV1 {
  const expected = createAutoRoadmapExecutionPlanV1(input);
  if (
    !value ||
    typeof value !== "object" ||
    roadmapCanonicalJson(value) !== roadmapCanonicalJson(expected)
  ) {
    throw new AutoRoadmapError("invalid-plan");
  }
  return expected;
}

/**
 * Execute only the exact previewed plan. The issue lifecycle executor owns
 * preflight, tracker-drift rejection, write-ahead receipts, reconciliation,
 * and idempotent resume.
 */
export async function applyAutoRoadmapExecutionPlanV1(
  options: ApplyAutoRoadmapExecutionPlanOptionsV1,
): Promise<IssueLifecycleApplicationResult> {
  const state =
    options.autoPlan && typeof options.autoPlan === "object"
      ? authenticAutoPlans.get(options.autoPlan)
      : undefined;
  if (!state || roadmapDigest(options.autoPlan) !== options.autoPlan.digest) {
    throw new AutoRoadmapError("invalid-plan");
  }
  const ledger = validateRoadmapLedger(options.ledger);
  const plan = validateRoadmapMutationPlanV2(options.plan, ledger);
  const materials = validateIssueLifecycleMaterialBundle(options.materials);
  if (
    state.ledgerDigest !== ledger.digest ||
    state.planDigest !== plan.digest ||
    state.materialBundleDigest !== materials.digest ||
    !sameKeys(
      options.autoPlan.operationKeys,
      plan.operations.map((item) => item.key),
    )
  ) {
    throw new AutoRoadmapError("invalid-plan");
  }
  const authorization = validateRoadmapMutationAuthorizationV2(options.authorization, plan, ledger);
  if (
    authorization.authorizedOperationKeys.length > state.operationCap ||
    authorization.authorizedOperationKeys.some(
      (key) => !options.autoPlan.operationKeys.includes(key),
    )
  ) {
    throw new AutoRoadmapError("authorization-expansion");
  }
  const assertReceiptWithinCap = (receipt: RoadmapMutationReceiptV2): RoadmapMutationReceiptV2 => {
    const validated = validateRoadmapMutationReceiptV2(receipt, ledger, plan, authorization);
    const confirmed = new Set(
      validated.attempts
        .filter(
          (attempt) =>
            attempt.disposition === "succeeded" ||
            attempt.disposition === "reused" ||
            attempt.disposition === "skipped",
        )
        .map((attempt) => attempt.operationKey),
    );
    if (
      confirmed.size > state.operationCap ||
      [...confirmed].some((key) => !authorization.authorizedOperationKeys.includes(key))
    ) {
      throw new AutoRoadmapError("receipt-expansion");
    }
    return validated;
  };
  const loadedReceipt = options.loadReceipt
    ? async (): Promise<RoadmapMutationReceiptV2 | undefined> => {
        const receipt = await options.loadReceipt!();
        return receipt === undefined ? undefined : assertReceiptWithinCap(receipt);
      }
    : undefined;
  const initialReceipt =
    options.receipt === undefined ? undefined : assertReceiptWithinCap(options.receipt);
  return applyIssueLifecyclePlan({
    ...options,
    ledger,
    plan,
    authorization,
    materials,
    ...(initialReceipt === undefined ? {} : { receipt: initialReceipt }),
    ...(loadedReceipt === undefined ? {} : { loadReceipt: loadedReceipt }),
    persistReceipt: async (receipt): Promise<void> => {
      await options.persistReceipt(assertReceiptWithinCap(receipt));
    },
  });
}

function sourceBinding(value: AutoRoadmapCycleSourceV1): AutoRoadmapCycleSourceV1 {
  const keys = [
    "requestSha256",
    "assessmentSha256",
    "decisionSha256",
    "maturityAssessmentSha256",
    "maturitySelectionSha256",
    "trackerObservationSha256",
    "managedTrackerObservationSha256",
    "planningArtifactSha256",
  ] as const;
  if (
    !value ||
    typeof value !== "object" ||
    nodeUtilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length
  )
    throw new AutoRoadmapError("invalid-plan");
  const source = {} as Record<(typeof keys)[number], string>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !keys.includes(key as (typeof keys)[number])) {
      throw new AutoRoadmapError("invalid-plan");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor ||
      !Object.hasOwn(descriptor, "value") ||
      !descriptor.enumerable ||
      typeof descriptor.value !== "string" ||
      !SHA256.test(descriptor.value)
    ) {
      throw new AutoRoadmapError("invalid-plan");
    }
    source[key as (typeof keys)[number]] = descriptor.value;
  }
  return freeze(source as AutoRoadmapCycleSourceV1);
}

function boundedOperationCap(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > AUTO_ROADMAP_MAX_OPERATION_CAP) {
    throw new AutoRoadmapError("operation-cap-exceeded");
  }
  return value;
}

function sortedUnique(values: readonly string[]): string[] {
  const result = [...values].sort(compareText);
  if (new Set(result).size !== result.length || result.some((value) => value.length === 0)) {
    throw new AutoRoadmapError("invalid-plan");
  }
  return result;
}

function sortedUniqueDigests(values: readonly string[], _field: string): string[] {
  const result = sortedUnique(values);
  if (result.some((value) => !SHA256.test(value))) throw new AutoRoadmapError("invalid-plan");
  return result;
}

function sameKeys(left: readonly string[], right: readonly string[]): boolean {
  const sortedLeft = [...left].sort(compareText);
  const sortedRight = [...right].sort(compareText);
  return (
    sortedLeft.length === sortedRight.length &&
    sortedLeft.every((value, index) => value === sortedRight[index])
  );
}

function freeze<T extends object>(value: T): T {
  return Object.freeze(value);
}
