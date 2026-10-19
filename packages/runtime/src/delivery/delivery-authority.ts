// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Destination-neutral delivery-intent contracts over orthogonal axes: trigger,
 * delivery intent, authority basis, and controller. A typed request is not an
 * authority grant, and unsupported combinations fail closed. Durable delivery
 * keys are replay-safe; a WeakSet is not a ledger.
 */

import { createContractKit, type ContractFail } from "../contract-kit/index.js";

export const DELIVERY_TRIGGERS = ["interactive", "api", "webhook"] as const;
export type DeliveryTrigger = (typeof DELIVERY_TRIGGERS)[number];

export const DELIVERY_INTENTS = [
  "artifact-only",
  "create-draft-mr",
  "comment-existing-mr",
  "update-existing-mr",
] as const;
export type DeliveryIntent = (typeof DELIVERY_INTENTS)[number];

export const AUTHORITY_BASES = ["none", "interactive-once", "standing-repo-grant"] as const;
export type AuthorityBasis = (typeof AUTHORITY_BASES)[number];

export const DELIVERY_CONTROLLERS = ["one-shot", "bounded-reconcile"] as const;
export type DeliveryController = (typeof DELIVERY_CONTROLLERS)[number];

export const EXCLUDED_DELIVERY_POWERS = [
  "agent-direct-scm-mutation",
  "approve",
  "mark-ready",
  "merge",
  "protected-default-write",
  "release",
  "admin",
  "grant-expansion",
] as const;
export type ExcludedDeliveryPower = (typeof EXCLUDED_DELIVERY_POWERS)[number];

export type DeliveryCombinationStatus = "supported" | "reserved" | "denied";

export interface DeliveryCombinationV1 {
  readonly intent: DeliveryIntent;
  readonly authorityBasis: AuthorityBasis;
  readonly controller: DeliveryController;
}

/** Complete initial supported rows. Unlisted combinations are denied, not inferred. */
export const SUPPORTED_DELIVERY_COMBINATIONS: readonly DeliveryCombinationV1[] = Object.freeze([
  { intent: "artifact-only", authorityBasis: "none", controller: "one-shot" },
  { intent: "create-draft-mr", authorityBasis: "interactive-once", controller: "one-shot" },
  { intent: "create-draft-mr", authorityBasis: "standing-repo-grant", controller: "one-shot" },
  { intent: "comment-existing-mr", authorityBasis: "interactive-once", controller: "one-shot" },
  { intent: "comment-existing-mr", authorityBasis: "standing-repo-grant", controller: "one-shot" },
  {
    intent: "comment-existing-mr",
    authorityBasis: "standing-repo-grant",
    controller: "bounded-reconcile",
  },
]);

export type DeliveryAuthorityErrorCode =
  | "invalid-shape"
  | "invalid-value"
  | "digest-mismatch"
  | "credential-material"
  | "unsupported-combination"
  | "reserved-combination"
  | "insufficient-grant"
  | "authority-required"
  | "authority-widening"
  | "delivery-conflict"
  | "excluded-power"
  | "stale-scm-state"
  | "revalidation-required"
  | "migration-required";

export class DeliveryAuthorityError extends Error {
  public readonly code: DeliveryAuthorityErrorCode;

  public constructor(code: DeliveryAuthorityErrorCode) {
    super(`Delivery authority contract rejected: ${code}.`);
    this.name = "DeliveryAuthorityError";
    this.code = code;
  }
}

export function failDeliveryAuthority(code: DeliveryAuthorityErrorCode): never {
  throw new DeliveryAuthorityError(code);
}

export const deliveryAuthorityKit = createContractKit({
  fail: failDeliveryAuthority as ContractFail<DeliveryAuthorityErrorCode>,
  inertMode: "strict",
  codes: {
    invalidShape: "invalid-shape",
    invalidValue: "invalid-value",
    digestMismatch: "digest-mismatch",
    credentialMaterial: "credential-material",
    schemaMismatch: "migration-required",
  },
});

const kit = deliveryAuthorityKit;

export interface DeliveryProtectionStateV1 {
  defaultBranch: string;
  sourceBranch: string;
  sourceProtected: boolean;
  targetProtected: boolean;
  sourceIsDefault: boolean;
}

export interface DeliveryGrantBindingV1 {
  version: number;
  tier: "discover" | "observe" | "review" | "contribute";
  updateExistingMrEnabled: boolean;
}

