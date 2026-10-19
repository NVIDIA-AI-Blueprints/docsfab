// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `docsfab run --change` with the planner step on the shipped model path: a
 * real `PiHarness` builds the step's tool set through its own source-read
 * grant, and a scripted provider plays the model. The model lists the bound
 * sources, then reads the diff and the manifest in the argument shapes a model
 * really sends, and the test reads back the tool results the next provider
 * request carried. Every change-source kind is covered: a local range, a
 * GitLab merge request (`glab` substituted), and a GitHub pull request (the
 * forge is the fetch), and so is a plain `--source` file. Each source is read
 * by its short handle, by its full ids, and once by an observation id copied
 * with one character changed, which must refuse with what to send instead and
 * land in the run record as a near miss. Each source is also read in the shape
 * a live model sent on every call: all eight arguments, the unused ones filled
 * with `null`, `""`, `0`, or a placeholder id, which must read the named spans.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { executeRunRequest } from "../src/cli/run-request.js";
import { parseRunArguments } from "../src/cli/run-arguments.js";
import type { HarnessStepInput } from "../src/execution/contracts.js";
import { decodeTools } from "../src/execution/inference-evidence.js";
import type {
  ToolArgumentFillerKind,
  ToolArgumentFillerRowV1,
  ToolRefusalArgumentKey,
  ToolRefusalRowV1,
} from "../src/records/contracts.js";
import { PiHarness } from "../src/harness/pi.js";
import type { CommandRunner } from "../src/init/types.js";
import { parseChangeSourceSelector, type ChangeSourceV1 } from "../src/inputs/change-source.js";
import { changeSourceRepositoryPath } from "../src/inputs/change-source/acquisition.js";
import { createModelConnection } from "../src/model/provider.js";
import { validModelConfig } from "./helpers.js";
import { runtimeConfig } from "./support/execution-convergence.js";
import {
  createSourceFixture,
  HTML_SOURCE_PATH,
  planBinding,
  runRequest,
  skillResolver,
  SourceToolHarness,
} from "./support/source-acquisition-cli.js";
import { commitFiles, fixtureGit } from "./support/change-source-fixture.js";
import {
  buildChangeRepository,
  FakeGithub,
  NAME,
  OWNER,
} from "./support/github-change-source-fixture.js";
import {
  boundStyleContext,
  qualityDirectory,
  skillCrateDirectory,
  textTurn,
  toolTurn,
  type ScriptedToolCall,
} from "./support/pi-harness-session-fixtures.js";
import { temporaryRoots } from "./helpers/temp.js";
import { testTimeoutMs } from "./helpers/test-timeouts.js";
import { listedInventory } from "./support/source-listing.js";

const roots = temporaryRoots();

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

interface ListedSpan {
  observationId: string;
  representationId: string;
  repositoryPath: string;
  mediaType: string;
  spanId: string;
  locator: {
    kind: string;
    fileOrdinal?: number | null;
    hunkOrdinal?: number | null;
  };
}

interface ListedSource {
  handle: string;
  observationId: string;
  representationId: string;
  repositoryPath: string;
  mediaType: string;
  diffFiles?: number;
}

interface ReadPayload {
  kind: string;
  text?: string;
  spans?: Array<{ spanId: string; text: string }>;
  nextFromByte?: number | null;
}

type ProviderRequest = {
  messages: Array<{ role: string; tool_call_id?: string; content: unknown }>;
};

function messageText(content: unknown): string {
  return typeof content === "string"
    ? content
    : (content as Array<{ text?: string }>).map((part) => part.text ?? "").join("");
}

/** The source's role in the calls the model makes: what the test asserts per source. */
function roleOf(source: ListedSource): "diff" | "manifest" | "file" {
  if (source.repositoryPath.endsWith("range.diff")) return "diff";
  if (source.repositoryPath.endsWith("manifest.json")) return "manifest";
  return "file";
}

