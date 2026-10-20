// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { canonicalDigest } from "../content-ir/canonical.js";
import {
  CORPUS_CASE_KINDS,
  CORPUS_DISPOSITIONS,
  CORPUS_FAILURE_CLASSES,
} from "./corpus/constants.js";
export {
  CORPUS_CASE_KINDS,
  CORPUS_DISPOSITIONS,
  CORPUS_FAILURE_CLASSES,
} from "./corpus/constants.js";
import {
  assertLiveCohorts,
  parseLiveExecutionAuthorization,
  parseRun,
  parseLivingDocumentationDataset,
  datasetDigest,
  corpusCaseContentDigest,
  corpusCaseRevision,
  corpusRepositoryRevision,
  corpusDatasetRevision,
  parseCorpusThresholdPolicy,
  corpusRunResultDigest,
} from "./corpus/codecs.js";
export {
  parseLivingDocumentationDataset,
  datasetDigest,
  corpusCaseContentDigest,
  corpusCaseRevision,
  corpusRepositoryRevision,
  corpusDatasetRevision,
  parseCorpusThresholdPolicy,
  corpusRunResultDigest,
} from "./corpus/codecs.js";
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
} from "./corpus/primitives.js";
import { CorpusValidationError } from "./corpus/errors.js";
export { CorpusValidationError } from "./corpus/errors.js";
import type { CorpusSignedApprovalCore } from "./corpus/approvals.js";
import {
  parseLiveCampaignApproval,
  validateCorpusLiveExecutionAuthorization,
} from "./corpus/approvals.js";
export {
  corpusThresholdPolicyDigest,
  createCorpusLiveExecutionAuthorization,
  createCorpusLiveExecutionAuthorizer,
  createCorpusThresholdApproval,
  thresholdRevisionDigest,
  validateCorpusLiveExecutionAuthorization,
} from "./corpus/approvals.js";
import { detectCredentialRuleIds } from "../security/repository-scanner.js";
import type { IaPlanTaskInput } from "../workflow-contracts/contracts.js";
import type {
  InferenceEvidenceIdentity,
  InferenceFailureCategory,
  ModelEvidence,
  TokenUsage,
} from "../records/contracts.js";
import type { ContentIndexV1 } from "../content-ir/contracts.js";
import { validateIaPlanReviewerPolicy, type IaPlanReviewerPolicy } from "../ia/plan-review.js";
import { validModelEvidenceProjection } from "../model/profile-evidence.js";
import type { EvaluationRubric, JudgeModelIdentity } from "./contracts.js";
import { consumeDerivedCorpusLiveRun, isDerivedCorpusLiveRun } from "./corpus-live.js";
import {
  canonicalGrouping,
  destinationKey,
  computeMetrics,
  evaluateFiveRunReliability,
  sameDestination,
} from "./corpus/metrics.js";
import {
  DOCSFAB_LIVING_DOCUMENTATION_QUALITY_ID_V1,
  DOCSFAB_LIVING_DOCUMENTATION_QUALITY_VERSION,
} from "./rubric-identifiers.js";

export type CorpusCaseKind = (typeof CORPUS_CASE_KINDS)[number];

export type CorpusDisposition = (typeof CORPUS_DISPOSITIONS)[number];

export type CorpusSourceVisibility = "public" | "private" | "blocked" | "excluded";

export interface CorpusSourceProvenance {
  /** Repository-relative path inside the synthetic source revision. */
  path: string;
  /** Project-relative location of the immutable fixture bytes. */
  fixturePath: string;
  sha256: string;
  visibility: CorpusSourceVisibility;
}

export interface CorpusDestination {
  nodeId: string;
  path: string;
  url: string;
  anchor: string | null;
}

export interface CorpusKnownAnswer {
  id: string;
  kind: "lookup" | "placement" | "negative-control";
  query: string;
  expected: CorpusDestination[];
  acceptableAlternatives: CorpusDestination[];
  negativeExpectations: CorpusDestination[];
}

export interface CorpusCase {
  id: string;
  kind: CorpusCaseKind;
  planning: boolean;
  repository: { revision: string; contentDigest: string };
  sources: CorpusSourceProvenance[];
  publicNodeSources: Record<string, string>;
  /** Complete scored-node location catalog, including nodes with no query. */
  publicNodeLocations: Record<string, { path: string; anchor: string | null }>;
  expectedDisposition: CorpusDisposition;
  requiredEvidenceNodeIds: string[];
  /** Versioned semantic topology oracle, hidden from fake providers. */
  expectedMajorGroupings: string[][];
  knownAnswers: CorpusKnownAnswer[];
}

export interface CorpusThresholds {
  artifactValidityRate: number;
  evidenceCoverage: number;
  placementAgreement: number;
  recallAt3: number;
  meanReciprocalRank: number;
  maximumNoResultRate: number;
  maximumOrphans: number;
  maximumDuplicateCanonicalHomes: number;
  maximumProviderBlanks: number;
  maximumUnclassifiedFailures: number;
}

