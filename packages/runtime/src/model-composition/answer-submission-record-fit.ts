// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure answer-submission record message and timer fit calculations.
 * This module intentionally has no filesystem, CLI, or runtime integration imports.
 */

export interface AnswerSubmissionRecordsGroupEnvelopeBytes {
  readonly group: number;
  readonly maxBytes: number;
}

export interface AnswerSubmissionFixtureRowV1 {
  readonly fixture: string;
  readonly group: number;
  readonly type: string;
  readonly key: string | null;
  readonly rawEnvelopeBytes: number;
}

export interface AnswerSubmissionRemainingPlanInput {
  readonly fixtureRows: readonly AnswerSubmissionFixtureRowV1[];
  /** Host ledger's exact open required keys (singleton keys are the type name). */
  readonly remainingKeys: readonly string[];
  /** Host ledger's exact admitted keys; this is state, not a row-count proxy. */
  readonly completedKeys: readonly string[];
  /** Direct status of every declared open set and its host closing flag. */
  readonly openSets: readonly { readonly type: string; readonly open: boolean }[];
  /** Direct host ledger completion state. */
  readonly complete: boolean;
  readonly qualifiedMessageBudget: number;
}

export interface AnswerSubmissionRemainingPlan {
  readonly openPlanBytes: number;
  readonly remainingMessages: number;
  readonly missingRequiredKeys: readonly string[];
}

/**
 * Project open canonical corpus work onto the sealed per-fixture plan. Unknown
 * optional/open rows remain conservatively allocated until the host ledger is
 * terminal; required keys without a corpus row are reported for unarming.
 */
export function deriveAnswerSubmissionRemainingPlan(
  input: AnswerSubmissionRemainingPlanInput,
): AnswerSubmissionRemainingPlan {
  if (
    input.fixtureRows.length === 0 ||
    !Number.isSafeInteger(input.qualifiedMessageBudget) ||
    input.qualifiedMessageBudget <= 0 ||
    input.remainingKeys.some((key) => typeof key !== "string" || key.length === 0) ||
    input.completedKeys.some((key) => typeof key !== "string" || key.length === 0) ||
    input.openSets.some(
      (entry) =>
        typeof entry.type !== "string" ||
        entry.type.length === 0 ||
        typeof entry.open !== "boolean",
    )
  ) {
    throw new TypeError("The answer record remaining-plan inputs are invalid or unsupported.");
  }
  const fixtureNames = new Set<string>();
  for (const row of input.fixtureRows) {
    if (
      typeof row.fixture !== "string" ||
      row.fixture.length === 0 ||
      !Number.isSafeInteger(row.group) ||
      row.group <= 0 ||
      typeof row.type !== "string" ||
      row.type.length === 0 ||
      (row.key !== null && (typeof row.key !== "string" || row.key.length === 0)) ||
      !Number.isSafeInteger(row.rawEnvelopeBytes) ||
      row.rawEnvelopeBytes <= 0
    ) {
      throw new TypeError("The answer record fixture-row projection is invalid or unsupported.");
    }
    fixtureNames.add(row.fixture);
  }
  if (fixtureNames.size === 0) {
    throw new TypeError(
      "The answer record fixture-row projection is empty for this sealed model-composition input.",
    );
  }
  const available = new Set(
    input.fixtureRows.map((row) => (row.key === null ? row.type : `${row.type}:${row.key}`)),
  );
  const missingRequiredKeys = input.remainingKeys.filter((key) => !available.has(key));
  if (input.complete) return { openPlanBytes: 0, remainingMessages: 0, missingRequiredKeys };
  const remaining = new Set(input.remainingKeys);
  const completed = new Set(input.completedKeys);
  const openSets = new Map(input.openSets.map((entry) => [entry.type, entry.open]));
  if ([...remaining].some((key) => completed.has(key))) {
    throw new TypeError("A required answer-record key cannot be both open and completed.");
  }
  const fixtureTotals = new Map<string, number>();
  const fixtureGroups = new Map<string, Map<number, number>>();
  for (const row of input.fixtureRows) {
    const key = row.key === null ? row.type : `${row.type}:${row.key}`;
    const openSetClosed = openSets.has(row.type) && !openSets.get(row.type);
    if (openSetClosed || completed.has(key)) continue;
    // A non-required row has no exact completion key. Retain it as a worst-case
    // allocation until the ledger reaches its directly reported terminal state.
    fixtureTotals.set(row.fixture, (fixtureTotals.get(row.fixture) ?? 0) + row.rawEnvelopeBytes);
    const groups = fixtureGroups.get(row.fixture) ?? new Map<number, number>();
    groups.set(row.group, (groups.get(row.group) ?? 0) + row.rawEnvelopeBytes);
    fixtureGroups.set(row.fixture, groups);
  }
  const openPlanBytes = Math.max(0, ...fixtureTotals.values());
  const maxBytesByGroup = new Map<number, number>();
  for (const groups of fixtureGroups.values()) {
    for (const [group, bytes] of groups) {
      maxBytesByGroup.set(group, Math.max(maxBytesByGroup.get(group) ?? 0, bytes));
    }
  }
  const remainingMessages = [...maxBytesByGroup.values()].reduce(
    (sum, bytes) => sum + Math.ceil(bytes / input.qualifiedMessageBudget),
    0,
  );
  if (!Number.isSafeInteger(openPlanBytes) || !Number.isSafeInteger(remainingMessages)) {
    throw new TypeError("The answer record remaining plan exceeds safe numeric precision.");
  }
  return { openPlanBytes, remainingMessages, missingRequiredKeys };
}

