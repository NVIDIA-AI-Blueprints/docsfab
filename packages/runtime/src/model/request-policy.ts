// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { canonicalDigest, deepFreeze } from "../contract-kit/index.js";
import {
  isInstalledPolicyRoute,
  type InstalledReasoningControl,
  type InstalledRequestPolicy,
} from "../model-composition/types.js";
import {
  CredentialBoundaryError,
  assertModelRequestCredentialFree,
} from "../security/credential-isolation.js";
import type { RequestPolicyRefusal } from "./request-policy-refusals.js";

export const DOCSFAB_SYSTEM_PROMPT = [
  "You are operating as DocsFab, a governed documentation workflow agent.",
  "Stay inside the selected repository. Never expose credentials. Base claims on repository evidence.",
].join("\n");

export const DOCSFAB_SYSTEM_PROMPT_SHA256 = canonicalDigest(DOCSFAB_SYSTEM_PROMPT);

const CONTROL_DIRECTIVE = /(?:^|[^A-Za-z0-9_])\/(?:no_)?think(?![A-Za-z0-9_])/u;
const RAW_PAYLOAD_KEYS = new Set([
  "model",
  "messages",
  "stream",
  "stream_options",
  "max_tokens",
  "temperature",
  "top_p",
  "tools",
  "tool_choice",
  "prompt_cache_key",
  "prompt_cache_retention",
  "store",
]);
// Reasoning controls (`chat_template_kwargs`, `reasoning_effort`, ...) must stay
// absent: the installed policy sets them from `reasoningControl`, never a
// caller. An unlisted key is already rejected as `payload-shape`.

/**
 * Reasoning fields Pi replays on an assistant turn: the delta field the
 * provider streamed the turn's reasoning in, or structured `reasoning_details`.
 */
const REPLAYED_REASONING_KEYS: readonly string[] = Object.freeze([
  "reasoning_content",
  "reasoning",
  "reasoning_text",
  "reasoning_details",
]);

/**
 * Message keys a refusal may name. Any other key is reported as "an unlisted
 * key", so a refusal never echoes a name the payload's author chose.
 */
const NAMEABLE_MESSAGE_KEYS: ReadonlySet<string> = new Set([
  "role",
  "content",
  "tool_calls",
  "tool_call_id",
  "name",
  "refusal",
  "audio",
  "function_call",
  "annotations",
  ...REPLAYED_REASONING_KEYS,
]);

const NAMEABLE_ROLES: ReadonlySet<string> = new Set(["system", "user", "assistant", "tool"]);

export interface FinalizedNvidiaApiCatalogPayload {
  readonly payload: Readonly<Record<string, unknown>>;
  readonly requestPolicySha256: string;
  readonly finalPayloadSha256: string;
  /**
   * Assistant messages whose replayed reasoning the policy omitted; 0 when
   * none. `finalPayloadSha256` digests the payload after the omission.
   */
  readonly replayedReasoningOmitted: number;
}

/**
 * DocsFab's own refusal of an outbound payload. `refusal` is the closed reason
 * (`request-policy-refusals.ts`); `detail` is host-written and content-free:
 * indexes, closed role and key names, and fixed words only.
 */
export class ProviderRequestPolicyError extends Error {
  public readonly code = "provider-request-policy" as const;
  public readonly retryable = false as const;
  public readonly refusal: RequestPolicyRefusal;

  public constructor(refusal: RequestPolicyRefusal, detail?: string) {
    super(
      `Provider request rejected by the installed request policy (${refusal}${detail ? `: ${detail}` : ""}).`,
    );
    this.name = "ProviderRequestPolicyError";
    this.refusal = refusal;
  }
}

/**
 * What the installed policy does with reasoning Pi replays on an assistant
 * turn, decided by the policy's sealed reasoning mode. A reasoning-off policy
 * omits it: the route was measured with reasoning off, a replayed field reaches
 * the model's chat template and changes its input, and the policy never asked
 * the model for it. A mode that admits reasoning must declare its own
 * disposition here before it can be installed.
 */
export function replayedReasoningDisposition(
  mode: InstalledRequestPolicy["reasoningMode"],
): "omit" {
  switch (mode) {
    case "disabled":
      return "omit";
    default: {
      const undeclared: never = mode;
      // hygiene: ok -- a reason code; the constructor makes it a sentence.
      throw new ProviderRequestPolicyError(
        "policy-subject",
        `reasoning mode ${String(undeclared)}`,
      );
    }
  }
}

