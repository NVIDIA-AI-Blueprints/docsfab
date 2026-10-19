// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRepositoryBootstrapAdapter } from "../onboarding/bootstrap-adapter.js";
import { prepareHostedAuthoring } from "./authoring.js";
import {
  unassessedSourceReadinessFixture,
  wrapSourceReadinessHarness,
} from "../readiness/assessment.js";
import type { AgentHarness, HarnessStepInput } from "../execution/contracts.js";
import { PiHarness } from "../harness/pi.js";
import { prepareHostedReadiness } from "./readiness.js";
import { assertHostedWorkflowCatalog } from "./workflow-catalog.js";
import { resolveToolOutputCapBytes } from "../harness/tool-output-cap.js";
import { createProviderConnectionFactory, servedModelWarning } from "../model/provider.js";
import {
  addRunNotes,
  createRunNotes,
  notingRunStore,
  type RunNotes,
} from "../records/run-notes.js";
import { FileRunStore } from "../records/file-store.js";
import { LocalRepositorySecurityScanner } from "../security/repository-scanner.js";
import { WorkflowRunner } from "../workflow-execution/runner.js";
import { prepareRepositoryWorkspace } from "../repository/workspace/materialize.js";
import {
  prepareNativeAuthoringRequest,
  retainNativeAuthoringArtifacts,
} from "./native-authoring.js";
import { assembleHostedNativeOperations } from "./native-operations.js";
import {
  authoritativeReviewTargetPaths,
  TECHNICAL_FACT_DIMENSIONS,
  validateVerificationResult,
  type VerificationResult,
} from "../workflow-execution/verification-result.js";
import { LocalWorkflowSearchCoordinator } from "../search/local-workflow-coordinator.js";
import type { WorkflowRunnerOptions } from "../workflow-execution/runner.js";
import { getWorkflow } from "../workflow-registry/catalog.js";
import type { ContextPreflightService } from "../context/contracts.js";
import type { ProgressEvent, RunRecord } from "../records/contracts.js";
import { resolve } from "node:path";
import { LocalSourceObligationSourceObserver } from "../workflow-execution/source-obligation-observer.js";
import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../json-evidence.js";
import {
  bindTechnicalCorrectionResponse,
  bindHostOwnedTechnicalCorrectionProposalV3,
  canonicalSourceObligationProposal,
  requiresSourceObligationLedger,
  requiresTechnicalCorrection,
  TECHNICAL_CORRECTION_PROPOSAL_KIND,
  type SourceObligationLedgerProposalV1,
} from "../workflow-execution/source-obligation.js";
import { createHostedContextPreflightService } from "./context-preflight.js";
import { contextPacketInputWindow } from "../context/budget.js";
import {
  assertHostRuntimeReaderEvidenceNominations,
  assertHostRuntimeWriteAuthorityBinding,
  digest,
  type HostRuntimePatchEvidenceV1,
  type HostRuntimeProgressV1,
  type HostRuntimeRequestV1,
} from "./contracts.js";
import { completeLiveAgentTurn, prepareLiveAgentTurn } from "./live-agent-turn.js";
import {
  liveAgentContextTargetPath,
  scopeLiveAgentTurnHarness,
  selectLiveAgentTurnPages,
} from "./live-agent-pages.js";
import {
  semanticComparisonReplyHarness,
  semanticComparisonInstruction,
  semanticComparisonRetryPolicy,
  validateSemanticComparisonRun,
} from "./reconcile-product-behavior.js";
import { recomputeHostedPatchEvidence } from "./patch-evidence.js";
import { MAX_GIT_OUTPUT_BYTES, runTrustedGit } from "./trusted-git.js";
import { assembleCandidateReviewEvidenceV1 } from "./candidate-review-evidence.js";
import { projectRunEditorialOutcome, type RunEditorialOutcomeV1 } from "../operator/run-result.js";
import { parseRetryPolicy } from "../config/retry-policy.js";
import { resolveDocsFabRuntimeAssetPaths } from "../config/runtime-loader.js";
import { verifyQualityPackContext } from "../quality-pack/manifest.js";
import { createStyleTaskContext, type StyleTaskContextV1 } from "../execution/task-context.js";
import {
  assembleEditorialWorkflowEvidenceV1,
  replayEditorialWorkflowEvidenceV1,
  type EditorialWorkflowEvidenceAssemblyV1,
} from "../workflow-execution/editorial-evidence-assembly.js";
import type { HostEditorialOutcomeAuthorityV1 } from "./contracts.js";
import { GitPatchEvidenceCollector } from "../repository/evidence.js";
import { hostedOperatorNamedPaths } from "../repository/operator-named-paths.js";
import { resolveEvidenceInputFormatPolicy } from "../harness/evidence-input-format.js";
import { documentationPlanModeForWorkflow } from "../workflow-execution/plan-binding.js";
import { resolvePreservationDeliveryPolicy } from "../workflow-execution/preservation-delivery-policy.js";
export {
  EXPERIMENTAL_STAGE_SPECIFIC_PRESERVATION_BASE_ENV,
  EXPERIMENTAL_PRESERVATION_OBSERVATION_REUSE_ENV,
  experimentalPreservationObservationReuseEnabled,
  experimentalStageSpecificPreservationBaseEnabled,
  preservationBaseDeliveryForHostWorkflow,
} from "../workflow-execution/preservation-delivery-policy.js";
import {
  AuthoringQualityWorkflowOutcomeProjector,
  isAuthoringQualityOutcomeWorkflow,
} from "../evaluation-report/authoring-outcome-projector.js";

