// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { handleRunsCommand } from "../src/cli/commands/runs.js";
import { limit } from "../src/config/limits.js";
import { canonicalizeJsonEvidence } from "../src/json-evidence.js";
import {
  buildRunResultV1,
  formatRunSummary,
  projectHumanReviewFindings,
  serializeRunResultV1,
  type RunSummaryContext,
} from "../src/operator/index.js";
import type { RunRecord, StepRunRecord } from "../src/records/contracts.js";
import {
  projectReviewFindingsFromRun,
  REVIEW_FINDINGS_PROJECTOR,
  type ProjectedReviewFindingsV1,
  type ReviewFindingV1,
} from "../src/review/index.js";
import { authoringReviewFindingsRecord } from "./helpers/authoring-review-record.js";

// The human REVIEW FINDINGS presenter. Every test renders through
// `formatRunSummary`, the function `deliverCliRunResult` and
// `docsfab runs show` print, or through `handleRunsCommand` itself.

const RUN_ID = "run-review-findings-1334";
const RECORD_PATH = `/private/state/${RUN_ID}.json`;
const POINTER = `docsfab runs show ${RUN_ID} --json --state-dir /private/state`;
/** A finding sentence line, anchored so limitation codes that embed ids never match. */
const FINDING_LINE = /^ {2}\[(error|warning|info)\] (\S+) at /gmu;

const roots: string[] = [];