/**
 * The observed calls: a live model sent all eight declared arguments on every
 * read, a handle, exact span ids, and the arguments it did not use filled in.
 * Each entry lists the arguments the host must set aside, and why, as the run
 * record counts them: Pi turns a `""` integer into `null` for a nullable one.
 */
const OBSERVED_SHAPES = {
  // Exact ids beside the handle, and every selection argument filled.
  observed: [
    ["diffFile", "null"],
    ["diffHunk", "zero"],
    ["fromByte", "zero"],
    ["maxBytes", "zero"],
  ],
  // The ids left blank.
  "observed-blank": [
    ["diffFile", "null"],
    ["diffHunk", "null"],
    ["fromByte", "zero"],
    ["maxBytes", "zero"],
    ["observationId", "empty"],
    ["representationId", "empty"],
  ],
  // The ids filled with an obvious placeholder.
  "observed-placeholder": [
    ["diffFile", "null"],
    ["diffHunk", "zero"],
    ["fromByte", "zero"],
    ["maxBytes", "zero"],
    ["observationId", "unissued-id"],
    ["representationId", "unissued-id"],
  ],
} as const satisfies Record<string, ReadonlyArray<readonly [string, ToolArgumentFillerKind]>>;

/** The filler rows the record must hold for these calls, tallied from what each call sent. */
function expectedFiller(
  calls: ReadonlyArray<ReadonlyArray<readonly [string, ToolArgumentFillerKind]>>,
): ToolArgumentFillerRowV1[] {
  const counts = new Map<string, number>();
  for (const call of calls) {
    for (const [argument, kind] of call) {
      counts.set(`${argument}\0${kind}`, (counts.get(`${argument}\0${kind}`) ?? 0) + 1);
    }
  }
  return [...counts.keys()].sort().map((key) => {
    const [argument, kind] = key.split("\0") as [ToolRefusalArgumentKey, ToolArgumentFillerKind];
    return {
      tool: "docsfab_read_source",
      argument,
      kind,
      count: counts.get(key)!,
    };
  });
}

/** An id copied with one hex character changed: the same length, equal to no id. */
function mangled(id: string): string {
  const at = id.length - 7;
  return `${id.slice(0, at)}${id[at] === "a" ? "b" : "a"}${id.slice(at + 1)}`;
}

/**
 * The model: list the sources, then read each one the ways a model asks for
 * it, then answer with the plan. Every read is one call id, so the result the
 * next request carried is found by id.
 */
class ScriptedPlanner {
  public readonly results = new Map<string, string>();
  public sources: ListedSource[] = [];
  public spans: ListedSpan[] = [];

  public constructor(private readonly passThrough?: typeof globalThis.fetch) {}

  public readonly fetch = (async (url: unknown, init?: RequestInit) => {
    if (!String(url).startsWith(validModelConfig.baseUrl)) {
      if (!this.passThrough) throw new Error(`Unexpected request to ${String(url)}.`);
      return this.passThrough(url as string, init);
    }
    const body = JSON.parse(String(init?.body)) as ProviderRequest;
    const toolMessages = body.messages.filter((message) => message.role === "tool");
    for (const message of toolMessages) {
      this.results.set(message.tool_call_id!, messageText(message.content));
    }
    if (toolMessages.length === 0) {
      return toolTurn([{ id: "list", name: "docsfab_list_sources", arguments: {} }]);
    }
    if (toolMessages.length === 1) {
      const listing = JSON.parse(this.results.get("list")!) as {
        sources: ListedSource[];
        spans: ListedSpan[];
      };
      this.sources = listing.sources;
      this.spans = listedInventory(this.results.get("list")!) as unknown as ListedSpan[];
      return toolTurn(this.readCalls(), 2);
    }
    return textTurn(
      JSON.stringify({
        summary: "Plan the page from the bound change.",
        planBinding: { mode: "create", ...planBindingBody() },
      }),
    );
  }) as unknown as typeof globalThis.fetch;

