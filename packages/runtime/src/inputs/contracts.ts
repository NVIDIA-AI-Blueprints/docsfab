// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  canonicalizeJsonEvidence,
  parseJsonEvidence,
  type JsonEvidenceValue,
} from "../json-evidence.js";
import { createInputsDialect, createInputsReceiptGuard, deepFreeze } from "./dialect.js";
import {
  internalExternalInputHostVerifier,
  type InternalExternalInputHostAuthority,
  type InternalExternalInputHostVerifier,
} from "./authority-internal.js";

export const EXTERNAL_INPUT_SCHEMA_VERSION = 1 as const;

export const EXTERNAL_INPUT_SOURCE_KINDS = [
  "direct-instruction",
  "repository-document",
  "slack-thread",
  "confluence-page",
  "upload",
  "gitlab-issue",
  "gitlab-mr-note",
  "url",
] as const;
export type ExternalInputSourceKind = (typeof EXTERNAL_INPUT_SOURCE_KINDS)[number];

export const EXTERNAL_INPUT_LIFECYCLE_STATES = [
  "supplied",
  "discovered",
  "accessed",
  "cited",
  "unused",
  "inaccessible",
  "changed",
  "revoked",
  "excluded",
] as const;
export type ExternalInputLifecycleState = (typeof EXTERNAL_INPUT_LIFECYCLE_STATES)[number];

export const EXTERNAL_INPUT_INITIAL_LIFECYCLE_STATES = [
  "supplied",
  "discovered",
  "inaccessible",
  "excluded",
] as const;
export type ExternalInputInitialLifecycleState =
  (typeof EXTERNAL_INPUT_INITIAL_LIFECYCLE_STATES)[number];

export const EXTERNAL_INPUT_VISIBILITY = ["public", "internal", "restricted", "private"] as const;
export type ExternalInputVisibility = (typeof EXTERNAL_INPUT_VISIBILITY)[number];

export const EXTERNAL_INPUT_DISCLOSURE_POLICIES = [
  "cite-and-quote",
  "cite-only",
  "identity-only",
  "redacted",
  "forbidden",
] as const;
export type ExternalInputDisclosurePolicy = (typeof EXTERNAL_INPUT_DISCLOSURE_POLICIES)[number];

export const EXTERNAL_INPUT_INTENDED_ROLES = [
  "requirement",
  "evidence",
  "background",
  "validation",
  "contradictory",
  "context",
] as const;
export type ExternalInputIntendedRole = (typeof EXTERNAL_INPUT_INTENDED_ROLES)[number];

export const EXTERNAL_INPUT_SUPPLIER_KINDS = ["operator", "host", "adapter"] as const;
export type ExternalInputSupplierKind = (typeof EXTERNAL_INPUT_SUPPLIER_KINDS)[number];

export const EXTERNAL_INPUT_LOCATOR_PERMISSION_CLASSES = [
  "readable",
  "metadata-only",
  "inaccessible",
] as const;
export type ExternalInputLocatorPermissionClass =
  (typeof EXTERNAL_INPUT_LOCATOR_PERMISSION_CLASSES)[number];

export interface ExternalInputRepositoryBindingV1 {
  identitySha256: string;
  revision: string;
}

export interface ExternalInputRunBindingV1 {
  runIdSha256: string;
  repository: ExternalInputRepositoryBindingV1;
}

export interface ExternalInputLocatorV1 {
  adapterKind: ExternalInputSourceKind;
  /** Digest of the canonical permission-aware locator; never a raw tokenized URL. */
  locatorSha256: string;
  permissionClass: ExternalInputLocatorPermissionClass;
}

export interface ExternalInputSupplierV1 {
  kind: ExternalInputSupplierKind;
  identitySha256: string;
}

export type ExternalInputVersionV1 =
  | { kind: "repository-revision"; revision: string }
  | { kind: "timestamp"; observedAt: string }
  | { kind: "etag"; etagSha256: string }
  | { kind: "content-digest"; contentDigestSha256: string }
  | { kind: "unavailable"; reasonCode: string };

export interface ExternalInputRegistrationV1 {
  inputId: string;
  sourceKind: ExternalInputSourceKind;
  /** Bounded operator-safe title; never a private body or credential. */
  safeTitle: string;
  locator: ExternalInputLocatorV1;
  supplier: ExternalInputSupplierV1;
  version: ExternalInputVersionV1;
  /** Content digest at registration; null when body was unavailable. */
  contentDigestSha256: string | null;
  visibility: ExternalInputVisibility;
  disclosurePolicy: ExternalInputDisclosurePolicy;
  intendedRoles: ExternalInputIntendedRole[];
  initialLifecycle: ExternalInputInitialLifecycleState;
}

