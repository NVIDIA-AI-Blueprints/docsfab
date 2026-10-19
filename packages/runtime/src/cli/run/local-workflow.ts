// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { DurableArtifactStore } from "../../artifacts/store.js";
import { FileRunStore } from "../../records/file-store.js";
import { decodeSavedRunRecord } from "../../records/saved-run-record.js";
import { admitReviewRescope } from "../../operator/recovery-scope.js";
import { buildRepositoryDiscoveryInventory } from "../../repository/inventory.js";
import { publicDocumentationPaths } from "../../workflow-execution/local-review-scope.js";
import { escapeUndisplayable } from "../../shared/display-text.js";
import { assertWorkflowActive } from "../../execution/cancellation.js";
import { failChangeSource } from "../../inputs/change-source.js";
import { failRunOption } from "../run-arguments.js";

import {
  loadConfig,
  loadNonInferenceRuntimeConfig,
  isNonInferenceRuntimeConfig,
  type DocsFabConfig,
  type RunRuntimeConfig,
} from "../../config/runtime-loader.js";
import { assertLegacyPolicyProfileReady } from "../../setup/profile-readiness.js";
import { bootstrapMissingProjectConfigIntoWorkspace } from "../../init/first-run-bootstrap.js";
import { GitPatchEvidenceCollector } from "../../repository/evidence.js";
import { withRepositoryWorkspace } from "../../repository/workspace/materialize.js";
import {
  admitAuthorizedTrackedWrites,
  listTrackedRepositoryFileSnapshotMetadata,
} from "../../repository/workspace/tracked-read.js";
import { ExecInitCommandRunner } from "../../init/shared.js";
import {
  createWorkspaceTrackedSourceReader,
  resolveCliChangeSource,
} from "./source-acquisition.js";
import {
  bindFirstRunProposalScope,
  bindFirstPassKnowledge,
  documentationPlanWriteScope,
  droppedDocumentationRootsStatus,
  FIRST_PASS_KNOWLEDGE_SNAPSHOT_PATH,
  firstRunProposalTargetControl,
  needsFirstPassKnowledge,
  needsFirstPassKnowledgeForExecution,
} from "../first-pass.js";
import {
  continuationRequestedPageIntent,
  instructionSha256,
  KnowledgeResumeError,
  ORIGINAL_TASK_PATH,
  requireMatchingKnowledgeResumeReceipts,
} from "../knowledge-resume.js";
import { executeWorkflowRun, resolveRunOperatorBinding, runSourceReadBudget } from "./execution.js";
import {
  claimKnowledgeContinuation,
  loadKnowledgeContinuation,
  persistKnowledgeContinuationStop,
  type ClaimedKnowledgeContinuation,
} from "./knowledge-continuation.js";
import { KnowledgeContinuationError } from "../../records/knowledge-continuation.js";
import { loadAnswerRecordContinuation } from "./answer-record-continuation.js";
import { persistFirstPassContradictionStop } from "./first-pass-contradiction-stop.js";
import { loadFirstPassChoiceContinuation } from "./first-pass-choice-continuation.js";
import { FirstPassSupportValidationError } from "../first-pass-support.js";
import {
  mintCliOperatorDirectedLineage,
  resolveCliOperatorAuthorityId,
} from "../../lineage/index.js";
import { canonicalDigest } from "../../contract-kit/index.js";
import { assembleHostOperations } from "./host-operations.js";
import { planOperatorNamedPaths } from "./plan-operator-naming.js";
import { prepareRunPreflight } from "./preflight.js";
import { probeRequiredCheckReadiness } from "../../workflow-execution/required-check-readiness.js";
import { admitRunBeforeModel } from "./pre-model-admission.js";
import { loadCompositionRunRuntime } from "./composition-runtime.js";
import {
  loadInstalledModelCompositionAuthority,
  resolveInstalledExecutableComposition,
} from "../../model-composition/index.js";
import {
  interpretedNonPublication,
  persistPublicationProhibitionStop,
  runRequestPublishes,
} from "./publication-prohibition-stop.js";
import { persistRequestIntentStop, runRequestInterpretation } from "./request-intent-stop.js";
import type {
  CliRunInvocation,
  CliRunDeliveryOutcome,
  CliRunOptions,
  RunRequestWithPublishProjection,
} from "./request.js";
import {
  RepositoryWorkspaceReadError,
  type RepositoryWorkspace,
} from "../../repository/workspace/contracts.js";
import type { RunPreflight } from "./preflight.js";
import type { ExecutedCliRun } from "./execution.js";

export type { RunRequestWithPublishProjection } from "./request.js";

/** CLI composition root: preflight → assemble → execute → deliver. */
export interface LocalWorkflowResultContext {
  /**
   * `intent-stopped`: the run stopped before its first step on a question or
   * refusal that saved its own record: the request interpretation, or first
   * pass finding sources that disagree. `execution.record` is that stop's
   * record, never a knowledge continuation stop.
   */
  readonly disposition: "executed" | "stopped" | "already-completed" | "intent-stopped";
  readonly invocation: CliRunInvocation;
  readonly workspace: RepositoryWorkspace;
  readonly preflight: RunPreflight;
  readonly execution: ExecutedCliRun;
  readonly preflightStopCode?: "reviewer-policy-rejected" | "application-rejected";
  readonly deliveryRequired?: boolean;
  readonly completedAttempt?: import("../../records/knowledge-continuation-store.js").KnowledgeContinuationAttemptV1;
}

