// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The shipped path: a real `PiHarness` planner step over a materialized
 * repository workspace, driven by a scripted provider, reads the base and head
 * of a change through the history tools. Its attempt evidence is decoded by
 * the strict record readers, and each citation's digest is recomputed from
 * the tool result the next provider request carried.
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import { InferenceStepError, type HarnessStepInput } from "../src/execution/contracts.js";
import { decodeTools } from "../src/execution/inference-evidence.js";
import { HISTORY_TOOL_NAMES, historyReaderForStep } from "../src/harness/history-tools.js";
import { createConfinedToolSet } from "../src/harness/confined-tools.js";
import { grantedToolsForStep } from "../src/harness/pi-tool-confine.js";
import { PiHarness } from "../src/harness/pi.js";
import { createModelConnection } from "../src/model/provider.js";
import type { RepositoryWorkspace } from "../src/repository/workspace/contracts.js";
import { prepareRepositoryWorkspace } from "../src/repository/workspace/materialize.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import { validModelConfig } from "./helpers.js";
import {
  BASE_APP,
  commitFiles,
  fixtureGit,
  HEAD_APP,
  historyFixture,
} from "./helpers/git-history-fixture.js";
import { temporaryRoots } from "./helpers/temp.js";
import { nestedDeadlineMs } from "./helpers/test-timeouts.js";
import {
  boundStyleContext,
  qualityDirectory,
  skillCrateDirectory,
  textTurn,
  toolTurn,
} from "./support/pi-harness-session-fixtures.js";

const roots = temporaryRoots();
const workspaces: RepositoryWorkspace[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const workspace of workspaces.splice(0)) await workspace.dispose();
});

/** Replays responses in order and keeps every request body. */
function recordingProvider(responses: readonly Response[]) {
  const bodies: string[] = [];
  let index = 0;
  const fetch = (async (_url: unknown, init?: { body?: unknown }) => {
    bodies.push(typeof init?.body === "string" ? init.body : "");
    const response = responses[index];
    index += 1;
    if (!response) throw new Error("Unexpected provider request.");
    return response.clone();
  }) as unknown as typeof globalThis.fetch;
  return { fetch, bodies };
}

/** The text of each tool result message a provider request carried, by call id. */
function toolResultTexts(body: string): Map<string, string> {
  const { messages } = JSON.parse(body) as {
    messages: Array<{ role: string; tool_call_id?: string; content: unknown }>;
  };
  return new Map(
    messages
      .filter((message) => message.role === "tool" && message.tool_call_id)
      .map((message) => [
        message.tool_call_id!,
        typeof message.content === "string"
          ? message.content
          : (message.content as Array<{ text?: string }>).map((part) => part.text ?? "").join(""),
      ]),
  );
}

/** The tool names a provider request offered the model. */
function offeredTools(body: string): string[] {
  const { tools } = JSON.parse(body) as { tools?: Array<{ function?: { name?: string } }> };
  return (tools ?? []).map((tool) => tool.function?.name ?? "");
}

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

function createPlanReply(): string {
  return JSON.stringify({
    summary: "Document the changed answer from the compared base and head.",
    planBinding: {
      mode: "create",
      pages: [{ path: "docs/answer.md", disposition: "create" }],
      sourceBindings: [{ pagePath: "docs/answer.md", sources: ["src/app.ts"] }],
    },
  });
}

async function runStep(
  workflowName: "create-documentation" | "restructure-documentation",
  stepId: string,
  responses: readonly Response[],
  options: { workspace?: RepositoryWorkspace; repositoryPath: string; toolCeiling?: string[] },
) {
  const provider = recordingProvider(responses);
  vi.stubGlobal("fetch", provider.fetch);
  const harness = new PiHarness({
    skillCrateDirectory,
    qualityDirectory,
    styleContext: await boundStyleContext(),
    model: validModelConfig,
    createConnection: createModelConnection,
    ...(options.workspace ? { repositoryWorkspace: options.workspace } : {}),
  });
  const workflow = getWorkflow(workflowName);
  const step = findStep(workflow, stepId);
  const input: HarnessStepInput = {
    runId: `history-${stepId}`,
    repositoryPath: options.repositoryPath,
    workflow,
    step,
    evidenceIdentity: { repositoryRevision: options.workspace?.revision ?? "a".repeat(40) },
    ...(options.toolCeiling ? { toolCeiling: options.toolCeiling } : {}),
  };
  try {
    const result = await harness.runStep(input);
    return { tools: result.tools, bodies: provider.bodies, error: undefined };
  } catch (error) {
    expect(error, String(error)).toBeInstanceOf(InferenceStepError);
    return {
      tools: (error as InferenceStepError).evidence?.tools,
      bodies: provider.bodies,
      error,
    };
  }
}

