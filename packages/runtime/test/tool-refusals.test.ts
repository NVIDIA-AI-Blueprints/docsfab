// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Refusal evidence for the source and git history tools: every refusal tells
 * the model what to change, and the run record keeps a content-free row per
 * distinct refusal: the code, the kind of fix, the argument names, and how
 * each id the call sent relates to the ids the host issued.
 */
import { describe, expect, it } from "vitest";

import { limitDefinition } from "../src/config/limits.js";
import { decodeTools } from "../src/execution/inference-evidence.js";
import { createHistoryToolDefinitions } from "../src/harness/history-tools.js";
import { createSourceToolDefinitions } from "../src/harness/source-tools.js";
import { resolveToolOutputCapBytes } from "../src/harness/tool-output-cap.js";
import {
  IssuedIds,
  ToolRefusalLedger,
  classifyIssuedId,
  idMatchEntries,
  toolArgumentKeys,
} from "../src/harness/tool-refusals.js";
import { SOURCE_DISCOVERY_REFUSAL_CODES } from "../src/inputs/source-discovery.js";
import { SOURCE_CITATION_REFUSALS } from "../src/inputs/source-evidence-artifacts.js";
import {
  SOURCE_EVIDENCE_SERVICE_ERROR_CODES,
  SOURCE_EVIDENCE_SERVICE_REMEDIATIONS,
  SourceEvidenceServiceError,
  type SourceSpanInventoryEntryV1,
  type SourceStepReaderV1,
} from "../src/inputs/source-resolver.js";
import {
  TOOL_REFUSAL_ARGUMENT_KEYS,
  TOOL_REFUSAL_CODES,
  type ToolRefusalRowV1,
  type ToolRefusalsV1,
} from "../src/records/contracts.js";
import { mergeToolRefusals } from "../src/records/tool-refusals.js";
import { GIT_HISTORY_CODES, GitHistoryReader } from "../src/repository/git-history.js";

const hex = (seed: string) => seed.repeat(64).slice(0, 64);
const OBS = [`obs-${hex("a1")}`, `obs-${hex("b2")}`];
const REP = [`rep-${hex("c3")}`, `rep-${hex("d4")}`];
const SPAN = [`span-${hex("e5")}`, `span-${hex("f6")}`, `span-${hex("07")}`];
const MAX_ROWS = limitDefinition("sources.toolRefusalRecordMaxRows").max;

/** Two single-representation sources, as a `--change` binding lists its diff and manifest. */
function inventory(): SourceSpanInventoryEntryV1[] {
  const entry = (source: number, span: number, startByte: number): SourceSpanInventoryEntryV1 => ({
    observationId: OBS[source]!,
    representationId: REP[source]!,
    repositoryPath:
      source === 0 ? "change-source/abc/range.diff" : "change-source/abc/manifest.json",
    mediaType: source === 0 ? "text/x-diff" : "application/json",
    spanId: SPAN[span]!,
    startByte,
    endByte: startByte + 10,
    locator: { kind: "json-pointer", pointer: "" } as never,
  });
  return [entry(0, 0, 0), entry(0, 1, 10), entry(1, 2, 0)];
}

/** A reader whose listing is `entries`, or whose every call refuses with `code`. */
function fakeReader(behavior: { entries?: SourceSpanInventoryEntryV1[]; refuse?: string }) {
  const refuse = () => {
    throw new SourceEvidenceServiceError(behavior.refuse as never);
  };
  return {
    listSources: () => (behavior.refuse ? refuse() : (behavior.entries ?? [])),
    read: () => refuse(),
  } as unknown as SourceStepReaderV1;
}

function sourceTools(reader: SourceStepReaderV1) {
  const ledger = new ToolRefusalLedger();
  const failures: string[] = [];
  const definitions = createSourceToolDefinitions({
    reader,
    // Never reached: every cite in this file refuses before the citer runs.
    citer: { cite: () => undefined } as never,
    recordFailure: (category) => failures.push(category),
    recordRefusal: ledger.record,
  });
  const execute = async (name: string, params: Record<string, unknown>) => {
    const tool = definitions.find((definition) => definition.name === name)!;
    try {
      await tool.execute("call", params, undefined, undefined, undefined as never);
    } catch (error) {
      return (error as Error).message;
    }
    throw new Error(`Expected ${name} to refuse.`);
  };
  return { ledger, failures, execute, definitions };
}

