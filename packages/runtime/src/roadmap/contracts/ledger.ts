// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { ARTIFACT_KINDS, type ArtifactReference } from "../../artifacts/contracts.js";
import type { RepositoryIdentity } from "../../content-ir/contracts.js";
import {
  internalRoadmapDecode,
  roadmapCanonicalJson,
  roadmapDigest,
  type RoadmapContractErrorCode,
} from "./decode.js";

const {
  closed,
  array,
  safeText,
  identifier,
  externalIdentifier,
  timestamp,
  digest,
  revision,
  positiveInteger,
  enumeration,
  safePath,
  idArray,
  digestArray,
  pathArray,
  requireUnique,
  requireReferences,
  sameStringSet,
  assertAcyclic,
  compareRoadmap,
  compareText,
  freeze,
  constants: { PROVIDER_IDENTIFIER, HOST },
  identifierCarriesConfiguredCredential,
} = internalRoadmapDecode;

const requireValue: (
  condition: unknown,
  code: RoadmapContractErrorCode,
  path: string,
) => asserts condition = internalRoadmapDecode.requireValue;

export const ROADMAP_LEDGER_SCHEMA_VERSION = 1 as const;

export const ROADMAP_LIFECYCLE_STATES = [
  "observed",
  "proposed",
  "filed",
  "selected",
  "in-progress",
  "fixed",
  "verified",
  "closed",
  "blocked",
  "duplicate",
  "superseded",
] as const;
export type RoadmapLifecycleState = (typeof ROADMAP_LIFECYCLE_STATES)[number];

export const ROADMAP_EVIDENCE_KINDS = [
  "docsfab-run",
  "artifact",
  "patch",
  "validation",
  "commit",
  "merge-request",
  "human-attestation",
] as const;
export type RoadmapEvidenceKind = (typeof ROADMAP_EVIDENCE_KINDS)[number];

export interface RoadmapProjectIdentity {
  provider: string;
  host: string;
  fullPath: string;
  projectId: number;
}

export interface RoadmapDiscoveryBoundary {
  id: string;
  mode: "release" | "documentation-health";
  observedAt: string;
  queryDigest: string;
  fromRevision?: string;
  toRevision?: string;
}

export interface RoadmapTrackerObservation {
  issueIid: number;
  state: "opened" | "closed";
  updatedAt: string;
  identityDigest: string;
}

export interface RoadmapEvidenceReference {
  id: string;
  kind: RoadmapEvidenceKind;
  digest: string;
  repositoryRevision?: string;
  path?: string;
  externalId?: string;
  artifact?: ArtifactReference;
}

export interface RoadmapFindingMaterial {
  boundaryId: string;
  category: string;
  severity: "p0" | "p1" | "p2";
  affectedPaths: string[];
  evidenceIds: string[];
  materialEvidenceDigest: string;
}

export interface RoadmapFinding extends RoadmapFindingMaterial {
  id: string;
  fingerprint: string;
  source: "release" | "documentation-health";
  disposition:
    | "documented"
    | "no-doc-impact"
    | "needs-update"
    | "needs-new-doc"
    | "healthy"
    | "repair"
    | "restructure"
    | "investigate"
    | "excluded"
    | "blocked"
    | "duplicate";
  lifecycle: RoadmapLifecycleState;
  dependsOnFindingIds: string[];
}

export interface RoadmapWorkstream {
  id: string;
  findingIds: string[];
  dependsOnWorkstreamIds: string[];
  collidesWithWorkstreamIds: string[];
  executionOrder: number;
  state: "planned" | "ready" | "blocked" | "complete";
}

export interface RoadmapDedupDecision {
  findingId: string;
  decision: "create" | "reuse" | "duplicate" | "supersede";
  issueIid?: number;
  observedUpdatedAt?: string;
  rationaleCode: string;
}

export interface RoadmapLifecycleTransition {
  id: string;
  findingId: string;
  from: RoadmapLifecycleState;
  to: RoadmapLifecycleState;
  at: string;
  reasonCode: string;
  evidenceIds: string[];
}

export interface RoadmapSweep {
  id: string;
  observedAt: string;
  repositoryRevision: string;
  trackerObservedAt: string;
  findingFingerprints: string[];
  newFindingIds: string[];
  disposition: "clean" | "new-findings" | "blocked";
}

