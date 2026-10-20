// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isRepositoryBootstrapStep } from "../onboarding/bootstrap-result.js";
import { isSourceReadinessStep } from "../readiness/assessment.js";
import { isSemanticComparisonStep } from "../workflow-contracts/semantic-comparison-step.js";
import { createHash } from "node:crypto";
import { currentTaskActivity, withTaskActivity } from "../activity/observer.js";
import type { PiActivitySession } from "../activity/observer.js";
import {
  preservationSourceObservationCacheDelta,
  preservationSourceObservationCacheStats,
} from "../workflow-execution/preservation-source-observation-cache.js";
import { assemblePiStepTools } from "./pi-step/tool-assembly.js";
import { throwPiAttemptFailure } from "./pi-step/attempt-failure.js";
import { collectPiAttemptEvidence } from "./pi-step/attempt-evidence.js";
import {
  settlePiActiveToolBatch,
  settlePiPreviouslySettledBatch,
  settlePiUnexecutedToolTurn,
} from "./pi-step/turn-settlement.js";
import { installPiAnswerRecordReplay } from "./pi-step/session-replay.js";
export { readTextRenderingForStep } from "./pi-step/tool-assembly.js";
import { assertWorkflowActive } from "../execution/cancellation.js";
import { ExecutionLeaseCoordinatorError } from "../execution/lease-coordinator.js";

import type {
  AgentHarness,
  HarnessStepInput,
  HarnessStepResult,
  ExecutionLeaseRuntimeTerminalDisposition,
} from "../execution/contracts.js";
import { InferenceStepError, isQualityCandidateValidationStep } from "../execution/contracts.js";
import type {
  InferenceConcludeNowEvidenceV1,
  InferenceDeadlineTurn,
  InferenceProgressToolActivityV1,
} from "../records/contracts.js";
import { concludesNow } from "../records/inference-retry-rule-vocabulary.js";
import {
  resolveRejectedReplyShapePolicy,
  retainRejectedReplyShape,
} from "../execution/rejected-reply-retention.js";
import {
  bindModelExecutionProfile,
  type BoundModelExecutionProfile,
  type ModelEndpointConfig,
  type ProviderCredential,
} from "../model/configuration.js";
import {
  createModelConnection,
  createProviderConnectionFactory,
  ProviderResponseLimitError,
  type ModelConnection,
  type ModelTurnGovernanceOptions,
  type ProviderConnectionInput,
  type ProviderConnectionFactory,
} from "../model/provider.js";
import {
  classifyModelFailure,
  grantedTurnOutputTokens,
  localStopReason,
} from "../model/context-budget.js";
import { isLengthStop } from "../model/provider-turn-retry.js";
import type { OutboundProxyRefusal } from "../model/outbound-http-policy.js";
import {
  buildAttemptModelTelemetry,
  observeLandedProviderTurn,
  type LandedProviderTurnTelemetry,
} from "../model/attempt-telemetry.js";
import { OUTPUT_AUTHORITY_FLOOR_TOKENS } from "../model/turn-governor.js";
import { inferAttemptWriteSettlement } from "./write-settlement.js";
import {
  assertModelResponseCredentialFree,
  type CredentialBoundaryError,
} from "../security/credential-isolation.js";
import { redactSecrets } from "../security/redaction.js";
import { readVerifiedCatalogFile, verifyCatalogSkill } from "../skills/catalog-crate.js";
import { limit, type ResolveLimitsOptions } from "../config/limits.js";
import { resolveTurnRecoveryPolicy } from "../model/turn-recovery-policy.js";
import { governedSkillVirtualRoot } from "./confined-tools.js";
import {
  admitQualityAnswerRecordReport,
  submissionMemberStrings,
  type QualitySubmissionMembers,
} from "./quality-candidate-tool.js";
import {
  firstSubmissionCall,
  QUALITY_ANSWER_RECORD_TOOL_NAME,
  QUALITY_SUBMISSION_TOOL_NAME,
  RawToolCallCapture,
  settledToolCalls,
} from "./answer-submission.js";
import { OUTPUT_HOST_TEXT, rejectOutput } from "../contracts/model-output.generated.js";
import type {
  InferenceAnswerReportTurnState,
  InferenceAnswerSubmissionEvidenceV1,
  InferenceAnswerSubmissionState,
} from "../records/contracts.js";
export { decodeQualityArtifactResponse } from "./quality-candidate-tool.js";
import {
  bindQualityArtifactResponseContract,
  buildEditorialResponseContractV1,
  isEditorialAssessmentStep,
  isQualityArtifactEvaluator,
  reviewResponsePlacement,
} from "./editorial-response-contract.js";
export {
  bindQualityArtifactResponseContract,
  buildEditorialResponseContractV1,
  decodeEditorialAssessmentResponseV1,
  editorialAssessmentEvidenceRefsV1,
} from "./editorial-response-contract.js";
import { documentationPlanModeForWorkflow } from "../workflow-execution/plan-binding.js";
import {
  contractPlaceholderScope,
  EMPTY_CONTRACT_PLACEHOLDER_SCOPE,
  findContractPlaceholderInReply,
} from "../workflow-execution/contract-placeholders.js";
import {
  authoritativeReviewTargetPaths,
  requiresVerificationResult,
  validateVerificationResult,
} from "../workflow-execution/verification-result.js";
import { createModelEvidence } from "../model/profile-evidence.js";
import type { ExecutionContextObservationV1, ExecutionTerminalReason } from "../execution/index.js";
import {
  PiAttemptBatchSettlementLedger,
  createPiBatchAuthoritySha256,
  digestPiToolCall,
  validatePiBatchCalls,
  validatePiBatchSettlement,
  type PiProgressRecommendationV1,
  recommendPiProgress,
  type PiProviderTurnUsageV1,
} from "./pi-lease.js";
import { canonicalDigest } from "../content-ir/canonical.js";
import {
  executionLeaseChargeableAttemptCeiling,
  readingToolCallsExecuted,
  remainingScopedToolCalls,
} from "../execution/lease-contracts.js";
import {
  bindReviewResponseContract,
  requiresEditorialReviewResult,
} from "../workflow-execution/review-response.js";
import {
  bindProvisionalVerificationJudgmentContract,
  bindSourceObligationResponseContract,
  canonicalSourceObligationProposal,
  requiresSourceObligationLedger,
  requiresTechnicalCorrection,
  validateSourceObligationProposal,
  usesProvisionalVerificationJudgment,
} from "../workflow-execution/source-obligation.js";
import { runHostZeroSourceJudgment } from "./zero-source-judgment.js";
import {
  declinedJudgmentCut,
  hostCompleteCutJudgment,
  hostCompleteCutQualityNarrative,
  hostCompleteCutQualityReport,
  hostCompleteCutQualityReportFromMembers,
  hostFillRefusedJudgment,
  hostFillRefusedCutJudgment,
  qualityReportCutApplies,
  recoverableQualityReportCut,
  refusedAsModelContent,
  refusedWithNoRetryLeft,
  type CutJudgmentAnswer,
} from "./cut-judgment.js";
import {
  bindAuthoringRevisionResponseContract,
  isAuthoringRevisionWriter,
} from "../workflow-execution/authoring-revision.js";
import type { RepositoryWorkspace } from "../repository/workspace/contracts.js";
import { assertOriginalSourceAuthorityAdmission } from "../workflow-execution/source-obligation-authority.js";
import { createStudyEvent } from "../records/study-event.js";
import type { StudySession } from "../records/study-store.js";
import {
  grantedToolsForStep,
  FILESYSTEM_READ_ONLY_TOOLS,
  QUALITY_CANDIDATE_VALIDATION_TOOL_NAME,
  normalizeObservedToolName,
  skillPolicyTools as skillPolicyToolsForMode,
  summarizeToolFailureCategories,
  type PiBeforeToolCall,
} from "./pi-tool-confine.js";
import { HISTORY_TOOL_NAMES, historyReaderForStep } from "./history-tools.js";
import { OBSERVATION_TOOL_NAMES } from "./observation-tools.js";
import { SOURCE_READ_TOOL_NAMES, SOURCE_SEARCH_TOOL_NAMES } from "./source-tools.js";
import { TOOL_RESULT_RECALL_TOOL_NAME } from "./tool-output-cap.js";
import {
  answerNowAppliesTo,
  answerNowFlipAtMs,
  concludeBeforeDeadlineAppliesTo,
  concludeBeforeDeadlineAtMs,
  stepAnswerNowPlan,
  resolveAnswerNowPolicy,
  deriveRecordsAnswerNowFlip,
} from "./answer-now.js";
import { deriveAnswerSubmissionRemainingPlan } from "../model-composition/answer-submission-record-fit.js";
import { isUsefulProgress } from "./read-evidence.js";
import {
  formatStepExecutionLimitStop,
  leaseTerminalLimitStop,
} from "../config/execution-limit-stops.js";
import { isConfigurableRetryCategory } from "../inference-attempt-taxonomy.js";
import {
  markStitchedReplyRefusal,
  lengthStopContinuationPrompt,
  resolveLengthStopContinuationPolicy,
} from "./length-stop-continuation.js";
import {
  observationModeForStep,
  scratchFromToolCall,
  type StudyCallScratch,
} from "./study-observer.js";
import {
  attributedProducedOutputTokens,
  bindProducedTurnOutputTokens,
  bindProviderFinishReasons,
} from "./turn-output-evidence.js";
import { QualityPackError } from "../quality-pack/manifest.js";
import type { StyleTaskContextV1 } from "../execution/task-context.js";
import {
  PI_ANSWER_NOW_PROMPT,
  PI_ANSWER_NOW_TOOL_REFUSAL,
  PI_CONCLUDE_NOW_PROMPT,
  PI_DEADLINE_CONCLUDE_NOW_PROMPT,
  buildDocsFabStepPrompt,
  createDocsFabResourceLoader,
  createPiAgentSession,
  loadQualityEvaluatorContract,
  loadWriterSourceFactMethod,
  STYLE_BOUND_SKILLS,
  expandGovernedSkillCommand,
  governedSkillBlock,
  SKILL_EXPANSION_MISSING,
  userMessageText,
} from "./pi-session.js";
import {
  assistantAuthoritySha256,
  assistantText,
  assistantToolCalls,
  assistantTurnFailure,
  formatAssistantTurnFailure,
  type OutputLeaseClamp,
  type PiAssistantTurnFailure,
  attemptArtifactSha256,
  createPiExecutionLeaseController,
  nextTranche,
  providerUsage,
  leaseAvailableInputTokens,
  reservationForTurn,
} from "./pi-offline.js";

export type {
  DocsFabContextSource,
  DocsFabResourceLoaderOptions,
} from "./pi-session.js";
export {
  buildDocsFabStepPrompt,
  createDocsFabResourceLoader,
  getDocsFabContextSources,
} from "./pi-session.js";
export {
  createBoundedBeforeToolCall,
  normalizeObservedToolName,
  summarizeToolFailureCategories,
} from "./pi-tool-confine.js";
import type { ReplyAdmissionContext } from "./reply-admission/context.js";
import { admitPlannerReply, confirmProposedUpdatePlan } from "./reply-admission/planner.js";
export {
  admitEditorialPlannerEnvelopeV1,
  admitEditorialPlannerProposalV1,
} from "./reply-admission/planner.js";
import { admitEditorialAssessmentReply } from "./reply-admission/editorial-assessment.js";

type ToolActivityCategory = keyof InferenceProgressToolActivityV1;

const READ_SEARCH_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...FILESYSTEM_READ_ONLY_TOOLS,
  ...SOURCE_READ_TOOL_NAMES,
  ...SOURCE_SEARCH_TOOL_NAMES,
  ...OBSERVATION_TOOL_NAMES,
  ...HISTORY_TOOL_NAMES,
  TOOL_RESULT_RECALL_TOOL_NAME,
  "canon_query",
  "canon_conflict_gap",
  "canon_affected_docs",
]);

function toolActivityCategory(name: string): ToolActivityCategory {
  if (name === QUALITY_ANSWER_RECORD_TOOL_NAME) return "answerRecord";
  if (name === QUALITY_SUBMISSION_TOOL_NAME) return "reportSubmission";
  if (name === QUALITY_CANDIDATE_VALIDATION_TOOL_NAME) return "candidateValidation";
  if (READ_SEARCH_TOOL_NAMES.has(name)) return "readSearch";
  return "other";
}
export { EDITORIAL_ENVELOPE_SHAPE_REJECTION } from "./reply-admission/editorial-assessment.js";
import { admitAuthoringRevisionReply } from "./reply-admission/authoring-revision.js";
import {
  admitJudgmentReply,
  admittedReplySpan,
  judgmentRowKeyEvidence,
} from "./reply-admission/judgment.js";
import {
  admitQualityArtifactReply,
  admitQualitySubmissionReply,
  decodeQualitySubmissionCall,
  qualitySubmissionFailure,
} from "./reply-admission/quality-artifact.js";
import { HOST_WRITTEN_EVALUATION_FIELDS } from "../evaluation-report/evaluation-target.js";
import { admitReviewResultReply } from "./reply-admission/review-result.js";

interface PiHarnessBaseOptions {
  skillCrateDirectory: string;
  /** Verified generated Pin C payload mounted read-only for skill references. */
  qualityDirectory?: string;
  /**
   * The bound style profile the host resolved from the verified pack at run
   * admission. Style-bound steps read it as given and refuse when it is absent.
   */
  styleContext?: StyleTaskContextV1;
  /** Host policy chained before DocsFab grants a Pi tool call. */
  beforeToolCall?: PiBeforeToolCall;
  /** Test/host seam for observing or interrupting the real Pi session. */
  configureSession?: (session: Awaited<ReturnType<typeof createPiAgentSession>>) => void;
  /** Opt-in `--study` sibling log. Absent means zero study events. */
  study?: StudySession;
  /**
   * Per-call model-visible payload ceiling for read/grep/find/ls, in bytes;
   * defaults to `DEFAULT_TOOL_OUTPUT_CAP_BYTES`. Not in any composition or tool-policy digest.
   */
  toolOutputCapBytes?: number;
  /**
   * Enables the tool-result archive and grants `docsfab_recall_tool_result` on
   * every step. Hosted runs leave it off:
   * a sealed composition's `declaredTools` must equal the catalog, which omits it.
   */
  toolResultRecall?: boolean;
  /** Effective local CAS bound for retained review read observations. */
  reviewReadMaxObjectBytes?: number;
  /** Limit resolution; omitted resolves the process environment and host files. */
  limits?: ResolveLimitsOptions;
  /** Host-held workspace capability; never serialized or exposed to the model. */
  repositoryWorkspace?: RepositoryWorkspace;
  /**
   * Clock for elapsed-time decisions inside an attempt. Message timestamps and
   * recorded turn durations stay on the wall clock because they are evidence.
   */
  now?: () => number;
}

interface LegacyPiHarnessOptions extends PiHarnessBaseOptions {
  model: ModelEndpointConfig;
  executionProfile?: never;
  credential?: never;
  providerConnectionFactory?: never;
  /** Test/host seam that still exercises the real Pi session lifecycle. */
  createConnection?: (
    model: ModelEndpointConfig,
    options: Parameters<typeof createModelConnection>[1],
  ) => Promise<ModelConnection>;
}

interface BoundPiHarnessOptions extends PiHarnessBaseOptions {
  model?: never;
  createConnection?: never;
  executionProfile: BoundModelExecutionProfile;
  credential: ProviderCredential;
  providerConnectionFactory: ProviderConnectionFactory;
}

export type PiHarnessOptions = LegacyPiHarnessOptions | BoundPiHarnessOptions;

export class PiHarness implements AgentHarness {
  private readonly executionProfile: BoundModelExecutionProfile;
  private readonly credential: ProviderCredential;
  private readonly providerConnectionFactory: ProviderConnectionFactory;

  public constructor(private readonly options: PiHarnessOptions) {
    if (options.model !== undefined) {
      const bound = bindModelExecutionProfile(options.model);
      this.executionProfile = bound.profile;
      this.credential = bound.credential;
      this.providerConnectionFactory = options.createConnection
        ? Object.freeze({
            routeId: bound.profile.routeId,
            transport: bound.profile.transport,
            create: (_input: ProviderConnectionInput, turnOptions?: ModelTurnGovernanceOptions) =>
              options.createConnection!(options.model, turnOptions),
          })
        : createProviderConnectionFactory({
            routeId: bound.profile.routeId,
            transport: bound.profile.transport,
          });
      return;
    }
    this.executionProfile = options.executionProfile;
    this.credential = options.credential;
    this.providerConnectionFactory = options.providerConnectionFactory;
    if (
      this.providerConnectionFactory.routeId !== this.executionProfile.routeId ||
      this.providerConnectionFactory.transport !== this.executionProfile.transport
    ) {
      throw new Error("Pi provider connection factory does not match the bound execution profile.");
    }
  }

  /**
   * The admission-resolved style profile for a style-bound step; other steps
   * receive none. The harness never re-reads the lock to resolve it.
   */
  public boundStyleContext(input: Pick<HarnessStepInput, "step">): StyleTaskContextV1 | undefined {
    if (!STYLE_BOUND_SKILLS.has(input.step.skill)) return undefined;
    if (!this.options.styleContext) {
      // hygiene: envelope — QualityPackError maps the stable code through its message table.
      throw new QualityPackError("lock-unavailable");
    }
    return this.options.styleContext;
  }

  /** Digest the actual bound serving model and request policy for host-only
   * answer-record provenance when no installed composition binding exists. */
  public qualityAnswerRecordRouteBindingSha256(): string {
    return canonicalDigest({
      providerId: this.executionProfile.providerId,
      modelId: this.executionProfile.modelId,
      routeId: this.executionProfile.routeId,
      apiFormat: this.executionProfile.apiFormat,
      requestPolicy: this.executionProfile.requestPolicy,
    });
  }

  /** The bound serving provider for host-authored answer-record provenance. */
  public qualityAnswerRecordProviderId(): string {
    return this.executionProfile.providerId;
  }

