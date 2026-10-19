// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { IssueLifecyclePreflightV1 } from "./issue-lifecycle.js";
import { type RoadmapLedger } from "./contracts/ledger.js";
import { roadmapDigest } from "./contracts/decode.js";
import type {
  RoadmapEffectIdentity,
  RoadmapMutationAuthorizationV2,
  RoadmapMutationPlanV2,
  RoadmapMutationReceiptV2,
} from "./execution-v2.js";

export interface IssueLifecycleExecutionReceiptState {
  projectDigest: string;
  ledgerDigest: string;
  planDigest: string;
  authorizationDigest: string;
  operatorAuthorityId: string;
  operatorIdentityDigest: string;
  receiptDigest: string;
  confirmedEffects: ReadonlyMap<string, RoadmapEffectIdentity>;
}

const executedReceipts = new WeakMap<object, IssueLifecycleExecutionReceiptState>();

/** @internal Called only from the issue-lifecycle execution boundary. */
export function internalRecordIssueLifecycleExecution(
  preflight: IssueLifecyclePreflightV1,
  ledger: RoadmapLedger,
  plan: RoadmapMutationPlanV2,
  authorization: RoadmapMutationAuthorizationV2,
  receipt: RoadmapMutationReceiptV2,
): void {
  if (
    authorization.authority.kind !== "local-user" ||
    authorization.authority.id !== `local-user:${preflight.identity.identityDigest}`
  )
    return;
  const confirmedEffects = new Map<string, RoadmapEffectIdentity>();
  for (const attempt of receipt.attempts) {
    if (
      (attempt.disposition === "succeeded" || attempt.disposition === "reused") &&
      attempt.effect
    ) {
      confirmedEffects.set(attempt.operationKey, attempt.effect);
    }
  }
  executedReceipts.set(receipt, {
    projectDigest: roadmapDigest(plan.project),
    ledgerDigest: ledger.digest,
    planDigest: plan.digest,
    authorizationDigest: authorization.digest,
    operatorAuthorityId: authorization.authority.id,
    operatorIdentityDigest: preflight.identity.identityDigest,
    receiptDigest: receipt.digest,
    confirmedEffects,
  });
}

/** @internal A copied, restored, or caller-constructed receipt has no execution state. */
export function internalIssueLifecycleExecutionReceiptState(
  receipt: RoadmapMutationReceiptV2,
): IssueLifecycleExecutionReceiptState | undefined {
  return receipt && typeof receipt === "object" ? executedReceipts.get(receipt) : undefined;
}
