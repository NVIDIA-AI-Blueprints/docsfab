// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { access, link, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { limit } from "../src/config/limits.js";
import { buildContentIndex } from "../src/content-ir/indexer.js";
import { createConfinedToolSet } from "../src/harness/confined-tools.js";
import { VIRTUAL_WORKSPACE_CWD } from "../src/harness/pi-session.js";
import { readTextRenderingForStep } from "../src/harness/pi.js";
import {
  REPOSITORY_BOOTSTRAP_RESULT_KIND,
  admitRepositoryBootstrapReply,
  isRepositoryBootstrapGuidancePath,
  type RepositoryBootstrapReplyV1,
} from "../src/onboarding/bootstrap-result.js";
import { getWorkflow } from "../src/workflow-registry/catalog.js";
import {
  SourceCitationRefusal,
  addObservedLines,
  decodeSourceCitationLocator,
  mintSourceCitations,
  mintedSourceCitationHolds,
  physicalLines,
  type ObservedSourceLinesV1,
  type SourceCitationLocations,
  type SourceCitationSource,
} from "../src/repository/source-citation.js";
import { temporaryRoots } from "./helpers/temp.js";
import { configureCredential } from "./helpers/configured-credential.js";

const temporaryDirectories = temporaryRoots();
const AT: SourceCitationLocations = { item: "$.evidence[]", total: "$.evidence" };
const CREDENTIAL = "api_key=syntheticxxxxxxxxxxxxxxxxxxxxxxxx";

function mint(
  files: Record<string, string | Uint8Array | "untracked" | "unreadable">,
  locators: { path: string; startLine: number; endLine: number }[],
  observed?: ObservedSourceLinesV1,
) {
  const sources = new Map<string, SourceCitationSource>(
    Object.entries(files).map(([path, value]) => [
      path,
      typeof value === "string" && value !== "untracked" && value !== "unreadable"
        ? Buffer.from(value, "utf8")
        : value,
    ]),
  );
  const everything: ObservedSourceLinesV1 = Object.fromEntries(
    Object.keys(files).map((path) => [path, [[1, Number.MAX_SAFE_INTEGER] as const]]),
  );
  return mintSourceCitations(locators, sources, observed ?? everything, AT);
}

function refusal(run: () => unknown): SourceCitationRefusal {
  try {
    run();
  } catch (error) {
    if (error instanceof SourceCitationRefusal) return error;
    throw error;
  }
  throw new Error("expected a source citation refusal");
}

