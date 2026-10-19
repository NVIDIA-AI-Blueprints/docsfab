// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { INFERENCE_RETRY_DECISION_TOKENS } from "../../operator/retry-disposition.js";
import { REQUEST_INTENT_ADMISSION_OUTCOMES } from "../../request-intent/interpret-record.js";
import { REQUEST_INTENT_TARGET_ORIGINS } from "../../request-intent/contract.js";
import type { JsonEvidenceErrorCode, JsonEvidenceSyntaxDetail } from "../../json-evidence.js";
import { RUN_RECORD_MAX_BYTES_LIMIT } from "../run-record-limit.js";
import type {
  InferenceAnswerPath,
  InferenceAnswerPathReason,
  InferenceAnswerReportTurnState,
  InferenceAnswerSubmissionState,
  InferenceConcludeNowTrigger,
  LegacyHostPathMatchRoot,
  LegacyHostPathSourceReading,
} from "../contracts.js";
import type { InferenceAnswerMemberEncodingColumn } from "../answer-submission-evidence.js";
import type { FailureClass, FailureLayer } from "../../operator/failure-class.js";
import type { InferenceRetryDecisionToken } from "../../operator/retry-disposition.js";
import type { RequestIntentAdmissionOutcome } from "../../request-intent/interpret-record.js";
import type {
  RequestIntentOperation,
  RequestIntentTargetOrigin,
} from "../../request-intent/contract.js";
import type { RejectionSubjectWithheld } from "../../execution/rejection-subject.js";
import type { CreateConversionReason } from "../../workflow-execution/plan-binding.js";
import type { StepExecutionCeilingSource } from "../../config/execution-ceiling-source.js";
import type { ModelFinishReason, ProviderErrorClass } from "../model-telemetry.js";

export const RUN_INDEX_ROW_SCHEMA_VERSION = 1 as const;
export const RUN_INDEX_ROW_KIND = "docsfab-run-index-row" as const;

/**
 * Which projection wrote a row. Bump it whenever the projection copies more,
 * so `docsfab runs import` re-projects older snapshots. A row without the
 * field reads as revision 1.
 *
 * - 2: `rejectedReplyParseCode` and `quality-validation` step rows.
 * - 3: model telemetry with normalized `finishReason`; closed `failureClass`
 *   and `failureLayer`.
 * - 4: `hostPathRoot` and `hostPathInAdmittedSource`.
 * - 5: `verifierDisagreementCount` on run rows.
 * - 6: model fields on run rows, from the record's `models`.
 * - 7: `rejectedReplyExcerpt` on attempt rows.
 * - 8: `failureCode`, `terminalStepId`, step rows for a step that ended after
 *   its final attempt succeeded, the attempt output totals, and
 *   `retryDecisionRule`.
 * - 9: `planConversion` on run rows.
 * - 10: `sourceEvidence` and `unverifiedDimensions` on run rows.
 * - 11: the read-loop counters on attempt rows (`unchangedReReads`,
 *   `readLoopWithheld`, `maxRepeatsOfOneResult`,
 *   `maxUnchangedReReadsAcrossResults`), and `executionCeilingSource`.
 * - 12: the final quality evaluator's answer path on attempt rows
 *   (`answerPath`, `answerPathReason`, `answerSubmission`,
 *   `answerReportTurn`).
 * - 13: `planConversion` reason `planner-proposed-update`; the attempt's
 *   rejection subject (`rejectedSourcePath`, `declaredChangedPaths`,
 *   `observedChangedPaths`, `rejectionSubjectWithheld`) on attempt rows.
 * - 14: `answerMemberEncoding` on attempt rows: how an admitted submission's
 *   members arrived, `<evaluation>/<qualityScore>`.
 * - 15: the request interpretation on run rows (`intentAdmission`,
 *   `intentOperation`, `intentTargetSource`).
 * - 16: `concludeNow` on attempt rows: why the host asked for the answer
 *   before the model finished reading.
 * - 17: `readinessDisposition` and `readinessReasonCodes` on readiness run rows.
 * - 18: checkpoint-bound records progress on the physical attempt that
 *   committed the checkpoint.
 * - 19: content-free source-proposal outcomes on run rows.
 */
