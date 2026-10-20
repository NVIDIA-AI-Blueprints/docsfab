// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { deepFreeze } from "../contract-kit/freeze.js";
import { roadmapCanonicalJson } from "./contracts/decode.js";
import {
  isRoadmapSkillPackId,
  ROADMAP_SKILL_PACK_CONTRACTS,
  type RoadmapSkillPackId,
} from "../skills/roadmap-pack.js";
import { screenCredentialValue } from "../security/credential-shape-findings.js";
import { detectCredentialRuleIdsInValue } from "../security/repository-scanner.js";

const SHA256 = /^[a-f0-9]{64}$/;
const GIT_OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

export const ROADMAP_HOST_OPERATION_KINDS = [
  "observe-repository-history",
  "observe-tracker",
  "apply-roadmap-mutation",
  "deliver-roadmap-child",
  "update-merge-request-description",
] as const;
export type RoadmapHostOperationKind = (typeof ROADMAP_HOST_OPERATION_KINDS)[number];

export const ROADMAP_PACK_ALLOWED_OPERATIONS = Object.freeze({
  "release-docs-epic": Object.freeze([
    "observe-repository-history",
    "observe-tracker",
    "apply-roadmap-mutation",
  ] as const),
  "doc-fix-issues": Object.freeze(["deliver-roadmap-child"] as const),
  "doc-session-insights": Object.freeze(["observe-tracker", "apply-roadmap-mutation"] as const),
  "doc-pr-auto-sync": Object.freeze(["update-merge-request-description"] as const),
} as const) satisfies Readonly<Record<RoadmapSkillPackId, readonly RoadmapHostOperationKind[]>>;

export interface RoadmapSkillPackIdentity {
  id: RoadmapSkillPackId;
  contractSha256: string;
}

export interface RoadmapHostRepositoryBinding {
  revision: string;
  contentSha256: string;
}

interface RoadmapHostOperationBase {
  schemaVersion: 1;
  kind: "roadmap-host-operation-request";
  operation: RoadmapHostOperationKind;
  requestId: string;
  deduplicationKey: string;
  pack: RoadmapSkillPackIdentity;
  repository: RoadmapHostRepositoryBinding;
  confirmationPolicy: "not-required" | "explicit-authorization-required";
  digest: string;
}

export interface ObserveRepositoryHistoryRequest extends RoadmapHostOperationBase {
  operation: "observe-repository-history";
  confirmationPolicy: "not-required";
  boundaryDigest: string;
}

export interface ObserveTrackerRequest extends RoadmapHostOperationBase {
  operation: "observe-tracker";
  confirmationPolicy: "not-required";
  projectIdentityDigest: string;
  queryDigest: string;
}

export interface ApplyRoadmapMutationRequest extends RoadmapHostOperationBase {
  operation: "apply-roadmap-mutation";
  confirmationPolicy: "explicit-authorization-required";
  ledgerDigest: string;
  planDigest: string;
  authorizationDigest: string;
}

export interface DeliverRoadmapChildRequest extends RoadmapHostOperationBase {
  operation: "deliver-roadmap-child";
  confirmationPolicy: "explicit-authorization-required";
  ledgerDigest: string;
  findingFingerprint: string;
  selectionAuthorizationDigest: string;
  deliveryPlanDigest: string;
}

export interface UpdateMergeRequestDescriptionRequest extends RoadmapHostOperationBase {
  operation: "update-merge-request-description";
  confirmationPolicy: "explicit-authorization-required";
  projectIdentityDigest: string;
  mergeRequestIid: number;
  observedUpdatedAt: string;
  descriptionDigest: string;
  authorizationDigest: string;
}

export type RoadmapHostOperationRequest =
  | ObserveRepositoryHistoryRequest
  | ObserveTrackerRequest
  | ApplyRoadmapMutationRequest
  | DeliverRoadmapChildRequest
  | UpdateMergeRequestDescriptionRequest;

export type RoadmapHostOperationRequestInput = RoadmapHostOperationRequest extends infer Request
  ? Request extends RoadmapHostOperationRequest
    ? Omit<Request, "schemaVersion" | "kind" | "requestId" | "deduplicationKey" | "digest">
    : never
  : never;

type RoadmapHostOperationRequestWithoutDigest = RoadmapHostOperationRequest extends infer Request
  ? Request extends RoadmapHostOperationRequest
    ? Omit<Request, "digest">
    : never
  : never;

