// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AmbiguityAnswer, ConversionDocument, ConversionIrV1 } from "../contracts.js";
import type { ConstructRuleIndex } from "../resolver.js";

/**
 * Fern's built-in components that the page emitter writes. Decision C2 allows
 * no custom components, so the MDX check refuses any other capitalized tag.
 */
export const FERN_BUILT_IN_COMPONENTS = Object.freeze([
  "Accordion",
  "Card",
  "CardGroup",
  "Frame",
  "Info",
  "Note",
  "Tab",
  "Tabs",
  "Tip",
  "Warning",
] as const);

export type FernBuiltInComponent = (typeof FERN_BUILT_IN_COMPONENTS)[number];

/** Frontmatter values the conversion plan supplies; the emitter never invents them. */
export interface FernPageFrontmatter {
  /** Page title from the plan's source title policy. */
  title?: string;
  slug?: string;
  /** Written as Fern's `canonical-url` key. */
  canonicalUrl?: string;
}

/** What the emitter asks the caller for when a node names another file. */
export interface FernSourceRequest {
  documentId: string;
  /** Repository-relative path of the page that names the file. */
  sourcePath: string;
  nodeId: string;
  /** The path as the source wrote it. */
  path: string;
}

/**
 * Source content the apply stage resolves. The emitter reads no files; a
 * missing answer is refused, never skipped.
 */
export interface FernEmitSources {
  /** Text of a literal include or a `csv-table` `:file:`. */
  readText?(request: FernSourceRequest): string | undefined;
  /** The conversion IR document of a markup include. */
  document?(request: FernSourceRequest): ConversionDocument | undefined;
}

export interface FernPageInput {
  ir: ConversionIrV1;
  documentId: string;
  /** Registry rules with the approved plan-level rules applied. */
  rules: ConstructRuleIndex;
  /** Validated answers keyed by ambiguity unit id (`unit:node:<node id>`). */
  answers?: ReadonlyMap<string, AmbiguityAnswer>;
  frontmatter?: FernPageFrontmatter;
  sources?: FernEmitSources;
}

/**
 * Next action for each emitter refusal. A refused page is not written; the
 * action says what has to change before the same command is rerun.
 */
export const FERN_EMIT_REFUSAL_NEXT_ACTIONS = Object.freeze({
  "fern-document-unknown":
    "Name a document id that the conversion IR contains, then rerun the same command.",
  "fern-intent-unknown":
    "The Fern page emitter has no emitter for this convert intent. Add one to FERN_INTENT_EMITTERS, or change the plan-level rule to a supported intent, then rerun the same command.",
  "fern-intent-node-mismatch":
    "The rule applies a convert intent to a node it cannot render. Fix the registry or plan-level rule for the construct, then rerun the same command.",
  "fern-node-unresolved":
    "The node's ambiguity unit has no usable answer. Answer the unit or add a plan-level rule for the construct, approve the plan, then rerun the same command.",
  "fern-node-refused":
    "The construct is refused until a plan-level rule covers it. Add the rule, approve the plan, then rerun the same command.",
  "fern-source-missing":
    "The emitter needs the content of a file the node names. Supply it through the emit sources, then rerun the same command.",
  "fern-source-remote":
    "The node names a remote URL, which conversion never fetches. Replace the source with a local file or add a plan-level rule, then rerun the same command.",
  "fern-include-cycle":
    "Markup includes form a cycle. Break the cycle in the source or drop one include with a plan-level rule, then rerun the same command.",
  "fern-include-selection-failed":
    "A literal include selects lines, a Python object, or a marker that the file does not contain. Fix the include options or the file, then rerun the same command.",
  "fern-substitution-unresolved":
    "The substitution has no literal value. Add a plan-level substitution rule, approve the plan, then rerun the same command.",
  "fern-body-unparsed":
    "The directive body is unparsed source text where the intent needs blocks. Report the reader defect with the node id and source path.",
  "fern-table-shape-invalid":
    "The table source does not have the shape its directive requires. Fix the table in the source, then rerun the same command.",
  "fern-mdx-unsafe":
    "The emitted page failed the MDX safety check. Report the emitter defect with the document id and the finding.",
} as const);

export type FernEmitRefusalCode = keyof typeof FERN_EMIT_REFUSAL_NEXT_ACTIONS;

export interface FernEmitRefusal {
  code: FernEmitRefusalCode;
  message: string;
  nextAction: string;
  nodeId?: string;
  construct?: string;
}

/** Content the page keeps in another form, or source detail Fern cannot carry. */
export type FernEmitNoticeCode =
  | "option-not-emitted"
  | "attribute-not-emitted"
  | "caption-flattened"
  | "heading-depth-clipped"
  | "html-wrapped"
  | "badge-variant-not-emitted"
  | "title-missing"
  | "cross-reference-title-unresolved"
  | "include-lines-beyond-end"
  | "answer-drop"
  | "frontmatter-key-not-emitted";

export interface FernEmitNotice {
  code: FernEmitNoticeCode;
  nodeId: string;
  detail: string;
}

export type FernPageResult =
  | { status: "emitted"; documentId: string; text: string; notices: FernEmitNotice[] }
  | {
      status: "refused";
      documentId: string;
      refusals: FernEmitRefusal[];
      notices: FernEmitNotice[];
    };
