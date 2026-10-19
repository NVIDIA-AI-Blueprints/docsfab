// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { posix } from "node:path";

import { canonicalJson, deepFreeze } from "../contract-kit/index.js";
import {
  parseSphinxConfLiterals,
  resolveSphinxTargetPath,
  scanSphinxDocument,
  sphinxDocumentCandidatePaths,
  sphinxFormatForPath,
  SphinxStructuralParseError,
  SPHINX_SUPPORTED_DIRECTIVES,
  type SphinxScanResultV1,
} from "../repository/documentation-source-sphinx.js";
import { RstRegionError } from "./contracts.js";
import { analyzeRstRegions } from "./regions.js";
import { selectRstCandidate } from "./preservation.js";

const SUPPORTED = new Set<string>(SPHINX_SUPPORTED_DIRECTIVES);
const DIRECTIVE = /^(\s*)\.\.\s+([A-Za-z][\w:.-]*)::(?:[ \t]+.*)?$/u;
const LABEL = /^\s*\.\.\s+_[^:]+:\s*$/u;
const EXPLICIT = /^(\s*)\.\.(?:\s|$)/u;
const OPTION = /^:[A-Za-z][A-Za-z0-9_-]*:(?:\s+.*)?$/u;
const CHECKED_KINDS = [
  "labels",
  "doc/ref",
  "toctree",
  "include/literalinclude",
  "directive-options",
] as const;

export type RstStaticResult = Readonly<{
  state: "passed" | "limited";
  opaqueRegions: number;
  checkedKinds: readonly string[];
}>;

export type RstStaticGraphResult = RstStaticResult & Readonly<{ limitations: readonly string[] }>;

export type RstStaticGraphInput = Readonly<{
  /** Repository-relative path of the admitted existing RST page. */
  path: string;
  /** Repository-relative Sphinx source root, such as `docs`. */
  documentationRoot: string;
  /** Candidate bytes overlay the tracked page at `path`. */
  candidate: Uint8Array;
  /** Reads only regular tracked files from the sealed workspace. */
  readTracked: (repositoryRelativePath: string) => Promise<Uint8Array | undefined>;
}>;

type MaskedRst = { source: string; opaqueRegions: number };