/** A step by id, in the shared steps or any branch. */
function findStep(workflow: ReturnType<typeof getWorkflow>, stepId: string) {
  const all = [
    ...workflow.steps,
    ...(
      (workflow as { branches?: Array<{ steps: typeof workflow.steps }> }).branches ?? []
    ).flatMap((branch) => branch.steps),
  ];
  const step = all.find((candidate) => candidate.id === stepId);
  if (!step) throw new Error(`The workflow has no step ${stepId}.`);
  return step;
}

async function materializedFixture() {
  const fixture = await historyFixture(roots);
  const workspace = await prepareRepositoryWorkspace(fixture.repository, "HEAD");
  workspaces.push(workspace);
  return { fixture, workspace };
}

describe("planner history reads through the real harness", () => {
  it(
    "cites a show at base and head and a diff between them, decoded by the strict readers",
    async () => {
      const { fixture, workspace } = await materializedFixture();
      const { tools, bodies, error } = await runStep(
        "create-documentation",
        "plan-documentation",
        [
          toolTurn([
            {
              id: "call-base",
              name: "docsfab_history_show",
              arguments: { path: "src/app.ts", revision: fixture.base },
            },
            {
              id: "call-head",
              name: "docsfab_history_show",
              arguments: { path: "src/app.ts", revision: "head" },
            },
            {
              id: "call-diff",
              name: "docsfab_history_diff",
              arguments: { base: fixture.base, head: "head" },
            },
          ]),
          textTurn(createPlanReply()),
          textTurn(createPlanReply()),
          textTurn(createPlanReply()),
        ],
        { workspace, repositoryPath: workspace.path },
      );
      expect(error, String(error)).toBeUndefined();
      // Never a hand parse: the strict decoder admits the attempt's tools.
      const decoded = decodeTools(tools);
      expect(decoded.presented).toEqual(expect.arrayContaining([...HISTORY_TOOL_NAMES]));
      const served = toolResultTexts(bodies[1]!);
      // Pi runs one turn's calls concurrently, so entries are in finishing order.
      const citations = decoded.historyReads!;
      const byCall = (tool: string, revisions: string[]) =>
        citations.find(
          (entry) =>
            entry.tool === tool && JSON.stringify(entry.revisions) === JSON.stringify(revisions),
        );
      const base = byCall("docsfab_history_show", [fixture.base]);
      const head = byCall("docsfab_history_show", [fixture.head]);
      const diff = byCall("docsfab_history_diff", [fixture.base, fixture.head]);
      expect(base).toEqual({
        tool: "docsfab_history_show",
        revisions: [fixture.base],
        paths: ["src/app.ts"],
        ranges: [{ path: "src/app.ts", unit: "bytes", start: 0, end: BASE_APP.length }],
        labels: [],
        sha256: sha256(served.get("call-base")!),
      });
      expect(head).toMatchObject({
        revisions: [fixture.head],
        sha256: sha256(served.get("call-head")!),
      });
      expect(diff).toMatchObject({
        tool: "docsfab_history_diff",
        revisions: [fixture.base, fixture.head],
        paths: ["docs/guide.md", "src/app.ts"],
        labels: ["history-paths-excluded"],
        excludedPathCount: 1,
        sha256: sha256(served.get("call-diff")!),
      });
      expect(JSON.parse(served.get("call-head")!)).toMatchObject({ text: HEAD_APP });
      expect(decoded.historyReads).toHaveLength(3);
    },
    nestedDeadlineMs(120_000, 240_000),
  );

  it(
    "cites a blame of known commits through the real harness, decoded by the strict readers",
    async () => {
      const { fixture, workspace } = await materializedFixture();
      const { tools, bodies, error } = await runStep(
        "create-documentation",
        "plan-documentation",
        [
          toolTurn([
            {
              id: "call-blame-head",
              name: "docsfab_history_blame",
              arguments: { path: "docs/guide.md", revision: "head", startLine: 1, endLine: 3 },
            },
            {
              id: "call-blame-base",
              name: "docsfab_history_blame",
              arguments: {
                path: "docs/guide.md",
                revision: fixture.base,
                startLine: 3,
                endLine: 3,
              },
            },
          ]),
          textTurn(createPlanReply()),
          textTurn(createPlanReply()),
          textTurn(createPlanReply()),
        ],
        { workspace, repositoryPath: workspace.path },
      );
      expect(error, String(error)).toBeUndefined();
      const decoded = decodeTools(tools);
      expect(decoded.presented).toEqual(expect.arrayContaining(["docsfab_history_blame"]));
      const served = toolResultTexts(bodies[1]!);
      const headPage = JSON.parse(served.get("call-blame-head")!) as {
        lines: Array<{ line: number; commit: string; text: string }>;
      };
      // The fixture's first two guide lines date from the base; the third changed at head.
      expect(headPage.lines.map((entry) => [entry.line, entry.commit, entry.text])).toEqual([
        [1, fixture.base, "# Guide"],
        [2, fixture.base, ""],
        [3, fixture.head, "The answer is two."],
      ]);
      const byRevision = (revision: string) =>
        decoded.historyReads!.find((entry) => entry.revisions[0] === revision);
      expect(byRevision(fixture.head)).toEqual({
        tool: "docsfab_history_blame",
        revisions: [fixture.head],
        paths: ["docs/guide.md"],
        ranges: [{ path: "docs/guide.md", unit: "lines", start: 1, end: 3 }],
        labels: [],
        sha256: sha256(served.get("call-blame-head")!),
      });
      expect(byRevision(fixture.base)).toEqual({
        tool: "docsfab_history_blame",
        revisions: [fixture.base],
        paths: ["docs/guide.md"],
        ranges: [{ path: "docs/guide.md", unit: "lines", start: 3, end: 3 }],
        labels: [],
        sha256: sha256(served.get("call-blame-base")!),
      });
      expect(JSON.parse(served.get("call-blame-base")!)).toMatchObject({
        lines: [{ line: 3, commit: fixture.base, text: "The answer is one." }],
      });
      expect(decoded.historyReads).toHaveLength(2);
    },
    nestedDeadlineMs(120_000, 240_000),
  );

  it(
    "cites a search's matched commits through the real harness, decoded by the strict readers",
    async () => {
      const { fixture, workspace } = await materializedFixture();
      const needle = "The answer is one";
      const { tools, bodies, error } = await runStep(
        "create-documentation",
        "plan-documentation",
        [
          toolTurn([{ id: "call-search", name: "docsfab_history_search", arguments: { needle } }]),
          textTurn(createPlanReply()),
          textTurn(createPlanReply()),
          textTurn(createPlanReply()),
        ],
        { workspace, repositoryPath: workspace.path },
      );
      expect(error, String(error)).toBeUndefined();
      const decoded = decodeTools(tools);
      expect(decoded.presented).toEqual(expect.arrayContaining([...HISTORY_TOOL_NAMES]));
      const served = toolResultTexts(bodies[1]!).get("call-search")!;
      // The base added the sentence and the head changed it.
      expect(decoded.historyReads).toEqual([
        {
          tool: "docsfab_history_search",
          revisions: [fixture.head],
          paths: [],
          ranges: [{ path: null, unit: "entries", start: 0, end: 2 }],
          labels: ["history-paths-excluded"],
          matchedCommits: [fixture.head, fixture.base],
          sha256: sha256(served),
        },
      ]);
      expect(
        (JSON.parse(served) as { matches: Array<{ commit: string }> }).matches.map(
          (match) => match.commit,
        ),
      ).toEqual([fixture.head, fixture.base]);
      // The search string reaches neither the page nor the attempt's evidence.
      expect(served).not.toContain(needle);
      const evidence = JSON.stringify(tools);
      expect(evidence).not.toContain(needle);
      expect(evidence).not.toContain(sha256(needle));
    },
    nestedDeadlineMs(120_000, 240_000),
  );

  it(
    "presents the tools to the planner and the writer only with a workspace, and never past a ceiling",
    async () => {
      const { workspace } = await materializedFixture();
      const reply = [textTurn("{}"), textTurn("{}"), textTurn("{}"), textTurn("{}")];
      const presented = async (
        workflowName: "create-documentation" | "restructure-documentation",
        stepId: string,
        options: { workspace?: RepositoryWorkspace; toolCeiling?: string[] } = {},
      ) => {
        // The step calls the log first, so a tool registered but not granted fails the call.
        const { tools, bodies } = await runStep(
          workflowName,
          stepId,
          [toolTurn([{ id: "call-log", name: "docsfab_history_log", arguments: {} }]), ...reply],
          { repositoryPath: workspace.path, ...options },
        );
        const decoded = decodeTools(tools);
        const recorded = decoded.presented!;
        // The recorded list must be what the provider was offered, not only what was registered.
        expect(historyNames(offeredTools(bodies[0]!))).toEqual(historyNames(recorded));
        const log = decoded.byTool.find((entry) => entry.name === "docsfab_history_log");
        if (historyNames(recorded).length > 0) {
          expect(log).toEqual({ name: "docsfab_history_log", calls: 1, failures: 0 });
          expect(decoded.historyReads).toHaveLength(1);
        } else {
          expect(decoded.historyReads).toBeUndefined();
        }
        return recorded;
      };
      const historyNames = (names: readonly string[]) =>
        names.filter((name) => name.startsWith("docsfab_history_"));

      expect(
        historyNames(await presented("create-documentation", "plan-documentation", { workspace })),
      ).toEqual([...HISTORY_TOOL_NAMES]);
      expect(
        historyNames(
          await presented("restructure-documentation", "write-documentation", { workspace }),
        ),
      ).toEqual([...HISTORY_TOOL_NAMES]);
      // No workspace: no reader, so no tool.
      expect(historyNames(await presented("create-documentation", "plan-documentation"))).toEqual(
        [],
      );
      // An adjacent step with the same workspace: the predicate is the skill.
      expect(
        historyNames(
          await presented("create-documentation", "derive-source-obligations", { workspace }),
        ),
      ).toEqual([]);
      // A sealed ceiling that omits them removes them from the session too.
      const ceiling = grantedToolsForStep(
        getWorkflow("create-documentation"),
        findStep(getWorkflow("create-documentation"), "plan-documentation"),
      );
      expect(
        historyNames(
          await presented("create-documentation", "plan-documentation", {
            workspace,
            toolCeiling: ceiling,
          }),
        ),
      ).toEqual([]);
      // A ceiling that names the other history tools but not blame grants none of them.
      const withoutBlame = HISTORY_TOOL_NAMES.filter((name) => name !== "docsfab_history_blame");
      expect(withoutBlame).toHaveLength(HISTORY_TOOL_NAMES.length - 1);
      expect(
        historyNames(
          await presented("create-documentation", "plan-documentation", {
            workspace,
            toolCeiling: [...ceiling, ...withoutBlame],
          }),
        ),
      ).toEqual([]);
      // A ceiling that names the four tools granted before search grants none either.
      const withoutSearch = HISTORY_TOOL_NAMES.filter((name) => name !== "docsfab_history_search");
      expect(withoutSearch).toHaveLength(HISTORY_TOOL_NAMES.length - 1);
      expect(
        historyNames(
          await presented("create-documentation", "plan-documentation", {
            workspace,
            toolCeiling: [...ceiling, ...withoutSearch],
          }),
        ),
      ).toEqual([]);
      // Adjacent: the same ceiling with blame grants all of them.
      expect(
        historyNames(
          await presented("create-documentation", "plan-documentation", {
            workspace,
            toolCeiling: [...ceiling, ...HISTORY_TOOL_NAMES],
          }),
        ),
      ).toEqual([...HISTORY_TOOL_NAMES]);
    },
    nestedDeadlineMs(180_000, 360_000),
  );
});

