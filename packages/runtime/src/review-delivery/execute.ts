// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";

import { canonicalJson, sha256 } from "../content-ir/canonical.js";
import { canonicalizeJsonEvidence, type JsonEvidenceValue } from "../json-evidence.js";
import { reviewTargetKeyV2, type ReviewTargetV2 } from "../review/contracts.js";
import type { ScmDeliveryReceiptStore } from "../delivery/receipt-store.js";
import type {
  ReviewDeliveryAction,
  ReviewDeliveryActionBinding,
  ReviewDeliveryActor,
  ReviewDeliveryGrant,
  ReviewDeliveryPlan,
} from "./contracts.js";
import { admitReviewDeliveryAction } from "./plan.js";
import {
  admitReviewDeliveryCustody,
  admitReviewDeliveryCorrelation,
  loadReviewDeliveryFencedSource,
  type ReviewDeliveryCustodyAdmission,
  type ReviewDeliveryOriginAdmission,
  type ReviewDeliveryCorrelationAdmission,
} from "./custody.js";
import {
  createReviewDeliveryManifest,
  createReviewDeliveryLegacyEmptyManifest,
  createReviewDeliveryRecord,
  reviewDeliveryImportedLineageMatches,
  updateReviewDeliveryRecord,
  type ReviewDeliveryCommittedEffectV1,
  type ReviewDeliveryEffectContextV1,
  type ReviewDeliveryEffectReceiptV1,
  type ReviewDeliveryRecordV1,
  type ReviewDeliveryStopV1,
} from "./receipt.js";

export type { ReviewDeliveryEffectContextV1 } from "./receipt.js";

export interface ReviewDeliveryGitLabTextPosition {
  readonly baseSha: string;
  readonly startSha: string;
  readonly headSha: string;
  readonly positionType: "text";
  readonly oldPath: string;
  readonly newPath: string;
  readonly oldLine: number | null;
  readonly newLine: number | null;
  readonly lineRange: null | {
    readonly start: {
      readonly type: "old" | "new";
      readonly lineCode: string;
      readonly oldLine: number | null;
      readonly newLine: number | null;
    };
    readonly end: {
      readonly type: "old" | "new";
      readonly lineCode: string;
      readonly oldLine: number | null;
      readonly newLine: number | null;
    };
  };
}

export interface ReviewDeliveryPreparedEffect {
  readonly kind: "effect";
  readonly effectId: string;
  readonly coveredActionIds: readonly string[];
  readonly actionPayloads: readonly {
    readonly actionId: string;
    readonly bodySha256: string;
    readonly anchorSha256: string | null;
  }[];
  readonly stage: ReviewDeliveryCommittedEffectV1["stage"];
  readonly request: {
    readonly method: "POST";
    readonly path: string;
    readonly bodyBytes: Uint8Array;
  };
  readonly outboundBytesSha256: string;
  readonly expectedBodySha256: string;
  readonly expectedGitLabPosition: ReviewDeliveryGitLabTextPosition | null;
  readonly marker: string;
  readonly revisionProvenance:
    | {
        readonly kind: "gitlab-summary-retained";
        readonly intendedHeadSha: string;
        readonly freshTargetObservationSha256: string;
        readonly serverAtomicFence: false;
      }
    | {
        readonly kind: "gitlab-diff-position";
        readonly baseSha: string;
        readonly startSha: string;
        readonly headSha: string;
      }
    | { readonly kind: "github-review-commit"; readonly commitId: string };
  /** Transient candidate accounting; never part of the V1 committed effect. */
  readonly overviewPresentation?: ReviewDeliveryOverviewPresentation;
}

/** Counts of retained material omitted from a compact native overview. */
export interface OverviewRemainingV1 {
  readonly findingsTotal: number;
  readonly summarySelectedFindings: number;
  readonly nativeInlineFindings: number;
  readonly retainedUnpostedFindings: number;
  readonly unsupportedUnpostedFindings: number;
  readonly findingLimitations: number;
  readonly checks: number;
  readonly unansweredQuestions: number;
  readonly reviewScopePresent: 0 | 1;
  readonly anchorPaths: number;
  readonly deferredPaths: number;
  readonly continuationLocatorPresent: 0 | 1;
  readonly templateReportPresent: 0 | 1;
  readonly templatePages: number;
  readonly templateRules: number;
  readonly templateSuggestionIds: number;
  readonly affectedPaths: number;
  readonly skippedPaths: number;
  readonly planLimitations: number;
  readonly hostedReportCandidatePresent: 0 | 1;
}

/** Opaque sealed identifiers for local inspection, never paths or URLs. */
export interface RetainedIdentityV1 {
  readonly resultSha256: string;
  readonly sourceSha256: string;
  readonly snapshotSha256: string;
  readonly runIdSha256: string;
  readonly actionSetSha256: string;
}

export interface ReviewDeliveryOverviewPresentation {
  readonly kind: "full" | "compact-partial" | "historical-legacy";
  readonly remaining: OverviewRemainingV1;
  readonly retained: RetainedIdentityV1;
}

export type ReviewDeliveryCommittedPresentation =
  | { readonly kind: "presentation"; readonly presentation: ReviewDeliveryOverviewPresentation }
  | { readonly kind: "not-applicable" }
  | { readonly kind: "unavailable" };

export interface ReviewDeliveryCapacityStop {
  readonly kind: "capacity-stop";
  readonly code: "github-review-body-bytes-bound";
  readonly limitName: "githubReview.bodyMaxBytes";
  readonly observedBytes: number;
  readonly effectiveBytes: number;
  readonly scope: "github-pending-review-create.body";
  readonly remaining: OverviewRemainingV1;
  readonly retained: RetainedIdentityV1;
}

export type ReviewDeliveryNativeEvidence =
  | {
      readonly kind: "gitlab-note";
      readonly projectId: number;
      readonly mergeRequestIid: number;
      readonly noteId: number;
      readonly author: ReviewDeliveryActor;
      readonly body: string;
    }
  | {
      readonly kind: "gitlab-discussion";
      readonly projectId: number;
      readonly mergeRequestIid: number;
      readonly discussionId: string;
      readonly noteId: number;
      readonly author: ReviewDeliveryActor;
      readonly body: string;
      readonly position: ReviewDeliveryGitLabTextPosition;
    }
  | {
      readonly kind: "github-review";
      readonly repositoryId: number;
      readonly pullRequestNumber: number;
      readonly reviewId: number;
      readonly author: ReviewDeliveryActor;
      readonly body: string;
      readonly commitId: string;
      readonly state: "PENDING" | "COMMENTED";
      readonly comments: readonly {
        readonly commentId: number;
        readonly commitId: string;
        readonly reviewId: number;
        readonly author: ReviewDeliveryActor;
        readonly body: string;
        readonly path: string;
        readonly line: number;
        readonly side: "LEFT" | "RIGHT";
        readonly startLine?: number;
        readonly startSide?: "LEFT" | "RIGHT";
      }[];
    };