export interface ExternalInputEntryV1
  extends Omit<ExternalInputRegistrationV1, "initialLifecycle"> {
  lifecycleState: ExternalInputLifecycleState;
  entrySha256: string;
}

export interface ExternalInputLifecycleTransitionV1 {
  inputId: string;
  from: ExternalInputLifecycleState;
  to: ExternalInputLifecycleState;
  reasonCode: string;
  evidenceSha256s: string[];
}

export interface ExternalInputAuthorityChallengeV1 {
  schemaVersion: 1;
  kind: "docsfab-external-input-authority-challenge";
  runIdSha256: string;
  repository: ExternalInputRepositoryBindingV1;
  entrySha256s: string[];
  proposedManifestSha256: string;
  challengeSha256: string;
}

/** Non-serializable capability; private object identity, not fields, is authority. */
export interface ExternalInputHostCapability {
  readonly kind: "docsfab-external-input-host-capability";
}

export interface ExternalInputManifestV1 {
  schemaVersion: 1;
  kind: "docsfab-external-input-manifest";
  runIdSha256: string;
  repository: ExternalInputRepositoryBindingV1;
  entries: ExternalInputEntryV1[];
  authorityStatus: "host-authenticated" | "historical-inert";
  observedAt: string | null;
  authorityReceiptSha256: string | null;
  manifestSha256: string;
}

export interface ExternalInputManifestProjectionV1 {
  schemaVersion: 1;
  kind: "docsfab-external-input-manifest-projection";
  runIdSha256: string;
  repositoryIdentitySha256: string;
  repositoryRevision: string;
  entries: Array<{
    inputIdSha256: string;
    sourceKind: ExternalInputSourceKind;
    locatorSha256: string;
    permissionClass: ExternalInputLocatorPermissionClass;
    visibility: ExternalInputVisibility;
    disclosurePolicy: ExternalInputDisclosurePolicy;
    intendedRoles: ExternalInputIntendedRole[];
    lifecycleState: ExternalInputLifecycleState;
    contentDigestPresent: boolean;
    entrySha256: string;
  }>;
  authorityStatus: "host-authenticated" | "historical-inert";
  manifestSha256: string;
  projectionSha256: string;
}

export const EXTERNAL_INPUT_MIGRATION_POLICY = deepFreeze({
  schemaVersion: 1 as const,
  kind: "docsfab-external-input-migration-policy" as const,
  currentSchemaVersion: 1 as const,
  acceptedSourceVersions: [1] as const,
  absentHistoricalManifest: "explicit-empty-historical-only" as const,
  historicalAuthority: "none" as const,
  unknownVersion: "reject" as const,
  retention: "identity-and-lifecycle-only" as const,
});

export type ExternalInputContractErrorCode =
  | "invalid-shape"
  | "invalid-value"
  | "digest-mismatch"
  | "credential-material"
  | "duplicate-input"
  | "lifecycle-conflict"
  | "authority-required"
  | "authority-replayed"
  | "substitution"
  | "migration-required";

export class ExternalInputContractError extends Error {
  public constructor(public readonly code: ExternalInputContractErrorCode) {
    super(`External-input contract rejected: ${code}.`);
    this.name = "ExternalInputContractError";
  }
}

function fail(code: ExternalInputContractErrorCode): never {
  throw new ExternalInputContractError(code);
}

const {
  canonicalDigest,
  canonicalJson,
  assertInert,
  rejectCredentials,
  object,
  exact,
  array,
  string,
  identifier,
  hash,
  nullableHash,
  revision,
  timestamp,
  nullableTimestamp,
  enumeration,
  compare,
  unique,
  normalizedHashes,
  seal,
  decodeSealed,
  sourceVersion,
} = createInputsDialect(fail);

const receiptGuard = createInputsReceiptGuard(fail);

interface CapabilityState {
  binding: ExternalInputRunBindingV1;
  entries: Map<string, ExternalInputEntryV1>;
  sealed: ExternalInputManifestV1 | null;
}

const capabilities = new WeakMap<object, CapabilityState>();
const authenticManifests = new WeakMap<object, string>();

