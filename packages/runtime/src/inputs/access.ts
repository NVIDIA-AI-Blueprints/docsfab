// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  canonicalizeJsonEvidence,
  parseJsonEvidence,
  type JsonEvidenceValue,
} from "../json-evidence.js";
import {
  digestExternalInputLocator,
  ExternalInputContractError,
  openExternalInputRegistry,
  registerExternalInput,
  transitionExternalInputLifecycle,
  type ExternalInputHostCapability,
  type ExternalInputLifecycleState,
  type ExternalInputRegistrationV1,
  type ExternalInputRepositoryBindingV1,
  type ExternalInputVersionV1,
} from "./contracts.js";
import { createInputsDialect, deepFreeze } from "./dialect.js";

function fail(code: ExternalInputContractError["code"]): never {
  throw new ExternalInputContractError(code);
}

const {
  canonicalDigest,
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
  enumeration,
  compare,
  unique,
  normalizedHashes,
} = createInputsDialect(fail);

export const EXTERNAL_INPUT_ACCESS_OUTCOMES = [
  "opened",
  "metadata-only",
  "denied",
  "missing",
  "changed-after-registration",
  "excluded-by-policy",
] as const;
export type ExternalInputAccessOutcome = (typeof EXTERNAL_INPUT_ACCESS_OUTCOMES)[number];

export interface ExternalInputAccessObservationInputV1 {
  inputId: string;
  stepId: string;
  outcome: ExternalInputAccessOutcome;
  /** Digest of retrieved content when opened; otherwise null. */
  observedContentDigestSha256: string | null;
  /** Tool or adapter identity; never credentials. */
  accessorId: string;
  evidenceSha256s: string[];
}

export interface ExternalInputAccessObservationV1 extends ExternalInputAccessObservationInputV1 {
  schemaVersion: 1;
  kind: "docsfab-external-input-access-observation";
  observedAt: string;
  observationSha256: string;
}

export interface ExternalInputAccessLedgerV1 {
  schemaVersion: 1;
  kind: "docsfab-external-input-access-ledger";
  runIdSha256: string;
  repository: ExternalInputRepositoryBindingV1;
  observations: ExternalInputAccessObservationV1[];
  ledgerSha256: string;
}

export type FakeExternalInputAdapterKind =
  | "repository-document"
  | "slack-thread"
  | "confluence-page"
  | "upload"
  | "gitlab-issue"
  | "gitlab-mr-note"
  | "url"
  | "direct-instruction";

export interface FakeExternalInputSource {
  adapterKind: FakeExternalInputAdapterKind;
  /** Synthetic canonical locator without credentials. */
  canonicalLocator: string;
  safeTitle: string;
  /** Synthetic body used only to derive digests; never persisted. */
  body: string | null;
  version: ExternalInputVersionV1;
  visibility: ExternalInputRegistrationV1["visibility"];
  disclosurePolicy: ExternalInputRegistrationV1["disclosurePolicy"];
  intendedRoles: ExternalInputRegistrationV1["intendedRoles"];
  /** When true, registration succeeds as inaccessible. */
  inaccessible?: boolean;
  /** When true, registration is excluded by policy. */
  excluded?: boolean;
}

interface AccessCapabilityState {
  runIdSha256: string;
  repository: ExternalInputRepositoryBindingV1;
  registry: ExternalInputHostCapability;
  registrations: Map<string, ExternalInputRegistrationV1>;
  lifecycle: Map<string, ExternalInputLifecycleState>;
  observations: ExternalInputAccessObservationV1[];
  clockMs: number;
}

const accessCapabilities = new WeakMap<object, AccessCapabilityState>();

/**
 * Host-owned access capture surface for one run. Fake adapters register
 * synthetic sources without connector credentials or private persistence.
 */
