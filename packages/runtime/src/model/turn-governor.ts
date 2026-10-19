// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import type {
  InferenceEvidenceIdentity,
  InferenceOutputAuthorityEvidence,
  InferenceTurnEvidence,
} from "../records/contracts.js";
import {
  ContextBudgetError,
  describeModelRequestTokens,
  estimateTranscriptTokens,
  preflightContextBudget,
  type ContextBudgetInput,
  type ContextBudgetResult,
} from "./context-budget.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;
const TRANSIENT_MESSAGE_FIELDS = new Set([
  "api",
  "errorMessage",
  "model",
  "provider",
  "stopReason",
  "timestamp",
  "usage",
]);

export interface TurnRequestContext {
  systemPrompt?: string;
  messages: readonly unknown[];
  tools?: readonly unknown[];
}

export interface TurnGovernorPolicy {
  budget: Omit<ContextBudgetInput, "estimatedInputTokens" | "requestedOutputTokens">;
  /** Skip DocsFab input admission; the provider is the context ceiling. */
  skipHostContextAdmission?: boolean;
  /** Completed provider turns allowed before another request is stopped. */
  maxProviderTurns?: number;
  /** A request after more than this many completed tool calls is stopped. */
  maxToolCalls?: number;
  /** Maximum deterministic local compactions in one inference attempt. */
  maxCompactions?: number;
  /** Whole-attempt turn/tool/compaction caps are intentionally absent. */
  aggregatePolicy?: { kind: "absent" };
  /** Complete recent assistant/tool-result groups that must remain verbatim. */
  minRecentToolTurns: number;
}

export interface TurnGovernorState {
  /** Provider requests already authorized in this inference attempt. */
  providerTurns: number;
  toolCalls: number;
  toolResults: number;
  compactions: number;
  /**
   * Tool-call identities removed by earlier compactions in this attempt.
   * Compaction shapes only the request; Pi rebuilds every request from the full
   * transcript, so the removal is re-applied before estimating and sending to
   * keep the usage anchor and the request describing one prefix.
   */
  removedToolCallIds?: readonly string[];
}

export type ToolEvidenceOutcome = "succeeded" | "denied" | "failed";

/** Host-derived metadata for preserving an otherwise content-bearing tool result. */
export interface TurnToolEvidence {
  toolCallId: string;
  toolName: string;
  outcome: ToolEvidenceOutcome;
  /** Repository-relative citations or opaque evidence IDs retained in the compacted request. */
  citations: readonly string[];
}

/**
 * The host's cumulative output-token authority for the attempt this turn
 * belongs to, read immediately before the turn is governed.
 */
export interface OutputTokenAuthorityInput {
  /** Cumulative output tokens the lease may spend across the whole attempt. */
  maxOutputTokens: number;
  /** Output tokens the lease has already charged in this attempt. */
  cumulativeOutputTokens: number;
}

/**
 * Output tokens a governed turn must still be able to emit, on top of
 * `requiredMinimumOutputTokens`, to be worth sending. A smaller remainder of
 * cumulative authority cannot carry one ordinary tool-calling turn and would
 * only produce a length-truncated answer, so the turn stops instead of being
 * clamped to it. 1,024 is 64 times the 16-token provider minimum and matches
 * measured per-turn output of tool-calling review steps (about 500 to 1,100).
 */
export const OUTPUT_AUTHORITY_FLOOR_TOKENS = 1_024;

export interface GovernTurnInput {
  context: TurnRequestContext;
  policy: TurnGovernorPolicy;
  state: TurnGovernorState;
  evidenceIdentity: InferenceEvidenceIdentity;
  /** Number of leading messages that contain the request and selected evidence. */
  pinnedMessageCount: number;
  toolEvidence?: readonly TurnToolEvidence[];
  requestedOutputTokens?: number;
  /**
   * Remaining cumulative output authority, when the host has one. A remainder
   * below the per-turn output limit clamps the request; a remainder below
   * `requiredMinimumOutputTokens + OUTPUT_AUTHORITY_FLOOR_TOKENS` stops the turn
   * with reason `output-authority-exhausted`. Either outcome is recorded on the
   * turn as `outputAuthority`.
   */
  outputAuthority?: OutputTokenAuthorityInput;
  /** Observed cache state is deliberately excluded from request and budget identity. */
  cacheDisposition?: "disabled" | "hit" | "miss" | "rejected";
}

/** `GovernTurnInput` after the output authority has been applied to the request. */
interface BoundTurnInput extends GovernTurnInput {
  /** Present only when the authority bound this turn; copied onto the evidence. */
  outputAuthorityEvidence?: InferenceOutputAuthorityEvidence;
}

export interface GovernTurnDecision {
  /** The original or deterministically compacted context to pass to the provider. */
  context: TurnRequestContext;
  /** State after committing this decision; stopped decisions do not consume a turn. */
  nextState: TurnGovernorState;
  evidence: InferenceTurnEvidence;
}

interface ToolTurnGroup {
  start: number;
  end: number;
  /** The exact message objects of this group, by reference. */
  messages: readonly unknown[];
  calls: Array<{ id: string; name: string; result: unknown }>;
}

interface ToolTurnGroups {
  groups: ToolTurnGroup[];
  unsafeEvidence: boolean;
}

