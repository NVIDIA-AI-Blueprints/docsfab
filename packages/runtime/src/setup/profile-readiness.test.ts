// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { CONSERVATIVE_MODEL_FALLBACK, type ModelProfile } from "../model/configuration.js";
import {
  assertLegacyPolicyProfileReady,
  inspectLegacyPolicyProfileReadiness,
} from "./profile-readiness.js";

function profile(overrides: Partial<ModelProfile>): ModelProfile {
  return {
    configuredLimits: {
      contextWindow: 1_000_000,
      maxInputTokens: 1_000_000,
      maxOutputTokens: 128_000,
    },
    contextWindow: CONSERVATIVE_MODEL_FALLBACK.contextWindow,
    maxInputTokens: CONSERVATIVE_MODEL_FALLBACK.contextWindow,
    maxOutputTokens: CONSERVATIVE_MODEL_FALLBACK.maxOutputTokens,
    effectiveLimitReason: "metadata-unknown",
    reasoning: false,
    input: ["text"],
    compatibility: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      apiFormats: ["chat_completions"],
    },
    costPerMillionTokens: {
      input: null,
      output: null,
      cacheRead: null,
      cacheWrite: null,
    },
    metadata: {
      approvedSource: null,
      effectiveDate: null,
      reviewAfter: null,
      status: "unknown",
    },
    ...overrides,
  };
}

describe("legacy policy profile readiness", () => {
  it("allows metadata-unknown profiles without inventing a host ceiling", () => {
    const readiness = inspectLegacyPolicyProfileReadiness(profile({}));
    expect(readiness.ready).toBe(true);
    expect(readiness.code).toBe("ready");
    expect(readiness.nextCommand).toBe("docsfab doctor");
    expect(readiness.explanation).toContain("does not invent a host context ceiling");
    expect(() => assertLegacyPolicyProfileReady(profile({}))).not.toThrow();
  });

  it("allows current approved profiles", () => {
    const ready = profile({
      contextWindow: 1_000_000,
      maxInputTokens: 1_000_000,
      maxOutputTokens: 128_000,
      effectiveLimitReason: "none",
      metadata: {
        approvedSource: "https://example.test/models/gpt-5.4",
        effectiveDate: "2026-08-04",
        reviewAfter: "2026-09-03",
        status: "current",
      },
    });
    expect(inspectLegacyPolicyProfileReadiness(ready).ready).toBe(true);
    expect(() => assertLegacyPolicyProfileReady(ready)).not.toThrow();
  });

  it("allows a profile whose review date has passed", () => {
    // The parser keeps such a profile `current`; readiness must not
    // re-derive a refusal from the date either.
    const overdue = profile({
      contextWindow: 1_000_000,
      maxInputTokens: 1_000_000,
      maxOutputTokens: 128_000,
      effectiveLimitReason: "none",
      metadata: {
        approvedSource: "https://example.test/models/gpt-5.4",
        effectiveDate: "2020-01-01",
        reviewAfter: "2020-02-01",
        status: "current",
      },
    });
    expect(overdue.metadata.reviewAfter! < new Date().toISOString().slice(0, 10)).toBe(true);
    expect(inspectLegacyPolicyProfileReadiness(overdue)).toEqual({
      ready: true,
      code: "ready",
      explanation: "The host policy profile can use its configured context limits.",
      nextCommand: "docsfab doctor",
    });
    expect(() => assertLegacyPolicyProfileReady(overdue)).not.toThrow();
  });

  it("does not refuse a legacy profile saved as stale", () => {
    // Adjacent condition: a legacy packet can still carry `metadata-stale`;
    // the date alone is never grounds to refuse a run.
    const stale = profile({
      effectiveLimitReason: "metadata-stale",
      metadata: {
        approvedSource: "https://example.test/models/gpt-5.4",
        effectiveDate: "2026-08-04",
        reviewAfter: "2026-09-03",
        status: "stale",
      },
    });
    expect(inspectLegacyPolicyProfileReadiness(stale).ready).toBe(true);
    expect(() => assertLegacyPolicyProfileReady(stale)).not.toThrow();
  });
});
