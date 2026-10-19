// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { roadmapDigest, roadmapCanonicalJson } from "./contracts/decode.js";
import { type RoadmapProjectIdentity, type RoadmapTrackerObservation } from "./contracts/ledger.js";
import type { RoadmapEffectIdentity, RoadmapMutationOperationV2 } from "./execution-v2.js";
import { compareText } from "../shared/primitives.js";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+/-]{0,127}$/u;
const SAFE_LABEL = /^[^\0-\x1f\x7f,]{1,128}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_BODY_BYTES = 256 * 1024;

export type IssueLifecycleAction =
  | "create-issue"
  | "create-saga"
  | "create-milestone"
  | "update-title"
  | "update-description"
  | "add-labels"
  | "remove-labels"
  | "assign-milestone"
  | "link-related"
  | "link-blocks"
  | "link-parent-task"
  | "comment"
  | "close"
  | "reopen";

interface MaterialBase {
  operationKey: string;
  action: IssueLifecycleAction;
}

export type IssueLifecycleMutationMaterial =
  | (MaterialBase & {
      action: "create-issue" | "create-saga";
      title: string;
      description: string;
      labels: string[];
      milestoneIid?: number;
    })
  | (MaterialBase & {
      action: "create-milestone";
      title: string;
      description: string;
      dueDate?: string;
    })
  | (MaterialBase & { action: "update-title"; title: string })
  | (MaterialBase & { action: "update-description"; description: string })
  | (MaterialBase & { action: "add-labels" | "remove-labels"; labels: string[] })
  | (MaterialBase & { action: "assign-milestone"; milestoneIid: number })
  | (MaterialBase & {
      action: "link-related" | "link-blocks" | "link-parent-task";
    })
  | (MaterialBase & { action: "comment"; body: string })
  | (MaterialBase & { action: "close" | "reopen" });

export interface IssueLifecycleMaterialBundleV1 {
  schemaVersion: 1;
  kind: "docsfab-issue-lifecycle-material-bundle";
  planDigest: string;
  operations: IssueLifecycleMutationMaterial[];
  digest: string;
}

export interface IssueTrackerIdentity {
  provider: string;
  host: string;
  username: string;
  identityDigest: string;
}

/** Exact v2 authorization authority id for the preflighted local operator. */
export function localUserIssueAuthorityId(identity: IssueTrackerIdentity): string {
  requireDigest(identity.identityDigest);
  return `local-user:${identity.identityDigest}`;
}

export interface IssueTrackerProjectState {
  project: RoadmapProjectIdentity;
  accessLevel: number;
  defaultBranch: string;
}

export interface IssueTrackerIssue {
  iid: number;
  titleDigest: string;
  descriptionDigest: string;
  state: "opened" | "closed";
  labels: string[];
  milestoneIid?: number;
  updatedAt: string;
  identityDigest: string;
}

export interface IssueTrackerMilestone {
  iid: number;
  externalId: string;
  titleDigest: string;
  descriptionDigest: string;
  state: "active" | "closed";
  updatedAt: string;
  identityDigest: string;
}

export interface IssueTrackerLink {
  externalId: string;
  subjectIid: number;
  relatedIid: number;
  linkType: "related" | "blocks" | "parent-task";
  updatedAt: string;
  identityDigest: string;
}

export interface IssueTrackerNote {
  externalId: string;
  issueIid: number;
  updatedAt: string;
  identityDigest: string;
}

export type IssueLifecycleReconciliation =
  | { disposition: "absent" }
  | { disposition: "found"; effect: RoadmapEffectIdentity }
  | { disposition: "ambiguous"; failureCode: string };

export interface IssueLifecycleMutationContext {
  project: RoadmapProjectIdentity;
  operation: RoadmapMutationOperationV2;
  material: IssueLifecycleMutationMaterial;
  targetIssue?: IssueTrackerIssue;
  relatedIssue?: IssueTrackerIssue;
  targetMilestone?: IssueTrackerMilestone;
  operationProofDigest?: string;
  operatorIdentityDigest: string;
  expectedAccessLevel: number;
  assertAuthorized(): void;
}