export function openExternalInputAccessCapture(input: {
  runIdSha256: string;
  repository: ExternalInputRepositoryBindingV1;
}): ExternalInputHostCapability {
  assertInert(input);
  exact(object(input), ["runIdSha256", "repository"]);
  rejectCredentials(input);
  const registry = openExternalInputRegistry({
    runIdSha256: hash(input.runIdSha256),
    repository: repositoryBinding(input.repository),
  });
  accessCapabilities.set(registry as object, {
    runIdSha256: hash(input.runIdSha256),
    repository: repositoryBinding(input.repository),
    registry,
    registrations: new Map(),
    lifecycle: new Map(),
    observations: [],
    clockMs: Date.parse("2026-08-05T20:00:00.000Z"),
  });
  return registry;
}

/** Register a fake adapter source into the host registry for offline acceptance. */
export function registerFakeExternalInput(
  capability: ExternalInputHostCapability,
  inputId: string,
  source: FakeExternalInputSource,
): { registration: ExternalInputRegistrationV1; contentDigestSha256: string | null } {
  const state = requireAccess(capability);
  assertInert(source);
  rejectCredentials({
    inputId,
    safeTitle: source.safeTitle,
    locator: source.canonicalLocator,
  });
  const inaccessible = source.inaccessible === true;
  const excluded = source.excluded === true;
  if (inaccessible && excluded) fail("lifecycle-conflict");
  const metadataOnly =
    source.body === null ||
    source.disclosurePolicy === "identity-only" ||
    source.disclosurePolicy === "redacted" ||
    source.disclosurePolicy === "forbidden" ||
    excluded;
  const contentDigestSha256 =
    source.body === null || inaccessible || metadataOnly
      ? null
      : canonicalDigest({
          kind: "docsfab-external-input-fake-body",
          adapterKind: source.adapterKind,
          body: source.body,
        });
  if (source.disclosurePolicy === "cite-and-quote" && (metadataOnly || inaccessible)) {
    fail("lifecycle-conflict");
  }
  const disclosurePolicy = excluded ? ("forbidden" as const) : source.disclosurePolicy;
  const registration: ExternalInputRegistrationV1 = {
    inputId: identifier(inputId),
    sourceKind: source.adapterKind,
    safeTitle: source.safeTitle,
    locator: {
      adapterKind: source.adapterKind,
      locatorSha256: digestExternalInputLocator(source.canonicalLocator),
      permissionClass: inaccessible ? "inaccessible" : metadataOnly ? "metadata-only" : "readable",
    },
    supplier: {
      kind: "adapter",
      identitySha256: canonicalDigest({
        kind: "docsfab-external-input-fake-adapter",
        adapterKind: source.adapterKind,
      }),
    },
    version: source.version,
    contentDigestSha256,
    visibility: source.visibility,
    disclosurePolicy,
    intendedRoles: [...source.intendedRoles].sort(compare),
    initialLifecycle: excluded ? "excluded" : inaccessible ? "inaccessible" : "supplied",
  };
  registerExternalInput(capability, registration);
  state.registrations.set(registration.inputId, registration);
  state.lifecycle.set(registration.inputId, registration.initialLifecycle);
  return { registration, contentDigestSha256: registration.contentDigestSha256 };
}

/**
 * Register one source document the host actually acquired.
 *
 * Unlike `registerFakeExternalInput`, which digests a synthetic body, this
 * records the producer's real content digest and names the producer as the
 * supplier, so the external-input ledger and the source observation agree.
 */
export function registerTrackedRepositorySourceInput(
  capability: ExternalInputHostCapability,
  input: {
    inputId: string;
    /** Used only to derive the locator digest. */
    canonicalLocator: string;
    safeTitle: string;
    /** Digest of the exact bytes a later read returns. Never null here. */
    contentDigestSha256: string;
    revision: string;
    producerId: string;
    producerVersion: string;
  },
): { registration: ExternalInputRegistrationV1; entrySha256: string } {
  const state = requireAccess(capability);
  assertInert(input);
  rejectCredentials({
    inputId: input.inputId,
    safeTitle: input.safeTitle,
    locator: input.canonicalLocator,
  });
  const registration: ExternalInputRegistrationV1 = {
    inputId: identifier(input.inputId),
    sourceKind: "repository-document",
    safeTitle: string(input.safeTitle),
    locator: {
      adapterKind: "repository-document",
      locatorSha256: digestExternalInputLocator(input.canonicalLocator),
      permissionClass: "readable",
    },
    supplier: {
      kind: "adapter",
      identitySha256: canonicalDigest({
        kind: "docsfab-source-acquisition-producer",
        producerId: identifier(input.producerId),
        producerVersion: identifier(input.producerVersion),
      }),
    },
    version: { kind: "repository-revision", revision: revision(input.revision) },
    contentDigestSha256: hash(input.contentDigestSha256),
    visibility: "internal",
    disclosurePolicy: "cite-and-quote",
    intendedRoles: ["evidence"],
    initialLifecycle: "supplied",
  };
  const entry = registerExternalInput(capability, registration);
  state.registrations.set(registration.inputId, registration);
  state.lifecycle.set(registration.inputId, registration.initialLifecycle);
  return { registration, entrySha256: entry.entrySha256 };
}

