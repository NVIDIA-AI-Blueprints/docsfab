// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

import type {
  WorkflowSearchCoordinator,
  WorkflowSearchCoordinatorInput,
  WorkflowSearchCoordinatorResultV1,
  WorkflowSearchResultV1,
} from "../workflow-contracts/contracts.js";
import {
  createExecutionCheckpoint,
  createExecutionLeaseIdentity,
  createExecutionLeasePolicy,
  createExecutionLeaseState,
  decideExecutionLeaseRenewal,
  type ExecutionCheckpointV1,
  type ExecutionLeaseDecisionV1,
  type ExecutionLeaseStateV1,
} from "../execution/index.js";
import {
  createBoundedSearchEvidence,
  createSearchConfidence,
  createSearchCoverage,
  createSearchFinding,
  createSearchLimitation,
  createSearchProbe,
  createSearchProgressEvidence,
  createSearchProgressEvent,
  createSearchProgressExecutionAuthority,
  createSearchProgressObservation,
  createSearchProgressPolicy,
  createSearchRemainingWorkRationale,
  type SearchLimitationV1,
  type SearchProbeV1,
  type SearchProgressEventCategory,
  type SearchProgressEventV1,
  type SearchProgressObservationV1,
  type SearchTargetV1,
  searchTargetSatisfied,
} from "../search/index.js";
import {
  buildRepositoryDiscoveryInventory,
  createRepositoryBatchReplayAuthority,
  formatRepositoryInventoryEntryLimitation,
  runRepositoryBatchProbes,
  type RepositoryBatchProbeEvidenceV1,
  type RepositoryBatchProbeRequestV1,
  type RepositoryDiscoveryInventoryV1,
} from "../repository/inventory.js";
import type { RepositoryWorkspace } from "../repository/workspace/contracts.js";
import {
  releaseDocumentationQuestion as releaseRubricQuestion,
  releaseDocumentationRepositoryIdentity,
} from "../release-documentation-rubric.js";
import { instantiateWorkflowSearchTargets } from "../workflow-contracts/search.js";
import {
  admitChangeImpactReadAuthority,
  assessChangeImpact,
  type AssessChangeImpactInput,
  type ChangeImpactPreflightV1,
  type VerifyChangeImpactSourceRunRecord,
} from "./change-impact.js";
import { buildContentIndexV2 } from "../content-ir/indexer.js";
import { formatLimitExceeded } from "../config/limits.js";
import { repositoryInventoryMaxEntriesLimit } from "../config/repository-discovery-limits.js";

const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;
const DOCUMENT = /(?:^|\/)(?:[^/]+\.(?:md|mdx|rst)|README|CONTRIBUTING)$/iu;
const CONVENTIONAL =
  /^(?:README|CONTRIBUTING)(?:\.(?:md|mdx|rst))?$|^docs\/(?:README|index)(?:\.(?:md|mdx|rst))?$/iu;

interface InventoryFile {
  path: string;
  sha256: string;
}

interface DocumentationInventory {
  files: InventoryFile[];
  complete: boolean;
  evidenceSha256: string;
  repositoryInventory?: RepositoryDiscoveryInventoryV1;
  /** The operator line when the inventory stopped at `repository.inventoryMaxEntries`. */
  entryLimitation?: string;
}

/**
 * Deterministic, read-only local coordinator for the catalog's current search
 * strategies. A supplied repository workspace enables authenticated inventory
 * and Content IR navigation evidence. The legacy filesystem-only path reports
 * semantic rubric and navigation probes as unsupported.
 */
export class LocalWorkflowSearchCoordinator implements WorkflowSearchCoordinator {
  public constructor(
    private readonly options: {
      workspace?: RepositoryWorkspace;
      verifyChangeImpactSourceRunRecord?: VerifyChangeImpactSourceRunRecord;
      /** Host-verified tracked inventory identity for a pre-materialized checkout. */
      workspaceSnapshotSha256?: string;
    } = {},
  ) {}

