// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { lstat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { canonicalDigest } from "../contract-kit/index.js";
import { parseJsonEvidence } from "../json-evidence.js";
import { detectCredentialRuleIdsInValue } from "../security/repository-scanner.js";
import {
  assertRunnerNewWritePath,
  decodeUtf8,
  ensureRunnerPrivateDirectory,
  nonnegativeInteger,
  sha256,
  strictObject,
  strictUtf8,
} from "./pilot-paths.js";
import { zeroAggregateUsage } from "./pilot-attempt.js";
import { fail } from "./pilot-runner-error.js";
import {
  NATIVE_PILOT_MAX_PROVIDER_REQUESTS_PER_STEP,
  type NativePilotHarnessId,
  type NativePilotStepId,
  type NativePilotStepReceiptV1,
} from "./pilot-contracts.js";
import type { NativePilotProcessObservation } from "./pilot-process.js";
import type {
  NativePilotAggregateUsageV1,
  NativePilotFailureEvidenceV1,
  RunnerState,
} from "./pilot-runner.js";

export async function persistNativeCapture(input: {
  readonly state: RunnerState;
  readonly attemptRoot: string;
  readonly stepId: NativePilotStepId;
  readonly ordinal: number;
  readonly observation: NativePilotProcessObservation;
  readonly receipt: NativePilotStepReceiptV1;
}): Promise<string> {
  const stdoutText = strictUtf8(input.observation.stdout);
  const stderrText = strictUtf8(input.observation.stderr);
  if (detectCredentialRuleIdsInValue({ stdoutText, stderrText }).length > 0) {
    fail("credential-material");
  }
  const directory = join(input.attemptRoot, "captures");
  await ensureRunnerPrivateDirectory(input.state, directory, true);
  const prefix = `${String(input.ordinal).padStart(2, "0")}-${input.stepId}`;
  const stdoutPath = join(directory, `${prefix}.stdout.jsonl`);
  const stderrPath = join(directory, `${prefix}.stderr.txt`);
  await Promise.all([
    assertRunnerNewWritePath(input.state, stdoutPath),
    assertRunnerNewWritePath(input.state, stderrPath),
  ]);
  await Promise.all([
    writeFile(stdoutPath, input.observation.stdout, { flag: "wx", mode: 0o600 }),
    writeFile(stderrPath, input.observation.stderr, { flag: "wx", mode: 0o600 }),
  ]);
  const body = {
    stepId: input.stepId,
    receiptSha256: input.receipt.receiptSha256,
    sessionSha256: input.receipt.sessionSha256,
    stdoutSha256: sha256(input.observation.stdout),
    stderrSha256: sha256(input.observation.stderr),
    stdoutBytes: input.observation.stdoutBytes,
    stderrBytes: input.observation.stderrBytes,
  };
  const captureSha256 = canonicalDigest(body);
  const receiptPath = join(directory, `${prefix}.capture.json`);
  await assertRunnerNewWritePath(input.state, receiptPath);
  await writeFile(
    receiptPath,
    `${JSON.stringify({ schemaVersion: 1, kind: "docsfab-native-pilot-capture", ...body, captureSha256 }, null, 2)}\n`,
    { flag: "wx", mode: 0o600 },
  );
  for (const path of [stdoutPath, stderrPath, receiptPath]) {
    const metadata = await lstat(path);
    const owner = typeof process.getuid === "function" ? process.getuid() : metadata.uid;
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.uid !== owner ||
      (metadata.mode & 0o077) !== 0
    ) {
      fail("artifact-permissions-invalid");
    }
  }
  return captureSha256;
}

