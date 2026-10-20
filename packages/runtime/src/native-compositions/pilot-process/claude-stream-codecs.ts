// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";

import { canonicalDigest } from "../../contract-kit/index.js";
import {
  NATIVE_PILOT_MAX_PROVIDER_REQUESTS_PER_STEP,
  NATIVE_PILOT_MAXIMA,
  parseNativePilotStepOutputV1,
  type NativePilotFailureCode,
} from "../pilot-contracts.js";
import {
  NativePilotProcessError,
  failProcess,
  type NativePilotProcessRequest,
} from "../pilot-process-contracts.js";
import {
  boundedStreamString,
  emptyList,
  exactStringList,
  safeStreamAdditiveJson,
  streamExact,
  streamInteger,
  streamNonnegativeNumber,
  streamObject,
  streamRequired,
} from "./stream-values.js";

const CLAUDE_INTRINSIC_TOOLS = Object.freeze(["StructuredOutput"] as const);

const CLAUDE_INERT_AGENTS = Object.freeze([
  "claude",
  "Explore",
  "general-purpose",
  "Plan",
] as const);

const CLAUDE_CAPABILITIES = Object.freeze([
  "interrupt_receipt_v1",
  "interrupt_cancel_queued_v1",
  "msg_lifecycle_v1",
] as const);

const CLAUDE_STRUCTURED_OUTPUT_ACKNOWLEDGEMENT = "Structured output provided successfully";

export const CLAUDE_INTERNAL_MAX_RETRIES = 10;

interface ClaudeUsageProjection {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly reasoningOutput: 0;
  readonly total: number;
}

interface ClaudeCompositionProjection {
  readonly primary: ClaudeUsageProjection;
  readonly composition: ClaudeUsageProjection;
  readonly providerRequests: number;
  readonly costUSD: number;
}

function validateClaudeRawUsage(
  value: unknown,
  envelope: "assistant" | "result",
): ClaudeUsageProjection {
  const usage = streamObject(value, "malformed-stream");
  streamExact(
    usage,
    envelope === "assistant"
      ? [
          "cache_creation",
          "cache_creation_input_tokens",
          "cache_read_input_tokens",
          "inference_geo",
          "input_tokens",
          "output_tokens",
          "service_tier",
        ]
      : [
          "cache_creation",
          "cache_creation_input_tokens",
          "cache_read_input_tokens",
          "inference_geo",
          "input_tokens",
          "iterations",
          "output_tokens",
          "server_tool_use",
          "service_tier",
          "speed",
        ],
    "malformed-stream",
  );
  const input = streamInteger(usage.input_tokens, "malformed-stream");
  const output = streamInteger(usage.output_tokens, "malformed-stream");
  const cacheCreationInputTokens = streamInteger(
    usage.cache_creation_input_tokens,
    "malformed-stream",
  );
  const cacheReadInputTokens = streamInteger(usage.cache_read_input_tokens, "malformed-stream");
  if (usage.cache_creation === null) {
    if (cacheCreationInputTokens !== 0) failProcess("budget-mismatch");
  } else {
    const cacheCreation = streamObject(usage.cache_creation, "malformed-stream");
    streamExact(
      cacheCreation,
      ["ephemeral_1h_input_tokens", "ephemeral_5m_input_tokens"],
      "malformed-stream",
    );
    if (
      streamInteger(cacheCreation.ephemeral_1h_input_tokens, "malformed-stream") +
        streamInteger(cacheCreation.ephemeral_5m_input_tokens, "malformed-stream") !==
      cacheCreationInputTokens
    ) {
      failProcess("budget-mismatch");
    }
  }
  if (envelope === "result" && usage.server_tool_use === null) {
    failProcess("malformed-stream");
  }
  if (envelope === "result" && usage.server_tool_use !== null) {
    const serverToolUse = streamObject(usage.server_tool_use, "malformed-stream");
    streamExact(serverToolUse, ["web_fetch_requests", "web_search_requests"], "malformed-stream");
    if (
      streamInteger(serverToolUse.web_fetch_requests, "malformed-stream") !== 0 ||
      streamInteger(serverToolUse.web_search_requests, "malformed-stream") !== 0
    ) {
      failProcess("unexpected-tool-activity");
    }
  }
  if (envelope === "result") {
    if (!Array.isArray(usage.iterations) || usage.iterations.length !== 1) {
      failProcess("malformed-stream");
    }
    const iteration = streamObject(usage.iterations[0], "malformed-stream");
    streamExact(
      iteration,
      [
        "cache_creation",
        "cache_creation_input_tokens",
        "cache_read_input_tokens",
        "input_tokens",
        "output_tokens",
        "type",
      ],
      "malformed-stream",
    );
    if (
      iteration.type !== "message" ||
      streamInteger(iteration.input_tokens, "malformed-stream") !== input ||
      streamInteger(iteration.output_tokens, "malformed-stream") !== output ||
      streamInteger(iteration.cache_read_input_tokens, "malformed-stream") !==
        cacheReadInputTokens ||
      streamInteger(iteration.cache_creation_input_tokens, "malformed-stream") !==
        cacheCreationInputTokens ||
      !isDeepStrictEqual(iteration.cache_creation, usage.cache_creation)
    ) {
      failProcess("budget-mismatch");
    }
  }
  if (
    ![null, "standard", "priority", "batch"].includes(usage.service_tier as never) ||
    (envelope === "result" && ![null, "standard", "fast"].includes(usage.speed as never)) ||
    (usage.inference_geo !== null && typeof usage.inference_geo !== "string")
  ) {
    failProcess("malformed-stream");
  }
  return {
    input,
    output,
    cacheRead: cacheReadInputTokens,
    cacheWrite: cacheCreationInputTokens,
    reasoningOutput: 0,
    total: input + output + cacheReadInputTokens + cacheCreationInputTokens,
  };
}

