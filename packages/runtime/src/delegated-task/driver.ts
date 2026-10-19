// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Headless delegated-task driver: one outcome runs through shared Pi session
 * construction and confined host tools. The caller owns presentation and
 * process exit. Direct work does not fabricate a workflow RunRecord. Nested
 * budget settlement belongs to `execution/task-budget.ts`; this driver keeps no
 * second budget or scope store.
 */
import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import {
  OPERATIONAL_LIMIT_NAMES,
  clippedLimitStop,
  exceededLimitStop,
  formatOperationalLimitStop,
  type OperationalLimitBreachRule,
  type OperationalLimitName,
  type OperationalLimitStop,
  type OperationalLimitUnit,
} from "../config/limit-stop.js";
import { WORKFLOW_CANCELLED, assertWorkflowActive } from "../execution/cancellation.js";
import {
  assertTaskResultChangeAdmitted,
  type TaskResultChangeFactsV1,
} from "../execution/task-reconciliation.js";
import { createConfinedToolSet, type ConfinedToolSet } from "../harness/confined-tools.js";
import { createDocsFabResourceLoader, type PiAgentSession } from "../harness/pi-session.js";
import {
  createBoundedBeforeToolCall,
  type BoundedBeforeToolCall,
} from "../harness/pi-tool-confine.js";
import {
  createLiveAgentToolDefinitions,
  type LiveAgentCapabilities,
} from "../live-agent/capabilities.js";
import type { LiveWorkflowRun } from "../live-agent/workflow-delivery.js";
import {
  TurnGovernanceError,
  createModelConnection,
  type ModelConnection,
} from "../model/provider.js";
import type { ModelEndpointConfig } from "../model/configuration.js";
import type {
  InferenceEvidenceIdentity,
  InferenceTurnEvidence,
  ProgressEvent,
  RunRecord,
} from "../records/contracts.js";
import type { ReaderTaskContextHandoffV1 } from "../execution/task-context.js";
import type { WorkflowDefinition } from "../workflow-contracts/contracts.js";
import type { RunnableWorkflowName } from "../workflow-registry/catalog.js";
import {
  assertDelegatedTaskSessionLifetime,
  createDelegatedTaskSession,
  type CreateDelegatedTaskSessionInput,
  type DelegatedTaskSessionLifetime,
} from "./session.js";

export const DELEGATED_TASK_RESULT_KIND = "docsfab-delegated-task-result" as const;
export const DELEGATED_TASK_UNSUPPORTED_HOST =
  "Delegated task host mode or composition is unsupported.";
export const DELEGATED_TASK_LIMITS_ERROR =
  "Delegated task limits must be finite positive integers; missing, zero, negative, NaN, and Infinity fail closed.";

const SUPPORTED_HOST_MODES = new Set([undefined, "omitted"]);

/**
 * Coded identity of a wall-clock deadline stop, so a deadline never borrows
 * `WORKFLOW_CANCELLED`, which `isCancelled()` reads as the operator's abort.
 */
export const WORKFLOW_DEADLINE_EXCEEDED = "workflow-deadline-exceeded" as const;

export const DELEGATED_TASK_DEADLINE_REMEDIATION =
  "Raise the delegated task wall-clock limit for this run, or narrow the outcome so it finishes inside the configured budget.";

export const DELEGATED_TASK_TOOL_CALL_REMEDIATION =
  "Raise the delegated task tool-call limit for this run, or narrow the outcome so it needs fewer confined reads.";

export const DELEGATED_TASK_TURN_GOVERNANCE_REMEDIATION =
  "Raise the delegated task execution envelope for this run, or narrow the outcome so it fits the configured turn, tool-call and context budgets.";

/**
 * A deadline timer whose monotonic measurement is unusable. It is a failure,
 * never a cancellation or a deadline claim the measurement cannot support.
 */
export const DELEGATED_TASK_DEADLINE_CLOCK_ANOMALY =
  "Delegated task deadline timer could not measure the elapsed wall-clock time it waited; no deadline is claimed for this run.";

