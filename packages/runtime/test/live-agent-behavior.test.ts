// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  createAgentSession,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createModelConnection } from "../src/model/provider.js";
import { createDocsFabResourceLoader } from "../src/harness/pi-session.js";
import { LiveAgentActivityRenderer, failureReason } from "../src/live-agent/activity-renderer.js";
import { loadVerifiedInvocationMetadata } from "../src/skills/invocation-metadata.js";
import { validModelConfig } from "./helpers.js";
import { execFile, spawnSync } from "node:child_process";
import { chmod, cp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createConfinedToolSet } from "../src/harness/confined-tools.js";
import { createLiveAgentToolDefinitions } from "../src/live-agent/capabilities.js";
import { createLiveAgentBoundedRunner } from "../src/live-agent/host.js";
import type { LiveAgentSourceSelection } from "../src/live-agent/source-commands.js";
import { TaskReconciliationError } from "../src/execution/task-reconciliation.js";
import type { DocsFabConfig } from "../src/config/runtime-loader.js";
import {
  createReaderTaskContextSupplier,
  ReaderTaskContextError,
} from "../src/execution/task-context.js";
import { LIVE_SKILL_FAILURES } from "../src/live-agent/skill-references.js";
import { verifyQualityPackContext } from "../src/quality-pack/manifest.js";
import { verifyCatalogSkill } from "../src/skills/catalog-crate.js";
import { temporaryRoots } from "./helpers/temp.js";

const directories = temporaryRoots();
const hasExpect = spawnSync("expect", ["-v"]).status === 0;

it.runIf(hasExpect)(
  "drives the real-model proof terminal without calling a model",
  async () => {
    const root = await directories.create("docsfab-proof-driver-");
    const executable = join(root, "fixture.mjs");
    const transcript = join(root, "received.json");
    await cp(resolve("test/fixtures/live-agent-behavior/driver-fixture.mjs"), executable);
    await chmod(executable, 0o700);
    const prompt = 'Explain [this] "example" without executing $commands.';
    const result = await promisify(execFile)(
      "expect",
      [
        "-f",
        resolve("test/fixtures/live-agent-behavior/conversation.exp"),
        executable,
        transcript,
        prompt,
      ],
      { timeout: 5000 },
    );
    expect(result.stdout.trim()).toBe("SESSION abcdefab-1234-5678-9012-abcdefabcdef");
    expect(JSON.parse(await readFile(transcript, "utf8"))).toEqual([prompt, "/exit"]);
  },
  10_000,
);
afterEach(async () => {
  vi.unstubAllGlobals();
});

async function fixture(allowWrite = false) {
  const root = await directories.create("docsfab-live-reference-", { realpath: true });
  const verified = await verifyCatalogSkill({
    skillCrateDirectory: resolve("skill-crate"),
    skillId: "review-documentation",
    grantedTools: ["read", "grep", "find", "ls"],
  });
  const directory = join(root, "skill");
  await cp(verified.directory, directory, { recursive: true });
  const tools = createLiveAgentToolDefinitions({
    allowWrite,
    capabilities: {
      skills: [{ lock: verified.skill, directory }],
      qualityPack: {} as never,
      workflows: [],
    },
    async runWorkflow() {
      throw new Error("No workflow needed for skill reference access.");
    },
  });
  const skill = tools[0]!;
  const invoke = (parameters: Record<string, unknown>) =>
    skill.execute("test", parameters, undefined, undefined, {} as never);
  return { root, directory, invoke, verified, tools };
}