interface CompactionLedger {
  message: unknown;
  citationCount: number;
  citationDigest: string;
}

interface CompactionCandidate {
  context: TurnRequestContext;
  estimate: number;
  budget: ContextBudgetResult;
  removedMessages: number;
  citationCount: number;
  citationDigest: string;
  removedToolCallIds: readonly string[];
}

interface BudgetFailure {
  estimatedInputTokens: number;
  availableOutputTokens: number;
}

/**
 * Govern one exact provider request without retaining prompt or repository content
 * in its diagnostic. The function is pure: cache state, clocks, and host paths do
 * not influence request identity or the compact/proceed/stop decision.
 */
export function governProviderTurn(rawInput: GovernTurnInput): GovernTurnDecision {
  validateInput(rawInput);
  const input = bindOutputAuthority(rawInput);
  const evidenceIdentity = normalizeEvidenceIdentity(input.evidenceIdentity);
  const evidenceDigest = digest(evidenceIdentity);
  const fullContext = cloneContext(input.context);
  const toolEvidence = new Map((input.toolEvidence ?? []).map((item) => [item.toolCallId, item]));
  const nextTurn = input.state.providerTurns + 1;

  // Ambiguous provider-controlled tool identities must fail closed even when
  // the request already fits. Waiting until compaction would authorize a
  // malformed request and make the later evidence ledger non-authoritative.
  const groupedTurns = completeToolTurnGroups(fullContext.messages, input.pinnedMessageCount);

  // Re-apply every earlier compaction before anything else looks at the
  // request. The provider was billed for the compacted prefix, so the estimate,
  // the digest, the group analysis and the payload all have to describe that
  // same prefix; the session transcript still holds the removed groups.
  const persisted = persistedRemoval(
    fullContext,
    groupedTurns.groups,
    input.state.removedToolCallIds,
  );
  const replayed = persisted.groups.length
    ? compactedRequest(
        fullContext,
        input.pinnedMessageCount,
        persisted.groups,
        toolEvidence,
        evidenceIdentity,
      )
    : { context: fullContext };
  const originalContext = replayed.context ?? fullContext;
  const beforeRequestDigest = requestDigest(originalContext);
  const beforeDescribed = describeTurnRequestTokens(originalContext);
  const beforeEstimate = beforeDescribed.estimatedInputTokens;
  const beforeBudget = budget(input, beforeEstimate);

  if (
    input.policy.maxProviderTurns !== undefined &&
    input.state.providerTurns >= input.policy.maxProviderTurns
  ) {
    return stopped(
      input,
      originalContext,
      evidenceDigest,
      beforeRequestDigest,
      beforeEstimate,
      beforeBudget,
      "provider-turn-limit",
    );
  }
  if (
    input.policy.maxToolCalls !== undefined &&
    input.state.toolCalls > input.policy.maxToolCalls
  ) {
    return stopped(
      input,
      originalContext,
      evidenceDigest,
      beforeRequestDigest,
      beforeEstimate,
      beforeBudget,
      "tool-call-limit",
    );
  }

  // A removed identity that is still in the transcript but could not be removed
  // again -- its group is no longer complete, or its evidence has gone -- means
  // the anchor and the request can no longer be reconciled. Proceeding would
  // charge those messages at zero.
  if (groupedTurns.unsafeEvidence || persisted.unresolved || replayed.context === undefined) {
    return stopped(
      input,
      originalContext,
      evidenceDigest,
      beforeRequestDigest,
      beforeEstimate,
      beforeBudget,
      "evidence-preservation-required",
    );
  }

  // Too little cumulative output authority is left for one more useful turn.
  // Stop by name before any provider traffic; the host preflight would
  // otherwise refuse one layer down and surface as a provider failure.
  if (outputAuthorityExhausted(input)) {
    return stopped(
      input,
      originalContext,
      evidenceDigest,
      beforeRequestDigest,
      beforeEstimate,
      beforeBudget,
      "output-authority-exhausted",
    );
  }

  if (!(beforeBudget instanceof ContextBudgetError)) {
    return {
      context: originalContext,
      nextState: {
        ...input.state,
        providerTurns: nextTurn,
        ...(persisted.ids.length ? { removedToolCallIds: persisted.ids } : {}),
      },
      evidence: turnEvidence({
        input,
        budget: beforeBudget,
        estimatedInputTokens: beforeEstimate,
        decision: "proceed",
        requestDigest: beforeRequestDigest,
        evidenceDigest,
      }),
    };
  }

  if (
    input.policy.maxCompactions !== undefined &&
    input.state.compactions >= input.policy.maxCompactions
  ) {
    return stopped(
      input,
      originalContext,
      evidenceDigest,
      beforeRequestDigest,
      beforeEstimate,
      beforeBudget,
      "compaction-limit",
    );
  }

  // Groups an earlier compaction already removed are gone from the request and
  // must not be offered again; what is left is what this turn may still drop.
  const liveGroups = groupedTurns.groups.filter((group) => !persisted.removed.has(group));
  const removable = liveGroups.slice(
    0,
    Math.max(0, liveGroups.length - input.policy.minRecentToolTurns),
  );
  if (removable.length === 0) {
    return stopped(
      input,
      originalContext,
      evidenceDigest,
      beforeRequestDigest,
      beforeEstimate,
      beforeBudget,
      "context-exhausted",
    );
  }

  const headroomTarget = compactionHeadroomTarget(input.policy.budget);
  const removed: ToolTurnGroup[] = [];
  let best: CompactionCandidate | undefined;
  for (const group of removable) {
    removed.push(group);
    // One ledger describes every group removed so far in this attempt, so a
    // replayed compaction and a freshly extended one produce the same request.
    const union = [...persisted.groups, ...removed];
    const candidate = compactedRequest(
      fullContext,
      input.pinnedMessageCount,
      union,
      toolEvidence,
      evidenceIdentity,
    );
    if (!candidate.context || !candidate.ledger) {
      return stopped(
        input,
        originalContext,
        evidenceDigest,
        beforeRequestDigest,
        beforeEstimate,
        beforeBudget,
        "evidence-preservation-required",
      );
    }
    const afterEstimate = compactedEstimate(
      originalContext,
      beforeDescribed,
      candidate.context,
      removed,
      candidate.ledger.message,
    );
    const afterBudget = budget(input, afterEstimate);
    if (afterBudget instanceof ContextBudgetError) continue;
    best = {
      context: candidate.context,
      estimate: afterEstimate,
      budget: afterBudget,
      removedMessages: union.reduce((total, item) => total + item.end - item.start, 0),
      citationCount: candidate.ledger.citationCount,
      citationDigest: candidate.ledger.citationDigest,
      removedToolCallIds: uniqueSorted(union.flatMap((item) => item.calls.map((call) => call.id))),
    };
    // Enough of the budget is free that the next tool result cannot immediately
    // demand another compaction. Removing more would discard evidence for no
    // reason, so this is the compaction to authorize.
    if (afterEstimate <= headroomTarget) break;
  }

  if (!best) {
    return stopped(
      input,
      originalContext,
      evidenceDigest,
      beforeRequestDigest,
      beforeEstimate,
      beforeBudget,
      "context-exhausted",
    );
  }

  // Every removable turn has been dropped and the request either did not shrink
  // or still sits against the ceiling. Another compaction next turn would find
  // strictly less to remove, so the whole remaining compaction budget would be
  // spent reaching the same place. Stop once, naming the reason.
  if (best.estimate >= beforeEstimate || best.estimate > headroomTarget) {
    return stopped(
      input,
      originalContext,
      evidenceDigest,
      beforeRequestDigest,
      beforeEstimate,
      beforeBudget,
      "compaction-ineffective",
    );
  }

  const afterRequestDigest = requestDigest(best.context);
  return {
    context: best.context,
    nextState: {
      ...input.state,
      providerTurns: nextTurn,
      compactions: input.state.compactions + 1,
      removedToolCallIds: best.removedToolCallIds,
    },
    evidence: turnEvidence({
      input,
      budget: best.budget,
      estimatedInputTokens: best.estimate,
      decision: "compact",
      requestDigest: afterRequestDigest,
      evidenceDigest,
      compaction: {
        beforeRequestDigest,
        afterRequestDigest,
        estimatedInputTokensBefore: beforeEstimate,
        estimatedInputTokensAfter: best.estimate,
        removedMessages: best.removedMessages,
        retainedMessages: best.context.messages.length,
        preservedCitationCount: best.citationCount,
        preservedCitationDigest: best.citationDigest,
      },
    }),
  };
}