afterEach(async () => {
  process.exitCode = undefined;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

type Severity = "critical" | "major" | "minor";

function issue(id: string, severity: Severity, location = "docs/guide.md:18") {
  return {
    id,
    severity,
    category: "completeness",
    location,
    finding: `Finding ${id} names a documentation gap.`,
    evidence: { source_id: "source-1", locator: "src/index.ts:4" },
    required_change: `Document the behavior ${id} names.`,
  };
}

function step(id: string, skill: string, summary: string): StepRunRecord {
  return { id, title: id, skill, mode: "read-only", status: "succeeded", summary };
}

/**
 * A retained `review-documentation` record: a lint step whose result is
 * unavailable, a review step with admitted issues, and optionally a retried
 * review step that repeats them.
 */
function reviewRecord(
  issues: readonly ReturnType<typeof issue>[],
  options: { retry?: boolean; workflow?: string } = {},
): RunRecord {
  const review = canonicalizeJsonEvidence({ verdict: "needs-revision", issues: [...issues] });
  return {
    schemaVersion: 2,
    id: RUN_ID,
    workflow: options.workflow ?? "review-documentation",
    repository: {
      sourcePath: "/tmp/repository",
      requestedRevision: "HEAD",
      revision: "a".repeat(40),
    },
    workspace: { strategy: "tracked-export", disposable: true },
    status: "succeeded",
    createdAt: "2026-09-25T00:00:00.000Z",
    models: [],
    skills: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0 },
    tools: { totalCalls: 0, failedCalls: 0, byTool: [] },
    steps: [
      step("lint-documentation", "lint-documentation", "No supported native checks ran."),
      step("review-documentation", "review-documentation", review),
      ...(options.retry
        ? [step("review-documentation-retry", "review-documentation", review)]
        : []),
    ],
  } as RunRecord;
}

function summary(
  record: RunRecord,
  projection: ProjectedReviewFindingsV1 | undefined,
  extra: Partial<RunSummaryContext> = {},
): string {
  return formatRunSummary({
    record,
    recordPath: RECORD_PATH,
    exitCode: 0,
    repositoryPath: "/tmp/repository",
    tty: false,
    ...(projection ? { reviewFindingsProjection: projection } : {}),
    // `deliverCliRunResult` and `runs show` always set this for a review run
    // with no retained evaluator report, which is what renders QUALITY.
    ...(record.workflow === "review-documentation"
      ? { reportUnavailableReason: "no retained evaluator report" }
      : {}),
    ...extra,
  }).join("\n");
}

function findingLines(human: string): Array<{ severity: string; code: string }> {
  return [...human.matchAll(FINDING_LINE)].map((match) => ({
    severity: match[1]!,
    code: match[2]!,
  }));
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function issuesUpTo(count: number): ReturnType<typeof issue>[] {
  return Array.from({ length: count }, (_, index) =>
    issue(`DOC-${String(index + 1).padStart(3, "0")}`, "major"),
  );
}

describe("REVIEW FINDINGS for review-documentation (#1334)", () => {
  it("prints admitted review findings as sentences, not only a count", () => {
    const record = reviewRecord([issue("DOC-001", "major"), issue("DOC-002", "minor")]);
    const projection = projectHumanReviewFindings(record, projectReviewFindingsFromRun(record));
    expect(projection?.findings).toHaveLength(2);
    const human = summary(record, projection);

    expect(human).toContain("REVIEW FINDINGS\n  Availability: partial (2)");
    expect(human).toMatch(
      /^ {2}\[warning\] DOC-001 at docs\/guide\.md:18: Finding DOC-001 names a documentation gap\.$/mu,
    );
    expect(human).toMatch(/^ {2}Recommendation: Document the behavior DOC-001 names\.$/mu);
    expect(human).toMatch(/^ {2}Evidence: source-1: src\/index\.ts:4$/mu);
    expect(human).toMatch(
      /^ {2}\[info\] DOC-002 at docs\/guide\.md:18: Finding DOC-002 names a documentation gap\.$/mu,
    );
  });

  it("keeps the authoring REVIEW FINDINGS section (positive control)", () => {
    const record = authoringReviewFindingsRecord();
    const human = summary(record, projectHumanReviewFindings(record));
    expect(human).toContain("REVIEW FINDINGS\n  Availability: partial (2)");
    expect(findingLines(human)).toEqual([
      { severity: "warning", code: "FACT-001" },
      { severity: "info", code: "TASK-001" },
    ]);
  });

  it("does not render the section for a workflow that is neither review nor authoring", () => {
    // Adjacent condition: a projection handed to the presenter for another
    // workflow must not open REVIEW FINDINGS.
    const record = reviewRecord([issue("DOC-001", "major")], { workflow: "readiness" });
    const human = summary(record, projectReviewFindingsFromRun(record));
    expect(human).not.toContain("REVIEW FINDINGS");
    expect(findingLines(human)).toEqual([]);
  });
});

describe("top-N display bound (reviewFindings.summaryTopN)", () => {
  const topN = limit("reviewFindings.summaryTopN").value;

  it("prints every finding at the limit, with no omission line", () => {
    const record = reviewRecord(issuesUpTo(topN));
    const human = summary(record, projectReviewFindingsFromRun(record));
    expect(findingLines(human)).toHaveLength(topN);
    expect(human).not.toContain("Findings shown:");
  });

  it("prints N and names the omitted count and the JSON pointer at the limit plus one", () => {
    const record = reviewRecord(issuesUpTo(topN + 1));
    // The same selector `deliverCliRunResult` and `runs show` hand to both
    // the human presenter and the JSON builder.
    const projection = projectHumanReviewFindings(record, projectReviewFindingsFromRun(record))!;
    const human = summary(record, projection);
    expect(findingLines(human)).toHaveLength(topN);
    expect(human).toMatch(
      new RegExp(
        `^ {2}Findings shown: ${topN} of ${topN + 1} \\(severity, then id\\); 1 more: ${POINTER.replaceAll(".", "\\.")}$`,
        "mu",
      ),
    );

    // The bound is presentation only: the JSON result carries every admitted
    // finding and is byte-identical with or without the preloaded projection.
    const input = {
      record,
      recordPath: RECORD_PATH,
      exitCode: 0 as const,
      repositoryPath: "/tmp/r",
    };
    const withProjection = serializeRunResultV1(
      buildRunResultV1({ ...input, reviewFindingsProjection: projection }),
    );
    expect(withProjection).toBe(serializeRunResultV1(buildRunResultV1(input)));
    const parsed = JSON.parse(withProjection) as { reviewFindings: ReviewFindingV1[] };
    expect(parsed.reviewFindings).toHaveLength(topN + 1);
  });

  it("clips the authoring section with the same presenter", () => {
    const base = authoringReviewFindingsRecord();
    const projection = projectHumanReviewFindings(base)!;
    const extra: ReviewFindingV1[] = Array.from({ length: topN }, (_, index) => ({
      id: `finding:review-documentation:EDIT-${String(index + 1).padStart(3, "0")}:1`,
      severity: "info",
      code: `EDIT-${String(index + 1).padStart(3, "0")}`,
      summary: "An editorial gap.",
      path: "docs/usage.md",
    }));
    const widened: ProjectedReviewFindingsV1 = {
      ...projection,
      findings: [...projection.findings, ...extra],
    };
    const human = summary(base, widened);
    expect(findingLines(human)).toHaveLength(topN);
    expect(human).toContain(
      `Findings shown: ${topN} of ${topN + 2} (severity, then id); 2 more: docsfab runs show ${base.id} --json --state-dir /private/state`,
    );
  });
});

describe("display order and --quiet", () => {
  it("ranks error, then warning, then info, then id, even when the error has the last id", () => {
    const topN = limit("reviewFindings.summaryTopN").value;
    // The only `error` (critical) finding has the lexicographically last id,
    // so id order alone would push it past the display bound.
    const issues = [
      ...issuesUpTo(topN).map((value, index) =>
        index === 0 ? { ...value, severity: "minor" as const } : value,
      ),
      issue("DOC-999", "critical"),
    ];
    const record = reviewRecord(issues);
    const human = summary(record, projectReviewFindingsFromRun(record));
    const shown = findingLines(human);
    expect(shown[0]).toEqual({ severity: "error", code: "DOC-999" });
    expect(shown.slice(1).every((line) => line.severity === "warning")).toBe(true);
    expect(shown.map((line) => line.code)).not.toContain("DOC-001");

    const smaller = reviewRecord([
      issue("DOC-001", "minor"),
      issue("DOC-002", "major"),
      issue("DOC-003", "critical"),
    ]);
    expect(findingLines(summary(smaller, projectReviewFindingsFromRun(smaller)))).toEqual([
      { severity: "error", code: "DOC-003" },
      { severity: "warning", code: "DOC-002" },
      { severity: "info", code: "DOC-001" },
    ]);
  });

  it("prints no finding sentences under --quiet and keeps one collapsed limitation list", () => {
    const record = reviewRecord([issue("DOC-001", "major"), issue("DOC-002", "minor")], {
      retry: true,
    });
    const projection = projectReviewFindingsFromRun(record);
    expect(projection.limitations).toContain("review-findings-unparsed:lint-documentation");

    const quiet = summary(record, projection, { quiet: true });
    expect(quiet).not.toContain("REVIEW FINDINGS");
    expect(findingLines(quiet)).toEqual([]);
    expect(quiet).toContain("Review findings: partial (2)");
    expect(quiet).toMatch(/^ {2}Review findings limitation: review-findings-duplicate: 2$/mu);
    expect(occurrences(quiet, "review-findings-unparsed:lint-documentation")).toBe(1);

    const full = summary(record, projection);
    expect(findingLines(full)).toHaveLength(2);
    expect(full).toMatch(/^ {2}Limitation: review-findings-duplicate: 2$/mu);
    expect(full).not.toContain("Review findings limitation:");
    expect(occurrences(full, "review-findings-unparsed:lint-documentation")).toBe(1);
    expect(occurrences(full, "review-findings-duplicate")).toBe(1);
  });
});

it("keeps terminal fact finding presentation separate from retained review graph delivery", () => {
  const record = authoringReviewFindingsRecord();
  const projected = projectReviewFindingsFromRun(record);
  expect(projected.findings.some((finding) => finding.code === "FACT-001")).toBe(true);
  expect(projected.findings.some((finding) => finding.code === "TASK-001")).toBe(true);
  expect(Object.hasOwn(projected, "issues")).toBe(false);
});

describe("limitation collapse", () => {
  // Codes in the exact shapes `review/findings.ts` emits, with realistic
  // per-item family counts (60, 17, 6).
  const collapsible = [
    ...Array.from(
      { length: 60 },
      (_, index) =>
        `review-finding-fact-source-partial:FACT-${index + 1}:1:retained=run-step:verify-technical-accuracy:summary:fact:FACT-${index + 1}`,
    ),
    ...Array.from(
      { length: 17 },
      (_, index) =>
        `review-findings-duplicate:finding:verify-technical-accuracy:TECH-001:1:fact:${index + 1}`,
    ),
    ...Array.from(
      { length: 6 },
      (_, index) => `review-finding-location-partial:DOC-00${index + 1}`,
    ),
    "review-finding-location-unavailable:QF-009",
    "review-finding-fact-metadata-omitted:FACT-3:source-2:retained=run-step:verify-technical-accuracy:summary:fact:FACT-3",
    "review-finding-fact-statement-omitted:FACT-4:retained=run-step:verify-technical-accuracy:summary:fact:FACT-4",
  ];
  // Adjacent codes that must stay verbatim: several share a prefix with a
  // collapsed family (`review-finding-fact-`, `review-findings-omitted`).
  const verbatim = [
    "review-finding-fact-projection-omitted:finding-limit:3:starting=FACT-9:retained=run-step:verify-technical-accuracy:summary",
    "review-findings-coverage-unverified:verify-technical-accuracy:docs/guide.md",
    "review-findings-fact-inventory-limitation:1:Completeness is bounded-not-proven.:retained=run-step:verify-technical-accuracy:summary",
    "review-findings-human-review:review-documentation",
    "review-findings-invalid:review-documentation:schema",
    "review-findings-omitted-bytes:4",
    "review-findings-omitted:2",
    "review-findings-schema-unavailable:lint-documentation",
    "review-findings-unparsed:lint-documentation",
  ];
  const projection: ProjectedReviewFindingsV1 = {
    findings: [],
    limitations: [...collapsible, ...verbatim].sort(),
    availability: "partial",
    artifactLocator: null,
    projector: REVIEW_FINDINGS_PROJECTOR,
  };

  it("counts per-item families and keeps every other code verbatim, once", () => {
    const record = reviewRecord([]);
    const human = summary(record, projection);
    const section = human.slice(human.indexOf("REVIEW FINDINGS"), human.indexOf("\nQUALITY"));
    const limitationLines = section
      .split("\n")
      .filter((line) => line.startsWith("  Limitation: "))
      .map((line) => line.slice("  Limitation: ".length));
    expect(limitationLines).toEqual([
      ...verbatim,
      "review-finding-fact-metadata-omitted: 1",
      "review-finding-fact-source-partial: 60",
      "review-finding-fact-statement-omitted: 1",
      "review-finding-location-partial: 6",
      "review-finding-location-unavailable: 1",
      "review-findings-duplicate: 17",
      `per-item codes counted above are listed by ${POINTER}`,
    ]);
    for (const code of verbatim) expect(occurrences(human, code)).toBe(1);
    expect(human).not.toContain("Review findings limitation:");
  });

  it("prints no pointer line when nothing collapsed", () => {
    const record = reviewRecord([]);
    const human = summary(record, { ...projection, limitations: verbatim });
    expect(human).not.toContain("per-item codes counted above");
    for (const code of verbatim) expect(occurrences(human, code)).toBe(1);
  });
});

describe("docsfab runs show (shipped entry point)", () => {
  it("replays a saved review run with finding sentences and collapsed duplicates", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "docsfab-review-findings-1334-"));
    roots.push(stateDirectory);
    const record = reviewRecord([issue("DOC-001", "major"), issue("DOC-002", "critical")], {
      retry: true,
    });
    await writeFile(join(stateDirectory, `${record.id}.json`), `${JSON.stringify(record)}\n`, {
      mode: 0o600,
    });
    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => lines.push(String(message ?? ""));
    try {
      await handleRunsCommand(["show", record.id, "--state-dir", stateDirectory]);
    } finally {
      console.log = originalLog;
    }
    const human = lines.join("\n");
    expect(findingLines(human)).toEqual([
      { severity: "error", code: "DOC-002" },
      { severity: "warning", code: "DOC-001" },
    ]);
    expect(human).toMatch(/^ {2}Limitation: review-findings-duplicate: 2$/mu);
    expect(occurrences(human, "review-findings-unparsed:lint-documentation")).toBe(1);
  });
});
