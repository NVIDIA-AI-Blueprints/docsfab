// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";

import { createContractKit, deepFreeze, type ContractFail } from "../contract-kit/index.js";
import {
  canonicalizeJsonEvidence,
  parseJsonEvidence,
  type JsonEvidenceValue,
} from "../json-evidence.js";
import { containsConfiguredCredential } from "../security/configured-credentials.js";

export const BOUNDED_SEARCH_SCHEMA_VERSION = 1 as const;
export const SEARCH_REQUIRED_PROBE_POLICY = {
  id: "docsfab-bounded-search-required-probes",
  version: "1.0.0",
} as const;

export const SEARCH_DISPOSITIONS = [
  "found",
  "not-found-after-bounded-search",
  "search-still-productive",
  "search-incomplete",
  "search-blocked",
  "stopped-no-progress",
  "stopped-hard-ceiling",
] as const;
export type SearchDisposition = (typeof SEARCH_DISPOSITIONS)[number];

export const SEARCH_PROBE_STRATEGIES = [
  "exact-path",
  "filename-index",
  "dependency-manifest",
  "script-manifest",
  "ci-configuration",
  "documentation-inventory",
  "navigation-graph",
  "rubric-assessment",
  "tracked-text-index",
] as const;
export type SearchProbeStrategy = (typeof SEARCH_PROBE_STRATEGIES)[number];

export const SEARCH_LOCATION_CATEGORIES = [
  "repository-root",
  "tracked-files",
  "documentation-tree",
  "dependency-manifests",
  "script-manifests",
  "ci-configuration",
  "navigation",
] as const;
export type SearchLocationCategory = (typeof SEARCH_LOCATION_CATEGORIES)[number];

export const SEARCH_ARTIFACT_CLASSES = [
  "configuration",
  "dependency",
  "script",
  "ci-definition",
  "documentation-artifact",
  "navigation-entry",
] as const;
export type SearchArtifactClass = (typeof SEARCH_ARTIFACT_CLASSES)[number];

export const SEARCH_RUBRIC_CRITERION_KINDS = [
  "accuracy",
  "completeness",
  "navigation",
  "usability",
] as const;
export type SearchRubricCriterionKind = (typeof SEARCH_RUBRIC_CRITERION_KINDS)[number];

export const SEARCH_LIMITATION_CATEGORIES = [
  "access-denied",
  "hard-ceiling",
  "index-incomplete",
  "tool-failure",
  "unsupported-operation",
  "scope-excluded",
  "timeout",
  "evidence-unavailable",
] as const;
export type SearchLimitationCategory = (typeof SEARCH_LIMITATION_CATEGORIES)[number];

type RequiredProbePair = Readonly<{
  strategy: SearchProbeStrategy;
  location: SearchLocationCategory;
}>;

export const SEARCH_ARTIFACT_REQUIRED_PROBES: Readonly<
  Record<SearchArtifactClass, readonly RequiredProbePair[]>
> = deepFreeze({
  configuration: [
    { strategy: "exact-path", location: "repository-root" },
    { strategy: "filename-index", location: "tracked-files" },
  ],
  dependency: [
    { strategy: "dependency-manifest", location: "dependency-manifests" },
    { strategy: "tracked-text-index", location: "tracked-files" },
  ],
  script: [
    { strategy: "script-manifest", location: "script-manifests" },
    { strategy: "tracked-text-index", location: "tracked-files" },
  ],
  "ci-definition": [
    { strategy: "ci-configuration", location: "ci-configuration" },
    { strategy: "filename-index", location: "tracked-files" },
  ],
  "documentation-artifact": [
    { strategy: "exact-path", location: "documentation-tree" },
    { strategy: "documentation-inventory", location: "documentation-tree" },
  ],
  "navigation-entry": [
    { strategy: "navigation-graph", location: "navigation" },
    { strategy: "documentation-inventory", location: "documentation-tree" },
  ],
});

export const SEARCH_RUBRIC_REQUIRED_PROBES: Readonly<
  Record<SearchRubricCriterionKind, readonly RequiredProbePair[]>
> = deepFreeze({
  accuracy: [{ strategy: "rubric-assessment", location: "documentation-tree" }],
  completeness: [
    { strategy: "rubric-assessment", location: "documentation-tree" },
    { strategy: "documentation-inventory", location: "documentation-tree" },
  ],
  navigation: [
    { strategy: "rubric-assessment", location: "navigation" },
    { strategy: "navigation-graph", location: "navigation" },
  ],
  usability: [{ strategy: "rubric-assessment", location: "documentation-tree" }],
});

/**
 * Rubric version that opts into conjunctive criterion satisfaction. Version 1
 * targets retain the historical any-positive-probe behavior so existing run
 * records and workflow semantics remain stable.
 */
export const SEARCH_ALL_CRITERIA_RUBRIC_VERSION = "2.0.0-all-criteria" as const;

/** Any matched criterion confirms only after every required probe is assessed. */
export const SEARCH_COMPLETE_COVERAGE_RUBRIC_VERSION = "2.0.0-complete-coverage" as const;

export interface SearchRepositoryBindingV1 {
  identitySha256: string;
  revision: string;
}

export interface SearchProbeDeclarationV1 {
  id: string;
  strategy: SearchProbeStrategy;
  location: SearchLocationCategory;
}

export interface SearchRubricCriterionV1 {
  id: string;
  kind: SearchRubricCriterionKind;
  requiredProbeIds: string[];
}

interface SearchTargetBaseV1 {
  schemaVersion: 1;
  kind: "docsfab-search-target";
  id: string;
  targetKey: string;
  targetType: "artifact-existence" | "rubric-coverage";
  repository: SearchRepositoryBindingV1;
  subjectSha256: string;
  probePolicy: typeof SEARCH_REQUIRED_PROBE_POLICY;
  requiredProbes: SearchProbeDeclarationV1[];
  stableFindingId: string;
  targetSha256: string;
}

export interface ArtifactExistenceSearchTargetV1 extends SearchTargetBaseV1 {
  targetType: "artifact-existence";
  artifactClass: SearchArtifactClass;
}

export interface RubricCoverageSearchTargetV1 extends SearchTargetBaseV1 {
  targetType: "rubric-coverage";
  rubric: {
    id: string;
    version: string;
    criteria: SearchRubricCriterionV1[];
  };
}

export type SearchTargetV1 = ArtifactExistenceSearchTargetV1 | RubricCoverageSearchTargetV1;

export interface SearchCitationV1 {
  path: string;
  anchorSha256: string | null;
}

export type SearchProbeOutcome = "match" | "no-match" | "inconclusive" | "blocked";