describe("id classification", () => {
  const observations = new IssuedIds(OBS);
  const representations = new IssuedIds(REP);
  const spans = new IssuedIds(SPAN);
  const others = {
    handles: new Set(["s1", "s2"]),
    paths: new Set(["change-source/abc/range.diff"]),
    otherKinds: [representations, spans],
  };
  const classify = (value: unknown) => classifyIssuedId(value, observations, others);

  it("names exact ids, handles, paths, and prefixes", () => {
    expect(classify(OBS[0])).toBe("exact");
    expect(classify("s2")).toBe("handle");
    expect(classify("change-source/abc/range.diff")).toBe("path");
    expect(classify(OBS[1]!.slice(0, 20))).toBe("unique-prefix");
  });

  it("tells a mis-copied id from a truncated one, another kind, and noise", () => {
    const flipped = `${OBS[0]!.slice(0, 30)}${OBS[0]![30] === "a" ? "b" : "a"}${OBS[0]!.slice(31)}`;
    expect(classify(flipped)).toBe("near-miss-same-length");
    expect(classify(`${OBS[0]}0`)).toBe("near-miss-other-length");
    // A prefix shared by both ids names neither.
    expect(classify("obs-")).toBe("near-miss-other-length");
    expect(classify(REP[0])).toBe("other-kind");
    expect(classify(SPAN[2])).toBe("other-kind");
    expect(classify("release notes")).toBe("unknown");
    expect(classify("")).toBe("malformed");
    expect(classify(7)).toBe("malformed");
  });

  it("collapses classes into sorted counts and keeps declared argument names only", () => {
    expect(
      idMatchEntries([
        ["spanIds", "unknown"],
        ["observationId", "exact"],
        ["spanIds", "exact"],
        ["spanIds", "unknown"],
      ]),
    ).toEqual([
      { argument: "observationId", match: "exact", count: 1 },
      { argument: "spanIds", match: "exact", count: 1 },
      { argument: "spanIds", match: "unknown", count: 2 },
    ]);
    expect(
      toolArgumentKeys(
        {
          range: { from: "a", sideways: 1 },
          revision: "b",
          "model text key": 1,
        },
        { range: ["from", "to"], revision: true },
      ),
    ).toEqual({
      argumentKeys: ["range", "range.from", "revision"],
      undeclaredArgumentCount: 2,
    });
  });
});

describe("the refusal ledger", () => {
  const row = (code: ToolRefusalRowV1["code"]): Omit<ToolRefusalRowV1, "count"> => ({
    tool: "docsfab_read_source",
    code,
    detailKind: "unknown-source",
    argumentKeys: ["observationId"],
    undeclaredArgumentCount: 0,
    idMatches: [{ argument: "observationId", match: "near-miss-same-length", count: 1 }],
  });

  it("collapses a retried refusal into one row and counts rows past the bound", () => {
    const ledger = new ToolRefusalLedger();
    expect(ledger.snapshot()).toBeUndefined();
    for (let call = 0; call < 50; call += 1) ledger.record(row("observation-unavailable"));
    expect(ledger.snapshot()).toEqual({
      rows: [{ ...row("observation-unavailable"), count: 50 }],
      overflowCount: 0,
    });
    for (let call = 1; call < MAX_ROWS + 2; call += 1) {
      ledger.record({
        ...row("span-unavailable"),
        undeclaredArgumentCount: call,
      });
    }
    // A row already held still counts after the bound is reached.
    ledger.record(row("observation-unavailable"));
    const snapshot = ledger.snapshot()!;
    expect(snapshot.rows).toHaveLength(MAX_ROWS);
    expect(snapshot.overflowCount).toBe(2);
    expect(snapshot.rows[0]!.count).toBe(51);
  });

  it("merges a step's attempts under the same bound", () => {
    const one: ToolRefusalsV1 = {
      rows: [{ ...row("observation-unavailable"), count: 3 }],
      overflowCount: 1,
    };
    const two: ToolRefusalsV1 = {
      rows: [
        { ...row("observation-unavailable"), count: 2 },
        { ...row("span-unavailable"), count: 4 },
      ],
      overflowCount: 0,
    };
    expect(mergeToolRefusals([one, two], MAX_ROWS)).toEqual({
      rows: [
        { ...row("observation-unavailable"), count: 5 },
        { ...row("span-unavailable"), count: 4 },
      ],
      overflowCount: 1,
    });
    expect(mergeToolRefusals([one, two], 1)).toEqual({
      rows: [{ ...row("observation-unavailable"), count: 5 }],
      overflowCount: 5,
    });
    expect(mergeToolRefusals([], MAX_ROWS)).toBeUndefined();
  });
});

