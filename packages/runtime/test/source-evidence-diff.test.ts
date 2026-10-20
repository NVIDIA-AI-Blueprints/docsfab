// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { limitDefinition } from "../src/config/limits.js";
import {
  DIFF_SOURCE_EXTRACTOR_ID,
  DIFF_SOURCE_MEDIA_TYPE,
  diffSourceExtractorAdapter,
  PATCH_SOURCE_MEDIA_TYPE,
} from "../src/inputs/adapters/diff.js";
import { assertSoundRepresentation } from "../src/inputs/source-acquisition.js";
import {
  normalizeSourceLocator,
  SOURCE_LOCATOR_KINDS,
  type SourceDiffLocatorV1,
} from "../src/inputs/source-evidence.js";
import {
  extractSourceRepresentation,
  formatSourceRepresentationLimitations,
  type SourceExtractionLimitsV1,
} from "../src/inputs/source-extraction.js";
import { temporaryRoots } from "./helpers/temp.js";

const exec = promisify(execFile);
const roots = temporaryRoots();
const REPOSITORY_ROOT = resolve(import.meta.dirname, "../../..");

const DIFF_FIXTURE_DIR = resolve(import.meta.dirname, "fixtures/source-evidence/diff");

/**
 * Committed git and GNU diff output, one per shape the adapter reads, so the
 * suite never depends on which diffs a checkout happens to track. `uncovered`
 * is the original text no span holds.
 */
const DIFF_FIXTURES: readonly {
  shape: string;
  name: string;
  manifest: readonly string[];
  uncovered: readonly string[];
}[] = [
  {
    shape: "git format-patch with a mail header, diffstat, and signature",
    name: "format-patch-single.patch",
    manifest: [
      "diff manifest: 1 file, 1 hunk, +1 -1 lines; 1 message; 1 trailer",
      'file 1: modified "docs/install.md"; +1 -1; 1 hunk',
    ],
    uncovered: [],
  },
  {
    shape: "format-patch --stdout series that repeats a path",
    name: "format-patch-series.patch",
    manifest: [
      "diff manifest: 3 files, 3 hunks, +4 -2 lines; 2 messages; 2 trailers",
      'file 1: modified "docs/install.md"; +1 -1; 1 hunk',
      'file 2: modified "docs/export.md"; +1 -1; 1 hunk',
      'file 3: modified "docs/install.md"; +2 -0; 1 hunk',
    ],
    uncovered: [],
  },
  {
    shape: "plain diff -u",
    name: "plain-u.diff",
    manifest: [
      "diff manifest: 1 file, 1 hunk, +2 -1 lines",
      'file 1: modified "new/guide/steps.txt"; +2 -1; 1 hunk',
    ],
    uncovered: [],
  },
  {
    shape: "diff -ruN",
    name: "recursive-ruN.diff",
    manifest: [
      "diff manifest: 4 files, 4 hunks, +4 -3 lines",
      'file 1: modified "new/guide/added.txt"; +1 -0; 1 hunk',
      'file 2: modified "new/guide/contact.txt"; +1 -1; 1 hunk',
      'file 3: modified "new/guide/retired.txt"; +0 -1; 1 hunk',
      'file 4: modified "new/guide/steps.txt"; +2 -1; 1 hunk',
    ],
    uncovered: [],
  },
  {
    shape: "git diff --no-prefix",
    name: "no-prefix.diff",
    manifest: [
      "diff manifest: 1 file, 1 hunk, +1 -1 lines",
      'file 1: modified "docs/install.md"; +1 -1; 1 hunk',
    ],
    uncovered: [],
  },
  {
    shape: "GIT binary patch",
    name: "git-binary.diff",
    manifest: [
      "diff manifest: 1 file, 0 hunks, +0 -0 lines",
      'file 1: added "assets/logo.png"; +0 -0; 0 hunks; labels: binary; 6 encoded binary lines not extracted',
    ],
    uncovered: [
      "literal 23\necmeAS@N?(olHy`uVBq!ia0y~yWMcmRj{yKP)db-H\n\nliteral 0\nHcmV?d00001\n",
    ],
  },
  {
    shape: "git rename with an edit",
    name: "rename.diff",
    manifest: [
      "diff manifest: 1 file, 1 hunk, +1 -1 lines",
      'file 1: renamed "docs/reference.md" -> "docs/settings.md"; +1 -1; 1 hunk',
    ],
    uncovered: [],
  },
  {
    shape: "git mode change",
    name: "mode-change.diff",
    manifest: [
      "diff manifest: 1 file, 0 hunks, +0 -0 lines",
      'file 1: modified "scripts/build.sh"; +0 -0; 0 hunks',
    ],
    uncovered: [],
  },
];

/** A `git format-patch` shape: a mail preamble, two text files, a binary file, and a rename. */
const FORMAT_PATCH = [
  "From 1234 Mon Sep 17 00:00:00 2001",
  "Subject: [PATCH] Raise the export limit",
  "",
  "Exports now stop at 500 rows.",
  "---",
  " src/export.ts | 3 ++-",
  "",
  "diff --git a/src/export.ts b/src/export.ts",
  "index 111..222 100644",
  "--- a/src/export.ts",
  "+++ b/src/export.ts",
  "@@ -1,3 +1,4 @@",
  " const rows = load();",
  "-const limit = 100;",
  "+const limit = 500;",
  "+--- this added line looks like a file header",
  " export { rows };",
  "@@ -10,2 +11,2 @@ function report() {",
  "-  return 'old';",
  "+  return 'new';",
  " }",
  "diff --git a/package-lock.json b/package-lock.json",
  "index 333..444 100644",
  "--- a/package-lock.json",
  "+++ b/package-lock.json",
  "@@ -1 +1 @@",
  '-{"lockfileVersion":2}',
  '+{"lockfileVersion":3}',
  "diff --git a/assets/logo.png b/assets/logo.png",
  "new file mode 100644",
  "index 0000000..abcdef0",
  "GIT binary patch",
  "literal 12",
  "TcmZ?wbhEHb6krfwcmS",
  "",
  "literal 0",
  "HcmV?d00001",
  "",
  "diff --git a/docs/old.md b/docs/new.md",
  "similarity index 100%",
  "rename from docs/old.md",
  "rename to docs/new.md",
  "",
].join("\n");

