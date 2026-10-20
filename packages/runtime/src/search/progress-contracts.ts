// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";

import { createContractKit, deepFreeze, type ContractFail } from "../contract-kit/index.js";
import {
  canonicalizeJsonEvidence,
  parseJsonEvidence,
  type JsonEvidenceValue,
} from "../json-evidence.js";
import {
  decideExecutionLeaseRenewal,
  decodeExecutionCheckpoint,
  decodeExecutionLeaseIdentity,
  decodeExecutionLeasePolicy,
  type ExecutionCheckpointV1,
  type ExecutionLeaseDecisionV1,
  type ExecutionLeaseIdentityV1,
  type ExecutionLeasePolicyV1,
  type ExecutionStopReason,
} from "../execution/lease-contracts.js";
import { containsConfiguredCredential } from "../security/configured-credentials.js";
import {
  decodeSearchLimitation,
  decodeSearchProbe,
  decodeSearchTarget,
  searchTargetSatisfied,
  searchTargetRequiresCompleteCoverage,
  type SearchCitationV1,
  type SearchDisposition,
  type SearchLimitationV1,
  type SearchProbeV1,
  type SearchSaturationBindingV1,
  type SearchTargetV1,
} from "./bounded-search-contracts.js";
import type {
  CreateSearchProgressEventInput,
  SearchProgressCategoryCountsV1,
  SearchProgressCheckpointBindingV1,
  SearchProgressEvidenceV1,
  SearchProgressEventCategory,
  SearchProgressEventV1,
  SearchProgressExecutionAuthorityV1,
  SearchProgressObservationV1,
  SearchProgressPolicyV1,
  SearchProgressReasonCategory,
  SearchProgressRecommendationV1,
  SearchRemainingWorkCategory,
  SearchRemainingWorkRationaleV1,
} from "./progress-evidence-contracts.js";

export type {
  CreateSearchProgressEventInput,
  SearchProgressCategoryCountsV1,
  SearchProgressCheckpointBindingV1,
  SearchProgressEvidenceV1,
  SearchProgressEventCategory,
  SearchProgressEventV1,
  SearchProgressExecutionAuthorityV1,
  SearchProgressObservationV1,
  SearchProgressPolicyV1,
  SearchProgressReasonCategory,
  SearchProgressRecommendationV1,
  SearchRemainingWorkCategory,
  SearchRemainingWorkRationaleV1,
} from "./progress-evidence-contracts.js";

export const SEARCH_PROGRESS_SCHEMA_VERSION = 1 as const;

export const SEARCH_PROGRESS_EVENT_CATEGORIES = [
  "evidence-produced",
  "no-new-evidence",
  "tool-failure",
  "authorization-denied",
  "governance-denied",
  "unsupported-operation",
  "governed-asset-defect",
  "governed-tool-defect",
] as const;

export const SEARCH_REMAINING_WORK_CATEGORIES = [
  "required-probes",
  "alternative-bounded-probe",
  "verification",
  "none",
] as const;

export const SEARCH_PROGRESS_REASON_CATEGORIES = [
  "blocking-limitation",
  "declining-yield-saturated",
  "hard-ceiling",
  "new-evidence",
  "new-required-probe-coverage",
  "positive-match",
  "repeated-equivalent-zero-yield",
  "required-probes-complete",
  "required-probes-remaining",
  "zero-yield-lease-limit",
  "execution-denied",
  "execution-budget-terminal",
  "workflow-completed",
] as const;

export class SearchProgressContractError extends Error {
  public readonly code:
    | "invalid-policy"
    | "invalid-event"
    | "invalid-observation"
    | "invalid-rationale"
    | "invalid-recommendation"
    | "invalid-execution-authority"
    | "invalid-evidence"
    | "unsupported-schema";
  public constructor(
    code:
      | "invalid-policy"
      | "invalid-event"
      | "invalid-observation"
      | "invalid-rationale"
      | "invalid-recommendation"
      | "invalid-execution-authority"
      | "invalid-evidence"
      | "unsupported-schema",
  ) {
    super(`Search progress contract rejected: ${code}.`);
    this.code = code;
    this.name = "SearchProgressContractError";
  }
}

function fail(code: SearchProgressContractError["code"]): never {
  throw new SearchProgressContractError(code);
}

type SearchProgressContractKit = ReturnType<
  typeof createContractKit<SearchProgressContractError["code"]>
>;

const progressKits = new Map<SearchProgressContractError["code"], SearchProgressContractKit>();

function kitFor(code: SearchProgressContractError["code"]): SearchProgressContractKit {
  const existing = progressKits.get(code);
  if (existing) return existing;
  const created = createContractKit({
    fail: fail as ContractFail<SearchProgressContractError["code"]>,
    inertMode: "strict",
    codes: {
      invalidShape: code,
      invalidValue: code,
      digestMismatch: code,
      credentialMaterial: code,
      schemaMismatch: code,
    },
  });
  progressKits.set(code, created);
  return created;
}

export function createSearchProgressPolicy(
  input: {
    repeatedEquivalentCallLimit?: number;
    consecutiveZeroYieldLeaseLimit?: number;
    decliningYieldWindow?: number;
  } = {},
): SearchProgressPolicyV1 {
  const item = object(input, "invalid-policy");
  if (
    Object.keys(item).some(
      (key) =>
        ![
          "repeatedEquivalentCallLimit",
          "consecutiveZeroYieldLeaseLimit",
          "decliningYieldWindow",
        ].includes(key),
    )
  )
    fail("invalid-policy");
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-search-progress-policy" as const,
    repeatedEquivalentCallLimit: input.repeatedEquivalentCallLimit ?? 3,
    consecutiveZeroYieldLeaseLimit: input.consecutiveZeroYieldLeaseLimit ?? 2,
    decliningYieldWindow: input.decliningYieldWindow ?? 3,
  };
  return decodeSearchProgressPolicy({ ...body, policySha256: hash(body) });
}

