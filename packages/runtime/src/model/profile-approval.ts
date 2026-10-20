// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash, createPublicKey, type KeyObject } from "node:crypto";

import { deepFreeze } from "../contract-kit/freeze.js";
import { createContractKit } from "../contract-kit/primitives.js";
import type { ModelEndpointConfig, ModelProfile } from "./configuration.js";
import type { ModelEvidence } from "../records/contracts.js";
import {
  canonicalizeJsonEvidence,
  parseJsonEvidence,
  type JsonEvidenceValue,
} from "../json-evidence.js";
import { detectCredentialRuleIdsInValue } from "../security/repository-scanner.js";
import {
  finalizeOperatorApprovedModelProfile,
  projectApprovedModelProfile,
  type ModelCatalogField,
  type ModelCatalogObservationV1,
  type ModelCatalogProposalFieldV1,
  type ModelProfilePurpose,
  type OperatorApprovedModelProfileV1,
} from "./catalog-contracts.js";
import {
  MODEL_CATALOG_RECONCILIATION_POLICY,
  MODEL_CATALOG_RECONCILIATION_POLICY_DIRECT_PROVIDER,
  createApprovedCatalogModelEvidence,
  decodeModelCatalogApprovalAuthorization,
  finalizeModelCatalogApprovalEvidence,
  signModelCatalogApprovalAuthorization,
  type ModelCatalogApprovalAuthorizationV1,
  type ModelCatalogApprovalEvidenceV1,
  type TrustedModelCatalogApprovalAuthority,
} from "./catalog-provenance.js";
import {
  decodeModelCatalogReconciliationDecision,
  type ReconcileModelCatalogInput,
} from "./catalog-reconciliation.js";
import {
  decodeModelProfileInspection,
  type ModelProfileInspectionV1,
} from "./profile-inspection.js";
import { createModelEvidence } from "./profile-evidence.js";

export const PROFILE_APPROVAL_SCHEMA_VERSION = 1 as const;
export const PROFILE_APPROVAL_MAX_EVIDENCE_AGE_MS = 24 * 60 * 60 * 1_000;

export interface ModelProfileApprovalBundleV1 {
  schemaVersion: 1;
  kind: "docsfab-model-profile-approval-bundle";
  purpose: ModelProfilePurpose;
  createdAt: string;
  inspectionSha256: string;
  decisionSha256: string;
  proposalSha256: string;
  proposalProvenanceSha256: string;
  approval: OperatorApprovedModelProfileV1;
  approvalEvidence: ModelCatalogApprovalEvidenceV1;
  authorization: ModelCatalogApprovalAuthorizationV1;
  authority: { id: string; publicKeySha256: string };
  modelEvidence: ModelEvidence;
  sha256: string;
}

export interface ApproveModelProfileInput {
  inspection: string | Uint8Array | unknown;
  purpose: ModelProfilePurpose;
  proposalSha256: string;
  effectiveDate: string;
  reviewAfter: string;
  conflictFields: readonly ModelCatalogField[];
  authority: TrustedModelCatalogApprovalAuthority;
  privateKey: KeyObject | string;
  endpoint: ModelEndpointConfig;
  now?: Date;
}

export class ModelProfileApprovalError extends Error {
  public readonly code = "invalid-model-profile-approval" as const;

  public constructor() {
    super("Model profile approval was rejected.");
    this.name = "ModelProfileApprovalError";
  }
}

const approvalKit = createContractKit({
  fail: invalid,
  codes: {
    invalidShape: "invalid-model-profile-approval",
    invalidValue: "invalid-model-profile-approval",
    digestMismatch: "invalid-model-profile-approval",
    credentialMaterial: "invalid-model-profile-approval",
    schemaMismatch: "invalid-model-profile-approval",
  },
});

