// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { canonicalDigest } from "../../content-ir/canonical.js";

import { resolveDocsFabStateDirectory } from "../../config/host-paths.js";
import { formatOperationalLimitStop, type OperationalLimitStop } from "../../config/limit-stop.js";
import {
  loadConfig,
  COMPOSITION_EXECUTION_LIMITS,
  type DocsFabConfig,
} from "../../config/runtime-loader.js";
import {
  attemptDelegatedWriteActivation,
  createDelegatedTaskAuthority,
  DELEGATED_WRITE_ACTIVATION_MESSAGE,
  DELEGATED_WRITE_BLOCKED_ISSUES,
} from "../../delegated-task/authority-adapter.js";
import {
  inspectPauseDelegatedTask,
  resumeDelegatedTask,
  createDelegatedRequest,
  createDelegatedRequirement,
  type DelegatedTaskInspectPauseInput,
  type DelegatedTaskInspectPauseResult,
  type DelegatedTaskResumeInput,
  type DelegatedTaskResumeResult,
} from "../../delegated-task/continuation.js";
import {
  assertDelegatedHostSelection,
  runDelegatedTask,
  type DelegatedTaskLimits,
  type DelegatedTaskResult as DelegatedTaskDriverResult,
  type RunDelegatedChildWorkflowInput,
  type RunDelegatedTaskInput,
} from "../../delegated-task/driver.js";
import { projectDelegatedTaskFulfillment } from "../../delegated-task/fulfillment.js";
import type { DelegatedTaskResultV1 } from "../../delegated-task/result-contract.js";
import { delegatedTaskPresentation } from "../../delegated-task/presentation.js";
import {
  delegatedTaskExitIntent,
  formatDelegatedTaskResultJson,
} from "../../delegated-task/result-format.js";
import {
  renderPresentation,
  resolveProcessPresentationCapabilities,
  withOutputCoordinator,
  writeRenderedPresentation,
  type OperatorOutputCoordinator,
  type PresentationProgressHandle,
} from "../../operator/index.js";
import {
  DELEGATED_TASK_GENERIC_PROMPT,
  DelegatedTaskStateError,
  DelegatedTaskStateStore,
  createDelegatedTaskState,
  delegatedTaskPlanIdentitySha256,
  delegatedTaskStateBody,
  delegatedTaskStateContractKit,
  type DelegatedTaskRequirementInputV1,
} from "../../delegated-task/task-state.js";
import { inspectDelegatedWorkspaceBasis } from "../../delegated-task/workspace-basis.js";
import { EXECUTION_LEASE_DEFAULTS } from "../../execution/lease-contracts.js";
import { loadLiveAgentCapabilities } from "../../live-agent/capabilities.js";
import type { LiveWorkflowRun } from "../../live-agent/workflow-delivery.js";
import type { AdmissionOffer } from "../admission-parse.js";
import { executeRunRequest } from "../run-request.js";
import { admitQualityPack } from "../run/pre-model-admission.js";
import { delegatedCheckEnvironment } from "../../security/delegated-check-environment.js";
import {
  DelegatedCheckOperatorError,
  delegatedCheckId,
  delegatedCheckScript,
  type DoArguments,
  type DoRunArguments,
} from "./do-parse.js";

export const DELEGATED_DO_OWNER_ID = "cli-operator" as const;

export const DELEGATED_DO_LIMITS: DelegatedTaskLimits = {
  maxProviderTurns: EXECUTION_LEASE_DEFAULTS.maxProviderTurns,
  maxToolCalls: EXECUTION_LEASE_DEFAULTS.hardToolCallCeiling,
  timeoutMs: COMPOSITION_EXECUTION_LIMITS.timeoutMs.default,
};

const DELEGATED_SILENT_FALLBACK = "Delegated do failed without invoking catalog routing.";
const DELEGATED_WRITE_DENIED = `${DELEGATED_WRITE_ACTIVATION_MESSAGE} Blocked on ${DELEGATED_WRITE_BLOCKED_ISSUES.join(" and ")}.`;
const DELEGATED_RESUME_MISSING_OUTCOME =
  "Delegated resume cannot re-enter the driver because the retained outcome for that task is missing.";
const DELEGATED_RESUME_OUTCOME_MISMATCH =
  "Delegated resume cannot re-enter the driver because the retained outcome does not match that task.";

/** Resume outcome failures use the CLI usage remediation at the operator boundary. */
class DelegatedResumeOperatorError extends Error {
  readonly code = "cli-usage";

  constructor(message: string) {
    super(message);
    this.name = "DelegatedResumeOperatorError";
  }
}

