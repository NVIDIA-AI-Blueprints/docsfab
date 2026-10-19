// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Confined WordprocessingML (.docx) block-evidence adapter: no DOM, script,
 * filesystem, network, or subprocess. It hand-rolls a minimal ZIP reader
 * (`node:zlib` for in-memory DEFLATE only) and parses XML with pinned
 * `fast-xml-parser`, entities disabled and nesting bounded. Policy lives in
 * `docs/reference/contracts/docx-evidence.md`.
 *
 * The main part is resolved through the `_rels/.rels` `officeDocument` target
 * and must be declared as the main document in `[Content_Types].xml`; it is
 * never read from a hardcoded path.
 *
 * `docx-block` locators:
 * - Body paragraph: `blockPath` is `[bodyBlockOrdinal]`, counting only body
 *   `w:p`/`w:tbl` children. `paragraphOrdinal` counts body paragraphs only.
 * - Table cell: its paragraphs joined with `"\n"`, `blockPath`
 *   `[tableBodyOrdinal, row, cell]`, `tableCell` `{row, column}`,
 *   `paragraphOrdinal` `null`. Merged cells are not resolved; nested tables are
 *   not extracted and add `unsupported-structure`.
 * - `part` is the resolved main part. Headers, footers, notes, and comments are
 *   not read; their presence adds `unsupported-structure`.
 *
 * Elements match by namespace URI and local name, not the literal `w:` prefix.
 * `w:ins`/`w:moveTo` are read and `w:del`/`w:moveFrom` excluded, and all four
 * add `unsupported-structure` because tracked-change semantics are not
 * resolved. Hidden runs add `hidden-content-excluded`. `w:altChunk` and
 * foreign-namespace elements (such as `mc:AlternateContent`) are never opened
 * and add `unsupported-structure`.
 */
import { inflateRawSync } from "node:zlib";

import { XMLParser, XMLValidator } from "fast-xml-parser";

import type {
  SourceExtractionRequestV1,
  SourceExtractionResultV1,
  SourceExtractionSegmentV1,
  SourceExtractorAdapterV1,
} from "../source-extraction.js";
import type { SourceRepresentationLimitation, SourceSpanLocatorV1 } from "../source-evidence.js";

export const DOCX_SOURCE_EXTRACTOR_ID = "docsfab-docx-block" as const;
export const DOCX_SOURCE_EXTRACTOR_VERSION = "1" as const;
export const DOCX_MEDIA_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document" as const;

const CONTENT_TYPES_PART = "[Content_Types].xml";
const ROOT_RELS_PART = "_rels/.rels";
const MACRO_PART = "word/vbaProject.bin";
const OFFICE_DOCUMENT_RELATIONSHIP_TYPE =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument";
const MAIN_DOCUMENT_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";

const WORDPROCESSINGML_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const PACKAGE_RELATIONSHIPS_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const CONTENT_TYPES_NS = "http://schemas.openxmlformats.org/package/2006/content-types";

/** Other WordprocessingML "stories" this adapter never reads. */
const STORY_PART_PATTERN = /^word\/(header|footer|footnotes|endnotes|comments)[0-9]*\.xml$/u;

/**
 * Assertion marker. The parser never expands entities (`processEntities: false`);
 * this module decodes only the predefined and numeric references itself. Any
 * `<!DOCTYPE` or `<!ENTITY` is refused by a scan before parsing.
 */
export const DOCX_XML_SECURITY_POLICY = Object.freeze({
  resolveExternalEntities: false,
  loadExternalDtd: false,
});

interface DocxExtractionOptions {
  maxArchiveEntries: number;
  maxExpandedBytes: number;
  maxXmlDepth: number;
  maxXmlNodes: number;
}

const DEFAULT_OPTIONS: Readonly<DocxExtractionOptions> = Object.freeze({
  maxArchiveEntries: 2_000,
  maxExpandedBytes: 64 * 1024 * 1024,
  maxXmlDepth: 64,
  maxXmlNodes: 200_000,
});

function resolveOptions(options: Readonly<Record<string, unknown>>): DocxExtractionOptions {
  const positiveFinite = (value: unknown, fallback: number): number =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
  return {
    maxArchiveEntries: positiveFinite(options.maxArchiveEntries, DEFAULT_OPTIONS.maxArchiveEntries),
    maxExpandedBytes: positiveFinite(options.maxExpandedBytes, DEFAULT_OPTIONS.maxExpandedBytes),
    maxXmlDepth: positiveFinite(options.maxXmlDepth, DEFAULT_OPTIONS.maxXmlDepth),
    maxXmlNodes: positiveFinite(options.maxXmlNodes, DEFAULT_OPTIONS.maxXmlNodes),
  };
}