export function createSearchProgressExecutionAuthority(input: {
  target: SearchTargetV1;
  policy: ExecutionLeasePolicyV1;
  identity: ExecutionLeaseIdentityV1;
  checkpoints: readonly ExecutionCheckpointV1[];
  decisions: readonly ExecutionLeaseDecisionV1[];
}): SearchProgressExecutionAuthorityV1 {
  requireKeys(
    object(input, "invalid-execution-authority"),
    ["target", "policy", "identity", "checkpoints", "decisions"],
    "invalid-execution-authority",
  );
  const target = decodeSearchTarget(input.target);
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-search-progress-execution-authority" as const,
    policy: input.policy,
    identity: input.identity,
    checkpoints: [...input.checkpoints],
    decisions: [...input.decisions],
  };
  return decodeSearchProgressExecutionAuthority({ ...body, authoritySha256: hash(body) }, target);
}

export function createSearchProgressEvent(
  input: CreateSearchProgressEventInput,
  targetValue: SearchTargetV1,
  probesValue: readonly SearchProbeV1[],
  limitationsValue: readonly SearchLimitationV1[],
): SearchProgressEventV1 {
  requireKeys(
    object(input, "invalid-event"),
    [
      "sequence",
      "category",
      "operationSha256",
      "probeId",
      "probeSha256",
      "evidenceSha256",
      "limitationSha256",
      "citations",
    ],
    "invalid-event",
  );
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-search-progress-event" as const,
    ...input,
    citations: normalizedCitations(input.citations, "invalid-event"),
  };
  return decodeSearchProgressEvent(
    { ...body, eventSha256: hash(body) },
    targetValue,
    probesValue,
    limitationsValue,
  );
}

export function createSearchProgressObservation(input: {
  target: SearchTargetV1;
  probes: readonly SearchProbeV1[];
  limitations: readonly SearchLimitationV1[];
  execution: SearchProgressExecutionAuthorityV1;
  events: readonly SearchProgressEventV1[];
  previousObservations?: readonly SearchProgressObservationV1[];
}): SearchProgressObservationV1 {
  requireKeys(
    object(input, "invalid-observation"),
    [
      "target",
      "probes",
      "limitations",
      "execution",
      "events",
      ...(Object.hasOwn(input, "previousObservations") ? ["previousObservations"] : []),
    ],
    "invalid-observation",
  );
  const target = decodeSearchTarget(input.target);
  const probes = normalizedProbes(input.probes, target);
  const limitations = normalizedLimitations(input.limitations, target, probes);
  const execution = decodeSearchProgressExecutionAuthority(input.execution, target);
  const previous = decodeObservationHistory(
    input.previousObservations ?? [],
    target,
    probes,
    limitations,
    execution,
  );
  if (execution.checkpoints.length !== previous.length + 1) fail("invalid-observation");
  const checkpoint = bindingFromCheckpoint(execution.checkpoints[previous.length]!);
  const events = normalizedEvents(input.events, target, probes, limitations);
  const body = observationBody(target, probes, checkpoint, events, previous, execution);
  return decodeSearchProgressObservation(
    { ...body, observationSha256: hash(body) },
    target,
    probes,
    limitations,
    execution,
    previous,
  );
}

export function createSearchRemainingWorkRationale(input: {
  target: SearchTargetV1;
  category: SearchRemainingWorkCategory;
  remainingRequiredProbeIds: string[];
  remainingWorkCount: number;
  detailSha256: string;
  citations: SearchCitationV1[];
}): SearchRemainingWorkRationaleV1 {
  requireKeys(
    object(input, "invalid-rationale"),
    [
      "target",
      "category",
      "remainingRequiredProbeIds",
      "remainingWorkCount",
      "detailSha256",
      "citations",
    ],
    "invalid-rationale",
  );
  const target = decodeSearchTarget(input.target);
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-search-remaining-work-rationale" as const,
    targetSha256: target.targetSha256,
    authority: "non-authoritative" as const,
    category: input.category,
    remainingRequiredProbeIds: [...input.remainingRequiredProbeIds].sort(),
    remainingWorkCount: input.remainingWorkCount,
    detailSha256: input.detailSha256,
    citations: normalizedCitations(input.citations, "invalid-rationale"),
  };
  return decodeSearchRemainingWorkRationale({ ...body, rationaleSha256: hash(body) }, target);
}

export function createSearchProgressEvidence(input: {
  policy: SearchProgressPolicyV1;
  execution: SearchProgressExecutionAuthorityV1;
  target: SearchTargetV1;
  probes: readonly SearchProbeV1[];
  limitations: readonly SearchLimitationV1[];
  observations: readonly SearchProgressObservationV1[];
  rationale: SearchRemainingWorkRationaleV1;
}): SearchProgressEvidenceV1 {
  requireKeys(
    object(input, "invalid-evidence"),
    ["policy", "execution", "target", "probes", "limitations", "observations", "rationale"],
    "invalid-evidence",
  );
  const policy = decodeSearchProgressPolicy(input.policy);
  const target = decodeSearchTarget(input.target);
  const execution = decodeSearchProgressExecutionAuthority(input.execution, target);
  const probes = normalizedProbes(input.probes, target);
  const limitations = normalizedLimitations(input.limitations, target, probes);
  const observations = decodeObservationHistory(
    input.observations,
    target,
    probes,
    limitations,
    execution,
  );
  if (observations.length === 0 || observations.length !== execution.checkpoints.length) {
    fail("invalid-evidence");
  }
  const rationale = decodeSearchRemainingWorkRationale(input.rationale, target);
  const recommendation = buildRecommendation(
    policy,
    execution,
    target,
    probes,
    limitations,
    observations,
    rationale,
  );
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-search-progress-evidence" as const,
    policy,
    execution,
    target,
    probes,
    limitations,
    observations,
    rationale,
    recommendation,
  };
  return decodeSearchProgressEvidence({ ...body, evidenceSha256: hash(body) });
}

export function serializeSearchProgressEvidence(value: SearchProgressEvidenceV1): string {
  return canonicalizeJsonEvidence(
    decodeSearchProgressEvidence(value) as unknown as JsonEvidenceValue,
  );
}

export function parseSearchProgressEvidence(
  input: string | Uint8Array | unknown,
): SearchProgressEvidenceV1 {
  const value =
    typeof input === "string" || input instanceof Uint8Array
      ? parseJsonEvidence(input, { requireCanonical: true })
      : input;
  return decodeSearchProgressEvidence(value);
}

