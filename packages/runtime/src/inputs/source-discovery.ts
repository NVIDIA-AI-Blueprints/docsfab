// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Bounded source discovery over an injected merged-MR page port.
 *
 * Turns `list_merged` pages into bounded descriptors, a resume cursor, and an
 * explicit coverage report. It opens no transport, filesystem, child process,
 * or clock of its own; the GitLab port lives in `./merged-mr-gitlab.js`, which
 * this module does not import so it stays testable against fixtures.
 *
 * - Completeness is explicit: a walk that did not finish reports an uncovered
 *   window even with zero descriptors, so "no merges matched" is never confused
 *   with "the read did not finish".
 * - The numeric project id is the identity locators are keyed on; the path is
 *   recorded alongside it for readers only.
 * - Failures are codes: a page failure is one `MERGED_MR_FAILURE_CODES` entry
 *   and never copies the port's error text, and no `SOURCE_DISCOVERY_REFUSALS`
 *   message echoes the refused value.
 *
 * Descriptors carry no MR title, description, or diff text; they are handles a
 * later read step resolves through the source registry.
 */

import { canonicalGitlabMrReviewLocator } from "./gitlab-mr-locator.js";
import {
  discoverMergedMrs,
  type MergedMrDiscoveryDispositionV1,
  type MergedMrFailureCodeV1,
  type MergedMrPagePortV1,
} from "./merged-mr-discovery.js";
import {
  assessMergedMrApplicability,
  type MergedMrCommitProvenanceV1,
  type MergedMrDateWindowV1,
  type MergedMrEvidenceGapV1,
  type MergedMrExclusionV1,
  type MergedMrSelectedV1,
} from "./merged-mr-selection.js";
import { assertConfinedToolResultCredentialFree } from "../security/credential-isolation.js";
import type { EgressValueRefusalCode } from "../security/egress.js";

/**
 * Default ceiling on returned descriptors, independent of the page and row
 * ceilings. When it bites, the window is reported as uncovered.
 */
export const SOURCE_DISCOVERY_DEFAULT_DESCRIPTOR_LIMIT = 200;

/** Longest locator text this service will parse. */
const LOCATOR_TEXT_LIMIT = 512;

/**
 * Mirrors `./gitlab-mr-locator.js`. Every match is re-minted through
 * `canonicalGitlabMrReviewLocator` and compared byte for byte, so this pattern
 * cannot accept a shape the canonical minter would not produce.
 */
const GITLAB_MR_LOCATOR = /^gitlab-mr:v1:host=([^:/]+):project=(\d+):mr=(\d+)$/u;

/** Shapes that are a host path rather than a remote locator. */
const LOCAL_PATH = /^(?:[A-Za-z]:[\\/]|[\\/]|\.{1,2}[\\/]|~[\\/]|file:)/u;

export const SOURCE_DISCOVERY_REFUSAL_CODES = [
  "scope-identity",
  "local-path",
  "unsupported-locator",
  "out-of-scope-locator",
  "credentials",
  "host-path",
  "egress-unwalkable-value",
] as const;

export type SourceDiscoveryRefusalCodeV1 = (typeof SOURCE_DISCOVERY_REFUSAL_CODES)[number];

/**
 * Operator-facing refusal text. No message interpolates the refused locator,
 * path, or row, so a refusal can be shown, logged, or written to a tracker.
 */
