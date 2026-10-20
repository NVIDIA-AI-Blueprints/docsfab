// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { DELEGATED_DO_LIMITS } from "../src/cli/commands/do.js";
import { limitDefinition } from "../src/config/limits.js";
import {
  OPERATIONAL_LIMIT_NAMES,
  clampedLimitStop,
  clippedLimitStop,
  exceededLimitStop,
  formatOperationalLimitStop,
  type OperationalLimitBreachRule,
} from "../src/config/limit-stop.js";
import {
  DELEGATED_TASK_DEADLINE_REMEDIATION,
  DELEGATED_TASK_TOOL_CALL_REMEDIATION,
  DELEGATED_TASK_TURN_GOVERNANCE_REMEDIATION,
  delegatedTaskDeadlineStop,
  delegatedTaskToolCallStop,
  delegatedTaskTurnGovernanceStop,
} from "../src/delegated-task/driver.js";
import { formatDoctorResult } from "../src/doctor.js";
import {
  HOSTED_CONTEXT_PREFLIGHT_BUDGET_MS,
  HOSTED_CONTEXT_PREFLIGHT_REMEDIATION,
  hostedContextPreflightBudgetStop,
} from "../src/host-invoker/context-preflight.js";
import {
  CONSERVATIVE_MODEL_FALLBACK,
  MODEL_PROFILE_CLAMP_REMEDIATION,
  modelProfileLimitClampIssues,
  parseModelEndpoint,
  type ModelEndpointConfig,
} from "../src/model/configuration.js";
import { resolveOperatorExecutionBinding } from "../src/model/operator-execution-binding.js";
import type { InferenceTurnEvidence } from "../src/records/contracts.js";
import { decodeContextPreflight } from "../src/scorecard-record.js";
import { normalizeContextPreflight } from "../src/workflow-execution/runner-evidence.js";
import { validModelConfig, validModelEnvironment } from "./helpers.js";
import { EXECUTABLE_ROUTE_BASE_URLS } from "../src/config/executable-route-urls.js";

const HUB_BASE_URL = EXECUTABLE_ROUTE_BASE_URLS["nvidia-inference-api"];

const SUPER_V3 = {
  providerId: "nvidia-inference-api",
  baseUrl: HUB_BASE_URL,
  modelId: "nvidia/nvidia/nemotron-3-super-v3",
} as const;

function superV3Endpoint(contextWindow: number, maxOutputTokens: number): ModelEndpointConfig {
  return {
    ...validModelConfig,
    ...SUPER_V3,
    requestPolicy: {
      minimumOutputTokens: 16,
      reservedContextTokens: 16,
    },
    profile: {
      ...validModelConfig.profile,
      configuredLimits: {
        contextWindow,
        maxInputTokens: contextWindow,
        maxOutputTokens,
      },
      contextWindow,
      maxInputTokens: contextWindow,
      maxOutputTokens,
    },
  };
}

const STALE_METADATA = {
  MODEL_PROFILE_APPROVED_SOURCE: "unknown",
  MODEL_PROFILE_EFFECTIVE_DATE: "unknown",
  MODEL_PROFILE_REVIEW_AFTER: "unknown",
};

function profileFor(contextWindow: number, maxOutputTokens: number) {
  return parseModelEndpoint({
    ...validModelEnvironment,
    ...STALE_METADATA,
    MODEL_CONTEXT_WINDOW: String(contextWindow),
    MODEL_MAX_OUTPUT_TOKENS: String(maxOutputTokens),
    MODEL_CONTEXT_RESERVE_TOKENS: "16",
  }).profile;
}

