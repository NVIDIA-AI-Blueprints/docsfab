// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  COMPOSITION_EXECUTION_LIMITS,
  loadConfiguredCompositionModelLimits,
  loadCompositionExecutionEnvelope,
} from "../src/config/runtime-loader.js";
import { answerSubmissionRecordsFitForEffectiveLimits } from "../src/model/operator-execution-binding.js";
import type { BoundInstalledComposition } from "../src/model-composition/index.js";
import { validModelConfig } from "./helpers.js";

// Flattened from the table rather than re-listed, so a field added there is
// covered here without an edit.
const SHIPPED_DEFAULTS = Object.fromEntries(
  Object.entries(COMPOSITION_EXECUTION_LIMITS).map(([field, bounds]) => [field, bounds.default]),
) as { [K in keyof typeof COMPOSITION_EXECUTION_LIMITS]: number };

describe("host-configured execution operational limits", () => {
  it("recomputes records fit from sealed evidence at effective output, turn, and timer clamps", () => {
    const syntheticBound = {
      composition: {
        answerSubmissionRecords: {
          phaseBMaxAdmittedMessageBytes: 18_743,
          minimumQualifiedMessageBytes: 6_144,
          maxMessageBytes: 18_743,
          groupEnvelopeBytes: [
            { group: 1, maxBytes: 10_000 },
            { group: 2, maxBytes: 8_000 },
          ],
          fullPlanEnvelopeBytes: 18_000,
          largestRecordEnvelopeBytes: 3_000,
          lturnMs: 8_000,
          decodeTokensPerSecond: 100,
          readingTurnsP90: 2,
          step8TurnEvidence: {
            projectedReportTokens: 2_700,
            samples: [{ d3ResidualFires: "unknown" }],
          },
        },
      },
    } as unknown as BoundInstalledComposition;

    const roomy = answerSubmissionRecordsFitForEffectiveLimits({
      bound: syntheticBound,
      effectiveLimits: { maxOutputTokens: 8_192, maxProviderTurns: 12, timeoutMs: 600_000 },
      environment: {},
    });
    const narrowed = answerSubmissionRecordsFitForEffectiveLimits({
      bound: syntheticBound,
      effectiveLimits: { maxOutputTokens: 1_024, maxProviderTurns: 4, timeoutMs: 60_000 },
      environment: {},
    });

    expect(roomy).toMatchObject({
      effectiveMaxMessageBytes: 18_743,
      messages: 2,
      fitsQualifiedMessageFloor: true,
      fitsRecordBoundary: true,
      fitsReadingTurns: true,
      fitsEffectiveTimer: true,
      d3ResidualSource: "unobserved-conservative-reserve",
    });
    expect(narrowed).toMatchObject({
      effectiveMaxMessageBytes: 2_342,
      fitsQualifiedMessageFloor: false,
      fitsRecordBoundary: false,
      fitsReadingTurns: false,
      fitsEffectiveTimer: false,
    });
  });

  it("loads the execution spending allowance through real consumer defaults and preserves lower host policy", () => {
    expect(loadCompositionExecutionEnvelope({})).toMatchObject({
      maxCumulativeInputTokens: 16_777_216,
      maxCumulativeOutputTokens: 4_194_304,
    });
    expect(loadConfiguredCompositionModelLimits(validModelConfig.profile, {}).timeoutMs).toBe(
      3_600_000,
    );
    expect(
      loadCompositionExecutionEnvelope({
        DOCSFAB_COMPOSITION_EXECUTION_MAX_CUMULATIVE_INPUT_TOKENS: "1600000",
        DOCSFAB_COMPOSITION_EXECUTION_MAX_CUMULATIVE_OUTPUT_TOKENS: "128000",
      }),
    ).toMatchObject({
      maxCumulativeInputTokens: 1_600_000,
      maxCumulativeOutputTokens: 128_000,
    });
    expect(
      loadConfiguredCompositionModelLimits(validModelConfig.profile, {
        DOCSFAB_COMPOSITION_EXECUTION_TIMEOUT_MS: "1800000",
      }).timeoutMs,
    ).toBe(1_800_000);
  });

  it("retains a complete six-field pre-clamp vector with safe defaults", () => {
    expect(loadConfiguredCompositionModelLimits(validModelConfig.profile, {})).toEqual({
      ...validModelConfig.profile.configuredLimits,
      ...SHIPPED_DEFAULTS,
    });
  });

  // The invariant stated directly over the table. The behavioural guard below
  // additionally proves the loader wires each field's default and max to the
  // right parameters.
  it("ships every override maximum at or above its default", () => {
    const entries = Object.entries(COMPOSITION_EXECUTION_LIMITS);
    // An empty table would satisfy the loop vacuously.
    expect(entries).toHaveLength(3);

    for (const [field, bounds] of entries) {
      expect(bounds.max, `${field}: max must be >= default`).toBeGreaterThanOrEqual(bounds.default);
    }
  });

  it("accepts bounded host overrides without changing configured model facts", () => {
    const limits = loadConfiguredCompositionModelLimits(validModelConfig.profile, {
      DOCSFAB_COMPOSITION_EXECUTION_MAX_PROVIDER_TURNS: "7",
      DOCSFAB_COMPOSITION_EXECUTION_TIMEOUT_MS: "420000",
      DOCSFAB_COMPOSITION_EXECUTION_MAX_RESPONSE_BYTES: "100000",
    });

    expect(limits).toEqual({
      ...validModelConfig.profile.configuredLimits,
      maxProviderTurns: 7,
      timeoutMs: 420_000,
      maxResponseBytes: 100_000,
    });
    expect(validModelConfig.profile.configuredLimits).toEqual({
      contextWindow: 128_000,
      maxInputTokens: 128_000,
      maxOutputTokens: 16_384,
    });
  });

  it.each([
    ["DOCSFAB_COMPOSITION_EXECUTION_MAX_PROVIDER_TURNS", "maxProviderTurns"],
    ["DOCSFAB_COMPOSITION_EXECUTION_TIMEOUT_MS", "timeoutMs"],
    ["DOCSFAB_COMPOSITION_EXECUTION_MAX_RESPONSE_BYTES", "maxResponseBytes"],
  ] as const)(
    "accepts %s set to the shipped default, so the override can express it",
    (name, field) => {
      // Each override's maximum must be >= its default. The loader returns the
      // default before range-checking it, so an inverted pair ships silently and
      // is invisible to a test that spreads the default into its own expectation.
      // Restating the default through the env path makes this fail iff
      // maximum < default.
      const shipped = COMPOSITION_EXECUTION_LIMITS[field].default;

      expect(
        loadConfiguredCompositionModelLimits(validModelConfig.profile, {
          [name]: String(shipped),
        })[field],
      ).toBe(shipped);
    },
  );

  // Out-of-range values are derived from the shipped maximum, not pinned: a
  // literal one above an old maximum becomes a valid value once the maximum
  // is raised, and the test would assert a rejection that no longer happens.
  it.each([
    ["DOCSFAB_COMPOSITION_EXECUTION_MAX_PROVIDER_TURNS", "0"],
    [
      "DOCSFAB_COMPOSITION_EXECUTION_MAX_PROVIDER_TURNS",
      String(COMPOSITION_EXECUTION_LIMITS.maxProviderTurns.max + 1),
    ],
    [
      "DOCSFAB_COMPOSITION_EXECUTION_TIMEOUT_MS",
      String(COMPOSITION_EXECUTION_LIMITS.timeoutMs.max + 1),
    ],
    ["DOCSFAB_COMPOSITION_EXECUTION_MAX_RESPONSE_BYTES", "1.5"],
    [
      "DOCSFAB_COMPOSITION_EXECUTION_MAX_RESPONSE_BYTES",
      String(COMPOSITION_EXECUTION_LIMITS.maxResponseBytes.max + 1),
    ],
  ])("rejects invalid %s without echoing its value", (name, value) => {
    let failure: unknown;
    try {
      loadConfiguredCompositionModelLimits(validModelConfig.profile, { [name]: value });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain(name);
    expect(String(failure)).not.toContain(`=${value}`);
  });
});
