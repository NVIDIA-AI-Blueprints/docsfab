// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import {
  documentationMarkdownAnchors,
  documentationMarkdownLinkTargets,
  maskMarkdownLiteralContent,
} from "../repository/documentation-source-support.js";
import {
  MkdocsConfigurationParseError,
  mkdocsNavigationLeaves,
  parseMkdocsConfiguration,
} from "../repository/documentation-source-mkdocs.js";

/**
 * Owns every MkDocs-specific filesystem read and error mapping. The validator rethrows
 * these issues as StructuralDocumentationValidationError; importing it here would be circular.
 */

export type MkdocsStructuralCheckId =
  | "documentation-paths-readable"
  | "documentation-relative-links"
  | "documentation-navigation-targets";
export type MkdocsStructuralStatus = "failed" | "limitation";

export class MkdocsStructuralValidationIssue extends Error {
  public constructor(
    public readonly check: MkdocsStructuralCheckId,
    public readonly status: MkdocsStructuralStatus,
    public readonly details = "",
  ) {
    super(`MkDocs structural documentation ${status} (${check})${details ? `: ${details}` : ""}.`);
    this.name = "MkdocsStructuralValidationIssue";
  }
}

export type MkdocsChangedPath = Readonly<{
  path: string;
  status: "added" | "modified" | "deleted" | "renamed" | "copied";
}>;

const MAX_MATERIAL_BLOCK_DEPTH = 4;
const ADMONITION_MARKER = /^( *)!!!( )([A-Za-z][\w-]*)(?:\s+"([^"]*)")?\s*$/u;
const DETAILS_MARKER = /^( *)\?\?\?(\+)?( )([A-Za-z][\w-]*)(?:\s+"([^"]*)")?\s*$/u;
const TAB_MARKER = /^( *)===( )"([^"]*)"\s*$/u;

/** Validate one MkDocs source root: config parse, nav reachability, links, and Material syntax. */
export async function validateMkdocsStructuralDocumentation(
  root: string,
  changed: readonly MkdocsChangedPath[],
  configurationFiles: readonly Readonly<{ path: string }>[],
): Promise<void> {
  if (configurationFiles.length !== 1)
    // hygiene: ok -- the error class constructs the complete stable message.
    throw new MkdocsStructuralValidationIssue(
      "documentation-navigation-targets",
      "limitation",
      "MkDocs requires exactly one governing mkdocs.yml or mkdocs.yaml configuration file.",
    );
  const configPath = configurationFiles[0]?.path ?? "";
  const source = await readMkdocsFile(root, configPath, "documentation-paths-readable");
  let configuration;
  try {
    configuration = parseMkdocsConfiguration(source);
  } catch (error) {
    if (error instanceof MkdocsConfigurationParseError)
      // hygiene: ok -- the error class constructs the complete stable message.
      throw new MkdocsStructuralValidationIssue(
        "documentation-navigation-targets",
        "limitation",
        error.message,
      );
    throw error;
  }

  const docsDirAbsolute = resolve(root, configuration.docsDir);
  if (!within(root, docsDirAbsolute))
    // hygiene: ok -- the error class constructs the complete stable message.
    throw new MkdocsStructuralValidationIssue(
      "documentation-navigation-targets",
      "failed",
      "MkDocs docs_dir must remain within the source root.",
    );
  await assertSafePath(root, docsDirAbsolute, "documentation-navigation-targets");
  let docsDirIsDirectory = false;
  try {
    docsDirIsDirectory = (await stat(docsDirAbsolute)).isDirectory();
  } catch {
    docsDirIsDirectory = false;
  }
  if (!docsDirIsDirectory)
    // hygiene: ok -- the error class constructs the complete stable message.
    throw new MkdocsStructuralValidationIssue(
      "documentation-navigation-targets",
      "failed",
      `MkDocs docs_dir does not exist: ${configuration.docsDir}.`,
    );

  const reachable = new Set<string>();
  if (configuration.navigationMode === "explicit" && configuration.nav) {
    for (const leaf of mkdocsNavigationLeaves(configuration.nav)) {
      const targetAbsolute = resolve(docsDirAbsolute, leaf.target);
      if (!within(docsDirAbsolute, targetAbsolute))
        // hygiene: ok -- the error class constructs the complete stable message.
        throw new MkdocsStructuralValidationIssue(
          "documentation-navigation-targets",
          "failed",
          `MkDocs nav target escapes docs_dir: ${leaf.target}.`,
        );
      await assertSafePath(root, targetAbsolute, "documentation-navigation-targets");
      let isFile = false;
      try {
        isFile = (await stat(targetAbsolute)).isFile();
      } catch {
        isFile = false;
      }
      if (!isFile)
        // hygiene: ok -- the error class constructs the complete stable message.
        throw new MkdocsStructuralValidationIssue(
          "documentation-navigation-targets",
          "failed",
          `MkDocs nav references a missing page: ${leaf.target}.`,
        );
      reachable.add(relative(docsDirAbsolute, targetAbsolute).replaceAll("\\", "/"));
    }
  }

  const docsDirPrefix = `${configuration.docsDir}/`;
  const relevantMarkdown = changed
    .filter(({ path }) => path.startsWith(docsDirPrefix) && path.endsWith(".md"))
    .map(({ path, status }) => ({ path: path.slice(docsDirPrefix.length), status }));

  for (const { path, status } of relevantMarkdown) {
    if (status === "deleted") {
      if (configuration.navigationMode === "explicit" && reachable.has(path))
        // hygiene: ok -- the error class constructs the complete stable message.
        throw new MkdocsStructuralValidationIssue(
          "documentation-navigation-targets",
          "failed",
          `MkDocs nav still references a deleted page: ${path}.`,
        );
      continue;
    }
    const pageAbsolute = resolve(docsDirAbsolute, path);
    await assertSafePath(root, pageAbsolute, "documentation-paths-readable");
    const pageSource = await readMkdocsFile(
      root,
      relative(root, pageAbsolute),
      "documentation-paths-readable",
    );
    if (configuration.navigationMode === "explicit" && !reachable.has(path))
      // hygiene: ok -- the error class constructs the complete stable message.
      throw new MkdocsStructuralValidationIssue(
        "documentation-navigation-targets",
        "limitation",
        `Changed MkDocs page is not reachable from nav and needs an explicit nav update: ${path}.`,
      );
    await validateMkdocsMarkdownLinks(root, pageAbsolute, pageSource);
    scanMkdocsMaterialBlocks(pageSource);
  }
}