// Opus may orchestrate a bounded ordered prefix of first-party Claude auxiliary
// models inside one governed session. The requested root model is always the last
// ledger key and remains the only entry that can emit and bind the strict output;
// every earlier entry is session-internal orchestration charged to the composition.
export function claudeRawModelKeyCount(value: unknown): number {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return 0;
  return Object.keys(value as Record<string, unknown>).length;
}

function validateClaudeModelUsage(
  value: unknown,
  requestedModel: string,
): ClaudeCompositionProjection {
  const root = streamObject(value, "malformed-stream");
  const modelIds = Object.keys(root);
  if (
    modelIds.length < 1 ||
    modelIds.length > NATIVE_PILOT_MAX_PROVIDER_REQUESTS_PER_STEP ||
    modelIds.at(-1) !== requestedModel ||
    modelIds.some((modelId) => !/^claude-[a-z0-9.-]{1,127}$/u.test(modelId))
  ) {
    failProcess("model-identity-mismatch");
  }
  const canonicalModels = new Set<string>();
  const composition = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let primary: ClaudeUsageProjection | null = null;
  let costUSD = 0;
  for (const [index, modelId] of modelIds.entries()) {
    const usage = streamObject(root[modelId], "malformed-stream");
    streamRequired(
      usage,
      [
        "cacheCreationInputTokens",
        "cacheReadInputTokens",
        "contextWindow",
        "costUSD",
        "inputTokens",
        "maxOutputTokens",
        "outputTokens",
        "webSearchRequests",
      ],
      ["canonicalModel", "provider"],
      "malformed-stream",
    );
    const input = streamInteger(usage.inputTokens, "malformed-stream");
    const output = streamInteger(usage.outputTokens, "malformed-stream");
    const cacheRead = streamInteger(usage.cacheReadInputTokens, "malformed-stream");
    const cacheWrite = streamInteger(usage.cacheCreationInputTokens, "malformed-stream");
    const isPrimary = index === modelIds.length - 1;
    const canonicalModel =
      usage.canonicalModel === undefined ? null : (usage.canonicalModel as unknown);
    if (
      streamInteger(usage.webSearchRequests, "malformed-stream") !== 0 ||
      input + cacheRead + cacheWrite > NATIVE_PILOT_MAXIMA.maxInputTokens ||
      output > NATIVE_PILOT_MAXIMA.maxOutputTokens ||
      !streamNonnegativeNumber(usage.costUSD) ||
      (usage.provider !== undefined && usage.provider !== "firstParty") ||
      (canonicalModel !== null && !boundedStreamString(canonicalModel, 256))
    ) {
      failProcess("budget-mismatch");
    }
    if (
      (!isPrimary && canonicalModel === requestedModel) ||
      (typeof canonicalModel === "string" && canonicalModels.has(canonicalModel))
    ) {
      failProcess("model-identity-mismatch");
    }
    if (typeof canonicalModel === "string") canonicalModels.add(canonicalModel);
    streamInteger(usage.contextWindow, "malformed-stream");
    streamInteger(usage.maxOutputTokens, "malformed-stream");
    costUSD += usage.costUSD as number;
    composition.input += input;
    composition.output += output;
    composition.cacheRead += cacheRead;
    composition.cacheWrite += cacheWrite;
    if (isPrimary) {
      primary = {
        input,
        output,
        cacheRead,
        cacheWrite,
        reasoningOutput: 0,
        total: input + output + cacheRead + cacheWrite,
      };
    }
  }
  if (primary === null) failProcess("model-identity-mismatch");
  return {
    primary,
    composition: {
      ...composition,
      reasoningOutput: 0,
      total:
        composition.input + composition.output + composition.cacheRead + composition.cacheWrite,
    },
    providerRequests: modelIds.length,
    costUSD,
  };
}

