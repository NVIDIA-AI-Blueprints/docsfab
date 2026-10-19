// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { ROADMAP_OPERATION_KINDS } from "../contracts/mutation.js";
import { compareText } from "../../shared/primitives.js";
import { ROADMAP_EFFECT_KINDS, type RoadmapEffectKind } from "./schema.js";
import {
  array,
  closed,
  digest,
  enumeration,
  externalId,
  idArray,
  identifier,
  positiveInteger,
  requireValue,
  timestamp,
} from "./primitives.js";
import type {
  RoadmapEffectIdentity,
  RoadmapMutationAttemptV2,
  RoadmapMutationOperationV2,
  RoadmapMutationOperationV2Input,
  RoadmapMutationPreconditionV2,
  RoadmapMutationProposalV2,
  RoadmapMutationTargetV2,
} from "./schema.js";

export function preconditionKey(value: RoadmapMutationPreconditionV2): string {
  return value.source === "ledger-observation"
    ? `ledger:${value.targetKey}`
    : `dependency:${value.operationKey}:${value.effectKind}`;
}
export function operation(value: unknown, path: string): RoadmapMutationOperationV2 {
  const item = closed(
    value,
    path,
    [
      "key",
      "kind",
      "findingIds",
      "dependsOnOperationKeys",
      "target",
      "relatedTarget",
      "preconditions",
      "proposal",
      "proposalDigest",
      "materialDigest",
      "materialBytes",
      "expectedEffectKind",
      "idempotencyKey",
    ],
    [
      "key",
      "kind",
      "findingIds",
      "dependsOnOperationKeys",
      "target",
      "preconditions",
      "proposal",
      "proposalDigest",
      "materialDigest",
      "materialBytes",
      "expectedEffectKind",
      "idempotencyKey",
    ],
  );
  return {
    key: identifier(item.key, `${path}.key`),
    kind: enumeration(item.kind, ROADMAP_OPERATION_KINDS, `${path}.kind`),
    findingIds: idArray(item.findingIds, `${path}.findingIds`),
    dependsOnOperationKeys: idArray(item.dependsOnOperationKeys, `${path}.dependsOnOperationKeys`),
    target: target(item.target, `${path}.target`),
    ...(item.relatedTarget === undefined
      ? {}
      : { relatedTarget: target(item.relatedTarget, `${path}.relatedTarget`) }),
    preconditions: array(item.preconditions, `${path}.preconditions`)
      .map((value, index) => precondition(value, `${path}.preconditions[${index}]`))
      .sort((left, right) => compareText(preconditionKey(left), preconditionKey(right))),
    proposal: proposal(item.proposal, `${path}.proposal`),
    proposalDigest: digest(item.proposalDigest, `${path}.proposalDigest`),
    materialDigest: digest(item.materialDigest, `${path}.materialDigest`),
    materialBytes: positiveInteger(item.materialBytes, `${path}.materialBytes`),
    expectedEffectKind: enumeration(
      item.expectedEffectKind,
      ROADMAP_EFFECT_KINDS,
      `${path}.expectedEffectKind`,
    ),
    idempotencyKey: digest(item.idempotencyKey, `${path}.idempotencyKey`),
  };
}

export function operationInput(value: unknown, path: string): RoadmapMutationOperationV2Input {
  const item = closed(
    value,
    path,
    [
      "key",
      "kind",
      "findingIds",
      "dependsOnOperationKeys",
      "target",
      "relatedTarget",
      "preconditions",
      "proposal",
      "materialDigest",
      "materialBytes",
      "expectedEffectKind",
    ],
    [
      "key",
      "kind",
      "findingIds",
      "dependsOnOperationKeys",
      "target",
      "preconditions",
      "proposal",
      "materialDigest",
      "materialBytes",
      "expectedEffectKind",
    ],
  );
  return {
    key: identifier(item.key, `${path}.key`),
    kind: enumeration(item.kind, ROADMAP_OPERATION_KINDS, `${path}.kind`),
    findingIds: idArray(item.findingIds, `${path}.findingIds`),
    dependsOnOperationKeys: idArray(item.dependsOnOperationKeys, `${path}.dependsOnOperationKeys`),
    target: target(item.target, `${path}.target`),
    ...(item.relatedTarget === undefined
      ? {}
      : { relatedTarget: target(item.relatedTarget, `${path}.relatedTarget`) }),
    preconditions: array(item.preconditions, `${path}.preconditions`)
      .map((preconditionValue, index) =>
        precondition(preconditionValue, `${path}.preconditions[${index}]`),
      )
      .sort((left, right) => compareText(preconditionKey(left), preconditionKey(right))),
    proposal: proposal(item.proposal, `${path}.proposal`),
    materialDigest: digest(item.materialDigest, `${path}.materialDigest`),
    materialBytes: positiveInteger(item.materialBytes, `${path}.materialBytes`),
    expectedEffectKind: enumeration(
      item.expectedEffectKind,
      ROADMAP_EFFECT_KINDS,
      `${path}.expectedEffectKind`,
    ),
  };
}