  public async inspectSkill(
    input: HarnessStepInput,
  ): Promise<NonNullable<HarnessStepResult["skill"]> | undefined> {
    const skillPolicyTools = this.skillPolicyTools(input);
    return (
      await verifyCatalogSkill({
        skillCrateDirectory: this.options.skillCrateDirectory,
        skillId: input.step.skill,
        grantedTools: skillPolicyTools,
      })
    ).evidence;
  }

  public async runStep(input: HarnessStepInput): Promise<HarnessStepResult> {
    const activity = currentTaskActivity();
    if (!activity?.childScopeId) return this.runStepObserved(input);
    const producerSessionId = activity.observer.reserveSession();
    return withTaskActivity({ ...activity, producerSessionId }, () => this.runStepObserved(input));
  }

  private async runStepObserved(input: HarnessStepInput): Promise<HarnessStepResult> {
    // Resolved before anything is opened, so no read on the rejection path can
    // replace a rejection.
    const replyShapePolicy = resolveRejectedReplyShapePolicy();
    assertWorkflowActive(input.signal);
    const now = this.options.now ?? Date.now;
    const attemptStartedAt = now();
    const reuseBefore = input.preservationSourceObservationCache
      ? preservationSourceObservationCacheStats(input.preservationSourceObservationCache)
      : undefined;
    if (!input.evidenceIdentity) {
      throw new Error("Pi workflow step is missing its repository evidence identity.");
    }
    if (input.sourceObligationAnswerRecords && !requiresSourceObligationLedger(input)) {
      throw new Error("The source-obligation records capability is bound to the wrong step.");
    }
    if (input.sourceObligationAnswerRecords && input.qualityAnswerRecords) {
      throw new Error(
        "Pi cannot bind quality and source-obligation answer-record capabilities to the same step.",
      );
    }
    const answerRecordCapability =
      input.qualityAnswerRecords ?? input.sourceObligationAnswerRecords;
    if (requiresTechnicalCorrection(input) && input.sourceObligationLedger?.schemaVersion === 2) {
      if (!input.runId || !input.originalSourceAuthorityAdmission) {
        throw new InferenceStepError(
          "Technical correction requires a valid original source authority admission.",
          "malformed-response",
          false,
        );
      }
      try {
        assertOriginalSourceAuthorityAdmission(input.originalSourceAuthorityAdmission, {
          runId: input.runId,
          descriptor: input.sourceObligationLedger.identity.originalSourceAuthority,
        });
      } catch {
        throw new InferenceStepError(
          "Technical correction original source authority admission is stale or invalid.",
          "malformed-response",
          false,
        );
      }
    }
    const technicalVerification = validateQualityCandidateToolBinding(input);
    // The answer path was resolved once by the runner from this harness's own
    // bound route. A tool-call path on a route with no recorded capability, or
    // on another step, is a host defect: the harness never re-resolves it.
    const answerSubmission = this.executionProfile.answerSubmission;
    const toolPath = input.answerSubmission?.path === "tool-call";
    if (toolPath && (!answerSubmission || !isQualityArtifactEvaluator(input))) {
      throw new Error(
        "The step input selects the tool-call answer path, but this harness's bound route records no answer submission for it.",
      );
    }
    // Raw tool-call argument text by content position, per turn. The submission
    // and the advisory check on the tool path are decoded from it, never from
    // the object Pi parsed.
    const rawToolCalls = new RawToolCallCapture();
    // Set once the report ask is sent; the provider hook reads it per request.
    let reportToolChoiceNone = false;
    let answerRecordReportAsked = false;
    // Set only after a records-only evaluator returns premature final text.
    // It stays active through whole-artifact corrections; report readiness
    // gives the existing final-report `none` behavior precedence.
    let answerRecordRecoveryToolChoiceRequired = false;
    // One answer drives both the registration below and the grant.
    const historyReader = historyReaderForStep(
      input.step,
      input.repositoryWorkspace ?? this.options.repositoryWorkspace,
      input.toolCeiling,
      this.options.limits,
    );
    const grantedTools = this.grantedTools(input, historyReader !== undefined);
    if (this.options.study && input.runId) {
      await this.options.study.ensureRun({
        runId: input.runId,
        observationMode: observationModeForStep(input.step.search, grantedTools),
        modelRef: {
          provider: this.executionProfile.providerId,
          catalogId: this.executionProfile.modelId,
        },
      });
    }
    const governedEvidence = await this.inspectSkill(input);
    const verifiedSkill = await verifyCatalogSkill({
      skillCrateDirectory: this.options.skillCrateDirectory,
      skillId: input.step.skill,
      grantedTools: this.skillPolicyTools(input),
    });
    const catalogSkillDirectory = verifiedSkill.directory;
    const evaluatorContract = isQualityArtifactEvaluator(input)
      ? await loadQualityEvaluatorContract({
          skillCrateDirectory: this.options.skillCrateDirectory,
          qualityDirectory: this.options.qualityDirectory ?? "",
          selection: input.qualityProfileSelection!,
          // The host writes these only when it binds the evaluation target.
          ...(input.qualityEvaluationTarget
            ? { hostWrittenFields: HOST_WRITTEN_EVALUATION_FIELDS }
            : {}),
        })
      : "";
    const styleContext = this.boundStyleContext(input)?.prompt ?? "";
    const writerSourceFactMethod =
      input.step.skill === "write-documentation"
        ? await loadWriterSourceFactMethod({
            skillCrateDirectory: this.options.skillCrateDirectory,
          })
        : "";
    // Pi loads no skills: its skill list and `/skill:` expansion name the
    // bundle by absolute host path. The host supplies the verified block.
    const resourceLoader = createDocsFabResourceLoader({
      repositoryPath: input.repositoryPath,
      mode: input.step.mode,
      step: input.step,
    });
    await resourceLoader.reload();
    const repositoryInstructions = resourceLoader
      .getAgentsFiles()
      .agentsFiles.map((file) => file.path);

    const skill = { name: verifiedSkill.skill.id };
    const activityBeforeSkill = currentTaskActivity();
    const settleSkillLoad = activityBeforeSkill?.childScopeId
      ? activityBeforeSkill.observer.startResource({
          childScopeId: activityBeforeSkill.childScopeId,
          resourceKind: "skill-instruction",
          operation: "load",
          resourceId: verifiedSkill.skill.id,
          path: null,
          fromByte: null,
          maxBytes: null,
        })
      : undefined;
    let skillContent: Buffer;
    try {
      skillContent = await readVerifiedCatalogFile(verifiedSkill, "SKILL.md");
      settleSkillLoad?.({ status: "ok", bytes: skillContent });
    } catch (error) {
      settleSkillLoad?.({ status: "failed", bytes: null });
      throw error;
    }
    const skillContentSha256 = createHash("sha256").update(skillContent).digest("hex");
    if (governedEvidence && governedEvidence.contentSha256 !== skillContentSha256) {
      throw new Error(`Loaded skill "${input.step.skill}" does not match its governed lock.`);
    }
    // A judgment step over a sealed ledger that admitted no source has a
    // host-determined answer. It returns after the skill lock and byte checks
    // and before any provider connection opens, so nothing is sent or read.
    const hostZeroSource = await runHostZeroSourceJudgment(input);
    if (hostZeroSource) {
      // No guard needed: every step this branch answers already satisfies
      // `requiresAdmittedReviewResponse`.
      input.onText?.(hostZeroSource.summary);
      return {
        ...hostZeroSource,
        // Required even with no provider turn: `records/composition-execution.ts`
        // fails an inference step without a matching `model` as `subject-mismatch`.
        model: createModelEvidence(this.executionProfile),
        skill: governedEvidence ?? {
          id: skill.name,
          contentSha256: skillContentSha256,
        },
      };
    }
    // The host replaces the step prompt's `/skill:<name> ` prefix with this
    // block. Before any provider traffic, require the first user message Pi
    // records to begin with exactly these verified bytes.
    const expectedSkillExpansion = governedSkillBlock(
      { id: skill.name, virtualRoot: governedSkillVirtualRoot(skill.name) },
      skillContent.toString("utf8"),
    );
    let skillExpansionVerified = false;
    let skillExpansionRefusal: InferenceStepError | undefined;
    const assertSkillExpanded = (): void => {
      if (skillExpansionVerified) return;
      if (!skillExpansionRefusal) {
        const firstUserMessage = session.messages.find((message) => message.role === "user");
        const text = firstUserMessage ? userMessageText(firstUserMessage) : "";
        if (text.startsWith(expectedSkillExpansion)) {
          skillExpansionVerified = true;
          return;
        }
        skillExpansionRefusal = new InferenceStepError(
          `${SKILL_EXPANSION_MISSING}: the first provider request does not begin with the verified "${skill.name}" skill body.`,
          "invalid-request",
          false,
        );
      }
      throw skillExpansionRefusal;
    };

    const { readEvidence, confinedTools, confinedToolDefinitions } = await assemblePiStepTools({
      step: input,
      repositoryWorkspace: input.repositoryWorkspace ?? this.options.repositoryWorkspace,
      historyReader,
      grantedTools,
      skill: { name: skill.name, directory: catalogSkillDirectory },
      limits: this.options.limits,
      qualityDirectory: this.options.qualityDirectory,
      toolOutputCapBytes: this.options.toolOutputCapBytes,
      toolResultRecall: this.options.toolResultRecall,
      reviewReadMaxObjectBytes: this.options.reviewReadMaxObjectBytes,
      technicalVerification,
      answerSubmission,
      toolPath,
      rawToolCalls,
    });

    // A fresh connection makes the mutable turn ledger attempt-scoped. Sharing
    // it across retries, workflow steps, or concurrent runs would corrupt both
    // limits and evidence identity.
    const executionLease = createPiExecutionLeaseController(
      input,
      this.executionProfile,
      grantedTools,
      this.options.limits,
    );
    const recoveryPolicy =
      executionLease.coordinator.policy.schemaVersion === 1
        ? resolveTurnRecoveryPolicy(
            executionLease.coordinator.policy.maxProviderTurns,
            this.options.limits,
          )
        : {
            // Tool-turn recovery counts are aggregate attempt ceilings. Discovery
            // keeps the preservation floor but has no consecutive-turn stop.
            maxConsecutiveLengthStoppedToolTurns: undefined,
            minRecentToolTurns: limit("governance.minRecentToolTurns", this.options.limits).value,
          };
    const maxLengthStopContinuations =
      input.experimentalAnswerRecordDiscoveryRenewal === true
        ? undefined
        : resolveLengthStopContinuationPolicy(this.options.limits).maxLengthStopContinuations;
    const connection = await this.providerConnectionFactory.create(
      { profile: this.executionProfile, credential: this.credential },
      {
        evidenceIdentity: input.evidenceIdentity,
        limits: {
          ...(executionLease.coordinator.policy.schemaVersion === 1
            ? {
                maxProviderTurns:
                  this.executionProfile.compositionPolicy?.maxProviderTurns ??
                  executionLease.coordinator.policy.maxProviderTurns,
                // Report the ceiling actually in force: this value is written into
                // every turn record, and a misreported ceiling makes a budget stop
                // look like the model choosing to stop.
                maxToolCalls: executionLeaseChargeableAttemptCeiling(
                  executionLease.coordinator.policy,
                ),
                maxCompactions: executionLease.coordinator.policy.maxCompactions,
              }
            : {}),
          minRecentToolTurns: recoveryPolicy.minRecentToolTurns,
        },
        ...(executionLease.coordinator.policy.schemaVersion === 2
          ? { aggregatePolicy: { kind: "absent" as const } }
          : {}),
        ...(input.experimentalAnswerRecordDiscoveryRenewal === true
          ? { aggregatePhysicalRequestLimit: { kind: "absent" as const } }
          : {}),
        beforeProviderTurn: (turn) => {
          assertWorkflowActive(input.signal);
          assertSkillExpanded();
          // Compaction may drop earlier results from the context, so a re-read
          // after it is new evidence again.
          if (turn.decision === "compact") readEvidence.startEpoch();
          executionLease.preflightProviderTurn({
            kind: executionLease.checkpointRequired ? "checkpoint" : "ordinary",
            toolCalls: 0,
            providerTurns: 1,
            compactions: turn.decision === "compact" ? 1 : 0,
            inputTokens: Math.max(1, turn.estimatedInputTokens),
            outputTokens: Math.max(1, grantedTurnOutputTokens(turn)),
            elapsedMs: 1,
            contextInputTokens: Math.max(1, turn.estimatedInputTokens),
          });
        },
        // The preflight compares the requested per-turn output against the
        // remaining cumulative authority, so a small remainder would refuse the
        // request outright. The governor gets the live remainder first and
        // clamps `max_tokens` to it, or stops by name.
        outputAuthority: () =>
          executionLease.coordinator.policy.schemaVersion === 1
            ? {
                maxOutputTokens: executionLease.coordinator.policy.cumulative.maxOutputTokens,
                cumulativeOutputTokens: executionLease.coordinator.state.cumulativeOutputTokens,
              }
            : undefined,
        // Report turns disable tools for answer records and for submission
        // routes that recorded support for `tool_choice: "none"`. The
        // experimental records-only recovery asks for a tool only on the
        // supported Chat Completions transport until the host validates the
        // settled report ledger.
        toolChoice: () =>
          answerRecordReportAsked ||
          (reportToolChoiceNone && answerSubmission?.reportTurnToolChoice === "none")
            ? "none"
            : answerRecordRecoveryToolChoiceRequired &&
                this.executionProfile.transport === "openai-chat-completions"
              ? "required"
              : undefined,
      },
    );
    readEvidence.bindTurnSource(
      () =>
        connection.turnGovernance?.evidence().filter((turn) => turn.decision !== "stop").length ??
        0,
    );
    const session = await createPiAgentSession({
      repositoryPath: input.repositoryPath,
      connection,
      resourceLoader,
      confinedToolDefinitions,
    });
    const activity = currentTaskActivity();
    const observedSession: PiActivitySession | undefined =
      activity?.childScopeId && activity.producerSessionId
        ? activity.observer.attachPiSession(
            confinedToolDefinitions.map((tool) => tool.name),
            {
              producerSessionId: activity.producerSessionId,
              childScopeId: activity.childScopeId,
              runId: input.runId ?? null,
              stepId: input.step.id,
              attempt: input.inferenceAttempt ?? 1,
            },
          )
        : undefined;
    installPiAnswerRecordReplay(session, connection.model, input, expectedSkillExpansion);
    let cancellation: Promise<void> | undefined;
    const cancelSession = () => {
      cancellation ??= session.abort().catch(() => {
        // The settled prompt reports the failure; never expose an arbitrary abort reason.
      });
    };
    input.signal?.addEventListener("abort", cancelSession, { once: true });

    const attemptTimeoutMs =
      input.experimentalAnswerRecordDiscoveryRenewal === true
        ? undefined
        : this.executionProfile.compositionPolicy?.timeoutMs;
    let attemptTimedOut = false;
    let attemptTimeout: NodeJS.Timeout | undefined;
    // Where the provider exchange stands, so a timer that fires can tell a
    // provider that never answered from a model still producing tool calls.
    let inFlightTurn: InferenceDeadlineTurn = "between-requests";
    let deadlineTurn: InferenceDeadlineTurn | undefined;
    const timeoutFailure =
      attemptTimeoutMs === undefined
        ? undefined
        : new Promise<never>((_resolve, reject) => {
            const elapsed = now() - attemptStartedAt;
            attemptTimeout = setTimeout(
              () => {
                attemptTimedOut = true;
                // The transport may buffer a whole response before Pi sees it,
                // so a request with no Pi event yet is a stall only when no byte
                // of its body has arrived either.
                deadlineTurn =
                  inFlightTurn === "awaiting-first-byte" &&
                  connection.providerTransport?.lastExchange().bodyReceived === true
                    ? "streaming"
                    : inFlightTurn;
                session.abort();
                reject(new CompositionAttemptTimeoutError(attemptTimeoutMs));
              },
              Math.max(0, attemptTimeoutMs - elapsed),
            );
          });
    const promptWithinAttempt = async (prompt: string): Promise<void> => {
      assertWorkflowActive(input.signal);
      const operation = session.prompt(prompt);
      await (timeoutFailure ? Promise.race([operation, timeoutFailure]) : operation);
      assertWorkflowActive(input.signal);
    };

    let studyWrite: Promise<void> = Promise.resolve();
    let answerRecordSettlement: Promise<void> = Promise.resolve();
    let answerRecordSettlementFailure: unknown;
    let sessionEventError: unknown;
    const queueAnswerRecordSettlement = (
      batch: {
        readonly authoritySha256: string;
        readonly authorized: readonly string[];
        readonly calls: readonly {
          readonly id: string;
          readonly name: string;
          readonly sha256: string;
        }[];
      },
      results: readonly { readonly callSha256: string; readonly outcome: "succeeded" | "failed" }[],
    ): void => {
      const capability = answerRecordCapability;
      if (!capability) return;
      const toolCallIds = batch.calls
        .filter((call) => call.name === QUALITY_ANSWER_RECORD_TOOL_NAME)
        .map((call) => call.id);
      if (toolCallIds.length === 0) return;
      const successfulToolCallIds = results.flatMap((result) => {
        if (result.outcome !== "succeeded") return [];
        const call = batch.calls.find((candidate) => candidate.sha256 === result.callSha256);
        return call?.name === QUALITY_ANSWER_RECORD_TOOL_NAME ? [call.id] : [];
      });
      const sourceObligationCapability = input.sourceObligationAnswerRecords;
      const failedRefusalToolCallIds = sourceObligationCapability
        ? results.flatMap((result) => {
            if (result.outcome !== "failed") return [];
            const call = batch.calls.find((candidate) => candidate.sha256 === result.callSha256);
            return call?.name === QUALITY_ANSWER_RECORD_TOOL_NAME &&
              batch.authorized.includes(call.sha256) &&
              sourceObligationCapability.receipt(call.id).status === "refused"
              ? [call.id]
              : [];
          })
        : [];
      answerRecordSettlement = answerRecordSettlement
        .then(async () => {
          if (answerRecordSettlementFailure !== undefined) throw answerRecordSettlementFailure;
          const authorizedToolCallIds = batch.calls.flatMap((call) =>
            call.name === QUALITY_ANSWER_RECORD_TOOL_NAME && batch.authorized.includes(call.sha256)
              ? [call.id]
              : [],
          );
          const settlement = {
            batchId: batch.authoritySha256,
            toolCallIds,
            authorizedToolCallIds,
            successfulToolCallIds,
          };
          if (sourceObligationCapability) {
            await sourceObligationCapability.settle({
              ...settlement,
              failedToolCallIds: failedRefusalToolCallIds,
            });
          } else {
            await input.qualityAnswerRecords!.settle(settlement);
          }
        })
        .catch((error: unknown) => {
          answerRecordSettlementFailure ??= error;
          sessionEventError ??= error;
          session.abort();
        });
    };
    // The settled reply the decoders see. It leaves this method as structure,
    // not text: its fingerprint on a contract rejection, and undeclared
    // judgment-row key counts on an accepted judgment.
    let decodedReply: string | undefined;
    // Continuation turns spent on a cut answer. The outer catch reads it to
    // decline, rather than retry, a decode failure of the stitched reply.
    let lengthStopContinuations = 0;
    // On the tool-call answer path, the span a refusal retains: the raw
    // submission arguments, or the report reply. `undefined` keeps the step's
    // own decoder span.
    let rejectedSpan: string | undefined;
    // The decoded member strings of a refused submission: retention screens
    // them as well as the raw span, since an inner escape can hide a credential.
    let rejectedInnerTexts: readonly string[] = [];
    try {
      // Keep all streamed text for credential screening, composition byte limits,
      // onText consumers, and ordinary summaries. Structured decoders receive
      // only the exact settled, tool-free terminal assistant message.
      let response = "";
      let terminalResponse = "";
      let rawToolArgumentCapture = "";
      const answerNowPolicy = resolveAnswerNowPolicy(this.options.limits);
      const answerNowPlan = stepAnswerNowPlan(
        input.step.id,
        this.executionProfile.profile.maxOutputTokens,
        this.options.limits,
      );
      // `undefined` when the budget does not arm: no attempt timer, or a step
      // whose answer the host cannot degrade.
      const recordAnswerPlan = input.qualityAnswerNowRecordsPlan;
      const attemptAnswerNowFlipAtMs =
        !input.qualityAnswerRecords && answerNowAppliesTo(input)
          ? answerNowFlipAtMs(attemptTimeoutMs, answerNowPolicy, answerNowPlan)
          : undefined;
      // Every other read-only step still calling tools once only its answer
      // reserve remains is asked to conclude, so a loop of distinct reads does
      // not run into the attempt timer. `undefined` when it does not arm.
      const attemptDeadlineConcludeAtMs =
        !input.qualityAnswerRecords && concludeBeforeDeadlineAppliesTo(input)
          ? concludeBeforeDeadlineAtMs(attemptTimeoutMs, answerNowPolicy, answerNowPlan)
          : undefined;
      let answerNowMode = false;
      let recordsAnswerNowMode = false;
      const recordsAnswerNowFlipForCurrentState = () => {
        if (!recordAnswerPlan || !input.qualityAnswerRecordProgress) return undefined;
        try {
          const progress = input.qualityAnswerRecordProgress();
          const remainingPlan = deriveAnswerSubmissionRemainingPlan({
            fixtureRows: recordAnswerPlan.fixtureRows,
            remainingKeys: progress.remainingKeys,
            completedKeys: progress.completedKeys,
            openSets: progress.openSets,
            complete: progress.complete,
            qualifiedMessageBudget: recordAnswerPlan.qualifiedMessageBudget,
          });
          if (remainingPlan.missingRequiredKeys.length > 0) return undefined;
          return deriveRecordsAnswerNowFlip({
            attemptTimeoutMs,
            elapsedShareBasisPoints: answerNowPolicy.elapsedShareBasisPoints,
            dFullMs: recordAnswerPlan.dFullMs,
            reportDecodeReserveMs: recordAnswerPlan.reportDecodeReserveMs,
            openPlanBytes: remainingPlan.openPlanBytes,
            fullPlanBytes: recordAnswerPlan.fullPlanBytes,
            remainingMessages: remainingPlan.remainingMessages,
            turnLatencyMs: recordAnswerPlan.turnLatencyMs,
            d3ResidualFires: recordAnswerPlan.d3ResidualFires,
          });
        } catch {
          // The answer-now boundary fails closed when a sealed plan or ledger
          // projection is absent or inconsistent; it never guesses a reserve.
          return undefined;
        }
      };
      const initialRecordsAnswerNowFlip =
        input.qualityAnswerRecords && recordAnswerPlan
          ? (() => {
              try {
                const progress = input.qualityAnswerRecordProgress?.();
                if (!progress) return undefined;
                const fullPlan = deriveAnswerSubmissionRemainingPlan({
                  fixtureRows: recordAnswerPlan.fixtureRows,
                  remainingKeys: progress.requiredKeys,
                  completedKeys: [],
                  openSets: progress.openSets.map((entry) => ({ ...entry, open: true })),
                  complete: false,
                  qualifiedMessageBudget: recordAnswerPlan.qualifiedMessageBudget,
                });
                if (
                  fullPlan.missingRequiredKeys.length > 0 ||
                  fullPlan.openPlanBytes !== recordAnswerPlan.fullPlanBytes ||
                  fullPlan.remainingMessages !== recordAnswerPlan.fullPlanMessages
                ) {
                  return undefined;
                }
                return deriveRecordsAnswerNowFlip({
                  attemptTimeoutMs,
                  elapsedShareBasisPoints: answerNowPolicy.elapsedShareBasisPoints,
                  dFullMs: recordAnswerPlan.dFullMs,
                  reportDecodeReserveMs: recordAnswerPlan.reportDecodeReserveMs,
                  openPlanBytes: recordAnswerPlan.fullPlanBytes,
                  fullPlanBytes: recordAnswerPlan.fullPlanBytes,
                  remainingMessages: recordAnswerPlan.fullPlanMessages,
                  turnLatencyMs: recordAnswerPlan.turnLatencyMs,
                  d3ResidualFires: recordAnswerPlan.d3ResidualFires,
                });
              } catch {
                return undefined;
              }
            })()
          : undefined;
      const recordsAnswerNowWasArmedAtStart = initialRecordsAnswerNowFlip?.armed === true;
      // A conclude-now retry (its rule in the catalog) asks for the answer at
      // the first re-read the read-evidence ledger withholds, not on a timer.
      const concludeNowRetry = concludesNow(input.responseCorrection?.retryRule);
      let concludeNowEvidence: InferenceConcludeNowEvidenceV1 | undefined;
      let finalAnswerValid = false;
      let turnStartedAt = Date.now();
      let observedProviderTurnsStarted = 0;
      let observedProviderTurnsSettled = 0;
      let observedToolExecutionsStarted = 0;
      let observedToolExecutionsSettled = 0;
      type MutableActivityCounts = { started: number; settled: number; errorResults: number };
      const toolActivityCounts: Record<ToolActivityCategory, MutableActivityCounts> = {
        answerRecord: { started: 0, settled: 0, errorResults: 0 },
        reportSubmission: { started: 0, settled: 0, errorResults: 0 },
        candidateValidation: { started: 0, settled: 0, errorResults: 0 },
        readSearch: { started: 0, settled: 0, errorResults: 0 },
        other: { started: 0, settled: 0, errorResults: 0 },
      };
      const eventActivityCategory = (toolName: string): ToolActivityCategory =>
        toolActivityCategory(
          grantedToolNames.has(toolName)
            ? normalizeObservedToolName(toolName, grantedToolNames)
            : "",
        );
      const snapshotToolActivity = (): InferenceProgressToolActivityV1 =>
        Object.freeze(
          Object.fromEntries(
            Object.entries(toolActivityCounts).map(([category, counts]) => [
              category,
              Object.freeze({ ...counts }),
            ]),
          ) as unknown as InferenceProgressToolActivityV1,
        );
      const emitProgress = (
        event:
          | "provider-turn-started"
          | "provider-turn-settled"
          | "tool-execution-started"
          | "tool-execution-settled",
        phase:
          | "provider-turn-pending"
          | "provider-turn-settled"
          | "tool-execution-active"
          | "tool-execution-settled",
      ): void => {
        if (!input.onProgress) return;
        try {
          const stats = session.getSessionStats();
          input.onProgress({
            schemaVersion: 1,
            kind: "docsfab-inference-progress-observation",
            attempt: input.inferenceAttempt ?? 1,
            observedAt: new Date().toISOString(),
            event,
            phase,
            providerTurns: {
              started: observedProviderTurnsStarted,
              settled: observedProviderTurnsSettled,
            },
            toolExecutions: {
              started: observedToolExecutionsStarted,
              settled: observedToolExecutionsSettled,
            },
            toolActivity: snapshotToolActivity(),
            usage: {
              input: stats.tokens.input,
              output: stats.tokens.output,
              cacheRead: stats.tokens.cacheRead,
              cacheWrite: stats.tokens.cacheWrite,
              total: stats.tokens.total,
              turns: observedProviderTurnsSettled,
            },
          });
        } catch {
          // Observability must not change Pi execution or inference authority.
        }
      };
      let turnCaptureBytes = 0;
      // Retained prefix of a structured answer cut at the output limit, and
      // whether the settled prompt owes one more continuation turn.
      let retainedTruncatedAnswer = "";
      let continuationPending = false;
      let qualityRecordContinuationPrompt: string | undefined;
      // The judgment answer the host completes instead of declining, and the
      // output each length-stopped answer turn billed, for its note.
      let cutJudgment: CutJudgmentAnswer | undefined;
      const answerTurnOutputTokens: (number | undefined)[] = [];
      let governanceStops = 0;
      let preExecutionRejections = 0;
      const preExecutionRejectionTurns = new Set<string>();
      let terminalPreExecutionRejection:
        | { turnKey: string; turn: number; count: number }
        | undefined;
      // The tool-call answer path. `submissionState` changes only when
      // a submission's turn settles. `submitTurnInProgress` marks a turn whose
      // submission arguments were streaming and that has not settled; the
      // record reports it as `in-flight` when the attempt ends there.
      let submissionState: Exclude<InferenceAnswerSubmissionState, "in-flight"> = "absent";
      let submissionMembers: QualitySubmissionMembers | undefined;
      let submissionBytes = 0;
      let submissionWithheld = false;
      let submitTurnInProgress = false;
      let reportAsked = false;
      let reportOutcome:
        | Extract<InferenceAnswerReportTurnState, "admitted" | "refused" | "authority-stopped">
        | undefined;
      // The first governed turn after the report ask, for the clamp reading.
      let reportTurnsFrom = 0;
      let reportCapturedBytes = 0;
      // Refusals recorded at turn settlement; the attempt rethrows them whole
      // rather than as a provider failure.
      const settlementRefusals = new WeakSet<object>();
      let leaseUniqueSuccesses = new Set<string>();
      let leaseFailures = 0;
      const grantedToolNames = new Set<string>(grantedTools);
      let unknownToolFailures = 0;
      const toolActivity = new Map<string, { calls: number; failures: number }>();
      interface ActiveBatch {
        authoritySha256: string;
        calls: Array<{ id: string; name: string; sha256: string }>;
        authorized: string[];
        hostDenied: Set<string>;
        /** Finalized tool results keyed by the exact assistant call identity. */
        observedResults: Map<string, "succeeded" | "failed">;
        preflighted: Set<string>;
        /** First call denied after the coordinator granted this batch. */
        deniedBoundaryIndex?: number;
        /** First unexecuted call after a host hook/runtime failure. */
        terminalBoundaryIndex?: number;
        pendingTerminalReason?: Exclude<ExecutionTerminalReason, "completed">;
        pendingError?: unknown;
        usage: PiProviderTurnUsageV1;
        settled: boolean;
        /** Whether this attempt's ledger has a tombstone for the settlement. */
        settlementRecorded: boolean;
        /**
         * The calls the host requested as denied, each with the refusal the
         * model sees: after the answer-now ask, after an admitted submission,
         * or a second submission in one turn. Per call, so a conclude-now
         * batch can run its submission and deny the rest.
         */
        deniedReasons: ReadonlyMap<string, string>;
      }
      const batches = new Map<string, ActiveBatch>();
      const answerRecordBatchPreparations = new Map<string, Promise<void>>();
      const studyScratch = new Map<string, StudyCallScratch>();
      const turnAuthorities = new Map<string, string>();
      const batchSettlementLedger = new PiAttemptBatchSettlementLedger();
      // Later turns can reuse a provider tool-call ID, so each execution event
      // routes through the authority and ordinal captured by beforeToolCall.
      const toolCallAuthorities = new Map<
        string,
        Array<{ authoritySha256: string; ordinal: number }>
      >();
      const registerToolCallAuthority = (
        toolCallId: string,
        identity: { authoritySha256: string; ordinal: number },
      ): void => {
        const pending = toolCallAuthorities.get(toolCallId) ?? [];
        pending.push(identity);
        toolCallAuthorities.set(toolCallId, pending);
      };
      let batchSequence = 0;
      const activeBatch = (): ActiveBatch | undefined => {
        const active = [...batches.values()].filter((batch) => !batch.settled);
        if (active.length > 1) {
          throw new Error("Pi execution lease observed more than one active tool batch.");
        }
        return active[0];
      };
      const consumeBatch = (batch: ActiveBatch): void => {
        batch.settled = true;
      };
      const recordExecutedResults = (
        batch: ActiveBatch,
        results: readonly {
          callSha256: string;
          outcome: "succeeded" | "failed";
        }[],
      ): void => {
        for (const result of results) {
          const call = batch.calls.find((candidate) => candidate.sha256 === result.callSha256);
          if (!call) throw new Error("Pi execution lease lost an executed tool identity.");
          const name = normalizeObservedToolName(call.name, grantedToolNames);
          const activity = toolActivity.get(name) ?? { calls: 0, failures: 0 };
          activity.calls += 1;
          if (result.outcome === "failed") {
            activity.failures += 1;
            if (name === "unknown-tool") unknownToolFailures += 1;
          }
          toolActivity.set(name, activity);
        }
        const study = this.options.study;
        const runId = input.runId;
        if (!study || !runId || results.length === 0) return;
        const settledAt = new Date();
        const t = settledAt.toISOString();
        const nowMs = settledAt.valueOf();
        const events = results.map((result) => {
          const scratch = studyScratch.get(result.callSha256);
          const call = batch.calls.find((candidate) => candidate.sha256 === result.callSha256);
          const tool = scratch?.tool ?? normalizeObservedToolName(call?.name, grantedToolNames);
          return createStudyEvent({
            t,
            runId,
            workflow: input.workflow.name,
            stepId: input.step.id,
            tool,
            disposition: result.outcome,
            durationMs: scratch ? Math.max(0, nowMs - scratch.startedAt) : 0,
            scheduled: scratch?.scheduled ?? false,
            ...(scratch?.targetNodeId !== undefined
              ? { targetNodeId: scratch.targetNodeId }
              : { pathClass: scratch?.pathClass ?? "other" }),
          });
        });
        studyWrite = studyWrite.then(async () => {
          for (const event of events) {
            await study.recordSettlement(event);
          }
        });
      };
      // Useful progress for lease renewal: a success that brought new read
      // evidence, or any other successful tool. An unchanged re-read under a
      // fresh call ID is not progress.
      const admitLeaseProgress = (
        batch: ActiveBatch,
        results: readonly { callSha256: string; outcome: "succeeded" | "failed" }[],
      ): void => {
        for (const result of results) {
          const call = batch.calls.find((candidate) => candidate.sha256 === result.callSha256);
          const evidence = call ? readEvidence.takeClassification(call.id) : undefined;
          if (result.outcome !== "succeeded") {
            leaseFailures += 1;
          } else if (isUsefulProgress(evidence)) {
            leaseUniqueSuccesses.add(result.callSha256);
          }
        }
      };
      const tombstoneBatch = (
        batch: ActiveBatch,
        results: readonly {
          callSha256: string;
          outcome: "succeeded" | "failed";
        }[],
      ): "settle" | "duplicate-settle" => {
        const classification = batchSettlementLedger.settle(batch.authoritySha256, results);
        if (classification.kind === "conflict") {
          throw new Error("Pi execution lease observed conflicting settled tool evidence.");
        }
        return classification.kind;
      };
      const observedAuthorizedPrefix = (
        batch: ActiveBatch,
      ): Array<{ callSha256: string; outcome: "succeeded" | "failed" }> => {
        const boundary = Math.min(
          batch.deniedBoundaryIndex ?? batch.calls.length,
          batch.terminalBoundaryIndex ?? batch.calls.length,
        );
        const eligible = batch.authorized.filter((digest) => {
          const index = batch.calls.findIndex((call) => call.sha256 === digest);
          return index >= 0 && index < boundary;
        });
        const results: Array<{
          callSha256: string;
          outcome: "succeeded" | "failed";
        }> = [];
        let missing = false;
        for (const digest of eligible) {
          const outcome = batch.observedResults.get(digest);
          if (outcome === undefined) {
            missing = true;
            continue;
          }
          if (missing) {
            throw new Error("Pi execution lease observed a non-prefix partial tool settlement.");
          }
          results.push({ callSha256: digest, outcome });
        }
        return results;
      };
      const settleObservedBatch = (batch: ActiveBatch): void => {
        // The host has complete authority only after it has processed every
        // proposed call and observed every result it authorized. This keeps a
        // later preflight denial from being hidden by an early tool result.
        if (
          batch.settled ||
          batch.preflighted.size !== batch.calls.length ||
          batch.pendingTerminalReason !== undefined ||
          batch.hostDenied.size > 0 ||
          !batch.authorized.every((digest) => batch.observedResults.has(digest))
        ) {
          return;
        }
        if (executionLease.coordinator.phase !== "batch-pending") {
          throw new Error("Pi execution lease could not settle a host-observed tool batch.");
        }
        const results = batch.authorized.map((callSha256) => ({
          callSha256,
          outcome: batch.observedResults.get(callSha256)!,
        }));
        executionLease.settleToolBatch(results, batch.usage);
        if (tombstoneBatch(batch, results) !== "settle") {
          throw new Error("Pi execution lease rejected a duplicate host-observed settlement.");
        }
        batch.settlementRecorded = true;
        admitLeaseProgress(batch, results);
        recordExecutedResults(batch, results);
        consumeBatch(batch);
      };
      const observeToolResult = (toolCallId: string, isError: boolean): void => {
        const pending = toolCallAuthorities.get(toolCallId);
        const identity = pending?.shift();
        if (pending?.length === 0) toolCallAuthorities.delete(toolCallId);
        if (!identity) return;
        const batch = batches.get(identity.authoritySha256);
        const call = batch?.calls[identity.ordinal];
        if (!batch || !call || call.id !== toolCallId) {
          throw new Error("Pi execution lease lost an authority-scoped tool identity.");
        }
        // A replayed beforeToolCall is blocked before host execution. Its
        // eventual turn_end is compared with this immutable tombstone; it must
        // not mutate the prior observation while that comparison is pending.
        if (batch.settled) return;
        const ordinal = identity.ordinal;
        const boundary = Math.min(
          batch.deniedBoundaryIndex ?? batch.calls.length,
          batch.terminalBoundaryIndex ?? batch.calls.length,
        );
        // Pi emits synthetic error results for calls rejected by preflight.
        // They are not executions and therefore never enter the observed prefix.
        if (ordinal >= boundary) return;
        const outcome = isError ? ("failed" as const) : ("succeeded" as const);
        const prior = batch.observedResults.get(call.sha256);
        if (prior !== undefined && prior !== outcome) {
          throw new Error("Pi execution lease observed conflicting tool results.");
        }
        batch.observedResults.set(call.sha256, outcome);
        settleObservedBatch(batch);
      };
      const drainPendingBatch = (
        batch: ActiveBatch,
        reason: Exclude<ExecutionTerminalReason, "completed">,
      ): void => {
        if (executionLease.coordinator.phase !== "batch-pending") {
          throw new Error("Pi execution lease could not drain a non-pending tool batch.");
        }
        const results = observedAuthorizedPrefix(batch);
        const effectiveBoundary = Math.min(
          batch.deniedBoundaryIndex ?? batch.calls.length,
          batch.terminalBoundaryIndex ?? batch.calls.length,
        );
        const boundaryCall =
          batch.deniedBoundaryIndex !== effectiveBoundary
            ? undefined
            : batch.calls[effectiveBoundary];
        const lateDenied =
          boundaryCall && batch.authorized.includes(boundaryCall.sha256)
            ? boundaryCall.sha256
            : undefined;
        executionLease.failToolBatch(results, batch.usage, reason, lateDenied);
        recordExecutedResults(batch, results);
        consumeBatch(batch);
      };
      const drainPendingBatchForRecords = (
        batch: ActiveBatch,
        reason: Exclude<ExecutionTerminalReason, "completed">,
      ): Array<{ callSha256: string; outcome: "succeeded" | "failed" }> => {
        try {
          const results = observedAuthorizedPrefix(batch);
          drainPendingBatch(batch, reason);
          return results;
        } catch (error) {
          // If the executed prefix cannot be established, release the captured
          // record batch without authorizing any durable row write.
          queueAnswerRecordSettlement(batch, []);
          throw error;
        }
      };
      const stopExecution = (
        reason: Exclude<ExecutionTerminalReason, "completed">,
        disposition?: Exclude<ExecutionLeaseRuntimeTerminalDisposition, "completed">,
      ): void => {
        if (executionLease.coordinator.phase === "batch-pending") {
          const batch = activeBatch();
          if (!batch) {
            throw new Error("Pi execution lease lost its pending tool batch.");
          }
          const results = drainPendingBatchForRecords(batch, reason);
          queueAnswerRecordSettlement(batch, results);
          return;
        }
        executionLease.stop(reason, disposition);
      };
      const turnContext = (): ExecutionContextObservationV1 => {
        const turn = connection.turnGovernance?.evidence().at(-1);
        return {
          status: turn?.decision === "stop" ? "exhausted" : "ready",
          availableInputTokens: Math.max(
            0,
            leaseAvailableInputTokens(
              this.executionProfile,
              executionLease.coordinator.policy.schemaVersion === 1
                ? executionLease.coordinator.policy.cumulative.maxInputTokens
                : this.executionProfile.profile.maxInputTokens,
              turn?.availableInputTokens,
            ),
          ),
          requiredInputTokens: Math.max(
            1,
            turn?.estimatedInputTokens ?? this.executionProfile.requestPolicy.minimumOutputTokens,
          ),
          authoritySha256: executionLease.coordinator.identity.contextAuthoritySha256,
        };
      };
      const producedOutputTokens: (number | undefined)[] = [];
      const producedFinishReasons: unknown[] = [];
      let lastLandedTurnTelemetry: LandedProviderTurnTelemetry | undefined;
      let providerLatencyMs = 0;
      /**
       * Usage charged to the lease for one governed provider turn. Tokens from
       * turns discarded by in-turn replay fold into the turn that landed, because
       * the lease's turn count is validated against one ledger entry per request.
       * Unattributable produced tokens stay unknown, not 0 or the grant.
       */
      const chargedProviderUsage = (
        message: object,
        compactions: number,
      ): PiProviderTurnUsageV1 => {
        const usage = providerUsage(
          message,
          Date.now() - turnStartedAt,
          turnContext(),
          compactions,
        );
        const discarded = connection.discardedProviderUsage?.drain();
        const charged =
          !discarded || discarded.turns === 0
            ? usage
            : {
                ...usage,
                inputTokens: usage.inputTokens + discarded.inputTokens,
                outputTokens: usage.outputTokens + discarded.outputTokens,
              };
        producedOutputTokens.push(
          attributedProducedOutputTokens(
            message,
            discarded && discarded.turns > 0 ? discarded.outputTokens : 0,
          ),
        );
        producedFinishReasons.push((message as { rawStopReason?: unknown }).rawStopReason);
        lastLandedTurnTelemetry = observeLandedProviderTurn(
          message,
          connection.providerTransport?.lastExchange(),
        );
        return charged;
      };
      const blankProviderTurns = (): number =>
        connection.turnGovernance?.evidence().at(-1)?.providerBlankTurns ?? 0;
      const providerAttempts = (): number =>
        (connection.turnGovernance?.evidence().at(-1)?.providerRetries ?? 0) + 1;
      /**
       * Output budget the settling turn was authorized with: the per-turn grant,
       * or the profile ceiling when no governor ran. Not `turn.outputTokens`,
       * which records tokens produced, not the ceiling.
       */
      const outputTokenLimit = (): number => {
        const turn = connection.turnGovernance?.evidence().at(-1);
        return turn && turn.decision !== "stop"
          ? grantedTurnOutputTokens(turn)
          : this.executionProfile.profile.maxOutputTokens;
      };
      /**
       * The lease clamp on the settling turn, when cumulative output authority
       * bound it, so the truncation hint names the lease values, not `maxOutputTokens`.
       */
      const outputLeaseClamp = (): OutputLeaseClamp | undefined => {
        const authority = connection.turnGovernance?.evidence().at(-1)?.outputAuthority;
        return authority === undefined
          ? undefined
          : {
              remainingOutputTokens: authority.maxOutputTokens - authority.cumulativeOutputTokens,
              maxOutputTokens: authority.maxOutputTokens,
            };
      };
      // Rejected length-stopped tool batches spend provider turns even though
      // no tool executes. Let the admitted envelope fund recovery; an explicit
      // lower allowance can stop the consecutive sequence sooner.
      let consecutiveLengthStoppedToolTurns = 0;
      const proxyRefusedTurns = new WeakMap<Error, OutboundProxyRefusal>();
      const credentialRefusedTurns = new WeakMap<Error, CredentialBoundaryError>();
      const responseLimitRefusedTurns = new WeakMap<Error, ProviderResponseLimitError>();
      /**
       * Carries the provider's classification structurally. DocsFab's message
       * prefix hides the leading status `classifyModelFailure` reads; it returns
       * an `InferenceStepError`'s classification unchanged.
       */
      const providerTurnError = (text: string, failure: PiAssistantTurnFailure): Error => {
        const responseLimit = connection.providerTransport?.lastResponseLimitRefusal?.();
        const error = failure.classification
          ? new InferenceStepError(
              text,
              failure.classification.category,
              failure.classification.retryable,
              undefined,
              failure.rejection,
              failure.condition ? { condition: failure.condition } : undefined,
            )
          : new Error(text);
        // Pi reports a proxy refusal as a generic connection error. Bind the
        // refusal of this turn's last request to the error that reports the
        // turn, so the attempt can name it only when this error ends it.
        const proxyRefusal = connection.providerTransport?.lastProxyRefusal();
        if (proxyRefusal) proxyRefusedTurns.set(error, proxyRefusal);
        // Likewise a credential-isolation refusal of the request payload or
        // the provider's response (#1807).
        const credentialRefusal = connection.providerTransport?.lastCredentialRefusal?.();
        if (credentialRefusal) credentialRefusedTurns.set(error, credentialRefusal);
        if (responseLimit) {
          responseLimitRefusedTurns.set(error, responseLimit);
          Object.defineProperty(error, "cause", {
            value: responseLimit,
            enumerable: false,
            writable: false,
            configurable: false,
          });
        }
        return error;
      };
      /**
       * Operator message for exhausted cumulative output authority, derived
       * from the governor's stop turn so it matches the record beside it.
       */
      const describeOutputAuthorityExhaustion = (): string => {
        const authority = connection.turnGovernance?.evidence().at(-1)?.outputAuthority;
        const { policy, state } = executionLease.coordinator;
        const maxOutputTokens =
          authority?.maxOutputTokens ??
          (policy.schemaVersion === 1
            ? policy.cumulative.maxOutputTokens
            : this.executionProfile.profile.maxOutputTokens);
        const cumulativeOutputTokens =
          authority?.cumulativeOutputTokens ?? state.cumulativeOutputTokens;
        const floorOutputTokens =
          authority?.floorOutputTokens ??
          this.executionProfile.requestPolicy.minimumOutputTokens + OUTPUT_AUTHORITY_FLOOR_TOKENS;
        return (
          `Output authority exhausted [output-authority-exhausted]: step ${input.step.id} used ` +
          `${cumulativeOutputTokens} of ${maxOutputTokens} cumulative output tokens; the ` +
          `${maxOutputTokens - cumulativeOutputTokens} remaining are below the ` +
          `${floorOutputTokens}-token floor, so no further provider turn was requested.`
        );
      };
      const assertCompositionProviderMessage = (message: object): void => {
        if (!this.executionProfile.compositionPolicy) return;
        assertModelResponseCredentialFree(message);
        const observed = message as { provider?: unknown; model?: unknown };
        if (
          observed.provider !== this.executionProfile.providerId ||
          observed.model !== this.executionProfile.modelId
        ) {
          throw new Error(
            "Composition provider response identity does not match the selected model composition.",
          );
        }
      };
      const existingBeforeToolCall = this.options.beforeToolCall ?? session.agent.beforeToolCall;
      session.agent.beforeToolCall = async (context, signal) => {
        assertCompositionProviderMessage(context.assistantMessage);
        const providerTurn =
          connection.turnGovernance?.evidence().filter((turn) => turn.decision !== "stop").length ??
          0;
        const assistantSha256 = assistantAuthoritySha256(context.assistantMessage);
        const turnKey = `${input.inferenceAttempt ?? 1}:${providerTurn}:${assistantSha256}`;
        const existingAuthority = turnAuthorities.get(turnKey);
        let batch = existingAuthority ? batches.get(existingAuthority) : undefined;
        if (batch?.settled) {
          const ordinal = batch.calls.findIndex((call) => call.id === context.toolCall.id);
          if (ordinal < 0) {
            throw new Error("Pi execution lease rejected a replay with a foreign tool call.");
          }
          // A batch whose calls were all requested as denied settles on
          // request, so its later calls arrive here too. Refuse each with its
          // own reason, not as a replay, and count it once as a governance stop
          // so the record matches the turn ledger.
          const refused = batch.calls[ordinal]!;
          const deniedReason = batch.deniedReasons.get(refused.sha256);
          if (deniedReason !== undefined) {
            if (!batch.preflighted.has(refused.sha256)) {
              batch.preflighted.add(refused.sha256);
              governanceStops += 1;
            }
            return { block: true, reason: deniedReason };
          }
          return {
            block: true,
            reason: "DocsFab withheld a replayed settled tool call from host execution.",
          };
        }
        if (!batch && activeBatch()) {
          // A distinct authority may not overlap the pending batch. Preserve
          // the observed prefix and terminate before a second batch can apply.
          stopExecution("evidence-preservation-required");
          throw new Error(
            "Pi execution lease rejected overlapping tool batches within one attempt.",
          );
        }
        if (
          batch?.deniedBoundaryIndex !== undefined ||
          batch?.terminalBoundaryIndex !== undefined
        ) {
          governanceStops += 1;
          return {
            block: true,
            reason: "DocsFab withheld the suffix after a host preflight stop.",
          };
        }
        if (!batch) {
          const calls = assistantToolCalls(context.assistantMessage).map((call, ordinal) => ({
            ...call,
            sha256: digestPiToolCall(call.id, call.name, ordinal),
          }));
          try {
            validatePiBatchCalls(calls);
          } catch (error) {
            if (executionLease.coordinator.phase !== "terminal") {
              const usage = chargedProviderUsage(context.assistantMessage, 0);
              if (executionLease.coordinator.phase === "active") {
                executionLease.settleOrdinaryProviderTurn(usage);
              }
              stopExecution("authorization-denied");
            }
            throw error;
          }
          const authoritySha256 = createPiBatchAuthoritySha256({
            inferenceAttempt: input.inferenceAttempt ?? 1,
            providerTurn,
            sequence: ++batchSequence,
            assistantSha256,
            calls,
          });
          turnAuthorities.set(turnKey, authoritySha256);
          const compactions = Math.max(
            0,
            (connection.turnGovernance?.evidence().filter((turn) => turn.decision === "compact")
              .length ?? 0) - executionLease.coordinator.state.compactions,
          );
          const usage = chargedProviderUsage(context.assistantMessage, compactions);
          // After the answer-now ask, every call is requested as denied; this is
          // where tools are withdrawn, since the request still offers them. The
          // flag changes only between turns, so no batch straddles the ask. A
          // denied-only batch reserves nothing and settles on the ordinary path.
          // On the tool-call answer path the decision is per call: under the
          // ask the turn's first submission still runs, after an admitted
          // submission every call is denied, and a second submission in one
          // turn is denied.
          const deniedReasons = new Map<string, string>();
          const firstSubmission = toolPath
            ? calls.findIndex((call) => call.name === QUALITY_SUBMISSION_TOOL_NAME)
            : -1;
          for (const [index, call] of calls.entries()) {
            const reason =
              toolPath && submissionState === "admitted"
                ? OUTPUT_HOST_TEXT["quality-submission-report-turn-refusal"]
                : recordsAnswerNowMode
                  ? call.name === QUALITY_ANSWER_RECORD_TOOL_NAME
                    ? undefined
                    : PI_ANSWER_NOW_TOOL_REFUSAL
                  : answerNowMode
                    ? index === firstSubmission
                      ? undefined
                      : PI_ANSWER_NOW_TOOL_REFUSAL
                    : call.name === QUALITY_SUBMISSION_TOOL_NAME && index !== firstSubmission
                      ? OUTPUT_HOST_TEXT["quality-submission-extra-call-refusal"]
                      : undefined;
            if (reason !== undefined) deniedReasons.set(call.sha256, reason);
          }
          // On a conclude-now retry a denied call makes no progress, so it
          // spends the read-loop stop's notice-only allowance.
          if (
            (answerNowMode || recordsAnswerNowMode) &&
            concludeNowRetry &&
            submissionState !== "admitted"
          ) {
            readEvidence.recordDeniedAfterAsk(deniedReasons.size);
          }
          const authorizations = calls.map((call) => ({
            callSha256: call.sha256,
            authorization: deniedReasons.has(call.sha256)
              ? ("denied" as const)
              : ("execute" as const),
            ...(executionLease.coordinator.policy.schemaVersion === 2 ||
            executionLease.coordinator.policy.answerRecordCallCeiling !== undefined
              ? {
                  scope:
                    call.name === QUALITY_ANSWER_RECORD_TOOL_NAME
                      ? ("answer-record" as const)
                      : ("reading" as const),
                }
              : {}),
          }));
          const executableCount = authorizations.filter(
            (call) => call.authorization === "execute",
          ).length;
          const decision = executionLease.requestToolBatch(
            authorizations,
            executableCount > 0
              ? reservationForTurn(usage, executableCount)
              : {
                  kind: "ordinary",
                  toolCalls: 0,
                  providerTurns: 0,
                  compactions: 0,
                  inputTokens: 0,
                  outputTokens: 0,
                  elapsedMs: 0,
                  contextInputTokens: 0,
                },
          );
          const executable = calls.filter(
            (call) =>
              authorizations.find((candidate) => candidate.callSha256 === call.sha256)
                ?.authorization === "execute",
          );
          batch = {
            authoritySha256,
            calls,
            authorized: executable
              .slice(0, decision.authorizedToolCalls)
              .map((call) => call.sha256),
            hostDenied: new Set(),
            observedResults: new Map(),
            preflighted: new Set(),
            usage,
            settled: decision.authorizedToolCalls === 0,
            settlementRecorded: false,
            deniedReasons,
          };
          batches.set(authoritySha256, batch);
        }
        if (answerRecordCapability) {
          const recordCalls = batch.calls.filter(
            (call) => call.name === QUALITY_ANSWER_RECORD_TOOL_NAME,
          );
          if (recordCalls.length > 0) {
            // A prior assistant message may still be writing its settled
            // authorized prefix. Do not prepare this message against a stale
            // in-memory ledger or overlap the session's active batch.
            await answerRecordSettlement;
            if (answerRecordSettlementFailure !== undefined) {
              throw answerRecordSettlementFailure;
            }
            let preparation = answerRecordBatchPreparations.get(batch.authoritySha256);
            if (!preparation) {
              preparation = answerRecordCapability.prepareBatch({
                batchId: batch.authoritySha256,
                toolCalls: recordCalls.map((call) => ({
                  toolCallId: call.id,
                  rawArguments: rawToolCalls.textOfCall(call.id),
                })),
                authorizedToolCallIds: recordCalls.flatMap((call) =>
                  batch.authorized.includes(call.sha256) ? [call.id] : [],
                ),
              });
              answerRecordBatchPreparations.set(batch.authoritySha256, preparation);
            }
            await preparation;
            if (answerRecordSettlementFailure !== undefined) throw answerRecordSettlementFailure;
          }
        }
        const ordinal = batch.calls.findIndex((call) => call.id === context.toolCall.id);
        const call = ordinal >= 0 ? batch.calls[ordinal] : undefined;
        if (call) {
          registerToolCallAuthority(context.toolCall.id, {
            authoritySha256: batch.authoritySha256,
            ordinal,
          });
          studyScratch.set(
            call.sha256,
            scratchFromToolCall(
              normalizeObservedToolName(call.name, grantedToolNames),
              context.toolCall,
              Date.now(),
            ),
          );
        }
        let existingResult: Awaited<ReturnType<PiBeforeToolCall>>;
        try {
          existingResult = await existingBeforeToolCall?.(context, signal);
        } catch (error) {
          if (!call) throw error;
          batch.terminalBoundaryIndex =
            batch.terminalBoundaryIndex === undefined
              ? ordinal
              : Math.min(batch.terminalBoundaryIndex, ordinal);
          batch.pendingTerminalReason = "evidence-preservation-required";
          batch.pendingError = error;
          governanceStops += 1;
          return {
            block: true,
            reason: "DocsFab stopped this tool call after a host preflight failure.",
          };
        }
        if ((signal?.aborted || input.signal?.aborted) && call) {
          batch.terminalBoundaryIndex =
            batch.terminalBoundaryIndex === undefined
              ? ordinal
              : Math.min(batch.terminalBoundaryIndex, ordinal);
          batch.pendingTerminalReason = "cancellation-requested";
          batch.pendingError = new Error("Pi tool preflight was cancelled.");
          governanceStops += 1;
          return {
            block: true,
            reason: "DocsFab stopped this tool call after cancellation.",
          };
        }
        if (call) batch.preflighted.add(call.sha256);
        if (existingResult?.block && call) {
          batch.hostDenied.add(call.sha256);
          batch.deniedBoundaryIndex =
            batch.deniedBoundaryIndex === undefined
              ? ordinal
              : Math.min(batch.deniedBoundaryIndex, ordinal);
        }
        if (!call || !batch.authorized.includes(call.sha256)) {
          settleObservedBatch(batch);
          governanceStops += 1;
          return existingResult?.block
            ? existingResult
            : {
                block: true,
                reason:
                  (call && batch.deniedReasons.get(call.sha256)) ??
                  "DocsFab withheld this tool call at an execution-lease boundary.",
              };
        }
        return existingResult;
      };
      const hostProgressRecommendation = (): PiProgressRecommendationV1 => {
        return recommendPiProgress({
          leaseNumber: executionLease.coordinator.state.leaseNumber,
          uniqueSuccessfulCalls: leaseUniqueSuccesses.size,
          failedCalls: leaseFailures,
          executedCalls: executionLease.coordinator.state.leaseExecutedToolCalls,
          ...(input.experimentalAnswerRecordDiscoveryRenewal === true
            ? { experimentalAnswerRecordDiscoveryRenewal: true as const }
            : {}),
        });
      };
      const applyAccountedHostCheckpoint = () => {
        let decision;
        try {
          decision = executionLease.applyHostCheckpoint(
            hostProgressRecommendation(),
            nextTranche(executionLease),
          );
        } catch (error) {
          if (!(error instanceof ExecutionLeaseCoordinatorError)) throw error;
          const failure = new InferenceStepError(
            "The host execution-lease coordinator rejected a checkpoint transition.",
            "host-runtime-failure",
            false,
            collectAttemptEvidence(),
            undefined,
            {
              hostFailureOrigin: {
                schemaVersion: 1,
                origin: "execution-lease-coordinator",
                code: "invalid-execution-lease-coordinator",
              },
            },
          );
          recordSessionEventError(failure);
          throw failure;
        }
        if (decision.decision === "renewed") {
          leaseUniqueSuccesses = new Set<string>();
          leaseFailures = 0;
        }
        return decision;
      };
      const recordSessionEventError = (error: unknown): void => {
        sessionEventError ??= error;
      };
      /**
       * A coded refusal of the submission at its turn's settlement. It is the
       * attempt's first error, `finishTurn` ends the attempt on it,
       * and the attempt rethrows it whole rather than as a provider failure.
       */
      const refuseAtSettlement = (failure: InferenceStepError): void => {
        submissionState = "refused";
        settlementRefusals.add(failure);
        recordSessionEventError(failure);
      };
      /**
       * Settlement admission of the turn's submission, after the lease
       * settled the turn's batch, so `executed` already counts it. A turn that
       * reached the hard tool-call ceiling is never decoded: it records no
       * error here, and the ceiling stop in `finishTurn` records its
       * own code first. Otherwise the turn's lowest-ordinal submission is
       * decoded from its raw text, whatever Pi did with the call: ran it,
       * refused it in validation, or the lease withheld it.
       */
      const admitSubmissionAtSettlement = (
        message: object,
        batch: ActiveBatch | undefined,
        terminalUnexecuted?: { turnKey: string; turn: number; count: number },
      ): void => {
        if (!toolPath || submissionState !== "absent") return;
        const submission = firstSubmissionCall(
          settledToolCalls(message),
          QUALITY_SUBMISSION_TOOL_NAME,
        );
        if (!submission) return;
        if (
          executionLease.coordinator.policy.schemaVersion === 1 &&
          remainingScopedToolCalls(
            executionLease.coordinator.policy,
            executionLease.coordinator.state,
          ) === 0 &&
          readingToolCallsExecuted(executionLease.coordinator.state) >=
            executionLease.coordinator.policy.hardToolCallCeiling
        ) {
          submissionState = "not-decoded-at-ceiling";
          return;
        }
        const raw = rawToolCalls.textAt(submission.contentIndex);
        const decoded = decodeQualitySubmissionCall(raw);
        if ("failure" in decoded) {
          rejectedSpan = raw;
          rejectedInnerTexts = submissionMemberStrings(raw);
          if (
            terminalUnexecuted &&
            decoded.failure.rejection?.code === "quality-submission-shape" &&
            preExecutionRejectionTurns.has(terminalUnexecuted.turnKey)
          ) {
            terminalPreExecutionRejection = terminalUnexecuted;
          }
          refuseAtSettlement(decoded.failure);
          return;
        }
        submissionState = "admitted";
        submissionMembers = decoded.members;
        submissionBytes = Buffer.byteLength(raw ?? "", "utf8");
        // The model saw a withheld or refused result for a call the host
        // accepted; the report ask then says so.
        submissionWithheld = !batch?.authorized.includes(
          digestPiToolCall(submission.id, submission.name, submission.ordinal),
        );
      };
      // A read loop past its notice-only allowance ends the attempt by name at
      // the end of a settled tool turn, before another provider turn opens. A
      // tool-free turn is an answer and is always evaluated. When the crossing
      // turn also reached a lease checkpoint, the stop stays due and takes
      // effect after the next tool turn, never on the answer the notice asked for.
      // The step correction policy decides whether it is retried. On a
      // conclude-now retry the stop stays armed after the ask: each call the
      // host denies spends the same allowance.
      const stopAfterSettledTurn = async (
        context: Parameters<NonNullable<typeof session.agent.finishTurn>>[0],
      ): Promise<boolean> => {
        // A settled tool turn that brought executed calls to the hard ceiling
        // ends the attempt at that ceiling. An answer the model gave after it
        // would be refused as truncated, so none is asked for. The attempt
        // records a coded no-progress stop at the ceiling, never a success, and
        // the step correction policy decides its retry (`tool-call-ceiling`).
        if (
          assistantToolCalls(context.message).length > 0 &&
          executionLease.coordinator.phase !== "terminal" &&
          executionLease.coordinator.policy.schemaVersion === 1 &&
          remainingScopedToolCalls(
            executionLease.coordinator.policy,
            executionLease.coordinator.state,
          ) === 0 &&
          readingToolCallsExecuted(executionLease.coordinator.state) >=
            executionLease.coordinator.policy.hardToolCallCeiling
        ) {
          executionLease.stopForNoProgress();
          const limitStop = leaseTerminalLimitStop(
            {
              terminalReason: executionLease.coordinator.terminalReason,
              providerTurns: executionLease.coordinator.state.providerTurns,
              toolCalls: { executed: executionLease.coordinator.state.toolCalls.executed },
            },
            connection.turnGovernance?.evidence().at(-1),
          );
          recordSessionEventError(
            new InferenceStepError(
              limitStop
                ? formatStepExecutionLimitStop(input.step.id, limitStop)
                : `The step attempt reached its hard tool-call ceiling and ended as ${executionLease.coordinator.terminalReason ?? "stopped"}.`,
              "no-progress",
              // Retryable once the correction policy lists the category.
              isConfigurableRetryCategory("no-progress"),
              undefined,
              undefined,
              { condition: "tool-call-ceiling" },
            ),
          );
          return true;
        }
        // A submission refused at this turn's settlement already recorded its
        // code; the turn stops here, before the conclude-now return below, so
        // no later turn can decode a second submission.
        if (submissionState === "refused") return true;
        // On a conclude-now retry the first withheld re-read withdraws the
        // tools instead (the next turn asks for the answer), so the read-loop
        // stop never pre-empts that ask, even when one batch reaches both.
        if (concludeNowRetry && !answerNowMode && readEvidence.counters().withheld > 0) {
          return false;
        }
        // A turn that admitted a submission moves on to the report, so the
        // read-loop stop never ends an attempt whose answer the host holds.
        if (
          !readEvidence.stopDue ||
          assistantToolCalls(context.message).length === 0 ||
          executionLease.coordinator.phase !== "active" ||
          submissionState === "admitted"
        ) {
          return false;
        }
        executionLease.stopForNoProgress();
        recordSessionEventError(
          new InferenceStepError(
            readEvidence.stopMessage(),
            "no-progress",
            // Retryable once the correction policy lists the category.
            isConfigurableRetryCategory("no-progress"),
            undefined,
            // The bound's catalog refusal code, carried onto the attempt record.
            readEvidence.stopRejection(),
          ),
        );
        return true;
      };
      const existingFinishTurn = session.agent.finishTurn;
      session.agent.finishTurn = async (
        context,
        signal,
      ): Promise<{ action: "continue" | "end" } | undefined> => {
        const existing = (await existingFinishTurn?.(context, signal)) || undefined;
        if (existing?.action === "end") return existing;
        // Error and aborted responses end the run without a stop decision.
        const stopReason = (context.message as { stopReason?: unknown }).stopReason;
        if (stopReason === "error" || stopReason === "aborted") return existing;
        settleAssistantTurn(context);
        if (
          input.qualityAnswerRecords &&
          assistantToolCalls(context.message).length === 0 &&
          (executionLease.coordinator.phase === "active" ||
            executionLease.coordinator.phase === "checkpoint-required")
        ) {
          await answerRecordSettlement;
          if (answerRecordSettlementFailure !== undefined) {
            throw answerRecordSettlementFailure;
          }
          const progress =
            input.qualityAnswerRecordProgress?.() ?? input.qualityAnswerRecords.answerNowProgress();
          if (progress && !progress.complete && progress.remainingKeys.length > 0) {
            if (
              isQualityArtifactEvaluator(input) &&
              input.experimentalAnswerRecordDiscoveryRenewal === true &&
              executionLease.coordinator.policy.schemaVersion === 2 &&
              this.executionProfile.transport === "openai-chat-completions"
            ) {
              answerRecordRecoveryToolChoiceRequired = true;
            }
            qualityRecordContinuationPrompt = [
              "The answer-record ledger is incomplete. Submit records only for these remaining host progress labels:",
              JSON.stringify(progress.remainingKeys),
              "These labels identify remaining host-planned records; they do not encode key shape. Use the matching record type in the host-provided answer-record guidance and schema to determine whether a key is required. For a fixed-key record, use the exact planned key even when its value is `singleton`; for a singleton, omit key or use key null as allowed by the schema.",
              "Do not provide the final report yet.",
            ].join("\n");
            continuationPending = true;
            finalAnswerValid = false;
            return { action: "end" };
          }
        }
        return (await stopAfterSettledTurn(context)) ? { action: "end" } : existing;
      };
      const existingPrepareNextTurn = session.agent.prepareNextTurnWithContext;
      session.agent.prepareNextTurnWithContext = async (context, signal) => {
        const existing = await existingPrepareNextTurn?.(context, signal);
        // A settled, tool-free response is already this step's terminal product;
        // a budget boundary found while accounting for it must not add a
        // checkpoint turn after the work is complete.
        if (finalAnswerValid) return existing;
        // Settle the lease boundary first on every turn, including after the
        // answer-now ask. Ordinary turns settle only from `active`, so an
        // unrenewed checkpoint would make the next settlement throw.
        if (executionLease.checkpointRequired) {
          // Executed-call accounting already determines renew or stop, so no
          // checkpoint provider turn is needed. The hard tool-call ceiling never
          // reaches here: the turn that reached it already ended the attempt.
          const decision = applyAccountedHostCheckpoint();
          if (decision.decision !== "renewed") {
            const message = `The execution checkpoint stopped without a host renew: ${decision.reason ?? "checkpoint-not-renewable"}.`;
            recordSessionEventError(
              decision.reason === "checkpoint-not-renewable"
                ? new InferenceStepError(message, "no-progress", false)
                : new Error(message),
            );
            session.abort();
            // The attempt is ending on a recorded lease failure; do not append
            // the answer-now prompt to an aborting session.
            return existing;
          }
        }
        // The records-only route has no singular submission call. Once the
        // host ledger is settled and complete, ask for the report with tools
        // disabled, just as the tool-call route does after admission.
        if (input.qualityAnswerRecords && !answerRecordReportAsked) {
          await answerRecordSettlement;
          if (answerRecordSettlementFailure !== undefined) {
            throw answerRecordSettlementFailure;
          }
          if (input.qualityAnswerRecords.takeReportReadiness?.() === true) {
            answerRecordReportAsked = true;
            reportAsked = true;
            reportToolChoiceNone = true;
            reportTurnsFrom = connection.turnGovernance?.evidence().length ?? 0;
            return {
              ...existing,
              messages: [
                ...(existing?.messages ?? []),
                {
                  role: "user" as const,
                  content: OUTPUT_HOST_TEXT["quality-answer-record-report-ask"],
                  timestamp: now(),
                },
              ],
            };
          }
        }
        // After an admitted submission, ask once for the report. A lease that
        // could not renew above already ended the attempt, so the report is
        // never asked of an aborting session. A submission the lease withheld
        // gets the variant that says the host accepted it anyway.
        if (toolPath && submissionState === "admitted" && !reportAsked) {
          reportAsked = true;
          reportToolChoiceNone = true;
          reportTurnsFrom = connection.turnGovernance?.evidence().length ?? 0;
          // Pi rebuilds each request from the session projection, so a host ask
          // reaches the model only as a prepared message, never in `context`.
          return {
            ...existing,
            messages: [
              ...(existing?.messages ?? []),
              {
                role: "user" as const,
                content: submissionWithheld
                  ? OUTPUT_HOST_TEXT["quality-submission-report-ask-after-withheld-submission"]
                  : OUTPUT_HOST_TEXT["quality-submission-report-ask"],
                timestamp: now(),
              },
            ],
          };
        }
        if (reportAsked) return existing;
        // Answer-record retries have a separate reserve based on the exact
        // remaining qualified plan. The attempt-start decision is latched:
        // a later reduction in work can move an already-armed flip, but cannot
        // make an initially unfit or unqualified full plan arm mid-attempt.
        if (input.qualityAnswerRecords) {
          if (!recordsAnswerNowWasArmedAtStart || recordsAnswerNowMode) return existing;
          const current = recordsAnswerNowFlipForCurrentState();
          if (!current?.armed || current.flipAtMs === undefined) {
            recordSessionEventError(
              new Error("The qualified answer-record reserve no longer matches its host ledger."),
            );
            session.abort();
            return existing;
          }
          const flipAtMs = current.flipAtMs;
          if (flipAtMs === undefined || now() - attemptStartedAt < flipAtMs) return existing;
          recordsAnswerNowMode = true;
          return {
            ...existing,
            messages: [
              ...(existing?.messages ?? []),
              {
                role: "user" as const,
                content:
                  "Use the evidence already gathered to finish submitting every remaining required answer record. Do not perform more reads. Keep each record within the host-provided schema and address only the remaining keys.",
                timestamp: now(),
              },
            ],
          };
        }
        // Ask once for the answer when the attempt spends its reading share, or,
        // on a conclude-now retry, at its first withheld re-read, or, on another
        // read-only step, once only its answer reserve remains. The ask stays
        // in force for the rest of the attempt. It fires from `active`,
        // so a cut answer can still take the bounded continuation. Tools stay in
        // the request (Bedrock refuses a tool-call history with empty `tools`);
        // `beforeToolCall` denies every later call instead.
        const alreadyAsked = answerNowMode;
        const readLoopFlip =
          concludeNowRetry && !alreadyAsked && readEvidence.counters().withheld > 0;
        const deadlineFlip =
          !alreadyAsked &&
          !readLoopFlip &&
          attemptDeadlineConcludeAtMs !== undefined &&
          now() - attemptStartedAt >= attemptDeadlineConcludeAtMs;
        if (
          attemptAnswerNowFlipAtMs === undefined &&
          !readLoopFlip &&
          !deadlineFlip &&
          !alreadyAsked
        ) {
          return existing;
        }
        if (
          !alreadyAsked &&
          !readLoopFlip &&
          !deadlineFlip &&
          (attemptAnswerNowFlipAtMs === undefined ||
            now() - attemptStartedAt < attemptAnswerNowFlipAtMs)
        ) {
          return existing;
        }
        // The first ask records why it came and after which governed turn, so
        // an answer from partial reading is never silent.
        if (!alreadyAsked) {
          concludeNowEvidence = {
            trigger: readLoopFlip
              ? "read-loop"
              : deadlineFlip
                ? "attempt-deadline"
                : "reading-budget",
            turn: Math.max(
              1,
              connection.turnGovernance?.evidence().filter((turn) => turn.decision !== "stop")
                .length ?? 1,
            ),
          };
        }
        answerNowMode = true;
        if (alreadyAsked) return existing;
        return {
          ...existing,
          messages: [
            ...(existing?.messages ?? []),
            {
              role: "user" as const,
              // A degradable judgment step keeps its answer-now wording,
              // which says how to report pages it never reached. On the
              // tool-call answer path the ask names the submission tool.
              content:
                readLoopFlip && toolPath
                  ? OUTPUT_HOST_TEXT["quality-submission-conclude-now-ask"]
                  : readLoopFlip && !answerNowAppliesTo(input)
                    ? PI_CONCLUDE_NOW_PROMPT
                    : deadlineFlip && toolPath
                      ? OUTPUT_HOST_TEXT["quality-submission-deadline-conclude-ask"]
                      : deadlineFlip
                        ? PI_DEADLINE_CONCLUDE_NOW_PROMPT
                        : PI_ANSWER_NOW_PROMPT,
              timestamp: now(),
            },
          ],
        };
      };

      /**
       * Charge captured model output to the composition's response bound and
       * screen it for credentials. `screened` is what the screen reads: the
       * text answer so far plus this delta by default; a submission screens
       * its whole captured argument text, so a credential split across deltas
       * is still seen.
       */
      const admitProviderCapture = (text: string, screened = `${response}${text}`): boolean => {
        const maxResponseBytes = this.executionProfile.compositionPolicy?.maxResponseBytes;
        if (maxResponseBytes === undefined) return true;
        try {
          assertModelResponseCredentialFree(screened);
        } catch (error) {
          recordSessionEventError(error);
          session.abort();
          return false;
        }
        turnCaptureBytes += Buffer.byteLength(text, "utf8");
        if (turnCaptureBytes <= maxResponseBytes) return true;
        recordSessionEventError(new ProviderResponseLimitError(maxResponseBytes));
        session.abort();
        return false;
      };
      const providerMessageWithinLimit = (message: object): boolean => {
        const maxResponseBytes = this.executionProfile.compositionPolicy?.maxResponseBytes;
        try {
          assertCompositionProviderMessage(message);
        } catch (error) {
          recordSessionEventError(error);
          session.abort();
          return false;
        }
        if (
          maxResponseBytes === undefined ||
          Buffer.byteLength(assistantText(message), "utf8") <= maxResponseBytes
        ) {
          return true;
        }
        recordSessionEventError(new ProviderResponseLimitError(maxResponseBytes));
        session.abort();
        return false;
      };
      type SettledTurn = Pick<
        Extract<Parameters<Parameters<typeof session.subscribe>[0]>[0], { type: "turn_end" }>,
        "message" | "toolResults"
      >;
      // Pi calls `finishTurn` before it emits `turn_end`, and the stop decision
      // there reads this settlement, so whichever comes first settles the turn.
      const settledAssistantTurns = new WeakSet<object>();
      const settleAssistantTurn = (event: SettledTurn): void => {
        if (settledAssistantTurns.has(event.message)) return;
        settledAssistantTurns.add(event.message);
        // A submission whose message the provider finished is no longer in
        // flight; an aborted or failed message leaves it in flight.
        const settledStop = (event.message as { stopReason?: unknown }).stopReason;
        if (settledStop !== "aborted" && settledStop !== "error") submitTurnInProgress = false;
        if (executionLease.coordinator.phase === "terminal") return;
        if (!providerMessageWithinLimit(event.message)) return;
        const calls = assistantToolCalls(event.message);
        const turnFailure = assistantTurnFailure(event.message, {
          blankProviderTurns: blankProviderTurns(),
          providerAttempts: providerAttempts(),
          outputTokenLimit: outputTokenLimit(),
          outputLeaseClamp: outputLeaseClamp(),
          stepId: input.step.id,
        });
        const lengthStoppedToolTurn =
          calls.length > 0 &&
          isLengthStop(
            (event.message as { stopReason?: unknown }).stopReason,
            (event.message as { rawStopReason?: unknown }).rawStopReason,
          );
        consecutiveLengthStoppedToolTurns = lengthStoppedToolTurn
          ? consecutiveLengthStoppedToolTurns + 1
          : 0;
        if (calls.length === 0 && executionLease.coordinator.phase === "batch-pending") {
          const batch = activeBatch();
          if (!batch) {
            recordSessionEventError(
              new Error("Pi execution lease lost a pending batch before turn settlement."),
            );
            return;
          }
          const reason = turnFailure?.reason ?? "evidence-preservation-required";
          let results: Array<{ callSha256: string; outcome: "succeeded" | "failed" }> = [];
          try {
            results = drainPendingBatchForRecords(batch, reason);
          } catch (error) {
            recordSessionEventError(error);
            return;
          }
          queueAnswerRecordSettlement(batch, results);
          recordSessionEventError(
            new Error("Pi provider turn ended without the pending tool batch's turn_end evidence."),
          );
          return;
        }
        if (calls.length > 0) {
          for (const result of event.toolResults) {
            observeToolResult(result.toolCallId, result.isError);
          }
          const providerTurn =
            connection.turnGovernance?.evidence().filter((turn) => turn.decision !== "stop")
              .length ?? 0;
          const turnKey =
            `${input.inferenceAttempt ?? 1}:${providerTurn}:` +
            assistantAuthoritySha256(event.message);
          const authoritySha256 = turnAuthorities.get(turnKey);
          const batch = authoritySha256 ? batches.get(authoritySha256) : undefined;
          if (batch?.settled) {
            let results: Array<{ callSha256: string; outcome: "succeeded" | "failed" }> = [];
            try {
              results = settlePiPreviouslySettledBatch(batch, event.toolResults, {
                tombstone: (settlement) => tombstoneBatch(batch, settlement),
                phase: () => executionLease.coordinator.phase,
                settleOrdinary: (usage) => executionLease.settleOrdinaryProviderTurn(usage),
                settleBoundary: (usage) => executionLease.settleBoundaryProviderTurn(usage),
                settleToolBatch: (settlement, usage) =>
                  executionLease.settleToolBatch(settlement, usage),
              });
            } catch (error) {
              stopExecution("evidence-preservation-required");
              queueAnswerRecordSettlement(batch, []);
              recordSessionEventError(error);
              return;
            }
            queueAnswerRecordSettlement(batch, results);
            if (turnFailure) {
              stopExecution(turnFailure.reason, turnFailure.disposition);
              recordSessionEventError(
                providerTurnError(
                  `Tool-batch provider turn failed: ${formatAssistantTurnFailure(turnFailure)}.`,
                  turnFailure,
                ),
              );
              return;
            }
            admitSubmissionAtSettlement(event.message, batch);
            return;
          }
          if (batch?.pendingTerminalReason !== undefined) {
            if (executionLease.coordinator.phase === "batch-pending") {
              const results = drainPendingBatchForRecords(batch, batch.pendingTerminalReason);
              queueAnswerRecordSettlement(batch, results);
            } else {
              queueAnswerRecordSettlement(batch, []);
            }
            recordSessionEventError(
              batch.pendingError ??
                new Error("Pi tool preflight failed without an attributable host error."),
            );
            return;
          }
          if (turnFailure) {
            let results: Array<{ callSha256: string; outcome: "succeeded" | "failed" }> = [];
            if (batch && executionLease.coordinator.phase === "batch-pending") {
              results = drainPendingBatchForRecords(batch, turnFailure.reason);
            } else if (batch) {
              results = validatePiBatchSettlement(
                batch.calls,
                batch.authorized,
                event.toolResults.map((result) => ({
                  toolCallId: result.toolCallId,
                  isError: result.isError,
                })),
              );
              if (executionLease.coordinator.phase === "active") {
                executionLease.settleOrdinaryProviderTurn(batch.usage);
              } else if (executionLease.coordinator.phase === "checkpoint-required") {
                executionLease.settleBoundaryProviderTurn(batch.usage);
              }
              stopExecution(turnFailure.reason, turnFailure.disposition);
              consumeBatch(batch);
            } else {
              stopExecution(turnFailure.reason, turnFailure.disposition);
            }
            if (batch) queueAnswerRecordSettlement(batch, results);
            recordSessionEventError(
              providerTurnError(
                `Tool-batch provider turn failed: ${formatAssistantTurnFailure(turnFailure)}.`,
                turnFailure,
              ),
            );
            return;
          }
          if (batch?.deniedBoundaryIndex !== undefined) {
            let results: Array<{ callSha256: string; outcome: "succeeded" | "failed" }> = [];
            if (executionLease.coordinator.phase === "batch-pending") {
              results = drainPendingBatchForRecords(batch, "authorization-denied");
            } else {
              results = validatePiBatchSettlement(
                batch.calls,
                batch.authorized,
                event.toolResults.map((result) => ({
                  toolCallId: result.toolCallId,
                  isError: result.isError,
                })),
              );
              if (executionLease.coordinator.phase === "active") {
                executionLease.settleOrdinaryProviderTurn(batch.usage);
              } else if (executionLease.coordinator.phase === "checkpoint-required") {
                executionLease.settleBoundaryProviderTurn(batch.usage);
              }
              stopExecution("authorization-denied");
              consumeBatch(batch);
            }
            queueAnswerRecordSettlement(batch, results);
            recordSessionEventError(
              new Error("Pi execution lease stopped after a host authorization denial."),
            );
            return;
          }
          if (!batch) {
            settlePiUnexecutedToolTurn(
              {
                calls,
                results: event.toolResults,
                authoritySha256,
                turnKey,
                providerTurn,
                stepId: input.step.id,
                lengthStopped: lengthStoppedToolTurn,
                consecutiveLengthStops: consecutiveLengthStoppedToolTurns,
                toolPath,
                submissionAbsent: submissionState === "absent",
                consumedOutputTokens: (event.message as { usage?: { output?: unknown } }).usage
                  ?.output,
                maxConsecutiveLengthStops: recoveryPolicy.maxConsecutiveLengthStoppedToolTurns,
                leasePolicySchemaVersion: executionLease.coordinator.policy.schemaVersion,
              },
              {
                phase: () => executionLease.coordinator.phase,
                rejectedTurns: preExecutionRejectionTurns,
                recordRejectedCalls: (count) => {
                  preExecutionRejections += count;
                },
                chargeOrdinaryTurn: () =>
                  executionLease.settleOrdinaryProviderTurn(chargedProviderUsage(event.message, 0)),
                readGovernedTurn: () => connection.turnGovernance?.evidence().at(-1),
                checkpointProviderTurnLimit: () =>
                  executionLease.coordinator.checkpointRequest?.stopReasons.includes(
                    "provider-turn-limit",
                  ) ?? false,
                outputTokenLimit,
                outputLeaseClamp,
                stopEvidencePreservation: () => stopExecution("evidence-preservation-required"),
                stopProviderTerminal: () => stopExecution("provider-terminal", "provider-failed"),
                recordError: (error) => recordSessionEventError(error),
                refuseCutSubmission: (error) => refuseAtSettlement(error),
                admitSubmission: (identity) =>
                  admitSubmissionAtSettlement(event.message, undefined, identity),
              },
            );
            return;
          }
          let results;
          try {
            results = settlePiActiveToolBatch(batch, event.toolResults, {
              tombstone: (settlement) => tombstoneBatch(batch, settlement),
              phase: () => executionLease.coordinator.phase,
              settleOrdinary: (usage) => executionLease.settleOrdinaryProviderTurn(usage),
              settleBoundary: (usage) => executionLease.settleBoundaryProviderTurn(usage),
              settleToolBatch: (settlement, usage) =>
                executionLease.settleToolBatch(settlement, usage),
            });
          } catch (error) {
            let partialResults: Array<{
              callSha256: string;
              outcome: "succeeded" | "failed";
            }> = [];
            try {
              partialResults = observedAuthorizedPrefix(batch);
            } catch {
              // Preserve the settlement failure as the primary evidence. The
              // queue is still given an empty prefix so it cannot commit a
              // call whose exact executed prefix was not established.
            }
            recordSessionEventError(error);
            if (executionLease.coordinator.phase === "batch-pending") {
              try {
                drainPendingBatch(
                  batch,
                  batch.hostDenied.size > 0
                    ? "authorization-denied"
                    : "evidence-preservation-required",
                );
              } catch (drainError) {
                // Preserve the settlement validation as primary evidence.
                recordSessionEventError(drainError);
              }
            }
            queueAnswerRecordSettlement(batch, partialResults);
            return;
          }
          queueAnswerRecordSettlement(batch, results);
          admitLeaseProgress(batch, results);
          recordExecutedResults(batch, results);
          consumeBatch(batch);
          admitSubmissionAtSettlement(event.message, batch);
          return;
        }
        if (turnFailure?.localStop) {
          if (reportAsked && turnFailure.reason === "output-authority-exhausted") {
            reportOutcome = "authority-stopped";
          }
          // The governor refused before any provider traffic, so there is no
          // turn to settle; charging one would break the exact match between
          // lease and ledger turn counts.
          stopExecution(turnFailure.reason, turnFailure.disposition);
          recordSessionEventError(
            providerTurnError(
              turnFailure.reason === "output-authority-exhausted"
                ? describeOutputAuthorityExhaustion()
                : `Provider turn failed: ${formatAssistantTurnFailure(turnFailure)}.`,
              turnFailure,
            ),
          );
          return;
        }
        const usage = chargedProviderUsage(event.message, 0);
        executionLease.settleOrdinaryProviderTurn(usage);
        if (turnFailure) {
          const cutCode = turnFailure.rejection?.code;
          // On the tool-call answer path, text cut before any admitted
          // submission is an answer written instead of the submission: it
          // is no answer, so it is never continued.
          if (toolPath && submissionState !== "admitted" && cutCode === "text-truncated") {
            stopExecution(turnFailure.reason, turnFailure.disposition);
            const missing = new InferenceStepError(
              `The final evaluator answered in text without calling ${QUALITY_SUBMISSION_TOOL_NAME}, and the text was cut at the output limit.`,
              "malformed-response",
              true,
              undefined,
              { ...rejectOutput("quality-submission-missing", "$") },
            );
            settlementRefusals.add(missing);
            recordSessionEventError(missing);
            return;
          }
          if (cutCode === "text-truncated" || cutCode === "output-truncated") {
            answerTurnOutputTokens.push(producedOutputTokens.at(-1));
          }
          // A judgment cut that `declinedJudgmentCut` names (it checks the
          // continuation bound) is kept for the host to complete after the
          // prompt settles; the attempt ends `completed` and the ledger keeps
          // the `length` stop. The final quality evaluator has no sealed
          // ledger to host-fill against: unlike the two ledger steps, its
          // completion can find nothing safe to keep (a cut inside
          // `evaluation` itself). When that is already knowable here, the
          // cut is NOT kept -- falling through to the unchanged pre-existing
          // failure below -- so this step's own fail-closed case is never
          // laundered into the generic "blank response" branch further down,
          // which is retryable and carries the wrong rejection code.
          // A plain report evaluator without a quality profile or editorial
          // assessment contract streams its answer and cannot continue it.
          // Its effective continuation bound is zero, so a text cut declines
          // on the first turn. Structured editorial assessments are excluded
          // from host completion below and use their configured continuation.
          const isUnboundQualityReport =
            qualityReportCutApplies(input) && !isQualityArtifactEvaluator(input);
          // Update's independent assessment is a strict JSON envelope,
          // even without a quality profile. Appending a plain report note
          // corrupts that envelope and cannot supply its missing proposal.
          // Continue it below, or refuse the cut when that budget is spent.
          const declinedCut = isEditorialAssessmentStep(input)
            ? undefined
            : declinedJudgmentCut(
                input,
                cutCode,
                lengthStopContinuations,
                isUnboundQualityReport ? 0 : maxLengthStopContinuations,
              );
          if (declinedCut) {
            const finalCut = assistantText(event.message, { thinkingFallback: false });
            const stitched = retainedTruncatedAnswer + finalCut;
            const maxResponseBytes = this.executionProfile.compositionPolicy?.maxResponseBytes;
            // The unbound evaluator's reply is plain markdown, not the
            // JSON envelope `recoverableQualityReportCut` parses (its
            // prompt never loaded the evaluator contract that asks for
            // one): "recoverable" here means only "the cut left some
            // text to keep", checked directly in the completion step
            // below rather than by JSON recovery.
            // A report cut after an admitted submission keeps the
            // submission's members whole, so the host can always complete it.
            const qualityReportUnrecoverable = submissionMembers
              ? false
              : isUnboundQualityReport
                ? stitched.trim().length === 0
                : qualityReportCutApplies(input) &&
                  recoverableQualityReportCut(
                    { stitched, finalCut },
                    input.experimentalAnswerRecordDiscoveryRenewal === true
                      ? undefined
                      : maxResponseBytes,
                  ) === undefined;
            if (!qualityReportUnrecoverable) {
              cutJudgment = {
                shape: declinedCut,
                stitched,
                finalCut,
                continuationTurns: lengthStopContinuations,
                outputTokenLimit: outputTokenLimit(),
                answerOutputTokens: answerTurnOutputTokens.every((tokens) => tokens !== undefined)
                  ? answerTurnOutputTokens.reduce<number>((total, tokens) => total + tokens!, 0)
                  : undefined,
              };
              return;
            }
          }
          // A `text-truncated` turn on a step with a host response contract
          // can be finished in this attempt: keep the prefix and ask for one
          // bounded continuation. `output-truncated` has no prefix to
          // continue, and a step without a host contract streams its answer,
          // so a second message there would corrupt it.
          if (
            turnFailure.rejection?.code === "text-truncated" &&
            requiresStructuredResponseEnvelope(input) &&
            (maxLengthStopContinuations === undefined ||
              lengthStopContinuations < maxLengthStopContinuations)
          ) {
            const retained =
              retainedTruncatedAnswer + assistantText(event.message, { thinkingFallback: false });
            const maxResponseBytes = this.executionProfile.compositionPolicy?.maxResponseBytes;
            // The stitched answer is one step answer under the same byte
            // ceiling as a single message; each turn's capture is measured
            // alone, so without this the ceiling would multiply. A report
            // after an admitted submission shares the ceiling with it.
            if (
              input.experimentalAnswerRecordDiscoveryRenewal !== true &&
              maxResponseBytes !== undefined &&
              submissionBytes + Buffer.byteLength(retained, "utf8") > maxResponseBytes
            ) {
              if (reportAsked) reportOutcome = "refused";
              stopExecution(turnFailure.reason, turnFailure.disposition);
              recordSessionEventError(new ProviderResponseLimitError(maxResponseBytes));
              return;
            }
            retainedTruncatedAnswer = retained;
            lengthStopContinuations += 1;
            continuationPending = true;
            return;
          }
          stopExecution(turnFailure.reason, turnFailure.disposition);
          recordSessionEventError(
            providerTurnError(
              `Provider turn failed: ${formatAssistantTurnFailure(turnFailure)}.`,
              turnFailure,
            ),
          );
          return;
        }
        // The settled assistant message owns the completed response. Stream
        // deltas are a progress transport and may omit its final text chunk.
        // Never promote a reasoning-only message into a structured answer.
        const settledText = assistantText(event.message, {
          thinkingFallback: false,
        });
        // The submission and its report are one answer under the
        // composition's response ceiling, as a stitched text answer is.
        const maxResponseBytes = this.executionProfile.compositionPolicy?.maxResponseBytes;
        if (
          input.experimentalAnswerRecordDiscoveryRenewal !== true &&
          maxResponseBytes !== undefined &&
          submissionBytes + Buffer.byteLength(retainedTruncatedAnswer + settledText, "utf8") >
            maxResponseBytes
        ) {
          if (reportAsked) reportOutcome = "refused";
          stopExecution("provider-terminal", "provider-failed");
          recordSessionEventError(new ProviderResponseLimitError(maxResponseBytes));
          return;
        }
        terminalResponse = settledText;
        finalAnswerValid = true;
      };
      session.subscribe((event) => {
        observedSession?.observe(event);
        if (event.type === "turn_start") {
          inFlightTurn = "awaiting-first-byte";
          observedProviderTurnsStarted += 1;
          emitProgress("provider-turn-started", "provider-turn-pending");
        }
        if (event.type === "message_update") {
          const update = event.assistantMessageEvent.type;
          if (update === "text_delta") inFlightTurn = "streaming-answer";
          else if (update.startsWith("toolcall_")) {
            if (inFlightTurn !== "streaming-answer") inFlightTurn = "streaming-tool-call";
          } else if (inFlightTurn === "awaiting-first-byte") inFlightTurn = "streaming";
        }
        if (event.type === "message_end" && event.message.role === "assistant") {
          inFlightTurn = "between-requests";
        }
        if (event.type === "turn_start") {
          turnStartedAt = Date.now();
          turnCaptureBytes = 0;
          terminalResponse = "";
          rawToolArgumentCapture = "";
          finalAnswerValid = false;
          rawToolCalls.reset();
          submitTurnInProgress = false;
        }
        // On the tool-call answer path, keep each call's raw argument text as
        // the serving stack streamed it. A submission's text is charged to the
        // response bound and screened like answer text; once its first event
        // arrives, its turn is in progress until it settles.
        if (
          (toolPath || answerRecordCapability !== undefined) &&
          event.type === "message_update" &&
          (event.assistantMessageEvent.type === "toolcall_start" ||
            event.assistantMessageEvent.type === "toolcall_delta" ||
            event.assistantMessageEvent.type === "toolcall_end")
        ) {
          const update = event.assistantMessageEvent;
          const block = (update.partial as { content?: unknown[] }).content?.[
            update.contentIndex
          ] as { name?: unknown } | undefined;
          const name = typeof block?.name === "string" ? block.name : undefined;
          if (update.type === "toolcall_delta") {
            rawToolCalls.append(update.contentIndex, name, update.delta);
          } else {
            rawToolCalls.observe(update.contentIndex, name);
          }
          if (update.type === "toolcall_end") {
            rawToolCalls.bind(update.contentIndex, update.toolCall.id);
          }
          const capturedToolName = rawToolCalls.nameAt(update.contentIndex);
          const capturesLegacySubmission = capturedToolName === QUALITY_SUBMISSION_TOOL_NAME;
          const capturesAnswerRecord =
            answerRecordCapability !== undefined &&
            capturedToolName === QUALITY_ANSWER_RECORD_TOOL_NAME;
          if (capturesLegacySubmission || capturesAnswerRecord) {
            if (capturesLegacySubmission) submitTurnInProgress = true;
            const uncharged = rawToolCalls.takeUncharged(update.contentIndex);
            if (uncharged) {
              rawToolArgumentCapture += uncharged;
              if (!admitProviderCapture(uncharged, `${response}${rawToolArgumentCapture}`)) return;
            }
          }
        }
        if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
          const text = event.assistantMessageEvent.delta;
          if (!admitProviderCapture(text)) return;
          response += text;
          if (reportAsked) reportCapturedBytes += Buffer.byteLength(text, "utf8");
          if (
            !this.executionProfile.compositionPolicy &&
            !isQualityArtifactEvaluator(input) &&
            !requiresAdmittedReviewResponse(input)
          ) {
            input.onText?.(text);
          }
        }
        if (event.type === "tool_execution_start") {
          observedToolExecutionsStarted += 1;
          // Pi emits this boundary before beforeToolCall. Use only the
          // host-granted tool name and persist its fixed category alone.
          const category = eventActivityCategory(event.toolName);
          toolActivityCounts[category].started += 1;
          emitProgress("tool-execution-started", "tool-execution-active");
        }
        if (event.type === "tool_execution_end") {
          observedToolExecutionsSettled += 1;
          const category = eventActivityCategory(event.toolName);
          toolActivityCounts[category].settled += 1;
          if (event.isError) toolActivityCounts[category].errorResults += 1;
          emitProgress(
            "tool-execution-settled",
            observedToolExecutionsSettled < observedToolExecutionsStarted
              ? "tool-execution-active"
              : "tool-execution-settled",
          );
          observeToolResult(event.toolCallId, event.isError);
        }
        // Provider latency runs from turn start to the settled assistant
        // message, before any tool in the turn executes.
        if (event.type === "message_end" && event.message.role === "assistant") {
          providerLatencyMs += Math.max(0, Date.now() - turnStartedAt);
        }
        if (event.type === "turn_end" && event.message.role === "assistant") {
          settleAssistantTurn(event);
          observedProviderTurnsSettled += 1;
          emitProgress("provider-turn-settled", "provider-turn-settled");
        }
      });
      this.options.configureSession?.(session);

      /**
       * The attempt's answer path and, on the tool path, how far the
       * submission and the report got. A submission whose arguments were still
       * streaming, or a report still being written, when the attempt ended is
       * `in-flight`, with the bytes the host captured from the stream.
       */
      const answerSubmissionEvidence = (): InferenceAnswerSubmissionEvidenceV1 | undefined => {
        const resolved = input.answerSubmission;
        if (input.qualityAnswerRecords) {
          const reportClamped = (connection.turnGovernance?.evidence() ?? [])
            .slice(reportTurnsFrom)
            .some((turn) => turn.decision !== "stop" && turn.outputAuthority !== undefined);
          const reportTurn: InferenceAnswerReportTurnState = reportOutcome
            ? reportOutcome === "admitted" && reportClamped
              ? "clamped"
              : reportOutcome
            : reportAsked
              ? "in-flight"
              : "not-asked";
          return {
            path: "answer-records",
            reason: "record-ledger",
            submission: "not-applicable",
            reportTurn,
            ...(reportTurn === "in-flight" ? { reportInFlightBytes: reportCapturedBytes } : {}),
          };
        }
        if (!resolved) return undefined;
        if (!toolPath) {
          return {
            path: resolved.path,
            reason: resolved.reason,
            submission: "absent",
            reportTurn: "not-asked",
          };
        }
        const submissionInFlight = submissionState === "absent" && submitTurnInProgress;
        const reportClamped = (connection.turnGovernance?.evidence() ?? [])
          .slice(reportTurnsFrom)
          .some((turn) => turn.decision !== "stop" && turn.outputAuthority !== undefined);
        const reportTurn: InferenceAnswerReportTurnState = !reportAsked
          ? "not-asked"
          : reportOutcome === "admitted"
            ? reportClamped
              ? "clamped"
              : "admitted"
            : (reportOutcome ?? "in-flight");
        return {
          path: resolved.path,
          reason: resolved.reason,
          submission: submissionInFlight ? "in-flight" : submissionState,
          reportTurn,
          ...(submissionInFlight
            ? { submissionInFlightBytes: rawToolCalls.bytesOf(QUALITY_SUBMISSION_TOOL_NAME) }
            : {}),
          ...(reportTurn === "in-flight" ? { reportInFlightBytes: reportCapturedBytes } : {}),
          ...(submissionState === "admitted" && submissionMembers
            ? {
                memberEncoding: { ...submissionMembers.memberEncoding },
                ...(submissionMembers.memberEncoding.evaluation === "string" ||
                submissionMembers.memberEncoding.qualityScore === "string"
                  ? { submissionInnerBytes: submissionMembers.innerBytes }
                  : {}),
              }
            : {}),
        };
      };

      const collectAttemptEvidence = (selectedResponseLimit?: ProviderResponseLimitError) =>
        collectPiAttemptEvidence(
          {
            input,
            readSessionStats: () => session.getSessionStats(),
            readProviderTurns: () => connection.turnGovernance?.evidence() ?? [],
            reportUsageCost: connection.reportUsageCost,
            readProviderResponses: () => connection.providerResponses?.(),
            readProviderRequests: () => connection.providerRequests?.(),
            readSourceReuse: () => {
              const reuseAfter = input.preservationSourceObservationCache
                ? preservationSourceObservationCacheStats(input.preservationSourceObservationCache)
                : undefined;
              return reuseBefore && reuseAfter
                ? preservationSourceObservationCacheDelta(reuseBefore, reuseAfter)
                : null;
            },
            readModelEvidence: () => createModelEvidence(this.executionProfile),
            readLeasePhase: () => executionLease.coordinator.phase,
            readLeaseCounters: () => executionLease.coordinator.state.toolCalls,
            bindLeaseEvidence: (digests) => executionLease.evidence(digests),
            readToolFailureCategories: () => confinedTools.getFailureCategories(),
            readToolResultArchive: () => confinedTools.getToolResultArchive(),
            readHistoryReads: () => confinedTools.getHistoryReads(),
            readToolRefusals: () => confinedTools.getToolRefusals(),
            readToolArgumentFiller: () => confinedTools.getToolArgumentFiller(),
            readReadEvidenceSnapshot: () => readEvidence.snapshot(),
            confinedToolDefinitions,
            batches,
            grantedToolNames,
            toolActivity,
            governanceStops,
            unknownToolFailures,
            preExecutionRejections,
            terminalPreExecutionRejection,
            preExecutionRejectionTurns,
            producedOutputTokens,
            producedFinishReasons,
            lastLandedTurnTelemetry,
            providerLatencyMs,
            concludeNowEvidence,
            deadlineTurn,
            answerSubmissionEvidence,
          },
          selectedResponseLimit,
        );

      const governedAssets = confinedTools.governedSkillVirtualPath
        ? [
            "",
            "",
            `Governed skill assets are read-only under ${confinedTools.governedSkillVirtualPath}/.`,
            ...(confinedTools.governedQualityVirtualPath
              ? [
                  `Quality assets referenced by the skill are read-only under ${confinedTools.governedQualityVirtualPath}/.`,
                ]
              : []),
            "Access governed assets only with the granted read-only filesystem tools: read, grep, find, or ls.",
          ].join("\n")
        : "";
      const hostPrompt = buildHostStepPrompt(
        input,
        governedAssets + styleContext + evaluatorContract + writerSourceFactMethod,
        this.executionProfile.profile.maxOutputTokens,
      );
      // Only the placeholders this step's host contract rendered, and only for
      // a step whose structured reply the harness admits. Other steps keep their
      // own decoder as the only judge of their reply.
      const placeholderScope = requiresStructuredResponseEnvelope(input)
        ? contractPlaceholderScope(hostPrompt)
        : EMPTY_CONTRACT_PLACEHOLDER_SCOPE;
      try {
        await promptWithinAttempt(
          expandGovernedSkillCommand(hostPrompt, skill.name, expectedSkillExpansion),
        );
        // One continuation prompt per retained cut, under the same attempt deadline.
        while (
          continuationPending &&
          skillExpansionRefusal === undefined &&
          sessionEventError === undefined
        ) {
          continuationPending = false;
          const continuationPrompt = qualityRecordContinuationPrompt;
          qualityRecordContinuationPrompt = undefined;
          await promptWithinAttempt(
            continuationPrompt ??
              lengthStopContinuationPrompt(outputTokenLimit(), retainedTruncatedAnswer.length),
          );
        }
        if (skillExpansionRefusal !== undefined) throw skillExpansionRefusal;
        await answerRecordSettlement;
        if (sessionEventError !== undefined) throw sessionEventError;
      } catch (error) {
        throwPiAttemptFailure({
          error,
          sessionEventError,
          skillExpansionRefusal,
          inputSignalAborted: input.signal?.aborted === true,
          sessionSignalAborted: session.agent.signal?.aborted === true,
          attemptTimedOut,
          settlementRefusals,
          phase: () => executionLease.coordinator.phase,
          complete: () => executionLease.complete(),
          stopExecution,
          credentialRefusedTurns,
          responseLimitRefusedTurns,
          proxyRefusedTurns,
          lastResponseLimitRefusal: () =>
            connection.providerTransport?.lastResponseLimitRefusal?.(),
          collectAttemptEvidence,
          redact: (failure) => this.redact(failure),
        });
      }

      const modelError = session.agent.state.errorMessage;
      if (modelError) {
        // Pi can resolve prompt() with state.errorMessage instead of throwing a
        // providerTurnError. Use only the request-bound typed transport signal;
        // never infer a byte-limit refusal from model/provider text.
        const outputAuthorityStop = localStopReason(modelError) === "output-authority-exhausted";
        const responseLimit = outputAuthorityStop
          ? undefined
          : connection.providerTransport?.lastResponseLimitRefusal?.();
        const failure = classifyModelFailure(modelError);
        let responseLimitTerminalizationError: unknown;
        // The output-authority stop normally settles in the turn_end handler.
        // If Pi surfaces it only here, it is still a budget stop and keeps its name.
        if (reportAsked && outputAuthorityStop) reportOutcome = "authority-stopped";
        if (executionLease.coordinator.phase !== "terminal") {
          if (responseLimit) {
            try {
              stopExecution("provider-terminal", "provider-failed");
            } catch (error) {
              responseLimitTerminalizationError = error;
            }
          } else {
            if (outputAuthorityStop) {
              stopExecution("output-authority-exhausted", "budget-stopped");
            } else {
              stopExecution(
                failure.category === "context-exhausted"
                  ? "context-exhausted"
                  : "provider-terminal",
                failure.category === "context-exhausted" ? "context-exhausted" : "provider-failed",
              );
            }
          }
        }
        const coded = new InferenceStepError(
          responseLimit
            ? `Model request failed [${failure.category}; retryable=${failure.retryable}]: ${responseLimit.message}${
                responseLimitTerminalizationError === undefined
                  ? ""
                  : " (lease terminalization also failed)"
              }`
            : `Model request failed [${failure.category}; retryable=${failure.retryable}]: ${
                outputAuthorityStop ? describeOutputAuthorityExhaustion() : this.redact(modelError)
              }`,
          failure.category,
          failure.retryable,
          collectAttemptEvidence(responseLimit),
        );
        if (responseLimit) {
          Object.defineProperty(coded, "cause", {
            value:
              responseLimitTerminalizationError === undefined
                ? responseLimit
                : new AggregateError(
                    [responseLimit, responseLimitTerminalizationError],
                    "Provider response limit and lease terminalization both failed.",
                  ),
            enumerable: false,
            writable: false,
            configurable: false,
          });
        }
        throw coded;
      }
      const settledResponse =
        this.executionProfile.compositionPolicy ||
        requiresStructuredResponseEnvelope(input) ||
        decodesFinalReplyOutsideHarness(input)
          ? terminalResponse
          : response;
      // Decoders see the retained prefix stitched onto the settled
      // continuation. A cut kept for the host is decoded as the host's completed
      // reply; a cut answer is never accepted as whole. The final quality
      // evaluator has no source-obligation ledger to host-fill against, so
      // its cut is completed by a different, non-ledger function, kept in
      // its own typed variable so the ledger-shaped floor below
      // (`admitJudgmentReply`, `hostFillRefusedCutJudgment`) is never handed
      // this step's completion. Which function depends on whether this run
      // bound a quality-evaluator profile: bound (local CLI only) recovers
      // the model's verbatim structured judgment and host-writes only the
      // narrative; unbound (every hosted pilot run today) never asked the
      // model for that JSON envelope, so the host keeps its plain-markdown
      // prose verbatim instead. `cutJudgment` is only ever set for this step
      // above once the turn-end handler has already confirmed the matching
      // completion function will find something to keep, so neither ever
      // returns `undefined` here; a cut that lands inside a bound
      // evaluator's `evaluation` object, or that left the unbound evaluator
      // nothing at all, never reaches this variable and fails at the
      // unchanged pre-existing site above instead.
      const hostCompletedLedgerCut =
        cutJudgment && !qualityReportCutApplies(input)
          ? hostCompleteCutJudgment(
              input,
              cutJudgment,
              this.executionProfile.compositionPolicy?.maxResponseBytes,
            )
          : undefined;
      // On the tool-call answer path the submission's admitted members come
      // first; only the report turn was cut.
      const hostCompletedQualityReportCut =
        cutJudgment && qualityReportCutApplies(input)
          ? submissionMembers
            ? hostCompleteCutQualityReportFromMembers(cutJudgment, submissionMembers)
            : isQualityArtifactEvaluator(input)
              ? hostCompleteCutQualityReport(
                  cutJudgment,
                  input.experimentalAnswerRecordDiscoveryRenewal === true
                    ? undefined
                    : this.executionProfile.compositionPolicy?.maxResponseBytes,
                )
              : hostCompleteCutQualityNarrative(cutJudgment)
          : undefined;
      const hostCompletedCut = hostCompletedLedgerCut ?? hostCompletedQualityReportCut;
      const decodedResponse = hostCompletedCut
        ? hostCompletedCut.reply
        : retainedTruncatedAnswer
          ? retainedTruncatedAnswer + settledResponse
          : settledResponse;
      if (
        !hostCompletedCut &&
        (!finalAnswerValid || (!decodedResponse.trim() && !input.sourceObligationAnswerRecords))
      ) {
        if (reportAsked && finalAnswerValid) reportOutcome = "refused";
        if (executionLease.coordinator.phase !== "terminal") {
          stopExecution("provider-terminal", "blank");
        }
        throw new InferenceStepError(
          "Model returned a blank response.",
          "blank-response",
          true,
          collectAttemptEvidence(),
        );
      }

      if (executionLease.coordinator.phase === "batch-pending") {
        stopExecution("evidence-preservation-required");
        throw new InferenceStepError(
          "A provider tool batch ended without exact terminal settlement.",
          "provider-terminal",
          false,
          collectAttemptEvidence(),
        );
      }
      if (
        executionLease.coordinator.phase === "active" ||
        executionLease.coordinator.phase === "checkpoint-required"
      ) {
        executionLease.complete();
      }
      if (
        this.executionProfile.compositionPolicy &&
        !isQualityArtifactEvaluator(input) &&
        !requiresAdmittedReviewResponse(input)
      ) {
        input.onText?.(decodedResponse);
      }

      await studyWrite;
      await answerRecordSettlement;
      decodedReply = decodedResponse;
      // Last in-harness gate: runs after the step's own decoders, so it never
      // masks a security or authority refusal. A value copied from a host
      // contract example, at that example's position, is a retryable rejection.
      const refuseContractPlaceholder = (reply: string): void => {
        const rejection = findContractPlaceholderInReply(
          reply,
          placeholderScope,
          replyShapePolicy.isDeclared,
        );
        if (!rejection) return;
        throw new InferenceStepError(
          "The response repeated a host contract placeholder instead of a value this run established.",
          "malformed-response",
          true,
          collectAttemptEvidence(),
          rejection,
        );
      };
      let summary = decodedResponse.trim();
      let verificationResult: HarnessStepResult["verificationResult"];
      let sourceObligationProposal: HarnessStepResult["sourceObligationProposal"];
      let technicalCorrectionEvidence: HarnessStepResult["technicalCorrectionEvidence"];
      let provisionalRichCandidateEvidence: HarnessStepResult["provisionalRichCandidateEvidence"];
      let authoringRevisionAccounting: HarnessStepResult["authoringRevisionAccounting"];
      let qualityArtifactCandidate: HarnessStepResult["qualityArtifactCandidate"];
      let planBinding: HarnessStepResult["planBinding"];
      let planResponseSha256: HarnessStepResult["planResponseSha256"];
      let planProposedMode: HarnessStepResult["planProposedMode"];
      let editorialDecisionProposal: HarnessStepResult["editorialDecisionProposal"];
      let editorialAssessmentProposal: HarnessStepResult["editorialAssessmentProposal"];
      let planDiagnostic: HarnessStepResult["planDiagnostic"];
      // Each admission step calls the evidence collector itself, so every
      // refusal records the attempt as it stood when it threw.
      const admission: ReplyAdmissionContext = {
        decodedResponse,
        collectAttemptEvidence,
        refuseContractPlaceholder,
      };
      // The size of the reply span the step's decoder admitted, recorded on the
      // succeeded attempt so answer-size bounds can be measured, not guessed.
      const answerBytesEvidence = (): Pick<HarnessStepResult, "answerBytes"> => {
        // A submitted answer is its raw arguments plus its report reply.
        if (submissionMembers) {
          return {
            answerBytes: submissionBytes + Buffer.byteLength(decodedReply ?? "", "utf8"),
          };
        }
        const span = admittedReplySpan(input, decodedReply);
        return span === undefined ? {} : { answerBytes: Buffer.byteLength(span, "utf8") };
      };
      const plannerAdmission = admitPlannerReply(input, summary, admission);
      // Only a planner's admitted needs-input reply ends the step here.
      if (plannerAdmission?.outcome === "needs-input") {
        planDiagnostic = plannerAdmission.planDiagnostic;
        return {
          summary: plannerAdmission.summary,
          outcome: "needs-input",
          planDiagnostic,
          ...answerBytesEvidence(),
          ...collectAttemptEvidence(),
          skill: governedEvidence ?? {
            id: skill.name,
            contentSha256: skillContentSha256,
          },
        };
      }
      if (plannerAdmission) {
        ({ summary, planBinding, editorialDecisionProposal, planResponseSha256 } =
          plannerAdmission);
        planProposedMode = await confirmProposedUpdatePlan(input, plannerAdmission, admission);
      }
      const editorialAssessmentAdmission = admitEditorialAssessmentReply(input, summary, admission);
      ({ summary, editorialAssessmentProposal } = editorialAssessmentAdmission);
      ({ summary, authoringRevisionAccounting } = admitAuthoringRevisionReply(
        input,
        summary,
        admission,
      ));
      // A judgment reply that spent a continuation already repaid its output
      // allowance, so a model-content refusal takes the floor on this attempt.
      // An uncut reply takes that floor only when no retry is left. The
      // continuation branch admits only retryable model-content refusals;
      // credential and floor-admission refusals still fail the step.
      if (input.sourceObligationAnswerRecords) {
        rejectedSpan = decodedResponse;
        sourceObligationProposal = validateSourceObligationProposal(
          await input.sourceObligationAnswerRecords.finish(),
          input,
        );
        summary = canonicalSourceObligationProposal(sourceObligationProposal);
      } else {
        ({
          summary,
          verificationResult,
          sourceObligationProposal,
          technicalCorrectionEvidence,
          provisionalRichCandidateEvidence,
        } = await admitJudgmentReply(
          input,
          summary,
          admission,
          hostCompletedLedgerCut?.coveragePolicy,
        ).catch((error: unknown) => {
          const floor = hostCompletedLedgerCut
            ? refusedAsModelContent(error)
              ? hostFillRefusedCutJudgment(input, hostCompletedLedgerCut, error)
              : undefined
            : lengthStopContinuations > 0 &&
                answerNowAppliesTo(input) &&
                refusedAsModelContent(error)
              ? hostFillRefusedJudgment(input, error, "continued-refusal")
              : refusedWithNoRetryLeft(input, error)
                ? hostFillRefusedJudgment(input, error)
                : undefined;
          if (!floor) throw error;
          decodedReply = floor.reply;
          return admitJudgmentReply(input, floor.reply, admission, floor.coveragePolicy);
        }));
      }
      // On the tool-call answer path the reply is the report, admitted with the
      // submission's members; a host-completed cut is the host's own envelope,
      // read as the text answer reads it. The report reply is what a refusal
      // retains, and the report state is settled before any refusal reads the
      // attempt evidence.
      let qualityAnswerRecordReport: string | undefined;
      if (input.sourceObligationAnswerRecords) {
        // `summary` is assembled from settled rows by the injected S2 capability.
      } else if (input.qualityAnswerRecords) {
        rejectedSpan = decodedResponse;
        try {
          summary = admitQualityAnswerRecordReport(decodedResponse);
        } catch (error) {
          throw qualitySubmissionFailure(error, collectAttemptEvidence());
        }
        qualityAnswerRecordReport = summary;
      } else if (toolPath && !hostCompletedQualityReportCut) {
        rejectedSpan = decodedResponse;
        ({ summary, qualityArtifactCandidate } = admitQualitySubmissionReply(
          input,
          submissionMembers,
          summary,
          {
            ...admission,
            collectAttemptEvidence: () => {
              if (reportAsked && reportOutcome === undefined) reportOutcome = "refused";
              return collectAttemptEvidence();
            },
          },
        ));
      } else {
        ({ summary, qualityArtifactCandidate } = admitQualityArtifactReply(
          input,
          summary,
          admission,
          // A continued or host-built cut answer is not a model-text syntax
          // limitation. Only this attempt's independently admitted outer reply
          // can carry its actual proposal through the strict inner refusal.
          !toolPath && !hostCompletedCut && lengthStopContinuations === 0
            ? {
                admission: editorialAssessmentAdmission,
                skill: governedEvidence ?? { id: skill.name, contentSha256: skillContentSha256 },
              }
            : undefined,
        ));
      }
      if (reportAsked && reportOutcome === undefined) reportOutcome = "admitted";
      summary = admitReviewResultReply(input, summary, admission);
      // The quality evaluator's report can arrive as Markdown after its JSON
      // object, so the gate reads the admitted members as the one envelope.
      refuseContractPlaceholder(
        qualityArtifactCandidate
          ? JSON.stringify({
              evaluation: qualityArtifactCandidate.evaluation,
              qualityScore: qualityArtifactCandidate.qualityScore,
              reportMarkdown: qualityArtifactCandidate.reportMarkdown,
            })
          : decodedResponse,
      );
      if (requiresAdmittedReviewResponse(input)) {
        input.onText?.(summary);
      }
      return {
        summary,
        ...(qualityArtifactCandidate ? { qualityArtifactCandidate } : {}),
        ...(qualityAnswerRecordReport ? { qualityAnswerRecordReport } : {}),
        ...(verificationResult ? { verificationResult } : {}),
        ...(sourceObligationProposal ? { sourceObligationProposal } : {}),
        ...(technicalCorrectionEvidence ? { technicalCorrectionEvidence } : {}),
        ...(provisionalRichCandidateEvidence ? { provisionalRichCandidateEvidence } : {}),
        ...(authoringRevisionAccounting ? { authoringRevisionAccounting } : {}),
        ...(planBinding ? { planBinding } : {}),
        ...(planResponseSha256 ? { planResponseSha256 } : {}),
        ...(planProposedMode ? { planProposedMode } : {}),
        ...(editorialDecisionProposal ? { editorialDecisionProposal } : {}),
        ...(editorialAssessmentProposal ? { editorialAssessmentProposal } : {}),
        ...(planDiagnostic ? { planDiagnostic } : {}),
        ...judgmentRowKeyEvidence(input, decodedReply, replyShapePolicy),
        ...answerBytesEvidence(),
        ...collectAttemptEvidence(),
        // The plan-scope stop keys on mutation denials, not the aggregate category.
        ...(confinedTools.getMutationBoundaryDenials() > 0
          ? {
              mutationBoundaryDenials: confinedTools.getMutationBoundaryDenials(),
            }
          : {}),
        // Citation admission reads which lines the model was shown; never persisted.
        ...(confinedTools.getObservedSourceLines()
          ? { observedSourceLines: confinedTools.getObservedSourceLines() }
          : {}),
        ...(confinedTools.getReviewReadObservation()
          ? { reviewReadObservation: confinedTools.getReviewReadObservation() }
          : {}),
        ...(confinedTools.getReviewChangeObservation()
          ? { reviewChangeObservation: confinedTools.getReviewChangeObservation() }
          : {}),
        ...(repositoryInstructions.length > 0 ? { repositoryInstructions } : {}),
        skill: governedEvidence ?? {
          id: skill.name,
          contentSha256: skillContentSha256,
        },
      };
    } catch (error) {
      // A decode failure of an answer already completed by continuation is the
      // `cut-answer` condition: its retry rule has its own small budget, because
      // each retry re-pays the whole output allowance. The retained span is what
      // the step's decoder parsed from `decodedReply`.
      throw retainRejectedReplyShape(
        markStitchedReplyRefusal(error, lengthStopContinuations),
        rejectedSpan ?? admittedReplySpan(input, decodedReply),
        replyShapePolicy,
        rejectedInnerTexts,
      );
    } finally {
      input.signal?.removeEventListener("abort", cancelSession);
      try {
        await cancellation;
      } finally {
        try {
          await studyWrite;
        } finally {
          try {
            await answerRecordSettlement;
          } finally {
            if (attemptTimeout !== undefined) clearTimeout(attemptTimeout);
            confinedTools.disposeReviewReadObservation();
            confinedTools.disposeReviewChangeObservation();
            session.dispose();
            observedSession?.dispose();
          }
        }
      }
    }
  }

  private redact(error: unknown): string {
    return redactSecrets(error, [this.credential.apiKey]);
  }

  private skillPolicyTools(input: HarnessStepInput): string[] {
    return skillPolicyToolsForMode(input.step.mode, input.step.kind);
  }

  private grantedTools(input: HarnessStepInput, historyRead: boolean): string[] {
    return grantedToolsForStep(
      input.workflow,
      input.step,
      input.qualityProfileSelection !== undefined,
      input.sourceReader !== undefined,
      input.sourceSearcher !== undefined,
      input.sourceCiter !== undefined,
      this.options.toolResultRecall === true,
      input.toolCeiling,
      input.answerSubmission,
      historyRead,
      input.qualityAnswerRecords !== undefined,
      input.sourceObligationAnswerRecords !== undefined,
      input.preservationSourceReader !== undefined,
      input.reviewChangeSource !== undefined,
    );
  }
}

