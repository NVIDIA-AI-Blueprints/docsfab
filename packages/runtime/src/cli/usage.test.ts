// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { HOSTED_WORKFLOW_NAMES, PUBLIC_WORKFLOW_NAMES } from "../workflow-registry/manifest.js";
import { generalHelp, runHelp, usage } from "./usage.js";

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

describe("runHelp", () => {
  it("lists exactly the public workflow registry in its runnable workflow section", () => {
    const help = runHelp();
    const section = help.split("Workflows:\n")[1]?.split("\n\nSource-aware execution:")[0];
    expect(section).toBeDefined();
    const listed = [...section!.matchAll(/^  ([a-z][a-z-]+)\s{2,}\S/gmu)].map((match) => match[1]);
    expect(listed).toEqual([...PUBLIC_WORKFLOW_NAMES]);
    for (const hosted of HOSTED_WORKFLOW_NAMES) expect(listed).not.toContain(hosted);
    expect(section).toContain("bootstrap");
    expect(section).toContain("--allow-write");
    expect(section).toContain("release-documentation-readiness");
    expect(help.indexOf("Delivery choices for documentation writes:")).toBeLessThan(
      help.indexOf("Model settings:"),
    );
    expect(help.indexOf("Common invocations:")).toBeLessThan(
      help.indexOf("Delivery choices for documentation writes:"),
    );
  });

  it("keeps general and reference help aligned with the public catalog", () => {
    expect(generalHelp()).toContain("'docsfab' 'list'");
    expect(generalHelp()).not.toContain("four bound documentation workflows");
    expect(usage()).toContain("docsfab run bootstrap");
    expect(usage()).not.toMatch(/Parked[^\n]*bootstrap/u);
  });

  it("does not claim a clean checkout is required for the default draft-MR delivery", () => {
    const help = runHelp();

    expect(help.toLowerCase()).not.toContain("clean checkout");
    expect(help.toLowerCase()).not.toContain("checkout is clean");
  });

  it("states the actual default delivery conditions and tracked-local-changes behavior", () => {
    const help = normalizeWhitespace(runHelp());

    expect(help).toContain("an origin remote (or --remote <name>), authenticated glab");
    expect(help).toContain("permission to push and create a merge request");
    expect(help).toContain(
      "Tracked local changes stay in place; delivery writes from GitLab's target-branch revision.",
    );
  });
});