export type DelegatedTaskStatus = "completed" | "cancelled" | "failed" | "timed-out";

/** The delegated wall-clock stop, or `undefined` when the bound did not bind. */
export function delegatedTaskDeadlineStop(input: {
  configuredMs: number;
  elapsedMs: number;
}): OperationalLimitStop | undefined {
  return exceededLimitStop({
    limit: OPERATIONAL_LIMIT_NAMES.delegatedTaskTimeoutMs,
    unit: "ms",
    // The timer fires at `elapsed >= configured`, so equality is the bound binding.
    breach: "at-the-bound",
    configured: input.configuredMs,
    observed: input.elapsedMs,
    remediation: DELEGATED_TASK_DEADLINE_REMEDIATION,
  });
}

/**
 * The clip flag for the confined tool-call ceiling. A refused call returns a
 * block to the agent and the session keeps running, so this is `clipped`,
 * never `stopped`.
 */
export function delegatedTaskToolCallStop(input: {
  configuredCalls: number;
  blockedCalls: number;
}): OperationalLimitStop | undefined {
  if (input.blockedCalls <= 0) return undefined;
  return clippedLimitStop({
    limit: OPERATIONAL_LIMIT_NAMES.delegatedTaskMaxToolCalls,
    unit: "calls",
    configured: input.configuredCalls,
    attempted: input.configuredCalls + input.blockedCalls,
    remediation: DELEGATED_TASK_TOOL_CALL_REMEDIATION,
  });
}

interface GovernedBoundPair {
  limit: OperationalLimitName;
  unit: OperationalLimitUnit;
  /**
   * The governor's own comparison, so `exceededLimitStop` refuses evidence
   * exactly on a bound the governor would have admitted.
   */
  breach: OperationalLimitBreachRule;
  configured: number;
  observed: number;
}

/**
 * The input budget the governor compares against. Counting the reservation on
 * the observed side matches `stopReasonMatches` in one inequality and keeps the
 * pair non-negative when the reservation exceeds the cap.
 */
function governedInputBound(turn: InferenceTurnEvidence): GovernedBoundPair | undefined {
  if (turn.effectiveMaxInputTokens === undefined) return undefined;
  return {
    limit: OPERATIONAL_LIMIT_NAMES.modelEffectiveMaxInputTokens,
    unit: "tokens",
    breach: "past-the-bound",
    configured: turn.effectiveMaxInputTokens,
    observed: turn.reservedTokens + turn.estimatedInputTokens,
  };
}

function governedOutputBound(turn: InferenceTurnEvidence): GovernedBoundPair {
  return {
    limit: OPERATIONAL_LIMIT_NAMES.modelAvailableOutputTokens,
    unit: "tokens",
    breach: "past-the-bound",
    configured: turn.availableOutputTokens,
    observed: turn.requiredMinimumOutputTokens,
  };
}

/** The context budget in the governor's precedence: input cap, then output room. */
function governedBudgetBound(turn: InferenceTurnEvidence): GovernedBoundPair | undefined {
  const input = governedInputBound(turn);
  if (input && input.observed > input.configured) return input;
  const output = governedOutputBound(turn);
  return output.observed > output.configured ? output : input;
}

/**
 * Which bound the governor breached, from its closed `turn.reason` verdict
 * rather than a second copy of the numeric rule in `stopReasonMatches`.
 * `undefined` for a stop that is not a numeric bound, so the run stays a plain
 * failure.
 */