/**
 * Apply the host's remaining cumulative output authority to this request.
 *
 * It binds only when the remainder is below the output the turn would request;
 * otherwise the input is untouched and nothing is recorded. A binding authority
 * clamps `requestedOutputTokens` to the remainder or, below
 * `requiredMinimumOutputTokens + OUTPUT_AUTHORITY_FLOOR_TOKENS`, leaves the
 * request for `governProviderTurn` to stop by name. Both record the same
 * `outputAuthority` evidence so the arithmetic can be redone from the record.
 */
function bindOutputAuthority(input: GovernTurnInput): BoundTurnInput {
  const authority = input.outputAuthority;
  if (authority === undefined) return input;
  const { effectiveMaxOutputTokens, requiredMinimumOutputTokens } = input.policy.budget;
  const remaining = authority.maxOutputTokens - authority.cumulativeOutputTokens;
  const wouldRequest = Math.min(
    input.requestedOutputTokens ?? effectiveMaxOutputTokens,
    effectiveMaxOutputTokens,
  );
  if (remaining >= wouldRequest) return input;
  const outputAuthorityEvidence: InferenceOutputAuthorityEvidence = {
    maxOutputTokens: authority.maxOutputTokens,
    cumulativeOutputTokens: authority.cumulativeOutputTokens,
    floorOutputTokens: requiredMinimumOutputTokens + OUTPUT_AUTHORITY_FLOOR_TOKENS,
  };
  if (remaining < outputAuthorityEvidence.floorOutputTokens) {
    return { ...input, outputAuthorityEvidence };
  }
  return { ...input, requestedOutputTokens: remaining, outputAuthorityEvidence };
}

function outputAuthorityExhausted(input: BoundTurnInput): boolean {
  const evidence = input.outputAuthorityEvidence;
  return (
    evidence !== undefined &&
    evidence.maxOutputTokens - evidence.cumulativeOutputTokens < evidence.floorOutputTokens
  );
}

