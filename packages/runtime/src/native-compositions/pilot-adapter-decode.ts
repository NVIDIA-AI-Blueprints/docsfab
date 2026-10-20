// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";

import { canonicalDigest } from "../contract-kit/index.js";
import { parseJsonEvidence, type JsonEvidenceValue } from "../json-evidence.js";
import {
  assertModelResponseCredentialFree,
  CredentialBoundaryError,
} from "../security/credential-isolation.js";
import {
  NATIVE_PILOT_ADAPTER_VERSION,
  NATIVE_PILOT_EVIDENCE_CLASS,
  NATIVE_PILOT_MAX_PROVIDER_REQUESTS_PER_STEP,
  NATIVE_PILOT_MAXIMA,
  parseNativePilotStepOutputV1,
  parseNativePilotStepPlanV1,
  sealNativePilotStepReceiptV1,
  type NativePilotFailureCode,
  type NativePilotHarnessId,
  type NativePilotModelLedgerEntryV1,
  type NativePilotStepOutputV1,
  type NativePilotStepPlanV1,
  type NativePilotStepReceiptV1,
  type NativePilotUsageV1,
} from "./pilot-contracts.js";
import {
  consumeNativePilotProcessObservationAuthority,
  nativePilotProcessRequestSha256,
  NativePilotProcessError,
  type NativePilotProcessObservation,
  type NativePilotProcessRequest,
} from "./pilot-process.js";
import {
  CLAUDE_NATIVE_PILOT_CAPABILITIES,
  CLAUDE_NATIVE_PILOT_INERT_AGENTS,
  CLAUDE_NATIVE_PILOT_INTRINSIC_TOOLS,
  CLAUDE_NATIVE_PILOT_STRUCTURED_OUTPUT_ACKNOWLEDGEMENT,
  CODEX_NATIVE_PILOT_DISABLED_FEATURES,
  CODEX_NATIVE_PILOT_VERSION,
  CODEX_NATIVE_PILOT_FEATURE_CAPTURE_SHA256,
  CODEX_NATIVE_PILOT_INERT_DIAGNOSTIC,
  failAdapter,
  sha256Bytes,
  sha256Text,
  strictUtf8,
} from "./pilot-adapter-constants.js";

function fail(code: NativePilotFailureCode): never {
  failAdapter(code);
}

export interface NativePilotFeatureStateEvidenceV1 {
  readonly rawCaptureSha256: typeof CODEX_NATIVE_PILOT_FEATURE_CAPTURE_SHA256;
  readonly rowCount: 104;
  readonly policySha256: string;
}

export interface NativePilotInvocationInput {
  readonly plan: unknown;
  readonly stdin: Buffer;
  readonly outputSchemaJson: string;
  readonly codexFeatureStateCapture?: Buffer;
}

export interface NativePilotInvocation {
  readonly harnessId: NativePilotHarnessId;
  readonly process: NativePilotProcessRequest;
  readonly argumentPolicySha256: string;
  readonly environmentPolicySha256: string;
  readonly toolPolicySha256: string;
  readonly featureStatePolicySha256: string | null;
}

export interface NativePilotDecodedResult {
  readonly output: NativePilotStepOutputV1;
  readonly receipt: NativePilotStepReceiptV1;
}

interface DecodedStream {
  readonly output: NativePilotStepOutputV1;
  readonly observedModel: string | null;
  readonly observedCanonicalModel: string | null;
  readonly sessionSha256: string;
  readonly usage: NativePilotUsageV1;
  readonly modelLedger: readonly NativePilotModelLedgerEntryV1[];
  readonly costUSD: number | null;
  readonly compositionAccounting: "complete" | "partial" | "unavailable";
  readonly providerRequests: number;
  readonly toolEventCount: 0;
}

interface InvocationBinding {
  readonly harnessId: NativePilotHarnessId;
  readonly planSha256: string;
  readonly argumentPolicySha256: string;
  readonly environmentPolicySha256: string;
  readonly toolPolicySha256: string;
  readonly featureStatePolicySha256: string | null;
  readonly processRequestSha256: string;
}

const INVOCATION_BINDINGS = new WeakMap<object, InvocationBinding>();
const CONSUMED_INVOCATION_PLANS = new WeakSet<object>();

export function decodeCodexNativePilotFeatureState(
  capture: Buffer,
): NativePilotFeatureStateEvidenceV1 {
  if (
    !Buffer.isBuffer(capture) ||
    capture.byteLength < 1 ||
    capture.byteLength > NATIVE_PILOT_MAXIMA.maxStderrBytes ||
    sha256Bytes(capture) !== CODEX_NATIVE_PILOT_FEATURE_CAPTURE_SHA256
  ) {
    fail("feature-state-mismatch");
  }
  const source = strictUtf8(capture, "feature-state-mismatch");
  const rows = source
    .trimEnd()
    .split("\n")
    .map((line) => {
      const match = line.match(
        /^(\S+)\s+(removed|stable|experimental|deprecated|under development)\s+(true|false)$/u,
      );
      if (!match) fail("feature-state-mismatch");
      return { name: match[1]!, stage: match[2]!, enabled: match[3] === "true" };
    });
  if (
    rows.length !== 104 ||
    new Set(rows.map((row) => row.name)).size !== rows.length ||
    rows.some((row, index) => index > 0 && rows[index - 1]!.name.localeCompare(row.name) >= 0)
  ) {
    fail("feature-state-mismatch");
  }
  for (const feature of CODEX_NATIVE_PILOT_DISABLED_FEATURES) {
    const row = rows.find((candidate) => candidate.name === feature);
    if (!row || row.enabled) fail("feature-state-mismatch");
  }
  return Object.freeze({
    rawCaptureSha256: CODEX_NATIVE_PILOT_FEATURE_CAPTURE_SHA256,
    rowCount: 104,
    policySha256: expectedFeatureStatePolicySha256(),
  });
}

