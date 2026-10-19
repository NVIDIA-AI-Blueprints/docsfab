// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { InferenceStepError } from "../execution/contracts.js";
import type { InferenceFailureCategory } from "../records/contracts.js";

export interface ContextBudgetInput {
  configuredContextWindow: number;
  effectiveContextWindow: number;
  configuredMaxInputTokens: number;
  effectiveMaxInputTokens: number;
  configuredMaxOutputTokens: number;
  effectiveMaxOutputTokens: number;
  reservedTokens: number;
  estimatedInputTokens: number;
  requiredMinimumOutputTokens: number;
  requestedOutputTokens?: number;
}

export interface ContextBudgetResult extends ContextBudgetInput {
  availableInputTokens: number;
  availableOutputTokens: number;
  outputTokens: number;
  minimumApplied: boolean;
}

export interface ContextBudgetDiagnostic {
  configuredContextWindow: number;
  effectiveContextWindow: number;
  configuredMaxInputTokens: number;
  effectiveMaxInputTokens: number;
  configuredMaxOutputTokens: number;
  effectiveMaxOutputTokens: number;
  reservedTokens: number;
  estimatedInputTokens: number;
  availableInputTokens: number;
  availableOutputTokens: number;
  requiredMinimumOutputTokens: number;
}

export class ContextBudgetError extends Error {
  public readonly code = "context-exhausted" as const;
  public readonly retryable = false as const;
  public readonly diagnostic: ContextBudgetDiagnostic;

  public constructor(diagnostic: ContextBudgetDiagnostic) {
    super(
      [
        "Context budget exhausted before provider invocation:",
        `configured-context=${diagnostic.configuredContextWindow}`,
        `effective-context=${diagnostic.effectiveContextWindow}`,
        `configured-input=${diagnostic.configuredMaxInputTokens}`,
        `effective-input=${diagnostic.effectiveMaxInputTokens}`,
        `configured-output=${diagnostic.configuredMaxOutputTokens}`,
        `effective-output=${diagnostic.effectiveMaxOutputTokens}`,
        `reserved=${diagnostic.reservedTokens}`,
        `estimated-input=${diagnostic.estimatedInputTokens}`,
        `available-input=${diagnostic.availableInputTokens}`,
        `available-output=${diagnostic.availableOutputTokens}`,
        `required-minimum-output=${diagnostic.requiredMinimumOutputTokens}`,
      ].join(" "),
    );
    this.name = "ContextBudgetError";
    this.diagnostic = diagnostic;
  }
}