  private readCalls(): ScriptedToolCall[] {
    const calls: ScriptedToolCall[] = [];
    for (const source of this.sources) {
      const role = roleOf(source);
      const ids = {
        observationId: source.observationId,
        representationId: source.representationId,
      };
      const firstSpan = this.spans.find((span) => span.observationId === source.observationId)!;
      // A window from the start, as the tool description asks for first.
      calls.push({
        id: `${role}-window`,
        name: "docsfab_read_source",
        arguments: { ...ids, fromByte: 0 },
      });
      // A span the listing named, bounded the way a small-context model bounds every read.
      calls.push({
        id: `${role}-span`,
        name: "docsfab_read_source",
        arguments: { ...ids, spanIds: [firstSpan.spanId], maxBytes: 16_384 },
      });
      // The observation and representation alone: read it from the start.
      calls.push({
        id: `${role}-whole`,
        name: "docsfab_read_source",
        arguments: { ...ids },
      });
      // The short handle the listing issued, in place of both long ids.
      calls.push({
        id: `${role}-handle`,
        name: "docsfab_read_source",
        arguments: { source: source.handle, fromByte: 0 },
      });
      // The observation id copied with one character changed.
      calls.push({
        id: `${role}-mangled`,
        name: "docsfab_read_source",
        arguments: { ...ids, observationId: mangled(source.observationId) },
      });
      // The shapes a live model sent: every argument, the unused ones filled.
      const observed = { source: source.handle, spanIds: [firstSpan.spanId] };
      calls.push({
        id: `${role}-observed`,
        name: "docsfab_read_source",
        arguments: {
          ...observed,
          ...ids,
          diffFile: null,
          diffHunk: 0,
          fromByte: 0,
          maxBytes: 0,
        },
      });
      calls.push({
        id: `${role}-observed-blank`,
        name: "docsfab_read_source",
        arguments: {
          ...observed,
          observationId: "",
          representationId: "",
          diffFile: "",
          diffHunk: null,
          fromByte: 0,
          maxBytes: 0,
        },
      });
      calls.push({
        id: `${role}-observed-placeholder`,
        name: "docsfab_read_source",
        arguments: {
          ...observed,
          observationId: "<observationId>",
          representationId: "rep-placeholder",
          diffFile: null,
          diffHunk: 0,
          fromByte: 0,
          maxBytes: 0,
        },
      });
      // A file and hunk number beside spans: the spans' own unit of a diff, or
      // numbers that mean nothing for a source that is not one.
      const unitSpan =
        role === "diff"
          ? this.spans.find(
              (span) =>
                span.observationId === source.observationId && span.locator.hunkOrdinal === 1,
            )!
          : firstSpan;
      calls.push({
        id: `${role}-observed-unit`,
        name: "docsfab_read_source",
        arguments: {
          source: source.handle,
          spanIds: [unitSpan.spanId],
          diffFile: unitSpan.locator.fileOrdinal ?? 1,
          diffHunk: 1,
        },
      });
      if (role === "diff") {
        const other = this.sources.find((entry) => entry !== source)!;
        // A well-formed id of another listed source beside the handle.
        calls.push({
          id: "diff-other-source",
          name: "docsfab_read_source",
          arguments: { ...observed, observationId: other.observationId },
        });
        // Span ids and a diff file they are not in: two selections.
        calls.push({
          id: "diff-span-and-file",
          name: "docsfab_read_source",
          arguments: { ...observed, diffFile: 1 },
        });
        calls.push({
          id: "diff-file",
          name: "docsfab_read_source",
          arguments: { ...ids, diffFile: 1 },
        });
        calls.push({
          id: "diff-hunk",
          name: "docsfab_read_source",
          arguments: { ...ids, diffFile: source.diffFiles!, diffHunk: 1 },
        });
        // A diff file by handle: no long id anywhere in the call.
        calls.push({
          id: "diff-handle-file",
          name: "docsfab_read_source",
          arguments: { source: source.handle, diffFile: 1 },
        });
        // Span ids and a window after byte 0: refused, with what to change.
        calls.push({
          id: "diff-both",
          name: "docsfab_read_source",
          arguments: { ...ids, spanIds: [firstSpan.spanId], fromByte: 1 },
        });
      }
    }
    return calls;
  }

