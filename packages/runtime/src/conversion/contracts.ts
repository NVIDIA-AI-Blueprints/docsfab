// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ContentFormatV3 } from "../content-ir/contracts.js";

/**
 * Generator-neutral conversion IR. Source readers produce it and target
 * emitters consume it; neither side reads the other's syntax.
 */
export const CONVERSION_IR_SCHEMA_VERSION = 1;

type Assert<T extends true> = T;
type Equals<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** One-based, inclusive source lines inside the owning document. */
export interface SourceSpan {
  startLine: number;
  endLine: number;
}

/** One-based, inclusive line range used by code-block and include options. */
export interface LineRange {
  start: number;
  end: number;
}

export interface ConversionNodeBase {
  /** Unique within one IR, dropped subtrees included; drop-ledger entries and ambiguity units cite it. */
  id: string;
  span: SourceSpan;
}

/** A directive or include option exactly as written; flag options have no value. */
export interface SourceOption {
  name: string;
  value?: string;
}

export interface HeadingNode extends ConversionNodeBase {
  kind: "heading";
  depth: number;
  children: ConversionInline[];
}

export interface ParagraphNode extends ConversionNodeBase {
  kind: "paragraph";
  children: ConversionInline[];
}

export interface ListNode extends ConversionNodeBase {
  kind: "list";
  ordered: boolean;
  /** First ordinal of an ordered list; RST auto-numbered lists leave it unset. */
  start?: number;
  items: ListItemNode[];
}

export interface ListItemNode extends ConversionNodeBase {
  kind: "listItem";
  children: ConversionBlock[];
}

export interface BlockquoteNode extends ConversionNodeBase {
  kind: "blockquote";
  children: ConversionBlock[];
}

export interface ThematicBreakNode extends ConversionNodeBase {
  kind: "thematicBreak";
}

export interface CodeBlockOptions {
  caption?: string;
  emphasizeLines?: LineRange[];
  lineNumbers?: boolean;
  /** First displayed line number (`:lineno-start:`). */
  firstLineNumber?: number;
  /** Explicit label (`:name:`); it is also present in the label table. */
  name?: string;
  /** Options the reader recognized as directive options but has no typed field for. */
  other: SourceOption[];
}

/** Fenced, indented, and literal blocks plus the `code-block`, `code`, and `sourcecode` directives. */
export interface CodeBlockNode extends ConversionNodeBase {
  kind: "codeBlock";
  language?: string;
  /** Opening-line text after the language (a fence's info string or the directive argument), as written. */
  meta?: string;
  value: string;
  options: CodeBlockOptions;
}

export interface TableCell {
  children: ConversionBlock[];
}

export interface TableRow {
  cells: TableCell[];
}

/** Pipe, grid, and simple tables; `list-table` and `csv-table` stay directives. */
export interface TableNode extends ConversionNodeBase {
  kind: "table";
  headerRows: TableRow[];
  bodyRows: TableRow[];
  caption?: ConversionInline[];
  /** Column alignment from a pipe table's delimiter row, one entry per column. */
  alignments?: TableColumnAlignment[];
}

export type TableColumnAlignment = "left" | "center" | "right" | "default";

export interface DefinitionListNode extends ConversionNodeBase {
  kind: "definitionList";
  items: Array<{ term: ConversionInline[]; definition: ConversionBlock[] }>;
}

export interface FieldListNode extends ConversionNodeBase {
  kind: "fieldList";
  fields: Array<{ name: ConversionInline[]; body: ConversionBlock[] }>;
}

export interface LineBlockNode extends ConversionNodeBase {
  kind: "lineBlock";
  lines: ConversionInline[][];
}

export interface FootnoteDefinitionNode extends ConversionNodeBase {
  kind: "footnoteDefinition";
  label: string;
  children: ConversionBlock[];
}

/** A label or target: MyST `(name)=` or RST `.. _name:`. */
export interface TargetNode extends ConversionNodeBase {
  kind: "target";
  label: string;
}