/** Build one signed approval from an inspection proposal. */
export function approveModelProfile(input: ApproveModelProfileInput): ModelProfileApprovalBundleV1 {
  try {
    const inspection = decodeModelProfileInspection(input.inspection);
    const now = input.now ?? new Date();
    const createdAt = timestamp(now);
    if (
      inspection.purpose !== input.purpose ||
      inspection.subject.provider !== input.endpoint.providerId ||
      inspection.subject.model !== input.endpoint.modelId ||
      inspection.subject.apiFormat !== input.endpoint.apiFormat ||
      canonicalizeJsonEvidence(input.endpoint.requestPolicy as unknown as JsonEvidenceValue) !==
        canonicalizeJsonEvidence(
          inspection.runtime.profileEvidence.requestPolicy as unknown as JsonEvidenceValue,
        )
    )
      invalid();
    const reconciliation = inspection.catalog.reconciliation;
    if (
      !inspection.catalog.requested ||
      !reconciliation ||
      reconciliation.status !== "proposed" ||
      !reconciliation.proposal ||
      !reconciliation.proposalProvenance ||
      reconciliation.decision.disposition === "blocked"
    )
      invalid();
    if (
      input.proposalSha256 !== reconciliation.proposal.sha256 ||
      reconciliation.decision.proposal?.sha256 !== reconciliation.proposal.sha256 ||
      reconciliation.decision.proposalProvenanceSha256 !==
        reconciliation.proposalProvenance.sha256 ||
      !acceptedReconciliationPolicy(reconciliation.decision.reconciliationPolicy)
    )
      invalid();
    const approvedOrigin = proposalString(reconciliation.proposal.fields, "origin");
    if (!endpointMatchesApprovedOrigin(input.endpoint, approvedOrigin)) invalid();

    const evidenceTime = Date.parse(inspection.generatedAt);
    const nowTime = now.valueOf();
    if (
      !Number.isFinite(nowTime) ||
      nowTime < evidenceTime ||
      nowTime - evidenceTime > PROFILE_APPROVAL_MAX_EVIDENCE_AGE_MS
    )
      invalid();
    const observations = observedEvidence(inspection).map((item) => item.observation);
    const observationProvenance = observedEvidence(inspection).map((item) => item.provenance);
    const reconciliationInput: ReconcileModelCatalogInput = {
      purpose: input.purpose,
      ...reconciliation.input,
      observations,
      observationProvenance,
    };
    decodeModelCatalogReconciliationDecision(reconciliation.decision, reconciliationInput);

    const conflicts = reconciliation.proposal.fields
      .filter((field) => field.state === "conflicting")
      .map((field) => field.field)
      .sort();
    const acknowledgements = [...input.conflictFields].sort();
    if (
      new Set(acknowledgements).size !== acknowledgements.length ||
      conflicts.join("\n") !== acknowledgements.join("\n")
    )
      invalid();
    const fields = reconciliation.proposal.fields.map(resolveConflict);
    const approval = finalizeOperatorApprovedModelProfile(
      {
        id: `approval:${input.purpose}:${reconciliation.proposal.sha256.slice(0, 32)}`,
        purpose: input.purpose,
        proposalSha256: reconciliation.proposal.sha256,
        approvedBy: input.authority.id,
        approvedAt: createdAt,
        effectiveDate: input.effectiveDate,
        reviewAfter: input.reviewAfter,
        fields,
      },
      reconciliation.proposal,
      reconciliation.observationSet,
      observations,
    );
    const approvalEvidence = finalizeModelCatalogApprovalEvidence({
      approval,
      proposalProvenance: reconciliation.proposalProvenance,
      proposal: reconciliation.proposal,
      observationSet: reconciliation.observationSet,
      observations,
      observationProvenance,
    });
    const signedAuthorization = signModelCatalogApprovalAuthorization({
      approvalEvidence,
      approval,
      proposalProvenance: reconciliation.proposalProvenance,
      proposal: reconciliation.proposal,
      observationSet: reconciliation.observationSet,
      observations,
      observationProvenance,
      authorityId: input.authority.id,
      authorizedAt: createdAt,
      privateKey: input.privateKey,
    });
    const authorization = decodeModelCatalogApprovalAuthorization(
      signedAuthorization,
      approvalEvidence,
      input.authority,
    );
    const profile = projectApprovedModelProfile(
      approval,
      reconciliation.proposal,
      reconciliation.observationSet,
      observations,
      now,
    );
    if (
      input.endpoint.requestPolicy.minimumOutputTokens > profile.maxOutputTokens ||
      input.endpoint.requestPolicy.reservedContextTokens > profile.maxInputTokens ||
      input.endpoint.requestPolicy.reservedContextTokens +
        input.endpoint.requestPolicy.minimumOutputTokens >
        profile.contextWindow
    )
      invalid();
    const approvedEndpoint: ModelEndpointConfig = { ...input.endpoint, profile };
    const modelEvidence = createApprovedCatalogModelEvidence({
      config: approvedEndpoint,
      purpose: input.purpose,
      asOf: now,
      approvalEvidence,
      approval,
      proposalProvenance: reconciliation.proposalProvenance,
      proposal: reconciliation.proposal,
      observationSet: reconciliation.observationSet,
      observations,
      observationProvenance,
      authorization,
      authority: input.authority,
    });
    if (
      !modelEvidence.profile ||
      modelEvidence.profile.schemaVersion !== 2 ||
      modelEvidence.profile.configuredMaxInputTokens === undefined ||
      modelEvidence.profile.effectiveMaxInputTokens === undefined
    )
      invalid();
    const withoutDigest = {
      schemaVersion: PROFILE_APPROVAL_SCHEMA_VERSION,
      kind: "docsfab-model-profile-approval-bundle" as const,
      purpose: input.purpose,
      createdAt,
      inspectionSha256: inspection.sha256,
      decisionSha256: reconciliation.decision.sha256,
      proposalSha256: reconciliation.proposal.sha256,
      proposalProvenanceSha256: reconciliation.proposalProvenance.sha256,
      approval,
      approvalEvidence,
      authorization,
      authority: {
        id: input.authority.id,
        publicKeySha256: publicKeyDigest(input.authority.publicKey),
      },
      modelEvidence,
    };
    const bundle = { ...withoutDigest, sha256: digest(withoutDigest) };
    assertCredentialFree(bundle);
    return deepFreeze(bundle);
  } catch (error) {
    if (error instanceof ModelProfileApprovalError) throw error;
    throw new ModelProfileApprovalError();
  }
}