export function decodeCodexNativePilotResult(
  planValue: unknown,
  observation: NativePilotProcessObservation,
): NativePilotDecodedResult {
  const plan = parseNativePilotStepPlanV1(planValue);
  if (plan.harnessId !== "codex") fail("invocation-policy");
  const binding = consumeInvocation(planValue, "codex", plan.planSha256);
  consumeObservation(observation, binding.processRequestSha256, binding.planSha256);
  const captures = validateObservation(plan, observation);
  const decoded = parseCodexStream(captures.stdout, plan);
  return decodedResult(plan, observation, decoded, binding);
}

export function decodeClaudeNativePilotResult(
  planValue: unknown,
  observation: NativePilotProcessObservation,
): NativePilotDecodedResult {
  const plan = parseNativePilotStepPlanV1(planValue);
  if (plan.harnessId !== "claude-code") fail("invocation-policy");
  const binding = consumeInvocation(planValue, "claude-code", plan.planSha256);
  consumeObservation(observation, binding.processRequestSha256, binding.planSha256);
  const captures = validateObservation(plan, observation);
  const decoded = parseClaudeStream(captures.stdout, plan);
  return decodedResult(plan, observation, decoded, binding);
}

export function decodeNativePilotResult(
  planValue: unknown,
  observation: NativePilotProcessObservation,
): NativePilotDecodedResult {
  const plan = parseNativePilotStepPlanV1(planValue);
  return plan.harnessId === "codex"
    ? decodeCodexNativePilotResult(planValue, observation)
    : decodeClaudeNativePilotResult(planValue, observation);
}

function validateObservation(
  plan: NativePilotStepPlanV1,
  observation: NativePilotProcessObservation,
): { stdout: Buffer; stderr: Buffer } {
  const streamPolicyValid =
    plan.harnessId === "claude-code"
      ? observation.streamDisposition === "success" &&
        observation.streamFailureCode === null &&
        observation.providerRequests >= 1 &&
        observation.providerRequests <= NATIVE_PILOT_MAX_PROVIDER_REQUESTS_PER_STEP &&
        observation.providerRequestLowerBound === observation.providerRequests &&
        observation.retryAttempt === null &&
        observation.retryMaximum === null &&
        observation.killIssued === false &&
        observation.killIssuedBeforeRetryDeadline === false &&
        observation.stopSettlementRequired === false &&
        observation.fallbackAttempted === false
      : observation.streamDisposition === "terminal-capture" &&
        observation.streamFailureCode === null &&
        observation.providerRequests === 1 &&
        observation.providerRequestLowerBound === 1 &&
        observation.retryAttempt === null &&
        observation.retryMaximum === null &&
        observation.killIssued === false &&
        observation.stopSettlementRequired === false &&
        observation.fallbackAttempted === false;
  if (
    observation.status !== "settled" ||
    observation.exitCode !== 0 ||
    !observation.stdinDelivered ||
    observation.stdinBytes < 1 ||
    observation.stdoutOverflow ||
    observation.stderrOverflow ||
    !observation.stdoutEof ||
    !observation.stderrEof ||
    !observation.processGroupSettled ||
    observation.lateBytesObserved ||
    observation.descendantContainment !== "unsupported" ||
    !streamPolicyValid
  ) {
    fail(processFailureCode(observation));
  }
  if (
    observation.stdoutBytes > plan.limits.maxStdoutBytes ||
    observation.stderrBytes > plan.limits.maxStderrBytes ||
    observation.stdout.byteLength !== observation.stdoutBytes ||
    observation.stderr.byteLength !== observation.stderrBytes
  ) {
    fail("output-limit");
  }
  try {
    assertModelResponseCredentialFree({
      stdout: strictUtf8(observation.stdout, "malformed-stream"),
      stderr: strictUtf8(observation.stderr, "malformed-stream"),
    });
  } catch (error) {
    if (error instanceof CredentialBoundaryError) fail("credential-material");
    throw error;
  }
  return { stdout: observation.stdout, stderr: observation.stderr };
}

function processFailureCode(observation: NativePilotProcessObservation): NativePilotFailureCode {
  if (observation.streamFailureCode !== null) return observation.streamFailureCode;
  if (observation.status === "timeout") return "timeout";
  if (observation.status === "cancelled") return "cancelled";
  if (observation.status === "spawn-failed") return "spawn-failed";
  if (observation.status === "output-limit") return "output-limit";
  if (observation.status === "process-failed") return "process-failed";
  if (
    observation.status === "settled" &&
    (observation.exitCode !== 0 || !observation.stdinDelivered)
  ) {
    return "process-failed";
  }
  return "process-not-settled";
}