describe("closed vocabularies", () => {
  it("lists exactly the codes the source and history tools can refuse with", () => {
    expect([...TOOL_REFUSAL_CODES].sort()).toEqual(
      [
        ...new Set([
          ...SOURCE_EVIDENCE_SERVICE_ERROR_CODES,
          ...Object.keys(SOURCE_CITATION_REFUSALS),
          ...SOURCE_DISCOVERY_REFUSAL_CODES,
          ...GIT_HISTORY_CODES,
          "operational-limit",
          "tool-defect",
        ]),
      ].sort(),
    );
  });

  it("names every argument any source or history tool declares", () => {
    const reader = fakeReader({ entries: inventory() });
    const definitions = [
      ...createSourceToolDefinitions({
        reader,
        searcher: { search: async () => undefined } as never,
        citer: { cite: () => undefined } as never,
        recordFailure: () => undefined,
      }),
      ...createHistoryToolDefinitions({
        reader: new GitHistoryReader({
          sourcePath: "/nonexistent",
          headRevision: hex("ab").slice(0, 40),
        }),
        recordFailure: () => undefined,
        toolOutputCapBytes: resolveToolOutputCapBytes(),
      }),
    ];
    expect(definitions).toHaveLength(9);
    const declared = new Set<string>();
    for (const definition of definitions) {
      const properties = (definition.parameters as { properties: Record<string, any> }).properties;
      for (const [name, schema] of Object.entries(properties)) {
        declared.add(name);
        for (const nested of Object.keys(schema.properties ?? {}))
          declared.add(`${name}.${nested}`);
      }
    }
    expect([...declared].sort()).toEqual([...TOOL_REFUSAL_ARGUMENT_KEYS]);
  });
});

