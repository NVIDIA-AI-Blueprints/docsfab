// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runDelegatedTask, type DelegatedTaskResult } from "../src/delegated-task/driver.js";
import { validModelConfig } from "./helpers.js";
import { scriptedProvider, textTurn } from "./support/execution-convergence.js";
import { temporaryRoots } from "./helpers/temp.js";

const directories = temporaryRoots();
const SOURCE_QUESTION = "Which flag enables JSON output?";

afterEach(async () => {
  vi.unstubAllGlobals();
});

async function fixtureRepository(flag: string): Promise<{
  repositoryPath: string;
  agentDir: string;
}> {
  const root = await directories.create("docsfab-delegated-source-read-");
  const repositoryPath = join(root, "repo");
  const agentDir = join(root, "agent");
  await mkdir(join(repositoryPath, "docs"), { recursive: true });
  await mkdir(agentDir);
  await writeFile(join(repositoryPath, "docs", "reference.md"), `json_flag=${flag}\n`, "utf8");
  return { repositoryPath, agentDir };
}

function sseResponse(chunks: readonly object[]): Response {
  return new Response(
    [...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`), "data: [DONE]\n\n"].join(""),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

function toolReadTurn(): Response {
  return sseResponse([
    {
      id: "completion-tool-turn",
      object: "chat.completion.chunk",
      created: 1,
      model: validModelConfig.modelId,
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "read-fixture",
                type: "function",
                function: {
                  name: "read",
                  arguments: JSON.stringify({ path: "docs/reference.md" }),
                },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    {
      id: "completion-tool-turn",
      object: "chat.completion.chunk",
      created: 1,
      model: validModelConfig.modelId,
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    },
  ]);
}

function groundedReadProvider(): typeof fetch {
  let index = 0;
  return async (_input, init) => {
    index += 1;
    if (index === 1) return toolReadTurn();
    const serialized = JSON.stringify(JSON.parse(String(init?.body ?? "{}")));
    const flag = serialized.match(/json_flag=([^\s"\\]+)/u)?.[1];
    if (!flag) throw new Error("scripted model required the confined read bytes");
    const line = serialized.match(/\[source-line (\d+)\]/u)?.[1];
    if (!line) throw new Error("scripted model required source coordinates from the confined read");
    return textTurn(`The JSON output flag is ${flag} ([source-line ${line}]).`);
  };
}

async function runFixtureTask(flag: string, provider: typeof fetch): Promise<DelegatedTaskResult> {
  const { repositoryPath, agentDir } = await fixtureRepository(flag);
  vi.stubGlobal("fetch", provider);
  return runDelegatedTask({
    outcome: SOURCE_QUESTION,
    repositoryPath,
    repositoryIdentity: { canonicalPath: repositoryPath, revision: "a".repeat(40) },
    sessionLifetime: { kind: "fresh" },
    limits: { maxProviderTurns: 8, maxToolCalls: 8, timeoutMs: 15_000 },
    model: validModelConfig,
    agentDir,
  });
}

function sourceReadOracle(result: DelegatedTaskResult, flag: string): void {
  const readCall = result.transcript.find(
    (entry) => entry.kind === "tool-call" && entry.name === "read",
  );
  const readResult = result.transcript.find(
    (entry) => entry.kind === "tool-result" && entry.name === "read" && entry.isError === false,
  );
  expect(result.status).toBe("completed");
  expect(readCall?.afterTaskStart).toBe(true);
  expect(readCall?.arguments).toEqual({ path: "docs/reference.md" });
  expect(readResult?.text).toContain(`[source-line 1] json_flag=${flag}`);
  expect(result.answer).toContain(flag);
  expect(result.answer).toMatch(/\[source-line \d+\]/u);
}

describe("delegated-task confined source-read fixture", () => {
  it("answers json_flag from the actual confined read of docs/reference.md", async () => {
    const result = await runFixtureTask("--json", groundedReadProvider());
    sourceReadOracle(result, "--json");
  }, 20_000);

  it("changes the answer when the fixture fact changes", async () => {
    const result = await runFixtureTask("--yaml", groundedReadProvider());
    sourceReadOracle(result, "--yaml");
    expect(result.answer).not.toContain("--json");
  }, 20_000);

  it("does not pass a model that skips the confined read tool", async () => {
    const result = await runFixtureTask(
      "--json",
      scriptedProvider([textTurn("The JSON output flag is --json ([source-line 1]).")]),
    );
    expect(result.transcript.some((entry) => entry.name === "read")).toBe(false);
    expect(() => sourceReadOracle(result, "--json")).toThrow();
  }, 20_000);
});
