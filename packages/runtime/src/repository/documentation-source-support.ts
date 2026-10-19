// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readdir } from "node:fs/promises";
import { dirname, posix, relative, resolve } from "node:path";

import { deepFreeze } from "../contract-kit/freeze.js";
import { FernStructuralParseError, type FernNavigationTarget } from "./fern-navigation.js";

const INLINE_LINK = /!?(?:\[[^\]]*\])\(([^)\s]+)(?:\s+[^)]*)?\)/gu;
const REFERENCE_LINK = /!?(?:\[[^\]]+\])\[([^\]]*)\]/gu;
const REFERENCE_DEFINITION = /^\s{0,3}\[([^\]]+)\]:\s*(?:<([^>]+)>|(\S+))/gmu;
const REFERENCE_DEFINITION_LINE = /^\s{0,3}\[[^\]]+\]:\s*(?:<[^>]+>|\S+)/u;
const CARD_HREF_ATTRIBUTE = /\shref\s*=/gu;
const STATIC_CARD_HREF = /^href\s*=\s*(?:"([^"\\]*)"|'([^'\\]*)')/u;
const MAX_CARD_OPENING_TAG_LENGTH = 8_192;
const MAX_HTML_ANCHOR_TAG_LENGTH = 8_192;

export const DOCUMENTATION_SOURCE_ADAPTER_VERSION = "1" as const;

export const DOCUMENTATION_SOURCE_ADAPTER_IDS = [
  "plain-markdown",
  "mkdocs",
  "docusaurus",
  "sphinx",
  "fern",
  "jupyter-book",
] as const;
export type DocumentationSourceAdapterId = (typeof DOCUMENTATION_SOURCE_ADAPTER_IDS)[number];

export const DOCUMENTATION_SOURCE_CAPABILITIES = [
  "detect",
  "navigation",
  "routes",
  "versions",
  "includes",
  "components",
  "frontmatter",
  "validate",
] as const;
export type DocumentationSourceCapability = (typeof DOCUMENTATION_SOURCE_CAPABILITIES)[number];

export const DOCUMENTATION_SOURCE_CAPABILITY_STATES = [
  "supported",
  "partial",
  "unsupported",
  "not-applicable",
] as const;
export type DocumentationSourceCapabilityState =
  (typeof DOCUMENTATION_SOURCE_CAPABILITY_STATES)[number];

/** Writer authority is separate from an adapter's ability to read or validate markup. */
export const DOCUMENTATION_SOURCE_RST_UPDATE_CAPABILITY_VERSION = 1 as const;
export function documentationSourceRstUpdateCapability(adapterId: DocumentationSourceAdapterId) {
  return deepFreeze({
    schemaVersion: DOCUMENTATION_SOURCE_RST_UPDATE_CAPABILITY_VERSION,
    capability: "update-existing-rst-ordinary-prose" as const,
    adapterId,
    state: adapterId === "sphinx" ? ("supported" as const) : ("unsupported" as const),
    limitation: adapterId === "sphinx" ? "top-level-prose-only" : "rst-writer-unavailable",
  });
}

export const DOCUMENTATION_SOURCE_NAVIGATION_MODES = ["none", "explicit", "automatic"] as const;
export type DocumentationSourceNavigationMode =
  (typeof DOCUMENTATION_SOURCE_NAVIGATION_MODES)[number];

export const DOCUMENTATION_SOURCE_LIMITATION_CODES = [
  "ambiguous-root-ownership",
  "configuration-deleted-without-authorized-root-change",
  "mixed-root-ownership",
  "navigation-not-checked",
  "unrecognized-markup-extension",
  "unsupported-docusaurus-adapter",
  "unsupported-jupyter-book-adapter",
  "unsupported-mkdocs-adapter",
  "unsupported-relevant-configuration",
  "unsupported-sphinx-adapter",
] as const;
export type DocumentationSourceLimitationCode =
  (typeof DOCUMENTATION_SOURCE_LIMITATION_CODES)[number];

