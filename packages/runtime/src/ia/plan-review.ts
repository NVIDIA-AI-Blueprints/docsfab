// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  createPublicKey,
  sign as signBytes,
  verify as verifyBytes,
  type KeyObject,
} from "node:crypto";

import {
  ArtifactValidationError,
  createArtifact,
  evaluatePlanState,
  validateArtifact,
  validateArtifactReference,
  type ArtifactReference,
  type IaPlanArtifact,
  type IaScope,
} from "../artifacts/index.js";
import { canonicalDigest, type ContentIndexV1 } from "../content-ir/index.js";
import { deepFreeze } from "../contract-kit/freeze.js";

const REVIEW_DECISIONS = ["approved", "changes-requested", "rejected"] as const;
export type IaPlanReviewDecision = (typeof REVIEW_DECISIONS)[number];
export type IaPlanReviewerRole = "maintainer" | "product-owner";

export interface IaPlanReviewerPolicyValue {
  id: string;
  version: string;
  reviewers: Array<{
    id: string;
    role: IaPlanReviewerRole;
    /** Trusted Ed25519 SPKI public key in PEM form. */
    publicKey: string;
  }>;
}

export interface IaPlanReviewerPolicy extends IaPlanReviewerPolicyValue {
  digest: string;
}

declare const iaPlanReviewerAuthorizationBrand: unique symbol;

/** Opaque signing authority created only after matching a trusted reviewer policy. */
export interface IaPlanReviewerAuthorization {
  readonly [iaPlanReviewerAuthorizationBrand]: true;
}

interface ReviewerAuthorizationState {
  reviewer: IaPlanReviewerPolicy["reviewers"][number];
  policy: IaPlanReviewerPolicy;
  privateKey: KeyObject;
  now: () => Date;
}

const reviewerAuthorizations = new WeakMap<
  IaPlanReviewerAuthorization,
  ReviewerAuthorizationState
>();

export interface IaPlanReviewReference {
  kind: "ia-plan-review";
  schemaVersion: 1;
  digest: string;
  repositoryRevision: string;
  repositoryContentDigest: string;
}

export interface IaPlanReviewArtifact {
  schemaVersion: 1;
  kind: "ia-plan-review";
  repository: { revision: string; contentDigest: string };
  /** Reviewable immutable input plan. */
  predecessorPlan: ArtifactReference<"ia-plan">;
  /** Immutable successor; only an approved successor is apply-eligible. */
  plan: ArtifactReference<"ia-plan">;
  scope: IaScope;
  targetNodeId?: string;
  decision: IaPlanReviewDecision;
  reviewer: { id: string; role: IaPlanReviewerRole };
  policy: { id: string; version: string; digest: string };
  decidedAt: string;
  expiresAt: string;
  predecessor?: IaPlanReviewReference;
  reason?: string;
  signature: string;
  digest: string;
}

export interface IaPlanReviewTransition {
  review: IaPlanReviewArtifact;
  plan: IaPlanArtifact;
}

export type IaPlanReviewErrorCode =
  | "invalid-policy"
  | "invalid-authority"
  | "invalid-plan"
  | "stale-plan"
  | "expired-plan"
  | "insufficient-role"
  | "invalid-review"
  | "invalid-transition"
  | "review-expired"
  | "signature-mismatch";

export class IaPlanReviewError extends Error {
  public constructor(public readonly code: IaPlanReviewErrorCode) {
    super(`IA plan review rejected: ${code}.`);
    this.name = "IaPlanReviewError";
  }
}

export function iaPlanReviewerPolicyDigest(value: IaPlanReviewerPolicyValue): string {
  return canonicalDigest(normalizePolicyValue(value));
}

/** Validate and canonicalize a host-trusted reviewer policy loaded from durable state. */
export function validateIaPlanReviewerPolicy(value: unknown): IaPlanReviewerPolicy {
  return validatePolicy(value as IaPlanReviewerPolicy);
}

/**
 * Matches one Ed25519 private key to an explicit reviewer in a closed,
 * content-addressed host policy. The key and clock remain outside artifacts.
 */
