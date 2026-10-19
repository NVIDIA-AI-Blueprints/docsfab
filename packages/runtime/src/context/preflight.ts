// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { realpath } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { posix, resolve } from "node:path";

import { createArtifact, type ArtifactEnvelope } from "../artifacts/index.js";
import type {
  ContextPreflightInput,
  ContextPreflightReason,
  ContextPreflightResult,
  ContextPreflightService,
  ContextPreflightTarget,
} from "./contracts.js";
import {
  buildContentIndex,
  buildScopedContentIndex,
  canonicalDigest,
  ContentIndexError,
  contentIndexLimitations,
  contentIndexNameWarnings,
  isNavigationLimitation,
  type ContentIndexV1,
  type DocumentNode,
  type ScopedIndexCoverage,
} from "../content-ir/index.js";
import type { RepositoryWorkspace } from "../repository/workspace/contracts.js";
import { listTrackedRepositoryEntries } from "../repository/workspace/tracked-read.js";
import {
  contextPacketBudget,
  contextPacketShareLimitName,
  isContextPacketInputWindow,
} from "./budget.js";
import {
  CONTEXT_PACKET_BYTES_PER_ESTIMATED_TOKEN,
  type ContextBudget,
  type ContextPolicy,
  type ContextPreflightDiagnostic,
  type ContextPreflightLimitEvidence,
  type ContextQuery,
  type ContextReason,
  type ContextReasonCode,
} from "./contracts.js";
import {
  contextPreflightCause,
  repositoryRelativePreflightDiagnostic,
  thrownCauseCode,
  thrownMessage,
  toContextPreflightDiagnostic,
} from "./diagnostic.js";
import { ContextService, type ContextServiceResponse } from "./service.js";

const ONTOLOGY_VERSION = "ontology-v1";

export interface LocalContextPreflightServiceOptions {
  /** Durable local cache outside the disposable repository workspace. */
  cacheRoot: string;
  /** Test seam; production callers use the revision-bound file cache. */
  service?: ContextService;
  clock?: () => number;
  /**
   * The materialized export the runner reviews. That export leaves tracked
   * symlinks absent on disk, so without this handle a focused index could not
   * tell a required navigation alias from a file that does not exist.
   */
  workspace?: RepositoryWorkspace;
  /**
   * Input window, in tokens, of the model that runs the steps. Each packet's
   * budget is a declared share of it (`budget.ts`); without one, the catalog
   * fallback window applies.
   */
  modelInputTokens?: number;
}

export type LocalContextPreflightResult = ContextPreflightResult & {
  diagnostic?: ContextPreflightDiagnostic;
};

/**
 * Compiles structural context from the exact disposable checkout selected by
 * the runner. The derived ontology repeats only document identity evidence; it
 * never infers page roles, reader jobs, or other semantics from repository text.
 */
export class LocalContextPreflightService implements ContextPreflightService {
  private readonly service: ContextService;
  private readonly clock: () => number;
  private readonly workspace: RepositoryWorkspace | undefined;
  private readonly modelInputTokens: number | undefined;

  public constructor(options: LocalContextPreflightServiceOptions) {
    if (
      options.modelInputTokens !== undefined &&
      !isContextPacketInputWindow(options.modelInputTokens)
    ) {
      throw new Error(
        "Local context preflight needs the model input window as a positive whole number of tokens.",
      );
    }
    this.service = options.service ?? ContextService.withFileCache(options.cacheRoot);
    this.clock = options.clock ?? (() => performance.now());
    this.workspace = options.workspace;
    this.modelInputTokens = options.modelInputTokens;
  }

