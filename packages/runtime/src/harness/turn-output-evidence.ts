// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { InferenceTurnEvidence } from "../records/contracts.js";

const CLOSED_PROVIDER_FINISH_REASON = /^[a-z][a-z0-9_]{0,31}$/u;

/**
 * Tokens one governed turn actually produced, or `undefined` when unknown.
 *
 * `providerUsage` defaults missing usage to 0 for lease reservation, but that
 * default is not an observation, so a record must omit `outputTokens` rather
 * than claim a zero-token completion. Discarded in-turn replay output still
 * counts, so a later failure does not erase earlier production.
 */
export function attributedProducedOutputTokens(
  message: object,
  discardedOutputTokens = 0,
): number | undefined {
  const record = message as { errorMessage?: unknown; usage?: { output?: unknown } };
  const errorPresent =
    typeof record.errorMessage === "string" && record.errorMessage.trim().length > 0;
  const rawOutput = record.usage?.output;
  const usagePresent = Number.isSafeInteger(rawOutput) && Number(rawOutput) >= 0;
  const discarded =
    Number.isSafeInteger(discardedOutputTokens) && discardedOutputTokens > 0
      ? discardedOutputTokens
      : 0;
  const landed =
    usagePresent && !(errorPresent && Number(rawOutput) === 0) ? Number(rawOutput) : undefined;
  if (landed !== undefined) return landed + discarded;
  if (discarded > 0) return discarded;
  return undefined;
}

/**
 * Closed provider `finish_reason` from a landed assistant message, or omitted
 * when the transport did not preserve a valid token. Never stores `absent`,
 * model prose, or credential-shaped text.
 */
export function attributedProviderFinishReason(message: object): string | undefined {
  const raw = (message as { rawStopReason?: unknown }).rawStopReason;
  if (typeof raw !== "string") return undefined;
  const token = raw.trim();
  return CLOSED_PROVIDER_FINISH_REASON.test(token) && token !== "absent" ? token : undefined;
}

/**
 * Copy tokens the provider actually produced onto each sent turn, zipped in
 * order. Stop turns and unknown slots omit the field rather than keeping the
 * grant. Values may include discarded in-turn replay output.
 */
export function bindProducedTurnOutputTokens(
  turns: readonly InferenceTurnEvidence[],
  producedOutputTokens: readonly (number | undefined)[],
): InferenceTurnEvidence[] {
  let index = 0;
  return turns.map((turn) => {
    if (turn.decision === "stop") return turn;
    const produced = producedOutputTokens[index];
    index += 1;
    if (produced === undefined || !Number.isSafeInteger(produced) || produced < 0) {
      if (turn.outputTokens === undefined) return turn;
      const { outputTokens: _grantPlaceholder, ...rest } = turn;
      return rest;
    }
    return { ...turn, outputTokens: produced };
  });
}

/**
 * Copy the provider's closed finish reason onto each sent turn, zipped in
 * order. Stop turns and missing or non-closed values omit the field.
 */
export function bindProviderFinishReasons(
  turns: readonly InferenceTurnEvidence[],
  finishReasons: readonly unknown[],
): InferenceTurnEvidence[] {
  let index = 0;
  return turns.map((turn) => {
    if (turn.decision === "stop") {
      if (turn.rawStopReason === undefined) return turn;
      const { rawStopReason: _drop, ...rest } = turn;
      return rest;
    }
    const attributed = attributedProviderFinishReason({
      rawStopReason: finishReasons[index],
    });
    index += 1;
    if (attributed === undefined) {
      if (turn.rawStopReason === undefined) return turn;
      const { rawStopReason: _drop, ...rest } = turn;
      return rest;
    }
    return { ...turn, rawStopReason: attributed };
  });
}