  public async search(
    input: WorkflowSearchCoordinatorInput,
  ): Promise<WorkflowSearchCoordinatorResultV1> {
    const root = await realpath(input.repositoryPath);
    const evidenceWarnings: string[] = [];
    const observedInventory = this.options.workspace
      ? await this.governedInventory(input, root, (warning) => evidenceWarnings.push(warning))
      : await documentationInventory(root);
    // Every workflow reports a clipped inventory as a run warning, which
    // LIMITATIONS prints, not only release readiness, whose result also
    // carries the inventory itself (#1927).
    if (observedInventory.entryLimitation) evidenceWarnings.push(observedInventory.entryLimitation);
    const inventory = this.options.workspaceSnapshotSha256
      ? { ...observedInventory, evidenceSha256: this.options.workspaceSnapshotSha256 }
      : observedInventory;
    const repositoryIdentitySha256 =
      input.workflow.name === "release-documentation-readiness"
        ? releaseDocumentationRepositoryIdentity({
            ...input.repository,
            defaultBranch: input.repositoryDefaultBranch ?? "",
          })
        : digest(input.repository.sourcePath);
    const targets = instantiateWorkflowSearchTargets(input.plan, {
      identitySha256: repositoryIdentitySha256,
      revision: input.repository.revision,
    });
    const results = targets.map((target) => searchTarget(target, inventory));
    return {
      repositoryIdentitySha256,
      workspaceSnapshotSha256: inventory.evidenceSha256,
      searches: results.map((result) => result.search),
      ...(evidenceWarnings.length > 0 ? { evidenceWarnings } : {}),
      ...(inventory.repositoryInventory && input.workflow.name === "release-documentation-readiness"
        ? {
            trustedRepositoryInventory: inventory.repositoryInventory,
            repositoryBatchAuthority: createRepositoryBatchReplayAuthority({
              repositoryIdentitySha256,
              inventory: inventory.repositoryInventory,
              targets: results.map((result, index) => {
                const target = targets[index]!;
                if (!result.batch) throw new Error("Governed release search batch is missing.");
                return { target, requests: result.batch.requests, evidence: result.batch.evidence };
              }),
            }),
          }
        : {}),
    };
  }

  /**
   * Build change-impact evidence from the same authenticated inventory used by
   * workflow search. The caller supplies admitted source identities and exact
   * comparison scope; this method supplies the host snapshot/navigation facts.
   */
  public async inspectChangeImpact(
    input: Omit<
      AssessChangeImpactInput,
      "repositoryPath" | "workspaceSnapshotSha256" | "observationEvidence" | "bindings"
    > & { sourceRunRecordSha256: string },
  ): Promise<ChangeImpactPreflightV1> {
    const workspace = this.options.workspace;
    const verifySourceRunRecord = this.options.verifyChangeImpactSourceRunRecord;
    if (!workspace || !verifySourceRunRecord) {
      throw new Error(
        "Governed change-impact inspection requires workspace and run-record authority.",
      );
    }
    const inventory = await buildRepositoryDiscoveryInventory({ workspace });
    const contentIndex = await buildContentIndexV2({ workspace });
    const request: AssessChangeImpactInput = {
      changedPaths: input.changedPaths,
      comparison: input.comparison,
      sources: input.sources,
      ...(input.includePaths ? { includePaths: input.includePaths } : {}),
      ...(input.mode ? { mode: input.mode } : {}),
      ...(input.previousAssessment ? { previousAssessment: input.previousAssessment } : {}),
      repositoryPath: workspace.path,
      workspaceSnapshotSha256: inventory.inventorySha256,
      observationEvidence: {
        workspaceSnapshotSha256: inventory.inventorySha256,
        inventoryEvidenceSha256: inventory.inventorySha256,
        navigationEvidenceSha256: inventory.navigation.evidenceSha256,
        inventoryComplete: inventory.status === "complete",
        navigationComplete: inventory.coverage.navigation.status === "complete",
      },
      bindings: {
        repositoryIdentitySha256: digest(workspace.sourcePath),
        repositoryRevision: workspace.revision,
        repositoryContentDigestSha256: contentIndex.repository.contentDigest,
        sourceRunRecordSha256: input.sourceRunRecordSha256,
      },
    };
    const authority = await admitChangeImpactReadAuthority({
      request,
      workspace,
      inventory,
      verifySourceRunRecord,
    });
    return assessChangeImpact(request, authority);
  }

