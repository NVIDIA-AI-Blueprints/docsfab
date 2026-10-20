// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * DocChangeDeltaV1: sealed ADDED / MODIFIED / REMOVED projection.
 *
 * Contract: docs/reference/contracts/doc-change-delta.md. Display / review
 * only: never grants tracker mutation, roadmap apply, or write.
 */

import {
  createContractKit,
  createHostAuthorityFactory,
  deepFreeze,
  type ContractFail,
} from "../contract-kit/index.js";

export const DOC_CHANGE_DELTA_SCHEMA_VERSION = 1 as const;
export const DOC_CHANGE_DELTA_KIND = "docsfab-doc-change-delta" as const;

export const DOC_CHANGE_DELTA_SECTIONS = ["added", "modified", "removed"] as const;
export type DocChangeDeltaSection = (typeof DOC_CHANGE_DELTA_SECTIONS)[number];

export const DOC_CHANGE_DELTA_DISPLAY_LIFECYCLES = ["open", "fixed", "verified"] as const;
export type DocChangeDeltaDisplayLifecycle = (typeof DOC_CHANGE_DELTA_DISPLAY_LIFECYCLES)[number];

export type DocChangeDeltaErrorCode =
  | "invalid-shape"
  | "invalid-value"
  | "digest-mismatch"
  | "credential-material"
  | "schema-mismatch"
  | "migration-required"
  /** Never raised; kept so readers of earlier rejections still type-check. */
  | "host-path"
  | "missing-evidence"
  | "authority-required"
  | "unauthorized";

export class DocChangeDeltaError extends Error {
  public constructor(public readonly code: DocChangeDeltaErrorCode) {
    super(`DocChangeDelta rejected: ${code}.`);
    this.name = "DocChangeDeltaError";
  }
}

function fail(code: DocChangeDeltaErrorCode): never {
  throw new DocChangeDeltaError(code);
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
  unique,
  seal,
  decodeSealed,
} = createContractKit({
  fail: fail as ContractFail<DocChangeDeltaErrorCode>,
  codes: {
    invalidShape: "invalid-shape",
    invalidValue: "invalid-value",
    digestMismatch: "digest-mismatch",
    credentialMaterial: "credential-material",
    schemaMismatch: "migration-required",
  },
});

const SAFE_STABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/u;
const SAFE_CODE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

/**
 * Content-free evidence bindings for one delta entry.
 * At least one digest must be present (fail closed on missing evidence).
 */
export interface DocChangeDeltaEvidenceBindingV1 {
  observationSha256: string | null;
  findingSha256: string | null;
  artifactRefSha256: string | null;
}

export interface DocChangeDeltaEntryV1 {
  section: DocChangeDeltaSection;
  /** Stable gap id, readiness work-unit id, or equivalent content-free identity. */
  stableId: string;
  /** Content-free machine codes (sorted, unique). */
  codes: string[];
  /** Content-free labels (sorted, unique). */
  labels: string[];
  evidence: DocChangeDeltaEvidenceBindingV1;
  /** Optional display lifecycle; archive/close never merges into repo markdown. */
  displayLifecycle: DocChangeDeltaDisplayLifecycle | null;
}

export interface DocChangeDeltaV1 {
  schemaVersion: 1;
  kind: typeof DOC_CHANGE_DELTA_KIND;
  repositoryIdentitySha256: string;
  repositoryRevision: string;
  /** Repository content digest matching the authenticated run. */
  repositoryContentDigestSha256: string;
  /** Authenticated run-record binding (self-sealed bytes alone are insufficient). */
  sourceRunRecordSha256: string;
  /** Admitted gap ledger digest when applicable; null for readiness-only sources. */
  sourceLedgerSha256: string | null;
  entries: DocChangeDeltaEntryV1[];
  /** Explicit non-authority — projection never authorizes tracker mutation. */
  trackerMutation: "not-authorized";
  deltaSha256: string;
}

export type DocChangeDeltaInputV1 = Omit<
  DocChangeDeltaV1,
  "schemaVersion" | "kind" | "deltaSha256"
>;

/** Opaque host capability admitting run / ledger provenance for a delta. */
export type DocChangeDeltaProvenanceAuthority = {
  readonly kind: "docsfab-doc-change-delta-provenance-authority";
};

export interface DocChangeDeltaProvenanceBindingsV1 {
  sourceRunRecordSha256: string;
  sourceLedgerSha256: string | null;
  repositoryIdentitySha256: string;
  repositoryRevision: string;
  repositoryContentDigestSha256: string;
}

export interface DocChangeDeltaProvenanceVerifier {
  verifyCurrent(bindings: DocChangeDeltaProvenanceBindingsV1): { status: "admitted" };
}

const provenanceAuthorities = createHostAuthorityFactory<
  "docsfab-doc-change-delta-provenance-authority",
  DocChangeDeltaProvenanceVerifier
>({
  kind: "docsfab-doc-change-delta-provenance-authority",
  invalidMessage: "DocChangeDelta provenance verifier must expose verifyCurrent.",
});

export function createDocChangeDeltaProvenanceAuthority(
  verifier: DocChangeDeltaProvenanceVerifier,
): DocChangeDeltaProvenanceAuthority {
  return provenanceAuthorities.create(verifier) as DocChangeDeltaProvenanceAuthority;
}

/**
 * Seal a DocChangeDeltaV1 body. Always stamps `trackerMutation: "not-authorized"`.
 * Callers that need provenance admission must still `validateDocChangeDelta`.
 */
