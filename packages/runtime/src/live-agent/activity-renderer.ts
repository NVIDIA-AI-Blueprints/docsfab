// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { sourceObligationFailureReason } from "../workflow-execution/source-obligation.js";
import { FIRST_PASS_CHOICE_CONTINUATION_MESSAGES } from "../cli/run/first-pass-choice-continuation.js";
import { invocationFailureReason } from "./invocation-bindings.js";
import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
  editorialInputAskPresentationV1,
  type EditorialInputAskFillKindV1,
} from "../artifacts/editorial-input-ask.js";
import { editorialInputAskSlots } from "../inputs/operator-input-fill.js";
import { classifyModelFailure } from "../model/context-budget.js";
import {
  describeFailureClassification,
  readFailureClassification,
  type FailureClassificationV1,
} from "../operator/failure-class.js";
import { SAVED_RUN_FAILURES } from "./saved-run-tool.js";
import {
  QUALITY_REPORT_FAILURES,
  QualityReportProjectionError,
} from "../evaluation-report/index.js";
import { QUALITY_ARTIFACT_FAILURES } from "../evaluation-report/quality-validator-host.js";
import { LiveAgentChatRenderer } from "./chat-renderer.js";
import { providerFailureReason, providerRetryLabel } from "./provider-failure.js";
import type { ProviderRetryNotice } from "../model/provider.js";
import type { ProviderErrorTelemetryV1 } from "../records/contracts.js";
import { LOCAL_REVIEW_SCOPE_FAILURES } from "../workflow-execution/local-review-scope.js";
import { DOCUMENTATION_PLAN_FAILURES } from "../workflow-execution/plan-binding.js";
import { GITLAB_READ_FAILURES } from "./gitlab-read.js";
import { LIVE_DELIVERY_FAILURES, livePublicationFailure } from "./workflow-delivery.js";
import { isCommandProcessStopRefusal, LIVE_COMMAND_FAILURES } from "./command-tool.js";
import { TASK_BRANCH_FAILURES } from "./branch-preparation.js";
import {
  LIVE_WORKFLOW_FAILURE_GATE_MESSAGES,
  LIVE_WORKFLOW_REQUEST_FAILURES,
  liveWorkflowScopeBoundStop,
  SCOPE_BOUND_NEXT,
} from "./workflow-failure-gate.js";
import { LIVE_SKILL_FAILURES } from "./skill-references.js";
import { LIVE_REVIEW_TARGET_FAILURES } from "./review-target.js";
import {
  DOCUMENTATION_WORK_PREREQUISITE_ACTION,
  type DocumentationWorkPrerequisiteActivity,
} from "./documentation-work-state.js";
import {
  LIVE_KNOWLEDGE_STOP_DIAGNOSTICS,
  LIVE_KNOWLEDGE_STOP_NOT_RETAINED,
  LIVE_KNOWLEDGE_STOP_NOT_RETAINED_DETAIL,
  isLiveKnowledgeStopReason,
} from "./capabilities.js";
import {
  knowledgeResumeNeedsInputMessage,
  type KnowledgeResumeStopReason,
} from "../cli/knowledge-resume.js";
import { SAFE_RECORD_ID } from "../records/file-store.js";
import { isRecordableEvidenceWarning } from "../records/evidence-warnings.js";
import { proposalScopeFailureCode } from "../init/first-run-bootstrap.js";
import {
  classifyProposalScopeFailure,
  firstPassFailureFromMessage,
  preRecordFailureIdentity,
  renderPreRecordFailure,
  type PreRecordFailureClassV1,
} from "../operator/pre-record-failure.js";

interface Activity {
  label: string;
  started: number;
}

export interface LiveAgentInputAskSlotV1 {
  readonly inputId: string;
  readonly label: string;
  readonly why: string;
  readonly fillKind: EditorialInputAskFillKindV1;
}

/** Catalog-only InputAsk projection. Never prints paths, hashes, or credentials. */
export function projectLiveAgentInputAskSlots(
  inputIds: readonly string[],
): readonly LiveAgentInputAskSlotV1[] {
  const slots: LiveAgentInputAskSlotV1[] = [];
  const seen = new Set<string>();
  for (const inputId of inputIds) {
    if (seen.has(inputId)) continue;
    const presentation = editorialInputAskPresentationV1(inputId);
    if (!presentation) continue;
    seen.add(inputId);
    slots.push({
      inputId,
      label: presentation.label,
      why: presentation.why,
      fillKind: presentation.fillKind,
    });
  }
  return Object.freeze(slots);
}

export function liveAgentInputAskSlotsFromRecord(
  record: unknown,
): readonly LiveAgentInputAskSlotV1[] {
  return projectLiveAgentInputAskSlots(editorialInputAskSlots(record).map((slot) => slot.inputId));
}