export function prepareIaPlanReviewerAuthorization(input: {
  policy: IaPlanReviewerPolicy;
  reviewerId: string;
  privateKey: KeyObject;
  now?: () => Date;
}): IaPlanReviewerAuthorization {
  const policy = validatePolicy(input.policy);
  const reviewer = policy.reviewers.find((entry) => entry.id === input.reviewerId);
  if (
    !reviewer ||
    input.privateKey.type !== "private" ||
    input.privateKey.asymmetricKeyType !== "ed25519"
  ) {
    fail("invalid-authority");
  }
  let suppliedPublicKey: string;
  try {
    suppliedPublicKey = exportPublicKey(createPublicKey(input.privateKey));
  } catch {
    fail("invalid-authority");
  }
  if (suppliedPublicKey !== reviewer.publicKey) fail("invalid-authority");
  const authorization = Object.freeze({}) as IaPlanReviewerAuthorization;
  reviewerAuthorizations.set(authorization, {
    reviewer,
    policy,
    privateKey: input.privateKey,
    now: input.now ?? (() => new Date()),
  });
  return authorization;
}

/** Create a signed immutable successor decision for one current IA plan. */
export function reviewIaPlan(input: {
  index: ContentIndexV1;
  plan: IaPlanArtifact;
  authorization: IaPlanReviewerAuthorization;
  decision: IaPlanReviewDecision;
  reason?: string;
  predecessor?: IaPlanReviewArtifact;
  /** Exact changes-requested successor named by predecessor review evidence. */
  reviewedPlan?: IaPlanArtifact;
  activePlan?: IaPlanArtifact;
}): IaPlanReviewTransition {
  const authority = reviewerAuthorizations.get(input.authorization);
  if (!authority) fail("invalid-authority");
  const now = validNow(authority.now());
  const predecessorPlan = reviewablePlan(input.plan, input.index, now, input.activePlan);
  requireRole(authority.reviewer.role, predecessorPlan.payload.approval.requirement);
  if (!REVIEW_DECISIONS.includes(input.decision)) fail("invalid-review");
  const reason = reviewReason(input.decision, input.reason);
  const predecessor = input.predecessor
    ? validateIaPlanReviewArtifact(input.predecessor, authority.policy)
    : undefined;
  validateTransition(predecessor, input.reviewedPlan, predecessorPlan, input.index, now);
  if (
    input.decision === "approved" &&
    (predecessorPlan.payload.openDecisions.length > 0 ||
      predecessorPlan.payload.migrationDispositions?.some(
        (entry) => entry.disposition === "needs-human-decision",
      ) === true)
  )
    fail("invalid-transition");

  const approval =
    input.decision === "approved"
      ? {
          requirement: predecessorPlan.payload.approval.requirement,
          status: "approved" as const,
          approvedBy: authority.reviewer.id,
          approvedAt: now.toISOString(),
        }
      : {
          requirement: predecessorPlan.payload.approval.requirement,
          status: input.decision,
        };
  const successorPlan = createArtifact(
    "ia-plan",
    {
      ...structuredClone(predecessorPlan.payload),
      approval,
      supersedes: planReference(predecessorPlan),
    },
    {
      index: input.index,
      now,
      ...(input.decision === "approved" ? {} : { planAcceptance: "any" as const }),
    },
  );

  const statement = {
    schemaVersion: 1 as const,
    kind: "ia-plan-review" as const,
    repository: { ...successorPlan.repository },
    predecessorPlan: planReference(predecessorPlan),
    plan: planReference(successorPlan),
    scope: successorPlan.payload.scope,
    ...(successorPlan.payload.targetNodeId
      ? { targetNodeId: successorPlan.payload.targetNodeId }
      : {}),
    decision: input.decision,
    reviewer: { id: authority.reviewer.id, role: authority.reviewer.role },
    policy: {
      id: authority.policy.id,
      version: authority.policy.version,
      digest: authority.policy.digest,
    },
    decidedAt: now.toISOString(),
    expiresAt: successorPlan.payload.expiresAt,
    ...(predecessor ? { predecessor: reviewReference(predecessor) } : {}),
    ...(reason ? { reason } : {}),
  };
  const signature = signBytes(
    null,
    Buffer.from(canonicalDigest(statement), "hex"),
    authority.privateKey,
  ).toString("base64url");
  const artifact = {
    ...statement,
    signature,
    digest: canonicalDigest({ ...statement, signature }),
  };
  return deepFreeze({ review: artifact, plan: successorPlan });
}