export function parseClaudeStreamLine(bytes: Buffer): Record<string, unknown> {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    failProcess("malformed-stream");
  }
  if (text.endsWith("\r")) text = text.slice(0, -1);
  if (!text || text.includes("\0") || text !== text.normalize("NFC")) {
    failProcess("malformed-stream");
  }
  try {
    return streamObject(JSON.parse(text), "malformed-stream");
  } catch (error) {
    if (error instanceof NativePilotProcessError) throw error;
    failProcess("malformed-stream");
  }
}

export function validateClaudeInit(
  event: Record<string, unknown>,
  request: NativePilotProcessRequest,
): string {
  if (request.streamPolicy.kind !== "claude-2.1.226-guard-v1") {
    failProcess("claude-stream-guard-required");
  }
  const policy = request.streamPolicy;
  streamRequired(
    event,
    [
      "agents",
      "analytics_disabled",
      "apiKeySource",
      "capabilities",
      "claude_code_version",
      "cwd",
      "messaging_socket_path",
      "mcp_servers",
      "model",
      "output_style",
      "permissionMode",
      "plugins",
      "product_feedback_disabled",
      "session_id",
      "skills",
      "slash_commands",
      "subtype",
      "tools",
      "type",
      "uuid",
    ],
    [
      "betas",
      "effort",
      "fast_mode_disabled_reason",
      "fast_mode_state",
      "plugin_errors",
      "terminal_slash_commands",
    ],
    "malformed-stream",
  );
  if (
    event.type !== "system" ||
    event.subtype !== "init" ||
    event.apiKeySource !== "none" ||
    event.claude_code_version !== "2.1.226" ||
    event.model !== policy.requestedModel ||
    event.cwd !== policy.workingDirectory ||
    event.permissionMode !== "dontAsk" ||
    event.analytics_disabled !== false ||
    event.product_feedback_disabled !== false ||
    !exactStringList(event.tools, CLAUDE_INTRINSIC_TOOLS) ||
    !exactStringList(event.agents, CLAUDE_INERT_AGENTS) ||
    !exactStringList(event.capabilities, CLAUDE_CAPABILITIES) ||
    !emptyList(event.mcp_servers) ||
    !emptyList(event.plugins) ||
    !emptyList(event.skills) ||
    !emptyList(event.slash_commands) ||
    (event.betas !== undefined &&
      (!Array.isArray(event.betas) ||
        event.betas.length > 1_024 ||
        event.betas.some((entry) => !boundedStreamString(entry, 1_024)))) ||
    (event.effort !== undefined &&
      event.effort !== null &&
      !["low", "medium", "high", "xhigh", "max"].includes(String(event.effort))) ||
    (event.fast_mode_state !== undefined &&
      !["on", "off", "cooldown"].includes(String(event.fast_mode_state))) ||
    (event.fast_mode_disabled_reason !== undefined &&
      event.fast_mode_disabled_reason !== null &&
      !boundedStreamString(event.fast_mode_disabled_reason, 128)) ||
    (event.plugin_errors !== undefined && !emptyList(event.plugin_errors)) ||
    (event.terminal_slash_commands !== undefined && !emptyList(event.terminal_slash_commands)) ||
    !boundedStreamString(event.uuid, 128) ||
    !boundedStreamString(event.session_id, 128) ||
    !boundedStreamString(event.output_style, 128) ||
    !boundedStreamString(event.messaging_socket_path, 4_096)
  ) {
    failProcess(
      event.cwd !== policy.workingDirectory
        ? "working-directory-mismatch"
        : "unexpected-tool-activity",
    );
  }
  return event.session_id;
}

