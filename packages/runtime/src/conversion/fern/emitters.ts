// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  CalloutTone,
  ConversionBlock,
  ConversionInline,
  ConversionNode,
  ConvertTarget,
  ConvertTargetName,
  ImageNode,
  LineRange,
  RoleNode,
} from "../contracts.js";
import {
  FLOW_START,
  LINE,
  anchorFor,
  argumentText,
  component,
  describeOption,
  directiveBody,
  mismatch,
  noticeOptions,
  optionValue,
  withAnchor,
  type AttributeValue,
  type FernEmitContext,
} from "./context.js";
import {
  codeFence,
  collapseWhitespace,
  escapeMdxText,
  inlineCodeSpan,
  jsxAttribute,
  mdxComment,
  normalizeNewlines,
  type TextPosition,
} from "./escape.js";
import { renderHtml } from "./html.js";
import { selectIncludeText } from "./include-select.js";
import {
  delimited,
  headingLine,
  markdownBlock,
  markdownImage,
  markdownInline,
  markdownLink,
} from "./markdown.js";
import { csvTableModel, listTableModel, renderTable, type TableModel } from "./tables.js";
import type { FernBuiltInComponent } from "./types.js";

export type { FernEmitContext, NodeFrontmatterKey } from "./context.js";

type IntentOf<K extends ConvertTargetName> = Extract<ConvertTarget, { target: K }>;

export interface FernIntentEmitter<K extends ConvertTargetName> {
  block?: (node: ConversionBlock, intent: IntentOf<K>, context: FernEmitContext) => string;
  inline?: (
    node: ConversionInline,
    intent: IntentOf<K>,
    context: FernEmitContext,
    position: TextPosition,
  ) => string;
}

/** One emitter per convert intent; the mapped type fails to compile when an intent has none. */
export type FernIntentEmitterTable = {
  readonly [K in ConvertTargetName]: FernIntentEmitter<K>;
};

const TONE_COMPONENT: Readonly<Record<CalloutTone, FernBuiltInComponent>> = Object.freeze({
  note: "Note",
  tip: "Tip",
  warning: "Warning",
  info: "Info",
});

/** Text of inline content for an attribute value, and whether formatting was lost. */
function flattenInlines(nodes: readonly ConversionInline[]): { text: string; flattened: boolean } {
  let flattened = false;
  const walk = (inline: ConversionInline): string => {
    switch (inline.kind) {
      case "text":
        return inline.value;
      case "emphasis":
      case "strong":
      case "link":
        flattened = true;
        return inline.children.map(walk).join("");
      case "inlineCode":
      case "inlineMath":
        flattened = true;
        return inline.value;
      case "role":
        flattened = true;
        return inline.display ?? inline.content;
      case "inlineImage":
        flattened = true;
        return inline.alt ?? "";
      case "lineBreak":
        return " ";
      case "inlineHtml":
      case "footnoteReference":
      case "substitutionReference":
        flattened = true;
        return "";
    }
  };
  return { text: collapseWhitespace(nodes.map(walk).join("")), flattened };
}