export interface CorpusThresholdPolicy {
  schemaVersion: 1;
  id: string;
  revision: number;
  thresholds: CorpusThresholds;
  /** Full digest and exact thresholds of a separately loaded trusted predecessor. */
  previous?: { revision: number; digest: string; thresholds: CorpusThresholds };
  regressionReason?: string;
  approval?: CorpusThresholdApproval;
  digest: string;
}

export interface LivingDocumentationDataset {
  schemaVersion: 1;
  id: string;
  /** Content-addressed revision; any case/source/answer change requires a new value. */
  revision: string;
  repositoryRevision: string;
  /** Immutable quality-policy anchor; arbitrary CLI policy chains are rejected. */
  thresholdPolicy: {
    id: string;
    revision: number;
    digest: string;
    rootRevision: 1;
    rootDigest: string;
  };
  cases: CorpusCase[];
}

export type CorpusProviderOutcome = "succeeded" | "controlled-stop" | "failed";
export type CorpusFailureClass =
  | InferenceFailureCategory
  | "evidence-insufficient"
  | "stale-plan"
  | "scaffold-collision"
  | "duplication-prevented";

export interface CorpusRunObservation {
  id: string;
  caseId: string;
  repositoryRevision: string;
  startedAt?: string;
  completedAt?: string;
  disposition: CorpusDisposition;
  artifactValid: boolean;
  evidenceNodeIds: string[];
  orphanNodeIds: string[];
  duplicateCanonicalHomes: Array<{ nodeId: string; paths: string[] }>;
  placements: Array<{ answerId: string; destination: CorpusDestination | null }>;
  rankings: Array<{ answerId: string; destinations: CorpusDestination[] }>;
  majorGroupings: string[][];
  /** Presentation-only labels are deliberately excluded from topology comparison. */
  dynamicLabels?: Record<string, string>;
  dynamicTools: string[];
  provider: {
    outcome: CorpusProviderOutcome;
    failureClass?: CorpusFailureClass;
    model?: { provider: string; model: string; profileSha256: string };
  };
  metrics: {
    latencyMs: number;
    usage: TokenUsage;
  };
  /** Required for live observations and forbidden for deterministic fake observations. */
  evidence?: CorpusLiveRunEvidence;
}

export interface CorpusLiveRunEvidence {
  source: "raw-record-artifact-chain";
  planningRunRecordDigest: string;
  providerRunRecordDigest: string;
  contentIndexDigest: string;
  ontologyArtifactDigest: string;
  candidateArtifactDigest: string;
  evaluationArtifactDigest: string;
  planArtifactDigest: string;
  navigationArtifactDigest: string;
  actualRepositoryRevision: string;
  actualRepositoryContentDigest: string;
  providerRunId: string;
  planningTaskDigest: string;
  contextPacketDigest: string;
  consultedNodeIds: string[];
  resultDigest: string;
}

export interface CorpusLiveCohortIdentity {
  caseId: string;
  actualRepositoryRevision: string;
  actualRepositoryContentDigest: string;
  planningTaskDigest: string;
  contextPacketDigest: string;
  consultedNodeIdsDigest: string;
  providerRunIds: string[];
}

export interface CorpusLiveCampaignApproval extends CorpusSignedApprovalCore {
  kind: "corpus-live-evidence-approval";
  dataset: { id: string; revision: string; digest: string };
  testedRevision: string;
  scope: "read-only-ia-planning";
  runEvidenceDigests: string[];
}

export interface CorpusLiveExecutionAuthorization extends CorpusSignedApprovalCore {
  kind: "corpus-live-execution-authorization";
  dataset: { id: string; revision: string; digest: string };
  testedRevision: string;
  scope: "read-only-ia-planning";
  model: { provider: string; model: string; profileSha256: string };
  cohorts: CorpusLiveCohortIdentity[];
}

export interface CorpusThresholdApproval extends CorpusSignedApprovalCore {
  kind: "corpus-threshold-regression-approval";
  thresholdPolicy: {
    id: string;
    revision: number;
    predecessorDigest: string;
    thresholdsDigest: string;
    regressionReason: string;
  };
}

export interface CorpusObservationSet {
  schemaVersion: 1;
  dataset: { id: string; revision: string; digest: string };
  mode: "offline-fake" | "live";
  runs: CorpusRunObservation[];
  executionAuthorization?: CorpusLiveExecutionAuthorization;
  authorization?: CorpusLiveCampaignApproval;
}

export interface CorpusMetrics {
  artifactValidityRate: number;
  evidenceCoverage: number;
  orphanCount: number;
  duplicateCanonicalHomeCount: number;
  placementAgreement: number;
  recallAt3: number;
  meanReciprocalRank: number;
  noResultRate: number;
  providerBlanks: number;
  unclassifiedFailures: number;
  latencyMs: { minimum: number; median: number; maximum: number };
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
    turns: number;
  };
  costUsd: number | null;
}

