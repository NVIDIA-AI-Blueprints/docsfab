// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-step source search: which merged merge requests exist to bind, answered
 * with bounded descriptors, a resume cursor, and a coverage verdict, never
 * evidence text.
 *
 * - The walk, bounds, ordering check, and credential screen are
 *   `discoverSourceDescriptors`; the page port is injected.
 * - The acquisition scope brand is re-verified on every search, before the port
 *   is touched, because a searcher outlives the call that built it. An
 *   unproved scope could key one project's descriptors on another's locator.
 * - A search cannot widen the binding: the only selector a model may name is
 *   an observation id the step reader already lists. Project, host, path,
 *   branch, and window come from the host-built searcher.
 */
import { canonicalGitlabMrReviewLocator } from "./gitlab-mr-locator.js";
import {
  assertGitLabAcquisitionScope,
  type GitLabAcquisitionScopeV1,
} from "./gitlab-source-provider.js";
import type { MergedMrPagePortV1 } from "./merged-mr-discovery.js";
import type { MergedMrDateWindowV1 } from "./merged-mr-selection.js";
import { gitlabMrSourceRepositoryPath } from "./source-acquisition-gitlab.js";
import { discoverSourceDescriptors, type SourceDiscoveryResultV1 } from "./source-discovery.js";
import { failSourceEvidenceService, type SourceStepReaderV1 } from "./source-resolver.js";

/**
 * Hard ceiling on descriptors one search may return. Narrower host and
 * per-call ceilings win; a model cannot widen it, because descriptor lists are
 * prompt-visible and an unbounded one becomes a bulk disclosure.
 *
 * At roughly 300 bytes per descriptor, fifty fits inside
 * `SOURCE_SEARCH_PAYLOAD_CEILING_BYTES` with room for the inapplicable list and
 * coverage report. `test/source-command-admission.test.ts` pins the literal so
 * a widening cannot pass silently.
 */
export const SOURCE_SEARCH_MAX_DESCRIPTORS = 50;

/** Everything a model may say about a search. */
export interface SourceSearchSelectionV1 {
  /** Narrow to evidence already bound to this run under this observation. */
  readonly observationId?: string;
  /** Per-call descriptor ceiling; clamped to the host and module ceilings. */
  readonly maxDescriptors?: number;
}

export interface SourceStepSearcherV1 {
  search(selection: SourceSearchSelectionV1): Promise<SourceDiscoveryResultV1>;
}

export interface SourceStepSearcherOptionsV1 {
  /** Proved by `resolveGitLabAcquisitionScope`; re-verified on every search. */
  readonly scope: GitLabAcquisitionScopeV1;
  readonly reader: SourceStepReaderV1;
  readonly port: MergedMrPagePortV1;
  readonly window: MergedMrDateWindowV1;
  readonly targetBranch: string;
  readonly maxDescriptors?: number;
  readonly maxPages?: number;
  readonly maxRows?: number;
  /** Revisions present in the target checkout; omit to leave applicability unassessed. */
  readonly presentRevisions?: Iterable<string>;
  readonly signal?: AbortSignal;
}

/**
 * The parsed number is re-rendered through `gitlabMrSourceRepositoryPath` and
 * compared byte for byte, so this never accepts a path the acquisition
 * producer would not write.
 */
const GITLAB_MR_REPOSITORY_PATH = /^gitlab-merge-request\/(\d+)\.txt$/u;

function mergeRequestIidOfBoundPath(repositoryPath: string | null): number | null {
  if (typeof repositoryPath !== "string") return null;
  const matched = GITLAB_MR_REPOSITORY_PATH.exec(repositoryPath);
  if (!matched) return null;
  const iid = Number(matched[1]);
  if (!Number.isSafeInteger(iid) || iid <= 0) return null;
  return gitlabMrSourceRepositoryPath(iid) === repositoryPath ? iid : null;
}

/**
 * Resolve a model-named observation into the one locator a search may narrow to.
 * Every refusal is `observation-unavailable`; distinguishing the cases would
 * tell a model which identifiers exist.
 */
function boundMergeRequestLocator(
  reader: SourceStepReaderV1,
  scope: GitLabAcquisitionScopeV1,
  observationId: unknown,
): string {
  if (typeof observationId !== "string" || observationId.length === 0) {
    failSourceEvidenceService("observation-unavailable");
  }
  // The same gate `read` uses: a superseded, ungranted, or cancelled step
  // reader refuses here before any narrowing is computed.
  const entry = reader.listSources().find((candidate) => candidate.observationId === observationId);
  if (!entry) failSourceEvidenceService("observation-unavailable");
  const mergeRequestIid = mergeRequestIidOfBoundPath(entry.repositoryPath);
  if (mergeRequestIid === null) failSourceEvidenceService("observation-unavailable");
  return canonicalGitlabMrReviewLocator({
    host: scope.host,
    projectId: scope.projectId,
    mergeRequestIid,
  });
}

/**
 * A malformed ceiling refuses as `span-unavailable`, the code
 * `docsfab_read_source` raises for a malformed selection.
 */
function requireDescriptorCeiling(selected: number | undefined, host: number | undefined): number {
  for (const value of [selected, host]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
      failSourceEvidenceService("span-unavailable");
    }
  }
  return Math.min(
    selected ?? SOURCE_SEARCH_MAX_DESCRIPTORS,
    host ?? SOURCE_SEARCH_MAX_DESCRIPTORS,
    SOURCE_SEARCH_MAX_DESCRIPTORS,
  );
}

/**
 * The scope is checked here so a wiring mistake fails at construction, and on
 * every search so a scope that lost its proof fails before a page is read.
 */
export function createSourceStepSearcher(
  options: SourceStepSearcherOptionsV1,
): SourceStepSearcherV1 {
  if (!options || typeof options !== "object") {
    throw new Error(
      "A per-step source searcher requires a proved acquisition scope, a step reader, an injected page port, a date window and a target branch.",
    );
  }
  assertGitLabAcquisitionScope(options.scope);
  if (!options.reader || typeof options.reader.listSources !== "function") {
    throw new Error(
      "A per-step source searcher requires the host-issued step reader; registry or artifact presence is not that grant.",
    );
  }
  return Object.freeze({
    async search(selection: SourceSearchSelectionV1): Promise<SourceDiscoveryResultV1> {
      // Fails closed before the port is touched: a refusal after a page fetch
      // would already have disclosed the walk to the wrong project.
      const scope = assertGitLabAcquisitionScope(options.scope);
      const narrowed = (selection ?? {}) as SourceSearchSelectionV1;
      const requestedLocators =
        narrowed.observationId === undefined
          ? undefined
          : [boundMergeRequestLocator(options.reader, scope, narrowed.observationId)];
      return discoverSourceDescriptors({
        scope,
        port: options.port,
        window: options.window,
        targetBranch: options.targetBranch,
        maxDescriptors: requireDescriptorCeiling(narrowed.maxDescriptors, options.maxDescriptors),
        ...(requestedLocators ? { requestedLocators } : {}),
        ...(options.maxPages === undefined ? {} : { maxPages: options.maxPages }),
        ...(options.maxRows === undefined ? {} : { maxRows: options.maxRows }),
        ...(options.presentRevisions === undefined
          ? {}
          : { presentRevisions: options.presentRevisions }),
        ...(options.signal ? { signal: options.signal } : {}),
      });
    },
  });
}
