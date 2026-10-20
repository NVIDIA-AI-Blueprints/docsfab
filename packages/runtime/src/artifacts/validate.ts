// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isAbsolute } from "node:path";

import type {
  ContentIndexV1,
  RepositoryIdentity,
  StructuralChangeRegion,
} from "../content-ir/contracts.js";
import {
  APPROVAL_REQUIREMENTS,
  ARTIFACT_KINDS,
  ARTIFACT_REFERENCE_KINDS,
  ARTIFACT_USE_ROLES,
  ArtifactValidationError,
  CANDIDATE_REJECTION_REASONS,
  CONTENT_TYPES,
  HEALING_LEVELS,
  IA_DECISION_KINDS,
  IA_EVALUATION_STATUSES,
  IA_PLAN_MODES,
  IA_SCOPES,
  NAVIGATION_OUTCOMES,
  NAVIGATION_PRESSURES,
  ONTOLOGY_ENTITY_KINDS,
  ONTOLOGY_RELATIONSHIPS,
  ORGANIZING_AXES,
  OUTPUT_OPERATIONS,
  PAGE_DISPOSITIONS,
  PLAN_APPROVAL_STATUSES,
  SEMANTIC_IMPACTS,
  STRUCTURAL_PRESSURES,
  type Artifact,
  type ArtifactEvidence,
  type ArtifactKind,
  type ArtifactPayloadByKind,
  type ArtifactReference,
  type ArtifactReferenceValidationOptions,
  type ArtifactUse,
  type ArtifactValidationOptions,
  type CreateArtifactOptions,
  type IaPlanArtifact,
  type NavigationEvaluationPayload,
  type NavigationMetrics,
  type NavigationOutcome,
  type NavigationTask,
  type PlanState,
} from "./contracts.js";
import { canonicalArtifactDigest, canonicalArtifactJson } from "./canonical.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const GIT_OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const STRUCTURAL_REGIONS: readonly StructuralChangeRegion[] = [
  "body",
  "headings",
  "metadata",
  "navigation",
  "graph",
];

type JsonObject = Record<string, unknown>;

interface ValidationContext {
  index: ContentIndexV1;
  beforeIndex?: ContentIndexV1;
  nodes: ReadonlyMap<string, string>;
  repository: RepositoryIdentity;
  now: Date;
}

function fail(code: ConstructorParameters<typeof ArtifactValidationError>[0], path: string): never {
  throw new ArtifactValidationError(code, path);
}

function assertJson(value: unknown, path = "$", seen = new WeakSet<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("invalid-json", path);
    return;
  }
  if (typeof value !== "object") fail("invalid-json", path);
  if (seen.has(value)) fail("invalid-json", path);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.keys(value).length !== value.length) fail("invalid-json", path);
      value.forEach((item, index) => assertJson(item, `${path}[${index}]`, seen));
      return;
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) fail("invalid-json", path);
    if (Reflect.ownKeys(value).some((key) => typeof key === "symbol")) {
      fail("invalid-json", path);
    }
    for (const [key, child] of Object.entries(value as JsonObject)) {
      assertJson(child, `${path}.${key}`, seen);
    }
  } finally {
    seen.delete(value);
  }
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

function string(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) fail("invalid-type", path);
  return value;
}

function normalizedId(value: unknown, path: string): string {
  const result = string(value, path);
  if (result !== result.normalize("NFC") || /[\s\0]/u.test(result)) {
    fail("invalid-id", path);
  }
  return result;
}

function number(
  value: unknown,
  path: string,
  minimum = Number.NEGATIVE_INFINITY,
  maximum = Number.POSITIVE_INFINITY,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail("invalid-type", path);
  if (value < minimum || value > maximum) fail("invalid-type", path);
  return value;
}

function integer(value: unknown, path: string, minimum = 0): number {
  const result = number(value, path, minimum);
  if (!Number.isSafeInteger(result)) fail("invalid-type", path);
  return result;
}

function enumeration<T extends string>(value: unknown, values: readonly T[], path: string): T {
  if (typeof value !== "string" || !values.includes(value as T)) {
    fail("invalid-enum", path);
  }
  return value as T;
}

function digest(value: unknown, path: string): string {
  const result = string(value, path);
  if (!SHA256.test(result)) fail("invalid-type", path);
  return result;
}

function timestamp(value: unknown, path: string): string {
  const result = string(value, path);
  const parsed = new Date(result);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== result) {
    fail("invalid-time", path);
  }
  return result;
}

function safePath(value: unknown, path: string): string {
  const result = string(value, path);
  if (
    result.includes("\0") ||
    result.includes("\\") ||
    isAbsolute(result) ||
    /^[A-Za-z]:/u.test(result) ||
    result.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    fail("unsafe-path", path);
  }
  return result;
}

function unique(values: readonly string[], path: string): void {
  if (new Set(values).size !== values.length) fail("duplicate-id", path);
}

function idArray(
  value: unknown,
  path: string,
  resolveNodes = false,
  context?: ValidationContext,
): string[] {
  const result = array(value, path).map((item, index) => normalizedId(item, `${path}[${index}]`));
  unique(result, path);
  if (resolveNodes && context) {
    result.forEach((id, index) => node(id, `${path}[${index}]`, context));
  }
  return result;
}

function enumArray<T extends string>(value: unknown, values: readonly T[], path: string): T[] {
  const result = array(value, path).map((item, index) =>
    enumeration(item, values, `${path}[${index}]`),
  );
  unique(result, path);
  return result;
}

function repository(value: unknown, path: string): RepositoryIdentity {
  const item = object(value, path, ["revision", "contentDigest"]);
  const revision = string(item.revision, `${path}.revision`);
  if (!GIT_OBJECT_ID.test(revision)) fail("invalid-type", `${path}.revision`);
  return {
    revision,
    contentDigest: digest(item.contentDigest, `${path}.contentDigest`),
  };
}

function sameRepository(left: RepositoryIdentity, right: RepositoryIdentity): boolean {
  return left.revision === right.revision && left.contentDigest === right.contentDigest;
}

