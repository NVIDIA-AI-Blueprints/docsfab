// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createArtifact,
  recomputeNavigationMetrics,
  type NavigationEvaluationPayload,
} from "../../src/artifacts/index.js";
import { buildContentIndex } from "../../src/content-ir/index.js";
import { DEFAULT_IA_NAVIGATION_TASKS } from "../../src/ia/input-provider.js";
import type { IaAnalysisScenarioFixture } from "../ia-analysis-harness.scenarios.js";

/** A new code-only example, independent of evaluation corpus repositories. */
export async function populateCodeOnlyRepository(destination: string): Promise<void> {
  await mkdir(join(destination, "src"), { recursive: true });
  await writeFile(join(destination, "src/report.ts"), "export const reportFormat = 'text';\n");
}

/** Tiny local-file report example. All artifact evidence binds its actual indexed files. */
export async function publicIaAnalysisFixture(root: string): Promise<IaAnalysisScenarioFixture> {
  const index = await buildContentIndex({
    repositoryPath: join(root, "repository"),
    repositoryRevision: "a".repeat(40),
  });
  const documents = index.nodes.filter((node) => node.kind === "document");
  const readme = documents.find((node) => node.sourcePath === "README.md")!;
  const input = documents.find((node) => node.sourcePath === "connect.md")!;
  const output = documents.find((node) => node.sourcePath === "publish.md")!;
  const evidence = [{ nodeId: readme.id, path: readme.sourcePath }];
  const groups = [
    {
      id: "group:local-report",
      label: "Prepare a local report",
      axis: "reader-job" as const,
      members: documents.map((node) => node.id),
      canonicalPath: "report",
      evidence,
    },
  ];
  const ontology = createArtifact(
    "ontology",
    {
      entities: [{ id: "entity:report", label: "Local report", kind: "artifact", evidence }],
      relationships: [],
    },
    { index },
  );
  const candidates = createArtifact(
    "ia-candidates",
    {
      scope: "site",
      candidates: [
        {
          id: "candidate:local-report",
          primaryAxis: "reader-job",
          secondaryAxes: [],
          score: 90,
          groups,
          evidence,
        },
        {
          id: "candidate:file-operations",
          primaryAxis: "capability",
          secondaryAxes: [],
          score: 70,
          groups: [
            {
              id: "group:read",
              label: "Read files",
              axis: "capability",
              members: [readme.id, input.id],
              canonicalPath: "read",
              evidence,
            },
            {
              id: "group:write",
              label: "Write files",
              axis: "capability",
              members: [output.id],
              canonicalPath: "write",
              evidence,
            },
          ],
          evidence,
        },
      ],
      recommendedCandidateId: "candidate:local-report",
      rejectedCandidates: [{ candidateId: "candidate:file-operations", reason: "lower-score" }],
      openDecisions: [],
    },
    { index },
  );
  const expected = (id: string) =>
    id === "expected-no-result"
      ? []
      : id === "reference-lookup"
        ? [output.id]
        : id === "ambiguous-placement"
          ? [input.id, output.id]
          : [input.id];
  const navigationPayload: Pick<NavigationEvaluationPayload, "tasks" | "results"> = {
    tasks: DEFAULT_IA_NAVIGATION_TASKS.map((task) => ({
      ...task,
      expectedNodeIds: expected(task.id),
      acceptableNodeIds: [],
    })),
    results: DEFAULT_IA_NAVIGATION_TASKS.map((task) => ({
      taskId: task.id,
      rankedNodeIds: expected(task.id),
      outcome:
        task.id === "expected-no-result"
          ? "no-result"
          : task.id === "ambiguous-placement"
            ? "ambiguous"
            : "matched",
    })),
  };
  const navigation = createArtifact(
    "navigation-evaluation",
    { ...navigationPayload, metrics: recomputeNavigationMetrics(navigationPayload) },
    { index },
  );
  return {
    index,
    ontology,
    candidates,
    navigation,
    result: {
      status: "recommendation-ready",
      useCases: [
        {
          id: "use:report",
          actor: "analyst",
          trigger: "a local file is ready",
          goal: "save a readable report",
          input: "local text file",
          outcome: "local report file",
          evidence,
        },
      ],
      recommendation: {
        candidateId: "candidate:local-report",
        primaryAxis: "reader-job",
        groups: groups.map((group) => ({ id: group.id, memberNodeIds: group.members })),
        rationale: "Keep the input and output steps together.",
        evidence,
      },
      rejections: [
        {
          candidateId: "candidate:file-operations",
          primaryAxis: "capability",
          reason: "lower-score",
          rationale: "Splitting read and write operations interrupts the report task.",
          evidence,
        },
      ],
      openDecisions: [],
    },
  };
}