  public payload(id: string): ReadPayload {
    const text = this.results.get(id);
    if (text === undefined) throw new Error(`No tool result for ${id}.`);
    // A refused read is plain text; name the call so a failure shows the refusal.
    if (!text.startsWith("{")) throw new Error(`${id} was refused: ${text}`);
    return JSON.parse(text) as ReadPayload;
  }

  /** The source text a read returned, whatever its form. */
  public text(id: string): string {
    const payload = this.payload(id);
    return payload.text ?? payload.spans!.map((span) => span.text).join("\n");
  }
}

function planBindingBody() {
  const { pages, sourceBindings } = planBinding([HTML_SOURCE_PATH]);
  return { pages, sourceBindings };
}

/**
 * The planner step runs through a real `PiHarness`: its tool set comes from
 * the harness's own grant and registration, never from this test. Every other
 * step is the shipped scripted model.
 */
class RealPlannerHarness extends SourceToolHarness {
  private planner: PiHarness | undefined;

  public constructor(
    private readonly model: ScriptedPlanner,
    /** The read whose spans the writer cites: the first window the planner read. */
    private readonly citedRead = "diff-window",
  ) {
    super({ readOnSkill: null, planSourcePaths: [HTML_SOURCE_PATH] });
  }

  private async pi(): Promise<PiHarness> {
    this.planner ??= new PiHarness({
      skillCrateDirectory,
      qualityDirectory,
      styleContext: await boundStyleContext(),
      model: validModelConfig,
      createConnection: createModelConnection,
    });
    return this.planner;
  }

  /** The planner's governed skill is the real one; the scripted steps keep the fixture's. */
  public readonly skillResolver = {
    resolveSkill: async (input: HarnessStepInput) =>
      input.step.skill === "plan-documentation"
        ? (await this.pi()).inspectSkill(input)
        : skillResolver.resolveSkill(input),
  };

  public override async runStep(input: HarnessStepInput) {
    if (input.step.skill !== "plan-documentation") return super.runStep(input);
    const result = await (await this.pi()).runStep(input);
    // The writer cites a span the planner really read: the diff's first window.
    const read = new Set(this.model.payload(this.citedRead).spans!.map((span) => span.spanId));
    this.readSpans.push(
      ...(this.model.spans.filter((span) =>
        read.has(span.spanId),
      ) as unknown as typeof this.readSpans),
    );
    return result;
  }
}