const SAFE_TITLE_MAX = 256;

/**
 * Open a host-owned registry for one run binding. Entries remain mutable only
 * through this private capability until the manifest is sealed.
 */
export function openExternalInputRegistry(
  binding: ExternalInputRunBindingV1,
): ExternalInputHostCapability {
  assertInert(binding);
  exact(object(binding), ["runIdSha256", "repository"]);
  rejectCredentials(binding);
  const normalized = {
    runIdSha256: hash(binding.runIdSha256),
    repository: repositoryBinding(binding.repository),
  };
  const capability = deepFreeze({ kind: "docsfab-external-input-host-capability" as const });
  capabilities.set(capability, {
    binding: normalized,
    entries: new Map(),
    sealed: null,
  });
  return capability;
}

/** Host-only registration. Caller- or model-authored lookalikes cannot open a registry. */
export function registerExternalInput(
  capability: ExternalInputHostCapability,
  registration: ExternalInputRegistrationV1,
): ExternalInputEntryV1 {
  const state = requireOpen(capability);
  assertInert(registration);
  rejectCredentials(registration);
  const entry = sealEntry(normalizeRegistration(registration));
  if (state.entries.has(entry.inputId)) fail("duplicate-input");
  state.entries.set(entry.inputId, entry);
  return entry;
}

/**
 * Host-only lifecycle transition. Access and citation capture use this path;
 * decoded manifests cannot invent new states.
 */
export function transitionExternalInputLifecycle(
  capability: ExternalInputHostCapability,
  transition: ExternalInputLifecycleTransitionV1,
): ExternalInputEntryV1 {
  const state = requireOpen(capability);
  assertInert(transition);
  exact(object(transition), ["inputId", "from", "to", "reasonCode", "evidenceSha256s"]);
  rejectCredentials(transition);
  const inputId = identifier(transition.inputId);
  const existing = state.entries.get(inputId);
  if (!existing) fail("invalid-value");
  const from = enumeration(transition.from, EXTERNAL_INPUT_LIFECYCLE_STATES);
  const to = enumeration(transition.to, EXTERNAL_INPUT_LIFECYCLE_STATES);
  if (existing.lifecycleState !== from) fail("lifecycle-conflict");
  assertAllowedTransition(from, to, existing);
  const evidenceSha256s = normalizedHashes(transition.evidenceSha256s, true);
  const reasonCode = identifier(transition.reasonCode);
  void evidenceSha256s;
  void reasonCode;
  const next = sealEntry({
    inputId: existing.inputId,
    sourceKind: existing.sourceKind,
    safeTitle: existing.safeTitle,
    locator: existing.locator,
    supplier: existing.supplier,
    version: existing.version,
    contentDigestSha256: existing.contentDigestSha256,
    visibility: existing.visibility,
    disclosurePolicy: existing.disclosurePolicy,
    intendedRoles: existing.intendedRoles,
    lifecycleState: to,
  });
  state.entries.set(inputId, next);
  return next;
}

/**
 * Mint an authenticated manifest after a trusted host verifies the content-free
 * challenge. Serialized copies remain inert without the original capability.
 */
export async function mintExternalInputManifest(
  capability: ExternalInputHostCapability,
  authority: InternalExternalInputHostAuthority,
): Promise<ExternalInputManifestV1> {
  const state = requireOpen(capability);
  const verifier = internalExternalInputHostVerifier(authority);
  if (!verifier) fail("authority-required");
  const provisional = provisionalManifest(
    state,
    "host-authenticated",
    "1970-01-01T00:00:00.000Z",
    "0".repeat(64),
  );
  const challengeBody = {
    runIdSha256: provisional.runIdSha256,
    repository: provisional.repository,
    entrySha256s: provisional.entries.map((entry) => entry.entrySha256),
    proposedManifestSha256: provisional.manifestSha256,
  };
  const challenge = seal(
    "docsfab-external-input-authority-challenge",
    "challengeSha256",
    challengeBody,
  );
  const verified = await verifier.verifyCurrent(challenge);
  assertInert(verified);
  exact(object(verified), ["status", "challengeSha256", "observedAt", "authorityReceiptSha256"]);
  if (verified.status !== "current" || verified.challengeSha256 !== challenge.challengeSha256) {
    fail("authority-required");
  }
  const observedAt = timestamp(verified.observedAt);
  const receipt = hash(verified.authorityReceiptSha256);
  consumeReceipt(verifier, receipt);
  // Never reread mutable registry state after the asynchronous host check.
  const manifest = sealManifest({
    runIdSha256: provisional.runIdSha256,
    repository: provisional.repository,
    entries: provisional.entries,
    authorityStatus: "host-authenticated",
    observedAt,
    authorityReceiptSha256: receipt,
  });
  state.sealed = manifest;
  authenticManifests.set(manifest, manifest.manifestSha256);
  return manifest;
}

