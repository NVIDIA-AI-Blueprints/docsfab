// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The record a run saves when first pass found repository sources that
 * disagree, and the one question it asks. The host builds the question from
 * the sides it verified; no model text but the obligation's condition reaches
 * it, and no value it could not find in its span.
 *
 * A stop saves its own record here, as the request interpretation stop does,
 * so `runs show`, NEXT and `--json` read the question from the record.
 */
import { randomUUID } from "node:crypto";

import type { DocsFabConfig } from "../../config/runtime-loader.js";
import { classifyingRunStore } from "../../operator/failure-classification.js";
import type { RunRecord } from "../../records/contracts.js";
import { FileRunStore } from "../../records/file-store.js";
import { FirstPassChoiceClaimStore } from "../../records/first-pass-choice-store.js";
import { runRecordMaxBytes } from "../../records/run-record-limit.js";
import { createIndexedFileRunStore } from "../../records/run-index-store.js";
import { firstPassContradictionAdmission } from "../../records/first-pass-contradiction-admission.js";
import type { FirstPassReplayV1 } from "../../records/first-pass-replay.js";
import type { RepositoryWorkspace } from "../../repository/workspace/contracts.js";
import { escapeUndisplayable } from "../../shared/display-text.js";
import { emptyTools, emptyUsage } from "../../workflow-execution/runner-step.js";
import type {
  FirstPassContradictionSideV1,
  FirstPassContradictionV1,
} from "../first-pass-support.js";
import type { RunRequestWithPublishProjection } from "./request.js";

export const RUN_RECORD_FIRST_PASS_CONTRADICTION_SCHEMA_VERSION = 1;

/** The stop code the record and its `error` field carry. */
export const FIRST_PASS_CONTRADICTION_STOP_CODE = "contradicted";

/** One decision-shaped question, in the request-intent question's four fields. */
export interface FirstPassContradictionQuestionV1 {
  readonly question: string;
  readonly options: readonly string[];
  readonly recommendedDefault: string;
  readonly consequence: string;
}

/** The run-record field of a run first pass stopped on disagreeing sources. */
export interface RunRecordFirstPassContradictionV1 {
  readonly schemaVersion: typeof RUN_RECORD_FIRST_PASS_CONTRADICTION_SCHEMA_VERSION;
  readonly code: typeof FIRST_PASS_CONTRADICTION_STOP_CODE;
  readonly contradictions: readonly FirstPassContradictionV1[];
  readonly question: FirstPassContradictionQuestionV1;
}

/** The recommended default: never pick a side the operator has not chosen. */
const WITHHOLD = "Withhold the disputed section until the sources agree";

/** The question sentence 5 of the label-not-block decision always asks. */
const OUTSIDE_EVIDENCE =
  "Do you know of anything outside what I can see (a PR, a release branch, a design doc, a ticket) that settles this?";

function lines(side: FirstPassContradictionSideV1): string {
  return side.lineStart === side.lineEnd
    ? `line ${String(side.lineStart)}`
    : `lines ${String(side.lineStart)}-${String(side.lineEnd)}`;
}

function located(side: FirstPassContradictionSideV1): string {
  return `\`${side.path}\` ${lines(side)}`;
}

// Repository and model text reaches a terminal line, so control, format and
// separator code points are written as escapes, never raw.
function describe(contradiction: FirstPassContradictionV1): string {
  const { sides } = contradiction;
  const condition = escapeUndisplayable(contradiction.condition);
  if (sides.length === 0) {
    return `For "${condition}", the sources disagree, and the assessment cited no source lines.`;
  }
  if (sides.every((side) => side.value !== null)) {
    return `For "${condition}", ${sides.map((side) => `${located(side)} has "${escapeUndisplayable(side.value!)}"`).join("; ")}.`;
  }
  return `For "${condition}", ${sides.map(located).join(" and ")} disagree; the disputed value could not be confirmed in each.`;
}

function option(
  contradiction: FirstPassContradictionV1,
  side: FirstPassContradictionSideV1,
  prefix: boolean,
): string {
  const text =
    side.value === null
      ? `Use what ${located(side)} states`
      : `Use "${escapeUndisplayable(side.value)}" from ${located(side)}`;
  return prefix ? `${contradiction.obligationId}: ${text}` : text;
}