describe("host-minted source citation lines (#1741)", () => {
  it("mints the exact bytes of LF-delimited lines, keeping CRLF, BOM and decomposed Unicode", () => {
    const file = "﻿first\r\nsecond\r\nthird\ncafé\nlast-without-feed";
    const quote = (startLine: number, endLine: number) =>
      mint({ "a.md": file }, [{ path: "a.md", startLine, endLine }])[0]!.quote;
    // BOM stays on line 1; a CRLF line ends before its CR.
    expect(quote(1, 1)).toBe("﻿first");
    // Interior CRLF terminators stay; only the last line's terminator is dropped.
    expect(quote(1, 2)).toBe("﻿first\r\nsecond");
    expect(quote(3, 3)).toBe("third");
    expect(quote(4, 4)).toBe("café");
    expect(quote(5, 5)).toBe("last-without-feed");
    for (let start = 1; start <= 5; start++)
      for (let end = start; end <= 5; end++) expect(file).toContain(quote(start, end));
  });

  it("counts the empty line after a final LF, as content-IR ranges do, and no line in an empty file", () => {
    // The host's one line model: content-IR section ranges and the read tool's
    // line totals both count the empty segment after a final LF.
    expect(physicalLines("one\ntwo\n").length).toBe(3);
    expect(physicalLines("one\ntwo").length).toBe(2);
    expect(physicalLines("").length).toBe(0);
    expect(physicalLines("\n").length).toBe(2);
    // Positive controls: the last text line, and a range ending on the empty
    // line that follows, as a context-packet section range does, are citable.
    expect(mint({ "a.md": "one\ntwo\n" }, [{ path: "a.md", startLine: 2, endLine: 2 }])).toEqual([
      { path: "a.md", startLine: 2, endLine: 2, quote: "two" },
    ]);
    expect(
      mint({ "a.md": "one\ntwo\n" }, [{ path: "a.md", startLine: 1, endLine: 3 }])[0]!.quote,
    ).toBe("one\ntwo\n");
    // The empty line alone is no evidence.
    expect(
      refusal(() => mint({ "a.md": "one\ntwo\n" }, [{ path: "a.md", startLine: 3, endLine: 3 }]))
        .code,
    ).toBe("source-citation-blank-span");
    // Adjacent: one line past it is not, nor past a file without a final LF,
    // and an empty file has no line 1.
    for (const [file, line] of [
      ["one\ntwo\n", 4],
      ["one\ntwo", 3],
      ["", 1],
    ] as const)
      expect(
        refusal(() => mint({ "a.md": file }, [{ path: "a.md", startLine: line, endLine: line }]))
          .rejection,
      ).toEqual({ code: "source-citation-line-range", location: "$.evidence[]" });
  });

  it("decodes only an exact path and line-range locator", () => {
    expect(
      decodeSourceCitationLocator({ path: "docs/a.md", startLine: 2, endLine: 4 }, AT),
    ).toEqual({ path: "docs/a.md", startLine: 2, endLine: 4 });
    expect(
      decodeSourceCitationLocator({ path: "docs/a.md", startLine: 4, endLine: 4 }, AT),
    ).toEqual({ path: "docs/a.md", startLine: 4, endLine: 4 });
    for (const value of [
      { path: "docs/a.md", startLine: 0, endLine: 1 },
      { path: "docs/a.md", startLine: 4, endLine: 3 },
      { path: "docs/a.md", startLine: 1, endLine: 2.5 },
      { path: "docs/a.md", startLine: 1 },
      { path: "docs/a.md", startLine: 1, endLine: 1, quote: "text" },
      { path: "docs/./a.md", startLine: 1, endLine: 1 },
      { path: "/abs/a.md", startLine: 1, endLine: 1 },
      { path: "a\u0000.md", startLine: 1, endLine: 1 },
      "docs/a.md:1-2",
      null,
    ])
      expect(
        refusal(() => decodeSourceCitationLocator(value, AT)).rejection,
        JSON.stringify(value),
      ).toEqual({ code: "source-citation-locator-shape", location: "$.evidence[]" });
  });

  it("refuses untracked, unreadable and blank citations with their rules", () => {
    const cases = [
      [{ "a.md": "untracked" }, "source-citation-untracked-path"],
      [{ "b.md": "x\n" }, "source-citation-untracked-path"],
      [{ "a.md": "unreadable" }, "source-citation-unreadable-text"],
      [{ "a.md": Buffer.from([0xc3, 0x28]) }, "source-citation-unreadable-text"],
      // A NUL byte is binary, and no admitted artifact carries one.
      [{ "a.md": "text\nx\u0000y text\nmore\n" }, "source-citation-unreadable-text"],
      // Content-IR breaks lines at a lone CR and the read tool does not, so
      // the file has no one numbering to cite.
      [{ "a.md": "text\nlone\rcarriage\nmore\n" }, "source-citation-unreadable-text"],
      [{ "a.md": "text\n   \n\t\nmore\n" }, "source-citation-blank-span"],
    ] as const;
    for (const [files, code] of cases)
      expect(
        refusal(() => mint(files, [{ path: "a.md", startLine: 2, endLine: 3 }])).code,
        code,
      ).toBe(code);
    // Positive control for the blank rule: a span with any text is admitted.
    expect(
      mint({ "a.md": "text\n   \nx\n" }, [{ path: "a.md", startLine: 2, endLine: 3 }])[0]!.quote,
    ).toBe("   \nx");
  });

  it("cites only lines a read showed, and nothing without a ledger", () => {
    const file = "1\n2\n3\n4\n5\n";
    const cite = (
      observed: ObservedSourceLinesV1 | undefined,
      startLine: number,
      endLine: number,
    ) =>
      mintSourceCitations(
        [{ path: "a.md", startLine, endLine }],
        new Map([["a.md", Buffer.from(file)]]),
        observed,
        AT,
      );
    expect(cite({ "a.md": [[2, 3]] }, 2, 3)[0]!.quote).toBe("2\n3");
    // Two adjacent shown ranges cover a span across their seam.
    const ledger = new Map<string, [number, number][]>();
    addObservedLines(ledger, "a.md", 3, 4);
    addObservedLines(ledger, "a.md", 1, 2);
    expect(ledger.get("a.md")).toEqual([[1, 4]]);
    expect(cite({ "a.md": ledger.get("a.md")! }, 2, 3)[0]!.quote).toBe("2\n3");
    for (const observed of [
      { "a.md": [[2, 2]] as const },
      {
        "a.md": [
          [1, 1],
          [3, 5],
        ] as const,
      },
      { "b.md": [[1, 5]] as const },
      {},
      undefined,
    ])
      expect(refusal(() => cite(observed as never, 2, 3)).code, JSON.stringify(observed)).toBe(
        "source-citation-unobserved",
      );
  });

  it("bounds the minted total by sourceCitation.mintedMaxChars and names the observation", () => {
    const bound = limit("sourceCitation.mintedMaxChars").value;
    const at = mint({ "a.md": `${"x".repeat(bound)}\n` }, [
      { path: "a.md", startLine: 1, endLine: 1 },
    ]);
    expect(at[0]!.quote.length).toBe(bound);
    // Two citations together over the bound, each under it.
    const half = `${"y".repeat(Math.ceil((bound + 1) / 2))}\n`;
    const over = refusal(() =>
      mint({ "a.md": half }, [
        { path: "a.md", startLine: 1, endLine: 1 },
        { path: "a.md", startLine: 1, endLine: 1 },
      ]),
    );
    expect(over.rejection).toEqual({
      code: "source-citation-minted-max-chars-bound",
      location: "$.evidence",
    });
    expect(over.message).toContain(
      `source-citation-minted-max-chars-bound: ${2 * Math.ceil((bound + 1) / 2)} exceeds sourceCitation.mintedMaxChars = ${bound} characters.`,
    );
    expect(over.message).toContain("Scope: the cited lines of one admitted artifact.");
    // Exactly one character over the bound.
    const edge = refusal(() =>
      mint({ "a.md": `${"x".repeat(bound)}\ny\n` }, [
        { path: "a.md", startLine: 1, endLine: 1 },
        { path: "a.md", startLine: 2, endLine: 2 },
      ]),
    );
    expect(edge.message).toContain(
      `source-citation-minted-max-chars-bound: ${bound + 1} exceeds sourceCitation.mintedMaxChars = ${bound} characters.`,
    );
  });

  it("re-verifies an admitted quote against the cited bytes", () => {
    const citation = { path: "a.md", startLine: 2, endLine: 2, quote: "two" };
    expect(mintedSourceCitationHolds(citation, Buffer.from("one\ntwo\n"))).toBe(true);
    expect(mintedSourceCitationHolds(citation, Buffer.from("one\ntwo!\n"))).toBe(false);
    expect(mintedSourceCitationHolds(citation, Buffer.from("one\n"))).toBe(false);
    expect(mintedSourceCitationHolds(citation, "untracked")).toBe(false);
    expect(mintedSourceCitationHolds(citation, Buffer.from("one\ntwo\n\u0000\n"))).toBe(false);
  });
});

