// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * On `answerNowAppliesTo` judgment steps, a review judgment answer cut at the
 * output limit is degraded model content, not a failed step: the host keeps
 * every complete element it can recover, fills the rest as unverified, forces
 * `human-review`, and names the cut in one host limitation.
 *
 * The cut text is never decoded as if whole. The host builds a complete reply
 * that the step's ordinary judgment decoder admits; there is no second
 * admission path.
 */
import { InferenceStepError, type HarnessStepInput } from "../execution/contracts.js";
import { isJsonEvidence, parseJsonEvidence, type JsonEvidenceValue } from "../json-evidence.js";
import { degradeJudgmentCoverage } from "../workflow-execution/judgment-coverage.js";
import {
  hostRejectedObligationJudgment,
  type HostFillReason,
} from "../workflow-execution/host-judgment-rejection.js";
import type { JudgmentCoveragePolicy } from "../workflow-execution/source-obligation.js";
import { authoritativeReviewTargetPaths } from "../workflow-execution/verification-result.js";
import { answerNowAppliesTo } from "./answer-now.js";

export {
  HOST_UNJUDGED_OBLIGATION_REASON,
  HOST_REFUSED_REPLY_OBLIGATION_REASON,
} from "../workflow-execution/host-judgment-rejection.js";

export type DeclinedJudgmentCutShape = "text-truncated" | "output-truncated";

/**
 * The final evaluator step: the same fail-open treatment as the two
 * `answerNowAppliesTo` judgment steps, over a completely different reply
 * shape (`evaluation`/`qualityScore`/`reportMarkdown`, not a source-obligation
 * ledger), so it is recognized on its own rather than folded into
 * `answerNowAppliesTo` itself -- that gate also drives the early-answer flip
 * and the all-host-filled floor, both ledger-shaped and wrong for this step.
 */
export const QUALITY_REPORT_CUT_STEP_ID = "evaluate-document-quality";

/** Whether a cut answer on this step is `evaluate-document-quality`'s, not a ledger judgment's. */
export function qualityReportCutApplies(input: Pick<HarnessStepInput, "step">): boolean {
  return input.step.id === QUALITY_REPORT_CUT_STEP_ID;
}

/** What the host retained of a judgment answer it declined to continue. */
export interface CutJudgmentAnswer {
  readonly shape: DeclinedJudgmentCutShape;
  /** The retained prefix plus the final cut turn's text blocks. */
  readonly stitched: string;
  /** The final cut turn's own text blocks, which may restart the answer. */
  readonly finalCut: string;
  readonly continuationTurns: number;
  /** Per-turn output budget the final cut turn was authorized with. */
  readonly outputTokenLimit: number;
  /** Output billed on the answer turns, or `undefined` when a turn reported none. */
  readonly answerOutputTokens: number | undefined;
}

/**
 * The cut shape the host completes instead of declining, or `undefined`.
 *
 * Only on `answerNowAppliesTo` steps, and only for `output-truncated`, which is
 * never continued, or `text-truncated` once the continuation budget is spent.
 */
export function declinedJudgmentCut(
  input: Pick<HarnessStepInput, "workflow" | "step" | "sourceObligationLedger">,
  rejectionCode: string | undefined,
  continuationsSpent: number,
  continuationBound: number | undefined,
): DeclinedJudgmentCutShape | undefined {
  if (!answerNowAppliesTo(input) && !qualityReportCutApplies(input)) return undefined;
  if (rejectionCode === "output-truncated") return rejectionCode;
  if (
    rejectionCode === "text-truncated" &&
    continuationBound !== undefined &&
    continuationsSpent >= continuationBound
  ) {
    return rejectionCode;
  }
  return undefined;
}

/** The complete elements recovered from a cut JSON object. */
export interface RecoveredJudgmentPrefix {
  /** The strict parse of the recovered text; `undefined` when no object began. */
  readonly value: Readonly<Record<string, JsonEvidenceValue>> | undefined;
  /** Where the recovered object begins in the bounded input. */
  readonly start: number;
  /** Where the kept prefix ends in the bounded input. */
  readonly end: number;
  /** Only closing brackets: what the host appended to the kept prefix. */
  readonly closers: string;
}

