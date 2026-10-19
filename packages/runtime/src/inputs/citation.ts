// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  canonicalizeJsonEvidence,
  parseJsonEvidence,
  type JsonEvidenceValue,
} from "../json-evidence.js";
import {
  advanceExternalInputLifecycle,
  getExternalInputAccessBinding,
  getExternalInputLifecycleState,
  getRegisteredExternalInput,
  listExternalInputAccessObservations,
  listRegisteredExternalInputs,
} from "./access.js";
import {
  ExternalInputContractError,
  type ExternalInputDisclosurePolicy,
  type ExternalInputHostCapability,
  type ExternalInputIntendedRole,
  type ExternalInputLifecycleState,
  type ExternalInputRepositoryBindingV1,
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
  noUnknown,
  array,
  string,
  identifier,
  hash,
  nullableHash,
  enumeration,
  compare,
  unique,
  normalizedHashes,
} = createInputsDialect(fail);

export const EXTERNAL_INPUT_CITATION_ROLES = [
  "requirement",
  "evidence",
  "background",
  "validation",
  "contradictory",
] as const;
export type ExternalInputCitationRole = (typeof EXTERNAL_INPUT_CITATION_ROLES)[number];

export const EXTERNAL_INPUT_CITATION_DIAGNOSTICS = [
  "unknown-input",
  "role-not-allowed",
  "lifecycle-incompatible",
  "disclosure-incompatible",
  "access-required",
  "stale-or-changed",
  "unsupported-claim",
] as const;
export type ExternalInputCitationDiagnosticCode =
  (typeof EXTERNAL_INPUT_CITATION_DIAGNOSTICS)[number];

export const EXTERNAL_INPUT_RECONCILIATION_STATES = [
  "accessed-and-used",
  "accessed-but-unused",
  "supplied-but-unused",
  "inaccessible",
  "excluded",
  "revoked",
  "changed",
] as const;
export type ExternalInputReconciliationState =
  (typeof EXTERNAL_INPUT_RECONCILIATION_STATES)[number];

export interface ExternalInputCitationInputV1 {
  inputId: string;
  stepId: string;
  role: ExternalInputCitationRole;
  /** Digest of the structured finding or decision this citation supports. */
  supportedClaimSha256: string;
  /** Optional access observation that witnessed the source for this claim. */
  accessObservationSha256: string | null;
  /** When true, record a reviewable unsupported-claim diagnostic instead of citing. */
  unsupported?: boolean;
}

export interface ExternalInputCitationV1 {
  schemaVersion: 1;
  kind: "docsfab-external-input-citation";
  inputId: string;
  stepId: string;
  role: ExternalInputCitationRole;
  supportedClaimSha256: string;
  accessObservationSha256: string | null;
  entrySha256: string;
  sourceKind: string;
  versionDigestSha256: string;
  disclosurePolicy: ExternalInputDisclosurePolicy;
  citationSha256: string;
}

export interface ExternalInputCitationDiagnosticV1 {
  schemaVersion: 1;
  kind: "docsfab-external-input-citation-diagnostic";
  code: ExternalInputCitationDiagnosticCode;
  inputId: string | null;
  stepId: string;
  supportedClaimSha256: string | null;
  reasonCode: string;
  diagnosticSha256: string;
}

export interface ExternalInputCitationLedgerV1 {
  schemaVersion: 1;
  kind: "docsfab-external-input-citation-ledger";
  runIdSha256: string;
  repository: ExternalInputRepositoryBindingV1;
  citations: ExternalInputCitationV1[];
  diagnostics: ExternalInputCitationDiagnosticV1[];
  reconciliation: Array<{
    inputId: string;
    state: ExternalInputReconciliationState;
    lifecycleState: ExternalInputLifecycleState;
    citationCount: number;
    accessCount: number;
  }>;
  ledgerSha256: string;
}

interface CitationCapabilityState {
  runIdSha256: string;
  repository: ExternalInputRepositoryBindingV1;
  citations: ExternalInputCitationV1[];
  diagnostics: ExternalInputCitationDiagnosticV1[];
}

const citationCapabilities = new WeakMap<object, CitationCapabilityState>();

const CITABLE_LIFECYCLES: ExternalInputLifecycleState[] = ["accessed", "cited"];
const DISCLOSURE_ALLOWS_CITATION: ExternalInputDisclosurePolicy[] = [
  "cite-and-quote",
  "cite-only",
  "identity-only",
];

