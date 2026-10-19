// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { canonicalDigest } from "../../content-ir/canonical.js";
import { validModelEvidenceProjection } from "../../model/profile-evidence.js";
import {
  array,
  digestValue,
  exactObject,
  fail,
  nonnegativeInteger,
  positiveInteger,
  revisionValue,
  safePath,
  stringArray,
  stringRecord,
  text,
  textRecord,
  timestamp,
  unique,
  unit,
} from "./primitives.js";
import { canonicalGrouping, destinationKey, sameDestination } from "./metrics.js";
import { CORPUS_CASE_KINDS, CORPUS_DISPOSITIONS, CORPUS_FAILURE_CLASSES } from "./constants.js";
import {
  parseLiveCampaignApproval,
  parseThresholdApproval,
  thresholdPolicyStatement,
  thresholdRegressed,
  thresholdRevisionDigest,
  validateCorpusLiveExecutionAuthorization,
} from "./approvals.js";
import type { IaPlanReviewerPolicy } from "../../ia/plan-review.js";
import type { ModelEvidence, TokenUsage } from "../../records/contracts.js";
import type { ContentIndexV1 } from "../../content-ir/contracts.js";
import type { InferenceEvidenceIdentity } from "../../records/contracts.js";
import type { IaPlanTaskInput } from "../../workflow-contracts/contracts.js";

import type {
  CorpusCase,
  CorpusCaseKind,
  CorpusDestination,
  CorpusDisposition,
  CorpusFailureClass,
  CorpusKnownAnswer,
  CorpusLiveCohortIdentity,
  CorpusLiveExecutionAuthorization,
  CorpusLiveRunEvidence,
  CorpusMetrics,
  CorpusObservationSet,
  CorpusRunObservation,
  CorpusProviderOutcome,
  CorpusSourceProvenance,
  CorpusSourceVisibility,
  CorpusThresholdPolicy,
  CorpusThresholds,
  LivingDocumentationDataset,
} from "../corpus.js";

export function parseLivingDocumentationDataset(value: unknown): LivingDocumentationDataset {
  const root = exactObject(
    value,
    ["schemaVersion", "id", "revision", "repositoryRevision", "thresholdPolicy", "cases"],
    "dataset",
  );
  if (root.schemaVersion !== 1) fail("dataset-schema");
  const id = text(root.id, "dataset-id");
  const revision = digestValue(root.revision, "dataset-revision");
  const repositoryRevision = digestValue(root.repositoryRevision, "dataset-repository-revision");
  const thresholdValue = exactObject(
    root.thresholdPolicy,
    ["id", "revision", "digest", "rootRevision", "rootDigest"],
    "dataset-threshold-policy",
  );
  const thresholdPolicy = {
    id: text(thresholdValue.id, "dataset-threshold-id"),
    revision: positiveInteger(thresholdValue.revision, "dataset-threshold-revision"),
    digest: digestValue(thresholdValue.digest, "dataset-threshold-digest"),
    rootRevision: thresholdValue.rootRevision,
    rootDigest: digestValue(thresholdValue.rootDigest, "dataset-threshold-root-digest"),
  };
  if (thresholdPolicy.rootRevision !== 1 || thresholdPolicy.revision < 1) {
    fail("dataset-threshold-policy");
  }
  if (!Array.isArray(root.cases) || root.cases.length !== CORPUS_CASE_KINDS.length)
    fail("case-count");
  const cases = root.cases.map((item, index) => parseCase(item, index));
  unique(
    cases.map((item) => item.id),
    "case-id",
  );
  for (const kind of CORPUS_CASE_KINDS) {
    if (cases.filter((item) => item.kind === kind).length !== 1) fail("case-kind-coverage");
  }
  for (const corpusCase of cases) {
    const contentDigest = corpusCaseContentDigest(corpusCase.sources);
    if (
      corpusCase.repository.contentDigest !== contentDigest ||
      corpusCase.repository.revision !== corpusCaseRevision(corpusCase.id, contentDigest)
    ) {
      fail("case-provenance");
    }
  }
  if (repositoryRevision !== corpusRepositoryRevision(cases)) fail("dataset-repository-provenance");
  const dataset = {
    schemaVersion: 1 as const,
    id,
    revision,
    repositoryRevision,
    thresholdPolicy: { ...thresholdPolicy, rootRevision: 1 as const },
    cases,
  };
  if (revision !== corpusDatasetRevision(dataset)) fail("dataset-content-revision");
  return dataset;
}