  private async governedInventory(
    input: WorkflowSearchCoordinatorInput,
    root: string,
    recordWarning: (warning: string) => void,
  ): Promise<DocumentationInventory> {
    const workspace = this.options.workspace!;
    if (
      (await realpath(workspace.path)) !== root ||
      (await realpath(workspace.sourcePath)) !== (await realpath(input.repository.sourcePath)) ||
      (input.workflow.name === "release-documentation-readiness" &&
        workspace.requestedRevision !== input.repository.requestedRevision) ||
      workspace.revision !== input.repository.revision
    ) {
      throw new Error("Governed repository inventory does not match the workflow workspace.");
    }
    const repositoryInventory = await buildRepositoryDiscoveryInventory({
      workspace,
      ...(input.authorizedWritePaths ? { authorizedWritePaths: input.authorizedWritePaths } : {}),
      recordWarning,
    });
    const entryLimitation = formatRepositoryInventoryEntryLimitation(repositoryInventory);
    return {
      files: repositoryInventory.documents.map((document) => ({
        path: document.path,
        sha256: document.evidenceSha256,
      })),
      complete: repositoryInventory.status === "complete",
      evidenceSha256: repositoryInventory.inventorySha256,
      repositoryInventory,
      ...(entryLimitation ? { entryLimitation } : {}),
    };
  }
}

/**
 * Filesystem-only inventory for a coordinator without a governed workspace.
 * The walk shares the governed inventory's declared entry bound,
 * `repository.inventoryMaxEntries`, which a host can raise; past it, the
 * search records an incomplete index instead of failing. Documents are a
 * subset of those entries, so no second document-count bound applies.
 */
async function documentationInventory(root: string): Promise<DocumentationInventory> {
  const files: InventoryFile[] = [];
  const entryLimit = repositoryInventoryMaxEntriesLimit();
  let entries = 0;
  let complete = true;
  let entryLimitExceeded = false;

  const walk = async (directory: string): Promise<void> => {
    if (!complete) return;
    let children;
    try {
      children = await readdir(directory, { withFileTypes: true });
    } catch {
      complete = false;
      return;
    }
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      entries += 1;
      if (entries > entryLimit.value) {
        complete = false;
        entryLimitExceeded = true;
        return;
      }
      const absolute = join(directory, child.name);
      const repositoryPath = relative(root, absolute).split(sep).join("/");
      if (!safeRepositoryPath(repositoryPath)) {
        complete = false;
        return;
      }
      if (child.isSymbolicLink()) {
        complete = false;
        return;
      }
      if (child.isDirectory()) {
        await walk(absolute);
        if (!complete) return;
        continue;
      }
      if (!child.isFile() || !DOCUMENT.test(repositoryPath)) continue;
      try {
        const handle = await open(absolute, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
        try {
          const before = await handle.stat();
          if (!before.isFile() || before.size > MAX_DOCUMENT_BYTES) {
            complete = false;
            return;
          }
          const bytes = await handle.readFile();
          const after = await handle.stat();
          if (
            bytes.byteLength !== before.size ||
            before.dev !== after.dev ||
            before.ino !== after.ino ||
            before.size !== after.size ||
            before.mtimeMs !== after.mtimeMs
          ) {
            complete = false;
            return;
          }
          files.push({ path: repositoryPath, sha256: digest(bytes) });
        } finally {
          await handle.close();
        }
      } catch {
        complete = false;
        return;
      }
    }
  };

  await walk(root);
  files.sort((left, right) => left.path.localeCompare(right.path));
  return {
    files,
    complete,
    evidenceSha256: digest({ complete, files }),
    // The walk stops at the bound, so it states the limit, never a count.
    ...(entryLimitExceeded ? { entryLimitation: formatLimitExceeded(entryLimit) } : {}),
  };
}