export interface AnswerSubmissionRecordsMessageBudgetInput {
  readonly effectiveMaxOutputTokens: number;
  readonly allowanceShareBasisPoints: number;
  readonly bytesPerTokenFloorMilli: number;
  readonly qualifiedMessageBytes: number;
  readonly minimumQualifiedMessageBytes: number;
  readonly sealedMessageCeiling: number;
}

/** The message budget is recalculated from the effective provider output allowance. */
export function deriveAnswerSubmissionRecordsMessageBudget(
  input: AnswerSubmissionRecordsMessageBudgetInput,
): number {
  const positive = [
    input.effectiveMaxOutputTokens,
    input.bytesPerTokenFloorMilli,
    input.qualifiedMessageBytes,
    input.minimumQualifiedMessageBytes,
    input.sealedMessageCeiling,
  ].every((value) => Number.isSafeInteger(value) && value > 0);
  if (
    !positive ||
    !Number.isSafeInteger(input.allowanceShareBasisPoints) ||
    input.allowanceShareBasisPoints < 0 ||
    input.allowanceShareBasisPoints > 10_000
  ) {
    throw new TypeError("The answer record message budget inputs are invalid or unsupported.");
  }
  const formulaBytes =
    (BigInt(input.effectiveMaxOutputTokens) *
      BigInt(input.allowanceShareBasisPoints) *
      BigInt(input.bytesPerTokenFloorMilli)) /
    10_000_000n;
  if (formulaBytes > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new TypeError("The answer record message budget exceeds safe numeric precision.");
  }
  const budget = Math.min(
    Number(formulaBytes),
    input.qualifiedMessageBytes,
    input.sealedMessageCeiling,
  );
  return budget;
}

export interface AnswerSubmissionRecordsFitInput {
  readonly groupEnvelopeBytes: readonly AnswerSubmissionRecordsGroupEnvelopeBytes[];
  readonly maxMessageBytes: number;
  readonly minimumQualifiedMessageBytes: number;
  readonly fullPlanEnvelopeBytes: number;
  readonly largestRecordEnvelopeBytes: number;
  readonly bytesPerTokenFloorMilli: number;
  readonly decodeTokensPerSecond: number;
  readonly projectedReportTokens: number;
  readonly lturnMs: number;
  readonly d3ResidualFires: boolean | "unknown";
  readonly readingTurnsP90: number;
  readonly maxProviderTurns: number;
  readonly effectiveTimeoutMs: number;
  readonly timerReviewLimitMs: number;
  readonly answerNowElapsedShareBasisPoints: number;
}

export interface AnswerSubmissionRecordsFit {
  readonly messages: number;
  readonly fullPlanTokens: number;
  readonly largestRecordTokens: number;
  readonly dFullMs: number;
  /** Fixed final-report decode time retained after all record rows are complete. */
  readonly reportDecodeReserveMs: number;
  readonly requiredReadingTurns: number;
  readonly predictedTimerMs: number;
  readonly effectiveTimeoutMs: number;
  readonly timerReviewLimitMs: number;
  readonly fitsReadingTurns: boolean;
  readonly fitsRecordBoundary: boolean;
  readonly fitsQualifiedMessageFloor: boolean;
  /** Unknown D3 state reserves the same single residual turn as a firing. */
  readonly d3ResidualSource:
    | "observed-fire"
    | "observed-no-fire"
    | "unobserved-conservative-reserve";
  readonly fitsEffectiveTimer: boolean;
  readonly withinReviewThreshold: boolean;
}

/**
 * Shared §4.2–§4.4 fit calculation for reseal, startup and doctor. Group
 * maxima, the full-plan total and the largest record are separately verified
 * against the committed corpus before reaching this pure function.
 */
