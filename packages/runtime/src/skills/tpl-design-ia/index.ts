// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import {
  CANDIDATE_REJECTION_REASONS,
  IA_DECISION_KINDS,
  IA_SCOPES,
  ORGANIZING_AXES,
  canonicalArtifactJson,
  validateArtifact,
  validateArtifactReference,
  type Artifact,
  type ArtifactEvidence,
  type ArtifactReference,
  type CandidateRejectionReason,
  type IaCandidatesPayload,
  type IaScope,
  type IaUseCase,
  type OntologyPayload,
  type OrganizingAxis,
} from "../../artifacts/index.js";
import type { ContentIndexV1, RepositoryIdentity } from "../../content-ir/index.js";
import { detectCredentialRuleIds } from "../../security/repository-scanner.js";

export const TPL_DESIGN_IA_SKILL = "tpl-design-ia" as const;
export const TPL_DESIGN_IA_SKILL_VERSION = "0.1.0-local.1" as const;
export const TPL_DESIGN_IA_PROVENANCE_STATUS = "docsfab-local" as const;
export const TPL_DESIGN_IA_EVALUATION_ID = "tpl-design-ia.behavior" as const;
export const TPL_DESIGN_IA_EVALUATION_VERSION = 1 as const;

export const TPL_DESIGN_IA_MODES = ["create", "reevaluate"] as const;
export type TplDesignIaMode = (typeof TPL_DESIGN_IA_MODES)[number];

export const TPL_DESIGN_IA_STATUSES = ["recommendation-ready", "needs-human-input"] as const;
export type TplDesignIaStatus = (typeof TPL_DESIGN_IA_STATUSES)[number];

export interface TplDesignIaSkillIdentity {
  id: typeof TPL_DESIGN_IA_SKILL;
  version: typeof TPL_DESIGN_IA_SKILL_VERSION;
  provenanceStatus: typeof TPL_DESIGN_IA_PROVENANCE_STATUS;
}

export interface TplDesignIaEvaluationIdentity {
  id: typeof TPL_DESIGN_IA_EVALUATION_ID;
  version: typeof TPL_DESIGN_IA_EVALUATION_VERSION;
}

export interface TplDesignIaArtifactReferences {
  ontology: ArtifactReference<"ontology">;
  iaCandidates?: ArtifactReference<"ia-candidates">;
  navigationEvaluation?: ArtifactReference<"navigation-evaluation">;
}

export interface TplDesignIaRecommendationGroup {
  id: string;
  memberNodeIds: string[];
}

export interface TplDesignIaRecommendation {
  candidateId: string;
  primaryAxis: OrganizingAxis;
  groups: TplDesignIaRecommendationGroup[];
  rationale: string;
  evidence: ArtifactEvidence[];
}

export interface TplDesignIaRejection {
  candidateId: string;
  primaryAxis: OrganizingAxis;
  reason: CandidateRejectionReason;
  rationale: string;
  evidence: ArtifactEvidence[];
}

export interface TplDesignIaOpenDecision {
  id: string;
  kind: (typeof IA_DECISION_KINDS)[number];
  question: string;
  blocking: boolean;
  evidence: ArtifactEvidence[];
  evidenceGap?: string;
}

export interface TplDesignIaResultV1 {
  schemaVersion: 1;
  digest: string;
  skill: TplDesignIaSkillIdentity;
  evaluation: TplDesignIaEvaluationIdentity;
  repository: RepositoryIdentity;
  scope: IaScope;
  mode: TplDesignIaMode;
  targetNodeId?: string;
  status: TplDesignIaStatus;
  artifacts: TplDesignIaArtifactReferences;
  useCases: IaUseCase[];
  recommendation?: TplDesignIaRecommendation;
  rejections: TplDesignIaRejection[];
  openDecisions: TplDesignIaOpenDecision[];
}

export interface TplDesignIaArtifactSet {
  ontology?: unknown;
  iaCandidates?: unknown;
  navigationEvaluation?: unknown;
}