/**
 * Limitations that record what validation did not check without refusing the
 * root. Every other limitation stops structural validation.
 */
export const DOCUMENTATION_SOURCE_ADVISORY_LIMITATION_CODES = [
  "navigation-not-checked",
] as const satisfies readonly DocumentationSourceLimitationCode[];

export interface DocumentationSourceAdapterSupport {
  readonly adapterId: DocumentationSourceAdapterId;
  readonly adapterVersion: typeof DOCUMENTATION_SOURCE_ADAPTER_VERSION;
  /** Every spelling, relative to a documentation root, that identifies the generator. */
  readonly configurationLocations: readonly string[];
  /** The configuration locations that declare navigation. */
  readonly navigationLocations: readonly string[];
  readonly supportedExtensions: readonly string[];
  /** Package manifest dependency names that identify the generator. */
  readonly packageDependencies: readonly string[];
  readonly capabilities: Readonly<
    Record<DocumentationSourceCapability, DocumentationSourceCapabilityState>
  >;
  /** Reported for a root the adapter owns while its `validate` capability is `unsupported`. */
  readonly unsupportedLimitation: DocumentationSourceLimitationCode;
  /**
   * For a `partial` validate capability: the plain-Markdown checks run instead,
   * and the root records the advisory limitation naming what they skip.
   */
  readonly validationFallback: Readonly<{
    adapterId: "plain-markdown";
    limitation: (typeof DOCUMENTATION_SOURCE_ADVISORY_LIMITATION_CODES)[number];
  }> | null;
}

const MODULE_EXTENSIONS = ["cjs", "cts", "js", "mjs", "mts", "ts"] as const;
const DOCUSAURUS_SIDEBAR_LOCATIONS = [...MODULE_EXTENSIONS, "json"]
  .map((extension) => `sidebars.${extension}`)
  .sort();