export interface SearchProbeV1 {
  schemaVersion: 1;
  kind: "docsfab-search-probe";
  id: string;
  targetSha256: string;
  strategy: SearchProbeStrategy;
  location: SearchLocationCategory;
  scopeSha256: string;
  outcome: SearchProbeOutcome;
  matchCount: number;
  evidenceSha256: string;
  citations: SearchCitationV1[];
  probeSha256: string;
}

export interface SearchLimitationV1 {
  schemaVersion: 1;
  kind: "docsfab-search-limitation";
  id: string;
  targetSha256: string;
  category: SearchLimitationCategory;
  impact: "blocking" | "non-blocking";
  probeIds: string[];
  detailSha256: string;
  limitationSha256: string;
}

export interface SearchCriterionCoverageV1 {
  criterionId: string;
  probeIds: string[];
  status: "assessed" | "incomplete" | "blocked";
}

export interface SearchCoverageV1 {
  schemaVersion: 1;
  kind: "docsfab-search-coverage";
  targetSha256: string;
  requiredProbeIds: string[];
  completedProbeIds: string[];
  incompleteProbeIds: string[];
  probeSha256s: string[];
  limitationSha256s: string[];
  rubricCriteria: SearchCriterionCoverageV1[];
  blockerDisclosure: {
    status: "complete" | "incomplete";
    undisclosedBlockerCount: number;
  };
  sufficient: boolean;
  coverageSha256: string;
}

export type SearchSaturationBindingV1 =
  | { status: "saturated" | "productive"; observationSha256: string }
  | { status: "not-observed"; observationSha256: null };

export interface SearchConfidenceV1 {
  schemaVersion: 1;
  kind: "docsfab-search-confidence";
  targetSha256: string;
  coverageSha256: string;
  limitationSha256s: string[];
  disposition: SearchDisposition;
  level: "confirmed" | "bounded" | "inconclusive" | "blocked";
  saturation: SearchSaturationBindingV1;
  confidenceSha256: string;
}

export interface SearchFindingV1 {
  schemaVersion: 1;
  kind: "docsfab-search-finding";
  stableFindingId: string;
  targetSha256: string;
  repositoryRevision: string;
  disposition: SearchDisposition;
  findingClass: "presence" | "absence" | "inconclusive" | "blocked";
  coverageSha256: string;
  confidenceSha256: string;
  limitationSha256s: string[];
  citations: SearchCitationV1[];
  findingSha256: string;
}

export interface BoundedSearchEvidenceV1 {
  schemaVersion: 1;
  kind: "docsfab-bounded-search-evidence";
  target: SearchTargetV1;
  probes: SearchProbeV1[];
  limitations: SearchLimitationV1[];
  coverage: SearchCoverageV1;
  confidence: SearchConfidenceV1;
  finding: SearchFindingV1;
  evidenceSha256: string;
}

export type SearchTargetInput =
  | {
      id: string;
      targetKey: string;
      targetType: "artifact-existence";
      repository: SearchRepositoryBindingV1;
      subjectSha256: string;
      artifactClass: SearchArtifactClass;
      requiredProbes: SearchProbeDeclarationV1[];
    }
  | {
      id: string;
      targetKey: string;
      targetType: "rubric-coverage";
      repository: SearchRepositoryBindingV1;
      subjectSha256: string;
      requiredProbes: SearchProbeDeclarationV1[];
      rubric: {
        id: string;
        version: string;
        criteria: SearchRubricCriterionV1[];
      };
    };

export class BoundedSearchContractError extends Error {
  public readonly code:
    | "invalid-target"
    | "invalid-probe"
    | "invalid-limitation"
    | "invalid-coverage"
    | "invalid-confidence"
    | "invalid-finding"
    | "invalid-evidence"
    | "unsupported-schema";
  public constructor(
    code:
      | "invalid-target"
      | "invalid-probe"
      | "invalid-limitation"
      | "invalid-coverage"
      | "invalid-confidence"
      | "invalid-finding"
      | "invalid-evidence"
      | "unsupported-schema",
  ) {
    super(`Bounded search contract rejected: ${code}.`);
    this.code = code;
    this.name = "BoundedSearchContractError";
  }
}

function fail(code: BoundedSearchContractError["code"]): never {
  throw new BoundedSearchContractError(code);
}

type SearchContractKit = ReturnType<typeof createContractKit<BoundedSearchContractError["code"]>>;

const searchKits = new Map<BoundedSearchContractError["code"], SearchContractKit>();

function kitFor(code: BoundedSearchContractError["code"]): SearchContractKit {
  const existing = searchKits.get(code);
  if (existing) return existing;
  const created = createContractKit({
    fail: fail as ContractFail<BoundedSearchContractError["code"]>,
    inertMode: "strict",
    codes: {
      invalidShape: code,
      invalidValue: code,
      digestMismatch: code,
      credentialMaterial: code,
      schemaMismatch: code,
    },
  });
  searchKits.set(code, created);
  return created;
}

export function createSearchTarget(input: SearchTargetInput): SearchTargetV1 {
  const inputItem = object(input, "invalid-target");
  const commonKeys = [
    "id",
    "targetKey",
    "targetType",
    "repository",
    "subjectSha256",
    "requiredProbes",
  ];
  if (inputItem.targetType === "artifact-existence") {
    requireKeys(inputItem, [...commonKeys, "artifactClass"], "invalid-target");
  } else if (inputItem.targetType === "rubric-coverage") {
    requireKeys(inputItem, [...commonKeys, "rubric"], "invalid-target");
  } else {
    fail("invalid-target");
  }
  const stableIdentity =
    input.targetType === "artifact-existence"
      ? {
          schemaVersion: 1,
          repositoryIdentitySha256: input.repository.identitySha256,
          targetKey: input.targetKey,
          targetType: input.targetType,
          artifactClass: input.artifactClass,
          subjectSha256: input.subjectSha256,
          probePolicy: SEARCH_REQUIRED_PROBE_POLICY,
          requiredProbes: normalizedDeclarations(input.requiredProbes),
        }
      : {
          schemaVersion: 1,
          repositoryIdentitySha256: input.repository.identitySha256,
          targetKey: input.targetKey,
          targetType: input.targetType,
          subjectSha256: input.subjectSha256,
          probePolicy: SEARCH_REQUIRED_PROBE_POLICY,
          requiredProbes: normalizedDeclarations(input.requiredProbes),
          rubric: normalizedRubric(input.rubric),
        };
  requireInert(stableIdentity, "invalid-target");
  const common = {
    schemaVersion: 1 as const,
    kind: "docsfab-search-target" as const,
    id: input.id,
    targetKey: input.targetKey,
    targetType: input.targetType,
    repository: { ...input.repository },
    subjectSha256: input.subjectSha256,
    probePolicy: SEARCH_REQUIRED_PROBE_POLICY,
    requiredProbes: normalizedDeclarations(input.requiredProbes),
    stableFindingId: `search-finding:${hash(stableIdentity).slice(0, 32)}`,
  };
  const body =
    input.targetType === "artifact-existence"
      ? {
          ...common,
          targetType: input.targetType,
          artifactClass: input.artifactClass,
        }
      : {
          ...common,
          targetType: input.targetType,
          rubric: normalizedRubric(input.rubric),
        };
  requireInert(body, "invalid-target");
  return decodeSearchTarget({ ...body, targetSha256: hash(body) });
}