export interface LocalWorkflowConsumption<T> {
  readonly value: T;
  readonly deliveryOutcome?: CliRunDeliveryOutcome;
}

export type LocalWorkflowResultConsumer<T> = (
  context: LocalWorkflowResultContext,
) => Promise<LocalWorkflowConsumption<T>>;

export type LocalWorkflowOptions = CliRunOptions & {
  readonly output: import("./request.js").CliRunOutput;
  readonly onStatus?: (message: string) => void;
  /** Caller-owned admission applied after any trusted continuation is loaded. */
  readonly prepareRequest?: (
    request: RunRequestWithPublishProjection,
  ) => Promise<RunRequestWithPublishProjection>;
};

type StructuralAuditStopCode =
  | "audit-continuation-unsupported"
  | "audit-workflow-invalid"
  | "audit-interpretation-unexpected";

const STRUCTURAL_AUDIT_STOPS: Record<
  StructuralAuditStopCode,
  { readonly message: string; readonly nextAction: string }
> = {
  "audit-continuation-unsupported": {
    message: "The structural audit does not support answer-record or model-run continuation.",
    nextAction: "Start a fresh audit-documentation run without --resume-from.",
  },
  "audit-workflow-invalid": {
    message: "The structural audit requires its registered read-only workflow and no publication.",
    nextAction: "Run audit-documentation without publication or a workflow override.",
  },
  "audit-interpretation-unexpected": {
    message: "The structural audit unexpectedly entered a model request-interpretation path.",
    nextAction: "Retry the registered audit and report this unexpected interpretation boundary.",
  },
};

class StructuralAuditOperatorError extends Error {
  readonly code: StructuralAuditStopCode;
  readonly nextAction: string;

  constructor(code: StructuralAuditStopCode) {
    const stop = STRUCTURAL_AUDIT_STOPS[code];
    super(stop.message);
    this.name = "StructuralAuditOperatorError";
    this.code = code;
    this.nextAction = stop.nextAction;
  }
}