function searchTarget(
  target: SearchTargetV1,
  inventory: DocumentationInventory,
): { search: WorkflowSearchResultV1; batch?: GovernedBatch } {
  const batched = inventory.repositoryInventory
    ? governedBatch(target, inventory.repositoryInventory)
    : undefined;
  const batchedById = new Map(batched?.evidence.results.map((result) => [result.id, result]));
  const probeInputs = target.requiredProbes.map((declaration) => {
    // This declaration names the judgment the readiness model is responsible
    // for making. It is carried in the bounded contract for rubric coverage,
    // but it is not a host search operation and must never be reported as a
    // blocked host probe.
    if (
      declaration.strategy === "rubric-assessment" &&
      releaseRubricQuestion(target.targetKey, declaration.id) === undefined
    ) {
      return {
        declaration,
        outcome: "inconclusive" as const,
        matches: [] as InventoryFile[],
      };
    }
    const batchResult = batchedById.get(declaration.id);
    if (batchResult) {
      if (batchResult.disposition === "found") {
        return {
          declaration,
          outcome: "match" as const,
          matches: batchResult.paths.map((path) => ({
            path,
            sha256: digest({ batchEvidenceSha256: batchResult.evidenceSha256, path }),
          })),
        };
      }
      if (batchResult.disposition === "not-found-after-bounded-search") {
        return { declaration, outcome: "no-match" as const, matches: [] as InventoryFile[] };
      }
      return {
        declaration,
        outcome: "blocked" as const,
        matches: [] as InventoryFile[],
        blockedCategory:
          batchResult.disposition === "unsupported"
            ? ("unsupported-operation" as const)
            : ("index-incomplete" as const),
      };
    }
    const requiresGovernedInventory = target.requiredProbes.some(
      (probe) => releaseRubricQuestion(target.targetKey, probe.id) !== undefined,
    );
    if (requiresGovernedInventory && !inventory.repositoryInventory) {
      return {
        declaration,
        outcome: "blocked" as const,
        matches: [] as InventoryFile[],
        blockedCategory: "unsupported-operation" as const,
      };
    }
    if (declaration.strategy === "navigation-graph" && !inventory.repositoryInventory) {
      return {
        declaration,
        outcome: "blocked" as const,
        matches: [] as InventoryFile[],
        blockedCategory: "unsupported-operation" as const,
      };
    }
    if (!inventory.complete) {
      return {
        declaration,
        outcome: "blocked" as const,
        matches: [] as InventoryFile[],
        blockedCategory: "index-incomplete" as const,
      };
    }
    if (
      declaration.strategy === "documentation-inventory" ||
      declaration.strategy === "tracked-text-index" ||
      declaration.strategy === "filename-index"
    ) {
      return {
        declaration,
        outcome: inventory.files.length > 0 ? ("match" as const) : ("no-match" as const),
        matches: inventory.files,
      };
    }
    if (declaration.strategy === "exact-path") {
      const matches = inventory.files.filter((file) => CONVENTIONAL.test(file.path));
      return {
        declaration,
        outcome: matches.length > 0 ? ("match" as const) : ("no-match" as const),
        matches,
      };
    }
    return {
      declaration,
      outcome: "blocked" as const,
      matches: [] as InventoryFile[],
      blockedCategory: "unsupported-operation" as const,
    };
  });

  const probes = probeInputs.map(({ declaration, outcome, matches }) =>
    createSearchProbe(
      {
        id: declaration.id,
        strategy: declaration.strategy,
        location: declaration.location,
        scopeSha256: digest({
          repositoryIdentitySha256: target.repository.identitySha256,
          repositoryRevision: target.repository.revision,
          strategy: declaration.strategy,
          location: declaration.location,
        }),
        outcome,
        matchCount: outcome === "match" ? matches.length : 0,
        evidenceSha256:
          batchedById.get(declaration.id)?.evidenceSha256 ??
          digest({
            inventoryEvidenceSha256: inventory.evidenceSha256,
            strategy: declaration.strategy,
            matches,
            outcome,
          }),
        citations:
          outcome === "match"
            ? matches.slice(0, 64).map((file) => ({
                path: file.path,
                anchorSha256: digest({ fileSha256: file.sha256, probeId: declaration.id }),
              }))
            : [],
      },
      target,
    ),
  );

  const blockedByCategory = new Map<"index-incomplete" | "unsupported-operation", string[]>();
  for (const input of probeInputs) {
    if (input.outcome !== "blocked") continue;
    const category = input.blockedCategory;
    blockedByCategory.set(category, [
      ...(blockedByCategory.get(category) ?? []),
      input.declaration.id,
    ]);
  }
  const limitations: SearchLimitationV1[] = [...blockedByCategory].map(([category, probeIds]) =>
    createSearchLimitation(
      {
        id:
          category === "unsupported-operation"
            ? "unsupported-local-probe"
            : "local-index-incomplete",
        category,
        impact: "blocking",
        probeIds,
        detailSha256: digest({
          inventoryEvidenceSha256: inventory.evidenceSha256,
          category,
          probeIds,
        }),
      },
      target,
      probes,
    ),
  );

  const firstLease = probes.map((probe, index) =>
    progressEvent(
      target,
      probes,
      limitations,
      probe.outcome === "blocked"
        ? limitations.find((item) => item.probeIds.includes(probe.id))?.category ===
          "unsupported-operation"
          ? "unsupported-operation"
          : "tool-failure"
        : "evidence-produced",
      probe,
      probe.outcome === "blocked"
        ? limitations.find((item) => item.probeIds.includes(probe.id))
        : undefined,
      index + 1,
    ),
  );
  const terminalUnsatisfied =
    !searchTargetSatisfied(target, probes) &&
    probes.every((probe) => probe.outcome === "match" || probe.outcome === "no-match");
  const leases: SearchProgressEventV1[][] = terminalUnsatisfied
    ? [
        firstLease,
        probes.map((probe, index) =>
          progressEvent(
            target,
            probes,
            limitations,
            "no-new-evidence",
            undefined,
            undefined,
            index + 1,
          ),
        ),
        probes.map((probe, index) =>
          progressEvent(
            target,
            probes,
            limitations,
            "no-new-evidence",
            undefined,
            undefined,
            index + 1,
          ),
        ),
      ]
    : [firstLease];
  const observations: SearchProgressObservationV1[] = [];
  for (let index = 0; index < leases.length; index += 1) {
    const execution = executionFor(
      target,
      leases.slice(0, index + 1),
      index === leases.length - 1,
      inventory.evidenceSha256,
    );
    observations.push(
      createSearchProgressObservation({
        target,
        probes,
        limitations,
        execution,
        events: leases[index]!,
        previousObservations: observations,
      }),
    );
  }
  const execution = executionFor(target, leases, true, inventory.evidenceSha256);
  const current = observations.at(-1)!;
  const rationale = createSearchRemainingWorkRationale({
    target,
    category: current.remainingRequiredProbeIds.length > 0 ? "required-probes" : "none",
    remainingRequiredProbeIds: current.remainingRequiredProbeIds,
    remainingWorkCount: current.remainingRequiredProbeIds.length,
    detailSha256: digest({
      inventoryEvidenceSha256: inventory.evidenceSha256,
      remainingRequiredProbeIds: current.remainingRequiredProbeIds,
    }),
    citations: [],
  });
  const progress = createSearchProgressEvidence({
    policy: createSearchProgressPolicy(),
    execution,
    target,
    probes,
    limitations,
    observations,
    rationale,
  });
  const coverage = createSearchCoverage({
    target,
    probes,
    limitations,
    blockerDisclosure: { status: "complete", undisclosedBlockerCount: 0 },
  });
  const confidence = createSearchConfidence({
    target,
    probes,
    coverage,
    limitations,
    disposition: progress.recommendation.disposition,
    saturation: progress.recommendation.saturation,
  });
  const finding = createSearchFinding({ target, probes, limitations, coverage, confidence });
  return {
    search: {
      targetId: target.id,
      bounded: createBoundedSearchEvidence({
        target,
        probes,
        limitations,
        coverage,
        confidence,
        finding,
      }),
      progress,
    },
    ...(batched ? { batch: batched } : {}),
  };
}

