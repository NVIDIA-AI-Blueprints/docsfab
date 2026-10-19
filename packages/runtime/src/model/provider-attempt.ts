// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Physical provider-request accounting for one step attempt.
 *
 * Three things are called "an attempt":
 *
 * - a step attempt is one pass of `executeInferenceStep`
 *   (`workflow-execution/retry.ts`), bounded by the read-only retry policy;
 * - a logical turn is one governed provider turn, bounded by
 *   `maxProviderTurns` and recorded as one `InferenceTurnEvidence` row;
 * - a physical request is one call to the provider transport. A logical turn
 *   spends one, or more when the in-turn replay of `provider-turn-retry.ts`
 *   fires.
 *
 * This module projects and bounds physical requests across a step; it makes no
 * retry decision. The runner owns physical retry and native provider retry is
 * not adopted, so a request this runtime did not issue does not exist and the
 * counts are complete by construction. A turn row that never sealed a final
 * payload digest is reported as unaccounted, not as zero requests.
 */
import { LIMIT_DEFINITION_BY_NAME } from "../config/limits.generated.js";
import {
  settlePhysicalEffect,
  type TaskBudgetDimension,
  type TaskBudgetEnvelope,
  type TaskBudgetOwner,
  TASK_BUDGET_DIMENSIONS,
} from "../execution/task-budget.js";
import { LOCAL_STOP_MESSAGE_PREFIX } from "./context-budget.js";
import type { InferenceTurnEvidence, ProviderTurnReplayVeto } from "../records/contracts.js";
import { isProviderTurnReplayVeto } from "../records/inference-retry-disposition.js";
import { isRecord } from "../shared/primitives.js";
import { isRequestPolicyRefusal } from "./request-policy-refusals.js";

/** Catalog names of every bound this module and the in-turn replay honour. */
export const PROVIDER_ATTEMPT_LIMIT_NAMES = Object.freeze({
  maxAttemptsPerTurn: "providerAttempt.maxAttemptsPerTurn",
  maxBlankAttemptsPerTurn: "providerAttempt.maxBlankAttemptsPerTurn",
  baseDelayMs: "providerAttempt.baseDelayMs",
  maxDelayMs: "providerAttempt.maxDelayMs",
  maxTotalDelayMs: "providerAttempt.maxTotalDelayMs",
  maxThrottledAttemptsPerTurn: "providerAttempt.maxThrottledAttemptsPerTurn",
  maxThrottledTotalDelayMs: "providerAttempt.maxThrottledTotalDelayMs",
  maxPhysicalRequestsPerStep: "providerAttempt.maxPhysicalRequestsPerStep",
} as const);

export type ProviderAttemptLimitKey = keyof typeof PROVIDER_ATTEMPT_LIMIT_NAMES;

/**
 * The catalog value of one provider-attempt bound, read from the generated
 * mirror rather than `config/limits.ts`: these bounds are frozen into a
 * module-level policy at import time, and a value that could change between
 * reads would make recorded backoff evidence unreproducible.
 */
export function providerAttemptLimit(key: ProviderAttemptLimitKey): number {
  const name = PROVIDER_ATTEMPT_LIMIT_NAMES[key];
  const definition = LIMIT_DEFINITION_BY_NAME[name];
  if (!definition) {
    throw new Error(`Operational limit ${name} is not declared in config/limits.yaml.`);
  }
  return definition.value;
}

/** Physical provider requests one step attempt may spend across all its turns. */
export function maxPhysicalProviderRequestsPerStep(): number {
  return providerAttemptLimit("maxPhysicalRequestsPerStep");
}

/**
 * The coded refusal of `providerAttempt.maxPhysicalRequestsPerStep`.
 *
 * Raised before a governed turn's first provider request, the only place a
 * step-wide bound can be enforced: each turn enters the replay wrapper afresh,
 * so a bound checked only on replays lets every further turn spend one more
 * request. The message carries the governor's `LOCAL_STOP_MESSAGE_PREFIX` and
 * `code`, so the classifier reads it as the host's non-retryable budget stop,
 * and `reason=` matches the replay veto name.
 */
export class ProviderStepAttemptBoundError extends Error {
  public readonly code = "context-exhausted" as const;
  public readonly retryable = false as const;
  public readonly reason = "step-physical-attempts-exhausted" as const;

  public constructor(input: { spent: number; allowed: number | null; budgetRefused?: boolean }) {
    super(
      [
        LOCAL_STOP_MESSAGE_PREFIX,
        "reason=step-physical-attempts-exhausted",
        `limit=${PROVIDER_ATTEMPT_LIMIT_NAMES.maxPhysicalRequestsPerStep}`,
        `physical-requests=${input.spent}`,
        `physical-request-limit=${input.allowed === null ? "absent" : input.allowed}`,
        `budget-refused=${input.budgetRefused === true}`,
      ].join(" "),
    );
    this.name = "ProviderStepAttemptBoundError";
  }
}