/** Assert the planner read the diff and the manifest of `head` and was told how to fix the one bad call. */
function expectChangeRead(
  model: ScriptedPlanner,
  record: Awaited<ReturnType<typeof executeRunRequest>>,
  head: string,
  added: string,
): void {
  expect(record?.status, record?.error).toBe("succeeded");
  expect(model.sources.map((source) => source.repositoryPath).sort()).toEqual(
    [changeSourceRepositoryPath(head, "diff"), changeSourceRepositoryPath(head, "manifest")].sort(),
  );
  // The diff: its manifest line first, and the changed line, by every form.
  for (const id of ["diff-window", "diff-whole"]) {
    expect(model.payload(id).kind, id).toBe("docsfab-source-window-read");
    expect(model.text(id).split("\n")[0], id).toMatch(/^diff manifest: \d+ files?, \d+ hunks?/u);
    expect(model.text(id).split("\n"), id).toContain(added);
  }
  expect(model.payload("diff-span")).toMatchObject({
    kind: "docsfab-source-span-read",
  });
  expect(model.text("diff-span")).toBe(model.payload("diff-window").spans![0]!.text);
  expect(model.payload("diff-file")).toMatchObject({
    kind: "docsfab-source-diff-read",
  });
  expect(model.text("diff-file").startsWith("diff --git ")).toBe(true);
  expect(model.payload("diff-hunk")).toMatchObject({
    kind: "docsfab-source-diff-read",
  });
  expect(model.text("diff-hunk").startsWith("@@ ")).toBe(true);
  // The manifest: the same sealed JSON by window, by span, and whole.
  const manifest = JSON.parse(model.text("manifest-window")) as ChangeSourceV1;
  expect(manifest.revision.head).toBe(head);
  expect(model.text("manifest-whole")).toBe(model.text("manifest-window"));
  expect(model.payload("manifest-span")).toMatchObject({
    kind: "docsfab-source-span-read",
  });
  expect(model.text("manifest-span")).toBe(model.payload("manifest-window").spans![0]!.text);
  expect(model.text("diff-handle-file")).toBe(model.text("diff-file"));
  for (const role of ["diff", "manifest"] as const) {
    expectHandleAndNearMiss(model, role, 2);
    expectObservedShapes(model, role);
  }
  // The span read beside its own file and hunk number is that hunk.
  expect(model.text("diff-observed-unit")).toMatch(/^(@@ |diff --git )/u);
  const refusal = (detail: string) =>
    `DocsFab refused this source read because the host reported span-unavailable. ${detail} No source text was returned.`;
  // A span read beside a window after byte 0 is two selections.
  expect(model.results.get("diff-both")).toBe(
    refusal(
      "spanIds cannot be combined with a fromByte after 0: a read by span ids returns those " +
        "spans whole. Send fromByte as null, or omit it, beside spanIds. Pass span ids, or a " +
        "window (fromByte, with an optional maxBytes), or a diff file (diffFile, with an " +
        "optional diffHunk), each in its own call; send an argument you do not use as null, " +
        "or omit it.",
    ),
  );
  // An id of another listed source beside the handle is a conflict, never a pick.
  expect(model.results.get("diff-other-source")).toBe(
    refusal(
      "source and observationId or representationId name different sources. Pass only " +
        "source, a handle docsfab_list_sources returned: s1 to s2.",
    ),
  );
  // Span ids beside a diff file they are not in.
  expect(model.results.get("diff-span-and-file")).toBe(
    refusal(
      "Those span ids are not all in diff file 1, so the call names two selections. Beside " +
        "spanIds, send diffFile and diffHunk as null, or omit them; or read diff file 1 by " +
        "diffFile and diffHunk without spanIds.",
    ),
  );
  // The run record carries the refused reads, and why, without an id.
  const plan = record!.steps.find((step) => step.id === "plan-documentation")!;
  const tools = decodeTools(plan.tools);
  const reads = tools.byTool.find((entry) => entry.name === "docsfab_read_source");
  expect(reads).toEqual({
    name: "docsfab_read_source",
    calls: 24,
    failures: 5,
  });
  expect(tools.toolRefusals?.overflowCount).toBe(0);
  const shapeRow = (
    argumentKeys: ToolRefusalArgumentKey[],
    idMatches: ToolRefusalRowV1["idMatches"],
  ) => ({
    tool: "docsfab_read_source" as const,
    code: "span-unavailable" as const,
    detailKind: "argument-shape" as const,
    argumentKeys,
    undeclaredArgumentCount: 0,
    idMatches,
    count: 1,
  });
  // In first-refusal order: the other source, the span and file, then the window.
  expect(sortedRows(tools.toolRefusals!.rows)).toEqual([
    nearMissRow(2),
    shapeRow(
      ["observationId", "source", "spanIds"],
      [
        { argument: "observationId", match: "exact", count: 1 },
        { argument: "source", match: "handle", count: 1 },
        { argument: "spanIds", match: "exact", count: 1 },
      ],
    ),
    shapeRow(
      ["diffFile", "source", "spanIds"],
      [
        { argument: "source", match: "handle", count: 1 },
        { argument: "spanIds", match: "exact", count: 1 },
      ],
    ),
    shapeRow(
      ["fromByte", "observationId", "representationId", "spanIds"],
      [
        { argument: "observationId", match: "exact", count: 1 },
        { argument: "representationId", match: "exact", count: 1 },
        { argument: "spanIds", match: "exact", count: 1 },
      ],
    ),
  ]);
  // Every filler argument of the observed calls was set aside, and counted.
  expect(tools.toolArgumentFiller).toEqual(
    expectedFiller([
      ...Object.values(OBSERVED_SHAPES),
      ...Object.values(OBSERVED_SHAPES),
      [
        ["diffFile", "redundant"],
        ["diffHunk", "redundant"],
      ],
      [
        ["diffFile", "inapplicable"],
        ["diffHunk", "inapplicable"],
      ],
    ]),
  );
  expectNoIdInRecord(model, plan.tools);
}

