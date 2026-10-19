// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { access, mkdir, readFile } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { LiveAgentActivityRenderer } from "../src/live-agent/activity-renderer.js";
import { safeFailureMessage } from "../src/harness/confined-tools.js";
import { LIVE_WORKFLOW_FAILURE_GATE_MESSAGES } from "../src/live-agent/workflow-failure-gate.js";
import type { DocsFabConfig } from "../src/config/runtime-loader.js";
import type { CatalogSkillId } from "../src/skills/catalog-crate.js";
import type { RunnableWorkflowName } from "../src/workflow-registry/catalog.js";
import { assembleLiveAgentHost } from "../src/live-agent/host.js";
import {
  createLiveAgentToolDefinitions,
  loadLiveAgentCapabilities,
} from "../src/live-agent/capabilities.js";
import { SAVED_RUN_FAILURES } from "../src/live-agent/saved-run-tool.js";
import {
  assertDocumentationWorkflowSourceReady,
  operatorNamedChangeReviewReferences,
} from "../src/live-agent/host.js";
import { parseLiveAgentChangeReviewReference } from "../src/live-agent/change-review.js";
import { SOURCE_COMMAND_REFUSALS } from "../src/live-agent/source-commands.js";
import { LIVE_COMMAND_FAILURES } from "../src/live-agent/command-tool.js";
import { configureCredential } from "./helpers/configured-credential.js";
import { initFixtureRepo } from "./helpers/git.js";
import { temporaryRoots } from "./helpers/temp.js";
import {
  createDocumentationWorkState,
  DOCUMENTATION_WORK_FAILURE_REFUSAL,
  DOCUMENTATION_WORK_REFUSAL,
  DOCUMENTATION_WORK_PREREQUISITE_ACTION,
  DocumentationWorkPrerequisiteError,
} from "../src/live-agent/documentation-work-state.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const skill = "create-documentation" as CatalogSkillId;
const secondSkill = "verify-technical-accuracy" as CatalogSkillId;
const installedWritingSkill = "write-documentation" as CatalogSkillId;
const workflow = "review-documentation" as RunnableWorkflowName;
const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const roots = temporaryRoots();

function capabilityConfig(stateDirectory: string): DocsFabConfig {
  return {
    projectRoot: runtimeRoot,
    skillCrateDirectory: join(runtimeRoot, "skill-crate"),
    qualityDirectory: join(runtimeRoot, "quality"),
    qualityPackDirectory: join(runtimeRoot, "quality-pack"),
    stateDirectory,
    model: { provider: "none", model: "none" },
  } as unknown as DocsFabConfig;
}

function state(verifyCurrent = () => undefined) {
  return createDocumentationWorkState({
    skillIds: [skill, secondSkill],
    workflowIds: [workflow],
    workflowSkillIds: new Map([[workflow, [skill, secondSkill]]]),
    verifyCurrent,
  });
}