export interface CommentNode extends ConversionNodeBase {
  kind: "comment";
  value: string;
}

/** HTML block, including the `raw` directive when its format is `html`. */
export interface HtmlNode extends ConversionNodeBase {
  kind: "html";
  value: string;
}

/** Display math, including the `math` directive. */
export interface MathNode extends ConversionNodeBase {
  kind: "math";
  value: string;
  label?: string;
  /** Directive options other than the label. */
  other?: SourceOption[];
}

export interface ImageOptions {
  alt?: string;
  title?: string;
  width?: string;
  height?: string;
  align?: string;
  /** Link target of a clickable image (`:target:`). */
  target?: string;
  other: SourceOption[];
}

/** Markdown image syntax or the `image` directive. */
export interface ImageNode extends ConversionNodeBase {
  kind: "image";
  /** Asset-table id for a local image; unset for a remote URL. */
  assetId?: string;
  source: string;
  options: ImageOptions;
}

/** The `figure` directive. */
export interface FigureNode extends ConversionNodeBase {
  kind: "figure";
  image: ImageNode;
  caption: ConversionInline[];
  legend: ConversionBlock[];
  label?: string;
}

export type IncludeTarget = { kind: "local"; path: string } | { kind: "remote"; url: string };

/** `include`, `literalinclude`, and equivalent snippet includes. */
export interface IncludeNode extends ConversionNodeBase {
  kind: "include";
  /** `markup` parses the included file; `literal` shows it as code. */
  mode: "markup" | "literal";
  target: IncludeTarget;
  language?: string;
  caption?: string;
  emphasizeLines?: LineRange[];
  /** `:lines:` selection as written. */
  lines?: LineRange[];
  /** `:pyobject:` dotted name of a Python class, function, or method. */
  pyobject?: string;
  startAfter?: string;
  endBefore?: string;
  other: SourceOption[];
}

/** One `toctree` entry as written; navigation assembly resolves targets. */
export type ToctreeEntry =
  | { kind: "document"; target: string; title?: string; span: SourceSpan }
  | { kind: "self"; title?: string; span: SourceSpan }
  | { kind: "url"; url: string; title?: string; span: SourceSpan }
  | { kind: "glob"; pattern: string; span: SourceSpan };

export type DirectiveBody =
  | { kind: "blocks"; children: ConversionBlock[] }
  | { kind: "text"; value: string }
  | {
      /** The `toctree` body; `caption`, `hidden`, and `glob` mirror the options of the same names. */
      kind: "toctree";
      entries: ToctreeEntry[];
      caption?: string;
      hidden: boolean;
      glob: boolean;
    }
  | { kind: "none" };

/**
 * Any directive the reader does not normalize into a typed node. Readers
 * normalize every name in `NORMALIZED_DIRECTIVE_NODE_KINDS`; the resolver
 * refuses a directive node that carries one of those names.
 */
export interface DirectiveNode extends ConversionNodeBase {
  kind: "directive";
  /** Lower-case directive name, including any domain prefix (`py:function`). */
  name: string;
  /** Text after the directive name on its opening line. */
  argument?: string;
  options: SourceOption[];
  body: DirectiveBody;
}

export type ConversionBlock =
  | HeadingNode
  | ParagraphNode
  | ListNode
  | ListItemNode
  | BlockquoteNode
  | ThematicBreakNode
  | CodeBlockNode
  | TableNode
  | DefinitionListNode
  | FieldListNode
  | LineBlockNode
  | FootnoteDefinitionNode
  | TargetNode
  | CommentNode
  | HtmlNode
  | MathNode
  | ImageNode
  | FigureNode
  | IncludeNode
  | DirectiveNode;

export interface TextNode extends ConversionNodeBase {
  kind: "text";
  value: string;
}

export interface EmphasisNode extends ConversionNodeBase {
  kind: "emphasis";
  children: ConversionInline[];
}

export interface StrongNode extends ConversionNodeBase {
  kind: "strong";
  children: ConversionInline[];
}