describe("operational limit stop vocabulary (#990)", () => {
  it("reports a ceiling stop at the limit and at limit plus one, and stays silent below it", () => {
    const configured = DELEGATED_DO_LIMITS.timeoutMs;
    const shared = {
      limit: OPERATIONAL_LIMIT_NAMES.delegatedTaskTimeoutMs,
      unit: "ms",
      breach: "at-the-bound",
      configured,
      remediation: "Raise it.",
    } as const;
    expect(exceededLimitStop({ ...shared, observed: configured - 1 })).toBeUndefined();
    expect(exceededLimitStop({ ...shared, observed: configured })?.disposition).toBe("stopped");
    expect(exceededLimitStop({ ...shared, observed: configured + 1 })?.observed).toBe(
      configured + 1,
    );
  });

  it("refuses a strict bound at equality and reports it one past, where an inclusive bound reports both", () => {
    // A deadline that has exactly run out has run out; a counter the governor
    // compares with `>` is not breached at equality, where the governor admits
    // the turn.
    const shared = {
      limit: OPERATIONAL_LIMIT_NAMES.delegatedTaskMaxProviderTurns,
      unit: "turns",
      configured: DELEGATED_DO_LIMITS.maxProviderTurns,
      remediation: "Raise it.",
    } as const;
    const atBound = DELEGATED_DO_LIMITS.maxProviderTurns;
    expect(
      exceededLimitStop({ ...shared, breach: "past-the-bound", observed: atBound }),
    ).toBeUndefined();
    expect(
      exceededLimitStop({ ...shared, breach: "past-the-bound", observed: atBound + 1 })?.observed,
    ).toBe(atBound + 1);
    expect(
      exceededLimitStop({ ...shared, breach: "at-the-bound", observed: atBound })?.disposition,
    ).toBe("stopped");
  });

  it("reports a clip only once work was dropped, and never as a stop", () => {
    const configured = DELEGATED_DO_LIMITS.maxToolCalls;
    const shared = {
      limit: OPERATIONAL_LIMIT_NAMES.delegatedTaskMaxToolCalls,
      unit: "calls",
      configured,
      remediation: "Raise it.",
    } as const;
    expect(clippedLimitStop({ ...shared, attempted: configured - 1 })).toBeUndefined();
    expect(clippedLimitStop({ ...shared, attempted: configured })).toBeUndefined();
    const clipped = clippedLimitStop({ ...shared, attempted: configured + 1 });
    expect(clipped?.disposition).toBe("clipped");
    expect(clipped?.disposition).not.toBe("stopped");
    expect(clipped?.observed).toBe(configured + 1);
  });

  it("reports a clamp only when the requested value exceeds the effective bound", () => {
    const shared = {
      limit: OPERATIONAL_LIMIT_NAMES.modelProfileFallbackContextWindow,
      unit: "tokens",
      configured: 8_192,
      remediation: "Approve metadata.",
    } as const;
    expect(clampedLimitStop({ ...shared, requested: 8_191 })).toBeUndefined();
    expect(clampedLimitStop({ ...shared, requested: 8_192 })).toBeUndefined();
    expect(clampedLimitStop({ ...shared, requested: 8_193 })?.disposition).toBe("clamped");
  });

  it("refuses to build a stop that cannot state its own value", () => {
    expect(() =>
      exceededLimitStop({
        limit: OPERATIONAL_LIMIT_NAMES.delegatedTaskTimeoutMs,
        unit: "ms",
        breach: "at-the-bound",
        configured: Number.NaN,
        observed: 1,
        remediation: "Raise it.",
      }),
    ).toThrow("a bound that cannot state its own value cannot be reported");
  });

  it("refuses to build a stop whose breach rule carries no comparison", () => {
    expect(() =>
      exceededLimitStop({
        limit: OPERATIONAL_LIMIT_NAMES.delegatedTaskTimeoutMs,
        unit: "ms",
        breach: "whenever-it-feels-like-it" as OperationalLimitBreachRule,
        configured: 1,
        observed: 2,
        remediation: "Raise it.",
      }),
    ).toThrow("carries no comparison for its breach rule");
  });

  it("names the limit, both values, the unit, and the remediation in one sentence", () => {
    const stopped = exceededLimitStop({
      limit: OPERATIONAL_LIMIT_NAMES.delegatedTaskTimeoutMs,
      unit: "ms",
      breach: "at-the-bound",
      configured: 1_800_000,
      observed: 1_800_004,
      remediation: DELEGATED_TASK_DEADLINE_REMEDIATION,
    });
    expect(stopped).toBeDefined();
    expect(formatOperationalLimitStop(stopped!)).toBe(
      "DocsFab stopped this run at the operational limit delegatedTask.timeoutMs (limit 1800000 ms, observed 1800004 ms). " +
        DELEGATED_TASK_DEADLINE_REMEDIATION,
    );
    const clamped = clampedLimitStop({
      limit: OPERATIONAL_LIMIT_NAMES.modelProfileFallbackContextWindow,
      unit: "tokens",
      configured: 8_192,
      requested: 128_000,
      remediation: MODEL_PROFILE_CLAMP_REMEDIATION,
    });
    expect(clamped).toBeDefined();
    expect(formatOperationalLimitStop(clamped!)).toBe(
      "DocsFab clamped to the operational limit modelProfile.conservativeFallbackContextWindow (effective 8192 tokens, requested 128000 tokens). " +
        MODEL_PROFILE_CLAMP_REMEDIATION,
    );
  });

  it("says a clipped run continued, never that DocsFab stopped it", () => {
    const clipped = clippedLimitStop({
      limit: OPERATIONAL_LIMIT_NAMES.delegatedTaskMaxToolCalls,
      unit: "calls",
      configured: 8,
      attempted: 9,
      remediation: DELEGATED_TASK_TOOL_CALL_REMEDIATION,
    });
    expect(clipped).toBeDefined();
    expect(formatOperationalLimitStop(clipped!)).toBe(
      "DocsFab continued with work clipped at the operational limit delegatedTask.maxToolCalls (limit 8 calls, attempted 9 calls). " +
        DELEGATED_TASK_TOOL_CALL_REMEDIATION,
    );
    expect(formatOperationalLimitStop(clipped!)).not.toContain("DocsFab stopped");
  });
});

