// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Locator degradation owns the host-written reason identity for decode and seal. */
import { limit } from "../../config/limits.js";
import type { HarnessStepInput } from "../../execution/contracts.js";
import { admitPlanSourceLocator, isPlanSourceLocatorRefusal } from "../repository-locator.js";
import { normalizeRepositoryLocator, type TechnicalFactDimension } from "../review-response.js";
import type {
  SourceObligationDimensionV1,
  SourceObligationLedgerProposalV1,
  SourceObligationV1,
} from "./types.js";

/**
 * The one condition under which a judgment step degrades model content instead
 * of refusing it: `review-documentation`, under the current rule that only
 * credentials and write or publish authority refuse. Every other workflow
 * keeps the refusal, including `create-documentation`, so membership of
 * `REVIEW_WORKFLOWS` is not this gate.
 */
export function degradesJudgmentModelContent(input: Pick<HarnessStepInput, "workflow">): boolean {
  return input.workflow.name === "review-documentation";
}

/**
 * One decode-time locator degradation. At decode, model content
 * degrades rather than refusing: a locator the host cannot admit is removed,
 * and every removal is collected so the dimension that lost it names the gap
 * in `limitations`. A locator that names a path but no lines is the one
 * exception: while retries remain it is refused with
 * `source-locator-span-missing`, because the model read the file and can cite
 * its lines; only the final attempt removes it.
 *
 * Present only on the decode path. A sealed ledger is re-validated with no
 * collector, so a consumer step still refuses a locator the host never
 * admitted.
 */
export interface LocatorDegradation {
  /**
   * The revision this run is bound to. A `@<revision>` suffix naming exactly
   * this revision is identity the host binds separately, so it is stripped;
   * any other revision is content the host cannot bind, and the locator goes.
   */
  readonly runRevision: string | undefined;
  /** One screened token and its reason per removed locator, in the order they were read. */
  readonly removed: RemovedLocator[];
  /** No retry follows this attempt, so a span-less locator is removed, not refused. */
  readonly finalAttempt: boolean;
}

/** Why the host removed a cited locator; each reads as its own clause in the limitation. */
type RemovedLocatorReason = "span-missing" | "foreign-revision" | "not-a-locator";

export interface RemovedLocator {
  readonly token: string;
  readonly reason: RemovedLocatorReason;
}

/**
 * What the host makes of one cited locator at decode: the locator it will
 * read, a whole-file citation with no line span, or a removal reason. Only the
 * `invalid-locator` cases are decided here (a revision suffix, or a locator
 * that is not physically specific); authority, digest, and staleness stay
 * refusals decided by their callers.
 */
type CitedLocatorReading =
  | { readonly kind: "admitted"; readonly locator: string }
  | { readonly kind: "span-missing"; readonly path: string }
  | { readonly kind: "removed"; readonly reason: Exclude<RemovedLocatorReason, "span-missing"> };

export function readCitedLocator(
  locator: string,
  runRevision: string | undefined,
): CitedLocatorReading {
  if (locator.includes("@")) {
    // One grammar, the plan-admission one, never a second one here.
    const parsed = admitPlanSourceLocator(locator);
    if (isPlanSourceLocatorRefusal(parsed)) return { kind: "removed", reason: "not-a-locator" };
    if (runRevision === undefined || parsed.revision !== runRevision) {
      return { kind: "removed", reason: "foreign-revision" };
    }
    const admitted = admitPlanSourceLocator(locator, runRevision);
    if (isPlanSourceLocatorRefusal(admitted))
      return { kind: "removed", reason: "foreign-revision" };
    return readCitedLocator(admitted.locator, runRevision);
  }
  const normalized = normalizeRepositoryLocator(locator);
  if (!normalized.path) return { kind: "removed", reason: "not-a-locator" };
  return normalized.specific
    ? { kind: "admitted", locator }
    : { kind: "span-missing", path: normalized.path };
}