interface GovernedBatch {
  requests: RepositoryBatchProbeRequestV1[];
  evidence: RepositoryBatchProbeEvidenceV1;
}

/**
 * Closed, target-specific probe set. Raw repository content never selects a
 * question, and the target binding is authenticated before the inventory
 * executes the batch.
 */
function governedBatch(
  target: SearchTargetV1,
  inventory: RepositoryDiscoveryInventoryV1,
): GovernedBatch | undefined {
  const probes: RepositoryBatchProbeRequestV1[] = target.requiredProbes.map((declaration) => ({
    id: declaration.id,
    question: inventoryQuestion(target, declaration),
  }));
  if (probes.length === 0) return undefined;
  return { requests: probes, evidence: runRepositoryBatchProbes({ inventory, target, probes }) };
}

function inventoryQuestion(
  target: SearchTargetV1,
  declaration: SearchTargetV1["requiredProbes"][number],
): RepositoryBatchProbeRequestV1["question"] {
  const releaseQuestion = releaseRubricQuestion(target.targetKey, declaration.id);
  if (releaseQuestion) return releaseQuestion;
  const strategy = declaration.strategy;
  if (strategy === "rubric-assessment") {
    return { kind: "unsupported", operation: "semantic-assessment" };
  }
  if (strategy === "navigation-graph") {
    return { kind: "metadata", field: "navigation-graph" };
  }
  if (strategy === "documentation-inventory") {
    return { kind: "metadata", field: "documentation" };
  }
  if (strategy === "dependency-manifest") return { kind: "metadata", field: "dependency" };
  if (strategy === "script-manifest") return { kind: "metadata", field: "command" };
  if (strategy === "ci-configuration") return { kind: "metadata", field: "ci-validation" };
  if (target.targetType === "rubric-coverage") {
    return { kind: "metadata", field: "documentation" };
  }
  if (target.artifactClass === "configuration") {
    return { kind: "metadata", field: "configuration" };
  }
  if (target.artifactClass === "dependency") {
    return { kind: "metadata", field: "dependency" };
  }
  if (target.artifactClass === "script") return { kind: "metadata", field: "command" };
  if (target.artifactClass === "ci-definition") {
    return { kind: "metadata", field: "ci-validation" };
  }
  if (target.artifactClass === "navigation-entry") {
    return { kind: "metadata", field: "documentation" };
  }
  return strategy === "exact-path"
    ? { kind: "metadata", field: "conventional-entrypoint" }
    : { kind: "metadata", field: "documentation" };
}