export type ReviewDeliveryRemoteObservation =
  | {
      readonly kind: "matching";
      readonly effectId: string;
      readonly providerReference: string;
      readonly native: ReviewDeliveryNativeEvidence;
      readonly actionReferences: readonly {
        readonly actionId: string;
        readonly nativeReference: string;
      }[];
      readonly discovery:
        | { readonly kind: "direct-reference" }
        | {
            readonly kind: "complete-enumeration";
            readonly enumerationSha256: string;
            readonly matchingCandidateCount: 1;
            readonly directGetVerified: true;
          };
      readonly lifecycle: "accepted-pending" | "final-published";
    }
  | {
      readonly kind: "absent-proven";
      readonly effectId: string;
      readonly completeForActorTargetAndEffect: true;
      readonly enumerationSha256: string;
    }
  | {
      readonly kind: "ambiguous" | "unavailable" | "conflict";
      readonly effectId: string;
      readonly reason: string;
    };

export interface ReviewDeliveryRecoveryPort {
  observeCurrent(binding: ReviewDeliveryActionBinding): Promise<
    | {
        readonly kind: "current";
        readonly target: ReviewTargetV2;
        readonly sourceSha256: string;
        readonly snapshotSha256: string;
        readonly actor: ReviewDeliveryActor;
        readonly headSha: string;
        readonly startSha: string | null;
      }
    | { readonly kind: "drift" | "unavailable"; readonly reason: string }
  >;
  observeEffect(input: {
    readonly action: ReviewDeliveryAction;
    readonly effect: ReviewDeliveryPreparedEffect;
    readonly context: ReviewDeliveryEffectContextV1;
    readonly phase: "pre-dispatch-baseline" | "recovery";
    readonly providerReference: string | null;
  }): Promise<ReviewDeliveryRemoteObservation>;
}

export type ReviewDeliveryPublishOutcome =
  | { readonly kind: "confirmed"; readonly providerReference: string | null }
  | {
      readonly kind: "uncertain";
      readonly providerReference: string | null;
      readonly stop: null | {
        readonly code: "rate-limited" | "cancelled" | "provider-failure" | "transport-failure";
        readonly retryAfterAt: string | null;
      };
    }
  | {
      readonly kind: "not-dispatched";
      readonly providerReference: null;
      readonly stop: {
        readonly code: "rate-limited" | "cancelled" | "provider-unavailable";
        readonly retryAfterAt: string | null;
      };
    };

export type ReviewDeliveryPreparation =
  | ReviewDeliveryPreparedEffect
  | { readonly kind: "complete" }
  | ReviewDeliveryCapacityStop
  | {
      readonly kind: "blocked";
      readonly actionId: string | null;
      readonly code:
        | "position-unprovable"
        | "diff-unavailable"
        | "source-drift"
        | "rate-limited"
        | "cancelled"
        | "provider-failure";
      readonly next: "retry" | "replan-required";
      readonly retryAfterAt: string | null;
    };

export interface ReviewDeliveryRecoverableEffectPort<TSource = unknown> {
  /** Pure sealed-candidate interpretation. It must not prepare, fetch, or consult current limits. */
  classifyCommittedOverviewPresentation?(input: {
    readonly plan: ReviewDeliveryPlan<TSource>;
    readonly context: ReviewDeliveryEffectContextV1;
  }): ReviewDeliveryCommittedPresentation;
  prepareNextEffect(input: {
    readonly plan: ReviewDeliveryPlan<TSource>;
    readonly priorObservations: readonly ReviewDeliveryRemoteObservation[];
    readonly context: ReviewDeliveryEffectContextV1;
  }): Promise<ReviewDeliveryPreparation>;
  publishEffect(input: {
    readonly plan: ReviewDeliveryPlan<TSource>;
    readonly effect: ReviewDeliveryPreparedEffect;
    readonly grantsByActionId: ReadonlyMap<string, ReviewDeliveryGrant>;
  }): Promise<ReviewDeliveryPublishOutcome>;
}

export interface ExecuteReviewDeliveryInput<TSource> {
  readonly plan: ReviewDeliveryPlan<TSource>;
  readonly store: ScmDeliveryReceiptStore;
  /** Mandatory opaque custody capability; the legacy origin factory admits only A,g0. */
  readonly originAdmission: ReviewDeliveryOriginAdmission | ReviewDeliveryCustodyAdmission;
  readonly correlationAdmission?: ReviewDeliveryCorrelationAdmission | null;
  readonly grantsByActionId: ReadonlyMap<string, ReviewDeliveryGrant>;
  readonly effects: ReviewDeliveryRecoverableEffectPort<TSource>;
  readonly recovery: ReviewDeliveryRecoveryPort;
  readonly cancelled?: () => boolean;
}

export type ReviewDeliveryExecutionResult =
  | {
      readonly kind: "complete";
      readonly overview?: "full" | "historical-legacy";
      readonly record: ReviewDeliveryRecordV1;
    }
  | {
      readonly kind: "partial";
      readonly publication: "submitted";
      readonly overview: "partial";
      readonly remaining: OverviewRemainingV1;
      readonly retained: RetainedIdentityV1;
      readonly record: ReviewDeliveryRecordV1;
    }
  | {
      readonly kind: "stopped";
      readonly reason: "capacity";
      readonly capacity: ReviewDeliveryCapacityStop;
      readonly record: ReviewDeliveryRecordV1;
    }
  | {
      readonly kind: "stopped";
      readonly reason:
        | "authority"
        | "custody"
        | "drift"
        | "preparation"
        | "remote-uncertain"
        | "provider-stop"
        | "store-uncertain";
      readonly record: ReviewDeliveryRecordV1 | null;
    };

function sha(value: unknown): string {
  return createHash("sha256")
    .update(canonicalizeJsonEvidence(value as JsonEvidenceValue))
    .digest("hex");
}

export function reviewDeliveryEffectId(
  context: ReviewDeliveryEffectContextV1,
  stage: ReviewDeliveryPreparedEffect["stage"],
  coveredActionIds: readonly string[],
): string {
  return sha({
    domain: "docsfab-review-effect-v1",
    logicalDeliveryId: context.logicalDeliveryId,
    stage,
    coveredActionIds,
  });
}

export function reviewDeliveryBodySha256(body: string): string {
  return sha(body);
}

export function reviewDeliveryGitLabPositionSha256(
  position: ReviewDeliveryGitLabTextPosition,
): string {
  return sha(position);
}

export function reviewDeliveryCurrentObservationSha256(
  observation: Awaited<ReturnType<ReviewDeliveryRecoveryPort["observeCurrent"]>>,
): string {
  return sha(observation);
}

export function reviewDeliveryGithubAnchorSha256(anchor: {
  readonly path: string;
  readonly line: number;
  readonly side: "LEFT" | "RIGHT";
  readonly startLine?: number;
  readonly startSide?: "LEFT" | "RIGHT";
}): string {
  return sha({
    path: anchor.path,
    line: anchor.line,
    side: anchor.side,
    startLine: anchor.startLine ?? null,
    startSide: anchor.startSide ?? null,
  });
}