/** A position where every value before it is complete, and how to close there. */
interface PrefixCheckpoint {
  readonly end: number;
  readonly closers: string;
}

const JSON_WHITESPACE = new Set([" ", "\t", "\n", "\r"]);

/** A Markdown fence opener; a cut answer's closing fence never arrives. */
const FENCE_OPENER = /(?:`{3,}|~{3,})[^\n]*\n/uy;

/**
 * `text` cut to at most `maxBytes` UTF-8 bytes on a code point boundary. The
 * string is never re-encoded, so a lone surrogate counts the three bytes it
 * serializes to and stays as it was.
 */
function utf8BoundedPrefix(text: string, maxBytes: number | undefined): string {
  if (maxBytes === undefined || Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let bytes = 0;
  let index = 0;
  for (const codePoint of text) {
    const size = Buffer.byteLength(codePoint, "utf8");
    if (bytes + size > maxBytes) break;
    bytes += size;
    index += codePoint.length;
  }
  return text.slice(0, index);
}

/** The index of the `{` the object begins at, after whitespace and a fence opener. */
function objectStart(text: string): number | undefined {
  let index = 0;
  const skipWhitespace = (): void => {
    while (index < text.length && JSON_WHITESPACE.has(text[index]!)) index += 1;
  };
  skipWhitespace();
  FENCE_OPENER.lastIndex = index;
  const fence = FENCE_OPENER.exec(text);
  if (fence) {
    index += fence[0].length;
    skipWhitespace();
  }
  return text[index] === "{" ? index : undefined;
}

/**
 * Every checkpoint of the object that begins at `start`: after its opening
 * brace, after each complete top-level member, and after each complete element
 * of a top-level member array. The scan tracks only string, escape, and
 * container state, so it is linear and never judges content. It stops at a
 * mismatched closer or at the object's own closing brace.
 */
function prefixCheckpoints(text: string, start: number): PrefixCheckpoint[] {
  const checkpoints: PrefixCheckpoint[] = [];
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  const inMemberArray = (): boolean => stack.length === 2 && stack[1] === "[";
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') {
        inString = false;
        if (inMemberArray()) checkpoints.push({ end: index + 1, closers: "]}" });
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{" || char === "[") {
      stack.push(char);
      if (stack.length === 1) checkpoints.push({ end: index + 1, closers: "}" });
    } else if (char === "}" || char === "]") {
      if (stack.pop() !== (char === "}" ? "{" : "[")) break;
      if (stack.length === 0) {
        checkpoints.push({ end: index + 1, closers: "" });
        break;
      }
      if (stack.length === 1) checkpoints.push({ end: index + 1, closers: "}" });
      else if (inMemberArray()) checkpoints.push({ end: index + 1, closers: "]}" });
    } else if (char === ",") {
      if (stack.length === 1) checkpoints.push({ end: index, closers: "}" });
      else if (inMemberArray()) checkpoints.push({ end: index, closers: "]}" });
    }
  }
  return checkpoints;
}

/**
 * Recover the complete elements of a JSON object cut at an arbitrary point.
 *
 * The kept text is a prefix of the `maxBytes`-bounded input plus closing
 * brackets only, judged by the strict `json-evidence` parser. Validity can only
 * be lost as the prefix grows, so bisection finds the last checkpoint that
 * parses. Recovering nothing is valid: the host then fills the whole answer.
 */
export function recoverJudgmentPrefix(input: string, maxBytes?: number): RecoveredJudgmentPrefix {
  const text = utf8BoundedPrefix(input, maxBytes);
  const start = objectStart(text);
  if (start === undefined) return { value: undefined, start: 0, end: 0, closers: "" };
  const checkpoints = prefixCheckpoints(text, start);
  const candidate = (checkpoint: PrefixCheckpoint): string =>
    text.slice(start, checkpoint.end) + checkpoint.closers;
  let low = 0;
  let high = checkpoints.length - 1;
  let best: PrefixCheckpoint | undefined;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (isJsonEvidence(candidate(checkpoints[middle]!))) {
      best = checkpoints[middle];
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  if (!best) return { value: undefined, start, end: start, closers: "" };
  const value = parseJsonEvidence(candidate(best));
  return {
    value: isRecord(value) ? value : undefined,
    start,
    end: best.end,
    closers: best.closers,
  };
}

function isRecord(value: unknown): value is Record<string, JsonEvidenceValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Prefix of every host judgment completion limitation, so one search finds them all. */
export const HOST_CUT_JUDGMENT_STEM = "Host judgment completion:";

/** The content-free counts one completion's limitation reports. */
export interface CutJudgmentCounts {
  readonly rowsKept: number;
  readonly rowsFilled: number;
  /** Complete rows that named no sealed obligation, or repeated one. */
  readonly rowsDiscarded: number;
  readonly coverageKept: number;
  readonly coverageFilled: number;
  readonly issueJudgmentsKept: number;
  readonly issueJudgmentsDropped: number;
  /** Links from kept issue judgments to obligations the host filled. */
  readonly linksPruned: number;
}

/** A complete judgment reply the host wrote, in whole or in part. */
export interface HostJudgmentCompletion {
  readonly reply: string;
  readonly coveragePolicy: JudgmentCoveragePolicy;
  readonly counts: CutJudgmentCounts;
}

export interface HostCompletedCutJudgment extends HostJudgmentCompletion {
  readonly cut: CutJudgmentAnswer;
}

/** Whether one complete row yields a fact that must be linked by an issue. */
function rowHasOpenFact(row: Readonly<Record<string, JsonEvidenceValue>>): boolean {
  if (row.disposition === "retained") return row.documentationDisposition !== "documented";
  if (row.disposition === "refined" && Array.isArray(row.replacements)) {
    return row.replacements.some(
      (replacement) =>
        isRecord(replacement) && replacement.documentationDisposition !== "documented",
    );
  }
  return false;
}

interface CompletionPlan {
  readonly rows: ReadonlyMap<string, Readonly<Record<string, JsonEvidenceValue>>>;
  readonly hostFilled: ReadonlySet<string>;
  readonly issueJudgments: readonly JsonEvidenceValue[];
  readonly coverage: JsonEvidenceValue;
  readonly rowsDiscarded: number;
  readonly issueJudgmentsDropped: number;
  readonly linksPruned: number;
}

/**
 * What the host keeps of one recovered object, and which obligations it fills.
 *
 * The host rewrites only what the cut leaves unsatisfiable:
 *
 * - an obligation with no complete row is filled, since the accounting needs
 *   one row per sealed obligation;
 * - a kept issue judgment loses its links to filled obligations, and is
 *   dropped when that leaves it linking no open fact;
 * - a kept row whose fact needs an issue no kept judgment links is filled,
 *   because the cut may have removed that issue.
 *
 * A release never changes which judgments are kept, so the loop ends on its
 * second pass. Other decoder rules apply to kept elements unchanged.
 */
function planCompletion(
  value: Readonly<Record<string, JsonEvidenceValue>> | undefined,
  obligationIds: readonly string[],
): CompletionPlan {
  const sealed = new Set(obligationIds);
  const rows = new Map<string, Readonly<Record<string, JsonEvidenceValue>>>();
  let rowsDiscarded = 0;
  for (const row of Array.isArray(value?.obligationJudgments) ? value.obligationJudgments : []) {
    const obligationId = isRecord(row) ? row.obligationId : undefined;
    if (!isRecord(row) || typeof obligationId !== "string" || !sealed.has(obligationId)) {
      rowsDiscarded += 1;
    } else if (rows.has(obligationId)) {
      rowsDiscarded += 1;
    } else {
      rows.set(obligationId, row);
    }
  }
  const hostFilled = new Set(obligationIds.filter((id) => !rows.has(id)));
  const recoveredJudgments = Array.isArray(value?.issueJudgments) ? value.issueJudgments : [];
  let kept: JsonEvidenceValue[] = [...recoveredJudgments];
  let changed = true;
  while (changed) {
    changed = false;
    const opens = (id: unknown): boolean =>
      typeof id === "string" &&
      !hostFilled.has(id) &&
      rows.has(id) &&
      rowHasOpenFact(rows.get(id)!);
    kept = kept.filter((judgment) => {
      if (!isRecord(judgment) || !Array.isArray(judgment.obligationIds)) return true;
      const links = judgment.obligationIds;
      if (!links.some((id) => typeof id === "string" && hostFilled.has(id))) return true;
      const remaining = links.filter((id) => !(typeof id === "string" && hostFilled.has(id)));
      if (remaining.some(opens)) return true;
      changed = true;
      return false;
    });
    const linked = new Set(
      kept.flatMap((judgment) =>
        isRecord(judgment) && Array.isArray(judgment.obligationIds) ? judgment.obligationIds : [],
      ),
    );
    for (const [obligationId, row] of rows) {
      if (hostFilled.has(obligationId) || !rowHasOpenFact(row) || linked.has(obligationId))
        continue;
      hostFilled.add(obligationId);
      changed = true;
    }
  }
  let linksPruned = 0;
  const issueJudgments = kept.map((judgment) => {
    if (!isRecord(judgment) || !Array.isArray(judgment.obligationIds)) return judgment;
    const remaining = judgment.obligationIds.filter(
      (id) => !(typeof id === "string" && hostFilled.has(id)),
    );
    linksPruned += judgment.obligationIds.length - remaining.length;
    return remaining.length === judgment.obligationIds.length
      ? judgment
      : { ...judgment, obligationIds: remaining };
  });
  return {
    rows: new Map([...rows].filter(([id]) => !hostFilled.has(id))),
    hostFilled,
    issueJudgments,
    coverage: Array.isArray(value?.coverage) ? value.coverage : [],
    rowsDiscarded,
    issueJudgmentsDropped: recoveredJudgments.length - kept.length,
    linksPruned,
  };
}

function plural(count: number, one: string, many: string): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;
}

/** The one content-free host limitation a completed cut answer carries. */
export function cutJudgmentLimitation(
  stepId: string,
  cut: Pick<
    CutJudgmentAnswer,
    "shape" | "continuationTurns" | "outputTokenLimit" | "answerOutputTokens"
  > & { readonly retainedChars: number },
  counts: CutJudgmentCounts,
): string {
  const billed =
    cut.answerOutputTokens === undefined
      ? "an unreported number of output tokens"
      : plural(cut.answerOutputTokens, "output token", "output tokens");
  return [
    `${HOST_CUT_JUDGMENT_STEM} the ${stepId} judgment answer was cut at the ${cut.outputTokenLimit.toLocaleString("en-US")}-token output limit (${cut.shape}) after ${plural(cut.continuationTurns, "continuation turn", "continuation turns")};`,
    `the answer turns billed ${billed} and the host retained ${plural(cut.retainedChars, "character", "characters")}.`,
    ...keptAndFilled(counts),
  ].join(" ");
}

/** What one host completion kept and filled, and its verdict, as note sentences. */
function keptAndFilled(counts: CutJudgmentCounts): string[] {
  const pruned =
    counts.linksPruned > 0
      ? ` after pruning ${plural(counts.linksPruned, "link", "links")} to host-filled obligations`
      : "";
  const discarded =
    counts.rowsDiscarded > 0
      ? ` ${plural(counts.rowsDiscarded, "complete row", "complete rows")} that named no sealed obligation or repeated one ${counts.rowsDiscarded === 1 ? "was" : "were"} discarded.`
      : "";
  return [
    `The host kept ${plural(counts.rowsKept, "complete obligation judgment", "complete obligation judgments")} and recorded ${counts.rowsFilled.toLocaleString("en-US")} unverified,`,
    `kept ${plural(counts.coverageKept, "coverage entry", "coverage entries")} and host-filled ${counts.coverageFilled.toLocaleString("en-US")},`,
    `and kept ${plural(counts.issueJudgmentsKept, "issue judgment", "issue judgments")}${pruned} and dropped ${counts.issueJudgmentsDropped.toLocaleString("en-US")};`,
    `the verdict is human-review.${discarded}`,
  ];
}

/** The one content-free host limitation a refused reply's floor carries. */
export function refusedJudgmentLimitation(
  stepId: string,
  attemptsSpent: number,
  rejectionCode: string,
  counts: CutJudgmentCounts,
  reason: "no-retry-left" | "continued-refusal" = "no-retry-left",
): string {
  const refusal =
    reason === "continued-refusal"
      ? `after a continuation (${plural(attemptsSpent, "attempt", "attempts")} spent, rejection code ${rejectionCode}), so the host kept none of that reply and did not retry the whole step.`
      : `with no retry left (${plural(attemptsSpent, "attempt", "attempts")} spent, rejection code ${rejectionCode}), so the host kept none of that reply.`;
  return [
    `${HOST_CUT_JUDGMENT_STEM} the step's own checks refused the ${stepId} judgment reply ${refusal}`,
    ...keptAndFilled(counts),
  ].join(" ");
}