  public async preflight(input: ContextPreflightInput): Promise<LocalContextPreflightResult> {
    const startedAt = this.clock();
    const targets = focusedTargets(input);
    if (!input.policy.required && targets.length === 0) {
      return { status: "unnecessary", reason: "policy-marked-unnecessary" };
    }

    if (input.policy.query !== "expand" && !input.contextTarget) {
      return { status: "unnecessary", reason: "target-not-applicable" };
    }

    let index: ContentIndexV1;
    let coverage: ScopedIndexCoverage | undefined;
    try {
      const includePaths = indexIncludePaths(input);
      if (includePaths) {
        const scoped = await buildScopedContentIndex({
          repositoryPath: input.workspacePath,
          repositoryRevision: input.repository.revision,
          includePaths,
          trackedAliasPaths: await this.trackedAliasPaths(input),
        });
        if (scoped.status === "alias-refused") {
          return aliasRefusedResult(scoped.coverage);
        }
        index = scoped.index;
        coverage = scoped.coverage;
      } else {
        index = await buildContentIndex({
          repositoryPath: input.workspacePath,
          repositoryRevision: input.repository.revision,
        });
      }
    } catch (error) {
      return indexFailureResult(error, input.workspacePath);
    }
    // Files the index left out under their on-disk names reach the run record
    // whatever the step's context turns out to be.
    const limitations = contentIndexNameWarnings(index);
    let result: LocalContextPreflightResult;
    try {
      result = await this.compile(input, index, coverage, targets, startedAt);
    } catch (error) {
      result = compileFailureResult(error, input.workspacePath);
    }
    return limitations.length > 0 ? { ...result, limitations: [...limitations] } : result;
  }

  /**
   * Compiles the step's packet from a built index. A throw here is DocsFab's
   * own: the index already built, so the caller records it as
   * `context-compile-failed`.
   */
  private async compile(
    input: ContextPreflightInput,
    index: ContentIndexV1,
    coverage: ScopedIndexCoverage | undefined,
    targets: readonly ContextPreflightTarget[],
    startedAt: number,
  ): Promise<LocalContextPreflightResult> {
    const documentIds = index.nodes
      .filter((node): node is DocumentNode => node.kind === "document")
      .map((node) => node.id)
      .sort();
    // Every target this preflight was asked to bind (one explicit
    // `contextTarget`, or a multi-page scope's `targetPaths`), split by
    // whether it resolves to a document at this revision. A one-page scope
    // folds into `contextTarget` before this input is built
    // (`taskContextTarget`), so `targets.length <= 1` covers every
    // single-target shape uniformly.
    const resolvedTargets = targets.filter(
      (target) => resolveNodeId(index, target.sourcePath, target.anchor) !== undefined,
    );
    // No target this preflight was asked to bind resolves to a document:
    // -- not "the index has zero documents", since a root navigation page
    // (README.md) can still land in `documentIds` as incidental ancestor
    // context for a target that is itself absent -- either a single named
    // page (fail-open: the operator asked about one page, and it turns out
    // to be pure code, renamed, or deleted, so there is nothing to review,
    // not a broken run), or a multi-page scope whose every page is outside
    // the indexed documentation corpus. Fewer than every target failing
    // (a mixed scope) is handled after the packet compiles, below: this
    // reads a SUCCESSFULLY built index that legitimately matched none of
    // the targets -- an index that could not be built never reaches this
    // method: `preflight()` records it with its own coded reason.
    const allTargetsUnresolved = targets.length > 0 && resolvedTargets.length === 0;
    if (documentIds.length === 0) {
      return { status: "unnecessary", reason: "target-not-applicable" };
    }
    const budget = contextPacketBudget(input.policy.level, this.modelInputTokens);
    const query = contextQuery(input, index, documentIds, budget.maxDepth);
    if (!query) {
      // The one ADJACENT condition this must NOT absorb, still `failed` via
      // `missingTargetResult()`: a target that DID resolve, where query
      // construction still fails for an unrelated reason (for example
      // `test-placement` naming no `candidateParentPath`). Only "nothing
      // named here resolves" becomes `unnecessary`.
      return allTargetsUnresolved
        ? { status: "unnecessary", reason: "target-not-applicable" }
        : missingTargetResult();
    }

    const ontology = structuralOntology(index);
    const policy = compilerPolicy(input);
    const response = await this.service.resolve({
      access: input.step.mode === "write" ? "write-capable" : "read-only",
      input: {
        index,
        ontology,
        semantics: [],
        query,
        policy,
        budget,
      },
    });
    const latencyMs = Math.max(0, this.clock() - startedAt);
    // A compiled packet can still omit a target that DID resolve: when the
    // requested pages alone do not fit the budget, the trim keeps them in
    // request order and drops the rest (`compiler.ts`'s
    // `retentionOrder`). `withPartialScopeCoverage` below degrades such a
    // step and names every requested target the packet does not bind,
    // instead of failing it closed for a page that did resolve; passing it
    // the targets the packet actually bound (never more than
    // `resolvedTargets`) routes a binding-time drop through that same
    // degrade. A packet the budget withheld binds nothing, so every target
    // filters out here too. A compile that came back `failed` for another
    // cause (semantics) passes through `withPartialScopeCoverage` and
    // `withNavigationCoverage` unchanged. One whose reason the preflight has
    // no mapping for is DocsFab's own, recorded with its raw reason.
    const mapped = mapResponse(response, latencyMs);
    if (mapped.reason === "context-compile-failed") return mapped;
    const boundTargets = resolvedTargets.filter((target) =>
      packetBindsContextTarget(response.result.packet, target),
    );
    return withPartialScopeCoverage(
      withNavigationCoverage(
        enforceTotalBudget(mapped, budget),
        (coverage?.incompleteNavigationPaths.length ?? 0) > 0 ||
          contentIndexLimitations(index).some(isNavigationLimitation),
      ),
      targets,
      boundTargets,
    );
  }