export function validateClaudeRateLimit(event: Record<string, unknown>, sessionId: string): void {
  streamExact(event, ["rate_limit_info", "session_id", "type", "uuid"], "malformed-stream");
  const info = streamObject(event.rate_limit_info, "rate-limit-event-mismatch");
  streamExact(
    info,
    [
      "isUsingOverage",
      "overageInUse",
      "overageResetsAt",
      "overageStatus",
      "rateLimitType",
      "resetsAt",
      "status",
    ],
    "rate-limit-event-mismatch",
  );
  if (
    event.type !== "rate_limit_event" ||
    event.session_id !== sessionId ||
    !boundedStreamString(event.uuid, 128) ||
    info.status !== "allowed" ||
    info.rateLimitType !== "overage" ||
    info.overageStatus !== "allowed" ||
    typeof info.isUsingOverage !== "boolean" ||
    typeof info.overageInUse !== "boolean" ||
    typeof info.resetsAt !== "number" ||
    !Number.isFinite(info.resetsAt) ||
    info.resetsAt < 0 ||
    typeof info.overageResetsAt !== "number" ||
    !Number.isFinite(info.overageResetsAt) ||
    info.overageResetsAt < 0
  ) {
    failProcess("rate-limit-event-mismatch");
  }
}

export function retrySignature(event: Record<string, unknown>): boolean {
  return event.type === "system" && event.subtype === "api_retry";
}

export function validateClaudeRetry(
  event: Record<string, unknown>,
  sessionId: string,
): { attempt: number; delayMs: number } {
  streamExact(
    event,
    [
      "attempt",
      "error",
      "error_status",
      "max_retries",
      "retry_delay_ms",
      "session_id",
      "subtype",
      "type",
      "uuid",
    ],
    "retry-event-mismatch",
  );
  if (
    event.session_id !== sessionId ||
    !Number.isSafeInteger(event.attempt) ||
    (event.attempt as number) < 1 ||
    (event.attempt as number) > CLAUDE_INTERNAL_MAX_RETRIES ||
    event.max_retries !== CLAUDE_INTERNAL_MAX_RETRIES ||
    !Number.isSafeInteger(event.retry_delay_ms) ||
    (event.retry_delay_ms as number) < 1 ||
    ![429, 529].includes(event.error_status as number) ||
    !boundedStreamString(event.error, 1_024) ||
    !boundedStreamString(event.uuid, 128)
  ) {
    failProcess("retry-event-mismatch");
  }
  return { attempt: event.attempt as number, delayMs: event.retry_delay_ms as number };
}