export function decodeSearchProgressPolicy(value: unknown): SearchProgressPolicyV1 {
  const item = object(value, "invalid-policy");
  requireKeys(
    item,
    [
      "schemaVersion",
      "kind",
      "repeatedEquivalentCallLimit",
      "consecutiveZeroYieldLeaseLimit",
      "decliningYieldWindow",
      "policySha256",
    ],
    "invalid-policy",
  );
  if (item.schemaVersion !== 1 || item.kind !== "docsfab-search-progress-policy") {
    fail(item.schemaVersion === 1 ? "invalid-policy" : "unsupported-schema");
  }
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-search-progress-policy" as const,
    repeatedEquivalentCallLimit: positive(item.repeatedEquivalentCallLimit, "invalid-policy"),
    consecutiveZeroYieldLeaseLimit: positive(item.consecutiveZeroYieldLeaseLimit, "invalid-policy"),
    decliningYieldWindow: positive(item.decliningYieldWindow, "invalid-policy"),
  };
  if (body.decliningYieldWindow < 2) fail("invalid-policy");
  return deepFreeze({
    ...body,
    policySha256: assertCanonicalBody(item, "policySha256", body, "invalid-policy"),
  });
}

export function decodeSearchProgressExecutionAuthority(
  value: unknown,
  targetValue: SearchTargetV1,
): SearchProgressExecutionAuthorityV1 {
  const target = decodeSearchTarget(targetValue);
  const item = object(value, "invalid-execution-authority");
  requireKeys(
    item,
    ["schemaVersion", "kind", "policy", "identity", "checkpoints", "decisions", "authoritySha256"],
    "invalid-execution-authority",
  );
  if (item.schemaVersion !== 1 || item.kind !== "docsfab-search-progress-execution-authority") {
    fail(item.schemaVersion === 1 ? "invalid-execution-authority" : "unsupported-schema");
  }
  let policy: ExecutionLeasePolicyV1;
  let identity: ExecutionLeaseIdentityV1;
  try {
    policy = decodeExecutionLeasePolicy(item.policy);
    identity = decodeExecutionLeaseIdentity(item.identity);
  } catch {
    fail("invalid-execution-authority");
  }
  if (
    identity.policySha256 !== policy.policySha256 ||
    identity.repositoryRevision !== target.repository.revision
  ) {
    fail("invalid-execution-authority");
  }
  const checkpoints: ExecutionCheckpointV1[] = [];
  try {
    for (const raw of array(item.checkpoints, "invalid-execution-authority")) {
      checkpoints.push(decodeExecutionCheckpoint(raw, policy, identity, checkpoints.at(-1)));
    }
  } catch {
    fail("invalid-execution-authority");
  }
  if (
    checkpoints.length === 0 ||
    checkpoints.length > policy.maxLeases ||
    new Set(checkpoints.map((checkpoint) => checkpoint.checkpointSha256)).size !==
      checkpoints.length ||
    new Set(checkpoints.map((checkpoint) => checkpoint.state.stateSha256)).size !==
      checkpoints.length ||
    checkpoints.some(
      (checkpoint, index) =>
        checkpoint.sequence !== index + 1 ||
        checkpoint.state.leaseNumber !== index + 1 ||
        checkpoint.previousCheckpointSha256 !== (checkpoints[index - 1]?.checkpointSha256 ?? null),
    )
  ) {
    fail("invalid-execution-authority");
  }
  const rawDecisions = array(item.decisions, "invalid-execution-authority");
  if (rawDecisions.length < checkpoints.length - 1 || rawDecisions.length > checkpoints.length) {
    fail("invalid-execution-authority");
  }
  const decisions: ExecutionLeaseDecisionV1[] = [];
  for (let index = 0; index < rawDecisions.length; index += 1) {
    const raw = rawDecisions[index];
    const rawItem = object(raw, "invalid-execution-authority");
    const checkpoint = checkpoints[index];
    if (!checkpoint || rawItem.checkpointSha256 !== checkpoint.checkpointSha256) {
      fail("invalid-execution-authority");
    }
    let expected: ExecutionLeaseDecisionV1;
    try {
      expected = decideExecutionLeaseRenewal({
        policy,
        identity,
        checkpoint,
        ...(rawItem.decision === "denied"
          ? {
              stopReasons: array(
                rawItem.consideredStopReasons,
                "invalid-execution-authority",
              ) as ExecutionStopReason[],
            }
          : {}),
        ...(index > 0
          ? { history: { checkpoints: checkpoints.slice(0, index), decisions: [...decisions] } }
          : {}),
      });
    } catch {
      fail("invalid-execution-authority");
    }
    if (expected.schemaVersion !== 1) fail("invalid-execution-authority");
    if (
      canonicalizeJsonEvidence(raw as JsonEvidenceValue) !==
      canonicalizeJsonEvidence(expected as unknown as JsonEvidenceValue)
    ) {
      fail("invalid-execution-authority");
    }
    decisions.push(expected);
  }
  for (let index = 1; index < checkpoints.length; index += 1) {
    const grant = decisions[index - 1];
    if (
      grant?.decision !== "granted" ||
      grant.leaseNumber !== checkpoints[index]!.state.leaseNumber
    ) {
      fail("invalid-execution-authority");
    }
  }
  if (new Set(decisions.map((decision) => decision.decisionSha256)).size !== decisions.length) {
    fail("invalid-execution-authority");
  }
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-search-progress-execution-authority" as const,
    policy,
    identity,
    checkpoints,
    decisions: decisions.map((decision) => {
      if (decision.schemaVersion !== 1) fail("invalid-execution-authority");
      return decision;
    }),
  };
  rejectCredentials(body, "invalid-execution-authority");
  return deepFreeze({
    ...body,
    authoritySha256: assertCanonicalBody(
      item,
      "authoritySha256",
      body,
      "invalid-execution-authority",
    ),
  });
}

