// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { types as nodeUtilTypes } from "node:util";

import {
  planAutoRoadmapCycleV1,
  type AutoRoadmapPlanningResultV1,
  type PlanAutoRoadmapCycleInputV1,
} from "./roadmap-planning.js";
import { AutoRoadmapError } from "./roadmap.js";

/**
 * Read-only seam for `docsfab auto --dry-run`. It accepts no write adapter or
 * authorization, so it has no tracker mutation path.
 */
export interface AutoRoadmapDryRunRequestV1 {
  mode: "dry-run";
  planningInput: PlanAutoRoadmapCycleInputV1;
}

export async function runAutoRoadmapDryRunV1(
  input: AutoRoadmapDryRunRequestV1,
): Promise<AutoRoadmapPlanningResultV1> {
  exactPlainObject(input, ["mode", "planningInput"]);
  if (input.mode !== "dry-run") throw new AutoRoadmapError("invalid-plan");
  exactPlainObject(input.planningInput, [
    "request",
    "assessment",
    "decision",
    "maturityAssessment",
    "maturityTrackerObservation",
    "maturitySelection",
    "policyWorkspace",
    "repository",
    "project",
    "managedTrackerObservation",
    "operationCap",
  ]);
  return planAutoRoadmapCycleV1(input.planningInput);
}

function exactPlainObject(
  value: unknown,
  keys: readonly string[],
): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    nodeUtilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new AutoRoadmapError("invalid-plan");
  const actual = Reflect.ownKeys(value);
  if (
    actual.length !== keys.length ||
    actual.some((key) => typeof key !== "string" || !keys.includes(key))
  ) {
    throw new AutoRoadmapError("invalid-plan");
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) {
      throw new AutoRoadmapError("invalid-plan");
    }
  }
}
