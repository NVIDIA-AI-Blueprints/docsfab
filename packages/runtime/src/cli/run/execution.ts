// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { resolvePlanOperatorInput } from "./plan-operator-naming.js";
import { createHash, randomUUID } from "node:crypto";
import { projectSourceRequestContext } from "../../inputs/source-evidence.js";
import { createPrReviewCitationAdmission } from "../../workflow-execution/pr-review-citation-admission.js";
import { dirname, resolve } from "node:path";
import type { RunRecord } from "../../records/contracts.js";
import {
  isNonInferenceRuntimeConfig,
  ModelRuntimeRequiredOperatorError,
} from "../../config/runtime-loader.js";
import { contextPacketInputWindow } from "../../context/budget.js";
import { PiHarness } from "../../harness/pi.js";
import { DurableArtifactStore } from "../../artifacts/store.js";
import { runWithHostBoundCanon } from "../../harness/canon-tools.js";
import { resolveToolOutputCapBytes } from "../../harness/tool-output-cap.js";
import { withoutInference } from "../../templates/audit-operation.js";
import {
  answerSubmissionRecordsFitForEffectiveLimits,
  resolveOperatorExecutionBinding,
  type OperatorExecutionBinding,
} from "../../model/operator-execution-binding.js";
import type { SourceReadBudgetV1 } from "../../inputs/source-step-policy.js";
import { createProviderConnectionFactory } from "../../model/provider.js";
import {
  mintCliOperatorDirectedLineage,
  resolveCliOperatorAuthorityId,
} from "../../lineage/index.js";
import { createCompositionExecutionEvidence } from "../../records/composition-execution.js";
import { bindAnswerRecordDiscoveryExecutionV1 } from "../../records/answer-record-discovery.js";
import {
  retainedReaderEvidenceRequest,
  type RunRecordReaderEvidenceRequestV1,
} from "../../records/reader-evidence-request.js";
import { workflowBranchCoverageDecodeOptionsV1 } from "../../records/composition-execution.js";
import { StudySession, studyDirectory } from "../../records/study-store.js";
import {
  retainedEvidenceBindings,
  type RetainedChangeRequestPinV1,
  type RetainedEvidenceBindingsV1,
  type RetainedSourcePinV1,
} from "../../records/retained-evidence-bindings.js";
import { assertContinuedEvidenceMatches } from "../../inputs/operator-input-fill.js";
import { normalizeSourceSelection } from "../../inputs/source-acquisition.js";
import {
  CLI_SOURCE_READ_SCOPE,
  cliSourceExtractionLimits,
  createWorkspaceTrackedSourceReader,
  resolveCliPrReviewSourceEvidence,
  workspaceIdentityDigest,
  type CliChangeRequestSourceEvidence,
} from "./source-acquisition.js";
import { GitPatchEvidenceCollector } from "../../repository/evidence.js";
import { CatalogSkillCrateResolver } from "../../skills/catalog-crate-resolver.js";
import {
  assembleEditorialAdmissionControlV1,
  createLocalWorkflowApplicationServices,
  executeWorkflowApplication,
} from "../../application/index.js";
import {
  workflowOutcomeExitCode,
  interactiveWorkflowOutcomePolicy,
  releaseGateWorkflowOutcomePolicy,
  type WorkflowOutcomeDecodeOptionsV1,
} from "../../workflow-contracts/outcome.js";
import { decodeWorkflowBranchCoverageV1 } from "../../workflow-contracts/branch-coverage.js";
import type { RepositoryWorkspace } from "../../repository/workspace/contracts.js";
import { prepareRepositoryWorkspace } from "../../repository/workspace/materialize.js";
import { resolvePreservationDeliveryPolicy } from "../../workflow-execution/preservation-delivery-policy.js";
import {
  resolveEvidenceInputFormatPolicy,
  type EvidenceInputFormatPolicyV1,
} from "../../harness/evidence-input-format.js";
import type { CliRunInvocation } from "./request.js";
import type { RunPreflight } from "./preflight.js";
import type { HostOperationAssembly } from "./host-operations.js";
import { assertWorkflowActive } from "../../execution/cancellation.js";
import type { RunRequest } from "../../execution/contracts.js";
import {
  conservativeReaderContextInput,
  createReaderTaskContextSupplier,
  type ReaderTaskContextInputProjectionV1,
} from "../../execution/task-context.js";
import {
  observeReaderTaskContextAdmissionV1,
  type ReaderSourceHintV1,
  type ReaderTaskContextObservationV1,
} from "../../execution/reader-task-admission.js";
import { admitRunBeforeModel } from "./pre-model-admission.js";
import { selectDocumentationQualityProfile } from "../../evaluation-report/quality-profile-selection.js";
import { buildRepositoryDiscoveryInventory } from "../../repository/inventory.js";
import { resolveLocalReviewScope } from "../../workflow-execution/local-review-scope.js";
import type { ReaderComparisonRequestV1 } from "../../search/change-impact.js";
import {
  resolveCliChangeRequestEvidenceFromSelector,
  resolveCliChangeSourceEvidence,
  resolveCliSourceEvidence,
  sourceReadBudgetForModel,
} from "./source-acquisition.js";
import { failChangeSource } from "../../inputs/change-source.js";
import {
  isAcquiredReleaseRange,
  isResolvedReleaseRange,
  type AcquiredReleaseRangeV1,
} from "../../inputs/change-source/release.js";
import { mergeRequestTextSelector } from "../../inputs/change-source/gitlab.js";
import { failChangeRequestSelector } from "../../inputs/change-request-selector.js";
import { resolveGitLabMergedMrProject } from "../../inputs/merged-mr-gitlab.js";
import { authorizeSecurityScan } from "../../security/scan-override.js";
import { resolveSecurityScanEffectiveDisposition } from "../../security/scan-disposition.js";
import { ExecInitCommandRunner } from "../../init/shared.js";
import {
  assembleMergedMrUpdate,
  issueMergedMrCliSourceEvidence,
  type MergedMrUpdateAssemblyV1,
} from "./merged-mr-update.js";
import {
  inventoryHasLimitOverflow,
  mergeRunLimitOverflowEvidence,
  overflowSourceRepresentationsFromAcquired,
  type RunLimitOverflowEvidenceV1,
} from "../../operator/run-limit-overflow.js";
import type { AcquiredChangeSourceV1 } from "../../inputs/change-source/acquisition.js";
import {
  runChangeSourceFromAcquired,
  type RunChangeSourcesV1,
} from "../../records/change-sources.js";
import {
  runChangeSourceReleaseFromAcquired,
  runChangeSourcesFromRelease,
  type RunChangeSourceReleaseV1,
} from "../../records/change-source-release.js";
import type { ResolvedCliChangeSourceV1 } from "./source-acquisition.js";
import { createRunNotes } from "../../records/run-notes.js";
import { runModelSettings } from "../../records/run-model-settings.js";
import { servedModelWarning } from "../../model/provider.js";
import {
  assertFreshGitLabSourceBinding,
  prepareFreshGitLabReviewDelivery,
  type FreshGitLabReviewBinding,
} from "../review-delivery.js";
import { ReviewDeliveryCliOperatorError } from "../review-delivery-error.js";
import { failCliPrCustody } from "./pr-h-source.js";

