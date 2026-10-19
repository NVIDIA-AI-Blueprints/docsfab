// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  createArtifact,
  DurableArtifactStore,
  type ArtifactReference,
} from "../artifacts/index.js";
import { resolve } from "node:path";
import { canonicalDigest } from "../content-ir/index.js";
import { buildContentIndex } from "../content-ir/index.js";
import type { ContentIndexV1 } from "../content-ir/contracts.js";
import type { ReaderContextInputV1 } from "../context/reader-context.js";
import {
  observeReaderTaskContextAdmissionV1,
  type ReaderSourceHintV1,
  type ReaderTaskContextNominationV1,
  type ReaderTaskContextObservationV1,
} from "../execution/reader-task-admission.js";
import {
  createReaderTaskContextSupplier,
  type ReaderTaskContextHandoffV1,
  type ReaderTaskContextInputOrigin,
  type ReaderTaskContextInputProjectionV1,
} from "../execution/task-context.js";
import type { VerifiedQualityPackContext } from "../quality-pack/manifest.js";
import type { RunRecord } from "../records/contracts.js";
import type { ReaderComparisonRequestV1 } from "../search/change-impact.js";
import type { WorkflowBranchEvidenceHost } from "../workflow-contracts/contracts.js";
import { workflowBranchCoverageDecodeOptionsV1 } from "../records/composition-execution.js";
import { projectRunEditorialOutcome } from "../operator/run-result.js";
import { verifyQualityPackContext } from "../quality-pack/manifest.js";
import { resolveDocsFabRuntimeAssetPaths } from "../config/runtime-loader.js";
import { decodeWorkflowBranchCoverageV1 } from "../workflow-contracts/branch-coverage.js";
import { getWorkflow } from "../workflow-registry/catalog.js";
import type {
  HostEditorialOutcomeAuthorityV1,
  HostRuntimeReaderEvidencePolicy,
  HostRuntimeReaderTaskV1,
  RunEditorialOutcomeV1,
} from "../host-invoker/contracts.js";
import { assertHostRuntimeReaderEvidenceNominations } from "../host-invoker/contracts.js";
import {
  createEditorialEvidenceHostV1,
  loadEditorialEvidenceDecodeOptionsFromStoreV1,
  loadEditorialEvidenceDecodeOptionsV1,
} from "./editorial-evidence-host.js";

export interface EditorialWorkflowEvidenceAssemblyV1 {
  readonly readerTaskContext: ReaderTaskContextInputProjectionV1;
  readonly observation: ReaderTaskContextObservationV1;
  readonly editorialEvidenceRefs: readonly ArtifactReference[];
  readonly workflowBranchEvidence: WorkflowBranchEvidenceHost;
}

/** Reconstruct one hosted editorial decision solely from retained canonical bytes. */
export async function replayEditorialWorkflowEvidenceV1(input: {
  repositoryPath: string;
  revision: string;
  stateDirectory: string;
  readerTask: HostRuntimeReaderTaskV1;
  readerEvidencePolicy: HostRuntimeReaderEvidencePolicy;
  record: Readonly<RunRecord>;
}): Promise<{
  readonly outcome: RunEditorialOutcomeV1;
  readonly authority: HostEditorialOutcomeAuthorityV1;
}> {
  if (input.record.workflow !== "update-documentation")
    throw new Error("Hosted editorial replay requires the update workflow record.");
  const verifiedQualityPack = await verifyQualityPackContext(resolveDocsFabRuntimeAssetPaths());
  const supplier = await createReaderTaskContextSupplier(verifiedQualityPack);
  const observation = await observeReaderTaskContextAdmissionV1({
    repositoryPath: input.repositoryPath,
    revision: input.revision,
    observationMode: "workflow-export",
    readerContextInput: input.readerTask.readerContextInput,
    comparisonRequest: input.readerTask.comparison,
    sourceHints: input.readerTask.sources,
    requestText: input.readerTask.requestText ?? input.readerTask.readerContextInput.reader_job,
    admitNominations: (nominations) =>
      assertHostRuntimeReaderEvidenceNominations(input.readerEvidencePolicy, nominations),
    requireCompleteChangedSources: true,
  });
  if (
    input.readerTask.comparison.headRevision !== input.revision ||
    observation.admission.admittedRevision !== input.revision
  )
    throw new Error("Hosted editorial replay differs from the frozen reader task.");
  const handoff = supplier.createHandoff({
    readerContextInput: input.readerTask.readerContextInput,
    admission: observation.admission,
    inputOrigin: input.readerTask.inputOrigin,
    ...(observation.sourceBinding ? { sourceBinding: observation.sourceBinding } : {}),
  });
  supplier.projectInput(input.readerTask.readerContextInput, {
    inputOrigin: input.readerTask.inputOrigin,
    handoff,
  });
  const editorial = await loadEditorialEvidenceDecodeOptionsV1({
    store: new DurableArtifactStore(resolve(input.stateDirectory, "artifacts")),
    record: input.record,
    baselineSha256: supplier.baseline.sha256,
    policy: supplier.policy,
    admission: observation.admission,
  });
  const workflow = getWorkflow("update-documentation");
  const decodeOptions = {
    ...editorial,
    decodeWorkflowBranchCoverage: (value: unknown, record: RunRecord) =>
      decodeWorkflowBranchCoverageV1(
        value,
        workflowBranchCoverageDecodeOptionsV1({
          workflow,
          record,
          requireComplete: record.status === "succeeded",
        }),
      ),
  };
  const record = structuredClone(input.record) as RunRecord;
  const outcome = projectRunEditorialOutcome(record, decodeOptions);
  const recordSha256 = canonicalDigest(record);
  const authority: HostEditorialOutcomeAuthorityV1 = Object.freeze({
    project(candidate: Readonly<Record<string, unknown>>) {
      if (canonicalDigest(candidate) !== recordSha256)
        throw new Error("Hosted editorial replay received a different run record.");
      return outcome;
    },
  });
  return Object.freeze({ outcome, authority });
}