describe("delegated-task limit boundaries (#990)", () => {
  // Read from DELEGATED_DO_LIMITS so the cases move with the bound.
  const configuredMs = DELEGATED_DO_LIMITS.timeoutMs;
  const configuredCalls = DELEGATED_DO_LIMITS.maxToolCalls;

  it("reports no deadline below the budget and a coded deadline at the budget and beyond", () => {
    expect(
      delegatedTaskDeadlineStop({ configuredMs, elapsedMs: configuredMs - 1 }),
    ).toBeUndefined();
    const atLimit = delegatedTaskDeadlineStop({ configuredMs, elapsedMs: configuredMs });
    expect(atLimit?.limit).toBe("delegatedTask.timeoutMs");
    expect(atLimit?.configured).toBe(configuredMs);
    expect(atLimit?.observed).toBe(configuredMs);
    expect(atLimit?.disposition).toBe("stopped");
    expect(atLimit?.remediation).toBe(DELEGATED_TASK_DEADLINE_REMEDIATION);
    const pastLimit = delegatedTaskDeadlineStop({ configuredMs, elapsedMs: configuredMs + 1 });
    expect(pastLimit?.observed).toBe(configuredMs + 1);
  });

  it("refuses an elapsed time it cannot measure rather than inventing a deadline", () => {
    // The driver floors this at zero and guards the call, so a hostile clock
    // reaches the anomaly branch instead of escaping a timer callback.
    expect(() => delegatedTaskDeadlineStop({ configuredMs, elapsedMs: -5 })).toThrow(
      "a bound that cannot state its own value cannot be reported",
    );
    expect(delegatedTaskDeadlineStop({ configuredMs, elapsedMs: 0 })).toBeUndefined();
  });

  it("flags a tool-call clip only once the ceiling blocked a call, and never as a stop", () => {
    expect(delegatedTaskToolCallStop({ configuredCalls, blockedCalls: 0 })).toBeUndefined();
    const clipped = delegatedTaskToolCallStop({ configuredCalls, blockedCalls: 1 });
    expect(clipped?.limit).toBe("delegatedTask.maxToolCalls");
    expect(clipped?.configured).toBe(configuredCalls);
    expect(clipped?.observed).toBe(configuredCalls + 1);
    // The confined ceiling blocks one call and the session keeps going, so this
    // must not read as "a budget ended the run".
    expect(clipped?.disposition).toBe("clipped");
    expect(clipped?.remediation).toBe(DELEGATED_TASK_TOOL_CALL_REMEDIATION);
  });
});

