// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Turn-scoped direct-change gate after a workflow that did not succeed.
 *
 * After any failed workflow, including a refusal before the run record exists,
 * the live agent may not fall back to direct edits in the same turn: a direct
 * fallback bypasses verification, review, and evidence and hides the defect.
 * Prompt text alone does not hold this, so the host refuses `edit`, `write`,
 * and `bash` until the operator's next message.
 *
 * - A refusal caused by the agent's own restatement is retried with the
 *   operator's original wording (`gateLiveWorkflowRunner` in `host.ts`, bounded
 *   by `liveAgent.agentCausedRefusalRetries`).
 * - A failure that ends the turn gets one host-rendered notice with a plain
 *   sentence, one `Details:` line, and two one-word choices.
 * - `retry` and `edit anyway` are recognized as the next message. An edit the
 *   operator asks for is labelled unverified, with no authorizing run.
 *
 * A workflow retry is never gated, and a successful workflow's checked patch
 * still applies through `LiveWorkflowDelivery`. The `blockAfter` policy sets
 * reversibility; `pre-record-refusal` restores the narrower rule.
 *
 * Every recorded field is a closed code or status, a validated step id, or a
 * run-store id, except the strictly decoded and credential-screened contradiction
 * question projected by the workflow tool. The local host persists screened
 * operator text separately so its request binding survives a restart.
 */
import type { FirstPassContradictionQuestionV1 } from "../cli/run/first-pass-contradiction-stop.js";
import { escapeUndisplayable } from "../shared/display-text.js";
import { HostPreMutationError } from "../harness/confined-tools.js";
import type { PreRecordHandlingKind } from "../operator/pre-record-failure.js";
import { TECHNICAL_CORRECTION_BYTE_BOUNDS } from "../workflow-execution/technical-rejection-retryability.js";

export const LIVE_WORKFLOW_FAILURE_GATE_MESSAGES = {
  directChange:
    "DocsFab blocked this direct change because a documentation workflow in this turn did not succeed. No files were changed. Keep your reply short: DocsFab shows the user what failed and offers a retry or an unverified direct edit. Wait for the user's reply.",
  unverified:
    "Unverified: this turn changed files directly after a workflow did not succeed, with no authorizing run. No workflow verified, reviewed, or recorded evidence for these changes.",
  openInputAsk:
    "DocsFab blocked this direct change because a stopped documentation workflow still needs its named input. No files were changed. Answer the user, and tell them that supplying the named input, such as the repository path of a source file, continues that run.",
  openInputAskNotice:
    'A stopped workflow still needs its named input. For text, reply "<inputId>: <answer>" using a named input, such as "prd: <answer>"; for a file, reply with its exact repository path.',
} as const;

export const LIVE_WORKFLOW_FAILURE_CHOICES = {
  retry: "retry",
  editAnyway: "edit anyway",
} as const;

export class LiveWorkflowFailureGateError extends HostPreMutationError {
  constructor(
    message:
      | typeof LIVE_WORKFLOW_FAILURE_GATE_MESSAGES.directChange
      | typeof LIVE_WORKFLOW_FAILURE_GATE_MESSAGES.openInputAsk = LIVE_WORKFLOW_FAILURE_GATE_MESSAGES.directChange,
  ) {
    super(message);
    this.name = "LiveWorkflowFailureGateError";
  }
}

/** One workflow outcome that did not succeed, with an optional screened question. */
export type LiveWorkflowFailureV1 =
  | {
      readonly kind: "no-run-record";
      readonly workflow: string;
      /** Present only when the stop is in the pre-record refusal vocabulary. */
      readonly code?: string;
      readonly handling?: PreRecordHandlingKind;
      /** This refusal answered a granted agent resubmission. */
      readonly resubmitted?: boolean;
    }
  | {
      readonly kind: "run";
      readonly workflow: string;
      readonly runId: string;
      readonly status: string;
      readonly step?: string;
      readonly code?: string;
      readonly persistence?: string;
      /** Stopped on named InputAsk slots, so no retry or unverified edit is offered. */
      readonly inputAsk?: true;
      readonly firstPassContradictionQuestion?: FirstPassContradictionQuestionV1;
      readonly firstPassChoiceAvailable?: true;
    };

