// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { canonicalDigest, deepFreeze } from "../contract-kit/index.js";
import type {
  BadgeVariant,
  CalloutTone,
  ConstructDisposition,
  ConstructKey,
  ConstructRule,
  ConstructRuleRegistry,
  ConvertTarget,
  DropReason,
} from "./contracts.js";

/** Bump when a rule changes meaning; plans bind to the version and digest. */
export const CONSTRUCT_RULE_REGISTRY_VERSION = 1;

const convert = (target: ConvertTarget): ConstructDisposition => ({
  disposition: "convert",
  convert: target,
});
const drop = (reason: DropReason): ConstructDisposition => ({
  disposition: "drop-with-notice",
  reason,
});
const callout = (tone: CalloutTone): ConstructDisposition =>
  convert({ target: "callout", tone, title: "none" });
const markdown = convert({ target: "markdown" });
const inlineCode = convert({ target: "inline-code" });
const plainText = convert({ target: "plain-text" });
const strong = convert({ target: "strong" });
const badge = (variant: BadgeVariant): ConstructRule => ({
  construct: `role:bdg-${variant}`,
  rule: convert({ target: "badge", variant }),
});
const apiReference: ConstructDisposition = {
  disposition: "refuse",
  reason: "api-reference-generation",
  text: "API reference generation is a separate decision; supply a plan-level rule to drop or replace this directive.",
};
const navigationOwned = drop({
  code: "navigation-owned",
  text: "The navigation tree carries this content; the target builds navigation from it.",
});

const PYTHON_ROLES = ["class", "func", "meth", "mod", "attr", "obj", "data", "exc", "const"];

/**
 * The closed construct rule registry. Each construct key has exactly one rule;
 * `directive:*` and `role:*` decide every directive or role name without one.
 * Seeded from the legacy convert-to-fern construct tables and DocsFab's
 * MyST-to-Fern component mapping.
 */