export async function runHostedWorkflow(input: {
  request: HostRuntimeRequestV1;
  credential: string | null;
  emit(event: HostRuntimeProgressV1): void;
  signal?: AbortSignal;
  /** Installed host caller instruction for a fixed nested workflow; not a wire grant. */
  instruction?: string;
  /** Strict host-backed projection; omission keeps legacy or unavailable evidence absent. */
  projectEditorialOutcome?: (record: RunRecord) => RunEditorialOutcomeV1;
  /** In-process acceptance seam for the model edge; production subprocesses never supply it. */
  executionHarness?: AgentHarness;
  /**
   * Host-projected retry environment. Tests inject the sealed `DOCSFAB_*`
   * retry projection; production omits this and uses `process.env`.
   */
  environment?: NodeJS.ProcessEnv;
}): Promise<{
  record: RunRecord;
  patch: string | null;
  patchEvidence: HostRuntimePatchEvidenceV1 | null;
  editorialOutcome: RunEditorialOutcomeV1;
  editorialAuthority?: HostEditorialOutcomeAuthorityV1;
}> {
  const { request } = input;
  const { preservationBaseDelivery, preservationObservationReuse } =
    resolvePreservationDeliveryPolicy({
      workflow: request.workflow,
      environment: input.environment ?? process.env,
    });
  const workflow = getWorkflow(request.workflow);
  if (!workflow)
    throw new Error("The hosted runtime workflow is not installed in the exact release.");
  const installedWriteStepIds = workflow.steps
    .filter((step) => step.mode === "write")
    .map((step) => step.id);
  const authority = request.writeAuthority;
  if (installedWriteStepIds.length > 0 && authority === null) {
    throw new Error("Hosted write workflows require a separate operation-specific write grant.");
  }
  if (authority !== null) {
    // Re-verified here because this is the first point the installed workflow's
    // write steps are known; a mismatch refuses before any tool is confined.
    assertHostRuntimeWriteAuthorityBinding({
      authority,
      request,
      installedWriteStepIds,
    });
  }
  // Only an opted-in run declares the preservation reader; an installed policy
  // sealed without it keeps validating while the experiment is off.
  assertHostedWorkflowCatalog(request, {
    preservationSourceRead: preservationBaseDelivery === "stage-specific",
  });
  assertExecutableHostedComposition(request);
  const readerTask = request.packet.readerTask;
  if (request.workflow === "update-documentation" && !readerTask)
    throw new Error(
      "Hosted schema-v2 update requires bound reader-task evidence before workflow execution.",
    );
  const verifiedQualityPack =
    request.workflow === "update-documentation"
      ? await verifyQualityPackContext(resolveDocsFabRuntimeAssetPaths())
      : undefined;
  // An installed provider harness reads the bound style profile resolved here,
  // once and before any model call; an oversized or stale one refuses the run.
  const styleContext =
    !input.executionHarness && request.composition.route !== "offline-fixture"
      ? await createStyleTaskContext(
          verifiedQualityPack ??
            (await verifyQualityPackContext(resolveDocsFabRuntimeAssetPaths())),
        )
      : undefined;
  const editorialAssembly =
    request.workflow === "update-documentation"
      ? await assembleEditorialWorkflowEvidenceV1({
          verifiedQualityPack: verifiedQualityPack!,
          repositoryPath: request.workspacePath,
          revision: request.revision,
          artifactRoot: resolve(request.stateDirectory, "artifacts"),
          readerContextInput: readerTask!.readerContextInput,
          inputOrigin: readerTask!.inputOrigin,
          requestText: readerTask!.requestText ?? readerTask!.readerContextInput.reader_job,
          comparisonRequest: readerTask!.comparison,
          sourceHints: readerTask!.sources,
          admitNominations: (nominations) =>
            assertHostRuntimeReaderEvidenceNominations(request.readerEvidencePolicy!, nominations),
          requireCompleteChangedSources: true,
        })
      : undefined;
  const candidateReviewSourceEvidence = request.packet.candidateReview
    ? await assembleCandidateReviewEvidenceV1({
        workspacePath: request.workspacePath,
        candidate: request.packet.candidateReview,
        signal: input.signal,
      })
    : undefined;
  await assertWorkspaceRevision(
    request.workspacePath,
    request.revision,
    request.sourceTreeObjectId,
    input.signal,
  );
  // A conversational turn renders its own instruction so the question reaches
  // the model as a question, not a `[frozen-review-event]` JSON blob. `null`
  // for every other workflow. Read when the step runs: a question with no
  // `target=` chooses its pages, and so its instruction, from the workspace.
  let liveAgentTurn = prepareLiveAgentTurn(request);
  const resolveInstruction = (): string =>
    input.instruction ??
    semanticComparisonInstruction(request) ??
    liveAgentTurn?.instruction ??
    [
      ...request.capsule.selectedEvidence.map((item) => `[${item.evidenceId}]\n${item.content}`),
      ...[request.packet.inputManifest, request.packet.canon, request.packet.reviewEvent]
        .filter((item): item is NonNullable<typeof item> => item !== null)
        .map((item) => `[frozen-${item.kind}]\n${item.content}`),
    ].join("\n\n");
  const sourceWorkspace = await prepareRepositoryWorkspace(request.workspacePath, request.revision);
  let repositoryEvidence: GitPatchEvidenceCollector | undefined;
  let authoring: Awaited<ReturnType<typeof prepareHostedAuthoring>>;
  let record: RunRecord;
  // A provider that answers under another model name is recorded, never refused.
  const runNotes = createRunNotes();
  try {
    liveAgentTurn =
      liveAgentTurn &&
      (await selectLiveAgentTurnPages(liveAgentTurn, {
        request,
        workspace: sourceWorkspace,
        signal: input.signal,
      }));
    const instruction = resolveInstruction();
    const readiness = await prepareHostedReadiness(request.workflow, sourceWorkspace);
    const nativeAssembly = await assembleHostedNativeOperations({
      request,
      workspace: sourceWorkspace,
      workflow,
      ...(input.signal ? { signal: input.signal } : {}),
      // A child pipeline runs here, in process, under a grant narrowed to its
      // intended paths: a private invocation of the installed writer with no
      // new credential or emit stream. Its retained artifacts are copied back
      // before its attempt directory is removed.
      async runAuthoring(invocation) {
        const child = await prepareNativeAuthoringRequest(invocation);
        const result = await runHostedWorkflow({
          ...child,
          credential: input.credential,
          ...(input.signal ? { signal: input.signal } : {}),
          ...(input.executionHarness ? { executionHarness: input.executionHarness } : {}),
          ...(input.environment ? { environment: input.environment } : {}),
          emit: () => undefined,
        });
        await retainNativeAuthoringArtifacts(child.request.stateDirectory, request.stateDirectory);
        return result;
      },
    });
    const installedHarness =
      nativeAssembly.harness ??
      input.executionHarness ??
      createHarness(request, input.credential, styleContext, runNotes, input.signal);
    // Only this host-constructed fixture can bypass the model re-ask policy.
    // Neither request route nor harness-returned metadata is an authority.
    const readinessMode =
      installedHarness instanceof OfflineWorkflowHarness ? "internal-offline-fixture" : "model";
    const baseHarness = candidateReviewSourceEvidence
      ? {
          ...(installedHarness.inspectSkill
            ? {
                inspectSkill(stepInput: HarnessStepInput) {
                  return installedHarness.inspectSkill!.call(installedHarness, {
                    ...stepInput,
                    candidateReviewSourceEvidence,
                  });
                },
              }
            : {}),
          runStep(stepInput: HarnessStepInput) {
            return installedHarness.runStep.call(installedHarness, {
              ...stepInput,
              candidateReviewSourceEvidence,
            });
          },
        }
      : installedHarness;
    const harness = scopeLiveAgentTurnHarness(
      nativeAssembly.wrapHarness ? nativeAssembly.wrapHarness(baseHarness) : baseHarness,
      liveAgentTurn,
    );
    const modelInputTokens = contextPacketInputWindow(request.composition.executionProfile);
    const contextPreflight: ContextPreflightService = createHostedContextPreflightService({
      capsule: request.capsule,
      stateDirectory: request.stateDirectory,
      ...(modelInputTokens !== undefined ? { modelInputTokens } : {}),
    });
    authoring = await prepareHostedAuthoring({ request, workflow, workspace: sourceWorkspace });
    const bootstrapAdapter =
      request.workflow === "bootstrap"
        ? createRepositoryBootstrapAdapter({
            harness,
            workspace: sourceWorkspace,
            repositoryPath: request.workspacePath,
            pathCeiling: authority!.pathCeiling,
          })
        : undefined;
    // Most specific first: CREATE's candidate collector, then the native
    // assembly's (against the outer checkout), then the shared collector for
    // UPDATE (editorial), bootstrap, and RESTRUCTURE, whose writer edits the
    // outer checkout directly. A native assembly never coexists with `authoring`.
    repositoryEvidence =
      authoring?.repositoryEvidence ??
      nativeAssembly.repositoryEvidence ??
      (editorialAssembly || bootstrapAdapter || request.workflow === "restructure-documentation"
        ? await GitPatchEvidenceCollector.create(
            request.workspacePath,
            resolve(request.stateDirectory, "patches"),
          )
        : undefined);
    let progressSequence = 0;
    const localWorkflowSearch =
      authoring?.workflowSearch ??
      readiness?.workflowSearch ??
      new LocalWorkflowSearchCoordinator(
        editorialAssembly
          ? {
              workspaceSnapshotSha256:
                editorialAssembly.observation.admission.workspaceSnapshotSha256,
            }
          : {},
      );
    const changedWorkflowSearch = new LocalWorkflowSearchCoordinator();
    const runnerOptions: WorkflowRunnerOptions = {
      evidenceInputFormatPolicy: resolveEvidenceInputFormatPolicy(input.environment ?? process.env),
      harness: semanticComparisonReplyHarness(
        request.workflow === "readiness"
          ? wrapSourceReadinessHarness(harness, sourceWorkspace, readinessMode)
          : (bootstrapAdapter?.harness ?? authoring?.wrapHarness(harness) ?? harness),
        request,
      ),
      ...(bootstrapAdapter
        ? { emptyWriteResultAdmission: bootstrapAdapter.emptyWriteResultAdmission }
        : {}),
      // A companion modifies an existing file, which a hosted grant allows only
      // through an exact modify target; the path ceiling admits new files only.
      // Any other index is labeled at plan admission instead of failing the
      // terminal patch-scope check after the write.
      ...(authority !== null
        ? {
            documentationCompanionGrant: authority.targets
              .filter((target) => target.operations.includes("modify"))
              .map((target) => target.path),
          }
        : {}),
      // A planned documentation write names an agent instruction file or a
      // hidden path only through the operator's own request, as the host's
      // grant reads it.
      ...(authority !== null && documentationPlanModeForWorkflow(request.workflow)
        ? {
            hostedPlanNaming: {
              roots: authority.pathCeiling,
              named: hostedOperatorNamedPaths(request.packet.readerTask),
            },
          }
        : {}),
      ...(authoring
        ? {
            authoringCandidateLifecycle: authoring.authoringCandidateLifecycle,
            impactPostflight: authoring.impactPostflight,
            toolCeiling: request.composition.declaredTools,
          }
        : {}),
      // A native write arm's own impact analysis; a native assembly never
      // coexists with `authoring`, so this widens nothing set above.
      ...(nativeAssembly.impactPostflight
        ? { impactPostflight: nativeAssembly.impactPostflight }
        : {}),
      ...(verifiedQualityPack ? { qualityPackEvidence: verifiedQualityPack.evidence } : {}),
      ...(authoring
        ? { hostOperations: authoring.hostOperations }
        : nativeAssembly.hostOperations
          ? { hostOperations: nativeAssembly.hostOperations }
          : {}),
      store: notingRunStore(new FileRunStore(request.stateDirectory), runNotes),
      repositoryScanner: new LocalRepositorySecurityScanner(),
      ...(repositoryEvidence ? { repositoryEvidence } : {}),
      ...(nativeAssembly.outcomeProjector
        ? { outcomeProjector: nativeAssembly.outcomeProjector }
        : bootstrapAdapter
          ? { outcomeProjector: bootstrapAdapter.outcomeProjector }
          : readiness?.outcomeProjector
            ? { outcomeProjector: readiness.outcomeProjector }
            : isAuthoringQualityOutcomeWorkflow(request.workflow)
              ? { outcomeProjector: new AuthoringQualityWorkflowOutcomeProjector() }
              : {}),
      contextPreflight,
      ...(editorialAssembly
        ? { workflowBranchEvidence: editorialAssembly.workflowBranchEvidence }
        : {}),
      // Reader admission already measured the exact tracked checkout. Bind each
      // search result to that authenticated snapshot while retaining the local
      // coordinator's bounded filesystem probes.
      workflowSearch: editorialAssembly
        ? {
            search: async (searchInput) => {
              const status = await runTrustedGit(
                request.workspacePath,
                ["status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching"],
                input.signal,
              );
              return (status.length === 0 ? localWorkflowSearch : changedWorkflowSearch).search(
                searchInput,
              );
            },
          }
        : localWorkflowSearch,
      // Search inspects the active candidate workspace so hosted writes
      // remain visible. Original-source admission uses a separate immutable
      // capability for the exact starting revision; write authority independently
      // confines the mutable checkout and forbids source/write intersection.
      sourceObligationObserver:
        authoring?.sourceObligationObserver ??
        new LocalSourceObligationSourceObserver(sourceWorkspace),
      preservationBaseDelivery,
      preservationObservationReuse,
      // The sealed host projection uses the catalogued retry policy. Semantic
      // comparisons apply their own cut-answer budget before host narrowing.
      retryPolicy:
        request.workflow === "reconcile-product-behavior"
          ? semanticComparisonRetryPolicy(
              parseRetryPolicy(input.environment ?? process.env),
              input.environment ?? process.env,
            )
          : parseRetryPolicy(input.environment ?? process.env),
      id: () => request.runId,
      onProgress: (event: ProgressEvent) => {
        if (event.type !== "run-status" && event.type !== "step-status") return;
        input.emit(
          Object.freeze({
            schemaVersion: 1,
            kind: "docsfab-host-runtime-event",
            sequence: ++progressSequence,
            type: event.type,
            runId: event.runId,
            ...(event.type === "step-status" ? { stepId: event.stepId } : {}),
            status: event.status,
          }),
        );
      },
    };
    // `WorkflowRunner` skips its search block when no coordinator is configured,
    // so a `reuse` or `revalidate` step would silently not inherit. Refuse.
    const dependentSearchStep = workflow.steps.find(
      (step) => step.searchMode === "reuse" || step.searchMode === "revalidate",
    );
    if (dependentSearchStep && !runnerOptions.workflowSearch) {
      throw new Error(
        `The hosted runtime cannot ${dependentSearchStep.searchMode} search evidence for step "${dependentSearchStep.id}" without a workflow search coordinator.`,
      );
    }
    const runner = new WorkflowRunner(runnerOptions);
    // Host-resolved and re-verified on arrival. Terminal admission requires the
    // record to carry exactly this scope, count included, so it is carried
    // through rather than recounted: a workspace recount could disagree and
    // fail as `terminal-review-scope-substitution`.
    const reviewScope = request.packet.reviewScope;
    record = await runner.run({
      runId: request.runId,
      signal: input.signal,
      workflow: request.workflow,
      ...(nativeAssembly.task ? { task: nativeAssembly.task } : {}),
      workspacePath:
        authoring?.workspacePath ??
        readiness?.workspacePath ??
        nativeAssembly.workspacePath ??
        (request.packet.nativeTask ? sourceWorkspace.path : request.workspacePath),
      ...(readiness?.releaseDefaultBranch
        ? { releaseDefaultBranch: readiness.releaseDefaultBranch }
        : {}),
      repository: authoring?.repository ??
        readiness?.repository ?? {
          sourcePath: request.packet.nativeTask
            ? sourceWorkspace.sourcePath
            : request.workspacePath,
          requestedRevision: request.revision,
          revision: request.revision,
        },
      ...(instruction ? { instruction } : {}),
      ...(editorialAssembly
        ? {
            readerContextInput: editorialAssembly.readerTaskContext.readerContextInput,
            readerTaskContext: editorialAssembly.readerTaskContext,
            editorialEvidenceRefs: editorialAssembly.editorialEvidenceRefs,
          }
        : {}),
      ...(reviewScope
        ? {
            reviewScope: {
              scope: reviewScope.scope,
              reason: reviewScope.reason,
              targetPaths: reviewScope.targets.map((target) => target.path),
              deferredPaths: reviewScope.deferred.map((entry) => entry.path),
              anchorPaths: reviewScope.anchorPaths,
              scopeSha256: reviewScope.scopeSha256,
              corpusFileCount: reviewScope.corpusFileCount,
              ...(request.packet.canon
                ? {
                    continuationIdentity: {
                      canonSha256: request.packet.canon.sha256,
                      reviewRevision: request.revision,
                    },
                  }
                : {}),
              ...(reviewScope.accounting ? { accounting: reviewScope.accounting } : {}),
            },
            // One named page narrows the context packet through the
            // `--context-path` seam. The preflight resolves it against the frozen
            // index, so a missing target refuses rather than widening the scope.
            // A question without `target=` points it at its first approved page.
            ...(reviewScope.targets.length === 1 && reviewScope.targets[0]
              ? {
                  contextTarget: {
                    sourcePath:
                      liveAgentContextTargetPath(liveAgentTurn) ?? reviewScope.targets[0].path,
                  },
                }
              : {}),
          }
        : {}),
      allowWrite: request.allowWrite,
    });
    await authoring?.finalize(record, input.signal);
    // Inside the same `try`, so a refusal still disposes the workspace and the
    // evidence collector.
    await nativeAssembly.finalize?.(record);
  } finally {
    try {
      try {
        await authoring?.dispose();
      } finally {
        await sourceWorkspace.dispose();
      }
    } finally {
      await repositoryEvidence?.dispose();
    }
  }
  // The saved record carries the run's warnings; the returned one does too.
  addRunNotes(record, runNotes);
  const completed = liveAgentTurn
    ? completeLiveAgentTurn(liveAgentTurn, record, request, input.signal)
    : validateSemanticComparisonRun(record, request);
  const editorialReplay = editorialAssembly
    ? await replayEditorialWorkflowEvidenceV1({
        repositoryPath: request.workspacePath,
        revision: request.revision,
        stateDirectory: request.stateDirectory,
        readerTask: readerTask!,
        readerEvidencePolicy: request.readerEvidencePolicy!,
        record: completed,
      })
    : undefined;
  const editorialOutcome =
    editorialReplay?.outcome ??
    (input.projectEditorialOutcome
      ? input.projectEditorialOutcome(completed)
      : projectRunEditorialOutcome(completed));
  if (authority !== null) {
    // A granted run changes the disposable tree, so instead of the
    // clean-manifest assertion every change is recomputed and bound to the grant.
    const { patch, evidence } = await recomputeHostedPatchEvidence({
      workspacePath: request.workspacePath,
      authority,
      signal: input.signal,
    });
    return {
      record: completed,
      patch,
      patchEvidence: evidence,
      editorialOutcome,
      ...(editorialReplay ? { editorialAuthority: editorialReplay.authority } : {}),
    };
  }

  await assertWorkspaceRevision(
    request.workspacePath,
    request.revision,
    request.sourceTreeObjectId,
    input.signal,
  );
  const stdout = await runTrustedGit(
    request.workspacePath,
    ["diff", "--binary", "--no-ext-diff", request.revision, "--"],
    input.signal,
    MAX_GIT_OUTPUT_BYTES,
  );
  const patch = stdout.toString("utf8");
  return {
    record: completed,
    patch: patch.length > 0 ? patch : null,
    patchEvidence: null,
    editorialOutcome,
    ...(editorialReplay ? { editorialAuthority: editorialReplay.authority } : {}),
  };
}

