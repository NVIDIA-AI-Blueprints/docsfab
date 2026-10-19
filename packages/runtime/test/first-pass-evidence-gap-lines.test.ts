// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The limitation lines of a first pass that continued with evidence gaps
 * (#2113), read from the support record they describe. Each case states what
 * the line says about how first pass ended, so a line never claims a round, an
 * obligation, or a bound that the record does not hold. The pipeline cases in
 * first-pass-evidence-gaps replay real first passes into the same lines.
 */
import { describe, expect, it } from "vitest";

import { firstPassEvidenceGapLines } from "../src/cli/first-pass-support.js";
import type { RunRecord } from "../src/records/contracts.js";
import { appendEvidenceWarnings } from "../src/workflow-execution/runner-evidence.js";

const GAP = "first-pass-evidence-gaps: ";
const TARGET = "docs/guide.md";
const USED =
  "The run used the evidence first pass gathered; to give an obligation its evidence, name its source by path in the request or with --source <path>.";

interface Obligation {
  readonly id: string;
  readonly status: string;
  readonly requiredSourceSupport: boolean;
  readonly evidenceSpanIds: readonly string[];
  readonly targetPaths: readonly string[];
}

const obligation = (id: string, status: string, targetPaths = [TARGET]): Obligation => ({
  id,
  status,
  requiredSourceSupport: true,
  evidenceSpanIds: status === "supported" ? ["span-1"] : [],
  targetPaths,
});

/** A support record as first pass retains it, with the fields the lines read. */
function support(overrides: Record<string, unknown> = {}) {
  return {
    terminationReason: "no-progress",
    targetPaths: [TARGET],
    cost: { rounds: 2 },
    obligations: [obligation("target-01", "supported"), obligation("decomposed-values", "missing")],
    ...overrides,
  };
}

describe("how a first pass that continued with evidence gaps says it ended (#2113)", () => {
  it("claims an expansion round only when more than one assessment round ran", () => {
    // The record keeps one reason, no-progress, for a round after which no
    // fewer obligations were open and for an attempt to read further that found
    // no new evidence. With one assessment round no expansion round ran, so
    // only the second can be what ended it.
    const afterExpansion = firstPassEvidenceGapLines(support());
    expect(afterExpansion[0]).toBe(
      `${GAP}first pass continued after 2 assessment rounds with 1 mandatory obligation its repository evidence did not support. It ended no-progress: its last round either did not reduce the number of open obligations or found no new evidence, so reading further was not expected to close one. ${USED}`,
    );

    const withoutExpansion = firstPassEvidenceGapLines(support({ cost: { rounds: 1 } }));
    expect(withoutExpansion[0]).toBe(
      `${GAP}first pass continued after 1 assessment round with 1 mandatory obligation its repository evidence did not support. It ended no-progress: an attempt to read further found no new evidence, so reading further was not expected to close an open obligation. ${USED}`,
    );
    expect(withoutExpansion[0]).not.toContain("its last round");
    expect(afterExpansion.slice(1)).toEqual([`${GAP}obligation decomposed-values is missing.`]);
    expect(withoutExpansion.slice(1)).toEqual(afterExpansion.slice(1));
  });

  it("names a bound as the end of a pass an evidence bound stopped", () => {
    const lines = firstPassEvidenceGapLines(support({ terminationReason: "budget-exhausted" }));
    expect(lines[0]).toBe(
      `${GAP}first pass continued after 2 assessment rounds with 1 mandatory obligation its repository evidence did not support. It ended budget-exhausted: an evidence bound stopped its reading. ${USED}`,
    );
  });

  it("says its reading ended with obligations still open when no bound or stall ended it", () => {
    const lines = firstPassEvidenceGapLines(
      support({ terminationReason: "unresolved-obligations" }),
    );
    expect(lines[0]).toBe(
      `${GAP}first pass continued after 2 assessment rounds with 1 mandatory obligation its repository evidence did not support. It ended unresolved-obligations: its reading ended with obligations still open. ${USED}`,
    );
  });

  it("falls back to a plain statement for a reason it does not know", () => {
    const lines = firstPassEvidenceGapLines(support({ terminationReason: "a-new-reason" }));
    expect(lines[0]).toContain("It ended a-new-reason: obligations were still open. ");
  });
});

describe("a page without support of its own while every obligation is supported (#2113)", () => {
  // A supported obligation that binds two pages is evidence for neither page
  // alone, so both lack support of their own although nothing is open.
  const pages = ["docs/a.md", "docs/b.md"];
  const bothPages = support({
    targetPaths: pages,
    cost: { rounds: 1 },
    obligations: [obligation("decomposed-both", "supported", pages)],
  });
  const PAGE_LINE = `${GAP}first pass continued after 1 assessment round with every mandatory obligation supported, leaving 2 of 2 target pages without page support of its own. The run used the evidence first pass gathered; to give a page its own support, name its source by path in the request or with --source <path>.`;

  it("says every obligation is supported, never that none is or that some are open", () => {
    for (const terminationReason of ["supported", "unresolved-obligations"]) {
      const lines = firstPassEvidenceGapLines({ ...bothPages, terminationReason });
      // One line: nothing is open, so no obligation line follows.
      expect(lines).toEqual([PAGE_LINE]);
      expect(lines[0]).not.toMatch(/with 0 mandatory|still open|It ended/u);
    }
  });

  it("keeps the open-obligation wording when an obligation is open beside the page", () => {
    const lines = firstPassEvidenceGapLines({
      ...bothPages,
      terminationReason: "no-progress",
      obligations: [
        obligation("decomposed-both", "supported", pages),
        obligation("decomposed-x", "missing"),
      ],
    });
    expect(lines[0]).toBe(
      `${GAP}first pass continued after 1 assessment round with 1 mandatory obligation its repository evidence did not support, leaving 2 of 2 target pages without page support of its own. It ended no-progress: an attempt to read further found no new evidence, so reading further was not expected to close an open obligation. ${USED}`,
    );
    expect(lines.slice(1)).toEqual([`${GAP}obligation decomposed-x is missing.`]);
  });

  it("states nothing when every page has support of its own and every obligation is supported", () => {
    expect(
      firstPassEvidenceGapLines(
        support({
          terminationReason: "supported",
          obligations: [obligation("target-01", "supported")],
        }),
      ),
    ).toEqual([]);
  });
});

describe("the unread files a bound left, with the paths the request named (#2113)", () => {
  const BOUND = {
    bound: "maxSourceFiles",
    observed: 2,
    limit: 1,
  };
  const BOUND_LINE = `${GAP}source files read needed 2, over the limit of 1 (maxSourceFiles, firstPass.maxSourceFiles). To read more, raise DOCSFAB_FIRST_PASS_MAX_SOURCE_FILES (up to 100,000).`;
  const withUnread = (unreadFiles: unknown) =>
    firstPassEvidenceGapLines(
      support({ terminationReason: "budget-exhausted", exhaustedBounds: [BOUND], unreadFiles }),
    );

  it("counts the files and lists each named path on its own line, after the count", () => {
    const lines = withUnread({ count: 40, namedPaths: ["src/alpha.go", "src/beta.go"] });
    expect(lines.slice(1)).toEqual([
      `${GAP}obligation decomposed-values is missing.`,
      BOUND_LINE,
      `${GAP}reading stopped with 40 candidate source files unread, 2 of them named by path.`,
      `${GAP}named path src/alpha.go was left unread.`,
      `${GAP}named path src/beta.go was left unread.`,
    ]);
  });

  it("counts one unread file in the singular, and lists no path when the request named none", () => {
    expect(withUnread({ count: 1, namedPaths: [] }).slice(-1)).toEqual([
      `${GAP}reading stopped with 1 candidate source file unread.`,
    ]);
    expect(withUnread({ count: 12, namedPaths: [] }).join("\n")).not.toContain("named path");
  });

  it("writes every undisplayable character of a path as an escape, so the record keeps the line", () => {
    const lines = withUnread({
      count: 3,
      namedPaths: ["docs/‮evil.md", "src/new\nline.go", "src/tab\there.go"],
    });
    expect(lines.slice(-3)).toEqual([
      `${GAP}named path docs/\\u{202e}evil.md was left unread.`,
      `${GAP}named path src/new\\u{a}line.go was left unread.`,
      `${GAP}named path src/tab\\u{9}here.go was left unread.`,
    ]);
    // The run record replaces a line holding a control character with a fixed
    // placeholder; an escaped path line is kept as written.
    const record = {} as RunRecord;
    appendEvidenceWarnings(record, lines);
    expect(record.evidenceWarnings).toEqual([...lines]);
  });

  it("keeps a long path whole, one to a line, inside what the run record holds", () => {
    const deep = `src/${"nested-directory/".repeat(40)}file.go`;
    expect(deep.length).toBeGreaterThan(600);
    const lines = withUnread({ count: 2, namedPaths: [deep, "src/other.go"] });
    const record = {} as RunRecord;
    appendEvidenceWarnings(record, lines);
    expect(record.evidenceWarnings).toEqual([...lines]);
    expect(lines).toContain(`${GAP}named path ${deep} was left unread.`);
  });
});

it("keeps ordinary gap warnings beside a host-resolved original contradiction", () => {
  const value = support({
    obligations: [
      obligation("health-discrepancy", "contradicted"),
      obligation("missing-install", "missing"),
    ],
  });
  const lines = firstPassEvidenceGapLines(value, new Set(["health-discrepancy"]));
  expect(lines.join("\n")).toContain("missing-install is missing");
  expect(lines.join("\n")).not.toContain("health-discrepancy is contradicted");
});