interface PersistedRemoval {
  /** Groups an earlier compaction removed, still present in this transcript. */
  groups: ToolTurnGroup[];
  /** The same group objects, for identity comparison against the live list. */
  removed: Set<ToolTurnGroup>;
  /** Normalized identities to carry forward unchanged. */
  ids: readonly string[];
  /** A carried identity is still in the transcript but no longer removable. */
  unresolved: boolean;
}

/**
 * Resolve the identities earlier compactions removed against this transcript.
 *
 * An identity that no longer appears at all is simply gone -- a host that
 * rewrites its own transcript needs no replay. An identity that is still
 * present but whose complete assistant/tool-result group can no longer be
 * formed cannot be removed again, and the anchor would then cover messages the
 * provider never received, so the caller fails closed.
 */
function persistedRemoval(
  context: TurnRequestContext,
  groups: readonly ToolTurnGroup[],
  removedToolCallIds: readonly string[] | undefined,
): PersistedRemoval {
  const ids = uniqueSorted([...(removedToolCallIds ?? [])]);
  if (ids.length === 0) {
    return { groups: [], removed: new Set(), ids: [], unresolved: false };
  }
  const wanted = new Set(ids);
  const selected = groups.filter((group) => group.calls.some((call) => wanted.has(call.id)));
  // A group is only removable as a whole; a partial match means the transcript
  // no longer agrees with the compaction that produced the anchor.
  const partial = selected.some((group) => !group.calls.every((call) => wanted.has(call.id)));
  const resolved = new Set(selected.flatMap((group) => group.calls.map((call) => call.id)));
  const stillPresent = new Set(
    toolCallIdsIn(context.messages).filter((id) => wanted.has(id) && !resolved.has(id)),
  );
  return {
    groups: selected,
    removed: new Set(selected),
    ids,
    unresolved: partial || stillPresent.size > 0,
  };
}

function toolCallIdsIn(messages: readonly unknown[]): string[] {
  return messages.flatMap((message) => {
    const item = record(message);
    if (!item) return [];
    if (item.role === "toolResult" && typeof item.toolCallId === "string") return [item.toolCallId];
    if (item.role !== "assistant") return [];
    return toolCalls(item).map((call) => call.id);
  });
}

interface CompactedRequest {
  /** Absent when the removed groups have no complete evidence ledger. */
  context?: TurnRequestContext;
  ledger?: CompactionLedger;
}

/** Build the exact request for one removal set: transcript minus groups, plus one ledger. */
function compactedRequest(
  context: TurnRequestContext,
  pinnedMessageCount: number,
  removed: readonly ToolTurnGroup[],
  evidenceByCall: ReadonlyMap<string, TurnToolEvidence>,
  identity: InferenceEvidenceIdentity,
): CompactedRequest {
  const ledger = compactionLedger(removed, evidenceByCall, identity);
  if (!ledger) return {};
  return { context: compacted(context, pinnedMessageCount, removed, ledger.message), ledger };
}

/** Largest estimate a compaction may settle at and still count as effective. */
function compactionHeadroomTarget(values: TurnGovernorPolicy["budget"]): number {
  const available = Math.max(0, values.effectiveMaxInputTokens - values.reservedTokens);
  return (
    available -
    Math.ceil((available * COMPACTION_HEADROOM_NUMERATOR) / COMPACTION_HEADROOM_DENOMINATOR)
  );
}

/** Stable SHA-256 over only fields that are material to a provider request. */
export function requestDigest(context: TurnRequestContext): string {
  return digest(requestProjection(context));
}

/**
 * Safety margin on content the provider has not billed yet. The base estimate
 * is four characters per token, but DocsFab traffic (Markdown, code, JSON tool
 * arguments) tokenizes nearer three, so 5/4 brings the effective ratio to 3.2.
 * The provider-reported prefix needs no margin.
 */
const UNREPORTED_MARGIN_NUMERATOR = 5;
const UNREPORTED_MARGIN_DENOMINATOR = 4;

/**
 * Fraction of the input budget a compaction must leave free. A compaction that
 * lands just under the ceiling is needed again after the next tool result and
 * burns the compaction limit with no work done, so one that cannot free a
 * quarter of the budget fails closed.
 */
const COMPACTION_HEADROOM_NUMERATOR = 1;
const COMPACTION_HEADROOM_DENOMINATOR = 4;

export interface TurnRequestEstimate {
  estimatedInputTokens: number;
  /** True when a provider-reported usage snapshot anchors the estimate. */
  calibrated: boolean;
  /** Index of the anchoring assistant message; -1 when the transcript has none. */
  anchorIndex: number;
  /** Provider-reported tokens for the prefix through `anchorIndex`. */
  reportedPrefixTokens: number;
  /** Estimate of the same request with no provider-reported anchor. */
  structuralEstimatedInputTokens: number;
}

/**
 * Estimate one provider request, calibrated against the provider's own numbers.
 *
 * The provider-reported prefix anchors the estimate, and only content appended
 * since is estimated, with the margin; with no report yet the whole request is
 * estimated that way. Only provider-visible content blocks count: tool metadata
 * such as Pi's `ToolResultMessage.details` never reaches the provider.
 * `requestDigest` excludes usage, so request identity stays stable.
 */
