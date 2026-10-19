// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The tool-call answer path (#1707) reads its member names from the answer
 * key set and its model-facing sentences from the `quality-submission`
 * catalog host text, never from literals of its own: with both sources
 * replaced here, the shell and the contract follow them.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/contracts/model-output.generated.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/contracts/model-output.generated.js")>();
  return {
    ...actual,
    OUTPUT_HOST_TEXT: Object.fromEntries(
      Object.entries(actual.OUTPUT_HOST_TEXT).map(([id, text]) => [
        id,
        id.startsWith("quality-submission-") ? `CATALOG ${id}` : text,
      ]),
    ),
  };
});

/** Whether the answer key set is replaced; the advisory tool's case keeps the real one. */
const keySet = vi.hoisted(() => ({ renamed: true }));

vi.mock("../src/execution/response-contract-keys.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/execution/response-contract-keys.js")>();
  return {
    ...actual,
    get QUALITY_ARTIFACT_ANSWER_KEYS() {
      return keySet.renamed ? ["evaluation", "renamedScore"] : actual.QUALITY_ARTIFACT_ANSWER_KEYS;
    },
  };
});

const { bindQualityArtifactResponseContract } = await import(
  "../src/harness/editorial-response-contract.js"
);
const { buildSubmissionShell } = await import("../src/harness/answer-submission.js");
const {
  qualitySubmissionParameters,
  createQualitySubmissionTool,
  createQualityCandidateValidationTool,
} = await import("../src/harness/quality-candidate-tool.js");
const { getWorkflow } = await import("../src/workflow-registry/catalog.js");

const SELECTION = {
  selectionSha256: "a".repeat(64),
  profileAssetPath: "profiles/p.json",
  profilePayloadSha256: "c".repeat(64),
} as never;

afterEach(() => {
  keySet.renamed = true;
});

describe("the tool-call answer path's sources", () => {
  it("builds the shell from the answer key set", () => {
    // The evaluator has a type for each member it knows; an unknown member is refused.
    expect(() => qualitySubmissionParameters(SELECTION, "untyped")).toThrow(
      /missing a member description or type/u,
    );
    const shell = buildSubmissionShell({
      keys: ["evaluation", "renamedScore"],
      argumentShell: "untyped",
      descriptions: { evaluation: "e", renamedScore: "r" },
      types: { evaluation: "object", renamedScore: ["object", "null"] },
    });
    expect(Object.keys(shell.properties)).toEqual(["evaluation", "renamedScore"]);
  });

  it("states the contract, the tool, and the descriptions from catalog host text", () => {
    const workflow = getWorkflow("review-documentation");
    const step = workflow.steps.find((entry) => entry.skill === "evaluate-document-quality")!;
    const prompt = bindQualityArtifactResponseContract({
      workflow,
      step,
      repositoryPath: "/workspace",
      qualityProfileSelection: SELECTION,
      answerSubmission: { path: "tool-call", reason: "recorded-route" },
    } as never).step.prompt;
    for (const id of [
      "quality-submission-contract-call",
      "quality-submission-contract-report",
      "quality-submission-contract-validate",
      "quality-submission-contract-validate-scope",
      "quality-submission-contract-null-score",
      "quality-submission-contract-report-not-proof",
    ]) {
      expect(prompt).toContain(`CATALOG ${id}`);
    }
    expect(() =>
      createQualitySubmissionTool({ selection: SELECTION, argumentShell: "untyped" }),
    ).toThrow(/missing a member description or type/u);
  });

  it("describes the advisory tool on the tool-call path from catalog host text", () => {
    keySet.renamed = false;
    const tool = createQualityCandidateValidationTool({
      selection: SELECTION,
      technicalVerification: {} as never,
      submission: { argumentShell: "typed", rawArguments: () => undefined },
    });
    expect(tool.description).toBe("CATALOG quality-submission-advisory-tool-description");
    expect(tool.promptSnippet).toBe("CATALOG quality-submission-advisory-prompt-snippet");
    expect(tool.promptGuidelines).toEqual([
      "CATALOG quality-submission-advisory-guideline-arguments",
      "CATALOG quality-submission-advisory-guideline-correct",
    ]);
  });
});
