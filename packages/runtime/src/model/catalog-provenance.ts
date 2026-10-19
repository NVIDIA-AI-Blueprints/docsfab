// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  createPrivateKey,
  createPublicKey,
  sign as signBytes,
  verify as verifyBytes,
  type KeyObject,
} from "node:crypto";

import { deepFreeze } from "../contract-kit/freeze.js";
import { createContractKit } from "../contract-kit/primitives.js";

import type { ModelEndpointConfig } from "./configuration.js";
import type { ModelEvidence } from "../records/contracts.js";
import {
  canonicalizeJsonEvidence,
  parseJsonEvidence,
  type JsonEvidenceValue,
} from "../json-evidence.js";
import {
  detectCredentialRuleIds,
  detectCredentialRuleIdsInValue,
} from "../security/repository-scanner.js";
import {
  decodeModelCatalogObservation,
  decodeModelProfileProposal,
  decodeOperatorApprovedModelProfile,
  projectApprovedModelProfile,
  type ModelCatalogFieldEvidenceV1,
  type ModelCatalogObservationSetV1,
  type ModelCatalogObservationV1,
  type ModelCatalogProposalFieldV1,
  type ModelProfileProposalV1,
  type OperatorApprovedModelProfileV1,
  type ModelProfilePurpose,
} from "./catalog-contracts.js";
import { createModelEvidence } from "./profile-evidence.js";
import { isDirectProviderCatalogAdapterId } from "./catalog-serving-route.js";
import { compareText } from "../shared/primitives.js";
import { sha256 } from "../content-ir/canonical.js";

export const MODEL_CATALOG_PROVENANCE_SCHEMA_VERSION = 1 as const;
export const MODEL_CATALOG_RECONCILIATION_POLICY_V1 = {
  id: "docsfab-model-catalog-reconciliation",
  version: "1",
} as const;
export const MODEL_CATALOG_RECONCILIATION_POLICY = {
  id: "docsfab-model-catalog-reconciliation",
  version: "2",
} as const;
export const MODEL_CATALOG_RECONCILIATION_POLICY_DIRECT_PROVIDER = {
  id: "docsfab-direct-provider-catalog-reconciliation",
  version: "1",
} as const;
export type ModelCatalogReconciliationPolicy =
  | typeof MODEL_CATALOG_RECONCILIATION_POLICY_V1
  | typeof MODEL_CATALOG_RECONCILIATION_POLICY
  | typeof MODEL_CATALOG_RECONCILIATION_POLICY_DIRECT_PROVIDER;

interface ArtifactBindingV1 {
  id: string;
  sha256: string;
}

export interface ModelCatalogObservationProvenanceV1 {
  schemaVersion: typeof MODEL_CATALOG_PROVENANCE_SCHEMA_VERSION;
  kind: "docsfab-model-catalog-observation-provenance";
  purpose: ModelProfilePurpose;
  observation: ArtifactBindingV1;
  source: {
    id: string;
    origin: string;
    pathSha256: string;
    providerId: string;
    modelId: string;
    retrievedAt: string;
    providerUpdatedAt: string | null;
    adapter: { id: string; version: string };
  };
  fields: ModelCatalogFieldEvidenceV1[];
  sha256: string;
}

export interface ModelCatalogProposalProvenanceV1 {
  schemaVersion: typeof MODEL_CATALOG_PROVENANCE_SCHEMA_VERSION;
  kind: "docsfab-model-catalog-proposal-provenance";
  purpose: ModelProfilePurpose;
  proposal: ArtifactBindingV1;
  observationSet: ArtifactBindingV1;
  observations: Array<{ observationId: string; provenanceSha256: string }>;
  providerId: string;
  modelId: string;
  origin: string;
  createdAt: string;
  reconciliationPolicy: ModelCatalogReconciliationPolicy;
  fields: ModelCatalogProposalFieldV1[];
  sha256: string;
}

export interface ModelCatalogApprovalEvidenceV1 {
  schemaVersion: typeof MODEL_CATALOG_PROVENANCE_SCHEMA_VERSION;
  kind: "docsfab-model-catalog-approval-evidence";
  purpose: ModelProfilePurpose;
  approval: ArtifactBindingV1;
  proposal: ArtifactBindingV1;
  proposalProvenanceSha256: string;
  providerId: string;
  modelId: string;
  origin: string;
  approvedBy: string;
  approvedAt: string;
  effectiveDate: string;
  reviewAfter: string;
  fields: ModelCatalogProposalFieldV1[];
  sha256: string;
}

export interface ModelCatalogApprovalAuthorizationV1 {
  schemaVersion: typeof MODEL_CATALOG_PROVENANCE_SCHEMA_VERSION;
  kind: "docsfab-model-catalog-approval-authorization";
  purpose: ModelProfilePurpose;
  approvalEvidenceSha256: string;
  approvalSha256: string;
  proposalSha256: string;
  providerId: string;
  modelId: string;
  origin: string;
  authorityId: string;
  authorizedAt: string;
  effectiveDate: string;
  reviewAfter: string;
  signature: string;
  sha256: string;
}