export interface ExecutedCliRun {
  readonly record: RunRecord;
  readonly exitCode: 0 | 1 | 2;
  readonly reviewDeliveryBinding?: FreshGitLabReviewBinding;
  readonly editorialDecodeOptions?: WorkflowOutcomeDecodeOptionsV1;
  /**
   * Overflow not already on the saved run record, such as `--source`
   * representations or review inventory that never became
   * `repositoryBatchAuthority`.
   */
  readonly limitOverflowEvidence?: RunLimitOverflowEvidenceV1;
}

type RunModelSelection = Pick<
  CliRunInvocation,
  "request" | "config" | "options" | "compositionRuntime"
>;

/**
 * The binding a run's workflow model executes under on the model-profile path.
 * An injected harness and a sealed composition, which carries its own bound
 * profile, have none.
 */
export function resolveRunOperatorBinding(
  invocation: RunModelSelection,
): Promise<OperatorExecutionBinding | undefined> {
  if (isNonInferenceRuntimeConfig(invocation.config)) {
    if (invocation.request.workflow !== "audit-documentation") {
      throw new ModelRuntimeRequiredOperatorError();
    }
    return Promise.resolve(undefined);
  }
  if (invocation.request.workflow === "audit-documentation") return Promise.resolve(undefined);
  const { options } = invocation;
  if (options.executionHarness ?? options.harness ?? invocation.compositionRuntime) {
    return Promise.resolve(undefined);
  }
  return resolveOperatorExecutionBinding({
    model: invocation.config.model,
    workflowId: invocation.request.workflow,
  });
}

/**
 * The per-step source-read budget of the model a run binds: bounded by its
 * input window as well as the declared ceiling, so a full budget of source
 * text cannot crowd a small window out. An injected harness binds no model,
 * so it keeps the ceiling.
 */
export function runSourceReadBudget(
  invocation: RunModelSelection,
  operatorBinding: OperatorExecutionBinding | undefined,
): SourceReadBudgetV1 {
  const { options } = invocation;
  return sourceReadBudgetForModel(
    (options.executionHarness ?? options.harness)
      ? undefined
      : (invocation.compositionRuntime?.executionProfile ?? operatorBinding?.profile),
  );
}

export async function executeWorkflowRun(
  invocation: CliRunInvocation,
  workspace: RepositoryWorkspace,
  evidence: GitPatchEvidenceCollector,
  preflight: RunPreflight,
  hostAssembly: HostOperationAssembly,
): Promise<ExecutedCliRun> {
  return withLocalPreservationSourceWorkspace(
    workspace,
    invocation.request.workflow,
    (source, policy, evidenceInputFormatPolicy) =>
      executeWorkflowRunBound(
        invocation,
        workspace,
        evidence,
        preflight,
        hostAssembly,
        source,
        policy,
        evidenceInputFormatPolicy,
      ),
  );
}

/** Keep the original-source export alive until local execution has settled. */
export async function withLocalPreservationSourceWorkspace<T>(
  workspace: RepositoryWorkspace,
  workflow: string,
  action: (
    sourceWorkspace: RepositoryWorkspace | undefined,
    policy: ReturnType<typeof resolvePreservationDeliveryPolicy>,
    evidenceInputFormatPolicy: EvidenceInputFormatPolicyV1,
  ) => Promise<T>,
): Promise<T> {
  const policy = resolvePreservationDeliveryPolicy({
    workflow,
    environment: process.env,
  });
  const evidenceInputFormatPolicy = resolveEvidenceInputFormatPolicy(process.env);
  const sourceWorkspace =
    policy.preservationBaseDelivery === "stage-specific"
      ? await prepareRepositoryWorkspace(workspace.sourcePath, workspace.revision)
      : undefined;
  try {
    return await action(sourceWorkspace, policy, evidenceInputFormatPolicy);
  } finally {
    await sourceWorkspace?.dispose();
  }
}

