// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Hosted runtime progress events (`docsfab-host-runtime-event`).
 *
 * The host validates each line against the request that produced it. Operator
 * diagnostics belong on standard error, not this channel.
 */
import type { HostRuntimeRequestV1 } from "./request.js";
import { bad, enumeration, id, record } from "./wire-decode.js";

export const HOST_RUNTIME_EVENT_KIND = "docsfab-host-runtime-event" as const;

export interface HostRuntimeProgressV1 {
  readonly schemaVersion: 1;
  readonly kind: typeof HOST_RUNTIME_EVENT_KIND;
  readonly sequence: number;
  readonly type: "run-status" | "step-status";
  readonly runId: string;
  readonly stepId?: string;
  readonly status:
    | "queued"
    | "pending"
    | "running"
    | "needs-input"
    | "needs-human-decision"
    | "succeeded"
    | "failed";
}

export function parseHostRuntimeProgress(
  input: unknown,
  request: HostRuntimeRequestV1,
): HostRuntimeProgressV1 {
  const root =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : bad("invalid-progress");
  const type = enumeration(root.type, ["run-status", "step-status"] as const);
  const expected =
    type === "step-status"
      ? ["schemaVersion", "kind", "sequence", "type", "runId", "stepId", "status"]
      : ["schemaVersion", "kind", "sequence", "type", "runId", "status"];
  record(root, expected);
  if (
    root.schemaVersion !== 1 ||
    root.kind !== HOST_RUNTIME_EVENT_KIND ||
    !Number.isSafeInteger(root.sequence) ||
    (root.sequence as number) < 1 ||
    root.runId !== request.runId
  )
    bad("invalid-progress");
  const runStatuses = [
    "queued",
    "running",
    "needs-input",
    "needs-human-decision",
    "succeeded",
    "failed",
  ] as const;
  const stepStatuses = [
    "pending",
    "running",
    "needs-input",
    "needs-human-decision",
    "succeeded",
    "failed",
  ] as const;
  const status =
    type === "run-status"
      ? enumeration(root.status, runStatuses)
      : enumeration(root.status, stepStatuses);
  const stepId = type === "step-status" ? id(root.stepId) : undefined;
  if (stepId && !request.stepIds.includes(stepId)) bad("progress-step-substitution");
  const progress: HostRuntimeProgressV1 = {
    schemaVersion: 1,
    kind: HOST_RUNTIME_EVENT_KIND,
    sequence: root.sequence as number,
    type,
    runId: request.runId,
    ...(stepId ? { stepId } : {}),
    status,
  };
  return Object.freeze(progress);
}
