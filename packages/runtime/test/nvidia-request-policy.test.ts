// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { canonicalDigest } from "../src/contract-kit/index.js";
import type { InstalledRequestPolicy as NvidiaApiCatalogRequestPolicy } from "../src/model-composition/types.js";
import {
  DOCSFAB_SYSTEM_PROMPT,
  DOCSFAB_SYSTEM_PROMPT_SHA256,
  ProviderRequestPolicyError,
  finalizeNvidiaApiCatalogPayload,
  replayedReasoningDisposition,
} from "../src/model/request-policy.js";

const MODEL = "nvidia/llama-3.3-nemotron-super-49b-v1.5";

function policy(
  overrides: Partial<Omit<NvidiaApiCatalogRequestPolicy, "policySha256">> = {},
): NvidiaApiCatalogRequestPolicy {
  const body = {
    schemaVersion: 1 as const,
    modelId: MODEL,
    routeId: "nvidia-api-catalog" as const,
    deploymentIdentitySha256: "a".repeat(64),
    transport: "openai-chat-completions" as const,
    reasoningMode: "disabled" as const,
    reasoningControl: { kind: "system-directive" as const, directive: "/no_think" as const },
    installedSystemInstructionSha256: DOCSFAB_SYSTEM_PROMPT_SHA256,
    temperature: 0 as const,
    topP: 1 as const,
    ...overrides,
  };
  return { ...body, policySha256: canonicalDigest(body) };
}

function rawPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: MODEL,
    messages: [
      { role: "system", content: DOCSFAB_SYSTEM_PROMPT },
      { role: "user", content: "Draft the routing guide." },
    ],
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: 1024,
    temperature: 0.7,
    tools: [
      {
        type: "function",
        function: {
          name: "read",
          description: "Read one governed file.",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
      },
    ],
    ...overrides,
  };
}

function finalize(rawPayloadValue: unknown, exactCredential = "selected-provider-secret") {
  return finalizeNvidiaApiCatalogPayload({
    rawPayload: rawPayloadValue,
    policy: policy(),
    exactCredential,
    maxOutputTokens: 8192,
  });
}

