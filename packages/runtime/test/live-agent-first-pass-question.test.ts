// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DocsFabConfig } from "../src/config/runtime-loader.js";
import {
  assembleLiveAgentHost,
  liveAgentWorkflowRunRequest,
  runTerminalConversation,
} from "../src/live-agent/host.js";
import {
  LIVE_DELIVERY_FAILURES,
  LiveWorkflowDelivery,
} from "../src/live-agent/workflow-delivery.js";
import type { RunRecord } from "../src/records/contracts.js";
import { firstPassContradictionRecord } from "../src/cli/run/first-pass-contradiction-stop.js";
import { firstPassContradictionAdmission } from "../src/records/first-pass-contradiction-admission.js";
import { configureCredential } from "./helpers/configured-credential.js";
import { installedLiveAgentCapabilities } from "./support/live-agent-installed-capabilities.js";
const exec = promisify(execFile);
const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const roots: string[] = [];
const ORIGINAL = "# Quickstart\n\nThe default name is world.\n";
type SeamInput = Parameters<typeof liveAgentWorkflowRunRequest>[0] & Record<string, unknown>;
type Seam = (input: SeamInput) => Promise<RunRecord>;
type Tool = { name: string; execute: (...arguments_: any[]) => Promise<any> };
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function git(cwd: string, args: string[]): Promise<string> {
  const result = await exec("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
  });
  return result.stdout.trim();
}

async function fixture(): Promise<{ repositoryPath: string; config: DocsFabConfig }> {
  const root = await mkdtemp(join(tmpdir(), "docsfab-live-failure-gate-"));
  roots.push(root);
  const repositoryPath = join(root, "repo");
  await mkdir(join(repositoryPath, "docs"), { recursive: true });
  await git(repositoryPath, ["init", "-q", "-b", "topic"]);
  await git(repositoryPath, ["config", "user.name", "DocsFab Fixture"]);
  await git(repositoryPath, ["config", "user.email", "fixture@example.test"]);
  await git(repositoryPath, ["config", "core.hooksPath", "/dev/null"]);
  await writeFile(join(repositoryPath, "docs", "quickstart.md"), ORIGINAL);
  await git(repositoryPath, ["add", "docs/quickstart.md"]);
  await git(repositoryPath, ["commit", "-qm", "Fixture base"]);
  const config = {
    projectRoot: runtimeRoot,
    stateDirectory: join(root, "state"),
    model: { provider: "none", model: "none" },
  } as unknown as DocsFabConfig;
  return { repositoryPath, config };
}

/** The live host exactly as `runLiveAgent` assembles it, with only the bounded run substituted. */
async function liveHost(
  seam: Seam,
  options: {
    environment?: NodeJS.ProcessEnv;
    allowWrite?: boolean;
  } = {},
) {
  const { repositoryPath, config } = await fixture();
  const runs = vi.fn(seam);
  const confirm = vi.fn(async () => true);
  const host = await assembleLiveAgentHost({
    repositoryPath,
    allowWrite: options.allowWrite ?? true,
    environment: { PATH: process.env.PATH, ...options.environment },
    config,
    capabilities: await installedLiveAgentCapabilities([
      "update-documentation",
      "create-documentation",
      "review-documentation",
    ]),
    sourcePorts: {} as never,
    onNotice: () => undefined,
    writeError: () => undefined,
    runWorkflow: runs as never,
  });
  host.terminalOptions.setPublicationConfirmation?.(confirm);
  const tools = host.customTools as unknown as Tool[];
  const find = (name: string) => {
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`Missing tool ${name}`);
    return tool;
  };
  const turn = (message: string) => {
    const replaced = host.terminalOptions.resolveChoice?.(message);
    host.terminalOptions.onUserTurn?.(message);
    return replaced;
  };
  const workflow = (
    instruction: string,
    context?: string,
    id = "update-documentation",
    extra: Record<string, unknown> = {},
  ) =>
    find("docsfab_run_workflow").execute(
      "workflow",
      { workflow: id, instruction, ...(context ? { context } : {}), ...extra },
      undefined,
      undefined,
      {} as never,
    );
  const write = (content: string, path = "docs/quickstart.md") =>
    find("write").execute("write", { path, content }, undefined, undefined, {} as never);
  const content = () => readFile(join(repositoryPath, "docs", "quickstart.md"), "utf8");
  return {
    host,
    runs,
    confirm,
    turn,
    workflow,
    write,
    content,
    repositoryPath,
    config,
  };
}

