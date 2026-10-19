// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ContentIndexV1, DocumentNode } from "../../src/content-ir/index.js";
import { DEFAULT_IA_NAVIGATION_TASKS } from "../../src/ia/input-provider.js";

/** Controlled inference response; all IDs come from the actual indexed test checkout. */
export function modelSubmission(index: ContentIndexV1) {
  const documents = index.nodes.filter((node): node is DocumentNode => node.kind === "document");
  const readme = documents.find((node) => node.sourcePath === "README.md")!;
  const connect = documents.find((node) => node.sourcePath === "connect.md")!;
  const publish = documents.find((node) => node.sourcePath === "publish.md")!;
  const evidence = (node: DocumentNode) => [{ nodeId: node.id, path: node.sourcePath }];
  const groups = [
    {
      id: "group:connect",
      label: "Connect",
      axis: "reader-job",
      members: [connect.id],
      canonicalPath: "connect",
      evidence: evidence(connect),
    },
    {
      id: "group:publish",
      label: "Publish",
      axis: "reader-job",
      members: [publish.id],
      canonicalPath: "publish",
      evidence: evidence(publish),
    },
  ];
  return {
    schemaVersion: 1,
    kind: "docsfab-ia-analysis-submission",
    repository: { ...index.repository, indexDigest: index.indexDigest },
    task: { scope: "site", mode: "create" },
    design: {
      status: "recommendation-ready",
      useCases: [
        {
          id: "use:connect",
          actor: "operator",
          trigger: "a cluster exists",
          goal: "connect it",
          input: "cluster endpoint",
          outcome: "connected cluster",
          evidence: evidence(connect),
        },
      ],
      recommendation: {
        candidateId: "candidate:jobs",
        primaryAxis: "reader-job",
        groups: groups.map((group) => ({ id: group.id, memberNodeIds: group.members })),
        rationale: "Reader jobs provide direct paths.",
        evidence: evidence(readme),
      },
      rejections: [
        {
          candidateId: "candidate:capabilities",
          primaryAxis: "capability",
          reason: "lower-score",
          rationale: "Capability labels obscure jobs.",
          evidence: evidence(readme),
        },
      ],
      openDecisions: [],
    },
    artifacts: {
      ontology: {
        entities: [
          { id: "entity:operator", label: "Operator", kind: "actor", evidence: evidence(readme) },
          { id: "entity:connect", label: "Connect", kind: "user-job", evidence: evidence(connect) },
          { id: "entity:publish", label: "Publish", kind: "user-job", evidence: evidence(publish) },
        ],
        relationships: [],
      },
      iaCandidates: {
        scope: "site",
        candidates: [
          {
            id: "candidate:jobs",
            primaryAxis: "reader-job",
            secondaryAxes: [],
            score: 92,
            groups,
            evidence: evidence(readme),
          },
          {
            id: "candidate:capabilities",
            primaryAxis: "capability",
            secondaryAxes: [],
            score: 68,
            groups: [
              {
                id: "group:platform",
                label: "Platform",
                axis: "capability",
                members: [connect.id, publish.id],
                canonicalPath: "platform",
                evidence: evidence(readme),
              },
            ],
            evidence: evidence(readme),
          },
        ],
        recommendedCandidateId: "candidate:jobs",
        rejectedCandidates: [{ candidateId: "candidate:capabilities", reason: "lower-score" }],
        openDecisions: [],
      },
      navigationEvaluation: {
        tasks: DEFAULT_IA_NAVIGATION_TASKS.map((task) => ({
          ...task,
          expectedNodeIds:
            task.id === "expected-no-result"
              ? []
              : task.id === "reference-lookup"
                ? [publish.id]
                : task.id === "ambiguous-placement"
                  ? [connect.id, publish.id]
                  : [connect.id],
          acceptableNodeIds: [],
        })),
        results: DEFAULT_IA_NAVIGATION_TASKS.map((task) => ({
          taskId: task.id,
          rankedNodeIds:
            task.id === "expected-no-result"
              ? []
              : task.id === "reference-lookup"
                ? [publish.id]
                : task.id === "ambiguous-placement"
                  ? [connect.id, publish.id]
                  : [connect.id],
          outcome:
            task.id === "expected-no-result"
              ? "no-result"
              : task.id === "ambiguous-placement"
                ? "ambiguous"
                : "matched",
        })),
      },
    },
  };
}
