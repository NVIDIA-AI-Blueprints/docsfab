// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SemanticDocumentTargets } from "../semantic-document-projection.js";

export interface HostRuntimeAcceptedEffectRevalidationV1 {
  readonly schemaVersion: 1;
  readonly kind: "docsfab-accepted-effect-revalidation";
  readonly subject: "desired-intent" | "observed-implementation";
  readonly baseline: {
    readonly projectId: string;
    readonly generation: number;
    readonly baselineSha256: string;
    readonly modelId: string;
    readonly modelSha256: string;
    readonly canonSha256: string;
    readonly approvalReceiptSha256: string;
    readonly sourceClosureSha256: string;
  };
  readonly original: {
    readonly comparisonSha256: string;
    readonly outcomeSha256: string;
    readonly findingSha256: string;
    readonly assertion: "proposed-intent" | "observed-implementation";
  };
  readonly decision: {
    readonly sourceRegistrationSha256: string;
    readonly selectedOptionId: "keep-approved" | "replace-statement-and-scope";
    readonly approvalTargetSha256: string;
    readonly offeredDeltaSha256: string;
  };
  readonly claim: {
    readonly beforeRecordSha256: string;
    readonly before: HostRuntimeAcceptedEffectClaim;
    readonly offeredAfter: HostRuntimeAcceptedEffectClaim;
    readonly expected: HostRuntimeAcceptedEffectClaim;
  };
  readonly repository: {
    readonly observationSha256: string;
    readonly priorComparisonReceiptSha256: string;
    readonly priorInputInventorySha256: string;
    readonly unavailableEvidenceIds: readonly string[];
    readonly previousRevision: string;
    readonly previousTree: string;
    readonly observedRevision: string;
    readonly observedTree: string;
    readonly origin: {
      readonly originalMergeAnchorSha256: string;
      readonly revision: string;
    } | null;
  };
  readonly facets: readonly HostRuntimeAcceptedEffectFacet[];
  readonly purposeSha256: string;
}

/** V2 binds role-aware observations, including a first snapshot without a prior repository. */
export type HostRuntimeAcceptedEffectRevalidationV2 = Omit<
  HostRuntimeAcceptedEffectRevalidationV1,
  "schemaVersion" | "repository"
> & {
  readonly schemaVersion: 2;
  readonly repository: Omit<
    HostRuntimeAcceptedEffectRevalidationV1["repository"],
    "previousRevision" | "previousTree" | "origin"
  > &
    (
      | {
          readonly previousRevision: null;
          readonly previousTree: null;
          readonly origin: null;
        }
      | {
          readonly previousRevision: string;
          readonly previousTree: string;
          readonly origin: HostRuntimeAcceptedEffectRevalidationV1["repository"]["origin"];
        }
    );
};

/** V3 pins manifest-backed repository coverage; intent and role rules remain unchanged. */
export type HostRuntimeAcceptedEffectRevalidationV3 = Omit<
  HostRuntimeAcceptedEffectRevalidationV2,
  "schemaVersion"
> & {
  readonly schemaVersion: 3;
};

export type HostRuntimeAcceptedEffectRevalidation =
  | HostRuntimeAcceptedEffectRevalidationV1
  | HostRuntimeAcceptedEffectRevalidationV2
  | HostRuntimeAcceptedEffectRevalidationV3;

/** Applicability of an exact corrective proposal, never a claim that its correction is implemented. */
export interface HostRuntimeCorrectiveProposalRevalidationV1 {
  readonly schemaVersion: 1;
  readonly kind: "docsfab-corrective-proposal-revalidation";
  readonly acceptedEffectPurposeSha256: string;
  readonly proposal: {
    readonly candidateManifestSha256: string;
    readonly recipeSha256: string;
    readonly targetRoutePolicySha256: string;
    readonly targets: readonly {
      readonly claimId: string;
      readonly targetId: string;
      readonly path: string;
      readonly delivery: "repository-planning" | "public-documentation";
      readonly heading: string | null;
    }[];
  };
  readonly purposeSha256: string;
}
export interface HostRuntimeCorrectiveProposalAssessmentV1 {
  readonly facetId: string;
  readonly applicability:
    | "within-approved-scope"
    | "partially-established"
    | "scope-change-required"
    | "insufficient"
    | "not-informative";
  readonly implementation:
    | "retained-deviation-present"
    | "aligned"
    | "partially-established"
    | "not-established"
    | "not-informative";
  readonly explanation: string;
  readonly intentCitation: HostRuntimeSemanticCitationV1;
  readonly sourceCitations: readonly HostRuntimeSemanticCitationV1[];
  readonly gapFindings: readonly { readonly evidenceId: string; readonly claimId: string }[];
}

export interface HostRuntimeAcceptedEffectClaim {
  readonly claim_id: string;
  readonly statement: string;
  readonly scope: Readonly<Record<string, unknown>>;
}
export interface HostRuntimeAcceptedEffectFacet {
  readonly facetId: string;
  readonly field: "statement" | "scope";
  readonly scopeKey: string | null;
  readonly content: string;
  readonly contentSha256: string;
}
export interface HostRuntimeAcceptedEffectAssessmentV1 {
  readonly facetId: string;
  readonly relationship:
    | "supports-full-facet"
    | "supports-part-of-facet"
    | "contradicts"
    | "insufficient"
    | "not-informative";
  readonly assertion: "proposed-intent" | "observed-implementation" | "unknown";
  readonly explanation: string;
  readonly intentCitation: HostRuntimeSemanticCitationV1;
  readonly sourceCitations: readonly HostRuntimeSemanticCitationV1[];
}