function basename(source: string): string {
  const path = source.split(/[?#]/u)[0] ?? source;
  return (
    path
      .split("/")
      .filter((part) => part !== "")
      .at(-1) ?? source
  );
}

function lineRanges(ranges: readonly LineRange[]): string {
  return ranges
    .map((range) => (range.start === range.end ? `${range.start}` : `${range.start}-${range.end}`))
    .join(",");
}

function roleText(node: RoleNode): string {
  return (node.display ?? node.content).replace(/[ \t]*\n[ \t]*/gu, " ");
}

function roleTarget(node: RoleNode): string {
  return (node.target ?? node.content).trim();
}

function noticeImageOptions(context: FernEmitContext, node: ImageNode): void {
  for (const name of ["width", "height", "align"] as const) {
    const value = node.options[name];
    if (value !== undefined) context.notice("option-not-emitted", node, `:${name}: ${value}`);
  }
  noticeOptions(context, node, node.options.other);
}

/** Fern reads `title` and a `{1,3-4}` highlight range from the fence info string. */
function fenceInfo(
  context: FernEmitContext,
  node: ConversionNode,
  language: string | undefined,
  title: string | undefined,
  highlight: readonly LineRange[] | undefined,
): string {
  const attributes: string[] = [];
  if (title !== undefined) {
    const text = collapseWhitespace(title);
    if (!text.includes('"')) attributes.push(`title="${text}"`);
    else if (!text.includes("'")) attributes.push(`title='${text}'`);
    else context.notice("attribute-not-emitted", node, `title ${text}`);
  }
  if (highlight !== undefined && highlight.length > 0)
    attributes.push(`{${lineRanges(highlight)}}`);
  let lang = language?.trim() || undefined;
  if (lang !== undefined && !/^[^\s`{}]+$/u.test(lang)) {
    context.notice("attribute-not-emitted", node, `language ${lang}`);
    lang = undefined;
  }
  if (attributes.length === 0) return lang ?? "";
  return [lang ?? "text", ...attributes].join(" ");
}

function displayMath(value: string): string {
  const body = normalizeNewlines(value);
  return `$$\n${body}${body.endsWith("\n") ? "" : "\n"}$$`;
}

function inlineMath(value: string): string {
  const body = normalizeNewlines(value).replace(/\n/gu, " ");
  const delimiter = body.includes("$") ? "$$" : "$";
  return `${delimiter}${body}${delimiter}`;
}

function codeBlockEmitter(
  node: ConversionBlock,
  intent: IntentOf<"code-block">,
  context: FernEmitContext,
): string {
  if (node.kind === "directive") {
    if (node.body.kind !== "text") {
      return context.refuse(
        "fern-body-unparsed",
        node,
        `Directive ${node.name} node ${node.id} needs a code body.`,
      );
    }
    noticeOptions(context, node, node.options);
    const info = fenceInfo(
      context,
      node,
      intent.language ?? argumentText(node),
      undefined,
      undefined,
    );
    return codeFence(node.body.value, info);
  }
  if (node.kind !== "codeBlock") return mismatch(context, node, intent.target);
  const { options } = node;
  const keep = new Set(intent.keep);
  const caption = keep.has("caption") ? options.caption : undefined;
  const highlight = keep.has("emphasize-lines") ? options.emphasizeLines : undefined;
  if (options.caption !== undefined && caption === undefined) {
    context.notice("option-not-emitted", node, `:caption: ${options.caption}`);
  }
  if (options.emphasizeLines !== undefined && highlight === undefined) {
    context.notice(
      "option-not-emitted",
      node,
      `:emphasize-lines: ${lineRanges(options.emphasizeLines)}`,
    );
  }
  if (options.lineNumbers === true) {
    context.notice(
      "attribute-not-emitted",
      node,
      "Fern code blocks have no per-block line numbers.",
    );
  }
  if (options.firstLineNumber !== undefined) {
    context.notice("attribute-not-emitted", node, `:lineno-start: ${options.firstLineNumber}`);
  }
  noticeOptions(context, node, options.other);
  const info = fenceInfo(context, node, intent.language ?? node.language, caption, highlight);
  return withAnchor(context, anchorFor(context, options.name), codeFence(node.value, info));
}

function codeIncludeEmitter(
  node: ConversionBlock,
  intent: IntentOf<"code-include">,
  context: FernEmitContext,
): string {
  if (node.kind !== "include" || node.mode !== "literal")
    return mismatch(context, node, intent.target);
  if (node.target.kind === "remote") {
    return context.refuse(
      "fern-source-remote",
      node,
      `Include node ${node.id} names ${node.target.url}, which is never fetched.`,
    );
  }
  const source = context.readText(node, node.target.path);
  if (source === undefined) return "";
  const honor = new Set(intent.honor);
  const keep = new Set(intent.keep);
  const selection = {
    ...(honor.has("pyobject") && node.pyobject !== undefined ? { pyobject: node.pyobject } : {}),
    ...(honor.has("start-after") && node.startAfter !== undefined
      ? { startAfter: node.startAfter }
      : {}),
    ...(honor.has("end-before") && node.endBefore !== undefined
      ? { endBefore: node.endBefore }
      : {}),
    ...(honor.has("lines") && node.lines !== undefined ? { lines: node.lines } : {}),
  };
  const unhonored: Array<[string, unknown]> = [
    ["pyobject", node.pyobject],
    ["start-after", node.startAfter],
    ["end-before", node.endBefore],
    ["lines", node.lines],
  ];
  for (const [name, value] of unhonored) {
    if (value !== undefined && !honor.has(name as IntentOf<"code-include">["honor"][number])) {
      context.notice("option-not-emitted", node, `:${name}:`);
    }
  }
  const selected = selectIncludeText(source, selection);
  if (!selected.ok) {
    return context.refuse(
      "fern-include-selection-failed",
      node,
      `Include node ${node.id}: ${selected.reason}`,
    );
  }
  if (selected.linesBeyondEnd) {
    context.notice("include-lines-beyond-end", node, `:lines: ${lineRanges(node.lines ?? [])}`);
  }
  const caption = keep.has("caption") ? node.caption : undefined;
  const highlight = keep.has("emphasize-lines") ? node.emphasizeLines : undefined;
  if (node.caption !== undefined && caption === undefined) {
    context.notice("option-not-emitted", node, `:caption: ${node.caption}`);
  }
  if (node.emphasizeLines !== undefined && highlight === undefined) {
    context.notice(
      "option-not-emitted",
      node,
      `:emphasize-lines: ${lineRanges(node.emphasizeLines)}`,
    );
  }
  noticeOptions(context, node, node.other);
  return codeFence(selected.text, fenceInfo(context, node, node.language, caption, highlight));
}

function framedImage(node: ConversionBlock, context: FernEmitContext): string {
  if (node.kind !== "figure") return mismatch(context, node, "framed-image");
  const { image } = node;
  const caption = flattenInlines(node.caption);
  if (caption.flattened) context.notice("caption-flattened", node, caption.text);
  noticeImageOptions(context, image);
  const attributes = [
    jsxAttribute("src", image.source),
    jsxAttribute("alt", image.options.alt ?? basename(image.source)),
    ...(image.options.title === undefined ? [] : [jsxAttribute("title", image.options.title)]),
  ];
  const img = `<img ${attributes.join(" ")} />`;
  const target = image.options.target;
  const linked = target === undefined ? img : `<a ${jsxAttribute("href", target)}>${img}</a>`;
  const legend = context.emitBlocks(node.legend);
  const frameAttributes = caption.text === "" ? "" : ` ${jsxAttribute("caption", caption.text)}`;
  const body = legend === "" ? `  ${linked}` : `  ${linked}\n\n${legend}`;
  return withAnchor(
    context,
    anchorFor(context, node.label),
    `<Frame${frameAttributes}>\n${body}\n</Frame>`,
  );
}

function crossReferenceText(
  node: RoleNode,
  intent: IntentOf<"cross-reference"> | IntentOf<"link">,
  context: FernEmitContext,
): string {
  if (node.display !== undefined) return roleText(node);
  const target = roleTarget(node);
  if (intent.resolveIn === "label-table") {
    const title = context.ir.labels.find((entry) => entry.label === target)?.title;
    if (title !== undefined) return title;
  }
  if (intent.target === "cross-reference" || intent.resolveIn === "label-table") {
    context.notice("cross-reference-title-unresolved", node, target);
  }
  return target;
}

/** The emitter for each convert intent. */
export const FERN_INTENT_EMITTERS: FernIntentEmitterTable = Object.freeze({
  markdown: {
    block: (node, _intent, context) => markdownBlock(node, context),
    inline: (node, _intent, context, position) => markdownInline(node, context, position),
  },
  "code-block": { block: codeBlockEmitter },
  "code-include": { block: codeIncludeEmitter },
  "markup-include": {
    block: (node, intent, context) => {
      if (node.kind !== "include" || node.mode !== "markup")
        return mismatch(context, node, intent.target);
      if (node.target.kind === "remote") {
        return context.refuse(
          "fern-source-remote",
          node,
          `Include node ${node.id} names ${node.target.url}, which is never fetched.`,
        );
      }
      noticeOptions(context, node, node.other);
      return context.includeDocument(node, node.target.path) ?? "";
    },
  },
  table: {
    block: (node, intent, context) => {
      let model: TableModel | undefined;
      if (intent.from === "node" && node.kind === "table") {
        model = {
          header: node.headerRows.map((row) =>
            row.cells.map((cell) => ({ blocks: cell.children })),
          ),
          body: node.bodyRows.map((row) => row.cells.map((cell) => ({ blocks: cell.children }))),
          ...(node.caption === undefined ? {} : { caption: node.caption }),
        };
      } else if (intent.from === "list-table" && node.kind === "directive") {
        model = listTableModel(node, context);
      } else if (intent.from === "csv" && node.kind === "directive") {
        model = csvTableModel(node, context);
      } else {
        return mismatch(context, node, `${intent.target} from ${intent.from}`);
      }
      return model === undefined ? "" : renderTable(model, context);
    },
  },
  callout: {
    block: (node, intent, context) => {
      if (node.kind !== "directive") return mismatch(context, node, intent.target);
      noticeOptions(context, node, node.options);
      const argument = argumentText(node);
      const lead =
        intent.title === "none" && argument !== undefined
          ? escapeMdxText(argument, FLOW_START)
          : "";
      const title = intent.title === "argument" ? argument : undefined;
      const body = context.joinBlocks([lead, directiveBody(node, context)]);
      return component(TONE_COMPONENT[intent.tone], [["title", title]], body);
    },
  },
  collapsible: {
    block: (node, intent, context) => {
      if (node.kind !== "directive") return mismatch(context, node, intent.target);
      noticeOptions(context, node, node.options);
      const title = argumentText(node);
      if (title === undefined) context.notice("title-missing", node, `${node.name} has no title.`);
      return component("Accordion", [["title", title]], directiveBody(node, context));
    },
  },
  tabs: {
    block: (node, intent, context) => {
      if (node.kind !== "directive") return mismatch(context, node, intent.target);
      noticeOptions(context, node, node.options);
      return component("Tabs", [], directiveBody(node, context));
    },
  },
  tab: {
    block: (node, intent, context) => {
      if (node.kind !== "directive") return mismatch(context, node, intent.target);
      noticeOptions(context, node, node.options);
      const title = argumentText(node);
      if (title === undefined) context.notice("title-missing", node, `${node.name} has no title.`);
      return component("Tab", [["title", title]], directiveBody(node, context));
    },
  },
  "card-group": {
    block: (node, intent, context) => {
      if (node.kind !== "directive") return mismatch(context, node, intent.target);
      noticeOptions(context, node, node.options);
      // A grid argument lists columns per breakpoint; Fern takes one count, the widest.
      const columns = (node.argument ?? "")
        .trim()
        .split(/\s+/u)
        .filter((part) => part !== "");
      const widest = columns.at(-1);
      let cols: AttributeValue;
      if (widest !== undefined && /^[1-9][0-9]*$/u.test(widest)) cols = { expression: widest };
      else if (widest !== undefined)
        context.notice("option-not-emitted", node, `columns ${node.argument}`);
      return component("CardGroup", [["cols", cols]], directiveBody(node, context));
    },
  },
  card: {
    block: (node, intent, context) => {
      if (node.kind !== "directive") return mismatch(context, node, intent.target);
      const linkType = optionValue(node, "link-type");
      noticeOptions(
        context,
        node,
        node.options,
        linkType?.trim().toLowerCase() === "url" ? ["link", "link-type"] : ["link"],
      );
      const rawLink = optionValue(node, "link")?.trim();
      const href =
        rawLink !== undefined && (linkType === undefined || linkType.trim().toLowerCase() === "url")
          ? rawLink
          : undefined;
      if (rawLink !== undefined && href === undefined) {
        context.notice(
          "option-not-emitted",
          node,
          `The link target requires link-type "url"; received ${JSON.stringify(linkType)}.`,
        );
      }
      return component(
        "Card",
        [
          ["title", argumentText(node)],
          ["href", href === "" ? undefined : href],
        ],
        directiveBody(node, context),
      );
    },
  },
  "framed-image": { block: (node, _intent, context) => framedImage(node, context) },
  image: {
    block: (node, intent, context) => {
      if (node.kind !== "image") return mismatch(context, node, intent.target);
      noticeImageOptions(context, node);
      const alt = node.options.alt ?? basename(node.source);
      const image = markdownImage(alt, node.source, "flow", node.options.title);
      const target = node.options.target;
      return target === undefined ? image : markdownLink(image, target);
    },
    inline: (node, intent, context, position) => {
      if (node.kind !== "inlineImage") return mismatch(context, node, intent.target);
      return markdownImage(node.alt ?? basename(node.source), node.source, position.mode);
    },
  },
  diagram: {
    block: (node, intent, context) => {
      if (node.kind !== "directive") return mismatch(context, node, intent.target);
      noticeOptions(context, node, node.options);
      if (node.body.kind === "text") return codeFence(node.body.value, intent.language);
      const path = argumentText(node);
      if (node.body.kind === "none" && path !== undefined) {
        const source = context.readText(node, path);
        return source === undefined ? "" : codeFence(source, intent.language);
      }
      return context.refuse(
        "fern-body-unparsed",
        node,
        `Diagram node ${node.id} has no diagram source.`,
      );
    },
  },
  "math-block": {
    block: (node, intent, context) => {
      if (node.kind !== "math") return mismatch(context, node, intent.target);
      return withAnchor(context, anchorFor(context, node.label), displayMath(node.value));
    },
  },
  "math-inline": {
    inline: (node, intent, context) => {
      if (node.kind === "inlineMath") return inlineMath(node.value);
      if (node.kind === "role") return inlineMath(node.content);
      return mismatch(context, node, intent.target);
    },
  },
  glossary: {
    block: (node, intent, context) => {
      if (node.kind !== "directive") return mismatch(context, node, intent.target);
      noticeOptions(context, node, node.options);
      return directiveBody(node, context);
    },
  },
  heading: {
    block: (node, intent, context) => {
      if (node.kind !== "directive") return mismatch(context, node, intent.target);
      noticeOptions(context, node, node.options);
      const text = argumentText(node);
      if (text === undefined) {
        context.notice("title-missing", node, `${node.name} has no heading text.`);
        return directiveBody(node, context);
      }
      const heading = headingLine(intent.depth, escapeMdxText(text, LINE), node, context);
      return context.joinBlocks([heading, directiveBody(node, context)]);
    },
  },
  "titled-block": {
    block: (node, intent, context) => {
      if (node.kind !== "directive") return mismatch(context, node, intent.target);
      noticeOptions(context, node, node.options);
      const title = argumentText(node);
      const heading = title === undefined ? "" : delimited("**", escapeMdxText(title, LINE));
      return context.joinBlocks([heading, directiveBody(node, context)]);
    },
  },
  unwrap: {
    block: (node, intent, context) => {
      if (node.kind !== "directive") return mismatch(context, node, intent.target);
      noticeOptions(context, node, node.options);
      return directiveBody(node, context);
    },
  },
  frontmatter: {
    block: (node, intent, context) => {
      if (node.kind !== "directive") return mismatch(context, node, intent.target);
      for (const option of node.options) {
        if (
          (option.name === "description" || option.name === "keywords") &&
          option.value !== undefined
        ) {
          context.setFrontmatter(option.name, collapseWhitespace(option.value), node);
        } else {
          context.notice("frontmatter-key-not-emitted", node, describeOption(option));
        }
      }
      return "";
    },
  },
  anchor: {
    block: (node, intent, context) =>
      node.kind === "target"
        ? anchorFor(context, node.label)
        : mismatch(context, node, intent.target),
  },
  comment: {
    block: (node, intent, context) =>
      node.kind === "comment"
        ? mdxComment(` ${normalizeNewlines(node.value)} `)
        : mismatch(context, node, intent.target),
  },
  html: {
    block: (node, intent, context) => {
      if (node.kind !== "html") return mismatch(context, node, intent.target);
      const rendered = renderHtml(node.value, "block");
      if (rendered.form === "wrapped")
        context.notice(
          "html-wrapped",
          node,
          "Raw HTML is written through dangerouslySetInnerHTML.",
        );
      return rendered.text;
    },
    inline: (node, intent, context) => {
      if (node.kind !== "inlineHtml") return mismatch(context, node, intent.target);
      const rendered = renderHtml(node.value, "inline");
      if (rendered.form === "wrapped")
        context.notice(
          "html-wrapped",
          node,
          "Raw HTML is written through dangerouslySetInnerHTML.",
        );
      return rendered.text;
    },
  },
  link: {
    block: (node, intent, context) => {
      if (node.kind !== "directive") return mismatch(context, node, intent.target);
      const target = argumentText(node);
      if (target === undefined) {
        return context.refuse(
          "fern-intent-node-mismatch",
          node,
          `Directive ${node.name} node ${node.id} has no link target.`,
        );
      }
      noticeOptions(context, node, node.options);
      const inner: TextPosition = { lineStart: false, mode: "flow" };
      let text: string;
      const [only, ...rest] = node.body.kind === "blocks" ? node.body.children : [];
      if (node.body.kind === "text") {
        text = escapeMdxText(node.body.value, inner);
      } else if (only?.kind === "paragraph" && rest.length === 0) {
        text = context.emitInlines(only.children, inner);
      } else if (only === undefined) {
        const title =
          intent.resolveIn === "label-table"
            ? context.ir.labels.find((entry) => entry.label === target)?.title
            : undefined;
        text = escapeMdxText(title ?? target, inner);
      } else {
        return context.refuse(
          "fern-intent-node-mismatch",
          node,
          `Directive ${node.name} node ${node.id} has a body that is not one paragraph.`,
        );
      }
      return markdownLink(text, target);
    },
    inline: (node, intent, context, position) => {
      if (node.kind !== "role") return mismatch(context, node, intent.target);
      const inner: TextPosition = { lineStart: false, mode: position.mode };
      return markdownLink(
        escapeMdxText(crossReferenceText(node, intent, context), inner),
        roleTarget(node),
      );
    },
  },
  "cross-reference": {
    inline: (node, intent, context, position) => {
      if (node.kind !== "role") return mismatch(context, node, intent.target);
      const inner: TextPosition = { lineStart: false, mode: position.mode };
      return markdownLink(
        escapeMdxText(crossReferenceText(node, intent, context), inner),
        roleTarget(node),
      );
    },
  },
  "inline-code": {
    inline: (node, intent, context) =>
      node.kind === "role" ? inlineCodeSpan(node.content) : mismatch(context, node, intent.target),
  },
  strong: {
    inline: (node, intent, context, position) =>
      node.kind === "role"
        ? delimited("**", escapeMdxText(roleText(node), { lineStart: false, mode: position.mode }))
        : mismatch(context, node, intent.target),
  },
  keyboard: {
    inline: (node, intent, context, position) =>
      node.kind === "role"
        ? `<kbd>${escapeMdxText(roleText(node), { lineStart: false, mode: position.mode })}</kbd>`
        : mismatch(context, node, intent.target),
  },
  "plain-text": {
    inline: (node, intent, context, position) =>
      node.kind === "role"
        ? escapeMdxText(roleText(node), position)
        : mismatch(context, node, intent.target),
  },
  badge: {
    inline: (node, intent, context, position) => {
      if (node.kind !== "role") return mismatch(context, node, intent.target);
      context.notice("badge-variant-not-emitted", node, intent.variant);
      return escapeMdxText(roleText(node), position);
    },
  },
  substitution: {
    inline: (node, intent, context, position) => {
      if (node.kind !== "substitutionReference") return mismatch(context, node, intent.target);
      const value = context.substitution(node.name);
      if (value === undefined) {
        return context.refuse(
          "fern-substitution-unresolved",
          node,
          `Substitution ${node.name} has no literal value.`,
        );
      }
      return escapeMdxText(value, position);
    },
  },
  "literal-text": {
    block: (_node, intent) => escapeMdxText(intent.text, FLOW_START),
    inline: (_node, intent, _context, position) => escapeMdxText(intent.text, position),
  },
} satisfies FernIntentEmitterTable);

/** Every intent the page emitter can write. */
export const FERN_EMITTED_INTENTS: readonly ConvertTargetName[] = Object.freeze(
  Object.keys(FERN_INTENT_EMITTERS) as ConvertTargetName[],
);