// Minimal ZIP central-directory reader, hand-rolled rather than a dependency
// (see the contract doc). It guards archive bombs, lying sizes, truncated
// directories, ZIP64, entry counts, local/central name disagreement, and
// case-insensitive duplicate names.

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const LOCAL_FILE_HEADER_SIZE = 30;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const CENTRAL_DIRECTORY_ENTRY_SIZE = 46;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const END_OF_CENTRAL_DIRECTORY_MIN_SIZE = 22;
const MAX_ZIP_COMMENT_BYTES = 65_535;

interface EndOfCentralDirectory {
  totalEntries: number;
  centralDirectorySize: number;
  centralDirectoryOffset: number;
}

function findEndOfCentralDirectory(buf: Buffer): EndOfCentralDirectory | null {
  const scanStart = Math.max(
    0,
    buf.length - (END_OF_CENTRAL_DIRECTORY_MIN_SIZE + MAX_ZIP_COMMENT_BYTES),
  );
  for (let index = buf.length - END_OF_CENTRAL_DIRECTORY_MIN_SIZE; index >= scanStart; index -= 1) {
    if (buf.readUInt32LE(index) !== END_OF_CENTRAL_DIRECTORY_SIGNATURE) continue;
    const commentLength = buf.readUInt16LE(index + 20);
    if (index + END_OF_CENTRAL_DIRECTORY_MIN_SIZE + commentLength !== buf.length) continue;
    return {
      totalEntries: buf.readUInt16LE(index + 10),
      centralDirectorySize: buf.readUInt32LE(index + 12),
      centralDirectoryOffset: buf.readUInt32LE(index + 16),
    };
  }
  return null;
}

interface ZipCentralEntry {
  name: string;
  generalPurposeFlag: number;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  externalAttrs: number;
  localHeaderOffset: number;
}

function readCentralDirectory(buf: Buffer, eocd: EndOfCentralDirectory): ZipCentralEntry[] | null {
  const entries: ZipCentralEntry[] = [];
  let offset = eocd.centralDirectoryOffset;
  const end = eocd.centralDirectoryOffset + eocd.centralDirectorySize;
  if (end > buf.length) return null;
  for (let count = 0; count < eocd.totalEntries; count += 1) {
    if (offset + CENTRAL_DIRECTORY_ENTRY_SIZE > end) return null;
    if (buf.readUInt32LE(offset) !== CENTRAL_DIRECTORY_SIGNATURE) return null;
    const generalPurposeFlag = buf.readUInt16LE(offset + 8);
    const compressionMethod = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const uncompressedSize = buf.readUInt32LE(offset + 24);
    const nameLength = buf.readUInt16LE(offset + 28);
    const extraLength = buf.readUInt16LE(offset + 30);
    const commentLength = buf.readUInt16LE(offset + 32);
    const externalAttrs = buf.readUInt32LE(offset + 38);
    const localHeaderOffset = buf.readUInt32LE(offset + 42);
    const nameStart = offset + CENTRAL_DIRECTORY_ENTRY_SIZE;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > end) return null;
    const name = buf.toString("utf8", nameStart, nameEnd);
    entries.push({
      name,
      generalPurposeFlag,
      compressionMethod,
      compressedSize,
      uncompressedSize,
      externalAttrs,
      localHeaderOffset,
    });
    offset = nameEnd + extraLength + commentLength;
  }
  return entries;
}

function isEncryptedEntry(generalPurposeFlag: number): boolean {
  return (generalPurposeFlag & 0x1) !== 0;
}

function isSymlinkEntry(externalAttrs: number): boolean {
  return ((externalAttrs >>> 16) & 0xf000) === 0xa000;
}

function isDirectoryEntryName(name: string): boolean {
  return name.endsWith("/");
}