/**
 * Refuse a contained native runner this release does not install
 * (`native-codex`/`native-claude`). It sits on the admission path because a
 * native operation supplies its own harness and never calls `createHarness`.
 */
function assertExecutableHostedComposition(request: HostRuntimeRequestV1): void {
  if (
    request.composition.route === "native-codex" ||
    request.composition.route === "native-claude"
  ) {
    const error = new Error(
      `host-invoker: ${request.composition.route} is preflight-only until a contained runner is installed`,
    );
    error.name = "UnsupportedNativeCompositionError";
    throw error;
  }
}

function createHarness(
  request: HostRuntimeRequestV1,
  credential: string | null,
  styleContext: StyleTaskContextV1 | undefined,
  runNotes: RunNotes,
  signal?: AbortSignal,
): AgentHarness {
  if (request.composition.route === "offline-fixture") {
    if (credential !== null)
      throw new Error(
        "The offline hosted composition unexpectedly received provider credential material.",
      );
    return new OfflineWorkflowHarness(
      request.composition.compositionSha256,
      request.composition.declaredTools,
    );
  }
  if (!credential || !request.composition.executionProfile) {
    throw new Error(
      "The executable hosted provider composition is missing its file-descriptor credential.",
    );
  }
  const profile = request.composition.executionProfile;
  const controller = { abort: (): void => undefined };
  const harness = new PiHarness({
    skillCrateDirectory: new URL("../../skill-crate", import.meta.url).pathname,
    qualityDirectory: new URL("../../quality", import.meta.url).pathname,
    ...(styleContext ? { styleContext } : {}),
    // Runtime policy, not carried in the request: `toolPolicySha256` covers
    // declared tool names, not tool limits.
    toolOutputCapBytes: resolveToolOutputCapBytes(),
    executionProfile: profile,
    credential: {
      family: request.composition.credentialFamily as Exclude<
        typeof request.composition.credentialFamily,
        "none"
      >,
      apiKey: credential,
    },
    providerConnectionFactory: createProviderConnectionFactory({
      routeId: profile.routeId,
      transport: profile.transport,
      onServedModel: (observation) => runNotes.add(servedModelWarning(observation)),
    }),
    configureSession(session) {
      controller.abort = () => session.abort();
    },
    beforeToolCall: async (context) => {
      const name = toolName(context);
      return name && request.composition.declaredTools.includes(name)
        ? undefined
        : { block: true, reason: "DocsFab denied a tool outside the installed composition." };
    },
  });
  signal?.addEventListener("abort", () => controller.abort(), { once: true });
  return harness;
}