describe("live-agent packaged supporting references", () => {
  it("reproduces the confined-read gap without broadening repository access", async () => {
    const { directory } = await fixture();
    const workspace = await directories.create("docsfab-live-workspace-");
    const tools = await createConfinedToolSet({ workspacePath: workspace, allowWrite: false });
    const read = tools.definitions.find((tool) => tool.name === "read")!;
    expect(await readFile(join(directory, "SKILL.md"), "utf8")).toContain(
      "references/review-methods.md",
    );
    await expect(
      read.execute(
        "read",
        { path: join(directory, "references/review-methods.md") },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow();
    expect(tools.definitions.map((tool) => tool.name)).not.toEqual(
      expect.arrayContaining(["write", "edit", "bash"]),
    );
  });

  it("loads a supporting reference with its locked identity through the existing skill tool", async () => {
    const { invoke, verified } = await fixture();
    const result = await invoke({
      skill: "review-documentation",
      reference: "references/review-methods.md",
    });
    expect(result.details).toMatchObject({
      kind: "docsfab-live-skill-reference",
      skill: "review-documentation",
      reference: "references/review-methods.md",
      sha256: verified.skill.files.find((file) => file.path === "references/review-methods.md")!
        .sha256,
    });
    const referenceContent = result.content[0];
    expect(referenceContent?.type).toBe("text");
    if (referenceContent?.type !== "text") throw new Error("Expected text reference content.");
    expect(referenceContent.text).toContain("Review");
    const skill = await invoke({ skill: "review-documentation" });
    const skillContent = skill.content[0];
    expect(skillContent?.type).toBe("text");
    if (skillContent?.type !== "text") throw new Error("Expected text skill content.");
    expect(skillContent.text).toContain("reference");
    expect(skill.details.kind).toBe("docsfab-live-skill");
    expect(
      (await invoke({ skill: "review-documentation", reference: "SKILL.md" })).details.kind,
    ).toBe("docsfab-live-skill");
  });

  it("rejects unknown references and traversal without granting filesystem access", async () => {
    const { invoke } = await fixture();
    for (const reference of ["../outside.md", "/etc/passwd", "references/missing.md"]) {
      await expect(invoke({ skill: "review-documentation", reference })).rejects.toThrow("locked");
    }
  });

  it("rejects reference reader fields before reading the reference", async () => {
    const { invoke, directory } = await fixture();
    await writeFile(join(directory, "references/review-methods.md"), "tampered-private-reference");
    await expect(
      invoke({
        skill: "review-documentation",
        reference: "references/review-methods.md",
        readerSources: [],
      }),
    ).rejects.toThrow('"code":"unsupported-context"');
  });

  it("rejects changed skill bytes after startup verification", async () => {
    const { invoke, directory } = await fixture();
    await writeFile(join(directory, "SKILL.md"), "modified");
    await expect(invoke({ skill: "review-documentation" })).rejects.toThrow("integrity");
  });

  it("rejects changed reference bytes after startup verification", async () => {
    const { invoke, directory } = await fixture();
    await writeFile(join(directory, "references/review-methods.md"), "modified");
    await expect(
      invoke({ skill: "review-documentation", reference: "references/review-methods.md" }),
    ).rejects.toThrow("integrity");
  });

  it("rejects a supporting reference replaced with a symlink", async () => {
    const { invoke, directory, root } = await fixture();
    const reference = join(directory, "references/review-methods.md");
    await writeFile(join(root, "outside.md"), "not a packaged reference");
    await rm(reference);
    await symlink(join(root, "outside.md"), reference);
    await expect(
      invoke({ skill: "review-documentation", reference: "references/review-methods.md" }),
    ).rejects.toThrow("locked");
  });
});

describe("live-agent reader task context", () => {
  async function readerTools(
    allowWrite = false,
    skillId = "plan-documentation",
    prepareError?: Error,
  ) {
    const verified = await verifyCatalogSkill({
      skillCrateDirectory: resolve("skill-crate"),
      skillId,
      grantedTools:
        skillId === "write-documentation"
          ? ["read", "grep", "find", "ls", "edit", "write"]
          : ["read", "grep", "find", "ls"],
    });
    const qualityPack = await verifyQualityPackContext({
      qualityPackDirectory: resolve("quality-pack"),
      qualityDirectory: resolve("quality"),
      skillCrateDirectory: resolve("skill-crate"),
    });
    const supplier = await createReaderTaskContextSupplier(qualityPack);
    const workflowCalls: unknown[] = [];
    const contextRequests: unknown[] = [];
    const refusals: unknown[] = [];
    const dispatches: { instruction: string; context?: string }[] = [];
    const tools = createLiveAgentToolDefinitions({
      allowWrite,
      onInvocationRefused: (refusal) => refusals.push(refusal),
      capabilities: {
        skills: [
          {
            lock: verified.skill,
            directory: verified.directory,
            invocation: await loadVerifiedInvocationMetadata(verified),
          },
        ],
        qualityPack: qualityPack.evidence,
        readerTaskContextSupplier: supplier,
        workflows: [
          { name: "update-documentation", title: "Update documentation" },
          { name: "review-documentation", title: "Review documentation" },
          { name: "create-documentation", title: "Create documentation" },
          { name: "restructure-documentation", title: "Restructure documentation" },
        ],
      },
      async prepareReaderTaskContext(request) {
        contextRequests.push(request);
        if (prepareError) throw prepareError;
        return supplier.createHandoff({
          readerContextInput: request.readerContextInput,
          inputOrigin: request.inputOrigin,
          admission: {
            admittedRevision: "a".repeat(40),
            workspaceSnapshotSha256: "b".repeat(64),
            repositoryIdentitySha256: "c".repeat(64),
            comparison: { kind: "workspace", snapshot_sha256: "b".repeat(64) },
            sources: [{ uri: "request:live-agent", sha256: "d".repeat(64), role: "request" }],
            provenanceLimitations: [],
          },
        });
      },
      async runWorkflow(_workflow, instruction, _progress, _signal, readerTaskContext, context) {
        workflowCalls.push(readerTaskContext);
        dispatches.push({ instruction, context });
        return {
          id: "reader-run",
          workflow: "update-documentation",
          status: "succeeded",
          steps: [],
          changes: [],
        } as never;
      },
    });
    return { tools, workflowCalls, contextRequests, refusals, dispatches };
  }

  const readerContext = {
    schema_version: 1,
    target_audience: "operators",
    reader_job: "run an inspection",
    change_scope: ["docs/cli.md"],
    source_priority: ["public CLI", "current docs"],
    required_content: ["command", "verification"],
    excluded_content: [],
    unresolved_questions: [],
  };

  it.each([
    ["write-documentation", true],
    ["write-documentation", false],
    ["plan-documentation", true],
    ["plan-documentation", false],
  ] as const)(
    "loads %s instructions in write mode without admitting optional reader context: context=%s",
    async (skillId, withContext) => {
      const { tools, contextRequests, workflowCalls } = await readerTools(true, skillId);
      const result = await tools[0]!.execute(
        "write-instructions",
        {
          skill: skillId,
          ...(withContext ? { readerContext } : {}),
          readerSources: [
            { role: "current-documentation", path: "docs/cli.md" },
            { role: "public-contract", path: "src/missing.ts" },
          ],
        },
        undefined,
        undefined,
        {} as never,
      );
      expect(result.details).toMatchObject({
        kind: "docsfab-live-skill",
        skill: skillId,
      });
      expect(result.details).not.toHaveProperty("readerTaskContextHandoffSha256");
      expect(result.content[0].text).toContain("only loaded instructions");
      expect(result.content[0].text).toContain("not admitted or verified");
      expect(contextRequests).toEqual([]);
      expect(workflowCalls).toEqual([]);
    },
  );

  it.each([false, true])(
    "advertises assessment inputs only in an available read-only host, write=%s",
    async (write) => {
      const { tools } = await readerTools(write);
      const schema = tools[0]!.parameters as { properties: Record<string, unknown> };
      expect(Object.hasOwn(schema.properties, "readerContext")).toBe(!write);
      expect(tools[0]!.description).toContain(
        write ? "unavailable in this session" : "only with plan-documentation",
      );
    },
  );

  it("does not decode or observe irrelevant malformed reader input during an ordinary load", async () => {
    const { tools, contextRequests } = await readerTools(true, "write-documentation");
    const result = await tools[0]!.execute(
      "plain",
      {
        skill: "write-documentation",
        readerSources: "not evidence",
        readerContext: { arbitrary: "private" },
      },
      undefined,
      undefined,
      {} as never,
    );
    expect(result.details.unadmittedReaderFields).toEqual(["readerContext", "readerSources"]);
    expect(result.content[0].text).not.toContain("private");
    expect(contextRequests).toEqual([]);
  });

  it("keeps explicit assessment intent when the observation supplier is missing", async () => {
    const { tools } = await readerTools();
    const verified = await verifyCatalogSkill({
      skillCrateDirectory: resolve("skill-crate"),
      skillId: "plan-documentation",
      grantedTools: ["read", "grep", "find", "ls"],
    });
    const missing = createLiveAgentToolDefinitions({
      capabilities: {
        skills: [
          {
            lock: verified.skill,
            directory: verified.directory,
            invocation: await loadVerifiedInvocationMetadata(verified),
          },
        ],
        qualityPack: {} as never,
        workflows: [],
      },
      async runWorkflow() {
        throw new Error("must not run");
      },
    });
    expect(missing[0]!.parameters).not.toHaveProperty("properties.readerContext");
    await expect(
      missing[0]!.execute(
        "assessment",
        { skill: "plan-documentation", readerContext },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow('"recovery":"retry-when-supplier-available"');
    expect(tools[0]!.parameters).toHaveProperty("properties.readerContext");
  });

  it("loads reader policy only for an explicit read-only assessment", async () => {
    const { tools, contextRequests } = await readerTools();
    const skill = tools.find((tool) => tool.name === "docsfab_use_skill")!;
    const result = await skill.execute(
      "reader-skill",
      { skill: "plan-documentation", readerContext },
      undefined,
      undefined,
      {} as never,
    );
    expect(result.content[0].text).toContain("# Reader Impact Baseline");
    expect(result.content[0].text).toContain('"reader_job":"run an inspection"');
    expect(result.details.readerTaskContextHandoffSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(contextRequests).toEqual([
      expect.objectContaining({ inputOrigin: "explicit", sourceHints: [] }),
    ]);
  });

  // The conservative context does not rule out no-change; the evidence bar
  // decides it.
  it("hands an ordinary update a conservative context whose no-change needs evidence", async () => {
    const { tools, workflowCalls, contextRequests } = await readerTools();
    const workflow = tools.find((tool) => tool.name === "docsfab_run_workflow")!;
    const result = await workflow.execute(
      "reader-workflow",
      { workflow: "update-documentation", instruction: "Update the CLI guide." },
      undefined,
      undefined,
      {} as never,
    );
    expect(workflowCalls).toHaveLength(1);
    expect(workflowCalls[0]).toMatchObject({
      inputOrigin: "conservative-fallback",
      noChangeAssessment: "requires-evidence",
      readerContextInput: {
        reader_job: "Update the CLI guide.",
        required_content: ["Update the CLI guide."],
      },
      comparison: { kind: "workspace", snapshot_sha256: "b".repeat(64) },
    });
    expect(result.details).toMatchObject({ noChangeAssessment: "requires-evidence" });
    expect(result.details).toMatchObject({
      status: "succeeded",
      quality: null,
      qualityLimitations: ["quality-evaluator-not-run"],
    });
    expect(result.content[0].text).toContain("quality-evaluator-not-run");
    expect(contextRequests).toEqual([
      expect.objectContaining({
        inputOrigin: "conservative-fallback",
        requestText: "Update the CLI guide.",
        comparisonRequest: { kind: "workspace" },
        sourceHints: [],
      }),
    ]);
  });

  it("passes explicit source paths to host admission without treating them as evidence", async () => {
    const { tools, contextRequests } = await readerTools();
    const workflow = tools.find((tool) => tool.name === "docsfab_run_workflow")!;
    await workflow.execute(
      "reader-workflow-sources",
      {
        workflow: "update-documentation",
        instruction: "Update the CLI guide.",
        readerContext,
        readerComparison: { kind: "workspace" },
        readerSources: [
          { role: "current-documentation", path: "docs/cli.md" },
          { role: "public-contract", path: "packages/runtime/src/cli/types.ts" },
        ],
      },
      undefined,
      undefined,
      {} as never,
    );
    expect(contextRequests).toEqual([
      expect.objectContaining({
        inputOrigin: "explicit",
        comparisonRequest: { kind: "workspace" },
        sourceHints: [
          { role: "current-documentation", path: "docs/cli.md" },
          { role: "public-contract", path: "packages/runtime/src/cli/types.ts" },
        ],
      }),
    ]);
  });

  it.each(["review-documentation", "create-documentation", "restructure-documentation"])(
    "starts %s without admitting, decoding, or observing reader fields",
    async (name) => {
      const { tools, workflowCalls, contextRequests, refusals, dispatches } = await readerTools();
      const workflow = tools.find((tool) => tool.name === "docsfab_run_workflow")!;
      const sourcesMarker = "dropped-reader-sources-marker-1265";
      const result = await workflow.execute(
        "reader-review-comparison",
        {
          workflow: name,
          instruction: "Review the CLI guide.",
          readerContext: { arbitrary: "private" },
          // Malformed on purpose: a dropped field is never decoded.
          readerSources: sourcesMarker,
          readerComparison: { kind: "workspace" },
        },
        undefined,
        undefined,
        {} as never,
      );
      expect(workflowCalls).toEqual([undefined]);
      expect(contextRequests).toEqual([]);
      expect(refusals).toEqual([]);
      // Dropped fields do not become request text or context.
      expect(dispatches).toEqual([{ instruction: "Review the CLI guide.", context: undefined }]);
      expect(JSON.stringify(dispatches)).not.toMatch(/dropped-reader-sources-marker|private/u);
      expect(result.details).toMatchObject({
        kind: "docsfab-live-workflow-result",
        runId: "reader-run",
        unadmittedReaderFields: ["readerContext", "readerSources", "readerComparison"],
        readerFieldsNote: expect.stringContaining("only update-documentation takes them"),
      });
      expect(result.details).not.toHaveProperty("readerTaskContextHandoffSha256");
      expect(result.content[0].text).not.toContain("private");
    },
  );

  it("describes workflow reader fields from the one intake declaration", async () => {
    const { tools } = await readerTools();
    const workflow = tools.find((tool) => tool.name === "docsfab_run_workflow")!;
    const properties = (
      workflow.parameters as { properties: Record<string, { description?: string }> }
    ).properties;
    for (const field of ["readerContext", "readerSources", "readerComparison"]) {
      expect(properties[field]!.description).toMatch(
        /^Only for update-documentation; other workflows start without it\./u,
      );
    }
    const reviewOnly = createLiveAgentToolDefinitions({
      capabilities: {
        skills: [],
        qualityPack: {} as never,
        workflows: [{ name: "review-documentation", title: "Review documentation" }],
      },
      async runWorkflow() {
        throw new Error("must not run");
      },
    }).find((tool) => tool.name === "docsfab_run_workflow")!;
    expect(reviewOnly.parameters).not.toHaveProperty("properties.readerContext");
    expect(reviewOnly.parameters).not.toHaveProperty("properties.readerSources");
    expect(reviewOnly.description).not.toContain("readerSources");
  });

  it("reports a snapshot mismatch from live-to-workflow handoff before running the child", async () => {
    const { tools, workflowCalls, refusals } = await readerTools(
      false,
      "plan-documentation",
      new ReaderTaskContextError("stale"),
    );
    const workflow = tools.find((tool) => tool.name === "docsfab_run_workflow")!;
    await expect(
      workflow.execute(
        "reader-workflow-stale",
        { workflow: "update-documentation", instruction: "Update the CLI guide." },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow(LIVE_SKILL_FAILURES.snapshotMismatch);
    expect(workflowCalls).toEqual([]);
    // The handoff refusal reaches the host's turn record, not only the terminal.
    expect(refusals).toEqual([{ workflow: "update-documentation" }]);
    expect(failureReason(LIVE_SKILL_FAILURES.snapshotMismatch, ["update-documentation"])).toBe(
      LIVE_SKILL_FAILURES.snapshotMismatch,
    );
  });
});

// Only provider replies are scripted. Tool execution, argument validation, error conversion,
// subsequent provider input, and terminal activity use the production Pi session.
it("preserves a reference rejection and valid plain-load recovery through Pi", async () => {
  const { root, tools } = await fixture(true);
  const requests: Record<string, unknown>[] = [];
  const replies = [
    {
      tool_calls: [
        {
          index: 0,
          id: "invalid",
          type: "function",
          function: {
            name: "docsfab_use_skill",
            arguments: JSON.stringify({
              skill: "review-documentation",
              reference: "references/review-methods.md",
              readerContext: { private: "not-to-display" },
            }),
          },
        },
      ],
    },
    {
      tool_calls: [
        {
          index: 0,
          id: "recovery",
          type: "function",
          function: {
            name: "docsfab_use_skill",
            arguments: JSON.stringify({
              skill: "review-documentation",
              readerContext: { private: "not-to-display" },
            }),
          },
        },
      ],
    },
    { content: "Instructions loaded. No edits or checks performed." },
  ];
  vi.stubGlobal("fetch", async (_request: unknown, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)));
    const delta = replies.shift();
    if (!delta) throw new Error("Unexpected provider request");
    const chunks = [
      {
        id: "reply",
        object: "chat.completion.chunk",
        created: 1,
        model: validModelConfig.modelId,
        choices: [{ index: 0, delta: { role: "assistant", ...delta }, finish_reason: null }],
      },
      {
        id: "reply",
        object: "chat.completion.chunk",
        created: 1,
        model: validModelConfig.modelId,
        choices: [
          { index: 0, delta: {}, finish_reason: "tool_calls" in delta ? "tool_calls" : "stop" },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
    ];
    return new Response(
      chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } },
    );
  });
  const connection = await createModelConnection(validModelConfig);
  const loader = createDocsFabResourceLoader({
    repositoryPath: root,
    agentDir: root,
    mode: "live-agent",
    systemPrompt: "Apply documentation guidance.",
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: root,
    modelRuntime: connection.runtime,
    model: connection.model,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(root),
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    }),
    tools: ["docsfab_use_skill"],
    customTools: [tools[0]!],
  });
  const output: string[] = [];
  const activity = new LiveAgentActivityRenderer({
    environment: { NO_COLOR: "1" },
    skillIds: ["review-documentation"],
    workflowIds: [],
    tty: true,
    columns: () => 100,
    write: (text) => output.push(text),
  });
  const results: Array<{ isError: boolean; result: any }> = [];
  activity.begin();
  session.subscribe((event) => {
    activity.handle(event);
    if (event.type === "tool_execution_end") results.push(event);
  });
  try {
    await session.prompt("Load the review guidance.");
    expect(results.map((result) => result.isError)).toEqual([true, false]);
    const rejected = JSON.parse(results[0]!.result.content[0].text);
    expect(rejected).toEqual({
      kind: "docsfab-invocation-error",
      code: "unsupported-context",
      fields: ["readerContext"],
      recovery: "retry-load-without-reader-fields",
    });
    expect(JSON.stringify(requests[1])).toContain("retry-load-without-reader-fields");
    expect(results[1]!.result.details.kind).toBe("docsfab-live-skill");
    expect(results[1]!.result.details.unadmittedReaderFields).toEqual(["readerContext"]);
    expect(output.join("")).toContain("[Failed]");
    expect(output.join("")).toContain("[Done]");
    expect(output.join("")).toContain("does not accept reader fields");
    expect(output.join("")).not.toContain("not-to-display");
    expect(output.join("")).not.toContain("No safe failure detail");
    expect(
      failureReason(results[0]!.result.content[0].text + " private suffix", []),
    ).toBeUndefined();
  } finally {
    activity.dispose();
    session.dispose();
  }
}, 15000);

// Proof grading is independent of the model's final self-report.
describe("live capability proof grading", () => {
  it("requires a grounded documentation finding for an unqualified PR review", async () => {
    const { assessPullRequestReview } = await import(
      "./fixtures/live-agent-behavior/proof-assertions.mjs"
    );
    const reviewed = {
      skillUses: [{ skill: "review-documentation", verified: true }],
      workflows: [],
      targetRead: true,
      sourceRead: true,
      diffRead: true,
      finalText:
        "README.md: The Quick Start omits the required --output option, so the documented command fails instead of saving a report. The PR makes it mandatory; include node cli.mjs export --output report.txt.",
    };
    expect(assessPullRequestReview(reviewed)).toBe(true);
    expect(
      assessPullRequestReview({
        ...reviewed,
        finalText:
          "README.md describes --output as optional; the implementation must not require it: restore the default in cli.mjs.",
      }),
    ).toBe(false);
    expect(
      assessPullRequestReview({
        ...reviewed,
        finalText:
          "README.md: The required --output argument is missing. Include node cli.mjs export --output report.txt.",
      }),
    ).toBe(false);
    // The reported session performed a code review with only ls and bash.
    expect(
      assessPullRequestReview({
        ...reviewed,
        skillUses: [],
        targetRead: false,
        finalText: "I recommend changes: each speaker fragment prematurely finalizes the turn.",
      }),
    ).toBe(false);
    // A final claim cannot substitute for a verified tool result or evidence reads.
    expect(assessPullRequestReview({ ...reviewed, skillUses: [] })).toBe(false);
    expect(
      assessPullRequestReview({
        ...reviewed,
        skillUses: [{ skill: "review-documentation", verified: false }],
      }),
    ).toBe(false);
    for (const field of ["targetRead", "sourceRead", "diffRead"] as const) {
      expect(assessPullRequestReview({ ...reviewed, [field]: false })).toBe(false);
    }
    expect(
      assessPullRequestReview({
        ...reviewed,
        finalText: "The implementation has a bug; add a source-code test.",
      }),
    ).toBe(false);
    expect(
      assessPullRequestReview({
        ...reviewed,
        skillUses: [],
        workflows: [{ workflow: "review-documentation", status: "failed" }],
      }),
    ).toBe(false);
    expect(
      assessPullRequestReview({
        ...reviewed,
        skillUses: [],
        workflows: [{ workflow: "review-documentation", status: "succeeded" }],
      }),
    ).toBe(true);
  });

  it("recognizes current task guidance while excluding schemas and unrelated API rubrics", async () => {
    const { isFocusedQualityGuidance, summarizeProofRun } = await import(
      "./fixtures/live-agent-behavior/proof-assertions.mjs"
    );
    expect(isFocusedQualityGuidance("rubrics/task-guide.yaml")).toBe(true);
    expect(isFocusedQualityGuidance("profiles/docsfab-documentation-quality/profile.json")).toBe(
      true,
    );
    expect(isFocusedQualityGuidance("schemas/reader-context.schema.json")).toBe(false);
    expect(isFocusedQualityGuidance("rubrics/api-reference.yaml")).toBe(false);
    const summary = summarizeProofRun({
      steps: [
        {
          id: "derive-source-obligations",
          status: "failed",
          // The coded form of the decoder's host-path refusal.
          error:
            "Source-obligation response did not satisfy the host-owned contract under rule host-path-disclosure at $.",
        },
        {
          id: "review-documentation",
          status: "failed",
          error: "private payload /Users/example/secret",
        },
      ],
    });
    expect(summary.steps[0].failureCategory).toBe("source-obligation-host-path");
    expect(JSON.stringify(summary)).not.toContain("private payload");
    expect(JSON.stringify(summary)).not.toContain("/Users/");
    // The older fixed sentence also classifies, so a proof run over a saved
    // record does not silently lose its category.
    const historical = summarizeProofRun({
      steps: [
        {
          id: "derive-source-obligations",
          status: "failed",
          error: "Source-obligation evidence disclosed a host path.",
        },
      ],
    });
    expect(historical.steps[0].failureCategory).toBe("source-obligation-host-path");
    // Control: an unrelated failure is not classified.
    const unrelated = summarizeProofRun({
      steps: [{ id: "derive-source-obligations", status: "failed", error: "something else" }],
    });
    expect(unrelated.steps[0].failureCategory).toBeUndefined();
  });
});

describe("live-agent task reconciliation seams", () => {
  it("refuses a workflow result-change when access was revoked", async () => {
    const tools = createLiveAgentToolDefinitions({
      capabilities: {
        skills: [],
        qualityPack: {} as never,
        workflows: [{ name: "review-documentation", title: "Review documentation" }],
      },
      resultChange: { accessRevoked: true },
      async runWorkflow() {
        throw new Error("must not run a revoked workflow");
      },
    });
    const workflow = tools.find((tool) => tool.name === "docsfab_run_workflow")!;
    await expect(
      workflow.execute(
        "revoked",
        { workflow: "review-documentation", instruction: "Review the CLI guide." },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toBeInstanceOf(TaskReconciliationError);
  });

  it("guards the bounded runner before a new workflow starts", async () => {
    const selection = {
      instructionCompatibilityFields: () => ({}),
      assertBindable: () => undefined,
      holdForRun: () => () => undefined,
      requestFields: () => ({}),
    } as unknown as LiveAgentSourceSelection;
    const runner = createLiveAgentBoundedRunner({
      selection,
      repositoryPath: "/tmp/docsfab-reconciliation-unused",
      allowWrite: false,
      config: {} as DocsFabConfig,
      persist: async () => ({ status: "not-needed" }) as never,
      resultChange: { anotherActiveOwner: true },
      runWorkflow: async () => {
        throw new Error("must not run under another owner");
      },
    });
    await expect(runner("review-documentation", "Review the CLI guide.")).rejects.toBeInstanceOf(
      TaskReconciliationError,
    );
  });
});
