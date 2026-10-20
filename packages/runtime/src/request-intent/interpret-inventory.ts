// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The documentation inventory the interpretation prompt lists: every tracked
 * Markdown and MDX page under the documentation roots, with its title.
 *
 * Repository text only, never request text. I/O goes through the injected
 * listing and tracked-byte reader, so the gate and the producer read one
 * revision. Navigation labels need a navigation parser this module does not
 * have yet, so every label is null.
 */
import { enforceLimit, limit, type ResolvedLimit } from "../config/limits.js";
import { withinWriteCeiling } from "../host-invoker/wire-decode.js";

export interface RequestIntentPromptInventoryEntry {
  readonly path: string;
  readonly title: string | null;
  readonly navLabel: string | null;
}

export interface RequestIntentPromptInventory {
  readonly entries: readonly RequestIntentPromptInventoryEntry[];
  /** Titles cut at `requestIntent.maxInventoryTitleChars`; shown on the record. */
  readonly clippedTitles: number;
}

export interface RequestIntentInventoryLimits {
  readonly maxPromptInventoryEntries: ResolvedLimit;
  readonly maxInventoryTitleChars: ResolvedLimit;
  readonly maxInventoryPathChars: ResolvedLimit;
  /** Bytes of one page read for its title. */
  readonly maxPageBytes: ResolvedLimit;
}

/** The inventory bounds in force, each read from its own catalog entry. */
export function resolvePromptInventoryLimits(): RequestIntentInventoryLimits {
  return {
    maxPromptInventoryEntries: limit("requestIntent.maxPromptInventoryEntries"),
    maxInventoryTitleChars: limit("requestIntent.maxInventoryTitleChars"),
    maxInventoryPathChars: limit("requestIntent.maxInventoryPathChars"),
    // A page larger than authoring may write is larger than any page it reads for a title.
    maxPageBytes: limit("authoring.plannedPageMaxBytes"),
  };
}

const PAGE_EXTENSION = /\.mdx?$/iu;
const ELLIPSIS = "…";

/**
 * Build the prompt inventory. Refuses through the limit, never by listing a
 * subset: a page left off the list would read to the model as absent.
 */
export async function buildRequestIntentPromptInventory(input: {
  /** The tracked listing, as `listTrackedRepositoryEntries` returns it. */
  readonly entries: readonly {
    readonly path?: string;
    readonly kind: string;
    readonly byteLength?: number;
  }[];
  readonly readTrackedBytes: (path: string, maxBytes: number) => Promise<Uint8Array>;
  /** Documentation roots: directories with their trailing slash, files without one. */
  readonly docsRoots: readonly string[];
  /** Exact tracked Sphinx pages admitted for the update operation only. */
  readonly rstUpdatePaths?: readonly string[];
  readonly limits: RequestIntentInventoryLimits;
}): Promise<RequestIntentPromptInventory> {
  const pages = input.entries
    .filter(
      (entry): entry is { path: string; kind: string; byteLength?: number } =>
        entry.kind === "regular" &&
        typeof entry.path === "string" &&
        (PAGE_EXTENSION.test(entry.path) || input.rstUpdatePaths?.includes(entry.path) === true) &&
        withinWriteCeiling(entry.path, input.docsRoots),
    )
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  enforceLimit(input.limits.maxPromptInventoryEntries, pages.length);
  for (const page of pages) {
    enforceLimit(input.limits.maxInventoryPathChars, page.path.length);
    if (page.byteLength !== undefined) enforceLimit(input.limits.maxPageBytes, page.byteLength);
  }
  let clippedTitles = 0;
  const entries: RequestIntentPromptInventoryEntry[] = [];
  for (const page of pages) {
    const bytes = await input.readTrackedBytes(page.path, input.limits.maxPageBytes.value);
    const title = pageTitle(new TextDecoder("utf-8", { fatal: false }).decode(bytes));
    const clipped =
      title === null ? null : clipTitle(title, input.limits.maxInventoryTitleChars.value);
    if (clipped !== null && clipped !== title) clippedTitles += 1;
    entries.push({ path: page.path, title: clipped, navLabel: null });
  }
  return { entries, clippedTitles };
}

/**
 * The page's frontmatter `title`, else its first level-one ATX heading outside
 * a code fence, else null. Fern renders frontmatter `title` as the H1, so it
 * wins.
 */
export function pageTitle(text: string): string | null {
  const lines = text.replace(/^﻿/u, "").split(/\r?\n/u);
  let index = 0;
  if (lines[0]?.trim() === "---") {
    const close = lines.findIndex((line, at) => at > 0 && line.trim() === "---");
    if (close > 0) {
      for (const line of lines.slice(1, close)) {
        const match = /^title:\s*(.+?)\s*$/u.exec(line);
        if (match) {
          const value = unquote(match[1]!);
          if (value.length > 0) return value;
        }
      }
      index = close + 1;
    }
  }
  let fence: string | undefined;
  for (const line of lines.slice(index)) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
    if (marker) {
      if (fence === undefined) fence = marker[0];
      else if (marker[0] === fence) fence = undefined;
      continue;
    }
    if (fence !== undefined) continue;
    const heading = /^\s{0,3}#[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/u.exec(line)?.[1];
    if (heading && heading.trim().length > 0) return heading.trim();
  }
  return null;
}

function unquote(value: string): string {
  const quoted = /^(["'])(.*)\1$/u.exec(value);
  return (quoted ? quoted[2]! : value).trim();
}

/** Cut to `maxChars` UTF-16 code units, ellipsis included, never splitting a pair. */
export function clipTitle(title: string, maxChars: number): string {
  if (title.length <= maxChars) return title;
  let cut = title.slice(0, Math.max(0, maxChars - ELLIPSIS.length));
  cut = cut.replace(/[\uD800-\uDBFF]$/u, "");
  return `${cut}${ELLIPSIS}`;
}