/**
 * Record one tool-mediated access against a registered input. Supplying a source
 * does not create an access observation.
 */
export function recordExternalInputAccess(
  capability: ExternalInputHostCapability,
  observation: ExternalInputAccessObservationInputV1,
): ExternalInputAccessObservationV1 {
  const state = requireAccess(capability);
  assertInert(observation);
  exact(object(observation), [
    "inputId",
    "stepId",
    "outcome",
    "observedContentDigestSha256",
    "accessorId",
    "evidenceSha256s",
  ]);
  rejectCredentials(observation);
  const inputId = identifier(observation.inputId);
  const registration = state.registrations.get(inputId);
  if (!registration) fail("invalid-value");
  const outcome = enumeration(observation.outcome, EXTERNAL_INPUT_ACCESS_OUTCOMES);
  const observedContentDigestSha256 = nullableHash(observation.observedContentDigestSha256);
  validateAccessOutcome(registration, outcome, observedContentDigestSha256);
  const observedAt = nextTimestamp(state);
  const sealed = sealObservation({
    inputId,
    stepId: identifier(observation.stepId),
    outcome,
    observedContentDigestSha256,
    accessorId: identifier(observation.accessorId),
    evidenceSha256s: normalizedHashes(observation.evidenceSha256s, true),
    observedAt,
  });
  state.observations.push(sealed);
  applyAccessLifecycle(capability, registration, outcome, inputId, sealed);
  return sealed;
}

export function createExternalInputAccessLedger(
  capability: ExternalInputHostCapability,
): ExternalInputAccessLedgerV1 {
  const state = requireAccess(capability);
  const observations = [...state.observations].sort(observationCompare);
  unique(observations.map((entry) => entry.observationSha256));
  return sealLedger({
    runIdSha256: state.runIdSha256,
    repository: state.repository,
    observations,
  });
}

export function decodeExternalInputAccessLedger(value: unknown): ExternalInputAccessLedgerV1 {
  assertInert(value);
  rejectCredentials(value);
  const root = object(value);
  exact(root, [
    "schemaVersion",
    "kind",
    "runIdSha256",
    "repository",
    "observations",
    "ledgerSha256",
  ]);
  if (root.schemaVersion !== 1 || root.kind !== "docsfab-external-input-access-ledger") {
    fail("migration-required");
  }
  const observations = array(root.observations).map(decodeObservation).sort(observationCompare);
  unique(observations.map((entry) => entry.observationSha256));
  const ledger = sealLedger({
    runIdSha256: hash(root.runIdSha256),
    repository: repositoryBinding(root.repository),
    observations,
  });
  if (root.ledgerSha256 !== ledger.ledgerSha256) fail("digest-mismatch");
  return ledger;
}

export function serializeExternalInputAccessLedger(value: unknown): string {
  return canonicalizeJsonEvidence(
    decodeExternalInputAccessLedger(value) as unknown as JsonEvidenceValue,
  );
}

export function decodePersistedExternalInputAccessLedger(
  value: string | Uint8Array,
): ExternalInputAccessLedgerV1 {
  try {
    return decodeExternalInputAccessLedger(parseJsonEvidence(value, { requireCanonical: true }));
  } catch (error) {
    if (error instanceof ExternalInputContractError) throw error;
    fail("invalid-shape");
  }
}