export function serializeModelProfileApprovalBundle(
  bundle: ModelProfileApprovalBundleV1,
  inspectionValue: string | Uint8Array | unknown,
  authority: TrustedModelCatalogApprovalAuthority,
  asOf: Date,
): string {
  const validated = validateBundle(bundle, inspectionValue, authority, asOf);
  return canonicalizeJsonEvidence(validated as unknown as JsonEvidenceValue);
}

export function decodeModelProfileApprovalBundle(
  value: string | Uint8Array | unknown,
  inspectionValue: string | Uint8Array | unknown,
  authority: TrustedModelCatalogApprovalAuthority,
  asOf: Date,
): ModelProfileApprovalBundleV1 {
  try {
    const parsed =
      typeof value === "string" || value instanceof Uint8Array ? parseJsonEvidence(value) : value;
    return validateBundle(parsed, inspectionValue, authority, asOf);
  } catch (error) {
    if (error instanceof ModelProfileApprovalError) throw error;
    throw new ModelProfileApprovalError();
  }
}

/** Strictly authenticate a saved bundle at its signed creation instant for recovery/replay only. */
export function decodeModelProfileApprovalBundleAtCreation(
  value: string | Uint8Array | unknown,
  inspectionValue: string | Uint8Array | unknown,
  authority: TrustedModelCatalogApprovalAuthority,
): ModelProfileApprovalBundleV1 {
  try {
    const parsed =
      typeof value === "string" || value instanceof Uint8Array ? parseJsonEvidence(value) : value;
    assertPlainDataTree(parsed);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) invalid();
    const descriptor = Object.getOwnPropertyDescriptor(parsed, "createdAt");
    if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "string") invalid();
    const createdAt = new Date(descriptor.value);
    if (!Number.isFinite(createdAt.valueOf()) || createdAt.toISOString() !== descriptor.value)
      invalid();
    return validateBundle(parsed, inspectionValue, authority, createdAt);
  } catch (error) {
    if (error instanceof ModelProfileApprovalError) throw error;
    throw new ModelProfileApprovalError();
  }
}

/** Revalidate at a trusted current time and return the exact runtime projection. */
export function projectModelProfileApprovalBundle(
  value: string | Uint8Array | unknown,
  inspectionValue: string | Uint8Array | unknown,
  authority: TrustedModelCatalogApprovalAuthority,
  asOf: Date,
): ModelProfile {
  const bundle = decodeModelProfileApprovalBundle(value, inspectionValue, authority, asOf);
  const inspection = decodeModelProfileInspection(inspectionValue);
  const reconciliation = inspection.catalog.reconciliation;
  if (!reconciliation || reconciliation.status !== "proposed" || !reconciliation.proposal)
    invalid();
  const observations = observedEvidence(inspection).map((item) => item.observation);
  const profile = projectApprovedModelProfile(
    bundle.approval,
    reconciliation.proposal,
    reconciliation.observationSet,
    observations,
    asOf,
  );
  if (profile.metadata.status !== "current" || profile.effectiveLimitReason !== "none") invalid();
  return profile;
}