export interface TrustedModelCatalogApprovalAuthority {
  id: string;
  /** Trusted Ed25519 SPKI public key supplied by the host, never by evidence. */
  publicKey: string;
}

export type ModelCatalogProvenanceArtifactV1 =
  | ModelCatalogObservationProvenanceV1
  | ModelCatalogProposalProvenanceV1
  | ModelCatalogApprovalEvidenceV1
  | ModelCatalogApprovalAuthorizationV1;

export type ModelCatalogProvenanceValidationContext =
  | {
      kind: "observation";
      observation: ModelCatalogObservationV1;
    }
  | {
      kind: "proposal";
      proposal: ModelProfileProposalV1;
      observationSet: ModelCatalogObservationSetV1;
      observations: readonly ModelCatalogObservationV1[];
      observationProvenance: readonly ModelCatalogObservationProvenanceV1[];
    }
  | {
      kind: "approval";
      approval: OperatorApprovedModelProfileV1;
      proposalProvenance: ModelCatalogProposalProvenanceV1;
      proposal: ModelProfileProposalV1;
      observationSet: ModelCatalogObservationSetV1;
      observations: readonly ModelCatalogObservationV1[];
      observationProvenance: readonly ModelCatalogObservationProvenanceV1[];
    }
  | {
      kind: "authorization";
      approvalEvidence: ModelCatalogApprovalEvidenceV1;
      authority: TrustedModelCatalogApprovalAuthority;
    };

export class ModelCatalogProvenanceError extends Error {
  public readonly code = "invalid-model-catalog-provenance" as const;

  public constructor() {
    super("Model catalog provenance is invalid or incompatible.");
    this.name = "ModelCatalogProvenanceError";
  }
}

const provenanceKit = createContractKit({
  fail: invalid,
  codes: {
    invalidShape: "invalid-model-catalog-provenance",
    invalidValue: "invalid-model-catalog-provenance",
    digestMismatch: "invalid-model-catalog-provenance",
    credentialMaterial: "invalid-model-catalog-provenance",
    schemaMismatch: "invalid-model-catalog-provenance",
  },
});

/**
 * Project one normalized observation into durable evidence. The request path is
 * consumed only to compute its digest and is never retained.
 */
export function finalizeModelCatalogObservationProvenance(input: {
  observation: ModelCatalogObservationV1;
  sourcePath: string;
}): ModelCatalogObservationProvenanceV1 {
  try {
    const observation = decodeModelCatalogObservation(input.observation);
    validateSourcePath(input.sourcePath);
    const artifact = observationProjection(observation, sha256(input.sourcePath));
    artifact.sha256 = artifactDigest(artifact);
    return validateModelCatalogObservationProvenance(artifact, observation);
  } catch (error) {
    return provenanceFailure(error);
  }
}

export function decodeModelCatalogObservationProvenance(
  input: string | Uint8Array | unknown,
  observation: ModelCatalogObservationV1,
): ModelCatalogObservationProvenanceV1 {
  try {
    return validateModelCatalogObservationProvenance(parsed(input), observation);
  } catch (error) {
    return provenanceFailure(error);
  }
}

export function finalizeModelCatalogProposalProvenance(input: {
  proposal: ModelProfileProposalV1;
  observationSet: ModelCatalogObservationSetV1;
  observations: readonly ModelCatalogObservationV1[];
  observationProvenance: readonly ModelCatalogObservationProvenanceV1[];
}): ModelCatalogProposalProvenanceV1 {
  try {
    preflightCatalogArrays(input.observations, input.observationProvenance);
    const proposal = decodeModelProfileProposal(
      input.proposal,
      input.observationSet,
      input.observations,
    );
    const sources = validatedProvenanceMap(input.observationProvenance, input.observations);
    const artifact = proposalProjection(proposal, input.observationSet, sources);
    artifact.sha256 = artifactDigest(artifact);
    return validateModelCatalogProposalProvenance(
      artifact,
      proposal,
      input.observationSet,
      input.observations,
      input.observationProvenance,
    );
  } catch (error) {
    return provenanceFailure(error);
  }
}

export function decodeModelCatalogProposalProvenance(
  input: string | Uint8Array | unknown,
  proposal: ModelProfileProposalV1,
  observationSet: ModelCatalogObservationSetV1,
  observations: readonly ModelCatalogObservationV1[],
  observationProvenance: readonly ModelCatalogObservationProvenanceV1[],
): ModelCatalogProposalProvenanceV1 {
  try {
    return validateModelCatalogProposalProvenance(
      parsed(input),
      proposal,
      observationSet,
      observations,
      observationProvenance,
    );
  } catch (error) {
    return provenanceFailure(error);
  }
}

