// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Instruction parser for date-scoped merged-MR UPDATE.
 *
 * Pure: no filesystem, process, network, or clock access. The parser never
 * guesses a time zone, a target branch, or another project. UPDATE
 * instructions that do not ask for merged-MR discovery are `not-applicable`.
 */

import {
  normalizeMergedMrSelectionRequest,
  type MergedMrSelectionRequestV1,
} from "./merged-mr-selection.js";

const MONTHS: Readonly<Record<string, number>> = Object.freeze({
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
});

const MONTH_DATE =
  /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s+(\d{4})\b/giu;
const ISO_DATE = /\b(\d{4}-\d{2}-\d{2})\b/gu;
const IANA_ZONE = /\b((?:UTC|[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+.-]+)+))\b/gu;
const MERGED_INTO = /\bmerged\s+into\s+([A-Za-z0-9._/-]+)\b/iu;
const EXPLICIT_BANG_IID = /(?:^|[^\w])!(\d+)\b/gu;
const EXPLICIT_MR_IID = /\bMR\s+#?(\d+)\b/giu;

export const MERGED_MR_UPDATE_REPRODUCTION_INSTRUCTION =
  "Review the MRs merged into main on September 14, 2026, using America/Los_Angeles time. Collect the related code changes and existing documentation. Identify changes affecting end users, including commands, configuration, defaults, installation, workflows, and observable behavior. Update only the affected user documentation, preserving unrelated content. Skip internal changes with no user impact. Report which MRs require documentation changes, what you updated, and any evidence gaps. If merge records or diffs are unavailable, report that limitation rather than claiming complete coverage.";

export type MergedMrInstructionParseV1 =
  | { readonly kind: "not-applicable" }
  | {
      readonly kind: "date-window";
      readonly request: Extract<MergedMrSelectionRequestV1, { kind: "date-window" }>;
    };

export class MergedMrInstructionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "MergedMrInstructionError";
  }
}

function looksLikeMergedMrDiscovery(instruction: string): boolean {
  return /\b(?:merge requests?|mrs?)\b/iu.test(instruction) && /\bmerged\b/iu.test(instruction);
}

function calendarDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function parseNamedDate(match: RegExpExecArray): string {
  const month = MONTHS[match[1]!.toLowerCase()];
  const day = Number(match[2]);
  const year = Number(match[3]);
  if (!month) {
    throw new MergedMrInstructionError(
      `A date-scoped merged-MR update requires a real calendar day. Received: ${JSON.stringify(match[0])}.`,
    );
  }
  return calendarDate(year, month, day);
}

function collectNamedDates(instruction: string): string[] {
  const dates: string[] = [];
  const matcher = new RegExp(MONTH_DATE.source, MONTH_DATE.flags);
  for (const match of instruction.matchAll(matcher)) {
    dates.push(parseNamedDate(match));
  }
  return dates;
}

function collectIsoDates(instruction: string): string[] {
  const dates: string[] = [];
  const matcher = new RegExp(ISO_DATE.source, ISO_DATE.flags);
  for (const match of instruction.matchAll(matcher)) {
    dates.push(match[1]!);
  }
  return dates;
}

function collectTimeZones(instruction: string): string[] {
  const zones: string[] = [];
  const matcher = new RegExp(IANA_ZONE.source, IANA_ZONE.flags);
  for (const match of instruction.matchAll(matcher)) {
    const zone = match[1]!;
    if (zone === "UTC" || zone.includes("/")) zones.push(zone);
  }
  return [...new Set(zones)];
}

function collectExplicitIids(instruction: string): number[] {
  const iids: number[] = [];
  for (const match of instruction.matchAll(new RegExp(EXPLICIT_BANG_IID.source, "gu"))) {
    iids.push(Number(match[1]));
  }
  for (const match of instruction.matchAll(new RegExp(EXPLICIT_MR_IID.source, "giu"))) {
    iids.push(Number(match[1]));
  }
  return [...new Set(iids)];
}