/** An include body can select, transform, or literalize content before RST parsing. */
function assertOptionlessInclude(
  path: string,
  source: string,
  format: "rst" | "myst",
  directiveLine: number,
): void {
  const lines = source.split(/\r?\n/u);
  const declaration = lines[directiveLine - 1] ?? "";
  const unsupported = (): never => {
    throw new SphinxStructuralParseError(
      `Sphinx include options or body are outside the bounded static graph: ${path}:${directiveLine}.`,
      "unsupported-directive",
    );
  };
  if (format === "rst") {
    const indent = declaration.length - declaration.trimStart().length;
    for (let index = directiveLine; index < lines.length; index += 1) {
      const line = lines[index]!;
      if (!line.trim()) continue;
      if (line.length - line.trimStart().length <= indent) break;
      unsupported();
    }
    return;
  }
  const marker = /^\s*([`~:]{3,})\{include\}(?:\s|$)/iu.exec(declaration)?.[1];
  if (!marker) return unsupported();
  for (let index = directiveLine; index < lines.length; index += 1) {
    const body = lines[index]!.trim();
    if (body.length >= marker.length && [...body].every((character) => character === marker[0]))
      return;
    if (body) unsupported();
  }
  throw new SphinxStructuralParseError(
    `Sphinx include fence is not closed: ${path}:${directiveLine}.`,
    "malformed-directive",
  );
}

function decode(path: string, bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new RstRegionError(
      "The tracked static source is not valid UTF-8 text.",
      "rst-edit-region-unsupported",
      path,
      { start: 0, end: bytes.length },
    );
  }
}

/** Mask only bounded unsupported explicit-markup bodies, retaining line numbers. */
function maskOpaqueRst(source: string): MaskedRst {
  const lines = source.split(/\r?\n/u);
  const masked = [...lines];
  let opaqueRegions = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const explicit = EXPLICIT.exec(line);
    if (!explicit || LABEL.test(line)) continue;
    const directive = DIRECTIVE.exec(line);
    if (directive && SUPPORTED.has(directive[2]!.toLowerCase())) continue;
    const indent = explicit[1]!.length;
    let end = index + 1;
    while (end < lines.length) {
      const next = lines[end]!;
      if (next.trim() === "") {
        end += 1;
        continue;
      }
      const nextIndent = next.length - next.trimStart().length;
      if (nextIndent <= indent) break;
      end += 1;
    }
    for (let cursor = index; cursor < end; cursor += 1) masked[cursor] = "";
    opaqueRegions += 1;
    index = end - 1;
  }
  return { source: masked.join("\n"), opaqueRegions };
}

type SupportedShape = Readonly<{
  labels: readonly string[];
  references: readonly string[];
  directives: readonly string[];
  options: readonly string[];
}>;

function supportedShape(source: string): {
  shape: SupportedShape;
  opaqueRegions: number;
  scan: SphinxScanResultV1;
} {
  const masked = maskOpaqueRst(source);
  const scan = scanSphinxDocument(masked.source, "rst");
  const lines = masked.source.split("\n");
  const options: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.replace(/\r$/u, "");
    const directive = DIRECTIVE.exec(line);
    if (!directive || !SUPPORTED.has(directive[2]!.toLowerCase())) continue;
    const indent = directive[1]!.length;
    const found: string[] = [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const body = lines[cursor]!.replace(/\r$/u, "");
      if (!body.trim()) break;
      const bodyIndent = body.length - body.trimStart().length;
      if (bodyIndent <= indent) break;
      const trimmed = body.trim();
      if (!trimmed.startsWith(":")) break;
      if (!OPTION.test(trimmed))
        throw new SphinxStructuralParseError(
          `Malformed Sphinx directive option at line ${cursor + 1}.`,
          "malformed-directive",
        );
      found.push(trimmed);
    }
    options.push(`${directive[2]!.toLowerCase()} ${directive[3] ?? ""}: ${found.join("|")}`);
  }
  return {
    shape: {
      labels: scan.labels.map((item) => item.label),
      references: scan.references.map((item) => `${item.role}:${item.target}`),
      directives: scan.directives.map((item) => `${item.kind}:${item.targets.join("|")}`),
      options,
    },
    opaqueRegions: masked.opaqueRegions,
    scan,
  };
}

/** Compare the supported RST structure around one byte-proven ordinary-prose edit. */
export function compareRstStaticStructure(
  path: string,
  original: Uint8Array,
  candidate: Uint8Array,
): RstStaticResult {
  const before = decode(path, original);
  const after = decode(path, candidate);
  const baseline = supportedShape(before);
  const next = supportedShape(after);
  if (
    canonicalJson(baseline.shape) !== canonicalJson(next.shape) ||
    baseline.opaqueRegions !== next.opaqueRegions
  ) {
    throw new RstRegionError(
      "The supported Sphinx structure changed outside the selected ordinary prose.",
      "rst-preservation-mismatch",
      path,
      { start: 0, end: original.length },
    );
  }
  if (before !== after) selectRstCandidate(analyzeRstRegions(path, original), original, candidate);
  return deepFreeze({
    state: next.opaqueRegions > 0 ? "limited" : "passed",
    opaqueRegions: next.opaqueRegions,
    checkedKinds: [...CHECKED_KINDS],
  });
}

function normalizedRoot(root: string): string {
  const value = root === "" || root === "." ? "" : posix.normalize(root);
  if (value === ".." || value.startsWith("../") || value.startsWith("/") || value.includes("\\")) {
    throw new SphinxStructuralParseError(
      `The selected Sphinx documentation root escapes the repository: ${root}.`,
      "path-escape",
    );
  }
  return value;
}

function withinDocumentationRoot(path: string, root: string): boolean {
  return (
    path === posix.normalize(path) &&
    !path.includes("\\") &&
    path !== ".." &&
    !path.startsWith("../") &&
    !path.startsWith("/") &&
    (root === "" || path.startsWith(`${root}/`))
  );
}

/** Resolve supported edges over the tracked source graph without executing conf.py. */
export async function validateRstStaticGraph(
  input: RstStaticGraphInput,
): Promise<RstStaticGraphResult> {
  const root = normalizedRoot(input.documentationRoot);
  if (
    !input.path.endsWith(".rst") ||
    !withinDocumentationRoot(input.path, root) ||
    posix.normalize(input.path) !== input.path
  ) {
    throw new SphinxStructuralParseError(
      `RST page is outside the documentation source root: ${input.path}.`,
      "path-escape",
    );
  }
  const confPath = root ? `${root}/conf.py` : "conf.py";
  const confBytes = await input.readTracked(confPath);
  const limitations: string[] = [];
  const conf = confBytes ? parseSphinxConfLiterals(decode(confPath, confBytes)) : undefined;
  if (!conf) limitations.push("root-document-unresolved: tracked conf.py is unavailable");
  const suffixes = conf?.sourceSuffixes ?? [".rst", ".md"];
  const visited = new Map<string, "visiting" | "done">();
  const anchors = new Map<string, string>();
  const pendingRefs: Array<{ from: string; target: string }> = [];
  let opaqueRegions = 0;

  const read = async (path: string): Promise<Uint8Array | undefined> => {
    if (!withinDocumentationRoot(path, root))
      throw new SphinxStructuralParseError(
        `Sphinx target escapes the documentation source root: ${path}.`,
        "path-escape",
      );
    if (path === input.path) {
      if (!(await input.readTracked(path)))
        throw new SphinxStructuralParseError(
          `Selected RST page is not tracked: ${path}.`,
          "missing-target",
        );
      return input.candidate;
    }
    return input.readTracked(path);
  };

  const firstExisting = async (paths: readonly string[]): Promise<string | undefined> => {
    for (const path of paths) if (await read(path)) return path;
    return undefined;
  };

  const resolveTarget = (from: string, target: string): string => {
    const path = resolveSphinxTargetPath(root, from, target);
    if (!withinDocumentationRoot(path, root))
      throw new SphinxStructuralParseError(
        `Sphinx target escapes the documentation source root: ${target}.`,
        "path-escape",
      );
    return path;
  };

  const traverse = async (path: string): Promise<void> => {
    const state = visited.get(path);
    if (state === "done") return;
    if (state === "visiting")
      throw new SphinxStructuralParseError(
        `Sphinx toctree graph contains a cycle detected while revisiting document: ${path}.`,
        "cycle",
      );
    visited.set(path, "visiting");
    const bytes = await read(path);
    if (!bytes)
      throw new SphinxStructuralParseError(
        `The Sphinx document target is missing from this repository: ${path}.`,
        "missing-target",
      );
    const source = decode(path, bytes);
    const format = sphinxFormatForPath(path);
    const masked = format === "rst" ? maskOpaqueRst(source) : { source, opaqueRegions: 0 };
    opaqueRegions += masked.opaqueRegions;
    if (masked.opaqueRegions > 0)
      limitations.push(
        `opaque-directive: ${path} contains ${masked.opaqueRegions} unvalidated bounded region(s)`,
      );
    const scan =
      format === "rst" ? supportedShape(source).scan : scanSphinxDocument(source, format);
    for (const label of scan.labels) {
      const previous = anchors.get(label.label);
      if (previous && previous !== path)
        throw new SphinxStructuralParseError(
          `Sphinx label is defined in more than one document: ${label.label}.`,
          "duplicate-reference-label",
        );
      anchors.set(label.label, path);
    }
    for (const directive of scan.directives) {
      if (directive.kind === "toctree") {
        for (const target of directive.targets) {
          const base = resolveTarget(path, target);
          const resolved = await firstExisting(sphinxDocumentCandidatePaths(base, suffixes));
          if (!resolved)
            throw conf?.hasGeneratedContentExtension
              ? new SphinxStructuralParseError(
                  `Sphinx toctree target is generated content outside bounded scope: ${base}.`,
                  "generated-content-target",
                )
              : new SphinxStructuralParseError(
                  `Sphinx toctree target is missing: ${base}.`,
                  "missing-target",
                );
          await traverse(resolved);
        }
      } else {
        const target = directive.targets[0]!;
        const resolved = resolveTarget(path, target);
        if (!(await read(resolved)))
          throw new SphinxStructuralParseError(
            `The supported Sphinx ${directive.kind} target is missing from this repository: ${resolved}.`,
            "missing-target",
          );
        if (directive.kind === "include") {
          assertOptionlessInclude(path, source, format, directive.line);
          if (/\.rst$/iu.test(resolved)) await traverse(resolved);
          else {
            limitations.push(`include-structure-unchecked: ${resolved} is not an RST source`);
          }
        }
      }
    }
    for (const reference of scan.references) {
      if (reference.role === "doc") {
        const base = resolveTarget(path, reference.target);
        if (!(await firstExisting(sphinxDocumentCandidatePaths(base, suffixes))))
          throw new SphinxStructuralParseError(
            `Sphinx doc reference target is missing: ${base}.`,
            "missing-target",
          );
      } else pendingRefs.push({ from: path, target: reference.target });
    }
    visited.set(path, "done");
  };

  if (conf) {
    const rootBase = posix.normalize(root ? `${root}/${conf.rootDocument}` : conf.rootDocument);
    if (!withinDocumentationRoot(rootBase, root))
      throw new SphinxStructuralParseError(
        `Sphinx root document escapes the documentation source root: ${conf.rootDocument}.`,
        "path-escape",
      );
    const rootPath = await firstExisting(sphinxDocumentCandidatePaths(rootBase, suffixes));
    if (!rootPath)
      throw new SphinxStructuralParseError(
        `The Sphinx root document is missing from this repository: ${rootBase}.`,
        "missing-target",
      );
    await traverse(rootPath);
  }
  if (!visited.has(input.path)) await traverse(input.path);
  for (const pending of pendingRefs) {
    if (anchors.has(pending.target)) continue;
    throw new SphinxStructuralParseError(
      `Sphinx ref target is missing: ${pending.target} (from ${pending.from}).`,
      "missing-target",
    );
  }
  return deepFreeze({
    state: limitations.length > 0 ? "limited" : "passed",
    opaqueRegions,
    checkedKinds: [...CHECKED_KINDS],
    limitations,
  });
}