const ADAPTERS: Readonly<Record<DocumentationSourceAdapterId, DocumentationSourceAdapterSupport>> =
  deepFreeze({
    "plain-markdown": {
      adapterId: "plain-markdown",
      adapterVersion: DOCUMENTATION_SOURCE_ADAPTER_VERSION,
      configurationLocations: [],
      navigationLocations: [],
      supportedExtensions: [".md", ".mdx"],
      packageDependencies: [],
      capabilities: {
        detect: "supported",
        navigation: "not-applicable",
        routes: "not-applicable",
        versions: "not-applicable",
        includes: "not-applicable",
        components: "partial",
        frontmatter: "not-applicable",
        validate: "supported",
      },
      unsupportedLimitation: "unsupported-relevant-configuration",
      validationFallback: null,
    },
    mkdocs: {
      adapterId: "mkdocs",
      adapterVersion: DOCUMENTATION_SOURCE_ADAPTER_VERSION,
      configurationLocations: ["mkdocs.yaml", "mkdocs.yml"],
      navigationLocations: ["mkdocs.yaml", "mkdocs.yml"],
      supportedExtensions: [".md"],
      packageDependencies: ["mkdocs"],
      capabilities: {
        detect: "supported",
        navigation: "partial",
        routes: "unsupported",
        versions: "unsupported",
        includes: "unsupported",
        components: "not-applicable",
        frontmatter: "unsupported",
        validate: "supported",
      },
      unsupportedLimitation: "unsupported-mkdocs-adapter",
      validationFallback: null,
    },
    docusaurus: {
      adapterId: "docusaurus",
      adapterVersion: DOCUMENTATION_SOURCE_ADAPTER_VERSION,
      configurationLocations: [
        ...MODULE_EXTENSIONS.map((extension) => `docusaurus.config.${extension}`),
        ...DOCUSAURUS_SIDEBAR_LOCATIONS,
      ],
      navigationLocations: DOCUSAURUS_SIDEBAR_LOCATIONS,
      supportedExtensions: [".md", ".mdx"],
      packageDependencies: ["@docusaurus/core"],
      capabilities: {
        detect: "supported",
        navigation: "partial",
        routes: "partial",
        versions: "unsupported",
        includes: "unsupported",
        components: "partial",
        frontmatter: "partial",
        validate: "supported",
      },
      unsupportedLimitation: "unsupported-docusaurus-adapter",
      validationFallback: null,
    },
    sphinx: {
      adapterId: "sphinx",
      adapterVersion: DOCUMENTATION_SOURCE_ADAPTER_VERSION,
      configurationLocations: ["conf.py", "docs/conf.py"],
      // Sphinx navigation is the toctree of the root document, not a configuration file.
      navigationLocations: [],
      supportedExtensions: [".md", ".rst"],
      packageDependencies: ["sphinx"],
      capabilities: {
        detect: "supported",
        navigation: "partial",
        routes: "unsupported",
        versions: "unsupported",
        includes: "partial",
        components: "unsupported",
        frontmatter: "unsupported",
        validate: "supported",
      },
      unsupportedLimitation: "unsupported-sphinx-adapter",
      validationFallback: null,
    },
    fern: {
      adapterId: "fern",
      adapterVersion: DOCUMENTATION_SOURCE_ADAPTER_VERSION,
      configurationLocations: ["fern/docs.yaml", "fern/docs.yml"],
      navigationLocations: ["fern/docs.yaml", "fern/docs.yml"],
      supportedExtensions: [".md", ".mdx"],
      packageDependencies: [],
      capabilities: {
        detect: "supported",
        navigation: "supported",
        routes: "supported",
        versions: "supported",
        includes: "partial",
        components: "partial",
        frontmatter: "partial",
        validate: "supported",
      },
      unsupportedLimitation: "unsupported-relevant-configuration",
      validationFallback: null,
    },
    "jupyter-book": {
      adapterId: "jupyter-book",
      adapterVersion: DOCUMENTATION_SOURCE_ADAPTER_VERSION,
      // `_config.yml` cannot identify a book: Jekyll sites use the same name.
      configurationLocations: ["_toc.yaml", "_toc.yml"],
      navigationLocations: ["_toc.yaml", "_toc.yml"],
      supportedExtensions: [".md"],
      packageDependencies: ["jupyter-book"],
      capabilities: {
        detect: "supported",
        navigation: "partial",
        routes: "unsupported",
        versions: "unsupported",
        includes: "unsupported",
        components: "unsupported",
        frontmatter: "unsupported",
        // Links and folders are checked as plain Markdown; the table of contents is not.
        validate: "partial",
      },
      unsupportedLimitation: "unsupported-jupyter-book-adapter",
      validationFallback: { adapterId: "plain-markdown", limitation: "navigation-not-checked" },
    },
  });

/** Generators repository inventory names although no source adapter reads them. */
export const DOCUMENTATION_GENERATORS_WITHOUT_ADAPTER: Readonly<
  Record<
    string,
    Readonly<{ configurationLocations: readonly string[]; packageDependencies: readonly string[] }>
  >
> = deepFreeze({
  vitepress: {
    configurationLocations: MODULE_EXTENSIONS.flatMap((extension) => [
      `.vitepress/config.${extension}`,
      `vitepress.config.${extension}`,
    ]).sort(),
    packageDependencies: ["vitepress"],
  },
});

/** Every adapter configuration location, in the byte order applicability records require. */
export const DOCUMENTATION_SOURCE_CONFIGURATION_LOCATIONS: readonly string[] = deepFreeze(
  DOCUMENTATION_SOURCE_ADAPTER_IDS.flatMap((id) => ADAPTERS[id].configurationLocations).sort(),
);

/** The markup extensions at least one adapter reads. */
export const DOCUMENTATION_SOURCE_MARKUP_EXTENSIONS: readonly string[] = deepFreeze(
  [
    ...new Set(DOCUMENTATION_SOURCE_ADAPTER_IDS.flatMap((id) => ADAPTERS[id].supportedExtensions)),
  ].sort(),
);

export function resolveDocumentationSourceAdapter(
  adapterId: DocumentationSourceAdapterId,
): DocumentationSourceAdapterSupport {
  return ADAPTERS[adapterId];
}

