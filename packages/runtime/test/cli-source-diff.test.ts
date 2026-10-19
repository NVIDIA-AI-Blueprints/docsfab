// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `docsfab run --source <change>.diff` end to end: the shipped CLI composition
 * root acquires a committed unified diff, and a model reads its manifest and
 * then one file or hunk by number through `docsfab_read_source`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { executeRunRequest } from "../src/cli/run-request.js";
import { limit } from "../src/config/limits.js";
import type { HarnessStepInput } from "../src/execution/contracts.js";
import { createSourceToolDefinitions } from "../src/harness/source-tools.js";
import type { SourceDiffLocatorV1 } from "../src/inputs/source-evidence.js";
import { runtimeConfig } from "./support/execution-convergence.js";
import {
  createSourceFixture,
  runRequest,
  skillResolver,
  SourceToolHarness,
  type InventoryEntry,
} from "./support/source-acquisition-cli.js";
import { temporaryRoots } from "./helpers/temp.js";
import { listedInventory } from "./support/source-listing.js";

const roots = temporaryRoots();
const DIFF_PATH = "changes/export-limit.diff";

afterEach(() => {
  vi.unstubAllEnvs();
  process.exitCode = undefined;
});

interface ToolPayload {
  [key: string]: unknown;
  spans: Array<{ spanId: string; text: string }>;
  nextFromByte: number | null;
  readBytes: number;
}

interface ListedSource {
  observationId: string;
  representationId: string;
  mediaType: string;
  spanCount: number;
  diffFiles?: number;
}

interface DiffTools {
  readonly sources: readonly ListedSource[];
  readonly inventory: readonly InventoryEntry[];
  read(params: Record<string, unknown>): Promise<ToolPayload>;
}

/**
 * Behaves like a planner that reads a diff the way the tool description says:
 * it lists the sources, then runs `script` against the first one. Every span it
 * reads becomes citable, so the writer cites what the planner read.
 */
class DiffPlannerHarness extends SourceToolHarness {
  public readonly refusals: string[] = [];

  public constructor(private readonly script: (tools: DiffTools) => Promise<void>) {
    super({ readOnSkill: null, planSourcePaths: [DIFF_PATH] });
  }

  public override async runStep(input: HarnessStepInput) {
    if (input.step.skill === "plan-documentation" && input.sourceReader) {
      const definitions = createSourceToolDefinitions({
        reader: input.sourceReader,
        recordFailure: () => undefined,
      });
      const list = definitions.find((entry) => entry.name === "docsfab_list_sources")!;
      const read = definitions.find((entry) => entry.name === "docsfab_read_source")!;
      const payload = ((await list.execute("list", {})) as { content: Array<{ text: string }> })
        .content[0]!.text;
      const listed = {
        sources: (JSON.parse(payload) as { sources: ListedSource[] }).sources,
        spans: listedInventory(payload) as unknown as InventoryEntry[],
      };
      this.listed.push(...listed.spans);
      let call = 0;
      await this.script({
        sources: listed.sources,
        inventory: listed.spans,
        read: async (params) => {
          call += 1;
          const source = listed.sources[0]!;
          try {
            const result = (await read.execute(`read-${call}`, {
              observationId: source.observationId,
              representationId: source.representationId,
              ...params,
            })) as { content: Array<{ text: string }> };
            const payload = JSON.parse(result.content[0]!.text) as ToolPayload;
            // A window or diff read returns spans; a read by id returns their ids.
            const readIds =
              payload.spans?.map((span) => span.spanId) ?? (payload.spanIds as string[]);
            for (const spanId of readIds) {
              const entry = listed.spans.find((candidate) => candidate.spanId === spanId);
              this.readSpans.push(entry ?? ({ ...source, spanId } as unknown as InventoryEntry));
            }
            return payload;
          } catch (error) {
            this.refusals.push(error instanceof Error ? error.message : String(error));
            throw error;
          }
        },
      });
    }
    return super.runStep(input);
  }
}