  /**
   * Tracked symlinks of the export this preflight indexes. Handles only the
   * case where the configured workspace IS the indexed directory at the same
   * revision; any other directory is read from disk alone, so one workspace's
   * aliases can never be charged to another checkout.
   */
  private async trackedAliasPaths(input: ContextPreflightInput): Promise<string[]> {
    const workspace = this.workspace;
    if (!workspace || workspace.revision !== input.repository.revision) return [];
    const [indexed, exported] = await Promise.all([
      realpath(resolve(input.workspacePath)),
      realpath(resolve(workspace.path)),
    ]);
    if (indexed !== exported) return [];
    return (await listTrackedRepositoryEntries(workspace))
      .filter((entry) => entry.kind === "symlink" && entry.path !== undefined)
      .map((entry) => entry.path!);
  }
}

/** The selected pages this preflight must bind: one named target, or the whole scope. */
function focusedTargets(input: ContextPreflightInput): ContextPreflightTarget[] {
  if (input.contextTarget) return [input.contextTarget];
  return (input.scope?.targetPaths ?? []).map((sourcePath) => ({ sourcePath }));
}

function indexIncludePaths(input: ContextPreflightInput): string[] | undefined {
  const target = input.contextTarget;
  if (target) {
    return target.candidateParentPath
      ? [target.sourcePath, target.candidateParentPath]
      : [target.sourcePath];
  }
  const scopePaths = input.scope?.targetPaths ?? [];
  return scopePaths.length > 0 ? [...scopePaths] : undefined;
}

/**
 * A selected page, or a directory on its path, is an alias. It is never
 * followed and no packet is compiled: the step is `degraded` with no packet,
 * and the runner lets a read-only step continue without one and stops a write
 * step, which needs one. The cause names every refused alias.
 */
function aliasRefusedResult(coverage: ScopedIndexCoverage): LocalContextPreflightResult {
  const message = `Focused context does not follow a selected alias: ${coverage.refusedAliasPaths.join(", ")}.`;
  return {
    status: "degraded",
    reason: "navigation-alias-refused",
    cause: contextPreflightCause("selected-alias", message),
    diagnostic: repositoryRelativePreflightDiagnostic(message),
  };
}

/**
 * The content index could not be built. A `ContentIndexError` is a refusal
 * of something in the checkout, recorded with its content index code; a
 * file-system error is recorded with its code; anything else is DocsFab's
 * own and records as `context-compile-failed`. Each leaves the step
 * `degraded` with no packet, and the cause names the file when the error does.
 */
function indexFailureResult(error: unknown, workspacePath: string): LocalContextPreflightResult {
  const cause = contextPreflightCause(thrownCauseCode(error), thrownMessage(error), workspacePath);
  return {
    status: "degraded",
    reason:
      error instanceof ContentIndexError
        ? "content-index-refused"
        : FILE_SYSTEM_ERROR_CODE.test(cause.code)
          ? "content-index-unreadable"
          : "context-compile-failed",
    cause,
    diagnostic: toContextPreflightDiagnostic(error, workspacePath),
  };
}

/** A Node.js file-system error code, such as `EACCES` or `EIO`. */
const FILE_SYSTEM_ERROR_CODE = /^E[A-Z0-9]+$/u;

/**
 * Compiling the packet from a built index threw: DocsFab built every input
 * the compile received, so the failure is its own.
 */
function compileFailureResult(error: unknown, workspacePath: string): LocalContextPreflightResult {
  return {
    status: "degraded",
    reason: "context-compile-failed",
    cause: contextPreflightCause(thrownCauseCode(error), thrownMessage(error), workspacePath),
    diagnostic: toContextPreflightDiagnostic(error, workspacePath),
  };
}