export const RUN_INDEX_PROJECTION_REVISION = 19 as const;

/** First revision whose run rows carry `terminalStepId` and `failureCode`. */
export const RUN_INDEX_RUN_END_REVISION = 8;

/**
 * First revision whose `failureClass` and `finishReason` hold closed
 * vocabularies; earlier rows read them as `null` rather than mix vocabularies.
 */
export const CLOSED_VOCABULARY_REVISION = 3;

/**
 * Limit names this index enforces; values live only in `config/limits.yaml`.
 * A record is bounded by the one run-record limit every reader shares.
 */
export const RUN_INDEX_LIMITS = Object.freeze({
  indexMaxBytes: "runs.indexMaxBytes",
  recordMaxBytes: RUN_RECORD_MAX_BYTES_LIMIT,
  importMaxRecords: "runs.indexImportMaxRecords",
  fieldMaxChars: "runs.indexFieldMaxChars",
} as const);

export const RUN_INDEX_ROW_KINDS = Object.freeze(["run", "step", "attempt"] as const);
export type RunIndexRowKind = (typeof RUN_INDEX_ROW_KINDS)[number];

export type RunIndexOrigin = "run-store" | "import";

/**
 * Which evidence supplied `rejectionCode` and `rejectionLocation`: the
 * attempt's `rejection` on `attempt` rows, or the step's
 * `qualityValidationRejection` on `step` rows.
 */
export type RunIndexRejectionSource = "inference-attempt" | "quality-validation";

/** Step statuses that end a run; the first such step is the run's `terminalStepId`. */
export const TERMINAL_STEP_STATUSES: readonly unknown[] = Object.freeze([
  "failed",
  "needs-input",
  "needs-human-decision",
]);

/**
 * `retryDecisionRule` values a row can hold: the operator reading of each
 * decision, without its `unavailable`, which a row stores as `null`.
 */
export const RUN_INDEX_RETRY_DECISION_RULES = Object.freeze(
  INFERENCE_RETRY_DECISION_TOKENS.filter((token) => token !== "unavailable"),
) as readonly Exclude<InferenceRetryDecisionToken, "unavailable">[];
export type RunIndexRetryDecisionRule = (typeof RUN_INDEX_RETRY_DECISION_RULES)[number];

/** `rejectedReplyParseCode` for a rejected reply the strict parser read. */
export const RUN_INDEX_REPLY_PARSED = "parsed";

/**
 * `rejectedReplyExcerpt` on an attempt row: whether the record keeps reply text
 * (`retained`), kept an excerpt whose every segment the credential screen
 * withheld (`withheld`), or kept one with no segment because the bound is 0 or
 * the reply was empty (`empty`). The text itself stays in the run record.
 */
export const RUN_INDEX_REPLY_EXCERPT_READINGS = Object.freeze([
  "retained",
  "withheld",
  "empty",
] as const);
export type RunIndexReplyExcerptReading = (typeof RUN_INDEX_REPLY_EXCERPT_READINGS)[number];

/**
 * The one `intentAdmission` value that differs from the recorded outcome: a
 * query reads a null field as `unavailable`, so the model-unavailable outcome
 * is stored under this name to stay apart from a run without the field.
 */
export const RUN_INDEX_INTENT_MODEL_UNAVAILABLE = "model-unavailable";

/**
 * `intentAdmission` on a run row: how the request interpretation ended, with
 * the one rename above, or `unverified` for a field that does not decode or
 * whose sealed intent does not verify against the record's instruction.
 */
export const RUN_INDEX_INTENT_ADMISSIONS = Object.freeze([
  ...REQUEST_INTENT_ADMISSION_OUTCOMES.map((outcome) =>
    outcome === "unavailable" ? RUN_INDEX_INTENT_MODEL_UNAVAILABLE : outcome,
  ),
  "unverified",
] as const) as readonly RunIndexIntentAdmission[];
export type RunIndexIntentAdmission =
  | Exclude<RequestIntentAdmissionOutcome, "unavailable">
  | typeof RUN_INDEX_INTENT_MODEL_UNAVAILABLE
  | "unverified";

