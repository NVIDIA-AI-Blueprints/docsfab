// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { posix } from "node:path";

import { maskInlineCode } from "../content-ir/parser.js";

/**
 * Sphinx support over a static subset of conf.py and the RST/MyST directives
 * that carry local structure. It never executes Python or resolves generated
 * content, custom domains, or remote inventories; those are reported as
 * limitations. The Content IR records directive shapes only.
 */

export type SphinxStructuralIssueCode =
  | "ambiguous-configuration-location"
  | "ambiguous-configuration-value"
  | "computed-configuration"
  | "unsupported-directive"
  | "malformed-directive"
  | "missing-target"
  | "path-escape"
  | "cycle"
  | "generated-content-target"
  | "duplicate-reference-label";

/** Stable, content-free reason a Sphinx source could not be structurally resolved. */
export class SphinxStructuralParseError extends Error {
  public constructor(
    message: string,
    public readonly code: SphinxStructuralIssueCode,
  ) {
    super(message);
    this.name = "SphinxStructuralParseError";
  }
}

export const SPHINX_SUPPORTED_DIRECTIVES = [
  "code",
  "code-block",
  "include",
  "literalinclude",
  "toctree",
] as const;
export type SphinxSupportedDirective = (typeof SPHINX_SUPPORTED_DIRECTIVES)[number];

const SUPPORTED_DIRECTIVES = new Set<string>(SPHINX_SUPPORTED_DIRECTIVES);

/** Extensions whose generated content DocsFab does not build. */
export const SPHINX_GENERATED_CONTENT_EXTENSIONS = [
  "sphinx.ext.apidoc",
  "sphinx.ext.autodoc",
  "sphinx.ext.autosummary",
  "sphinx.ext.intersphinx",
] as const;

export type SphinxDocumentFormat = "rst" | "myst";

export interface SphinxConfLiteralsV1 {
  readonly project?: string;
  readonly rootDocument: string;
  readonly sourceSuffixes: readonly string[];
  readonly extensions: readonly string[];
  readonly hasGeneratedContentExtension: boolean;
}

export interface SphinxDirectiveReferenceV1 {
  readonly kind: "toctree" | "include" | "literalinclude";
  readonly line: number;
  readonly targets: readonly string[];
}

export interface SphinxLocalReferenceV1 {
  readonly role: "ref" | "doc";
  readonly line: number;
  readonly target: string;
}

export interface SphinxLabelV1 {
  readonly label: string;
  readonly line: number;
}

export interface SphinxScanResultV1 {
  readonly directives: readonly SphinxDirectiveReferenceV1[];
  readonly references: readonly SphinxLocalReferenceV1[];
  readonly labels: readonly SphinxLabelV1[];
}

const TRACKED_CONF_KEYS = [
  "project",
  "root_doc",
  "master_doc",
  "source_suffix",
  "extensions",
] as const;
type TrackedConfKey = (typeof TRACKED_CONF_KEYS)[number];

interface ConfAssignment {
  readonly indent: number;
  readonly raw: string;
  readonly line: number;
}

const STRING_LITERAL = /^(['"])((?:\\.|(?!\1).)*)\1$/su;
const ASSIGNMENT = /^(\s*)([A-Za-z_][A-Za-z0-9_]*)\s*=(?!=)\s*(.*)$/u;

/** Parse the static conf.py literals used for routing without executing Python. */
export function parseSphinxConfLiterals(source: string): SphinxConfLiteralsV1 {
  const assignments = collectConfAssignments(source);
  const project = assignments.get("project")?.length
    ? literalScalar(singleAssignment(assignments, "project"), "project")
    : undefined;
  const rootDocument = resolveRootDocument(assignments);
  const sourceSuffixes = literalStringList(assignments, "source_suffix", [".rst", ".md"]);
  const extensions = literalStringList(assignments, "extensions", []);
  const hasGeneratedContentExtension = extensions.some((extension) =>
    (SPHINX_GENERATED_CONTENT_EXTENSIONS as readonly string[]).includes(extension),
  );
  return {
    ...(project !== undefined ? { project } : {}),
    rootDocument,
    sourceSuffixes,
    extensions,
    hasGeneratedContentExtension,
  };
}

function collectConfAssignments(source: string): Map<TrackedConfKey, ConfAssignment[]> {
  const assignments = new Map<TrackedConfKey, ConfAssignment[]>();
  const lines = source.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const stripped = stripPythonComment(lines[index] ?? "");
    const match = ASSIGNMENT.exec(stripped);
    if (!match) continue;
    const name = match[2]!;
    if (!(TRACKED_CONF_KEYS as readonly string[]).includes(name)) continue;
    const key = name as TrackedConfKey;
    let raw = (match[3] ?? "").trim();
    let end = index;
    while (isUnbalanced(raw) && end + 1 < lines.length) {
      end += 1;
      raw = `${raw} ${stripPythonComment(lines[end] ?? "").trim()}`.trim();
    }
    const existing = assignments.get(key) ?? [];
    existing.push({ indent: match[1]!.length, raw, line: index + 1 });
    assignments.set(key, existing);
    index = end;
  }
  return assignments;
}

function isUnbalanced(raw: string): boolean {
  let open = 0;
  let quote: string | undefined;
  for (const character of raw) {
    if (quote) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "[" || character === "(") open += 1;
    else if (character === "]" || character === ")") open -= 1;
  }
  return open > 0;
}