export function finalizeModelCatalogApprovalEvidence(input: {
  approval: OperatorApprovedModelProfileV1;
  proposalProvenance: ModelCatalogProposalProvenanceV1;
  proposal: ModelProfileProposalV1;
  observationSet: ModelCatalogObservationSetV1;
  observations: readonly ModelCatalogObservationV1[];
  observationProvenance: readonly ModelCatalogObservationProvenanceV1[];
}): ModelCatalogApprovalEvidenceV1 {
  try {
    preflightCatalogArrays(input.observations, input.observationProvenance);
    const approval = decodeOperatorApprovedModelProfile(
      input.approval,
      input.proposal,
      input.observationSet,
      input.observations,
    );
    const provenance = validateModelCatalogProposalProvenance(
      input.proposalProvenance,
      input.proposal,
      input.observationSet,
      input.observations,
      input.observationProvenance,
    );
    const artifact = approvalProjection(approval, provenance);
    artifact.sha256 = artifactDigest(artifact);
    return validateModelCatalogApprovalEvidence(
      artifact,
      approval,
      provenance,
      input.proposal,
      input.observationSet,
      input.observations,
      input.observationProvenance,
    );
  } catch (error) {
    return provenanceFailure(error);
  }
}

export function decodeModelCatalogApprovalEvidence(
  input: string | Uint8Array | unknown,
  approval: OperatorApprovedModelProfileV1,
  proposalProvenance: ModelCatalogProposalProvenanceV1,
  proposal: ModelProfileProposalV1,
  observationSet: ModelCatalogObservationSetV1,
  observations: readonly ModelCatalogObservationV1[],
  observationProvenance: readonly ModelCatalogObservationProvenanceV1[],
): ModelCatalogApprovalEvidenceV1 {
  try {
    return validateModelCatalogApprovalEvidence(
      parsed(input),
      approval,
      proposalProvenance,
      proposal,
      observationSet,
      observations,
      observationProvenance,
    );
  } catch (error) {
    return provenanceFailure(error);
  }
}

/** Sign the exact approval evidence at the trusted host boundary. */
export function signModelCatalogApprovalAuthorization(input: {
  approvalEvidence: ModelCatalogApprovalEvidenceV1;
  approval: OperatorApprovedModelProfileV1;
  proposalProvenance: ModelCatalogProposalProvenanceV1;
  proposal: ModelProfileProposalV1;
  observationSet: ModelCatalogObservationSetV1;
  observations: readonly ModelCatalogObservationV1[];
  observationProvenance: readonly ModelCatalogObservationProvenanceV1[];
  authorityId: string;
  authorizedAt: string;
  privateKey: KeyObject | string;
}): ModelCatalogApprovalAuthorizationV1 {
  try {
    const evidence = validateModelCatalogApprovalEvidence(
      input.approvalEvidence,
      input.approval,
      input.proposalProvenance,
      input.proposal,
      input.observationSet,
      input.observations,
      input.observationProvenance,
    );
    identifier(input.authorityId);
    timestamp(input.authorizedAt);
    if (input.authorityId !== evidence.approvedBy || input.authorizedAt < evidence.approvedAt)
      invalid();
    const statement = authorizationProjection(evidence, input.authorityId, input.authorizedAt);
    const privateKey =
      typeof input.privateKey === "string" ? createPrivateKey(input.privateKey) : input.privateKey;
    if (privateKey.asymmetricKeyType !== "ed25519") invalid();
    const signature = signBytes(
      null,
      Buffer.from(artifactDigest(statement), "hex"),
      privateKey,
    ).toString("base64url");
    const artifact = { ...statement, signature, sha256: "" };
    artifact.sha256 = artifactDigest(artifact);
    // Self-verification proves key/signature consistency; downstream callers
    // still authenticate against their separately supplied host authority.
    return validateModelCatalogApprovalAuthorization(artifact, evidence, {
      id: input.authorityId,
      publicKey: createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString(),
    });
  } catch (error) {
    return provenanceFailure(error);
  }
}

export function decodeModelCatalogApprovalAuthorization(
  input: string | Uint8Array | unknown,
  approvalEvidence: ModelCatalogApprovalEvidenceV1,
  authority: TrustedModelCatalogApprovalAuthority,
): ModelCatalogApprovalAuthorizationV1 {
  try {
    return validateModelCatalogApprovalAuthorization(parsed(input), approvalEvidence, authority);
  } catch (error) {
    return provenanceFailure(error);
  }
}