class OfflineWorkflowHarness implements AgentHarness {
  constructor(
    private readonly compositionSha256: string,
    private readonly tools: readonly string[],
  ) {}
  async inspectSkill(input: HarnessStepInput) {
    return {
      id: input.step.skill,
      contentSha256: digest({ skill: input.step.skill, composition: this.compositionSha256 }),
    };
  }
  async runStep(input: HarnessStepInput) {
    if (requiresSourceObligationLedger(input)) {
      const paths = offlineDocumentationPaths(input);
      const sourceLocator = paths[0];
      if (!sourceLocator) {
        return {
          summary: "The offline fixture found no admitted source for obligation derivation.",
          outcome: "needs-input" as const,
          skill: await this.inspectSkill(input),
        };
      }
      const sourceObligationProposal: SourceObligationLedgerProposalV1 = {
        completeness: "bounded-not-proven",
        dimensions: TECHNICAL_FACT_DIMENSIONS.map((dimension) => ({
          dimension,
          status: "not-applicable",
          reason: `The offline fixture establishes no ${dimension} obligation.`,
          sourceLocators: [`${sourceLocator}:1`],
          obligations: [],
        })),
        limitations: [],
      };
      return {
        summary: canonicalSourceObligationProposal(sourceObligationProposal),
        sourceObligationProposal,
        model: { provider: "offline-fixture", model: this.compositionSha256.slice(0, 16) },
        skill: await this.inspectSkill(input),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0 },
        tools: { totalCalls: 0, failedCalls: 0, byTool: [], failureCategories: [] },
      };
    }
    let verificationResult: VerificationResult | undefined;
    if (input.step.skill === "verify-technical-accuracy") {
      const paths = offlineDocumentationPaths(input);
      if (!paths.length)
        return {
          summary: "The offline fixture found no documentation targets to verify.",
          outcome: "needs-input" as const,
          skill: await this.inspectSkill(input),
        };
      verificationResult = validateVerificationResult(
        {
          review: { verdict: "human-review", issues: [] },
          coverage: paths.map((path) => ({
            path,
            status: "unverified",
            evidence: [],
            reason:
              "The offline fixture does not perform technical verification; source claims require a real review.",
          })),
          factInventory: {
            completeness: "bounded-not-proven",
            dimensions: TECHNICAL_FACT_DIMENSIONS.map((dimension) => {
              const reason = `The offline fixture cannot inspect ${dimension} behavior; use an executable technical review.`;
              return {
                dimension,
                status: "unverified",
                reason,
                sourceLocators: [],
                facts: [],
              };
            }),
            limitations: TECHNICAL_FACT_DIMENSIONS.map(
              (dimension) =>
                `The offline fixture cannot inspect ${dimension} behavior; use an executable technical review.`,
            ),
          },
        },
        paths,
      );
    }
    const correction =
      verificationResult && requiresTechnicalCorrection(input) && input.sourceObligationLedger
        ? input.sourceObligationLedger.schemaVersion === 2
          ? await bindHostOwnedTechnicalCorrectionProposalV3(
              {
                kind: TECHNICAL_CORRECTION_PROPOSAL_KIND,
                schemaVersion: 3,
                verdict: verificationResult.review.verdict,
                coverage: verificationResult.coverage,
                factInventory: verificationResult.factInventory,
                issueJudgments: [],
                obligationAccounting: [],
              },
              input.sourceObligationLedger,
              input.originalSourceAuthorityAdmission ??
                (() => {
                  throw new Error(
                    "Offline fixture requires a valid original source authority admission.",
                  );
                })(),
              input.runId ?? "",
              authoritativeReviewTargetPaths(input) ??
                verificationResult.coverage.map(({ path }) => path),
            )
          : bindTechnicalCorrectionResponse(
              { verificationResult, obligationAccounting: [] },
              input.sourceObligationLedger,
              (value) => value as VerificationResult,
            )
        : undefined;
    verificationResult = correction?.verificationResult ?? verificationResult;
    return {
      ...(verificationResult ? { verificationResult } : {}),
      ...(correction ? { technicalCorrectionEvidence: correction.evidence } : {}),
      summary:
        input.workflow.name === "readiness"
          ? unassessedSourceReadinessFixture(input)
          : verificationResult
            ? canonicalizeJsonEvidence(verificationResult as unknown as JsonEvidenceValue).trimEnd()
            : `offline fixture executed ${input.step.id}`,
      model: { provider: "offline-fixture", model: this.compositionSha256.slice(0, 16) },
      skill: await this.inspectSkill(input),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0, cost: 0 },
      tools: {
        totalCalls: 0,
        failedCalls: 0,
        byTool: this.tools.map((name) => ({ name, calls: 0, failures: 0 })),
        failureCategories: [],
      },
    };
  }
}

