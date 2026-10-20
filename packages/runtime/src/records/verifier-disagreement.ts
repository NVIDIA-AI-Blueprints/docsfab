// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Verifier disagreement (#1439): a host-derived comparison between a
 * provisional technical verification and the canonical technical verification
 * that follows it in the same run.
 *
 * The canonical pass may drop or reverse an objection the provisional pass
 * raised, and nothing else in the record says so: the correction evidence
 * accounts for ledger obligations, not for provisional facts or issues, and
 * the two summaries number their facts and issues independently. This module
 * lines the two passes up by content, never by ID, and names each provisional
 * objection the canonical pass did not keep and each canonical issue the
 * provisional pass never raised.
 *
 * It is a pure function of two already-validated verification results. It
 * copies no model prose into the record: rows carry step-local IDs, closed
 * dispositions, the issue category, and a digest of the fact key, so a reader
 * opens the two summaries to read the statements themselves.
 */
import { createHash } from "node:crypto";

import type {
  TechnicalSourceFact,
  VerificationResult,
} from "../workflow-execution/review-response.js";

export const VERIFIER_DISAGREEMENT_KIND = "docsfab-verifier-disagreement" as const;

/** Provisional dispositions that object to the page: the only ones compared. */
export const VERIFIER_DISAGREEMENT_PROVISIONAL_DISPOSITIONS = ["omitted", "conflicting"] as const;
/** Canonical fates that drop a provisional objection. `absent`: no matching fact. */
export const VERIFIER_DISAGREEMENT_CANONICAL_DISPOSITIONS = ["documented", "absent"] as const;
/** Closed reasons a comparison could not run. */
export const VERIFIER_DISAGREEMENT_UNAVAILABLE_REASONS = [
  "provisional-summary-undecodable",
] as const;

export type VerifierDisagreementProvisionalDisposition =
  (typeof VERIFIER_DISAGREEMENT_PROVISIONAL_DISPOSITIONS)[number];
export type VerifierDisagreementCanonicalDisposition =
  (typeof VERIFIER_DISAGREEMENT_CANONICAL_DISPOSITIONS)[number];
export type VerifierDisagreementUnavailableReason =
  (typeof VERIFIER_DISAGREEMENT_UNAVAILABLE_REASONS)[number];

/** A provisional objection the canonical pass documented or no longer lists. */
export interface VerifierDisagreementFactRowV1 {
  readonly kind: "fact";
  readonly provisionalFactId: string;
  readonly provisionalDisposition: VerifierDisagreementProvisionalDisposition;
  /** The canonical fact with the same key; null exactly when `absent`. */
  readonly canonicalFactId: string | null;
  readonly canonicalDisposition: VerifierDisagreementCanonicalDisposition;
  /** SHA-256 of the normalized statement and sorted locators both passes matched on. */
  readonly factKeySha256: string;
}

/** A canonical issue with no provisional counterpart. */
export interface VerifierDisagreementIssueRowV1 {
  readonly kind: "canonical-issue";
  readonly canonicalIssueId: string;
  readonly category: string;
}

export type VerifierDisagreementRowV1 =
  | VerifierDisagreementFactRowV1
  | VerifierDisagreementIssueRowV1;

/**
 * Retained on a canonical technical step, beside (never inside) its
 * `technicalCorrectionEvidence`. `compared` with no rows means the passes
 * agree; `unavailable` means no comparison ran, so a count reads it as
 * unknown rather than as agreement.
 */
export type VerifierDisagreementV1 =
  | {
      readonly schemaVersion: 1;
      readonly kind: typeof VERIFIER_DISAGREEMENT_KIND;
      readonly provisionalStepId: string;
      readonly status: "compared";
      readonly rows: readonly VerifierDisagreementRowV1[];
    }
  | {
      readonly schemaVersion: 1;
      readonly kind: typeof VERIFIER_DISAGREEMENT_KIND;
      readonly provisionalStepId: string;
      readonly status: "unavailable";
      readonly reason: VerifierDisagreementUnavailableReason;
    };

/** One provisional fact and the canonical fact it lines up with, if any. */
export interface TechnicalFactPairing {
  readonly provisionalFactId: string;
  readonly canonicalFactId: string | null;
}

const SHA256_HEX = /^[a-f0-9]{64}$/u;

/**
 * The content key both passes are matched on: the statement with runs of
 * whitespace collapsed and trimmed (case kept, since identifiers are
 * case-significant) plus the sorted, de-duplicated exact locator strings.
 * Locators are not reduced to their first line: distinct ranges in one file
 * are distinct facts.
 */
export function technicalFactKey(
  fact: Pick<TechnicalSourceFact, "statement" | "sourceLocators">,
): string {
  const statement = fact.statement.replace(/\s+/gu, " ").trim();
  const locators = [...new Set(fact.sourceLocators)].sort();
  return JSON.stringify([statement, locators]);
}