export function createSearchProbe(
  input: Omit<SearchProbeV1, "schemaVersion" | "kind" | "targetSha256" | "probeSha256">,
  targetValue: SearchTargetV1,
): SearchProbeV1 {
  requireKeys(
    object(input, "invalid-probe"),
    [
      "id",
      "strategy",
      "location",
      "scopeSha256",
      "outcome",
      "matchCount",
      "evidenceSha256",
      "citations",
    ],
    "invalid-probe",
  );
  const target = decodeSearchTarget(targetValue);
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-search-probe" as const,
    ...input,
    targetSha256: target.targetSha256,
    citations: normalizedCitations(input.citations),
  };
  requireInert(body, "invalid-probe");
  return decodeSearchProbe({ ...body, probeSha256: hash(body) }, target);
}

export function createSearchLimitation(
  input: Omit<SearchLimitationV1, "schemaVersion" | "kind" | "targetSha256" | "limitationSha256">,
  targetValue: SearchTargetV1,
  probes: readonly SearchProbeV1[],
): SearchLimitationV1 {
  requireKeys(
    object(input, "invalid-limitation"),
    ["id", "category", "impact", "probeIds", "detailSha256"],
    "invalid-limitation",
  );
  const target = decodeSearchTarget(targetValue);
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-search-limitation" as const,
    ...input,
    targetSha256: target.targetSha256,
    probeIds: sortedUnique(input.probeIds, "invalid-limitation"),
  };
  requireInert(body, "invalid-limitation");
  return decodeSearchLimitation({ ...body, limitationSha256: hash(body) }, target, probes);
}

export function createSearchCoverage(input: {
  target: SearchTargetV1;
  probes: readonly SearchProbeV1[];
  limitations: readonly SearchLimitationV1[];
  blockerDisclosure: SearchCoverageV1["blockerDisclosure"];
}): SearchCoverageV1 {
  requireKeys(
    object(input, "invalid-coverage"),
    ["target", "probes", "limitations", "blockerDisclosure"],
    "invalid-coverage",
  );
  const target = decodeSearchTarget(input.target);
  const probes = normalizedProbes(input.probes, target);
  const limitations = normalizedLimitations(input.limitations, target, probes);
  const disclosure = decodeBlockerDisclosure(input.blockerDisclosure, "invalid-coverage");
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-search-coverage" as const,
    ...createCoverageBody(target, probes, limitations, disclosure),
  };
  requireInert(body, "invalid-coverage");
  return decodeSearchCoverage({ ...body, coverageSha256: hash(body) }, target, probes, limitations);
}

export function createSearchConfidence(input: {
  target: SearchTargetV1;
  probes: readonly SearchProbeV1[];
  coverage: SearchCoverageV1;
  limitations: readonly SearchLimitationV1[];
  disposition: SearchDisposition;
  saturation: SearchSaturationBindingV1;
}): SearchConfidenceV1 {
  requireKeys(
    object(input, "invalid-confidence"),
    ["target", "probes", "coverage", "limitations", "disposition", "saturation"],
    "invalid-confidence",
  );
  const target = decodeSearchTarget(input.target);
  const probes = normalizedProbes(input.probes, target);
  const limitations = normalizedLimitations(input.limitations, target, probes);
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-search-confidence" as const,
    targetSha256: target.targetSha256,
    coverageSha256: input.coverage.coverageSha256,
    limitationSha256s: limitations.map((item) => item.limitationSha256).sort(),
    disposition: input.disposition,
    level: confidenceLevel(input.disposition),
    saturation: { ...input.saturation },
  };
  requireInert(body, "invalid-confidence");
  return decodeSearchConfidence(
    { ...body, confidenceSha256: hash(body) },
    target,
    probes,
    input.coverage,
    limitations,
  );
}

export function createSearchFinding(input: {
  target: SearchTargetV1;
  probes: readonly SearchProbeV1[];
  limitations: readonly SearchLimitationV1[];
  coverage: SearchCoverageV1;
  confidence: SearchConfidenceV1;
}): SearchFindingV1 {
  requireKeys(
    object(input, "invalid-finding"),
    ["target", "probes", "limitations", "coverage", "confidence"],
    "invalid-finding",
  );
  const target = decodeSearchTarget(input.target);
  const probes = normalizedProbes(input.probes, target);
  const limitations = normalizedLimitations(input.limitations, target, probes);
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-search-finding" as const,
    stableFindingId: target.stableFindingId,
    targetSha256: target.targetSha256,
    repositoryRevision: target.repository.revision,
    disposition: input.confidence.disposition,
    findingClass: findingClass(input.confidence.disposition),
    coverageSha256: input.coverage.coverageSha256,
    confidenceSha256: input.confidence.confidenceSha256,
    limitationSha256s: limitations.map((item) => item.limitationSha256).sort(),
    citations: normalizedCitations(probes.flatMap((probe) => probe.citations)),
  };
  requireInert(body, "invalid-finding");
  return decodeSearchFinding(
    { ...body, findingSha256: hash(body) },
    target,
    probes,
    limitations,
    input.coverage,
    input.confidence,
  );
}

export function createBoundedSearchEvidence(
  input: Omit<BoundedSearchEvidenceV1, "schemaVersion" | "kind" | "evidenceSha256">,
): BoundedSearchEvidenceV1 {
  requireKeys(
    object(input, "invalid-evidence"),
    ["target", "probes", "limitations", "coverage", "confidence", "finding"],
    "invalid-evidence",
  );
  const target = decodeSearchTarget(input.target);
  const probes = normalizedProbes(input.probes, target);
  const limitations = normalizedLimitations(input.limitations, target, probes);
  const coverage = decodeSearchCoverage(input.coverage, target, probes, limitations);
  const confidence = decodeSearchConfidence(
    input.confidence,
    target,
    probes,
    coverage,
    limitations,
  );
  const finding = decodeSearchFinding(
    input.finding,
    target,
    probes,
    limitations,
    coverage,
    confidence,
  );
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-bounded-search-evidence" as const,
    target,
    probes,
    limitations,
    coverage,
    confidence,
    finding,
  };
  requireInert(body, "invalid-evidence");
  return decodeBoundedSearchEvidence({ ...body, evidenceSha256: hash(body) });
}

