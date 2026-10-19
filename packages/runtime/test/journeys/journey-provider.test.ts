// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The journey provider and budget: every refusal is written to the ledger by
 * its own code before it is thrown, the settle check fails on a refusal or an
 * unconsumed turn, and the journey budget comes from the limits table.
 */
import { describe, expect, it, vi } from "vitest";

import { LIMIT_DEFINITION_BY_NAME } from "../../src/config/limits.generated.js";
import { validModelConfig } from "../helpers.js";
import { temporaryRoots } from "../helpers/temp.js";
import {
  createJourneyFixture,
  JOURNEY_TIMEOUT_LIMIT,
  journeyProviders,
  journeyTestTimeoutMs,
  runJourney,
} from "../support/journey.js";
import {
  assertJourneyProviderSettled,
  callTools,
  journeyProvider,
  JourneyProviderUnsettledError,
  reply,
  type JourneyProvider,
} from "../support/journey-provider.js";

const READ = { id: "read", name: "docsfab_read_source", arguments: {} };
const roots = temporaryRoots();
const provider = journeyProviders();

/** One provider request offering exactly these tool names. */
function send(
  provider: JourneyProvider,
  offered: readonly string[],
  url = validModelConfig.baseUrl,
) {
  return provider.fetch(`${url}/chat/completions`, {
    method: "POST",
    body: JSON.stringify({
      tools: offered.map((name) => ({ type: "function", function: { name } })),
      messages: [{ role: "user", content: "scripted journey request" }],
    }),
  });
}

function settleError(provider: JourneyProvider): JourneyProviderUnsettledError {
  try {
    assertJourneyProviderSettled(provider);
  } catch (error) {
    if (error instanceof JourneyProviderUnsettledError) return error;
    throw error;
  }
  throw new Error("expected the journey provider to be unsettled");
}

describe("journey provider ledger", () => {
  it("admits a tool call only when the request offered that exact name", async () => {
    const offered = journeyProvider([callTools([READ])]);
    const response = await send(offered, ["docsfab_list_sources", "docsfab_read_source"]);
    expect(response.status).toBe(200);
    expect(offered.ledger).toEqual([]);
    expect(() => assertJourneyProviderSettled(offered)).not.toThrow();

    for (const tools of [
      ["docsfab_list_sources"],
      ["docsfab_read"],
      ["docsfab_read_source_window"],
    ]) {
      const refused = journeyProvider([callTools([READ])]);
      await expect(send(refused, tools)).rejects.toThrow(
        "journey provider refused request 0: journey-tool-not-offered",
      );
      expect(refused.ledger, tools.join(",")).toEqual([
        { code: "journey-tool-not-offered", requestIndex: 0, toolName: "docsfab_read_source" },
      ]);
      expect(settleError(refused).message).toBe(
        "journey-provider-refused: journey-tool-not-offered:docsfab_read_source@0",
      );
    }
  });

  it("records a request past the script as exhausted, and settles on the exact script", async () => {
    const exact = journeyProvider([reply("first"), reply("second")]);
    await send(exact, []);
    await send(exact, []);
    expect(() => assertJourneyProviderSettled(exact)).not.toThrow();

    const extra = journeyProvider([reply("only")]);
    await send(extra, []);
    await expect(send(extra, [])).rejects.toThrow(
      "journey provider refused request 1: journey-script-exhausted",
    );
    expect(extra.ledger).toEqual([{ code: "journey-script-exhausted", requestIndex: 1 }]);
    expect(settleError(extra).message).toBe("journey-provider-refused: journey-script-exhausted@1");
  });

  it("fails the settle check when a scripted turn was never consumed", async () => {
    const short = journeyProvider([reply("first"), reply("second")]);
    await send(short, []);
    expect(short.ledger).toEqual([]);
    const error = settleError(short);
    expect(error.message).toBe("journey-turns-unconsumed: 1 of 2 scripted turns consumed");
    expect(error).toMatchObject({ consumedTurns: 1, turnCount: 2 });
  });

  it("records a turn that cannot read its request, and a request to another endpoint", async () => {
    const failing = journeyProvider([
      callTools((request) => {
        request.toolResultJson("absent-call");
        return [READ];
      }),
    ]);
    await expect(send(failing, ["docsfab_read_source"])).rejects.toThrow(
      "journey provider refused request 0: journey-turn-failed",
    );
    expect(failing.ledger).toEqual([
      {
        code: "journey-turn-failed",
        requestIndex: 0,
        detail: "no tool result answers call absent-call",
      },
    ]);

    const elsewhere = journeyProvider([reply("unused")]);
    await expect(send(elsewhere, [], "https://forge.invalid")).rejects.toThrow(
      "journey provider refused request 0: journey-unexpected-endpoint",
    );
    expect(elsewhere.ledger).toEqual([
      {
        code: "journey-unexpected-endpoint",
        requestIndex: 0,
        detail: "https://forge.invalid/chat/completions",
      },
    ]);
    expect(elsewhere.consumed()).toBe(0);
  });

  it("records a request body that is not JSON by its own code, not as a turn failure", async () => {
    const garbled = journeyProvider([reply("unused")]);
    await expect(
      garbled.fetch(`${validModelConfig.baseUrl}/chat/completions`, {
        method: "POST",
        body: "{not json",
      }),
    ).rejects.toThrow("journey provider refused request 0: journey-request-unparseable");
    expect(garbled.ledger).toMatchObject([
      { code: "journey-request-unparseable", requestIndex: 0 },
    ]);
    expect(garbled.requests).toEqual([]);
    expect(garbled.consumed()).toBe(0);
    expect(settleError(garbled).message).toBe(
      "journey-provider-refused: journey-request-unparseable@0",
    );
  });
});