/**
 * Refuse the next governed turn when the step's physical allowance is gone.
 * Called before the governor admits a turn, so a refused turn writes no ledger
 * row; one that issued no request would read as `unaccounted`.
 */
export function assertStepPhysicalAttemptsRemaining(
  ledger: Pick<PhysicalProviderAttemptLedger, "hasRemaining" | "spent" | "bound" | "refusal">,
): void {
  if (ledger.hasRemaining()) return;
  throw new ProviderStepAttemptBoundError({
    spent: ledger.spent(),
    allowed: ledger.bound(),
    budgetRefused: ledger.refusal() !== undefined,
  });
}

/**
 * The boundaries every physical attempt is held to, in the order the in-turn
 * replay applies them. Each names the `ProviderTurnReplayVeto` that enforces
 * it in `provider-turn-retry.ts`; the `Record` type below fails to typecheck if
 * a veto is renamed or removed.
 *
 * `finalized-payload` shares `local-denial`: a replay whose payload digest
 * differs from the sealed one is refused inside the payload hook as DocsFab's
 * own rejection and reaches the wrapper through `isReplayable`. That holds only
 * because `describeProviderTurnReplayVeto` consults the host veto before the
 * classifier's verdict; `test/provider-attempt-accounting.test.ts` asserts it.
 */
export const PROVIDER_ATTEMPT_BOUNDARIES = Object.freeze([
  "finalized-payload",
  "local-denial",
  "response-commit",
  "attempt-deadline",
  "cancellation",
] as const);

export type ProviderAttemptBoundary = (typeof PROVIDER_ATTEMPT_BOUNDARIES)[number];

export const PROVIDER_ATTEMPT_BOUNDARY_VETOES: Readonly<
  Record<ProviderAttemptBoundary, ProviderTurnReplayVeto>
> = Object.freeze({
  "finalized-payload": "local-denial",
  "local-denial": "local-denial",
  "response-commit": "partial-stream",
  "attempt-deadline": "attempt-deadline",
  cancellation: "cancelled",
});

/** How completely a reading could account for the turns it was given. */
export const PROVIDER_ATTEMPT_COVERAGES = Object.freeze(["complete", "partial"] as const);

export type ProviderAttemptCoverage = (typeof PROVIDER_ATTEMPT_COVERAGES)[number];

/**
 * Logical turns against physical requests for one step attempt.
 *
 * `physicalRequests` counts only requests this runtime can prove it issued: a
 * row that sealed a final payload digest spent one plus one per recorded
 * replay, less one when the send gate refused the last of them. A governor
 * `stop` is a known zero (`governorStoppedTurns`), and so is a turn the request
 * policy refused before sealing (`requestPolicyRefusedTurns`); any other
 * unsealed row counts in `unaccountedTurns`, and `coverage` reads `partial` so
 * `physicalRequests` is known to be a floor.
 */
export interface ProviderAttemptAccountingV1 {
  readonly logicalTurns: number;
  readonly physicalRequests: number;
  readonly replayedRequests: number;
  readonly blankRequests: number;
  readonly governorStoppedTurns: number;
  /** Turns the installed request policy refused before sealing a payload: a known zero. */
  readonly requestPolicyRefusedTurns: number;
  readonly unaccountedTurns: number;
  readonly coverage: ProviderAttemptCoverage;
}

/** The reading for an attempt whose turn ledger is absent or unreadable. */
export const PROVIDER_ATTEMPT_ACCOUNTING_UNAVAILABLE = "unavailable";

function countable(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/**
 * Project logical turns and physical requests off a recorded turn ledger.
 * The ledger is untrusted; an unreadable row is unaccounted, never skipped,
 * because skipping would shrink the physical count silently.
 */
export function accountProviderAttempts(
  turns: unknown,
): ProviderAttemptAccountingV1 | typeof PROVIDER_ATTEMPT_ACCOUNTING_UNAVAILABLE {
  if (!Array.isArray(turns)) return PROVIDER_ATTEMPT_ACCOUNTING_UNAVAILABLE;
  let logicalTurns = 0;
  let physicalRequests = 0;
  let replayedRequests = 0;
  let blankRequests = 0;
  let governorStoppedTurns = 0;
  let requestPolicyRefusedTurns = 0;
  let unaccountedTurns = 0;
  for (const row of turns) {
    if (!isRecord(row)) {
      unaccountedTurns += 1;
      continue;
    }
    const sealed = typeof row.finalPayloadSha256 === "string" && row.finalPayloadSha256.length > 0;
    const refusal = isRequestPolicyRefusal(row.requestPolicyRefusal)
      ? row.requestPolicyRefusal
      : undefined;
    if (!sealed) {
      // A governor stop and a request-policy refusal before sealing never
      // reached the transport, so each is a known zero.
      if (row.decision === "stop") governorStoppedTurns += 1;
      else if (refusal !== undefined) requestPolicyRefusedTurns += 1;
      else unaccountedTurns += 1;
      continue;
    }
    const replays = countable(row.providerRetries);
    // `payload-send` refuses after finalization promoted the request into the
    // count, so that last counted request was never sent. `payload-resend`
    // refuses a second call after the counted request was sent.
    const sent = refusal === "payload-send" ? replays : replays + 1;
    logicalTurns += 1;
    physicalRequests += sent;
    replayedRequests += Math.max(0, sent - 1);
    blankRequests += countable(row.providerBlankTurns);
  }
  return Object.freeze({
    logicalTurns,
    physicalRequests,
    replayedRequests,
    blankRequests,
    governorStoppedTurns,
    requestPolicyRefusedTurns,
    unaccountedTurns,
    coverage: unaccountedTurns === 0 ? ("complete" as const) : ("partial" as const),
  });
}

/**
 * The terminal replay veto recorded on the last turn row that carries one.
 * Saved records are untrusted, so each token is validated; an unreadable one is
 * skipped so a junk row cannot hide a real veto on an earlier row.
 */
export function readTerminalReplayVeto(turns: unknown): ProviderTurnReplayVeto | undefined {
  if (!Array.isArray(turns)) return undefined;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const row: unknown = turns[index];
    if (!isRecord(row)) continue;
    const veto = row.providerReplayVeto;
    if (isProviderTurnReplayVeto(veto)) return veto;
  }
  return undefined;
}