/**
 * `intentTargetSource` on a run row: the one `chosenFrom` every write-role
 * target of an admitted intent shares, `mixed` when they differ, or `none`
 * when the intent has no write target.
 */
export const RUN_INDEX_INTENT_TARGET_SOURCES = Object.freeze([
  ...REQUEST_INTENT_TARGET_ORIGINS,
  "mixed",
  "none",
] as const);
export type RunIndexIntentTargetSource = RequestIntentTargetOrigin | "mixed" | "none";

/**
 * The strict parser's closed refusal vocabulary for `rejectedReplyParseCode`.
 * Keyed by the parser's unions, so a new code does not typecheck until listed.
 */
export const REPLY_PARSE_ERROR_CODES: Readonly<Record<JsonEvidenceErrorCode, true>> = Object.freeze(
  {
    "invalid-utf8": true,
    "malformed-json": true,
    "duplicate-key": true,
    "unsafe-number": true,
    "noncanonical-json": true,
  },
);
export const REPLY_PARSE_SYNTAX_DETAILS: Readonly<Record<JsonEvidenceSyntaxDetail, true>> =
  Object.freeze({
    "unexpected-end": true,
    "unexpected-token": true,
    "invalid-escape": true,
    "unescaped-control": true,
    "unpaired-surrogate": true,
  });