export const CONSTRUCT_RULE_REGISTRY: ConstructRuleRegistry = deepFreeze({
  version: CONSTRUCT_RULE_REGISTRY_VERSION,
  rules: [
    { construct: "node:heading", rule: markdown },
    { construct: "node:paragraph", rule: markdown },
    { construct: "node:list", rule: markdown },
    { construct: "node:listItem", rule: markdown },
    { construct: "node:blockquote", rule: markdown },
    { construct: "node:thematicBreak", rule: markdown },
    {
      construct: "node:codeBlock",
      rule: convert({
        target: "code-block",
        keep: ["caption", "emphasize-lines", "line-numbers", "first-line-number"],
      }),
      improvement:
        "Caption and emphasized lines become code-block attributes instead of being dropped.",
    },
    { construct: "node:table", rule: convert({ target: "table", from: "node" }) },
    { construct: "node:definitionList", rule: markdown },
    { construct: "node:fieldList", rule: markdown },
    { construct: "node:lineBlock", rule: markdown },
    { construct: "node:footnoteDefinition", rule: markdown },
    {
      construct: "node:target",
      rule: convert({ target: "anchor" }),
      improvement: "Explicit targets become Fern anchors instead of being ignored.",
    },
    { construct: "node:comment", rule: convert({ target: "comment" }) },
    { construct: "node:html", rule: convert({ target: "html" }) },
    { construct: "node:math", rule: convert({ target: "math-block" }) },
    { construct: "node:image", rule: convert({ target: "image" }) },
    { construct: "node:figure", rule: convert({ target: "framed-image" }) },
    {
      construct: "include:literal",
      rule: convert({
        target: "code-include",
        honor: ["lines", "pyobject", "start-after", "end-before"],
        keep: ["caption", "emphasize-lines"],
      }),
      improvement:
        "The :lines: and :pyobject: selections are applied instead of inlining the whole file.",
    },
    {
      construct: "include:markup",
      rule: convert({ target: "markup-include" }),
      improvement: "Markup includes are expanded into the document tree instead of being dropped.",
    },
    {
      construct: "include:remote",
      rule: { disposition: "judge", unitKind: "remote-include" },
      improvement: "A remote include is never fetched; it becomes an ambiguity unit.",
    },
    { construct: "node:text", rule: markdown },
    { construct: "node:emphasis", rule: markdown },
    { construct: "node:strong", rule: markdown },
    { construct: "node:inlineCode", rule: markdown },
    { construct: "node:link", rule: markdown },
    { construct: "node:inlineImage", rule: convert({ target: "image" }) },
    { construct: "node:inlineHtml", rule: convert({ target: "html" }) },
    { construct: "node:inlineMath", rule: convert({ target: "math-inline" }) },
    { construct: "node:lineBreak", rule: markdown },
    { construct: "node:footnoteReference", rule: markdown },
    {
      construct: "node:substitutionReference",
      rule: convert({ target: "substitution", resolveIn: "substitution-table" }),
    },

    { construct: "directive:note", rule: callout("note") },
    { construct: "directive:seealso", rule: callout("note") },
    { construct: "directive:tip", rule: callout("tip") },
    { construct: "directive:hint", rule: callout("tip") },
    { construct: "directive:important", rule: callout("info") },
    { construct: "directive:versionadded", rule: callout("info") },
    { construct: "directive:versionchanged", rule: callout("info") },
    { construct: "directive:warning", rule: callout("warning") },
    { construct: "directive:caution", rule: callout("warning") },
    { construct: "directive:danger", rule: callout("warning") },
    { construct: "directive:attention", rule: callout("warning") },
    { construct: "directive:error", rule: callout("warning") },
    { construct: "directive:deprecated", rule: callout("warning") },
    {
      construct: "directive:admonition",
      rule: convert({ target: "collapsible", title: "argument" }),
    },
    {
      construct: "directive:dropdown",
      rule: convert({ target: "collapsible", title: "argument" }),
    },
    { construct: "directive:sidebar", rule: convert({ target: "collapsible", title: "argument" }) },
    { construct: "directive:tab-set", rule: convert({ target: "tabs" }) },
    { construct: "directive:tab-item", rule: convert({ target: "tab", title: "argument" }) },
    { construct: "directive:grid", rule: convert({ target: "card-group" }) },
    { construct: "directive:grid-item-card", rule: convert({ target: "card", title: "argument" }) },
    { construct: "directive:card", rule: convert({ target: "card", title: "argument" }) },
    { construct: "directive:button-link", rule: convert({ target: "link", resolveIn: "url" }) },
    {
      construct: "directive:button-ref",
      rule: convert({ target: "link", resolveIn: "label-table" }),
    },
    { construct: "directive:list-table", rule: convert({ target: "table", from: "list-table" }) },
    {
      construct: "directive:csv-table",
      rule: convert({ target: "table", from: "csv", quoting: "rfc4180", file: "local-only" }),
      improvement: "Quoted fields and the :file: option are honored; :url: is never fetched.",
    },
    { construct: "directive:mermaid", rule: convert({ target: "diagram", language: "mermaid" }) },
    {
      construct: "directive:doctest",
      rule: convert({ target: "code-block", keep: [], language: "python" }),
    },
    { construct: "directive:glossary", rule: convert({ target: "glossary" }) },
    { construct: "directive:rubric", rule: convert({ target: "heading", depth: 3 }) },
    { construct: "directive:topic", rule: convert({ target: "titled-block" }) },
    { construct: "directive:div", rule: convert({ target: "unwrap" }) },
    { construct: "directive:container", rule: convert({ target: "unwrap" }) },
    { construct: "directive:eval-rst", rule: convert({ target: "unwrap" }) },
    { construct: "directive:meta", rule: convert({ target: "frontmatter" }) },
    {
      construct: "directive:only",
      rule: { disposition: "judge", unitKind: "conditional-content" },
      improvement: "Conditional blocks are judged instead of being silently dropped.",
    },
    {
      construct: "directive:ifconfig",
      rule: { disposition: "judge", unitKind: "conditional-content" },
    },
    { construct: "directive:toctree", rule: navigationOwned },
    {
      construct: "directive:contents",
      rule: drop({
        code: "generated-by-target",
        text: "The target generates the on-page table of contents.",
      }),
    },
    {
      construct: "directive:raw",
      rule: drop({
        code: "no-target-equivalent",
        text: "Raw output for a non-HTML writer has no target equivalent; readers turn raw HTML into html nodes.",
      }),
    },
    {
      construct: "directive:todo",
      rule: drop({ code: "editorial-only", text: "Author to-do notes are not published." }),
    },
    {
      construct: "directive:todolist",
      rule: drop({ code: "editorial-only", text: "Author to-do lists are not published." }),
    },
    {
      construct: "directive:spelling:word-list",
      rule: drop({ code: "editorial-only", text: "Spell-checker word lists are build input." }),
    },
    {
      construct: "directive:automodule",
      rule: apiReference,
      improvement: "Autodoc output is refused until API reference generation is in scope.",
    },
    {
      construct: "directive:autoclass",
      rule: apiReference,
      improvement: "Autodoc output is refused until API reference generation is in scope.",
    },
    {
      construct: "directive:autofunction",
      rule: apiReference,
      improvement: "Autodoc output is refused until API reference generation is in scope.",
    },
    {
      construct: "directive:autosummary",
      rule: apiReference,
      improvement: "Autodoc output is refused until API reference generation is in scope.",
    },
    {
      construct: "directive:autodoc2-docstring",
      rule: apiReference,
      improvement: "Autodoc output is refused until API reference generation is in scope.",
    },
    { construct: "directive:*", rule: { disposition: "judge", unitKind: "custom-construct" } },

    {
      construct: "role:doc",
      rule: convert({ target: "cross-reference", resolveIn: "route-table" }),
    },
    {
      construct: "role:std:doc",
      rule: convert({ target: "cross-reference", resolveIn: "route-table" }),
    },
    {
      construct: "role:ref",
      rule: convert({ target: "cross-reference", resolveIn: "label-table" }),
    },
    {
      construct: "role:std:ref",
      rule: convert({ target: "cross-reference", resolveIn: "label-table" }),
    },
    { construct: "role:numref", rule: plainText },
    { construct: "role:any", rule: plainText },
    { construct: "role:abbreviation", rule: plainText },
    { construct: "role:abbr", rule: plainText },
    { construct: "role:samp", rule: inlineCode },
    { construct: "role:literal", rule: inlineCode },
    { construct: "role:code", rule: inlineCode },
    { construct: "role:sup", rule: markdown },
    { construct: "role:sub", rule: markdown },
    { construct: "role:title-reference", rule: plainText },
    { construct: "role:t", rule: plainText },
    { construct: "role:c:doc", rule: inlineCode },
    { construct: "role:cpp:doc", rule: inlineCode },
    { construct: "role:js:doc", rule: inlineCode },
    { construct: "role:term", rule: strong },
    { construct: "role:guilabel", rule: strong },
    { construct: "role:menuselection", rule: strong },
    { construct: "role:kbd", rule: convert({ target: "keyboard" }) },
    { construct: "role:envvar", rule: inlineCode },
    { construct: "role:confval", rule: inlineCode },
    { construct: "role:command", rule: inlineCode },
    { construct: "role:program", rule: inlineCode },
    { construct: "role:option", rule: inlineCode },
    { construct: "role:file", rule: inlineCode },
    { construct: "role:std:envvar", rule: inlineCode },
    {
      construct: "role:std:term",
      rule: strong,
      improvement: "Renders like role:term; the legacy converter rendered it as inline code.",
    },
    { construct: "role:std:option", rule: inlineCode },
    { construct: "role:std:program", rule: inlineCode },
    { construct: "role:std:command", rule: inlineCode },
    ...PYTHON_ROLES.flatMap((role): ConstructRule[] => [
      { construct: `role:${role}`, rule: inlineCode },
      { construct: `role:py:${role}`, rule: inlineCode },
    ]),
    { construct: "role:download", rule: convert({ target: "link", resolveIn: "asset-table" }) },
    { construct: "role:math", rule: convert({ target: "math-inline" }) },
    {
      construct: "role:octicon",
      rule: drop({ code: "decorative", text: "Icon glyphs have no target equivalent." }),
    },
    badge("primary"),
    badge("secondary"),
    badge("success"),
    badge("warning"),
    badge("danger"),
    badge("info"),
    badge("light"),
    badge("dark"),
    { construct: "role:*", rule: { disposition: "judge", unitKind: "custom-construct" } },
  ],
} satisfies ConstructRuleRegistry);

/** Digest of the registry content; a plan records it beside the version. */
export function constructRuleRegistryDigest(
  registry: ConstructRuleRegistry = CONSTRUCT_RULE_REGISTRY,
): string {
  return canonicalDigest(registry);
}

export const DIRECTIVE_FALLBACK_KEY: ConstructKey = "directive:*";
export const ROLE_FALLBACK_KEY: ConstructKey = "role:*";
