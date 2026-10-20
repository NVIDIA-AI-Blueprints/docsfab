// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { performance } from "node:perf_hooks";
import { types as utilTypes } from "node:util";

import { deepFreeze } from "../contract-kit/freeze.js";
import {
  internalIssueDocumentationMaturityTrackerSnapshot,
  type InternalDocumentationMaturityTrackerSnapshot,
} from "../maturity/tracker-snapshot-authority-internal.js";
import { roadmapCanonicalJson, roadmapDigest } from "./contracts/decode.js";
import { type RoadmapProjectIdentity } from "./contracts/ledger.js";
import { extractManagedIssueMarker, type ManagedIssueMarkerV1 } from "./managed-issue.js";
import {
  observeManagedIssueTrackerV1,
  type ManagedIssueHostProjectionV1,
  type ManagedIssueObservedLinkRelationship,
  type ManagedIssueTrackerObservationV1,
} from "./managed-issue-observer.js";
import { internalIssueManagedIssueObservationCapability } from "./managed-issue-observer-authority-internal.js";
import type { ManagedIssueStateLookupV1 } from "./managed-issue-state.js";
import type { SanitizedRoadmapIssue } from "./planning.js";
import { sha256 } from "../content-ir/canonical.js";
import { dnsHostnamePattern } from "../shared/dns-hostname.js";
import { outboundFetch } from "../model/outbound-http-policy.js";

const SHA = /^[a-f0-9]{64}$/u;
const HOST = dnsHostnamePattern();
const PATH = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+$/u;
const FINGERPRINT_MARKER = /\[docsfab-fingerprint:([a-f0-9]{64})\]/gu;
const MATERIAL_MARKER = /\[docsfab-material:([a-f0-9]{64})\]/gu;
const MAX_MANAGED_LINK_ISSUES = 256;
const hostNow = Date.now.bind(Date);
const hostMonotonicNow = performance.now.bind(performance);
const hostTimeOrigin = performance.timeOrigin;
const ISSUE_FIELDS = [
  "id",
  "iid",
  "project_id",
  "title",
  "description",
  "state",
  "created_at",
  "updated_at",
  "closed_at",
  "closed_by",
  "labels",
  "milestone",
  "assignees",
  "author",
  "type",
  "assignee",
  "user_notes_count",
  "merge_requests_count",
  "upvotes",
  "downvotes",
  "due_date",
  "confidential",
  "discussion_locked",
  "issue_type",
  "web_url",
  "time_stats",
  "task_completion_status",
  "has_tasks",
  "task_status",
  "references",
  "severity",
  "subscribed",
  "service_desk_reply_to",
  "epic",
  "iteration",
  "weight",
] as const;
const MILESTONE_FIELDS = [
  "id",
  "iid",
  "project_id",
  "title",
  "description",
  "state",
  "created_at",
  "updated_at",
  "due_date",
  "start_date",
  "expired",
  "web_url",
] as const;

export interface RoadmapIssueReader {
  observe(project: RoadmapProjectIdentity): Promise<SanitizedRoadmapIssue[]>;
}

export interface GitLabRoadmapReaderOptions {
  /** Strict-decoded, authenticated project identity. */
  project: RoadmapProjectIdentity;
  /** Optional configuration must be the exact canonical project origin. */
  baseUrl?: string;
  token?: string;
  fetch?: typeof globalThis.fetch;
  maxPages?: number;
}

export interface GitLabAutoTrackerSnapshotV1 {
  maturitySource: InternalDocumentationMaturityTrackerSnapshot;
  managed: ManagedIssueTrackerObservationV1;
}

/** GET-only GitLab edge whose credential destination is fixed at construction. */
export class GitLabRoadmapReader implements RoadmapIssueReader {
  private readonly project: RoadmapProjectIdentity;
  private readonly origin: string;
  private readonly token?: string;
  private readonly request: typeof globalThis.fetch;
  private readonly maxPages: number;

  public constructor(options: GitLabRoadmapReaderOptions) {
    this.project = trustedProject(options.project);
    this.origin = `https://${this.project.host}`;
    if (options.baseUrl !== undefined) assertExactOrigin(options.baseUrl, this.origin);
    this.token = options.token;
    this.request = options.fetch ?? outboundFetch();
    this.maxPages = options.maxPages ?? 100;
    if (!Number.isSafeInteger(this.maxPages) || this.maxPages < 1 || this.maxPages > 100) {
      throw new Error("GitLab roadmap reader maxPages must be between 1 and 100.");
    }
  }

  public async observe(projectValue: RoadmapProjectIdentity): Promise<SanitizedRoadmapIssue[]> {
    const project = trustedProject(projectValue);
    if (!sameProject(project, this.project))
      throw new Error(
        "GitLab reader project identity does not match its trusted credential destination.",
      );
    return (await this.readRawIssues())
      .map(sanitizeGitLabIssue)
      .sort((left, right) => left.iid - right.iid)
      .map(deepFreeze);
  }