export function reviewDeliveryEffectNonce(
  context: ReviewDeliveryEffectContextV1,
  effectId: string,
): string {
  return createHmac("sha256", Buffer.from(context.correlationSeed, "base64url"))
    .update(
      canonicalizeJsonEvidence([
        "docsfab-review-effect-nonce-v1",
        context.logicalDeliveryId,
        effectId,
      ]),
    )
    .digest("base64url");
}

/** Hash the exact outbound method/path/body bytes without persisting review text. */
export function reviewDeliveryOutboundBytesSha256(
  request: ReviewDeliveryPreparedEffect["request"],
): string {
  const hash = createHash("sha256");
  hash.update(request.method);
  hash.update("\0");
  hash.update(request.path);
  hash.update("\0");
  hash.update(request.bodyBytes);
  return hash.digest("hex");
}

function descriptor(effect: ReviewDeliveryPreparedEffect): ReviewDeliveryCommittedEffectV1 {
  return {
    effectId: effect.effectId,
    stage: effect.stage,
    coveredActionIds: [...effect.coveredActionIds],
    actionPayloads: [...effect.actionPayloads],
    outboundBytesSha256: effect.outboundBytesSha256,
    expectedBodySha256: effect.expectedBodySha256,
    expectedGitLabPositionSha256:
      effect.expectedGitLabPosition === null
        ? null
        : reviewDeliveryGitLabPositionSha256(effect.expectedGitLabPosition),
    marker: effect.marker,
  };
}

function sealedEffect(
  effect: ReviewDeliveryPreparedEffect,
  record: ReviewDeliveryRecordV1,
): boolean {
  const bound = record.context.committedEffects.find((item) => item.effectId === effect.effectId);
  return bound !== undefined && sha(descriptor(effect)) === sha(bound);
}

function effectReceipt(
  effect: ReviewDeliveryPreparedEffect,
  baseline: ReviewDeliveryEffectReceiptV1["baseline"],
): ReviewDeliveryEffectReceiptV1 {
  return {
    ...descriptor(effect),
    state: "intent",
    attemptId: randomUUID(),
    providerReference: null,
    observationSha256: null,
    actionReferences: [],
    baseline,
    stop: null,
  };
}

function currentMatches(
  binding: ReviewDeliveryActionBinding,
  current: Awaited<ReturnType<ReviewDeliveryRecoveryPort["observeCurrent"]>>,
): boolean {
  return (
    current.kind === "current" &&
    sha(reviewTargetKeyV2(current.target)) === sha(reviewTargetKeyV2(binding.target)) &&
    current.target.targetSha256 === binding.target.targetSha256 &&
    current.sourceSha256 === binding.sourceSha256 &&
    current.snapshotSha256 === binding.snapshotSha256 &&
    current.actor.host === binding.actor.host &&
    current.actor.id === binding.actor.id &&
    current.headSha === binding.reviewedHeadSha &&
    current.startSha === binding.startSha
  );
}

function revisionMatches(
  effect: ReviewDeliveryPreparedEffect,
  binding: ReviewDeliveryActionBinding,
  current: Awaited<ReturnType<ReviewDeliveryRecoveryPort["observeCurrent"]>>,
): boolean {
  const provenance = effect.revisionProvenance;
  if (effect.stage === "gitlab-note")
    return (
      provenance.kind === "gitlab-summary-retained" &&
      provenance.intendedHeadSha === binding.reviewedHeadSha &&
      provenance.serverAtomicFence === false &&
      provenance.freshTargetObservationSha256 === reviewDeliveryCurrentObservationSha256(current)
    );
  if (effect.stage === "gitlab-discussion")
    return (
      provenance.kind === "gitlab-diff-position" &&
      effect.expectedGitLabPosition !== null &&
      provenance.baseSha === binding.target.baseSha &&
      provenance.startSha === binding.startSha &&
      provenance.headSha === binding.reviewedHeadSha &&
      effect.expectedGitLabPosition.baseSha === provenance.baseSha &&
      effect.expectedGitLabPosition.startSha === provenance.startSha &&
      effect.expectedGitLabPosition.headSha === provenance.headSha
    );
  return (
    provenance.kind === "github-review-commit" && provenance.commitId === binding.reviewedHeadSha
  );
}

function actionsFor(
  effect: ReviewDeliveryPreparedEffect,
  plan: ReviewDeliveryPlan,
): ReviewDeliveryAction[] | null {
  if (
    effect.coveredActionIds.length === 0 ||
    new Set(effect.coveredActionIds).size !== effect.coveredActionIds.length ||
    effect.coveredActionIds.some(
      (id, index) => index > 0 && effect.coveredActionIds[index - 1]! >= id,
    )
  )
    return null;
  const actions = effect.coveredActionIds.map((id) =>
    plan.actions.find((action) => action.id === id),
  );
  return actions.every((action) => action !== undefined)
    ? (actions as ReviewDeliveryAction[])
    : null;
}

function grantsAdmit(
  plan: ReviewDeliveryPlan,
  actions: readonly ReviewDeliveryAction[],
  grants: ReadonlyMap<string, ReviewDeliveryGrant>,
): boolean {
  return actions.every((action) => {
    const grant = grants.get(action.id);
    if (grant === undefined) return false;
    try {
      return admitReviewDeliveryAction(plan, action, grant).status === "admitted";
    } catch {
      return false;
    }
  });
}

function effectShapeValid(
  effect: ReviewDeliveryPreparedEffect,
  record: ReviewDeliveryRecordV1,
): boolean {
  if (
    effect.kind !== "effect" ||
    effect.request.method !== "POST" ||
    !effect.request.path.startsWith("/") ||
    effect.request.path.includes("//") ||
    effect.outboundBytesSha256 !== reviewDeliveryOutboundBytesSha256(effect.request) ||
    effect.coveredActionIds.length !== effect.actionPayloads.length ||
    effect.coveredActionIds.some((id, index) => effect.actionPayloads[index]?.actionId !== id) ||
    (effect.stage === "gitlab-discussion") !== (effect.expectedGitLabPosition !== null)
  )
    return false;
  const expectedEffectId = reviewDeliveryEffectId(
    record.context,
    effect.stage,
    effect.coveredActionIds,
  );
  return (
    effect.effectId === expectedEffectId &&
    effect.marker === reviewDeliveryEffectNonce(record.context, effect.effectId)
  );
}