function node(id: string, path: string, context: ValidationContext): void {
  if (!context.nodes.has(id)) fail("unresolved-endpoint", path);
}

function evidence(value: unknown, path: string, context: ValidationContext): ArtifactEvidence[] {
  const result = array(value, path).map((entry, index) => {
    const entryPath = `${path}[${index}]`;
    const item = object(entry, entryPath, ["path", "nodeId"]);
    const evidencePath = safePath(item.path, `${entryPath}.path`);
    const nodeId = normalizedId(item.nodeId, `${entryPath}.nodeId`);
    node(nodeId, `${entryPath}.nodeId`, context);
    if (context.nodes.get(nodeId) !== evidencePath) {
      fail("unresolved-endpoint", `${entryPath}.path`);
    }
    return { path: evidencePath, nodeId };
  });
  const keys = result.map((item) => `${item.path}\0${item.nodeId ?? ""}`);
  unique(keys, path);
  return result;
}

function validateGroup(value: unknown, path: string, context: ValidationContext): string {
  const item = object(value, path, ["id", "label", "axis", "members", "canonicalPath", "evidence"]);
  const id = normalizedId(item.id, `${path}.id`);
  string(item.label, `${path}.label`);
  enumeration(item.axis, ORGANIZING_AXES, `${path}.axis`);
  idArray(item.members, `${path}.members`, true, context);
  safePath(item.canonicalPath, `${path}.canonicalPath`);
  evidence(item.evidence, `${path}.evidence`, context);
  return id;
}

function validateRejectedCandidate(value: unknown, path: string): string {
  const item = object(value, path, ["candidateId", "reason"]);
  const id = normalizedId(item.candidateId, `${path}.candidateId`);
  enumeration(item.reason, CANDIDATE_REJECTION_REASONS, `${path}.reason`);
  return id;
}

function validateDecision(value: unknown, path: string, context: ValidationContext): string {
  const item = object(value, path, ["id", "kind", "evidence"]);
  const id = normalizedId(item.id, `${path}.id`);
  enumeration(item.kind, IA_DECISION_KINDS, `${path}.kind`);
  evidence(item.evidence, `${path}.evidence`, context);
  return id;
}

function validateReferenceInternal(
  value: unknown,
  path: string,
  options: ArtifactReferenceValidationOptions = {},
): ArtifactReference {
  const item = object(value, path, [
    "kind",
    "schemaVersion",
    "digest",
    "repositoryRevision",
    "repositoryContentDigest",
  ]);
  const kind = enumeration(item.kind, ARTIFACT_REFERENCE_KINDS, `${path}.kind`);
  if (options.expectedKind && kind !== options.expectedKind) {
    fail("invalid-enum", `${path}.kind`);
  }
  const expectedVersion = kind === "editorial-decision" ? 3 : 1;
  if (item.schemaVersion !== expectedVersion) {
    if (typeof item.schemaVersion === "number" && item.schemaVersion > expectedVersion) {
      fail("future-version", `${path}.schemaVersion`);
    }
    fail("invalid-type", `${path}.schemaVersion`);
  }
  const revision = string(item.repositoryRevision, `${path}.repositoryRevision`);
  if (!GIT_OBJECT_ID.test(revision)) fail("invalid-type", `${path}.repositoryRevision`);
  const result: ArtifactReference = {
    kind,
    schemaVersion: expectedVersion as ArtifactReference["schemaVersion"],
    digest: digest(item.digest, `${path}.digest`),
    repositoryRevision: revision,
    repositoryContentDigest: digest(
      item.repositoryContentDigest,
      `${path}.repositoryContentDigest`,
    ),
  };
  if (
    options.index &&
    (result.repositoryRevision !== options.index.repository.revision ||
      result.repositoryContentDigest !== options.index.repository.contentDigest)
  ) {
    fail("repository-mismatch", path);
  }
  return result;
}

export function validateArtifactReference(
  value: unknown,
  options: ArtifactReferenceValidationOptions = {},
): ArtifactReference {
  assertJson(value);
  return validateReferenceInternal(value, "$", options);
}

export function validateArtifactUse(value: unknown): ArtifactUse {
  assertJson(value);
  const item = object(value, "$", ["role", "stepId", "reference"], ["role", "reference"]);
  const role = enumeration(item.role, ARTIFACT_USE_ROLES, "$.role");
  const reference = validateReferenceInternal(item.reference, "$.reference");
  return {
    role,
    ...(item.stepId === undefined ? {} : { stepId: normalizedId(item.stepId, "$.stepId") }),
    reference,
  };
}

function validateOntology(value: unknown, path: string, context: ValidationContext): void {
  const payload = object(value, path, ["entities", "relationships"]);
  const entityIds = array(payload.entities, `${path}.entities`).map((entry, index) => {
    const entryPath = `${path}.entities[${index}]`;
    const item = object(entry, entryPath, ["id", "label", "kind", "evidence"]);
    const id = normalizedId(item.id, `${entryPath}.id`);
    string(item.label, `${entryPath}.label`);
    enumeration(item.kind, ONTOLOGY_ENTITY_KINDS, `${entryPath}.kind`);
    evidence(item.evidence, `${entryPath}.evidence`, context);
    return id;
  });
  unique(entityIds, `${path}.entities`);
  const known = new Set(entityIds);
  const relationshipKeys = array(payload.relationships, `${path}.relationships`).map(
    (entry, index) => {
      const entryPath = `${path}.relationships[${index}]`;
      const item = object(entry, entryPath, ["subject", "predicate", "object", "evidence"]);
      const subject = normalizedId(item.subject, `${entryPath}.subject`);
      const predicate = enumeration(
        item.predicate,
        ONTOLOGY_RELATIONSHIPS,
        `${entryPath}.predicate`,
      );
      const target = normalizedId(item.object, `${entryPath}.object`);
      if (!known.has(subject)) fail("unresolved-endpoint", `${entryPath}.subject`);
      if (!known.has(target)) fail("unresolved-endpoint", `${entryPath}.object`);
      evidence(item.evidence, `${entryPath}.evidence`, context);
      return `${subject}\0${predicate}\0${target}`;
    },
  );
  unique(relationshipKeys, `${path}.relationships`);
}