/**
 * Complete a cut judgment answer into the reply the step's own decoder admits.
 *
 * Both the stitched text and the final cut are read, because a blank
 * continuation's replay asks for the complete answer and can restart it. The one
 * that keeps more obligation rows wins; the stitched text wins a tie.
 */
export function hostCompleteCutJudgment(
  input: HarnessStepInput,
  cut: CutJudgmentAnswer,
  maxResponseBytes: number | undefined,
): HostCompletedCutJudgment {
  const obligationIds = ledgerObligationIds(input);
  const candidates = cut.finalCut === cut.stitched ? [cut.stitched] : [cut.stitched, cut.finalCut];
  const plans = candidates.map((text) =>
    planCompletion(recoverJudgmentPrefix(text, maxResponseBytes).value, obligationIds),
  );
  const plan = plans.reduce((best, next) => (next.rows.size > best.rows.size ? next : best));
  return { ...completeFromPlan(input, obligationIds, plan, cutNote(input, cut, "")), cut };
}

/** The note of a completion of `cut`; `refusal` ends it. */
function cutNote(
  input: HarnessStepInput,
  cut: CutJudgmentAnswer,
  refusal: string,
): (counts: CutJudgmentCounts) => string {
  return (counts) =>
    cutJudgmentLimitation(input.step.id, { ...cut, retainedChars: cut.stitched.length }, counts) +
    refusal;
}

