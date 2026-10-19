// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Planner response summary capacity, at the limit and at the limit plus one.
 *
 * The bound is `runtime.planner.summaryMaxChars` in `config/limits.yaml`; the
 * harness reads it from the generated catalog instead of carrying its own
 * literal. Both cases run the real `PiHarness` step against a scripted
 * provider, so the guard is reached through the shipped planner path rather
 * than a helper.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, it, vi } from "vitest";

import { limitDefinition } from "../src/config/limits.js";
import { PiHarness } from "../src/harness/pi.js";
import { createModelConnection } from "../src/model/provider.js";
import { documentationPlanBindingDigest } from "../src/workflow-execution/plan-binding.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import { validModelConfig } from "./helpers.js";
import { scriptedProvider, textTurn } from "./support/execution-convergence.js";
import { nestedDeadlineMs } from "./helpers/test-timeouts.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skillCrateDirectory = resolve(projectRoot, "skill-crate");
const temporaryDirectories: string[] = [];

afterAll(async () => {
  for (const directory of temporaryDirectories)
    await rm(directory, { recursive: true, force: true });
});

function planBinding() {
  const mode = "create" as const;
  const pages = [{ path: "docs/getting-started.md", disposition: mode }];
  const sourceBindings = [{ pagePath: "docs/getting-started.md", sources: ["README.md"] }];
  return {
    kind: "docsfab-documentation-plan" as const,
    schemaVersion: 1 as const,
    mode,
    pages,
    sourceBindings,
    digest: documentationPlanBindingDigest({ mode, pages, sourceBindings }),
  };
}

it.each(["at-capacity", "one-past-capacity"] as const)(
  "admits a planner summary at runtime.planner.summaryMaxChars and refuses one character past it: %s",
  async (position) => {
    const max = limitDefinition("runtime.planner.summaryMaxChars").max;
    const length = position === "at-capacity" ? max : max + 1;
    const repositoryPath = await mkdtemp(resolve(tmpdir(), "docsfab-planner-summary-"));
    temporaryDirectories.push(repositoryPath);
    await writeFile(resolve(repositoryPath, "README.md"), "# Fixture\n");
    const response = JSON.stringify({ summary: "s".repeat(length), planBinding: planBinding() });
    vi.stubGlobal("fetch", scriptedProvider([textTurn(response), textTurn(response)]));
    try {
      const harness = new PiHarness({
        skillCrateDirectory,
        model: validModelConfig,
        createConnection: createModelConnection,
      });
      const workflow = getWorkflow("create-documentation");
      const run = harness.runStep({
        runId: "planner-summary-capacity",
        repositoryPath,
        workflow,
        step: workflow.steps.find((step) => step.id === "plan-documentation")!,
        evidenceIdentity: { repositoryRevision: "a".repeat(40) },
      });
      if (position === "one-past-capacity") {
        // Names the exact message the planner envelope check throws.
        await expect(run).rejects.toThrow(
          "Planner response summary must be non-empty bounded text.",
        );
      } else {
        // Positive control: the same response one character shorter passes the
        // summary guard and the step returns the planner's own binding.
        const result = await run;
        expect(result.summary).toHaveLength(max);
        expect(result.planBinding).toMatchObject({ mode: "create" });
      }
    } finally {
      vi.unstubAllGlobals();
    }
  },
  nestedDeadlineMs(120_000, 240_000),
);
