// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The one rule for which model input window a budget may be sized from
 * (#1809, #1932): only a window DocsFab admits requests against counts.
 */
import { describe, expect, it } from "vitest";

import { contextPacketInputWindow } from "../src/context/budget.js";
import {
  parseHostRuntimeComposition,
  sealHostRuntimeComposition,
} from "../src/host-invoker/composition.js";
import {
  admittedInputWindowTokens,
  type AdmittedInputWindowSource,
} from "../src/model/admitted-input-window.js";
import {
  bindModelExecutionProfile,
  CONSERVATIVE_MODEL_FALLBACK,
  type ModelProfile,
} from "../src/model/configuration.js";
import { validModelConfig } from "./helpers.js";
import { setupPlaceholderModel } from "./support/setup-placeholder-model.js";

describe("the model input window a budget may be sized from (#1809, #1932)", () => {
  it("counts the window of a profile with current metadata", () => {
    const bound = bindModelExecutionProfile(validModelConfig).profile;
    expect(bound.contextAdmission).toBe("host-window");
    expect(admittedInputWindowTokens(bound)).toBe(128_000);
  });

  it("counts an installed composition's window, even when the YAML metadata is unknown", () => {
    const placeholder = bindModelExecutionProfile(setupPlaceholderModel()).profile;
    expect(
      admittedInputWindowTokens({
        contextAdmission: "host-window",
        profile: {
          ...placeholder.profile,
          maxInputTokens: 1_050_000,
          effectiveLimitReason: "composition-candidate",
        },
      }),
    ).toBe(1_050_000);
    // A hosted composition's profile carries no admission mode; DocsFab admits
    // against its window.
    expect(
      admittedInputWindowTokens({
        profile: { maxInputTokens: 1_050_000, effectiveLimitReason: "composition-candidate" },
      }),
    ).toBe(1_050_000);
  });

  it("counts no window for the placeholder setup writes for an unmatched endpoint", () => {
    const model = setupPlaceholderModel();
    expect(model.profile.maxInputTokens).toBe(CONSERVATIVE_MODEL_FALLBACK.contextWindow);
    expect(model.profile.metadata.status).toBe("unknown");
    const bound = bindModelExecutionProfile(model).profile;
    expect(bound.contextAdmission).toBe("provider");
    expect(admittedInputWindowTokens(bound)).toBeUndefined();
    // Without its admission mode the placeholder still counts no window: no one
    // attested its metadata.
    const { contextAdmission: _admission, ...withoutAdmission } = bound;
    expect(admittedInputWindowTokens(withoutAdmission)).toBeUndefined();
    expect(
      admittedInputWindowTokens({ ...withoutAdmission, contextAdmission: "host-window" }),
    ).toBeUndefined();
  });

  it("counts no window under provider admission, stale metadata, no profile, or a malformed window", () => {
    const attested = bindModelExecutionProfile(validModelConfig).profile;
    expect(
      admittedInputWindowTokens({ ...attested, contextAdmission: "provider" }),
    ).toBeUndefined();
    expect(
      admittedInputWindowTokens({
        ...attested,
        profile: { ...attested.profile, effectiveLimitReason: "metadata-stale" },
      }),
    ).toBeUndefined();
    expect(admittedInputWindowTokens(undefined)).toBeUndefined();
    expect(admittedInputWindowTokens(null)).toBeUndefined();
    expect(admittedInputWindowTokens({ contextAdmission: "host-window" })).toBeUndefined();
    for (const maxInputTokens of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        admittedInputWindowTokens({
          ...attested,
          profile: { ...attested.profile, maxInputTokens },
        }),
      ).toBeUndefined();
    }
  });
});

