// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Public presentation inputs shared by ordered summary and focused projections. */
import type { RunRecord } from "../../records/contracts.js";
import type { WorkflowTaskInput } from "../../workflow-contracts/contracts.js";
import type { RepositoryDiscoveryInventoryV1 } from "../../repository/inventory.js";
import type { WorkflowOutcomeDecodeOptionsV1 } from "../../workflow-contracts/outcome.js";
import type { ProjectedReviewFindingsV1 } from "../../review/index.js";
import type { ReviewEvidenceProjectionV1 } from "../review-evidence.js";
import type { RunLimitOverflowEvidenceV1 } from "../run-limit-overflow.js";
import type { RunResultPublicationV1 } from "../run-result.js";
import type { RunRetainedDeliveryV1 } from "../../records/retained-delivery.js";
import type { RunDiagnosisV1 } from "../../diagnosis/contracts.js";
import type { RunResumabilityProjectionV1 } from "../run-resumability.js";
import type { RunHumanNextCommand } from "../run-next-action.js";
import type { DeliveryValidationFailureEvidence } from "../../delivery/contracts.js";

/**
 * do/run publication plane outcome. A saved-run replay never sets it, which
 * formats the same as `not-requested`; replay reports the run delivery index
 * through `deliveryLookup` instead, which never feeds the verdict or NEXT.
 */
export type RunSummaryPublicationOutcome =
  | { readonly status: "not-requested" }
  /** Requested, but the run verified that no documentation change is needed. */
  | { readonly status: "not-needed" }
  | { readonly status: "succeeded"; readonly mergeRequestUrl: string }
  | {
      readonly status: "failed";
      readonly failureCode: string;
      readonly recoveryCommand?: string;
      /** Typed human detail from a publisher or preflight error. */
      readonly detail?: string;
      /** Bounded, credential-free check dispositions from the typed delivery failure. */
      readonly validationFailure?: DeliveryValidationFailureEvidence;
      /**
       * Which phase refused the run base. `pre-write` is the `--draft-mr`
       * freshness prelude, before any write workspace exists. Absent reads as
       * `post-write`, the only phase a saved run record can describe.
       */
      readonly phase?: RunPublicationPhase;
    };

export type RunPublicationPhase = "pre-write" | "post-write";

/**
 * Saved-run replay NEXT-command projection. `readyCommand` is set only after an
 * explicit selector round-trips through the real `docsfab run` parser, so NEXT
 * is empty rather than an invented placeholder template.
 */
export interface RunHistoryNextCommandContext {
  readonly resumability: RunResumabilityProjectionV1;
  readonly readyCommand?: RunHumanNextCommand;
  /** Why an explicit selection did not yield `readyCommand`, when one was attempted. */
  readonly selectionOutcomeReason?: string;
}

/** Per-file +/- counts parsed from the patch artifact; presentation only. */
export interface RunSummaryPatchFileStat {
  readonly path: string;
  readonly insertions: number;
  readonly deletions: number;
}

export interface RunSummaryContext {
  record: RunRecord;
  recordPath: string;
  exitCode: 0 | 1 | 2;
  repositoryPath: string;
  task?: WorkflowTaskInput;
  releaseScorecard?: {
    defaultBranch: string;
    inventory: RepositoryDiscoveryInventoryV1;
  };
  iaContinuation?: string[];
  showScan?: boolean;
  tty?: boolean;
  /** Pins the `CI` rule; leave unset so live invocations read the ambient `CI`. */
  ci?: boolean;
  /** Pins `NO_COLOR`; leave unset so live invocations honor the environment. */
  noColor?: boolean;
  /** Raw ms duration, DocChangeDelta, and the gap-ledger dump. */
  verbose?: boolean;
  editorialDecodeOptions?: WorkflowOutcomeDecodeOptionsV1;
  /**
   * `--quiet` shape: VERDICT, NEXT and PATCH when present, RECORD, then QUALITY
   * and LIMITATIONS when present.
   */
  quiet?: boolean;
  /** Pre-write repository content digest for DocChangeDelta review lines. */
  repositoryContentDigestSha256?: string;
  publication?: RunSummaryPublicationOutcome;
  /**
   * Saved-run replay only, and only for a run with a publishable patch: the
   * run delivery index lookup. It renders a PUBLICATION section but sets no
   * verdict plane and no NEXT command, so a refused lookup never reads as a
   * failed publication.
   */
  deliveryLookup?: RunResultPublicationV1;
  retainedDelivery?: RunRetainedDeliveryV1;
  /**
   * Present only for saved-run replay. Keeps placeholder retry templates out of
   * NEXT and adds a Resumability line to VERDICT.
   */
  history?: RunHistoryNextCommandContext;
  patchFileStats?: readonly RunSummaryPatchFileStat[];
  htmlReportUrl?: string;
  /** Verified local HTML report path. */
  htmlReportPath?: string;
  /** Verified local Markdown report path, when retained. */
  markdownReportPath?: string | null;
  /** Whether the evaluator Markdown artifact was retained and read back. */
  markdownReportAvailable?: boolean;
  /** Why retained Markdown is unavailable while the HTML report remains valid. */
  markdownReportUnavailableReason?: "byte-bound" | "artifact-unavailable";
  /** Exact loopback command for serving this report. */
  reportServeCommand?: string;
  reportUnavailableReason?: string;
  reviewFindingsProjection?: ProjectedReviewFindingsV1;
  reviewEvidenceProjection?: ReviewEvidenceProjectionV1;
  /**
   * Sealed overflow evidence for the LIMITATIONS footer; this presenter never
   * invents bound-plus-one observations.
   */
  limitOverflowEvidence?: RunLimitOverflowEvidenceV1;
  /**
   * A failed run's diagnosis with recurrence read from the run index. Without
   * it, DIAGNOSIS is computed from the record alone and reports recurrence as
   * unread.
   */
  diagnosis?: RunDiagnosisV1;
}