export function createDocChangeDelta(input: DocChangeDeltaInputV1): DocChangeDeltaV1 {
  assertInert(input);
  rejectCredentials(input);
  const root = object(input as unknown);
  exact(root, [
    "repositoryIdentitySha256",
    "repositoryRevision",
    "repositoryContentDigestSha256",
    "sourceRunRecordSha256",
    "sourceLedgerSha256",
    "entries",
    "trackerMutation",
  ]);
  const body = normalizeBody(root);
  return decodeDocChangeDelta(seal(DOC_CHANGE_DELTA_KIND, "deltaSha256", body));
}

/**
 * Decode closed-schema DocChangeDeltaV1.
 * Fail closed on unknown fields, missing evidence, and any trackerMutation
 * other than `not-authorized`.
 *
 * Self-sealed integrity only — use {@link validateDocChangeDelta} at trust
 * boundaries so provenance is admitted by the host.
 */
export function decodeDocChangeDelta(value: unknown): DocChangeDeltaV1 {
  return decodeSealed(
    value,
    DOC_CHANGE_DELTA_KIND,
    "deltaSha256",
    [
      "repositoryIdentitySha256",
      "repositoryRevision",
      "repositoryContentDigestSha256",
      "sourceRunRecordSha256",
      "sourceLedgerSha256",
      "entries",
      "trackerMutation",
    ],
    (root) => normalizeBody(root),
  );
}

/**
 * Assert explicit non-authority. Decode already enforces this; this helper is
 * the named fail-closed authority check for callers and tests.
 */
export function assertDocChangeDeltaNonAuthority(value: unknown): "not-authorized" {
  const delta = decodeDocChangeDelta(value);
  if (delta.trackerMutation !== "not-authorized") fail("unauthorized");
  return delta.trackerMutation;
}

/**
 * Authenticate a decoded (or raw) delta against host-admitted provenance.
 * Self-sealed bytes alone are insufficient (same class as gap→roadmap validators).
 */
export function validateDocChangeDelta(input: {
  delta: unknown;
  provenance: DocChangeDeltaProvenanceAuthority;
}): DocChangeDeltaV1 {
  assertInert(input);
  rejectCredentials(input);
  const root = object(input as unknown);
  exact(root, ["delta", "provenance"]);
  const delta = decodeDocChangeDelta(root.delta);
  assertDocChangeDeltaNonAuthority(delta);
  const verifier = provenanceAuthorities.lookup(
    root.provenance as DocChangeDeltaProvenanceAuthority,
  );
  if (!verifier) fail("authority-required");
  const admitted = verifier.verifyCurrent({
    sourceRunRecordSha256: delta.sourceRunRecordSha256,
    sourceLedgerSha256: delta.sourceLedgerSha256,
    repositoryIdentitySha256: delta.repositoryIdentitySha256,
    repositoryRevision: delta.repositoryRevision,
    repositoryContentDigestSha256: delta.repositoryContentDigestSha256,
  });
  if (!admitted || admitted.status !== "admitted") fail("authority-required");
  return delta;
}

function normalizeBody(
  root: Record<string, unknown>,
): Omit<DocChangeDeltaV1, "schemaVersion" | "kind" | "deltaSha256"> {
  const trackerMutation = enumeration(root.trackerMutation, ["not-authorized"] as const);
  const entries = array(root.entries).map(normalizeEntry);
  unique(entries.map((entry) => `${entry.section}:${entry.stableId}`));
  return {
    repositoryIdentitySha256: hash(root.repositoryIdentitySha256),
    repositoryRevision: revision(root.repositoryRevision),
    repositoryContentDigestSha256: hash(root.repositoryContentDigestSha256),
    sourceRunRecordSha256: hash(root.sourceRunRecordSha256),
    sourceLedgerSha256: nullableHash(root.sourceLedgerSha256),
    entries,
    trackerMutation,
  };
}

function normalizeEntry(value: unknown): DocChangeDeltaEntryV1 {
  const item = object(value);
  exact(item, ["section", "stableId", "codes", "labels", "evidence", "displayLifecycle"]);
  const evidence = normalizeEvidence(item.evidence);
  const codes = normalizeCodes(item.codes);
  const labels = normalizeCodes(item.labels);
  return {
    section: enumeration(item.section, DOC_CHANGE_DELTA_SECTIONS),
    stableId: stableId(item.stableId),
    codes,
    labels,
    evidence,
    displayLifecycle:
      item.displayLifecycle === null
        ? null
        : enumeration(item.displayLifecycle, DOC_CHANGE_DELTA_DISPLAY_LIFECYCLES),
  };
}

function normalizeEvidence(value: unknown): DocChangeDeltaEvidenceBindingV1 {
  const item = object(value);
  exact(item, ["observationSha256", "findingSha256", "artifactRefSha256"]);
  const evidence = {
    observationSha256: nullableHash(item.observationSha256),
    findingSha256: nullableHash(item.findingSha256),
    artifactRefSha256: nullableHash(item.artifactRefSha256),
  };
  if (
    evidence.observationSha256 === null &&
    evidence.findingSha256 === null &&
    evidence.artifactRefSha256 === null
  ) {
    fail("missing-evidence");
  }
  return evidence;
}

function normalizeCodes(value: unknown): string[] {
  const result = array(value)
    .map((entry) => {
      const code = string(entry);
      if (!SAFE_CODE.test(code)) fail("invalid-value");
      return code;
    })
    .sort(compare);
  unique(result);
  return result;
}

function stableId(value: unknown): string {
  const result = string(value);
  if (!SAFE_STABLE_ID.test(result) || result.includes("..")) {
    fail("invalid-value");
  }
  return result;
}

deepFreeze({
  kind: DOC_CHANGE_DELTA_KIND,
  sections: DOC_CHANGE_DELTA_SECTIONS,
  displayLifecycles: DOC_CHANGE_DELTA_DISPLAY_LIFECYCLES,
});