export function serializeModelCatalogProvenanceArtifact(
  artifact: ModelCatalogProvenanceArtifactV1,
  context: ModelCatalogProvenanceValidationContext,
): string {
  try {
    assertDataTree(artifact);
    const kindDescriptor = Object.getOwnPropertyDescriptor(artifact, "kind");
    if (!kindDescriptor || !Object.hasOwn(kindDescriptor, "value")) invalid();
    const kind = kindDescriptor.value;
    let validated: ModelCatalogProvenanceArtifactV1;
    if (kind === "docsfab-model-catalog-observation-provenance" && context.kind === "observation") {
      validated = validateModelCatalogObservationProvenance(artifact, context.observation);
    } else if (
      kind === "docsfab-model-catalog-proposal-provenance" &&
      context.kind === "proposal"
    ) {
      validated = validateModelCatalogProposalProvenance(
        artifact,
        context.proposal,
        context.observationSet,
        context.observations,
        context.observationProvenance,
      );
    } else if (kind === "docsfab-model-catalog-approval-evidence" && context.kind === "approval") {
      validated = validateModelCatalogApprovalEvidence(
        artifact,
        context.approval,
        context.proposalProvenance,
        context.proposal,
        context.observationSet,
        context.observations,
        context.observationProvenance,
      );
    } else if (
      kind === "docsfab-model-catalog-approval-authorization" &&
      context.kind === "authorization"
    ) {
      validated = validateModelCatalogApprovalAuthorization(
        artifact,
        context.approvalEvidence,
        context.authority,
      );
    } else {
      return invalid();
    }
    return canonicalizeJsonEvidence(validated as unknown as JsonEvidenceValue);
  } catch (error) {
    return provenanceFailure(error);
  }
}

/**
 * Emit the unchanged legacy run-record projection only after the complete
 * catalog approval chain and runtime projection agree exactly. Endpoint and
 * discovery credentials, source paths, provenance leaves, and operator IDs
 * never enter the returned evidence.
 */
export function createApprovedCatalogModelEvidence(input: {
  config: ModelEndpointConfig;
  /** Host-selected runtime slot; never inferred from caller-supplied evidence. */
  purpose: ModelProfilePurpose;
  asOf: Date;
  approvalEvidence: ModelCatalogApprovalEvidenceV1;
  approval: OperatorApprovedModelProfileV1;
  proposalProvenance: ModelCatalogProposalProvenanceV1;
  proposal: ModelProfileProposalV1;
  observationSet: ModelCatalogObservationSetV1;
  observations: readonly ModelCatalogObservationV1[];
  observationProvenance: readonly ModelCatalogObservationProvenanceV1[];
  authorization: ModelCatalogApprovalAuthorizationV1;
  authority: TrustedModelCatalogApprovalAuthority;
}): ModelEvidence {
  try {
    const evidence = validateModelCatalogApprovalEvidence(
      input.approvalEvidence,
      input.approval,
      input.proposalProvenance,
      input.proposal,
      input.observationSet,
      input.observations,
      input.observationProvenance,
    );
    const authorization = validateModelCatalogApprovalAuthorization(
      input.authorization,
      evidence,
      input.authority,
    );
    const asOfMilliseconds = input.asOf.valueOf();
    if (
      !Number.isFinite(asOfMilliseconds) ||
      asOfMilliseconds < Date.parse(authorization.authorizedAt)
    )
      invalid();
    if (
      input.purpose !== evidence.purpose ||
      input.config.providerId !== evidence.providerId ||
      input.config.modelId !== evidence.modelId ||
      (input.config.apiFormat !== "chat_completions" && input.config.apiFormat !== "messages")
    )
      invalid();
    const projected = projectApprovedModelProfile(
      input.approval,
      input.proposal,
      input.observationSet,
      input.observations,
      input.asOf,
    );
    if (!equalJson(input.config.profile, projected)) invalid();
    const model = createModelEvidence(input.config);
    assertCredentialFree(model);
    return model;
  } catch (error) {
    return provenanceFailure(error);
  }
}

function validateModelCatalogApprovalAuthorization(
  value: unknown,
  evidence: ModelCatalogApprovalEvidenceV1,
  authority: TrustedModelCatalogApprovalAuthority,
): ModelCatalogApprovalAuthorizationV1 {
  const authorization = validateAuthorizationShape(value);
  const validatedEvidence = validateApprovalEvidenceShape(evidence);
  identifier(authority.id);
  if (
    authorization.approvalEvidenceSha256 !== validatedEvidence.sha256 ||
    authorization.approvalSha256 !== validatedEvidence.approval.sha256 ||
    authorization.proposalSha256 !== validatedEvidence.proposal.sha256 ||
    authorization.purpose !== validatedEvidence.purpose ||
    authorization.providerId !== validatedEvidence.providerId ||
    authorization.modelId !== validatedEvidence.modelId ||
    authorization.origin !== validatedEvidence.origin ||
    authorization.effectiveDate !== validatedEvidence.effectiveDate ||
    authorization.reviewAfter !== validatedEvidence.reviewAfter ||
    authorization.authorityId !== validatedEvidence.approvedBy ||
    authorization.authorityId !== authority.id ||
    authorization.authorizedAt < validatedEvidence.approvedAt
  )
    invalid();
  let publicKey: KeyObject;
  try {
    publicKey = createPublicKey(authority.publicKey);
  } catch {
    return invalid();
  }
  if (publicKey.asymmetricKeyType !== "ed25519") invalid();
  const statement = authorizationProjection(
    validatedEvidence,
    authorization.authorityId,
    authorization.authorizedAt,
  );
  let verified = false;
  try {
    verified = verifyBytes(
      null,
      Buffer.from(artifactDigest(statement), "hex"),
      publicKey,
      Buffer.from(authorization.signature, "base64url"),
    );
  } catch {
    return invalid();
  }
  if (!verified) invalid();
  // Only this closed-schema, genuinely verified proof slot is public data.
  const { signature: _publicProof, ...nonProof } = authorization;
  assertCredentialFree(nonProof);
  return authorization;
}