/** Validate closed content, policy binding, digest, and reviewer signature. */
export function validateIaPlanReviewArtifact(
  value: unknown,
  policyValue: IaPlanReviewerPolicy,
): IaPlanReviewArtifact {
  const policy = validatePolicy(policyValue);
  const root = closed(
    value,
    [
      "schemaVersion",
      "kind",
      "repository",
      "predecessorPlan",
      "plan",
      "scope",
      "targetNodeId",
      "decision",
      "reviewer",
      "policy",
      "decidedAt",
      "expiresAt",
      "predecessor",
      "reason",
      "signature",
      "digest",
    ],
    [
      "schemaVersion",
      "kind",
      "repository",
      "predecessorPlan",
      "plan",
      "scope",
      "decision",
      "reviewer",
      "policy",
      "decidedAt",
      "expiresAt",
      "signature",
      "digest",
    ],
  );
  if (root.schemaVersion !== 1 || root.kind !== "ia-plan-review") fail("invalid-review");
  const repository = repositoryIdentity(root.repository);
  let predecessorPlan: ArtifactReference<"ia-plan">;
  let plan: ArtifactReference<"ia-plan">;
  try {
    predecessorPlan = validateArtifactReference(root.predecessorPlan, {
      expectedKind: "ia-plan",
    }) as ArtifactReference<"ia-plan">;
    plan = validateArtifactReference(root.plan, {
      expectedKind: "ia-plan",
    }) as ArtifactReference<"ia-plan">;
  } catch {
    fail("invalid-review");
  }
  if (
    predecessorPlan.repositoryRevision !== repository.revision ||
    predecessorPlan.repositoryContentDigest !== repository.contentDigest ||
    plan.repositoryRevision !== repository.revision ||
    plan.repositoryContentDigest !== repository.contentDigest
  )
    fail("invalid-review");
  if (samePlanReference(predecessorPlan, plan)) fail("invalid-review");
  const scope = enumeration(root.scope, ["site", "section", "page"] as const);
  const targetNodeId = root.targetNodeId === undefined ? undefined : identifier(root.targetNodeId);
  if ((scope === "site") === (targetNodeId !== undefined)) fail("invalid-review");
  const decision = enumeration(root.decision, REVIEW_DECISIONS);
  const reviewerRoot = closed(root.reviewer, ["id", "role"]);
  const reviewer = {
    id: identifier(reviewerRoot.id),
    role: enumeration(reviewerRoot.role, ["maintainer", "product-owner"] as const),
  };
  const authorizedReviewer = policy.reviewers.find(
    (entry) => entry.id === reviewer.id && entry.role === reviewer.role,
  );
  if (!authorizedReviewer) fail("invalid-authority");
  const policyRoot = closed(root.policy, ["id", "version", "digest"]);
  if (
    policyRoot.id !== policy.id ||
    policyRoot.version !== policy.version ||
    policyRoot.digest !== policy.digest
  )
    fail("invalid-policy");
  const decidedAt = timestamp(root.decidedAt);
  const expiresAt = timestamp(root.expiresAt);
  if (decidedAt >= expiresAt) fail("invalid-review");
  const predecessor =
    root.predecessor === undefined ? undefined : parseReviewReference(root.predecessor, repository);
  const reason = reviewReason(
    decision,
    root.reason === undefined ? undefined : reviewText(root.reason),
  );
  const signature = signatureText(root.signature);
  const digest = digestText(root.digest);
  const statement = {
    schemaVersion: 1 as const,
    kind: "ia-plan-review" as const,
    repository,
    predecessorPlan,
    plan,
    scope,
    ...(targetNodeId ? { targetNodeId } : {}),
    decision,
    reviewer,
    policy: { id: policy.id, version: policy.version, digest: policy.digest },
    decidedAt,
    expiresAt,
    ...(predecessor ? { predecessor } : {}),
    ...(reason ? { reason } : {}),
  };
  if (canonicalDigest({ ...statement, signature }) !== digest) fail("invalid-review");
  let signatureValid = false;
  try {
    signatureValid = verifyBytes(
      null,
      Buffer.from(canonicalDigest(statement), "hex"),
      authorizedReviewer.publicKey,
      Buffer.from(signature, "base64url"),
    );
  } catch {
    fail("signature-mismatch");
  }
  if (!signatureValid) fail("signature-mismatch");
  return deepFreeze({ ...statement, signature, digest });
}