function governedBound(turn: InferenceTurnEvidence): GovernedBoundPair | undefined {
  // `TurnGovernanceError` itself defaults the same way.
  switch (turn.reason ?? "context-exhausted") {
    case "provider-turn-limit":
      if (turn.maxProviderTurns === undefined) return undefined;
      return {
        limit: OPERATIONAL_LIMIT_NAMES.delegatedTaskMaxProviderTurns,
        unit: "turns",
        // Evidence records `turn = providerTurns + 1` and the governor stops at
        // `providerTurns >= maxProviderTurns`, so a genuine stop carries
        // `turn > maxProviderTurns`; equality is a turn the governor admitted.
        breach: "past-the-bound",
        configured: turn.maxProviderTurns,
        observed: turn.turn,
      };
    case "tool-call-limit":
      if (turn.maxToolCalls === undefined) return undefined;
      return {
        limit: OPERATIONAL_LIMIT_NAMES.delegatedTaskMaxToolCalls,
        unit: "calls",
        breach: "past-the-bound",
        configured: turn.maxToolCalls,
        observed: turn.toolCalls,
      };
    case "output-authority-exhausted": {
      // The authority is exhausted when what remains is below one turn's floor,
      // so `configured` is the authority left, not the lease ceiling.
      const authority = turn.outputAuthority;
      if (authority === undefined) return undefined;
      return {
        limit: OPERATIONAL_LIMIT_NAMES.modelOutputTokenAuthority,
        unit: "tokens",
        // `remaining < floor` is strict; remaining equal to the floor affords a turn.
        breach: "past-the-bound",
        configured: Math.max(0, authority.maxOutputTokens - authority.cumulativeOutputTokens),
        observed: authority.floorOutputTokens,
      };
    }
    case "compaction-limit":
      if (turn.maxCompactions === undefined) return undefined;
      return {
        limit: OPERATIONAL_LIMIT_NAMES.delegatedTaskMaxCompactions,
        unit: "compactions",
        // The one inclusive arm: the governor stops at `compactions >= max`.
        breach: "at-the-bound",
        configured: turn.maxCompactions,
        observed: turn.compactions,
      };
    case "context-exhausted":
    case "compaction-ineffective":
      return governedBudgetBound(turn);
    default:
      // `evidence-preservation-required` has no numeric bound to name.
      return undefined;
  }
}

/**
 * The stop for DocsFab's turn governor, read from the governed turn evidence,
 * never the message. `exceededLimitStop` refuses a pair whose numbers cannot
 * support the verdict, so a contradictory record stays a plain failure.
 */
export function delegatedTaskTurnGovernanceStop(
  turn: InferenceTurnEvidence,
): OperationalLimitStop | undefined {
  const bound = governedBound(turn);
  if (bound === undefined) return undefined;
  return exceededLimitStop({
    limit: bound.limit,
    unit: bound.unit,
    breach: bound.breach,
    configured: bound.configured,
    observed: bound.observed,
    remediation: DELEGATED_TASK_TURN_GOVERNANCE_REMEDIATION,
  });
}

/** Structural, not nominal: the governed turn is the evidence, never the message. */
function governedTurnEvidence(error: unknown): InferenceTurnEvidence | undefined {
  if (error instanceof TurnGovernanceError) return error.turn;
  if (!(error instanceof Error) || error.name !== "TurnGovernanceError") return undefined;
  const turn = (error as { turn?: unknown }).turn;
  return turn && typeof turn === "object" ? (turn as InferenceTurnEvidence) : undefined;
}

export class DelegatedTaskDeadlineExceededError extends Error {
  public readonly code = WORKFLOW_DEADLINE_EXCEEDED;

  public constructor(public readonly limitStop: OperationalLimitStop) {
    super(formatOperationalLimitStop(limitStop));
    this.name = "DelegatedTaskDeadlineExceededError";
  }
}

export interface DelegatedTaskLimits {
  readonly maxProviderTurns: number;
  readonly maxToolCalls: number;
  readonly timeoutMs: number;
}

export interface DelegatedTaskHostSelection {
  readonly mode?: string;
  readonly composition?: string;
}

export interface DelegatedTaskRepositoryIdentity {
  readonly canonicalPath: string;
  readonly revision: string;
}

export interface DelegatedTaskPresentation {
  readonly onText?: (text: string) => void;
}

export interface DelegatedToolTranscriptEntry {
  readonly kind: "tool-call" | "tool-result";
  readonly name: string;
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly afterTaskStart?: boolean;
  readonly arguments?: unknown;
  readonly text?: string;
  readonly isError?: boolean;
}