/**
 * A complete `evaluation` and `qualityScore` recovered from a cut
 * `evaluate-document-quality` reply, or `undefined` when `evaluation` itself
 * did not finish before the cut.
 *
 * Unlike the two ledger-based judgment steps, this step has no sealed
 * obligation list to host-fill against: its `evaluation` object is the
 * model's own layered judgment, checked by a locked schema and a technical-
 * fact-trace cross-check neither of which this host can safely reconstruct.
 * So only the two structured members are ever kept -- verbatim, never
 * fabricated -- and only when both are already complete. A cut that lands
 * inside `evaluation` itself has nothing safe to complete and is not
 * handled here: the step fails exactly as it did before this function
 * existed, which is the one adjacent condition this must not absorb.
 */
export function recoverableQualityReportCut(
  cut: Pick<CutJudgmentAnswer, "stitched" | "finalCut">,
  maxResponseBytes: number | undefined,
):
  | Readonly<{
      readonly evaluation: JsonEvidenceValue;
      readonly qualityScore: JsonEvidenceValue | null;
      /**
       * Whether `qualityScore` is `null` because the cut landed before that
       * member arrived at all (absent from the recovered prefix), rather than
       * the model's own complete `null` judgment (no single content-type rubric
       * applied). The two are never conflated: only the second is the model's
       * verbatim answer.
       */
      readonly qualityScoreCut: boolean;
    }>
  | undefined {
  const candidates = cut.finalCut === cut.stitched ? [cut.stitched] : [cut.stitched, cut.finalCut];
  for (const text of candidates) {
    const recovered = recoverJudgmentPrefix(text, maxResponseBytes).value;
    const evaluation = recovered?.evaluation;
    const qualityScore = recovered?.qualityScore;
    if (
      isRecord(evaluation) &&
      (qualityScore === undefined || qualityScore === null || isRecord(qualityScore))
    ) {
      return {
        evaluation,
        qualityScore: qualityScore ?? null,
        qualityScoreCut: qualityScore === undefined,
      };
    }
  }
  return undefined;
}