async function runWithDiff(diff: string, model: SourceToolHarness) {
  const fixture = await createSourceFixture({ [DIFF_PATH]: diff });
  roots.track(fixture.root);
  return executeRunRequest(
    runRequest(fixture, [DIFF_PATH]),
    runtimeConfig(fixture.stateDirectory),
    { silent: true, executionHarness: model, skillResolver },
  );
}

function section(path: string, hunks: readonly string[][]): string[] {
  return [
    `diff --git a/${path} b/${path}`,
    "index 1111111..2222222 100644",
    `--- a/${path}`,
    `+++ b/${path}`,
    ...hunks.flat(),
  ];
}

function hunk(oldStart: number, removed: string, added: string): string[] {
  return [`@@ -${oldStart},1 +${oldStart},1 @@`, `-${removed}`, `+${added}`];
}

function diffLocator(entry: InventoryEntry): SourceDiffLocatorV1 {
  if (entry.locator.kind !== "diff") throw new Error("expected a diff locator");
  return entry.locator;
}

describe("docsfab run --source with a unified diff", () => {
  /** 10,000 characters on one added line, as a minified bundle or lockfile carries. */
  const LONG_LINE = `+${"m".repeat(9_999)}`;
  const DIFF = [
    "Subject: [PATCH] Raise the export limit",
    "",
    ...section("src/export.ts", [
      hunk(1, "const limit = 100;", "const limit = 500;"),
      hunk(20, "  return 'old';", "  return 'new';"),
    ]),
    ...section("dist/export.min.js", [["@@ -1,0 +1,1 @@", LONG_LINE]]),
    "",
  ].join("\n");

  it("reads the manifest first, then a file and a hunk by number, and passes the write gate", async () => {
    const reads: ToolPayload[] = [];
    let listedSource: ListedSource | undefined;
    let inventory: readonly InventoryEntry[] = [];
    const model = new DiffPlannerHarness(async (tools) => {
      listedSource = tools.sources[0];
      inventory = tools.inventory;
      reads.push(await tools.read({ fromByte: 0, maxBytes: 1 }));
      reads.push(await tools.read({ diffFile: 1, diffHunk: 1 }));
      reads.push(await tools.read({ diffFile: 2, diffHunk: 1 }));
      reads.push(await tools.read({ diffFile: 1 }));
      await tools.read({ diffFile: 3 }).catch(() => undefined);
      await tools.read({ diffFile: 1, diffHunk: 3 }).catch(() => undefined);
      await tools.read({ diffFile: 2, fromByte: 1 }).catch(() => undefined);
    });

    const record = await runWithDiff(DIFF, model);

    expect(record?.status, record?.error).toBe("succeeded");
    expect(listedSource).toMatchObject({ mediaType: "text/x-diff", diffFiles: 2 });
    const [manifest, firstHunk, longHunk, wholeFile] = reads;
    // The first span of the source is its manifest.
    expect(manifest!.spans).toHaveLength(1);
    expect(manifest!.spans[0]!.text.split("\n")).toEqual([
      "diff manifest: 2 files, 3 hunks, +3 -2 lines; 1 message",
      'file 1: modified "src/export.ts"; +2 -2; 2 hunks',
      'file 2: modified "dist/export.min.js"; +1 -0; 1 hunk; labels: generated',
    ]);
    // A hunk read returns that hunk's span and stops there.
    const hunkSpans = inventory.filter(
      (entry) => diffLocator(entry).fileOrdinal === 1 && diffLocator(entry).hunkOrdinal === 1,
    );
    expect(firstHunk).toMatchObject({ unit: "hunk", diffFile: 1, diffHunk: 1, nextFromByte: null });
    expect(firstHunk!.spans.map((span) => span.spanId)).toEqual(
      hunkSpans.map((entry) => entry.spanId),
    );
    expect(firstHunk!.spans[0]!.text).toBe(
      "@@ -1,1 +1,1 @@\n-const limit = 100;\n+const limit = 500;",
    );
    expect(diffLocator(hunkSpans[0]!)).toMatchObject({
      newPath: "src/export.ts",
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 1,
    });
    // The 10,000-character line is one readable span, not span-unavailable.
    expect(longHunk).toMatchObject({ unit: "hunk", nextFromByte: null });
    expect(longHunk!.spans.map((span) => span.text).join("")).toBe(`@@ -1,0 +1,1 @@\n${LONG_LINE}`);
    // A file read returns its header and every hunk, and nothing of the next file.
    expect(wholeFile).toMatchObject({ unit: "file", nextFromByte: null });
    expect(wholeFile!.spans.map((span) => span.text)).toEqual([
      DIFF.split("\n").slice(2, 6).join("\n"),
      "@@ -1,1 +1,1 @@\n-const limit = 100;\n+const limit = 500;",
      "@@ -20,1 +20,1 @@\n-  return 'old';\n+  return 'new';",
    ]);
    // A file, hunk, or offset outside the diff is refused with counts and offsets, not a guess.
    const fileTwo = inventory.filter((entry) => diffLocator(entry).fileOrdinal === 2);
    expect(model.refusals).toEqual([
      "DocsFab refused this source read because the host reported span-unavailable. This diff has 2 files, and file 3 is not one of them. Read its manifest from fromByte 0 for the file numbers. No source text was returned.",
      "DocsFab refused this source read because the host reported span-unavailable. Diff file 1 has 2 hunks, and hunk 3 is not one of them. No source text was returned.",
      `DocsFab refused this source read because the host reported span-unavailable. fromByte 1 is outside the requested diff file, which runs from byte ${fileTwo[0]!.startByte} to ${fileTwo.at(-1)!.endByte}. Omit fromByte to start at its beginning, or pass the nextFromByte an earlier read returned. No source text was returned.`,
    ]);
    expect(
      (record?.evidenceWarnings ?? []).filter((entry) => entry.startsWith("source-read-partial:")),
    ).toEqual([]);
  }, 120_000);

  it("pages a hunk line longer than one span by continuing from nextFromByte", async () => {
    /** 40,001 bytes on one line: a "+", then two-byte characters. */
    const LINE = `+${"é".repeat(20_000)}`;
    const diff = [...section("data/catalog.json", [["@@ -1,0 +1,1 @@", LINE]]), ""].join("\n");
    const pages: ToolPayload[] = [];
    const model = new DiffPlannerHarness(async (tools) => {
      let page = await tools.read({ diffFile: 1, diffHunk: 1, maxBytes: 16_384 });
      pages.push(page);
      while (page.nextFromByte !== null) {
        page = await tools.read({
          diffFile: 1,
          diffHunk: 1,
          fromByte: page.nextFromByte,
          maxBytes: 16_384,
        });
        pages.push(page);
      }
    });

    const record = await runWithDiff(diff, model);

    expect(record?.status, record?.error).toBe("succeeded");
    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) expect(page.readBytes).toBeLessThanOrEqual(16_384);
    expect(pages.flatMap((page) => page.spans.map((span) => span.text)).join("")).toBe(
      `@@ -1,0 +1,1 @@\n${LINE}`,
    );
  }, 120_000);

  it("binds a diff with more hunks than the span ceiling holds by reading its largest file whole", async () => {
    const many = (path: string) =>
      section(
        path,
        Array.from({ length: 800 }, (_, index) =>
          hunk(index * 10 + 1, `old ${index}`, `new ${index}`),
        ),
      );
    const diff = [...many("src/a.ts"), ...many("src/b.ts"), ...many("src/c.ts"), ""].join("\n");
    const reads: ToolPayload[] = [];
    const model = new DiffPlannerHarness(async (tools) => {
      reads.push(await tools.read({ diffFile: 1, diffHunk: 5, maxBytes: 64 }));
      reads.push(await tools.read({ diffFile: 2, diffHunk: 5 }));
    });

    const record = await runWithDiff(diff, model);

    expect(record?.status, record?.error).toBe("succeeded");
    // File 1 is read whole, so its hunk 5 is answered with the file's first span.
    expect(reads[0]).toMatchObject({ unit: "file", diffFile: 1, diffHunk: 5 });
    expect(reads[0]!.nextFromByte).not.toBeNull();
    expect(reads[1]).toMatchObject({ unit: "hunk", nextFromByte: null });
    expect(reads[1]!.spans[0]!.text).toBe("@@ -41,1 +41,1 @@\n-old 4\n+new 4");
  }, 120_000);

  it("refuses a diff with more files than the span ceiling holds, naming that bound", async () => {
    const diff = [
      ...Array.from({ length: 2_100 }, (_, index) =>
        section(`docs/page-${index}.md`, [hunk(1, "a", "b")]),
      ).flat(),
      "",
    ].join("\n");
    const model = new SourceToolHarness({ readOnSkill: null, planSourcePaths: [DIFF_PATH] });

    await expect(runWithDiff(diff, model)).rejects.toThrowError(
      /^Source acquisition refused: input-over-limit \(changes\/export-limit\.diff\)\. sources-extraction-max-spans-bound: \d+ exceeds sources\.extractionMaxSpans = 2048 /u,
    );
    expect(model.calls).toEqual([]);
  }, 120_000);

  it("refuses a diff whose extracted text is past the derivative ceiling with that limit's line", async () => {
    // 100 hunks of 12,000-byte lines: under the original ceiling, over the 1 MiB derivative one.
    const diff = [
      ...section(
        "data/fixtures.json",
        Array.from({ length: 100 }, (_, index) => [
          `@@ -${index + 1},0 +${index + 1},1 @@`,
          `+${String(index).padEnd(12_000, "f")}`,
        ]),
      ),
      "",
    ].join("\n");
    const model = new SourceToolHarness({ readOnSkill: null, planSourcePaths: [DIFF_PATH] });

    await expect(runWithDiff(diff, model)).rejects.toThrowError(
      /^Source acquisition refused: input-over-limit \(changes\/export-limit\.diff\)\. sources-extraction-max-derivative-bytes-bound: \d+ exceeds sources\.extractionMaxDerivativeBytes = 1048576 bytes\. Bind a smaller file or a narrower selection, or raise DOCSFAB_SOURCES_EXTRACTION_MAX_DERIVATIVE_BYTES, up to 67108864, then start a new run\. Follow the named remediation\.$/u,
    );
    expect(model.calls).toEqual([]);
  }, 120_000);

  it("refuses a diff past the original ceiling with the code, its bytes, the bound, and the override", async () => {
    const diff = [
      ...section(
        "data/huge.json",
        Array.from({ length: 2_000 }, (_, index) => [
          `@@ -${index + 1},0 +${index + 1},1 @@`,
          `+${String(index).padEnd(2_200, "h")}`,
        ]),
      ),
      "",
    ].join("\n");
    const model = new SourceToolHarness({ readOnSkill: null, planSourcePaths: [DIFF_PATH] });

    await expect(runWithDiff(diff, model)).rejects.toThrowError(
      `Source acquisition refused: input-over-limit (${DIFF_PATH}). ` +
        `sources-extraction-max-original-bytes-bound: ${Buffer.byteLength(diff)} exceeds sources.extractionMaxOriginalBytes = 4194304 bytes. ` +
        "Bind a smaller source, such as a narrower merged-MR window or a smaller tracked file, or raise DOCSFAB_SOURCES_EXTRACTION_MAX_ORIGINAL_BYTES, up to 67108864, then start a new run. " +
        "Follow the named remediation.",
    );
    expect(model.calls).toEqual([]);
  }, 120_000);
});

