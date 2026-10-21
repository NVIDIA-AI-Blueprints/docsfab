// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  captureAuthoringWorkspaceSnapshot,
  assertAuthoringCandidateCaptureAuthority,
  readImmutablePatchArtifact,
} from "../workflow-execution/authoring-workspace-host.js";

import { wrapSourceReadinessHarness } from "../readiness/assessment.js";
import { createRepositoryBootstrapAdapter } from "../onboarding/bootstrap-adapter.js";
import { dirname, resolve } from "node:path";

import { DurableArtifactStore } from "../artifacts/index.js";
import type { RunRuntimeConfig } from "../config/runtime-loader.js";
import { DEFAULT_ANSWER_SUBMISSION_OPTION } from "../config/answer-submission.js";
import type { InstalledAnswerSubmission } from "../model-composition/types.js";
import type { ContextPreflightTarget } from "../context/contracts.js";
import { LocalContextPreflightService } from "../context/index.js";
import {
  AuthoringQualityWorkflowOutcomeProjector,
  isAuthoringQualityOutcomeWorkflow,
} from "../evaluation-report/authoring-outcome-projector.js";
import { selectDocumentationQualityProfile } from "../evaluation-report/quality-profile-selection.js";
import { QualityValidatorHost } from "../evaluation-report/quality-validator-host.js";
import type {
  AgentHarness,
  ExecutionServices,
  GovernedSkillResolver,
  HostOperationExecutor,
  RunRequest,
  RunReviewScope,
} from "../execution/contracts.js";
import { FoundationWorkflowOutcomeProjector } from "../foundation/index.js";
import { FoundationToPatchWorkflowOutcomeProjector } from "../foundation/to-patch.js";
import {
  IaAnalysisHarness,
  LocalIaAnalysisInputProvider,
  LocalIaAnalysisOutputPublisher,
  IaPlanningWorkflowOutcomeProjector,
  type IaAnalysisExecutionAuthorizer,
} from "../ia/index.js";
import type { ImpactPostflightService } from "../impact/contracts.js";
import { AuditWorkflowOutcomeProjector } from "../maturity/audit-outcome-projector.js";
import { verifyQualityPackContext } from "../quality-pack/manifest.js";
import { ReadinessWorkflowOutcomeProjector } from "../readiness/outcome-projector.js";
import type { ProgressEvent } from "../records/contracts.js";
import { createIndexedFileRunStore, publishRunIndexProgress } from "../records/run-index-store.js";
import type { RepositoryEvidenceCollector } from "../repository/contracts.js";
import { GitPatchEvidenceCollector } from "../repository/evidence.js";
import { buildRepositoryDiscoveryInventory } from "../repository/inventory.js";
import type { RepositoryWorkspace } from "../repository/workspace/contracts.js";
import { LocalRepositorySecurityScanner } from "../security/repository-scanner.js";
import { LocalWorkflowSearchCoordinator } from "../search/local-workflow-coordinator.js";
import { isWorkflowManifestV3, type WorkflowDefinition } from "../workflow-contracts/contracts.js";
import { resolveLocalReviewScope } from "../workflow-execution/local-review-scope.js";
import type { WorkflowRunnerOptions } from "../workflow-execution/runner.js";
import type { EvidenceInputFormatPolicyV1 } from "../harness/evidence-input-format.js";
import type { PreservationDeliveryPolicy } from "../workflow-execution/preservation-delivery-policy.js";
import {
  TemplateAuditWorkflowOutcomeProjector,
  withoutInference,
} from "../templates/audit-operation.js";
import { LocalSourceObligationSourceObserver } from "../workflow-execution/source-obligation-observer.js";
import { LocalAuthoringCandidateLifecycle } from "../workflow-execution/authoring-runtime.js";
import { notingRunStore, type RunNotes } from "../records/run-notes.js";
import type { WorkflowApplicationServices } from "./contracts.js";