export interface RunIndexRowV1 {
  readonly schemaVersion: typeof RUN_INDEX_ROW_SCHEMA_VERSION;
  readonly kind: typeof RUN_INDEX_ROW_KIND;
  readonly projectionRevision: number;
  /**
   * Attempt rows only: the classifier that derived `failureClass` and
   * `failureLayer`. A reader with a different classifier reads both as `null`
   * and `docsfab runs import` re-projects. Null on `run` and `step` rows,
   * whose classes are recorded rather than derived.
   */
  readonly attemptClassifierSha256: string | null;
  readonly rowKind: RunIndexRowKind;
  /** One append of one record snapshot. The newest snapshot per run wins. */
  readonly snapshotId: string;
  /** Rows in this snapshot; a query drops a snapshot with fewer rows present. */
  readonly snapshotRows: number;
  readonly indexedAt: string;
  readonly origin: RunIndexOrigin;
  readonly runId: string;
  /** SHA-256 of the exact record bytes this row was projected from. */
  readonly recordSha256: string;
  /** Harness `report.json` `batchId` when imported from one. */
  readonly batchId: string | null;
  readonly caseKey: string | null;
  /**
   * The DocsFab build that saved the record, on rows the run store wrote, or
   * the revision the importer declared. `-dirty` marks a build whose checkout
   * differed from its commit. Records do not carry it.
   */
  readonly docsfabRevision: string | null;
  readonly workflow: string;
  readonly runStatus: string;
  readonly runCreatedAt: string;
  readonly runStartedAt: string | null;
  readonly runCompletedAt: string | null;
  /** Revision of the documentation repository the run targeted. */
  readonly repositoryRevision: string | null;
  readonly qualityPackManifestSha256: string | null;
  /** Null on the `run` row. */
  readonly stepIndex: number | null;
  readonly stepId: string | null;
  readonly stepKind: string | null;
  readonly stepStatus: string | null;
  readonly stepStartedAt: string | null;
  readonly stepCompletedAt: string | null;
  readonly skillId: string | null;
  readonly skillSha256: string | null;
  readonly attempt: number | null;
  /** True on the step's last recorded attempt, or on its only row. */
  readonly finalAttempt: boolean;
  /** Attempt outcome, the status of a step without attempts, or the run status. */
  readonly outcome: string;
  /**
   * The record's own `failure` on `run` and `step` rows. Attempts record no
   * class, so on `attempt` rows it is `classifyInferenceAttempt`'s reading,
   * null for a succeeded attempt; the failure category stays in `outcome`.
   */
  readonly failureClass: FailureClass | null;
  readonly failureLayer: FailureLayer | null;
  /** The code beside `failureClass`, from the same source. */
  readonly failureCode: string | null;
  /**
   * Run rows only: the first step that ended failed or waiting for input, on a
   * run that did not succeed. Null when the run failed after its steps. The
   * run's `failureCode` is the run's recorded cause, which can be a different
   * step's code than this step's own.
   */
  readonly terminalStepId: string | null;
  readonly rejectionSource: RunIndexRejectionSource | null;
  readonly rejectionCode: string | null;
  readonly rejectionLocation: string | null;
  /**
   * Attempt rows only: `parsed`, or the strict parser's refusal as
   * `json-<detail>` when it named a syntax detail and `json-<code>` otherwise.
   */
  readonly rejectedReplyParseCode: string | null;
  /** Attempt rows only: whether the record keeps a reply excerpt; never its text. */
  readonly rejectedReplyExcerpt: RunIndexReplyExcerptReading | null;
  /**
   * Attempt rows only, from revision 13: the source path a refused citation
   * named, recorded only when the host knew it (a plan write path or a tracked
   * file at the run's revision); `null` otherwise.
   */
  readonly rejectedSourcePath: string | null;
  /**
   * Attempt rows only, from revision 13: the pages a refused revision writer
   * declared changed, and the pages the host observed it change, each as a
   * JSON array of plan write paths (`[]` for none); `null` when not recorded.
   */
  readonly declaredChangedPaths: string | null;
  readonly observedChangedPaths: string | null;
  /** Attempt rows only, from revision 13: why a recorded rejection subject names no path. */
  readonly rejectionSubjectWithheld: RejectionSubjectWithheld | null;
  /**
   * Attempt rows only: the matched root segment or form name of a
   * `host-path-disclosure` refusal an older host recorded. Never the path, and
   * `null` for every current attempt.
   */
  readonly hostPathRoot: LegacyHostPathMatchRoot | null;
  /** Attempt rows only: whether that older refused token occurred in admitted source. */
  readonly hostPathInAdmittedSource: LegacyHostPathSourceReading | null;
  readonly conditionRetryability: string | null;
  readonly retryDecision: string | null;
  /**
   * Attempt rows only: the rule behind `retryDecision`, as `docsfab runs show`
   * reads it, such as `declined-host-refusal`. Null when the record does not
   * carry a readable decision.
   */
  readonly retryDecisionRule: RunIndexRetryDecisionRule | null;
  /**
   * The model fields. On a `run` row each is the value every model in the
   * record's `models` shares, or the distinct values sorted and joined with
   * `RUN_INDEX_MODEL_SEPARATOR` when they differ.
   */
  readonly provider: string | null;
  readonly model: string | null;
  readonly apiFormat: string | null;
  readonly modelProfileSha256: string | null;
  /** Attempt rows only: how the last landed turn finished, from `modelTelemetry`. */
  readonly finishReason: ModelFinishReason | null;
  /** Attempt rows only: the provider error class that ended the attempt. */
  readonly providerErrorClass: ProviderErrorClass | null;
  /** Attempt rows only: the HTTP status of that provider error's response. */
  readonly httpStatus: number | null;
  /** Attempt rows only: output tokens the last landed turn produced. */
  readonly outputTokens: number | null;
  /** Attempt rows only: the per-request output allowance that turn was sent with. */
  readonly outputAllowance: number | null;
  /** Attempt rows only: milliseconds spent waiting on the provider, summed over turns. */
  readonly providerLatencyMs: number | null;
  /** Attempt rows only: output tokens the whole attempt produced, over every turn. */
  readonly attemptOutputTokens: number | null;
  /**
   * Attempt rows only: turns cut at the output limit that the host continued
   * with another turn that issued no tool call, so the cut answer went on.
   */
  readonly continuations: number | null;
  /**
   * Attempt rows only: how the first turn of the attempt's final answer
   * finished: `length` when that answer was cut and continued, otherwise
   * `finishReason`.
   */
  readonly firstFinishReason: ModelFinishReason | null;
  /**
   * Attempt rows only: output tokens of the final answer's turns, the cut
   * turns and the turn that finished it, as the turn ledger records them
   * (including discarded in-turn replay output).
   */
  readonly answerOutputTokens: number | null;
  readonly durationMs: number | null;
  readonly backoffMs: number | null;
  /**
   * Run rows only (#1439): disagreement rows summed over the record's
   * provisional/canonical technical verification pairs. `0` means every
   * pair the record retains was compared and agreed; `null` means the sum is
   * not known (a workflow without the pair, a record written before the
   * field existed, any pair whose comparison was `unavailable`, or a refused
   * field, which is also named in `omittedFields`), and on every other row
   * kind.
   */
  readonly verifierDisagreementCount: number | null;
  /**
   * Run rows only: why the host converted the CREATE plan's one
   * existing page into an UPDATE of it, as a closed reason:
   * `create-target-exists` (the planner planned a CREATE of it) or, from
   * revision 13, `planner-proposed-update` (the planner proposed the UPDATE);
   * `null` when nothing was converted, on a record indexed before revision 9,
   * and on every other row kind. The page path stays in the record
   * (`docsfab runs show`).
   */
  readonly planConversion: CreateConversionReason | null;
  /**
   * Run rows only: how many technical dimensions of the sealed
   * source-obligation ledger kept source evidence. `cited` when none is
   * unverified, `partial` when some are, and `none` when every one is, so a
   * review that ran on no admitted source never reads as a clean run. `null`
   * for a run without a succeeded source-obligation step, a record indexed
   * before revision 10, a ledger the host cannot validate (also named in
   * `omittedFields`), and every other row kind.
   */
  readonly sourceEvidence: RunIndexSourceEvidence | null;
  /**
   * Run rows only: how many ledger dimensions are unverified, whoever made
   * them so; `null` exactly when `sourceEvidence` is.
   */
  readonly unverifiedDimensions: number | null;
  /**
   * Attempt rows only: the attempt's read-loop counters from
   * `tools.readEvidence`, so a read-loop stop can be measured and explained
   * from the index. `null` when the attempt re-read nothing unchanged, on a
   * record indexed before revision 11, and on every other row kind.
   * `maxUnchangedReReadsAcrossResults` is also `null` on a record written
   * before the cross-result bound; it is never derived.
   */
  readonly unchangedReReads: number | null;
  readonly readLoopWithheld: number | null;
  readonly maxRepeatsOfOneResult: number | null;
  readonly maxUnchangedReReadsAcrossResults: number | null;
  /**
   * Attempt rows only, from revision 16: the trigger of the attempt's
   * `concludeNow` record, when the host withdrew the tools and asked for the
   * answer before the model finished reading (`read-loop`, `reading-budget`,
   * or `attempt-deadline`). `null` when it did not ask, on a record indexed
   * before revision 16, and on every other row kind.
   */
  readonly concludeNow: InferenceConcludeNowTrigger | null;
  /**
   * What set the execution ceiling the row's `failureCode` names: the
   * composition's sealed budget, a host limit at its catalog value, or an
   * operator override below it (`stepExecutionCeilingSource`). Read from the
   * stopped attempt's turn and lease evidence; on a run row, from its terminal
   * step's final attempt. `null` when the code names no execution ceiling and
   * on a record indexed before revision 11.
   */
  readonly executionCeilingSource: StepExecutionCeilingSource | null;
  /**
   * Attempt rows only: the final quality evaluator's answer path
   * (`text-final` or `tool-call`), why it took it, and on the tool path how
   * far the submission and the report got, copied from the attempt's
   * `answerSubmission`. `null` on every other step, on a record indexed before
   * revision 12, and on run and step rows.
   */
  readonly answerPath: InferenceAnswerPath | null;
  readonly answerPathReason: InferenceAnswerPathReason | null;
  readonly answerSubmission: InferenceAnswerSubmissionState | null;
  readonly answerReportTurn: InferenceAnswerReportTurnState | null;
  /**
   * Attempt rows only: how an admitted tool-path submission's members
   * arrived, `<evaluation>/<qualityScore>` (for example `string/string` when
   * the serving stack sent both as JSON strings). `null` when no submission
   * was admitted, and on a record indexed before revision 14.
   */
  readonly answerMemberEncoding: InferenceAnswerMemberEncodingColumn | null;
  /** Attempt rows only, from revision 17: committed answer-record lineage progress. */
  readonly answerRecordAdmittedRowCount: number | null;
  readonly answerRecordReleasedRowCount: number | null;
  readonly answerRecordRemainingKeyCount: number | null;
  readonly answerRecordRefusalEventCount: number | null;
  /** Direct ledger completion state; it does not mean report validation succeeded. */
  readonly answerRecordComplete: boolean | null;
  readonly answerRecordCheckpointSequence: number | null;
  readonly answerRecordLogicalRunId: string | null;
  readonly answerRecordSourceRunId: string | null;
  readonly answerRecordSourceAttemptHighWater: number | null;
  /**
   * Run rows only, from revision 15: how the record's request interpretation
   * ended (`RUN_INDEX_INTENT_ADMISSIONS`); `null` when the record has no
   * `requestIntent`, and on every other row kind.
   */
  readonly intentAdmission: RunIndexIntentAdmission | null;
  /**
   * Run rows only: the operation and the write targets' origin of an
   * `admitted` intent, the reading the run followed. `null` for every other
   * outcome, an advisory reading included, since the run went on with its
   * declared workflow instead.
   */
  readonly intentOperation: RequestIntentOperation | null;
  readonly intentTargetSource: RunIndexIntentTargetSource | null;
  /** Run rows for source readiness only: host-projected product disposition. */
  readonly readinessDisposition: RunIndexReadinessDisposition | null;
  /** Run rows for source readiness only: JSON array of criterion/reason codes. */
  readonly readinessReasonCodes: string | null;
  /** Run rows only: canonical JSON of validated source proposal outcome tuples. */
  readonly sourceProposalOutcomes: string | null;
  /** Fields whose recorded value was refused rather than copied. */
  readonly omittedFields: readonly string[];
}

