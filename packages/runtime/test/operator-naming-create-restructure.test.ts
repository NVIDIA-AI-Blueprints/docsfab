// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createKnowledgeAcceptedSnapshot } from "../src/canon/from-knowledge-snapshot.js";
import { executeRunRequest } from "../src/cli/run-request.js";
import type { AgentHarness } from "../src/execution/contracts.js";
import { runHostedWorkflow } from "../src/host-invoker/workflow-runner.js";
import { readRunFailure } from "../src/operator/failure-classification.js";
import {
  PLAN_TARGET_NOT_NAMED_CODE,
  sealDocumentationPlanBinding,
} from "../src/workflow-execution/plan-binding.js";
import {
  controlledHostedCreateHarness,
  createHostedCreateFixture,
  HOSTED_CREATE_PAGE,
} from "./helpers/hosted-create.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";
import { runtimeConfig } from "./support/execution-convergence.js";
import { unassessedQualityEvaluation } from "./helpers/unassessed-quality-evaluation.js";

const fixtures: Awaited<ReturnType<typeof createHostedCreateFixture>>[] = [];
const budget = { timeout: testTimeoutMs(120_000) };
const paths = ["docs/WARP.md", "docs/.hidden/page.md"];
afterEach(async () => {
  vi.unstubAllEnvs();
  process.exitCode = undefined;
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

async function execute(
  mode: "create" | "restructure",
  path: string,
  named: boolean,
  hosted = false,
) {
  const existing = mode === "restructure" || hosted;
  const fixture = await createHostedCreateFixture({
    workflow: mode === "create" ? "create-documentation" : "restructure-documentation",
    sourceFiles: {
      Makefile: `docs-check:\n\t@test -s ${path}\n`,
      ".docsfab.json": JSON.stringify({
        schemaVersion: 1,
        gitlab: { remote: "origin", defaultBranch: "main" },
        provider: { configuration: "host" },
        storage: { scope: "user-private" },
      }),
      ...(existing ? { [path]: HOSTED_CREATE_PAGE } : {}),
    },
    ...(hosted ? { grantTargets: [{ path, operations: ["modify"] }], maximumChangedPaths: 2 } : {}),
  });
  fixtures.push(fixture);
  if (!hosted) {
    await fixture.git(
      ["remote", "set-url", "origin", "ssh://git@gitlab.example.invalid/docs/api.git"],
      fixture.outer,
    );
  }
  const inner = controlledHostedCreateHarness(fixture.request, { targetPath: path });
  const harness: AgentHarness = {
    inspectSkill: inner.harness.inspectSkill,
    async runStep(input) {
      const result = await inner.harness.runStep(input);
      if (input.step.id === "plan-documentation" && mode === "restructure") {
        return {
          ...result,
          planBinding: sealDocumentationPlanBinding(
            {
              mode,
              pages: [{ path, disposition: "restructure" }],
              sourceBindings: [
                { pagePath: path, sources: [`src/api.ts:1@${fixture.request.revision}`] },
              ],
            },
            { expectedMode: mode },
          ),
        };
      }
      if (input.step.id === "write-documentation" && existing) {
        await writeFile(
          join(input.repositoryPath, path),
          `${HOSTED_CREATE_PAGE}\nUse the current API guide.\n`,
        );
      }
      return result;
    },
  };
  const instruction = `${mode === "create" ? "Create" : "Restructure"} ${named ? path : "the documentation"} for the safe API default.`;
  if (hosted) {
    // Neither rendered capsule content nor the installed caller's instruction
    // is operator input. These legacy CREATE/RESTRUCTURE packets carry none.
    const result = await runHostedWorkflow({
      request: fixture.request,
      credential: null,
      emit() {},
      executionHarness: harness,
      instruction,
    });
    return { fixture, record: result.record, calls: inner.calls };
  }
  const canonSnapshotPath = join(fixture.state, "canon.json");
  await writeFile(
    canonSnapshotPath,
    JSON.stringify(
      createKnowledgeAcceptedSnapshot({
        projectId: "API",
        modelVersionId: "API-V1",
        streamVersion: 1,
        status: "approved",
        claims: [
          {
            id: "API-DEFAULT",
            kind: "behavior",
            scope: path,
            statement: "The API exposes a safe default.",
            modelState: "canonical",
            evidenceIds: ["API-SOURCE"],
          },
        ],
        sources: [{ id: "API-SOURCE", locator: "src/api.ts" }],
        conflicts: [],
      }),
    ),
  );
  vi.stubEnv("PI_OFFLINE", "1");
  const record = await executeRunRequest(
    {
      workflow: mode === "create" ? "create-documentation" : "restructure-documentation",
      repositoryPath: fixture.outer,
      revision: fixture.request.revision,
      instruction,
      allowWrite: true,
      releaseGate: false,
      verbose: false,
      json: false,
      showScan: false,
      ...(mode === "create" ? { canonSnapshotPath } : {}),
    },
    runtimeConfig(fixture.state),
    {
      silent: true,
      executionHarness: harness,
      // An inventory-selected CREATE target gives the first pass an unambiguous
      // plan without claiming the operator named it. The naming gate still reads
      // only the original request; restructure needs no first-pass binding.
      ...(mode === "create"
        ? {
            requestInterpreter: {
              async call() {
                return {
                  text: JSON.stringify({
                    operation: "create",
                    authorityPreference: { preference: "unspecified", quote: null },
                    targets: [
                      {
                        path,
                        role: "write",
                        chosenFrom: "proposed-new",
                        quote: named ? path : "documentation",
                      },
                    ],
                  }),
                  usage: { inputTokens: 2, outputTokens: 1 },
                };
              },
            },
          }
        : {}),
    },
  );
  expect(record).toBeDefined();
  return { fixture, record: record!, calls: inner.calls };
}

describe("CREATE and RESTRUCTURE name special targets before writing", () => {
  it(
    "review --allow-write remains read-only even when the operator names an instruction file",
    budget,
    async () => {
      const path = "docs/WARP.md";
      const fixture = await createHostedCreateFixture({
        sourceFiles: {
          [path]: HOSTED_CREATE_PAGE,
          ".docsfab.json": JSON.stringify({
            schemaVersion: 1,
            gitlab: { remote: "origin", defaultBranch: "main" },
            provider: { configuration: "host" },
            storage: { scope: "user-private" },
          }),
        },
      });
      fixtures.push(fixture);
      await fixture.git(
        ["remote", "set-url", "origin", "ssh://git@gitlab.example.invalid/docs/api.git"],
        fixture.outer,
      );
      const controlled = controlledHostedCreateHarness(fixture.request, { targetPath: path });
      const harness: AgentHarness = {
        inspectSkill: controlled.harness.inspectSkill,
        async runStep(input) {
          const result = await controlled.harness.runStep(input);
          if (input.step.id !== "evaluate-document-quality") return result;
          const profile = JSON.parse(
            await readFile(
              new URL(
                "../quality/profiles/docsfab-documentation-quality/profile.json",
                import.meta.url,
              ),
              "utf8",
            ),
          );
          const reportMarkdown =
            "# Documentation quality evaluation report\n\n## Evidence gaps and limitations\n\n- Limitation: Direct outcome evidence is unavailable.\n";
          return {
            ...result,
            summary: reportMarkdown,
            qualityArtifactCandidate: {
              evaluation: unassessedQualityEvaluation(
                profile,
                fixture.request.revision,
                input.qualityEvaluationTarget!.map((entry) => entry.path),
              ),
              qualityScore: null,
              reportMarkdown,
              selectionSha256: input.qualityProfileSelection!.selectionSha256,
            },
          };
        },
      };
      vi.stubEnv("PI_OFFLINE", "1");
      const record = await executeRunRequest(
        {
          workflow: "review-documentation",
          repositoryPath: fixture.outer,
          revision: fixture.request.revision,
          instruction: `Review ${path}.`,
          contextTarget: { sourcePath: path },
          allowWrite: true,
          releaseGate: false,
          verbose: false,
          json: false,
          showScan: false,
        },
        runtimeConfig(fixture.state),
        { silent: true, executionHarness: harness },
      );
      expect(record?.status, record?.error).toBe("succeeded");
      expect(controlled.calls.length).toBeGreaterThan(0);
      expect(controlled.calls.every((call) => call.step.mode === "read-only")).toBe(true);
      expect(record?.changes?.files ?? []).toEqual([]);
      expect(await readFile(join(fixture.outer, path), "utf8")).toBe(HOSTED_CREATE_PAGE);
    },
  );

  const modes = ["create", "restructure"] as const;
  const cases = modes.flatMap((mode) => paths.map((path) => [mode, path] as const));
  it.each(cases)("%s refuses an unnamed %s", budget, async (mode, path) => {
    const result = await execute(mode, path, false);
    expect(readRunFailure(result.record)?.code, result.record.error).toBe(
      PLAN_TARGET_NOT_NAMED_CODE,
    );
    if (mode === "create") {
      expect(result.calls).toEqual([]);
    } else {
      expect(result.calls.at(-1)?.step.id).toBe("plan-documentation");
    }
    expect(result.calls.some((call) => call.step.mode === "write")).toBe(false);
  });
  it.each(cases)("%s delivers the exact named %s (control)", budget, async (mode, path) => {
    const result = await execute(mode, path, true);
    expect(result.record.status, result.record.error).toBe("succeeded");
    expect(result.record.changes?.files.map((file) => file.path)).toEqual([path]);
  });
  it.each(modes)(
    "%s in the hosted runner does not turn rendered instructions into operator naming",
    budget,
    async (mode) => {
      const result = await execute(mode, "docs/WARP.md", true, true);
      expect(readRunFailure(result.record)?.code, result.record.error).toBe(
        PLAN_TARGET_NOT_NAMED_CODE,
      );
      expect(result.calls.some((call) => call.step.mode === "write")).toBe(false);
      expect(await readFile(join(result.fixture.outer, "docs/WARP.md"), "utf8")).toBe(
        HOSTED_CREATE_PAGE,
      );
    },
  );
});