export interface RoadmapCloseoutDecision {
  id: string;
  targetKey: string;
  findingIds: string[];
  decision: "close" | "keep-open" | "reopen";
  decidedAt: string;
  reasonCode: string;
  evidenceIds: string[];
  supplementalSweepId: string;
}

export interface RoadmapLedger {
  kind: "roadmap-ledger";
  schemaVersion: typeof ROADMAP_LEDGER_SCHEMA_VERSION;
  id: string;
  repository: RepositoryIdentity;
  project: RoadmapProjectIdentity;
  boundary: RoadmapDiscoveryBoundary;
  trackerObservedAt: string;
  tracker: RoadmapTrackerObservation[];
  evidence: RoadmapEvidenceReference[];
  findings: RoadmapFinding[];
  workstreams: RoadmapWorkstream[];
  dedup: RoadmapDedupDecision[];
  transitions: RoadmapLifecycleTransition[];
  sweeps: RoadmapSweep[];
  closeouts: RoadmapCloseoutDecision[];
  createdAt: string;
  updatedAt: string;
  digest: string;
}

const TRANSITIONS: Readonly<Record<RoadmapLifecycleState, readonly RoadmapLifecycleState[]>> = {
  observed: ["proposed", "blocked", "duplicate", "superseded"],
  proposed: ["filed", "blocked", "duplicate", "superseded"],
  filed: ["selected", "in-progress", "blocked", "duplicate", "superseded"],
  selected: ["in-progress", "blocked", "duplicate", "superseded"],
  "in-progress": ["fixed", "blocked", "duplicate", "superseded"],
  fixed: ["verified", "in-progress", "blocked"],
  verified: ["closed", "in-progress", "blocked"],
  closed: ["observed"],
  blocked: ["observed", "proposed", "selected", "in-progress", "duplicate", "superseded"],
  duplicate: ["observed"],
  superseded: ["observed"],
};

export function roadmapFindingFingerprint(material: RoadmapFindingMaterial): string {
  const normalized = validateFindingMaterial(material, "$.material");
  return roadmapDigest(normalized);
}

export function createRoadmapLedger(
  input: Omit<RoadmapLedger, "kind" | "schemaVersion" | "digest">,
): RoadmapLedger {
  const candidate = {
    kind: "roadmap-ledger" as const,
    schemaVersion: ROADMAP_LEDGER_SCHEMA_VERSION,
    ...input,
    digest: "0".repeat(64),
  };
  candidate.digest = roadmapDigest(candidate);
  return validateRoadmapLedger(candidate);
}

