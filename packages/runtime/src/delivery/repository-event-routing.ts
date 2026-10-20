// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure repository-event delivery selection over host-verified event, grant, MR,
 * and candidate evidence. It does not read webhook payloads, evaluate quality,
 * mint authority, contact an SCM provider, or suppress publisher reconciliation
 * on replay.
 */

export const REPOSITORY_EVENT_ROUTE_REASONS = [
  "requested-artifact-only",
  "endpoint-not-allowed",
  "event-evidence-binding-mismatch",
  "grant-denied",
  "grant-binding-mismatch",
  "grant-insufficient",
  "merge-request-missing",
  "merge-request-ambiguous",
  "merge-request-binding-mismatch",
  "candidate-missing",
  "candidate-ineligible",
  "candidate-binding-mismatch",
  "comment-existing-mr",
  "create-draft-mr",
] as const;

export type RepositoryEventRouteReason = (typeof REPOSITORY_EVENT_ROUTE_REASONS)[number];
export type RepositoryEventRoutableIntent =
  | "artifact-only"
  | "comment-existing-mr"
  | "create-draft-mr";

export interface RepositoryEventRoutingSourceV1 {
  readonly logicalRequestId: string;
  readonly inputManifestSha256: string;
  /** The trusted outcome producer's echo of the exact admitted packet. */
  readonly outcomeInputManifestSha256: string;
  /** Host-produced identity for the complete C..H source manifest. */
  readonly sourceManifestSha256: string;
  readonly host: string;
  readonly projectId: number;
  readonly baseRevision: string;
  readonly headRevision: string;
  readonly requestedIntent: RepositoryEventRoutableIntent;
}

export interface RepositoryEventRoutingTargetV1 {
  readonly repository: string;
  readonly patchDigestSha256: string;
  /** Candidate documentation paths; these are distinct from source C..H paths. */
  readonly allowedPaths: readonly string[];
  readonly defaultBranch: string;
  readonly sourceBranch: string;
  readonly sourceProtected: boolean;
  readonly targetProtected: boolean;
  readonly sourceIsDefault: boolean;
  readonly grantVersion: number;
}

export interface RepositoryEventRoutingGrantV1 {
  readonly decision: "allow" | "deny";
  readonly reason: string;
  readonly host: string | null;
  readonly projectId: number | null;
  readonly grantVersion: number | null;
  readonly tier: "discover" | "observe" | "review" | "contribute" | null;
  readonly status: "active" | "revoked" | "reduced" | null;
  readonly allowedOperations: readonly string[];
}

export interface RepositoryEventMergeRequestV1 {
  readonly iid: number;
  readonly host: string;
  readonly projectId: number;
  readonly headRevision: string;
}

export interface RepositoryEventCandidateRoutingEvidenceV1 {
  readonly disposition: "eligible" | "ineligible";
  readonly sourceManifestSha256: string;
  readonly baseRevision: string;
  readonly headRevision: string;
  readonly patchSha256: string;
  readonly patchPaths: readonly string[];
  readonly candidateTreeObjectId: string;
  readonly targetManifestSha256: string;
  readonly eligibilityReceiptSha256: string;
}

export interface RepositoryEventRoutingInputV1 {
  readonly source: RepositoryEventRoutingSourceV1;
  readonly target: RepositoryEventRoutingTargetV1;
  readonly grant: RepositoryEventRoutingGrantV1;
  readonly mergeRequests: readonly RepositoryEventMergeRequestV1[];
  readonly candidate: RepositoryEventCandidateRoutingEvidenceV1 | null;
}

export type RepositoryEventRouteDecisionV1 =
  | {
      readonly intent: "artifact-only";
      readonly reason: Exclude<
        RepositoryEventRouteReason,
        "comment-existing-mr" | "create-draft-mr"
      >;
      readonly mergeRequestIid: null;
      readonly candidate: null;
    }
  | {
      readonly intent: "comment-existing-mr";
      readonly reason: "comment-existing-mr";
      readonly mergeRequestIid: number;
      readonly candidate: null;
    }
  | {
      readonly intent: "create-draft-mr";
      readonly reason: "create-draft-mr";
      readonly mergeRequestIid: null;
      readonly candidate: RepositoryEventCandidateRoutingEvidenceV1;
    };

