// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Project DocChangeDeltaV1 from an authenticated run's gap ledger.
 *
 * Source map per docs/reference/contracts/doc-change-delta.md: open gaps /
 * readiness missing → ADDED; prior observation with changed coverage or
 * revision → MODIFIED; explicitly closed reconciliations → REMOVED. Display /
 * review only — never grants write or tracker authority.
 */

import { createContractKit, type ContractFail } from "../contract-kit/index.js";
import { canonicalDigest } from "../content-ir/canonical.js";
import {
  assertDocChangeDeltaNonAuthority,
  createDocChangeDelta,
  createDocChangeDeltaProvenanceAuthority,
  decodeDocChangeDelta,
  validateDocChangeDelta,
  type DocChangeDeltaDisplayLifecycle,
  type DocChangeDeltaEntryV1,
  type DocChangeDeltaProvenanceAuthority,
  type DocChangeDeltaSection,
  type DocChangeDeltaV1,
} from "./doc-change-delta.js";
import {
  decodeDocumentationGapLedger,
  type DocumentationGapLedgerEntryV1,
  type DocumentationGapLedgerV1,
  type DocumentationSearchFindingV1,
} from "./gap-ledger.js";

export type DocChangeDeltaProjectorErrorCode =
  | "invalid-shape"
  | "invalid-value"
  | "digest-mismatch"
  | "credential-material"
  | "migration-required"
  | "schema-mismatch"
  | "missing-evidence"
  | "unauthorized";

export class DocChangeDeltaProjectorError extends Error {
  public constructor(public readonly code: DocChangeDeltaProjectorErrorCode) {
    super(`DocChangeDelta projector rejected: ${code}.`);
    this.name = "DocChangeDeltaProjectorError";
  }
}

function fail(code: DocChangeDeltaProjectorErrorCode): never {
  throw new DocChangeDeltaProjectorError(code);
}

const {
  assertInert,
  rejectCredentials,
  object,
  exact,
  array,
  string,
  hash,
  nullableHash,
  revision,
  enumeration,
  compare,
} = createContractKit({
  fail: fail as ContractFail<DocChangeDeltaProjectorErrorCode>,
  codes: {
    invalidShape: "invalid-shape",
    invalidValue: "invalid-value",
    digestMismatch: "digest-mismatch",
    credentialMaterial: "credential-material",
    schemaMismatch: "migration-required",
  },
});

const SAFE_STABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/u;

/** Authenticated run bindings that must match the admitted ledger. */
export interface DocChangeDeltaRunBindingsV1 {
  sourceRunRecordSha256: string;
  repositoryIdentitySha256: string;
  repositoryRevision: string;
  repositoryContentDigestSha256: string;
  /**
   * When set, must equal `ledger.ledgerSha256` — fail closed on substituted
   * ledger bytes (same spirit as roadmap-proposal source-aware validators).
   */
  expectedLedgerSha256?: string;
}

/**
 * Content-free readiness work-unit binding from the same authenticated run.
 * Does not import release-documentation-readiness (assessment seam stays free
 * of that product façade); callers pass already-projected digests.
 */
export interface DocChangeDeltaReadinessWorkUnitSourceV1 {
  id: string;
  state: "missing" | "needs-human-decision" | "covered" | "inconclusive" | "blocked";
  workUnitSha256: string;
  observationSha256: string | null;
  findingSha256: string | null;
  repositoryIdentitySha256: string;
  repositoryRevision: string;
}

const READINESS_STATES = [
  "missing",
  "needs-human-decision",
  "covered",
  "inconclusive",
  "blocked",
] as const;

/**
 * Deterministically project a sealed DocChangeDelta from an admitted gap ledger
 * (and optional readiness work units on the same run).
 *
 * Always stamps `trackerMutation: "not-authorized"`. Does not mint write,
 * tracker, or roadmap-apply authority.
 */
