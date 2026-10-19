// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ChangeRequestSelectorV1 } from "../inputs/change-request-selector.js";
import type { ChangeSourceSelectorV1 } from "../inputs/change-source.js";
import type { ContextPreflightTarget } from "../context/contracts.js";
import type { WorkflowTaskInput, WorkflowName } from "../workflow-contracts/contracts.js";
import type { TaskLineageArtifactsV1 } from "../lineage/index.js";
import type { ReaderComparisonRequestV1 } from "../search/change-impact.js";
import type { ReaderSourceHintV1 } from "../execution/reader-task-admission.js";

export interface RunArguments {
  /**
   * Exact installed composition; never inferred from a model name. Present, it
   * selects the sealed-composition path; omitted, the model-profile path runs.
   */
  compositionId?: string;
  /** Explicit, unqualified answer-record discovery for review-documentation. */
  experimentalAnswerRecords?: true;
  workflow: WorkflowName;
  repositoryPath: string;
  revision: string;
  instruction?: string;
  contextTarget?: ContextPreflightTarget;
  /** Operator-selected review pages; never inferred from model advice. */
  reviewTargetPaths?: readonly string[];
  /** Original CLI delivery choice; a change source alone grants no destination. */
  reviewDelivery?: "preview" | "publish";
  reviewDeliveryTarget?: string;
  /** Saved review whose admitted target set this explicit batch narrows. */
  rescopeFrom?: string;
  /** Explicit comparison intent; omission remains unknown. */
  comparisonRequest?: ReaderComparisonRequestV1;
  /** Optional path/role nominations. The host reads and hashes the tracked bytes. */
  readerSources?: readonly ReaderSourceHintV1[];
  /** Host-normalized date-window selector inferred from an UPDATE instruction. */
  mergedMrSelection?: import("../inputs/merged-mr-selection.js").MergedMrSelectionRequestV1;
  /**
   * `--source` paths the host acquires at the selected revision into the run's
   * `SourceBindingV1`; omission leaves the request byte-identical.
   */
  sourcePaths?: readonly string[];
  /**
   * `--pr`, parsed only: host and project may still be unresolved, and the
   * numeric project id is resolved at the provider boundary.
   */
  changeRequestSelector?: ChangeRequestSelectorV1;
  /**
   * `--change`, parsed only. The host resolves it against the checkout before
   * any model call; it never enters the source request projection.
   */
  changeSource?: ChangeSourceSelectorV1;
  task?: WorkflowTaskInput;
  planPath?: string;
  reviewerPolicyPath?: string;
  docImprovementCampaignPath?: string;
  docImprovementReviewerPolicyPath?: string;
  /** Knowledge snapshot imported by create-documentation or update-documentation. */
  canonSnapshotPath?: string;
  /** Host-accept a candidate --canon-snapshot for one run. */
  acceptCandidateSnapshot?: boolean;
  canonSnapshotAuthorityId?: string;
  allowWrite: boolean;
  /** Whether --allow-write was explicitly present in the original argv. */
  writeGrantExplicit?: boolean;
  /** Effective delivery selected by the original CLI invocation. */
  retryDeliverySelection?: import("../records/retry-context.js").CliRunRetryContextV1["deliveryMode"];
  runId?: string;
  corpusExecutionAuthorizationPath?: string;
  corpusReviewerPolicyPath?: string;
  corpusCaseId?: string;
  corpusTestedRevision?: string;
  inputDigest?: string;
  taskLineage?: TaskLineageArtifactsV1;
  /** Internal durable resume context; argv supplies only --resume-from. */
  knowledgeContinuationReceipt?: import("../records/knowledge-continuation.js").KnowledgeContinuationReceiptV1;
  knowledgeContinuationRecoveryAuthorization?: import("../lineage/contracts.js").TaskLineageRecoveryAuthorizationV1;
  knowledgeContinuationSnapshotSha256?: string;
  knowledgeContinuationAcceptanceSha256?: string;
  resumeFrom?: string;
  /** Host-only receipt copied to the new child run; argv never supplies it. */
  answerRecordContinuationReceipt?: import("../records/contracts.js").AnswerRecordContinuationReceiptV1;
  revisionExplicit?: boolean;
  releaseGate: boolean;
  verbose: boolean;
  json: boolean;
  showScan: boolean;
  /** Opt-in StudyEventV1 sibling log; off means no events, study dir, or STUDY plane. */
  study?: boolean;
  /** Classify and stop before write or publication. */
  dryRun?: boolean;
  /** Explicit local patch delivery, retained for operation-specific writer admission. */
  patchOnly?: boolean;
  /** Git remote for draft-MR publication; omitted means `origin`. */
  remoteName?: string;
}