function inventoryFacts(result: VerificationResult): TechnicalSourceFact[] {
  return result.factInventory.dimensions.flatMap((dimension) => dimension.facts);
}

/** The first canonical fact for each key, in inventory order. */
function canonicalFactsByKey(canonical: VerificationResult): Map<string, TechnicalSourceFact> {
  const byKey = new Map<string, TechnicalSourceFact>();
  for (const fact of inventoryFacts(canonical)) {
    const key = technicalFactKey(fact);
    if (!byKey.has(key)) byKey.set(key, fact);
  }
  return byKey;
}

/** Line every provisional fact up with the canonical fact sharing its key. */
export function pairTechnicalFacts(
  provisional: VerificationResult,
  canonical: VerificationResult,
): TechnicalFactPairing[] {
  const byKey = canonicalFactsByKey(canonical);
  return inventoryFacts(provisional).map((fact) => ({
    provisionalFactId: fact.id,
    canonicalFactId: byKey.get(technicalFactKey(fact))?.id ?? null,
  }));
}

/** Fact keys of the facts that link this issue by ID, in the issue's own pass. */
function linkedFactKeys(result: VerificationResult, issueId: string): Set<string> {
  return new Set(
    inventoryFacts(result)
      .filter((fact) => fact.issueIds.includes(issueId))
      .map((fact) => technicalFactKey(fact)),
  );
}

/**
 * Issue fields read as text. The inputs are validated verification results,
 * whose review schema requires `id`, `category`, and `location` on every issue.
 */
function issueText(issue: Record<string, unknown>, field: "id" | "category" | "location"): string {
  return String(issue[field]);
}

/**
 * Canonical issues with no provisional counterpart. Matching is one-to-one
 * and greedy, in two passes over the canonical issues: first to an unmatched
 * provisional issue that shares at least one linked-fact key, then, for the
 * rest, to an unmatched provisional issue with the same category and
 * location. Issue IDs are never compared: each pass numbers its own.
 */
function unmatchedCanonicalIssues(
  provisional: VerificationResult,
  canonical: VerificationResult,
): Record<string, unknown>[] {
  const provisionalIssues = provisional.review.issues.map((issue) => ({
    issue,
    linked: linkedFactKeys(provisional, issueText(issue, "id")),
  }));
  const canonicalIssues = canonical.review.issues.map((issue) => ({
    issue,
    linked: linkedFactKeys(canonical, issueText(issue, "id")),
  }));
  const used = new Set<number>();
  const matched = new Set<number>();
  const claim = (canonicalIndex: number, accepts: (index: number) => boolean): void => {
    const found = provisionalIssues.findIndex((_, index) => !used.has(index) && accepts(index));
    if (found < 0) return;
    used.add(found);
    matched.add(canonicalIndex);
  };
  canonicalIssues.forEach(({ linked }, canonicalIndex) => {
    claim(canonicalIndex, (index) =>
      [...provisionalIssues[index]!.linked].some((key) => linked.has(key)),
    );
  });
  canonicalIssues.forEach(({ issue }, canonicalIndex) => {
    if (matched.has(canonicalIndex)) return;
    claim(canonicalIndex, (index) => {
      const candidate = provisionalIssues[index]!.issue;
      return (
        issueText(candidate, "category") === issueText(issue, "category") &&
        issueText(candidate, "location") === issueText(issue, "location")
      );
    });
  });
  return canonicalIssues
    .filter((_, canonicalIndex) => !matched.has(canonicalIndex))
    .map(({ issue }) => issue);
}

function isProvisionalObjection(
  disposition: TechnicalSourceFact["documentationDisposition"],
): disposition is VerifierDisagreementProvisionalDisposition {
  return (VERIFIER_DISAGREEMENT_PROVISIONAL_DISPOSITIONS as readonly string[]).includes(
    disposition,
  );
}

/**
 * Compare a provisional and a canonical verification result of the same
 * candidate. Rows, in order: each provisional `omitted` or `conflicting` fact
 * whose canonical counterpart is `documented` or absent, then each canonical
 * issue with no provisional counterpart. A canonical fact that stays
 * `omitted`/`conflicting`, or turns `unverified-policy`/`product-defect`, is
 * not a dropped objection and yields no row; neither does a provisional
 * `documented` fact the canonical pass objects to.
 */
