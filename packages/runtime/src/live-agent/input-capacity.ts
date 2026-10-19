// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Representation capacities remain independent of a smaller operator intake allowance. */
import { HOST_RUNTIME_READER_REQUEST_MAXIMUM_BYTES } from "../host-invoker/reader-task-capacity.js";
import { LIMIT_DEFINITION_BY_NAME } from "../config/limits.generated.js";
import { deriveLiveAgentInputCapacities } from "./input-envelope.js";

function capacity(name: string): number {
  const definition = LIMIT_DEFINITION_BY_NAME[name];
  if (!definition)
    throw new Error(`Hosted input capacity ${name} is absent from the generated catalog.`);
  return definition.max;
}

export const HOSTED_INPUT_CAPACITY = deriveLiveAgentInputCapacities({
  questionBytes: capacity("host.slack.liveAgentTurnTextMaxBytes"),
  ordinaryFrozenInputBytes: capacity("hostInvoker.frozenInputMaxBytes"),
  ordinaryFrozenInputsBytes: capacity("hostInvoker.frozenInputsMaxBytes"),
  ordinaryRequestBytes: capacity("hostInvoker.requestMaxBytes"),
});

/** Canon travels as a JSON string, so the wire boundary reserves JSON's longest
 * encoding of every admitted chunk byte. That boundary is its own registered
 * bound, `semantic.comparisonRequestBytes`, not a multiple of the chunk
 * allowance, and it also feeds the pre-parse ceiling `HOSTED_REQUEST_MAXIMUM_BYTES`. */
export const SEMANTIC_INPUT_CAPACITY = Object.freeze({
  frozenInputsBytes: capacity("semantic.comparisonChunkBytes"),
  requestBytes: capacity("semantic.comparisonRequestBytes"),
});
export const HOSTED_REQUEST_MAXIMUM_BYTES = Math.max(
  HOSTED_INPUT_CAPACITY.requestBytes,
  SEMANTIC_INPUT_CAPACITY.requestBytes,
  HOST_RUNTIME_READER_REQUEST_MAXIMUM_BYTES,
);

/** Preserve the legacy small-budget partition while budgeting complete canon. */
export function semanticComparisonEvidenceBudget(
  configuredBytes: number,
  canonBytes: number,
): number {
  return configuredBytes <= HOSTED_INPUT_CAPACITY.ordinaryFrozenInputsBytes
    ? Math.min(configuredBytes, HOSTED_INPUT_CAPACITY.ordinaryFrozenInputsBytes - canonBytes)
    : configuredBytes - canonBytes;
}

export function hostedRequestMaximumBytes(workflow: string): number {
  return workflow === "reconcile-product-behavior"
    ? SEMANTIC_INPUT_CAPACITY.requestBytes
    : workflow === "live-agent-turn"
      ? HOSTED_INPUT_CAPACITY.requestBytes
      : workflow === "update-documentation"
        ? HOST_RUNTIME_READER_REQUEST_MAXIMUM_BYTES
        : HOSTED_INPUT_CAPACITY.ordinaryRequestBytes;
}