export interface InlineCodeNode extends ConversionNodeBase {
  kind: "inlineCode";
  value: string;
}

/** Inline link with an explicit URL or autolink; cross-reference roles stay roles. */
export interface LinkNode extends ConversionNodeBase {
  kind: "link";
  url: string;
  title?: string;
  children: ConversionInline[];
}

export interface InlineImageNode extends ConversionNodeBase {
  kind: "inlineImage";
  assetId?: string;
  source: string;
  alt?: string;
}

export interface InlineHtmlNode extends ConversionNodeBase {
  kind: "inlineHtml";
  value: string;
}

export interface InlineMathNode extends ConversionNodeBase {
  kind: "inlineMath";
  value: string;
}

export interface LineBreakNode extends ConversionNodeBase {
  kind: "lineBreak";
}

export interface FootnoteReferenceNode extends ConversionNodeBase {
  kind: "footnoteReference";
  label: string;
}

/** `{{ name }}` in MyST or `|name|` in RST; values live in the substitution table. */
export interface SubstitutionReferenceNode extends ConversionNodeBase {
  kind: "substitutionReference";
  name: string;
}

/** Any interpreted-text role, including the cross-reference roles. */
export interface RoleNode extends ConversionNodeBase {
  kind: "role";
  /** Lower-case role name, including any domain prefix (`py:class`). */
  name: string;
  /** Raw text between the backticks. */
  content: string;
  /** Display text of the `Display <target>` form. */
  display?: string;
  /** Target of the `Display <target>` form, or the whole content when no display is given. */
  target?: string;
}

export type ConversionInline =
  | TextNode
  | EmphasisNode
  | StrongNode
  | InlineCodeNode
  | LinkNode
  | InlineImageNode
  | InlineHtmlNode
  | InlineMathNode
  | LineBreakNode
  | FootnoteReferenceNode
  | SubstitutionReferenceNode
  | RoleNode;

export type ConversionNode = ConversionBlock | ConversionInline;
export type ConversionNodeKind = ConversionNode["kind"];

/** Every IR node kind, in declaration order. Exhaustiveness tests enumerate this list. */
export const CONVERSION_NODE_KINDS = Object.freeze([
  "heading",
  "paragraph",
  "list",
  "listItem",
  "blockquote",
  "thematicBreak",
  "codeBlock",
  "table",
  "definitionList",
  "fieldList",
  "lineBlock",
  "footnoteDefinition",
  "target",
  "comment",
  "html",
  "math",
  "image",
  "figure",
  "include",
  "directive",
  "text",
  "emphasis",
  "strong",
  "inlineCode",
  "link",
  "inlineImage",
  "inlineHtml",
  "inlineMath",
  "lineBreak",
  "footnoteReference",
  "substitutionReference",
  "role",
] as const);

type NodeKindListIsComplete = Assert<
  Equals<(typeof CONVERSION_NODE_KINDS)[number], ConversionNodeKind>
>;

/**
 * Directive names that readers turn into typed nodes. A `directive` node with
 * one of these names is a reader defect, not a custom directive.
 */
export const NORMALIZED_DIRECTIVE_NODE_KINDS = Object.freeze({
  "code-block": "codeBlock",
  code: "codeBlock",
  sourcecode: "codeBlock",
  image: "image",
  figure: "figure",
  math: "math",
  include: "include",
  literalinclude: "include",
  rli: "include",
} as const satisfies Record<string, ConversionNodeKind>);

/** Where a navigation title came from; title conflicts compare these origins. */
export type TitleOrigin = "toctree-entry" | "frontmatter" | "first-heading" | "configuration";

export interface SourceTitle {
  text: string;
  origin: TitleOrigin;
}

/** Navigation entries keep source order: array order is navigation order. */
export type NavigationEntry =
  | { kind: "page"; documentId: string; title?: SourceTitle; hidden: boolean }
  | {
      kind: "section";
      title: SourceTitle;
      /** Landing page of the section, when the source has one. */
      documentId?: string;
      children: NavigationEntry[];
    }
  | { kind: "link"; title: SourceTitle; url: string };