function validateContextPacket(value: unknown, path: string, context: ValidationContext): void {
  const payload = object(value, path, [
    "targetNodeId",
    "pageRole",
    "ancestors",
    "siblings",
    "relatedCanonicalPages",
    "placementRules",
    "activeDecisionIds",
    "structuralPressure",
    "evidence",
  ]);
  const target = normalizedId(payload.targetNodeId, `${path}.targetNodeId`);
  node(target, `${path}.targetNodeId`, context);
  const role = object(
    payload.pageRole,
    `${path}.pageRole`,
    ["contentType", "readerJob", "canonicalParentId", "organizingAxis"],
    ["contentType", "readerJob", "organizingAxis"],
  );
  enumeration(role.contentType, CONTENT_TYPES, `${path}.pageRole.contentType`);
  normalizedId(role.readerJob, `${path}.pageRole.readerJob`);
  if (role.canonicalParentId !== undefined) {
    const parent = normalizedId(role.canonicalParentId, `${path}.pageRole.canonicalParentId`);
    node(parent, `${path}.pageRole.canonicalParentId`, context);
  }
  enumeration(role.organizingAxis, ORGANIZING_AXES, `${path}.pageRole.organizingAxis`);
  idArray(payload.ancestors, `${path}.ancestors`, true, context);
  idArray(payload.siblings, `${path}.siblings`, true, context);
  idArray(payload.relatedCanonicalPages, `${path}.relatedCanonicalPages`, true, context);
  const placement = object(payload.placementRules, `${path}.placementRules`, [
    "belongsHere",
    "belongsElsewhere",
  ]);
  idArray(placement.belongsHere, `${path}.placementRules.belongsHere`);
  idArray(placement.belongsElsewhere, `${path}.placementRules.belongsElsewhere`);
  idArray(payload.activeDecisionIds, `${path}.activeDecisionIds`);
  enumeration(payload.structuralPressure, STRUCTURAL_PRESSURES, `${path}.structuralPressure`);
  evidence(payload.evidence, `${path}.evidence`, context);
}

function validateCandidates(value: unknown, path: string, context: ValidationContext): void {
  const payload = object(
    value,
    path,
    [
      "scope",
      "targetNodeId",
      "candidates",
      "recommendedCandidateId",
      "rejectedCandidates",
      "openDecisions",
    ],
    ["scope", "candidates", "recommendedCandidateId", "rejectedCandidates", "openDecisions"],
  );
  const scope = enumeration(payload.scope, IA_SCOPES, `${path}.scope`);
  if (payload.targetNodeId === undefined) {
    if (scope !== "site") fail("missing-field", `${path}.targetNodeId`);
  } else {
    const target = normalizedId(payload.targetNodeId, `${path}.targetNodeId`);
    node(target, `${path}.targetNodeId`, context);
  }
  const candidateIds = array(payload.candidates, `${path}.candidates`).map((entry, index) => {
    const entryPath = `${path}.candidates[${index}]`;
    const item = object(entry, entryPath, [
      "id",
      "primaryAxis",
      "secondaryAxes",
      "score",
      "groups",
      "evidence",
    ]);
    const id = normalizedId(item.id, `${entryPath}.id`);
    enumeration(item.primaryAxis, ORGANIZING_AXES, `${entryPath}.primaryAxis`);
    enumArray(item.secondaryAxes, ORGANIZING_AXES, `${entryPath}.secondaryAxes`);
    number(item.score, `${entryPath}.score`, 0, 100);
    const groupIds = array(item.groups, `${entryPath}.groups`).map((group, groupIndex) =>
      validateGroup(group, `${entryPath}.groups[${groupIndex}]`, context),
    );
    unique(groupIds, `${entryPath}.groups`);
    evidence(item.evidence, `${entryPath}.evidence`, context);
    return id;
  });
  unique(candidateIds, `${path}.candidates`);
  const recommended = normalizedId(
    payload.recommendedCandidateId,
    `${path}.recommendedCandidateId`,
  );
  if (!candidateIds.includes(recommended))
    fail("unresolved-endpoint", `${path}.recommendedCandidateId`);
  const rejected = array(payload.rejectedCandidates, `${path}.rejectedCandidates`).map(
    (entry, index) => validateRejectedCandidate(entry, `${path}.rejectedCandidates[${index}]`),
  );
  unique(rejected, `${path}.rejectedCandidates`);
  rejected.forEach((id, index) => {
    if (!candidateIds.includes(id))
      fail("unresolved-endpoint", `${path}.rejectedCandidates[${index}].candidateId`);
  });
  if (rejected.includes(recommended)) {
    fail("invalid-id", `${path}.recommendedCandidateId`);
  }
  const decisions = array(payload.openDecisions, `${path}.openDecisions`).map((entry, index) =>
    validateDecision(entry, `${path}.openDecisions[${index}]`, context),
  );
  unique(decisions, `${path}.openDecisions`);
}

