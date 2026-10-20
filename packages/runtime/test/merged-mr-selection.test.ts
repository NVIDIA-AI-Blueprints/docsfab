// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  discoverMergedMrs,
  MERGED_MR_FAILURE_CODES,
  type MergedMrDiscoveryResultV1,
  type MergedMrPagePortV1,
} from "../src/inputs/merged-mr-discovery.js";
import {
  assessMergedMrApplicability,
  decideMergedMrRecord,
  detectMergedMrCommitDrift,
  type MergedMrDateWindowV1,
  type MergedMrExclusionReasonV1,
  type MergedMrProjectScopeV1,
  type MergedMrRecordV1,
  type MergedMrSelectedV1,
  normalizeMergedMrSelectionRequest,
  parseMergedAtMs,
  resolveMergedMrDateWindow,
  selectMergedMrRecords,
} from "../src/inputs/merged-mr-selection.js";
import { GITLAB_READ_FAILURES } from "../src/live-agent/gitlab-read.js";

const HOUR_MS = 3_600_000;
const NAIVE_DAY_MS = 86_400_000;
const LOS_ANGELES = "America/Los_Angeles";

type FailureCode = keyof typeof GITLAB_READ_FAILURES;

interface FixturePage {
  readonly page: number;
  readonly nextPage: number | null;
  readonly truncated?: boolean;
  readonly failure?: FailureCode;
  readonly items: readonly MergedMrRecordV1[];
}

interface Fixture {
  readonly description: string;
  readonly window: { timeZone: string; startDate: string; endDate: string };
  readonly targetBranch: string;
  readonly pages: readonly FixturePage[];
}