  /** GET-only, content-minimized marker/label/material/link observation for auto roadmap planning. */
  public async observeManaged(
    projectValue: RoadmapProjectIdentity,
    stateLookup: ManagedIssueStateLookupV1,
  ): Promise<ManagedIssueTrackerObservationV1> {
    const project = trustedProject(projectValue);
    if (!sameProject(project, this.project)) {
      throw new Error(
        "GitLab reader project identity does not match its trusted credential destination.",
      );
    }
    const rawIssues = await this.readRawIssues();
    const projections = rawIssues.map(sanitizeGitLabManagedIssue);
    const linkCandidates = projections.filter(
      (issue) =>
        issue.marker !== null ||
        issue.labels.includes("docsfab-roadmap::managed") ||
        issue.materialEvidenceDigests.length > 0,
    );
    if (linkCandidates.length > MAX_MANAGED_LINK_ISSUES) {
      throw new Error("GitLab managed issue link observation exceeded its bounded issue limit.");
    }
    const withLinks = (
      await Promise.all(
        projections.map(async (issue) =>
          linkCandidates.some((candidate) => candidate.iid === issue.iid)
            ? { ...issue, links: await this.readIssueLinks(issue.iid) }
            : issue,
        ),
      )
    ).sort((left, right) => left.iid - right.iid);
    const observedAt = new Date(hostNow()).toISOString();
    const sourceDigest = roadmapDigest({ project, observedAt, issues: withLinks });
    return observeManagedIssueTrackerV1({
      project,
      observedAt,
      issues: withLinks,
      sourceCapability: internalIssueManagedIssueObservationCapability(sourceDigest),
      stateLookup,
    });
  }

  /**
   * One authenticated issue read shared by the maturity and managed projections.
   * The timestamp is minted at this host edge and cannot be supplied by a caller.
   */
  public async observeAutoSnapshot(
    projectValue: RoadmapProjectIdentity,
    stateLookup: ManagedIssueStateLookupV1,
  ): Promise<GitLabAutoTrackerSnapshotV1> {
    const project = trustedProject(projectValue);
    if (!sameProject(project, this.project)) {
      throw new Error(
        "GitLab reader project identity does not match its trusted credential destination.",
      );
    }
    const rawIssues = await this.readRawIssues();
    const maturityIssues = rawIssues
      .map(sanitizeGitLabIssue)
      .sort((left, right) => left.iid - right.iid)
      .map(deepFreeze);
    const projections = rawIssues.map(sanitizeGitLabManagedIssue);
    const linkCandidates = projections.filter(
      (issue) =>
        issue.marker !== null ||
        issue.labels.includes("docsfab-roadmap::managed") ||
        issue.materialEvidenceDigests.length > 0,
    );
    if (linkCandidates.length > MAX_MANAGED_LINK_ISSUES) {
      throw new Error("GitLab managed issue link observation exceeded its bounded issue limit.");
    }
    const withLinks = (
      await Promise.all(
        projections.map(async (issue) =>
          linkCandidates.some((candidate) => candidate.iid === issue.iid)
            ? { ...issue, links: await this.readIssueLinks(issue.iid) }
            : issue,
        ),
      )
    ).sort((left, right) => left.iid - right.iid);
    const observedAtMonotonicMs = hostMonotonicNow();
    const observedAtEpochMs = hostTimeOrigin + observedAtMonotonicMs;
    if (!Number.isFinite(observedAtEpochMs) || !Number.isFinite(observedAtMonotonicMs)) {
      throw new Error("GitLab tracker observation time is invalid.");
    }
    const observedAt = new Date(observedAtEpochMs).toISOString();
    const sourceDigest = roadmapDigest({ project, observedAt, issues: withLinks });
    return deepFreeze({
      maturitySource: internalIssueDocumentationMaturityTrackerSnapshot({
        project,
        issues: maturityIssues,
        observedAtEpochMs,
        observedAtMonotonicMs,
      }),
      managed: observeManagedIssueTrackerV1({
        project,
        observedAt,
        issues: withLinks,
        sourceCapability: internalIssueManagedIssueObservationCapability(sourceDigest),
        stateLookup,
      }),
    });
  }