export interface ValidateTplDesignIaOptions {
  index: ContentIndexV1;
  artifacts: TplDesignIaArtifactSet;
}

export type TplDesignIaValidationErrorCode =
  | "unknown-field"
  | "missing-field"
  | "invalid-type"
  | "invalid-enum"
  | "duplicate-id"
  | "repository-mismatch"
  | "unresolved-evidence"
  | "invalid-reference"
  | "invalid-status"
  | "insufficient-candidates"
  | "sparse-invention"
  | "invalid-recommendation"
  | "incomplete-rejections"
  | "unsafe-content"
  | "digest-mismatch";

export class TplDesignIaValidationError extends Error {
  public constructor(
    public readonly code: TplDesignIaValidationErrorCode,
    public readonly path: string,
  ) {
    super(`tpl-design-ia result validation failed (${code}) at ${path}.`);
    this.name = "TplDesignIaValidationError";
  }
}

type JsonObject = Record<string, unknown>;

const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_RESULT_BYTES = 65_536;
const MAX_IDENTIFIER_LENGTH = 200;
const MAX_TEXT_LENGTH = 4_096;
const MAX_USE_CASE_FIELD_LENGTH = 1_000;
const MAX_QUESTION_LENGTH = 1_000;

function fail(code: TplDesignIaValidationErrorCode, path: string): never {
  throw new TplDesignIaValidationError(code, path);
}

function object(
  value: unknown,
  path: string,
  allowed: readonly string[],
  required: readonly string[] = allowed,
): JsonObject {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    fail("invalid-type", path);
  }
  const result = value as JsonObject;
  for (const key of Object.keys(result)) {
    if (!allowed.includes(key)) fail("unknown-field", `${path}.${key}`);
  }
  for (const key of required) {
    if (!Object.hasOwn(result, key)) fail("missing-field", `${path}.${key}`);
  }
  return result;
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail("invalid-type", path);
  return value;
}

function text(value: unknown, path: string, maximumLength = MAX_TEXT_LENGTH): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximumLength) {
    fail("invalid-type", path);
  }
  if (detectCredentialRuleIds(value).length > 0) {
    fail("unsafe-content", path);
  }
  return value;
}

function conciseText(value: unknown, path: string): string {
  return text(value, path, 240);
}

function identifier(value: unknown, path: string): string {
  const result = text(value, path, MAX_IDENTIFIER_LENGTH);
  if (result !== result.normalize("NFC") || /[\s\0]/u.test(result)) fail("invalid-type", path);
  return result;
}

function enumeration<T extends string>(value: unknown, values: readonly T[], path: string): T {
  if (typeof value !== "string" || !values.includes(value as T)) fail("invalid-enum", path);
  return value as T;
}

function unique(values: readonly string[], path: string): void {
  if (new Set(values).size !== values.length) fail("duplicate-id", path);
}

function identifiers(value: unknown, path: string): string[] {
  const result = array(value, path).map((item, index) => identifier(item, `${path}[${index}]`));
  unique(result, path);
  return result;
}

function scanUnsafeContent(value: unknown, path = "$", seen = new WeakSet<object>()): void {
  if (typeof value === "string") {
    if (detectCredentialRuleIds(value).length > 0) {
      fail("unsafe-content", path);
    }
    return;
  }
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) fail("invalid-type", path);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => scanUnsafeContent(entry, `${path}[${index}]`, seen));
    } else {
      for (const [key, child] of Object.entries(value as JsonObject)) {
        scanUnsafeContent(child, `${path}.${key}`, seen);
      }
    }
  } finally {
    seen.delete(value);
  }
}

function repository(value: unknown, index: ContentIndexV1): RepositoryIdentity {
  const item = object(value, "$.repository", ["revision", "contentDigest"]);
  const revision = text(item.revision, "$.repository.revision");
  const contentDigest = text(item.contentDigest, "$.repository.contentDigest");
  if (revision !== index.repository.revision || contentDigest !== index.repository.contentDigest) {
    fail("repository-mismatch", "$.repository");
  }
  return { revision, contentDigest };
}

