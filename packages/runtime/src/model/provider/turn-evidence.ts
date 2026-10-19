// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { ProviderRequestPolicyError } from "../request-policy.js";
import type { PendingFinalTurn } from "./turn-evidence-types.js";
import type { InferenceTurnEvidence } from "../../records/contracts.js";

/**
 * Write the finalized provider payload evidence for one governed turn.
 *
 * A retry re-enters Pi's payload hook for the same turn; it must not consume
 * another lease preflight or append a second ledger entry, so the first
 * finalization owns the entry. A repeat whose payload digest differs fails
 * closed, which makes the retry provably idempotent.
 *
 * The one sanctioned divergence is the nudged replay, announced through
 * `onRetry({ nudged: true })`: its digest must differ from the first attempt's,
 * and it rewrites `finalPayloadSha256` to the payload really sent. The request
 * policy digest must not move.
 */
export function finalizeTurnEvidence(
  pending: PendingFinalTurn,
  digests: {
    requestPolicySha256?: string;
    finalPayloadSha256: string;
    replayedReasoningOmitted?: number;
  },
): void {
  if (pending.finalized) {
    const nudged = pending.nudgedReplayPending;
    const sameRequest = pending.finalized.finalPayloadSha256 === digests.finalPayloadSha256;
    if (
      pending.finalized.requestPolicySha256 !== digests.requestPolicySha256 ||
      (nudged ? sameRequest : !sameRequest)
    ) {
      throw new ProviderRequestPolicyError("payload-authority", "turn-evidence-authority");
    }
    pending.nudgedReplayPending = false;
    writeTurnEvidence(pending, {
      ...pending.finalized,
      ...(nudged ? { finalPayloadSha256: digests.finalPayloadSha256 } : {}),
    });
    return;
  }
  const index = pending.governance.ledger.indexOf(pending.evidence);
  if (index < 0) {
    throw new ProviderRequestPolicyError("payload-authority", "turn-evidence-authority");
  }
  const finalized: InferenceTurnEvidence = {
    ...pending.evidence,
    providerPayloadSchemaVersion: 1,
    ...digests,
    ...turnAttemptCounters(pending),
  };
  pending.governance.ledger[index] = finalized;
  pending.finalized = finalized;
  pending.governance.beforeProviderTurn?.(structuredClone(finalized));
}

/**
 * The single write site for a finalized entry's later revisions. It replaces
 * the entry in place so the ledger keeps exactly one row per governed turn.
 */
export function writeTurnEvidence(
  pending: PendingFinalTurn,
  base: InferenceTurnEvidence,
  counters: Partial<InferenceTurnEvidence> = turnAttemptCounters(pending),
): void {
  const finalized = pending.finalized;
  const index = finalized ? pending.governance.ledger.indexOf(finalized) : -1;
  if (index < 0) {
    // hygiene: ok -- a reason code; the constructor makes it a sentence.
    throw new ProviderRequestPolicyError("payload-authority", "turn-evidence-authority");
  }
  const updated: InferenceTurnEvidence = { ...base, ...counters };
  pending.governance.ledger[index] = updated;
  pending.finalized = updated;
}

/** Counters present only when non-zero; absent means "none happened". */
function turnAttemptCounters(pending: PendingFinalTurn): Partial<InferenceTurnEvidence> {
  return {
    ...(pending.retries > 0 ? { providerRetries: pending.retries } : {}),
    ...(pending.blankTurns > 0 ? { providerBlankTurns: pending.blankTurns } : {}),
    ...(pending.replayVeto ? { providerReplayVeto: pending.replayVeto } : {}),
  };
}
