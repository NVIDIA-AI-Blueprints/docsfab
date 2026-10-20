// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { catalogSkillToolsForStep } from "../src/skills/catalog-crate-selection.js";
import { grantedToolsForStep, skillPolicyTools } from "../src/harness/pi-tool-confine.js";
import type { WorkflowStep } from "../src/workflow-contracts/contracts.js";

describe("native operation guidance tools", () => {
  const step: WorkflowStep = {
    id: "apply-site",
    title: "Apply approved site plan",
    skill: "template-scaffold-site",
    kind: "host-operation",
    operation: "site-bootstrap",
    mode: "write",
    prompt: "Apply the exact signed plan.",
  };
  it("does not grant model editing merely because the separately authorized native executor writes", () => {
    expect(catalogSkillToolsForStep(step)).toEqual(["read", "grep", "find", "ls"]);
    expect(skillPolicyTools(step.mode, step.kind)).toEqual(catalogSkillToolsForStep(step));
    expect(grantedToolsForStep({ name: "site-bootstrap" }, step)).not.toContain("write");
    expect(grantedToolsForStep({ name: "site-bootstrap" }, step)).not.toContain("edit");
    expect(step.mode).toBe("write");
  });
  it("preserves authoring model tools for an actual inference write step", () => {
    expect(
      catalogSkillToolsForStep({ ...step, kind: "inference", skill: "write-documentation" }),
    ).toContain("write");
    expect(
      catalogSkillToolsForStep({ ...step, kind: "inference", mode: "read-only" }),
    ).not.toContain("write");
    // `kind === "inference"` with `mode === "write"` is not captured by the
    // `host-operation` clause, so write tools are granted there; a read-only
    // default would fail this.
    const inference = { ...step, kind: "inference" as const, skill: "write-documentation" };
    expect(skillPolicyTools(inference.mode, inference.kind)).toContain("write");
    expect(grantedToolsForStep({ name: "foundation-to-patch" }, inference)).toContain("write");
    expect(grantedToolsForStep({ name: "foundation-to-patch" }, inference)).toContain("edit");
  });
  it("keeps an evaluate step read-only, so the native clause is not what carries it", () => {
    // The evaluate clause keeps this step read-only on its own, separately from
    // the `host-operation` clause.
    const evaluate = { ...step, kind: "evaluate" as const };
    expect(skillPolicyTools(evaluate.mode, evaluate.kind)).not.toContain("write");
    expect(grantedToolsForStep({ name: "review-documentation" }, evaluate)).not.toContain("write");
  });
});
