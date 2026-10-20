// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { analyzeRstRegions, selectRstRegion } from "../src/rst-authoring/regions.js";
import {
  applyRstProseEdit,
  selectRstCandidate,
  verifyRstPreservation,
} from "../src/rst-authoring/preservation.js";

const enc = new TextEncoder();
const dec = new TextDecoder();
const path = "docs/guide.rst";

const original = [
  ".. _start:",
  "",
  "Getting started",
  "===============",
  "",
  "Tested with café hardware.  ",
  "",
  "Install the toolkit before running examples.",
  "",
  ".. tabs::",
  "",
  "   .. tab:: pip",
  "",
  "      pip install toolkit",
  "",
  ".. list-table:: Supported targets",
  "   :header-rows: 1",
  "",
  "   * - Platform",
  "     - Version",
  "",
  ".. image:: diagram.png",
  "   :alt: Diagram",
  "",
  ".. include:: prerequisite.rst",
  "",
  ".. toctree::",
  "   :maxdepth: 1",
  "",
  "   details",
  "",
  ".. code-block:: python",
  "",
  "   print('untouched')",
  "",
  ".. note::",
  "",
  "   Never edit this note.",
  "",
  "See :doc:`details`, :ref:`start`, and |product|.",
  "",
  ".. |product| replace:: Toolkit",
  "",
].join("\r\n");