function validateAuthorizationShape(value: unknown): ModelCatalogApprovalAuthorizationV1 {
  assertDataTree(value);
  const root = {
    ...closed(value, [
      "schemaVersion",
      "kind",
      "purpose",
      "approvalEvidenceSha256",
      "approvalSha256",
      "proposalSha256",
      "providerId",
      "modelId",
      "origin",
      "authorityId",
      "authorizedAt",
      "effectiveDate",
      "reviewAfter",
      "signature",
      "sha256",
    ]),
  };
  if (
    root.schemaVersion !== 1 ||
    root.kind !== "docsfab-model-catalog-approval-authorization" ||
    (root.purpose !== "policy" && root.purpose !== "judge")
  )
    invalid();
  digest(root.approvalEvidenceSha256);
  digest(root.approvalSha256);
  digest(root.proposalSha256);
  identifier(root.providerId);
  identifier(root.modelId);
  safeOrigin(root.origin);
  identifier(root.authorityId);
  timestamp(root.authorizedAt);
  date(root.effectiveDate);
  date(root.reviewAfter);
  if (typeof root.signature !== "string" || !/^[A-Za-z0-9_-]{86}$/u.test(root.signature)) invalid();
  const signatureBytes = Buffer.from(root.signature, "base64url");
  // Ed25519's 64-byte wire format has one canonical unpadded base64url encoding.
  if (signatureBytes.length !== 64 || signatureBytes.toString("base64url") !== root.signature)
    invalid();
  digest(root.sha256);
  if (artifactDigest(root) !== root.sha256) invalid();
  provenanceKit.rejectCredentials(root);
  return deepFreeze(root as unknown as ModelCatalogApprovalAuthorizationV1);
}

function authorizationProjection(
  evidence: ModelCatalogApprovalEvidenceV1,
  authorityId: string,
  authorizedAt: string,
): Omit<ModelCatalogApprovalAuthorizationV1, "signature" | "sha256"> {
  return {
    schemaVersion: 1,
    kind: "docsfab-model-catalog-approval-authorization",
    purpose: evidence.purpose,
    approvalEvidenceSha256: evidence.sha256,
    approvalSha256: evidence.approval.sha256,
    proposalSha256: evidence.proposal.sha256,
    providerId: evidence.providerId,
    modelId: evidence.modelId,
    origin: evidence.origin,
    authorityId,
    authorizedAt,
    effectiveDate: evidence.effectiveDate,
    reviewAfter: evidence.reviewAfter,
  };
}

function validateModelCatalogObservationProvenance(
  value: unknown,
  observationValue: ModelCatalogObservationV1,
): ModelCatalogObservationProvenanceV1 {
  assertDataTree(value);
  const observation = decodeModelCatalogObservation(observationValue);
  const root = closed(value, [
    "schemaVersion",
    "kind",
    "purpose",
    "observation",
    "source",
    "fields",
    "sha256",
  ]);
  if (root.schemaVersion !== 1 || root.kind !== "docsfab-model-catalog-observation-provenance")
    invalid();
  const source = closed(root.source, [
    "id",
    "origin",
    "pathSha256",
    "providerId",
    "modelId",
    "retrievedAt",
    "providerUpdatedAt",
    "adapter",
  ]);
  closed(source.adapter, ["id", "version"]);
  binding(root.observation);
  digest(source.pathSha256);
  digest(root.sha256);
  const expected = observationProjection(observation, String(source.pathSha256));
  if (
    !equalJson(withoutDigest(root), withoutDigest(expected)) ||
    artifactDigest(root) !== root.sha256
  )
    invalid();
  assertCredentialFree(root);
  return root as unknown as ModelCatalogObservationProvenanceV1;
}