export interface NavigationTree {
  entries: NavigationEntry[];
}

export interface LabelEntry {
  label: string;
  documentId: string;
  /** Anchor in the converted page; unset when the label names the whole page. */
  anchor?: string;
  /** Display title a label-only cross-reference renders. */
  title?: string;
  span: SourceSpan;
}

/** Source route to target route. Readers leave `targetRoute` unset; route planning fills it. */
export interface RouteEntry {
  documentId: string;
  sourceRoute: string;
  targetRoute?: string;
}

export interface AssetEntry {
  id: string;
  /** Repository-relative path. */
  sourcePath: string;
  role: "image" | "download" | "include-source";
}

export type SubstitutionValue =
  | { kind: "literal"; text: string }
  /** A value computed in configuration code; the reader records the expression, never evaluates it. */
  | { kind: "computed"; expression: string };

export type SubstitutionOrigin =
  | { kind: "configuration"; path: string; span: SourceSpan }
  | { kind: "document"; documentId: string; sourcePath: string; span: SourceSpan };

export interface SubstitutionEntry {
  name: string;
  value: SubstitutionValue;
  origin: SubstitutionOrigin;
}

export type DropReasonCode =
  | "navigation-owned"
  | "generated-by-target"
  | "editorial-only"
  | "decorative"
  | "no-target-equivalent"
  | "operator-rule"
  | "judged-answer";

export interface DropReason {
  code: DropReasonCode;
  text: string;
}

export interface DropLedgerEntry {
  nodeId: string;
  documentId: string;
  sourcePath: string;
  construct: ConstructKey;
  reason: DropReason;
  span: SourceSpan;
}

export interface ConversionDocument {
  id: string;
  /** Repository-relative path. */
  sourcePath: string;
  format: ContentFormatV3;
  frontmatter: Readonly<Record<string, unknown>>;
  children: ConversionBlock[];
}

export type ConversionSourceGenerator = "sphinx" | "mkdocs" | "docusaurus" | "markdown";

export interface ConversionSource {
  generator: ConversionSourceGenerator;
  /** Repository-relative documentation root. */
  root: string;
  repositoryRevision: string;
  /** Extension modules the source configuration declares, in declaration order. */
  extensionModules: string[];
}

export interface ConversionIrV1 {
  schemaVersion: typeof CONVERSION_IR_SCHEMA_VERSION;
  source: ConversionSource;
  documents: ConversionDocument[];
  navigation: NavigationTree;
  labels: LabelEntry[];
  routes: RouteEntry[];
  assets: AssetEntry[];
  substitutions: SubstitutionEntry[];
  /** Nodes a reader removed before resolution; the resolver appends its own drops. */
  dropLedger: DropLedgerEntry[];
}

/**
 * Registry key for one construct. Typed nodes key by kind; directives and
 * roles key by name, and `*` is the fallback for an unregistered name.
 * Includes key by mode, and every remote include shares one key.
 */
export type ConstructKey =
  | `node:${Exclude<ConversionNodeKind, "directive" | "role" | "include">}`
  | "include:markup"
  | "include:literal"
  | "include:remote"
  | DirectiveConstructKey
  | RoleConstructKey;

export type DirectiveConstructKey = `directive:${string}`;
export type RoleConstructKey = `role:${string}`;

export type CalloutTone = "note" | "tip" | "warning" | "info";

export type BadgeVariant =
  | "primary"
  | "secondary"
  | "success"
  | "warning"
  | "danger"
  | "info"
  | "light"
  | "dark";

/**
 * Target-neutral emitter intents with typed parameters. A target emitter maps
 * each intent to its own syntax (for Fern, `callout` with tone `note` is
 * `<Note>`).
 */