export function validateRoadmapLedger(value: unknown): RoadmapLedger {
  const root = closed(value, "$", [
    "kind",
    "schemaVersion",
    "id",
    "repository",
    "project",
    "boundary",
    "trackerObservedAt",
    "tracker",
    "evidence",
    "findings",
    "workstreams",
    "dedup",
    "transitions",
    "sweeps",
    "closeouts",
    "createdAt",
    "updatedAt",
    "digest",
  ]);
  requireValue(
    root.kind === "roadmap-ledger" && root.schemaVersion === ROADMAP_LEDGER_SCHEMA_VERSION,
    "invalid-value",
    "$",
  );
  const ledger: RoadmapLedger = {
    kind: "roadmap-ledger",
    schemaVersion: ROADMAP_LEDGER_SCHEMA_VERSION,
    id: identifier(root.id, "$.id"),
    repository: repository(root.repository, "$.repository"),
    project: project(root.project, "$.project"),
    boundary: boundary(root.boundary, "$.boundary"),
    trackerObservedAt: timestamp(root.trackerObservedAt, "$.trackerObservedAt"),
    tracker: array(root.tracker, "$.tracker")
      .map((item, index) => trackerObservation(item, `$.tracker[${index}]`))
      .sort(compareRoadmap),
    evidence: array(root.evidence, "$.evidence")
      .map((item, index) => evidenceReference(item, `$.evidence[${index}]`))
      .sort(compareRoadmap),
    findings: array(root.findings, "$.findings")
      .map((item, index) => finding(item, `$.findings[${index}]`))
      .sort(compareRoadmap),
    workstreams: array(root.workstreams, "$.workstreams")
      .map((item, index) => workstream(item, `$.workstreams[${index}]`))
      .sort(compareRoadmap),
    dedup: array(root.dedup, "$.dedup")
      .map((item, index) => dedupDecision(item, `$.dedup[${index}]`))
      .sort(compareRoadmap),
    transitions: array(root.transitions, "$.transitions")
      .map((item, index) => transition(item, `$.transitions[${index}]`))
      .sort(compareRoadmap),
    sweeps: array(root.sweeps, "$.sweeps")
      .map((item, index) => sweep(item, `$.sweeps[${index}]`))
      .sort(compareRoadmap),
    closeouts: array(root.closeouts, "$.closeouts")
      .map((item, index) => closeout(item, `$.closeouts[${index}]`))
      .sort(compareRoadmap),
    createdAt: timestamp(root.createdAt, "$.createdAt"),
    updatedAt: timestamp(root.updatedAt, "$.updatedAt"),
    digest: digest(root.digest, "$.digest"),
  };
  validateLedgerRelations(ledger);
  requireValue(
    Date.parse(ledger.createdAt) <= Date.parse(ledger.updatedAt),
    "invalid-time",
    "$.updatedAt",
  );
  requireValue(
    Date.parse(ledger.boundary.observedAt) <= Date.parse(ledger.trackerObservedAt),
    "invalid-time",
    "$.trackerObservedAt",
  );
  requireValue(roadmapDigest(ledger) === ledger.digest, "digest-mismatch", "$.digest");
  return freeze(ledger);
}