  private async readRawIssues(): Promise<unknown[]> {
    const rawResult: unknown[] = [];
    let page = 1;
    while (page <= this.maxPages) {
      const url = new URL(`/api/v4/projects/${this.project.projectId}/issues`, this.origin);
      url.searchParams.set("scope", "all");
      url.searchParams.set("state", "all");
      url.searchParams.set("per_page", "100");
      url.searchParams.set("page", String(page));
      const response = await this.request(url, {
        method: "GET",
        redirect: "error",
        headers: this.token ? { "PRIVATE-TOKEN": this.token } : {},
      });
      if (!response.ok)
        throw new Error(`GitLab read-only issue observation failed (${response.status}).`);
      const raw: unknown = await response.json();
      for (const value of inertArray(raw, "GitLab issue response")) rawResult.push(value);
      const next = response.headers.get("x-next-page");
      if (!next) break;
      if (!/^[1-9][0-9]*$/u.test(next) || Number(next) !== page + 1)
        throw new Error("GitLab issue pagination is invalid.");
      page += 1;
    }
    if (page > this.maxPages)
      throw new Error("GitLab issue observation exceeded the bounded page limit.");
    const sanitized = rawResult.map(sanitizeGitLabIssue);
    if (new Set(sanitized.map((item) => item.iid)).size !== sanitized.length) {
      throw new Error("GitLab issue observation contains duplicate IIDs.");
    }
    return rawResult;
  }

  private async readIssueLinks(iid: number): Promise<ManagedIssueHostProjectionV1["links"]> {
    const url = new URL(
      `/api/v4/projects/${this.project.projectId}/issues/${iid}/links`,
      this.origin,
    );
    url.searchParams.set("per_page", "100");
    const response = await this.request(url, {
      method: "GET",
      redirect: "error",
      headers: this.token ? { "PRIVATE-TOKEN": this.token } : {},
    });
    if (!response.ok)
      throw new Error(`GitLab read-only issue-link observation failed (${response.status}).`);
    if (response.headers.get("x-next-page")) {
      throw new Error("GitLab managed issue link observation exceeded its bounded page limit.");
    }
    const raw: unknown = await response.json();
    return inertArray(raw, "GitLab issue-link response")
      .map(sanitizeGitLabManagedLink)
      .sort(
        (left, right) =>
          left.targetIid - right.targetIid || left.relationship.localeCompare(right.relationship),
      );
  }
}

export function sanitizeGitLabIssue(value: unknown): SanitizedRoadmapIssue {
  const issue = inertObject(value, "GitLab issue metadata", ISSUE_FIELDS);
  const iid = integer(issue.iid, "iid");
  if (issue.state !== "opened" && issue.state !== "closed")
    throw new Error("GitLab issue metadata is invalid.");
  const updatedAt = boundedText(issue.updated_at, 64, "updated_at");
  if (new Date(updatedAt).toISOString() !== updatedAt)
    throw new Error("GitLab issue metadata is invalid.");
  const title = boundedText(issue.title, 4_096, "title");
  const description =
    issue.description === null || issue.description === undefined
      ? ""
      : boundedText(issue.description, 2 * 1024 * 1024, "description");
  const labels = inertArray(issue.labels, "labels").map((item) => boundedText(item, 256, "label"));
  const milestone =
    issue.milestone === null || issue.milestone === undefined
      ? null
      : sanitizeMilestone(issue.milestone);
  const findingFingerprints = markers(description, FINGERPRINT_MARKER);
  const materialEvidenceDigests = markers(description, MATERIAL_MARKER);
  const identityDigest = sha256(
    roadmapCanonicalJson({
      iid,
      state: issue.state,
      updatedAt,
      titleDigest: sha256(title),
      descriptionDigest: sha256(description),
      labelDigests: labels.sort().map(sha256),
      milestoneDigest: sha256(roadmapCanonicalJson(milestone)),
    }),
  );
  return deepFreeze({
    iid,
    state: issue.state,
    updatedAt,
    identityDigest,
    findingFingerprints,
    materialEvidenceDigests,
  });
}

export function sanitizeGitLabManagedIssue(value: unknown): ManagedIssueHostProjectionV1 {
  const issue = inertObject(value, "GitLab issue metadata", ISSUE_FIELDS);
  const iid = integer(issue.iid, "iid");
  if (issue.state !== "opened" && issue.state !== "closed") {
    throw new Error("GitLab issue metadata is invalid.");
  }
  const updatedAt = boundedText(issue.updated_at, 64, "updated_at");
  if (new Date(updatedAt).toISOString() !== updatedAt)
    throw new Error("GitLab issue metadata is invalid.");
  const description =
    issue.description === null || issue.description === undefined
      ? ""
      : boundedText(issue.description, 2 * 1024 * 1024, "description");
  const labels = inertArray(issue.labels, "labels").map((item) => boundedText(item, 128, "label"));
  let marker: ManagedIssueMarkerV1 | null = null;
  if (description.includes("docsfab-managed-issue")) {
    try {
      marker = extractManagedIssueMarker(description) ?? null;
    } catch {
      throw new Error("GitLab managed issue marker is invalid.");
    }
  }
  const base = sanitizeGitLabIssue(value);
  return deepFreeze({
    iid,
    state: issue.state,
    updatedAt,
    identityDigest: base.identityDigest,
    marker,
    labels: [...new Set(labels)].sort(),
    materialEvidenceDigests: markers(description, MATERIAL_MARKER),
    links: [],
  });
}