/** Exact reviewed-candidate binding used when delivery uploads a new commit. */
export interface DeliveryCandidateBindingV1 {
  /** Git tree object T independently validated by the trusted host. */
  treeObjectId: string;
  /** Exact target/scope manifest reviewed for T. */
  targetManifestSha256: string;
  /** Host eligibility receipt that binds H/T, patch, scope, policy, and review. */
  eligibilityReceiptSha256: string;
}

export interface DeliveryTargetBindingV1 {
  host: string;
  projectId: number;
  repository: string;
  baseRevision: string;
  headRevision: string;
  patchDigestSha256: string;
  allowedPaths: readonly string[];
  candidate?: DeliveryCandidateBindingV1;
  protection: DeliveryProtectionStateV1;
  grant: DeliveryGrantBindingV1;
}

export interface DeliveryRequestInputV1 {
  trigger: DeliveryTrigger;
  intent: DeliveryIntent;
  authorityBasis: AuthorityBasis;
  controller: DeliveryController;
  logicalRequestId: string;
  mergeRequestIid: number | null;
  binding: DeliveryTargetBindingV1;
}

export interface DeliveryRequestV1 extends DeliveryRequestInputV1 {
  schemaVersion: 1;
  kind: "docsfab-delivery-request";
  requestSha256: string;
}

export interface DeliveryKeyV1 {
  schemaVersion: 1;
  kind: "docsfab-delivery-key";
  keySha256: string;
  intent: DeliveryIntent;
  logicalRequestId: string;
}

export interface DeliveryLedgerEntryV1 {
  schemaVersion: 1;
  kind: "docsfab-delivery-key-ledger-entry";
  deliveryKeySha256: string;
  requestSha256: string;
  intent: DeliveryIntent;
  claimedAt: string;
  entrySha256: string;
}

export interface DeliveryKeyClaimV1 {
  created: boolean;
  entry: DeliveryLedgerEntryV1;
}

const COMBINATION_KEY = (row: DeliveryCombinationV1): string =>
  `${row.intent}\0${row.authorityBasis}\0${row.controller}`;

const SUPPORTED_KEYS = new Set(SUPPORTED_DELIVERY_COMBINATIONS.map(COMBINATION_KEY));

export function deliveryCombinationStatus(
  intent: DeliveryIntent,
  authorityBasis: AuthorityBasis,
  controller: DeliveryController,
): DeliveryCombinationStatus {
  if (intent === "update-existing-mr") return "reserved";
  return SUPPORTED_KEYS.has(COMBINATION_KEY({ intent, authorityBasis, controller }))
    ? "supported"
    : "denied";
}

export function assertAllowedDeliveryCombination(
  intent: DeliveryIntent,
  authorityBasis: AuthorityBasis,
  controller: DeliveryController,
): void {
  const status = deliveryCombinationStatus(intent, authorityBasis, controller);
  if (status === "reserved") failDeliveryAuthority("reserved-combination");
  if (status !== "supported") failDeliveryAuthority("unsupported-combination");
}

export function assertExcludedDeliveryPowerDenied(power: string): never {
  failDeliveryAuthority(
    (EXCLUDED_DELIVERY_POWERS as readonly string[]).includes(power)
      ? "excluded-power"
      : "unsupported-combination",
  );
}

export function createDeliveryRequest(input: DeliveryRequestInputV1): DeliveryRequestV1 {
  kit.assertInert(input);
  kit.rejectCredentials(input);
  return kit.seal("docsfab-delivery-request", "requestSha256", normalizeRequestInput(input));
}

export function decodeDeliveryRequest(value: unknown): DeliveryRequestV1 {
  return kit.decodeSealed(
    value,
    "docsfab-delivery-request",
    "requestSha256",
    [
      "trigger",
      "intent",
      "authorityBasis",
      "controller",
      "logicalRequestId",
      "mergeRequestIid",
      "binding",
    ],
    (root) => normalizeRequestInput(root as unknown as DeliveryRequestInputV1),
  );
}

