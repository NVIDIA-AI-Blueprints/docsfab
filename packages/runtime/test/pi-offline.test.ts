// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  assistantAuthoritySha256,
  assistantText,
  assistantTurnFailure,
  formatAssistantTurnFailure,
} from "../src/harness/pi-offline.js";
import { redactSecrets } from "../src/security/redaction.js";

describe("assistantTurnFailure", () => {
  it("keeps a truncated provider errorMessage on stopReason error", () => {
    const failure = assistantTurnFailure({
      stopReason: "error",
      errorMessage: "HTTP status 503: upstream overloaded\nretry later",
    });
    expect(failure).toMatchObject({
      disposition: "provider-failed",
      reason: "provider-terminal",
      detail: "HTTP status 503: upstream overloaded retry later",
    });
    expect(formatAssistantTurnFailure(failure!)).toBe(
      "provider-failed: HTTP status 503: upstream overloaded retry later",
    );
  });

  it("does not invent detail when the provider omitted errorMessage", () => {
    expect(
      assistantTurnFailure({
        stopReason: "error",
      }),
    ).toEqual({
      disposition: "provider-failed",
      checkpointDisposition: "provider-failed",
      reason: "provider-terminal",
      // A turn that named no error at all still carries the verdict that text
      // produced, so the step-level classifier never has to re-read a sentence.
      classification: { category: "provider-terminal", retryable: false },
    });
    expect(
      formatAssistantTurnFailure({
        disposition: "provider-failed",
        checkpointDisposition: "provider-failed",
        reason: "provider-terminal",
      }),
    ).toBe("provider-failed");
  });

  it("keeps the provider's own classification on the failure", () => {
    // The step-level classifier must not re-read DocsFab's composed sentence:
    // doing so loses the hub's leading 503 and fails a replayed-and-exhausted
    // transient as provider-terminal.
    const failure = assistantTurnFailure(
      {
        stopReason: "error",
        errorMessage:
          '503: {"error":{"message":"litellm.ServiceUnavailableError: BedrockException","code":"503"}}',
      },
      { providerAttempts: 3 },
    );
    expect(failure?.classification).toEqual({ category: "provider-transient", retryable: true });
    expect(failure?.detail).toContain("3 provider attempts");
    expect(failure?.detail).toContain("litellm.ServiceUnavailableError");
    // A single attempt states no count rather than inventing "1 attempt" noise.
    expect(
      assistantTurnFailure({ stopReason: "error", errorMessage: "503: upstream" })?.detail,
    ).toBe("503: upstream");
  });

  it("names an exhausted output authority as the lease's budget stop, not a provider failure", () => {
    // The governor's local stop reaches Pi as an assistant errorMessage; it is
    // the lease's own cumulative-output-limit, and no provider turn happened for
    // it.
    const failure = assistantTurnFailure({
      stopReason: "error",
      errorMessage:
        "Provider turn stopped locally: reason=output-authority-exhausted turn=20 provider-turn-limit=512 tool-calls=30 tool-call-limit=400 estimated-input=50000 available-input=520192 available-output=470000 required-minimum-output=16 cumulative-output=127500 output-authority=128000 output-floor=1040",
    });
    expect(failure).toMatchObject({
      disposition: "budget-stopped",
      reason: "output-authority-exhausted",
      localStop: true,
      classification: { category: "context-exhausted", retryable: false },
    });
    expect(failure?.detail).toContain("cumulative-output=127500 output-authority=128000");
    // Every other governor stop keeps its context-exhausted verdict and is
    // still marked local: no provider turn happened for it either.
    expect(
      assistantTurnFailure({
        stopReason: "error",
        errorMessage: "Provider turn stopped locally: reason=provider-turn-limit turn=13",
      }),
    ).toMatchObject({
      disposition: "context-exhausted",
      reason: "context-exhausted",
      localStop: true,
    });
    // A provider answer is not a local stop.
    expect(
      assistantTurnFailure({ stopReason: "error", errorMessage: "503: upstream" })?.localStop,
    ).toBeUndefined();
  });

  it("caps provider detail at 300 characters", () => {
    const failure = assistantTurnFailure({
      stopReason: "error",
      errorMessage: `HTTP status 500: ${"x".repeat(400)}`,
    });
    expect(failure?.detail).toHaveLength(301);
    expect(failure?.detail?.endsWith("…")).toBe(true);
  });

  /**
   * A terminal turn that billed its whole output budget with
   * finish_reason=length and surfaced nothing must be named for its shape and
   * the limit an operator would raise, not as a bare blank turn.
   */
  describe("turns stopped at the output limit", () => {
    const live = {
      content: [],
      stopReason: "length",
      rawStopReason: "length",
      usage: { input: 52_486, output: 8_192 },
    };

    it("names a withheld cut as output-truncated with the step, the limit and the tokens consumed, not as blank", () => {
      // The name must not claim the withheld payload was a tool call, and must say
      // which step and how much of the budget the cut turn burned.
      const failure = assistantTurnFailure(live, {
        blankProviderTurns: 2,
        providerAttempts: 2,
        outputTokenLimit: 8_192,
        stepId: "evaluate-document-quality",
      });
      expect(failure).toMatchObject({
        disposition: "provider-failed",
        checkpointDisposition: "provider-failed",
        reason: "provider-terminal",
        // The retry rule decides; the classifier names the cut-answer condition.
        classification: { category: "malformed-response", retryable: true },
        condition: "cut-answer",
      });
      expect(failure?.disposition).not.toBe("blank");
      expect(failure?.detail).toBe(
        "output-truncated: 2 provider turns of step evaluate-document-quality hit the 8,192-token " +
          "output limit (finish_reason=length), last turn consumed 8,192 output tokens, no text or " +
          "tool call surfaced; the provider withheld the cut answer. Shorten the answer or raise " +
          "maxOutputTokens.",
      );
      expect(failure!.detail!.length).toBeLessThanOrEqual(300);
      expect(failure?.detail).not.toContain("…");
      expect(formatAssistantTurnFailure(failure!)).toMatch(
        /^provider-failed: output-truncated: 2 provider turns of step evaluate-document-quality/u,
      );
      // A single cut (the nudged replay was vetoed) says so; without a step id
      // the sentence still reads, and a turn without usage names no count.
      expect(
        assistantTurnFailure(live, { blankProviderTurns: 1, outputTokenLimit: 8_192 })?.detail,
      ).toMatch(/^output-truncated: 1 provider turn of the step hit the 8,192-token output limit/u);
      expect(
        assistantTurnFailure({ ...live, usage: undefined }, { outputTokenLimit: 8_192 })?.detail,
      ).toContain("(finish_reason=length), no text or tool call surfaced");
    });

    it("keeps partial text and names it text-truncated instead of accepting it as complete", () => {
      const text = "# Quality report\n\n## Findings\n1. The";
      const message = { ...live, content: [{ type: "text", text }] };
      const failure = assistantTurnFailure(message, { outputTokenLimit: 8_192 });
      // Not blank, and not silently complete.
      expect(failure).toMatchObject({
        disposition: "provider-failed",
        reason: "provider-terminal",
        classification: { category: "malformed-response", retryable: true },
        condition: "cut-answer",
      });
      expect(failure?.detail).toBe(
        "text-truncated: the step answer cut at the 8,192-token output limit " +
          `(finish_reason=length) after ${text.length} characters, last turn consumed 8,192 ` +
          "output tokens; partial text retained, not accepted as complete. Shorten the answer or " +
          "raise maxOutputTokens.",
      );
      // With the step named, the sentence says which step's answer outgrew the limit.
      expect(
        assistantTurnFailure(message, { outputTokenLimit: 8_192, stepId: "review-documentation" })
          ?.detail,
      ).toMatch(/^text-truncated: step review-documentation answer cut at the 8,192-token/u);
      // The text itself stays the turn's content: identity and the response
      // capture both still read it.
      expect(assistantText(message)).toBe(text);
      // Positive control: the same text with an ordinary stop is a complete turn.
      expect(
        assistantTurnFailure({ ...message, stopReason: "stop", rawStopReason: "stop" }),
      ).toBeUndefined();
      // A thinking-only cut is text for the same reason `assistantText` reads it.
      expect(
        assistantTurnFailure(
          { ...live, content: [{ type: "thinking", thinking: "partial" }] },
          { outputTokenLimit: 8_192 },
        )?.detail,
      ).toMatch(/^text-truncated:/u);
    });

    /**
     * A request clamped to the cumulative output lease's remainder can be cut at
     * that remainder. The composition's `maxOutputTokens` was not the binding
     * limit, so the message names the lease remainder and limit instead of
     * "raise maxOutputTokens".
     */
    const clampedCut = { ...live, usage: { input: 52_486, output: 10_000 } };
    const outputLeaseClamp = { remainingOutputTokens: 10_000, maxOutputTokens: 128_000 };

    it("names the lease clamp instead of maxOutputTokens when a withheld cut was clamped to the lease", () => {
      const failure = assistantTurnFailure(clampedCut, {
        blankProviderTurns: 1,
        outputTokenLimit: 10_000,
        outputLeaseClamp,
        stepId: "evaluate-document-quality",
      });
      expect(failure?.detail).toBe(
        "output-truncated: 1 provider turn of step evaluate-document-quality hit the 10,000-token " +
          "output limit (finish_reason=length), last turn consumed 10,000 output tokens, no text or " +
          "tool call surfaced; the provider withheld the cut answer. Shorten the answer; the limit " +
          "was the 10,000 output tokens left of the 128,000-token cumulative output lease, not " +
          "maxOutputTokens.",
      );
      // The provider-detail cap does not elide the clamp.
      expect(failure?.detail).not.toContain("…");
      expect(failure?.detail).not.toContain("raise maxOutputTokens");
      // Positive control: the same cut without a clamp keeps the maxOutputTokens remedy.
      expect(
        assistantTurnFailure(clampedCut, {
          blankProviderTurns: 1,
          outputTokenLimit: 10_000,
          stepId: "evaluate-document-quality",
        })?.detail,
      ).toMatch(/ Shorten the answer or raise maxOutputTokens\.$/u);
    });

    it("names the lease clamp instead of maxOutputTokens when a cut terminal answer was clamped to the lease", () => {
      const text = "# Quality report\n\n## Findings\n1. The";
      const message = { ...clampedCut, content: [{ type: "text", text }] };
      const failure = assistantTurnFailure(message, {
        outputTokenLimit: 10_000,
        outputLeaseClamp,
        stepId: "review-documentation",
      });
      expect(failure?.detail).toBe(
        "text-truncated: step review-documentation answer cut at the 10,000-token output limit " +
          `(finish_reason=length) after ${text.length} characters, last turn consumed 10,000 ` +
          "output tokens; partial text retained, not accepted as complete. Shorten the answer; the " +
          "limit was the 10,000 output tokens left of the 128,000-token cumulative output lease, " +
          "not maxOutputTokens.",
      );
      expect(failure?.detail).not.toContain("…");
      expect(failure?.detail).not.toContain("raise maxOutputTokens");
      // Positive control: the same cut without a clamp keeps the maxOutputTokens remedy.
      expect(
        assistantTurnFailure(message, { outputTokenLimit: 10_000, stepId: "review-documentation" })
          ?.detail,
      ).toMatch(/ Shorten the answer or raise maxOutputTokens\.$/u);
    });

    it("leaves a streamed truncated tool call to Pi's own re-issue loop", () => {
      // pi-ai keeps the call with salvaged arguments and Pi's agent loop
      // refuses to execute it and asks the model to re-issue; the harness
      // bounds that repeat itself, so the classifier must not pre-empt it.
      expect(
        assistantTurnFailure(
          {
            ...live,
            content: [
              { type: "toolCall", id: "call_1", name: "canon_submit_artifact", arguments: {} },
            ],
          },
          { outputTokenLimit: 8_192 },
        ),
      ).toBeUndefined();
    });

    it("reads the provider's own max_tokens word and falls back when no limit is known", () => {
      const failure = assistantTurnFailure({ ...live, rawStopReason: "max_tokens" });
      expect(failure?.detail).toContain("hit the configured output limit");
      expect(failure?.detail).toContain("finish_reason=max_tokens");
    });

    it("still reports an ordinary empty turn as blank", () => {
      // Control: the empty-turn shape is unchanged by the length classification.
      const failure = assistantTurnFailure(
        { content: [], stopReason: "stop", rawStopReason: "stop" },
        { blankProviderTurns: 3, outputTokenLimit: 8_192 },
      );
      expect(failure).toMatchObject({ disposition: "blank", reason: "provider-terminal" });
      expect(failure?.detail).toBe("3 blank provider turns stopReason=stop finish_reason=stop");
      expect(failure?.classification).toBeUndefined();
    });
  });

  it("redacts a dummy api key from the composed inference error text", () => {
    const apiKey = "nvapi-test-secret-163-not-a-real-key";
    const failure = assistantTurnFailure({
      stopReason: "error",
      errorMessage: `HTTP status 401 using ${apiKey}`,
    });
    const composed = `Provider turn failed: ${formatAssistantTurnFailure(failure!)}.`;
    const redacted = redactSecrets(new Error(composed), [apiKey]);
    expect(redacted).toContain("[REDACTED]");
    expect(redacted).not.toContain(apiKey);
  });
});