export type CorpusGateName =
  | "artifact-validity"
  | "evidence-coverage"
  | "orphans"
  | "duplicate-canonical-homes"
  | "placement-agreement"
  | "recall-at-3"
  | "mean-reciprocal-rank"
  | "no-result-rate"
  | "provider-blanks"
  | "classified-failures"
  | "expected-dispositions"
  | "public-answer-safety"
  | "expected-major-groupings"
  | "five-run-reliability";

export interface CorpusGateResult {
  gate: CorpusGateName;
  passed: boolean;
  message: "passed" | "failed";
}

export interface CorpusDeterministicEvaluation {
  schemaVersion: 1;
  dataset: { id: string; revision: string; digest: string };
  thresholdPolicy: { id: string; revision: number; digest: string };
  observationMode: CorpusObservationSet["mode"];
  runCount: number;
  metrics: CorpusMetrics;
  gates: CorpusGateResult[];
  passed: boolean;
  digest: string;
}

export interface CorpusJudgeRequest {
  schemaVersion: 1;
  rubric: EvaluationRubric;
  datasetDigest: string;
  evaluationDigest: string;
  metrics: CorpusMetrics;
  gateResults: Array<{ gate: CorpusGateName; passed: boolean }>;
}

export interface CorpusJudge {
  identity: JudgeModelIdentity;
  evaluate(request: CorpusJudgeRequest): Promise<{ agrees: boolean }>;
}

export const CORPUS_SEMANTIC_RUBRIC: EvaluationRubric = {
  id: DOCSFAB_LIVING_DOCUMENTATION_QUALITY_ID_V1,
  version: DOCSFAB_LIVING_DOCUMENTATION_QUALITY_VERSION,
  criteria: [
    "Major groupings remain useful across the versioned reader and agent tasks.",
    "Known-answer placement and retrieval results are consistent with the deterministic evidence.",
    "No semantic claim exceeds the supplied content-minimized metrics and gate dispositions.",
  ],
};

export type CorpusJudgeDisposition =
  | {
      status: "not-run";
      reason: "deterministic-failed" | "not-configured";
      rubric: { id: string; version: number };
    }
  | {
      status: "agreed" | "disagreed" | "failed";
      rubric: { id: string; version: number };
      model: JudgeModelIdentity;
    };

export function parseCorpusObservationSet(
  value: unknown,
  dataset: LivingDocumentationDataset,
  options: {
    reviewerPolicy?: IaPlanReviewerPolicy;
    now?: Date;
    expectedTestedRevision?: string;
  } = {},
): CorpusObservationSet {
  const root = exactObject(
    value,
    ["schemaVersion", "dataset", "mode", "runs", "executionAuthorization", "authorization"],
    "observations",
    ["schemaVersion", "dataset", "mode", "runs"],
  );
  if (root.schemaVersion !== 1) fail("observation-schema");
  const binding = exactObject(root.dataset, ["id", "revision", "digest"], "observation-dataset");
  const expectedDigest = datasetDigest(dataset);
  if (
    binding.id !== dataset.id ||
    binding.revision !== dataset.revision ||
    binding.digest !== expectedDigest
  )
    fail("dataset-binding");
  if (root.mode !== "offline-fake" && root.mode !== "live") fail("observation-mode");
  if (!Array.isArray(root.runs) || root.runs.length === 0) fail("observation-runs");
  if (root.mode === "live" && root.runs.some((run) => !isDerivedCorpusLiveRun(run))) {
    fail("live-raw-evidence-required");
  }
  const runs = root.runs.map((item, index) =>
    parseRun(item, index, root.mode as CorpusObservationSet["mode"]),
  );
  unique(
    runs.map((item) => item.id),
    "run-id",
  );
  for (const run of runs) {
    const corpusCase = dataset.cases.find((item) => item.id === run.caseId);
    if (!corpusCase || run.repositoryRevision !== corpusCase.repository.revision)
      fail("run-case-binding");
    if (
      run.evidence &&
      run.evidence.actualRepositoryContentDigest !== corpusCase.repository.contentDigest
    ) {
      fail("live-run-content-binding");
    }
    const expectedAnswerIds = corpusCase.knownAnswers.map((answer) => answer.id).sort();
    if (
      run.placements
        .map((item) => item.answerId)
        .sort()
        .join("\n") !== expectedAnswerIds.join("\n") ||
      run.rankings
        .map((item) => item.answerId)
        .sort()
        .join("\n") !== expectedAnswerIds.join("\n")
    ) {
      fail("run-answer-coverage");
    }
    const publicNodeIds = new Set(Object.keys(corpusCase.publicNodeSources));
    const grouped = run.majorGroupings.flat();
    if (
      grouped.some((nodeId) => !publicNodeIds.has(nodeId)) ||
      new Set(grouped).size !== grouped.length
    ) {
      fail("run-major-groupings");
    }
  }
  const result: CorpusObservationSet = {
    schemaVersion: 1,
    dataset: { id: dataset.id, revision: dataset.revision, digest: expectedDigest },
    mode: root.mode,
    runs,
  };
  if (root.mode === "live") {
    const planningCases = dataset.cases.filter(
      (item) => item.planning && item.expectedDisposition === "recommendation-ready",
    );
    if (
      runs.length !== planningCases.length * 5 ||
      planningCases.some((item) => runs.filter((run) => run.caseId === item.id).length !== 5) ||
      runs.some((run) => !planningCases.some((item) => item.id === run.caseId))
    ) {
      fail("live-run-coverage");
    }
    const modelIdentities = new Set(
      runs.map((run) =>
        run.provider.model
          ? `${run.provider.model.provider}\0${run.provider.model.model}\0${run.provider.model.profileSha256}`
          : "missing",
      ),
    );
    if (modelIdentities.size !== 1 || modelIdentities.has("missing")) fail("live-model-profile");
    assertLiveCohorts(planningCases, runs);
    const started = runs.map((run) => run.startedAt);
    if (
      started.some((value) => value === undefined) ||
      new Set(started).size !== runs.length ||
      runs.some(
        (run) =>
          !run.completedAt ||
          Date.parse(run.completedAt) - Date.parse(run.startedAt!) !== run.metrics.latencyMs,
      )
    ) {
      fail("live-run-independence");
    }
    result.authorization = parseLiveCampaignApproval(root.authorization, dataset, runs, options);
    result.executionAuthorization = parseLiveExecutionAuthorization(
      root.executionAuthorization,
      dataset,
      runs,
      options,
    );
    for (const run of root.runs) consumeDerivedCorpusLiveRun(run as object);
  } else {
    if (root.authorization !== undefined || root.executionAuthorization !== undefined) {
      fail("unexpected-authorization");
    }
    if (
      runs.length !== dataset.cases.length ||
      dataset.cases.some((item) => runs.filter((run) => run.caseId === item.id).length !== 1)
    ) {
      fail("offline-run-coverage");
    }
  }
  return result;
}