function splitFragment(rawTarget: string): { target: string; fragment?: string } {
  const separator = rawTarget.indexOf("#");
  if (separator < 0) return { target: rawTarget };
  return { target: rawTarget.slice(0, separator), fragment: rawTarget.slice(separator + 1) };
}

async function validateMkdocsMarkdownLinks(
  root: string,
  pageAbsolute: string,
  source: string,
): Promise<void> {
  const masked = maskMarkdownLiteralContent(source);
  for (const rawTarget of documentationMarkdownLinkTargets(masked)) {
    const { target, fragment } = splitFragment(rawTarget);
    if (!target) {
      if (fragment) await assertMkdocsAnchor(root, pageAbsolute, fragment);
      continue;
    }
    if (target.startsWith("/") || target.includes("\\"))
      // hygiene: ok -- the error class constructs the complete stable message.
      throw new MkdocsStructuralValidationIssue(
        "documentation-relative-links",
        "failed",
        `Unsupported MkDocs link target: ${rawTarget}.`,
      );
    const resolved = resolve(dirname(pageAbsolute), target);
    if (!within(root, resolved))
      // hygiene: ok -- the error class constructs the complete stable message.
      throw new MkdocsStructuralValidationIssue(
        "documentation-relative-links",
        "failed",
        `MkDocs link escapes the source root: ${rawTarget}.`,
      );
    const candidates = /\.md$/u.test(resolved)
      ? [resolved]
      : [resolved, `${resolved}.md`, join(resolved, "index.md"), join(resolved, "README.md")];
    let matched: string | undefined;
    for (const candidate of candidates) {
      try {
        await assertSafePath(root, candidate, "documentation-relative-links");
        if ((await stat(candidate)).isFile()) {
          matched = candidate;
          break;
        }
      } catch {
        // Try the next literal candidate; the loop reports a stable failure afterward.
      }
    }
    if (!matched)
      // hygiene: ok -- the error class constructs the complete stable message.
      throw new MkdocsStructuralValidationIssue(
        "documentation-relative-links",
        "failed",
        `Broken MkDocs relative link: ${rawTarget}.`,
      );
    if (fragment) await assertMkdocsAnchor(root, matched, fragment);
  }
}

