// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Bounded merged-MR pagination for the UPDATE journey. Transport-free: pages
 * arrive through an injected port in the `list_merged` page shape.
 *
 * - Dedupe: a merge landing between fetches shifts later pages, so the same MR
 *   can appear twice. Rows are keyed by `iid`, first occurrence wins, and
 *   repeats are recorded, not counted as evidence.
 * - Ordering is verified, not trusted: a port declaring
 *   `orderedDescendingByMergedAt` earns the early stop only while pages read
 *   stay descending, and the stop reads one confirmation page past the trigger.
 *   A violation ends the walk `ordering-violated`.
 * - Port rejections and malformed rows are recorded as `MERGED_MR_FAILURE_CODES`
 *   entries, never upstream text, so no error string reaches a result a caller
 *   might write back to GitLab.
 *
 * Only `complete` and `exhausted-empty` report the window as covered.
 */

import {
  type MergedMrDateWindowV1,
  type MergedMrEvidenceGapV1,
  type MergedMrExclusionV1,
  type MergedMrProjectScopeV1,
  type MergedMrRecordV1,
  type MergedMrSelectedV1,
  parseMergedAtMs,
  selectMergedMrRecords,
} from "./merged-mr-selection.js";

/** Default page ceiling; far tighter than GitLab's 1000-page maximum. */
export const MERGED_MR_DEFAULT_PAGE_LIMIT = 50;
/**
 * Soft, post-page row cap: the page that crosses it is processed in full, so a
 * walk reads at most this many rows plus one page.
 */
export const MERGED_MR_DEFAULT_ROW_LIMIT = 1_000;

/** Same keys as `GITLAB_READ_FAILURES` in `src/live-agent/gitlab-read.ts`, without message text. */
export const MERGED_MR_FAILURE_CODES = [
  "repository",
  "authentication",
  "access",
  "network",
  "timeout",
  "request",
  "response",
  "credentials",
] as const;

export type MergedMrFailureCodeV1 = (typeof MERGED_MR_FAILURE_CODES)[number];

export interface MergedMrPageV1 {
  readonly items: readonly MergedMrRecordV1[];
  readonly nextPage: number | null;
  readonly truncated?: boolean;
}

/**
 * A port must declare `orderedDescendingByMergedAt`; one that declares it false
 * gets no early stop at the window start. A failure rejects with a `code` from
 * `MERGED_MR_FAILURE_CODES`; an untagged rejection is recorded as `request`,
 * and no message is retained.
 */
export interface MergedMrPagePortV1 {
  readonly orderedDescendingByMergedAt: boolean;
  fetchPage(page: number): Promise<MergedMrPageV1>;
}

export type MergedMrDiscoveryDispositionV1 =
  | "complete"
  | "exhausted-empty"
  | "page-limit-reached"
  | "item-limit-reached"
  | "page-failed"
  | "ordering-violated"
  | "cancelled";

export interface MergedMrDiscoveryResultV1 {
  readonly schemaVersion: 1;
  readonly kind: "docsfab-merged-mr-discovery";
  readonly window: MergedMrDateWindowV1;
  readonly targetBranch: string;
  readonly disposition: MergedMrDiscoveryDispositionV1;
  /** True only for `complete` and `exhausted-empty`. */
  readonly windowCovered: boolean;
  readonly selected: readonly MergedMrSelectedV1[];
  readonly excluded: readonly MergedMrExclusionV1[];
  readonly pagesRead: number;
  readonly lastGoodPage: number;
  /** Every row the port returned, including repeats from a shifting list. */
  readonly rowsRead: number;
  /** Distinct merge requests considered; the denominator for the evidence. */
  readonly itemsRead: number;
  /** Merge-request numbers the port returned more than once, in first-seen order. */
  readonly duplicateRows: readonly number[];
  readonly failureCode: MergedMrFailureCodeV1 | null;
  readonly truncatedPages: readonly number[];
}