export function documentationSourceAdapterForConfiguration(
  path: string,
): DocumentationSourceAdapterId | undefined {
  const normalized = canonicalDocumentationSourcePath(path);
  for (const adapterId of DOCUMENTATION_SOURCE_ADAPTER_IDS) {
    if (ADAPTERS[adapterId].configurationLocations.includes(normalized)) return adapterId;
  }
  return undefined;
}

export function isDocumentationSourceConfigurationPath(path: string): boolean {
  const normalized = canonicalDocumentationSourcePath(path);
  const parts = normalized.split("/");
  const rootRelative =
    parts[0] === "packages" && parts.length > 2 ? parts.slice(2).join("/") : normalized;
  return documentationSourceAdapterForConfiguration(rootRelative) !== undefined;
}

/**
 * Name the generator that a repository-root configuration path identifies,
 * ignoring case, including generators without a source adapter.
 */
export function documentationGeneratorForConfigurationPath(path: string): string | undefined {
  const normalized = path.toLowerCase();
  for (const adapterId of DOCUMENTATION_SOURCE_ADAPTER_IDS)
    if (ADAPTERS[adapterId].configurationLocations.includes(normalized)) return adapterId;
  for (const [generator, entry] of Object.entries(DOCUMENTATION_GENERATORS_WITHOUT_ADAPTER))
    if (entry.configurationLocations.includes(normalized)) return generator;
  return undefined;
}

/** Name the generator that a package manifest dependency identifies. */
export function documentationGeneratorForPackageDependency(name: string): string | undefined {
  for (const adapterId of DOCUMENTATION_SOURCE_ADAPTER_IDS)
    if (ADAPTERS[adapterId].packageDependencies.includes(name)) return adapterId;
  for (const [generator, entry] of Object.entries(DOCUMENTATION_GENERATORS_WITHOUT_ADAPTER))
    if (entry.packageDependencies.includes(name)) return generator;
  return undefined;
}

export function documentationSourceLimitationForAdapter(
  adapterId: DocumentationSourceAdapterId,
): DocumentationSourceLimitationCode | undefined {
  const adapter = ADAPTERS[adapterId];
  if (adapter.capabilities.validate === "unsupported") return adapter.unsupportedLimitation;
  if (adapter.capabilities.validate === "partial") return adapter.validationFallback?.limitation;
  return undefined;
}

/** The adapter whose structural checks validate a root this adapter owns. */
export function documentationSourceValidationAdapter(
  adapterId: DocumentationSourceAdapterId,
): DocumentationSourceAdapterId {
  return ADAPTERS[adapterId].validationFallback?.adapterId ?? adapterId;
}

export function isBlockingDocumentationSourceLimitation(
  code: DocumentationSourceLimitationCode,
): boolean {
  return !(DOCUMENTATION_SOURCE_ADVISORY_LIMITATION_CODES as readonly string[]).includes(code);
}

export function isDocumentationMarkupPath(path: string): boolean {
  const normalized = canonicalDocumentationSourcePath(path).toLowerCase();
  return DOCUMENTATION_SOURCE_MARKUP_EXTENSIONS.some((extension) => normalized.endsWith(extension));
}

export function isCanonicalDocumentationSourcePath(path: unknown): path is string {
  return (
    typeof path === "string" &&
    path !== "" &&
    path === path.normalize("NFC") &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    path.split("/").every((part) => part !== "" && part !== "." && part !== "..") &&
    posix.normalize(path) === path
  );
}

export function canonicalDocumentationSourcePath(path: string): string {
  if (!isCanonicalDocumentationSourcePath(path))
    throw new TypeError("Documentation source paths must be canonical repository-relative paths.");
  return path;
}