export function projectDocChangeDeltaFromGapLedger(input: {
  ledger: DocumentationGapLedgerV1;
  runBindings: DocChangeDeltaRunBindingsV1;
  readinessWorkUnits?: readonly DocChangeDeltaReadinessWorkUnitSourceV1[];
}): DocChangeDeltaV1 {
  assertInert(input);
  rejectCredentials(input);
  const root = object(input as unknown);
  exact(
    root,
    root.readinessWorkUnits === undefined
      ? ["ledger", "runBindings"]
      : ["ledger", "runBindings", "readinessWorkUnits"],
  );
  const ledger = decodeDocumentationGapLedger(root.ledger);
  const runBindings = normalizeRunBindings(root.runBindings);
  assertLedgerMatchesRun(ledger, runBindings);
  const readinessWorkUnits =
    root.readinessWorkUnits === undefined
      ? []
      : array(root.readinessWorkUnits).map(normalizeReadinessWorkUnit);

  for (const unit of readinessWorkUnits) {
    if (
      unit.repositoryIdentitySha256 !== runBindings.repositoryIdentitySha256 ||
      unit.repositoryRevision !== runBindings.repositoryRevision
    ) {
      fail("digest-mismatch");
    }
  }

  const entries: DocChangeDeltaEntryV1[] = [];
  for (const entry of [...ledger.entries].sort((left, right) =>
    left.stableGapId.localeCompare(right.stableGapId),
  )) {
    const projected = projectGapEntry(entry);
    if (projected) entries.push(projected);
  }
  for (const unit of [...readinessWorkUnits].sort((left, right) =>
    left.id.localeCompare(right.id),
  )) {
    const projected = projectReadinessWorkUnit(unit);
    if (projected) entries.push(projected);
  }

  entries.sort(
    (left, right) =>
      sectionRank(left.section) - sectionRank(right.section) ||
      left.stableId.localeCompare(right.stableId),
  );

  return createDocChangeDelta({
    repositoryIdentitySha256: runBindings.repositoryIdentitySha256,
    repositoryRevision: runBindings.repositoryRevision,
    repositoryContentDigestSha256: runBindings.repositoryContentDigestSha256,
    sourceRunRecordSha256: runBindings.sourceRunRecordSha256,
    sourceLedgerSha256: ledger.ledgerSha256,
    entries,
    trackerMutation: "not-authorized",
  });
}

/**
 * Authenticate a serialized delta by re-projecting from the same ledger + run
 * bindings. Self-sealed bytes alone are insufficient.
 */
export function validateProjectedDocChangeDelta(input: {
  delta: unknown;
  ledger: DocumentationGapLedgerV1;
  runBindings: DocChangeDeltaRunBindingsV1;
  readinessWorkUnits?: readonly DocChangeDeltaReadinessWorkUnitSourceV1[];
}): DocChangeDeltaV1 {
  assertInert(input);
  rejectCredentials(input);
  const root = object(input as unknown);
  exact(
    root,
    root.readinessWorkUnits === undefined
      ? ["delta", "ledger", "runBindings"]
      : ["delta", "ledger", "runBindings", "readinessWorkUnits"],
  );
  const delta = decodeDocChangeDelta(root.delta);
  assertDocChangeDeltaNonAuthority(delta);
  const expected = projectDocChangeDeltaFromGapLedger({
    ledger: root.ledger as DocumentationGapLedgerV1,
    runBindings: root.runBindings as DocChangeDeltaRunBindingsV1,
    ...(root.readinessWorkUnits === undefined
      ? {}
      : {
          readinessWorkUnits:
            root.readinessWorkUnits as readonly DocChangeDeltaReadinessWorkUnitSourceV1[],
        }),
  });
  if (canonicalDigest(delta) !== canonicalDigest(expected)) fail("digest-mismatch");
  const provenance = createDocChangeDeltaRunProvenanceAuthority({
    sourceRunRecordSha256: expected.sourceRunRecordSha256,
    sourceLedgerSha256: expected.sourceLedgerSha256,
    repositoryIdentitySha256: expected.repositoryIdentitySha256,
    repositoryRevision: expected.repositoryRevision,
    repositoryContentDigestSha256: expected.repositoryContentDigestSha256,
  });
  return validateDocChangeDelta({ delta: expected, provenance });
}