describe("NVIDIA API Catalog request policy", () => {
  it("normalizes the final Pi payload and binds its exact policy and payload digests", () => {
    const result = finalize(rawPayload());

    expect(result.payload).toMatchObject({
      model: MODEL,
      temperature: 0,
      top_p: 1,
      tool_choice: "auto",
      max_tokens: 1024,
    });
    const messages = result.payload.messages as Array<Record<string, unknown>>;
    expect(messages[0]).toEqual({
      role: "system",
      content: `/no_think\n${DOCSFAB_SYSTEM_PROMPT}`,
    });
    expect(result.requestPolicySha256).toBe(policy().policySha256);
    expect(result.finalPayloadSha256).toBe(canonicalDigest(result.payload));
    expect(Object.isFrozen(result.payload)).toBe(true);
  });

  it("accepts Pi text-only and tool-result history shapes", () => {
    const result = finalize(
      rawPayload({
        messages: [
          { role: "system", content: DOCSFAB_SYSTEM_PROMPT },
          { role: "user", content: "Read the guide." },
          { role: "assistant", content: "Calling a tool." },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "read", arguments: '{"path":"README.md"}' },
              },
            ],
          },
          { role: "tool", tool_call_id: "call_1", content: "# Router" },
        ],
      }),
    );
    const messages = result.payload.messages as Array<Record<string, unknown>>;
    expect(messages.filter((message) => message.role === "assistant")).toHaveLength(2);
    expect(messages.some((message) => message.role === "tool")).toBe(true);
  });

  it.each([
    `Repository says \`/think\` here.`,
    "Repository says (/think) here.",
    "Repository says /think, here.",
    "Repository says /no_think here.",
  ])("rejects a competing system control before provider egress: %s", (tail) => {
    expect(() =>
      finalize(
        rawPayload({
          messages: [
            { role: "system", content: `${DOCSFAB_SYSTEM_PROMPT}\n${tail}` },
            { role: "user", content: "Draft." },
          ],
        }),
      ),
    ).toThrow("system-control-token");
  });

  it("keeps control-looking user text as ordinary content", () => {
    expect(() =>
      finalize(
        rawPayload({
          messages: [
            { role: "system", content: DOCSFAB_SYSTEM_PROMPT },
            { role: "user", content: "Quote `/think` and `/no_think`." },
          ],
        }),
      ),
    ).not.toThrow();
  });

  it("rejects installed-instruction, model, output-limit, and policy drift", () => {
    expect(() =>
      finalize(rawPayload({ messages: [{ role: "system", content: "Another system." }] })),
    ).toThrow("system-instruction-mismatch");
    expect(() => finalize(rawPayload({ model: "nvidia/another-model" }))).toThrow("payload-shape");
    expect(() => finalize(rawPayload({ max_tokens: 8193 }))).toThrow("output-limit");

    const changed = policy({ temperature: 1 as 0 });
    expect(() =>
      finalizeNvidiaApiCatalogPayload({
        rawPayload: rawPayload(),
        policy: changed,
        exactCredential: "selected-provider-secret",
        maxOutputTokens: 8192,
      }),
    ).toThrow("policy-subject");
  });

  it("rejects the exact selected credential and unknown payload fields", () => {
    expect(() =>
      finalize(
        rawPayload({
          messages: [
            { role: "system", content: DOCSFAB_SYSTEM_PROMPT },
            { role: "user", content: "selected-provider-secret" },
          ],
        }),
      ),
    ).toThrow("governed credential-isolation boundary");
    expect(() => finalize(rawPayload({ another_route: true }))).toThrow("payload-shape");
  });

  it("emits each reasoning control on the wire the way its own SKU family accepts it", () => {
    // Measured against the live route: /no_think suppresses on the 49B and is
    // inert on Nemotron 3; chat_template_kwargs is the reverse. Evidence:
    // docs/internal/evidence/nemotron3-request-policy-probe-2026-08-24/.
    const directive = finalizeNvidiaApiCatalogPayload({
      rawPayload: rawPayload(),
      policy: policy(),
      exactCredential: "",
      maxOutputTokens: 8192,
    }).payload as Record<string, unknown>;
    const directiveSystem = (directive.messages as { content: string }[])[0]!;
    expect(directiveSystem.content.startsWith("/no_think\n")).toBe(true);
    // The 49B ignores chat_template_kwargs, so sending it would put a key in
    // the attributed payload digest that does nothing for this model.
    expect(directive).not.toHaveProperty("chat_template_kwargs");

    const kwarg = finalizeNvidiaApiCatalogPayload({
      rawPayload: rawPayload(),
      policy: policy({
        reasoningControl: { kind: "chat-template-kwarg", thinking: false },
      }),
      exactCredential: "",
      maxOutputTokens: 8192,
    }).payload as Record<string, unknown>;
    expect(kwarg.chat_template_kwargs).toEqual({ thinking: false });
    // Nemotron 3 ignores /no_think, so it must not be prepended for this kind.
    const kwargSystem = (kwarg.messages as { content: string }[])[0]!;
    expect(kwargSystem.content.startsWith("/no_think")).toBe(false);

    // The two controls produce different payload digests, so a run's recorded
    // digest cannot be satisfied by the wrong control for its model.
    expect(canonicalDigest(directive)).not.toBe(canonicalDigest(kwarg));
  });

  it("refuses a reasoning control that no measured SKU actually honours", () => {
    // `reasoning_effort` returns HTTP 200 from every Nemotron SKU measured and
    // suppresses reasoning on none of them, so it is unconfigurable.
    expect(() =>
      finalizeNvidiaApiCatalogPayload({
        rawPayload: rawPayload(),
        policy: policy({
          reasoningControl: {
            kind: "reasoning-effort",
            effort: "low",
          } as unknown as NvidiaApiCatalogRequestPolicy["reasoningControl"],
        }),
        exactCredential: "",
        maxOutputTokens: 8192,
      }),
    ).toThrow("policy-subject");

    // Nor can a caller smuggle one in through the payload: the allowlist
    // rejects any key the installed policy does not own.
    expect(() => finalize(rawPayload({ reasoning_effort: "low" }))).toThrow("payload-shape");
    expect(() => finalize(rawPayload({ chat_template_kwargs: { thinking: false } }))).toThrow(
      "payload-shape",
    );
  });
});