describe("source tool refusals", () => {
  it("gives every service code a remediation, so no refusal is bare", async () => {
    for (const code of SOURCE_EVIDENCE_SERVICE_ERROR_CODES) {
      if (code === "credential-withheld") continue;
      const { execute, ledger } = sourceTools(fakeReader({ refuse: code }));
      const message = await execute("docsfab_read_source", { source: "s1" });
      const remediation = SOURCE_EVIDENCE_SERVICE_REMEDIATIONS[code];
      expect(remediation.text.length, code).toBeGreaterThan(20);
      expect(message).toBe(
        `DocsFab refused this source read because the host reported ${code}. ${remediation.text} No source text was returned.`,
      );
      // The listing itself refused, so nothing is classified, and the code says why.
      expect(ledger.snapshot()!.rows).toEqual([
        {
          tool: "docsfab_read_source",
          code,
          detailKind: remediation.kind,
          argumentKeys: ["source"],
          undeclaredArgumentCount: 0,
          idMatches: [],
          count: 1,
        },
      ]);
    }
  });

  it("refuses an unknown handle with the valid ones, never the value sent", async () => {
    const { execute, ledger, failures } = sourceTools(fakeReader({ entries: inventory() }));
    const message = await execute("docsfab_read_source", {
      source: "s9-secret-guess",
    });
    expect(message).toBe(
      "DocsFab refused this source read because the host reported observation-unavailable. No source this step may read has that handle. Pass one docsfab_list_sources returned: s1 to s2. Call docsfab_list_sources again to see them. No source text was returned.",
    );
    expect(message).not.toContain("s9-secret-guess");
    expect(failures).toEqual(["denied-path"]);
    expect(ledger.snapshot()!.rows[0]).toMatchObject({
      code: "observation-unavailable",
      detailKind: "unknown-source",
      idMatches: [{ argument: "source", match: "unknown", count: 1 }],
    });
  });

  it("asks for a representation by handle when an observation has more than one", async () => {
    const entries = inventory();
    const second = {
      ...entries[2]!,
      observationId: OBS[0]!,
      spanId: `span-${hex("99")}`,
    };
    const { execute } = sourceTools(fakeReader({ entries: [...entries, second] }));
    expect(await execute("docsfab_read_source", { observationId: OBS[0] })).toBe(
      "DocsFab refused this source read because the host reported span-unavailable. This observation has 2 representations. Pass source with the handle of the one to read: s1, s3. No source text was returned.",
    );
  });

  it("records a path, a swapped id, and a truncated span id by class", async () => {
    const { execute, ledger } = sourceTools(fakeReader({ entries: inventory() }));
    await execute("docsfab_read_source", {
      source: "change-source/abc/range.diff",
    });
    await execute("docsfab_read_source", {
      observationId: REP[0],
      representationId: OBS[0],
    });
    await execute("docsfab_cite_source", {
      claim: "A claim.",
      source: "s7",
      spanIds: [SPAN[0], SPAN[1]!.slice(0, 40)],
    });
    expect(
      ledger.snapshot()!.rows.map(({ tool, code, detailKind, idMatches }) => ({
        tool,
        code,
        detailKind,
        idMatches,
      })),
    ).toEqual([
      {
        tool: "docsfab_read_source",
        code: "observation-unavailable",
        detailKind: "unknown-source",
        idMatches: [{ argument: "source", match: "path", count: 1 }],
      },
      {
        tool: "docsfab_read_source",
        code: "observation-unavailable",
        detailKind: "unknown-source",
        idMatches: [
          { argument: "observationId", match: "other-kind", count: 1 },
          { argument: "representationId", match: "other-kind", count: 1 },
        ],
      },
      {
        tool: "docsfab_cite_source",
        code: "unknown-span",
        detailKind: "citation",
        idMatches: [
          { argument: "source", match: "unknown", count: 1 },
          { argument: "spanIds", match: "exact", count: 1 },
          { argument: "spanIds", match: "unique-prefix", count: 1 },
        ],
      },
    ]);
  });
});

describe("git history tool refusals", () => {
  it("records each refused history call with its revision classes", async () => {
    const head = hex("cd").slice(0, 40);
    const ledger = new ToolRefusalLedger();
    const definitions = createHistoryToolDefinitions({
      reader: new GitHistoryReader({
        sourcePath: "/nonexistent",
        headRevision: head,
        git: async () => {
          throw new Error("No git runs in this test.");
        },
      }),
      recordFailure: () => undefined,
      recordRefusal: ledger.record,
      toolOutputCapBytes: resolveToolOutputCapBytes(),
    });
    const show = definitions.find((definition) => definition.name === "docsfab_history_show")!;
    const refuse = async (params: Record<string, unknown>) =>
      show.execute("call", params, undefined, undefined, undefined as never).then(
        () => "served",
        (error: Error) => error.message,
      );
    expect(await refuse({ path: "src/app.ts", revision: "main~1" })).toMatch(
      /^DocsFab refused this history read: history-revision-invalid\./u,
    );
    expect(await refuse({ path: "../outside", revision: "head" })).toMatch(
      /^DocsFab refused this history read: history-path-refused\./u,
    );
    const rows = ledger.snapshot()!.rows;
    expect(rows).toEqual([
      {
        tool: "docsfab_history_show",
        code: "history-revision-invalid",
        detailKind: "history",
        argumentKeys: ["path", "revision"],
        undeclaredArgumentCount: 0,
        idMatches: [{ argument: "revision", match: "unknown", count: 1 }],
        count: 1,
      },
      {
        tool: "docsfab_history_show",
        code: "history-path-refused",
        detailKind: "history",
        argumentKeys: ["path", "revision"],
        undeclaredArgumentCount: 0,
        idMatches: [{ argument: "revision", match: "handle", count: 1 }],
        count: 1,
      },
    ]);
    expect(JSON.stringify(rows)).not.toContain("outside");
  });
});