/** Extract bounded local CommonMark/MDX link targets outside literal code. */
export function documentationMarkdownLinkTargets(source: string): readonly string[] {
  const visible = maskMarkdownLiteralContent(source);
  const definitions = new Map<string, string>();
  const targets: string[] = [];
  for (const match of visible.matchAll(REFERENCE_DEFINITION)) {
    const label = match[1]?.trim().toLowerCase();
    const target = match[2] ?? match[3];
    if (label && target !== undefined) definitions.set(label, target);
  }
  for (const match of visible.matchAll(INLINE_LINK)) {
    const target = match[1];
    if (target !== undefined && !externalTarget(target)) targets.push(target);
  }
  for (const match of visible.matchAll(REFERENCE_LINK)) {
    const target = definitions.get((match[1] ?? "").trim().toLowerCase());
    if (target !== undefined && !externalTarget(target)) targets.push(target);
  }
  for (const target of definitions.values()) if (!externalTarget(target)) targets.push(target);
  for (const target of inspectDocumentationMdxCards(visible).targets)
    if (!externalTarget(target)) targets.push(target);
  return Object.freeze([...new Set(targets)]);
}

/** Extract the finite CommonMark and explicit anchors used by structural validation. */
export function documentationMarkdownAnchors(source: string): readonly string[] {
  const structuralSource = maskMarkdownHtmlComments(
    maskMarkdownFencedContent(maskMarkdownFrontmatter(source)),
  );
  const lines = structuralSource.split(/\r?\n/u);
  const literalMaskedSource = maskInlineCodeSpans(structuralSource);
  const anchors = new Set<string>();
  const headingAnchors = new Set<string>();
  const paragraph: string[] = [];
  for (const anchor of documentationHtmlAnchors(literalMaskedSource)) anchors.add(anchor);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (/^(?: {4}|\t)/u.test(line)) {
      paragraph.length = 0;
      continue;
    }
    const atx = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/u.exec(line);
    if (atx?.[2]) {
      addDocumentationHeadingAnchor(anchors, headingAnchors, atx[2]);
      paragraph.length = 0;
      continue;
    }
    if (/^ {0,3}(?:=+|-+)\s*$/u.test(line)) {
      if (paragraph.length > 0)
        addDocumentationHeadingAnchor(anchors, headingAnchors, paragraph.join(" "));
      paragraph.length = 0;
      continue;
    }
    if (paragraph.length === 0 && REFERENCE_DEFINITION_LINE.test(line)) continue;
    if (!line.trim() || documentationMarkdownBlockBoundary(line)) paragraph.length = 0;
    else paragraph.push(line.trim());
  }
  return Object.freeze([...anchors]);
}