/** Prefix of the one host limitation a completed quality-report cut carries. */
export const QUALITY_REPORT_CUT_STEM = "Host report completion:";

export interface HostCompletedCutQualityReport {
  readonly reply: string;
  readonly limitation: string;
  readonly cut: CutJudgmentAnswer;
}

/**
 * Complete a cut `evaluate-document-quality` answer into the reply the
 * step's own `decodeQualityArtifactResponse` admits, or `undefined` when
 * {@link recoverableQualityReportCut} found nothing safe to keep.
 *
 * `evaluation` is always the model's own complete judgment, carried through
 * unchanged so the real evaluator identity, layered evidence, and hard-gate
 * findings stay exactly what the model produced. `qualityScore` is the
 * model's own complete judgment too, UNLESS the cut landed before that
 * member arrived (`recovered.qualityScoreCut`): then the wire value is still
 * `null` (the decoder admits no other shape here), but the one host
 * limitation says the score was lost to the cut, never that the model
 * judged no rubric applicable. Only `reportMarkdown`, the narrative the cut
 * prevented the model from finishing, is ever host-written, and it names
 * the cut (and, when it applies, the lost score) as its one limitation.
 */
export function hostCompleteCutQualityReport(
  cut: CutJudgmentAnswer,
  maxResponseBytes: number | undefined,
): HostCompletedCutQualityReport | undefined {
  const recovered = recoverableQualityReportCut(cut, maxResponseBytes);
  if (!recovered) return undefined;
  return completeCutQualityReport(cut, recovered);
}

