// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { TokenUsage, ToolActivitySummary } from "../../records/contracts.js";
import {
  decodeTools,
  decodeHistoryReads,
  decodeToolArgumentFiller,
  decodeToolRefusals,
} from "../../execution/inference-evidence.js";
import { object, exact, fail } from "./value-kit.js";

export function emptyUsage(value: TokenUsage): boolean {
  return (
    value.input === 0 &&
    value.output === 0 &&
    value.cacheRead === 0 &&
    value.cacheWrite === 0 &&
    value.total === 0 &&
    value.turns === 0 &&
    value.cost === undefined
  );
}

export function emptyTools(value: ToolActivitySummary): boolean {
  return (
    value.totalCalls === 0 &&
    value.failedCalls === 0 &&
    value.byTool.length === 0 &&
    value.preExecutionRejections === undefined &&
    (value.failureCategories === undefined || value.failureCategories.length === 0)
  );
}

export function parseUsage(value: unknown): TokenUsage {
  const root = object(value, "live-usage");
  exact(
    root,
    ["input", "output", "cacheRead", "cacheWrite", "total", "turns", "cost"],
    ["input", "output", "cacheRead", "cacheWrite", "total", "turns"],
  );
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "total", "turns"] as const) {
    if (!Number.isSafeInteger(root[key]) || Number(root[key]) < 0) fail("live-usage");
  }
  if (
    root.total !==
    Number(root.input) + Number(root.output) + Number(root.cacheRead) + Number(root.cacheWrite)
  )
    fail("live-usage");
  if (
    root.cost !== undefined &&
    (typeof root.cost !== "number" || !Number.isFinite(root.cost) || root.cost < 0)
  )
    fail("live-usage");
  return structuredClone(value) as TokenUsage;
}

/** Tool summary without the per-step `presented` set, for run-vs-step equality. */
export function comparableTools(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  const {
    presented: _presented,
    toolResultArchive: _archive,
    readEvidence: _readEvidence,
    historyReads: _historyReads,
    toolRefusals: _toolRefusals,
    toolArgumentFiller: _toolArgumentFiller,
    ...rest
  } = value as Record<string, unknown>;
  return rest;
}

