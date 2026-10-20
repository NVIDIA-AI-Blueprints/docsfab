// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  assertPlainJsonData,
  deepFreeze,
  digest,
  exact,
  fail,
  nonnegative,
  nullableDigest,
  object,
  positive,
  revision,
  sha256,
} from "./codec-helpers.js";
import type {
  AnyExecutionLeasePolicyV1OrV2,
  ExecutionLeaseAggregatePolicyV2,
  ExecutionLeaseCumulativePolicyV1,
  ExecutionLeaseIdentityV1,
  ExecutionLeasePolicyV1,
  ExecutionLeasePolicyV2,
} from "../lease-contracts.js";

export function decodeExecutionLeaseAggregatePolicyV2(
  value: unknown,
): ExecutionLeaseAggregatePolicyV2 {
  const policy = object(value, "invalid-policy");
  exact(policy, ["kind"], "invalid-policy");
  if (policy.kind !== "absent") fail("invalid-policy");
  return { kind: "absent" };
}

export function decodeAnyExecutionLeasePolicy(value: unknown): AnyExecutionLeasePolicyV1OrV2 {
  const item = object(value, "invalid-policy");
  return item.schemaVersion === 2
    ? decodeExecutionLeasePolicyV2(item)
    : decodeExecutionLeasePolicyV1(item);
}

export function decodeExecutionLeasePolicy(value: unknown): ExecutionLeasePolicyV1 {
  return decodeExecutionLeasePolicyV1(value);
}

export function decodeExecutionLeasePolicyV1(value: unknown): ExecutionLeasePolicyV1 {
  assertPlainJsonData(value, "invalid-policy");
  const item = object(value, "invalid-policy");
  exact(
    item,
    [
      "schemaVersion",
      "kind",
      "callsPerLease",
      "maxLeases",
      "hardToolCallCeiling",
      "answerRecordCallCeiling",
      "sharedToolCallCapacity",
      "maxProviderTurns",
      "maxCompactions",
      "cumulative",
      "policySha256",
    ],
    "invalid-policy",
    ["answerRecordCallCeiling", "sharedToolCallCapacity"],
  );
  if (item.schemaVersion !== 1 || item.kind !== "docsfab-execution-lease-policy") {
    fail("migration-required");
  }
  const callsPerLease = positive(item.callsPerLease, "invalid-policy");
  const maxLeases = positive(item.maxLeases, "invalid-policy");
  const hardToolCallCeiling = positive(item.hardToolCallCeiling, "invalid-policy");
  const maxProviderTurns = positive(item.maxProviderTurns, "invalid-policy");
  const maxCompactions = nonnegative(item.maxCompactions, "invalid-policy");
  const answerRecordCallCeiling =
    item.answerRecordCallCeiling === undefined
      ? undefined
      : positive(item.answerRecordCallCeiling, "invalid-policy");
  if (item.sharedToolCallCapacity !== undefined && item.sharedToolCallCapacity !== true) {
    fail("invalid-policy");
  }
  const sharedToolCallCapacity = item.sharedToolCallCapacity === true;
  if (
    (sharedToolCallCapacity && answerRecordCallCeiling === undefined) ||
    (answerRecordCallCeiling === undefined && callsPerLease > hardToolCallCeiling) ||
    (!sharedToolCallCapacity && hardToolCallCeiling > callsPerLease * maxLeases) ||
    (answerRecordCallCeiling !== undefined &&
      (!Number.isSafeInteger(hardToolCallCeiling + answerRecordCallCeiling) ||
        (!sharedToolCallCapacity &&
          hardToolCallCeiling + answerRecordCallCeiling > callsPerLease * maxLeases))) ||
    !Number.isSafeInteger(callsPerLease * maxLeases) ||
    (!sharedToolCallCapacity && maxProviderTurns < hardToolCallCeiling + maxLeases) ||
    (sharedToolCallCapacity && maxProviderTurns < maxLeases)
  ) {
    fail("invalid-policy");
  }
  const cumulativeItem = object(item.cumulative, "invalid-policy");
  exact(
    cumulativeItem,
    ["maxInputTokens", "maxOutputTokens", "maxElapsedMs", "maxKnownCostMicrousd"],
    "invalid-policy",
    ["maxKnownCostMicrousd"],
  );
  const cumulative: ExecutionLeaseCumulativePolicyV1 = {
    maxInputTokens: positive(cumulativeItem.maxInputTokens, "invalid-policy"),
    maxOutputTokens: positive(cumulativeItem.maxOutputTokens, "invalid-policy"),
    maxElapsedMs: positive(cumulativeItem.maxElapsedMs, "invalid-policy"),
    ...(cumulativeItem.maxKnownCostMicrousd === undefined
      ? {}
      : { maxKnownCostMicrousd: positive(cumulativeItem.maxKnownCostMicrousd, "invalid-policy") }),
  };
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-execution-lease-policy" as const,
    callsPerLease,
    maxLeases,
    hardToolCallCeiling,
    ...(answerRecordCallCeiling === undefined ? {} : { answerRecordCallCeiling }),
    ...(sharedToolCallCapacity ? { sharedToolCallCapacity: true as const } : {}),
    maxProviderTurns,
    maxCompactions,
    cumulative,
  };
  digest(item.policySha256, "invalid-policy");
  if (item.policySha256 !== sha256(body, "invalid-policy")) fail("invalid-policy");
  return deepFreeze({ ...body, policySha256: item.policySha256 });
}