export function liveAgentInputAskSlotsFromWorkflowDetails(
  details: unknown,
  inputAskInputIdsForRun?: (runId: string) => readonly string[] | undefined,
): readonly LiveAgentInputAskSlotV1[] {
  const ids: string[] = [];
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return projectLiveAgentInputAskSlots(ids);
  }
  const root = details as {
    inputAskSlots?: unknown;
    runId?: unknown;
    status?: unknown;
    workflowStatus?: unknown;
    workflow?: unknown;
    workflowOutcome?: unknown;
  };
  if (Array.isArray(root.inputAskSlots)) {
    for (const item of root.inputAskSlots) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const inputId = (item as { inputId?: unknown }).inputId;
      if (typeof inputId === "string") ids.push(inputId);
    }
  }
  ids.push(...editorialInputAskSlots(details).map((slot) => slot.inputId));
  if (root.workflowOutcome !== undefined) {
    ids.push(
      ...editorialInputAskSlots({
        status: root.workflowStatus ?? root.status,
        workflow: root.workflow,
        workflowOutcome: root.workflowOutcome,
      }).map((slot) => slot.inputId),
    );
  }
  if (typeof root.runId === "string") {
    const remembered = inputAskInputIdsForRun?.(root.runId);
    if (remembered) ids.push(...remembered);
  }
  return projectLiveAgentInputAskSlots(ids);
}

export function renderLiveAgentInputAskSlots(
  slots: readonly LiveAgentInputAskSlotV1[],
): string | undefined {
  if (slots.length === 0) return undefined;
  return [
    "Named InputAsk slots are open. The next message in this conversation fills them and continues the same run when the workspace snapshot still matches.",
    ...slots.map((slot) => `- ${slot.label} (${slot.inputId}; ${slot.fillKind}): ${slot.why}`),
  ].join("\n");
}

export function renderLiveAgentInputAskResume(plan: {
  readonly originalRunId: string;
  readonly fills: readonly { readonly inputId: string }[];
  readonly skipPlanner: boolean;
}): string {
  const fills = plan.fills.map((fill) => fill.inputId).join(", ");
  const resume = plan.skipPlanner
    ? "Workspace snapshot still matches; planner and search observe are skipped."
    : "Workspace snapshot or planBinding changed; planner and search observe revalidate.";
  return `Continuing editorial run ${plan.originalRunId} with InputAsk fills: ${fills}.\n${resume}\n`;
}

// Fixed host messages can be displayed verbatim. Provider payloads cannot.
const SETUP_REASONS = new Set([
  ...FIRST_PASS_CHOICE_CONTINUATION_MESSAGES,
  ...Object.values(DOCUMENTATION_PLAN_FAILURES),
  ...Object.values(LOCAL_REVIEW_SCOPE_FAILURES),
  ...Object.values(GITLAB_READ_FAILURES),
  ...Object.values(LIVE_DELIVERY_FAILURES),
  ...Object.values(LIVE_COMMAND_FAILURES),
  ...Object.values(TASK_BRANCH_FAILURES),
  ...Object.values(LIVE_WORKFLOW_FAILURE_GATE_MESSAGES),
  ...Object.values(LIVE_WORKFLOW_REQUEST_FAILURES),
  ...Object.values(LIVE_SKILL_FAILURES),
  ...Object.values(LIVE_REVIEW_TARGET_FAILURES),
  "The canonical Git remote is not one supported uncredentialed GitLab remote.",
  "More than one GitLab remote was found. Re-run with --remote <name>.",
  "The GitLab default branch could not be discovered. Authenticate glab or set the remote HEAD.",
  "The selected repository directory is unavailable.",
  "Git remotes could not be inspected.",
  "DocsFab live-agent received no run record from the completed bounded workflow.",
  "Model returned a blank response.",
  "A provider tool batch ended without exact terminal settlement.",
  "Planner response must be one exact JSON object envelope.",
  "Planner response summary must be non-empty bounded text.",
]);

/**
 * The typed identity of a stop raised before any workflow RunRecord.
 *
 * The tool boundary keeps only the message, so this exactly matches the
 * first-pass stop sentence or a proposal-scope refusal, fixed or in an exact
 * form that names pages; a decorated variant is not projected.
 */
export function preRecordFailure(error: unknown): PreRecordFailureClassV1 | undefined {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const firstPass = firstPassFailureFromMessage(message);
  if (firstPass) return firstPass;
  const scopeCode = proposalScopeFailureCode(message);
  return scopeCode === undefined ? undefined : classifyProposalScopeFailure(scopeCode, message);
}

/** Exact-match inverse of the adapter's coded pre-record diagnostics. */
const KNOWLEDGE_STOP_DIAGNOSTIC_REASONS: ReadonlyMap<string, KnowledgeResumeStopReason> = new Map(
  Object.entries(LIVE_KNOWLEDGE_STOP_DIAGNOSTICS).map(([reason, diagnostic]) => [
    diagnostic,
    reason as KnowledgeResumeStopReason,
  ]),
);

/**
 * The operator's next step for a stop whose retained run can be continued.
 *
 * This is the validating `docsfab runs show` command, not a `--resume-from`
 * line: the terminal knows only the run id, not the snapshot path or authority
 * id, and `runs show` prints the parser-validated resume command itself.
 *
 * The command sits on its own line with no trailing punctuation, because a
 * period would fuse with the closing quote and become part of the authority id.
 * The run id is the only interpolated value, gated by `SAFE_RECORD_ID`.
 */
function knowledgeStopResumeCommand(runId: string): string {
  return (
    `docsfab runs show ${runId} --canon-snapshot '<attributed-snapshot.json>'` +
    " --accept-candidate-snapshot --authority-id '<accountable-authority-id>'"
  );
}