export function decodeSearchProgressEvent(
  value: unknown,
  targetValue: SearchTargetV1,
  probesValue: readonly SearchProbeV1[],
  limitationsValue: readonly SearchLimitationV1[],
): SearchProgressEventV1 {
  const target = decodeSearchTarget(targetValue);
  const probes = normalizedProbes(probesValue, target);
  const limitations = normalizedLimitations(limitationsValue, target, probes);
  const item = object(value, "invalid-event");
  requireKeys(
    item,
    [
      "schemaVersion",
      "kind",
      "sequence",
      "category",
      "operationSha256",
      "probeId",
      "probeSha256",
      "evidenceSha256",
      "limitationSha256",
      "citations",
      "eventSha256",
    ],
    "invalid-event",
  );
  if (item.schemaVersion !== 1 || item.kind !== "docsfab-search-progress-event") {
    fail(item.schemaVersion === 1 ? "invalid-event" : "unsupported-schema");
  }
  const category = enumValue(item.category, SEARCH_PROGRESS_EVENT_CATEGORIES, "invalid-event");
  const probeId = nullableId(item.probeId, "invalid-event");
  const probeSha256 = nullableDigest(item.probeSha256, "invalid-event");
  const evidenceSha256 = nullableDigest(item.evidenceSha256, "invalid-event");
  const limitationSha256 = nullableDigest(item.limitationSha256, "invalid-event");
  const probe = probeId === null ? undefined : probes.find((candidate) => candidate.id === probeId);
  const limitation =
    limitationSha256 === null
      ? undefined
      : limitations.find((candidate) => candidate.limitationSha256 === limitationSha256);
  if (
    (probe === undefined) !== (probeSha256 === null) ||
    (probe && probe.probeSha256 !== probeSha256)
  )
    fail("invalid-event");
  const successful = category === "evidence-produced";
  const failed = isBlockingEvent(category);
  if (successful) {
    if (
      evidenceSha256 === null ||
      limitation ||
      (probe && (probe.outcome === "blocked" || evidenceSha256 !== probe.evidenceSha256))
    ) {
      fail("invalid-event");
    }
  } else if (
    evidenceSha256 !== null ||
    (category === "no-new-evidence" && probe?.outcome === "blocked")
  )
    fail("invalid-event");
  if (failed) {
    if (
      !limitation ||
      limitation.impact !== "blocking" ||
      (probeId !== null && !limitation.probeIds.includes(probeId)) ||
      !limitationMatches(category, limitation)
    )
      fail("invalid-event");
  } else if (limitation) fail("invalid-event");
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-search-progress-event" as const,
    sequence: positive(item.sequence, "invalid-event"),
    category,
    operationSha256: digest(item.operationSha256, "invalid-event"),
    probeId,
    probeSha256,
    evidenceSha256,
    limitationSha256,
    citations: normalizedCitations(
      array(item.citations, "invalid-event") as unknown as SearchCitationV1[],
      "invalid-event",
    ),
  };
  if (
    probe &&
    canonicalizeJsonEvidence(body.citations as unknown as JsonEvidenceValue) !==
      canonicalizeJsonEvidence(probe.citations as unknown as JsonEvidenceValue)
  )
    fail("invalid-event");
  rejectCredentials(body, "invalid-event");
  return deepFreeze({
    ...body,
    eventSha256: assertCanonicalBody(item, "eventSha256", body, "invalid-event"),
  });
}

export function decodeSearchProgressObservation(
  value: unknown,
  targetValue: SearchTargetV1,
  probesValue: readonly SearchProbeV1[],
  limitationsValue: readonly SearchLimitationV1[],
  executionValue: SearchProgressExecutionAuthorityV1,
  previousValues: readonly SearchProgressObservationV1[] = [],
): SearchProgressObservationV1 {
  const target = decodeSearchTarget(targetValue);
  const probes = normalizedProbes(probesValue, target);
  const limitations = normalizedLimitations(limitationsValue, target, probes);
  const execution = decodeSearchProgressExecutionAuthority(executionValue, target);
  const previous = decodeObservationHistory(previousValues, target, probes, limitations, execution);
  return decodeObservationInDecodedContext(value, target, probes, limitations, execution, previous);
}

/**
 * Observation-specific checks against context this module has already decoded
 * in the same call. The public decoder above re-decodes every argument; the
 * history walk must not, or decoding observation k re-decodes observations
 * 1..k-1 and their execution authority again (2^k work for k observations).
 */
function decodeObservationInDecodedContext(
  value: unknown,
  target: SearchTargetV1,
  probes: readonly SearchProbeV1[],
  limitations: readonly SearchLimitationV1[],
  execution: SearchProgressExecutionAuthorityV1,
  previous: readonly SearchProgressObservationV1[],
): SearchProgressObservationV1 {
  const item = object(value, "invalid-observation");
  requireKeys(
    item,
    [
      "schemaVersion",
      "kind",
      "targetSha256",
      "checkpoint",
      "previousObservationSha256",
      "events",
      "categoryCounts",
      "newUniqueEvidenceCount",
      "newlyCompletedRequiredProbeIds",
      "completedRequiredProbeIds",
      "remainingRequiredProbeIds",
      "repeatedEquivalentCallCount",
      "zeroYieldCallCount",
      "yieldScore",
      "operationSha256s",
      "evidenceSha256s",
      "limitationSha256s",
      "citations",
      "observationSha256",
    ],
    "invalid-observation",
  );
  if (item.schemaVersion !== 1 || item.kind !== "docsfab-search-progress-observation") {
    fail(item.schemaVersion === 1 ? "invalid-observation" : "unsupported-schema");
  }
  const checkpointValue = execution.checkpoints[previous.length];
  if (!checkpointValue) fail("invalid-observation");
  const checkpoint = bindingFromCheckpoint(checkpointValue);
  const events = normalizedEvents(
    array(item.events, "invalid-observation") as unknown as SearchProgressEventV1[],
    target,
    probes,
    limitations,
  );
  const body = observationBody(target, probes, checkpoint, events, previous, execution);
  return deepFreeze({
    ...body,
    observationSha256: assertCanonicalBody(item, "observationSha256", body, "invalid-observation"),
  });
}

