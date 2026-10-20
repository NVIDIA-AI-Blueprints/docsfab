// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createContractKit, type ContractFail } from "../contract-kit/index.js";
import { normalizeReaderContextInputTransportV1 } from "../reader-task-transport.js";
import { sha256 } from "../content-ir/canonical.js";

const IMPACT_KINDS = ["public-behavior-change", "documentation-defect", "none", "unknown"] as const;
export const READER_CONTEXT_SOURCE_ROLES = [
  "public-contract",
  "changed-source",
  "current-documentation",
  "repository-instruction",
  "accepted-knowledge",
  "request",
] as const;

export const READER_CONTEXT_CHANGED_SOURCE_INAPPLICABLE_LIMITATION =
  "changed-source-not-applicable-identical-revisions" as const;

export type ReaderContextImpactKindV1 = (typeof IMPACT_KINDS)[number];
export type ReaderContextSourceRoleV1 = (typeof READER_CONTEXT_SOURCE_ROLES)[number];

export interface ReaderContextEvidenceReferenceV1 {
  uri: string;
  sha256: string;
}

export interface ReaderContextImpactBasisV1 {
  kind: ReaderContextImpactKindV1;
  rationale: string;
  evidence_refs: ReaderContextEvidenceReferenceV1[];
}

export interface ReaderContextInputV1 {
  schema_version: 1;
  target_audience: string;
  reader_job: string;
  change_scope: string[];
  source_priority: string[];
  required_content: string[];
  excluded_content: string[];
  unresolved_questions: string[];
  known_limitations?: string[];
}

export interface ReaderContextV1 extends ReaderContextInputV1 {
  impact_basis: ReaderContextImpactBasisV1;
}

export type ReaderContextComparisonV1 =
  | { kind: "base-head"; base_revision: string; head_revision: string }
  | { kind: "workspace"; snapshot_sha256: string }
  | { kind: "unknown" };

export interface ReaderContextPolicyIdentityV1 {
  id: string;
  version: string;
  sha256: string;
}

export interface ReaderContextProvenanceSourceV1 extends ReaderContextEvidenceReferenceV1 {
  role: ReaderContextSourceRoleV1;
}

export interface ReaderContextProvenanceV1 {
  schema_version: 1;
  reader_context_sha256: string;
  baseline_sha256: string;
  admitted_revision: string;
  workspace_snapshot_sha256: string;
  repository_identity_sha256: string;
  policy: ReaderContextPolicyIdentityV1;
  comparison: ReaderContextComparisonV1;
  sources: ReaderContextProvenanceSourceV1[];
  observed_at: string;
  limitations: string[];
}

export interface ReaderContextValidationOptions {
  /** Host-admitted evidence identities. These are matched only; this decoder never fetches a URI. */
  admittedEvidence: readonly ReaderContextEvidenceReferenceV1[];
}

export interface ReaderContextProvenanceValidationOptions {
  readerContextSha256: string;
  baselineSha256: string;
  admittedRevision: string;
  workspaceSnapshotSha256: string;
  repositoryIdentitySha256: string;
  policy: ReaderContextPolicyIdentityV1;
  /** Exact host-admitted source identities for this run. */
  admittedSources: readonly ReaderContextProvenanceSourceV1[];
}

export type ReaderContextValidationErrorCode =
  | "invalid-shape"
  | "invalid-value"
  | "credential-material"
  | "size-exceeded"
  | "evidence-unavailable"
  | "identity-mismatch";

export class ReaderContextValidationError extends Error {
  public constructor(public readonly code: ReaderContextValidationErrorCode) {
    super(`Reader context rejected: ${code}.`);
    this.name = "ReaderContextValidationError";
  }
}

function fail(code: ReaderContextValidationErrorCode): never {
  throw new ReaderContextValidationError(code);
}

const kit = createContractKit<ReaderContextValidationErrorCode>({
  fail: fail as ContractFail<ReaderContextValidationErrorCode>,
  inertMode: "strict",
  codes: {
    invalidShape: "invalid-shape",
    invalidValue: "invalid-value",
    digestMismatch: "identity-mismatch",
    credentialMaterial: "credential-material",
    schemaMismatch: "invalid-shape",
  },
});

const INPUT_KEYS = [
  "schema_version",
  "target_audience",
  "reader_job",
  "change_scope",
  "source_priority",
  "required_content",
  "excluded_content",
  "unresolved_questions",
  "known_limitations",
] as const;
const REQUIRED_INPUT_KEYS = INPUT_KEYS.filter((key) => key !== "known_limitations");
const MAX_CONTEXT_BYTES = 64 * 1024;
const MAX_PROVENANCE_BYTES = 128 * 1024;

