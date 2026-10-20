// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Repository grant, broker identity class, and effective-authority intersection
 * contracts. Intersection is not a grant expansion.
 */

import {
  AUTHORITY_BASES,
  DELIVERY_CONTROLLERS,
  DELIVERY_INTENTS,
  assertAllowedDeliveryCombination,
  decodeDeliveryRequest,
  deliveryAuthorityKit as kit,
  failDeliveryAuthority,
  type AuthorityBasis,
  type DeliveryController,
  type DeliveryIntent,
  type DeliveryRequestV1,
} from "./delivery-authority.js";

export const REPOSITORY_GRANT_TIERS = ["discover", "observe", "review", "contribute"] as const;
export type RepositoryGrantTier = (typeof REPOSITORY_GRANT_TIERS)[number];

export const REPOSITORY_GRANT_OPERATIONS = [
  "read-activation-eligibility",
  "read-revision",
  "read-merge-request",
  "read-ci",
  "read-evidence",
  "create-or-update-summary-note",
  "push-namespaced-unprotected-non-default-branch",
  "create-or-reuse-draft-mr",
  "update-existing-mr-source-branch",
] as const;
export type RepositoryGrantOperation = (typeof REPOSITORY_GRANT_OPERATIONS)[number];

export const GRANT_TIER_OPERATIONS: Readonly<
  Record<RepositoryGrantTier, readonly RepositoryGrantOperation[]>
> = Object.freeze({
  discover: ["read-activation-eligibility"],
  observe: [
    "read-activation-eligibility",
    "read-revision",
    "read-merge-request",
    "read-ci",
    "read-evidence",
  ],
  review: [
    "read-activation-eligibility",
    "read-revision",
    "read-merge-request",
    "read-ci",
    "read-evidence",
    "create-or-update-summary-note",
  ],
  contribute: [
    "read-activation-eligibility",
    "read-revision",
    "read-merge-request",
    "read-ci",
    "read-evidence",
    "create-or-update-summary-note",
    "push-namespaced-unprotected-non-default-branch",
    "create-or-reuse-draft-mr",
  ],
});

export const INTENT_REQUIRED_OPERATIONS: Readonly<
  Record<DeliveryIntent, readonly RepositoryGrantOperation[]>
> = Object.freeze({
  "artifact-only": [],
  "comment-existing-mr": ["create-or-update-summary-note"],
  "create-draft-mr": ["push-namespaced-unprotected-non-default-branch", "create-or-reuse-draft-mr"],
  "update-existing-mr": ["update-existing-mr-source-branch"],
});

export const CREDENTIAL_BROKER_IDENTITY_CLASS = "organization-owned-gitlab-bot-or-app" as const;

export interface CredentialBrokerIdentityClassV1 {
  schemaVersion: 1;
  kind: "docsfab-credential-broker-identity-class";
  identityClass: typeof CREDENTIAL_BROKER_IDENTITY_CLASS;
  handleKind: "per-task";
  workerHoldsCredentials: false;
  identitySha256: string;
}

export interface RepositoryGrantInputV1 {
  grantVersion: number;
  host: string;
  projectId: number;
  tier: RepositoryGrantTier;
  status: "active" | "revoked" | "reduced";
  updateExistingMr: {
    enabled: boolean;
    ownershipPolicy: "same-author" | "docsfab-owned" | "none";
    forkPolicy: "same-project" | "none";
    headPolicy: "exact-head" | "none";
  };
}

export interface RepositoryGrantV1 extends RepositoryGrantInputV1 {
  schemaVersion: 1;
  kind: "docsfab-repository-grant";
  operations: readonly RepositoryGrantOperation[];
  grantSha256: string;
}

export interface DeliveryWorkflowPolicyV1 {
  allowedIntents: readonly DeliveryIntent[];
  allowedControllers: readonly DeliveryController[];
  allowedAuthorityBases: readonly AuthorityBasis[];
}

export interface DeliveryServiceCapabilityV1 {
  publisher: "host-owned";
  broker: CredentialBrokerIdentityClassV1;
  namedOperations: readonly RepositoryGrantOperation[];
}

export interface DeliveryRequesterV1 {
  entitlement: "none" | "operator" | "activator";
}

export interface DeliveryScmStateV1 {
  grantStatus: "active" | "revoked" | "reduced";
  currentHeadRevision: string;
  sourceBranchProtected: boolean;
  sourceBranchIsDefault: boolean;
}