function parseCodexStream(stdout: Buffer, plan: NativePilotStepPlanV1): DecodedStream {
  const events = jsonLines(stdout);
  let threadId: string | null = null;
  let inertDiagnosticSeen = false;
  let turnStarted = false;
  let turnCompleted = false;
  let outputValue: unknown;
  let usage: NativePilotUsageV1 | undefined;
  const startedItems = new Map<string, "reasoning" | "agent_message">();
  const completedItems = new Set<string>();
  for (let index = 0; index < events.length; index += 1) {
    const event = strictObject(events[index], "malformed-stream");
    switch (event.type) {
      case "thread.started":
        exactKeys(event, ["thread_id", "type"], "malformed-stream");
        if (index !== 0 || threadId !== null) fail("malformed-stream");
        threadId = safeText(event.thread_id, 128, "malformed-stream");
        break;
      case "turn.started":
        exactKeys(event, ["type"], "malformed-stream");
        if (threadId === null || turnStarted || turnCompleted) fail("malformed-stream");
        turnStarted = true;
        break;
      case "item.started": {
        exactKeys(event, ["item", "type"], "malformed-stream");
        const item = strictObject(event.item, "malformed-stream");
        requiredSafeKeys(item, ["id", "type"], ["status", "text"], "malformed-stream");
        if (!turnStarted || turnCompleted) fail("malformed-stream");
        if (item.type !== "reasoning" && item.type !== "agent_message") {
          fail("unexpected-tool-activity");
        }
        const itemId = safeText(item.id, 128, "malformed-stream");
        if (
          startedItems.has(itemId) ||
          completedItems.has(itemId) ||
          (item.status !== undefined && item.status !== "in_progress") ||
          (item.text !== undefined && (typeof item.text !== "string" || item.text.length > 65_536))
        ) {
          fail("malformed-stream");
        }
        startedItems.set(itemId, item.type);
        break;
      }
      case "item.completed": {
        exactKeys(event, ["item", "type"], "malformed-stream");
        const item = strictObject(event.item, "malformed-stream");
        if (!turnStarted) {
          if (
            threadId === null ||
            turnCompleted ||
            inertDiagnosticSeen ||
            !isExactCodexInertDiagnostic(event, item)
          ) {
            fail("diagnostic-mismatch");
          }
          inertDiagnosticSeen = true;
          break;
        }
        if (turnCompleted) fail("malformed-stream");
        if (item.type === "error") fail("diagnostic-mismatch");
        if (item.type !== "reasoning" && item.type !== "agent_message") {
          fail("unexpected-tool-activity");
        }
        requiredSafeKeys(item, ["id", "text", "type"], ["status"], "malformed-stream");
        const itemId = safeText(item.id, 128, "malformed-stream");
        if (
          completedItems.has(itemId) ||
          (item.status !== undefined && item.status !== "completed")
        ) {
          fail("malformed-stream");
        }
        const startedType = startedItems.get(itemId);
        if (startedType !== undefined && startedType !== item.type) fail("malformed-stream");
        startedItems.delete(itemId);
        completedItems.add(itemId);
        if (item.type === "reasoning") {
          if (typeof item.text !== "string" || item.text.length > 65_536) {
            fail("malformed-stream");
          }
          break;
        }
        if (item.type !== "agent_message") fail("unexpected-tool-activity");
        if (outputValue !== undefined) fail("malformed-stream");
        try {
          outputValue = parseJsonEvidence(safeText(item.text, 65_536, "malformed-output"));
        } catch {
          fail("malformed-output");
        }
        break;
      }
      case "turn.completed":
        exactKeys(event, ["type", "usage"], "malformed-stream");
        if (!turnStarted || turnCompleted || index !== events.length - 1) {
          fail("malformed-stream");
        }
        usage = codexUsage(event.usage, plan);
        turnCompleted = true;
        break;
      default:
        fail("unexpected-tool-activity");
    }
  }
  if (
    threadId === null ||
    !turnStarted ||
    !turnCompleted ||
    outputValue === undefined ||
    !usage ||
    startedItems.size !== 0
  ) {
    fail("malformed-stream");
  }
  return {
    output: parseNativePilotStepOutputV1(outputValue, plan.stepId),
    observedModel: null,
    observedCanonicalModel: null,
    sessionSha256: canonicalDigest({ harnessId: "codex", threadId }),
    usage,
    modelLedger: [
      {
        ordinal: 1,
        role: "primary-output",
        modelId: plan.requestedModel,
        canonicalModel: null,
        provider: "firstParty",
        usage,
        costUSD: null,
        outputAuthority: "governed-session-structured-output",
      },
    ],
    costUSD: null,
    compositionAccounting: "unavailable",
    providerRequests: 1,
    toolEventCount: 0,
  };
}

function isExactCodexInertDiagnostic(
  event: Record<string, unknown>,
  item: Record<string, unknown>,
): boolean {
  return (
    Object.keys(event).length === 2 &&
    Object.keys(item).length === 3 &&
    item.id === CODEX_NATIVE_PILOT_INERT_DIAGNOSTIC.item.id &&
    item.type === CODEX_NATIVE_PILOT_INERT_DIAGNOSTIC.item.type &&
    item.message === CODEX_NATIVE_PILOT_INERT_DIAGNOSTIC.item.message
  );
}

