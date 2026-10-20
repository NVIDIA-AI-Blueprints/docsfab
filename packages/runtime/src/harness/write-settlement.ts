// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ExecutionToolCallCountersV1 } from "../execution/lease-contracts.js";
import type { ToolActivityEntry } from "../records/contracts.js";
import { QUALITY_SUBMISSION_TOOL_NAME } from "./answer-submission.js";
import { CANON_TOOL_NAMES } from "./canon-tools.js";
import { HISTORY_TOOL_NAMES } from "./history-tools.js";
import { OBSERVATION_TOOL_NAMES } from "./observation-tools.js";
import { FILESYSTEM_READ_ONLY_TOOLS, READ_ONLY_TOOLS } from "./pi-tool-confine.js";
import { QUALITY_CANDIDATE_VALIDATION_TOOL_NAME } from "./pi-tool-confine.js";
import { SOURCE_TOOL_NAMES } from "./source-tools.js";
import { TOOL_RESULT_RECALL_TOOL_NAME } from "./tool-output-cap.js";

export type InferenceAttemptWriteSettlement = "no-write" | "write-executed" | "unavailable";

export interface AttemptToolCallSettlement {
  readonly name: string;
  /** The attempt's host authorization admitted this call to execution. */
  readonly authorized: boolean;
  /** A later host preflight refused it before the tool implementation ran. */
  readonly hostDenied: boolean;
  /** Present only when the host observed the tool implementation's result. */
  readonly outcome?: "succeeded" | "failed";
}

/** One host-observed, attempt-wide projection of Pi tool settlement. */
export interface AttemptWriteSettlementInput {
  readonly leaseTerminal: boolean;
  readonly presented: readonly string[];
  readonly calls: readonly AttemptToolCallSettlement[];
  readonly counters: ExecutionToolCallCountersV1;
  readonly toolActivity: {
    readonly totalCalls: number;
    readonly failedCalls: number;
    readonly byTool: readonly ToolActivityEntry[];
  };
}

const READ_ONLY_TOOL_NAMES = new Set<string>([
  ...FILESYSTEM_READ_ONLY_TOOLS,
  ...READ_ONLY_TOOLS,
  ...CANON_TOOL_NAMES,
  ...HISTORY_TOOL_NAMES,
  ...OBSERVATION_TOOL_NAMES,
  ...SOURCE_TOOL_NAMES,
  QUALITY_CANDIDATE_VALIDATION_TOOL_NAME,
  QUALITY_SUBMISSION_TOOL_NAME,
  TOOL_RESULT_RECALL_TOOL_NAME,
]);
const MUTATING_TOOL_NAMES = new Set(["edit", "write"]);

/**
 * No-write evidence requires every host-authorized call across every turn to
 * have a result and the per-call, execution-lease, and tool-activity ledgers to
 * reconcile. An incomplete batch or unrecognized tool never proves absence.
 */
export function inferAttemptWriteSettlement(
  input: AttemptWriteSettlementInput,
): InferenceAttemptWriteSettlement {
  const { counters, toolActivity } = input;
  const integers = [
    counters.requested,
    counters.executed,
    counters.succeeded,
    counters.failed,
    counters.denied,
    counters.governanceBlocked,
    toolActivity.totalCalls,
    toolActivity.failedCalls,
  ];
  if (
    !input.leaseTerminal ||
    !integers.every((value) => Number.isSafeInteger(value) && value >= 0) ||
    new Set(input.presented).size !== input.presented.length ||
    input.presented.some(
      (name) => !READ_ONLY_TOOL_NAMES.has(name) && !MUTATING_TOOL_NAMES.has(name),
    ) ||
    counters.requested !== input.calls.length ||
    counters.requested !== counters.executed + counters.denied + counters.governanceBlocked ||
    counters.executed !== counters.succeeded + counters.failed ||
    toolActivity.totalCalls !== counters.executed ||
    toolActivity.failedCalls !== counters.failed
  ) {
    return "unavailable";
  }

  let observedCalls = 0;
  let observedFailures = 0;
  let writeExecuted = false;
  const byTool = new Map<string, { calls: number; failures: number }>();
  for (const call of input.calls) {
    if (!input.presented.includes(call.name)) return "unavailable";
    if (call.hostDenied && (!call.authorized || call.outcome !== undefined)) {
      return "unavailable";
    }
    if (!call.authorized) {
      if (call.outcome !== undefined || call.hostDenied) return "unavailable";
      continue;
    }
    if (call.hostDenied) continue;
    if (call.outcome === undefined) return "unavailable";
    observedCalls += 1;
    if (call.outcome === "failed") observedFailures += 1;
    const activity = byTool.get(call.name) ?? { calls: 0, failures: 0 };
    activity.calls += 1;
    if (call.outcome === "failed") activity.failures += 1;
    byTool.set(call.name, activity);
    if (MUTATING_TOOL_NAMES.has(call.name)) writeExecuted = true;
    else if (!READ_ONLY_TOOL_NAMES.has(call.name)) return "unavailable";
  }

  if (observedCalls !== counters.executed || observedFailures !== counters.failed) {
    return "unavailable";
  }
  if (
    toolActivity.byTool.some(
      (entry) =>
        !Number.isSafeInteger(entry.calls) ||
        entry.calls < 0 ||
        !Number.isSafeInteger(entry.failures) ||
        entry.failures < 0 ||
        entry.failures > entry.calls,
    ) ||
    toolActivity.byTool.length !== byTool.size ||
    toolActivity.byTool.some((entry) => {
      const observed = byTool.get(entry.name);
      return (
        observed === undefined ||
        observed.calls !== entry.calls ||
        observed.failures !== entry.failures
      );
    })
  ) {
    return "unavailable";
  }
  return writeExecuted ? "write-executed" : "no-write";
}