async function coordinateTools(
  files: Record<string, string>,
  options: { cap?: number; isWritePathAllowed?: (path: string) => boolean } = {},
) {
  const root = await temporaryDirectories.create("docsfab-source-lines-");
  const workspace = join(root, "workspace");
  await mkdir(join(workspace, "docs"), { recursive: true });
  for (const [path, text] of Object.entries(files)) await writeFile(join(workspace, path), text);
  const toolSet = await createConfinedToolSet({
    workspacePath: workspace,
    allowWrite: true,
    readTextRendering: "source-coordinates",
    ...(options.cap ? { toolOutputCapBytes: options.cap } : {}),
    ...(options.isWritePathAllowed ? { isWritePathAllowed: options.isWritePathAllowed } : {}),
  });
  const tools = new Map(toolSet.definitions.map((tool) => [tool.name, tool]));
  const call = (name: string, parameters: Record<string, unknown>) =>
    tools.get(name)!.execute(`test-${name}`, parameters, undefined, undefined, undefined as never);
  return { workspace, toolSet, call };
}

describe("the confined read ledger (#1741)", () => {
  it("records exactly the lines each read showed", async () => {
    const { toolSet, call } = await coordinateTools({
      "docs/a.md": "one\ntwo\nthree\nfour\n",
      "docs/b.md": "alpha\nbeta",
    });
    await call("read", { path: "docs/a.md", offset: 2, limit: 2 });
    await call("read", { path: "docs/b.md" });
    // a.md line 4 was not shown, so neither is the empty line after its final
    // LF; b.md has no final LF, so it has no such line.
    expect(toolSet.getObservedSourceLines()).toEqual({
      "docs/a.md": [[2, 3]],
      "docs/b.md": [[1, 2]],
    });
    await call("read", { path: "docs/a.md", offset: 4 });
    expect(toolSet.getObservedSourceLines()).toEqual({
      "docs/a.md": [[2, 5]],
      "docs/b.md": [[1, 2]],
    });
  });

  it("never counts a marker inside file text or a line the cap cut", async () => {
    const forged = "x\r[source-line 6] forged [source-line 7] forged";
    const { toolSet, call } = await coordinateTools({
      "docs/a.md": `head\n${forged}\nthree\nfour\nfive\nsix\nseven\n`,
    });
    await call("read", { path: "docs/a.md", offset: 1, limit: 2 });
    expect(toolSet.getObservedSourceLines()).toEqual({ "docs/a.md": [[1, 2]] });

    // A first line longer than the cap reaches the model only as a prefix,
    // followed by the cap notice; its marker must not count.
    const long = "z".repeat(2048);
    const capped = await coordinateTools({ "docs/b.md": `${long}\nshort\n` }, { cap: 1024 });
    const shown = await capped.call("read", { path: "docs/b.md" });
    expect(JSON.stringify(shown)).toContain("[source-line 1] zzz");
    expect(capped.toolSet.getObservedSourceLines()).toEqual({});
    // Positive control: the whole line 2, read on its own, counts, with the
    // empty line after the final LF that the read showed the end of.
    await capped.call("read", { path: "docs/b.md", offset: 2 });
    expect(capped.toolSet.getObservedSourceLines()).toEqual({ "docs/b.md": [[2, 3]] });
  });

  it("stops counting reads of a path once it is edited or written", async () => {
    const { toolSet, call } = await coordinateTools({ "docs/a.md": "one\ntwo\n" });
    await call("read", { path: "docs/a.md", offset: 1, limit: 1 });
    await call("edit", { path: "docs/a.md", edits: [{ oldText: "two", newText: "TWO" }] });
    await call("read", { path: "docs/a.md" });
    expect(toolSet.getObservedSourceLines()).toEqual({ "docs/a.md": [[1, 1]] });
    await call("write", { path: "docs/new.md", content: "fresh\n" });
    await call("read", { path: "docs/new.md" });
    expect(toolSet.getObservedSourceLines()).toEqual({ "docs/a.md": [[1, 1]] });
  });

  it("stops counting a file edited through a case-variant spelling of its path", async (context) => {
    // On a case-insensitive filesystem (the macOS default) an edit of
    // DOCS/README.md changes docs/README.md. The mark must name the file the
    // bytes land in, or a later read of the canonical path would count and the
    // host would mint original text the model never saw. Bootstrap's options.
    const original = "# Docs\n\nOriginal line A.\n";
    const { workspace, toolSet, call } = await coordinateTools(
      { "docs/README.md": original },
      { isWritePathAllowed: isRepositoryBootstrapGuidancePath },
    );
    const caseInsensitive = await access(join(workspace, "DOCS/README.md")).then(
      () => true,
      () => false,
    );
    if (!caseInsensitive) context.skip("needs a case-insensitive filesystem");
    await call("edit", {
      path: "DOCS/README.md",
      edits: [{ oldText: "Original line A.", newText: "Edited line B." }],
    });
    expect(await readFile(join(workspace, "docs/README.md"), "utf8")).toContain("Edited line B.");
    await call("read", { path: "docs/README.md" });
    expect(toolSet.getObservedSourceLines()).toEqual({});
    expect(
      refusal(() =>
        mintSourceCitations(
          [{ path: "docs/README.md", startLine: 3, endLine: 3 }],
          new Map([["docs/README.md", Buffer.from(original)]]),
          toolSet.getObservedSourceLines(),
          AT,
        ),
      ).code,
    ).toBe("source-citation-unobserved");
  });

  it("stops counting a new file written under a case-variant spelling of its directory", async (context) => {
    // The file does not exist yet, so it has no device and inode to mark; the
    // path mark must be canonical, from the realpath of its existing ancestor.
    const { workspace, toolSet, call } = await coordinateTools({ "docs/a.md": "one\n" });
    const caseInsensitive = await access(join(workspace, "DOCS/a.md")).then(
      () => true,
      () => false,
    );
    if (!caseInsensitive) context.skip("needs a case-insensitive filesystem");
    await call("write", { path: "DOCS/sub/new.md", content: "fresh\n" });
    expect(await readFile(join(workspace, "docs/sub/new.md"), "utf8")).toBe("fresh\n");
    await call("read", { path: "docs/sub/new.md" });
    expect(toolSet.getObservedSourceLines()).toEqual({});
  });

  it("refuses an edit of a hard-linked file under either name and keeps counting it", async () => {
    // The same file under a second name: the confinement refuses a write to a
    // file with another hard link, so neither name changes it or marks it.
    const { workspace, toolSet, call } = await coordinateTools({ "docs/a.md": "one\ntwo\n" });
    await link(join(workspace, "docs/a.md"), join(workspace, "docs/alias.md"));
    for (const path of ["docs/alias.md", "docs/a.md"]) {
      await expect(
        call("edit", { path, edits: [{ oldText: "two", newText: "TWO" }] }),
      ).rejects.toThrow("DocsFab denied the requested tool path.");
    }
    expect(await readFile(join(workspace, "docs/a.md"), "utf8")).toBe("one\ntwo\n");
    await call("read", { path: "docs/a.md" });
    expect(toolSet.getObservedSourceLines()).toEqual({ "docs/a.md": [[1, 3]] });
  });

  it("refuses an edit through a symlinked alias and keeps counting the unchanged file", async () => {
    const { workspace, toolSet, call } = await coordinateTools({ "docs/a.md": "one\ntwo\n" });
    await symlink("a.md", join(workspace, "docs/link.md"));
    await symlink("docs", join(workspace, "alias"));
    await expect(
      call("edit", { path: "docs/link.md", edits: [{ oldText: "two", newText: "TWO" }] }),
    ).rejects.toThrow();
    await expect(
      call("edit", { path: "alias/a.md", edits: [{ oldText: "two", newText: "TWO" }] }),
    ).rejects.toThrow();
    expect(await readFile(join(workspace, "docs/a.md"), "utf8")).toBe("one\ntwo\n");
    // Positive control: a refused edit changed nothing, so it marks nothing.
    await call("read", { path: "docs/a.md" });
    expect(toolSet.getObservedSourceLines()).toEqual({ "docs/a.md": [[1, 3]] });
  });

  it("keys reads and marks on the path Pi opens for every spelling the confinement accepts", async () => {
    // The session advertises a virtual working directory, and Pi strips a
    // leading "@"; both spellings open the canonical file.
    const { toolSet, call } = await coordinateTools({
      "docs/a.md": "one\ntwo\n",
      "docs/b.md": "alpha\n",
    });
    await call("read", { path: `${VIRTUAL_WORKSPACE_CWD}/docs/a.md`, offset: 1, limit: 1 });
    await call("read", { path: "@docs/a.md", offset: 2, limit: 1 });
    await call("read", { path: "./docs/b.md" });
    expect(toolSet.getObservedSourceLines()).toEqual({
      "docs/a.md": [[1, 3]],
      "docs/b.md": [[1, 2]],
    });
    await call("edit", {
      path: `${VIRTUAL_WORKSPACE_CWD}/docs/b.md`,
      edits: [{ oldText: "alpha", newText: "beta" }],
    });
    await call("read", { path: "docs/b.md" });
    await call("read", { path: `${VIRTUAL_WORKSPACE_CWD}/docs/b.md` });
    expect(toolSet.getObservedSourceLines()).toEqual({
      "docs/a.md": [[1, 3]],
      "docs/b.md": [[1, 2]],
    });
  });

  it("never counts a read through an alias, before or after an edit", async () => {
    // A citation names the canonical path, so a read under another name is
    // not a read of the cited path.
    const { workspace, toolSet, call } = await coordinateTools({ "docs/a.md": "one\ntwo\n" });
    await symlink("a.md", join(workspace, "docs/link.md"));
    await symlink("docs", join(workspace, "alias"));
    await call("read", { path: "docs/link.md" });
    await call("read", { path: "alias/a.md" });
    expect(toolSet.getObservedSourceLines()).toEqual({});
    await call("edit", { path: "docs/a.md", edits: [{ oldText: "two", newText: "TWO" }] });
    await call("read", { path: "docs/link.md" });
    await call("read", { path: "alias/a.md" });
    await call("read", { path: "docs/a.md" });
    expect(toolSet.getObservedSourceLines()).toEqual({});
  });

  it("records nothing for a file the credential screen refuses", async () => {
    configureCredential(CREDENTIAL.slice("api_key=".length));
    const { toolSet, call } = await coordinateTools({ "docs/a.md": `intro\n${CREDENTIAL}\n` });
    await expect(call("read", { path: "docs/a.md", offset: 1, limit: 1 })).rejects.toThrow();
    expect(toolSet.getObservedSourceLines()).toEqual({});
  });

  it("keeps no ledger under raw rendering", async () => {
    const root = await temporaryDirectories.create("docsfab-source-lines-raw-");
    await writeFile(join(root, "a.md"), "one\n");
    const toolSet = await createConfinedToolSet({ workspacePath: root, allowWrite: false });
    expect(toolSet.getObservedSourceLines()).toBeUndefined();
  });
});