/**
 * Attach citation tracking to an access-capture capability. Citations never
 * invent input identity and cannot grant tools, writes, or publication.
 */
export function openExternalInputCitationCapture(capability: ExternalInputHostCapability): void {
  if (citationCapabilities.has(capability as object)) return;
  const binding = getExternalInputAccessBinding(capability);
  citationCapabilities.set(capability as object, {
    runIdSha256: binding.runIdSha256,
    repository: binding.repository,
    citations: [],
    diagnostics: [],
  });
}

/**
 * Cite a host-registered input for a structured claim. Rejects unknown,
 * inaccessible, revoked, stale, or disclosure-incompatible inputs with
 * reviewable diagnostics rather than fabricated certainty.
 */
export function citeExternalInput(
  capability: ExternalInputHostCapability,
  input: ExternalInputCitationInputV1,
): ExternalInputCitationV1 | ExternalInputCitationDiagnosticV1 {
  ensureCitation(capability);
  const state = citationCapabilities.get(capability as object)!;
  assertInert(input);
  requireCitationShape(object(input), [
    "inputId",
    "stepId",
    "role",
    "supportedClaimSha256",
    "accessObservationSha256",
    "unsupported",
  ]);
  rejectCredentials(input);
  const stepId = identifier(input.stepId);
  const supportedClaimSha256 = hash(input.supportedClaimSha256);
  if (input.unsupported === true) {
    return pushDiagnostic(state, {
      code: "unsupported-claim",
      inputId: typeof input.inputId === "string" ? input.inputId : null,
      stepId,
      supportedClaimSha256,
      reasonCode: "claim-marked-unsupported",
    });
  }
  let registration;
  try {
    registration = getRegisteredExternalInput(capability, input.inputId);
  } catch {
    return pushDiagnostic(state, {
      code: "unknown-input",
      inputId: typeof input.inputId === "string" ? String(input.inputId).slice(0, 256) : null,
      stepId,
      supportedClaimSha256,
      reasonCode: "input-not-registered",
    });
  }
  const role = enumeration(input.role, EXTERNAL_INPUT_CITATION_ROLES);
  if (!registration.intendedRoles.includes(role as ExternalInputIntendedRole)) {
    return pushDiagnostic(state, {
      code: "role-not-allowed",
      inputId: registration.inputId,
      stepId,
      supportedClaimSha256,
      reasonCode: "role-outside-intended-roles",
    });
  }
  const lifecycle = getExternalInputLifecycleState(capability, registration.inputId);
  if (lifecycle === "revoked" || lifecycle === "excluded" || lifecycle === "inaccessible") {
    return pushDiagnostic(state, {
      code: "lifecycle-incompatible",
      inputId: registration.inputId,
      stepId,
      supportedClaimSha256,
      reasonCode: `lifecycle-${lifecycle}`,
    });
  }
  if (lifecycle === "changed") {
    return pushDiagnostic(state, {
      code: "stale-or-changed",
      inputId: registration.inputId,
      stepId,
      supportedClaimSha256,
      reasonCode: "source-changed-after-registration",
    });
  }
  if (!DISCLOSURE_ALLOWS_CITATION.includes(registration.disclosurePolicy)) {
    return pushDiagnostic(state, {
      code: "disclosure-incompatible",
      inputId: registration.inputId,
      stepId,
      supportedClaimSha256,
      reasonCode: `disclosure-${registration.disclosurePolicy}`,
    });
  }
  if (!CITABLE_LIFECYCLES.includes(lifecycle)) {
    return pushDiagnostic(state, {
      code: "access-required",
      inputId: registration.inputId,
      stepId,
      supportedClaimSha256,
      reasonCode: `lifecycle-${lifecycle}`,
    });
  }
  const accessObservationSha256 = nullableHash(input.accessObservationSha256);
  if (accessObservationSha256 !== null) {
    const observations = listExternalInputAccessObservations(capability, registration.inputId);
    const matched = observations.find(
      (entry) => entry.observationSha256 === accessObservationSha256,
    );
    if (!matched || (matched.outcome !== "opened" && matched.outcome !== "metadata-only")) {
      return pushDiagnostic(state, {
        code: "access-required",
        inputId: registration.inputId,
        stepId,
        supportedClaimSha256,
        reasonCode: "access-observation-missing-or-unusable",
      });
    }
  } else {
    const opened = listExternalInputAccessObservations(capability, registration.inputId).some(
      (entry) => entry.outcome === "opened" || entry.outcome === "metadata-only",
    );
    if (!opened) {
      return pushDiagnostic(state, {
        code: "access-required",
        inputId: registration.inputId,
        stepId,
        supportedClaimSha256,
        reasonCode: "no-access-observation",
      });
    }
  }

  // entrySha256 is recomputed from registration fields without relying on a
  // sealed registry entry digest that may predate lifecycle transitions.
  const entrySha256 = canonicalDigest({
    inputId: registration.inputId,
    sourceKind: registration.sourceKind,
    safeTitle: registration.safeTitle,
    locator: registration.locator,
    supplier: registration.supplier,
    version: registration.version,
    contentDigestSha256: registration.contentDigestSha256,
    visibility: registration.visibility,
    disclosurePolicy: registration.disclosurePolicy,
    intendedRoles: registration.intendedRoles,
  });
  const citation = sealCitation({
    inputId: registration.inputId,
    stepId,
    role,
    supportedClaimSha256,
    accessObservationSha256,
    entrySha256,
    sourceKind: registration.sourceKind,
    versionDigestSha256: canonicalDigest(registration.version),
    disclosurePolicy: registration.disclosurePolicy,
  });
  state.citations.push(citation);
  if (lifecycle === "accessed") {
    advanceExternalInputLifecycle(capability, {
      inputId: registration.inputId,
      to: "cited",
      reasonCode: "input-cited",
      evidenceSha256s: [citation.citationSha256],
    });
  }
  return citation;
}

