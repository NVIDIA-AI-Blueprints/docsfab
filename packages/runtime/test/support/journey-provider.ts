// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The scripted model for journey tests. A journey runs the shipped entry
 * point, the real `PiHarness`, and the real tool grant; only the provider
 * `fetch` is replaced. Each scripted turn reads the PARSED request (the tool
 * names offered, the tool results returned, and the host's nonce-bound
 * evidence frames) and never the system or user prose, so a prompt wording
 * change cannot silently re-route a journey.
 *
 * PiHarness reports a throw from `fetch` as a generic connection failure, so
 * every refusal is written to a ledger before it is thrown. A journey asserts
 * the ledger is empty and every turn was consumed, whether the run passed or
 * failed; a refusal therefore fails by its own code, never as a provider
 * outage.
 */
import { validModelConfig } from "../helpers.js";
import { parseEvidenceFrames } from "../helpers/knowledge-evidence-frames.js";
import { textTurn, toolTurn, type ScriptedToolCall } from "./pi-harness-session-fixtures.js";

export type JourneyRefusalCode =
  | "journey-tool-not-offered"
  | "journey-request-unparseable"
  | "journey-script-exhausted"
  | "journey-turn-failed"
  | "journey-unexpected-endpoint";

export interface JourneyRefusal {
  readonly code: JourneyRefusalCode;
  /** Zero-based index of the `fetch` call that was refused. */
  readonly requestIndex: number;
  readonly toolName?: string;
  readonly detail?: string;
}

interface WireMessage {
  readonly role: string;
  readonly tool_call_id?: string;
  readonly content?: unknown;
}

interface WireRequest {
  readonly tools?: ReadonlyArray<{ readonly function?: { readonly name?: unknown } }>;
  readonly messages?: readonly WireMessage[];
}

/** One provider request, as a scripted turn may read it. */
export interface JourneyRequest {
  readonly index: number;
  /** Tool names offered, read from `tools[].function.name`. */
  readonly offeredTools: readonly string[];
  /** Parsed request body, kept for assertions. */
  readonly body: WireRequest;
  /** The text of the tool result answering one call id, or undefined. */
  toolResult(callId: string): string | undefined;
  /** The tool result for one call id, parsed as JSON; throws when absent. */
  toolResultJson<T>(callId: string): T;
  /**
   * The first-pass evidence frames the host offered, decoded by the knowledge
   * provider's own nonce-bound frame parser; the frame grammar, not prose.
   */
  evidenceFrames(): ReturnType<typeof parseEvidenceFrames>;
}

export type JourneyReply =
  | { readonly text: string }
  | { readonly calls: readonly ScriptedToolCall[] };

/** One scripted model turn: a function of the parsed request only. */
export type JourneyTurn = (request: JourneyRequest) => JourneyReply;

export interface JourneyProvider {
  readonly fetch: typeof globalThis.fetch;
  readonly ledger: readonly JourneyRefusal[];
  readonly requests: readonly JourneyRequest[];
  readonly turnCount: number;
  /** Turns consumed so far. */
  consumed(): number;
}

export class JourneyProviderUnsettledError extends Error {
  public constructor(
    public readonly ledger: readonly JourneyRefusal[],
    public readonly consumedTurns: number,
    public readonly turnCount: number,
  ) {
    super(
      ledger.length > 0
        ? `journey-provider-refused: ${ledger.map(formatRefusal).join(", ")}`
        : `journey-turns-unconsumed: ${String(consumedTurns)} of ${String(turnCount)} scripted turns consumed`,
    );
    this.name = "JourneyProviderUnsettledError";
  }
}

function formatRefusal(refusal: JourneyRefusal): string {
  return `${refusal.code}${refusal.toolName ? `:${refusal.toolName}` : ""}@${String(refusal.requestIndex)}`;
}

/** A reply that answers with text. */
export const reply =
  (text: string): JourneyTurn =>
  () => ({ text });

/** A reply that answers with JSON text. */
export const replyJson = (value: unknown): JourneyTurn => reply(JSON.stringify(value));