function nativeMatches(
  plan: ReviewDeliveryPlan,
  effect: ReviewDeliveryPreparedEffect,
  observation: Extract<ReviewDeliveryRemoteObservation, { kind: "matching" }>,
  allowFinalPendingReview = false,
): boolean {
  const native = observation.native;
  const target = plan.target;
  if (
    observation.discovery.kind === "complete-enumeration" &&
    (observation.discovery.matchingCandidateCount !== 1 ||
      observation.discovery.directGetVerified !== true ||
      !/^[a-f0-9]{64}$/u.test(observation.discovery.enumerationSha256))
  )
    return false;
  if (
    observation.effectId !== effect.effectId ||
    !observation.providerReference ||
    observation.actionReferences.length !== effect.coveredActionIds.length ||
    new Set(observation.actionReferences.map((item) => item.actionId)).size !==
      observation.actionReferences.length ||
    observation.actionReferences.some(
      (item) => !effect.coveredActionIds.includes(item.actionId) || !item.nativeReference,
    )
  )
    return false;
  if (native.author.host !== plan.actor.host || native.author.id !== plan.actor.id) return false;
  if (native.kind === "gitlab-note" || native.kind === "gitlab-discussion") {
    if (
      target.scmProvider !== "gitlab" ||
      native.projectId !== target.projectId ||
      native.mergeRequestIid !== target.mergeRequestIid ||
      reviewDeliveryBodySha256(native.body) !== effect.expectedBodySha256 ||
      observation.lifecycle !== "final-published"
    )
      return false;
    if (native.kind === "gitlab-note")
      return (
        effect.stage === "gitlab-note" &&
        observation.providerReference === String(native.noteId) &&
        observation.actionReferences.every((item) => item.nativeReference === String(native.noteId))
      );
    return (
      effect.stage === "gitlab-discussion" &&
      observation.providerReference === native.discussionId &&
      observation.actionReferences.every(
        (item) => item.nativeReference === String(native.noteId),
      ) &&
      effect.expectedGitLabPosition !== null &&
      sha(native.position) === sha(effect.expectedGitLabPosition)
    );
  }
  if (
    target.scmProvider !== "github" ||
    native.repositoryId !== target.repositoryId ||
    native.pullRequestNumber !== target.pullRequestNumber ||
    native.commitId !== plan.result.reviewedHeadSha ||
    reviewDeliveryBodySha256(native.body) !== effect.expectedBodySha256 ||
    !["github-pending-review-create", "github-comment-submit"].includes(effect.stage)
  )
    return false;
  const expectedState = effect.stage === "github-comment-submit" ? "COMMENTED" : "PENDING";
  const finalPendingReview =
    allowFinalPendingReview &&
    effect.stage === "github-pending-review-create" &&
    native.state === "COMMENTED" &&
    observation.lifecycle === "final-published";
  if (
    (native.state !== expectedState && !finalPendingReview) ||
    observation.providerReference !== String(native.reviewId) ||
    (observation.lifecycle !==
      (expectedState === "COMMENTED" ? "final-published" : "accepted-pending") &&
      !finalPendingReview)
  )
    return false;
  const inlineReferences = observation.actionReferences.filter(
    (item) =>
      effect.actionPayloads.find((payload) => payload.actionId === item.actionId)?.anchorSha256 !==
      null,
  );
  if (
    new Set(inlineReferences.map((item) => item.nativeReference)).size !==
      inlineReferences.length ||
    native.comments.length !== inlineReferences.length
  )
    return false;
  for (const payload of effect.actionPayloads) {
    const reference = observation.actionReferences.find(
      (item) => item.actionId === payload.actionId,
    );
    if (!reference) return false;
    if (payload.anchorSha256 === null) {
      if (
        reference.nativeReference !== String(native.reviewId) ||
        reviewDeliveryBodySha256(native.body) !== payload.bodySha256
      )
        return false;
      continue;
    }
    const comment = native.comments.find(
      (item) => String(item.commentId) === reference.nativeReference,
    );
    if (
      !comment ||
      comment.commitId !== plan.result.reviewedHeadSha ||
      comment.commitId !== native.commitId ||
      comment.reviewId !== native.reviewId ||
      comment.author.host !== plan.actor.host ||
      comment.author.id !== plan.actor.id ||
      reviewDeliveryBodySha256(comment.body) !== payload.bodySha256 ||
      reviewDeliveryGithubAnchorSha256(comment) !== payload.anchorSha256
    )
      return false;
  }
  return true;
}

function retainedNativeMatches(
  plan: ReviewDeliveryPlan,
  effect: ReviewDeliveryPreparedEffect,
  receipt: ReviewDeliveryEffectReceiptV1,
  observation: ReviewDeliveryRemoteObservation,
  allowFinalPendingReview: boolean,
): boolean {
  if (
    observation.kind !== "matching" ||
    receipt.providerReference === null ||
    observation.discovery.kind !== "direct-reference" ||
    observation.providerReference !== receipt.providerReference ||
    sha([...observation.actionReferences].sort((a, b) => a.actionId.localeCompare(b.actionId))) !==
      sha(receipt.actionReferences)
  )
    return false;
  return nativeMatches(plan, effect, observation, allowFinalPendingReview);
}

function sealedSubmitForPendingCreate(
  record: ReviewDeliveryRecordV1,
  created: ReviewDeliveryEffectReceiptV1,
): boolean {
  return record.effects.some(
    (item) =>
      item.stage === "github-comment-submit" &&
      sha(item.coveredActionIds) === sha(created.coveredActionIds) &&
      (item.state === "intent" ||
        item.state === "uncertain" ||
        (item.state === "confirmed" &&
          created.providerReference !== null &&
          item.providerReference === created.providerReference &&
          item.expectedBodySha256 === created.expectedBodySha256 &&
          sha(item.actionPayloads) === sha(created.actionPayloads) &&
          item.actionReferences.length === created.coveredActionIds.length &&
          sha(item.actionReferences) === sha(created.actionReferences))),
  );
}

function submitTargetsCreatedReview(
  effect: ReviewDeliveryPreparedEffect,
  record: ReviewDeliveryRecordV1,
  plan: ReviewDeliveryPlan,
): boolean {
  if (effect.stage !== "github-comment-submit") return true;
  if (plan.target.scmProvider !== "github") return false;
  const created = record.effects.find(
    (item) =>
      item.stage === "github-pending-review-create" &&
      item.state === "accepted-pending" &&
      sha(item.coveredActionIds) === sha(effect.coveredActionIds),
  );
  return (
    created?.providerReference !== null &&
    created?.providerReference !== undefined &&
    effect.request.path.endsWith(
      `/pulls/${plan.target.pullRequestNumber}/reviews/${created.providerReference}/events`,
    )
  );
}

function updateEffect(
  record: ReviewDeliveryRecordV1,
  old: ReviewDeliveryEffectReceiptV1,
  changes: Partial<ReviewDeliveryEffectReceiptV1>,
): ReviewDeliveryRecordV1 {
  const next = { ...old, ...changes };
  return updateReviewDeliveryRecord(record, {
    effects: record.effects.map((item) => (item.effectId === old.effectId ? next : item)),
  });
}

async function save(
  store: ScmDeliveryReceiptStore,
  before: ReviewDeliveryRecordV1,
  after: ReviewDeliveryRecordV1,
  authorize: () => void | Promise<void>,
): Promise<ReviewDeliveryRecordV1> {
  if (!store.compareAndSwapReview)
    throw new Error("Review receipt compare-and-swap is unavailable in this configured store.");
  try {
    return await store.compareAndSwapReview(before.sha256, after, authorize);
  } catch (error) {
    // A helper can die after linking the new slot. Only the exact persisted
    // successor proves this CAS committed; any other state stops this attempt.
    const observed = await store.loadReview?.(after.idempotencyKey).catch(() => undefined);
    if (observed?.sha256 === after.sha256) return observed;
    throw error;
  }
}