export function createExternalInputCitationLedger(
  capability: ExternalInputHostCapability,
): ExternalInputCitationLedgerV1 {
  ensureCitation(capability);
  const state = citationCapabilities.get(capability as object)!;
  const citations = [...state.citations].sort(citationCompare);
  const diagnostics = [...state.diagnostics].sort(diagnosticCompare);
  unique(citations.map((entry) => entry.citationSha256));
  unique(diagnostics.map((entry) => entry.diagnosticSha256));
  const reconciliation = listRegisteredExternalInputs(capability)
    .map((registration) => {
      const lifecycleState = getExternalInputLifecycleState(capability, registration.inputId);
      const accessCount = listExternalInputAccessObservations(
        capability,
        registration.inputId,
      ).filter((entry) => entry.outcome === "opened" || entry.outcome === "metadata-only").length;
      const citationCount = citations.filter(
        (entry) => entry.inputId === registration.inputId,
      ).length;
      return {
        inputId: registration.inputId,
        state: reconcile(lifecycleState, accessCount, citationCount),
        lifecycleState,
        citationCount,
        accessCount,
      };
    })
    .sort((left, right) => compare(left.inputId, right.inputId));
  return sealLedger({
    runIdSha256: state.runIdSha256,
    repository: state.repository,
    citations,
    diagnostics,
    reconciliation,
  });
}

export function decodeExternalInputCitationLedger(value: unknown): ExternalInputCitationLedgerV1 {
  assertInert(value);
  rejectCredentials(value);
  const root = object(value);
  exact(root, [
    "schemaVersion",
    "kind",
    "runIdSha256",
    "repository",
    "citations",
    "diagnostics",
    "reconciliation",
    "ledgerSha256",
  ]);
  if (root.schemaVersion !== 1 || root.kind !== "docsfab-external-input-citation-ledger") {
    fail("migration-required");
  }
  const citations = array(root.citations).map(decodeCitation).sort(citationCompare);
  const diagnostics = array(root.diagnostics).map(decodeDiagnostic).sort(diagnosticCompare);
  unique(citations.map((entry) => entry.citationSha256));
  unique(diagnostics.map((entry) => entry.diagnosticSha256));
  const reconciliation = array(root.reconciliation)
    .map(decodeReconciliation)
    .sort((left, right) => compare(left.inputId, right.inputId));
  unique(reconciliation.map((entry) => entry.inputId));
  const ledger = sealLedger({
    runIdSha256: hash(root.runIdSha256),
    repository: repositoryBinding(root.repository),
    citations,
    diagnostics,
    reconciliation,
  });
  if (root.ledgerSha256 !== ledger.ledgerSha256) fail("digest-mismatch");
  return ledger;
}