/**
 * Every observed shape reads the named span, as the plain span read does, and
 * the unit beside a span is set aside when it is the span's own or means nothing.
 */
function expectObservedShapes(model: ScriptedPlanner, role: "diff" | "manifest" | "file"): void {
  for (const shape of Object.keys(OBSERVED_SHAPES)) {
    const id = `${role}-${shape}`;
    expect(model.payload(id), id).toMatchObject({
      kind: "docsfab-source-span-read",
    });
    expect(model.text(id), id).toBe(model.text(`${role}-span`));
  }
  expect(model.payload(`${role}-observed-unit`)).toMatchObject({
    kind: "docsfab-source-span-read",
  });
}

function sortedRows(rows: readonly ToolRefusalRowV1[]): ToolRefusalRowV1[] {
  return [...rows].sort((left, right) => left.code.localeCompare(right.code));
}

/** The record row every mis-copied observation id lands in: a same-length near miss. */
function nearMissRow(count: number): ToolRefusalRowV1 {
  return {
    tool: "docsfab_read_source",
    code: "observation-unavailable",
    detailKind: "unknown-source",
    argumentKeys: ["observationId", "representationId"],
    undeclaredArgumentCount: 0,
    idMatches: [
      { argument: "observationId", match: "near-miss-same-length", count: 1 },
      { argument: "representationId", match: "exact", count: 1 },
    ],
    count,
  };
}

/**
 * The handle read returns the same text as the full-id window, and the
 * mis-copied id is refused with the valid handles and without the value sent.
 */
function expectHandleAndNearMiss(
  model: ScriptedPlanner,
  role: "diff" | "manifest" | "file",
  sourceCount: number,
): void {
  const source = model.sources.find((entry) => roleOf(entry) === role)!;
  expect(model.payload(`${role}-handle`)).toMatchObject({
    kind: "docsfab-source-window-read",
    source: source.handle,
    observationId: source.observationId,
    representationId: source.representationId,
  });
  expect(model.text(`${role}-handle`)).toBe(model.text(`${role}-window`));
  const handles = sourceCount === 1 ? "s1" : `s1 to s${sourceCount}`;
  const refusal = model.results.get(`${role}-mangled`)!;
  expect(refusal).toBe(
    "DocsFab refused this source read because the host reported observation-unavailable. " +
      "That observationId is not a source this step may read. Pass source, a handle " +
      `docsfab_list_sources returned (${handles}), instead of observationId and ` +
      "representationId; call docsfab_list_sources again to see them. No source text was returned.",
  );
  expect(refusal).not.toContain(mangled(source.observationId));
}

/** The refusal rows are content-free: no listed or mis-copied id reaches the record. */
function expectNoIdInRecord(model: ScriptedPlanner, tools: unknown): void {
  const recorded = JSON.stringify((tools as { toolRefusals?: unknown }).toolRefusals);
  for (const source of model.sources) {
    expect(recorded).not.toContain(source.observationId.slice(4, 20));
    expect(recorded).not.toContain(mangled(source.observationId).slice(4, 20));
    expect(recorded).not.toContain(source.representationId.slice(4, 20));
  }
}

