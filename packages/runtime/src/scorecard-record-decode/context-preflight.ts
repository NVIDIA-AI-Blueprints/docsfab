// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  isContextPreflightCauseReason,
  type ContextPreflightEvidence,
} from "../context/contracts.js";
import {
  CONTEXT_PREFLIGHT_CAUSE_CODE,
  CONTEXT_PREFLIGHT_CAUSE_MESSAGE_CHARACTERS,
  UNDISPLAYABLE_CAUSE_TEXT,
} from "../context/diagnostic.js";
import {
  boolean,
  exact,
  identifier,
  nonnegativeFinite,
  nonnegativeInteger,
  object,
  oneOf,
  optionalNonnegativeInteger,
  pattern,
  positiveInteger,
  repositoryRelativePath,
  requireCondition,
  safeText,
  uniqueSortedIdentifiers,
  SHA256,
} from "../scorecard-record-parse.js";

export function decodeContextPreflight(value: unknown): ContextPreflightEvidence {
  const item = object(value);
  exact(item, [
    "status",
    "packetDigest",
    "consultedNodeIds",
    "ontologyVersion",
    "effectiveDecisionIds",
    "measurements",
    "cache",
    "reason",
    "limit",
    "unboundTargets",
    "unboundTargetsOmitted",
    "cause",
  ]);
  const status = oneOf(item.status, ["ready", "degraded", "unnecessary", "failed"] as const);
  const packetDigest =
    item.packetDigest === undefined ? undefined : pattern(item.packetDigest, SHA256);
  const consultedNodeIds =
    item.consultedNodeIds === undefined
      ? undefined
      : uniqueSortedIdentifiers(item.consultedNodeIds);
  const ontologyVersion =
    item.ontologyVersion === undefined ? undefined : identifier(item.ontologyVersion);
  const effectiveDecisionIds =
    item.effectiveDecisionIds === undefined
      ? undefined
      : uniqueSortedIdentifiers(item.effectiveDecisionIds);
  const measurements =
    item.measurements === undefined ? undefined : decodeContextMeasurements(item.measurements);
  const cache = item.cache === undefined ? undefined : decodeContextCache(item.cache);
  const reason =
    item.reason === undefined
      ? undefined
      : oneOf(item.reason, [
          "context-service-not-configured",
          "security-scan-not-authorized",
          "workflow-stopped-before-step",
          "policy-marked-unnecessary",
          "semantic-state-unavailable",
          "target-not-applicable",
          "preflight-internal-failure",
          "preflight-budget-exceeded",
          "navigation-coverage-incomplete",
          "navigation-alias-refused",
          "scope-target-partially-unresolved",
          "content-index-refused",
          "content-index-unreadable",
          "context-compile-failed",
        ] as const);
  const limit = item.limit === undefined ? undefined : decodeContextLimit(item.limit);
  const cause = item.cause === undefined ? undefined : decodeContextCause(item.cause);
  // A cause travels with its reason on a degraded step, both ways; a record
  // written before causes existed carries a refused alias as `failed`.
  requireCondition(
    (cause !== undefined) === (status === "degraded" && isContextPreflightCauseReason(reason)),
  );
  const unboundTargets =
    item.unboundTargets === undefined ? undefined : decodeUnboundTargets(item.unboundTargets);
  const unboundTargetsOmitted =
    item.unboundTargetsOmitted === undefined
      ? undefined
      : positiveInteger(item.unboundTargetsOmitted);
  // Only a degraded step names or counts requested targets its packet does not bind.
  requireCondition(
    (unboundTargets === undefined && unboundTargetsOmitted === undefined) || status === "degraded",
  );
  if (status === "ready") {
    requireCondition(
      packetDigest !== undefined &&
        consultedNodeIds !== undefined &&
        consultedNodeIds.length > 0 &&
        ontologyVersion !== undefined &&
        effectiveDecisionIds !== undefined &&
        measurements !== undefined &&
        cache !== undefined &&
        reason === undefined &&
        limit === undefined,
    );
  } else {
    requireCondition(measurements !== undefined || reason !== undefined);
  }
  // The pairing binds both ways. A limit beside any other reason is a value
  // with no cause; a budget reason carrying no limit is a bound that cannot
  // state its own value, which `config/limit-stop.ts` refuses at the source.
  requireCondition((limit !== undefined) === (reason === "preflight-budget-exceeded"));
  return {
    status,
    ...(packetDigest === undefined ? {} : { packetDigest }),
    ...(consultedNodeIds === undefined ? {} : { consultedNodeIds }),
    ...(ontologyVersion === undefined ? {} : { ontologyVersion }),
    ...(effectiveDecisionIds === undefined ? {} : { effectiveDecisionIds }),
    ...(measurements === undefined ? {} : { measurements }),
    ...(cache === undefined ? {} : { cache }),
    ...(reason === undefined ? {} : { reason }),
    ...(limit === undefined ? {} : { limit }),
    ...(unboundTargets === undefined ? {} : { unboundTargets }),
    ...(unboundTargetsOmitted === undefined ? {} : { unboundTargetsOmitted }),
    ...(cause === undefined ? {} : { cause }),
  };
}

