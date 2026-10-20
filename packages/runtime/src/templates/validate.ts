// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { canonicalDigest } from "../content-ir/index.js";
import { listTemplates, validateGovernedTemplateBundle } from "./catalog.js";
import type { GovernedTemplateBundle, TemplateOutputPreview } from "./contracts.js";

export type TemplateFindingSeverity = "error" | "warning" | "info";

export interface TemplateValidationFinding {
  rule:
    | "missing-required-heading"
    | "duplicate-h1"
    | "wrong-section-order"
    | "unresolved-template-placeholder";
  severity: TemplateFindingSeverity;
  expected: string;
  line: number | null;
}

export interface TemplatePageValidation {
  schemaVersion: 1;
  policy: { id: string; version: string; digest: string };
  path: string;
  templateId: string;
  format: "gfm" | "myst";
  templateSha256: string;
  schemaSha256: string;
  status: "passed" | "failed";
  findings: TemplateValidationFinding[];
  digest: string;
}

const TEMPLATE_STRUCTURAL_VALIDATION_POLICY = Object.freeze({
  id: "docsfab:template-structural-blocking",
  version: "1",
  digest: canonicalDigest({
    id: "docsfab:template-structural-blocking",
    version: "1",
    rules: ["required-headings", "duplicate-h1", "section-order", "unresolved-placeholders"],
  }),
});

/** One heading rule from a template's structural schema. */
export interface TemplateHeadingExpectation {
  level: number;
  /** A case-insensitive regular expression searched within the heading text. */
  pattern: string;
  required: boolean;
  description?: string;
}

export interface TemplateStructuralSchema {
  headings: TemplateHeadingExpectation[];
  sectionOrder: string[];
}

/** Deterministic TypeScript port of the structural tpl-lint checks needed by the MVP. */
export function validatePage(input: {
  bundle: GovernedTemplateBundle;
  page: TemplateOutputPreview;
}): TemplatePageValidation {
  const bundle = validateGovernedTemplateBundle(input.bundle);
  const catalog = listTemplates({ bundle });
  const definition = bundle.manifest.templates.find(
    (entry) =>
      entry.format === input.page.format &&
      entry.template.sha256 === input.page.template.sha256 &&
      entry.schema.sha256 === input.page.schema.sha256,
  );
  const catalogEntry = catalog.templates.find((entry) => entry.id === definition?.id);
  if (
    !definition ||
    !catalogEntry ||
    !sameProvenance(input.page.template, catalogEntry.template) ||
    !sameProvenance(input.page.schema, catalogEntry.schema)
  ) {
    throw new Error("Template page is not bound to the governed catalog.");
  }
  if (sha256Text(input.page.content) !== input.page.contentSha256) {
    throw new Error("Template page content digest does not match its preview.");
  }
  const schema = parseStructuralSchema(definition.schema.content);
  const headings = markdownHeadings(input.page.content);
  const findings: TemplateValidationFinding[] = [];
  for (const expected of schema.headings.filter((heading) => heading.required)) {
    const expression = safeExpression(expected.pattern);
    if (
      !headings.some((heading) => heading.level === expected.level && expression.test(heading.text))
    ) {
      findings.push({
        rule: "missing-required-heading",
        severity: "error",
        expected: `h${expected.level}:${expected.pattern}`,
        line: null,
      });
    }
  }
  const h1 = headings.filter((heading) => heading.level === 1);
  if (h1.length > 1) {
    findings.push({
      rule: "duplicate-h1",
      severity: "error",
      expected: "at-most-one-h1",
      line: h1[1]!.line,
    });
  }
  const ordered = schema.sectionOrder
    .map((pattern) => ({
      pattern,
      index: headings.findIndex((heading) => safeExpression(pattern).test(heading.text)),
    }))
    .filter((entry) => entry.index >= 0);
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index]!.index < ordered[index - 1]!.index) {
      findings.push({
        rule: "wrong-section-order",
        severity: "warning",
        expected: ordered[index]!.pattern,
        line: headings[ordered[index]!.index]?.line ?? null,
      });
    }
  }
  const unresolved = unresolvedPlaceholders(input.page.content);
  if (unresolved.length > 0) {
    findings.push({
      rule: "unresolved-template-placeholder",
      severity: "warning",
      expected: `${unresolved.length}-explicit-placeholder(s)`,
      line: unresolved[0]!.line,
    });
  }
  findings.sort(
    (left, right) =>
      severityRank(left.severity) - severityRank(right.severity) ||
      compareText(left.rule, right.rule) ||
      compareText(left.expected, right.expected) ||
      (left.line ?? Number.MAX_SAFE_INTEGER) - (right.line ?? Number.MAX_SAFE_INTEGER),
  );
  const value = {
    schemaVersion: 1 as const,
    policy: TEMPLATE_STRUCTURAL_VALIDATION_POLICY,
    path: input.page.path,
    templateId: definition.id,
    format: definition.format,
    templateSha256: definition.template.sha256,
    schemaSha256: definition.schema.sha256,
    status: findings.some((finding) => finding.severity === "error")
      ? ("failed" as const)
      : ("passed" as const),
    findings,
  };
  return { ...value, digest: canonicalDigest(value) };
}