/** One physical request, as the step-attempt ledger charges it. */
function physicalRequestCharges(): TaskBudgetEnvelope {
  const envelope = {} as Record<TaskBudgetDimension, number>;
  for (const dimension of TASK_BUDGET_DIMENSIONS) envelope[dimension] = 0;
  envelope["provider-turns"] = 1;
  return Object.freeze(envelope);
}

export interface PhysicalProviderAttemptLedger {
  /**
   * Count one physical request that is about to be issued.
   *
   * Never throws: it runs inside the provider stream, where a failing counter
   * would lose an inference turn. A budget owner that refuses the charge closes
   * the ledger instead, so the next replay is vetoed and the refusal recorded.
   * The charge settles after the request was authorized, so a budget refusal
   * stops the next request, not this one; a caller that needs otherwise must
   * reserve the charge before `record()`. No caller supplies a budget owner
   * today, so the gap is latent.
   */
  record(): void;
  spent(): number;
  /** The allowance this ledger applies, for the refusal to name. */
  bound(): number | null;
  /** Zero once the step bound is reached or a budget charge was refused. */
  remaining(): number | null;
  /** False once the step's physical-request allowance is spent or refused. */
  hasRemaining(): boolean;
  /** The budget refusal that closed the ledger, when one did. */
  refusal(): string | undefined;
}

export interface CreatePhysicalProviderAttemptLedgerInput {
  /** Defaults to the catalog bound `providerAttempt.maxPhysicalRequestsPerStep`. */
  readonly maxPhysicalRequests?: number;
  /** Explicitly removes only the across-step aggregate; the per-turn replay policy remains active. */
  readonly aggregateRequestLimit?: { readonly kind: "absent" };
  /**
   * Nested remaining-budget owner. Every physical request settles exactly one
   * `provider-turns` charge under its own effect id, so the budget's replay
   * guard refuses a duplicate settlement of the same request.
   */
  readonly budget?: TaskBudgetOwner;
  /** Effect-id prefix, unique per step attempt. Defaults to a process counter. */
  readonly effectScope?: string;
}

let ledgerOrdinal = 0;

export function createPhysicalProviderAttemptLedger(
  input: CreatePhysicalProviderAttemptLedgerInput = {},
): PhysicalProviderAttemptLedger {
  if (input.aggregateRequestLimit?.kind === "absent" && input.maxPhysicalRequests !== undefined) {
    throw new Error("Physical provider request limit cannot be both absent and numeric.");
  }
  const bound =
    input.aggregateRequestLimit?.kind === "absent"
      ? null
      : input.maxPhysicalRequests === undefined
        ? maxPhysicalProviderRequestsPerStep()
        : input.maxPhysicalRequests;
  if (bound !== null && (!Number.isSafeInteger(bound) || bound < 1)) {
    throw new Error(
      "Physical provider attempt ledger requires a positive integer request bound.", // hygiene: ok
    );
  }
  ledgerOrdinal += 1;
  const scope = input.effectScope ?? `provider-attempt-${ledgerOrdinal}`;
  const charges = physicalRequestCharges();
  let spent = 0;
  let refusal: string | undefined;
  return {
    record(): void {
      spent += 1;
      if (!input.budget || refusal) return;
      try {
        settlePhysicalEffect(input.budget, { effectId: `${scope}:${spent}`, charges });
      } catch (error) {
        // A refused charge closes the ledger, so the next replay is vetoed as
        // `step-physical-attempts-exhausted`.
        refusal = error instanceof Error ? error.message : String(error);
      }
    },
    spent: () => spent,
    bound: () => bound,
    remaining: () => (refusal ? 0 : bound === null ? null : Math.max(0, bound - spent)),
    hasRemaining: () => !refusal && (bound === null || spent < bound),
    refusal: () => refusal,
  };
}