export function deriveAnswerSubmissionRecordsFit(
  input: AnswerSubmissionRecordsFitInput,
): AnswerSubmissionRecordsFit {
  const positive = [
    input.maxMessageBytes,
    input.minimumQualifiedMessageBytes,
    input.fullPlanEnvelopeBytes,
    input.largestRecordEnvelopeBytes,
    input.bytesPerTokenFloorMilli,
    input.decodeTokensPerSecond,
    input.projectedReportTokens,
    input.lturnMs,
    input.maxProviderTurns,
    input.effectiveTimeoutMs,
    input.timerReviewLimitMs,
    input.answerNowElapsedShareBasisPoints,
  ].every((value) => Number.isFinite(value) && value > 0);
  if (
    !positive ||
    !Number.isSafeInteger(input.maxMessageBytes) ||
    !Number.isSafeInteger(input.minimumQualifiedMessageBytes) ||
    !Number.isSafeInteger(input.fullPlanEnvelopeBytes) ||
    !Number.isSafeInteger(input.largestRecordEnvelopeBytes) ||
    !Number.isSafeInteger(input.bytesPerTokenFloorMilli) ||
    !Number.isSafeInteger(input.maxProviderTurns) ||
    !Number.isSafeInteger(input.effectiveTimeoutMs) ||
    !Number.isSafeInteger(input.timerReviewLimitMs) ||
    !Number.isSafeInteger(input.answerNowElapsedShareBasisPoints) ||
    !Number.isFinite(input.readingTurnsP90) ||
    input.readingTurnsP90 < 0 ||
    input.answerNowElapsedShareBasisPoints >= 10_000 ||
    input.answerNowElapsedShareBasisPoints < 0 ||
    input.groupEnvelopeBytes.length === 0 ||
    input.groupEnvelopeBytes.some(
      (entry, index) =>
        !Number.isSafeInteger(entry.group) ||
        entry.group <= 0 ||
        !Number.isSafeInteger(entry.maxBytes) ||
        entry.maxBytes <= 0 ||
        (index > 0 && entry.group <= input.groupEnvelopeBytes[index - 1]!.group),
    )
  ) {
    throw new TypeError("The answer record fit inputs are invalid or unsupported.");
  }
  const messages = input.groupEnvelopeBytes.reduce(
    (sum, entry) => sum + Math.ceil(entry.maxBytes / input.maxMessageBytes),
    0,
  );
  const tokensOf = (bytes: number) => Math.ceil((bytes * 1000) / input.bytesPerTokenFloorMilli);
  const fullPlanTokens = tokensOf(input.fullPlanEnvelopeBytes);
  const largestRecordTokens = tokensOf(input.largestRecordEnvelopeBytes);
  const dFullMs = Math.ceil(
    ((fullPlanTokens + input.projectedReportTokens + largestRecordTokens) /
      input.decodeTokensPerSecond) *
      1000,
  );
  const reportDecodeReserveMs = Math.ceil(
    (input.projectedReportTokens / input.decodeTokensPerSecond) * 1000,
  );
  const d3ExtraTurns = input.d3ResidualFires === false ? 0 : 1;
  const answerMaxMs = dFullMs + (messages + 2 + d3ExtraTurns) * input.lturnMs;
  const elapsedShare = input.answerNowElapsedShareBasisPoints / 10_000;
  const predictedTimerMs = Math.ceil(answerMaxMs / (1 - elapsedShare));
  if (!Number.isSafeInteger(messages) || !Number.isSafeInteger(predictedTimerMs)) {
    throw new TypeError("The answer record fit result exceeds safe numeric precision.");
  }
  const requiredReadingTurns = Math.ceil(input.readingTurnsP90) + messages + 1 + messages;
  const fitsRecordBoundary = input.maxMessageBytes >= input.largestRecordEnvelopeBytes;
  const fitsQualifiedMessageFloor = input.maxMessageBytes >= input.minimumQualifiedMessageBytes;
  return {
    messages,
    fullPlanTokens,
    largestRecordTokens,
    dFullMs,
    reportDecodeReserveMs,
    requiredReadingTurns,
    predictedTimerMs,
    effectiveTimeoutMs: input.effectiveTimeoutMs,
    timerReviewLimitMs: input.timerReviewLimitMs,
    fitsReadingTurns: requiredReadingTurns <= input.maxProviderTurns,
    fitsRecordBoundary,
    fitsQualifiedMessageFloor,
    d3ResidualSource:
      input.d3ResidualFires === true
        ? "observed-fire"
        : input.d3ResidualFires === false
          ? "observed-no-fire"
          : "unobserved-conservative-reserve",
    fitsEffectiveTimer: fitsRecordBoundary && predictedTimerMs <= input.effectiveTimeoutMs,
    withinReviewThreshold: predictedTimerMs <= input.timerReviewLimitMs,
  };
}