/**
 * Handles exactly one condition: a compiled `ready` or `degraded` packet whose
 * index could not read required navigation, or recorded a navigation
 * limitation: an entry it could not link, or a navigation source it could not
 * read or will not run. It becomes `degraded` with
 * `navigation-coverage-incomplete` (an earlier degrade keeps its own reason).
 * A `failed` result, or one with complete navigation, is unchanged. A skipped
 * symlink or a left-out page anchor is not a navigation limitation.
 */
function withNavigationCoverage(
  result: ContextPreflightResult,
  navigationIncomplete: boolean,
): ContextPreflightResult {
  if (!navigationIncomplete) return result;
  if (result.status !== "ready" && result.status !== "degraded") return result;
  return {
    ...result,
    status: "degraded",
    reason: result.reason ?? "navigation-coverage-incomplete",
  };
}

/**
 * Handles exactly one condition: a `ready` or `degraded` result for a scope
 * where at least one requested page is not bound in the packet -- a single
 * named target counts too, since binding can diverge from resolution (see
 * `boundTargets` above). It becomes `degraded` with
 * `scope-target-partially-unresolved` (an earlier degrade, such as a budget
 * trim, keeps its own reason) and names in `unboundTargets` every requested
 * target the packet does not bind. A `failed` result, an empty target list,
 * and a scope where every page is bound are all unchanged.
 *
 * `unboundTargets` covers two causes the same way, because a review cannot
 * tell them apart from its own scope request: a page absent from the corpus
 * entirely, and a page that resolved but did not survive the packet budget.
 * The trim keeps requested pages first, in request order, so it drops one only
 * when the requested pages alone do not fit. The step's own `reviewScope`
 * input still carries the complete requested list, so an unbound page stays
 * in the authoritative scope without compiled context; this record, and the
 * operator summary built from it, name it.
 */
function withPartialScopeCoverage(
  result: ContextPreflightResult,
  targets: readonly ContextPreflightTarget[],
  boundTargets: readonly ContextPreflightTarget[],
): ContextPreflightResult {
  if (boundTargets.length === targets.length) return result;
  if (result.status !== "ready" && result.status !== "degraded") return result;
  const bound = new Set(boundTargets.map(targetLabel));
  return {
    ...result,
    status: "degraded",
    reason: result.reason ?? "scope-target-partially-unresolved",
    unboundTargets: [
      ...new Set(targets.map(targetLabel).filter((label) => !bound.has(label))),
    ].sort(),
  };
}

/** A requested target as the record names it: its path, with `#anchor` when it named one. */
function targetLabel(target: ContextPreflightTarget): string {
  const path = target.sourcePath.normalize("NFC");
  return target.anchor === undefined ? path : `${path}#${target.anchor.normalize("NFC")}`;
}

/**
 * A requested path as the content index names the file it read: normalized
 * and NFC (`content-ir/indexer.ts` `requestedPathKey`), so a page requested by
 * its decomposed (NFD) on-disk name resolves to the node the index built from
 * it. A backslash stays part of the name: the index leaves out a file whose
 * name holds one, so a request naming it binds nothing, never a different
 * page. Only lookups use this; the index reads each file by its on-disk name.
 */
function indexPathKey(sourcePath: string): string {
  return posix.normalize(sourcePath).normalize("NFC");
}

/**
 * The one ADJACENT condition `allTargetsUnresolved` above must not absorb: a
 * target that DID resolve, where the query still could not be built for an
 * unrelated reason (a `test-placement` naming no `candidateParentPath`).
 * That stays `failed`: it is not a benign "nothing to review" outcome, it is
 * a request the compiler could not honor for a resolved page.
 */
function missingTargetResult(): LocalContextPreflightResult {
  return {
    status: "failed",
    reason: "target-not-applicable",
    diagnostic: {
      name: "Error",
      message: "Context target is not present in the bounded content index.",
    },
  };
}

/** True when the compiled packet retains the operator-requested path (and anchor). */
export function packetBindsContextTarget(
  packet:
    | {
        readonly nodes?: ReadonlyArray<{
          kind: string;
          sourcePath: string;
          anchor?: string;
        }>;
      }
    | undefined,
  target: ContextPreflightTarget,
): boolean {
  if (!packet?.nodes) return false;
  const sourcePath = indexPathKey(target.sourcePath);
  const anchor = target.anchor?.normalize("NFC");
  return packet.nodes.some((node) => {
    if (node.sourcePath !== sourcePath) return false;
    if (anchor === undefined) return true;
    return node.kind === "section" && node.anchor === anchor;
  });
}