export type RoadmapHostOperationRequestErrorCode =
  | "invalid-shape"
  | "invalid-value"
  | "confirmation-bypass"
  | "digest-mismatch";

export class RoadmapHostOperationRequestError extends Error {
  public constructor(
    public readonly code: RoadmapHostOperationRequestErrorCode,
    public readonly field: string,
  ) {
    super(`Roadmap host-operation request failed validation (${code}) at ${field}.`);
    this.name = "RoadmapHostOperationRequestError";
  }
}

export function createRoadmapHostOperationRequest(
  input: RoadmapHostOperationRequestInput,
): Readonly<RoadmapHostOperationRequest> {
  const common = {
    schemaVersion: 1 as const,
    kind: "roadmap-host-operation-request" as const,
    ...input,
  };
  const identityDigest = digestObject(common);
  const candidate = {
    ...common,
    requestId: `roadmap-host:${identityDigest}`,
    deduplicationKey: identityDigest,
  } as RoadmapHostOperationRequestWithoutDigest;
  return validateRoadmapHostOperationRequest({
    ...candidate,
    digest: digestObject(candidate),
  });
}

export function validateRoadmapHostOperationRequest(
  value: unknown,
): Readonly<RoadmapHostOperationRequest> {
  // DocsFab's own configured credential refuses; a value that only looks like
  // a credential is recorded and continues (#1807).
  if (
    screenCredentialValue(value, "roadmap-host-operation", detectCredentialRuleIdsInValue) !== null
  )
    fail("invalid-value", "$");
  const root = object(value, "$", [
    "schemaVersion",
    "kind",
    "operation",
    "requestId",
    "deduplicationKey",
    "pack",
    "repository",
    "confirmationPolicy",
    "digest",
    ...operationFields(value),
  ]);
  if (root.schemaVersion !== 1 || root.kind !== "roadmap-host-operation-request") {
    fail("invalid-value", "$");
  }
  const operation = enumeration(root.operation, ROADMAP_HOST_OPERATION_KINDS, "$.operation");
  const pack = object(root.pack, "$.pack", ["id", "contractSha256"]);
  const repository = object(root.repository, "$.repository", ["revision", "contentSha256"]);
  const packId = identifier(pack.id, "$.pack.id");
  if (!isRoadmapSkillPackId(packId)) fail("invalid-value", "$.pack.id");
  if (
    !(ROADMAP_PACK_ALLOWED_OPERATIONS[packId] as readonly RoadmapHostOperationKind[]).includes(
      operation,
    )
  ) {
    fail("invalid-value", "$.operation");
  }
  const contractSha256 = hash(pack.contractSha256, "$.pack.contractSha256");
  if (contractSha256 !== ROADMAP_SKILL_PACK_CONTRACTS[packId].contractSha256) {
    fail("invalid-value", "$.pack.contractSha256");
  }
  const common = {
    schemaVersion: 1 as const,
    kind: "roadmap-host-operation-request" as const,
    operation,
    requestId: identifier(root.requestId, "$.requestId"),
    deduplicationKey: hash(root.deduplicationKey, "$.deduplicationKey"),
    pack: {
      id: packId,
      contractSha256,
    },
    repository: {
      revision: gitObjectId(repository.revision, "$.repository.revision"),
      contentSha256: hash(repository.contentSha256, "$.repository.contentSha256"),
    },
    confirmationPolicy: confirmation(root.confirmationPolicy, operation),
  };
  let decoded: RoadmapHostOperationRequestWithoutDigest;
  switch (operation) {
    case "observe-repository-history":
      decoded = {
        ...common,
        operation,
        confirmationPolicy: "not-required",
        boundaryDigest: hash(root.boundaryDigest, "$.boundaryDigest"),
      };
      break;
    case "observe-tracker":
      decoded = {
        ...common,
        operation,
        confirmationPolicy: "not-required",
        projectIdentityDigest: hash(root.projectIdentityDigest, "$.projectIdentityDigest"),
        queryDigest: hash(root.queryDigest, "$.queryDigest"),
      };
      break;
    case "apply-roadmap-mutation":
      decoded = {
        ...common,
        operation,
        confirmationPolicy: "explicit-authorization-required",
        ledgerDigest: hash(root.ledgerDigest, "$.ledgerDigest"),
        planDigest: hash(root.planDigest, "$.planDigest"),
        authorizationDigest: hash(root.authorizationDigest, "$.authorizationDigest"),
      };
      break;
    case "deliver-roadmap-child":
      decoded = {
        ...common,
        operation,
        confirmationPolicy: "explicit-authorization-required",
        ledgerDigest: hash(root.ledgerDigest, "$.ledgerDigest"),
        findingFingerprint: hash(root.findingFingerprint, "$.findingFingerprint"),
        selectionAuthorizationDigest: hash(
          root.selectionAuthorizationDigest,
          "$.selectionAuthorizationDigest",
        ),
        deliveryPlanDigest: hash(root.deliveryPlanDigest, "$.deliveryPlanDigest"),
      };
      break;
    case "update-merge-request-description":
      decoded = {
        ...common,
        operation,
        confirmationPolicy: "explicit-authorization-required",
        projectIdentityDigest: hash(root.projectIdentityDigest, "$.projectIdentityDigest"),
        mergeRequestIid: positiveInteger(root.mergeRequestIid, "$.mergeRequestIid"),
        observedUpdatedAt: timestamp(root.observedUpdatedAt, "$.observedUpdatedAt"),
        descriptionDigest: hash(root.descriptionDigest, "$.descriptionDigest"),
        authorizationDigest: hash(root.authorizationDigest, "$.authorizationDigest"),
      };
      break;
  }
  const digest = hash(root.digest, "$.digest");
  if (digest !== digestObject(decoded)) fail("digest-mismatch", "$.digest");
  const identity = { ...decoded } as Record<string, unknown>;
  delete identity.requestId;
  delete identity.deduplicationKey;
  const expectedKey = digestObject(identity);
  if (
    decoded.deduplicationKey !== expectedKey ||
    decoded.requestId !== `roadmap-host:${expectedKey}`
  ) {
    fail("digest-mismatch", "$.deduplicationKey");
  }
  return deepFreeze({ ...decoded, digest } as RoadmapHostOperationRequest);
}