describe("delegated-task turn governance stops (#990)", () => {
  // Every optional field the governor's own rule reads is populated, so no
  // candidate can pass merely because the fixture omitted its evidence.
  function governedTurn(overrides: Partial<InferenceTurnEvidence> = {}): InferenceTurnEvidence {
    return {
      turn: 4,
      toolCalls: 2,
      toolResults: 2,
      maxProviderTurns: 24,
      maxToolCalls: 40,
      compactions: 0,
      maxCompactions: 3,
      configuredContextWindow: 128_000,
      effectiveContextWindow: 128_000,
      configuredMaxInputTokens: 120_000,
      effectiveMaxInputTokens: 120_000,
      configuredMaxOutputTokens: 16_384,
      effectiveMaxOutputTokens: 16_384,
      reservedTokens: 4_096,
      estimatedInputTokens: 1_000,
      availableInputTokens: 115_904,
      availableOutputTokens: 8_000,
      requiredMinimumOutputTokens: 16,
      outputAuthority: {
        maxOutputTokens: 100_000,
        cumulativeOutputTokens: 1_000,
        floorOutputTokens: 256,
      },
      decision: "stop",
      requestDigest: "a".repeat(64),
      ...overrides,
    } as InferenceTurnEvidence;
  }

  it("names the provider-turn ceiling with the configured and observed turn counts", () => {
    const stop = delegatedTaskTurnGovernanceStop(
      governedTurn({ reason: "provider-turn-limit", turn: 25, maxProviderTurns: 24 }),
    );
    expect(stop?.limit).toBe("delegatedTask.maxProviderTurns");
    expect(stop?.disposition).toBe("stopped");
    expect(stop?.configured).toBe(24);
    expect(stop?.observed).toBe(25);
    expect(stop?.remediation).toBe(DELEGATED_TASK_TURN_GOVERNANCE_REMEDIATION);
  });

  it("names the tool-call ceiling when the governor stopped on prepared calls", () => {
    const stop = delegatedTaskTurnGovernanceStop(
      governedTurn({ reason: "tool-call-limit", toolCalls: 41, maxToolCalls: 40 }),
    );
    expect(stop?.limit).toBe("delegatedTask.maxToolCalls");
    expect(stop?.disposition).toBe("stopped");
    expect(stop?.observed).toBe(41);
  });

  it("names the output room a context-exhausted turn could not reserve", () => {
    const stop = delegatedTaskTurnGovernanceStop(
      governedTurn({
        reason: "context-exhausted",
        availableOutputTokens: 15,
        requiredMinimumOutputTokens: 16,
      }),
    );
    expect(stop?.limit).toBe("model.availableOutputTokens");
    expect(stop?.configured).toBe(15);
    expect(stop?.observed).toBe(16);
  });

  it("names the remaining output authority the governor's floor comparison exhausted", () => {
    // The governor's rule is `max - cumulative < floor`, a floor comparison, not
    // a counter.
    const stop = delegatedTaskTurnGovernanceStop(
      governedTurn({
        reason: "output-authority-exhausted",
        outputAuthority: {
          maxOutputTokens: 100_000,
          cumulativeOutputTokens: 99_900,
          floorOutputTokens: 256,
        },
      }),
    );
    expect(stop?.limit).toBe("model.outputTokenAuthority");
    expect(stop?.disposition).toBe("stopped");
    expect(stop?.configured).toBe(100);
    expect(stop?.observed).toBe(256);
  });

  it("names the compaction ceiling the governor admits at equality, not a lower bound", () => {
    // The governor's compaction arm is `compactions >= maxCompactions`; with `>`
    // a lower-precedence candidate would name the wrong bound.
    const stop = delegatedTaskTurnGovernanceStop(
      governedTurn({
        reason: "compaction-limit",
        compactions: 3,
        maxCompactions: 3,
        availableOutputTokens: 15,
        requiredMinimumOutputTokens: 16,
      }),
    );
    expect(stop?.limit).toBe("delegatedTask.maxCompactions");
    expect(stop?.limit).not.toBe("model.effectiveMaxInputTokens");
    expect(stop?.configured).toBe(3);
    expect(stop?.observed).toBe(3);
  });

  it("names the input cap a reservation overran on its own", () => {
    // The reservation alone exceeds the cap, so the room left is negative;
    // counting the reservation on the observed side states the breach with two
    // non-negative values.
    const stop = delegatedTaskTurnGovernanceStop(
      governedTurn({
        reason: "context-exhausted",
        effectiveMaxInputTokens: 120_000,
        reservedTokens: 200_000,
        estimatedInputTokens: 0,
      }),
    );
    expect(stop?.limit).toBe("model.effectiveMaxInputTokens");
    expect(stop?.configured).toBe(120_000);
    expect(stop?.observed).toBe(200_000);
  });

  it("claims no bound for a governance stop that has no numeric bound behind it", () => {
    expect(
      delegatedTaskTurnGovernanceStop(governedTurn({ reason: "evidence-preservation-required" })),
    ).toBeUndefined();
  });

  it("reports nothing when the governed evidence shows no bound actually breached", () => {
    // A turn below its ceiling.
    expect(
      delegatedTaskTurnGovernanceStop(
        governedTurn({ reason: "provider-turn-limit", turn: 23, maxProviderTurns: 24 }),
      ),
    ).toBeUndefined();
  });

  it("reports nothing for evidence sitting exactly on a bound the governor admits", () => {
    // At the ceiling, not past it, for each strict arm. The governor stops at
    // `providerTurns >= max` while recording `turn = providerTurns + 1`, so a
    // genuine stop carries `turn > max`; the tool-call, output-authority and
    // input-cap comparisons are strict likewise. Only forged or corrupted
    // evidence reaches equality, and it must not name a limit that did not bind.
    expect(
      delegatedTaskTurnGovernanceStop(
        governedTurn({ reason: "provider-turn-limit", turn: 24, maxProviderTurns: 24 }),
      ),
    ).toBeUndefined();
    expect(
      delegatedTaskTurnGovernanceStop(
        governedTurn({ reason: "tool-call-limit", toolCalls: 40, maxToolCalls: 40 }),
      ),
    ).toBeUndefined();
    expect(
      delegatedTaskTurnGovernanceStop(
        governedTurn({
          reason: "output-authority-exhausted",
          outputAuthority: {
            maxOutputTokens: 100_000,
            cumulativeOutputTokens: 99_744,
            floorOutputTokens: 256,
          },
        }),
      ),
    ).toBeUndefined();
    expect(
      delegatedTaskTurnGovernanceStop(
        governedTurn({
          reason: "context-exhausted",
          effectiveMaxInputTokens: 120_000,
          reservedTokens: 119_000,
          estimatedInputTokens: 1_000,
          availableOutputTokens: 8_000,
          requiredMinimumOutputTokens: 16,
        }),
      ),
    ).toBeUndefined();
  });

  it("still names the compaction ceiling at equality, because that governor arm is inclusive", () => {
    // The one bound whose enforcer uses `>=`, so it is not tightened to `>`.
    expect(
      delegatedTaskTurnGovernanceStop(
        governedTurn({ reason: "compaction-limit", compactions: 3, maxCompactions: 3 }),
      )?.limit,
    ).toBe("delegatedTask.maxCompactions");
  });
});