export const SOURCE_DISCOVERY_REFUSALS: Readonly<Record<SourceDiscoveryRefusalCodeV1, string>> =
  Object.freeze({
    // Covers an unusable scope, a path-only reference with no identity port, and
    // an unproved acquisition scope: the scope cannot be trusted to name one project.
    "scope-identity":
      "Source discovery requires a scope whose numeric GitLab project id is known and proved to name the same project as its path. A project path is resolved once at the boundary and is never substituted for the id, and a scope that was rebuilt or copied after that resolution is no longer proved. Supply the project path and let the boundary resolve its id, then pass the scope it returns without reconstructing it.",
    "local-path":
      "Source discovery refused a local filesystem path presented as a remote locator. Only a canonical gitlab-mr locator routes through an enabled scoped adapter.",
    "unsupported-locator":
      "Source discovery refused a locator that is not a canonical gitlab-mr locator. Source text, provider endpoints and arbitrary URLs cannot route a discovery request.",
    // Covers both a locator naming another project and a supplied id and path
    // that resolve to different projects, so the text describes both.
    "out-of-scope-locator":
      "Source discovery refused a reference or locator naming a project outside the enabled scope. A supplied numeric project id and project path must resolve to the same project, and no cross-project scope is ever inferred. Supply the project path on its own to have its id resolved, or correct the pair so both name one project.",
    credentials:
      "Blocked by DocsFab runtime credential screening (source-discovery).\nDiscovered GitLab evidence matched a credential-like pattern and was withheld from the result; this is not an authentication failure.",
    // Raised only when two keys of a result merge once their host roots are
    // replaced; the search payload otherwise replaces roots and continues.
    "host-path":
      "Discovered GitLab evidence named this host's paths in a form that could not be replaced safely, so the result was withheld. Paths in row text are normally replaced with a neutral placeholder and returned; here two entries became indistinguishable after replacement. Re-run the search once the upstream merge request no longer names this host's paths, or narrow the target branch so the offending row falls outside the walk.",
    "egress-unwalkable-value":
      "The source search result was withheld because DocsFab's outbound screen could not walk its structure, such as a value that is not plain JSON data or one over the screen's size cap. This is not a credential finding or an authentication failure. Retry with a narrower date window or target branch; if it recurs, report it to DocsFab maintainers as a defect.",
  });

/**
 * The discovery refusal for an egress refusal of a search result. Two keys that
 * merge once their roots are replaced are a host-path refusal.
 */
export function sourceDiscoveryEgressRefusal(
  code: EgressValueRefusalCode,
): SourceDiscoveryRefusalCodeV1 {
  switch (code) {
    case "credential-material":
      return "credentials";
    case "egress-key-collision":
      return "host-path";
    case "egress-unwalkable-value":
      return "egress-unwalkable-value";
  }
}

export class SourceDiscoveryError extends Error {
  public constructor(public readonly code: SourceDiscoveryRefusalCodeV1) {
    super(SOURCE_DISCOVERY_REFUSALS[code]);
    this.name = "SourceDiscoveryError";
  }
}

export function failSourceDiscovery(code: SourceDiscoveryRefusalCodeV1): never {
  throw new SourceDiscoveryError(code);
}

/** `projectId` is the canonical identity; `projectPath` is recorded for readability only. */
export interface SourceDiscoveryScopeV1 {
  readonly schemaVersion: 1;
  readonly kind: "docsfab-source-discovery-scope";
  readonly providerId: string;
  readonly host: string;
  readonly projectId: number;
  readonly projectPath: string | null;
}

export type SourceDescriptorApplicabilityV1 =
  | "unassessed"
  | "applicable"
  | "revision-absent-from-checkout"
  | "missing-commit-identity";

/** A handle onto discovered evidence; it carries no evidence text. */
export interface SourceDescriptorV1 {
  readonly schemaVersion: 1;
  readonly kind: "docsfab-source-descriptor";
  readonly providerId: string;
  readonly locator: string;
  readonly projectId: number;
  readonly projectPath: string | null;
  readonly mergeRequestIid: number;
  readonly mergedAt: string;
  readonly mergedAtMs: number;
  readonly targetBranch: string;
  readonly commitSha: string | null;
  readonly commitProvenance: MergedMrCommitProvenanceV1;
  readonly evidenceGaps: readonly MergedMrEvidenceGapV1[];
  readonly applicability: SourceDescriptorApplicabilityV1;
}

/**
 * Where a later walk resumes, page-granular. `ordering-violated` is not
 * resumable because resuming would re-trust the broken ordering. A descriptor
 * cap is not a resume point either; a page cursor cannot resume mid-page.
 */
export interface SourceDiscoveryCursorV1 {
  readonly resumable: boolean;
  readonly nextPage: number | null;
  readonly lastGoodPage: number;
}

export interface SourceDiscoveryCoverageV1 {
  readonly disposition: MergedMrDiscoveryDispositionV1;
  readonly windowCovered: boolean;
  readonly failureCode: MergedMrFailureCodeV1 | null;
  readonly pagesRead: number;
  readonly rowsRead: number;
  readonly itemsRead: number;
  /** Merge-request numbers the port returned more than once, in first-seen order. */
  readonly duplicateRows: readonly number[];
  readonly truncatedPages: readonly number[];
  readonly descriptorLimitReached: boolean;
  /** Selected merge requests dropped because the request named other locators. */
  readonly notRequested: readonly number[];
  readonly excluded: readonly MergedMrExclusionV1[];
}