function operationFields(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  switch ((value as Record<string, unknown>).operation) {
    case "observe-repository-history":
      return ["boundaryDigest"];
    case "observe-tracker":
      return ["projectIdentityDigest", "queryDigest"];
    case "apply-roadmap-mutation":
      return ["ledgerDigest", "planDigest", "authorizationDigest"];
    case "deliver-roadmap-child":
      return [
        "ledgerDigest",
        "findingFingerprint",
        "selectionAuthorizationDigest",
        "deliveryPlanDigest",
      ];
    case "update-merge-request-description":
      return [
        "projectIdentityDigest",
        "mergeRequestIid",
        "observedUpdatedAt",
        "descriptionDigest",
        "authorizationDigest",
      ];
    default:
      return [];
  }
}

function confirmation(
  value: unknown,
  operation: RoadmapHostOperationKind,
): RoadmapHostOperationRequest["confirmationPolicy"] {
  const expected =
    operation === "observe-repository-history" || operation === "observe-tracker"
      ? "not-required"
      : "explicit-authorization-required";
  if (value !== expected) fail("confirmation-bypass", "$.confirmationPolicy");
  return expected;
}

function digestObject(value: unknown): string {
  return createHash("sha256").update(roadmapCanonicalJson(value)).digest("hex");
}

function object(value: unknown, field: string, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid-shape", field);
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some((key) => !allowed.includes(key))) fail("invalid-shape", field);
  return item;
}

function enumeration<const T extends readonly string[]>(
  value: unknown,
  values: T,
  field: string,
): T[number] {
  if (typeof value !== "string" || !values.includes(value)) fail("invalid-value", field);
  return value as T[number];
}

function identifier(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9:._-]{0,255}$/u.test(value))
    fail("invalid-value", field);
  return value;
}

function hash(value: unknown, field: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) fail("invalid-value", field);
  return value;
}

function gitObjectId(value: unknown, field: string): string {
  if (typeof value !== "string" || !GIT_OBJECT_ID.test(value)) fail("invalid-value", field);
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail("invalid-value", field);
  return value as number;
}

function timestamp(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    fail("invalid-value", field);
  return value;
}

function fail(code: RoadmapHostOperationRequestErrorCode, field: string): never {
  throw new RoadmapHostOperationRequestError(code, field);
}