function validateIaEvaluation(value: unknown, path: string, context: ValidationContext): void {
  const payload = object(value, path, [
    "candidateArtifact",
    "candidateId",
    "diagnosticsDigest",
    "scoringDigest",
    "topologyDigest",
    "navigationComparisonDigest",
    "navigationEvaluation",
    "navigationSuite",
    "scores",
    "deterministicStatus",
    "eligible",
    "blockingDiagnosticDigests",
    "policyBindings",
    "evidence",
  ]);
  validateReferenceInternal(payload.candidateArtifact, `${path}.candidateArtifact`, {
    index: context.index,
    expectedKind: "ia-candidates",
  });
  normalizedId(payload.candidateId, `${path}.candidateId`);
  for (const field of [
    "diagnosticsDigest",
    "scoringDigest",
    "topologyDigest",
    "navigationComparisonDigest",
  ] as const) {
    digest(payload[field], `${path}.${field}`);
  }
  validateReferenceInternal(payload.navigationEvaluation, `${path}.navigationEvaluation`, {
    index: context.index,
    expectedKind: "navigation-evaluation",
  });
  const suite = object(payload.navigationSuite, `${path}.navigationSuite`, [
    "id",
    "version",
    "digest",
  ]);
  normalizedId(suite.id, `${path}.navigationSuite.id`);
  string(suite.version, `${path}.navigationSuite.version`);
  digest(suite.digest, `${path}.navigationSuite.digest`);
  const scores = object(payload.scores, `${path}.scores`, [
    "evidenceCoverage",
    "cohesion",
    "separation",
    "predictability",
    "balance",
    "stability",
    "duplication",
    "total",
    "structuralFindability",
  ]);
  for (const field of Object.keys(scores)) {
    number(scores[field], `${path}.scores.${field}`, 0, 100);
  }
  const status = enumeration(
    payload.deterministicStatus,
    IA_EVALUATION_STATUSES,
    `${path}.deterministicStatus`,
  );
  if (typeof payload.eligible !== "boolean") fail("invalid-type", `${path}.eligible`);
  const blockers = array(
    payload.blockingDiagnosticDigests,
    `${path}.blockingDiagnosticDigests`,
  ).map((entry, index) => digest(entry, `${path}.blockingDiagnosticDigests[${index}]`));
  unique(blockers, `${path}.blockingDiagnosticDigests`);
  if (
    (status === "passed" && (!payload.eligible || blockers.length > 0)) ||
    (status === "failed" && payload.eligible)
  )
    fail("invalid-type", `${path}.eligible`);
  const policyIds = array(payload.policyBindings, `${path}.policyBindings`).map((entry, index) => {
    const entryPath = `${path}.policyBindings[${index}]`;
    const item = object(entry, entryPath, ["id", "version", "digest"]);
    const id = normalizedId(item.id, `${entryPath}.id`);
    string(item.version, `${entryPath}.version`);
    digest(item.digest, `${entryPath}.digest`);
    return id;
  });
  unique(policyIds, `${path}.policyBindings`);
  if (policyIds.length === 0) fail("missing-field", `${path}.policyBindings`);
  evidence(payload.evidence, `${path}.evidence`, context);
}

