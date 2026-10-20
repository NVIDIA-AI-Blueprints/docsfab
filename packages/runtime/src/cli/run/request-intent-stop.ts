// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The request interpretation step of a CLI or live-agent run, the record it
 * saves when it stops the run, and that stop's operator output.
 *
 * An admitted intent, and an advisory reading the run goes on with, are
 * recorded and shown; first-pass binding, targets and plan do not consume
 * them yet. A stop saves its own record here, never through the
 * knowledge-continuation stop, which needs first-pass snapshot artifacts.
 */
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { limit } from "../../config/limits.js";
import {
  isNonInferenceRuntimeConfig,
  ModelRuntimeRequiredOperatorError,
  type DocsFabConfig,
  type RunRuntimeConfig,
} from "../../config/runtime-loader.js";
import { OUTPUT_RULE_FAILURE_CLASSES } from "../../contracts/model-output.js";
import { failureClassification, type FailureClass } from "../../operator/failure-class.js";
import {
  RUN_FAILURE_CODE_CLASSES,
  classifyingRunStore,
  type RunFailureCode,
} from "../../operator/failure-classification.js";
import {
  buildRunResultV1,
  collectRunResultNextSteps,
  formatRunSummary,
  type RunSummaryContext,
} from "../../operator/index.js";
import type { RunRecord } from "../../records/contracts.js";
import type { ModelSlotSettingsV1 } from "../../config/model-settings.js";
import { runModelSettings } from "../../records/run-model-settings.js";
import { createIndexedFileRunStore } from "../../records/run-index-store.js";
import { listTrackedRepositoryEntries } from "../../repository/workspace/tracked-read.js";
import type { RepositoryWorkspace } from "../../repository/workspace/contracts.js";
import {
  buildRequestIntentPromptInventory,
  resolvePromptInventoryLimits,
} from "../../request-intent/interpret-inventory.js";
import { createRequestIntentModelPort } from "../../request-intent/interpret-model.js";
import {
  RUN_RECORD_REQUEST_INTENT_SCHEMA_VERSION,
  type RequestIntentNotRunReason,
  type RunRecordRequestIntentV1,
} from "../../request-intent/interpret-record.js";
import {
  declaredRequestIntentOperation,
  interpretRequest,
  REQUEST_INTENT_HOST_STOP_CODES,
  type InterpretationOutcome,
  type RequestIntentInterpreterPort,
} from "../../request-intent/interpret.js";
import { resolveRequestIntentLimits } from "../../request-intent/limits.js";
import type { WorkflowDefinition } from "../../workflow-contracts/contracts.js";
import type { RequestIntentPathScope } from "../../request-intent/contract.js";
import { plannedTargetCollisions } from "../../workflow-execution/authoring-workspace-host.js";
import { workflowWriteGrantedAtAdmission } from "../../workflow-execution/runner-admission.js";
import { emptyTools, emptyUsage } from "../../workflow-execution/runner-step.js";
import {
  DocumentationRootsOutsideWriteRootsError,
  firstPassDocumentationWriteRoots,
  preflightExplicitDocumentationWriteScope,
} from "../first-pass.js";
import type { DocumentationRootPolicy } from "../first-pass-support.js";
import type { CompositionRunRuntime } from "./composition-runtime.js";
import { serializeRunResultCliJson } from "./delivery.js";
import type { CliRunInvocation, RunRequestWithPublishProjection } from "./request.js";
import { createWorkspaceTrackedSourceReader } from "./source-acquisition.js";

/** The host codes this step records; each has a class in the run failure table. */
const HOST_STOP_CODES = REQUEST_INTENT_HOST_STOP_CODES satisfies readonly RunFailureCode[];

export type RequestInterpretationStep =
  /** Go on to the first step; `recorded` is undefined only when admission refuses first. */
  | { readonly kind: "continue"; readonly recorded: RunRecordRequestIntentV1 | undefined }
  | {
      readonly kind: "stop";
      readonly recorded: RunRecordRequestIntentV1;
      readonly status: "needs-input" | "failed";
      readonly exitCode: 1 | 2;
    };

/**
 * A continuation re-enters a run whose request was read when it first ran: a
 * loaded knowledge continuation, or an InputAsk resume from `do --continue`
 * or the live agent. A run id alone is not one.
 */
export function requestIntentContinuationReason(input: {
  readonly loadedContinuation: boolean;
  readonly request: Pick<RunRequestWithPublishProjection, "operatorInputResume">;
}): RequestIntentNotRunReason | undefined {
  if (input.loadedContinuation) return "knowledge-continuation";
  if (input.request.operatorInputResume !== undefined) return "operator-input-resume";
  return undefined;
}