function offlineDocumentationPaths(input: HarnessStepInput): string[] {
  const authoritative = authoritativeReviewTargetPaths(input);
  if (authoritative) return [...authoritative];
  return [
    ...new Set(
      (input.searchEvidence?.searches ?? []).flatMap((search) =>
        search.bounded.probes.flatMap((probe) => probe.citations.map((citation) => citation.path)),
      ),
    ),
  ]
    .filter((path) => /\.(?:md|mdx|rst)$/iu.test(path))
    .sort();
}

async function assertWorkspaceRevision(
  workspace: string,
  expected: string,
  expectedTree: string,
  signal?: AbortSignal,
): Promise<void> {
  const [commit, tree, status] = await Promise.all([
    runTrustedGit(workspace, ["rev-parse", "--verify", "HEAD^{commit}"], signal),
    runTrustedGit(workspace, ["rev-parse", "--verify", "HEAD^{tree}"], signal),
    runTrustedGit(workspace, ["status", "--porcelain=v1", "--untracked-files=all"], signal),
  ]);
  if (
    commit.toString("utf8").trim() !== expected ||
    tree.toString("utf8").trim() !== expectedTree ||
    status.length !== 0
  ) {
    throw new Error("The hosted runtime workspace no longer matches its exact clean manifest.");
  }
}

function toolName(context: unknown): string | undefined {
  if (!context || typeof context !== "object") return undefined;
  const record = context as Record<string, unknown>;
  if (typeof record.toolName === "string") return record.toolName;
  if (record.toolCall && typeof record.toolCall === "object") {
    const call = record.toolCall as Record<string, unknown>;
    return typeof call.name === "string" ? call.name : undefined;
  }
  return undefined;
}
