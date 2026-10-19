// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { executeInferenceStep } from "../src/workflow-execution/retry.js";
import {
  decodeVerificationResponse,
  validateVerificationResult,
  wrapTechnicalReviewFailure,
} from "../src/workflow-execution/review-response.js";
import { buildDocsFabStepPrompt } from "../src/harness/pi-session.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import { bindReviewResponseContract } from "../src/workflow-execution/review-response.js";
import { VerificationResultContractError } from "../src/workflow-execution/review-response.js";
import {
  unverifiedVerificationResultFixture,
  verificationResultFixture,
} from "./helpers/verification.js";
import { configureCredential } from "./helpers/configured-credential.js";
import { plantedCredentialValue } from "./helpers/planted-credential.js";

const completed = verificationResultFixture(["docs/page.md"]);

describe("technical verification completion", () => {
  it.each([
    [
      "dimension-locators",
      (value: typeof completed) => {
        value.factInventory.dimensions[0]!.sourceLocators = ["src/api.ts:42"];
      },
    ],
    [
      "dimension-facts",
      (value: typeof completed) => {
        value.factInventory.dimensions[0]!.facts = [];
      },
    ],
    [
      "fact-identity",
      (value: typeof completed) => {
        value.factInventory.dimensions[0]!.facts[0]!.id = "invalid";
      },
    ],
    [
      "fact-locators",
      (value: typeof completed) => {
        value.factInventory.dimensions[0]!.facts[0]!.sourceLocators = ["src/api.ts"];
      },
    ],
    [
      "fact-finding-link",
      (value: typeof completed) => {
        value.factInventory.dimensions[0]!.facts[0]!.documentationDisposition = "omitted";
      },
    ],
    [
      "limitation-link",
      (value: typeof completed) => {
        value.factInventory.dimensions[0]!.status = "unverified";
        value.factInventory.dimensions[0]!.facts = [];
      },
    ],
  ] as const)("retains the finite inventory %s reason across host wrappers", (detail, change) => {
    const value = structuredClone(completed);
    change(value);
    let failure: unknown;
    try {
      decodeVerificationResponse(JSON.stringify(value));
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      retryable: true,
      rejection: { code: `inventory-${detail}`, location: "$.factInventory" },
    });
    expect(wrapTechnicalReviewFailure(failure).rejection).toEqual({
      code: `inventory-${detail}`,
      location: "$.factInventory",
    });
    expect(JSON.stringify(wrapTechnicalReviewFailure(failure))).not.toContain("src/api.ts");
  });

  it("uses the configured read-only retry to recover a rejected verification envelope", async () => {
    const result = await executeInferenceStep({
      mode: "read-only",
      policy: {
        maxRetries: 1,
        baseDelayMs: 0,
        maxDelayMs: 0,
        retryableCategories: ["malformed-response"],
      },
      execute: async (attempt) => {
        const response =
          attempt === 1
            ? {
                ...completed,
                factInventory: { ...completed.factInventory, completeness: "complete" },
              }
            : completed;
        const admitted = decodeVerificationResponse(JSON.stringify(response), ["docs/page.md"]);
        return { summary: JSON.stringify(admitted) };
      },
    });
    expect(result.status).toBe("succeeded");
    expect(result.evidence.attempts.map((attempt) => attempt.retryDecision)).toEqual([
      "retried",
      "not-applicable",
    ]);
  });

  it("stops malformed verification at the configured retry boundary", async () => {
    const result = await executeInferenceStep({
      mode: "read-only",
      policy: {
        maxRetries: 1,
        baseDelayMs: 0,
        maxDelayMs: 0,
        retryableCategories: ["malformed-response"],
      },
      execute: async () => {
        decodeVerificationResponse(JSON.stringify({ ...completed, coverage: [] }), [
          "docs/page.md",
        ]);
        return { summary: "unreachable" };
      },
    });
    expect(result.status).toBe("failed");
    expect(result.evidence.attempts.map((attempt) => attempt.retryDecision)).toEqual([
      "retried",
      "exhausted",
    ]);
  });

  it("retains a content-free syntax reason across bounded attempts", async () => {
    const result = await executeInferenceStep({
      mode: "read-only",
      policy: {
        maxRetries: 0,
        baseDelayMs: 0,
        maxDelayMs: 0,
        retryableCategories: ["malformed-response"],
      },
      execute: async () => {
        decodeVerificationResponse('{"review":"unfinished');
        return { summary: "unreachable" };
      },
    });
    expect(result.status).toBe("failed");
    expect(result.evidence.attempts[0]?.rejection).toEqual({
      code: "json-unexpected-end",
      location: "$response",
    });
    expect(JSON.stringify(result.evidence)).not.toContain("unfinished");
  });

  it("accepts grounded zero-findings evidence without requiring tool calls", () => {
    expect(decodeVerificationResponse(JSON.stringify(completed), ["docs/page.md"])).toEqual(
      completed,
    );
  });

  it.each([
    ["envelope", { ...completed, unexpected: true }],
    ["review", { ...completed, review: { verdict: "invalid", issues: [] } }],
    ["coverage", { ...completed, coverage: [{ ...completed.coverage[0], path: "docs/other.md" }] }],
    [
      "fact-inventory",
      {
        ...completed,
        factInventory: {
          ...completed.factInventory,
          dimensions: completed.factInventory.dimensions.map((dimension, index) =>
            index === 0
              ? {
                  ...dimension,
                  facts: dimension.facts.map((fact) => ({
                    ...fact,
                    documentationDisposition: "omitted",
                    issueIds: [],
                  })),
                }
              : dimension,
          ),
        },
      },
    ],
    [
      "consistency",
      {
        ...completed,
        coverage: completed.coverage.map((entry) => ({
          ...entry,
          status: "unverified",
          evidence: [],
        })),
      },
    ],
  ])("reports the fixed %s validation boundary without rejected values", (stage, value) => {
    let failure: unknown;
    try {
      validateVerificationResult(value, ["docs/page.md"]);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(VerificationResultContractError);
    expect(failure).toMatchObject({ stage, retryable: true });
    expect((failure as Error).message).not.toContain("docs/other.md");
    expect((failure as Error).message).not.toContain("invalid");
  });

  it("does not disclose a rejected configured credential in verification content", () => {
    // Only one of DocsFab's own configured credentials is refused (#1807).
    const sensitiveValue = configureCredential(["glpat", plantedCredentialValue(77, 24)].join("-"));
    const value = structuredClone(completed);
    value.factInventory.dimensions[0]!.facts[0]!.statement = sensitiveValue;
    let failure: unknown;
    try {
      validateVerificationResult(value, ["docs/page.md"]);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(VerificationResultContractError);
    expect((failure as Error).message).not.toContain(sensitiveValue);

    // A statement with a credential shape that is not configured is admitted.
    const shaped = structuredClone(completed);
    shaped.factInventory.dimensions[0]!.facts[0]!.statement = [
      "glpat",
      plantedCredentialValue(78, 24),
    ].join("-");
    expect(() => validateVerificationResult(shaped, ["docs/page.md"])).not.toThrow();
  });

  it.each([
    ["I'll perform a fresh technical review.", "invalid-json"],
    [JSON.stringify({ review: { verdict: "pass", issues: [] } }), "invalid-shape"],
    [JSON.stringify({ ...completed, coverage: [] }), "invalid-coverage"],
    [
      JSON.stringify({ ...completed, coverage: [{ ...completed.coverage[0], evidence: [] }] }),
      "invalid-coverage",
    ],
    [
      JSON.stringify({
        ...completed,
        coverage: [{ ...completed.coverage[0], status: "unverified" }],
      }),
      "inconsistent-verdict",
    ],
    [
      JSON.stringify({ ...completed, review: { verdict: "needs-revision", issues: [] } }),
      "inconsistent-verdict",
    ],
  ])("rejects incomplete response %s as %s", (response, rejectionCode) => {
    expect(() => decodeVerificationResponse(response)).toThrow(
      `Technical review response rejected: ${rejectionCode}.`,
    );
  });

  it("rejects missing, duplicate, and extra page coverage", () => {
    expect(() => validateVerificationResult(completed, ["docs/other.md"])).toThrow();
    expect(() =>
      validateVerificationResult(completed, ["docs/page.md", "docs/other.md"]),
    ).toThrow();
    expect(() =>
      validateVerificationResult({
        ...completed,
        coverage: [...completed.coverage, ...completed.coverage],
      }),
    ).toThrow();
  });

  it("retains explicit unavailable evidence without claiming a pass", () => {
    const unavailable = unverifiedVerificationResultFixture(
      ["docs/page.md"],
      "The referenced source revision is unavailable.",
    );
    expect(validateVerificationResult(unavailable)).toEqual(unavailable);
  });

  it("uses the existing findings schema and rejects unsupported findings", () => {
    expect(() =>
      validateVerificationResult({
        ...completed,
        review: { verdict: "needs-revision", issues: [{ finding: "Wrong API" }] },
      }),
    ).toThrow();
  });

  it("binds the response contract to verification prompts", () => {
    const workflow = getWorkflow("review-documentation");
    const step = workflow.steps.find((entry) => entry.id === "provisional-technical-verification")!;
    const prompt = buildDocsFabStepPrompt(
      bindReviewResponseContract({
        workflow,
        step,
        repositoryPath: "/tmp/repository",
        contextTarget: { sourcePath: "docs/requested.md" },
      }),
    );
    expect(prompt).toContain("Runtime technical verification response contract");
    expect(prompt).toContain("review-result.schema.json");
    expect(prompt).toContain("never a promise to review later");
    expect(prompt).toContain('Authoritative verification target: ["docs/requested.md"]');
  });
});