describe("one window rule for context packets and source reads (#1809, #1932)", () => {
  /** The packet rule before it delegated: only provider admission discounted a window. */
  function formerPacketRule(source: AdmittedInputWindowSource): number | undefined {
    if (source.contextAdmission === "provider") return undefined;
    const window = source.profile?.maxInputTokens;
    return typeof window === "number" && Number.isSafeInteger(window) && window > 0
      ? window
      : undefined;
  }

  it("gives packets the source-read rule on every input, including the 12 where the packet rule alone counted a window", () => {
    const admissions = [undefined, "host-window", "provider"] as const;
    const reasons = [
      undefined,
      "none",
      "composition-candidate",
      "metadata-unknown",
      "metadata-stale",
    ] as const;
    const windows = [
      undefined,
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      1,
      65_536,
      1_050_000,
    ];
    const divergent: string[] = [];
    for (const contextAdmission of admissions) {
      for (const effectiveLimitReason of reasons) {
        for (const maxInputTokens of windows) {
          const source: AdmittedInputWindowSource = {
            ...(contextAdmission ? { contextAdmission } : {}),
            profile: {
              ...(maxInputTokens === undefined ? {} : { maxInputTokens }),
              ...(effectiveLimitReason ? { effectiveLimitReason } : {}),
            },
          };
          const label = `${contextAdmission ?? "no-admission"}/${effectiveLimitReason ?? "no-reason"}/${String(maxInputTokens)}`;
          const shared = admittedInputWindowTokens(source);
          expect(contextPacketInputWindow(source), label).toBe(shared);
          if (formerPacketRule(source) !== shared) {
            expect(shared, label).toBeUndefined();
            divergent.push(label);
          }
        }
      }
    }
    // Unattested metadata, admission that is not the provider's, and a
    // positive window: the packet rule sized from these, the source rule did not.
    expect(divergent).toEqual(
      ["no-admission", "host-window"].flatMap((admission) =>
        ["metadata-unknown", "metadata-stale"].flatMap((reason) =>
          ["1", "65536", "1050000"].map((window) => `${admission}/${reason}/${window}`),
        ),
      ),
    );
  });

  it("counts a hosted composition's window only when its sealed profile is attested", () => {
    // A hosted request carries its composition on the wire; the decoder keeps
    // any effectiveLimitReason and has no admission field to carry.
    function decoded(effectiveLimitReason: ModelProfile["effectiveLimitReason"]) {
      const sealed = sealHostRuntimeComposition({
        compositionId: "window-rule-fixture-v1",
        route: "nvidia-inference-api",
        credentialFamily: "nvidia-inference-api",
        executionProfile: {
          routeId: "nvidia-inference-api",
          providerId: "nvidia-inference-api",
          baseUrl: "https://example.invalid/v1",
          modelId: "model-fixture",
          transport: "openai-chat-completions",
          apiFormat: "chat_completions",
          profile: {
            configuredLimits: {
              contextWindow: 262_144,
              maxInputTokens: 131_072,
              maxOutputTokens: 2_048,
            },
            contextWindow: 262_144,
            maxInputTokens: 131_072,
            maxOutputTokens: 2_048,
            effectiveLimitReason,
            reasoning: false,
            input: ["text"],
            compatibility: {
              supportsDeveloperRole: true,
              supportsReasoningEffort: false,
              apiFormats: ["chat_completions"],
            },
            costPerMillionTokens: { input: null, output: null, cacheRead: null, cacheWrite: null },
            metadata: {
              approvedSource: null,
              effectiveDate: null,
              reviewAfter: null,
              status: "unknown",
            },
          },
          requestPolicy: { minimumOutputTokens: 16, reservedContextTokens: 512 },
        },
        declaredTools: [],
      });
      const profile = parseHostRuntimeComposition(JSON.parse(JSON.stringify(sealed)))
        .executionProfile!;
      expect(profile.contextAdmission).toBeUndefined();
      expect(profile.profile.effectiveLimitReason).toBe(effectiveLimitReason);
      return profile;
    }

    expect(contextPacketInputWindow(decoded("composition-candidate"))).toBe(131_072);
    expect(contextPacketInputWindow(decoded("none"))).toBe(131_072);
    expect(contextPacketInputWindow(decoded("metadata-unknown"))).toBeUndefined();
    expect(contextPacketInputWindow(decoded("metadata-stale"))).toBeUndefined();
  });
});