/**
 * Fields a query may filter or group by. Wall-clock timings, snapshot digests,
 * and bookkeeping are excluded on purpose. Telemetry counts are included so
 * `unavailable` selects attempts that recorded none.
 */
export const RUN_INDEX_QUERY_FIELDS = Object.freeze([
  "rowKind",
  "runId",
  "origin",
  "batchId",
  "caseKey",
  "docsfabRevision",
  "workflow",
  "runStatus",
  "repositoryRevision",
  "qualityPackManifestSha256",
  "stepId",
  "stepKind",
  "stepStatus",
  "skillId",
  "skillSha256",
  "attempt",
  "finalAttempt",
  "outcome",
  "failureClass",
  "failureLayer",
  "failureCode",
  "terminalStepId",
  "rejectionSource",
  "rejectionCode",
  "rejectionLocation",
  "rejectedReplyParseCode",
  "rejectedReplyExcerpt",
  "rejectedSourcePath",
  "declaredChangedPaths",
  "observedChangedPaths",
  "rejectionSubjectWithheld",
  "hostPathRoot",
  "hostPathInAdmittedSource",
  "conditionRetryability",
  "retryDecision",
  "retryDecisionRule",
  "provider",
  "model",
  "apiFormat",
  "modelProfileSha256",
  "finishReason",
  "providerErrorClass",
  "httpStatus",
  "outputTokens",
  "outputAllowance",
  "providerLatencyMs",
  "attemptOutputTokens",
  "continuations",
  "firstFinishReason",
  "answerOutputTokens",
  "verifierDisagreementCount",
  "planConversion",
  "sourceEvidence",
  "unverifiedDimensions",
  "unchangedReReads",
  "readLoopWithheld",
  "maxRepeatsOfOneResult",
  "maxUnchangedReReadsAcrossResults",
  "concludeNow",
  "executionCeilingSource",
  "answerPath",
  "answerPathReason",
  "answerSubmission",
  "answerReportTurn",
  "answerMemberEncoding",
  "answerRecordAdmittedRowCount",
  "answerRecordReleasedRowCount",
  "answerRecordRemainingKeyCount",
  "answerRecordRefusalEventCount",
  "answerRecordComplete",
  "answerRecordCheckpointSequence",
  "answerRecordLogicalRunId",
  "answerRecordSourceRunId",
  "answerRecordSourceAttemptHighWater",
  "intentAdmission",
  "intentOperation",
  "intentTargetSource",
  "readinessDisposition",
  "readinessReasonCodes",
] as const);

