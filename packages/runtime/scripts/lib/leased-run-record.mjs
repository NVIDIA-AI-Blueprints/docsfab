// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Write one run record through a built package's own record writer. Its
 * inference step retries one malformed reply, then succeeds with Pi
 * execution-lease evidence from the same build; a stub stands in for the
 * provider. Each measured value differs from the others, so a row that reads
 * the wrong field cannot match by accident.
 *
 * @param {{ packageRoot: string; stateDirectory: string; recordId: string; inputTokens?: number }} input
 * @returns {Promise<{ recordPath: string; observed: Record<string, number> }>}
 */
export async function writeLeasedRunRecord({
  packageRoot,
  stateDirectory,
  recordId,
  inputTokens = 4_567,
}) {
  const load = (path) => import(pathToFileURL(join(packageRoot, "dist", path)).href);
  const [
    { FileRunStore },
    { executeInferenceStep },
    { PiExecutionLeaseController, digestPiToolCall },
    { createExecutionLeaseCoordinatorPolicy },
    { parseRetryPolicy },
    { InferenceStepError },
  ] = await Promise.all([
    load("records/file-store.js"),
    load("workflow-execution/retry.js"),
    load("harness/pi-lease.js"),
    load("execution/index.js"),
    load("config/retry-policy.js"),
    load("execution/contracts.js"),
  ]);

  const toolCalls = 3;
  const turns = [
    { inputTokens: inputTokens - 567, outputTokens: 500 },
    { inputTokens: 567, outputTokens: 390 },
  ];
  const outputTokens = turns[0].outputTokens + turns[1].outputTokens;
  const context = {
    status: "ready",
    availableInputTokens: 1_000_000,
    requiredInputTokens: 1,
    authoritySha256: "9".repeat(64),
  };
  const lease = (attempt) => {
    const controller = new PiExecutionLeaseController({
      policy: createExecutionLeaseCoordinatorPolicy({
        maxCompactions: 1,
        providerLimits: { maxProviderTurns: 16, maxCompactions: 1 },
        cumulative: { maxInputTokens: 1_000_000, maxOutputTokens: 100_000, maxElapsedMs: 60_000 },
      }),
      identity: {
        inferenceAttempt: attempt,
        retriesConsumed: attempt - 1,
        authorizationSha256: "1".repeat(64),
        repositoryRevision: "a".repeat(40),
        contextPacketSha256: "2".repeat(64),
        evidenceSha256: "3".repeat(64),
        toolPolicySha256: "4".repeat(64),
        contextAuthoritySha256: context.authoritySha256,
      },
      pricing: {
        status: "known",
        inputMicrousdPerMillionTokens: 100,
        outputMicrousdPerMillionTokens: 200,
        authoritySha256: "5".repeat(64),
      },
      context,
    });
    const calls = Array.from({ length: toolCalls }, (_, index) => ({
      callSha256: digestPiToolCall(`call-${String(index)}`, "read", index),
      authorization: "execute",
    }));
    const [toolTurn, finalTurn] = turns;
    controller.requestToolBatch(calls, {
      kind: "ordinary",
      toolCalls,
      providerTurns: 1,
      compactions: 0,
      ...toolTurn,
      elapsedMs: 1,
      contextInputTokens: 1,
    });
    controller.settleToolBatch(
      calls.map(({ callSha256 }) => ({ callSha256, outcome: "succeeded" })),
      { ...toolTurn, elapsedMs: 1, compactions: 0, context },
    );
    controller.preflightProviderTurn({
      kind: "ordinary",
      toolCalls: 0,
      providerTurns: 1,
      compactions: 0,
      ...finalTurn,
      elapsedMs: 1,
      contextInputTokens: 1,
    });
    controller.settleOrdinaryProviderTurn({ ...finalTurn, elapsedMs: 1, compactions: 0, context });
    controller.complete();
    return controller.evidence({
      inferenceAttempt: attempt,
      retriesConsumed: attempt - 1,
      repositoryRevision: "a".repeat(40),
      providerTurnLedgerSha256: "6".repeat(64),
      usageSha256: "7".repeat(64),
      toolsSha256: "8".repeat(64),
    });
  };
  const usage = {
    input: inputTokens,
    output: outputTokens,
    cacheRead: 0,
    cacheWrite: 0,
    total: inputTokens + outputTokens,
    turns: turns.length,
  };
  const tools = { totalCalls: toolCalls, failedCalls: 0, byTool: [] };

  let clock = 0;
  const produced = await executeInferenceStep({
    mode: "read-only",
    // The recorded run lowered its retry delay, so its one retry stays below
    // the default the reader compares it with. No host limits file applies.
    policy: parseRetryPolicy({ DOCSFAB_RETRY_BASE_DELAY_MS: "250", NODE_TEST_CONTEXT: "fixture" }),
    now: () => {
      clock += 7_919;
      return clock;
    },
    sleep: async () => undefined,
    execute: async (attempt) => {
      if (attempt === 1) {
        throw new InferenceStepError(
          "The reply did not match the response contract.",
          "malformed-response",
          true,
        );
      }
      return { summary: "Stub provider answer.", usage, tools, executionLease: lease(attempt) };
    },
  });
  const [retried, leased] = produced.evidence.attempts;
  if (produced.status !== "succeeded" || leased?.executionLease === undefined) {
    throw new Error("The leased run-record fixture did not produce a succeeded leased attempt.");
  }

  await new FileRunStore(stateDirectory).save({
    schemaVersion: 2,
    id: recordId,
    workflow: "review-documentation",
    repository: {
      sourcePath: "/operator/source",
      requestedRevision: "HEAD",
      revision: "a".repeat(40),
    },
    workspace: { strategy: "tracked-export", disposable: true },
    status: "succeeded",
    createdAt: "2026-10-07T12:00:00.000Z",
    models: [],
    skills: [],
    usage,
    tools,
    steps: [
      {
        id: "audit-documentation",
        title: "Audit documentation",
        skill: "review-documentation",
        mode: "read-only",
        status: produced.status,
        inference: produced.evidence,
      },
    ],
  });
  return {
    recordPath: join(stateDirectory, `${recordId}.json`),
    observed: {
      "compositionExecution.timeoutMs": leased.durationMs,
      "compositionExecution.maxProviderTurns": turns.length,
      "compositionExecution.maxToolCallsPerStep": toolCalls,
      "compositionExecution.maxCumulativeInputTokens": inputTokens,
      "compositionExecution.maxCumulativeOutputTokens": outputTokens,
      "retry.maxRetries": 1,
      "retry.baseDelayMs": retried.backoffMs,
      "retry.maxDelayMs": retried.backoffMs,
    },
  };
}
