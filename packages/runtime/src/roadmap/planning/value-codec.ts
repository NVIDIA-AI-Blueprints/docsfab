// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { types as utilTypes } from "node:util";
import {
  screenCredentialText,
  screenCredentialValue,
  tokenPrefixRuleIds,
} from "../../security/credential-shape-findings.js";
import { detectCredentialRuleIdsInValue } from "../../security/repository-scanner.js";
import { compareText } from "../../shared/primitives.js";
import { roadmapDigest } from "../contracts/decode.js";
import { requireCondition } from "./protocol.js";
import type {
  RoadmapPlanningDraft,
  RoadmapPlanningRankedProposal,
  SanitizedRoadmapIssue,
} from "./schema.js";

export function decodeDraft(value: unknown, path: string): RoadmapPlanningDraft {
  const item = closed(
    value,
    path,
    [
      "kind",
      "title",
      "summary",
      "acceptanceCriteria",
      "verification",
      "evidencePaths",
      "selfContained",
      "requiredParentContext",
    ],
    [
      "kind",
      "title",
      "summary",
      "acceptanceCriteria",
      "verification",
      "evidencePaths",
      "selfContained",
    ],
  );
  const draft: RoadmapPlanningDraft = {
    kind: enumeration(
      item.kind,
      ["saga", "issue", "update", "closeout", "investigation"] as const,
      `${path}.kind`,
    ),
    title: safeContent(item.title, `${path}.title`),
    summary: safeContent(item.summary, `${path}.summary`),
    acceptanceCriteria: contentArray(item.acceptanceCriteria, `${path}.acceptanceCriteria`),
    verification: contentArray(item.verification, `${path}.verification`),
    evidencePaths: pathArray(item.evidencePaths, `${path}.evidencePaths`),
    selfContained: boolean(item.selfContained, `${path}.selfContained`),
    ...(item.requiredParentContext === undefined
      ? {}
      : {
          requiredParentContext: safeContent(
            item.requiredParentContext,
            `${path}.requiredParentContext`,
          ),
        }),
  };
  requireCondition(
    draft.acceptanceCriteria.length > 0 && draft.verification.length > 0,
    "invalid-input",
    path,
  );
  requireCondition(
    draft.selfContained
      ? draft.requiredParentContext === undefined
      : draft.requiredParentContext !== undefined,
    "invalid-input",
    `${path}.requiredParentContext`,
  );
  requireCondition(
    screenCredentialValue(draft, `roadmap-planning:${path}`, detectCredentialRuleIdsInValue) ===
      null,
    "unsafe-content",
    path,
  );
  return draft;
}

export function decodeIssues(value: unknown): SanitizedRoadmapIssue[] {
  const issues = denseArray(value, "$.tracker").map((child, index) => {
    const path = `$.tracker[${index}]`;
    const item = closed(child, path, [
      "iid",
      "state",
      "updatedAt",
      "identityDigest",
      "findingFingerprints",
      "materialEvidenceDigests",
    ]);
    return {
      iid: positiveInteger(item.iid, `${path}.iid`),
      state: enumeration(item.state, ["opened", "closed"] as const, `${path}.state`),
      updatedAt: timestamp(item.updatedAt, `${path}.updatedAt`),
      identityDigest: digest(item.identityDigest, `${path}.identityDigest`),
      findingFingerprints: digestArray(item.findingFingerprints, `${path}.findingFingerprints`),
      materialEvidenceDigests: digestArray(
        item.materialEvidenceDigests,
        `${path}.materialEvidenceDigests`,
      ),
    };
  });
  unique(
    issues.map((item) => String(item.iid)),
    "$.tracker",
  );
  return issues.sort((left, right) => left.iid - right.iid);
}

export function decodeRankedProposal(value: unknown, path: string): RoadmapPlanningRankedProposal {
  const item = closed(
    value,
    path,
    [
      "candidateId",
      "findingId",
      "findingFingerprint",
      "action",
      "issueIid",
      "confidence",
      "score",
      "reasons",
      "operationKey",
      "draft",
    ],
    ["candidateId", "findingId", "findingFingerprint", "action", "confidence", "score", "reasons"],
  );
  return {
    candidateId: identifier(item.candidateId, `${path}.candidateId`),
    findingId: identifier(item.findingId, `${path}.findingId`),
    findingFingerprint: digest(item.findingFingerprint, `${path}.findingFingerprint`),
    action: enumeration(
      item.action,
      ["create", "extend", "link", "supersede", "investigate", "none"] as const,
      `${path}.action`,
    ),
    ...(item.issueIid === undefined
      ? {}
      : { issueIid: positiveInteger(item.issueIid, `${path}.issueIid`) }),
    confidence: confidence(item.confidence, `${path}.confidence`),
    score: integer(item.score, `${path}.score`),
    reasons: contentArray(item.reasons, `${path}.reasons`),
    ...(item.operationKey === undefined
      ? {}
      : { operationKey: identifier(item.operationKey, `${path}.operationKey`) }),
    ...(item.draft === undefined ? {} : { draft: decodeDraft(item.draft, `${path}.draft`) }),
  };
}

export type JsonObject = Record<string, unknown>;

const SHA = /^[a-f0-9]{64}$/u;

const REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

const IDENTIFIER = /^[a-z0-9](?:[a-z0-9._:/-]{0,255})$/u;

