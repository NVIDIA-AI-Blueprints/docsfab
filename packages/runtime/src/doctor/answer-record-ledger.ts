// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { parseJsonEvidence } from "../json-evidence.js";
import {
  ANSWER_RECORD_PREMISE_EVIDENCE_SHA256,
  ANSWER_RECORD_PROBE_KIND,
  ANSWER_RECORD_RESERVATION_KIND,
  AnswerRecordLedgerError,
  isAnswerRecordDiagnosticEvidence,
  isAnswerRecordExactQualificationEvidence,
  type AnswerRecordLedger,
} from "../profile/answer-record-probe.js";

/** The immutable six-singleton context observation whose only failure was the equivalent null spelling. */
export const ANSWER_RECORD_TYPED_CONTEXT_PARTIAL_EVIDENCE_SHA256 =
  "84609596d548bbea6109e544087a20eb9c99261187ef1ded9b714b08f7bf1c47";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function countOf(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Validate K's request-level resend graph; those resends never use shared retries. */
function smallGroupResends(
  samples: readonly unknown[],
  measurement: unknown,
  fileName: string,
): number {
  const invalid = () =>
    new AnswerRecordLedgerError(
      `The retained observation ${fileName} has invalid retry provenance.`,
    );
  const inconsistent = () =>
    new AnswerRecordLedgerError(
      `The retained observation ${fileName} has inconsistent retry provenance.`,
    );
  const children = new Map<number, number>();
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index];
    if (!isRecord(sample) || typeof sample.retried !== "boolean") throw invalid();
    if (sample.retryOf === null) continue;
    if (!countOf(sample.retryOf) || sample.retryOf >= index || sample.retried) throw invalid();
    const parent = samples[sample.retryOf];
    if (!isRecord(parent) || parent.retryOf !== null || parent.retried !== true) {
      throw inconsistent();
    }
    if (children.has(sample.retryOf)) throw inconsistent();
    children.set(sample.retryOf, index);
  }
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index];
    if (!isRecord(sample) || sample.retried !== children.has(index)) throw inconsistent();
  }

  const resendCount = children.size;
  if (
    isRecord(measurement) &&
    measurement.remainderResends !== undefined &&
    (!countOf(measurement.remainderResends) || measurement.remainderResends !== resendCount)
  ) {
    throw new AnswerRecordLedgerError(
      `The retained observation ${fileName} has a remainder-resend count that does not match its retry markers.`,
    );
  }
  if (
    isRecord(measurement) &&
    measurement.transportRetriesUsed !== undefined &&
    measurement.transportRetriesUsed !== 0
  ) {
    throw new AnswerRecordLedgerError(
      `The retained observation ${fileName} records shared retries for a small-group run.`,
    );
  }
  return resendCount;
}

/**
 * Sum the untyped request tranche and combined input-token spend. Typed
 * requests use their own tranche, but their tokens still count against the
 * shared ceiling. Each file is named by the SHA-256 of its bytes, so an
 * edited file is refused rather than counted at a lower spend.
 */
