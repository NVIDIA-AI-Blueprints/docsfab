// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { InferenceProgressObservationV1 } from "./contracts.js";

const EVENTS = new Set([
  "provider-turn-started",
  "provider-turn-settled",
  "tool-execution-started",
  "tool-execution-settled",
]);
const PHASES = new Set([
  "provider-turn-pending",
  "provider-turn-settled",
  "tool-execution-active",
  "tool-execution-settled",
]);

function countPair(value: unknown): value is { started: number; settled: number } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const pair = value as Record<string, unknown>;
  return (
    Object.keys(pair).length === 2 &&
    Object.hasOwn(pair, "started") &&
    Object.hasOwn(pair, "settled") &&
    Number.isSafeInteger(pair.started) &&
    Number.isSafeInteger(pair.settled) &&
    Number(pair.started) >= 0 &&
    Number(pair.settled) >= 0 &&
    Number(pair.settled) <= Number(pair.started)
  );
}

export function decodeInferenceProgressObservation(value: unknown): InferenceProgressObservationV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The inference progress observation does not satisfy its closed schema.");
  }
  const item = value as Record<string, unknown>;
  const keys = [
    "schemaVersion",
    "kind",
    "attempt",
    "observedAt",
    "event",
    "phase",
    "providerTurns",
    "toolExecutions",
  ];
  const expectedKeys = [...keys, ...(Object.hasOwn(item, "usage") ? ["usage"] : [])];
  if (Object.hasOwn(item, "toolActivity")) expectedKeys.push("toolActivity");
  if (
    Object.keys(item).length !== expectedKeys.length ||
    expectedKeys.some((key) => !Object.hasOwn(item, key)) ||
    item.schemaVersion !== 1 ||
    item.kind !== "docsfab-inference-progress-observation" ||
    !Number.isSafeInteger(item.attempt) ||
    Number(item.attempt) < 1 ||
    typeof item.observedAt !== "string" ||
    !Number.isFinite(Date.parse(item.observedAt)) ||
    new Date(item.observedAt).toISOString() !== item.observedAt ||
    typeof item.event !== "string" ||
    !EVENTS.has(item.event) ||
    typeof item.phase !== "string" ||
    !PHASES.has(item.phase) ||
    !countPair(item.providerTurns) ||
    !countPair(item.toolExecutions) ||
    (Object.hasOwn(item, "toolActivity") &&
      !decodeToolActivity(item.toolActivity, item.toolExecutions)) ||
    (item.usage !== undefined && !decodeUsage(item.usage))
  ) {
    throw new Error("The inference progress observation does not satisfy its closed schema.");
  }
  const event = item.event;
  const phase = item.phase;
  const provider = item.providerTurns as { started: number; settled: number };
  const tools = item.toolExecutions as { started: number; settled: number };
  const consistent =
    (event === "provider-turn-started" && phase === "provider-turn-pending") ||
    (event === "provider-turn-settled" && phase === "provider-turn-settled") ||
    (event === "tool-execution-started" &&
      phase === "tool-execution-active" &&
      tools.started > tools.settled) ||
    (event === "tool-execution-settled" &&
      ((phase === "tool-execution-settled" && tools.settled === tools.started) ||
        (phase === "tool-execution-active" && tools.settled < tools.started)));
  if (
    !consistent ||
    provider.started < 1 ||
    (event === "provider-turn-started" && provider.started !== provider.settled + 1) ||
    (event === "provider-turn-settled" && provider.started !== provider.settled) ||
    tools.started < 0
  ) {
    throw new Error("The inference progress observation does not satisfy its closed schema.");
  }
  return value as InferenceProgressObservationV1;
}

const TOOL_ACTIVITY_CATEGORIES = [
  "answerRecord",
  "reportSubmission",
  "candidateValidation",
  "readSearch",
  "other",
] as const;

function decodeToolActivity(value: unknown, executions: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const activity = value as Record<string, unknown>;
  if (
    Object.keys(activity).length !== TOOL_ACTIVITY_CATEGORIES.length ||
    !TOOL_ACTIVITY_CATEGORIES.every((category) => Object.hasOwn(activity, category))
  )
    return false;
  const sums = { started: 0, settled: 0 };
  for (const category of TOOL_ACTIVITY_CATEGORIES) {
    const counts = activity[category];
    if (!counts || typeof counts !== "object" || Array.isArray(counts)) return false;
    const item = counts as Record<string, unknown>;
    if (
      Object.keys(item).length !== 3 ||
      !["started", "settled", "errorResults"].every((key) => Object.hasOwn(item, key)) ||
      ![item.started, item.settled, item.errorResults].every(
        (count) => Number.isSafeInteger(count) && Number(count) >= 0,
      ) ||
      Number(item.errorResults) > Number(item.settled) ||
      Number(item.settled) > Number(item.started)
    )
      return false;
    sums.started += Number(item.started);
    sums.settled += Number(item.settled);
  }
  const total = executions as { started: number; settled: number };
  return (
    Number.isSafeInteger(sums.started) &&
    Number.isSafeInteger(sums.settled) &&
    sums.started === total.started &&
    sums.settled === total.settled
  );
}

function decodeUsage(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const keys = ["input", "output", "cacheRead", "cacheWrite", "total", "turns"];
  if (
    Object.keys(item).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(item, key) && Number.isSafeInteger(item[key])) ||
    !keys.every((key) => Number(item[key]) >= 0)
  ) {
    return false;
  }
  const componentTotal =
    Number(item.input) + Number(item.output) + Number(item.cacheRead) + Number(item.cacheWrite);
  return Number.isSafeInteger(componentTotal) && componentTotal === Number(item.total);
}