function validateLedgerRelations(ledger: RoadmapLedger): void {
  requireUnique(
    ledger.tracker.map((item) => String(item.issueIid)),
    "$.tracker",
  );
  requireUnique(
    ledger.evidence.map((item) => item.id),
    "$.evidence",
  );
  requireUnique(
    ledger.findings.map((item) => item.id),
    "$.findings",
  );
  requireUnique(
    ledger.findings.map((item) => item.fingerprint),
    "$.findings",
  );
  requireUnique(
    ledger.workstreams.map((item) => item.id),
    "$.workstreams",
  );
  requireUnique(
    ledger.dedup.map((item) => item.findingId),
    "$.dedup",
  );
  requireUnique(
    ledger.transitions.map((item) => item.id),
    "$.transitions",
  );
  requireUnique(
    ledger.sweeps.map((item) => item.id),
    "$.sweeps",
  );
  requireUnique(
    ledger.closeouts.map((item) => item.id),
    "$.closeouts",
  );
  const evidence = new Set(ledger.evidence.map((item) => item.id));
  const findings = new Map(ledger.findings.map((item) => [item.id, item]));
  const workstreams = new Map(ledger.workstreams.map((item) => [item.id, item]));
  const sweeps = new Set(ledger.sweeps.map((item) => item.id));
  const tracker = new Map(ledger.tracker.map((item) => [item.issueIid, item]));
  requireValue(
    sameStringSet(
      ledger.dedup.map((item) => item.findingId),
      [...findings.keys()],
    ),
    "unresolved-reference",
    "$.dedup",
  );
  if (ledger.boundary.mode === "release") {
    requireValue(
      ledger.boundary.toRevision === ledger.repository.revision,
      "repository-mismatch",
      "$.boundary.toRevision",
    );
  }
  for (const item of ledger.tracker) {
    requireValue(
      Date.parse(item.updatedAt) <= Date.parse(ledger.trackerObservedAt),
      "invalid-time",
      `$.tracker.${item.issueIid}.updatedAt`,
    );
  }
  for (const item of ledger.evidence) {
    if (item.repositoryRevision) {
      requireValue(
        item.repositoryRevision === ledger.repository.revision,
        "repository-mismatch",
        `$.evidence.${item.id}.repositoryRevision`,
      );
    }
    if (item.kind === "artifact") {
      requireValue(
        item.artifact !== undefined && item.artifact.digest === item.digest,
        "digest-mismatch",
        `$.evidence.${item.id}.artifact`,
      );
    } else {
      requireValue(item.artifact === undefined, "invalid-value", `$.evidence.${item.id}.artifact`);
    }
    if (item.artifact) {
      requireValue(
        item.artifact.repositoryRevision === ledger.repository.revision &&
          item.artifact.repositoryContentDigest === ledger.repository.contentDigest,
        "repository-mismatch",
        `$.evidence.${item.id}.artifact`,
      );
    }
  }
  for (const item of ledger.findings) {
    requireValue(item.evidenceIds.length > 0, "missing-field", `$.findings.${item.id}.evidenceIds`);
    requireValue(
      item.boundaryId === ledger.boundary.id,
      "unresolved-reference",
      `$.findings.${item.id}.boundaryId`,
    );
    requireReferences(item.evidenceIds, evidence, `$.findings.${item.id}.evidenceIds`);
    requireReferences(
      item.dependsOnFindingIds,
      new Set(findings.keys()),
      `$.findings.${item.id}.dependsOnFindingIds`,
    );
    requireValue(
      roadmapFindingFingerprint(item) === item.fingerprint,
      "digest-mismatch",
      `$.findings.${item.id}.fingerprint`,
    );
    requireValue(
      item.source === ledger.boundary.mode,
      "invalid-value",
      `$.findings.${item.id}.source`,
    );
    const releaseDisposition = [
      "documented",
      "no-doc-impact",
      "needs-update",
      "needs-new-doc",
      "blocked",
      "duplicate",
    ].includes(item.disposition);
    requireValue(
      (item.source === "release") === releaseDisposition,
      "invalid-value",
      `$.findings.${item.id}.disposition`,
    );
  }
  assertAcyclic([...findings.keys()], (id) => findings.get(id)!.dependsOnFindingIds, "$.findings");
  for (const item of ledger.workstreams) {
    requireReferences(
      item.findingIds,
      new Set(findings.keys()),
      `$.workstreams.${item.id}.findingIds`,
    );
    requireReferences(
      item.dependsOnWorkstreamIds,
      new Set(workstreams.keys()),
      `$.workstreams.${item.id}.dependsOnWorkstreamIds`,
    );
    requireReferences(
      item.collidesWithWorkstreamIds,
      new Set(workstreams.keys()),
      `$.workstreams.${item.id}.collidesWithWorkstreamIds`,
    );
    requireValue(
      !item.collidesWithWorkstreamIds.includes(item.id),
      "unresolved-dependency",
      `$.workstreams.${item.id}.collidesWithWorkstreamIds`,
    );
    for (const collision of item.collidesWithWorkstreamIds) {
      requireValue(
        workstreams.get(collision)!.collidesWithWorkstreamIds.includes(item.id),
        "unresolved-dependency",
        `$.workstreams.${item.id}.collidesWithWorkstreamIds`,
      );
    }
    for (const dependency of item.dependsOnWorkstreamIds) {
      requireValue(
        workstreams.get(dependency)!.executionOrder < item.executionOrder,
        "unresolved-dependency",
        `$.workstreams.${item.id}.executionOrder`,
      );
    }
  }
  assertAcyclic(
    [...workstreams.keys()],
    (id) => workstreams.get(id)!.dependsOnWorkstreamIds,
    "$.workstreams",
  );
  for (const item of ledger.dedup) {
    requireValue(findings.has(item.findingId), "unresolved-reference", `$.dedup.${item.findingId}`);
    if (item.decision === "create") {
      requireValue(
        item.issueIid === undefined && item.observedUpdatedAt === undefined,
        "invalid-value",
        `$.dedup.${item.findingId}`,
      );
    } else {
      requireValue(
        item.issueIid !== undefined && item.observedUpdatedAt !== undefined,
        "missing-field",
        `$.dedup.${item.findingId}`,
      );
      requireValue(
        tracker.get(item.issueIid!)?.updatedAt === item.observedUpdatedAt,
        "tracker-drift",
        `$.dedup.${item.findingId}.observedUpdatedAt`,
      );
    }
  }
  const transitionsByFinding = new Map<string, RoadmapLifecycleTransition[]>();
  for (const item of [...ledger.transitions].sort((left, right) =>
    compareText(left.at, right.at),
  )) {
    requireValue(
      findings.has(item.findingId),
      "unresolved-reference",
      `$.transitions.${item.id}.findingId`,
    );
    requireReferences(item.evidenceIds, evidence, `$.transitions.${item.id}.evidenceIds`);
    requireValue(
      TRANSITIONS[item.from].includes(item.to),
      "invalid-transition",
      `$.transitions.${item.id}`,
    );
    requireValue(
      Date.parse(item.at) <= Date.parse(ledger.updatedAt),
      "invalid-time",
      `$.transitions.${item.id}.at`,
    );
    const chain = transitionsByFinding.get(item.findingId) ?? [];
    if (chain.length === 0) {
      requireValue(item.from === "observed", "invalid-transition", `$.transitions.${item.id}.from`);
    } else {
      requireValue(
        chain.at(-1)!.to === item.from,
        "invalid-transition",
        `$.transitions.${item.id}.from`,
      );
      requireValue(
        Date.parse(chain.at(-1)!.at) < Date.parse(item.at),
        "invalid-time",
        `$.transitions.${item.id}.at`,
      );
    }
    chain.push(item);
    transitionsByFinding.set(item.findingId, chain);
  }
  for (const item of ledger.findings) {
    const chain = transitionsByFinding.get(item.id) ?? [];
    requireValue(
      (chain.at(-1)?.to ?? "observed") === item.lifecycle,
      "invalid-transition",
      `$.findings.${item.id}.lifecycle`,
    );
  }
  for (const item of ledger.sweeps) {
    requireValue(
      item.repositoryRevision === ledger.repository.revision,
      "repository-mismatch",
      `$.sweeps.${item.id}.repositoryRevision`,
    );
    requireReferences(
      item.newFindingIds,
      new Set(findings.keys()),
      `$.sweeps.${item.id}.newFindingIds`,
    );
    requireValue(
      sameStringSet(
        item.findingFingerprints,
        ledger.findings.map((findingItem) => findingItem.fingerprint),
      ),
      "unresolved-reference",
      `$.sweeps.${item.id}.findingFingerprints`,
    );
    requireValue(
      (item.disposition === "new-findings") === item.newFindingIds.length > 0,
      "invalid-value",
      `$.sweeps.${item.id}.disposition`,
    );
    if (item.disposition === "clean") {
      requireValue(
        item.newFindingIds.length === 0,
        "invalid-value",
        `$.sweeps.${item.id}.newFindingIds`,
      );
    }
    requireValue(
      Date.parse(item.observedAt) <= Date.parse(item.trackerObservedAt) &&
        Date.parse(item.trackerObservedAt) <= Date.parse(ledger.updatedAt),
      "invalid-time",
      `$.sweeps.${item.id}`,
    );
  }
  for (const item of ledger.closeouts) {
    requireValue(
      sweeps.has(item.supplementalSweepId),
      "unresolved-reference",
      `$.closeouts.${item.id}.supplementalSweepId`,
    );
    requireReferences(item.evidenceIds, evidence, `$.closeouts.${item.id}.evidenceIds`);
    requireValue(item.findingIds.length > 0, "missing-field", `$.closeouts.${item.id}.findingIds`);
    requireReferences(
      item.findingIds,
      new Set(findings.keys()),
      `$.closeouts.${item.id}.findingIds`,
    );
    const closeSweep = ledger.sweeps.find(
      (sweepItem) => sweepItem.id === item.supplementalSweepId,
    )!;
    if (item.decision === "close") {
      requireValue(
        item.evidenceIds.length > 0,
        "missing-field",
        `$.closeouts.${item.id}.evidenceIds`,
      );
      requireValue(
        closeSweep.disposition === "clean",
        "unresolved-dependency",
        `$.closeouts.${item.id}`,
      );
      requireValue(
        item.findingIds.every((findingId) =>
          ["verified", "closed", "duplicate", "superseded"].includes(
            findings.get(findingId)!.lifecycle,
          ),
        ),
        "invalid-transition",
        `$.closeouts.${item.id}.findingIds`,
      );
    }
    requireValue(
      Date.parse(closeSweep.observedAt) <= Date.parse(closeSweep.trackerObservedAt) &&
        Date.parse(closeSweep.trackerObservedAt) <= Date.parse(item.decidedAt) &&
        Date.parse(item.decidedAt) <= Date.parse(ledger.updatedAt),
      "invalid-time",
      `$.closeouts.${item.id}.decidedAt`,
    );
  }
}

