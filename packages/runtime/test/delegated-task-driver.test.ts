// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DELEGATED_TASK_DEADLINE_CLOCK_ANOMALY,
  DELEGATED_TASK_DEADLINE_REMEDIATION,
  DELEGATED_TASK_LIMITS_ERROR,
  DELEGATED_TASK_RESULT_KIND,
  DELEGATED_TASK_UNSUPPORTED_HOST,
  WORKFLOW_DEADLINE_EXCEEDED,
  runDelegatedTask,
  type DelegatedTaskLimits,
  type RunDelegatedTaskInput,
} from "../src/delegated-task/driver.js";
import { WORKFLOW_CANCELLED } from "../src/execution/cancellation.js";
import { TaskReconciliationError } from "../src/execution/task-reconciliation.js";
import { createLiveAgentToolDefinitions } from "../src/live-agent/capabilities.js";
import { validModelConfig } from "./helpers.js";
import { textTurn } from "./support/execution-convergence.js";
import { temporaryRoots } from "./helpers/temp.js";

const directories = temporaryRoots();
const SOURCE_QUESTION = "Which flag enables JSON output?";
const LIMITS: DelegatedTaskLimits = {
  maxProviderTurns: 8,
  maxToolCalls: 8,
  timeoutMs: 15_000,
};

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function repositoryFixture(flag = "--json"): Promise<{
  repositoryPath: string;
  agentDir: string;
}> {
  const root = await directories.create("docsfab-delegated-driver-");
  const repositoryPath = join(root, "repo");
  const agentDir = join(root, "agent");
  await mkdir(join(repositoryPath, "docs"), { recursive: true });
  await mkdir(agentDir);
  await writeFile(join(repositoryPath, "docs", "reference.md"), `json_flag=${flag}\n`, "utf8");
  return { repositoryPath, agentDir };
}

