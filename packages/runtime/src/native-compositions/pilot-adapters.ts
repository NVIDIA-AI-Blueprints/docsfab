// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { canonicalDigest } from "../contract-kit/index.js";
import { parseJsonEvidence, type JsonEvidenceValue } from "../json-evidence.js";
import {
  assertModelRequestCredentialFree,
  CredentialBoundaryError,
} from "../security/credential-isolation.js";
import {
  NATIVE_PILOT_ADAPTER_VERSION,
  parseNativePilotStepPlanV1,
  type NativePilotFailureCode,
  type NativePilotStepPlanV1,
} from "./pilot-contracts.js";
import { authorizeNativePilotProcessRequest } from "./pilot-process.js";
import {
  CLAUDE_NATIVE_PILOT_INTRINSIC_TOOLS,
  CLAUDE_NATIVE_PILOT_VERSION,
  CODEX_NATIVE_PILOT_CONFIG_OVERRIDES,
  CODEX_NATIVE_PILOT_DISABLED_FEATURES,
  CODEX_NATIVE_PILOT_VERSION,
  NATIVE_PILOT_SYSTEM_PROMPT,
  failAdapter,
  sha256Bytes,
  sha256Text,
  strictUtf8,
} from "./pilot-adapter-constants.js";
import {
  decodeCodexNativePilotFeatureState,
  registerInvocation,
  type NativePilotInvocation,
  type NativePilotInvocationInput,
} from "./pilot-adapter-decode.js";

export {
  CLAUDE_NATIVE_PILOT_CAPABILITIES,
  CLAUDE_NATIVE_PILOT_INERT_AGENTS,
  CLAUDE_NATIVE_PILOT_INTRINSIC_TOOLS,
  CLAUDE_NATIVE_PILOT_STRUCTURED_OUTPUT_ACKNOWLEDGEMENT,
  CLAUDE_NATIVE_PILOT_VERSION,
  CODEX_NATIVE_PILOT_DISABLED_FEATURES,
  CODEX_NATIVE_PILOT_FEATURE_CAPTURE_SHA256,
  CODEX_NATIVE_PILOT_INERT_DIAGNOSTIC,
  CODEX_NATIVE_PILOT_VERSION,
  NATIVE_PILOT_SYSTEM_PROMPT_SHA256,
} from "./pilot-adapter-constants.js";

export {
  decodeClaudeNativePilotResult,
  decodeCodexNativePilotFeatureState,
  decodeCodexNativePilotResult,
  decodeNativePilotResult,
  type NativePilotDecodedResult,
  type NativePilotFeatureStateEvidenceV1,
  type NativePilotInvocation,
  type NativePilotInvocationInput,
} from "./pilot-adapter-decode.js";

function fail(code: NativePilotFailureCode): never {
  failAdapter(code);
}

export function buildCodexNativePilotInvocation(
  input: NativePilotInvocationInput,
): NativePilotInvocation {
  const plan = parseNativePilotStepPlanV1(input.plan);
  if (plan.harnessId !== "codex") fail("invocation-policy");
  if (!input.codexFeatureStateCapture) fail("feature-state-mismatch");
  const featureState = decodeCodexNativePilotFeatureState(input.codexFeatureStateCapture);
  const schemaJson = validateInvocationInput(plan, input.stdin, input.outputSchemaJson);
  if (plan.reportedVersion !== CODEX_NATIVE_PILOT_VERSION || plan.outputSchemaPath === null) {
    fail("executable-policy");
  }
  const argumentsValue = [
    "--strict-config",
    "--model",
    plan.requestedModel,
    "--ask-for-approval",
    "never",
    ...CODEX_NATIVE_PILOT_CONFIG_OVERRIDES.flatMap((override) => ["--config", override]),
    ...CODEX_NATIVE_PILOT_DISABLED_FEATURES.flatMap((feature) => ["--disable", feature]),
    "exec",
    "--sandbox",
    "read-only",
    "--cd",
    plan.workingDirectory,
    "--skip-git-repo-check",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--json",
    "--output-schema",
    plan.outputSchemaPath,
    "--color",
    "never",
    "-",
  ] as const;
  const invocation = buildInvocation(
    plan,
    input.stdin,
    schemaJson,
    argumentsValue,
    featureState.policySha256,
  );
  registerInvocation(input.plan, invocation, plan.planSha256);
  return invocation;
}

/**
 * Parse-only Codex configuration canary. The app-server closes on stdin EOF,
 * performs no model request, and unlike help/features commands honors
 * `--strict-config` for every live override.
 */
export function buildCodexNativePilotStrictConfigProbeArguments(): readonly string[] {
  return Object.freeze([
    "app-server",
    "--strict-config",
    ...CODEX_NATIVE_PILOT_CONFIG_OVERRIDES.flatMap((override) => ["--config", override]),
    ...CODEX_NATIVE_PILOT_DISABLED_FEATURES.flatMap((feature) => ["--disable", feature]),
    "--listen",
    "stdio://",
  ]);
}