export interface DelegatedChildWorkflowRef {
  readonly id: string;
  readonly workflow: string;
  readonly status: string;
}

export interface DelegatedTaskResult {
  readonly kind: typeof DELEGATED_TASK_RESULT_KIND;
  readonly status: DelegatedTaskStatus;
  readonly answer: string;
  readonly transcript: readonly DelegatedToolTranscriptEntry[];
  readonly childWorkflows: readonly DelegatedChildWorkflowRef[];
  readonly error?: string;
  /** Present only for a wall-clock deadline; operator abort stays `cancelled` with no code. */
  readonly code?: typeof WORKFLOW_DEADLINE_EXCEEDED;
  /** Present only when one of DocsFab's own bounds stopped or clipped the task. */
  readonly limitStop?: OperationalLimitStop;
}

export type DelegatedToolExecute = ConfinedToolSet["definitions"][number]["execute"];

export interface RunDelegatedChildWorkflowInput {
  readonly workflow: RunnableWorkflowName;
  readonly instruction: string;
  readonly onProgress?: (event: ProgressEvent, workflow: WorkflowDefinition) => void;
  readonly signal?: AbortSignal;
  readonly readerTaskContext?: ReaderTaskContextHandoffV1;
}

export interface RunDelegatedTaskInput {
  readonly outcome: string;
  readonly repositoryPath: string;
  readonly repositoryIdentity: DelegatedTaskRepositoryIdentity;
  readonly sessionLifetime: DelegatedTaskSessionLifetime;
  readonly limits: DelegatedTaskLimits | undefined;
  readonly signal?: AbortSignal;
  readonly host?: DelegatedTaskHostSelection;
  readonly capabilities?: LiveAgentCapabilities;
  readonly presentation?: DelegatedTaskPresentation;
  readonly model?: ModelEndpointConfig;
  readonly connection?: ModelConnection;
  readonly agentDir?: string;
  readonly runChildWorkflow?: (input: RunDelegatedChildWorkflowInput) => Promise<LiveWorkflowRun>;
  readonly persistChildRun?: (record: RunRecord) => Promise<void>;
  readonly wrapToolExecute?: (name: string, execute: DelegatedToolExecute) => DelegatedToolExecute;
  /**
   * Facts for the result-change guard. Cancellation still comes from `signal`;
   * omitted facts admit ordinary dispatch.
   */
  readonly resultChange?: TaskResultChangeFactsV1;
  readonly createConnection?: (
    model: ModelEndpointConfig,
    limits: DelegatedTaskLimits,
    identity: InferenceEvidenceIdentity,
    signal?: AbortSignal,
  ) => Promise<ModelConnection>;
  readonly createConfinedToolSet?: typeof createConfinedToolSet;
  readonly createSession?: (input: CreateDelegatedTaskSessionInput) => Promise<PiAgentSession>;
}

export function assertDelegatedHostSelection(host?: DelegatedTaskHostSelection): void {
  if (!SUPPORTED_HOST_MODES.has(host?.mode)) {
    throw new Error(DELEGATED_TASK_UNSUPPORTED_HOST);
  }
  if (host?.composition !== undefined && host.composition !== "") {
    throw new Error(DELEGATED_TASK_UNSUPPORTED_HOST);
  }
}

export function assertDelegatedTaskLimits(
  limits: DelegatedTaskLimits | undefined,
): asserts limits is DelegatedTaskLimits {
  if (limits === undefined || typeof limits !== "object") {
    throw new Error(DELEGATED_TASK_LIMITS_ERROR);
  }
  requirePositiveSafeInteger(limits.maxProviderTurns, "maxProviderTurns");
  requirePositiveSafeInteger(limits.maxToolCalls, "maxToolCalls");
  requirePositiveSafeInteger(limits.timeoutMs, "timeoutMs");
}