/** Reject an absolute path, a traversal segment, or a backslash separator. */
function isSafePartName(name: string, allowTrailingSlash: boolean): boolean {
  if (name.length === 0) return false;
  if (name.includes("\\")) return false;
  if (name.startsWith("/")) return false;
  const body = allowTrailingSlash && name.endsWith("/") ? name.slice(0, -1) : name;
  if (body.length === 0) return false;
  return body
    .split("/")
    .every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

/**
 * Returns one entry's decompressed bytes, or null when the local header is out
 * of range or has a bad signature, the local and central names disagree (a
 * parser-confusion vector), the data runs past the buffer, the size exceeds the
 * budget, a stored entry's sizes disagree, the compression method is
 * unsupported, or decompression fails.
 */
function readEntryBytes(
  buf: Buffer,
  entry: ZipCentralEntry,
  maxExpandedBytes: number,
): Buffer | null {
  const headerOffset = entry.localHeaderOffset;
  if (headerOffset + LOCAL_FILE_HEADER_SIZE > buf.length) return null;
  if (buf.readUInt32LE(headerOffset) !== LOCAL_FILE_HEADER_SIGNATURE) return null;
  const nameLength = buf.readUInt16LE(headerOffset + 26);
  const extraLength = buf.readUInt16LE(headerOffset + 28);
  const localNameStart = headerOffset + LOCAL_FILE_HEADER_SIZE;
  const localNameEnd = localNameStart + nameLength;
  if (localNameEnd > buf.length) return null;
  const localName = buf.toString("utf8", localNameStart, localNameEnd);
  if (localName !== entry.name) return null;
  const dataStart = localNameEnd + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > buf.length) return null;
  const data = buf.subarray(dataStart, dataEnd);
  if (entry.uncompressedSize > maxExpandedBytes) return null;
  let result: Buffer | null = null;
  if (entry.compressionMethod === 0) {
    if (entry.compressedSize !== entry.uncompressedSize) return null;
    result = Buffer.from(data);
  } else if (entry.compressionMethod === 8) {
    try {
      // Bounds actual output regardless of the attacker-controlled declared size.
      result = inflateRawSync(data, { maxOutputLength: maxExpandedBytes });
    } catch {
      return null;
    }
  } else {
    return null;
  }
  // Defense in depth: do not trust `maxOutputLength` alone.
  if (result.byteLength > maxExpandedBytes) return null;
  return result;
}

export type DocxPackageReasonCode =
  | "eocd-not-found"
  | "zip64-unsupported"
  | "too-many-entries"
  | "central-directory-malformed"
  | "encrypted"
  | "unsafe-path"
  | "symlink"
  | "duplicate-part"
  | "macro-enabled"
  | "root-relationships-missing"
  | "root-relationships-unreadable"
  | "root-relationships-malformed"
  | "main-relationship-missing"
  | "main-relationship-ambiguous"
  | "main-relationship-external"
  | "main-part-unsafe-path"
  | "main-part-missing"
  | "content-types-missing"
  | "content-types-unreadable"
  | "content-types-malformed"
  | "content-type-mismatch"
  | "expansion-failed";

interface ResolvedDocxPackage {
  documentPart: string;
  documentBytes: Buffer;
  hasOmittedStories: boolean;
}

type DocxPackageResult =
  | { ok: true; value: ResolvedDocxPackage }
  | { ok: false; reasonCode: DocxPackageReasonCode };

/** Normalize a package-relative or `/`-rooted relationship target. */
function normalizePackageTarget(target: string): string | null {
  const relative = target.startsWith("/") ? target.slice(1) : target;
  if (!isSafePartName(relative, false)) return null;
  return relative;
}