export function serializeBoundedSearchEvidence(value: BoundedSearchEvidenceV1): string {
  return canonicalizeJsonEvidence(
    decodeBoundedSearchEvidence(value) as unknown as JsonEvidenceValue,
  );
}

export function parseBoundedSearchEvidence(
  input: string | Uint8Array | unknown,
): BoundedSearchEvidenceV1 {
  const value =
    typeof input === "string" || input instanceof Uint8Array
      ? parseJsonEvidence(input, { requireCanonical: true })
      : input;
  return decodeBoundedSearchEvidence(value);
}

export function decodeSearchTarget(value: unknown): SearchTargetV1 {
  const item = object(value, "invalid-target");
  const commonKeys = [
    "schemaVersion",
    "kind",
    "id",
    "targetKey",
    "targetType",
    "repository",
    "subjectSha256",
    "probePolicy",
    "requiredProbes",
    "stableFindingId",
    "targetSha256",
  ];
  if (item.targetType === "artifact-existence")
    requireKeys(item, [...commonKeys, "artifactClass"], "invalid-target");
  else if (item.targetType === "rubric-coverage")
    requireKeys(item, [...commonKeys, "rubric"], "invalid-target");
  else fail(item.schemaVersion === 1 ? "invalid-target" : "unsupported-schema");
  if (item.schemaVersion !== 1 || item.kind !== "docsfab-search-target") {
    fail(item.schemaVersion === 1 ? "invalid-target" : "unsupported-schema");
  }
  const repositoryItem = object(item.repository, "invalid-target");
  requireKeys(repositoryItem, ["identitySha256", "revision"], "invalid-target");
  const repository = {
    identitySha256: digest(repositoryItem.identitySha256, "invalid-target"),
    revision: revision(repositoryItem.revision, "invalid-target"),
  };
  const probePolicy = decodeProbePolicy(item.probePolicy);
  const requiredProbes = array(item.requiredProbes, "invalid-target").map(decodeDeclaration);
  if (
    requiredProbes.length < 2 ||
    new Set(requiredProbes.map((probe) => probe.id)).size !== requiredProbes.length ||
    new Set(requiredProbes.map((probe) => `${probe.strategy}:${probe.location}`)).size < 2
  ) {
    fail("invalid-target");
  }
  requiredProbes.sort(compareDeclaration);
  const base = {
    schemaVersion: 1 as const,
    kind: "docsfab-search-target" as const,
    id: safeId(item.id, "invalid-target"),
    targetKey: safeId(item.targetKey, "invalid-target"),
    targetType: item.targetType,
    repository,
    subjectSha256: digest(item.subjectSha256, "invalid-target"),
    probePolicy,
    requiredProbes,
    stableFindingId: stableFindingId(item.stableFindingId, "invalid-target"),
  };
  const body =
    item.targetType === "artifact-existence"
      ? {
          ...base,
          targetType: item.targetType,
          artifactClass: enumValue(item.artifactClass, SEARCH_ARTIFACT_CLASSES, "invalid-target"),
        }
      : {
          ...base,
          targetType: item.targetType,
          rubric: decodeRubric(item.rubric, requiredProbes),
        };
  if ("artifactClass" in body) {
    assertRequiredProbePairs(
      requiredProbes,
      SEARCH_ARTIFACT_REQUIRED_PROBES[body.artifactClass],
      "invalid-target",
    );
  }
  const stableIdentity =
    "artifactClass" in body
      ? {
          schemaVersion: 1,
          repositoryIdentitySha256: repository.identitySha256,
          targetKey: body.targetKey,
          targetType: body.targetType,
          artifactClass: body.artifactClass,
          subjectSha256: body.subjectSha256,
          probePolicy,
          requiredProbes,
        }
      : {
          schemaVersion: 1,
          repositoryIdentitySha256: repository.identitySha256,
          targetKey: body.targetKey,
          targetType: body.targetType,
          subjectSha256: body.subjectSha256,
          probePolicy,
          requiredProbes,
          rubric: body.rubric,
        };
  if (body.stableFindingId !== `search-finding:${hash(stableIdentity).slice(0, 32)}`) {
    fail("invalid-target");
  }
  const targetSha256 = assertCanonicalBody(item, "targetSha256", body, "invalid-target");
  assertContentMinimized(body, "invalid-target");
  return deepFreeze({ ...body, targetSha256 }) as SearchTargetV1;
}

export function decodeSearchProbe(value: unknown, targetValue: SearchTargetV1): SearchProbeV1 {
  const target = decodeSearchTarget(targetValue);
  const item = object(value, "invalid-probe");
  requireKeys(
    item,
    [
      "schemaVersion",
      "kind",
      "id",
      "targetSha256",
      "strategy",
      "location",
      "scopeSha256",
      "outcome",
      "matchCount",
      "evidenceSha256",
      "citations",
      "probeSha256",
    ],
    "invalid-probe",
  );
  if (item.schemaVersion !== 1 || item.kind !== "docsfab-search-probe") {
    fail(item.schemaVersion === 1 ? "invalid-probe" : "unsupported-schema");
  }
  const id = safeId(item.id, "invalid-probe");
  const declaration = target.requiredProbes.find((probe) => probe.id === id);
  if (!declaration || item.targetSha256 !== target.targetSha256) fail("invalid-probe");
  const outcome = enumValue(
    item.outcome,
    ["match", "no-match", "inconclusive", "blocked"] as const,
    "invalid-probe",
  );
  const matchCount = nonnegative(item.matchCount, "invalid-probe");
  const citations = normalizedCitations(
    array(item.citations, "invalid-probe") as unknown as SearchCitationV1[],
  );
  if ((outcome === "match") !== matchCount > 0 || (outcome === "match" && citations.length === 0))
    fail("invalid-probe");
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-search-probe" as const,
    id,
    targetSha256: target.targetSha256,
    strategy: enumValue(item.strategy, SEARCH_PROBE_STRATEGIES, "invalid-probe"),
    location: enumValue(item.location, SEARCH_LOCATION_CATEGORIES, "invalid-probe"),
    scopeSha256: digest(item.scopeSha256, "invalid-probe"),
    outcome,
    matchCount,
    evidenceSha256: digest(item.evidenceSha256, "invalid-probe"),
    citations,
  };
  if (body.strategy !== declaration.strategy || body.location !== declaration.location) {
    fail("invalid-probe");
  }
  const probeSha256 = assertCanonicalBody(item, "probeSha256", body, "invalid-probe");
  assertContentMinimized(body, "invalid-probe");
  return deepFreeze({ ...body, probeSha256 });
}