function validateBundle(
  value: unknown,
  inspectionValue: string | Uint8Array | unknown,
  authority: TrustedModelCatalogApprovalAuthority,
  asOf: Date,
): ModelProfileApprovalBundleV1 {
  try {
    assertPlainDataTree(value);
    if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
    // All subsequent checks and exports use this one inert, independent snapshot.
    const bundle = structuredClone(value) as ModelProfileApprovalBundleV1;
    const keys = [
      "schemaVersion",
      "kind",
      "purpose",
      "createdAt",
      "inspectionSha256",
      "decisionSha256",
      "proposalSha256",
      "proposalProvenanceSha256",
      "approval",
      "approvalEvidence",
      "authorization",
      "authority",
      "modelEvidence",
      "sha256",
    ];
    if (
      Object.keys(bundle).sort().join("\n") !== keys.sort().join("\n") ||
      bundle.schemaVersion !== 1 ||
      bundle.kind !== "docsfab-model-profile-approval-bundle" ||
      (bundle.purpose !== "policy" && bundle.purpose !== "judge") ||
      bundle.authority.id !== authority.id ||
      bundle.authority.publicKeySha256 !== publicKeyDigest(authority.publicKey) ||
      Object.keys(bundle.authority).sort().join("\n") !== "id\npublicKeySha256"
    )
      invalid();
    const asOfTime = asOf.valueOf();
    // Refuses an invalid clock or one before the bundle was created. A passed
    // `approval.reviewAfter` is advisory and does not invalidate the bundle.
    if (!Number.isFinite(asOfTime) || asOfTime < Date.parse(bundle.createdAt)) invalid();
    const inspection = decodeModelProfileInspection(inspectionValue);
    const reconciliation = inspection.catalog.reconciliation;
    if (
      !reconciliation ||
      reconciliation.status !== "proposed" ||
      !reconciliation.proposal ||
      !reconciliation.proposalProvenance ||
      inspection.sha256 !== bundle.inspectionSha256 ||
      reconciliation.decision.sha256 !== bundle.decisionSha256 ||
      reconciliation.proposal.sha256 !== bundle.proposalSha256 ||
      reconciliation.proposalProvenance.sha256 !== bundle.proposalProvenanceSha256
    )
      invalid();
    const observations = observedEvidence(inspection).map((item) => item.observation);
    const observationProvenance = observedEvidence(inspection).map((item) => item.provenance);
    const expectedEvidence = finalizeModelCatalogApprovalEvidence({
      approval: bundle.approval,
      proposalProvenance: reconciliation.proposalProvenance,
      proposal: reconciliation.proposal,
      observationSet: reconciliation.observationSet,
      observations,
      observationProvenance,
    });
    if (
      canonicalizeJsonEvidence(expectedEvidence as unknown as JsonEvidenceValue) !==
      canonicalizeJsonEvidence(bundle.approvalEvidence as unknown as JsonEvidenceValue)
    )
      invalid();
    bundle.authorization = decodeModelCatalogApprovalAuthorization(
      bundle.authorization,
      bundle.approvalEvidence,
      authority,
    );
    if (
      bundle.createdAt !== bundle.approval.approvedAt ||
      bundle.authorization.authorizedAt !== bundle.createdAt ||
      bundle.purpose !== bundle.approval.purpose ||
      bundle.purpose !== inspection.purpose
    )
      invalid();
    const profile = projectApprovedModelProfile(
      bundle.approval,
      reconciliation.proposal,
      reconciliation.observationSet,
      observations,
      new Date(bundle.createdAt),
    );
    const expectedModelEvidence = createModelEvidence({
      providerId: inspection.subject.provider,
      modelId: inspection.subject.model,
      baseUrl: "https://evidence.invalid/v1",
      apiFormat: inspection.subject.apiFormat,
      api: "openai-completions",
      apiKey: "not-retained",
      profile,
      requestPolicy: { ...inspection.runtime.profileEvidence.requestPolicy },
    });
    if (
      canonicalizeJsonEvidence(expectedModelEvidence as unknown as JsonEvidenceValue) !==
        canonicalizeJsonEvidence(bundle.modelEvidence as unknown as JsonEvidenceValue) ||
      bundle.modelEvidence.profile?.schemaVersion !== 2
    )
      invalid();
    const { sha256, ...withoutDigest } = bundle;
    if (digest(withoutDigest) !== sha256) invalid();
    assertCredentialFree(bundle);
    return deepFreeze(bundle);
  } catch (error) {
    if (error instanceof ModelProfileApprovalError) throw error;
    throw new ModelProfileApprovalError();
  }
}

