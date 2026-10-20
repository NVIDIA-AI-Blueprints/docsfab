// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The one reader of a run's CREATE-to-UPDATE conversion for every
 * operator surface: the run summary, the run result, the run index, and
 * `docsfab why`. It admits the conversion only from the planner step's sealed
 * plan binding, through the binding validator every other reader uses.
 */

import type { RunRecord } from "../records/contracts.js";
import {
  validateAdmittedDocumentationPlanBinding,
  type DocumentationPlanCreateConversionV1,
} from "../workflow-execution/plan-binding.js";

const PLANNER_STEP_ID = "plan-documentation";

/** The conversion the run's admitted CREATE plan records, or `undefined`. */
export function admittedCreateConversion(
  record: Readonly<Pick<RunRecord, "workflow" | "steps">>,
): DocumentationPlanCreateConversionV1 | undefined {
  if (record.workflow !== "create-documentation" || !Array.isArray(record.steps)) return undefined;
  const planner = record.steps.find((step) => step?.id === PLANNER_STEP_ID);
  if (!planner?.planBinding) return undefined;
  try {
    return validateAdmittedDocumentationPlanBinding(planner.planBinding, { expectedMode: "create" })
      .createConvertedToUpdate;
  } catch {
    // An unreadable binding records no admitted conversion.
    return undefined;
  }
}

/** The operator-facing note for a converted page, after its patch row. */
export function createConversionPatchNote(
  conversion: Pick<DocumentationPlanCreateConversionV1, "path" | "reason">,
): string {
  return conversion.reason === "planner-proposed-update"
    ? `(CREATE converted to UPDATE as the planner proposed: ${conversion.path} existed at the run's revision)`
    : `(CREATE converted to UPDATE: ${conversion.path} existed at the run's revision)`;
}
