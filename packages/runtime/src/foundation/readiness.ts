// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Foundation inspection readiness vocabulary and product mapping.
 *
 * Consumes the closed golden-evaluator readiness set without inventing claim or
 * authority schemas. Product disposition stays inside existing ProductDisposition.
 */

import type { ProductDisposition } from "../workflow-contracts/contracts.js";

/** Closed readiness outcomes from the Foundation Canon golden evaluator. */
export const FOUNDATION_INSPECT_READINESS = [
  "ready",
  "needs-input",
  "conflict",
  "stale",
  "invalid",
] as const;

export type FoundationInspectReadiness = (typeof FOUNDATION_INSPECT_READINESS)[number];

/**
 * Critical gaps that must be resolved before drafting. Questions are fixed
 * labels (never host paths or credentials).
 */
export const FOUNDATION_CRITICAL_QUESTIONS = Object.freeze([
  "What authoritative source binds product truth for the current revision?",
  "Who owns documentation accuracy for the current version series?",
  "What support channel is authoritative for end users?",
  "What audience and output scope apply to derived documentation?",
  "Which version series is currently in force?",
] as const);

/** Map foundation readiness into the closed operator ProductDisposition set. */
export function foundationReadinessToProductDisposition(
  readiness: FoundationInspectReadiness,
): ProductDisposition {
  switch (readiness) {
    case "ready":
      return "ready";
    case "needs-input":
      return "needs-input";
    case "conflict":
    case "stale":
      return "not-ready";
    case "invalid":
      return "blocked";
  }
}

/** Runner step outcome for the host-operation path. */
export function foundationReadinessToStepOutcome(
  readiness: FoundationInspectReadiness,
): "succeeded" | "needs-input" {
  return readiness === "needs-input" ? "needs-input" : "succeeded";
}