function progressEvent(
  target: SearchTargetV1,
  probes: SearchProbeV1[],
  limitations: SearchLimitationV1[],
  category: SearchProgressEventCategory,
  probe: SearchProbeV1 | undefined,
  limitation: SearchLimitationV1 | undefined,
  sequence: number,
): SearchProgressEventV1 {
  return createSearchProgressEvent(
    {
      sequence,
      category,
      operationSha256: digest({ targetSha256: target.targetSha256, category, sequence }),
      probeId: probe?.id ?? null,
      probeSha256: probe?.probeSha256 ?? null,
      evidenceSha256: category === "evidence-produced" ? (probe?.evidenceSha256 ?? null) : null,
      limitationSha256: limitation?.limitationSha256 ?? null,
      citations: probe?.citations ?? [],
    },
    target,
    probes,
    limitations,
  );
}

function executionFor(
  target: SearchTargetV1,
  leases: SearchProgressEventV1[][],
  completed: boolean,
  inventoryEvidenceSha256: string,
) {
  const callsPerLease = Math.max(1, ...leases.map((events) => events.length));
  const policy = createExecutionLeasePolicy({
    callsPerLease,
    maxLeases: 4,
    hardToolCallCeiling: callsPerLease * 4,
    maxProviderTurns: callsPerLease * 4 + 4,
    maxCompactions: 4,
    cumulative: {
      maxInputTokens: 10_000,
      maxOutputTokens: 10_000,
      maxElapsedMs: 10_000,
    },
  });
  const identity = createExecutionLeaseIdentity({
    inferenceAttempt: 1,
    retriesConsumed: 0,
    authorizationSha256: null,
    repositoryRevision: target.repository.revision,
    contextPacketSha256: null,
    evidenceSha256: inventoryEvidenceSha256,
    toolPolicySha256: digest("docsfab-local-search-tool-policy-v1"),
    contextAuthoritySha256: digest("docsfab-local-search-context-authority-v1"),
    policySha256: policy.policySha256,
  });
  const checkpoints: ExecutionCheckpointV1[] = [];
  const decisions: ExecutionLeaseDecisionV1[] = [];
  let previousState: ExecutionLeaseStateV1 | undefined;
  const totals = {
    requested: 0,
    executed: 0,
    succeeded: 0,
    failed: 0,
    denied: 0,
    governanceBlocked: 0,
  };
  for (let index = 0; index < leases.length; index += 1) {
    const events = leases[index]!;
    const denied = events.filter((event) => event.category === "authorization-denied").length;
    const governanceBlocked = events.filter(
      (event) => event.category === "governance-denied",
    ).length;
    const succeeded = events.filter(
      (event) => event.category === "evidence-produced" || event.category === "no-new-evidence",
    ).length;
    const failed = events.length - denied - governanceBlocked - succeeded;
    const executed = succeeded + failed;
    totals.requested += events.length;
    totals.executed += executed;
    totals.succeeded += succeeded;
    totals.failed += failed;
    totals.denied += denied;
    totals.governanceBlocked += governanceBlocked;
    const state = createExecutionLeaseState(
      {
        leaseNumber: index + 1,
        leaseExecutedToolCalls: executed,
        providerTurns: index + 1,
        compactions: 0,
        toolCalls: { ...totals },
        cumulativeInputTokens: index + 1,
        cumulativeOutputTokens: index + 1,
        elapsedMs: index + 1,
        cost: { status: "known", microusd: 0 },
        lastCheckpointSha256: checkpoints.at(-1)?.checkpointSha256 ?? null,
      },
      policy,
      previousState,
    );
    const checkpoint = createExecutionCheckpoint({
      policy,
      identity,
      state,
      reason: index === leases.length - 1 && completed ? "workflow-completed" : "lease-exhausted",
      ...(checkpoints.length > 0 ? { previous: checkpoints.at(-1)! } : {}),
    });
    checkpoints.push(checkpoint);
    previousState = state;
    if (index < leases.length - 1) {
      decisions.push(
        decideExecutionLeaseRenewal({
          policy,
          identity,
          checkpoint,
          ...(index > 0
            ? { history: { checkpoints: checkpoints.slice(0, -1), decisions: [...decisions] } }
            : {}),
        }),
      );
    }
  }
  return createSearchProgressExecutionAuthority({
    target,
    policy,
    identity,
    checkpoints,
    decisions,
  });
}

function safeRepositoryPath(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 4_096 &&
    !isAbsolute(value) &&
    !/^[A-Za-z]:[\\/]/u.test(value) &&
    !value.includes("\\") &&
    !value.split("/").includes("..") &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function digest(value: string | Uint8Array | object): string {
  const bytes =
    typeof value === "string" || value instanceof Uint8Array
      ? value
      : JSON.stringify(sortValue(value));
  return createHash("sha256").update(bytes).digest("hex");
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortValue(child)]),
  );
}
