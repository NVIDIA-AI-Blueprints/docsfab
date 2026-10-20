// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  WorkflowContextPolicy,
  WorkflowManifestStepV2,
  WorkflowManifestV3,
} from "../../src/workflow-contracts/contracts.js";

const context = (
  steps: readonly WorkflowManifestStepV2[],
  writeStepId?: string,
): WorkflowContextPolicy => ({
  schemaVersion: 1,
  steps: steps.map((step) => ({
    stepId: step.id,
    required: true,
    level: "corpus",
    query: "expand",
    allowReadOnlyDegraded: step.id !== writeStepId,
  })),
});

const prefix: WorkflowManifestStepV2[] = [
  step("plan-documentation", "evaluate", "plan-documentation", "read-only", {
    searchPlan: "documentation-observation",
    searchMode: "observe",
  }),
  step("derive-source-obligations", "evaluate", "verify-technical-accuracy", "read-only", {
    searchPlan: "documentation-observation",
    searchMode: "revalidate",
  }),
  step("write-documentation", "inference", "write-documentation", "write", {
    consumes: ["derive-source-obligations"],
    searchPlan: "documentation-observation",
    searchMode: "revalidate",
  }),
  step("lint-documentation", "host-operation", "lint-documentation", "read-only"),
  step("provisional-technical-verification", "evaluate", "verify-technical-accuracy", "read-only", {
    consumes: ["derive-source-obligations"],
    searchPlan: "documentation-observation",
    searchMode: "revalidate",
  }),
  step("review-documentation", "evaluate", "review-documentation", "read-only"),
  step("verify-technical-accuracy", "evaluate", "verify-technical-accuracy", "read-only", {
    consumes: [
      "derive-source-obligations",
      "provisional-technical-verification",
      "review-documentation",
    ],
    consumesEvidence: [
      "derive-source-obligations",
      "provisional-technical-verification",
      "review-documentation",
    ],
    searchPlan: "documentation-observation",
    searchMode: "revalidate",
  }),
];

const retain: WorkflowManifestStepV2[] = [
  step("test-audience-understanding", "evaluate", "test-audience-understanding", "read-only", {
    consumes: ["lint-documentation", "verify-technical-accuracy", "review-documentation"],
  }),
  step("evaluate-document-quality", "evaluate", "evaluate-document-quality", "read-only", {
    consumes: [
      "lint-documentation",
      "verify-technical-accuracy",
      "review-documentation",
      "test-audience-understanding",
    ],
    consumesEvidence: ["verify-technical-accuracy"],
    searchPlan: "documentation-observation",
    searchMode: "reuse",
  }),
];

const revise: WorkflowManifestStepV2[] = [
  step("revise-documentation", "inference", "write-documentation", "write", {
    consumes: ["derive-source-obligations", "verify-technical-accuracy", "review-documentation"],
    consumesEvidence: [
      "derive-source-obligations",
      "verify-technical-accuracy",
      "review-documentation",
    ],
    searchPlan: "documentation-observation",
    searchMode: "revalidate",
  }),
  step("lint-revised-documentation", "host-operation", "lint-documentation", "read-only"),
  step(
    "provisional-revised-technical-verification",
    "evaluate",
    "verify-technical-accuracy",
    "read-only",
    {
      consumes: ["derive-source-obligations"],
      searchPlan: "documentation-observation",
      searchMode: "revalidate",
    },
  ),
  step("verify-revised-technical-accuracy", "evaluate", "verify-technical-accuracy", "read-only", {
    consumes: ["derive-source-obligations", "provisional-revised-technical-verification"],
    consumesEvidence: ["derive-source-obligations", "provisional-revised-technical-verification"],
    searchPlan: "documentation-observation",
    searchMode: "revalidate",
  }),
  step("review-revised-documentation", "evaluate", "review-documentation", "read-only", {
    consumes: ["lint-revised-documentation", "verify-revised-technical-accuracy"],
  }),
  step("test-audience-understanding", "evaluate", "test-audience-understanding", "read-only", {
    consumes: [
      "lint-revised-documentation",
      "verify-revised-technical-accuracy",
      "review-revised-documentation",
    ],
  }),
  step("evaluate-document-quality", "evaluate", "evaluate-document-quality", "read-only", {
    consumes: [
      "lint-revised-documentation",
      "verify-revised-technical-accuracy",
      "review-revised-documentation",
      "test-audience-understanding",
    ],
    consumesEvidence: ["verify-revised-technical-accuracy"],
    searchPlan: "documentation-observation",
    searchMode: "reuse",
  }),
];

export function authoringManifestV3(): WorkflowManifestV3 {
  return structuredClone({
    schemaVersion: 3,
    name: "create-documentation",
    title: "Create documentation",
    outcome: "A bounded source-grounded documentation candidate.",
    prefix: { steps: prefix, contextPolicy: context(prefix, "write-documentation") },
    selection: {
      afterStepId: "verify-technical-accuracy",
      kind: "authoring-revision-v1",
    },
    branches: [
      { id: "retain", steps: retain, contextPolicy: context(retain) },
      {
        id: "revise",
        steps: revise,
        contextPolicy: context(revise, "revise-documentation"),
      },
    ],
  });
}

export function legacyAuthoringManifestV3(): WorkflowManifestV3 {
  const manifest = authoringManifestV3();
  const canonical = manifest.prefix.steps[6]!;
  canonical.consumes = ["derive-source-obligations", "provisional-technical-verification"];
  canonical.consumesEvidence = ["derive-source-obligations", "provisional-technical-verification"];
  manifest.prefix.steps.splice(5, 2, canonical, manifest.prefix.steps[5]!);
  const canonicalContext = manifest.prefix.contextPolicy.steps[6]!;
  manifest.prefix.contextPolicy.steps.splice(
    5,
    2,
    canonicalContext,
    manifest.prefix.contextPolicy.steps[5]!,
  );
  manifest.selection.afterStepId = "review-documentation";
  return manifest;
}

function step(
  id: string,
  kind: WorkflowManifestStepV2["kind"],
  skill: string,
  mode: WorkflowManifestStepV2["mode"],
  optional: Partial<WorkflowManifestStepV2> = {},
): WorkflowManifestStepV2 {
  return {
    id,
    title: id,
    kind,
    skill,
    mode,
    prompt: `Perform the closed ${id} phase.`,
    ...optional,
  };
}