export function validateClaudeAssistant(
  event: Record<string, unknown>,
  sessionId: string,
  request: NativePilotProcessRequest,
): { readonly input: unknown; readonly outputSha256: string; readonly toolUseId: string } {
  if (request.streamPolicy.kind !== "claude-2.1.226-guard-v1") {
    failProcess("claude-stream-guard-required");
  }
  streamRequired(
    event,
    ["message", "parent_tool_use_id", "session_id", "type", "uuid"],
    ["aborted", "context_usage", "error", "request_id", "timestamp"],
    "malformed-stream",
  );
  const message = streamObject(event.message, "malformed-stream");
  streamRequired(
    message,
    ["content", "id", "model", "role", "stop_reason", "type", "usage"],
    ["container", "context_management", "diagnostics", "stop_details", "stop_sequence"],
    "malformed-stream",
  );
  if (
    event.type !== "assistant" ||
    event.session_id !== sessionId ||
    event.parent_tool_use_id !== null ||
    event.error !== undefined ||
    event.aborted !== undefined ||
    !boundedStreamString(event.uuid, 128) ||
    message.type !== "message" ||
    message.role !== "assistant" ||
    message.model !== request.streamPolicy.requestedModel ||
    !boundedStreamString(message.id, 128) ||
    !Array.isArray(message.content) ||
    message.content.length !== 1 ||
    message.stop_reason !== null ||
    (message.stop_sequence !== undefined && message.stop_sequence !== null) ||
    (message.diagnostics !== undefined && message.diagnostics !== null) ||
    (message.stop_details !== undefined && message.stop_details !== null)
  ) {
    failProcess("unexpected-tool-activity");
  }
  const intrinsicBlock = streamObject(message.content[0], "unexpected-tool-activity");
  streamExact(
    intrinsicBlock,
    ["caller", "id", "input", "name", "type"],
    "unexpected-tool-activity",
  );
  const caller = streamObject(intrinsicBlock.caller, "unexpected-tool-activity");
  streamExact(caller, ["type"], "unexpected-tool-activity");
  if (
    intrinsicBlock.type !== "tool_use" ||
    intrinsicBlock.name !== "StructuredOutput" ||
    caller.type !== "direct" ||
    !boundedStreamString(intrinsicBlock.id, 128)
  ) {
    failProcess("unexpected-tool-activity");
  }
  try {
    parseNativePilotStepOutputV1(intrinsicBlock.input, request.streamPolicy.stepId);
  } catch {
    failProcess("malformed-output");
  }
  if (
    (event.request_id !== undefined && !boundedStreamString(event.request_id, 128)) ||
    (event.timestamp !== undefined &&
      (typeof event.timestamp !== "string" ||
        event.timestamp.length > 64 ||
        Number.isNaN(Date.parse(event.timestamp)))) ||
    (event.context_usage !== undefined && !safeStreamAdditiveJson(event.context_usage, 0)) ||
    (message.container !== undefined && !safeStreamAdditiveJson(message.container, 0)) ||
    (message.context_management !== undefined &&
      !safeStreamAdditiveJson(message.context_management, 0))
  ) {
    failProcess("malformed-stream");
  }
  validateClaudeRawUsage(message.usage, "assistant");
  return {
    input: intrinsicBlock.input,
    outputSha256: canonicalDigest(intrinsicBlock.input),
    toolUseId: intrinsicBlock.id as string,
  };
}

export function validateClaudeStructuredOutputAcknowledgement(
  event: Record<string, unknown>,
  sessionId: string,
  toolUseId: string,
): void {
  streamExact(
    event,
    ["message", "parent_tool_use_id", "session_id", "timestamp", "tool_use_result", "type", "uuid"],
    "unexpected-tool-activity",
  );
  if (
    event.type !== "user" ||
    event.session_id !== sessionId ||
    event.parent_tool_use_id !== null
  ) {
    failProcess("session-mismatch");
  }
  const timestampMs =
    typeof event.timestamp === "string" ? Date.parse(event.timestamp) : Number.NaN;
  if (
    !boundedStreamString(event.uuid, 128) ||
    typeof event.timestamp !== "string" ||
    event.timestamp.length > 64 ||
    Number.isNaN(timestampMs) ||
    new Date(timestampMs).toISOString() !== event.timestamp
  ) {
    failProcess("malformed-stream");
  }
  if (event.tool_use_result !== CLAUDE_STRUCTURED_OUTPUT_ACKNOWLEDGEMENT) {
    failProcess("unexpected-tool-activity");
  }
  const message = streamObject(event.message, "malformed-stream");
  streamExact(message, ["content", "role"], "unexpected-tool-activity");
  if (message.role !== "user" || !Array.isArray(message.content) || message.content.length !== 1) {
    failProcess("unexpected-tool-activity");
  }
  const block = streamObject(message.content[0], "unexpected-tool-activity");
  streamExact(block, ["content", "tool_use_id", "type"], "unexpected-tool-activity");
  if (
    block.type !== "tool_result" ||
    block.tool_use_id !== toolUseId ||
    block.content !== CLAUDE_STRUCTURED_OUTPUT_ACKNOWLEDGEMENT
  ) {
    failProcess(block.tool_use_id !== toolUseId ? "digest-mismatch" : "unexpected-tool-activity");
  }
}

