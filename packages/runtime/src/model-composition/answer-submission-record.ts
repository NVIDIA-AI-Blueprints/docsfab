// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { canonicalDigest, canonicalJson } from "../content-ir/canonical.js";
import { decodeSavedRunRecord } from "../records/saved-run-record.js";
import { limit } from "../config/limits.js";
import { parseJsonEvidence } from "../json-evidence.js";
import { QUALITY_ANSWER_RECORD_TOOL_NAME } from "../harness/answer-submission.js";
import {
  ANSWER_RECORD_CORPUS_KIND,
  ANSWER_RECORD_CORPUS_SHA256,
  isAnswerRecordExactQualificationEvidence,
  sampleDecodeRate,
} from "../profile/answer-record-probe.js";
import { decodeAnswerSubmissionRecords } from "./contracts.js";
import type { InstalledAnswerSubmissionRecords } from "./types.js";

import {
  deriveAnswerSubmissionRecordsFit,
  deriveAnswerSubmissionRecordsMessageBudget,
} from "./answer-submission-record-fit.js";
export {
  deriveAnswerSubmissionRecordsFit,
  deriveAnswerSubmissionRecordsMessageBudget,
} from "./answer-submission-record-fit.js";
export type {
  AnswerSubmissionRecordsFit,
  AnswerSubmissionRecordsFitInput,
  AnswerSubmissionRecordsGroupEnvelopeBytes,
  AnswerSubmissionRecordsMessageBudgetInput,
} from "./answer-submission-record-fit.js";

/** Canonical-corpus row weight carried by a locally resealed #1973 capability. */
export interface AnswerSubmissionFixtureRowV1 {
  readonly fixture: string;
  readonly group: 1 | 2 | 3 | 4;
  readonly type: string;
  readonly key: string | null;
  readonly rawEnvelopeBytes: number;
}

/**
 * Derive the exact per-fixture row projection used by retry progress. Null
 * keys are row occurrences, not a map key: repeated anonymous rows are kept.
 */
export function deriveAnswerSubmissionFixtureRows(
  records: readonly unknown[],
): readonly AnswerSubmissionFixtureRowV1[] {
  return records.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError(
        "The canonical answer-record corpus row is malformed and cannot be trusted.",
      );
    }
    const row = value as Record<string, unknown>;
    if (
      typeof row.fixture !== "string" ||
      !Number.isSafeInteger(row.group) ||
      ![1, 2, 3, 4].includes(row.group as number) ||
      typeof row.type !== "string" ||
      !Object.hasOwn(row, "record") ||
      (row.key !== undefined && typeof row.key !== "string")
    ) {
      throw new TypeError(
        "The canonical answer-record corpus row is malformed and cannot be trusted.",
      );
    }
    const key = typeof row.key === "string" ? row.key : null;
    const envelope = {
      type: row.type,
      ...(key !== null ? { key } : {}),
      record: row.record,
    };
    return {
      fixture: row.fixture,
      group: row.group as 1 | 2 | 3 | 4,
      type: row.type,
      key,
      rawEnvelopeBytes: Buffer.byteLength(JSON.stringify(envelope), "utf8"),
    };
  });
}

/**
 * The completeness rule for a recorded answer-submission capability (#1707).
 * The runtime decoder keeps `objectMembers` optional, so this rule is what
 * makes it required: `reseal-composition-digests.mts` and
 * `verify-composition-digests.mts` refuse a registry in which any recorded
 * `answerSubmission` lacks one of these fields.
 */

/** Every field a recorded `answerSubmission` carries. */
export const RECORDED_ANSWER_SUBMISSION_FIELDS = Object.freeze([
  "kind",
  "argumentShell",
  "duplicateKeys",
  "reportTurnToolChoice",
  "objectMembers",
  "evidenceSha256",
] as const);

/**
 * One line per recorded `answerSubmission` field that is missing, naming the
 * composition and the field; empty when every recorded capability is complete.
 */
export function recordedAnswerSubmissionGaps(registry: unknown): string[] {
  const listed =
    registry && typeof registry === "object"
      ? (registry as { compositions?: unknown }).compositions
      : undefined;
  const compositions: unknown[] = Array.isArray(listed) ? listed : [];
  const gaps: string[] = [];
  for (const composition of compositions) {
    if (!composition || typeof composition !== "object") continue;
    const record = composition as Record<string, unknown>;
    const capability = record.answerSubmission;
    if (capability === undefined) continue;
    const id = String(record.compositionId ?? "<unknown>");
    if (!capability || typeof capability !== "object" || Array.isArray(capability)) {
      gaps.push(`composition ${id}: answerSubmission is not an object`);
      continue;
    }
    for (const field of RECORDED_ANSWER_SUBMISSION_FIELDS) {
      if (!Object.hasOwn(capability, field)) {
        gaps.push(`composition ${id}: answerSubmission lacks ${field}`);
      }
    }
  }
  return gaps;
}
/**
 * Check that a sealed records capability is backed by the exact committed
 * probe, corpus, and retained step-8 source files it names. A self-digest in
 * the composition proves internal consistency, not that measurements exist.
 */
