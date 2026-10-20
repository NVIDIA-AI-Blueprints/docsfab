// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Hosted context preflight.
 *
 * Compiles the real Content IR packet for the materialized checkout, bounded
 * in wall time, with the host capsule projection as the fallback when the
 * compile would not authorize the step, or when the content index could not
 * be built or the compiler failed; the record keeps the compiler's coded
 * reason and cause either way. A named target or scope whose page the
 * compiler could not resolve, or selected as an alias, keeps the compiler's
 * verdict instead of widening to the capsule.
 *
 * The budget bounds how long the runner waits, not how long the uncancellable
 * index build runs.
 */
import { resolve } from "node:path";

import { limit, limitDefinition } from "../config/limits.js";
import {
  OPERATIONAL_LIMIT_NAMES,
  exceededLimitStop,
  type OperationalLimitStop,
} from "../config/limit-stop.js";
import { LocalContextPreflightService } from "../context/index.js";
import {
  isContextPreflightCauseReason,
  type ContextPreflightInput,
  type ContextPreflightReason,
  type ContextPreflightResult,
  type ContextPreflightService,
} from "../context/contracts.js";
import {
  contextPreflightAllowsExecution,
  isRecordableContextPreflightCause,
  isRecordableContextPreflightLimit,
} from "../workflow-execution/runner-evidence.js";
import type { HostRuntimeRequestV1 } from "./contracts.js";

/** Latency ceiling for one hosted structural compile. Catalog default. */
export const HOSTED_CONTEXT_PREFLIGHT_BUDGET_MS = limitDefinition(
  "hostInvoker.contextPreflightBudgetMs",
).value;

/**
 * Compiler reasons that refuse a page the operator named. For a targeted or
 * scoped step these stop the step; they never widen to the capsule.
 */
const SCOPED_REFUSAL_REASONS: ReadonlySet<ContextPreflightReason | undefined> = new Set([
  "target-not-applicable",
  "navigation-alias-refused",
]);

export const HOSTED_CONTEXT_PREFLIGHT_REMEDIATION =
  "Raise the hosted context preflight budget for this host, or accept the capsule projection for this step.";

/**
 * Boundary rule for the hosted compile ceiling. Returns the coded stop only
 * when the wait actually reached the budget.
 */
export function hostedContextPreflightBudgetStop(input: {
  configuredMs: number;
  elapsedMs: number;
}): OperationalLimitStop | undefined {
  return exceededLimitStop({
    limit: OPERATIONAL_LIMIT_NAMES.hostedContextPreflightBudgetMs,
    unit: "ms",
    // `setTimeout` cannot fire before its delay, so a wait that reached the
    // ceiling exactly is the ceiling binding, not evidence contradicting it.
    breach: "at-the-bound",
    configured: input.configuredMs,
    observed: input.elapsedMs,
    remediation: HOSTED_CONTEXT_PREFLIGHT_REMEDIATION,
  });
}

export interface HostedContextPreflightOptions {
  capsule: HostRuntimeRequestV1["capsule"];
  /** The compiler cache lives beside it. */
  stateDirectory: string;
  service?: ContextPreflightService;
  budgetMs?: number;
  /** Input window of the composition's model, which sizes each context packet. */
  modelInputTokens?: number;
  clock?: () => number;
  /** Monotonic source for the recorded wait; `clock` may be any test double. */
  waitNow?: () => number;
}

/** Projection of the host capsule, used as the fallback evidence. */
export function capsuleContextProjection(
  capsule: HostRuntimeRequestV1["capsule"],
  input: { rebuildAttempted: boolean; latencyMs: number },
): ContextPreflightResult {
  const consultedNodeIds = capsule.selectedEvidence.map((item) => item.evidenceId);
  const byteLength = Buffer.byteLength(JSON.stringify(capsule.selectedEvidence));
  return {
    status: "ready",
    packetDigest: capsule.sha256,
    consultedNodeIds,
    ontologyVersion: "hosted-v1",
    effectiveDecisionIds: [],
    measurements: {
      byteLength,
      estimatedTokens: Math.ceil(byteLength / 4),
      latencyMs: input.latencyMs,
      nodeCount: capsule.selectedEvidence.length,
    },
    cache: { disposition: "disabled", rebuildAttempted: input.rebuildAttempted },
    packet: {
      schemaVersion: 1,
      digest: capsule.sha256,
      consultedNodeIds,
    },
  };
}

