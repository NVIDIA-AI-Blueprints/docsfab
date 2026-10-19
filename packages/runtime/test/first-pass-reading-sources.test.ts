// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The sources an admitted request reading names, as a gathering first pass
 * binds them (#2112): a tracked file binds, a tracked directory binds its
 * tracked regular files whole or not at all within `firstPass.maxSourceFiles`,
 * and every other path becomes one coded notice. The reader here refuses to
 * read bytes, so every row also proves that deciding reads none.
 */
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  bindReadingSources,
  boundDirectoryStatus,
  hostStateAncestor,
  isBindableSourcePath,
  READING_SOURCE_NOTICE_CODE,
  type BoundReadingSources,
} from "../src/cli/first-pass-reading-sources.js";
import { formatLimitObservation, limit } from "../src/config/limits.js";
import type { TrackedSourceReaderV1 } from "../src/inputs/source-acquisition.js";
import { EXPORT_EXCLUSION_DESCRIPTION } from "../src/repository/workspace/export-exclusion.js";
import { isRecordableEvidenceWarning } from "../src/records/evidence-warnings.js";
import type { RequestIntentPathQuote } from "../src/request-intent/contract.js";

const knowledgeSource = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "knowledge");
const knowledgeParse = (await import(
  pathToFileURL(resolve(knowledgeSource, "src", "first-pass", "parse.mjs")).href
)) as {
  normalizeBoundSourcePaths: (
    value: readonly string[] | undefined,
    maxSelections: number,
    readingPaths: readonly string[],
  ) => readonly string[];
};
const knowledgeScan = (await import(
  pathToFileURL(resolve(knowledgeSource, "src", "first-pass", "scan.mjs")).href
)) as { hostStateAncestor: (path: string) => string | undefined };

afterEach(() => {
  vi.unstubAllEnvs();
});

/** A reader over `tracked` that lists them and refuses to read any byte. */
function reader(
  tracked: readonly string[],
  options: { readonly listing?: boolean } = {},
): TrackedSourceReaderV1 & { readonly asked: string[] } {
  const set = new Set(tracked);
  const asked: string[] = [];
  return {
    asked,
    isTrackedRegularFile: async (path: string) => {
      asked.push(path);
      return set.has(path);
    },
    ...(options.listing === false ? {} : { listTrackedRegularFiles: async () => [...tracked] }),
    readTrackedBytes: async () => {
      throw new Error("binding the reading's sources never reads a byte");
    },
  };
}

let quoteStart = 0;
/** A reading source; each quote gets its own offsets so rows cannot mix them up. */
function source(path: string, text = `the ${path} source`): RequestIntentPathQuote {
  const start = quoteStart;
  quoteStart += text.length + 1;
  return { path, quote: { text, start, end: start + text.length } };
}

async function bind(
  tracked: readonly string[],
  sources: readonly RequestIntentPathQuote[],
  extra: {
    readonly selected?: readonly string[];
    readonly writeTargets?: readonly string[];
    readonly listing?: boolean;
  } = {},
): Promise<BoundReadingSources> {
  const trackedReader = reader(tracked, extra);
  return bindReadingSources({
    reader: trackedReader,
    trackedFiles: extra.listing === false ? undefined : tracked,
    sources,
    selected: extra.selected ?? [],
    writeTargets: extra.writeTargets ?? [],
    sourceBudget: limit("firstPass.maxSourceFiles"),
  });
}

const reasonOf = (bound: BoundReadingSources) =>
  bound.notices.map(({ path, reason }) => ({ path, reason }));

const line = (path: string, reason: string, sentence: string) =>
  `${READING_SOURCE_NOTICE_CODE}: ${JSON.stringify(path)} (${reason}): ${sentence}`;

const WENT_ON = "and went on with the evidence it could bind";

/** A tracked name in decomposed form, as a macOS checkout can commit it; built here so no editor can recompose it. */
const NFD_PATH = `upstream/${"caf\u00e9".normalize("NFD")}.md`;

