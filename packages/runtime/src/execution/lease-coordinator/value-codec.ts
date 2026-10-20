// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AnyExecutionLeasePolicyV1OrV2 } from "../lease-contracts.js";
import { digest, exact, freeze, hash, inert, nonnegative, positive, reject } from "./protocol.js";
import type {
  BoundExecutionPricingV1,
  ExecutionContextObservationV1,
  ExecutionProgressObservationV1,
  ExecutionResourceEnvelopeV1,
  GrantedExecutionResourceEnvelopeV1,
} from "./types.js";

export function createExecutionProgressObservation(
  input: Omit<ExecutionProgressObservationV1, "schemaVersion" | "kind" | "observationSha256">,
): ExecutionProgressObservationV1 {
  inert(input);
  exact(input, [
    "sequence",
    "providerTurns",
    "compactions",
    "cumulativeInputTokens",
    "cumulativeOutputTokens",
    "elapsedMs",
    "context",
  ]);
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-execution-progress-observation" as const,
    sequence: positive(input.sequence),
    providerTurns: nonnegative(input.providerTurns),
    compactions: nonnegative(input.compactions),
    cumulativeInputTokens: nonnegative(input.cumulativeInputTokens),
    cumulativeOutputTokens: nonnegative(input.cumulativeOutputTokens),
    elapsedMs: nonnegative(input.elapsedMs),
    context: decodeContext(input.context),
  };
  return freeze({ ...body, observationSha256: hash(body) });
}

export function decodeObservation(
  value: ExecutionProgressObservationV1,
  contextAuthoritySha256?: string,
): ExecutionProgressObservationV1 {
  inert(value);
  exact(value, [
    "schemaVersion",
    "kind",
    "sequence",
    "providerTurns",
    "compactions",
    "cumulativeInputTokens",
    "cumulativeOutputTokens",
    "elapsedMs",
    "context",
    "observationSha256",
  ]);
  if (value.schemaVersion !== 1 || value.kind !== "docsfab-execution-progress-observation")
    reject();
  const decoded = createExecutionProgressObservation({
    sequence: value.sequence,
    providerTurns: value.providerTurns,
    compactions: value.compactions,
    cumulativeInputTokens: value.cumulativeInputTokens,
    cumulativeOutputTokens: value.cumulativeOutputTokens,
    elapsedMs: value.elapsedMs,
    context: value.context,
  });
  if (
    decoded.observationSha256 !== value.observationSha256 ||
    (contextAuthoritySha256 !== undefined &&
      decoded.context.authoritySha256 !== contextAuthoritySha256)
  )
    reject();
  return decoded;
}

export function decodeEnvelope(value: ExecutionResourceEnvelopeV1): ExecutionResourceEnvelopeV1 {
  inert(value);
  exact(value, [
    "toolCalls",
    "providerTurns",
    "compactions",
    "inputTokens",
    "outputTokens",
    "elapsedMs",
    "contextInputTokens",
  ]);
  const decoded = {
    toolCalls: nonnegative(value.toolCalls),
    providerTurns: nonnegative(value.providerTurns),
    compactions: nonnegative(value.compactions),
    inputTokens: nonnegative(value.inputTokens),
    outputTokens: nonnegative(value.outputTokens),
    elapsedMs: nonnegative(value.elapsedMs),
    contextInputTokens: nonnegative(value.contextInputTokens),
  };
  return freeze(decoded);
}

export function decodeGrantedEnvelope(
  value: GrantedExecutionResourceEnvelopeV1,
): GrantedExecutionResourceEnvelopeV1 {
  inert(value);
  exact(value, [
    "toolCalls",
    "providerTurns",
    "compactions",
    "inputTokens",
    "outputTokens",
    "elapsedMs",
    "contextInputTokens",
    "knownCostMicrousd",
  ]);
  const envelope = decodeEnvelope({
    toolCalls: value.toolCalls,
    providerTurns: value.providerTurns,
    compactions: value.compactions,
    inputTokens: value.inputTokens,
    outputTokens: value.outputTokens,
    elapsedMs: value.elapsedMs,
    contextInputTokens: value.contextInputTokens,
  });
  return freeze({ ...envelope, knownCostMicrousd: nonnegative(value.knownCostMicrousd) });
}

export function requireExecutableEnvelope(value: ExecutionResourceEnvelopeV1): void {
  positive(value.toolCalls);
  positive(value.providerTurns);
  positive(value.inputTokens);
  positive(value.outputTokens);
  positive(value.elapsedMs);
  positive(value.contextInputTokens);
}

export function requireRenewalEnvelope(
  value: ExecutionResourceEnvelopeV1,
  policy: AnyExecutionLeasePolicyV1OrV2,
): void {
  if (policy.schemaVersion !== 2 || policy.aggregatePolicy.kind !== "absent") {
    requireExecutableEnvelope(value);
    return;
  }
  positive(value.toolCalls);
  positive(value.providerTurns);
  positive(value.inputTokens);
  positive(value.outputTokens);
  nonnegative(value.elapsedMs);
  positive(value.contextInputTokens);
}

export function decodeContext(value: ExecutionContextObservationV1): ExecutionContextObservationV1 {
  inert(value);
  exact(value, ["status", "availableInputTokens", "requiredInputTokens", "authoritySha256"]);
  if (value.status !== "ready" && value.status !== "exhausted") reject();
  const decoded = {
    status: value.status,
    availableInputTokens: nonnegative(value.availableInputTokens),
    requiredInputTokens: positive(value.requiredInputTokens),
    authoritySha256: digest(value.authoritySha256),
  };
  if (decoded.status === "ready" && decoded.availableInputTokens < decoded.requiredInputTokens)
    reject();
  return freeze(decoded);
}

export function decodePricing(value: BoundExecutionPricingV1): BoundExecutionPricingV1 {
  inert(value);
  digest(value.authoritySha256);
  if (value.status === "known") {
    exact(value, [
      "status",
      "inputMicrousdPerMillionTokens",
      "outputMicrousdPerMillionTokens",
      "authoritySha256",
    ]);
    return freeze({
      status: "known",
      inputMicrousdPerMillionTokens: nonnegative(value.inputMicrousdPerMillionTokens),
      outputMicrousdPerMillionTokens: nonnegative(value.outputMicrousdPerMillionTokens),
      authoritySha256: value.authoritySha256,
    });
  }
  if (
    value.status === "unavailable" &&
    (value.reason === "pricing-unknown" || value.reason === "pricing-stale")
  ) {
    exact(value, ["status", "reason", "authoritySha256"]);
    return freeze({
      status: value.status,
      reason: value.reason,
      authoritySha256: value.authoritySha256,
    });
  }
  return reject();
}

export function costForTokens(
  pricing: Extract<BoundExecutionPricingV1, { status: "known" }>,
  inputTokens: number,
  outputTokens: number,
): number {
  const numerator =
    BigInt(inputTokens) * BigInt(pricing.inputMicrousdPerMillionTokens) +
    BigInt(outputTokens) * BigInt(pricing.outputMicrousdPerMillionTokens);
  const cost = Number((numerator + 999_999n) / 1_000_000n);
  if (!Number.isSafeInteger(cost)) reject();
  return cost;
}