/** One attempt of a workflow tool call, kept for the turn's record. */
export type LiveWorkflowAttemptV1 =
  | {
      readonly instruction: "agent" | "agent-resubmission";
      readonly outcome: "refused";
      readonly code?: string;
    }
  | {
      readonly instruction: "agent" | "agent-resubmission";
      readonly outcome: "run";
      readonly runId: string;
      readonly status: string;
    };

/** A direct change the host admitted while a failed workflow was the latest outcome. */
export interface LiveUnverifiedChangeV1 {
  readonly authorizingRun: "none";
  readonly requestedByOperator: boolean;
}

export type LiveWorkflowFailureGatePolicy = "any-failed-workflow" | "pre-record-refusal";

export interface LiveWorkflowFailureGate {
  readonly policy: LiveWorkflowFailureGatePolicy;
  beginUserTurn(request: string): void;
  /** The operator's message this turn's request ends at (a choice replays the failed turn's). */
  readonly turnRequest: string | undefined;
  /** Every operator message up to and including this turn's anchor, oldest first. */
  readonly verbatimMessages: readonly string[];
  /** Only messages supplied in this process; prior persisted messages grant no direct path authority. */
  readonly turnOperatorMessages: readonly string[];
  /** A retry turn must bind this entire saved instruction, not merely an ending suffix. */
  readonly replayInstruction: string | undefined;
  /** Saved run selected by a retry reply; the host must re-read its scope and revision. */
  readonly replayRunId: string | undefined;
  /** Host-only continuation state. It contains no grants or model transcript. */
  continuationState(): LiveWorkflowFailureContinuationV1;
  /** Only messages added since the last completed local checkpoint. */
  continuationStateSince(count: number): LiveWorkflowFailureContinuationDeltaV2;
  restoreContinuationState(state: LiveWorkflowFailureContinuationV1): void;
  /** Record how many whole operator messages the bound instruction joined. */
  noteBoundRequest(messageCount: number): void;
  readonly boundMessageCount: number | undefined;
  /** Agent resubmissions granted in this turn. */
  readonly resubmissions: number;
  /** Grant one resubmission; the next workflow attempt is recorded as it. */
  grantResubmission(): void;
  readonly resubmissionPending: boolean;
  recordAttempt(attempt: LiveWorkflowAttemptV1): void;
  readonly attempts: readonly LiveWorkflowAttemptV1[];
  recordFailure(failure: LiveWorkflowFailureV1): void;
  recordSuccess(): void;
  /** The failure that closed direct changes in this turn, if any. */
  readonly blocking: LiveWorkflowFailureV1 | undefined;
  /** The latest workflow outcome in this turn when it did not succeed. */
  readonly turnFailure: LiveWorkflowFailureV1 | undefined;
  readonly unverifiedChanges: readonly LiveUnverifiedChangeV1[];
  recordContextClip(clip: { readonly omittedChars: number; readonly maxChars: number }): void;
  /**
   * The message could not fill a stopped run's open named input. Direct changes
   * stay closed for the turn so the input is never bypassed, and no retry or
   * edit choice is offered.
   */
  holdForOpenInputAsk(): void;
  /** A source-choice answer cannot become an ordinary retry request. */
  holdForFirstPassChoice(): void;
  /** Refuse one-word recovery of a settled source-choice answer. */
  refuseChoice(message: string): string | undefined;
  /** Throws {@link LiveWorkflowFailureGateError} while this turn is closed. No other effect. */
  assertOpen(): void;
  /** {@link assertOpen}, then record an unverified change when a failure is the latest outcome. */
  admitDirectChange(): void;
  /** The host-authored prompt that replaces `retry` or `edit anyway` after a failed turn. */
  resolveChoice(message: string): string | undefined;
  /** Host lines printed after the turn: the failure notice, then the unverified label. */
  endTurn(): readonly string[];
}

export interface LiveWorkflowFailureContinuationV1 {
  readonly operatorMessages: readonly string[];
  /** A denial only; no source option or retry request is reconstructed from it. */
  readonly firstPassChoiceRetryBlocked?: true;
  readonly pendingRetry?: {
    readonly failure: LiveWorkflowFailureV1;
    readonly instruction: string;
    readonly anchor: number;
  };
}