export function withLocalWorkflowRun<T>(
  request: RunRequestWithPublishProjection,
  config: DocsFabConfig | undefined,
  options: LocalWorkflowOptions,
  consume: LocalWorkflowResultConsumer<T>,
): Promise<T | undefined>;
export async function withLocalWorkflowRun<T>(
  request: RunRequestWithPublishProjection,
  config: DocsFabConfig | undefined,
  options: LocalWorkflowOptions,
  consume: LocalWorkflowResultConsumer<T>,
): Promise<T | undefined> {
  assertWorkflowActive(options.signal);
  if (request.workflow === "audit-documentation") {
    return withStructuralAuditRun(request, config, options, consume);
  }
  // `--composition <id>` selects that preset for this run; without it the
  // configured model runs.
  const compositionPath = request.compositionId !== undefined;
  const legacyConfig = compositionPath ? undefined : (config ?? loadConfig());
  if (legacyConfig) assertLegacyPolicyProfileReady(legacyConfig.model.profile);
  const continuationConfig = request.resumeFrom
    ? (config ??
      legacyConfig ??
      loadConfig(
        process.env,
        request.compositionId !== undefined ? { writingPreset: request.compositionId } : {},
      ))
    : undefined;
  const loadedAnswerRecordContinuation = continuationConfig
    ? await loadAnswerRecordContinuation(request, continuationConfig)
    : undefined;
  // A preset run resumes a knowledge continuation the same way a profile run does.
  const knowledgeConfig = legacyConfig ?? continuationConfig;
  const loadedFirstPassChoice = request.firstPassChoices?.length
    ? await loadFirstPassChoiceContinuation({
        request,
        config: config ?? legacyConfig ?? loadConfig(),
      })
    : undefined;
  const loadedContinuation =
    knowledgeConfig && !loadedAnswerRecordContinuation
      ? await loadKnowledgeContinuation(request, knowledgeConfig)
      : undefined;
  if (request.resumeFrom && !loadedContinuation && !loadedAnswerRecordContinuation) {
    // hygiene: envelope -- run failures are rendered by reportCommandFailure.
    throw new Error(
      "The selected --resume-from run has no eligible committed answer-record checkpoint or supported knowledge continuation. Select a stopped run with a committed evaluator checkpoint, or provide the existing knowledge-continuation acceptance inputs.",
    );
  }
  const status = options.onStatus ?? ((_message: string): void => undefined);
  const selectedRequest =
    loadedAnswerRecordContinuation?.request ?? loadedContinuation?.request ?? request;
  let runRequest: RunRequestWithPublishProjection;
  try {
    runRequest = options.prepareRequest
      ? await options.prepareRequest(selectedRequest)
      : selectedRequest;
  } catch (error) {
    if (loadedContinuation) throw new KnowledgeContinuationError("delivery-recovery-required"); // hygiene: ok -- stable typed code; the constructor supplies the operator-safe message.
    throw error;
  }
  if (
    loadedContinuation?.privateTask.delivery.mode === "draft-mr" &&
    (runRequest.gitlabTargetAtRunStart?.branch !==
      loadedContinuation.privateTask.delivery.targetBranch ||
      runRequest.gitlabTargetAtRunStart.revision !==
        loadedContinuation.privateTask.delivery.targetRevision)
  )
    throw new KnowledgeContinuationError("delivery-recovery-required"); // hygiene: ok -- stable typed code; the constructor supplies the operator-safe message.
  const workspaceRevision = runRequest.gitlabTargetAtRunStart?.revision ?? runRequest.revision;
  return await withRepositoryWorkspace(
    runRequest.repositoryPath,
    workspaceRevision,
    async (workspace) => {
      assertWorkflowActive(options.signal);
      const compositionRuntime = compositionPath
        ? await loadCompositionRunRuntime(runRequest, config)
        : undefined;
      const effectiveConfig = compositionRuntime?.config ?? legacyConfig;
      if (!effectiveConfig) {
        throw new Error(
          "DocsFab runtime configuration is unavailable for the selected execution path.",
        );
      }
      if (runRequest.rescopeFrom) {
        const source = decodeSavedRunRecord(
          (await new FileRunStore(effectiveConfig.stateDirectory).get(
            runRequest.rescopeFrom,
          )) as never,
          runRequest.rescopeFrom,
        );
        if (runRequest.revision !== source.repository.revision) {
          failRunOption("rescope-from-revision");
        }
        const batch = admitReviewRescope({
          source,
          repositoryPath: workspace.sourcePath,
          revision: workspace.revision,
          instruction: runRequest.instruction,
          targetPaths: runRequest.reviewTargetPaths ?? [],
          ...(source.reviewScope
            ? {}
            : {
                wholeSetPaths: publicDocumentationPaths(
                  await buildRepositoryDiscoveryInventory({ workspace }),
                ),
              }),
        });
        status(
          `Rescope from run ${source.id}: effective targets ${batch.targetPaths.map(escapeUndisplayable).join(", ")}; ` +
            `remaining original targets ${batch.remainingPaths.map(escapeUndisplayable).join(", ")}. ` +
            `Batch intent: ${batch.targetPaths.length} selected from the saved review at ${source.repository.revision}.`,
        );
      }
      if (compositionRuntime?.answerRecordDiscovery) {
        const evidence = compositionRuntime.answerRecordDiscovery;
        const { bounds } = evidence;
        const providerExecution = bounds.effective.providerExecution;
        const providerExecutionLimits =
          providerExecution.policyVersion === 2
            ? `answer-record evaluator step has no aggregate provider-turn or whole-attempt time ceiling; configured host proposal ${bounds.configuredHost.maxProviderTurns} turns/${bounds.configuredHost.timeoutMs} ms, package ceiling ${bounds.packageCeiling.maxProviderTurns} turns/${bounds.packageCeiling.timeoutMs} ms; `
            : `provider turns ${providerExecution.maxProviderTurns} (host ${bounds.configuredHost.maxProviderTurns}, package ceiling ${bounds.packageCeiling.maxProviderTurns}); ` +
              `provider timeout ${providerExecution.timeoutMs} ms (host ${bounds.configuredHost.timeoutMs}, package ceiling ${bounds.packageCeiling.timeoutMs}); `;
        status(
          `${evidence.statusLabel}. Effective discovery controls: ${providerExecutionLimits}` +
            `response ${bounds.effective.providerExecution.maxResponseBytes} bytes; ` +
            `model context/input/output ${bounds.effective.model.contextWindow}/` +
            `${bounds.effective.model.maxInputTokens}/${bounds.effective.model.maxOutputTokens} tokens; ` +
            `local quality-validator subprocess ${bounds.qualityValidatorTimeoutMs} ms; ` +
            `request interpretation ${bounds.requestIntentTimeoutMs} ms; ` +
            `answer-now reserve policy ${bounds.answerNow.elapsedShareBasisPoints} bp, ` +
            `${bounds.answerNow.decodeTokensPerSecond} tokens/s, ${bounds.answerNow.turnLatencyMs} ms/turn; ` +
            "no separate workflow deadline.",
        );
      }
      // Resolve and bound the whole --change range here, ahead of request
      // interpretation and the knowledge first pass, so a bad range refuses
      // before any model call. Observations are minted later, at acquisition.
      // A merge request kind reads it through the operator's own glab login.
      const preparedReviewChange = options.preparedReviewChange;
      if (preparedReviewChange !== undefined) {
        const source = preparedReviewChange.changeSource.source;
        const selected = runRequest.changeSource;
        if (
          runRequest.workflow !== "review-documentation" ||
          source.kind !== "github-pull-request" ||
          selected?.source !== "github-pull-request" ||
          !("number" in source) ||
          source.number !== selected.number ||
          !("fullName" in source) ||
          typeof source.fullName !== "string" ||
          source.fullName.toLowerCase() !==
            `${selected.owner}/${selected.repository}`.toLowerCase() ||
          preparedReviewChange.changeSource.revision.head !== workspace.revision
        ) {
          failChangeSource("change-source-github-head-moved");
        }
      }
      const changeSource =
        preparedReviewChange ??
        (runRequest.changeSource
          ? await resolveCliChangeSource({
              workspace,
              selector: runRequest.changeSource,
              onStatus: status,
              besideObservations: runRequest.sourcePaths?.length ?? 0,
              // The step read budget of the model this run will bind, which a
              // release sizes its units index to; other kinds never ask for it.
              readBudget: async () => {
                const selection = {
                  request: runRequest,
                  config: effectiveConfig,
                  options,
                  ...(compositionRuntime ? { compositionRuntime } : {}),
                };
                return runSourceReadBudget(selection, await resolveRunOperatorBinding(selection));
              },
              ...(options.signal ? { signal: options.signal } : {}),
              forge: {
                commands: options.changeRequestCommands ?? new ExecInitCommandRunner(),
                environment: options.changeRequestEnvironment ?? process.env,
              },
            })
          : undefined);
      const invocation: CliRunInvocation = {
        request: runRequest,
        config: effectiveConfig,
        options,
        output: options.output,
        ...(compositionRuntime ? { compositionRuntime } : {}),
        ...(loadedAnswerRecordContinuation
          ? {
              answerRecordContinuation: loadedAnswerRecordContinuation.answerRecordContinuation,
              claimAnswerRecordContinuation:
                loadedAnswerRecordContinuation.claimAnswerRecordContinuation,
            }
          : {}),
        ...(changeSource ? { changeSource } : {}),
      };
      const prepared = await prepareRunPreflight(invocation, workspace);
      assertWorkflowActive(options.signal);
      if ("stoppedRecord" in prepared) {
        const { stoppedRecord, code, ...preflight } = prepared;
        return (
          await consume({
            disposition: "stopped",
            invocation,
            workspace,
            preflight,
            execution: { record: stoppedRecord, exitCode: 1 },
            preflightStopCode: code,
          })
        ).value;
      }
      const preflight = prepared;
      let claimedContinuation: ClaimedKnowledgeContinuation | undefined;
      let executionRequest = preflight.task ? { ...runRequest, task: preflight.task } : runRequest;
      if (loadedContinuation) {
        const claim = await claimKnowledgeContinuation(loadedContinuation, workspace);
        if (!("attempt" in claim)) {
          if (claim.disposition === "already-completed" && claim.record && claim.completedAttempt) {
            if (claim.completedAttempt.phase === "delivery-settled") {
              return (
                await consume({
                  disposition: "already-completed",
                  invocation,
                  workspace,
                  preflight,
                  execution: { record: claim.record, exitCode: 0 },
                  deliveryRequired: false,
                  completedAttempt: claim.completedAttempt,
                })
              ).value;
            }
            const consumed = await consume({
              disposition: "already-completed",
              invocation,
              workspace,
              preflight,
              execution: { record: claim.record, exitCode: 0 },
              deliveryRequired: true,
            });
            if (consumed.deliveryOutcome?.status === "settled") {
              await loadedContinuation.attempts.transition({
                originalRunId: loadedContinuation.receipt.originalRunId,
                attemptId: claim.completedAttempt.attemptId,
                owner: loadedContinuation.owner,
                phase: "delivery-settled",
                deliveryResult: await createContinuationDeliveryResult(
                  effectiveConfig,
                  loadedContinuation.privateTask.delivery,
                  consumed.deliveryOutcome,
                ),
              });
            }
            return consumed.value;
          }
          throw new Error(
            claim.disposition === "busy"
              ? "Knowledge continuation is busy in another live process."
              : "Knowledge continuation requires bounded operator recovery before it can run again.",
          );
        }
        claimedContinuation = claim;
        executionRequest = claim.request;
      } else if (needsFirstPassKnowledge(runRequest) && runRequest.instruction) {
        const runId = runRequest.runId ?? randomUUID();
        const repository = {
          identitySha256: createHash("sha256").update(workspace.sourcePath).digest("hex"),
          revision: workspace.revision,
        };
        const taskLineage =
          runRequest.taskLineage ??
          (await mintCliOperatorDirectedLineage({
            instruction: runRequest.instruction.normalize("NFC"),
            task: null,
            workflow: runRequest.workflow,
            repository,
            authorityId: resolveCliOperatorAuthorityId(),
            runId,
          }));
        executionRequest = { ...runRequest, runId, taskLineage };
      }
      if (preflight.workflow.steps.some((step) => step.mode === "write")) {
        const limitation = await (
          options.probeRequiredCheckReadiness ?? probeRequiredCheckReadiness
        )(workspace);
        if (limitation) {
          const line = `PREFLIGHT ${limitation.code}: ${limitation.explanation} Next action: ${limitation.nextCommand} The run can still produce a patch with this limitation.`;
          options.output.error(line);
        }
      }
      // Every refusal that reads neither the request's pages nor a model reply
      // comes before the interpretation, the run's first model call.
      const preModelAdmission = await admitRunBeforeModel({
        config: effectiveConfig,
        workspace,
        ...(executionRequest.sourcePaths ? { sourcePaths: executionRequest.sourcePaths } : {}),
        ...(options.hostTrackedSourceReader
          ? { hostTrackedSourceReader: options.hostTrackedSourceReader }
          : {}),
      });
      // A local run: .docsfab.json documentationRoots may widen the write
      // roots to configured documentation directories, Markdown and MDX only
      // (owner amendment to Decision 8, option A, #1914 note 72942914).
      // Hosted runs never reach this path and stay narrow until #1603. The
      // interpretation and first-pass binding read this one policy.
      const documentationRootPolicy = "local-widen" as const;
      // Interpret once, before first-pass binding reads the request, and for
      // read-only runs too. First pass binds its write targets from an
      // admitted intent.
      const interpretation = loadedFirstPassChoice
        ? { kind: "continue" as const, recorded: loadedFirstPassChoice.requestIntent }
        : loadedAnswerRecordContinuation
          ? { kind: "continue" as const, recorded: loadedAnswerRecordContinuation.requestIntent }
          : await runRequestInterpretation({
              request: executionRequest,
              loadedContinuation: loadedContinuation !== undefined,
              workflow: preflight.workflow,
              workspace,
              config: effectiveConfig,
              documentationRoots: preflight.documentationRoots,
              documentationRootPolicy,
              ...(preflight.documentationRootFiles
                ? { documentationRootFiles: preflight.documentationRootFiles }
                : {}),
              ...(preflight.rstUpdatePaths ? { rstUpdatePaths: preflight.rstUpdatePaths } : {}),
              ...(compositionRuntime ? { compositionRuntime } : {}),
              ...(options.requestInterpreter ? { port: options.requestInterpreter } : {}),
              ...(options.signal ? { signal: options.signal } : {}),
            });
      // The interpretation is the second publication-prohibition signal: a
      // reading that forbids publishing stops a run that would publish.
      const nonPublication = interpretedNonPublication(interpretation);
      if (nonPublication && runRequestPublishes(executionRequest)) {
        const record = await persistPublicationProhibitionStop({
          request: executionRequest,
          config: effectiveConfig,
          workspace,
          recorded: nonPublication,
        });
        return (
          await consume({
            disposition: "intent-stopped",
            invocation: { ...invocation, request: executionRequest },
            workspace,
            preflight,
            execution: { record, exitCode: 1 },
          })
        ).value;
      }
      if (interpretation.kind === "stop") {
        const record = await persistRequestIntentStop({
          request: executionRequest,
          config: effectiveConfig,
          workspace,
          step: interpretation,
          ...(compositionRuntime?.modelSettings
            ? { modelSettings: compositionRuntime.modelSettings }
            : {}),
        });
        return (
          await consume({
            disposition: "intent-stopped",
            invocation: { ...invocation, request: executionRequest },
            workspace,
            preflight,
            execution: { record, exitCode: interpretation.exitCode },
          })
        ).value;
      }
      // Only this step's own result is the run's intent: a field the caller
      // set on the request never reaches first pass.
      const { requestIntent: _callerSupplied, ...uninterpreted } = executionRequest;
      executionRequest = interpretation.recorded
        ? { ...uninterpreted, requestIntent: interpretation.recorded }
        : uninterpreted;
      const evidence = await GitPatchEvidenceCollector.create(
        workspace.path,
        resolve(dirname(effectiveConfig.stateDirectory), "patches"),
      );
      try {
        const droppedRoots = droppedDocumentationRootsStatus(
          executionRequest.workflow,
          preflight.documentationRoots,
          documentationRootPolicy,
          preflight.documentationRootFiles,
        );
        if (droppedRoots) status(droppedRoots);
        const proposalScope = loadedAnswerRecordContinuation
          ? undefined
          : await bindFirstRunProposalScope({
              request: executionRequest,
              config: effectiveConfig,
              revision: workspace.revision,
              documentationRootPolicy,
              ...(preflight.documentationRoots
                ? { documentationRoots: preflight.documentationRoots }
                : {}),
              ...(preflight.documentationRootFiles
                ? { documentationRootFiles: preflight.documentationRootFiles }
                : {}),
              ...(preflight.rstUpdatePaths ? { rstUpdatePaths: preflight.rstUpdatePaths } : {}),
            });
        const firstPassRequired = loadedAnswerRecordContinuation
          ? false
          : await needsFirstPassKnowledgeForExecution(
              executionRequest,
              preflight.workflow,
              proposalScope,
              { config: effectiveConfig, revision: workspace.revision },
            );
        status("checking project configuration");
        const projectConfig = loadedAnswerRecordContinuation
          ? { status: "local-unconfigured" as const }
          : await bootstrapMissingProjectConfigIntoWorkspace({
              sourcePath: workspace.sourcePath,
              workspacePath: workspace.path,
              allowWrite: runRequest.allowWrite,
              writeCapable: preflight.workflow.steps.some((step) => step.mode === "write"),
              allowLocalUnconfigured: !runRequestPublishes(executionRequest),
              ...(executionRequest.remoteName ? { remote: executionRequest.remoteName } : {}),
              ...(proposalScope
                ? {
                    proposalScope,
                    proposalScopeExpected: {
                      workflow: proposalScope.workflow,
                      instructionSha256: instructionSha256(executionRequest.instruction),
                      repositoryRevision: workspace.revision,
                    },
                  }
                : {}),
            });
        if (projectConfig.status === "bootstrapped") {
          status("proposing host-derived .docsfab.json in this write");
        } else if (projectConfig.status === "host-private") {
          status("using host-private project setup within the explicit proposal scope");
        } else if (projectConfig.status === "local-unconfigured") {
          status(
            "using default documentation roots; retaining a local result without project setup",
          );
        }
        let knowledge;
        // Every record this run saves from here keeps first pass's notices.
        const firstPassNotices: string[] = [];
        try {
          knowledge = firstPassRequired
            ? await bindFirstPassKnowledge({
                request: executionRequest,
                config: effectiveConfig,
                workspacePath: workspace.path,
                revision: workspace.revision,
                status,
                notice: (line) => firstPassNotices.push(line),
                ...(options.signal ? { signal: options.signal } : {}),
                ...(compositionRuntime ? { compositionRuntime } : {}),
                documentationRootPolicy,
                ...(preflight.documentationRoots
                  ? { documentationRoots: preflight.documentationRoots }
                  : {}),
                ...(preflight.documentationRootFiles
                  ? { documentationRootFiles: preflight.documentationRootFiles }
                  : {}),
                ...(preflight.rstUpdatePaths ? { rstUpdatePaths: preflight.rstUpdatePaths } : {}),
                // Same reader source acquisition uses, so the gate and the
                // producer cannot disagree about what this revision tracks.
                trackedSourceReader:
                  options.hostTrackedSourceReader ?? createWorkspaceTrackedSourceReader(workspace),
                ...(loadedFirstPassChoice
                  ? {
                      firstPassChoices: loadedFirstPassChoice.choices,
                      ...(loadedFirstPassChoice.replay
                        ? { firstPassReplay: loadedFirstPassChoice.replay }
                        : {}),
                    }
                  : {}),
              })
            : undefined;
        } catch (error) {
          // Only the stop for sources that disagree saves a record here; every
          // other first-pass stop keeps the operator error envelope.
          if (
            error instanceof FirstPassSupportValidationError &&
            error.code === "contradicted" &&
            error.contradictions !== undefined
          ) {
            const record = await persistFirstPassContradictionStop({
              request: executionRequest,
              admissionRequest: runRequest,
              config: effectiveConfig,
              workspace,
              contradictions: error.contradictions,
              // A legacy chain cannot acquire replay authority midway through
              // its choices; all descendants keep the original lineage shape.
              ...(error.replay && (!loadedFirstPassChoice || loadedFirstPassChoice.replay)
                ? { replay: error.replay }
                : {}),
              notices: firstPassNotices,
            });
            return (
              await consume({
                disposition: "intent-stopped",
                invocation: { ...invocation, request: executionRequest },
                workspace,
                preflight,
                execution: { record, exitCode: 2 },
              })
            ).value;
          }
          if (
            error instanceof KnowledgeResumeError &&
            firstPassRequired &&
            executionRequest.runId &&
            executionRequest.taskLineage
          ) {
            const stopped = await persistKnowledgeContinuationStop({
              request: executionRequest,
              config: effectiveConfig,
              workspace,
              runId: executionRequest.runId,
              taskLineage: executionRequest.taskLineage,
              reason: error.code,
              notices: firstPassNotices,
              ...(error.receipt ? { targetConflictReceipt: error.receipt } : {}),
              ...(compositionRuntime?.modelSettings
                ? { modelSettings: compositionRuntime.modelSettings }
                : {}),
            });
            const stoppedInvocation = { ...invocation, request: executionRequest };
            return (
              await consume({
                disposition: "stopped",
                invocation: stoppedInvocation,
                workspace,
                preflight,
                execution: { record: stopped, exitCode: 2 },
              })
            ).value;
          }
          throw error;
        }
        assertWorkflowActive(options.signal);
        if (firstPassRequired) {
          if (knowledge?.gatheredSnapshot?.replacedTracked) {
            // Authenticate only the fixed host-written path and the exact bytes
            // first pass wrote. An untouched tracked snapshot keeps its export
            // identity and cannot be silently re-admitted after mutation.
            const admitted = await admitAuthorizedTrackedWrites(workspace, [
              FIRST_PASS_KNOWLEDGE_SNAPSHOT_PATH,
            ]);
            const snapshot = (await listTrackedRepositoryFileSnapshotMetadata(workspace)).find(
              (entry) => entry.path === FIRST_PASS_KNOWLEDGE_SNAPSHOT_PATH,
            );
            if (
              !admitted.includes(FIRST_PASS_KNOWLEDGE_SNAPSHOT_PATH) ||
              snapshot?.sha256 !== knowledge.gatheredSnapshot.sha256
            ) {
              throw new RepositoryWorkspaceReadError("changed"); // hygiene: ok -- stable typed code; the constructor supplies the operator-safe message.
            }
          }
          await evidence.advanceBaselineForRuntimeChanges(
            knowledge?.gatheredSnapshot
              ? [FIRST_PASS_KNOWLEDGE_SNAPSHOT_PATH, ORIGINAL_TASK_PATH]
              : [ORIGINAL_TASK_PATH],
          );
        }
        assertWorkflowActive(options.signal);
        const knowledgeRequest: RunRequestWithPublishProjection = knowledge
          ? {
              ...executionRequest,
              ...(knowledge.canonSnapshotPath
                ? { canonSnapshotPath: knowledge.canonSnapshotPath }
                : {}),
              ...(knowledge.acceptCandidateSnapshot ? { acceptCandidateSnapshot: true } : {}),
              ...(knowledge.canonSnapshotAuthorityId
                ? {
                    canonSnapshotAuthorityId: knowledge.canonSnapshotAuthorityId,
                  }
                : {}),
            }
          : executionRequest;
        const proposalTargetControl = proposalScope
          ? firstRunProposalTargetControl(proposalScope)
          : undefined;
        if (
          proposalTargetControl &&
          knowledge?.firstPassTargetControl &&
          proposalTargetControl.bodySha256 !== knowledge.firstPassTargetControl.bodySha256
        ) {
          throw new Error("First-pass support targets do not match the admitted proposal scope.");
        }
        const firstPassTargetControl = proposalTargetControl ?? knowledge?.firstPassTargetControl;
        // A first pass that continued past evidence gaps records them with its
        // other notices (#2113).
        firstPassNotices.push(...(knowledge?.firstPassEvidenceWarnings ?? []));
        // Every plan of this run, admitted, advisory, uninterpreted, or a
        // continuation of any of them, writes only inside these roots, and an
        // agent instruction file or hidden path there only when the
        // operator's own request names it.
        const planWriteScope = documentationPlanWriteScope(
          preflight.documentationRoots,
          documentationRootPolicy,
          preflight.documentationRootFiles,
          await planOperatorNamedPaths({
            request: executionRequest,
            stateDirectory: effectiveConfig.stateDirectory,
            trackedPaths: preflight.trackedPaths ?? [],
          }),
          preflight.rstCapabilityAdmission
            ? (preflight.rstUpdatePaths ?? [])
            : (firstPassTargetControl?.targetPaths.filter((path) =>
                preflight.rstUpdatePaths?.includes(path),
              ) ?? []),
        );
        const continuationPageIntent = claimedContinuation
          ? continuationRequestedPageIntent(claimedContinuation.privateTask)
          : undefined;
        const effectiveInvocation: CliRunInvocation = {
          ...invocation,
          request: knowledgeRequest,
          preModelAdmission,
          ...(continuationPageIntent ? { continuationPageIntent } : {}),
          ...(firstPassTargetControl ? { firstPassTargetControl } : {}),
          ...(firstPassNotices.length > 0 ? { firstPassNotices } : {}),
          planWriteScope,
        };
        status(`running ${knowledgeRequest.workflow}`);
        let hostAssembly: Awaited<ReturnType<typeof assembleHostOperations>>;
        try {
          hostAssembly = await assembleHostOperations(
            effectiveInvocation,
            workspace,
            evidence,
            preflight,
          );
        } catch (error) {
          if (claimedContinuation) {
            await claimedContinuation.attempts.transition({
              originalRunId: claimedContinuation.receipt.originalRunId,
              attemptId: claimedContinuation.attempt.attemptId,
              owner: claimedContinuation.owner,
              phase: "failed-before-execution",
            });
          }
          throw error;
        }
        const knowledgeResumeReceipt = requireMatchingKnowledgeResumeReceipts(
          knowledge?.knowledgeResumeReceipt,
          hostAssembly.knowledgeResumeReceipt,
          knowledge?.canonSnapshotPath !== undefined,
        );
        const effectiveHostAssembly = knowledgeResumeReceipt
          ? { ...hostAssembly, knowledgeResumeReceipt }
          : hostAssembly;
        if (claimedContinuation) {
          await claimedContinuation.attempts.transition({
            originalRunId: claimedContinuation.receipt.originalRunId,
            attemptId: claimedContinuation.attempt.attemptId,
            owner: claimedContinuation.owner,
            phase: "executing",
          });
        }
        const execution = await executeWorkflowRun(
          effectiveInvocation,
          workspace,
          evidence,
          preflight,
          effectiveHostAssembly,
        );
        let childRecordSha256: string | undefined;
        if (claimedContinuation && execution.record.status === "succeeded") {
          try {
            const persisted = await new FileRunStore(
              effectiveInvocation.config.stateDirectory,
            ).getWithDigest(execution.record.id);
            if (canonicalDigest(persisted.record) !== canonicalDigest(execution.record)) {
              throw new KnowledgeContinuationError("delivery-recovery-required"); // hygiene: ok -- stable typed code; the constructor supplies the operator-safe message.
            }
            childRecordSha256 = persisted.sha256;
          } catch (error) {
            await claimedContinuation.attempts.transition({
              originalRunId: claimedContinuation.receipt.originalRunId,
              attemptId: claimedContinuation.attempt.attemptId,
              owner: claimedContinuation.owner,
              phase: "recovery-required",
            });
            if (error instanceof KnowledgeContinuationError) throw error;
            throw new KnowledgeContinuationError("delivery-recovery-required"); // hygiene: ok -- stable typed code; the constructor supplies the operator-safe message.
          }
        }
        if (claimedContinuation) {
          const noWriteStarted = execution.record.steps
            .filter((step) => step.mode === "write")
            .every((step) => step.status === "pending");
          await claimedContinuation.attempts.transition({
            originalRunId: claimedContinuation.receipt.originalRunId,
            attemptId: claimedContinuation.attempt.attemptId,
            owner: claimedContinuation.owner,
            phase:
              execution.record.status === "succeeded"
                ? "writer-completed"
                : noWriteStarted && execution.record.status === "needs-input"
                  ? "needs-input-before-execution"
                  : noWriteStarted
                    ? "failed-before-execution"
                    : "recovery-required",
            ...(execution.record.status === "succeeded"
              ? { childRecordSha256: childRecordSha256! }
              : {}),
          });
        }
        const consumed = await consume({
          disposition: "executed",
          invocation: effectiveInvocation,
          workspace,
          preflight,
          execution,
        });
        if (
          claimedContinuation &&
          execution.record.status === "succeeded" &&
          consumed.deliveryOutcome?.status === "settled"
        ) {
          const history = await claimedContinuation.attempts.read(
            claimedContinuation.receipt.originalRunId,
          );
          const latest = history.at(-1)!;
          await claimedContinuation.attempts.transition({
            originalRunId: claimedContinuation.receipt.originalRunId,
            attemptId: latest.attemptId,
            owner: claimedContinuation.owner,
            phase: "delivery-settled",
            deliveryResult: await createContinuationDeliveryResult(
              effectiveConfig,
              claimedContinuation.privateTask.delivery,
              consumed.deliveryOutcome,
            ),
          });
        }
        return consumed.value;
      } finally {
        await evidence.dispose();
      }
    },
  );
}

