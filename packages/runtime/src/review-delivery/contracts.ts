// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  ReviewCheckV1,
  ReviewCoverageV1,
  ReviewFindingSeverity,
  ReviewQuestionV1,
  ReviewSourceContextV3,
  ReviewTargetV2,
} from "../review/contracts.js";
import type {
  ReviewResultProjectionV1,
  ReviewTargetMigrationV1,
} from "../review/target-migration.js";
import type { ReviewDiffFile, ReviewResolvedAnchor, ReviewUnresolvedAnchor } from "./anchors.js";
import type { ReviewLocatorLoadResult } from "../review/locator-provenance-contracts.js";

/** Provider facts are observations, not authority to publish. */
export interface ReviewDeliveryProviderCapabilities {
  readonly scmProvider: "gitlab" | "github";
  readonly host: string;
  readonly summary: boolean;
  readonly inline: boolean;
}

/** Original caller choice; absence preserves the historical action projection. */
export type ReviewDeliveryRequestedActions = "overview" | "summary-only";

export interface ReviewDeliveryActor {
  readonly host: string;
  readonly id: string;
}

/** Supplied by retained storage; its digest must equal the decoded original result. */
export interface ReviewDeliveryArtifact {
  readonly kind: "retained-review-result";
  readonly id: string;
  readonly resultSha256: string;
}

/** Host-owned original bytes and complete parsed diff for the bound ChangeSource. */
export interface ReviewDeliverySnapshot {
  readonly changeSourceSha256: string;
  readonly files: readonly ReviewDiffFile[];
}

export type ReviewDeliveryDisposition =
  | { readonly kind: "inline-candidate"; readonly anchor: ReviewResolvedAnchor }
  | {
      readonly kind: "summary-candidate";
      readonly reason:
        | ReviewUnresolvedAnchor["reason"]
        | "presentation-policy"
        | "delivery-intent"
        | "inline-unavailable"
        | "no-location";
    }
  | {
      readonly kind: "unsupported";
      readonly reason: "provider-unsupported" | "presentation-unsupported";
    };

/** An inventory entry names original saved bytes; it does not create another issue graph. */
export interface ReviewDeliveryFinding {
  readonly inventoryId: string;
  readonly logicalIssueId: string;
  readonly observationId: string;
  readonly source: "issue" | "finding";
  readonly sourceIndex: number;
  readonly retained: {
    readonly resultSha256: string;
    readonly collection: "issues" | "findings";
    readonly index: number;
  };
  readonly originalId: string;
  readonly severity: ReviewFindingSeverity;
  readonly text: string;
  readonly path: string | null;
  readonly relatedLocations: readonly string[];
  readonly groupIds: readonly string[];
  readonly limitations: readonly string[];
  readonly sourceContextId: string | null;
  readonly evidence: { readonly sourceId: string; readonly locator: string } | null;
  readonly disposition: ReviewDeliveryDisposition;
}

/** Full binding is an inspectable effect request. Text never selects its destination. */
export interface ReviewDeliveryActionBinding {
  readonly target: ReviewTargetV2;
  readonly sourceSha256: string;
  readonly snapshotSha256: string;
  readonly artifact: ReviewDeliveryArtifact;
  readonly actor: ReviewDeliveryActor;
  readonly reviewedHeadSha: string;
  readonly startSha: string | null;
}

export type ReviewDeliveryAction =
  | {
      readonly kind: "publish-summary";
      readonly id: string;
      readonly binding: ReviewDeliveryActionBinding;
      readonly findingIds: readonly string[];
    }
  | {
      readonly kind: "publish-inline";
      readonly id: string;
      readonly binding: ReviewDeliveryActionBinding;
      readonly findingId: string;
      readonly logicalIssueId: string;
      readonly anchor: ReviewResolvedAnchor;
    };

export interface ReviewDeliveryPlan<TSource = unknown> {
  readonly kind: "docsfab-review-delivery-plan";
  readonly schemaVersion: 1;
  readonly target: ReviewTargetV2;
  readonly source: TSource;
  readonly result: ReviewResultProjectionV1;
  readonly snapshotSha256: string;
  readonly artifact: ReviewDeliveryArtifact;
  readonly actor: ReviewDeliveryActor;
  readonly capabilities: ReviewDeliveryProviderCapabilities;
  readonly requestedActions?: ReviewDeliveryRequestedActions;
  readonly findings: readonly ReviewDeliveryFinding[];
  readonly actions: readonly ReviewDeliveryAction[];
  readonly checks: readonly ReviewCheckV1[];
  readonly unresolvedQuestions: readonly ReviewQuestionV1[];
  readonly affectedPaths: readonly string[];
  readonly reviewScope?: ReviewCoverageV1;
  readonly sourceContexts?: readonly ReviewSourceContextV3[];
  readonly limitations: readonly string[];
}

/** Optional presentation can downgrade a candidate, never create a new anchor. */
export interface ReviewPresentationPolicy {
  select(finding: Readonly<ReviewDeliveryFinding>): "inline" | "summary" | "retained";
}

