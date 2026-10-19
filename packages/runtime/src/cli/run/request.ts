// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { RunRuntimeConfig } from "../../config/runtime-loader.js";
import type { LocalUserPublicationRevisionPolicy } from "../../delivery/freshness.js";
import type { CommentExistingMrBinding, CommentExistingMrPort } from "../comment-existing-mr.js";
import type { RunArguments } from "../types.js";
import type { CompositionRunRuntime } from "./composition-runtime.js";
import type { ProgressEvent } from "../../records/contracts.js";
import type { WorkflowDefinition } from "../../workflow-contracts/contracts.js";
import type { FirstPassDocumentationTargetControl } from "../../workflow-execution/runner.js";
import type { AgentHarness } from "../../execution/contracts.js";
import type {
  AnswerRecordContinuationCheckpointEnvelopeV1,
  RunRecord,
  StepRunRecord,
} from "../../records/contracts.js";

export type PublicationRevisionPolicy = LocalUserPublicationRevisionPolicy;

/** Preserve explicit revision intent while selecting the draft-MR default. */
export function revisionPolicyForDraftMr(
  revision: string,
  revisionExplicit: boolean,
): PublicationRevisionPolicy {
  if (!revisionExplicit) return "target-branch-head";
  if (revision === "HEAD") return "checkout-head";
  return /^[a-f0-9]{40,64}$/iu.test(revision) ? "explicit-sha" : "explicit-ref";
}

export type RunRequestWithPublishProjection = RunArguments & {
  /**
   * Live-agent context beside the verbatim `instruction`. Shown to workflow
   * steps as non-authoritative context; never parsed for scope.
   */
  readonly instructionContext?: string;
  /** Content-free live handoff; execution re-observes every referenced source before use. */
  readonly readerTaskContext?: import("../../execution/task-context.js").ReaderTaskContextHandoffV1;
  readonly draftMr?: boolean;
  /** How the draft-MR freshness prelude resolves `revision`. */
  readonly revisionPolicy?: PublicationRevisionPolicy;
  readonly commentMr?: string;
  readonly commentMrBinding?: CommentExistingMrBinding;
  readonly commentMrRetry?: boolean;
  /**
   * `--canon-sha256`, so the review summary note can print the exact continue
   * command. Without it the note carries only the deferred `target=` value.
   */
  readonly commentMrCanonSha256?: string;
  /** `--quiet` on `do` / `run`; `--json` still wins. */
  readonly quiet?: boolean;
  /** GitLab target-branch HEAD observed before a `--draft-mr` write, when sealed. */
  readonly gitlabTargetAtRunStart?: {
    readonly branch: string;
    readonly revision: string;
  };
  /**
   * Host-owned editorial InputAsk resume from `do` or live-agent continue. The
   * runner admits fills from this field, not from `--reader-source`.
   */
  readonly operatorInputResume?: import("../../inputs/operator-input-fill.js").OperatorInputResumePlanV1;
  /** Host-selected, exact offered contradiction option; revalidated before first pass. */
  readonly firstPassChoices?: readonly import("../../records/first-pass-choice.js").FirstPassChoiceV1[];
  /** Set by the request interpretation step; the runner copies it onto the queued record. */
  readonly requestIntent?: import("../../request-intent/interpret-record.js").RunRecordRequestIntentV1;
};

export interface CliRunOutput {
  log(message: string): void;
  error(message: string): void;
}

/** Authoritative delivery observation for durable continuation coordination. */
export type CliRunDeliveryOutcome =
  | {
      readonly status: "settled";
      readonly mode: "none" | "comment-mr";
      readonly locator: string | null;
      readonly publicationResult: null;
    }
  | {
      readonly status: "settled";
      readonly mode: "draft-mr";
      readonly locator: string;
      readonly publicationResult: import("../../delivery/publication-result.js").LocalUserGitLabPublicationResultV1;
    }
  | {
      readonly status: "failed";
      readonly mode: "draft-mr" | "comment-mr";
      readonly failureCode: string;
    };