/**
 * Render one typed knowledge stop with a next action that is true right now.
 *
 * The category and recovery reuse `knowledgeResumeNeedsInputMessage` verbatim
 * so the terminal, model, and CLI share one wording; only the resumability
 * tail is this surface's own.
 */
export function renderLiveAgentKnowledgeStop(stop: {
  readonly reason: KnowledgeResumeStopReason;
  readonly recorded: boolean;
  readonly resumeRunId?: string;
}): string {
  const resumability =
    stop.resumeRunId === undefined
      ? stop.recorded
        ? "The saved run retains no continuation binding, so there is no resume command for this stop."
        : "No run record was saved, so there is no run id or resume command for this stop."
      : SAFE_RECORD_ID.test(stop.resumeRunId)
        ? `The stopped run ${stop.resumeRunId} retains this stop. Validate an attributed snapshot and print the exact resume command with\n${knowledgeStopResumeCommand(stop.resumeRunId)}`
        : // The run store would refuse to load this id.
          "The retained run id is not one this host can load, so no resume command is offered for this stop.";
  return `Workflow knowledge stop (${stop.reason}). ${knowledgeResumeNeedsInputMessage(stop.reason)} ${resumability}`;
}

/**
 * The sanitization boundary between a raw failure and a human-visible one.
 *
 * The hosted turn posts into a shared channel, so an arbitrary provider
 * message must never pass; anything outside the closed set is `undefined`.
 */