export async function recordedAnswerSubmissionRecordsEvidenceGaps(
  registry: unknown,
  evidenceRoot: string,
): Promise<string[]> {
  const listed =
    registry && typeof registry === "object"
      ? (registry as { compositions?: unknown }).compositions
      : undefined;
  const compositions: unknown[] = Array.isArray(listed) ? listed : [];
  const gaps: string[] = [];
  const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
  const rawBytes = (value: unknown): number => {
    if (!value || typeof value !== "object") return 0;
    const bytes = (value as Record<string, unknown>).rawBytes;
    return typeof bytes === "number" && Number.isSafeInteger(bytes) && bytes > 0 ? bytes : 0;
  };
  const readJson = async (
    path: string,
  ): Promise<{ bytes: Buffer; value: Record<string, unknown> }> => {
    const bytes = await readFile(path);
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("The evidence file must contain one JSON object value.");
    return { bytes, value: value as Record<string, unknown> };
  };
  const samplesFor = (observation: Record<string, unknown>, phase: string) =>
    Array.isArray(observation.samples)
      ? observation.samples.filter(
          (sample): sample is Record<string, unknown> =>
            Boolean(sample) && typeof sample === "object" && sample.phase === phase,
        )
      : [];
  const admittedRung = (
    samples: Record<string, unknown>[],
    bytesOf: (sample: Record<string, unknown>) => number,
    expectedRungs: readonly number[],
  ): { rung: number; bytes: number; samples: Record<string, unknown>[] } | undefined => {
    const byRung = new Map<number, Record<string, unknown>[]>();
    for (const sample of samples) {
      const rung = sample.rungBytes ?? sample.plannedBytes;
      if (typeof rung !== "number" || !Number.isSafeInteger(rung) || rung <= 0) continue;
      byRung.set(rung, [...(byRung.get(rung) ?? []), sample]);
    }
    let last: { rung: number; bytes: number; samples: Record<string, unknown>[] } | undefined;
    for (const rung of expectedRungs) {
      const rungSamples = byRung.get(rung);
      if (!rungSamples) break;
      const seeds = rungSamples.map((sample) => sample.seed);
      const admitted =
        rungSamples.length === 3 &&
        new Set(seeds).size === 3 &&
        rungSamples.every(
          (sample) =>
            sample.admitted === true &&
            sample.failure === null &&
            Number.isSafeInteger(bytesOf(sample)) &&
            bytesOf(sample) > 0,
        );
      if (!admitted) break;
      last = {
        rung,
        bytes: Math.min(...rungSamples.map(bytesOf)),
        samples: rungSamples,
      };
    }
    return last;
  };

  for (const composition of compositions) {
    if (!composition || typeof composition !== "object") continue;
    const item = composition as Record<string, unknown>;
    const capability = item.answerSubmissionRecords;
    if (capability === undefined) continue;
    const id = String(item.compositionId ?? "<unknown>");
    let record: InstalledAnswerSubmissionRecords;
    try {
      record = decodeAnswerSubmissionRecords(capability);
    } catch {
      gaps.push(`composition ${id}: records capability does not satisfy its closed contract`);
      continue;
    }
    const model = item.model;
    const deployment = item.deployment;
    if (
      !model ||
      typeof model !== "object" ||
      Array.isArray(model) ||
      !deployment ||
      typeof deployment !== "object" ||
      Array.isArray(deployment) ||
      (model as Record<string, unknown>).resolvedId !== record.modelId ||
      (deployment as Record<string, unknown>).routeId !== record.routeId ||
      (deployment as Record<string, unknown>).identitySha256 !== record.deploymentIdentitySha256
    ) {
      gaps.push(`composition ${id}: records evidence identity differs from its owning composition`);
      continue;
    }
    const answerSubmission = item.answerSubmission;
    if (
      !answerSubmission ||
      typeof answerSubmission !== "object" ||
      Array.isArray(answerSubmission) ||
      (answerSubmission as Record<string, unknown>).evidenceSha256 !==
        record.answerSubmissionEvidenceSha256
    ) {
      gaps.push(
        `composition ${id}: records evidence digest differs from its answer submission capability`,
      );
      continue;
    }
    const probeDigest = record.evidenceSha256;
    const corpusDigest = record.corpusSha256;
    if (typeof probeDigest !== "string" || !/^[a-f0-9]{64}$/u.test(probeDigest)) {
      gaps.push(`composition ${id}: records capability has no valid probe evidence digest`);
      continue;
    }
    if (
      typeof corpusDigest !== "string" ||
      !/^[a-f0-9]{64}$/u.test(corpusDigest) ||
      corpusDigest !== ANSWER_RECORD_CORPUS_SHA256
    ) {
      gaps.push(`composition ${id}: records capability has no valid corpus digest`);
      continue;
    }
    let observation: Record<string, unknown>;
    try {
      const loaded = await readJson(
        resolve(evidenceRoot, "probe-observations", `${probeDigest}.json`),
      );
      if (hash(loaded.bytes) !== probeDigest) {
        throw new Error("The probe evidence bytes do not match their committed digest.");
      }
      observation = loaded.value;
    } catch {
      gaps.push(
        `composition ${id}: probe observation ${probeDigest} is missing or does not match its digest`,
      );
      continue;
    }
    let corpus: Record<string, unknown>;
    try {
      const corpusBytes = await readFile(resolve(evidenceRoot, "corpus.json"));
      if (
        hash(corpusBytes) !== ANSWER_RECORD_CORPUS_SHA256 ||
        observation.corpusSha256 !== ANSWER_RECORD_CORPUS_SHA256
      ) {
        throw new Error("The corpus evidence bytes do not match their committed digest.");
      }
      corpus = JSON.parse(corpusBytes.toString("utf8")) as Record<string, unknown>;
      if (corpus.schemaVersion !== 1 || corpus.kind !== ANSWER_RECORD_CORPUS_KIND) {
        throw new Error("The retained corpus does not match the committed corpus contract.");
      }
    } catch {
      gaps.push(`composition ${id}: committed answer-record corpus does not match ${corpusDigest}`);
      continue;
    }
    const deploymentBinding =
      observation.deploymentBinding && typeof observation.deploymentBinding === "object"
        ? (observation.deploymentBinding as Record<string, unknown>)
        : undefined;
    if (
      observation.kind !== "docsfab-answer-record-probe" ||
      observation.schemaVersion !== 2 ||
      observation.modelId !== record.modelId ||
      observation.shell !== record.argumentShell ||
      deploymentBinding?.status !== "bound" ||
      deploymentBinding.routeId !== record.routeId ||
      deploymentBinding.deploymentIdentitySha256 !== record.deploymentIdentitySha256 ||
      deploymentBinding.transport !== "openai-chat-completions"
    ) {
      gaps.push(`composition ${id}: probe identity differs from the sealed records capability`);
      continue;
    }

    if (observation.diagnosticOnly !== undefined) {
      gaps.push(
        `composition ${id}: diagnostic-only answer-record evidence cannot qualify or activate a records capability`,
      );
      continue;
    }

    const exactQualification = observation.exactQualification;
    if (exactQualification === undefined) {
      if (record.qualificationFingerprint !== undefined) {
        gaps.push(`composition ${id}: sealed qualification fingerprint has no retained exact plan`);
        continue;
      }
    } else {
      const requestPolicy = item.requestPolicy;
      const baseComposition = { ...item };
      delete baseComposition.answerSubmissionRecords;
      delete baseComposition.compositionSha256;
      const qualificationCompositionSha256 = canonicalDigest(baseComposition);
      const exactIsBound =
        isAnswerRecordExactQualificationEvidence(exactQualification) &&
        record.qualificationFingerprint === exactQualification.qualificationFingerprint &&
        exactQualification.compositionId === id &&
        exactQualification.compositionSha256 === qualificationCompositionSha256 &&
        exactQualification.modelId === record.modelId &&
        exactQualification.routeId === record.routeId &&
        exactQualification.transport === deploymentBinding.transport &&
        exactQualification.deploymentIdentitySha256 === record.deploymentIdentitySha256 &&
        exactQualification.corpusSha256 === record.corpusSha256 &&
        exactQualification.shell === record.argumentShell &&
        Boolean(
          requestPolicy &&
            typeof requestPolicy === "object" &&
            !Array.isArray(requestPolicy) &&
            (requestPolicy as Record<string, unknown>).policySha256 ===
              exactQualification.requestPolicySha256 &&
            (requestPolicy as Record<string, unknown>).installedSystemInstructionSha256 ===
              exactQualification.installedSystemInstructionCanonicalDigest,
        );
      const plannedCells = isAnswerRecordExactQualificationEvidence(exactQualification)
        ? exactQualification.cells
        : [];
      const observedCells = Array.isArray(observation.samples)
        ? observation.samples
            .filter(
              (sample): sample is Record<string, unknown> =>
                Boolean(sample) && typeof sample === "object",
            )
            .map((sample) => ({
              phase: sample.phase,
              rungBytes: sample.rungBytes,
              seed: sample.seed,
              plannedBytes: sample.plannedBytes,
              paddingChars: sample.paddingChars,
              estimatedInputTokens: sample.estimatedInputTokens,
              rawBytes: Array.isArray(sample.calls)
                ? sample.calls.map((call) =>
                    call && typeof call === "object"
                      ? (call as Record<string, unknown>).rawBytes
                      : null,
                  )
                : [],
            }))
        : [];
      const pinnedCells = plannedCells.map((cell) => ({
        phase: cell.phase,
        rungBytes: cell.rungBytes,
        seed: cell.seed,
        plannedBytes: cell.plannedBytes,
        paddingChars: cell.paddingChars,
        estimatedInputTokens: cell.estimatedInputTokens,
        rawBytes: cell.calls.map((call) => call.rawBytes),
      }));
      if (!exactIsBound || canonicalJson(observedCells) !== canonicalJson(pinnedCells)) {
        gaps.push(
          `composition ${id}: retained exact qualification plan does not bind this observation and composition`,
        );
        continue;
      }
      const exactSamples = Array.isArray(observation.samples)
        ? observation.samples.filter(
            (sample): sample is Record<string, unknown> =>
              Boolean(sample) && typeof sample === "object" && !Array.isArray(sample),
          )
        : [];
      const exactCopyValid =
        exactSamples.length === plannedCells.length &&
        plannedCells.every((cell) => {
          const matches = exactSamples.filter(
            (sample) =>
              sample.phase === cell.phase &&
              sample.rungBytes === cell.rungBytes &&
              sample.seed === cell.seed,
          );
          if (matches.length !== 1) return false;
          const sample = matches[0]!;
          const calls = Array.isArray(sample.calls)
            ? sample.calls.filter(
                (call): call is Record<string, unknown> =>
                  Boolean(call) && typeof call === "object" && !Array.isArray(call),
              )
            : [];
          if (sample.expectedCalls !== cell.calls.length || calls.length !== cell.calls.length) {
            return false;
          }
          if (sample.admitted === true) {
            return calls.every(
              (call) =>
                call.decode === "admitted" && call.piValidation === "ok" && call.deepEqual === true,
            );
          }
          if (cell.phase !== "C") return false;
          const rawBytes = calls.map((call) =>
            typeof call.rawBytes === "number" && Number.isSafeInteger(call.rawBytes)
              ? call.rawBytes
              : 0,
          );
          return (
            sample.failure === "length" &&
            rawBytes.length === cell.calls.length &&
            rawBytes.every((bytes) => bytes > (record.maxRecordBytes as number))
          );
        });
      if (!exactCopyValid) {
        gaps.push(
          `composition ${id}: retained exact qualification cells do not prove exact admitted copies and cardinality`,
        );
        continue;
      }
      const observedPlan =
        observation.plan && typeof observation.plan === "object" && !Array.isArray(observation.plan)
          ? (observation.plan as Record<string, unknown>)
          : undefined;
      if (observedPlan?.transportRetries !== 0) {
        gaps.push(`composition ${id}: exact qualification observation includes retry allowance`);
        continue;
      }
    }

    const typed = record.argumentShell === "typed";
    const phaseA = samplesFor(observation, typed ? "A-t" : "A");
    const expectedARungs = typed ? [2048, 4096, 8192] : [512, 2048, 4096, 8192];
    const bestA = admittedRung(
      phaseA,
      (sample) => {
        const calls = Array.isArray(sample.calls) ? sample.calls : [];
        return calls.reduce((largest, call) => Math.max(largest, rawBytes(call)), 0);
      },
      expectedARungs,
    );
    if (!bestA) {
      gaps.push(`composition ${id}: phase A has no largest three-seed admitted rung`);
    } else if (record.maxRecordBytes !== bestA.bytes) {
      gaps.push(`composition ${id}: maxRecordBytes does not match the phase-A admitted rung`);
    }

    const observationOutputTokens =
      typeof observation.maxOutputTokens === "number" &&
      Number.isSafeInteger(observation.maxOutputTokens) &&
      observation.maxOutputTokens > 0
        ? observation.maxOutputTokens
        : undefined;
    const budgetBytes =
      observationOutputTokens === undefined
        ? undefined
        : Math.floor(
            (observationOutputTokens *
              limit("inference.answerRecordAllowanceShareBasisPoints").value *
              limit("inference.answerRecordBytesPerTokenFloorMilli").value) /
              10_000_000,
          );
    const expectedBRungs =
      budgetBytes === undefined
        ? []
        : [...new Set([6144, 10_240, budgetBytes])]
            .filter((rung) => rung <= budgetBytes)
            .sort((left, right) => left - right);
    const bestB = admittedRung(
      samplesFor(observation, "B"),
      (sample) =>
        Array.isArray(sample.calls)
          ? sample.calls.reduce((sum, call) => sum + rawBytes(call), 0)
          : 0,
      expectedBRungs,
    );
    if (!bestB) {
      gaps.push(`composition ${id}: phase B lacks a three-seed admitted message rung`);
    } else {
      const measured = bestB.bytes;
      const minimumQualifiedMessageBytes = expectedBRungs[0];
      if (typeof minimumQualifiedMessageBytes !== "number") {
        gaps.push(`composition ${id}: phase B has no measured qualification floor`);
      } else if (record.minimumQualifiedMessageBytes !== minimumQualifiedMessageBytes) {
        gaps.push(
          `composition ${id}: minimumQualifiedMessageBytes differs from the lowest admitted phase-B rung`,
        );
      }
      if (record.phaseBMaxAdmittedMessageBytes !== measured) {
        gaps.push(`composition ${id}: phaseBMaxAdmittedMessageBytes differs from phase B`);
      }
    }

    const phaseC = samplesFor(observation, "C");
    if (phaseC.length !== 3 || new Set(phaseC.map((sample) => sample.seed)).size !== 3) {
      gaps.push(`composition ${id}: phase C does not contain three distinct retained samples`);
    } else {
      const observed = Math.max(
        ...phaseC.map((sample) => {
          const calls = Array.isArray(sample.calls) ? sample.calls : [];
          return Math.max(
            typeof sample.plannedBytes === "number" ? sample.plannedBytes : 0,
            ...calls.map(rawBytes),
          );
        }),
      );
      const allAdmitted = phaseC.every(
        (sample) => sample.admitted === true && sample.failure === null,
      );
      const onlyOversize = phaseC.every((sample) => {
        const calls = Array.isArray(sample.calls) ? sample.calls : [];
        const raw = Math.max(0, ...calls.map(rawBytes));
        return (
          sample.admitted === true ||
          ((sample.failure === "length" || sample.transportError === "byte-bound") &&
            raw > (record.maxRecordBytes as number))
        );
      });
      const expectedOutcome = allAdmitted
        ? "admitted"
        : onlyOversize
          ? "size-above-record-maximum"
          : null;
      if (
        expectedOutcome === null ||
        record.phaseCOutcome !== expectedOutcome ||
        record.phaseCSamples !== 3
      ) {
        gaps.push(
          `composition ${id}: phase C is not admitted 3/3 or exclusively size-limited above maxRecordBytes`,
        );
      }
      if (record.phaseCMaxObservedRecordBytes !== observed) {
        gaps.push(`composition ${id}: phaseCMaxObservedRecordBytes differs from retained phase C`);
      }
    }

    const records = Array.isArray(corpus.records) ? corpus.records : [];
    let fixtureRows: readonly AnswerSubmissionFixtureRowV1[] = [];
    try {
      fixtureRows = deriveAnswerSubmissionFixtureRows(records);
    } catch {
      gaps.push(`composition ${id}: committed answer-record corpus rows cannot be projected`);
      continue;
    }
    if (canonicalJson(record.fixtureRows) !== canonicalJson(fixtureRows)) {
      gaps.push(`composition ${id}: per-fixture row weights differ from the committed corpus`);
    }
    const groupBytes = new Map<string, Map<number, number>>();
    let largestCorpusRecordBytes = 0;
    for (const entry of records) {
      if (!entry || typeof entry !== "object") continue;
      const row = entry as Record<string, unknown>;
      if (
        typeof row.fixture !== "string" ||
        typeof row.group !== "number" ||
        typeof row.type !== "string" ||
        !Object.hasOwn(row, "record")
      ) {
        gaps.push(`composition ${id}: corpus contains a malformed group entry`);
        continue;
      }
      const envelope = {
        type: row.type,
        ...(typeof row.key === "string" ? { key: row.key } : {}),
        record: row.record,
      };
      const bytes = Buffer.byteLength(JSON.stringify(envelope), "utf8");
      largestCorpusRecordBytes = Math.max(largestCorpusRecordBytes, bytes);
      const groups = groupBytes.get(row.fixture) ?? new Map<number, number>();
      groups.set(row.group, (groups.get(row.group) ?? 0) + bytes);
      groupBytes.set(row.fixture, groups);
    }
    const groupMaxima = new Map<number, number>();
    let fullPlanEnvelopeBytes = 0;
    for (const groups of groupBytes.values()) {
      let fixtureBytes = 0;
      for (const [group, bytes] of groups) {
        fixtureBytes += bytes;
        groupMaxima.set(group, Math.max(groupMaxima.get(group) ?? 0, bytes));
      }
      fullPlanEnvelopeBytes = Math.max(fullPlanEnvelopeBytes, fixtureBytes);
    }
    const groupEnvelopeBytes = [...groupMaxima]
      .sort(([left], [right]) => left - right)
      .map(([group, maxBytes]) => ({ group, maxBytes }));
    if (canonicalJson(record.groupEnvelopeBytes) !== canonicalJson(groupEnvelopeBytes)) {
      gaps.push(`composition ${id}: per-group envelope maxima differ from the committed corpus`);
    }
    if (record.fullPlanEnvelopeBytes !== fullPlanEnvelopeBytes) {
      gaps.push(`composition ${id}: full-plan envelope bytes differ from the committed corpus`);
    }
    if (record.largestRecordEnvelopeBytes !== largestCorpusRecordBytes) {
      gaps.push(`composition ${id}: largest record envelope differs from the committed corpus`);
    }
    const requiredRecordBytes = Math.ceil(largestCorpusRecordBytes * 1.5);
    if (observation.requiredRecordBytes !== requiredRecordBytes) {
      gaps.push(
        `composition ${id}: probe requiredRecordBytes does not match canonical outer-envelope corpus bytes`,
      );
    }
    if (typeof record.maxRecordBytes !== "number" || record.maxRecordBytes < requiredRecordBytes) {
      gaps.push(
        `composition ${id}: phase-A record bound is below the corpus 1.5x outer-envelope requirement`,
      );
    }
    const compositionLimits =
      item.compositionLimits && typeof item.compositionLimits === "object"
        ? (item.compositionLimits as Record<string, unknown>)
        : {};
    let maxMessageBound: number | undefined;
    if (bestB && typeof compositionLimits.maxOutputTokens === "number") {
      try {
        maxMessageBound = deriveAnswerSubmissionRecordsMessageBudget({
          effectiveMaxOutputTokens: compositionLimits.maxOutputTokens,
          allowanceShareBasisPoints: limit("inference.answerRecordAllowanceShareBasisPoints").value,
          bytesPerTokenFloorMilli: limit("inference.answerRecordBytesPerTokenFloorMilli").value,
          qualifiedMessageBytes: bestB.bytes,
          minimumQualifiedMessageBytes: expectedBRungs[0]!,
          sealedMessageCeiling: limit("sealed.answerSubmission.maxMessageBytes").value,
        });
        if (maxMessageBound < expectedBRungs[0]!) {
          gaps.push(
            `composition ${id}: effective output allowance falls below the lowest qualified phase-B message rung`,
          );
        }
      } catch {
        gaps.push(
          `composition ${id}: effective output allowance cannot derive a safe message budget`,
        );
      }
    }
    if (bestB && record.maxMessageBytes !== maxMessageBound) {
      gaps.push(
        `composition ${id}: maxMessageBytes does not equal the measured/formula outer-envelope bound`,
      );
    }
    if (bestB && maxMessageBound !== undefined) {
      const messages = groupEnvelopeBytes.reduce(
        (sum, group) => sum + Math.ceil(group.maxBytes / maxMessageBound),
        0,
      );
      const step8TurnEvidence = record.step8TurnEvidence;
      const step8Samples =
        step8TurnEvidence &&
        typeof step8TurnEvidence === "object" &&
        !Array.isArray(step8TurnEvidence)
          ? (step8TurnEvidence as Record<string, unknown>).samples
          : undefined;
      const runtimeRows: Record<string, unknown>[] = Array.isArray(step8Samples)
        ? step8Samples
        : [];
      const p90 = (values: number[]): number | null => {
        if (values.length === 0) return null;
        const sorted = [...values].sort((left, right) => left - right);
        return sorted[Math.ceil(sorted.length * 0.9) - 1] ?? null;
      };
      const readingP90 = p90(runtimeRows.map((sample) => sample.readingTurns as number));
      const runtimeTurnP90 = p90(runtimeRows.map((sample) => sample.turnLatencyMs as number));
      const probePlan =
        observation.plan && typeof observation.plan === "object"
          ? (observation.plan as Record<string, unknown>)
          : {};
      const windowMinBasisPoints = probePlan.decodeWindowMinBasisPoints;
      const probeLturnSamples = bestB.samples.map((sample) => {
        const ttft = sample.ttftMs;
        const elapsed = sample.elapsedMs;
        const first = sample.firstArgumentDeltaMs;
        const last = sample.lastArgumentDeltaMs;
        const windowIsUsable =
          typeof windowMinBasisPoints === "number" &&
          typeof first === "number" &&
          typeof last === "number" &&
          last > first &&
          typeof sample.argumentBytes === "number" &&
          sample.argumentBytes > 0 &&
          typeof sample.argumentBytesAfterFirstDelta === "number" &&
          sample.argumentBytesAfterFirstDelta > 0 &&
          typeof elapsed === "number" &&
          (last - first) * 10_000 >= windowMinBasisPoints * elapsed;
        if (typeof ttft !== "number" || typeof elapsed !== "number") {
          return Number.NaN;
        }
        // Inclusive non-window elapsed retains measured call/prefill/tail
        // overhead. If no usable argument window exists, whole-call elapsed
        // is the conservative upper estimate (and can double-count decode).
        return windowIsUsable && typeof first === "number" && typeof last === "number"
          ? Math.max(ttft, elapsed - (last - first))
          : elapsed;
      });
      const probeLturnP90 =
        probeLturnSamples.length === 3 && probeLturnSamples.every(Number.isFinite)
          ? p90(probeLturnSamples)
          : null;
      const readingTurns = compositionLimits.maxProviderTurns;
      if (readingP90 === null || runtimeTurnP90 === null || probeLturnP90 === null) {
        gaps.push(
          `composition ${id}: timer and provider-turn fit lack retained step-8 or padded phase-B metrics`,
        );
      } else {
        if (runtimeTurnP90 < probeLturnP90) {
          gaps.push(
            `composition ${id}: archived duration-per-turn upper bound is below padded-probe Lturn`,
          );
        }
        if (record.lturnMs !== probeLturnP90) {
          gaps.push(
            `composition ${id}: sealed Lturn differs from the padded phase-B probe measurement`,
          );
        }
        if (record.readingTurnsP90 !== readingP90) {
          gaps.push(
            `composition ${id}: sealed p90 reading-turn count differs from retained attempts`,
          );
        }
        if (typeof readingTurns !== "number" || readingP90 + 2 * messages + 1 > readingTurns) {
          gaps.push(
            `composition ${id}: §4.4 p90 reading-turn fit fails for the canonical outer-envelope message count`,
          );
        }
        const rated = bestB.samples.flatMap((sample) => {
          if (
            typeof sample.httpStatus !== "number" ||
            typeof sample.outputTokens !== "number" ||
            typeof sample.elapsedMs !== "number" ||
            typeof sample.argumentBytes !== "number" ||
            typeof sample.argumentBytesAfterFirstDelta !== "number" ||
            typeof windowMinBasisPoints !== "number"
          )
            return [];
          const first =
            typeof sample.firstArgumentDeltaMs === "number" ? sample.firstArgumentDeltaMs : null;
          const last =
            typeof sample.lastArgumentDeltaMs === "number" ? sample.lastArgumentDeltaMs : null;
          const rate = sampleDecodeRate(
            {
              httpStatus: sample.httpStatus,
              outputTokens: sample.outputTokens,
              elapsedMs: sample.elapsedMs,
              firstArgumentDeltaMs: first,
              lastArgumentDeltaMs: last,
              argumentBytes: sample.argumentBytes,
              argumentBytesAfterFirstDelta: sample.argumentBytesAfterFirstDelta,
            },
            windowMinBasisPoints,
          );
          return rate ? [rate] : [];
        });
        const rateSources = new Set(rated.map((rate) => rate.source));
        const streamRates = rated.filter((rate) => rate.source === "stream-window");
        if (rated.length !== 3 || rateSources.size !== 1) {
          gaps.push(
            `composition ${id}: all three phase-B samples must provide one consistent decode-rate source`,
          );
        }
        const selectedRates = rated.map((rate) => rate.tokensPerSecond);
        const sortedRates = [...selectedRates].sort((left, right) => left - right);
        const middle = Math.floor(sortedRates.length / 2);
        const derivedDecodeRate =
          sortedRates.length !== 3 || rateSources.size !== 1 ? null : sortedRates[middle]!;
        const decodeRate =
          derivedDecodeRate === null ? null : Math.round(derivedDecodeRate * 10) / 10;
        const derivedRateSource = streamRates.length === 3 ? "stream-window" : "end-to-end";
        if (
          decodeRate !== record.decodeTokensPerSecond ||
          derivedRateSource !== record.decodeRateSource
        ) {
          gaps.push(
            `composition ${id}: sealed decode rate/source differs from the pinned phase-B observation`,
          );
        }
        const projectedTokens =
          step8TurnEvidence && typeof step8TurnEvidence === "object"
            ? (step8TurnEvidence as Record<string, unknown>).projectedReportTokens
            : undefined;
        const outputTokens = compositionLimits.maxOutputTokens;
        if (
          typeof decodeRate !== "number" ||
          typeof projectedTokens !== "number" ||
          typeof outputTokens !== "number" ||
          decodeRate <= 0
        ) {
          gaps.push(
            `composition ${id}: Dfull lacks qualified decode-rate or output projection inputs`,
          );
        } else {
          const compositionTimeoutMs = compositionLimits.timeoutMs;
          const fit = deriveAnswerSubmissionRecordsFit({
            groupEnvelopeBytes,
            maxMessageBytes: maxMessageBound,
            minimumQualifiedMessageBytes: record.minimumQualifiedMessageBytes,
            fullPlanEnvelopeBytes,
            largestRecordEnvelopeBytes: largestCorpusRecordBytes,
            bytesPerTokenFloorMilli: limit("inference.answerRecordBytesPerTokenFloorMilli").value,
            decodeTokensPerSecond: decodeRate,
            projectedReportTokens: projectedTokens,
            lturnMs: probeLturnP90,
            d3ResidualFires: runtimeRows.some((sample) => sample.d3ResidualFires === true)
              ? true
              : runtimeRows.length > 0 &&
                  runtimeRows.every((sample) => sample.d3ResidualFires === false)
                ? false
                : "unknown",
            readingTurnsP90: readingP90,
            maxProviderTurns: readingTurns as number,
            effectiveTimeoutMs: compositionTimeoutMs as number,
            timerReviewLimitMs: limit("sealed.answerSubmission.maxPredictedTimerMs").value,
            answerNowElapsedShareBasisPoints: limit(
              "compositionExecution.answerNowElapsedShareBasisPoints",
            ).value,
          });
          const predictedTimerMs = fit.predictedTimerMs;
          const timerReviewLimit = limit("sealed.answerSubmission.maxPredictedTimerMs").value;
          if (predictedTimerMs > timerReviewLimit || !fit.withinReviewThreshold) {
            gaps.push(
              `composition ${id}: predicted timer ${predictedTimerMs}ms exceeds the accepted review threshold ${timerReviewLimit}ms`,
            );
          }
          if (!fit.fitsRecordBoundary || !fit.fitsEffectiveTimer) {
            gaps.push(
              `composition ${id}: sealed timer does not fit the measured T* ${predictedTimerMs}ms`,
            );
          }
        }
      }
    }

    const turn = record.step8TurnEvidence;
    const revisionDigest = (revision: string) => hash(Buffer.from(revision, "utf8"));
    if (!Array.isArray(turn.samples) || turn.samples.length === 0) {
      gaps.push(`composition ${id}: retained step-8 run selectors are missing`);
      continue;
    }
    for (const sample of turn.samples) {
      try {
        const digest = sample.runEvidenceSha256;
        const source = await readJson(resolve(evidenceRoot, "step8-runs", `${digest}.json`));
        if (hash(source.bytes) !== digest) {
          throw new Error("The retained run bytes do not match their committed digest.");
        }
        const parsed = parseJsonEvidence(source.bytes);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("The retained run must contain one decoded object value.");
        }
        const runId = (parsed as Record<string, unknown>).id;
        if (typeof runId !== "string") {
          throw new Error("The retained run must identify its own durable record.");
        }
        const run = decodeSavedRunRecord(parsed, runId);
        if (run.answerRecordContinuation !== undefined) {
          throw new Error("A continuation child cannot qualify as fresh step-8 evidence.");
        }
        const execution = run.compositionExecution;
        if (
          run.workflow !== "review-documentation" ||
          !execution ||
          execution.runId !== run.id ||
          execution.workflow.id !== "review-documentation" ||
          execution.compositionId !== sample.compositionId ||
          execution.model.resolvedId !== sample.modelId ||
          execution.deployment.routeId !== sample.routeId ||
          execution.deployment.identitySha256 !== sample.deploymentIdentitySha256 ||
          record.modelId !== sample.modelId ||
          record.routeId !== sample.routeId ||
          record.deploymentIdentitySha256 !== sample.deploymentIdentitySha256 ||
          revisionDigest(run.repository.revision) !== turn.targetRevisionSha256
        ) {
          throw new Error("The retained run binding differs from the sealed composition identity.");
        }
        const step = run.steps.find((entry) => entry.id === sample.stepId);
        if (step?.inheritedFrom !== undefined) {
          throw new Error("An inherited evaluator step cannot qualify as fresh step-8 evidence.");
        }
        const attempts = step?.inference?.attempts ?? [];
        const attempt = attempts.find((entry) => entry.attempt === sample.attempt);
        if (
          !step ||
          step.id !== "evaluate-document-quality" ||
          step.skill !== "evaluate-document-quality" ||
          !attempt ||
          !attempt.turns ||
          attempt.turns.length === 0
        ) {
          throw new Error("The selected attempt has no exact retained turn evidence.");
        }
        const turns = attempt.turns;
        const providerTurns = turns.filter((entry) => entry.decision !== "stop").length;
        if (providerTurns === 0) {
          throw new Error("The selected attempt contains no sent provider turns.");
        }
        if (
          attempt.usage?.turns !== providerTurns ||
          attempt.executionLease?.providerTurns !== providerTurns
        ) {
          throw new Error("The attempt usage and lease counts do not corroborate provider turns.");
        }
        const stepToolRows = step.tools?.byTool ?? [];
        const stepToolCalls = stepToolRows.reduce((sum, entry) => sum + entry.calls, 0);
        const attemptToolCalls = (entry: (typeof attempts)[number]): number => {
          const summary = entry.tools;
          if (!summary || !Number.isSafeInteger(summary.totalCalls) || summary.totalCalls < 0) {
            throw new Error("The attempt tool-call total is absent or invalid.");
          }
          const byTool = summary.byTool.reduce((sum, tool) => sum + tool.calls, 0);
          if (byTool !== summary.totalCalls)
            throw new Error("The attempt tool summary does not reconcile with its total.");
          return summary.totalCalls;
        };
        const allAttemptToolCalls = attempts.reduce(
          (sum, entry) => sum + attemptToolCalls(entry),
          0,
        );
        const aggregateAttemptTools = new Map<string, number>();
        for (const entry of attempts) {
          for (const tool of entry.tools?.byTool ?? []) {
            aggregateAttemptTools.set(
              tool.name,
              (aggregateAttemptTools.get(tool.name) ?? 0) + tool.calls,
            );
          }
        }
        if (
          stepToolCalls !== allAttemptToolCalls ||
          aggregateAttemptTools.size !== stepToolRows.length ||
          stepToolRows.some((tool) => aggregateAttemptTools.get(tool.name) !== tool.calls)
        ) {
          throw new Error("The step tool summary does not reconcile with its attempt totals.");
        }
        const recordCalls =
          attempt.tools?.byTool
            .filter((tool) => tool.name === QUALITY_ANSWER_RECORD_TOOL_NAME)
            .reduce((sum, tool) => sum + tool.calls, 0) ?? 0;
        const attemptCalls = attemptToolCalls(attempt);
        const scoped = attempt.executionLease?.toolCallsByScope;
        if (
          attempt.answerSubmission?.path === "tool-call" ||
          recordCalls !== 0 ||
          (scoped !== undefined && (scoped.answerRecord !== 0 || scoped.reading !== attemptCalls))
        ) {
          throw new Error("The selected attempt cannot prove its tools used reading scope.");
        }
        const firstCumulative = turns[0]!.toolCalls;
        let positiveResponseDeltas = 0;
        for (let index = 1; index < turns.length; index += 1) {
          const delta = turns[index]!.toolCalls - turns[index - 1]!.toolCalls;
          if (!Number.isSafeInteger(delta) || delta < 0) {
            throw new Error("The cumulative turn tool-call counter decreased or became invalid.");
          }
          if (delta > 0 && turns[index - 1]!.decision === "stop") {
            throw new Error("An unsent stopped turn cannot own a tool-call response delta.");
          }
          if (delta > 0) positiveResponseDeltas += 1;
        }
        const observedNewCalls = turns.at(-1)!.toolCalls - firstCumulative;
        const finalResponseResidual = attemptCalls - observedNewCalls;
        if (!Number.isSafeInteger(finalResponseResidual) || finalResponseResidual < 0) {
          throw new Error("Cumulative turn counters exceed the selected attempt tool-call total.");
        }
        const readingTurns = positiveResponseDeltas + (finalResponseResidual > 0 ? 1 : 0);
        if (readingTurns > turns.length) {
          throw new Error(
            "The projected reading-turn count exceeds available sent provider turns.",
          );
        }
        const turnLatencyMs = attempt.durationMs / providerTurns;
        if (
          sample.providerTurns !== providerTurns ||
          sample.readingTurns !== readingTurns ||
          sample.recordCalls !== recordCalls ||
          sample.turnLatencyMs !== turnLatencyMs ||
          sample.d3ResidualFires !== "unknown"
        ) {
          throw new Error("The sealed timing or D3 projection differs from its selected attempt.");
        }
      } catch {
        gaps.push(
          `composition ${id}: step-8 run ${sample.runEvidenceSha256} is missing, mismatched, or cannot prove its selected-attempt projections`,
        );
      }
    }
  }
  return gaps;
}