export function decodeSearchLimitation(
  value: unknown,
  targetValue: SearchTargetV1,
  probesValue: readonly SearchProbeV1[],
): SearchLimitationV1 {
  const target = decodeSearchTarget(targetValue);
  const probes = normalizedProbes(probesValue, target);
  const item = object(value, "invalid-limitation");
  requireKeys(
    item,
    [
      "schemaVersion",
      "kind",
      "id",
      "targetSha256",
      "category",
      "impact",
      "probeIds",
      "detailSha256",
      "limitationSha256",
    ],
    "invalid-limitation",
  );
  if (item.schemaVersion !== 1 || item.kind !== "docsfab-search-limitation") {
    fail(item.schemaVersion === 1 ? "invalid-limitation" : "unsupported-schema");
  }
  const category = enumValue(item.category, SEARCH_LIMITATION_CATEGORIES, "invalid-limitation");
  const impact = enumValue(
    item.impact,
    ["blocking", "non-blocking"] as const,
    "invalid-limitation",
  );
  const forcedBlocking: readonly SearchLimitationCategory[] = [
    "access-denied",
    "hard-ceiling",
    "index-incomplete",
    "tool-failure",
    "unsupported-operation",
    "timeout",
    "evidence-unavailable",
  ];
  if (forcedBlocking.includes(category) && impact !== "blocking") fail("invalid-limitation");
  const probeIds = sortedUnique(array(item.probeIds, "invalid-limitation"), "invalid-limitation");
  if (probeIds.length === 0) fail("invalid-limitation");
  const knownProbeIds = new Set(probes.map((probe) => probe.id));
  if (probeIds.some((id) => !knownProbeIds.has(id))) fail("invalid-limitation");
  if (
    impact === "blocking" &&
    probeIds.some((id) => probes.find((probe) => probe.id === id)?.outcome !== "blocked")
  ) {
    fail("invalid-limitation");
  }
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-search-limitation" as const,
    id: safeId(item.id, "invalid-limitation"),
    targetSha256: target.targetSha256,
    category,
    impact,
    probeIds,
    detailSha256: digest(item.detailSha256, "invalid-limitation"),
  };
  if (item.targetSha256 !== target.targetSha256) fail("invalid-limitation");
  const limitationSha256 = assertCanonicalBody(
    item,
    "limitationSha256",
    body,
    "invalid-limitation",
  );
  assertContentMinimized(body, "invalid-limitation");
  return deepFreeze({ ...body, limitationSha256 });
}

export function decodeSearchCoverage(
  value: unknown,
  targetValue: SearchTargetV1,
  probesValue: readonly SearchProbeV1[],
  limitationsValue: readonly SearchLimitationV1[],
): SearchCoverageV1 {
  const target = decodeSearchTarget(targetValue);
  const probes = normalizedProbes(probesValue, target);
  const limitations = normalizedLimitations(limitationsValue, target, probes);
  const item = object(value, "invalid-coverage");
  requireKeys(
    item,
    [
      "schemaVersion",
      "kind",
      "targetSha256",
      "requiredProbeIds",
      "completedProbeIds",
      "incompleteProbeIds",
      "probeSha256s",
      "limitationSha256s",
      "rubricCriteria",
      "blockerDisclosure",
      "sufficient",
      "coverageSha256",
    ],
    "invalid-coverage",
  );
  if (item.schemaVersion !== 1 || item.kind !== "docsfab-search-coverage") {
    fail(item.schemaVersion === 1 ? "invalid-coverage" : "unsupported-schema");
  }
  const expected = createCoverageBody(
    target,
    probes,
    limitations,
    decodeBlockerDisclosure(item.blockerDisclosure, "invalid-coverage"),
  );
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-search-coverage" as const,
    ...expected,
  };
  const supplied = { ...item };
  delete supplied.coverageSha256;
  if (
    canonicalizeJsonEvidence(supplied as JsonEvidenceValue) !==
    canonicalizeJsonEvidence(body as unknown as JsonEvidenceValue)
  )
    fail("invalid-coverage");
  const coverageSha256 = digest(item.coverageSha256, "invalid-coverage");
  verifyHash(coverageSha256, body, "invalid-coverage");
  assertContentMinimized(body, "invalid-coverage");
  return deepFreeze({ ...body, coverageSha256 });
}

export function decodeSearchConfidence(
  value: unknown,
  targetValue: SearchTargetV1,
  probesValue: readonly SearchProbeV1[],
  coverageValue: SearchCoverageV1,
  limitationsValue: readonly SearchLimitationV1[],
): SearchConfidenceV1 {
  const target = decodeSearchTarget(targetValue);
  const probes = normalizedProbes(probesValue, target);
  const limitations = normalizedLimitations(limitationsValue, target, probes);
  const item = object(value, "invalid-confidence");
  requireKeys(
    item,
    [
      "schemaVersion",
      "kind",
      "targetSha256",
      "coverageSha256",
      "limitationSha256s",
      "disposition",
      "level",
      "saturation",
      "confidenceSha256",
    ],
    "invalid-confidence",
  );
  if (item.schemaVersion !== 1 || item.kind !== "docsfab-search-confidence") {
    fail(item.schemaVersion === 1 ? "invalid-confidence" : "unsupported-schema");
  }
  const coverage = decodeSearchCoverage(coverageValue, target, probes, limitations);
  const disposition = enumValue(item.disposition, SEARCH_DISPOSITIONS, "invalid-confidence");
  const saturation = decodeSaturation(item.saturation, "invalid-confidence");
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-search-confidence" as const,
    targetSha256: target.targetSha256,
    coverageSha256: coverage.coverageSha256,
    limitationSha256s: limitations.map((limitation) => limitation.limitationSha256).sort(),
    disposition,
    level: confidenceLevel(disposition),
    saturation,
  };
  if (disposition !== dispositionFor(target, coverage, limitations, saturation, probes)) {
    fail("invalid-confidence");
  }
  const confidenceSha256 = assertCanonicalBody(
    item,
    "confidenceSha256",
    body,
    "invalid-confidence",
  );
  assertContentMinimized(body, "invalid-confidence");
  return deepFreeze({ ...body, confidenceSha256 });
}