export function datasetDigest(dataset: LivingDocumentationDataset): string {
  return canonicalDigest(dataset);
}

export function corpusCaseContentDigest(sources: CorpusSourceProvenance[]): string {
  return createHash("sha256")
    .update(
      // Bytewise ordering, as Content IR uses; locale ordering would produce an
      // index binding no real repository can satisfy.
      [...sources]
        .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
        .map((source) => `${source.sha256}  ${source.path}\n`)
        .join(""),
    )
    .digest("hex");
}

export function corpusCaseRevision(id: string, contentDigest: string): string {
  return canonicalDigest({ kind: "synthetic-corpus-repository", id, contentDigest });
}

export function corpusRepositoryRevision(cases: CorpusCase[]): string {
  return canonicalDigest(
    cases.map((corpusCase) => ({
      id: corpusCase.id,
      revision: corpusCase.repository.revision,
      contentDigest: corpusCase.repository.contentDigest,
    })),
  );
}

export function corpusDatasetRevision(
  dataset: Omit<LivingDocumentationDataset, "revision"> | LivingDocumentationDataset,
): string {
  return canonicalDigest({
    schemaVersion: dataset.schemaVersion,
    id: dataset.id,
    repositoryRevision: dataset.repositoryRevision,
    thresholdPolicy: dataset.thresholdPolicy,
    cases: dataset.cases,
  });
}

export function parseCorpusThresholdPolicy(
  value: unknown,
  options: {
    reviewerPolicy?: IaPlanReviewerPolicy;
    now?: Date;
    /** Never trust the successor's embedded predecessor snapshot by itself. */
    trustedPredecessor?: CorpusThresholdPolicy;
  } = {},
): CorpusThresholdPolicy {
  const root = exactObject(
    value,
    [
      "schemaVersion",
      "id",
      "revision",
      "thresholds",
      "previous",
      "regressionReason",
      "approval",
      "digest",
    ],
    "threshold-policy",
    ["schemaVersion", "id", "revision", "thresholds", "digest"],
  );
  if (root.schemaVersion !== 1) fail("threshold-schema");
  const policy: CorpusThresholdPolicy = {
    schemaVersion: 1,
    id: text(root.id, "threshold-id"),
    revision: positiveInteger(root.revision, "threshold-revision"),
    thresholds: parseThresholds(root.thresholds),
    digest: digestValue(root.digest, "threshold-digest"),
  };
  if ((policy.revision === 1) !== (root.previous === undefined)) {
    fail("threshold-history-required");
  }
  if (root.previous !== undefined) {
    const previous = exactObject(
      root.previous,
      ["revision", "digest", "thresholds"],
      "threshold-previous",
    );
    policy.previous = {
      revision: positiveInteger(previous.revision, "threshold-previous-revision"),
      digest: digestValue(previous.digest, "threshold-previous-digest"),
      thresholds: parseThresholds(previous.thresholds),
    };
    const trusted = options.trustedPredecessor;
    if (
      !trusted ||
      trusted.id !== policy.id ||
      trusted.revision !== policy.revision - 1 ||
      policy.previous.revision !== trusted.revision ||
      policy.previous.digest !== trusted.digest ||
      canonicalDigest(policy.previous.thresholds) !== canonicalDigest(trusted.thresholds)
    ) {
      fail("threshold-predecessor");
    }
  }
  if (root.regressionReason !== undefined)
    policy.regressionReason = text(root.regressionReason, "regression-reason");
  const regressed = thresholdRegressed(policy.previous?.thresholds, policy.thresholds);
  if (regressed && !policy.regressionReason?.trim()) fail("unreasoned-threshold-regression");
  if (root.approval !== undefined) {
    policy.approval = parseThresholdApproval(root.approval, policy, options);
  }
  if (regressed && !policy.approval) fail("unapproved-threshold-regression");
  const expectedDigest = canonicalDigest(thresholdPolicyStatement(policy));
  if (policy.digest !== expectedDigest) fail("threshold-policy-digest");
  return policy;
}

