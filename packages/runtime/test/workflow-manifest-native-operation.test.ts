// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { parseWorkflowManifestSnapshot } from "../src/workflow-registry/manifest.js";
import { documentationAuditSearch } from "../src/maturity/audit-search-plan.js";
import { documentationObservationSearch } from "../src/search/observation-search-plan.js";

const searchPlans = {
  "documentation-audit": documentationAuditSearch,
  "documentation-observation": documentationObservationSearch,
};
const base = {
  schemaVersion: 1,
  name: "live-agent-turn",
  title: "Manifest grammar fixture",
  outcome: "Fixture only; does not install an executor",
  contextPolicy: {
    schemaVersion: 1,
    steps: [
      {
        stepId: "selected-step",
        required: true,
        level: "corpus",
        query: "expand",
        allowReadOnlyDegraded: true,
      },
    ],
  },
  steps: [
    {
      id: "selected-step",
      title: "Selected native operation",
      kind: "host-operation",
      skill: "review-documentation",
      mode: "read-only",
      prompt: "Fixture guidance",
    },
  ],
};

describe("manifest native operation field", () => {
  it("preserves each existing native operation identity into the executable step definition", () => {
    for (const operation of ["foundation", "foundation-to-patch", "ia-plan", "site-bootstrap"]) {
      const manifest = { ...base, steps: [{ ...base.steps[0], operation }] };
      expect(
        parseWorkflowManifestSnapshot(manifest, "live-agent-turn", searchPlans).steps[0]!.operation,
      ).toBe(operation);
    }
  });
  it("admits only the installed CREATE dependency for a native Foundation composition", () => {
    const step = {
      ...base.steps[0],
      operation: "foundation-to-patch",
      invokes: "create-documentation",
    };
    expect(
      parseWorkflowManifestSnapshot({ ...base, steps: [step] }, "live-agent-turn", searchPlans)
        .steps[0]!.invokes,
    ).toBe("create-documentation");
    // Adjacent conditions, each named by the message it must reach. The first
    // three each break one conjunct of the `invokes` guard; the fourth keeps a
    // valid `invokes` but moves the step off `host-operation` with an operation,
    // which the earlier operation guard catches first, proving the two refusals
    // are distinct checks.
    for (const [change, message] of [
      [{ invokes: "update-documentation" }, "does not name the implemented native composition"],
      [{ operation: "foundation" }, "does not name the implemented native composition"],
      [
        { kind: "inference", operation: undefined },
        "does not name the implemented native composition",
      ],
      [
        { kind: "inference" },
        "must name a supported native host operation on a host-operation step",
      ],
    ] as const) {
      expect(() =>
        parseWorkflowManifestSnapshot(
          { ...base, steps: [{ ...step, ...change }] },
          "live-agent-turn",
          searchPlans,
        ),
      ).toThrow(message);
    }
  });
  it("preserves existing host-check manifests without an operation field", () => {
    expect(
      parseWorkflowManifestSnapshot(base, "live-agent-turn", searchPlans).steps[0],
    ).not.toHaveProperty("operation");
  });
  it("refuses model-selected operations and unknown native executor names", () => {
    // Both halves of the same condition: an operation on a step the model
    // drives, and an operation naming an executor this release never installs.
    for (const change of [
      { kind: "inference", operation: "foundation" },
      { operation: "shell-command" },
    ]) {
      expect(() =>
        parseWorkflowManifestSnapshot(
          { ...base, steps: [{ ...base.steps[0], ...change }] },
          "live-agent-turn",
          searchPlans,
        ),
      ).toThrow(
        "workflows/live-agent-turn.json.steps[0].operation must name a supported native host operation on a host-operation step.",
      );
    }
  });

  it("keeps an inference step without an operation admissible", () => {
    // Adjacent condition the refusal above must not handle: the same model-driven
    // step kind, with no `operation` field at all, still parses.
    const parsed = parseWorkflowManifestSnapshot(
      { ...base, steps: [{ ...base.steps[0], kind: "inference" }] },
      "live-agent-turn",
      searchPlans,
    );
    expect(parsed.steps[0]?.kind).toBe("inference");
    expect(parsed.steps[0]).not.toHaveProperty("operation");
  });
});