async function executeWorkflowRunBound(
  invocation: CliRunInvocation,
  workspace: RepositoryWorkspace,
  evidence: GitPatchEvidenceCollector,
  preflight: RunPreflight,
  hostAssembly: HostOperationAssembly,
  preservationSourceWorkspace: RepositoryWorkspace | undefined,
  preservationDeliveryPolicy: ReturnType<typeof resolvePreservationDeliveryPolicy>,
  evidenceInputFormatPolicy: EvidenceInputFormatPolicyV1,
): Promise<ExecutedCliRun> {
  const { request, config, options } = invocation;
  assertWorkflowActive(options.signal);
  // A caller that skipped `withLocalWorkflowRun` runs no request interpretation,
  // so its `--source` paths keep their check at acquisition, still ahead of its
  // first model call.
  const { qualityPack: verifiedQualityPack, styleContext } =
    invocation.preModelAdmission ?? (await admitRunBeforeModel({ config, workspace }));
  let readerTaskContextInput: ReaderTaskContextInputProjectionV1 | undefined;
  let readerTaskContextObservation: ReaderTaskContextObservationV1 | undefined;
  let readerTaskContextSupplier:
    | Awaited<ReturnType<typeof createReaderTaskContextSupplier>>
    | undefined;
  let initialSourceHints: Array<{
    role: import("../../context/reader-context.js").ReaderContextProvenanceSourceV1["role"];
    path: string;
  }> = [];
  let comparisonRequest: ReaderComparisonRequestV1 | undefined;
  let requestEvidenceText: string | undefined;
  let retainsVirtualRequest = true;
  let mergedMrAssembly: MergedMrUpdateAssemblyV1 | undefined;
  let readerEvidenceRequest: RunRecordReaderEvidenceRequestV1 | undefined;
  if (request.readerTaskContext && request.workflow !== "update-documentation") {
    throw new Error("Reader task context is supported only by update-documentation.");
  }
  if (request.workflow === "update-documentation") {
    const supplier = await createReaderTaskContextSupplier(verifiedQualityPack);
    readerTaskContextSupplier = supplier;
    const handoff = request.readerTaskContext
      ? supplier.validateHandoff(request.readerTaskContext)
      : undefined;
    const assembled = handoff
      ? undefined
      : await assembleMergedMrUpdate({ request, workspace, options });
    mergedMrAssembly = assembled;
    const readerInstruction = (
      request.instruction ?? "Assess the authorized bounded documentation update."
    ).normalize("NFC");
    const namedChangeScope = uniqueNamedDocumentationPaths([
      ...(invocation.firstPassTargetControl?.targetPaths ?? []),
      ...(request.contextTarget?.sourcePath ? [request.contextTarget.sourcePath] : []),
    ]);
    const readerContextInput = handoff
      ? handoff.readerContextInput
      : mergedMrAssembly
        ? mergedMrAssembly.readerContextInput
        : conservativeReaderContextInput({
            instruction: readerInstruction,
            ...(namedChangeScope ? { changeScope: namedChangeScope } : {}),
          });
    requestEvidenceText = (request.instruction ?? readerContextInput.reader_job).normalize("NFC");
    const replay = handoff ? replayableHandoffSources(handoff) : undefined;
    retainsVirtualRequest = handoff ? Boolean(replay?.retainsRequest) : true;
    initialSourceHints = [
      ...(replay?.sourceHints ?? mergedMrAssembly?.readerSources ?? request.readerSources ?? []),
    ];
    comparisonRequest = handoff
      ? comparisonRequestFromHandoff(handoff.comparison)
      : request.comparisonRequest;
    // Keep only what the operator supplied: a handoff's comparison and sources,
    // and merged-MR-assembled sources, are re-derived by their own path.
    readerEvidenceRequest = retainedReaderEvidenceRequest({
      ...(handoff ? {} : { comparisonRequest: request.comparisonRequest }),
      ...(handoff || mergedMrAssembly ? {} : { readerSources: request.readerSources }),
    });
    const missingMergedMrSources: ReaderSourceHintV1[] = [];
    const skipMissingMergedMrSources = mergedMrAssembly !== undefined;
    readerTaskContextObservation = await observeReaderTaskContextAdmissionV1({
      repositoryPath: workspace.sourcePath,
      revision: workspace.revision,
      observationMode: "workflow-export",
      readerContextInput,
      comparisonRequest,
      sourceHints: initialSourceHints,
      ...(skipMissingMergedMrSources
        ? {
            onMissingSource: (source) => {
              missingMergedMrSources.push(source);
            },
          }
        : {}),
      ...(retainsVirtualRequest && requestEvidenceText ? { requestText: requestEvidenceText } : {}),
    });
    if (handoff) supplier.validateHandoff(handoff, readerTaskContextObservation.admission);
    const readerContextForProjection =
      missingMergedMrSources.length === 0
        ? readerContextInput
        : {
            ...readerContextInput,
            known_limitations: [
              ...new Set([
                ...(readerContextInput.known_limitations ?? []),
                ...missingMergedMrSources.map(
                  (source) =>
                    `Repository evidence was unavailable at the selected revision: ${source.path}. Continue with the admitted files; report this gap and do not treat the missing file as verified evidence.`,
                ),
              ]),
            ],
          };
    readerTaskContextInput = supplier.projectInput(readerContextForProjection, {
      inputOrigin: handoff?.inputOrigin ?? "conservative-fallback",
      ...(handoff ? { handoff } : {}),
    });
  } else if (
    request.workflow === "review-documentation" ||
    request.workflow === "create-documentation"
  ) {
    // Same date-window discovery as UPDATE, but REVIEW and CREATE have no
    // reader task context, so they read the diffs only through the source
    // binding minted below. `undefined` unless the instruction names a
    // merged-MR date window.
    mergedMrAssembly = await assembleMergedMrUpdate({
      request,
      workspace,
      options,
    });
  }
  const editorialAdmissionAssembly = await assembleEditorialAdmissionControlV1({
    artifactRoot: resolve(dirname(config.stateDirectory), "artifacts"),
    contentIndex: preflight.contentIndex,
    readerTaskContext: readerTaskContextInput,
    observation: readerTaskContextObservation,
    supplier: readerTaskContextSupplier,
    repositoryPath: workspace.sourcePath,
    revision: workspace.revision,
    initialSourceHints,
    comparisonRequest,
    capRefreshNominations: mergedMrAssembly !== undefined,
    retainsVirtualRequest,
    ...(requestEvidenceText ? { requestEvidenceText } : {}),
  });
  const studySession =
    request.study === true
      ? new StudySession({ directory: studyDirectory(config.stateDirectory) })
      : undefined;
  if (studySession) invocation.studySession = studySession;
  let reviewInventory: Awaited<ReturnType<typeof buildRepositoryDiscoveryInventory>> | undefined;
  if (request.workflow === "review-documentation") {
    reviewInventory = await buildRepositoryDiscoveryInventory({ workspace });
    const reviewScope =
      invocation.githubPrScope?.scope ??
      resolveLocalReviewScope({
        instruction: request.instruction,
        sourcePath: request.contextTarget?.sourcePath,
        boundPaths: request.reviewTargetPaths,
        inventory: reviewInventory,
      });
    await selectDocumentationQualityProfile({
      workflow: preflight.workflow,
      workspace,
      inventory: reviewInventory,
      ...(reviewScope ? { targetPaths: reviewScope.targetPaths } : {}),
      pack: verifiedQualityPack,
    });
  }
  const reviewLocatorArtifacts =
    request.workflow === "review-documentation"
      ? new DurableArtifactStore(resolve(dirname(config.stateDirectory), "artifacts"))
      : undefined;
  const harnessOptions = {
    skillCrateDirectory: config.skillCrateDirectory,
    qualityDirectory: config.qualityDirectory,
    styleContext,
    toolOutputCapBytes: isNonInferenceRuntimeConfig(config)
      ? config.toolOutputCapBytes
      : resolveToolOutputCapBytes(),
    // A capped result stays recoverable by handle through the recall tool. The
    // local CLI has no sealed composition to keep equal, so it always opts in.
    toolResultRecall: true,
    ...(reviewLocatorArtifacts
      ? { reviewReadMaxObjectBytes: reviewLocatorArtifacts.maxObjectBytes }
      : {}),
    repositoryWorkspace: workspace,
    ...(studySession ? { study: studySession } : {}),
  };
  const baseHarness =
    request.workflow === "audit-documentation"
      ? withoutInference(options.executionHarness ?? options.harness)
      : (options.executionHarness ?? options.harness);
  const operatorBinding = await resolveRunOperatorBinding(invocation);
  if (operatorBinding?.operatorNotice) {
    invocation.output.error(operatorBinding.operatorNotice);
  }
  // A value that differs from the preset is shown and recorded, never refused.
  const settingsNotes = invocation.compositionRuntime?.notes ?? operatorBinding?.notes ?? [];
  for (const note of settingsNotes) invocation.output.error(`Warning: ${note}`);
  const runNotes = invocation.compositionRuntime?.runNotes ?? createRunNotes();
  // A provider that answers under another model name is shown as it happens and recorded.
  runNotes.onNote((note) => invocation.output.error(`Warning: ${note}`));
  const modelSettings = runModelSettings({
    writing: invocation.compositionRuntime?.modelSettings ?? operatorBinding?.modelSettings,
    judge: isNonInferenceRuntimeConfig(config) ? undefined : config.judge?.modelSettings,
  });
  const admittedHarness = baseHarness
    ? baseHarness
    : invocation.compositionRuntime
      ? new PiHarness({
          ...harnessOptions,
          executionProfile: invocation.compositionRuntime.executionProfile,
          credential: invocation.compositionRuntime.credential,
          providerConnectionFactory: invocation.compositionRuntime.providerConnectionFactory,
        })
      : operatorBinding
        ? new PiHarness({
            ...harnessOptions,
            executionProfile: operatorBinding.profile,
            credential: operatorBinding.credential,
            providerConnectionFactory: {
              routeId: operatorBinding.profile.routeId,
              transport: operatorBinding.profile.transport,
              create: (input, turnOptions) =>
                createProviderConnectionFactory({
                  routeId: operatorBinding.profile.routeId,
                  transport: operatorBinding.profile.transport,
                  onServedModel: (observation) => runNotes.add(servedModelWarning(observation)),
                }).create(input, turnOptions),
            },
          })
        : (() => {
            throw new Error("Omitted-mode execution is missing its required operator binding.");
          })();
  const answerSubmissionCapability = baseHarness
    ? undefined
    : (invocation.compositionRuntime?.executionProfile ?? operatorBinding?.profile)
        ?.answerSubmission;
  const sourceReadBudget = runSourceReadBudget(invocation, operatorBinding);
  // Context packets are a share of the input window the bound model admits;
  // a placeholder window that DocsFab does not admit against sizes nothing.
  const modelInputTokens = baseHarness
    ? undefined
    : contextPacketInputWindow(
        invocation.compositionRuntime?.executionProfile ?? operatorBinding?.profile,
      );
  const repositoryBinding = {
    identitySha256: createHash("sha256").update(workspace.sourcePath).digest("hex"),
    revision: workspace.revision,
  };
  // A run that mints a source binding needs its id first, because the binding
  // commits to `runIdSha256`. Ordinary no-source runs let the runner mint it.
  const sourceRequested = (request.sourcePaths?.length ?? 0) > 0;
  const changeRequestSelector = request.changeRequestSelector;
  const mergedMrSourceRequested = (mergedMrAssembly?.discovery.selected.length ?? 0) > 0;
  // A request that names a range must arrive resolved; binding it here would
  // move the range's refusals behind the first model call.
  if (request.changeSource !== undefined && invocation.changeSource === undefined) {
    failChangeSource("change-source-resolution-missing");
  }
  const changeSource = invocation.changeSource;
  const runId =
    request.runId ??
    (invocation.compositionRuntime ||
    sourceRequested ||
    invocation.githubPrBasis !== undefined ||
    mergedMrSourceRequested ||
    changeRequestSelector !== undefined ||
    changeSource !== undefined
      ? randomUUID()
      : undefined);
  const compositionExecution =
    invocation.compositionRuntime && !invocation.compositionRuntime.experimentalAnswerRecords
      ? createCompositionExecutionEvidence({
          runId: runId!,
          bound: invocation.compositionRuntime.bound,
          executionProfile: invocation.compositionRuntime.executionProfile,
          configuredLimits: invocation.compositionRuntime.configuredLimits,
          workflow: {
            id: invocation.compositionRuntime.bound.workflow.workflowId,
            sourceSha256: invocation.compositionRuntime.bound.workflow.sourceSha256,
          },
          repository: repositoryBinding,
          ...(invocation.compositionRuntime.modelSettings
            ? { modelSettings: invocation.compositionRuntime.modelSettings }
            : {}),
        })
      : undefined;
  const answerRecordDiscoveryDraft = invocation.compositionRuntime?.answerRecordDiscovery;
  const answerRecordDiscovery = answerRecordDiscoveryDraft
    ? bindAnswerRecordDiscoveryExecutionV1(answerRecordDiscoveryDraft, {
        runId: runId!,
        workflow: request.workflow,
        repositoryRevision: repositoryBinding.revision,
        repositoryIdentitySha256: repositoryBinding.identitySha256,
      })
    : undefined;
  let taskLineage = request.taskLineage;
  if (!taskLineage && request.instruction && request.allowWrite) {
    const writeCapable = preflight.workflow.steps.some((step) => step.mode === "write");
    if (writeCapable) {
      taskLineage = await mintCliOperatorDirectedLineage({
        instruction: request.instruction,
        task:
          hostAssembly.task?.kind === "create-documentation" ||
          hostAssembly.task?.kind === "update-documentation"
            ? null
            : (hostAssembly.task ?? null),
        workflow: request.workflow,
        repository: repositoryBinding,
        authorityId: resolveCliOperatorAuthorityId(),
        ...(runId ? { runId } : {}),
      });
    }
  }
  const applicationRequest = {
    signal: options.signal,
    ...(runId ? { runId } : {}),
    workflow: request.workflow,
    workspacePath: workspace.path,
    repository: {
      sourcePath: workspace.sourcePath,
      requestedRevision: workspace.requestedRevision,
      revision: workspace.revision,
      ...(request.gitlabTargetAtRunStart
        ? {
            gitlabTargetBranch: request.gitlabTargetAtRunStart.branch,
            gitlabTargetRevision: request.gitlabTargetAtRunStart.revision,
          }
        : {}),
    },
    ...(request.instruction ? { instruction: request.instruction } : {}),
    ...(request.retryDeliverySelection !== undefined
      ? {
          retryContext: {
            schemaVersion: 1,
            reconstructable: !(
              request.task ||
              request.planPath ||
              request.reviewerPolicyPath ||
              request.mergedMrSelection ||
              request.corpusExecutionAuthorizationPath ||
              request.corpusReviewerPolicyPath ||
              request.corpusCaseId ||
              request.corpusTestedRevision ||
              request.taskLineage ||
              request.changeRequestSelector ||
              request.changeSource ||
              request.knowledgeContinuationReceipt ||
              request.answerRecordContinuationReceipt ||
              request.resumeFrom
            ),
            instructionPresent: request.instruction !== undefined,
            deliveryMode: request.retryDeliverySelection,
            allowWrite: request.allowWrite,
            writeGrantExplicit: request.writeGrantExplicit ?? false,
            releaseGate: request.releaseGate,
            ...(request.study ? { study: true } : {}),
            ...(request.compositionId !== undefined
              ? { compositionId: request.compositionId }
              : {}),
            ...(request.experimentalAnswerRecords
              ? { experimentalAnswerRecords: true as const }
              : {}),
            ...(request.contextTarget ? { contextTarget: request.contextTarget } : {}),
            ...(request.docImprovementCampaignPath
              ? {
                  docImprovementCampaignPath: request.docImprovementCampaignPath,
                }
              : {}),
            ...(request.docImprovementReviewerPolicyPath
              ? {
                  docImprovementReviewerPolicyPath: request.docImprovementReviewerPolicyPath,
                }
              : {}),
            ...(request.canonSnapshotPath ? { canonSnapshotPath: request.canonSnapshotPath } : {}),
            ...(request.acceptCandidateSnapshot ? { acceptCandidateSnapshot: true } : {}),
            ...(request.canonSnapshotAuthorityId
              ? { canonSnapshotAuthorityId: request.canonSnapshotAuthorityId }
              : {}),
            ...(request.revisionExplicit ? { revision: request.revision } : {}),
            ...(request.draftMr && request.remoteName ? { remoteName: request.remoteName } : {}),
            ...(request.commentMr ? { commentMr: request.commentMr } : {}),
            ...(request.commentMrCanonSha256
              ? { commentMrCanonSha256: request.commentMrCanonSha256 }
              : {}),
            ...(request.comparisonRequest ? { comparisonRequest: request.comparisonRequest } : {}),
            ...(request.readerSources ? { readerSources: [...request.readerSources] } : {}),
            ...(request.sourcePaths ? { sourcePaths: [...request.sourcePaths] } : {}),
          },
        }
      : {}),
    ...(request.instructionContext ? { instructionContext: request.instructionContext } : {}),
    ...(readerEvidenceRequest ? { readerEvidenceRequest } : {}),
    ...(request.contextTarget ? { contextTarget: request.contextTarget } : {}),
    ...(invocation.githubPrBasisBinding ? { prReviewBasis: invocation.githubPrBasisBinding } : {}),
    ...(readerTaskContextInput
      ? {
          readerContextInput: readerTaskContextInput.readerContextInput,
          readerTaskContext: readerTaskContextInput,
        }
      : {}),
    ...(editorialAdmissionAssembly?.editorialEvidenceRefs
      ? {
          editorialEvidenceRefs: editorialAdmissionAssembly.editorialEvidenceRefs,
        }
      : {}),
    ...(hostAssembly.task ? { task: hostAssembly.task } : {}),
    allowWrite: request.allowWrite,
    ...(preflight.releaseDefaultBranch
      ? { releaseDefaultBranch: preflight.releaseDefaultBranch }
      : {}),
    ...(taskLineage ? { taskLineage } : {}),
    ...(compositionExecution ? { compositionExecution } : {}),
    ...(answerRecordDiscovery ? { answerRecordDiscovery } : {}),
    ...(modelSettings ? { modelSettings } : {}),
    ...(hostAssembly.knowledgeResumeReceipt
      ? { knowledgeResumeReceipt: hostAssembly.knowledgeResumeReceipt }
      : {}),
    ...(request.knowledgeContinuationReceipt
      ? { knowledgeContinuationReceipt: request.knowledgeContinuationReceipt }
      : {}),
    ...(request.knowledgeContinuationRecoveryAuthorization
      ? {
          knowledgeContinuationRecoveryAuthorization:
            request.knowledgeContinuationRecoveryAuthorization,
        }
      : {}),
    ...(request.knowledgeContinuationSnapshotSha256
      ? {
          knowledgeContinuationSnapshotSha256: request.knowledgeContinuationSnapshotSha256,
        }
      : {}),
    ...(request.knowledgeContinuationAcceptanceSha256
      ? {
          knowledgeContinuationAcceptanceSha256: request.knowledgeContinuationAcceptanceSha256,
        }
      : {}),
    ...(invocation.answerRecordContinuation
      ? { answerRecordContinuation: invocation.answerRecordContinuation }
      : {}),
    ...(request.answerRecordContinuationReceipt
      ? {
          answerRecordContinuationReceipt: request.answerRecordContinuationReceipt,
        }
      : {}),
  } satisfies RunRequest;
  const dependencyAssembly = await createLocalWorkflowApplicationServices({
    config,
    runNotes,
    request: applicationRequest,
    ...(request.reviewTargetPaths ? { reviewTargetPaths: request.reviewTargetPaths } : {}),
    ...(invocation.githubPrScope ? { prReviewScope: invocation.githubPrScope.scope } : {}),
    workflow: preflight.workflow,
    workspace,
    ...(preservationSourceWorkspace ? { preservationSourceWorkspace } : {}),
    preservationDeliveryPolicy,
    evidenceInputFormatPolicy,
    repositoryEvidence: evidence,
    baseHarness: admittedHarness,
    // From the same bound profile the harness runs with, so the resolver and
    // the harness's invariant read one capability.
    ...(answerSubmissionCapability ? { answerSubmissionCapability } : {}),
    ...(!invocation.compositionRuntime?.experimentalAnswerRecords &&
    invocation.compositionRuntime?.bound.composition.answerSubmissionRecords
      ? (() => {
          const records = invocation.compositionRuntime!.bound.composition.answerSubmissionRecords!;
          const fit = answerSubmissionRecordsFitForEffectiveLimits({
            bound: invocation.compositionRuntime!.bound,
            effectiveLimits: invocation.compositionRuntime!.configuredLimits,
          });
          return fit?.fitsEffectiveTimer && fit.fitsRecordBoundary && fit.fitsQualifiedMessageFloor
            ? {
                qualityAnswerNowRecordsPlan: {
                  fixtureRows: records.fixtureRows,
                  fullPlanBytes: records.fullPlanEnvelopeBytes,
                  fullPlanMessages: fit.messages,
                  dFullMs: fit.dFullMs,
                  reportDecodeReserveMs: fit.reportDecodeReserveMs,
                  qualifiedMessageBudget: fit.effectiveMaxMessageBytes,
                  turnLatencyMs: records.lturnMs,
                  d3ResidualFires:
                    fit.d3ResidualSource === "observed-fire"
                      ? true
                      : fit.d3ResidualSource === "observed-no-fire"
                        ? false
                        : ("unknown" as const),
                },
              }
            : {};
        })()
      : {}),
    ...(invocation.claimAnswerRecordContinuation
      ? {
          claimAnswerRecordContinuation: invocation.claimAnswerRecordContinuation,
        }
      : {}),
    ...(modelInputTokens !== undefined ? { modelInputTokens } : {}),
    skillResolver:
      options.skillResolver ?? new CatalogSkillCrateResolver(config.skillCrateDirectory),
    ...(hostAssembly.hostOperations ? { hostOperations: hostAssembly.hostOperations } : {}),
    ...(preflight.impactPostflight ? { impactPostflight: preflight.impactPostflight } : {}),
    ...(preflight.rstCapabilityAdmission
      ? { rstCapabilityAdmission: preflight.rstCapabilityAdmission }
      : {}),
    ...(request.workflow === "ia-analysis"
      ? {
          iaAnalysis: {
            repositoryIdentity: preflight.iaRepositoryIdentity!,
            ...(request.inputDigest ? { packageDigest: request.inputDigest } : {}),
            ...(preflight.analysisExecutionAuthorizer
              ? { executionAuthorizer: preflight.analysisExecutionAuthorizer }
              : {}),
          },
        }
      : {}),
    onProgress: (event) => options.onProgress?.(event, preflight.workflow),
  });
  const admittedRequest: RunRequest = {
    ...applicationRequest,
    ...(dependencyAssembly.contextTarget
      ? { contextTarget: dependencyAssembly.contextTarget }
      : {}),
    ...(dependencyAssembly.reviewScope ? { reviewScope: dependencyAssembly.reviewScope } : {}),
    // First pass bound its write targets from this interpretation, so the
    // source projection digests it with the rest of the admitted request.
    ...(request.requestIntent ? { requestIntent: request.requestIntent } : {}),
    ...(request.firstPassChoices?.length ? { firstPassChoices: request.firstPassChoices } : {}),
  };
  // Source acquisition runs against the exact admitted request the runner will
  // receive, so the sealed request digest matches what the runner recomputes.
  // It cannot move earlier: the dependency assembly above resolves
  // `contextTarget` and `reviewScope`, which the request projection reads. It
  // still precedes the first workflow model call, but follows the knowledge
  // first pass.
  // A merged merge request binds its text beside its diff; an open one, and
  // a local range, bind the diff alone. Without a resolved change, `--pr`
  // binds its text as before.
  // A release range binds its units and index alone: only a single change
  // record can name a merge request whose text joins it.
  const changeRecord =
    changeSource && !isResolvedReleaseRange(changeSource) ? changeSource : undefined;
  const textSelector = changeSource
    ? changeRecord && mergeRequestTextSelector(changeRecord.changeSource)
    : changeRequestSelector;
  const prCustody = invocation.githubPrBasis
    ? await resolveCliPrReviewSourceEvidence({
        basis: invocation.githubPrBasis,
        workspace,
        sourcePaths: request.sourcePaths ?? [],
        targetPaths: invocation.githubPrScope?.scope.targetPaths ?? [],
        admittedRequest: admittedRequest as unknown as Record<string, unknown>,
        runId: runId!,
        readBudget: sourceReadBudget,
      })
    : undefined;
  if (prCustody && (!prCustody.sourceReference || !prCustody.sourceEvidence)) {
    prCustody.dispose();
    failCliPrCustody("github-pr-source-binding-unavailable");
  }
  try {
    // `--change` selects the basis, and `--source` files join the same binding.
    const changeSourceEvidence =
      changeSource && textSelector === undefined
        ? await resolveCliChangeSourceEvidence({
            workspace,
            resolved: changeSource,
            admittedRequest: admittedRequest as unknown as Record<string, unknown>,
            runId: runId!,
            ...(sourceRequested ? { sourcePaths: request.sourcePaths! } : {}),
            ...(invocation.options.hostTrackedSourceReader
              ? {
                  hostTrackedSourceReader: invocation.options.hostTrackedSourceReader,
                }
              : {}),
            readBudget: sourceReadBudget,
          })
        : undefined;
    // `--pr` selects the basis, and `--source` may add tracked files beside it;
    // one binding carries every producer's observations.
    const changeRequestEvidence = textSelector
      ? await resolveCliChangeRequestEvidenceFromSelector({
          workspace,
          selector: textSelector,
          ...(changeRecord ? { changeSource: changeRecord } : {}),
          admittedRequest: admittedRequest as unknown as Record<string, unknown>,
          runId: runId!,
          ...(sourceRequested ? { sourcePaths: request.sourcePaths! } : {}),
          ...(invocation.options.hostTrackedSourceReader
            ? {
                hostTrackedSourceReader: invocation.options.hostTrackedSourceReader,
              }
            : {}),
          checkout: async () => {
            // The checkout's own remote: the exported workspace has no git metadata.
            const project = await resolveGitLabMergedMrProject({
              repositoryPath: workspace.sourcePath,
            });
            if (typeof project.projectPath !== "string" || project.projectPath.length === 0) {
              // Coded, not a bare Error, so callers can branch on it and the
              // remediation contract test covers its wording.
              failChangeRequestSelector("checkout-project-unavailable");
            }
            return { host: project.host, projectPath: project.projectPath };
          },
          commands: options.changeRequestCommands ?? new ExecInitCommandRunner(),
          environment: options.changeRequestEnvironment ?? process.env,
          readBudget: sourceReadBudget,
        })
      : undefined;
    const sourceEvidence =
      (prCustody
        ? {
            reference: prCustody.sourceReference!,
            runnerBinding: prCustody.sourceEvidence!,
          }
        : undefined) ??
      changeRequestEvidence ??
      (changeSourceEvidence !== undefined || sourceRequested
        ? (changeSourceEvidence ??
          (await resolveCliSourceEvidence({
            workspace,
            sourcePaths: request.sourcePaths!,
            ...(invocation.options.hostTrackedSourceReader
              ? {
                  hostTrackedSourceReader: invocation.options.hostTrackedSourceReader,
                }
              : {}),
            admittedRequest: admittedRequest as unknown as Record<string, unknown>,
            runId: runId!,
            readBudget: sourceReadBudget,
          })))
        : mergedMrSourceRequested && mergedMrAssembly
          ? await issueMergedMrCliSourceEvidence({
              workspace,
              admittedRequest: admittedRequest as unknown as Record<string, unknown>,
              runId: runId!,
              assembly: mergedMrAssembly,
              readBudget: sourceReadBudget,
            })
          : undefined);
    // Derived before the runner, so a change the host resolved but did not
    // acquire refuses instead of reaching a record that cannot cite it. A merged
    // merge request acquires its change beside its text; every other change
    // acquires it alone.
    const acquiredChange = changeSourceEvidence?.acquired ?? changeRequestEvidence?.change;
    const changeSources = runChangeSourcesForRun(changeSource, acquiredChange);
    const changeSourceRelease = runChangeSourceReleaseForRun(acquiredChange);
    if (request.reviewDelivery !== undefined && request.reviewDelivery !== "preview") {
      throw new ReviewDeliveryCliOperatorError("publish-unsupported");
    }
    const freshDelivery =
      request.reviewDelivery === "preview"
        ? await (async () => {
            if (
              request.workflow !== "review-documentation" ||
              !request.reviewDeliveryTarget ||
              !changeRecord ||
              !acquiredChange ||
              isAcquiredReleaseRange(acquiredChange) ||
              !sourceEvidence ||
              !("acquired" in sourceEvidence) ||
              !reviewLocatorArtifacts ||
              options.reviewResultRetention ||
              prCustody
            ) {
              throw new ReviewDeliveryCliOperatorError("acquired-change-required");
            }
            const runSourceBinding = sourceEvidence.acquired.binding;
            assertFreshGitLabSourceBinding({
              binding: runSourceBinding,
              referenceDigest: sourceEvidence.reference.digest,
              repository: repositoryBinding,
              reviewedHead: changeRecord.changeSource.revision.head,
            });
            return prepareFreshGitLabReviewDelivery({
              targetUrl: request.reviewDeliveryTarget,
              sourcePath: workspace.sourcePath,
              runId: runId!,
              resolved: changeRecord,
              acquired: acquiredChange,
              runSourceBinding,
              artifacts: reviewLocatorArtifacts,
              commands: options.changeRequestCommands ?? new ExecInitCommandRunner(),
              ...(options.signal ? { signal: options.signal } : {}),
              limits: { environment: process.env, cwd: workspace.sourcePath },
            });
          })()
        : undefined;
    const boundRequest: RunRequest = {
      ...admittedRequest,
      ...(sourceEvidence ? { sourceBinding: sourceEvidence.reference } : {}),
    };
    const prReviewCitationAdmission =
      prCustody && invocation.githubPrBasisBinding
        ? createPrReviewCitationAdmission({
            basis: invocation.githubPrBasis!,
            basisBinding: invocation.githubPrBasisBinding,
            runId: runId!,
            requestSha256: projectSourceRequestContext(
              admittedRequest as unknown as Record<string, unknown>,
              {
                runId: runId!,
                workspaceIdentitySha256: workspaceIdentityDigest(workspace),
                repository: {
                  identitySha256: createHash("sha256").update(workspace.sourcePath).digest("hex"),
                  revision: workspace.revision,
                },
              },
            ),
            sourceBindingSha256: prCustody.binding!.bindingSha256,
            policySha256: prCustody.sourceEvidence!.policy.policySha256,
          })
        : undefined;
    // Pinned after acquisition and before the queued save: an InputAsk
    // continuation whose evidence differs from the stopped run's refuses here,
    // so no record is saved for it and the stopped run stays open.
    const retainedEvidenceBindings = await retainedEvidenceBindingsForRun({
      workspace,
      sourcePaths: sourceRequested ? request.sourcePaths! : [],
      ...(invocation.options.hostTrackedSourceReader
        ? {
            hostTrackedSourceReader: invocation.options.hostTrackedSourceReader,
          }
        : {}),
      changeRequestEvidence,
    });
    if (request.operatorInputResume !== undefined) {
      assertContinuedEvidenceMatches(request.operatorInputResume, {
        ...(retainedEvidenceBindings ? { retainedEvidenceBindings } : {}),
        ...(changeSources ? { changeSources } : {}),
      });
    }
    const operatorInput = await resolvePlanOperatorInput(request, config.stateDirectory);
    const run = () =>
      executeWorkflowApplication({
        services: {
          ...dependencyAssembly.services,
          ...(reviewLocatorArtifacts ? { reviewLocatorArtifacts } : {}),
          ...(freshDelivery?.reviewChangeSource
            ? { reviewChangeSource: freshDelivery.reviewChangeSource }
            : {}),
          ...((freshDelivery?.retention ?? invocation.options.reviewResultRetention)
            ? {
                reviewResultRetention:
                  freshDelivery?.retention ?? invocation.options.reviewResultRetention,
              }
            : {}),
          ...(invocation.options.outcomeProjector
            ? { outcomeProjector: invocation.options.outcomeProjector }
            : {}),
          ...(invocation.firstPassNotices?.length
            ? { firstPassNotices: invocation.firstPassNotices }
            : {}),
          ...(retainedEvidenceBindings ? { retainedEvidenceBindings } : {}),
          // Preserve the operator's inputs, before assembly's model-derived
          // contextTarget. This private record metadata grants no source reads.
          operatorTargetPaths: operatorInput?.explicitPaths ?? [],
          ...(editorialAdmissionAssembly?.workflowBranchEvidence
            ? {
                workflowBranchEvidence: editorialAdmissionAssembly.workflowBranchEvidence,
              }
            : {}),
          ...(editorialAdmissionAssembly?.editorialAdmission
            ? {
                editorialAdmission: editorialAdmissionAssembly.editorialAdmission,
              }
            : {}),
          ...(sourceEvidence ? { sourceEvidence: sourceEvidence.runnerBinding } : {}),
          ...(prReviewCitationAdmission ? { prReviewCitationAdmission } : {}),
          ...(changeSources ? { changeSources } : {}),
          ...(changeSourceRelease ? { changeSourceRelease } : {}),
          ...(invocation.planWriteScope ? { planWriteScope: invocation.planWriteScope } : {}),
          ...(invocation.planWriteScope?.rstUpdatePaths?.length
            ? { rstRepositoryWorkspace: workspace, rstCaptureBinding: {} }
            : {}),
          ...(hostAssembly.templateSet ? { templateSet: hostAssembly.templateSet } : {}),
        },
        request: boundRequest,
        ...(invocation.firstPassTargetControl
          ? { firstPassTargetControl: invocation.firstPassTargetControl }
          : {}),
      });
    const record: RunRecord =
      hostAssembly.task?.kind === "create-documentation" ||
      hostAssembly.task?.kind === "update-documentation"
        ? await runWithHostBoundCanon(hostAssembly.task.canonSha256, run)
        : await run();
    const editorialHost = editorialAdmissionAssembly?.workflowBranchEvidence;
    const hasSecurityEvidence =
      record.securityScan !== undefined ||
      record.securityScanAuthorization !== undefined ||
      record.securityScanEffectiveDisposition !== undefined;
    const editorialDecodeOptions: WorkflowOutcomeDecodeOptionsV1 | undefined =
      editorialHost || hasSecurityEvidence
        ? {
            ...(hasSecurityEvidence
              ? {
                  authorizeSecurityScan,
                  resolveSecurityScanEffectiveDisposition,
                }
              : {}),
            ...(editorialHost
              ? {
                  decodeEditorialDecision: (reference, stepId) =>
                    editorialHost.decodeEditorialDecision(reference, stepId),
                  decodeWorkflowBranchCoverage: (value, candidateRecord) =>
                    decodeWorkflowBranchCoverageV1(
                      value,
                      workflowBranchCoverageDecodeOptionsV1({
                        workflow: preflight.workflow,
                        record: candidateRecord,
                        requireComplete: candidateRecord.status === "succeeded",
                      }),
                    ),
                }
              : {}),
          }
        : undefined;
    const limitOverflowEvidence = mergeRunLimitOverflowEvidence(
      reviewInventory && inventoryHasLimitOverflow(reviewInventory)
        ? { inventory: reviewInventory }
        : undefined,
      {
        sourceRepresentations: overflowSourceRepresentationsFromAcquired(
          sourceEvidence && "acquired" in sourceEvidence ? sourceEvidence.acquired : undefined,
        ),
      },
    );
    return {
      record,
      ...(freshDelivery ? { reviewDeliveryBinding: freshDelivery.binding } : {}),
      exitCode:
        record.status === "needs-input"
          ? 2
          : workflowOutcomeExitCode(
              record,
              request.releaseGate
                ? releaseGateWorkflowOutcomePolicy()
                : interactiveWorkflowOutcomePolicy(),
              editorialDecodeOptions,
            ),
      ...(editorialDecodeOptions ? { editorialDecodeOptions } : {}),
      ...(limitOverflowEvidence ? { limitOverflowEvidence } : {}),
    };
  } finally {
    prCustody?.dispose();
  }
}