/** Strict model-facing intake. It deliberately excludes the candidate impact basis. */
export function validateReaderContextInputV1(value: unknown): ReaderContextInputV1 {
  return normalizeReaderContextInputTransportV1(value, {
    fail,
    rejectCredentials: kit.rejectCredentials,
  });
}

/**
 * Strict completed context admission. Evidence locators are matched to an
 * already admitted host set and are never dereferenced here.
 */
export function validateReaderContextV1(
  value: unknown,
  options: ReaderContextValidationOptions,
): ReaderContextV1 {
  kit.assertInert(value);
  kit.rejectCredentials(value);
  const root = kit.object(value);
  kit.exact(
    root,
    [...REQUIRED_INPUT_KEYS, "known_limitations", "impact_basis"],
    ["known_limitations"],
  );
  const input = validateReaderContextInputV1(
    Object.fromEntries(
      INPUT_KEYS.flatMap((key) => (Object.hasOwn(root, key) ? [[key, root[key]]] : [])),
    ),
  );
  const basis = decodeImpactBasis(root.impact_basis, options);
  const result = { ...input, impact_basis: basis };
  assertCanonicalSize(result, MAX_CONTEXT_BYTES);
  return kit.deepFreeze(result);
}

/** Closed comparison grammar shared by provenance and editorial decisions. */
export function validateReaderContextComparisonV1(value: unknown): ReaderContextComparisonV1 {
  const root = kit.object(value);
  if (root.kind === "base-head") {
    kit.exact(root, ["kind", "base_revision", "head_revision"]);
    return kit.deepFreeze({
      kind: "base-head",
      base_revision: kit.revision(root.base_revision),
      head_revision: kit.revision(root.head_revision),
    });
  }
  if (root.kind === "workspace") {
    kit.exact(root, ["kind", "snapshot_sha256"]);
    return kit.deepFreeze({ kind: "workspace", snapshot_sha256: kit.hash(root.snapshot_sha256) });
  }
  if (root.kind === "unknown") {
    kit.exact(root, ["kind"]);
    return kit.deepFreeze({ kind: "unknown" });
  }
  return fail("invalid-value");
}

/**
 * Admit provenance only against the current host-selected identities and
 * source inventory. A syntactically valid envelope alone is not replay proof.
 */
export function validateReaderContextProvenanceV1(
  value: unknown,
  options: ReaderContextProvenanceValidationOptions,
): ReaderContextProvenanceV1 {
  kit.assertInert(value);
  kit.rejectCredentials(value);
  const root = kit.object(value);
  kit.exact(root, [
    "schema_version",
    "reader_context_sha256",
    "baseline_sha256",
    "admitted_revision",
    "workspace_snapshot_sha256",
    "repository_identity_sha256",
    "policy",
    "comparison",
    "sources",
    "observed_at",
    "limitations",
  ]);
  if (root.schema_version !== 1) fail("invalid-value");
  const policy = decodePolicy(root.policy);
  const comparison = validateReaderContextComparisonV1(root.comparison);
  const sources = kit.array(root.sources).map(decodeSource);
  if (sources.length < 1 || sources.length > 128) fail("invalid-value");
  uniqueByCanonical(sources);
  const result: ReaderContextProvenanceV1 = {
    schema_version: 1,
    reader_context_sha256: kit.hash(root.reader_context_sha256),
    baseline_sha256: kit.hash(root.baseline_sha256),
    admitted_revision: kit.revision(root.admitted_revision),
    workspace_snapshot_sha256: kit.hash(root.workspace_snapshot_sha256),
    repository_identity_sha256: kit.hash(root.repository_identity_sha256),
    policy,
    comparison,
    sources,
    observed_at: rfc3339Utc(root.observed_at),
    limitations: boundedTextArray(root.limitations, 0, 64, 1_024),
  };
  if (
    result.reader_context_sha256 !== kit.hash(options.readerContextSha256) ||
    result.baseline_sha256 !== kit.hash(options.baselineSha256) ||
    result.admitted_revision !== kit.revision(options.admittedRevision) ||
    result.workspace_snapshot_sha256 !== kit.hash(options.workspaceSnapshotSha256) ||
    result.repository_identity_sha256 !== kit.hash(options.repositoryIdentitySha256) ||
    kit.canonicalJson(result.policy) !== kit.canonicalJson(decodePolicy(options.policy))
  ) {
    fail("identity-mismatch");
  }
  if (
    (comparison.kind === "base-head" && comparison.head_revision !== result.admitted_revision) ||
    (comparison.kind === "workspace" &&
      comparison.snapshot_sha256 !== result.workspace_snapshot_sha256)
  ) {
    fail("identity-mismatch");
  }
  const admittedSources = options.admittedSources.map(decodeSource);
  uniqueByCanonical(admittedSources);
  const admitted = new Set(admittedSources.map(sourceKey));
  if (
    sources.length !== admittedSources.length ||
    sources.some((source) => !admitted.has(sourceKey(source)))
  ) {
    fail("evidence-unavailable");
  }
  const changedSourceInapplicable = result.limitations.includes(
    READER_CONTEXT_CHANGED_SOURCE_INAPPLICABLE_LIMITATION,
  );
  if (
    changedSourceInapplicable &&
    (comparison.kind !== "base-head" ||
      comparison.base_revision !== comparison.head_revision ||
      sources.some((source) => source.role === "changed-source"))
  ) {
    fail("identity-mismatch");
  }
  assertCanonicalSize(result, MAX_PROVENANCE_BYTES);
  return kit.deepFreeze(result);
}