/**
 * A preflight cause: its code and one sentence with every control, format,
 * and separator code point escaped.
 */
function decodeContextCause(value: unknown): NonNullable<ContextPreflightEvidence["cause"]> {
  const item = object(value);
  exact(item, ["code", "message"]);
  requireCondition(item.code !== undefined && item.message !== undefined);
  const code = pattern(item.code, CONTEXT_PREFLIGHT_CAUSE_CODE);
  const message = safeText(item.message, CONTEXT_PREFLIGHT_CAUSE_MESSAGE_CHARACTERS);
  requireCondition(!UNDISPLAYABLE_CAUSE_TEXT.test(message));
  return { code, message };
}

/** Requested targets a packet does not bind: distinct repository-relative paths in code-unit order. */
function decodeUnboundTargets(value: unknown): string[] {
  requireCondition(Array.isArray(value) && value.length > 0);
  const decoded = (value as unknown[]).map(repositoryRelativePath);
  requireCondition(new Set(decoded).size === decoded.length);
  requireCondition(decoded.every((target, index) => index === 0 || decoded[index - 1]! < target));
  return decoded;
}

function decodeContextLimit(value: unknown): NonNullable<ContextPreflightEvidence["limit"]> {
  const item = object(value);
  exact(item, ["name", "unit", "configured", "observed"]);
  const name = identifier(item.name);
  const unit = oneOf(item.unit, ["ms", "tokens"] as const);
  const configured = nonnegativeInteger(item.configured);
  const observed = nonnegativeInteger(item.observed);
  requireCondition(observed >= configured);
  return { name, unit, configured, observed };
}

function decodeContextMeasurements(
  value: unknown,
): NonNullable<ContextPreflightEvidence["measurements"]> {
  const item = object(value);
  exact(item, [
    "byteLength",
    "estimatedTokens",
    "latencyMs",
    "nodeCount",
    "edgeCount",
    "pathCount",
  ]);
  const nodeCount = optionalNonnegativeInteger(item.nodeCount);
  const edgeCount = optionalNonnegativeInteger(item.edgeCount);
  const pathCount = optionalNonnegativeInteger(item.pathCount);
  return {
    byteLength: nonnegativeInteger(item.byteLength),
    estimatedTokens: nonnegativeInteger(item.estimatedTokens),
    latencyMs: nonnegativeFinite(item.latencyMs),
    ...(nodeCount === undefined ? {} : { nodeCount }),
    ...(edgeCount === undefined ? {} : { edgeCount }),
    ...(pathCount === undefined ? {} : { pathCount }),
  };
}

function decodeContextCache(value: unknown): NonNullable<ContextPreflightEvidence["cache"]> {
  const item = object(value);
  exact(item, ["disposition", "keyDigest", "rebuildAttempted"]);
  const disposition = oneOf(item.disposition, ["disabled", "hit", "miss", "rejected"] as const);
  const keyDigest = item.keyDigest === undefined ? undefined : pattern(item.keyDigest, SHA256);
  const rebuildAttempted = boolean(item.rebuildAttempted);
  if (disposition === "hit" || disposition === "miss" || disposition === "rejected") {
    requireCondition(keyDigest !== undefined);
  }
  return { disposition, ...(keyDigest === undefined ? {} : { keyDigest }), rebuildAttempted };
}