export function answerRecordLedger(
  files: readonly { readonly name: string; readonly text: string }[],
): AnswerRecordLedger {
  let requests = 0;
  let inputTokens = 0;
  let reservations = 0;
  const charged = new Set<string>();
  for (const file of files) {
    const digest = createHash("sha256").update(file.text).digest("hex");
    if (file.name !== `${digest}.json`) {
      throw new AnswerRecordLedgerError(
        `The retained observation ${file.name} does not match its SHA-256 ${digest}.`,
      );
    }
    let parsed: unknown;
    try {
      parsed = parseJsonEvidence(file.text);
    } catch {
      parsed = undefined;
    }
    const unreadable = () =>
      new AnswerRecordLedgerError(
        `The retained observation ${file.name} is not a readable record-probe observation.`,
      );
    if (!isRecord(parsed)) throw unreadable();
    if (parsed.kind === ANSWER_RECORD_RESERVATION_KIND) {
      if (!countOf(parsed.requests) || !countOf(parsed.inputTokens)) throw unreadable();
      if (!validRetainedExactQualification(parsed, true) || !validRetainedDiagnostic(parsed, true))
        throw unreadable();
      if (
        parsed.selection !== undefined &&
        !["premise", "small-groups", "typed"].includes(String(parsed.selection))
      ) {
        throw unreadable();
      }
      if (parsed.selection !== "typed") requests += parsed.requests;
      inputTokens += parsed.inputTokens;
      reservations += 1;
      charged.add(digest);
      continue;
    }
    if (parsed.kind !== ANSWER_RECORD_PROBE_KIND || !Array.isArray(parsed.samples)) {
      throw unreadable();
    }
    const typed = parsed.shell === "typed" && parsed.selection === "typed";
    if (parsed.shell !== "untyped" && !typed) throw unreadable();
    if (
      parsed.selection !== undefined &&
      !["premise", "small-groups", "typed"].includes(String(parsed.selection))
    ) {
      throw unreadable();
    }
    if (parsed.selection === "typed" && !typed) throw unreadable();
    if (!validRetainedExactQualification(parsed, false)) throw unreadable();
    if (!validRetainedDiagnostic(parsed, false)) throw unreadable();
    for (const sample of parsed.samples) {
      const estimated = isRecord(sample) ? sample.estimatedInputTokens : undefined;
      const reported = isRecord(sample) ? sample.promptTokens : undefined;
      if (!countOf(estimated) || !(reported === null || countOf(reported))) {
        throw new AnswerRecordLedgerError(
          `A sample in the retained observation ${file.name} has no input-token count.`,
        );
      }
      if (!typed) requests += 1;
      inputTokens += Math.max(reported ?? 0, estimated);
    }
    charged.add(digest);
  }
  if (!charged.has(ANSWER_RECORD_PREMISE_EVIDENCE_SHA256)) {
    throw new AnswerRecordLedgerError(
      `The retained observations do not include the premise run ${ANSWER_RECORD_PREMISE_EVIDENCE_SHA256}.`,
    );
  }
  return { observations: charged.size, reservations, requests, inputTokens };
}

/** Validate the optional exact-plan proof while leaving historical/ordinary records unchanged. */
function validRetainedExactQualification(
  record: Record<string, unknown>,
  reservation: boolean,
): boolean {
  if (record.exactQualification === undefined) return true;
  const exact = record.exactQualification;
  if (
    !isAnswerRecordExactQualificationEvidence(exact) ||
    record.selection !== "typed" ||
    record.modelId !== exact.modelId ||
    record.corpusSha256 !== exact.corpusSha256 ||
    exact.shell !== "typed"
  )
    return false;
  if (reservation) {
    return isRecord(record.plan) && record.plan.requests === exact.cells.length;
  }
  return record.shell === "typed" && record.maxOutputTokens === exact.maxOutputTokens;
}

/** Keep diagnostic spend chargeable while forbidding it from carrying a qualification proof. */
function validRetainedDiagnostic(record: Record<string, unknown>, reservation: boolean): boolean {
  if (record.diagnosticOnly === undefined) return true;
  const diagnostic = record.diagnosticOnly;
  const plan = isRecord(record.plan) ? record.plan : undefined;
  if (
    !isAnswerRecordDiagnosticEvidence(diagnostic) ||
    record.exactQualification !== undefined ||
    record.selection !== "typed" ||
    (record.shell !== undefined && record.shell !== "typed") ||
    record.modelId !== diagnostic.modelId ||
    record.corpusSha256 !== diagnostic.corpusSha256 ||
    plan?.requests !== 1 ||
    plan.transportRetries !== 0 ||
    plan.diagnosticFingerprint !== diagnostic.diagnosticFingerprint
  ) {
    return false;
  }
  if (reservation) return true;
  if (!Array.isArray(record.samples) || record.samples.length !== 1) return false;
  const sample = record.samples[0];
  return (
    isRecord(sample) &&
    sample.phase === diagnostic.cell.phase &&
    sample.rungBytes === diagnostic.cell.rungBytes &&
    sample.seed === diagnostic.cell.seed &&
    sample.plannedBytes === diagnostic.cell.plannedBytes &&
    sample.expectedCalls === diagnostic.cell.calls.length &&
    Array.isArray(sample.calls)
  );
}