function evidence(
  value: unknown,
  path: string,
  index: ContentIndexV1,
  requireNonEmpty = true,
): ArtifactEvidence[] {
  const sources = new Map(index.nodes.map((node) => [node.id, node.sourcePath]));
  const result = array(value, path).map((entry, entryIndex) => {
    const entryPath = `${path}[${entryIndex}]`;
    const item = object(entry, entryPath, ["path", "nodeId"]);
    const nodeId = identifier(item.nodeId, `${entryPath}.nodeId`);
    const sourcePath = text(item.path, `${entryPath}.path`);
    if (sources.get(nodeId) !== sourcePath) fail("unresolved-evidence", entryPath);
    return { path: sourcePath, nodeId };
  });
  if (requireNonEmpty && result.length === 0) fail("sparse-invention", path);
  unique(
    result.map((item) => `${item.nodeId}\0${item.path}`),
    path,
  );
  return result;
}

function useCase(value: unknown, path: string, index: ContentIndexV1): IaUseCase {
  const item = object(value, path, [
    "id",
    "actor",
    "trigger",
    "goal",
    "input",
    "outcome",
    "evidence",
  ]);
  return {
    id: identifier(item.id, `${path}.id`),
    actor: text(item.actor, `${path}.actor`, 160),
    trigger: text(item.trigger, `${path}.trigger`, MAX_USE_CASE_FIELD_LENGTH),
    goal: text(item.goal, `${path}.goal`, MAX_USE_CASE_FIELD_LENGTH),
    input: text(item.input, `${path}.input`, MAX_USE_CASE_FIELD_LENGTH),
    outcome: text(item.outcome, `${path}.outcome`, MAX_USE_CASE_FIELD_LENGTH),
    evidence: evidence(item.evidence, `${path}.evidence`, index),
  };
}

function recommendation(
  value: unknown,
  path: string,
  index: ContentIndexV1,
): TplDesignIaRecommendation {
  const item = object(value, path, [
    "candidateId",
    "primaryAxis",
    "groups",
    "rationale",
    "evidence",
  ]);
  const groups = array(item.groups, `${path}.groups`).map((entry, groupIndex) => {
    const groupPath = `${path}.groups[${groupIndex}]`;
    const group = object(entry, groupPath, ["id", "memberNodeIds"]);
    const memberNodeIds = identifiers(group.memberNodeIds, `${groupPath}.memberNodeIds`);
    if (memberNodeIds.length === 0) fail("sparse-invention", `${groupPath}.memberNodeIds`);
    memberNodeIds.forEach((nodeId, nodeIndex) => {
      if (!index.nodes.some((node) => node.id === nodeId)) {
        fail("unresolved-evidence", `${groupPath}.memberNodeIds[${nodeIndex}]`);
      }
    });
    return { id: identifier(group.id, `${groupPath}.id`), memberNodeIds };
  });
  if (groups.length === 0) fail("sparse-invention", `${path}.groups`);
  unique(
    groups.map((group) => group.id),
    `${path}.groups`,
  );
  return {
    candidateId: identifier(item.candidateId, `${path}.candidateId`),
    primaryAxis: enumeration(item.primaryAxis, ORGANIZING_AXES, `${path}.primaryAxis`),
    groups,
    rationale: conciseText(item.rationale, `${path}.rationale`),
    evidence: evidence(item.evidence, `${path}.evidence`, index),
  };
}

function rejection(value: unknown, path: string, index: ContentIndexV1): TplDesignIaRejection {
  const item = object(value, path, [
    "candidateId",
    "primaryAxis",
    "reason",
    "rationale",
    "evidence",
  ]);
  return {
    candidateId: identifier(item.candidateId, `${path}.candidateId`),
    primaryAxis: enumeration(item.primaryAxis, ORGANIZING_AXES, `${path}.primaryAxis`),
    reason: enumeration(item.reason, CANDIDATE_REJECTION_REASONS, `${path}.reason`),
    rationale: conciseText(item.rationale, `${path}.rationale`),
    evidence: evidence(item.evidence, `${path}.evidence`, index),
  };
}