describe("assistantText", () => {
  // Pi's AssistantMessage.content is (TextContent | ThinkingContent |
  // ToolCall)[] per pi-ai types.d.ts, so a plain string or a top-level
  // reasoning_content is unreachable here and is not tested.
  it("joins text blocks", () => {
    expect(
      assistantText({
        content: [
          { type: "text", text: "one" },
          { type: "text", text: "-two" },
        ],
      }),
    ).toBe("one-two");
  });

  it("falls back to thinking blocks when there is no text block", () => {
    // pi-ai's openai-completions adapter folds a provider's `reasoning_content`
    // delta into a {type:"thinking"} block, so this is how a reasoning-split
    // model reaches DocsFab. Reading only text blocks would report these turns
    // as blank and collapse their identity hash.
    expect(assistantText({ content: [{ type: "thinking", thinking: "the actual answer" }] })).toBe(
      "the actual answer",
    );
  });

  it("prefers real text over thinking when both are present", () => {
    expect(
      assistantText({
        content: [
          { type: "thinking", thinking: "scratchpad" },
          { type: "text", text: "answer" },
        ],
      }),
    ).toBe("answer");
  });

  it("excludes reasoning when selecting a completed structured answer", () => {
    expect(
      assistantText(
        { content: [{ type: "thinking", thinking: '{"verdict":"pass"}' }] },
        { thinkingFallback: false },
      ),
    ).toBe("");
    expect(
      assistantText(
        {
          content: [
            { type: "thinking", thinking: "scratchpad" },
            { type: "text", text: "answer" },
          ],
        },
        { thinkingFallback: false },
      ),
    ).toBe("answer");
  });

  it("does not read text that only repeats the turn's reasoning as an answer", () => {
    const echo = {
      content: [
        { type: "thinking", thinking: "We must return the ledger." },
        { type: "text", text: "We must return the ledger." },
      ],
    };
    expect(assistantText(echo, { thinkingFallback: false })).toBe("");
    // The turn keeps its reasoning as its identity text.
    expect(assistantText(echo)).toBe("We must return the ledger.");
    expect(
      assistantText(
        {
          content: [
            { type: "thinking", thinking: "We must return the ledger." },
            { type: "text", text: '{"completeness":"bounded-not-proven"}' },
          ],
        },
        { thinkingFallback: false },
      ),
    ).toBe('{"completeness":"bounded-not-proven"}');
  });

  it("ignores tool calls, which are not text", () => {
    expect(
      assistantText({
        content: [{ type: "toolCall", id: "c1", name: "read", arguments: {} }],
      }),
    ).toBe("");
  });

  it("still reports genuinely empty messages as empty", () => {
    expect(assistantText({})).toBe("");
    expect(assistantText({ content: [] })).toBe("");
    // Whitespace-only text counts as absent and falls through to thinking; with
    // no thinking block the result is empty, which is what the blank check wants.
    expect(assistantText({ content: [{ type: "text", text: "   " }] })).toBe("");
  });

  it("gives thinking-only turns distinct identities", () => {
    // With assistantText returning "", textSha256 would be hash("") for every
    // turn, so two turns with identical tool calls would produce the same
    // authority and the second would be rejected as a replayed batch. Distinct
    // thinking must yield distinct identities.
    const calls = [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }];
    const first = assistantAuthoritySha256({
      content: [{ type: "thinking", thinking: "first turn" }, ...calls],
    });
    const second = assistantAuthoritySha256({
      content: [{ type: "thinking", thinking: "second turn" }, ...calls],
    });
    expect(first).not.toBe(second);
  });
});
