// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Merged GitLab MR acquisition producer, the same shape as
 * `acquireTrackedSourceBinding`: every byte comes from one injected
 * `GitLabMrSourceReaderV1`, and identity is pure over the fetched projection.
 *
 * There is no partial binding: if one named merge request cannot be bound, the
 * whole acquisition refuses. Merge requests registered before the refusal stay
 * in the external-input ledger, as in the tracked producer, so retrying on the
 * same capability refuses with `duplicate-input`. The CLI path discards its
 * capability on failure; a caller sharing one registry across retries does not.
 *
 * Locators are keyed on the numeric project id, never the path, so two projects
 * sharing a path cannot collide. GitLab-reported failures use the shared
 * `GITLAB_READ_FAILURES` messages; selection refusals carry no upstream text.
 */

import { canonicalDigest } from "../content-ir/canonical.js";
import { registerTrackedRepositorySourceInput } from "./access.js";
import type { ExternalInputHostCapability } from "./contracts.js";
import {
  canonicalGitlabMrReviewLocator,
  digestGitlabMrReviewLocator,
} from "./gitlab-mr-locator.js";
import {
  failGitLabSourceProvider,
  GITLAB_READ_TEXT_LIMIT,
  GITLAB_SOURCE_PROVIDER_ID,
  assertGitLabAcquisitionScope,
  type GitLabAcquisitionScopeV1,
  type GitLabMrProjectionV1,
  type GitLabMrSourceReaderV1,
} from "./gitlab-source-provider.js";
import {
  GITLAB_MERGED_MR_DIFF_MEDIA_TYPE,
  gitlabMergedMrDiffExtractorAdapter,
} from "./merged-mr-evidence.js";
import type { MergedMrEvidenceGapV1 } from "./merged-mr-selection.js";
import { normalizeSourceReadScope } from "./source-acquisition.js";

import {
  createSourceBinding,
  createSourceObservation,
  digestSourceProducerScopes,
  type SourceBindingV1,
  type SourceObservationV1,
  type SourceRepositoryBindingV1,
  type SourceRepresentationV1,
} from "./source-evidence.js";
import { extractSourceRepresentation, sha256Bytes } from "./source-extraction.js";
import { assertConfinedToolResultCredentialFree } from "../security/credential-isolation.js";

/** Same identity as discovery, so a run presents one producer scope row for both. */
export const GITLAB_MR_SOURCE_PRODUCER_ID = GITLAB_SOURCE_PROVIDER_ID;
export const GITLAB_MR_SOURCE_PRODUCER_VERSION = "1" as const;

/** Extends the shared `MergedMrEvidenceGapV1` vocabulary with merge-request body gaps. */
export type GitLabMrEvidenceGapV1 =
  | MergedMrEvidenceGapV1
  | "truncated-merge-request-text"
  | "missing-merge-request-text";

/** Source of truth for refusal codes; the message table must cover each one. */
export const GITLAB_SOURCE_ACQUISITION_REFUSAL_CODES = [
  "empty-selection",
  "invalid-merge-request",
  "duplicate-merge-request",
  "merge-request-unavailable",
] as const;

export type GitLabSourceAcquisitionRefusalCode =
  (typeof GITLAB_SOURCE_ACQUISITION_REFUSAL_CODES)[number];

/**
 * Operator text for each refusal: the condition, then the fix. No entry
 * interpolates untrusted values; only the merge-request number is appended.
 */
export const GITLAB_SOURCE_ACQUISITION_REFUSALS: Readonly<
  Record<GitLabSourceAcquisitionRefusalCode, string>
> = Object.freeze({
  "empty-selection":
    "GitLab source acquisition was given no merge requests to bind. Name at least one merged merge request, or run without a merge-request basis at all.",
  "invalid-merge-request":
    "GitLab source acquisition refused a merge-request number that is not a positive whole number. Use the project-local number GitLab shows after the exclamation mark, such as 804.",
  "duplicate-merge-request":
    "GitLab source acquisition refused a merge-request number that was named more than once. Remove the repeat, or replace it with the other merge request you meant to bind.",
  "merge-request-unavailable":
    "GitLab source acquisition could not find one of the named merge requests in the selected project. Check the number, confirm it is merged in this project, then run again.",
});

export function gitlabSourceAcquisitionRefusalMessage(
  code: GitLabSourceAcquisitionRefusalCode,
  mergeRequestIid?: number,
): string {
  const named =
    mergeRequestIid === undefined ? "" : ` The merge request named was !${mergeRequestIid}.`;
  return `${GITLAB_SOURCE_ACQUISITION_REFUSALS[code]}${named}`;
}