export type ConvertTarget =
  | { target: "markdown" }
  | {
      target: "code-block";
      /** Source options kept as target code-block attributes. */
      keep: Array<"caption" | "emphasize-lines" | "line-numbers" | "first-line-number">;
      /** Language for directives that imply one (`doctest`). */
      language?: string;
    }
  | {
      target: "code-include";
      /** Selection options applied to the included file before it is inlined. */
      honor: Array<"lines" | "pyobject" | "start-after" | "end-before">;
      keep: Array<"caption" | "emphasize-lines">;
    }
  | { target: "markup-include" }
  | { target: "table"; from: "node" | "list-table" }
  | {
      target: "table";
      from: "csv";
      /** RFC 4180 quoting; `:file:` reads a local file and never fetches `:url:`. */
      quoting: "rfc4180";
      file: "local-only";
    }
  | { target: "callout"; tone: CalloutTone; title: "none" | "argument" }
  | { target: "collapsible"; title: "argument" }
  | { target: "tabs" }
  | { target: "tab"; title: "argument" }
  | { target: "card-group" }
  | { target: "card"; title: "argument" }
  | { target: "framed-image" }
  | { target: "image" }
  | { target: "diagram"; language: "mermaid" }
  | { target: "math-block" }
  | { target: "math-inline" }
  | { target: "glossary" }
  | { target: "heading"; depth: number }
  | { target: "titled-block" }
  | { target: "unwrap" }
  | { target: "frontmatter" }
  | { target: "anchor" }
  | { target: "comment" }
  | { target: "html" }
  | { target: "link"; resolveIn: "url" | "label-table" | "asset-table" }
  | { target: "cross-reference"; resolveIn: "label-table" | "route-table" }
  | { target: "inline-code" }
  | { target: "strong" }
  | { target: "keyboard" }
  | { target: "plain-text" }
  | { target: "badge"; variant: BadgeVariant }
  | { target: "substitution"; resolveIn: "substitution-table" }
  /** Fixed replacement text; only plan-level rules and judged answers produce it. */
  | { target: "literal-text"; text: string };

export type ConvertTargetName = ConvertTarget["target"];

export type ConstructRefusalReason = "api-reference-generation";

/** Unit kinds a registry rule can produce from one node; the rest come from planning. */
export type NodeAmbiguityUnitKind = Extract<
  AmbiguityUnitKind,
  "custom-construct" | "conditional-content" | "remote-include"
>;

export type ConstructDisposition =
  | { disposition: "convert"; convert: ConvertTarget }
  | { disposition: "judge"; unitKind: NodeAmbiguityUnitKind }
  | { disposition: "drop-with-notice"; reason: DropReason }
  | { disposition: "refuse"; reason: ConstructRefusalReason; text: string };

export type DispositionName = ConstructDisposition["disposition"];

export interface ConstructRule {
  construct: ConstructKey;
  rule: ConstructDisposition;
  /** Where the rule departs from the legacy converter, the departure in one sentence. */
  improvement?: string;
}

export interface ConstructRuleRegistry {
  version: number;
  rules: readonly ConstructRule[];
}

/** Ambiguity-unit kinds the host enumerates; the model never scans a site freely. */
export type AmbiguityUnitKind =
  | "custom-construct"
  | "conditional-content"
  | "non-literal-substitution"
  | "unresolved-link-target"
  | "title-conflict"
  | "build-generated-source"
  | "remote-include";

export const AMBIGUITY_UNIT_SCHEMA_VERSION = 1;

/** Location of the excerpt the unit asks about; the unit never embeds whole pages. */
export interface SourceExcerptRef {
  documentId?: string;
  sourcePath: string;
  span: SourceSpan;
}

interface AmbiguityUnitBase {
  schemaVersion: typeof AMBIGUITY_UNIT_SCHEMA_VERSION;
  /** Deterministic from the node or table entry it was enumerated from. */
  id: string;
  excerpt: SourceExcerptRef;
}