export interface CorpusFakeProvider {
  readonly id: "deterministic-fake";
  run(input: CorpusFakeProviderInput, index: number): Promise<CorpusFakeProviderResult>;
}

/** Deliberately excludes dispositions, known answers, and quality expectations. */
export interface CorpusFakeProviderInput {
  caseId: string;
  planning: boolean;
  repository: { revision: string; contentDigest: string };
  publicNodeIds: string[];
}

export interface CorpusFakeCandidateV1 {
  schemaVersion: 1;
  kind: "docsfab-corpus-fake-candidate";
  caseId: string;
  repository: { revision: string; contentDigest: string };
  disposition: CorpusDisposition;
  evidenceNodeIds: string[];
  orphanNodeIds: string[];
  canonicalHomes: Array<{ nodeId: string; paths: string[] }>;
  placements: Array<{ answerId: string; nodeId: string | null }>;
  rankings: Array<{ answerId: string; nodeIds: string[] }>;
  majorGroupings: string[][];
  digest: string;
}

export interface CorpusFakeProviderResult {
  id: string;
  artifact: unknown;
  dynamicTools: string[];
  provider: CorpusRunObservation["provider"];
  metrics: CorpusRunObservation["metrics"];
}

export interface CorpusFakeCandidateFixture {
  caseId: string;
  artifact: CorpusFakeCandidateV1;
  providerOutcome: CorpusProviderOutcome;
  failureClass?: CorpusFailureClass;
}

export interface CorpusFakeCandidateSet {
  schemaVersion: 1;
  dataset: { id: string; revision: string; digest: string };
  cases: CorpusFakeCandidateFixture[];
}