/**
 * What a removed locator is recorded as. Model text is kept here only inside
 * the sealed ledger (already screened for credentials) and
 * only when it parses as a repository locator; anything else becomes a closed
 * class word and a length. A revision hex is never echoed.
 */
export function degradedLocatorToken(locator: string, runRevision: string | undefined): string {
  const admitted = admitPlanSourceLocator(locator);
  if (isPlanSourceLocatorRefusal(admitted)) {
    return `<unreadable-locator:${locator.length}>`;
  }
  if (admitted.revision !== undefined && admitted.revision !== runRevision) {
    return `${admitted.locator}@<foreign-revision>`;
  }
  return admitted.locator;
}

export const HOST_DEGRADATION_STEM = "Host degradation:";

export type HostWrittenReasons = Map<string, Set<string>>;
const hostWrittenProposalReasons = new WeakMap<object, HostWrittenReasons>();

export function hostWrittenReasonsFor(value: unknown): HostWrittenReasons {
  const saved =
    value !== null && typeof value === "object" ? hostWrittenProposalReasons.get(value) : undefined;
  const copied: HostWrittenReasons = new Map();
  for (const [name, reasons] of saved ?? []) copied.set(name, new Set(reasons));
  return copied;
}

export function markHostWrittenReason(
  reasons: HostWrittenReasons,
  dimension: string,
  reason: string,
): void {
  const known = reasons.get(dimension) ?? new Set<string>();
  known.add(reason);
  reasons.set(dimension, known);
}

export function hasHostWrittenReason(
  reasons: HostWrittenReasons,
  dimension: string,
  reason: string,
): boolean {
  return reasons.get(dimension)?.has(reason) === true;
}

export function rememberHostWrittenReasons(proposal: object, reasons: HostWrittenReasons): void {
  if (reasons.size > 0) hostWrittenProposalReasons.set(proposal, reasons);
}

/** A model omission is recorded from the status and counts the host can inspect. */
export function hostFilledDimensionReason(
  dimension: TechnicalFactDimension,
  status: SourceObligationDimensionV1["status"],
  obligations: number,
  sourceLocators: number,
): string {
  return `${HOST_DEGRADATION_STEM} the model marked ${dimension} ${status} with ${obligations} obligation(s) and ${sourceLocators} dimension source locator(s), but supplied no reason; the host records only those observed facts.`;
}

/** The clause each removal reason contributes, in a fixed order. */
const REMOVED_LOCATOR_CLAUSES: readonly [RemovedLocatorReason, string][] = [
  ["span-missing", "named a path but no line span"],
  ["foreign-revision", "named a repository revision this run is not bound to"],
  ["not-a-locator", "were not repository locators"],
];

/**
 * The one limitation a degraded dimension contributes. `demoted` picks the
 * sentence, so a dimension that kept its status never claims a demotion, and
 * each removal reason is named, so the note never says the host could not
 * read a file it never tried to read. The quoted list is bounded by
 * `factInventory.maxDegradedLocatorChars`, and the sentence by the ledger's
 * `reason` and `limitations` text bounds.
 */
export function hostDegradationLimitation(
  dimension: TechnicalFactDimension,
  removed: readonly RemovedLocator[],
  demoted: boolean,
): string {
  const budget = limit("factInventory.maxDegradedLocatorChars").value;
  const listedTokens: string[] = [];
  for (const { token } of removed) {
    const next = JSON.stringify([...listedTokens, token]);
    if (next.length > budget) break;
    listedTokens.push(token);
  }
  const withheld = removed.length - listedTokens.length;
  const reasons = REMOVED_LOCATOR_CLAUSES.flatMap(([reason, clause]) => {
    const count = removed.filter((entry) => entry.reason === reason).length;
    return count === 0 ? [] : [`${count} ${clause}`];
  }).join("; ");
  return [
    `${HOST_DEGRADATION_STEM} the ${dimension} dimension cited ${removed.length} source locator(s) the host could not admit (${reasons}),`,
    demoted
      ? " so it is recorded unverified."
      : " so they were removed and the rest of the dimension stands.",
    listedTokens.length === 0 ? "" : ` Removed: ${JSON.stringify(listedTokens)}.`,
    withheld === 0 ? "" : ` ${withheld} further removed locator(s) are not listed.`,
  ].join("");
}