function parseClaudeStream(stdout: Buffer, plan: NativePilotStepPlanV1): DecodedStream {
  const events = jsonLines(stdout);
  if (events.length < 4 || events.length > 5) fail("malformed-stream");
  const init = strictObject(events[0], "malformed-stream");
  requiredExactKeys(
    init,
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
    init.type !== "system" ||
    init.subtype !== "init" ||
    init.apiKeySource !== "none" ||
    init.claude_code_version !== "2.1.226" ||
    init.permissionMode !== "dontAsk" ||
    init.model !== plan.requestedModel ||
    init.cwd !== plan.workingDirectory ||
    init.analytics_disabled !== false ||
    init.product_feedback_disabled !== false ||
    !exactStringArray(init.tools, CLAUDE_NATIVE_PILOT_INTRINSIC_TOOLS) ||
    !exactStringArray(init.agents, CLAUDE_NATIVE_PILOT_INERT_AGENTS) ||
    !exactStringArray(init.capabilities, CLAUDE_NATIVE_PILOT_CAPABILITIES) ||
    !emptyArray(init.mcp_servers) ||
    !emptyArray(init.plugins) ||
    !emptyArray(init.skills) ||
    !emptyArray(init.slash_commands) ||
    (init.plugin_errors !== undefined && !emptyArray(init.plugin_errors)) ||
    (init.terminal_slash_commands !== undefined && !emptyArray(init.terminal_slash_commands))
  ) {
    fail(
      init.cwd !== plan.workingDirectory
        ? "working-directory-mismatch"
        : "unexpected-tool-activity",
    );
  }
  safeText(init.uuid, 128, "malformed-stream");
  safeText(init.output_style, 128, "malformed-stream");
  safeText(init.messaging_socket_path, 4_096, "malformed-stream");
  if (
    (init.betas !== undefined && !stringArray(init.betas)) ||
    (init.effort !== undefined &&
      init.effort !== null &&
      !["low", "medium", "high", "xhigh", "max"].includes(String(init.effort))) ||
    (init.fast_mode_state !== undefined &&
      !["on", "off", "cooldown"].includes(String(init.fast_mode_state))) ||
    (init.fast_mode_disabled_reason !== undefined &&
      init.fast_mode_disabled_reason !== null &&
      (typeof init.fast_mode_disabled_reason !== "string" ||
        init.fast_mode_disabled_reason.length > 128))
  ) {
    fail("malformed-stream");
  }
  const sessionId = safeText(init.session_id, 128, "malformed-stream");
  let cursor = 1;
  if ((events[cursor] as Record<string, unknown> | undefined)?.type === "rate_limit_event") {
    parseClaudeRateLimitEvent(events[cursor], sessionId);
    cursor += 1;
  }
  if (events.length !== cursor + 3) fail("malformed-stream");
  const assistant = strictObject(events[cursor], "malformed-stream");
  requiredSafeKeys(
    assistant,
    ["message", "parent_tool_use_id", "session_id", "type", "uuid"],
    ["aborted", "context_usage", "error", "request_id", "timestamp"],
    "malformed-stream",
  );
  if (
    assistant.type !== "assistant" ||
    assistant.session_id !== sessionId ||
    assistant.parent_tool_use_id !== null ||
    assistant.error !== undefined ||
    assistant.aborted !== undefined
  ) {
    fail("session-mismatch");
  }
  safeText(assistant.uuid, 128, "malformed-stream");
  if (assistant.request_id !== undefined) {
    safeText(assistant.request_id, 128, "malformed-stream");
  }
  if (
    (assistant.timestamp !== undefined &&
      (typeof assistant.timestamp !== "string" ||
        assistant.timestamp.length > 64 ||
        Number.isNaN(Date.parse(assistant.timestamp)))) ||
    (assistant.context_usage !== undefined && !safeAdditiveJson(assistant.context_usage, 0))
  ) {
    fail("malformed-stream");
  }
  const message = strictObject(assistant.message, "malformed-stream");
  requiredSafeKeys(
    message,
    ["content", "id", "model", "role", "stop_reason", "type", "usage"],
    ["container", "context_management", "diagnostics", "stop_details", "stop_sequence"],
    "malformed-stream",
  );
  if (
    message.type !== "message" ||
    message.role !== "assistant" ||
    message.model !== plan.requestedModel ||
    !Array.isArray(message.content) ||
    message.content.length !== 1 ||
    message.stop_reason !== null ||
    (message.stop_sequence !== undefined && message.stop_sequence !== null) ||
    (message.diagnostics !== undefined && message.diagnostics !== null) ||
    (message.stop_details !== undefined && message.stop_details !== null)
  ) {
    fail("unexpected-tool-activity");
  }
  safeText(message.id, 128, "malformed-stream");
  const intrinsicBlock = strictObject(message.content[0], "unexpected-tool-activity");
  exactKeys(intrinsicBlock, ["caller", "id", "input", "name", "type"], "unexpected-tool-activity");
  const caller = strictObject(intrinsicBlock.caller, "unexpected-tool-activity");
  exactKeys(caller, ["type"], "unexpected-tool-activity");
  if (
    intrinsicBlock.type !== "tool_use" ||
    intrinsicBlock.name !== "StructuredOutput" ||
    caller.type !== "direct"
  ) {
    fail("unexpected-tool-activity");
  }
  safeText(intrinsicBlock.id, 128, "malformed-stream");
  let assistantOutput: NativePilotStepOutputV1;
  try {
    assistantOutput = parseNativePilotStepOutputV1(intrinsicBlock.input, plan.stepId);
  } catch {
    fail("malformed-output");
  }
  if (
    (message.container !== undefined && !safeAdditiveJson(message.container, 0)) ||
    (message.context_management !== undefined && !safeAdditiveJson(message.context_management, 0))
  ) {
    fail("malformed-stream");
  }
  claudeRawUsage(message.usage, "assistant");
  parseClaudeStructuredOutputAcknowledgement(events[cursor + 1], sessionId, intrinsicBlock.id);
  const result = strictObject(events[cursor + 2], "malformed-stream");
  requiredSafeKeys(
    result,
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
    result.type !== "result" ||
    result.subtype !== "success" ||
    result.is_error !== false ||
    result.session_id !== sessionId ||
    result.num_turns !== 2 ||
    !emptyArray(result.permission_denials) ||
    result.deferred_tool_use !== undefined ||
    (result.terminal_reason !== undefined && result.terminal_reason !== "completed")
  ) {
    fail("session-mismatch");
  }
  safeText(result.uuid, 128, "malformed-stream");
  if (
    !nonnegativeNumber(result.duration_ms) ||
    !nonnegativeNumber(result.duration_api_ms) ||
    !nonnegativeNumber(result.total_cost_usd) ||
    typeof result.result !== "string" ||
    result.result.length > 65_536 ||
    (result.stop_reason !== null && typeof result.stop_reason !== "string")
  ) {
    fail("malformed-stream");
  }
  if (
    (result.api_error_status !== undefined &&
      result.api_error_status !== null &&
      (!Number.isSafeInteger(result.api_error_status) ||
        (result.api_error_status as number) < 100 ||
        (result.api_error_status as number) > 599)) ||
    (result.fast_mode_state !== undefined &&
      !["on", "off", "cooldown"].includes(String(result.fast_mode_state))) ||
    (result.fast_mode_disabled_reason !== undefined &&
      result.fast_mode_disabled_reason !== null &&
      (typeof result.fast_mode_disabled_reason !== "string" ||
        result.fast_mode_disabled_reason.length > 128)) ||
    (result.origin !== undefined && !safeAdditiveJson(result.origin, 0)) ||
    (result.request_sent_wall_ms !== undefined &&
      !nonnegativeNumber(result.request_sent_wall_ms)) ||
    (result.time_to_request_ms !== undefined && !nonnegativeNumber(result.time_to_request_ms)) ||
    (result.ttft_ms !== undefined && !nonnegativeNumber(result.ttft_ms)) ||
    (result.ttft_stream_ms !== undefined && !nonnegativeNumber(result.ttft_stream_ms)) ||
    (result.user_message_uuid !== undefined &&
      (typeof result.user_message_uuid !== "string" || result.user_message_uuid.length > 128))
  ) {
    fail("malformed-stream");
  }
  const resultRawUsage = claudeRawUsage(result.usage, "result");
  const modelUsage = claudeModelUsage(result.modelUsage, plan);
  // Result-level usage reports the governed root turn only.
  if (!isDeepStrictEqual(resultRawUsage, modelUsage.primaryUsage)) fail("budget-mismatch");
  const reportedCostUSD =
    typeof result.total_cost_usd === "number" &&
    Number.isFinite(result.total_cost_usd) &&
    result.total_cost_usd >= 0
      ? result.total_cost_usd
      : null;
  if (
    canonicalDigest(intrinsicBlock.input) !== canonicalDigest(result.structured_output) ||
    !isDeepStrictEqual(intrinsicBlock.input, result.structured_output)
  ) {
    fail("digest-mismatch");
  }
  let resultOutput: NativePilotStepOutputV1;
  try {
    resultOutput = parseNativePilotStepOutputV1(result.structured_output, plan.stepId);
  } catch {
    fail("malformed-output");
  }
  if (!isDeepStrictEqual(assistantOutput, resultOutput)) fail("digest-mismatch");
  return {
    output: assistantOutput,
    observedModel: plan.requestedModel,
    observedCanonicalModel: modelUsage.canonicalModel,
    sessionSha256: canonicalDigest({ harnessId: "claude-code", sessionId }),
    usage: modelUsage.usage,
    modelLedger: modelUsage.ledger,
    costUSD: modelUsage.costUSD,
    // Metering is complete only when the harness's own reported total agrees with
    // the summed ledger; otherwise the cost is retained but flagged partial.
    compositionAccounting:
      reportedCostUSD !== null && reportedCostUSD === modelUsage.costUSD ? "complete" : "partial",
    providerRequests: modelUsage.providerRequests,
    toolEventCount: 0,
  };
}