export class GitLabSourceAcquisitionError extends Error {
  public constructor(
    public readonly code: GitLabSourceAcquisitionRefusalCode,
    public readonly mergeRequestIid?: number,
  ) {
    super(gitlabSourceAcquisitionRefusalMessage(code, mergeRequestIid));
    this.name = "GitLabSourceAcquisitionError";
  }
}

function refuse(code: GitLabSourceAcquisitionRefusalCode, mergeRequestIid?: number): never {
  throw new GitLabSourceAcquisitionError(code, mergeRequestIid);
}

/**
 * Normalize the operator's merge-request selection into ascending order.
 *
 * A duplicate is refused rather than collapsed, because it usually means the
 * operator meant a different merge request that is now missing.
 */
export function normalizeGitLabMrSelection(selection: readonly number[]): readonly number[] {
  if (!Array.isArray(selection) || selection.length === 0) refuse("empty-selection");
  const seen = new Set<number>();
  for (const entry of selection) {
    if (typeof entry !== "number" || !Number.isSafeInteger(entry) || entry <= 0) {
      refuse("invalid-merge-request");
    }
    if (seen.has(entry)) refuse("duplicate-merge-request", entry);
    seen.add(entry);
  }
  return Object.freeze([...seen].sort((left, right) => left - right));
}

/**
 * Digest the producer scope: project scope, host-granted read scope, and the
 * named merge requests. Widening any of them changes the binding.
 */
export function digestGitLabMrProducerScope(input: {
  readonly scope: GitLabAcquisitionScopeV1;
  readonly repository: SourceRepositoryBindingV1;
  readonly readScope: readonly string[];
  readonly mergeRequestIids: readonly number[];
}): string {
  return canonicalDigest({
    schemaVersion: 1 as const,
    kind: "docsfab-gitlab-mr-source-read-scope" as const,
    producerId: GITLAB_MR_SOURCE_PRODUCER_ID,
    producerVersion: GITLAB_MR_SOURCE_PRODUCER_VERSION,
    repositoryIdentitySha256: input.repository.identitySha256,
    host: input.scope.host,
    projectId: input.scope.projectId,
    projectPath: input.scope.projectPath,
    readScope: [...normalizeSourceReadScope(input.readScope)],
    mergeRequestIids: [...input.mergeRequestIids].sort((left, right) => left - right),
  });
}

/** Revision-independent identity for one merge request as a source origin. */
export function computeGitLabMrOriginId(input: {
  readonly repository: SourceRepositoryBindingV1;
  readonly canonicalLocator: string;
}): string {
  return canonicalDigest({
    schemaVersion: 1 as const,
    kind: "docsfab-gitlab-mr-source-origin" as const,
    repositoryIdentitySha256: input.repository.identitySha256,
    canonicalLocator: input.canonicalLocator,
  });
}

/** Content-free receipt for one merge-request acquisition. */
export function computeGitLabMrAcquisitionReceiptSha256(input: {
  readonly canonicalLocator: string;
  readonly originalSha256: string;
  readonly byteLength: number;
  readonly readScopeSha256: string;
  readonly representationSha256: string;
  readonly observedAt: string;
}): string {
  return canonicalDigest({
    schemaVersion: 1 as const,
    kind: "docsfab-gitlab-mr-source-acquisition-receipt" as const,
    producerId: GITLAB_MR_SOURCE_PRODUCER_ID,
    producerVersion: GITLAB_MR_SOURCE_PRODUCER_VERSION,
    canonicalLocator: input.canonicalLocator,
    originalSha256: input.originalSha256,
    byteLength: input.byteLength,
    readScopeSha256: input.readScopeSha256,
    representationSha256: input.representationSha256,
    observedAt: input.observedAt,
  });
}

export function gitlabMrSourceRepositoryPath(mergeRequestIid: number): string {
  return `gitlab-merge-request/${mergeRequestIid}.txt`;
}

/**
 * Render the immutable evidence body for one merge request.
 *
 * Identity and declared gaps come before the untrusted body, so a reader can
 * tell which merge request the text belongs to without trusting the text.
 */
