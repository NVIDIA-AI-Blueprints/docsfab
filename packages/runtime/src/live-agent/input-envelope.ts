// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Pure hosted-question envelope sizing, shared by the host and runtime.
 * No model, filesystem, credential or execution authority is imported here.
 */
export interface HostedInputCapacities {
  readonly questionBytes: number;
  readonly ordinaryFrozenInputBytes: number;
  readonly ordinaryFrozenInputsBytes: number;
  readonly ordinaryRequestBytes: number;
}

/** These are the admitted wire grammar's field widths, not operational quotas. */
export function maximumLiveAgentTurnFramingBytes(): number {
  return Buffer.byteLength(
    JSON.stringify({
      turnKind: "docsfab-live-agent-turn",
      sessionId: "s".repeat(128),
      threadBindingSha256: "a".repeat(64),
      messageTs: `${"1".repeat(20)}.${"1".repeat(20)}`,
      text: "",
      scopeSha256: "b".repeat(64),
      priorSessionStateSha256: null,
      priorSessionState: null,
    }),
  );
}

export function deriveLiveAgentInputCapacities(input: HostedInputCapacities) {
  for (const value of Object.values(input)) {
    if (!Number.isSafeInteger(value) || value < 1)
      throw new Error("Hosted input capacity must be a positive safe integer.");
  }
  // Admitted questions exclude controls except tab/CR/LF. Quotes, slashes and
  // these remaining controls require at most twice their UTF-8 bytes in JSON.
  const eventBytes = Math.max(
    input.ordinaryFrozenInputBytes,
    input.questionBytes * 2 + maximumLiveAgentTurnFramingBytes(),
  );
  const growth = eventBytes - input.ordinaryFrozenInputBytes;
  const frozenInputsBytes = input.ordinaryFrozenInputsBytes + growth;
  // The event is JSON carried inside a JSON string in the complete request.
  const requestBytes = input.ordinaryRequestBytes + growth * 2;
  if (![eventBytes, frozenInputsBytes, requestBytes].every(Number.isSafeInteger)) {
    throw new Error(
      "Hosted input capacities exceed safe integer storage; correct the catalog values.",
    );
  }
  return Object.freeze({ ...input, eventBytes, frozenInputsBytes, requestBytes });
}
