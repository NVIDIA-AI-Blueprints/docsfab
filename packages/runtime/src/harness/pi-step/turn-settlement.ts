// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Exact tool-batch settlement shared by the attempt's two turn-end callers. */
import { validatePiBatchSettlement, type PiProviderTurnUsageV1 } from "../pi-lease.js";
import { isPiUnexecutedToolBatchTurn } from "../pi-lease.js";
import { InferenceStepError } from "../../execution/contracts.js";
import { lengthStopRejection, outputLimitRemedy, type OutputLeaseClamp } from "../pi-offline.js";
import { qualitySubmissionCutFailure } from "../reply-admission/quality-artifact.js";
import { QUALITY_SUBMISSION_TOOL_NAME } from "../answer-submission.js";

type SettlementResult = { callSha256: string; outcome: "succeeded" | "failed" };
type ProviderToolResult = { toolCallId: string; isError: boolean };

export interface PiTurnSettlementBatch {
  readonly calls: readonly { id: string; name: string; sha256: string }[];
  readonly authorized: readonly string[];
  readonly preflighted: ReadonlySet<string>;
  readonly hostDenied: ReadonlySet<string>;
  readonly usage: PiProviderTurnUsageV1;
  settlementRecorded: boolean;
}

export interface PiTurnSettlementActions {
  readonly tombstone: (results: readonly SettlementResult[]) => "settle" | "duplicate-settle";
  readonly phase: () => "active" | "checkpoint-required" | string;
  readonly settleOrdinary: (usage: PiProviderTurnUsageV1) => void;
  readonly settleBoundary: (usage: PiProviderTurnUsageV1) => void;
  readonly settleToolBatch: (
    results: readonly SettlementResult[],
    usage: PiProviderTurnUsageV1,
  ) => void;
}

/** A zero-authorized batch was already settled by the host hook. */
export function settlePiPreviouslySettledBatch(
  batch: PiTurnSettlementBatch,
  toolResults: readonly ProviderToolResult[],
  actions: PiTurnSettlementActions,
): SettlementResult[] {
  const results = validatePiBatchSettlement(batch.calls, batch.authorized, toolResults);
  const settlement = actions.tombstone(results);
  if (!batch.settlementRecorded) {
    if (settlement !== "settle") {
      throw new Error("Pi execution lease lost its zero-authorized batch settlement.");
    }
    if (actions.phase() === "active") {
      actions.settleOrdinary(batch.usage);
    } else if (actions.phase() === "checkpoint-required") {
      actions.settleBoundary(batch.usage);
    } else {
      throw new Error("Pi execution lease could not account for a zero-authorized batch.");
    }
    batch.settlementRecorded = true;
  } else if (settlement !== "duplicate-settle") {
    throw new Error("Pi execution lease lost its settled tool-batch tombstone.");
  }
  return results;
}

/** Validate the complete host-observed vector before charging an active batch. */
export function settlePiActiveToolBatch(
  batch: PiTurnSettlementBatch,
  toolResults: readonly ProviderToolResult[],
  actions: PiTurnSettlementActions,
): SettlementResult[] {
  // The SDK can reject a name/schema before beforeToolCall even after
  // another call opened this lease batch. That result is not execution
  // evidence and cannot be charged as a host call.
  if (!batch.authorized.every((digest) => batch.preflighted.has(digest))) {
    throw new Error("Pi execution lease observed an unpreflighted tool result.");
  }
  const results = validatePiBatchSettlement(batch.calls, batch.authorized, toolResults);
  if ([...batch.hostDenied].some((digest) => batch.authorized.includes(digest))) {
    throw new Error("Pi execution lease observed a late authorization denial.");
  }
  actions.settleToolBatch(results, batch.usage);
  if (actions.tombstone(results) !== "settle") {
    throw new Error("Pi execution lease rejected a duplicate active batch settlement.");
  }
  batch.settlementRecorded = true;
  return results;
}

/** State read at this turn only; no provider messages or mutable lease state are cached. */
export interface PiUnexecutedToolTurn {
  readonly calls: readonly { readonly id: string; readonly name: string }[];
  readonly results: readonly ProviderToolResult[];
  readonly authoritySha256?: string;
  readonly turnKey: string;
  readonly providerTurn: number;
  readonly stepId: string;
  readonly lengthStopped: boolean;
  readonly consecutiveLengthStops: number;
  readonly toolPath: boolean;
  readonly submissionAbsent: boolean;
  readonly consumedOutputTokens: unknown;
  readonly maxConsecutiveLengthStops?: number;
  readonly leasePolicySchemaVersion: number;
}