export function compareVerifierPasses(
  provisional: VerificationResult,
  canonical: VerificationResult,
): VerifierDisagreementRowV1[] {
  const byKey = canonicalFactsByKey(canonical);
  const rows: VerifierDisagreementRowV1[] = [];
  for (const fact of inventoryFacts(provisional)) {
    const disposition = fact.documentationDisposition;
    if (!isProvisionalObjection(disposition)) continue;
    const key = technicalFactKey(fact);
    const counterpart = byKey.get(key);
    const canonicalDisposition = counterpart ? counterpart.documentationDisposition : "absent";
    if (canonicalDisposition !== "documented" && canonicalDisposition !== "absent") continue;
    rows.push({
      kind: "fact",
      provisionalFactId: fact.id,
      provisionalDisposition: disposition,
      canonicalFactId: counterpart ? counterpart.id : null,
      canonicalDisposition,
      factKeySha256: createHash("sha256").update(key).digest("hex"),
    });
  }
  for (const issue of unmatchedCanonicalIssues(provisional, canonical)) {
    rows.push({
      kind: "canonical-issue",
      canonicalIssueId: issueText(issue, "id"),
      category: issueText(issue, "category"),
    });
  }
  return rows;
}

/**
 * The record field for one canonical step. `provisional` is the paired
 * provisional step's summary as the run's admitted decoder read it; the
 * decoder returns `undefined` for a summary it cannot read, and that one
 * condition records `unavailable` instead of a comparison. It never throws on
 * that input: an unreadable provisional summary must not fail the canonical
 * step it annotates.
 */
export function recordVerifierDisagreement(input: {
  readonly provisionalStepId: string;
  readonly provisional: VerificationResult | undefined;
  readonly canonical: VerificationResult;
}): VerifierDisagreementV1 {
  const base = {
    schemaVersion: 1,
    kind: VERIFIER_DISAGREEMENT_KIND,
    provisionalStepId: input.provisionalStepId,
  } as const;
  if (input.provisional === undefined) {
    return {
      ...base,
      status: "unavailable",
      reason: "provisional-summary-undecodable",
    };
  }
  return {
    ...base,
    status: "compared",
    rows: compareVerifierPasses(input.provisional, input.canonical),
  };
}

/**
 * How many disagreements a retained field counts: its row count when the
 * passes were compared, `null` when they were not. A value that is not a
 * well-formed field also reads `null`; callers that must refuse it use
 * {@link isVerifierDisagreement}.
 */
export function verifierDisagreementCount(value: unknown): number | null {
  if (!isVerifierDisagreement(value) || value.status !== "compared") return null;
  return value.rows.length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const present = Object.keys(value);
  return present.length === keys.length && keys.every((key) => present.includes(key));
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isRow(value: unknown): value is VerifierDisagreementRowV1 {
  if (!isRecord(value)) return false;
  if (value.kind === "canonical-issue") {
    return (
      hasExactKeys(value, ["kind", "canonicalIssueId", "category"]) &&
      isText(value.canonicalIssueId) &&
      isText(value.category)
    );
  }
  if (value.kind !== "fact") return false;
  const absent = value.canonicalDisposition === "absent";
  return (
    hasExactKeys(value, [
      "kind",
      "provisionalFactId",
      "provisionalDisposition",
      "canonicalFactId",
      "canonicalDisposition",
      "factKeySha256",
    ]) &&
    isText(value.provisionalFactId) &&
    (VERIFIER_DISAGREEMENT_PROVISIONAL_DISPOSITIONS as readonly unknown[]).includes(
      value.provisionalDisposition,
    ) &&
    (VERIFIER_DISAGREEMENT_CANONICAL_DISPOSITIONS as readonly unknown[]).includes(
      value.canonicalDisposition,
    ) &&
    (absent ? value.canonicalFactId === null : isText(value.canonicalFactId)) &&
    typeof value.factKeySha256 === "string" &&
    SHA256_HEX.test(value.factKeySha256)
  );
}

/**
 * Closed-shape check for a retained field. With `provisionalStepId`, the
 * field must also name that step as its provisional pass.
 */
export function isVerifierDisagreement(
  value: unknown,
  provisionalStepId?: string,
): value is VerifierDisagreementV1 {
  if (!isRecord(value)) return false;
  if (value.schemaVersion !== 1 || value.kind !== VERIFIER_DISAGREEMENT_KIND) return false;
  if (!isText(value.provisionalStepId)) return false;
  if (provisionalStepId !== undefined && value.provisionalStepId !== provisionalStepId) {
    return false;
  }
  if (value.status === "compared") {
    return (
      hasExactKeys(value, ["schemaVersion", "kind", "provisionalStepId", "status", "rows"]) &&
      Array.isArray(value.rows) &&
      value.rows.every(isRow)
    );
  }
  return (
    value.status === "unavailable" &&
    hasExactKeys(value, ["schemaVersion", "kind", "provisionalStepId", "status", "reason"]) &&
    (VERIFIER_DISAGREEMENT_UNAVAILABLE_REASONS as readonly unknown[]).includes(value.reason)
  );
}
