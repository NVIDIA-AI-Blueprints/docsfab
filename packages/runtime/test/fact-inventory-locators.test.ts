// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { HarnessStepInput } from "../src/execution/contracts.js";
import { buildHostStepPrompt } from "../src/harness/pi.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import { createDocumentationPlanBinding } from "../src/workflow-execution/plan-binding.js";
import { executeInferenceStep } from "../src/workflow-execution/retry.js";
import {
  authoritativeReviewTargetPaths,
  decodeVerificationResponse,
  SOURCE_LOCATOR_RULE,
  type VerificationResult,
} from "../src/workflow-execution/review-response.js";

/**
 * Locator shapes from recorded restructure runs refused with
 * `inventory-fact-locators @ $.factInventory`: facts citing the plan's
 * whole-file source identity `README.md@<repository revision>` next to a line
 * locator. Statements are synthetic; only the locator shapes are recorded.
 */
const REVISION = "810f0ae3875fd192d5a9e27c6ea12cc2d8d7e146";
const WHOLE_FILE_IDENTITY = `README.md@${REVISION}`;

const planBinding = createDocumentationPlanBinding({
  mode: "restructure",
  pages: [
    { path: "docs/guide.md", disposition: "move" },
    { path: "docs/quickstart.md", disposition: "retain" },
    { path: "README.md", disposition: "out-of-scope" },
  ],
  sourceBindings: [
    {
      pagePath: "docs/guide.md",
      sources: [`docs/guide.md@${REVISION}`, `docs/quickstart.md@${REVISION}`, WHOLE_FILE_IDENTITY],
    },
  ],
});

const workflow = getWorkflow("restructure-documentation");
const verifyStep = workflow.steps.find((step) => step.id === "verify-technical-accuracy")!;
const verifyInput = {
  repositoryPath: "/tmp/repository",
  workflow,
  step: verifyStep,
  planBinding,
  evidenceIdentity: { repositoryRevision: REVISION },
} as HarnessStepInput;
const targetPaths = authoritativeReviewTargetPaths(verifyInput)!;

function fact(id: string, dimension: string, sourceLocators: string[]) {
  return {
    id,
    dimension,
    sourceLocators,
    statement: `Synthetic ${dimension} fact for the recorded locator shape.`,
    documentationDisposition: "documented",
    uncertainty: "None for this fixture.",
    issueIds: [],
  };
}

/** The recorded restructure inventory as the host admitted it on retry. */
function admittedRestructureResult(): VerificationResult {
  return {
    review: { verdict: "pass", issues: [] },
    coverage: targetPaths.map((path) => ({
      path,
      status: "verified",
      evidence: ["src/sprout.mjs:3-27"],
      reason: "Preserved claims were checked against the cited source lines.",
    })),
    factInventory: {
      completeness: "bounded-not-proven",
      dimensions: [
        {
          dimension: "input-representations",
          status: "applicable",
          reason: "Command arguments are part of the restructured guide.",
          sourceLocators: [],
          facts: [fact("FACT-001", "input-representations", ["src/sprout.mjs:8-20"])],
        },
        {
          dimension: "defaults-and-overrides",
          status: "applicable",
          reason: "The default greeting name is documented.",
          sourceLocators: [],
          facts: [fact("FACT-002", "defaults-and-overrides", ["src/sprout.mjs:12-13"])],
        },
        {
          dimension: "mutable-state",
          status: "not-applicable",
          reason: "The cited source keeps no mutable state in scope.",
          sourceLocators: ["src/sprout.mjs:12-20"],
          facts: [],
        },
        {
          dimension: "destination-and-trust",
          status: "applicable",
          reason: "Output goes to standard output only.",
          sourceLocators: [],
          facts: [fact("FACT-006", "destination-and-trust", ["src/sprout.mjs:5", "README.md:3"])],
        },
        {
          dimension: "error-status-retry",
          status: "applicable",
          reason: "Unknown commands exit with an error.",
          sourceLocators: [],
          facts: [fact("FACT-007", "error-status-retry", ["src/sprout.mjs:22-24"])],
        },
        {
          dimension: "environment-prerequisite",
          status: "applicable",
          reason: "The guide states the runtime requirement.",
          sourceLocators: [],
          facts: [
            fact("FACT-008", "environment-prerequisite", ["README.md:3", "src/sprout.mjs:1"]),
          ],
        },
      ],
      limitations: [],
    },
  } as VerificationResult;
}

