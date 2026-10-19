// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  authoringPhaseForStep,
  authoringPrefixPhaseForStep,
  authoringSelectedPath,
} from "../src/workflow-contracts/authoring-schedule.js";
import type { WorkflowManifestV3 } from "../src/workflow-contracts/contracts.js";
import { documentationAuditSearch } from "../src/maturity/audit-search-plan.js";
import { documentationObservationSearch } from "../src/search/observation-search-plan.js";
import { parseWorkflowManifestSnapshot } from "../src/workflow-registry/manifest.js";
import { authoringManifestV3, legacyAuthoringManifestV3 } from "./helpers/authoring-manifest.js";

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const searchPlans = {
  "documentation-audit": documentationAuditSearch,
  "documentation-observation": documentationObservationSearch,
};

function parse(manifest: unknown) {
  return parseWorkflowManifestSnapshot(manifest, "create-documentation", searchPlans);
}

describe("CREATE Manifest V3 authoring schedule", () => {
  it("selects the exact nine-step retain and fourteen-step revise paths", () => {
    const workflow = parse(authoringManifestV3());
    const retain = authoringSelectedPath(workflow, "retain");
    const revise = authoringSelectedPath(workflow, "revise");

    expect(retain.steps.map((step) => step.id)).toEqual([
      "plan-documentation",
      "derive-source-obligations",
      "write-documentation",
      "lint-documentation",
      "provisional-technical-verification",
      "review-documentation",
      "verify-technical-accuracy",
      "test-audience-understanding",
      "evaluate-document-quality",
    ]);
    expect(revise.steps.map((step) => step.id)).toEqual([
      ...retain.steps.slice(0, 7).map((step) => step.id),
      "revise-documentation",
      "lint-revised-documentation",
      "provisional-revised-technical-verification",
      "verify-revised-technical-accuracy",
      "review-revised-documentation",
      "test-audience-understanding",
      "evaluate-document-quality",
    ]);
    expect(workflow.steps.map((step) => step.id)).toEqual(revise.steps.map((step) => step.id));
    expect(retain.excludedStepIds).toEqual([
      "revise-documentation",
      "lint-revised-documentation",
      "provisional-revised-technical-verification",
      "verify-revised-technical-accuracy",
      "review-revised-documentation",
    ]);
    expect(revise.excludedStepIds).toEqual([]);
    expect(retain.contextPolicy.steps.map((step) => step.stepId)).toEqual(
      retain.steps.map((step) => step.id),
    );
    expect(revise.contextPolicy.steps.map((step) => step.stepId)).toEqual(
      revise.steps.map((step) => step.id),
    );
  });

  it("derives candidate writer and assessment roles from the installed schedule", () => {
    const workflow = parse(authoringManifestV3());
    const retain = authoringSelectedPath(workflow, "retain");
    const revise = authoringSelectedPath(workflow, "revise");

    expect(retain.phases).toEqual([
      {
        stepId: "write-documentation",
        ordinal: 3,
        role: "writer",
        inputCandidateOrdinal: null,
        outputCandidateOrdinal: 0,
      },
      { stepId: "lint-documentation", ordinal: 4, role: "lint", candidateOrdinal: 0 },
      {
        stepId: "provisional-technical-verification",
        ordinal: 5,
        role: "provisional-technical",
        candidateOrdinal: 0,
      },
      {
        stepId: "review-documentation",
        ordinal: 6,
        role: "editorial",
        candidateOrdinal: 0,
      },
      {
        stepId: "verify-technical-accuracy",
        ordinal: 7,
        role: "canonical-technical",
        candidateOrdinal: 0,
      },
      {
        stepId: "test-audience-understanding",
        ordinal: 8,
        role: "audience",
        candidateOrdinal: 0,
      },
      {
        stepId: "evaluate-document-quality",
        ordinal: 9,
        role: "evaluation",
        candidateOrdinal: 0,
      },
    ]);
    expect(authoringPrefixPhaseForStep(workflow, "plan-documentation")).toBeUndefined();
    expect(authoringPrefixPhaseForStep(workflow, "write-documentation")).toEqual(retain.phases[0]);
    expect(authoringPhaseForStep(workflow, "revise", "revise-documentation")).toEqual({
      stepId: "revise-documentation",
      ordinal: 8,
      role: "writer",
      inputCandidateOrdinal: 0,
      outputCandidateOrdinal: 1,
    });
    expect(authoringPhaseForStep(workflow, "revise", "test-audience-understanding")).toEqual({
      stepId: "test-audience-understanding",
      ordinal: 13,
      role: "audience",
      candidateOrdinal: 1,
    });
    expect(revise.phases).toHaveLength(12);
  });

  it("resolves only the selected candidate producers and evidence consumption", () => {
    const workflow = parse(authoringManifestV3());
    const retain = authoringSelectedPath(workflow, "retain");
    const revise = authoringSelectedPath(workflow, "revise");
    const retainAudience = retain.steps.at(-2)!;
    const reviseAudience = revise.steps.at(-2)!;
    const reviseEvaluation = revise.steps.at(-1)!;
    const revisedCanonical = revise.steps.find(
      (step) => step.id === "verify-revised-technical-accuracy",
    )!;

    expect(retain).toMatchObject({
      candidateOrdinal: 0,
      technicalProducerStepId: "verify-technical-accuracy",
      editorialProducerStepId: "review-documentation",
    });
    expect(revise).toMatchObject({
      candidateOrdinal: 1,
      technicalProducerStepId: "verify-revised-technical-accuracy",
      editorialProducerStepId: "review-revised-documentation",
    });
    expect(retainAudience.consumes).toEqual([
      "lint-documentation",
      "verify-technical-accuracy",
      "review-documentation",
    ]);
    expect(reviseAudience.consumes).toEqual([
      "lint-revised-documentation",
      "verify-revised-technical-accuracy",
      "review-revised-documentation",
    ]);
    expect(reviseEvaluation.consumes).toEqual([
      ...reviseAudience.consumes!,
      "test-audience-understanding",
    ]);
    expect(reviseEvaluation.consumesEvidence).toEqual(["verify-revised-technical-accuracy"]);
    expect(revisedCanonical.consumes).toEqual([
      "derive-source-obligations",
      "provisional-revised-technical-verification",
    ]);
    expect(workflow.authoringSchedule!.prefix.steps.at(-1)!.consumes).toEqual([
      "derive-source-obligations",
      "provisional-technical-verification",
      "review-documentation",
    ]);
    expect(JSON.stringify(revise.steps.slice(10))).not.toContain(
      '"provisional-technical-verification"',
    );
  });

  it("accepts the exact legacy prefix with its legacy selector and dependencies", () => {
    const workflow = parse(legacyAuthoringManifestV3());

    expect(workflow.authoringSchedule?.selection.afterStepId).toBe("review-documentation");
    expect(workflow.authoringSchedule?.prefix.steps.slice(4).map((step) => step.id)).toEqual([
      "provisional-technical-verification",
      "verify-technical-accuracy",
      "review-documentation",
    ]);
    expect(workflow.authoringSchedule?.prefix.steps[5]?.consumes).toEqual([
      "derive-source-obligations",
      "provisional-technical-verification",
    ]);
  });

  it("rejects mixed legacy and corrected selector, order, and dependency layouts", () => {
    const correctedWithLegacySelector = authoringManifestV3();
    correctedWithLegacySelector.selection.afterStepId = "review-documentation";
    const legacyWithCorrectedSelector = legacyAuthoringManifestV3();
    legacyWithCorrectedSelector.selection.afterStepId = "verify-technical-accuracy";
    const correctedWithLegacyDependencies = authoringManifestV3();
    correctedWithLegacyDependencies.prefix.steps[6]!.consumes = [
      "derive-source-obligations",
      "provisional-technical-verification",
    ];
    correctedWithLegacyDependencies.prefix.steps[6]!.consumesEvidence = [
      "derive-source-obligations",
      "provisional-technical-verification",
    ];

    for (const manifest of [
      correctedWithLegacySelector,
      legacyWithCorrectedSelector,
      correctedWithLegacyDependencies,
    ]) {
      expect(() => parse(manifest)).toThrow(/closed CREATE Manifest V3/u);
    }
  });

  it("rejects schedule, mode, branch, context, and technical-pairing drift", () => {
    const mutations: Array<(manifest: WorkflowManifestV3) => void> = [
      (manifest) => {
        manifest.prefix.steps[0]!.id = "arbitrary-step";
      },
      (manifest) => {
        manifest.branches[1].steps[0]!.mode = "read-only";
      },
      (manifest) => {
        manifest.branches.reverse();
      },
      (manifest) => {
        manifest.branches[1].contextPolicy.steps[0]!.allowReadOnlyDegraded = true;
      },
      (manifest) => {
        manifest.branches[1].steps[3]!.consumes = [
          "derive-source-obligations",
          "provisional-technical-verification",
        ];
      },
      (manifest) => {
        manifest.branches[0].steps[1]!.consumes = [
          "lint-documentation",
          "verify-revised-technical-accuracy",
          "review-documentation",
          "test-audience-understanding",
        ];
      },
    ];

    for (const mutate of mutations) {
      const manifest = authoringManifestV3();
      mutate(manifest);
      expect(() => parse(manifest)).toThrow();
    }
    expect(() =>
      parseWorkflowManifestSnapshot(authoringManifestV3(), "update-documentation", searchPlans),
    ).toThrow(/supported only for create-documentation/u);
  });

  it("preserves existing V1 and update V2 manifest parsing", () => {
    const review = JSON.parse(
      readFileSync(resolve(runtimeRoot, "workflows/review-documentation.json"), "utf8"),
    ) as unknown;
    const update = JSON.parse(
      readFileSync(resolve(runtimeRoot, "workflows/update-documentation.json"), "utf8"),
    ) as unknown;

    const parsedReview = parseWorkflowManifestSnapshot(review, "review-documentation", searchPlans);
    const parsedUpdate = parseWorkflowManifestSnapshot(update, "update-documentation", searchPlans);
    expect(parsedReview.schemaVersion).toBeUndefined();
    expect(parsedReview.steps.map((step) => step.id)).toEqual(
      (review as { steps: Array<{ id: string }> }).steps.map((step) => step.id),
    );
    expect(parsedUpdate.schemaVersion).toBe(2);
    expect(parsedUpdate.branching?.branches.map((branch) => branch.id)).toEqual([
      "author",
      "assess-no-change",
    ]);
  });
});