export interface SuggestionCompiler<TSource = unknown> {
  compile(input: {
    readonly finding: ReviewDeliveryFinding;
    readonly anchor: ReviewResolvedAnchor;
    readonly source: TSource;
  }):
    | { readonly kind: "suggestion"; readonly replacement: string }
    | { readonly kind: "unsupported"; readonly reason: string };
}

export interface RevisionReconciler {
  reconcile(input: {
    readonly before: ReviewDeliveryPlan;
    readonly after: ReviewDeliveryPlan;
  }): readonly {
    readonly earlierLogicalIssueId: string;
    readonly laterLogicalIssueId: string;
    readonly status: "candidate" | "unresolved";
  }[];
}

export interface ReviewReplyAction {
  readonly kind: "reply" | "resolve" | "reopen";
  readonly actor: ReviewDeliveryActor;
  readonly actionBinding: ReviewDeliveryActionBinding;
  readonly logicalIssueId: string;
  readonly text?: string;
}

/** Host-owned, callable actor authentication is separate from review summary/inline grants. */
export interface ReviewReplyAuthorization {
  verifyCurrent(action: ReviewReplyAction): { readonly status: "admitted" };
}

export interface ReplyActionHandler {
  handle(input: {
    readonly action: ReviewReplyAction;
    readonly authorization: ReviewReplyAuthorization;
  }): Promise<{ readonly kind: "handled" | "unsupported" }>;
}

export interface ScopedFeedbackPort {
  record(input: {
    readonly actor: ReviewDeliveryActor;
    readonly target: ReviewTargetV2;
    readonly observationId: string;
    readonly logicalIssueId: string;
    readonly verdict: "useful" | "not-useful";
  }): Promise<{ readonly kind: "recorded" | "unsupported" }>;
}

export type ReviewReplyIntentV2 =
  | "explain-evidence"
  | "request-recheck"
  | "record-feedback"
  | "prepare-fix-handoff";

export type ReviewReplyFeedbackDispositionV2 =
  | "useful"
  | "incorrect"
  | "irrelevant"
  | "already-covered"
  | "intentional"
  | "deferred";

export type ReviewReplyFeedbackScopeV2 = "observation" | "proven-issue-lineage" | "selected-review";

/** A provider reply reference or a trusted local invocation; neither is authority. */
export type ReviewReplyIngressV2 =
  | {
      readonly kind: "provider-reply";
      readonly provider: "gitlab" | "github";
      readonly threadId: string;
      readonly rootId: string;
      readonly replyId: string;
    }
  | { readonly kind: "local-invocation"; readonly invocationId: string };

/** Immutable first binding for a reply request; mutable selected-view admission is separate. */
export interface ReviewReplyActionBindingV2 {
  readonly ingressKey: string;
  readonly inputDigest: string;
  readonly actor: ReviewDeliveryActor;
  readonly target: ReviewTargetV2;
  readonly receiptId: string;
  readonly actionId: string;
  readonly ingress: ReviewReplyIngressV2;
  readonly observationId: string;
  readonly logicalIssueId: string;
  readonly resultSha256: string;
  readonly sourceSha256: string;
  readonly reviewedHeadSha: string;
  readonly reviewRevision: string;
}

type ReviewReplyActionPayloadV2 =
  | {
      readonly intent: "explain-evidence";
      readonly payload: { readonly kind: "explain-evidence" };
    }
  | {
      readonly intent: "request-recheck";
      readonly payload: { readonly kind: "request-recheck" };
    }
  | {
      readonly intent: "record-feedback";
      readonly payload: {
        readonly kind: "record-feedback";
        readonly disposition: ReviewReplyFeedbackDispositionV2;
        /** Implementations must reject an empty reason; this type does not validate runtime data. */
        readonly reason: string;
        readonly scope: ReviewReplyFeedbackScopeV2;
      };
    }
  | {
      readonly intent: "prepare-fix-handoff";
      readonly payload: { readonly kind: "prepare-fix-handoff" };
    };

/**
 * Additive closed V2 request envelope. This declaration is not a runtime decoder or executor.
 */
export type ReviewReplyActionV2 = {
  readonly schemaVersion: 2;
  readonly binding: ReviewReplyActionBindingV2;
} & ReviewReplyActionPayloadV2;

/** Compile-time opaque marker only; it is not unforgeable at runtime or an authority grant. */
declare const reviewReplyGrantV2Brand: unique symbol;
export interface ReviewReplyGrantV2 {
  readonly [reviewReplyGrantV2Brand]: "review-reply-grant-v2";
}

export type ReviewReplyAuthorizationDecisionV2 =
  | {
      readonly kind: "admitted";
      readonly exactIntent: ReviewReplyIntentV2;
      readonly exactBinding: ReviewReplyActionBindingV2;
      readonly opaqueGrant: ReviewReplyGrantV2;
    }
  | { readonly kind: "denied"; readonly reason: string };

export interface ReviewReplyAuthorizationInputV2 {
  readonly action: ReviewReplyActionV2;
  readonly intent: ReviewReplyIntentV2;
  readonly effectTarget?: ReviewTargetV2;
  /** Supplied by a future accepted-view implementation; not part of immutable ingress identity. */
  readonly selectedViewToken?: string;
}