export interface FreshDeliveryRevalidationV1 {
  readonly kind: "docsfab-fresh-delivery-revalidation";
  readonly deliveryKeySha256: string;
  readonly scmStateSha256: string;
}

export interface EffectiveAuthorityV1 {
  schemaVersion: 1;
  kind: "docsfab-effective-authority";
  requestSha256: string;
  grantSha256: string | null;
  operations: readonly RepositoryGrantOperation[];
  publisher: "host-owned";
  authorityExpansion: false;
  effectiveSha256: string;
}

const issuedRevalidations = new WeakMap<
  object,
  { deliveryKeySha256: string; scmStateSha256: string }
>();

export function createCredentialBrokerIdentityClass(): CredentialBrokerIdentityClassV1 {
  return kit.seal("docsfab-credential-broker-identity-class", "identitySha256", {
    identityClass: CREDENTIAL_BROKER_IDENTITY_CLASS,
    handleKind: "per-task" as const,
    workerHoldsCredentials: false as const,
  });
}

export function decodeCredentialBrokerIdentityClass(
  value: unknown,
): CredentialBrokerIdentityClassV1 {
  return kit.decodeSealed(
    value,
    "docsfab-credential-broker-identity-class",
    "identitySha256",
    ["identityClass", "handleKind", "workerHoldsCredentials"],
    (root) => {
      if (root.workerHoldsCredentials !== false) failDeliveryAuthority("authority-widening");
      return {
        identityClass: kit.enumeration(root.identityClass, [
          CREDENTIAL_BROKER_IDENTITY_CLASS,
        ] as const),
        handleKind: kit.enumeration(root.handleKind, ["per-task"] as const),
        workerHoldsCredentials: false as const,
      };
    },
  );
}

export function createRepositoryGrant(input: RepositoryGrantInputV1): RepositoryGrantV1 {
  kit.assertInert(input);
  kit.rejectCredentials(input);
  return kit.seal("docsfab-repository-grant", "grantSha256", normalizeGrantInput(input));
}

export function decodeRepositoryGrant(value: unknown): RepositoryGrantV1 {
  return kit.decodeSealed(
    value,
    "docsfab-repository-grant",
    "grantSha256",
    ["grantVersion", "host", "projectId", "tier", "status", "updateExistingMr", "operations"],
    (root) =>
      normalizeGrantInput(root as unknown as RepositoryGrantInputV1 & { operations?: unknown }),
  );
}

export function scmStateSha256(state: DeliveryScmStateV1): string {
  kit.assertInert(state);
  return kit.canonicalDigest(normalizeScmState(state));
}

export function mintFreshDeliveryRevalidation(input: {
  deliveryKeySha256: string;
  scmStateSha256: string;
}): FreshDeliveryRevalidationV1 {
  const deliveryKeySha256 = kit.hash(input.deliveryKeySha256);
  const stateDigest = kit.hash(input.scmStateSha256);
  const token = Object.freeze({
    kind: "docsfab-fresh-delivery-revalidation" as const,
    deliveryKeySha256,
    scmStateSha256: stateDigest,
  });
  issuedRevalidations.set(token, { deliveryKeySha256, scmStateSha256: stateDigest });
  return token;
}

export function assertFreshDeliveryRevalidation(
  value: unknown,
  deliveryKeySha256: string,
  stateDigest: string,
): asserts value is FreshDeliveryRevalidationV1 {
  if (typeof value !== "object" || value === null) failDeliveryAuthority("revalidation-required");
  const issued = issuedRevalidations.get(value);
  const token = value as FreshDeliveryRevalidationV1;
  if (
    !issued ||
    token.kind !== "docsfab-fresh-delivery-revalidation" ||
    issued.deliveryKeySha256 !== kit.hash(deliveryKeySha256) ||
    issued.scmStateSha256 !== kit.hash(stateDigest) ||
    token.deliveryKeySha256 !== issued.deliveryKeySha256 ||
    token.scmStateSha256 !== issued.scmStateSha256
  ) {
    failDeliveryAuthority("revalidation-required");
  }
}

