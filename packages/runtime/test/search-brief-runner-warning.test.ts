// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The runner records a step's search-brief omission on the run record when the
 * step runs, so the operator footer reports what the model was given rather
 * than a later recomputation.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import type { RunRecord } from "../src/records/contracts.js";
import type { WorkflowSearchStepEvidenceV1 } from "../src/workflow-contracts/contracts.js";
import { LocalWorkflowSearchCoordinator } from "../src/search/local-workflow-coordinator.js";
import { WorkflowRunner } from "../src/workflow-execution/runner.js";
import { recordSearchBriefOmission } from "../src/workflow-execution/runner-step-loop.js";
import { readyContextPreflight } from "./helpers.js";
import { initFixtureRepo } from "./helpers/git.js";

/** Hold the brief to exactly its fixed content, so every cited path is left out. */
vi.mock("../src/search/model-search-brief.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/search/model-search-brief.js")>();
  return {
    ...original,
    searchBriefOmissionWarning: (
      ...[stepId, evidence]: Parameters<typeof original.searchBriefOmissionWarning>
    ) => {
      const { accounting } = original.projectModelSearchBrief(evidence);
      return original.searchBriefOmissionWarning(stepId, evidence, {
        ...original.resolveSearchBriefLimit(),
        value: accounting.fixedChars,
      });
    },
  };
});

const temporary: string[] = [];
/** The readiness step's real search evidence, kept from the first case. */
let observedEvidence: WorkflowSearchStepEvidenceV1 | undefined;
afterAll(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("search brief omission on the run record", () => {
  it("records the step's omission warning once on the run record", async () => {
    const root = await mkdtemp(join(tmpdir(), "docsfab-search-brief-runner-"));
    temporary.push(root);
    const revision = await initFixtureRepo(
      root,
      {
        "README.md": "# Product\n\n[Install](docs/install.md)\n",
        "docs/install.md": "# Install\n\nInstall the supported package.\n",
      },
      { branch: "main" },
    );
    const saved: RunRecord[] = [];
    const runner = new WorkflowRunner({
      harness: {
        runStep: async () => ({ summary: "Readiness assessed." }),
      },
      store: { save: async (record) => void saved.push(structuredClone(record)) },
      repositoryScanner: {
        scan: async () => ({
          ruleSet: "test-v1",
          status: "passed",
          scannedFiles: 2,
          binaryFiles: 0,
          findings: [],
        }),
      },
      contextPreflight: readyContextPreflight,
      workflowSearch: new LocalWorkflowSearchCoordinator(),
      id: () => "run-search-brief-warning",
    });
    const record = await runner.run({
      workflow: "readiness",
      workspacePath: root,
      repository: { sourcePath: root, requestedRevision: revision, revision },
      allowWrite: false,
    });
    const warnings = (record.evidenceWarnings ?? []).filter((warning) =>
      warning.startsWith("search-brief-cited-paths-omitted: step assess-readiness listed 0 of "),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("search-brief-total-max-chars-bound: ");
    expect(saved.at(-1)?.evidenceWarnings).toContain(warnings[0]);
    observedEvidence = record.steps[0]!.searchEvidence;
  });

  it("records nothing for a host-operation step, which gives no model a brief", async () => {
    const root = await mkdtemp(join(tmpdir(), "docsfab-search-brief-host-step-"));
    temporary.push(root);
    const revision = await initFixtureRepo(
      root,
      {
        "README.md": "# Product\n\n[Install](docs/install.md)\n",
        "docs/install.md": "# Install\n\nInstall the supported package.\n",
      },
      { branch: "main" },
    );
    const runner = new WorkflowRunner({
      harness: { runStep: async () => ({ summary: "unused" }) },
      hostOperations: {
        runStep: async () => ({
          summary: "fixture host operation",
          outcome: "succeeded" as const,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0, cost: 0 },
          tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
        }),
      },
      store: { save: async () => undefined },
      repositoryScanner: {
        scan: async () => ({
          ruleSet: "test-v1",
          status: "passed",
          scannedFiles: 2,
          binaryFiles: 0,
          findings: [],
        }),
      },
      contextPreflight: readyContextPreflight,
      workflowSearch: new LocalWorkflowSearchCoordinator(),
      id: () => "run-search-brief-host-step",
    });
    const record = await runner.run({
      workflow: "ia-plan",
      workspacePath: root,
      repository: { sourcePath: root, requestedRevision: revision, revision },
      task: { kind: "ia-plan", scope: "site", mode: "create" },
      allowWrite: false,
    });
    // Control: the host step did observe search evidence the mocked budget cuts.
    expect(record.steps[0]?.kind).toBe("host-operation");
    expect(record.steps[0]?.searchEvidence).toBeDefined();
    expect(
      (record.evidenceWarnings ?? []).filter((warning) =>
        warning.startsWith("search-brief-cited-paths-omitted:"),
      ),
    ).toEqual([]);
  });

  it("records a repeated omission once, which the readiness reader requires", () => {
    // A step that runs again (a replay or resume) meets the same evidence; the
    // readiness reader refuses duplicated evidence warnings.
    expect(observedEvidence).toBeDefined();
    const record = {
      evidenceWarnings: ["Repository change evidence could not be captured."],
    } as unknown as RunRecord;
    recordSearchBriefOmission(record, "assess-readiness", observedEvidence!);
    recordSearchBriefOmission(record, "assess-readiness", observedEvidence!);
    expect(
      record.evidenceWarnings!.filter((warning) =>
        warning.startsWith("search-brief-cited-paths-omitted: step assess-readiness"),
      ),
    ).toHaveLength(1);
    expect(record.evidenceWarnings).toHaveLength(2);
  });
});