/** Explicit empty historical state. Readable and digest-bound but always inert. */
export function createHistoricalEmptyExternalInputManifest(input: {
  runIdSha256: string;
  repository: ExternalInputRepositoryBindingV1;
}): ExternalInputManifestV1 {
  assertInert(input);
  exact(object(input), ["runIdSha256", "repository"]);
  rejectCredentials(input);
  return sealManifest({
    runIdSha256: hash(input.runIdSha256),
    repository: repositoryBinding(input.repository),
    entries: [],
    authorityStatus: "historical-inert",
    observedAt: null,
    authorityReceiptSha256: null,
  });
}

/** Structural decoder only. Successfully decoded persisted JSON grants no authority. */
export function decodeExternalInputManifest(value: unknown): ExternalInputManifestV1 {
  return decodeSealed(
    value,
    "docsfab-external-input-manifest",
    "manifestSha256",
    [
      "runIdSha256",
      "repository",
      "entries",
      "authorityStatus",
      "observedAt",
      "authorityReceiptSha256",
    ],
    (root) => normalizeManifestBody(root),
  ) as ExternalInputManifestV1;
}

export function serializeExternalInputManifest(value: unknown): string {
  return canonicalizeJsonEvidence(
    decodeExternalInputManifest(value) as unknown as JsonEvidenceValue,
  );
}

export function decodePersistedExternalInputManifest(
  value: string | Uint8Array,
): ExternalInputManifestV1 {
  try {
    return decodeExternalInputManifest(parseJsonEvidence(value, { requireCanonical: true }));
  } catch (error) {
    if (error instanceof ExternalInputContractError) throw error;
    fail("invalid-shape");
  }
}

/** Re-authenticate an exact persisted manifest against its original host capability. */
export function restoreExternalInputManifest(
  value: unknown,
  capability: ExternalInputHostCapability,
): ExternalInputManifestV1 {
  const state = capabilities.get(capability as object);
  if (!state?.sealed) fail("authority-required");
  const decoded = decodeExternalInputManifest(value);
  if (canonicalJson(decoded) !== canonicalJson(state.sealed)) fail("authority-required");
  authenticManifests.set(state.sealed, state.sealed.manifestSha256);
  return state.sealed;
}

export function assertExternalInputManifestAuthentic(value: ExternalInputManifestV1): void {
  const decoded = decodeExternalInputManifest(value);
  if (authenticManifests.get(value as object) !== decoded.manifestSha256) {
    fail("authority-required");
  }
}

export function projectExternalInputManifest(value: unknown): ExternalInputManifestProjectionV1 {
  const manifest = decodeExternalInputManifest(value);
  const body = {
    runIdSha256: manifest.runIdSha256,
    repositoryIdentitySha256: manifest.repository.identitySha256,
    repositoryRevision: manifest.repository.revision,
    entries: manifest.entries.map((entry) => ({
      inputIdSha256: canonicalDigest(entry.inputId),
      sourceKind: entry.sourceKind,
      locatorSha256: entry.locator.locatorSha256,
      permissionClass: entry.locator.permissionClass,
      visibility: entry.visibility,
      disclosurePolicy: entry.disclosurePolicy,
      intendedRoles: entry.intendedRoles,
      lifecycleState: entry.lifecycleState,
      contentDigestPresent: entry.contentDigestSha256 !== null,
      entrySha256: entry.entrySha256,
    })),
    authorityStatus: manifest.authorityStatus,
    manifestSha256: manifest.manifestSha256,
  };
  return seal("docsfab-external-input-manifest-projection", "projectionSha256", body);
}

export function migrateExternalInputManifest(value: unknown): ExternalInputManifestV1 {
  if (sourceVersion(value) !== 1) fail("migration-required");
  return decodeExternalInputManifest(value);
}