function loadFixture(name: string): Fixture {
  const path = new URL(`./fixtures/merged-mr-update/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(path, "utf8")) as Fixture;
}

function windowOf(fixture: Fixture): MergedMrDateWindowV1 {
  return resolveMergedMrDateWindow(fixture.window);
}

function pageOf(fixture: Fixture, page: number): FixturePage {
  const entry = fixture.pages.find((candidate) => candidate.page === page);
  if (!entry) throw new Error(`fixture ${fixture.description} has no page ${page}`);
  return entry;
}

function recordOf(fixture: Fixture, iid: number): MergedMrRecordV1 {
  for (const page of fixture.pages) {
    const found = page.items.find((item) => item.iid === iid);
    if (found) return found;
  }
  throw new Error(`fixture ${fixture.description} has no merge request ${iid}`);
}

function selectFirstPage(
  fixture: Fixture,
  options: { targetBranch?: string; project?: MergedMrProjectScopeV1 } = {},
) {
  return selectMergedMrRecords(pageOf(fixture, 1).items, {
    window: windowOf(fixture),
    targetBranch: options.targetBranch ?? fixture.targetBranch,
    ...(options.project ? { project: options.project } : {}),
  });
}

interface RecordingPort extends MergedMrPagePortV1 {
  readonly requested: number[];
}

function portFor(
  fixture: Fixture,
  options: {
    ordered?: boolean;
    honourFailures?: boolean;
    failureCode?: FailureCode;
    onPage?: (page: number) => void;
  } = {},
): RecordingPort {
  const requested: number[] = [];
  return {
    requested,
    orderedDescendingByMergedAt: options.ordered ?? false,
    async fetchPage(page: number) {
      requested.push(page);
      options.onPage?.(page);
      const entry = pageOf(fixture, page);
      if (entry.failure && options.honourFailures !== false) {
        const code = options.failureCode ?? entry.failure;
        // The shape a real adapter uses: the operator message from the shared
        // constant, plus the code the walk is allowed to retain.
        throw Object.assign(new Error(GITLAB_READ_FAILURES[code]), { code });
      }
      return {
        items: entry.items,
        nextPage: entry.nextPage,
        truncated: entry.truncated === true,
      };
    },
  };
}

function walk(
  fixture: Fixture,
  options: {
    ordered?: boolean;
    honourFailures?: boolean;
    failureCode?: FailureCode;
    onPage?: (page: number) => void;
    targetBranch?: string;
    maxPages?: number;
    maxRows?: number;
    signal?: AbortSignal;
  } = {},
): Promise<MergedMrDiscoveryResultV1> {
  return discoverMergedMrs({
    port: portFor(fixture, options),
    window: windowOf(fixture),
    targetBranch: options.targetBranch ?? fixture.targetBranch,
    ...(options.maxPages === undefined ? {} : { maxPages: options.maxPages }),
    ...(options.maxRows === undefined ? {} : { maxRows: options.maxRows }),
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

function iids(entries: readonly { iid: number }[]): number[] {
  return entries.map((entry) => entry.iid);
}

function selectionOf(entries: readonly MergedMrSelectedV1[], iid: number): MergedMrSelectedV1 {
  const found = entries.find((entry) => entry.iid === iid);
  if (!found) throw new Error(`selection is missing merge request ${iid}`);
  return found;
}

const selectionSource = readFileSync(
  new URL("../src/inputs/merged-mr-selection.ts", import.meta.url),
  "utf8",
);
const discoverySource = readFileSync(
  new URL("../src/inputs/merged-mr-discovery.ts", import.meta.url),
  "utf8",
);

describe("merged-MR date window normalization (#896)", () => {
  it("maps the reported September 14 2026 Los Angeles day to [2026-09-14T07:00:00Z, 2026-09-15T07:00:00Z)", () => {
    const window = resolveMergedMrDateWindow({
      timeZone: LOS_ANGELES,
      startDate: "2026-09-14",
      endDate: "2026-09-14",
    });
    expect(window.startUtc).toBe("2026-09-14T07:00:00.000Z");
    expect(window.endUtc).toBe("2026-09-15T07:00:00.000Z");
    expect(window.startUtcMs).toBe(Date.parse("2026-09-14T07:00:00.000Z"));
    expect(window.endUtcMs).toBe(Date.parse("2026-09-15T07:00:00.000Z"));
    expect(window.endUtcMs - window.startUtcMs).toBe(24 * HOUR_MS);
    expect(window.timeZone).toBe(LOS_ANGELES);
  });

  it("spans 23 hours across the 2026-03-08 Los Angeles spring-forward day", () => {
    const window = resolveMergedMrDateWindow({
      timeZone: LOS_ANGELES,
      startDate: "2026-03-08",
      endDate: "2026-03-08",
    });
    expect(window.startUtc).toBe("2026-03-08T08:00:00.000Z");
    expect(window.endUtc).toBe("2026-03-09T07:00:00.000Z");
    expect(window.endUtcMs - window.startUtcMs).toBe(23 * HOUR_MS);
    expect(window.endUtcMs).not.toBe(window.startUtcMs + NAIVE_DAY_MS);
  });

  it("spans 25 hours across the 2026-11-01 Los Angeles fall-back day", () => {
    const window = resolveMergedMrDateWindow({
      timeZone: LOS_ANGELES,
      startDate: "2026-11-01",
      endDate: "2026-11-01",
    });
    expect(window.startUtc).toBe("2026-11-01T07:00:00.000Z");
    expect(window.endUtc).toBe("2026-11-02T08:00:00.000Z");
    expect(window.endUtcMs - window.startUtcMs).toBe(25 * HOUR_MS);
    expect(window.endUtcMs).not.toBe(window.startUtcMs + NAIVE_DAY_MS);
  });

  it("treats a start and end date as one half-open interval ending at the midnight after the final requested day", () => {
    const window = resolveMergedMrDateWindow({
      timeZone: LOS_ANGELES,
      startDate: "2026-03-07",
      endDate: "2026-03-09",
    });
    expect(window.startUtc).toBe("2026-03-07T08:00:00.000Z");
    expect(window.endUtc).toBe("2026-03-10T07:00:00.000Z");
    expect(window.endUtcMs - window.startUtcMs).toBe(71 * HOUR_MS);
    expect(window.endUtcMs).not.toBe(window.startUtcMs + 3 * NAIVE_DAY_MS);
  });

  it("refuses an unknown IANA zone rather than falling back to the host zone", () => {
    expect(() =>
      resolveMergedMrDateWindow({
        timeZone: "Mars/Phobos",
        startDate: "2026-09-14",
        endDate: "2026-09-14",
      }),
    ).toThrowError(/requires a valid IANA time zone name such as America\/Los_Angeles/u);
    expect(() =>
      resolveMergedMrDateWindow({
        timeZone: "Mars/Phobos",
        startDate: "2026-09-14",
        endDate: "2026-09-14",
      }),
    ).toThrowError(/Received: "Mars\/Phobos"/u);
  });

  it("refuses a fixed UTC-offset zone that cannot express a daylight-saving transition", () => {
    expect(() =>
      resolveMergedMrDateWindow({
        timeZone: "+05:30",
        startDate: "2026-09-14",
        endDate: "2026-09-14",
      }),
    ).toThrowError(/never falls back to the host zone\. Received: "\+05:30"\./u);
  });

  it("refuses an end date earlier than the start date", () => {
    expect(() =>
      resolveMergedMrDateWindow({
        timeZone: LOS_ANGELES,
        startDate: "2026-09-14",
        endDate: "2026-09-13",
      }),
    ).toThrowError(
      /requires an end date on or after its start date, so the interval is never empty\. Received: "2026-09-14" through "2026-09-13"\./u,
    );
  });

  it("refuses a malformed or non-existent calendar date rather than coercing it", () => {
    expect(() =>
      resolveMergedMrDateWindow({
        timeZone: LOS_ANGELES,
        startDate: "2026-9-14",
        endDate: "2026-09-14",
      }),
    ).toThrowError(/requires the start date as an ISO calendar date shaped YYYY-MM-DD/u);
    expect(() =>
      resolveMergedMrDateWindow({
        timeZone: LOS_ANGELES,
        startDate: "2026-02-30",
        endDate: "2026-03-01",
      }),
    ).toThrowError(/requires the start date to be a real calendar day/u);
  });

  it("never derives the window from Date.now or the host TZ environment variable", () => {
    const original = process.env.TZ;
    try {
      process.env.TZ = "Asia/Tokyo";
      const window = resolveMergedMrDateWindow({
        timeZone: LOS_ANGELES,
        startDate: "2026-09-14",
        endDate: "2026-09-14",
      });
      expect(window.startUtc).toBe("2026-09-14T07:00:00.000Z");
      expect(window.endUtc).toBe("2026-09-15T07:00:00.000Z");
      expect(() =>
        resolveMergedMrDateWindow({
          timeZone: undefined as unknown as string,
          startDate: "2026-09-14",
          endDate: "2026-09-14",
        }),
      ).toThrowError(/never falls back to the host zone/u);
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
    expect(selectionSource).not.toMatch(/Date\.now/u);
  });
});

describe("merged-MR selection predicate (#896)", () => {
  it("includes a merge at the exact window start instant and excludes the millisecond before it", () => {
    const fixture = loadFixture("boundary-dst-spring");
    const window = windowOf(fixture);
    const split = selectFirstPage(fixture);
    expect(window.startUtc).toBe("2026-03-08T08:00:00.000Z");
    expect(selectionOf(split.selected, 3302).mergedAt).toBe("2026-03-08T08:00:00.000Z");
    expect(split.excluded.find((entry) => entry.iid === 3301)).toEqual({
      iid: 3301,
      reason: "before-window",
      mergedAt: "2026-03-08T07:59:59.999Z",
      targetBranch: "main",
    });
  });

  it("excludes a merge at the exact window end instant and includes the millisecond before it", () => {
    const fixture = loadFixture("boundary-dst-spring");
    const window = windowOf(fixture);
    const split = selectFirstPage(fixture);
    expect(window.endUtc).toBe("2026-03-09T07:00:00.000Z");
    expect(selectionOf(split.selected, 3303).mergedAt).toBe("2026-03-09T06:59:59.999Z");
    expect(split.excluded.find((entry) => entry.iid === 3304)).toEqual({
      iid: 3304,
      reason: "after-window",
      mergedAt: "2026-03-09T07:00:00.000Z",
      targetBranch: "main",
    });
    expect(iids(split.selected)).toEqual([3302, 3303]);
  });

  it("selects the twenty-fifth-hour merge of the fall-back day that a fixed 24-hour window would drop", () => {
    const fixture = loadFixture("boundary-dst-fall");
    const window = windowOf(fixture);
    const split = selectFirstPage(fixture);
    expect(selectionOf(split.selected, 3403).mergedAt).toBe("2026-11-02T07:59:59.999Z");
    expect(Date.parse("2026-11-02T07:59:59.999Z")).toBeGreaterThan(
      window.startUtcMs + NAIVE_DAY_MS,
    );
    expect(iids(split.selected)).toEqual([3402, 3403]);
    expect(split.excluded.map((entry) => `${entry.iid}:${entry.reason}`)).toEqual([
      "3401:before-window",
      "3404:after-window",
    ]);
  });

  it("selects on merged_at and ignores an updated_at outside the window", () => {
    const fixture = loadFixture("stale-updated-at");
    const window = windowOf(fixture);
    const record = recordOf(fixture, 6501);
    expect(Date.parse(String(record.updatedAt))).toBeGreaterThan(window.endUtcMs);
    const decision = decideMergedMrRecord(record, { window, targetBranch: "main" });
    expect(decision.kind).toBe("selected");
    expect(decision.kind === "selected" && decision.selected.mergedAt).toBe(
      "2026-09-14T11:00:00.000Z",
    );
  });

  it("excludes an MR whose updated_at is inside the window but whose merged_at is not", () => {
    const fixture = loadFixture("stale-updated-at");
    const window = windowOf(fixture);
    const record = recordOf(fixture, 6502);
    const updatedAtMs = Date.parse(String(record.updatedAt));
    expect(updatedAtMs).toBeGreaterThanOrEqual(window.startUtcMs);
    expect(updatedAtMs).toBeLessThan(window.endUtcMs);
    const decision = decideMergedMrRecord(record, { window, targetBranch: "main" });
    expect(decision.kind === "excluded" && decision.excluded.reason).toBe("before-window");
    expect(decision.kind === "excluded" && decision.excluded.mergedAt).toBe(
      "2026-09-10T11:00:00.000Z",
    );
  });

  it("refuses a merged_at without an explicit designator whose meaning depends on the host zone", () => {
    const fixture = loadFixture("offset-timestamps");
    const window = windowOf(fixture);
    const record = recordOf(fixture, 7705);
    expect(record.mergedAt).toBe("2026-11-01T12:00:00");
    // Read as UTC the record falls inside the window; read as +05:30 it falls
    // before the start. A host-zone-dependent parse would flip the decision,
    // so the strict parser refuses the value instead of guessing a zone.
    expect(Date.parse("2026-11-01T12:00:00Z")).toBeGreaterThanOrEqual(window.startUtcMs);
    expect(Date.parse("2026-11-01T12:00:00Z")).toBeLessThan(window.endUtcMs);
    expect(Date.parse("2026-11-01T12:00:00+05:30")).toBeLessThan(window.startUtcMs);
    expect(parseMergedAtMs("2026-11-01T12:00:00")).toBeNull();
    const decision = decideMergedMrRecord(record, { window, targetBranch: "main" });
    expect(decision.kind === "excluded" && decision.excluded.reason).toBe("unusable-merged-at");
  });

  it("refuses a non-ISO merged_at that only a lenient parser would accept", () => {
    const fixture = loadFixture("offset-timestamps");
    const window = windowOf(fixture);
    const record = recordOf(fixture, 7706);
    expect(record.mergedAt).toBe("Nov 1 2026 12:00:00");
    expect(Number.isFinite(Date.parse("Nov 1 2026 12:00:00"))).toBe(true);
    expect(parseMergedAtMs("Nov 1 2026 12:00:00")).toBeNull();
    const decision = decideMergedMrRecord(record, { window, targetBranch: "main" });
    expect(decision.kind === "excluded" && decision.excluded.reason).toBe("unusable-merged-at");
  });

  it("reports unusable-merged-at for a merged row whose merged_at is null, undefined, or empty", () => {
    const fixture = loadFixture("stale-updated-at");
    const window = windowOf(fixture);
    const nulled = recordOf(fixture, 6503);
    expect(nulled.mergedAt).toBeNull();
    // Its updated_at sits inside the window, so a fallback would select it.
    expect(parseMergedAtMs(nulled.updatedAt)).toBeGreaterThanOrEqual(window.startUtcMs);
    const reasonFor = (record: MergedMrRecordV1): MergedMrExclusionReasonV1 | "selected" => {
      const decision = decideMergedMrRecord(record, { window, targetBranch: "main" });
      return decision.kind === "excluded" ? decision.excluded.reason : "selected";
    };
    expect(reasonFor(nulled)).toBe("unusable-merged-at");
    expect(reasonFor({ ...nulled, mergedAt: undefined as unknown as null })).toBe(
      "unusable-merged-at",
    );
    expect(reasonFor({ ...nulled, mergedAt: "" })).toBe("unusable-merged-at");
    expect(reasonFor({ ...nulled, mergedAt: "2026-09-14T12:00:00.000Z" })).toBe("selected");
  });

  it("selects a locally stamped merge at the window start and excludes one at the window end", () => {
    const fixture = loadFixture("offset-timestamps");
    const window = windowOf(fixture);
    const split = selectFirstPage(fixture);
    expect(window.startUtc).toBe("2026-11-01T07:00:00.000Z");
    expect(window.endUtc).toBe("2026-11-02T08:00:00.000Z");
    expect(selectionOf(split.selected, 7701).mergedAt).toBe("2026-11-01T00:00:00.000-07:00");
    expect(selectionOf(split.selected, 7701).mergedAtMs).toBe(window.startUtcMs);
    expect(selectionOf(split.selected, 7702).mergedAt).toBe("2026-11-01T13:22:41.272-07:00");
    expect(split.excluded.find((entry) => entry.iid === 7703)?.reason).toBe("after-window");
    expect(split.excluded.find((entry) => entry.iid === 7704)?.reason).toBe("before-window");
    expect(iids(split.selected)).toEqual([7701, 7702]);
  });

  it("excludes merges into a different target branch and records other-target-branch as the reason", () => {
    const fixture = loadFixture("other-target-branches");
    const split = selectFirstPage(fixture);
    expect(iids(split.selected)).toEqual([7601]);
    expect(split.excluded.find((entry) => entry.iid === 7602)?.reason).toBe("other-target-branch");
    expect(split.excluded.find((entry) => entry.iid === 7603)).toEqual({
      iid: 7603,
      reason: "other-target-branch",
      mergedAt: "2026-09-14T13:30:00.000Z",
      targetBranch: "main-archive",
    });
  });

  it("excludes a row whose state is not merged and records not-merged as the reason", () => {
    const fixture = loadFixture("other-target-branches");
    const split = selectFirstPage(fixture);
    expect(split.excluded.find((entry) => entry.iid === 7604)).toEqual({
      iid: 7604,
      reason: "not-merged",
      mergedAt: "2026-09-14T13:40:00.000Z",
      targetBranch: "main",
    });
  });

  it("selects every matching MR in the window and retains each one's own commit identity", async () => {
    const fixture = loadFixture("pages-multi");
    const result = await walk(fixture);
    expect(iids(result.selected)).toEqual([4101, 4102, 4104, 4105, 4108]);
    const shas = result.selected.map((entry) => entry.commitSha);
    expect(shas).toEqual([
      "bb02c3d4e5b6978899aabbccddeeff0011223344",
      "cc03c3d4e5b6978899aabbccddeeff0011223344",
      "ee05c3d4e5b6978899aabbccddeeff0011223344",
      "ff06c3d4e5b6978899aabbccddeeff0011223344",
      "3309c3d4e5b6978899aabbccddeeff0011223344",
    ]);
    expect(new Set(shas).size).toBe(5);
  });

  it("records squash_commit_sha with squash provenance and merge_commit_sha with merge provenance", () => {
    const fixture = loadFixture("squash-and-merge-identity");
    const split = selectFirstPage(fixture);
    const squashed = selectionOf(split.selected, 8701);
    expect(squashed.commitProvenance).toBe("squash");
    expect(squashed.commitSha).toBe("87b1c3d4e5b6978899aabbccddeeff0011223344");
    expect(squashed.mergeCommitSha).toBe("87a1c3d4e5b6978899aabbccddeeff0011223344");
    const merged = selectionOf(split.selected, 8702);
    expect(merged.commitProvenance).toBe("merge");
    expect(merged.commitSha).toBe("87a2c3d4e5b6978899aabbccddeeff0011223344");
    expect(merged.squashCommitSha).toBeNull();
  });

  it("retains an MR with neither squash nor merge commit as selected with an explicit commit gap", () => {
    const fixture = loadFixture("squash-and-merge-identity");
    const split = selectFirstPage(fixture);
    const gapped = selectionOf(split.selected, 8703);
    expect(gapped.commitProvenance).toBe("none");
    expect(gapped.commitSha).toBeNull();
    expect(gapped.evidenceGaps).toEqual(["missing-commit-identity"]);
    expect(iids(split.excluded)).toEqual([]);
  });

  it("reports a selected revision absent from the target checkout as inapplicable without substituting a comparison", () => {
    const fixture = loadFixture("squash-and-merge-identity");
    const split = selectFirstPage(fixture);
    const applicability = assessMergedMrApplicability(split.selected, [
      "87b1c3d4e5b6978899aabbccddeeff0011223344",
    ]);
    expect(iids(applicability.applicable)).toEqual([8701]);
    expect(applicability.inapplicable).toEqual([
      {
        iid: 8702,
        commitSha: "87a2c3d4e5b6978899aabbccddeeff0011223344",
        reason: "revision-absent-from-checkout",
      },
      { iid: 8703, commitSha: null, reason: "missing-commit-identity" },
    ]);
    expect(Object.keys(applicability).sort()).toEqual(["applicable", "inapplicable"]);
  });

  it("never emits a first-to-last SHA comparison spanning unselected commits", async () => {
    const fixture = loadFixture("pages-multi");
    const result = await walk(fixture);
    const serialized = JSON.stringify(result);
    // 4103 merged into release/2026.09 and 4107 merged before the window.
    expect(serialized).not.toContain("dd04c3d4e5b6978899aabbccddeeff0011223344");
    expect(serialized).not.toContain("2208c3d4e5b6978899aabbccddeeff0011223344");
    expect(Object.keys(result).sort()).toEqual([
      "disposition",
      "duplicateRows",
      "excluded",
      "failureCode",
      "itemsRead",
      "kind",
      "lastGoodPage",
      "pagesRead",
      "rowsRead",
      "schemaVersion",
      "selected",
      "targetBranch",
      "truncatedPages",
      "window",
      "windowCovered",
    ]);
  });

  it("reuses the canonical gitlab-mr locator for a numeric project identity", () => {
    const fixture = loadFixture("other-target-branches");
    const numeric = selectFirstPage(fixture, {
      project: { host: "gitlab.example.test", projectId: 437040 },
    });
    expect(selectionOf(numeric.selected, 7601).locator).toBe(
      "gitlab-mr:v1:host=gitlab.example.test:project=437040:mr=7601",
    );
    const pathOnly = selectFirstPage(fixture, {
      project: { host: "gitlab.example.test", projectPath: "team/project" },
    });
    expect(selectionOf(pathOnly.selected, 7601).locator).toBeNull();
    expect(selectionOf(pathOnly.selected, 7601).projectPath).toBe("team/project");
  });

  it("rejects a request that carries both an explicit MR list and a date window", () => {
    expect(() =>
      normalizeMergedMrSelectionRequest({
        targetBranch: "main",
        timeZone: LOS_ANGELES,
        startDate: "2026-09-14",
        endDate: "2026-09-14",
        mergeRequestIids: [4101],
      }),
    ).toThrowError(/carries either an explicit merge-request list or a date window, never both\./u);
    const windowOnly = normalizeMergedMrSelectionRequest({
      targetBranch: "main",
      timeZone: LOS_ANGELES,
      startDate: "2026-09-14",
      endDate: "2026-09-14",
    });
    expect(windowOnly.kind).toBe("date-window");
    expect(windowOnly.kind === "date-window" && windowOnly.window.startUtc).toBe(
      "2026-09-14T07:00:00.000Z",
    );
    const listOnly = normalizeMergedMrSelectionRequest({
      targetBranch: "main",
      mergeRequestIids: [4101, 4102],
    });
    expect(listOnly.kind).toBe("explicit-merge-requests");
    expect(listOnly.kind === "explicit-merge-requests" && listOnly.mergeRequestIids).toEqual([
      4101, 4102,
    ]);
  });

  it("refuses an empty target branch or a hand-built window instead of reporting an empty result", async () => {
    const fixture = loadFixture("other-target-branches");
    const window = windowOf(fixture);
    const items = pageOf(fixture, 1).items;
    expect(() => selectMergedMrRecords(items, { window, targetBranch: "" })).toThrowError(
      /requires one non-empty target branch, because an unmatched branch would otherwise look like an empty window\. Received: ""\./u,
    );
    const handBuilt = { ...window, kind: "hand-built-window" } as unknown as MergedMrDateWindowV1;
    expect(() =>
      selectMergedMrRecords(items, { window: handBuilt, targetBranch: "main" }),
    ).toThrowError(
      /requires a normalized half-open date window from resolveMergedMrDateWindow, never a hand-built interval\./u,
    );
    const port = portFor(fixture);
    await expect(discoverMergedMrs({ port, window, targetBranch: "" })).rejects.toThrowError(
      /requires one non-empty target branch/u,
    );
    expect(port.requested).toEqual([]);
  });

  it("reports a changed merge commit for a previously selected MR as drift rather than re-selecting silently", () => {
    const fixture = loadFixture("squash-and-merge-identity");
    const previous = selectFirstPage(fixture).selected;
    const rewritten = pageOf(fixture, 1).items.map((item) =>
      item.iid === 8701
        ? { ...item, squashCommitSha: "87c9c3d4e5b6978899aabbccddeeff0011223344" }
        : item,
    );
    const current = selectMergedMrRecords(rewritten, {
      window: windowOf(fixture),
      targetBranch: fixture.targetBranch,
    }).selected;
    const drift = detectMergedMrCommitDrift(previous, current);
    expect(drift).toEqual([
      {
        iid: 8701,
        previousCommitSha: "87b1c3d4e5b6978899aabbccddeeff0011223344",
        currentCommitSha: "87c9c3d4e5b6978899aabbccddeeff0011223344",
        previousProvenance: "squash",
        currentProvenance: "squash",
      },
    ]);
    expect(detectMergedMrCommitDrift(previous, previous)).toEqual([]);
  });
});

describe("merged-MR bounded pagination (#896)", () => {
  it("selects a matching MR that appears only on page two", async () => {
    const fixture = loadFixture("page-two-match");
    const port = portFor(fixture);
    const result = await discoverMergedMrs({
      port,
      window: windowOf(fixture),
      targetBranch: fixture.targetBranch,
    });
    expect(port.requested).toEqual([1, 2]);
    expect(iids(result.selected)).toEqual([5203]);
    expect(selectionOf(result.selected, 5203).mergedAt).toBe("2026-09-14T18:45:00.000Z");
    expect(result.disposition).toBe("complete");
  });

  it("follows nextPage until the port stops and records pagesRead", async () => {
    const fixture = loadFixture("pages-multi");
    const port = portFor(fixture);
    const result = await discoverMergedMrs({
      port,
      window: windowOf(fixture),
      targetBranch: fixture.targetBranch,
    });
    expect(port.requested).toEqual([1, 2, 3, 4]);
    expect(result.pagesRead).toBe(4);
    expect(result.lastGoodPage).toBe(4);
    expect(result.rowsRead).toBe(8);
    expect(result.itemsRead).toBe(8);
    expect(result.duplicateRows).toEqual([]);
    expect(result.disposition).toBe("complete");
    expect(result.failureCode).toBeNull();
  });

  it("stops early only when the port declares merged_at descending ordering", async () => {
    const fixture = loadFixture("ordered-descending");
    const port = portFor(fixture, { ordered: true });
    const result = await discoverMergedMrs({
      port,
      window: windowOf(fixture),
      targetBranch: fixture.targetBranch,
    });
    // Pages 1-3 cover the window; page 4 is the confirmation read. Pages 5-6
    // are never requested.
    expect(port.requested).toEqual([1, 2, 3, 4]);
    expect(result.pagesRead).toBe(4);
    expect(result.disposition).toBe("complete");
    expect(iids(result.selected)).toEqual([5501, 5503, 5504, 5505]);
  });

  it("stops early without dropping a single in-window merge an exhaustive walk finds", async () => {
    const fixture = loadFixture("ordered-descending");
    const early = await walk(fixture, { ordered: true });
    const exhaustive = await walk(fixture, { ordered: false });
    expect(iids(exhaustive.selected)).toEqual([5501, 5503, 5504, 5505]);
    expect(iids(early.selected)).toEqual(iids(exhaustive.selected));
    expect(early.selected).toEqual(exhaustive.selected);
    expect(early.pagesRead).toBe(4);
    expect(exhaustive.pagesRead).toBe(6);
    expect(early.disposition).toBe("complete");
  });

  it("walks every page to exhaustion when the port does not declare an ordering", async () => {
    const fixture = loadFixture("pages-multi");
    const unordered = await walk(fixture, { ordered: false });
    expect(iids(unordered.selected)).toContain(4108);
    expect(selectionOf(unordered.selected, 4108).mergedAt).toBe("2026-09-14T12:00:00.000Z");
    expect(unordered.pagesRead).toBe(4);
    expect(unordered.disposition).toBe("complete");
  });

  it("deduplicates a merge request a shifting list returns on two pages", async () => {
    const fixture = loadFixture("shifting-list");
    const result = await walk(fixture, { ordered: true });
    expect(iids(result.selected)).toEqual([5001, 5002, 5003, 5004]);
    expect(result.duplicateRows).toEqual([5002]);
    expect(result.rowsRead).toBe(5);
    expect(result.itemsRead).toBe(4);
    expect(result.disposition).toBe("complete");
    // The repeat must not survive anywhere: a doubled selection would make the
    // retained evidence disagree with the drift map, which is keyed by iid.
    expect(result.selected.filter((entry) => entry.iid === 5002)).toHaveLength(1);
    expect(iids(detectMergedMrCommitDrift(result.selected, result.selected))).toEqual([]);
    expect(new Set(iids(result.selected)).size).toBe(result.selected.length);
  });

  it("refuses a page that contradicts the declared merged_at ordering", async () => {
    const fixture = loadFixture("ordering-violated");
    const port = portFor(fixture, { ordered: true });
    const result = await discoverMergedMrs({
      port,
      window: windowOf(fixture),
      targetBranch: fixture.targetBranch,
    });
    expect(result.disposition).toBe("ordering-violated");
    expect(result.windowCovered).toBe(false);
    expect(result.pagesRead).toBe(2);
    expect(result.lastGoodPage).toBe(1);
    expect(iids(result.selected)).toEqual([6601, 6602]);
    // Nothing from the untrusted page or beyond it is claimed as covered.
    expect(iids(result.selected)).not.toContain(6604);
    expect(port.requested).toEqual([1, 2]);
  });

  it("selects the same fixture completely when the port makes no ordering claim", async () => {
    const fixture = loadFixture("ordering-violated");
    const result = await walk(fixture, { ordered: false });
    expect(result.disposition).toBe("complete");
    expect(result.windowCovered).toBe(true);
    expect(iids(result.selected)).toEqual([6601, 6602, 6603, 6604, 6605]);
  });

  it("catches an ordering claim that breaks on the page after the early stop", async () => {
    const fixture = loadFixture("pages-multi");
    const port = portFor(fixture, { ordered: true });
    const result = await discoverMergedMrs({
      port,
      window: windowOf(fixture),
      targetBranch: fixture.targetBranch,
    });
    // Page 3 falls below the window start, but page 4 holds an in-window merge
    // out of order; the confirmation page turns that into a refusal rather
    // than silent data loss.
    expect(port.requested).toEqual([1, 2, 3, 4]);
    expect(result.disposition).toBe("ordering-violated");
    expect(result.disposition).not.toBe("complete");
    expect(result.windowCovered).toBe(false);
  });

  it("rejects a port that repeats a page number instead of advancing", async () => {
    const fixture = loadFixture("page-two-match");
    const looping: MergedMrPagePortV1 = {
      orderedDescendingByMergedAt: false,
      async fetchPage() {
        return { items: pageOf(fixture, 1).items, nextPage: 1 };
      },
    };
    await expect(
      discoverMergedMrs({
        port: looping,
        window: windowOf(fixture),
        targetBranch: fixture.targetBranch,
      }),
    ).rejects.toThrowError(
      /must advance nextPage beyond the page it just returned, or report null\. Page requested: 1; nextPage reported: 1\./u,
    );
  });

  it("reports item-limit-reached when the bounded cap is hit before the window is covered", async () => {
    const fixture = loadFixture("pages-multi");
    const result = await walk(fixture, { maxRows: 3 });
    expect(result.disposition).toBe("item-limit-reached");
    expect(result.windowCovered).toBe(false);
    expect(result.pagesRead).toBe(1);
    expect(result.rowsRead).toBe(3);
    expect(iids(result.selected)).toEqual([4101, 4102]);
  });

  it("reports page-limit-reached when the page cap stops a walk the port has not finished", async () => {
    const fixture = loadFixture("pages-multi");
    const result = await walk(fixture, { maxPages: 2 });
    expect(result.disposition).toBe("page-limit-reached");
    expect(result.windowCovered).toBe(false);
    expect(result.pagesRead).toBe(2);
    expect(result.lastGoodPage).toBe(2);
    expect(iids(result.selected)).toEqual([4101, 4102, 4104, 4105]);
  });
});

describe("merged-MR retrieval dispositions (#896)", () => {
  it("reports exhausted-empty for a fully walked window with no matches", async () => {
    const fixture = loadFixture("no-matching-merges");
    const result = await walk(fixture);
    expect(result.disposition).toBe("exhausted-empty");
    expect(result.windowCovered).toBe(true);
    expect(result.selected).toEqual([]);
    expect(result.failureCode).toBeNull();
    expect(result.pagesRead).toBe(2);
    expect(result.excluded.map((entry) => `${entry.iid}:${entry.reason}`)).toEqual([
      "2901:other-target-branch",
      "2902:before-window",
    ]);
  });

  it("reports page-failed with the last good page when page two errors and never reports complete", async () => {
    const fixture = loadFixture("page-two-failure");
    const result = await walk(fixture);
    expect(result.disposition).toBe("page-failed");
    expect(result.disposition).not.toBe("complete");
    expect(result.lastGoodPage).toBe(1);
    expect(result.pagesRead).toBe(1);
    expect(result.windowCovered).toBe(false);
    expect(iids(result.selected)).toEqual([9801]);
  });

  it("refuses to report exhausted-empty when a later page failed", async () => {
    const fixture = loadFixture("page-two-failure");
    const result = await walk(fixture, { targetBranch: "docs/site" });
    expect(result.selected).toEqual([]);
    expect(result.disposition).toBe("page-failed");
    expect(result.disposition).not.toBe("exhausted-empty");
    expect(result.windowCovered).toBe(false);
    expect(result.failureCode).toBe("authentication");
  });

  it("retains the authentication failure as a shared code the operator message resolves from", async () => {
    const fixture = loadFixture("page-two-failure");
    const result = await walk(fixture, { failureCode: "authentication" });
    expect(result.failureCode).toBe("authentication");
    expect(GITLAB_READ_FAILURES[result.failureCode!]).toMatch(
      /^GitLab authentication failed\. Run glab auth login/u,
    );
    expect(result.windowCovered).toBe(false);
  });

  it("retains the denied-access failure as a shared code and marks the window uncovered", async () => {
    const fixture = loadFixture("page-two-failure");
    const result = await walk(fixture, { failureCode: "access" });
    expect(result.failureCode).toBe("access");
    expect(GITLAB_READ_FAILURES[result.failureCode!]).toMatch(
      /^GitLab denied access to the selected project or merge request\./u,
    );
    expect(result.windowCovered).toBe(false);
    expect(result.disposition).toBe("page-failed");
  });

  it("never copies the port's error text into the retained result", async () => {
    const fixture = loadFixture("page-two-failure");
    const result = await walk(fixture, { failureCode: "credentials" });
    expect(result.failureCode).toBe("credentials");
    // The port threw with the full operator message attached; only the code is
    // retained, so nothing a caller might later write back to GitLab carries
    // upstream text.
    expect(JSON.stringify(result)).not.toContain(GITLAB_READ_FAILURES.credentials);
    expect(JSON.stringify(result)).not.toContain("credential-like pattern");
  });

  it("maps an untagged port rejection to the request code without retaining its message", async () => {
    const fixture = loadFixture("page-two-match");
    const untagged: MergedMrPagePortV1 = {
      orderedDescendingByMergedAt: false,
      async fetchPage(page: number) {
        if (page === 1) return { items: pageOf(fixture, 1).items, nextPage: 2 };
        throw new Error("glab exited 1: unexpected chatter from the host toolchain");
      },
    };
    const result = await discoverMergedMrs({
      port: untagged,
      window: windowOf(fixture),
      targetBranch: fixture.targetBranch,
    });
    expect(result.disposition).toBe("page-failed");
    expect(result.failureCode).toBe("request");
    expect(MERGED_MR_FAILURE_CODES).toContain(result.failureCode!);
    expect(JSON.stringify(result)).not.toContain("unexpected chatter");
  });

  it("reports page-failed with the response code for a malformed row and keeps earlier pages", async () => {
    const fixture = loadFixture("page-two-match");
    const malformed: MergedMrPagePortV1 = {
      orderedDescendingByMergedAt: false,
      async fetchPage(page: number) {
        if (page === 1) return { items: pageOf(fixture, 2).items, nextPage: 2 };
        return {
          items: [{ iid: "not-a-number" } as unknown as MergedMrRecordV1],
          nextPage: null,
        };
      },
    };
    const result = await discoverMergedMrs({
      port: malformed,
      window: windowOf(fixture),
      targetBranch: fixture.targetBranch,
    });
    expect(result.disposition).toBe("page-failed");
    expect(result.failureCode).toBe("response");
    expect(result.windowCovered).toBe(false);
    expect(result.lastGoodPage).toBe(1);
    expect(iids(result.selected)).toEqual([5203]);
  });

  it("keeps one failure vocabulary shared with the GitLab read tool", () => {
    expect([...MERGED_MR_FAILURE_CODES]).toEqual(Object.keys(GITLAB_READ_FAILURES));
  });

  it("selects page two's match from the same fixture when the injected page failure is removed", async () => {
    const fixture = loadFixture("page-two-failure");
    const result = await walk(fixture, { honourFailures: false });
    expect(result.disposition).toBe("complete");
    expect(result.windowCovered).toBe(true);
    expect(result.failureCode).toBeNull();
    expect(iids(result.selected)).toEqual([9801, 9802]);
    expect(result.pagesRead).toBe(2);
  });

  it("retains a truncated page flag as a per-MR evidence gap rather than dropping the MR", async () => {
    const fixture = loadFixture("truncated-page");
    const result = await walk(fixture);
    expect(iids(result.selected)).toEqual([1901]);
    expect(selectionOf(result.selected, 1901).evidenceGaps).toEqual(["truncated-source-page"]);
    expect(result.truncatedPages).toEqual([1]);
    expect(result.disposition).toBe("complete");
  });

  it("aborts on a signal and reports the partial walk as cancelled rather than complete", async () => {
    const fixture = loadFixture("pages-multi");
    const controller = new AbortController();
    const result = await walk(fixture, {
      signal: controller.signal,
      onPage: (page) => {
        if (page === 1) controller.abort();
      },
    });
    expect(result.disposition).toBe("cancelled");
    expect(result.disposition).not.toBe("complete");
    expect(result.windowCovered).toBe(false);
    expect(result.pagesRead).toBe(1);
    expect(iids(result.selected)).toEqual([4101, 4102]);
    expect(iids(result.selected)).not.toContain(4104);
  });

  it("reports cancelled, not page-failed, when the port rejects because the walk was aborted", async () => {
    const fixture = loadFixture("pages-multi");
    const controller = new AbortController();
    const aborting: MergedMrPagePortV1 = {
      orderedDescendingByMergedAt: false,
      async fetchPage(page: number) {
        if (page === 1) return { items: pageOf(fixture, 1).items, nextPage: 2 };
        controller.abort();
        // What a real adapter does when its request is torn down mid-flight.
        throw new Error("The operation was aborted.");
      },
    };
    const result = await discoverMergedMrs({
      port: aborting,
      window: windowOf(fixture),
      targetBranch: fixture.targetBranch,
      signal: controller.signal,
    });
    expect(result.disposition).toBe("cancelled");
    expect(result.disposition).not.toBe("page-failed");
    expect(result.failureCode).toBeNull();
    expect(result.windowCovered).toBe(false);
    expect(JSON.stringify(result)).not.toContain("The operation was aborted.");
    expect(iids(result.selected)).toEqual([4101, 4102]);
  });
});

describe("merged-MR module purity (#896)", () => {
  it("imports no filesystem, process, or network module in either selection module", () => {
    for (const source of [selectionSource, discoverySource]) {
      expect(source).not.toMatch(/from "node:/u);
      expect(source).not.toMatch(/require\(/u);
      expect(source).not.toMatch(/child_process/u);
      expect(source).not.toMatch(/\bfetch\(/u);
      expect(source).not.toMatch(/Date\.now/u);
    }
    const imports = (source: string) =>
      [...source.matchAll(/from "([^"]+)"/gu)].map((match) => match[1]);
    expect(imports(selectionSource)).toEqual(["./gitlab-mr-locator.js"]);
    expect(imports(discoverySource)).toEqual(["./merged-mr-selection.js"]);
  });

  it("copies no GitLab failure message text into the selection or discovery modules", () => {
    for (const message of Object.values(GITLAB_READ_FAILURES)) {
      expect(selectionSource).not.toContain(message);
      expect(discoverySource).not.toContain(message);
    }
  });
});