export interface LiveWorkflowFailureContinuationDeltaV2 {
  readonly baseCount: number;
  readonly operatorMessagesAdded: readonly string[];
  readonly messageCount: number;
  readonly firstPassChoiceRetryBlocked?: true;
  readonly pendingRetry?: LiveWorkflowFailureContinuationV1["pendingRetry"];
}

const CHOICE_WORKFLOW = /^[a-z0-9][a-z0-9-]{0,63}$/u;

export function createLiveWorkflowFailureGate(
  options: {
    blockAfter?: LiveWorkflowFailureGatePolicy;
    /** False in a read-only session: "edit anyway" is neither offered nor recognized. */
    allowDirectEdits?: boolean;
  } = {},
): LiveWorkflowFailureGate {
  const policy = options.blockAfter ?? "any-failed-workflow";
  const allowDirectEdits = options.allowDirectEdits ?? true;
  const operatorMessages: string[] = [];
  let anchor = -1;
  let processStart = 0;
  let boundMessageCount: number | undefined;
  let resubmissions = 0;
  let resubmissionPending = false;
  let attempts: LiveWorkflowAttemptV1[] = [];
  let blocking: LiveWorkflowFailureV1 | undefined;
  let turnFailure: LiveWorkflowFailureV1 | undefined;
  let latestFailure: LiveWorkflowFailureV1 | undefined;
  let directChangeThisTurn = false;
  let unverifiedChanges: LiveUnverifiedChangeV1[] = [];
  let contextClips: { readonly omittedChars: number; readonly maxChars: number }[] = [];
  let operatorChoseEdit = false;
  type PendingChoice = { failure: LiveWorkflowFailureV1; anchor: number; instruction: string };
  let pendingChoice: PendingChoice | undefined;
  // Retry retains only the original request, never an expired direct-edit choice.
  let pendingRetry: PendingChoice | undefined;
  let firstPassChoiceTurn = false;
  let choiceAnchor: number | undefined;
  let choiceInstruction: string | undefined;
  let choiceRunId: string | undefined;
  let replayRunId: string | undefined;
  let replayInstruction: string | undefined;
  let openInputAskHeld = false;
  const savedRetry = (): LiveWorkflowFailureContinuationV1["pendingRetry"] =>
    pendingRetry
      ? Object.freeze({
          failure: Object.freeze(
            pendingRetry.failure.kind === "run"
              ? {
                  kind: "run" as const,
                  workflow: pendingRetry.failure.workflow,
                  runId: pendingRetry.failure.runId,
                  status: pendingRetry.failure.status,
                  ...(pendingRetry.failure.code ? { code: pendingRetry.failure.code } : {}),
                }
              : {
                  kind: "no-run-record" as const,
                  workflow: pendingRetry.failure.workflow,
                  ...(pendingRetry.failure.code ? { code: pendingRetry.failure.code } : {}),
                },
          ),
          instruction: pendingRetry.instruction,
          anchor: pendingRetry.anchor,
        })
      : undefined;
  const assertDirectChangesOpen = (): void => {
    if (blocking) throw new LiveWorkflowFailureGateError();
    if (openInputAskHeld) {
      throw new LiveWorkflowFailureGateError(LIVE_WORKFLOW_FAILURE_GATE_MESSAGES.openInputAsk);
    }
  };
  return {
    policy,
    beginUserTurn(request) {
      firstPassChoiceTurn = false;
      if (request.trim() !== "") operatorMessages.push(request.trim());
      anchor = choiceAnchor ?? operatorMessages.length - 1;
      choiceAnchor = undefined;
      replayInstruction = choiceInstruction;
      choiceInstruction = undefined;
      replayRunId = choiceRunId;
      choiceRunId = undefined;
      boundMessageCount = undefined;
      resubmissions = 0;
      resubmissionPending = false;
      attempts = [];
      blocking = undefined;
      turnFailure = undefined;
      directChangeThisTurn = false;
      unverifiedChanges = [];
      contextClips = [];
      openInputAskHeld = false;
    },
    holdForOpenInputAsk() {
      openInputAskHeld = true;
    },
    holdForFirstPassChoice() {
      firstPassChoiceTurn = true;
    },
    refuseChoice(message) {
      const choice = message.trim().toLowerCase().replace(/\s+/gu, " ");
      if (
        firstPassChoiceTurn &&
        (choice === LIVE_WORKFLOW_FAILURE_CHOICES.retry ||
          choice === LIVE_WORKFLOW_FAILURE_CHOICES.editAnyway)
      ) {
        return turnFailure?.kind === "run" && turnFailure.firstPassChoiceAvailable
          ? "This source-choice answer cannot be retried as a task. Reply with one exact remaining offered source option, or send your complete documentation task as a new request."
          : "This source-choice answer cannot be retried as a task. Inspect its saved run and any retained patch, then send your complete documentation task as a new request.";
      }
      return undefined;
    },
    get turnRequest() {
      return anchor >= 0 ? operatorMessages[anchor] : undefined;
    },
    get verbatimMessages() {
      return operatorMessages.slice(0, anchor + 1);
    },
    get turnOperatorMessages() {
      return operatorMessages.slice(processStart, anchor + 1);
    },
    continuationState() {
      const retry = savedRetry();
      return Object.freeze({
        operatorMessages: Object.freeze([...operatorMessages]),
        ...(firstPassChoiceTurn ? { firstPassChoiceRetryBlocked: true as const } : {}),
        ...(retry ? { pendingRetry: retry } : {}),
      });
    },
    continuationStateSince(count) {
      if (!Number.isSafeInteger(count) || count < 0 || count > operatorMessages.length) {
        throw new Error(
          "The local continuation checkpoint offset is outside the recorded operator messages.",
        );
      }
      const retry = savedRetry();
      return Object.freeze({
        baseCount: count,
        operatorMessagesAdded: Object.freeze(operatorMessages.slice(count)),
        messageCount: operatorMessages.length,
        ...(firstPassChoiceTurn ? { firstPassChoiceRetryBlocked: true as const } : {}),
        ...(retry ? { pendingRetry: retry } : {}),
      });
    },
    restoreContinuationState(state) {
      firstPassChoiceTurn = state.firstPassChoiceRetryBlocked === true;
      operatorMessages.splice(0, operatorMessages.length, ...state.operatorMessages);
      processStart = operatorMessages.length;
      anchor = state.pendingRetry?.anchor ?? operatorMessages.length - 1;
      pendingRetry = state.pendingRetry
        ? {
            failure: state.pendingRetry.failure,
            anchor: state.pendingRetry.anchor,
            instruction: state.pendingRetry.instruction,
          }
        : undefined;
    },
    get replayInstruction() {
      return replayInstruction;
    },
    get replayRunId() {
      return replayRunId;
    },
    noteBoundRequest(messageCount) {
      boundMessageCount = messageCount;
    },
    get boundMessageCount() {
      return boundMessageCount;
    },
    get resubmissions() {
      return resubmissions;
    },
    grantResubmission() {
      resubmissions += 1;
      resubmissionPending = true;
    },
    get resubmissionPending() {
      return resubmissionPending;
    },
    recordAttempt(attempt) {
      attempts.push(Object.freeze({ ...attempt }));
      resubmissionPending = false;
    },
    get attempts() {
      return attempts;
    },
    recordFailure(failure) {
      latestFailure = failure;
      turnFailure = failure;
      if (policy === "any-failed-workflow" || failure.kind === "no-run-record") {
        blocking = failure;
      }
    },
    recordSuccess() {
      firstPassChoiceTurn = false;
      latestFailure = undefined;
      turnFailure = undefined;
      pendingRetry = undefined;
      operatorChoseEdit = false;
      replayRunId = undefined;
    },
    get blocking() {
      return blocking;
    },
    get turnFailure() {
      return turnFailure;
    },
    get unverifiedChanges() {
      return unverifiedChanges;
    },
    recordContextClip(clip) {
      contextClips.push(Object.freeze({ ...clip }));
    },
    assertOpen() {
      assertDirectChangesOpen();
    },
    admitDirectChange() {
      assertDirectChangesOpen();
      directChangeThisTurn = true;
      if (latestFailure) {
        unverifiedChanges.push(
          Object.freeze({
            authorizingRun: "none" as const,
            requestedByOperator: operatorChoseEdit,
          }),
        );
      }
    },
    resolveChoice(message) {
      const choice = message.trim().toLowerCase().replace(/\s+/gu, " ");
      if (firstPassChoiceTurn) return undefined;
      const pending = choice === LIVE_WORKFLOW_FAILURE_CHOICES.retry ? pendingRetry : pendingChoice;
      if (!pending) return undefined;
      if (
        choice !== LIVE_WORKFLOW_FAILURE_CHOICES.retry &&
        choice !== LIVE_WORKFLOW_FAILURE_CHOICES.editAnyway
      ) {
        return undefined;
      }
      // A read-only session never offered an edit, so the words are ordinary text.
      if (choice === LIVE_WORKFLOW_FAILURE_CHOICES.editAnyway && !allowDirectEdits) {
        return undefined;
      }
      pendingChoice = undefined;
      choiceAnchor = pending.anchor;
      const request = pending.instruction;
      const workflow = CHOICE_WORKFLOW.test(pending.failure.workflow)
        ? pending.failure.workflow
        : "documentation";
      if (choice === LIVE_WORKFLOW_FAILURE_CHOICES.retry) {
        choiceInstruction = request;
        choiceRunId = pending.failure.kind === "run" ? pending.failure.runId : undefined;
        operatorChoseEdit = false;
        return [
          `The user replied "retry". Run the ${workflow} workflow again with docsfab_run_workflow for the user's request that ended with the message below.`,
          "Pass that request verbatim as instruction, exactly as before; put anything you add in context. Do not edit files directly.",
          "",
          "Original bound user request:",
          request,
        ].join("\n");
      }
      operatorChoseEdit = true;
      return [
        `The user replied "edit anyway". Make the change for the user's original request below directly with edit or write, without running a workflow.`,
        'This edit is unverified: no workflow verified, reviewed, or recorded evidence for it, and it has no authorizing run. Say "unverified" in your reply and keep the original workflow failure in your summary.',
        "",
        "Original bound user request:",
        request,
      ].join("\n");
    },
    endTurn() {
      const lines: string[] = [];
      if (turnFailure && anchor >= 0) {
        // A targetless answer attempt cannot replace the earlier admitted request.
        // Only retry is retained; direct-edit choices still belong to the latest turn.
        const earlierRetry =
          isTargetlessInputStop(turnFailure) &&
          pendingRetry?.failure.kind === "run" &&
          pendingRetry.failure.status === "needs-input" &&
          pendingRetry.failure.inputAsk !== true &&
          !isTargetlessInputStop(pendingRetry.failure) &&
          pendingRetry.failure.workflow === turnFailure.workflow
            ? pendingRetry
            : undefined;
        lines.push(
          renderLiveWorkflowFailureNotice(turnFailure, {
            directEditsAvailable: allowDirectEdits,
            ...(firstPassChoiceTurn ? { firstPassChoiceTurn: true } : {}),
            ...(earlierRetry ? { retryEarlierRequest: true } : {}),
            filesMayHaveChanged:
              directChangeThisTurn ||
              (turnFailure.kind === "run" &&
                (turnFailure.persistence === "applied" ||
                  turnFailure.persistence === "already-applied")),
          }),
        );
        // An InputAsk stop offers no choice words: the next message is its fill.
        // A scope stop offers none either: the same request stops at the same bound.
        pendingChoice =
          isWorkflowCancellation(turnFailure) ||
          isInputAskStop(turnFailure) ||
          isScopeBoundStop(turnFailure) ||
          firstPassChoiceTurn
            ? undefined
            : {
                failure: turnFailure,
                anchor,
                instruction:
                  replayInstruction ??
                  operatorMessages
                    .slice(anchor - (boundMessageCount ?? 1) + 1, anchor + 1)
                    .join(VERBATIM_MESSAGE_SEPARATOR),
              };
        pendingRetry =
          isWorkflowCancellation(turnFailure) || firstPassChoiceTurn
            ? undefined
            : (earlierRetry ?? pendingChoice);
      } else {
        pendingChoice = undefined;
        if (firstPassChoiceTurn) pendingRetry = undefined;
      }
      if (unverifiedChanges.length > 0) lines.push(LIVE_WORKFLOW_FAILURE_GATE_MESSAGES.unverified);
      if (openInputAskHeld && !turnFailure) {
        lines.push(LIVE_WORKFLOW_FAILURE_GATE_MESSAGES.openInputAskNotice);
      }
      for (const clip of contextClips) lines.push(liveWorkflowContextClipNotice(clip));
      contextClips = [];
      return lines;
    },
  };
}

