// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from "vitest";

import {
  captureInferenceFailure,
  createAuditHarness,
  createModelConnection,
  createRepository,
  getWorkflow,
  resetSharedTestState,
  scriptedProvider,
  stepInput,
  toolTurn,
} from "./support/pi-harness-session-fixtures.js";

const providerFailure = () =>
  new Response(JSON.stringify({ error: { message: "provider unavailable" } }), {
    status: 503,
    headers: { "content-type": "application/json" },
  });

afterEach(resetSharedTestState);

describe("PiHarness write-settlement evidence on provider failure", () => {
  it("proves no write when a provider failure ends the attempt before any tool call", async () => {
    const repositoryPath = await createRepository();
    const base = stepInput(repositoryPath);
    const workflow = getWorkflow("restructure-documentation");
    const step = workflow.steps.find((candidate) => candidate.id === "write-documentation")!;
    const harness = await createAuditHarness({
      createConnection: (model, options) =>
        createModelConnection(
          model,
          options
            ? {
                ...options,
                providerTurnRetry: {
                  baseDelayMs: 0,
                  maxDelayMs: 0,
                  maxAttempts: 1,
                  maxBlankAttempts: 1,
                },
              }
            : options,
        ),
    });
    globalThis.fetch = scriptedProvider(Array.from({ length: 8 }, providerFailure));

    const error = await captureInferenceFailure(harness, { ...base, workflow, step });

    expect(error.evidence?.writeSettlement).toBe("no-write");
    expect(error.evidence?.tools).toMatchObject({ totalCalls: 0, byTool: [] });
  });

  it("keeps a settled write in scope across later turns before provider failure", async () => {
    const repositoryPath = await createRepository();
    const base = stepInput(repositoryPath);
    const workflow = getWorkflow("restructure-documentation");
    const step = workflow.steps.find((candidate) => candidate.id === "write-documentation")!;
    const harness = await createAuditHarness({
      createConnection: (model, options) =>
        createModelConnection(
          model,
          options
            ? {
                ...options,
                providerTurnRetry: {
                  baseDelayMs: 0,
                  maxDelayMs: 0,
                  maxAttempts: 1,
                  maxBlankAttempts: 1,
                },
              }
            : options,
        ),
    });
    globalThis.fetch = scriptedProvider([
      toolTurn([{ id: "read-before", name: "read", arguments: { path: "README.md" } }]),
      toolTurn([
        {
          id: "write-page",
          name: "write",
          arguments: { path: "README.md", content: "# Updated fixture\n" },
        },
      ]),
      toolTurn([{ id: "read-after", name: "read", arguments: { path: "README.md" } }]),
      providerFailure(),
    ]);

    const error = await captureInferenceFailure(harness, { ...base, workflow, step });

    expect(error.evidence?.writeSettlement).toBe("write-executed");
    expect(error.evidence?.tools).toMatchObject({
      totalCalls: 3,
      byTool: [
        { name: "read", calls: 2, failures: 0 },
        { name: "write", calls: 1, failures: 0 },
      ],
    });
  });
});
