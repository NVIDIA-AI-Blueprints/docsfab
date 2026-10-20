// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Date-scoped merged-MR selection for the UPDATE journey.
 *
 * Pure: no filesystem, process, network, or clock access. IANA zone offsets
 * come from `Intl.DateTimeFormat`; `check:soft-deps` limits runtime
 * dependencies, so there is no date/timezone library.
 *
 * A reported calendar day is a civil interval, so the UTC window is half-open
 * and the day after the end day is computed on the civil calendar: adding
 * 86_400_000 ms is wrong on 23-hour and 25-hour daylight-saving days.
 *
 * Record fields mirror the `list_merged` projection in
 * `src/live-agent/gitlab-read.ts`. The only timestamp selection reads is
 * `merged_at`, never `updated_at`.
 */

import { canonicalGitlabMrReviewLocator } from "./gitlab-mr-locator.js";

const MILLISECONDS_PER_DAY = 86_400_000;
const ZONE_NAME_LIMIT = 64;
/**
 * Region/City IANA names plus bare `UTC`. Slash-less aliases such as `EST5EDT`,
 * `Zulu`, or a fixed `+05:30` offset are rejected: the reported-day contract
 * needs a zone that can express a daylight-saving transition.
 */
const IANA_ZONE = /^(?:UTC|[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+.-]+)+)$/u;
const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;

const zoneFormatters = new Map<string, Intl.DateTimeFormat>();

/** One merged merge request in the `list_merged` projection shape. */
export interface MergedMrRecordV1 {
  readonly iid: number;
  readonly state: string | null;
  /** GitLab `merged_at`. The only timestamp selection reads. */
  readonly mergedAt: string | null;
  readonly targetBranch: string | null;
  readonly mergeCommitSha?: string | null;
  readonly squashCommitSha?: string | null;
  readonly sourceBranch?: string | null;
  readonly url?: string | null;
  readonly title?: string | null;
  readonly description?: string | null;
  /**
   * GitLab `updated_at`. Selection never reads it: a note or label edit must not
   * move an MR across a merge-date window, and a missing `mergedAt` never falls
   * back to it.
   */
  readonly updatedAt?: string | null;
}

/** Project identity for the selected scope; either form may be supplied. */
export interface MergedMrProjectScopeV1 {
  readonly host: string;
  readonly projectId?: number;
  readonly projectPath?: string;
}

/** Half-open UTC interval derived from reported civil days in one IANA zone. */
export interface MergedMrDateWindowV1 {
  readonly schemaVersion: 1;
  readonly kind: "docsfab-merged-mr-date-window";
  readonly timeZone: string;
  readonly startDate: string;
  readonly endDate: string;
  /** Inclusive lower bound. */
  readonly startUtc: string;
  /** Exclusive upper bound. */
  readonly endUtc: string;
  readonly startUtcMs: number;
  readonly endUtcMs: number;
}

export type MergedMrCommitProvenanceV1 = "squash" | "merge" | "none";

export type MergedMrEvidenceGapV1 = "missing-commit-identity" | "truncated-source-page";

export interface MergedMrSelectedV1 {
  readonly iid: number;
  /** Canonical `gitlab-mr:v1:` locator when the scope carries a numeric id. */
  readonly locator: string | null;
  readonly projectPath: string | null;
  readonly mergedAt: string;
  readonly mergedAtMs: number;
  readonly targetBranch: string;
  readonly commitSha: string | null;
  readonly commitProvenance: MergedMrCommitProvenanceV1;
  readonly mergeCommitSha: string | null;
  readonly squashCommitSha: string | null;
  readonly evidenceGaps: readonly MergedMrEvidenceGapV1[];
}

export type MergedMrExclusionReasonV1 =
  | "not-merged"
  | "unusable-merged-at"
  | "other-target-branch"
  | "before-window"
  | "after-window";

export interface MergedMrExclusionV1 {
  readonly iid: number;
  readonly reason: MergedMrExclusionReasonV1;
  readonly mergedAt: string | null;
  readonly targetBranch: string | null;
}

export type MergedMrDecisionV1 =
  | { readonly kind: "selected"; readonly selected: MergedMrSelectedV1 }
  | { readonly kind: "excluded"; readonly excluded: MergedMrExclusionV1 };