describe("the source-coordinate mutation guard (#1741)", () => {
  it("refuses a display-only coordinate prefix in edit or write text, passing its sentence", async () => {
    const { workspace, toolSet, call } = await coordinateTools({ "docs/a.md": "one\ntwo\n" });
    const refused: [string, Record<string, unknown>][] = [
      ["write", { path: "docs/a.md", content: "[source-line 1] one\n" }],
      ["write", { path: "docs/a.md", content: "ok\n[source-line 2] two\n" }],
      ["edit", { path: "docs/a.md", edits: [{ oldText: "two", newText: "[source-line 2] 2" }] }],
      ["edit", { path: "docs/a.md", edits: [{ oldText: "[source-line 1] one", newText: "1" }] }],
    ];
    for (const [tool, parameters] of refused)
      await expect(call(tool, parameters), JSON.stringify(parameters)).rejects.toThrow(
        "The [source-line N] prefixes in read output are display-only coordinates, not file content.",
      );
    expect(await readFile(join(workspace, "docs/a.md"), "utf8")).toBe("one\ntwo\n");
    // Not a confinement denial: no failure category and no mutation-boundary denial.
    expect(toolSet.getFailureCategories()).toEqual([]);
    expect(toolSet.getMutationBoundaryDenials()).toBe(0);
    // A refused write changed nothing, so earlier reads of the path still count.
    await call("read", { path: "docs/a.md" });
    expect(toolSet.getObservedSourceLines()).toEqual({ "docs/a.md": [[1, 3]] });
    // Positive control: a marker that does not start a line is ordinary text.
    await call("edit", {
      path: "docs/a.md",
      edits: [{ oldText: "two", newText: "see [source-line 2] in prose" }],
    });
    expect(await readFile(join(workspace, "docs/a.md"), "utf8")).toBe(
      "one\nsee [source-line 2] in prose\n",
    );
  });

  it("leaves raw-rendering writes unguarded", async () => {
    const root = await temporaryDirectories.create("docsfab-source-lines-raw-write-");
    const toolSet = await createConfinedToolSet({ workspacePath: root, allowWrite: true });
    const write = toolSet.definitions.find((tool) => tool.name === "write")!;
    await write.execute(
      "raw",
      { path: "a.md", content: "[source-line 1] literal\n" },
      undefined,
      undefined,
      undefined as never,
    );
    expect(await readFile(join(root, "a.md"), "utf8")).toBe("[source-line 1] literal\n");
  });
});