function stopped(value = "friend", path = "src/sprout.mjs"): RunRecord {
  return {
    id: "run-contradiction",
    workflow: "create-documentation",
    status: "needs-input",
    repository: { revision: "a".repeat(40) },
    steps: [],
    firstPassContradiction: firstPassContradictionRecord([
      {
        obligationId: "default-name",
        targetPaths: ["docs/cli-reference.md"],
        condition: "default name",
        sides: [
          { path, lineStart: 7, lineEnd: 7, value },
          { path: "docs/source.md", lineStart: 11, lineEnd: 12, value: "world" },
        ],
      },
    ]),
  } as unknown as RunRecord;
}
async function assertDirectChangesBlocked(live: Awaited<ReturnType<typeof liveHost>>) {
  expect(live.host.workflowFailure.blocking).toMatchObject({
    kind: "run",
    runId: "run-contradiction",
    status: "needs-input",
  });
  expect(live.host.workflowFailure.blocking).not.toHaveProperty("firstPassContradictionQuestion");
  const tools = live.host.customTools as unknown as Tool[];
  for (const [name, args] of [
    ["write", { path: "docs/quickstart.md", content: "unguarded fallback\n" }],
    ["edit", { path: "docs/quickstart.md", edits: [{ oldText: "world", newText: "friend" }] }],
    ["bash", { command: "printf 'unguarded fallback\\n' > docs/quickstart.md" }],
  ] as const) {
    const tool = tools.find((candidate) => candidate.name === name)!;
    await expect(tool.execute(name, args, undefined, undefined, {} as never)).rejects.toThrow(
      "blocked this direct change",
    );
  }
  expect(await live.content()).toBe(ORIGINAL);
  expect(live.confirm).not.toHaveBeenCalled();
}
const REQUEST =
  "Create docs/cli-reference.md from src/sprout.mjs. Keep the result local; do not commit, push, or open an MR.";