function stripPythonComment(line: string): string {
  let quote: string | undefined;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "#") return line.slice(0, index);
  }
  return line;
}

function singleAssignment(
  assignments: Map<TrackedConfKey, ConfAssignment[]>,
  key: TrackedConfKey,
): ConfAssignment {
  const values = assignments.get(key) ?? [];
  if (values.length > 1)
    throw new SphinxStructuralParseError(
      `Conflicting literal assignments to Sphinx conf.py key: ${key}.`,
      "ambiguous-configuration-value",
    );
  return values[0]!;
}

function literalScalar(assignment: ConfAssignment, key: string): string {
  if (assignment.indent > 0)
    throw new SphinxStructuralParseError(
      `Sphinx conf.py key ${key} is assigned outside top-level scope (line ${assignment.line}).`,
      "computed-configuration",
    );
  const match = STRING_LITERAL.exec(assignment.raw);
  if (!match)
    throw new SphinxStructuralParseError(
      `Sphinx conf.py key ${key} is not a static string literal (line ${assignment.line}).`,
      "computed-configuration",
    );
  return unescapeLiteral(match[2]!);
}

function resolveRootDocument(assignments: Map<TrackedConfKey, ConfAssignment[]>): string {
  const rootDocValue = assignments.get("root_doc")?.length
    ? literalScalar(singleAssignment(assignments, "root_doc"), "root_doc")
    : undefined;
  const masterDocValue = assignments.get("master_doc")?.length
    ? literalScalar(singleAssignment(assignments, "master_doc"), "master_doc")
    : undefined;
  if (rootDocValue !== undefined && masterDocValue !== undefined && rootDocValue !== masterDocValue)
    throw new SphinxStructuralParseError(
      "Sphinx conf.py declares root_doc and master_doc with different literal values.",
      "ambiguous-configuration-value",
    );
  return rootDocValue ?? masterDocValue ?? "index";
}

function literalStringList(
  assignments: Map<TrackedConfKey, ConfAssignment[]>,
  key: TrackedConfKey,
  fallback: readonly string[],
): readonly string[] {
  const values = assignments.get(key) ?? [];
  if (values.length === 0) return fallback;
  if (values.length > 1)
    throw new SphinxStructuralParseError(
      `Conflicting literal assignments to Sphinx conf.py key: ${key}.`,
      "ambiguous-configuration-value",
    );
  const assignment = values[0]!;
  if (assignment.indent > 0)
    throw new SphinxStructuralParseError(
      `Sphinx conf.py key ${key} is assigned outside top-level scope (line ${assignment.line}).`,
      "computed-configuration",
    );
  return parseListLiteral(assignment.raw, key, assignment.line);
}