/**
 * Sibling of {@link packetBindsContextTarget} for a multi-page scope: true only
 * when EVERY selected target is bound. An empty target list binds nothing.
 */
export function packetBindsEveryContextTarget(
  packet: Parameters<typeof packetBindsContextTarget>[0],
  targets: readonly ContextPreflightTarget[],
): boolean {
  return targets.length > 0 && targets.every((target) => packetBindsContextTarget(packet, target));
}

function expandSeedIds(
  input: ContextPreflightInput,
  index: ContentIndexV1,
  documentIds: string[],
): string[] | undefined {
  const target = input.contextTarget;
  if (!target) {
    const scopePaths = input.scope?.targetPaths ?? [];
    if (scopePaths.length === 0) return documentIds;
    // Seed every RESOLVABLE selected page. A page that does not resolve is
    // simply not seeded here: the caller already computed `resolvedTargets`
    // and `allTargetsUnresolved` from the same corpus before this runs, and
    // decides "unnecessary" (none resolve) vs "degraded, reviewing the rest"
    // (some resolve) vs "ready" (all resolve) from those, not from this
    // function's return value alone.
    const seeds = scopePaths.flatMap((path) => {
      const seed = resolveNodeId(index, path);
      return seed ? [seed] : [];
    });
    return seeds.length > 0 ? [...new Set(seeds)] : undefined;
  }
  const targetNodeId = resolveNodeId(index, target.sourcePath, target.anchor);
  if (!targetNodeId) return undefined;
  const seeds = [targetNodeId];
  if (!target.candidateParentPath) return seeds;
  const parentId = resolveNodeId(index, target.candidateParentPath, target.candidateParentAnchor);
  if (!parentId) return undefined;
  if (parentId !== targetNodeId) seeds.push(parentId);
  return seeds;
}

function contextQuery(
  input: ContextPreflightInput,
  index: ContentIndexV1,
  documentIds: string[],
  depth: number,
): ContextQuery | undefined {
  if (input.policy.query === "expand") {
    const targetNodeIds = expandSeedIds(input, index, documentIds);
    if (!targetNodeIds || targetNodeIds.length === 0) return undefined;
    return { kind: "expand", targetNodeIds, depth };
  }
  const target = input.contextTarget;
  if (!target) return undefined;
  const targetNodeId = resolveNodeId(index, target.sourcePath, target.anchor);
  if (!targetNodeId) return undefined;
  switch (input.policy.query) {
    case "locate":
      return {
        kind: "locate",
        sourcePath: indexPathKey(target.sourcePath),
        ...(target.anchor ? { anchor: target.anchor.normalize("NFC") } : {}),
      };
    case "get-neighborhood":
      return { kind: "get-neighborhood", targetNodeId, depth };
    case "find-home":
      return { kind: "find-home", targetNodeId };
    case "test-placement": {
      if (!target.candidateParentPath) return undefined;
      const candidateParentId = resolveNodeId(
        index,
        target.candidateParentPath,
        target.candidateParentAnchor,
      );
      return candidateParentId
        ? { kind: "test-placement", targetNodeId, candidateParentId }
        : undefined;
    }
  }
}

function resolveNodeId(
  index: ContentIndexV1,
  sourcePath: string,
  anchor?: string,
): string | undefined {
  const path = indexPathKey(sourcePath);
  const slug = anchor?.normalize("NFC");
  const matches = index.nodes.filter(
    (node) =>
      node.sourcePath === path &&
      (slug === undefined
        ? node.kind === "document"
        : node.kind === "section" && node.anchor === slug),
  );
  return matches.length === 1 ? matches[0]!.id : undefined;
}

/** A validated ontology whose claims are limited to structural document facts. */
export function structuralOntology(index: ContentIndexV1): ArtifactEnvelope<"ontology"> {
  return createArtifact(
    "ontology",
    {
      entities: index.nodes
        .filter((node): node is DocumentNode => node.kind === "document")
        .map((document) => ({
          id: `artifact:${document.id}`,
          label: document.sourcePath,
          kind: "artifact" as const,
          evidence: [{ path: document.sourcePath, nodeId: document.id }],
        }))
        .sort((left, right) => left.id.localeCompare(right.id)),
      relationships: [],
    },
    { index },
  );
}