function validatePlanPayload(value: unknown, path: string, context: ValidationContext): void {
  const payload = object(
    value,
    path,
    [
      "planId",
      "candidateId",
      "candidateArtifact",
      "scope",
      "targetNodeId",
      "primaryAxis",
      "secondaryAxes",
      "groups",
      "useCases",
      "rejectedCandidates",
      "openDecisions",
      "redirects",
      "inboundLinkConsequences",
      "navigationEvaluation",
      "policyBindings",
      "approval",
      "expiresAt",
      "supersedes",
      "outputScope",
      "mode",
      "iaEvaluation",
      "plannedPages",
      "migrationDispositions",
    ],
    [
      "planId",
      "candidateId",
      "candidateArtifact",
      "scope",
      "primaryAxis",
      "secondaryAxes",
      "groups",
      "useCases",
      "rejectedCandidates",
      "openDecisions",
      "redirects",
      "inboundLinkConsequences",
      "navigationEvaluation",
      "policyBindings",
      "approval",
      "expiresAt",
      "outputScope",
    ],
  );
  normalizedId(payload.planId, `${path}.planId`);
  const candidateId = normalizedId(payload.candidateId, `${path}.candidateId`);
  validateReferenceInternal(payload.candidateArtifact, `${path}.candidateArtifact`, {
    index: context.index,
    expectedKind: "ia-candidates",
  });
  const scope = enumeration(payload.scope, IA_SCOPES, `${path}.scope`);
  if (payload.targetNodeId === undefined) {
    if (scope !== "site") fail("missing-field", `${path}.targetNodeId`);
  } else {
    const target = normalizedId(payload.targetNodeId, `${path}.targetNodeId`);
    node(target, `${path}.targetNodeId`, context);
  }
  const planningFields = ["mode", "iaEvaluation", "plannedPages", "migrationDispositions"] as const;
  const suppliedPlanningFields = planningFields.filter((field) => payload[field] !== undefined);
  if (
    suppliedPlanningFields.length !== 0 &&
    suppliedPlanningFields.length !== planningFields.length
  ) {
    const missing = planningFields.find((field) => payload[field] === undefined)!;
    fail("missing-field", `${path}.${missing}`);
  }
  const mode =
    suppliedPlanningFields.length === planningFields.length
      ? enumeration(payload.mode, IA_PLAN_MODES, `${path}.mode`)
      : undefined;
  if (mode === "create" && scope !== "site") fail("invalid-enum", `${path}.mode`);
  if (mode) {
    validateReferenceInternal(payload.iaEvaluation, `${path}.iaEvaluation`, {
      index: context.index,
      expectedKind: "ia-evaluation",
    });
  }
  enumeration(payload.primaryAxis, ORGANIZING_AXES, `${path}.primaryAxis`);
  enumArray(payload.secondaryAxes, ORGANIZING_AXES, `${path}.secondaryAxes`);
  const groups = array(payload.groups, `${path}.groups`).map((entry, index) =>
    validateGroup(entry, `${path}.groups[${index}]`, context),
  );
  unique(groups, `${path}.groups`);
  const useCases = array(payload.useCases, `${path}.useCases`).map((entry, index) => {
    const entryPath = `${path}.useCases[${index}]`;
    const item = object(entry, entryPath, [
      "id",
      "actor",
      "trigger",
      "goal",
      "input",
      "outcome",
      "evidence",
    ]);
    const id = normalizedId(item.id, `${entryPath}.id`);
    string(item.actor, `${entryPath}.actor`);
    string(item.trigger, `${entryPath}.trigger`);
    string(item.goal, `${entryPath}.goal`);
    string(item.input, `${entryPath}.input`);
    string(item.outcome, `${entryPath}.outcome`);
    evidence(item.evidence, `${entryPath}.evidence`, context);
    return id;
  });
  unique(useCases, `${path}.useCases`);
  const rejected = array(payload.rejectedCandidates, `${path}.rejectedCandidates`).map(
    (entry, index) => validateRejectedCandidate(entry, `${path}.rejectedCandidates[${index}]`),
  );
  unique(rejected, `${path}.rejectedCandidates`);
  if (rejected.includes(candidateId)) {
    fail("invalid-id", `${path}.candidateId`);
  }
  const decisions = array(payload.openDecisions, `${path}.openDecisions`).map((entry, index) =>
    validateDecision(entry, `${path}.openDecisions[${index}]`, context),
  );
  unique(decisions, `${path}.openDecisions`);
  const redirects = array(payload.redirects, `${path}.redirects`).map((entry, index) => {
    const entryPath = `${path}.redirects[${index}]`;
    const item = object(entry, entryPath, ["from", "to"]);
    return `${safePath(item.from, `${entryPath}.from`)}\0${safePath(item.to, `${entryPath}.to`)}`;
  });
  unique(redirects, `${path}.redirects`);
  const inbound = array(payload.inboundLinkConsequences, `${path}.inboundLinkConsequences`).map(
    (entry, index) => {
      const entryPath = `${path}.inboundLinkConsequences[${index}]`;
      const item = object(entry, entryPath, ["nodeId", "disposition"]);
      const id = normalizedId(item.nodeId, `${entryPath}.nodeId`);
      node(id, `${entryPath}.nodeId`, context);
      enumeration(item.disposition, PAGE_DISPOSITIONS, `${entryPath}.disposition`);
      return id;
    },
  );
  unique(inbound, `${path}.inboundLinkConsequences`);
  validateReferenceInternal(payload.navigationEvaluation, `${path}.navigationEvaluation`, {
    index: context.index,
    expectedKind: "navigation-evaluation",
  });
  const policies = array(payload.policyBindings, `${path}.policyBindings`).map((entry, index) => {
    const entryPath = `${path}.policyBindings[${index}]`;
    const item = object(entry, entryPath, ["id", "version", "digest"]);
    const id = normalizedId(item.id, `${entryPath}.id`);
    string(item.version, `${entryPath}.version`);
    digest(item.digest, `${entryPath}.digest`);
    return id;
  });
  unique(policies, `${path}.policyBindings`);
  const approval = object(
    payload.approval,
    `${path}.approval`,
    ["requirement", "status", "approvedBy", "approvedAt"],
    ["requirement", "status"],
  );
  const requirement = enumeration(
    approval.requirement,
    APPROVAL_REQUIREMENTS,
    `${path}.approval.requirement`,
  );
  const status = enumeration(approval.status, PLAN_APPROVAL_STATUSES, `${path}.approval.status`);
  const expiresAt = timestamp(payload.expiresAt, `${path}.expiresAt`);
  if (status === "approved") {
    if (approval.approvedAt === undefined) fail("missing-field", `${path}.approval.approvedAt`);
    const approvedAt = timestamp(approval.approvedAt, `${path}.approval.approvedAt`);
    if (requirement !== "none" && approval.approvedBy === undefined) {
      fail("missing-field", `${path}.approval.approvedBy`);
    }
    if (new Date(approvedAt).valueOf() > context.now.valueOf()) {
      fail("invalid-time", `${path}.approval.approvedAt`);
    }
    if (new Date(approvedAt).valueOf() >= new Date(expiresAt).valueOf()) {
      fail("invalid-time", `${path}.approval.approvedAt`);
    }
  } else if (approval.approvedBy !== undefined || approval.approvedAt !== undefined) {
    fail("invalid-type", `${path}.approval`);
  }
  if (approval.approvedBy !== undefined)
    normalizedId(approval.approvedBy, `${path}.approval.approvedBy`);
  if (payload.supersedes !== undefined) {
    validateReferenceInternal(payload.supersedes, `${path}.supersedes`, {
      index: context.index,
      expectedKind: "ia-plan",
    });
  }
  const outputs = array(payload.outputScope, `${path}.outputScope`).map((entry, index) => {
    const entryPath = `${path}.outputScope[${index}]`;
    const item = object(entry, entryPath, ["path", "operation"]);
    const outputPath = safePath(item.path, `${entryPath}.path`);
    enumeration(item.operation, OUTPUT_OPERATIONS, `${entryPath}.operation`);
    return outputPath;
  });
  unique(outputs, `${path}.outputScope`);
  if (mode) {
    const plannedPages = array(payload.plannedPages, `${path}.plannedPages`).map((entry, index) => {
      const entryPath = `${path}.plannedPages[${index}]`;
      const item = object(entry, entryPath, [
        "topicId",
        "title",
        "slug",
        "templateId",
        "format",
        "outputPath",
        "evidence",
      ]);
      const topicId = normalizedId(item.topicId, `${entryPath}.topicId`);
      string(item.title, `${entryPath}.title`);
      safePath(item.slug, `${entryPath}.slug`);
      normalizedId(item.templateId, `${entryPath}.templateId`);
      enumeration(item.format, ["gfm", "myst"] as const, `${entryPath}.format`);
      const outputPath = safePath(item.outputPath, `${entryPath}.outputPath`);
      if (evidence(item.evidence, `${entryPath}.evidence`, context).length === 0) {
        fail("missing-field", `${entryPath}.evidence`);
      }
      return { topicId, outputPath };
    });
    unique(
      plannedPages.map((page) => page.topicId),
      `${path}.plannedPages`,
    );
    unique(
      plannedPages.map((page) => page.outputPath),
      `${path}.plannedPages`,
    );

    const migrations = array(payload.migrationDispositions, `${path}.migrationDispositions`).map(
      (entry, index) => {
        const entryPath = `${path}.migrationDispositions[${index}]`;
        const item = object(entry, entryPath, [
          "nodeId",
          "disposition",
          "destinationPaths",
          "relatedNodeIds",
          "evidence",
        ]);
        const nodeId = normalizedId(item.nodeId, `${entryPath}.nodeId`);
        node(nodeId, `${entryPath}.nodeId`, context);
        const disposition = enumeration(
          item.disposition,
          PAGE_DISPOSITIONS,
          `${entryPath}.disposition`,
        );
        const destinationPaths = array(item.destinationPaths, `${entryPath}.destinationPaths`).map(
          (destination, destinationIndex) =>
            safePath(destination, `${entryPath}.destinationPaths[${destinationIndex}]`),
        );
        unique(destinationPaths, `${entryPath}.destinationPaths`);
        const relatedNodeIds = idArray(
          item.relatedNodeIds,
          `${entryPath}.relatedNodeIds`,
          true,
          context,
        );
        if (relatedNodeIds.includes(nodeId)) fail("invalid-id", `${entryPath}.relatedNodeIds`);
        if (evidence(item.evidence, `${entryPath}.evidence`, context).length === 0) {
          fail("missing-field", `${entryPath}.evidence`);
        }
        if ((disposition === "rename" || disposition === "move") && destinationPaths.length !== 1) {
          fail("invalid-type", `${entryPath}.destinationPaths`);
        }
        if (disposition === "split" && destinationPaths.length < 2) {
          fail("invalid-type", `${entryPath}.destinationPaths`);
        }
        if (
          ["keep", "archive", "needs-human-decision"].includes(disposition) &&
          destinationPaths.length !== 0
        ) {
          fail("invalid-type", `${entryPath}.destinationPaths`);
        }
        return nodeId;
      },
    );
    unique(migrations, `${path}.migrationDispositions`);
    if (mode === "create") {
      if (plannedPages.length === 0) fail("missing-field", `${path}.plannedPages`);
      if (migrations.length !== 0) fail("invalid-type", `${path}.migrationDispositions`);
      const createOutputs = array(payload.outputScope, `${path}.outputScope`).map(
        (entry) => entry as Record<string, unknown>,
      );
      if (
        createOutputs.some((output) => output.operation !== "create") ||
        plannedPages.length !== outputs.length ||
        plannedPages.some((page) => !outputs.includes(page.outputPath))
      ) {
        fail("invalid-type", `${path}.outputScope`);
      }
    } else {
      if (plannedPages.length !== 0) fail("invalid-type", `${path}.plannedPages`);
      if (migrations.length === 0) fail("missing-field", `${path}.migrationDispositions`);
      if (outputs.length !== 0) fail("invalid-type", `${path}.outputScope`);
    }
  }
}