/** The same inventory with the recorded refused locators on FACT-006 and FACT-008. */
function refusedRestructureResult(): VerificationResult {
  const result = admittedRestructureResult();
  const facts = result.factInventory.dimensions.flatMap((dimension) => dimension.facts);
  facts.find((item) => item.id === "FACT-006")!.sourceLocators = [
    "src/sprout.mjs:5",
    WHOLE_FILE_IDENTITY,
  ];
  facts.find((item) => item.id === "FACT-008")!.sourceLocators = [
    WHOLE_FILE_IDENTITY,
    "src/sprout.mjs:1",
  ];
  return result;
}

function rejectionOf(value: unknown): unknown {
  try {
    decodeVerificationResponse(JSON.stringify(value), targetPaths);
  } catch (error) {
    return error;
  }
  throw new Error("expected the verification response to be rejected");
}

function retryFeedback(prompt: string): string {
  const marker = "Host validation feedback for this bounded retry:";
  const start = prompt.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  return prompt.slice(start);
}

describe("restructure fact-inventory locators (#1220)", () => {
  it("admits the recorded restructure inventory with line-specific locators", () => {
    const admitted = decodeVerificationResponse(
      JSON.stringify(admittedRestructureResult()),
      targetPaths,
    );
    expect(admitted.factInventory.dimensions).toHaveLength(6);
  });

  it.each([
    ["the recorded whole-file plan identity", WHOLE_FILE_IDENTITY],
    ["a plan identity with a line suffix", `README.md@${REVISION}:3`],
    ["a bare whole-file path", "README.md"],
  ])("refuses %s as a fact locator with a retryable inventory-fact-locators code", (_, locator) => {
    const value = admittedRestructureResult();
    value.factInventory.dimensions[3]!.facts[0]!.sourceLocators = ["src/sprout.mjs:5", locator];
    expect(rejectionOf(value)).toMatchObject({
      retryable: true,
      rejection: { code: "inventory-fact-locators", location: "$.factInventory" },
    });
  });

  it("states the locator rule in the restructure verification contract beside @revision plan identities", () => {
    const prompt = buildHostStepPrompt(verifyInput);
    expect(prompt).toContain(WHOLE_FILE_IDENTITY);
    expect(prompt).toContain(SOURCE_LOCATOR_RULE);
    expect(prompt).not.toContain("Host validation feedback");
  });

  it("re-asks the recorded refusal with a hint that names the failing locator rule", async () => {
    const feedback: unknown[] = [];
    const prompts: string[] = [];
    const result = await executeInferenceStep({
      mode: "read-only",
      policy: {
        maxRetries: 1,
        baseDelayMs: 0,
        maxDelayMs: 0,
        retryableCategories: ["malformed-response"],
      },
      sleep: async () => {},
      execute: async (attempt, correction) => {
        feedback.push(correction);
        prompts.push(
          buildHostStepPrompt({
            ...verifyInput,
            inferenceAttempt: attempt,
            ...(correction ? { responseCorrection: correction } : {}),
          }),
        );
        const response = attempt === 1 ? refusedRestructureResult() : admittedRestructureResult();
        return {
          summary: JSON.stringify(
            decodeVerificationResponse(JSON.stringify(response), targetPaths),
          ),
        };
      },
    });
    expect(result.status).toBe("succeeded");
    expect(result.evidence.attempts[0]).toMatchObject({
      outcome: "malformed-response",
      rejection: { code: "inventory-fact-locators", location: "$.factInventory" },
    });
    expect(feedback).toEqual([
      undefined,
      { rejection: { code: "inventory-fact-locators", location: "$.factInventory" } },
    ]);
    const hint = retryFeedback(prompts[1]!);
    expect(hint).toContain("inventory-fact-locators");
    expect(hint).toContain(SOURCE_LOCATOR_RULE);
    // The hint is host-authored: it never echoes the refused locator.
    expect(hint).not.toContain(REVISION);
    expect(hint).not.toContain("Check every required field");
  });
});