/** Provider-neutral issue tracker boundary. Implementations never expose raw responses. */
export interface IssueLifecycleProviderAdapter {
  readonly provider: string;
  preflight(project: RoadmapProjectIdentity): Promise<{
    identity: IssueTrackerIdentity;
    project: IssueTrackerProjectState;
  }>;
  searchIssues(project: RoadmapProjectIdentity, query: string): Promise<IssueTrackerIssue[]>;
  searchMilestones(
    project: RoadmapProjectIdentity,
    query: string,
  ): Promise<IssueTrackerMilestone[]>;
  getIssue(project: RoadmapProjectIdentity, iid: number): Promise<IssueTrackerIssue | undefined>;
  getMilestone(
    project: RoadmapProjectIdentity,
    iid: number,
  ): Promise<IssueTrackerMilestone | undefined>;
  listLabels(project: RoadmapProjectIdentity): Promise<string[]>;
  listLinks(project: RoadmapProjectIdentity, iid: number): Promise<IssueTrackerLink[]>;
  reconcile(context: IssueLifecycleMutationContext): Promise<IssueLifecycleReconciliation>;
  mutate(context: IssueLifecycleMutationContext): Promise<RoadmapEffectIdentity>;
}

export type IssueLifecycleFailureCode =
  | "authentication-unavailable"
  | "authentication-revoked"
  | "permission-denied"
  | "project-drift"
  | "tracker-drift"
  | "missing-label"
  | "missing-target"
  | "unsupported-operation"
  | "authorization-invalid"
  | "authorization-expired"
  | "material-invalid"
  | "invalid-response"
  | "ambiguous-effect"
  | "external-failure";

export class IssueLifecycleAdapterError extends Error {
  public constructor(
    public readonly code: IssueLifecycleFailureCode,
    public readonly retryable = false,
  ) {
    super(`Issue lifecycle adapter failed (${code}).`);
    this.name = "IssueLifecycleAdapterError";
  }
}

export function issueTrackerObservation(issue: IssueTrackerIssue): RoadmapTrackerObservation {
  return Object.freeze({
    issueIid: issue.iid,
    state: issue.state,
    updatedAt: issue.updatedAt,
    identityDigest: issue.identityDigest,
  });
}

export function issueIdentityDigest(input: Omit<IssueTrackerIssue, "identityDigest">): string {
  return roadmapDigest({
    contract: "issue-tracker-issue-identity-v1",
    iid: input.iid,
    titleDigest: input.titleDigest,
    descriptionDigest: input.descriptionDigest,
    state: input.state,
    labels: [...input.labels].sort(compareText),
    ...(input.milestoneIid === undefined ? {} : { milestoneIid: input.milestoneIid }),
    updatedAt: input.updatedAt,
  });
}

export function milestoneIdentityDigest(
  input: Omit<IssueTrackerMilestone, "identityDigest">,
): string {
  return roadmapDigest({ contract: "issue-tracker-milestone-identity-v1", ...input });
}

export function issueEffectIdentity(
  value: IssueTrackerIssue,
  proof?: string,
): RoadmapEffectIdentity {
  return freeze({
    kind: "issue",
    targetKey: `issue:${value.iid}`,
    externalId: String(value.iid),
    state: value.state,
    updatedAt: value.updatedAt,
    identityDigest: value.identityDigest,
    ...(proof === undefined ? {} : { operationProofDigest: proof }),
  });
}

export function milestoneEffectIdentity(
  value: IssueTrackerMilestone,
  proof?: string,
): RoadmapEffectIdentity {
  return freeze({
    kind: "milestone",
    targetKey: `milestone:${value.iid}`,
    externalId: value.externalId,
    state: value.state,
    updatedAt: value.updatedAt,
    identityDigest: value.identityDigest,
    ...(proof === undefined ? {} : { operationProofDigest: proof }),
  });
}

export function linkIdentityDigest(input: Omit<IssueTrackerLink, "identityDigest">): string {
  return roadmapDigest({ contract: "issue-tracker-link-identity-v1", ...input });
}

export function noteIdentityDigest(input: Omit<IssueTrackerNote, "identityDigest">): string {
  return roadmapDigest({ contract: "issue-tracker-note-identity-v1", ...input });
}

export function mutationMaterialDigest(material: IssueLifecycleMutationMaterial): string {
  return roadmapDigest(validateMutationMaterial(material));
}