/**
 * Pre-record scope codes an agent-assembled request can cause when a later
 * joined user message repeats or narrows an earlier one. Only such a
 * multi-message instruction earns a resubmission.
 */
export const AGENT_CAUSED_REFUSAL_CODES: ReadonlySet<string> = new Set([
  "proposal-scope-duplicate-targets",
  "proposal-scope-conflicting-targets",
  "proposal-scope-ambiguous-targets",
]);

const PLAIN_BY_CODE: Readonly<Record<string, string>> = {
  "proposal-scope-duplicate-targets":
    "I couldn't start this change: the request named the same page more than once.",
  "proposal-scope-conflicting-targets":
    "I couldn't start this change: the request both changes a page and uses it as a source or keeps it unchanged.",
  "proposal-scope-ambiguous-targets":
    "I couldn't start this change: the request didn't say clearly which pages to change.",
  "proposal-scope-unsafe-target":
    "I couldn't start this change: the request named a page outside the documentation area.",
  // Deliberately not in AGENT_CAUSED_REFUSAL_CODES. The user's own
  // words asked a question or said not yet; a resubmission would let the agent
  // rewrite them into an imperative the user never gave.
  "proposal-scope-non-actionable-targets":
    "I couldn't start this change: the request reads as a question, a request to wait, or a request not to change the page.",
  "credential-material":
    "I stopped because the request or its sources contain one of DocsFab's own configured credentials.",
  "bound-source-unavailable": "I couldn't read one of the sources selected for this change.",
  "live-workflow-request-not-verbatim":
    "I couldn't start this change: I need the request in your own words, in one message.",
  "live-workflow-context-credential-material":
    "I stopped because the context I added contains one of DocsFab's own configured credentials.",
};