function parseListLiteral(raw: string, key: string, line: number): readonly string[] {
  const trimmed = raw.trim();
  const scalar = STRING_LITERAL.exec(trimmed);
  if (scalar) return [unescapeLiteral(scalar[2]!)];
  const bracket = /^[[(](.*)[\])]$/su.exec(trimmed);
  if (!bracket)
    throw new SphinxStructuralParseError(
      `Sphinx conf.py key ${key} is not a static string or literal list (line ${line}).`,
      "computed-configuration",
    );
  const body = bracket[1]!;
  const values: string[] = [];
  for (const match of body.matchAll(/'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)"/gsu))
    values.push(unescapeLiteral(match[1] ?? match[2] ?? ""));
  const residual = body
    .replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/gsu, "")
    .replace(/[\s,]/gu, "");
  if (residual.length > 0)
    throw new SphinxStructuralParseError(
      `Sphinx conf.py key ${key} contains a computed or non-literal list entry (line ${line}).`,
      "computed-configuration",
    );
  return values;
}

function unescapeLiteral(value: string): string {
  return value.replace(/\\(.)/gsu, "$1");
}

const RST_DIRECTIVE = /^(\s*)\.\.\s+([A-Za-z][\w:.-]*)::(?:[ \t]+(.*))?\s*$/u;
const RST_LABEL = /^\s*\.\.\s+_([^:]+):\s*$/u;
const MYST_DIRECTIVE = /^(\s*)((?:`|~|:){3,})\{([A-Za-z][\w:.-]*)\}(?:[ \t]+(\S.*))?\s*$/u;
const MYST_LABEL = /^\s*\(([^)]+)\)=\s*$/u;
const ROLE = /:(ref|doc):`([^`]+)`|\{(ref|doc)\}`([^`]+)`/gu;

/**
 * Scan RST/MyST source for directive targets, ref/doc role targets, and
 * labels. Throws for any directive or domain outside the supported set.
 */
export function scanSphinxDocument(
  source: string,
  format: SphinxDocumentFormat,
): SphinxScanResultV1 {
  return format === "rst" ? scanRst(source) : scanMyst(source);
}

function scanRst(source: string): SphinxScanResultV1 {
  const lines = source.split(/\r?\n/u);
  const directives: SphinxDirectiveReferenceV1[] = [];
  const references: SphinxLocalReferenceV1[] = [];
  const labels: SphinxLabelV1[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const label = RST_LABEL.exec(line);
    if (label) {
      labels.push({ label: label[1]!.trim().toLowerCase(), line: index + 1 });
      continue;
    }
    const directive = RST_DIRECTIVE.exec(line);
    if (directive) {
      const indent = directive[1]!.length;
      const name = directive[2]!.toLowerCase();
      const argument = (directive[3] ?? "").trim();
      assertSupportedDirective(name, index + 1);
      if (name === "toctree") {
        const { entries, end } = collectIndentedBody(lines, index + 1, indent);
        directives.push({
          kind: "toctree",
          line: index + 1,
          targets: entries
            .filter((entry) => !entry.startsWith(":"))
            .map((entry) => toctreeTarget(entry, index + 1)),
        });
        index = end - 1;
        continue;
      }
      if (name === "include" || name === "literalinclude") {
        if (!argument)
          throw new SphinxStructuralParseError(
            `Sphinx ${name} directive is missing its target at line ${index + 1}.`,
            "malformed-directive",
          );
        directives.push({ kind: name, line: index + 1, targets: [argument] });
        continue;
      }
      // code / code-block: skip the literal body so it is not scanned for directives.
      const { end } = collectIndentedBody(lines, index + 1, indent);
      index = end - 1;
      continue;
    }
    const masked = maskInlineCode(line, { preserveMystRoles: true });
    for (const match of masked.matchAll(ROLE)) {
      const role = (match[1] ?? match[3])! as "ref" | "doc";
      const target = (match[2] ?? match[4])!.trim();
      references.push({ role, line: index + 1, target: roleTarget(target) });
    }
  }
  return {
    directives: Object.freeze(directives),
    references: Object.freeze(references),
    labels: Object.freeze(labels),
  };
}

function scanMyst(source: string): SphinxScanResultV1 {
  const lines = source.split(/\r?\n/u);
  const directives: SphinxDirectiveReferenceV1[] = [];
  const references: SphinxLocalReferenceV1[] = [];
  const labels: SphinxLabelV1[] = [];
  let fence: { marker: string } | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (fence) {
      if (closesFence(line, fence.marker)) fence = undefined;
      continue;
    }
    const label = MYST_LABEL.exec(line);
    if (label) {
      labels.push({ label: label[1]!.trim().toLowerCase(), line: index + 1 });
      continue;
    }
    const directive = MYST_DIRECTIVE.exec(line);
    if (directive) {
      const marker = directive[2]!;
      const name = directive[3]!.toLowerCase();
      const argument = (directive[4] ?? "").trim();
      assertSupportedDirective(name, index + 1);
      if (name === "toctree") {
        const { entries, end } = collectFencedBody(lines, index + 1, marker);
        directives.push({
          kind: "toctree",
          line: index + 1,
          targets: entries
            .filter((entry) => !entry.startsWith(":"))
            .map((entry) => toctreeTarget(entry, index + 1)),
        });
        index = end - 1;
        continue;
      }
      if (name === "include" || name === "literalinclude") {
        if (!argument)
          throw new SphinxStructuralParseError(
            `Sphinx ${name} directive is missing its target at line ${index + 1}.`,
            "malformed-directive",
          );
        directives.push({ kind: name, line: index + 1, targets: [argument] });
        const { end } = collectFencedBody(lines, index + 1, marker);
        index = end - 1;
        continue;
      }
      fence = { marker };
      continue;
    }
    const fenceOpen = /^\s*(`{3,}|~{3,})/u.exec(line);
    if (fenceOpen) {
      fence = { marker: fenceOpen[1]! };
      continue;
    }
    const masked = maskInlineCode(line, { preserveMystRoles: true });
    for (const match of masked.matchAll(ROLE)) {
      const role = (match[1] ?? match[3])! as "ref" | "doc";
      const target = (match[2] ?? match[4])!.trim();
      references.push({ role, line: index + 1, target: roleTarget(target) });
    }
  }
  return {
    directives: Object.freeze(directives),
    references: Object.freeze(references),
    labels: Object.freeze(labels),
  };
}