describe("live-agent saved first-pass contradiction question", () => {
  it.each([
    ["legacy", "Use the implementation"],
    ["legacy", "Withhold the disputed section until the sources agree"],
    ["external", "Use the implementation"],
    ["external", "Withhold the disputed section until the sources agree"],
    ["repository-only", "Use the implementation"],
    ["repository-only", "Withhold the disputed section until the sources agree"],
  ] as const)(
    "routes the %s stop's %s reply by its choice availability",
    async (admission, reply) => {
      const record = stopped();
      if (admission !== "legacy") {
        record.firstPassContradictionAdmission = firstPassContradictionAdmission({
          runId: record.id,
          repositoryRevision: "a".repeat(40),
          instruction: REQUEST,
          contradiction: record.firstPassContradiction,
          ...(admission === "external" ? { sourcePaths: ["src/sprout.mjs"] } : {}),
        });
      }
      const live = await liveHost(async () => record);
      live.turn(REQUEST);
      const result = await live.workflow(REQUEST, undefined, "create-documentation");
      const eligible = admission === "repository-only";
      expect(result.details.firstPassChoiceAvailable ?? false).toBe(eligible);
      expect(live.host.terminalOptions.hasPendingFirstPassChoice?.()).toBe(eligible);
      expect(live.host.workflowFailure.blocking?.status).toBe("needs-input");
      await expect(live.write("bypass before the next turn\n")).rejects.toThrow(
        "blocked this direct change",
      );
      const input = new PassThrough();
      const output = new PassThrough();
      const prompt = vi.fn(async () => undefined);
      const plan = vi.fn((message: string) =>
        live.host.terminalOptions.planFirstPassChoiceTurn!(message),
      );
      const done = runTerminalConversation(
        { sessionFile: undefined, subscribe: () => () => {}, abort: async () => {}, prompt },
        input,
        output,
        {
          ...live.host.terminalOptions,
          environment: { NO_COLOR: "1" },
          planFirstPassChoiceTurn: plan,
        },
      );
      input.write(`${reply}\n`);
      await vi.waitFor(() => expect(prompt.mock.calls.length + plan.mock.calls.length).toBe(1));
      input.end();
      await done;
      expect(prompt).toHaveBeenCalledTimes(eligible ? 0 : 1);
      expect(plan).toHaveBeenCalledTimes(eligible ? 1 : 0);
      expect(live.runs).toHaveBeenCalledTimes(1);
      if (eligible) {
        expect(live.host.workflowFailure.blocking?.status).toBe("needs-input");
      } else {
        // Normal onUserTurn reopens the per-turn gate; it grants no successful run.
        expect(live.host.workflowFailure.blocking).toBeUndefined();
        live.host.workflowFailure.admitDirectChange();
        expect(live.host.workflowFailure.unverifiedChanges).toEqual([
          { authorizingRun: "none", requestedByOperator: false },
        ]);
      }
      expect(await live.content()).toBe(ORIGINAL);
    },
  );

  it("relays a saved docs-stale warning from a successful run to the live result", async () => {
    const record = stopped();
    record.status = "succeeded";
    delete record.firstPassContradiction;
    record.evidenceWarnings = [
      "docs-stale: discrepancy 1, detail 1: documentation differs from implementation; verification needed.",
    ];
    const live = await liveHost(async () => record);
    live.turn(REQUEST);
    const result = await live.workflow(REQUEST, undefined, "create-documentation");
    expect(result.details.evidenceWarnings).toEqual(record.evidenceWarnings);
    expect(result.content[0].text).toContain("docs-stale:");
  });

  it("refuses to relay a docs-stale warning that contains a configured credential", async () => {
    const secret = configureCredential("synthetic-private-docs-stale-value");
    const record = stopped();
    record.status = "succeeded";
    delete record.firstPassContradiction;
    record.evidenceWarnings = [`docs-stale: chosen value: ${secret}.`];
    const live = await liveHost(async () => record);
    live.turn(REQUEST);
    await expect(live.workflow(REQUEST, undefined, "create-documentation")).rejects.toThrow(
      "governed credential-isolation boundary",
    );
    expect(live.host.terminalOptions.turnNotices?.().join("\n")).not.toContain(secret);
  });

  it.each(["persistence", "quality"] as const)(
    "reports a %s failure consistently in the ordinary tool and terminal choice result",
    async (failure) => {
      const record = {
        ...stopped(),
        status: "succeeded",
        firstPassContradiction: undefined,
      } as RunRecord;
      if (failure === "persistence") {
        vi.spyOn(LiveWorkflowDelivery.prototype, "persist").mockResolvedValue({
          status: "failed",
          error: LIVE_DELIVERY_FAILURES.apply,
        });
      } else {
        record.steps = [
          {
            id: "evaluate-document-quality",
            skill: "evaluate-document-quality",
            status: "succeeded",
            summary: "No structured report was produced.",
          },
        ] as never;
        record.qualityArtifactValidation = {} as never;
      }
      const live = await liveHost(async () => record);
      live.turn(REQUEST);
      const ordinary = await live.workflow(REQUEST, undefined, "create-documentation");
      expect(ordinary.details.status).toBe("failed");
      expect(ordinary.details.workflowStatus).toBe("succeeded");
      expect(ordinary.details.error).toContain(
        failure === "persistence" ? LIVE_DELIVERY_FAILURES.apply : "Quality report",
      );
      const input = new PassThrough();
      const output = new PassThrough();
      let transcript = "";
      output.on("data", (chunk) => {
        transcript += chunk.toString();
      });
      const prompt = vi.fn(async () => undefined);
      const projectEditorialOutcome = vi.fn(async () => ordinary.details.editorial);
      const done = runTerminalConversation(
        { sessionFile: undefined, subscribe: () => () => {}, abort: async () => {}, prompt },
        input,
        output,
        {
          environment: { NO_COLOR: "1" },
          skillIds: [],
          workflowIds: ["create-documentation"],
          planFirstPassChoiceTurn: async () =>
            ({ kind: "choice", plan: { workflow: "create-documentation" } }) as never,
          continueFirstPassChoice: async () => ({
            ...record,
            livePersistence: ordinary.details.persistence,
          }),
          projectEditorialOutcome,
        },
      );
      input.write("Use the implementation\n");
      await vi.waitFor(() =>
        expect(transcript.includes("[Failed]") || transcript.includes("[Completed]")).toBe(true),
      );
      input.end();
      await done;
      expect(transcript).toContain("[Failed]");
      expect(transcript).not.toContain("[Completed]");
      expect(prompt).not.toHaveBeenCalled();
      expect(projectEditorialOutcome).toHaveBeenCalledTimes(1);
      expect(projectEditorialOutcome).toHaveBeenCalledWith(
        expect.objectContaining({ id: record.id, status: "succeeded" }),
      );
    },
  );

  it("withholds configured credentials from successor warnings in the terminal choice path", async () => {
    const secret = configureCredential("synthetic-private-successor-warning");
    const record = {
      ...stopped(),
      status: "succeeded",
      firstPassContradiction: undefined,
      evidenceWarnings: [`operator-choice: unsafe value ${secret}.`],
    } as RunRecord;
    const input = new PassThrough();
    const output = new PassThrough();
    let transcript = "";
    output.on("data", (chunk) => {
      transcript += chunk.toString();
    });
    const prompt = vi.fn(async () => undefined);
    const done = runTerminalConversation(
      { sessionFile: undefined, subscribe: () => () => {}, abort: async () => {}, prompt },
      input,
      output,
      {
        environment: { NO_COLOR: "1" },
        skillIds: [],
        workflowIds: ["create-documentation"],
        planFirstPassChoiceTurn: async () =>
          ({ kind: "choice", plan: { workflow: "create-documentation" } }) as never,
        continueFirstPassChoice: async () => ({
          ...record,
          livePersistence: { status: "not-needed" },
        }),
      },
    );
    input.write("Use the implementation\n");
    await vi.waitFor(() =>
      expect(transcript.includes("[Failed]") || transcript.includes(secret)).toBe(true),
    );
    expect(transcript).toContain("[Failed]");
    input.end();
    await done;
    expect(transcript).not.toContain(secret);
    expect(transcript).not.toContain("operator-choice: unsafe");
    expect(prompt).not.toHaveBeenCalled();
  });

  it("relays and directly renders a zero-step question without assistant text", async () => {
    const record = stopped();
    const live = await liveHost(async () => record);
    live.turn(REQUEST);
    const result = await live.workflow(REQUEST, undefined, "create-documentation");
    expect(result.details.firstPassContradictionQuestion).toEqual(
      record.firstPassContradiction?.question,
    );
    expect(JSON.parse(result.content[0].text).firstPassContradictionQuestion).toEqual(
      record.firstPassContradiction?.question,
    );
    const notice = live.host.terminalOptions.turnNotices?.().join("\n");
    expect(notice).toContain("Question: The repository sources disagree");
    expect(notice).toContain('`src/sprout.mjs` line 7 has "friend"');
    expect(notice).toContain('`docs/source.md` lines 11-12 has "world"');
    expect(notice).toContain('Options: Use "friend" from `src/sprout.mjs` line 7');
    expect(notice).toContain("Recommended: Withhold the disputed section until the sources agree");
    expect(notice).toContain("If you take it: DocsFab writes `docs/cli-reference.md`");
    await expect(live.write("unsafe fallback")).rejects.toThrow("blocked this direct change");
    expect(await live.content()).toBe(ORIGINAL);
    expect(live.confirm).not.toHaveBeenCalled();
  });
  it("prints the saved zero-step question through the terminal conversation", async () => {
    const live = await liveHost(async () => stopped());
    const input = new PassThrough();
    const output = new PassThrough();
    let transcript = "";
    output.on("data", (chunk) => {
      transcript += chunk.toString();
    });
    const done = runTerminalConversation(
      {
        sessionFile: undefined,
        subscribe: () => () => {},
        abort: async () => {},
        prompt: async () => {
          await live.workflow(REQUEST, undefined, "create-documentation");
        },
      },
      input,
      output,
      { ...live.host.terminalOptions, environment: { NO_COLOR: "1" } },
    );
    input.write(`${REQUEST}\n`);
    await vi.waitFor(() =>
      expect(transcript).toContain(
        "Recommended: Withhold the disputed section until the sources agree",
      ),
    );
    expect(transcript).toContain('`src/sprout.mjs` line 7 has "friend"');
    expect(transcript).toContain('`docs/source.md` lines 11-12 has "world"');
    input.end();
    await done;
  });
  it.each(["missing", "failed", "succeeded"])(
    "omits question for the adjacent %s record",
    async (kind) => {
      const record = stopped();
      if (kind === "missing") delete (record as any).firstPassContradiction;
      else (record as any).status = kind;
      const live = await liveHost(async () => record);
      live.turn(REQUEST);
      const result = await live.workflow(REQUEST, undefined, "create-documentation");
      expect(result.details).not.toHaveProperty("firstPassContradictionQuestion");
      expect(live.host.terminalOptions.turnNotices?.().join("\n")).not.toContain("Question:");
    },
  );
  it("refuses a tampered saved question without relaying its contents", async () => {
    const record = stopped();
    (record.firstPassContradiction!.question as any).question = "tampered disclosure instruction";
    const live = await liveHost(async () => record);
    live.turn(REQUEST);
    await expect(live.workflow(REQUEST, undefined, "create-documentation")).rejects.toThrow(
      "The recorded first-pass contradiction does not have the shape DocsFab writes.",
    );
    await assertDirectChangesBlocked(live);
    expect(live.host.terminalOptions.turnNotices?.().join("\n")).not.toContain(
      "tampered disclosure instruction",
    );
  });
  it("withholds configured credentials from a structurally valid question", async () => {
    const secret = configureCredential("synthetic-private-contradiction-value");
    const live = await liveHost(async () => stopped(secret));
    live.turn(REQUEST);
    await expect(live.workflow(REQUEST, undefined, "create-documentation")).rejects.toThrow(
      "governed credential-isolation boundary",
    );
    await assertDirectChangesBlocked(live);
    expect(live.host.terminalOptions.turnNotices?.().join("\n")).not.toContain(secret);
  });
  it("escapes control characters in source paths in every terminal question field", async () => {
    const live = await liveHost(async () => stopped("friend", "src/\u001b[2Jsprout.mjs"));
    live.turn(REQUEST);
    await live.workflow(REQUEST, undefined, "create-documentation");
    const notice = live.host.terminalOptions.turnNotices?.().join("\n") ?? "";
    expect(notice).toContain("src/\\u{1b}[2Jsprout.mjs");
    expect(notice).not.toContain("\u001b[2J");
  });
});