function validateModelCatalogProposalProvenance(
  value: unknown,
  proposalValue: ModelProfileProposalV1,
  observationSet: ModelCatalogObservationSetV1,
  observations: readonly ModelCatalogObservationV1[],
  observationProvenance: readonly ModelCatalogObservationProvenanceV1[],
): ModelCatalogProposalProvenanceV1 {
  preflightCatalogArrays(observations, observationProvenance);
  assertDataTree(value);
  const proposal = decodeModelProfileProposal(proposalValue, observationSet, observations);
  const sources = validatedProvenanceMap(observationProvenance, observations);
  const root = closed(value, [
    "schemaVersion",
    "kind",
    "purpose",
    "proposal",
    "observationSet",
    "observations",
    "providerId",
    "modelId",
    "origin",
    "createdAt",
    "reconciliationPolicy",
    "fields",
    "sha256",
  ]);
  if (root.schemaVersion !== 1 || root.kind !== "docsfab-model-catalog-proposal-provenance")
    invalid();
  binding(root.proposal);
  binding(root.observationSet);
  denseArray(root.observations, 64).forEach((item) => {
    const binding = closed(item, ["observationId", "provenanceSha256"]);
    identifier(binding.observationId);
    digest(binding.provenanceSha256);
  });
  const policy = closed(root.reconciliationPolicy, ["id", "version"]);
  const expectedPolicy = reconciliationPolicyFor(proposal, [...sources.values()]);
  if (policy.id !== expectedPolicy.id || policy.version !== expectedPolicy.version) invalid();
  digest(root.sha256);
  const expected = proposalProjection(proposal, observationSet, sources);
  if (
    !equalJson(withoutDigest(root), withoutDigest(expected)) ||
    artifactDigest(root) !== root.sha256
  )
    invalid();
  assertCredentialFree(root);
  return root as unknown as ModelCatalogProposalProvenanceV1;
}

function validateModelCatalogApprovalEvidence(
  value: unknown,
  approvalValue: OperatorApprovedModelProfileV1,
  proposalProvenanceValue: ModelCatalogProposalProvenanceV1,
  proposal: ModelProfileProposalV1,
  observationSet: ModelCatalogObservationSetV1,
  observations: readonly ModelCatalogObservationV1[],
  observationProvenance: readonly ModelCatalogObservationProvenanceV1[],
): ModelCatalogApprovalEvidenceV1 {
  preflightCatalogArrays(observations, observationProvenance);
  const approval = decodeOperatorApprovedModelProfile(
    approvalValue,
    proposal,
    observationSet,
    observations,
  );
  const provenance = validateModelCatalogProposalProvenance(
    proposalProvenanceValue,
    proposal,
    observationSet,
    observations,
    observationProvenance,
  );
  const root = validateApprovalEvidenceShape(value);
  const expected = approvalProjection(approval, provenance);
  if (!equalJson(withoutDigest(root), withoutDigest(expected))) invalid();
  return root;
}

function validateApprovalEvidenceShape(value: unknown): ModelCatalogApprovalEvidenceV1 {
  assertDataTree(value);
  const root = closed(value, [
    "schemaVersion",
    "kind",
    "purpose",
    "approval",
    "proposal",
    "proposalProvenanceSha256",
    "providerId",
    "modelId",
    "origin",
    "approvedBy",
    "approvedAt",
    "effectiveDate",
    "reviewAfter",
    "fields",
    "sha256",
  ]);
  if (root.schemaVersion !== 1 || root.kind !== "docsfab-model-catalog-approval-evidence")
    invalid();
  binding(root.approval);
  binding(root.proposal);
  if (root.purpose !== "policy" && root.purpose !== "judge") invalid();
  digest(root.proposalProvenanceSha256);
  identifier(root.providerId);
  identifier(root.modelId);
  safeOrigin(root.origin);
  identifier(root.approvedBy);
  timestamp(root.approvedAt);
  date(root.effectiveDate);
  date(root.reviewAfter);
  const fields = denseArray(root.fields, 64);
  if (fields.length === 0) invalid();
  digest(root.sha256);
  if (artifactDigest(root) !== root.sha256) invalid();
  assertCredentialFree(root);
  return root as unknown as ModelCatalogApprovalEvidenceV1;
}

function observationProjection(
  observation: ModelCatalogObservationV1,
  pathSha256: string,
): ModelCatalogObservationProvenanceV1 {
  const providerUpdated = fieldValue(observation.fields, "providerUpdatedAt");
  return {
    schemaVersion: 1,
    kind: "docsfab-model-catalog-observation-provenance",
    purpose: observation.purpose,
    observation: { id: observation.id, sha256: observation.sha256 },
    source: {
      id: observation.source.id,
      origin: requiredString(observation.fields, "origin"),
      pathSha256,
      providerId: requiredString(observation.fields, "providerId"),
      modelId: requiredString(observation.fields, "modelId"),
      retrievedAt: observation.source.retrievedAt,
      providerUpdatedAt:
        providerUpdated?.state === "observed" && typeof providerUpdated.value === "string"
          ? providerUpdated.value
          : null,
      adapter: { ...observation.source.adapter },
    },
    fields: structuredClone(observation.fields),
    sha256: "",
  };
}

