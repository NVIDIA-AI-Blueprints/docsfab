// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The `docsfab why` answer shape, shared by the command's `--json` envelope
 * and the DIAGNOSIS block of a failed run. Every value is an identifier, a
 * closed code, a count, or a sentence DocsFab wrote; model prose, error
 * messages, and credentials never enter it.
 *
 * Schema version 1 is append-only: a new field is optional or nullable, and
 * a new owner class or cause is a new enum member, never a renamed one.
 * Other surfaces import the owner classes and cause mapping from here.
 */

export const WHY_REPORT_SCHEMA_VERSION = 1 as const;
export const WHY_REPORT_KIND = "docsfab-why" as const;

/** Limit names diagnosis enforces; values live only in `config/limits/diagnosis.yaml`. */
export const DIAGNOSIS_LIMITS = Object.freeze({
  maxRuns: "diagnosis.maxRuns",
  recurrenceLookbackRuns: "diagnosis.recurrenceLookbackRuns",
} as const);

/** Whose problem a failure is, in the order the answer lists them. */
export const DIAGNOSIS_OWNER_CLASSES = Object.freeze([
  "provider-capacity",
  "output-limit",
  "contract-shape",
  "model-content",
  "operator-configuration",
  "docsfab-defect",
  "model-progress",
  "repository-check",
  "unattributed-search",
] as const);

export type DiagnosisOwnerClass = (typeof DIAGNOSIS_OWNER_CLASSES)[number];

/** One sentence per owner class: who acts, never what one run did. */
export const DIAGNOSIS_OWNER_MEANINGS: Readonly<Record<DiagnosisOwnerClass, string>> =
  Object.freeze({
    "provider-capacity":
      "The provider could not serve the request for now: overload, rate limit, outage, or a stream failure. Waiting and rerunning can clear it.",
    "output-limit": "The reply reached the output allowance the request was sent with.",
    "contract-shape":
      "The reply did not match the step's contract shape: it was not JSON, or its JSON had the wrong structure.",
    "model-content":
      "The reply was well formed, but its content broke a host rule the step enforces.",
    "operator-configuration":
      "The configured endpoint, credential, model, or request settings kept the request from being served, including a model the provider has retired. Rerunning unchanged cannot clear it.",
    "docsfab-defect":
      "DocsFab failed on its own side, or recorded a code its failure catalog does not classify.",
    "model-progress":
      "The model kept calling tools without finishing the step: it re-read results it already had, used the step's whole tool-call or turn ceiling, or ran into its attempt timer before it answered. A rerun can loop the same way.",
    "repository-check":
      "A repository-required check failed on the candidate. Available evidence alone does not establish whether the baseline, candidate, or environment caused it.",
    "unattributed-search":
      "The saved search evidence does not identify whether the checkout, a host dependency, or DocsFab caused the stop.",
  });

/** Human label for an owner class. */
export const DIAGNOSIS_OWNER_LABELS: Readonly<Record<DiagnosisOwnerClass, string>> = Object.freeze({
  "provider-capacity": "provider capacity",
  "output-limit": "output limit",
  "contract-shape": "contract shape",
  "model-content": "model content",
  "operator-configuration": "operator configuration",
  "docsfab-defect": "DocsFab defect",
  "model-progress": "model progress",
  "repository-check": "repository check",
  "unattributed-search": "search cause unresolved",
});

