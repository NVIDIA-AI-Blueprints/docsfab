// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { EXECUTION_STOP_REASON_PRECEDENCE } from "../lease-contracts.js";
import { digest, exact, reject, uniqueReasons } from "./protocol.js";
import type { CheckpointRequestV1, ExecutionCoordinatorCommandV1 } from "./types.js";

export function validateCommand(value: ExecutionCoordinatorCommandV1): void {
  if (value.kind === "observe-provider-turn") {
    exact(value, ["kind", "observation"]);
    return;
  }
  if (value.kind === "observe-checkpoint-turn") {
    exact(value, ["kind", "observation"]);
    return;
  }
  if (value.kind === "request-tool-batch") {
    exact(value, ["kind", "calls", "envelope"]);
    return;
  }
  if (value.kind === "settle-tool-batch") {
    exact(value, ["kind", "results", "observation"]);
    return;
  }
  if (value.kind === "fail-tool-batch") {
    exact(
      value,
      ["kind", "results", "observation", "reason", "lateDeniedCallSha256"],
      ["lateDeniedCallSha256"],
    );
    return;
  }
  if (value.kind === "renew") {
    exact(value, ["kind", "nextTranche"]);
    return;
  }
  if (value.kind === "complete") {
    exact(value, ["kind"]);
    return;
  }
  if (value.kind === "stop") {
    exact(value, ["kind", "reason"]);
    return;
  }
  reject();
}

export function validateCheckpointRequest(value: CheckpointRequestV1): void {
  exact(value, ["reason", "stopReasons", "observationSha256", "chargeableAttemptStateSha256"]);
  if (value.reason !== "lease-exhausted" && value.reason !== "budget-boundary") reject();
  digest(value.observationSha256);
  digest(value.chargeableAttemptStateSha256);
  for (const reason of value.stopReasons) {
    if (!EXECUTION_STOP_REASON_PRECEDENCE.includes(reason)) reject();
  }
  if (uniqueReasons(value.stopReasons).length !== value.stopReasons.length) reject();
}