function requirePositiveSafeInteger(value: unknown, field: string): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isSafeInteger(value) ||
    value < 1
  ) {
    throw new Error(DELEGATED_TASK_LIMITS_ERROR);
  }
  return value;
}

function requireOutcome(outcome: string): string {
  if (typeof outcome !== "string" || outcome.trim() === "") {
    throw new Error("Delegated tasks require one original non-empty documentation outcome.");
  }
  return outcome;
}

function canonicalRepositoryPath(path: string): string {
  if (typeof path !== "string" || path.trim() === "" || !isAbsolute(path)) {
    throw new Error("Delegated tasks require an absolute canonical repository path.");
  }
  if (path.split(/[\\/]/u).includes("..")) {
    throw new Error("Delegated tasks require an absolute canonical repository path.");
  }
  return resolve(path);
}

function toolResultText(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) => {
      if (!block || typeof block !== "object") return [];
      const item = block as { type?: unknown; text?: unknown };
      return item.type === "text" && typeof item.text === "string" ? [item.text] : [];
    })
    .join("\n");
}

function whenAborted(signal?: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const fail = (): void => reject(new Error(WORKFLOW_CANCELLED));
    if (signal?.aborted) {
      fail();
      return;
    }
    signal?.addEventListener("abort", fail, { once: true });
  });
}

function bindDelegatedTools(
  definitions: ConfinedToolSet["definitions"],
  options: {
    signal?: AbortSignal;
    taskStartedAt: number;
    transcript: DelegatedToolTranscriptEntry[];
    wrapToolExecute?: RunDelegatedTaskInput["wrapToolExecute"];
  },
): ConfinedToolSet["definitions"] {
  return definitions.map((definition) => {
    const original: DelegatedToolExecute = definition.execute.bind(definition);
    return {
      ...definition,
      execute: async (...args: Parameters<DelegatedToolExecute>) => {
        const [, params, signal] = args;
        assertWorkflowActive(options.signal);
        assertWorkflowActive(signal);
        const startedAt = Date.now();
        options.transcript.push({
          kind: "tool-call",
          name: definition.name,
          arguments: params,
          startedAt,
          afterTaskStart: startedAt >= options.taskStartedAt,
        });
        const execute = options.wrapToolExecute
          ? options.wrapToolExecute(definition.name, original)
          : original;
        try {
          const result = await Promise.race([
            execute(...args),
            whenAborted(options.signal),
            whenAborted(signal),
          ]);
          options.transcript.push({
            kind: "tool-result",
            name: definition.name,
            isError: false,
            text: toolResultText(result),
            endedAt: Date.now(),
          });
          return result;
        } catch (error) {
          options.transcript.push({
            kind: "tool-result",
            name: definition.name,
            isError: true,
            text: error instanceof Error ? error.message : "tool failed",
            endedAt: Date.now(),
          });
          throw error;
        }
      },
    };
  });
}

async function defaultCreateConnection(
  model: ModelEndpointConfig,
  limits: DelegatedTaskLimits,
  identity: InferenceEvidenceIdentity,
  signal?: AbortSignal,
): Promise<ModelConnection> {
  return createModelConnection(model, {
    evidenceIdentity: identity,
    limits: {
      maxProviderTurns: limits.maxProviderTurns,
      maxToolCalls: limits.maxToolCalls,
    },
    beforeProviderTurn: () => {
      assertWorkflowActive(signal);
    },
  });
}

function isCancelled(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return error instanceof Error && error.message === WORKFLOW_CANCELLED;
}

/**
 * Run one finite headless delegated documentation task and return after the
 * session stops, cancellation/teardown completes, and retained evidence is
 * collected. Does not write a `You:` prompt or set `process.exitCode`.
 */