/** Digest a canonical locator string without retaining it in the record. */
export function digestExternalInputLocator(canonicalLocator: string): string {
  if (
    typeof canonicalLocator !== "string" ||
    canonicalLocator !== canonicalLocator.normalize("NFC") ||
    canonicalLocator.length === 0 ||
    canonicalLocator.length > 8_192 ||
    canonicalLocator.includes("\0")
  ) {
    fail("invalid-value");
  }
  rejectCredentials({ locator: canonicalLocator });
  return canonicalDigest({ kind: "docsfab-external-input-locator", locator: canonicalLocator });
}

function requireOpen(capability: ExternalInputHostCapability): CapabilityState {
  const state = capabilities.get(capability as object);
  if (!state) fail("authority-required");
  if (state.sealed) fail("authority-required");
  return state;
}

function provisionalManifest(
  state: CapabilityState,
  status: "host-authenticated" | "historical-inert",
  observedAt: string | null,
  receipt: string | null,
): ExternalInputManifestV1 {
  const entries = [...state.entries.values()].sort(entryCompare);
  unique(entries.map((entry) => entry.inputId));
  unique(entries.map((entry) => entry.entrySha256));
  return sealManifest({
    runIdSha256: state.binding.runIdSha256,
    repository: state.binding.repository,
    entries,
    authorityStatus: status,
    observedAt,
    authorityReceiptSha256: receipt,
  });
}

function normalizeRegistration(
  value: ExternalInputRegistrationV1,
): Omit<ExternalInputEntryV1, "entrySha256"> {
  const root = object(value);
  exact(root, [
    "inputId",
    "sourceKind",
    "safeTitle",
    "locator",
    "supplier",
    "version",
    "contentDigestSha256",
    "visibility",
    "disclosurePolicy",
    "intendedRoles",
    "initialLifecycle",
  ]);
  const sourceKind = enumeration(root.sourceKind, EXTERNAL_INPUT_SOURCE_KINDS);
  const locator = inputLocator(root.locator, sourceKind);
  const initialLifecycle = enumeration(
    root.initialLifecycle,
    EXTERNAL_INPUT_INITIAL_LIFECYCLE_STATES,
  );
  const contentDigestSha256 = nullableHash(root.contentDigestSha256);
  const visibility = enumeration(root.visibility, EXTERNAL_INPUT_VISIBILITY);
  const disclosurePolicy = enumeration(root.disclosurePolicy, EXTERNAL_INPUT_DISCLOSURE_POLICIES);
  validateRegistrationConsistency({
    sourceKind,
    locator,
    initialLifecycle,
    contentDigestSha256,
    visibility,
    disclosurePolicy,
  });
  return {
    inputId: identifier(root.inputId),
    sourceKind,
    safeTitle: safeTitle(root.safeTitle),
    locator,
    supplier: inputSupplier(root.supplier),
    version: inputVersion(root.version),
    contentDigestSha256,
    visibility,
    disclosurePolicy,
    intendedRoles: intendedRoles(root.intendedRoles),
    lifecycleState: initialLifecycle,
  };
}

function normalizeManifestBody(
  root: Record<string, unknown>,
): Omit<ExternalInputManifestV1, "schemaVersion" | "kind" | "manifestSha256"> {
  const entries = array(root.entries).map(decodeEntry).sort(entryCompare);
  unique(entries.map((entry) => entry.inputId));
  unique(entries.map((entry) => entry.entrySha256));
  const status = enumeration(root.authorityStatus, [
    "host-authenticated",
    "historical-inert",
  ] as const);
  const observedAt = nullableTimestamp(root.observedAt);
  const receipt = nullableHash(root.authorityReceiptSha256);
  const historical = status === "historical-inert";
  if (historical !== (observedAt === null) || historical !== (receipt === null)) {
    fail("invalid-value");
  }
  if (historical && entries.length !== 0) fail("invalid-value");
  return {
    runIdSha256: hash(root.runIdSha256),
    repository: repositoryBinding(root.repository),
    entries,
    authorityStatus: status,
    observedAt,
    authorityReceiptSha256: receipt,
  };
}

