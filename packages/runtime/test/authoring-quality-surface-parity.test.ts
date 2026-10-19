// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleRunsCommand } from "../src/cli/commands/runs.js";
import { loadSavedRunEditorialDecodeOptions } from "../src/cli/run/editorial-replay.js";
import { inspectQualityReportFromRun } from "../src/evaluation-report/index.js";
import { createSavedRunReadTool } from "../src/live-agent/saved-run-tool.js";
import { createLiveAgentToolDefinitions } from "../src/live-agent/capabilities.js";
import { buildRunResultV1, projectRunEditorialOutcome } from "../src/operator/run-result.js";
import { formatRunSummary } from "../src/operator/run-summary.js";
import { runAuthoringQualityProducerFixture } from "./support/authoring-quality-runner.js";
import { runAuthoringUpdateQualityProducerFixture } from "./support/authoring-update-quality-runner.js";
import { temporaryRoots } from "./helpers/temp.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";

const roots = temporaryRoots();
afterEach(async () => {
  vi.restoreAllMocks();
  await roots.cleanup();
});
describe("actual authoring producer quality across operator surfaces", () => {
  it.each([
    "create-retain",
    "create-revise",
    "update",
    "no-change",
    "create-declined",
    "update-declined",
  ] as const)(
    "keeps %s initial, saved, live and human quality consistent",
    async (mode) => {
      const root = await roots.create("docsfab-quality-parity-");
      const declined = mode.endsWith("declined");
      const fixture = mode.startsWith("create-")
        ? await runAuthoringQualityProducerFixture(root, {
            branch: mode === "create-revise" ? "revise" : "retain",
            quotedDecline: true,
            declineQuality: declined,
          })
        : await runAuthoringUpdateQualityProducerFixture(
            root,
            mode.startsWith("update") ? "update" : "no-change",
            { declineQuality: declined },
          );
      const { record, stateDirectory, sourcePath } = fixture;
      expect(
        record.status,
        JSON.stringify({
          error: record.error,
          steps: record.steps.map(({ id, status, error, qualityValidationRejection }) => ({
            id,
            status,
            error,
            qualityValidationRejection,
          })),
        }),
      ).toBe("succeeded");
      const editorialDecodeOptions = await loadSavedRunEditorialDecodeOptions(
        record,
        stateDirectory,
      );
      const context = {
        record,
        recordPath: join(stateDirectory, `${record.id}.json`),
        repositoryPath: sourcePath,
        exitCode: 0 as const,
        editorialDecodeOptions,
      };
      const initial = buildRunResultV1(context);
      const output: string[] = [];
      vi.spyOn(console, "log").mockImplementation((value?: unknown) => {
        output.push(String(value));
      });
      await handleRunsCommand(["show", record.id, "--json", "--state-dir", stateDirectory]);
      const saved = JSON.parse(output.at(-1)!);
      const readTool = createSavedRunReadTool({ repositoryPath: sourcePath, stateDirectory });
      const read = await readTool.execute(
        "read",
        { runId: record.id },
        undefined,
        undefined,
        {} as never,
      );
      const live = createLiveAgentToolDefinitions({
        capabilities: {
          skills: [],
          qualityPack: {} as never,
          workflows: [{ name: record.workflow, title: "Authoring fixture" }],
        },
        runWorkflow: async () => record,
        projectEditorialOutcome: () => projectRunEditorialOutcome(record, editorialDecodeOptions),
      }).find((tool) => tool.name === "docsfab_run_workflow")!;
      const result = await live.execute(
        "run",
        { workflow: record.workflow, instruction: `Assess the requested ${mode} documentation.` },
        undefined,
        undefined,
        {} as never,
      );
      expect(saved.quality).toEqual(initial.quality);
      expect(read.details).toMatchObject({ quality: initial.quality });
      expect(result.details).toMatchObject({
        quality: initial.quality,
        workflowStatus: "succeeded",
      });
      for (const quiet of [false, true]) {
        const text = formatRunSummary({ ...context, quiet }).join("\n");
        if (mode === "no-change") {
          expect(initial.quality).toBeNull();
          expect(text).not.toContain("quality-validation-unavailable");
          expect(JSON.stringify(read.details)).not.toContain("quality-validation-unavailable");
          expect(JSON.stringify(result.details)).not.toContain("quality-validation-unavailable");
        } else if (declined) {
          expect(record.qualityProfileSelection).toBeDefined();
          expect(record.qualityArtifactValidation).toBeUndefined();
          expect(record.steps.at(-1)).toMatchObject({
            status: "succeeded",
            qualityValidationRejection: { code: "report-limitation-section-count" },
          });
          expect(inspectQualityReportFromRun(record)).toEqual({
            quality: null,
            limitation: "quality-validation-unavailable",
          });
          expect(initial.quality).toBeNull();
          expect(text).toContain("quality-validation-unavailable");
          expect(read.details).toMatchObject({
            qualityLimitations: ["quality-validation-unavailable"],
          });
          expect(result.details).toMatchObject({
            status: "succeeded",
            qualityLimitations: ["quality-validation-unavailable"],
          });
        } else {
          expect(record.qualityArtifactValidation?.status).toBe("passed");
          expect(initial.quality).toMatchObject({
            decision: "insufficient-evidence",
            rubric: { status: "unavailable" },
          });
          expect(initial.product.disposition).toBe("inconclusive");
          expect(text).toContain("Decision: insufficient-evidence");
          expect(text).toContain("Score: unavailable");
          const inspection = inspectQualityReportFromRun(record);
          expect(inspection.error).toBeUndefined();
          expect(inspection.quality).toEqual(initial.quality);
          const changedPatch = structuredClone(record);
          changedPatch.changes!.patch!.sha256 = "a".repeat(64);
          expect(inspectQualityReportFromRun(changedPatch)).toMatchObject({
            quality: null,
            error: expect.stringContaining("invalid-report"),
          });
          const patch = await readFile(record.changes!.patch!.artifactPath, "utf8");
          expect(patch).toContain(mode === "update" ? "--new" : "hello");
          expect(record.changes!.files.map((file) => file.path)).toEqual([
            mode === "update" ? "docs/cli.md" : "docs/cli-reference.md",
          ]);
        }
      }
    },
    testTimeoutMs(120_000),
  );
});