async function assertMkdocsAnchor(
  root: string,
  pagePath: string,
  rawFragment: string,
): Promise<void> {
  await assertSafePath(root, pagePath, "documentation-relative-links");
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawFragment);
  } catch {
    // hygiene: ok -- the error class constructs the complete stable message.
    throw new MkdocsStructuralValidationIssue(
      "documentation-relative-links",
      "failed",
      `Malformed MkDocs link fragment: ${rawFragment}.`,
    );
  }
  const anchors = documentationMarkdownAnchors(await readFile(pagePath, "utf8"));
  const literal = decoded.normalize("NFC");
  if (!literal || !anchors.includes(literal))
    // hygiene: ok -- the error class constructs the complete stable message.
    throw new MkdocsStructuralValidationIssue(
      "documentation-relative-links",
      "failed",
      `Missing MkDocs anchor: ${rawFragment}.`,
    );
}

/**
 * Recognize the enumerated Material admonition/details/tab block markers and enforce bounded,
 * 4-space-aligned nesting. Positive recognition never asserts full Python-Markdown fidelity;
 * unsupported or over-nested markers fail closed with a stable limitation.
 */
export function scanMkdocsMaterialBlocks(source: string): void {
  const masked = maskMarkdownLiteralContent(source);
  const lines = masked.split(/\r?\n/u);
  const stack: number[] = [];
  for (const rawLine of lines) {
    if (!rawLine.trim()) continue;
    const indentMatch = /^ */u.exec(rawLine);
    const indent = indentMatch ? indentMatch[0].length : 0;
    while (stack.length > 0 && indent <= (stack[stack.length - 1] ?? -1)) stack.pop();
    const marker =
      ADMONITION_MARKER.exec(rawLine) ?? DETAILS_MARKER.exec(rawLine) ?? TAB_MARKER.exec(rawLine);
    if (!marker) continue;
    if (indent % 4 !== 0)
      // hygiene: ok -- the error class constructs the complete stable message.
      throw new MkdocsStructuralValidationIssue(
        "documentation-navigation-targets",
        "limitation",
        `Material block markers must align to 4-space indentation levels: "${rawLine.trim()}".`,
      );
    if (stack.length >= MAX_MATERIAL_BLOCK_DEPTH)
      // hygiene: ok -- the error class constructs the complete stable message.
      throw new MkdocsStructuralValidationIssue(
        "documentation-navigation-targets",
        "limitation",
        "Material admonition, details, and tab blocks exceed the maximum supported nesting depth.",
      );
    stack.push(indent);
  }
}

function within(root: string, value: string): boolean {
  const result = relative(root, value);
  return (
    result === "" ||
    (!result.startsWith("..") && !result.includes("../") && !result.includes("..\\"))
  );
}

async function assertSafePath(
  root: string,
  value: string,
  check: MkdocsStructuralCheckId,
): Promise<void> {
  if (!within(root, value))
    // hygiene: ok -- the error class constructs the complete stable message.
    throw new MkdocsStructuralValidationIssue(check, "failed", "Path escapes the source root.");
  let current = root;
  const segments = relative(root, value).split(/[\\/]/u).filter(Boolean);
  try {
    if ((await lstat(current)).isSymbolicLink())
      // hygiene: ok -- the error class constructs the complete stable message.
      throw new MkdocsStructuralValidationIssue(check, "failed", "Path traverses a symlink.");
    for (const segment of segments) {
      current = join(current, segment);
      if ((await lstat(current)).isSymbolicLink())
        // hygiene: ok -- the error class constructs the complete stable message.
        throw new MkdocsStructuralValidationIssue(check, "failed", "Path traverses a symlink.");
    }
    const rootReal = await realpath(root);
    const valueReal = await realpath(value);
    if (!within(rootReal, valueReal))
      // hygiene: ok -- the error class constructs the complete stable message.
      throw new MkdocsStructuralValidationIssue(check, "failed", "Path escapes the source root.");
  } catch (error) {
    if (error instanceof MkdocsStructuralValidationIssue) throw error;
    // hygiene: ok -- the error class constructs the complete stable message.
    throw new MkdocsStructuralValidationIssue(check, "failed", "Path is not accessible.");
  }
}

async function readMkdocsFile(
  root: string,
  path: string,
  check: MkdocsStructuralCheckId,
): Promise<string> {
  const candidate = resolve(root, path);
  if (!within(root, candidate))
    // hygiene: ok -- the error class constructs the complete stable message.
    throw new MkdocsStructuralValidationIssue(check, "failed", "Path escapes the source root.");
  await assertSafePath(root, candidate, check);
  try {
    return await readFile(candidate, "utf8");
  } catch {
    // hygiene: ok -- the error class constructs the complete stable message.
    throw new MkdocsStructuralValidationIssue(
      check,
      "failed",
      `Unable to read MkDocs file: ${path}.`,
    );
  }
}