/** The deadline for every call of one interpretation together. */
export function requestIntentDeadlineMs(compositionRuntime?: CompositionRunRuntime): number {
  const own = limit("requestIntent.interpretationTimeoutMs").value;
  const composition = compositionRuntime?.executionProfile.compositionPolicy?.timeoutMs;
  return composition === undefined ? own : Math.min(own, composition);
}

/**
 * Offline only for `PI_OFFLINE=1`, the value DocsFab's admission model call
 * also gates on. Live CI jobs and the dogfood host export `PI_OFFLINE=0` and
 * run completions; Pi reads mere presence only for its model catalog refresh.
 */
export function isRequestIntentOffline(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment.PI_OFFLINE === "1";
}

function notRun(
  outcome: "offline" | "not-applicable" | "continuation",
  reason: RequestIntentNotRunReason,
): RequestInterpretationStep {
  return {
    kind: "continue",
    recorded: {
      schemaVersion: RUN_RECORD_REQUEST_INTENT_SCHEMA_VERSION,
      admission: {
        outcome,
        code: null,
        location: null,
        reason,
        boundary: null,
        calls: [],
        clippedTitles: 0,
      },
      intent: null,
    },
  };
}

/**
 * A write root as `firstPassDocumentationWriteRoots` returns it, as a scope
 * entry: a directory root, `docs/`, stays a directory, and a file root, a page
 * the revision tracks as a regular file such as a package `README.md`, grants
 * that one page. A directory named like a page (`docs/api.md/`) stays a
 * directory, because only a tracked regular file becomes a file root.
 */
export function requestIntentRootScope(root: string): RequestIntentPathScope {
  return root.endsWith("/")
    ? { kind: "root", path: root.slice(0, -1) }
    : { kind: "file", path: root };
}

/**
 * Run the interpretation once, before first-pass binding, for every workflow
 * that declares an operation, read-only review included.
 */