export function renderGitLabMrSourceOriginal(input: {
  readonly projection: GitLabMrProjectionV1;
  readonly canonicalLocator: string;
  readonly evidenceGaps: readonly GitLabMrEvidenceGapV1[];
}): Uint8Array {
  const { projection } = input;
  const description = projection.description ?? "";
  const lines = [
    `# GitLab merge request !${projection.iid}`,
    `# locator: ${input.canonicalLocator}`,
    `# state: ${projection.state ?? "unknown"}`,
    `# merged_at: ${projection.mergedAt ?? "none"}`,
    `# target_branch: ${projection.targetBranch ?? "none"}`,
    `# source_branch: ${projection.sourceBranch ?? "none"}`,
    `# merge_commit_sha: ${projection.mergeCommitSha ?? "none"}`,
    `# squash_commit_sha: ${projection.squashCommitSha ?? "none"}`,
    ...(input.evidenceGaps.length > 0
      ? [`# evidence_gaps: ${[...input.evidenceGaps].join(",")}`]
      : []),
    "",
    `# title`,
    projection.title ?? "(no title)",
    "",
    `# description`,
    description.length === 0
      ? "(no merge-request body was retained)"
      : description.length > GITLAB_READ_TEXT_LIMIT
        ? description.slice(0, GITLAB_READ_TEXT_LIMIT)
        : description,
    "",
  ];
  return new TextEncoder().encode(`${lines.join("\n")}\n`);
}

export interface AcquiredGitLabMrSourceV1 {
  readonly observation: SourceObservationV1;
  readonly representation: SourceRepresentationV1;
  /** The retained derivative bytes the reader will later serve. */
  readonly derivative: Uint8Array;
  readonly repositoryPath: string;
  readonly mergeRequestIid: number;
  /** Keyed on the numeric project id. */
  readonly locator: string;
  readonly evidenceGaps: readonly GitLabMrEvidenceGapV1[];
}

export interface AcquiredGitLabMrSourceBindingV1 {
  readonly binding: SourceBindingV1;
  readonly acquired: readonly AcquiredGitLabMrSourceV1[];
  readonly producerScopes: ReadonlyArray<{ producerId: string; scopeSha256: string }>;
  readonly scope: GitLabAcquisitionScopeV1;
  readonly readScope: readonly string[];
}

export interface AcquireGitLabMrSourceBindingInput {
  /**
   * The only I/O seam; the rest of this module does no I/O, but registration
   * mutates `externalInputs`.
   */
  readonly reader: GitLabMrSourceReaderV1;
  readonly externalInputs: ExternalInputHostCapability;
  /**
   * Proved by `resolveGitLabAcquisitionScope`; this producer cannot check the
   * id/path pair itself without a second GitLab read path.
   */
  readonly scope: GitLabAcquisitionScopeV1;
  readonly selection: readonly number[];
  readonly readScope: readonly string[];
  readonly runIdSha256: string;
  readonly repository: SourceRepositoryBindingV1;
  readonly requestSha256: string;
  readonly hostPolicySha256: string;
  readonly observedAt: string;
}

/**
 * Acquire the selected merged merge requests and mint the run's source binding.
 *
 * Scope and selection are validated before any read. Per merge request, a row
 * that is not merged is refused before its text is rendered or screened.
 */