export function finalizeNvidiaApiCatalogPayload(input: {
  rawPayload: unknown;
  policy: InstalledRequestPolicy;
  exactCredential: string;
  maxOutputTokens: number;
}): FinalizedNvidiaApiCatalogPayload {
  assertPolicy(input.policy);
  const raw = record(input.rawPayload, "payload-shape");
  if (
    Object.keys(raw).some((key) => !RAW_PAYLOAD_KEYS.has(key)) ||
    raw.model !== input.policy.modelId ||
    raw.stream !== true
  ) {
    throw new ProviderRequestPolicyError("payload-shape");
  }
  const disposition = replayedReasoningDisposition(input.policy.reasoningMode);
  let replayedReasoningOmitted = 0;
  const messages = array(raw.messages, "payload-shape", "messages").map((value, index) => {
    const normalized = normalizeMessage(value, index, disposition);
    if (normalized.omittedReasoning) replayedReasoningOmitted += 1;
    return normalized.message;
  });
  const systemIndexes = messages.flatMap((message, index) =>
    message.role === "system" ? [index] : [],
  );
  if (systemIndexes.length !== 1 || systemIndexes[0] !== 0) {
    throw new ProviderRequestPolicyError("system-instruction", "system-message-order");
  }
  const system = messages[0]!;
  if (typeof system.content !== "string") {
    throw new ProviderRequestPolicyError("system-instruction", "system-message-shape");
  }
  if (
    system.content !== DOCSFAB_SYSTEM_PROMPT &&
    !system.content.startsWith(`${DOCSFAB_SYSTEM_PROMPT}\n`)
  ) {
    throw new ProviderRequestPolicyError("system-instruction", "system-instruction-mismatch");
  }
  const systemTail = system.content.slice(DOCSFAB_SYSTEM_PROMPT.length);
  if (CONTROL_DIRECTIVE.test(systemTail)) {
    throw new ProviderRequestPolicyError("system-instruction", "system-control-token");
  }

  const maxTokens = positiveInteger(raw.max_tokens, "output-limit", "max-tokens");
  if (
    !Number.isSafeInteger(input.maxOutputTokens) ||
    input.maxOutputTokens < 1 ||
    maxTokens > input.maxOutputTokens
  ) {
    throw new ProviderRequestPolicyError("output-limit");
  }
  const streamOptions = record(raw.stream_options, "payload-shape", "stream-options");
  if (Object.keys(streamOptions).length !== 1 || streamOptions.include_usage !== true) {
    throw new ProviderRequestPolicyError("payload-shape", "stream-options");
  }
  const tools =
    raw.tools === undefined ? [] : array(raw.tools, "tool-shape", "tools").map(normalizeTool);
  const toolChoice = raw.tool_choice ?? "auto";
  if (!new Set(["auto", "none", "required"]).has(toolChoice as string)) {
    throw new ProviderRequestPolicyError("tool-shape", "tool-choice");
  }

  const control = input.policy.reasoningControl;
  const payload = deepFreeze({
    model: input.policy.modelId,
    messages: messages.map((message, index) =>
      index === 0 && control.kind === "system-directive"
        ? { ...message, content: `${control.directive}\n${system.content}` }
        : message,
    ),
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: maxTokens,
    temperature: input.policy.temperature,
    top_p: input.policy.topP,
    tools,
    tool_choice: toolChoice,
    // Emitted only for SKUs whose reasoning responds to it: the payload digest
    // attributes a run's behaviour to a policy, so an inert key must not appear.
    ...(control.kind === "chat-template-kwarg"
      ? { chat_template_kwargs: { thinking: control.thinking } }
      : {}),
  });
  assertModelRequestCredentialFree(payload);
  if (input.exactCredential.length > 0 && JSON.stringify(payload).includes(input.exactCredential)) {
    throw new CredentialBoundaryError("model-request");
  }
  assertToolHistoryCarriesTools(payload);
  return deepFreeze({
    payload,
    requestPolicySha256: input.policy.policySha256,
    finalPayloadSha256: canonicalDigest(payload),
    replayedReasoningOmitted,
  });
}

/**
 * Apply a measured reasoning control to a chat-completions payload in place.
 * `chat-template-kwarg` sets `chat_template_kwargs.thinking`; `system-directive`
 * prefixes the leading system message, which must exist as a string.
 */
export function applyReasoningControl(
  payload: Record<string, unknown>,
  control: InstalledReasoningControl,
): void {
  if (control.kind === "chat-template-kwarg") {
    const existing = payload.chat_template_kwargs;
    if (
      existing !== undefined &&
      (existing === null || typeof existing !== "object" || Array.isArray(existing))
    ) {
      // hygiene: ok -- a reason code; the constructor makes it a sentence.
      throw new ProviderRequestPolicyError("payload-shape", "chat-template-kwargs-shape");
    }
    payload.chat_template_kwargs = {
      ...(existing as Record<string, unknown> | undefined),
      thinking: control.thinking,
    };
    return;
  }
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const first = messages[0] as { role?: unknown; content?: unknown } | undefined;
  if (
    first === undefined ||
    (first.role !== "system" && first.role !== "developer") ||
    typeof first.content !== "string"
  ) {
    // hygiene: ok -- a reason code; the constructor makes it a sentence.
    throw new ProviderRequestPolicyError("system-instruction", "system-message-shape");
  }
  messages[0] = { ...first, content: `${control.directive}\n${first.content}` };
}