export function serializeExternalInputCitationLedger(value: unknown): string {
  return canonicalizeJsonEvidence(
    decodeExternalInputCitationLedger(value) as unknown as JsonEvidenceValue,
  );
}

export function decodePersistedExternalInputCitationLedger(
  value: string | Uint8Array,
): ExternalInputCitationLedgerV1 {
  try {
    return decodeExternalInputCitationLedger(parseJsonEvidence(value, { requireCanonical: true }));
  } catch (error) {
    if (error instanceof ExternalInputContractError) throw error;
    fail("invalid-shape");
  }
}

/**
 * Workflow gate: require at least one successful citation for each claim digest.
 * Returns diagnostics for missing citations; never fabricates them.
 */
export function requireCitationsForClaims(
  capability: ExternalInputHostCapability,
  claimSha256s: string[],
): ExternalInputCitationDiagnosticV1[] {
  ensureCitation(capability);
  const state = citationCapabilities.get(capability as object)!;
  const required = normalizedHashes(claimSha256s, true);
  const cited = new Set(state.citations.map((entry) => entry.supportedClaimSha256));
  const missing: ExternalInputCitationDiagnosticV1[] = [];
  for (const claim of required) {
    if (cited.has(claim)) continue;
    missing.push(
      pushDiagnostic(state, {
        code: "unsupported-claim",
        inputId: null,
        stepId: "workflow:citation-gate",
        supportedClaimSha256: claim,
        reasonCode: "required-citation-missing",
      }),
    );
  }
  return missing;
}

function reconcile(
  lifecycle: ExternalInputLifecycleState,
  accessCount: number,
  citationCount: number,
): ExternalInputReconciliationState {
  if (lifecycle === "inaccessible") return "inaccessible";
  if (lifecycle === "excluded") return "excluded";
  if (lifecycle === "revoked") return "revoked";
  if (lifecycle === "changed") return "changed";
  if (citationCount > 0) return "accessed-and-used";
  if (accessCount > 0 || lifecycle === "accessed" || lifecycle === "cited") {
    return "accessed-but-unused";
  }
  return "supplied-but-unused";
}

function ensureCitation(capability: ExternalInputHostCapability): void {
  if (!citationCapabilities.has(capability as object)) {
    openExternalInputCitationCapture(capability);
  }
}

function pushDiagnostic(
  state: CitationCapabilityState,
  input: {
    code: ExternalInputCitationDiagnosticCode;
    inputId: string | null;
    stepId: string;
    supportedClaimSha256: string | null;
    reasonCode: string;
  },
): ExternalInputCitationDiagnosticV1 {
  const diagnostic = sealDiagnostic({
    code: input.code,
    inputId: sanitizeDiagnosticInputId(input.inputId),
    stepId: identifier(input.stepId),
    supportedClaimSha256: input.supportedClaimSha256,
    reasonCode: identifier(input.reasonCode),
  });
  state.diagnostics.push(diagnostic);
  return diagnostic;
}

function sanitizeDiagnosticInputId(value: string | null): string | null {
  if (value === null) return null;
  try {
    return identifier(value);
  } catch {
    return null;
  }
}

function decodeCitation(value: unknown): ExternalInputCitationV1 {
  const root = object(value);
  exact(root, [
    "schemaVersion",
    "kind",
    "inputId",
    "stepId",
    "role",
    "supportedClaimSha256",
    "accessObservationSha256",
    "entrySha256",
    "sourceKind",
    "versionDigestSha256",
    "disclosurePolicy",
    "citationSha256",
  ]);
  if (root.schemaVersion !== 1 || root.kind !== "docsfab-external-input-citation") {
    fail("migration-required");
  }
  const sealed = sealCitation({
    inputId: identifier(root.inputId),
    stepId: identifier(root.stepId),
    role: enumeration(root.role, EXTERNAL_INPUT_CITATION_ROLES),
    supportedClaimSha256: hash(root.supportedClaimSha256),
    accessObservationSha256: nullableHash(root.accessObservationSha256),
    entrySha256: hash(root.entrySha256),
    sourceKind: identifier(root.sourceKind),
    versionDigestSha256: hash(root.versionDigestSha256),
    disclosurePolicy: enumeration(root.disclosurePolicy, [
      "cite-and-quote",
      "cite-only",
      "identity-only",
      "redacted",
      "forbidden",
    ] as const),
  });
  if (root.citationSha256 !== sealed.citationSha256) fail("digest-mismatch");
  return sealed;
}