export function parseCorpusFakeCandidateSet(
  value: unknown,
  dataset: LivingDocumentationDataset,
): CorpusFakeCandidateSet {
  const root = exactObject(value, ["schemaVersion", "dataset", "cases"], "fake-candidate-set");
  if (root.schemaVersion !== 1) fail("fake-candidate-set");
  const binding = exactObject(root.dataset, ["id", "revision", "digest"], "fake-candidate-dataset");
  if (
    binding.id !== dataset.id ||
    binding.revision !== dataset.revision ||
    binding.digest !== datasetDigest(dataset)
  )
    fail("fake-candidate-dataset");
  const cases = array(root.cases, "fake-candidate-cases").map((value) => {
    const item = exactObject(
      value,
      [
        "caseId",
        "disposition",
        "evidenceNodeIds",
        "orphanNodeIds",
        "canonicalHomes",
        "placements",
        "rankings",
        "majorGroupings",
        "providerOutcome",
        "failureClass",
      ],
      "fake-candidate-case",
      [
        "caseId",
        "disposition",
        "evidenceNodeIds",
        "orphanNodeIds",
        "canonicalHomes",
        "placements",
        "rankings",
        "majorGroupings",
        "providerOutcome",
      ],
    );
    const caseId = text(item.caseId, "fake-candidate-case-id");
    const corpusCase = dataset.cases.find((candidate) => candidate.id === caseId);
    if (
      !corpusCase ||
      !["succeeded", "controlled-stop", "failed"].includes(item.providerOutcome as string)
    ) {
      fail("fake-candidate-case");
    }
    const withoutDigest = {
      schemaVersion: 1 as const,
      kind: "docsfab-corpus-fake-candidate" as const,
      caseId,
      repository: { ...corpusCase.repository },
      disposition: item.disposition,
      evidenceNodeIds: item.evidenceNodeIds,
      orphanNodeIds: item.orphanNodeIds,
      canonicalHomes: item.canonicalHomes,
      placements: item.placements,
      rankings: item.rankings,
      majorGroupings: item.majorGroupings,
    };
    const artifact = parseFakeCandidate(
      {
        ...withoutDigest,
        digest: corpusFakeCandidateDigest(withoutDigest as Omit<CorpusFakeCandidateV1, "digest">),
      },
      corpusCase,
    );
    const failureClass =
      item.failureClass === undefined ? undefined : fakeFailureClassValue(item.failureClass);
    if (
      (item.providerOutcome === "succeeded") === (failureClass !== undefined) ||
      (item.providerOutcome === "controlled-stop" &&
        failureClass !== fakeFailureClass(artifact.disposition))
    ) {
      fail("fake-candidate-provider");
    }
    return {
      caseId,
      artifact,
      providerOutcome: item.providerOutcome as CorpusProviderOutcome,
      ...(failureClass ? { failureClass } : {}),
    };
  });
  unique(
    cases.map((item) => item.caseId),
    "fake-candidate-case-id",
  );
  if (
    cases.length !== dataset.cases.length ||
    dataset.cases.some((corpusCase) => !cases.some((item) => item.caseId === corpusCase.id))
  ) {
    fail("fake-candidate-case-coverage");
  }
  return {
    schemaVersion: 1,
    dataset: { id: dataset.id, revision: dataset.revision, digest: datasetDigest(dataset) },
    cases,
  };
}

export function corpusFakeCandidateDigest(
  value: Omit<CorpusFakeCandidateV1, "digest"> | CorpusFakeCandidateV1,
): string {
  const { digest: _digest, ...digestible } = value as CorpusFakeCandidateV1;
  return canonicalDigest(digestible);
}

/** A scripted fake model emits node identities only; the evaluator derives destinations. */
export function createDeterministicFakeCandidate(
  input: CorpusFakeProviderInput,
  index: number,
  artifact: unknown,
  outcome: {
    providerOutcome?: CorpusProviderOutcome;
    failureClass?: CorpusFailureClass;
  } = {},
): CorpusFakeProviderResult {
  const failureClass = outcome.failureClass;
  const providerOutcome = outcome.providerOutcome ?? (failureClass ? "failed" : "succeeded");
  const succeeded = providerOutcome === "succeeded";
  const inputTokens = succeeded ? 100 + index * 10 : 50 + index;
  const output = succeeded ? 20 + index : 0;
  return {
    id: `offline-${input.caseId}`,
    artifact: structuredClone(artifact),
    dynamicTools: input.planning ? [index % 2 === 0 ? "read" : "find"] : [],
    provider: {
      outcome: providerOutcome,
      ...(failureClass ? { failureClass } : {}),
      model: {
        provider: "fake",
        model: "deterministic",
        profileSha256: "f".repeat(64),
      },
    },
    metrics: {
      latencyMs: 5 + index,
      usage: {
        input: inputTokens,
        output,
        cacheRead: 0,
        cacheWrite: 0,
        total: inputTokens + output,
        turns: succeeded ? 1 : 0,
        cost: 0,
      },
    },
  };
}

/** Exercise the complete offline provider seam; static observation cloning is not a campaign. */
export async function runOfflineFakeCorpus(
  dataset: LivingDocumentationDataset,
  provider: CorpusFakeProvider,
): Promise<CorpusObservationSet> {
  if (provider.id !== "deterministic-fake") fail("offline-provider");
  const runs: CorpusRunObservation[] = [];
  for (let index = 0; index < dataset.cases.length; index += 1) {
    const corpusCase = dataset.cases[index]!;
    const result = await provider.run(
      {
        caseId: corpusCase.id,
        planning: corpusCase.planning,
        repository: { ...corpusCase.repository },
        publicNodeIds: Object.keys(corpusCase.publicNodeSources),
      },
      index,
    );
    runs.push(deriveFakeObservation(corpusCase, result));
  }
  return parseCorpusObservationSet(
    {
      schemaVersion: 1,
      dataset: { id: dataset.id, revision: dataset.revision, digest: datasetDigest(dataset) },
      mode: "offline-fake",
      runs,
    },
    dataset,
  );
}

