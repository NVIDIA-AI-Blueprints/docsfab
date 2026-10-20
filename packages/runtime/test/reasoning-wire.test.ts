// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Which thinking an Anthropic Messages request carries comes from Pi's own
 * model catalog: adaptive thinking with an effort for Claude 4.6 and later,
 * budget thinking for older or unknown models.
 */
import { describe, expect, it } from "vitest";

import {
  anthropicThinking,
  carriesReasoning,
  reasoningWireNotes,
} from "../src/model/reasoning-wire.js";
import { validModelConfig } from "./helpers.js";

describe("anthropic thinking from Pi's catalog", () => {
  it.each([
    ["claude-opus-4-7", { catalogId: "claude-opus-4-7", adaptive: true }],
    // A gateway model id matches the catalog by its last segment.
    ["aws/anthropic/bedrock-claude-sonnet-5", { catalogId: "claude-sonnet-5", adaptive: true }],
    ["claude-sonnet-4-5", { catalogId: "claude-sonnet-4-5", adaptive: false }],
    ["model-under-test", { adaptive: false }],
    // Control: a name that only contains a catalog id is not that model.
    ["notclaude-sonnet-5", { adaptive: false }],
  ] as const)("reads %s", (modelId, expected) => {
    expect(anthropicThinking(modelId)).toEqual(expected);
  });
});

describe("a model that cannot carry reasoning", () => {
  const profile = {
    modelId: "claude-sonnet-4-5",
    transport: "anthropic-messages" as const,
    profile: { ...validModelConfig.profile, reasoning: false },
  };

  it("is an Anthropic Messages model without adaptive thinking, and only that", () => {
    expect(carriesReasoning("anthropic-messages", "claude-sonnet-4-5")).toBe(false);
    expect(carriesReasoning("anthropic-messages", "claude-opus-4-7")).toBe(true);
    // Other transports carry reasoning as an effort field, whatever the model.
    expect(carriesReasoning("openai-chat-completions", "claude-sonnet-4-5")).toBe(true);
    expect(carriesReasoning("openai-responses", "model-under-test")).toBe(true);
  });

  it("is noted when reasoning was asked for, from any source", () => {
    const note =
      "is not sent: model claude-sonnet-4-5 has no adaptive thinking in Pi's catalog, and DocsFab sends Anthropic Messages thinking only as adaptive thinking, so requests keep thinking off.";
    expect(reasoningWireNotes(profile, { reasoning: true })).toEqual([`Reasoning ${note}`]);
    expect(reasoningWireNotes(profile, { reasoning: true, effort: "low" })).toEqual([
      `Reasoning at reasoningEffort low ${note}`,
    ]);
    // The profile's own reasoning: true is bound off too, and says so.
    expect(reasoningWireNotes(profile, { profileReasoning: true })).toEqual([`Reasoning ${note}`]);
  });

  it("is not noted when nothing asked for reasoning (control)", () => {
    expect(reasoningWireNotes(profile, {})).toEqual([]);
    expect(reasoningWireNotes(profile, { reasoning: false, profileReasoning: true })).toEqual([]);
  });
});