const PLAIN_BY_HANDLING: Readonly<Record<PreRecordHandlingKind, string>> = {
  supply: "I couldn't start this change: the request needs more detail.",
  recover: "I couldn't reach the model to check the source facts.",
  correct: "I couldn't verify this change: the source facts didn't line up.",
  redirect:
    "I couldn't make this change: it is larger than, or not supported by, what the repository documents.",
};

const VERIFY_STEP = /verif|technical|accuracy|fact/iu;
const REVIEW_STEP = /review|quality|evaluat|editorial/iu;
const PLAN_STEP = /plan/iu;

/** The writer-facing sentence for one failure, derived only from its class and codes. */
export function plainLiveWorkflowFailure(failure: LiveWorkflowFailureV1): string {
  if (isWorkflowCancellation(failure)) return "Workflow cancelled by user.";
  if (failure.kind === "no-run-record") {
    const byCode = failure.code === undefined ? undefined : PLAIN_BY_CODE[failure.code];
    if (byCode) return byCode;
    if (failure.code?.startsWith("proposal-scope-")) {
      return "I couldn't start this change: the list of pages to change didn't check out.";
    }
    if (failure.handling) return PLAIN_BY_HANDLING[failure.handling];
    return "I couldn't start the workflow for this change.";
  }
  if (failure.status === "needs-input" || failure.status === "needs-human-decision") {
    return "The workflow needs more information from you before it can finish.";
  }
  if (failure.persistence === "failed") {
    return "The workflow finished, but I couldn't apply its change to your checkout.";
  }
  const scopeBound = scopeBoundLimitName(failure.code);
  if (scopeBound) {
    return `I stopped this review because its scope is too large for one run: it reached the ${scopeBound} bound.`;
  }
  const step = failure.step ?? "";
  if (VERIFY_STEP.test(step))
    return "I couldn't verify this change: the source facts didn't line up.";
  if (REVIEW_STEP.test(step)) return "I couldn't finish the review, so the change wasn't accepted.";
  if (PLAN_STEP.test(step)) return "I couldn't plan this change.";
  return "The workflow didn't finish, so its change wasn't accepted.";
}