export function preflightContextBudget(input: ContextBudgetInput): ContextBudgetResult {
  for (const [name, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${name} must be a non-negative safe integer.`);
    }
  }
  if (input.requiredMinimumOutputTokens <= 0) {
    throw new Error("requiredMinimumOutputTokens must be positive.");
  }
  if (input.effectiveContextWindow > input.configuredContextWindow) {
    throw new Error("effectiveContextWindow must not exceed configuredContextWindow.");
  }
  if (input.configuredMaxInputTokens > input.configuredContextWindow) {
    throw new Error("configuredMaxInputTokens must not exceed configuredContextWindow.");
  }
  if (input.effectiveMaxInputTokens > input.effectiveContextWindow) {
    throw new Error("effectiveMaxInputTokens must not exceed effectiveContextWindow.");
  }
  if (input.effectiveMaxInputTokens > input.configuredMaxInputTokens) {
    throw new Error("effectiveMaxInputTokens must not exceed configuredMaxInputTokens.");
  }
  if (input.configuredMaxOutputTokens > input.configuredContextWindow) {
    throw new Error("configuredMaxOutputTokens must not exceed configuredContextWindow.");
  }
  if (input.effectiveMaxOutputTokens > input.effectiveContextWindow) {
    throw new Error("effectiveMaxOutputTokens must not exceed effectiveContextWindow.");
  }
  if (input.effectiveMaxOutputTokens > input.configuredMaxOutputTokens) {
    throw new Error("effectiveMaxOutputTokens must not exceed configuredMaxOutputTokens.");
  }

  const availableInputTokens = Math.max(0, input.effectiveMaxInputTokens - input.reservedTokens);
  const inputLimitExceeded =
    input.reservedTokens > input.effectiveMaxInputTokens ||
    input.estimatedInputTokens > input.effectiveMaxInputTokens - input.reservedTokens;

  const availableOutputTokens = Math.max(
    0,
    input.effectiveContextWindow - input.estimatedInputTokens - input.reservedTokens,
  );
  const effectiveCap = Math.min(input.effectiveMaxOutputTokens, availableOutputTokens);
  const diagnostic: ContextBudgetDiagnostic = {
    configuredContextWindow: input.configuredContextWindow,
    effectiveContextWindow: input.effectiveContextWindow,
    configuredMaxInputTokens: input.configuredMaxInputTokens,
    effectiveMaxInputTokens: input.effectiveMaxInputTokens,
    configuredMaxOutputTokens: input.configuredMaxOutputTokens,
    effectiveMaxOutputTokens: input.effectiveMaxOutputTokens,
    reservedTokens: input.reservedTokens,
    estimatedInputTokens: input.estimatedInputTokens,
    availableInputTokens,
    availableOutputTokens,
    requiredMinimumOutputTokens: input.requiredMinimumOutputTokens,
  };
  if (inputLimitExceeded || effectiveCap < input.requiredMinimumOutputTokens) {
    throw new ContextBudgetError(diagnostic);
  }

  const requested = Math.min(
    input.requestedOutputTokens ?? input.effectiveMaxOutputTokens,
    effectiveCap,
  );
  const outputTokens = grantedTurnOutputTokens({
    ...(input.requestedOutputTokens === undefined
      ? {}
      : { requestedOutputTokens: input.requestedOutputTokens }),
    effectiveMaxOutputTokens: input.effectiveMaxOutputTokens,
    availableOutputTokens,
    requiredMinimumOutputTokens: input.requiredMinimumOutputTokens,
  });
  return {
    ...input,
    availableInputTokens,
    availableOutputTokens,
    outputTokens,
    minimumApplied: outputTokens !== requested,
  };
}

/**
 * Per-turn output allowance sent as `max_tokens`: the requested amount, never
 * above the profile ceiling or remaining context, and never below the provider
 * minimum. Distinct from tokens produced (`InferenceTurnEvidence.outputTokens`).
 */
export function grantedTurnOutputTokens(input: {
  requestedOutputTokens?: number;
  effectiveMaxOutputTokens: number;
  availableOutputTokens: number;
  requiredMinimumOutputTokens: number;
}): number {
  return Math.max(
    Math.min(
      input.requestedOutputTokens ?? input.effectiveMaxOutputTokens,
      input.effectiveMaxOutputTokens,
      input.availableOutputTokens,
    ),
    input.requiredMinimumOutputTokens,
  );
}

/**
 * Ceiling for tokens one governed turn may record as produced.
 *
 * Each physical provider request may produce up to the per-request grant
 * (`grantedTurnOutputTokens`, also bounded by the profile and remaining
 * context). `providerRetries` absent means one request. This is not an SDK
 * `max_tokens` authority: every request still sends the single-request grant.
 */
export function producedTurnOutputTokenLimit(input: {
  requestedOutputTokens?: number;
  effectiveMaxOutputTokens: number;
  availableOutputTokens: number;
  requiredMinimumOutputTokens: number;
  providerRetries?: number;
}): number {
  const perRequest = Math.min(
    grantedTurnOutputTokens(input),
    input.effectiveMaxOutputTokens,
    input.availableOutputTokens,
  );
  return perRequest * ((input.providerRetries ?? 0) + 1);
}

interface RequestContextLike {
  systemPrompt?: string;
  messages: readonly unknown[];
  tools?: readonly unknown[];
}

/** The host token estimator's characters per token. */
export const CHARS_PER_TOKEN = 4;
const ESTIMATED_IMAGE_CHARS = 4_800;

function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "undefined";
  } catch {
    return "[unserializable]";
  }
}

function estimateContentChars(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  return content.reduce((total, block) => {
    if (!block || typeof block !== "object") return total;
    const item = block as Record<string, unknown>;
    if (item.type === "text" && typeof item.text === "string") {
      return total + item.text.length;
    }
    if (item.type === "thinking" && typeof item.thinking === "string") {
      return total + item.thinking.length;
    }
    if (item.type === "image") return total + ESTIMATED_IMAGE_CHARS;
    if (item.type === "toolCall") {
      return (
        total +
        (typeof item.name === "string" ? item.name.length : 0) +
        safeJson(item.arguments).length
      );
    }
    return total;
  }, 0);
}

function estimateMessageTokens(message: unknown): number {
  if (!message || typeof message !== "object") return 0;
  const item = message as Record<string, unknown>;
  if (item.role === "bashExecution") {
    return estimateTextTokens(
      `${typeof item.command === "string" ? item.command : ""}${typeof item.output === "string" ? item.output : ""}`,
    );
  }
  if (item.role === "branchSummary" || item.role === "compactionSummary") {
    return estimateTextTokens(typeof item.summary === "string" ? item.summary : "");
  }
  return Math.ceil(estimateContentChars(item.content) / CHARS_PER_TOKEN);
}

function usageTokens(message: unknown): number | undefined {
  if (!message || typeof message !== "object") return undefined;
  const item = message as Record<string, unknown>;
  if (item.role !== "assistant" || !item.usage || typeof item.usage !== "object") {
    return undefined;
  }
  if (item.stopReason === "error" || item.stopReason === "aborted") {
    return undefined;
  }
  const usage = item.usage as Record<string, unknown>;
  const component = (key: string): number | undefined =>
    typeof usage[key] === "number" ? (usage[key] as number) : undefined;
  const components = ["input", "output", "cacheRead", "cacheWrite"].map(component);
  // Completion tokens with no prompt tokens is a partial report, not an anchor:
  // anchoring on it would charge the whole prefix at the size of one response.
  if (components.some((value) => value !== undefined)) {
    const prompt =
      (component("input") ?? 0) + (component("cacheRead") ?? 0) + (component("cacheWrite") ?? 0);
    if (prompt <= 0) return undefined;
  }
  const total =
    typeof usage.totalTokens === "number"
      ? usage.totalTokens
      : components.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  return total > 0 ? total : undefined;
}

function messageTimestamp(message: unknown): number {
  if (!message || typeof message !== "object") return Number.NEGATIVE_INFINITY;
  const timestamp = (message as Record<string, unknown>).timestamp;
  return typeof timestamp === "number" ? timestamp : Number.NEGATIVE_INFINITY;
}

/**
 * Provider-visible tool fields only. Host wrappers copy prompt snippets,
 * guidelines, prepare hooks, and execute callbacks onto the same object; those
 * bytes never enter the tools array the provider bills.
 */
const PROVIDER_TOOL_KEYS = ["name", "description", "parameters", "input_schema", "type"] as const;

function projectProviderVisibleTool(tool: unknown): unknown {
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) return undefined;
  const item = tool as Record<string, unknown>;
  const projected: Record<string, unknown> = {};
  for (const key of PROVIDER_TOOL_KEYS) {
    if (item[key] !== undefined) projected[key] = item[key];
  }
  if (item.function !== undefined) {
    const nested = projectProviderVisibleTool(item.function);
    if (nested !== undefined) projected.function = nested;
  }
  return Object.keys(projected).length > 0 ? projected : undefined;
}

function estimateToolsTokens(tools: readonly unknown[] | undefined): number {
  if (!tools?.length) return 0;
  const projected = tools.map(projectProviderVisibleTool).filter((tool) => tool !== undefined);
  return projected.length ? estimateTextTokens(safeJson(projected)) : 0;
}

/**
 * Structural estimate over an exact message list. Only provider-visible content
 * blocks count; Pi's tool-result `details` (for `read`, Pi's own truncated read
 * of up to 50 KB, before DocsFab's per-call cap) travels on the same object but
 * is never sent to the provider.
 */
export function estimateTranscriptTokens(messages: readonly unknown[]): number {
  return messages.reduce<number>((sum, message) => sum + estimateMessageTokens(message), 0);
}

export interface ModelRequestTokenEstimate {
  /** Reported prefix plus the estimate of everything appended after it. */
  tokens: number;
  /** Provider-reported tokens for the prefix through `anchorIndex`; 0 when none. */
  reportedPrefixTokens: number;
  unreportedTokens: number;
  /** Estimate of the whole request without any provider-reported anchor. */
  structuralTokens: number;
  /** Un-margined estimate of the prefix the anchor claims to cover; 0 when none. */
  anchoredPrefixStructuralTokens: number;
  /** Index of the anchoring assistant message; -1 when the transcript has none. */
  anchorIndex: number;
}

/**
 * Describe the token estimate for one request without retaining its content.
 *
 * The anchor is the provider's usage for the latest usable assistant response.
 * Pi reports `input` net of cache reads and writes, so `input + cacheRead +
 * cacheWrite` is the billed prompt and `totalTokens` adds that response's
 * output: exactly the prefix the next request replays. The sum is the same for
 * a cache hit or miss, so authorization is invariant to cache state.
 */
export function describeModelRequestTokens(context: RequestContextLike): ModelRequestTokenEstimate {
  let latestUsageIndex = -1;
  let latestUsageTokens = 0;
  let latestPrefixTimestamp = Number.NEGATIVE_INFINITY;
  for (const [index, message] of context.messages.entries()) {
    const tokens = usageTokens(message);
    const timestamp = messageTimestamp(message);
    if (tokens !== undefined && timestamp >= latestPrefixTimestamp) {
      latestUsageIndex = index;
      latestUsageTokens = tokens;
    }
    latestPrefixTimestamp = Math.max(latestPrefixTimestamp, timestamp);
  }

  const structuralTokens =
    estimateTextTokens(context.systemPrompt ?? "") +
    estimateTranscriptTokens(context.messages) +
    estimateToolsTokens(context.tools);

  if (latestUsageIndex < 0) {
    return {
      tokens: structuralTokens,
      reportedPrefixTokens: 0,
      unreportedTokens: structuralTokens,
      structuralTokens,
      anchoredPrefixStructuralTokens: 0,
      anchorIndex: -1,
    };
  }

  const trailingMessages = context.messages.slice(latestUsageIndex + 1);
  const trailing = estimateTranscriptTokens(trailingMessages);
  const addedToolNames = new Set(
    trailingMessages.flatMap((message) => {
      if (!message || typeof message !== "object") return [];
      const item = message as Record<string, unknown>;
      return item.role === "toolResult" && Array.isArray(item.addedToolNames)
        ? item.addedToolNames.filter((name): name is string => typeof name === "string")
        : [];
    }),
  );
  const addedTools = context.tools?.filter((tool) => {
    if (!tool || typeof tool !== "object") return false;
    return addedToolNames.has(String((tool as Record<string, unknown>).name ?? ""));
  });
  const unreportedTokens = trailing + estimateToolsTokens(addedTools);
  return {
    tokens: latestUsageTokens + unreportedTokens,
    reportedPrefixTokens: latestUsageTokens,
    unreportedTokens,
    structuralTokens,
    anchoredPrefixStructuralTokens:
      estimateTextTokens(context.systemPrompt ?? "") +
      estimateTranscriptTokens(context.messages.slice(0, latestUsageIndex + 1)) +
      estimateToolsTokens(context.tools),
    anchorIndex: latestUsageIndex,
  };
}

/** Estimate only token counts; never retain request content in diagnostics. */
export function estimateModelRequestTokens(context: RequestContextLike): number {
  return describeModelRequestTokens(context).tokens;
}

export interface ModelTurnAdmission {
  estimatedInputTokens: number;
  reservedTokens: number;
  /**
   * Occupancy preflight charges against the input window to admit or abort
   * the turn: the calibrated request estimate plus configured framing reserve.
   * Serialized request bytes are not tokens.
   */
  admissionTokens: number;
}

/**
 * Reservation used to admit or abort a turn. Unsent host fields (tool-result
 * `details`, prompt guidelines, execute callbacks) do not inflate it; the hard
 * context window and configured framing reserve still bind.
 */
export function describeModelTurnAdmission(
  context: RequestContextLike,
  reservedTokens: number,
): ModelTurnAdmission {
  if (!Number.isSafeInteger(reservedTokens) || reservedTokens < 0) {
    throw new Error("reservedTokens must be a non-negative safe integer value.");
  }
  const estimatedInputTokens = estimateModelRequestTokens(context);
  return {
    estimatedInputTokens,
    reservedTokens,
    admissionTokens: estimatedInputTokens + reservedTokens,
  };
}

/** A status named by a keyword, as DocsFab's own diagnostics write it. */
const KEYWORD_STATUS =
  /\b(?:HTTP(?:\s+status)?|status(?:\s+code)?|error\s+code)\s*[:=]?\s*(\d{3})\b/iu;

/**
 * A status leading the message, as the provider stack writes it. Pi turns a
 * non-2xx response into a status-first message with no keyword:
 *
 *   `503: {"message":"Service unavailable","type":"server_error"}`  (JSON body)
 *   `503 status code (no body)`                                     (empty body)
 *   `503 <html><body>503 Service Unavailable</body></html>`         (text body)
 *
 * It takes precedence over the keyword form because the provider-controlled
 * body travels in the same message, and a body mentioning `Error code: 400`
 * must not outrank the real leading status. DocsFab's own diagnostics never
 * begin with a three-digit code.
 */
const LEADING_STATUS = /^\s*([1-5]\d{2})(?::|\s)/u;

function messageStatus(message: string): number {
  return Number(
    LEADING_STATUS.exec(message)?.[1] ?? KEYWORD_STATUS.exec(message)?.[1] ?? Number.NaN,
  );
}

/**
 * Leading words of the turn governor's own refusal (`TurnGovernanceError`).
 * Pi flattens the thrown error into an assistant `errorMessage`, so this prefix
 * is how a later reader tells a request DocsFab declined to send from one the
 * provider answered.
 */
export const LOCAL_STOP_MESSAGE_PREFIX = "Provider turn stopped locally:";

/**
 * The governor's closed stop reason named in a local-stop message, if the
 * message is one. `TurnGovernanceError` writes `reason=<InferenceTurnReason>`
 * as its first field, so the value is the ledger's own word for the stop.
 */
export function localStopReason(message: string): string | undefined {
  if (!message.startsWith(LOCAL_STOP_MESSAGE_PREFIX)) return undefined;
  return /\breason=([a-z-]+)/u.exec(message)?.[1];
}

export type ModelFailureCategory = InferenceFailureCategory;

export interface ModelFailureDisposition {
  category: ModelFailureCategory;
  retryable: boolean;
}

export function classifyModelFailure(error: unknown): ModelFailureDisposition {
  if (error instanceof InferenceStepError) {
    return { category: error.category, retryable: error.retryable };
  }
  if (
    error instanceof ContextBudgetError ||
    (error &&
      typeof error === "object" &&
      (error as Record<string, unknown>).code === "context-exhausted")
  ) {
    return { category: "context-exhausted", retryable: false };
  }
  const record =
    error && typeof error === "object" ? (error as Record<string, unknown>) : undefined;
  const status = typeof record?.status === "number" ? record.status : messageStatus(String(error));
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith("Context budget exhausted before provider invocation:")) {
    return { category: "context-exhausted", retryable: false };
  }
  // Every governor refusal is the host's own budget stop, never retryable. The
  // named reason travels on the turn ledger, lease, and step message.
  if (message.startsWith(LOCAL_STOP_MESSAGE_PREFIX)) {
    return { category: "context-exhausted", retryable: false };
  }
  if (
    status === 400 &&
    (/ContextWindowExceededError/iu.test(message) ||
      (/Context Window Error/iu.test(message) && /prompt is too long/iu.test(message)))
  ) {
    return { category: "context-exhausted", retryable: false };
  }
  if (status === 408) {
    return { category: "timeout", retryable: true };
  }
  if (status === 429) return { category: "throttled", retryable: true };
  // 425 Too Early is the one other 4xx the client is invited to repeat verbatim.
  if (status === 425) return { category: "provider-transient", retryable: true };
  if (status >= 400 && status <= 499) {
    return { category: "invalid-request", retryable: false };
  }
  if (status >= 500 && status <= 599) {
    return { category: "provider-transient", retryable: true };
  }
  // These text rules do not decide a sent provider failure: both retry layers
  // read its typed provider-error class first (`sent-provider-failure.ts`). They
  // apply only to a failure that carries no sent provider error.
  if (/\btimeout|timed out\b/iu.test(message)) {
    return { category: "timeout", retryable: true };
  }
  // Policy refusals and documentation can mention network access without a failure.
  if (
    /\b(?:network\s*(?:error|failure)|connection\s+(?:error|failure|failed|refused|reset|closed)|ECONNRESET|ECONNREFUSED)\b/iu.test(
      message,
    )
  ) {
    return { category: "provider-transient", retryable: true };
  }
  if (
    /\bmalformed response|invalid response|response (?:parse|parser)|unexpected end of JSON\b/iu.test(
      message,
    )
  ) {
    return { category: "malformed-response", retryable: true };
  }
  return { category: "provider-terminal", retryable: false };
}
