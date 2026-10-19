// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { HarnessStepInput } from "../src/execution/contracts.js";
import {
  buildHostStepPrompt,
  decodeEditorialAssessmentResponseV1,
  EDITORIAL_ENVELOPE_SHAPE_REJECTION,
} from "../src/harness/pi.js";
import { EditorialAssessmentEnvelopeError } from "../src/harness/editorial-response-contract.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import {
  bindReviewResponseContract,
  EDITORIAL_RESPONSE_CONTRACT,
  VERIFICATION_RESPONSE_CONTRACT,
} from "../src/workflow-execution/review-response.js";
import { PROVISIONAL_VERIFICATION_JUDGMENT_CONTRACT } from "../src/workflow-execution/source-obligation.js";
import { verificationResultFixture } from "./helpers/verification.js";

// Each prompt statement that fixes the reply top level is one outer shape.
const OUTER_SHAPE_STATEMENT = /\bone JSON object\b/giu;
const EDITORIAL_SKILLS = new Set([
  "verify-technical-accuracy",
  "review-documentation",
  "test-audience-understanding",
  "evaluate-document-quality",
]);

function outerShapeStatements(prompt: string): number {
  return prompt.match(OUTER_SHAPE_STATEMENT)?.length ?? 0;
}

function editorialFixture(): Omit<HarnessStepInput, "workflow" | "step"> {
  const readerContextInput = {
    schema_version: 1 as const,
    target_audience: "Orbit users",
    reader_job: "run an inspection",
    change_scope: ["docs/cli.md"],
    source_priority: ["public contract"],
    required_content: ["current command"],
    excluded_content: [],
    unresolved_questions: [],
  };
  const readerContext = {
    ...readerContextInput,
    impact_basis: {
      kind: "none" as const,
      rationale: "The admitted comparison preserves the documented public command.",
      evidence_refs: [{ uri: "repo://src/orbit.ts", sha256: "f".repeat(64) }],
    },
  };
  const policy = { id: "docsfab-documentation-quality", version: "v0.1", sha256: "b".repeat(64) };
  const readerContextProvenance = {
    schema_version: 1 as const,
    reader_context_sha256: "1".repeat(64),
    baseline_sha256: "a".repeat(64),
    admitted_revision: "d".repeat(40),
    workspace_snapshot_sha256: "2".repeat(64),
    repository_identity_sha256: "3".repeat(64),
    policy,
    comparison: { kind: "unknown" as const },
    sources: [
      { uri: "repo://src/orbit.ts", role: "public-contract" as const, sha256: "f".repeat(64) },
    ],
    observed_at: "2026-09-14T12:00:00.000Z",
    limitations: [],
  };
  const evidenceRefs = [
    {
      kind: "context-packet" as const,
      schemaVersion: 1 as const,
      digest: "c".repeat(64),
      repositoryRevision: "d".repeat(40),
      repositoryContentDigest: "e".repeat(64),
    },
  ];
  const candidateReference = {
    kind: "editorial-decision" as const,
    schemaVersion: 3 as const,
    digest: "4".repeat(64),
    repositoryRevision: "d".repeat(40),
    repositoryContentDigest: "2".repeat(64),
  };
  return {
    repositoryPath: "/tmp/repository",
    readerContextInput,
    readerContext,
    readerContextProvenance,
    readerTaskContext: {
      schemaVersion: 1 as const,
      kind: "docsfab-reader-task-context-completed" as const,
      inputOrigin: "explicit" as const,
      noChangeAssessment: "requires-evidence" as const,
      readerContextInput,
      readerContext,
      provenance: readerContextProvenance,
      baseline: {
        path: "profiles/docsfab-documentation-quality/reader-impact-baseline.md" as const,
        sha256: "a".repeat(64),
        content: "Use actual reader and source evidence.",
      },
      policy,
      prompt: "Completed host-validated reader task context.",
    },
    editorialEvidenceRefs: [...evidenceRefs, candidateReference],
    editorialCandidate: {
      reference: candidateReference,
      proposal: {
        schemaVersion: 1,
        kind: "docsfab-editorial-decision-proposal",
        candidate: "no-change",
        rationale: "The admitted comparison preserves the public option behavior.",
        evidenceRefs,
        limitations: [],
        impactBasis: readerContext.impact_basis,
      },
    },
  } as Omit<HarnessStepInput, "workflow" | "step">;
}