function validateQualityCandidateToolBinding(
  input: HarnessStepInput,
): HarnessStepInput["technicalVerification"] {
  const qualityArtifactBound = input.qualityProfileSelection !== undefined;
  if (
    !qualityArtifactBound &&
    input.workflow.name === "review-documentation" &&
    input.step.id === "evaluate-document-quality" &&
    input.step.skill === "evaluate-document-quality" &&
    (input.step.kind ?? "inference") === "evaluate" &&
    input.step.mode === "read-only" &&
    (input.technicalVerification !== undefined ||
      input.evidenceIdentity?.technicalVerificationSha256 !== undefined)
  ) {
    throw new Error(
      "The unbound evaluator cannot accept a technical verification candidate binding.",
    );
  }
  if (!isQualityCandidateValidationStep({ ...input, qualityArtifactBound })) return undefined;
  if (!input.technicalVerification || !input.evidenceIdentity?.technicalVerificationSha256) {
    throw new Error("The final evaluator is missing its admitted technical verification binding.");
  }
  validateVerificationResult(input.technicalVerification, authoritativeReviewTargetPaths(input));
  if (
    canonicalDigest(input.technicalVerification) !==
    input.evidenceIdentity.technicalVerificationSha256
  ) {
    throw new Error(
      "The final evaluator technical verification digest does not match its binding.",
    );
  }
  return input.technicalVerification;
}