export interface CliRunOptions {
  /** Read-only observer for a fresh retained delivery preview. */
  onReviewDeliveryPreview?: (
    plan: Awaited<
      ReturnType<typeof import("../review-delivery.js").previewFreshGitLabReviewDelivery>
    >,
  ) => void;
  /** Host-owned original result producer; source parts are retained before model dispatch. */
  reviewResultRetention?: import("../../workflow-execution/runner-ports.js").WorkflowRunnerOptions["reviewResultRetention"];
  /** Deterministic product-outcome fixture; production uses the installed workflow projector. */
  outcomeProjector?: import("../../workflow-contracts/contracts.js").WorkflowOutcomeProjector;
  /** Test seam for the host's early required-check isolation probe. */
  probeRequiredCheckReadiness?: typeof import("../../workflow-execution/required-check-readiness.js").probeRequiredCheckReadiness;
  /** Host-prepared PR review evidence; checked against the selected snapshot before inference. */
  preparedReviewChange?: import("../../inputs/change-source.js").ResolvedChangeSourceV1<
    import("../../inputs/change-source.js").ChangeSourceMemberV1
  >;
  /** Test-only adapter seam; production constructs the configured Pi harness. */
  harness?: AgentHarness;
  /**
   * Request-interpretation port. Injected, it is always used, offline or not;
   * production builds the governed model port unless `PI_OFFLINE=1`.
   */
  requestInterpreter?: import("../../request-intent/interpret.js").RequestIntentInterpreterPort;
  /**
   * `--quiet` on `do` / `run`: suppresses the progress wall (and, on `do`, the
   * ROUTE preamble) but still prints the run footer and failure diagnostics.
   * `--json` still wins.
   */
  quiet?: boolean;
  verbose?: boolean;
  json?: boolean;
  /**
   * Internal, for a sub-run whose caller owns all output. Unlike `quiet`, it
   * drops the footer and failure diagnostics too; no public flag sets it.
   */
  silent?: boolean;
  /** Internal observer for callers that own their UI, including silent sub-runs. */
  onProgress?: (event: ProgressEvent, workflow: WorkflowDefinition) => void;
  signal?: AbortSignal;
  /** Host-selected immutable source reader for an isolated task; CLI flags cannot set it. */
  hostTrackedSourceReader?: import("../../inputs/source-acquisition.js").TrackedSourceReaderV1;
  commentExistingMr?: CommentExistingMrPort;
  /** Deterministic test fixture seam; production always assembles PiHarness. */
  executionHarness?: import("../../execution/contracts.js").AgentHarness;
  /** Deterministic application seam; production uses the installed catalog resolver. */
  skillResolver?: import("../../execution/contracts.js").GovernedSkillResolver;
  /** Internal authoritative delivery observer; normal CLI rendering is unchanged. */
  onDeliveryOutcome?: (outcome: CliRunDeliveryOutcome) => void;
  /** Deterministic delivery fixture seam; production uses the existing publisher. */
  submitAfterSucceededRun?: typeof import("../../autonomy/managed-publish-host.js").submitAfterSucceededRun;
  /** Test seam; production uses `ensureLocalUserPublicationFreshness`. */
  ensurePublicationFreshness?: (input: {
    readonly repositoryPath: string;
    readonly revision: string;
    readonly revisionPolicy?: PublicationRevisionPolicy;
    readonly remoteName?: string;
    readonly status?: (message: string) => void;
  }) => Promise<
    import("../../delivery/freshness.js").LocalUserPublicationGitLabTargetSnapshot | undefined
  >;
  /** Test seam for date-scoped UPDATE merged-MR discovery. */
  mergedMrPagePort?: import("../../inputs/merged-mr-discovery.js").MergedMrPagePortV1;
  /** Test seam for merged-MR discovery project identity. */
  mergedMrProject?: import("../../inputs/merged-mr-selection.js").MergedMrProjectScopeV1;
  /** Test seam for date-scoped UPDATE per-MR diffs. */
  fetchMergedMrDiffs?: import("../../inputs/merged-mr-gitlab.js").MergedMrDiffFetcherV1;
  /**
   * Test seam for `--pr` acquisition, so `run`, `do`, and `live-agent` can be
   * driven against one fixture forge. Production uses the host `glab` runner.
   */
  changeRequestCommands?: import("../../init/types.js").CommandRunner;
  /** Isolated environment for live `glab api` change-request reads. */
  changeRequestEnvironment?: NodeJS.ProcessEnv;
  /** Injected git/glab runner for merged-MR discovery and applicability. */
  mergedMrCommands?: import("../../init/types.js").CommandRunner;
  /** Isolated environment for live `glab api` merged-MR reads. */
  mergedMrEnvironment?: NodeJS.ProcessEnv;
  /** Skip `git cat-file` when the test already knows which SHAs exist. */
  presentMergedMrRevisions?: Iterable<string>;
}

export interface CliRunInvocation {
  request: RunRequestWithPublishProjection;
  config: RunRuntimeConfig;
  options: CliRunOptions;
  output: CliRunOutput;
  compositionRuntime?: CompositionRunRuntime;
  /** Set by the local run before its first model call; workflow execution reuses it. */
  preModelAdmission?: import("./pre-model-admission.js").PreModelAdmission;
  /** Exact host-selected checkpoint and successful prefix for process continuation. */
  answerRecordContinuation?: {
    readonly logicalRunId: string;
    readonly sourceRunId: string;
    readonly checkpoint: {
      readonly record: AnswerRecordContinuationCheckpointEnvelopeV1;
      readonly sha256: string;
    };
    readonly resumeStepId: string;
    readonly completedPrefix: readonly StepRunRecord[];
    readonly selectedPathId?: string;
    readonly selectionEvidence?: {
      readonly workflowBranchCoverage?: import("../../workflow-contracts/contracts.js").WorkflowBranchCoverageV1;
    };
    readonly sourceArtifacts?: RunRecord["artifacts"];
  };
  /** Durable exact-checkpoint claim, invoked by the runner after restore validation. */
  claimAnswerRecordContinuation?: (
    child?: import("../../records/contracts.js").RunRecord,
  ) => Promise<void>;
  /** Host-validated, per-run narrowing for an admitted first-pass documentation request. */
  firstPassTargetControl?: FirstPassDocumentationTargetControl;
  /** Coded first-pass notices the run record keeps from its queued save, such as an unbound reading source. */
  firstPassNotices?: readonly string[];
  /** The documentation write scope every plan of this run keeps to. */
  planWriteScope?: import("../../workflow-execution/runner-ports.js").DocumentationPlanWriteScope;
  /** Host-set from a claimed knowledge continuation only: the pages its stopped run admitted. */
  continuationPageIntent?: import("../knowledge-resume.js").RequestedPageIntent;
  /** Opt-in `--study` session. Absent when the flag is off. */
  studySession?: import("../../records/study-store.js").StudySession;
  /** The `--change` range, resolved and bounded before any model call. */
  changeSource?: import("./source-acquisition.js").ResolvedCliChangeSourceV1;
}