function decodeEntry(value: unknown): ExternalInputEntryV1 {
  assertInert(value);
  rejectCredentials(value);
  const root = object(value);
  exact(root, [
    "inputId",
    "sourceKind",
    "safeTitle",
    "locator",
    "supplier",
    "version",
    "contentDigestSha256",
    "visibility",
    "disclosurePolicy",
    "intendedRoles",
    "lifecycleState",
    "entrySha256",
  ]);
  const sourceKind = enumeration(root.sourceKind, EXTERNAL_INPUT_SOURCE_KINDS);
  const locator = inputLocator(root.locator, sourceKind);
  const lifecycleState = enumeration(root.lifecycleState, EXTERNAL_INPUT_LIFECYCLE_STATES);
  const contentDigestSha256 = nullableHash(root.contentDigestSha256);
  const visibility = enumeration(root.visibility, EXTERNAL_INPUT_VISIBILITY);
  const disclosurePolicy = enumeration(root.disclosurePolicy, EXTERNAL_INPUT_DISCLOSURE_POLICIES);
  validateEntryConsistency({
    sourceKind,
    locator,
    lifecycleState,
    contentDigestSha256,
    visibility,
    disclosurePolicy,
  });
  const body = {
    inputId: identifier(root.inputId),
    sourceKind,
    safeTitle: safeTitle(root.safeTitle),
    locator,
    supplier: inputSupplier(root.supplier),
    version: inputVersion(root.version),
    contentDigestSha256,
    visibility,
    disclosurePolicy,
    intendedRoles: intendedRoles(root.intendedRoles),
    lifecycleState,
  };
  const entry = sealEntry(body);
  if (root.entrySha256 !== entry.entrySha256) fail("digest-mismatch");
  return entry;
}

function validateRegistrationConsistency(input: {
  sourceKind: ExternalInputSourceKind;
  locator: ExternalInputLocatorV1;
  initialLifecycle: ExternalInputInitialLifecycleState;
  contentDigestSha256: string | null;
  visibility: ExternalInputVisibility;
  disclosurePolicy: ExternalInputDisclosurePolicy;
}): void {
  if (input.locator.adapterKind !== input.sourceKind) fail("substitution");
  if (input.initialLifecycle === "inaccessible") {
    if (input.locator.permissionClass !== "inaccessible" || input.contentDigestSha256 !== null)
      fail("lifecycle-conflict");
  } else if (input.locator.permissionClass === "inaccessible") {
    fail("lifecycle-conflict");
  }
  if (input.initialLifecycle === "excluded" && input.disclosurePolicy !== "forbidden")
    fail("lifecycle-conflict");
  if (input.disclosurePolicy === "forbidden" && input.visibility === "public")
    fail("lifecycle-conflict");
  if (
    input.locator.permissionClass === "metadata-only" &&
    (input.disclosurePolicy === "cite-and-quote" || input.contentDigestSha256 !== null)
  )
    fail("lifecycle-conflict");
}

function validateEntryConsistency(input: {
  sourceKind: ExternalInputSourceKind;
  locator: ExternalInputLocatorV1;
  lifecycleState: ExternalInputLifecycleState;
  contentDigestSha256: string | null;
  visibility: ExternalInputVisibility;
  disclosurePolicy: ExternalInputDisclosurePolicy;
}): void {
  if (input.locator.adapterKind !== input.sourceKind) fail("substitution");
  if (
    input.lifecycleState === "inaccessible" &&
    (input.locator.permissionClass !== "inaccessible" || input.contentDigestSha256 !== null)
  )
    fail("lifecycle-conflict");
  if (input.lifecycleState === "excluded" && input.disclosurePolicy !== "forbidden")
    fail("lifecycle-conflict");
  if (input.disclosurePolicy === "forbidden" && input.visibility === "public")
    fail("lifecycle-conflict");
  if (
    input.locator.permissionClass === "metadata-only" &&
    (input.disclosurePolicy === "cite-and-quote" || input.contentDigestSha256 !== null)
  )
    fail("lifecycle-conflict");
  if (
    (input.lifecycleState === "accessed" || input.lifecycleState === "cited") &&
    input.locator.permissionClass === "inaccessible"
  )
    fail("lifecycle-conflict");
  if (
    input.lifecycleState === "cited" &&
    (input.disclosurePolicy === "forbidden" || input.disclosurePolicy === "redacted")
  )
    fail("lifecycle-conflict");
}

function assertAllowedTransition(
  from: ExternalInputLifecycleState,
  to: ExternalInputLifecycleState,
  entry: ExternalInputEntryV1,
): void {
  if (from === to) fail("lifecycle-conflict");
  const allowed = TRANSITIONS[from];
  if (!allowed.includes(to)) fail("lifecycle-conflict");
  if (to === "accessed" && entry.locator.permissionClass === "inaccessible") {
    fail("lifecycle-conflict");
  }
  if (
    to === "cited" &&
    (entry.disclosurePolicy === "forbidden" || entry.disclosurePolicy === "redacted")
  )
    fail("lifecycle-conflict");
  if (to === "inaccessible" && entry.contentDigestSha256 !== null) fail("lifecycle-conflict");
}