function target(value: unknown, path: string): RoadmapMutationTargetV2 {
  const base = closed(
    value,
    path,
    ["source", "targetKey", "operationKey", "effectKind"],
    ["source"],
    true,
  );
  const source = enumeration(
    base.source,
    ["project", "ledger-observation", "dependency-result"] as const,
    `${path}.source`,
  );
  if (source === "dependency-result") {
    const item = closed(value, path, ["source", "operationKey", "effectKind"]);
    return {
      source,
      operationKey: identifier(item.operationKey, `${path}.operationKey`),
      effectKind: enumeration(item.effectKind, ROADMAP_EFFECT_KINDS, `${path}.effectKind`),
    };
  }
  const item = closed(value, path, ["source", "targetKey"]);
  return { source, targetKey: identifier(item.targetKey, `${path}.targetKey`) };
}

function precondition(value: unknown, path: string): RoadmapMutationPreconditionV2 {
  const base = closed(
    value,
    path,
    ["source", "targetKey", "observedAt", "identityDigest", "operationKey", "effectKind"],
    ["source"],
    true,
  );
  const source = enumeration(
    base.source,
    ["ledger-observation", "dependency-result"] as const,
    `${path}.source`,
  );
  if (source === "dependency-result") {
    const item = closed(value, path, ["source", "operationKey", "effectKind"]);
    return {
      source,
      operationKey: identifier(item.operationKey, `${path}.operationKey`),
      effectKind: enumeration(item.effectKind, ROADMAP_EFFECT_KINDS, `${path}.effectKind`),
    };
  }
  const item = closed(value, path, ["source", "targetKey", "observedAt", "identityDigest"]);
  return {
    source,
    targetKey: identifier(item.targetKey, `${path}.targetKey`),
    observedAt: timestamp(item.observedAt, `${path}.observedAt`),
    identityDigest: digest(item.identityDigest, `${path}.identityDigest`),
  };
}

function proposal(value: unknown, path: string): RoadmapMutationProposalV2 {
  const item = closed(value, path, ["kind", "intent", "effectKind"]);
  return {
    kind: enumeration(item.kind, ROADMAP_OPERATION_KINDS, `${path}.kind`),
    intent: enumeration(
      item.intent,
      [
        "create",
        "update",
        "comment",
        "link",
        "assign-label",
        "assign-milestone",
        "close",
        "reopen",
      ] as const,
      `${path}.intent`,
    ),
    effectKind: enumeration(item.effectKind, ROADMAP_EFFECT_KINDS, `${path}.effectKind`),
  };
}

export function attempt(value: unknown, path: string): RoadmapMutationAttemptV2 {
  const item = closed(
    value,
    path,
    [
      "operationKey",
      "attempt",
      "idempotencyKey",
      "phase",
      "disposition",
      "startedAt",
      "completedAt",
      "before",
      "effect",
      "failureCode",
      "reconcilesAttempt",
    ],
    [
      "operationKey",
      "attempt",
      "idempotencyKey",
      "phase",
      "disposition",
      "startedAt",
      "completedAt",
    ],
  );
  return {
    operationKey: identifier(item.operationKey, `${path}.operationKey`),
    attempt: positiveInteger(item.attempt, `${path}.attempt`),
    idempotencyKey: digest(item.idempotencyKey, `${path}.idempotencyKey`),
    phase: enumeration(item.phase, ["mutation", "reconciliation"] as const, `${path}.phase`),
    disposition: enumeration(
      item.disposition,
      ["succeeded", "failed", "reused", "skipped", "ambiguous"] as const,
      `${path}.disposition`,
    ),
    startedAt: timestamp(item.startedAt, `${path}.startedAt`),
    completedAt: timestamp(item.completedAt, `${path}.completedAt`),
    ...(item.before === undefined ? {} : { before: effectIdentity(item.before, `${path}.before`) }),
    ...(item.effect === undefined ? {} : { effect: effectIdentity(item.effect, `${path}.effect`) }),
    ...(item.failureCode === undefined
      ? {}
      : { failureCode: identifier(item.failureCode, `${path}.failureCode`) }),
    ...(item.reconcilesAttempt === undefined
      ? {}
      : {
          reconcilesAttempt: positiveInteger(item.reconcilesAttempt, `${path}.reconcilesAttempt`),
        }),
  };
}