function decodedResult(
  plan: NativePilotStepPlanV1,
  observation: NativePilotProcessObservation,
  decoded: DecodedStream,
  binding: InvocationBinding,
): NativePilotDecodedResult {
  const outputBytes = Buffer.from(JSON.stringify(decoded.output), "utf8");
  if (outputBytes.byteLength > plan.limits.maxResponseBytes) fail("output-limit");
  // The host-observed request count is authoritative only when it agrees with the
  // strictly decoded model ledger; neither channel may understate the other.
  if (
    observation.providerRequests !== decoded.providerRequests ||
    decoded.modelLedger.length !== decoded.providerRequests
  ) {
    fail("budget-mismatch");
  }
  const receipt = sealNativePilotStepReceiptV1({
    adapterVersion: NATIVE_PILOT_ADAPTER_VERSION,
    evidenceClass: NATIVE_PILOT_EVIDENCE_CLASS,
    planSha256: plan.planSha256,
    harnessId: plan.harnessId,
    stepId: plan.stepId,
    outcome: decoded.output.outcome,
    requestedModel: plan.requestedModel,
    observedModel: decoded.observedModel,
    observedCanonicalModel: decoded.observedCanonicalModel,
    sessionSha256: decoded.sessionSha256,
    usage: decoded.usage,
    modelLedger: decoded.modelLedger,
    modelLedgerSha256: canonicalDigest(decoded.modelLedger),
    costUSD: decoded.costUSD,
    compositionAccounting: decoded.compositionAccounting,
    auxiliaryModelCalls: decoded.providerRequests - 1,
    executable: {
      sha256: plan.executableSha256,
      identitySha256: plan.executableIdentitySha256,
      reportedVersion: plan.reportedVersion,
    },
    workingDirectorySha256: plan.workingDirectorySha256,
    stdinSha256: plan.stdinSha256,
    serializedInputSha256: plan.serializedInputSha256,
    outputSchemaSha256: plan.outputSchemaSha256,
    outputSha256: sha256Bytes(outputBytes),
    outputPayloadSha256: canonicalDigest(decoded.output),
    summarySha256: sha256Text(decoded.output.summary),
    argumentPolicySha256: binding.argumentPolicySha256,
    environmentPolicySha256: binding.environmentPolicySha256,
    toolPolicySha256: binding.toolPolicySha256,
    featureStatePolicySha256: binding.featureStatePolicySha256,
    durationMs: observation.durationMs,
    stdinBytes: observation.stdinBytes,
    stdoutBytes: observation.stdoutBytes,
    stderrBytes: observation.stderrBytes,
    providerTurns: 1,
    providerRequests: decoded.providerRequests,
    toolEventCount: decoded.toolEventCount,
    descendantContainment: "unsupported",
    terminalCode: "completed",
  });
  return Object.freeze({ output: decoded.output, receipt });
}