export async function persistFailedNativeCapture(input: {
  readonly state: RunnerState;
  readonly attemptRoot: string;
  readonly stepId: NativePilotStepId;
  readonly ordinal: number;
  readonly harnessId: NativePilotHarnessId;
  readonly requestedModel: string;
  readonly observation: NativePilotProcessObservation;
}): Promise<NativePilotFailureEvidenceV1> {
  if (
    input.observation.providerRequests < input.observation.providerRequestLowerBound ||
    input.observation.fallbackAttempted
  ) {
    fail("provider-request-count-mismatch");
  }
  if (
    input.harnessId === "claude-code" &&
    (input.observation.streamDisposition === "terminal-capture" ||
      !input.observation.processGroupSettled ||
      !input.observation.stdoutEof ||
      !input.observation.stderrEof ||
      (input.observation.stopSettlementRequired &&
        (!input.observation.killIssued ||
          !input.observation.killIssuedBeforeRetryDeadline ||
          input.observation.streamDisposition !== "stopped")))
  ) {
    fail("process-not-settled");
  }
  const stdoutSha256 = sha256(input.observation.stdout);
  const stderrSha256 = sha256(input.observation.stderr);
  const safeRaw =
    credentialFreeBuffer(input.observation.stdout) &&
    credentialFreeBuffer(input.observation.stderr);
  const projected = projectFailedNativeStream(
    input.harnessId,
    input.requestedModel,
    input.observation.stdout,
  );
  const body = {
    stepId: input.stepId,
    processStatus: input.observation.status,
    sessionSha256: projected.sessionSha256,
    usage: projected.usage,
    providerTurns: input.observation.providerRequests,
    providerRequests: input.observation.providerRequests,
    durationMs: input.observation.durationMs,
    stdoutBytes: input.observation.stdoutBytes,
    stderrBytes: input.observation.stderrBytes,
    stdoutSha256,
    stderrSha256,
    rawBytesRetained: safeRaw,
  };
  const captureSha256 = canonicalDigest(body);
  const directory = join(input.attemptRoot, "captures");
  await ensureRunnerPrivateDirectory(input.state, directory, true);
  const prefix = `${String(input.ordinal).padStart(2, "0")}-${input.stepId}.failed`;
  if (safeRaw) {
    const stdoutPath = join(directory, `${prefix}.stdout`);
    const stderrPath = join(directory, `${prefix}.stderr`);
    await Promise.all([
      assertRunnerNewWritePath(input.state, stdoutPath),
      assertRunnerNewWritePath(input.state, stderrPath),
    ]);
    await Promise.all([
      writeFile(stdoutPath, input.observation.stdout, {
        flag: "wx",
        mode: 0o600,
      }),
      writeFile(stderrPath, input.observation.stderr, {
        flag: "wx",
        mode: 0o600,
      }),
    ]);
  }
  const receiptPath = join(directory, `${prefix}.capture.json`);
  await assertRunnerNewWritePath(input.state, receiptPath);
  await writeFile(
    receiptPath,
    `${JSON.stringify({ schemaVersion: 1, kind: "docsfab-native-pilot-failed-capture", ...body, captureSha256 }, null, 2)}\n`,
    { flag: "wx", mode: 0o600 },
  );
  return {
    stepId: input.stepId,
    processStatus: input.observation.status,
    sessionSha256: projected.sessionSha256,
    usage: projected.usage,
    providerTurns: input.observation.providerRequests,
    providerRequests: input.observation.providerRequests,
    durationMs: input.observation.durationMs,
    stdoutBytes: input.observation.stdoutBytes,
    stderrBytes: input.observation.stderrBytes,
    captureSha256,
  };
}

function projectFailedNativeStream(
  harnessId: NativePilotHarnessId,
  requestedModel: string,
  stdout: Buffer,
): {
  readonly sessionSha256: string | null;
  readonly usage: NativePilotAggregateUsageV1;
  readonly providerTurns: number;
} {
  const unavailable = {
    sessionSha256: null,
    usage: zeroAggregateUsage(),
    providerTurns: 0,
  };
  if (!credentialFreeBuffer(stdout)) return unavailable;
  let events: Array<Record<string, unknown>>;
  try {
    events = decodeUtf8(stdout)
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => strictObject(parseJsonEvidence(line)));
  } catch {
    return unavailable;
  }
  if (harnessId === "codex") {
    const started = events.find((event) => event.type === "thread.started");
    const completed = [...events].reverse().find((event) => event.type === "turn.completed");
    if (typeof started?.thread_id !== "string") return unavailable;
    const usage = completed ? projectCodexFailedUsage(completed.usage) : zeroAggregateUsage();
    return {
      sessionSha256: canonicalDigest({ harnessId, threadId: started.thread_id }),
      usage,
      providerTurns: completed ? 1 : 0,
    };
  }
  const init = events.find((event) => event.type === "system" && event.subtype === "init");
  const result = [...events].reverse().find((event) => event.type === "result");
  if (typeof init?.session_id !== "string") return unavailable;
  const usage = result
    ? projectClaudeFailedUsage(result.modelUsage, requestedModel)
    : zeroAggregateUsage();
  return {
    sessionSha256: canonicalDigest({ harnessId, sessionId: init.session_id }),
    usage,
    providerTurns: result ? 1 : 0,
  };
}