describe("hosted context preflight budget boundary (#990)", () => {
  it("reports no budget stop below the ceiling and a coded stop at the ceiling and beyond", () => {
    const configuredMs = HOSTED_CONTEXT_PREFLIGHT_BUDGET_MS;
    expect(configuredMs).toBe(limitDefinition("hostInvoker.contextPreflightBudgetMs").value);
    expect(
      hostedContextPreflightBudgetStop({ configuredMs, elapsedMs: configuredMs - 1 }),
    ).toBeUndefined();
    const atBudget = hostedContextPreflightBudgetStop({ configuredMs, elapsedMs: configuredMs });
    expect(atBudget?.limit).toBe("hostInvoker.contextPreflightBudgetMs");
    expect(atBudget?.configured).toBe(configuredMs);
    expect(atBudget?.remediation).toBe(HOSTED_CONTEXT_PREFLIGHT_REMEDIATION);
    const pastBudget = hostedContextPreflightBudgetStop({
      configuredMs,
      elapsedMs: configuredMs + 1,
    });
    expect(pastBudget?.observed).toBe(configuredMs + 1);
  });
});

describe("recorded preflight limit evidence (#990)", () => {
  const budgeted = {
    status: "degraded" as const,
    measurements: { byteLength: 1, estimatedTokens: 1, latencyMs: 31_000 },
    cache: { disposition: "disabled" as const, rebuildAttempted: true },
    reason: "preflight-budget-exceeded" as const,
    limit: {
      name: "hostInvoker.contextPreflightBudgetMs",
      unit: "ms" as const,
      configured: 30_000,
      observed: 31_000,
    },
  };

  it("carries the named bound and both values through the normalizer and the decoder", () => {
    const evidence = normalizeContextPreflight(budgeted);
    expect(evidence.limit).toEqual(budgeted.limit);
    expect(decodeContextPreflight(evidence)).toEqual(evidence);
  });

  it("refuses an observed value below the bound it claims to have exceeded", () => {
    expect(() =>
      normalizeContextPreflight({
        ...budgeted,
        limit: { ...budgeted.limit, observed: budgeted.limit.configured - 1 },
      }),
    ).toThrow("Context preflight returned an invalid limit record");
  });

  it("refuses a recorded bound that names no budget reason", () => {
    expect(() =>
      decodeContextPreflight({
        ...budgeted,
        reason: "preflight-internal-failure",
      }),
    ).toThrow();
  });

  it("refuses a budget reason that carries no bound, in the normalizer and the decoder", () => {
    const { limit: _limit, ...withoutLimit } = budgeted;
    expect(() => normalizeContextPreflight(withoutLimit)).toThrow(
      "a recorded bound and its cause travel together",
    );
    expect(() => decodeContextPreflight(withoutLimit)).toThrow();
  });
});