/**
 * The host notice for a turn that ended on a failed workflow: plain sentence
 * and edit state first, one `Details:` line, then the one-word choices.
 */
export function renderLiveWorkflowFailureNotice(
  failure: LiveWorkflowFailureV1,
  state: {
    readonly filesMayHaveChanged: boolean;
    readonly directEditsAvailable?: boolean;
    readonly retryEarlierRequest?: boolean;
    readonly firstPassChoiceTurn?: true;
  },
): string {
  const edited = state.filesMayHaveChanged
    ? "Some files may have changed; check git status before you continue."
    : "Nothing was edited.";
  const details =
    failure.kind === "run"
      ? [
          `run ${failure.runId}`,
          ...(failure.step ? [`step ${failure.step}`] : []),
          ...(failure.code ? [`code ${failure.code}`] : []),
          `status ${failure.status}`,
        ]
      : [
          "no run record",
          ...(failure.code ? [`code ${failure.code}`] : []),
          ...(failure.resubmitted ? ["after one resubmission of your exact words"] : []),
        ];
  const retry = state.retryEarlierRequest
    ? `"${LIVE_WORKFLOW_FAILURE_CHOICES.retry}" to replay the earlier original request unchanged`
    : `"${LIVE_WORKFLOW_FAILURE_CHOICES.retry}" to try again`;
  const edit = `"${LIVE_WORKFLOW_FAILURE_CHOICES.editAnyway}" to make an unverified edit (skips source-fact checking and review)`;
  const cancelled = isWorkflowCancellation(failure);
  const options = state.directEditsAvailable === false ? `${retry}.` : `${retry}, or ${edit}.`;
  if (cancelled) {
    return [
      `${plainLiveWorkflowFailure(failure)} ${edited}`,
      `Details: ${details.join(", ")}.`,
      "Send a new request when you are ready to continue.",
    ].join("\n");
  }
  const choices = isInputAskStop(failure)
    ? 'For text, reply "<inputId>: <answer>" using the named input above, such as "prd: <answer>". For a file, reply with its exact repository path to continue this run.'
    : isScopeBoundStop(failure)
      ? SCOPE_BOUND_NEXT
      : failure.kind === "run" && failure.firstPassChoiceAvailable
        ? "Reply with one exact offered source option in this live-agent session. If exactly one verified executable implementation side was offered, 'Use the implementation' also selects it. The choice remains attributed and unverified."
        : state.firstPassChoiceTurn
          ? "Inspect the saved run and any retained patch. Start a new request with your complete documentation task to try again; this source-choice answer cannot be retried as a task."
          : failure.kind === "run" &&
              (failure.status === "needs-input" || failure.status === "needs-human-decision")
            ? `This stop cannot be continued in place. Send your complete request again with the requested details to start a new workflow run, or ${options}`
            : `Reply ${options}`;
  return [
    `${plainLiveWorkflowFailure(failure)} ${edited}`,
    `Details: ${details.join(", ")}.`,
    ...(failure.kind === "run" && failure.firstPassContradictionQuestion
      ? [
          `Question: ${escapeUndisplayable(failure.firstPassContradictionQuestion.question)}`,
          `Options: ${failure.firstPassContradictionQuestion.options.map(escapeUndisplayable).join(" | ")}`,
          `Recommended: ${escapeUndisplayable(failure.firstPassContradictionQuestion.recommendedDefault)}`,
          `If you take it: ${escapeUndisplayable(failure.firstPassContradictionQuestion.consequence)}`,
        ]
      : []),
    choices,
  ].join("\n");
}

