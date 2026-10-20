// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * A CREATE source-obligation reply is checked against the plan's bound sources
 * inside the attempt, at the harness's own reply admission, so a refused
 * citation keeps its attempt evidence. The attempt records the refused
 * citation's path only when the host already knows it: one of the plan's write
 * paths, or a tracked regular file at the run's revision.
 */
import { describe, expect, it } from "vitest";

import { limit } from "../src/config/limits.js";
import { InferenceStepError, type HarnessStepInput } from "../src/execution/contracts.js";
import {
  changedPathsRejectionSubject,
  isInferenceRejectionSubject,
  sourcePathRejectionSubject,
} from "../src/execution/rejection-subject.js";
import { admitJudgmentReply } from "../src/harness/reply-admission/judgment.js";
import {
  convertCreatePlanPageToUpdate,
  documentationPlanBindingDigest,
  validateDocumentationPlanBinding,
} from "../src/workflow-execution/plan-binding.js";
import { SourceObligationSourceReferenceError } from "../src/workflow-execution/source-obligation.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import { sourceObligationProposalFixture } from "./helpers/verification.js";
import { searchStepEvidence } from "./helpers/search-evidence-fixture.js";

const PAGE = "docs/routing/guide.md";
const SOURCE = "src/api.ts";
const TRACKED_UNBOUND = "tests/test_routing_contract.py";

/**
 * A converted CREATE plan: one existing page and its bound sources. Sealed
 * directly, as a saved record holds it, so a binding that planner admission
 * refuses can still reach derivation.
 */
function convertedPlan(sources = [`${SOURCE}:1`]) {
  const pages = [{ path: PAGE, disposition: "create" as const }];
  const sourceBindings = [{ pagePath: PAGE, sources: [...sources].sort() }];
  const sealed = validateDocumentationPlanBinding({
    kind: "docsfab-documentation-plan",
    schemaVersion: 1,
    mode: "create",
    pages,
    sourceBindings,
    digest: documentationPlanBindingDigest({ mode: "create", pages, sourceBindings }),
  });
  return convertCreatePlanPageToUpdate(
    sealed,
    { path: PAGE, baseSha256: "d".repeat(64) },
    "create-target-exists",
  );
}

function deriveInput(overrides: Partial<HarnessStepInput> = {}): HarnessStepInput {
  const workflow = getWorkflow("create-documentation");
  return {
    repositoryPath: "/workspace",
    workflow,
    step: workflow.steps.find((step) => step.id === "derive-source-obligations")!,
    planBinding: convertedPlan(),
    evidenceIdentity: { repositoryRevision: "a".repeat(40) },
    searchEvidence: searchStepEvidence({
      evidenceSha256: "b".repeat(64),
      workspaceSnapshotSha256: "c".repeat(64),
    }),
    trackedRepositoryPaths: new Set([SOURCE, PAGE, TRACKED_UNBOUND]),
    ...overrides,
  };
}

async function admit(input: HarnessStepInput, locator: string) {
  const reply = JSON.stringify(sourceObligationProposalFixture(locator));
  return admitJudgmentReply(input, reply, {
    decodedResponse: reply,
    collectAttemptEvidence: () => ({}),
    refuseContractPlaceholder: () => undefined,
  });
}

async function refusal(input: HarnessStepInput, locator: string): Promise<InferenceStepError> {
  try {
    await admit(input, locator);
  } catch (error) {
    expect(error).toBeInstanceOf(InferenceStepError);
    return error as InferenceStepError;
  }
  throw new Error("Expected the source-obligation reply to be refused in the attempt.");
}