export function mutationMaterialBytes(material: IssueLifecycleMutationMaterial): number {
  return Buffer.byteLength(roadmapCanonicalJson(validateMutationMaterial(material)), "utf8");
}

export function createIssueLifecycleMaterialBundle(input: {
  planDigest: string;
  operations: IssueLifecycleMutationMaterial[];
}): IssueLifecycleMaterialBundleV1 {
  requireDigest(input.planDigest);
  const operations = input.operations
    .map(validateMutationMaterial)
    .sort((a, b) => compareText(a.operationKey, b.operationKey));
  unique(operations.map((item) => item.operationKey));
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-issue-lifecycle-material-bundle" as const,
    planDigest: input.planDigest,
    operations,
  };
  return freeze({ ...body, digest: roadmapDigest(body) });
}

export function validateIssueLifecycleMaterialBundle(
  value: unknown,
): IssueLifecycleMaterialBundleV1 {
  inert(value);
  const root = exactObject(value, ["schemaVersion", "kind", "planDigest", "operations", "digest"]);
  if (
    root.schemaVersion !== 1 ||
    root.kind !== "docsfab-issue-lifecycle-material-bundle" ||
    !Array.isArray(root.operations)
  )
    invalidMaterial();
  requireDigest(root.planDigest);
  const result = createIssueLifecycleMaterialBundle({
    planDigest: root.planDigest,
    operations: root.operations as IssueLifecycleMutationMaterial[],
  });
  if (root.digest !== result.digest) invalidMaterial();
  return result;
}

export function validateMutationMaterial(value: unknown): IssueLifecycleMutationMaterial {
  inert(value);
  const base = exactObject(value);
  const operationKey = safeId(base.operationKey);
  if (typeof base.action !== "string") invalidMaterial();
  const action = base.action as IssueLifecycleAction;
  if (["create-issue", "create-saga"].includes(action)) {
    exactKeys(base, ["operationKey", "action", "title", "description", "labels"], ["milestoneIid"]);
    const labels = labelArray(base.labels, true);
    return freeze({
      operationKey,
      action: action as "create-issue" | "create-saga",
      title: safeBody(base.title, 512),
      description: safeBody(base.description, MAX_BODY_BYTES),
      labels,
      ...(base.milestoneIid === undefined
        ? {}
        : { milestoneIid: positiveInteger(base.milestoneIid) }),
    });
  }
  if (action === "create-milestone") {
    exactKeys(base, ["operationKey", "action", "title", "description"], ["dueDate"]);
    const dueDate = base.dueDate === undefined ? undefined : safeDate(base.dueDate);
    return freeze({
      operationKey,
      action,
      title: safeBody(base.title, 512),
      description: safeBody(base.description, MAX_BODY_BYTES),
      ...(dueDate ? { dueDate } : {}),
    });
  }
  if (action === "update-title") {
    exactKeys(base, ["operationKey", "action", "title"]);
    return freeze({ operationKey, action, title: safeBody(base.title, 512) });
  }
  if (action === "update-description") {
    exactKeys(base, ["operationKey", "action", "description"]);
    return freeze({
      operationKey,
      action,
      description: safeBody(base.description, MAX_BODY_BYTES),
    });
  }
  if (action === "comment") {
    exactKeys(base, ["operationKey", "action", "body"]);
    return freeze({ operationKey, action, body: safeBody(base.body, MAX_BODY_BYTES) });
  }
  if (action === "add-labels" || action === "remove-labels") {
    exactKeys(base, ["operationKey", "action", "labels"]);
    return freeze({ operationKey, action, labels: labelArray(base.labels) });
  }
  if (action === "assign-milestone") {
    exactKeys(base, ["operationKey", "action", "milestoneIid"]);
    return freeze({ operationKey, action, milestoneIid: positiveInteger(base.milestoneIid) });
  }
  if (["link-related", "link-blocks", "link-parent-task", "close", "reopen"].includes(action)) {
    exactKeys(base, ["operationKey", "action"]);
    return freeze({ operationKey, action } as IssueLifecycleMutationMaterial);
  }
  invalidMaterial();
}