export function registerInvocation(
  planValue: unknown,
  invocation: NativePilotInvocation,
  planSha256: string,
): void {
  if (!planValue || typeof planValue !== "object") fail("invocation-policy");
  const binding: InvocationBinding = Object.freeze({
    harnessId: invocation.harnessId,
    planSha256,
    argumentPolicySha256: invocation.argumentPolicySha256,
    environmentPolicySha256: invocation.environmentPolicySha256,
    toolPolicySha256: invocation.toolPolicySha256,
    featureStatePolicySha256: invocation.featureStatePolicySha256,
    processRequestSha256: nativePilotProcessRequestSha256(invocation.process),
  });
  if (INVOCATION_BINDINGS.has(planValue) || CONSUMED_INVOCATION_PLANS.has(planValue)) {
    fail("invocation-policy");
  }
  INVOCATION_BINDINGS.set(planValue, binding);
}

function consumeObservation(
  observation: NativePilotProcessObservation,
  expectedRequestSha256: string,
  expectedPlanSha256: string,
): void {
  try {
    consumeNativePilotProcessObservationAuthority(
      observation,
      expectedRequestSha256,
      expectedPlanSha256,
    );
  } catch (error) {
    if (error instanceof NativePilotProcessError) fail(error.code);
    throw error;
  }
}

function consumeInvocation(
  planValue: unknown,
  expectedHarness: NativePilotHarnessId,
  expectedPlanSha256: string,
): InvocationBinding {
  if (!planValue || typeof planValue !== "object") fail("invocation-policy");
  const binding = INVOCATION_BINDINGS.get(planValue);
  if (
    !binding ||
    binding.harnessId !== expectedHarness ||
    binding.planSha256 !== expectedPlanSha256
  ) {
    fail("invocation-policy");
  }
  INVOCATION_BINDINGS.delete(planValue);
  CONSUMED_INVOCATION_PLANS.add(planValue);
  return binding;
}

function expectedFeatureStatePolicySha256(): string {
  return canonicalDigest({
    version: CODEX_NATIVE_PILOT_VERSION,
    rawCaptureSha256: CODEX_NATIVE_PILOT_FEATURE_CAPTURE_SHA256,
    toolBearingFeatures: CODEX_NATIVE_PILOT_DISABLED_FEATURES,
  });
}

function codexUsage(value: unknown, plan: NativePilotStepPlanV1): NativePilotUsageV1 {
  const usage = strictObject(value, "malformed-stream");
  requiredSafeKeys(
    usage,
    [
      "cache_write_input_tokens",
      "cached_input_tokens",
      "input_tokens",
      "output_tokens",
      "reasoning_output_tokens",
    ],
    ["total_tokens"],
    "malformed-stream",
  );
  const input = integer(usage.input_tokens, "malformed-stream");
  const output = integer(usage.output_tokens, "malformed-stream");
  const cacheRead = integer(usage.cached_input_tokens, "malformed-stream");
  const cacheWrite = integer(usage.cache_write_input_tokens, "malformed-stream");
  const reasoningOutput = integer(usage.reasoning_output_tokens, "malformed-stream");
  const total = input + output;
  if (
    (usage.total_tokens !== undefined &&
      integer(usage.total_tokens, "malformed-stream") !== total) ||
    cacheRead > input ||
    cacheWrite > input ||
    reasoningOutput > output ||
    input > plan.limits.maxInputTokens ||
    output > plan.limits.maxOutputTokens
  ) {
    fail("budget-mismatch");
  }
  return Object.freeze({
    input,
    output,
    cacheRead,
    cacheWrite,
    reasoningOutput,
    total,
    effectiveInput: input,
    accounting: "codex-cache-subset",
  });
}

function parseClaudeRateLimitEvent(value: unknown, sessionId: string): void {
  const event = strictObject(value, "malformed-stream");
  exactKeys(event, ["rate_limit_info", "session_id", "type", "uuid"], "malformed-stream");
  const info = strictObject(event.rate_limit_info, "rate-limit-event-mismatch");
  exactKeys(
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
    info.status !== "allowed" ||
    info.rateLimitType !== "overage" ||
    info.overageStatus !== "allowed" ||
    typeof info.isUsingOverage !== "boolean" ||
    typeof info.overageInUse !== "boolean" ||
    !nonnegativeNumber(info.resetsAt) ||
    !nonnegativeNumber(info.overageResetsAt)
  ) {
    fail("rate-limit-event-mismatch");
  }
  safeText(event.uuid, 128, "malformed-stream");
}

function parseClaudeStructuredOutputAcknowledgement(
  value: unknown,
  sessionId: string,
  toolUseId: unknown,
): void {
  const acknowledgement = strictObject(value, "malformed-stream");
  exactKeys(
    acknowledgement,
    ["message", "parent_tool_use_id", "session_id", "timestamp", "tool_use_result", "type", "uuid"],
    "unexpected-tool-activity",
  );
  if (
    acknowledgement.type !== "user" ||
    acknowledgement.session_id !== sessionId ||
    acknowledgement.parent_tool_use_id !== null
  ) {
    fail("session-mismatch");
  }
  safeText(acknowledgement.uuid, 128, "malformed-stream");
  const timestampMs =
    typeof acknowledgement.timestamp === "string"
      ? Date.parse(acknowledgement.timestamp)
      : Number.NaN;
  if (
    typeof acknowledgement.timestamp !== "string" ||
    acknowledgement.timestamp.length > 64 ||
    Number.isNaN(timestampMs) ||
    new Date(timestampMs).toISOString() !== acknowledgement.timestamp
  ) {
    fail("malformed-stream");
  }
  if (acknowledgement.tool_use_result !== CLAUDE_NATIVE_PILOT_STRUCTURED_OUTPUT_ACKNOWLEDGEMENT) {
    fail("unexpected-tool-activity");
  }
  const message = strictObject(acknowledgement.message, "malformed-stream");
  exactKeys(message, ["content", "role"], "unexpected-tool-activity");
  if (message.role !== "user" || !Array.isArray(message.content) || message.content.length !== 1) {
    fail("unexpected-tool-activity");
  }
  const block = strictObject(message.content[0], "unexpected-tool-activity");
  exactKeys(block, ["content", "tool_use_id", "type"], "unexpected-tool-activity");
  if (
    block.type !== "tool_result" ||
    block.tool_use_id !== toolUseId ||
    block.content !== CLAUDE_NATIVE_PILOT_STRUCTURED_OUTPUT_ACKNOWLEDGEMENT
  ) {
    fail(block.tool_use_id !== toolUseId ? "digest-mismatch" : "unexpected-tool-activity");
  }
}