function compilerPolicy(input: ContextPreflightInput): ContextPolicy {
  const allowDegradedRead = input.policy.allowReadOnlyDegraded || input.step.mode === "write";
  const identity = {
    workflow: input.workflow.name,
    mode: input.step.mode,
    level: input.policy.level,
    query: input.policy.query,
    allowDegradedRead,
    // The same page set can belong to a different admitted review scope.
    // Keep that sealed identity in the cache key without changing the packet
    // or widening the selected content index.
    ...(input.scope ? { scopeSha256: input.scope.scopeSha256 } : {}),
  };
  return {
    // Structural context depends on the selected bytes and query policy, not
    // the reviewing role. Step identity stays on the run record; including it
    // here prevents identical read-only stages from sharing compiled evidence.
    id: `workflow:${input.workflow.name}:context`,
    version: "1",
    digest: canonicalDigest(identity),
    // Compilation must preserve a bounded packet when a structural budget is
    // reached. The runner separately decides whether that packet is sufficient
    // for the requested access mode and explicit write authorization.
    allowDegradedRead,
  };
}

function mapResponse(response: ContextServiceResponse, latencyMs: number): ContextPreflightResult {
  const { result, evidence } = response;
  const packet = result.packet;
  const mapped: ContextPreflightResult = {
    status: result.status,
    consultedNodeIds: [...result.provenance.consultedNodeIds],
    ontologyVersion: ONTOLOGY_VERSION,
    effectiveDecisionIds: [...result.provenance.activeDecisionIds],
    measurements: {
      byteLength: evidence.byteLength,
      estimatedTokens: evidence.estimatedTokens,
      latencyMs: Math.max(0, latencyMs),
      nodeCount: evidence.nodeCount,
      edgeCount: evidence.edgeCount,
      pathCount: evidence.pathCount,
    },
    cache: {
      disposition: evidence.cache,
      keyDigest: evidence.cacheKeyDigest,
      rebuildAttempted: evidence.rebuildAttempted,
    },
    ...(packet ? { packetDigest: packet.digest, packet } : {}),
  };
  const reason = mapReason(result.reasons.map((item) => item.code));
  if (reason === "context-compile-failed") return compilerRefusedResult(mapped, result.reasons);
  if (reason) return { ...mapped, reason };
  // A packet the compiler trimmed to fit, or could not fit at all, names the
  // budget, never a bare degrade or an internal failure.
  const limit = packetBudgetLimit(result.provenance.budget, observedPacketTokens(result.reasons));
  return limit ? { ...mapped, reason: "preflight-budget-exceeded", limit } : mapped;
}

/**
 * The estimated tokens the compiler measured, from the detail its byte or
 * token budget reason carries: the whole walk before a trim or, when not even
 * the first-ranked node fits, that smallest packet. `undefined` when neither
 * reason measured one.
 */
function observedPacketTokens(reasons: readonly ContextReason[]): number | undefined {
  let observed: number | undefined;
  for (const reason of reasons) {
    const measured = reason.detail === undefined ? Number.NaN : Number(reason.detail);
    if (!Number.isSafeInteger(measured) || measured < 0) continue;
    const tokens =
      reason.code === "token-budget-exceeded"
        ? measured
        : reason.code === "byte-budget-exceeded"
          ? Math.ceil(measured / CONTEXT_PACKET_BYTES_PER_ESTIMATED_TOKEN)
          : undefined;
    if (tokens !== undefined) observed = Math.max(observed ?? 0, tokens);
  }
  return observed;
}

/**
 * The record of a packet over its budget: the catalog share that sized the
 * budget, the token budget it gives this run's input window, and what the
 * packet measured. `undefined` unless the packet measured over that budget;
 * a packet exactly at its budget fits.
 */
function packetBudgetLimit(
  budget: ContextBudget,
  observedTokens: number | undefined,
): ContextPreflightLimitEvidence | undefined {
  if (observedTokens === undefined || observedTokens <= budget.maxEstimatedTokens) return undefined;
  return {
    name: contextPacketShareLimitName(budget.class),
    unit: "tokens",
    configured: budget.maxEstimatedTokens,
    observed: observedTokens,
  };
}