export function createHostedContextPreflightService(
  options: HostedContextPreflightOptions,
): ContextPreflightService {
  const compiler =
    options.service ??
    new LocalContextPreflightService({
      cacheRoot: resolve(options.stateDirectory, "context-cache"),
      ...(options.modelInputTokens !== undefined
        ? { modelInputTokens: options.modelInputTokens }
        : {}),
    });
  const budgetMs = options.budgetMs ?? limit("hostInvoker.contextPreflightBudgetMs").value;
  const clock = options.clock ?? (() => performance.now());
  const waitNow = options.waitNow ?? (() => performance.now());
  return {
    async preflight(input: ContextPreflightInput): Promise<ContextPreflightResult> {
      const startedAt = clock();
      // The bound's observed value comes from `waitNow` inside the race;
      // `latencyMs` below uses the injected clock because it is a measurement.
      // Not memoized across steps: `compilerPolicy` bakes the step id into the
      // packet's policy id and digest, so reuse would name the wrong step.
      const attempt = await withBudget(compiler.preflight(input), budgetMs, waitNow);
      const compiled = attempt.outcome === "completed" ? attempt.value : undefined;
      const latencyMs = Math.max(0, Math.round(clock() - startedAt));
      if (
        compiled &&
        contextPreflightAllowsExecution(input.step.mode, input.policy, compiled) &&
        !capsuleStandsIn(compiled)
      ) {
        return compiled;
      }
      // A named target or scope page the compiler could not resolve, or refused
      // as an alias, stops the step rather than widening to the capsule. Any
      // other compiler reason, or an untargeted run, takes the capsule fallback
      // below: a broken indexer is not evidence about the page.
      if (
        (input.contextTarget || input.scope) &&
        compiled !== undefined &&
        SCOPED_REFUSAL_REASONS.has(compiled.reason)
      ) {
        return compiled;
      }
      // `degraded`, not `ready`: no packet was compiled. Hosted-eligible
      // workflows set `allowReadOnlyDegraded`, so a read-only step still runs.
      // `ready` would forbid a `reason`, and a `rejected` cache
      // would demand a `keyDigest` this path does not have. `reason` names
      // which cause fired: the ceiling, a thrown compiler, a policy refusal,
      // or the compiler's coded index or compile cause, with its `cause`.
      // Files the content index left out stay named whichever context the
      // step gets.
      const limitations = compiled?.limitations;
      return {
        ...capsuleContextProjection(options.capsule, { rebuildAttempted: true, latencyMs }),
        status: "degraded",
        cache: { disposition: "disabled", rebuildAttempted: true },
        ...preflightDegradeCause(attempt, budgetMs),
        ...(Array.isArray(limitations) && limitations.length > 0 ? { limitations } : {}),
      };
    },
  };
}

/**
 * A compile that left the step without a packet because the index could not
 * be built or the compiler failed: the host capsule stands in for the packet,
 * as it did before these causes had their own codes, and the record keeps the
 * compiler's coded reason and cause. A refused alias is evidence about the
 * selected page, so it keeps the compiler's verdict instead.
 */
function capsuleStandsIn(compiled: ContextPreflightResult): boolean {
  return (
    compiled.packet === undefined &&
    compiled.packetDigest === undefined &&
    isContextPreflightCauseReason(compiled.reason) &&
    compiled.reason !== "navigation-alias-refused"
  );
}

function preflightDegradeCause(
  attempt: BudgetedAttempt<ContextPreflightResult>,
  budgetMs: number,
): Pick<ContextPreflightResult, "reason" | "limit" | "cause"> {
  if (attempt.outcome === "failed") return { reason: "preflight-internal-failure" };
  if (attempt.outcome === "completed") {
    // The step's policy refused the result, so the compiler's own reason
    // stands. `service` is a host-supplied seam and may resolve nullish.
    const compilerReason = attempt.value?.reason;
    if (isContextPreflightCauseReason(compilerReason)) {
      // The coded cause travels with its reason, or the claim is a seam
      // violation, as an unbounded budget claim is below.
      const compilerCause = attempt.value?.cause;
      return isRecordableContextPreflightCause(compilerCause)
        ? { reason: compilerReason, cause: compilerCause }
        : { reason: "preflight-internal-failure" };
    }
    if (compilerReason === "preflight-budget-exceeded") {
      // A host-supplied compiler may bound itself. Carry the claim only with
      // the compiler's own recordable bound, since this ceiling did not fire;
      // a missing or malformed bound is a coded internal failure.
      const compilerLimit = attempt.value?.limit;
      return isRecordableContextPreflightLimit(compilerLimit)
        ? { reason: compilerReason, limit: compilerLimit }
        : { reason: "preflight-internal-failure" };
    }
    return { reason: compilerReason ?? "semantic-state-unavailable" };
  }
  // `observed` is the wait actually spent, read from `waitNow` when the
  // ceiling fired, not a guess at how long the uncancellable build will run.
  // `setTimeout` cannot fire early, so the budget is a valid floor.
  const stop = hostedContextPreflightBudgetStop({
    configuredMs: budgetMs,
    elapsedMs: attempt.elapsedMs,
  });
  return stop
    ? {
        reason: "preflight-budget-exceeded",
        limit: {
          name: stop.limit,
          unit: "ms",
          configured: stop.configured,
          observed: stop.observed,
        },
      }
    : { reason: "preflight-internal-failure" };
}

type BudgetedAttempt<T> =
  | { outcome: "completed"; value: T }
  | { outcome: "failed" }
  | { outcome: "budget-exceeded"; elapsedMs: number };

/**
 * Reports `budget-exceeded` when the compile outruns its latency ceiling and
 * `failed` when it throws, so a slow indexer and a broken one stay distinct.
 * The underlying build keeps running and is reclaimed with the process; it
 * holds no lock and writes nothing outside the compiler cache.
 */
async function withBudget<T>(
  work: Promise<T>,
  budgetMs: number,
  waitNow: () => number,
): Promise<BudgetedAttempt<T>> {
  let timer: NodeJS.Timeout | undefined;
  const waitStartedAt = waitNow();
  const ceiling = new Promise<BudgetedAttempt<T>>((resolveCeiling) => {
    timer = setTimeout(() => {
      const waitedMs = Math.max(0, Math.round(waitNow() - waitStartedAt));
      resolveCeiling({
        outcome: "budget-exceeded",
        elapsedMs: Math.max(budgetMs, waitedMs),
      });
    }, budgetMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([
      work.then(
        (value): BudgetedAttempt<T> => ({ outcome: "completed", value }),
        (): BudgetedAttempt<T> => ({ outcome: "failed" }),
      ),
      ceiling,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