/**
 * Refuse a chat-completions payload whose conversation already holds tool
 * calls or tool results but which offers no tools.
 *
 * The condition: some `messages` entry is an assistant message with a
 * `tool_calls` entry, or a `role: "tool"` message, and `tools` is not a
 * non-empty array. Anthropic Messages and OpenAI Responses payloads carry tool
 * history elsewhere and are not read here. Some provider routes reject this
 * shape with HTTP 400, and pi-ai sends `tools: []` for it, so it fails by name
 * before any request.
 */
export function assertToolHistoryCarriesTools(payload: Readonly<Record<string, unknown>>): void {
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const index = messages.findIndex(isToolHistoryMessage);
  if (index < 0) return;
  const tools = payload.tools;
  if (Array.isArray(tools) && tools.length > 0) return;
  const kind =
    (messages[index] as { role?: unknown }).role === "tool" ? "a tool result" : "a tool call";
  const state =
    tools === undefined ? "absent" : Array.isArray(tools) ? "an empty array" : "not an array";
  // hygiene: ok -- a reason code with its detail; the constructor makes it a sentence.
  throw new ProviderRequestPolicyError(
    "tool-history-without-tools",
    `message ${index} is ${kind}, and tools is ${state}`,
  );
}

function isToolHistoryMessage(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const message = value as { role?: unknown; tool_calls?: unknown };
  return (
    message.role === "tool" ||
    (message.role === "assistant" &&
      Array.isArray(message.tool_calls) &&
      message.tool_calls.length > 0)
  );
}

function isSupportedReasoningControl(control: InstalledRequestPolicy["reasoningControl"]): boolean {
  if (control === null || typeof control !== "object") return false;
  if (control.kind === "system-directive") return control.directive === "/no_think";
  if (control.kind === "chat-template-kwarg") return control.thinking === false;
  return false;
}

function assertPolicy(policy: InstalledRequestPolicy): void {
  const { policySha256: _policySha256, ...body } = policy;
  if (
    canonicalDigest(body) !== policy.policySha256 ||
    !isInstalledPolicyRoute(policy.routeId) ||
    policy.transport !== "openai-chat-completions" ||
    policy.reasoningMode !== "disabled" ||
    !isSupportedReasoningControl(policy.reasoningControl) ||
    policy.installedSystemInstructionSha256 !== DOCSFAB_SYSTEM_PROMPT_SHA256 ||
    policy.temperature !== 0 ||
    policy.topP !== 1
  ) {
    throw new ProviderRequestPolicyError("policy-subject");
  }
}

interface NormalizedMessage {
  readonly message: Record<string, unknown>;
  /** The policy omitted this assistant message's replayed reasoning. */
  readonly omittedReasoning: boolean;
}

function normalizeMessage(value: unknown, index: number, disposition: "omit"): NormalizedMessage {
  const message = record(value, "message-shape", `message ${index} is not an object`);
  const role = message.role;
  const at = `message ${index}, role ${typeof role === "string" && NAMEABLE_ROLES.has(role) ? role : "unlisted"}`;
  if (role === "system" || role === "user") {
    messageKeys(message, ["role", "content"], ["role", "content"], at);
    return {
      message: { role, content: content(message.content, at) },
      omittedReasoning: false,
    };
  }
  if (role === "assistant") {
    // Decided before the key check, so a reasoning-off route never refuses, and
    // never forwards, the reasoning Pi replays from a streamed reasoning delta.
    const omittedReasoning =
      disposition === "omit" && REPLAYED_REASONING_KEYS.some((key) => Object.hasOwn(message, key));
    const admitted = Object.keys(message).filter(
      (key) => !(disposition === "omit" && REPLAYED_REASONING_KEYS.includes(key)),
    );
    messageKeys(
      Object.fromEntries(admitted.map((key) => [key, message[key]])),
      ["role", "content", "tool_calls"],
      ["role", "content"],
      at,
    );
    // `null` is Pi's content for a turn that only called tools.
    const assistantContent = message.content === null ? null : content(message.content, at);
    return {
      message: {
        role,
        content: assistantContent,
        tool_calls:
          message.tool_calls === undefined
            ? []
            : array(message.tool_calls, "message-tool-call", `${at}, tool_calls`).map(
                (call, callIndex) => normalizeToolCall(call, callIndex, at),
              ),
      },
      omittedReasoning,
    };
  }
  if (role === "tool") {
    messageKeys(
      message,
      ["role", "tool_call_id", "content"],
      ["role", "tool_call_id", "content"],
      at,
    );
    return {
      message: {
        role,
        tool_call_id: nonemptyString(message.tool_call_id, "message-shape", `${at}, tool_call_id`),
        content: content(message.content, at),
      },
      omittedReasoning: false,
    };
  }
  throw new ProviderRequestPolicyError("message-role", at);
}