export function liveCohortIdentities(
  planningCases: CorpusCase[],
  runs: CorpusRunObservation[],
): CorpusLiveCohortIdentity[] {
  return planningCases.map((corpusCase) => {
    const cohort = runs.filter((run) => run.caseId === corpusCase.id);
    const evidence = cohort[0]?.evidence;
    if (!evidence) fail("live-cohort-evidence");
    return {
      caseId: corpusCase.id,
      actualRepositoryRevision: evidence.actualRepositoryRevision,
      actualRepositoryContentDigest: evidence.actualRepositoryContentDigest,
      planningTaskDigest: evidence.planningTaskDigest,
      contextPacketDigest: evidence.contextPacketDigest,
      consultedNodeIdsDigest: canonicalDigest(evidence.consultedNodeIds),
      providerRunIds: cohort.map(
        (run) => run.evidence?.providerRunId ?? fail("live-cohort-evidence"),
      ),
    };
  });
}

export function assertLiveCohorts(planningCases: CorpusCase[], runs: CorpusRunObservation[]): void {
  for (const identity of liveCohortIdentities(planningCases, runs)) {
    const cohort = runs.filter((run) => run.caseId === identity.caseId);
    if (
      cohort.some(
        (run) =>
          !run.evidence ||
          run.evidence.actualRepositoryRevision !== identity.actualRepositoryRevision ||
          run.evidence.actualRepositoryContentDigest !== identity.actualRepositoryContentDigest ||
          run.evidence.planningTaskDigest !== identity.planningTaskDigest ||
          run.evidence.contextPacketDigest !== identity.contextPacketDigest ||
          canonicalDigest(run.evidence.consultedNodeIds) !== identity.consultedNodeIdsDigest,
      ) ||
      new Set(identity.providerRunIds).size !== identity.providerRunIds.length
    ) {
      fail("live-cohort-identity");
    }
  }
}

export function corpusRunResultDigest(run: Omit<CorpusRunObservation, "evidence">): string {
  return canonicalDigest({
    caseId: run.caseId,
    repositoryRevision: run.repositoryRevision,
    disposition: run.disposition,
    artifactValid: run.artifactValid,
    evidenceNodeIds: run.evidenceNodeIds,
    orphanNodeIds: run.orphanNodeIds,
    duplicateCanonicalHomes: run.duplicateCanonicalHomes,
    placements: run.placements,
    rankings: run.rankings,
    majorGroupings: run.majorGroupings,
  });
}