describe("docsfab run --source with a unified diff, read back and at its bounds", () => {
  it("reads every listed span and every window byte for byte, including spans past the listing", async () => {
    const HUNKS = 300;
    const hunkText = (index: number) =>
      `@@ -${index * 10 + 1},1 +${index * 10 + 1},1 @@\n-old ${index}\n+new ${index}`;
    const diff = [
      "diff --git a/src/many.ts b/src/many.ts",
      "--- a/src/many.ts",
      "+++ b/src/many.ts",
      ...Array.from({ length: HUNKS }, (_, index) => hunkText(index)),
      "",
    ].join("\n");
    const original = Buffer.from(diff);
    const byId: Array<{ entry: InventoryEntry; text: string }> = [];
    const windowSpans: Array<{ spanId: string; text: string }> = [];
    let summary: ListedSource | undefined;
    let lastHunk: ToolPayload | undefined;
    const model = new DiffPlannerHarness(async (tools) => {
      summary = tools.sources[0];
      for (const entry of tools.inventory) {
        const read = (await tools.read({ spanIds: [entry.spanId] })) as unknown as {
          text: string;
        };
        byId.push({ entry, text: read.text });
      }
      for (let fromByte: number | null = 0; fromByte !== null; ) {
        const window: ToolPayload = await tools.read({ fromByte, maxBytes: 4_096 });
        windowSpans.push(...window.spans);
        fromByte = window.nextFromByte;
      }
      lastHunk = await tools.read({ diffFile: 1, diffHunk: HUNKS });
    });

    const record = await runWithDiff(diff, model);

    expect(record?.status, record?.error).toBe("succeeded");
    // One manifest, one header, and one span per hunk; the listing stops short of them.
    expect(summary?.spanCount).toBe(HUNKS + 2);
    expect(byId.length).toBeLessThan(HUNKS + 2);
    for (const { entry, text } of byId) {
      const locator = diffLocator(entry);
      if (locator.part === "manifest") {
        expect(text.startsWith("diff manifest: 1 file, 300 hunks, +300 -300 lines")).toBe(true);
        continue;
      }
      expect(original.subarray(locator.startByte!, locator.endByte!).toString("utf8")).toBe(text);
    }
    // Windows reach every span, in order, with the bytes a read by id returns.
    expect(windowSpans).toHaveLength(HUNKS + 2);
    for (const { entry, text } of byId) {
      expect(windowSpans.find((span) => span.spanId === entry.spanId)?.text).toBe(text);
    }
    const listed = new Set(byId.map(({ entry }) => entry.spanId));
    const pastListing = windowSpans.filter((span) => !listed.has(span.spanId));
    expect(pastListing.length).toBeGreaterThan(0);
    expect(pastListing.map((span) => span.text)).toEqual(
      Array.from({ length: pastListing.length }, (_, offset) =>
        hunkText(HUNKS - pastListing.length + offset),
      ),
    );
    expect(lastHunk).toMatchObject({ unit: "hunk", nextFromByte: null });
    expect(lastHunk!.spans.map((span) => span.text)).toEqual([hunkText(HUNKS - 1)]);
  }, 180_000);

  it("binds a diff at the span ceiling and refuses one span past it", async () => {
    vi.stubEnv("DOCSFAB_SOURCES_EXTRACTION_MAX_SPANS", "8");
    const bound = limit("sources.extractionMaxSpans").value;
    expect(bound).toBe(8);
    // A rename-only file is one span no fallback can shrink; the manifest is one more.
    const renames = (count: number) =>
      [
        ...Array.from({ length: count }, (_, index) => [
          `diff --git a/docs/old-${index}.md b/docs/new-${index}.md`,
          "similarity index 100%",
          `rename from docs/old-${index}.md`,
          `rename to docs/new-${index}.md`,
        ]).flat(),
        "",
      ].join("\n");

    const atBound = await runWithDiff(
      renames(bound - 1),
      new SourceToolHarness({ readOnSkill: null, planSourcePaths: [DIFF_PATH] }),
    );
    expect(atBound?.status, atBound?.error).toBe("succeeded");

    const model = new SourceToolHarness({ readOnSkill: null, planSourcePaths: [DIFF_PATH] });
    await expect(runWithDiff(renames(bound), model)).rejects.toThrowError(
      `Source acquisition refused: input-over-limit (${DIFF_PATH}). sources-extraction-max-spans-bound: ${bound + 1} exceeds sources.extractionMaxSpans = ${bound} count.`,
    );
    expect(model.calls).toEqual([]);
  }, 180_000);

  it("binds a diff of exactly the original ceiling and refuses one byte more", async () => {
    vi.stubEnv("DOCSFAB_SOURCES_EXTRACTION_MAX_ORIGINAL_BYTES", "4096");
    const bound = limit("sources.extractionMaxOriginalBytes").value;
    expect(bound).toBe(4_096);
    const head = [
      "diff --git a/docs/notes.md b/docs/notes.md",
      "--- a/docs/notes.md",
      "+++ b/docs/notes.md",
      "@@ -0,0 +1,1 @@",
      "+",
    ].join("\n");
    const sized = (bytes: number) => `${head}${"n".repeat(bytes - head.length - 1)}\n`;
    expect(Buffer.byteLength(sized(bound))).toBe(bound);

    const atBound = await runWithDiff(
      sized(bound),
      new SourceToolHarness({ readOnSkill: null, planSourcePaths: [DIFF_PATH] }),
    );
    expect(atBound?.status, atBound?.error).toBe("succeeded");

    const model = new SourceToolHarness({ readOnSkill: null, planSourcePaths: [DIFF_PATH] });
    await expect(runWithDiff(sized(bound + 1), model)).rejects.toThrowError(
      `Source acquisition refused: input-over-limit (${DIFF_PATH}). sources-extraction-max-original-bytes-bound: ${bound + 1} exceeds sources.extractionMaxOriginalBytes = ${bound} bytes.`,
    );
    expect(model.calls).toEqual([]);
  }, 180_000);

  it("binds an empty committed diff as a manifest of no files", async () => {
    const model = new SourceToolHarness({ readOnSkill: null, planSourcePaths: [DIFF_PATH] });
    const record = await runWithDiff("", model);
    expect(record?.status, record?.error).toBe("succeeded");
    const read = model.hostReads.find((source) => source.repositoryPath === DIFF_PATH);
    expect(read?.spans.map((span) => span.text)).toEqual([
      "diff manifest: 0 files, 0 hunks, +0 -0 lines",
    ]);
  }, 120_000);
});