describe("journey runner", () => {
  it("refuses a --dry-run argv, which returns no run record, without calling the model", async () => {
    const fixture = await createJourneyFixture("greeter", roots);
    const unused = provider([]);
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await expect(
        runJourney({
          fixture,
          provider: unused,
          argv: [
            "review-documentation",
            "--repo",
            fixture.repository,
            "--instruction",
            "Review the committed documentation.",
            "--dry-run",
          ],
        }),
      ).rejects.toThrow("journey run returned no record: a --dry-run argv runs no journey");
    } finally {
      output.mockRestore();
    }
    expect(unused.requests).toEqual([]);
  });
});

describe("journey budget", () => {
  const declared = LIMIT_DEFINITION_BY_NAME[JOURNEY_TIMEOUT_LIMIT]!;

  it("reads the declared millisecond entry from the limits table", () => {
    expect(declared.unit).toBe("ms");
    expect(journeyTestTimeoutMs({})).toBe(declared.value);
    const injected = { [JOURNEY_TIMEOUT_LIMIT]: { value: declared.value + 1, unit: "ms" } };
    expect(journeyTestTimeoutMs({}, injected)).toBe(declared.value + 1);
    const ciFloor = LIMIT_DEFINITION_BY_NAME["test.ciTimeoutMs"]!.value;
    expect(journeyTestTimeoutMs({ CI: "true" }, injected)).toBe(
      Math.max(declared.value + 1, ciFloor),
    );
  });

  it("refuses an absent entry or one not in milliseconds", () => {
    expect(() => journeyTestTimeoutMs({}, {})).toThrow(
      expect.objectContaining({
        name: "JourneyBudgetError",
        code: "journey-budget-missing",
        message: `Journey budget ${JOURNEY_TIMEOUT_LIMIT} is missing from the generated limits mirror; declare it in config/limits/test.yaml and run npm run generate:limits.`,
      }),
    );
    expect(() =>
      journeyTestTimeoutMs({}, { [JOURNEY_TIMEOUT_LIMIT]: { value: declared.value, unit: "s" } }),
    ).toThrow(
      expect.objectContaining({
        name: "JourneyBudgetError",
        code: "journey-budget-unit",
        message: `Journey budget ${JOURNEY_TIMEOUT_LIMIT} must use unit ms, found s.`,
      }),
    );
  });
});
