// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { types as nodeUtilTypes } from "node:util";

import { screenCredentialValue } from "../security/credential-shape-findings.js";
import { detectCredentialRuleIdsInValue } from "../security/repository-scanner.js";
import { roadmapCanonicalJson, roadmapDigest } from "./contracts/decode.js";
import { type RoadmapProjectIdentity, type RoadmapTrackerObservation } from "./contracts/ledger.js";
import {
  renderManagedIssueMarker,
  validateManagedIssueMarker,
  type ManagedIssueMarkerV1,
  type ManagedIssueObservation,
} from "./managed-issue.js";
import {
  internalManagedIssueObservationSourceDigest,
  type InternalManagedIssueObservationCapability,
} from "./managed-issue-observer-authority-internal.js";
import {
  managedIssueStateBindingFromLookup,
  type ManagedIssueStateLookupV1,
} from "./managed-issue-state.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_LABEL = /^[^\u0000-\u001f\u007f,]{1,128}$/u;
const MAX_ISSUES = 10_000;
const MAX_LABELS = 128;
const MAX_LINKS = 256;

export type ManagedIssueObservedLinkRelationship =
  | "blocks"
  | "is-blocked-by"
  | "relates-to"
  | "duplicates"
  | "is-duplicated-by";

/** Content-minimized host projection; no title, prose, credential, or raw response. */
export interface ManagedIssueHostProjectionV1 {
  iid: number;
  state: "opened" | "closed";
  updatedAt: string;
  identityDigest: string;
  marker: ManagedIssueMarkerV1 | null;
  labels: string[];
  materialEvidenceDigests: string[];
  links: Array<{
    targetIid: number;
    relationship: ManagedIssueObservedLinkRelationship;
    identityDigest: string;
  }>;
}

export interface ManagedIssueTrackerObservationV1 {
  kind: "docsfab-managed-issue-tracker-observation";
  schemaVersion: 1;
  readOnly: true;
  project: RoadmapProjectIdentity;
  observedAt: string;
  issues: ManagedIssueHostProjectionV1[];
  digest: string;
}

interface AuthenticObservationState {
  reconcilerIssues: readonly ManagedIssueObservation[];
  tracker: readonly RoadmapTrackerObservation[];
}

const authenticObservations = new WeakMap<object, AuthenticObservationState>();

export class ManagedIssueObserverError extends Error {
  public constructor(public readonly code: "invalid-source" | "invalid-observation") {
    super(`Managed issue observation failed: ${code}.`);
    this.name = "ManagedIssueObserverError";
  }
}

/**
 * Convert a host-authenticated, content-minimized tracker snapshot into the
 * exact public observation and private reconciliation view used by auto mode.
 */
export function observeManagedIssueTrackerV1(inputValue: {
  project: RoadmapProjectIdentity;
  observedAt: string;
  issues: ManagedIssueHostProjectionV1[];
  sourceCapability: InternalManagedIssueObservationCapability;
  stateLookup: ManagedIssueStateLookupV1;
}): ManagedIssueTrackerObservationV1 {
  const input = inertRecord(inputValue, [
    "project",
    "observedAt",
    "issues",
    "sourceCapability",
    "stateLookup",
  ]);
  const project = projectIdentity(input.project);
  const observedAt = timestamp(input.observedAt);
  const issues = inertArray(input.issues, MAX_ISSUES)
    .map((value) => hostIssue(value))
    .sort((left, right) => left.iid - right.iid);
  if (new Set(issues.map((issue) => issue.iid)).size !== issues.length) invalid();
  // DocsFab's own configured credential refuses; issue text that only looks
  // like a credential is recorded per issue and observed (#1807).
  for (const issue of issues) {
    if (
      screenCredentialValue(issue, `managed-issue:${issue.iid}`, detectCredentialRuleIdsInValue) !==
      null
    )
      invalid();
  }
  const sourceDigest = roadmapDigest({ project, observedAt, issues });
  if (
    internalManagedIssueObservationSourceDigest(
      input.sourceCapability as InternalManagedIssueObservationCapability,
    ) !== sourceDigest
  )
    throw new ManagedIssueObserverError("invalid-source");
  const stateLookup = input.stateLookup as ManagedIssueStateLookupV1;
  const reconcilerIssues = issues.map(
    (issue): ManagedIssueObservation => ({
      iid: issue.iid,
      state: issue.state,
      title: issue.marker ? "Managed issue" : "Human-owned issue",
      description: issue.marker ? renderManagedIssueMarker(issue.marker) : "",
      labels: [...issue.labels],
      ...(managedIssueStateBindingFromLookup(stateLookup, issue.iid) === undefined
        ? {}
        : {
            stateBinding: managedIssueStateBindingFromLookup(stateLookup, issue.iid),
          }),
    }),
  );
  const body = {
    kind: "docsfab-managed-issue-tracker-observation" as const,
    schemaVersion: 1 as const,
    readOnly: true as const,
    project,
    observedAt,
    issues,
  };
  const observation = freeze({ ...body, digest: roadmapDigest(body) });
  authenticObservations.set(observation, {
    reconcilerIssues: freeze(reconcilerIssues),
    tracker: freeze(
      issues.map((issue) => ({
        issueIid: issue.iid,
        state: issue.state,
        updatedAt: issue.updatedAt,
        identityDigest: issue.identityDigest,
      })),
    ),
  });
  return observation;
}