function observedEvidence(inspection: ModelProfileInspectionV1) {
  return inspection.catalog.sources.flatMap((source) => (source.evidence ? [source.evidence] : []));
}

function resolveConflict(field: ModelCatalogProposalFieldV1): ModelCatalogProposalFieldV1 {
  return field.state === "conflicting" && field.value !== undefined
    ? { ...structuredClone(field), state: "observed" }
    : structuredClone(field);
}

function proposalString(
  fields: readonly ModelCatalogProposalFieldV1[],
  name: ModelCatalogField,
): string {
  const field = fields.find((candidate) => candidate.field === name);
  if (!field || typeof field.value !== "string") return invalid();
  return field.value;
}

function endpointMatchesApprovedOrigin(endpoint: ModelEndpointConfig, origin: string): boolean {
  try {
    const base = new URL(endpoint.baseUrl);
    const approved = new URL(origin);
    const path = base.pathname.endsWith("/") ? base.pathname.slice(0, -1) : base.pathname;
    return (
      approved.href === approved.origin + "/" &&
      base.origin === approved.origin &&
      path === "/v1" &&
      base.search === "" &&
      base.hash === "" &&
      base.username === "" &&
      base.password === ""
    );
  } catch {
    return false;
  }
}

function acceptedReconciliationPolicy(policy: { id: string; version: string }): boolean {
  return (
    (policy.id === MODEL_CATALOG_RECONCILIATION_POLICY.id &&
      policy.version === MODEL_CATALOG_RECONCILIATION_POLICY.version) ||
    (policy.id === MODEL_CATALOG_RECONCILIATION_POLICY_DIRECT_PROVIDER.id &&
      policy.version === MODEL_CATALOG_RECONCILIATION_POLICY_DIRECT_PROVIDER.version)
  );
}

function timestamp(value: Date): string {
  const time = value.valueOf();
  if (!Number.isFinite(time)) invalid();
  return value.toISOString();
}

function publicKeyDigest(value: string): string {
  const key = createPublicKey(value);
  if (key.asymmetricKeyType !== "ed25519") invalid();
  return createHash("sha256")
    .update(key.export({ type: "spki", format: "der" }))
    .digest("hex");
}

function digest(value: unknown): string {
  return createHash("sha256")
    .update(canonicalizeJsonEvidence(value as JsonEvidenceValue))
    .digest("hex");
}

function assertCredentialFree(bundle: ModelProfileApprovalBundleV1): void {
  approvalKit.rejectCredentials(bundle);
  // Both callers reach this screen only with a trusted-decoder authorization.
  const { signature: _publicProof, ...authorization } = bundle.authorization;
  if (detectCredentialRuleIdsInValue({ ...bundle, authorization }).length > 0) invalid();
}

function assertPlainDataTree(value: unknown, depth = 0, seen = { count: 0 }): void {
  if (depth === 0) approvalKit.assertInert(value);
  seen.count += 1;
  if (seen.count > 20_000 || depth > 32) invalid();
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return;
  if (!value || typeof value !== "object") invalid();
  if (Array.isArray(value)) {
    if (
      Object.getPrototypeOf(value) !== Array.prototype ||
      Object.keys(value).length !== value.length
    )
      invalid();
    for (const item of value) assertPlainDataTree(item, depth + 1, seen);
    return;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(value).some((key) => typeof key !== "string") ||
    Object.values(descriptors).some(
      (descriptor) => !("value" in descriptor) || !descriptor.enumerable,
    )
  )
    invalid();
  for (const descriptor of Object.values(descriptors)) {
    if ("value" in descriptor) assertPlainDataTree(descriptor.value, depth + 1, seen);
  }
}

function invalid(): never {
  throw new ModelProfileApprovalError();
}