function proposalProjection(
  proposal: ModelProfileProposalV1,
  observationSet: ModelCatalogObservationSetV1,
  sources: Map<string, ModelCatalogObservationProvenanceV1>,
): ModelCatalogProposalProvenanceV1 {
  return {
    schemaVersion: 1,
    kind: "docsfab-model-catalog-proposal-provenance",
    purpose: proposal.purpose,
    proposal: { id: proposal.id, sha256: proposal.sha256 },
    observationSet: { id: observationSet.id, sha256: observationSet.sha256 },
    observations: [...sources]
      .map(([observationId, evidence]) => ({
        observationId,
        provenanceSha256: evidence.sha256,
      }))
      .sort((left, right) => compareText(left.observationId, right.observationId)),
    providerId: requiredProposalString(proposal.fields, "providerId"),
    modelId: requiredProposalString(proposal.fields, "modelId"),
    origin: requiredProposalString(proposal.fields, "origin"),
    createdAt: proposal.createdAt,
    reconciliationPolicy: { ...reconciliationPolicyFor(proposal, [...sources.values()]) },
    fields: structuredClone(proposal.fields),
    sha256: "",
  };
}

function reconciliationPolicyFor(
  proposal: ModelProfileProposalV1,
  provenances: readonly ModelCatalogObservationProvenanceV1[],
): ModelCatalogReconciliationPolicy {
  const adapterIds = provenances.map((item) => item.source.adapter.id);
  if (adapterIds.length === 1 && isDirectProviderCatalogAdapterId(adapterIds[0]!)) {
    return MODEL_CATALOG_RECONCILIATION_POLICY_DIRECT_PROVIDER;
  }
  const usesVersionTwo = proposal.fields.some(
    (field) =>
      field.derivation.kind === "rule" &&
      (field.derivation.rule === "combined-context-input-clamp@1" ||
        field.derivation.rule === "qualified-model-label@1" ||
        field.derivation.rule === "propagate-no-authoritative-value@1" ||
        field.derivation.rule === "select-runtime-source@1"),
  );
  return usesVersionTwo
    ? MODEL_CATALOG_RECONCILIATION_POLICY
    : MODEL_CATALOG_RECONCILIATION_POLICY_V1;
}

function approvalProjection(
  approval: OperatorApprovedModelProfileV1,
  provenance: ModelCatalogProposalProvenanceV1,
): ModelCatalogApprovalEvidenceV1 {
  return {
    schemaVersion: 1,
    kind: "docsfab-model-catalog-approval-evidence",
    purpose: approval.purpose,
    approval: { id: approval.id, sha256: approval.sha256 },
    proposal: { ...provenance.proposal },
    proposalProvenanceSha256: provenance.sha256,
    providerId: requiredProposalString(approval.fields, "providerId"),
    modelId: requiredProposalString(approval.fields, "modelId"),
    origin: requiredProposalString(approval.fields, "origin"),
    approvedBy: approval.approvedBy,
    approvedAt: approval.approvedAt,
    effectiveDate: approval.effectiveDate,
    reviewAfter: approval.reviewAfter,
    fields: structuredClone(approval.fields),
    sha256: "",
  };
}

function validatedProvenanceMap(
  values: readonly ModelCatalogObservationProvenanceV1[],
  observations: readonly ModelCatalogObservationV1[],
): Map<string, ModelCatalogObservationProvenanceV1> {
  const entries = denseArray(values, 64) as ModelCatalogObservationProvenanceV1[];
  const observationEntries = denseArray(observations, 64) as ModelCatalogObservationV1[];
  if (entries.length !== observationEntries.length || entries.length === 0) invalid();
  const observationsById = new Map<string, ModelCatalogObservationV1>();
  for (const candidate of observationEntries) {
    const observation = decodeModelCatalogObservation(candidate);
    if (observationsById.has(observation.id)) invalid();
    observationsById.set(observation.id, observation);
  }
  const output = new Map<string, ModelCatalogObservationProvenanceV1>();
  for (const value of entries) {
    assertDataTree(value);
    const root = record(value);
    const observationBinding = closed(root.observation, ["id", "sha256"]);
    identifier(observationBinding.id);
    const id = observationBinding.id;
    const observation = observationsById.get(id);
    if (!observation || output.has(id)) invalid();
    output.set(id, validateModelCatalogObservationProvenance(value, observation));
  }
  return new Map([...output].sort(([left], [right]) => compareText(left, right)));
}

function preflightCatalogArrays(
  observations: readonly ModelCatalogObservationV1[],
  provenance: readonly ModelCatalogObservationProvenanceV1[],
): void {
  assertDataTree(observations);
  assertDataTree(provenance);
  denseArray(observations, 64);
  denseArray(provenance, 64);
}

