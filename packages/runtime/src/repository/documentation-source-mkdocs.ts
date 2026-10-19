// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { parseDocument, visit } from "yaml";

/**
 * Pure parsing of the literal MkDocs/Material subset: docs_dir, nav, and use_directory_urls.
 * Nothing is executed; unsupported YAML constructs are rejected rather than degraded.
 */

const MAX_NAV_DEPTH = 16;
const MAX_NAV_ENTRIES = 2_000;
const INDEX_FILE_NAMES = new Set(["index.md", "README.md"]);

export class MkdocsConfigurationParseError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "MkdocsConfigurationParseError";
  }
}

export type MkdocsNavigationNode =
  | Readonly<{ kind: "page"; title: string | null; target: string }>
  | Readonly<{ kind: "section"; title: string; children: readonly MkdocsNavigationNode[] }>;

export interface MkdocsConfiguration {
  readonly docsDir: string;
  readonly useDirectoryUrls: boolean;
  readonly navigationMode: "explicit" | "automatic";
  readonly nav: readonly MkdocsNavigationNode[] | null;
}

type UnknownRecord = Record<string, unknown>;

export function parseMkdocsConfiguration(source: string): MkdocsConfiguration {
  const value = parseMkdocsYaml(source);
  if (value.INHERIT !== undefined)
    // hygiene: ok -- the error class constructs the complete stable message.
    throw new MkdocsConfigurationParseError(
      "MkDocs INHERIT-based configuration composition is unsupported; the effective configuration cannot be determined from this file alone.",
    );

  const docsDirRaw = value.docs_dir;
  const docsDir = docsDirRaw === undefined ? "docs" : literalRelativePath(docsDirRaw, "docs_dir");

  const useDirectoryUrlsRaw = value.use_directory_urls;
  let useDirectoryUrls = true;
  if (useDirectoryUrlsRaw !== undefined) {
    if (typeof useDirectoryUrlsRaw !== "boolean")
      // hygiene: ok -- the error class constructs the complete stable message.
      throw new MkdocsConfigurationParseError(
        "MkDocs use_directory_urls must be a literal YAML boolean value.",
      );
    useDirectoryUrls = useDirectoryUrlsRaw;
  }

  const navRaw = value.nav;
  if (navRaw === undefined) {
    const plugins = value.plugins;
    if (Array.isArray(plugins) && plugins.length > 0)
      // hygiene: ok -- the error class constructs the complete stable message.
      throw new MkdocsConfigurationParseError(
        "MkDocs automatic navigation with configured plugins is unsupported because plugins can silently reorder pages.",
      );
    return { docsDir, useDirectoryUrls, navigationMode: "automatic", nav: null };
  }
  const nav = parseNavList(navRaw, 0, { count: 0 });
  return { docsDir, useDirectoryUrls, navigationMode: "explicit", nav };
}

function parseMkdocsYaml(source: string): UnknownRecord {
  let document;
  try {
    document = parseDocument(source, { strict: true, uniqueKeys: true });
  } catch {
    // hygiene: ok -- the error class constructs the complete stable message.
    throw new MkdocsConfigurationParseError(
      "MkDocs configuration contains malformed YAML and cannot be interpreted.",
    );
  }
  if (document.errors.length > 0 || document.warnings.length > 0)
    // hygiene: ok -- the error class constructs the complete stable message.
    throw new MkdocsConfigurationParseError(
      "MkDocs configuration contains malformed or unsupported YAML syntax, such as a Python tag.",
    );
  let hasAlias = false;
  visit(document, {
    Alias: () => {
      hasAlias = true;
      return visit.BREAK;
    },
  });
  if (hasAlias)
    // hygiene: ok -- the error class constructs the complete stable message.
    throw new MkdocsConfigurationParseError(
      "MkDocs configuration aliases are unsupported by structural documentation validation.",
    );
  const value: unknown = document.toJS({ maxAliasCount: 0 });
  if (!isPlainObject(value))
    // hygiene: ok -- the error class constructs the complete stable message.
    throw new MkdocsConfigurationParseError(
      "MkDocs configuration must use a literal YAML mapping at the document root.",
    );
  return value;
}