describe("the run record decoder", () => {
  const row: ToolRefusalRowV1 = {
    tool: "docsfab_read_source",
    code: "observation-unavailable",
    detailKind: "unknown-source",
    argumentKeys: ["observationId", "representationId"],
    undeclaredArgumentCount: 0,
    idMatches: [
      { argument: "observationId", match: "near-miss-same-length", count: 1 },
      { argument: "representationId", match: "exact", count: 1 },
    ],
    count: 2,
  };
  const tools = (toolRefusals: unknown, failures = 3) => ({
    totalCalls: 4,
    failedCalls: failures,
    byTool: [{ name: "docsfab_read_source", calls: 4, failures }],
    toolRefusals,
  });

  it("admits the rows a ledger writes", () => {
    expect(decodeTools(tools({ rows: [row], overflowCount: 1 })).toolRefusals).toEqual({
      rows: [row],
      overflowCount: 1,
    });
  });

  it("refuses rows outside the closed vocabularies, the bound, or the recorded failures", () => {
    const refused = (toolRefusals: unknown, failures?: number) =>
      expect(() => decodeTools(tools(toolRefusals, failures))).toThrow();
    refused({ rows: [{ ...row, code: "made-up" }], overflowCount: 0 });
    refused({ rows: [{ ...row, detailKind: "free text" }], overflowCount: 0 });
    refused({
      rows: [{ ...row, argumentKeys: ["obs-123"] }],
      overflowCount: 0,
    });
    refused({
      rows: [{ ...row, argumentKeys: ["representationId", "observationId"] }],
      overflowCount: 0,
    });
    refused({
      rows: [{ ...row, argumentKeys: ["observationId"] }],
      overflowCount: 0,
    });
    refused({ rows: [{ ...row, tool: "read" }], overflowCount: 0 });
    refused({ rows: [row, row], overflowCount: 0 });
    refused({ rows: [], overflowCount: 0 });
    refused({ rows: [row], overflowCount: 2 });
    refused({ rows: [row], overflowCount: 0 }, 1);
    refused({ rows: [row], overflowCount: 0, idValues: [] });
    refused(
      {
        rows: Array.from({ length: MAX_ROWS + 1 }, (_, index) => ({
          ...row,
          undeclaredArgumentCount: index,
          count: 1,
        })),
        overflowCount: 0,
      },
      MAX_ROWS + 1,
    );
  });
});

describe("the filler record decoder", () => {
  const tools = (toolArgumentFiller: unknown, calls = 4) => ({
    totalCalls: calls,
    failedCalls: 0,
    byTool: [{ name: "docsfab_read_source", calls, failures: 0 }],
    toolArgumentFiller,
  });
  const rows = [
    {
      tool: "docsfab_read_source",
      argument: "diffFile",
      kind: "null",
      count: 3,
    },
    {
      tool: "docsfab_read_source",
      argument: "diffFile",
      kind: "redundant",
      count: 1,
    },
    {
      tool: "docsfab_read_source",
      argument: "maxBytes",
      kind: "zero",
      count: 4,
    },
  ];

  it("admits sorted rows within each tool's calls", () => {
    expect(decodeTools(tools(rows)).toolArgumentFiller).toEqual(rows);
  });

  it("refuses rows outside the closed vocabularies, out of order, repeated, or past the calls", () => {
    const refused = (toolArgumentFiller: unknown, calls?: number) =>
      expect(() => decodeTools(tools(toolArgumentFiller, calls))).toThrow();
    refused([{ ...rows[0], kind: "placeholder" }]);
    refused([{ ...rows[0], argument: "obs-123" }]);
    refused([{ ...rows[0], tool: "read" }]);
    refused([{ ...rows[0], value: "" }]);
    refused([rows[1], rows[0]]);
    refused([rows[0], rows[0]]);
    refused([]);
    // One call sets one argument aside once: diffFile has 4 here, over 3 calls.
    refused(rows, 3);
  });
});