export type AmbiguityUnit =
  | (AmbiguityUnitBase & {
      kind: "custom-construct";
      construct: DirectiveConstructKey | RoleConstructKey;
      nodeId: string;
      name: string;
      argument?: string;
      options: SourceOption[];
      /** Extension modules the source configuration declares; the reader cannot attribute a name statically. */
      extensionModules: string[];
    })
  | (AmbiguityUnitBase & {
      kind: "conditional-content";
      construct: ConstructKey;
      nodeId: string;
      condition: string;
    })
  | (AmbiguityUnitBase & {
      kind: "non-literal-substitution";
      name: string;
      expression: string;
    })
  | (AmbiguityUnitBase & {
      kind: "unresolved-link-target";
      nodeId: string;
      target: string;
    })
  | (AmbiguityUnitBase & {
      kind: "title-conflict";
      documentId: string;
      candidates: SourceTitle[];
    })
  | (AmbiguityUnitBase & {
      kind: "build-generated-source";
      path: string;
      evidence: string;
    })
  | (AmbiguityUnitBase & {
      kind: "remote-include";
      construct: "include:remote";
      nodeId: string;
      url: string;
    });

type UnitKindsAreClosed = Assert<Equals<AmbiguityUnit["kind"], AmbiguityUnitKind>>;

/** The closed answer set for one unit. */
export type AmbiguityAnswer =
  | {
      answer: "map-to-construct";
      /** A registered directive or role of the same family whose rule is `convert`. */
      construct: DirectiveConstructKey | RoleConstructKey;
      /** The mapped rule's intent with its parameters set; it must name the same intent. */
      parameters?: ConvertTarget;
    }
  | { answer: "keep-literal"; text: string }
  | { answer: "drop"; reason: string }
  | { answer: "ask-operator"; question: string };

export type AmbiguityAnswerKind = AmbiguityAnswer["answer"];

/** Which answers each unit kind admits; the host refuses any other answer. */
export const AMBIGUITY_UNIT_ANSWERS = Object.freeze({
  "custom-construct": Object.freeze(["map-to-construct", "keep-literal", "drop", "ask-operator"]),
  "conditional-content": Object.freeze(["map-to-construct", "drop", "ask-operator"]),
  "non-literal-substitution": Object.freeze(["keep-literal", "drop", "ask-operator"]),
  "unresolved-link-target": Object.freeze(["keep-literal", "drop", "ask-operator"]),
  "title-conflict": Object.freeze(["keep-literal", "ask-operator"]),
  "build-generated-source": Object.freeze(["drop", "ask-operator"]),
  "remote-include": Object.freeze(["keep-literal", "drop", "ask-operator"]),
} as const satisfies Record<AmbiguityUnitKind, readonly AmbiguityAnswerKind[]>);

export type ConversionRuleProvenance =
  | { source: "operator" }
  | { source: "judged-answer"; unitId: string };

/** What a plan-level rule does with every occurrence of its construct. */
export type ConversionOverrideRule =
  | {
      rule: "map-to-construct";
      construct: DirectiveConstructKey | RoleConstructKey;
      /** The mapped rule's intent with its parameters set; it must name the same intent. */
      parameters?: ConvertTarget;
    }
  | { rule: "keep-literal"; text: string }
  | { rule: "drop"; reason: string };

/**
 * A plan-level rule. It binds only through plan approval and replaces the
 * registry rule for its construct, or sets a substitution's literal value.
 */
export type ConversionRuleOverride =
  | {
      kind: "construct";
      construct: DirectiveConstructKey | RoleConstructKey;
      override: ConversionOverrideRule;
      provenance: ConversionRuleProvenance;
    }
  | {
      kind: "substitution";
      name: string;
      literal: string;
      provenance: ConversionRuleProvenance;
    };

/**
 * Next action for each refusal. A refusal names the construct or node; the
 * action says what has to change before the same command is rerun.
 */