export const HOST_RUNTIME_SEMANTIC_SOURCE_KINDS = [
  "product-reference-model",
  "source-thread",
  "prd",
  "srd",
  "por",
  "decision",
  "repository-documentation",
  "repository-source",
] as const;

/** Host-bound coverage metadata, never a model-supplied classification or authority. */
export interface HostRuntimeSemanticRepositoryRole {
  readonly sourceKind: (typeof HOST_RUNTIME_SEMANTIC_SOURCE_KINDS)[number] | null;
  readonly classification: "implementation" | "context" | "own-projection" | "unclassified";
  readonly coveragePlanSha256: string;
}

/** Inert evidence for one semantic chunk. Approval digests are bindings, never capabilities. */
export interface HostRuntimeSemanticComparisonChunkV1 {
  readonly schemaVersion: 1;
  readonly kind: "docsfab-semantic-comparison-chunk";
  readonly projectId: string;
  readonly caseKind: "merge" | "source-case";
  readonly caseSha256: string;
  readonly comparisonSha256: string;
  readonly baselineGeneration: number;
  readonly baselineSha256: string;
  readonly approvalReceiptSha256: string;
  readonly modelSha256: string;
  readonly canonSha256: string;
  readonly sourceInventorySha256: string;
  readonly ordinal: number;
  readonly chunkCount: number;
  readonly claims: readonly {
    readonly claimId: string;
    readonly statement: string;
    readonly statementSha256: string;
    readonly scope: string;
    readonly recordSha256: string;
  }[];
  readonly evidence: readonly {
    readonly evidenceId: string;
    readonly kind:
      | "repository-before"
      | "repository-after"
      | "supporting-context"
      | "issue-observation"
      | "proposed-intent";
    readonly version: string;
    readonly sourcePath: string | null;
    readonly change: "added" | "modified" | "deleted" | "context" | "source-observation";
    readonly content: string;
    readonly contentSha256: string;
    readonly sourceContentSha256: string;
    readonly startByte: number;
    readonly endByte: number;
    readonly totalBytes: number;
    readonly sourceVersionSha256: string | null;
    readonly repositoryRole?: HostRuntimeSemanticRepositoryRole;
  }[];
  readonly documentTargets?: SemanticDocumentTargets;
  readonly acceptedEffectRevalidation?: HostRuntimeAcceptedEffectRevalidation;
  readonly correctiveProposalRevalidation?: HostRuntimeCorrectiveProposalRevalidationV1;
  /** Required by fresh manifest-backed repository inputs; absent historical bytes are unchanged. */
  readonly repositoryObservationVersion?: 3;
  /**
   * The merged change's own title and description, read from its merge commit. The model
   * reads them only to say whether the merge presents a change as deliberate; an input
   * without them is unchanged.
   */
  readonly mergeMessage?: HostRuntimeSemanticMergeMessageV1;
  readonly inputSha256: string;
}

/** A merged change's own title (one line) and description, as its merge commit states them. */
export interface HostRuntimeSemanticMergeMessageV1 {
  readonly title: string;
  readonly description: string;
}

/**
 * Whether the merge's own title and description present one assessed change as deliberate,
 * as a mistake or a temporary workaround (`not-intended`), or neither.
 */
export const HOST_RUNTIME_SEMANTIC_MERGE_INTENTS = [
  "deliberate",
  "not-mentioned",
  "unclear",
  "not-intended",
] as const;
export type HostRuntimeSemanticMergeIntent = (typeof HOST_RUNTIME_SEMANTIC_MERGE_INTENTS)[number];

/**
 * The reply the comparison would give the product owner about one conflict: keep the approved
 * claim as it is, update it to match the merge, or decide later. It is advice that rides beside
 * an assessment. It records no decision and changes no claim; only the owner's own reply does.
 */
export const HOST_RUNTIME_SEMANTIC_SUGGESTIONS = ["keep", "update", "later"] as const;
export type HostRuntimeSemanticSuggestion = (typeof HOST_RUNTIME_SEMANTIC_SUGGESTIONS)[number];

/** The declared allowance for a suggestion's rationale, read from the generated catalog. */
/**
 * The options a caller of the proposal parser may set. `suggestionRationaleMaxChars` is the
 * effective allowance for a suggestion's rationale (`semantic.suggestionRationaleMaxChars`
 * after any host override); without it the catalog default applies. A stored outcome's proposals
 * (`parseHostRuntimeSemanticComparisonProposalData`) are read back under the catalog maximum, so
 * lowering the allowance never invalidates one.
 */
export interface HostRuntimeSemanticProposalOptions {
  readonly suggestionRationaleMaxChars?: number;
}

export interface HostRuntimeSemanticCitationV1 {
  readonly evidenceId: string;
  readonly startByte: number;
  readonly endByte: number;
  readonly sha256: string;
}
