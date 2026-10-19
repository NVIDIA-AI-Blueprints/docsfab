// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The host's coverage rule table for a `review-documentation` judgment reply,
 * and the host-authored coverage of a run whose sealed ledger admitted no
 * source.
 *
 * Both judgment steps (`provisional-technical-verification` and
 * `verify-technical-accuracy`) decode the same shape through the same host
 * fill, which applies this table. Coverage faults are model content, and the
 * current rule is that only credentials and write or publish authority may
 * refuse, so model content degrades and continues.
 *
 * `create-documentation` keeps its coverage refusal: the gate is the workflow
 * name, not the review-workflow set, which includes CREATE.
 *
 * Nothing here refuses. Every rule rewrites a member or removes an entry and
 * records one host limitation per class of rewrite, so the operator sees what
 * the model actually said.
 */
import { limit } from "../config/limits.js";
import { VERIFICATION_COVERAGE_ENTRY_KEYS } from "../execution/response-contract-keys.js";
import { normalizeRepositoryLocator } from "./repository-locator.js";

export const HOST_COVERAGE_DEGRADATION_STEM = "Host coverage degradation:";

const COVERAGE_ENTRY_KEYS = new Set<string>(VERIFICATION_COVERAGE_ENTRY_KEYS);

export interface JudgmentCoverageEntry {
  path: string;
  status: "verified" | "unverified";
  evidence: string[];
  reason: string;
}

export interface DegradedJudgmentCoverage {
  /** One entry per authoritative target path, in target order. */
  readonly coverage: JudgmentCoverageEntry[];
  /** At most one per class of rewrite. */
  readonly limitations: readonly string[];
  /** Approved target paths no entry of the reply covered, in target order. */
  readonly filledPaths: readonly string[];
}

export const HOST_FILLED_COVERAGE_REASON =
  "Host-authored: the judgment reply returned no coverage entry for this approved target page, so the host recorded it unverified rather than refusing the whole answer.";

export const HOST_AUTHORED_COVERAGE_REASON =
  "Host-authored: the judgment reply gave no usable reason for this approved target page, so the host recorded it unverified.";

export const HOST_ZERO_SOURCE_COVERAGE_REASON =
  "Host-authored: the sealed source-obligation ledger admitted no source, so no claim this page makes can be compared with an admitted source and the host recorded the page unverified without asking the model to verify nothing.";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The target path one coverage entry names, or `undefined` when it names none:
 * verbatim, with a leading `./` (stripped once, at the front only, since the
 * coverage validator refuses a `.` segment), or as a locator the repository
 * grammar normalizes onto a target, such as `docs/page.md:1-40`.
 *
 * The verbatim comparison comes first because approved targets are not drawn
 * from the locator grammar: `docs/getting started.md` is approvable but the
 * grammar cannot read it, so normalizing first would drop an exact match.
 */
function coverageTargetPath(value: unknown, targets: ReadonlySet<string>): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (targets.has(trimmed)) return trimmed;
  const dotless = trimmed.startsWith("./") ? trimmed.slice(2) : trimmed;
  if (targets.has(dotless)) return dotless;
  const path = readableRepositoryPage(value);
  return path !== undefined && targets.has(path) ? path : undefined;
}

/**
 * `value` cut to at most `maxChars` UTF-16 code units (the unit every
 * `*MaxChars` catalog entry counts) without splitting a surrogate pair. A
 * plain `slice` could leave a lone surrogate that no decoder on the judgment
 * path screens for.
 */
function boundedChars(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  let bounded = "";
  for (const codePoint of value) {
    if (bounded.length + codePoint.length > maxChars) break;
    bounded += codePoint;
  }
  return bounded;
}

/**
 * The repository-relative page one removed entry named, when the locator
 * grammar can read it. Anything else is counted in the limitation instead of
 * quoted into it.
 */
function readableRepositoryPage(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const candidate = value.startsWith("./") ? value.slice(2) : value;
  const normalized = normalizeRepositoryLocator(candidate);
  if (normalized.malformed || !normalized.path) return undefined;
  return normalized.path;
}

/**
 * The evidence list one coverage entry keeps: distinct, non-empty, trimmed
 * strings, each truncated to `technicalCorrection.coverageEvidenceEntryMaxChars`
 * and the list truncated to `technicalCorrection.coverageEvidenceMaxEntries`.
 * `changed` is true when anything was rewritten or removed.
 */
function degradeEvidence(value: unknown): { evidence: string[]; changed: boolean } {
  const maxEntries = limit("technicalCorrection.coverageEvidenceMaxEntries").value;
  const maxChars = limit("technicalCorrection.coverageEvidenceEntryMaxChars").value;
  const source = Array.isArray(value) ? value : [];
  let changed = !Array.isArray(value);
  const evidence: string[] = [];
  for (const item of source) {
    if (typeof item !== "string" || !item.trim()) {
      changed = true;
      continue;
    }
    const trimmed = item.trim();
    const bounded = boundedChars(trimmed, maxChars);
    if (bounded !== item) changed = true;
    if (evidence.includes(bounded)) {
      changed = true;
      continue;
    }
    if (evidence.length >= maxEntries) {
      changed = true;
      continue;
    }
    evidence.push(bounded);
  }
  return { evidence, changed };
}

/**
 * The reason one coverage entry keeps: the model's own trimmed prose when it
 * has any, truncated to `technicalCorrection.coverageReasonMaxChars`, else the
 * host's own sentence.
 */
function degradeReason(value: unknown): { reason: string; changed: boolean } {
  const maxChars = limit("technicalCorrection.coverageReasonMaxChars").value;
  if (typeof value !== "string" || !value.trim()) {
    return { reason: HOST_AUTHORED_COVERAGE_REASON, changed: true };
  }
  const trimmed = value.trim();
  if (trimmed.length > maxChars) return { reason: boundedChars(trimmed, maxChars), changed: true };
  return { reason: trimmed, changed: trimmed !== value };
}