export function decodeSearchFinding(
  value: unknown,
  targetValue: SearchTargetV1,
  probesValue: readonly SearchProbeV1[],
  limitationsValue: readonly SearchLimitationV1[],
  coverageValue: SearchCoverageV1,
  confidenceValue: SearchConfidenceV1,
): SearchFindingV1 {
  const target = decodeSearchTarget(targetValue);
  const probes = normalizedProbes(probesValue, target);
  const limitations = normalizedLimitations(limitationsValue, target, probes);
  const coverage = decodeSearchCoverage(coverageValue, target, probes, limitations);
  const confidence = decodeSearchConfidence(confidenceValue, target, probes, coverage, limitations);
  const item = object(value, "invalid-finding");
  requireKeys(
    item,
    [
      "schemaVersion",
      "kind",
      "stableFindingId",
      "targetSha256",
      "repositoryRevision",
      "disposition",
      "findingClass",
      "coverageSha256",
      "confidenceSha256",
      "limitationSha256s",
      "citations",
      "findingSha256",
    ],
    "invalid-finding",
  );
  if (item.schemaVersion !== 1 || item.kind !== "docsfab-search-finding") {
    fail(item.schemaVersion === 1 ? "invalid-finding" : "unsupported-schema");
  }
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-search-finding" as const,
    stableFindingId: target.stableFindingId,
    targetSha256: target.targetSha256,
    repositoryRevision: target.repository.revision,
    disposition: confidence.disposition,
    findingClass: findingClass(confidence.disposition),
    coverageSha256: coverage.coverageSha256,
    confidenceSha256: confidence.confidenceSha256,
    limitationSha256s: limitations.map((limitation) => limitation.limitationSha256).sort(),
    citations: normalizedCitations(probes.flatMap((probe) => probe.citations)),
  };
  if (
    confidence.disposition !==
    dispositionFor(target, coverage, limitations, confidence.saturation, probes)
  )
    fail("invalid-finding");
  const supplied = { ...item };
  delete supplied.findingSha256;
  if (
    canonicalizeJsonEvidence(supplied as JsonEvidenceValue) !==
    canonicalizeJsonEvidence(body as unknown as JsonEvidenceValue)
  )
    fail("invalid-finding");
  const findingSha256 = digest(item.findingSha256, "invalid-finding");
  verifyHash(findingSha256, body, "invalid-finding");
  assertContentMinimized(body, "invalid-finding");
  return deepFreeze({ ...body, findingSha256 });
}

export function decodeBoundedSearchEvidence(value: unknown): BoundedSearchEvidenceV1 {
  const item = object(value, "invalid-evidence");
  requireKeys(
    item,
    [
      "schemaVersion",
      "kind",
      "target",
      "probes",
      "limitations",
      "coverage",
      "confidence",
      "finding",
      "evidenceSha256",
    ],
    "invalid-evidence",
  );
  if (item.schemaVersion !== 1 || item.kind !== "docsfab-bounded-search-evidence") {
    fail(item.schemaVersion === 1 ? "invalid-evidence" : "unsupported-schema");
  }
  const target = decodeSearchTarget(item.target);
  const probes = normalizedProbes(
    array(item.probes, "invalid-evidence") as unknown as SearchProbeV1[],
    target,
  );
  const limitations = normalizedLimitations(
    array(item.limitations, "invalid-evidence") as unknown as SearchLimitationV1[],
    target,
    probes,
  );
  const coverage = decodeSearchCoverage(item.coverage, target, probes, limitations);
  const confidence = decodeSearchConfidence(item.confidence, target, probes, coverage, limitations);
  const finding = decodeSearchFinding(
    item.finding,
    target,
    probes,
    limitations,
    coverage,
    confidence,
  );
  const body = {
    schemaVersion: 1 as const,
    kind: "docsfab-bounded-search-evidence" as const,
    target,
    probes,
    limitations,
    coverage,
    confidence,
    finding,
  };
  const evidenceSha256 = assertCanonicalBody(item, "evidenceSha256", body, "invalid-evidence");
  assertContentMinimized(body, "invalid-evidence");
  return deepFreeze({ ...body, evidenceSha256 });
}

function createCoverageBody(
  target: SearchTargetV1,
  probes: SearchProbeV1[],
  limitations: SearchLimitationV1[],
  blockerDisclosure: SearchCoverageV1["blockerDisclosure"],
): Omit<SearchCoverageV1, "schemaVersion" | "kind" | "coverageSha256"> {
  const probeById = new Map(probes.map((probe) => [probe.id, probe]));
  const requiredProbeIds = target.requiredProbes.map((probe) => probe.id).sort();
  const completedProbeIds = requiredProbeIds.filter((id) => {
    const outcome = probeById.get(id)?.outcome;
    return outcome === "match" || outcome === "no-match";
  });
  const incompleteProbeIds = requiredProbeIds.filter((id) => !completedProbeIds.includes(id));
  const rubricCriteria =
    target.targetType === "rubric-coverage"
      ? target.rubric.criteria.map((criterion) => {
          const outcomes = criterion.requiredProbeIds.map((id) => probeById.get(id)?.outcome);
          return {
            criterionId: criterion.id,
            probeIds: [...criterion.requiredProbeIds],
            status: outcomes.some((outcome) => outcome === "blocked")
              ? ("blocked" as const)
              : outcomes.every((outcome) => outcome === "match" || outcome === "no-match")
                ? ("assessed" as const)
                : ("incomplete" as const),
          };
        })
      : [];
  const disclosedBlockingProbeIds = new Set(
    limitations
      .filter((limitation) => limitation.impact === "blocking")
      .flatMap((limitation) => limitation.probeIds),
  );
  const undisclosedBlockedProbeCount = probes.filter(
    (probe) => probe.outcome === "blocked" && !disclosedBlockingProbeIds.has(probe.id),
  ).length;
  if (
    (blockerDisclosure.status === "complete" && undisclosedBlockedProbeCount > 0) ||
    (blockerDisclosure.status === "incomplete" &&
      blockerDisclosure.undisclosedBlockerCount < undisclosedBlockedProbeCount)
  ) {
    fail("invalid-coverage");
  }
  const sufficient =
    incompleteProbeIds.length === 0 &&
    rubricCriteria.every((criterion) => criterion.status === "assessed") &&
    limitations.every((limitation) => limitation.impact !== "blocking") &&
    blockerDisclosure.status === "complete" &&
    blockerDisclosure.undisclosedBlockerCount === 0;
  return {
    targetSha256: target.targetSha256,
    requiredProbeIds,
    completedProbeIds,
    incompleteProbeIds,
    probeSha256s: probes.map((probe) => probe.probeSha256).sort(),
    limitationSha256s: limitations.map((limitation) => limitation.limitationSha256).sort(),
    rubricCriteria,
    blockerDisclosure,
    sufficient,
  };
}