function updateEditorialAssessmentInputs(): HarnessStepInput[] {
  const workflow = getWorkflow("update-documentation");
  expect(workflow.schemaVersion).toBe(2);
  if (workflow.schemaVersion !== 2) return [];
  const inputs = workflow.branching.branches.flatMap((branch) =>
    branch.steps
      .filter((step) => EDITORIAL_SKILLS.has(step.skill) && step.id !== "derive-source-obligations")
      .map((step) => ({ ...editorialFixture(), workflow, step }) as HarnessStepInput),
  );
  expect(inputs.map((input) => input.step.id)).toEqual([
    "verify-technical-accuracy",
    "review-documentation",
    "test-audience-understanding",
    "evaluate-document-quality",
    "verify-technical-accuracy",
    "review-documentation",
    "test-audience-understanding",
    "evaluate-document-quality",
  ]);
  return inputs;
}

describe("update V2 editorial assessment prompts", () => {
  it("state exactly one outer response shape per step, owned by the envelope", () => {
    for (const input of updateEditorialAssessmentInputs()) {
      for (const attempt of [
        {},
        {
          inferenceAttempt: 2,
          responseCorrection: { rejection: { code: "editorial-envelope-shape", location: "$" } },
        },
      ]) {
        const prompt = buildHostStepPrompt({ ...input, ...attempt });
        expect(outerShapeStatements(prompt), input.step.skill).toBe(1);
        expect(prompt).toContain(
          "exactly two top-level keys, summary and editorialAssessmentProposal",
        );
        expect(prompt).not.toContain(VERIFICATION_RESPONSE_CONTRACT);
        expect(prompt).not.toContain(EDITORIAL_RESPONSE_CONTRACT);
        const envelopeAt = prompt.indexOf(
          "Runtime independent editorial assessment response contract (host-owned):",
        );
        expect(envelopeAt).toBeGreaterThan(0);
        const nestedHeader =
          input.step.skill === "verify-technical-accuracy"
            ? "Nested technical verification result contract (host-owned):"
            : input.step.skill === "review-documentation"
              ? "Nested editorial review result contract (host-owned):"
              : undefined;
        if (nestedHeader) {
          const nestedAt = prompt.indexOf(nestedHeader);
          expect(nestedAt).toBeGreaterThan(0);
          expect(nestedAt).toBeLessThan(envelopeAt);
        } else {
          expect(prompt).not.toContain("Nested ");
          expect(prompt).toContain("summary is one non-empty JSON string");
        }
      }
    }
  });

  it("keeps the top-level contracts for review workflows outside the envelope", () => {
    const workflow = getWorkflow("review-documentation");
    const input = (id: string) =>
      ({
        repositoryPath: "/tmp/repository",
        workflow,
        step: workflow.steps.find((step) => step.id === id)!,
      }) as HarnessStepInput;
    // Without a V2 ledger the provisional step keeps the full verification
    // contract its decoder admits; technical-correction-host-fill.test.ts covers
    // the V2 judgment prompt.
    const technical = buildHostStepPrompt(input("provisional-technical-verification"));
    expect(technical).toContain(VERIFICATION_RESPONSE_CONTRACT);
    expect(technical).not.toContain(PROVISIONAL_VERIFICATION_JUDGMENT_CONTRACT);
    expect(technical).not.toContain("Nested technical verification result contract");
    expect(outerShapeStatements(technical)).toBe(1);
    const editorial = buildHostStepPrompt(input("review-documentation"));
    expect(editorial).toContain(EDITORIAL_RESPONSE_CONTRACT);
    expect(outerShapeStatements(editorial)).toBe(1);
    const update = updateEditorialAssessmentInputs()[0]!;
    expect(bindReviewResponseContract(update).step.prompt).toContain(
      VERIFICATION_RESPONSE_CONTRACT,
    );
  });

  it("codes a top-level technical result as an envelope-shape rejection", () => {
    expect(EDITORIAL_ENVELOPE_SHAPE_REJECTION).toBe("editorial-envelope-shape");
    expect(() =>
      decodeEditorialAssessmentResponseV1(
        JSON.stringify(verificationResultFixture(["docs/cli.md"])),
        { nestedReviewResult: true },
      ),
    ).toThrow(EditorialAssessmentEnvelopeError);
    expect(() => decodeEditorialAssessmentResponseV1("not json")).not.toThrow(
      EditorialAssessmentEnvelopeError,
    );
  });
});