export async function acquireGitLabMrSourceBinding(
  input: AcquireGitLabMrSourceBindingInput,
): Promise<AcquiredGitLabMrSourceBindingV1> {
  const scope = assertGitLabAcquisitionScope(input.scope);
  const readScope = normalizeSourceReadScope(input.readScope);
  const selection = normalizeGitLabMrSelection(input.selection);
  const readScopeSha256 = digestGitLabMrProducerScope({
    scope,
    repository: input.repository,
    readScope,
    mergeRequestIids: selection,
  });

  const acquired: AcquiredGitLabMrSourceV1[] = [];
  for (const mergeRequestIid of selection) {
    const locator = canonicalGitlabMrReviewLocator({
      host: scope.host,
      projectId: scope.projectId,
      mergeRequestIid,
    });
    const projection = await input.reader.readMergeRequest(mergeRequestIid);
    if (projection === undefined) refuse("merge-request-unavailable", mergeRequestIid);
    if (projection.iid !== mergeRequestIid) failGitLabSourceProvider("response");
    // A `get` read returns any state; an open merge request is not immutable evidence.
    if (projection.state !== "merged") failGitLabSourceProvider("response");
    if (
      typeof projection.mergedAt !== "string" ||
      !Number.isFinite(Date.parse(projection.mergedAt))
    ) {
      failGitLabSourceProvider("response");
    }

    const gaps: GitLabMrEvidenceGapV1[] = [];
    if (projection.mergeCommitSha === null && projection.squashCommitSha === null) {
      gaps.push("missing-commit-identity");
    }
    // Shipped readers clip before this point, so only their flag detects a
    // clip; the length test covers a reader that hands over unclipped text.
    if (
      projection.textTruncated === true ||
      (projection.description ?? "").length > GITLAB_READ_TEXT_LIMIT
    ) {
      gaps.push("truncated-merge-request-text");
    }
    // Without this gap an absent body would seal as complete evidence. An empty
    // body records it too: the gap means no text was retained.
    if (projection.description === null || projection.description.length === 0) {
      gaps.push("missing-merge-request-text");
    }
    const evidenceGaps: readonly GitLabMrEvidenceGapV1[] = Object.freeze([...gaps]);
    const bytes = renderGitLabMrSourceOriginal({
      projection,
      canonicalLocator: locator,
      evidenceGaps,
    });
    // Last credential screen before the text becomes an observation a model can
    // read. It runs for every reader, since readers other than the confined tool
    // might not screen.
    try {
      assertConfinedToolResultCredentialFree({
        text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      });
    } catch {
      failGitLabSourceProvider("credentials");
    }

    const extracted = await extractSourceRepresentation({
      adapter: gitlabMergedMrDiffExtractorAdapter,
      bytes,
      mediaType: GITLAB_MERGED_MR_DIFF_MEDIA_TYPE,
    });
    const originIdSha256 = computeGitLabMrOriginId({
      repository: input.repository,
      canonicalLocator: locator,
    });
    const observationId = `obs-${canonicalDigest({
      schemaVersion: 1 as const,
      kind: "docsfab-source-observation-id" as const,
      originIdSha256,
      revision: input.repository.revision,
      originalSha256: extracted.originalSha256,
      representationSha256: extracted.representation.representationSha256,
    })}`;
    const inputId = `input-${canonicalDigest({
      schemaVersion: 1 as const,
      kind: "docsfab-source-input-id" as const,
      observationId,
    })}`;
    const repositoryPath = gitlabMrSourceRepositoryPath(mergeRequestIid);
    const { entrySha256 } = registerTrackedRepositorySourceInput(input.externalInputs, {
      inputId,
      canonicalLocator: locator,
      safeTitle: `GitLab merge request !${mergeRequestIid}`,
      contentDigestSha256: sha256Bytes(extracted.derivative),
      revision: input.repository.revision,
      producerId: GITLAB_MR_SOURCE_PRODUCER_ID,
      producerVersion: GITLAB_MR_SOURCE_PRODUCER_VERSION,
    });
    const observation = createSourceObservation({
      observationId,
      originIdSha256,
      inputId,
      registrationSha256: entrySha256,
      runIdSha256: input.runIdSha256,
      repository: input.repository,
      requestSha256: input.requestSha256,
      producerId: GITLAB_MR_SOURCE_PRODUCER_ID,
      producerVersion: GITLAB_MR_SOURCE_PRODUCER_VERSION,
      producerScopeSha256: readScopeSha256,
      acquisitionReceiptSha256: computeGitLabMrAcquisitionReceiptSha256({
        canonicalLocator: locator,
        originalSha256: extracted.originalSha256,
        byteLength: bytes.byteLength,
        readScopeSha256,
        representationSha256: extracted.representation.representationSha256,
        observedAt: input.observedAt,
      }),
      observedAt: input.observedAt,
      original: {
        sha256: extracted.originalSha256,
        byteLength: bytes.byteLength,
        mediaType: GITLAB_MERGED_MR_DIFF_MEDIA_TYPE,
        locatorSha256: digestGitlabMrReviewLocator({
          host: scope.host,
          projectId: scope.projectId,
          mergeRequestIid,
        }),
        // Identified by its own bytes, not by the checkout revision.
        version: { kind: "content-digest", contentDigestSha256: extracted.originalSha256 },
        repositoryPath,
      },
      representations: [extracted.representation],
    });
    acquired.push({
      observation,
      representation: extracted.representation,
      derivative: extracted.derivative,
      repositoryPath,
      mergeRequestIid,
      locator,
      evidenceGaps,
    });
  }

  const producerScopes = Object.freeze([
    { producerId: GITLAB_MR_SOURCE_PRODUCER_ID, scopeSha256: readScopeSha256 },
  ]);
  const binding = createSourceBinding({
    runIdSha256: input.runIdSha256,
    repository: input.repository,
    requestSha256: input.requestSha256,
    hostPolicySha256: input.hostPolicySha256,
    producerScopeSha256: digestSourceProducerScopes(producerScopes),
    parentBindingSha256: null,
    observations: acquired.map((entry) => ({
      observationId: entry.observation.observationId,
      observationSha256: entry.observation.observationSha256,
    })),
    // A run that never read a named merge request may not write.
    requiredObservationIds: acquired.map((entry) => entry.observation.observationId),
  });
  return { binding, acquired: Object.freeze(acquired), producerScopes, scope, readScope };
}