describe("the planner reads a --change diff and manifest through the shipped harness", () => {
  it(
    "reads a local range by window, span, whole source, diff file, and hunk",
    async () => {
      const fixture = await createSourceFixture();
      roots.track(fixture.root);
      const head = await commitFiles(
        fixture.repository,
        { "src/export.ts": "export const requiresOutputPath = true;\n" },
        "Require an explicit export path",
      );
      const model = new ScriptedPlanner();
      const harness = new RealPlannerHarness(model);
      vi.stubGlobal("fetch", model.fetch);

      const record = await executeRunRequest(
        {
          ...runRequest(fixture),
          changeSource: parseChangeSourceSelector("HEAD~1..HEAD"),
        },
        runtimeConfig(fixture.stateDirectory),
        {
          silent: true,
          executionHarness: harness,
          skillResolver: harness.skillResolver,
        },
      );

      expectChangeRead(model, record, head, "+export const requiresOutputPath = true;");
    },
    testTimeoutMs(120_000),
  );

  it(
    "reads a GitLab merge request named as !N against the checkout's project",
    async () => {
      const fixture = await createSourceFixture();
      roots.track(fixture.root);
      const host = "gitlab.example.test";
      const projectPath = "team/docs-project";
      await fixtureGit(fixture.repository, [
        "remote",
        "add",
        "origin",
        `git@${host}:${projectPath}.git`,
      ]);
      const branch = await fixtureGit(fixture.repository, ["rev-parse", "--abbrev-ref", "HEAD"]);
      const base = await fixtureGit(fixture.repository, ["rev-parse", "HEAD"]);
      await fixtureGit(fixture.repository, ["checkout", "-q", "-b", "feature/export-path"]);
      const head = await commitFiles(
        fixture.repository,
        { "src/export.ts": "export const requiresOutputPath = true;\n" },
        "Require an explicit export path",
      );
      await fixtureGit(fixture.repository, ["checkout", "-q", branch]);
      const recorded = readFileSync(
        join(import.meta.dirname, "fixtures", "change-source-gitlab", "merge-request-get.json"),
        "utf8",
      );
      const ids: Record<string, string | null> = {
        base,
        start: base,
        head,
        merge: null,
      };
      const openMergeRequest = {
        ...(JSON.parse(recorded, (_key, value: unknown) =>
          typeof value === "string" && value.startsWith("@") ? ids[value.slice(1)] : value,
        ) as Record<string, unknown>),
        state: "opened",
        merged_at: null,
      };
      const glab: CommandRunner = {
        async run(_command, args) {
          const body = String(args.at(-1)).includes("/merge_requests/")
            ? openMergeRequest
            : { id: 4242, path_with_namespace: projectPath };
          return { stdout: JSON.stringify(body), stderr: "", exitCode: 0 };
        },
      };
      const parsed = parseRunArguments([
        "create-documentation",
        "--repo",
        fixture.repository,
        "--instruction",
        runRequest(fixture).instruction,
        "--change",
        "!813",
      ]);
      const model = new ScriptedPlanner();
      const harness = new RealPlannerHarness(model);
      vi.stubGlobal("fetch", model.fetch);

      const record = await executeRunRequest(
        { ...runRequest(fixture), changeSource: parsed.changeSource! },
        runtimeConfig(fixture.stateDirectory),
        {
          silent: true,
          executionHarness: harness,
          skillResolver: harness.skillResolver,
          changeRequestCommands: glab,
          changeRequestEnvironment: {},
        },
      );

      expectChangeRead(model, record, head, "+export const requiresOutputPath = true;");
    },
    testTimeoutMs(120_000),
  );

  it(
    "reads a GitHub pull request the forge reported",
    async () => {
      const fixture = await createSourceFixture();
      roots.track(fixture.root);
      const change = await buildChangeRepository(await roots.create("docsfab-gh-planner-"));
      await fixtureGit(change.repository, [
        "merge",
        "-q",
        "--no-ff",
        "-m",
        "Merge pull request #7",
        change.head,
      ]);
      const forge = new FakeGithub(change.repository);
      await forge.servePull({
        number: 7,
        state: "closed",
        merged: true,
        baseSha: change.baseNow,
        baseRef: "main",
        headSha: change.head,
        baseNow: await fixtureGit(change.repository, ["rev-parse", "main"]),
      });
      const model = new ScriptedPlanner(forge.fetch as unknown as typeof globalThis.fetch);
      const harness = new RealPlannerHarness(model);
      vi.stubGlobal("fetch", model.fetch);

      const record = await executeRunRequest(
        {
          ...runRequest(fixture),
          changeSource: parseChangeSourceSelector(`https://github.com/${OWNER}/${NAME}/pull/7`),
        },
        runtimeConfig(fixture.stateDirectory),
        {
          silent: true,
          executionHarness: harness,
          skillResolver: harness.skillResolver,
        },
      );

      expectChangeRead(model, record, change.head, "+export const requiresOutputPath = true;");
    },
    testTimeoutMs(120_000),
  );
});