export function decodeSearchRemainingWorkRationale(
  value: unknown,
  targetValue: SearchTargetV1,
): SearchRemainingWorkRationaleV1 {
  const target = decodeSearchTarget(targetValue);
  const item = object(value, "invalid-rationale");
  requireKeys(
    item,
    [
      "schemaVersion",
      "kind",
      "targetSha256",
      "authority",
      "category",
      "remainingRequiredProbeIds",
      "remainingWorkCount",
      "detailSha256",
      "citations",
      "rationaleSha256",
    ],
    "invalid-rationale",
  );
  if (item.schemaVersion !== 1 || item.kind !== "docsfab-search-remaining-work-rationale") {
    fail(item.schemaVersion === 1 ? "invalid-rationale" : "unsupported-schema");
  }
  const ids = sortedUniqueIds(
    array(item.remainingRequiredProbeIds, "invalid-rationale"),
    "invalid-rationale",
  );
  const known = new Set(target.requiredProbes.map((probe) => probe.id));
  if (ids.some((id) => !known.has(id))) fail("invalid-rationale");
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-search-remaining-work-rationale" as const,
    targetSha256: digest(item.targetSha256, "invalid-rationale"),
    authority: item.authority,
    category: enumValue(item.category, SEARCH_REMAINING_WORK_CATEGORIES, "invalid-rationale"),
    remainingRequiredProbeIds: ids,
    remainingWorkCount: nonnegative(item.remainingWorkCount, "invalid-rationale"),
    detailSha256: digest(item.detailSha256, "invalid-rationale"),
    citations: normalizedCitations(
      array(item.citations, "invalid-rationale") as unknown as SearchCitationV1[],
      "invalid-rationale",
    ),
  };
  if (
    body.targetSha256 !== target.targetSha256 ||
    body.authority !== "non-authoritative" ||
    (body.category === "none") !== (body.remainingWorkCount === 0 && ids.length === 0)
  ) {
    fail("invalid-rationale");
  }
  rejectCredentials(body, "invalid-rationale");
  return deepFreeze({
    ...body,
    authority: "non-authoritative",
    rationaleSha256: assertCanonicalBody(item, "rationaleSha256", body, "invalid-rationale"),
  });
}

export function decodeSearchProgressEvidence(value: unknown): SearchProgressEvidenceV1 {
  const item = object(value, "invalid-evidence");
  requireKeys(
    item,
    [
      "schemaVersion",
      "kind",
      "policy",
      "execution",
      "target",
      "probes",
      "limitations",
      "observations",
      "rationale",
      "recommendation",
      "evidenceSha256",
    ],
    "invalid-evidence",
  );
  if (item.schemaVersion !== 1 || item.kind !== "docsfab-search-progress-evidence") {
    fail(item.schemaVersion === 1 ? "invalid-evidence" : "unsupported-schema");
  }
  const policy = decodeSearchProgressPolicy(item.policy);
  const target = decodeSearchTarget(item.target);
  const execution = decodeSearchProgressExecutionAuthority(item.execution, target);
  const probes = normalizedProbes(
    array(item.probes, "invalid-evidence") as unknown as SearchProbeV1[],
    target,
  );
  const limitations = normalizedLimitations(
    array(item.limitations, "invalid-evidence") as unknown as SearchLimitationV1[],
    target,
    probes,
  );
  const observations = decodeObservationHistory(
    array(item.observations, "invalid-evidence") as unknown as SearchProgressObservationV1[],
    target,
    probes,
    limitations,
    execution,
  );
  if (observations.length === 0 || observations.length !== execution.checkpoints.length) {
    fail("invalid-evidence");
  }
  const rationale = decodeSearchRemainingWorkRationale(item.rationale, target);
  const recommendation = decodeRecommendation(
    item.recommendation,
    policy,
    execution,
    target,
    probes,
    limitations,
    observations,
    rationale,
  );
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-search-progress-evidence" as const,
    policy,
    execution,
    target,
    probes,
    limitations,
    observations,
    rationale,
    recommendation,
  };
  rejectCredentials(body, "invalid-evidence");
  return deepFreeze({
    ...body,
    evidenceSha256: assertCanonicalBody(item, "evidenceSha256", body, "invalid-evidence"),
  });
}

function observationBody(
  target: SearchTargetV1,
  probes: readonly SearchProbeV1[],
  checkpoint: SearchProgressCheckpointBindingV1,
  events: readonly SearchProgressEventV1[],
  previous: readonly SearchProgressObservationV1[],
  execution: SearchProgressExecutionAuthorityV1,
) {
  const prior = previous.at(-1);
  if (
    previous.some(
      (observation) =>
        observation.categoryCounts.authorizationDenied > 0 ||
        observation.categoryCounts.governanceDenied > 0,
    )
  ) {
    fail("invalid-observation");
  }
  if (
    (prior === undefined && checkpoint.leaseNumber !== 1) ||
    (prior && checkpoint.leaseNumber !== prior.checkpoint.leaseNumber + 1) ||
    (prior &&
      (checkpoint.identitySha256 !== prior.checkpoint.identitySha256 ||
        checkpoint.policySha256 !== prior.checkpoint.policySha256))
  )
    fail("invalid-observation");
  const priorOperations = new Set(previous.flatMap((observation) => observation.operationSha256s));
  const priorEvidence = new Set(previous.flatMap((observation) => observation.evidenceSha256s));
  const priorCompleted = new Set(
    previous.flatMap((observation) => observation.newlyCompletedRequiredProbeIds),
  );
  const seenOperations = new Set<string>();
  const seenEvidence = new Set<string>();
  let repeatedEquivalentCallCount = 0;
  let zeroYieldCallCount = 0;
  const newlyCompleted = new Set<string>();
  for (const event of events) {
    const repeated =
      priorOperations.has(event.operationSha256) || seenOperations.has(event.operationSha256);
    seenOperations.add(event.operationSha256);
    const isNewEvidence =
      event.evidenceSha256 !== null &&
      !priorEvidence.has(event.evidenceSha256) &&
      !seenEvidence.has(event.evidenceSha256);
    if (event.evidenceSha256) seenEvidence.add(event.evidenceSha256);
    const eventProbe =
      event.probeId === null ? undefined : probes.find((probe) => probe.id === event.probeId);
    const completesProbe =
      event.category === "evidence-produced" &&
      event.probeId !== null &&
      (eventProbe?.outcome === "match" || eventProbe?.outcome === "no-match") &&
      !priorCompleted.has(event.probeId) &&
      !newlyCompleted.has(event.probeId);
    if (completesProbe && event.probeId) newlyCompleted.add(event.probeId);
    if (repeated && !isNewEvidence && !completesProbe) repeatedEquivalentCallCount += 1;
    if (!isNewEvidence && !completesProbe) zeroYieldCallCount += 1;
  }
  const completed = new Set([...priorCompleted, ...newlyCompleted]);
  const required = target.requiredProbes.map((probe) => probe.id).sort();
  const counts = categoryCounts(events);
  assertCheckpointCounterDeltas(execution, previous.length, counts, events.length);
  const newUniqueEvidenceCount = events
    .map((event) => event.evidenceSha256)
    .filter((value): value is string => value !== null && !priorEvidence.has(value))
    .filter((value, index, values) => values.indexOf(value) === index).length;
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-search-progress-observation" as const,
    targetSha256: target.targetSha256,
    checkpoint,
    previousObservationSha256: prior?.observationSha256 ?? null,
    events: [...events],
    categoryCounts: counts,
    newUniqueEvidenceCount,
    newlyCompletedRequiredProbeIds: [...newlyCompleted].sort(),
    completedRequiredProbeIds: [...completed].sort(),
    remainingRequiredProbeIds: required.filter((id) => !completed.has(id)),
    repeatedEquivalentCallCount,
    zeroYieldCallCount,
    yieldScore: newUniqueEvidenceCount + newlyCompleted.size,
    operationSha256s: [...seenOperations].sort(),
    evidenceSha256s: [...seenEvidence].sort(),
    limitationSha256s: [
      ...new Set(
        events.flatMap((event) =>
          event.limitationSha256 === null ? [] : [event.limitationSha256],
        ),
      ),
    ].sort(),
    citations: normalizedCitations(
      events.flatMap((event) => event.citations),
      "invalid-observation",
    ),
  };
  rejectCredentials(body, "invalid-observation");
  return body;
}