function retainedPresentationMatches<TSource>(
  plan: ReviewDeliveryPlan<TSource>,
  presentation: ReviewDeliveryOverviewPresentation,
): boolean {
  const { remaining, retained } = presentation;
  return (
    retained.resultSha256 === plan.result.originalResultSha256 &&
    retained.sourceSha256 === plan.target.changeSourceSha256 &&
    retained.snapshotSha256 === plan.snapshotSha256 &&
    retained.runIdSha256 === plan.result.runIdSha256 &&
    retained.actionSetSha256 ===
      sha256(canonicalJson(plan.actions.map((action) => action.id).sort())) &&
    remaining.findingsTotal === plan.findings.length &&
    remaining.summarySelectedFindings ===
      plan.actions
        .filter((action) => action.kind === "publish-summary")
        .reduce((count, action) => count + action.findingIds.length, 0) &&
    remaining.nativeInlineFindings ===
      plan.actions.filter((action) => action.kind === "publish-inline").length &&
    remaining.retainedUnpostedFindings ===
      remaining.findingsTotal -
        remaining.summarySelectedFindings -
        remaining.nativeInlineFindings &&
    remaining.unsupportedUnpostedFindings <= remaining.retainedUnpostedFindings &&
    Object.values(remaining).every((value) => Number.isSafeInteger(value) && value >= 0)
  );
}

function completedPresentation<TSource>(
  plan: ReviewDeliveryPlan<TSource>,
  effects: ReviewDeliveryRecoverableEffectPort<TSource>,
  record: ReviewDeliveryRecordV1,
): ReviewDeliveryExecutionResult {
  const created = record.effects.filter((item) => item.stage === "github-pending-review-create");
  if (plan.target.scmProvider !== "github" || created.length === 0)
    return { kind: "complete", record };
  // A missing classifier cannot distinguish an old terse review from a
  // compact review committed under a newer provider, even at the same key.
  if (!effects.classifyCommittedOverviewPresentation)
    return { kind: "stopped", reason: "remote-uncertain", record };
  let classified: ReviewDeliveryCommittedPresentation;
  try {
    classified = effects.classifyCommittedOverviewPresentation({ plan, context: record.context });
  } catch {
    return { kind: "stopped", reason: "remote-uncertain", record };
  }
  if (classified.kind !== "presentation" || created.length !== 1)
    return { kind: "stopped", reason: "remote-uncertain", record };
  const { presentation } = classified;
  if (!retainedPresentationMatches(plan, presentation))
    return { kind: "stopped", reason: "remote-uncertain", record };
  const pending = created[0]!;
  if (
    pending.state !== "accepted-pending" ||
    pending.observationSha256 === null ||
    !record.effects.some(
      (item) =>
        item.stage === "github-comment-submit" &&
        item.state === "confirmed" &&
        item.observationSha256 !== null &&
        item.providerReference === pending.providerReference &&
        sha(item.coveredActionIds) === sha(pending.coveredActionIds),
    ) ||
    !sealedSubmitForPendingCreate(record, pending)
  )
    return { kind: "stopped", reason: "remote-uncertain", record };
  if (presentation.kind !== "compact-partial")
    return { kind: "complete", overview: presentation.kind, record };
  return {
    kind: "partial",
    publication: "submitted",
    overview: "partial",
    remaining: presentation.remaining,
    retained: presentation.retained,
    record,
  };
}

async function observeMatching<TSource>(
  input: ExecuteReviewDeliveryInput<TSource>,
  record: ReviewDeliveryRecordV1,
  effect: ReviewDeliveryPreparedEffect,
  observation: ReviewDeliveryRemoteObservation,
): Promise<ReviewDeliveryRecordV1 | null> {
  if (observation.kind !== "matching" || !nativeMatches(input.plan, effect, observation))
    return null;
  const existing = record.effects.find((item) => item.effectId === effect.effectId);
  if (!existing) return null;
  if (existing.providerReference !== null && observation.discovery.kind !== "direct-reference")
    return null;
  if (
    effect.stage === "gitlab-discussion" &&
    existing.providerReference === null &&
    observation.discovery.kind !== "complete-enumeration"
  )
    return null;
  if (
    effect.stage === "github-pending-review-create" &&
    existing.providerReference === null &&
    observation.discovery.kind !== "complete-enumeration"
  )
    return null;
  if (effect.stage === "github-comment-submit") {
    const created = record.effects.find(
      (item) =>
        item.stage === "github-pending-review-create" &&
        sha(item.coveredActionIds) === sha(effect.coveredActionIds),
    );
    if (
      !created ||
      created.state !== "accepted-pending" ||
      created.providerReference !== observation.providerReference ||
      sha(created.actionReferences) !==
        sha([...observation.actionReferences].sort((a, b) => a.actionId.localeCompare(b.actionId)))
    )
      return null;
  }
  if (effect.stage === "gitlab-note" && existing.providerReference === null) {
    if (
      existing.baseline === null ||
      observation.discovery.kind !== "complete-enumeration" ||
      observation.discovery.matchingCandidateCount !== 1 ||
      !observation.discovery.directGetVerified ||
      observation.discovery.enumerationSha256 === existing.baseline.enumerationSha256 ||
      !(await admitReviewDeliveryCorrelation(input.correlationAdmission ?? null, {
        logicalDeliveryId: record.manifest.logicalDeliveryId,
        effectId: effect.effectId,
        target: input.plan.target,
        actor: input.plan.actor,
        requestedStore: record.ownerStoreId,
        nonce: effect.marker,
      }))
    )
      return null;
  }
  if (
    existing.providerReference !== null &&
    existing.providerReference !== observation.providerReference
  )
    return null;
  const state =
    observation.lifecycle === "final-published" && effect.stage !== "github-pending-review-create"
      ? "confirmed"
      : "accepted-pending";
  return updateEffect(record, existing, {
    state,
    providerReference: observation.providerReference,
    observationSha256: sha(observation),
    actionReferences: [...observation.actionReferences].sort((a, b) =>
      a.actionId.localeCompare(b.actionId),
    ),
    stop: null,
  });
}