export type RunIndexQueryField = (typeof RUN_INDEX_QUERY_FIELDS)[number];

export function isRunIndexQueryField(value: string): value is RunIndexQueryField {
  return (RUN_INDEX_QUERY_FIELDS as readonly string[]).includes(value);
}

/** Record statuses after which the run store appends the snapshot to the index. */
export const RUN_INDEX_TERMINAL_STATUSES = Object.freeze([
  "succeeded",
  "failed",
  "needs-input",
  "needs-human-decision",
] as const);

export function isRunIndexTerminalStatus(status: unknown): boolean {
  return (
    typeof status === "string" &&
    (RUN_INDEX_TERMINAL_STATUSES as readonly string[]).includes(status)
  );
}

const BUILD_COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

/**
 * The `docsfabRevision` the run store writes: a stamped build's commit, with
 * `-dirty` when its checkout differed from it, or null for an unstamped build.
 */
export function docsfabBuildRevision(identity: unknown): string | null {
  if (!isObject(identity) || typeof identity.commit !== "string") return null;
  if (!BUILD_COMMIT.test(identity.commit) || typeof identity.dirty !== "boolean") return null;
  return identity.dirty ? `${identity.commit}-dirty` : identity.commit;
}

/**
 * The build revision a snapshot projected again from a record keeps: one the
 * importer declares, else the earlier snapshot's when the record bytes are
 * unchanged, else none. Rebuilding an index never drops the revision the run
 * store recorded, and never claims it for bytes it did not index.
 */
