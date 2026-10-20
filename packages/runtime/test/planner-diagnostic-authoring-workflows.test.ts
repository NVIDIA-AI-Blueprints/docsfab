// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The planner diagnostic admits exactly the authoring jobs: its workflow list
 * is the one `authoring-workflows.ts` declares, never a restated copy.
 */
import { describe, expect, it, vi } from "vitest";

import type { RunRecord } from "../src/records/contracts.js";
import { admitPlannerDiagnostic } from "../src/workflow-contracts/planner-diagnostic.js";

vi.mock("../src/workflow-contracts/authoring-workflows.js", () => ({
  AUTHORING_QUALITY_OUTCOME_WORKFLOWS: ["create-documentation", "relocate-documentation"],
}));

function stoppedPlannerRecord(workflow: string): RunRecord {
  return {
    workflow,
    status: "needs-input",
    steps: [
      {
        id: "plan-documentation",
        skill: "plan-documentation",
        kind: "evaluate",
        mode: "read-only",
        status: "needs-input",
        inference: { attempts: [{ outcome: "succeeded" }] },
        planDiagnostic: {
          schemaVersion: 1,
          kind: "docsfab-documentation-plan-diagnostic",
          code: "missing-information",
          responseShape: "json-object",
          responseSha256: "a".repeat(64),
        },
      },
    ],
  } as unknown as RunRecord;
}

describe("planner diagnostic workflows come from the authoring workflow list", () => {
  it("admits a workflow only that list adds and refuses one only that list drops", () => {
    expect(admitPlannerDiagnostic(stoppedPlannerRecord("relocate-documentation"))).toEqual({
      code: "missing-information",
      responseShape: "json-object",
      responseSha256: "a".repeat(64),
    });
    expect(admitPlannerDiagnostic(stoppedPlannerRecord("create-documentation"))).toBeDefined();
    expect(admitPlannerDiagnostic(stoppedPlannerRecord("update-documentation"))).toBeUndefined();
  });
});