describe("live-agent documentation work admission", () => {
  it("projects actual host admission as a prerequisite without reading content, then permits the loaded-skill retry", async () => {
    const root = await roots.create("docsfab-work-prerequisite-activity-");
    const repositoryPath = join(root, "repo");
    const stateDirectory = join(root, "state");
    const page = join(repositoryPath, "docs/index.md");
    await mkdir(stateDirectory, { recursive: true });
    await initFixtureRepo(
      repositoryPath,
      {
        "docs/index.md": "# Admitted guide\n",
        "src/code.ts": "export const unchanged = true;\n",
      },
      { branch: "main" },
    );
    const config = capabilityConfig(stateDirectory);
    const host = await assembleLiveAgentHost({
      repositoryPath,
      allowWrite: true,
      environment: { PATH: process.env.PATH, NO_COLOR: "1" },
      config,
      capabilities: await loadLiveAgentCapabilities(config),
      sourcePorts: {} as never,
      onNotice: () => undefined,
      writeError: () => undefined,
      runWorkflow: (() => Promise.reject(new Error("unexpected workflow"))) as never,
    });
    const read = host.customTools.find((tool) => tool.name === "read");
    const write = host.customTools.find((tool) => tool.name === "write");
    const useSkill = host.customTools.find((tool) => tool.name === "docsfab_use_skill");
    if (!read || !write || !useSkill)
      throw new Error("Missing real repository or installed skill tool.");
    const chunks: string[] = [];
    const activity = new LiveAgentActivityRenderer({
      ...host.terminalOptions,
      tty: false,
      write: (text) => chunks.push(text),
    });
    const observedTool = async (
      toolName: "read" | "write",
      toolCallId: string,
      args: { path: string; content?: string },
    ) => {
      activity.handle({
        type: "tool_execution_start",
        toolName,
        toolCallId,
        args,
      });
      try {
        const tool = toolName === "read" ? read : write;
        const result = await tool.execute(toolCallId, args, undefined, undefined, {} as never);
        activity.handle({
          type: "tool_execution_end",
          toolName,
          toolCallId,
          result,
          isError: false,
        });
        return result;
      } catch (error) {
        // Pi carries only text, not the admission Error's custom identity.
        activity.handle({
          type: "tool_execution_end",
          toolName,
          toolCallId,
          isError: true,
          result: {
            content: [
              { type: "text", text: error instanceof Error ? error.message : String(error) },
            ],
          },
        } as AgentSessionEvent);
        throw error;
      }
    };
    const observedRead = (toolCallId: string) =>
      observedTool("read", toolCallId, { path: "docs/index.md" });
    const contentReads = () => vi.mocked(readFile).mock.calls.filter(([path]) => path === page);
    const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    try {
      host.terminalOptions.onUserTurn?.("Inspect the guide.");
      activity.begin();
      vi.mocked(readFile).mockClear();
      const prerequisite = host.terminalOptions.documentationWorkPrerequisite;
      if (!prerequisite) throw new Error("Missing actual host prerequisite observation.");
      // The SDK can emit start/end for an unknown malformed call without invoking a host tool.
      for (const [toolCallId, toolName] of [
        ["missing-name", undefined],
        ["empty-name", ""],
        ["null-name", null],
        ["numeric-name", 0],
        ["object-name", { toString: null }],
        [undefined, "read"],
        ["", "read"],
        [null, "read"],
        [0, "read"],
        [{ toString: null }, "read"],
        [undefined, undefined],
      ] as const) {
        expect(prerequisite.consume(toolCallId as never, toolName as never)).toBe(false);
        chunks.length = 0;
        expect(() =>
          activity.handle({
            type: "tool_execution_start",
            toolCallId,
            toolName,
            args: {},
          } as unknown as AgentSessionEvent),
        ).not.toThrow();
        activity.handle({
          type: "tool_execution_end",
          toolCallId,
          toolName,
          isError: true,
          result: {
            content: [{ type: "text", text: `${DOCUMENTATION_WORK_REFUSAL} private-sdk-error` }],
          },
        } as unknown as AgentSessionEvent);
        expect(chunks.join("")).toContain("[Failed]");
        expect(chunks.join("")).toContain("unclassified");
        expect(chunks.join("")).not.toContain("[Blocked]");
        expect(chunks.join("")).not.toContain(DOCUMENTATION_WORK_PREREQUISITE_ACTION);
        expect(chunks.join("")).not.toContain("private-sdk-error");
        expect(contentReads()).toHaveLength(0);
      }
      // A valid actual admission and loaded-skill retry still recover after malformed events.
      chunks.length = 0;
      await expect(observedRead("same-read")).rejects.toThrow(DOCUMENTATION_WORK_REFUSAL);
      expect(contentReads()).toHaveLength(0);
      expect(chunks.join("")).toContain("[Blocked] Reading repository evidence");
      expect(chunks.join("")).toContain(DOCUMENTATION_WORK_PREREQUISITE_ACTION);
      expect(chunks.join("")).not.toMatch(/unclassified|maintainers|Admitted guide/u);

      // A later SDK error without a new admission cannot replay the consumed host fact.
      chunks.length = 0;
      activity.handle({
        type: "tool_execution_start",
        toolName: "read",
        toolCallId: "same-read",
        args: {},
      });
      activity.handle({
        type: "tool_execution_end",
        toolName: "read",
        toolCallId: "same-read",
        isError: true,
        result: { content: [{ type: "text", text: DOCUMENTATION_WORK_REFUSAL }] },
      } as AgentSessionEvent);
      expect(chunks.join("")).toContain("[Failed]");
      expect(chunks.join("")).toContain("unclassified");
      expect(chunks.join("")).not.toContain("[Blocked]");
      expect(contentReads()).toHaveLength(0);

      await useSkill.execute(
        "reference",
        { skill: installedWritingSkill, reference: "references/content-map.md" },
        undefined,
        undefined,
        {} as never,
      );
      chunks.length = 0;
      await expect(observedRead("same-read")).rejects.toThrow(DOCUMENTATION_WORK_REFUSAL);
      expect(contentReads()).toHaveLength(0);
      expect(chunks.join("")).toContain("[Blocked]");

      await useSkill.execute(
        "main-skill",
        { skill: installedWritingSkill },
        undefined,
        undefined,
        {} as never,
      );
      chunks.length = 0;
      expect(JSON.stringify(await observedRead("same-read"))).toContain("# Admitted guide");
      expect(contentReads().length).toBeGreaterThan(0);
      expect(chunks.join("")).toContain("[Done] Reading repository evidence");
      expect(chunks.join("")).not.toMatch(/Blocked|unclassified|maintainers/u);

      chunks.length = 0;
      await expect(observedTool("read", "malformed-read", { path: null } as never)).rejects.toThrow(
        safeFailureMessage("denied-path"),
      );
      expect(chunks.join("")).not.toContain("[Blocked]");
      expect(chunks.join("")).not.toContain(DOCUMENTATION_WORK_PREREQUISITE_ACTION);

      // An identical typed error from the underlying reader is not admission evidence.
      vi.mocked(readFile).mockRejectedValueOnce(new DocumentationWorkPrerequisiteError());
      chunks.length = 0;
      await expect(observedRead("same-read")).rejects.toThrow(safeFailureMessage("tool-defect"));
      expect(chunks.join("")).toContain("[Failed]");
      expect(chunks.join("")).toContain("unclassified");
      expect(chunks.join("")).not.toContain("[Blocked]");
      expect(chunks.join("")).not.toContain(DOCUMENTATION_WORK_PREREQUISITE_ACTION);

      vi.mocked(readFile).mockReset().mockImplementation(actualFs.readFile);
      chunks.length = 0;
      await expect(
        observedTool("write", "source-write", {
          path: "src/code.ts",
          content: "changed source\n",
        }),
      ).rejects.toThrow(/outside this session's documentation scope/u);
      expect(await actualFs.readFile(join(repositoryPath, "src/code.ts"), "utf8")).toBe(
        "export const unchanged = true;\n",
      );
      expect(chunks.join("")).not.toContain("[Blocked]");
      expect(chunks.join("")).not.toContain(DOCUMENTATION_WORK_PREREQUISITE_ACTION);

      for (const code of [undefined, "workflow-cancelled"] as const) {
        host.terminalOptions.onUserTurn?.("A workflow stopped before repository editing.");
        host.workflowFailure.recordFailure({
          kind: "no-run-record",
          workflow,
          ...(code ? { code } : {}),
        });
        chunks.length = 0;
        await expect(
          observedTool("write", "stopped-write", {
            path: "docs/index.md",
            content: "must not be written\n",
          }),
        ).rejects.toThrow(LIVE_WORKFLOW_FAILURE_GATE_MESSAGES.directChange);
        expect(chunks.join("")).not.toContain("[Blocked]");
        expect(chunks.join("")).not.toContain(DOCUMENTATION_WORK_PREREQUISITE_ACTION);
        expect(await actualFs.readFile(page, "utf8")).toBe("# Admitted guide\n");
      }

      host.terminalOptions.onUserTurn?.("A new operator turn has no loaded skill.");
      chunks.length = 0;
      await expect(observedRead("new-turn")).rejects.toThrow(DOCUMENTATION_WORK_REFUSAL);
      expect(chunks.join("")).toContain("[Blocked]");
    } finally {
      activity.dispose();
      vi.mocked(readFile).mockReset().mockImplementation(actualFs.readFile);
    }
  });

  it("projects actual bash prerequisites after input checks and permits loaded-skill approval without command execution", async () => {
    const root = await roots.create("docsfab-work-command-activity-");
    const repositoryPath = join(root, "repo");
    const stateDirectory = join(root, "state");
    const page = join(repositoryPath, "docs/index.md");
    await mkdir(stateDirectory, { recursive: true });
    await initFixtureRepo(repositoryPath, { "docs/index.md": "# Guide\n" }, { branch: "main" });
    const config = capabilityConfig(stateDirectory);
    const host = await assembleLiveAgentHost({
      repositoryPath,
      allowWrite: true,
      environment: { PATH: process.env.PATH, NO_COLOR: "1" },
      config,
      capabilities: await loadLiveAgentCapabilities(config),
      sourcePorts: {} as never,
      onNotice: () => undefined,
      writeError: () => undefined,
      runWorkflow: (() => Promise.reject(new Error("unexpected workflow"))) as never,
    });
    const command = host.customTools.find((tool) => tool.name === "bash");
    const useSkill = host.customTools.find((tool) => tool.name === "docsfab_use_skill");
    const prerequisite = host.terminalOptions.documentationWorkPrerequisite;
    if (!command || !useSkill || !prerequisite)
      throw new Error("Missing real command, installed skill or prerequisite observation.");
    const chunks: string[] = [];
    const activity = new LiveAgentActivityRenderer({
      ...host.terminalOptions,
      tty: false,
      write: (text) => chunks.push(text),
    });
    const finishFailure = (toolCallId: unknown, toolName: unknown = "bash") =>
      activity.handle({
        type: "tool_execution_end",
        toolCallId,
        toolName,
        isError: true,
        result: {
          content: [{ type: "text", text: DOCUMENTATION_WORK_REFUSAL }],
          details: { prerequisite: true, toolCallId, toolName },
        },
      } as unknown as AgentSessionEvent);
    const observedCommand = async (
      toolCallId: unknown,
      args: unknown = { command: "touch docs/should-not-run.md" },
      signal?: AbortSignal,
    ) => {
      chunks.length = 0;
      activity.handle({
        type: "tool_execution_start",
        toolName: "bash",
        toolCallId,
        args,
      } as unknown as AgentSessionEvent);
      try {
        const result = await command.execute(
          toolCallId as never,
          args,
          signal,
          undefined,
          {} as never,
        );
        activity.handle({
          type: "tool_execution_end",
          toolName: "bash",
          toolCallId,
          result,
          isError: false,
        } as unknown as AgentSessionEvent);
        return result;
      } catch (error) {
        // The SDK error projection retains text only; the host callback carries trust.
        activity.handle({
          type: "tool_execution_end",
          toolName: "bash",
          toolCallId,
          isError: true,
          result: {
            content: [
              { type: "text", text: error instanceof Error ? error.message : String(error) },
            ],
          },
        } as unknown as AgentSessionEvent);
        throw error;
      }
    };
    const confirm = vi.fn(async () => false);
    host.terminalOptions.setPublicationConfirmation?.(confirm);
    const actualChild =
      await vi.importActual<typeof import("node:child_process")>("node:child_process");
    vi.mocked(spawn)
      .mockClear()
      .mockImplementation(() => {
        throw new Error("No host command may execute in the admission activity test.");
      });
    const contentReads = () => vi.mocked(readFile).mock.calls.filter(([path]) => path === page);
    try {
      host.terminalOptions.onUserTurn?.("Update the guide.");
      activity.begin();
      vi.mocked(readFile).mockClear();
      await expect(observedCommand("command")).rejects.toThrow(DOCUMENTATION_WORK_REFUSAL);
      expect(chunks.join("")).toContain("[Blocked] Running approved host command");
      expect(chunks.join("")).toContain(DOCUMENTATION_WORK_PREREQUISITE_ACTION);
      expect(chunks.join("")).not.toMatch(/unclassified|maintainers/u);
      expect(confirm).not.toHaveBeenCalled();
      expect(contentReads()).toHaveLength(0);

      // A consumed fact, lookalike JSON, or a different name cannot attest an admission.
      chunks.length = 0;
      activity.handle({
        type: "tool_execution_start",
        toolName: "bash",
        toolCallId: "command",
        args: {},
      });
      finishFailure("command");
      expect(chunks.join("")).toContain("[Failed]");
      expect(chunks.join("")).not.toContain("[Blocked]");
      activity.handle({
        type: "tool_execution_start",
        toolName: "bash",
        toolCallId: "wrong-name",
        args: {},
      });
      await expect(
        command.execute("wrong-name", { command: "true" }, undefined, undefined, {} as never),
      ).rejects.toThrow(DOCUMENTATION_WORK_REFUSAL);
      chunks.length = 0;
      finishFailure("wrong-name", "read");
      expect(chunks.join("")).not.toContain("[Blocked]");
      expect(prerequisite.consume("wrong-name", "bash")).toBe(false);

      for (const toolCallId of [undefined, null, "", 0, { toString: null }]) {
        await expect(observedCommand(toolCallId)).rejects.toThrow(DOCUMENTATION_WORK_REFUSAL);
        expect(chunks.join("")).toContain("[Failed]");
        expect(chunks.join("")).toContain("unclassified");
        expect(chunks.join("")).not.toContain("[Blocked]");
      }

      // An invalid retry without a renderer start must clear the earlier host fact.
      await expect(
        command.execute("stale", { command: "true" }, undefined, undefined, {} as never),
      ).rejects.toThrow(DOCUMENTATION_WORK_REFUSAL);
      await expect(
        command.execute("stale", { command: "" }, undefined, undefined, {} as never),
      ).rejects.toThrow(LIVE_COMMAND_FAILURES.input);
      expect(prerequisite.consume("stale", "bash")).toBe(false);
      for (const args of [
        { command: "" },
        { command: "true", timeout: 0 },
        { command: "true", extra: true },
      ]) {
        await expect(observedCommand("invalid-input", args)).rejects.toThrow(
          LIVE_COMMAND_FAILURES.input,
        );
        expect(chunks.join("")).not.toContain("[Blocked]");
      }
      const credential = configureCredential("fixture-command-credential");
      await expect(
        observedCommand("credential", { command: `echo ${credential}` }),
      ).rejects.toThrow(LIVE_COMMAND_FAILURES.credentials);
      expect(chunks.join("")).not.toContain("[Blocked]");
      const abort = new AbortController();
      abort.abort();
      expect((await observedCommand("aborted", undefined, abort.signal)).details).toMatchObject({
        status: "cancelled",
      });
      expect(chunks.join("")).not.toContain("[Blocked]");
      expect(confirm).not.toHaveBeenCalled();
      expect(contentReads()).toHaveLength(0);

      await useSkill.execute(
        "reference",
        { skill: installedWritingSkill, reference: "references/content-map.md" },
        undefined,
        undefined,
        {} as never,
      );
      await expect(observedCommand("command")).rejects.toThrow(DOCUMENTATION_WORK_REFUSAL);
      expect(chunks.join("")).toContain("[Blocked]");
      expect(confirm).not.toHaveBeenCalled();
      expect(contentReads()).toHaveLength(0);
      await useSkill.execute(
        "main-skill",
        { skill: installedWritingSkill },
        undefined,
        undefined,
        {} as never,
      );
      expect((await observedCommand("command")).details).toMatchObject({ status: "cancelled" });
      expect(confirm).toHaveBeenCalledOnce();
      expect(chunks.join("")).toContain("[Cancelled]");
      expect(chunks.join("")).not.toContain("[Blocked]");

      // A typed exception after admission is still an ordinary genuine failure.
      host.terminalOptions.setPublicationConfirmation?.(async () => {
        throw new DocumentationWorkPrerequisiteError();
      });
      await expect(observedCommand("post-admission")).rejects.toThrow(DOCUMENTATION_WORK_REFUSAL);
      expect(chunks.join("")).toContain("[Failed]");
      expect(chunks.join("")).toContain("unclassified");
      expect(chunks.join("")).not.toContain("[Blocked]");

      let releaseApproval!: (approved: boolean) => void;
      let reachedApproval!: () => void;
      const entered = new Promise<void>((resolve) => {
        reachedApproval = resolve;
      });
      const approval = new Promise<boolean>((resolve) => {
        releaseApproval = resolve;
      });
      host.terminalOptions.setPublicationConfirmation?.(async () => {
        reachedApproval();
        return approval;
      });
      const activeCommand = observedCommand("active");
      try {
        await entered;
        await expect(observedCommand("concurrent")).rejects.toThrow(LIVE_COMMAND_FAILURES.busy);
        expect(chunks.join("")).not.toContain("[Blocked]");
      } finally {
        releaseApproval(false);
        expect((await activeCommand).details).toMatchObject({ status: "cancelled" });
      }

      host.terminalOptions.setPublicationConfirmation?.(confirm);
      confirm.mockClear();
      for (const code of [undefined, "workflow-cancelled"] as const) {
        host.terminalOptions.onUserTurn?.("A workflow stopped before command approval.");
        host.workflowFailure.recordFailure({
          kind: "no-run-record",
          workflow,
          ...(code ? { code } : {}),
        });
        await expect(observedCommand("stopped-command")).rejects.toThrow(
          LIVE_WORKFLOW_FAILURE_GATE_MESSAGES.directChange,
        );
        expect(chunks.join("")).not.toContain("[Blocked]");
      }
      expect(confirm).not.toHaveBeenCalled();
      expect(contentReads()).toHaveLength(0);
      expect(spawn).not.toHaveBeenCalled();
      await expect(access(join(repositoryPath, "docs/should-not-run.md"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      activity.dispose();
      vi.mocked(spawn).mockReset().mockImplementation(actualChild.spawn);
    }
  });

  it("types only missing selection or load, preserving failed, cancelled, invalid-selection and authority refusals", () => {
    const capture = (admit: () => void) => {
      try {
        admit();
      } catch (error) {
        return error;
      }
      throw new Error("Expected documentation admission refusal.");
    };
    const work = state();
    work.beginTurn();
    expect(capture(() => work.admitRepositoryTool())).toBeInstanceOf(
      DocumentationWorkPrerequisiteError,
    );
    work.selectSkill(skill);
    expect(capture(() => work.admitRepositoryTool())).toBeInstanceOf(
      DocumentationWorkPrerequisiteError,
    );
    expect(capture(() => work.admitReviewEvidenceTool())).toBeInstanceOf(
      DocumentationWorkPrerequisiteError,
    );
    work.selectSavedResult("saved-result");
    expect(capture(() => work.admitRepositoryTool())).not.toBeInstanceOf(
      DocumentationWorkPrerequisiteError,
    );
    for (const error of ["workflow-failed", "workflow-cancelled"]) {
      work.beginTurn();
      work.selectWorkflow(workflow);
      work.recordWorkflowOutcome("failed", error);
      expect(() => work.admitRepositoryTool()).toThrow(DOCUMENTATION_WORK_FAILURE_REFUSAL);
      expect(capture(() => work.admitRepositoryTool())).not.toBeInstanceOf(
        DocumentationWorkPrerequisiteError,
      );
    }
    const unauthorized = state(() => {
      throw new Error(DOCUMENTATION_WORK_REFUSAL);
    });
    expect(() => unauthorized.admitRepositoryTool()).toThrow(DOCUMENTATION_WORK_REFUSAL);
    expect(capture(() => unauthorized.admitRepositoryTool())).not.toBeInstanceOf(
      DocumentationWorkPrerequisiteError,
    );
  });

  it("keeps repository tools closed when a skill read succeeds but reader handoff fails", async () => {
    const root = await roots.create("docsfab-work-skill-handoff-");
    const config = capabilityConfig(root);
    const capabilities = await loadLiveAgentCapabilities(config);
    const planSkill = "plan-documentation" as CatalogSkillId;
    const work = createDocumentationWorkState({
      skillIds: [planSkill],
      workflowIds: [],
      workflowSkillIds: new Map(),
      verifyCurrent: () => undefined,
    });
    work.beginTurn();
    let attemptedHandoff = false;
    const useSkill = createLiveAgentToolDefinitions({
      capabilities,
      async runWorkflow() {
        throw new Error("No workflow expected in skill handoff test.");
      },
      async prepareReaderTaskContext() {
        attemptedHandoff = true;
        throw new Error("fixture reader handoff failed");
      },
      documentationWork: work,
    }).find((tool) => tool.name === "docsfab_use_skill");
    if (!useSkill) throw new Error("Missing skill tool.");

    await expect(
      useSkill.execute(
        "failed-skill",
        {
          skill: planSkill,
          readerContext: {
            schema_version: 1,
            target_audience: "operators",
            reader_job: "run an inspection",
            change_scope: ["docs/cli.md"],
            source_priority: ["public CLI", "current docs"],
            required_content: ["command", "verification"],
            excluded_content: [],
            unresolved_questions: [],
          },
        },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow("fixture reader handoff failed");
    expect(attemptedHandoff).toBe(true);
    expect(() => work.admitRepositoryTool()).toThrow(DOCUMENTATION_WORK_REFUSAL);
  });

  it("keeps reference-only work closed and preserves main-skill proof through a later reference", async () => {
    const root = await roots.create("docsfab-work-reference-only-");
    const config = capabilityConfig(root);
    const capabilities = await loadLiveAgentCapabilities(config);
    const work = createDocumentationWorkState({
      skillIds: [installedWritingSkill],
      workflowIds: [],
      workflowSkillIds: new Map(),
      verifyCurrent: () => undefined,
    });
    work.beginTurn();
    const useSkill = createLiveAgentToolDefinitions({
      capabilities,
      async runWorkflow() {
        throw new Error("No workflow expected in skill reference test.");
      },
      documentationWork: work,
    }).find((tool) => tool.name === "docsfab_use_skill");
    if (!useSkill) throw new Error("Missing skill tool.");

    const reference = await useSkill.execute(
      "reference",
      { skill: installedWritingSkill, reference: "references/content-map.md" },
      undefined,
      undefined,
      {} as never,
    );
    expect(reference.details).toMatchObject({ kind: "docsfab-live-skill-reference" });
    expect(() => work.admitRepositoryTool()).toThrow(DOCUMENTATION_WORK_REFUSAL);

    const instructions = await useSkill.execute(
      "instructions",
      { skill: installedWritingSkill },
      undefined,
      undefined,
      {} as never,
    );
    expect(instructions.details).toMatchObject({ kind: "docsfab-live-skill" });
    expect(() => work.admitRepositoryTool()).not.toThrow();

    const laterReference = await useSkill.execute(
      "later-reference",
      { skill: installedWritingSkill, reference: "references/content-map.md" },
      undefined,
      undefined,
      {} as never,
    );
    expect(laterReference.details).toMatchObject({ kind: "docsfab-live-skill-reference" });
    expect(() => work.admitRepositoryTool()).not.toThrow();

    work.beginTurn();
    expect(() => work.admitRepositoryTool()).toThrow(DOCUMENTATION_WORK_REFUSAL);
  });

  it("keeps an assembled repository read available after a loaded skill's supporting reference", async () => {
    const root = await roots.create("docsfab-work-loaded-reference-");
    const repositoryPath = join(root, "repo");
    const stateDirectory = join(root, "state");
    await mkdir(stateDirectory, { recursive: true });
    await initFixtureRepo(repositoryPath, { "docs/index.md": "# Guide\n" }, { branch: "main" });
    const config = capabilityConfig(stateDirectory);
    const host = await assembleLiveAgentHost({
      repositoryPath,
      allowWrite: true,
      environment: { PATH: process.env.PATH },
      config,
      capabilities: await loadLiveAgentCapabilities(config),
      sourcePorts: {} as never,
      onNotice: () => undefined,
      writeError: () => undefined,
      runWorkflow: (() => Promise.reject(new Error("unexpected workflow"))) as never,
    });
    const useSkill = host.customTools.find((candidate) => candidate.name === "docsfab_use_skill");
    const read = host.customTools.find((candidate) => candidate.name === "read");
    if (!useSkill || !read) throw new Error("Missing installed skill or repository read tool.");
    const readPage = () =>
      read.execute("read-page", { path: "docs/index.md" }, undefined, undefined, {} as never);

    host.terminalOptions.onUserTurn?.("Inspect the documentation guide.");
    await expect(readPage()).rejects.toThrow(DOCUMENTATION_WORK_REFUSAL);
    await useSkill.execute(
      "main",
      { skill: installedWritingSkill },
      undefined,
      undefined,
      {} as never,
    );
    await useSkill.execute(
      "reference",
      { skill: installedWritingSkill, reference: "references/content-map.md" },
      undefined,
      undefined,
      {} as never,
    );
    expect(JSON.stringify(await readPage())).toContain("# Guide");

    host.terminalOptions.onUserTurn?.("A new question arrived.");
    await expect(readPage()).rejects.toThrow(DOCUMENTATION_WORK_REFUSAL);
  });

  it("keeps normal conversation open while requiring a loaded skill before repository tools", () => {
    const work = state();
    work.beginTurn();
    expect(work.selection).toBeUndefined();
    expect(() => work.admitRepositoryTool()).toThrow(DOCUMENTATION_WORK_REFUSAL);

    work.selectSkill(skill);
    expect(() => work.admitRepositoryTool()).toThrow(DOCUMENTATION_WORK_REFUSAL);
    work.markSkillLoaded(skill);
    expect(() => work.admitRepositoryTool()).not.toThrow();

    work.selectSkill(secondSkill);
    expect(() => work.admitRepositoryTool()).toThrow(DOCUMENTATION_WORK_REFUSAL);
    work.markSkillLoaded(secondSkill);
    expect(() => work.admitRepositoryTool()).not.toThrow();
    expect(work.selection).toMatchObject({ kind: "skills", skillIds: [skill, secondSkill] });
  });

  it("keeps failed objectives closed, then reopens only the preserved workflow on retry", () => {
    const work = state();
    work.beginTurn();
    work.selectWorkflow(workflow);
    work.admitWorkflow(workflow);
    work.recordWorkflowOutcome("failed", "test-failure");
    expect(() => work.admitWorkflow(workflow)).toThrow(DOCUMENTATION_WORK_FAILURE_REFUSAL);
    expect(() => work.admitRepositoryTool()).toThrow(DOCUMENTATION_WORK_FAILURE_REFUSAL);

    work.beginTurn({ workflowId: workflow, requestIntent: null });
    expect(work.selection).toMatchObject({ kind: "workflow", workflowId: workflow });
    expect(() => work.admitWorkflow(workflow)).not.toThrow();
    expect(() => work.admitRepositoryTool()).toThrow(DOCUMENTATION_WORK_REFUSAL);
  });

  it("supports loading workflow dependency skills and duplicate workflow observations", () => {
    const work = state();
    work.beginTurn();
    work.selectWorkflow(workflow);
    work.selectSkill(skill);
    expect(() => work.admitRepositoryTool()).toThrow(DOCUMENTATION_WORK_REFUSAL);
    work.markSkillLoaded(skill);
    expect(() => work.admitRepositoryTool()).not.toThrow();

    work.recordWorkflowOutcome("failed", "workflow-failure");
    expect(() => work.recordWorkflowOutcome("failed", "workflow-failure")).not.toThrow();
    expect(() => work.admitRepositoryTool()).toThrow(DOCUMENTATION_WORK_FAILURE_REFUSAL);
  });

  it("keeps loaded skill proof when the same objective becomes a workflow", () => {
    const work = state();
    work.beginTurn();
    work.selectSkill(skill);
    work.markSkillLoaded(skill);
    expect(() => work.admitRepositoryTool()).not.toThrow();

    work.selectWorkflow(workflow);
    expect(() => work.admitRepositoryTool()).not.toThrow();
    work.selectWorkflow(workflow);
    expect(() => work.admitRepositoryTool()).not.toThrow();

    work.recordWorkflowOutcome("failed", "fixture-workflow-failed");
    expect(() => work.admitRepositoryTool()).toThrow(DOCUMENTATION_WORK_FAILURE_REFUSAL);
    // A workflow retry is allowed, but failed work does not carry skill proof
    // into direct repository tools in the retry attempt.
    work.selectWorkflow(workflow);
    expect(() => work.admitWorkflow(workflow)).not.toThrow();
    expect(() => work.admitRepositoryTool()).toThrow(DOCUMENTATION_WORK_REFUSAL);

    // A new turn has no loaded-skill proof even if it selects that workflow.
    work.beginTurn();
    work.selectWorkflow(workflow);
    expect(() => work.admitRepositoryTool()).toThrow(DOCUMENTATION_WORK_REFUSAL);
  });

  it("keeps a cancelled workflow closed until a new operator turn", () => {
    const work = state();
    work.beginTurn();
    work.selectWorkflow(workflow);
    work.recordWorkflowOutcome("failed", "workflow-cancelled");

    expect(work.phase).toBe("cancelled");
    expect(() => work.selectWorkflow(workflow)).toThrow(DOCUMENTATION_WORK_FAILURE_REFUSAL);
    expect(() => work.selectSkill(skill)).toThrow(DOCUMENTATION_WORK_FAILURE_REFUSAL);
    expect(() => work.admitWorkflow(workflow)).toThrow(DOCUMENTATION_WORK_FAILURE_REFUSAL);

    work.beginTurn();
    work.selectWorkflow(workflow);
    expect(() => work.selectSkill(skill)).not.toThrow();
    expect(() => work.admitWorkflow(workflow)).not.toThrow();
  });

  it("refuses a supporting skill reference after workflow cancellation", async () => {
    const root = await roots.create("docsfab-work-cancelled-reference-");
    const config = capabilityConfig(root);
    const work = createDocumentationWorkState({
      skillIds: [installedWritingSkill],
      workflowIds: ["update-documentation" as RunnableWorkflowName],
      workflowSkillIds: new Map([
        ["update-documentation" as RunnableWorkflowName, [installedWritingSkill]],
      ]),
      verifyCurrent: () => undefined,
    });
    work.beginTurn();
    work.selectWorkflow("update-documentation" as RunnableWorkflowName);
    work.recordWorkflowOutcome("failed", "workflow-cancelled");
    const useSkill = createLiveAgentToolDefinitions({
      capabilities: await loadLiveAgentCapabilities(config),
      async runWorkflow() {
        throw new Error("No workflow expected in cancelled reference test.");
      },
      documentationWork: work,
    }).find((tool) => tool.name === "docsfab_use_skill");
    if (!useSkill) throw new Error("Missing skill tool.");

    await expect(
      useSkill.execute(
        "cancelled-reference",
        { skill: installedWritingSkill, reference: "references/content-map.md" },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow(DOCUMENTATION_WORK_FAILURE_REFUSAL);
  });

  it("allows the existing explicit edit-anyway recovery while preventing a workflow rerun", () => {
    const work = state();
    work.beginTurn({ workflowId: workflow, requestIntent: null, directEditFallback: true });
    expect(() => work.admitRepositoryTool()).not.toThrow();
    expect(() => work.admitWorkflow(workflow)).toThrow(DOCUMENTATION_WORK_FAILURE_REFUSAL);
  });

  it("rechecks current host and source authority on every admission", () => {
    let sourceBound = true;
    const work = state(() => {
      if (!sourceBound) throw new Error(DOCUMENTATION_WORK_REFUSAL);
    });
    work.beginTurn();
    work.selectSkill(skill);
    work.markSkillLoaded(skill);
    expect(() => work.admitRepositoryTool()).not.toThrow();
    sourceBound = false;
    expect(() => work.admitRepositoryTool()).toThrow(DOCUMENTATION_WORK_REFUSAL);
  });

  it("blocks PR-head claims while keeping local authoring with PR evidence available", () => {
    expect(() => assertDocumentationWorkflowSourceReady(workflow, true)).toThrow(
      /workspace is not bound to that pull-request revision/u,
    );
    expect(() =>
      assertDocumentationWorkflowSourceReady("update-documentation", true),
    ).not.toThrow();
    expect(() =>
      assertDocumentationWorkflowSourceReady("review-documentation", false),
    ).not.toThrow();
  });

  it("admits only exact operator-named review locators and refuses malformed PR-shaped URLs", () => {
    const message =
      "Review https://github.com/voice-team/agent-docs/pull/161 and preserve this local target.";
    const [reference] = operatorNamedChangeReviewReferences(message);
    expect(reference).toBe("https://github.com/voice-team/agent-docs/pull/161");
    expect(parseLiveAgentChangeReviewReference(reference!)).toMatchObject({
      source: "github-pull-request",
      number: 161,
    });

    const malformed = operatorNamedChangeReviewReferences(
      "Review https://github.com/voice-team/agent-docs/pull/not-a-number",
    );
    expect(malformed).toEqual(["https://github.com/voice-team/agent-docs/pull/not-a-number"]);
    expect(() => parseLiveAgentChangeReviewReference(malformed[0]!)).toThrow();
    expect(
      operatorNamedChangeReviewReferences(
        "Compare https://github.com/a/b/pull/1 and https://github.com/c/d/pull/2",
      ),
    ).toHaveLength(2);
  });

  it("reads the second tool argument as the operator-named saved run ID", async () => {
    const root = await roots.create("docsfab-work-admission-");
    const repositoryPath = join(root, "repo");
    const stateDirectory = join(root, "state");
    await mkdir(stateDirectory, { recursive: true });
    await initFixtureRepo(repositoryPath, { "docs/index.md": "# Guide\n" }, { branch: "main" });
    const host = await assembleLiveAgentHost({
      repositoryPath,
      allowWrite: false,
      environment: { PATH: process.env.PATH },
      config: {
        projectRoot: runtimeRoot,
        stateDirectory,
        model: { provider: "none", model: "none" },
      } as unknown as DocsFabConfig,
      capabilities: {
        skills: [],
        qualityPack: { id: "docsfab-default", version: "1.0.0" } as never,
        workflows: [],
      },
      sourcePorts: {} as never,
      onNotice: () => undefined,
      writeError: () => undefined,
      runWorkflow: (() => Promise.reject(new Error("unexpected workflow"))) as never,
    });
    host.terminalOptions.onUserTurn?.("Inspect saved run saved-run-id");
    const tool = host.customTools.find((candidate) => candidate.name === "docsfab_read_run");
    if (!tool) throw new Error("Missing saved-run read tool.");
    await expect(
      tool.execute("read", { runId: "saved-run-id" }, undefined, undefined, {} as never),
    ).rejects.toThrow(SAVED_RUN_FAILURES.unavailable);

    host.terminalOptions.onUserTurn?.("Inspect saved run saved-run-id-long");
    expect(() =>
      tool.execute("shorter", { runId: "saved-run-id" }, undefined, undefined, {} as never),
    ).toThrow(DOCUMENTATION_WORK_REFUSAL);
    await expect(
      tool.execute("exact", { runId: "saved-run-id-long" }, undefined, undefined, {} as never),
    ).rejects.toThrow(SAVED_RUN_FAILURES.unavailable);

    host.terminalOptions.onUserTurn?.("Inspect saved run saved-run-id.foo");
    expect(() =>
      tool.execute("shorter-dotted", { runId: "saved-run-id" }, undefined, undefined, {} as never),
    ).toThrow(DOCUMENTATION_WORK_REFUSAL);
    await expect(
      tool.execute(
        "exact-dotted",
        { runId: "saved-run-id.foo" },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow(SAVED_RUN_FAILURES.unavailable);

    host.terminalOptions.onUserTurn?.("Inspect saved run unrelated-id");
    expect(() =>
      tool.execute("unrelated", { runId: "saved-run-id" }, undefined, undefined, {} as never),
    ).toThrow(DOCUMENTATION_WORK_REFUSAL);

    host.terminalOptions.onUserTurn?.("Inspect saved run saved-run-id.");
    await expect(
      tool.execute("sentence", { runId: "saved-run-id" }, undefined, undefined, {} as never),
    ).rejects.toThrow(SAVED_RUN_FAILURES.unavailable);
  });

  it("rechecks the selected objective after command approval and before mutation", async () => {
    const root = await roots.create("docsfab-work-command-race-");
    const repositoryPath = join(root, "repo");
    const stateDirectory = join(root, "state");
    await mkdir(stateDirectory, { recursive: true });
    await initFixtureRepo(repositoryPath, { "docs/index.md": "# Guide\n" }, { branch: "main" });
    const config = capabilityConfig(stateDirectory);
    const host = await assembleLiveAgentHost({
      repositoryPath,
      allowWrite: true,
      environment: { PATH: process.env.PATH },
      config,
      capabilities: await loadLiveAgentCapabilities(config),
      sourcePorts: {} as never,
      onNotice: () => undefined,
      writeError: () => undefined,
      runWorkflow: (() => Promise.reject(new Error("unexpected workflow"))) as never,
    });
    const useSkill = host.customTools.find((candidate) => candidate.name === "docsfab_use_skill");
    const command = host.customTools.find((candidate) => candidate.name === "bash");
    if (!useSkill || !command) throw new Error("Missing admitted skill or command tool.");

    host.terminalOptions.onUserTurn?.("Update the operator guide.");
    await useSkill.execute(
      "skill",
      { skill: installedWritingSkill },
      undefined,
      undefined,
      {} as never,
    );
    host.terminalOptions.setPublicationConfirmation?.(async () => {
      host.terminalOptions.onUserTurn?.("A new ordinary question arrived.");
      return true;
    });
    const chunks: string[] = [];
    const activity = new LiveAgentActivityRenderer({
      ...host.terminalOptions,
      tty: false,
      write: (text) => chunks.push(text),
    });
    const actualChild =
      await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const commandSpawns: string[] = [];
    vi.mocked(spawn).mockImplementation((...args) => {
      // Sandbox bookkeeping may inspect the fixture index; the proposed command must not start.
      if (args[0] === "git") return actualChild.spawn(...args);
      commandSpawns.push(args[0]);
      throw new Error("No host command may execute in the post-approval admission test.");
    });
    try {
      activity.begin();
      activity.handle({
        type: "tool_execution_start",
        toolName: "bash",
        toolCallId: "command",
        args: { command: "touch docs/should-not-run.md" },
      });
      await expect(
        command.execute(
          "command",
          { command: "touch docs/should-not-run.md" },
          undefined,
          undefined,
          {} as never,
        ),
      ).rejects.toThrow(DOCUMENTATION_WORK_REFUSAL);
      activity.handle({
        type: "tool_execution_end",
        toolName: "bash",
        toolCallId: "command",
        isError: true,
        result: { content: [{ type: "text", text: DOCUMENTATION_WORK_REFUSAL }] },
      } as AgentSessionEvent);
      expect(chunks.join("")).toContain("[Blocked] Running approved host command");
      expect(chunks.join("")).toContain(DOCUMENTATION_WORK_PREREQUISITE_ACTION);
      expect(chunks.join("")).not.toMatch(/unclassified|maintainers/u);
      expect(commandSpawns).toEqual([]);
      await expect(access(join(repositoryPath, "docs/should-not-run.md"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      activity.dispose();
      vi.mocked(spawn).mockReset().mockImplementation(actualChild.spawn);
    }
  });

  it("refuses unsupported GitLab PR-head review before dispatch but preserves attached-source authoring", async () => {
    const root = await roots.create("docsfab-pr-workspace-admission-");
    const repositoryPath = join(root, "repo");
    const stateDirectory = join(root, "state");
    await mkdir(stateDirectory, { recursive: true });
    await initFixtureRepo(repositoryPath, { "docs/index.md": "# Guide\n" }, { branch: "main" });
    const config = capabilityConfig(stateDirectory);
    const capabilities = await loadLiveAgentCapabilities(config);
    const requests: Record<string, unknown>[] = [];
    const host = await assembleLiveAgentHost({
      repositoryPath,
      allowWrite: false,
      environment: { PATH: process.env.PATH },
      config,
      capabilities,
      changeSource: parseLiveAgentChangeReviewReference(
        "https://gitlab.com/voice-team/agent-docs/-/merge_requests/161",
      ),
      sourcePorts: {} as never,
      onNotice: () => undefined,
      writeError: () => undefined,
      runWorkflow: (async (request: Record<string, unknown>) => {
        requests.push(request);
        throw new Error("fixture runner reached");
      }) as never,
    });
    const tool = host.customTools.find((candidate) => candidate.name === "docsfab_run_workflow");
    if (!tool) throw new Error("Missing bounded workflow tool.");

    const reviewInstruction = "Review documentation in this pull request.";
    host.terminalOptions.onUserTurn?.(reviewInstruction);
    await expect(
      tool.execute(
        "review",
        { workflow: "review-documentation", instruction: reviewInstruction },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow(/workspace is not bound to that pull-request revision/u);
    expect(requests).toHaveLength(0);

    const authoringInstruction =
      "Update the local documentation using https://gitlab.com/voice-team/agent-docs/-/merge_requests/161 as evidence.";
    host.terminalOptions.onUserTurn?.(authoringInstruction);
    expect(await host.terminalOptions.prepareUserTurn?.(authoringInstruction)).toBeUndefined();
    await expect(
      tool.execute(
        "update",
        { workflow: "update-documentation", instruction: authoringInstruction },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow("fixture runner reached");
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      workflow: "update-documentation",
      changeSource: { source: "gitlab-merge-request", changeRequest: { number: 161 } },
    });

    const conflictingInstruction =
      "Update the local documentation using https://gitlab.com/voice-team/agent-docs/-/merge_requests/162 as evidence.";
    host.terminalOptions.onUserTurn?.(conflictingInstruction);
    expect(await host.terminalOptions.prepareUserTurn?.(conflictingInstruction)).toBe(
      SOURCE_COMMAND_REFUSALS["one-change-request"],
    );
    expect(requests).toHaveLength(1);
  });
});