/** The closed cause vocabulary; each cause belongs to exactly one owner class. */
export const DIAGNOSIS_CAUSE_OWNERS = Object.freeze({
  "provider-rate-limited": "provider-capacity",
  "provider-server-error": "provider-capacity",
  "provider-stream-error": "provider-capacity",
  "provider-stream-incomplete": "provider-capacity",
  "provider-timeout": "provider-capacity",
  "attempt-deadline-awaiting-provider": "provider-capacity",
  "provider-unavailable": "provider-capacity",
  "output-allowance-reached": "output-limit",
  "reply-cut-over-allowance": "output-limit",
  "reply-continued-over-allowance": "output-limit",
  "reply-not-json": "contract-shape",
  "reply-shape-rejected": "contract-shape",
  "reply-content-rejected": "model-content",
  "reply-blank": "model-content",
  "provider-content-filter": "model-content",
  "provider-model-retired": "operator-configuration",
  "provider-auth-refused": "operator-configuration",
  "provider-request-refused": "operator-configuration",
  "provider-endpoint-unreachable": "operator-configuration",
  "request-not-sent": "operator-configuration",
  "context-window-exhausted": "operator-configuration",
  "operator-input-refused": "operator-configuration",
  "operational-limit-reached": "operator-configuration",
  "host-dependency-unavailable": "operator-configuration",
  "host-runtime-failure": "docsfab-defect",
  "run-cancelled": "operator-configuration",
  "boundary-refusal": "docsfab-defect",
  "request-policy-refused": "docsfab-defect",
  "installed-policy-unverified": "operator-configuration",
  "host-built-value-refused": "docsfab-defect",
  "uncatalogued-failure": "docsfab-defect",
  "read-loop-stopped": "model-progress",
  "execution-ceiling-reached": "model-progress",
  "attempt-deadline-in-tool-loop": "model-progress",
  "execution-ceiling-configured": "operator-configuration",
  "required-check-failed": "repository-check",
  "search-cause-unresolved": "unattributed-search",
} as const satisfies Record<string, DiagnosisOwnerClass>);

export type DiagnosisCause = keyof typeof DIAGNOSIS_CAUSE_OWNERS;

/** The index fields a finding was read from; `null` is a value the record did not carry. */
export interface DiagnosisEvidenceV1 {
  readonly rowKind: "run" | "step" | "attempt";
  readonly provider: string | null;
  readonly model: string | null;
  readonly outcome: string;
  readonly failureClass: string | null;
  readonly failureLayer: string | null;
  readonly rejectionSource: string | null;
  readonly rejectionCode: string | null;
  readonly rejectionLocation: string | null;
  readonly rejectedReplyParseCode: string | null;
  readonly finishReason: string | null;
  readonly outputTokens: number | null;
  readonly outputAllowance: number | null;
  readonly providerErrorClass: string | null;
  readonly httpStatus: number | null;
  /** An error status declared inside a 2xx stream, when the index carries it. */
  readonly streamErrorStatus: number | null;
  readonly conditionRetryability: string | null;
  readonly retryDecision: string | null;
  /**
   * Whole-attempt output figures from the attempt's index row: its
   * `attemptOutputTokens`, `outputAllowance`, and `continuations`. `null` when
   * the row carries none of them, such as a row an earlier DocsFab indexed.
   */
  readonly attemptTotals: {
    readonly outputTokens: number | null;
    readonly allowance: number | null;
    readonly continuations: number | null;
  } | null;
  /**
   * What the attempt's refused rule refused, from its index row: the cited
   * source path, or the declared and observed changed paths (JSON arrays), or
   * why the record names no path. `null` when the row records none.
   * Nullable, so schema version 1 still holds.
   */
  readonly rejectionSubject: {
    readonly sourcePath: string | null;
    readonly declaredChangedPaths: string | null;
    readonly observedChangedPaths: string | null;
    readonly withheld: string | null;
  } | null;
  /**
   * Content-free answer-record ledger progress from the committed checkpoint
   * owned by this physical attempt. Counts belong to the logical lineage named
   * here. `complete` is the ledger's direct terminal state, not report validation.
   */
  readonly answerRecordProgress: {
    readonly admittedRowCount: number;
    readonly releasedRowCount: number;
    readonly remainingKeyCount: number;
    readonly refusalEventCount: number;
    readonly complete: boolean;
    readonly checkpointSequence: number;
    readonly logicalRunId: string;
    readonly sourceRunId: string;
    readonly sourceAttemptHighWater: number;
  } | null;
}