function fieldValue(fields: readonly ModelCatalogFieldEvidenceV1[], name: string) {
  return fields.find((field) => field.field === name);
}

function requiredString(fields: readonly ModelCatalogFieldEvidenceV1[], name: string): string {
  const field = fieldValue(fields, name);
  if (field?.state !== "observed" || typeof field.value !== "string") return invalid();
  return field.value;
}

function requiredProposalString(
  fields: readonly ModelCatalogProposalFieldV1[],
  name: string,
): string {
  const field = fields.find((item) => item.field === name);
  if (field?.state !== "observed" || typeof field.value !== "string") return invalid();
  return field.value;
}

function validateSourcePath(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.includes("\0") ||
    value.includes("#") ||
    Buffer.byteLength(value, "utf8") > 4_096 ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    detectCredentialRuleIds(value).length > 0
  )
    invalid();
}

function parsed(input: string | Uint8Array | unknown): unknown {
  try {
    if (typeof input === "string" && Buffer.byteLength(input, "utf8") > 1024 * 1024) invalid();
    if (input instanceof Uint8Array && input.byteLength > 1024 * 1024) invalid();
    return typeof input === "string" || input instanceof Uint8Array
      ? parseJsonEvidence(input)
      : input;
  } catch {
    return invalid();
  }
}

function artifactDigest(value: object): string {
  return sha256(canonicalizeJsonEvidence(withoutDigest(value) as JsonEvidenceValue));
}

function withoutDigest(value: object): Record<string, unknown> {
  const { sha256: _sha256, ...body } = value as Record<string, unknown>;
  return body;
}

function assertCredentialFree(value: unknown): void {
  provenanceKit.rejectCredentials(value);
  if (detectCredentialRuleIdsInValue(value).length > 0) invalid();
}

function assertDataTree(value: unknown, depth = 0, budget = { nodes: 0 }): void {
  if (depth === 0) provenanceKit.assertInert(value);
  budget.nodes += 1;
  if (budget.nodes > 20_000 || depth > 24) invalid();
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) && !Number.isFinite(value)) invalid();
    return;
  }
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > 4_096) invalid();
    return;
  }
  if (Array.isArray(value)) {
    for (const item of denseArray(value, 128)) assertDataTree(item, depth + 1, budget);
    return;
  }
  const root = record(value);
  if (Object.keys(root).length > 64) invalid();
  for (const [key, item] of Object.entries(root)) {
    if (key.length > 128) invalid();
    assertDataTree(item, depth + 1, budget);
  }
}

function closed(value: unknown, required: readonly string[]): Record<string, unknown> {
  const root = record(value);
  const keys = Object.keys(root);
  if (
    keys.length !== required.length ||
    required.some((key) => !Object.hasOwn(root, key)) ||
    keys.some((key) => !required.includes(key))
  )
    invalid();
  return root;
}

function record(value: unknown): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.getOwnPropertySymbols(value).length > 0
  )
    invalid();
  const descriptors = Object.values(Object.getOwnPropertyDescriptors(value));
  if (descriptors.some((item) => !Object.hasOwn(item, "value") || !item.enumerable)) invalid();
  return value as Record<string, unknown>;
}

function denseArray(value: unknown, maximum: number): unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximum ||
    Object.getOwnPropertySymbols(value).length > 0
  )
    invalid();
  const names = Object.getOwnPropertyNames(value);
  if (
    names.length !== value.length + 1 ||
    names.some((name, index) => (index < value.length ? name !== String(index) : name !== "length"))
  )
    invalid();
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) invalid();
  }
  return value;
}

function binding(value: unknown): void {
  const root = closed(value, ["id", "sha256"]);
  identifier(root.id);
  digest(root.sha256);
}

function identifier(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/u.test(value) ||
    value.includes("..") ||
    value.includes("//")
  )
    invalid();
}

function digest(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) invalid();
}

function safeOrigin(value: unknown): asserts value is string {
  if (typeof value !== "string") invalid();
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash ||
      parsed.origin !== value
    )
      invalid();
  } catch {
    invalid();
  }
}

function timestamp(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    new Date(value).toISOString() !== value
  )
    invalid();
}

function date(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(value) ||
    new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value
  )
    invalid();
}

function equalJson(left: unknown, right: unknown): boolean {
  return (
    canonicalizeJsonEvidence(left as JsonEvidenceValue) ===
    canonicalizeJsonEvidence(right as JsonEvidenceValue)
  );
}

function provenanceFailure(error: unknown): never {
  if (error instanceof ModelCatalogProvenanceError) throw error;
  throw new ModelCatalogProvenanceError();
}

function invalid(): never {
  throw new ModelCatalogProvenanceError();
}