function dispositionFor(
  target: SearchTargetV1,
  coverage: SearchCoverageV1,
  limitations: readonly SearchLimitationV1[],
  saturation: SearchSaturationBindingV1,
  probes: readonly SearchProbeV1[],
): SearchDisposition {
  const blocking = limitations.filter((limitation) => limitation.impact === "blocking");
  const hardCeiling = limitations.some((limitation) => limitation.category === "hard-ceiling");
  if (
    searchTargetSatisfied(target, probes) &&
    (!searchTargetRequiresCompleteCoverage(target) || coverage.sufficient)
  )
    return "found";
  if (hardCeiling) return "stopped-hard-ceiling";
  if (blocking.length > 0) return "search-blocked";
  if (saturation.status === "productive") return "search-still-productive";
  if (saturation.status === "saturated") {
    return coverage.sufficient &&
      !searchTargetSatisfied(target, probes) &&
      probes.every((probe) => probe.outcome === "match" || probe.outcome === "no-match")
      ? "not-found-after-bounded-search"
      : "stopped-no-progress";
  }
  return "search-incomplete";
}

export function searchTargetSatisfied(
  target: SearchTargetV1,
  probes: readonly SearchProbeV1[],
): boolean {
  if (
    target.targetType === "artifact-existence" ||
    (!searchTargetRequiresCompleteCoverage(target) && !searchTargetUsesAllCriteria(target))
  ) {
    return probes.some((probe) => probe.outcome === "match");
  }
  if (searchTargetRequiresCompleteCoverage(target)) {
    const byId = new Map(probes.map((probe) => [probe.id, probe]));
    return (
      target.requiredProbes.every((required) => {
        const outcome = byId.get(required.id)?.outcome;
        return outcome === "match" || outcome === "no-match";
      }) && probes.some((probe) => probe.outcome === "match")
    );
  }
  const byId = new Map(probes.map((probe) => [probe.id, probe]));
  return target.rubric.criteria.every((criterion) =>
    criterion.requiredProbeIds.every((id) => byId.get(id)?.outcome === "match"),
  );
}

export function searchTargetRequiresCompleteCoverage(target: SearchTargetV1): boolean {
  return (
    target.targetType === "rubric-coverage" &&
    target.rubric.version === SEARCH_COMPLETE_COVERAGE_RUBRIC_VERSION
  );
}

export function searchTargetUsesAllCriteria(target: SearchTargetV1): boolean {
  return (
    target.targetType === "rubric-coverage" &&
    target.rubric.version === SEARCH_ALL_CRITERIA_RUBRIC_VERSION
  );
}

function confidenceLevel(disposition: SearchDisposition): SearchConfidenceV1["level"] {
  if (disposition === "found") return "confirmed";
  if (disposition === "not-found-after-bounded-search") return "bounded";
  if (disposition === "search-blocked" || disposition === "stopped-hard-ceiling") return "blocked";
  return "inconclusive";
}

function findingClass(disposition: SearchDisposition): SearchFindingV1["findingClass"] {
  if (disposition === "found") return "presence";
  if (disposition === "not-found-after-bounded-search") return "absence";
  if (disposition === "search-blocked" || disposition === "stopped-hard-ceiling") return "blocked";
  return "inconclusive";
}

function decodeDeclaration(value: unknown): SearchProbeDeclarationV1 {
  const item = object(value, "invalid-target");
  requireKeys(item, ["id", "strategy", "location"], "invalid-target");
  return {
    id: safeId(item.id, "invalid-target"),
    strategy: enumValue(item.strategy, SEARCH_PROBE_STRATEGIES, "invalid-target"),
    location: enumValue(item.location, SEARCH_LOCATION_CATEGORIES, "invalid-target"),
  };
}

function decodeProbePolicy(value: unknown): typeof SEARCH_REQUIRED_PROBE_POLICY {
  const item = object(value, "invalid-target");
  requireKeys(item, ["id", "version"], "invalid-target");
  if (
    item.id !== SEARCH_REQUIRED_PROBE_POLICY.id ||
    item.version !== SEARCH_REQUIRED_PROBE_POLICY.version
  )
    fail("invalid-target");
  return SEARCH_REQUIRED_PROBE_POLICY;
}