function deriveFakeObservation(
  corpusCase: CorpusCase,
  result: CorpusFakeProviderResult,
): CorpusRunObservation {
  let candidate: CorpusFakeCandidateV1;
  try {
    candidate = parseFakeCandidate(result.artifact, corpusCase);
  } catch (error) {
    if (!(error instanceof CorpusValidationError)) throw error;
    return invalidFakeObservation(corpusCase, result);
  }
  const destinationsByNode = new Map<string, CorpusDestination>();
  for (const answer of corpusCase.knownAnswers) {
    for (const destination of [...answer.expected, ...answer.acceptableAlternatives]) {
      const existing = destinationsByNode.get(destination.nodeId);
      if (existing && !sameDestination(existing, destination))
        fail("fake-candidate-ambiguous-destination");
      destinationsByNode.set(destination.nodeId, destination);
    }
  }
  const destination = (nodeId: string | null): CorpusDestination | null => {
    if (nodeId === null) return null;
    const value = destinationsByNode.get(nodeId);
    if (!value || !publicDestination(corpusCase, value)) fail("fake-candidate-destination");
    return structuredClone(value);
  };
  const duplicateCanonicalHomes = candidate.canonicalHomes.flatMap((home) =>
    home.paths.length > 1 ? [{ nodeId: home.nodeId, paths: [...home.paths] }] : [],
  );
  return {
    id: text(result.id, "fake-run-id"),
    caseId: corpusCase.id,
    repositoryRevision: corpusCase.repository.revision,
    disposition: candidate.disposition,
    artifactValid: true,
    evidenceNodeIds: [...candidate.evidenceNodeIds],
    orphanNodeIds: [...candidate.orphanNodeIds],
    duplicateCanonicalHomes,
    placements: candidate.placements.map((item) => ({
      answerId: item.answerId,
      destination: destination(item.nodeId),
    })),
    rankings: candidate.rankings.map((item) => ({
      answerId: item.answerId,
      destinations: item.nodeIds.map((nodeId) => destination(nodeId)!),
    })),
    majorGroupings: candidate.majorGroupings.map((group) => [...group]),
    dynamicTools: [...result.dynamicTools],
    provider: structuredClone(result.provider),
    metrics: structuredClone(result.metrics),
  };
}

function invalidFakeObservation(
  corpusCase: CorpusCase,
  result: CorpusFakeProviderResult,
): CorpusRunObservation {
  return {
    id: text(result.id, "fake-run-id"),
    caseId: corpusCase.id,
    repositoryRevision: corpusCase.repository.revision,
    disposition: corpusCase.expectedDisposition,
    artifactValid: false,
    evidenceNodeIds: [],
    orphanNodeIds: [],
    duplicateCanonicalHomes: [],
    placements: corpusCase.knownAnswers.map((answer) => ({
      answerId: answer.id,
      destination: null,
    })),
    rankings: corpusCase.knownAnswers.map((answer) => ({
      answerId: answer.id,
      destinations: [],
    })),
    majorGroupings: [],
    dynamicTools: [...result.dynamicTools],
    provider: structuredClone(result.provider),
    metrics: structuredClone(result.metrics),
  };
}

