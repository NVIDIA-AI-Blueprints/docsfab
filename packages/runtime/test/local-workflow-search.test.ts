// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createDocumentationGapLedger,
  negativeDocumentationEvidence,
  projectDocumentationSearchFindings,
} from "../src/search/index.js";
import { getWorkflow, listCatalogWorkflows } from "../src/workflow-registry/catalog.js";
import type {
  WorkflowDefinition,
  WorkflowName,
  WorkflowStep,
} from "../src/workflow-contracts/contracts.js";
import { LocalWorkflowSearchCoordinator } from "../src/search/local-workflow-coordinator.js";
import { normalizeWorkflowSearchEvidence } from "../src/workflow-contracts/search.js";
import { temporaryRoots } from "./helpers/temp.js";

const REVISION = "a".repeat(40);
const temporary = temporaryRoots();

describe("local workflow search coordinator", () => {
  it("keeps model-owned rubric assessment out of blocked host limitations", async () => {
    const root = await repository();
    await mkdir(join(root, "docs"));
    await writeFile(join(root, "README.md"), "# Product\n");
    await writeFile(join(root, "docs", "guide.md"), "# Guide\n");

    const evidence = await runReadiness(root);
    expect(evidence.searches.map((search) => search.bounded.finding.disposition)).toEqual([
      "found",
      "found",
    ]);
    const rubric = evidence.searches[1]!.bounded.probes.filter(
      (probe) => probe.strategy === "rubric-assessment",
    );
    expect(rubric).toHaveLength(2);
    expect(rubric.every((probe) => probe.outcome === "inconclusive")).toBe(true);
    expect(evidence.searches[1]!.bounded.limitations).toEqual([]);
    const findings = projectDocumentationSearchFindings({
      workflow: "readiness",
      stepId: "assess-readiness",
      evidence,
    });
    const ledger = createDocumentationGapLedger({ currentRevision: REVISION, findings });
    expect(ledger.entries.map((entry) => entry.state).sort()).toEqual([
      "inconclusive",
      "satisfied",
    ]);
    expect(JSON.stringify({ evidence, findings, ledger })).not.toContain(root);
    expect(JSON.stringify({ findings, ledger })).not.toContain("README.md");
    expect(JSON.stringify({ findings, ledger })).not.toContain("# Product");
  });

  it("reaches bounded absence only after complete deterministic inventory probes", async () => {
    const root = await repository();
    const evidence = await runReadiness(root);
    expect(evidence.searches[0]!.bounded.finding.disposition).toBe(
      "not-found-after-bounded-search",
    );
    expect(evidence.searches[0]!.progress.observations).toHaveLength(3);
    const findings = projectDocumentationSearchFindings({
      workflow: "readiness",
      stepId: "assess-readiness",
      evidence,
    });
    expect(negativeDocumentationEvidence(findings)).toHaveLength(1);
  });

  it("preserves tracked documentation paths containing plus signs in bounded and progress evidence", async () => {
    const root = await repository();
    await mkdir(join(root, "changelog.d"));
    await writeFile(join(root, "changelog.d", "+analytics-full-payload.fixed.md"), "# Change\n");

    const evidence = await runReadiness(root);
    const path = "changelog.d/+analytics-full-payload.fixed.md";
    expect(
      evidence.searches[1]!.bounded.finding.citations.map((citation) => citation.path),
    ).toContain(path);
    expect(
      evidence.searches[1]!.progress.observations.flatMap((observation) => observation.events)
        .flatMap((event) => event.citations)
        .map((citation) => citation.path),
    ).toContain(path);
  });

  it("treats symlinked inventory as incomplete instead of claiming absence", async () => {
    const root = await repository();
    await symlink("/private/host-document.md", join(root, "README.md"));
    const evidence = await runReadiness(root);
    expect(evidence.searches[0]!.bounded.finding.disposition).toBe("search-blocked");
    expect(evidence.searches[0]!.bounded.limitations.map((item) => item.category)).toEqual([
      "index-incomplete",
    ]);
    expect(JSON.stringify(evidence)).not.toContain("/private/host-document.md");
  });
});

const catalogSearchCases = listCatalogWorkflows().flatMap((workflow) =>
  workflow.steps
    .filter((step) => step.search !== undefined)
    .map((step) => ({ workflow: workflow.name, stepId: step.id })),
);

describe("catalog-owned search identity", () => {
  it.each(catalogSearchCases)(
    "projects coordinator findings for $workflow/$stepId",
    async ({ workflow: workflowName, stepId }) => {
      const root = await repository();
      await writeFile(join(root, "README.md"), "# Product\n");
      const workflow = getWorkflow(workflowName);
      const step = workflow.steps.find((candidate) => candidate.id === stepId)!;
      const evidence = await runSearch(root, workflow, step);
      expect(() =>
        projectDocumentationSearchFindings({
          workflow: workflowName,
          stepId,
          evidence,
        }),
      ).not.toThrow();
    },
    30_000,
  );

  it("rejects findings attributed to a string that is not a catalog workflow", async () => {
    const root = await repository();
    await writeFile(join(root, "README.md"), "# Product\n");
    const evidence = await runReadiness(root);
    expect(() =>
      projectDocumentationSearchFindings({
        workflow: "not-a-catalog-job" as WorkflowName,
        stepId: "assess-readiness",
        evidence,
      }),
    ).toThrow(/invalid-finding/u);
  });
});

function repository(): Promise<string> {
  return temporary.create("docsfab-local-search-");
}

async function runReadiness(repositoryPath: string) {
  const workflow = getWorkflow("readiness");
  return runSearch(repositoryPath, workflow, workflow.steps[0]!);
}

async function runSearch(repositoryPath: string, workflow: WorkflowDefinition, step: WorkflowStep) {
  const plan = step.search!;
  const repository = {
    sourcePath: "/selected/source",
    requestedRevision: REVISION,
    revision: REVISION,
  };
  const result = await new LocalWorkflowSearchCoordinator().search({
    runId: "local-search-test",
    repositoryPath,
    repository,
    workflow,
    step,
    plan,
    repositoryDefaultBranch: "main",
  });
  return normalizeWorkflowSearchEvidence({
    plan,
    repository,
    repositoryIdentitySha256: result.repositoryIdentitySha256,
    searches: result.searches,
  });
}