function validateFindingMaterial(
  value: RoadmapFindingMaterial,
  path: string,
): RoadmapFindingMaterial {
  return {
    boundaryId: identifier(value.boundaryId, `${path}.boundaryId`),
    category: identifier(value.category, `${path}.category`),
    severity: enumeration(value.severity, ["p0", "p1", "p2"] as const, `${path}.severity`),
    affectedPaths: pathArray(value.affectedPaths, `${path}.affectedPaths`).sort(),
    evidenceIds: idArray(value.evidenceIds, `${path}.evidenceIds`).sort(),
    materialEvidenceDigest: digest(value.materialEvidenceDigest, `${path}.materialEvidenceDigest`),
  };
}

function boundary(value: unknown, path: string): RoadmapDiscoveryBoundary {
  const item = closed(
    value,
    path,
    ["id", "mode", "observedAt", "queryDigest", "fromRevision", "toRevision"],
    ["id", "mode", "observedAt", "queryDigest"],
  );
  const mode = enumeration(item.mode, ["release", "documentation-health"] as const, `${path}.mode`);
  const result: RoadmapDiscoveryBoundary = {
    id: identifier(item.id, `${path}.id`),
    mode,
    observedAt: timestamp(item.observedAt, `${path}.observedAt`),
    queryDigest: digest(item.queryDigest, `${path}.queryDigest`),
    ...(item.fromRevision === undefined
      ? {}
      : { fromRevision: revision(item.fromRevision, `${path}.fromRevision`) }),
    ...(item.toRevision === undefined
      ? {}
      : { toRevision: revision(item.toRevision, `${path}.toRevision`) }),
  };
  if (mode === "release")
    requireValue(
      result.fromRevision !== undefined && result.toRevision !== undefined,
      "missing-field",
      path,
    );
  if (mode === "documentation-health")
    requireValue(
      result.fromRevision === undefined && result.toRevision === undefined,
      "invalid-value",
      path,
    );
  return result;
}