export function failureReason(
  error: unknown,
  workflowIds: readonly string[],
  provider?: { readonly error: ProviderErrorTelemetryV1; readonly attempts: number },
): string | undefined {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const invocationReason = invocationFailureReason(message);
  if (invocationReason) return invocationReason;
  // Before the source-obligation reasons: a scope stop is not a source fault.
  const scopeBound = liveWorkflowScopeBoundStop(message);
  if (scopeBound) {
    return `This review's scope is too large for one run: ${scopeBound.observedBytes} bytes exceed ${scopeBound.limitName} = ${scopeBound.limitBytes} bytes (${scopeBound.code}). ${SCOPE_BOUND_NEXT}`;
  }
  const inventoryReason = sourceObligationFailureReason(message);
  if (inventoryReason) return inventoryReason;
  // Exact match only: a loose match would put a wrapper's body on the terminal.
  const knowledgeStop = KNOWLEDGE_STOP_DIAGNOSTIC_REASONS.get(message);
  if (knowledgeStop) {
    return renderLiveAgentKnowledgeStop({ reason: knowledgeStop, recorded: false });
  }
  if (message === LIVE_KNOWLEDGE_STOP_NOT_RETAINED) {
    return `Workflow knowledge stop (not-retained). ${LIVE_KNOWLEDGE_STOP_NOT_RETAINED_DETAIL} No run record was saved, so there is no run id or resume command for this stop.`;
  }
  if (message === "Reader task admission observation rejected input: credential-material.") {
    return "DocsFab withheld the reader-evidence handoff because the request or a nominated source holds one of DocsFab's own configured credentials. This is credential screening, not an authentication failure. Remove the credential, and rotate it if it was committed; repeating the same handoff will not resolve it.";
  }
  if (
    /^Editorial assessment response rejected: (?:invalid-shape|invalid-value|credential-material|identity-mismatch|evidence-unavailable)\.$/u.test(
      message,
    ) ||
    message === "The independent editorial step returned a malformed assessment envelope." ||
    message === "Review response did not satisfy the host-owned structured contract."
  ) {
    return "The model's editorial assessment did not satisfy the workflow response contract. The workflow did not complete.";
  }
  if (
    /^Editorial evidence host rejected input: (?:invalid-shape|invalid-value|credential-material|identity-mismatch|evidence-unavailable|producer-mismatch|conflicting-assessment)\.$/u.test(
      message,
    )
  ) {
    return "Workflow evidence failed validation. Inspect the saved run for the failed step; the workflow did not complete.";
  }
  if (message === "DocsFab denied the requested tool path.") {
    return "The requested file is outside this tool's allowed repository paths.";
  }
  if (message === "DocsFab tool target is unavailable.") {
    return "The requested repository file or directory is unavailable.";
  }
  for (const code of ["missing-report", "invalid-report"] as const) {
    if (
      message === QUALITY_REPORT_FAILURES[code] ||
      message === new QualityReportProjectionError(code).message
    )
      return QUALITY_REPORT_FAILURES[code];
  }
  for (const [code, diagnostic] of Object.entries(QUALITY_ARTIFACT_FAILURES)) {
    if (message === `Quality artifact validation failed: ${code}.`) return diagnostic;
  }
  if (SETUP_REASONS.has(message) || isCommandProcessStopRefusal(message)) return message;
  // Every first-pass rule and proposal-scope refusal, not one regex per rule.
  const preRecord = preRecordFailure(message);
  if (preRecord) return renderPreRecordFailure(preRecord);
  if (Object.values(SAVED_RUN_FAILURES).some((safe) => safe === message)) return message;
  const publication = livePublicationFailure(error);
  if (publication) return publication;
  // Run errors can nest the host's governor diagnostic inside provider wrappers.
  // Extract only its enumerated reason and numeric limits, never the wrapper body.
  const budget =
    /(?:^|: )Provider turn stopped locally: reason=(tool-call-limit|provider-turn-limit) turn=\d{1,6} provider-turn-limit=(\d{1,6}) tool-calls=\d{1,6} tool-call-limit=(\d{1,6})(?: |$)/u.exec(
      message,
    );
  if (budget) {
    const kind = budget[1] === "tool-call-limit" ? "tool-call" : "model-turn";
    const limit = Number(budget[1] === "tool-call-limit" ? budget[3] : budget[2]);
    return `Workflow step reached its ${kind} limit (${limit}). The workflow did not complete; inspect the saved run before retrying.`;
  }
  // A step that completed at its ceiling records only the coded limit line
  // (`formatStepExecutionLimitStop`); read its enumerated ceiling and number.
  const ceiling =
    /(?:^| )[a-z][a-z0-9-]{0,62}[a-z0-9]: workflow step "[^"]{1,128}" (?:exceeded|used all of) its (tool-call|provider-turn) ceiling of (\d{1,6}) /u.exec(
      message,
    );
  if (ceiling) {
    const kind = ceiling[1] === "tool-call" ? "tool-call" : "model-turn";
    return `Workflow step reached its ${kind} limit (${Number(ceiling[2])}). The workflow did not complete; inspect the saved run before retrying.`;
  }
  if (message === "No supported uncredentialed GitLab remote is available for this operation.") {
    return "Workflow setup requires a supported GitLab remote; the workflow did not start. Local patch-only writes can run without one. Do not add a fabricated remote.";
  }
  if (
    workflowIds.some(
      (id) =>
        message ===
        `Workflow "${id}" can modify files. Re-run with --allow-write after reviewing the plan.`,
    )
  ) {
    return "Workflow writes are not enabled. Restart with --allow-write to authorize them.";
  }
  // A typed rate limit or credential refusal outranks the context text rule,
  // whose pattern also matches a per-minute token 429's body. Other classes
  // yield: some servers answer a context overflow with a 400 or a 500.
  const typed = provider && providerFailureReason(provider.error, provider.attempts);
  if (typed && (provider?.error.class === "rate-limit" || provider?.error.class === "auth")) {
    return typed;
  }
  if (
    /maximum context|context.{0,30}(?:length|window)|token.{0,20}(?:limit|budget)/iu.test(message)
  ) {
    return "Context budget exceeded. Shorten the request or start a new conversation with --new.";
  }
  // A sent request's typed status decides before any text rule below.
  if (typed) return typed;
  // SDK errors can prefix their private body with a bare HTTP status.
  const wrapped = /^Model request failed \[([a-z-]+); retryable=(?:true|false)\]: /u.exec(message);
  const status = /^(?:HTTP(?: status)?\s*[:=]?\s*)?(401|403|408|429|5\d\d)\b/iu.exec(
    wrapped ? message.slice(wrapped[0].length) : message,
  )?.[1];
  if (status === "401")
    return "Authentication failed (HTTP 401). Check the credentials for the failing service.";
  if (status === "403")
    return "Access was denied (HTTP 403). Check permissions for the failing service.";
  const category = status
    ? classifyModelFailure({ status: Number(status) }).category
    : (wrapped?.[1] ?? classifyModelFailure(error).category);
  switch (category) {
    case "context-exhausted":
      return "Context budget exceeded. Shorten the request or start a new conversation with --new.";
    case "timeout":
      return "The request timed out. Check service availability before retrying.";
    case "throttled":
      return "The service rate limit was reached. Wait before retrying.";
    case "provider-transient":
      return "The service is unavailable or the connection failed. Check connectivity before retrying.";
    case "invalid-request":
      return "The service rejected the request. Check the configured model and request settings.";
    case "malformed-response":
      return "The service returned an invalid response that DocsFab could not parse.";
    case "blank-response":
      return "The model returned no answer. Retry with a shorter request.";
    case "no-progress":
      return "The model kept calling tools without answering: it re-read unchanged content or used the step's whole tool-call allowance. Retry, or narrow the request.";
    default:
      return undefined;
  }
}

/**
 * The fallback for a failure outside the safe vocabulary. It names a saved run
 * only when the tool returned one; the raw text stays in the private session
 * transcript.
 */
function unclassifiedFailure(toolName: string, details: unknown): string {
  const runId =
    details && typeof details === "object" ? (details as { runId?: unknown }).runId : undefined;
  if (typeof runId === "string" && SAFE_RECORD_ID.test(runId)) {
    return (
      "No safe failure detail is available. Run " +
      runId +
      " was saved; inspect its failed step with\ndocsfab runs show " +
      runId
    );
  }
  const beforeRecord =
    toolName === "docsfab_run_workflow"
      ? " The workflow stopped before DocsFab created a run record, so there is no run log."
      : "";
  return (
    "No safe failure detail is available." +
    beforeRecord +
    " The raw error is kept only in this session's private transcript." +
    " NEXT: report the unclassified failure to the DocsFab maintainers so it gains a safe code."
  );
}