export function buildClaudeNativePilotInvocation(
  input: NativePilotInvocationInput,
): NativePilotInvocation {
  const plan = parseNativePilotStepPlanV1(input.plan);
  if (plan.harnessId !== "claude-code" || input.codexFeatureStateCapture !== undefined) {
    fail("invocation-policy");
  }
  const schemaJson = validateInvocationInput(plan, input.stdin, input.outputSchemaJson);
  if (plan.reportedVersion !== CLAUDE_NATIVE_PILOT_VERSION || plan.outputSchemaPath !== null) {
    fail("executable-policy");
  }
  const argumentsValue = [
    "--print",
    "--input-format",
    "text",
    "--model",
    plan.requestedModel,
    "--effort",
    "low",
    "--max-turns",
    "1",
    "--output-format",
    "stream-json",
    "--verbose",
    "--json-schema",
    schemaJson,
    "--no-session-persistence",
    "--safe-mode",
    "--disable-slash-commands",
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--system-prompt",
    NATIVE_PILOT_SYSTEM_PROMPT,
    "--tools",
    "",
    "--permission-mode",
    "dontAsk",
    "--no-chrome",
  ] as const;
  const invocation = buildInvocation(plan, input.stdin, schemaJson, argumentsValue, null);
  registerInvocation(input.plan, invocation, plan.planSha256);
  return invocation;
}

function buildInvocation(
  plan: NativePilotStepPlanV1,
  stdin: Buffer,
  outputSchemaJson: string,
  argumentsValue: readonly string[],
  featureStatePolicySha256: string | null,
): NativePilotInvocation {
  try {
    assertModelRequestCredentialFree({
      arguments: argumentsValue,
      environment: plan.environment,
      stdinUtf8: strictUtf8(stdin, "invalid-value"),
      workingDirectory: plan.workingDirectory,
      outputSchemaJson,
    });
  } catch (error) {
    if (error instanceof CredentialBoundaryError) fail("credential-material");
    throw error;
  }
  const argumentPolicySha256 = canonicalDigest({
    adapterVersion: NATIVE_PILOT_ADAPTER_VERSION,
    harnessId: plan.harnessId,
    arguments: argumentsValue,
  });
  const environmentPolicySha256 = environmentPolicy(plan);
  const toolPolicySha256 = toolPolicy(plan);
  const processRequest = Object.freeze({
    harnessId: plan.harnessId,
    executablePath: plan.executablePath,
    arguments: Object.freeze([...argumentsValue]),
    workingDirectory: plan.workingDirectory,
    environment: Object.freeze({ ...plan.environment }),
    stdin: Buffer.from(stdin),
    timeoutMs: plan.limits.timeoutMs,
    maxStdoutBytes: plan.limits.maxStdoutBytes,
    maxStderrBytes: plan.limits.maxStderrBytes,
    streamPolicy:
      plan.harnessId === "claude-code"
        ? Object.freeze({
            kind: "claude-2.1.226-guard-v1" as const,
            requestedModel: "claude-opus-4-7" as const,
            stepId: plan.stepId,
            workingDirectory: plan.workingDirectory,
          })
        : Object.freeze({ kind: "terminal-capture-v1" as const }),
  });
  authorizeNativePilotProcessRequest(processRequest, plan.planSha256);
  return Object.freeze({
    harnessId: plan.harnessId,
    process: processRequest,
    argumentPolicySha256,
    environmentPolicySha256,
    toolPolicySha256,
    featureStatePolicySha256,
  });
}

function validateInvocationInput(
  plan: NativePilotStepPlanV1,
  stdin: Buffer,
  outputSchemaJson: string,
): string {
  if (
    !Buffer.isBuffer(stdin) ||
    stdin.byteLength < 1 ||
    stdin.byteLength > plan.limits.maxStdinBytes ||
    sha256Bytes(stdin) !== plan.stdinSha256 ||
    sha256Bytes(stdin) !== plan.serializedInputSha256
  ) {
    fail("invocation-policy");
  }
  const stdinUtf8 = strictUtf8(stdin, "invalid-value");
  if (stdinUtf8.length < 1) fail("invalid-value");
  const schemaBytes = Buffer.from(outputSchemaJson, "utf8");
  if (schemaBytes.byteLength < 2 || schemaBytes.byteLength > plan.limits.maxOutputSchemaBytes) {
    fail("invocation-policy");
  }
  let schema: JsonEvidenceValue;
  try {
    schema = parseJsonEvidence(schemaBytes);
  } catch {
    fail("malformed-output");
  }
  if (canonicalDigest(schema) !== plan.outputSchemaSha256) fail("invocation-policy");
  if (sha256Text(NATIVE_PILOT_SYSTEM_PROMPT) !== plan.systemPromptSha256) {
    fail("invocation-policy");
  }
  return outputSchemaJson;
}

function environmentPolicy(plan: NativePilotStepPlanV1): string {
  return canonicalDigest({
    names: Object.keys(plan.environment).sort(),
    valueDigests: Object.fromEntries(
      Object.entries(plan.environment)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, value]) => [name, sha256Text(value)]),
    ),
  });
}

function toolPolicy(plan: NativePilotStepPlanV1): string {
  return canonicalDigest({
    harnessId: plan.harnessId,
    tools:
      plan.harnessId === "claude-code"
        ? { intrinsic: CLAUDE_NATIVE_PILOT_INTRINSIC_TOOLS, callableExternal: [] }
        : "empty",
    mcp: "empty",
    toolEventsAllowed: 0,
    repositoryExposed: false,
  });
}