/**
 * The step prompt the host sends: the step's response contract, then the
 * suffix, reader context, and any editorial envelope.
 */
export function buildHostStepPrompt(
  input: HarnessStepInput,
  suffix = "",
  // Effective per-turn output limit. When absent, the judgment answer-budget
  // sentence is omitted rather than stated from the registry ceiling.
  outputTokens?: number,
): string {
  return buildDocsFabStepPrompt(
    bindAuthoringRevisionResponseContract(
      bindQualityArtifactResponseContract(
        requiresSourceObligationLedger(input) || requiresTechnicalCorrection(input)
          ? bindSourceObligationResponseContract(input, outputTokens)
          : usesProvisionalVerificationJudgment(input)
            ? bindProvisionalVerificationJudgmentContract(input, outputTokens)
            : bindReviewResponseContract(input, reviewResponsePlacement(input)),
      ),
    ),
    suffix,
    input.readerTaskContext,
    buildEditorialResponseContractV1(input),
  );
}

function requiresAdmittedReviewResponse(input: HarnessStepInput): boolean {
  return (
    requiresSourceObligationLedger(input) ||
    requiresVerificationResult(input) ||
    requiresEditorialReviewResult(input)
  );
}

function requiresStructuredResponseEnvelope(input: HarnessStepInput): boolean {
  return (
    (input.step.skill === "plan-documentation" &&
      documentationPlanModeForWorkflow(input.workflow.name) !== undefined) ||
    isEditorialAssessmentStep(input) ||
    isAuthoringRevisionWriter(input) ||
    requiresTechnicalCorrection(input) ||
    requiresAdmittedReviewResponse(input) ||
    isQualityArtifactEvaluator(input)
  );
}

/**
 * A step whose reply a decoder outside this harness reads as one JSON document,
 * taken from the final settled message only so an earlier tool turn's JSON is
 * never admitted. Kept out of {@link requiresStructuredResponseEnvelope}, which
 * also scopes the placeholder gate and length-stop continuation.
 */
function decodesFinalReplyOutsideHarness(input: HarnessStepInput): boolean {
  return (
    isSourceReadinessStep(input) ||
    isRepositoryBootstrapStep(input) ||
    isSemanticComparisonStep(input)
  );
}

class CompositionAttemptTimeoutError extends Error {
  public readonly code = "composition-attempt-timeout" as const;
  public readonly retryable = true as const;

  public constructor(public readonly timeoutMs: number) {
    super(`Composition model attempt timed out after ${timeoutMs}ms.`);
    this.name = "CompositionAttemptTimeoutError";
  }
}