export function describeTurnRequestTokens(context: TurnRequestContext): TurnRequestEstimate {
  const described = describeModelRequestTokens({
    ...(context.systemPrompt === undefined ? {} : { systemPrompt: context.systemPrompt }),
    messages: context.messages,
    // Tool definitions carry host callbacks no provider request can contain;
    // project them away, as `requestDigest` does, so a host function moves
    // neither request identity nor the budget decision.
    ...(context.tools === undefined
      ? {}
      : { tools: context.tools.map(projectValue).filter((value) => value !== undefined) }),
  });
  // Floor the reported prefix at its un-margined character estimate so a stale
  // or partial report can only raise the estimate, never collapse it. On a
  // healthy turn the reported figure is larger and the floor is inert.
  const reportedPrefixTokens = Math.max(
    described.reportedPrefixTokens,
    described.anchorIndex < 0 ? 0 : described.anchoredPrefixStructuralTokens,
  );
  return {
    estimatedInputTokens: reportedPrefixTokens + withMargin(described.unreportedTokens),
    calibrated: described.anchorIndex >= 0,
    anchorIndex: described.anchorIndex,
    reportedPrefixTokens,
    structuralEstimatedInputTokens: withMargin(described.structuralTokens),
  };
}

export function estimateTurnRequestTokens(context: TurnRequestContext): number {
  return describeTurnRequestTokens(context).estimatedInputTokens;
}

function withMargin(tokens: number): number {
  return Math.ceil((tokens * UNREPORTED_MARGIN_NUMERATOR) / UNREPORTED_MARGIN_DENOMINATOR);
}

/**
 * Estimate a compacted request when the anchoring response survived compaction.
 *
 * The anchor still counts the removed tool turns, so they are subtracted at the
 * uncalibrated rate, without the margin so the subtraction stays the smaller
 * plausible figure. The result is floored at the uncalibrated estimate of what
 * is left.
 */
function compactedEstimate(
  before: TurnRequestContext,
  beforeEstimate: TurnRequestEstimate,
  compactedContext: TurnRequestContext,
  removed: readonly ToolTurnGroup[],
  ledger: unknown,
): number {
  const after = describeTurnRequestTokens(compactedContext);
  if (after.anchorIndex < 0 || beforeEstimate.anchorIndex < 0) return after.estimatedInputTokens;
  // Positions are resolved against the request this turn started from -- the
  // one the anchor was billed for -- because the removed groups are indexed
  // against the full session transcript, which may still hold earlier removals.
  const removedFromPrefix: unknown[] = [];
  for (const group of removed) {
    for (const message of group.messages) {
      const index = before.messages.indexOf(message);
      if (index >= 0 && index <= beforeEstimate.anchorIndex) removedFromPrefix.push(message);
    }
  }
  // The ledger is inserted ahead of the surviving anchor, so the anchored walk
  // treats it as part of the reported prefix. It is new content the provider has
  // never billed and has to be added back explicitly.
  const ledgerTokens = withMargin(estimateTranscriptTokens([ledger]));
  return Math.max(
    after.structuralEstimatedInputTokens,
    after.estimatedInputTokens + ledgerTokens - estimateTranscriptTokens(removedFromPrefix),
  );
}

function budget(
  input: GovernTurnInput,
  estimatedInputTokens: number,
): ContextBudgetResult | ContextBudgetError {
  if (input.policy.skipHostContextAdmission) {
    const outputTokens =
      input.requestedOutputTokens ?? input.policy.budget.effectiveMaxOutputTokens;
    return {
      ...input.policy.budget,
      estimatedInputTokens,
      availableInputTokens: estimatedInputTokens,
      availableOutputTokens: outputTokens,
      outputTokens,
      minimumApplied: false,
    };
  }
  try {
    return preflightContextBudget({
      ...input.policy.budget,
      estimatedInputTokens,
      ...(input.requestedOutputTokens === undefined
        ? {}
        : { requestedOutputTokens: input.requestedOutputTokens }),
    });
  } catch (error) {
    if (error instanceof ContextBudgetError) return error;
    throw error;
  }
}

function stopped(
  input: BoundTurnInput,
  context: TurnRequestContext,
  evidenceDigest: string,
  currentRequestDigest: string,
  estimatedInputTokens: number,
  currentBudget: ContextBudgetResult | ContextBudgetError,
  reason: NonNullable<InferenceTurnEvidence["reason"]>,
): GovernTurnDecision {
  const failure = budgetFailure(currentBudget, estimatedInputTokens);
  return {
    context,
    nextState: { ...input.state },
    evidence: turnEvidence({
      input,
      budget: currentBudget,
      estimatedInputTokens: failure.estimatedInputTokens,
      availableOutputTokens: failure.availableOutputTokens,
      decision: "stop",
      reason,
      requestDigest: currentRequestDigest,
      evidenceDigest,
    }),
  };
}