/**
 * The run record's change-source citation, from the change the host acquired
 * for the resolved `--change`: one entry per sealed record bound. Undefined
 * when no change was resolved, or when a release page bound no unit record,
 * which its index citation then records. A resolved change without an
 * acquired record, or acquired as the other shape, refuses, because the run
 * would otherwise read a change its record never names.
 */
export function runChangeSourcesForRun(
  changeSource: ResolvedCliChangeSourceV1 | undefined,
  acquired: AcquiredChangeSourceV1 | AcquiredReleaseRangeV1 | undefined,
): RunChangeSourcesV1 | undefined {
  if (changeSource !== undefined && acquired === undefined) {
    failChangeSource("change-source-record-unbound");
  }
  if (changeSource === undefined || acquired === undefined) return undefined;
  if (isResolvedReleaseRange(changeSource) !== isAcquiredReleaseRange(acquired)) {
    failChangeSource("change-source-record-unbound");
  }
  return isAcquiredReleaseRange(acquired)
    ? runChangeSourcesFromRelease(acquired)
    : [runChangeSourceFromAcquired(acquired)];
}

/** A release run's units index citation; undefined for every other change. */
export function runChangeSourceReleaseForRun(
  acquired: AcquiredChangeSourceV1 | AcquiredReleaseRangeV1 | undefined,
): RunChangeSourceReleaseV1 | undefined {
  return acquired !== undefined && isAcquiredReleaseRange(acquired)
    ? runChangeSourceReleaseFromAcquired(acquired)
    : undefined;
}