/**
 * The members-first entry for an answer submitted through the tool call:
 * the host already admitted `evaluation` and `qualityScore` whole,
 * and only the report turn that followed was cut. The completion is the one
 * the text answer gets for the same complete members, so both paths store the
 * same candidate.
 */
export function hostCompleteCutQualityReportFromMembers(
  cut: CutJudgmentAnswer,
  members: {
    readonly evaluation: Readonly<Record<string, unknown>>;
    readonly qualityScore: Readonly<Record<string, unknown>> | null;
  },
): HostCompletedCutQualityReport {
  return completeCutQualityReport(cut, {
    evaluation: members.evaluation as JsonEvidenceValue,
    qualityScore: members.qualityScore as JsonEvidenceValue | null,
    qualityScoreCut: false,
  });
}

function completeCutQualityReport(
  cut: CutJudgmentAnswer,
  recovered: NonNullable<ReturnType<typeof recoverableQualityReportCut>>,
): HostCompletedCutQualityReport {
  const billed =
    cut.answerOutputTokens === undefined
      ? "an unreported number of output tokens"
      : plural(cut.answerOutputTokens, "output token", "output tokens");
  // The two structured members are never conflated: `qualityScore: null` is
  // reported identically at the wire regardless of cause, but the one host
  // limitation says which happened -- a `qualityScoreCut` never asserts a
  // judgment the model did not make.
  const scoreDisposition = recovered.qualityScoreCut
    ? "after its structured evaluation had already completed, but before its quality score did;"
    : "after its structured evaluation and quality score had already completed;";
  const scoreNote = recovered.qualityScoreCut
    ? "The host kept the complete evaluation and wrote this narrative report itself instead of the " +
      "model; the evaluation above is unaffected by the cut and remains the authoritative result. " +
      "The quality score was lost to the cut before it arrived: the null value reported above " +
      "reflects that loss, not a model determination that no content-type rubric applied."
    : "The host kept both complete and wrote this narrative report itself instead of the model; " +
      "the evaluation and score above are unaffected by the cut and remain the authoritative result.";
  const limitation =
    `${QUALITY_REPORT_CUT_STEM} the evaluate-document-quality answer was cut at the ` +
    `${cut.outputTokenLimit.toLocaleString("en-US")}-token output limit (${cut.shape}) ` +
    `${scoreDisposition} the answer turns billed ${billed}. ` +
    scoreNote;
  const reportMarkdown = [
    "# Documentation quality report (host-completed narrative)",
    "",
    limitation,
    "",
    recovered.qualityScoreCut
      ? "The structured evaluation is the authoritative result of this step and was not affected by " +
        "the cut; the quality score was lost to the cut, and only this narrative section was not " +
        "written by the model because its answer was cut before reaching it."
      : "The structured evaluation and quality score are the authoritative result of this step and were " +
        "not affected by the cut; only this narrative section was not written by the model because its " +
        "answer was cut before reaching it.",
  ].join("\n");
  const reply = JSON.stringify({
    evaluation: recovered.evaluation,
    qualityScore: recovered.qualityScore,
    reportMarkdown,
  });
  return { reply, limitation, cut };
}

