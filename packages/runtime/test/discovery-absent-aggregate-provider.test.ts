// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { createProviderConnectionFactory } from "../src/model/provider.js";
import {
  fixtureCompositionExecutionProfile,
  sseResponse,
} from "./support/pi-harness-session-fixtures.js";

const revision = "a".repeat(40);

function reply(model: string): Response {
  return sseResponse([
    {
      id: "discovery-provider-turn",
      object: "chat.completion.chunk",
      created: 1,
      model,
      choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: null }],
    },
    {
      id: "discovery-provider-turn",
      object: "chat.completion.chunk",
      created: 1,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    },
  ]);
}

async function completeOneTurn(
  connection: Awaited<ReturnType<typeof createConnection>>["connection"],
) {
  const stream = connection.runtime.streamSimple(
    connection.model,
    {
      systemPrompt: "Govern this test request.",
      messages: [{ role: "user", content: "Reply once.", timestamp: 1 }],
    },
    { maxRetries: 0 },
  );
  for await (const _event of stream) {
    // Drain the scripted provider stream so final turn evidence is committed.
  }
}

async function createConnection(
  aggregatePolicy: { kind: "absent" } | undefined,
  limits?: { maxProviderTurns?: number; maxToolCalls?: number; maxCompactions?: number },
  fetchCalls: unknown[] = [],
) {
  const profile = fixtureCompositionExecutionProfile({
    maxProviderTurns: 1,
    timeoutMs: 300_000,
    maxResponseBytes: 65_536,
  });
  const factory = createProviderConnectionFactory({
    routeId: profile.routeId,
    transport: profile.transport,
    fetch: async (request, init) => {
      fetchCalls.push({ request, init });
      return reply(profile.modelId);
    },
  });
  const connection = await factory.create(
    {
      profile,
      credential: { family: "openai-compatible-api", apiKey: "synthetic-provider-key" },
    },
    {
      evidenceIdentity: { repositoryRevision: revision },
      ...(limits === undefined ? {} : { limits }),
      ...(aggregatePolicy ? { aggregatePolicy } : {}),
    },
  );
  return { connection, fetchCalls };
}

describe("provider governor with absent aggregate ceilings", () => {
  it("allows repeated real provider requests while preserving per-turn evidence", async () => {
    const { connection, fetchCalls } = await createConnection({ kind: "absent" });

    await completeOneTurn(connection);
    await completeOneTurn(connection);
    await completeOneTurn(connection);

    expect(fetchCalls).toHaveLength(3);
    expect(connection.turnGovernance?.evidence()).toHaveLength(3);
    expect(connection.turnGovernance?.evidence().map((turn) => turn.decision)).toEqual([
      "proceed",
      "proceed",
      "proceed",
    ]);
    for (const turn of connection.turnGovernance?.evidence() ?? []) {
      expect(turn.aggregatePolicy).toEqual({ kind: "absent" });
      expect(turn).not.toHaveProperty("maxProviderTurns");
      expect(turn).not.toHaveProperty("maxToolCalls");
      expect(turn).not.toHaveProperty("maxCompactions");
    }
  });

  it("treats optional undefined limits as omitted", async () => {
    const { connection, fetchCalls } = await createConnection(
      { kind: "absent" },
      {
        maxProviderTurns: undefined,
      },
    );

    await completeOneTurn(connection);
    await completeOneTurn(connection);
    await completeOneTurn(connection);

    expect(fetchCalls).toHaveLength(3);
  });

  it("continues to enforce the finite V1 provider-turn limit", async () => {
    const { connection, fetchCalls } = await createConnection(undefined, {
      maxProviderTurns: 1,
      maxToolCalls: 1,
      maxCompactions: 0,
    });

    await completeOneTurn(connection);
    await expect(completeOneTurn(connection)).rejects.toThrow();

    expect(fetchCalls).toHaveLength(1);
    const evidence = connection.turnGovernance?.evidence() ?? [];
    expect(evidence.map((turn) => turn.decision)).toEqual(["proceed", "stop"]);
    expect(evidence[0]).toMatchObject({
      maxProviderTurns: 1,
      maxToolCalls: 1,
      maxCompactions: 0,
    });
    expect(evidence[1]).toMatchObject({ decision: "stop", reason: "provider-turn-limit" });
  });

  it.each([
    ["maxProviderTurns", { maxProviderTurns: 1 }],
    ["maxToolCalls", { maxToolCalls: 1 }],
    ["maxCompactions", { maxCompactions: 0 }],
  ] as const)(
    "refuses explicit %s with the absent marker before requests",
    async (_name, limits) => {
      const fetchCalls: unknown[] = [];
      await expect(createConnection({ kind: "absent" }, limits, fetchCalls)).rejects.toThrow(
        "absent aggregate policy cannot be combined with explicit",
      );
      expect(fetchCalls).toEqual([]);
    },
  );
});