export const CONVERSION_REFUSAL_NEXT_ACTIONS = Object.freeze({
  "conversion-ir-schema-unsupported":
    "Rebuild the conversion IR with this DocsFab version, then rerun the same command.",
  "conversion-unknown-node-kind":
    "The reader produced a node kind the conversion IR does not define. Report the reader defect with the node id and source path; the plan cannot be built until the reader emits only IR node kinds.",
  "conversion-ir-id-duplicate":
    "The reader gave two IR nodes the same id, or two substitution-table entries the same name. Report the reader defect with the id or name; ambiguity units and drop-ledger entries cite them.",
  "conversion-construct-name-not-normalized":
    "The reader left a directive or role name that is not lower case. Report the reader defect with the node id and source path; readers lower-case names as the source generator does.",
  "conversion-registry-invalid":
    "The construct rule registry has a rule that cannot apply as written. Fix the registry rule the message names, then rerun the same command.",
  "conversion-construct-unregistered":
    "The construct rule registry has no rule for this construct. Add exactly one rule for it to the registry, then rerun the same command.",
  "conversion-construct-ambiguous":
    "More than one rule applies to this construct. Keep exactly one registry rule, and at most one plan-level rule, for it, then rerun the same command.",
  "conversion-directive-not-normalized":
    "The reader left a directive as a generic directive node although the IR has a typed node for it. Report the reader defect with the node id and source path.",
  "conversion-source-missing":
    "A page the reader was asked to read is not a file under the documentation root. Rerun with the pages the source navigation names.",
  "conversion-source-encoding":
    "A source file is not valid UTF-8. Re-encode the file the message names as UTF-8, then rerun the same command.",
  "conversion-frontmatter-invalid":
    "A page's frontmatter is not a YAML mapping. Fix the frontmatter the message names, then rerun the same command.",
  "conversion-directive-options-invalid":
    "A directive's options cannot be read as written: a YAML option block that is not a mapping, or an option the reader does not support on that directive. Fix the options the message names, then rerun the same command.",
  "conversion-include-outside-root":
    "An include or page path resolves outside the documentation root, directly or through a symbolic link, and the reader never follows it. Move the file under the documentation root, or convert from a documentation root that contains it, then rerun the same command.",
  "conversion-include-missing":
    "An include names a local file that does not exist under the documentation root. Fix the include path or add the file, then rerun the same command.",
  "conversion-include-cycle":
    "Markup includes form a cycle, so the included content has no end. Remove the include that closes the cycle the message names, then rerun the same command.",
  "conversion-asset-outside-repository":
    "An image or download path resolves outside the repository. Move the asset into the repository or reference it by URL, then rerun the same command.",
  "conversion-image-title-unsupported":
    "A Markdown image title has no field in this conversion IR and would otherwise be lost. Move its meaning into visible alt text or a caption, then rerun the same command.",
  "conversion-substitution-conflict":
    "Two sources define the same substitution name with different values, and the substitution table holds one value per name. Rename one of them, then rerun the same command.",
  "conversion-configuration-not-static":
    "A configuration value the reader needs is not a static literal, and the reader never executes configuration code. Assign the value the message names as a literal, then rerun the same command.",
  "conversion-override-invalid":
    "Fix the plan-level rule the message names: it must map a directive or role to a registered one of the same family whose rule is convert (with parameters for the same intent), keep non-blank literal text, or drop with a non-blank reason; a substitution rule must name a substitution in the IR and set non-blank text. Then rerun the same command.",
} as const);

export type ConversionRefusalCode = keyof typeof CONVERSION_REFUSAL_NEXT_ACTIONS;

export class ConversionContractError extends Error {
  public readonly nextAction: string;
  public declare readonly construct?: string;
  public declare readonly nodeId?: string;

  public constructor(
    public readonly code: ConversionRefusalCode,
    message: string,
    details?: { readonly construct?: string; readonly nodeId?: string },
  ) {
    super(message);
    this.name = "ConversionContractError";
    this.nextAction = CONVERSION_REFUSAL_NEXT_ACTIONS[code];
    if (details?.construct !== undefined) this.construct = details.construct;
    if (details?.nodeId !== undefined) this.nodeId = details.nodeId;
  }
}