export function parseLiveRunEvidence(
  value: unknown,
  run: CorpusRunObservation,
): CorpusLiveRunEvidence {
  const root = exactObject(
    value,
    [
      "source",
      "planningRunRecordDigest",
      "providerRunRecordDigest",
      "contentIndexDigest",
      "ontologyArtifactDigest",
      "candidateArtifactDigest",
      "evaluationArtifactDigest",
      "planArtifactDigest",
      "navigationArtifactDigest",
      "actualRepositoryRevision",
      "resultDigest",
      "actualRepositoryContentDigest",
      "providerRunId",
      "planningTaskDigest",
      "contextPacketDigest",
      "consultedNodeIds",
    ],
    "live-run-evidence",
  );
  if (root.source !== "raw-record-artifact-chain") fail("live-run-evidence-source");
  const planningRunRecordDigest = digestValue(
    root.planningRunRecordDigest,
    "planning-run-record-digest",
  );
  const providerRunRecordDigest = digestValue(
    root.providerRunRecordDigest,
    "provider-run-record-digest",
  );
  const contentIndexDigest = digestValue(root.contentIndexDigest, "content-index-digest");
  const ontologyArtifactDigest = digestValue(
    root.ontologyArtifactDigest,
    "ontology-artifact-digest",
  );
  const candidateArtifactDigest = digestValue(
    root.candidateArtifactDigest,
    "candidate-artifact-digest",
  );
  const evaluationArtifactDigest = digestValue(
    root.evaluationArtifactDigest,
    "evaluation-artifact-digest",
  );
  const planArtifactDigest = digestValue(root.planArtifactDigest, "plan-artifact-digest");
  const navigationArtifactDigest = digestValue(
    root.navigationArtifactDigest,
    "navigation-artifact-digest",
  );
  const actualRepositoryRevision = revisionValue(
    root.actualRepositoryRevision,
    "actual-repository-revision",
  );
  const actualRepositoryContentDigest = digestValue(
    root.actualRepositoryContentDigest,
    "actual-repository-content-digest",
  );
  const providerRunId = text(root.providerRunId, "provider-run-id");
  const planningTaskDigest = digestValue(root.planningTaskDigest, "planning-task-digest");
  const contextPacketDigest = digestValue(root.contextPacketDigest, "context-packet-digest");
  const consultedNodeIds = stringArray(root.consultedNodeIds, "consulted-node-ids");
  if (consultedNodeIds.length === 0 || new Set(consultedNodeIds).size !== consultedNodeIds.length) {
    fail("consulted-node-ids");
  }
  const resultDigest = digestValue(root.resultDigest, "run-result-digest");
  if (
    resultDigest !== corpusRunResultDigest(run) ||
    run.provider.outcome !== "succeeded" ||
    run.provider.failureClass !== undefined ||
    !run.startedAt ||
    !run.completedAt ||
    !run.provider.model
  ) {
    fail("live-run-record-binding");
  }
  return {
    source: "raw-record-artifact-chain",
    planningRunRecordDigest,
    providerRunRecordDigest,
    contentIndexDigest,
    ontologyArtifactDigest,
    candidateArtifactDigest,
    evaluationArtifactDigest,
    planArtifactDigest,
    navigationArtifactDigest,
    actualRepositoryRevision,
    actualRepositoryContentDigest,
    providerRunId,
    planningTaskDigest,
    contextPacketDigest,
    consultedNodeIds,
    resultDigest,
  };
}

export function parseLiveExecutionAuthorization(
  value: unknown,
  dataset: LivingDocumentationDataset,
  runs: CorpusRunObservation[],
  options: {
    reviewerPolicy?: IaPlanReviewerPolicy;
    now?: Date;
    expectedTestedRevision?: string;
  },
): CorpusLiveExecutionAuthorization {
  const model = runs[0]!.provider.model!;
  const authorization = validateCorpusLiveExecutionAuthorization(value, dataset, {
    ...options,
    expectedModel: model,
  });
  const planningCases = dataset.cases.filter(
    (item) => item.planning && item.expectedDisposition === "recommendation-ready",
  );
  const expectedCohorts = liveCohortIdentities(planningCases, runs);
  if (canonicalDigest(authorization.cohorts) !== canonicalDigest(expectedCohorts)) {
    fail("live-execution-binding");
  }
  if (
    runs.some(
      (run) =>
        Date.parse(run.startedAt!) < Date.parse(authorization.approvedAt) ||
        Date.parse(run.startedAt!) >= Date.parse(authorization.expiresAt),
    )
  ) {
    fail("live-execution-window");
  }
  return authorization;
}