/** Revalidate the durable approval against the current plan and repository. */
export function assertIaPlanReviewApproved(input: {
  index: ContentIndexV1;
  plan: IaPlanArtifact;
  review: IaPlanReviewArtifact;
  policy: IaPlanReviewerPolicy;
  now?: Date;
  activePlan?: IaPlanArtifact;
}): IaPlanReviewArtifact {
  const now = validNow(input.now ?? new Date());
  const plan = activePlan(input.plan, input.index, now, input.activePlan);
  const review = validateIaPlanReviewArtifact(input.review, input.policy);
  if (review.decision !== "approved") fail("invalid-transition");
  if (review.expiresAt <= now.toISOString()) fail("review-expired");
  if (!samePlanReference(review.plan, planReference(plan))) fail("stale-plan");
  if (
    !plan.payload.supersedes ||
    !samePlanReference(review.predecessorPlan, plan.payload.supersedes)
  ) {
    fail("invalid-transition");
  }
  requireRole(review.reviewer.role, plan.payload.approval.requirement);
  return review;
}

function activePlan(
  value: IaPlanArtifact,
  index: ContentIndexV1,
  now: Date,
  replacement?: IaPlanArtifact,
): IaPlanArtifact {
  try {
    const artifact = validateArtifact(value, {
      index,
      now,
      ...(replacement ? { activePlan: replacement } : {}),
    });
    if (artifact.kind !== "ia-plan") fail("invalid-plan");
    return artifact;
  } catch (error) {
    if (error instanceof IaPlanReviewError) throw error;
    if (error instanceof ArtifactValidationError) {
      if (error.code === "plan-expired") fail("expired-plan");
      if (error.code === "plan-superseded" || error.code === "repository-mismatch") {
        fail("stale-plan");
      }
    }
    fail("invalid-plan");
  }
}

function reviewablePlan(
  value: IaPlanArtifact,
  index: ContentIndexV1,
  now: Date,
  replacement?: IaPlanArtifact,
): IaPlanArtifact {
  let plan: IaPlanArtifact;
  try {
    const artifact = validateArtifact(value, {
      index,
      now,
      planAcceptance: "any",
      ...(replacement ? { activePlan: replacement } : {}),
    });
    if (artifact.kind !== "ia-plan") fail("invalid-plan");
    plan = artifact;
  } catch (error) {
    if (error instanceof IaPlanReviewError) throw error;
    if (error instanceof ArtifactValidationError && error.code === "repository-mismatch") {
      fail("stale-plan");
    }
    fail("invalid-plan");
  }
  if (plan.payload.expiresAt <= now.toISOString()) fail("expired-plan");
  if (replacement && explicitlySupersedes(replacement, plan)) fail("stale-plan");
  const state = evaluatePlanState(plan, { index, now });
  if (state !== "unapproved" && state !== "changes-requested") {
    fail("invalid-transition");
  }
  return plan;
}