export function hasPinnedContextGroupContinuation(
  files: readonly { readonly name: string; readonly text: string }[],
): boolean {
  const names = new Set(files.map((file) => file.name));
  const requiredHistory = [
    "a556782a4c1db76a65c58b8b3ce25988b77865e4f9694b27ae3a501436070605.json",
    "6f1add22933da65d6eaa88a726dbfa983d8fbd27b28b93eb2e33c61e06e02077.json",
    "44e76d415b9e4f285a7b7c2f9183f34f347d9d30463391bf19baf74d96d72bb3.json",
    `${ANSWER_RECORD_TYPED_CONTEXT_PARTIAL_EVIDENCE_SHA256}.json`,
  ];
  if (!requiredHistory.every((name) => names.has(name))) return false;

  // The existing typed-ledger reader has already verified each filename against
  // its bytes. Only permit the pinned partial screen and reject any prior group
  // send; additional ordinary observations remain charged by the ledger.
  for (const file of files) {
    let parsed: unknown;
    try {
      parsed = parseJsonEvidence(file.text);
    } catch {
      continue;
    }
    if (!isRecord(parsed) || parsed.kind !== ANSWER_RECORD_PROBE_KIND) continue;
    if (parsed.typedContextGroupOnly === true) return false;
    if (
      Array.isArray(parsed.samples) &&
      parsed.samples.some(
        (sample) =>
          isRecord(sample) && sample.phase === "A-t-context" && sample.expectedCalls === 2,
      )
    ) {
      return false;
    }
  }
  return true;
}