function trackerObservation(value: unknown, path: string): RoadmapTrackerObservation {
  const item = closed(value, path, ["issueIid", "state", "updatedAt", "identityDigest"]);
  return {
    issueIid: positiveInteger(item.issueIid, `${path}.issueIid`),
    state: enumeration(item.state, ["opened", "closed"] as const, `${path}.state`),
    updatedAt: timestamp(item.updatedAt, `${path}.updatedAt`),
    identityDigest: digest(item.identityDigest, `${path}.identityDigest`),
  };
}

function evidenceReference(value: unknown, path: string): RoadmapEvidenceReference {
  const item = closed(
    value,
    path,
    ["id", "kind", "digest", "repositoryRevision", "path", "externalId", "artifact"],
    ["id", "kind", "digest"],
  );
  return {
    id: identifier(item.id, `${path}.id`),
    kind: enumeration(item.kind, ROADMAP_EVIDENCE_KINDS, `${path}.kind`),
    digest: digest(item.digest, `${path}.digest`),
    ...(item.repositoryRevision === undefined
      ? {}
      : { repositoryRevision: revision(item.repositoryRevision, `${path}.repositoryRevision`) }),
    ...(item.path === undefined ? {} : { path: safePath(item.path, `${path}.path`) }),
    ...(item.externalId === undefined
      ? {}
      : { externalId: externalIdentifier(item.externalId, `${path}.externalId`) }),
    ...(item.artifact === undefined
      ? {}
      : { artifact: artifactReference(item.artifact, `${path}.artifact`) }),
  };
}