/** Read-only inspection for citation and disclosure enforcement. */
export function getRegisteredExternalInput(
  capability: ExternalInputHostCapability,
  inputId: string,
): ExternalInputRegistrationV1 {
  const state = requireAccess(capability);
  const registration = state.registrations.get(identifier(inputId));
  if (!registration) fail("invalid-value");
  return registration;
}

export function getExternalInputLifecycleState(
  capability: ExternalInputHostCapability,
  inputId: string,
): ExternalInputLifecycleState {
  const state = requireAccess(capability);
  const id = identifier(inputId);
  const lifecycle = state.lifecycle.get(id);
  if (!lifecycle) fail("invalid-value");
  return lifecycle;
}

export function listExternalInputAccessObservations(
  capability: ExternalInputHostCapability,
  inputId?: string,
): ExternalInputAccessObservationV1[] {
  const state = requireAccess(capability);
  const observations =
    inputId === undefined
      ? state.observations
      : state.observations.filter((entry) => entry.inputId === identifier(inputId));
  return [...observations].sort(observationCompare);
}

export function listRegisteredExternalInputs(
  capability: ExternalInputHostCapability,
): ExternalInputRegistrationV1[] {
  const state = requireAccess(capability);
  return [...state.registrations.values()].sort((left, right) =>
    compare(left.inputId, right.inputId),
  );
}

export function getExternalInputAccessBinding(capability: ExternalInputHostCapability): {
  runIdSha256: string;
  repository: ExternalInputRepositoryBindingV1;
} {
  const state = requireAccess(capability);
  return {
    runIdSha256: state.runIdSha256,
    repository: state.repository,
  };
}

/**
 * Host-only lifecycle advance used by citation. Updates both the registry and
 * the access-capture mirror so reconciliation stays consistent.
 */
export function advanceExternalInputLifecycle(
  capability: ExternalInputHostCapability,
  input: {
    inputId: string;
    to: ExternalInputLifecycleState;
    reasonCode: string;
    evidenceSha256s: string[];
  },
): ExternalInputLifecycleState {
  const state = requireAccess(capability);
  assertInert(input);
  exact(object(input), ["inputId", "to", "reasonCode", "evidenceSha256s"]);
  const inputId = identifier(input.inputId);
  const from = state.lifecycle.get(inputId);
  if (!from) fail("invalid-value");
  const to = enumeration(input.to, [
    "supplied",
    "discovered",
    "accessed",
    "cited",
    "unused",
    "inaccessible",
    "changed",
    "revoked",
    "excluded",
  ] as const);
  transitionExternalInputLifecycle(capability, {
    inputId,
    from,
    to,
    reasonCode: identifier(input.reasonCode),
    evidenceSha256s: normalizedHashes(input.evidenceSha256s, true),
  });
  state.lifecycle.set(inputId, to);
  return to;
}

/** Map access outcomes onto registry lifecycle without inventing influence. */
function applyAccessLifecycle(
  capability: ExternalInputHostCapability,
  registration: ExternalInputRegistrationV1,
  outcome: ExternalInputAccessOutcome,
  inputId: string,
  observation: ExternalInputAccessObservationV1,
): void {
  const state = requireAccess(capability);
  const from = state.lifecycle.get(inputId) ?? registration.initialLifecycle;
  if (from === "inaccessible" || from === "excluded" || from === "revoked") return;
  const to: ExternalInputLifecycleState | null =
    outcome === "opened" || outcome === "metadata-only"
      ? "accessed"
      : (outcome === "denied" || outcome === "missing") && registration.contentDigestSha256 === null
        ? "inaccessible"
        : outcome === "changed-after-registration"
          ? "changed"
          : outcome === "excluded-by-policy"
            ? "excluded"
            : null;
  if (to === null || to === from) return;
  // Permission class must already allow inaccessible lifecycle when mapping there.
  if (to === "inaccessible" && registration.locator.permissionClass !== "inaccessible") {
    return;
  }
  try {
    transitionExternalInputLifecycle(capability, {
      inputId,
      from,
      to,
      reasonCode: `access-${outcome}`,
      evidenceSha256s: [observation.observationSha256],
    });
    state.lifecycle.set(inputId, to);
  } catch (error) {
    if (!(error instanceof ExternalInputContractError) || error.code !== "lifecycle-conflict")
      throw error;
  }
}

