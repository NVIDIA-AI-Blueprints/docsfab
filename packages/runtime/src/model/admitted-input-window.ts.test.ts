// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Compile-time proof that the window rule takes the bound execution profile,
 * never the endpoint configuration it was bound from (`config.model`).
 *
 * This file sits under `src/`, so `npm run typecheck` checks it. Each
 * `@ts-expect-error` below fails that typecheck if an endpoint configuration
 * ever compiles where the bound profile belongs.
 */
import { describe, expect, it } from "vitest";
import { sourceReadBudgetForModel } from "../cli/run/source-acquisition.js";
import { contextPacketInputWindow } from "../context/budget.js";
import { admittedInputWindowTokens } from "./admitted-input-window.js";
import type { ModelEndpointConfig } from "./configuration.js";

function windowsFromEndpoint(model: ModelEndpointConfig) {
  return [
    // @ts-expect-error An endpoint configuration is not the bound profile.
    admittedInputWindowTokens(model),
    // @ts-expect-error Context packets read the same rule.
    contextPacketInputWindow(model),
    // @ts-expect-error Source reads read it too.
    sourceReadBudgetForModel(model).budgetBytes,
  ];
}

describe("the window rule's bound-profile guard", () => {
  it("would drop an installed composition's window if handed the configured profile", () => {
    // What `docsfab setup --profile <composition>` writes: the composition's
    // window, with metadata nobody attested. Only binding admits that window.
    const window = { maxInputTokens: 128_000, effectiveLimitReason: "metadata-unknown" } as const;
    const configured = {
      profile: window,
      requestPolicy: { minimumOutputTokens: 16, reservedContextTokens: 1_024 },
    } as unknown as ModelEndpointConfig;
    expect(windowsFromEndpoint(configured)).toEqual([undefined, undefined, 262_144]);
    // The bound profile of the same composition counts its window.
    const bound = {
      contextAdmission: "host-window",
      profile: { ...window, effectiveLimitReason: "composition-candidate" },
      requestPolicy: { minimumOutputTokens: 16, reservedContextTokens: 1_024 },
    } as const;
    expect(admittedInputWindowTokens(bound)).toBe(128_000);
    expect(contextPacketInputWindow(bound)).toBe(128_000);
    expect(sourceReadBudgetForModel(bound).budgetBytes).toBe(76_185);
  });
});