/** The heading rules and section order of an upstream YAML template schema. */
export function parseStructuralSchema(content: string): TemplateStructuralSchema {
  if (content.trimStart().startsWith("{")) return { headings: [], sectionOrder: [] };
  const headings: TemplateHeadingExpectation[] = [];
  const sectionOrder: string[] = [];
  let headingLevel: number | undefined;
  let required: boolean | undefined;
  let inHeadings = false;
  let inSectionOrder = false;
  for (const rawLine of content.split("\n")) {
    const indent = rawLine.match(/^\s*/u)?.[0].length ?? 0;
    const line = rawLine.trim();
    if (line === "headings:") {
      inHeadings = true;
      inSectionOrder = false;
      continue;
    }
    if (line === "section_order:") {
      inHeadings = false;
      inSectionOrder = true;
      continue;
    }
    if (indent <= 2 && line.endsWith(":") && line !== "structure:") {
      inHeadings = false;
      inSectionOrder = false;
    }
    if (inHeadings) {
      const heading = line.match(/^h([1-6]):$/u);
      if (heading) {
        headingLevel = Number(heading[1]);
        required = undefined;
        continue;
      }
      if (line === "required:") {
        required = true;
        continue;
      }
      if (line === "optional:") {
        required = false;
        continue;
      }
      const pattern = line.match(/^-\s+pattern:\s*(.+)$/u)?.[1];
      if (pattern && headingLevel && required !== undefined) {
        headings.push({ level: headingLevel, pattern: yamlScalar(pattern), required });
        continue;
      }
      // A description belongs to the pattern entry it follows.
      const description = line.match(/^description:\s*(.+)$/u)?.[1];
      const last = headings.at(-1);
      if (description && last && last.level === headingLevel && last.required === required) {
        last.description ??= yamlScalar(description);
      }
    } else if (inSectionOrder) {
      const item = line.match(/^-[ ]+(.+)$/u)?.[1];
      if (item) sectionOrder.push(yamlScalar(item));
    }
  }
  if (headings.length === 0) throw new Error("Template schema has no structural heading rules.");
  return { headings, sectionOrder };
}

function yamlScalar(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) {
    return JSON.parse(value) as string;
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replaceAll("''", "'");
  return value;
}

/**
 * Marks each line that opens, closes, or sits inside a fenced code block. As
 * in CommonMark, a fence closes only on the opening character repeated at
 * least as many times with nothing after it, so a ```` fence may hold ```.
 * Any indentation is accepted, because fences nested in list items are
 * indented past the CommonMark three-space limit.
 */
export function fencedCodeLines(lines: readonly string[]): boolean[] {
  let open: { char: string; length: number } | undefined;
  return lines.map((line) => {
    const marker = /^\s*(`{3,}|~{3,})(.*)$/u.exec(line);
    if (!open) {
      if (!marker || (marker[1]![0] === "`" && marker[2]!.includes("`"))) return false;
      open = { char: marker[1]![0]!, length: marker[1]!.length };
      return true;
    }
    if (
      marker &&
      marker[1]![0] === open.char &&
      marker[1]!.length >= open.length &&
      marker[2]!.trim() === ""
    ) {
      open = undefined;
    }
    return true;
  });
}

function markdownHeadings(content: string): Array<{ level: number; text: string; line: number }> {
  const result: Array<{ level: number; text: string; line: number }> = [];
  const lines = content.split("\n");
  const fenced = fencedCodeLines(lines);
  for (const [index, rawLine] of lines.entries()) {
    if (fenced[index]) continue;
    const line = rawLine.trim();
    const match = line.match(/^(#{1,6})\s+(.+?)\s*$/u);
    if (match) result.push({ level: match[1]!.length, text: match[2]!, line: index + 1 });
  }
  return result;
}

function unresolvedPlaceholders(content: string): Array<{ text: string; line: number }> {
  const result: Array<{ text: string; line: number }> = [];
  for (const [index, line] of content.split("\n").entries()) {
    for (const match of line.matchAll(
      /\[(?:[A-Z][^\]\n]{0,79}|(?:org|repo|registry|image|tag|package(?:-name|_name)?))\](?!\()/gu,
    )) {
      result.push({ text: match[0], line: index + 1 });
    }
  }
  return result;
}

function safeExpression(pattern: string): RegExp {
  if (pattern.length > 512) throw new Error("Template schema heading pattern is too large.");
  try {
    // Upstream tpl-lint treats schema patterns as searches within a heading,
    // so titles such as "Quick Start Guide for DocsFab" satisfy "Quick Start".
    return new RegExp(pattern, "iu");
  } catch {
    throw new Error("Template schema heading pattern is invalid.");
  }
}

function severityRank(severity: TemplateFindingSeverity): number {
  return severity === "error" ? 0 : severity === "warning" ? 1 : 2;
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sameProvenance(
  left: TemplateOutputPreview["template"],
  right: TemplateOutputPreview["template"],
): boolean {
  return (
    left.sourceRepository === right.sourceRepository &&
    left.sourceRevision === right.sourceRevision &&
    left.sourcePath === right.sourcePath &&
    left.version === right.version &&
    left.license === right.license &&
    left.sha256 === right.sha256
  );
}