describe("CREATE citation authority inside the attempt", () => {
  it("admits a reply citing only the plan's bound sources (positive control)", async () => {
    const admitted = await admit(deriveInput(), `${SOURCE}:1`);
    expect(admitted.sourceObligationProposal).toEqual(
      sourceObligationProposalFixture(`${SOURCE}:1`),
    );
  });

  it.each([
    ["with a line span", `${PAGE}:3`],
    ["without a line span", PAGE],
  ])(
    "refuses a citation of the converted page %s as a correctable write-target-source",
    async (_name, locator) => {
      const error = await refusal(deriveInput(), locator);
      expect(error.message).toBe(
        "Source-obligation response did not satisfy the host-owned contract under rule " +
          "write-target-source at $.dimensions[].sourceLocators[].",
      );
      expect(error.retryable).toBe(true);
      expect(error.rejection).toEqual({
        code: "write-target-source",
        location: "$.dimensions[].sourceLocators[]",
      });
      expect(error.rejectionSubject).toEqual({ kind: "source-path", path: PAGE });
    },
  );

  it("records a tracked file outside the bound sources by its path", async () => {
    const error = await refusal(deriveInput(), `${TRACKED_UNBOUND}:4-9`);
    expect(error.rejection?.code).toBe("source-proposal-required");
    expect(error.retryable).toBe(true);
    expect(error.rejectionSubject).toEqual({ kind: "source-path", path: TRACKED_UNBOUND });
  });

  it("withholds a cited path the host does not know", async () => {
    const error = await refusal(deriveInput(), "notes/made-up-plan.md:1");
    expect(error.rejection?.code).toBe("source-proposal-required");
    expect(error.rejectionSubject).toEqual({ kind: "source-path", withheld: "not-host-known" });
  });

  it("knows only the plan's write paths when the step has no tracked file set", async () => {
    const input = deriveInput({ trackedRepositoryPaths: undefined });
    expect((await refusal(input, `${PAGE}:3`)).rejectionSubject).toEqual({
      kind: "source-path",
      path: PAGE,
    });
    expect((await refusal(input, `${TRACKED_UNBOUND}:4`)).rejectionSubject).toEqual({
      kind: "source-path",
      withheld: "not-host-known",
    });
  });

  it("checks no CREATE authority outside a CREATE plan (adjacent: review)", async () => {
    const workflow = getWorkflow("review-documentation");
    const step = workflow.steps.find((candidate) => candidate.id === "derive-source-obligations")!;
    const admitted = await admit(
      deriveInput({ workflow, step, planBinding: undefined }),
      `${TRACKED_UNBOUND}:4`,
    );
    expect(admitted.sourceObligationProposal).toBeDefined();
  });

  it("keeps a plan whose source is its own write target a host fault, not a reply refusal", async () => {
    const input = deriveInput({ planBinding: convertedPlan([`${SOURCE}:1`, `${PAGE}:1`]) });
    await expect(admit(input, `${SOURCE}:1`)).rejects.toBeInstanceOf(
      SourceObligationSourceReferenceError,
    );
    await expect(admit(input, `${SOURCE}:1`)).rejects.toThrow(
      "A documentation plan cannot use an authorized write target as original source evidence.",
    );
  });
});

describe("rejection subject shape", () => {
  it("lists changed paths sorted and distinct, and keeps counts over the bound", () => {
    expect(changedPathsRejectionSubject([PAGE, PAGE], [])).toEqual({
      kind: "changed-paths",
      declared: [PAGE],
      observed: [],
    });
    const many = Array.from({ length: 65 }, (_, index) => `docs/page-${String(index)}.md`);
    expect(changedPathsRejectionSubject(many, [PAGE])).toEqual({
      kind: "changed-paths",
      withheld: "over-bound",
      declaredCount: 65,
      observedCount: 1,
    });
  });

  it("withholds a known path longer than the retained bound instead of cutting it", () => {
    const bound = limit("inference.rejectionSubjectPathMaxChars").value;
    const atBound = `docs/${"a".repeat(bound - "docs/".length)}`;
    expect(sourcePathRejectionSubject(atBound, () => true)).toEqual({
      kind: "source-path",
      path: atBound,
    });
    expect(sourcePathRejectionSubject(`${atBound}b`, () => true)).toEqual({
      kind: "source-path",
      withheld: "over-bound",
    });
  });

  it.each([
    ["an absolute path", "/etc/passwd"],
    ["a parent segment", "docs/../secret"],
    ["a control character", "docs/a\nb.md"],
    ["a backslash", "docs\\a.md"],
  ])("never records %s even when the host claims to know it", (_name, path) => {
    expect(sourcePathRejectionSubject(path, () => true)).toEqual({
      kind: "source-path",
      withheld: "not-host-known",
    });
  });

  it.each([
    ["free text", { kind: "source-path", path: "docs/a.md", note: "x" }],
    ["unsorted lists", { kind: "changed-paths", declared: ["b", "a"], observed: [] }],
    ["an open withheld reason", { kind: "source-path", withheld: "because" }],
    ["an unknown kind", { kind: "reply", text: "x" }],
  ])("refuses a recorded subject with %s", (_name, value) => {
    expect(isInferenceRejectionSubject(value)).toBe(false);
  });
});