export interface PiUnexecutedToolTurnActions {
  readonly phase: () => string;
  readonly rejectedTurns: Set<string>;
  readonly recordRejectedCalls: (count: number) => void;
  readonly chargeOrdinaryTurn: () => void;
  readonly readGovernedTurn: () =>
    | { readonly maxToolCalls?: number; readonly toolCalls: number }
    | undefined;
  readonly checkpointProviderTurnLimit: () => boolean;
  readonly outputTokenLimit: () => number;
  readonly outputLeaseClamp: () => OutputLeaseClamp | undefined;
  readonly stopEvidencePreservation: () => void;
  readonly stopProviderTerminal: () => void;
  readonly recordError: (error: Error) => void;
  readonly refuseCutSubmission: (error: InferenceStepError) => void;
  readonly admitSubmission: (identity: { turnKey: string; turn: number; count: number }) => void;
}

/**
 * Settle the SDK's complete failed call/result vector when no host preflight
 * opened a batch. Replay and output-cut decisions stay separate from executed
 * tool settlement, and the caller's attempt owns all mutable evidence.
 */
export function settlePiUnexecutedToolTurn(
  turn: PiUnexecutedToolTurn,
  actions: PiUnexecutedToolTurnActions,
): void {
  // An authority without a batch means the host hook failed mid-preflight;
  // only an active lease may charge an ordinary zero-tool provider turn.
  const unexecuted =
    turn.authoritySha256 === undefined &&
    isPiUnexecutedToolBatchTurn(turn.calls, turn.results) &&
    actions.phase() === "active";
  if (!unexecuted) {
    actions.stopEvidencePreservation();
    actions.recordError(
      new Error("Pi execution lease rejected an unknown or replayed tool batch."),
    );
    return;
  }
  if (actions.rejectedTurns.has(turn.turnKey)) {
    actions.stopEvidencePreservation();
    actions.recordError(
      new Error("Pi execution lease rejected a replayed pre-execution tool result."),
    );
    return;
  }
  actions.rejectedTurns.add(turn.turnKey);
  actions.recordRejectedCalls(turn.calls.length);
  actions.chargeOrdinaryTurn();
  if (
    turn.toolPath &&
    turn.submissionAbsent &&
    turn.calls.some((call) => call.name === QUALITY_SUBMISSION_TOOL_NAME)
  ) {
    if (turn.lengthStopped) {
      actions.stopProviderTerminal();
      actions.refuseCutSubmission(qualitySubmissionCutFailure(actions.outputTokenLimit()));
      return;
    }
    actions.admitSubmission({
      turnKey: turn.turnKey,
      turn: turn.providerTurn,
      count: turn.calls.length,
    });
    return;
  }
  const governedTurn = actions.readGovernedTurn();
  const requestedToolAllowanceSpent =
    governedTurn !== undefined &&
    governedTurn.maxToolCalls !== undefined &&
    governedTurn.toolCalls + turn.calls.length > governedTurn.maxToolCalls;
  if (
    turn.lengthStopped &&
    (requestedToolAllowanceSpent ||
      (turn.leasePolicySchemaVersion === 1 &&
        turn.consecutiveLengthStops >= turn.maxConsecutiveLengthStops!) ||
      actions.checkpointProviderTurnLimit())
  ) {
    const limit = actions.outputTokenLimit().toLocaleString("en-US");
    const consumed = turn.consumedOutputTokens;
    const consumption =
      Number.isSafeInteger(consumed) && Number(consumed) > 0
        ? `, last turn consumed ${Number(consumed).toLocaleString("en-US")} output tokens`
        : "";
    actions.stopProviderTerminal();
    actions.recordError(
      new InferenceStepError(
        `Tool-batch provider turn failed: provider-failed: tool-arguments-truncated: ` +
          `${turn.consecutiveLengthStops} consecutive provider turns of step ` +
          `${turn.stepId} hit the ${limit}-token output limit (finish_reason=length) ` +
          `with truncated tool arguments${consumption}; the re-issued call repeated ` +
          `the cut. ${outputLimitRemedy("Keep tool arguments within the limit", actions.outputLeaseClamp())}`,
        "malformed-response",
        false,
        undefined,
        lengthStopRejection("tool-arguments-truncated"),
      ),
    );
  }
}