function openDecision(
  value: unknown,
  path: string,
  index: ContentIndexV1,
): TplDesignIaOpenDecision {
  const item = object(
    value,
    path,
    ["id", "kind", "question", "blocking", "evidence", "evidenceGap"],
    ["id", "kind", "question", "blocking", "evidence"],
  );
  if (typeof item.blocking !== "boolean") fail("invalid-type", `${path}.blocking`);
  const decisionEvidence = evidence(item.evidence, `${path}.evidence`, index, false);
  const evidenceGap =
    item.evidenceGap === undefined
      ? undefined
      : text(item.evidenceGap, `${path}.evidenceGap`, MAX_QUESTION_LENGTH);
  if (decisionEvidence.length === 0 && !evidenceGap) fail("sparse-invention", path);
  return {
    id: identifier(item.id, `${path}.id`),
    kind: enumeration(item.kind, IA_DECISION_KINDS, `${path}.kind`),
    question: text(item.question, `${path}.question`, MAX_QUESTION_LENGTH),
    blocking: item.blocking,
    evidence: decisionEvidence,
    ...(evidenceGap ? { evidenceGap } : {}),
  };
}

function artifactReference<K extends "ontology" | "ia-candidates" | "navigation-evaluation">(
  value: unknown,
  path: string,
  kind: K,
  index: ContentIndexV1,
): ArtifactReference<K> {
  try {
    return validateArtifactReference(value, { index, expectedKind: kind }) as ArtifactReference<K>;
  } catch {
    fail("invalid-reference", path);
  }
}

function referenceFor(artifact: Artifact): ArtifactReference {
  return {
    kind: artifact.kind,
    schemaVersion: artifact.schemaVersion,
    digest: artifact.digest,
    repositoryRevision: artifact.repository.revision,
    repositoryContentDigest: artifact.repository.contentDigest,
  };
}

function requireExactReference(
  reference: ArtifactReference,
  artifact: Artifact,
  path: string,
): void {
  if (canonicalArtifactJson(reference) !== canonicalArtifactJson(referenceFor(artifact))) {
    fail("invalid-reference", path);
  }
}

function validateFullArtifact<K extends "ontology" | "ia-candidates" | "navigation-evaluation">(
  value: unknown,
  kind: K,
  index: ContentIndexV1,
  path: string,
): Extract<Artifact, { kind: K }> {
  if (value === undefined) fail("missing-field", path);
  const artifact = validateArtifact(value, { index });
  if (artifact.kind !== kind) fail("invalid-reference", path);
  return artifact as Extract<Artifact, { kind: K }>;
}

function normalizedPartition(groups: Array<{ members: string[] }>): string {
  return groups
    .map((group) => [...group.members].sort().join("\0"))
    .sort()
    .join("\u0001");
}

function recommendationPartition(groups: TplDesignIaRecommendationGroup[]): string {
  return normalizedPartition(groups.map((group) => ({ members: group.memberNodeIds })));
}