export interface MergedMrDiscoveryOptionsV1 {
  readonly port: MergedMrPagePortV1;
  readonly window: MergedMrDateWindowV1;
  readonly targetBranch: string;
  readonly project?: MergedMrProjectScopeV1;
  readonly maxPages?: number;
  readonly maxRows?: number;
  readonly signal?: AbortSignal;
}

function requireBound(value: number | undefined, fallback: number, label: string): number {
  const bound = value ?? fallback;
  if (!Number.isSafeInteger(bound) || bound <= 0) {
    throw new Error(
      `A bounded merged-MR walk requires a positive integer ${label} ceiling before it reads any page. Received: ${JSON.stringify(value)}.`,
    );
  }
  return bound;
}

function requirePageShape(page: MergedMrPageV1, requested: number): void {
  if (!page || typeof page !== "object" || !Array.isArray(page.items)) {
    throw new Error(
      `A merged-MR page port must return an items array for every page it accepts. Page requested: ${requested}.`,
    );
  }
  const nextPage = page.nextPage;
  if (nextPage === null || nextPage === undefined) return;
  if (!Number.isSafeInteger(nextPage) || nextPage <= requested) {
    throw new Error(
      `A merged-MR page port must advance nextPage beyond the page it just returned, or report null. Page requested: ${requested}; nextPage reported: ${JSON.stringify(nextPage)}.`,
    );
  }
}

function withTruncatedPageGap(entry: MergedMrSelectedV1): MergedMrSelectedV1 {
  if (entry.evidenceGaps.includes("truncated-source-page")) return entry;
  const gaps: readonly MergedMrEvidenceGapV1[] = [...entry.evidenceGaps, "truncated-source-page"];
  return Object.freeze({ ...entry, evidenceGaps: Object.freeze(gaps) });
}

function failureCodeOf(error: unknown): MergedMrFailureCodeV1 {
  const tagged = (error as { code?: unknown } | null)?.code;
  return MERGED_MR_FAILURE_CODES.includes(tagged as MergedMrFailureCodeV1)
    ? (tagged as MergedMrFailureCodeV1)
    : "request";
}

/**
 * False as soon as a row is newer than one already read, within the page or
 * against the previous page. Rows without a usable timestamp are skipped; the
 * selector reports them separately.
 */
function pageKeepsDescendingOrder(
  items: readonly MergedMrRecordV1[],
  previousMs: number | null,
): { ordered: boolean; lastMs: number | null } {
  let boundary = previousMs;
  for (const item of items) {
    const parsed = parseMergedAtMs(item?.mergedAt);
    if (parsed === null) continue;
    if (boundary !== null && parsed > boundary) return { ordered: false, lastMs: boundary };
    boundary = parsed;
  }
  return { ordered: true, lastMs: boundary };
}

/**
 * Walk the injected port within explicit bounds and report one disposition.
 * The walk stops early only when the port declares descending order, the pages
 * read have upheld it, and a fully read page fell below the window start.
 */