function validateImpact(value: unknown, path: string, context: ValidationContext): void {
  const payload = object(value, path, [
    "beforeRepository",
    "afterRepository",
    "beforeIndexDigest",
    "afterIndexDigest",
    "changedPaths",
    "structuralRegions",
    "ontologyDelta",
    "affectedNodeIds",
    "navigationPressure",
    "semanticImpact",
    "recommendedAction",
    "requiredApproval",
    "evidence",
  ]);
  const before = repository(payload.beforeRepository, `${path}.beforeRepository`);
  if (!context.beforeIndex || !sameRepository(before, context.beforeIndex.repository)) {
    fail("repository-mismatch", `${path}.beforeRepository`);
  }
  const after = repository(payload.afterRepository, `${path}.afterRepository`);
  if (!sameRepository(after, context.repository))
    fail("repository-mismatch", `${path}.afterRepository`);
  const beforeIndex = digest(payload.beforeIndexDigest, `${path}.beforeIndexDigest`);
  if (beforeIndex !== context.beforeIndex.indexDigest) {
    fail("repository-mismatch", `${path}.beforeIndexDigest`);
  }
  const afterIndex = digest(payload.afterIndexDigest, `${path}.afterIndexDigest`);
  if (afterIndex !== context.index.indexDigest)
    fail("repository-mismatch", `${path}.afterIndexDigest`);
  const changed = array(payload.changedPaths, `${path}.changedPaths`).map((entry, index) =>
    safePath(entry, `${path}.changedPaths[${index}]`),
  );
  unique(changed, `${path}.changedPaths`);
  enumArray(payload.structuralRegions, STRUCTURAL_REGIONS, `${path}.structuralRegions`);
  const delta = object(payload.ontologyDelta, `${path}.ontologyDelta`, [
    "addedEntityIds",
    "removedEntityIds",
    "changedEntityIds",
    "addedRelationshipCount",
    "removedRelationshipCount",
  ]);
  idArray(delta.addedEntityIds, `${path}.ontologyDelta.addedEntityIds`);
  idArray(delta.removedEntityIds, `${path}.ontologyDelta.removedEntityIds`);
  idArray(delta.changedEntityIds, `${path}.ontologyDelta.changedEntityIds`);
  integer(delta.addedRelationshipCount, `${path}.ontologyDelta.addedRelationshipCount`);
  integer(delta.removedRelationshipCount, `${path}.ontologyDelta.removedRelationshipCount`);
  const affectedNodeIds = idArray(payload.affectedNodeIds, `${path}.affectedNodeIds`);
  const beforeNodes = new Set(context.beforeIndex.nodes.map((item) => item.id));
  affectedNodeIds.forEach((id, index) => {
    if (!context.nodes.has(id) && !beforeNodes.has(id)) {
      fail("unresolved-endpoint", `${path}.affectedNodeIds[${index}]`);
    }
  });
  enumeration(payload.navigationPressure, NAVIGATION_PRESSURES, `${path}.navigationPressure`);
  enumeration(payload.semanticImpact, SEMANTIC_IMPACTS, `${path}.semanticImpact`);
  enumeration(payload.recommendedAction, HEALING_LEVELS, `${path}.recommendedAction`);
  enumeration(payload.requiredApproval, APPROVAL_REQUIREMENTS, `${path}.requiredApproval`);
  evidence(payload.evidence, `${path}.evidence`, context);
}