function positiveCanonicalCount(text: string): number | undefined {
  if (!/^[1-9][0-9]*$/u.test(text)) return undefined;
  const count = Number(text);
  return Number.isSafeInteger(count) ? count : undefined;
}

/** Recognize only the decoder's fixed removal clauses and complete note shape. */
function isDecoderHostLocatorNote(dimension: TechnicalFactDimension, note: string): boolean {
  const prefix = `${HOST_DEGRADATION_STEM} the ${dimension} dimension cited `;
  if (!note.startsWith(prefix)) return false;
  const match =
    /^([1-9][0-9]*) source locator\(s\) the host could not admit \(([^()]*)\),( so it is recorded unverified\.| so they were removed and the rest of the dimension stands\.)(.*)$/u.exec(
      note.slice(prefix.length),
    );
  if (!match) return false;
  const total = positiveCanonicalCount(match[1]!);
  if (total === undefined) return false;
  const parts = match[2]!.split("; ");
  let lastClause = -1;
  let described = 0;
  for (const part of parts) {
    const index = REMOVED_LOCATOR_CLAUSES.findIndex(([, clause]) => part.endsWith(` ${clause}`));
    if (index <= lastClause) return false;
    const clause = REMOVED_LOCATOR_CLAUSES[index]![1];
    const count = positiveCanonicalCount(part.slice(0, -` ${clause}`.length));
    if (count === undefined) return false;
    lastClause = index;
    described += count;
  }
  if (described !== total) return false;
  const suffix =
    /^(?: Removed: (.+?)\.)?(?: ([1-9][0-9]*) further removed locator\(s\) are not listed\.)?$/u.exec(
      match[4]!,
    );
  if (!suffix) return false;
  const listed = listedRemovedLocators(suffix[1]);
  const withheld = suffix[2] === undefined ? 0 : positiveCanonicalCount(suffix[2]);
  return listed !== undefined && withheld !== undefined && listed + withheld === total;
}

/** Read the new unambiguous list, or a previously accepted comma-joined note. */
function listedRemovedLocators(text: string | undefined): number | undefined {
  if (text === undefined) return 0;
  if (!text.startsWith("[")) return text.split(", ").length;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    parsed.some((token) => typeof token !== "string" || token.length === 0) ||
    JSON.stringify(parsed) !== text ||
    text.length > limit("factInventory.maxDegradedLocatorChars").value
  ) {
    return undefined;
  }
  return parsed.length;
}

/** The seal writer and sealed readback use the same sentence constructor. */
function sealTimeHostLocatorNote(
  dimension: TechnicalFactDimension,
  removed: number,
  demoted: boolean,
  previous?: string,
): string {
  const prefix = `${HOST_DEGRADATION_STEM} the ${dimension} dimension `;
  const cited = `cited ${removed} source locator(s) the host cannot read as a tracked repository file, so`;
  return previous
    ? `${previous} It also ${cited} ${demoted ? "it is recorded unverified" : "they were removed"}.`
    : `${prefix}${cited} ${demoted ? "it is recorded unverified" : "they were removed and the rest of the dimension stands"}.`;
}