/**
 * One host limitation, with as many quoted items as fit inside
 * `technicalCorrection.fieldMaxChars` and a count of the rest, in the same
 * shape as the dimension-degradation note.
 */
function coverageLimitation(sentence: string, quoted: readonly string[]): string {
  const budget = limit("technicalCorrection.fieldMaxChars").value;
  const head = `${HOST_COVERAGE_DEGRADATION_STEM} ${sentence}`;
  let listed = "";
  let count = 0;
  for (const item of quoted) {
    const next = count === 0 ? item : `${listed}, ${item}`;
    if (head.length + next.length + " Pages: .".length > budget) break;
    listed = next;
    count += 1;
  }
  const withheld = quoted.length - count;
  return [
    head,
    count === 0 ? "" : ` Pages: ${listed}.`,
    withheld === 0 ? "" : ` ${withheld} further page(s) are not listed.`,
  ]
    .join("")
    .trim();
}

/**
 * The coverage a zero-source run records: one unverified entry per target,
 * host-authored, with no evidence, plus the one limitation that says so.
 */
export function hostZeroSourceCoverage(targetPaths: readonly string[]): DegradedJudgmentCoverage {
  const targets = [...new Set(targetPaths)];
  return {
    coverage: targets.map((path) => ({
      path,
      status: "unverified" as const,
      evidence: [],
      reason: HOST_ZERO_SOURCE_COVERAGE_REASON,
    })),
    limitations: [
      coverageLimitation(
        `the sealed source-obligation ledger admitted no source, so the host recorded every approved target page unverified and spent no model turn on this step.`,
        targets,
      ),
    ],
    filledPaths: targets,
  };
}

/**
 * Apply the coverage rule table to one judgment reply's `coverage` member.
 * The result carries exactly one entry per distinct authoritative target path,
 * in target order, so the coverage validator's target-set check cannot fail on
 * a `review-documentation` judgment.
 */
export function degradeJudgmentCoverage(
  value: unknown,
  targetPaths: readonly string[],
): DegradedJudgmentCoverage {
  const targets = [...new Set(targetPaths)];
  const targetSet = new Set(targets);
  const entries = Array.isArray(value) ? value : [];
  const kept = new Map<string, JudgmentCoverageEntry>();
  const removedPages: string[] = [];
  let removedUnreadable = 0;
  let rewritten = 0;
  for (const raw of entries) {
    const entry = isPlainObject(raw) ? raw : {};
    const path = coverageTargetPath(entry.path, targetSet);
    if (path === undefined) {
      // No approved target page. A readable repository-relative page is quoted
      // in the limitation; anything else is counted, so an unparseable model
      // string is not copied into the record.
      const readable = readableRepositoryPage(entry.path);
      if (readable === undefined) removedUnreadable += 1;
      else removedPages.push(readable);
      continue;
    }
    if (kept.has(path)) {
      // A duplicate entry; the first occurrence stands.
      removedPages.push(path);
      continue;
    }
    const { evidence, changed: evidenceChanged } = degradeEvidence(entry.evidence);
    const { reason, changed: reasonChanged } = degradeReason(entry.reason);
    // An off-vocabulary status, or `verified` with no evidence left after
    // degradation, is recorded as the conservative status that the verdict
    // rule forces to human review.
    const statusChanged =
      (entry.status !== "verified" && entry.status !== "unverified") ||
      (entry.status === "verified" && evidence.length === 0);
    const status: "verified" | "unverified" = statusChanged
      ? "unverified"
      : (entry.status as "verified" | "unverified");
    // Unknown keys are dropped by rebuilding the entry from the admitted
    // members; the degraders above host-fill and report a missing member.
    const unknownKeys = Object.keys(entry).some((key) => !COVERAGE_ENTRY_KEYS.has(key));
    const pathChanged = entry.path !== path;
    if (
      evidenceChanged ||
      reasonChanged ||
      statusChanged ||
      unknownKeys ||
      pathChanged ||
      !isPlainObject(raw)
    ) {
      rewritten += 1;
    }
    kept.set(path, { path, status, evidence, reason });
  }
  const filled: string[] = [];
  for (const path of targets) {
    if (kept.has(path)) continue;
    // An approved target page the reply never covered.
    filled.push(path);
    kept.set(path, {
      path,
      status: "unverified",
      evidence: [],
      reason: HOST_FILLED_COVERAGE_REASON,
    });
  }
  const limitations: string[] = [];
  if (removedPages.length > 0 || removedUnreadable > 0) {
    limitations.push(
      coverageLimitation(
        `${removedPages.length + removedUnreadable} coverage entr${removedPages.length + removedUnreadable === 1 ? "y" : "ies"} named a page outside the approved target set, repeated a page already covered, or named no readable page, and were removed.`,
        removedPages,
      ),
    );
  }
  if (filled.length > 0) {
    limitations.push(
      coverageLimitation(
        `${filled.length} approved target page(s) were not covered by the judgment reply and the host recorded them unverified.`,
        filled,
      ),
    );
  }
  if (rewritten > 0) {
    limitations.push(
      coverageLimitation(
        `${rewritten} coverage entr${rewritten === 1 ? "y" : "ies"} carried a path, status, reason, evidence list, or key set the contract does not admit, and the host rewrote the offending member rather than refusing the answer. A path is rewritten when the entry named an approved target page in another form, such as a locator with line numbers or a leading "./".`,
        [],
      ),
    );
  }
  return {
    coverage: targets.map((path) => kept.get(path)!),
    limitations,
    filledPaths: filled,
  };
}