/** A reply that calls tools; `calls` may read the parsed request. */
export const callTools =
  (
    calls: readonly ScriptedToolCall[] | ((request: JourneyRequest) => readonly ScriptedToolCall[]),
  ): JourneyTurn =>
  (request) => ({ calls: typeof calls === "function" ? calls(request) : calls });

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
        ? (part as { text: string }).text
        : "",
    )
    .join("");
}

function parseRequest(index: number, init: RequestInit | undefined): JourneyRequest {
  const body = JSON.parse(String(init?.body)) as WireRequest;
  const offeredTools = (body.tools ?? []).flatMap((tool) =>
    typeof tool.function?.name === "string" ? [tool.function.name] : [],
  );
  const messages = body.messages ?? [];
  const toolResult = (callId: string) => {
    const message = messages.find(
      (candidate) => candidate.role === "tool" && candidate.tool_call_id === callId,
    );
    return message === undefined ? undefined : messageText(message.content);
  };
  return {
    index,
    offeredTools,
    body,
    toolResult,
    toolResultJson<T>(callId: string): T {
      const text = toolResult(callId);
      if (text === undefined) throw new Error(`no tool result answers call ${callId}`);
      return JSON.parse(text) as T;
    },
    evidenceFrames() {
      return parseEvidenceFrames(
        messages
          .filter((message) => message.role === "user")
          .map((message) => messageText(message.content))
          .join("\n"),
      );
    },
  };
}

/**
 * The journey provider. Turns are consumed in order. A tool call is admitted
 * only when the request offered a tool with exactly that name.
 */
export function journeyProvider(turns: readonly JourneyTurn[]): JourneyProvider {
  const ledger: JourneyRefusal[] = [];
  const requests: JourneyRequest[] = [];
  let next = 0;
  let seen = 0;
  const refuse = (refusal: JourneyRefusal): never => {
    ledger.push(refusal);
    throw new Error(
      `journey provider refused request ${String(refusal.requestIndex)}: ${refusal.code}`,
    );
  };
  const fetch = (async (url: unknown, init?: RequestInit) => {
    const requestIndex = seen;
    seen += 1;
    if (!String(url).startsWith(validModelConfig.baseUrl)) {
      return refuse({ code: "journey-unexpected-endpoint", requestIndex, detail: String(url) });
    }
    let request: JourneyRequest;
    try {
      request = parseRequest(requestIndex, init);
    } catch (error) {
      // Only a body that is not JSON; a parsed body a turn cannot read is a turn failure.
      return refuse({
        code: "journey-request-unparseable",
        requestIndex,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    requests.push(request);
    const turn = turns[next];
    if (turn === undefined) {
      return refuse({ code: "journey-script-exhausted", requestIndex: request.index });
    }
    next += 1;
    let answer: JourneyReply;
    try {
      answer = turn(request);
    } catch (error) {
      // Only the scripted turn's own throw, such as a tool result it expected
      // and did not find; refusals below are recorded under their own codes.
      return refuse({
        code: "journey-turn-failed",
        requestIndex: request.index,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    if ("text" in answer) return textTurn(answer.text);
    for (const call of answer.calls) {
      // Exact equality: a prefix or substring would admit a tool the step never offered.
      if (!request.offeredTools.includes(call.name)) {
        return refuse({
          code: "journey-tool-not-offered",
          requestIndex: request.index,
          toolName: call.name,
        });
      }
    }
    return toolTurn(answer.calls);
  }) as typeof globalThis.fetch;
  return {
    fetch,
    ledger,
    requests,
    turnCount: turns.length,
    consumed: () => next,
  };
}

/** Throws unless the ledger is empty and every scripted turn was consumed. */
export function assertJourneyProviderSettled(provider: JourneyProvider): void {
  if (provider.ledger.length > 0 || provider.consumed() !== provider.turnCount) {
    throw new JourneyProviderUnsettledError(
      [...provider.ledger],
      provider.consumed(),
      provider.turnCount,
    );
  }
}