export function deliveryKeyForRequest(request: DeliveryRequestV1): DeliveryKeyV1 {
  const current = decodeDeliveryRequest(request);
  const identity =
    current.intent === "comment-existing-mr"
      ? {
          host: current.binding.host,
          projectId: current.binding.projectId,
          mergeRequestIid: current.mergeRequestIid,
          logicalRequestId: current.logicalRequestId,
          intent: current.intent,
        }
      : {
          host: current.binding.host,
          projectId: current.binding.projectId,
          repository: current.binding.repository,
          baseRevision: current.binding.baseRevision,
          headRevision: current.binding.headRevision,
          patchDigestSha256: current.binding.patchDigestSha256,
          allowedPaths: current.binding.allowedPaths,
          ...(current.binding.candidate ? { candidate: current.binding.candidate } : {}),
          logicalRequestId: current.logicalRequestId,
          intent: current.intent,
        };
  return kit.deepFreeze({
    schemaVersion: 1 as const,
    kind: "docsfab-delivery-key" as const,
    keySha256: kit.canonicalDigest(identity),
    intent: current.intent,
    logicalRequestId: current.logicalRequestId,
  });
}

export function createDeliveryLedgerEntry(input: {
  request: DeliveryRequestV1;
  claimedAt: string;
}): DeliveryLedgerEntryV1 {
  const request = decodeDeliveryRequest(input.request);
  const key = deliveryKeyForRequest(request);
  return kit.seal("docsfab-delivery-key-ledger-entry", "entrySha256", {
    deliveryKeySha256: key.keySha256,
    requestSha256: request.requestSha256,
    intent: request.intent,
    claimedAt: kit.timestamp(input.claimedAt),
  });
}

export function decodeDeliveryLedgerEntry(value: unknown): DeliveryLedgerEntryV1 {
  return kit.decodeSealed(
    value,
    "docsfab-delivery-key-ledger-entry",
    "entrySha256",
    ["deliveryKeySha256", "requestSha256", "intent", "claimedAt"],
    (root) => ({
      deliveryKeySha256: kit.hash(root.deliveryKeySha256),
      requestSha256: kit.hash(root.requestSha256),
      intent: kit.enumeration(root.intent, DELIVERY_INTENTS),
      claimedAt: kit.timestamp(root.claimedAt),
    }),
  );
}

/** Durable keyed ledger. Entries are serializable; object identity is not authority. */
export class DeliveryKeyLedger {
  private readonly entries = new Map<string, DeliveryLedgerEntryV1>();

  public claim(request: DeliveryRequestV1, claimedAt: string): DeliveryKeyClaimV1 {
    const entry = createDeliveryLedgerEntry({ request, claimedAt });
    const existing = this.entries.get(entry.deliveryKeySha256);
    if (!existing) {
      this.entries.set(entry.deliveryKeySha256, entry);
      return { created: true, entry };
    }
    if (existing.requestSha256 !== entry.requestSha256) {
      failDeliveryAuthority("delivery-conflict");
    }
    return { created: false, entry: existing };
  }

  public get(deliveryKeySha256: string): DeliveryLedgerEntryV1 | undefined {
    return this.entries.get(kit.hash(deliveryKeySha256));
  }

  public exportEntries(): DeliveryLedgerEntryV1[] {
    return [...this.entries.values()];
  }

  public static import(values: unknown[]): DeliveryKeyLedger {
    kit.assertInert(values);
    const ledger = new DeliveryKeyLedger();
    for (const value of kit.array(values)) {
      const entry = decodeDeliveryLedgerEntry(value);
      const existing = ledger.entries.get(entry.deliveryKeySha256);
      if (existing && existing.entrySha256 !== entry.entrySha256) {
        failDeliveryAuthority("delivery-conflict");
      }
      ledger.entries.set(entry.deliveryKeySha256, entry);
    }
    return ledger;
  }
}