function buildRecommendation(
  policy: SearchProgressPolicyV1,
  execution: SearchProgressExecutionAuthorityV1,
  target: SearchTargetV1,
  probes: readonly SearchProbeV1[],
  limitations: readonly SearchLimitationV1[],
  observations: readonly SearchProgressObservationV1[],
  rationale: SearchRemainingWorkRationaleV1,
): SearchProgressRecommendationV1 {
  const current = observations.at(-1);
  if (!current) fail("invalid-recommendation");
  const executionCheckpoint = execution.checkpoints.at(-1);
  if (
    !executionCheckpoint ||
    executionCheckpoint.checkpointSha256 !== current.checkpoint.checkpointSha256
  ) {
    fail("invalid-recommendation");
  }
  const reasons = new Set<SearchProgressReasonCategory>();
  if (current.newUniqueEvidenceCount > 0) reasons.add("new-evidence");
  if (current.newlyCompletedRequiredProbeIds.length > 0) reasons.add("new-required-probe-coverage");
  if (current.remainingRequiredProbeIds.length === 0) reasons.add("required-probes-complete");
  else reasons.add("required-probes-remaining");
  const hardCeiling = limitations.some((limitation) => limitation.category === "hard-ceiling");
  const blocked = limitations.some((limitation) => limitation.impact === "blocking");
  const matched =
    searchTargetSatisfied(target, probes) &&
    (!searchTargetRequiresCompleteCoverage(target) || !blocked);
  const repeated = current.repeatedEquivalentCallCount >= policy.repeatedEquivalentCallLimit;
  const zeroLeaseCount = countTrailing(observations, (observation) => observation.yieldScore === 0);
  const zeroLimit = zeroLeaseCount >= policy.consecutiveZeroYieldLeaseLimit;
  const yields = observations
    .slice(-policy.decliningYieldWindow)
    .map((observation) => observation.yieldScore);
  const declining =
    yields.length === policy.decliningYieldWindow &&
    yields.at(-1) === 0 &&
    yields.some((value) => value > 0) &&
    yields.every((value, index) => index === 0 || value <= (yields[index - 1] ?? value));
  if (matched) reasons.add("positive-match");
  if (hardCeiling) reasons.add("hard-ceiling");
  if (blocked) reasons.add("blocking-limitation");
  if (repeated) reasons.add("repeated-equivalent-zero-yield");
  if (zeroLimit) reasons.add("zero-yield-lease-limit");
  if (declining) reasons.add("declining-yield-saturated");

  const lastDecision =
    execution.decisions.at(-1)?.checkpointSha256 === executionCheckpoint.checkpointSha256
      ? execution.decisions.at(-1)
      : undefined;
  const derivedDecision = lastDecision ?? deriveCurrentExecutionDecision(execution);
  const deniedByCounter = observations.some(
    (observation) =>
      observation.categoryCounts.authorizationDenied > 0 ||
      observation.categoryCounts.governanceDenied > 0,
  );
  const workflowCompleted = executionCheckpoint.reason === "workflow-completed";
  const budgetReasons: readonly ExecutionStopReason[] = [
    "hard-tool-call-ceiling",
    "cumulative-input-limit",
    "cumulative-output-limit",
    "cumulative-time-limit",
    "cost-unavailable",
    "cumulative-cost-limit",
    "provider-turn-limit",
    "lease-limit",
  ];
  const executionDenied = derivedDecision.decision === "denied" || deniedByCounter;
  const executionBudgetTerminal =
    derivedDecision.decision === "denied" &&
    derivedDecision.consideredStopReasons.some((reason) => budgetReasons.includes(reason));
  const benignWorkflowCompletion =
    workflowCompleted &&
    !deniedByCounter &&
    !executionBudgetTerminal &&
    derivedDecision.decision === "denied" &&
    derivedDecision.reason === "checkpoint-not-renewable" &&
    derivedDecision.consideredStopReasons.length === 1 &&
    derivedDecision.consideredStopReasons[0] === "checkpoint-not-renewable";
  if (executionDenied) reasons.add("execution-denied");
  if (executionBudgetTerminal) reasons.add("execution-budget-terminal");
  if (workflowCompleted) reasons.add("workflow-completed");

  let disposition: SearchDisposition = "search-incomplete";
  let saturation: SearchSaturationBindingV1 = { status: "not-observed", observationSha256: null };
  if (matched) {
    disposition = "found";
  } else if (
    benignWorkflowCompletion &&
    current.remainingRequiredProbeIds.length === 0 &&
    declining &&
    !blocked
  ) {
    disposition = "not-found-after-bounded-search";
    saturation = { status: "saturated", observationSha256: current.observationSha256 };
  } else if (hardCeiling) {
    disposition = "stopped-hard-ceiling";
  } else if (executionBudgetTerminal) {
    disposition = "stopped-hard-ceiling";
  } else if (blocked) {
    disposition = "search-blocked";
  } else if (benignWorkflowCompletion) {
    disposition = "search-incomplete";
  } else if (executionDenied || deniedByCounter) {
    disposition = "search-blocked";
  } else if (current.remainingRequiredProbeIds.length === 0 && declining) {
    disposition = "not-found-after-bounded-search";
    saturation = { status: "saturated", observationSha256: current.observationSha256 };
  } else if (repeated || zeroLimit) {
    disposition = "stopped-no-progress";
    saturation = { status: "saturated", observationSha256: current.observationSha256 };
  } else if (current.yieldScore > 0) {
    disposition = "search-still-productive";
    saturation = { status: "productive", observationSha256: current.observationSha256 };
  }
  const renewable =
    !workflowCompleted &&
    !executionDenied &&
    !executionBudgetTerminal &&
    (disposition === "search-still-productive" || disposition === "search-incomplete");
  const recommendation = renewable ? ("renew" as const) : ("stop" as const);
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-search-progress-recommendation" as const,
    targetSha256: target.targetSha256,
    policySha256: policy.policySha256,
    checkpointSha256: current.checkpoint.checkpointSha256,
    observationSha256: current.observationSha256,
    rationaleSha256: rationale.rationaleSha256,
    rationaleAuthority: "non-authoritative" as const,
    renewable,
    recommendation,
    disposition,
    saturation,
    reasonCategories: [...reasons].sort() as SearchProgressReasonCategory[],
  };
  return deepFreeze({ ...body, recommendationSha256: hash(body) });
}