function finding(value: unknown, path: string): RoadmapFinding {
  const item = closed(value, path, [
    "id",
    "fingerprint",
    "boundaryId",
    "category",
    "severity",
    "affectedPaths",
    "evidenceIds",
    "materialEvidenceDigest",
    "source",
    "disposition",
    "lifecycle",
    "dependsOnFindingIds",
  ]);
  const material = validateFindingMaterial(
    {
      boundaryId: item.boundaryId as string,
      category: item.category as string,
      severity: item.severity as RoadmapFindingMaterial["severity"],
      affectedPaths: item.affectedPaths as string[],
      evidenceIds: item.evidenceIds as string[],
      materialEvidenceDigest: item.materialEvidenceDigest as string,
    },
    path,
  );
  return {
    id: identifier(item.id, `${path}.id`),
    fingerprint: digest(item.fingerprint, `${path}.fingerprint`),
    ...material,
    source: enumeration(
      item.source,
      ["release", "documentation-health"] as const,
      `${path}.source`,
    ),
    disposition: enumeration(
      item.disposition,
      [
        "documented",
        "no-doc-impact",
        "needs-update",
        "needs-new-doc",
        "healthy",
        "repair",
        "restructure",
        "investigate",
        "excluded",
        "blocked",
        "duplicate",
      ] as const,
      `${path}.disposition`,
    ),
    lifecycle: enumeration(item.lifecycle, ROADMAP_LIFECYCLE_STATES, `${path}.lifecycle`),
    dependsOnFindingIds: idArray(item.dependsOnFindingIds, `${path}.dependsOnFindingIds`).sort(),
  };
}

function workstream(value: unknown, path: string): RoadmapWorkstream {
  const item = closed(value, path, [
    "id",
    "findingIds",
    "dependsOnWorkstreamIds",
    "collidesWithWorkstreamIds",
    "executionOrder",
    "state",
  ]);
  return {
    id: identifier(item.id, `${path}.id`),
    findingIds: idArray(item.findingIds, `${path}.findingIds`).sort(),
    dependsOnWorkstreamIds: idArray(
      item.dependsOnWorkstreamIds,
      `${path}.dependsOnWorkstreamIds`,
    ).sort(),
    collidesWithWorkstreamIds: idArray(
      item.collidesWithWorkstreamIds,
      `${path}.collidesWithWorkstreamIds`,
    ).sort(),
    executionOrder: positiveInteger(item.executionOrder, `${path}.executionOrder`),
    state: enumeration(
      item.state,
      ["planned", "ready", "blocked", "complete"] as const,
      `${path}.state`,
    ),
  };
}

function dedupDecision(value: unknown, path: string): RoadmapDedupDecision {
  const item = closed(
    value,
    path,
    ["findingId", "decision", "issueIid", "observedUpdatedAt", "rationaleCode"],
    ["findingId", "decision", "rationaleCode"],
  );
  return {
    findingId: identifier(item.findingId, `${path}.findingId`),
    decision: enumeration(
      item.decision,
      ["create", "reuse", "duplicate", "supersede"] as const,
      `${path}.decision`,
    ),
    ...(item.issueIid === undefined
      ? {}
      : { issueIid: positiveInteger(item.issueIid, `${path}.issueIid`) }),
    ...(item.observedUpdatedAt === undefined
      ? {}
      : { observedUpdatedAt: timestamp(item.observedUpdatedAt, `${path}.observedUpdatedAt`) }),
    rationaleCode: identifier(item.rationaleCode, `${path}.rationaleCode`),
  };
}

function transition(value: unknown, path: string): RoadmapLifecycleTransition {
  const item = closed(value, path, [
    "id",
    "findingId",
    "from",
    "to",
    "at",
    "reasonCode",
    "evidenceIds",
  ]);
  return {
    id: identifier(item.id, `${path}.id`),
    findingId: identifier(item.findingId, `${path}.findingId`),
    from: enumeration(item.from, ROADMAP_LIFECYCLE_STATES, `${path}.from`),
    to: enumeration(item.to, ROADMAP_LIFECYCLE_STATES, `${path}.to`),
    at: timestamp(item.at, `${path}.at`),
    reasonCode: identifier(item.reasonCode, `${path}.reasonCode`),
    evidenceIds: idArray(item.evidenceIds, `${path}.evidenceIds`).sort(),
  };
}