/** The recorded class and code are closed host evidence, not report prose. */
function recordedFailureReason(failure: FailureClassificationV1, details: unknown): string {
  const classification = `Failure class: ${describeFailureClassification(failure)}.`;
  const runId =
    details && typeof details === "object" ? (details as { runId?: unknown }).runId : undefined;
  return typeof runId === "string" && SAFE_RECORD_ID.test(runId)
    ? `${classification} Run ${runId} was saved; inspect its failed step with\ndocsfab runs show ${runId}`
    : classification;
}

function hasToolCallIdentity(toolCallId: unknown, toolName: unknown): boolean {
  return (
    typeof toolCallId === "string" &&
    toolCallId.length > 0 &&
    typeof toolName === "string" &&
    toolName.length > 0
  );
}

/**
 * Private equality key for one tool call: its name plus its full arguments.
 * Only compared, never printed; `undefined` when the arguments cannot be
 * serialized, which disables collapsing for that call.
 */
function argumentsDigest(toolName: string, args: unknown): string | undefined {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(args ?? null);
  } catch {
    return undefined;
  }
  if (serialized === undefined) return undefined;
  return createHash("sha256")
    .update(toolName + "\0" + serialized, "utf8")
    .digest("hex");
}

/** Terminal-only projection of observed events. Never print event payloads. */
export class LiveAgentActivityRenderer {
  private active?: Activity;
  private readonly tools = new Map<string, Activity & { readonly toolName: string }>();
  private readonly ambiguousToolCalls = new Set<string>();
  private readonly stages = new Map<string, Activity>();
  private timer?: ReturnType<typeof setInterval>;
  private readonly chat: LiveAgentChatRenderer;
  private receivedText = false;
  private failed = false;
  private running = false;
  private cancelling = false;
  private responseStarted?: number;
  /** Retried provider failures of the current model call. */
  private providerRetries = 0;
  /** Failure text already shown this turn, with how many attempts produced it. */
  private readonly shownFailures = new Map<
    string,
    { readonly identity: string; readonly label: string; attempts: number }
  >();
  /** Digest of each running tool call's name and full arguments; never printed. */
  private readonly attemptKeys = new Map<string, string>();

  constructor(
    private readonly options: {
      write: (text: string) => void;
      writeError?: (text: string) => void;
      tty: boolean;
      columns?: () => number;
      environment?: NodeJS.ProcessEnv;
      skillIds: readonly string[];
      workflowIds: readonly string[];
      qualityPath?: string;
      inputAskInputIdsForRun?: (runId: string) => readonly string[] | undefined;
      documentationWorkPrerequisite?: DocumentationWorkPrerequisiteActivity;
      /** The typed provider error behind a failed assistant message, when one was sent. */
      providerFailure?: (message: object) => ProviderErrorTelemetryV1 | undefined;
    },
  ) {
    this.chat = new LiveAgentChatRenderer(options);
  }

  prompt(): string {
    return this.chat.prompt();
  }

  begin(): void {
    this.dispose();
    this.running = true;
    this.receivedText = false;
    this.failed = false;
    this.cancelling = false;
    this.providerRetries = 0;
    this.shownFailures.clear();
    this.show({ label: "Contacting model", started: Date.now() });
  }