export function parseCase(value: unknown, index: number): CorpusCase {
  const root = exactObject(
    value,
    [
      "id",
      "kind",
      "planning",
      "repository",
      "sources",
      "publicNodeSources",
      "publicNodeLocations",
      "expectedDisposition",
      "requiredEvidenceNodeIds",
      "expectedMajorGroupings",
      "knownAnswers",
    ],
    `case-${index}`,
  );
  const repository = exactObject(root.repository, ["revision", "contentDigest"], "case-repository");
  if (!CORPUS_CASE_KINDS.includes(root.kind as CorpusCaseKind)) fail("case-kind");
  if (typeof root.planning !== "boolean") fail("case-planning");
  if (!Array.isArray(root.sources) || root.sources.length === 0) fail("case-sources");
  const sources = root.sources.map(parseSource);
  unique(
    sources.map((item) => item.path),
    "source-path",
  );
  unique(
    sources.map((item) => item.fixturePath),
    "source-fixture-path",
  );
  const nodeSources = stringRecord(root.publicNodeSources, "public-node-sources");
  for (const path of Object.values(nodeSources)) {
    if (!sources.some((source) => source.path === path && source.visibility === "public"))
      fail("public-node-source");
  }
  const locationRoot = exactObject(
    root.publicNodeLocations,
    Object.keys(nodeSources),
    "public-node-locations",
  );
  const publicNodeLocations = Object.fromEntries(
    Object.entries(locationRoot).map(([nodeId, value]) => {
      const location = exactObject(value, ["path", "anchor"], "public-node-location");
      const path = safePath(location.path, "public-node-location-path");
      const anchor =
        location.anchor === null ? null : text(location.anchor, "public-node-location-anchor");
      if (path !== nodeSources[nodeId]) fail("public-node-location-path");
      return [nodeId, { path, anchor }];
    }),
  );
  if (!CORPUS_DISPOSITIONS.includes(root.expectedDisposition as CorpusDisposition))
    fail("case-disposition");
  const requiredEvidenceNodeIds = stringArray(root.requiredEvidenceNodeIds, "required-evidence");
  if (requiredEvidenceNodeIds.some((nodeId) => !Object.hasOwn(nodeSources, nodeId)))
    fail("required-evidence-node");
  const expectedMajorGroupings = array(root.expectedMajorGroupings, "expected-major-groupings").map(
    (group) => stringArray(group, "expected-major-group"),
  );
  if (
    new Set(expectedMajorGroupings.flat()).size !== expectedMajorGroupings.flat().length ||
    expectedMajorGroupings.flat().some((nodeId) => !Object.hasOwn(nodeSources, nodeId)) ||
    (root.expectedDisposition === "recommendation-ready") !== expectedMajorGroupings.length > 0
  ) {
    fail("expected-major-groupings");
  }
  if (!Array.isArray(root.knownAnswers) || root.knownAnswers.length === 0) fail("known-answers");
  const knownAnswers = root.knownAnswers.map(parseKnownAnswer);
  unique(
    knownAnswers.map((item) => item.id),
    "answer-id",
  );
  return {
    id: text(root.id, "case-id"),
    kind: root.kind as CorpusCaseKind,
    planning: root.planning,
    repository: {
      revision: revisionValue(repository.revision, "case-revision"),
      contentDigest: digestValue(repository.contentDigest, "case-content-digest"),
    },
    sources,
    publicNodeSources: nodeSources,
    publicNodeLocations,
    expectedDisposition: root.expectedDisposition as CorpusDisposition,
    requiredEvidenceNodeIds,
    expectedMajorGroupings,
    knownAnswers,
  };
}

export function parseSource(value: unknown): CorpusSourceProvenance {
  const root = exactObject(value, ["path", "fixturePath", "sha256", "visibility"], "source");
  if (!["public", "private", "blocked", "excluded"].includes(root.visibility as string))
    fail("source-visibility");
  return {
    path: safePath(root.path, "source-path"),
    fixturePath: safePath(root.fixturePath, "source-fixture-path"),
    sha256: digestValue(root.sha256, "source-digest"),
    visibility: root.visibility as CorpusSourceVisibility,
  };
}