export interface MergedMrSelectionOptionsV1 {
  readonly window: MergedMrDateWindowV1;
  readonly targetBranch: string;
  readonly project?: MergedMrProjectScopeV1;
}

export interface MergedMrSelectionSplitV1 {
  readonly selected: readonly MergedMrSelectedV1[];
  readonly excluded: readonly MergedMrExclusionV1[];
}

export type MergedMrInapplicableReasonV1 =
  | "revision-absent-from-checkout"
  | "missing-commit-identity";

export interface MergedMrApplicabilityV1 {
  readonly applicable: readonly MergedMrSelectedV1[];
  readonly inapplicable: readonly {
    readonly iid: number;
    readonly commitSha: string | null;
    readonly reason: MergedMrInapplicableReasonV1;
  }[];
}

export interface MergedMrCommitDriftV1 {
  readonly iid: number;
  readonly previousCommitSha: string | null;
  readonly currentCommitSha: string | null;
  readonly previousProvenance: MergedMrCommitProvenanceV1;
  readonly currentProvenance: MergedMrCommitProvenanceV1;
}

export interface MergedMrSelectionRequestInputV1 {
  readonly targetBranch: string;
  readonly timeZone?: string;
  readonly startDate?: string;
  readonly endDate?: string;
  readonly mergeRequestIids?: readonly number[];
}

export type MergedMrSelectionRequestV1 =
  | {
      readonly kind: "date-window";
      readonly targetBranch: string;
      readonly window: MergedMrDateWindowV1;
    }
  | {
      readonly kind: "explicit-merge-requests";
      readonly targetBranch: string;
      readonly mergeRequestIids: readonly number[];
    };

function zoneFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = zoneFormatters.get(timeZone);
  if (cached) return cached;
  if (
    typeof timeZone !== "string" ||
    timeZone.length > ZONE_NAME_LIMIT ||
    !IANA_ZONE.test(timeZone)
  ) {
    throw new Error(
      `A merged-MR date window requires a valid IANA time zone name such as America/Los_Angeles, and never falls back to the host zone. Received: ${JSON.stringify(timeZone)}.`,
    );
  }
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    throw new Error(
      `A merged-MR date window requires a valid IANA time zone name such as America/Los_Angeles, and never falls back to the host zone. Received: ${JSON.stringify(timeZone)}.`,
    );
  }
  zoneFormatters.set(timeZone, formatter);
  return formatter;
}

function wallClockParts(
  timeZone: string,
  instantMs: number,
): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const parts: Record<string, string> = {};
  for (const part of zoneFormatter(timeZone).formatToParts(new Date(instantMs))) {
    if (part.type !== "literal") parts[part.type] = part.value;
  }
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

function zoneOffsetMs(timeZone: string, instantMs: number): number {
  const wall = wallClockParts(timeZone, instantMs);
  return (
    Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second) - instantMs
  );
}

function isoCalendarDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function localCalendarDate(timeZone: string, instantMs: number): string {
  const wall = wallClockParts(timeZone, instantMs);
  return isoCalendarDate(wall.year, wall.month, wall.day);
}

/**
 * First instant of a civil day in one zone.
 *
 * Candidates come from the offsets a day either side of nominal UTC midnight,
 * which handles 23-hour and 25-hour days; the earliest candidate that begins
 * the requested day wins. A skipped local midnight yields the day's first
 * existing instant.
 */
function firstInstantOfCivilDay(
  timeZone: string,
  year: number,
  month: number,
  day: number,
): number {
  const nominal = Date.UTC(year, month - 1, day);
  const date = isoCalendarDate(year, month, day);
  const candidates = [
    nominal - zoneOffsetMs(timeZone, nominal - MILLISECONDS_PER_DAY),
    nominal - zoneOffsetMs(timeZone, nominal + MILLISECONDS_PER_DAY),
  ]
    .filter((value, index, all) => all.indexOf(value) === index)
    .sort((left, right) => left - right);
  for (const candidate of candidates) {
    if (
      localCalendarDate(timeZone, candidate) === date &&
      localCalendarDate(timeZone, candidate - 1) !== date
    ) {
      return candidate;
    }
  }
  for (const candidate of candidates) {
    if (localCalendarDate(timeZone, candidate) === date) return candidate;
  }
  throw new Error(
    `A merged-MR date window could not resolve the first instant of ${date} in the requested time zone, so no interval is reported. Zone: ${JSON.stringify(timeZone)}.`,
  );
}