export async function runDelegatedTask(input: RunDelegatedTaskInput): Promise<DelegatedTaskResult> {
  assertDelegatedTaskSessionLifetime(input.sessionLifetime);
  assertDelegatedHostSelection(input.host);
  assertDelegatedTaskLimits(input.limits);
  const outcome = requireOutcome(input.outcome);
  const repositoryPath = canonicalRepositoryPath(input.repositoryPath);
  const identityPath = canonicalRepositoryPath(input.repositoryIdentity.canonicalPath);
  if (repositoryPath !== identityPath) {
    throw new Error("Delegated task repository identity does not match the selected repository.");
  }
  if (
    typeof input.repositoryIdentity.revision !== "string" ||
    input.repositoryIdentity.revision.trim() === ""
  ) {
    throw new Error("Delegated tasks require a canonical repository revision identifier.");
  }

  const limits = input.limits;
  const transcript: DelegatedToolTranscriptEntry[] = [];
  const childWorkflows: DelegatedChildWorkflowRef[] = [];
  const taskStartedAt = Date.now();
  // Transcript timestamps use the wall clock to match other evidence; the
  // deadline uses a monotonic clock because a wall-clock read can step back.
  const deadlineStartedAt = performance.now();
  let session: PiAgentSession | undefined;
  let timeout: NodeJS.Timeout | undefined;
  let answer = "";
  let deadlineStop: OperationalLimitStop | undefined;
  let boundedToolCalls: BoundedBeforeToolCall | undefined;
  const toolCallStop = (): OperationalLimitStop | undefined =>
    delegatedTaskToolCallStop({
      configuredCalls: limits.maxToolCalls,
      blockedCalls: boundedToolCalls?.governanceStops() ?? 0,
    });
  const cancelSession = (): void => {
    session?.abort().catch(() => {
      // Settled prompt reports cancellation; do not expose an arbitrary abort reason.
    });
  };

  try {
    const repository = await stat(repositoryPath);
    if (!repository.isDirectory()) {
      throw new Error("Delegated tasks require an existing local repository directory.");
    }
    assertWorkflowActive(input.signal);

    const createTools = input.createConfinedToolSet ?? createConfinedToolSet;
    const confined = await createTools({
      workspacePath: repositoryPath,
      allowWrite: false,
      readTextRendering: "source-coordinates",
    });
    const liveTools =
      input.capabilities === undefined
        ? []
        : createLiveAgentToolDefinitions({
            capabilities: input.capabilities,
            allowWrite: false,
            resultChange: input.resultChange,
            runWorkflow: async (workflow, instruction, onProgress, signal, readerTaskContext) => {
              if (!input.runChildWorkflow) {
                throw new Error(
                  "Delegated child workflows require the existing runner supplied by the caller.",
                );
              }
              assertWorkflowActive(input.signal);
              assertWorkflowActive(signal);
              assertTaskResultChangeAdmitted(
                { signal: input.signal ?? signal, ...input.resultChange },
                { kind: "dispatch-child-workflow" },
              );
              const record = await input.runChildWorkflow({
                workflow,
                instruction,
                onProgress,
                signal,
                readerTaskContext,
              });
              childWorkflows.push({
                id: record.id,
                workflow: record.workflow,
                status: record.status,
              });
              await input.persistChildRun?.(record);
              return record;
            },
          });
    const definitions = bindDelegatedTools([...confined.definitions, ...liveTools], {
      signal: input.signal,
      taskStartedAt,
      transcript,
      wrapToolExecute: input.wrapToolExecute,
    });

    const resourceLoader = createDocsFabResourceLoader({
      repositoryPath,
      mode: "read-only",
      ...(input.agentDir ? { agentDir: input.agentDir } : {}),
      // No Pi skills: Pi lists them by absolute path. `docsfab_use_skill` serves them.
      additionalSystemPrompt: [
        "This is one finite headless delegated documentation task. Complete the original outcome.",
        "Use confined repository tools for evidence. Do not treat conversation memory as canonical repository evidence.",
        "Session lifetime is not a grant. Do not request file changes in this read-only task.",
        ...(input.capabilities
          ? [
              `Installed skills: ${input.capabilities.skills.map((skill) => skill.lock.id).join(", ") || "none"}.`,
              `Installed workflows: ${input.capabilities.workflows.map((workflow) => workflow.name).join(", ") || "none"}.`,
            ]
          : []),
      ],
    });
    await resourceLoader.reload();

    const connection =
      input.connection ??
      (await (input.createConnection ?? defaultCreateConnection)(
        input.model ??
          (() => {
            throw new Error(
              "Delegated tasks require a model connection or endpoint configuration.",
            );
          })(),
        limits,
        { repositoryRevision: input.repositoryIdentity.revision },
        input.signal,
      ));
    const createSession = input.createSession ?? createDelegatedTaskSession;
    session = await createSession({
      repositoryPath,
      connection,
      resourceLoader,
      confinedToolDefinitions: definitions,
      lifetime: input.sessionLifetime,
    });
    boundedToolCalls = createBoundedBeforeToolCall(
      session.agent.beforeToolCall,
      limits.maxToolCalls,
    );
    session.agent.beforeToolCall = boundedToolCalls;
    input.signal?.addEventListener("abort", cancelSession, { once: true });
    session.subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
        const text = event.assistantMessageEvent.delta;
        answer += text;
        input.presentation?.onText?.(text);
      }
    });

    const timedOut = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        // Guarded: this callback runs outside the enclosing `try`, so a throw
        // would escape as an `uncaughtException` with no result document.
        try {
          const stop = delegatedTaskDeadlineStop({
            configuredMs: limits.timeoutMs,
            elapsedMs: Math.max(0, Math.round(performance.now() - deadlineStartedAt)),
          });
          deadlineStop = stop;
          cancelSession();
          reject(
            stop
              ? new DelegatedTaskDeadlineExceededError(stop)
              : new Error(DELEGATED_TASK_DEADLINE_CLOCK_ANOMALY),
          );
        } catch {
          deadlineStop = undefined;
          cancelSession();
          reject(new Error(DELEGATED_TASK_DEADLINE_CLOCK_ANOMALY));
        }
      }, limits.timeoutMs);
    });
    await Promise.race([session.prompt(outcome), whenAborted(input.signal), timedOut]);
    const clipped = toolCallStop();
    return {
      kind: DELEGATED_TASK_RESULT_KIND,
      status: "completed",
      answer,
      transcript: [...transcript],
      childWorkflows: [...childWorkflows],
      ...(clipped ? { limitStop: clipped } : {}),
    };
  } catch (error) {
    // A fired deadline classifies from the timer's typed stop, not the race
    // winner: aborting the session can surface a cancellation error afterwards.
    const timedOutByDeadline =
      error instanceof DelegatedTaskDeadlineExceededError ||
      (deadlineStop !== undefined && !input.signal?.aborted);
    // Only the turn governor and the deadline end a run at a bound. The result
    // carries one bound, so an ending bound replaces the tool-call clip. A clip
    // is reported otherwise, even on a crash, and never as a stop.
    const governed = timedOutByDeadline ? undefined : governedTurnEvidence(error);
    const governanceStop = governed ? delegatedTaskTurnGovernanceStop(governed) : undefined;
    const limitStop = timedOutByDeadline ? deadlineStop : (governanceStop ?? toolCallStop());
    const status: DelegatedTaskStatus = timedOutByDeadline
      ? "timed-out"
      : isCancelled(error, input.signal)
        ? "cancelled"
        : "failed";
    const message =
      timedOutByDeadline && deadlineStop
        ? formatOperationalLimitStop(deadlineStop)
        : error instanceof Error
          ? error.message
          : "Delegated task failed.";
    return {
      kind: DELEGATED_TASK_RESULT_KIND,
      status,
      answer,
      transcript: [...transcript],
      childWorkflows: [...childWorkflows],
      error: message,
      ...(timedOutByDeadline && deadlineStop ? { code: WORKFLOW_DEADLINE_EXCEEDED } : {}),
      ...(limitStop ? { limitStop } : {}),
    };
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    input.signal?.removeEventListener("abort", cancelSession);
    if (session) {
      try {
        await session.abort().catch(() => undefined);
      } finally {
        session.dispose();
      }
    }
  }
}
