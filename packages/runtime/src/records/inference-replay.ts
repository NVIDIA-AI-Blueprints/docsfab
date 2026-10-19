// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The replay mode a step records, and what each lets its retry policy do.
 *
 * - `read-only`: replays every configured retryable category.
 * - `disabled-write-step`: contract retries stay disabled; transport retries
 *   require attempt-wide host proof that no write tool executed.
 * - `reset-write-step`: the host restores the workspace to the step's sealed
 *   input before every retry. It replays malformed replies and transport
 *   failures covered by a recorded transport budget. Only
 *   `revise-documentation` has such a host.
 *
 * `workflow-execution/retry.ts` and every record validator share this module,
 * so a validator cannot admit a retry the writer would not schedule.
 */

import type { InferenceExecutionEvidence, InferenceFailureCategory } from "./contracts.js";
import { isTransportRetryCategory } from "./inference-retry-disposition.js";
import type { StepMode } from "../workflow-contracts/contracts.js";
import { REVISE_DOCUMENTATION_STEP_ID } from "../workflow-contracts/run-recovery-presentation.js";

export type InferenceReplayMode = InferenceExecutionEvidence["replay"];

export const INFERENCE_REPLAY_MODES = Object.freeze([
  "read-only",
  "disabled-write-step",
  "reset-write-step",
] as const satisfies readonly InferenceReplayMode[]);

/** `true` only while the tuple above lists the whole record-contract union. */
export const INFERENCE_REPLAY_MODE_COVERAGE: [InferenceReplayMode] extends [
  (typeof INFERENCE_REPLAY_MODES)[number],
]
  ? true
  : never = true;

export const RESET_WRITE_STEP_RETRY_CATEGORIES = Object.freeze([
  "malformed-response",
] as const satisfies readonly InferenceFailureCategory[]);

export function effectiveInferenceRetryCategories(
  replay: InferenceReplayMode,
  configured: readonly InferenceFailureCategory[],
  hasTransportBudget = false,
): InferenceFailureCategory[] {
  if (replay === "read-only") return [...configured];
  const transport = hasTransportBudget ? configured.filter(isTransportRetryCategory) : [];
  if (replay === "reset-write-step") {
    return configured.filter(
      (category) =>
        (RESET_WRITE_STEP_RETRY_CATEGORIES as readonly InferenceFailureCategory[]).includes(
          category,
        ) || transport.includes(category),
    );
  }
  return transport;
}

export function replayKeepsConfiguredBudget(replay: InferenceReplayMode): boolean {
  return replay === "read-only" || replay === "reset-write-step";
}

/**
 * The replay modes a step may record. The CREATE revision writer may also
 * record `reset-write-step`; this function still admits `disabled-write-step`
 * for older records.
 */
export function admittedInferenceReplays(step: {
  readonly id: string;
  readonly mode: StepMode;
}): readonly InferenceReplayMode[] {
  if (step.mode === "read-only") return ["read-only"];
  return step.id === REVISE_DOCUMENTATION_STEP_ID
    ? ["disabled-write-step", "reset-write-step"]
    : ["disabled-write-step"];
}

export function inferenceReplayFor(mode: StepMode, hostResetsWrites: boolean): InferenceReplayMode {
  if (mode === "read-only") return "read-only";
  return hostResetsWrites ? "reset-write-step" : "disabled-write-step";
}