/**
 * The one question for every contradiction of a stop: each disagreement with
 * its paths, lines and verified values, one option per side, and the
 * recommended default to withhold. Its length follows from bounded parts.
 */
export function firstPassContradictionQuestion(
  contradictions: readonly FirstPassContradictionV1[],
): FirstPassContradictionQuestionV1 {
  const several = contradictions.length > 1;
  const targets = [...new Set(contradictions.flatMap((item) => item.targetPaths))].sort();
  return {
    question: [
      several
        ? `The repository sources disagree on ${String(contradictions.length)} points, and DocsFab does not pick a side.`
        : "The repository sources disagree, and DocsFab does not pick a side.",
      ...contradictions.map(describe),
      "Which source is right?",
      OUTSIDE_EVIDENCE,
    ].join(" "),
    options: [
      ...contradictions.flatMap((item) => item.sides.map((side) => option(item, side, several))),
      WITHHOLD,
    ],
    recommendedDefault: WITHHOLD,
    consequence: `DocsFab writes ${targets.map((path) => `\`${path}\``).join(", ")} without the disputed ${several ? "values" : "value"} and names the disagreement, so neither source becomes product truth.`,
  };
}

/** The record field for a stop's contradictions. */
export function firstPassContradictionRecord(
  contradictions: readonly FirstPassContradictionV1[],
): RunRecordFirstPassContradictionV1 {
  return {
    schemaVersion: RUN_RECORD_FIRST_PASS_CONTRADICTION_SCHEMA_VERSION,
    code: FIRST_PASS_CONTRADICTION_STOP_CODE,
    contradictions,
    question: firstPassContradictionQuestion(contradictions),
  };
}

export class RunRecordFirstPassContradictionError extends Error {
  public readonly code = "first-pass-contradiction-record-invalid";

  public constructor() {
    super("The recorded first-pass contradiction does not have the shape DocsFab writes.");
    this.name = "RunRecordFirstPassContradictionError";
  }
}

function invalid(): never {
  throw new RunRecordFirstPassContradictionError();
}

function exactKeys(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    invalid();
  }
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) invalid();
  return value;
}

function texts(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) invalid();
  return value.map(text);
}

function lineNumber(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) invalid();
  return value as number;
}

/**
 * Decode the recorded field and require its question to be the one the host
 * builds from its contradictions, so a hand-edited question never reaches NEXT.
 */
export function decodeRunRecordFirstPassContradiction(
  value: unknown,
): RunRecordFirstPassContradictionV1 {
  const root = exactKeys(value, ["schemaVersion", "code", "contradictions", "question"]);
  if (
    root.schemaVersion !== RUN_RECORD_FIRST_PASS_CONTRADICTION_SCHEMA_VERSION ||
    root.code !== FIRST_PASS_CONTRADICTION_STOP_CODE ||
    !Array.isArray(root.contradictions) ||
    root.contradictions.length === 0
  ) {
    invalid();
  }
  const contradictions = root.contradictions.map((entry): FirstPassContradictionV1 => {
    const item = exactKeys(entry, ["obligationId", "targetPaths", "condition", "sides"]);
    if (!Array.isArray(item.sides)) invalid();
    return {
      obligationId: text(item.obligationId),
      targetPaths: texts(item.targetPaths),
      condition: text(item.condition),
      sides: item.sides.map((raw): FirstPassContradictionSideV1 => {
        const side = exactKeys(raw, ["path", "lineStart", "lineEnd", "value"]);
        const lineStart = lineNumber(side.lineStart);
        const lineEnd = lineNumber(side.lineEnd);
        if (lineEnd < lineStart) invalid();
        return {
          path: text(side.path),
          lineStart,
          lineEnd,
          value: side.value === null ? null : text(side.value),
        };
      }),
    };
  });
  const question = exactKeys(root.question, [
    "question",
    "options",
    "recommendedDefault",
    "consequence",
  ]);
  const expected = firstPassContradictionQuestion(contradictions);
  if (
    question.question !== expected.question ||
    question.recommendedDefault !== expected.recommendedDefault ||
    question.consequence !== expected.consequence ||
    !Array.isArray(question.options) ||
    question.options.length !== expected.options.length ||
    question.options.some((entry, index) => entry !== expected.options[index])
  ) {
    invalid();
  }
  return {
    schemaVersion: RUN_RECORD_FIRST_PASS_CONTRADICTION_SCHEMA_VERSION,
    code: FIRST_PASS_CONTRADICTION_STOP_CODE,
    contradictions,
    question: expected,
  };
}

/**
 * The FIRST PASS section `runs show` and the run footer print for a record
 * carrying the field: each disagreement with its sides, then the question.
 * Empty without the field; a field that does not decode is named, not shown.
 */
export function formatFirstPassContradictionLines(record: {
  readonly firstPassContradiction?: unknown;
}): string[] {
  if (record.firstPassContradiction === undefined) return [];
  let field: RunRecordFirstPassContradictionV1;
  try {
    field = decodeRunRecordFirstPassContradiction(record.firstPassContradiction);
  } catch (error) {
    if (!(error instanceof RunRecordFirstPassContradictionError)) throw error;
    return [`Stop: unverified (${error.code})`];
  }
  return [
    `Stop: ${field.code}`,
    ...field.contradictions.flatMap((item) => [
      `Disagreement: ${item.obligationId} · ${item.targetPaths.join(", ")}`,
      ...item.sides.map(
        (side) =>
          `Side: ${side.path} ${lines(side)} · ${side.value === null ? "value not confirmed" : `"${escapeUndisplayable(side.value)}"`}`,
      ),
    ]),
    `Question: ${field.question.question}`,
    `Options: ${field.question.options.join(" | ")}`,
    `Recommended: ${field.question.recommendedDefault}`,
    `If you take it: ${field.question.consequence}`,
  ];
}

/**
 * Save the `needs-input` record of a run first pass stopped on disagreeing
 * sources, before its first step. It keeps the request interpretation the
 * run already recorded, and first pass's notices.
 */
export async function persistFirstPassContradictionStop(input: {
  readonly request: RunRequestWithPublishProjection;
  /** Before the host minted lineage for this first-pass run. */
  readonly admissionRequest?: RunRequestWithPublishProjection;
  readonly config: DocsFabConfig;
  readonly workspace: RepositoryWorkspace;
  readonly contradictions: readonly FirstPassContradictionV1[];
  readonly replay?: FirstPassReplayV1;
  /** Coded first-pass notices, each a line the record can keep. */
  readonly notices?: readonly string[];
}): Promise<RunRecord> {
  const now = new Date().toISOString();
  const runId = input.request.runId ?? randomUUID();
  const contradiction = firstPassContradictionRecord(input.contradictions);
  const admission = firstPassContradictionAdmission({
    ...(input.admissionRequest ?? input.request),
    runId,
    repositoryRevision: input.workspace.revision,
    instruction: input.request.instruction ?? "",
    contradiction,
  });
  const record: RunRecord = {
    schemaVersion: 2,
    id: runId,
    workflow: input.request.workflow,
    repository: {
      sourcePath: input.workspace.sourcePath,
      requestedRevision: input.workspace.requestedRevision,
      revision: input.workspace.revision,
    },
    workspace: { strategy: "tracked-export", disposable: true },
    ...(input.request.instruction ? { instruction: input.request.instruction } : {}),
    ...(input.request.instructionContext
      ? { instructionContext: input.request.instructionContext }
      : {}),
    status: "needs-input",
    error: FIRST_PASS_CONTRADICTION_STOP_CODE,
    createdAt: now,
    completedAt: now,
    models: [],
    skills: [],
    usage: emptyUsage(),
    tools: emptyTools(),
    ...(input.request.requestIntent ? { requestIntent: input.request.requestIntent } : {}),
    ...(input.notices?.length ? { evidenceWarnings: [...new Set(input.notices)] } : {}),
    firstPassContradiction: contradiction,
    ...(input.replay && admission.outcome === "repository-only"
      ? { firstPassReplay: input.replay }
      : {}),
    ...(input.request.firstPassChoices?.length
      ? { firstPassChoices: [...input.request.firstPassChoices] }
      : {}),
    firstPassContradictionAdmission: admission,
    steps: [],
  };
  await classifyingRunStore(createIndexedFileRunStore(input.config.stateDirectory)).save(record);
  if (record.firstPassReplay) {
    const saved = await new FileRunStore(input.config.stateDirectory).getWithDigest(runId, {
      maxBytes: runRecordMaxBytes().value,
    });
    await new FirstPassChoiceClaimStore(input.config.stateDirectory).sealReplay(
      runId,
      record.firstPassReplay.replaySha256,
      saved.sha256,
    );
  }
  return record;
}