function parseFakeCandidate(value: unknown, corpusCase: CorpusCase): CorpusFakeCandidateV1 {
  const root = exactObject(
    value,
    [
      "schemaVersion",
      "kind",
      "caseId",
      "repository",
      "disposition",
      "evidenceNodeIds",
      "orphanNodeIds",
      "canonicalHomes",
      "placements",
      "rankings",
      "majorGroupings",
      "digest",
    ],
    "fake-candidate",
  );
  if (
    root.schemaVersion !== 1 ||
    root.kind !== "docsfab-corpus-fake-candidate" ||
    root.caseId !== corpusCase.id ||
    !CORPUS_DISPOSITIONS.includes(root.disposition as CorpusDisposition)
  ) {
    fail("fake-candidate");
  }
  const repository = exactObject(
    root.repository,
    ["revision", "contentDigest"],
    "fake-candidate-repository",
  );
  if (
    repository.revision !== corpusCase.repository.revision ||
    repository.contentDigest !== corpusCase.repository.contentDigest
  )
    fail("fake-candidate-repository");
  const publicNodes = new Set(Object.keys(corpusCase.publicNodeSources));
  const canonicalHomes = array(root.canonicalHomes, "fake-candidate-homes").map((item) => {
    const home = exactObject(item, ["nodeId", "paths"], "fake-candidate-home");
    const nodeId = text(home.nodeId, "fake-candidate-node");
    const paths = stringArray(home.paths, "fake-candidate-paths").map((path) =>
      safePath(path, "fake-candidate-path"),
    );
    if (!publicNodes.has(nodeId) || !paths.includes(corpusCase.publicNodeSources[nodeId]!)) {
      fail("fake-candidate-home");
    }
    return { nodeId, paths };
  });
  unique(
    canonicalHomes.map((item) => item.nodeId),
    "fake-candidate-home",
  );
  const placements = array(root.placements, "fake-candidate-placements").map((item) => {
    const placement = exactObject(item, ["answerId", "nodeId"], "fake-candidate-placement");
    const nodeId =
      placement.nodeId === null ? null : text(placement.nodeId, "fake-candidate-placement-node");
    return { answerId: text(placement.answerId, "fake-candidate-answer"), nodeId };
  });
  const rankings = array(root.rankings, "fake-candidate-rankings").map((item) => {
    const ranking = exactObject(item, ["answerId", "nodeIds"], "fake-candidate-ranking");
    return {
      answerId: text(ranking.answerId, "fake-candidate-answer"),
      nodeIds: stringArray(ranking.nodeIds, "fake-candidate-ranking-nodes"),
    };
  });
  const answerIds = corpusCase.knownAnswers
    .map((answer) => answer.id)
    .sort()
    .join("\n");
  if (
    placements
      .map((item) => item.answerId)
      .sort()
      .join("\n") !== answerIds ||
    rankings
      .map((item) => item.answerId)
      .sort()
      .join("\n") !== answerIds
  )
    fail("fake-candidate-answer-coverage");
  const evidenceNodeIds = stringArray(root.evidenceNodeIds, "fake-candidate-evidence");
  const orphanNodeIds = stringArray(root.orphanNodeIds, "fake-candidate-orphans");
  const majorGroupings = array(root.majorGroupings, "fake-candidate-groupings").map((group) =>
    stringArray(group, "fake-candidate-group"),
  );
  if (
    [...evidenceNodeIds, ...majorGroupings.flat()].some((nodeId) => !publicNodes.has(nodeId)) ||
    new Set(majorGroupings.flat()).size !== majorGroupings.flat().length
  )
    fail("fake-candidate-public-nodes");
  const parsed: CorpusFakeCandidateV1 = {
    schemaVersion: 1,
    kind: "docsfab-corpus-fake-candidate",
    caseId: corpusCase.id,
    repository: {
      revision: corpusCase.repository.revision,
      contentDigest: corpusCase.repository.contentDigest,
    },
    disposition: root.disposition as CorpusDisposition,
    evidenceNodeIds,
    orphanNodeIds,
    canonicalHomes,
    placements,
    rankings,
    majorGroupings,
    digest: digestValue(root.digest, "fake-candidate-digest"),
  };
  if (parsed.digest !== corpusFakeCandidateDigest(parsed)) fail("fake-candidate-digest");
  return parsed;
}

function fakeFailureClass(disposition: CorpusDisposition): CorpusFailureClass | undefined {
  if (disposition === "needs-human-input") return "evidence-insufficient";
  if (disposition === "stale-plan-rejected") return "stale-plan";
  if (disposition === "collision-rejected") return "scaffold-collision";
  if (disposition === "duplication-prevented") return "duplication-prevented";
  return undefined;
}

function fakeFailureClassValue(value: unknown): CorpusFailureClass {
  if (!CORPUS_FAILURE_CLASSES.includes(value as CorpusFailureClass))
    fail("fake-candidate-failure-class");
  return value as CorpusFailureClass;
}

export function evaluateCorpus(
  dataset: LivingDocumentationDataset,
  observations: CorpusObservationSet,
  thresholdPolicy: CorpusThresholdPolicy,
): CorpusDeterministicEvaluation {
  const thresholds = thresholdPolicy.thresholds;
  const metrics = computeMetrics(dataset, observations.runs);
  const dispositionsPassed = observations.runs.every(
    (run) =>
      dataset.cases.find((item) => item.id === run.caseId)?.expectedDisposition === run.disposition,
  );
  const publicSafetyPassed =
    observations.runs.every((run) => {
      const corpusCase = dataset.cases.find((item) => item.id === run.caseId)!;
      return observedAnswerSafety(corpusCase, run);
    }) &&
    dataset.cases.every((corpusCase) =>
      corpusCase.knownAnswers.every((answer) =>
        [...answer.expected, ...answer.acceptableAlternatives].every((destination) =>
          publicDestination(corpusCase, destination),
        ),
      ),
    );
  const groupingsPassed = observations.runs.every((run) => {
    const corpusCase = dataset.cases.find((item) => item.id === run.caseId)!;
    return (
      canonicalGrouping(run.majorGroupings) === canonicalGrouping(corpusCase.expectedMajorGroupings)
    );
  });
  const gates: CorpusGateResult[] = [
    gate("artifact-validity", metrics.artifactValidityRate >= thresholds.artifactValidityRate),
    gate("evidence-coverage", metrics.evidenceCoverage >= thresholds.evidenceCoverage),
    gate("orphans", metrics.orphanCount <= thresholds.maximumOrphans),
    gate(
      "duplicate-canonical-homes",
      metrics.duplicateCanonicalHomeCount <= thresholds.maximumDuplicateCanonicalHomes,
    ),
    gate("placement-agreement", metrics.placementAgreement >= thresholds.placementAgreement),
    gate("recall-at-3", metrics.recallAt3 >= thresholds.recallAt3),
    gate("mean-reciprocal-rank", metrics.meanReciprocalRank >= thresholds.meanReciprocalRank),
    gate("no-result-rate", metrics.noResultRate <= thresholds.maximumNoResultRate),
    gate("provider-blanks", metrics.providerBlanks <= thresholds.maximumProviderBlanks),
    gate(
      "classified-failures",
      metrics.unclassifiedFailures <= thresholds.maximumUnclassifiedFailures,
    ),
    gate("expected-dispositions", dispositionsPassed),
    gate("public-answer-safety", publicSafetyPassed),
    gate("expected-major-groupings", groupingsPassed),
    gate("five-run-reliability", evaluateFiveRunReliability(dataset, observations)),
  ];
  const base = {
    schemaVersion: 1 as const,
    dataset: { id: dataset.id, revision: dataset.revision, digest: datasetDigest(dataset) },
    thresholdPolicy: {
      id: thresholdPolicy.id,
      revision: thresholdPolicy.revision,
      digest: thresholdPolicy.digest,
    },
    observationMode: observations.mode,
    runCount: observations.runs.length,
    metrics,
    gates,
    passed: gates.every((item) => item.passed),
  };
  return { ...base, digest: canonicalDigest(base) };
}