/** A serialized/rehashed observation has no host authority. */
export function managedIssueTrackerObservationStateV1(
  observation: ManagedIssueTrackerObservationV1,
): {
  reconcilerIssues: readonly ManagedIssueObservation[];
  tracker: readonly RoadmapTrackerObservation[];
} {
  const state =
    observation && typeof observation === "object"
      ? authenticObservations.get(observation)
      : undefined;
  if (!state || roadmapDigest(observation) !== observation.digest) {
    throw new ManagedIssueObserverError("invalid-observation");
  }
  return state;
}

function hostIssue(value: unknown): ManagedIssueHostProjectionV1 {
  const item = inertRecord(value, [
    "iid",
    "state",
    "updatedAt",
    "identityDigest",
    "marker",
    "labels",
    "materialEvidenceDigests",
    "links",
  ]);
  const iid = positiveInteger(item.iid);
  const marker = item.marker === null ? null : validateManagedIssueMarker(item.marker);
  const labels = stringArray(item.labels, MAX_LABELS, false, SAFE_LABEL);
  const materialEvidenceDigests = stringArray(
    item.materialEvidenceDigests,
    MAX_LABELS,
    true,
    SHA256,
  );
  const links = inertArray(item.links, MAX_LINKS)
    .map((linkValue) => {
      const link = inertRecord(linkValue, ["targetIid", "relationship", "identityDigest"]);
      const relationship = link.relationship;
      if (
        !["blocks", "is-blocked-by", "relates-to", "duplicates", "is-duplicated-by"].includes(
          relationship as string,
        )
      )
        invalid();
      return {
        targetIid: positiveInteger(link.targetIid),
        relationship: relationship as ManagedIssueObservedLinkRelationship,
        identityDigest: sha256(link.identityDigest),
      };
    })
    .sort(
      (left, right) =>
        left.targetIid - right.targetIid || left.relationship.localeCompare(right.relationship),
    );
  if (
    links.some((link) => link.targetIid === iid) ||
    new Set(links.map((link) => `${link.targetIid}:${link.relationship}`)).size !== links.length
  )
    invalid();
  return freeze({
    iid,
    state: choice(item.state, ["opened", "closed"] as const),
    updatedAt: timestamp(item.updatedAt),
    identityDigest: sha256(item.identityDigest),
    marker,
    labels,
    materialEvidenceDigests,
    links,
  });
}

function projectIdentity(value: unknown): RoadmapProjectIdentity {
  const item = inertRecord(value, ["provider", "host", "fullPath", "projectId"]);
  if (
    typeof item.provider !== "string" ||
    typeof item.host !== "string" ||
    typeof item.fullPath !== "string" ||
    item.provider.length === 0 ||
    item.host.length === 0 ||
    item.fullPath.length === 0 ||
    /[\u0000-\u001f\u007f]/u.test(`${item.provider}${item.host}${item.fullPath}`)
  )
    invalid();
  return freeze({
    provider: item.provider,
    host: item.host,
    fullPath: item.fullPath,
    projectId: positiveInteger(item.projectId),
  });
}

function inertRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    nodeUtilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    invalid();
  const result: Record<string, unknown> = {};
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length) invalid();
  for (const key of ownKeys) {
    if (typeof key !== "string" || !keys.includes(key)) invalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) invalid();
    result[key] = descriptor.value;
  }
  return result;
}

function inertArray(value: unknown, maximum: number): unknown[] {
  if (
    !Array.isArray(value) ||
    nodeUtilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximum
  )
    invalid();
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, "value")) invalid();
    result.push(descriptor.value);
  }
  if (Reflect.ownKeys(value).length !== result.length + 1) invalid();
  return result;
}

function stringArray(value: unknown, maximum: number, digest: boolean, pattern: RegExp): string[] {
  const result = inertArray(value, maximum)
    .map((item) => {
      if (typeof item !== "string" || !pattern.test(item) || (digest && !SHA256.test(item)))
        invalid();
      return item as string;
    })
    .sort();
  if (new Set(result).size !== result.length) invalid();
  return result;
}

function timestamp(value: unknown): string {
  if (typeof value !== "string") invalid();
  try {
    if (new Date(value).toISOString() !== value) invalid();
  } catch {
    invalid();
  }
  return value as string;
}

function positiveInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) invalid();
  return value as number;
}

function sha256(value: unknown): string {
  if (typeof value !== "string" || !SHA256.test(value)) invalid();
  return value as string;
}

function choice<T extends string>(value: unknown, choices: readonly T[]): T {
  if (!choices.includes(value as T)) invalid();
  return value as T;
}

function invalid(): never {
  throw new ManagedIssueObserverError("invalid-observation");
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