export function toolNames(value: unknown): string[] {
  const root = object(value, "live-tools");
  exact(
    root,
    [
      "totalCalls",
      "failedCalls",
      "byTool",
      "failureCategories",
      "preExecutionRejections",
      "presented",
      "toolResultArchive",
      "readEvidence",
      "historyReads",
      "toolRefusals",
      "toolArgumentFiller",
    ],
    ["totalCalls", "failedCalls", "byTool"],
  );
  if (
    !Number.isSafeInteger(root.totalCalls) ||
    Number(root.totalCalls) < 0 ||
    root.failedCalls !== 0 ||
    !Array.isArray(root.byTool)
  )
    fail("live-tools");
  if (root.preExecutionRejections !== undefined) {
    try {
      decodeTools(value);
    } catch {
      fail("live-tools");
    }
  }
  const summary = structuredClone(value) as ToolActivitySummary;
  const names = summary.byTool.flatMap((item) => {
    const entry = object(item, "live-tool-entry");
    exact(entry, ["name", "calls", "failures"]);
    if (
      typeof item.name !== "string" ||
      !item.name ||
      !Number.isSafeInteger(item.calls) ||
      item.calls < 0 ||
      item.failures !== 0
    )
      fail("live-tools");
    return Array.from({ length: item.calls }, () => item.name);
  });
  if (
    names.length !== summary.totalCalls ||
    new Set(summary.byTool.map((item) => item.name)).size !== summary.byTool.length
  )
    fail("live-tools");
  if (summary.failureCategories !== undefined) {
    if (!Array.isArray(summary.failureCategories) || summary.failureCategories.length !== 0) {
      fail("live-tools");
    }
  }
  // An admitted key must be validated, or this drift guard has a hole. Mirrors
  // `decodePresentedTools`, including sortedness: the harness writes it sorted,
  // so an unsorted list did not come from that harness.
  if (summary.presented !== undefined) {
    const presented = summary.presented;
    if (!Array.isArray(presented)) fail("live-tools");
    const seen = new Set<string>();
    for (const entry of presented) {
      if (typeof entry !== "string" || !entry || seen.has(entry)) fail("live-tools");
      seen.add(entry);
    }
    if (JSON.stringify(presented) !== JSON.stringify([...presented].sort())) fail("live-tools");
    // A model cannot call a tool it was not offered.
    if (summary.byTool.some((item) => !seen.has(item.name))) fail("live-tools");
  }
  if (summary.toolResultArchive !== undefined) {
    const archive = summary.toolResultArchive as unknown as Record<string, unknown>;
    exact(archive, ["receipts", "storedBytes", "ceilingBytes", "refusals"]);
    if (
      !Array.isArray(archive.receipts) ||
      !Array.isArray(archive.refusals) ||
      !Number.isSafeInteger(archive.storedBytes) ||
      Number(archive.storedBytes) < 0 ||
      !Number.isSafeInteger(archive.ceilingBytes) ||
      Number(archive.ceilingBytes) < 0
    ) {
      fail("live-tools");
    }
  }
  if (summary.readEvidence !== undefined) {
    const counters = summary.readEvidence as unknown as Record<string, unknown>;
    exact(
      counters,
      [
        "unchangedReReads",
        "withheld",
        "maxRepeatsOfOneResult",
        "maxUnchangedReReadsAcrossResults",
        "deniedAfterAsk",
      ],
      // Records written before the cross-result bound lack its peak.
      ["unchangedReReads", "withheld", "maxRepeatsOfOneResult"],
    );
    const {
      unchangedReReads,
      withheld,
      maxRepeatsOfOneResult,
      maxUnchangedReReadsAcrossResults: acrossResults,
      deniedAfterAsk,
    } = counters;
    // Denied calls never executed: they are bounded by the governance stops.
    const governanceStops =
      summary.failureCategories?.find((entry) => entry.category === "governance-stop")?.count ?? 0;
    const denied = deniedAfterAsk === undefined ? 0 : Number(deniedAfterAsk);
    if (
      !Number.isSafeInteger(unchangedReReads) ||
      !Number.isSafeInteger(withheld) ||
      !Number.isSafeInteger(maxRepeatsOfOneResult) ||
      (deniedAfterAsk !== undefined && (!Number.isSafeInteger(deniedAfterAsk) || denied < 1)) ||
      denied > governanceStops ||
      (Number(unchangedReReads) < 1 && denied === 0) ||
      Number(unchangedReReads) < 0 ||
      Number(unchangedReReads) > summary.totalCalls ||
      Number(withheld) < 0 ||
      Number(withheld) > Number(unchangedReReads) ||
      (Number(unchangedReReads) === 0
        ? Number(maxRepeatsOfOneResult) !== 0
        : Number(maxRepeatsOfOneResult) < 1) ||
      Number(maxRepeatsOfOneResult) > Number(unchangedReReads) ||
      (acrossResults !== undefined &&
        (!Number.isSafeInteger(acrossResults) ||
          Number(acrossResults) < Number(maxRepeatsOfOneResult) ||
          Number(acrossResults) > Number(unchangedReReads)))
    ) {
      fail("live-tools");
    }
  }
  // An admitted key is validated by the shipped decoder, which also bounds the
  // entries by the history calls that did not fail (none here).
  if (summary.historyReads !== undefined) {
    try {
      decodeHistoryReads(summary.historyReads, summary.byTool);
    } catch {
      fail("live-tools");
    }
  }
  if (summary.toolRefusals !== undefined) {
    try {
      decodeToolRefusals(summary.toolRefusals, summary.byTool);
    } catch {
      fail("live-tools");
    }
  }
  if (summary.toolArgumentFiller !== undefined) {
    try {
      decodeToolArgumentFiller(summary.toolArgumentFiller, summary.byTool);
    } catch {
      fail("live-tools");
    }
  }
  return names;
}