/** The registered structural audit has no model slot or inference bootstrap. */
async function withStructuralAuditRun<T>(
  request: RunRequestWithPublishProjection,
  providedConfig: DocsFabConfig | undefined,
  options: LocalWorkflowOptions,
  consume: LocalWorkflowResultConsumer<T>,
): Promise<T | undefined> {
  const config: RunRuntimeConfig = providedConfig ?? loadNonInferenceRuntimeConfig();
  if (request.resumeFrom) {
    throw new StructuralAuditOperatorError("audit-continuation-unsupported");
  }
  const runRequest = options.prepareRequest ? await options.prepareRequest(request) : request;
  if (runRequest.workflow !== "audit-documentation" || runRequestPublishes(runRequest)) {
    throw new StructuralAuditOperatorError("audit-workflow-invalid");
  }
  // The CLI admits --change only for create/update. Enforce the same boundary
  // for direct host callers before the audit can enter source acquisition.
  if (runRequest.changeSource) failChangeSource("change-source-workflow-unsupported");
  if (runRequest.compositionId) {
    const { authority } = await loadInstalledModelCompositionAuthority();
    resolveInstalledExecutableComposition({
      authority,
      compositionId: runRequest.compositionId,
      workflowId: runRequest.workflow,
    });
  }
  const status = options.onStatus ?? ((_message: string): void => undefined);
  const revision = runRequest.gitlabTargetAtRunStart?.revision ?? runRequest.revision;
  return withRepositoryWorkspace(runRequest.repositoryPath, revision, async (workspace) => {
    assertWorkflowActive(options.signal);
    const invocation: CliRunInvocation = {
      request: runRequest,
      config,
      options,
      output: options.output,
    };
    const prepared = await prepareRunPreflight(invocation, workspace);
    if ("stoppedRecord" in prepared) {
      const { stoppedRecord, code, ...preflight } = prepared;
      return (
        await consume({
          disposition: "stopped",
          invocation,
          workspace,
          preflight,
          execution: { record: stoppedRecord, exitCode: 1 },
          preflightStopCode: code,
        })
      ).value;
    }
    const preModelAdmission = await admitRunBeforeModel({
      config,
      workspace,
      ...(runRequest.sourcePaths ? { sourcePaths: runRequest.sourcePaths } : {}),
    });
    const interpretation = await runRequestInterpretation({
      request: runRequest,
      loadedContinuation: false,
      workflow: prepared.workflow,
      workspace,
      config,
      documentationRoots: prepared.documentationRoots,
      documentationRootPolicy: "local-widen",
      ...(prepared.documentationRootFiles
        ? { documentationRootFiles: prepared.documentationRootFiles }
        : {}),
      ...(options.requestInterpreter ? { port: options.requestInterpreter } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (interpretation.kind !== "continue") {
      throw new StructuralAuditOperatorError("audit-interpretation-unexpected");
    }
    const { requestIntent: _callerSupplied, ...uninterpreted } = runRequest;
    const executionRequest = interpretation.recorded
      ? { ...uninterpreted, requestIntent: interpretation.recorded }
      : uninterpreted;
    const evidence = await GitPatchEvidenceCollector.create(
      workspace.path,
      resolve(dirname(config.stateDirectory), "patches"),
      isNonInferenceRuntimeConfig(config) ? config.repositoryEvidenceGitLimits : undefined,
    );
    try {
      status("checking project configuration");
      await bootstrapMissingProjectConfigIntoWorkspace({
        sourcePath: workspace.sourcePath,
        workspacePath: workspace.path,
        allowWrite: false,
        writeCapable: false,
        allowLocalUnconfigured: true,
      });
      const planWriteScope = documentationPlanWriteScope(
        prepared.documentationRoots,
        "local-widen",
        prepared.documentationRootFiles,
        await planOperatorNamedPaths({
          request: executionRequest,
          stateDirectory: config.stateDirectory,
          trackedPaths: prepared.trackedPaths ?? [],
        }),
      );
      const effectiveInvocation: CliRunInvocation = {
        ...invocation,
        request: executionRequest,
        preModelAdmission,
        planWriteScope,
      };
      status("running audit-documentation");
      const hostAssembly = await assembleHostOperations(
        effectiveInvocation,
        workspace,
        evidence,
        prepared,
      );
      const execution = await executeWorkflowRun(
        effectiveInvocation,
        workspace,
        evidence,
        prepared,
        hostAssembly,
      );
      return (
        await consume({
          disposition: "executed",
          invocation: effectiveInvocation,
          workspace,
          preflight: prepared,
          execution,
        })
      ).value;
    } finally {
      await evidence.dispose();
    }
  });
}

async function createContinuationDeliveryResult(
  config: DocsFabConfig,
  intent: import("../../records/knowledge-continuation.js").KnowledgeContinuationDeliveryIntentV1,
  outcome: Extract<CliRunDeliveryOutcome, { status: "settled" }>,
) {
  if (
    (intent.mode === "patch-only" && outcome.mode !== "none") ||
    (intent.mode === "draft-mr" &&
      (outcome.mode !== "draft-mr" ||
        outcome.publicationResult.targetBranch !== intent.targetBranch ||
        outcome.publicationResult.mergeRequest.url !== outcome.locator))
  )
    throw new KnowledgeContinuationError("delivery-recovery-required"); // hygiene: ok -- stable typed code; the constructor supplies the operator-safe message.
  const publisherResultArtifactSha256 =
    outcome.mode === "draft-mr" ? canonicalDigest(outcome.publicationResult) : null;
  if (outcome.mode === "draft-mr") {
    await new DurableArtifactStore(resolve(dirname(config.stateDirectory), "artifacts")).putRecord(
      publisherResultArtifactSha256!,
      outcome.publicationResult,
    );
  }
  const body = {
    status: "settled" as const,
    intentSha256: intent.intentSha256,
    locator: outcome.locator,
    publisherResultArtifactSha256,
    publisherIdempotencyKey:
      outcome.mode === "draft-mr" ? outcome.publicationResult.idempotencyKey : null,
  };
  return { ...body, resultSha256: canonicalDigest(body) };
}