export async function runOptionalCorpusJudge(
  evaluation: CorpusDeterministicEvaluation,
  judge?: CorpusJudge,
): Promise<CorpusJudgeDisposition> {
  const rubric = { id: CORPUS_SEMANTIC_RUBRIC.id, version: CORPUS_SEMANTIC_RUBRIC.version };
  if (!evaluation.passed) return { status: "not-run", reason: "deterministic-failed", rubric };
  if (!judge) return { status: "not-run", reason: "not-configured", rubric };
  try {
    const response = await judge.evaluate({
      schemaVersion: 1,
      rubric: CORPUS_SEMANTIC_RUBRIC,
      datasetDigest: evaluation.dataset.digest,
      evaluationDigest: evaluation.digest,
      metrics: evaluation.metrics,
      gateResults: evaluation.gates.map(({ gate: name, passed }) => ({ gate: name, passed })),
    });
    if (!response || typeof response.agrees !== "boolean")
      throw new Error("invalid judge response");
    return {
      status: response.agrees ? "agreed" : "disagreed",
      rubric,
      model: { ...judge.identity },
    };
  } catch {
    return { status: "failed", rubric, model: { ...judge.identity } };
  }
}

export function assertCorpusSourceBytes(source: CorpusSourceProvenance, bytes: Uint8Array): void {
  if (createHash("sha256").update(bytes).digest("hex") !== source.sha256)
    fail("source-content-drift");
}

export function assertCorpusReportSanitized(value: unknown): void {
  const serialized = JSON.stringify(value);
  if (
    detectCredentialRuleIds(serialized).length > 0 ||
    /\b(?:sk-[A-Za-z0-9_-]{12,}|glpat-[A-Za-z0-9_-]{12,})\b/u.test(serialized) ||
    /(?:[A-Za-z]:\\|\/(?:Users|home|private|tmp)\/)/u.test(serialized) ||
    /(?:prompt|transcript|toolArguments|toolResults|credential|apiKey)\s*"?:/iu.test(serialized)
  )
    fail("unsanitized-report");
}

function observedAnswerSafety(corpusCase: CorpusCase, run: CorpusRunObservation): boolean {
  for (const answer of corpusCase.knownAnswers) {
    const placement = run.placements.find((item) => item.answerId === answer.id)?.destination;
    const ranked = run.rankings.find((item) => item.answerId === answer.id)?.destinations ?? [];
    for (const destination of [...(placement ? [placement] : []), ...ranked]) {
      if (
        !publicDestination(corpusCase, destination) ||
        answer.negativeExpectations.some((negative) => sameDestination(negative, destination))
      ) {
        return false;
      }
    }
  }
  return true;
}

function publicDestination(corpusCase: CorpusCase, destination: CorpusDestination): boolean {
  const source = corpusCase.publicNodeSources[destination.nodeId];
  const canonicalDestinations = corpusCase.knownAnswers.flatMap((answer) => [
    ...answer.expected,
    ...answer.acceptableAlternatives,
  ]);
  return (
    source === destination.path &&
    corpusCase.sources.some((item) => item.path === source && item.visibility === "public") &&
    canonicalDestinations.some((canonical) => sameDestination(canonical, destination))
  );
}
function gate(name: CorpusGateName, passed: boolean): CorpusGateResult {
  return { gate: name, passed, message: passed ? "passed" : "failed" };
}