function parseCalendarDate(value: unknown, field: "start" | "end"): [number, number, number] {
  const matched = typeof value === "string" ? CALENDAR_DATE.exec(value) : null;
  if (!matched) {
    throw new Error(
      `A merged-MR date window requires the ${field} date as an ISO calendar date shaped YYYY-MM-DD. Received: ${JSON.stringify(value)}.`,
    );
  }
  const year = Number(matched[1]);
  const month = Number(matched[2]);
  const day = Number(matched[3]);
  const roundTrip = new Date(Date.UTC(year, month - 1, day));
  if (
    roundTrip.getUTCFullYear() !== year ||
    roundTrip.getUTCMonth() + 1 !== month ||
    roundTrip.getUTCDate() !== day
  ) {
    throw new Error(
      `A merged-MR date window requires the ${field} date to be a real calendar day in the proleptic Gregorian calendar. Received: ${JSON.stringify(value)}.`,
    );
  }
  return [year, month, day];
}

/**
 * Normalize reported civil days into one half-open UTC interval.
 *
 * `endDate` is the final *reported* day and is inclusive as a day: the returned
 * `endUtc` is the first instant of the following civil day and is exclusive as
 * an instant.
 */
export function resolveMergedMrDateWindow(input: {
  readonly timeZone: string;
  readonly startDate: string;
  readonly endDate: string;
}): MergedMrDateWindowV1 {
  if (!input || typeof input !== "object") {
    throw new Error(
      "A merged-MR date window requires a request object carrying a time zone, a start date, and an end date.",
    );
  }
  const timeZone = input.timeZone;
  zoneFormatter(timeZone);
  const [startYear, startMonth, startDay] = parseCalendarDate(input.startDate, "start");
  const [endYear, endMonth, endDay] = parseCalendarDate(input.endDate, "end");
  const startUtcMs = firstInstantOfCivilDay(timeZone, startYear, startMonth, startDay);
  // Civil day arithmetic, never a fixed 86_400_000 ms addition.
  const dayAfterEnd = new Date(Date.UTC(endYear, endMonth - 1, endDay + 1));
  const endUtcMs = firstInstantOfCivilDay(
    timeZone,
    dayAfterEnd.getUTCFullYear(),
    dayAfterEnd.getUTCMonth() + 1,
    dayAfterEnd.getUTCDate(),
  );
  if (!(startUtcMs < endUtcMs)) {
    throw new Error(
      `A merged-MR date window requires an end date on or after its start date, so the interval is never empty. Received: ${JSON.stringify(input.startDate)} through ${JSON.stringify(input.endDate)}.`,
    );
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    kind: "docsfab-merged-mr-date-window" as const,
    timeZone,
    startDate: isoCalendarDate(startYear, startMonth, startDay),
    endDate: isoCalendarDate(endYear, endMonth, endDay),
    startUtc: new Date(startUtcMs).toISOString(),
    endUtc: new Date(endUtcMs).toISOString(),
    startUtcMs,
    endUtcMs,
  });
}

