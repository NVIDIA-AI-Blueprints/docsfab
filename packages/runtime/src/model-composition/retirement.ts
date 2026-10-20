// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { ModelCompositionError, type InstalledExecutionComposition } from "./types.js";

/**
 * Refuse a retired record for any NEW selection: a Pi run, a native preflight,
 * a native pilot, or a host slot. The record stays installed so completed run
 * records keep rebinding to its exact digests. The message names the reason
 * and instant, and the remediation names the declared successor, so an
 * operator reading a failed job does not have to open the registry to learn
 * where to go.
 */
export function assertCompositionNotRetired(
  composition: Pick<InstalledExecutionComposition, "compositionId" | "status" | "retirement">,
): void {
  if (composition.status !== "retired") return;
  const retirement = composition.retirement;
  const successor = retirement?.successorCompositionId;
  // hygiene: envelope
  throw new ModelCompositionError(
    "composition-retired",
    `Composition "${composition.compositionId}" is retired (${retirement?.reason ?? "retired"}, effective ${retirement?.effectiveAt ?? "at an unrecorded instant"}) and cannot be selected for a new execution.`,
    successor
      ? `Select its successor, \`${successor}\`; the retired record is retained only so completed run records keep rebinding to it.`
      : "Select a composition whose status is active in `docsfab composition list`; the retired record is retained only so completed run records keep rebinding to it.",
  );
}
