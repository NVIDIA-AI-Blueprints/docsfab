// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { parseDotenvAssignments } from "../src/config/dotenv.js";
import { parseRetryPolicy } from "../src/config/retry-policy.js";
import { COMPOSITION_EXECUTION_LIMITS } from "../src/config/runtime-loader.js";
import { ModelProfileMigrationError, parseModelEndpoint } from "../src/model/configuration.js";

const TEMPLATE = resolve(import.meta.dirname, "..", ".env.example");

async function templateValue(name: string): Promise<string | undefined> {
  const text = await readFile(TEMPLATE, "utf8");
  // Uncommented assignments only; the host does not load a commented line.
  const match = text.match(new RegExp(`^${name}=(.*)$`, "mu"));
  return match?.[1]?.trim();
}

/**
 * `.env.example` cannot import a constant, so the composition limits can drift
 * there silently, and as an override it wins the `Math.min` in
 * `deriveEffectiveLimits` over all three digest-sealed sources. The model
 * matrix copies it as its profile template, so a stale low value truncates
 * governed composition runs while static gates stay green.
 */
describe("shipped env template", () => {
  it("preserves the catalog retry count and delay defaults in a newly copied environment", async () => {
    const policy = parseRetryPolicy({});
    expect(await templateValue("DOCSFAB_READ_ONLY_MAX_RETRIES")).toBe(String(policy.maxRetries));
    expect(await templateValue("DOCSFAB_RETRY_BASE_DELAY_MS")).toBe(String(policy.baseDelayMs));
    expect(await templateValue("DOCSFAB_RETRY_MAX_DELAY_MS")).toBe(String(policy.maxDelayMs));
  });

  it("agrees with the shipped composition provider-turn default", async () => {
    expect(await templateValue("DOCSFAB_COMPOSITION_EXECUTION_MAX_PROVIDER_TURNS")).toBe(
      String(COMPOSITION_EXECUTION_LIMITS.maxProviderTurns.default),
    );
  });

  it("agrees with the shipped composition timeout default", async () => {
    expect(await templateValue("DOCSFAB_COMPOSITION_EXECUTION_TIMEOUT_MS")).toBe(
      String(COMPOSITION_EXECUTION_LIMITS.timeoutMs.default),
    );
  });

  it("does not impose the historical comparison response cap on ordinary configurations", async () => {
    expect(await templateValue("DOCSFAB_COMPOSITION_EXECUTION_MAX_RESPONSE_BYTES")).toBe(
      String(COMPOSITION_EXECUTION_LIMITS.maxResponseBytes.default),
    );
  });

  it("picks no model: a copy of the template alone lists the selection fields as missing", async () => {
    const template = Object.fromEntries(parseDotenvAssignments(await readFile(TEMPLATE, "utf8")));
    const failure = (() => {
      try {
        parseModelEndpoint(template);
      } catch (error) {
        return error;
      }
      return undefined;
    })();
    expect(failure).toBeInstanceOf(ModelProfileMigrationError);
    expect((failure as ModelProfileMigrationError).issues.map((issue) => issue.field)).toEqual([
      "MODEL_PROVIDER",
      "MODEL_BASE_URL",
      "MODEL_ID",
      "MODEL_API_KEY",
    ]);

    // Adjacent condition: once the operator sets the selection and key, the
    // rest of the template block is complete and parses.
    const selected = parseModelEndpoint({
      ...template,
      MODEL_PROVIDER: "openai-api",
      MODEL_BASE_URL: "https://api.openai.com/v1",
      MODEL_ID: "example/model",
      MODEL_API_KEY: "test-secret",
    });
    expect(selected.modelId).toBe("example/model");
  });

  it("is copied only by procedures that tell the operator to set the model selection", async () => {
    const procedures = [
      "docs/reference/model-governance/model-profiles.md",
      "docs/reference/model-governance/model-catalog-operations.md",
      "scripts/dogfood/create-documentation-no-doc/README.md",
    ];
    for (const path of procedures) {
      const text = (await readFile(resolve(import.meta.dirname, "..", path), "utf8"))
        .replaceAll("`", "")
        .replace(/\s+/gu, " ");
      const namesSelection = /MODEL_PROVIDER, MODEL_BASE_URL,? (?:and )?MODEL_ID/u.test(text);
      expect(namesSelection, path).toBe(true);
      expect(/example block is GPT-6 Sol/u.test(text), path).toBe(false);
    }
  });

  it("reads an uncommented assignment rather than matching documentation prose", async () => {
    // Positive control for the helper: the template documents this variable in
    // comments above the assignment, so a regex matching anywhere would read a
    // commented value.
    expect(await templateValue("DOCSFAB_COMPOSITION_EXECUTION_MAX_RESPONSE_BYTES")).toMatch(
      /^\d+$/u,
    );
    expect(await templateValue("DOCSFAB_THIS_KEY_DOES_NOT_EXIST")).toBeUndefined();
  });
});