/** Canonical identity only. Callers must validate against admitted evidence first. */
export function readerContextSha256(value: ReaderContextV1): string {
  return sha256(kit.canonicalJson(value));
}

/** Canonical identity only. Callers must validate against current host identities first. */
export function readerContextProvenanceSha256(value: ReaderContextProvenanceV1): string {
  return sha256(kit.canonicalJson(value));
}

function decodeImpactBasis(
  value: unknown,
  options: ReaderContextValidationOptions,
): ReaderContextImpactBasisV1 {
  const root = kit.object(value);
  kit.exact(root, ["kind", "rationale", "evidence_refs"]);
  const kind = kit.enumeration(root.kind, IMPACT_KINDS);
  const evidenceRefs = kit.array(root.evidence_refs).map(decodeEvidenceReference);
  if (evidenceRefs.length > 32 || (kind !== "unknown" && evidenceRefs.length === 0)) {
    fail("invalid-value");
  }
  uniqueByCanonical(evidenceRefs);
  const admitted = new Set(options.admittedEvidence.map(evidenceKey));
  if (evidenceRefs.some((reference) => !admitted.has(evidenceKey(reference)))) {
    fail("evidence-unavailable");
  }
  return {
    kind,
    rationale: boundedText(root.rationale, 2_048),
    evidence_refs: evidenceRefs,
  };
}

function decodeEvidenceReference(value: unknown): ReaderContextEvidenceReferenceV1 {
  const root = kit.object(value);
  kit.exact(root, ["uri", "sha256"]);
  return { uri: boundedText(root.uri, 4_096), sha256: kit.hash(root.sha256) };
}

function decodeSource(value: unknown): ReaderContextProvenanceSourceV1 {
  const root = kit.object(value);
  kit.exact(root, ["uri", "sha256", "role"]);
  return {
    uri: boundedText(root.uri, 4_096),
    sha256: kit.hash(root.sha256),
    role: kit.enumeration(root.role, READER_CONTEXT_SOURCE_ROLES),
  };
}

function decodePolicy(value: unknown): ReaderContextPolicyIdentityV1 {
  const root = kit.object(value);
  kit.exact(root, ["id", "version", "sha256"]);
  return {
    id: boundedText(root.id, 256),
    version: boundedText(root.version, 256),
    sha256: kit.hash(root.sha256),
  };
}

function boundedText(value: unknown, maximumCodePoints: number): string {
  const result = kit.string(value);
  if (result.includes("\r") || !/\S/u.test(result) || [...result].length > maximumCodePoints) {
    fail("invalid-value");
  }
  return result;
}

function boundedTextArray(
  value: unknown,
  minimum: number,
  maximum: number,
  maximumCodePoints: number,
): string[] {
  const result = kit.array(value).map((item) => boundedText(item, maximumCodePoints));
  if (result.length < minimum || result.length > maximum) fail("invalid-value");
  kit.unique(result);
  return result;
}

function rfc3339Utc(value: unknown): string {
  const result = kit.string(value);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(result) ||
    Number.isNaN(Date.parse(result))
  ) {
    fail("invalid-value");
  }
  return result;
}

function evidenceKey(value: ReaderContextEvidenceReferenceV1): string {
  return kit.canonicalJson(value);
}

function sourceKey(value: ReaderContextProvenanceSourceV1): string {
  return kit.canonicalJson(value);
}

function uniqueByCanonical(values: readonly unknown[]): void {
  kit.unique(values.map((value) => kit.canonicalJson(value)));
}

function assertCanonicalSize(value: unknown, maximum: number): void {
  if (Buffer.byteLength(kit.canonicalJson(value), "utf8") > maximum) fail("size-exceeded");
}