function normalizeRequestInput(input: DeliveryRequestInputV1): DeliveryRequestInputV1 {
  const root = kit.object(input);
  kit.exact(root, [
    "trigger",
    "intent",
    "authorityBasis",
    "controller",
    "logicalRequestId",
    "mergeRequestIid",
    "binding",
  ]);
  const intent = kit.enumeration(root.intent, DELIVERY_INTENTS);
  const authorityBasis = kit.enumeration(root.authorityBasis, AUTHORITY_BASES);
  const controller = kit.enumeration(root.controller, DELIVERY_CONTROLLERS);
  assertAllowedDeliveryCombination(intent, authorityBasis, controller);
  const mergeRequestIid = nullablePositiveInteger(root.mergeRequestIid);
  if ((intent === "comment-existing-mr") !== (mergeRequestIid !== null)) {
    failDeliveryAuthority("invalid-value");
  }
  const binding = normalizeBinding(root.binding);
  if (intent === "create-draft-mr") {
    if (binding.protection.sourceProtected || binding.protection.sourceIsDefault) {
      failDeliveryAuthority("excluded-power");
    }
    if (binding.grant.tier !== "contribute") failDeliveryAuthority("insufficient-grant");
  }
  if (
    intent === "comment-existing-mr" &&
    binding.grant.tier !== "review" &&
    binding.grant.tier !== "contribute"
  ) {
    failDeliveryAuthority("insufficient-grant");
  }
  if (intent === "artifact-only" && authorityBasis !== "none") {
    failDeliveryAuthority("unsupported-combination");
  }
  return {
    trigger: kit.enumeration(root.trigger, DELIVERY_TRIGGERS),
    intent,
    authorityBasis,
    controller,
    logicalRequestId: kit.identifier(root.logicalRequestId),
    mergeRequestIid,
    binding,
  };
}

function normalizeBinding(value: unknown): DeliveryTargetBindingV1 {
  const root = kit.object(value);
  kit.exact(
    root,
    [
      "host",
      "projectId",
      "repository",
      "baseRevision",
      "headRevision",
      "patchDigestSha256",
      "allowedPaths",
      "candidate",
      "protection",
      "grant",
    ],
    ["candidate"],
  );
  const protectionRoot = kit.object(root.protection);
  kit.exact(protectionRoot, [
    "defaultBranch",
    "sourceBranch",
    "sourceProtected",
    "targetProtected",
    "sourceIsDefault",
  ]);
  const grantRoot = kit.object(root.grant);
  kit.exact(grantRoot, ["version", "tier", "updateExistingMrEnabled"]);
  const allowedPaths = kit.array(root.allowedPaths).map(relativePath).sort(kit.compare);
  kit.unique(allowedPaths);
  if (allowedPaths.length === 0) failDeliveryAuthority("invalid-value");
  const sourceBranch = kit.identifier(protectionRoot.sourceBranch);
  const defaultBranch = kit.identifier(protectionRoot.defaultBranch);
  const sourceIsDefault = booleanValue(protectionRoot.sourceIsDefault);
  if (sourceIsDefault !== (sourceBranch === defaultBranch)) failDeliveryAuthority("invalid-value");
  const candidateRoot = root.candidate === undefined ? undefined : kit.object(root.candidate);
  if (candidateRoot) {
    kit.exact(candidateRoot, ["treeObjectId", "targetManifestSha256", "eligibilityReceiptSha256"]);
  }
  return {
    host: kit.identifier(root.host),
    projectId: positiveInteger(root.projectId),
    repository: kit.identifier(root.repository),
    baseRevision: kit.revision(root.baseRevision),
    headRevision: kit.revision(root.headRevision),
    patchDigestSha256: kit.hash(root.patchDigestSha256),
    allowedPaths,
    ...(candidateRoot
      ? {
          candidate: {
            treeObjectId: kit.revision(candidateRoot.treeObjectId),
            targetManifestSha256: kit.hash(candidateRoot.targetManifestSha256),
            eligibilityReceiptSha256: kit.hash(candidateRoot.eligibilityReceiptSha256),
          },
        }
      : {}),
    protection: {
      defaultBranch,
      sourceBranch,
      sourceProtected: booleanValue(protectionRoot.sourceProtected),
      targetProtected: booleanValue(protectionRoot.targetProtected),
      sourceIsDefault,
    },
    grant: {
      version: positiveInteger(grantRoot.version),
      tier: kit.enumeration(grantRoot.tier, [
        "discover",
        "observe",
        "review",
        "contribute",
      ] as const),
      updateExistingMrEnabled: booleanValue(grantRoot.updateExistingMrEnabled),
    },
  };
}

function relativePath(value: unknown): string {
  const result = kit.string(value);
  if (result === ".") return result;
  if (
    result.length > 512 ||
    result.startsWith("/") ||
    result.includes("\\") ||
    result.includes("//") ||
    result.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    failDeliveryAuthority("invalid-value");
  }
  return result;
}

function positiveInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    failDeliveryAuthority("invalid-value");
  }
  return value;
}

function nullablePositiveInteger(value: unknown): number | null {
  return value === null ? null : positiveInteger(value);
}

function booleanValue(value: unknown): boolean {
  if (typeof value !== "boolean") failDeliveryAuthority("invalid-value");
  return value;
}
