// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { InferenceStepError } from "../src/execution/contracts.js";
import {
  classifyModelFailure,
  ContextBudgetError,
  describeModelTurnAdmission,
  estimateModelRequestTokens,
  LOCAL_STOP_MESSAGE_PREFIX,
  localStopReason,
  preflightContextBudget,
} from "../src/model/context-budget.js";
import { createContextBudgetedStream } from "../src/model/provider.js";
import { validModelConfig } from "./helpers.js";

const baseBudget = {
  configuredContextWindow: 128_000,
  effectiveContextWindow: 8_192,
  configuredMaxInputTokens: 128_000,
  effectiveMaxInputTokens: 8_192,
  configuredMaxOutputTokens: 16_384,
  effectiveMaxOutputTokens: 4_096,
  reservedTokens: 4_096,
  requiredMinimumOutputTokens: 16,
};

describe("preflightContextBudget", () => {
  it("rejects locally when the provider minimum cannot fit", () => {
    expect(() =>
      preflightContextBudget({ ...baseBudget, estimatedInputTokens: 4_081 }),
    ).toThrowError(
      expect.objectContaining({
        code: "context-exhausted",
        retryable: false,
        diagnostic: expect.objectContaining({ availableOutputTokens: 15 }),
      }),
    );
  });

  it("accepts budgets equal to and above the provider minimum", () => {
    expect(preflightContextBudget({ ...baseBudget, estimatedInputTokens: 4_080 })).toMatchObject({
      outputTokens: 16,
      availableOutputTokens: 16,
    });
    expect(preflightContextBudget({ ...baseBudget, estimatedInputTokens: 4_079 })).toMatchObject({
      outputTokens: 17,
      availableOutputTokens: 17,
    });
  });

  it("enforces the effective input cap independently at its exact boundary", () => {
    const independentInputCap = {
      ...baseBudget,
      effectiveContextWindow: 12_000,
      effectiveMaxInputTokens: 5_000,
      reservedTokens: 1_000,
      requestedOutputTokens: 16,
    };

    expect(
      preflightContextBudget({
        ...independentInputCap,
        estimatedInputTokens: 4_000,
      }),
    ).toMatchObject({ availableInputTokens: 4_000, outputTokens: 16 });
    expect(() =>
      preflightContextBudget({
        ...independentInputCap,
        estimatedInputTokens: 4_001,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "context-exhausted",
        diagnostic: expect.objectContaining({
          effectiveMaxInputTokens: 5_000,
          availableInputTokens: 4_000,
        }),
      }),
    );
  });

  it("rejects when reserved framing alone exceeds the input cap", () => {
    expect(() =>
      preflightContextBudget({
        ...baseBudget,
        effectiveMaxInputTokens: 4_095,
        estimatedInputTokens: 0,
      }),
    ).toThrow(ContextBudgetError);
  });

  it.each([
    [
      { effectiveContextWindow: 128_001 },
      "effectiveContextWindow must not exceed configuredContextWindow",
    ],
    [
      {
        effectiveContextWindow: 10_000,
        effectiveMaxInputTokens: 8_193,
        configuredMaxInputTokens: 8_192,
      },
      "effectiveMaxInputTokens must not exceed configuredMaxInputTokens",
    ],
    [
      { effectiveMaxOutputTokens: 4_097, configuredMaxOutputTokens: 4_096 },
      "effectiveMaxOutputTokens must not exceed configuredMaxOutputTokens",
    ],
  ] as const)("fails closed for incoherent effective limits", (limits, message) => {
    expect(() =>
      preflightContextBudget({
        ...baseBudget,
        ...limits,
        estimatedInputTokens: 1,
      }),
    ).toThrow(message);
  });

  it("clamps a too-small request only when the minimum fits", () => {
    expect(
      preflightContextBudget({
        ...baseBudget,
        estimatedInputTokens: 4_000,
        requestedOutputTokens: 1,
      }),
    ).toMatchObject({ outputTokens: 16, minimumApplied: true });
    expect(() =>
      preflightContextBudget({
        ...baseBudget,
        effectiveMaxOutputTokens: 15,
        estimatedInputTokens: 4_000,
        requestedOutputTokens: 1,
      }),
    ).toThrow(ContextBudgetError);
  });

  it("keeps prompt content out of its diagnostic", () => {
    let failure: unknown;
    try {
      preflightContextBudget({ ...baseBudget, estimatedInputTokens: 9_999 });
    } catch (error) {
      failure = error;
    }
    expect(JSON.stringify(failure)).not.toContain("secret prompt marker");
    expect((failure as Error).message).not.toContain("secret prompt marker");
  });
});