const TRANSITIONS: Record<ExternalInputLifecycleState, ExternalInputLifecycleState[]> = {
  supplied: ["accessed", "unused", "inaccessible", "changed", "revoked", "excluded"],
  discovered: ["accessed", "unused", "inaccessible", "changed", "revoked", "excluded"],
  accessed: ["cited", "changed", "revoked", "excluded"],
  cited: ["changed", "revoked"],
  unused: ["revoked", "excluded"],
  inaccessible: ["revoked", "excluded", "changed"],
  changed: ["revoked", "excluded"],
  revoked: [],
  excluded: [],
};

function inputLocator(
  value: unknown,
  expectedKind: ExternalInputSourceKind,
): ExternalInputLocatorV1 {
  const root = object(value);
  exact(root, ["adapterKind", "locatorSha256", "permissionClass"]);
  const adapterKind = enumeration(root.adapterKind, EXTERNAL_INPUT_SOURCE_KINDS);
  if (adapterKind !== expectedKind) fail("substitution");
  return {
    adapterKind,
    locatorSha256: hash(root.locatorSha256),
    permissionClass: enumeration(root.permissionClass, EXTERNAL_INPUT_LOCATOR_PERMISSION_CLASSES),
  };
}

function inputSupplier(value: unknown): ExternalInputSupplierV1 {
  const root = object(value);
  exact(root, ["kind", "identitySha256"]);
  return {
    kind: enumeration(root.kind, EXTERNAL_INPUT_SUPPLIER_KINDS),
    identitySha256: hash(root.identitySha256),
  };
}

function inputVersion(value: unknown): ExternalInputVersionV1 {
  const root = object(value);
  const kind = enumeration(root.kind, [
    "repository-revision",
    "timestamp",
    "etag",
    "content-digest",
    "unavailable",
  ] as const);
  if (kind === "repository-revision") {
    exact(root, ["kind", "revision"]);
    return { kind, revision: revision(root.revision) };
  }
  if (kind === "timestamp") {
    exact(root, ["kind", "observedAt"]);
    return { kind, observedAt: timestamp(root.observedAt) };
  }
  if (kind === "etag") {
    exact(root, ["kind", "etagSha256"]);
    return { kind, etagSha256: hash(root.etagSha256) };
  }
  if (kind === "content-digest") {
    exact(root, ["kind", "contentDigestSha256"]);
    return { kind, contentDigestSha256: hash(root.contentDigestSha256) };
  }
  exact(root, ["kind", "reasonCode"]);
  return { kind, reasonCode: identifier(root.reasonCode) };
}

function intendedRoles(value: unknown): ExternalInputIntendedRole[] {
  const roles = array(value)
    .map((role) => enumeration(role, EXTERNAL_INPUT_INTENDED_ROLES))
    .sort(compare);
  unique(roles);
  if (roles.length === 0) fail("invalid-value");
  return roles;
}

function safeTitle(value: unknown): string {
  const result = string(value);
  if (result.length === 0 || result.length > SAFE_TITLE_MAX || /^\s|\s$/u.test(result)) {
    fail("invalid-value");
  }
  rejectCredentials({ safeTitle: result });
  return result;
}

function sealEntry(body: Omit<ExternalInputEntryV1, "entrySha256">): ExternalInputEntryV1 {
  return deepFreeze({ ...body, entrySha256: canonicalDigest(body) });
}

function sealManifest(
  body: Omit<ExternalInputManifestV1, "schemaVersion" | "kind" | "manifestSha256">,
): ExternalInputManifestV1 {
  return seal("docsfab-external-input-manifest", "manifestSha256", body);
}

function repositoryBinding(value: unknown): ExternalInputRepositoryBindingV1 {
  const root = object(value);
  exact(root, ["identitySha256", "revision"]);
  return { identitySha256: hash(root.identitySha256), revision: revision(root.revision) };
}

function consumeReceipt(verifier: InternalExternalInputHostVerifier, receipt: string): void {
  receiptGuard.consume(verifier as object, receipt);
}

function entryCompare(left: ExternalInputEntryV1, right: ExternalInputEntryV1): number {
  return compare(left.inputId, right.inputId);
}
