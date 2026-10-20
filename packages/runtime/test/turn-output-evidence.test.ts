// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  attributedProducedOutputTokens,
  attributedProviderFinishReason,
  bindProducedTurnOutputTokens,
  bindProviderFinishReasons,
} from "../src/harness/turn-output-evidence.js";
import {
  grantedTurnOutputTokens,
  preflightContextBudget,
  producedTurnOutputTokenLimit,
} from "../src/model/context-budget.js";
import type { InferenceTurnEvidence } from "../src/records/contracts.js";

const grant = {
  requestedOutputTokens: undefined as number | undefined,
  effectiveMaxOutputTokens: 32_768,
  availableOutputTokens: 100_000,
  requiredMinimumOutputTokens: 16,
};

function sentTurn(outputTokens: number): InferenceTurnEvidence {
  return {
    turn: 1,
    toolCalls: 0,
    toolResults: 0,
    maxProviderTurns: 12,
    maxToolCalls: 12,
    compactions: 0,
    maxCompactions: 8,
    configuredContextWindow: 128_000,
    effectiveContextWindow: 128_000,
    configuredMaxOutputTokens: 32_768,
    effectiveMaxOutputTokens: 32_768,
    reservedTokens: 128,
    estimatedInputTokens: 1_000,
    availableOutputTokens: 100_000,
    requiredMinimumOutputTokens: 16,
    outputTokens,
    decision: "proceed",
    requestDigest: "a".repeat(64),
    evidenceDigest: "b".repeat(64),
  };
}

describe("grantedTurnOutputTokens", () => {
  it("matches the preflight grant and is not tokens produced", () => {
    const budget = preflightContextBudget({
      configuredContextWindow: 128_000,
      effectiveContextWindow: 128_000,
      configuredMaxInputTokens: 128_000,
      effectiveMaxInputTokens: 128_000,
      configuredMaxOutputTokens: 32_768,
      effectiveMaxOutputTokens: 32_768,
      reservedTokens: 128,
      estimatedInputTokens: 1_000,
      requiredMinimumOutputTokens: 16,
    });
    expect(grantedTurnOutputTokens(grant)).toBe(32_768);
    expect(budget.outputTokens).toBe(32_768);
    expect(grantedTurnOutputTokens({ ...grant, requestedOutputTokens: 1_000 })).toBe(1_000);
  });
});

describe("producedTurnOutputTokenLimit", () => {
  it("keeps one request at the grant and scales by physical requests", () => {
    expect(producedTurnOutputTokenLimit(grant)).toBe(32_768);
    expect(producedTurnOutputTokenLimit({ ...grant, providerRetries: 1 })).toBe(65_536);
    expect(
      producedTurnOutputTokenLimit({ ...grant, requestedOutputTokens: 1_000, providerRetries: 1 }),
    ).toBe(2_000);
  });
});

describe("attributedProducedOutputTokens", () => {
  it("omits production when usage is missing or an error reported none", () => {
    expect(attributedProducedOutputTokens({})).toBeUndefined();
    expect(attributedProducedOutputTokens({ usage: { input: 10 } })).toBeUndefined();
    expect(
      attributedProducedOutputTokens({
        errorMessage: "503: unavailable",
        usage: { output: 0 },
      }),
    ).toBeUndefined();
  });

  it("records a landed zero and discarded-plus-landed aggregates", () => {
    expect(attributedProducedOutputTokens({ usage: { output: 0 } })).toBe(0);
    expect(attributedProducedOutputTokens({ usage: { output: 800 } }, 800)).toBe(1_600);
    expect(
      attributedProducedOutputTokens(
        { errorMessage: "503: unavailable", usage: { output: 0 } },
        800,
      ),
    ).toBe(800);
  });
});

