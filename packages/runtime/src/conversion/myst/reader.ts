// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { posix } from "node:path";

import { parse as parseYaml } from "yaml";

import { limit, refuseLimit, type ResolvedLimit } from "../../config/limits.js";
import {
  CONVERSION_IR_SCHEMA_VERSION,
  ConversionContractError,
  type AssetEntry,
  type ConversionBlock,
  type ConversionDocument,
  type ConversionIrV1,
  type ConversionSource,
  type IncludeNode,
  type IncludeTarget,
  type LabelEntry,
  type RoleNode,
  type SourceSpan,
  type SubstitutionEntry,
} from "../contracts.js";
import { BlockParser, isRemoteReference, type BlockContext } from "./blocks.js";
import { InlineParser, plainText, type LinkDefinition } from "./inline.js";
import { splitSourceLines, type SourceLine } from "./lines.js";
import type { MystSourceTree } from "./source-tree.js";
import { nestedBlockSequences, visitNodes } from "./tree.js";

export const MYST_READER_LIMIT_NAMES = Object.freeze({
  maxSourceBytes: "contentIndex.maxSourceBytes",
  maxNestingDepth: "conversion.maxNestingDepth",
} as const);

export interface MystReaderLimits {
  /** Bytes of one page or markup-included file. */
  readonly maxSourceBytes: ResolvedLimit;
  /** Block and inline containers nested along one path in one page. */
  readonly maxNestingDepth: ResolvedLimit;
}

/** Resolve the reader's bounds once, as host and project overrides set them. */
export function resolveMystReaderLimits(): MystReaderLimits {
  return {
    maxSourceBytes: limit(MYST_READER_LIMIT_NAMES.maxSourceBytes),
    maxNestingDepth: limit(MYST_READER_LIMIT_NAMES.maxNestingDepth),
  };
}

export interface MystReadInput {
  readonly source: ConversionSource;
  /** Read access to the documentation root named by `source.root`. */
  readonly tree: MystSourceTree;
  /** Root-relative POSIX paths of the pages to read. */
  readonly pages: readonly string[];
  /** Substitution-table entries from configuration, such as `readMystSubstitutions` returns. */
  readonly substitutions?: readonly SubstitutionEntry[];
  readonly limits?: MystReaderLimits;
}

const MYST_PARSER_NAMES = new Set(["myst", "md", "markdown", "myst_parser.sphinx_"]);
const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/u;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Normalize a root-relative path; undefined when it leaves the root. */
function normalizeWithinRoot(path: string): string | undefined {
  const normalized = posix.normalize(path);
  if (normalized === ".." || normalized.startsWith("../") || posix.isAbsolute(normalized)) {
    return undefined;
  }
  return normalized;
}