/**
 * Complete a cut `evaluate-document-quality` answer for a step running
 * without a bound quality-evaluator profile (`qualityProfileSelection`
 * unset -- every hosted pilot run today; only the local CLI binds one).
 * With no evaluator contract loaded, this step's prompt never asked the
 * model for the JSON envelope {@link hostCompleteCutQualityReport}
 * completes: its reply is the same plain-markdown report every other
 * unbound step already writes. So the host keeps the truncated prose
 * verbatim -- never re-derived, never re-scored -- and appends the one
 * limitation naming the cut, instead of fabricating structure the model
 * was never asked to produce.
 *
 * `undefined` only when the cut left nothing to keep (the very first turn's
 * text was empty before it was cut): the one case with nothing safe to
 * complete, which fails exactly as it did before this function existed.
 */
export function hostCompleteCutQualityNarrative(
  cut: CutJudgmentAnswer,
): HostCompletedCutQualityReport | undefined {
  const kept = cut.stitched.trim();
  if (!kept) return undefined;
  const billed =
    cut.answerOutputTokens === undefined
      ? "an unreported number of output tokens"
      : plural(cut.answerOutputTokens, "output token", "output tokens");
  const limitation =
    `${QUALITY_REPORT_CUT_STEM} the evaluate-document-quality answer was cut at the ` +
    `${cut.outputTokenLimit.toLocaleString("en-US")}-token output limit (${cut.shape}) ` +
    `before it finished; the answer turns billed ${billed}. The host kept everything the model ` +
    `wrote before the cut, unedited, and appended this one limitation below it; nothing after ` +
    `the cut is represented here.`;
  const reply = `${kept}\n\n---\n\n${limitation}`;
  return { reply, limitation, cut };
}

/**
 * Whether admission refused a host-completed cut reply for its model content (a
 * retryable, `model-correctable` rejection), so the host falls back to
 * {@link hostFillRefusedCutJudgment}. Terminal refusals, including a credential
 * disclosure (`unsafe-disclosure`) and a source or target authority refusal,
 * still fail the step.
 */
export function refusedAsModelContent(error: unknown): error is InferenceStepError {
  return error instanceof InferenceStepError && error.retryable;
}

/**
 * The floor when admission refused the completed cut reply for its model
 * content: the host keeps none of the cut answer and fills every obligation and
 * target. It decodes only while the filled coverage fits
 * the step's proposal bound, which a repository-scale target list can exceed.
 */
export function hostFillRefusedCutJudgment(
  input: HarnessStepInput,
  refused: HostCompletedCutJudgment,
  refusal: InferenceStepError,
): HostCompletedCutJudgment {
  const obligationIds = ledgerObligationIds(input);
  const { rowsKept, coverageKept, issueJudgmentsKept } = refused.counts;
  const kept = [
    plural(rowsKept, "complete obligation judgment", "complete obligation judgments"),
    plural(coverageKept, "coverage entry", "coverage entries"),
    `and ${plural(issueJudgmentsKept, "issue judgment", "issue judgments")}`,
  ].join(", ");
  return {
    ...completeFromPlan(
      input,
      obligationIds,
      planCompletion(undefined, obligationIds),
      cutNote(
        input,
        refused.cut,
        ` The step's own checks refused the host's first completion, which kept ${kept} (${refusal.rejection?.code ?? "unknown"}), so the host kept none of them and filled every obligation.`,
      ),
    ),
    cut: refused.cut,
  };
}