/** Injected current authority contract. No implementation or grant factory exists in D1. */
export interface ReviewReplyAuthorizationV2 {
  verifyCurrent(input: ReviewReplyAuthorizationInputV2): ReviewReplyAuthorizationDecisionV2;
}

export interface ReviewScopedFeedbackEventV2 {
  readonly eventRef: string;
  readonly ingressKey: string;
  readonly inputDigest: string;
  readonly disposition: ReviewReplyFeedbackDispositionV2;
  readonly reason: string;
  readonly scope: ReviewReplyFeedbackScopeV2;
}

export type ReviewScopedFeedbackRecordResultV2 =
  | { readonly kind: "recorded"; readonly eventRef: string }
  | { readonly kind: "duplicate"; readonly eventRef: string }
  | { readonly kind: "conflict" }
  | { readonly kind: "unsupported" };

export type ReviewScopedFeedbackReadResultV2 =
  | { readonly kind: "found"; readonly event: ReviewScopedFeedbackEventV2 }
  | { readonly kind: "unavailable" };

/** Portable typed port only; persistence, uniqueness, and authority are supplied elsewhere. */
export interface ScopedFeedbackPortV2 {
  record(input: {
    readonly action: Extract<ReviewReplyActionV2, { readonly intent: "record-feedback" }>;
    readonly disposition: ReviewReplyFeedbackDispositionV2;
    readonly reason: string;
    readonly scope: ReviewReplyFeedbackScopeV2;
    readonly ingressKey: string;
    readonly inputDigest: string;
    readonly grant: ReviewReplyGrantV2;
  }): Promise<ReviewScopedFeedbackRecordResultV2>;
  read(ingressKey: string): Promise<ReviewScopedFeedbackReadResultV2>;
}

export interface ReviewDeliveryExtensions<TSource = unknown> {
  readonly presentation?: ReviewPresentationPolicy;
  readonly suggestions?: SuggestionCompiler<TSource>;
  readonly revisions?: RevisionReconciler;
  readonly replies?: ReplyActionHandler;
  readonly feedback?: ScopedFeedbackPort;
}

/** Later host adapters inject these ports; D1 constructs no remote effect. */
export interface ReviewDeliveryTransport {
  publishSummary(input: {
    readonly plan: ReviewDeliveryPlan;
    readonly action: Extract<ReviewDeliveryAction, { kind: "publish-summary" }>;
    readonly grant: ReviewDeliveryGrant;
  }): Promise<{
    readonly kind: "confirmed" | "uncertain";
    readonly providerReference: string | null;
  }>;
  publishInline(input: {
    readonly plan: ReviewDeliveryPlan;
    readonly action: Extract<ReviewDeliveryAction, { kind: "publish-inline" }>;
    readonly grant: ReviewDeliveryGrant;
  }): Promise<{
    readonly kind: "confirmed" | "uncertain";
    readonly providerReference: string | null;
  }>;
}

export interface ReviewDeliveryReceipt {
  readonly operationId: string;
  readonly binding: ReviewDeliveryActionBinding;
  readonly kind: ReviewDeliveryAction["kind"];
  readonly state: "confirmed" | "uncertain";
  readonly providerReference: string | null;
}

export interface ReviewDeliveryReceiptPort {
  read(operationId: string): Promise<ReviewDeliveryReceipt | null>;
  record(receipt: ReviewDeliveryReceipt): Promise<void>;
}

export interface ReviewDeliveryGrantVerifier {
  verifyCurrent(action: ReviewDeliveryAction): {
    readonly status: "admitted";
    readonly actionId: string;
    readonly kind: ReviewDeliveryAction["kind"];
  };
}

/** Object identity is private to the host-authority factory; a serialized copy is inert. */
export type ReviewDeliveryGrant = { readonly kind: "docsfab-review-delivery-grant" };

export class ReviewDeliveryError extends Error {
  public constructor(
    public readonly code:
      | "source-mismatch"
      | "result-mismatch"
      | "artifact-mismatch"
      | "actor-mismatch"
      | "capability-mismatch"
      | "snapshot-mismatch"
      | "invalid-requested-actions"
      | "summary-unavailable",
  ) {
    super(`Review delivery rejected: ${code}.`);
    this.name = "ReviewDeliveryError";
  }
}

export interface ReviewDeliveryPlanInput<TSource = unknown> {
  readonly target: ReviewTargetV2 | ReviewTargetMigrationV1;
  readonly source: TSource;
  readonly result: unknown;
  readonly snapshot: ReviewDeliverySnapshot;
  /** Cold, opaque provenance; an unavailable arm keeps locations in summary. */
  readonly locatorEvidence?: ReviewLocatorLoadResult;
  readonly artifact: ReviewDeliveryArtifact;
  readonly actor: ReviewDeliveryActor;
  readonly capabilities: ReviewDeliveryProviderCapabilities;
  readonly requestedActions?: ReviewDeliveryRequestedActions;
  readonly extensions?: ReviewDeliveryExtensions<TSource>;
}