function decodeDiagnostic(value: unknown): ExternalInputCitationDiagnosticV1 {
  const root = object(value);
  exact(root, [
    "schemaVersion",
    "kind",
    "code",
    "inputId",
    "stepId",
    "supportedClaimSha256",
    "reasonCode",
    "diagnosticSha256",
  ]);
  if (root.schemaVersion !== 1 || root.kind !== "docsfab-external-input-citation-diagnostic") {
    fail("migration-required");
  }
  const sealed = sealDiagnostic({
    code: enumeration(root.code, EXTERNAL_INPUT_CITATION_DIAGNOSTICS),
    inputId: root.inputId === null ? null : identifier(root.inputId),
    stepId: identifier(root.stepId),
    supportedClaimSha256:
      root.supportedClaimSha256 === null ? null : hash(root.supportedClaimSha256),
    reasonCode: identifier(root.reasonCode),
  });
  if (root.diagnosticSha256 !== sealed.diagnosticSha256) fail("digest-mismatch");
  return sealed;
}

function decodeReconciliation(
  value: unknown,
): ExternalInputCitationLedgerV1["reconciliation"][number] {
  const root = object(value);
  exact(root, ["inputId", "state", "lifecycleState", "citationCount", "accessCount"]);
  return {
    inputId: identifier(root.inputId),
    state: enumeration(root.state, EXTERNAL_INPUT_RECONCILIATION_STATES),
    lifecycleState: enumeration(root.lifecycleState, [
      "supplied",
      "discovered",
      "accessed",
      "cited",
      "unused",
      "inaccessible",
      "changed",
      "revoked",
      "excluded",
    ] as const),
    citationCount: nonnegativeInteger(root.citationCount),
    accessCount: nonnegativeInteger(root.accessCount),
  };
}

function sealCitation(
  body: Omit<ExternalInputCitationV1, "schemaVersion" | "kind" | "citationSha256">,
): ExternalInputCitationV1 {
  const envelope = {
    schemaVersion: 1 as const,
    kind: "docsfab-external-input-citation" as const,
    ...body,
  };
  return deepFreeze({ ...envelope, citationSha256: canonicalDigest(envelope) });
}

function sealDiagnostic(
  body: Omit<ExternalInputCitationDiagnosticV1, "schemaVersion" | "kind" | "diagnosticSha256">,
): ExternalInputCitationDiagnosticV1 {
  const envelope = {
    schemaVersion: 1 as const,
    kind: "docsfab-external-input-citation-diagnostic" as const,
    ...body,
  };
  return deepFreeze({ ...envelope, diagnosticSha256: canonicalDigest(envelope) });
}

function sealLedger(
  body: Omit<ExternalInputCitationLedgerV1, "schemaVersion" | "kind" | "ledgerSha256">,
): ExternalInputCitationLedgerV1 {
  const envelope = {
    schemaVersion: 1 as const,
    kind: "docsfab-external-input-citation-ledger" as const,
    ...body,
  };
  return deepFreeze({ ...envelope, ledgerSha256: canonicalDigest(envelope) });
}

function requireCitationShape(root: Record<string, unknown>, keys: string[]): void {
  noUnknown(root, keys);
  for (const key of [
    "inputId",
    "stepId",
    "role",
    "supportedClaimSha256",
    "accessObservationSha256",
  ]) {
    if (!(key in root)) fail("invalid-shape");
  }
}

function nonnegativeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 1_000_000) {
    fail("invalid-value");
  }
  return value;
}

function citationCompare(left: ExternalInputCitationV1, right: ExternalInputCitationV1): number {
  return compare(left.citationSha256, right.citationSha256);
}

function diagnosticCompare(
  left: ExternalInputCitationDiagnosticV1,
  right: ExternalInputCitationDiagnosticV1,
): number {
  return compare(left.diagnosticSha256, right.diagnosticSha256);
}

function repositoryBinding(value: unknown): ExternalInputRepositoryBindingV1 {
  const root = object(value);
  exact(root, ["identitySha256", "revision"]);
  return {
    identitySha256: hash(root.identitySha256),
    revision: (() => {
      const result = string(root.revision);
      if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(result)) fail("invalid-value");
      return result;
    })(),
  };
}