function turnEvidence(options: {
  input: BoundTurnInput;
  budget: ContextBudgetResult | ContextBudgetError;
  estimatedInputTokens: number;
  availableOutputTokens?: number;
  decision: InferenceTurnEvidence["decision"];
  reason?: InferenceTurnEvidence["reason"];
  requestDigest: string;
  evidenceDigest: string;
  compaction?: InferenceTurnEvidence["compaction"];
}): InferenceTurnEvidence {
  const values = options.input.policy.budget;
  const availableOutputTokens =
    options.availableOutputTokens ??
    (options.budget instanceof ContextBudgetError
      ? options.budget.diagnostic.availableOutputTokens
      : options.budget.availableOutputTokens);
  const availableInputTokens =
    options.budget instanceof ContextBudgetError
      ? options.budget.diagnostic.availableInputTokens
      : options.budget.availableInputTokens;
  return {
    contextBudgetSchemaVersion: 2,
    ...(options.input.policy.skipHostContextAdmission
      ? { contextAdmission: "provider" as const }
      : {}),
    turn: options.input.state.providerTurns + 1,
    toolCalls: options.input.state.toolCalls,
    toolResults: options.input.state.toolResults,
    ...(options.input.policy.maxProviderTurns === undefined
      ? {}
      : { maxProviderTurns: options.input.policy.maxProviderTurns }),
    ...(options.input.policy.maxToolCalls === undefined
      ? {}
      : { maxToolCalls: options.input.policy.maxToolCalls }),
    ...(options.input.policy.maxCompactions === undefined
      ? {}
      : { maxCompactions: options.input.policy.maxCompactions }),
    ...(options.input.policy.aggregatePolicy
      ? { aggregatePolicy: options.input.policy.aggregatePolicy }
      : {}),
    compactions: options.input.state.compactions,
    configuredContextWindow: values.configuredContextWindow,
    effectiveContextWindow: values.effectiveContextWindow,
    configuredMaxInputTokens: values.configuredMaxInputTokens,
    effectiveMaxInputTokens: values.effectiveMaxInputTokens,
    configuredMaxOutputTokens: values.configuredMaxOutputTokens,
    effectiveMaxOutputTokens: values.effectiveMaxOutputTokens,
    reservedTokens: values.reservedTokens,
    estimatedInputTokens: options.estimatedInputTokens,
    availableInputTokens,
    availableOutputTokens,
    requiredMinimumOutputTokens: values.requiredMinimumOutputTokens,
    ...(options.input.requestedOutputTokens === undefined
      ? {}
      : { requestedOutputTokens: options.input.requestedOutputTokens }),
    // Do not write the `max_tokens` grant onto `outputTokens`. That field is
    // tokens produced, bound from charged usage before the record is emitted.
    // The grant stays reconstructable via `grantedTurnOutputTokens`.
    // Missing usage must omit the field rather than look like full consumption.
    ...(options.input.outputAuthorityEvidence === undefined
      ? {}
      : { outputAuthority: { ...options.input.outputAuthorityEvidence } }),
    decision: options.decision,
    ...(options.reason ? { reason: options.reason } : {}),
    requestDigest: options.requestDigest,
    evidenceDigest: options.evidenceDigest,
    ...(options.compaction ? { compaction: options.compaction } : {}),
  };
}

function budgetFailure(
  value: ContextBudgetResult | ContextBudgetError,
  estimatedInputTokens: number,
): BudgetFailure {
  return value instanceof ContextBudgetError
    ? {
        estimatedInputTokens: value.diagnostic.estimatedInputTokens,
        availableOutputTokens: value.diagnostic.availableOutputTokens,
      }
    : { estimatedInputTokens, availableOutputTokens: value.availableOutputTokens };
}

function completeToolTurnGroups(
  messages: readonly unknown[],
  pinnedMessageCount: number,
): ToolTurnGroups {
  const groups: ToolTurnGroup[] = [];
  const seenCallIds = new Set<string>();
  const seenResultIds = new Set<string>();
  let unsafeEvidence = false;
  for (let index = pinnedMessageCount; index < messages.length; index += 1) {
    const assistant = record(messages[index]);
    if (assistant?.role === "toolResult") {
      unsafeEvidence = true;
      continue;
    }
    if (assistant?.role !== "assistant") continue;
    const calls = toolCalls(assistant);
    if (calls.length === 0) continue;
    const callIds = calls.map((call) => call.id);
    if (new Set(callIds).size !== callIds.length || callIds.some((id) => seenCallIds.has(id))) {
      unsafeEvidence = true;
    }
    for (const id of callIds) seenCallIds.add(id);

    const results: Array<{ id: string; name: string; value: unknown }> = [];
    let end = index + 1;
    while (end < messages.length) {
      const result = record(messages[end]);
      if (result?.role !== "toolResult") break;
      if (
        typeof result.toolCallId !== "string" ||
        !result.toolCallId ||
        typeof result.toolName !== "string" ||
        !result.toolName
      ) {
        unsafeEvidence = true;
      } else {
        results.push({
          id: result.toolCallId,
          name: result.toolName,
          value: messages[end],
        });
      }
      end += 1;
    }
    const resultIds = results.map((result) => result.id);
    if (
      new Set(resultIds).size !== resultIds.length ||
      resultIds.some((id) => seenResultIds.has(id))
    ) {
      unsafeEvidence = true;
    }
    for (const id of resultIds) seenResultIds.add(id);
    const resultsById = new Map(results.map((result) => [result.id, result]));
    const oneToOne =
      results.length === calls.length &&
      calls.every((call) => {
        const result = resultsById.get(call.id);
        return result?.name === call.name;
      });
    if (!oneToOne) {
      unsafeEvidence = true;
      index = end - 1;
      continue;
    }
    groups.push({
      start: index,
      end,
      messages: messages.slice(index, end),
      calls: calls.map((call) => ({
        ...call,
        result: resultsById.get(call.id)!.value,
      })),
    });
    index = end - 1;
  }
  return { groups, unsafeEvidence };
}