function sweep(value: unknown, path: string): RoadmapSweep {
  const item = closed(value, path, [
    "id",
    "observedAt",
    "repositoryRevision",
    "trackerObservedAt",
    "findingFingerprints",
    "newFindingIds",
    "disposition",
  ]);
  return {
    id: identifier(item.id, `${path}.id`),
    observedAt: timestamp(item.observedAt, `${path}.observedAt`),
    repositoryRevision: revision(item.repositoryRevision, `${path}.repositoryRevision`),
    trackerObservedAt: timestamp(item.trackerObservedAt, `${path}.trackerObservedAt`),
    findingFingerprints: digestArray(
      item.findingFingerprints,
      `${path}.findingFingerprints`,
    ).sort(),
    newFindingIds: idArray(item.newFindingIds, `${path}.newFindingIds`).sort(),
    disposition: enumeration(
      item.disposition,
      ["clean", "new-findings", "blocked"] as const,
      `${path}.disposition`,
    ),
  };
}

function closeout(value: unknown, path: string): RoadmapCloseoutDecision {
  const item = closed(value, path, [
    "id",
    "targetKey",
    "findingIds",
    "decision",
    "decidedAt",
    "reasonCode",
    "evidenceIds",
    "supplementalSweepId",
  ]);
  return {
    id: identifier(item.id, `${path}.id`),
    targetKey: identifier(item.targetKey, `${path}.targetKey`),
    findingIds: idArray(item.findingIds, `${path}.findingIds`).sort(compareText),
    decision: enumeration(
      item.decision,
      ["close", "keep-open", "reopen"] as const,
      `${path}.decision`,
    ),
    decidedAt: timestamp(item.decidedAt, `${path}.decidedAt`),
    reasonCode: identifier(item.reasonCode, `${path}.reasonCode`),
    evidenceIds: idArray(item.evidenceIds, `${path}.evidenceIds`).sort(),
    supplementalSweepId: identifier(item.supplementalSweepId, `${path}.supplementalSweepId`),
  };
}

function artifactReference(value: unknown, path: string): ArtifactReference {
  const item = closed(value, path, [
    "kind",
    "schemaVersion",
    "digest",
    "repositoryRevision",
    "repositoryContentDigest",
  ]);
  const schemaVersion = positiveInteger(item.schemaVersion, `${path}.schemaVersion`);
  requireValue(schemaVersion === 1, "invalid-value", `${path}.schemaVersion`);
  return {
    kind: enumeration(item.kind, ARTIFACT_KINDS, `${path}.kind`),
    schemaVersion: 1,
    digest: digest(item.digest, `${path}.digest`),
    repositoryRevision: revision(item.repositoryRevision, `${path}.repositoryRevision`),
    repositoryContentDigest: digest(
      item.repositoryContentDigest,
      `${path}.repositoryContentDigest`,
    ),
  };
}

function repository(value: unknown, path: string): RepositoryIdentity {
  const item = closed(value, path, ["revision", "contentDigest"]);
  return {
    revision: revision(item.revision, `${path}.revision`),
    contentDigest: digest(item.contentDigest, `${path}.contentDigest`),
  };
}

function project(value: unknown, path: string): RoadmapProjectIdentity {
  const item = closed(value, path, ["provider", "host", "fullPath", "projectId"]);
  const provider = safeText(item.provider, `${path}.provider`).toLowerCase();
  requireValue(
    PROVIDER_IDENTIFIER.test(provider) &&
      !identifierCarriesConfiguredCredential(provider, `${path}.provider`),
    "invalid-value",
    `${path}.provider`,
  );
  const host = safeText(item.host, `${path}.host`).toLowerCase();
  requireValue(HOST.test(host), "invalid-value", `${path}.host`);
  const fullPath = safePath(item.fullPath, `${path}.fullPath`);
  requireValue(fullPath.split("/").length >= 2, "invalid-value", `${path}.fullPath`);
  return {
    provider,
    host,
    fullPath,
    projectId: positiveInteger(item.projectId, `${path}.projectId`),
  };
}

/** @internal Shared identity validation for mutation and authorization contracts. */
export const internalRoadmapIdentity = Object.freeze({
  repository,
  project,
  sameRepository: (left: RepositoryIdentity, right: RepositoryIdentity): boolean =>
    left.revision === right.revision && left.contentDigest === right.contentDigest,
  sameProject: (left: RoadmapProjectIdentity, right: RoadmapProjectIdentity): boolean =>
    left.provider === right.provider &&
    left.host === right.host &&
    left.fullPath === right.fullPath &&
    left.projectId === right.projectId,
});