function validateTransition(
  predecessor: IaPlanReviewArtifact | undefined,
  reviewedPlanValue: IaPlanArtifact | undefined,
  plan: IaPlanArtifact,
  index: ContentIndexV1,
  now: Date,
): void {
  if (!plan.payload.supersedes) {
    if (plan.payload.approval.status !== "pending" || predecessor || reviewedPlanValue) {
      fail("invalid-transition");
    }
    return;
  }
  if (!predecessor || !reviewedPlanValue) fail("invalid-transition");
  if (predecessor.expiresAt <= now.toISOString()) fail("review-expired");
  const reviewedPlan = reviewablePlan(reviewedPlanValue, index, now);
  if (
    predecessor.decision !== "changes-requested" ||
    reviewedPlan.payload.approval.status !== "changes-requested" ||
    plan.payload.approval.status !== "pending" ||
    !samePlanReference(predecessor.plan, planReference(reviewedPlan)) ||
    !samePlanReference(plan.payload.supersedes, planReference(reviewedPlan)) ||
    plan.payload.scope !== predecessor.scope ||
    plan.payload.targetNodeId !== predecessor.targetNodeId ||
    reviewedPlan.payload.scope !== predecessor.scope ||
    reviewedPlan.payload.targetNodeId !== predecessor.targetNodeId ||
    substantivePlanDigest(plan) === substantivePlanDigest(reviewedPlan)
  ) {
    fail("invalid-transition");
  }
}

/** Excludes revision-control metadata that cannot satisfy requested plan changes. */
function substantivePlanDigest(plan: IaPlanArtifact): string {
  const payload = structuredClone(plan.payload) as unknown as Record<string, unknown>;
  delete payload.planId;
  delete payload.approval;
  delete payload.expiresAt;
  delete payload.supersedes;
  return canonicalDigest(payload);
}

function explicitlySupersedes(replacement: IaPlanArtifact, plan: IaPlanArtifact): boolean {
  return (
    replacement.payload.scope === plan.payload.scope &&
    replacement.payload.targetNodeId === plan.payload.targetNodeId &&
    replacement.payload.supersedes !== undefined &&
    samePlanReference(replacement.payload.supersedes, planReference(plan))
  );
}

function requireRole(
  actual: IaPlanReviewerRole,
  requirement: "none" | "maintainer" | "product-owner",
): void {
  if (requirement === "none") fail("insufficient-role");
  const required = requirement;
  if (actual !== required && !(actual === "product-owner" && required === "maintainer")) {
    fail("insufficient-role");
  }
}

function reviewReason(
  decision: IaPlanReviewDecision,
  reason: string | undefined,
): string | undefined {
  if (decision === "approved") {
    if (reason !== undefined) fail("invalid-review");
    return undefined;
  }
  if (reason === undefined) fail("invalid-review");
  return reviewText(reason);
}

function reviewText(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    !value ||
    value.length > 1_000 ||
    value.includes("\0") ||
    /[\r\n]/u.test(value)
  ) {
    fail("invalid-review");
  }
  return value;
}

function validatePolicy(value: IaPlanReviewerPolicy): IaPlanReviewerPolicy {
  const root = closed(value, ["id", "version", "digest", "reviewers"]);
  const policyValue = normalizePolicyValue({
    id: identifier(root.id),
    version: identifier(root.version),
    reviewers: array(root.reviewers).map((entry) => {
      const reviewer = closed(entry, ["id", "role", "publicKey"]);
      const publicKey = publicKeyText(reviewer.publicKey);
      return {
        id: identifier(reviewer.id),
        role: enumeration(reviewer.role, ["maintainer", "product-owner"] as const),
        publicKey,
      };
    }),
  });
  if (
    policyValue.reviewers.length === 0 ||
    new Set(policyValue.reviewers.map((entry) => entry.id)).size !== policyValue.reviewers.length
  )
    fail("invalid-policy");
  const digest = digestText(root.digest);
  if (canonicalDigest(policyValue) !== digest) fail("invalid-policy");
  return deepFreeze({ ...policyValue, digest });
}

