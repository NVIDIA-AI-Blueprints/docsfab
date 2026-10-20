// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildDocsFabStepPrompt,
  createReaderTaskContextSupplier,
  editorialTechnicalStepInput,
  getWorkflow,
  projectRoot,
  resetSharedTestState,
  skillCrateDirectory,
  verifyQualityPackContext,
} from "./support/pi-harness-session-fixtures.js";

afterEach(resetSharedTestState);

describe("Pi reader task context prompt", () => {
  it("uses the verified shared input projection and replaces the legacy planner envelope", async () => {
    const supplier = await createReaderTaskContextSupplier(
      await verifyQualityPackContext({
        qualityPackDirectory: resolve(projectRoot, "quality-pack"),
        qualityDirectory: resolve(projectRoot, "quality"),
        skillCrateDirectory,
      }),
    );
    const projection = supplier.projectInput({
      schema_version: 1,
      target_audience: "operators",
      reader_job: "run an inspection",
      change_scope: ["docs/cli.md"],
      source_priority: ["public CLI", "current docs"],
      required_content: ["command", "verification"],
      excluded_content: [],
      unresolved_questions: [],
    });
    const workflow = getWorkflow("update-documentation");
    const prompt = buildDocsFabStepPrompt(
      {
        repositoryPath: "/tmp/repository",
        workflow,
        step: workflow.steps.find((step) => step.id === "plan-documentation")!,
      },
      "",
      projection,
      'Reader planner response contract: {"summary":"...","planBinding":{},"editorialDecisionProposal":{}}',
    );
    expect(prompt).toContain("# Reader Impact Baseline");
    expect(prompt).toContain('"reader_job":"run an inspection"');
    expect(prompt).toContain("editorialDecisionProposal");
    expect(prompt).not.toContain("Completed plan:");
    expect(prompt).not.toContain('"impact_basis"');
  });

  it("refuses a completed reader projection whose snapshot no longer matches the admitted step", () => {
    const input = editorialTechnicalStepInput("/tmp/repository");
    expect(() =>
      buildDocsFabStepPrompt(
        {
          ...input,
          readerContextProvenance: {
            ...input.readerContextProvenance!,
            workspace_snapshot_sha256: "0".repeat(64),
          },
        },
        "",
        input.readerTaskContext,
      ),
    ).toThrow("Reader task context does not match the admitted harness step.");
  });
});