type Extracted = Awaited<ReturnType<typeof extract>>;

async function extract(original: string | Uint8Array, limits?: Partial<SourceExtractionLimitsV1>) {
  const bytes = typeof original === "string" ? new TextEncoder().encode(original) : original;
  const result = await extractSourceRepresentation({
    adapter: diffSourceExtractorAdapter,
    bytes,
    mediaType: DIFF_SOURCE_MEDIA_TYPE,
    ...(limits ? { limits } : {}),
  });
  const derivative = Buffer.from(result.derivative);
  const spans = result.representation.spans.map((span) => ({
    ...span,
    locator: span.locator as SourceDiffLocatorV1,
    text: derivative.subarray(span.startByte, span.endByte).toString("utf8"),
  }));
  return { ...result, bytes, spans };
}

/**
 * Every span but the manifest is the original slice its locator names, and the
 * bytes no span holds are exactly `uncovered`, in order, with the newlines the
 * host separator stands for removed.
 */
function expectVerbatimSlices(extracted: Extracted, uncovered: readonly string[] = []): void {
  const original = Buffer.from(extracted.bytes);
  const covered = new Uint8Array(original.length);
  for (const span of extracted.spans) {
    if (span.locator.part === "manifest") {
      expect(span.locator.startByte).toBeNull();
      continue;
    }
    const { startByte, endByte } = span.locator;
    expect(original.subarray(startByte!, endByte!).toString("utf8")).toBe(span.text);
    covered.fill(1, startByte!, endByte!);
  }
  const left: string[] = [];
  let run = "";
  original.forEach((byte, index) => {
    if (covered[index]) {
      if (run) left.push(run);
      run = "";
    } else {
      run += String.fromCharCode(byte);
    }
  });
  if (run) left.push(run);
  expect(left.map((text) => text.replace(/^\n|\n$/gu, "")).filter(Boolean)).toEqual(uncovered);
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (
    await exec(
      "git",
      [
        "-c",
        "user.name=Fixture Author",
        "-c",
        "user.email=fixture@example.test",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      { cwd, maxBuffer: 1 << 24 },
    )
  ).stdout;
}

/**
 * A real repository's two-patch `format-patch --stdout` series. With `withBinary`,
 * the first patch's last file is binary, so its payload is followed by the
 * signature and the second patch's mail headers.
 */
async function formatPatchSeries(withBinary: boolean): Promise<string> {
  const cwd = await roots.create("docsfab-diff-series-");
  await git(cwd, "init", "-q");
  await writeFile(join(cwd, "guide.md"), "# Guide\n\nThe limit is 100.\n- \nEnd.\n");
  await git(cwd, "add", ".");
  await git(cwd, "commit", "-qm", "Start the guide");
  await writeFile(join(cwd, "guide.md"), "# Guide\n\nThe limit is 500.\nEnd.\n");
  if (withBinary) {
    await writeFile(join(cwd, "logo.bin"), Buffer.from([0, 1, 2, 3, 0, 255, 254, 0, 9, 9, 9, 0]));
  }
  await git(cwd, "add", ".");
  await git(cwd, "commit", "-qm", "Raise the limit");
  await writeFile(join(cwd, "notes.md"), "Second patch notes.\n");
  await git(cwd, "add", ".");
  await git(cwd, "commit", "-qm", "Add notes");
  return git(cwd, "format-patch", "--stdout", "--binary", "-2");
}

describe("unified diff extraction", () => {
  it("opens with a manifest, then keeps every other span a verbatim slice of the original", async () => {
    const extracted = await extract(FORMAT_PATCH);
    const { spans, representation } = extracted;

    expect(spans[0]!.locator.part).toBe("manifest");
    expect(spans[0]!.text.split("\n")).toEqual([
      "diff manifest: 4 files, 3 hunks, +4 -3 lines; 1 message",
      'file 1: modified "src/export.ts"; +3 -2; 2 hunks',
      'file 2: modified "package-lock.json"; +1 -1; 1 hunk; labels: lockfile',
      'file 3: added "assets/logo.png"; +0 -0; 0 hunks; labels: binary; 6 encoded binary lines not extracted',
      'file 4: renamed "docs/old.md" -> "docs/new.md"; +0 -0; 0 hunks',
    ]);
    expect(
      spans.map((span) => [span.locator.part, span.locator.fileOrdinal, span.locator.hunkOrdinal]),
    ).toEqual([
      ["manifest", null, null],
      ["preamble", null, null],
      ["header", 1, null],
      ["hunk", 1, 1],
      ["hunk", 1, 2],
      ["header", 2, null],
      ["hunk", 2, 1],
      ["file", 3, null],
      ["file", 4, null],
    ]);
    const firstHunkStart = FORMAT_PATCH.indexOf("@@ -1,3");
    expect(spans[3]!.locator).toEqual({
      kind: "diff",
      part: "hunk",
      fileOrdinal: 1,
      oldPath: "src/export.ts",
      newPath: "src/export.ts",
      change: "modified",
      labels: [],
      hunkOrdinal: 1,
      hunkCount: null,
      oldStart: 1,
      oldLines: 3,
      newStart: 1,
      newLines: 4,
      startByte: firstHunkStart,
      endByte: FORMAT_PATCH.indexOf("\n@@ -10,2"),
    });
    expect(spans[3]!.text).toContain("+--- this added line looks like a file header");
    expect(spans[2]!.locator.hunkCount).toBe(2);
    expect(spans[7]!.locator).toMatchObject({
      part: "file",
      oldPath: null,
      newPath: "assets/logo.png",
      change: "added",
      labels: ["binary"],
      hunkCount: 0,
    });
    expect(spans[8]!.locator).toMatchObject({
      oldPath: "docs/old.md",
      newPath: "docs/new.md",
      change: "renamed",
    });
    expect(representation.limitations).toEqual(["non-text-content-excluded"]);
    expect(representation.completeness).toBe("partial");
    // Only the binary payload is in no span.
    expectVerbatimSlices(extracted, [
      "literal 12\nTcmZ?wbhEHb6krfwcmS\n\nliteral 0\nHcmV?d00001\n",
    ]);
    for (const span of spans) expect(normalizeSourceLocator(span.locator)).toEqual(span.locator);
    // The operator footer names the exclusion rather than dropping it.
    expect(formatSourceRepresentationLimitations(representation)).toEqual([
      "non-text-content-excluded",
    ]);
  });

  it("ends a binary payload at its last block, so a series' signature and next message stay text", async () => {
    const series = await formatPatchSeries(true);
    const extracted = await extract(series);
    const rows = extracted.spans[0]!.text.split("\n");
    expect(rows[0]).toBe("diff manifest: 3 files, 2 hunks, +2 -2 lines; 2 messages; 2 trailers");
    expect(rows[1]).toBe('file 1: modified "guide.md"; +1 -2; 1 hunk');
    expect(rows[2]).toMatch(
      /^file 2: added "logo\.bin"; \+0 -0; 0 hunks; labels: binary; \d+ encoded binary lines not extracted$/u,
    );
    expect(rows[3]).toBe('file 3: added "notes.md"; +1 -0; 1 hunk');
    expect(rows).toHaveLength(4);
    const parts = extracted.spans.map((span) => [span.locator.part, span.locator.fileOrdinal]);
    expect(parts).toEqual([
      ["manifest", null],
      ["preamble", null],
      ["header", 1],
      ["hunk", 1],
      ["file", 2],
      ["trailer", null],
      ["preamble", null],
      ["header", 3],
      ["hunk", 3],
      ["trailer", null],
    ]);
    const preambles = extracted.spans.filter((span) => span.locator.part === "preamble");
    expect(preambles[0]!.text).toContain("Subject: [PATCH 1/2] Raise the limit");
    expect(preambles[1]!.text).toContain("Subject: [PATCH 2/2] Add notes");
    // The removed line `- ` reads `-- ` and stays in its hunk by the `@@` counts.
    const removal = extracted.spans.find((span) => span.locator.part === "hunk")!;
    expect(removal.text.split("\n")).toContain("-- ");
    for (const trailer of extracted.spans.filter((span) => span.locator.part === "trailer")) {
      expect(trailer.text.startsWith("-- \n")).toBe(true);
    }
    expect(extracted.representation.limitations).toEqual(["non-text-content-excluded"]);
    expect(extracted.spans.every((span) => !span.text.includes("GIT binary patch\nliteral"))).toBe(
      true,
    );
  });

  it("gives each patch of a text-only series its own message span", async () => {
    const series = await formatPatchSeries(false);
    const extracted = await extract(series);
    expect(extracted.spans[0]!.text.split("\n")).toEqual([
      "diff manifest: 2 files, 2 hunks, +2 -2 lines; 2 messages; 2 trailers",
      'file 1: modified "guide.md"; +1 -2; 1 hunk',
      'file 2: added "notes.md"; +1 -0; 1 hunk',
    ]);
    const hunks = extracted.spans.filter((span) => span.locator.part === "hunk");
    expect(hunks.some((span) => span.text.includes("Subject:"))).toBe(false);
    expect(extracted.representation.limitations).toEqual([]);
    expectVerbatimSlices(extracted);
  });

  it("keeps carriage returns, so a line-ending-only change stays visible", async () => {
    const diff = [
      "diff --git a/notes.txt b/notes.txt",
      "--- a/notes.txt",
      "+++ b/notes.txt",
      "@@ -1,2 +1,2 @@",
      "-same text\r",
      "+same text",
      " kept\r",
      "",
    ].join("\n");
    const extracted = await extract(diff);
    const hunk = extracted.spans.find((span) => span.locator.part === "hunk")!;
    expect(hunk.text).toBe("@@ -1,2 +1,2 @@\n-same text\r\n+same text\n kept\r");
    expect(hunk.locator).toMatchObject({ oldLines: 2, newLines: 2 });
    expectVerbatimSlices(extracted);
  });

  it("keeps a 10,000-character line in one hunk span and narrows each piece of a longer one", async () => {
    const tenThousand = `+${"x".repeat(9_999)}`;
    const forty = `+${"é".repeat(20_000)}`;
    const diff = [
      "diff --git a/dist/app.min.js b/dist/app.min.js",
      "--- a/dist/app.min.js",
      "+++ b/dist/app.min.js",
      "@@ -0,0 +1,1 @@",
      tenThousand,
      "diff --git a/data/catalog.json b/data/catalog.json",
      "--- a/data/catalog.json",
      "+++ b/data/catalog.json",
      "@@ -1,0 +1,1 @@",
      forty,
      "",
    ].join("\n");
    const extracted = await extract(diff);
    const minified = extracted.spans.filter(
      (span) => span.locator.fileOrdinal === 1 && span.locator.part === "hunk",
    );
    expect(minified).toHaveLength(1);
    expect(minified[0]!.text).toBe(`@@ -0,0 +1,1 @@\n${tenThousand}`);
    expect(minified[0]!.locator.labels).toEqual(["generated"]);
    const long = extracted.spans.filter(
      (span) => span.locator.fileOrdinal === 2 && span.locator.part === "hunk",
    );
    expect(long.length).toBeGreaterThan(1);
    for (const piece of long) {
      expect(Buffer.byteLength(piece.text, "utf8")).toBeLessThanOrEqual(16_384);
      expect(piece.locator.hunkOrdinal).toBe(1);
    }
    expect(long.map((piece) => piece.text).join("")).toBe(`@@ -1,0 +1,1 @@\n${forty}`);
    // Each piece names its own original bytes.
    expectVerbatimSlices(extracted);
    expect(extracted.representation.limitations).toEqual([]);
  });

  it("labels a non-UTF-8 hunk and admits the rest of the diff as partial", async () => {
    const latin1 = Buffer.concat([
      Buffer.from(
        [
          "diff --git a/docs/caf.txt b/docs/caf.txt",
          "--- a/docs/caf.txt",
          "+++ b/docs/caf.txt",
          "@@ -1 +1 @@",
          "-old",
          "+caf",
        ].join("\n"),
      ),
      Buffer.from([0xe9]),
      Buffer.from(
        [
          "",
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
    const extracted = await extract(latin1);
    expect(extracted.spans[0]!.text.split("\n")).toEqual([
      "diff manifest: 2 files, 2 hunks, +2 -2 lines",
      'file 1: modified "docs/caf.txt"; +1 -1; 1 hunk; labels: non-utf8; 1 hunk body not extracted (not UTF-8)',
      'file 2: modified "docs/plain.md"; +1 -1; 1 hunk',
    ]);
    const firstHunk = extracted.spans.find(
      (span) => span.locator.fileOrdinal === 1 && span.locator.part === "hunk",
    )!;
    expect(firstHunk.text).toBe("@@ -1 +1 @@");
    expect(extracted.representation.limitations).toEqual(["non-text-content-excluded"]);
    // The acquisition gate admits it.
    expect(() =>
      assertSoundRepresentation(extracted.representation, "changes/latin1.diff"),
    ).not.toThrow();
    expectVerbatimSlices(extracted, ["-old\n+café"]);
  });

  it("records unsupported-encoding when a file header is not UTF-8", async () => {
    const original = Buffer.concat([
      Buffer.from("diff --git a/caf"),
      Buffer.from([0xe9]),
      Buffer.from(".txt b/caf"),
      Buffer.from([0xe9]),
      Buffer.from(".txt\n@@ -1 +1 @@\n-a\n+b\n"),
    ]);
    const extracted = await extract(original);
    expect(extracted.representation.limitations).toEqual(["unsupported-encoding"]);
    expect(() =>
      assertSoundRepresentation(extracted.representation, "changes/latin1.diff"),
    ).toThrowError(/extractor-limitation/u);
  });

  it("labels a combined merge diff instead of refusing it", async () => {
    const diff = [
      "diff --cc src/merge.ts",
      "index 111,222..333",
      "--- a/src/merge.ts",
      "+++ b/src/merge.ts",
      "@@@ -1,1 -1,1 +1,1 @@@",
      "- left",
      " -right",
      "++merged",
      "",
    ].join("\n");
    const extracted = await extract(diff);
    expect(extracted.spans[0]!.text.split("\n")).toEqual([
      "diff manifest: 1 file, 0 hunks, +0 -0 lines",
      'file 1: modified "src/merge.ts"; +0 -0; 0 hunks; labels: combined',
    ]);
    expect(extracted.spans[1]!.locator).toMatchObject({ part: "file", labels: ["combined"] });
    expect(extracted.representation.limitations).toEqual([]);
    expectVerbatimSlices(extracted);
  });

  it("labels by basename and whole directory segment, never by substring", async () => {
    const section = (path: string, line: string) =>
      [
        `diff --git a/${path} b/${path}`,
        `--- a/${path}`,
        `+++ b/${path}`,
        "@@ -1,0 +1,2 @@",
        `+${line}`,
        "+const value = 1;",
      ].join("\n");
    const diff = [
      section("go.sum", "example.com/mod v1.0.0 h1:abc="),
      section("third_party/zlib/zlib.h", "#define ZLIB 1"),
      section("api/__generated__/types.ts", "export type A = string;"),
      section("api/client.pb.go", "package api"),
      section("internal/enum_string.go", "// Code generated by stringer; DO NOT EDIT."),
      section("src/vendor-api.ts", "export const api = 1;"),
      section("packages/lockfile-utils/index.ts", "export {};"),
      section("docs/yarn.lock.md", "# Lockfiles"),
      section("src/plain.ts", "export const plain = true;"),
      "",
    ].join("\n");
    const { spans } = await extract(diff);
    const labels = Object.fromEntries(
      spans
        .filter((span) => span.locator.part === "header")
        .map((span) => [span.locator.newPath, span.locator.labels]),
    );
    expect(labels).toEqual({
      "go.sum": ["lockfile"],
      "third_party/zlib/zlib.h": ["vendored"],
      "api/__generated__/types.ts": ["generated"],
      "api/client.pb.go": ["generated"],
      "internal/enum_string.go": ["generated"],
      "src/vendor-api.ts": [],
      "packages/lockfile-utils/index.ts": [],
      "docs/yarn.lock.md": [],
      "src/plain.ts": [],
    });
  });

  it("reads plain, quoted, no-prefix, and absolute-path diffs", async () => {
    const diff = [
      "diff -u old/notes.txt new/notes.txt",
      "--- old/notes.txt\t2026-10-01 10:00:00.000000000 +0000",
      "+++ new/notes.txt\t2026-10-02 10:00:00.000000000 +0000",
      "@@ -1 +1 @@",
      "-before",
      "+after",
      "\\ No newline at end of file",
      'diff --git "a/docs/caf\\303\\251 notes.md" "b/docs/caf\\303\\251 notes.md"',
      "deleted file mode 100644",
      "index 555..000",
      '--- "a/docs/caf\\303\\251 notes.md"',
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-gone",
      "diff --git a/notes.md a/notes.md",
      "--- a/notes.md",
      "+++ a/notes.md",
      "@@ -1 +1 @@",
      "-x",
      "+y",
      "--- /tmp/left.txt",
      "+++ /tmp/right.txt",
      "@@ -1 +1 @@",
      "-l",
      "+r",
      "",
    ].join("\n");
    const extracted = await extract(diff);
    const headers = extracted.spans.filter((span) => span.locator.part === "header");
    expect(
      headers.map((span) => [
        span.locator.oldPath,
        span.locator.newPath,
        span.locator.change,
        span.locator.labels,
      ]),
    ).toEqual([
      ["old/notes.txt", "new/notes.txt", "modified", []],
      ["docs/café notes.md", null, "deleted", []],
      // `--no-prefix`: only one side carries `a/`, so the path keeps it.
      ["a/notes.md", "a/notes.md", "modified", []],
      [null, null, "modified", ["unrepresentable-path"]],
    ]);
    expect(extracted.spans[0]!.text.split("\n")).toEqual([
      "diff manifest: 4 files, 4 hunks, +3 -4 lines",
      'file 1: modified "new/notes.txt"; +1 -1; 1 hunk',
      'file 2: deleted "docs/café notes.md"; +0 -1; 1 hunk',
      'file 3: modified "a/notes.md"; +1 -1; 1 hunk',
      "file 4: modified (path not carried); +1 -1; 1 hunk; labels: unrepresentable-path",
    ]);
    expectVerbatimSlices(extracted);
  });

  it("reads a file's hunks as one span when per-hunk spans would pass the span ceiling", async () => {
    const hunks = (path: string, count: number) => [
      `diff --git a/${path} b/${path}`,
      `--- a/${path}`,
      `+++ b/${path}`,
      ...Array.from({ length: count }, (_, index) => [
        `@@ -${index * 10 + 1},1 +${index * 10 + 1},1 @@`,
        `-old ${index}`,
        `+new ${index}`,
      ]).flat(),
    ];
    const diff = [...hunks("src/many.ts", 40), ...hunks("src/few.ts", 2), ""].join("\n");

    const roomy = await extract(diff);
    expect(roomy.spans.filter((span) => span.locator.part === "hunk")).toHaveLength(42);

    const tight = await extract(diff, { maxSpans: 10 });
    expect(tight.representation.limitations).toEqual([]);
    expect(
      tight.spans.map((span) => [
        span.locator.part,
        span.locator.fileOrdinal,
        span.locator.hunkCount,
      ]),
    ).toEqual([
      ["manifest", null, null],
      ["file", 1, 40],
      ["header", 2, 2],
      ["hunk", 2, null],
      ["hunk", 2, null],
    ]);
    expectVerbatimSlices(tight);

    const tooTight = await extract(diff, { maxSpans: 2 });
    expect(tooTight.representation.limitations).toEqual(["span-budget-truncated"]);
    expect(tooTight.representation.overflows).toEqual([
      { limitation: "span-budget-truncated", limitName: "sources.extractionMaxSpans", observed: 3 },
    ]);
  });

  it("packs the manifest into spans of whole rows that name no original bytes", async () => {
    const diff = [
      ...Array.from({ length: 400 }, (_, index) => [
        `diff --git a/docs/page-${index}.md b/docs/page-${index}.md`,
        `--- a/docs/page-${index}.md`,
        `+++ b/docs/page-${index}.md`,
        "@@ -1 +1 @@",
        "-a",
        "+b",
      ]).flat(),
      "",
    ].join("\n");
    const { spans } = await extract(diff, { maxSpanBytes: 4_096 });
    const manifest = spans.filter((span) => span.locator.part === "manifest");
    expect(manifest.length).toBeGreaterThan(1);
    for (const span of manifest) {
      expect(Buffer.byteLength(span.text, "utf8")).toBeLessThanOrEqual(4_096);
      expect([span.locator.startByte, span.locator.endByte]).toEqual([null, null]);
    }
    const rows = manifest.flatMap((span) => span.text.split("\n"));
    expect(rows).toHaveLength(401);
    expect(rows[400]).toBe('file 400: modified "docs/page-399.md"; +1 -1; 1 hunk');
    expect(spans.slice(0, manifest.length).every((span) => span.locator.part === "manifest")).toBe(
      true,
    );
  });

  it("binds an empty diff as a manifest of no files, complete", async () => {
    const extracted = await extract("");
    expect(extracted.spans.map((span) => [span.locator.part, span.text])).toEqual([
      ["manifest", "diff manifest: 0 files, 0 hunks, +0 -0 lines"],
    ]);
    expect(extracted.representation.completeness).toBe("complete");
  });

  it("keeps text with no file section as one message span", async () => {
    const extracted = await extract("Release notes only.\nNo diff here.\n");
    expect(extracted.spans.map((span) => [span.locator.part, span.text])).toEqual([
      ["manifest", "diff manifest: 0 files, 0 hunks, +0 -0 lines; 1 message"],
      ["preamble", "Release notes only.\nNo diff here."],
    ]);
  });

  it("keeps lines it cannot read as structure as text of the span before them", async () => {
    const diff = [
      "diff -u",
      "@@ -99999999999,1 +1,1 @@",
      "-old",
      "+new",
      "diff --git a/img.png b/img.png",
      "GIT binary patch",
      "literal 3",
      "abc",
      "--- a/after.txt",
      "+++ b/after.txt",
      "@@ -1 +1 @@",
      "-x",
      "+y",
      "",
    ].join("\n");
    const { spans } = await extract(diff);
    expect(spans.map((span) => [span.locator.part, span.locator.fileOrdinal])).toEqual([
      ["manifest", null],
      ["file", 1],
      ["file", 2],
      ["header", 3],
      ["hunk", 3],
    ]);
    expect(spans[1]!.locator).toMatchObject({ oldPath: null, newPath: null, hunkCount: 0 });
    expect(spans[1]!.text).toBe(diff.split("\n").slice(0, 4).join("\n"));
    expect(spans[2]!.text).toBe("diff --git a/img.png b/img.png\nGIT binary patch");
    expect(spans[3]!.locator.newPath).toBe("after.txt");
  });

  it.each(DIFF_FIXTURES)(
    "admits the $shape fixture with its manifest and every span a verbatim slice",
    async ({ name, manifest, uncovered }) => {
      const extracted = await extract(await readFile(join(DIFF_FIXTURE_DIR, name)));
      expect(extracted.spans[0]!.text.split("\n")).toEqual(manifest);
      // Only a Git binary payload is left out, and it is labeled, never dropped silently.
      expect(extracted.representation.limitations).toEqual(
        uncovered.length > 0 ? ["non-text-content-excluded"] : [],
      );
      expect(extracted.representation.completeness).toBe(
        uncovered.length > 0 ? "partial" : "complete",
      );
      expect(() => assertSoundRepresentation(extracted.representation, name)).not.toThrow();
      expectVerbatimSlices(extracted, uncovered);
    },
  );

  // The scan reads whatever diffs this checkout tracks, so it asserts no count:
  // the public export carries fewer of them than the source repository does.
  it("admits every tracked repository diff and patch whole, the owned fixtures among them", async () => {
    const tracked = (
      await exec("git", ["ls-files", "*.diff", "*.patch"], { cwd: REPOSITORY_ROOT })
    ).stdout
      .split("\n")
      .filter(Boolean);
    const owned = DIFF_FIXTURES.map(({ name }) =>
      relative(REPOSITORY_ROOT, join(DIFF_FIXTURE_DIR, name)).split(sep).join("/"),
    );
    expect(tracked).toEqual(expect.arrayContaining(owned));
    // The owned fixtures have their own expectations above; the binary one is partial.
    for (const path of tracked.filter((candidate) => !owned.includes(candidate))) {
      const extracted = await extract(await readFile(join(REPOSITORY_ROOT, path)));
      expect([path, extracted.representation.completeness]).toEqual([path, "complete"]);
      expect(() => assertSoundRepresentation(extracted.representation, path)).not.toThrow();
      expectVerbatimSlices(extracted);
    }
  });

  it("exports the adapter, its media types, and its id for producers to pass directly", () => {
    expect(diffSourceExtractorAdapter.id).toBe(DIFF_SOURCE_EXTRACTOR_ID);
    expect(diffSourceExtractorAdapter.mediaTypes).toEqual([
      DIFF_SOURCE_MEDIA_TYPE,
      PATCH_SOURCE_MEDIA_TYPE,
    ]);
  });
});

describe("diff locator contract", () => {
  const hunk: SourceDiffLocatorV1 = {
    kind: "diff",
    part: "hunk",
    fileOrdinal: 1,
    oldPath: "a.ts",
    newPath: "a.ts",
    change: "modified",
    labels: [],
    hunkOrdinal: 1,
    hunkCount: null,
    oldStart: 1,
    oldLines: 1,
    newStart: 1,
    newLines: 1,
    startByte: 10,
    endByte: 20,
  };
  const manifest: SourceDiffLocatorV1 = {
    ...hunk,
    part: "manifest",
    fileOrdinal: null,
    oldPath: null,
    newPath: null,
    change: null,
    hunkOrdinal: null,
    oldStart: null,
    oldLines: null,
    newStart: null,
    newLines: null,
    startByte: null,
    endByte: null,
  };

  it("admits each part only with the fields that part names", () => {
    expect(normalizeSourceLocator(hunk)).toEqual(hunk);
    expect(normalizeSourceLocator(manifest)).toEqual(manifest);
    const reject = (locator: Record<string, unknown>) =>
      expect(() => normalizeSourceLocator(locator)).toThrowError(
        "Source-evidence contract rejected: invalid-value.",
      );
    reject({ ...hunk, oldStart: null });
    reject({ ...hunk, hunkCount: 1 });
    reject({ ...hunk, hunkOrdinal: 0 });
    reject({ ...hunk, fileOrdinal: null });
    reject({ ...hunk, startByte: null });
    reject({ ...hunk, endByte: 10 });
    reject({ ...hunk, part: "header", hunkOrdinal: null, hunkCount: 0 });
    reject({ ...hunk, change: "moved" });
    reject({ ...hunk, labels: ["minified"] });
    reject({ ...hunk, labels: ["vendored", "lockfile"] });
    reject({ ...hunk, labels: ["lockfile", "lockfile"] });
    reject({ ...hunk, newPath: "" });
    reject({ ...hunk, newPath: "/etc/passwd" });
    reject({ ...hunk, newPath: "docs/../secret" });
    reject({ ...hunk, newPath: "x\nfile 2: forged" });
    reject({ ...hunk, newPath: "evil\u202etxt.exe" });
    reject({ ...hunk, newPath: "C:\\b\\x.txt" });
    reject({ ...hunk, newPath: "C:/b/x.txt" });
    reject({ ...hunk, oldPath: "docs\\x.txt" });
    reject({ ...hunk, part: "note" });
    reject({ ...hunk, part: "note", hunkOrdinal: null, hunkCount: 1 });
    expect(
      normalizeSourceLocator({
        ...hunk,
        part: "note",
        hunkOrdinal: null,
        oldStart: null,
        oldLines: null,
        newStart: null,
        newLines: null,
      }),
    ).toMatchObject({ part: "note", hunkCount: null });
    reject({
      ...hunk,
      newPath: "a".repeat(limitDefinition("sources.authorityMemberPathMaxChars").value + 1),
    });
    reject({ ...manifest, startByte: 0, endByte: 1 });
    reject({ ...manifest, labels: ["binary"] });
    reject({ ...manifest, part: "preamble" });
    expect(() => normalizeSourceLocator({ ...hunk, extra: 1 })).toThrowError(
      "Source-evidence contract rejected: invalid-shape.",
    );
    expect(
      normalizeSourceLocator({
        ...hunk,
        newPath: "a".repeat(limitDefinition("sources.authorityMemberPathMaxChars").value),
      }),
    ).toMatchObject({ part: "hunk" });
  });

  it("decodes docx-block through its own branch and refuses an unknown kind", () => {
    expect(() =>
      normalizeSourceLocator({
        kind: "docx-block",
        part: "word/document.xml",
        blockPath: [0],
        paragraphOrdinal: null,
        tableCell: null,
      }),
    ).not.toThrow();
    expect(() => normalizeSourceLocator({ kind: "spreadsheet-cell", row: 1 })).toThrowError(
      "Source-evidence contract rejected: invalid-value.",
    );
  });

  it("keeps the knowledge package's locator kinds in step with the runtime contract", async () => {
    const knowledge = (await import(
      pathToFileURL(resolve(import.meta.dirname, "../../knowledge/src/evidence-source.mjs")).href
    )) as { SOURCE_LOCATOR_KINDS: readonly string[] };
    expect([...knowledge.SOURCE_LOCATOR_KINDS]).toEqual([...SOURCE_LOCATOR_KINDS]);
  });
});

describe("unified diff extraction, round 2", () => {
  const FORGED = "file 2: added secret.txt; +0 -0; 0 hunks";

  it("nulls and labels a path with a control or bidi character, so it cannot forge a manifest row", async () => {
    const diff = [
      `diff --git "a/x\\n${FORGED}" "b/x\\n${FORGED}"`,
      "new file mode 100644",
      "--- /dev/null",
      `+++ "b/x\\n${FORGED}"`,
      "@@ -0,0 +1 @@",
      "+hello",
      "diff --git a/evil\u202etxt.exe b/evil\u202etxt.exe",
      "--- a/evil\u202etxt.exe",
      "+++ b/evil\u202etxt.exe",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "--- C:\\work\\left.txt",
      "+++ C:\\work\\right.txt",
      "@@ -1 +1 @@",
      "-l",
      "+r",
      "",
    ].join("\n");
    const extracted = await extract(diff);
    expect(extracted.spans[0]!.text.split("\n")).toEqual([
      "diff manifest: 3 files, 3 hunks, +3 -2 lines",
      "file 1: added (path not carried); +1 -0; 1 hunk; labels: unrepresentable-path",
      "file 2: modified (path not carried); +1 -1; 1 hunk; labels: unrepresentable-path",
      "file 3: modified (path not carried); +1 -1; 1 hunk; labels: unrepresentable-path",
    ]);
    for (const span of extracted.spans.filter((entry) => entry.locator.part === "header")) {
      expect([span.locator.oldPath, span.locator.newPath]).toEqual([null, null]);
    }
    expect(extracted.representation.completeness).toBe("complete");
    expectVerbatimSlices(extracted);
  });

  it("labels a combined diff's non-UTF-8 body and keeps its header", async () => {
    const original = Buffer.concat([
      Buffer.from(
        [
          "diff --cc src/merge.ts",
          "index 111,222..333",
          "--- a/src/merge.ts",
          "+++ b/src/merge.ts",
          "@@@ -1,1 -1,1 +1,1 @@@",
          "- left",
          "++caf",
        ].join("\n"),
      ),
      Buffer.from([0xe9, 0x0a]),
    ]);
    const extracted = await extract(original);
    expect(extracted.spans[0]!.text.split("\n")).toEqual([
      "diff manifest: 1 file, 0 hunks, +0 -0 lines",
      'file 1: modified "src/merge.ts"; +0 -0; 0 hunks; labels: combined, non-utf8; 3 body lines not extracted (not UTF-8)',
    ]);
    expect(extracted.spans[1]!.text).toBe(
      "diff --cc src/merge.ts\nindex 111,222..333\n--- a/src/merge.ts\n+++ b/src/merge.ts",
    );
    expect(extracted.representation.limitations).toEqual(["non-text-content-excluded"]);
    expect(() =>
      assertSoundRepresentation(extracted.representation, "changes/merge.diff"),
    ).not.toThrow();
  });

  it("labels a `diff -r` note that is not UTF-8 after a binary file", async () => {
    const original = Buffer.concat([
      Buffer.from(
        "diff -ru a/logo.png b/logo.png\nBinary files a/logo.png and b/logo.png differ\nOnly in a: caf",
      ),
      Buffer.from([0xe9, 0x0a]),
    ]);
    const extracted = await extract(original);
    expect(extracted.spans[0]!.text.split("\n")).toEqual([
      "diff manifest: 1 file, 0 hunks, +0 -0 lines",
      'file 1: modified "logo.png"; +0 -0; 0 hunks; labels: binary, non-utf8; 1 body line not extracted (not UTF-8)',
    ]);
    expect(extracted.representation.limitations).toEqual(["non-text-content-excluded"]);
  });

  it("reads `git log -p` commits as messages and labels a non-UTF-8 author line", async () => {
    const sha = (digit: string) => digit.repeat(40);
    const original = Buffer.concat([
      Buffer.from(
        [
          `commit ${sha("a")}`,
          "Author: Ada <ada@example.test>",
          "",
          "    Rename the guide",
          "",
          "diff --git a/old.md b/new.md",
          "similarity index 100%",
          "rename from old.md",
          "rename to new.md",
          "",
          `commit ${sha("b")}`,
          "Author: Jos",
        ].join("\n"),
      ),
      Buffer.from([0xe9]),
      Buffer.from(
        [
          " <jose@example.test>",
          "",
          "    Edit a",
          "",
          "diff --git a/a.txt b/a.txt",
          "--- a/a.txt",
          "+++ b/a.txt",
          "@@ -1 +1 @@",
          "-a",
          "+b",
          "",
        ].join("\n"),
      ),
    ]);
    const extracted = await extract(original);
    expect(extracted.spans[0]!.text.split("\n")).toEqual([
      "diff manifest: 2 files, 1 hunk, +1 -1 lines; 2 messages; 5 message lines not extracted (not UTF-8)",
      'file 1: renamed "old.md" -> "new.md"; +0 -0; 0 hunks',
      'file 2: modified "a.txt"; +1 -1; 1 hunk',
    ]);
    expect(extracted.spans.map((span) => span.locator.part)).toEqual([
      "manifest",
      "preamble",
      "file",
      "header",
      "hunk",
    ]);
    expect(extracted.spans[2]!.text).toBe(
      "diff --git a/old.md b/new.md\nsimilarity index 100%\nrename from old.md\nrename to new.md\n",
    );
    expect(extracted.representation.limitations).toEqual(["non-text-content-excluded"]);
  });

  it("keeps whitespace-only message text as a span and a leading BOM as its own", async () => {
    const whitespace = await extract(
      "\t\n\u00a0\ndiff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n",
    );
    expect(whitespace.spans.map((span) => [span.locator.part, span.text])).toEqual([
      [
        "manifest",
        expect.stringMatching(/^diff manifest: 1 file, 1 hunk, \+1 -1 lines; 1 message\n/u),
      ],
      ["preamble", "\t\n\u00a0"],
      ["header", "diff --git a/x b/x\n--- a/x\n+++ b/x"],
      ["hunk", "@@ -1 +1 @@\n-a\n+b"],
    ]);
    const bom = await extract("\uFEFFdiff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n");
    expect(
      bom.spans.map((span) => [span.locator.part, span.locator.startByte, span.locator.endByte]),
    ).toEqual([
      ["manifest", null, null],
      ["preamble", 0, 3],
      ["header", 3, 37],
      ["hunk", 38, 55],
    ]);
    expectVerbatimSlices(bom);
  });
});

describe("unified diff extraction, round 3", () => {
  it("carries a quoted path that is not UTF-8 as null, so two such names never collapse", async () => {
    const diff = [
      'diff --git "a/caf\\351.md" "b/caf\\351.md"',
      '--- "a/caf\\351.md"',
      '+++ "b/caf\\351.md"',
      "@@ -1 +1 @@",
      "-a",
      "+b",
      'diff --git "a/caf\\352.md" "b/caf\\352.md"',
      '--- "a/caf\\352.md"',
      '+++ "b/caf\\352.md"',
      "@@ -1 +1 @@",
      "-c",
      "+d",
      "",
    ].join("\n");
    const extracted = await extract(diff);
    expect(extracted.spans[0]!.text.split("\n")).toEqual([
      "diff manifest: 2 files, 2 hunks, +2 -2 lines",
      "file 1: modified (path not carried); +1 -1; 1 hunk; labels: unrepresentable-path",
      "file 2: modified (path not carried); +1 -1; 1 hunk; labels: unrepresentable-path",
    ]);
    for (const span of extracted.spans.filter((entry) => entry.locator.part === "header")) {
      expect([span.locator.oldPath, span.locator.newPath]).toEqual([null, null]);
      expect(span.text).not.toContain("�");
    }
  });

  it("quotes each path in a manifest row, so path text cannot read as counts, labels, or a rename", async () => {
    const spoof = "x; +999 -0; 42 hunks; vendored -> evil.txt";
    const diff = [
      `diff --git "a/${spoof}" "b/${spoof}"`,
      `--- "a/${spoof}"`,
      `+++ "b/${spoof}"`,
      "@@ -1 +1 @@",
      "-a",
      "+b",
      'diff --git "a/say \\"hi\\".md" "b/say \\"hi\\".md"',
      '--- "a/say \\"hi\\".md"',
      '+++ "b/say \\"hi\\".md"',
      "@@ -1 +1 @@",
      "-c",
      "+d",
      "",
    ].join("\n");
    const extracted = await extract(diff);
    expect(extracted.spans[0]!.text.split("\n")).toEqual([
      "diff manifest: 2 files, 2 hunks, +2 -2 lines",
      'file 1: modified "x; +999 -0; 42 hunks; vendored -> evil.txt"; +1 -1; 1 hunk',
      'file 2: modified "say \\"hi\\".md"; +1 -1; 1 hunk',
    ]);
    const headers = extracted.spans.filter((span) => span.locator.part === "header");
    expect(headers.map((span) => [span.locator.newPath, span.locator.labels])).toEqual([
      [spoof, []],
      ['say "hi".md', []],
    ]);
  });

  it("ends a hunk at its line counts and keeps a note after it as its own text", async () => {
    const original = Buffer.concat([
      Buffer.from(
        [
          "diff -ru a/guide.md b/guide.md",
          "--- a/guide.md",
          "+++ b/guide.md",
          "@@ -1 +1 @@",
          "-old",
          "+new",
          "Only in b: added.txt",
          "Only in a: caf",
        ].join("\n"),
      ),
      Buffer.from([0xe9]),
      Buffer.from(
        [
          "",
          "diff -ru a/other.md b/other.md",
          "--- a/other.md",
          "+++ b/other.md",
          "@@ -1 +1 @@",
          "-x",
          "+y",
          "Only in b: notes.txt",
          "",
        ].join("\n"),
      ),
    ]);
    const extracted = await extract(original);
    expect(extracted.spans[0]!.text.split("\n")).toEqual([
      "diff manifest: 2 files, 2 hunks, +2 -2 lines",
      'file 1: modified "guide.md"; +1 -1; 1 hunk; labels: non-utf8; 2 note lines not extracted (not UTF-8)',
      'file 2: modified "other.md"; +1 -1; 1 hunk',
    ]);
    expect(
      extracted.spans.map((span) => [span.locator.part, span.locator.fileOrdinal, span.text]),
    ).toEqual([
      ["manifest", null, expect.any(String)],
      ["header", 1, "diff -ru a/guide.md b/guide.md\n--- a/guide.md\n+++ b/guide.md"],
      ["hunk", 1, "@@ -1 +1 @@\n-old\n+new"],
      ["header", 2, "diff -ru a/other.md b/other.md\n--- a/other.md\n+++ b/other.md"],
      ["hunk", 2, "@@ -1 +1 @@\n-x\n+y"],
      ["note", 2, "Only in b: notes.txt"],
    ]);
    expect(extracted.representation.limitations).toEqual(["non-text-content-excluded"]);
    for (const span of extracted.spans) {
      expect(normalizeSourceLocator(span.locator)).toEqual(span.locator);
    }
    expectVerbatimSlices(extracted, ["Only in b: added.txt\nOnly in a: café"]);
  });
});

describe("documented diff manifest examples", () => {
  /** The rows of the first `text` block in `page` that is a diff manifest. */
  async function documentedManifest(page: string): Promise<string[]> {
    const text = await readFile(join(REPOSITORY_ROOT, page), "utf8");
    const block = [...text.matchAll(/```text\n([\s\S]*?)\n\s*```/gu)]
      .map((match) => match[1]!)
      .find((body) => body.trimStart().startsWith("diff manifest:"));
    if (block === undefined) throw new Error(`${page} has no diff manifest example`);
    return block.split("\n").map((row) => row.trim());
  }

  const edit = (path: string, hunks: readonly string[][]) => [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    ...hunks.flat(),
  ];

  it("matches the source-evidence contract's example", async () => {
    const diff = [
      "Subject: [PATCH] Raise the export limit",
      "",
      ...edit("src/export.ts", [
        ["@@ -1,1 +1,1 @@", "-const limit = 100;", "+const limit = 500;"],
        ["@@ -20,1 +20,1 @@", "-  return 'old';", "+  return 'new';"],
      ]),
      "diff --git a/docs/old.md b/docs/new.md",
      "similarity index 100%",
      "rename from docs/old.md",
      "rename to docs/new.md",
      "diff --git a/package-lock.json b/package-lock.json",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/package-lock.json",
      "@@ -0,0 +1 @@",
      '+{"lockfileVersion":3}',
      "",
    ].join("\n");
    const { spans } = await extract(diff);
    expect(spans[0]!.text.split("\n")).toEqual(
      await documentedManifest("packages/runtime/docs/reference/contracts/source-evidence.md"),
    );
  });

  it("matches the tracked source-evidence reference's example", async () => {
    const diff = [
      "Subject: [PATCH] Raise the export limit",
      "",
      ...edit("src/export.ts", [
        ["@@ -1,1 +1,1 @@", "-const limit = 100;", "+const limit = 500;"],
        ["@@ -20,1 +20,1 @@", "-  return 'old';", "+  return 'new';"],
      ]),
      ...edit("dist/export.min.js", [["@@ -1,0 +1,1 @@", `+${"m".repeat(9_999)}`]]),
      "",
    ].join("\n");
    const { spans } = await extract(diff);
    expect(spans[0]!.text.split("\n")).toEqual(
      await documentedManifest("docs/reference/status-and-configuration/source-evidence.md"),
    );
  });
});