function replayableHandoffSources(
  handoff: import("../../execution/task-context.js").ReaderTaskContextHandoffV1,
): {
  sourceHints: Array<{
    role: import("../../context/reader-context.js").ReaderContextProvenanceSourceV1["role"];
    path: string;
  }>;
  retainsRequest: boolean;
} {
  const sourceHints = [];
  let retainsRequest = false;
  for (const source of handoff.sources) {
    if (source.uri === "request:instruction") {
      if (source.role !== "request" || retainsRequest) {
        throw new Error("Reader task handoff contains invalid virtual request evidence.");
      }
      retainsRequest = true;
      continue;
    }
    sourceHints.push({ role: source.role, path: source.uri });
  }
  return { sourceHints, retainsRequest };
}

function comparisonRequestFromHandoff(
  comparison: import("../../context/reader-context.js").ReaderContextComparisonV1,
): ReaderComparisonRequestV1 | undefined {
  return comparison.kind === "base-head"
    ? {
        kind: "base-head",
        baseRevision: comparison.base_revision,
        headRevision: comparison.head_revision,
      }
    : comparison.kind === "workspace"
      ? { kind: "workspace" }
      : undefined;
}

function uniqueNamedDocumentationPaths(paths: readonly string[]): string[] | undefined {
  const named = [...new Set(paths.filter((path) => path.trim().length > 0))];
  return named.length > 0 ? named : undefined;
}