export interface SourceDiscoveryResultV1 {
  readonly schemaVersion: 1;
  readonly kind: "docsfab-source-discovery";
  readonly scope: SourceDiscoveryScopeV1;
  readonly window: MergedMrDateWindowV1;
  readonly targetBranch: string;
  readonly descriptors: readonly SourceDescriptorV1[];
  readonly inapplicable: readonly SourceDescriptorV1[];
  readonly cursor: SourceDiscoveryCursorV1;
  readonly coverage: SourceDiscoveryCoverageV1;
}

export interface SourceDiscoveryOptionsV1 {
  readonly scope: SourceDiscoveryScopeV1;
  readonly port: MergedMrPagePortV1;
  readonly window: MergedMrDateWindowV1;
  readonly targetBranch: string;
  /** Narrow discovery to these canonical locators; each is checked against the scope first. */
  readonly requestedLocators?: readonly string[];
  /** Revisions present in the target checkout; omit to leave applicability unassessed. */
  readonly presentRevisions?: Iterable<string>;
  readonly maxPages?: number;
  readonly maxRows?: number;
  readonly maxDescriptors?: number;
  readonly signal?: AbortSignal;
}

const RESUMABLE_DISPOSITIONS: ReadonlySet<MergedMrDiscoveryDispositionV1> = new Set([
  "page-failed",
  "page-limit-reached",
  "item-limit-reached",
  "cancelled",
]);

/**
 * Validates the scope by minting a probe locator, so `host` and `projectId`
 * follow `canonicalGitlabMrReviewLocator`'s rules with no second copy.
 */
export function requireSourceDiscoveryScope(scope: SourceDiscoveryScopeV1): SourceDiscoveryScopeV1 {
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) {
    failSourceDiscovery("scope-identity");
  }
  if (scope.kind !== "docsfab-source-discovery-scope" || scope.schemaVersion !== 1) {
    failSourceDiscovery("scope-identity");
  }
  if (typeof scope.providerId !== "string" || scope.providerId.length === 0) {
    failSourceDiscovery("scope-identity");
  }
  if (scope.projectPath !== null && typeof scope.projectPath !== "string") {
    failSourceDiscovery("scope-identity");
  }
  try {
    canonicalGitlabMrReviewLocator({
      host: scope.host,
      projectId: scope.projectId,
      mergeRequestIid: 1,
    });
  } catch {
    failSourceDiscovery("scope-identity");
  }
  return scope;
}

/**
 * Accepts a locator only when it is canonical and inside the enabled scope; a
 * non-locator fails before the scope is consulted.
 */
export function requireLocatorInScope(value: unknown, scope: SourceDiscoveryScopeV1): string {
  const scoped = requireSourceDiscoveryScope(scope);
  if (typeof value !== "string" || value.length === 0 || value.length > LOCATOR_TEXT_LIMIT) {
    failSourceDiscovery("unsupported-locator");
  }
  if (LOCAL_PATH.test(value)) failSourceDiscovery("local-path");
  const matched = GITLAB_MR_LOCATOR.exec(value);
  if (!matched) failSourceDiscovery("unsupported-locator");
  const host = matched[1] as string;
  const projectId = Number(matched[2]);
  const mergeRequestIid = Number(matched[3]);
  let canonical: string;
  try {
    canonical = canonicalGitlabMrReviewLocator({ host, projectId, mergeRequestIid });
  } catch {
    failSourceDiscovery("unsupported-locator");
  }
  // A locator the minter would have written differently is not the one it claims.
  if (canonical !== value) failSourceDiscovery("unsupported-locator");
  if (host !== scoped.host || projectId !== scoped.projectId) {
    failSourceDiscovery("out-of-scope-locator");
  }
  return canonical;
}

function requireDescriptorLimit(value: number | undefined): number {
  const limit = value ?? SOURCE_DISCOVERY_DEFAULT_DESCRIPTOR_LIMIT;
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error(
      `Source discovery requires a positive integer descriptor ceiling before it reads any page. Received: ${JSON.stringify(value)}.`,
    );
  }
  return limit;
}