describe("the history grant", () => {
  it("appends its flag after every existing positional flag", () => {
    const workflow = getWorkflow("update-documentation");
    const step = workflow.steps.find((candidate) => candidate.id === "plan-documentation")!;
    const withRecall = grantedToolsForStep(workflow, step, false, false, false, false, true);
    expect(withRecall).toContain("docsfab_recall_tool_result");
    expect(withRecall).not.toContain("docsfab_history_show");
    const withHistory = grantedToolsForStep(
      workflow,
      step,
      false,
      false,
      false,
      false,
      false,
      undefined,
      undefined,
      true,
    );
    expect(withHistory).toEqual(expect.arrayContaining([...HISTORY_TOOL_NAMES]));
    expect(withHistory).not.toContain("docsfab_recall_tool_result");
  });

  it("admits the planner and writer skills and no other", () => {
    const workspace = { sourcePath: "/checkout", revision: "a".repeat(40) };
    expect(historyReaderForStep({ skill: "plan-documentation" }, workspace)).toBeDefined();
    expect(historyReaderForStep({ skill: "write-documentation" }, workspace)).toBeDefined();
    expect(historyReaderForStep({ skill: "review-documentation" }, workspace)).toBeUndefined();
    expect(historyReaderForStep({ skill: "plan-documentation" }, undefined)).toBeUndefined();
    // A sealed ceiling: all five names admit a reader; missing one builds none.
    expect(
      historyReaderForStep({ skill: "plan-documentation" }, workspace, [...HISTORY_TOOL_NAMES]),
    ).toBeDefined();
    // The four names granted before search existed are not enough.
    expect(
      historyReaderForStep({ skill: "plan-documentation" }, workspace, [
        "docsfab_history_blame",
        "docsfab_history_diff",
        "docsfab_history_log",
        "docsfab_history_show",
      ]),
    ).toBeUndefined();
    expect(
      historyReaderForStep({ skill: "plan-documentation" }, workspace, [
        "docsfab_history_diff",
        "docsfab_history_log",
        "docsfab_history_show",
      ]),
    ).toBeUndefined();
    expect(
      historyReaderForStep({ skill: "plan-documentation" }, workspace, ["read", "grep"]),
    ).toBeUndefined();
  });
});

