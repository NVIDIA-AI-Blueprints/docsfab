// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The governed template guidance a documentation planner or writer reads for
 * its pages. It states structure and style only; the advisory post-write
 * template check, not this text, reports a page that departs from it.
 */
import {
  AUTHORED_PAGE_READ_BYTES_LIMIT,
  type PageTemplateGuidanceV1,
  type PageTemplateSelectionV1,
  type TemplateGuidanceNoteV1,
} from "../templates/page-guidance.js";
import type { TemplateHeadingExpectation } from "../templates/validate.js";

export const PAGE_TEMPLATE_GUIDANCE_HEADER =
  "Page template guidance (structure and style only, computed by the host from the governed template library before this step):";

/**
 * The prompt block for `guidance`. It opens with a blank line, so it never
 * joins a host-owned section above it.
 */
export function pageTemplateGuidancePrompt(guidance: PageTemplateGuidanceV1): string {
  if (guidance.pages.length === 0) return "";
  return [
    "",
    "",
    PAGE_TEMPLATE_GUIDANCE_HEADER,
    "This guidance describes page structure, heading names, section order, and writing style only. It is never a source of product facts: take every product name, command, version, value, and claim from the bound sources and the repository, never from a template. Bracketed text such as [Product Name] is a placeholder: replace it with sourced content or leave it out, never copy it.",
    "When the documentation site renders the frontmatter title as the page H1, as Fern and Docusaurus do, the page must not add a Markdown H1: the frontmatter title is the H1. Otherwise the page has exactly one Markdown H1.",
    "For a page that already exists, apply the template structure to the sections the request adds or changes; do not restructure content the request does not ask to change.",
    "Heading patterns are case-insensitive regular expressions matched within the heading text.",
    ...guidance.pages.map(pageLine),
    ...guidance.templates.flatMap((template) => {
      if (template.status === "omitted") {
        return [`Template ${template.templateId}: guidance omitted. ${template.reason}`];
      }
      return [
        `Template ${template.templateId}:`,
        ...headingLines("Required headings", template.requiredHeadings),
        ...headingLines("Optional headings", template.optionalHeadings),
        ...(template.sectionOrder.length > 0
          ? [`  Section order: ${template.sectionOrder.map((entry) => `/${entry}/`).join(", ")}`]
          : []),
        "  Heading skeleton, with the template's naming, formatting, and optional-section notes:",
        ...template.skeleton.flatMap((section) => [
          section.heading
            ? `  ${"#".repeat(section.heading.level)} ${section.heading.text}`
            : "  (whole page)",
          ...section.notes.map(noteLine),
        ]),
      ];
    }),
    "End of page template guidance.",
    "",
    "",
  ].join("\n");
}

function pageLine(page: PageTemplateSelectionV1): string {
  const name = JSON.stringify(page.path);
  switch (page.status) {
    case "mapped":
      return `Page ${name}: template ${page.templateId} (selected by ${page.basis}: ${JSON.stringify(page.signal)}).`;
    case "unmapped":
      return `Page ${name}: no template guidance (${page.reason}${page.candidates.length > 0 ? `; candidates ${page.candidates.join(", ")}` : ""}). Follow the repository's existing conventions for this page.`;
    case "refused":
      return `Page ${name}: no template guidance, because the host could not read the current page (${refusalReason(page)}). Its own template choice is unknown, so keep the page's existing structure and headings, and do not restructure it to match a template.`;
  }
}

function refusalReason(page: Extract<PageTemplateSelectionV1, { status: "refused" }>): string {
  switch (page.code) {
    case "page-too-large":
      return `page-too-large: ${page.observedBytes ?? "unknown"} bytes exceeds ${AUTHORED_PAGE_READ_BYTES_LIMIT}, ${page.limitBytes ?? "unknown"} bytes`;
    case "page-not-utf8":
      return "page-not-utf8: the page bytes are not valid UTF-8";
    case "page-unreadable":
      return "page-unreadable: the page is not a readable regular file";
  }
}

function headingLines(
  label: string,
  headings: readonly TemplateHeadingExpectation[],
): readonly string[] {
  if (headings.length === 0) return [];
  return [
    `  ${label}:`,
    ...headings.map(
      (heading) =>
        `  - H${heading.level} /${heading.pattern}/${heading.description ? `: ${heading.description}` : ""}`,
    ),
  ];
}

function noteLine(note: TemplateGuidanceNoteV1): string {
  return `      ${note.kind}: ${note.text.split("\n").join("\n        ")}`;
}
