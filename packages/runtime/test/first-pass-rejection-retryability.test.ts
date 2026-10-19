// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * One closed table says which first-pass rejections get a hinted correction
 * round before the request stops, and the knowledge first pass holds a hint
 * for exactly those rules.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  FIRST_PASS_REJECTION_RETRYABILITY,
  isModelCorrectableFirstPassRule,
} from "../src/operator/first-pass-rejection-retryability.js";
import {
  classifyFirstPassFailure,
  FIRST_PASS_FAILURE_RULES,
} from "../src/operator/pre-record-failure.js";

const KNOWLEDGE_ASSESS = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../knowledge/src/first-pass/assess.mjs",
);

async function knowledgeCorrections(): Promise<Readonly<Record<string, string>>> {
  const module = (await import(pathToFileURL(KNOWLEDGE_ASSESS).href)) as {
    FIRST_PASS_CORRECTIONS: Readonly<Record<string, string>>;
  };
  return module.FIRST_PASS_CORRECTIONS;
}

const MODEL_CORRECTABLE = Object.entries(FIRST_PASS_REJECTION_RETRYABILITY)
  .filter(([, entry]) => entry.retry === "model-correctable")
  .map(([rule]) => rule)
  .sort();

describe("first-pass rejection retryability table", () => {
  it("classifies exactly the first-pass rule vocabulary", () => {
    expect(Object.keys(FIRST_PASS_REJECTION_RETRYABILITY).sort()).toEqual(
      [...FIRST_PASS_FAILURE_RULES].sort(),
    );
    for (const entry of Object.values(FIRST_PASS_REJECTION_RETRYABILITY)) {
      expect(entry.reason.length).toBeGreaterThan(0);
    }
  });

  it("matches the rules the knowledge first pass holds a correction hint for", async () => {
    const corrections = await knowledgeCorrections();
    expect(Object.keys(corrections).sort()).toEqual(MODEL_CORRECTABLE);
    for (const hint of Object.values(corrections)) expect(hint.length).toBeGreaterThan(0);
  });

  it.each([
    // The recorded create-live refusal and the recorded create-cli refusal.
    "evidence-span-binding",
    "assessment-binding-response-json",
    "assessment-binding-response-shape",
    "assessment-binding-response-rows",
    "response-truncated",
    "strict-json",
    "obligation-binding",
    "decomposition-omission",
    "status",
    "detail-shape",
  ])("lets a hinted round repair model-output rule %s", (rule) => {
    expect(isModelCorrectableFirstPassRule(rule)).toBe(true);
    const failure = classifyFirstPassFailure({ phase: "assessment", rule, location: "$response" });
    expect(failure?.kind).toBe("correct");
    expect(failure?.next).not.toContain("DocsFab's own first-pass evidence binding failed");
  });

  it.each([
    // Security and authority.
    "credential-material",
    "unsafe-target",
    // DocsFab built the prompt, provenance, and identity.
    "assessment-binding-prompt-shape",
    "assessment-binding-provenance",
    "assessment-binding-source-spans",
    "identity-binding",
    "identity-shape",
    "evidence-frame-nonce-source",
    // Operator input, planning, infrastructure, and bounds.
    "bound-source-unavailable",
    "insufficient-evidence",
    "model-connection-failed",
    "provider-stop-reason",
    "model-turn-budget-exhausted",
    "model-cumulative-token-budget-exhausted",
    "output-policy-limit",
    // No rule to state.
    "response-size",
    "invalid-response",
    "assessment-invalid",
  ])("keeps %s terminal", (rule) => {
    expect(isModelCorrectableFirstPassRule(rule)).toBe(false);
  });

  it("treats a rule outside the vocabulary as terminal", () => {
    expect(isModelCorrectableFirstPassRule("unknown-rule")).toBe(false);
    expect(isModelCorrectableFirstPassRule("toString")).toBe(false);
  });
});