describe("repository configuration through the shipped workspace path", () => {
  it(
    "runs no configured program and keeps the parsed output under every admitted output-shaping key",
    async () => {
      const fixture = await historyFixture(roots);
      const marker = join(fixture.root, "ran");
      const program = join(fixture.root, "program.sh");
      await writeFile(program, `#!/bin/sh\necho ran >> "${marker}"\n`, { mode: 0o755 });
      const mailmap = join(fixture.root, "mailmap");
      await writeFile(mailmap, "Renamed <renamed@example.invalid> <committer@example.invalid>\n");
      // A signed-looking head, so a configured verifier would be asked.
      const tree = await fixtureGit(fixture.repository, ["rev-parse", "HEAD^{tree}"]);
      const identity = "Fixture <fixture@example.invalid> 1790000000 +0000";
      const signed = await fixtureGit(
        fixture.repository,
        ["hash-object", "-t", "commit", "-w", "--stdin"],
        `tree ${tree}\nparent ${fixture.head}\nauthor ${identity}\ncommitter ${identity}\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n -----END PGP SIGNATURE-----\n\nSigned café head\n`,
      );
      await fixtureGit(fixture.repository, ["update-ref", "refs/heads/main", signed]);
      await fixtureGit(fixture.repository, ["notes", "add", "-m", "a note", signed]);
      for (const [key, value] of [
        ["log.showSignature", "true"],
        ["gpg.program", program],
        ["gpg.ssh.program", program],
        ["core.pager", program],
        ["mailmap.file", mailmap],
        ["diff.noprefix", "true"],
        ["color.ui", "always"],
        ["log.decorate", "full"],
        ["notes.displayRef", "refs/notes/commits"],
        ["blame.ignoreRevsFile", join(fixture.root, "absent-revs")],
        ["i18n.logOutputEncoding", "ISO-8859-1"],
      ] as const) {
        await fixtureGit(fixture.repository, ["config", key, value]);
      }
      const workspace = await prepareRepositoryWorkspace(fixture.repository, "HEAD");
      workspaces.push(workspace);
      const reader = historyReaderForStep({ skill: "plan-documentation" }, workspace)!;
      const toolSet = await createConfinedToolSet({
        workspacePath: workspace.path,
        allowWrite: false,
        historyReader: reader,
        repositoryWorkspace: workspace,
      });
      const call = async (name: string, parameters: Record<string, unknown>) => {
        const tool = toolSet.definitions.find((definition) => definition.name === name)!;
        const result = await tool.execute(
          "call",
          parameters,
          undefined,
          undefined,
          undefined as never,
        );
        return JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as Record<
          string,
          unknown
        >;
      };

      const log = await call("docsfab_history_log", {});
      expect(log.entries).toEqual([
        {
          commit: signed,
          parents: [fixture.head],
          committedAt: expect.any(String),
          subject: "Signed café head",
        },
        expect.objectContaining({ commit: fixture.head, subject: "Change the answer" }),
        expect.objectContaining({ commit: fixture.base, subject: "Start the app" }),
      ]);
      const diff = await call("docsfab_history_diff", { base: fixture.base, head: "head" });
      const patch = (diff.files as Array<{ path: string; patch: string }>)[1]!.patch;
      expect(patch.startsWith("diff --git a/src/app.ts b/src/app.ts\n")).toBe(true);
      expect(patch).not.toContain("\u001b[");
      const show = await call("docsfab_history_show", { path: "src/app.ts", revision: "head" });
      expect(show.text).toBe(HEAD_APP);
      expect(existsSync(marker)).toBe(false);
      // Positive control: the same configuration does run the program in plain git.
      await execFileAsync("/usr/bin/git", ["-C", fixture.repository, "log", "-1", "--format=%H"], {
        env: { PATH: "/usr/bin:/bin", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
      });
      expect(existsSync(marker)).toBe(true);
    },
    nestedDeadlineMs(60_000, 120_000),
  );
});

describe("blame under repository configuration, through the shipped workspace path", () => {
  it(
    "keeps attribution and the parsed page under admitted blame keys and a configured ignore list",
    async () => {
      const fixture = await historyFixture(roots);
      const marker = join(fixture.root, "ran");
      const program = join(fixture.root, "program.sh");
      await writeFile(program, `#!/bin/sh\necho ran >> "${marker}"\n`, { mode: 0o755 });
      const first = await commitFiles(fixture.repository, { "notes.md": "one\ntwo\n" }, "Notes");
      const reformat = await commitFiles(
        fixture.repository,
        { "notes.md": "one\nTwo\n" },
        "Reformat",
      );
      const ignoreList = join(fixture.root, "ignore-revs");
      await writeFile(ignoreList, `${reformat}\n`);
      for (const [key, value] of [
        ["blame.markIgnoredLines", "true"],
        ["blame.markUnblamableLines", "true"],
        ["blame.showEmail", "true"],
        ["blame.date", "relative"],
        ["blame.coloring", "highlightRecent"],
        ["blame.blankBoundary", "true"],
        ["blame.showRoot", "true"],
        ["diff.noprefix", "true"],
        ["log.showSignature", "true"],
        ["gpg.program", program],
        ["blame.ignoreRevsFile", ignoreList],
      ] as const) {
        await fixtureGit(fixture.repository, ["config", key, value]);
      }
      const blameLine = async () => {
        const workspace = await prepareRepositoryWorkspace(fixture.repository, "HEAD");
        workspaces.push(workspace);
        const reader = historyReaderForStep({ skill: "write-documentation" }, workspace)!;
        const toolSet = await createConfinedToolSet({
          workspacePath: workspace.path,
          allowWrite: false,
          historyReader: reader,
          repositoryWorkspace: workspace,
        });
        const tool = toolSet.definitions.find(
          (definition) => definition.name === "docsfab_history_blame",
        )!;
        const result = await tool.execute(
          "call",
          { path: "notes.md", revision: "head", startLine: 1, endLine: 2 },
          undefined,
          undefined,
          undefined as never,
        );
        const page = JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as {
          labels: string[];
          lines: Array<Record<string, unknown>>;
        };
        return { labels: page.labels, lines: page.lines };
      };
      const expected = {
        labels: [],
        lines: [
          { line: 1, commit: first, sourceLine: 1, text: "one" },
          { line: 2, commit: reformat, sourceLine: 2, text: "Two" },
        ],
      };
      // An existing ignore list that would move line 2 to the older commit.
      expect(await blameLine()).toEqual(expected);
      const plain = (args: readonly string[]) =>
        execFileAsync("/usr/bin/git", ["-C", fixture.repository, ...args], {
          env: { PATH: "/usr/bin:/bin", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
        });
      const plainBlame = ["blame", "--porcelain", "-L", "2,2", "HEAD", "--", "notes.md"];
      // Positive control: plain git with this configuration does move it.
      expect((await plain(plainBlame)).stdout.split(" ")[0]).toBe(first);
      // A missing ignore list: plain git refuses to blame, the tool serves the page.
      await fixtureGit(fixture.repository, [
        "config",
        "blame.ignoreRevsFile",
        join(fixture.root, "absent-revs"),
      ]);
      await expect(plain(plainBlame)).rejects.toThrow();
      expect(await blameLine()).toEqual(expected);
      expect(existsSync(marker)).toBe(false);
    },
    nestedDeadlineMs(60_000, 120_000),
  );
});

describe("repository configuration the workspace screen refuses, at the reader", () => {
  it(
    "runs no external diff, textconv, fsmonitor, filter, hook or included program (helper level)",
    async () => {
      const fixture = await historyFixture(roots);
      const marker = join(fixture.root, "ran");
      const program = join(fixture.root, "program.sh");
      await writeFile(program, `#!/bin/sh\necho ran >> "${marker}"\n`, { mode: 0o755 });
      const included = join(fixture.root, "included.config");
      await writeFile(included, `[core]\n\tpager = ${program}\n`);
      await commitFiles(
        fixture.repository,
        { ".gitattributes": "* diff=evil filter=evil\n" },
        "Attrs",
      );
      const head = await commitFiles(fixture.repository, { "src/app.ts": "four\n" }, "Four");
      for (const [key, value] of [
        ["diff.external", program],
        ["diff.evil.textconv", program],
        ["diff.evil.command", program],
        ["core.fsmonitor", program],
        ["filter.evil.smudge", program],
        ["filter.evil.clean", program],
        ["core.hooksPath", fixture.root],
        ["include.path", included],
      ] as const) {
        await fixtureGit(fixture.repository, ["config", key, value]);
      }
      const reader = historyReaderForStep(
        { skill: "write-documentation" },
        { sourcePath: fixture.repository, revision: head },
      )!;
      const toolSet = await createConfinedToolSet({
        workspacePath: fixture.root,
        allowWrite: false,
        historyReader: reader,
      });
      const call = async (name: string, parameters: Record<string, unknown>) => {
        const tool = toolSet.definitions.find((definition) => definition.name === name)!;
        const result = await tool.execute(
          "call",
          parameters,
          undefined,
          undefined,
          undefined as never,
        );
        return JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as Record<
          string,
          unknown
        >;
      };
      const diff = await call("docsfab_history_diff", { base: fixture.base, head: "head" });
      const appPatch = (diff.files as Array<{ path: string; patch: string }>).find(
        (file) => file.path === "src/app.ts",
      )!.patch;
      expect(appPatch).toContain("-export const answer = 1;\n+four\n");
      expect(
        (await call("docsfab_history_show", { path: "src/app.ts", revision: fixture.base })).text,
      ).toBe(BASE_APP);
      expect(((await call("docsfab_history_log", {})).entries as unknown[]).length).toBe(4);
      // Pickaxe compares blob text, so a textconv driver would replace "four"
      // with the program's output and the match would vanish.
      const search = (await call("docsfab_history_search", { needle: "four" })) as {
        matches: Array<{ commit: string; paths: string[] }>;
      };
      expect(search.matches.map((match) => [match.commit, match.paths])).toEqual([
        [head, ["src/app.ts"]],
      ]);
      expect(existsSync(marker)).toBe(false);
      const plain = (args: readonly string[]) =>
        execFileAsync("/usr/bin/git", ["-C", fixture.repository, ...args], {
          env: { PATH: "/usr/bin:/bin", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
        }).catch(() => undefined);
      // Control: plain pickaxe runs no program once textconv is off ...
      await plain(["log", "--format=%H", "--no-textconv", "-Sfour"]);
      expect(existsSync(marker)).toBe(false);
      // ... and runs the textconv driver when it is on.
      await plain(["log", "--format=%H", "-Sfour"]);
      expect(existsSync(marker)).toBe(true);
      await rm(marker);
      // Positive control: plain git with this configuration runs the external diff.
      await plain(["diff", fixture.base, head, "--", "src/app.ts"]);
      expect(existsSync(marker)).toBe(true);
    },
    nestedDeadlineMs(60_000, 120_000),
  );
});
