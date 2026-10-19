// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The one reader of the pages an update run's admitted plan kept unchanged
 * (disposition `retain`) for the runtime's operator surfaces: the run result,
 * the human PATCH section, and the verified no-change NEXT. A plan may keep a
 * page the request named instead of writing it, so every kept page is
 * named beside the patch rather than left silent. It admits the pages only
 * from the planner step's sealed plan binding, through the binding validator
 * every other reader uses.
 */

import type { RunRecord } from "../records/contracts.js";
import { compareText } from "../shared/primitives.js";
import { validateAdmittedDocumentationPlanBinding } from "../workflow-execution/plan-binding.js";

const PLANNER_STEP_ID = "plan-documentation";

/** The sorted pages the run's admitted update plan kept unchanged; empty when none. */
export function admittedKeptUnchangedPages(
  record: Readonly<Pick<RunRecord, "workflow" | "steps">>,
): readonly string[] {
  if (record.workflow !== "update-documentation" || !Array.isArray(record.steps)) return [];
  const planner = record.steps.find((step) => step?.id === PLANNER_STEP_ID);
  if (!planner?.planBinding) return [];
  try {
    return validateAdmittedDocumentationPlanBinding(planner.planBinding, {
      expectedMode: "update",
    })
      .pages.filter((page) => page.disposition === "retain")
      .map((page) => page.path)
      .sort(compareText);
  } catch {
    // An unreadable binding records no admitted kept page.
    return [];
  }
}

/** The operator-facing PATCH line naming every kept page. */
export function keptUnchangedPatchLine(paths: readonly string[]): string {
  return `Kept unchanged: ${paths.join(", ")}`;
}