  handle(event: AgentSessionEvent): void {
    if (!this.running || this.cancelling) return;
    if (event.type === "tool_execution_start") {
      // A new call identity cannot inherit an unconsumed fact from an earlier attempt.
      this.options.documentationWorkPrerequisite?.consume(event.toolCallId, event.toolName);
      // Simultaneously reused IDs cannot identify which invocation produced a fact.
      if (this.tools.has(event.toolCallId)) this.ambiguousToolCalls.add(event.toolCallId);
      this.closeText();
      this.clear();
      const activity = {
        label: this.toolLabel(event.toolName, event.args),
        started: Date.now(),
        toolName: event.toolName,
      };
      this.tools.set(event.toolCallId, activity);
      const attemptKey = hasToolCallIdentity(event.toolCallId, event.toolName)
        ? argumentsDigest(event.toolName, event.args)
        : undefined;
      if (attemptKey) this.attemptKeys.set(event.toolCallId, attemptKey);
      this.show(activity);
    } else if (
      event.type === "tool_execution_update" &&
      event.toolName === "docsfab_run_workflow"
    ) {
      const workflow = this.tools.get(event.toolCallId);
      const progress = event.partialResult?.details;
      const hasOrdinal =
        Number.isSafeInteger(progress?.step) &&
        Number.isSafeInteger(progress?.total) &&
        progress.step >= 1 &&
        progress.step <= progress.total &&
        progress.total <= 1000;
      const omitsOrdinal = progress?.step === undefined && progress?.total === undefined;
      if (
        !workflow ||
        progress?.kind !== "docsfab-live-workflow-progress" ||
        !this.options.workflowIds.includes(progress.workflow) ||
        workflow.label !== `Running workflow: ${progress.workflow}` ||
        typeof progress.stepId !== "string" ||
        !/^[a-z0-9-]+$/u.test(progress.stepId) ||
        (!hasOrdinal && !omitsOrdinal) ||
        !["running", "succeeded", "failed", "needs-input", "needs-human-decision"].includes(
          progress.status,
        )
      )
        return;
      this.closeText();
      const label = hasOrdinal
        ? `${progress.workflow} · step ${progress.step}/${progress.total}: ${progress.stepId}`
        : `${progress.workflow} · ${progress.stepId}`;
      const previous = this.stages.get(event.toolCallId);
      const stage = previous?.label === label ? previous : { label, started: Date.now() };
      if (progress.status === "running") {
        this.stages.set(event.toolCallId, stage);
        this.show(stage);
      } else {
        this.milestone(
          progress.status === "succeeded"
            ? "Done"
            : progress.status === "failed"
              ? "Failed"
              : "Needs input",
          stage,
        );
        this.stages.delete(event.toolCallId);
        this.show(workflow);
      }
    } else if (event.type === "tool_execution_end") {
      const observedPrerequisite = this.options.documentationWorkPrerequisite?.consume(
        event.toolCallId,
        event.toolName,
      );
      const activity = this.tools.get(event.toolCallId);
      if (!activity) return;
      const prerequisite =
        event.isError &&
        hasToolCallIdentity(event.toolCallId, event.toolName) &&
        activity.toolName === event.toolName &&
        !this.ambiguousToolCalls.has(event.toolCallId) &&
        observedPrerequisite === true;
      this.closeText();
      this.clear();
      if (
        event.toolName === "docsfab_run_workflow" &&
        !event.isError &&
        event.result?.details?.kind === "docsfab-live-workflow-resubmit"
      ) {
        // A granted agent resubmission is not an outcome: the resubmitted call,
        // or the failure notice, speaks for it.
        this.tools.delete(event.toolCallId);
        this.attemptKeys.delete(event.toolCallId);
        this.stages.delete(event.toolCallId);
        this.show(
          this.tools.values().next().value ?? { label: "Contacting model", started: Date.now() },
        );
        return;
      }
      const outcomeTool = ["docsfab_run_workflow", "docsfab_publish_workflow", "bash"].includes(
        event.toolName,
      );
      const status = outcomeTool ? event.result?.details?.status : undefined;
      const cancelled = status === "cancelled";
      const needsInput = status === "needs-input" || status === "needs-human-decision";
      const failed =
        event.isError || (outcomeTool && status !== "succeeded" && !needsInput && !cancelled);
      const reviewDecision =
        event.toolName === "docsfab_run_workflow"
          ? event.result?.details?.quality?.decision
          : undefined;
      this.milestone(
        prerequisite
          ? "Blocked"
          : cancelled
            ? "Cancelled"
            : needsInput
              ? "Needs input"
              : failed
                ? "Failed"
                : reviewDecision === "insufficient-evidence"
                  ? "Evidence limited"
                  : reviewDecision === "fail" || reviewDecision === "human-review"
                    ? "Findings"
                    : "Done",
        activity,
      );
      if (!failed && !cancelled && typeof reviewDecision === "string") {
        const conclusion = {
          "insufficient-evidence":
            "Review execution finished, but the available evidence does not support an overall quality conclusion. Read the findings and unverified scope below.",
          fail: "Review execution finished with documentation findings that need correction.",
          "human-review": "Review execution finished with findings that need human review.",
        }[reviewDecision];
        if (conclusion) this.options.write(`${conclusion}\n`);
      }
      if (event.toolName === "docsfab_run_workflow" && !event.isError) {
        const warnings: unknown = event.result?.details?.evidenceWarnings;
        if (Array.isArray(warnings)) {
          for (const line of warnings) {
            if (typeof line === "string" && isRecordableEvidenceWarning(line)) {
              this.options.write(`${line}\n`);
            }
          }
        }
      }
      if (prerequisite) {
        this.options.write(`${DOCUMENTATION_WORK_PREREQUISITE_ACTION}\n`);
      } else if (needsInput || failed) {
        const details =
          event.toolName === "docsfab_run_workflow" ? event.result?.details : undefined;
        // Completed runs carry errors in details; thrown preflight errors arrive as text.
        const errors: unknown[] = [details?.error];
        const recordedFailures: unknown[] = [details?.failure];
        const outcomeSteps: {
          status?: unknown;
          error?: unknown;
          summary?: unknown;
          failure?: unknown;
        }[] = Array.isArray(details?.steps)
          ? details.steps.filter(
              (step: { status?: unknown } | null) =>
                step?.status === "failed" || step?.status === "needs-input",
            )
          : [];
        for (const step of outcomeSteps) {
          errors.push(step.error);
          if (step.status === "failed") recordedFailures.push(step.failure);
        }
        const recordedFailure = failed
          ? recordedFailures.map(readFailureClassification).find((failure) => failure !== null)
          : undefined;
        // Closed host diagnostics remain actionable beside a recorded class.
        // Saved step summaries and arbitrary tool text never enter this set.
        const recordedHostStop = [details?.error, ...outcomeSteps.map((step) => step.error)].find(
          (error): error is string => typeof error === "string" && SETUP_REASONS.has(error),
        );
        if (event.isError && Array.isArray(event.result?.content)) {
          errors.push(
            ...event.result.content
              .filter((item: { type?: unknown } | null) => item?.type === "text")
              .map((item: { text?: unknown }) => item.text),
          );
        }
        const commandExit = event.toolName === "bash" ? event.result?.details?.exitCode : undefined;
        const commandReason =
          Number.isInteger(commandExit) && commandExit >= 0 && commandExit <= 255
            ? `Host command exited with code ${commandExit}. Review its output and repository state before retrying.`
            : undefined;
        // A persisted knowledge stop carries its typed reason in the result, so
        // it is projected from the type rather than recovered from a message.
        const stop = details?.knowledgeStop;
        const knowledgeStopReason =
          stop && typeof stop === "object" && isLiveKnowledgeStopReason(stop.reason)
            ? renderLiveAgentKnowledgeStop({
                reason: stop.reason,
                recorded: true,
                ...(typeof stop.resumeRunId === "string" ? { resumeRunId: stop.resumeRunId } : {}),
              })
            : undefined;
        const reason =
          commandReason ??
          knowledgeStopReason ??
          (recordedFailure
            ? `${recordedFailureReason(recordedFailure, details)}${recordedHostStop ? ` ${recordedHostStop}` : ""}`
            : undefined) ??
          errors.map((error) => failureReason(error, this.options.workflowIds)).find(Boolean) ??
          (needsInput
            ? outcomeSteps
                .filter((step) => step.status === "needs-input")
                .map((step) => step.summary)
                .find(
                  (summary): summary is string =>
                    typeof summary === "string" && SETUP_REASONS.has(summary),
                )
            : undefined) ??
          (needsInput
            ? renderLiveAgentInputAskSlots(
                liveAgentInputAskSlotsFromWorkflowDetails(
                  details,
                  this.options.inputAskInputIdsForRun,
                ),
              )
            : undefined);
        const text =
          reason ??
          (needsInput
            ? "Provide the missing task details before retrying the workflow."
            : unclassifiedFailure(event.toolName, details));
        // Collapse only when the printed text is the rendered pre-record stop
        // itself, not a command exit or knowledge stop that outranked it.
        const preRecord = errors.map((error) => preRecordFailure(error)).find(Boolean);
        const attemptKey = this.attemptKeys.get(event.toolCallId);
        if (preRecord && attemptKey && text === renderPreRecordFailure(preRecord)) {
          const identity = preRecordFailureIdentity(preRecord);
          this.writeRepeatableFailure(text, attemptKey + "\0" + identity, identity, activity.label);
        } else {
          this.options.write(text + "\n");
        }
      }
      this.tools.delete(event.toolCallId);
      this.attemptKeys.delete(event.toolCallId);
      this.stages.delete(event.toolCallId);
      this.show(
        this.tools.values().next().value ?? { label: "Contacting model", started: Date.now() },
      );
    } else if (
      event.type === "message_update" &&
      event.assistantMessageEvent.type === "text_delta"
    ) {
      const text = event.assistantMessageEvent.delta;
      if (!text) return;
      this.clear();
      this.receivedText ||= text.trim().length > 0;
      this.chat.append(text);
      if (this.chat.rich) {
        this.responseStarted ??= Date.now();
        this.show({ label: "Receiving response", started: this.responseStarted });
      }
    } else if (event.type === "message_end" && event.message.role === "assistant") {
      if (event.message.stopReason === "error") {
        this.fail(event.message.errorMessage, this.options.providerFailure?.(event.message));
      } else if (event.message.stopReason === "aborted") this.interrupt();
      // Retries belong to one model call; a tool loop's next call starts at zero.
      this.providerRetries = 0;
    }
  }

