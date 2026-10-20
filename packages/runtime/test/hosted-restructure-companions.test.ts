// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The hosted navigation companion grant at its shipped call site:
 * `runHostedWorkflow` derives the grant from the write authority's exact modify
 * targets, and the sealed terminal then admits or refuses the patch.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { AgentHarness } from "../src/execution/contracts.js";
import {
  parseHostRuntimeTerminalWire,
  sealHostRuntimeTerminal,
} from "../src/host-invoker/contracts.js";
import { runHostedWorkflow } from "../src/host-invoker/workflow-runner.js";
import {
  documentationPlanWritePaths,
  sealDocumentationPlanBinding,
} from "../src/workflow-execution/plan-binding.js";
import {
  controlledHostedCreateHarness,
  createHostedCreateFixture,
  HOSTED_CREATE_PAGE as page,
  HOSTED_CREATE_TARGET as target,
} from "./helpers/hosted-create.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";

const INDEX = "docs/index.md";
const INDEX_BEFORE = "# Guides\n\n- [Overview](overview.md)\n";
const INDEX_AFTER = "# Guides\n\n- [Overview](overview.md)\n- [API guide](new-guide.md)\n";
const fixtures: Awaited<ReturnType<typeof createHostedCreateFixture>>[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((f) => f.cleanup()));
});

/** A restructure plan that adds one page beside an existing docs index. */
function restructureHarness(request: Parameters<typeof controlledHostedCreateHarness>[0]) {
  const inner = controlledHostedCreateHarness(request);
  const writerAllowlists: (readonly string[])[] = [];
  const harness: AgentHarness = {
    inspectSkill: inner.harness.inspectSkill!,
    async runStep(input) {
      const answer = await inner.harness.runStep(input);
      if (input.step.id === "plan-documentation") {
        return {
          ...answer,
          planBinding: sealDocumentationPlanBinding(
            {
              mode: "restructure",
              pages: [{ path: target, disposition: "move" }],
              sourceBindings: [{ pagePath: target, sources: [`src/api.ts:1@${request.revision}`] }],
            },
            { expectedMode: "restructure" },
          ),
        };
      }
      if (input.step.id === "write-documentation") {
        const allowlist = documentationPlanWritePaths(input.planBinding!);
        writerAllowlists.push(allowlist);
        // The writer links the new page only where its allowlist lets it.
        if (allowlist.includes(INDEX)) {
          await writeFile(join(input.repositoryPath, INDEX), INDEX_AFTER);
        }
      }
      return answer;
    },
  };
  return { harness, writerAllowlists };
}

async function runHostedRestructure(
  indexOperations: readonly ("modify" | "delete")[],
  maximumChangedPaths: number,
) {
  const f = await createHostedCreateFixture({
    workflow: "restructure-documentation",
    sourceFiles: { [INDEX]: INDEX_BEFORE, "docs/overview.md": "# Overview\n" },
    grantTargets: [{ path: INDEX, operations: indexOperations }],
    maximumChangedPaths,
  });
  fixtures.push(f);
  const controlled = restructureHarness(f.request);
  const result = await runHostedWorkflow({
    request: f.request,
    credential: null,
    emit() {},
    executionHarness: controlled.harness,
    instruction: "Restructure the guides and add docs/new-guide.md.",
  });
  const terminal = () =>
    parseHostRuntimeTerminalWire(
      JSON.parse(
        JSON.stringify(
          sealHostRuntimeTerminal({
            request: f.request,
            status: result.record.status === "succeeded" ? "succeeded" : "failed",
            runtimeRecord: result.record,
            patch: result.patch,
            patchEvidence: result.patchEvidence,
            editorialOutcome: result.editorialOutcome,
          }),
        ),
      ),
      f.request,
    );
  const step = (id: string) => result.record.steps.find((candidate) => candidate.id === id)!;
  return { f, result, terminal, step, writerAllowlists: controlled.writerAllowlists };
}

describe("hosted restructure navigation companion grant", () => {
  it("labels an index the grant may only delete and seals a terminal without it", {
    timeout: testTimeoutMs(120_000),
  }, async () => {
    // Adjacent to the modify case: the index is an exact target, but not a
    // modify target, so it is never a companion.
    const { f, result, terminal, step, writerAllowlists } = await runHostedRestructure(
      ["delete"],
      1,
    );
    expect(result.record.status, result.record.error).toBe("succeeded");
    const planner = step("plan-documentation");
    expect(planner.planBinding?.navigationCompanions).toBeUndefined();
    expect(planner.navigationLabels).toEqual([
      { code: "navigation-companion-not-granted", path: INDEX, grant: [] },
    ]);
    expect(writerAllowlists).toEqual([[target]]);
    expect(step("write-documentation").navigationLabels).toEqual([
      { code: "navigation-unreachable-page", path: target, navigation: null, index: INDEX },
    ]);
    expect(result.patchEvidence?.changes.map((change) => change.path)).toEqual([target]);
    expect(await readFile(join(f.outer, INDEX), "utf8")).toBe(INDEX_BEFORE);
    expect(terminal().status).toBe("succeeded");
  });

  it("admits an index the grant lets it modify and seals a terminal with the link", {
    timeout: testTimeoutMs(120_000),
  }, async () => {
    const { f, result, terminal, step, writerAllowlists } = await runHostedRestructure(
      ["modify"],
      2,
    );
    expect(result.record.status, result.record.error).toBe("succeeded");
    const planner = step("plan-documentation");
    expect(planner.planBinding?.navigationCompanions?.map((companion) => companion.path)).toEqual([
      INDEX,
    ]);
    expect(planner.navigationLabels).toBeUndefined();
    expect(writerAllowlists).toEqual([[INDEX, target]]);
    expect(step("write-documentation").navigationLabels).toBeUndefined();
    expect(result.patchEvidence?.changes.map((change) => [change.path, change.operation])).toEqual([
      [INDEX, "modify"],
      [target, "add"],
    ]);
    expect(await readFile(join(f.outer, INDEX), "utf8")).toBe(INDEX_AFTER);
    expect(await readFile(join(f.outer, target), "utf8")).toBe(page);
    expect(terminal().status).toBe("succeeded");
  });
});