function decodeRecommendation(
  value: unknown,
  policy: SearchProgressPolicyV1,
  execution: SearchProgressExecutionAuthorityV1,
  target: SearchTargetV1,
  probes: readonly SearchProbeV1[],
  limitations: readonly SearchLimitationV1[],
  observations: readonly SearchProgressObservationV1[],
  rationale: SearchRemainingWorkRationaleV1,
): SearchProgressRecommendationV1 {
  const expected = buildRecommendation(
    policy,
    execution,
    target,
    probes,
    limitations,
    observations,
    rationale,
  );
  const item = object(value, "invalid-recommendation");
  if (
    canonicalizeJsonEvidence(item as JsonEvidenceValue) !==
    canonicalizeJsonEvidence(expected as unknown as JsonEvidenceValue)
  )
    fail("invalid-recommendation");
  return expected;
}

function deriveCurrentExecutionDecision(
  execution: SearchProgressExecutionAuthorityV1,
): ExecutionLeaseDecisionV1 {
  const checkpoint = execution.checkpoints.at(-1);
  if (!checkpoint) fail("invalid-recommendation");
  const priorCheckpoints = execution.checkpoints.slice(0, -1);
  const priorDecisions = execution.decisions.filter(
    (decision) => decision.checkpointSha256 !== checkpoint.checkpointSha256,
  );
  try {
    return decideExecutionLeaseRenewal({
      policy: execution.policy,
      identity: execution.identity,
      checkpoint,
      ...(priorCheckpoints.length > 0
        ? { history: { checkpoints: priorCheckpoints, decisions: priorDecisions } }
        : {}),
    });
  } catch {
    fail("invalid-recommendation");
  }
}

function normalizedProbes(
  values: readonly SearchProbeV1[],
  target: SearchTargetV1,
): SearchProbeV1[] {
  const probes = values.map((probe) => decodeSearchProbe(probe, target));
  probes.sort((left, right) => left.id.localeCompare(right.id));
  if (new Set(probes.map((probe) => probe.id)).size !== probes.length) fail("invalid-evidence");
  return probes;
}

function normalizedLimitations(
  values: readonly SearchLimitationV1[],
  target: SearchTargetV1,
  probes: readonly SearchProbeV1[],
): SearchLimitationV1[] {
  const limitations = values.map((limitation) =>
    decodeSearchLimitation(limitation, target, probes),
  );
  limitations.sort((left, right) => left.id.localeCompare(right.id));
  if (new Set(limitations.map((limitation) => limitation.id)).size !== limitations.length)
    fail("invalid-evidence");
  return limitations;
}

function normalizedEvents(
  values: readonly SearchProgressEventV1[],
  target: SearchTargetV1,
  probes: readonly SearchProbeV1[],
  limitations: readonly SearchLimitationV1[],
): SearchProgressEventV1[] {
  const events = values.map((event) =>
    decodeSearchProgressEvent(event, target, probes, limitations),
  );
  events.sort((left, right) => left.sequence - right.sequence);
  if (events.length === 0 || events.some((event, index) => event.sequence !== index + 1)) {
    fail("invalid-observation");
  }
  return events;
}

/** Every caller passes context it has just decoded; only `values` is untrusted. */
function decodeObservationHistory(
  values: readonly SearchProgressObservationV1[],
  target: SearchTargetV1,
  probes: readonly SearchProbeV1[],
  limitations: readonly SearchLimitationV1[],
  execution: SearchProgressExecutionAuthorityV1,
): SearchProgressObservationV1[] {
  const result: SearchProgressObservationV1[] = [];
  for (const value of values) {
    result.push(
      decodeObservationInDecodedContext(value, target, probes, limitations, execution, result),
    );
  }
  return result;
}

function bindingFromCheckpoint(value: ExecutionCheckpointV1): SearchProgressCheckpointBindingV1 {
  return deepFreeze({
    leaseNumber: value.state.leaseNumber,
    checkpointSha256: value.checkpointSha256,
    stateSha256: value.state.stateSha256,
    identitySha256: value.identitySha256,
    policySha256: value.policySha256,
  });
}

function assertCheckpointCounterDeltas(
  execution: SearchProgressExecutionAuthorityV1,
  checkpointIndex: number,
  counts: SearchProgressCategoryCountsV1,
  eventCount: number,
): void {
  const current = execution.checkpoints[checkpointIndex]?.state;
  if (!current) fail("invalid-observation");
  const prior = execution.checkpoints[checkpointIndex - 1]?.state;
  const before = prior?.toolCalls ?? {
    requested: 0,
    executed: 0,
    succeeded: 0,
    failed: 0,
    denied: 0,
    governanceBlocked: 0,
  };
  const delta = {
    requested: current.toolCalls.requested - before.requested,
    succeeded: current.toolCalls.succeeded - before.succeeded,
    failed: current.toolCalls.failed - before.failed,
    denied: current.toolCalls.denied - before.denied,
    governanceBlocked: current.toolCalls.governanceBlocked - before.governanceBlocked,
    executed: current.toolCalls.executed - before.executed,
  };
  const expected = {
    requested: eventCount,
    succeeded: counts.evidenceProduced + counts.noNewEvidence,
    failed:
      counts.toolFailure +
      counts.unsupportedOperation +
      counts.governedAssetDefect +
      counts.governedToolDefect,
    denied: counts.authorizationDenied,
    governanceBlocked: counts.governanceDenied,
  };
  const expectedExecuted = expected.succeeded + expected.failed;
  if (
    delta.requested !== expected.requested ||
    delta.succeeded !== expected.succeeded ||
    delta.failed !== expected.failed ||
    delta.denied !== expected.denied ||
    delta.governanceBlocked !== expected.governanceBlocked ||
    delta.executed !== expectedExecuted ||
    current.leaseExecutedToolCalls !== expectedExecuted
  ) {
    fail("invalid-observation");
  }
}

