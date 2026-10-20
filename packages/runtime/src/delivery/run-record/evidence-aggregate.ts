// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { StepRunRecord, TokenUsage, ToolActivitySummary } from "../../records/contracts.js";
import { canonical, expect } from "./contract.js";

export function sumUsage(steps: StepRunRecord[]): TokenUsage {
  return sumUsageValues(steps.flatMap((step) => (step.usage ? [step.usage] : [])));
}

export function sumAttemptUsage(
  attempts: NonNullable<StepRunRecord["inference"]>["attempts"],
): TokenUsage {
  expect(attempts.every((attempt) => attempt.usage !== undefined));
  return sumUsageValues(attempts.map((attempt) => attempt.usage!));
}

function sumUsageValues(values: TokenUsage[]): TokenUsage {
  const result = zeroUsage();
  let cost: number | undefined;
  for (const value of values) {
    result.input += value.input;
    result.output += value.output;
    result.cacheRead += value.cacheRead;
    result.cacheWrite += value.cacheWrite;
    result.total += value.total;
    result.turns += value.turns;
    if (value.cost !== undefined) cost = (cost ?? 0) + value.cost;
  }
  return { ...result, ...(cost === undefined ? {} : { cost: Number(cost.toFixed(12)) }) };
}

export function sumTools(steps: StepRunRecord[]): ToolActivitySummary {
  return sumToolValues(steps.flatMap((step) => (step.tools ? [step.tools] : [])));
}

export function sumToolValues(values: ToolActivitySummary[]): ToolActivitySummary {
  const tools = new Map<string, { calls: number; failures: number }>();
  const categories = new Map<string, number>();
  let totalCalls = 0;
  let failedCalls = 0;
  let preExecutionRejections = 0;
  let categoriesPresent = false;
  for (const value of values) {
    totalCalls += value.totalCalls;
    failedCalls += value.failedCalls;
    preExecutionRejections += value.preExecutionRejections?.count ?? 0;
    for (const entry of value.byTool) {
      const sum = tools.get(entry.name) ?? { calls: 0, failures: 0 };
      sum.calls += entry.calls;
      sum.failures += entry.failures;
      tools.set(entry.name, sum);
    }
    if (value.failureCategories !== undefined) {
      categoriesPresent = true;
      for (const entry of value.failureCategories)
        categories.set(entry.category, (categories.get(entry.category) ?? 0) + entry.count);
    }
  }
  return {
    totalCalls,
    failedCalls,
    ...(preExecutionRejections > 0
      ? {
          preExecutionRejections: {
            schemaVersion: 1,
            kind: "tool-pre-execution-rejections",
            count: preExecutionRejections,
          } as const,
        }
      : {}),
    byTool: [...tools]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, counts]) => ({ name, ...counts })),
    ...(categoriesPresent
      ? {
          failureCategories: [...categories]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([category, count]) => ({ category: category as never, count })),
        }
      : {}),
  };
}

function zeroUsage(): TokenUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0 };
}

export function zeroTools(): ToolActivitySummary {
  return { totalCalls: 0, failedCalls: 0, byTool: [] };
}

export function canonicalTools(value: ToolActivitySummary): string {
  // Step counts must equal the sum of attempt counts. `presented` is the tool
  // set offered to the step, not a count, and `sumToolValues` never rebuilds it,
  // so it is excluded from both sides.
  const {
    presented: _presented,
    toolResultArchive: _archive,
    readEvidence: _readEvidence,
    historyReads: _historyReads,
    toolRefusals: _toolRefusals,
    toolArgumentFiller: _toolArgumentFiller,
    ...comparable
  } = value;
  // An empty legacy category list and an absent one are equivalent. Preserve
  // every other count while normalizing only that one optional field.
  const { failureCategories: _emptyCategories, ...withoutEmptyCategories } = comparable;
  const normalized =
    comparable.failureCategories?.length === 0 ? withoutEmptyCategories : comparable;
  return canonical(normalized);
}

export function uniqueValues<T>(values: Array<T | undefined>): T[] {
  const result: T[] = [];
  for (const value of values)
    if (value !== undefined && !result.some((entry) => canonical(entry) === canonical(value)))
      result.push(value);
  return result;
}

export function unique(values: unknown[]): boolean {
  return new Set(values.map(canonical)).size === values.length;
}