/** Normalize a link fragment with the DocsFab heading-anchor convention. */
export function normalizeDocumentationMarkdownAnchor(value: string): string {
  return value
    .normalize("NFC")
    .toLowerCase()
    .replace(/<[^>]+>/gu, "")
    .replace(/[`*_~]/gu, "")
    .replace(/[^\p{Letter}\p{Number}\s_-]/gu, "")
    .trim()
    .replace(/[\s_]+/gu, "-")
    .replace(/-+/gu, "-");
}

export type DocumentationMdxCardIssue =
  | "incomplete-opening-tag"
  | "unsupported-attribute-expression"
  | "unsupported-expression-delimiter"
  | "invalid-href-cardinality"
  | "invalid-static-href";

/** Parse the same bounded static Card href subset used by validation and closure derivation. */
export function inspectDocumentationMdxCards(source: string): Readonly<{
  targets: readonly string[];
  issues: readonly DocumentationMdxCardIssue[];
}> {
  const { tags, issues: parseIssues } = mdxCardOpeningTags(source);
  const targets: string[] = [];
  const issues: DocumentationMdxCardIssue[] = [...parseIssues];
  for (const card of tags) {
    const masked = maskCardQuotedValues(card);
    const hrefAttributes = [...masked.matchAll(CARD_HREF_ATTRIBUTE)];
    if (hrefAttributes.length !== 1) {
      issues.push("invalid-href-cardinality");
      continue;
    }
    const attribute = hrefAttributes[0];
    const nameOffset = (attribute?.index ?? 0) + (attribute?.[0].indexOf("href") ?? 0);
    const href = STATIC_CARD_HREF.exec(card.slice(nameOffset));
    const target = href?.[1] ?? href?.[2];
    if (target === undefined || target === "") issues.push("invalid-static-href");
    else targets.push(target);
  }
  return Object.freeze({ targets: Object.freeze(targets), issues: Object.freeze(issues) });
}

export function fernCanonicalTargets(source: string): string[] {
  return [...source.matchAll(/^\s*canonical:\s*['"]?([^\s'"#]+)['"]?/gmu)]
    .map((match) => match[1])
    .filter((value): value is string => Boolean(value));
}

/** Build route aliases from page targets in a sealed Fern navigation candidate. */
export async function fernRouteAliases(
  root: string,
  navigationPath: string,
  targets: readonly FernNavigationTarget[],
  prefixes: readonly string[],
) {
  const routes = new Map<string, string>();
  const conflicts = new Set<string>();
  for (const target of targets) {
    const absolute = resolve(dirname(navigationPath), target.path);
    let expanded = [absolute];
    try {
      if ((await readdir(absolute, { withFileTypes: true })).length > 0)
        expanded = await markdownFiles(absolute);
    } catch {
      /* target validation reports missing folders */
    }
    for (const targetAbsolute of expanded) {
      const relativePath = targetAbsolute.startsWith(`${root}/`)
        ? targetAbsolute.slice(root.length + 1)
        : "";
      if (!relativePath) continue;
      const explicitPage = target.routeSegments
        ? explicitRoutePage(absolute, targetAbsolute, target.routeSegments, target.folder)
        : undefined;
      const page =
        explicitPage ??
        relativePath
          .replace(/^(?:docs|fern\/pages)\//u, "")
          .replace(/(?:\/(?:_)?index)?\.mdx?$/u, "");
      for (const prefix of prefixes) {
        const routePage = page.startsWith(`${prefix.slice(1)}/`) ? page.slice(prefix.length) : page;
        const route = `${prefix}/${routePage}`.replaceAll("//", "/");
        const previous = routes.get(route);
        if (previous && previous !== targetAbsolute) conflicts.add(route);
        routes.set(route, targetAbsolute);
      }
    }
  }
  return { routes, conflicts };
}

/** Mask fenced and inline code while preserving offsets and line endings. */
export function maskMarkdownLiteralContent(source: string): string {
  return maskInlineCodeSpans(maskMarkdownFencedContent(source));
}

function maskMarkdownFencedContent(source: string): string {
  const lines = source.split(/(?<=\n)/u);
  let fence: { marker: "`" | "~"; length: number } | undefined;
  return lines
    .map((line) => {
      const opening = /^ {0,3}(`{3,}|~{3,})/u.exec(line);
      if (!fence && opening?.[1]) {
        fence = { marker: opening[1][0] as "`" | "~", length: opening[1].length };
        return line.replace(/[^\r\n]/gu, " ");
      }
      if (fence) {
        const closing = new RegExp(`^ {0,3}${fence.marker}{${fence.length},}\\s*$`, "u").test(
          line.replace(/\r?\n$/u, ""),
        );
        if (closing) fence = undefined;
        return line.replace(/[^\r\n]/gu, " ");
      }
      return line;
    })
    .join("");
}

function maskMarkdownFrontmatter(source: string): string {
  const lines = source.split(/(?<=\n)/u);
  if ((lines[0] ?? "").replace(/\r?\n$/u, "").trim() !== "---") return source;
  const closing = lines
    .slice(1)
    .findIndex((line) => /^(?:---|\.\.\.)\s*$/u.test(line.replace(/\r?\n$/u, "")));
  if (closing < 0) return source;
  return lines
    .map((line, index) => (index <= closing + 1 ? line.replace(/[^\r\n]/gu, " ") : line))
    .join("");
}

function maskMarkdownHtmlComments(source: string): string {
  return source.replace(/<!--[\s\S]*?(?:-->|$)/gu, (comment) => comment.replace(/[^\r\n]/gu, " "));
}

function documentationHtmlAnchors(source: string): string[] {
  const anchors: string[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    const start = source.indexOf("<a", cursor);
    if (start < 0) break;
    const boundary = source[start + 2];
    if (boundary !== undefined && !/[\s/>]/u.test(boundary)) {
      cursor = start + 2;
      continue;
    }
    const lineStart = source.lastIndexOf("\n", start - 1) + 1;
    if (/^(?: {4}|\t)/u.test(source.slice(lineStart, start))) {
      cursor = start + 2;
      continue;
    }
    let quote: '"' | "'" | undefined;
    let end = -1;
    const limit = Math.min(source.length, start + MAX_HTML_ANCHOR_TAG_LENGTH);
    for (let index = start + 2; index < limit; index += 1) {
      const character = source[index];
      if (quote) {
        if (character === quote) quote = undefined;
        continue;
      }
      if (character === '"' || character === "'") {
        quote = character;
        continue;
      }
      if (character === ">") {
        end = index;
        break;
      }
    }
    if (end < 0 || quote) break;
    anchors.push(...htmlAnchorAttributeValues(source.slice(start + 2, end)));
    cursor = end + 1;
  }
  return anchors;
}

function htmlAnchorAttributeValues(attributes: string): string[] {
  const anchors: string[] = [];
  const anchorAttributes = new Set<string>();
  let cursor = 0;
  while (cursor < attributes.length) {
    while (/\s/u.test(attributes[cursor] ?? "")) cursor += 1;
    if (cursor >= attributes.length) break;
    if (attributes[cursor] === "/")
      return staticHtmlAnchorSelfClosingSuffix(attributes, cursor) ? anchors : [];
    if (attributes[cursor] === "{" || attributes[cursor] === "}") return [];
    const start = cursor;
    while (cursor < attributes.length && !/[\s=/>]/u.test(attributes[cursor] ?? "")) cursor += 1;
    const name = attributes.slice(start, cursor).toLowerCase();
    if (!name || name.includes("{") || name.includes("}")) return [];
    if (name === "id" || name === "name") {
      if (anchorAttributes.has(name)) return [];
      anchorAttributes.add(name);
    }
    while (/\s/u.test(attributes[cursor] ?? "")) cursor += 1;
    if (attributes[cursor] !== "=") continue;
    cursor += 1;
    while (/\s/u.test(attributes[cursor] ?? "")) cursor += 1;
    if (attributes[cursor] === "{" || attributes[cursor] === "}") return [];
    const quote =
      attributes[cursor] === '"' || attributes[cursor] === "'" ? attributes[cursor] : undefined;
    if (quote) cursor += 1;
    const valueStart = cursor;
    if (quote) while (cursor < attributes.length && attributes[cursor] !== quote) cursor += 1;
    else
      while (cursor < attributes.length && !/[\s/>]/u.test(attributes[cursor] ?? "")) cursor += 1;
    const value = attributes.slice(valueStart, cursor).normalize("NFC");
    if (!quote && (value.includes("{") || value.includes("}"))) return [];
    if (quote && attributes[cursor] === quote) cursor += 1;
    if (quote && (name === "id" || name === "name") && value) anchors.push(value);
  }
  return anchors;
}

function staticHtmlAnchorSelfClosingSuffix(attributes: string, slash: number): boolean {
  for (let cursor = slash + 1; cursor < attributes.length; cursor += 1)
    if (!/\s/u.test(attributes[cursor] ?? "")) return false;
  return true;
}

function documentationMarkdownBlockBoundary(line: string): boolean {
  return (
    /^ {0,3}(?:>|[-+*]\s+|\d+[.)]\s+|<)/u.test(line) ||
    /^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/u.test(line)
  );
}

function addDocumentationHeadingAnchor(
  anchors: Set<string>,
  headingAnchors: Set<string>,
  value: string,
): void {
  const requested = normalizeDocumentationMarkdownAnchor(value);
  if (!requested) return;
  let anchor = requested;
  let suffix = 1;
  while (headingAnchors.has(anchor)) anchor = `${requested}-${suffix++}`;
  headingAnchors.add(anchor);
  anchors.add(anchor);
}

function maskInlineCodeSpans(source: string): string {
  const characters = source.split("");
  let cursor = 0;
  while (cursor < source.length) {
    if (source[cursor] !== "`") {
      cursor += 1;
      continue;
    }
    let openingEnd = cursor;
    while (source[openingEnd] === "`") openingEnd += 1;
    const delimiterLength = openingEnd - cursor;
    let search = openingEnd;
    let closingEnd: number | undefined;
    while (search < source.length) {
      const start = source.indexOf("`", search);
      if (start < 0) break;
      let end = start;
      while (source[end] === "`") end += 1;
      if (end - start === delimiterLength) {
        closingEnd = end;
        break;
      }
      search = end;
    }
    if (closingEnd === undefined) {
      cursor = openingEnd;
      continue;
    }
    for (let index = cursor; index < closingEnd; index += 1)
      if (characters[index] !== "\r" && characters[index] !== "\n") characters[index] = " ";
    cursor = closingEnd;
  }
  return characters.join("");
}

function externalTarget(target: string): boolean {
  return /^(?:https?:|mailto:|tel:)/iu.test(target);
}

function mdxCardOpeningTags(source: string): {
  tags: string[];
  issues: DocumentationMdxCardIssue[];
} {
  const tags: string[] = [];
  const issues: DocumentationMdxCardIssue[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    const start = source.indexOf("<Card", cursor);
    if (start < 0) break;
    const boundary = source[start + "<Card".length];
    if (boundary !== undefined && !/[\s/>]/u.test(boundary)) {
      cursor = start + "<Card".length;
      continue;
    }
    let quote: '"' | "'" | undefined;
    let escaped = false;
    let end = -1;
    const limit = Math.min(source.length, start + MAX_CARD_OPENING_TAG_LENGTH);
    for (let index = start + "<Card".length; index < limit; index += 1) {
      const character = source[index];
      if (quote) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === quote) quote = undefined;
        continue;
      }
      if (character === '"' || character === "'") {
        quote = character;
        continue;
      }
      if (character === "{") {
        issues.push("unsupported-attribute-expression");
        end = index;
        break;
      }
      if (character === "}") {
        issues.push("unsupported-expression-delimiter");
        end = index;
        break;
      }
      if (character === ">") {
        end = index;
        break;
      }
    }
    if (end < 0 || quote) {
      issues.push("incomplete-opening-tag");
      return { tags, issues };
    }
    if (source[end] !== ">") {
      cursor = end + 1;
      continue;
    }
    tags.push(source.slice(start, end + 1));
    cursor = end + 1;
  }
  return { tags, issues };
}