function normalizePolicyValue(value: IaPlanReviewerPolicyValue): IaPlanReviewerPolicyValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid-policy");
  return {
    id: identifier(value.id),
    version: identifier(value.version),
    reviewers: [...value.reviewers]
      .map((reviewer) => ({
        id: identifier(reviewer.id),
        role: enumeration(reviewer.role, ["maintainer", "product-owner"] as const),
        publicKey: publicKeyText(reviewer.publicKey),
      }))
      .sort((left, right) => compare(left.id, right.id)),
  };
}

function publicKeyText(value: unknown): string {
  if (typeof value !== "string") fail("invalid-policy");
  let key: KeyObject;
  try {
    key = createPublicKey(value);
  } catch {
    fail("invalid-policy");
  }
  if (key.asymmetricKeyType !== "ed25519") fail("invalid-policy");
  return exportPublicKey(key);
}

function exportPublicKey(key: KeyObject): string {
  return key.export({ type: "spki", format: "pem" }).toString();
}

function planReference(plan: IaPlanArtifact): ArtifactReference<"ia-plan"> {
  return {
    kind: "ia-plan",
    schemaVersion: 1,
    digest: plan.digest,
    repositoryRevision: plan.repository.revision,
    repositoryContentDigest: plan.repository.contentDigest,
  };
}

function reviewReference(review: IaPlanReviewArtifact): IaPlanReviewReference {
  return {
    kind: "ia-plan-review",
    schemaVersion: 1,
    digest: review.digest,
    repositoryRevision: review.repository.revision,
    repositoryContentDigest: review.repository.contentDigest,
  };
}

function parseReviewReference(
  value: unknown,
  repository: IaPlanReviewArtifact["repository"],
): IaPlanReviewReference {
  const root = closed(value, [
    "kind",
    "schemaVersion",
    "digest",
    "repositoryRevision",
    "repositoryContentDigest",
  ]);
  if (
    root.kind !== "ia-plan-review" ||
    root.schemaVersion !== 1 ||
    root.repositoryRevision !== repository.revision ||
    root.repositoryContentDigest !== repository.contentDigest
  )
    fail("invalid-review");
  return {
    kind: "ia-plan-review",
    schemaVersion: 1,
    digest: digestText(root.digest),
    repositoryRevision: repository.revision,
    repositoryContentDigest: repository.contentDigest,
  };
}

function repositoryIdentity(value: unknown): IaPlanReviewArtifact["repository"] {
  const root = closed(value, ["revision", "contentDigest"]);
  if (typeof root.revision !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(root.revision))
    fail("invalid-review");
  return { revision: root.revision, contentDigest: digestText(root.contentDigest) };
}

function samePlanReference(
  left: ArtifactReference<"ia-plan">,
  right: ArtifactReference<"ia-plan">,
): boolean {
  return (
    left.kind === right.kind &&
    left.schemaVersion === right.schemaVersion &&
    left.digest === right.digest &&
    left.repositoryRevision === right.repositoryRevision &&
    left.repositoryContentDigest === right.repositoryContentDigest
  );
}

function validNow(value: Date): Date {
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) fail("invalid-review");
  return new Date(value.valueOf());
}

function timestamp(value: unknown): string {
  if (typeof value !== "string") fail("invalid-review");
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) fail("invalid-review");
  return value;
}

function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value)) {
    fail("invalid-review");
  }
  return value;
}

function signatureText(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{80,128}$/u.test(value)) {
    fail("invalid-review");
  }
  return value;
}

function digestText(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) fail("invalid-review");
  return value;
}

function enumeration<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== "string" || !values.includes(value as T)) fail("invalid-review");
  return value as T;
}

function closed(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[] = allowed,
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    fail("invalid-review");
  const root = value as Record<string, unknown>;
  if (
    Object.keys(root).some((key) => !allowed.includes(key)) ||
    required.some((key) => !Object.hasOwn(root, key))
  )
    fail("invalid-review");
  return root;
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) fail("invalid-review");
  return value;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fail(code: IaPlanReviewErrorCode): never {
  throw new IaPlanReviewError(code);
}