function mapReason(codes: readonly ContextReasonCode[]): ContextPreflightReason | undefined {
  if (codes.length === 0) return undefined;
  if (codes.every((code) => BUDGET_REASON_CODES.has(code))) return undefined;
  if (codes.some((code) => SEMANTIC_REASON_CODES.has(code))) return "semantic-state-unavailable";
  if (codes.some((code) => TARGET_REASON_CODES.has(code))) return "target-not-applicable";
  // What is left is a reason the preflight has no mapping for, such as
  // `invalid-input` or `repository-mismatch`: the compiler refused an input
  // DocsFab built itself.
  return "context-compile-failed";
}

const BUDGET_REASON_CODES: ReadonlySet<ContextReasonCode> = new Set([
  "node-budget-exceeded",
  "edge-budget-exceeded",
  "path-budget-exceeded",
  "depth-budget-exceeded",
  "byte-budget-exceeded",
  "token-budget-exceeded",
  "latency-budget-exceeded",
]);
const SEMANTIC_REASON_CODES: ReadonlySet<ContextReasonCode> = new Set([
  "page-role-unresolved",
  "canonical-home-unresolved",
  "placement-undetermined",
]);
const TARGET_REASON_CODES: ReadonlySet<ContextReasonCode> = new Set([
  "target-unresolved",
  "candidate-parent-unresolved",
  "location-unresolved",
  "context-unnecessary",
]);

/**
 * A compile whose reasons the preflight has no mapping for. The step gets no
 * packet, since DocsFab cannot vouch for one its own compiler refused, and the
 * cause names each raw reason with its content-free detail: `invalid-input
 * (context-rebuild-failed)`. The measurements and cache evidence stay.
 */
function compilerRefusedResult(
  mapped: ContextPreflightResult,
  reasons: readonly ContextReason[],
): ContextPreflightResult {
  const unmapped = reasons.filter(
    (reason) =>
      !BUDGET_REASON_CODES.has(reason.code) &&
      !SEMANTIC_REASON_CODES.has(reason.code) &&
      !TARGET_REASON_CODES.has(reason.code),
  );
  const named = unmapped
    .map((reason) => (reason.detail ? `${reason.code} (${reason.detail})` : reason.code))
    .join(", ");
  const {
    packet: _packet,
    packetDigest: _packetDigest,
    consultedNodeIds: _consultedNodeIds,
    effectiveDecisionIds: _effectiveDecisionIds,
    ...evidence
  } = mapped;
  return {
    ...evidence,
    status: "degraded",
    reason: "context-compile-failed",
    cause: contextPreflightCause(
      unmapped[0]?.code ?? "invalid-input",
      `The context compiler returned ${named} for the input DocsFab built.`,
    ),
  };
}

/**
 * Handles a step that cannot have a packet within its budget: the compiler
 * could not fit even its first-ranked node (a `failed` compile that names the
 * budget), or a service returned a packet that measures over it. Either way
 * the step gets no packet and the evidence names the bound.
 *
 * The result is `degraded` with no packet, so the runner's existing rule
 * decides: a read-only step whose policy admits degraded reads continues
 * without context, and a write step, which needs a packet, stops with this
 * coded bound. Node, edge, and path counts never bind before the token
 * budget (`budget.ts`), so the token budget is the one checked here.
 */
function enforceTotalBudget(
  result: ContextPreflightResult,
  budget: ContextBudget,
): ContextPreflightResult {
  const measurements = result.measurements;
  if (result.packet && measurements) {
    const limit = packetBudgetLimit(
      budget,
      Math.max(
        measurements.estimatedTokens,
        Math.ceil(measurements.byteLength / CONTEXT_PACKET_BYTES_PER_ESTIMATED_TOKEN),
      ),
    );
    if (limit) return withoutPacket(result, limit);
  }
  if (!result.packet && result.status === "failed" && result.limit) {
    return withoutPacket(result, result.limit);
  }
  // End-to-end latency includes repository indexing and cache I/O. It remains
  // recorded as operational evidence, but a slow, otherwise valid packet is
  // not less trustworthy and must not revoke explicit write authorization.
  return result;
}

function withoutPacket(
  result: ContextPreflightResult,
  limit: ContextPreflightLimitEvidence,
): ContextPreflightResult {
  // The node and decision IDs describe a packet the step never receives.
  const {
    packet: _packet,
    packetDigest: _packetDigest,
    consultedNodeIds: _consultedNodeIds,
    effectiveDecisionIds: _effectiveDecisionIds,
    ...evidence
  } = result;
  return { ...evidence, status: "degraded", reason: "preflight-budget-exceeded", limit };
}