export function decodeExecutionLeasePolicyV2(value: unknown): ExecutionLeasePolicyV2 {
  assertPlainJsonData(value, "invalid-policy");
  const item = object(value, "invalid-policy");
  exact(
    item,
    [
      "schemaVersion",
      "kind",
      "callsPerLease",
      "sharedToolCallCapacity",
      "aggregatePolicy",
      "policySha256",
    ],
    "invalid-policy",
  );
  if (item.schemaVersion !== 2 || item.kind !== "docsfab-execution-lease-policy") {
    fail("migration-required");
  }
  const body = {
    schemaVersion: 2 as const,
    kind: "docsfab-execution-lease-policy" as const,
    callsPerLease: positive(item.callsPerLease, "invalid-policy"),
    sharedToolCallCapacity:
      item.sharedToolCallCapacity === true ? (true as const) : fail("invalid-policy"),
    aggregatePolicy: decodeExecutionLeaseAggregatePolicyV2(item.aggregatePolicy),
  };
  digest(item.policySha256, "invalid-policy");
  if (item.policySha256 !== sha256(body, "invalid-policy")) fail("invalid-policy");
  return deepFreeze({ ...body, policySha256: item.policySha256 });
}

export function decodeExecutionLeaseIdentity(value: unknown): ExecutionLeaseIdentityV1 {
  assertPlainJsonData(value, "invalid-identity");
  const item = object(value, "invalid-identity");
  exact(
    item,
    [
      "schemaVersion",
      "kind",
      "inferenceAttempt",
      "retriesConsumed",
      "authorizationSha256",
      "repositoryRevision",
      "contextPacketSha256",
      "evidenceSha256",
      "toolPolicySha256",
      "contextAuthoritySha256",
      "policySha256",
      "identitySha256",
    ],
    "invalid-identity",
  );
  if (item.schemaVersion !== 1 || item.kind !== "docsfab-execution-lease-identity") {
    fail("migration-required");
  }
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-execution-lease-identity" as const,
    inferenceAttempt: positive(item.inferenceAttempt, "invalid-identity"),
    retriesConsumed: nonnegative(item.retriesConsumed, "invalid-identity"),
    authorizationSha256: nullableDigest(item.authorizationSha256, "invalid-identity"),
    repositoryRevision: revision(item.repositoryRevision, "invalid-identity"),
    contextPacketSha256: nullableDigest(item.contextPacketSha256, "invalid-identity"),
    evidenceSha256: digest(item.evidenceSha256, "invalid-identity"),
    toolPolicySha256: digest(item.toolPolicySha256, "invalid-identity"),
    contextAuthoritySha256: digest(item.contextAuthoritySha256, "invalid-identity"),
    policySha256: digest(item.policySha256, "invalid-identity"),
  };
  digest(item.identitySha256, "invalid-identity");
  if (item.identitySha256 !== sha256(body, "invalid-identity")) fail("invalid-identity");
  return deepFreeze({ ...body, identitySha256: item.identitySha256 });
}
