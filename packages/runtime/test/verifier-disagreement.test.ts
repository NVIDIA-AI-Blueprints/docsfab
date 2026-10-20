// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../src/json-evidence.js";
import {
  compareVerifierPasses,
  isVerifierDisagreement,
  pairTechnicalFacts,
  recordVerifierDisagreement,
  technicalFactKey,
  verifierDisagreementCount,
  type VerifierDisagreementRowV1,
} from "../src/records/verifier-disagreement.js";
import {
  decodeAdmittedVerificationSummary,
  type TechnicalSourceFact,
  type VerificationResult,
} from "../src/workflow-execution/review-response.js";
import { verificationResultFixture } from "./helpers/verification.js";

/**
 * Technical-verification step summaries from the PRR 2026-09-25 runs,
 * trimmed to fact IDs, dispositions, statements, locators and issue links.
 */
const FIXTURE = JSON.parse(
  readFileSync(
    new URL(
      "./fixtures/verifier-disagreement/prr-20260925-technical-summaries.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  runs: Record<string, { workflow: string; steps: Record<string, VerificationResult> }>;
};

const PROVISIONAL = "provisional-technical-verification";
const CANONICAL = "verify-technical-accuracy";
const REVISED_PROVISIONAL = "provisional-revised-technical-verification";
const REVISED_CANONICAL = "verify-revised-technical-accuracy";

function summary(run: string, step: string): VerificationResult {
  const found = FIXTURE.runs[run]?.steps[step];
  if (!found) throw new Error(`fixture ${run} lacks step ${step}`);
  return structuredClone(found);
}

function facts(result: VerificationResult): TechnicalSourceFact[] {
  return result.factInventory.dimensions.flatMap((dimension) => dimension.facts);
}

function fact(result: VerificationResult, id: string): TechnicalSourceFact {
  const found = facts(result).find((candidate) => candidate.id === id);
  if (!found) throw new Error(`fixture lacks ${id}`);
  return found;
}

function keyDigest(result: VerificationResult, id: string): string {
  return createHash("sha256")
    .update(technicalFactKey(fact(result, id)))
    .digest("hex");
}

/** Rows without their key digest, for readable exact comparisons. */
function withoutDigest(rows: readonly VerifierDisagreementRowV1[]) {
  return rows.map((row) =>
    row.kind === "fact" ? { ...row, factKeySha256: undefined } : { ...row },
  );
}

function factRow(
  provisionalFactId: string,
  provisionalDisposition: "omitted" | "conflicting",
  canonicalFactId: string | null,
) {
  return {
    kind: "fact",
    provisionalFactId,
    provisionalDisposition,
    canonicalFactId,
    canonicalDisposition: canonicalFactId === null ? "absent" : "documented",
    factKeySha256: undefined,
  };
}

describe("verifier disagreement comparator on the d158e98a create run", () => {
  it("names the six dropped provisional objections and the two canonical-only issues of the first pair", () => {
    const provisional = summary("d158e98a", PROVISIONAL);
    const canonical = summary("d158e98a", CANONICAL);
    const rows = compareVerifierPasses(provisional, canonical);

    expect(withoutDigest(rows)).toEqual([
      factRow("FACT-3", "conflicting", "FACT-3"),
      factRow("FACT-4", "omitted", "FACT-4"),
      factRow("FACT-5", "omitted", "FACT-5"),
      factRow("FACT-6", "omitted", "FACT-6"),
      factRow("FACT-9", "omitted", "FACT-9"),
      factRow("FACT-13", "omitted", "FACT-13"),
      {
        kind: "canonical-issue",
        canonicalIssueId: "TECH-001",
        category: "completeness",
      },
      {
        kind: "canonical-issue",
        canonicalIssueId: "TECH-002",
        category: "technical_accuracy",
      },
    ]);
    // The digest is of the matched key, the same on both sides.
    const first = rows[0];
    expect(first?.kind === "fact" && first.factKeySha256).toBe(keyDigest(provisional, "FACT-3"));
    expect(keyDigest(provisional, "FACT-3")).toBe(keyDigest(canonical, "FACT-3"));
  });

  it("does not report canonical-added objections, the documented-to-omitted direction", () => {
    const provisional = summary("d158e98a", PROVISIONAL);
    const canonical = summary("d158e98a", CANONICAL);
    // Both transitions exist in the real run.
    expect(fact(provisional, "FACT-2").documentationDisposition).toBe("documented");
    expect(fact(canonical, "FACT-2").documentationDisposition).toBe("omitted");
    expect(fact(provisional, "FACT-21").documentationDisposition).toBe("documented");
    expect(fact(canonical, "FACT-21").documentationDisposition).toBe("omitted");

    const reported = compareVerifierPasses(provisional, canonical).flatMap((row) =>
      row.kind === "fact" ? [row.provisionalFactId] : [],
    );
    expect(reported).not.toContain("FACT-2");
    expect(reported).not.toContain("FACT-21");
  });

  it("reports exactly the HeadersInit fact for the revised pair", () => {
    const rows = compareVerifierPasses(
      summary("d158e98a", REVISED_PROVISIONAL),
      summary("d158e98a", REVISED_CANONICAL),
    );
    expect(withoutDigest(rows)).toEqual([factRow("FACT-3", "conflicting", "FACT-3")]);
    expect(fact(summary("d158e98a", REVISED_PROVISIONAL), "FACT-3").statement).toContain(
      "addCsrfToRequestHeaders accepts an optional HeadersInit",
    );
  });
});

describe("verifier disagreement comparator on the 683ab88d create run (IDs drift)", () => {
  it("matches facts by content: provisional FACT-15 is canonical FACT-13, and FACT-14 has no counterpart", () => {
    const provisional = summary("683ab88d", PROVISIONAL);
    const canonical = summary("683ab88d", CANONICAL);
    const pairing = new Map(
      pairTechnicalFacts(provisional, canonical).map((pair) => [
        pair.provisionalFactId,
        pair.canonicalFactId,
      ]),
    );
    expect(pairing.get("FACT-15")).toBe("FACT-13");
    expect(pairing.get("FACT-21")).toBe("FACT-19");
    expect(pairing.get("FACT-14")).toBeNull();

    const rows = compareVerifierPasses(provisional, canonical);
    expect(withoutDigest(rows)).toEqual([
      factRow("FACT-14", "omitted", null),
      {
        kind: "canonical-issue",
        canonicalIssueId: "TECH-002",
        category: "technical_accuracy",
      },
    ]);
    // FACT-15 matched canonical FACT-13 and both are documented: no row.
    expect(rows.some((row) => row.kind === "fact" && row.provisionalFactId === "FACT-15")).toBe(
      false,
    );
  });

  it("keeps an issue whose location moved but whose linked fact stayed (TECH-001, usage.md:70-72 -> :72)", () => {
    const provisional = summary("683ab88d", PROVISIONAL);
    const canonical = summary("683ab88d", CANONICAL);
    const provisionalIssue = provisional.review.issues.find((issue) => issue.id === "TECH-001");
    const canonicalIssue = canonical.review.issues.find((issue) => issue.id === "TECH-001");
    expect(provisionalIssue?.location).toBe("docs/usage.md:70-72");
    expect(canonicalIssue?.location).toBe("docs/usage.md:72");

    const issues = compareVerifierPasses(provisional, canonical).filter(
      (row) => row.kind === "canonical-issue",
    );
    expect(issues.map((row) => row.kind === "canonical-issue" && row.canonicalIssueId)).toEqual([
      "TECH-002",
    ]);
  });

  it("matches on a shared linked fact, not on an equal linked set", () => {
    const provisional = summary("683ab88d", PROVISIONAL);
    const canonical = summary("683ab88d", CANONICAL);
    // Canonical TECH-001 now also cites a fact no provisional issue cites;
    // it still shares FACT-4's key with provisional TECH-001, and its moved
    // location rules out the category/location fallback.
    fact(canonical, "FACT-1").issueIds = ["TECH-001"];
    const issues = compareVerifierPasses(provisional, canonical).filter(
      (row) => row.kind === "canonical-issue",
    );
    expect(issues).toEqual([
      {
        kind: "canonical-issue",
        canonicalIssueId: "TECH-002",
        category: "technical_accuracy",
      },
    ]);
  });

  it("reports an omitted fact the revised canonical pass no longer lists, and keeps TECH-001 whose linked set grew", () => {
    const rows = compareVerifierPasses(
      summary("683ab88d", REVISED_PROVISIONAL),
      summary("683ab88d", REVISED_CANONICAL),
    );
    expect(withoutDigest(rows)).toEqual([factRow("FACT-12", "omitted", null)]);
  });
});

describe("verifier disagreement comparator on agreeing review runs", () => {
  it.each(["1aba893c", "ac0e85b5"])("returns no rows for %s", (run) => {
    const provisional = summary(run, PROVISIONAL);
    const canonical = summary(run, CANONICAL);
    // Two issues share (completeness, README.md:28) on both sides.
    expect(
      canonical.review.issues.map((issue) => `${String(issue.category)} ${String(issue.location)}`),
    ).toEqual(["completeness README.md:28", "completeness README.md:28"]);
    expect(compareVerifierPasses(provisional, canonical)).toEqual([]);
    const field = recordVerifierDisagreement({
      provisionalStepId: PROVISIONAL,
      provisional,
      canonical,
    });
    expect(field).toEqual({
      schemaVersion: 1,
      kind: "docsfab-verifier-disagreement",
      provisionalStepId: PROVISIONAL,
      status: "compared",
      rows: [],
    });
    expect(verifierDisagreementCount(field)).toBe(0);
  });

  it("matches issues one to one: a second canonical issue at the same place is new", () => {
    // Provisional keeps only TECH-001; canonical keeps TECH-001 and TECH-002,
    // both at (completeness, README.md:28). TECH-001 takes the only
    // provisional issue, so TECH-002 has no counterpart left to claim.
    const provisional = summary("1aba893c", PROVISIONAL);
    const canonical = summary("1aba893c", CANONICAL);
    provisional.review.issues = provisional.review.issues.filter(
      (issue) => issue.id === "TECH-001",
    );
    for (const item of facts(provisional)) {
      item.issueIds = item.issueIds.filter((id) => id === "TECH-001");
    }
    const expected = [
      { kind: "canonical-issue", canonicalIssueId: "TECH-002", category: "completeness" },
    ];
    expect(compareVerifierPasses(provisional, canonical)).toEqual(expected);

    // Fallback only: with every link removed, (category, location) still
    // matches one provisional issue to one canonical issue.
    for (const item of [...facts(provisional), ...facts(canonical)]) item.issueIds = [];
    expect(compareVerifierPasses(provisional, canonical)).toEqual(expected);

    // Adjacent: with both provisional issues kept, both are claimed.
    const both = summary("1aba893c", PROVISIONAL);
    for (const item of [...facts(both), ...facts(canonical)]) item.issueIds = [];
    expect(compareVerifierPasses(both, canonical)).toEqual([]);
  });

  it("ignores whitespace-only statement differences", () => {
    const provisional = summary("1aba893c", PROVISIONAL);
    const canonical = summary("1aba893c", CANONICAL);
    for (const item of facts(canonical)) {
      item.statement = `  ${item.statement.replaceAll(" ", " \n\t ")}  `;
    }
    expect(compareVerifierPasses(provisional, canonical)).toEqual([]);
  });

  it("ignores the order of source locators", () => {
    const provisional = summary("1aba893c", PROVISIONAL);
    const canonical = summary("1aba893c", CANONICAL);
    const reordered = facts(canonical).filter((item) => item.sourceLocators.length > 1);
    expect(reordered.length).toBeGreaterThan(0);
    for (const item of reordered) item.sourceLocators.reverse();
    expect(compareVerifierPasses(provisional, canonical)).toEqual([]);
  });

  it("treats the same statement at a different locator as a different fact", () => {
    const provisional = summary("1aba893c", PROVISIONAL);
    const canonical = summary("1aba893c", CANONICAL);
    const moved = fact(canonical, "FACT-1");
    moved.sourceLocators = ["src/elsewhere.ts:1"];
    moved.documentationDisposition = "documented";
    moved.issueIds = [];
    expect(withoutDigest(compareVerifierPasses(provisional, canonical))).toEqual([
      factRow("FACT-1", "omitted", null),
    ]);
  });
});

describe("verifier disagreement record field", () => {
  it("records unavailable, without throwing, when the admitted decoder cannot read the provisional summary", () => {
    const canonical = summary("1aba893c", CANONICAL);
    const provisional = decodeAdmittedVerificationSummary("{not a verification summary");
    expect(provisional).toBeUndefined();
    const field = recordVerifierDisagreement({
      provisionalStepId: PROVISIONAL,
      provisional,
      canonical,
    });
    expect(field).toEqual({
      schemaVersion: 1,
      kind: "docsfab-verifier-disagreement",
      provisionalStepId: PROVISIONAL,
      status: "unavailable",
      reason: "provisional-summary-undecodable",
    });
    // Not compared reads as unknown, never as agreement.
    expect(verifierDisagreementCount(field)).toBeNull();
    expect(isVerifierDisagreement(field, PROVISIONAL)).toBe(true);
  });

  it("compares, and counts zero, when the admitted decoder reads the provisional summary", () => {
    const current = verificationResultFixture(["docs/usage.md"]);
    const provisional = decodeAdmittedVerificationSummary(
      canonicalizeJsonEvidence(current as unknown as JsonEvidenceValue).trimEnd(),
    );
    expect(provisional).toBeDefined();
    const field = recordVerifierDisagreement({
      provisionalStepId: PROVISIONAL,
      provisional,
      canonical: current,
    });
    expect(field).toMatchObject({ status: "compared", rows: [] });
    expect(verifierDisagreementCount(field)).toBe(0);
  });

  it("admits the fields the comparator writes and refuses other shapes", () => {
    const field = recordVerifierDisagreement({
      provisionalStepId: PROVISIONAL,
      provisional: summary("683ab88d", PROVISIONAL),
      canonical: summary("683ab88d", CANONICAL),
    });
    expect(isVerifierDisagreement(field, PROVISIONAL)).toBe(true);
    expect(verifierDisagreementCount(field)).toBe(2);
    // Another step's provisional pass.
    expect(isVerifierDisagreement(field, REVISED_PROVISIONAL)).toBe(false);
    // An extra key, or prose copied into a row.
    expect(isVerifierDisagreement({ ...field, note: "x" })).toBe(false);
    const rows = field.status === "compared" ? field.rows : [];
    expect(
      isVerifierDisagreement({
        ...field,
        rows: [{ ...rows[0], statement: "copied prose" }],
      }),
    ).toBe(false);
    // An absent canonical fact cannot also name one.
    expect(
      isVerifierDisagreement({
        ...field,
        rows: [{ ...rows[0], canonicalFactId: "FACT-14" }],
      }),
    ).toBe(false);
    // A canonical disposition outside the closed list.
    expect(
      isVerifierDisagreement({
        ...field,
        rows: [{ ...rows[0], canonicalDisposition: "omitted" }],
      }),
    ).toBe(false);
    expect(verifierDisagreementCount({ ...field, status: "agreed" })).toBeNull();
  });
});