/** Host authority that admits exact run + ledger provenance bindings. */
export function createDocChangeDeltaRunProvenanceAuthority(bindings: {
  sourceRunRecordSha256: string;
  sourceLedgerSha256: string | null;
  repositoryIdentitySha256: string;
  repositoryRevision: string;
  repositoryContentDigestSha256: string;
}): DocChangeDeltaProvenanceAuthority {
  assertInert(bindings);
  rejectCredentials(bindings);
  const root = object(bindings as unknown);
  exact(root, [
    "sourceRunRecordSha256",
    "sourceLedgerSha256",
    "repositoryIdentitySha256",
    "repositoryRevision",
    "repositoryContentDigestSha256",
  ]);
  const admitted = {
    sourceRunRecordSha256: hash(root.sourceRunRecordSha256),
    sourceLedgerSha256: nullableHash(root.sourceLedgerSha256),
    repositoryIdentitySha256: hash(root.repositoryIdentitySha256),
    repositoryRevision: revision(root.repositoryRevision),
    repositoryContentDigestSha256: hash(root.repositoryContentDigestSha256),
  };
  return createDocChangeDeltaProvenanceAuthority({
    verifyCurrent(candidate) {
      if (
        candidate.sourceRunRecordSha256 !== admitted.sourceRunRecordSha256 ||
        candidate.sourceLedgerSha256 !== admitted.sourceLedgerSha256 ||
        candidate.repositoryIdentitySha256 !== admitted.repositoryIdentitySha256 ||
        candidate.repositoryRevision !== admitted.repositoryRevision ||
        candidate.repositoryContentDigestSha256 !== admitted.repositoryContentDigestSha256
      ) {
        fail("digest-mismatch");
      }
      return { status: "admitted" as const };
    },
  });
}

function normalizeRunBindings(value: unknown): DocChangeDeltaRunBindingsV1 {
  const item = object(value);
  const keys =
    item.expectedLedgerSha256 === undefined
      ? [
          "sourceRunRecordSha256",
          "repositoryIdentitySha256",
          "repositoryRevision",
          "repositoryContentDigestSha256",
        ]
      : [
          "sourceRunRecordSha256",
          "repositoryIdentitySha256",
          "repositoryRevision",
          "repositoryContentDigestSha256",
          "expectedLedgerSha256",
        ];
  exact(item, keys);
  return {
    sourceRunRecordSha256: hash(item.sourceRunRecordSha256),
    repositoryIdentitySha256: hash(item.repositoryIdentitySha256),
    repositoryRevision: revision(item.repositoryRevision),
    repositoryContentDigestSha256: hash(item.repositoryContentDigestSha256),
    ...(item.expectedLedgerSha256 === undefined
      ? {}
      : { expectedLedgerSha256: hash(item.expectedLedgerSha256) }),
  };
}

function normalizeReadinessWorkUnit(value: unknown): DocChangeDeltaReadinessWorkUnitSourceV1 {
  const item = object(value);
  exact(item, [
    "id",
    "state",
    "workUnitSha256",
    "observationSha256",
    "findingSha256",
    "repositoryIdentitySha256",
    "repositoryRevision",
  ]);
  const id = string(item.id);
  if (!SAFE_STABLE_ID.test(id) || id.includes("..")) fail("invalid-value");
  return {
    id,
    state: enumeration(item.state, READINESS_STATES),
    workUnitSha256: hash(item.workUnitSha256),
    observationSha256: nullableHash(item.observationSha256),
    findingSha256: nullableHash(item.findingSha256),
    repositoryIdentitySha256: hash(item.repositoryIdentitySha256),
    repositoryRevision: revision(item.repositoryRevision),
  };
}

function assertLedgerMatchesRun(
  ledger: DocumentationGapLedgerV1,
  runBindings: DocChangeDeltaRunBindingsV1,
): void {
  if (
    ledger.repositoryIdentitySha256 !== runBindings.repositoryIdentitySha256 ||
    ledger.currentRevision !== runBindings.repositoryRevision
  ) {
    fail("digest-mismatch");
  }
  if (
    runBindings.expectedLedgerSha256 !== undefined &&
    runBindings.expectedLedgerSha256 !== ledger.ledgerSha256
  ) {
    fail("digest-mismatch");
  }
  for (const entry of ledger.entries) {
    const current = entry.observations.find(
      (finding) => finding.observationSha256 === entry.currentObservationSha256,
    );
    if (!current) fail("missing-evidence");
    if (
      current.evidenceIdentity.repositoryIdentitySha256 !== runBindings.repositoryIdentitySha256 ||
      current.evidenceIdentity.repositoryRevision !== runBindings.repositoryRevision
    ) {
      fail("digest-mismatch");
    }
    if (!current.observationSha256) fail("missing-evidence");
  }
}