function parseNavList(
  value: unknown,
  depth: number,
  state: { count: number },
): MkdocsNavigationNode[] {
  if (depth > MAX_NAV_DEPTH)
    // hygiene: ok -- the error class constructs the complete stable message.
    throw new MkdocsConfigurationParseError(
      "MkDocs nav nesting exceeds the maximum supported validation depth.",
    );
  if (!Array.isArray(value))
    // hygiene: ok -- the error class constructs the complete stable message.
    throw new MkdocsConfigurationParseError("MkDocs nav must use a literal YAML list of entries.");
  return value.map((item) => parseNavItem(item, depth, state));
}

function parseNavItem(
  item: unknown,
  depth: number,
  state: { count: number },
): MkdocsNavigationNode {
  state.count += 1;
  if (state.count > MAX_NAV_ENTRIES)
    // hygiene: ok -- the error class constructs the complete stable message.
    throw new MkdocsConfigurationParseError(
      "MkDocs nav exceeds the maximum supported validation entry count.",
    );
  if (typeof item === "string")
    return { kind: "page", title: null, target: literalRelativePath(item, "MkDocs nav page") };
  if (isPlainObject(item)) {
    const keys = Object.keys(item);
    if (keys.length !== 1)
      // hygiene: ok -- the error class constructs the complete stable message.
      throw new MkdocsConfigurationParseError(
        "MkDocs nav entries must use exactly one literal title key per mapping.",
      );
    const title = keys[0] ?? "";
    if (!title.trim())
      // hygiene: ok -- the error class constructs the complete stable message.
      throw new MkdocsConfigurationParseError(
        "MkDocs nav entries must use a non-empty literal title string.",
      );
    const entryValue = item[title];
    if (typeof entryValue === "string")
      return { kind: "page", title, target: literalRelativePath(entryValue, "MkDocs nav page") };
    if (Array.isArray(entryValue))
      return { kind: "section", title, children: parseNavList(entryValue, depth + 1, state) };
    // hygiene: ok -- the error class constructs the complete stable message.
    throw new MkdocsConfigurationParseError(
      "MkDocs nav entries must map a title to a literal page path or a nested literal list.",
    );
  }
  // hygiene: ok -- the error class constructs the complete stable message.
  throw new MkdocsConfigurationParseError(
    "MkDocs nav entries must use a supported literal scalar or single-key mapping shape.",
  );
}

function literalRelativePath(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim())
    // hygiene: ok -- the error class constructs the complete stable message.
    throw new MkdocsConfigurationParseError(
      `MkDocs ${field} must use a non-empty literal scalar string value.`,
    );
  const trimmed = value.trim();
  if (
    trimmed.startsWith("/") ||
    trimmed.includes("\\") ||
    trimmed.split("/").some((part) => part === ".." || part === "." || part === "")
  )
    // hygiene: ok -- the error class constructs the complete stable message.
    throw new MkdocsConfigurationParseError(
      `MkDocs ${field} must use a safe repository-relative literal path value.`,
    );
  return trimmed;
}

function isPlainObject(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Flatten an MkDocs nav tree into its ordered page leaves, dropping section titles. */
export function mkdocsNavigationLeaves(
  nav: readonly MkdocsNavigationNode[],
): readonly Readonly<{ title: string | null; target: string }>[] {
  const leaves: Readonly<{ title: string | null; target: string }>[] = [];
  const walk = (nodes: readonly MkdocsNavigationNode[]): void => {
    for (const node of nodes) {
      if (node.kind === "page") leaves.push({ title: node.title, target: node.target });
      else walk(node.children);
    }
  };
  walk(nav);
  return Object.freeze(leaves);
}

/** Route for a docs_dir-relative page, folding index/README and applying use_directory_urls. */
export function mkdocsPageRoute(relativePath: string, useDirectoryUrls: boolean): string {
  const normalized = literalRelativePath(relativePath, "page path");
  const segments = normalized.split("/");
  const file = segments[segments.length - 1] ?? "";
  if (!file.endsWith(".md"))
    // hygiene: ok -- the error class constructs the complete stable message.
    throw new MkdocsConfigurationParseError(
      "MkDocs page routes require a literal .md source file name.",
    );
  const directorySegments = INDEX_FILE_NAMES.has(file)
    ? segments.slice(0, -1)
    : [...segments.slice(0, -1), file.slice(0, -".md".length)];
  const directory = directorySegments.join("/");
  if (useDirectoryUrls) return directory === "" ? "/" : `/${directory}/`;
  return directory === "" ? "/index.html" : `/${directory}.html`;
}