const DELEGATED_CHECK_TIMEOUT_MS = 60_000;
const DELEGATED_PATH_TOKEN = /(?:^|[\s`'"(])((?:docs|src|test)\/[A-Za-z0-9._:/-]{0,240})/gu;
const DELEGATED_MARKDOWN_TOKEN = /\b([A-Za-z0-9._/-]+\.md)\b/gu;
const DELEGATED_CHECK_MANIFEST = "package.json";
const DELEGATED_CHECK_REMEDIATION = `declare it under "scripts" in ${DELEGATED_CHECK_MANIFEST}, or drop that --check flag`;

const DELEGATED_CONSOLE_OUTPUT_COORDINATOR: OperatorOutputCoordinator = {
  writeMessage(stream, completeMessage) {
    const write = stream === "stdout" ? console.log : console.error;
    write(completeMessage.replace(/\n$/u, ""));
  },
  startProgress(_initial): PresentationProgressHandle {
    return { id: Symbol("delegated-do-progress") };
  },
  updateProgress() {},
  finalizeProgress() {},
  dispose() {},
};

export type DoRunWorkflow = (request: DoRunArguments) => Promise<unknown>;
/** Names one workflow from the offer, or `undefined` for an abstain, a miss, or a failure. */
export type AdmitCatalogWorkflow = (
  request: string,
  offer: AdmissionOffer,
) => Promise<string | undefined>;
export type DelegatedDoRunner = (
  input: RunDelegatedTaskInput,
) => Promise<DelegatedTaskDriverResult>;

export interface DoCommandOptions {
  runWorkflow?: DoRunWorkflow;
  admitCatalogWorkflow?: AdmitCatalogWorkflow;
  stateDirectory?: string;
  currentWorkspaceSnapshotSha256?: string;
  now?: () => Date;
  runDelegatedTask?: DelegatedDoRunner;
  resumeDelegatedTask?: (input: DelegatedTaskResumeInput) => Promise<DelegatedTaskResumeResult>;
  inspectPauseDelegatedTask?: (
    input: DelegatedTaskInspectPauseInput,
  ) => Promise<DelegatedTaskInspectPauseResult>;
  createDelegatedTaskAuthority?: typeof createDelegatedTaskAuthority;
  attemptDelegatedWriteActivation?: typeof attemptDelegatedWriteActivation;
  inspectDelegatedWorkspaceBasis?: typeof inspectDelegatedWorkspaceBasis;
  loadDelegatedConfig?: () => DocsFabConfig;
  readAnswersFile?: (path: string) => Promise<string>;
  ownerId?: string;
  taskId?: string;
  signal?: AbortSignal;
  delegatedLimits?: DelegatedTaskLimits;
  runRequestedDelegatedChecks?: (
    input: DelegatedRequestedCheckRunInput,
  ) => Promise<readonly DelegatedRequestedCheckEvidence[]>;
  /** Optional output host for the human boundary; JSON remains on its canonical serializer. */
  outputCoordinator?: OperatorOutputCoordinator;
}

export interface DelegatedRequestedCheckRunInput {
  readonly repositoryPath: string;
  readonly checks: readonly DelegatedRequestedCheck[];
  readonly signal?: AbortSignal;
  /** Variables the loaded configuration names as holding a model key; no check receives them. */
  readonly credentialEnvNames?: readonly string[];
}

export interface DelegatedRequestedCheck {
  readonly checkId: string;
  readonly argv: readonly string[];
}

export interface DelegatedRequestedCheckEvidence {
  readonly checkId: string;
  readonly state: "passed" | "failed";
  readonly receiptSha256: string;
}

export async function handleDelegatedDoCommand(
  parsed: DoArguments,
  options: DoCommandOptions,
): Promise<DelegatedTaskResultV1> {
  assertDelegatedHostSelection({
    ...(parsed.compositionId ? { composition: parsed.compositionId } : {}),
  });
  const stateDirectory = options.stateDirectory ?? resolveDocsFabStateDirectory();
  const storeDirectory = join(stateDirectory, "delegated-tasks");
  const ownerId = options.ownerId ?? DELEGATED_DO_OWNER_ID;
  const inspectBasis = options.inspectDelegatedWorkspaceBasis ?? inspectDelegatedWorkspaceBasis;
  const basis = await inspectBasis(parsed.repositoryPath);
  const canonicalPath = basis.canonicalRepositoryPath;
  // Admit named checks before any authority, pause state, driver, or spawn.
  const requestedChecks = await admitDelegatedChecks(canonicalPath, parsed.checkScripts ?? []);
  let releaseSignals = (): void => undefined;
  let signal = options.signal;
  if (!signal) {
    const abort = new AbortController();
    signal = abort.signal;
    releaseSignals = installDelegatedStopSignals(abort);
  }
  try {
    const createAuthority = options.createDelegatedTaskAuthority ?? createDelegatedTaskAuthority;
    const authority = await createAuthority({
      repositoryPath: canonicalPath,
      allowWrite: parsed.allowWrite,
      signal,
    });
    if (parsed.allowWrite) {
      const activate = options.attemptDelegatedWriteActivation ?? attemptDelegatedWriteActivation;
      const activation = await activate(authority);
      if (activation.status !== "allowed") {
        const taskId = options.taskId ?? `task:${randomUUID()}`;
        return emitDelegatedResult(
          parsed,
          options,
          projectWriteActivationDenied({
            taskId,
            outcome: parsed.request,
            repositoryPath: canonicalPath,
            repositoryRevision: basis.committedHeadRevision.toLowerCase(),
          }),
          DELEGATED_WRITE_DENIED,
        );
      }
    }
    if (parsed.resumeTaskId !== undefined && parsed.answersPath !== undefined) {
      const store = new DelegatedTaskStateStore({ directory: storeDirectory });
      const loaded = await readDelegatedResumeRecord(store, parsed.resumeTaskId);
      assertDelegatedResumeOutcome(loaded.state.outcome, loaded.state.outcomeSha256);
      assertRetainedChecksResupplied(loaded.state.originalRequirements, requestedChecks);
      const readAnswers = options.readAnswersFile ?? ((path: string) => readFile(path, "utf8"));
      const answersJson = await readAnswers(parsed.answersPath);
      const resume = options.resumeDelegatedTask ?? resumeDelegatedTask;
      const resumed = await resume({
        taskId: parsed.resumeTaskId,
        ownerId,
        repositoryPath: canonicalPath,
        repositoryRevision: basis.committedHeadRevision.toLowerCase(),
        answersJson,
        freshAuthority: {
          read: true,
          write: parsed.allowWrite,
          check: requestedChecks.length > 0,
        },
        storeDirectory,
        commit: "defer",
        ...(options.now ? { now: options.now } : {}),
      });
      if (resumed.status === "recovery-required") {
        throw new Error(
          "Delegated task continuation was rejected for the closed code unsupported-recovery.",
        );
      }
      if (resumed.status !== "resumed") {
        return emitDelegatedResult(parsed, options, resumed.result);
      }
      return runProjectedDelegatedDriver({
        parsed,
        options,
        taskId: parsed.resumeTaskId,
        outcome: continueDelegatedOutcome(loaded.state.outcome, answersJson),
        requestLabel: loaded.state.outcome,
        retainedRequestSha256: loaded.state.request.requestSha256,
        requestedChecks,
        canonicalPath,
        repositoryRevision: basis.committedHeadRevision.toLowerCase(),
        signal,
        beforeEmit: async (projected) => {
          if (projected.stopReason !== "finished") return;
          try {
            await store.save(
              finishedStateForProjectedIdentity(resumed.state, projected),
              resumed.recordByteSha256,
            );
          } catch (error) {
            if (error instanceof DelegatedTaskStateError && error.code === "digest-mismatch") {
              throw new DelegatedResumeOperatorError(DELEGATED_RESUME_OUTCOME_MISMATCH);
            }
            throw error;
          }
        },
      });
    }

    const taskId = options.taskId ?? `task:${randomUUID()}`;
    const pauseTargets = await deriveDelegatedPauseTargets(parsed.request, canonicalPath);
    // Named checks are retained requirements, so a pause cannot drop them: the
    // printed resume command carries no --check, and resume refuses without them.
    const defaultRequirements = [
      createDelegatedRequirement("R1", "artifact", pauseTargets.materialTargetLocator ?? "answer"),
      ...requestedChecks.map((check, index) =>
        createDelegatedRequirement(`C${String(index + 1)}`, "check", check.checkId),
      ),
    ];
    const inspectPause = options.inspectPauseDelegatedTask ?? inspectPauseDelegatedTask;
    const paused = await inspectPause({
      taskId,
      ownerId,
      outcome: parsed.request,
      request: createDelegatedRequest(defaultRequirements, parsed.request),
      repositoryPath: canonicalPath,
      repositoryRevision: basis.committedHeadRevision.toLowerCase(),
      admittedLocators: pauseTargets.admittedLocators,
      ...(pauseTargets.materialTargetLocator
        ? { materialTargetLocator: pauseTargets.materialTargetLocator }
        : {}),
      originalRequirements: defaultRequirements,
      inputMode: parsed.json ? "json" : parsed.noInput ? "no-input" : "non-tty",
      currentAuthority: {
        read: true,
        write: parsed.allowWrite,
        check: requestedChecks.length > 0,
      },
      storeDirectory,
      ...(options.now ? { now: options.now } : {}),
    });
    if (paused.status === "needs-input") {
      return emitDelegatedResult(parsed, options, paused.result);
    }
    if (paused.status === "recovery-required") {
      throw new Error(
        "Delegated task continuation was rejected for the closed code unsupported-recovery.",
      );
    }

    return runProjectedDelegatedDriver({
      parsed,
      options,
      taskId,
      outcome: parsed.request,
      requestedChecks,
      canonicalPath,
      repositoryRevision: basis.committedHeadRevision.toLowerCase(),
      signal,
    });
  } finally {
    releaseSignals();
  }
}

async function runProjectedDelegatedDriver(input: {
  parsed: DoArguments;
  options: DoCommandOptions;
  taskId: string;
  outcome: string;
  requestLabel?: string;
  retainedRequestSha256?: string;
  requestedChecks: readonly DelegatedRequestedCheck[];
  canonicalPath: string;
  repositoryRevision: string;
  signal: AbortSignal;
  beforeEmit?: (projected: DelegatedTaskResultV1) => Promise<void>;
}): Promise<DelegatedTaskResultV1> {
  const run = input.options.runDelegatedTask ?? runDelegatedTask;
  const limits = input.options.delegatedLimits ?? DELEGATED_DO_LIMITS;
  const config = input.options.runDelegatedTask
    ? undefined
    : (input.options.loadDelegatedConfig ?? loadConfig)();
  const childDispatch = config
    ? await createDelegatedChildDispatch(config, input.canonicalPath, input.signal)
    : undefined;
  const driverResult = await run({
    outcome: input.outcome,
    repositoryPath: input.canonicalPath,
    repositoryIdentity: {
      canonicalPath: input.canonicalPath,
      revision: input.repositoryRevision,
    },
    sessionLifetime: { kind: "fresh" },
    limits,
    signal: input.signal,
    ...(config ? { model: config.model } : {}),
    ...(childDispatch?.capabilities ? { capabilities: childDispatch.capabilities } : {}),
    ...(childDispatch?.runChildWorkflow
      ? { runChildWorkflow: childDispatch.runChildWorkflow }
      : {}),
  });
  const checkRunner = input.options.runRequestedDelegatedChecks ?? runDelegatedRequestedChecks;
  const checkEvidence =
    input.requestedChecks.length === 0
      ? []
      : await checkRunner({
          repositoryPath: input.canonicalPath,
          checks: input.requestedChecks,
          signal: input.signal,
          // From the loaded configuration, which need not reach this process's environment.
          credentialEnvNames: configuredCredentialEnvNames(
            config ?? input.options.loadDelegatedConfig?.(),
          ),
        });
  const projected = projectDelegatedDriverResult({
    taskId: input.taskId,
    outcome: input.requestLabel ?? input.outcome,
    retainedRequestSha256: input.retainedRequestSha256,
    repositoryPath: input.canonicalPath,
    repositoryRevision: input.repositoryRevision,
    driverResult,
    requestedChecks: input.requestedChecks,
    checkEvidence,
  });
  if (input.beforeEmit) await input.beforeEmit(projected);
  return emitDelegatedResult(
    input.parsed,
    input.options,
    projected,
    driverResult.answer,
    driverResult.limitStop,
  );
}

function assertDelegatedResumeOutcome(outcome: string, expectedOutcomeSha256: string): void {
  if (canonicalDigest(outcome) !== expectedOutcomeSha256) {
    throw new DelegatedResumeOperatorError(DELEGATED_RESUME_OUTCOME_MISMATCH);
  }
}

async function readDelegatedResumeRecord(store: DelegatedTaskStateStore, taskId: string) {
  try {
    return await store.readExact(taskId);
  } catch (error) {
    if (error instanceof DelegatedTaskStateError && error.code === "task-not-found") {
      throw new DelegatedResumeOperatorError(DELEGATED_RESUME_MISSING_OUTCOME);
    }
    if (
      error instanceof DelegatedTaskStateError &&
      (error.code === "identity-mismatch" || error.code === "digest-mismatch")
    ) {
      throw new DelegatedResumeOperatorError(DELEGATED_RESUME_OUTCOME_MISMATCH);
    }
    throw error;
  }
}

function continueDelegatedOutcome(outcome: string, answersJson: string): string {
  const parsed = JSON.parse(answersJson) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return outcome;
  }
  const lines = Object.entries(parsed as Record<string, unknown>)
    .flatMap(([id, value]) => (typeof value === "string" ? [`${id}: ${value}`] : []))
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  if (lines.length === 0) return outcome;
  return `${outcome.trimEnd()}\n\nSettled answers:\n${lines.join("\n")}`;
}

async function emitDelegatedResult(
  parsed: DoArguments,
  options: DoCommandOptions,
  result: DelegatedTaskResultV1,
  answer?: string,
  limitStop?: OperationalLimitStop,
): Promise<DelegatedTaskResultV1> {
  const intent = delegatedTaskExitIntent(result);
  process.exitCode = intent.exitCode;
  // A bound that stopped or clipped this task reaches the operator, not only
  // the retained record. JSON keeps stdout canonical, so it goes to stderr.
  const limitLine = limitStop ? formatOperationalLimitStop(limitStop) : undefined;
  if (parsed.json) {
    const json = formatDelegatedTaskResultJson(result);
    if (json.includes(DELEGATED_TASK_GENERIC_PROMPT)) {
      throw new Error(DELEGATED_SILENT_FALLBACK);
    }
    if (limitLine) console.error(limitLine);
    console.log(json);
    return result;
  }
  const document = delegatedTaskPresentation(result, {
    ...(answer === undefined ? {} : { answer }),
    ...(limitLine === undefined ? {} : { limitNotice: limitLine }),
    includeAnswer: !parsed.quiet,
  });
  const rendered = renderPresentation(document, resolveProcessPresentationCapabilities());
  if (`${rendered.stdout}${rendered.stderr}`.includes(DELEGATED_TASK_GENERIC_PROMPT)) {
    throw new Error(DELEGATED_SILENT_FALLBACK);
  }
  const outputCoordinator = options.outputCoordinator ?? DELEGATED_CONSOLE_OUTPUT_COORDINATOR;
  await withOutputCoordinator(outputCoordinator, async (coordinator) => {
    await writeRenderedPresentation(coordinator, rendered);
  });
  return result;
}

function projectWriteActivationDenied(input: {
  taskId: string;
  outcome: string;
  repositoryPath: string;
  repositoryRevision: string;
}): DelegatedTaskResultV1 {
  const requirements = [createDelegatedRequirement("R1", "artifact", "answer")];
  const request = createDelegatedRequest(requirements, input.outcome);
  return projectDelegatedTaskFulfillment({
    taskId: input.taskId,
    request,
    repository: {
      identitySha256: createHash("sha256").update(input.repositoryPath).digest("hex"),
      revision: input.repositoryRevision,
    },
    originalRequirements: requirements,
    planRequirementIds: requirements.map((requirement) => requirement.id),
    stopReason: "failed",
    deliveryState: "not-requested",
    artifacts: [],
    checks: [],
    children: [],
    pendingQuestions: [],
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
      turns: 0,
    },
  });
}

function finishedStateForProjectedIdentity(
  state: Parameters<typeof delegatedTaskStateBody>[0],
  projected: DelegatedTaskResultV1,
) {
  const requirements: DelegatedTaskRequirementInputV1[] = projected.requirements.map(
    (requirement) => ({
      id: requirement.id,
      kind: requirement.kind,
      originalSha256: requirement.originalSha256,
      targetLocator: requirement.targetLocator,
    }),
  );
  const planRequirementIds = requirements
    .map((requirement) => requirement.id)
    .sort(delegatedTaskStateContractKit.compare);
  return createDelegatedTaskState({
    ...delegatedTaskStateBody(state),
    request: projected.request,
    originalRequirements: requirements,
    planRequirementIds,
    planSha256: delegatedTaskPlanIdentitySha256(requirements, planRequirementIds),
  });
}

function projectDelegatedDriverResult(input: {
  taskId: string;
  outcome: string;
  retainedRequestSha256?: string;
  repositoryPath: string;
  repositoryRevision: string;
  driverResult: DelegatedTaskDriverResult;
  requestedChecks: readonly DelegatedRequestedCheck[];
  checkEvidence: readonly DelegatedRequestedCheckEvidence[];
}): DelegatedTaskResultV1 {
  const reads = successfulDelegatedReads(input.driverResult, input.repositoryPath);
  const answerText = input.driverResult.answer.trim();
  const sourceBackedAnswer =
    input.driverResult.status === "completed" && answerText.length > 0 && reads.length > 0;
  const artifactRequirements =
    reads.length > 0
      ? [
          ...reads.map((read, index) =>
            createDelegatedRequirement(`R${String(index + 1)}`, "artifact", read.locator),
          ),
          createDelegatedRequirement(`R${String(reads.length + 1)}`, "artifact", "answer"),
        ]
      : [createDelegatedRequirement("R1", "artifact", "answer")];
  const checkRequirements = input.requestedChecks.map((check, index) =>
    createDelegatedRequirement(`C${String(index + 1)}`, "check", check.checkId),
  );
  const requirements = [...artifactRequirements, ...checkRequirements];
  const minted = createDelegatedRequest(requirements, input.outcome);
  const request = input.retainedRequestSha256
    ? { ...minted, requestSha256: input.retainedRequestSha256 }
    : minted;
  const repositoryIdentitySha256 = createHash("sha256").update(input.repositoryPath).digest("hex");
  const boundArtifacts = [
    ...reads.map((read, index) => ({
      evidenceId: `artifact:R${String(index + 1)}`,
      taskId: input.taskId,
      taskSha256: request.taskSha256,
      repositoryIdentitySha256,
      repositoryRevision: input.repositoryRevision,
      locator: read.locator,
      digestSha256: read.digestSha256,
      boundRequirementIds: [`R${String(index + 1)}`],
      persistence: "applied" as const,
      supportClass: "supported" as const,
    })),
    ...(sourceBackedAnswer
      ? [
          {
            evidenceId: `artifact:R${String(reads.length + 1)}`,
            taskId: input.taskId,
            taskSha256: request.taskSha256,
            repositoryIdentitySha256,
            repositoryRevision: input.repositoryRevision,
            locator: "answer",
            digestSha256: createHash("sha256").update(answerText).digest("hex"),
            boundRequirementIds: [`R${String(reads.length + 1)}`],
            persistence: "applied" as const,
            supportClass: "supported" as const,
          },
        ]
      : []),
  ];
  const boundChecks = input.requestedChecks.map((check, index) => {
    const evidence = input.checkEvidence.find((item) => item.checkId === check.checkId);
    return {
      evidenceId: `check:C${String(index + 1)}`,
      taskId: input.taskId,
      taskSha256: request.taskSha256,
      repositoryIdentitySha256,
      repositoryRevision: input.repositoryRevision,
      checkId: check.checkId,
      state: (evidence?.state ?? "not-run") as "passed" | "failed" | "not-run",
      receiptSha256: evidence?.receiptSha256 ?? null,
      boundRequirementIds: [`C${String(index + 1)}`],
    };
  });
  const stopReason = delegatedStopReason(input.driverResult);
  const children = input.driverResult.childWorkflows.flatMap((child) => {
    const workflow = asDelegatedChildWorkflow(child.workflow);
    if (!workflow) return [];
    return [
      {
        childId: child.id,
        taskId: input.taskId,
        taskSha256: request.taskSha256,
        repositoryIdentitySha256,
        repositoryRevision: input.repositoryRevision,
        workflow,
        status: asDelegatedChildStatus(child.status),
        failureCode: child.status === "failed" ? "workflow-failed" : null,
        formalQuality:
          child.status === "failed" ? ("failed" as const) : ("not-established" as const),
        attemptedRequirementIds: [] as const,
      },
    ];
  });
  return projectDelegatedTaskFulfillment({
    taskId: input.taskId,
    request,
    repository: {
      identitySha256: repositoryIdentitySha256,
      revision: input.repositoryRevision,
    },
    originalRequirements: requirements,
    planRequirementIds: requirements.map((requirement) => requirement.id),
    stopReason,
    deliveryState: "not-requested",
    artifacts: boundArtifacts,
    checks: boundChecks,
    children,
    pendingQuestions: [],
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
      turns: input.driverResult.transcript.filter((entry) => entry.kind === "tool-call").length,
    },
  });
}

function successfulDelegatedReads(
  result: DelegatedTaskDriverResult,
  repositoryPath: string,
): readonly { locator: string; digestSha256: string }[] {
  const reads: { locator: string; digestSha256: string }[] = [];
  const seen = new Set<string>();
  const usedResults = new Set<number>();
  for (let index = 0; index < result.transcript.length; index += 1) {
    const call = result.transcript[index]!;
    if (call.kind !== "tool-call" || !isDelegatedSourceTool(call.name)) continue;
    const locator = delegatedReadLocator(call.arguments, repositoryPath);
    if (!locator || seen.has(locator)) continue;
    let matched: { digestSha256: string } | undefined;
    for (let cursor = index + 1; cursor < result.transcript.length; cursor += 1) {
      if (usedResults.has(cursor)) continue;
      const entry = result.transcript[cursor]!;
      if (entry.kind !== "tool-result" || entry.name !== call.name) continue;
      usedResults.add(cursor);
      if (!entry.isError && entry.text?.trim()) {
        matched = {
          digestSha256: createHash("sha256").update(entry.text).digest("hex"),
        };
      }
      break;
    }
    if (!matched) continue;
    seen.add(locator);
    reads.push({ locator, digestSha256: matched.digestSha256 });
  }
  return reads;
}

function isDelegatedSourceTool(name: string): boolean {
  return name === "read" || name === "grep";
}

function delegatedReadLocator(value: unknown, repositoryPath: string): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return delegatedReadLocator(JSON.parse(trimmed) as unknown, repositoryPath);
      } catch {
        return undefined;
      }
    }
    return delegatedReadLocator({ path: trimmed }, repositoryPath);
  }
  if (!value || typeof value !== "object") return undefined;
  const record = value as { path?: unknown; file?: unknown; target?: unknown };
  const raw = [record.path, record.file, record.target].find(
    (candidate) => typeof candidate === "string" && candidate.trim() !== "",
  );
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  let path = raw.trim().replaceAll("\\", "/");
  if (isAbsolute(path)) {
    const relativePath = relative(repositoryPath, path);
    if (relativePath.startsWith(`..${sep}`) || relativePath === ".." || isAbsolute(relativePath)) {
      return undefined;
    }
    path = relativePath.replaceAll("\\", "/");
  }
  if (path.startsWith("./")) path = path.slice(2);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(path)) return undefined;
  return path;
}

/**
 * Each `--check` name must be an own string entry of the repository's root
 * `package.json` `scripts`, the file `npm run` reads in that directory.
 */
async function admitDelegatedChecks(
  repositoryPath: string,
  scripts: readonly string[],
): Promise<DelegatedRequestedCheck[]> {
  if (scripts.length === 0) return [];
  const declared = await readDeclaredScripts(join(repositoryPath, DELEGATED_CHECK_MANIFEST));
  return scripts.map((script) => {
    if (!Object.hasOwn(declared, script) || typeof declared[script] !== "string") {
      throw new DelegatedCheckOperatorError(
        "undeclared-script",
        `docsfab do --check ${script} names no script in ${DELEGATED_CHECK_MANIFEST} "scripts"; ${DELEGATED_CHECK_REMEDIATION}.`,
      );
    }
    return { checkId: delegatedCheckId(script), argv: ["npm", "run", script] };
  });
}

async function readDeclaredScripts(manifestPath: string): Promise<Record<string, unknown>> {
  const text = await readDelegatedManifest(manifestPath);
  let manifest: unknown;
  try {
    manifest = JSON.parse(text);
  } catch {
    // JSON.parse of a string fails only on syntax; shape errors are refused below.
    throw new DelegatedCheckOperatorError(
      "manifest-invalid",
      `docsfab do --check could not parse ${manifestPath} as JSON; fix the file, or drop every --check flag.`,
    );
  }
  const scripts = isPlainRecord(manifest) ? manifest.scripts : undefined;
  if (!isPlainRecord(manifest) || (scripts !== undefined && !isPlainRecord(scripts))) {
    throw new DelegatedCheckOperatorError(
      "manifest-invalid",
      `docsfab do --check needs ${manifestPath} to be a JSON object whose "scripts" is an object of names to commands.`,
    );
  }
  return scripts ?? {};
}

async function readDelegatedManifest(manifestPath: string): Promise<string> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    // No symlink: the bytes validated here are the repository's own manifest.
    handle = await open(manifestPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    // Only ENOENT is an absent manifest; a symlink (ELOOP) or any other open
    // failure is unreadable.
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new DelegatedCheckOperatorError(
        "manifest-missing",
        `docsfab do --check found no ${manifestPath}; add a package.json with "scripts" at the repository root, or drop every --check flag.`,
      );
    }
    throw new DelegatedCheckOperatorError(
      "manifest-unreadable",
      code === "ELOOP"
        ? `docsfab do --check refuses ${manifestPath} because it is a symlink; replace it with a regular file, or drop every --check flag.`
        : `docsfab do --check could not open ${manifestPath} (${String(code)}); make it a readable regular file, or drop every --check flag.`,
    );
  }
  try {
    if (!(await handle.stat()).isFile()) {
      throw new DelegatedCheckOperatorError(
        "manifest-unreadable",
        `docsfab do --check needs ${manifestPath} to be a regular file; replace it, or drop every --check flag.`,
      );
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A pause retains the checks its fresh run named. Resume grants only its own
 * `--check` flags, so each retained check must be named again or the task
 * would finish without running it.
 */
function assertRetainedChecksResupplied(
  retained: readonly DelegatedTaskRequirementInputV1[],
  requestedChecks: readonly DelegatedRequestedCheck[],
): void {
  const supplied = new Set(requestedChecks.map((check) => check.checkId));
  const missing = retained
    .filter((requirement) => requirement.kind === "check")
    .filter((requirement) => !supplied.has(requirement.targetLocator))
    .map(
      (requirement) => delegatedCheckScript(requirement.targetLocator) ?? requirement.targetLocator,
    );
  if (missing.length === 0) return;
  throw new DelegatedCheckOperatorError(
    "resume-check-not-resupplied",
    `docsfab do --resume needs the checks the paused task retained; add ${missing.map((script) => `--check ${script}`).join(" ")} to the resume command.`,
    missing,
  );
}

async function deriveDelegatedPauseTargets(
  outcome: string,
  repositoryPath: string,
): Promise<{ admittedLocators: readonly string[]; materialTargetLocator?: string }> {
  const candidates = new Set<string>();
  DELEGATED_PATH_TOKEN.lastIndex = 0;
  for (const match of outcome.matchAll(DELEGATED_PATH_TOKEN)) {
    const locator = normalizeDelegatedLocatorToken(match[1]!);
    if (locator) candidates.add(locator);
  }
  DELEGATED_MARKDOWN_TOKEN.lastIndex = 0;
  for (const match of outcome.matchAll(DELEGATED_MARKDOWN_TOKEN)) {
    const locator = normalizeDelegatedLocatorToken(match[1]!);
    if (locator) candidates.add(locator);
  }
  const admittedLocators: string[] = [];
  let materialTargetLocator: string | undefined;
  for (const locator of [...candidates].sort()) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(locator)) continue;
    const present = await pathExistsInRepository(repositoryPath, locator);
    if (present === "file") admittedLocators.push(locator);
    if (present === "missing" && materialTargetLocator === undefined) {
      materialTargetLocator = locator;
    }
  }
  if (materialTargetLocator !== undefined && admittedLocators.length === 0) {
    for (const fallback of ["README.md", "docs/index.md", "docs/reference.md"]) {
      if ((await pathExistsInRepository(repositoryPath, fallback)) === "file") {
        admittedLocators.push(fallback);
      }
    }
  }
  return {
    admittedLocators,
    ...(materialTargetLocator ? { materialTargetLocator } : {}),
  };
}

function normalizeDelegatedLocatorToken(raw: string): string | undefined {
  const locator = raw.replace(/[.,;:!?)]+$/u, "").replace(/\/$/u, "");
  return locator === "" ? undefined : locator;
}

async function pathExistsInRepository(
  repositoryPath: string,
  locator: string,
): Promise<"file" | "directory" | "missing"> {
  const target = resolve(join(repositoryPath, locator));
  const relativePath = relative(repositoryPath, target);
  if (
    relativePath.startsWith(`..${sep}`) ||
    relativePath === ".." ||
    relativePath.startsWith("/")
  ) {
    return "missing";
  }
  const entry = await lstat(target).catch(() => undefined);
  if (!entry || entry.isSymbolicLink()) return "missing";
  if (entry.isFile()) return "file";
  if (entry.isDirectory()) return "directory";
  return "missing";
}

function installDelegatedStopSignals(abort: AbortController | undefined): () => void {
  if (!abort) return () => undefined;
  const onStop = (): void => {
    abort.abort();
  };
  process.once("SIGTERM", onStop);
  process.once("SIGINT", onStop);
  return () => {
    process.off("SIGTERM", onStop);
    process.off("SIGINT", onStop);
  };
}

async function createDelegatedChildDispatch(
  config: DocsFabConfig,
  repositoryPath: string,
  signal: AbortSignal,
): Promise<{
  capabilities?: Awaited<ReturnType<typeof loadLiveAgentCapabilities>>;
  runChildWorkflow?: (input: RunDelegatedChildWorkflowInput) => Promise<LiveWorkflowRun>;
}> {
  // The pack, the skill crate's lock included, refuses with its own code
  // before the driver's first model call; the capability faults caught below
  // leave the driver without child runs.
  await admitQualityPack(config);
  let capabilities: Awaited<ReturnType<typeof loadLiveAgentCapabilities>> | undefined;
  try {
    capabilities = await loadLiveAgentCapabilities(config);
  } catch {
    return {};
  }
  return {
    capabilities,
    runChildWorkflow: async (input) => {
      const record = await executeRunRequest(
        {
          workflow: input.workflow,
          repositoryPath,
          revision: "HEAD",
          instruction: input.instruction,
          allowWrite: false,
          json: false,
          verbose: false,
          releaseGate: false,
          showScan: false,
        },
        config,
        { silent: true, signal: input.signal ?? signal },
      );
      if (!record || typeof record !== "object" || !("id" in record) || !("workflow" in record)) {
        throw new Error("Delegated child workflows require a run record from the existing runner.");
      }
      return record as LiveWorkflowRun;
    },
  };
}

async function runDelegatedRequestedChecks(
  input: DelegatedRequestedCheckRunInput,
): Promise<readonly DelegatedRequestedCheckEvidence[]> {
  const evidence: DelegatedRequestedCheckEvidence[] = [];
  for (const check of input.checks) {
    const result = await spawnDelegatedCheck(
      check.argv,
      input.repositoryPath,
      input.credentialEnvNames ?? [],
      input.signal,
    );
    if (!result) continue;
    evidence.push({
      checkId: check.checkId,
      state: result.exitCode === 0 ? "passed" : "failed",
      receiptSha256: createHash("sha256")
        .update(JSON.stringify({ checkId: check.checkId, exitCode: result.exitCode }))
        .digest("hex"),
    });
  }
  return evidence;
}

/** The variables the configuration names as holding the model and judge keys. */
function configuredCredentialEnvNames(config: DocsFabConfig | undefined): string[] {
  if (!config) return [];
  return [config.model.credentialEnv, config.judge?.credentialEnv].filter(
    (name): name is string => name !== undefined,
  );
}

function spawnDelegatedCheck(
  argv: readonly string[],
  cwd: string,
  credentialEnvNames: readonly string[],
  signal?: AbortSignal,
): Promise<{ exitCode: number } | undefined> {
  const [command, ...args] = argv;
  if (!command) return Promise.resolve(undefined);
  return new Promise((resolveCheck) => {
    const child = spawn(command, args, {
      cwd,
      env: delegatedCheckEnvironment(process.env, credentialEnvNames),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, DELEGATED_CHECK_TIMEOUT_MS);
    const onAbort = (): void => {
      child.kill("SIGTERM");
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolveCheck(undefined);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolveCheck({ exitCode: code ?? 1 });
    });
  });
}

/**
 * Classify from the driver's typed outcome, never from error prose: matching
 * words in `result.error` misattributes unrelated failures.
 */
function delegatedStopReason(
  result: DelegatedTaskDriverResult,
): DelegatedTaskResultV1["stopReason"] {
  if (result.status === "timed-out") return "deadline-exceeded";
  if (result.status === "completed") return "finished";
  if (result.status === "cancelled") return "cancelled";
  // Only a bound that ended the run is exhaustion. A `clamped` or `clipped`
  // bound let the task continue, so it must not change the stop reason, exit
  // intent, or next action, even on a crash that carries the flag.
  if (result.limitStop?.disposition === "stopped") return "budget-exhausted";
  return "failed";
}

function asDelegatedChildWorkflow(
  workflow: string,
):
  | "review-documentation"
  | "create-documentation"
  | "update-documentation"
  | "restructure-documentation"
  | undefined {
  if (
    workflow === "review-documentation" ||
    workflow === "create-documentation" ||
    workflow === "update-documentation" ||
    workflow === "restructure-documentation"
  ) {
    return workflow;
  }
  return undefined;
}

function asDelegatedChildStatus(
  status: string,
): "queued" | "running" | "needs-input" | "needs-human-decision" | "succeeded" | "failed" {
  if (
    status === "queued" ||
    status === "running" ||
    status === "needs-input" ||
    status === "needs-human-decision" ||
    status === "succeeded" ||
    status === "failed"
  ) {
    return status;
  }
  return "failed";
}