describe("bindProducedTurnOutputTokens", () => {
  it("replaces the grant with tokens produced and leaves stop turns unset", () => {
    const grantTurn = sentTurn(32_768);
    const stop: InferenceTurnEvidence = {
      ...sentTurn(32_768),
      turn: 2,
      decision: "stop",
      reason: "output-authority-exhausted",
    };
    delete stop.outputTokens;
    const bound = bindProducedTurnOutputTokens([grantTurn, stop], [1_000]);
    expect(bound[0]?.outputTokens).toBe(1_000);
    expect(bound[0]?.outputTokens).not.toBe(bound[0]?.effectiveMaxOutputTokens);
    expect(bound[1]?.outputTokens).toBeUndefined();
    expect(bound[1]?.decision).toBe("stop");
  });

  it("omits the grant when a sent turn has no attributable usage", () => {
    const bound = bindProducedTurnOutputTokens([sentTurn(32_768)], []);
    expect(bound[0]?.outputTokens).toBeUndefined();
    expect(bound[0]?.decision).toBe("proceed");
    expect(grantedTurnOutputTokens(bound[0]!)).toBe(32_768);
  });

  it("keeps unknown slots aligned so a later turn is not charged earlier", () => {
    const first = sentTurn(32_768);
    const second = { ...sentTurn(32_768), turn: 2 };
    const bound = bindProducedTurnOutputTokens([first, second], [undefined, 100]);
    expect(bound[0]?.outputTokens).toBeUndefined();
    expect(bound[1]?.outputTokens).toBe(100);
  });

  it("records discarded-plus-landed production that crosses one request grant", () => {
    const perRequest = 1_000;
    const discarded = 800;
    const landed = 800;
    const grantTurn = sentTurn(perRequest);
    grantTurn.effectiveMaxOutputTokens = perRequest;
    grantTurn.configuredMaxOutputTokens = perRequest;
    const bound = bindProducedTurnOutputTokens([grantTurn], [discarded + landed]);
    expect(bound[0]?.outputTokens).toBe(1_600);
    expect(bound[0]?.outputTokens).toBeGreaterThan(grantedTurnOutputTokens(bound[0]!));
    expect(
      producedTurnOutputTokenLimit({ ...bound[0]!, providerRetries: 1 }),
    ).toBeGreaterThanOrEqual(bound[0]!.outputTokens!);
  });
});

describe("attributedProviderFinishReason", () => {
  it("admits a closed provider token and drops missing or unsafe values", () => {
    expect(attributedProviderFinishReason({ rawStopReason: "length" })).toBe("length");
    expect(attributedProviderFinishReason({ rawStopReason: "stop" })).toBe("stop");
    expect(attributedProviderFinishReason({ rawStopReason: "tool_calls" })).toBe("tool_calls");
    expect(attributedProviderFinishReason({})).toBeUndefined();
    expect(attributedProviderFinishReason({ rawStopReason: "absent" })).toBeUndefined();
    expect(
      attributedProviderFinishReason({
        rawStopReason: "nvapi-abcdefghijklmnopqrstuvwxyz012345",
      }),
    ).toBeUndefined();
  });
});

describe("bindProviderFinishReasons", () => {
  it("copies the closed token onto sent turns and leaves stop turns unset", () => {
    const stop: InferenceTurnEvidence = {
      ...sentTurn(32_768),
      turn: 2,
      decision: "stop",
      reason: "output-authority-exhausted",
    };
    delete stop.outputTokens;
    const bound = bindProviderFinishReasons([sentTurn(32_768), stop], ["length"]);
    expect(bound[0]?.rawStopReason).toBe("length");
    expect(bound[1]?.rawStopReason).toBeUndefined();
  });

  it("omits credential-shaped tokens rather than recording them", () => {
    const bound = bindProviderFinishReasons(
      [sentTurn(32_768)],
      ["nvapi-abcdefghijklmnopqrstuvwxyz012345"],
    );
    expect(bound[0]?.rawStopReason).toBeUndefined();
  });
});