/** A second owner the same evidence supports, with its own next action. */
export interface DiagnosisAlsoCauseV1 {
  readonly ownerClass: DiagnosisOwnerClass;
  readonly cause: DiagnosisCause;
  readonly why: string;
  readonly nextAction: string;
  readonly nextCommand: string | null;
}

/** How often the same step failed with the same signature for the same provider and model. */
export interface DiagnosisRecurrenceV1 {
  /** Runs in the window with a row matching the finding's signature at its step. */
  readonly runs: number;
  /** Runs in the window for this provider and model, including this one. */
  readonly ofRuns: number;
  /** `diagnosis.recurrenceLookbackRuns` as resolved. */
  readonly lookbackRuns: number;
  /** True when the index holds older runs for this provider and model than the window. */
  readonly clipped: boolean;
  readonly firstSeen: {
    readonly runId: string;
    readonly runCreatedAt: string;
    /** DocsFab revision the run was indexed with; `null` when the index does not carry one. */
    readonly docsfabRevision: string | null;
  } | null;
  /** `docsfab runs query` counting the matching runs in the window. */
  readonly query: string;
  /** `docsfab runs query` counting every run in the window, the denominator. */
  readonly denominatorQuery: string;
}

export interface DiagnosisFindingV1 {
  /** `terminal` ends a failed step or run; `contributing` is an earlier or recovered failure. */
  readonly role: "terminal" | "contributing";
  readonly stepId: string | null;
  readonly stepIndex: number | null;
  /** Attempt numbers of the rows this finding covers, in order; empty for step and run rows. */
  readonly attempts: readonly number[];
  /** Recorded attempts at this step. */
  readonly stepAttempts: number;
  /**
   * For a contributing finding: whether its step later succeeded, or a later
   * attempt of the step succeeded before the step ended on its own cause.
   */
  readonly recovered: boolean | null;
  /** Whether the recorded step itself succeeded, distinct from a later attempt succeeding. */
  readonly stepSucceeded?: boolean | null;
  readonly ownerClass: DiagnosisOwnerClass;
  readonly cause: DiagnosisCause;
  readonly what: string;
  readonly why: string;
  readonly nextAction: string;
  /** A DocsFab command that performs or checks the next action, when one exists. */
  readonly nextCommand: string | null;
  readonly evidence: DiagnosisEvidenceV1;
  /** The index clauses that define this finding's signature, as `--where` pairs. */
  readonly signature: Readonly<Record<string, string>>;
  /** `docsfab runs query` that prints the rows this finding was read from. */
  readonly reproduce: string;
  readonly recurrence: DiagnosisRecurrenceV1 | null;
  /** A second owner the evidence supports or cannot rule out; act on both. */
  readonly alsoCause: DiagnosisAlsoCauseV1 | null;
  /** Why a field the finding would use is unavailable, as closed codes. */
  readonly limitations: readonly string[];
}

/** A legitimate recorded gate, separate from a failure finding and its owner. */
export interface DiagnosisStopV1 {
  readonly status: "needs-input" | "needs-human-decision";
  /** Present only when one coherent terminal step supports the run status. */
  readonly stepId: string | null;
  readonly stepIndex: number | null;
  /** A verified no-step request-intent question, or unknown. */
  readonly admission: "question" | "unknown";
  readonly explanation: string;
  readonly nextAction: string;
  /** Read-only inspection at a known saved-run location; null for index-only selection. */
  readonly nextCommand: string | null;
  readonly limitations: readonly (
    | "stop-detail-unavailable"
    | "stop-step-unavailable"
    | "stop-step-ambiguous"
    | "stop-step-inconsistent"
    | "stop-admission-unavailable"
    | "stop-saved-location-unavailable"
  )[];
}