/**
 * The run's `--source` files with the digest of the bytes at the selected
 * revision, read by the same tracked reader acquisition used, and the `--pr`
 * merge request with the canonical project the forge returned and the digest
 * of the text the host bound. Undefined when the run bound neither.
 */
async function retainedEvidenceBindingsForRun(input: {
  readonly workspace: RepositoryWorkspace;
  readonly sourcePaths: readonly string[];
  readonly changeRequestEvidence: CliChangeRequestSourceEvidence | undefined;
  readonly hostTrackedSourceReader?: import("../../inputs/source-acquisition.js").TrackedSourceReaderV1;
}): Promise<RetainedEvidenceBindingsV1 | undefined> {
  const reader =
    input.hostTrackedSourceReader ?? createWorkspaceTrackedSourceReader(input.workspace);
  const { maxOriginalBytes } = cliSourceExtractionLimits();
  const sources: RetainedSourcePinV1[] = [];
  const paths =
    input.sourcePaths.length > 0
      ? normalizeSourceSelection(input.sourcePaths, CLI_SOURCE_READ_SCOPE)
      : [];
  for (const path of paths) {
    const bytes = await reader.readTrackedBytes(path, maxOriginalBytes);
    sources.push({
      path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  const text = input.changeRequestEvidence?.acquired;
  const entry = text?.acquired[0];
  const changeRequest: RetainedChangeRequestPinV1 | undefined =
    text && entry
      ? {
          selector: {
            schemaVersion: 1,
            kind: "docsfab-change-request-selector",
            provider: "gitlab",
            host: text.scope.host,
            projectPath: text.scope.projectPath,
            number: entry.mergeRequestIid,
          },
          projectId: text.scope.projectId,
          textSha256: entry.observation.original.sha256,
        }
      : undefined;
  return retainedEvidenceBindings({
    sources,
    ...(changeRequest ? { changeRequest } : {}),
  });
}
