// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { delegatedTaskContractKit, type DelegatedTaskResultV1 } from "./result-contract.js";
import { delegatedTaskPresentation } from "./presentation.js";
import { renderPresentation, resolvePresentationCapabilities } from "../operator/index.js";

const { canonicalDigest, canonicalJson } = delegatedTaskContractKit;

export const DELEGATED_TASK_EXIT_REASONS = [
  "complete",
  "incomplete",
  "needs-input",
  "failed",
  "cancelled",
  "budget-exhausted",
  "deadline-exceeded",
] as const;
export type DelegatedTaskExitReason = (typeof DELEGATED_TASK_EXIT_REASONS)[number];

export interface DelegatedTaskExitIntentV1 {
  exitCode: 0 | 1 | 2;
  reason: DelegatedTaskExitReason;
}

export interface DelegatedTaskHumanProjectionV1 {
  taskId: string;
  fulfillment: DelegatedTaskResultV1["fulfillment"];
  stopReason: DelegatedTaskResultV1["stopReason"];
  unmetRequirementIds: readonly string[];
  checkState: DelegatedTaskResultV1["checkState"];
  childIds: readonly string[];
  locators: readonly string[];
  usage: DelegatedTaskResultV1["usage"];
  nextAction: DelegatedTaskResultV1["nextAction"];
  text: string;
}

/**
 * Exit zero only for completed requested work that finished. `needs-input` uses
 * the existing exit-2 convention. Other incomplete terminals are nonzero and
 * typed. Delivery/publication eligibility never changes this mapping.
 */
export function delegatedTaskExitIntent(result: DelegatedTaskResultV1): DelegatedTaskExitIntentV1 {
  if (result.fulfillment === "complete" && result.stopReason === "finished") {
    return { exitCode: 0, reason: "complete" };
  }
  if (result.stopReason === "needs-input") return { exitCode: 2, reason: "needs-input" };
  if (result.stopReason === "failed") return { exitCode: 1, reason: "failed" };
  if (result.stopReason === "cancelled") return { exitCode: 1, reason: "cancelled" };
  if (result.stopReason === "budget-exhausted") {
    return { exitCode: 1, reason: "budget-exhausted" };
  }
  // A DocsFab wall-clock deadline keeps its own exit reason, not `cancelled`.
  if (result.stopReason === "deadline-exceeded") {
    return { exitCode: 1, reason: "deadline-exceeded" };
  }
  return { exitCode: 1, reason: "incomplete" };
}

export function formatDelegatedTaskResultHuman(
  result: DelegatedTaskResultV1,
): DelegatedTaskHumanProjectionV1 {
  const childIds = result.children.map((child) => child.childId);
  const locators = result.artifacts.map((artifact) => artifact.locator);
  const document = delegatedTaskPresentation(result);
  const capabilities = resolvePresentationCapabilities({
    stdout: { isTTY: false },
    stderr: { isTTY: false },
    environment: { noColorPresent: true, forceColor: false, ci: true, termDumb: true },
    unicode: false,
  });
  const text = renderPresentation(document, capabilities).stdout.trimEnd();
  return {
    taskId: result.taskId,
    fulfillment: result.fulfillment,
    stopReason: result.stopReason,
    unmetRequirementIds: result.unmetRequirementIds,
    checkState: result.checkState,
    childIds,
    locators,
    usage: result.usage,
    nextAction: result.nextAction,
    text,
  };
}

export function formatDelegatedTaskResultJson(result: DelegatedTaskResultV1): string {
  return canonicalJson(result);
}

export function delegatedTaskResultProjectionIdentity(result: DelegatedTaskResultV1): string {
  return canonicalDigest({
    taskId: result.taskId,
    fulfillment: result.fulfillment,
    stopReason: result.stopReason,
    unmetRequirementIds: result.unmetRequirementIds,
    checkState: result.checkState,
    childIds: result.children.map((child) => child.childId),
    locators: result.artifacts.map((artifact) => artifact.locator),
    usage: result.usage,
    nextAction: result.nextAction,
  });
}