export interface RunDiagnosisV1 {
  readonly runId: string;
  readonly workflow: string;
  readonly runStatus: string;
  readonly runCreatedAt: string;
  readonly batchId: string | null;
  readonly caseKey: string | null;
  readonly docsfabRevision: string | null;
  readonly provider: string | null;
  readonly model: string | null;
  /** Failed runs carry a terminal failure; legitimate stops can have no failure finding. */
  readonly verdict: "failed" | "incomplete" | "succeeded";
  readonly summary: string;
  /** Terminal findings first, in step order; then contributing findings. */
  readonly findings: readonly DiagnosisFindingV1[];
  /** Additive schema-v1 field; older diagnosis objects can omit it. */
  readonly stop?: DiagnosisStopV1 | null;
  /** `docsfab why` for this run, with the same index location. */
  readonly whyCommand: string;
  /** `docsfab runs show` for this run's saved record. */
  readonly showCommand: string;
  /** Where the rows came from: the run index, or the saved record projected in memory. */
  readonly source: "run-index" | "record";
  /**
   * Why the host converted the run's CREATE plan into an UPDATE of the one
   * page that already existed, from the run row; `null` when it did not, or
   * when the row predates the field. Nullable, so schema version 1 still holds.
   */
  readonly planConversion:
    | import("../workflow-execution/plan-binding.js").CreateConversionReason
    | null;
  /**
   * How many technical dimensions of the run's sealed source-obligation
   * ledger kept source evidence (`cited`, `partial`, or `none`), from the run
   * row; `null` when the run has no such ledger or the row predates the field.
   */
  readonly sourceEvidence: "cited" | "partial" | "none" | null;
  /** How many ledger dimensions are unverified; `null` with `sourceEvidence`. */
  readonly unverifiedDimensions: number | null;
  /** Host-projected product disposition for source readiness, or unavailable. */
  readonly readinessDisposition:
    | import("../records/run-index.js").RunIndexReadinessDisposition
    | null;
  /** Canonical JSON array of closed readiness criterion/reason codes, or unavailable. */
  readonly readinessReasonCodes: string | null;
  /** Validated CREATE source-proposal outcomes; reasons remain in the saved run record only. */
  readonly sourceProposalOutcomes?: readonly SourceProposalOutcomeV1[] | null;
  /** Whether revision 19 refused to copy the whole projection; null on older rows. */
  readonly sourceProposalOutcomesOmitted?: boolean | null;
}

export interface SourceProposalOutcomeV1 {
  readonly attempt: number;
  readonly path: string;
  readonly status: "admitted" | "refused";
  readonly refusalCode?: import("../workflow-execution/source-obligation-authority.js").SourceAuthorityProposalRefusalCodeV1;
}

export interface WhyModelCauseV1 {
  readonly ownerClass: DiagnosisOwnerClass;
  readonly cause: DiagnosisCause;
  readonly role: "terminal" | "contributing";
  readonly runs: number;
  readonly steps: readonly string[];
}

export interface WhyModelSummaryV1 {
  readonly provider: string | null;
  readonly model: string | null;
  readonly runs: number;
  readonly failedRuns: number;
  readonly causes: readonly WhyModelCauseV1[];
}

export interface WhyReportV1 {
  readonly schemaVersion: typeof WHY_REPORT_SCHEMA_VERSION;
  readonly kind: typeof WHY_REPORT_KIND;
  readonly index: {
    readonly path: string;
    readonly exists: boolean;
    readonly storedRows: number;
    readonly supersededRows: number;
    readonly unreadableLines: number;
    readonly incompleteSnapshots: number;
    /** Snapshots the run store could not index, from the index overflow file. */
    readonly refusedSnapshots: number;
    /** The state directory whose saved records were read; `null` with `--index-dir`. */
    readonly stateDirectory: string | null;
  };
  readonly selection: {
    readonly mode: "run" | "last" | "all" | "batch";
    readonly runId: string | null;
    readonly batchId: string | null;
    readonly model: string | null;
  };
  readonly runs: {
    readonly matched: number;
    readonly diagnosed: number;
    readonly clipped: boolean;
    readonly limit: { readonly name: string; readonly value: number };
  };
  readonly diagnoses: readonly RunDiagnosisV1[];
  readonly byModel: readonly WhyModelSummaryV1[];
  /** Answer-level gaps, such as a run diagnosed from its record because the index lacked it. */
  readonly limitations: readonly string[];
}