/** Reject a request that carries both an explicit MR list and a date window. */
export function normalizeMergedMrSelectionRequest(
  input: MergedMrSelectionRequestInputV1,
): MergedMrSelectionRequestV1 {
  if (!input || typeof input !== "object") {
    throw new Error(
      "A merged-MR selection request requires a target branch and exactly one selector.",
    );
  }
  const targetBranch = input.targetBranch;
  if (typeof targetBranch !== "string" || targetBranch.length === 0) {
    throw new Error(
      "A merged-MR selection request requires one non-empty target branch name to select against.",
    );
  }
  const hasExplicit = Array.isArray(input.mergeRequestIids) && input.mergeRequestIids.length > 0;
  const hasWindow =
    input.timeZone !== undefined || input.startDate !== undefined || input.endDate !== undefined;
  if (hasExplicit && hasWindow) {
    throw new Error(
      "A merged-MR selection request carries either an explicit merge-request list or a date window, never both.",
    );
  }
  if (hasExplicit) {
    const mergeRequestIids = (input.mergeRequestIids ?? []).map((iid) => {
      if (typeof iid !== "number" || !Number.isSafeInteger(iid) || iid <= 0) {
        throw new Error(
          `A merged-MR selection request lists project-local merge-request numbers as positive integers. Received: ${JSON.stringify(iid)}.`,
        );
      }
      return iid;
    });
    return Object.freeze({
      kind: "explicit-merge-requests" as const,
      targetBranch,
      mergeRequestIids: Object.freeze(mergeRequestIids),
    });
  }
  if (!hasWindow) {
    throw new Error(
      "A merged-MR selection request carries either an explicit merge-request list or a date window, and one is required.",
    );
  }
  return Object.freeze({
    kind: "date-window" as const,
    targetBranch,
    window: resolveMergedMrDateWindow({
      timeZone: input.timeZone as string,
      startDate: input.startDate as string,
      endDate: input.endDate as string,
    }),
  });
}

function requireRecordShape(record: MergedMrRecordV1): void {
  if (!record || typeof record !== "object") {
    throw new Error(
      "A merged-MR page row must be the object projection this selector documents, never a bare value.",
    );
  }
  if (typeof record.iid !== "number" || !Number.isSafeInteger(record.iid) || record.iid <= 0) {
    throw new Error(
      `A merged-MR page row requires the project-local merge-request number as a positive integer. Received: ${JSON.stringify(record.iid)}.`,
    );
  }
}

/**
 * Refuse an unusable selector before any row is judged, so a malformed request
 * never looks like a genuinely empty MR set.
 */
function requireSelectionOptions(options: MergedMrSelectionOptionsV1): void {
  if (!options || typeof options !== "object") {
    throw new Error(
      "A merged-MR selection requires an options object carrying a date window and one target branch.",
    );
  }
  if (typeof options.targetBranch !== "string" || options.targetBranch.length === 0) {
    throw new Error(
      `A merged-MR selection requires one non-empty target branch, because an unmatched branch would otherwise look like an empty window. Received: ${JSON.stringify(options.targetBranch)}.`,
    );
  }
  const window = options.window;
  if (
    !window ||
    typeof window !== "object" ||
    window.kind !== "docsfab-merged-mr-date-window" ||
    !Number.isFinite(window.startUtcMs) ||
    !Number.isFinite(window.endUtcMs) ||
    !(window.startUtcMs < window.endUtcMs)
  ) {
    throw new Error(
      "A merged-MR selection requires a normalized half-open date window from resolveMergedMrDateWindow, never a hand-built interval.",
    );
  }
}

function locatorFor(iid: number, project?: MergedMrProjectScopeV1): string | null {
  if (!project || typeof project.projectId !== "number") return null;
  return canonicalGitlabMrReviewLocator({
    host: project.host,
    projectId: project.projectId,
    mergeRequestIid: iid,
  });
}

/**
 * Parse a GitLab timestamp to epoch milliseconds, or `null` when unusable.
 *
 * Only an ISO-8601 instant with an explicit `Z` or `±hh:mm` designator is
 * accepted. Bare `Date.parse` resolves designator-less text against the host
 * zone and accepts non-ISO text, which would make selection depend on where
 * the process runs.
 */