describe("createContextBudgetedStream", () => {
  const constrainedConfig = {
    ...validModelConfig,
    profile: {
      ...validModelConfig.profile,
      contextWindow: 8_192,
      maxInputTokens: 8_192,
      maxOutputTokens: 4_096,
    },
  };
  const model = {
    id: "example/model",
    name: "example/model",
    api: "openai-completions",
    provider: "test-provider",
    baseUrl: "https://example.test/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8_192,
    maxTokens: 4_096,
  } as Parameters<ModelRuntime["streamSimple"]>[0];

  it("rejects an exhausted context before the provider delegate", () => {
    let calls = 0;
    const delegate = (() => {
      calls += 1;
      return {} as ReturnType<ModelRuntime["streamSimple"]>;
    }) as ModelRuntime["streamSimple"];
    const stream = createContextBudgetedStream(constrainedConfig, delegate);

    expect(() =>
      stream(model, {
        systemPrompt: "x".repeat(16_500),
        messages: [],
      }),
    ).toThrow(ContextBudgetError);
    expect(calls).toBe(0);
  });

  it("forwards at least the translated API minimum without Pi reclamping", () => {
    let captured:
      | {
          contextWindow: number;
          maxTokens: number | undefined;
        }
      | undefined;
    const delegate = ((requestModel, _context, options) => {
      captured = {
        contextWindow: requestModel.contextWindow,
        maxTokens: options?.maxTokens,
      };
      return {} as ReturnType<ModelRuntime["streamSimple"]>;
    }) as ModelRuntime["streamSimple"];
    const stream = createContextBudgetedStream(constrainedConfig, delegate);

    stream(model, { systemPrompt: "probe", messages: [] }, { maxTokens: 1 });
    expect(captured).toEqual({ contextWindow: 0, maxTokens: 16 });
  });

  it("stops at independent input cap +1 before provider I/O", () => {
    const context = { systemPrompt: "probe", messages: [] };
    const estimated = estimateModelRequestTokens(context);
    const delegate = vi.fn(
      () => ({}) as ReturnType<ModelRuntime["streamSimple"]>,
    ) as ModelRuntime["streamSimple"];
    const reserve = constrainedConfig.requestPolicy.reservedContextTokens;
    const atBoundary = createContextBudgetedStream(
      {
        ...constrainedConfig,
        profile: {
          ...constrainedConfig.profile,
          maxInputTokens: estimated + reserve,
        },
      },
      delegate,
    );

    atBoundary(model, context, { maxTokens: 16 });
    expect(delegate).toHaveBeenCalledTimes(1);

    const overBoundary = createContextBudgetedStream(
      {
        ...constrainedConfig,
        profile: {
          ...constrainedConfig.profile,
          maxInputTokens: estimated + reserve - 1,
        },
      },
      delegate,
    );
    expect(() => overBoundary(model, context, { maxTokens: 16 })).toThrow(ContextBudgetError);
    expect(delegate).toHaveBeenCalledTimes(1);
  });
});