describe("source-coordinate rendering for the minted-citation steps (#1741)", () => {
  it("numbers read lines for source readiness and repository bootstrap only", () => {
    const step = (workflow: string, id?: string) => {
      const manifest = getWorkflow(workflow);
      const first = manifest.steps[0]!;
      return { workflow: manifest, step: id ? { ...first, id } : first };
    };
    expect(readTextRenderingForStep(step("readiness"))).toBe("source-coordinates");
    expect(readTextRenderingForStep(step("bootstrap"))).toBe("source-coordinates");
    // Adjacent: the release step shares the readiness skill but mints nothing,
    // and another bootstrap step id is not the decoded step.
    expect(readTextRenderingForStep(step("release-documentation-readiness"))).toBe("raw");
    expect(readTextRenderingForStep(step("bootstrap", "bootstrap-guidance-notes"))).toBe("raw");
  });
});

describe("repository bootstrap admission of minted evidence (#1741)", () => {
  const reply = (path: string): RepositoryBootstrapReplyV1 => ({
    schemaVersion: 1,
    kind: REPOSITORY_BOOTSTRAP_RESULT_KIND,
    binding: {
      runId: "run-bootstrap",
      repositoryRevision: "a".repeat(40),
      contextSha256: "b".repeat(64),
    },
    decision: "no-change",
    summary: "Existing guidance covers the repository.",
    changedPaths: [],
    evidence: [{ path, startLine: 3, endLine: 3 }],
    assumptions: [],
    missingEvidence: [],
    questions: [],
  });
  const sources = new Map<string, SourceCitationSource>([
    ["README.md", Buffer.from("# Product\n\nRun the installer.\n")],
    ["AGENTS.md", Buffer.from(`# Agents\n\n${CREDENTIAL}\n`)],
  ]);
  const observed = { "README.md": [[1, 3]], "AGENTS.md": [[1, 3]] } as const;

  it("mints the cited line and screens the minted result for credential material", () => {
    configureCredential(CREDENTIAL.slice("api_key=".length));
    expect(admitRepositoryBootstrapReply(reply("README.md"), sources, observed).evidence).toEqual([
      { path: "README.md", startLine: 3, endLine: 3, quote: "Run the installer." },
    ]);
    expect(() => admitRepositoryBootstrapReply(reply("AGENTS.md"), sources, observed)).toThrowError(
      expect.objectContaining({
        name: "RepositoryBootstrapResultError",
        code: "repository-bootstrap-credential-material",
      }),
    );
  });
});