describe("bounded RST regions", () => {
  it("identifies byte-accurate plain paragraphs and preserves opaque syntax", () => {
    const bytes = enc.encode(original);
    const analysis = analyzeRstRegions(path, bytes);
    expect(analysis.newline).toBe("crlf");
    expect(analysis.finalNewline).toBe(true);
    expect(
      analysis.paragraphs.map((region) => dec.decode(bytes.slice(region.start, region.end))),
    ).toEqual(["Tested with café hardware.  ", "Install the toolkit before running examples."]);
    const target = analysis.paragraphs[1]!;
    expect(target.start).toBe(enc.encode(original.slice(0, original.indexOf("Install"))).length);
    const selection = selectRstRegion(analysis, {
      kind: "replace",
      start: target.start,
      end: target.end,
    });
    expect(selection.manifest.ranges.some((range) => range.kind === "opaque")).toBe(true);
    const result = applyRstProseEdit(
      bytes,
      selection,
      "Install the tested toolkit before running examples.",
    );
    expect(dec.decode(result.bytes)).toContain(
      "Install the tested toolkit before running examples.\r\n",
    );
    expect(result.receipt.unchangedRanges).toBe(selection.manifest.ranges.length);
    expect(result.receipt.candidateSha256).not.toBe(analysis.baseSha256);
  });

  it("inserts one plain paragraph before a complete opaque block", () => {
    const bytes = enc.encode(original);
    const analysis = analyzeRstRegions(path, bytes);
    const tabStart = enc.encode(original.slice(0, original.indexOf(".. tabs::"))).length;
    const selection = selectRstRegion(analysis, { kind: "insert", offset: tabStart });
    const result = applyRstProseEdit(bytes, selection, "The tested environment uses Toolkit 2.");
    expect(dec.decode(result.bytes)).toContain(
      "The tested environment uses Toolkit 2.\r\n\r\n.. tabs::",
    );
    expect(result.receipt.selectedStart).toBe(tabStart);
    expect(selectRstCandidate(analysis, bytes, result.bytes).selection).toEqual(selection);
  });

  it("recognizes an insertion whose prose shares the following block prefix", () => {
    const bytes = enc.encode("Earlier prose.\n\nThe next block starts here.\n");
    const analysis = analyzeRstRegions(path, bytes);
    const slot = analysis.insertionSlots[0]!;
    const selection = selectRstRegion(analysis, { kind: "insert", offset: slot.offset });
    const candidate = applyRstProseEdit(bytes, selection, "The next prerequisite is required.");
    expect(selectRstCandidate(analysis, bytes, candidate.bytes).selection).toEqual(selection);
    const tampered = enc.encode(
      dec.decode(candidate.bytes).replace("Earlier prose.", "Altered prose."),
    );
    expect(() => verifyRstPreservation(bytes, tampered, selection)).toThrowError(
      expect.objectContaining({ code: "rst-preservation-mismatch", path }),
    );
  });

  it("does not offer slots inside directive, label, literal, note, or indented bodies", () => {
    const source = [
      "Safe preceding prose.",
      "",
      ".. _anchor:",
      "",
      "Heading",
      "=======",
      "",
      ".. tabs::",
      "   :class: tabs",
      "",
      "   .. tab:: pip",
      "",
      "      pip install tool",
      "",
      "Example::",
      "",
      "   literal code",
      "",
      ".. note::",
      "",
      "   nested note",
      "",
      "Term",
      "   Definition",
      "",
      "Following prose.",
      "",
    ].join("\n");
    const analysis = analyzeRstRegions(path, enc.encode(source));
    const allowed = source.indexOf(".. _anchor:");
    expect(analysis.insertionSlots.map((slot) => slot.offset)).toEqual([allowed]);
    for (const marker of [
      "Heading",
      "   .. tab::",
      "   literal code",
      "   nested note",
      "   Definition",
    ]) {
      const offset = enc.encode(source.slice(0, source.indexOf(marker))).length;
      expect(() => selectRstRegion(analysis, { kind: "insert", offset })).toThrowError(
        expect.objectContaining({ code: "rst-edit-region-unsupported", path }),
      );
    }
  });

  it.each([
    ["directive option", ":header-rows: 1", ":header-rows: 2"],
    ["label", ".. _start:", ".. _other:"],
    ["tab body", "pip install toolkit", "pip install other"],
    ["table", "Platform", "Framework"],
    ["image", "diagram.png", "diagram.svg"],
    ["include", "prerequisite.rst", "different.rst"],
    ["toctree", "details", "otherpg"],
    ["code", "print('untouched')", "print('modified')"],
    ["note", "Never edit this note.", "Now edit this note."],
    ["role", ":doc:`details`", ":doc:`otherpg`"],
    ["substitution", "|product|", "|service|"],
    ["trailing space", "hardware.  ", "hardware. "],
  ])("rejects a protected %s byte mutation", (_name, before, after) => {
    const base = enc.encode(original);
    const analysis = analyzeRstRegions(path, base);
    const paragraph = analysis.paragraphs[1]!;
    const selection = selectRstRegion(analysis, {
      kind: "replace",
      start: paragraph.start,
      end: paragraph.end,
    });
    const changed = original
      .replace(before, after)
      .replace(
        "Install the toolkit before running examples.",
        "Install the tested toolkit before running examples.",
      );
    expect(() => verifyRstPreservation(base, enc.encode(changed), selection)).toThrowError(
      expect.objectContaining({ code: "rst-preservation-mismatch", path }),
    );
  });

  it("refuses unsafe selections, invalid UTF-8 and mixed newline semantics", () => {
    const bytes = enc.encode(original);
    const analysis = analyzeRstRegions(path, bytes);
    const roleStart = enc.encode(original.slice(0, original.indexOf("See :doc:"))).length;
    expect(() =>
      selectRstRegion(analysis, { kind: "replace", start: roleStart, end: roleStart + 3 }),
    ).toThrowError(expect.objectContaining({ code: "rst-edit-region-unsupported", path }));
    expect(() => analyzeRstRegions(path, new Uint8Array([0xff]))).toThrowError(
      expect.objectContaining({ code: "rst-edit-region-unsupported", path }),
    );
    expect(() => analyzeRstRegions(path, new Uint8Array([0xef, 0xbb, 0xbf, 0x41]))).toThrowError(
      expect.objectContaining({ code: "rst-edit-region-unsupported", path }),
    );
    expect(() => analyzeRstRegions(path, enc.encode("Plain.\n\r\nOther.\r\n"))).toThrowError(
      expect.objectContaining({ code: "rst-edit-region-unsupported", path }),
    );
    for (const control of ["\u000b", "\u000c"]) {
      expect(() =>
        analyzeRstRegions(path, enc.encode(`${control}Indented content.\n`)),
      ).toThrowError(expect.objectContaining({ code: "rst-edit-region-unsupported", path }));
    }
  });

  it("recognizes short heading adornments and preserves no-final-newline state", () => {
    const source = enc.encode("A\n=\n\nEditable prose");
    const analysis = analyzeRstRegions(path, source);
    expect(analysis.finalNewline).toBe(false);
    expect(analysis.paragraphs).toHaveLength(1);
    expect(
      dec.decode(source.subarray(analysis.paragraphs[0]!.start, analysis.paragraphs[0]!.end)),
    ).toBe("Editable prose");
    const paragraph = analysis.paragraphs[0]!;
    const selected = selectRstRegion(analysis, {
      kind: "replace",
      start: paragraph.start,
      end: paragraph.end,
    });
    const applied = applyRstProseEdit(source, selected, "Updated prose");
    expect(dec.decode(applied.bytes)).toBe("A\n=\n\nUpdated prose");
    expect(selectRstCandidate(analysis, source, applied.bytes).receipt).toEqual(applied.receipt);
  });

  it("keeps every RST punctuation adornment and its attached title opaque", () => {
    const adornments = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";
    for (const character of adornments) {
      const source = `Setup\n${character.repeat(5)}\n\nEditable prose.\n`;
      const bytes = enc.encode(source);
      const analysis = analyzeRstRegions(path, bytes);
      expect(
        analysis.paragraphs.map((region) => dec.decode(bytes.subarray(region.start, region.end))),
        `adornment ${JSON.stringify(character)}`,
      ).toEqual(["Editable prose."]);
      const changed = enc.encode(source.replace("Setup", "Changed title"));
      expect(() => selectRstCandidate(analysis, bytes, changed)).toThrowError(
        expect.objectContaining({ code: "rst-edit-region-unsupported", path }),
      );
      const quoted = enc.encode(`Example::\n\n${character} quoted code\n\nEditable prose.\n`);
      const quotedAnalysis = analyzeRstRegions(path, quoted);
      expect(
        quotedAnalysis.paragraphs.map((region) =>
          dec.decode(quoted.subarray(region.start, region.end)),
        ),
        `quoted prefix ${JSON.stringify(character)}`,
      ).toEqual(["Editable prose."]);
    }
  });

  it("keeps a trailing-space literal introducer and quoted body opaque", () => {
    const source = [
      "Ordinary preceding prose.",
      "",
      "Run this example::  ",
      "",
      "> quoted code",
      "> next line",
      "",
      "Ordinary following prose.",
      "",
    ].join("\n");
    const bytes = enc.encode(source);
    const analysis = analyzeRstRegions(path, bytes);
    expect(
      analysis.paragraphs.map((region) => dec.decode(bytes.subarray(region.start, region.end))),
    ).toEqual(["Ordinary preceding prose.", "Ordinary following prose."]);
    for (const marker of ["Run this example::  ", "> quoted code"]) {
      const start = enc.encode(source.slice(0, source.indexOf(marker))).length;
      expect(() =>
        selectRstRegion(analysis, { kind: "replace", start, end: start + 1 }),
      ).toThrowError(expect.objectContaining({ code: "rst-edit-region-unsupported", path }));
    }
    const introStart = enc.encode(source.slice(0, source.indexOf("Run this example::  "))).length;
    expect(selectRstRegion(analysis, { kind: "insert", offset: introStart }).kind).toBe("insert");
    const quotedStart = enc.encode(source.slice(0, source.indexOf("> quoted code"))).length;
    expect(() => selectRstRegion(analysis, { kind: "insert", offset: quotedStart })).toThrowError(
      expect.objectContaining({ code: "rst-edit-region-unsupported", path }),
    );
    expect(() =>
      selectRstCandidate(analysis, bytes, enc.encode(source.replace("> quoted code", "> changed"))),
    ).toThrowError(expect.objectContaining({ code: "rst-edit-region-unsupported", path }));
  });

  it("keeps POSIX, GNU plus, and DOS/VMS option-list entries opaque", () => {
    for (const option of ["--help", "-a", "+x", "/V"]) {
      const source = `${option}  Show usage.\n\nOrdinary prose.\n`;
      const bytes = enc.encode(source);
      const analysis = analyzeRstRegions(path, bytes);
      expect(
        analysis.paragraphs.map((region) => dec.decode(bytes.subarray(region.start, region.end))),
      ).toEqual(["Ordinary prose."]);
      expect(() =>
        selectRstCandidate(analysis, bytes, enc.encode(source.replace("Show usage", "Show help"))),
      ).toThrowError(expect.objectContaining({ code: "rst-edit-region-unsupported", path }));
    }
  });

  it("keeps Unicode bullet-list items opaque", () => {
    for (const bullet of ["•", "‣", "⁃"]) {
      const source = `${bullet} First item.\n\nOrdinary prose.\n`;
      const bytes = enc.encode(source);
      const analysis = analyzeRstRegions(path, bytes);
      expect(
        analysis.paragraphs.map((region) => dec.decode(bytes.subarray(region.start, region.end))),
      ).toEqual(["Ordinary prose."]);
      expect(() =>
        selectRstCandidate(analysis, bytes, enc.encode(source.replace("First", "Changed"))),
      ).toThrowError(expect.objectContaining({ code: "rst-edit-region-unsupported", path }));
    }
  });

  it("refuses replacement text that introduces RST structure", () => {
    const bytes = enc.encode("Plain paragraph.\n\n.. note::\n\n   Protected.\n");
    const analysis = analyzeRstRegions(path, bytes);
    const paragraph = analysis.paragraphs[0]!;
    const selection = selectRstRegion(analysis, {
      kind: "replace",
      start: paragraph.start,
      end: paragraph.end,
    });
    for (const prose of [
      ".. note::",
      "A :doc:`target` link.",
      "  indented text",
      "A title\n=======",
      "One.\n\nTwo.",
      "A |substitution|.",
      ":field: value",
      "A literal::",
      "\uFEFFhidden BOM",
      "a. list item",
      "(1) list item",
      "#. list item",
      "IV. list item",
      ">>> print('code')",
      "New heading\n/////",
      "Run this example::  ",
      "> quoted code",
      "--help  Show usage.",
      "/V  Show usage.",
      "• First item.",
      "‣ First item.",
      "⁃ First item.",
    ]) {
      expect(() => applyRstProseEdit(bytes, selection, prose)).toThrowError(
        expect.objectContaining({ code: "rst-edit-region-unsupported", path }),
      );
    }
  });

  it("keeps ordinary numbered sentences eligible", () => {
    const analysis = analyzeRstRegions(
      path,
      enc.encode("Version 1.2 works.\n\nA toolkit is available.\n"),
    );
    expect(analysis.paragraphs).toHaveLength(2);
  });

  it("keeps ordinary Unicode prose eligible without treating letters as adornments", () => {
    const bytes = enc.encode("Café matériel est prêt.\n\n設備の準備ができました。\n");
    const analysis = analyzeRstRegions(path, bytes);
    expect(
      analysis.paragraphs.map((region) => dec.decode(bytes.subarray(region.start, region.end))),
    ).toEqual(["Café matériel est prêt.", "設備の準備ができました。"]);
  });

  it("detects a changed final newline even when the selected paragraph is valid", () => {
    const bytes = enc.encode(original);
    const analysis = analyzeRstRegions(path, bytes);
    const paragraph = analysis.paragraphs[1]!;
    const selection = selectRstRegion(analysis, {
      kind: "replace",
      start: paragraph.start,
      end: paragraph.end,
    });
    const changed = original
      .replace(
        "Install the toolkit before running examples.",
        "Install the tested toolkit before running examples.",
      )
      .slice(0, -2);
    expect(() => verifyRstPreservation(bytes, enc.encode(changed), selection)).toThrowError(
      expect.objectContaining({ code: "rst-preservation-mismatch", path }),
    );
  });
});