export function expectedMaterialAction(
  operation: RoadmapMutationOperationV2,
): readonly IssueLifecycleAction[] {
  if (operation.kind === "saga") return ["create-saga"];
  if (operation.kind === "issue") return ["create-issue"];
  if (operation.kind === "milestone") return ["create-milestone"];
  if (operation.kind === "comment") return ["comment"];
  if (operation.kind === "closure")
    return operation.proposal.intent === "close" ? ["close"] : ["reopen"];
  if (operation.kind === "label") return ["add-labels", "remove-labels"];
  if (operation.kind === "link") return ["link-related", "link-blocks", "link-parent-task"];
  if (operation.kind === "update" && operation.proposal.intent === "assign-milestone")
    return ["assign-milestone"];
  if (operation.kind === "update") return ["update-title", "update-description"];
  return [];
}

export function assertMaterialForOperation(
  operation: RoadmapMutationOperationV2,
  material: IssueLifecycleMutationMaterial,
): void {
  if (
    operation.key !== material.operationKey ||
    !expectedMaterialAction(operation).includes(material.action) ||
    mutationMaterialDigest(material) !== operation.materialDigest ||
    mutationMaterialBytes(material) !== operation.materialBytes
  )
    invalidMaterial();
}

export function sanitizeFailureCode(error: unknown): IssueLifecycleFailureCode {
  return error instanceof IssueLifecycleAdapterError ? error.code : "external-failure";
}

function labelArray(value: unknown, allowEmpty = false): string[] {
  if (
    !Array.isArray(value) ||
    (!allowEmpty && value.length < 1) ||
    value.length > 32 ||
    value.some((item) => typeof item !== "string" || !SAFE_LABEL.test(item))
  )
    invalidMaterial();
  const labels = [...value].map(String).sort(compareText);
  unique(labels);
  return labels;
}

function safeBody(value: unknown, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    Buffer.byteLength(value, "utf8") > maximum ||
    /\0/u.test(value)
  )
    invalidMaterial();
  return value.replace(/\r\n?/gu, "\n");
}

function safeDate(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(value) ||
    Number.isNaN(Date.parse(`${value}T00:00:00.000Z`)) ||
    new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value
  )
    invalidMaterial();
  return value;
}

function positiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) invalidMaterial();
  return Number(value);
}

function safeId(value: unknown): string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) invalidMaterial();
  return value;
}

function requireDigest(value: unknown): asserts value is string {
  if (typeof value !== "string" || !SHA256.test(value)) invalidMaterial();
}

function exactObject(value: unknown, keys?: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    invalidMaterial();
  if (keys) exactKeys(value as Record<string, unknown>, keys);
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  )
    invalidMaterial();
}

function unique(values: readonly string[]): void {
  if (new Set(values).size !== values.length) invalidMaterial();
}

function inert(value: unknown): void {
  const active = new WeakSet<object>();
  let nodes = 0;
  const visit = (item: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > 100_000 || depth > 24) invalidMaterial();
    if (item === null || ["string", "number", "boolean"].includes(typeof item)) return;
    if (typeof item !== "object" || active.has(item)) invalidMaterial();
    active.add(item);
    try {
      if (Object.getOwnPropertySymbols(item).length > 0) invalidMaterial();
      const descriptors = Object.getOwnPropertyDescriptors(item);
      if (Array.isArray(item)) {
        if (Object.getPrototypeOf(item) !== Array.prototype) invalidMaterial();
        const length = descriptors.length;
        if (
          !length ||
          !Object.hasOwn(length, "value") ||
          !Number.isSafeInteger(length.value) ||
          (length.value as number) > 100_000
        )
          invalidMaterial();
        const expected = new Set([
          "length",
          ...Array.from({ length: length.value as number }, (_unused, index) => String(index)),
        ]);
        if (
          Object.keys(descriptors).some((key) => !expected.has(key)) ||
          Object.keys(descriptors).length !== expected.size
        )
          invalidMaterial();
      } else if (Object.getPrototypeOf(item) !== Object.prototype) invalidMaterial();
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (key === "length" && Array.isArray(item)) continue;
        if (!Object.hasOwn(descriptor, "value") || !descriptor.enumerable) invalidMaterial();
        visit(descriptor.value, depth + 1);
      }
    } finally {
      active.delete(item);
    }
  };
  visit(value, 0);
}

function invalidMaterial(): never {
  throw new IssueLifecycleAdapterError("material-invalid");
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
  }
  return value;
}