function categoryCounts(events: readonly SearchProgressEventV1[]): SearchProgressCategoryCountsV1 {
  const count = (category: SearchProgressEventCategory) =>
    events.filter((event) => event.category === category).length;
  return {
    evidenceProduced: count("evidence-produced"),
    noNewEvidence: count("no-new-evidence"),
    toolFailure: count("tool-failure"),
    authorizationDenied: count("authorization-denied"),
    governanceDenied: count("governance-denied"),
    unsupportedOperation: count("unsupported-operation"),
    governedAssetDefect: count("governed-asset-defect"),
    governedToolDefect: count("governed-tool-defect"),
  };
}

function limitationMatches(
  category: SearchProgressEventCategory,
  limitation: SearchLimitationV1,
): boolean {
  const allowed: Record<string, readonly SearchLimitationV1["category"][]> = {
    "tool-failure": ["tool-failure", "timeout", "index-incomplete"],
    "authorization-denied": ["access-denied"],
    "governance-denied": ["evidence-unavailable", "scope-excluded"],
    "unsupported-operation": ["unsupported-operation"],
    "governed-asset-defect": ["evidence-unavailable", "index-incomplete"],
    "governed-tool-defect": ["tool-failure", "unsupported-operation", "evidence-unavailable"],
  };
  return (allowed[category] ?? []).includes(limitation.category);
}

function isBlockingEvent(category: SearchProgressEventCategory): boolean {
  return category !== "evidence-produced" && category !== "no-new-evidence";
}

function countTrailing<T>(values: readonly T[], predicate: (value: T) => boolean): number {
  let count = 0;
  for (let index = values.length - 1; index >= 0 && predicate(values[index] as T); index -= 1)
    count += 1;
  return count;
}

function normalizedCitations(
  values: readonly SearchCitationV1[],
  code: SearchProgressContractError["code"],
): SearchCitationV1[] {
  const result = values.map((citation) => {
    const item = object(citation, code);
    requireKeys(item, ["path", "anchorSha256"], code);
    return {
      path: relativePath(item.path, code),
      anchorSha256: nullableDigest(item.anchorSha256, code),
    };
  });
  result.sort(
    (left, right) =>
      left.path.localeCompare(right.path) ||
      String(left.anchorSha256).localeCompare(String(right.anchorSha256)),
  );
  const keys = result.map((citation) => `${citation.path}:${citation.anchorSha256 ?? ""}`);
  return result.filter((_citation, index) => index === 0 || keys[index] !== keys[index - 1]);
}

function requireInert(value: unknown, code: SearchProgressContractError["code"]): void {
  kitFor(code).assertInert(value);
}

function rejectCredentials(value: unknown, code: SearchProgressContractError["code"]): void {
  kitFor(code).rejectCredentials(value);
}

function requireKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  code: SearchProgressContractError["code"],
): void {
  kitFor(code).exact(value, keys);
}

function object(
  value: unknown,
  code: SearchProgressContractError["code"],
): Record<string, unknown> {
  requireInert(value, code);
  return kitFor(code).object(value);
}

function array(value: unknown, code: SearchProgressContractError["code"]): unknown[] {
  return kitFor(code).array(value);
}

function enumValue<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  code: SearchProgressContractError["code"],
): T[number] {
  return kitFor(code).enumeration(value, allowed);
}

function positive(value: unknown, code: SearchProgressContractError["code"]): number {
  const number = nonnegative(value, code);
  if (number === 0) fail(code);
  return number;
}

function nonnegative(value: unknown, code: SearchProgressContractError["code"]): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) fail(code);
  return value;
}

function digest(value: unknown, code: SearchProgressContractError["code"]): string {
  return kitFor(code).hash(value);
}

function nullableDigest(value: unknown, code: SearchProgressContractError["code"]): string | null {
  return kitFor(code).nullableHash(value);
}

function nullableId(value: unknown, code: SearchProgressContractError["code"]): string | null {
  return value === null ? null : safeId(value, code);
}

function safeId(value: unknown, code: SearchProgressContractError["code"]): string {
  if (
    typeof value !== "string" ||
    !/^[a-z0-9][a-z0-9._:-]{0,127}$/u.test(value) ||
    value.includes("..") ||
    containsConfiguredCredential(value)
  )
    fail(code);
  return value;
}

function sortedUniqueIds(
  values: readonly unknown[],
  code: SearchProgressContractError["code"],
): string[] {
  const result = values.map((value) => safeId(value, code)).sort();
  if (new Set(result).size !== result.length) fail(code);
  return result;
}

function relativePath(value: unknown, code: SearchProgressContractError["code"]): string {
  if (
    typeof value !== "string" ||
    value !== value.normalize("NFC") ||
    value.length === 0 ||
    value.length > 512 ||
    value.includes("\0") ||
    !/^[A-Za-z0-9._+/-]+$/u.test(value) ||
    value.includes("\\") ||
    isAbsolute(value) ||
    /^[A-Za-z]:/u.test(value) ||
    value.split("/").some((part) => !part || part === "." || part === "..") ||
    containsConfiguredCredential(value)
  )
    fail(code);
  return value;
}

function hash(value: unknown): string {
  return createHash("sha256")
    .update(canonicalizeJsonEvidence(value as JsonEvidenceValue))
    .digest("hex");
}

function assertCanonicalBody(
  item: Record<string, unknown>,
  key: string,
  body: unknown,
  code: SearchProgressContractError["code"],
): string {
  const supplied = { ...item };
  delete supplied[key];
  if (
    canonicalizeJsonEvidence(supplied as JsonEvidenceValue) !==
    canonicalizeJsonEvidence(body as JsonEvidenceValue)
  )
    fail(code);
  const value = digest(item[key], code);
  if (value !== hash(body)) fail(code);
  return value;
}