export function effectIdentity(value: unknown, path: string): RoadmapEffectIdentity {
  const base = closed(
    value,
    path,
    [
      "kind",
      "targetKey",
      "externalId",
      "state",
      "updatedAt",
      "identityDigest",
      "operationProofDigest",
      "subjectTargetKey",
      "relatedTargetKey",
    ],
    ["kind"],
    true,
  );
  const kind = enumeration(base.kind, ROADMAP_EFFECT_KINDS, `${path}.kind`);
  if (kind === "note") {
    const item = closed(
      value,
      path,
      [
        "kind",
        "targetKey",
        "externalId",
        "state",
        "updatedAt",
        "identityDigest",
        "operationProofDigest",
        "subjectTargetKey",
      ],
      [
        "kind",
        "targetKey",
        "externalId",
        "state",
        "updatedAt",
        "identityDigest",
        "subjectTargetKey",
      ],
    );
    requireValue(item.state === "present", "invalid-value", `${path}.state`);
    const targetKey = noteKey(item.targetKey, `${path}.targetKey`);
    const external = externalId(item.externalId, `${path}.externalId`);
    const subjectTargetKey = issueKey(item.subjectTargetKey, `${path}.subjectTargetKey`);
    const match = /^note:([1-9][0-9]*):([1-9][0-9]*)$/u.exec(targetKey)!;
    requireValue(
      match[1] === issueKeyComponent(subjectTargetKey) && match[2] === external,
      "tracker-drift",
      path,
    );
    return {
      kind,
      targetKey,
      externalId: external,
      state: "present",
      updatedAt: timestamp(item.updatedAt, `${path}.updatedAt`),
      identityDigest: digest(item.identityDigest, `${path}.identityDigest`),
      ...effectProof(item.operationProofDigest, path),
      subjectTargetKey,
    };
  }
  if (kind === "link") {
    const item = closed(
      value,
      path,
      [
        "kind",
        "targetKey",
        "externalId",
        "state",
        "updatedAt",
        "identityDigest",
        "operationProofDigest",
        "subjectTargetKey",
        "relatedTargetKey",
      ],
      [
        "kind",
        "targetKey",
        "externalId",
        "state",
        "updatedAt",
        "identityDigest",
        "subjectTargetKey",
        "relatedTargetKey",
      ],
    );
    requireValue(item.state === "present", "invalid-value", `${path}.state`);
    const targetKey = linkKey(item.targetKey, `${path}.targetKey`);
    const external = externalId(item.externalId, `${path}.externalId`);
    requireValue(targetKey === `link:${external}`, "tracker-drift", path);
    return {
      kind,
      targetKey,
      externalId: external,
      state: "present",
      updatedAt: timestamp(item.updatedAt, `${path}.updatedAt`),
      identityDigest: digest(item.identityDigest, `${path}.identityDigest`),
      ...effectProof(item.operationProofDigest, path),
      subjectTargetKey: issueKey(item.subjectTargetKey, `${path}.subjectTargetKey`),
      relatedTargetKey: issueKey(item.relatedTargetKey, `${path}.relatedTargetKey`),
    };
  }
  const item = closed(
    value,
    path,
    [
      "kind",
      "targetKey",
      "externalId",
      "state",
      "updatedAt",
      "identityDigest",
      "operationProofDigest",
    ],
    ["kind", "targetKey", "externalId", "state", "updatedAt", "identityDigest"],
  );
  if (kind === "issue") {
    const targetKey = issueKey(item.targetKey, `${path}.targetKey`);
    const external = externalId(item.externalId, `${path}.externalId`);
    requireValue(issueKeyComponent(targetKey) === external, "tracker-drift", path);
    return {
      kind,
      targetKey,
      externalId: external,
      state: enumeration(item.state, ["opened", "closed"] as const, `${path}.state`),
      updatedAt: timestamp(item.updatedAt, `${path}.updatedAt`),
      identityDigest: digest(item.identityDigest, `${path}.identityDigest`),
      ...effectProof(item.operationProofDigest, path),
    };
  }
  const targetKey = milestoneKey(item.targetKey, `${path}.targetKey`);
  const external = externalId(item.externalId, `${path}.externalId`);
  requireValue(targetKey === `milestone:${external}`, "tracker-drift", path);
  return {
    kind,
    targetKey,
    externalId: external,
    state: enumeration(item.state, ["active", "closed"] as const, `${path}.state`),
    updatedAt: timestamp(item.updatedAt, `${path}.updatedAt`),
    identityDigest: digest(item.identityDigest, `${path}.identityDigest`),
    ...effectProof(item.operationProofDigest, path),
  };
}
export function issueIid(value: string): number | undefined {
  const match = /^issue:([1-9][0-9]*)$/u.exec(value);
  return match ? Number(match[1]) : undefined;
}

function issueKey(value: unknown, path: string): string {
  const result = identifier(value, path);
  requireValue(issueIid(result) !== undefined, "invalid-value", path);
  return result;
}

function issueKeyComponent(value: string): string {
  return value.slice("issue:".length);
}

function effectProof(value: unknown, path: string): { operationProofDigest?: string } {
  return value === undefined
    ? {}
    : { operationProofDigest: digest(value, `${path}.operationProofDigest`) };
}

function milestoneKey(value: unknown, path: string): string {
  const result = identifier(value, path);
  requireValue(/^milestone:[1-9][0-9]*$/u.test(result), "invalid-value", path);
  return result;
}

function noteKey(value: unknown, path: string): string {
  const result = identifier(value, path);
  requireValue(/^note:[1-9][0-9]*:[1-9][0-9]*$/u.test(result), "invalid-value", path);
  return result;
}

function linkKey(value: unknown, path: string): string {
  const result = identifier(value, path);
  requireValue(/^link:[1-9][0-9]*$/u.test(result), "invalid-value", path);
  return result;
}