function validateHealing(value: unknown, path: string, context: ValidationContext): void {
  const payload = object(value, path, ["impactReport", "recommendations", "requiredApproval"]);
  validateReferenceInternal(payload.impactReport, `${path}.impactReport`, {
    index: context.index,
    expectedKind: "impact-report",
  });
  const ids = array(payload.recommendations, `${path}.recommendations`).map((entry, index) => {
    const entryPath = `${path}.recommendations[${index}]`;
    const item = object(entry, entryPath, [
      "id",
      "level",
      "disposition",
      "targetNodeIds",
      "outputPaths",
      "evidence",
    ]);
    const id = normalizedId(item.id, `${entryPath}.id`);
    enumeration(item.level, HEALING_LEVELS, `${entryPath}.level`);
    enumeration(item.disposition, PAGE_DISPOSITIONS, `${entryPath}.disposition`);
    idArray(item.targetNodeIds, `${entryPath}.targetNodeIds`, true, context);
    const outputPaths = array(item.outputPaths, `${entryPath}.outputPaths`).map(
      (output, outputIndex) => safePath(output, `${entryPath}.outputPaths[${outputIndex}]`),
    );
    unique(outputPaths, `${entryPath}.outputPaths`);
    evidence(item.evidence, `${entryPath}.evidence`, context);
    return id;
  });
  unique(ids, `${path}.recommendations`);
  enumeration(payload.requiredApproval, APPROVAL_REQUIREMENTS, `${path}.requiredApproval`);
}

export function recomputeNavigationMetrics(
  payload: Pick<NavigationEvaluationPayload, "tasks" | "results">,
): NavigationMetrics {
  const taskCount = payload.tasks.length;
  if (taskCount === 0) {
    return {
      taskCount: 0,
      agreementRate: 0,
      recallAt3: 0,
      meanReciprocalRank: 0,
      noResultRate: 0,
      ambiguousPlacementRate: 0,
    };
  }
  const results = new Map(payload.results.map((result) => [result.taskId, result]));
  let agreements = 0;
  let recalls = 0;
  let reciprocalRanks = 0;
  let noResults = 0;
  let ambiguous = 0;
  for (const task of payload.tasks) {
    const result = results.get(task.id);
    if (!result) continue;
    const accepted = new Set([...task.expectedNodeIds, ...task.acceptableNodeIds]);
    const outcome = deriveNavigationOutcome(task, result.rankedNodeIds);
    if (result.rankedNodeIds.length === 0) noResults += 1;
    if (outcome === "ambiguous") ambiguous += 1;
    if (result.rankedNodeIds[0] && accepted.has(result.rankedNodeIds[0])) agreements += 1;
    if (result.rankedNodeIds.slice(0, 3).some((id) => accepted.has(id))) recalls += 1;
    const rank = result.rankedNodeIds.findIndex((id) => accepted.has(id));
    if (rank >= 0) reciprocalRanks += 1 / (rank + 1);
  }
  return {
    taskCount,
    agreementRate: agreements / taskCount,
    recallAt3: recalls / taskCount,
    meanReciprocalRank: reciprocalRanks / taskCount,
    noResultRate: noResults / taskCount,
    ambiguousPlacementRate: ambiguous / taskCount,
  };
}

function deriveNavigationOutcome(
  task: Pick<NavigationTask, "expectedNodeIds" | "acceptableNodeIds">,
  rankedNodeIds: readonly string[],
): NavigationOutcome {
  if (rankedNodeIds.length === 0) return "no-result";
  const accepted = new Set([...task.expectedNodeIds, ...task.acceptableNodeIds]);
  const acceptedResults = new Set(rankedNodeIds.filter((id) => accepted.has(id)));
  if (acceptedResults.size > 1) return "ambiguous";
  return acceptedResults.size === 1 ? "matched" : "missed";
}

function validateNavigation(value: unknown, path: string, context: ValidationContext): void {
  const payload = object(value, path, ["tasks", "results", "metrics"]);
  const tasks = array(payload.tasks, `${path}.tasks`).map((entry, index) => {
    const entryPath = `${path}.tasks[${index}]`;
    const item = object(entry, entryPath, ["id", "query", "expectedNodeIds", "acceptableNodeIds"]);
    const id = normalizedId(item.id, `${entryPath}.id`);
    const query = string(item.query, `${entryPath}.query`);
    const expected = idArray(item.expectedNodeIds, `${entryPath}.expectedNodeIds`, true, context);
    const acceptable = idArray(
      item.acceptableNodeIds,
      `${entryPath}.acceptableNodeIds`,
      true,
      context,
    );
    return {
      id,
      query,
      expectedNodeIds: expected,
      acceptableNodeIds: acceptable,
    };
  });
  const taskIds = tasks.map((task) => task.id);
  unique(taskIds, `${path}.tasks`);
  const resultIds = array(payload.results, `${path}.results`).map((entry, index) => {
    const entryPath = `${path}.results[${index}]`;
    const item = object(entry, entryPath, ["taskId", "rankedNodeIds", "outcome"]);
    const taskId = normalizedId(item.taskId, `${entryPath}.taskId`);
    if (!taskIds.includes(taskId)) fail("unresolved-endpoint", `${entryPath}.taskId`);
    const ranked = idArray(item.rankedNodeIds, `${entryPath}.rankedNodeIds`, true, context);
    const outcome = enumeration(item.outcome, NAVIGATION_OUTCOMES, `${entryPath}.outcome`);
    const task = tasks.find((candidate) => candidate.id === taskId)!;
    if (outcome !== deriveNavigationOutcome(task, ranked)) {
      fail("invalid-enum", `${entryPath}.outcome`);
    }
    return taskId;
  });
  unique(resultIds, `${path}.results`);
  if (resultIds.length !== taskIds.length) fail("unresolved-endpoint", `${path}.results`);
  const metrics = object(payload.metrics, `${path}.metrics`, [
    "taskCount",
    "agreementRate",
    "recallAt3",
    "meanReciprocalRank",
    "noResultRate",
    "ambiguousPlacementRate",
  ]);
  integer(metrics.taskCount, `${path}.metrics.taskCount`);
  for (const field of [
    "agreementRate",
    "recallAt3",
    "meanReciprocalRank",
    "noResultRate",
    "ambiguousPlacementRate",
  ] as const) {
    number(metrics[field], `${path}.metrics.${field}`, 0, 1);
  }
  const computed = recomputeNavigationMetrics(payload as unknown as NavigationEvaluationPayload);
  for (const [field, expected] of Object.entries(computed) as Array<
    [keyof NavigationMetrics, number]
  >) {
    const actual = metrics[field];
    if (typeof actual !== "number" || Math.abs(actual - expected) > 1e-12) {
      fail("invalid-metrics", `${path}.metrics.${field}`);
    }
  }
}