export function parseMergedAtMs(value: string | null | undefined): number | null {
  if (typeof value !== "string" || !ISO_INSTANT.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function decideMergedMrRecord(
  record: MergedMrRecordV1,
  options: MergedMrSelectionOptionsV1,
): MergedMrDecisionV1 {
  requireSelectionOptions(options);
  requireRecordShape(record);
  const { window, targetBranch, project } = options;
  const excluded = (reason: MergedMrExclusionReasonV1): MergedMrDecisionV1 =>
    Object.freeze({
      kind: "excluded" as const,
      excluded: Object.freeze({
        iid: record.iid,
        reason,
        mergedAt: record.mergedAt ?? null,
        targetBranch: record.targetBranch ?? null,
      }),
    });
  if (record.state !== "merged") return excluded("not-merged");
  const mergedAt = record.mergedAt;
  const mergedAtMs = parseMergedAtMs(mergedAt);
  if (typeof mergedAt !== "string" || mergedAtMs === null) {
    return excluded("unusable-merged-at");
  }
  if (record.targetBranch !== targetBranch) return excluded("other-target-branch");
  if (mergedAtMs < window.startUtcMs) return excluded("before-window");
  if (mergedAtMs >= window.endUtcMs) return excluded("after-window");
  const squashCommitSha = record.squashCommitSha ?? null;
  const mergeCommitSha = record.mergeCommitSha ?? null;
  const commitSha = squashCommitSha ?? mergeCommitSha;
  const commitProvenance: MergedMrCommitProvenanceV1 = squashCommitSha
    ? "squash"
    : mergeCommitSha
      ? "merge"
      : "none";
  return Object.freeze({
    kind: "selected" as const,
    selected: Object.freeze({
      iid: record.iid,
      locator: locatorFor(record.iid, project),
      projectPath: project?.projectPath ?? null,
      mergedAt,
      mergedAtMs,
      targetBranch,
      commitSha,
      commitProvenance,
      mergeCommitSha,
      squashCommitSha,
      evidenceGaps: Object.freeze(
        commitProvenance === "none"
          ? (["missing-commit-identity"] as readonly MergedMrEvidenceGapV1[])
          : ([] as readonly MergedMrEvidenceGapV1[]),
      ),
    }),
  });
}

export function selectMergedMrRecords(
  records: readonly MergedMrRecordV1[],
  options: MergedMrSelectionOptionsV1,
): MergedMrSelectionSplitV1 {
  requireSelectionOptions(options);
  const selected: MergedMrSelectedV1[] = [];
  const excluded: MergedMrExclusionV1[] = [];
  for (const record of records) {
    const decision = decideMergedMrRecord(record, options);
    if (decision.kind === "selected") selected.push(decision.selected);
    else excluded.push(decision.excluded);
  }
  return Object.freeze({ selected: Object.freeze(selected), excluded: Object.freeze(excluded) });
}

/**
 * Split selections by whether their own recorded revision exists in the target
 * checkout. Each MR keeps its own identity; there is deliberately no
 * first-to-last comparison, which would span unselected commits.
 */
export function assessMergedMrApplicability(
  selected: readonly MergedMrSelectedV1[],
  presentRevisions: Iterable<string>,
): MergedMrApplicabilityV1 {
  const present = new Set(presentRevisions);
  const applicable: MergedMrSelectedV1[] = [];
  const inapplicable: {
    iid: number;
    commitSha: string | null;
    reason: MergedMrInapplicableReasonV1;
  }[] = [];
  for (const entry of selected) {
    if (entry.commitSha === null) {
      inapplicable.push({
        iid: entry.iid,
        commitSha: null,
        reason: "missing-commit-identity",
      });
      continue;
    }
    if (present.has(entry.commitSha)) {
      applicable.push(entry);
      continue;
    }
    inapplicable.push({
      iid: entry.iid,
      commitSha: entry.commitSha,
      reason: "revision-absent-from-checkout",
    });
  }
  return Object.freeze({
    applicable: Object.freeze(applicable),
    inapplicable: Object.freeze(inapplicable.map((entry) => Object.freeze(entry))),
  });
}

/** Report a previously selected MR whose recorded commit identity moved. */
export function detectMergedMrCommitDrift(
  previous: readonly MergedMrSelectedV1[],
  current: readonly MergedMrSelectedV1[],
): readonly MergedMrCommitDriftV1[] {
  const byIid = new Map(current.map((entry) => [entry.iid, entry]));
  const drift: MergedMrCommitDriftV1[] = [];
  for (const entry of previous) {
    const now = byIid.get(entry.iid);
    if (!now) continue;
    if (now.commitSha === entry.commitSha && now.commitProvenance === entry.commitProvenance) {
      continue;
    }
    drift.push(
      Object.freeze({
        iid: entry.iid,
        previousCommitSha: entry.commitSha,
        currentCommitSha: now.commitSha,
        previousProvenance: entry.commitProvenance,
        currentProvenance: now.commitProvenance,
      }),
    );
  }
  return Object.freeze(drift);
}