/** Refuse a key outside `allowed`, or a missing `required` key, naming only listed keys. */
function messageKeys(
  message: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
  at: string,
): void {
  const extra = Object.keys(message).find((key) => !allowed.includes(key));
  if (extra !== undefined) {
    const name = NAMEABLE_MESSAGE_KEYS.has(extra) ? extra : "an unlisted key";
    throw new ProviderRequestPolicyError("message-shape", `${at}, carries ${name}`);
  }
  const missing = required.find((key) => !Object.hasOwn(message, key));
  if (missing !== undefined) {
    throw new ProviderRequestPolicyError("message-shape", `${at}, lacks ${missing}`);
  }
}

function normalizeToolCall(value: unknown, index: number, at: string): Record<string, unknown> {
  const where = `${at}, tool call ${index}`;
  const call = record(value, "message-tool-call", where);
  exactKeys(call, ["id", "type", "function"], "message-tool-call", where);
  if (call.type !== "function") {
    throw new ProviderRequestPolicyError("message-tool-call", `${where}, type`);
  }
  const fn = record(call.function, "message-tool-call", `${where}, function`);
  exactKeys(fn, ["name", "arguments"], "message-tool-call", `${where}, function`);
  return {
    id: nonemptyString(call.id, "message-tool-call", `${where}, id`),
    type: "function",
    function: {
      name: nonemptyString(fn.name, "message-tool-call", `${where}, name`),
      arguments: nonemptyString(fn.arguments, "message-tool-call", `${where}, arguments`),
    },
  };
}

function normalizeTool(value: unknown, index: number): Record<string, unknown> {
  const where = `tool ${index}`;
  const tool = record(value, "tool-shape", where);
  exactKeys(tool, ["type", "function"], "tool-shape", where);
  if (tool.type !== "function")
    throw new ProviderRequestPolicyError("tool-shape", `${where}, type`);
  const fn = record(tool.function, "tool-shape", `${where}, function`);
  // DocsFab registers every model with `supportsStrictMode: false`, so `strict`
  // is normally absent. It stays optional and is preserved when present,
  // because dropping a field the harness sent would digest a request that was
  // never sent.
  exactKeys(
    fn,
    Object.hasOwn(fn, "strict")
      ? ["name", "description", "parameters", "strict"]
      : ["name", "description", "parameters"],
    "tool-shape",
    `${where}, function`,
  );
  if (Object.hasOwn(fn, "strict") && typeof fn.strict !== "boolean") {
    throw new ProviderRequestPolicyError("tool-shape", `${where}, strict`);
  }
  return {
    type: "function",
    function: {
      name: nonemptyString(fn.name, "tool-shape", `${where}, name`),
      description: nonemptyString(fn.description, "tool-shape", `${where}, description`),
      parameters: structuredClone(record(fn.parameters, "tool-shape", `${where}, parameters`)),
      ...(Object.hasOwn(fn, "strict") ? { strict: fn.strict as boolean } : {}),
    },
  };
}

/** Message content: a non-empty string or a non-empty array of parts. */
function content(value: unknown, at: string): unknown {
  if (typeof value === "string" && value.length > 0) return value;
  if (Array.isArray(value) && value.length > 0) return structuredClone(value);
  throw new ProviderRequestPolicyError(
    "message-shape",
    `${at}, ${value === "" || (Array.isArray(value) && value.length === 0) ? "empty content" : "content of an unadmitted type"}`,
  );
}

function record(
  value: unknown,
  refusal: RequestPolicyRefusal,
  detail?: string,
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new ProviderRequestPolicyError(refusal, detail);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, refusal: RequestPolicyRefusal, detail: string): unknown[] {
  if (!Array.isArray(value)) throw new ProviderRequestPolicyError(refusal, detail);
  return value;
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  refusal: RequestPolicyRefusal,
  detail: string,
): void {
  if (
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some((key) => !keys.includes(key))
  ) {
    throw new ProviderRequestPolicyError(refusal, detail);
  }
}

function nonemptyString(value: unknown, refusal: RequestPolicyRefusal, detail: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ProviderRequestPolicyError(refusal, detail);
  }
  return value;
}

function positiveInteger(value: unknown, refusal: RequestPolicyRefusal, detail: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new ProviderRequestPolicyError(refusal, detail);
  }
  return value as number;
}