export function carriedDocsfabRevision(
  declared: string | null,
  previous: Pick<RunIndexRowV1, "recordSha256" | "docsfabRevision"> | undefined,
  recordSha256: string,
): string | null {
  return declared ?? (previous?.recordSha256 === recordSha256 ? previous.docsfabRevision : null);
}

export interface RunIndexSnapshotContext {
  readonly origin: RunIndexOrigin;
  readonly snapshotId: string;
  readonly indexedAt: string;
  readonly recordSha256: string;
  readonly fieldMaxChars: number;
  readonly batchId?: string | null;
  readonly caseKey?: string | null;
  readonly docsfabRevision?: string | null;
}

export type RunIndexProjection =
  | {
      readonly ok: true;
      readonly runId: string;
      readonly rows: readonly RunIndexRowV1[];
    }
  | { readonly ok: false; readonly reason: RunIndexRecordRefusal };

/** Why a parsed value could not be indexed as a run record. */
export type RunIndexRecordRefusal =
  | "not-a-run-record"
  | "unsupported-schema"
  | "unsafe-run-id"
  | "missing-run-identity";

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Project one parsed run record into index rows. The input is untrusted and
 * may predate current contracts, so every field is read defensively and
 * nothing is inferred.
 */
export const RUN_INDEX_SOURCE_EVIDENCE = Object.freeze(["cited", "partial", "none"] as const);
export type RunIndexSourceEvidence = (typeof RUN_INDEX_SOURCE_EVIDENCE)[number];

export const RUN_INDEX_READINESS_DISPOSITIONS = Object.freeze([
  "ready",
  "not-ready",
  "needs-input",
  "inconclusive",
  "blocked",
] as const);
export type RunIndexReadinessDisposition = (typeof RUN_INDEX_READINESS_DISPOSITIONS)[number];

export const RUN_INDEX_READINESS_CRITERIA = Object.freeze([
  "source-completeness",
  "source-usability",
] as const);
export const RUN_INDEX_READINESS_REASON_CODES = Object.freeze([
  "access-denied",
  "hard-ceiling",
  "incomplete-search",
  "index-incomplete",
  "model-assessed-unassessed",
  "scope-excluded",
  "timeout",
  "tool-failure",
  "unsupported-operation",
  "evidence-unavailable",
] as const);

/** Joins a run row's distinct model values when the run used more than one. */
export const RUN_INDEX_MODEL_SEPARATOR = "+";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