describe("estimateModelRequestTokens", () => {
  it("ignores cached usage that predates a newer message prefix", () => {
    const estimate = estimateModelRequestTokens({
      messages: [
        { role: "user", timestamp: 200, content: "short" },
        {
          role: "assistant",
          timestamp: 100,
          content: "reply",
          usage: { totalTokens: 10_000 },
        },
      ],
    });

    expect(estimate).toBeLessThan(10_000);
  });

  it.each(["error", "aborted"])(
    "ignores partial usage from an assistant turn stopped as %s",
    (stopReason) => {
      const estimate = estimateModelRequestTokens({
        messages: [
          {
            role: "assistant",
            timestamp: 100,
            stopReason,
            content: "partial reply",
            usage: { totalTokens: 10_000 },
          },
        ],
      });

      expect(estimate).toBeLessThan(10_000);
    },
  );

  it("accounts for tools added after the latest valid usage snapshot", () => {
    const estimate = estimateModelRequestTokens({
      messages: [
        {
          role: "assistant",
          timestamp: 100,
          content: "reply",
          usage: { totalTokens: 100 },
        },
        {
          role: "toolResult",
          timestamp: 200,
          content: "",
          addedToolNames: ["deferred-tool"],
        },
      ],
      tools: [
        {
          name: "deferred-tool",
          description: "x".repeat(400),
        },
      ],
    });

    expect(estimate).toBeGreaterThan(100);
  });
});

describe("describeModelTurnAdmission", () => {
  const reservedTokens = 4_096;
  const requiredMinimumOutputTokens = 16;
  const hostOnlyPadding = "host-only-prompt-guideline ".repeat(2_000);
  const unsentReadPayload = "unsent-pi-truncation-content ".repeat(2_000);

  function ordinaryJobContext(
    workflow: "create-documentation" | "update-documentation" | "review-documentation",
    instruction: string,
  ) {
    const visibleRead = `# ${workflow} evidence\n${"documented behavior ".repeat(80)}`;
    const tools = [
      {
        name: "read",
        description: "Read one workspace file.",
        parameters: {
          type: "object",
          required: ["path"],
          properties: { path: { type: "string" } },
        },
        promptSnippet: hostOnlyPadding,
        promptGuidelines: [hostOnlyPadding],
        execute: () => hostOnlyPadding,
      },
    ];
    return {
      systemPrompt: `DocsFab ${workflow} skill. Preserve credentials and required evidence.`,
      messages: [
        { role: "user", timestamp: 1, content: instruction },
        {
          role: "assistant",
          timestamp: 2,
          content: [
            { type: "toolCall", id: "read-1", name: "read", arguments: { path: "docs/cli.md" } },
          ],
          usage: { input: 1_200, output: 40, cacheRead: 0, cacheWrite: 0, totalTokens: 1_240 },
          stopReason: "toolUse",
        },
        {
          role: "toolResult",
          timestamp: 3,
          toolCallId: "read-1",
          toolName: "read",
          content: [{ type: "text", text: visibleRead }],
          details: { truncation: { content: unsentReadPayload } },
        },
      ],
      tools,
    };
  }

  const jobs = [
    ["create-documentation", "Create docs/health.md for the /health endpoint from src/server.ts."],
    [
      "update-documentation",
      "Update docs/cli.md so --format default and exit codes match src/cli.ts.",
    ],
    [
      "review-documentation",
      "Review docs/api.md against src/server.ts and report source-supported findings.",
    ],
  ] as const;

  it.each(jobs)(
    "reserves %s within an asserted bound of counted tokens and admits under the window",
    (workflow, instruction) => {
      const context = ordinaryJobContext(workflow, instruction);
      const visibleTrailing = Math.ceil(
        `# ${workflow} evidence\n${"documented behavior ".repeat(80)}`.length / 4,
      );
      const countedTokens = 1_240 + visibleTrailing;
      const admission = describeModelTurnAdmission(context, reservedTokens);
      const serializedBytes = Buffer.byteLength(JSON.stringify(context.messages), "utf8");

      expect(admission.estimatedInputTokens).toBe(countedTokens);
      expect(admission.admissionTokens).toBe(countedTokens + reservedTokens);
      expect(admission.estimatedInputTokens).toBeLessThan(serializedBytes / 4);
      expect(serializedBytes).toBeGreaterThan(unsentReadPayload.length);

      const roomyWindow = 32_768;
      expect(
        preflightContextBudget({
          configuredContextWindow: 128_000,
          effectiveContextWindow: roomyWindow,
          configuredMaxInputTokens: 128_000,
          effectiveMaxInputTokens: roomyWindow,
          configuredMaxOutputTokens: 16_384,
          effectiveMaxOutputTokens: 4_096,
          reservedTokens,
          estimatedInputTokens: admission.estimatedInputTokens,
          requiredMinimumOutputTokens,
        }),
      ).toMatchObject({
        availableInputTokens: roomyWindow - reservedTokens,
        estimatedInputTokens: countedTokens,
      });
    },
  );

  it("fails closed when counted tokens exceed the real window", () => {
    const context = ordinaryJobContext(
      "review-documentation",
      "Review docs/api.md against src/server.ts.",
    );
    const estimatedInputTokens = estimateModelRequestTokens(context);
    const tightWindow = estimatedInputTokens + reservedTokens + requiredMinimumOutputTokens - 1;

    expect(() =>
      preflightContextBudget({
        configuredContextWindow: 128_000,
        effectiveContextWindow: tightWindow,
        configuredMaxInputTokens: 128_000,
        effectiveMaxInputTokens: tightWindow,
        configuredMaxOutputTokens: 16_384,
        effectiveMaxOutputTokens: 4_096,
        reservedTokens,
        estimatedInputTokens,
        requiredMinimumOutputTokens,
      }),
    ).toThrow(ContextBudgetError);
  });

  it("does not charge host tool prompt copy against the reservation", () => {
    const context = ordinaryJobContext(
      "create-documentation",
      "Create docs/health.md from src/server.ts.",
    );
    const withoutHostCopy = {
      ...context,
      tools: context.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })),
    };

    expect(estimateModelRequestTokens(context)).toBe(estimateModelRequestTokens(withoutHostCopy));
    expect(estimateModelRequestTokens(context)).toBeLessThan(Math.ceil(hostOnlyPadding.length / 4));
  });
});