function readDocxPackage(buf: Buffer, options: DocxExtractionOptions): DocxPackageResult {
  const eocd = findEndOfCentralDirectory(buf);
  if (!eocd) return { ok: false, reasonCode: "eocd-not-found" };
  if (
    eocd.totalEntries === 0xffff ||
    eocd.centralDirectoryOffset === 0xffffffff ||
    eocd.centralDirectorySize === 0xffffffff
  ) {
    return { ok: false, reasonCode: "zip64-unsupported" };
  }
  if (eocd.totalEntries > options.maxArchiveEntries) {
    return { ok: false, reasonCode: "too-many-entries" };
  }
  const entries = readCentralDirectory(buf, eocd);
  if (!entries) return { ok: false, reasonCode: "central-directory-malformed" };

  const seenNames = new Set<string>();
  const seenNamesCaseInsensitive = new Set<string>();
  const byName = new Map<string, ZipCentralEntry>();
  let hasMacro = false;
  let hasOmittedStories = false;
  for (const entry of entries) {
    if (isEncryptedEntry(entry.generalPurposeFlag)) return { ok: false, reasonCode: "encrypted" };
    const directory = isDirectoryEntryName(entry.name);
    if (!isSafePartName(entry.name, directory)) return { ok: false, reasonCode: "unsafe-path" };
    if (directory) continue;
    if (isSymlinkEntry(entry.externalAttrs)) return { ok: false, reasonCode: "symlink" };
    if (seenNames.has(entry.name)) return { ok: false, reasonCode: "duplicate-part" };
    const lower = entry.name.toLowerCase();
    if (seenNamesCaseInsensitive.has(lower)) return { ok: false, reasonCode: "duplicate-part" };
    seenNames.add(entry.name);
    seenNamesCaseInsensitive.add(lower);
    byName.set(entry.name, entry);
    if (entry.name === MACRO_PART) hasMacro = true;
    else if (STORY_PART_PATTERN.test(entry.name)) hasOmittedStories = true;
  }
  if (hasMacro) return { ok: false, reasonCode: "macro-enabled" };

  // Resolve the main document part from _rels/.rels, never a hardcoded path.
  const rootRelsEntry = byName.get(ROOT_RELS_PART);
  if (!rootRelsEntry) return { ok: false, reasonCode: "root-relationships-missing" };
  const rootRelsBytes = readEntryBytes(buf, rootRelsEntry, options.maxExpandedBytes);
  if (!rootRelsBytes) return { ok: false, reasonCode: "root-relationships-unreadable" };
  const rootRelsXml = decodeXmlPart(rootRelsBytes);
  const rootRelsParsed = parseXmlSafely(rootRelsXml, options);
  if (rootRelsParsed.rejected || !rootRelsParsed.root) {
    return { ok: false, reasonCode: "root-relationships-malformed" };
  }
  const rootRelsResolved = resolveDocument(rootRelsParsed.root, options.maxXmlNodes);
  if (rootRelsResolved.nodeBudgetExceeded || !rootRelsResolved.root) {
    return { ok: false, reasonCode: "root-relationships-malformed" };
  }
  // `<Relationships>` is the root element itself, not a child of it.
  const relationshipsRoot =
    rootRelsResolved.root.uri === PACKAGE_RELATIONSHIPS_NS &&
    rootRelsResolved.root.local === "Relationships"
      ? rootRelsResolved.root
      : null;
  const relationships = relationshipsRoot
    ? findNsChildren(relationshipsRoot, PACKAGE_RELATIONSHIPS_NS, "Relationship")
    : [];
  const officeDocumentRelationships = relationships.filter(
    (rel) => rel.attrs.get("Type") === OFFICE_DOCUMENT_RELATIONSHIP_TYPE,
  );
  if (officeDocumentRelationships.length === 0) {
    return { ok: false, reasonCode: "main-relationship-missing" };
  }
  if (officeDocumentRelationships.length > 1) {
    return { ok: false, reasonCode: "main-relationship-ambiguous" };
  }
  const mainRelationship = officeDocumentRelationships[0]!;
  // An external target is never a valid main document part.
  if (mainRelationship.attrs.get("TargetMode") === "External") {
    return { ok: false, reasonCode: "main-relationship-external" };
  }
  const target = mainRelationship.attrs.get("Target");
  const documentPart = target === undefined ? null : normalizePackageTarget(target);
  if (!documentPart) return { ok: false, reasonCode: "main-part-unsafe-path" };
  const documentEntry = byName.get(documentPart);
  if (!documentEntry) return { ok: false, reasonCode: "main-part-missing" };

  // Do not trust the relationship target alone: a decoy part at that path must
  // also be declared as the main document.
  const contentTypesEntry = byName.get(CONTENT_TYPES_PART);
  if (!contentTypesEntry) return { ok: false, reasonCode: "content-types-missing" };
  const contentTypesBytes = readEntryBytes(buf, contentTypesEntry, options.maxExpandedBytes);
  if (!contentTypesBytes) return { ok: false, reasonCode: "content-types-unreadable" };
  const contentTypesXml = decodeXmlPart(contentTypesBytes);
  const contentTypesParsed = parseXmlSafely(contentTypesXml, options);
  if (contentTypesParsed.rejected || !contentTypesParsed.root) {
    return { ok: false, reasonCode: "content-types-malformed" };
  }
  const contentTypesResolved = resolveDocument(contentTypesParsed.root, options.maxXmlNodes);
  if (contentTypesResolved.nodeBudgetExceeded || !contentTypesResolved.root) {
    return { ok: false, reasonCode: "content-types-malformed" };
  }
  // `<Types>` is the root element itself, not a child of it.
  const typesRoot =
    contentTypesResolved.root.uri === CONTENT_TYPES_NS &&
    contentTypesResolved.root.local === "Types"
      ? contentTypesResolved.root
      : null;
  const effectiveContentType = typesRoot ? resolveContentType(typesRoot, documentPart) : null;
  if (effectiveContentType !== MAIN_DOCUMENT_CONTENT_TYPE) {
    return { ok: false, reasonCode: "content-type-mismatch" };
  }

  const documentBytes = readEntryBytes(buf, documentEntry, options.maxExpandedBytes);
  if (!documentBytes) return { ok: false, reasonCode: "expansion-failed" };
  return { ok: true, value: { documentPart, documentBytes, hasOmittedStories } };
}