function describeSelection(
  entry: MergedMrSelectedV1,
  scope: SourceDiscoveryScopeV1,
  applicability: SourceDescriptorApplicabilityV1,
): SourceDescriptorV1 {
  // No locator means the scope lost its numeric id; fail closed rather than emit
  // a descriptor no read step could resolve.
  if (typeof entry.locator !== "string" || entry.locator.length === 0) {
    failSourceDiscovery("scope-identity");
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    kind: "docsfab-source-descriptor" as const,
    providerId: scope.providerId,
    locator: entry.locator,
    projectId: scope.projectId,
    projectPath: scope.projectPath,
    mergeRequestIid: entry.iid,
    mergedAt: entry.mergedAt,
    mergedAtMs: entry.mergedAtMs,
    targetBranch: entry.targetBranch,
    commitSha: entry.commitSha,
    commitProvenance: entry.commitProvenance,
    evidenceGaps: entry.evidenceGaps,
    applicability,
  });
}

/**
 * Walks the injected port within explicit bounds. An unusable scope or
 * out-of-scope requested locator fails before any page is read.
 */
export async function discoverSourceDescriptors(
  options: SourceDiscoveryOptionsV1,
): Promise<SourceDiscoveryResultV1> {
  const scope = requireSourceDiscoveryScope(options.scope);
  const maxDescriptors = requireDescriptorLimit(options.maxDescriptors);
  const requested =
    options.requestedLocators === undefined
      ? null
      : new Set(options.requestedLocators.map((locator) => requireLocatorInScope(locator, scope)));

  const walk = await discoverMergedMrs({
    port: options.port,
    window: options.window,
    targetBranch: options.targetBranch,
    project: {
      host: scope.host,
      projectId: scope.projectId,
      ...(scope.projectPath === null ? {} : { projectPath: scope.projectPath }),
    },
    ...(options.maxPages === undefined ? {} : { maxPages: options.maxPages }),
    ...(options.maxRows === undefined ? {} : { maxRows: options.maxRows }),
    ...(options.signal ? { signal: options.signal } : {}),
  });

  const notRequested: number[] = [];
  const kept: MergedMrSelectedV1[] = [];
  for (const entry of walk.selected) {
    if (requested !== null && (entry.locator === null || !requested.has(entry.locator))) {
      notRequested.push(entry.iid);
      continue;
    }
    kept.push(entry);
  }

  const descriptorLimitReached = kept.length > maxDescriptors;
  const bounded = descriptorLimitReached ? kept.slice(0, maxDescriptors) : kept;

  const descriptors: SourceDescriptorV1[] = [];
  const inapplicable: SourceDescriptorV1[] = [];
  if (options.presentRevisions === undefined) {
    // No checkout was offered, so applicability is unknown, not applicable.
    for (const entry of bounded) descriptors.push(describeSelection(entry, scope, "unassessed"));
  } else {
    const assessed = assessMergedMrApplicability(bounded, options.presentRevisions);
    for (const entry of assessed.applicable) {
      descriptors.push(describeSelection(entry, scope, "applicable"));
    }
    const reasons = new Map(assessed.inapplicable.map((entry) => [entry.iid, entry.reason]));
    for (const entry of bounded) {
      const reason = reasons.get(entry.iid);
      if (reason === undefined) continue;
      inapplicable.push(describeSelection(entry, scope, reason));
    }
  }

  const windowCovered = walk.windowCovered && !descriptorLimitReached;
  const resumable = RESUMABLE_DISPOSITIONS.has(walk.disposition);
  const result: SourceDiscoveryResultV1 = Object.freeze({
    schemaVersion: 1 as const,
    kind: "docsfab-source-discovery" as const,
    scope,
    window: options.window,
    targetBranch: options.targetBranch,
    descriptors: Object.freeze(descriptors),
    inapplicable: Object.freeze(inapplicable),
    cursor: Object.freeze({
      resumable,
      nextPage: resumable ? walk.lastGoodPage + 1 : null,
      lastGoodPage: walk.lastGoodPage,
    }),
    coverage: Object.freeze({
      disposition: walk.disposition,
      windowCovered,
      failureCode: walk.failureCode,
      pagesRead: walk.pagesRead,
      rowsRead: walk.rowsRead,
      itemsRead: walk.itemsRead,
      duplicateRows: walk.duplicateRows,
      truncatedPages: walk.truncatedPages,
      descriptorLimitReached,
      notRequested: Object.freeze(notRequested),
      excluded: walk.excluded,
    }),
  });

  // Exclusions carry upstream row text verbatim, so screen the whole result for
  // credential-shaped bytes before a caller renders, logs, or relays it.
  try {
    assertConfinedToolResultCredentialFree(result);
  } catch {
    failSourceDiscovery("credentials");
  }
  return result;
}