export function parseKnownAnswer(value: unknown): CorpusKnownAnswer {
  const root = exactObject(
    value,
    ["id", "kind", "query", "expected", "acceptableAlternatives", "negativeExpectations"],
    "known-answer",
  );
  if (!["lookup", "placement", "negative-control"].includes(root.kind as string))
    fail("answer-kind");
  const expected = destinationArray(root.expected, "answer-expected");
  const acceptableAlternatives = destinationArray(
    root.acceptableAlternatives,
    "answer-alternatives",
  );
  const negativeExpectations = destinationArray(root.negativeExpectations, "answer-negatives");
  if (
    root.kind === "negative-control" &&
    (expected.length > 0 || acceptableAlternatives.length > 0)
  )
    fail("negative-control-answer");
  if (root.kind !== "negative-control" && expected.length === 0) fail("missing-answer");
  unique(
    [...expected, ...acceptableAlternatives, ...negativeExpectations].map(destinationKey),
    "answer-destination",
  );
  return {
    id: text(root.id, "answer-id"),
    kind: root.kind as CorpusKnownAnswer["kind"],
    query: text(root.query, "answer-query"),
    expected,
    acceptableAlternatives,
    negativeExpectations,
  };
}

export function parseRun(
  value: unknown,
  index: number,
  mode: CorpusObservationSet["mode"],
): CorpusRunObservation {
  const root = exactObject(
    value,
    [
      "id",
      "caseId",
      "repositoryRevision",
      "startedAt",
      "completedAt",
      "disposition",
      "artifactValid",
      "evidenceNodeIds",
      "orphanNodeIds",
      "duplicateCanonicalHomes",
      "placements",
      "rankings",
      "majorGroupings",
      "dynamicLabels",
      "dynamicTools",
      "provider",
      "metrics",
      "evidence",
    ],
    `run-${index}`,
    [
      "id",
      "caseId",
      "repositoryRevision",
      "disposition",
      "artifactValid",
      "evidenceNodeIds",
      "orphanNodeIds",
      "duplicateCanonicalHomes",
      "placements",
      "rankings",
      "majorGroupings",
      "dynamicTools",
      "provider",
      "metrics",
    ],
  );
  if (!CORPUS_DISPOSITIONS.includes(root.disposition as CorpusDisposition)) fail("run-disposition");
  if (typeof root.artifactValid !== "boolean") fail("run-artifact-valid");
  const duplicateValues = array(root.duplicateCanonicalHomes, "duplicate-homes").map((item) => {
    const duplicate = exactObject(item, ["nodeId", "paths"], "duplicate-home");
    return {
      nodeId: text(duplicate.nodeId, "duplicate-node"),
      paths: stringArray(duplicate.paths, "duplicate-paths").map((path) =>
        safePath(path, "duplicate-path"),
      ),
    };
  });
  const placements = array(root.placements, "placements").map((item) => {
    const placement = exactObject(item, ["answerId", "destination"], "placement");
    return {
      answerId: text(placement.answerId, "placement-answer"),
      destination: placement.destination === null ? null : parseDestination(placement.destination),
    };
  });
  const rankings = array(root.rankings, "rankings").map((item) => {
    const ranking = exactObject(item, ["answerId", "destinations"], "ranking");
    return {
      answerId: text(ranking.answerId, "ranking-answer"),
      destinations: destinationArray(ranking.destinations, "ranking-destinations"),
    };
  });
  unique(
    placements.map((item) => item.answerId),
    "placement-answer",
  );
  unique(
    rankings.map((item) => item.answerId),
    "ranking-answer",
  );
  const groups = array(root.majorGroupings, "major-groupings").map((item) =>
    stringArray(item, "major-group"),
  );
  const provider = exactObject(root.provider, ["outcome", "failureClass", "model"], "provider", [
    "outcome",
  ]);
  if (!["succeeded", "controlled-stop", "failed"].includes(provider.outcome as string))
    fail("provider-outcome");
  if (
    provider.failureClass !== undefined &&
    !CORPUS_FAILURE_CLASSES.includes(provider.failureClass as CorpusFailureClass)
  )
    fail("failure-class");
  if (provider.outcome === "succeeded" && provider.failureClass !== undefined)
    fail("unexpected-failure-class");
  let model: CorpusRunObservation["provider"]["model"];
  if (provider.model !== undefined) {
    const identity = exactObject(
      provider.model,
      ["provider", "model", "profileSha256"],
      "provider-model",
    );
    model = {
      provider: text(identity.provider, "provider-id"),
      model: text(identity.model, "model-id"),
      profileSha256: digestValue(identity.profileSha256, "profile-sha256"),
    };
  }
  const metrics = exactObject(root.metrics, ["latencyMs", "usage"], "metrics");
  const usage = exactObject(
    metrics.usage,
    ["input", "output", "cacheRead", "cacheWrite", "total", "turns", "cost"],
    "usage",
    ["input", "output", "cacheRead", "cacheWrite", "total", "turns"],
  );
  const parsedUsage: TokenUsage = {
    input: nonnegativeInteger(usage.input, "usage-input"),
    output: nonnegativeInteger(usage.output, "usage-output"),
    cacheRead: nonnegativeInteger(usage.cacheRead, "usage-cache-read"),
    cacheWrite: nonnegativeInteger(usage.cacheWrite, "usage-cache-write"),
    total: nonnegativeInteger(usage.total, "usage-total"),
    turns: nonnegativeInteger(usage.turns, "usage-turns"),
  };
  if (
    parsedUsage.total !==
    parsedUsage.input + parsedUsage.output + parsedUsage.cacheRead + parsedUsage.cacheWrite
  )
    fail("usage-total");
  if (usage.cost !== undefined) {
    if (typeof usage.cost !== "number" || !Number.isFinite(usage.cost) || usage.cost < 0)
      fail("cost");
    parsedUsage.cost = usage.cost;
  }
  const startedAt =
    root.startedAt === undefined ? undefined : timestamp(root.startedAt, "run-started-at");
  const completedAt =
    root.completedAt === undefined ? undefined : timestamp(root.completedAt, "run-completed-at");
  const latencyMs = nonnegativeInteger(metrics.latencyMs, "latency");
  if (
    (startedAt === undefined) !== (completedAt === undefined) ||
    (startedAt !== undefined &&
      completedAt !== undefined &&
      Date.parse(completedAt) - Date.parse(startedAt) !== latencyMs)
  ) {
    fail("run-timestamps");
  }
  const parsed: CorpusRunObservation = {
    id: text(root.id, "run-id"),
    caseId: text(root.caseId, "run-case-id"),
    repositoryRevision: revisionValue(root.repositoryRevision, "run-revision"),
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(completedAt !== undefined ? { completedAt } : {}),
    disposition: root.disposition as CorpusDisposition,
    artifactValid: root.artifactValid,
    evidenceNodeIds: stringArray(root.evidenceNodeIds, "evidence-node-ids"),
    orphanNodeIds: stringArray(root.orphanNodeIds, "orphan-node-ids"),
    duplicateCanonicalHomes: duplicateValues,
    placements,
    rankings,
    majorGroupings: groups,
    ...(root.dynamicLabels !== undefined
      ? { dynamicLabels: textRecord(root.dynamicLabels, "dynamic-labels") }
      : {}),
    dynamicTools: stringArray(root.dynamicTools, "dynamic-tools"),
    provider: {
      outcome: provider.outcome as CorpusProviderOutcome,
      ...(provider.failureClass
        ? { failureClass: provider.failureClass as CorpusFailureClass }
        : {}),
      ...(model ? { model } : {}),
    },
    metrics: { latencyMs, usage: parsedUsage },
  };
  if (mode === "live") {
    parsed.evidence = parseLiveRunEvidence(root.evidence, parsed);
  } else if (root.evidence !== undefined) {
    fail("offline-live-evidence");
  }
  return parsed;
}