describe("docsfab run --source with a diff that is partly not UTF-8", () => {
  it("binds the diff, labels the file, and refuses a hunk read with no extracted text", async () => {
    const diff = Buffer.concat([
      Buffer.from(
        [
          "diff --git a/docs/caf.txt b/docs/caf.txt",
          "--- a/docs/caf.txt",
          "+++ b/docs/caf.txt",
          "@@ -1 +1 @@ caf",
        ].join("\n"),
      ),
      Buffer.from([0xe9]),
      Buffer.from(
        [
          "",
          "-old",
          "+new",
          "diff --git a/docs/plain.md b/docs/plain.md",
          "--- a/docs/plain.md",
          "+++ b/docs/plain.md",
          "@@ -1 +1 @@",
          "-a",
          "+b",
          "",
        ].join("\n"),
      ),
    ]);
    const reads: ToolPayload[] = [];
    const model = new DiffPlannerHarness(async (tools) => {
      reads.push(await tools.read({ fromByte: 0, maxBytes: 1 }));
      await tools.read({ diffFile: 1, diffHunk: 1 }).catch(() => undefined);
      reads.push(await tools.read({ diffFile: 2, diffHunk: 1 }));
    });
    const fixture = await createSourceFixture({ [DIFF_PATH]: diff });
    roots.track(fixture.root);

    const record = await executeRunRequest(
      runRequest(fixture, [DIFF_PATH]),
      runtimeConfig(fixture.stateDirectory),
      { silent: true, executionHarness: model, skillResolver },
    );

    expect(record?.status, record?.error).toBe("succeeded");
    expect(reads[0]!.spans[0]!.text.split("\n")).toEqual([
      "diff manifest: 2 files, 2 hunks, +2 -2 lines",
      'file 1: modified "docs/caf.txt"; +1 -1; 1 hunk; labels: non-utf8; 1 hunk body not extracted (not UTF-8)',
      'file 2: modified "docs/plain.md"; +1 -1; 1 hunk',
    ]);
    expect(model.refusals).toEqual([
      "DocsFab refused this source read because the host reported span-unavailable. Diff file 1 hunk 1 has no extracted text. The file's row in the manifest, read from fromByte 0, says why. No source text was returned.",
    ]);
    expect(reads[1]!.spans.map((span) => span.text)).toEqual(["@@ -1 +1 @@\n-a\n+b"]);
  }, 120_000);
});