/**
 * Whether the host admits the all-host-filled floor instead of failing the
 * step, because no retry of this refusal will follow.
 *
 * Only on the two `answerNowAppliesTo` judgment steps. Both are read-only, so a
 * credential match is the one refusal that stays closed; every other
 * model-content refusal fails open once no retry is left, and the floor keeps
 * nothing of the refused reply. A refused stitched reply is marked after
 * this check as the `cut-answer` condition (`markStitchedReplyRefusal`); the
 * floor's notion of "no retry left" stays the contract count.
 */
export function refusedWithNoRetryLeft(
  input: Pick<
    HarnessStepInput,
    "workflow" | "step" | "sourceObligationLedger" | "finalInferenceAttempt"
  >,
  error: unknown,
): error is InferenceStepError {
  return (
    answerNowAppliesTo(input) &&
    error instanceof InferenceStepError &&
    (input.finalInferenceAttempt === true || !error.retryable) &&
    !refusedForCredential(error)
  );
}

/** Whether a judgment refusal is the disclosure screen's credential match. */
function refusedForCredential(error: InferenceStepError): boolean {
  return error.rejection?.code === "unsafe-disclosure";
}

/**
 * The floor for a refused judgment reply: name whether a continuation already
 * spent the output allowance or no retry remains. Filled coverage over the
 * proposal bound still fails the step.
 */
export function hostFillRefusedJudgment(
  input: HarnessStepInput,
  refusal: InferenceStepError,
  reason: "no-retry-left" | "continued-refusal" = "no-retry-left",
): HostJudgmentCompletion {
  const obligationIds = ledgerObligationIds(input);
  return completeFromPlan(
    input,
    obligationIds,
    planCompletion(undefined, obligationIds),
    (counts) =>
      refusedJudgmentLimitation(
        input.step.id,
        input.inferenceAttempt ?? 1,
        refusal.rejection?.code ?? "unknown",
        counts,
        reason,
      ),
    reason === "continued-refusal" ? "continued-judgment-reply-refused" : "judgment-reply-refused",
  );
}

/** The sealed obligation IDs a completion accounts for, in ledger order. */
function ledgerObligationIds(input: HarnessStepInput): string[] {
  const ledger = input.sourceObligationLedger;
  if (ledger?.schemaVersion !== 2) {
    throw new Error(
      "A cut judgment answer can only be completed over a V2 source-obligation ledger.",
    );
  }
  return ledger.dimensions.flatMap((dimension) => dimension.obligations.map(({ id }) => id));
}

/** The reply and host policy one completion plan yields, with `note` its one limitation. */
function completeFromPlan(
  input: HarnessStepInput,
  obligationIds: readonly string[],
  plan: CompletionPlan,
  note: (counts: CutJudgmentCounts) => string,
  hostFillReason: HostFillReason = "answer-cut-at-output-limit",
): HostJudgmentCompletion {
  const targets = [...new Set(authoritativeReviewTargetPaths(input) ?? [])];
  const coverageFilled = degradeJudgmentCoverage(plan.coverage, targets).filledPaths.length;
  const counts: CutJudgmentCounts = {
    rowsKept: plan.rows.size,
    rowsFilled: plan.hostFilled.size,
    rowsDiscarded: plan.rowsDiscarded,
    coverageKept: targets.length - coverageFilled,
    coverageFilled,
    issueJudgmentsKept: plan.issueJudgments.length,
    issueJudgmentsDropped: plan.issueJudgmentsDropped,
    linksPruned: plan.linksPruned,
  };
  const reply = JSON.stringify({
    verdict: "human-review",
    coverage: plan.coverage,
    issueJudgments: plan.issueJudgments,
    obligationJudgments: obligationIds.map(
      (obligationId) =>
        plan.rows.get(obligationId) ?? hostRejectedObligationJudgment(obligationId, hostFillReason),
    ),
  });
  return {
    reply,
    coveragePolicy: {
      degradeCoverage: true,
      hostLimitations: [note(counts)],
      hostFilledObligationIds: plan.hostFilled,
      hostFillReason,
    },
    counts,
  };
}