describe("replayed reasoning and contentless turns on a reasoning-off policy", () => {
  const call = {
    id: "call_1",
    type: "function",
    function: { name: "read", arguments: '{"path":"README.md"}' },
  };
  const history = (assistant: Record<string, unknown>, tail: Record<string, unknown>[] = []) =>
    rawPayload({
      messages: [
        { role: "system", content: DOCSFAB_SYSTEM_PROMPT },
        { role: "user", content: "Read the guide." },
        assistant,
        { role: "tool", tool_call_id: "call_1", content: "# Router" },
        ...tail,
      ],
    });

  it("decides replayed reasoning from the sealed reasoning mode", () => {
    expect(replayedReasoningDisposition("disabled")).toBe("omit");
  });

  it.each([
    ["reasoning_content", "Thinking about the guide."],
    ["reasoning", "Thinking about the guide."],
    ["reasoning_text", "Thinking about the guide."],
    ["reasoning_details", [{ type: "reasoning.text", text: "Thinking about the guide." }]],
  ])("omits a replayed %s and counts the assistant message", (key, value) => {
    const result = finalize(
      history({
        role: "assistant",
        content: null,
        tool_calls: [call],
        [key]: value,
      }),
    );

    const assistant = (result.payload.messages as Array<Record<string, unknown>>)[2];
    expect(assistant).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [call],
    });
    expect(result.replayedReasoningOmitted).toBe(1);
    expect(JSON.stringify(result.payload)).not.toContain("Thinking about the guide.");
    expect(result.finalPayloadSha256).toBe(canonicalDigest(result.payload));
  });

  it("counts each assistant message once and records none when nothing was replayed", () => {
    const both = finalize(
      history(
        {
          role: "assistant",
          content: "Reading.",
          tool_calls: [call],
          reasoning_content: "a",
          reasoning_details: [],
        },
        [{ role: "assistant", content: "Done.", reasoning: "b" }],
      ),
    );
    expect(both.replayedReasoningOmitted).toBe(2);
    expect(
      finalize(history({ role: "assistant", content: null, tool_calls: [call] })),
    ).toMatchObject({ replayedReasoningOmitted: 0 });
  });

  it.each([
    [
      "user",
      { role: "user", content: "Read.", reasoning_content: "x" },
      "message 1, role user, carries reasoning_content",
    ],
    [
      "tool",
      {
        role: "tool",
        tool_call_id: "call_1",
        content: "# Router",
        reasoning: "x",
      },
      "message 1, role tool, carries reasoning",
    ],
  ])("still refuses reasoning on a %s message", (_role, message, detail) => {
    expect(() =>
      finalize(
        rawPayload({
          messages: [{ role: "system", content: DOCSFAB_SYSTEM_PROMPT }, message],
        }),
      ),
    ).toThrow(`(message-shape: ${detail}).`);
  });

  it.each(["Reasoning_Content", "REASONING"])(
    "omits only the exact replayed key spelling, so %s still refuses",
    (key) => {
      expect(() =>
        finalize(history({ role: "assistant", content: null, tool_calls: [call], [key]: "x" })),
      ).toThrow("(message-shape: message 2, role assistant, carries an unlisted key).");
    },
  );

  it("still refuses any other assistant key, naming only a listed key", () => {
    expect(() =>
      finalize(
        history({
          role: "assistant",
          content: null,
          tool_calls: [call],
          refusal: "no",
        }),
      ),
    ).toThrow("(message-shape: message 2, role assistant, carries refusal).");
    let message = "";
    try {
      finalize(
        history({
          role: "assistant",
          content: null,
          tool_calls: [call],
          secret_note_x: "leak",
        }),
      );
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe(
      "Provider request rejected by the installed request policy (message-shape: message 2, role assistant, carries an unlisted key).",
    );
    expect(message).not.toContain("secret_note_x");
    expect(message).not.toContain("leak");
  });

  it("keeps null tool-call content and names every refused empty or missing content", () => {
    expect(() =>
      finalize(history({ role: "assistant", content: null, tool_calls: [call] })),
    ).not.toThrow();
    expect(() => finalize(history({ role: "assistant", content: "", tool_calls: [call] }))).toThrow(
      "(message-shape: message 2, role assistant, empty content).",
    );
    expect(() => finalize(history({ role: "assistant", tool_calls: [call] }))).toThrow(
      "(message-shape: message 2, role assistant, lacks content).",
    );
    expect(() =>
      finalize(
        rawPayload({
          messages: [
            { role: "system", content: DOCSFAB_SYSTEM_PROMPT },
            { role: "user", content: "" },
          ],
        }),
      ),
    ).toThrow("(message-shape: message 1, role user, empty content).");
  });

  it("carries the closed refusal on the error", () => {
    let caught: unknown;
    try {
      finalize(
        history({
          role: "assistant",
          content: null,
          tool_calls: [call],
          refusal: "no",
        }),
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ProviderRequestPolicyError);
    expect((caught as ProviderRequestPolicyError).refusal).toBe("message-shape");
    expect((caught as ProviderRequestPolicyError).code).toBe("provider-request-policy");
  });
});