function uniqueDatePair(dates: readonly string[]): { startDate: string; endDate: string } {
  if (dates.length === 0) {
    throw new MergedMrInstructionError(
      "A date-scoped merged-MR update names one calendar day or an inclusive from/through range as real calendar dates. It does not guess a day.",
    );
  }
  if (dates.length === 1) {
    return { startDate: dates[0]!, endDate: dates[0]! };
  }
  if (dates.length === 2) {
    return { startDate: dates[0]!, endDate: dates[1]! };
  }
  throw new MergedMrInstructionError(
    `A date-scoped merged-MR update names one calendar day or one inclusive range, never ${dates.length} unrelated dates. Received: ${JSON.stringify(dates)}.`,
  );
}

function missing(parts: readonly string[]): never {
  throw new MergedMrInstructionError(
    `A date-scoped merged-MR update names one target branch, one calendar day or range, and one IANA time zone. It does not guess a time zone or read another project. Missing: ${parts.join(", ")}.`,
  );
}

/**
 * Parse an UPDATE instruction into a date-window selector, or report that
 * merged-MR discovery does not apply.
 *
 * `normalizeMergedMrSelectionRequest` refuses explicit merge-request numbers
 * combined with a date window. Incomplete requests get a clarification error
 * rather than a guessed scope.
 */
export function parseMergedMrUpdateInstruction(instruction: string): MergedMrInstructionParseV1 {
  if (typeof instruction !== "string" || instruction.trim().length === 0) {
    return { kind: "not-applicable" };
  }
  if (!looksLikeMergedMrDiscovery(instruction)) {
    return { kind: "not-applicable" };
  }

  const missingParts: string[] = [];
  const branchMatch = MERGED_INTO.exec(instruction);
  const targetBranch = branchMatch?.[1];
  if (!targetBranch) missingParts.push("target branch");

  const namedDates = collectNamedDates(instruction);
  const isoDates = namedDates.length > 0 ? [] : collectIsoDates(instruction);
  const dates = namedDates.length > 0 ? namedDates : isoDates;
  if (dates.length === 0) missingParts.push("calendar day or range");

  const zones = collectTimeZones(instruction);
  if (zones.length === 0) missingParts.push("IANA time zone");
  if (zones.length > 1) {
    throw new MergedMrInstructionError(
      `A date-scoped merged-MR update names exactly one IANA time zone. Received: ${JSON.stringify(zones)}.`,
    );
  }
  if (missingParts.length > 0) missing(missingParts);

  const { startDate, endDate } = uniqueDatePair(dates);
  const explicitIids = collectExplicitIids(instruction);
  try {
    const request = normalizeMergedMrSelectionRequest({
      targetBranch: targetBranch!,
      timeZone: zones[0],
      startDate,
      endDate,
      ...(explicitIids.length > 0 ? { mergeRequestIids: explicitIids } : {}),
    });
    if (request.kind !== "date-window") {
      throw new MergedMrInstructionError(
        "A date-scoped merged-MR update carries a date window, not an explicit merge-request list.",
      );
    }
    return { kind: "date-window", request };
  } catch (error) {
    if (error instanceof MergedMrInstructionError) throw error;
    throw new MergedMrInstructionError(
      error instanceof Error
        ? error.message
        : "A date-scoped merged-MR update could not normalize the requested selector.",
    );
  }
}

/**
 * Refuse a date-window instruction that also carries explicit CLI selectors.
 *
 * `--reader-source` and `--comparison-base` / `--comparison-workspace` are
 * manual evidence bindings. Combining them with inferred merged-MR discovery
 * would leave the run with two competing source sets.
 */
export function assertMergedMrSelectorCompatibility(input: {
  readonly parsed: MergedMrInstructionParseV1;
  readonly readerSources?: readonly unknown[];
  readonly comparisonRequest?: unknown;
}): void {
  if (input.parsed.kind !== "date-window") return;
  if ((input.readerSources?.length ?? 0) > 0) {
    throw new MergedMrInstructionError(
      "A date-scoped merged-MR update discovers merge requests from the instruction. Do not combine it with --reader-source.",
    );
  }
  if (input.comparisonRequest !== undefined) {
    throw new MergedMrInstructionError(
      "A date-scoped merged-MR update discovers per-MR evidence. Do not combine it with --comparison-base or --comparison-workspace, which would invent a first-to-last SHA comparison.",
    );
  }
}