export async function discoverMergedMrs(
  options: MergedMrDiscoveryOptionsV1,
): Promise<MergedMrDiscoveryResultV1> {
  const { port, window, targetBranch, project } = options;
  // `aborted` can flip while a page is in flight; a call keeps TypeScript from
  // narrowing it from a previous check.
  const aborted = (): boolean => options.signal?.aborted === true;
  if (!port || typeof port.fetchPage !== "function") {
    throw new Error(
      "A bounded merged-MR walk requires an injected page port; this module opens no transport itself.",
    );
  }
  if (typeof port.orderedDescendingByMergedAt !== "boolean") {
    throw new Error(
      "A merged-MR page port must declare whether it orders merges by merged_at descending, because ordering is never assumed.",
    );
  }
  const maxPages = requireBound(options.maxPages, MERGED_MR_DEFAULT_PAGE_LIMIT, "page");
  const maxRows = requireBound(options.maxRows, MERGED_MR_DEFAULT_ROW_LIMIT, "row");
  // Fail closed before any page is read: an unusable window or target branch
  // would otherwise exclude every row and end in exhausted-empty.
  selectMergedMrRecords([], { window, targetBranch, project });

  const selected: MergedMrSelectedV1[] = [];
  const excluded: MergedMrExclusionV1[] = [];
  const truncatedPages: number[] = [];
  const considered = new Set<number>();
  const duplicateRows: number[] = [];
  let disposition: MergedMrDiscoveryDispositionV1 = "complete";
  let failureCode: MergedMrFailureCodeV1 | null = null;
  let pagesRead = 0;
  let lastGoodPage = 0;
  let rowsRead = 0;
  let orderBoundaryMs: number | null = null;
  let confirmPending = false;
  let page: number | null = 1;

  while (page !== null) {
    if (aborted()) {
      disposition = "cancelled";
      break;
    }
    if (pagesRead >= maxPages) {
      disposition = "page-limit-reached";
      break;
    }
    const requested = page;
    let fetched: MergedMrPageV1;
    try {
      fetched = await port.fetchPage(requested);
    } catch (error) {
      // A rejection caused by cancellation is a cancellation, not a retrieval
      // failure.
      if (aborted()) {
        disposition = "cancelled";
        break;
      }
      disposition = "page-failed";
      failureCode = failureCodeOf(error);
      break;
    }
    requirePageShape(fetched, requested);
    pagesRead += 1;

    if (port.orderedDescendingByMergedAt) {
      const ordering = pageKeepsDescendingOrder(fetched.items, orderBoundaryMs);
      if (!ordering.ordered) {
        // Neither this page nor an early stop derived from it can be trusted.
        // Prior pages are retained.
        disposition = "ordering-violated";
        break;
      }
      orderBoundaryMs = ordering.lastMs;
    }

    const fresh: MergedMrRecordV1[] = [];
    for (const item of fetched.items) {
      rowsRead += 1;
      const iid = item?.iid;
      if (typeof iid === "number" && considered.has(iid)) {
        if (!duplicateRows.includes(iid)) duplicateRows.push(iid);
        continue;
      }
      if (typeof iid === "number") considered.add(iid);
      fresh.push(item);
    }

    let split: ReturnType<typeof selectMergedMrRecords>;
    try {
      split = selectMergedMrRecords(fresh, { window, targetBranch, project });
    } catch {
      // A malformed row fails the walk but keeps the pages already read.
      disposition = "page-failed";
      failureCode = "response";
      break;
    }
    lastGoodPage = requested;
    const truncated = fetched.truncated === true;
    if (truncated) truncatedPages.push(requested);
    for (const entry of split.selected) {
      selected.push(truncated ? withTruncatedPageGap(entry) : entry);
    }
    excluded.push(...split.excluded);

    if (confirmPending) {
      disposition = "complete";
      break;
    }

    const oldestOnPage = fetched.items.reduce((oldest, record) => {
      const parsed = parseMergedAtMs(record?.mergedAt);
      return parsed !== null && parsed < oldest ? parsed : oldest;
    }, Number.POSITIVE_INFINITY);
    const passedWindowStart =
      port.orderedDescendingByMergedAt &&
      Number.isFinite(oldestOnPage) &&
      oldestOnPage < window.startUtcMs;
    page = fetched.nextPage ?? null;
    if (passedWindowStart) {
      if (page === null) {
        disposition = "complete";
        break;
      }
      // Read one more page before trusting the early stop, so an ordering claim
      // that breaks right after the stop cannot drop in-window merges.
      confirmPending = true;
    }
    if (page !== null && rowsRead >= maxRows) {
      disposition = "item-limit-reached";
      break;
    }
  }

  if (disposition === "complete" && selected.length === 0) disposition = "exhausted-empty";
  const windowCovered = disposition === "complete" || disposition === "exhausted-empty";
  return Object.freeze({
    schemaVersion: 1 as const,
    kind: "docsfab-merged-mr-discovery" as const,
    window,
    targetBranch,
    disposition,
    windowCovered,
    selected: Object.freeze(selected),
    excluded: Object.freeze(excluded),
    pagesRead,
    lastGoodPage,
    rowsRead,
    itemsRead: considered.size,
    duplicateRows: Object.freeze(duplicateRows),
    failureCode,
    truncatedPages: Object.freeze(truncatedPages),
  });
}