describe("model profile window reduction reporting (#990)", () => {
  it("does not invent an 8k lid for a profile configured at the old fallback numbers", () => {
    const profile = profileFor(
      CONSERVATIVE_MODEL_FALLBACK.contextWindow,
      CONSERVATIVE_MODEL_FALLBACK.maxOutputTokens,
    );
    expect(profile.effectiveLimitReason).toBe("metadata-unknown");
    expect(profile.contextWindow).toBe(CONSERVATIVE_MODEL_FALLBACK.contextWindow);
    expect(profile.maxOutputTokens).toBe(CONSERVATIVE_MODEL_FALLBACK.maxOutputTokens);
    expect(modelProfileLimitClampIssues(profile, "MODEL")).toEqual([]);
  });

  it("keeps configured windows one token above the old fallback without reducing them", () => {
    const profile = profileFor(
      CONSERVATIVE_MODEL_FALLBACK.contextWindow + 1,
      CONSERVATIVE_MODEL_FALLBACK.maxOutputTokens + 1,
    );
    expect(profile.contextWindow).toBe(CONSERVATIVE_MODEL_FALLBACK.contextWindow + 1);
    expect(profile.maxOutputTokens).toBe(CONSERVATIVE_MODEL_FALLBACK.maxOutputTokens + 1);
    expect(modelProfileLimitClampIssues(profile, "MODEL")).toEqual([]);
  });

  it("does not reduce a configured 128K lane whose metadata is not current", () => {
    const profile = parseModelEndpoint({ ...validModelEnvironment, ...STALE_METADATA }).profile;
    expect(profile.contextWindow).toBe(128_000);
    expect(profile.maxOutputTokens).toBe(16_384);
    expect(modelProfileLimitClampIssues(profile, "MODEL")).toEqual([]);
  });

  it("reports no reduction when approved metadata is current", () => {
    const profile = parseModelEndpoint(validModelEnvironment).profile;
    expect(profile.metadata.status).toBe("current");
    expect(modelProfileLimitClampIssues(profile, "MODEL")).toEqual([]);
  });

  it("binds attested windows above the preset unclamped, and reports a reduced profile by field", async () => {
    const high = await resolveOperatorExecutionBinding({
      // Above the preset's sealed Hub Metadata limits (1,048,576 / 32,768).
      model: superV3Endpoint(2_000_000, 65_536),
      environment: { MODEL_API_KEY: "test-secret" },
    });
    expect(high.match).toBe("installed-composition");
    expect(high.profile.profile.effectiveLimitReason).toBe("composition-candidate");
    // The operator's attested values win over the preset's.
    expect(high.profile.profile.contextWindow).toBe(2_000_000);
    expect(high.profile.profile.maxOutputTokens).toBe(65_536);
    expect(modelProfileLimitClampIssues(high.profile.profile, "MODEL")).toEqual([]);

    // A profile whose effective window is below its configured one, such as
    // one a hosted packet carries, is still reported field by field.
    const boundContext = 1_048_576;
    const boundOutput = 32_768;
    const profile = {
      ...high.profile.profile,
      configuredLimits: {
        contextWindow: boundContext + 1,
        maxInputTokens: boundContext + 1,
        maxOutputTokens: boundOutput + 1,
      },
      contextWindow: boundContext,
      maxInputTokens: boundContext,
      maxOutputTokens: boundOutput,
    };
    const issues = modelProfileLimitClampIssues(profile, "MODEL");
    const contextIssue = issues.find((issue) => issue.field === "MODEL_CONTEXT_WINDOW");
    const outputIssue = issues.find((issue) => issue.field === "MODEL_MAX_OUTPUT_TOKENS");
    expect(contextIssue).toMatchObject({ profile: "MODEL", field: "MODEL_CONTEXT_WINDOW" });
    expect(contextIssue?.message).toContain(`effective ${boundContext} tokens`);
    expect(contextIssue?.message).toContain(`requested ${boundContext + 1} tokens`);
    expect(outputIssue).toMatchObject({ profile: "MODEL", field: "MODEL_MAX_OUTPUT_TOKENS" });
    expect(outputIssue?.message).toContain(`effective ${boundOutput} tokens`);
    expect(outputIssue?.message).toContain(`requested ${boundOutput + 1} tokens`);

    const doctor = formatDoctorResult({
      provider: SUPER_V3.providerId,
      endpoint: SUPER_V3.baseUrl,
      model: SUPER_V3.modelId,
      profile,
      requestPolicy: { minimumOutputTokens: 16, reservedContextTokens: 16 },
      retryPolicy: {
        maxRetries: 1,
        baseDelayMs: 1_000,
        maxDelayMs: 4_000,
        retryableCategories: ["timeout", "throttled"],
      },
      skills: [],
      contextSources: [],
    });
    expect(doctor).toContain("Limit clamp: MODEL_CONTEXT_WINDOW:");
    expect(doctor).toContain(
      `effective ${boundContext} tokens, requested ${boundContext + 1} tokens`,
    );
  });
});
