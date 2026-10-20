// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  DERIVED_BASELINE_KIND,
  deriveStudyBaseline,
  serializeDerivedBaseline,
  type DerivedBaseline,
} from "./derive.js";
import { internalOnly } from "../../test/helpers/internal-path.js";

const here = dirname(fileURLToPath(import.meta.url));
const committedEvidence = internalOnly(
  "packages/runtime/docs/internal/evidence/study-derived-baseline/export.json",
  "it pins the internal evidence export, which is not exported",
);

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(here, "fixtures", name), "utf8")) as unknown;
}

const POISON_MARKERS = [
  "POISON_PROMPT_DO_NOT_EXPORT",
  "POISON_CREDENTIAL_DO_NOT_EXPORT",
  "POISON_MODEL_SUMMARY_DO_NOT_EXPORT",
  "POISON_STEP_SUMMARY_DO_NOT_EXPORT",
  "POISON_TOOL_ARGS_DO_NOT_EXPORT",
  "POISON_TOOL_RESULT_DO_NOT_EXPORT",
  "POISON_NESTED_ARGS_DO_NOT_EXPORT",
  "POISON_NESTED_RESULT_DO_NOT_EXPORT",
  "POISON_TURN_PROMPT_DO_NOT_EXPORT",
];

function collectKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const entry of value) collectKeys(entry, keys);
    return keys;
  }
  if (typeof value !== "object" || value === null) return keys;
  for (const [key, child] of Object.entries(value)) {
    keys.add(key);
    collectKeys(child, keys);
  }
  return keys;
}