/** Cold replay after a host has verified and restored a bound retention manifest. */
export async function replayRetainedEditorialWorkflowEvidenceV1(input: {
  stateDirectory: string;
  record: Readonly<RunRecord>;
  expected: {
    runtimeRecordSha256: string;
    repositoryRevision: string;
  };
}): Promise<RunEditorialOutcomeV1> {
  const record = structuredClone(input.record) as RunRecord;
  if (
    record.workflow !== "update-documentation" ||
    record.repository.revision !== input.expected.repositoryRevision ||
    canonicalDigest(record) !== input.expected.runtimeRecordSha256
  )
    throw new Error("Retained editorial replay differs from the expected record binding.");
  const verifiedQualityPack = await verifyQualityPackContext(resolveDocsFabRuntimeAssetPaths());
  const supplier = await createReaderTaskContextSupplier(verifiedQualityPack);
  const editorial = await loadEditorialEvidenceDecodeOptionsFromStoreV1({
    store: new DurableArtifactStore(resolve(input.stateDirectory, "artifacts")),
    record,
    baselineSha256: supplier.baseline.sha256,
    policy: supplier.policy,
  });
  const workflow = getWorkflow("update-documentation");
  return projectRunEditorialOutcome(record, {
    ...editorial,
    decodeWorkflowBranchCoverage: (value, candidateRecord) =>
      decodeWorkflowBranchCoverageV1(
        value,
        workflowBranchCoverageDecodeOptionsV1({
          workflow,
          record: candidateRecord,
          requireComplete: candidateRecord.status === "succeeded",
        }),
      ),
  });
}

type ReaderTaskContextSupplierV1 = Awaited<ReturnType<typeof createReaderTaskContextSupplier>>;

/**
 * Assemble the canonical reader and editorial evidence adapter from tracked bytes.
 * Both CLI and hosted execution call this path, so context-packet bytes and admission rules match.
 */
export async function assembleEditorialWorkflowEvidenceV1(input: {
  verifiedQualityPack: VerifiedQualityPackContext;
  repositoryPath: string;
  revision: string;
  artifactRoot: string;
  readerContextInput: ReaderContextInputV1;
  inputOrigin: ReaderTaskContextInputOrigin;
  requestText?: string;
  comparisonRequest?: ReaderComparisonRequestV1;
  sourceHints?: readonly ReaderSourceHintV1[];
  handoff?: ReaderTaskContextHandoffV1;
  contentIndex?: ContentIndexV1;
  observedAt?: string;
  admitNominations?: (nominations: readonly ReaderTaskContextNominationV1[]) => void;
  requireCompleteChangedSources?: boolean;
}): Promise<EditorialWorkflowEvidenceAssemblyV1> {
  const supplier = await createReaderTaskContextSupplier(input.verifiedQualityPack);
  const handoff = input.handoff ? supplier.validateHandoff(input.handoff) : undefined;
  const replay = handoff ? replayableHandoffSources(handoff) : undefined;
  const observation = await observeReaderTaskContextAdmissionV1({
    repositoryPath: input.repositoryPath,
    revision: input.revision,
    observationMode: "workflow-export",
    readerContextInput: input.readerContextInput,
    comparisonRequest: handoff
      ? comparisonRequestFromHandoff(handoff.comparison)
      : input.comparisonRequest,
    sourceHints: replay?.sourceHints ?? input.sourceHints,
    ...(input.admitNominations ? { admitNominations: input.admitNominations } : {}),
    ...(input.requireCompleteChangedSources ? { requireCompleteChangedSources: true } : {}),
    ...(handoff
      ? replay?.retainsRequest && input.requestText !== undefined
        ? { requestText: input.requestText }
        : {}
      : input.requestText === undefined
        ? {}
        : { requestText: input.requestText }),
  });
  if (handoff) supplier.validateHandoff(handoff, observation.admission);
  const effectiveHandoff =
    handoff ??
    supplier.createHandoff({
      readerContextInput: input.readerContextInput,
      admission: observation.admission,
      inputOrigin: input.inputOrigin,
      ...(observation.sourceBinding ? { sourceBinding: observation.sourceBinding } : {}),
    });
  supplier.validateHandoff(effectiveHandoff, observation.admission);
  const readerTaskContext = supplier.projectInput(input.readerContextInput, {
    inputOrigin: input.inputOrigin,
    handoff: effectiveHandoff,
  });
  const index =
    input.contentIndex ??
    (await buildContentIndex({
      repositoryPath: input.repositoryPath,
      repositoryRevision: input.revision,
    }));
  return assembleEditorialEvidenceFromAdmissionV1({
    artifactRoot: input.artifactRoot,
    index,
    readerTaskContext,
    observation,
    supplier,
    observedAt: input.observedAt,
  });
}