export function intersectEffectiveAuthority(input: {
  request: DeliveryRequestV1;
  requester: DeliveryRequesterV1;
  grant: RepositoryGrantV1 | null;
  workflowPolicy: DeliveryWorkflowPolicyV1;
  serviceCapability: DeliveryServiceCapabilityV1;
  scmState: DeliveryScmStateV1;
  revalidation: unknown;
  deliveryKeySha256: string;
}): EffectiveAuthorityV1 {
  kit.assertInert({
    requester: input.requester,
    workflowPolicy: input.workflowPolicy,
    serviceCapability: {
      publisher: input.serviceCapability.publisher,
      namedOperations: input.serviceCapability.namedOperations,
    },
    scmState: input.scmState,
  });
  const request = decodeDeliveryRequest(input.request);
  const requester = normalizeRequester(input.requester);
  const broker = decodeCredentialBrokerIdentityClass(input.serviceCapability.broker);
  if (broker.workerHoldsCredentials !== false) failDeliveryAuthority("authority-widening");
  if (input.serviceCapability.publisher !== "host-owned") {
    failDeliveryAuthority("authority-required");
  }
  assertAllowedDeliveryCombination(request.intent, request.authorityBasis, request.controller);
  const policy = normalizePolicy(input.workflowPolicy);
  if (
    !policy.allowedIntents.includes(request.intent) ||
    !policy.allowedControllers.includes(request.controller) ||
    !policy.allowedAuthorityBases.includes(request.authorityBasis)
  ) {
    failDeliveryAuthority("unsupported-combination");
  }
  if (requester.entitlement === "none" && request.intent !== "artifact-only") {
    failDeliveryAuthority("insufficient-grant");
  }
  const scm = normalizeScmState(input.scmState);
  const namedOperations = uniqueEnumeration(
    input.serviceCapability.namedOperations,
    REPOSITORY_GRANT_OPERATIONS,
    false,
  );
  const required = INTENT_REQUIRED_OPERATIONS[request.intent];
  let grant: RepositoryGrantV1 | null = null;
  if (request.intent === "artifact-only") {
    if (request.authorityBasis !== "none") failDeliveryAuthority("unsupported-combination");
  } else {
    assertFreshDeliveryRevalidation(
      input.revalidation,
      input.deliveryKeySha256,
      scmStateSha256(scm),
    );
    if (input.grant === null) failDeliveryAuthority("insufficient-grant");
    grant = decodeRepositoryGrant(input.grant);
    if (grant.host !== request.binding.host || grant.projectId !== request.binding.projectId) {
      failDeliveryAuthority("insufficient-grant");
    }
    if (grant.grantVersion !== request.binding.grant.version) {
      failDeliveryAuthority("stale-scm-state");
    }
    if (grant.status !== "active" || scm.grantStatus !== "active") {
      failDeliveryAuthority("insufficient-grant");
    }
    if (grant.tier !== request.binding.grant.tier) failDeliveryAuthority("insufficient-grant");
    if (request.intent === "create-draft-mr") {
      if (scm.sourceBranchProtected || scm.sourceBranchIsDefault) {
        failDeliveryAuthority("excluded-power");
      }
    }
    if (
      request.intent === "comment-existing-mr" &&
      scm.currentHeadRevision !== request.binding.headRevision
    ) {
      failDeliveryAuthority("stale-scm-state");
    }
  }
  const grantOperations = new Set(grant?.operations ?? []);
  const serviceOperations = new Set(namedOperations);
  const effective = required.filter(
    (operation) => grantOperations.has(operation) && serviceOperations.has(operation),
  );
  if (effective.length !== required.length) failDeliveryAuthority("insufficient-grant");
  if (grant && request.binding.grant.updateExistingMrEnabled !== grant.updateExistingMr.enabled) {
    failDeliveryAuthority("invalid-value");
  }
  if (request.intent === "update-existing-mr") failDeliveryAuthority("reserved-combination");
  return kit.seal("docsfab-effective-authority", "effectiveSha256", {
    requestSha256: request.requestSha256,
    grantSha256: grant?.grantSha256 ?? null,
    operations: effective,
    publisher: "host-owned" as const,
    authorityExpansion: false as const,
  });
}

export function decodeEffectiveAuthority(value: unknown): EffectiveAuthorityV1 {
  return kit.decodeSealed(
    value,
    "docsfab-effective-authority",
    "effectiveSha256",
    ["requestSha256", "grantSha256", "operations", "publisher", "authorityExpansion"],
    (root) => {
      if (root.authorityExpansion !== false) failDeliveryAuthority("authority-widening");
      if (root.publisher !== "host-owned") failDeliveryAuthority("authority-required");
      return {
        requestSha256: kit.hash(root.requestSha256),
        grantSha256: kit.nullableHash(root.grantSha256),
        operations: kit
          .array(root.operations)
          .map((item) => kit.enumeration(item, REPOSITORY_GRANT_OPERATIONS)),
        publisher: "host-owned" as const,
        authorityExpansion: false as const,
      };
    },
  );
}