function maskCardQuotedValues(card: string): string {
  const characters = card.split("");
  let quote: '"' | "'" | undefined;
  let escaped = false;
  for (let index = "<Card".length; index < characters.length; index += 1) {
    const character = characters[index];
    if (quote) {
      characters[index] = " ";
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      characters[index] = " ";
    }
  }
  return characters.join("");
}

function routeSlug(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^(?:[A-Za-z0-9][A-Za-z0-9_-]*)?$/u.test(value.trim()))
    throw new FernStructuralParseError(`${field} must use one supported scalar route segment.`);
  return value.trim();
}

function explicitRoutePage(
  targetRoot: string,
  targetAbsolute: string,
  routeSegments: readonly string[],
  folder: boolean,
): string {
  if (!folder) return routeSegments.join("/");
  const descendant = relative(targetRoot, targetAbsolute).replaceAll("\\", "/");
  const suffix = descendant
    .replace(/(?:^|\/)(?:_)?index\.mdx?$/u, "")
    .replace(/\.mdx?$/u, "")
    .split("/")
    .filter(Boolean)
    .map((segment) => routeSlug(segment, "Fern folder descendant route"));
  return [...routeSegments, ...suffix].join("/");
}

async function markdownFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await markdownFiles(path)));
    else if (/\.mdx?$/u.test(entry.name)) files.push(path);
  }
  return files.length > 0 ? files : [directory];
}