describe("localStopReason", () => {
  it("reads the governor's closed reason from a local-stop message and from nothing else", () => {
    expect(
      localStopReason(`${LOCAL_STOP_MESSAGE_PREFIX} reason=output-authority-exhausted turn=20`),
    ).toBe("output-authority-exhausted");
    expect(localStopReason(`${LOCAL_STOP_MESSAGE_PREFIX} reason=provider-turn-limit turn=13`)).toBe(
      "provider-turn-limit",
    );
    // The classifier and this reader agree: every local stop is the host's
    // own budget stop.
    expect(
      classifyModelFailure(`${LOCAL_STOP_MESSAGE_PREFIX} reason=output-authority-exhausted`),
    ).toEqual({ category: "context-exhausted", retryable: false });
    // A provider body that quotes the same words is not a local stop, and a
    // local stop that names no reason yields none.
    expect(
      localStopReason(`503: ${LOCAL_STOP_MESSAGE_PREFIX} reason=output-authority-exhausted`),
    ).toBeUndefined();
    expect(
      localStopReason("Context budget exhausted before provider invocation: reason=x"),
    ).toBeUndefined();
    expect(localStopReason(LOCAL_STOP_MESSAGE_PREFIX)).toBeUndefined();
  });
});

describe("classifyModelFailure", () => {
  it.each([
    "Network access is disabled by this request.",
    "The network connection is documented.",
    "Check the connection settings.",
  ])("does not infer a retryable failure from descriptive prose: %s", (message) => {
    for (const error of [message, new Error(message)])
      expect(classifyModelFailure(error)).toEqual({
        category: "provider-terminal",
        retryable: false,
      });
  });

  it.each([
    "read ECONNRESET",
    "connect ECONNREFUSED",
    "Network error while reading response",
    "NetworkError: request failed",
    "connection failed",
    "connection error",
    "connection reset by peer",
    "connection closed",
  ])("preserves concrete network failures: %s", (message) => {
    for (const error of [message, new Error(message)])
      expect(classifyModelFailure(error)).toEqual({
        category: "provider-transient",
        retryable: true,
      });
  });

  it.each([
    [400, "invalid-request", false],
    [422, "invalid-request", false],
    [408, "timeout", true],
    [429, "throttled", true],
    [500, "provider-transient", true],
  ] as const)("classifies HTTP %s", (status, category, retryable) => {
    expect(classifyModelFailure({ status })).toEqual({ category, retryable });
  });

  it("keeps context exhaustion distinct and terminal", () => {
    const error = new ContextBudgetError({
      configuredContextWindow: 128_000,
      effectiveContextWindow: 8_192,
      configuredMaxInputTokens: 8_192,
      effectiveMaxInputTokens: 8_192,
      configuredMaxOutputTokens: 16_384,
      effectiveMaxOutputTokens: 4_096,
      reservedTokens: 4_096,
      estimatedInputTokens: 4_081,
      availableInputTokens: 15,
      availableOutputTokens: 15,
      requiredMinimumOutputTokens: 16,
    });
    expect(classifyModelFailure(error)).toEqual({
      category: "context-exhausted",
      retryable: false,
    });
  });

  it.each([400, 422])(
    "keeps HTTP %s terminal when its message contains transient wording",
    (status) => {
      expect(
        classifyModelFailure(
          Object.assign(new Error("connection timeout while parsing request"), {
            status,
          }),
        ),
      ).toEqual({ category: "invalid-request", retryable: false });
    },
  );

  it("recognizes a serialized local context-budget failure", () => {
    expect(
      classifyModelFailure(
        new Error("Context budget exhausted before provider invocation: effective-context=8192"),
      ),
    ).toEqual({ category: "context-exhausted", retryable: false });
  });

  it("classifies the pilot provider context-window 400 while preserving other invalid requests", () => {
    const pilot = Object.assign(
      new Error(
        "400: litellm.ContextWindowExceededError: litellm.BadRequestError: BedrockException: Context Window Error - The model returned the following errors: prompt is too long: 1009642 tokens > 1000000 maximum (model aws/anthropic/bedrock-claude-sonnet-5)",
      ),
      { status: 400, requestId: "semantic-e66a0f5029ad354a07e5df856184ea12bbd" },
    );
    const unrelated = Object.assign(new Error("400: request schema is invalid"), {
      status: 400,
      requestId: "semantic-unrelated-invalid-request",
    });
    expect(classifyModelFailure(pilot)).toEqual({
      category: "context-exhausted",
      retryable: false,
    });
    expect(classifyModelFailure(unrelated)).toEqual({
      category: "invalid-request",
      retryable: false,
    });
  });

  it("recognizes Pi's serialized multi-turn local stop", () => {
    expect(
      classifyModelFailure("Provider turn stopped locally: reason=provider-turn-limit turn=13"),
    ).toEqual({ category: "context-exhausted", retryable: false });
  });

  it("distinguishes malformed transport responses without overriding HTTP precedence", () => {
    expect(classifyModelFailure(new Error("invalid response envelope"))).toEqual({
      category: "malformed-response",
      retryable: true,
    });
    expect(
      classifyModelFailure(
        Object.assign(new Error("unexpected end of JSON response"), {
          status: 400,
        }),
      ),
    ).toEqual({ category: "invalid-request", retryable: false });
  });

  it("does not interpret unrelated three-digit values as HTTP statuses", () => {
    expect(classifyModelFailure(new Error("request timed out after 500 ms"))).toEqual({
      category: "timeout",
      retryable: true,
    });
    expect(classifyModelFailure(new Error("invalid response at position 400"))).toEqual({
      category: "malformed-response",
      retryable: true,
    });
    expect(classifyModelFailure(new Error("HTTP status 500"))).toEqual({
      category: "provider-transient",
      retryable: true,
    });
  });

  it("preserves typed blank-response disposition", () => {
    expect(
      classifyModelFailure(
        new InferenceStepError("Model returned a blank response.", "blank-response", true),
      ),
    ).toEqual({ category: "blank-response", retryable: true });
  });
});