function validateAccessOutcome(
  registration: ExternalInputRegistrationV1,
  outcome: ExternalInputAccessOutcome,
  observedContentDigestSha256: string | null,
): void {
  if (registration.initialLifecycle === "excluded" && outcome !== "excluded-by-policy")
    fail("lifecycle-conflict");
  if (
    registration.locator.permissionClass === "inaccessible" &&
    (outcome === "opened" || outcome === "metadata-only")
  )
    fail("lifecycle-conflict");
  if (outcome === "opened") {
    if (observedContentDigestSha256 === null) fail("lifecycle-conflict");
    if (
      registration.contentDigestSha256 !== null &&
      observedContentDigestSha256 !== registration.contentDigestSha256
    ) {
      fail("substitution");
    }
  } else if (outcome === "changed-after-registration") {
    if (
      observedContentDigestSha256 === null ||
      registration.contentDigestSha256 === null ||
      observedContentDigestSha256 === registration.contentDigestSha256
    ) {
      fail("lifecycle-conflict");
    }
  } else if (observedContentDigestSha256 !== null) {
    fail("lifecycle-conflict");
  }
}

function requireAccess(capability: ExternalInputHostCapability): AccessCapabilityState {
  const state = accessCapabilities.get(capability as object);
  if (!state) fail("authority-required");
  return state;
}

function decodeObservation(value: unknown): ExternalInputAccessObservationV1 {
  assertInert(value);
  rejectCredentials(value);
  const root = object(value);
  exact(root, [
    "schemaVersion",
    "kind",
    "inputId",
    "stepId",
    "outcome",
    "observedContentDigestSha256",
    "accessorId",
    "evidenceSha256s",
    "observedAt",
    "observationSha256",
  ]);
  if (root.schemaVersion !== 1 || root.kind !== "docsfab-external-input-access-observation") {
    fail("migration-required");
  }
  const sealed = sealObservation({
    inputId: identifier(root.inputId),
    stepId: identifier(root.stepId),
    outcome: enumeration(root.outcome, EXTERNAL_INPUT_ACCESS_OUTCOMES),
    observedContentDigestSha256: nullableHash(root.observedContentDigestSha256),
    accessorId: identifier(root.accessorId),
    evidenceSha256s: normalizedHashes(root.evidenceSha256s, true),
    observedAt: timestamp(root.observedAt),
  });
  if (root.observationSha256 !== sealed.observationSha256) fail("digest-mismatch");
  return sealed;
}

function sealObservation(
  body: Omit<ExternalInputAccessObservationV1, "schemaVersion" | "kind" | "observationSha256">,
): ExternalInputAccessObservationV1 {
  const envelope = {
    schemaVersion: 1 as const,
    kind: "docsfab-external-input-access-observation" as const,
    ...body,
  };
  return deepFreeze({
    ...envelope,
    observationSha256: canonicalDigest(envelope),
  });
}

function sealLedger(
  body: Omit<ExternalInputAccessLedgerV1, "schemaVersion" | "kind" | "ledgerSha256">,
): ExternalInputAccessLedgerV1 {
  const envelope = {
    schemaVersion: 1 as const,
    kind: "docsfab-external-input-access-ledger" as const,
    ...body,
  };
  return deepFreeze({
    ...envelope,
    ledgerSha256: canonicalDigest(envelope),
  });
}

function nextTimestamp(state: AccessCapabilityState): string {
  state.clockMs += 1_000;
  return new Date(state.clockMs).toISOString();
}

function repositoryBinding(value: unknown): ExternalInputRepositoryBindingV1 {
  const root = object(value);
  exact(root, ["identitySha256", "revision"]);
  return { identitySha256: hash(root.identitySha256), revision: revision(root.revision) };
}

function observationCompare(
  left: ExternalInputAccessObservationV1,
  right: ExternalInputAccessObservationV1,
): number {
  return compare(left.observationSha256, right.observationSha256);
}