function decodeRubric(value: unknown, declarations: SearchProbeDeclarationV1[]) {
  const item = object(value, "invalid-target");
  requireKeys(item, ["id", "version", "criteria"], "invalid-target");
  const declared = new Set(declarations.map((probe) => probe.id));
  const criteria = array(item.criteria, "invalid-target")
    .map((candidate) => {
      const criterion = object(candidate, "invalid-target");
      requireKeys(criterion, ["id", "kind", "requiredProbeIds"], "invalid-target");
      const kind = enumValue(criterion.kind, SEARCH_RUBRIC_CRITERION_KINDS, "invalid-target");
      const requiredProbeIds = sortedUnique(
        array(criterion.requiredProbeIds, "invalid-target"),
        "invalid-target",
      );
      if (requiredProbeIds.length === 0 || requiredProbeIds.some((id) => !declared.has(id))) {
        fail("invalid-target");
      }
      const criterionDeclarations = declarations.filter((declaration) =>
        requiredProbeIds.includes(declaration.id),
      );
      assertRequiredProbePairs(
        criterionDeclarations,
        SEARCH_RUBRIC_REQUIRED_PROBES[kind],
        "invalid-target",
      );
      return {
        id: safeId(criterion.id, "invalid-target"),
        kind,
        requiredProbeIds,
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
  if (
    criteria.length === 0 ||
    new Set(criteria.map((criterion) => criterion.id)).size !== criteria.length ||
    declarations.some(
      (probe) =>
        criteria.filter((criterion) => criterion.requiredProbeIds.includes(probe.id)).length !== 1,
    )
  ) {
    fail("invalid-target");
  }
  return {
    id: safeId(item.id, "invalid-target"),
    version: safeId(item.version, "invalid-target"),
    criteria,
  };
}

function normalizedDeclarations(value: SearchProbeDeclarationV1[]): SearchProbeDeclarationV1[] {
  return value.map((item) => ({ ...item })).sort(compareDeclaration);
}

function normalizedRubric(value: RubricCoverageSearchTargetV1["rubric"]) {
  return {
    id: value.id,
    version: value.version,
    criteria: value.criteria
      .map((criterion) => ({
        id: criterion.id,
        kind: criterion.kind,
        requiredProbeIds: [...criterion.requiredProbeIds].sort(),
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
}

function assertRequiredProbePairs(
  declarations: readonly SearchProbeDeclarationV1[],
  required: readonly RequiredProbePair[],
  code: BoundedSearchContractError["code"],
): void {
  if (
    required.some(
      (pair) =>
        !declarations.some(
          (declaration) =>
            declaration.strategy === pair.strategy && declaration.location === pair.location,
        ),
    )
  ) {
    fail(code);
  }
}

function normalizedProbes(
  values: readonly SearchProbeV1[],
  target: SearchTargetV1,
): SearchProbeV1[] {
  requireInert(values, "invalid-probe");
  const probes = values
    .map((probe) => decodeSearchProbe(probe, target))
    .sort((left, right) => left.id.localeCompare(right.id));
  if (new Set(probes.map((probe) => probe.id)).size !== probes.length) fail("invalid-probe");
  return probes;
}

function normalizedLimitations(
  values: readonly SearchLimitationV1[],
  target: SearchTargetV1,
  probes: readonly SearchProbeV1[],
): SearchLimitationV1[] {
  requireInert(values, "invalid-limitation");
  const limitations = values
    .map((value) => decodeSearchLimitation(value, target, probes))
    .sort((left, right) => left.id.localeCompare(right.id));
  if (new Set(limitations.map((limitation) => limitation.id)).size !== limitations.length) {
    fail("invalid-limitation");
  }
  return limitations;
}

function normalizedCitations(values: readonly SearchCitationV1[]): SearchCitationV1[] {
  const citations = values
    .map((value) => {
      const item = object(value, "invalid-probe");
      requireKeys(item, ["path", "anchorSha256"], "invalid-probe");
      return {
        path: relativePath(item.path, "invalid-probe"),
        anchorSha256:
          item.anchorSha256 === null ? null : digest(item.anchorSha256, "invalid-probe"),
      };
    })
    .sort((left, right) =>
      `${left.path}:${left.anchorSha256 ?? ""}`.localeCompare(
        `${right.path}:${right.anchorSha256 ?? ""}`,
      ),
    );
  const identities = citations.map((citation) => `${citation.path}:${citation.anchorSha256 ?? ""}`);
  return identities.some((identity, index) => identity === identities[index - 1])
    ? fail("invalid-probe")
    : citations;
}

function decodeBlockerDisclosure(
  value: unknown,
  code: BoundedSearchContractError["code"],
): SearchCoverageV1["blockerDisclosure"] {
  const item = object(value, code);
  requireKeys(item, ["status", "undisclosedBlockerCount"], code);
  const status = enumValue(item.status, ["complete", "incomplete"] as const, code);
  const undisclosedBlockerCount = nonnegative(item.undisclosedBlockerCount, code);
  if ((status === "complete") !== (undisclosedBlockerCount === 0)) fail(code);
  return { status, undisclosedBlockerCount };
}

function decodeSaturation(
  value: unknown,
  code: BoundedSearchContractError["code"],
): SearchSaturationBindingV1 {
  const item = object(value, code);
  requireKeys(item, ["status", "observationSha256"], code);
  const status = enumValue(item.status, ["saturated", "productive", "not-observed"] as const, code);
  if (status === "not-observed") {
    if (item.observationSha256 !== null) fail(code);
    return { status, observationSha256: null };
  }
  return { status, observationSha256: digest(item.observationSha256, code) };
}

function requireInert(value: unknown, code: BoundedSearchContractError["code"]): void {
  kitFor(code).assertInert(value);
}

function requireKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  code: BoundedSearchContractError["code"],
): void {
  kitFor(code).exact(value, keys);
}

function object(value: unknown, code: BoundedSearchContractError["code"]): Record<string, unknown> {
  requireInert(value, code);
  return kitFor(code).object(value);
}

function array(value: unknown, code: BoundedSearchContractError["code"]): unknown[] {
  return kitFor(code).array(value);
}

function enumValue<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  code: BoundedSearchContractError["code"],
): T[number] {
  return kitFor(code).enumeration(value, allowed);
}

function digest(value: unknown, code: BoundedSearchContractError["code"]): string {
  return kitFor(code).hash(value);
}

function revision(value: unknown, code: BoundedSearchContractError["code"]): string {
  return kitFor(code).revision(value);
}

function safeId(value: unknown, code: BoundedSearchContractError["code"]): string {
  if (
    typeof value !== "string" ||
    !/^[a-z0-9][a-z0-9._:-]{0,127}$/u.test(value) ||
    value.includes("..") ||
    containsConfiguredCredential(value)
  )
    fail(code);
  return value;
}

function stableFindingId(value: unknown, code: BoundedSearchContractError["code"]): string {
  if (typeof value !== "string" || !/^search-finding:[a-f0-9]{32}$/u.test(value)) fail(code);
  return value;
}

function relativePath(value: unknown, code: BoundedSearchContractError["code"]): string {
  if (
    typeof value !== "string" ||
    value !== value.normalize("NFC") ||
    value.length === 0 ||
    value.length > 512 ||
    value.includes("\0") ||
    !/^[A-Za-z0-9._+/-]+$/u.test(value) ||
    value.includes("\\") ||
    isAbsolute(value) ||
    /^[A-Za-z]:/u.test(value) ||
    value.split("/").some((part) => !part || part === "." || part === "..") ||
    containsConfiguredCredential(value)
  )
    fail(code);
  return value;
}

function nonnegative(value: unknown, code: BoundedSearchContractError["code"]): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) fail(code);
  return value;
}

function sortedUnique(
  value: readonly unknown[],
  code: BoundedSearchContractError["code"],
): string[] {
  const result = value.map((item) => safeId(item, code)).sort();
  if (new Set(result).size !== result.length) fail(code);
  return result;
}

function compareDeclaration(
  left: SearchProbeDeclarationV1,
  right: SearchProbeDeclarationV1,
): number {
  return left.id.localeCompare(right.id);
}

function hash(value: unknown): string {
  return createHash("sha256")
    .update(canonicalizeJsonEvidence(value as JsonEvidenceValue))
    .digest("hex");
}

function verifyHash(value: unknown, body: unknown, code: BoundedSearchContractError["code"]): void {
  if (digest(value, code) !== hash(body)) fail(code);
}

function assertCanonicalBody(
  item: Record<string, unknown>,
  digestKey: string,
  body: unknown,
  code: BoundedSearchContractError["code"],
): string {
  const supplied = { ...item };
  delete supplied[digestKey];
  if (
    canonicalizeJsonEvidence(supplied as JsonEvidenceValue) !==
    canonicalizeJsonEvidence(body as JsonEvidenceValue)
  )
    fail(code);
  const value = digest(item[digestKey], code);
  verifyHash(value, body, code);
  return value;
}

function assertContentMinimized(value: unknown, code: BoundedSearchContractError["code"]): void {
  kitFor(code).rejectCredentials(value);
}
