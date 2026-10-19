// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Tracked HTML/export text adapter.
 *
 * An inert scanner: it never builds a DOM, evaluates script, resolves a URL, or
 * touches the filesystem. Active, hidden, and non-text material is excluded and
 * reported as a fixed limitation. `html-node` locators use preorder ordinals
 * over the elements this scanner opens.
 */
import type {
  SourceExtractionRequestV1,
  SourceExtractionResultV1,
  SourceExtractionSegmentV1,
  SourceExtractorAdapterV1,
} from "../source-extraction.js";
import type { SourceRepresentationLimitation } from "../source-evidence.js";

export const HTML_SOURCE_EXTRACTOR_ID = "docsfab-html-text" as const;
export const HTML_SOURCE_EXTRACTOR_VERSION = "1" as const;

/** Elements whose content is never part of the readable derivative. */
const ACTIVE_ELEMENTS = new Set(["script", "style", "template", "noscript"]);
/** Elements whose content is markup-bearing but not readable prose. */
const NON_TEXT_ELEMENTS = new Set(["svg", "math", "canvas", "iframe", "object", "audio", "video"]);
const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);
const NAMED_ENTITIES: Readonly<Record<string, string>> = Object.freeze({
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"',
});

const TAG_NAME = /^[A-Za-z][A-Za-z0-9-]*/u;

interface OpenElement {
  name: string;
  ordinal: number;
  textBytes: number;
  suppressed: boolean;
}

function decodeEntities(value: string): string {
  return value.replaceAll(
    /&(#[0-9]{1,7}|#[Xx][0-9A-Fa-f]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/gu,
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
      return NAMED_ENTITIES[body.toLowerCase()] ?? match;
    },
  );
}

/** Collapse runs of ASCII whitespace so a span is stable readable text. */
function normalizeText(value: string): string {
  return decodeEntities(value)
    .replaceAll(/[\t\n\f\r ]+/gu, " ")
    .trim();
}

function isHidden(attributes: string): boolean {
  if (/(?:^|\s)hidden(?:[\s=/>]|$)/iu.test(attributes)) return true;
  const style = /(?:^|\s)style\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/iu.exec(attributes);
  const value = (style?.[1] ?? style?.[2] ?? style?.[3] ?? "").toLowerCase();
  return /display\s*:\s*none/u.test(value) || /visibility\s*:\s*hidden/u.test(value);
}

function decodeOriginal(
  bytes: Uint8Array,
  limitations: Set<SourceRepresentationLimitation>,
): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    limitations.add("unsupported-encoding");
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function extract(request: SourceExtractionRequestV1): SourceExtractionResultV1 {
  const limitations = new Set<SourceRepresentationLimitation>();
  const html = decodeOriginal(request.bytes, limitations);
  const segments: SourceExtractionSegmentV1[] = [];
  const stack: OpenElement[] = [];
  let ordinal = 0;
  let index = 0;
  let structureMismatch = false;

  const suppressed = (): boolean => stack.some((entry) => entry.suppressed);

  const pushText = (raw: string): void => {
    const open = stack[stack.length - 1];
    if (!open) {
      if (normalizeText(raw).length > 0) structureMismatch = true;
      return;
    }
    if (suppressed()) return;
    const text = normalizeText(raw);
    if (text.length === 0) return;
    const textStartByte = open.textBytes;
    const textEndByte = textStartByte + Buffer.byteLength(text, "utf8");
    open.textBytes = textEndByte;
    segments.push({
      text,
      locator: { kind: "html-node", nodeOrdinal: open.ordinal, textStartByte, textEndByte },
    });
  };

  while (index < html.length) {
    const next = html.indexOf("<", index);
    if (next === -1) {
      pushText(html.slice(index));
      break;
    }
    if (next > index) pushText(html.slice(index, next));

    if (html.startsWith("<!--", next)) {
      const end = html.indexOf("-->", next + 4);
      index = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith("<!", next) || html.startsWith("<?", next)) {
      const end = html.indexOf(">", next);
      index = end === -1 ? html.length : end + 1;
      continue;
    }
    if (html.startsWith("</", next)) {
      const end = html.indexOf(">", next);
      const name = TAG_NAME.exec(html.slice(next + 2))?.[0]?.toLowerCase();
      index = end === -1 ? html.length : end + 1;
      if (!name) {
        structureMismatch = true;
        continue;
      }
      let depth = -1;
      for (let cursor = stack.length - 1; cursor >= 0; cursor -= 1) {
        if (stack[cursor]!.name === name) {
          depth = cursor;
          break;
        }
      }
      if (depth === -1) {
        structureMismatch = true;
        continue;
      }
      if (depth !== stack.length - 1) structureMismatch = true;
      stack.length = depth;
      continue;
    }

    const name = TAG_NAME.exec(html.slice(next + 1))?.[0]?.toLowerCase();
    if (!name) {
      pushText(html.slice(next, next + 1));
      index = next + 1;
      continue;
    }
    const end = html.indexOf(">", next);
    const tagEnd = end === -1 ? html.length : end + 1;
    const attributes = html.slice(next + 1 + name.length, end === -1 ? html.length : end);
    const selfClosing = attributes.trimEnd().endsWith("/");
    ordinal += 1;
    const elementOrdinal = ordinal - 1;
    index = tagEnd;

    if (ACTIVE_ELEMENTS.has(name)) {
      limitations.add("active-content-excluded");
      // Raw-text element: skip its content and its own close tag without
      // tokenizing either. Leaving the close tag behind would look like an
      // unmatched tag and report a false structure limitation.
      const close = html.toLowerCase().indexOf(`</${name}`, index);
      if (close === -1) {
        index = html.length;
        structureMismatch = true;
        continue;
      }
      const closeEnd = html.indexOf(">", close);
      index = closeEnd === -1 ? html.length : closeEnd + 1;
      continue;
    }
    if (VOID_ELEMENTS.has(name) || selfClosing) continue;

    const hidden = isHidden(attributes);
    if (hidden) limitations.add("hidden-content-excluded");
    const nonText = NON_TEXT_ELEMENTS.has(name);
    if (nonText) limitations.add("non-text-content-excluded");
    stack.push({
      name,
      ordinal: elementOrdinal,
      textBytes: 0,
      suppressed: hidden || nonText,
    });
  }

  if (structureMismatch || stack.length > 0) limitations.add("unsupported-structure");
  return { segments, limitations: [...limitations].sort() };
}

export const htmlSourceExtractorAdapter: SourceExtractorAdapterV1 = Object.freeze({
  id: HTML_SOURCE_EXTRACTOR_ID,
  version: HTML_SOURCE_EXTRACTOR_VERSION,
  locatorKind: "html-node",
  mediaTypes: Object.freeze(["text/html", "application/xhtml+xml"]),
  defaultOptions: Object.freeze({
    collapseWhitespace: true,
    decodeNamedEntities: true,
    excludeActiveContent: true,
    excludeHiddenContent: true,
  }),
  extract,
});