/** Validate content-addressed retained files and total their combined spend. */
export function answerRecordTypedLedger(
  files: readonly { readonly name: string; readonly text: string }[],
): AnswerRecordLedger {
  let requests = 0;
  let typedRequests = 0;
  let inputTokens = 0;
  let transportRetriesUsed = 0;
  let reservations = 0;
  const charged = new Set<string>();
  for (const file of files) {
    const digest = createHash("sha256").update(file.text).digest("hex");
    if (file.name !== `${digest}.json`) {
      throw new AnswerRecordLedgerError(
        `The retained observation ${file.name} does not match its SHA-256 ${digest}.`,
      );
    }
    let parsed: unknown;
    try {
      parsed = parseJsonEvidence(file.text);
    } catch {
      parsed = undefined;
    }
    if (!isRecord(parsed)) {
      throw new AnswerRecordLedgerError(
        `The retained observation ${file.name} cannot be read as structured probe evidence.`,
      );
    }
    if (parsed.kind === ANSWER_RECORD_RESERVATION_KIND) {
      if (!countOf(parsed.requests) || !countOf(parsed.inputTokens)) {
        throw new AnswerRecordLedgerError(
          `The retained reservation ${file.name} has invalid charged request or token limits.`,
        );
      }
      if (
        parsed.selection !== undefined &&
        !["premise", "small-groups", "typed"].includes(String(parsed.selection))
      ) {
        throw new AnswerRecordLedgerError(
          `The retained reservation ${file.name} has an unknown selection.`,
        );
      }
      if (
        !validRetainedExactQualification(parsed, true) ||
        !validRetainedDiagnostic(parsed, true)
      ) {
        throw new AnswerRecordLedgerError(
          `The retained reservation ${file.name} has invalid plan binding.`,
        );
      }
      const planRetries = isRecord(parsed.plan) ? parsed.plan.transportRetries : undefined;
      const retryReserve = parsed.transportRetries ?? planRetries;
      if (!countOf(retryReserve))
        throw new AnswerRecordLedgerError(
          `The retained reservation ${file.name} has invalid retry accounting.`,
        );
      // Reservations predate the selection field only in the small-group K
      // flow, so preserve those records as K reservations rather than
      // consuming the shared 1a/1b retry pool.
      const reservationSelection = parsed.selection ?? "small-groups";
      if (
        parsed.diagnosticOnly !== undefined &&
        (reservationSelection !== "typed" || retryReserve !== 0)
      ) {
        throw new AnswerRecordLedgerError(
          `The retained diagnostic reservation ${file.name} does not use the typed pool with zero retries.`,
        );
      }
      requests += parsed.requests;
      inputTokens += parsed.inputTokens;
      // Small-group/K retries are paid from its own 24-request ledger. The
      // two shared retries belong only to premise (1a) and typed (1b).
      if (reservationSelection !== "small-groups") transportRetriesUsed += retryReserve;
      if (reservationSelection === "typed") typedRequests += parsed.requests;
      reservations += 1;
      charged.add(digest);
      continue;
    }
    if (parsed.kind !== ANSWER_RECORD_PROBE_KIND || !Array.isArray(parsed.samples)) {
      throw new AnswerRecordLedgerError(
        `The retained observation ${file.name} is not a record-probe observation.`,
      );
    }
    const isTyped = parsed.shell === "typed" && parsed.selection === "typed";
    if (parsed.shell !== "untyped" && !isTyped) {
      throw new AnswerRecordLedgerError(
        `The retained observation ${file.name} has an unsupported shell/selection pair.`,
      );
    }
    if (
      parsed.selection !== undefined &&
      !["premise", "small-groups", "typed"].includes(String(parsed.selection))
    ) {
      throw new AnswerRecordLedgerError(
        `The retained observation ${file.name} has an unknown selection.`,
      );
    }
    if (!validRetainedExactQualification(parsed, false)) {
      throw new AnswerRecordLedgerError(
        `The retained observation ${file.name} has invalid exact-qualification binding.`,
      );
    }
    if (!validRetainedDiagnostic(parsed, false)) {
      throw new AnswerRecordLedgerError(
        `The retained observation ${file.name} has invalid diagnostic-only binding.`,
      );
    }
    for (const sample of parsed.samples) {
      const estimated = isRecord(sample) ? sample.estimatedInputTokens : undefined;
      const reported = isRecord(sample) ? sample.promptTokens : undefined;
      if (!countOf(estimated) || !(reported === null || countOf(reported))) {
        throw new AnswerRecordLedgerError(
          `A sample in the retained observation ${file.name} has no input-token count.`,
        );
      }
      requests += 1;
      if (isTyped) typedRequests += 1;
      inputTokens += Math.max(reported ?? 0, estimated);
    }
    const measurement = parsed.measurement;
    let retries = isRecord(measurement) ? measurement.transportRetriesUsed : undefined;
    if (parsed.selection === "small-groups") {
      smallGroupResends(parsed.samples, measurement, file.name);
      // K resends are already represented as separate request samples and do
      // not draw from the shared premise/typed retry pool.
      retries = 0;
    } else if (retries === undefined) {
      // Older 1a observations predate the aggregate counter but retain each
      // send's retry marker. Derive the exact count from those per-send fields.
      const retryMarked = parsed.samples.every(
        (sample) =>
          isRecord(sample) &&
          typeof sample.retried === "boolean" &&
          (sample.retryOf === null || countOf(sample.retryOf)),
      );
      if (retryMarked) {
        retries = parsed.samples.filter(
          (sample) => isRecord(sample) && (sample.retried === true || sample.retryOf !== null),
        ).length;
      }
    }
    if (!countOf(retries)) {
      throw new AnswerRecordLedgerError(
        `The retained observation ${file.name} has no shared-retry count.`,
      );
    }
    // K's re-sends already appear as separate samples and consume the K
    // request tranche; only the premise and typed slices draw on the shared
    // retry pool. A missing selection is a legacy untyped premise record.
    if (parsed.selection !== "small-groups") transportRetriesUsed += retries;
    charged.add(digest);
  }
  if (!charged.has(ANSWER_RECORD_PREMISE_EVIDENCE_SHA256)) {
    throw new AnswerRecordLedgerError(
      `The retained observations do not include the pinned 1a premise run ${ANSWER_RECORD_PREMISE_EVIDENCE_SHA256}.`,
    );
  }
  return {
    observations: charged.size,
    reservations,
    requests,
    typedRequests,
    inputTokens,
    transportRetriesUsed,
  };
}