function validatePayload(kind: ArtifactKind, value: unknown, context: ValidationContext): void {
  switch (kind) {
    case "ontology":
      return validateOntology(value, "$.payload", context);
    case "context-packet":
      return validateContextPacket(value, "$.payload", context);
    case "ia-candidates":
      return validateCandidates(value, "$.payload", context);
    case "ia-evaluation":
      return validateIaEvaluation(value, "$.payload", context);
    case "ia-plan":
      return validatePlanPayload(value, "$.payload", context);
    case "impact-report":
      return validateImpact(value, "$.payload", context);
    case "healing-report":
      return validateHealing(value, "$.payload", context);
    case "navigation-evaluation":
      return validateNavigation(value, "$.payload", context);
  }
}

function planReference(plan: IaPlanArtifact): ArtifactReference<"ia-plan"> {
  return {
    kind: "ia-plan",
    schemaVersion: 1,
    digest: plan.digest,
    repositoryRevision: plan.repository.revision,
    repositoryContentDigest: plan.repository.contentDigest,
  };
}

function sameReference(
  left: ArtifactReference<"ia-plan">,
  right: ArtifactReference<"ia-plan">,
): boolean {
  return (
    left.kind === right.kind &&
    left.schemaVersion === right.schemaVersion &&
    left.digest === right.digest &&
    left.repositoryRevision === right.repositoryRevision &&
    left.repositoryContentDigest === right.repositoryContentDigest
  );
}

function explicitlySupersedes(
  plan: IaPlanArtifact,
  activePlan: IaPlanArtifact | undefined,
): boolean {
  if (!activePlan?.payload.supersedes) return false;
  if (activePlan.payload.scope !== plan.payload.scope) return false;
  if (activePlan.payload.targetNodeId !== plan.payload.targetNodeId) return false;
  return sameReference(activePlan.payload.supersedes, planReference(plan));
}

export function evaluatePlanState(
  plan: IaPlanArtifact,
  options: {
    now?: Date;
    index?: ContentIndexV1;
    beforeIndex?: ContentIndexV1;
    activePlan?: IaPlanArtifact;
  } = {},
): PlanState {
  const status = plan.payload.approval.status;
  if (status === "rejected") return "rejected";
  if (status === "changes-requested") return "changes-requested";
  const now = options.now ?? new Date();
  if (options.activePlan && !options.index) {
    fail("missing-field", "$.options.index");
  }
  const validatedActivePlan =
    options.activePlan && options.index
      ? validateArtifact(options.activePlan, {
          index: options.index,
          ...(options.beforeIndex ? { beforeIndex: options.beforeIndex } : {}),
          now,
        })
      : undefined;
  if (validatedActivePlan && validatedActivePlan.kind !== "ia-plan") {
    fail("invalid-enum", "$.options.activePlan.kind");
  }
  const activePlan = validatedActivePlan as IaPlanArtifact | undefined;
  if (explicitlySupersedes(plan, activePlan)) return "superseded";
  if (status !== "approved") return "unapproved";
  if (new Date(plan.payload.expiresAt).valueOf() <= now.valueOf()) return "expired";
  return "active";
}

export function validateArtifact(value: unknown, options: ArtifactValidationOptions): Artifact {
  assertJson(value);
  const envelope = object(value, "$", ["schemaVersion", "kind", "repository", "digest", "payload"]);
  if (envelope.schemaVersion !== 1) {
    if (typeof envelope.schemaVersion === "number" && envelope.schemaVersion > 1) {
      fail("future-version", "$.schemaVersion");
    }
    fail("invalid-type", "$.schemaVersion");
  }
  const kind = enumeration(envelope.kind, ARTIFACT_KINDS, "$.kind");
  const artifactRepository = repository(envelope.repository, "$.repository");
  if (!sameRepository(artifactRepository, options.index.repository)) {
    fail("repository-mismatch", "$.repository");
  }
  const expectedDigest = digest(envelope.digest, "$.digest");
  const context: ValidationContext = {
    index: options.index,
    ...(options.beforeIndex ? { beforeIndex: options.beforeIndex } : {}),
    nodes: new Map(options.index.nodes.map((item) => [item.id, item.sourcePath])),
    repository: artifactRepository,
    now: options.now ?? new Date(),
  };
  validatePayload(kind, envelope.payload, context);
  if (canonicalArtifactDigest(value) !== expectedDigest) fail("digest-mismatch", "$.digest");
  const artifact = JSON.parse(canonicalArtifactJson(value)) as Artifact;
  if (artifact.kind === "ia-plan") {
    const state = evaluatePlanState(artifact, {
      index: options.index,
      ...(options.beforeIndex ? { beforeIndex: options.beforeIndex } : {}),
      ...(options.now ? { now: options.now } : {}),
      ...(options.activePlan ? { activePlan: options.activePlan } : {}),
    });
    if (options.planAcceptance !== "any") {
      if (state === "unapproved" || state === "changes-requested" || state === "rejected") {
        fail("plan-unapproved", "$.payload.approval.status");
      }
      if (state === "expired") fail("plan-expired", "$.payload.expiresAt");
      if (state === "superseded") fail("plan-superseded", "$.digest");
    }
  }
  return artifact;
}

export function createArtifact<K extends ArtifactKind>(
  kind: K,
  payload: ArtifactPayloadByKind[K],
  options: CreateArtifactOptions,
): Extract<Artifact, { kind: K }> {
  assertJson(payload, "$.payload");
  const artifact: JsonObject = {
    schemaVersion: 1,
    kind,
    repository: {
      revision: options.index.repository.revision,
      contentDigest: options.index.repository.contentDigest,
    },
    digest: "0".repeat(64),
    payload: structuredClone(payload),
  };
  artifact.digest = canonicalArtifactDigest(artifact);
  const canonical = JSON.parse(canonicalArtifactJson(artifact)) as unknown;
  return validateArtifact(canonical, options) as Extract<Artifact, { kind: K }>;
}
