// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PiHarness,
  createAuditHarness,
  createRepository,
  resetSharedTestState,
  stepInput,
  textTurn,
  toolTurn,
  validModelConfig,
} from "./support/pi-harness-session-fixtures.js";

afterEach(resetSharedTestState);

/**
 * Pi's agent loop rebuilds each request from the transcript it retains, and
 * native Pi compaction is disabled (`pi-session.ts`), so compaction must hold
 * for every later delegated request, not only the one it was computed for.
 * This drives the real harness, governor and stream wrapper over a scripted
 * provider and asserts on the bytes delegated.
 */
describe("PiHarness compaction across real provider turns", () => {
  it("keeps compacted evidence out of every later delegated request", async () => {
    const repositoryPath = await createRepository();
    // One 16 KB result carrying a marker, plus two more so the governor has
    // enough removable groups to free the quarter of the budget it requires.
    const alphaMarker = "ALPHA-EVIDENCE-MARKER";
    await writeFile(
      resolve(repositoryPath, "big-a.md"),
      `${alphaMarker} line of documentation evidence\n`.repeat(430),
    );
    await writeFile(
      resolve(repositoryPath, "big-b.md"),
      "bravo line of documentation evidence\n".repeat(430),
    );
    await writeFile(
      resolve(repositoryPath, "big-c.md"),
      "delta line of documentation evidence\n".repeat(430),
    );
    await writeFile(resolve(repositoryPath, "small.md"), "small\n");

    const delegated: string[] = [];
    const responses = [
      toolTurn([{ id: "call_1", name: "read", arguments: { path: "big-a.md" } }], 1),
      toolTurn([{ id: "call_2", name: "read", arguments: { path: "big-b.md" } }], 2),
      toolTurn([{ id: "call_3", name: "read", arguments: { path: "big-c.md" } }], 3),
      toolTurn([{ id: "call_4", name: "read", arguments: { path: "small.md" } }], 4),
      textTurn("Review complete."),
    ];
    let index = 0;
    vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
      delegated.push(String(init?.body ?? ""));
      const response = responses[index];
      index += 1;
      if (!response) throw new Error("Unexpected provider request.");
      return response.clone();
    });

    // 14,000 usable input tokens: turns 1-3 fit, the fourth request does not.
    // The first request carries the expanded audit-documentation skill body,
    // about 2,000 estimated tokens more than the bare step prompt.
    const harness = await createAuditHarness({
      toolOutputCapBytes: 16_384,
      model: {
        ...validModelConfig,
        profile: {
          ...validModelConfig.profile,
          contextWindow: 18_096,
          maxInputTokens: 18_096,
          maxOutputTokens: 2_048,
        },
      },
    });
    const result = await harness.runStep(stepInput(repositoryPath));
    const turns = result.turns ?? [];

    expect(delegated).toHaveLength(5);

    // The third request still carries the marker; every request from the
    // compaction onwards must not, including one Pi rebuilds from its transcript.
    expect(delegated[2]).toContain(alphaMarker);
    expect(delegated[3]).not.toContain(alphaMarker);
    expect(delegated[4]).not.toContain(alphaMarker);

    const finalRequest = JSON.parse(delegated[4]!) as {
      messages: Array<Record<string, unknown>>;
    };
    expect(delegated[4]!.match(/docsfab-local-compaction-evidence/gu)).toHaveLength(1);
    expect(
      finalRequest.messages.some(
        (message) =>
          message.role === "user" && JSON.stringify(message).includes("Workflow outcome:"),
      ),
    ).toBe(true);
    const retainedResults = finalRequest.messages
      .map((message, index) => ({ message, index }))
      .filter(({ message }) => message.role === "tool");
    expect(retainedResults.length).toBeGreaterThan(0);
    for (const { message, index: resultIndex } of retainedResults) {
      const call = finalRequest.messages[resultIndex - 1];
      expect(call?.role).toBe("assistant");
      expect(JSON.stringify(call)).toContain(`"id":"${String(message.tool_call_id)}"`);
    }

    expect(turns.map((turn) => turn.decision)).toEqual([
      "proceed",
      "proceed",
      "proceed",
      "compact",
      "proceed",
    ]);

    // The estimate describes the delegated request: post-compaction requests
    // stay smaller than the one that overflowed, without a second compaction.
    expect(delegated[4]!.length).toBeLessThan(delegated[2]!.length);
    expect(turns[4]!.estimatedInputTokens).toBeLessThanOrEqual(turns[4]!.availableInputTokens!);
    expect(turns[4]!.compactions).toBe(1);
    expect(turns[4]!.maxCompactions).toBeGreaterThan(1);
  }, 120_000);
});