function stableGroups(
  groups: Array<{ id: string; members: string[] }>,
): Array<{ id: string; members: string[] }> {
  return groups
    .map((group) => ({ id: group.id, members: [...group.members].sort() }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function validateCandidateMateriality(payload: IaCandidatesPayload): void {
  if (payload.candidates.length < 2) fail("insufficient-candidates", "$.artifacts.iaCandidates");
  const axes = new Set(payload.candidates.map((candidate) => candidate.primaryAxis));
  const partitions = new Set(
    payload.candidates.map((candidate) => normalizedPartition(candidate.groups)),
  );
  if (axes.size < 2 || partitions.size < 2) {
    fail("insufficient-candidates", "$.artifacts.iaCandidates");
  }
}

function validateMaterialOntology(payload: OntologyPayload): void {
  if (payload.entities.length === 0)
    fail("sparse-invention", "$.artifacts.ontology.payload.entities");
  payload.entities.forEach((entity, index) => {
    if (entity.evidence.length === 0) {
      fail("sparse-invention", `$.artifacts.ontology.payload.entities[${index}].evidence`);
    }
  });
  payload.relationships.forEach((relationship, index) => {
    if (relationship.evidence.length === 0) {
      fail("sparse-invention", `$.artifacts.ontology.payload.relationships[${index}].evidence`);
    }
  });
}

function validateRecommendationAgainstCandidates(
  result: TplDesignIaRecommendation,
  rejections: TplDesignIaRejection[],
  payload: IaCandidatesPayload,
): void {
  validateCandidateMateriality(payload);
  const selected = payload.candidates.find(
    (candidate) => candidate.id === payload.recommendedCandidateId,
  );
  if (!selected || result.candidateId !== payload.recommendedCandidateId) {
    fail("invalid-recommendation", "$.recommendation.candidateId");
  }
  if (
    selected.primaryAxis !== result.primaryAxis ||
    canonicalArtifactJson(stableGroups(selected.groups)) !==
      canonicalArtifactJson(
        stableGroups(
          result.groups.map((group) => ({ id: group.id, members: group.memberNodeIds })),
        ),
      )
  ) {
    fail("invalid-recommendation", "$.recommendation.groups");
  }
  if (rejections.some((item) => item.candidateId === result.candidateId)) {
    fail("invalid-recommendation", "$.rejections");
  }
  const excludedIds = payload.candidates
    .filter((candidate) => candidate.id !== selected.id)
    .map((candidate) => candidate.id)
    .sort();
  if (
    canonicalArtifactJson(rejections.map((item) => item.candidateId).sort()) !==
    canonicalArtifactJson(excludedIds)
  ) {
    fail("incomplete-rejections", "$.rejections");
  }
  rejections.forEach((item, index) => {
    const candidate = payload.candidates.find((entry) => entry.id === item.candidateId);
    if (!candidate || candidate.primaryAxis !== item.primaryAxis) {
      fail("invalid-recommendation", `$.rejections[${index}]`);
    }
    const artifactRejection = payload.rejectedCandidates.find(
      (rejection) => rejection.candidateId === candidate.id,
    );
    if (!artifactRejection || artifactRejection.reason !== item.reason) {
      fail("invalid-recommendation", `$.rejections[${index}].reason`);
    }
  });
}

function validateOpenDecisions(
  result: TplDesignIaOpenDecision[],
  payload: IaCandidatesPayload,
): void {
  const resultIds = result.map((decision) => decision.id).sort();
  const artifactIds = payload.openDecisions.map((decision) => decision.id).sort();
  if (canonicalArtifactJson(resultIds) !== canonicalArtifactJson(artifactIds)) {
    fail("invalid-reference", "$.openDecisions");
  }
  result.forEach((decision, index) => {
    const artifactDecision = payload.openDecisions.find((item) => item.id === decision.id);
    if (!artifactDecision || artifactDecision.kind !== decision.kind) {
      fail("invalid-reference", `$.openDecisions[${index}]`);
    }
  });
}

export function canonicalTplDesignIaJson(value: unknown): string {
  return canonicalArtifactJson(value);
}

export function tplDesignIaDigest(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid-type", "$");
  const { digest: _digest, ...digestible } = value as JsonObject;
  return createHash("sha256").update(canonicalArtifactJson(digestible)).digest("hex");
}

export function validateTplDesignIaResult(
  value: unknown,
  options: ValidateTplDesignIaOptions,
): TplDesignIaResultV1 {
  let canonicalInput: string;
  try {
    canonicalInput = canonicalArtifactJson(value);
  } catch {
    fail("invalid-type", "$");
  }
  if (Buffer.byteLength(canonicalInput, "utf8") > MAX_RESULT_BYTES) {
    fail("invalid-type", "$");
  }
  scanUnsafeContent(value);
  scanUnsafeContent(options.artifacts, "$.artifactValues");
  const item = object(
    value,
    "$",
    [
      "schemaVersion",
      "digest",
      "skill",
      "evaluation",
      "repository",
      "scope",
      "mode",
      "targetNodeId",
      "status",
      "artifacts",
      "useCases",
      "recommendation",
      "rejections",
      "openDecisions",
    ],
    [
      "schemaVersion",
      "digest",
      "skill",
      "evaluation",
      "repository",
      "scope",
      "mode",
      "status",
      "artifacts",
      "useCases",
      "rejections",
      "openDecisions",
    ],
  );
  if (item.schemaVersion !== 1) fail("invalid-type", "$.schemaVersion");
  const skill = object(item.skill, "$.skill", ["id", "version", "provenanceStatus"]);
  if (skill.id !== TPL_DESIGN_IA_SKILL) fail("invalid-enum", "$.skill.id");
  if (skill.version !== TPL_DESIGN_IA_SKILL_VERSION) fail("invalid-enum", "$.skill.version");
  if (skill.provenanceStatus !== TPL_DESIGN_IA_PROVENANCE_STATUS) {
    fail("invalid-enum", "$.skill.provenanceStatus");
  }
  const evaluation = object(item.evaluation, "$.evaluation", ["id", "version"]);
  if (evaluation.id !== TPL_DESIGN_IA_EVALUATION_ID) fail("invalid-enum", "$.evaluation.id");
  if (evaluation.version !== TPL_DESIGN_IA_EVALUATION_VERSION)
    fail("invalid-type", "$.evaluation.version");
  const repositoryIdentity = repository(item.repository, options.index);
  const scope = enumeration(item.scope, IA_SCOPES, "$.scope");
  const mode = enumeration(item.mode, TPL_DESIGN_IA_MODES, "$.mode");
  const status = enumeration(item.status, TPL_DESIGN_IA_STATUSES, "$.status");
  let targetNodeId: string | undefined;
  if (item.targetNodeId !== undefined) {
    targetNodeId = identifier(item.targetNodeId, "$.targetNodeId");
    if (!options.index.nodes.some((node) => node.id === targetNodeId)) {
      fail("unresolved-evidence", "$.targetNodeId");
    }
  } else if (scope !== "site") {
    fail("missing-field", "$.targetNodeId");
  }
  const useCases = array(item.useCases, "$.useCases").map((entry, index) =>
    useCase(entry, `$.useCases[${index}]`, options.index),
  );
  unique(
    useCases.map((entry) => entry.id),
    "$.useCases",
  );
  const rejections = array(item.rejections, "$.rejections").map((entry, index) =>
    rejection(entry, `$.rejections[${index}]`, options.index),
  );
  unique(
    rejections.map((entry) => entry.candidateId),
    "$.rejections",
  );
  const openDecisions = array(item.openDecisions, "$.openDecisions").map((entry, index) =>
    openDecision(entry, `$.openDecisions[${index}]`, options.index),
  );
  unique(
    openDecisions.map((entry) => entry.id),
    "$.openDecisions",
  );

  let artifacts: TplDesignIaArtifactReferences;
  let selectedRecommendation: TplDesignIaRecommendation | undefined;
  const fullOntology = validateFullArtifact(
    options.artifacts.ontology,
    "ontology",
    options.index,
    "$.artifactValues.ontology",
  );
  validateMaterialOntology(fullOntology.payload);

  if (status === "recommendation-ready") {
    if (item.recommendation === undefined) fail("missing-field", "$.recommendation");
    if (useCases.length === 0) fail("sparse-invention", "$.useCases");
    const refs = object(item.artifacts, "$.artifacts", [
      "ontology",
      "iaCandidates",
      "navigationEvaluation",
    ]);
    const ontologyReference = artifactReference(
      refs.ontology,
      "$.artifacts.ontology",
      "ontology",
      options.index,
    );
    const candidatesReference = artifactReference(
      refs.iaCandidates,
      "$.artifacts.iaCandidates",
      "ia-candidates",
      options.index,
    );
    const navigationReference = artifactReference(
      refs.navigationEvaluation,
      "$.artifacts.navigationEvaluation",
      "navigation-evaluation",
      options.index,
    );
    artifacts = {
      ontology: ontologyReference,
      iaCandidates: candidatesReference,
      navigationEvaluation: navigationReference,
    };
    const fullCandidates = validateFullArtifact(
      options.artifacts.iaCandidates,
      "ia-candidates",
      options.index,
      "$.artifactValues.iaCandidates",
    );
    const fullNavigation = validateFullArtifact(
      options.artifacts.navigationEvaluation,
      "navigation-evaluation",
      options.index,
      "$.artifactValues.navigationEvaluation",
    );
    if (
      fullCandidates.payload.scope !== scope ||
      fullCandidates.payload.targetNodeId !== targetNodeId
    ) {
      fail("invalid-reference", "$.artifacts.iaCandidates");
    }
    requireExactReference(ontologyReference, fullOntology, "$.artifacts.ontology");
    requireExactReference(candidatesReference, fullCandidates, "$.artifacts.iaCandidates");
    requireExactReference(navigationReference, fullNavigation, "$.artifacts.navigationEvaluation");
    selectedRecommendation = recommendation(item.recommendation, "$.recommendation", options.index);
    validateRecommendationAgainstCandidates(
      selectedRecommendation,
      rejections,
      fullCandidates.payload,
    );
    validateOpenDecisions(openDecisions, fullCandidates.payload);
    if (fullNavigation.payload.tasks.length === 0) {
      fail("sparse-invention", "$.artifactValues.navigationEvaluation.payload.tasks");
    }
    if (openDecisions.some((decision) => decision.blocking)) {
      fail("invalid-status", "$.openDecisions");
    }
  } else {
    if (item.recommendation !== undefined) fail("invalid-status", "$.recommendation");
    if (rejections.length > 0) fail("invalid-status", "$.rejections");
    if (openDecisions.length === 0 || openDecisions.some((decision) => !decision.blocking)) {
      fail("invalid-status", "$.openDecisions");
    }
    const refs = object(item.artifacts, "$.artifacts", ["ontology"]);
    artifacts = {
      ontology: artifactReference(refs.ontology, "$.artifacts.ontology", "ontology", options.index),
    };
    requireExactReference(artifacts.ontology, fullOntology, "$.artifacts.ontology");
  }

  const suppliedDigest = text(item.digest, "$.digest");
  if (!SHA256.test(suppliedDigest) || tplDesignIaDigest(value) !== suppliedDigest) {
    fail("digest-mismatch", "$.digest");
  }

  return JSON.parse(
    canonicalArtifactJson({
      schemaVersion: 1,
      digest: suppliedDigest,
      skill: {
        id: TPL_DESIGN_IA_SKILL,
        version: TPL_DESIGN_IA_SKILL_VERSION,
        provenanceStatus: TPL_DESIGN_IA_PROVENANCE_STATUS,
      },
      evaluation: { id: TPL_DESIGN_IA_EVALUATION_ID, version: TPL_DESIGN_IA_EVALUATION_VERSION },
      repository: repositoryIdentity,
      scope,
      mode,
      ...(targetNodeId ? { targetNodeId } : {}),
      status,
      artifacts,
      useCases,
      ...(selectedRecommendation ? { recommendation: selectedRecommendation } : {}),
      rejections,
      openDecisions,
    }),
  ) as TplDesignIaResultV1;
}

export function normalizedMajorGrouping(result: TplDesignIaResultV1): string {
  if (result.status !== "recommendation-ready" || !result.recommendation) return result.status;
  return `${result.recommendation.primaryAxis}\0${recommendationPartition(result.recommendation.groups)}`;
}

export function haveEquivalentMajorGroupings(
  left: TplDesignIaResultV1,
  right: TplDesignIaResultV1,
): boolean {
  return (
    left.scope === right.scope &&
    left.targetNodeId === right.targetNodeId &&
    normalizedMajorGrouping(left) === normalizedMajorGrouping(right)
  );
}