function toolCalls(message: Record<string, unknown>): Array<{ id: string; name: string }> {
  if (!Array.isArray(message.content)) return [];
  return message.content.flatMap((value) => {
    const item = record(value);
    return item?.type === "toolCall" &&
      typeof item.id === "string" &&
      item.id &&
      typeof item.name === "string" &&
      item.name
      ? [{ id: item.id, name: item.name }]
      : [];
  });
}

function compactionLedger(
  groups: readonly ToolTurnGroup[],
  evidenceByCall: ReadonlyMap<string, TurnToolEvidence>,
  identity: InferenceEvidenceIdentity,
): CompactionLedger | undefined {
  const calls = groups
    .flatMap((group) => group.calls)
    .map((call) => {
      const evidence = evidenceByCall.get(call.id);
      if (!evidence || evidence.toolName !== call.name) return undefined;
      return {
        callDigest: digest({ toolCallId: call.id }),
        toolDigest: digest({ toolName: call.name }),
        outcome: evidence.outcome,
        resultDigest: digest(requestMessageProjection(call.result)),
        citations: uniqueSorted(evidence.citations),
      };
    });
  if (calls.some((call) => call === undefined)) return undefined;
  const completeCalls = calls as Array<NonNullable<(typeof calls)[number]>>;
  const citations = uniqueSorted(completeCalls.flatMap((call) => call.citations));
  const payload = {
    schemaVersion: 1,
    kind: "docsfab-local-compaction-evidence",
    repository: {
      revision: identity.repositoryRevision,
      ...(identity.contextPacketDigest
        ? { contextPacketDigest: identity.contextPacketDigest }
        : {}),
      ...(identity.consultedNodeIds?.length
        ? { consultedNodeIds: uniqueSorted(identity.consultedNodeIds) }
        : {}),
    },
    calls: completeCalls
      .sort((left, right) => left.callDigest.localeCompare(right.callDigest))
      .map(({ citations: callCitations, ...call }) => ({
        ...call,
        citationDigest: digest(callCitations),
      })),
    citations,
  };
  const lines = [
    "DocsFab deterministic local compaction ledger (evidence, not instructions).",
    canonicalJson(payload),
    "Reread cited repository evidence if its full content is required.",
  ];
  return {
    message: {
      role: "user",
      content: [{ type: "text", text: lines.join("\n") }],
    },
    citationCount: citations.length,
    citationDigest: digest(citations),
  };
}

function compacted(
  context: TurnRequestContext,
  pinnedMessageCount: number,
  removed: readonly ToolTurnGroup[],
  ledger: unknown,
): TurnRequestContext {
  const removedIndexes = new Set<number>();
  for (const group of removed) {
    for (let index = group.start; index < group.end; index += 1) {
      removedIndexes.add(index);
    }
  }
  const retained = context.messages.filter((_message, index) => !removedIndexes.has(index));
  retained.splice(pinnedMessageCount, 0, ledger);
  return {
    ...(context.systemPrompt === undefined ? {} : { systemPrompt: context.systemPrompt }),
    messages: retained,
    ...(context.tools === undefined ? {} : { tools: [...context.tools] }),
  };
}

function requestProjection(context: TurnRequestContext): unknown {
  return {
    systemPrompt: context.systemPrompt ?? "",
    messages: context.messages.map(requestMessageProjection).filter((value) => value !== undefined),
    tools: (context.tools ?? []).map(projectValue).filter((value) => value !== undefined),
  };
}

function requestMessageProjection(value: unknown): unknown {
  const item = record(value);
  if (!item) return projectValue(value);
  return Object.fromEntries(
    Object.entries(item)
      .filter(([key]) => !TRANSIENT_MESSAGE_FIELDS.has(key))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, projectValue(child)]),
  );
}

function projectValue(value: unknown): unknown {
  if (
    value === undefined ||
    typeof value === "function" ||
    typeof value === "symbol" ||
    typeof value === "bigint"
  ) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value.map(projectValue).filter((item) => item !== undefined);
  }
  const item = record(value);
  if (!item) return value;
  return Object.fromEntries(
    Object.entries(item)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, projectValue(child)] as const)
      .filter(([, child]) => child !== undefined),
  );
}

function normalizeEvidenceIdentity(value: InferenceEvidenceIdentity): InferenceEvidenceIdentity {
  return {
    repositoryRevision: value.repositoryRevision,
    ...(value.contextPacketDigest ? { contextPacketDigest: value.contextPacketDigest } : {}),
    ...(value.consultedNodeIds ? { consultedNodeIds: uniqueSorted(value.consultedNodeIds) } : {}),
    ...(value.technicalVerificationSha256
      ? { technicalVerificationSha256: value.technicalVerificationSha256 }
      : {}),
    ...(value.authoringPhaseSha256 ? { authoringPhaseSha256: value.authoringPhaseSha256 } : {}),
  };
}