export interface LocalWorkflowDependencyInput {
  /** Authenticated public PR radius, determined before quality profile selection. */
  readonly prReviewScope?: RunReviewScope;
  readonly config: RunRuntimeConfig;
  readonly request: RunRequest;
  /** CLI/host-admitted page selection, before it becomes the sealed review scope. */
  readonly reviewTargetPaths?: readonly string[];
  readonly workflow: WorkflowDefinition;
  readonly workspace: RepositoryWorkspace;
  /** Exact starting revision for original-source reads while the candidate is edited. */
  readonly preservationSourceWorkspace?: RepositoryWorkspace;
  /** Resolved at the CLI boundary; application assembly has no process environment. */
  readonly preservationDeliveryPolicy?: PreservationDeliveryPolicy;
  /** Resolved at the CLI boundary; direct callers retain the canonical format. */
  readonly evidenceInputFormatPolicy?: EvidenceInputFormatPolicyV1;
  readonly repositoryEvidence: RepositoryEvidenceCollector;
  readonly baseHarness: AgentHarness;
  /** The answer submission the bound route recorded; absent when none is. */
  readonly answerSubmissionCapability?: InstalledAnswerSubmission;
  /** Sealed composition fit for answer-record answer-now; absent means fail-safe unarmed. */
  readonly qualityAnswerNowRecordsPlan?: WorkflowRunnerOptions["qualityAnswerNowRecordsPlan"];
  /** Deferred exact-checkpoint claim, invoked only after the host restores it. */
  readonly claimAnswerRecordContinuation?: (
    child?: import("../records/contracts.js").RunRecord,
  ) => Promise<void>;
  /** Input window of the bound model, which sizes each context packet's budget. */
  readonly modelInputTokens?: number;
  readonly hostOperations?: HostOperationExecutor;
  readonly skillResolver?: GovernedSkillResolver;
  readonly impactPostflight?: ImpactPostflightService;
  readonly rstCapabilityAdmission?: WorkflowRunnerOptions["rstCapabilityAdmission"];
  readonly iaAnalysis?: {
    readonly repositoryIdentity: string;
    readonly packageDigest?: string;
    readonly executionAuthorizer?: IaAnalysisExecutionAuthorizer;
  };
  readonly onProgress?: (event: ProgressEvent) => void;
  /** Warnings the run collects outside its steps; each save records them. */
  readonly runNotes?: RunNotes;
}

export interface LocalWorkflowDependencyAssembly {
  readonly services: WorkflowApplicationServices;
  readonly contextTarget?: ContextPreflightTarget;
  readonly reviewScope?: RunReviewScope;
}