function sanitizeGitLabManagedLink(value: unknown): {
  targetIid: number;
  relationship: ManagedIssueObservedLinkRelationship;
  identityDigest: string;
} {
  const allowed = [...ISSUE_FIELDS, "link_type"];
  const link = inertObject(value, "GitLab issue-link metadata", allowed);
  const targetIid = integer(link.iid, "link.iid");
  const rawRelationship = boundedText(link.link_type, 64, "link.link_type");
  const relationships: Record<string, ManagedIssueObservedLinkRelationship> = {
    relates_to: "relates-to",
    blocks: "blocks",
    is_blocked_by: "is-blocked-by",
    duplicates: "duplicates",
    is_duplicated_by: "is-duplicated-by",
  };
  const relationship = relationships[rawRelationship];
  if (!relationship) throw new Error("GitLab issue-link relationship is invalid.");
  return deepFreeze({
    targetIid,
    relationship,
    identityDigest: sha256(
      roadmapCanonicalJson({
        targetIid,
        relationship,
        updatedAt: boundedText(link.updated_at, 64, "link.updated_at"),
      }),
    ),
  });
}

function sanitizeMilestone(value: unknown): Record<string, unknown> {
  const milestone = inertObject(value, "GitLab milestone metadata", MILESTONE_FIELDS);
  const result: Record<string, unknown> = {};
  for (const key of MILESTONE_FIELDS) {
    if (!Object.hasOwn(milestone, key)) continue;
    const item = milestone[key];
    if (item === null || typeof item === "boolean" || typeof item === "number") result[key] = item;
    else
      result[key] = boundedText(item, key === "description" ? 65_536 : 4_096, `milestone.${key}`);
  }
  return result;
}

function trustedProject(value: unknown): RoadmapProjectIdentity {
  const project = inertObject(value, "GitLab project identity", [
    "provider",
    "host",
    "fullPath",
    "projectId",
  ]);
  if (
    project.provider !== "gitlab" ||
    typeof project.host !== "string" ||
    !HOST.test(project.host) ||
    typeof project.fullPath !== "string" ||
    !PATH.test(project.fullPath)
  )
    throw new Error("GitLab project identity is invalid.");
  return deepFreeze({
    provider: "gitlab",
    host: project.host,
    fullPath: project.fullPath,
    projectId: integer(project.projectId, "projectId"),
  });
}

function assertExactOrigin(value: string, expected: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("GitLab roadmap reader base URL must match the trusted project origin.");
  }
  if (
    parsed.origin !== expected ||
    parsed.href !== `${expected}/` ||
    parsed.protocol !== "https:" ||
    parsed.port ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname !== "/"
  ) {
    throw new Error("GitLab roadmap reader base URL must match the trusted project origin.");
  }
}

function inertObject(
  value: unknown,
  label: string,
  allowed: readonly string[],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    utilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new Error(`${label} is invalid.`);
  const result: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.includes(key)) throw new Error(`${label} is invalid.`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable)
      throw new Error(`${label} is invalid.`);
    result[key] = descriptor.value;
  }
  return result;
}

function inertArray(value: unknown, label: string): unknown[] {
  if (
    !Array.isArray(value) ||
    utilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  )
    throw new Error(`${label} is not an inert array.`);
  const length = Object.getOwnPropertyDescriptor(value, "length");
  if (
    !length ||
    !Object.hasOwn(length, "value") ||
    !Number.isSafeInteger(length.value) ||
    length.value < 0 ||
    length.value > 10_000
  )
    throw new Error(`${label} is invalid.`);
  const result: unknown[] = [];
  for (let index = 0; index < length.value; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, "value")) throw new Error(`${label} is invalid.`);
    result.push(descriptor.value);
  }
  if (Reflect.ownKeys(value).length !== result.length + 1) throw new Error(`${label} is invalid.`);
  return result;
}

function boundedText(value: unknown, max: number, field: string): string {
  if (
    typeof value !== "string" ||
    value.length > max ||
    value.includes("\0") ||
    value !== value.normalize("NFC")
  )
    throw new Error(`GitLab ${field} is invalid.`);
  return value;
}
function integer(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new Error(`GitLab ${field} is invalid.`);
  return value;
}
function sameProject(left: RoadmapProjectIdentity, right: RoadmapProjectIdentity): boolean {
  return (
    left.provider === right.provider &&
    left.host === right.host &&
    left.fullPath === right.fullPath &&
    left.projectId === right.projectId
  );
}
function markers(value: string, pattern: RegExp): string[] {
  return [
    ...new Set(
      [...value.matchAll(pattern)].map((match) => match[1]!).filter((item) => SHA.test(item)),
    ),
  ].sort();
}