  finish(): void {
    if (!this.running) return;
    this.clear();
    this.closeText();
    this.summarizeRepeatedFailures();
    if (!this.receivedText && !this.failed) {
      this.writeError(
        "[Failed] Model returned no answer. Retry with a shorter request; if it persists, check model readiness with docsfab setup.\n",
      );
    }
    this.dispose();
  }

  fail(error: unknown, providerError?: ProviderErrorTelemetryV1): void {
    if (this.failed || !this.running || this.cancelling) return;
    this.options.documentationWorkPrerequisite?.clear();
    const label =
      this.providerRetries > 0 ? "Contacting model" : (this.active?.label ?? "Model response");
    this.clear();
    this.closeText();
    this.failed = true;
    this.writeError(
      `[Failed] ${label}.\n${
        failureReason(
          error,
          this.options.workflowIds,
          providerError ? { error: providerError, attempts: this.providerRetries + 1 } : undefined,
        ) ??
        "Model or session request failed. Check connectivity and model readiness with docsfab setup, then retry."
      }\n`,
    );
    this.running = false;
  }

  /** One model request failed and DocsFab is about to replay it. */
  retrying(notice: ProviderRetryNotice): void {
    if (!this.running || this.cancelling) return;
    this.providerRetries = notice.attempt;
    if (this.tools.size > 0) return;
    this.clear();
    this.closeText();
    this.show({ label: providerRetryLabel(notice), started: Date.now() });
  }

  interrupt(): void {
    if (!this.running) return;
    this.clear();
    this.closeText();
    this.options.write("[Interrupted] Current turn stopped. No completion is implied.\n");
    this.dispose();
  }

  requestInterrupt(): void {
    if (!this.running || this.cancelling) return;
    this.options.documentationWorkPrerequisite?.clear();
    this.cancelling = true;
    this.clear();
    this.closeText();
    this.show({ label: "Cancellation requested; waiting for active work", started: Date.now() });
  }

  pauseForInput(): void {
    this.clear();
    this.closeText();
  }