/** One origin-store attempt. Every exit retains a durable record or names the unproved store outcome. */
export async function executeReviewDelivery<TSource>(
  input: ExecuteReviewDeliveryInput<TSource>,
): Promise<ReviewDeliveryExecutionResult> {
  const manifest = createReviewDeliveryManifest(input.plan);
  if (!input.store.withReviewDeliveryLease || !input.store.loadReview || !input.store.claimReview)
    return { kind: "stopped", reason: "store-uncertain", record: null };
  let initialSlot: ReviewDeliveryRecordV1 | null | undefined;
  try {
    initialSlot = await input.store.loadReview!(manifest.idempotencyKey);
  } catch {
    return { kind: "stopped", reason: "store-uncertain", record: null };
  }
  const expectedGeneration = initialSlot?.generation ?? null;
  const transferId = initialSlot?.custody.transferId ?? null;
  const sourceStoreId = initialSlot?.custody.otherStoreId ?? null;
  const origin = await admitReviewDeliveryCustody(input.originAdmission, {
    manifest,
    plan: input.plan,
    requestedStore: input.store,
    phase: "execute",
    expectedGeneration,
    transferId,
    sourceStoreId,
    sourceGeneration: initialSlot && initialSlot.generation > 0 ? initialSlot.generation - 1 : null,
    destinationStoreId: null,
    fencedRecordSha256: null,
  });
  if (origin.status !== "admitted")
    return { kind: "stopped", reason: "custody", record: initialSlot ?? null };
  const legacyEmptyManifest =
    !initialSlot && origin.storeId === origin.originStoreId
      ? createReviewDeliveryLegacyEmptyManifest(input.plan)
      : null;
  // The source lease is read before taking the destination lease. Its fence is
  // monotone; the destination CAS and every dispatch check the source again.
  const fencedSource =
    initialSlot?.custody.state === "import-pending" &&
    initialSlot.custody.otherStoreId !== null &&
    initialSlot.custody.transferId !== null
      ? await loadReviewDeliveryFencedSource(
          input.originAdmission as ReviewDeliveryCustodyAdmission,
          {
            manifest,
            plan: input.plan,
            sourceStoreId: initialSlot.custody.otherStoreId,
            destinationStoreId: origin.storeId,
            sourceGeneration: initialSlot.generation - 1,
            transferId: initialSlot.custody.transferId,
          },
        )
      : null;
  if (initialSlot?.custody.state === "import-pending" && !fencedSource)
    return { kind: "stopped", reason: "custody", record: initialSlot };
  let dispatchGuardActions: readonly ReviewDeliveryAction[] = [];
  let activationGuard = false;
  const authorize = async (): Promise<void> => {
    const currentOrigin = await admitReviewDeliveryCustody(input.originAdmission, {
      manifest,
      plan: input.plan,
      requestedStore: input.store,
      phase: "execute",
      expectedGeneration,
      transferId,
      sourceStoreId,
      sourceGeneration:
        initialSlot && initialSlot.generation > 0 ? initialSlot.generation - 1 : null,
      destinationStoreId: null,
      fencedRecordSha256: null,
    });
    if (
      currentOrigin.status !== "admitted" ||
      currentOrigin.storeId !== origin.storeId ||
      currentOrigin.originStoreId !== origin.originStoreId
    )
      throw new Error(
        "Review delivery custody admission changed before the durable journal write.",
      );
    const guardActions = activationGuard ? input.plan.actions : dispatchGuardActions;
    if (activationGuard || guardActions.length > 0) {
      if (
        input.cancelled?.() === true ||
        !grantsAdmit(input.plan, guardActions, input.grantsByActionId)
      )
        throw new Error(
          "Review delivery dispatch authority changed before the durable journal write.",
        );
      if (guardActions.length > 0) {
        const current = await input.recovery.observeCurrent(guardActions[0]!.binding);
        if (!guardActions.every((action) => currentMatches(action.binding, current)))
          throw new Error(
            "Review delivery target or source changed before the durable intent CAS.",
          );
        if (
          input.cancelled?.() === true ||
          !grantsAdmit(input.plan, guardActions, input.grantsByActionId)
        )
          throw new Error(
            "Review delivery dispatch authority changed before the durable journal write.",
          );
      }
    }
  };
  const withCurrentLease = async <T>(
    key: string,
    assertAuthorized: () => void | Promise<void>,
    action: (assertHeldReviewIntent: (recordSha256: string) => Promise<void>) => Promise<T>,
  ): Promise<T | ReviewDeliveryExecutionResult> => {
    if (legacyEmptyManifest === null)
      return input.store.withReviewDeliveryLease!(key, assertAuthorized, action);
    // Old GitLab zero-action journals use null startSha and a distinct V1 key.
    // Hold that key before the current key throughout claim and dispatch.
    return input.store.withReviewDeliveryLease!(
      legacyEmptyManifest.idempotencyKey,
      authorize,
      async () => {
        const alias = await input.store.loadReview!(legacyEmptyManifest.idempotencyKey);
        if (
          alias &&
          (alias.manifest.manifestSha256 !== legacyEmptyManifest.manifestSha256 ||
            alias.originStoreId !== origin.originStoreId ||
            alias.ownerStoreId !== origin.storeId ||
            alias.generation !== 0 ||
            alias.custody.state !== "active" ||
            alias.custody.transferId !== null ||
            alias.custody.otherStoreId !== null ||
            alias.effects.length !== 0 ||
            alias.context.committedEffects.length !== 0 ||
            alias.preparationStop !== null)
        )
          return { kind: "stopped" as const, reason: "custody" as const, record: alias };
        return input.store.withReviewDeliveryLease!(key, assertAuthorized, action);
      },
    );
  };
  try {
    return await withCurrentLease(
      manifest.idempotencyKey,
      authorize,
      async (assertHeldReviewIntent) => {
        let record = await input.store.loadReview!(manifest.idempotencyKey);
        if (!record) {
          if (origin.storeId !== origin.originStoreId || expectedGeneration !== null)
            return { kind: "stopped", reason: "custody", record: null };
          const initial = createReviewDeliveryRecord(
            manifest,
            origin.originStoreId,
            randomBytes(32).toString("base64url"),
          );
          try {
            record = (await input.store.claimReview!(initial, authorize)).record;
          } catch (error) {
            const observed = await input.store.loadReview!(manifest.idempotencyKey).catch(
              () => undefined,
            );
            if (observed?.sha256 !== initial.sha256) throw error;
            record = observed;
          }
        }
        if (
          record.manifest.manifestSha256 !== manifest.manifestSha256 ||
          record.originStoreId !== origin.originStoreId ||
          record.ownerStoreId !== origin.storeId ||
          (record.custody.state !== "active" && record.custody.state !== "import-pending") ||
          record.generation !== (expectedGeneration ?? 0) ||
          record.custody.transferId !== transferId
        )
          return { kind: "stopped", reason: "custody", record };
        if (
          input.plan.requestedActions === undefined &&
          record.custody.state === "active" &&
          record.effects.every(
            (item) => item.state === "confirmed" || item.state === "accepted-pending",
          ) &&
          input.plan.actions.every((action) =>
            record!.effects.some(
              (item) => item.state === "confirmed" && item.coveredActionIds.includes(action.id),
            ),
          )
        ) {
          if (!grantsAdmit(input.plan, input.plan.actions, input.grantsByActionId))
            return { kind: "stopped", reason: "authority", record };
          if (input.plan.actions.length > 0) {
            const current = await input.recovery.observeCurrent(input.plan.actions[0]!.binding);
            if (!input.plan.actions.every((action) => currentMatches(action.binding, current)))
              return { kind: "stopped", reason: "drift", record };
          }
          return completedPresentation(input.plan, input.effects, record);
        }
        const prior: ReviewDeliveryRemoteObservation[] = [];
        const remaining = new Set(record.effects.map((item) => item.effectId));
        while (remaining.size > 0) {
          const prepared = await input.effects.prepareNextEffect({
            plan: input.plan,
            priorObservations: [...prior],
            context: record.context,
          });
          const old =
            prepared.kind === "effect"
              ? record.effects.find((item) => item.effectId === prepared.effectId)
              : undefined;
          if (
            prepared.kind !== "effect" ||
            !old ||
            !remaining.has(prepared.effectId) ||
            !sealedEffect(prepared, record) ||
            !submitTargetsCreatedReview(prepared, record, input.plan)
          )
            return { kind: "stopped", reason: "remote-uncertain", record };
          if (old.state === "not-dispatched") break;
          if (old.state === "pending")
            return { kind: "stopped", reason: "remote-uncertain", record };
          const actions = actionsFor(prepared, input.plan);
          if (!actions || !grantsAdmit(input.plan, actions, input.grantsByActionId))
            return { kind: "stopped", reason: "authority", record };
          const current = await input.recovery.observeCurrent(actions[0]!.binding);
          if (
            !actions.every((action) => currentMatches(action.binding, current)) ||
            !revisionMatches(prepared, actions[0]!.binding, current)
          )
            return { kind: "stopped", reason: "drift", record };
          const observation = await input.recovery.observeEffect({
            action: actions[0]!,
            effect: prepared,
            context: record.context,
            phase: "recovery",
            providerReference: old.providerReference,
          });
          const afterCurrent = await input.recovery.observeCurrent(actions[0]!.binding);
          if (!actions.every((action) => currentMatches(action.binding, afterCurrent)))
            return { kind: "stopped", reason: "drift", record };
          if (old.state === "confirmed" || old.state === "accepted-pending") {
            const finalPendingReview =
              old.state === "accepted-pending" &&
              old.stage === "github-pending-review-create" &&
              sealedSubmitForPendingCreate(record, old);
            if (!retainedNativeMatches(input.plan, prepared, old, observation, finalPendingReview))
              return { kind: "stopped", reason: "remote-uncertain", record };
          } else {
            // A provider may have accepted the request before the first post-call
            // receipt write. Retain the permitted intermediate state before
            // settling authenticated native evidence from the old intent.
            if (old.state === "intent") {
              const uncertain = updateEffect(record, old, { state: "uncertain" });
              if (!(await observeMatching(input, uncertain, prepared, observation)))
                return { kind: "stopped", reason: "remote-uncertain", record };
              record = await save(input.store, record, uncertain, authorize);
            }
            const settled = await observeMatching(input, record, prepared, observation);
            if (!settled) return { kind: "stopped", reason: "remote-uncertain", record };
            record = await save(input.store, record, settled, authorize);
            if (
              record.effects.find((item) => item.effectId === old.effectId)?.state !==
                "confirmed" &&
              !(
                old.stage === "github-pending-review-create" &&
                record.effects.find((item) => item.effectId === old.effectId)?.state ===
                  "accepted-pending"
              )
            )
              return { kind: "stopped", reason: "remote-uncertain", record };
          }
          prior.push(observation);
          remaining.delete(old.effectId);
        }
        if (record.custody.state === "import-pending") {
          if (
            !fencedSource ||
            !reviewDeliveryImportedLineageMatches(fencedSource, record) ||
            [...remaining].some((id) => {
              const effect = record!.effects.find((item) => item.effectId === id);
              return effect?.providerReference !== null || effect?.state !== "not-dispatched";
            })
          )
            return { kind: "stopped", reason: "remote-uncertain", record };
          if (!grantsAdmit(input.plan, input.plan.actions, input.grantsByActionId))
            return { kind: "stopped", reason: "authority", record };
          if (input.cancelled?.() === true) return { kind: "stopped", reason: "authority", record };
          if (input.plan.actions.length > 0) {
            const current = await input.recovery.observeCurrent(input.plan.actions[0]!.binding);
            if (!input.plan.actions.every((action) => currentMatches(action.binding, current)))
              return { kind: "stopped", reason: "drift", record };
          }
          const currentCustody = await admitReviewDeliveryCustody(input.originAdmission, {
            manifest,
            plan: input.plan,
            requestedStore: input.store,
            phase: "execute",
            expectedGeneration: record.generation,
            transferId: record.custody.transferId,
            sourceStoreId: record.custody.otherStoreId,
            sourceGeneration: record.generation - 1,
            destinationStoreId: null,
            fencedRecordSha256: null,
          });
          if (
            currentCustody.status !== "admitted" ||
            currentCustody.storeId !== origin.storeId ||
            currentCustody.state !== "import-pending"
          )
            return { kind: "stopped", reason: "custody", record };
          const activated = updateReviewDeliveryRecord(record, {
            custody: { ...record.custody, state: "active" },
          });
          activationGuard = true;
          try {
            record = await save(input.store, record, activated, authorize);
          } finally {
            activationGuard = false;
          }
        }
        for (;;) {
          const preparation = await input.effects.prepareNextEffect({
            plan: input.plan,
            priorObservations: [...prior],
            context: record.context,
          });
          if (preparation.kind === "complete") {
            if (
              input.plan.actions.every((action) =>
                record!.effects.some(
                  (item) => item.state === "confirmed" && item.coveredActionIds.includes(action.id),
                ),
              )
            )
              return completedPresentation(input.plan, input.effects, record);
            return { kind: "stopped", reason: "remote-uncertain", record };
          }
          if (preparation.kind === "capacity-stop") {
            if (
              input.plan.target.scmProvider !== "github" ||
              (input.plan.requestedActions === undefined &&
                !input.plan.actions.some((action) => action.kind === "publish-summary")) ||
              record.effects.some((item) => item.stage === "github-pending-review-create") ||
              !retainedPresentationMatches(input.plan, {
                kind: "compact-partial",
                remaining: preparation.remaining,
                retained: preparation.retained,
              }) ||
              !Number.isSafeInteger(preparation.observedBytes) ||
              !Number.isSafeInteger(preparation.effectiveBytes) ||
              preparation.observedBytes <= preparation.effectiveBytes ||
              preparation.effectiveBytes < 0
            )
              return { kind: "stopped", reason: "remote-uncertain", record };
            return { kind: "stopped", reason: "capacity", capacity: preparation, record };
          }
          if (preparation.kind === "blocked") {
            const stopped = updateReviewDeliveryRecord(record, {
              preparationStop: {
                actionId: preparation.actionId,
                code: preparation.code,
                next: preparation.next,
                retryAfterAt: preparation.retryAfterAt,
              },
            });
            record = await save(input.store, record, stopped, authorize);
            return { kind: "stopped", reason: "preparation", record };
          }
          const effect = preparation;
          const actions = actionsFor(effect, input.plan);
          const earlier = record.effects.find((item) => item.effectId === effect.effectId);
          if (
            !actions ||
            !effectShapeValid(effect, record) ||
            !submitTargetsCreatedReview(effect, record, input.plan) ||
            (earlier !== undefined &&
              (earlier.state !== "not-dispatched" || !sealedEffect(effect, record))) ||
            !grantsAdmit(input.plan, actions, input.grantsByActionId)
          )
            return { kind: "stopped", reason: "authority", record };
          const current = await input.recovery.observeCurrent(actions[0]!.binding);
          if (
            !actions.every((action) => currentMatches(action.binding, current)) ||
            !revisionMatches(effect, actions[0]!.binding, current)
          )
            return { kind: "stopped", reason: "drift", record };
          let baseline: ReviewDeliveryEffectReceiptV1["baseline"] = null;
          if (effect.stage === "gitlab-note") {
            const observed = await input.recovery.observeEffect({
              action: actions[0]!,
              effect,
              context: record.context,
              phase: "pre-dispatch-baseline",
              providerReference: null,
            });
            if (
              observed.kind !== "absent-proven" ||
              observed.effectId !== effect.effectId ||
              !observed.completeForActorTargetAndEffect
            )
              return { kind: "stopped", reason: "remote-uncertain", record };
            baseline = {
              scopeSha256: sha({
                target: input.plan.target,
                actor: input.plan.actor,
                effectId: effect.effectId,
                marker: effect.marker,
              }),
              enumerationSha256: observed.enumerationSha256,
              bodySha256: effect.expectedBodySha256,
            };
          }
          const pending =
            earlier === undefined
              ? effectReceipt(effect, baseline)
              : {
                  ...earlier,
                  state: "intent" as const,
                  attemptId: randomUUID(),
                  baseline,
                  stop: null,
                };
          const effects = (
            earlier === undefined
              ? [...record.effects, pending]
              : record.effects.map((item) => (item.effectId === pending.effectId ? pending : item))
          ).sort((a, b) => a.effectId.localeCompare(b.effectId));
          const committedEffects =
            earlier === undefined
              ? [...record.context.committedEffects, descriptor(effect)].sort((a, b) =>
                  a.effectId.localeCompare(b.effectId),
                )
              : record.context.committedEffects;
          dispatchGuardActions = actions;
          try {
            record = await save(
              input.store,
              record,
              updateReviewDeliveryRecord(record, {
                effects,
                context: { ...record.context, committedEffects },
                preparationStop: null,
              }),
              authorize,
            );
          } finally {
            dispatchGuardActions = [];
          }
          const postAdmitted = await admitReviewDeliveryCustody(input.originAdmission, {
            manifest,
            plan: input.plan,
            requestedStore: input.store,
            phase: "execute",
            expectedGeneration: record.generation,
            transferId: record.custody.transferId,
            sourceStoreId: record.custody.otherStoreId,
            sourceGeneration: record.generation > 0 ? record.generation - 1 : null,
            destinationStoreId: null,
            fencedRecordSha256: null,
          });
          // Origin loss is a local, pre-dispatch stop. Do not depend on a
          // remote observation to record that no provider call was made.
          if (
            postAdmitted.status !== "admitted" ||
            postAdmitted.storeId !== origin.storeId ||
            postAdmitted.originStoreId !== origin.originStoreId
          ) {
            record = await save(
              input.store,
              record,
              updateEffect(record, pending, {
                state: "not-dispatched",
                stop: { code: "source-drift", retryAfterAt: null },
              }),
              () => undefined,
            );
            return { kind: "stopped", reason: "authority", record };
          }
          const postCurrent = await input.recovery.observeCurrent(actions[0]!.binding);
          if (
            input.cancelled?.() === true ||
            !actions.every((action) => currentMatches(action.binding, postCurrent)) ||
            !grantsAdmit(input.plan, actions, input.grantsByActionId)
          ) {
            record = await save(
              input.store,
              record,
              updateEffect(record, pending, {
                state: "not-dispatched",
                stop: {
                  code: input.cancelled?.() === true ? "cancelled" : "source-drift",
                  retryAfterAt: null,
                },
              }),
              authorize,
            );
            return { kind: "stopped", reason: "authority", record };
          }
          await assertHeldReviewIntent(record.sha256);
          // The store check awaits a journal helper. A grant can be revoked or
          // cancellation requested during that wait, so sample both again at
          // the final synchronous transport boundary.
          const postGuardCancelled = input.cancelled?.() === true;
          if (postGuardCancelled || !grantsAdmit(input.plan, actions, input.grantsByActionId)) {
            record = await save(
              input.store,
              record,
              updateEffect(record, pending, {
                state: "not-dispatched",
                stop: {
                  code: postGuardCancelled ? "cancelled" : "source-drift",
                  retryAfterAt: null,
                },
              }),
              authorize,
            );
            return { kind: "stopped", reason: "authority", record };
          }
          let outcome: ReviewDeliveryPublishOutcome;
          try {
            outcome = await input.effects.publishEffect({
              plan: input.plan,
              effect,
              grantsByActionId: input.grantsByActionId,
            });
          } catch {
            outcome = {
              kind: "uncertain",
              providerReference: null,
              stop: { code: "transport-failure", retryAfterAt: null },
            };
          }
          if (outcome.kind === "not-dispatched") {
            record = await save(
              input.store,
              record,
              updateEffect(record, pending, {
                state: "not-dispatched",
                stop: outcome.stop,
              }),
              authorize,
            );
            return { kind: "stopped", reason: "provider-stop", record };
          }
          record = await save(
            input.store,
            record,
            updateEffect(record, pending, {
              state: "uncertain",
              providerReference: outcome.providerReference,
              stop: outcome.kind === "uncertain" ? outcome.stop : null,
            }),
            authorize,
          );
          const observation = await input.recovery.observeEffect({
            action: actions[0]!,
            effect,
            context: record.context,
            phase: "recovery",
            providerReference: outcome.providerReference,
          });
          prior.push(observation);
          const afterCurrent = await input.recovery.observeCurrent(actions[0]!.binding);
          if (!actions.every((action) => currentMatches(action.binding, afterCurrent)))
            return { kind: "stopped", reason: "drift", record };
          const settled = await observeMatching(input, record, effect, observation);
          if (!settled) return { kind: "stopped", reason: "remote-uncertain", record };
          record = await save(input.store, record, settled, authorize);
          if (
            record.effects.find((item) => item.effectId === effect.effectId)?.state !==
              "confirmed" &&
            !(
              effect.stage === "github-pending-review-create" &&
              record.effects.find((item) => item.effectId === effect.effectId)?.state ===
                "accepted-pending"
            )
          )
            return { kind: "stopped", reason: "remote-uncertain", record };
        }
      },
    );
  } catch {
    const observed = await input.store.loadReview(manifest.idempotencyKey).catch(() => undefined);
    if (observed && observed.manifest.manifestSha256 !== manifest.manifestSha256)
      return { kind: "stopped", reason: "custody", record: observed };
    return { kind: "stopped", reason: "store-uncertain", record: observed ?? null };
  }
}