function projectCodexFailedUsage(value: unknown): NativePilotAggregateUsageV1 {
  try {
    const usage = strictObject(value);
    const input = nonnegativeInteger(usage.input_tokens);
    const output = nonnegativeInteger(usage.output_tokens);
    const cacheRead = nonnegativeInteger(usage.cached_input_tokens);
    const cacheWrite = nonnegativeInteger(usage.cache_write_input_tokens);
    const reasoningOutput = nonnegativeInteger(usage.reasoning_output_tokens);
    const total = input + output;
    if (
      (usage.total_tokens !== undefined && nonnegativeInteger(usage.total_tokens) !== total) ||
      cacheRead > input ||
      cacheWrite > input ||
      reasoningOutput > output
    ) {
      return zeroAggregateUsage();
    }
    return { input, output, cacheRead, cacheWrite, reasoningOutput, total };
  } catch {
    return zeroAggregateUsage();
  }
}

// Failed-attempt projection charges the whole composition: the ordered ledger may
// carry bounded first-party auxiliary entries before the requested root model.
function projectClaudeFailedUsage(
  value: unknown,
  requestedModel: string,
): NativePilotAggregateUsageV1 {
  try {
    const modelUsage = strictObject(value);
    const modelIds = Object.keys(modelUsage);
    if (
      modelIds.length < 1 ||
      modelIds.length > NATIVE_PILOT_MAX_PROVIDER_REQUESTS_PER_STEP ||
      modelIds.at(-1) !== requestedModel
    ) {
      return zeroAggregateUsage();
    }
    const aggregate = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    for (const modelId of modelIds) {
      const usage = strictObject(modelUsage[modelId]);
      aggregate.input += nonnegativeInteger(usage.inputTokens);
      aggregate.output += nonnegativeInteger(usage.outputTokens);
      aggregate.cacheRead += nonnegativeInteger(usage.cacheReadInputTokens);
      aggregate.cacheWrite += nonnegativeInteger(usage.cacheCreationInputTokens);
    }
    return {
      ...aggregate,
      reasoningOutput: 0,
      total: aggregate.input + aggregate.output + aggregate.cacheRead + aggregate.cacheWrite,
    };
  } catch {
    return zeroAggregateUsage();
  }
}

function credentialFreeBuffer(bytes: Buffer): boolean {
  try {
    return detectCredentialRuleIdsInValue(decodeUtf8(bytes)).length === 0;
  } catch {
    return false;
  }
}
export function aggregateNativeUsage(
  receipts: readonly NativePilotStepReceiptV1[],
  failure: NativePilotFailureEvidenceV1 | null = null,
): {
  readonly usage: NativePilotAggregateUsageV1;
  readonly providerTurns: number;
  readonly providerRequests: number;
  readonly durationMs: number;
} {
  const usage: NativePilotAggregateUsageV1 = {
    input:
      receipts.reduce((sum, receipt) => sum + receipt.usage.input, 0) + (failure?.usage.input ?? 0),
    output:
      receipts.reduce((sum, receipt) => sum + receipt.usage.output, 0) +
      (failure?.usage.output ?? 0),
    cacheRead:
      receipts.reduce((sum, receipt) => sum + receipt.usage.cacheRead, 0) +
      (failure?.usage.cacheRead ?? 0),
    cacheWrite:
      receipts.reduce((sum, receipt) => sum + receipt.usage.cacheWrite, 0) +
      (failure?.usage.cacheWrite ?? 0),
    reasoningOutput:
      receipts.reduce((sum, receipt) => sum + receipt.usage.reasoningOutput, 0) +
      (failure?.usage.reasoningOutput ?? 0),
    total:
      receipts.reduce((sum, receipt) => sum + receipt.usage.total, 0) + (failure?.usage.total ?? 0),
  };
  return {
    usage,
    providerTurns:
      receipts.reduce((sum, receipt) => sum + receipt.providerTurns, 0) +
      (failure?.providerTurns ?? 0),
    providerRequests:
      receipts.reduce((sum, receipt) => sum + receipt.providerRequests, 0) +
      (failure?.providerRequests ?? 0),
    durationMs:
      receipts.reduce((sum, receipt) => sum + receipt.durationMs, 0) + (failure?.durationMs ?? 0),
  };
}