export function validateClaudeResult(
  event: Record<string, unknown>,
  sessionId: string,
  request: NativePilotProcessRequest,
  assistantInput: unknown,
  assistantOutputSha256: string,
): void {
  streamRequired(
    event,
    [
      "duration_api_ms",
      "duration_ms",
      "is_error",
      "modelUsage",
      "num_turns",
      "permission_denials",
      "result",
      "session_id",
      "stop_reason",
      "structured_output",
      "subtype",
      "total_cost_usd",
      "type",
      "usage",
      "uuid",
    ],
    [
      "api_error_status",
      "deferred_tool_use",
      "fast_mode_disabled_reason",
      "fast_mode_state",
      "origin",
      "request_sent_wall_ms",
      "terminal_reason",
      // Reported by the Claude Code 2.1.226 terminal result beside
      // request_sent_wall_ms; bounded as a nonnegative latency counter below.
      "time_to_request_ms",
      "ttft_ms",
      "ttft_stream_ms",
      "user_message_uuid",
    ],
    "malformed-stream",
  );
  if (
    event.type !== "result" ||
    event.subtype !== "success" ||
    event.is_error !== false ||
    event.session_id !== sessionId ||
    event.num_turns !== 2 ||
    !emptyList(event.permission_denials) ||
    event.deferred_tool_use !== undefined ||
    (event.terminal_reason !== undefined && event.terminal_reason !== "completed") ||
    !boundedStreamString(event.uuid, 128) ||
    !streamNonnegativeNumber(event.duration_ms) ||
    !streamNonnegativeNumber(event.duration_api_ms) ||
    !streamNonnegativeNumber(event.total_cost_usd) ||
    typeof event.result !== "string" ||
    event.result.length > 65_536 ||
    (event.stop_reason !== null && typeof event.stop_reason !== "string")
  ) {
    failProcess("session-mismatch");
  }
  if (request.streamPolicy.kind !== "claude-2.1.226-guard-v1") {
    failProcess("claude-stream-guard-required");
  }
  if (
    (event.api_error_status !== undefined &&
      event.api_error_status !== null &&
      (!Number.isSafeInteger(event.api_error_status) ||
        (event.api_error_status as number) < 100 ||
        (event.api_error_status as number) > 599)) ||
    (event.fast_mode_state !== undefined &&
      !["on", "off", "cooldown"].includes(String(event.fast_mode_state))) ||
    (event.fast_mode_disabled_reason !== undefined &&
      event.fast_mode_disabled_reason !== null &&
      (typeof event.fast_mode_disabled_reason !== "string" ||
        event.fast_mode_disabled_reason.length > 128)) ||
    (event.origin !== undefined && !safeStreamAdditiveJson(event.origin, 0)) ||
    (event.request_sent_wall_ms !== undefined &&
      !streamNonnegativeNumber(event.request_sent_wall_ms)) ||
    (event.time_to_request_ms !== undefined &&
      !streamNonnegativeNumber(event.time_to_request_ms)) ||
    (event.ttft_ms !== undefined && !streamNonnegativeNumber(event.ttft_ms)) ||
    (event.ttft_stream_ms !== undefined && !streamNonnegativeNumber(event.ttft_stream_ms)) ||
    (event.user_message_uuid !== undefined &&
      (typeof event.user_message_uuid !== "string" || event.user_message_uuid.length > 128))
  ) {
    failProcess("malformed-stream");
  }
  const resultUsage = validateClaudeRawUsage(event.usage, "result");
  const modelUsage = validateClaudeModelUsage(
    event.modelUsage,
    request.streamPolicy.requestedModel,
  );
  // Result-level usage reports the governed root turn, so it binds to the primary
  // ledger entry; auxiliary entries are additive composition accounting only.
  if (!isDeepStrictEqual(resultUsage, modelUsage.primary)) failProcess("budget-mismatch");
  if (
    canonicalDigest(assistantInput) !== canonicalDigest(event.structured_output) ||
    !isDeepStrictEqual(assistantInput, event.structured_output)
  ) {
    failProcess("digest-mismatch");
  }
  try {
    const resultOutput = parseNativePilotStepOutputV1(
      event.structured_output,
      request.streamPolicy.stepId,
    );
    if (canonicalDigest(resultOutput) !== assistantOutputSha256) {
      failProcess("digest-mismatch");
    }
  } catch (error) {
    if (error instanceof NativePilotProcessError) throw error;
    failProcess("malformed-output");
  }
}

export function rawRetryAttempt(event: Record<string, unknown>): number {
  return Number.isSafeInteger(event.attempt) && (event.attempt as number) > 0
    ? (event.attempt as number)
    : 1;
}

export function rawRetryDelay(event: Record<string, unknown>): number {
  return Number.isSafeInteger(event.retry_delay_ms) && (event.retry_delay_ms as number) > 0
    ? (event.retry_delay_ms as number)
    : 1;
}