describe("one host line model across the context packet and the read tool (#1741)", () => {
  it("mints every content-IR section range after a whole-file confined read", async () => {
    // Context-packet section ranges can end on the empty line after a final
    // LF. Every section range content-IR reports must stay citable from what
    // one confined read shows, with and without a final LF.
    const files = {
      "docs/guide.md": "# Guide\n\nIntro text.\n\n## Install\n\nRun the installer.\n",
      "docs/plain.md": "# Plain\n\nNo final line break.",
      "docs/windows.md": "# Windows\r\n\r\nCRLF line breaks.\r\n",
    };
    const { workspace, toolSet, call } = await coordinateTools(files);
    for (const path of Object.keys(files)) await call("read", { path });
    const index = await buildContentIndex({
      repositoryPath: workspace,
      repositoryRevision: "c".repeat(40),
    });
    const sections = index.nodes
      .filter((node) => node.kind === "section")
      .sort((left, right) =>
        `${left.sourcePath}:${left.startLine}`.localeCompare(
          `${right.sourcePath}:${right.startLine}`,
        ),
      );
    expect(sections.map((node) => [node.sourcePath, node.startLine, node.endLine])).toEqual([
      ["docs/guide.md", 1, 4],
      ["docs/guide.md", 5, 8],
      ["docs/plain.md", 1, 3],
      ["docs/windows.md", 1, 4],
    ]);
    const sources = new Map<string, SourceCitationSource>(
      Object.entries(files).map(([path, text]) => [path, Buffer.from(text)]),
    );
    for (const node of sections) {
      const [minted] = mintSourceCitations(
        [{ path: node.sourcePath, startLine: node.startLine, endLine: node.endLine }],
        sources,
        toolSet.getObservedSourceLines(),
        AT,
      );
      expect(files[node.sourcePath as keyof typeof files]).toContain(minted!.quote);
    }
  });

  it("refuses a lone-CR file, whose content-IR sections the read tool numbers differently", async () => {
    const file = "# Old Mac\r\rLone CR line breaks.\r";
    const { workspace, toolSet, call } = await coordinateTools({ "docs/lonecr.md": file });
    await call("read", { path: "docs/lonecr.md" });
    const index = await buildContentIndex({
      repositoryPath: workspace,
      repositoryRevision: "c".repeat(40),
    });
    const [section] = index.nodes.filter((node) => node.kind === "section");
    expect([section!.startLine, section!.endLine]).toEqual([1, 4]);
    expect(
      refusal(() =>
        mintSourceCitations(
          [{ path: "docs/lonecr.md", startLine: 1, endLine: 1 }],
          new Map([["docs/lonecr.md", Buffer.from(file)]]),
          toolSet.getObservedSourceLines(),
          AT,
        ),
      ).code,
    ).toBe("source-citation-unreadable-text");
  });
});