/** Complete evidence construction after a caller has already observed canonical admission. */
export async function assembleEditorialEvidenceFromAdmissionV1(input: {
  artifactRoot: string;
  index: ContentIndexV1;
  readerTaskContext: ReaderTaskContextInputProjectionV1;
  observation: ReaderTaskContextObservationV1;
  supplier: ReaderTaskContextSupplierV1;
  observedAt?: string;
}): Promise<EditorialWorkflowEvidenceAssemblyV1> {
  const contextArtifact = createReaderContextPacketArtifactV1(
    input.index,
    input.readerTaskContext.readerContextInput,
  );
  const workflowBranchEvidence = await createEditorialEvidenceHostV1({
    store: new DurableArtifactStore(input.artifactRoot),
    index: input.index,
    readerContextInput: input.readerTaskContext.readerContextInput,
    baselineSha256: input.readerTaskContext.baseline.sha256,
    policy: input.readerTaskContext.policy,
    comparison: input.observation.admission.comparison,
    repositoryIdentitySha256: input.observation.admission.repositoryIdentitySha256,
    workspaceSnapshotSha256: input.observation.admission.workspaceSnapshotSha256,
    observedAt: input.observedAt ?? new Date().toISOString(),
    provenanceLimitations: input.observation.admission.provenanceLimitations,
    sources: input.observation.sourceBytes,
    admittedArtifacts: [contextArtifact],
    // No run request field carries an audience protocol.
    audienceProtocol: "not-supplied",
    projectCompletedReaderTaskContext: ({ readerContext, provenance, admission }) =>
      input.supplier.projectCompleted({
        readerContext,
        provenance,
        admission,
        inputOrigin: input.readerTaskContext.inputOrigin,
      }),
  });
  return Object.freeze({
    readerTaskContext: input.readerTaskContext,
    observation: input.observation,
    editorialEvidenceRefs: Object.freeze([artifactReference(contextArtifact)]),
    workflowBranchEvidence,
  });
}

export function createReaderContextPacketArtifactV1(
  index: ContentIndexV1,
  readerContextInput: ReaderContextInputV1,
) {
  const requestedPaths = new Set(readerContextInput.change_scope);
  const node =
    index.nodes.find(
      (candidate) => candidate.kind === "document" && requestedPaths.has(candidate.sourcePath),
    ) ?? index.nodes.find((candidate) => candidate.kind === "document");
  if (!node) throw new Error("Reader task context requires one indexed documentation page.");
  return createArtifact(
    "context-packet",
    {
      targetNodeId: node.id,
      pageRole: {
        contentType: "reference",
        readerJob: "reader:documentation-update",
        organizingAxis: "reader-job",
      },
      ancestors: [],
      siblings: [],
      relatedCanonicalPages: [],
      placementRules: { belongsHere: ["reader:requested-documentation"], belongsElsewhere: [] },
      activeDecisionIds: [],
      structuralPressure: "healthy",
      evidence: [{ path: node.sourcePath, nodeId: node.id }],
    },
    { index },
  );
}

function artifactReference(
  artifact: ReturnType<typeof createReaderContextPacketArtifactV1>,
): ArtifactReference {
  return {
    kind: artifact.kind,
    schemaVersion: 1,
    digest: artifact.digest,
    repositoryRevision: artifact.repository.revision,
    repositoryContentDigest: artifact.repository.contentDigest,
  };
}

function replayableHandoffSources(handoff: ReaderTaskContextHandoffV1): {
  sourceHints: ReaderSourceHintV1[];
  retainsRequest: boolean;
} {
  const sourceHints: ReaderSourceHintV1[] = [];
  let retainsRequest = false;
  for (const source of handoff.sources) {
    if (source.uri === "request:instruction") {
      if (source.role !== "request" || retainsRequest)
        throw new Error("Reader task handoff contains invalid virtual request evidence.");
      retainsRequest = true;
      continue;
    }
    sourceHints.push({ role: source.role, path: source.uri });
  }
  return { sourceHints, retainsRequest };
}

function comparisonRequestFromHandoff(
  comparison: ReaderTaskContextHandoffV1["comparison"],
): ReaderComparisonRequestV1 | undefined {
  return comparison.kind === "base-head"
    ? {
        kind: "base-head",
        baseRevision: comparison.base_revision,
        headRevision: comparison.head_revision,
      }
    : comparison.kind === "workspace"
      ? { kind: "workspace" }
      : undefined;
}
