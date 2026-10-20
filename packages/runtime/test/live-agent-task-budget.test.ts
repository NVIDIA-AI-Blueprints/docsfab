// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  createRootTaskBudget,
  projectTaskBudget,
  type TaskBudgetOwner,
} from "../src/execution/task-budget.js";
import type { BoundModelExecutionProfile } from "../src/model/configuration.js";
import { createFirstPassSupportModelBridge } from "../src/cli/first-pass-support.js";
import { createProviderConnectionFactory, withTaskBudgetScope } from "../src/model/provider.js";
import { createRequestIntentModelPort } from "../src/request-intent/interpret-model.js";
import { validModelConfig } from "./helpers.js";

function owner(turns: number): TaskBudgetOwner {
  return createRootTaskBudget({
    envelope: {
      "provider-turns": turns,
      "tool-calls": 0,
      "input-tokens": 0,
      "output-tokens": 0,
      "source-bytes": 0,
      "elapsed-ms": 0,
      "cost-microusd": 0,
    },
  });
}

const profile: BoundModelExecutionProfile = {
  routeId: "direct-openai",
  providerId: "task-budget-provider",
  baseUrl: "https://task-budget.example.test/v1",
  modelId: "model-under-test",
  transport: "openai-chat-completions",
  apiFormat: "chat_completions",
  profile: {
    ...validModelConfig.profile,
    compatibility: { ...validModelConfig.profile.compatibility, apiFormats: ["chat_completions"] },
  },
  requestPolicy: validModelConfig.requestPolicy,
};

function reply(): Response {
  const body = [
    `data: ${JSON.stringify({ id: "budget", object: "chat.completion.chunk", created: 1, model: profile.modelId, choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ id: "budget", object: "chat.completion.chunk", created: 1, model: profile.modelId, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

async function connection(fetch: typeof globalThis.fetch, taskBudget?: TaskBudgetOwner) {
  return createProviderConnectionFactory({
    routeId: profile.routeId,
    transport: profile.transport,
    fetch,
  }).create(
    { profile, credential: { family: "openai-compatible-api", apiKey: "synthetic-task-key" } },
    taskBudget
      ? {
          evidenceIdentity: { repositoryRevision: "a".repeat(40) },
          aggregatePolicy: { kind: "absent" },
          aggregatePhysicalRequestLimit: { kind: "absent" },
          taskBudget,
        }
      : undefined,
  );
}

async function ask(active: Awaited<ReturnType<typeof connection>>) {
  return active.runtime.completeSimple(
    active.model,
    { systemPrompt: "Reply once.", messages: [{ role: "user", content: "Answer.", timestamp: 1 }] },
    { maxRetries: 0 },
  );
}

describe("live-agent physical task budget", () => {
  it("admits one physical dispatch and refuses a second before the transport", async () => {
    const budget = owner(1);
    let sent = 0;
    const refusals: { code: string; dimension?: string; observed?: number; remaining?: number }[] =
      [];
    const active = await createProviderConnectionFactory({
      routeId: profile.routeId,
      transport: profile.transport,
      fetch: async () => {
        sent += 1;
        return reply();
      },
    }).create(
      { profile, credential: { family: "openai-compatible-api", apiKey: "synthetic-task-key" } },
      {
        evidenceIdentity: { repositoryRevision: "a".repeat(40) },
        aggregatePolicy: { kind: "absent" },
        aggregatePhysicalRequestLimit: { kind: "absent" },
        taskBudget: budget,
        onTaskBudgetRefusal: (error) => refusals.push(error),
      },
    );
    await ask(active);
    await ask(active).catch(() => undefined);
    expect(sent).toBe(1);
    expect(projectTaskBudget(budget).settled["provider-turns"]).toBe(1);
    expect(refusals).toContainEqual(
      expect.objectContaining({
        code: "budget-exhausted",
        dimension: "provider-turns",
        remaining: 0,
        observed: 1,
      }),
    );
  });

  it("charges isolated async child scopes and refuses an explicit-owner mismatch", async () => {
    const first = owner(1);
    const second = owner(1);
    let sent = 0;
    const active = await connection(async () => {
      sent += 1;
      return reply();
    });
    await Promise.all([
      withTaskBudgetScope(first, () => ask(active)),
      withTaskBudgetScope(second, () => ask(active)),
    ]);
    expect(sent).toBe(2);
    expect(projectTaskBudget(first).settled["provider-turns"]).toBe(1);
    expect(projectTaskBudget(second).settled["provider-turns"]).toBe(1);

    const bound = await connection(async () => {
      sent += 1;
      return reply();
    }, first);
    await withTaskBudgetScope(second, () => ask(bound)).catch(() => undefined);
    expect(sent).toBe(2);
  });

  it("keeps a scoped owner through a deferred transport continuation", async () => {
    const budget = owner(1);
    let release!: () => void;
    let start!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      start = resolve;
    });
    let sent = 0;
    const active = await connection(async () => {
      sent += 1;
      start();
      await held;
      return reply();
    });
    const pending = withTaskBudgetScope(budget, () => ask(active));
    await started;
    expect(sent).toBe(1);
    expect(projectTaskBudget(budget).settled["provider-turns"]).toBe(1);
    release();
    await pending;
  });

  it("refuses exhausted request interpretation before any physical dispatch", async () => {
    const budget = owner(0);
    let sent = 0;
    const interpreter = createRequestIntentModelPort({
      config: { model: validModelConfig } as never,
      workflow: "update-documentation",
      repositoryRevision: "a".repeat(40),
      maxCalls: 1,
      connectionFactory: () =>
        connection(async () => {
          sent += 1;
          return reply();
        }),
    });
    await withTaskBudgetScope(budget, () =>
      interpreter.call({
        systemPrompt: "Interpret.",
        prompt: "Update the guide.",
        maxOutputTokens: 16,
        signal: AbortSignal.timeout(1_000),
      }),
    ).catch(() => undefined);
    expect(sent).toBe(0);
    expect(projectTaskBudget(budget).settled["provider-turns"]).toBe(0);
  });

  it("charges parent, interpretation, first pass, workflow, and parent follow-up once each", async () => {
    const budget = owner(5);
    let sent = 0;
    const open = () =>
      connection(async () => {
        sent += 1;
        return reply();
      });
    const parent = await connection(async () => {
      sent += 1;
      return reply();
    }, budget);
    const interpreter = createRequestIntentModelPort({
      config: { model: validModelConfig, retryPolicy: { maxRetries: 0 } } as never,
      workflow: "update-documentation",
      repositoryRevision: "a".repeat(40),
      maxCalls: 1,
      connectionFactory: open,
    });
    const firstPass = createFirstPassSupportModelBridge({
      config: { model: validModelConfig, retryPolicy: { maxRetries: 0 } } as never,
      repositoryRevision: "a".repeat(40),
      loadEvidenceFrameParser: async () => () => [],
      connectionFactory: open,
    });
    await ask(parent);
    await withTaskBudgetScope(budget, async () => {
      await interpreter.call({
        systemPrompt: "Interpret.",
        prompt: "Update the guide.",
        maxOutputTokens: 16,
        signal: new AbortController().signal,
      });
      await firstPass.call({
        systemPrompt: "Assess.",
        prompt: "Phase: decomposition. Identify the guide.",
        maxOutputTokens: 16,
        procedureId: "fixture-procedure",
        procedureSha256: "b".repeat(64),
        promptSha256: "c".repeat(64),
      });
      await ask(await open());
    });
    await ask(parent);
    expect(sent).toBe(5);
    expect(projectTaskBudget(budget).settled["provider-turns"]).toBe(5);
  });
});