function validateInput(input: GovernTurnInput): void {
  for (const [name, value] of Object.entries(input.state)) {
    if (name === "removedToolCallIds") continue;
    nonnegativeInteger(value, `state.${name}`);
  }
  if (input.state.removedToolCallIds !== undefined) {
    if (!Array.isArray(input.state.removedToolCallIds)) {
      throw new Error("state.removedToolCallIds must be an array of tool call IDs.");
    }
    for (const id of input.state.removedToolCallIds) {
      if (typeof id !== "string" || !id.trim() || CONTROL_CHARACTERS.test(id)) {
        throw new Error(
          "state.removedToolCallIds must be non-empty and cannot contain control characters.",
        );
      }
    }
  }
  const aggregateAbsent = input.policy.aggregatePolicy?.kind === "absent";
  for (const [name, value] of Object.entries(input.policy)) {
    if (name === "budget" || name === "skipHostContextAdmission" || name === "aggregatePolicy")
      continue;
    nonnegativeInteger(value, `policy.${name}`);
  }
  if (
    input.policy.aggregatePolicy !== undefined &&
    (Object.keys(input.policy.aggregatePolicy).length !== 1 || !aggregateAbsent)
  ) {
    throw new Error("policy.aggregatePolicy must be the exact absent aggregate marker.");
  }
  if (
    aggregateAbsent
      ? input.policy.maxProviderTurns !== undefined ||
        input.policy.maxToolCalls !== undefined ||
        input.policy.maxCompactions !== undefined
      : input.policy.maxProviderTurns === undefined ||
        input.policy.maxToolCalls === undefined ||
        input.policy.maxCompactions === undefined
  ) {
    throw new Error(
      "finite ceilings are required without the absent aggregate marker, and forbidden with it.",
    );
  }
  if (
    input.policy.skipHostContextAdmission !== undefined &&
    typeof input.policy.skipHostContextAdmission !== "boolean"
  ) {
    throw new Error("policy.skipHostContextAdmission must be a boolean when it is present.");
  }
  if (input.policy.maxProviderTurns !== undefined && input.policy.maxProviderTurns < 1)
    throw new Error("policy.maxProviderTurns must be positive.");
  if (input.policy.maxToolCalls !== undefined && input.policy.maxToolCalls < 1)
    throw new Error("policy.maxToolCalls must be positive.");
  if (input.outputAuthority !== undefined) {
    nonnegativeInteger(input.outputAuthority.maxOutputTokens, "outputAuthority.maxOutputTokens");
    nonnegativeInteger(
      input.outputAuthority.cumulativeOutputTokens,
      "outputAuthority.cumulativeOutputTokens",
    );
    if (input.outputAuthority.maxOutputTokens < 1) {
      throw new Error(
        "outputAuthority.maxOutputTokens must be a positive integer: a lease with no output authority cannot govern a provider turn.",
      );
    }
  }
  nonnegativeInteger(input.pinnedMessageCount, "pinnedMessageCount");
  if (input.pinnedMessageCount > input.context.messages.length) {
    throw new Error("pinnedMessageCount exceeds the message count.");
  }
  if (!input.evidenceIdentity.repositoryRevision.trim()) {
    throw new Error("evidenceIdentity.repositoryRevision must be non-empty.");
  }
  if (CONTROL_CHARACTERS.test(input.evidenceIdentity.repositoryRevision)) {
    throw new Error("evidenceIdentity.repositoryRevision cannot contain control characters.");
  }
  if (
    input.evidenceIdentity.contextPacketDigest !== undefined &&
    !SHA256.test(input.evidenceIdentity.contextPacketDigest)
  ) {
    throw new Error("evidenceIdentity.contextPacketDigest must be SHA-256.");
  }
  if (
    input.evidenceIdentity.consultedNodeIds?.some(
      (nodeId) => !nodeId.trim() || CONTROL_CHARACTERS.test(nodeId),
    )
  ) {
    throw new Error(
      "evidenceIdentity.consultedNodeIds must be non-empty and cannot contain control characters.",
    );
  }
  if (
    input.evidenceIdentity.technicalVerificationSha256 !== undefined &&
    !SHA256.test(input.evidenceIdentity.technicalVerificationSha256)
  ) {
    throw new Error("The evaluator technical verification identity must contain a SHA-256 digest.");
  }
  if (
    input.evidenceIdentity.authoringPhaseSha256 !== undefined &&
    !SHA256.test(input.evidenceIdentity.authoringPhaseSha256)
  ) {
    throw new Error("The CREATE authoring phase identity must contain a SHA-256 digest.");
  }
  const callIds = new Set<string>();
  for (const item of input.toolEvidence ?? []) {
    if (!item.toolCallId.trim() || !item.toolName.trim()) {
      throw new Error("toolEvidence identities must be non-empty.");
    }
    if (callIds.has(item.toolCallId)) throw new Error("toolEvidence call IDs must be unique.");
    callIds.add(item.toolCallId);
    if (item.citations.some((citation) => !citation.trim() || CONTROL_CHARACTERS.test(citation))) {
      throw new Error(
        "toolEvidence citations must be non-empty and cannot contain control characters.",
      );
    }
  }
}

function cloneContext(context: TurnRequestContext): TurnRequestContext {
  return {
    ...(context.systemPrompt === undefined ? {} : { systemPrompt: context.systemPrompt }),
    messages: [...context.messages],
    ...(context.tools === undefined ? {} : { tools: [...context.tools] }),
  };
}

function nonnegativeInteger(value: unknown, path: string): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${path} must be a non-negative safe integer.`);
  }
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(",")}}`;
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