describe("binding the sources an admitted reading names", () => {
  it("binds a tracked file and every tracked file of a named directory, once each, with the quote that named it", async () => {
    const tracked = [
      "README.md",
      "pages/[id].md",
      "keps/2724-topology-aware-scheduling/README.md",
      "keps/2724-topology-aware-scheduling/kep.yaml",
      // A sibling KEP the reading does not name, and a prefix-only lookalike.
      "keps/2724-topology-aware-scheduling-v2/README.md",
      "keps/3001-other/README.md",
    ];
    const folder = source("keps/2724-topology-aware-scheduling", "the topology KEP folder");
    const kep = source("keps/2724-topology-aware-scheduling/kep.yaml", "its kep.yaml");
    const readme = source("README.md", "the README");
    // Brackets are a literal file name here, not a pattern.
    const page = source("pages/[id].md", "the id page");
    const bound = await bind(tracked, [folder, kep, readme, page]);
    expect(bound.notices).toEqual([]);
    expect(bound.sources).toEqual([
      { path: "keps/2724-topology-aware-scheduling/README.md", quote: folder.quote },
      { path: "keps/2724-topology-aware-scheduling/kep.yaml", quote: folder.quote },
      readme,
      page,
    ]);
    expect(bound.directories).toEqual([{ path: "keps/2724-topology-aware-scheduling", files: 2 }]);
    expect(boundDirectoryStatus(bound.directories[0]!)).toBe(
      'first pass binds the 2 tracked files under "keps/2724-topology-aware-scheduling", which the request\'s reading names as a source',
    );
  });

  it("gives every path it does not bind one coded notice naming the path and the reason", async () => {
    const tracked = ["src/a.ts", ".docsfab/notes.md", ".docsfab/reference-model/x.json"];
    const bound = await bind(tracked, [
      source("upstream"),
      source("src/missing.ts"),
      source("pages/[slug].md"),
      source("src/*.ts"),
      source(".env"),
      source("node_modules/left-pad"),
      source(".docsfab/notes.md"),
      source(".docsfab"),
    ]);
    expect(bound.sources).toEqual([]);
    expect(reasonOf(bound)).toEqual([
      { path: "upstream", reason: "not-tracked" },
      { path: "src/missing.ts", reason: "not-tracked" },
      { path: "pages/[slug].md", reason: "not-tracked" },
      { path: "src/*.ts", reason: "glob" },
      { path: ".env", reason: "export-excluded" },
      { path: "node_modules/left-pad", reason: "export-excluded" },
      { path: ".docsfab/notes.md", reason: "host-state" },
      { path: ".docsfab", reason: "host-state" },
    ]);
    const notTracked = `the request's reading names it as a source, but the selected revision tracks no regular file at that path or under it, so first pass did not read it ${WENT_ON}. To use it as evidence, check the path or commit it, then run again, or pass a tracked file with --source.`;
    const hostState = `the request's reading names it as a source, but it is host state in .docsfab/, which first pass never reads, so first pass did not read it ${WENT_ON}. Name a tracked product file outside that directory.`;
    expect(bound.notices.map((notice) => notice.line)).toEqual([
      line("upstream", "not-tracked", notTracked),
      line("src/missing.ts", "not-tracked", notTracked),
      line("pages/[slug].md", "not-tracked", notTracked),
      line(
        "src/*.ts",
        "glob",
        `the request's reading names it as a source, but it is a pattern, and first pass binds a source only by its exact path, so it read nothing for it ${WENT_ON}. Name the files, or the directory that holds them, in the request, or pass the files with --source.`,
      ),
      line(
        ".env",
        "export-excluded",
        `the request's reading names it as a source, but the source export never materializes ${EXPORT_EXCLUSION_DESCRIPTION}, so first pass did not read it ${WENT_ON}. Bind a different file that carries the evidence.`,
      ),
      line(
        "node_modules/left-pad",
        "export-excluded",
        `the request's reading names it as a source, but the source export never materializes ${EXPORT_EXCLUSION_DESCRIPTION}, so first pass did not read it ${WENT_ON}. Bind a different file that carries the evidence.`,
      ),
      line(".docsfab/notes.md", "host-state", hostState),
      line(".docsfab", "host-state", hostState),
    ]);
    for (const notice of bound.notices) expect(isRecordableEvidenceWarning(notice.line)).toBe(true);
  });

  it("binds a directory whole at the source budget and none of it one file over, naming the limit and the observed count", async () => {
    // One source taken by --source, so a two-file directory fills a budget of three.
    vi.stubEnv("DOCSFAB_FIRST_PASS_MAX_SOURCE_FILES", "3");
    const budget = limit("firstPass.maxSourceFiles");
    expect(budget.value).toBe(3);
    const twoFiles = ["upstream/pkg/a.go", "upstream/pkg/b.go"];
    const atLimit = await bind(["src/a.ts", ...twoFiles], [source("upstream")], {
      selected: ["src/a.ts"],
    });
    expect(atLimit.notices).toEqual([]);
    expect(atLimit.sources.map((entry) => entry.path)).toEqual(twoFiles);

    const threeFiles = [...twoFiles, "upstream/pkg/c.go"];
    const over = await bind(["src/a.ts", ...threeFiles], [source("upstream")], {
      selected: ["src/a.ts"],
    });
    expect(over.sources).toEqual([]);
    expect(over.directories).toEqual([]);
    expect(over.notices.map((notice) => notice.line)).toEqual([
      line(
        "upstream",
        "over-budget",
        `the request's reading names this directory as a source, but binding its 3 tracked files would bring first pass to 4 sources, so first pass bound none of them ${WENT_ON}. ${formatLimitObservation(budget, 4)}`,
      ),
    ]);
    expect(over.notices[0]!.line).toContain("DOCSFAB_FIRST_PASS_MAX_SOURCE_FILES");

    // A file past a full budget is noticed too, at the budget plus one.
    const file = await bind(
      ["src/a.ts", ...twoFiles, "docs/extra.md"],
      [source("upstream"), source("docs/extra.md")],
      { selected: ["src/a.ts"] },
    );
    expect(file.sources.map((entry) => entry.path)).toEqual(twoFiles);
    expect(file.notices.map((notice) => notice.line)).toEqual([
      line(
        "docs/extra.md",
        "over-budget",
        `the request's reading names it as a source, but binding it would bring first pass to 4 sources, so first pass did not bind it ${WENT_ON}. ${formatLimitObservation(budget, 4)}`,
      ),
    ]);
  });

  it("counts neither --source selections nor write targets again when a named directory holds them", async () => {
    vi.stubEnv("DOCSFAB_FIRST_PASS_MAX_SOURCE_FILES", "2");
    const tracked = ["docs/guide.md", "docs/new.md", "docs/other.md"];
    const bound = await bind(tracked, [source("docs")], {
      selected: ["docs/guide.md"],
      writeTargets: ["docs/new.md"],
    });
    // One selection plus the one file left fills the budget of two exactly.
    expect(bound.notices).toEqual([]);
    expect(bound.sources.map((entry) => entry.path)).toEqual(["docs/other.md"]);
    expect(bound.directories).toEqual([{ path: "docs", files: 1 }]);
  });

  it("leaves out the files of a named directory that first pass never binds, and says how many and why", async () => {
    const tracked = [
      "upstream/ok.go",
      "upstream/.docsfab/state.json",
      "upstream/weird\\name.go",
      NFD_PATH,
    ];
    expect(NFD_PATH).not.toBe(NFD_PATH.normalize("NFC"));
    const bound = await bind(tracked, [source("upstream")]);
    expect(bound.sources.map((entry) => entry.path)).toEqual(["upstream/ok.go"]);
    expect(bound.notices.map((notice) => notice.line)).toEqual([
      line(
        "upstream",
        "files-left-out",
        "the request's reading names this directory as a source, and first pass bound 1 of its tracked files. It left out 3 of its tracked files, which first pass never binds as sources: 1 in host state under .docsfab/ or .git/, and 2 whose path is not in Unicode NFC form or holds a backslash or drive prefix. It went on with the evidence it could bind.",
      ),
    ]);
  });

  it("gives a tracked file the provider cannot bind an unsafe-path notice instead of binding it", async () => {
    const bound = await bind(
      ["C:notes.md", "README.md"],
      [source("C:notes.md"), source("README.md")],
    );
    expect(bound.sources.map((entry) => entry.path)).toEqual(["README.md"]);
    expect(bound.notices.map((notice) => notice.line)).toEqual([
      line(
        "C:notes.md",
        "unsafe-path",
        `the request's reading names it as a source, but first pass binds only a path in Unicode NFC form with no backslash or drive prefix, so it did not bind it ${WENT_ON}. Rename the file, or name another file that carries the evidence.`,
      ),
    ]);
  });

  it("names a path too long for the run record by its SHA-256 and keeps the line within the record's bound", async () => {
    const long = `upstream/${"segment/".repeat(140)}file.go`;
    const bound = await bind([], [source(long)]);
    const notice = bound.notices[0]!;
    expect(notice).toMatchObject({ path: long, reason: "not-tracked" });
    expect(isRecordableEvidenceWarning(line(long, "not-tracked", "x"))).toBe(false);
    expect(isRecordableEvidenceWarning(notice.line)).toBe(true);
    expect(notice.line).toBe(
      `${READING_SOURCE_NOTICE_CODE}: a path too long to show here, with path SHA-256 ${createHash("sha256").update(long, "utf8").digest("hex")} (not-tracked): the request's reading names it as a source, but the selected revision tracks no regular file at that path or under it, so first pass did not read it ${WENT_ON}. To use it as evidence, check the path or commit it, then run again, or pass a tracked file with --source.`,
    );
  });

  it("binds only files without a tracked-file listing, and says a directory is not a tracked file", async () => {
    const tracked = ["upstream/a.go", "README.md"];
    const bound = await bind(tracked, [source("upstream"), source("README.md")], {
      listing: false,
    });
    expect(bound.sources.map((entry) => entry.path)).toEqual(["README.md"]);
    expect(bound.notices.map((notice) => notice.line)).toEqual([
      line(
        "upstream",
        "not-tracked",
        `the request's reading names it as a source, but it is not a tracked regular file at the selected revision, so first pass did not read it ${WENT_ON}. To use it as evidence, check the path or commit it, then run again, or pass a tracked file with --source.`,
      ),
    ]);
  });

  it("passes a reader failure through unchanged", async () => {
    const failure = new Error("tracked-set listing failed: git exited 128");
    await expect(
      bindReadingSources({
        reader: {
          isTrackedRegularFile: async () => {
            throw failure;
          },
          readTrackedBytes: async () => {
            throw new Error("never read");
          },
        },
        trackedFiles: [],
        sources: [source("upstream")],
        selected: [],
        writeTargets: [],
        sourceBudget: limit("firstPass.maxSourceFiles"),
      }),
    ).rejects.toBe(failure);
  });

  it("agrees with the knowledge provider on host state and on every path it binds", () => {
    const paths = [
      "src/a.ts",
      "docs/open-api/indexes.yaml",
      "vendor/lib/util.js",
      ".github/workflows/ci.yml",
      ".docsfab/notes.md",
      "pkg/.DocsFab/state.json",
      ".git/config",
      "upstream/.git/HEAD",
      ".docsfab",
      "upstream/weird\\name.go",
      NFD_PATH,
      "C:notes.md",
      "/etc/passwd",
      "a//b.md",
      "a/./b.md",
      "a/../b.md",
      "trailing/",
      "nul\0byte.md",
    ];
    for (const path of paths) {
      expect(hostStateAncestor(path), path).toBe(knowledgeScan.hostStateAncestor(path));
      let accepted = true;
      try {
        knowledgeParse.normalizeBoundSourcePaths([], 64, [path]);
      } catch {
        accepted = false;
      }
      expect(isBindableSourcePath(path) && hostStateAncestor(path) === undefined, path).toBe(
        accepted,
      );
    }
  });
});