/** Assemble presentation-free local services over the existing runner ports. */
export async function createLocalWorkflowApplicationServices(
  input: LocalWorkflowDependencyInput,
): Promise<LocalWorkflowDependencyAssembly> {
  const { config, request, workspace } = input;
  const verifiedQualityPack = await verifyQualityPackContext({
    skillCrateDirectory: config.skillCrateDirectory,
    qualityDirectory: config.qualityDirectory,
    qualityPackDirectory: config.qualityPackDirectory,
  });
  const artifactStore = new DurableArtifactStore(
    resolve(dirname(config.stateDirectory), "artifacts"),
  );
  const inventory =
    request.workflow === "review-documentation" || request.workflow === "audit-documentation"
      ? await buildRepositoryDiscoveryInventory({ workspace })
      : undefined;
  const reviewScope =
    input.prReviewScope ??
    (inventory
      ? resolveLocalReviewScope({
          instruction: request.instruction,
          sourcePath: request.contextTarget?.sourcePath,
          boundPaths: input.reviewTargetPaths,
          inventory,
        })
      : undefined);
  const contextTarget =
    request.contextTarget ??
    (reviewScope?.targetPaths.length === 1
      ? { sourcePath: reviewScope.targetPaths[0]! }
      : undefined);
  const qualitySelection =
    inventory && request.workflow === "review-documentation"
      ? await selectDocumentationQualityProfile({
          workflow: input.workflow,
          workspace,
          inventory,
          ...(reviewScope ? { targetPaths: reviewScope.targetPaths } : {}),
          pack: verifiedQualityPack,
        })
      : undefined;
  const qualityValidation = qualitySelection
    ? {
        selection: qualitySelection,
        host: new QualityValidatorHost({
          store: artifactStore,
          selection: qualitySelection,
          temporaryRoot: resolve(dirname(config.stateDirectory), "quality-validation"),
          stateDirectory: config.stateDirectory,
          ...(request.answerRecordDiscovery
            ? {
                answerRecordsExperimentalDiscovery: true,
                timeoutMs: request.answerRecordDiscovery.bounds.qualityValidatorTimeoutMs,
              }
            : {}),
        }),
      }
    : undefined;
  const harness = input.iaAnalysis
    ? new IaAnalysisHarness(input.baseHarness, {
        artifactStore,
        inputProvider: new LocalIaAnalysisInputProvider({
          packageRoot: resolve(
            dirname(config.stateDirectory),
            "ia-analysis-inputs",
            input.iaAnalysis.repositoryIdentity,
          ),
          repositoryRevision: workspace.revision,
          repositoryIdentity: input.iaAnalysis.repositoryIdentity,
          packageDigest: input.iaAnalysis.packageDigest,
        }),
        outputPublisher: new LocalIaAnalysisOutputPublisher(
          resolve(
            dirname(config.stateDirectory),
            "ia-analysis-outputs",
            input.iaAnalysis.repositoryIdentity,
          ),
          input.iaAnalysis.repositoryIdentity,
        ),
        ...(input.iaAnalysis.executionAuthorizer
          ? { executionAuthorizer: input.iaAnalysis.executionAuthorizer }
          : {}),
      })
    : request.workflow === "audit-documentation"
      ? withoutInference(input.baseHarness)
      : input.baseHarness;
  const bootstrapAdapter =
    request.workflow === "bootstrap"
      ? createRepositoryBootstrapAdapter({ harness, workspace })
      : undefined;
  const execution: ExecutionServices = {
    harness:
      request.workflow === "readiness"
        ? wrapSourceReadinessHarness(harness, workspace)
        : (bootstrapAdapter?.harness ?? harness),
    store: input.runNotes
      ? notingRunStore(createIndexedFileRunStore(config.stateDirectory), input.runNotes)
      : createIndexedFileRunStore(config.stateDirectory),
    ...(input.skillResolver ? { skillResolver: input.skillResolver } : {}),
    ...(input.hostOperations ? { hostOperations: input.hostOperations } : {}),
  };
  const workflowSearch = new LocalWorkflowSearchCoordinator({ workspace });
  const sourceObligationObserver = new LocalSourceObligationSourceObserver(
    input.preservationSourceWorkspace ?? workspace,
  );
  const authoringCandidateLifecycle = isWorkflowManifestV3(input.workflow)
    ? (() => {
        if (!(input.repositoryEvidence instanceof GitPatchEvidenceCollector)) {
          throw new Error(
            "CREATE V3 requires the local authenticated Git patch evidence collector.",
          );
        }
        if (!input.hostOperations) {
          throw new Error("CREATE V3 requires the local documentation check host.");
        }
        return new LocalAuthoringCandidateLifecycle({
          workspace,
          evidenceCollector: input.repositoryEvidence,
          search: workflowSearch,
          sourceObserver: sourceObligationObserver,
          hostOperations: input.hostOperations,
          artifactDirectory: resolve(dirname(config.stateDirectory), "patches"),
        });
      })()
    : undefined;
  const runner: Omit<WorkflowRunnerOptions, keyof ExecutionServices> = {
    evidenceInputFormatPolicy: input.evidenceInputFormatPolicy ?? "canonical-json-string-v1",
    ...(input.preservationDeliveryPolicy ?? {
      preservationBaseDelivery: "eager",
      preservationObservationReuse: false,
    }),
    qualityPackEvidence: verifiedQualityPack.evidence,
    publishAnswerRecordProgress: (record) => publishRunIndexProgress(config.stateDirectory, record),
    ...(qualityValidation ? { qualityValidation } : {}),
    ...(request.workflow === "create-documentation" || request.workflow === "update-documentation"
      ? {
          prepareAuthoringQualityValidation: async (
            candidateInput: Parameters<
              NonNullable<WorkflowRunnerOptions["prepareAuthoringQualityValidation"]>
            >[0],
          ) => {
            const currentWorkspace = candidateInput.repositoryWorkspace ?? workspace;
            if (currentWorkspace.path !== candidateInput.workspacePath)
              throw new Error(
                "Quality candidate workspace does not match its authenticated export.",
              );
            const capture = candidateInput.capture;
            if (candidateInput.workflow.name === "create-documentation") {
              if (!capture)
                throw new Error(
                  "CREATE quality evaluation requires its host-admitted immutable authoring capture.",
                );
              assertAuthoringCandidateCaptureAuthority(capture);
            }
            const evidence =
              capture?.evidence ??
              (await candidateInput.repositoryEvidence.capture({
                runId: candidateInput.record.id,
                repository: candidateInput.record.repository,
                workspacePath: candidateInput.workspacePath,
                persistPatch: true,
              }));
            if (!evidence.patch)
              throw new Error(
                "Authored quality evaluation requires an actual retained candidate patch.",
              );
            await readImmutablePatchArtifact(
              evidence.patch.artifactPath,
              evidence.patch.byteLength,
              evidence.patch.sha256,
            );
            const snapshot = await captureAuthoringWorkspaceSnapshot(
              currentWorkspace,
              candidateInput.targetPaths,
            );
            if (
              capture &&
              (snapshot.digest !== capture.candidate.workspaceSnapshotDigest ||
                evidence.patch.sha256 !== capture.candidate.patchDigestSha256)
            )
              throw new Error(
                "Quality evaluation candidate bytes changed after immutable capture.",
              );
            const inventory = await buildRepositoryDiscoveryInventory({
              workspace: currentWorkspace,
              authorizedWritePaths: candidateInput.targetPaths,
            });
            const selection = await selectDocumentationQualityProfile({
              workflow: candidateInput.workflow,
              workspace: currentWorkspace,
              inventory,
              pack: verifiedQualityPack,
              targetPaths: candidateInput.targetPaths,
            });
            const evaluatedCandidate: import("../records/contracts.js").QualityEvaluatedCandidateV1 =
              {
                workflow: candidateInput.workflow.name as
                  | "create-documentation"
                  | "update-documentation",
                targetPaths: [...candidateInput.targetPaths],
                patchSha256: evidence.patch.sha256,
                workspaceSnapshotSha256: snapshot.digest,
                candidateOrdinal: capture?.candidate.ordinal ?? null,
                candidateDigest: capture?.candidate.digest ?? null,
              };
            return {
              selection,
              host: new QualityValidatorHost({
                store: artifactStore,
                selection,
                evaluatedCandidate,
                temporaryRoot: resolve(dirname(config.stateDirectory), "quality-validation"),
                stateDirectory: config.stateDirectory,
              }),
            };
          },
        }
      : {}),
    answerSubmission: {
      option: config.answerSubmission ?? DEFAULT_ANSWER_SUBMISSION_OPTION,
      ...(input.answerSubmissionCapability ? { capability: input.answerSubmissionCapability } : {}),
    },
    ...(input.qualityAnswerNowRecordsPlan
      ? { qualityAnswerNowRecordsPlan: input.qualityAnswerNowRecordsPlan }
      : {}),
    ...(request.answerRecordContinuation
      ? { answerRecordContinuation: request.answerRecordContinuation }
      : {}),
    ...(input.claimAnswerRecordContinuation
      ? { claimAnswerRecordContinuation: input.claimAnswerRecordContinuation }
      : {}),
    repositoryScanner: new LocalRepositorySecurityScanner(),
    contextPreflight: new LocalContextPreflightService({
      cacheRoot: resolve(dirname(config.stateDirectory), "context-cache"),
      workspace,
      ...(input.modelInputTokens !== undefined ? { modelInputTokens: input.modelInputTokens } : {}),
    }),
    workflowSearch,
    sourceObligationObserver,
    ...(authoringCandidateLifecycle ? { authoringCandidateLifecycle } : {}),
    ...(input.impactPostflight ? { impactPostflight: input.impactPostflight } : {}),
    ...(input.rstCapabilityAdmission
      ? { rstCapabilityAdmission: input.rstCapabilityAdmission }
      : {}),
    repositoryEvidence: input.repositoryEvidence,
    ...(bootstrapAdapter
      ? { emptyWriteResultAdmission: bootstrapAdapter.emptyWriteResultAdmission }
      : {}),
    ...(bootstrapAdapter
      ? { outcomeProjector: bootstrapAdapter.outcomeProjector }
      : request.workflow === "ia-plan"
        ? { outcomeProjector: new IaPlanningWorkflowOutcomeProjector() }
        : request.workflow === "foundation"
          ? { outcomeProjector: new FoundationWorkflowOutcomeProjector() }
          : request.workflow === "foundation-to-patch"
            ? { outcomeProjector: new FoundationToPatchWorkflowOutcomeProjector() }
            : request.workflow === "readiness"
              ? { outcomeProjector: new ReadinessWorkflowOutcomeProjector(workspace) }
              : request.workflow === "review-documentation"
                ? { outcomeProjector: new AuditWorkflowOutcomeProjector() }
                : request.workflow === "audit-documentation"
                  ? { outcomeProjector: new TemplateAuditWorkflowOutcomeProjector() }
                  : isAuthoringQualityOutcomeWorkflow(request.workflow)
                    ? { outcomeProjector: new AuthoringQualityWorkflowOutcomeProjector() }
                    : {}),
    retryPolicy: config.retryPolicy,
    ...(input.onProgress ? { onProgress: input.onProgress } : {}),
  };
  return {
    services: composeWorkflowApplicationServices(execution, runner),
    ...(contextTarget ? { contextTarget } : {}),
    ...(reviewScope ? { reviewScope } : {}),
  };
}

/**
 * Compose the established execution services with the remaining runner ports.
 * This is intentionally presentation-free and does not acquire host authority.
 */
export function composeWorkflowApplicationServices(
  execution: ExecutionServices,
  runner: Omit<WorkflowRunnerOptions, keyof ExecutionServices>,
): WorkflowApplicationServices {
  return { ...runner, ...execution };
}