describe("the planner reads a plain --source file through the shipped harness", () => {
  it(
    "reads it by handle and by full ids, and records a mis-copied id as a near miss",
    async () => {
      const fixture = await createSourceFixture();
      roots.track(fixture.root);
      const model = new ScriptedPlanner();
      const harness = new RealPlannerHarness(model, "file-window");
      vi.stubGlobal("fetch", model.fetch);

      const record = await executeRunRequest(
        runRequest(fixture, [HTML_SOURCE_PATH]),
        runtimeConfig(fixture.stateDirectory),
        {
          silent: true,
          executionHarness: harness,
          skillResolver: harness.skillResolver,
        },
      );

      expect(record?.status, record?.error).toBe("succeeded");
      expect(model.sources.map((source) => source.repositoryPath)).toEqual([HTML_SOURCE_PATH]);
      expect(model.text("file-whole")).toBe(model.text("file-window"));
      expect(model.text("file-span")).toBe(model.payload("file-window").spans![0]!.text);
      expectHandleAndNearMiss(model, "file", 1);
      const plan = record!.steps.find((step) => step.id === "plan-documentation")!;
      const tools = decodeTools(plan.tools);
      expectObservedShapes(model, "file");
      expect(tools.byTool.find((entry) => entry.name === "docsfab_read_source")).toEqual({
        name: "docsfab_read_source",
        calls: 9,
        failures: 1,
      });
      expect(tools.toolRefusals).toEqual({
        rows: [nearMissRow(1)],
        overflowCount: 0,
      });
      expect(tools.toolArgumentFiller).toEqual(
        expectedFiller([
          ...Object.values(OBSERVED_SHAPES),
          [
            ["diffFile", "inapplicable"],
            ["diffHunk", "inapplicable"],
          ],
        ]),
      );
      expectNoIdInRecord(model, plan.tools);
    },
    testTimeoutMs(120_000),
  );
});

describe("a CREATE plan that names the bound change as a page source", () => {
  it(
    "stops with source-untracked before any write, naming what a plan source must be",
    async () => {
      const fixture = await createSourceFixture();
      roots.track(fixture.root);
      const head = await commitFiles(
        fixture.repository,
        { "src/export.ts": "export const requiresOutputPath = true;\n" },
        "Require an explicit export path",
      );
      const model = new SourceToolHarness({
        readOnSkill: "plan-documentation",
        planSourcePaths: [changeSourceRepositoryPath(head, "diff")],
      });

      const record = await executeRunRequest(
        {
          ...runRequest(fixture),
          changeSource: parseChangeSourceSelector("HEAD~1..HEAD"),
        },
        runtimeConfig(fixture.stateDirectory),
        { silent: true, executionHarness: model, skillResolver },
      );

      expect(record?.status).toBe("failed");
      expect(record?.error).toBe(
        "source-untracked: the documentation plan names a page source the host cannot admit as " +
          "a regular tracked file at this revision: it is untracked, or a link, submodule, or " +
          "other entry the host does not seal as original source. Bound source evidence, such as a --change diff or manifest, is " +
          "read and cited with docsfab_read_source and docsfab_cite_source, never named as a page " +
          "source. Start a new run; if its plan names an untracked source again, report the run id " +
          "as a planner defect.",
      );
      expect(model.writerCalls).toBe(0);
    },
    testTimeoutMs(120_000),
  );
});