function assertSupportedDirective(name: string, line: number): void {
  if (!SUPPORTED_DIRECTIVES.has(name))
    throw new SphinxStructuralParseError(
      `Unsupported Sphinx directive or domain: ${name} at line ${line}.`,
      "unsupported-directive",
    );
}

function collectIndentedBody(
  lines: readonly string[],
  start: number,
  indent: number,
): { entries: string[]; end: number } {
  const entries: string[] = [];
  let end = start;
  for (; end < lines.length; end += 1) {
    const line = lines[end] ?? "";
    if (!line.trim()) continue;
    const lineIndent = line.length - line.trimStart().length;
    if (lineIndent <= indent) break;
    entries.push(line.trim());
  }
  return { entries, end: Math.max(start, end) };
}

function collectFencedBody(
  lines: readonly string[],
  start: number,
  marker: string,
): { entries: string[]; end: number } {
  const entries: string[] = [];
  let end = start;
  for (; end < lines.length; end += 1) {
    const line = lines[end] ?? "";
    if (closesFence(line, marker)) {
      end += 1;
      break;
    }
    if (line.trim()) entries.push(line.trim());
  }
  return { entries, end: Math.max(start, end) };
}

function closesFence(line: string, marker: string): boolean {
  return new RegExp(`^\\s*${escapeRegExp(marker[0]!)}{${marker.length},}\\s*$`, "u").test(line);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function toctreeTarget(entry: string, line: number): string {
  const explicit = entry.match(/^.*?<([^>]+)>$/u);
  const target = (explicit?.[1] ?? entry).trim();
  if (!target || target.includes("*"))
    throw new SphinxStructuralParseError(
      `Unsupported glob or empty toctree entry at line ${line}.`,
      "malformed-directive",
    );
  return target;
}

function roleTarget(value: string): string {
  const explicit = value.match(/^.*?<([^>]+)>$/u);
  return (explicit?.[1] ?? value).trim();
}

/** .rst sources parse as RST; every other supported suffix parses as MyST-flavored Markdown. */
export function sphinxFormatForPath(path: string): SphinxDocumentFormat {
  return /\.rst$/iu.test(path) ? "rst" : "myst";
}

/**
 * Resolve a directive target to a repository-relative base path. A leading `/`
 * is relative to the directory containing conf.py; otherwise to the document.
 */
export function resolveSphinxTargetPath(
  sphinxRoot: string,
  referencingDocumentPath: string,
  rawTarget: string,
): string {
  const base = rawTarget.startsWith("/") ? sphinxRoot : posix.dirname(referencingDocumentPath);
  return posix.normalize(posix.join(base, rawTarget.replace(/^\//u, "")));
}

/** Candidate document paths for a toctree entry, trying each configured suffix in order. */
export function sphinxDocumentCandidatePaths(
  basePath: string,
  suffixes: readonly string[],
): readonly string[] {
  if (suffixes.some((suffix) => basePath.toLowerCase().endsWith(suffix.toLowerCase())))
    return [basePath];
  return suffixes.map((suffix) => `${basePath}${suffix}`);
}