/** [Content_Types].xml resolution: exact Override, else extension Default. */
function resolveContentType(typesRoot: NsElement, partName: string): string | null {
  const overrides = findNsChildren(typesRoot, CONTENT_TYPES_NS, "Override");
  const normalizedTarget = `/${partName}`;
  for (const override of overrides) {
    if (override.attrs.get("PartName") === normalizedTarget) {
      return override.attrs.get("ContentType") ?? null;
    }
  }
  const lastDot = partName.lastIndexOf(".");
  if (lastDot === -1) return null;
  const extension = partName.slice(lastDot + 1).toLowerCase();
  const defaults = findNsChildren(typesRoot, CONTENT_TYPES_NS, "Default");
  for (const entry of defaults) {
    if ((entry.attrs.get("Extension") ?? "").toLowerCase() === extension) {
      return entry.attrs.get("ContentType") ?? null;
    }
  }
  return null;
}

function decodeXmlPart(bytes: Buffer): { text: string; unsupportedEncoding: boolean } {
  try {
    return {
      text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      unsupportedEncoding: false,
    };
  } catch {
    return { text: new TextDecoder("utf-8").decode(bytes), unsupportedEncoding: true };
  }
}

// `fast-xml-parser` keeps literal tag prefixes, so this module resolves them to
// namespace URIs itself.

function containsDangerousDeclaration(xml: string): boolean {
  return /<!DOCTYPE/iu.test(xml) || /<!ENTITY/iu.test(xml);
}

interface ParsedXml {
  root: FxpNode[] | null;
  rejected: boolean;
}

function parseXmlSafely(
  decoded: { text: string; unsupportedEncoding: boolean },
  options: DocxExtractionOptions,
): ParsedXml {
  if (containsDangerousDeclaration(decoded.text)) return { root: null, rejected: true };
  // `parse` recovers from an unclosed tag by nesting later content under it,
  // which would merge following paragraphs into one span at the wrong locator.
  // Validate well-formedness first and refuse anything the validator rejects.
  const validation = XMLValidator.validate(decoded.text);
  if (validation !== true) return { root: null, rejected: true };
  const parser = new XMLParser({
    preserveOrder: true,
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: false,
    processEntities: false,
    ignoreDeclaration: true,
    ignorePiTags: true,
    strictReservedNames: true,
    maxNestedTags: options.maxXmlDepth,
    // Distinct from "#text" so literal CDATA is never entity-decoded.
    cdataPropName: "#cdata",
  });
  try {
    const parsed: unknown = parser.parse(decoded.text);
    if (!Array.isArray(parsed)) return { root: null, rejected: true };
    return { root: parsed as FxpNode[], rejected: false };
  } catch {
    return { root: null, rejected: true };
  }
}

/** Raw `fast-xml-parser` `preserveOrder: true` node shape. */
type FxpNode =
  | { "#text": string }
  | ({ ":@"?: Record<string, string> } & Record<string, FxpNode[]>);

const XML_NAMED_ENTITIES: Readonly<Record<string, string>> = Object.freeze({
  amp: "&",
  lt: "<",
  gt: ">",
  apos: "'",
  quot: '"',
});