export function parseThresholds(value: unknown): CorpusThresholds {
  const keys = [
    "artifactValidityRate",
    "evidenceCoverage",
    "placementAgreement",
    "recallAt3",
    "meanReciprocalRank",
    "maximumNoResultRate",
    "maximumOrphans",
    "maximumDuplicateCanonicalHomes",
    "maximumProviderBlanks",
    "maximumUnclassifiedFailures",
  ] as const;
  const root = exactObject(value, [...keys], "thresholds");
  return {
    artifactValidityRate: unit(root.artifactValidityRate, "threshold-artifactValidityRate"),
    evidenceCoverage: unit(root.evidenceCoverage, "threshold-evidenceCoverage"),
    placementAgreement: unit(root.placementAgreement, "threshold-placementAgreement"),
    recallAt3: unit(root.recallAt3, "threshold-recallAt3"),
    meanReciprocalRank: unit(root.meanReciprocalRank, "threshold-meanReciprocalRank"),
    maximumNoResultRate: unit(root.maximumNoResultRate, "threshold-maximumNoResultRate"),
    maximumOrphans: nonnegativeInteger(root.maximumOrphans, "threshold-maximumOrphans"),
    maximumDuplicateCanonicalHomes: nonnegativeInteger(
      root.maximumDuplicateCanonicalHomes,
      "threshold-maximumDuplicateCanonicalHomes",
    ),
    maximumProviderBlanks: nonnegativeInteger(
      root.maximumProviderBlanks,
      "threshold-maximumProviderBlanks",
    ),
    maximumUnclassifiedFailures: nonnegativeInteger(
      root.maximumUnclassifiedFailures,
      "threshold-maximumUnclassifiedFailures",
    ),
  };
}