function projectGapEntry(entry: DocumentationGapLedgerEntryV1): DocChangeDeltaEntryV1 | null {
  const current = entry.observations.find(
    (finding) => finding.observationSha256 === entry.currentObservationSha256,
  );
  if (!current) fail("missing-evidence");

  const closed = closedReconciliation(entry);
  const priors = entry.observations.filter(
    (finding) => finding.observationSha256 !== current.observationSha256,
  );
  const change = classifyCoverageRevisionChange(current, priors);

  let section: DocChangeDeltaSection | null = null;
  let codes: string[] = [];
  let labels: string[] = [];
  let displayLifecycle: DocChangeDeltaDisplayLifecycle | null = null;

  if (closed) {
    section = "removed";
    codes = ["disposition.closed"];
    labels = [closed];
    displayLifecycle = closed;
  } else if (change.changed) {
    section = "modified";
    codes = change.codes;
    labels = ["gap.history"];
    displayLifecycle = entry.state === "open" ? "open" : null;
  } else if (entry.state === "open") {
    section = "added";
    codes = ["gap.open"];
    labels = ["requirement.missing"];
    displayLifecycle = "open";
  } else {
    return null;
  }

  return {
    section,
    stableId: entry.stableGapId,
    codes: [...codes].sort(compare),
    labels: [...labels].sort(compare),
    evidence: {
      observationSha256: current.observationSha256,
      findingSha256: current.evidenceIdentity.searchFindingSha256,
      artifactRefSha256: null,
    },
    displayLifecycle,
  };
}

function projectReadinessWorkUnit(
  unit: DocChangeDeltaReadinessWorkUnitSourceV1,
): DocChangeDeltaEntryV1 | null {
  if (unit.state !== "missing" && unit.state !== "needs-human-decision") {
    return null;
  }
  if (unit.observationSha256 === null && unit.findingSha256 === null) {
    fail("missing-evidence");
  }
  return {
    section: "added",
    stableId: unit.id,
    codes: unit.state === "missing" ? ["readiness.missing"] : ["readiness.needs-human-decision"],
    labels: ["work-unit"],
    evidence: {
      observationSha256: unit.observationSha256,
      findingSha256: unit.findingSha256,
      artifactRefSha256: unit.workUnitSha256,
    },
    displayLifecycle: "open",
  };
}

function closedReconciliation(entry: DocumentationGapLedgerEntryV1): "fixed" | "verified" | null {
  const statuses = entry.reconciliations.map((item) => item.status);
  if (statuses.includes("verified")) return "verified";
  if (statuses.includes("fixed")) return "fixed";
  return null;
}

function classifyCoverageRevisionChange(
  current: DocumentationSearchFindingV1,
  priors: readonly DocumentationSearchFindingV1[],
): { changed: boolean; codes: string[] } {
  if (priors.length === 0) return { changed: false, codes: [] };
  const codes = new Set<string>();
  for (const prior of priors) {
    if (prior.probeCoverage.coverageSha256 !== current.probeCoverage.coverageSha256) {
      codes.add("coverage.changed");
    }
    if (
      prior.evidenceIdentity.workspaceSnapshotSha256 !==
      current.evidenceIdentity.workspaceSnapshotSha256
    ) {
      codes.add("workspace-snapshot.changed");
    }
    if (prior.evidenceIdentity.repositoryRevision !== current.evidenceIdentity.repositoryRevision) {
      codes.add("revision.changed");
    }
    if (
      prior.evidenceIdentity.searchFindingSha256 !== current.evidenceIdentity.searchFindingSha256 &&
      prior.probeCoverage.coverageSha256 === current.probeCoverage.coverageSha256 &&
      prior.evidenceIdentity.repositoryRevision === current.evidenceIdentity.repositoryRevision
    ) {
      // Distinct observation at same revision/coverage still counts as history.
      codes.add("coverage.changed");
    }
  }
  if (codes.size === 0) {
    // Prior observations exist but digests already collapsed — still MODIFIED
    // per source map (prior observation + changed finding identity).
    codes.add("coverage.changed");
  }
  return { changed: true, codes: [...codes].sort(compare) };
}

function sectionRank(section: DocChangeDeltaSection): number {
  if (section === "added") return 0;
  if (section === "modified") return 1;
  return 2;
}