function isWorkflowCancellation(failure: LiveWorkflowFailureV1): boolean {
  return (
    (failure.kind === "no-run-record" && failure.code === "workflow-cancelled") ||
    (failure.kind === "run" &&
      (failure.status === "cancelled" || failure.code === "workflow-cancelled"))
  );
}

function isInputAskStop(failure: LiveWorkflowFailureV1): boolean {
  return failure.kind === "run" && failure.status === "needs-input" && failure.inputAsk === true;
}

/** The host admitted no target for this request, so it cannot supersede an input stop. */
function isTargetlessInputStop(failure: LiveWorkflowFailureV1): boolean {
  return (
    failure.kind === "run" &&
    failure.status === "needs-input" &&
    failure.code === "request-intent-target-missing"
  );
}

/** The next step for a scope stop; a retry of the same scope stops at the same bound. */
export const SCOPE_BOUND_NEXT =
  "Narrow the request, for example to one directory such as docs/get-started, and send it again. Retrying the same scope stops at the same bound.";

/** Each review scope stop's catalog refusal code, with the limit it names. */
const SCOPE_BOUND_LIMIT_NAMES: ReadonlyMap<string, string> = new Map(
  Object.values(TECHNICAL_CORRECTION_BYTE_BOUNDS).map(({ code, limit }) => [code, limit]),
);

