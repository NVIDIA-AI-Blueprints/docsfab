// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Structure and style guidance for authoring one documentation page against
 * its governed template. Guidance carries only a template's schema heading
 * rules, its heading skeleton, and its `@tpl:naming`, `@tpl:formatting`, and
 * `@tpl:optional` notes. Example blocks, untagged comments, and template body
 * prose are never extracted, so a template cannot supply product facts.
 */
import { constants as fsConstants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";

import { formatLimitObservation, limit } from "../config/limits.js";
import {
  mapPageToTemplate,
  type TemplateAuditInputPage,
  type TemplateAuditRefusalCode,
  type TemplateMappingBasis,
  type TemplateUnmappedReason,
} from "./audit.js";
import { listTemplates } from "./catalog.js";
import type { GovernedTemplateBundle } from "./contracts.js";
import {
  fencedCodeLines,
  parseStructuralSchema,
  type TemplateHeadingExpectation,
} from "./validate.js";

/** Bytes of one template's guidance, measured as its JSON text. */
export const PAGE_TEMPLATE_GUIDANCE_BYTES_LIMIT = "authoring.pageTemplateGuidanceMaxBytes" as const;

/**
 * Bytes of one authored page the host reads for template guidance and the
 * post-write template check. It is the planned-page bound, so every page a
 * plan may write can also be read here; a smaller read bound would refuse
 * pages the run is allowed to author.
 */
export const AUTHORED_PAGE_READ_BYTES_LIMIT = "authoring.plannedPageMaxBytes" as const;

const GUIDANCE_NOTE_KINDS = ["naming", "formatting", "optional"] as const;
export type TemplateGuidanceNoteKind = (typeof GUIDANCE_NOTE_KINDS)[number];

export interface TemplateGuidanceNoteV1 {
  readonly kind: TemplateGuidanceNoteKind;
  /** Trimmed non-empty lines of the note, joined by line breaks. */
  readonly text: string;
}

export interface TemplateSkeletonSectionV1 {
  /** `null` for notes that precede the template's first heading. */
  readonly heading: { readonly level: number; readonly text: string } | null;
  readonly notes: readonly TemplateGuidanceNoteV1[];
}

export type TemplateStructureGuidanceV1 =
  | {
      readonly templateId: string;
      readonly status: "included";
      readonly requiredHeadings: readonly TemplateHeadingExpectation[];
      readonly optionalHeadings: readonly TemplateHeadingExpectation[];
      readonly sectionOrder: readonly string[];
      readonly skeleton: readonly TemplateSkeletonSectionV1[];
    }
  | {
      readonly templateId: string;
      readonly status: "omitted";
      /** The limit observation naming the code, value, bound, and remediation. */
      readonly reason: string;
    };

export type PageTemplateSelectionV1 =
  | {
      readonly path: string;
      readonly status: "mapped";
      readonly templateId: string;
      readonly basis: TemplateMappingBasis;
      readonly signal: string;
    }
  | {
      readonly path: string;
      readonly status: "unmapped";
      readonly reason: TemplateUnmappedReason;
      readonly candidates: readonly string[];
    }
  | {
      /**
       * The page exists, but the host refused to read it. No template is
       * selected: its own `template:` key is unknown, so a path-based guess
       * could contradict it.
       */
      readonly path: string;
      readonly status: "refused";
      readonly code: TemplateAuditRefusalCode;
      /** Page size and read bound in bytes; set only for `page-too-large`. */
      readonly observedBytes?: number;
      readonly limitBytes?: number;
    };

/**
 * One page to guide: its current content, nothing for a new or absent page
 * (selected by its path), or the reader's refusal for a page that exists but
 * could not be read.
 */
export type PageTemplateGuidanceInput =
  | { readonly path: string; readonly content?: string }
  | Extract<TemplateAuditInputPage, { readonly refused: TemplateAuditRefusalCode }>;

/** Per-page template selections and each selected template's guidance, once. */
export interface PageTemplateGuidanceV1 {
  readonly pages: readonly PageTemplateSelectionV1[];
  readonly templates: readonly TemplateStructureGuidanceV1[];
}

/**
 * The governed template for one page, with the audit's mapping rules: an
 * explicit `template:` frontmatter key wins, then page-type keys, then path
 * conventions. A new page has no content and maps by its path alone.
 */
export function selectPageTemplate(input: {
  readonly bundle: GovernedTemplateBundle;
  readonly path: string;
  readonly content?: string;
}): PageTemplateSelectionV1 {
  const templateIds = new Set(
    listTemplates({ bundle: input.bundle }).templates.map((entry) => entry.id),
  );
  const mapping = mapPageToTemplate({
    path: input.path,
    content: input.content ?? "",
    templateIds,
  });
  return mapping.status === "mapped"
    ? {
        path: input.path,
        status: "mapped",
        templateId: mapping.templateId,
        basis: mapping.basis,
        signal: mapping.signal,
      }
    : {
        path: input.path,
        status: "unmapped",
        reason: mapping.reason,
        candidates: mapping.candidates,
      };
}

/**
 * Guidance for each page, in the given order; a page path appears once. A
 * refused page keeps its refusal and selects no template.
 */
export function pageTemplateGuidance(input: {
  readonly bundle: GovernedTemplateBundle;
  readonly pages: readonly PageTemplateGuidanceInput[];
}): PageTemplateGuidanceV1 {
  const seen = new Set<string>();
  const pages = input.pages.flatMap((page): PageTemplateSelectionV1[] => {
    if (seen.has(page.path)) return [];
    seen.add(page.path);
    if ("refused" in page) {
      const sized = page.refused === "page-too-large";
      return [
        {
          path: page.path,
          status: "refused",
          code: page.refused,
          ...(sized && page.observedBytes !== undefined
            ? { observedBytes: page.observedBytes }
            : {}),
          ...(sized && page.limitBytes !== undefined ? { limitBytes: page.limitBytes } : {}),
        },
      ];
    }
    return [selectPageTemplate({ bundle: input.bundle, path: page.path, content: page.content })];
  });
  const templateIds = [
    ...new Set(pages.flatMap((page) => (page.status === "mapped" ? [page.templateId] : []))),
  ];
  return {
    pages,
    templates: templateIds.map((templateId) => templateStructureGuidance(input.bundle, templateId)),
  };
}

/** One template's guidance, or why it was omitted when it exceeds its byte bound. */
export function templateStructureGuidance(
  bundle: GovernedTemplateBundle,
  templateId: string,
): TemplateStructureGuidanceV1 {
  const definition = bundle.manifest.templates.find((entry) => entry.id === templateId);
  if (!definition) throw new Error(`Template ${templateId} is not in the governed catalog.`);
  const schema = parseStructuralSchema(definition.schema.content);
  const guidance: TemplateStructureGuidanceV1 = {
    templateId,
    status: "included",
    requiredHeadings: schema.headings.filter((heading) => heading.required),
    optionalHeadings: schema.headings.filter((heading) => !heading.required),
    sectionOrder: schema.sectionOrder,
    skeleton: templateSkeleton(definition.template.content),
  };
  const bound = limit(PAGE_TEMPLATE_GUIDANCE_BYTES_LIMIT);
  const bytes = Buffer.byteLength(JSON.stringify(guidance), "utf8");
  return bytes > bound.value
    ? { templateId, status: "omitted", reason: formatLimitObservation(bound, bytes) }
    : guidance;
}

/**
 * The template's headings and tagged notes, in order. Frontmatter, fenced
 * code, untagged comments, `@tpl:example` and other tagged comments, and body
 * prose are dropped. A heading inside a comment, such as one in an example
 * block, is not part of the skeleton. Identical notes are kept once.
 */
export function templateSkeleton(content: string): TemplateSkeletonSectionV1[] {
  const lines = withoutFrontmatter(content.replace(/\r\n?/gu, "\n").split("\n"));
  const fenced = fencedCodeLines(lines);
  const sections: Array<{
    heading: TemplateSkeletonSectionV1["heading"];
    notes: TemplateGuidanceNoteV1[];
  }> = [{ heading: null, notes: [] }];
  const kept = new Set<string>();
  let comment: string[] | undefined;
  for (const [index, line] of lines.entries()) {
    if (comment) {
      const end = line.indexOf("-->");
      if (end < 0) {
        comment.push(line);
        continue;
      }
      comment.push(line.slice(0, end));
      addNote(comment.join("\n"));
      comment = undefined;
      continue;
    }
    if (fenced[index]) continue;
    const start = line.indexOf("<!--");
    if (start >= 0) {
      const rest = line.slice(start + "<!--".length);
      const end = rest.indexOf("-->");
      if (end >= 0) addNote(rest.slice(0, end));
      else comment = [rest];
      continue;
    }
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/u.exec(line.trim());
    if (heading) {
      sections.push({ heading: { level: heading[1]!.length, text: heading[2]! }, notes: [] });
    }
  }
  return sections.filter((section) => section.heading !== null || section.notes.length > 0);

  function addNote(body: string): void {
    const tagged = /^\s*@tpl:([a-z-]+)\b([\s\S]*)$/u.exec(body);
    const kind = tagged?.[1] as TemplateGuidanceNoteKind | undefined;
    if (!kind || !GUIDANCE_NOTE_KINDS.includes(kind)) return;
    const text = tagged![2]!
      .split("\n")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .join("\n");
    const key = `${kind}\0${text}`;
    if (!text || kept.has(key)) return;
    kept.add(key);
    sections.at(-1)!.notes.push({ kind, text });
  }
}

/**
 * One page's current working-tree bytes, bounded by the planned-page limit,
 * or `undefined` when the page is absent. A path through a symbolic link, or
 * one that is not a regular file, is refused as unreadable.
 */
export async function readWorkspacePage(
  workspacePath: string,
  path: string,
): Promise<TemplateAuditInputPage | undefined> {
  const limitBytes = limit(AUTHORED_PAGE_READ_BYTES_LIMIT).value;
  const segments = path.split("/");
  let current = workspacePath;
  let size = 0;
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink()) return { path, refused: "page-unreadable" };
      if (index === segments.length - 1) {
        if (!metadata.isFile()) return { path, refused: "page-unreadable" };
        size = metadata.size;
      }
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (code === "ENOENT" || code === "ENOTDIR") return undefined;
      return { path, refused: "page-unreadable" };
    }
  }
  if (size > limitBytes) {
    return { path, refused: "page-too-large", observedBytes: size, limitBytes };
  }
  let bytes: Buffer;
  try {
    const handle = await open(current, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      bytes = await handle.readFile();
    } finally {
      await handle.close();
    }
  } catch {
    // hygiene: refusal — a page that cannot be opened is reported as unreadable.
    return { path, refused: "page-unreadable" };
  }
  if (bytes.byteLength > limitBytes) {
    return { path, refused: "page-too-large", observedBytes: bytes.byteLength, limitBytes };
  }
  try {
    return { path, content: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    // hygiene: refusal — invalid UTF-8 is reported as a refused page, not a failure.
    return { path, refused: "page-not-utf8" };
  }
}

function withoutFrontmatter(lines: string[]): string[] {
  if (lines[0]?.trim() !== "---") return lines;
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (line === "---" || line === "...") return lines.slice(index + 1);
  }
  return lines;
}