function claudeRawUsage(value: unknown, envelope: "assistant" | "result"): NativePilotUsageV1 {
  const usage = strictObject(value, "malformed-stream");
  exactKeys(
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
  const input = integer(usage.input_tokens, "malformed-stream");
  const output = integer(usage.output_tokens, "malformed-stream");
  const cacheCreationInputTokens = integer(usage.cache_creation_input_tokens, "malformed-stream");
  const cacheReadInputTokens = integer(usage.cache_read_input_tokens, "malformed-stream");
  if (usage.cache_creation === null) {
    if (cacheCreationInputTokens !== 0) fail("budget-mismatch");
  } else {
    const cacheCreation = strictObject(usage.cache_creation, "malformed-stream");
    exactKeys(
      cacheCreation,
      ["ephemeral_1h_input_tokens", "ephemeral_5m_input_tokens"],
      "malformed-stream",
    );
    if (
      integer(cacheCreation.ephemeral_1h_input_tokens, "malformed-stream") +
        integer(cacheCreation.ephemeral_5m_input_tokens, "malformed-stream") !==
      cacheCreationInputTokens
    ) {
      fail("budget-mismatch");
    }
  }
  if (envelope === "result" && usage.server_tool_use === null) fail("malformed-stream");
  if (envelope === "result" && usage.server_tool_use !== null) {
    const serverToolUse = strictObject(usage.server_tool_use, "malformed-stream");
    exactKeys(serverToolUse, ["web_fetch_requests", "web_search_requests"], "malformed-stream");
    if (
      integer(serverToolUse.web_fetch_requests, "malformed-stream") !== 0 ||
      integer(serverToolUse.web_search_requests, "malformed-stream") !== 0
    ) {
      fail("unexpected-tool-activity");
    }
  }
  if (envelope === "result") {
    if (!Array.isArray(usage.iterations) || usage.iterations.length !== 1) {
      fail("malformed-stream");
    }
    const iteration = strictObject(usage.iterations[0], "malformed-stream");
    exactKeys(
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
      integer(iteration.input_tokens, "malformed-stream") !== input ||
      integer(iteration.output_tokens, "malformed-stream") !== output ||
      integer(iteration.cache_read_input_tokens, "malformed-stream") !== cacheReadInputTokens ||
      integer(iteration.cache_creation_input_tokens, "malformed-stream") !==
        cacheCreationInputTokens ||
      !isDeepStrictEqual(iteration.cache_creation, usage.cache_creation)
    ) {
      fail("budget-mismatch");
    }
  }
  if (
    ![null, "standard", "priority", "batch"].includes(usage.service_tier as never) ||
    (envelope === "result" && ![null, "standard", "fast"].includes(usage.speed as never)) ||
    (usage.inference_geo !== null && typeof usage.inference_geo !== "string")
  ) {
    fail("malformed-stream");
  }
  const effectiveInput = input + cacheReadInputTokens + cacheCreationInputTokens;
  return Object.freeze({
    input,
    output,
    cacheRead: cacheReadInputTokens,
    cacheWrite: cacheCreationInputTokens,
    reasoningOutput: 0,
    total: effectiveInput + output,
    effectiveInput,
    accounting: "claude-cache-additive",
  });
}

// Ordered first-party ledger: auxiliary orchestration models first, requested root
// model last. Only the root entry carries output authority; the aggregate is what
// the Claude composition is charged.
function claudeModelUsage(
  value: unknown,
  plan: NativePilotStepPlanV1,
): {
  usage: NativePilotUsageV1;
  primaryUsage: NativePilotUsageV1;
  canonicalModel: string | null;
  ledger: readonly NativePilotModelLedgerEntryV1[];
  costUSD: number;
  providerRequests: number;
} {
  const root = strictObject(value, "malformed-stream");
  const modelIds = Object.keys(root);
  if (
    modelIds.length < 1 ||
    modelIds.length > NATIVE_PILOT_MAX_PROVIDER_REQUESTS_PER_STEP ||
    modelIds.at(-1) !== plan.requestedModel ||
    modelIds.some((modelId) => !/^claude-[a-z0-9.-]{1,127}$/u.test(modelId))
  ) {
    fail("model-identity-mismatch");
  }
  const canonicalModels = new Set<string>();
  const aggregate = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let costUSD = 0;
  const ledger = modelIds.map((modelId, index) => {
    const usage = strictObject(root[modelId], "malformed-stream");
    requiredSafeKeys(
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
    const input = integer(usage.inputTokens, "malformed-stream");
    const output = integer(usage.outputTokens, "malformed-stream");
    const cacheRead = integer(usage.cacheReadInputTokens, "malformed-stream");
    const cacheWrite = integer(usage.cacheCreationInputTokens, "malformed-stream");
    const effectiveInput = input + cacheRead + cacheWrite;
    if (
      integer(usage.webSearchRequests, "malformed-stream") !== 0 ||
      effectiveInput > plan.limits.maxInputTokens ||
      output > plan.limits.maxOutputTokens ||
      typeof usage.costUSD !== "number" ||
      !Number.isFinite(usage.costUSD) ||
      usage.costUSD < 0 ||
      (usage.provider !== undefined && usage.provider !== "firstParty")
    ) {
      fail("budget-mismatch");
    }
    integer(usage.contextWindow, "malformed-stream");
    integer(usage.maxOutputTokens, "malformed-stream");
    const primary = index === modelIds.length - 1;
    const canonicalModel =
      usage.canonicalModel === undefined
        ? null
        : safeText(usage.canonicalModel, 256, "malformed-stream");
    if (
      (!primary && canonicalModel === plan.requestedModel) ||
      (canonicalModel !== null && canonicalModels.has(canonicalModel))
    ) {
      fail("model-identity-mismatch");
    }
    if (canonicalModel !== null) canonicalModels.add(canonicalModel);
    aggregate.input += input;
    aggregate.output += output;
    aggregate.cacheRead += cacheRead;
    aggregate.cacheWrite += cacheWrite;
    costUSD += usage.costUSD;
    return Object.freeze({
      ordinal: index + 1,
      role: primary ? ("primary-output" as const) : ("internal-orchestration" as const),
      modelId,
      canonicalModel,
      provider: "firstParty" as const,
      usage: Object.freeze({
        input,
        output,
        cacheRead,
        cacheWrite,
        reasoningOutput: 0,
        total: effectiveInput + output,
        effectiveInput,
        accounting: "claude-cache-additive" as const,
      }),
      costUSD: usage.costUSD,
      outputAuthority: primary
        ? ("governed-session-structured-output" as const)
        : ("session-internal-no-independent-authority" as const),
    });
  });
  const compositionEffectiveInput = aggregate.input + aggregate.cacheRead + aggregate.cacheWrite;
  if (
    compositionEffectiveInput > plan.limits.maxInputTokens ||
    aggregate.output > plan.limits.maxOutputTokens
  ) {
    fail("budget-mismatch");
  }
  const primaryEntry = ledger.at(-1);
  if (primaryEntry === undefined) fail("model-identity-mismatch");
  return {
    usage: Object.freeze({
      input: aggregate.input,
      output: aggregate.output,
      cacheRead: aggregate.cacheRead,
      cacheWrite: aggregate.cacheWrite,
      reasoningOutput: 0,
      total: compositionEffectiveInput + aggregate.output,
      effectiveInput: compositionEffectiveInput,
      accounting: "claude-cache-additive",
    }),
    primaryUsage: primaryEntry.usage,
    canonicalModel: primaryEntry.canonicalModel,
    ledger: Object.freeze(ledger),
    costUSD,
    providerRequests: ledger.length,
  };
}

function jsonLines(value: Buffer): JsonEvidenceValue[] {
  const source = strictUtf8(value, "malformed-stream");
  const lines = source.split(/\r?\n/u).filter((line) => line.length > 0);
  if (lines.length < 1 || lines.length > 10_000) fail("malformed-stream");
  return lines.map((line) => {
    try {
      return parseJsonEvidence(line);
    } catch {
      fail("malformed-stream");
    }
  });
}

function strictObject(value: unknown, code: NativePilotFailureCode): Record<string, unknown> {
  if (!isObject(value)) fail(code);
  const descriptors = Object.values(Object.getOwnPropertyDescriptors(value));
  if (descriptors.some((descriptor) => !("value" in descriptor) || !descriptor.enumerable)) {
    fail(code);
  }
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  code: NativePilotFailureCode,
): void {
  if (
    Object.keys(value).length !== expected.length ||
    Object.keys(value).some((key) => !expected.includes(key))
  ) {
    fail(code);
  }
}

function requiredSafeKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  code: NativePilotFailureCode,
): void {
  const keys = Object.keys(value);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    keys.some(
      (key) =>
        !required.includes(key) && !optional.includes(key) && !safeAdditiveJson(value[key], 0),
    )
  ) {
    fail(code);
  }
}

function requiredExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  code: NativePilotFailureCode,
): void {
  const keys = Object.keys(value);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    keys.some((key) => !required.includes(key) && !optional.includes(key))
  ) {
    fail(code);
  }
}

function safeAdditiveJson(value: unknown, depth: number): boolean {
  if (depth > 8) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value) && !Object.is(value, -0);
  if (typeof value === "string") {
    return value.length <= 65_536 && !value.includes("\0") && value === value.normalize("NFC");
  }
  if (Array.isArray(value)) {
    return value.length <= 1_024 && value.every((entry) => safeAdditiveJson(entry, depth + 1));
  }
  if (!isObject(value) || Object.keys(value).length > 256) return false;
  return Object.entries(value).every(
    ([key, entry]) => /^[A-Za-z0-9_.:-]{1,128}$/u.test(key) && safeAdditiveJson(entry, depth + 1),
  );
}

function safeText(value: unknown, maximum: number, code: NativePilotFailureCode): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    value.includes("\0") ||
    value !== value.normalize("NFC")
  ) {
    fail(code);
  }
  return value;
}

function integer(value: unknown, code: NativePilotFailureCode): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail(code);
  return value as number;
}

function emptyArray(value: unknown): boolean {
  return Array.isArray(value) && value.length === 0;
}

function exactStringArray(value: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((entry, index) => entry === expected[index])
  );
}

function stringArray(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length <= 1_024 &&
    value.every(
      (entry) =>
        typeof entry === "string" &&
        entry.length <= 1_024 &&
        !entry.includes("\0") &&
        entry === entry.normalize("NFC"),
    )
  );
}

function nonnegativeNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