export function closed(
  value: unknown,
  path: string,
  allowed: readonly string[],
  required: readonly string[] = allowed,
): JsonObject {
  requireCondition(
    typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      !utilTypes.isProxy(value),
    "invalid-input",
    path,
  );
  const proto = Object.getPrototypeOf(value);
  requireCondition(proto === Object.prototype || proto === null, "invalid-input", path);
  const keys = Reflect.ownKeys(value);
  requireCondition(
    keys.every((key): key is string => typeof key === "string"),
    "invalid-input",
    path,
  );
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    requireCondition(
      Object.hasOwn(descriptor, "value") && descriptor.enumerable && allowed.includes(key),
      "invalid-input",
      `${path}.${key}`,
    );
  }
  for (const key of required)
    requireCondition(Object.hasOwn(value, key), "invalid-input", `${path}.${key}`);
  return value as JsonObject;
}

export function denseArray(value: unknown, path: string): unknown[] {
  requireCondition(!utilTypes.isProxy(value) && Array.isArray(value), "invalid-input", path);
  requireCondition(Object.getPrototypeOf(value) === Array.prototype, "invalid-input", path);
  const keys = Reflect.ownKeys(value);
  const length = Object.getOwnPropertyDescriptor(value, "length");
  requireCondition(
    length !== undefined &&
      Object.hasOwn(length, "value") &&
      typeof length.value === "number" &&
      Number.isSafeInteger(length.value) &&
      length.value >= 0,
    "invalid-input",
    `${path}.length`,
  );
  const result: unknown[] = [];
  for (let index = 0; index < length.value; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    requireCondition(
      descriptor !== undefined && Object.hasOwn(descriptor, "value"),
      "invalid-input",
      `${path}[${index}]`,
    );
    result.push(descriptor.value);
  }
  requireCondition(
    keys.length === result.length + 1 &&
      keys.every(
        (key) => key === "length" || (typeof key === "string" && /^(?:0|[1-9][0-9]*)$/u.test(key)),
      ),
    "invalid-input",
    path,
  );
  return result;
}

export function safeContent(value: unknown, path: string): string {
  requireCondition(
    typeof value === "string" &&
      value.length > 0 &&
      value.length <= 4_096 &&
      value === value.normalize("NFC") &&
      !value.includes("\0") &&
      screenCredentialText(value, `roadmap-planning:${path}`, (text) =>
        tokenPrefixRuleIds(text, { anchored: true }),
      ) === null,
    "unsafe-content",
    path,
  );
  return value;
}

export function identifier(value: unknown, path: string): string {
  const result = safeContent(value, path);
  requireCondition(IDENTIFIER.test(result) && !result.includes(":/"), "invalid-input", path);
  return result;
}

export function safePath(value: unknown, path: string): string {
  const result = safeContent(value, path);
  requireCondition(
    !result.startsWith("/") &&
      !/^[A-Za-z]:/u.test(result) &&
      !result.includes("\\") &&
      result.split("/").every((part) => part && part !== "." && part !== ".."),
    "invalid-input",
    path,
  );
  return result;
}

export function timestamp(value: unknown, path: string): string {
  requireCondition(
    typeof value === "string" && new Date(value).toISOString() === value,
    "invalid-input",
    path,
  );
  return value;
}

export function digest(value: unknown, path: string): string {
  requireCondition(typeof value === "string" && SHA.test(value), "invalid-input", path);
  return value;
}

export function revision(value: unknown, path: string): string {
  requireCondition(typeof value === "string" && REVISION.test(value), "invalid-input", path);
  return value;
}

export function positiveInteger(value: unknown, path: string): number {
  requireCondition(
    typeof value === "number" && Number.isSafeInteger(value) && value > 0,
    "invalid-input",
    path,
  );
  return value;
}

export function integer(value: unknown, path: string): number {
  requireCondition(typeof value === "number" && Number.isSafeInteger(value), "invalid-input", path);
  return value;
}

export function boundedInteger(value: unknown, path: string, min: number, max: number): number {
  const result = integer(value, path);
  requireCondition(result >= min && result <= max, "invalid-input", path);
  return result;
}

export function confidence(value: unknown, path: string): number {
  requireCondition(
    typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1,
    "invalid-input",
    path,
  );
  return value;
}

export function boolean(value: unknown, path: string): boolean {
  requireCondition(typeof value === "boolean", "invalid-input", path);
  return value;
}

export function enumeration<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
): T {
  requireCondition(
    typeof value === "string" && allowed.includes(value as T),
    "invalid-input",
    path,
  );
  return value as T;
}

export function textArray(value: unknown, path: string): string[] {
  return denseArray(value, path).map((item, index) => identifier(item, `${path}[${index}]`));
}

export function contentArray(value: unknown, path: string): string[] {
  return denseArray(value, path).map((item, index) => safeContent(item, `${path}[${index}]`));
}

export function pathArray(value: unknown, path: string): string[] {
  const result = denseArray(value, path).map((item, index) => safePath(item, `${path}[${index}]`));
  unique(result, path);
  return result.sort(compareText);
}

export function digestArray(value: unknown, path: string): string[] {
  const result = denseArray(value, path).map((item, index) => digest(item, `${path}[${index}]`));
  unique(result, path);
  return result.sort(compareText);
}

export function unique(values: string[], path: string): void {
  requireCondition(new Set(values).size === values.length, "invalid-input", path);
}

export function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}