function scopeBoundLimitName(code: string | undefined): string | undefined {
  return code === undefined ? undefined : SCOPE_BOUND_LIMIT_NAMES.get(code);
}

function isScopeBoundStop(failure: LiveWorkflowFailureV1): boolean {
  return failure.kind === "run" && scopeBoundLimitName(failure.code) !== undefined;
}

/** A review scope stop read from run error text: digits and catalog names only. */
export interface LiveWorkflowScopeBoundStopV1 {
  readonly code: string;
  readonly limitName: string;
  readonly observedBytes: number;
  readonly limitBytes: number;
}

const LIMIT_OBSERVATION =
  /(?:^|[\s.:])([a-z0-9]+(?:-[a-z0-9]+)+): (\d{1,15}) exceeds ([A-Za-z][A-Za-z0-9.]{0,127}) = (\d{1,15}) bytes\./u;

/**
 * The review scope stop a run error names, as the host's limit refusal line
 * (`<code>: <observed> exceeds <limit> = <value> bytes.`) writes it. Only a
 * scope bound's own code and limit name are admitted, so no other text passes.
 */
export function liveWorkflowScopeBoundStop(
  error: unknown,
): LiveWorkflowScopeBoundStopV1 | undefined {
  if (typeof error !== "string") return undefined;
  const match = LIMIT_OBSERVATION.exec(error);
  if (!match) return undefined;
  const [, code, observed, limitName, configured] = match;
  if (scopeBoundLimitName(code) !== limitName) return undefined;
  return {
    code: code!,
    limitName: limitName!,
    observedBytes: Number(observed),
    limitBytes: Number(configured),
  };
}

const STRICT_CODE = /^[a-z0-9]+(?:-[a-z0-9]+)+$/u;
const CODED_ERROR = /(?:rejected|stopped|failed|refused)[^:]{0,80}: ([a-z0-9][a-z0-9-]{0,63})\.?$/u;

/**
 * A closed rejection code from free-text run error, or `undefined`: a review
 * scope stop's bound code, else a trailing hyphenated token after a
 * "rejected:" style prefix.
 */
export function liveWorkflowRejectionCode(error: unknown): string | undefined {
  if (typeof error !== "string") return undefined;
  const scopeBound = liveWorkflowScopeBoundStop(error);
  if (scopeBound) return scopeBound.code;
  const code = CODED_ERROR.exec(error.trim())?.[1];
  return code !== undefined && STRICT_CODE.test(code) ? code : undefined;
}

export const LIVE_WORKFLOW_REQUEST_FAILURES = {
  notVerbatim:
    "DocsFab refused the workflow request (live-workflow-request-not-verbatim): instruction must be the user's consecutive messages ending at the current one, copied unchanged and joined by a blank line, with none skipped. Put your own additions in context.",
  contextCredentials:
    "DocsFab refused the workflow request (live-workflow-context-credential-material): the context contains one of DocsFab's own configured credentials. Remove it from context and retry.",
} as const;

/** Separator between whole user messages in a multi-message instruction. */
export const VERBATIM_MESSAGE_SEPARATOR = "\n\n";

/**
 * How many consecutive operator messages, ending at the last one, `instruction`
 * joins verbatim; `undefined` when it is not such a run.
 *
 * The run must end at the anchor message and skip nothing: dropping a later
 * narrowing message or a middle one would widen or change scope.
 */
export function verbatimOperatorMessageCount(
  instruction: string,
  messages: readonly string[],
): number | undefined {
  const text = instruction.trim();
  if (text === "" || messages.length === 0) return undefined;
  for (let start = messages.length - 1; start >= 0; start -= 1) {
    if (messages.slice(start).join(VERBATIM_MESSAGE_SEPARATOR) === text) {
      return messages.length - start;
    }
  }
  return undefined;
}

/** The operator-facing line for context cut at `liveAgent.workflowContextMaxChars`. */
export function liveWorkflowContextClipNotice(clip: {
  readonly omittedChars: number;
  readonly maxChars: number;
}): string {
  return `Context clipped (live-agent-workflow-context-max-chars-bound): the agent's workflow context was cut at liveAgent.workflowContextMaxChars = ${clip.maxChars} characters; ${clip.omittedChars} characters were left out. Your instruction was not cut.`;
}