function normalizeGrantInput(
  input: RepositoryGrantInputV1 & { operations?: unknown },
): RepositoryGrantInputV1 & { operations: readonly RepositoryGrantOperation[] } {
  const root = kit.object(input);
  kit.exact(
    root,
    ["grantVersion", "host", "projectId", "tier", "status", "updateExistingMr", "operations"],
    ["operations"],
  );
  const tier = kit.enumeration(root.tier, REPOSITORY_GRANT_TIERS);
  const status = kit.enumeration(root.status, ["active", "revoked", "reduced"] as const);
  const updateRoot = kit.object(root.updateExistingMr);
  kit.exact(updateRoot, ["enabled", "ownershipPolicy", "forkPolicy", "headPolicy"]);
  const enabled = booleanValue(updateRoot.enabled);
  const operations = [...GRANT_TIER_OPERATIONS[tier]];
  if (enabled) {
    if (tier !== "contribute") failDeliveryAuthority("insufficient-grant");
    operations.push("update-existing-mr-source-branch");
  }
  if (root.operations !== undefined) {
    const supplied = kit
      .array(root.operations)
      .map((item) => kit.enumeration(item, REPOSITORY_GRANT_OPERATIONS));
    if (
      kit.canonicalJson([...supplied].sort(kit.compare)) !==
      kit.canonicalJson([...operations].sort(kit.compare))
    ) {
      failDeliveryAuthority("authority-widening");
    }
  }
  return {
    grantVersion: positiveInteger(root.grantVersion),
    host: kit.identifier(root.host),
    projectId: positiveInteger(root.projectId),
    tier,
    status,
    updateExistingMr: {
      enabled,
      ownershipPolicy: kit.enumeration(updateRoot.ownershipPolicy, [
        "same-author",
        "docsfab-owned",
        "none",
      ] as const),
      forkPolicy: kit.enumeration(updateRoot.forkPolicy, ["same-project", "none"] as const),
      headPolicy: kit.enumeration(updateRoot.headPolicy, ["exact-head", "none"] as const),
    },
    operations,
  };
}

function normalizePolicy(value: DeliveryWorkflowPolicyV1): DeliveryWorkflowPolicyV1 {
  const root = kit.object(value);
  kit.exact(root, ["allowedIntents", "allowedControllers", "allowedAuthorityBases"]);
  return {
    allowedIntents: uniqueEnumeration(root.allowedIntents, DELIVERY_INTENTS),
    allowedControllers: uniqueEnumeration(root.allowedControllers, DELIVERY_CONTROLLERS),
    allowedAuthorityBases: uniqueEnumeration(root.allowedAuthorityBases, AUTHORITY_BASES),
  };
}

function normalizeScmState(value: DeliveryScmStateV1): DeliveryScmStateV1 {
  const root = kit.object(value);
  kit.exact(root, [
    "grantStatus",
    "currentHeadRevision",
    "sourceBranchProtected",
    "sourceBranchIsDefault",
  ]);
  return {
    grantStatus: kit.enumeration(root.grantStatus, ["active", "revoked", "reduced"] as const),
    currentHeadRevision: kit.revision(root.currentHeadRevision),
    sourceBranchProtected: booleanValue(root.sourceBranchProtected),
    sourceBranchIsDefault: booleanValue(root.sourceBranchIsDefault),
  };
}

function normalizeRequester(value: DeliveryRequesterV1): DeliveryRequesterV1 {
  const root = kit.object(value);
  kit.exact(root, ["entitlement"]);
  return {
    entitlement: kit.enumeration(root.entitlement, ["none", "operator", "activator"] as const),
  };
}

function uniqueEnumeration<const T extends readonly string[]>(
  value: unknown,
  values: T,
  requireNonEmpty = true,
): T[number][] {
  const result = kit.array(value).map((item) => kit.enumeration(item, values));
  kit.unique(result);
  if (requireNonEmpty && result.length === 0) failDeliveryAuthority("invalid-value");
  return result;
}

function positiveInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    failDeliveryAuthority("invalid-value");
  }
  return value;
}

function booleanValue(value: unknown): boolean {
  if (typeof value !== "boolean") failDeliveryAuthority("invalid-value");
  return value;
}