describe("study-derived-baseline", () => {
  it("projects step order, byTool, turn tool-call counts, consulted nodes, and search dispositions", () => {
    const baseline = deriveStudyBaseline(loadFixture("shareable-run-record-projection.json"));
    expect(baseline.kind).toBe(DERIVED_BASELINE_KIND);
    expect(baseline.notStudyEventV1).toBe(true);
    expect(baseline.steps.map((step) => step.stepId)).toEqual([
      "plan-documentation",
      "write-documentation",
      "lint-documentation",
      "verify-technical-accuracy",
      "peer-review-documentation",
      "evaluate-document-quality",
    ]);
    expect(baseline.steps.map((step) => step.order)).toEqual([1, 2, 3, 4, 5, 6]);

    const plan = baseline.steps[0];
    expect(plan?.toolsByTool).toEqual([{ name: "read", calls: 1, failures: 0 }]);
    expect(plan?.inferenceTurnToolCalls).toEqual([
      { attempt: 1, turn: 1, toolCalls: 1 },
      { attempt: 1, turn: 2, toolCalls: 0 },
    ]);
    expect(plan?.consultedNodeIds).toEqual(["node-a", "node-b"]);
    expect(plan?.searchDispositions).toEqual([
      {
        source: "searchFindings",
        disposition: "found",
        targetId: "documentation-nav-graph",
      },
      {
        source: "searchEvidence",
        disposition: "found",
        targetId: "documentation-nav-graph",
      },
    ]);

    const write = baseline.steps[1];
    expect(write?.toolsByTool).toEqual([
      { name: "read", calls: 3, failures: 0 },
      { name: "write", calls: 1, failures: 0 },
    ]);
    expect(write?.inferenceTurnToolCalls?.map((row) => row.toolCalls)).toEqual([2, 1, 1, 0]);
    expect(write?.consultedNodeIds).toEqual(["node-a"]);
    expect(write?.searchDispositions).toBeNull();

    expect(baseline.presentToday).toEqual({
      stepOrder: true,
      stepToolsByTool: true,
      inferenceTurnToolCallCounts: true,
      consultedNodeIds: true,
      searchDispositions: true,
    });
  });

  it("lists per-read target and scheduled as gaps and does not invent them", () => {
    const baseline = deriveStudyBaseline(loadFixture("shareable-run-record-projection.json"));
    expect(baseline.gaps.map((gap) => gap.field)).toEqual(["per-read-target", "scheduled"]);
    for (const gap of baseline.gaps) {
      expect(gap.present).toBe(false);
    }
    for (const step of baseline.steps) {
      expect(step).not.toHaveProperty("targetNodeId");
      expect(step).not.toHaveProperty("pathClass");
      expect(step).not.toHaveProperty("scheduled");
    }
    expect(baseline).not.toHaveProperty("scheduled");
    expect(JSON.stringify(baseline)).not.toMatch(/"scheduled"\s*:\s*true/);
  });

  it("does not treat retryScheduled as the study scheduled flag", () => {
    const baseline = deriveStudyBaseline(loadFixture("payload-poisoned.json"));
    const scheduled = baseline.gaps.find((gap) => gap.field === "scheduled");
    expect(scheduled?.present).toBe(false);
    expect(scheduled?.note).toContain("retryScheduled");
    expect(collectKeys(baseline).has("retryScheduled")).toBe(false);
    expect(collectKeys(baseline).has("scheduled")).toBe(false);
  });

  it("from a checked-in create→MR receipt, only step order is present", () => {
    const baseline = deriveStudyBaseline(loadFixture("create-mr-class-receipt.json"));
    expect(baseline.presentToday).toEqual({
      stepOrder: true,
      stepToolsByTool: false,
      inferenceTurnToolCallCounts: false,
      consultedNodeIds: false,
      searchDispositions: false,
    });
    expect(baseline.gaps).toHaveLength(2);
    for (const step of baseline.steps) {
      expect(step.toolsByTool).toBeNull();
      expect(step.inferenceTurnToolCalls).toBeNull();
      expect(step.consultedNodeIds).toBeNull();
      expect(step.searchDispositions).toBeNull();
    }
  });

  it("strips prompt text, tool arguments/results, and credentials from the export", () => {
    const baseline = deriveStudyBaseline(loadFixture("payload-poisoned.json"));
    const serialized = serializeDerivedBaseline(baseline);
    for (const marker of POISON_MARKERS) {
      expect(serialized, `export leaked ${marker}`).not.toContain(marker);
    }
    expect(baseline.steps[0]?.toolsByTool).toEqual([{ name: "read", calls: 1, failures: 0 }]);
    expect(baseline.kind).not.toBe("StudyEventV1");
    const keys = collectKeys(baseline);
    expect(keys.has("instruction")).toBe(false);
    expect(keys.has("apiKey")).toBe(false);
    expect(keys.has("arguments")).toBe(false);
    expect(keys.has("result")).toBe(false);
    expect(keys.has("prompt")).toBe(false);
  });

  it.skipIf(committedEvidence.skip)(
    committedEvidence.title("matches the committed evidence export for the shareable fixture"),
    () => {
      const baseline = deriveStudyBaseline(loadFixture("shareable-run-record-projection.json"));
      const committed = readFileSync(
        join(here, "../../docs/internal/evidence/study-derived-baseline/export.json"),
        "utf8",
      );
      expect(serializeDerivedBaseline(baseline)).toBe(committed);
    },
  );

  it("matches the pinned copy of the evidence export for the shareable fixture", () => {
    const baseline = deriveStudyBaseline(loadFixture("shareable-run-record-projection.json"));
    const pinned = readFileSync(
      join(here, "../../test/fixtures/public-export/study-derived-baseline-export.json"),
      "utf8",
    );
    // The copy is repository-formatted, so it is compared after the export's
    // own serialization, which still fixes key order and every value.
    expect(serializeDerivedBaseline(baseline)).toBe(
      `${JSON.stringify(JSON.parse(pinned), null, 2)}\n`,
    );
  });

  it("rejects non-objects", () => {
    expect(() => deriveStudyBaseline(null)).toThrow(/RunRecord-shaped/);
    expect(() => deriveStudyBaseline({ id: "x" })).toThrow(/steps\[\]/);
  });
});

describe("study-derived-baseline allowlist", () => {
  it("refuses extra keys if they appear on the derived object", () => {
    const baseline = deriveStudyBaseline(loadFixture("shareable-run-record-projection.json"));
    const poisoned = { ...baseline, instruction: "nope" } as DerivedBaseline & {
      instruction: string;
    };
    expect(() => serializeDerivedBaseline(poisoned)).toThrow(/forbidden export key/);
  });
});
