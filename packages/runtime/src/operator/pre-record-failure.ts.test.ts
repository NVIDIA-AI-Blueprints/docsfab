// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Compile-time proof that first-pass raise sites cannot name a rule the
 * operator classification table does not cover.
 *
 * This file sits under `src/`, so `npm run typecheck` checks it. Each
 * `@ts-expect-error` below fails that typecheck if the guarded line ever
 * compiles, which would mean an unclassified rule could be raised.
 */
import { describe, expect, it } from "vitest";
import {
  FIRST_PASS_MODEL_CALL_RULES,
  FirstPassSupportModelCallError,
} from "../cli/first-pass-support.js";
import { classifyFirstPassFailure, type FirstPassFailureRule } from "./pre-record-failure.js";

// @ts-expect-error A rule absent from the classification table is not a FirstPassFailureRule.
const unclassifiedRule: FirstPassFailureRule = "fake-new-rule";

function raiseUnclassified(): Error {
  // @ts-expect-error The model-call boundary cannot raise an unclassified rule.
  return new FirstPassSupportModelCallError("decomposition", "fake-new-rule", "$response");
}

// @ts-expect-error A raiser rule list that names an unclassified rule fails `satisfies`.
const unclassifiedList = ["fake-new-rule"] as const satisfies readonly FirstPassFailureRule[];

describe("first-pass raise-site rules", () => {
  it("classifies every rule the model-call boundary can raise", () => {
    for (const rule of FIRST_PASS_MODEL_CALL_RULES) {
      expect(classifyFirstPassFailure({ phase: "decomposition", rule })?.code).toBe(rule);
    }
  });

  it("refuses the rule the type-level cases reject", () => {
    expect(classifyFirstPassFailure({ phase: "decomposition", rule: unclassifiedRule })).toBe(
      undefined,
    );
    expect(unclassifiedList).toEqual(["fake-new-rule"]);
    expect(raiseUnclassified()).toBeInstanceOf(FirstPassSupportModelCallError);
  });
});