function stripQueryAndFragment(reference: string): string {
  return reference.replace(/[?#].*$/su, "");
}

interface PendingInclude {
  readonly node: IncludeNode;
  /** The local target's path relative to the documentation root. */
  readonly rootPath: string;
}

/** Refuse at a limit, naming where in the source the bound was passed. */
function refuseAt(bound: ResolvedLimit, observed: number, where: string): never {
  try {
    return refuseLimit(bound, observed);
  } catch (error) {
    if (error instanceof Error) error.message = `${where}: ${error.message}`;
    throw error;
  }
}

/**
 * Reads MyST pages into the conversion IR. Each page gets full block and
 * inline trees with source spans; markup includes are read under the
 * documentation root and recorded as their own documents; remote includes
 * are recorded and never fetched. Navigation and routes stay empty for
 * navigation assembly and route planning to fill.
 */
export function readMystSource(input: MystReadInput): ConversionIrV1 {
  const limits = input.limits ?? resolveMystReaderLimits();
  const root = posix.normalize(input.source.root.length > 0 ? input.source.root : ".");
  const repositoryPath = (rootPath: string): string => posix.normalize(posix.join(root, rootPath));
  const relativeToRoot = (path: string): string | undefined => {
    if (root === ".") return normalizeWithinRoot(path);
    if (path === root) return ".";
    return path.startsWith(`${root}/`)
      ? normalizeWithinRoot(path.slice(root.length + 1))
      : undefined;
  };
  const documents = new Map<string, ConversionDocument>();
  const assets = new Map<string, AssetEntry>();
  const labels: LabelEntry[] = [];
  const substitutions = new Map<string, SubstitutionEntry>();
  const includeEdges = new Map<string, Set<string>>();
  const queue: string[] = [];
  const queued = new Set<string>();

  const addSubstitution = (entry: SubstitutionEntry): void => {
    const existing = substitutions.get(entry.name);
    if (!existing) {
      substitutions.set(entry.name, entry);
      return;
    }
    if (JSON.stringify(existing.value) === JSON.stringify(entry.value)) return;
    const where = (origin: SubstitutionEntry["origin"]): string =>
      origin.kind === "configuration" ? origin.path : origin.sourcePath;
    throw new ConversionContractError(
      "conversion-substitution-conflict",
      `Substitution ${JSON.stringify(entry.name)} has one value in ${where(existing.origin)} and another in ${where(entry.origin)}.`,
      { construct: `substitution:${entry.name}` },
    );
  };
  for (const entry of input.substitutions ?? []) addSubstitution(entry);

  const enqueue = (rootPath: string): void => {
    if (queued.has(rootPath)) return;
    queued.add(rootPath);
    queue.push(rootPath);
  };
  const pages = [...input.pages].map((page) => {
    const normalized = normalizeWithinRoot(page);
    if (normalized === undefined) {
      throw new ConversionContractError(
        "conversion-include-outside-root",
        `Page ${JSON.stringify(page)} is outside the documentation root ${root}.`,
      );
    }
    return normalized;
  });
  for (const page of pages.sort(compareText)) enqueue(page);

  const addAsset = (role: AssetEntry["role"], sourcePath: string): string => {
    const id = `asset:${role}:${sourcePath}`;
    if (!assets.has(id)) assets.set(id, { id, sourcePath, role });
    return id;
  };

  const readDocument = (rootPath: string): void => {
    const sourcePath = repositoryPath(rootPath);
    const size = input.tree.fileSize(rootPath);
    if (size === undefined) {
      throw new ConversionContractError(
        "conversion-source-missing",
        `${sourcePath} is not a file under the documentation root ${root}.`,
      );
    }
    if (size > limits.maxSourceBytes.value) refuseAt(limits.maxSourceBytes, size, sourcePath);
    const bytes = input.tree.read(rootPath);
    if (bytes.byteLength > limits.maxSourceBytes.value) {
      refuseAt(limits.maxSourceBytes, bytes.byteLength, sourcePath);
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new ConversionContractError(
        "conversion-source-encoding",
        `${sourcePath} is not valid UTF-8.`,
      );
    }
    const pending: PendingInclude[] = [];
    const document = parseDocument(text, rootPath, sourcePath, {
      limits,
      repositoryPath,
      relativeToRoot,
      addAsset,
      pending,
      addSubstitution,
    });
    documents.set(rootPath, document);
    collectLabels(document, labels);
    for (const role of rolesNamed(document.children, "download")) {
      const reference = stripQueryAndFragment(role.target ?? role.content);
      if (reference.length === 0 || URL_SCHEME.test(reference)) continue;
      addAsset("download", assetPath(rootPath, reference, repositoryPath, role.span, sourcePath));
    }
    for (const { node, rootPath: included } of pending) {
      if (node.target.kind !== "local") continue;
      addAsset("include-source", node.target.path);
      if (input.tree.fileSize(included) === undefined) {
        throw new ConversionContractError(
          "conversion-include-missing",
          `${sourcePath}:${node.span.startLine}: include ${node.target.path} is not a file under the documentation root ${root}.`,
          { nodeId: node.id },
        );
      }
      const parser = node.other.find((option) => option.name === "parser")?.value;
      if (node.mode !== "markup" || (parser !== undefined && !MYST_PARSER_NAMES.has(parser)))
        continue;
      const edges = includeEdges.get(rootPath) ?? new Set<string>();
      edges.add(included);
      includeEdges.set(rootPath, edges);
      enqueue(included);
    }
  };

  for (let next = 0; next < queue.length; next += 1) readDocument(queue[next]!);
  refuseIncludeCycles(includeEdges, repositoryPath);

  return {
    schemaVersion: CONVERSION_IR_SCHEMA_VERSION,
    source: { ...input.source, extensionModules: [...input.source.extensionModules] },
    documents: [...documents.values()],
    navigation: { entries: [] },
    labels,
    routes: [],
    assets: [...assets.values()].sort((left, right) => compareText(left.id, right.id)),
    substitutions: [...substitutions.values()],
    dropLedger: [],
  };
}

function assetPath(
  documentRootPath: string,
  reference: string,
  repositoryPath: (rootPath: string) => string,
  span: SourceSpan,
  sourcePath: string,
): string {
  let decoded = reference;
  try {
    decoded = decodeURI(reference);
  } catch {
    decoded = reference;
  }
  const rootRelative = decoded.startsWith("/")
    ? posix.normalize(decoded.slice(1))
    : posix.normalize(posix.join(posix.dirname(documentRootPath), decoded));
  const path = repositoryPath(rootRelative);
  if (path === ".." || path.startsWith("../") || posix.isAbsolute(path)) {
    throw new ConversionContractError(
      "conversion-asset-outside-repository",
      `${sourcePath}:${span.startLine}: ${JSON.stringify(reference)} resolves outside the repository.`,
    );
  }
  return path;
}

interface DocumentServices {
  readonly limits: MystReaderLimits;
  readonly repositoryPath: (rootPath: string) => string;
  /** The root-relative path of a repository path, or undefined when it is outside the root. */
  readonly relativeToRoot: (repositoryPath: string) => string | undefined;
  readonly addAsset: (role: AssetEntry["role"], sourcePath: string) => string;
  readonly pending: PendingInclude[];
  readonly addSubstitution: (entry: SubstitutionEntry) => void;
}

function frontmatterOf(
  lines: readonly SourceLine[],
  sourcePath: string,
): { frontmatter: Record<string, unknown>; bodyStart: number; span?: SourceSpan } {
  if (lines.length === 0 || lines[0]!.text.trimEnd() !== "---")
    return { frontmatter: {}, bodyStart: 0 };
  const close = lines.findIndex(
    (line, index) => index > 0 && (line.text.trimEnd() === "---" || line.text.trimEnd() === "..."),
  );
  if (close < 0) return { frontmatter: {}, bodyStart: 0 };
  const yaml = lines
    .slice(1, close)
    .map((line) => line.text)
    .join("\n");
  let parsed: unknown;
  try {
    parsed = yaml.trim().length === 0 ? {} : parseYaml(yaml);
  } catch (error) {
    throw new ConversionContractError(
      "conversion-frontmatter-invalid",
      `${sourcePath}:1: frontmatter does not parse as YAML: ${(error as Error).message.split("\n")[0]}`,
    );
  }
  if (parsed === null || parsed === undefined) parsed = {};
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConversionContractError(
      "conversion-frontmatter-invalid",
      `${sourcePath}:1: frontmatter is not a YAML mapping.`,
    );
  }
  return {
    frontmatter: parsed as Record<string, unknown>,
    bodyStart: close + 1,
    span: { startLine: lines[0]!.line, endLine: lines[close]!.line },
  };
}

function parseDocument(
  text: string,
  rootPath: string,
  sourcePath: string,
  services: DocumentServices,
): ConversionDocument {
  const { limits } = services;
  const lines = splitSourceLines(text);
  const { frontmatter, bodyStart, span: frontmatterSpan } = frontmatterOf(lines, sourcePath);
  const documentSubstitutions = frontmatter.substitutions;
  if (documentSubstitutions !== undefined && frontmatterSpan) {
    if (
      documentSubstitutions === null ||
      typeof documentSubstitutions !== "object" ||
      Array.isArray(documentSubstitutions)
    ) {
      throw new ConversionContractError(
        "conversion-frontmatter-invalid",
        `${sourcePath}:1: frontmatter substitutions is not a mapping.`,
      );
    }
    for (const [name, value] of Object.entries(documentSubstitutions)) {
      services.addSubstitution({
        name,
        value:
          typeof value === "string" || typeof value === "number" || typeof value === "boolean"
            ? { kind: "literal", text: String(value) }
            : { kind: "computed", expression: JSON.stringify(value) },
        origin: { kind: "document", documentId: sourcePath, sourcePath, span: frontmatterSpan },
      });
    }
  }

  const deferred: Array<() => void> = [];
  const definitions = new Map<string, LinkDefinition>();
  const includePaths = new WeakMap<IncludeTarget, string>();
  const refuseDepth = (depth: number, line: number): void => {
    if (depth > limits.maxNestingDepth.value) {
      refuseAt(limits.maxNestingDepth, depth, `${sourcePath}:${line}`);
    }
  };
  const registerImage = (source: string, line: number): string | undefined => {
    const reference = stripQueryAndFragment(source.trim());
    if (reference.length === 0 || URL_SCHEME.test(reference) || reference.startsWith("//")) {
      return undefined;
    }
    const where = { startLine: line, endLine: line };
    return services.addAsset(
      "image",
      assetPath(rootPath, reference, services.repositoryPath, where, sourcePath),
    );
  };
  const context: BlockContext = {
    definitions,
    enterBlock: refuseDepth,
    deferInline: (job) => deferred.push(job),
    parseInline: (inlineLines, depth) =>
      new InlineParser(inlineLines, {
        definitions,
        enterInline: (inlineDepth, line) => refuseDepth(depth + inlineDepth, line),
        registerImage,
        refuseImageTitle: (line) => {
          throw new ConversionContractError(
            "conversion-image-title-unsupported",
            `${sourcePath}:${line}: an inline or reference image title is not represented in the conversion IR; move it to visible alt text or a caption before converting.`,
            { construct: "image:inline-title" },
          );
        },
      }).parse(),
    registerImage,
    includeTarget: (argument, line): IncludeTarget => {
      const reference = argument.trim();
      if (reference.length === 0) {
        throw new ConversionContractError(
          "conversion-directive-options-invalid",
          `${sourcePath}:${line}: an include directive names no file.`,
        );
      }
      if (isRemoteReference(reference)) return { kind: "remote", url: reference };
      const rootRelative = services.relativeToRoot(
        services.repositoryPath(
          reference.startsWith("/")
            ? reference.slice(1)
            : posix.join(posix.dirname(rootPath), reference),
        ),
      );
      if (rootRelative === undefined) {
        throw new ConversionContractError(
          "conversion-include-outside-root",
          `${sourcePath}:${line}: include ${JSON.stringify(reference)} resolves outside the documentation root.`,
        );
      }
      const target: IncludeTarget = { kind: "local", path: services.repositoryPath(rootRelative) };
      includePaths.set(target, rootRelative);
      return target;
    },
    refuseOptions: (detail, line) => {
      throw new ConversionContractError(
        "conversion-directive-options-invalid",
        `${sourcePath}:${line}: ${detail}`,
      );
    },
  };
  const children = new BlockParser(lines.slice(bodyStart), context, 0).parse();
  for (const job of deferred) job();

  let counter = 0;
  visitNodes(children, (node) => {
    counter += 1;
    node.id = `${sourcePath}#${counter}`;
    const included = node.kind === "include" ? includePaths.get(node.target) : undefined;
    if (node.kind === "include" && included !== undefined) {
      services.pending.push({ node, rootPath: included });
    }
  });
  return { id: sourcePath, sourcePath, format: "myst", frontmatter, children };
}

function rolesNamed(blocks: readonly ConversionBlock[], name: string): RoleNode[] {
  const roles: RoleNode[] = [];
  visitNodes(blocks, (node) => {
    if (node.kind === "role" && node.name === name) roles.push(node);
  });
  return roles;
}

/** Label-table entries from targets and `:name:` options, with titles where the source gives one. */
function collectLabels(document: ConversionDocument, labels: LabelEntry[]): void {
  const visit = (sequence: readonly ConversionBlock[], topLevel: boolean): void => {
    sequence.forEach((node, index) => {
      const entry = (label: string, title: string | undefined, anchor: boolean): void => {
        labels.push({
          label,
          documentId: document.id,
          ...(anchor ? { anchor: label } : {}),
          ...(title !== undefined && title.length > 0 ? { title } : {}),
          span: node.span,
        });
      };
      switch (node.kind) {
        case "target": {
          const next = sequence.slice(index + 1).find((sibling) => sibling.kind !== "target");
          const heading = next?.kind === "heading" ? next : undefined;
          const namesPage =
            topLevel &&
            heading?.depth === 1 &&
            sequence
              .slice(0, index)
              .every((sibling) => sibling.kind === "target" || sibling.kind === "comment");
          entry(node.label, heading ? plainText(heading.children).trim() : undefined, !namesPage);
          break;
        }
        case "codeBlock":
          if (node.options.name) entry(node.options.name, node.options.caption, true);
          break;
        case "figure":
          if (node.label) entry(node.label, plainText(node.caption).trim(), true);
          break;
        case "image": {
          const name = node.options.other.find((option) => option.name === "name")?.value;
          if (name) entry(name, undefined, true);
          break;
        }
        case "include": {
          const name = node.other.find((option) => option.name === "name")?.value;
          if (name) entry(name, node.caption, true);
          break;
        }
        case "directive": {
          const name = node.options.find((option) => option.name === "name")?.value;
          if (name) entry(name, undefined, true);
          break;
        }
        default:
          break;
      }
      for (const nested of nestedBlockSequences(node)) visit(nested, false);
    });
  };
  visit(document.children, true);
}

/** Refuse when markup includes form a cycle; names the cycle in source paths. */
function refuseIncludeCycles(
  edges: ReadonlyMap<string, ReadonlySet<string>>,
  repositoryPath: (rootPath: string) => string,
): void {
  const state = new Map<string, "visiting" | "done">();
  const nodes = [...edges.keys()].sort(compareText);
  for (const start of nodes) {
    if (state.has(start)) continue;
    const stack: Array<{ node: string; next: string[] }> = [
      { node: start, next: [...(edges.get(start) ?? [])].sort(compareText) },
    ];
    state.set(start, "visiting");
    while (stack.length > 0) {
      const frame = stack.at(-1)!;
      const target = frame.next.shift();
      if (target === undefined) {
        state.set(frame.node, "done");
        stack.pop();
        continue;
      }
      const seen = state.get(target);
      if (seen === "visiting") {
        const cycle = [
          ...stack.slice(stack.findIndex((each) => each.node === target)).map((each) => each.node),
          target,
        ];
        throw new ConversionContractError(
          "conversion-include-cycle",
          `Markup includes form a cycle: ${cycle.map(repositoryPath).join(" -> ")}.`,
        );
      }
      if (seen === "done") continue;
      state.set(target, "visiting");
      stack.push({ node: target, next: [...(edges.get(target) ?? [])].sort(compareText) });
    }
  }
}