describe("docsfab run --source reads a diff note through docsfab_read_source", () => {
  it("reads notes with their file, pages a long one, and leaves them out of a hunk read", async () => {
    /** 40,001 bytes on one line after the hunk: a note split into pieces. */
    const LONG_NOTE = `Only in b: ${"é".repeat(19_995)}`;
    const diff = [
      "diff -ru a/guide.md b/guide.md",
      "--- a/guide.md",
      "+++ b/guide.md",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      LONG_NOTE,
      "diff -ru a/other.md b/other.md",
      "--- a/other.md",
      "+++ b/other.md",
      "@@ -1 +1 @@",
      "-x",
      "+y",
      "",
    ].join("\n");
    const original = Buffer.from(diff);
    const pages: ToolPayload[] = [];
    let hunkRead: ToolPayload | undefined;
    let inventory: readonly InventoryEntry[] = [];
    const model = new DiffPlannerHarness(async (tools) => {
      inventory = tools.inventory;
      let page = await tools.read({ diffFile: 1, maxBytes: 16_384 });
      pages.push(page);
      while (page.nextFromByte !== null) {
        page = await tools.read({ diffFile: 1, fromByte: page.nextFromByte, maxBytes: 16_384 });
        pages.push(page);
      }
      hunkRead = await tools.read({ diffFile: 1, diffHunk: 1 });
    });

    const record = await runWithDiff(diff, model);

    expect(record?.status, record?.error).toBe("succeeded");
    // The file read pages through header, hunk, and note, and stops before file 2.
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.every((page) => page.unit === "file")).toBe(true);
    const texts = pages.flatMap((page) => page.spans.map((span) => span.text));
    expect(texts[0]).toBe("diff -ru a/guide.md b/guide.md\n--- a/guide.md\n+++ b/guide.md");
    expect(texts[1]).toBe("@@ -1 +1 @@\n-old\n+new");
    expect(texts.slice(2).join("")).toBe(LONG_NOTE);
    expect(texts.join("\n")).not.toContain("other.md");
    // A hunk read leaves the note out.
    expect(hunkRead).toMatchObject({ unit: "hunk", nextFromByte: null });
    expect(hunkRead!.spans.map((span) => span.text)).toEqual(["@@ -1 +1 @@\n-old\n+new"]);
    // Each note piece's locator names its own original bytes.
    const notePieces = inventory.filter((entry) => diffLocator(entry).part === "note");
    expect(notePieces.length).toBeGreaterThan(1);
    const readText = new Map(
      pages.flatMap((page) => page.spans.map((span) => [span.spanId, span.text] as const)),
    );
    for (const piece of notePieces) {
      const locator = diffLocator(piece);
      expect(locator).toMatchObject({ fileOrdinal: 1, hunkOrdinal: null, hunkCount: null });
      expect(original.subarray(locator.startByte!, locator.endByte!).toString("utf8")).toBe(
        readText.get(piece.spanId),
      );
    }
  }, 120_000);
});