function decodeXmlEntities(value: string): string {
  return value.replaceAll(
    /&(#[0-9]{1,7}|#[Xx][0-9A-Fa-f]{1,6}|[A-Za-z][A-Za-z0-9]{0,31});/gu,
    (match, body: string) => {
      if (body.startsWith("#")) {
        const codePoint =
          body[1] === "x" || body[1] === "X"
            ? Number.parseInt(body.slice(2), 16)
            : Number.parseInt(body.slice(1), 10);
        if (
          !Number.isInteger(codePoint) ||
          codePoint <= 0 ||
          codePoint > 0x10ffff ||
          (codePoint >= 0xd800 && codePoint <= 0xdfff)
        ) {
          return match;
        }
        return String.fromCodePoint(codePoint);
      }
      return XML_NAMED_ENTITIES[body] ?? match;
    },
  );
}

/** Namespace-resolved, decoded normal form this module's walkers consume. */
export interface NsElement {
  uri: string | null;
  local: string;
  /** Keyed by attribute local name, ignoring namespace; values are entity-decoded. */
  attrs: Map<string, string>;
  children: NsNode[];
}
export type NsNode = NsElement | { text: string };

function isNsElement(node: NsNode): node is NsElement {
  return "local" in node;
}

interface NamespaceWalkState {
  nodeCount: number;
  maxNodes: number;
  exceeded: boolean;
}

const XMLNS_ATTR = /^xmlns(?::(.+))?$/u;

function resolveNamespaces(
  nodes: FxpNode[],
  parentScope: ReadonlyMap<string, string>,
  state: NamespaceWalkState,
): NsNode[] {
  const result: NsNode[] = [];
  for (const node of nodes) {
    if (state.exceeded) break;
    if ("#text" in node) {
      const raw = (node as { "#text": string })["#text"];
      const text = decodeXmlEntities(raw);
      if (text.length > 0) result.push({ text });
      continue;
    }
    if ("#cdata" in node) {
      // CDATA is literal: no entity decoding.
      const cdataChildren = (node as { "#cdata": FxpNode[] })["#cdata"];
      let raw = "";
      for (const inner of cdataChildren) {
        if ("#text" in inner) raw += (inner as { "#text": string })["#text"];
      }
      if (raw.length > 0) result.push({ text: raw });
      continue;
    }
    const rawAttrs = (node[":@"] ?? {}) as Record<string, string>;
    const scope = new Map(parentScope);
    for (const [key, value] of Object.entries(rawAttrs)) {
      if (!key.startsWith("@_")) continue;
      const attrName = key.slice(2);
      const match = XMLNS_ATTR.exec(attrName);
      if (match) scope.set(match[1] ?? "", value);
    }
    const tagKey = Object.keys(node).find((key) => key !== ":@");
    if (!tagKey) continue;
    state.nodeCount += 1;
    if (state.nodeCount > state.maxNodes) {
      state.exceeded = true;
      break;
    }
    const colonIndex = tagKey.indexOf(":");
    const prefix = colonIndex === -1 ? "" : tagKey.slice(0, colonIndex);
    const local = colonIndex === -1 ? tagKey : tagKey.slice(colonIndex + 1);
    const uri = scope.get(prefix) ?? null;
    const attrs = new Map<string, string>();
    for (const [key, value] of Object.entries(rawAttrs)) {
      if (!key.startsWith("@_")) continue;
      const attrName = key.slice(2);
      if (XMLNS_ATTR.test(attrName)) continue;
      const attrColon = attrName.indexOf(":");
      const attrLocal = attrColon === -1 ? attrName : attrName.slice(attrColon + 1);
      attrs.set(attrLocal, decodeXmlEntities(value));
    }
    const childNodes = (node[tagKey as keyof typeof node] ?? []) as FxpNode[];
    const children = resolveNamespaces(childNodes, scope, state);
    result.push({ uri, local, attrs, children });
  }
  return result;
}

function resolveDocument(
  nodes: FxpNode[],
  maxNodes: number,
): { root: NsElement | null; nodeBudgetExceeded: boolean } {
  const state: NamespaceWalkState = { nodeCount: 0, maxNodes, exceeded: false };
  const resolved = resolveNamespaces(nodes, new Map(), state);
  const root = resolved.find((node): node is NsElement => isNsElement(node)) ?? null;
  return { root, nodeBudgetExceeded: state.exceeded };
}

function findNsChild(node: NsElement, uri: string, local: string): NsElement | null {
  return (
    node.children.find(
      (child): child is NsElement =>
        isNsElement(child) && child.uri === uri && child.local === local,
    ) ?? null
  );
}

function findNsChildren(node: NsElement, uri: string, local: string): NsElement[] {
  return node.children.filter(
    (child): child is NsElement => isNsElement(child) && child.uri === uri && child.local === local,
  );
}

function wChildren(node: NsElement, local?: string): NsElement[] {
  return node.children.filter(
    (child): child is NsElement =>
      isNsElement(child) &&
      child.uri === WORDPROCESSINGML_NS &&
      (local === undefined || child.local === local),
  );
}

/** Elements whose children are formatting metadata, never readable text. */
const PROPERTY_BAG_LOCALS = new Set(["pPr", "rPr", "tcPr", "trPr", "tblPr", "sectPr", "sdtPr"]);
/** Body-level metadata with no block text; any other unknown body child is flagged. */
const KNOWN_BODY_METADATA_LOCALS = new Set([
  "sectPr",
  "bookmarkStart",
  "bookmarkEnd",
  "proofErr",
  "commentRangeStart",
  "commentRangeEnd",
  "permStart",
  "permEnd",
]);
/** Best-effort current content at this location. */
const REVISION_INCLUDED_LOCALS = new Set(["ins", "moveTo"]);
const REVISION_EXCLUDED_LOCALS = new Set(["del", "moveFrom"]);
const MEDIA_LOCALS = new Set(["drawing", "object", "pict"]);
/**
 * Allowlist of extra containers `collectParagraphText` recurses into beyond
 * `w:r`, `w:ins`, and `w:moveTo`. Any unrecognized element, such as a
 * schema-invalid nested `w:p`, is flagged and not recursed into, so it cannot
 * merge another paragraph's text into this span.
 */
const INLINE_CONTAINER_LOCALS = new Set([
  "hyperlink",
  "smartTag",
  "fldSimple",
  "sdt",
  "sdtContent",
]);

/** CT_OnOff (ECMA-376 Part 1, §17.17.4): on unless `w:val` is `false`, `0`, or `off`. */
function isOnOffElementActive(element: NsElement): boolean {
  const val = element.attrs.get("val");
  if (val === undefined) return true;
  return val !== "false" && val !== "0" && val !== "off";
}

function isVanishRun(run: NsElement): boolean {
  const rPr = wChildren(run, "rPr")[0];
  if (!rPr) return false;
  const vanish = wChildren(rPr, "vanish")[0];
  if (!vanish) return false;
  return isOnOffElementActive(vanish);
}

function collectParagraphText(
  paragraph: NsElement,
  limitations: Set<SourceRepresentationLimitation>,
): string {
  let text = "";
  const walk = (node: NsElement): void => {
    for (const child of node.children) {
      if (!isNsElement(child)) continue;
      if (child.uri !== WORDPROCESSINGML_NS) {
        // Not extracted (commonly `mc:AlternateContent`); the gap is flagged.
        limitations.add("unsupported-structure");
        continue;
      }
      if (PROPERTY_BAG_LOCALS.has(child.local)) continue;
      if (child.local === "r") {
        if (isVanishRun(child)) {
          limitations.add("hidden-content-excluded");
          continue;
        }
        walk(child);
        continue;
      }
      if (child.local === "t") {
        for (const grandchild of child.children) {
          if (!isNsElement(grandchild)) text += grandchild.text;
        }
        continue;
      }
      if (child.local === "tab") {
        text += "\t";
        continue;
      }
      if (child.local === "br" || child.local === "cr") {
        text += "\n";
        continue;
      }
      if (MEDIA_LOCALS.has(child.local)) {
        limitations.add("non-text-content-excluded");
        continue;
      }
      if (REVISION_EXCLUDED_LOCALS.has(child.local)) {
        limitations.add("unsupported-structure");
        continue;
      }
      if (REVISION_INCLUDED_LOCALS.has(child.local)) {
        limitations.add("unsupported-structure");
        walk(child);
        continue;
      }
      if (INLINE_CONTAINER_LOCALS.has(child.local)) {
        walk(child);
        continue;
      }
      // Never recurse generically; see INLINE_CONTAINER_LOCALS.
      limitations.add("unsupported-structure");
    }
  };
  walk(paragraph);
  return text;
}

function cellHasNestedTable(cell: NsElement): boolean {
  return wChildren(cell, "tbl").length > 0;
}

const TBL_METADATA_LOCALS = new Set(["tblPr", "tblGrid"]);
const TR_METADATA_LOCALS = new Set(["trPr"]);
/** `tbl` is flagged by `cellHasNestedTable`, so it is skipped here. */
const TC_METADATA_LOCALS = new Set(["tcPr", "tbl"]);

/**
 * Collects direct `wanted` children. Metadata is skipped; any other child (such
 * as a `w:sdt` wrapping a row) is flagged and never recursed into.
 */
function collectDirectChildren(
  node: NsElement,
  wanted: string,
  metadataLocals: ReadonlySet<string>,
  limitations: Set<SourceRepresentationLimitation>,
): NsElement[] {
  const collected: NsElement[] = [];
  for (const child of node.children) {
    if (!isNsElement(child)) continue;
    if (child.uri !== WORDPROCESSINGML_NS) {
      limitations.add("unsupported-structure");
      continue;
    }
    if (child.local === wanted) {
      collected.push(child);
      continue;
    }
    if (metadataLocals.has(child.local)) continue;
    limitations.add("unsupported-structure");
  }
  return collected;
}

function walkBody(
  body: NsElement,
  documentPart: string,
  limitations: Set<SourceRepresentationLimitation>,
): SourceExtractionSegmentV1[] {
  const segments: SourceExtractionSegmentV1[] = [];
  let bodyOrdinal = 0;
  let paragraphOrdinal = 0;

  for (const child of body.children) {
    if (!isNsElement(child)) continue;
    if (child.uri !== WORDPROCESSINGML_NS) {
      limitations.add("unsupported-structure");
      continue;
    }
    if (child.local === "p") {
      const text = collectParagraphText(child, limitations);
      if (text.length > 0) {
        const locator: SourceSpanLocatorV1 = {
          kind: "docx-block",
          part: documentPart,
          blockPath: [bodyOrdinal],
          paragraphOrdinal,
          tableCell: null,
        };
        segments.push({ text, locator });
      }
      paragraphOrdinal += 1;
      bodyOrdinal += 1;
      continue;
    }
    if (child.local === "tbl") {
      const rows = collectDirectChildren(child, "tr", TBL_METADATA_LOCALS, limitations);
      rows.forEach((row, rowIndex) => {
        const cells = collectDirectChildren(row, "tc", TR_METADATA_LOCALS, limitations);
        cells.forEach((cell, cellIndex) => {
          if (cellHasNestedTable(cell)) limitations.add("unsupported-structure");
          const paragraphs = collectDirectChildren(cell, "p", TC_METADATA_LOCALS, limitations);
          const cellText = paragraphs
            .map((paragraph) => collectParagraphText(paragraph, limitations))
            .filter((value) => value.length > 0)
            .join("\n");
          if (cellText.length > 0) {
            const locator: SourceSpanLocatorV1 = {
              kind: "docx-block",
              part: documentPart,
              blockPath: [bodyOrdinal, rowIndex, cellIndex],
              paragraphOrdinal: null,
              tableCell: { row: rowIndex, column: cellIndex },
            };
            segments.push({ text: cellText, locator });
          }
        });
      });
      bodyOrdinal += 1;
      continue;
    }
    if (child.local === "altChunk") {
      limitations.add("unsupported-structure");
      continue;
    }
    // Known metadata is skipped; any other body child (often a run orphaned by a
    // mismatched tag) is flagged. Neither advances bodyOrdinal.
    if (!KNOWN_BODY_METADATA_LOCALS.has(child.local)) {
      limitations.add("unsupported-structure");
    }
  }
  return segments;
}

/**
 * Test surface outside the adapter contract. The host reports every package
 * refusal as `empty-extraction`; this names which check fired.
 */
export function diagnoseDocxPackage(
  bytes: Uint8Array,
  options: Readonly<Record<string, unknown>> = {},
): { ok: true; documentPart: string } | { ok: false; reasonCode: DocxPackageReasonCode } {
  const resolved = resolveOptions(options);
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const result = readDocxPackage(buf, resolved);
  if (!result.ok) return result;
  return { ok: true, documentPart: result.value.documentPart };
}

const EMPTY_RESULT: SourceExtractionResultV1 = Object.freeze({ segments: [], limitations: [] });

function extract(request: SourceExtractionRequestV1): SourceExtractionResultV1 {
  try {
    const options = resolveOptions(request.options);
    const buf = Buffer.from(
      request.bytes.buffer,
      request.bytes.byteOffset,
      request.bytes.byteLength,
    );

    const pkg = readDocxPackage(buf, options);
    if (!pkg.ok) return EMPTY_RESULT;

    const limitations = new Set<SourceRepresentationLimitation>();
    if (pkg.value.hasOmittedStories) limitations.add("unsupported-structure");

    const decoded = decodeXmlPart(pkg.value.documentBytes);
    if (decoded.unsupportedEncoding) limitations.add("unsupported-encoding");

    const parsed = parseXmlSafely(decoded, options);
    if (parsed.rejected || !parsed.root) return EMPTY_RESULT;

    const { root: documentElement, nodeBudgetExceeded } = resolveDocument(
      parsed.root,
      options.maxXmlNodes,
    );
    if (nodeBudgetExceeded || !documentElement) return EMPTY_RESULT;
    if (documentElement.uri !== WORDPROCESSINGML_NS || documentElement.local !== "document") {
      return EMPTY_RESULT;
    }
    const body = findNsChild(documentElement, WORDPROCESSINGML_NS, "body");
    if (!body) return EMPTY_RESULT;

    const segments = walkBody(body, pkg.value.documentPart, limitations);
    return { segments, limitations: [...limitations].sort() };
  } catch {
    // Never throw: the host turns an empty result into `empty-extraction`.
    return EMPTY_RESULT;
  }
}

export const docxSourceExtractorAdapter: SourceExtractorAdapterV1 = Object.freeze({
  id: DOCX_SOURCE_EXTRACTOR_ID,
  version: DOCX_SOURCE_EXTRACTOR_VERSION,
  locatorKind: "docx-block",
  mediaTypes: Object.freeze([DOCX_MEDIA_TYPE]),
  defaultOptions: DEFAULT_OPTIONS,
  extract,
});
