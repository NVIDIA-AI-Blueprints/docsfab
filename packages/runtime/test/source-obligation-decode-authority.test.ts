// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The harness decodes a CREATE step-2 reply with its own step input, so a
 * citation outside the plan's bound sources is refused inside the attempt,
 * where the refusal keeps its attempt evidence, and not only after it.
 */
import { describe, expect, it } from "vitest";

import { InferenceStepError, type HarnessStepInput } from "../src/execution/contracts.js";
import { admitJudgmentReply } from "../src/harness/reply-admission/judgment.js";
import { createDocumentationPlanBinding } from "../src/workflow-execution/plan-binding.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import { searchStepEvidence } from "./helpers/search-evidence-fixture.js";
import { sourceObligationProposalFixture } from "./helpers/verification.js";

const PAGE = "docs/routing/guide.md";

function deriveInput(): HarnessStepInput {
  const workflow = getWorkflow("create-documentation");
  return {
    repositoryPath: "/workspace",
    workflow,
    step: workflow.steps.find((step) => step.id === "derive-source-obligations")!,
    planBinding: createDocumentationPlanBinding({
      mode: "create",
      pages: [{ path: PAGE, disposition: "create" }],
      sourceBindings: [{ pagePath: PAGE, sources: ["src/api.ts:1"] }],
    }),
    evidenceIdentity: { repositoryRevision: "a".repeat(40) },
    searchEvidence: searchStepEvidence({
      evidenceSha256: "b".repeat(64),
      workspaceSnapshotSha256: "c".repeat(64),
    }),
  };
}

async function admit(locator: string, finalInferenceAttempt = false) {
  const reply = JSON.stringify(sourceObligationProposalFixture(locator));
  return admitJudgmentReply({ ...deriveInput(), finalInferenceAttempt }, reply, {
    decodedResponse: reply,
    collectAttemptEvidence: () => ({}),
    refuseContractPlaceholder: () => undefined,
  });
}

describe("step-2 citation authority at the harness decode", () => {
  it("admits a reply citing only the plan's bound sources (positive control)", async () => {
    expect((await admit("src/api.ts:1")).sourceObligationProposal).toBeDefined();
  });

  it("correctably rejects a citation outside the bound sources until it is proposed", async () => {
    const error = await admit("tests/test_routing_contract.py:4").then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(InferenceStepError);
    expect((error as InferenceStepError).rejection).toEqual({
      code: "source-proposal-required",
      location: "$.dimensions[].sourceLocators[]",
    });
    expect((error as InferenceStepError).message).toBe(
      "Source-obligation response did not satisfy the host-owned contract under rule " +
        "source-proposal-required at $.dimensions[].sourceLocators[].",
    );
  });

  // A span-less citation outside the plan is corrected by declaring a path
  // proposal; it does not enter the authority until the host admits it.
  it.each([
    ["while a retry remains", false],
    ["on the final attempt", true],
  ])("refuses a span-less citation outside the bound sources (%s)", async (_when, final) => {
    const error = await admit("tests/test_routing_contract.py", final).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(InferenceStepError);
    expect(error).toMatchObject({
      retryable: true,
      rejection: { code: "source-proposal-required", location: "$.dimensions[].sourceLocators[]" },
    });
  });

  it("re-asks a span-less citation of a bound source for its line span (adjacent)", async () => {
    const error = await admit("src/api.ts").then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({
      retryable: true,
      rejection: {
        code: "source-locator-span-missing",
        location: "$.dimensions[].sourceLocators[]",
      },
    });
  });
});
