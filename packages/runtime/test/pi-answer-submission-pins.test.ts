// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Pins on the Pi behavior the tool-call answer path (#1707) is built on, so a
 * Pi upgrade that changes one fails here first: raw `toolcall_delta` text,
 * no execution of a length-stopped message's calls, the root-type refusal
 * before `beforeToolCall`, the lenient argument parse, and the typed shell's
 * coercion. Each is a reason the host decodes the raw text itself.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { createModelConnection } from "../src/model/provider.js";
import { validModelConfig } from "./helpers.js";
import {
  captureInferenceFailure,
  createRepository,
  resetSharedTestState,
} from "./support/pi-harness-session-fixtures.js";
import {
  SUBMIT,
  qualityStepInput,
  rawToolCallTurn,
  recordingProvider,
  submissionCall,
  toolPathHarness,
} from "./support/answer-submission-fixtures.js";

afterEach(resetSharedTestState);

const piRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));

async function piAi(): Promise<{
  parseStreamingJson: (text: string) => unknown;
  validateToolArguments: (
    tool: { name: string; parameters: unknown },
    call: { name: string; arguments: unknown },
  ) => unknown;
}> {
  for (const base of piRequire.resolve.paths("@earendil-works/pi-ai") ?? []) {
    const directory = join(base, "@earendil-works/pi-ai");
    if (existsSync(join(directory, "package.json"))) {
      return import(pathToFileURL(join(directory, "dist/index.js")).href);
    }
  }
  throw new Error("Pi dependency @earendil-works/pi-ai is not installed.");
}

describe("Pi behavior the tool-call answer path relies on", () => {
  it("streams each tool call's raw argument fragments as toolcall_delta text", async () => {
    const raw = ['{"evaluation":{"a":1,', '"a":2},"qualityScore":null}'];
    recordingProvider([rawToolCallTurn([{ id: "call-1", name: SUBMIT, chunks: raw }])]);
    const connection = await createModelConnection(validModelConfig);
    const stream = connection.runtime.streamSimple(
      connection.model,
      {
        systemPrompt: "Probe.",
        messages: [{ role: "user", content: "Call the tool.", timestamp: 1 }],
        tools: [
          {
            name: SUBMIT,
            description: "Submit.",
            parameters: { type: "object", properties: { evaluation: {} } } as never,
          },
        ],
      },
      { maxTokens: 64 },
    );
    const deltas: string[] = [];
    let ended: Record<string, unknown> | undefined;
    for await (const event of stream as AsyncIterable<Record<string, any>>) {
      if (event.type === "toolcall_delta") deltas.push(event.delta);
      if (event.type === "toolcall_end") ended = event.toolCall;
    }
    expect(deltas.join("")).toBe(raw.join(""));
    // Pi keeps only its lenient parse and drops its own copy of the text.
    expect(ended).not.toHaveProperty("partialArgs");
    expect(ended?.arguments).toEqual({ evaluation: { a: 2 }, qualityScore: null });
  });

  it("parses arguments leniently: a duplicate dropped, a raw line break kept, a trailing brace accepted", async () => {
    const { parseStreamingJson } = await piAi();
    expect(parseStreamingJson('{"a":1,"a":2}')).toEqual({ a: 2 });
    expect(parseStreamingJson('{"a":"x\ny"}')).toEqual({ a: "x\ny" });
    expect(parseStreamingJson('{"a":1}}')).toEqual({ a: 1 });
  });

  it("coerces a typed shell's members: false and an empty string become null", async () => {
    const { validateToolArguments } = await piAi();
    const tool = {
      name: SUBMIT,
      parameters: {
        type: "object",
        properties: { evaluation: { type: "object" }, qualityScore: { type: ["object", "null"] } },
      },
    };
    expect(
      validateToolArguments(tool, {
        name: SUBMIT,
        arguments: { evaluation: {}, qualityScore: false },
      }),
    ).toEqual({ evaluation: {}, qualityScore: null });
    expect(
      validateToolArguments(tool, {
        name: SUBMIT,
        arguments: { evaluation: {}, qualityScore: "" },
      }),
    ).toEqual({ evaluation: {}, qualityScore: null });
  });

  it("refuses a non-object root before beforeToolCall and never runs a length-stopped call", async () => {
    for (const [raw, finishReason] of [
      ["[1,2]", "tool_calls"],
      ['{"evaluation":{"a":1},"qualityScore":null}', "length"],
    ] as const) {
      const repositoryPath = await createRepository();
      const input = await qualityStepInput(repositoryPath);
      recordingProvider([rawToolCallTurn([submissionCall("submit-1", raw)], { finishReason })]);
      const seen: string[] = [];

      const error = await captureInferenceFailure(
        toolPathHarness({
          beforeToolCall: async (context) => {
            seen.push(context.toolCall.name);
            return undefined;
          },
        }),
        input,
      );

      expect(seen).toEqual([]);
      expect(error.evidence?.tools?.byTool.find((tool) => tool.name === SUBMIT)).toBeUndefined();
    }
  }, 60_000);
});