export function parseDestination(value: unknown): CorpusDestination {
  const root = exactObject(value, ["nodeId", "path", "url", "anchor"], "destination");
  const url = text(root.url, "destination-url");
  if (!url.startsWith("/") || url.includes("#") || url.includes("\\")) fail("destination-url");
  if (
    root.anchor !== null &&
    (typeof root.anchor !== "string" || !root.anchor || root.anchor.startsWith("#"))
  )
    fail("destination-anchor");
  return {
    nodeId: text(root.nodeId, "destination-node"),
    path: safePath(root.path, "destination-path"),
    url,
    anchor: root.anchor as string | null,
  };
}

export function parseTokenUsage(value: unknown, code: string): TokenUsage {
  const root = exactObject(
    value,
    ["input", "output", "cacheRead", "cacheWrite", "total", "turns", "cost"],
    code,
    ["input", "output", "cacheRead", "cacheWrite", "total", "turns"],
  );
  const usage: TokenUsage = {
    input: nonnegativeInteger(root.input, `${code}-input`),
    output: nonnegativeInteger(root.output, `${code}-output`),
    cacheRead: nonnegativeInteger(root.cacheRead, `${code}-cache-read`),
    cacheWrite: nonnegativeInteger(root.cacheWrite, `${code}-cache-write`),
    total: nonnegativeInteger(root.total, `${code}-total`),
    turns: nonnegativeInteger(root.turns, `${code}-turns`),
  };
  if (usage.total !== usage.input + usage.output + usage.cacheRead + usage.cacheWrite) {
    fail(`${code}-total`);
  }
  if (root.cost !== undefined) {
    if (typeof root.cost !== "number" || !Number.isFinite(root.cost) || root.cost < 0) {
      fail(`${code}-cost`);
    }
    usage.cost = root.cost;
  }
  return usage;
}

export function destinationArray(value: unknown, code: string): CorpusDestination[] {
  return array(value, code).map(parseDestination);
}