export async function runRequestInterpretation(input: {
  readonly request: RunRequestWithPublishProjection;
  readonly loadedContinuation: boolean;
  readonly workflow: WorkflowDefinition;
  readonly workspace: RepositoryWorkspace;
  readonly config: RunRuntimeConfig;
  /** The tracked `.docsfab.json` `documentationRoots`, as preflight read them. */
  readonly documentationRoots: readonly string[] | undefined;
  /** The run's root policy, the one first-pass binding uses. */
  readonly documentationRootPolicy: DocumentationRootPolicy;
  /** The configured roots the revision tracks as regular files, as preflight listed them. */
  readonly documentationRootFiles?: readonly string[];
  readonly rstUpdatePaths?: readonly string[];
  readonly compositionRuntime?: CompositionRunRuntime;
  readonly port?: RequestIntentInterpreterPort;
  readonly signal?: AbortSignal;
}): Promise<RequestInterpretationStep> {
  const operation = declaredRequestIntentOperation(input.request.workflow);
  if (operation === undefined) return notRun("not-applicable", "workflow-without-operation");
  if (isNonInferenceRuntimeConfig(input.config)) {
    throw new ModelRuntimeRequiredOperatorError();
  }
  const instruction = input.request.instruction;
  if (instruction === undefined || instruction.trim().length === 0) {
    return notRun("not-applicable", "instruction-absent");
  }
  const continuation = requestIntentContinuationReason(input);
  if (continuation) return notRun("continuation", continuation);
  // Admission refuses this workflow without --allow-write from flags alone,
  // with its existing message; asking the model first would only spend a call.
  if (workflowWriteGrantedAtAdmission(input.workflow) && !input.request.allowWrite) {
    return { kind: "continue", recorded: undefined };
  }
  // The roots first-pass binding and plan admission resolve for this run,
  // resolved once so the prompt and admission read the same list.
  const trackedFiles = input.documentationRootFiles ?? [];
  const { roots, dropped } = firstPassDocumentationWriteRoots(
    input.documentationRoots,
    input.documentationRootPolicy,
    trackedFiles,
    input.rstUpdatePaths,
  );
  // A create always writes a new page, which only a directory root can hold,
  // so this run would stop on the same refusal at first pass; refuse it before
  // the model call. Every other operation asks the model: a reading that names
  // a page outside the roots gets this refusal after the call
  // (`droppedRootsConfigurationRefusal`), and plan admission checks the pages
  // the workflow chooses.
  const fileRoots = roots.filter((root) => !root.endsWith("/"));
  if (operation === "create" && roots.length === fileRoots.length) {
    throw new DocumentationRootsOutsideWriteRootsError(dropped, input.documentationRootPolicy, {
      trackedFiles,
      fileRoots,
    });
  }
  const entries = await listTrackedRepositoryEntries(input.workspace);
  await preflightExplicitDocumentationWriteScope({
    request: input.request,
    config: input.config,
    revision: input.workspace.revision,
    repositoryPaths: entries.flatMap((entry) =>
      entry.kind === "regular" && entry.path !== undefined ? [entry.path] : [],
    ),
    ...(input.documentationRoots ? { documentationRoots: input.documentationRoots } : {}),
    documentationRootPolicy: input.documentationRootPolicy,
    ...(input.documentationRootFiles
      ? { documentationRootFiles: input.documentationRootFiles }
      : {}),
    ...(input.rstUpdatePaths ? { rstUpdatePaths: input.rstUpdatePaths } : {}),
  });
  // An injected port always wins, so an offline test still exercises it.
  if (input.port === undefined && isRequestIntentOffline()) {
    return notRun("offline", "pi-offline");
  }
  const maxRetries = input.config.retryPolicy.maxRetries;
  const port =
    input.port ??
    createRequestIntentModelPort({
      config: input.config,
      workflow: input.request.workflow,
      repositoryRevision: input.workspace.revision,
      maxCalls: maxRetries + 1,
      ...(input.compositionRuntime ? { compositionRuntime: input.compositionRuntime } : {}),
    });
  const reader = createWorkspaceTrackedSourceReader(input.workspace);
  const promptInventory = await buildRequestIntentPromptInventory({
    entries,
    readTrackedBytes: (path, maxBytes) => reader.readTrackedBytes(path, maxBytes),
    docsRoots: roots,
    ...(operation === "update" && input.request.patchOnly && input.rstUpdatePaths
      ? { rstUpdatePaths: input.rstUpdatePaths }
      : {}),
    limits: resolvePromptInventoryLimits(),
  });
  const profile = (input.compositionRuntime?.executionProfile ?? input.config.model).profile;
  const rootScopes = roots.map((root) => requestIntentRootScope(root));
  const outcome = await interpretRequest({
    port,
    workflow: input.request.workflow,
    operation,
    instruction,
    promptInventory,
    admissionInventory: entries.flatMap((entry) => (entry.path === undefined ? [] : [entry.path])),
    documentationRoots: rootScopes,
    // The same roots whatever --allow-write says: the runner keeps its own
    // write-grant stop for a run without it.
    writeRoots: rootScopes,
    // No plan-free navigation reader ships yet, so a companion target is
    // corrected and re-asked; the prompt shows the model the empty set.
    navigationSet: [],
    // Before the run's first write, as the oracle requires. A local run has
    // no update grant to consult.
    existence: (paths) => plannedTargetCollisions(input.workspace, paths),
    limits: resolveRequestIntentLimits(),
    maxRetries,
    window: { maxInputTokens: profile.maxInputTokens, maxOutputTokens: profile.maxOutputTokens },
    deadlineMs: requestIntentDeadlineMs(input.compositionRuntime),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  const configurationFault = droppedRootsConfigurationRefusal(
    outcome,
    { roots, dropped },
    input.documentationRootPolicy,
    trackedFiles,
  );
  if (configurationFault) throw configurationFault;
  return requestInterpretationStep(outcome, promptInventory.clippedTitles);
}

/**
 * The configuration refusal for a reading admission refused against the
 * documentation roots, when `.docsfab.json` dropped every one: a `docs-root`
 * or `write-scope` refusal measured a named or new page against no root, so
 * the fault is the configuration, and the run stops as first pass stops such
 * a page, with `documentation-roots-outside-write-roots`. Undefined when a
 * root is left or none was dropped, for every other outcome, and for every
 * other boundary: the update grant and an internal segment no root decides.
 */
export function droppedRootsConfigurationRefusal(
  outcome: InterpretationOutcome,
  resolved: { readonly roots: readonly string[]; readonly dropped: readonly string[] },
  policy: DocumentationRootPolicy,
  /** The configured roots the revision tracks as regular files. */
  trackedFiles: readonly string[] = [],
): DocumentationRootsOutsideWriteRootsError | undefined {
  if (resolved.roots.length > 0 || resolved.dropped.length === 0) return undefined;
  if (outcome.outcome !== "refused") return undefined;
  const kind = outcome.boundary?.kind;
  if (kind !== "docs-root" && kind !== "write-scope") return undefined;
  return new DocumentationRootsOutsideWriteRootsError(resolved.dropped, policy, { trackedFiles });
}

/** The recorded field and the run disposition for one interpretation outcome. */
export function requestInterpretationStep(
  outcome: InterpretationOutcome,
  clippedTitles: number,
): RequestInterpretationStep {
  const admission = {
    outcome: outcome.outcome,
    code: "code" in outcome ? outcome.code : null,
    location: "at" in outcome ? outcome.at : null,
    reason: null,
    boundary: outcome.outcome === "refused" ? outcome.boundary : null,
    calls: outcome.calls,
    clippedTitles,
  };
  const intent = "intent" in outcome ? outcome.intent : null;
  const recorded: RunRecordRequestIntentV1 = {
    schemaVersion: RUN_RECORD_REQUEST_INTENT_SCHEMA_VERSION,
    admission,
    intent,
  };
  switch (outcome.outcome) {
    case "admitted":
    case "advisory":
      return { kind: "continue", recorded };
    case "question":
      return { kind: "stop", recorded, status: "needs-input", exitCode: 2 };
    case "refused":
    case "rejected":
    case "unavailable":
      return { kind: "stop", recorded, status: "failed", exitCode: 1 };
  }
}

function stopFailureClass(code: string): FailureClass {
  if ((HOST_STOP_CODES as readonly string[]).includes(code)) {
    return RUN_FAILURE_CODE_CLASSES[code as RunFailureCode];
  }
  return OUTPUT_RULE_FAILURE_CLASSES[code] ?? "unknown";
}

/** Save the record of a run the interpretation stopped before its first step. */
export async function persistRequestIntentStop(input: {
  readonly request: RunRequestWithPublishProjection;
  readonly config: DocsFabConfig;
  readonly workspace: RepositoryWorkspace;
  readonly step: Extract<RequestInterpretationStep, { kind: "stop" }>;
  /** The bound preset's settings; defaults to the loaded writing model's. */
  readonly modelSettings?: ModelSlotSettingsV1;
}): Promise<RunRecord> {
  const modelSettings = runModelSettings({
    // A stop recorded before any model was configured has no settings to show.
    writing: input.modelSettings ?? input.config.model?.modelSettings,
  });
  const code = input.step.recorded.admission.code!;
  const now = new Date().toISOString();
  const record: RunRecord = {
    schemaVersion: 2,
    id: input.request.runId ?? randomUUID(),
    workflow: input.request.workflow,
    repository: {
      sourcePath: input.workspace.sourcePath,
      requestedRevision: input.workspace.requestedRevision,
      revision: input.workspace.revision,
    },
    workspace: { strategy: "tracked-export", disposable: true },
    ...(input.request.instruction ? { instruction: input.request.instruction } : {}),
    ...(input.request.instructionContext
      ? { instructionContext: input.request.instructionContext }
      : {}),
    status: input.step.status,
    error: code,
    ...(input.step.status === "failed"
      ? { failure: failureClassification(stopFailureClass(code), "inference", code) }
      : {}),
    createdAt: now,
    completedAt: now,
    models: [],
    skills: [],
    usage: emptyUsage(),
    tools: emptyTools(),
    requestIntent: input.step.recorded,
    // The interpretation called the model, so its stop shows the settings it ran with.
    ...(modelSettings ? { modelSettings } : {}),
    steps: [],
  };
  await classifyingRunStore(createIndexedFileRunStore(input.config.stateDirectory)).save(record);
  return record;
}

/** Print a stopped interpretation's footer or `--json` envelope and set the exit code. */
export function reportRequestIntentStop(
  invocation: CliRunInvocation,
  record: RunRecord,
  exitCode: 1 | 2,
): RunRecord {
  const recordPath = resolve(invocation.config.stateDirectory, `${record.id}.json`);
  const json = invocation.options.json ?? invocation.request.json ?? false;
  const context: RunSummaryContext = {
    record,
    recordPath,
    exitCode,
    repositoryPath: invocation.request.repositoryPath,
    quiet: (invocation.options.quiet ?? invocation.request.quiet ?? false) && !json,
    tty: Boolean(process.stdout.isTTY),
  };
  if (json) {
    invocation.output.log(
      serializeRunResultCliJson(
        buildRunResultV1({
          record,
          recordPath,
          exitCode,
          repositoryPath: invocation.request.repositoryPath,
          nextSteps: collectRunResultNextSteps(context),
        }),
        record,
      ).trimEnd(),
    );
  } else {
    for (const line of formatRunSummary(context)) invocation.output.log(line);
  }
  process.exitCode = exitCode;
  return record;
}