export function routeRepositoryEventDelivery(
  input: RepositoryEventRoutingInputV1,
): RepositoryEventRouteDecisionV1 {
  if (
    !(["artifact-only", "comment-existing-mr", "create-draft-mr"] as const).includes(
      input.source.requestedIntent,
    )
  ) {
    throw new TypeError(
      "Repository event routing requires one supported requested delivery intent.",
    );
  }

  if (input.source.requestedIntent === "artifact-only") {
    return artifact("requested-artifact-only");
  }
  if (input.source.inputManifestSha256 !== input.source.outcomeInputManifestSha256) {
    return artifact("event-evidence-binding-mismatch");
  }
  if (input.grant.decision !== "allow" || input.grant.reason !== "allowed") {
    return artifact("grant-denied");
  }
  if (!grantBindingMatches(input)) return artifact("grant-binding-mismatch");

  if (input.source.requestedIntent === "comment-existing-mr") {
    if (
      (input.grant.tier !== "review" && input.grant.tier !== "contribute") ||
      !input.grant.allowedOperations.includes("create-or-update-summary-note")
    ) {
      return artifact("grant-insufficient");
    }
    if (input.mergeRequests.length === 0) return artifact("merge-request-missing");
    if (input.mergeRequests.length !== 1) return artifact("merge-request-ambiguous");
    const mergeRequest = input.mergeRequests[0]!;
    if (
      mergeRequest.host !== input.source.host ||
      mergeRequest.projectId !== input.source.projectId ||
      mergeRequest.headRevision !== input.source.headRevision
    ) {
      return artifact("merge-request-binding-mismatch");
    }
    return Object.freeze({
      intent: "comment-existing-mr" as const,
      reason: "comment-existing-mr" as const,
      mergeRequestIid: positiveInteger(mergeRequest.iid),
      candidate: null,
    });
  }

  if (
    input.grant.tier !== "contribute" ||
    !input.grant.allowedOperations.includes("push-namespaced-unprotected-non-default-branch") ||
    !input.grant.allowedOperations.includes("create-or-reuse-draft-mr")
  ) {
    return artifact("grant-insufficient");
  }
  if (input.candidate === null) return artifact("candidate-missing");
  if (input.candidate.disposition !== "eligible") return artifact("candidate-ineligible");
  if (!candidateBindingMatches(input)) return artifact("candidate-binding-mismatch");
  return Object.freeze({
    intent: "create-draft-mr" as const,
    reason: "create-draft-mr" as const,
    mergeRequestIid: null,
    candidate: normalizeCandidate(input.candidate),
  });
}

function grantBindingMatches(input: RepositoryEventRoutingInputV1): boolean {
  return (
    input.grant.host === input.source.host &&
    input.grant.projectId === input.source.projectId &&
    input.grant.grantVersion === input.target.grantVersion &&
    input.grant.status === "active"
  );
}

function candidateBindingMatches(input: RepositoryEventRoutingInputV1): boolean {
  const candidate = input.candidate!;
  return (
    candidate.sourceManifestSha256 === input.source.sourceManifestSha256 &&
    candidate.baseRevision === input.source.baseRevision &&
    candidate.headRevision === input.source.headRevision &&
    candidate.patchSha256 === input.target.patchDigestSha256 &&
    samePaths(candidate.patchPaths, input.target.allowedPaths) &&
    !input.target.sourceProtected &&
    !input.target.sourceIsDefault &&
    input.target.sourceBranch !== input.target.defaultBranch
  );
}

function normalizeCandidate(
  candidate: RepositoryEventCandidateRoutingEvidenceV1,
): RepositoryEventCandidateRoutingEvidenceV1 {
  return Object.freeze({
    disposition: candidate.disposition,
    sourceManifestSha256: hash(candidate.sourceManifestSha256),
    baseRevision: revision(candidate.baseRevision),
    headRevision: revision(candidate.headRevision),
    patchSha256: hash(candidate.patchSha256),
    patchPaths: paths(candidate.patchPaths),
    candidateTreeObjectId: objectId(candidate.candidateTreeObjectId),
    targetManifestSha256: hash(candidate.targetManifestSha256),
    eligibilityReceiptSha256: hash(candidate.eligibilityReceiptSha256),
  });
}

function samePaths(left: readonly string[], right: readonly string[]): boolean {
  const leftPaths = paths(left);
  const rightPaths = paths(right);
  return (
    leftPaths.length === rightPaths.length &&
    leftPaths.every((value, index) => value === rightPaths[index])
  );
}

function paths(value: readonly string[]): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 512) {
    throw new TypeError("Repository event routing requires a nonempty bounded path list.");
  }
  const normalized = value.map((entry) => {
    if (
      typeof entry !== "string" ||
      entry.length === 0 ||
      entry.length > 512 ||
      entry.startsWith("/") ||
      entry.includes("\\") ||
      entry.split("/").some((part) => part === "" || part === "." || part === "..")
    ) {
      throw new TypeError(
        "Repository event routing requires every supplied path to be repository relative.",
      );
    }
    return entry;
  });
  if (new Set(normalized).size !== normalized.length) {
    throw new TypeError("Repository event routing requires each supplied path to be unique.");
  }
  return Object.freeze(normalized.sort());
}

function hash(value: string): string {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError(
      "Repository event routing requires a lowercase SHA-256 hexadecimal digest.",
    );
  }
  return value;
}

function revision(value: string): string {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value)) {
    throw new TypeError("Repository event routing requires a valid Git object revision value.");
  }
  return value;
}

function objectId(value: string): string {
  return revision(value);
}

function positiveInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError("Repository event routing requires a strictly positive integer value.");
  }
  return value;
}

function artifact(
  reason: Exclude<RepositoryEventRouteReason, "comment-existing-mr" | "create-draft-mr">,
): RepositoryEventRouteDecisionV1 {
  return Object.freeze({
    intent: "artifact-only" as const,
    reason,
    mergeRequestIid: null,
    candidate: null,
  });
}