function toolTurn(path: string): Response {
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
                id: "read-1",
                type: "function",
                function: { name: "read", arguments: JSON.stringify({ path }) },
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

function sseResponse(chunks: readonly object[]): Response {
  return new Response(
    [...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`), "data: [DONE]\n\n"].join(""),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

function groundedReadProvider(bodies: unknown[] = []): typeof fetch {
  let index = 0;
  return async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    bodies.push(body);
    index += 1;
    if (index === 1) return toolTurn("docs/reference.md");
    const serialized = JSON.stringify(body);
    const flag = serialized.match(/json_flag=([^\s"\\]+)/u)?.[1];
    if (!flag) throw new Error("scripted model required the confined read result");
    const line = serialized.match(/\[source-line (\d+)\]/u)?.[1] ?? "1";
    return textTurn(`The JSON output flag is ${flag} ([source-line ${line}]).`);
  };
}

function constructionProbes() {
  return {
    createConnection: vi.fn(async () => {
      throw new Error("provider construction must not run");
    }),
    createConfinedToolSet: vi.fn(async () => {
      throw new Error("tool construction must not run");
    }),
    createSession: vi.fn(async () => {
      throw new Error("session construction must not run");
    }),
  };
}

function closedInput(
  overrides: Partial<RunDelegatedTaskInput> & Pick<RunDelegatedTaskInput, "limits">,
): RunDelegatedTaskInput {
  const unused = resolve("/tmp/docsfab-delegated-unused-repo");
  return {
    outcome: SOURCE_QUESTION,
    repositoryPath: unused,
    repositoryIdentity: { canonicalPath: unused, revision: "a".repeat(40) },
    sessionLifetime: { kind: "fresh" },
    model: validModelConfig,
    ...constructionProbes(),
    ...overrides,
  };
}

async function runReadOnlyTask(
  options: {
    flag?: string;
    provider?: typeof fetch;
    bodies?: unknown[];
    signal?: AbortSignal;
    wrapToolExecute?: RunDelegatedTaskInput["wrapToolExecute"];
    persistChildRun?: RunDelegatedTaskInput["persistChildRun"];
    presentation?: RunDelegatedTaskInput["presentation"];
    priorSession?: boolean;
    limits?: DelegatedTaskLimits;
    capabilities?: RunDelegatedTaskInput["capabilities"];
  } = {},
) {
  const { repositoryPath, agentDir } = await repositoryFixture(options.flag);
  if (options.priorSession) {
    const sessions = join(agentDir, "live-sessions");
    await mkdir(sessions);
    const prior = SessionManager.create(repositoryPath, sessions);
    prior.appendMessage({
      role: "user",
      content: "Remember this DocsFab conversation. PRIOR_GRANT_TOKEN",
      timestamp: Date.now(),
    });
    prior.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "I will remember the prior grant." }],
      timestamp: Date.now(),
    } as never);
  }
  const bodies = options.bodies ?? [];
  vi.stubGlobal("fetch", options.provider ?? groundedReadProvider(bodies));
  const persistChildRun = options.persistChildRun ?? vi.fn(async () => undefined);
  const result = await runDelegatedTask({
    outcome: SOURCE_QUESTION,
    repositoryPath,
    repositoryIdentity: { canonicalPath: repositoryPath, revision: "a".repeat(40) },
    sessionLifetime: { kind: "fresh" },
    limits: options.limits ?? LIMITS,
    model: validModelConfig,
    agentDir,
    persistChildRun,
    signal: options.signal,
    wrapToolExecute: options.wrapToolExecute,
    presentation: options.presentation,
    ...(options.capabilities ? { capabilities: options.capabilities } : {}),
  });
  return { result, bodies, persistChildRun, repositoryPath };
}

describe("delegated-task driver", () => {
  it("creates one fresh session without continue-most-recent or prior grant leakage", async () => {
    const continueRecent = vi.spyOn(SessionManager, "continueRecent");
    const bodies: unknown[] = [];
    const { result } = await runReadOnlyTask({ priorSession: true, bodies });
    expect(continueRecent).not.toHaveBeenCalled();
    expect(result.status).toBe("completed");
    const serialized = JSON.stringify(bodies);
    expect(serialized).not.toContain("Remember this DocsFab conversation");
    expect(serialized).not.toContain("PRIOR_GRANT_TOKEN");
    expect(serialized).not.toContain("I will remember the prior grant");
  }, 20_000);

  it("lists no Pi skills, so no installed skill directory reaches the provider", async () => {
    const skillRoot = await directories.create("docsfab-delegated-skill-");
    const directory = join(skillRoot, "fixture-skill");
    await mkdir(directory);
    await writeFile(
      join(directory, "SKILL.md"),
      "---\nname: fixture-skill\ndescription: Fixture skill for the delegated driver.\n---\n\nFixture body.\n",
    );
    const bodies: unknown[] = [];
    const { result } = await runReadOnlyTask({
      bodies,
      capabilities: {
        skills: [{ lock: { id: "fixture-skill" } as never, directory }],
        qualityPack: {} as never,
        workflows: [],
      },
    });
    expect(result.status).toBe("completed");
    const first = JSON.stringify(bodies[0]);
    expect(first).toContain("Installed skills: fixture-skill.");
    expect(first).not.toContain("<available_skills>");
    expect(first).not.toContain(skillRoot);
  }, 20_000);

  it("completes the read-only task on non-TTY streams without a You: prompt", async () => {
    const input = Object.assign(new PassThrough(), { isTTY: false });
    const output = Object.assign(new PassThrough(), { isTTY: false });
    const rendered: string[] = [];
    output.on("data", (chunk) => rendered.push(String(chunk)));
    const { result } = await runReadOnlyTask({
      presentation: {
        onText: (text) => {
          output.write(text);
        },
      },
    });
    input.end();
    expect(result.kind).toBe(DELEGATED_TASK_RESULT_KIND);
    expect(result.status).toBe("completed");
    expect(result.answer).toContain("--json");
    expect(rendered.join("")).not.toContain("You:");
    expect(result).not.toHaveProperty("schemaVersion");
  }, 20_000);

  it.each([
    ["undefined limits", undefined],
    ["zero maxProviderTurns", { maxProviderTurns: 0, maxToolCalls: 4, timeoutMs: 1_000 }],
    ["negative maxToolCalls", { maxProviderTurns: 4, maxToolCalls: -1, timeoutMs: 1_000 }],
    ["NaN timeoutMs", { maxProviderTurns: 4, maxToolCalls: 4, timeoutMs: Number.NaN }],
    [
      "Infinity maxProviderTurns",
      { maxProviderTurns: Number.POSITIVE_INFINITY, maxToolCalls: 4, timeoutMs: 1_000 },
    ],
  ] as const)("fails closed for %s before construction", async (_title, limits) => {
    const probes = constructionProbes();
    await expect(runDelegatedTask(closedInput({ limits, ...probes }))).rejects.toThrow(
      DELEGATED_TASK_LIMITS_ERROR,
    );
    expect(probes.createConnection).not.toHaveBeenCalled();
    expect(probes.createConfinedToolSet).not.toHaveBeenCalled();
    expect(probes.createSession).not.toHaveBeenCalled();
  });

  it("fails closed for a host-advertised unsupported mode before construction", async () => {
    const probes = constructionProbes();
    await expect(
      runDelegatedTask(closedInput({ limits: LIMITS, host: { mode: "experimental" }, ...probes })),
    ).rejects.toThrow(DELEGATED_TASK_UNSUPPORTED_HOST);
    expect(probes.createConnection).not.toHaveBeenCalled();
    expect(probes.createConfinedToolSet).not.toHaveBeenCalled();
    expect(probes.createSession).not.toHaveBeenCalled();
  });

  it("fails closed for a host-advertised unsupported composition before construction", async () => {
    const probes = constructionProbes();
    await expect(
      runDelegatedTask(
        closedInput({
          limits: LIMITS,
          host: { composition: "no-such-composition" },
          ...probes,
        }),
      ),
    ).rejects.toThrow(DELEGATED_TASK_UNSUPPORTED_HOST);
    expect(probes.createConnection).not.toHaveBeenCalled();
    expect(probes.createConfinedToolSet).not.toHaveBeenCalled();
    expect(probes.createSession).not.toHaveBeenCalled();
  });

  it("cancels an in-flight confined read, awaits teardown, and retains partial evidence", async () => {
    const abort = new AbortController();
    let readStarted!: () => void;
    const started = new Promise<void>((resolveStarted) => {
      readStarted = resolveStarted;
    });
    const hang = new Promise<never>(() => undefined);
    const { result } = await (async () => {
      const running = runReadOnlyTask({
        signal: abort.signal,
        wrapToolExecute:
          (name, execute) =>
          async (...args) => {
            if (name === "read") {
              readStarted();
              await hang;
            }
            return execute(...args);
          },
      });
      await started;
      abort.abort();
      return running;
    })();
    expect(result.status).toBe("cancelled");
    expect(result.kind).toBe(DELEGATED_TASK_RESULT_KIND);
    expect(
      result.transcript.some((entry) => entry.kind === "tool-call" && entry.name === "read"),
    ).toBe(true);
    expect(result.transcript.some((entry) => entry.afterTaskStart)).toBe(true);
    expect(result.error).toBeDefined();
    // Unlike the deadline fixture below, an operator abort carries the fixed
    // cancellation diagnostic and no DocsFab deadline code or limit.
    expect(result.error).toContain(WORKFLOW_CANCELLED);
    expect(result.code).toBeUndefined();
    expect(result.limitStop).toBeUndefined();
  }, 20_000);

  it("stops at its own wall-clock deadline with a coded limit, never as a cancellation", async () => {
    let readStarted!: () => void;
    const started = new Promise<void>((resolveStarted) => {
      readStarted = resolveStarted;
    });
    const hang = new Promise<never>(() => undefined);
    const { result } = await runReadOnlyTask({
      // No AbortSignal exists here, so a `cancelled` status would be fabricated.
      limits: { ...LIMITS, timeoutMs: 250 },
      wrapToolExecute:
        (name, execute) =>
        async (...args) => {
          if (name === "read") {
            readStarted();
            await hang;
          }
          return execute(...args);
        },
    });
    await started;
    expect(result.status).toBe("timed-out");
    expect(result.status).not.toBe("cancelled");
    expect(result.code).toBe(WORKFLOW_DEADLINE_EXCEEDED);
    expect(result.limitStop?.limit).toBe("delegatedTask.timeoutMs");
    expect(result.limitStop?.disposition).toBe("stopped");
    expect(result.limitStop?.configured).toBe(250);
    expect(result.limitStop?.observed).toBeGreaterThanOrEqual(250);
    expect(result.error).toContain("DocsFab stopped this run at the operational limit");
    expect(result.error).toContain("delegatedTask.timeoutMs");
    expect(result.error).toContain("limit 250 ms");
    expect(result.error).toContain(DELEGATED_TASK_DEADLINE_REMEDIATION);
    expect(result.error).not.toContain(WORKFLOW_CANCELLED);
  }, 20_000);

  it("returns a coded clock anomaly instead of throwing out of the deadline timer", async () => {
    // Force the monotonic source to report no progress: the bound cannot state
    // how long it waited, so it must not claim a deadline, and the refusal must
    // not escape the timer callback as an uncaughtException (no result document).
    const uncaught: unknown[] = [];
    const captureUncaught = (error: unknown): void => {
      uncaught.push(error);
    };
    process.on("uncaughtException", captureUncaught);
    const reads = [Number.MAX_SAFE_INTEGER];
    const nowSpy = vi.spyOn(performance, "now").mockImplementation(() => reads.shift() ?? 0);
    try {
      let readStarted!: () => void;
      const started = new Promise<void>((resolveStarted) => {
        readStarted = resolveStarted;
      });
      const hang = new Promise<never>(() => undefined);
      const { result } = await runReadOnlyTask({
        limits: { ...LIMITS, timeoutMs: 250 },
        wrapToolExecute:
          (name, execute) =>
          async (...args) => {
            if (name === "read") {
              readStarted();
              await hang;
            }
            return execute(...args);
          },
      });
      await started;
      expect(uncaught).toEqual([]);
      expect(result.kind).toBe(DELEGATED_TASK_RESULT_KIND);
      expect(result.status).toBe("failed");
      expect(result.status).not.toBe("cancelled");
      expect(result.status).not.toBe("timed-out");
      expect(result.code).toBeUndefined();
      expect(result.error).toContain(DELEGATED_TASK_DEADLINE_CLOCK_ANOMALY);
      expect(result.error).not.toContain(WORKFLOW_CANCELLED);
      expect(result.limitStop).toBeUndefined();
    } finally {
      nowSpy.mockRestore();
      process.off("uncaughtException", captureUncaught);
    }
  }, 20_000);

  it("creates no workflow RunRecord for direct work", async () => {
    const { result, persistChildRun } = await runReadOnlyTask();
    expect(result.status).toBe("completed");
    expect(result.childWorkflows).toEqual([]);
    expect(persistChildRun).not.toHaveBeenCalled();
    expect(result.kind).toBe(DELEGATED_TASK_RESULT_KIND);
    expect(result).not.toHaveProperty("schemaVersion");
    expect(result).not.toHaveProperty("workflow");
    expect(result).not.toHaveProperty("steps");
  }, 20_000);

  it("guards child-workflow dispatch through the live-agent seam the driver uses", async () => {
    const driverSource = readFileSync(resolve("src/delegated-task/driver.ts"), "utf8");
    expect(driverSource).toContain("assertTaskResultChangeAdmitted");
    expect(driverSource).toContain("resultChange: input.resultChange");
    const runWorkflow = vi.fn(async () => {
      throw new Error("must not dispatch a revoked child");
    });
    const tools = createLiveAgentToolDefinitions({
      capabilities: {
        skills: [],
        qualityPack: {} as never,
        workflows: [{ name: "review-documentation", title: "Review documentation" }],
      },
      resultChange: { accessRevoked: true },
      runWorkflow,
    });
    const workflow = tools.find((tool) => tool.name === "docsfab_run_workflow");
    expect(workflow).toBeDefined();
    await expect(
      workflow!.execute(
        "revoked-child",
        { workflow: "review-documentation", instruction: "Review the CLI guide." },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toBeInstanceOf(TaskReconciliationError);
    expect(runWorkflow).not.toHaveBeenCalled();
  });
});