function isSealTimeHostLocatorNote(dimension: TechnicalFactDimension, note: string): boolean {
  const prefix = `${HOST_DEGRADATION_STEM} the ${dimension} dimension `;
  if (!note.startsWith(prefix)) return false;
  const additionAt = note.lastIndexOf(" It also cited ");
  const previous = additionAt < 0 ? undefined : note.slice(0, additionAt);
  if (previous !== undefined && !isDecoderHostLocatorNote(dimension, previous)) return false;
  const remainder = previous === undefined ? note.slice(prefix.length) : note.slice(additionAt + 9);
  const match =
    /^cited ([1-9][0-9]*) source locator\(s\) the host cannot read as a tracked repository file, so (it is recorded unverified|they were removed(?: and the rest of the dimension stands)?)\.$/u.exec(
      remainder,
    );
  if (!match) return false;
  const removed = positiveCanonicalCount(match[1]!);
  if (removed === undefined) return false;
  for (const demoted of [true, false]) {
    if (note === sealTimeHostLocatorNote(dimension, removed, demoted, previous)) return true;
  }
  return false;
}

export function isHostLocatorDegradationNote(
  dimension: TechnicalFactDimension,
  note: string,
): boolean {
  return isDecoderHostLocatorNote(dimension, note) || isSealTimeHostLocatorNote(dimension, note);
}

/**
 * The seal-time half of {@link LocatorDegradation}: the observer reads cited
 * paths only when the runner seals the ledger, after the retry loop, so the
 * decoder cannot drop a path the observer would refuse. A locator whose path
 * fails `observable` goes, an obligation left with no locator goes, and a
 * dimension left with none is recorded unverified, as at decode.
 *
 * Only a `review-documentation` proposal degrades
 * ({@link degradesJudgmentModelContent}); any other comes back unchanged, so
 * its observer still refuses the path. A dimension keeps one host note: the
 * note the decoder wrote for it, or a new one, gains a sentence that counts
 * the removals and quotes none of them.
 */
export function withoutUnobservableSourceLocators(
  proposal: SourceObligationLedgerProposalV1,
  input: Pick<HarnessStepInput, "workflow">,
  observable: (path: string) => boolean,
): SourceObligationLedgerProposalV1 {
  if (!degradesJudgmentModelContent(input)) return proposal;
  const hostWritten = hostWrittenReasonsFor(proposal);
  const readable = (locator: string): boolean => {
    const { path } = normalizeRepositoryLocator(locator);
    return path !== null && observable(path);
  };
  let limitations = [...proposal.limitations];
  const dimensions = proposal.dimensions.map((dimension): SourceObligationDimensionV1 => {
    const sourceLocators = dimension.sourceLocators.filter(readable);
    let removed = dimension.sourceLocators.length - sourceLocators.length;
    const obligations = dimension.obligations.flatMap((obligation) => {
      const kept = obligation.sourceLocators.filter(readable);
      removed += obligation.sourceLocators.length - kept.length;
      return kept.length === 0 ? [] : [{ ...obligation, sourceLocators: kept }];
    });
    if (removed === 0) return dimension;
    const demoted =
      (dimension.status === "applicable" && obligations.length === 0) ||
      (dimension.status === "not-applicable" && sourceLocators.length === 0);
    const prefix = `${HOST_DEGRADATION_STEM} the ${dimension.dimension} dimension `;
    const previous = limitations.find(
      (entry) =>
        entry.startsWith(prefix) && hasHostWrittenReason(hostWritten, dimension.dimension, entry),
    );
    const note = sealTimeHostLocatorNote(dimension.dimension, removed, demoted, previous);
    markHostWrittenReason(hostWritten, dimension.dimension, note);
    limitations = [...limitations.filter((entry) => entry !== previous), note].sort();
    if (demoted) {
      return {
        dimension: dimension.dimension,
        status: "unverified",
        reason: note,
        sourceLocators: [],
        obligations: [],
      };
    }
    return {
      ...dimension,
      // An unverified reason must stay one of the limitations it names.
      reason: dimension.reason === previous ? note : dimension.reason,
      sourceLocators,
      obligations,
    };
  });
  const sealedProposal = { completeness: proposal.completeness, dimensions, limitations };
  rememberHostWrittenReasons(sealedProposal, hostWritten);
  return sealedProposal;
}