  resumeAfterInput(): void {
    const activity = [...this.tools.values()].at(-1);
    if (this.running && !this.cancelling && activity) this.show(activity);
  }

  dispose(): void {
    this.options.documentationWorkPrerequisite?.clear();
    this.clear();
    this.closeText();
    this.tools.clear();
    this.ambiguousToolCalls.clear();
    this.attemptKeys.clear();
    this.stages.clear();
    this.running = false;
  }

  private toolLabel(name: string, args: unknown): string {
    if (name === "bash") return "Running approved host command";
    if (name === "edit" || name === "write") return "Editing repository files";
    if (name === "docsfab_publish_workflow") return "Creating draft merge request";
    const parameters = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
    if (name === "docsfab_read_gitlab") {
      // Tool arguments are untrusted. Display only known operations and bounded
      // numeric identifiers, never MR titles, URLs, descriptions, or raw errors.
      const page = parameters.page ?? 1;
      const validPage =
        typeof page === "number" && Number.isInteger(page) && page >= 1 && page <= 1000;
      if (parameters.operation === "list_merged" && validPage) {
        return `Listing merged GitLab MRs (page ${page})`;
      }
      const iid = parameters.iid;
      if (typeof iid === "number" && Number.isSafeInteger(iid) && iid >= 1) {
        if (parameters.operation === "get") return `Reading GitLab MR !${iid} details`;
        if (parameters.operation === "diffs" && validPage) {
          return `Reading GitLab MR !${iid} diffs (page ${page})`;
        }
      }
      return "Reading GitLab evidence (invalid request)";
    }
    if (name === "docsfab_use_skill") {
      return this.knownLabel("Loading skill", parameters.skill, this.options.skillIds);
    }
    if (name === "docsfab_read_run") {
      const id = parameters.runId;
      return typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(id)
        ? `Reading saved run: ${id}`
        : "Reading saved run";
    }
    if (name === "docsfab_run_workflow") {
      return this.knownLabel("Running workflow", parameters.workflow, this.options.workflowIds);
    }
    if (["read", "grep", "find", "ls"].includes(name)) {
      const path = parameters.path;
      const quality = this.options.qualityPath;
      if (quality && typeof path === "string" && posix.normalize(path).startsWith(`${quality}/`)) {
        return "Consulting quality guidance";
      }
      return "Reading repository evidence";
    }
    return "Running tool";
  }

  /**
   * Show a classified pre-record stop once per turn per (tool, full arguments,
   * stop identity); a repeat with the same key prints only its attempt number.
   */
  private writeRepeatableFailure(text: string, key: string, identity: string, label: string): void {
    const shown = this.shownFailures.get(key);
    if (!shown) {
      this.shownFailures.set(key, { identity, label, attempts: 1 });
      this.options.write(text + "\n");
      return;
    }
    shown.attempts += 1;
    this.options.write(
      "Same stop again (attempt " +
        shown.attempts +
        " this turn with the same arguments: " +
        identity +
        "). The detail above still applies.\n",
    );
  }

  /** Close a turn with what repetition established, not a copy of the stop. */
  private summarizeRepeatedFailures(): void {
    for (const [, shown] of this.shownFailures) {
      if (shown.attempts < 2) continue;
      this.options.write(
        "Turn summary: " +
          shown.label +
          " was called " +
          shown.attempts +
          " times with the same arguments and stopped at " +
          shown.identity +
          " each time.\n",
      );
    }
  }

  private writeError(text: string): void {
    (this.options.writeError ?? this.options.write)(text);
  }

  private knownLabel(label: string, value: unknown, allowed: readonly string[]): string {
    return typeof value === "string" && allowed.includes(value) && /^[a-z0-9-]+$/.test(value)
      ? `${label}: ${value}`
      : label;
  }

  private show(activity: Activity): void {
    this.active = activity;
    this.draw();
    this.timer = setInterval(() => this.draw(), 1000);
    this.timer.unref();
  }

  private get inPlace(): boolean {
    return this.options.tty && this.options.environment?.TERM !== "dumb";
  }

  private draw(): void {
    if (!this.active) return;
    const elapsed = `${Math.floor((Date.now() - this.active.started) / 1000)}s`;
    const width = Math.max(8, this.options.columns?.() || 80) - 1;
    const suffix = ` (${elapsed})`;
    const label = `[Working] ${this.active.label}`;
    const line =
      label.length + suffix.length > width
        ? `${label.slice(0, Math.max(0, width - suffix.length - 1))}~${suffix}`
        : `${label}${suffix}`;
    const styled = this.chat.paint(line, 220);
    this.options.write(this.inPlace ? `\r\u001b[2K${styled}` : `${styled}\n`);
  }

  private clear(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.active && this.inPlace) this.options.write("\r\u001b[2K");
    this.active = undefined;
  }

  private milestone(status: string, activity: Activity): void {
    this.options.write(
      `${this.chat.paint(`[${status}] ${activity.label} (${Math.floor((Date.now() - activity.started) / 1000)}s)`, status === "Done" ? 113 : status === "Failed" ? 203 : 220)}\n`,
    );
  }

  private closeText(): void {
    this.clear();
    this.chat.close();
    this.responseStarted = undefined;
  }
}
